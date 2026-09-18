import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { CliArgumentError, helpText, parseCliArgs } from "../src/cli.js";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("CLI argument parsing", () => {
  it("accepts watch options before the input path", () => {
    const parsed = parseCliArgs(["--watch", "--theme", "dark", "notes.md"]);
    assert.equal(parsed.action, "run");
    assert.equal(parsed.inputPath, "notes.md");
    assert.equal(parsed.watch, true);
    assert.equal(parsed.theme, "dark");
  });

  it("accepts options after the input path and equals syntax", () => {
    const parsed = parseCliArgs([
      "notes.md",
      "-w",
      "--no-open",
      "--format=markdown",
      "--font-size=17.5",
      "--port",
      "4312",
    ]);
    assert.equal(parsed.inputPath, "notes.md");
    assert.equal(parsed.watch, true);
    assert.equal(parsed.open, false);
    assert.equal(parsed.format, "markdown");
    assert.equal(parsed.fontSizePx, 17.5);
    assert.equal(parsed.port, 4312);
  });

  it("supports -- for paths beginning with a dash", () => {
    const parsed = parseCliArgs(["--no-open", "--", "-notes.md"]);
    assert.equal(parsed.inputPath, "-notes.md");
    assert.equal(parsed.open, false);
  });

  it("recognizes help and version without an input file", () => {
    assert.equal(parseCliArgs(["--help"]).action, "help");
    assert.equal(parseCliArgs(["-v"]).action, "version");
    assert.match(helpText(), /^pandoc-glance 0\.3\.1/m);
    assert.match(helpText(), /pandoc-glance --watch \[options\] <file>/);
  });

  it("runs when invoked through an npm-style symlink", async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "pandoc-glance-entrypoint-"));
    const linkedCli = join(temporaryDirectory, "pandoc-glance");
    await symlink(join(repositoryRoot, "src", "cli.ts"), linkedCli);
    try {
      const { stdout } = await execFileAsync(
        process.execPath,
        ["--import", "tsx", linkedCli, "--version"],
        { cwd: repositoryRoot },
      );
      assert.equal(stdout.trim(), "0.3.1");
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("rejects missing or multiple input paths", () => {
    assert.throws(() => parseCliArgs([]), CliArgumentError);
    assert.throws(() => parseCliArgs(["one.md", "two.md"]), /Expected one input file/);
  });

  it("rejects unknown options and invalid enum values", () => {
    assert.throws(() => parseCliArgs(["--watc", "notes.md"]), /Unknown option/);
    assert.throws(() => parseCliArgs(["--theme", "blue", "notes.md"]), /auto, light, or dark/);
    assert.throws(() => parseCliArgs(["--format", "html", "notes.md"]), /auto, markdown, or latex/);
  });

  it("validates font sizes and ports", () => {
    assert.throws(() => parseCliArgs(["--font-size", "9.9", "notes.md"]), /between 10 and 24/);
    assert.throws(() => parseCliArgs(["--font-size", "large", "notes.md"]), /Invalid --font-size/);
    assert.throws(() => parseCliArgs(["--port", "65536", "notes.md"]), /0 to 65535/);
    assert.throws(() => parseCliArgs(["--port", "1.5", "notes.md"]), /Invalid --port/);
  });
});
