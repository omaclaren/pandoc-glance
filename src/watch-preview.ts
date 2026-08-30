import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import {
  buildInitialErrorHtml,
  renderDocument,
  type PreviewFormat,
} from "./render.js";
import { PreviewServer, type PreviewServerState } from "./server.js";
import type { PreviewTheme } from "./styles.js";
import { DebouncedFileWatcher } from "./watcher.js";

export interface WatchRenderContext {
  revision: number;
  sourcePath: string;
  resourceRoot: string;
  format: PreviewFormat;
  theme: PreviewTheme;
  fontSizePx: number;
  eventsPath: string;
  resourcePath: string;
  assetPath: string;
  storageKey: string;
  signal: AbortSignal;
}

export interface WatchRenderResult {
  html: string;
  assets?: Map<string, string>;
  warnings?: string[];
}

export type WatchRenderer = (source: string, context: WatchRenderContext) => Promise<WatchRenderResult>;

export interface WatchPreviewStatus {
  revision: number;
  status: "success" | "error";
  error?: string;
}

export interface StartWatchPreviewOptions {
  inputPath: string;
  format: PreviewFormat;
  theme: PreviewTheme;
  fontSizePx: number;
  port?: number;
  debounceMs?: number;
  signal?: AbortSignal;
  renderer?: WatchRenderer;
  onLog?: (message: string, level: "info" | "warning" | "error") => void;
  onStatus?: (status: WatchPreviewStatus) => void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class WatchPreviewSession {
  readonly inputPath: string;
  readonly server: PreviewServer;
  readonly initialError: string | null;

  #watcher: DebouncedFileWatcher;
  #closeRequested = false;
  #closePromise: Promise<void> | null = null;
  #getRenderChain: () => Promise<void>;
  #onBeforeClose: () => void;

  constructor(options: {
    inputPath: string;
    server: PreviewServer;
    watcher: DebouncedFileWatcher;
    initialError: string | null;
    getRenderChain: () => Promise<void>;
    onBeforeClose: () => void;
  }) {
    this.inputPath = options.inputPath;
    this.server = options.server;
    this.#watcher = options.watcher;
    this.initialError = options.initialError;
    this.#getRenderChain = options.getRenderChain;
    this.#onBeforeClose = options.onBeforeClose;
  }

  get url(): string {
    return this.server.url;
  }

  get state(): PreviewServerState {
    return this.server.state;
  }

  async waitForIdle(): Promise<void> {
    await this.#getRenderChain();
  }

  async close(): Promise<void> {
    if (this.#closePromise) return await this.#closePromise;
    this.#closeRequested = true;
    this.#onBeforeClose();
    this.#closePromise = (async () => {
      const renderChain = this.#getRenderChain();
      void renderChain.catch(() => undefined);
      const results = await Promise.allSettled([
        this.#watcher.close(),
        this.server.close(),
      ]);
      const errors = results
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => result.reason);
      if (errors.length > 0) throw new AggregateError(errors, "Failed to close the preview session cleanly.");
    })();
    return await this.#closePromise;
  }

  get closeRequested(): boolean {
    return this.#closeRequested;
  }
}

async function defaultRenderer(source: string, context: WatchRenderContext): Promise<WatchRenderResult> {
  const rendered = await renderDocument({
    source,
    sourcePath: context.sourcePath,
    resourceRoot: context.resourceRoot,
    format: context.format,
    theme: context.theme,
    fontSizePx: context.fontSizePx,
    title: `${basename(context.sourcePath)} — pandoc-glance`,
    liveReload: {
      eventsPath: context.eventsPath,
      revision: context.revision,
      storageKey: context.storageKey,
    },
    serverResources: {
      resourcePath: context.resourcePath,
      assetPath: context.assetPath,
      revision: context.revision,
    },
    signal: context.signal,
  });
  return {
    html: rendered.html,
    assets: rendered.assets,
    warnings: rendered.pandocWarnings,
  };
}

