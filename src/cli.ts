#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import { readFile, readdir, mkdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { openInDefaultBrowser } from "./browser.js";
import {
  assertPandocAvailable,
  detectFormat,
  renderDocument,
  type PreviewFormatOption,
} from "./render.js";
import type { PreviewTheme } from "./styles.js";
import { startWatchPreview, type WatchPreviewSession } from "./watch-preview.js";

export const VERSION = "0.1.0";
export const DEFAULT_FONT_SIZE_PX = 15;
export const MIN_FONT_SIZE_PX = 10;
export const MAX_FONT_SIZE_PX = 24;

export interface CliOptions {
  action: "run" | "help" | "version";
  inputPath?: string;
  watch: boolean;
  open: boolean;
  theme: PreviewTheme;
  format: PreviewFormatOption;
  fontSizePx: number;
  port: number;
}

export class CliArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliArgumentError";
  }
}

function optionValue(argv: string[], index: number, option: string, inlineValue: string | undefined): {
  value: string;
  nextIndex: number;
} {
  if (inlineValue !== undefined) {
    if (!inlineValue) throw new CliArgumentError(`${option} requires a value.`);
    return { value: inlineValue, nextIndex: index };
  }
  const value = argv[index + 1];
  if (value === undefined) throw new CliArgumentError(`${option} requires a value.`);
  return { value, nextIndex: index + 1 };
}

function parseFontSize(rawValue: string): number {
  if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(rawValue)) {
    throw new CliArgumentError(`Invalid --font-size value: ${rawValue}. Expected a number from ${MIN_FONT_SIZE_PX} to ${MAX_FONT_SIZE_PX}.`);
  }
  const value = Number(rawValue);
  if (!Number.isFinite(value) || value < MIN_FONT_SIZE_PX || value > MAX_FONT_SIZE_PX) {
    throw new CliArgumentError(`--font-size must be between ${MIN_FONT_SIZE_PX} and ${MAX_FONT_SIZE_PX}px.`);
  }
  return Math.round(value * 10) / 10;
}

function parsePort(rawValue: string): number {
  if (!/^\d+$/.test(rawValue)) {
    throw new CliArgumentError(`Invalid --port value: ${rawValue}. Expected an integer from 0 to 65535.`);
  }
  const value = Number(rawValue);
  if (!Number.isSafeInteger(value) || value < 0 || value > 65_535) {
    throw new CliArgumentError("--port must be an integer from 0 to 65535.");
  }
  return value;
}

export function parseCliArgs(argv: string[]): CliOptions {
  if (argv.includes("--help") || argv.includes("-h")) {
    return {
      action: "help",
      watch: false,
      open: true,
      theme: "auto",
      format: "auto",
      fontSizePx: DEFAULT_FONT_SIZE_PX,
      port: 0,
    };
  }
  if (argv.includes("--version") || argv.includes("-v")) {
    return {
      action: "version",
      watch: false,
      open: true,
      theme: "auto",
      format: "auto",
      fontSizePx: DEFAULT_FONT_SIZE_PX,
      port: 0,
    };
  }

  let watch = false;
  let open = true;
  let theme: PreviewTheme = "auto";
  let format: PreviewFormatOption = "auto";
  let fontSizePx = DEFAULT_FONT_SIZE_PX;
  let port = 0;
  const positional: string[] = [];
  let positionalOnly = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (positionalOnly) {
      positional.push(token);
      continue;
    }
    if (token === "--") {
      positionalOnly = true;
      continue;
    }
    if (token === "--watch" || token === "-w") {
      watch = true;
      continue;
    }
    if (token === "--no-open") {
      open = false;
      continue;
    }

    const equalsIndex = token.indexOf("=");
    const option = equalsIndex >= 0 ? token.slice(0, equalsIndex) : token;
    const inlineValue = equalsIndex >= 0 ? token.slice(equalsIndex + 1) : undefined;

    if (option === "--theme") {
      const parsed = optionValue(argv, index, option, inlineValue);
      index = parsed.nextIndex;
      if (parsed.value !== "auto" && parsed.value !== "light" && parsed.value !== "dark") {
        throw new CliArgumentError(`Invalid --theme value: ${parsed.value}. Expected auto, light, or dark.`);
      }
      theme = parsed.value;
      continue;
    }
    if (option === "--format") {
      const parsed = optionValue(argv, index, option, inlineValue);
      index = parsed.nextIndex;
      if (parsed.value !== "auto" && parsed.value !== "markdown" && parsed.value !== "latex") {
        throw new CliArgumentError(`Invalid --format value: ${parsed.value}. Expected auto, markdown, or latex.`);
      }
      format = parsed.value;
      continue;
    }
    if (option === "--font-size") {
      const parsed = optionValue(argv, index, option, inlineValue);
      index = parsed.nextIndex;
      fontSizePx = parseFontSize(parsed.value);
      continue;
    }
    if (option === "--port") {
      const parsed = optionValue(argv, index, option, inlineValue);
      index = parsed.nextIndex;
      port = parsePort(parsed.value);
      continue;
    }
    if (token.startsWith("-")) throw new CliArgumentError(`Unknown option: ${token}`);
    positional.push(token);
  }

  if (positional.length === 0) throw new CliArgumentError("Missing input file. Run pandoc-glance --help for usage.");
  if (positional.length > 1) {
    throw new CliArgumentError(`Expected one input file, but received ${positional.length}: ${positional.join(", ")}`);
  }

  return {
    action: "run",
    inputPath: positional[0]!,
    watch,
    open,
    theme,
    format,
    fontSizePx,
    port,
  };
}

