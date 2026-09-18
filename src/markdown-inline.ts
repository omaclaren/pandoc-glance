/** Skip math as a unit, including unmatched square brackets in TeX. */
export function markdownMathEnd(source: string, start: number, limit: number): number | undefined {
  const opening = source.startsWith("$$", start) ? "$$"
    : source.startsWith("\\(", start) ? "\\("
      : source.startsWith("\\[", start) ? "\\["
        : source[start] === "$" && /\S/.test(source[start + 1] ?? "") ? "$" : undefined;
  if (!opening) return undefined;
  const closing = opening === "\\(" ? "\\)" : opening === "\\[" ? "\\]" : opening;
  for (let index = start + opening.length; index < limit; index += 1) {
    if (source.startsWith(closing, index)) {
      if (opening === "$" && (/\s/.test(source[index - 1]!) || /\d/.test(source[index + 1] ?? ""))) continue;
      return index + closing.length;
    }
    if (source[index] === "\\") index += 1;
  }
  return undefined;
}

/** Micromark does not recognise Pandoc's attribute syntax. Leave it alone. */
export function pandocAttributeEnd(source: string, start: number, limit: number): number | undefined {
  if (source[start] !== "{" || !/^\{[ \t]*(?:[.#]|[\w:-]+[ \t]*=)/.test(source.slice(start))) return undefined;
  let quote: string | undefined;
  for (let index = start + 1; index < limit; index += 1) {
    const character = source[index];
    if (character === "\\") index += 1;
    else if (quote) {
      if (character === quote) quote = undefined;
    } else if (character === '"' || character === "'") quote = character;
    else if (character === "}") return index + 1;
  }
  return undefined;
}
