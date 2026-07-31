import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { before, describe, it } from "node:test";
import {
  assertPandocAvailable,
  detectFormat,
  normalizeMathDelimiters,
  renderDocument,
} from "../src/render.js";

const execFileAsync = promisify(execFile);
const fixtureDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures");
let pandocAvailable = true;

before(async () => {
  try {
    await assertPandocAvailable();
  } catch {
    pandocAvailable = false;
  }
});

function requirePandoc(context: { skip: (message?: string) => void }): boolean {
  if (pandocAvailable) return true;
  context.skip("Pandoc is not installed; skipping Pandoc integration coverage.");
  return false;
}

describe("format detection", () => {
  it("detects Markdown and standalone LaTeX extensions", () => {
    assert.equal(detectFormat("notes.md", "auto"), "markdown");
    assert.equal(detectFormat("paper.markdown", "auto"), "markdown");
    assert.equal(detectFormat("paper.tex", "auto"), "latex");
    assert.equal(detectFormat("paper.LATEX", "auto"), "latex");
  });

  it("honors overrides and rejects unknown automatic formats", () => {
    assert.equal(detectFormat("source.txt", "markdown"), "markdown");
    assert.equal(detectFormat("source.md", "latex"), "latex");
    assert.throws(() => detectFormat("source.txt", "auto"), /--format markdown or --format latex/);
  });

  it("reports an actionable error when PANDOC_PATH is missing", async () => {
    const previous = process.env.PANDOC_PATH;
    process.env.PANDOC_PATH = join(tmpdir(), "pi-md-preview-pandoc-does-not-exist");
    try {
      await assert.rejects(assertPandocAvailable(), /Pandoc was not found at PANDOC_PATH=.*set PANDOC_PATH/);
    } finally {
      if (previous === undefined) delete process.env.PANDOC_PATH;
      else process.env.PANDOC_PATH = previous;
    }
  });
});

