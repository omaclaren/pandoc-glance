import { randomBytes } from "node:crypto";

export const PREVIEW_CSP_META_ID = "pandoc-glance-csp";
export const TRUSTED_PREVIEW_SCRIPT_ATTRIBUTE = "data-pandoc-glance-trusted";

export function createPreviewScriptNonce(): string {
  return randomBytes(18).toString("base64url");
}

export function previewContentSecurityPolicy(nonce: string, mode: "file" | "http"): string {
  const isHttp = mode === "http";
  const directives = [
    "default-src 'none'",
    `base-uri ${isHttp ? "'none'" : "'self' file:"}`,
    `connect-src ${isHttp ? "'self' " : "data: file: "}https://cdn.jsdelivr.net https://unpkg.com`,
    "font-src 'self' data: https://cdn.jsdelivr.net",
    "form-action 'none'",
    "frame-src 'none'",
    `img-src 'self' data: ${isHttp ? "" : "file: "}http: https:`,
    `media-src 'self' data: ${isHttp ? "" : "file: "}http: https:`,
    "object-src 'none'",
    `script-src 'nonce-${nonce}' 'strict-dynamic' https://cdn.jsdelivr.net`,
    "script-src-attr 'none'",
    "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
    `worker-src 'self' blob: ${isHttp ? "" : "file: "}https://cdn.jsdelivr.net`,
    "child-src blob: https://cdn.jsdelivr.net",
  ];
  if (isHttp) directives.push("frame-ancestors 'none'");
  return directives.join("; ");
}

const CSP_META_PATTERN = new RegExp(
  `<meta\\b(?=[^>]*\\bid=(?:"${PREVIEW_CSP_META_ID}"|'${PREVIEW_CSP_META_ID}'))[^>]*>\\s*`,
  "i",
);

/** Replace only pandoc-glance's trusted bootstrap-script nonce for an HTTP response. */
export function preparePreviewHtmlForHttp(html: string, nonce: string): string {
  const withoutMetaPolicy = html.replace(CSP_META_PATTERN, "");
  return withoutMetaPolicy.replace(/<script\b[^>]*>/gi, (tag) => {
    if (!new RegExp(`\\b${TRUSTED_PREVIEW_SCRIPT_ATTRIBUTE}(?:\\s*=\\s*(?:"true"|'true'|true))?(?=\\s|>)`, "i").test(tag)) {
      return tag;
    }
    const withoutNonce = tag.replace(/\snonce\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "");
    return withoutNonce.replace(/>$/, ` nonce="${nonce}">`);
  });
}
