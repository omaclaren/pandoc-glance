import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it } from "node:test";
import {
  appendLocalResourceSuffix,
  isNetworkResourcePath,
  parseLocalResourceReference,
} from "../src/local-resource.js";

describe("local resource references", () => {
  it("retains authored query strings and fragments", () => {
    const reference = parseLocalResourceReference("figures/plot%20one.svg?variant=dark&mode=compact#layer-two");
    assert.deepEqual(reference, {
      path: "figures/plot one.svg",
      search: "?variant=dark&mode=compact",
      hash: "#layer-two",
    });
    assert.equal(
      appendLocalResourceSuffix("/token/resource?path=figures%2Fplot%20one.svg&v=7", reference!),
      "/token/resource?path=figures%2Fplot%20one.svg&v=7&variant=dark&mode=compact#layer-two",
    );
  });

  it("keeps trusted route parameters authoritative", () => {
    const reference = parseLocalResourceReference("plot.svg?path=ignored.svg&v=0#layer");
    assert.ok(reference);
    assert.equal(
      appendLocalResourceSuffix("/token/resource?path=plot.svg&v=9", reference),
      "/token/resource?path=plot.svg&v=9&path=ignored.svg&v=0#layer",
    );
  });

  it("accepts local file URLs and Windows drive paths", () => {
    const localPath = resolve("test", "fixtures", "sample.svg");
    assert.deepEqual(parseLocalResourceReference(`${pathToFileURL(localPath).href}?raw=1#shape`), {
      path: localPath,
      search: "?raw=1",
      hash: "#shape",
    });
    assert.deepEqual(parseLocalResourceReference("C:\\Users\\Oliver\\plot.svg?raw=1#shape"), {
      path: "C:\\Users\\Oliver\\plot.svg",
      search: "?raw=1",
      hash: "#shape",
    });
  });

  it("rejects raw, encoded, and file-URL network or device paths", () => {
    const rejected = [
      "//server/share/plot.svg",
      "\\\\server\\share\\plot.svg",
      "\\/server/share/plot.svg",
      "%5C%5Cserver%5Cshare%5Cplot.svg",
      "%5C%2Fserver%2Fshare%2Fplot.svg",
      "\\\\?\\C:\\plot.svg",
      "\\\\.\\pipe\\preview",
      "file://server/share/plot.svg",
      "file:////server/share/plot.svg",
      "https://example.com/plot.svg",
      "data:image/svg+xml;base64,AAAA",
    ];
    for (const value of rejected) {
      assert.equal(parseLocalResourceReference(value), null, `Expected ${value} to be rejected`);
    }
    assert.equal(isNetworkResourcePath("\\/server/share"), true);
    assert.equal(isNetworkResourcePath("/local/path"), false);
  });
});