describe("Pandoc rendering", () => {
  it("renders headings, highlighted code, all math delimiters, Mermaid, and local images", async (context) => {
    if (!requirePandoc(context)) return;
    const sourcePath = join(fixtureDirectory, "sample.md");
    const source = await readFile(sourcePath, "utf8");
    const rendered = await renderDocument({
      source,
      sourcePath,
      resourceRoot: fixtureDirectory,
      format: "markdown",
      theme: "auto",
      fontSizePx: 15,
    });

    assert.match(rendered.fragmentHtml, /<h1 id="pi-md-preview-sample">/);
    assert.match(rendered.fragmentHtml, /class="sourceCode typescript"/);
    assert.match(rendered.fragmentHtml, /<span class="kw">interface<\/span>/);
    assert.ok((rendered.fragmentHtml.match(/<math\b/g) ?? []).length >= 4, rendered.fragmentHtml);
    assert.match(rendered.fragmentHtml, /<pre class="mermaid">/);
    assert.ok((rendered.fragmentHtml.match(/src="sample\.svg"/g) ?? []).length >= 2);
    assert.match(rendered.html, /<base href="file:/);
    assert.match(rendered.html, /prefers-color-scheme: dark/);
    assert.match(rendered.html, /mermaid@11\.16\.0/);
    assert.match(rendered.html, /mermaid\.registerIconPacks/);
    assert.match(rendered.html, /@iconify-json\/lucide@1\/icons\.json/);
    assert.match(rendered.html, /@iconify-json\/logos@1\/icons\.json/);
    assert.match(rendered.html, /ensureReadableColor/);
    assert.match(rendered.html, /className = "mermaid-error"/);
    assert.match(rendered.html, /mathjax@3/);
  });

  it("renders a standalone LaTeX document and its local figure", async (context) => {
    if (!requirePandoc(context)) return;
    const sourcePath = join(fixtureDirectory, "sample.tex");
    const source = await readFile(sourcePath, "utf8");
    const rendered = await renderDocument({
      source,
      sourcePath,
      resourceRoot: fixtureDirectory,
      format: detectFormat(sourcePath, "auto"),
      theme: "light",
      fontSizePx: 16,
    });

    assert.match(rendered.fragmentHtml, /Standalone LaTeX preview/);
    assert.match(rendered.fragmentHtml, /<math\b/);
    assert.match(rendered.fragmentHtml, /src="sample\.svg"/);
    assert.match(rendered.html, /--preview-font-size: 16px/);
  });

  it("does not misinterpret plain escaped brackets and parentheses as math", async (context) => {
    if (!requirePandoc(context)) return;
    const sourcePath = join(fixtureDirectory, "sample.md");
    const rendered = await renderDocument({
      source: "This is \\[not a link\\] and \\(plain words\\).",
      sourcePath,
      resourceRoot: fixtureDirectory,
      format: "markdown",
      theme: "auto",
      fontSizePx: 15,
    });
    assert.doesNotMatch(rendered.fragmentHtml, /<math\b/);
    assert.match(rendered.fragmentHtml, /\[not a link\].*\(plain words\)/);
  });

  it("rewrites watch-mode resources with revision cache busting", async (context) => {
    if (!requirePandoc(context)) return;
    const sourcePath = join(fixtureDirectory, "sample.md");
    const rendered = await renderDocument({
      source: "# Resource\n\n![fixture](sample.svg)",
      sourcePath,
      resourceRoot: fixtureDirectory,
      format: "markdown",
      theme: "dark",
      fontSizePx: 15,
      liveReload: {
        eventsPath: "/token/events",
        revision: 7,
        storageKey: "test-position",
      },
      serverResources: {
        resourcePath: "/token/resource",
        assetPath: "/token/asset",
        revision: 7,
      },
    });

    assert.match(rendered.fragmentHtml, /src="\/token\/resource\?path=sample\.svg&amp;v=7"/);
    assert.match(rendered.html, /new EventSource\(CONFIG\.live\.eventsPath\)/);
    assert.match(rendered.html, /"revision":7/);
  });

  it("uses opaque allowlisted URLs for explicitly referenced absolute resources outside the root", async (context) => {
    if (!requirePandoc(context)) return;
    const temporaryRoot = await mkdtemp(join(tmpdir(), "pi-md-preview-render-"));
    const documentDirectory = join(temporaryRoot, "document");
    const outsideImage = join(temporaryRoot, "outside.svg");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(documentDirectory));
    await writeFile(outsideImage, "<svg xmlns=\"http://www.w3.org/2000/svg\"/>", "utf8");
    const sourcePath = join(documentDirectory, "notes.md");

    try {
      const rendered = await renderDocument({
        source: `![outside](<${outsideImage}>)`,
        sourcePath,
        resourceRoot: documentDirectory,
        format: "markdown",
        theme: "light",
        fontSizePx: 15,
        serverResources: {
          resourcePath: "/token/resource",
          assetPath: "/token/asset",
          revision: 3,
        },
      });
      assert.equal(rendered.assets.size, 1);
      assert.match(rendered.fragmentHtml, /src="\/token\/asset\/[A-Za-z0-9_-]{24}\?v=3"/);
      assert.equal([...rendered.assets.values()][0], await realpath(outsideImage));
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("emits syntactically valid browser JavaScript", async (context) => {
    if (!requirePandoc(context)) return;
    const sourcePath = join(fixtureDirectory, "sample.md");
    const rendered = await renderDocument({
      source: "# Script check",
      sourcePath,
      resourceRoot: fixtureDirectory,
      format: "markdown",
      theme: "auto",
      fontSizePx: 15,
    });
    const scriptMatch = rendered.html.match(/<script type="module">([\s\S]*?)<\/script>/);
    assert.ok(scriptMatch);
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-md-preview-script-"));
    const scriptPath = join(temporaryDirectory, "client.mjs");
    try {
      await writeFile(scriptPath, scriptMatch[1]!, "utf8");
      await execFileAsync(process.execPath, ["--check", scriptPath]);
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });
});

describe("math normalization", () => {
  it("normalizes single-backslash delimiters outside fenced code only", () => {
    const markdown = "Before \\(x+1\\).\n\n\\[y=2\\]\n\n```text\n\\(leave me\\)\n```";
    const normalized = normalizeMathDelimiters(markdown);
    assert.match(normalized, /Before \$x\+1\$\./);
    assert.match(normalized, /\$\$\ny=2\n\$\$/);
    assert.match(normalized, /```text\n\\\(leave me\\\)\n```/);
  });
});
