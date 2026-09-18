// Bracket/escape scanning adapted from pi-markdown-preview's MIT-licensed
// client/annotation-helpers.js (commit 80e7c60), Copyright (c) 2026 Oliver MacLaren.
// See LICENSE. Unlike its browser placeholders, we emit native Pandoc spans:
// Pandoc remains responsible for rendering/escaping all note contents.
import { parse, postprocess, preprocess } from "micromark";
import { splitValidYamlFrontMatter } from "./markdown-comments.js";
import { markdownMathEnd, pandocAttributeEnd } from "./markdown-inline.js";

interface SourceRange {
  start: number;
  end: number;
}

const PROSE_TOKENS = new Set(["paragraph", "atxHeadingText", "setextHeadingText"]);
const PROTECTED_TOKENS = new Set([
  "codeText", "link", "image", "autolink", "htmlText", "definition",
]);

function containingRange(ranges: SourceRange[], offset: number): SourceRange | undefined {
  // Ranges are disjoint and sorted; this also keeps large annotation-heavy
  // documents from repeatedly scanning every earlier inline-code/link token.
  let lower = 0;
  let upper = ranges.length;
  while (lower < upper) {
    const middle = (lower + upper) >>> 1;
    if (ranges[middle]!.start <= offset) lower = middle + 1;
    else upper = middle;
  }
  const range = ranges[lower - 1];
  return range && offset < range.end ? range : undefined;
}

function mergeRanges(ranges: SourceRange[]): SourceRange[] {
  const merged: SourceRange[] = [];
  for (const range of ranges.sort((a, b) => a.start - b.start || b.end - a.end)) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

function bareUrlEnd(source: string, start: number): number | undefined {
  if (!/[hf]/i.test(source[start] ?? "")) return undefined;
  const match = source.slice(start).match(/^(?:https?|ftp):\/\/[^\s<>]+/i);
  return match ? start + match[0].length : undefined;
}

function readMarkerEnd(source: string, start: number, limit: number, protectedRanges: SourceRange[]): number | undefined {
  let depth = 0;
  for (let index = start + 4; index < limit; index += 1) {
    const protectedRange = containingRange(protectedRanges, index);
    const end = protectedRange?.end ?? markdownMathEnd(source, index, limit) ?? pandocAttributeEnd(source, index, limit);
    if (end !== undefined) {
      index = end - 1;
      continue;
    }
    const character = source[index];
    if (character === "\\") index += 1;
    else if (character === "[") depth += 1;
    else if (character === "]") {
      if (depth === 0) return index + 1;
      depth -= 1;
    }
  }
  return undefined;
}

function attributeText(text: string): string {
  // Entity-encode backslashes as well: authored \" must not escape the closing
  // quote in the generated Pandoc attribute. Pipes/backticks must not change
  // table-cell parsing. Pandoc decodes the entities on output.
  return text.replace(/&/g, "&amp;").replace(/\\/g, "&#92;")
    .replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/\|/g, "&#124;").replace(/`/g, "&#96;");
}

/** Highlight prose annotations only; no source writes, raw HTML, or runtime JS. */
export function highlightMarkdownAnnotations(markdown: string): string {
  if (!/\[an:/i.test(markdown)) return markdown;
  const split = splitValidYamlFrontMatter(markdown);
  const frontMatter = split?.frontMatter ?? "";
  const body = split?.body ?? markdown;
  const bom = body.startsWith("\uFEFF") ? "\uFEFF" : "";
  const source = body.slice(bom.length);
  const events = postprocess(parse().document().write(preprocess()(source, "utf8", true)));
  const prose: SourceRange[] = [];
  const protectedRanges: SourceRange[] = [];
  const quotePrefixes: SourceRange[] = [];
  for (const [event, token] of events) {
    if (event !== "enter") continue;
    const range = { start: token.start.offset, end: token.end.offset };
    if (PROSE_TOKENS.has(token.type)) prose.push(range);
    if (PROTECTED_TOKENS.has(token.type)) protectedRanges.push(range);
    if (token.type === "blockQuotePrefix") quotePrefixes.push(range);
  }
  const protectedInlines = mergeRanges(protectedRanges);
  const prefixes = mergeRanges(quotePrefixes);
  const replacements: Array<SourceRange & { text: string }> = [];
  for (const range of prose) {
    for (let index = range.start; index < range.end; index += 1) {
      const protectedRange = containingRange(protectedInlines, index);
      const end = protectedRange?.end ?? markdownMathEnd(source, index, range.end)
        ?? pandocAttributeEnd(source, index, range.end) ?? bareUrlEnd(source, index);
      if (end !== undefined) {
        index = end - 1;
        continue;
      }
      if (source[index] === "\\") {
        index += 1;
        continue;
      }
      if (source.slice(index, index + 4).toLowerCase() !== "[an:") continue;
      const markerEnd = readMarkerEnd(source, index, range.end, protectedInlines);
      // Do not absorb another block, or repeatedly rescan a malformed paragraph.
      if (markerEnd === undefined) break;
      let label = "";
      for (let cursor = index + 4; cursor < markerEnd - 1; cursor += 1) {
        const prefix = containingRange(prefixes, cursor);
        if (prefix) cursor = prefix.end - 1;
        else label += source[cursor];
      }
      label = label.replace(/\s*\r?\n\s*/g, " ").trim();
      if (label) {
        replacements.push({
          start: index,
          end: markerEnd,
          text: `[${label}]{.annotation-marker title="${attributeText(`[an: ${label}]`)}"}`,
        });
      }
      index = markerEnd - 1;
    }
  }
  let output = frontMatter + bom;
  let cursor = 0;
  for (const replacement of replacements) {
    output += source.slice(cursor, replacement.start) + replacement.text;
    cursor = replacement.end;
  }
  return output + source.slice(cursor);
}
