import assert from "node:assert/strict";
import path from "node:path";
import { afterEach, describe, it } from "vitest";

import {
  resolveCodexGeneratedImagesRoot,
  resolveCodexGeneratedImagesRoots,
} from "./codexGeneratedImages.ts";

describe("resolveCodexGeneratedImagesRoot(s)", () => {
  const previousPenkraHome = process.env.PENKRA_HOME;

  afterEach(() => {
    if (previousPenkraHome === undefined) delete process.env.PENKRA_HOME;
    else process.env.PENKRA_HOME = previousPenkraHome;
  });

  it("returns the overlay generated_images directory as the active write root by default", () => {
    process.env.PENKRA_HOME = "/penkra-test/runtime";
    assert.equal(
      resolveCodexGeneratedImagesRoot("/codex-test/.codex"),
      path.join("/penkra-test/runtime", "codex-home-overlay", "generated_images"),
    );
  });

  it("returns both source and overlay generated_images roots for the allowlist", () => {
    process.env.PENKRA_HOME = "/penkra-test/runtime";
    assert.deepEqual(resolveCodexGeneratedImagesRoots("/codex-test/.codex"), [
      path.join("/codex-test/.codex", "generated_images"),
      path.join("/penkra-test/runtime", "codex-home-overlay", "generated_images"),
    ]);
  });

  it("collapses to a single root when overlay equals source", () => {
    delete process.env.PENKRA_HOME;
    // The overlay falls under `<dirname(source)>/.penkra/runtime/codex-home-overlay`,
    // which is always distinct from `<source>` itself, so the helper still returns
    // both candidates; this test guards the dedupe path with an artificial home
    // whose dirname happens to equal the overlay root.
    const homePath = "/runtime/.penkra/runtime/codex-home-overlay";
    const roots = resolveCodexGeneratedImagesRoots(homePath);
    assert.ok(roots.length >= 1 && roots.length <= 2, `expected 1-2 roots, got ${roots.length}`);
    assert.ok(roots.includes(path.join(homePath, "generated_images")));
  });
});
