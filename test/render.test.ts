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
  stripMarkdownHtmlComments,
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
    process.env.PANDOC_PATH = join(tmpdir(), "pandoc-glance-pandoc-does-not-exist");
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

    assert.match(rendered.fragmentHtml, /<h1 id="pandoc-glance-sample">/);
    assert.match(rendered.fragmentHtml, /class="sourceCode typescript"/);
    assert.match(rendered.fragmentHtml, /<span class="kw">interface<\/span>/);
    assert.ok((rendered.fragmentHtml.match(/<math\b/g) ?? []).length >= 4, rendered.fragmentHtml);
    assert.match(rendered.fragmentHtml, /<pre class="mermaid">/);
    assert.match(rendered.fragmentHtml, /lucide:file-code-2/);
    assert.ok((rendered.fragmentHtml.match(/src="sample\.svg"/g) ?? []).length >= 2);
    assert.match(rendered.html, /<base href="file:/);
    assert.match(rendered.html, /<title>sample\.md — pandoc-glance<\/title>/);
    assert.match(rendered.html, /window\.__pandocGlanceReady = true/);
    assert.match(rendered.html, /prefers-color-scheme: dark/);
    assert.match(rendered.html, /mermaid@11\.16\.0/);
    assert.match(rendered.html, /mermaid\.registerIconPacks/);
    assert.match(rendered.html, /@iconify-json\/lucide@1\/icons\.json/);
    assert.match(rendered.html, /@iconify-json\/logos@1\/icons\.json/);
    assert.match(rendered.html, /ensureReadableColor/);
    assert.match(rendered.html, /className = "mermaid-error"/);
    assert.match(rendered.html, /mathjax@3/);
    assert.match(rendered.html, /id="pandoc-glance-csp" http-equiv="Content-Security-Policy"/);
    assert.match(rendered.html, /<script type="module" data-pandoc-glance-trusted="true" nonce="[A-Za-z0-9_-]+">/);
    assert.doesNotMatch(rendered.html, /script-src[^;\"]*unsafe-inline|unsafe-eval/);
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

  it("renders Markdown metadata while removing authored HTML comments", async (context) => {
    if (!requirePandoc(context)) return;
    const sourcePath = join(fixtureDirectory, "metadata.qmd");
    const rendered = await renderDocument({
      source: [
        "---",
        "title: Assignment preview",
        "author: Test Author",
        "---",
        "",
        "<!-- private drafting note -->",
        "",
        "# Visible body",
      ].join("\n"),
      sourcePath,
      resourceRoot: fixtureDirectory,
      format: "markdown",
      theme: "auto",
      fontSizePx: 15,
    });

    assert.match(rendered.fragmentHtml, /<header id="title-block-header">/);
    assert.match(rendered.fragmentHtml, /<h1 class="title">Assignment preview<\/h1>/);
    assert.match(rendered.fragmentHtml, /<p class="author">Test Author<\/p>/);
    assert.match(rendered.fragmentHtml, /<h1 id="visible-body">Visible body<\/h1>/);
    assert.doesNotMatch(rendered.fragmentHtml, /private drafting note|&lt;!|--&gt;/);
  });

  it("resolves exact Quarto and pandoc-crossref figure references", async (context) => {
    if (!requirePandoc(context)) return;
    const sourcePath = join(fixtureDirectory, "crossrefs.qmd");
    const rendered = await renderDocument({
      source: [
        "See @fig-elephant and @fig:whale. Missing @fig-missing.",
        "",
        "Qualified [see @fig-elephant, p. 2] remains unresolved.",
        "",
        "![An Elephant](elephant.png){#fig-elephant}",
        "",
        "![A Whale](whale.png){#fig:whale}",
        "",
        "Inline ![not a standalone figure](inline.png){#fig-inline}; @fig-inline.",
        "",
        "`@fig-elephant`",
      ].join("\n"),
      sourcePath,
      resourceRoot: fixtureDirectory,
      format: "markdown",
      theme: "auto",
      fontSizePx: 15,
    });

    assert.match(rendered.fragmentHtml, /<a href="#fig-elephant">Figure 1<\/a>/);
    assert.match(rendered.fragmentHtml, /<a href="#fig:whale">Figure 2<\/a>/);
    assert.match(rendered.fragmentHtml, /<figcaption[^>]*>Figure 1: An Elephant<\/figcaption>/);
    assert.match(rendered.fragmentHtml, /<figcaption[^>]*>Figure 2: A Whale<\/figcaption>/);
    assert.match(rendered.fragmentHtml, /@fig-missing/);
    assert.match(rendered.fragmentHtml, /\[see @fig-elephant, p\. 2\]/);
    assert.match(rendered.fragmentHtml, /@fig-inline/);
    assert.match(rendered.fragmentHtml, /<code>@fig-elephant<\/code>/);
    assert.ok(rendered.pandocWarnings.some((warning) => warning.includes("unresolved figure reference: fig-missing")));
    assert.ok(rendered.pandocWarnings.some((warning) => warning.includes("unresolved figure reference: fig-inline")));
  });

  it("numbers unlabelled figures consistently and leaves ordinary captions alone without references", async (context) => {
    if (!requirePandoc(context)) return;
    const options = {
      sourcePath: join(fixtureDirectory, "numbering.md"),
      resourceRoot: fixtureDirectory,
      format: "markdown" as const,
      theme: "light" as const,
      fontSizePx: 15,
    };
    const numbered = await renderDocument({
      ...options,
      source: [
        "See @fig-second.",
        "",
        "![Unlabelled but captioned](first.png)",
        "",
        "![Second](second.png){#fig-second}",
      ].join("\n"),
    });
    assert.match(numbered.fragmentHtml, /href="#fig-second">Figure 2<\/a>/);
    assert.match(numbered.fragmentHtml, /Figure 1: Unlabelled but captioned/);
    assert.match(numbered.fragmentHtml, /Figure 2: Second/);

    const ordinary = await renderDocument({
      ...options,
      source: "![Ordinary Markdown caption](ordinary.png)",
    });
    assert.match(ordinary.fragmentHtml, /<figcaption[^>]*>Ordinary Markdown caption<\/figcaption>/);
    assert.doesNotMatch(ordinary.fragmentHtml, /Figure 1:/);
  });

  it("keeps duplicate figure references visibly unresolved", async (context) => {
    if (!requirePandoc(context)) return;
    const rendered = await renderDocument({
      source: [
        "![First](one.png){#fig-duplicate}",
        "",
        "![Second](two.png){#fig-duplicate}",
        "",
        "See @fig-duplicate.",
      ].join("\n"),
      sourcePath: join(fixtureDirectory, "duplicate-figures.md"),
      resourceRoot: fixtureDirectory,
      format: "markdown",
      theme: "light",
      fontSizePx: 15,
    });

    assert.match(rendered.fragmentHtml, /@fig-duplicate/);
    assert.doesNotMatch(rendered.fragmentHtml, /href="#fig-duplicate">Figure/);
    assert.match(rendered.fragmentHtml, /Figure 1: First/);
    assert.match(rendered.fragmentHtml, /Figure 2: Second/);
    assert.ok(rendered.pandocWarnings.some((warning) => warning.includes("duplicate figure identifier: fig-duplicate")));
    assert.ok(rendered.pandocWarnings.some((warning) => warning.includes("unresolved figure reference: fig-duplicate")));
  });

  it("renders raw attributed HTML as inert code", async (context) => {
    if (!requirePandoc(context)) return;
    const rendered = await renderDocument({
      source: "```{=html}\n<script>globalThis.__unsafe = true</script>\n```",
      sourcePath: join(fixtureDirectory, "raw-attribute.md"),
      resourceRoot: fixtureDirectory,
      format: "markdown",
      theme: "light",
      fontSizePx: 15,
    });
    assert.doesNotMatch(rendered.fragmentHtml, /<script>/i);
    assert.match(rendered.fragmentHtml, /&lt;script&gt;globalThis\.__unsafe = true&lt;\/script&gt;/);
  });

  it("places javascript links under a nonce-only script policy", async (context) => {
    if (!requirePandoc(context)) return;
    const rendered = await renderDocument({
      source: "[Unsafe](javascript:globalThis.__pandocGlanceUnsafe=true)",
      sourcePath: join(fixtureDirectory, "unsafe-link.md"),
      resourceRoot: fixtureDirectory,
      format: "markdown",
      theme: "light",
      fontSizePx: 15,
    });
    assert.match(rendered.fragmentHtml, /href="javascript:globalThis\.__pandocGlanceUnsafe=true"/);
    assert.match(rendered.html, /script-src &#39;nonce-[A-Za-z0-9_-]+&#39; &#39;strict-dynamic&#39;/);
    assert.doesNotMatch(rendered.html, /script-src[^;\"]*unsafe-inline|unsafe-eval/);
    assert.match(rendered.html, /script-src-attr &#39;none&#39;/);
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

  it("uses opaque allowlisted URLs for explicitly referenced parent resources outside the root", async (context) => {
    if (!requirePandoc(context)) return;
    const temporaryRoot = await mkdtemp(join(tmpdir(), "pandoc-glance-render-parent-"));
    const documentDirectory = join(temporaryRoot, "document");
    const outsidePdf = join(temporaryRoot, "figure.pdf");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(documentDirectory));
    await writeFile(outsidePdf, "%PDF-1.4\n% preview fixture\n", "utf8");
    const sourcePath = join(documentDirectory, "notes.qmd");

    try {
      const rendered = await renderDocument({
        source: "See @fig-parent.\n\n![Parent PDF](../figure.pdf){#fig-parent fig-align=\"center\"}",
        sourcePath,
        resourceRoot: documentDirectory,
        format: "markdown",
        theme: "light",
        fontSizePx: 15,
        serverResources: {
          resourcePath: "/token/resource",
          assetPath: "/token/asset",
          revision: 4,
        },
      });
      assert.equal(rendered.assets.size, 1);
      assert.match(rendered.fragmentHtml, /<a href="#fig-parent">Figure 1<\/a>/);
      assert.match(rendered.fragmentHtml, /<div class="preview-pdf-figure preview-pdf-pending" data-preview-pdf-src="\/token\/asset\/[A-Za-z0-9_-]{24}\?v=4" id="fig-parent"/);
      assert.match(rendered.fragmentHtml, /<figcaption[^>]*>Figure 1: Parent PDF<\/figcaption>/);
      assert.match(rendered.fragmentHtml, /class="preview-pdf-open"[^>]*>Open PDF<\/a>/);
      assert.doesNotMatch(rendered.fragmentHtml, /<embed\b/);
      assert.equal([...rendered.assets.values()][0], await realpath(outsidePdf));
      assert.match(rendered.html, /pdfjs-dist@4\.10\.38/);
      assert.match(rendered.html, /renderPdfPreviews/);
      assert.match(rendered.html, /\.preview-pdf-figure/);
      assert.match(rendered.html, /\.preview-pdf-loading/);

      const oneShot = await renderDocument({
        source: "![Parent PDF](../figure.pdf)",
        sourcePath,
        resourceRoot: documentDirectory,
        format: "markdown",
        theme: "light",
        fontSizePx: 15,
      });
      assert.match(oneShot.fragmentHtml, /data-preview-pdf-src="data:application\/pdf;base64,JVBER/);
      assert.match(oneShot.fragmentHtml, /class="preview-pdf-open" href="\.\.\/figure\.pdf"/);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("does not expose attribute-like code or unsupported local file types", async (context) => {
    if (!requirePandoc(context)) return;
    const temporaryRoot = await mkdtemp(join(tmpdir(), "pandoc-glance-render-code-"));
    const documentDirectory = join(temporaryRoot, "document");
    const outsideFile = join(temporaryRoot, "outside.txt");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(documentDirectory));
    await writeFile(outsideFile, "private fixture", "utf8");

    try {
      const rendered = await renderDocument({
        source: `Inline code: \`href="${outsideFile}"\`.\n\n[Unsupported local file](${outsideFile})`,
        sourcePath: join(documentDirectory, "notes.md"),
        resourceRoot: documentDirectory,
        format: "markdown",
        theme: "light",
        fontSizePx: 15,
        serverResources: {
          resourcePath: "/token/resource",
          assetPath: "/token/asset",
          revision: 5,
        },
      });
      assert.equal(rendered.assets.size, 0);
      assert.ok(rendered.fragmentHtml.includes(outsideFile), rendered.fragmentHtml);
      assert.doesNotMatch(rendered.fragmentHtml, /\/token\/asset/);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("uses opaque allowlisted URLs for explicitly referenced absolute resources outside the root", async (context) => {
    if (!requirePandoc(context)) return;
    const temporaryRoot = await mkdtemp(join(tmpdir(), "pandoc-glance-render-"));
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
    const scriptMatch = rendered.html.match(/<script\b[^>]*\bdata-pandoc-glance-trusted="true"[^>]*>([\s\S]*?)<\/script>/);
    assert.ok(scriptMatch);
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "pandoc-glance-script-"));
    const scriptPath = join(temporaryDirectory, "client.mjs");
    try {
      await writeFile(scriptPath, scriptMatch[1]!, "utf8");
      await execFileAsync(process.execPath, ["--check", scriptPath]);
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });
});

describe("Markdown preprocessing", () => {
  it("strips comments outside code while preserving YAML front matter and comment literals", () => {
    const markdown = [
      "---",
      "title: Comment handling",
      "custom: \"<!-- YAML literal -->\"",
      "---",
      "",
      "Before `<!-- inline literal -->`.",
      "",
      "<!--",
      "private drafting note",
      "-->",
      "",
      "```html",
      "<!-- fenced literal -->",
      "```",
      "",
      "After",
    ].join("\n");
    const stripped = stripMarkdownHtmlComments(markdown);

    assert.match(stripped, /custom: "<!-- YAML literal -->"/);
    assert.match(stripped, /`<!-- inline literal -->`/);
    assert.match(stripped, /```html\n<!-- fenced literal -->\n```/);
    assert.doesNotMatch(stripped, /private drafting note/);
    assert.match(stripped, /Before[\s\S]*After/);
  });

  it("preserves multiline code spans, nested fences, and YAML closed with ellipses", () => {
    const markdown = [
      "---",
      "title: \"<!-- YAML literal -->\"",
      "...",
      "",
      "``<!-- multiline code literal",
      "continues here -->``",
      "",
      "> ```html",
      "> <!-- blockquote fence literal -->",
      "> ```",
      "",
      "- ```html",
      "  <!-- list fence literal -->",
      "  ```",
      "",
      "```text",
      "``` not a closing fence",
      "<!-- fence literal after a fence-like line -->",
      "```",
      "",
      "<!-- remove this drafting note -->",
    ].join("\n");
    const stripped = stripMarkdownHtmlComments(markdown);

    assert.match(stripped, /title: \"<!-- YAML literal -->\"/);
    assert.match(stripped, /``<!-- multiline code literal\ncontinues here -->``/);
    assert.match(stripped, /<!-- blockquote fence literal -->/);
    assert.match(stripped, /<!-- list fence literal -->/);
    assert.match(stripped, /<!-- fence literal after a fence-like line -->/);
    assert.doesNotMatch(stripped, /remove this drafting note/);
  });

  it("preserves indented code and destinations while rejecting false front matter", () => {
    const markdown = [
      "---",
      "Ordinary Markdown between thematic breaks.",
      "<!-- remove from the body -->",
      "---",
      "",
      "    <!-- indented code literal -->",
      "",
      "[destination](figure<!--destination-literal-->.png \"<!-- title literal -->\")",
      "",
      "<div>",
      "<!-- remove from native HTML flow -->",
      "`<!-- native inline code literal -->`",
      "</div>",
    ].join("\n");
    const stripped = stripMarkdownHtmlComments(markdown);

    assert.match(stripped, /Ordinary Markdown between thematic breaks\./);
    assert.doesNotMatch(stripped, /remove from the body/);
    assert.match(stripped, /    <!-- indented code literal -->/);
    assert.match(stripped, /figure<!--destination-literal-->\.png/);
    assert.match(stripped, /\"<!-- title literal -->\"/);
    assert.doesNotMatch(stripped, /remove from native HTML flow/);
    assert.match(stripped, /`<!-- native inline code literal -->`/);
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
