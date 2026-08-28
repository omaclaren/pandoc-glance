import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { assertPandocAvailable } from "../src/render.js";
import { startWatchPreview, type WatchRenderer } from "../src/watch-preview.js";

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  description: string,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

async function readState(url: string): Promise<{ revision: number; successfulRevision: number; status: string; error: string | null }> {
  const response = await fetch(url);
  assert.equal(response.status, 200);
  return await response.json() as { revision: number; successfulRevision: number; status: string; error: string | null };
}

async function observeSseRevision(eventsUrl: string, minimumRevision: number, action: () => Promise<void>): Promise<number> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  timeout.unref();
  try {
    const response = await fetch(eventsUrl, { signal: controller.signal });
    assert.equal(response.status, 200);
    assert.ok(response.body);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    await action();

    while (true) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error("SSE stream ended before the expected revision.");
      buffer += decoder.decode(chunk.value, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = block.split("\n").find((line) => line.startsWith("data: "));
        if (data) {
          const update = JSON.parse(data.slice(6)) as { revision: number };
          if (update.revision >= minimumRevision) return update.revision;
        }
        boundary = buffer.indexOf("\n\n");
      }
    }
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
}

function testRenderer(): WatchRenderer {
  return async (source, context) => {
    if (source.includes("BROKEN")) throw new Error("Synthetic render failure");
    return {
      html: `<!doctype html><html><body data-revision="${context.revision}">${source}</body></html>`,
    };
  };
}

async function temporarySource(initial: string): Promise<{ directory: string; filePath: string }> {
  const directory = await mkdtemp(join(tmpdir(), "pandoc-glance-watch-"));
  const filePath = join(directory, "notes.md");
  await writeFile(filePath, initial, "utf8");
  return { directory, filePath };
}