export async function startWatchPreview(options: StartWatchPreviewOptions): Promise<WatchPreviewSession> {
  const inputPath = resolve(options.inputPath);
  const resourceRoot = dirname(inputPath);
  const serverOptions: { resourceRoot: string; port?: number } = { resourceRoot };
  if (options.port !== undefined) serverOptions.port = options.port;
  const server = await PreviewServer.create(serverOptions);
  await server.start();

  const renderer = options.renderer ?? defaultRenderer;
  const log = options.onLog ?? (() => undefined);
  const renderAbortController = new AbortController();
  let renderInFlight: Promise<void> | null = null;
  let renderQueued = false;
  let closed = false;
  let lastStatus: "starting" | "success" | "error" = "starting";
  let lastSuccessfulSourceHash: string | null = null;

  const abortRendering = (): void => {
    closed = true;
    renderQueued = false;
    renderAbortController.abort();
  };
  options.signal?.addEventListener("abort", abortRendering, { once: true });
  if (options.signal?.aborted) abortRendering();

  const renderOnce = async (): Promise<void> => {
    if (closed) return;
    const revision = server.state.revision + 1;
    try {
      const source = await readFile(inputPath, {
        encoding: "utf8",
        signal: renderAbortController.signal,
      });
      const sourceHash = createHash("sha256").update(source).digest("hex");
      if (server.state.status === "success" && sourceHash === lastSuccessfulSourceHash) return;
      const rendered = await renderer(source, {
        revision,
        sourcePath: inputPath,
        resourceRoot,
        format: options.format,
        theme: options.theme,
        fontSizePx: options.fontSizePx,
        eventsPath: server.paths.events,
        resourcePath: server.paths.resource,
        assetPath: server.paths.asset,
        storageKey: `pandoc-glance:${server.token}`,
        signal: renderAbortController.signal,
      });
      if (closed) return;
      server.publishSuccess(revision, rendered.html, rendered.assets ?? new Map());
      lastSuccessfulSourceHash = sourceHash;
      // Reconcile after rendering in case a save landed while the read/render was
      // in flight and its filesystem event was coalesced. The content hash makes
      // the ordinary unchanged case a cheap no-op.
      renderQueued = true;
      for (const warning of rendered.warnings ?? []) log(`Pandoc: ${warning}`, "warning");
      if (lastStatus === "error") log(`Render recovered (revision ${revision}).`, "info");
      else log(`Rendered revision ${revision}.`, "info");
      lastStatus = "success";
      options.onStatus?.({ revision, status: "success" });
    } catch (error) {
      if (closed) return;
      const message = errorMessage(error);
      const initialErrorHtml = server.state.successfulRevision === 0
        ? buildInitialErrorHtml({
            title: `${basename(inputPath)} — pandoc-glance`,
            error: message,
            theme: options.theme,
            fontSizePx: options.fontSizePx,
            liveReload: {
              eventsPath: server.paths.events,
              revision,
              storageKey: `pandoc-glance:${server.token}`,
            },
          })
        : undefined;
      server.publishError(revision, message, initialErrorHtml);
      log(`Render failed (revision ${revision}): ${message}`, "error");
      lastStatus = "error";
      options.onStatus?.({ revision, status: "error", error: message });
    }
  };

  const enqueueRender = (): Promise<void> => {
    if (closed) return Promise.resolve();
    renderQueued = true;
    if (renderInFlight) return renderInFlight;

    const loop = (async (): Promise<void> => {
      while (!closed && renderQueued) {
        renderQueued = false;
        await renderOnce();
      }
    })();
    const tracked = loop.finally(() => {
      if (renderInFlight === tracked) renderInFlight = null;
    });
    renderInFlight = tracked;
    return tracked;
  };

  const watcherOptions = {
    ...(options.debounceMs === undefined ? {} : { debounceMs: options.debounceMs }),
    onError: (error: unknown) => log(`File watcher error: ${errorMessage(error)}`, "error"),
  };
  const watcher = new DebouncedFileWatcher(inputPath, enqueueRender, watcherOptions);

  try {
    await watcher.ready();
    await enqueueRender();
  } catch (error) {
    abortRendering();
    options.signal?.removeEventListener("abort", abortRendering);
    await watcher.close().catch(() => undefined);
    await server.close().catch(() => undefined);
    throw error;
  }

  const initialError = server.state.status === "error" ? server.state.error : null;
  const session = new WatchPreviewSession({
    inputPath,
    server,
    watcher,
    initialError,
    getRenderChain: () => renderInFlight ?? Promise.resolve(),
    onBeforeClose: () => {
      options.signal?.removeEventListener("abort", abortRendering);
      abortRendering();
    },
  });
  return session;
}
