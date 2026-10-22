import { describe, expect, it } from "vitest";
import { bumpArguments, claudeSdkVersion, targetPlatform } from "./providers-bump.ts";
import { PROVIDER_RUNTIME_TARGETS } from "../src/provider/pinnedProviderRuntimes.ts";

describe("provider bump inputs", () => {
  it("requires one named provider and an exact version", () => {
    expect(bumpArguments(["codex", "0.163.0"])).toEqual({ provider: "codex", version: "0.163.0" });
    for (const args of [
      [],
      ["codex"],
      ["unknown", "1.2.3"],
      ["codex", "latest"],
      ["codex", "^1.2.3"],
      ["codex", "1.2.3", "extra"],
    ])
      expect(() => bumpArguments(args)).toThrow("Usage:");
  });
  it("uses explicit SDK metadata, never a guessed CLI-to-SDK version conversion", () => {
    const versions = {
      "0.3.307": { version: "0.3.307", claudeCodeVersion: "2.1.307" },
      "0.3.308": { version: "0.3.308", claudeCodeVersion: "2.1.307" },
      "0.3.999": { version: "0.3.999", claudeCodeVersion: "2.1.999" },
    };
    expect(claudeSdkVersion({ versions }, "2.1.307")).toBe("0.3.308");
    expect(() => claudeSdkVersion({ versions }, "2.1.308")).toThrow("No official");
    expect(() => claudeSdkVersion({}, "2.1.307")).toThrow("No official");
  });
  it("resolves every supported target with explicit architecture and libc", () => {
    for (const target of PROVIDER_RUNTIME_TARGETS) {
      const resolved = targetPlatform(target);
      expect([resolved.platform, resolved.arch, resolved.libc].filter(Boolean).join("-")).toBe(
        target,
      );
      expect(resolved.baseline ?? false).toBe(resolved.arch === "x64");
    }
  });
});
