export type PreviewTheme = "auto" | "light" | "dark";

export interface PreviewPalette {
  bg: string;
  card: string;
  panel: string;
  border: string;
  borderMuted: string;
  text: string;
  muted: string;
  accent: string;
  warning: string;
  error: string;
  success: string;
  heading: string;
  link: string;
  linkUrl: string;
  inlineCode: string;
  codeText: string;
  codeBorder: string;
  quote: string;
  quoteBorder: string;
  rule: string;
  listBullet: string;
  syntaxComment: string;
  syntaxKeyword: string;
  syntaxFunction: string;
  syntaxVariable: string;
  syntaxString: string;
  syntaxNumber: string;
  syntaxType: string;
  syntaxOperator: string;
  syntaxPunctuation: string;
}

// Adapted from pi-markdown-preview's MIT-licensed browser palettes.
export const DARK_PALETTE: PreviewPalette = {
  bg: "#0f1117",
  card: "#171b24",
  panel: "#11161f",
  border: "#2d3748",
  borderMuted: "#242b38",
  text: "#e6edf3",
  muted: "#9aa5b1",
  accent: "#5ea1ff",
  warning: "#f9c74f",
  error: "#ff6b6b",
  success: "#73d13d",
  heading: "#f0c674",
  link: "#81a2be",
  linkUrl: "#8a93a1",
  inlineCode: "#8abeb7",
  codeText: "#d8e2cf",
  codeBorder: "#505866",
  quote: "#a6afbb",
  quoteBorder: "#667080",
  rule: "#46505f",
  listBullet: "#8abeb7",
  syntaxComment: "#6a9955",
  syntaxKeyword: "#569cd6",
  syntaxFunction: "#dcdcaa",
  syntaxVariable: "#9cdcfe",
  syntaxString: "#ce9178",
  syntaxNumber: "#b5cea8",
  syntaxType: "#4ec9b0",
  syntaxOperator: "#d4d4d4",
  syntaxPunctuation: "#d4d4d4",
};

export const LIGHT_PALETTE: PreviewPalette = {
  bg: "#f5f7fb",
  card: "#ffffff",
  panel: "#f8fafc",
  border: "#d0d7de",
  borderMuted: "#e0e6ee",
  text: "#1f2328",
  muted: "#57606a",
  accent: "#0969da",
  warning: "#9a6700",
  error: "#cf222e",
  success: "#1a7f37",
  heading: "#8b661f",
  link: "#3f6f9f",
  linkUrl: "#68717c",
  inlineCode: "#436f70",
  codeText: "#344f34",
  codeBorder: "#afb8c1",
  quote: "#57606a",
  quoteBorder: "#8c959f",
  rule: "#afb8c1",
  listBullet: "#467146",
  syntaxComment: "#008000",
  syntaxKeyword: "#0000ff",
  syntaxFunction: "#795e26",
  syntaxVariable: "#001080",
  syntaxString: "#a31515",
  syntaxNumber: "#098658",
  syntaxType: "#267f99",
  syntaxOperator: "#000000",
  syntaxPunctuation: "#000000",
};

function cssVariables(palette: PreviewPalette, fontSizePx: number, colorScheme: "light" | "dark"): string {
  return `
  color-scheme: ${colorScheme};
  --preview-font-size: ${fontSizePx}px;
  --bg: ${palette.bg};
  --card: ${palette.card};
  --panel: ${palette.panel};
  --border: ${palette.border};
  --border-muted: ${palette.borderMuted};
  --text: ${palette.text};
  --muted: ${palette.muted};
  --accent: ${palette.accent};
  --warning: ${palette.warning};
  --error: ${palette.error};
  --success: ${palette.success};
  --heading: ${palette.heading};
  --link: ${palette.link};
  --link-url: ${palette.linkUrl};
  --inline-code: ${palette.inlineCode};
  --code-text: ${palette.codeText};
  --code-border: ${palette.codeBorder};
  --quote: ${palette.quote};
  --quote-border: ${palette.quoteBorder};
  --rule: ${palette.rule};
  --list-bullet: ${palette.listBullet};
  --syntax-comment: ${palette.syntaxComment};
  --syntax-keyword: ${palette.syntaxKeyword};
  --syntax-function: ${palette.syntaxFunction};
  --syntax-variable: ${palette.syntaxVariable};
  --syntax-string: ${palette.syntaxString};
  --syntax-number: ${palette.syntaxNumber};
  --syntax-type: ${palette.syntaxType};
  --syntax-operator: ${palette.syntaxOperator};
  --syntax-punctuation: ${palette.syntaxPunctuation};
`;
}

