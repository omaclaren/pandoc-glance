// Adapted from pi-markdown-preview's MIT-licensed comment scanner (commit 146c022).
import { parse, postprocess, preprocess } from "micromark";
import { isMap, parseDocument } from "yaml";

interface SourceRange {
  start: number;
  end: number;
}

interface HtmlTagRange extends SourceRange {
  tagName: string;
}

const PROTECTED_MARKDOWN_TOKEN_TYPES = new Set([
  "characterEscape",
  "codeFenced",
  "codeIndented",
  "codeText",
  "definitionDestinationString",
  "definitionTitleString",
  "resourceDestinationString",
  "resourceTitleString",
]);

function mergeRanges(ranges: SourceRange[]): SourceRange[] {
  const sorted = ranges
    .filter((range) => range.end > range.start)
    .sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: SourceRange[] = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (!previous || range.start > previous.end) {
      merged.push({ ...range });
    } else {
      previous.end = Math.max(previous.end, range.end);
    }
  }
  return merged;
}

function collectProtectedMarkdownRanges(source: string): SourceRange[] {
  const hasByteOrderMark = source.startsWith("\uFEFF");
  const tokenizerSource = hasByteOrderMark ? source.slice(1) : source;
  const offsetAdjustment = hasByteOrderMark ? 1 : 0;
  const events = postprocess(parse().document().write(preprocess()(tokenizerSource, "utf8", true)));
  const ranges: SourceRange[] = [];
  for (const [eventType, token] of events) {
    if (eventType !== "enter" || !PROTECTED_MARKDOWN_TOKEN_TYPES.has(token.type)) continue;
    ranges.push({
      start: token.start.offset + offsetAdjustment,
      end: token.end.offset + offsetAdjustment,
    });
  }
  return ranges;
}

function hasEscapedOpeningAngleBracket(source: string, start: number): boolean {
  let precedingBackslashes = 0;
  for (let index = start - 1; index >= 0 && source[index] === "\\"; index -= 1) precedingBackslashes += 1;
  return precedingBackslashes % 2 === 1;
}

function isHtmlWhitespace(character: string | undefined): boolean {
  return character === " " || character === "\t" || character === "\r" || character === "\n" || character === "\f";
}

