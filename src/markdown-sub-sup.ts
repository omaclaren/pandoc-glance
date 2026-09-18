// Adapted from pi-markdown-preview/shared/markdown-sub-sup.js (MIT).
// Copyright (c) 2026 Oliver MacLaren. See LICENSE.
import { collectMarkdownLiteralRanges, type SourceRange } from "./markdown-comments.js";
import { markdownMathEnd, pandocAttributeEnd } from "./markdown-inline.js";

function overlaps(ranges: SourceRange[], start: number, end: number): boolean {
  return ranges.some((range) => range.start < end && range.end > start);
}

/**
 * Translate bare, paired HTML sup/sub tags containing plain inline text into
 * Pandoc's native notation. Keep raw HTML disabled and literal/code contexts
 * byte-for-byte intact. Attributes and nested markup are not supported.
 */
export function normalizeSubSupTags(source: string): string {
  if (!/<(?:sup|sub)>/i.test(source)) return source;
  const literalRanges = collectMarkdownLiteralRanges(source);
  const mathRanges: SourceRange[] = [];
  const mathStarts = /[$\\]/g;
  let match: RegExpExecArray | null;
  while ((match = mathStarts.exec(source))) {
    const start = match.index;
    // Micromark treats backslash math delimiters as two-character escapes.
    // Allow just those delimiters, never math starts within code or metadata.
    const escapedMathDelimiter = source[start] === "\\" && ["(", "["].includes(source[start + 1] ?? "");
    if (literalRanges.some((range) => range.start <= start && range.end > start
      && !(escapedMathDelimiter && range.start === start && range.end === start + 2))) continue;
    const end = markdownMathEnd(source, start, source.length);
    if (end !== undefined) {
      mathRanges.push({ start, end });
      mathStarts.lastIndex = end;
    }
  }
  const protectedRanges = [...literalRanges, ...mathRanges];
  // Pandoc attributes are not understood by Micromark. Preserve their contents
  // too, including title attributes on native Markdown spans and images.
  const attributeStarts = /\{/g;
  while ((match = attributeStarts.exec(source))) {
    if (overlaps(protectedRanges, match.index, match.index + 1)) continue;
    const end = pandocAttributeEnd(source, match.index, source.length);
    if (end !== undefined) {
      protectedRanges.push({ start: match.index, end });
      attributeStarts.lastIndex = end;
    }
  }

  const stack: Array<{ name: string; start: number; contentStart: number }> = [];
  const tags = /<(\/?)(sup|sub)>/gi;
  let cursor = 0;
  let output = "";
  while ((match = tags.exec(source))) {
    if (overlaps(protectedRanges, match.index, tags.lastIndex)) continue;
    const name = match[2]!.toLowerCase();
    if (!match[1]) {
      stack.push({ name, start: match.index, contentStart: tags.lastIndex });
      continue;
    }
    const opening = stack.pop();
    if (!opening || opening.name !== name) {
      stack.length = 0;
      continue;
    }
    if (stack.length) continue;
    const content = source.slice(opening.contentStart, match.index);
    if (!/^[^<>\r\n]+$/.test(content) || overlaps(protectedRanges, opening.start, tags.lastIndex)) continue;
    // Treat the contents as text, not injected Markdown. Preserve entities for
    // Pandoc to decode, and escape spaces for its native sup/sub syntax.
    const text = content.replace(
      /&(?:#(?:\d+|x[\da-f]+)|[a-z][\da-z]+);|[\\`*_[\]{}()!#$~^|@:.+=\-"']|[ \t]/gi,
      (token) => token.startsWith("&") ? token : /[ \t]/.test(token) ? "\\ " : `\\${token}`,
    );
    const delimiter = name === "sup" ? "^" : "~";
    output += source.slice(cursor, opening.start) + delimiter + text + delimiter;
    cursor = tags.lastIndex;
  }
  return output + source.slice(cursor);
}
