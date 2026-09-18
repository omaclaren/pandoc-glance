import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { highlightMarkdownAnnotations } from "../src/annotations.js";

const highlight = highlightMarkdownAnnotations;
const note = (label: string): string => `[${label}]{.annotation-marker title="[an: ${label}]"}`;

describe("annotation preprocessing", () => {
  it("recognises case-insensitive markers without requiring a space, including adjacent notes", () => {
    assert.equal(highlight("Before [an:here][AN: there] after"), `Before ${note("here")}${note("there")} after`);
    assert.equal(highlight("[an: ] and [an:]"), "[an: ] and [an:]");
  });

  it("balances brackets and skips code, links, and math within a note", () => {
    for (const label of [
      "a [nested [bracket]] and **bold**",
      "see [this link](https://example.com/path) and `code]`",
      "use ``a ` and ]`` here",
      String.raw`math $x \in [0,1)$ and $\text{]}$`,
      String.raw`escaped \] and \[ brackets`,
    ]) {
      const output = highlight(`[an:${label}]`);
      assert.ok(output.startsWith(`[${label}]{.annotation-marker title="`), output);
      assert.equal((output.match(/\.annotation-marker/g) ?? []).length, 1);
    }
  });

  it("leaves fenced, indented, nested, and multiline inline code untouched", () => {
    const source = [
      "```markdown", "[an:fenced]", "```", "",
      "~~~", "[an:tilde]", "~~~", "",
      "    [an:indented]", "",
      "> ```", "> [an:quoted fence]", "> ```", "",
      "- ```", "  [an:list fence]", "  ```", "",
      "`[an:inline]` and ``a ` [an:two ticks]``", "",
      "`first line", "[an:multiline code]`",
    ].join("\n");
    assert.equal(highlight(source), source);
  });

  it("preserves escapes, math literals, links, images, definitions, HTML, and Pandoc attributes", () => {
    const source = [
      String.raw`\[an:escaped]`,
      String.raw`$\text{[an:math]}$ and \(\text{[an:paren]}\)`,
      "$$", String.raw`\text{[an:display]}`, "$$", "",
      '[an:link label](https://example.com "[an:title]")',
      '![an:image label](sample.svg "[an:image title]")',
      '[link](<folder/[an:destination]>)',
      'https://example.com/[an:bare-url] and <https://example.com/[an:autolink]>',
      '[span]{title="[an:attribute]" .custom}',
      '# Header {#test title="[an:heading attr]"}', "",
      '[an:definition]: https://example.com "[an:reference title]"',
      '[an:definition]', "",
      '<div title="[an:html attr]">[an:html block]</div>',
    ].join("\n");
    assert.equal(highlight(source), source);
    assert.equal(highlight(String.raw`\\[an:visible]`), String.raw`\\` + note("visible"));
  });

  it("preserves YAML front matter and BOM/CRLF while annotating body prose", () => {
    const yaml = '\uFEFF---\r\ntitle: "[an:metadata]"\r\nauthor: Test\r\n...\r\n';
    assert.equal(highlight(yaml + "\r\n[an:body]\r\n"), yaml + "\r\n" + note("body") + "\r\n");
    assert.equal(highlight("\uFEFF[an:body]"), "\uFEFF" + note("body"));
  });

  it("supports headings, lists, table cells, soft line breaks, and continued blockquotes", () => {
    const source = [
      "# Heading [an:heading]", "",
      "- item [an:list]", "",
      "| A | B |", "|---|---|", "| [an:cell] | two |", "",
      "First [an:soft", "line] end.", "",
      "> Quote [an:continued", "> note] end.",
    ].join("\n");
    const output = highlight(source);
    for (const label of ["heading", "list", "cell", "soft line", "continued note"]) {
      assert.ok(output.includes(note(label)), output);
    }
  });

  it("does not complete markers across paragraphs or consume code blocks", () => {
    for (const source of [
      "Before [an:unfinished",
      "[an:unfinished\n\nLater ]",
      "[an:unfinished\n\n```\n] [an:code]\n```",
      "[an:broken [nested]",
    ]) assert.equal(highlight(source), source);
    const source = "[an:unfinished\n\n[an:valid]";
    assert.equal(highlight(source), "[an:unfinished\n\n" + note("valid"));
  });

  it("escapes generated title attributes without changing the note body", () => {
    const source = String.raw`[an:<tag> & "quote" \] text]`;
    const output = highlight(source);
    assert.ok(output.startsWith(String.raw`[<tag> & "quote" \] text]{.annotation-marker`), output);
    assert.ok(output.endsWith('title="[an: &lt;tag&gt; &amp; &quot;quote&quot; &#92;] text]"}'), output);
  });

  it("leaves documents without annotations byte-for-byte unchanged", () => {
    assert.equal(highlight("# Title\r\n\r\nJust text.\r\n"), "# Title\r\n\r\nJust text.\r\n");
  });
});