function isHtmlAttributeNameCharacter(character: string | undefined): boolean {
  return Boolean(character) && !isHtmlWhitespace(character) && !/["'=<>`/]/.test(character!);
}

function isHtmlUnquotedAttributeValueCharacter(character: string | undefined): boolean {
  return Boolean(character) && !isHtmlWhitespace(character) && !/["'`=<>]/.test(character!);
}

function readHtmlTag(source: string, start: number): { end: number; tagName: string } | undefined {
  if (source.startsWith("<!--", start) || hasEscapedOpeningAngleBracket(source, start)) return undefined;
  let index = start + 1;
  let closing = false;
  if (source[index] === "/") {
    closing = true;
    index += 1;
  }
  if (!/[a-zA-Z]/.test(source[index] ?? "")) return undefined;
  const nameStart = index;
  index += 1;
  while (/[a-zA-Z0-9:-]/.test(source[index] ?? "")) index += 1;
  const tagName = source.slice(nameStart, index).toLowerCase();

  if (closing) {
    while (isHtmlWhitespace(source[index])) index += 1;
    return source[index] === ">" ? { end: index + 1, tagName } : undefined;
  }

  for (;;) {
    while (isHtmlWhitespace(source[index])) index += 1;
    if (source[index] === ">") return { end: index + 1, tagName };
    if (source[index] === "/" && source[index + 1] === ">") return { end: index + 2, tagName };
    if (!isHtmlAttributeNameCharacter(source[index])) return undefined;
    while (isHtmlAttributeNameCharacter(source[index])) index += 1;
    while (isHtmlWhitespace(source[index])) index += 1;
    if (source[index] !== "=") continue;
    index += 1;
    while (isHtmlWhitespace(source[index])) index += 1;
    const quote = source[index] === "\"" || source[index] === "'" ? source[index] : undefined;
    if (quote) {
      index += 1;
      while (index < source.length && source[index] !== quote) index += 1;
      if (source[index] !== quote) return undefined;
      index += 1;
      continue;
    }
    if (!isHtmlUnquotedAttributeValueCharacter(source[index])) return undefined;
    while (isHtmlUnquotedAttributeValueCharacter(source[index])) index += 1;
  }
}

function collectHtmlTags(source: string): HtmlTagRange[] {
  const tags: HtmlTagRange[] = [];
  let index = 0;
  while (index < source.length) {
    const start = source.indexOf("<", index);
    if (start < 0) break;
    const tag = readHtmlTag(source, start);
    if (!tag) {
      index = start + 1;
      continue;
    }
    tags.push({ ...tag, start });
    index = tag.end;
  }
  return tags;
}

function isMarkdownContainerPrefixOnly(value: string): boolean {
  let remainder = value;
  for (;;) {
    const blockQuote = remainder.match(/^[ \t]{0,3}>[ \t]?/);
    if (blockQuote) {
      remainder = remainder.slice(blockQuote[0].length);
      continue;
    }
    const listItem = remainder.match(/^[ \t]{0,3}(?:[-+*]|\d{1,9}[.)])[ \t]+/);
    if (listItem) {
      remainder = remainder.slice(listItem[0].length);
      continue;
    }
    return remainder.trim().length === 0;
  }
}

function collectBlankDivTagStarts(source: string, tags: HtmlTagRange[]): Set<number> {
  const blankTagStarts = new Set<number>();
  let tagIndex = 0;
  let lineStart = 0;
  while (lineStart <= source.length && tagIndex < tags.length) {
    const newlineIndex = source.indexOf("\n", lineStart);
    const lineEnd = newlineIndex < 0 ? source.length : newlineIndex;
    while (tagIndex < tags.length && tags[tagIndex]!.end <= lineStart) tagIndex += 1;
    let lineTagEnd = tagIndex;
    while (lineTagEnd < tags.length && tags[lineTagEnd]!.start < lineEnd) lineTagEnd += 1;
    const lineTags = tags.slice(tagIndex, lineTagEnd);
    if (
      lineTags.length > 0
      && lineTags.every((tag) => tag.tagName === "div" && tag.start >= lineStart && tag.end <= lineEnd)
    ) {
      let residual = "";
      let cursor = lineStart;
      for (const tag of lineTags) {
        residual += source.slice(cursor, tag.start);
        cursor = tag.end;
      }
      residual += source.slice(cursor, lineEnd);
      if (isMarkdownContainerPrefixOnly(residual)) {
        for (const tag of lineTags) blankTagStarts.add(tag.start);
      }
    }
    if (newlineIndex < 0) break;
    lineStart = newlineIndex + 1;
  }
  return blankTagStarts;
}

function maskHtmlTags(source: string): string {
  const tags = collectHtmlTags(source);
  if (tags.length === 0) return source;
  const blankDivTagStarts = collectBlankDivTagStarts(source, tags);
  const pieces: string[] = [];
  let cursor = 0;
  for (const tag of tags) {
    pieces.push(source.slice(cursor, tag.start));
    const maskCharacter = blankDivTagStarts.has(tag.start) ? " " : "x";
    pieces.push(source.slice(tag.start, tag.end).replace(/[^\r\n]/g, maskCharacter));
    cursor = tag.end;
  }
  pieces.push(source.slice(cursor));
  return pieces.join("");
}

function findContainingRange(
  ranges: SourceRange[],
  offset: number,
  startIndex = 0,
): { range: SourceRange | undefined; nextIndex: number } {
  for (let index = startIndex; index < ranges.length; index += 1) {
    const range = ranges[index]!;
    if (offset < range.start) return { range: undefined, nextIndex: index };
    if (offset < range.end) return { range, nextIndex: index };
  }
  return { range: undefined, nextIndex: ranges.length };
}

function collectMarkdownHtmlCommentRanges(source: string): SourceRange[] {
  const maskedSource = maskHtmlTags(source);
  const protectedRanges = mergeRanges([
    ...collectProtectedMarkdownRanges(source),
    ...collectProtectedMarkdownRanges(maskedSource),
  ]);
  const commentRanges: SourceRange[] = [];
  let protectedRangeIndex = 0;
  let index = 0;

  while (index < source.length) {
    const start = source.indexOf("<!--", index);
    if (start < 0) break;
    const protectedContaining = findContainingRange(protectedRanges, start, protectedRangeIndex);
    protectedRangeIndex = protectedContaining.nextIndex;
    if (protectedContaining.range) {
      index = Math.max(start + 4, protectedContaining.range.end);
      continue;
    }
    const closingIndex = source.indexOf("-->", start + 4);
    if (closingIndex < 0) break;
    const end = closingIndex + 3;
    commentRanges.push({ start, end });
    index = end;
  }
  return commentRanges;
}

function blankCommentTextPreservingLineEndings(comment: string): string {
  return comment.replace(/[^\r\n]/g, "");
}

/**
 * Remove Markdown HTML comments while preserving comment-like text in fenced,
 * indented, and inline code. Micromark supplies code/escape ranges; a second
 * tag-masked pass handles Pandoc's Markdown-inside-native-HTML behavior.
 */
export function stripMarkdownHtmlComments(markdown: string): string {
  const source = String(markdown ?? "");
  const ranges = collectMarkdownHtmlCommentRanges(source);
  if (ranges.length === 0) return source;

  let output = "";
  let cursor = 0;
  for (const { start, end } of ranges) {
    output += source.slice(cursor, start);
    output += blankCommentTextPreservingLineEndings(source.slice(start, end));
    cursor = end;
  }
  return output + source.slice(cursor);
}

function splitValidYamlFrontMatter(source: string): { frontMatter: string; body: string } | undefined {
  const match = source.match(/^(\uFEFF?---[ \t]*\r?\n)([\s\S]*?)^((?:---|\.\.\.)[ \t]*(?:\r?\n|$))/m);
  if (!match || match.index !== 0) return undefined;

  const yamlSource = match[2] ?? "";
  const document = parseDocument(yamlSource, { prettyErrors: false, uniqueKeys: false });
  if (document.errors.length > 0 || !isMap(document.contents)) return undefined;

  const frontMatter = match[0];
  return { frontMatter, body: source.slice(frontMatter.length) };
}

/** Preserve valid YAML mapping front matter byte-for-byte while removing body comments. */
export function stripMarkdownHtmlCommentsPreservingYamlFrontMatter(markdown: string): string {
  const source = String(markdown ?? "");
  const split = splitValidYamlFrontMatter(source);
  if (!split) return stripMarkdownHtmlComments(source);
  return `${split.frontMatter}${stripMarkdownHtmlComments(split.body)}`;
}
