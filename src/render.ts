import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, relative, resolve, sep, win32 } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  appendLocalResourceSuffix,
  parseLocalResourceReference,
  type LocalResourceReference,
} from "./local-resource.js";
import { stripMarkdownHtmlCommentsPreservingYamlFrontMatter } from "./markdown-comments.js";
import { previewResourceContentType } from "./resource-types.js";
import {
  createPreviewScriptNonce,
  PREVIEW_CSP_META_ID,
  previewContentSecurityPolicy,
  TRUSTED_PREVIEW_SCRIPT_ATTRIBUTE,
} from "./security.js";
import { buildPreviewCss, palettesForClient, type PreviewTheme } from "./styles.js";

export type PreviewFormat = "markdown" | "latex";
export type PreviewFormatOption = "auto" | PreviewFormat;

export interface LiveReloadConfig {
  eventsPath: string;
  revision: number;
  storageKey: string;
  initialError?: string;
}

export interface ServerResourceConfig {
  resourcePath: string;
  assetPath: string;
  revision: number;
}

export interface RenderDocumentOptions {
  source: string;
  sourcePath: string;
  resourceRoot: string;
  format: PreviewFormat;
  theme: PreviewTheme;
  fontSizePx: number;
  title?: string;
  liveReload?: LiveReloadConfig;
  serverResources?: ServerResourceConfig;
  signal?: AbortSignal;
}

export interface RenderDocumentResult {
  html: string;
  fragmentHtml: string;
  assets: Map<string, string>;
  pandocWarnings: string[];
}

export interface BuildHtmlOptions {
  fragmentHtml: string;
  title: string;
  resourceRoot?: string;
  theme: PreviewTheme;
  fontSizePx: number;
  liveReload?: LiveReloadConfig;
}

const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown", ".mdown", ".mkd", ".qmd", ".rmd"]);
const LATEX_EXTENSIONS = new Set([".tex", ".latex"]);
const PANDOC_OUTPUT_LIMIT_BYTES = 50 * 1024 * 1024;
const ONE_SHOT_PDF_MAX_BYTES = 16 * 1024 * 1024;
const ONE_SHOT_PDF_TOTAL_BYTES = 30 * 1024 * 1024;
const PANDOC_TIMEOUT_MS = 30_000;
const MERMAID_BROWSER_VERSION = "11.16.0";
const PDFJS_BROWSER_VERSION = "4.10.38";
const PANDOC_FIGURE_CROSSREF_FILTER_PATH = fileURLToPath(
  new URL("../shared/pandoc-figure-crossrefs.lua", import.meta.url),
);
const MERMAID_BROWSER_ICON_PACKS = [
  { name: "lucide", url: "https://unpkg.com/@iconify-json/lucide@1/icons.json" },
  { name: "logos", url: "https://unpkg.com/@iconify-json/logos@1/icons.json" },
] as const;

export class PandocError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PandocError";
  }
}

export function detectFormat(filePath: string, requested: PreviewFormatOption): PreviewFormat {
  if (requested !== "auto") return requested;

  const extension = extname(filePath).toLowerCase();
  if (LATEX_EXTENSIONS.has(extension)) return "latex";
  if (MARKDOWN_EXTENSIONS.has(extension)) return "markdown";

  throw new Error(
    `Cannot detect the input format from ${extension || "a file with no extension"}. `
      + "Use --format markdown or --format latex.",
  );
}

function pandocCommand(): string {
  return process.env.PANDOC_PATH?.trim() || "pandoc";
}

function pandocInstallHint(): string {
  if (process.platform === "darwin") return "Install it with `brew install pandoc`, or set PANDOC_PATH.";
  if (process.platform === "win32") {
    return "Install it with `winget install --id JohnMacFarlane.Pandoc`, or set PANDOC_PATH.";
  }
  return "Install it with your package manager (for example `sudo apt install pandoc`), or set PANDOC_PATH.";
}

interface PandocProcessResult {
  stdout: string;
  stderr: string;
}

function renderCancelledError(): PandocError {
  return new PandocError("Preview rendering was cancelled.");
}

function throwIfRenderingAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw renderCancelledError();
}

async function runPandoc(args: string[], input?: string, signal?: AbortSignal): Promise<PandocProcessResult> {
  throwIfRenderingAborted(signal);
  const command = pandocCommand();

  return await new Promise<PandocProcessResult>((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let settled = false;
    let timedOut = false;
    let timeout: NodeJS.Timeout | undefined;

    const cleanup = (): void => {
      if (timeout) clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
    };
    const finishWithError = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectPromise(error);
    };
    const onAbort = (): void => {
      child.kill("SIGKILL");
      finishWithError(renderCancelledError());
    };

    timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, PANDOC_TIMEOUT_MS);
    timeout.unref();

    child.stdout.on("data", (chunk: Buffer | string) => {
      const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      stdoutBytes += buffer.length;
      if (stdoutBytes > PANDOC_OUTPUT_LIMIT_BYTES) {
        child.kill("SIGKILL");
        finishWithError(new PandocError("Pandoc HTML output exceeded 50 MB."));
        return;
      }
      stdoutChunks.push(buffer);
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      stderrChunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    });

    child.once("error", (error) => {
      const systemError = error as NodeJS.ErrnoException;
      if (systemError.code === "ENOENT") {
        const configured = process.env.PANDOC_PATH?.trim();
        const prefix = configured
          ? `Pandoc was not found at PANDOC_PATH=${configured}.`
          : "Pandoc was not found.";
        finishWithError(new PandocError(`${prefix} ${pandocInstallHint()}`, { cause: error }));
        return;
      }
      finishWithError(new PandocError(`Failed to start Pandoc: ${error.message}`, { cause: error }));
    });

    child.once("close", (code, closeSignal) => {
      if (settled) return;
      settled = true;
      cleanup();
      const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
      if (timedOut) {
        rejectPromise(new PandocError(`Pandoc timed out after ${PANDOC_TIMEOUT_MS / 1000} seconds.`));
        return;
      }
      if (code !== 0) {
        const status = code === null ? `signal ${closeSignal ?? "unknown"}` : `exit code ${code}`;
        rejectPromise(new PandocError(`Pandoc failed with ${status}${stderr ? `: ${stderr}` : "."}`));
        return;
      }
      resolvePromise({
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr,
      });
    });

    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") finishWithError(new PandocError(`Could not send input to Pandoc: ${error.message}`));
    });
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    else child.stdin.end(input ?? "");
  });
}

