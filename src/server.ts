import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isAbsolute, relative, resolve, sep, win32 } from "node:path";
import type { AddressInfo } from "node:net";
import { isNetworkResourcePath } from "./local-resource.js";
import { previewResourceContentType } from "./resource-types.js";
import {
  createPreviewScriptNonce,
  preparePreviewHtmlForHttp,
  previewContentSecurityPolicy,
} from "./security.js";

export interface PreviewServerOptions {
  resourceRoot: string;
  port?: number;
  token?: string;
}

export interface PreviewServerState {
  revision: number;
  successfulRevision: number;
  status: "starting" | "success" | "error";
  error: string | null;
}

export interface PreviewServerPaths {
  document: string;
  events: string;
  state: string;
  resource: string;
  asset: string;
}

export class ResourceAccessError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode = 403) {
    super(message);
    this.name = "ResourceAccessError";
    this.statusCode = statusCode;
  }
}

function pathIsWithin(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return fromRoot === "" || (!fromRoot.startsWith(`..${sep}`) && fromRoot !== ".." && !isAbsolute(fromRoot));
}

function decodeConservatively(value: string): string {
  let decoded = value;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    let next: string;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      throw new ResourceAccessError("Malformed resource path.", 400);
    }
    if (next === decoded) return decoded;
    decoded = next;
  }
  if (/%[0-9a-f]{2}/i.test(decoded)) throw new ResourceAccessError("Over-encoded resource path.");
  return decoded;
}

/** Resolve a user-controlled resource path without allowing traversal or symlink escape. */
export async function resolveSafeResourcePath(canonicalRoot: string, requestedPath: string): Promise<string> {
  const decoded = decodeConservatively(requestedPath);
  if (!decoded || decoded.includes("\0")) throw new ResourceAccessError("Invalid resource path.", 400);
  if (isNetworkResourcePath(decoded)) throw new ResourceAccessError("Network resource paths are not allowed.");
  if (isAbsolute(decoded) || win32.isAbsolute(decoded)) throw new ResourceAccessError("Absolute resource paths are not allowed.");

  const slashNormalized = decoded.replace(/\\/g, "/");
  if (slashNormalized.split("/").some((segment) => segment === "..")) {
    throw new ResourceAccessError("Resource path traversal is not allowed.");
  }

  const lexicalCandidate = resolve(canonicalRoot, decoded);
  if (!pathIsWithin(canonicalRoot, lexicalCandidate)) {
    throw new ResourceAccessError("Resource path escapes the document directory.");
  }

  let canonicalCandidate: string;
  try {
    canonicalCandidate = await realpath(lexicalCandidate);
  } catch (error) {
    const systemError = error as NodeJS.ErrnoException;
    if (systemError.code === "ENOENT" || systemError.code === "ENOTDIR") {
      throw new ResourceAccessError("Resource not found.", 404);
    }
    throw error;
  }

  if (!pathIsWithin(canonicalRoot, canonicalCandidate)) {
    throw new ResourceAccessError("Symlinked resource escapes the document directory.");
  }

  const metadata = await stat(canonicalCandidate);
  if (!metadata.isFile()) throw new ResourceAccessError("Resource is not a file.", 404);
  return canonicalCandidate;
}

function securityHeaders(): Record<string, string> {
  return {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
  };
}

