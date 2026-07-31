import chokidar, { type FSWatcher } from "chokidar";
import { dirname, resolve } from "node:path";

export interface DebouncedFileWatcherOptions {
  debounceMs?: number;
  onError?: (error: unknown) => void;
}

/**
 * Watches the containing directory rather than only the inode, so editor
 * atomic-save rename/replacement patterns continue to trigger updates.
 */
export class DebouncedFileWatcher {
  readonly filePath: string;

  #watcher: FSWatcher;
  #callback: () => void | Promise<void>;
  #debounceMs: number;
  #timer: NodeJS.Timeout | null = null;
  #closed = false;
  #ready: Promise<void>;

  constructor(filePath: string, callback: () => void | Promise<void>, options: DebouncedFileWatcherOptions = {}) {
    this.filePath = resolve(filePath);
    this.#callback = callback;
    this.#debounceMs = options.debounceMs ?? 140;

    const parentDirectory = dirname(this.filePath);
    this.#watcher = chokidar.watch(parentDirectory, {
      persistent: true,
      ignoreInitial: true,
      depth: 0,
      atomic: true,
      awaitWriteFinish: {
        stabilityThreshold: 70,
        pollInterval: 10,
      },
    });

    this.#ready = new Promise<void>((resolvePromise, rejectPromise) => {
      const onReady = (): void => {
        this.#watcher.off("error", onInitialError);
        resolvePromise();
      };
      const onInitialError = (error: unknown): void => {
        this.#watcher.off("ready", onReady);
        rejectPromise(error);
      };
      this.#watcher.once("ready", onReady);
      this.#watcher.once("error", onInitialError);
    });
    this.#watcher.on("error", (error) => options.onError?.(error));

    const handlePath = (changedPath: string): void => {
      if (resolve(changedPath) !== this.filePath) return;
      this.#schedule();
    };
    this.#watcher.on("add", handlePath);
    this.#watcher.on("change", handlePath);
    this.#watcher.on("unlink", handlePath);
  }

  async ready(): Promise<void> {
    await this.#ready;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    await this.#watcher.close();
  }

  #schedule(): void {
    if (this.#closed) return;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = null;
      if (this.#closed) return;
      void Promise.resolve(this.#callback()).catch(() => {
        // The owner reports callback errors; never let a watcher callback create
        // an unhandled rejection that terminates watch mode.
      });
    }, this.#debounceMs);
  }
}
