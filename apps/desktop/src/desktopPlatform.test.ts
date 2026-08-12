import { describe, expect, it } from "vitest";

import { resolveDesktopPlatformAdapter } from "./desktopPlatform";

describe("desktop platform adapters", () => {
  it("defines the signed macOS runtime and updater contract", () => {
    const adapter = resolveDesktopPlatformAdapter("darwin");
    expect(adapter.installation).toEqual({
      target: "dmg",
      trust: "apple-developer-id",
    });
    expect(adapter.updater).toMatchObject({
      mode: "automatic",
      disabledReason: null,
    });
    expect(adapter.browserPermissions.microphone).toBe("macos-system-prompt");
  });

  it("keeps initial Windows distribution unsigned and manual-only", () => {
    const adapter = resolveDesktopPlatformAdapter("win32");
    expect(adapter.installation).toEqual({
      target: "nsis",
      trust: "unsigned-manual",
    });
    expect(adapter.updater.mode).toBe("manual-only");
    expect(adapter.updater.disabledReason).toContain("unsigned");
    expect(adapter.processLifecycle.backendShutdown).toBe("windows-control");
  });

  it("defines AppImage updater and provenance behavior for Linux", () => {
    const adapter = resolveDesktopPlatformAdapter("linux");
    expect(adapter.installation).toEqual({
      target: "appimage",
      trust: "checksum-provenance",
    });
    expect(adapter.updater.mode).toBe("appimage-automatic");
    expect(adapter.paths.appData).toBe("xdg-config");
  });

  it("fails closed on an unsupported desktop platform", () => {
    expect(() => resolveDesktopPlatformAdapter("freebsd")).toThrow("Unsupported Penkra");
  });
});