function respondText(response: ServerResponse, statusCode: number, body: string): void {
  response.writeHead(statusCode, {
    ...securityHeaders(),
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}

function respondJson(response: ServerResponse, statusCode: number, body: unknown): void {
  const json = JSON.stringify(body);
  response.writeHead(statusCode, {
    ...securityHeaders(),
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(json),
  });
  response.end(json);
}

async function respondFile(request: IncomingMessage, response: ServerResponse, filePath: string): Promise<void> {
  const mimeType = previewResourceContentType(filePath);
  if (!mimeType) {
    respondText(response, 415, "Unsupported preview resource type.");
    return;
  }
  const metadata = await stat(filePath);
  response.writeHead(200, {
    ...securityHeaders(),
    "Content-Type": mimeType,
    "Content-Length": metadata.size,
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox",
  });
  if (request.method === "HEAD") {
    response.end();
    return;
  }

  await new Promise<void>((resolvePromise, rejectPromise) => {
    const stream = createReadStream(filePath);
    stream.once("error", rejectPromise);
    response.once("close", resolvePromise);
    response.once("finish", resolvePromise);
    stream.pipe(response);
  });
}

function formatSseEvent(state: PreviewServerState): string {
  const data = JSON.stringify({
    revision: state.revision,
    successfulRevision: state.successfulRevision,
    status: state.status,
    error: state.error,
  });
  return `id: ${state.revision}\nevent: preview\ndata: ${data}\n\n`;
}

export class PreviewServer {
  readonly token: string;
  readonly resourceRoot: string;
  readonly paths: PreviewServerPaths;

  #requestedPort: number;
  #server: Server | null = null;
  #closePromise: Promise<void> | null = null;
  #port = 0;
  #html: string | null = null;
  #assets = new Map<string, string>();
  #sseClients = new Set<ServerResponse>();
  #heartbeat: NodeJS.Timeout | null = null;
  #state: PreviewServerState = {
    revision: 0,
    successfulRevision: 0,
    status: "starting",
    error: null,
  };

  private constructor(canonicalRoot: string, options: PreviewServerOptions) {
    this.resourceRoot = canonicalRoot;
    this.token = options.token ?? randomBytes(24).toString("base64url");
    this.#requestedPort = options.port ?? 0;
    const prefix = `/${this.token}`;
    this.paths = {
      document: `${prefix}/`,
      events: `${prefix}/events`,
      state: `${prefix}/state`,
      resource: `${prefix}/resource`,
      asset: `${prefix}/asset`,
    };
  }

  static async create(options: PreviewServerOptions): Promise<PreviewServer> {
    const canonicalRoot = await realpath(resolve(options.resourceRoot));
    return new PreviewServer(canonicalRoot, options);
  }

  get port(): number {
    return this.#port;
  }

  get url(): string {
    if (!this.#port) throw new Error("Preview server has not started.");
    return `http://127.0.0.1:${this.#port}${this.paths.document}`;
  }

  get state(): PreviewServerState {
    return { ...this.#state };
  }

  get address(): AddressInfo | null {
    const address = this.#server?.address();
    return address && typeof address !== "string" ? address : null;
  }

  async start(): Promise<void> {
    if (this.#closePromise) await this.#closePromise;
    if (this.#server) return;
    const server = createServer((request, response) => {
      void this.#handleRequest(request, response).catch((error: unknown) => {
        if (response.headersSent) {
          response.destroy(error instanceof Error ? error : undefined);
          return;
        }
        respondText(response, 500, `Internal preview server error: ${error instanceof Error ? error.message : String(error)}`);
      });
    });

    await new Promise<void>((resolvePromise, rejectPromise) => {
      const onError = (error: Error): void => {
        server.off("listening", onListening);
        rejectPromise(error);
      };
      const onListening = (): void => {
        server.off("error", onError);
        resolvePromise();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(this.#requestedPort, "127.0.0.1");
    });

    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("Could not determine the preview server port.");
    }
    this.#server = server;
    this.#port = address.port;
    this.#heartbeat = setInterval(() => {
      for (const client of this.#sseClients) client.write(": keep-alive\n\n");
    }, 15_000);
    this.#heartbeat.unref();
  }

  publishSuccess(revision: number, html: string, assets: Map<string, string> = new Map()): void {
    this.#html = html;
    this.#assets = new Map(assets);
    this.#state = {
      revision,
      successfulRevision: revision,
      status: "success",
      error: null,
    };
    this.#broadcast();
  }

  publishError(revision: number, error: string, initialErrorHtml?: string): void {
    if (!this.#html && initialErrorHtml) this.#html = initialErrorHtml;
    this.#state = {
      revision,
      successfulRevision: this.#state.successfulRevision,
      status: "error",
      error,
    };
    this.#broadcast();
  }

  async close(): Promise<void> {
    if (this.#closePromise) return await this.#closePromise;
    if (this.#heartbeat) {
      clearInterval(this.#heartbeat);
      this.#heartbeat = null;
    }
    for (const client of this.#sseClients) client.end();
    this.#sseClients.clear();

    const server = this.#server;
    this.#server = null;
    this.#port = 0;
    if (!server) return;
    server.closeIdleConnections();
    const closing = new Promise<void>((resolvePromise) => {
      server.close(() => resolvePromise());
      server.closeAllConnections();
    });
    const tracked = closing.finally(() => {
      if (this.#closePromise === tracked) this.#closePromise = null;
    });
    this.#closePromise = tracked;
    return await tracked;
  }

  #broadcast(): void {
    const event = formatSseEvent(this.#state);
    for (const client of this.#sseClients) client.write(event);
  }

  #validHost(request: IncomingMessage): boolean {
    const host = request.headers.host;
    if (!host) return true;
    return host === `127.0.0.1:${this.#port}` || host === `localhost:${this.#port}`;
  }

  async #handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!this.#validHost(request)) {
      respondText(response, 403, "Invalid Host header.");
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.setHeader("Allow", "GET, HEAD");
      respondText(response, 405, "Method not allowed.");
      return;
    }

    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    const pathname = requestUrl.pathname;

    if (pathname === this.paths.document.slice(0, -1)) {
      response.writeHead(308, { ...securityHeaders(), Location: this.paths.document });
      response.end();
      return;
    }

    if (pathname === this.paths.document) {
      if (!this.#html) {
        respondText(response, 503, "Preview is starting.");
        return;
      }
      const scriptNonce = createPreviewScriptNonce();
      const responseHtml = preparePreviewHtmlForHttp(this.#html, scriptNonce);
      response.writeHead(200, {
        ...securityHeaders(),
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": previewContentSecurityPolicy(scriptNonce, "http"),
      });
      if (request.method === "HEAD") response.end();
      else response.end(responseHtml);
      return;
    }

    if (pathname === this.paths.events) {
      if (request.method === "HEAD") {
        response.writeHead(200, { ...securityHeaders(), "Content-Type": "text/event-stream; charset=utf-8" });
        response.end();
        return;
      }
      response.writeHead(200, {
        ...securityHeaders(),
        "Content-Type": "text/event-stream; charset=utf-8",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      response.write("retry: 750\n\n");
      response.write(formatSseEvent(this.#state));
      this.#sseClients.add(response);
      request.once("close", () => this.#sseClients.delete(response));
      return;
    }

    if (pathname === this.paths.state) {
      respondJson(response, 200, this.#state);
      return;
    }

    if (pathname === this.paths.resource) {
      const requestedPath = requestUrl.searchParams.get("path") ?? "";
      try {
        const filePath = await resolveSafeResourcePath(this.resourceRoot, requestedPath);
        await respondFile(request, response, filePath);
      } catch (error) {
        if (error instanceof ResourceAccessError) {
          respondText(response, error.statusCode, error.message);
          return;
        }
        throw error;
      }
      return;
    }

    if (pathname.startsWith(`${this.paths.asset}/`)) {
      const assetId = pathname.slice(this.paths.asset.length + 1);
      if (!/^[A-Za-z0-9_-]{16,64}$/.test(assetId)) {
        respondText(response, 404, "Asset not found.");
        return;
      }
      const filePath = this.#assets.get(assetId);
      if (!filePath) {
        respondText(response, 404, "Asset not found.");
        return;
      }
      await respondFile(request, response, filePath);
      return;
    }

    respondText(response, 404, "Not found.");
  }
}
