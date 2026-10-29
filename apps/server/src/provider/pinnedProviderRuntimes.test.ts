import { describe, expect, it } from "vitest";
import lock from "../../../../providerRuntimes.json" with { type: "json" };
import serverPackage from "../../package.json" with { type: "json" };
import scriptsPackage from "../../../../scripts/package.json" with { type: "json" };
import {
  PINNED_PROVIDER_KINDS,
  PINNED_PROVIDER_RUNTIMES,
  PROVIDER_RUNTIME_TARGETS,
  parseProviderRuntimeLock,
  pinnedProviderArtifact,
} from "./pinnedProviderRuntimes.ts";

describe("pinned provider runtime manifest", () => {

  it("rejects missing targets, invalid digests, and crossed provider/version/platform identity", () => {
    const missing = structuredClone(lock);
    Reflect.deleteProperty(missing.providers.codex.artifacts, "darwin-arm64");
    expect(() => parseProviderRuntimeLock(missing)).toThrow();
    for (const replacement of [
      { sha256: "invalid" },
      { provider: "opencode" },
      { version: "0.1.0" },
      { platform: "win32" },
    ]) {
      const changed = structuredClone(lock);
      Object.assign(changed.providers.codex.artifacts["darwin-arm64"], replacement);
      expect(() => parseProviderRuntimeLock(changed)).toThrow();
    }
  });

  it("rejects non-official or mutable sources and escaping executable paths", () => {
    for (const replacement of [
      { url: "https://example.com/codex" },
      { url: "https://github.com/openai/codex/releases/latest/download/codex" },
      { executableRelativePath: "../codex" },
      { executableRelativePath: "C:\\codex.exe" },
    ]) {
      const changed = structuredClone(lock);
      Object.assign(changed.providers.codex.artifacts["darwin-arm64"], replacement);
      expect(() => parseProviderRuntimeLock(changed)).toThrow();
    }
    expect(() => pinnedProviderArtifact("codex", { platform: "freebsd", arch: "x64" })).toThrow(
      "No pinned runtime",
    );
  });
});