export async function assertPandocAvailable(signal?: AbortSignal): Promise<void> {
  await runPandoc(["--version"], undefined, signal);
}

function isLikelyMathExpression(expression: string): boolean {
  const content = expression.trim();
  if (!content) return false;
  if (/\\[a-zA-Z]+/.test(content)) return true;
  if (/[0-9]/.test(content)) return true;
  if (/[=+\-*/^_<>≤≥±×÷]/u.test(content)) return true;
  if (/[{}]/.test(content)) return true;
  if (/[α-ωΑ-Ω]/u.test(content)) return true;
  if (/^[A-Za-z]$/.test(content)) return true;
  if (/^[A-Za-z][A-Za-z\s'".,:;!?-]*[A-Za-z]$/.test(content)) return false;
  return false;
}

function normalizeMathInPlainSegment(markdown: string): string {
  let normalized = markdown.replace(/\\\[\s*([\s\S]*?)\s*\\\]/g, (match, expression: string) => {
    const content = expression.trim();
    if (!isLikelyMathExpression(content)) return match;
    return `$$\n${content}\n$$`;
  });

  normalized = normalized.replace(/\\\(([\s\S]*?)\\\)/g, (match, expression: string) => {
    if (!isLikelyMathExpression(expression)) return match;
    return `$${expression.trim()}$`;
  });
  return normalized;
}

export function normalizeMathDelimiters(markdown: string): string {
  const lines = markdown.split("\n");
  const output: string[] = [];
  let plainLines: string[] = [];
  let fenceCharacter: "`" | "~" | undefined;
  let fenceLength = 0;

  const flushPlain = (): void => {
    if (plainLines.length === 0) return;
    output.push(normalizeMathInPlainSegment(plainLines.join("\n")));
    plainLines = [];
  };

  for (const line of lines) {
    const match = line.trimStart().match(/^(`{3,}|~{3,})/);
    if (match) {
      const marker = match[1]!;
      const character = marker[0] as "`" | "~";
      if (!fenceCharacter) {
        flushPlain();
        fenceCharacter = character;
        fenceLength = marker.length;
        output.push(line);
        continue;
      }
      if (character === fenceCharacter && marker.length >= fenceLength) {
        fenceCharacter = undefined;
        fenceLength = 0;
      }
      output.push(line);
      continue;
    }

    if (fenceCharacter) output.push(line);
    else plainLines.push(line);
  }

  flushPlain();
  return output.join("\n");
}

function formatMarkdownImageDestination(rawPath: string): string {
  const trimmed = rawPath.trim();
  if (!trimmed) return "";
  const unwrapped = trimmed.startsWith("<") && trimmed.endsWith(">")
    ? trimmed.slice(1, -1).trim()
    : trimmed;
  return /[\s<>()]/.test(unwrapped) ? `<${unwrapped}>` : unwrapped;
}

export function normalizeObsidianImages(markdown: string): string {
  return markdown
    .replace(/!\[\[([^|\]]+)\|([^\]]+)\]\]/g, (_match, imagePath: string, alt: string) => {
      return `![${alt}](${formatMarkdownImageDestination(imagePath)})`;
    })
    .replace(/!\[\[([^\]]+)\]\]/g, (_match, imagePath: string) => {
      return `![](${formatMarkdownImageDestination(imagePath)})`;
    });
}

/** Remove authored HTML comments without exposing their Markdown contents through Pandoc's raw-HTML boundary. */
export function stripMarkdownHtmlComments(markdown: string): string {
  return stripMarkdownHtmlCommentsPreservingYamlFrontMatter(markdown);
}

function longestFenceRun(text: string, character: "`" | "~"): number {
  const pattern = character === "`" ? /`+/g : /~+/g;
  let longest = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) longest = Math.max(longest, match[0].length);
  return longest;
}

// Protect fenced blocks whose contents contain a run as long as the outer fence.
export function normalizeMarkdownFencedBlocks(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const output: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const opening = line.match(/^(\s{0,3})(`{3,}|~{3,})([^\n]*)$/);
    if (!opening) {
      output.push(line);
      continue;
    }

    const indent = opening[1] ?? "";
    const openingFence = opening[2]!;
    const suffix = opening[3] ?? "";
    const character = openingFence[0] as "`" | "~";
    let closingIndex = -1;
    for (let candidate = index + 1; candidate < lines.length; candidate += 1) {
      const closing = (lines[candidate] ?? "").match(/^\s{0,3}(`{3,}|~{3,})\s*$/);
      if (!closing) continue;
      const closingFence = closing[1]!;
      if (closingFence[0] === character && closingFence.length >= openingFence.length) {
        closingIndex = candidate;
        break;
      }
    }

    if (closingIndex === -1) {
      output.push(line);
      continue;
    }

    const contentLines = lines.slice(index + 1, closingIndex);
    const content = contentLines.join("\n");
    const backticks = longestFenceRun(content, "`");
    const tildes = longestFenceRun(content, "~");
    const currentLongest = character === "`" ? backticks : tildes;
    if (currentLongest < openingFence.length) {
      output.push(line, ...contentLines, lines[closingIndex] ?? "");
      index = closingIndex;
      continue;
    }

    const neededBackticks = Math.max(3, backticks + 1);
    const neededTildes = Math.max(3, tildes + 1);
    let replacementCharacter: "`" | "~" = character;
    if (neededBackticks < neededTildes) replacementCharacter = "`";
    else if (neededTildes < neededBackticks) replacementCharacter = "~";
    else if (character === "`") replacementCharacter = "~";
    const replacementLength = replacementCharacter === "`" ? neededBackticks : neededTildes;
    const replacement = replacementCharacter.repeat(replacementLength);
    output.push(`${indent}${replacement}${suffix}`, ...contentLines, `${indent}${replacement}`);
    index = closingIndex;
  }

  return output.join("\n");
}

export function prepareMarkdownForPandoc(markdown: string): string {
  const withoutComments = stripMarkdownHtmlComments(markdown);
  return normalizeMarkdownFencedBlocks(normalizeObsidianImages(normalizeMathDelimiters(withoutComments)));
}

export async function renderPandocFragment(
  source: string,
  format: PreviewFormat,
  resourceRoot: string,
  signal?: AbortSignal,
): Promise<{ html: string; warnings: string[] }> {
  const inputFormat = format === "latex"
    ? "latex"
    : "markdown+lists_without_preceding_blankline-blank_before_blockquote-blank_before_header+tex_math_dollars+autolink_bare_uris-raw_html-raw_attribute";
  const pandocInput = format === "latex" ? source : prepareMarkdownForPandoc(source);
  const args = [
    "-f",
    inputFormat,
    "-t",
    "html5",
    "--mathml",
    "--wrap=none",
    `--resource-path=${resourceRoot}`,
    "--metadata=pagetitle:pandoc-glance preview",
    "--standalone",
  ];
  if (format === "markdown") args.push(`--lua-filter=${PANDOC_FIGURE_CROSSREF_FILTER_PATH}`);
  const result = await runPandoc(args, pandocInput, signal);
  const body = result.stdout.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  if (!body) throw new PandocError(`Pandoc did not return a complete HTML body for the ${format} document.`);
  const html = body[1]!.trimStart();
  return {
    html,
    warnings: result.stderr ? result.stderr.split(/\r?\n/).filter(Boolean) : [],
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeJsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
}

function decodeHtmlAttribute(value: string): string {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_match, decimal: string) => String.fromCodePoint(Number.parseInt(decimal, 10)));
}

function encodeHtmlAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function decodeLocalReference(rawValue: string): LocalResourceReference | null {
  return parseLocalResourceReference(decodeHtmlAttribute(rawValue));
}

function pathIsWithin(root: string, candidate: string): boolean {
  const fromRoot = relative(resolve(root), resolve(candidate));
  return fromRoot === "" || (!fromRoot.startsWith(`..${sep}`) && fromRoot !== ".." && !isAbsolute(fromRoot));
}

interface RewriteResult {
  html: string;
  assets: Map<string, string>;
}

function markLocalPdfEmbeds(fragmentHtml: string): string {
  return fragmentHtml.replace(/<embed\b[^>]*>/gi, (tag) => {
    const srcMatch = tag.match(/\bsrc=("([^"]*)"|'([^']*)')/i);
    const localReference = srcMatch ? decodeLocalReference(srcMatch[2] ?? srcMatch[3] ?? "") : null;
    if (!localReference || extname(localReference.path).toLowerCase() !== ".pdf") return tag;

    let marked = tag;
    if (!/\btype\s*=/i.test(marked)) marked = marked.replace(/^<embed\b/i, '<embed type="application/pdf"');
    if (!/\bdata-preview-pdf\s*=/i.test(marked)) {
      marked = marked.replace(/^<embed\b/i, '<embed data-preview-pdf="true"');
    }
    return marked;
  });
}

function tagAttribute(tag: string, name: string): string | null {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = tag.match(new RegExp(`\\b${escapedName}=("([^"]*)"|'([^']*)')`, "i"));
  return match ? decodeHtmlAttribute(match[2] ?? match[3] ?? "") : null;
}

async function inlineOneShotPdfSources(
  fragmentHtml: string,
  resourceRoot: string,
  signal?: AbortSignal,
): Promise<string> {
  const replacements: Array<{ start: number; end: number; value: string }> = [];
  const tagPattern = /<embed\b[^>]*\bdata-preview-pdf=(?:"true"|'true')[^>]*>/gi;
  let totalBytes = 0;
  let match: RegExpExecArray | null;

  while ((match = tagPattern.exec(fragmentHtml)) !== null) {
    throwIfRenderingAborted(signal);
    const tag = match[0];
    const src = tagAttribute(tag, "src");
    const localReference = src ? decodeLocalReference(src) : null;
    if (!src || !localReference) continue;
    const localPath = localReference.path;
    const candidatePath = isAbsolute(localPath) || win32.isAbsolute(localPath)
      ? localPath
      : resolve(resourceRoot, localPath);

    try {
      const canonicalPath = await realpath(candidatePath);
      const metadata = await stat(canonicalPath);
      if (!metadata.isFile() || metadata.size > ONE_SHOT_PDF_MAX_BYTES) continue;
      if (totalBytes + metadata.size > ONE_SHOT_PDF_TOTAL_BYTES) continue;
      const pdf = await readFile(canonicalPath, signal ? { signal } : undefined);
      totalBytes += pdf.length;
      const dataUri = `data:application/pdf;base64,${pdf.toString("base64")}`;
      let replacement = tag.replace(
        /\bsrc=("[^"]*"|'[^']*')/i,
        `src="${dataUri}"`,
      );
      replacement = replacement.replace(
        /^<embed\b/i,
        `<embed data-preview-pdf-open-href="${encodeHtmlAttribute(src)}"`,
      );
      replacements.push({ start: match.index, end: match.index + tag.length, value: replacement });
    } catch {
      throwIfRenderingAborted(signal);
      // Leave a direct Open PDF link when a local figure cannot be inlined.
    }
  }

  let inlined = fragmentHtml;
  for (const replacement of replacements.reverse()) {
    inlined = inlined.slice(0, replacement.start) + replacement.value + inlined.slice(replacement.end);
  }
  return inlined;
}

