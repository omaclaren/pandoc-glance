import assert from "node:assert/strict";
import { request, type ClientRequest, type IncomingMessage } from "node:http";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { PreviewServer } from "../src/server.js";

const cleanupTasks: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanupTasks.length > 0) await cleanupTasks.pop()!();
});

async function makeFixtureTree(): Promise<{
  root: string;
  validFile: string;
  unsupportedFile: string;
  secretFile: string;
  outsidePdf: string;
  symlinkPath: string;
}> {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "pandoc-glance-server-"));
  const root = join(temporaryDirectory, "document");
  await mkdir(join(root, "assets"), { recursive: true });
  const validFile = join(root, "assets", "fixture file.svg");
  const unsupportedFile = join(root, "assets", "notes.txt");
  const secretFile = join(temporaryDirectory, "secret.txt");
  const outsidePdf = join(temporaryDirectory, "figure.pdf");
  const symlinkPath = join(root, "assets", "escaped.txt");
  await writeFile(validFile, "<svg xmlns=\"http://www.w3.org/2000/svg\"/>", "utf8");
  await writeFile(unsupportedFile, "same-directory source should remain private", "utf8");
  await writeFile(secretFile, "not public", "utf8");
  await writeFile(outsidePdf, "%PDF-1.4\n", "utf8");
  await symlink(secretFile, symlinkPath);
  cleanupTasks.push(() => rm(temporaryDirectory, { recursive: true, force: true }));
  return { root, validFile, unsupportedFile, secretFile, outsidePdf, symlinkPath };
}

function rawRequest(url: URL, host?: string): Promise<{ status: number; body: string; headers: IncomingMessage["headers"] }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const requestOptions = {
      hostname: url.hostname,
      port: Number(url.port),
      path: `${url.pathname}${url.search}`,
      method: "GET",
      headers: host ? { Host: host } : undefined,
    };
    const client = request(requestOptions, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer | string) => chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk));
      response.on("end", () => resolvePromise({
        status: response.statusCode ?? 0,
        body: Buffer.concat(chunks).toString("utf8"),
        headers: response.headers,
      }));
    });
    client.once("error", rejectPromise);
    client.end();
  });
}

interface SseUpdate {
  revision: number;
  status: string;
  error: string | null;
}

class SseCollector {
  #request: ClientRequest | null = null;
  #updates: SseUpdate[] = [];
  #waiters: Array<{ predicate: (update: SseUpdate) => boolean; resolve: (update: SseUpdate) => void }> = [];
  #buffer = "";

  async connect(url: URL): Promise<void> {
    await new Promise<void>((resolvePromise, rejectPromise) => {
      this.#request = request(url, { headers: { Accept: "text/event-stream" } }, (response) => {
        assert.equal(response.statusCode, 200);
        resolvePromise();
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => this.#consume(chunk));
      });
      this.#request.once("error", rejectPromise);
      this.#request.end();
    });
  }

  async waitFor(predicate: (update: SseUpdate) => boolean, timeoutMs = 3000): Promise<SseUpdate> {
    const existing = this.#updates.find(predicate);
    if (existing) return existing;
    return await new Promise<SseUpdate>((resolvePromise, rejectPromise) => {
      const waiter = { predicate, resolve: resolvePromise };
      this.#waiters.push(waiter);
      const timeout = setTimeout(() => {
        const index = this.#waiters.indexOf(waiter);
        if (index >= 0) this.#waiters.splice(index, 1);
        rejectPromise(new Error(`Timed out waiting for SSE update; received ${JSON.stringify(this.#updates)}`));
      }, timeoutMs);
      timeout.unref();
      waiter.resolve = (update) => {
        clearTimeout(timeout);
        resolvePromise(update);
      };
    });
  }

  close(): void {
    this.#request?.destroy();
    this.#request = null;
  }

  #consume(chunk: string): void {
    this.#buffer += chunk;
    let boundary = this.#buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const block = this.#buffer.slice(0, boundary);
      this.#buffer = this.#buffer.slice(boundary + 2);
      const dataLine = block.split("\n").find((line) => line.startsWith("data: "));
      if (dataLine) {
        const update = JSON.parse(dataLine.slice(6)) as SseUpdate;
        this.#updates.push(update);
        const ready = this.#waiters.filter((waiter) => waiter.predicate(update));
        this.#waiters = this.#waiters.filter((waiter) => !waiter.predicate(update));
        ready.forEach((waiter) => waiter.resolve(update));
      }
      boundary = this.#buffer.indexOf("\n\n");
    }
  }
}