export function helpText(): string {
  return `pandoc-glance ${VERSION}

High-fidelity Markdown and LaTeX preview in your default browser.

Usage:
  pandoc-glance [options] <file>
  pandoc-glance --watch [options] <file>
  pandoc-glance <file> --watch

Options:
  -w, --watch             Watch the file and refresh the existing browser tab
      --no-open           Do not launch a browser; print the path or URL
      --theme <mode>      auto, light, or dark (default: auto)
      --format <format>   auto, markdown, or latex (default: auto)
      --font-size <px>    Base font size, ${MIN_FONT_SIZE_PX}-${MAX_FONT_SIZE_PX} (default: ${DEFAULT_FONT_SIZE_PX})
      --port <number>     Watch-server port; 0 chooses an available port (default: 0)
  -h, --help              Show this help
  -v, --version           Show the version

Pandoc is required. Set PANDOC_PATH to use a non-default Pandoc binary.
Watch mode is save-based: it sees changes written to disk, not unsaved editor buffers.`;
}

async function validateInputFile(inputPath: string): Promise<void> {
  let metadata;
  try {
    metadata = await stat(inputPath);
  } catch (error) {
    const systemError = error as NodeJS.ErrnoException;
    if (systemError.code === "ENOENT") throw new Error(`Input file does not exist: ${inputPath}`);
    throw new Error(`Cannot access input file ${inputPath}: ${systemError.message}`, { cause: error });
  }
  if (!metadata.isFile()) throw new Error(`Input path is not a regular file: ${inputPath}`);
}

function cacheDirectory(): string {
  const xdgCache = process.env.XDG_CACHE_HOME?.trim();
  if (xdgCache) return join(xdgCache, "pandoc-glance");
  if (process.platform === "darwin") return join(homedir(), "Library", "Caches", "pandoc-glance");
  return join(homedir(), ".cache", "pandoc-glance");
}

async function pruneCache(directory: string, keepPath: string): Promise<void> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }

  const htmlFiles = await Promise.all(entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".html"))
    .map(async (entry) => {
      const filePath = join(directory, entry.name);
      const metadata = await stat(filePath).catch(() => null);
      return metadata ? { filePath, modified: metadata.mtimeMs } : null;
    }));
  const sorted = htmlFiles
    .filter((entry): entry is { filePath: string; modified: number } => entry !== null)
    .sort((left, right) => right.modified - left.modified);

  await Promise.all(sorted.slice(30).map(async (entry) => {
    if (entry.filePath !== keepPath) await unlink(entry.filePath).catch(() => undefined);
  }));
}