function replaceMarkedPdfEmbedsWithPlaceholders(fragmentHtml: string): string {
  return fragmentHtml.replace(/<embed\b[^>]*\bdata-preview-pdf=(?:"true"|'true')[^>]*>/gi, (tag) => {
    const src = tagAttribute(tag, "src");
    if (!src) return tag;
    const id = tagAttribute(tag, "id");
    const style = tagAttribute(tag, "style");
    const width = tagAttribute(tag, "width");
    const alignment = tagAttribute(tag, "data-fig-align");
    const title = tagAttribute(tag, "title") || "PDF figure";
    const openHref = tagAttribute(tag, "data-preview-pdf-open-href") || src;
    const attributes = [
      id ? ` id="${encodeHtmlAttribute(id)}"` : "",
      style ? ` style="${encodeHtmlAttribute(style)}"` : "",
      width ? ` data-preview-pdf-width="${encodeHtmlAttribute(width)}"` : "",
      alignment ? ` data-fig-align="${encodeHtmlAttribute(alignment)}"` : "",
    ].join("");
    const encodedSrc = encodeHtmlAttribute(src);
    const encodedOpenHref = encodeHtmlAttribute(openHref);
    return `<div class="preview-pdf-figure preview-pdf-pending" data-preview-pdf-src="${encodedSrc}"${attributes}><div class="preview-pdf-loading" role="status">Loading PDF figure…</div><a class="preview-pdf-open" href="${encodedOpenHref}" target="_blank" rel="noopener noreferrer" title="${encodeHtmlAttribute(title)}">Open PDF</a></div>`;
  });
}

async function rewriteServerResourceUrls(
  fragmentHtml: string,
  resourceRoot: string,
  config: ServerResourceConfig,
  signal?: AbortSignal,
): Promise<RewriteResult> {
  const assets = new Map<string, string>();
  const replacements: Array<{ start: number; end: number; value: string }> = [];
  const tagPattern = /<[A-Za-z][^>]*>/g;
  let tagMatch: RegExpExecArray | null;

  while ((tagMatch = tagPattern.exec(fragmentHtml)) !== null) {
    throwIfRenderingAborted(signal);
    const tag = tagMatch[0];
    const attributePattern = /\b(?:src|href|poster|data)\s*=\s*("([^"]*)"|'([^']*)')/gi;
    let attributeMatch: RegExpExecArray | null;
    while ((attributeMatch = attributePattern.exec(tag)) !== null) {
      const quotedValue = attributeMatch[1]!;
      const rawValue = attributeMatch[2] ?? attributeMatch[3] ?? "";
      const localReference = decodeLocalReference(rawValue);
      if (!localReference) continue;

      const localPath = localReference.path;
      const absolutePath = isAbsolute(localPath) || win32.isAbsolute(localPath);
      const candidatePath = absolutePath ? localPath : resolve(resourceRoot, localPath);
      if (!previewResourceContentType(candidatePath)) continue;
      let rewritten: string;

      if (pathIsWithin(resourceRoot, candidatePath)) {
        const relativePath = relative(resolve(resourceRoot), resolve(candidatePath));
        rewritten = appendLocalResourceSuffix(
          `${config.resourcePath}?path=${encodeURIComponent(relativePath)}&v=${config.revision}`,
          localReference,
        );
      } else {
        try {
          // An authored ../ or absolute reference outside the normal resource root is
          // exposed only through an opaque, per-render allowlist entry. Arbitrary
          // traversal requests to the public resource endpoint remain forbidden.
          const canonicalPath = await realpath(candidatePath);
          const metadata = await stat(canonicalPath);
          if (!metadata.isFile()) continue;
          const assetId = createHash("sha256").update(canonicalPath).digest("base64url").slice(0, 24);
          assets.set(assetId, canonicalPath);
          rewritten = appendLocalResourceSuffix(
            `${config.assetPath}/${assetId}?v=${config.revision}`,
            localReference,
          );
        } catch {
          throwIfRenderingAborted(signal);
          continue;
        }
      }

      const quote = quotedValue[0] ?? "\"";
      const replacement = `${quote}${encodeHtmlAttribute(rewritten)}${quote}`;
      const valueOffset = attributeMatch[0].indexOf(quotedValue);
      const start = tagMatch.index + attributeMatch.index + valueOffset;
      replacements.push({
        start,
        end: start + quotedValue.length,
        value: replacement,
      });
    }
  }

  let rewrittenHtml = fragmentHtml;
  for (const replacement of replacements.reverse()) {
    rewrittenHtml = rewrittenHtml.slice(0, replacement.start) + replacement.value + rewrittenHtml.slice(replacement.end);
  }
  return { html: rewrittenHtml, assets };
}