describe("preview HTTP server", () => {
  it("binds only to loopback and requires its tokenized path", async () => {
    const fixture = await makeFixtureTree();
    const server = await PreviewServer.create({ resourceRoot: fixture.root, port: 0 });
    await server.start();
    cleanupTasks.push(() => server.close());
    server.publishSuccess(1, "<!doctype html><title>ok</title>");

    assert.equal(server.address?.address, "127.0.0.1");
    assert.ok(server.token.length >= 24);
    assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]+\/$/);

    const documentResponse = await fetch(server.url);
    assert.equal(documentResponse.status, 200);
    assert.equal(await documentResponse.text(), "<!doctype html><title>ok</title>");
    assert.equal(documentResponse.headers.get("cache-control"), "no-store");
    const documentCsp = documentResponse.headers.get("content-security-policy") ?? "";
    assert.match(documentCsp, /connect-src 'self'[^;]*https:\/\/unpkg\.com/);
    assert.match(documentCsp, /worker-src 'self' blob: https:\/\/cdn\.jsdelivr\.net/);
    assert.match(documentCsp, /object-src 'none'/);
    const scriptDirective = documentCsp.split(";").find((directive) => /^\s*script-src\s/.test(directive)) ?? "";
    assert.match(scriptDirective, /'nonce-[A-Za-z0-9_-]+'/);
    assert.match(scriptDirective, /'strict-dynamic'/);
    assert.doesNotMatch(scriptDirective, /'unsafe-inline'|'unsafe-eval'/);

    const origin = new URL(server.url).origin;
    assert.equal((await fetch(`${origin}/`)).status, 404);
    const invalidHost = await rawRequest(new URL(server.url), "attacker.invalid");
    assert.equal(invalidHost.status, 403);
  });

  it("uses a fresh nonce for only the trusted bootstrap script", async () => {
    const fixture = await makeFixtureTree();
    const server = await PreviewServer.create({ resourceRoot: fixture.root });
    await server.start();
    cleanupTasks.push(() => server.close());
    server.publishSuccess(1, [
      "<!doctype html>",
      '<meta id="pandoc-glance-csp" http-equiv="Content-Security-Policy" content="script-src nonce-old" />',
      '<a href="javascript:globalThis.__unsafe = true">Unsafe</a>',
      '<script type="module" data-pandoc-glance-trusted="true" nonce="stored-nonce">globalThis.__trusted = true;</script>',
      "<script>globalThis.__untrusted = true;</script>",
    ].join(""));

    const first = await fetch(server.url);
    const firstBody = await first.text();
    const firstCsp = first.headers.get("content-security-policy") ?? "";
    const firstNonce = /script-src 'nonce-([A-Za-z0-9_-]+)'/.exec(firstCsp)?.[1];
    assert.ok(firstNonce);
    assert.match(firstCsp, /script-src 'nonce-[^']+' 'strict-dynamic'/);
    assert.doesNotMatch(firstCsp.split(";").find((directive) => /^\s*script-src\s/.test(directive)) ?? "", /unsafe-inline|unsafe-eval/);
    assert.doesNotMatch(firstBody, /http-equiv="Content-Security-Policy"/i);
    assert.match(firstBody, new RegExp(`<script type="module" data-pandoc-glance-trusted="true" nonce="${firstNonce}">`));
    assert.match(firstBody, /<script>globalThis\.__untrusted = true;<\/script>/);
    assert.doesNotMatch(firstBody, /<script nonce="[^"]+">globalThis\.__untrusted/);

    const second = await fetch(server.url);
    const secondCsp = second.headers.get("content-security-policy") ?? "";
    const secondNonce = /script-src 'nonce-([A-Za-z0-9_-]+)'/.exec(secondCsp)?.[1];
    assert.ok(secondNonce);
    assert.notEqual(secondNonce, firstNonce);
  });

  it("serves supported in-root media and rejects unsupported types, traversal, absolute paths, and symlink escape", async () => {
    const fixture = await makeFixtureTree();
    const server = await PreviewServer.create({ resourceRoot: fixture.root });
    await server.start();
    cleanupTasks.push(() => server.close());
    server.publishSuccess(1, "ok");
    const origin = new URL(server.url).origin;
    const endpoint = `${origin}${server.paths.resource}`;

    const validUrl = new URL(endpoint);
    validUrl.searchParams.set("path", "assets/fixture file.svg");
    const valid = await fetch(validUrl);
    assert.equal(valid.status, 200);
    assert.equal(valid.headers.get("content-type"), "image/svg+xml");
    assert.match(valid.headers.get("content-security-policy") ?? "", /default-src 'none'.*sandbox/);
    assert.match(await valid.text(), /<svg/);

    const unsupportedUrl = new URL(endpoint);
    unsupportedUrl.searchParams.set("path", "assets/notes.txt");
    const unsupported = await fetch(unsupportedUrl);
    assert.equal(unsupported.status, 415);
    assert.doesNotMatch(await unsupported.text(), /same-directory source should remain private/);

    const traversal = await fetch(`${endpoint}?path=${encodeURIComponent("../secret.txt")}`);
    assert.equal(traversal.status, 403);

    const encodedTraversal = await fetch(`${endpoint}?path=%252e%252e%252fsecret.txt`);
    assert.equal(encodedTraversal.status, 403);

    const absolute = await fetch(`${endpoint}?path=${encodeURIComponent(fixture.secretFile)}`);
    assert.equal(absolute.status, 403);

    const symlinkEscape = await fetch(`${endpoint}?path=${encodeURIComponent("assets/escaped.txt")}`);
    assert.equal(symlinkEscape.status, 403);
  });

  it("serves only explicitly allowlisted opaque assets", async () => {
    const fixture = await makeFixtureTree();
    const server = await PreviewServer.create({ resourceRoot: fixture.root });
    await server.start();
    cleanupTasks.push(() => server.close());
    const assetId = "abcdefghijklmnopqrstuvwx";
    const unsupportedAssetId = "bcdefghijklmnopqrstuvwxy";
    server.publishSuccess(2, "ok", new Map([
      [assetId, fixture.outsidePdf],
      [unsupportedAssetId, fixture.secretFile],
    ]));
    const origin = new URL(server.url).origin;

    const allowed = await fetch(`${origin}${server.paths.asset}/${assetId}`);
    assert.equal(allowed.status, 200);
    assert.equal(allowed.headers.get("content-type"), "application/pdf");
    assert.equal(await allowed.text(), "%PDF-1.4\n");
    const unsupported = await fetch(`${origin}${server.paths.asset}/${unsupportedAssetId}`);
    assert.equal(unsupported.status, 415);
    assert.doesNotMatch(await unsupported.text(), /not public/);
    assert.equal((await fetch(`${origin}${server.paths.asset}/zyxwvutsrqponmlkjihgfedc`)).status, 404);
  });

  it("broadcasts revision and error events over SSE and closes cleanly", async () => {
    const fixture = await makeFixtureTree();
    const server = await PreviewServer.create({ resourceRoot: fixture.root });
    await server.start();
    const collector = new SseCollector();
    cleanupTasks.push(async () => {
      collector.close();
      await server.close();
    });
    const eventsUrl = new URL(server.paths.events, new URL(server.url).origin);
    await collector.connect(eventsUrl);
    await collector.waitFor((update) => update.revision === 0 && update.status === "starting");

    server.publishSuccess(1, "first");
    const success = await collector.waitFor((update) => update.revision === 1);
    assert.equal(success.status, "success");

    server.publishError(2, "broken input");
    const failure = await collector.waitFor((update) => update.revision === 2);
    assert.equal(failure.status, "error");
    assert.equal(failure.error, "broken input");

    const previousUrl = server.url;
    collector.close();
    await server.close();
    await assert.rejects(fetch(previousUrl));
    cleanupTasks.pop();
  });
});
