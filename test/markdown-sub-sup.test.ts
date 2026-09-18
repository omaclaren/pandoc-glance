import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeSubSupTags } from "../src/markdown-sub-sup.js";

const normalize = normalizeSubSupTags;

describe("safe HTML sup/sub compatibility", () => {
  it("normalizes bare case-insensitive inline tags and affiliation markers", () => {
    assert.equal(
      normalize("Alan Li<sup>1</sup>, Oliver Maclaren<sup>1,2</sup>\n\n<sup>1</sup> Department\n\nH<sub>2</sub>O"),
      "Alan Li^1^, Oliver Maclaren^1,2^\n\n^1^ Department\n\nH~2~O",
    );
    assert.equal(normalize("<SUP>1, 2</SUP>"), "^1,\\ 2^");
    assert.equal(normalize("<sup>1</sup><sub>2</sub>"), "^1^~2~");
    assert.equal(normalize("Prose\r\n\r\n<sup>1</sup>\r\n"), "Prose\r\n\r\n^1^\r\n");
  });

  it("preserves fenced, indented, nested and inline code examples", () => {
    for (const source of [
      "`<sup>1</sup>`", "``<sub>2</sub> ` example``", "    <sup>1</sup>\n", "\t<sub>2</sub>\n",
      "```html\n<sup>1</sup>\n```", "~~~html\n<sub>2</sub>\n~~~", "```\n<sup>1</sup>",
      "> ```html\n> <sup>1</sup>\n> ```", "- ```html\n  <sup>1</sup>\n  ```",
      "`multiline\n<sup>1</sup>`",
    ]) assert.equal(normalize(source), source);
    assert.equal(normalize("`<sup>1</sup>` next <sup>2</sup>"), "`<sup>1</sup>` next ^2^");
    assert.equal(
      normalize("<div>\n`<sup>1</sup>` next <sup>2</sup>\n</div>"),
      "<div>\n`<sup>1</sup>` next ^2^\n</div>",
    );
  });

  it("preserves escapes, comments, destinations and HTML/Pandoc attributes", () => {
    for (const source of [
      String.raw`\<sup>1</sup>`, String.raw`<sup>1\</sup>`, "&lt;sup&gt;1&lt;/sup&gt;",
      "<!-- <sup>1</sup> -->", '<a title="<sup>1</sup>">link</a>',
      '[link](target "<sup>1</sup>")', '[link]: target "<sup>1</sup>"',
      '[link](<folder/<sup>1</sup>>)',
      '[span]{title="<sup>1</sup>"}', '![image](sample.svg){title="<sup>1</sup>"}',
    ]) assert.equal(normalize(source), source);
  });

  it("preserves valid YAML front matter without suppressing body markup", () => {
    for (const header of [
      '---\ntitle: "<sup>1</sup>"\n---\n',
      '\uFEFF---\r\ntitle: "<sup>1</sup>"\r\n...\r\n',
    ]) assert.equal(normalize(header + "\nAlan Li<sup>1</sup>"), header + "\nAlan Li^1^");
  });

  it("keeps math contents unchanged for all supported delimiters", () => {
    for (const source of [
      "$<sup>1</sup>$", "$$\n<sub>2</sub>\n$$",
      String.raw`\(<sup>1</sup>\)`, String.raw`\[<sub>2</sub>\]`,
    ]) assert.equal(normalize(source), source);
    assert.equal(normalize("`$` next <sup>1</sup>"), "`$` next ^1^");
  });

  it("does not enable attributed, nested, malformed, empty or multiline HTML", () => {
    for (const source of [
      "<sup onclick='alert(1)'>1</sup>", "<sub class='x'>2</sub>",
      "<sup><em>1</em></sup>", "<sup><sub>1</sub></sup>", "<sup><sup>1</sup></sup>",
      "<sup>line\nbreak</sup>", "<sup>unclosed", "<sup>1</sub>", "<sup></sup>",
      "<sup>text <code>x</code></sup>", "<sup>1 < 2</sup>", "<sup>1 > 0</sup>",
      "<sup>text `code`</sup>",
    ]) assert.equal(normalize(source), source);
  });

  it("escapes Markdown punctuation and preserves entities as text", () => {
    assert.equal(
      normalize("<sup>* _ ^ ~ $ [1] &amp; ²</sup>"),
      String.raw`^\*\ \_\ \^\ \~\ \$\ \[1\]\ &amp;\ ²^`,
    );
    assert.equal(normalize("<sub>a|b</sub>"), String.raw`~a\|b~`);
    assert.equal(normalize("<sup>&#8224; &#x2021;</sup>"), String.raw`^&#8224;\ &#x2021;^`);
    assert.equal(normalize("<sup>@fig-test</sup>"), String.raw`^\@fig\-test^`);
  });

  it("leaves native Pandoc syntax and documents without HTML sup/sub unchanged", () => {
    const source = "Name^1,2^ and H~2~O\r\n\r\nPlain text.\r\n";
    assert.equal(normalize(source), source);
  });
});
