import { assert, describe, it } from "@effect/vitest";

import { resolveUnusedClaudePlatformPackageName } from "./lib/desktop-staged-runtime.ts";

describe("desktop staged runtime", () => {
  it("resolves the external-Claude package for each concrete desktop target", () => {
    assert.equal(
      resolveUnusedClaudePlatformPackageName("mac", "arm64"),
      "claude-agent-sdk-darwin-arm64",
    );
    assert.equal(
      resolveUnusedClaudePlatformPackageName("linux", "x64"),
      "claude-agent-sdk-linux-x64",
    );
    assert.equal(
      resolveUnusedClaudePlatformPackageName("win", "x64"),
      "claude-agent-sdk-win32-x64",
    );
  });

  it("leaves universal pruning to the architecture-specific packaging pass", () => {
    assert.equal(resolveUnusedClaudePlatformPackageName("mac", "universal"), null);
  });
});
