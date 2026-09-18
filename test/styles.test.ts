import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildPreviewCss, DARK_PALETTE, LIGHT_PALETTE } from "../src/styles.js";

describe("annotation styling", () => {
  it("uses the theme accent rather than warning colours, keeping normal text and inline wrapping", () => {
    for (const theme of ["light", "dark", "auto"] as const) {
      const css = buildPreviewCss(theme, 15);
      const annotation = css.match(/#preview-root \.annotation-marker \{([^}]+)\}/)?.[1];
      assert.ok(annotation);
      assert.match(annotation, /background: var\(--annotation-bg\)/);
      assert.match(annotation, /border: 1px solid var\(--annotation-border\)/);
      assert.match(annotation, /color: var\(--text\)/);
      assert.match(annotation, /display: inline;/);
      assert.match(annotation, /box-decoration-break: clone;/);
      assert.doesNotMatch(annotation, /--warning/);
    }
  });

  it("uses a softer light tint and a stronger dark tint without changing other palette colours", () => {
    for (const [theme, palette, fill, border] of [
      ["light", LIGHT_PALETTE, 10, 25],
      ["dark", DARK_PALETTE, 18, 35],
    ] as const) {
      const css = buildPreviewCss(theme, 15);
      assert.ok(css.includes(`--annotation-bg: color-mix(in srgb, var(--accent) ${fill}%, var(--card))`));
      assert.ok(css.includes(`--annotation-border: color-mix(in srgb, var(--accent) ${border}%, var(--card))`));
      assert.ok(css.includes(`--accent: ${palette.accent}`));
      assert.ok(css.includes(`--heading: ${palette.heading}`));
      assert.ok(css.includes(`--warning: ${palette.warning}`));
      assert.doesNotMatch(css, /@media \(prefers-color-scheme:/);
    }
  });

  it("updates annotation colours with the auto-theme media query", () => {
    const css = buildPreviewCss("auto", 15);
    const [light, dark] = css.split("@media (prefers-color-scheme: dark)");
    assert.ok(light?.includes("--annotation-bg: color-mix(in srgb, var(--accent) 10%"));
    assert.ok(light?.includes("--annotation-border: color-mix(in srgb, var(--accent) 25%"));
    assert.ok(dark?.includes("--annotation-bg: color-mix(in srgb, var(--accent) 18%"));
    assert.ok(dark?.includes("--annotation-border: color-mix(in srgb, var(--accent) 35%"));
  });
});
