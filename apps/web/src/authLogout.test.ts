import { describe, expect, it, vi } from "vitest";

import { AUTH_SIGNED_OUT_PATH } from "./authSignedOut";
import { logoutCurrentBrowserSession } from "./authLogout";

describe("logoutCurrentBrowserSession", () => {
  it.each(["logout", "navigation"] as const)(
    "records a fixed incident when %s fails",
    async (failureAt) => {
      const recordDiagnosticIncident = vi.fn().mockResolvedValue(undefined);
      vi.stubGlobal("window", { desktopBridge: { recordDiagnosticIncident } });
      try {
        const failure = new Error("private failure detail");
        const onError = vi.fn();
        await expect(
          logoutCurrentBrowserSession({
            confirm: async () => true,
            logout: async () => {
              if (failureAt === "logout") throw failure;
            },
            navigate: () => {
              if (failureAt === "navigation") throw failure;
            },
            onError,
          }),
        ).resolves.toBe("failed");
        expect(onError).toHaveBeenCalledWith(failure);
        expect(recordDiagnosticIncident).toHaveBeenCalledWith({
          traceId: expect.any(String),
          spanId: expect.any(String),
          kind: "command.failed",
          code: "APP_OPERATION_FAILED",
          where: "browser.client_runtime",
          severity: "error",
          expected: { accepted: true },
          actual: { accepted: false },
        });
        expect(JSON.stringify(recordDiagnosticIncident.mock.calls)).not.toContain(
          "private failure detail",
        );
      } finally {
        vi.unstubAllGlobals();
      }
    },
  );

  it("revokes once and replaces the authenticated app on confirmation", async () => {
    const logout = vi.fn().mockResolvedValue({ revoked: true });
    const navigate = vi.fn();
    const onError = vi.fn();

    await expect(
      logoutCurrentBrowserSession({
        confirm: async () => true,
        logout,
        navigate,
        onError,
      }),
    ).resolves.toBe("redirecting");

    expect(logout).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith(AUTH_SIGNED_OUT_PATH);
    expect(onError).not.toHaveBeenCalled();
  });

  it("keeps the authenticated app usable on cancellation or failure", async () => {
    const cancelledLogout = vi.fn();
    const navigate = vi.fn();
    const onError = vi.fn();
    await expect(
      logoutCurrentBrowserSession({
        confirm: async () => false,
        logout: cancelledLogout,
        navigate,
        onError,
      }),
    ).resolves.toBe("cancelled");
    expect(cancelledLogout).not.toHaveBeenCalled();

    const failure = new Error("network unavailable");
    await expect(
      logoutCurrentBrowserSession({
        confirm: async () => true,
        logout: async () => Promise.reject(failure),
        navigate,
        onError,
      }),
    ).resolves.toBe("failed");
    expect(navigate).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(failure);
  });
});
