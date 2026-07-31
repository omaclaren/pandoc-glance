# Build Brief: `pandoc-glance`

## Objective

Create a polished standalone CLI that renders a local Markdown or LaTeX document in a browser. It should work from any shell or editor. Zed is an initial client, not a runtime dependency:

```bash
pandoc-glance --watch "$ZED_FILE"
```

The differentiator is not merely “Markdown in a browser.” It is the high-fidelity document pipeline already proven in `pi-markdown-preview`: Pandoc syntax handling, robust math/LaTeX, Mermaid, syntax highlighting, local resources, and good light/dark styling.

Build a working MVP, verify it, commit it, and push it to the private GitHub remote. Do not stop at a design or skeleton.

## Product behavior

Support both common argument orders:

```bash
pandoc-glance notes.md
pandoc-glance --watch notes.md
pandoc-glance notes.md --watch
```

### One-shot mode

`pandoc-glance <file>` should:

1. Validate and read the file.
2. Auto-detect Markdown versus standalone LaTeX from the extension unless overridden.
3. Render browser-ready HTML.
4. Open it in the system default browser.
5. Exit successfully after opening.

With `--no-open`, do not launch anything; print the generated HTML path clearly. It is acceptable for one-shot output to live in a cache directory, but avoid leaking unbounded temporary files.

### Watch mode

`pandoc-glance --watch <file>` should:

1. Bind an HTTP server to `127.0.0.1` only, using an available random port by default.
2. Use a hard-to-guess tokenized URL or equivalently narrow local access design.
3. Open exactly one browser tab unless `--no-open` is supplied.
4. Watch the source robustly across ordinary writes and editor atomic-save/rename behavior.
5. Debounce rapid changes.
6. Rerender after saved changes and refresh/update the existing tab, never opening another tab.
7. Preserve the user’s reading position as well as practical—prefer the nearest heading/element anchor, with scroll ratio as a fallback.
8. Keep the last successful render visible if a subsequent render fails. Show the current error in the browser and terminal, then recover automatically after the file is fixed.
9. Shut down cleanly on Ctrl-C/SIGTERM.

This is necessarily save-based: it watches the file on disk and does not see unsaved editor buffers. Document that explicitly.

SSE is likely sufficient for live-reload and avoids a WebSocket dependency, but choose the simplest robust design.

## CLI surface for the MVP

Required:

- positional input path
- `-w, --watch`
- `--no-open`
- `--theme auto|light|dark` (default `auto`)
- `--format auto|markdown|latex` (default `auto`)
- `--font-size <px>` with sensible validation
- `--port <number>` (`0` or omission means choose an available port)
- `-h, --help`
- `-v, --version`

Print actionable errors and use nonzero exit codes for invalid arguments, missing files, missing Pandoc, or initial render failure. Keep parsing lightweight and allow options before or after the file.

## Rendering requirements

Start by inspecting these exact areas in `~/Git-Working/pi-markdown-preview/index.ts`:

- `prepareBrowserPreviewMarkdown`
- `renderMarkdownToHtmlWithPandoc`
- `buildBrowserHtmlFromPandocFragment`
- `renderPreviewHtmlToFile`
- math delimiter normalization
- local/Obsidian image normalization
- browser opening and theme palettes

Also inspect `~/Git-Working/pi-studio` for newer fixes where useful, but do not import its broad editor/export scope.

The MVP should preserve or deliberately document these capabilities:

- Pandoc Markdown rendering
- inline/display math using `$...$`, `$$...$$`, `\\(...\\)`, and `\\[...\\]`
- standalone `.tex`/`.latex` input
- MathML with selective MathJax fallback where required
- fenced-code syntax highlighting
- Mermaid diagrams, including lazy Lucide/Logos icon packs
- relative and absolute local images/resources
- Obsidian image syntax if it can be retained without broad scope
- readable theme-aware typography and code blocks

Use the source file’s directory as the default resource root. Serve or embed local resources safely. Requests must not escape the allowed resource root through `..`, URL encoding, or symlink tricks. Avoid stale browser-cached local images after rerenders.

The current reference implementation loads Mermaid, optional icon packs, and selective MathJax fallback from CDNs. For the MVP, retaining that behavior is acceptable if clearly documented. Basic rendering and automated tests must still work without network access. Do not make bundling large browser libraries block the MVP.

Pandoc remains an explicit prerequisite. Detect it early and provide platform-appropriate installation guidance. Support `PANDOC_PATH` if the reference implementation does.

## Themes

Outside Pi there is no Pi `Theme` object. Provide independent palettes:

- `auto`: respond to browser `prefers-color-scheme`, ideally without rerendering
- `light`
- `dark`

Reuse the proven light/dark palette and CSS from `pi-markdown-preview` where sensible. Keep font-size behavior consistent in one-shot and watch modes.

## Browser opening and portability