// Adapted from pi-studio's MIT-licensed PDF figure fallback.
function buildPdfClientSource(): string {
  const pdfJsUrlJson = escapeJsonForScript(
    `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_BROWSER_VERSION}/legacy/build/pdf.min.mjs`,
  );
  const pdfJsWorkerUrlJson = escapeJsonForScript(
    `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_BROWSER_VERSION}/legacy/build/pdf.worker.min.mjs`,
  );

  return String.raw`
  let pdfJsPromise = null;

  function setPdfRenderResult(status, error) {
    window.__pdfPreviewRenderResult = error ? { status, error } : { status };
  }

  function ensurePdfJs() {
    if (window.pdfjsLib && typeof window.pdfjsLib.getDocument === "function") {
      return Promise.resolve(window.pdfjsLib);
    }
    if (pdfJsPromise) return pdfJsPromise;
    pdfJsPromise = import(${pdfJsUrlJson}).then((module) => {
      const api = module && typeof module.getDocument === "function"
        ? module
        : (module && module.default && typeof module.default.getDocument === "function" ? module.default : null);
      if (!api) throw new Error("pdf.js did not initialize.");
      if (api.GlobalWorkerOptions && !api.GlobalWorkerOptions.workerSrc) {
        api.GlobalWorkerOptions.workerSrc = ${pdfJsWorkerUrlJson};
      }
      window.pdfjsLib = api;
      return api;
    }).catch((error) => {
      pdfJsPromise = null;
      throw error;
    });
    return pdfJsPromise;
  }

  function decodePdfDataUri(src) {
    const match = String(src || "").match(/^data:application\/pdf(?:;[^,]*)?;base64,([A-Za-z0-9+/=\s]+)$/i);
    if (!match) return null;
    const binary = window.atob(String(match[1] || "").replace(/\s+/g, ""));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }

  async function loadPdfBytes(src) {
    const embedded = decodePdfDataUri(src);
    if (embedded) return embedded;
    const response = await fetch(src, { cache: "no-store" });
    if (!response.ok) throw new Error("Failed to fetch PDF figure: HTTP " + response.status);
    return new Uint8Array(await response.arrayBuffer());
  }

  function markPdfWrapperFailure(wrapper, message) {
    wrapper.classList.remove("preview-pdf-pending");
    wrapper.classList.add("preview-pdf-failed");
    const loading = wrapper.querySelector(".preview-pdf-loading");
    if (loading) loading.textContent = "PDF figure preview unavailable.";
    if (message) wrapper.title = message;
  }

  async function renderPdfWrapper(wrapper, pdfjsLib) {
    const src = String(wrapper.dataset.previewPdfSrc || "");
    if (!src) throw new Error("PDF figure has no source URL.");
    const authoredWidth = String(wrapper.dataset.previewPdfWidth || "");
    if (!wrapper.getAttribute("style") && authoredWidth) {
      wrapper.style.width = /^\d+(?:\.\d+)?$/.test(authoredWidth) ? authoredWidth + "px" : authoredWidth;
    }
    const measuredWidth = Math.max(1, Math.round(wrapper.getBoundingClientRect().width || 0));
    const bytes = await loadPdfBytes(src);
    const loadingTask = pdfjsLib.getDocument({ data: bytes });
    const pdfDocument = await loadingTask.promise;

    try {
      const page = await pdfDocument.getPage(1);
      const baseViewport = page.getViewport({ scale: 1 });
      const cssWidth = Math.max(1, measuredWidth || Math.round(baseViewport.width));
      const renderScale = Math.max(0.25, cssWidth / baseViewport.width) * Math.min(window.devicePixelRatio || 1, 2);
      const viewport = page.getViewport({ scale: renderScale });
      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) throw new Error("Canvas 2D context unavailable.");

      canvas.width = Math.max(1, Math.ceil(viewport.width));
      canvas.height = Math.max(1, Math.ceil(viewport.height));
      canvas.style.width = "100%";
      canvas.style.height = "auto";
      canvas.setAttribute("aria-label", "PDF figure preview");
      await page.render({ canvasContext: context, viewport }).promise;

      const openLink = wrapper.querySelector(".preview-pdf-open");
      wrapper.replaceChildren(canvas);
      if (openLink) wrapper.appendChild(openLink);
      wrapper.classList.remove("preview-pdf-pending", "preview-pdf-failed");
      wrapper.classList.add("preview-pdf-rendered");
      wrapper.title = "PDF figure preview (page 1)";
    } finally {
      if (typeof pdfDocument.cleanup === "function") {
        try { pdfDocument.cleanup(); } catch {}
      }
      if (typeof pdfDocument.destroy === "function") {
        try { await pdfDocument.destroy(); } catch {}
      }
    }
  }

  async function renderPdfPreviews() {
    if (!root) {
      setPdfRenderResult("skipped");
      return;
    }
    const wrappers = Array.from(root.querySelectorAll(".preview-pdf-figure[data-preview-pdf-src]"));
    if (wrappers.length === 0) {
      setPdfRenderResult("skipped");
      return;
    }

    setPdfRenderResult("pending");
    let pdfjsLib;
    try {
      pdfjsLib = await ensurePdfJs();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      wrappers.forEach((wrapper) => markPdfWrapperFailure(wrapper, message));
      setPdfRenderResult("failed", message);
      appendWarning("preview-pdf-warning", "PDF figure rendering is unavailable. Use Open PDF to view the source files.");
      console.error("pdf.js load failed:", error);
      return;
    }

    const failures = [];
    for (const wrapper of wrappers) {
      try {
        await renderPdfWrapper(wrapper, pdfjsLib);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push(message);
        markPdfWrapperFailure(wrapper, message);
        console.error("PDF figure render failed:", error);
      }
    }
    if (failures.length > 0) {
      const message = failures.length + " of " + wrappers.length + " PDF figures failed to render.";
      setPdfRenderResult("failed", message);
      appendWarning("preview-pdf-warning", message + " Use Open PDF for the affected files.");
    } else {
      setPdfRenderResult("success");
    }
  }
`;
}

