# Goal
Bring pi-markdown-preview's bare HTML-style superscript/subscript support to the standalone CLI, e.g. `Alan Li<sup>1</sup>`.

# Current State
- v0.3.1 prepared, NOT published/tagged. Global registry install remains v0.3.0.
- `src/markdown-sub-sup.ts` adapts the reference helper (MIT) to TypeScript. Bare single-line plain-text sup/sub pairs become Pandoc native `^...^` / `~...~` notation; raw HTML and raw attributes stay disabled.
- `src/markdown-comments.ts` supplies literal/code/YAML/HTML-attribute ranges, following the reference helper. Pandoc attributes and math are protected too.
- Existing annotation math/attribute scanners extracted unchanged into `src/markdown-inline.ts` for reuse. Sup/sub contents escape Markdown punctuation/citations/URLs but preserve numeric/named entities; normalization runs before annotation highlighting.
- Added `test/markdown-sub-sup.test.ts`, rendering/security regressions, real watch-update coverage, and `test/fixtures/superscript.qmd`. Updated README/BUILD_BRIEF and package/CLI version.
- Verified typecheck/build, all 76 tests, production audit (0 vulnerabilities), packed CLI install, real Brave one-shot/watch rendering and live update. Browser saw 9 superscripts, 2 subscripts, correct super/sub vertical alignment, literal code, working annotations, no active hostile HTML. Smoke browser/server cleaned up.
- Screenshot inspected: `docs/screenshots/superscript-light.png`.
- Pi reference repositories were read-only. The new reference sup/sub helper was still uncommitted there when inspected; do not attribute it to the existing HEAD commit.

# Decisions
Match the narrow reference behaviour, not general raw HTML support. Code/escapes/YAML/math/attributes remain untouched. Standalone LaTeX unchanged. No new dependencies or theme changes. Publishing requires a separate owner-approved release.

# Next Steps
User manual test: `node dist/cli.js --watch test/fixtures/superscript.qmd`. If approved for publication, repeat full checks/packed smoke, then publish and verify registry before tagging. Do not replace global v0.3.0 without approval.

# Continuation Prompt
Check git status/log. v0.3.1 safe sup/sub compatibility is implemented with 76 passing tests but not published. Latest npm/global release is v0.3.0. Keep Pi references read-only.
