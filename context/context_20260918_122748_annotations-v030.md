# Goal
Add display-only `[an: ...]` highlighting to pandoc-glance for consistency with Pi preview tools, without Pi dependencies or an annotation editor.

# Current State
- v0.3.0 development milestone implemented; npm publication/tagging NOT authorised in this turn.
- Global registry install remains v0.2.1. Use `node dist/cli.js` to test this checkout.
- New `src/annotations.ts`: balanced marker scanner adapted from pi-markdown-preview (MIT); Micromark prose/code boundaries, existing YAML splitter, protected math/link/attribute contexts; emits native Pandoc spans.
- `src/styles.ts`: theme-aware wrapping note highlights. No new dependencies or browser scripts; raw HTML/CSP restrictions unchanged.
- Tests/fixture: `test/annotations.test.ts`, render/watch regressions, `test/fixtures/annotations.qmd` (uses adjacent sample.svg).
- Docs: README annotation usage and screenshot, BUILD_BRIEF design decision. Screenshot: `docs/screenshots/annotations-dark.png`.
- Verified typecheck, build, all 62 tests, production audit (0 vulnerabilities), packed-install CLI and real Brave one-shot/watch smoke. Confirmed 9 notes, inline math/link, literal code, live saves, light/dark colours, narrow wrapping, no script execution or source writes. Browser/watch smoke processes closed.

# Decisions
- Markdown/QMD only; standalone LaTeX unchanged.
- Source-preserving display extension; no comments database, browser editing, AI, or hiding/stripping controls.
- Native Pandoc rendering rather than reference JS placeholders: keeps inline Markdown/math, meaningful heading IDs, existing safety boundaries; links within notes are clickable.
- Empty/unfinished/escaped notes and code examples remain literal. YAML front matter, existing links/images, attributes, math contents excluded. No multi-paragraph notes.
- Generated title attributes encode pipes/backticks/backslashes to prevent quote/table parsing issues.
- Reference repositories inspected read-only. No CI infrastructure added.

# Next Steps
1. User manual test: `node dist/cli.js --watch test/fixtures/annotations.qmd`.
2. Address actual feedback. Publish only after explicit approval and final full checks/packed-install smoke.
3. Verify registry installation before tagging v0.3.0; do not silently replace the global install.

# Continuation Prompt
Continue from the v0.3.0 inline-annotation milestone. Check git status/log before work. The current checkout has display-only notes and 62 passing tests; published/global version is still v0.2.1. Keep feature scope narrow and Pi reference repositories read-only.
