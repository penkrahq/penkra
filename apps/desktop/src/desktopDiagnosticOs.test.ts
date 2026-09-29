import { describe, expect, it, vi } from "vitest";

import { recordDesktopOsLookupFailure, resolveDesktopOsMajor } from "./desktopDiagnosticOs";

describe("desktop diagnostics OS identity", () => {
  it("uses the product major returned by Electron", () => {
    const getSystemVersion = vi.fn(() => "15.6.1");
    expect(resolveDesktopOsMajor(getSystemVersion)).toBe(15);
    expect(getSystemVersion).toHaveBeenCalledTimes(1);
  });

  it("marks unavailable and invalid versions unknown", () => {
    expect(
      resolveDesktopOsMajor(() => {
        throw new Error("unavailable");
      }),
    ).toBe("unknown");
    expect(resolveDesktopOsMajor(() => "invalid")).toBe("unknown");
  });

  it("records one content-free incident when the OS version is unavailable", () => {
    const incident = vi.fn();
    recordDesktopOsLookupFailure("unknown", { incident });
    recordDesktopOsLookupFailure(15, { incident });
    expect(incident).toHaveBeenCalledTimes(1);
    expect(incident).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "EXTERNAL_CALL_FAILED",
        where: "desktop.os_lookup",
        actual: { errorCode: "OTHER", reason: "unknown" },
      }),
    );
  });
});