export function buildPreviewCss(theme: PreviewTheme, fontSizePx: number): string {
  const initial = theme === "dark" ? DARK_PALETTE : LIGHT_PALETTE;
  const initialMode = theme === "dark" ? "dark" : "light";
  const automaticDark = theme === "auto"
    ? `\n@media (prefers-color-scheme: dark) {\n  :root {${cssVariables(DARK_PALETTE, fontSizePx, "dark")}  }\n}\n`
    : "";

  return `
:root {${cssVariables(initial, fontSizePx, initialMode)}
}
${automaticDark}
* { box-sizing: border-box; }
html {
  min-height: 100%;
  scroll-padding-top: 24px;
  background: var(--bg);
}
body {
  min-height: 100vh;
  margin: 0;
  padding: 28px;
  background: var(--bg);
  color: var(--text);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
  transition: background-color 120ms ease, color 120ms ease;
}
#preview-root {
  width: min(1100px, 100%);
  min-height: calc(100vh - 56px);
  margin: 0 auto;
  padding: 28px 32px 44px;
  overflow-wrap: anywhere;
  border: 1px solid var(--border-muted);
  border-radius: 12px;
  background: var(--card);
  box-shadow: 0 8px 30px color-mix(in srgb, var(--bg) 70%, transparent);
  font-size: var(--preview-font-size);
  line-height: 1.62;
}
#preview-root > :first-child { margin-top: 0; }
#preview-root > :last-child { margin-bottom: 0; }
#preview-root #title-block-header {
  margin-bottom: 2em;
  padding-bottom: 1.25em;
  border-bottom: 1px solid var(--border-muted);
}
#preview-root #title-block-header .title { margin-top: 0; }
#preview-root #title-block-header .author,
#preview-root #title-block-header .date {
  margin: 0.3em 0 0;
  color: var(--muted);
}
#preview-root h1,
#preview-root h2,
#preview-root h3,
#preview-root h4,
#preview-root h5,
#preview-root h6 {
  margin: 1.35em 0 0.55em;
  color: var(--heading);
  line-height: 1.25;
  letter-spacing: -0.012em;
  scroll-margin-top: 24px;
}
#preview-root h1 { font-size: 1.75em; }
#preview-root h2 { font-size: 1.38em; }
#preview-root h3 { font-size: 1.16em; }
#preview-root p,
#preview-root ul,
#preview-root ol,
#preview-root blockquote,
#preview-root table,
#preview-root figure { margin-top: 0; margin-bottom: 1em; }
#preview-root li + li { margin-top: 0.22em; }
#preview-root li::marker { color: var(--list-bullet); }
#preview-root a { color: var(--link); text-decoration: none; }
#preview-root a:hover { text-decoration: underline; }
#preview-root a.uri,
#preview-root .uri { color: var(--link-url); }
#preview-root blockquote {
  margin-left: 0;
  padding: 0.35em 1em;
  border-left: 0.25em solid var(--quote-border);
  border-radius: 0 8px 8px 0;
  background: color-mix(in srgb, var(--quote-border) 9%, transparent);
  color: var(--quote);
}
#preview-root pre {
  margin: 1em 0;
  padding: 13px 15px;
  overflow: auto;
  border: 1px solid var(--code-border);
  border-radius: 9px;
  background: var(--panel);
  tab-size: 2;
}
#preview-root code {
  color: var(--inline-code);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
  font-size: 0.9em;
}
#preview-root pre code { color: var(--code-text); }
#preview-root :not(pre) > code {
  padding: 0.12em 0.36em;
  border: 1px solid color-mix(in srgb, var(--code-border) 72%, transparent);
  border-radius: 6px;
  background: color-mix(in srgb, var(--code-border) 12%, transparent);
}
#preview-root code span.kw,
#preview-root code span.cf,
#preview-root code span.im { color: var(--syntax-keyword); font-weight: 600; }
#preview-root code span.dt { color: var(--syntax-type); font-weight: 600; }
#preview-root code span.fu,
#preview-root code span.bu { color: var(--syntax-function); }
#preview-root code span.va,
#preview-root code span.ot { color: var(--syntax-variable); }
#preview-root code span.st,
#preview-root code span.ss,
#preview-root code span.sc,
#preview-root code span.ch { color: var(--syntax-string); }
#preview-root code span.dv,
#preview-root code span.bn,
#preview-root code span.fl { color: var(--syntax-number); }
#preview-root code span.co { color: var(--syntax-comment); font-style: italic; }
#preview-root code span.op { color: var(--syntax-operator); }
#preview-root code span.pp,
#preview-root code span.pu { color: var(--syntax-punctuation); }
#preview-root code span.er,
#preview-root code span.al { color: var(--error); font-weight: 600; }
#preview-root table {
  display: block;
  max-width: 100%;
  overflow: auto;
  border-collapse: collapse;
}
#preview-root th,
#preview-root td { padding: 7px 12px; border: 1px solid var(--border-muted); }
#preview-root thead th { background: var(--panel); }
#preview-root tbody tr:nth-child(even) { background: color-mix(in srgb, var(--panel) 68%, transparent); }
#preview-root hr { margin: 1.5em 0; border: 0; border-top: 1px solid var(--rule); }
#preview-root img,
#preview-root video,
#preview-root svg { max-width: 100%; height: auto; }
#preview-root .preview-pdf-figure {
  position: relative;
  display: block;
  width: 100%;
  max-width: 100%;
  border: 1px solid var(--border-muted);
  border-radius: 9px;
  background: #fff;
  overflow: hidden;
  line-height: 0;
}
#preview-root .preview-pdf-pending,
#preview-root .preview-pdf-failed {
  min-height: 220px;
  background: var(--panel);
}
#preview-root .preview-pdf-loading {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  padding: 3em 1em;
  color: var(--muted);
  font-size: 0.9em;
  line-height: 1.4;
}
#preview-root .preview-pdf-failed .preview-pdf-loading { color: var(--error); }
#preview-root .preview-pdf-figure canvas { display: block; width: 100%; height: auto; }
#preview-root .preview-pdf-open {
  position: absolute;
  top: 9px;
  right: 9px;
  padding: 0.36em 0.62em;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: color-mix(in srgb, var(--card) 92%, transparent);
  box-shadow: 0 2px 8px color-mix(in srgb, var(--bg) 55%, transparent);
  font-size: 0.78em;
  line-height: 1.25;
}
#preview-root .preview-pdf-figure[data-fig-align="center"] { margin-right: auto; margin-left: auto; }
#preview-root .preview-pdf-figure[data-fig-align="right"] { margin-right: 0; margin-left: auto; }
#preview-root figure { text-align: center; }
#preview-root figcaption { margin-top: 0.45em; color: var(--muted); font-size: 0.9em; }
#preview-root math[display="block"],
#preview-root mjx-container[display="true"] {
  display: block;
  margin: 1em 0;
  overflow-x: auto;
  overflow-y: hidden;
}
#preview-root .mermaid-container { margin: 1.1em 0; overflow-x: auto; text-align: center; }
#preview-root .mermaid-container svg { max-width: 100%; height: auto; }
#preview-root .mermaid-error {
  padding: 12px 14px;
  border: 1px solid var(--error);
  border-radius: 8px;
  background: var(--panel);
  text-align: left;
}
#preview-root .mermaid-error-message {
  margin-bottom: 0.75em;
  color: var(--error);
  font-weight: 600;
  overflow-wrap: anywhere;
}
#preview-root .mermaid-error .mermaid-source { margin: 0; }
.preview-warning {
  margin: 1em 0;
  padding: 10px 12px;
  border: 1px solid color-mix(in srgb, var(--warning) 52%, transparent);
  border-radius: 8px;
  background: color-mix(in srgb, var(--warning) 11%, var(--card));
  color: var(--text);
  font-size: 0.9em;
}
.initial-render-error {
  max-width: 760px;
  margin: 8vh auto;
  padding: 22px;
  border: 1px solid color-mix(in srgb, var(--error) 55%, transparent);
  border-radius: 10px;
  background: color-mix(in srgb, var(--error) 8%, var(--card));
}
.initial-render-error h1 { color: var(--error) !important; }
.initial-render-error pre { white-space: pre-wrap; }
#preview-status {
  position: fixed;
  z-index: 1000;
  right: 18px;
  bottom: 18px;
  max-width: min(560px, calc(100vw - 36px));
  padding: 11px 14px;
  border: 1px solid var(--border);
  border-radius: 9px;
  background: color-mix(in srgb, var(--card) 94%, transparent);
  box-shadow: 0 10px 34px color-mix(in srgb, var(--bg) 62%, transparent);
  color: var(--text);
  font-size: 13px;
  line-height: 1.4;
  white-space: pre-wrap;
}
#preview-status[data-level="error"] { border-color: var(--error); }
#preview-status[data-level="warning"] { border-color: var(--warning); }
#preview-status[hidden] { display: none; }
@media (max-width: 720px) {
  body { padding: 0; }
  #preview-root {
    min-height: 100vh;
    padding: 22px 18px 36px;
    border: 0;
    border-radius: 0;
    box-shadow: none;
  }
}
@media print {
  html, body { background: #fff; }
  body { padding: 0; }
  #preview-root {
    width: 100%;
    min-height: 0;
    padding: 0;
    border: 0;
    box-shadow: none;
  }
  #preview-status { display: none !important; }
}
`;
}

export function palettesForClient(): { light: PreviewPalette; dark: PreviewPalette } {
  return { light: LIGHT_PALETTE, dark: DARK_PALETTE };
}