Target macOS first while keeping Linux and Windows support straightforward. A small established cross-platform browser-opening dependency is acceptable. Do not hard-code Brave; use the system default browser. `--no-open` must make headless/SSH use fully testable.

## Suggested code organization

Use judgment, but aim for separation along these lines:

```text
src/
  cli.ts              argument parsing and process lifecycle
  render.ts           context-free Markdown/LaTeX -> standalone HTML
  server.ts           loopback HTTP/SSE server and safe resource serving
  watcher.ts          debounced, atomic-save-safe file watching
  browser.ts          default-browser launch
  styles.ts           independent palettes/CSS inputs
```

The executable should be exposed as `pandoc-glance` through `package.json#bin`, include a portable Node shebang, and run from compiled `dist` output. Do not require Pi packages at runtime.

Use package version `0.1.0` initially and protect against accidental publication while the repository remains private.

## Testing and verification

At minimum, add automated coverage for:

1. CLI parsing, including options before/after the path and invalid values.
2. Markdown rendering with headings, fenced code, all required math delimiters, and a local image.
3. LaTeX format auto-detection and override.
4. Watch server startup on loopback with `--no-open`.
5. A source-file change producing a new live-reload revision/event.
6. Initial render errors and recovery after a corrected save.
7. Resource serving and traversal rejection, including encoded traversal.
8. Clean shutdown where practical.

Tests must not open a browser. They must not depend on CDN availability. Pandoc-dependent tests may explicitly detect/skip with a clear reason only if necessary, but Pandoc is installed on this development machine and the main integration path should be exercised here.

Create a representative fixture containing prose, code, math, Mermaid, and a local image. Run and report:

```bash
npm install
npm run typecheck
npm test
npm run build
```

Also perform a headless smoke test resembling:

```bash
pandoc-glance --watch --no-open test/fixtures/sample.md
```

Fetch the printed loopback URL, verify rendered content, modify a temporary copy, verify a reload/revision, and terminate cleanly.

## Documentation

The README should include:

- concise value proposition and screenshots placeholder if no screenshot is captured yet
- prerequisites and installation from a local checkout
- all CLI usage/options
- math, Mermaid, local-resource, and standalone LaTeX examples
- save-based watch semantics
- network/CDN behavior
- security/loopback behavior
- troubleshooting for Pandoc and browser opening
- a Zed task example using `$ZED_FILE`
- generic terminal/editor examples
- development/test commands

Use a valid Zed `tasks.json` example and explain that autosave makes the disk-based watcher feel more live.

## Explicit non-goals for the first milestone

Do not let these delay the MVP:

- an embedded Zed pane or Zed extension
- unsaved-buffer integration
- bidirectional source/preview scroll sync
- an in-browser editor
- multiple documents in one server process
- PDF/PNG export or terminal image rendering
- npm publication/release automation
- fully offline bundled Mermaid/MathJax/icon packs

Structure the rendering core so exports and additional frontends can be added later, but do not prematurely migrate every feature from `pi-markdown-preview`.

## Repository and workflow constraints

- Work only in `~/Git-Working/pandoc-glance`.
- Reference repositories are read-only.
- Do not alter global Pi/npm/Git settings.
- Do not publish anything publicly or to npm.
- The GitHub repository is already private and `origin` uses SSH.
- Make coherent commits and push tested milestones to `origin/main`.

## Completion checklist

The first milestone is complete when:

- the CLI works in one-shot and watch modes;
- browser watch mode updates one tab on saved file changes and preserves position reasonably;
- Markdown/math/Mermaid/code/local-image and standalone LaTeX behavior is demonstrated;
- errors recover without killing the watch process;
- loopback/resource security is covered;
- build, typecheck, tests, and headless smoke test pass;
- README documents general and Zed usage;
- all work is committed and pushed to the private remote;
- no known required MVP work remains.

## Milestone implementation status

Completed in the `0.1.0` MVP:

- [x] one-shot and save-based watch CLI modes;
- [x] loopback-only tokenized HTTP/SSE server with one-tab reloads and position restoration;
- [x] Pandoc Markdown/standalone LaTeX, MathML plus selective MathJax, Mermaid with icon packs, highlighted code, and local/Obsidian images;
- [x] debounced ordinary-write and atomic-save watching;
- [x] last-successful-render retention, browser/terminal errors, and automatic recovery;
- [x] canonical-path resource containment, encoded traversal rejection, symlink-escape rejection, and cache busting;
- [x] deterministic browser-free automated coverage and a representative fixture;
- [x] complete general, headless, security, troubleshooting, and Zed documentation.

One ambiguity was resolved in favor of recovery: one-shot initial render failures exit immediately with a nonzero status, while watch-mode initial render failures serve an error page and remain alive so a corrected save can recover. A watch process stopped before it ever renders successfully exits nonzero.