// Adapted from pi-markdown-preview's MIT-licensed Mermaid icon and contrast handling.
function buildMermaidClientSource(): string {
  const mermaidUrlJson = escapeJsonForScript(
    `https://cdn.jsdelivr.net/npm/mermaid@${MERMAID_BROWSER_VERSION}/dist/mermaid.esm.min.mjs`,
  );
  const iconPacksJson = escapeJsonForScript(MERMAID_BROWSER_ICON_PACKS);

  return String.raw`
  function setMermaidRenderResult(status, error) {
    window.__mermaidRenderResult = error ? { status, error } : { status };
  }

  function renderMermaidFailure(entries, message) {
    entries.forEach((entry) => {
      const failure = document.createElement("div");
      failure.className = "mermaid-error";
      failure.setAttribute("role", "alert");

      const summary = document.createElement("div");
      summary.className = "mermaid-error-message";
      summary.textContent = "Mermaid render failed: " + message;

      const source = document.createElement("pre");
      source.className = "mermaid-source";
      const code = document.createElement("code");
      code.textContent = entry.source;
      source.appendChild(code);
      failure.append(summary, source);
      entry.wrapper.replaceChildren(failure);
    });
  }

  async function renderMermaid() {
    if (!root) {
      setMermaidRenderResult("skipped");
      return;
    }
    const blocks = Array.from(root.querySelectorAll("pre.mermaid"));
    if (blocks.length === 0) {
      setMermaidRenderResult("skipped");
      return;
    }

    setMermaidRenderResult("pending");
    const entries = blocks.map((pre) => {
      const code = pre.querySelector("code");
      const source = String(code ? code.textContent : pre.textContent || "");
      const wrapper = document.createElement("div");
      wrapper.className = "mermaid-container";
      const diagram = document.createElement("div");
      diagram.className = "mermaid";
      diagram.textContent = source;
      wrapper.appendChild(diagram);
      pre.replaceWith(wrapper);
      return { wrapper, diagram, source };
    });

    try {
      const module = await import(${mermaidUrlJson});
      const mermaid = module && module.default;
      if (!mermaid) throw new Error("Mermaid did not expose a default export.");

      const packs = ${iconPacksJson};
      const pending = new Map();
      let iconPackError = null;
      const load = (pack) => {
        if (!pending.has(pack.name)) {
          pending.set(pack.name, fetch(pack.url).then((response) => {
            if (!response.ok) {
              throw new Error("Failed to load Mermaid icon pack " + pack.name + ": HTTP " + response.status);
            }
            return response.json();
          }).catch((error) => {
            iconPackError = iconPackError || (error instanceof Error ? error : new Error(String(error)));
            throw error;
          }));
        }
        return pending.get(pack.name);
      };

      mermaid.registerIconPacks(packs.map((pack) => ({ name: pack.name, loader: () => load(pack) })));
      mermaid.initialize(mermaidConfig());
      await mermaid.run({ nodes: entries.map((entry) => entry.diagram) });
      if (iconPackError) throw iconPackError;

      const parseRgb = (value) => {
        const match = value.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/);
        return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
      };
      const isOpaqueColor = (value) => {
        if (!parseRgb(value)) return false;
        const alphaMatch = value.match(/^rgba\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*,\s*([\d.]+)\s*\)$/);
        return !alphaMatch || Number(alphaMatch[1]) >= 1;
      };
      const findOpaqueFill = (element) => {
        if (!(element instanceof Element)) return null;
        const shape = Array.from(element.querySelectorAll("rect, polygon, path, circle, ellipse")).find((candidate) => {
          return isOpaqueColor(getComputedStyle(candidate).fill);
        });
        return shape ? getComputedStyle(shape).fill : null;
      };
      const findOpaqueBackground = (element, fallback) => {
        let current = element instanceof Element ? element : null;
        while (current) {
          const background = getComputedStyle(current).backgroundColor;
          if (current instanceof HTMLElement && isOpaqueColor(background)) return background;
          current = current.parentElement;
        }
        return fallback;
      };
      const relativeLuminance = (color) => {
        const linear = color.map((channel) => {
          const value = channel / 255;
          return value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
        });
        return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
      };
      const contrastRatio = (foreground, background) => {
        const lighter = Math.max(relativeLuminance(foreground), relativeLuminance(background));
        const darker = Math.min(relativeLuminance(foreground), relativeLuminance(background));
        return (lighter + 0.05) / (darker + 0.05);
      };
      const toRgb = (color) => "rgb(" + color.map((channel) => Math.round(channel)).join(", ") + ")";
      const ensureReadableColor = (foregroundCss, backgroundCss) => {
        const foreground = parseRgb(foregroundCss);
        const background = parseRgb(backgroundCss);
        if (!foreground || !background || contrastRatio(foreground, background) >= 4.5) return foregroundCss;
        const readableCandidates = [[0, 0, 0], [255, 255, 255]].flatMap((target) => {
          for (let step = 1; step <= 20; step += 1) {
            const amount = step / 20;
            const color = foreground.map((channel, index) => channel + (target[index] - channel) * amount);
            if (contrastRatio(color, background) >= 4.5) return [{ amount, color }];
          }
          return [];
        });
        readableCandidates.sort((left, right) => left.amount - right.amount);
        if (readableCandidates.length > 0) return toRgb(readableCandidates[0].color);
        const black = [0, 0, 0];
        const white = [255, 255, 255];
        return toRgb(contrastRatio(black, background) >= contrastRatio(white, background) ? black : white);
      };

      const pageBackground = getComputedStyle(document.body).backgroundColor;
      root.querySelectorAll(".mermaid-container .icon-shape").forEach((node) => {
        const icon = node.querySelector("svg");
        if (!icon) return;
        const semanticColor = getComputedStyle(icon).color;
        const iconSurface = findOpaqueFill(node.firstElementChild)
          || findOpaqueBackground(icon, pageBackground);
        icon.style.setProperty("color", ensureReadableColor(semanticColor, iconSurface), "important");
        node.querySelectorAll(".labelBkg, .nodeLabel").forEach((label) => {
          if (!(label instanceof HTMLElement)) return;
          const labelSurface = findOpaqueBackground(label, pageBackground);
          label.style.setProperty("color", ensureReadableColor(semanticColor, labelSurface), "important");
        });
      });
      root.querySelectorAll(".mermaid-container .node:not(.icon-shape)").forEach((node) => {
        const shape = Array.from(node.querySelectorAll("rect, polygon, path, circle, ellipse")).find((candidate) => {
          const fill = getComputedStyle(candidate).fill;
          return fill && fill !== "none" && fill !== "rgba(0, 0, 0, 0)";
        });
        if (!shape) return;
        const shapeFill = getComputedStyle(shape).fill;
        node.querySelectorAll(".nodeLabel").forEach((label) => {
          if (!(label instanceof HTMLElement)) return;
          const labelColor = ensureReadableColor(getComputedStyle(label).color, shapeFill);
          label.style.setProperty("color", labelColor, "important");
        });
      });
      setMermaidRenderResult("success");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setMermaidRenderResult("failed", message);
      renderMermaidFailure(entries, message);
      appendWarning("preview-mermaid-warning", "Mermaid is unavailable. Showing the diagram source as code.");
      console.error("Mermaid render failed:", error);
    }
  }
`;
}