describe("watch preview", () => {
  it("emits a live-reload revision after an atomic-save replacement", async () => {
    const fixture = await temporarySource("# First");
    const session = await startWatchPreview({
      inputPath: fixture.filePath,
      format: "markdown",
      theme: "auto",
      fontSizePx: 15,
      debounceMs: 30,
      renderer: testRenderer(),
    });

    try {
      assert.equal(session.server.address?.address, "127.0.0.1");
      assert.equal(session.state.revision, 1);
      const eventsUrl = new URL(session.server.paths.events, new URL(session.url).origin).href;
      const replacement = join(fixture.directory, "replacement.md");
      const observedRevision = await observeSseRevision(eventsUrl, 2, async () => {
        await writeFile(replacement, "# Second", "utf8");
        await rename(replacement, fixture.filePath);
      });
      assert.ok(observedRevision >= 2);
      await waitFor(() => session.state.status === "success" && session.state.revision >= 2, "successful rerender");
      const page = await (await fetch(session.url)).text();
      assert.match(page, /# Second/);
    } finally {
      await session.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("keeps the last successful HTML on failure and recovers after a corrected save", async () => {
    const fixture = await temporarySource("VALID FIRST");
    const session = await startWatchPreview({
      inputPath: fixture.filePath,
      format: "markdown",
      theme: "dark",
      fontSizePx: 15,
      debounceMs: 25,
      renderer: testRenderer(),
    });

    try {
      assert.equal(session.state.status, "success");
      await writeFile(fixture.filePath, "BROKEN", "utf8");
      await waitFor(() => session.state.status === "error", "render failure");
      const failedState = session.state;
      assert.equal(failedState.successfulRevision, 1);
      assert.match(failedState.error ?? "", /Synthetic render failure/);
      const retainedPage = await (await fetch(session.url)).text();
      assert.match(retainedPage, /VALID FIRST/);
      assert.doesNotMatch(retainedPage, /BROKEN/);

      await writeFile(fixture.filePath, "VALID AGAIN", "utf8");
      await waitFor(
        () => session.state.status === "success" && session.state.successfulRevision > failedState.successfulRevision,
        "render recovery",
      );
      const recoveredPage = await (await fetch(session.url)).text();
      assert.match(recoveredPage, /VALID AGAIN/);
    } finally {
      await session.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("starts with an error page and recovers when initially invalid input is corrected", async () => {
    const fixture = await temporarySource("BROKEN INITIAL");
    const session = await startWatchPreview({
      inputPath: fixture.filePath,
      format: "markdown",
      theme: "light",
      fontSizePx: 16,
      debounceMs: 25,
      renderer: testRenderer(),
    });

    try {
      assert.match(session.initialError ?? "", /Synthetic render failure/);
      assert.equal(session.state.status, "error");
      const errorPage = await (await fetch(session.url)).text();
      assert.match(errorPage, /Preview render failed/);
      assert.match(errorPage, /recover automatically/);

      await writeFile(fixture.filePath, "CORRECTED", "utf8");
      await waitFor(() => session.state.status === "success", "initial-error recovery");
      const recoveredPage = await (await fetch(session.url)).text();
      assert.match(recoveredPage, /CORRECTED/);
    } finally {
      await session.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("collapses save bursts to one latest pending render", async () => {
    const fixture = await temporarySource("initial");
    const calls: string[] = [];
    let releaseBlockedRender = (): void => undefined;
    const blockedRender = new Promise<void>((resolvePromise) => {
      releaseBlockedRender = resolvePromise;
    });
    let markBlockedRenderStarted = (): void => undefined;
    const blockedRenderStarted = new Promise<void>((resolvePromise) => {
      markBlockedRenderStarted = resolvePromise;
    });
    const renderer: WatchRenderer = async (source, context) => {
      calls.push(source);
      if (source === "one") {
        markBlockedRenderStarted();
        await blockedRender;
      }
      return { html: `<!doctype html><body data-revision="${context.revision}">${source}</body>` };
    };
    const session = await startWatchPreview({
      inputPath: fixture.filePath,
      format: "markdown",
      theme: "light",
      fontSizePx: 15,
      debounceMs: 10,
      renderer,
    });

    try {
      await writeFile(fixture.filePath, "one", "utf8");
      await blockedRenderStarted;
      for (const source of ["two", "three", "four"]) {
        await writeFile(fixture.filePath, source, "utf8");
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 120));
      }
      releaseBlockedRender();
      await waitFor(() => calls.includes("four") && session.state.revision === 3, "latest burst render");
      await session.waitForIdle();

      assert.deepEqual(calls, ["initial", "one", "four"]);
      const page = await (await fetch(session.url)).text();
      assert.match(page, />four<\/body>/);
    } finally {
      releaseBlockedRender();
      await session.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("shuts down without leaving a reachable server", async () => {
    const fixture = await temporarySource("# Shutdown");
    const session = await startWatchPreview({
      inputPath: fixture.filePath,
      format: "markdown",
      theme: "auto",
      fontSizePx: 15,
      renderer: testRenderer(),
    });
    const url = session.url;
    await session.close();
    await assert.rejects(fetch(url));
    await rm(fixture.directory, { recursive: true, force: true });
  });
});

function waitForChildOutput(child: ChildProcess, pattern: RegExp, timeoutMs = 10_000): Promise<RegExpMatchArray> {
  return new Promise((resolvePromise, rejectPromise) => {
    let output = "";
    const timeout = setTimeout(() => {
      rejectPromise(new Error(`Timed out waiting for child output ${pattern}; received: ${output}`));
    }, timeoutMs);
    const consume = (chunk: Buffer | string): void => {
      output += chunk.toString();
      const match = output.match(pattern);
      if (!match) return;
      clearTimeout(timeout);
      resolvePromise(match);
    };
    child.stdout?.on("data", consume);
    child.stderr?.on("data", consume);
    child.once("exit", (code) => {
      clearTimeout(timeout);
      rejectPromise(new Error(`CLI exited early with code ${code}; output: ${output}`));
    });
  });
}

describe("watch CLI integration", () => {
  it("starts on loopback with --no-open and exits cleanly on SIGTERM", async (context) => {
    try {
      await assertPandocAvailable();
    } catch {
      context.skip("Pandoc is not installed; skipping CLI integration coverage.");
      return;
    }

    const fixture = await temporarySource("# CLI watch test");
    const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "src/cli.ts", "--watch", "--no-open", fixture.filePath],
      { cwd: repositoryRoot, stdio: ["ignore", "pipe", "pipe"] },
    );

    try {
      const match = await waitForChildOutput(child, /Preview URL: (http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]+\/)/);
      const url = match[1]!;
      const response = await fetch(url);
      assert.equal(response.status, 200);
      assert.match(await response.text(), /CLI watch test/);

      child.kill("SIGTERM");
      const exitCode = await new Promise<number | null>((resolvePromise) => child.once("exit", resolvePromise));
      assert.equal(exitCode, 0);
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });
});
