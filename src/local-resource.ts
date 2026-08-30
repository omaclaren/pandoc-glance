import { win32 } from "node:path";
import { fileURLToPath } from "node:url";

export interface LocalResourceReference {
  path: string;
  search: string;
  hash: string;
}

/** Reject UNC, Windows device, and mixed-separator network paths on every host. */
export function isNetworkResourcePath(value: string): boolean {
  return value.replace(/\//g, "\\").startsWith("\\\\");
}

/**
 * Parse a browser resource reference without allowing it to select a network
 * file system. Query strings and fragments are retained for the rewritten URL.
 */
export function parseLocalResourceReference(value: string): LocalResourceReference | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;

  const hashIndex = trimmed.indexOf("#");
  const hash = hashIndex >= 0 ? trimmed.slice(hashIndex) : "";
  const withoutHash = hashIndex >= 0 ? trimmed.slice(0, hashIndex) : trimmed;
  const queryIndex = withoutHash.indexOf("?");
  const search = queryIndex >= 0 ? withoutHash.slice(queryIndex) : "";
  const rawPath = queryIndex >= 0 ? withoutHash.slice(0, queryIndex) : withoutHash;
  if (!rawPath || isNetworkResourcePath(rawPath)) return null;

  if (/^file:/i.test(rawPath)) {
    try {
      const fileUrl = new URL(rawPath);
      if (fileUrl.protocol !== "file:" || (fileUrl.hostname && fileUrl.hostname.toLowerCase() !== "localhost")) {
        return null;
      }
      fileUrl.search = "";
      fileUrl.hash = "";
      const filePath = fileURLToPath(fileUrl);
      if (filePath.includes("\0") || isNetworkResourcePath(filePath)) return null;
      return { path: filePath, search, hash };
    } catch {
      return null;
    }
  }

  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(rawPath);
  } catch {
    decodedPath = rawPath;
  }
  if (!decodedPath || decodedPath.includes("\0") || isNetworkResourcePath(decodedPath)) return null;
  if (/^file:/i.test(decodedPath)) return null;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(decodedPath) && !win32.isAbsolute(decodedPath)) return null;
  return { path: decodedPath, search, hash };
}

/** Preserve an authored query and fragment after trusted route parameters. */
export function appendLocalResourceSuffix(route: string, reference: LocalResourceReference): string {
  const authoredQuery = reference.search.startsWith("?") ? reference.search.slice(1) : reference.search;
  const withQuery = authoredQuery ? `${route}${route.includes("?") ? "&" : "?"}${authoredQuery}` : route;
  return `${withQuery}${reference.hash}`;
}