function buildClientScript(theme: PreviewTheme, liveReload?: LiveReloadConfig): string {
  const clientConfig = {
    theme,
    palettes: palettesForClient(),
    live: liveReload ?? null,
  };
  const configJson = escapeJsonForScript(clientConfig);

  return `
(() => {
  "use strict";
  const CONFIG = ${configJson};
  const MATHJAX_CDN_URL = "https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-chtml.js";
  const root = document.getElementById("preview-root");
  const status = document.getElementById("preview-status");
  let activeRenderError = CONFIG.live && CONFIG.live.initialError ? String(CONFIG.live.initialError) : "";

  function showStatus(message, level) {
    if (!status) return;
    status.textContent = String(message || "");
    status.dataset.level = level || "warning";
    status.hidden = !message;
  }

  function appendWarning(className, message) {
    if (!root || root.querySelector("." + className)) return;
    const warning = document.createElement("div");
    warning.className = "preview-warning " + className;
    warning.textContent = message;
    root.appendChild(warning);
  }

  function hashText(text) {
    let hash = 2166136261;
    const source = String(text || "");
    for (let index = 0; index < source.length; index += 1) {
      hash ^= source.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  function assignStableAnchors() {
    if (!root) return [];
    const selector = "h1,h2,h3,h4,h5,h6,p,figure,blockquote,ul,ol,table,div.sourceCode,pre,math[display='block'],.mermaid-container";
    const occurrences = new Map();
    return Array.from(root.querySelectorAll(selector)).map((element) => {
      if (element.id) {
        element.dataset.previewAnchor = "id:" + element.id;
        return element;
      }
      const text = String(element.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 160);
      const base = element.tagName.toLowerCase() + ":" + hashText(text);
      const occurrence = occurrences.get(base) || 0;
      occurrences.set(base, occurrence + 1);
      element.dataset.previewAnchor = base + ":" + occurrence;
      return element;
    });
  }

  function captureReadingPosition() {
    if (!CONFIG.live || !root) return;
    const elements = assignStableAnchors();
    const targetLine = Math.max(24, window.innerHeight * 0.28);
    let selected = elements[0] || null;
    for (const element of elements) {
      if (element.getBoundingClientRect().top <= targetLine) selected = element;
      else break;
    }
    const maxScroll = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
    const state = {
      anchor: selected ? selected.dataset.previewAnchor || "" : "",
      offset: selected ? selected.getBoundingClientRect().top : 0,
      ratio: window.scrollY / maxScroll,
    };
    try { sessionStorage.setItem(CONFIG.live.storageKey, JSON.stringify(state)); } catch {}
  }

  function restoreReadingPosition() {
    if (!CONFIG.live || !root) return;
    let saved = null;
    try { saved = JSON.parse(sessionStorage.getItem(CONFIG.live.storageKey) || "null"); } catch {}
    if (!saved || typeof saved !== "object") return;
    const elements = assignStableAnchors();
    const anchored = elements.find((element) => element.dataset.previewAnchor === saved.anchor);
    if (anchored) {
      const top = window.scrollY + anchored.getBoundingClientRect().top - Number(saved.offset || 0);
      window.scrollTo(0, Math.max(0, top));
      return;
    }
    const maxScroll = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    window.scrollTo(0, Math.max(0, Math.min(1, Number(saved.ratio || 0))) * maxScroll);
  }

  function currentPalette() {
    if (CONFIG.theme === "dark") return CONFIG.palettes.dark;
    if (CONFIG.theme === "light") return CONFIG.palettes.light;
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches
      ? CONFIG.palettes.dark
      : CONFIG.palettes.light;
  }

  function mermaidConfig() {
    const palette = currentPalette();
    return {
      startOnLoad: false,
      theme: "base",
      themeVariables: {
        background: palette.bg,
        primaryColor: palette.panel,
        primaryTextColor: palette.text,
        primaryBorderColor: palette.codeBorder,
        secondaryColor: palette.card,
        secondaryTextColor: palette.text,
        secondaryBorderColor: palette.codeBorder,
        tertiaryColor: palette.card,
        tertiaryTextColor: palette.text,
        tertiaryBorderColor: palette.codeBorder,
        lineColor: palette.quote,
        textColor: palette.text,
        edgeLabelBackground: palette.panel,
        nodeBorder: palette.codeBorder,
        clusterBkg: palette.card,
        clusterBorder: palette.codeBorder,
        titleColor: palette.heading,
      },
    };
  }

${buildMermaidClientSource()}
${buildPdfClientSource()}

  function fallbackMathTargets() {
    if (!root) return [];
    const targets = [];
    const seen = new Set();
    Array.from(root.querySelectorAll(".math.display, .math.inline")).forEach((node) => {
      const display = node.classList.contains("display");
      let source = String(node.textContent || "").trim();
      if (!source) return;
      if (display && source.startsWith("$$") && source.endsWith("$$")) source = source.slice(2, -2).trim();
      else if (display && source.startsWith("\\\\[") && source.endsWith("\\\\]")) source = source.slice(2, -2).trim();
      else if (!display && source.startsWith("\\\\(") && source.endsWith("\\\\)")) source = source.slice(2, -2).trim();
      else if (!display && source.startsWith("$") && source.endsWith("$")) source = source.slice(1, -1).trim();
      let renderTarget = node;
      if (display && node.parentElement && node.parentElement.tagName === "P"
          && String(node.parentElement.textContent || "").trim() === String(node.textContent || "").trim()) {
        renderTarget = node.parentElement;
      }
      if (!source || seen.has(renderTarget)) return;
      seen.add(renderTarget);
      targets.push({ renderTarget, display, source });
    });
    return targets;
  }

  let mathJaxPromise = null;
  function ensureMathJax() {
    if (window.MathJax && typeof window.MathJax.typesetPromise === "function") return Promise.resolve(window.MathJax);
    if (mathJaxPromise) return mathJaxPromise;
    mathJaxPromise = new Promise((resolvePromise, rejectPromise) => {
      window.MathJax = {
        loader: { load: ["[tex]/ams", "[tex]/noerrors", "[tex]/noundefined"] },
        tex: {
          inlineMath: [["\\\\(", "\\\\)"], ["$", "$"]],
          displayMath: [["\\\\[", "\\\\]"], ["$$", "$$"]],
          packages: { "[+]": ["ams", "noerrors", "noundefined"] },
        },
        options: { skipHtmlTags: ["script", "noscript", "style", "textarea", "pre", "code"] },
        startup: { typeset: false },
      };
      const script = document.createElement("script");
      script.src = MATHJAX_CDN_URL;
      script.async = true;
      script.onload = () => {
        const api = window.MathJax;
        if (api && api.startup && api.startup.promise) api.startup.promise.then(() => resolvePromise(api)).catch(rejectPromise);
        else if (api && typeof api.typesetPromise === "function") resolvePromise(api);
        else rejectPromise(new Error("MathJax did not initialize."));
      };
      script.onerror = () => rejectPromise(new Error("Failed to load MathJax."));
      document.head.appendChild(script);
    }).catch((error) => {
      mathJaxPromise = null;
      throw error;
    });
    return mathJaxPromise;
  }

  async function renderMathFallback() {
    const targets = fallbackMathTargets();
    if (targets.length === 0) return;
    try {
      const mathJax = await ensureMathJax();
      targets.forEach((entry) => {
        entry.renderTarget.textContent = entry.display
          ? "\\\\[\\n" + entry.source + "\\n\\\\]"
          : "\\\\(" + entry.source + "\\\\)";
      });
      await mathJax.typesetPromise(targets.map((entry) => entry.renderTarget));
    } catch (error) {
      console.error("MathJax fallback failed:", error);
      appendWarning("preview-math-warning", "MathJax fallback is unavailable. Unsupported equations may remain as TeX.");
    }
  }

  function connectLiveReload() {
    if (!CONFIG.live || typeof EventSource !== "function") return;
    if (activeRenderError) showStatus("Render failed; watching for a correction:\\n" + activeRenderError, "error");
    const events = new EventSource(CONFIG.live.eventsPath);
    events.addEventListener("preview", (event) => {
      let update;
      try { update = JSON.parse(event.data); } catch { return; }
      if (update.status === "error") {
        activeRenderError = String(update.error || "Unknown render error");
        const prefix = Number(update.successfulRevision || 0) > 0
          ? "Render failed; the last successful preview is still shown:\\n"
          : "Initial render failed; watching for a correction:\\n";
        showStatus(prefix + activeRenderError, "error");
        return;
      }
      activeRenderError = "";
      if (Number(update.revision || 0) > Number(CONFIG.live.revision || 0)) {
        captureReadingPosition();
        window.location.reload();
        return;
      }
      showStatus("", "");
    });
    events.addEventListener("open", () => {
      if (!activeRenderError) showStatus("", "");
    });
    events.addEventListener("error", () => {
      if (!activeRenderError) showStatus("Live reload disconnected; reconnecting…", "warning");
    });
  }

  async function initialize() {
    assignStableAnchors();
    restoreReadingPosition();
    connectLiveReload();
    await Promise.all([renderMermaid(), renderMathFallback(), renderPdfPreviews()]);
    if (document.fonts && document.fonts.ready) {
      try { await document.fonts.ready; } catch {}
    }
    requestAnimationFrame(() => requestAnimationFrame(restoreReadingPosition));
    window.__pandocGlanceReady = true;
  }

  if (CONFIG.theme === "auto" && window.matchMedia) {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", () => {
      if (root && root.querySelector(".mermaid-container")) {
        captureReadingPosition();
        window.location.reload();
      }
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => { void initialize(); }, { once: true });
  else void initialize();
})();
`;
}

