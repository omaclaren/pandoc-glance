# Project Instructions

## Purpose

Build `pi-md-preview`, a standalone, editor-agnostic CLI for high-fidelity Markdown and LaTeX preview in a web browser. The first motivating integration is a Zed task such as `pi-md-preview --watch "$ZED_FILE"`, but the program must not depend on Zed or Pi at runtime.

## Reference repositories

These repositories are available locally on this machine for inspection:

- `~/Git-Working/pi-markdown-preview` — primary implementation reference; use its Pandoc/MathML/MathJax/Mermaid/browser-preview behavior as the template.
- `~/Git-Working/pi-studio` — secondary reference for newer rendering edge cases and live browser/server patterns.

Treat both repositories as read-only. Do not edit, commit, install from, or change their branches/remotes. Reuse only the code needed for a focused standalone browser CLI. Preserve applicable MIT notices when copying code.

## Engineering conventions

- TypeScript, ESM, and Node.js 22+.
- Keep the standalone rendering core free of Pi coding-agent runtime types and dependencies.
- Prefer existing patterns from `pi-markdown-preview` when they remain appropriate.
- Keep dependencies modest; do not add Puppeteer merely for browser preview.
- Commit `package-lock.json` and keep `npm run typecheck` working.
- Tests must be deterministic and must not open a browser or require public-network access.
- Bind preview servers to loopback only and test path traversal protections.
- Do not publish to npm or make a release. The repository is private during development.
- Make coherent commits and push working milestones to `origin/main`.
- Do not inspect, print, copy, or commit credentials or secret configuration files.

## Working style

Read `BUILD_BRIEF.md` completely before implementation. Inspect the reference implementations before choosing abstractions. Work autonomously through a functioning, tested MVP rather than stopping after a plan. Keep scope focused, but fix issues uncovered by tests and smoke testing. Update the README and build brief/checklist when decisions differ from the initial proposal.