async function writeOneShotHtml(inputPath: string, html: string, options: CliOptions): Promise<string> {
  const directory = cacheDirectory();
  await mkdir(directory, { recursive: true });
  const key = createHash("sha256")
    .update(resolve(inputPath))
    .update("\0")
    .update(options.theme)
    .update("\0")
    .update(options.format)
    .update("\0")
    .update(String(options.fontSizePx))
    .digest("hex")
    .slice(0, 24);
  const outputPath = join(directory, `${key}.html`);
  const temporaryPath = join(directory, `.${key}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  await writeFile(temporaryPath, html, "utf8");
  await rename(temporaryPath, outputPath);
  await pruneCache(directory, outputPath);
  return outputPath;
}

async function waitForShutdown(session: WatchPreviewSession): Promise<void> {
  await new Promise<void>((resolvePromise) => {
    let shuttingDown = false;
    const onInterrupt = (): void => shutdown("SIGINT");
    const onTerminate = (): void => shutdown("SIGTERM");
    const shutdown = (signal: NodeJS.Signals): void => {
      if (shuttingDown) return;
      shuttingDown = true;
      process.off("SIGINT", onInterrupt);
      process.off("SIGTERM", onTerminate);
      process.stderr.write(`\nReceived ${signal}; shutting down preview server…\n`);
      void session.close().then(resolvePromise, resolvePromise);
    };
    process.once("SIGINT", onInterrupt);
    process.once("SIGTERM", onTerminate);
  });
}

async function runOneShot(options: CliOptions, inputPath: string): Promise<number> {
  const format = detectFormat(inputPath, options.format);
  const source = await readFile(inputPath, "utf8");
  const rendered = await renderDocument({
    source,
    sourcePath: inputPath,
    resourceRoot: dirname(inputPath),
    format,
    theme: options.theme,
    fontSizePx: options.fontSizePx,
    title: `${basename(inputPath)} — pandoc-glance`,
  });
  for (const warning of rendered.pandocWarnings) process.stderr.write(`Pandoc: ${warning}\n`);
  const outputPath = await writeOneShotHtml(inputPath, rendered.html, options);
  process.stdout.write(`HTML: ${outputPath}\n`);
  if (options.open) await openInDefaultBrowser(pathToFileURL(outputPath).href);
  return 0;
}

async function runWatch(options: CliOptions, inputPath: string): Promise<number> {
  const format = detectFormat(inputPath, options.format);
  let recovered = false;
  const session = await startWatchPreview({
    inputPath,
    format,
    theme: options.theme,
    fontSizePx: options.fontSizePx,
    port: options.port,
    onLog: (message, level) => {
      const stream = level === "info" ? process.stdout : process.stderr;
      stream.write(`${message}\n`);
    },
    onStatus: (status) => {
      if (status.status === "success" && status.revision > 1) recovered = true;
    },
  });

  process.stdout.write(`Watching: ${inputPath}\n`);
  process.stdout.write(`Preview URL: ${session.url}\n`);
  process.stdout.write("Updates are save-based; unsaved editor buffers are not visible.\n");
  if (session.initialError) {
    process.stderr.write(`Initial render failed; watch mode remains active for recovery: ${session.initialError}\n`);
  }

  try {
    if (options.open) await openInDefaultBrowser(session.url);
  } catch (error) {
    await session.close();
    throw error;
  }

  await waitForShutdown(session);
  return session.initialError && !recovered ? 1 : 0;
}

export async function runCli(argv: string[]): Promise<number> {
  let options: CliOptions;
  try {
    options = parseCliArgs(argv);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Error: ${message}\n`);
    return 2;
  }

  if (options.action === "help") {
    process.stdout.write(`${helpText()}\n`);
    return 0;
  }
  if (options.action === "version") {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  if (Number(process.versions.node.split(".")[0]) < 22) {
    process.stderr.write(`Error: pandoc-glance requires Node.js 22 or newer (found ${process.version}).\n`);
    return 1;
  }

  const inputPath = resolve(options.inputPath!);
  try {
    await validateInputFile(inputPath);
    await assertPandocAvailable();
    return options.watch ? await runWatch(options, inputPath) : await runOneShot(options, inputPath);
  } catch (error) {
    process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

const entryPoint = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (entryPoint === import.meta.url) {
  void runCli(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