export function buildPreviewHtml(options: BuildHtmlOptions): string {
  const baseTag = options.resourceRoot
    ? `<base href="${pathToFileURL(resolve(options.resourceRoot) + sep).href}" />\n`
    : "";
  const clientScript = buildClientScript(options.theme, options.liveReload).replace(/<\/script/gi, "<\\/script");
  const css = buildPreviewCss(options.theme, options.fontSizePx);
  const scriptNonce = createPreviewScriptNonce();
  const contentSecurityPolicy = previewContentSecurityPolicy(scriptNonce, "file");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta id="${PREVIEW_CSP_META_ID}" http-equiv="Content-Security-Policy" content="${encodeHtmlAttribute(contentSecurityPolicy)}" />
${baseTag}<title>${escapeHtml(options.title)}</title>
<style>${css}</style>
</head>
<body>
<article id="preview-root">${options.fragmentHtml}</article>
<div id="preview-status" role="status" aria-live="polite" hidden></div>
<script type="module" ${TRUSTED_PREVIEW_SCRIPT_ATTRIBUTE}="true" nonce="${scriptNonce}">${clientScript}</script>
</body>
</html>`;
}

export function buildInitialErrorHtml(options: {
  title: string;
  error: string;
  theme: PreviewTheme;
  fontSizePx: number;
  liveReload: LiveReloadConfig;
}): string {
  const fragmentHtml = `<section class="initial-render-error"><h1>Preview render failed</h1><p>Fix the file and save it; this page will recover automatically.</p><pre>${escapeHtml(options.error)}</pre></section>`;
  return buildPreviewHtml({
    fragmentHtml,
    title: options.title,
    theme: options.theme,
    fontSizePx: options.fontSizePx,
    liveReload: { ...options.liveReload, initialError: options.error },
  });
}

export async function renderDocument(options: RenderDocumentOptions): Promise<RenderDocumentResult> {
  const rendered = await renderPandocFragment(options.source, options.format, options.resourceRoot, options.signal);
  throwIfRenderingAborted(options.signal);
  let fragmentHtml = markLocalPdfEmbeds(rendered.html);
  let assets = new Map<string, string>();

  if (options.serverResources) {
    const rewritten = await rewriteServerResourceUrls(
      fragmentHtml,
      options.resourceRoot,
      options.serverResources,
      options.signal,
    );
    fragmentHtml = rewritten.html;
    assets = rewritten.assets;
  } else {
    fragmentHtml = await inlineOneShotPdfSources(fragmentHtml, options.resourceRoot, options.signal);
  }
  throwIfRenderingAborted(options.signal);
  fragmentHtml = replaceMarkedPdfEmbedsWithPlaceholders(fragmentHtml);

  const htmlOptions: BuildHtmlOptions = {
    fragmentHtml,
    title: options.title ?? `${basename(options.sourcePath)} — pandoc-glance`,
    theme: options.theme,
    fontSizePx: options.fontSizePx,
  };
  if (!options.serverResources) htmlOptions.resourceRoot = options.resourceRoot;
  if (options.liveReload) htmlOptions.liveReload = options.liveReload;

  return {
    html: buildPreviewHtml(htmlOptions),
    fragmentHtml,
    assets,
    pandocWarnings: rendered.warnings,
  };
}
