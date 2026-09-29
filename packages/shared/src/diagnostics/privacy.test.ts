import { describe, expect, it } from "vitest";
import { validateDiagnosticFields, validateDiagnosticToken } from "./privacy";

describe("diagnostic field privacy", () => {
  it("rejects unknown keys even when their value is null", () => {
    expect(() => validateDiagnosticFields({ message: null })).toThrow(
      "Diagnostic field message is not allowlisted",
    );
    expect(validateDiagnosticFields({ threadId: null })).toEqual({ threadId: null });
  });

  it("accepts the desktop coverage recorder locations", () => {
    for (const where of [
      "desktop.app_runtime",
      "desktop.app_storage",
      "desktop.backend_runtime",
      "desktop.ipc_dispatch",
      "desktop.platform_runtime",
      "desktop.registry_client",
      "desktop.simulator_runtime",
      "desktop.tab_observer",
      "desktop.update_runtime",
    ]) {
      expect(validateDiagnosticToken(where, "where")).toBe(where);
    }
  });

  it("accepts the browser local-state and client-runtime locations", () => {
    expect(validateDiagnosticToken("browser.local_state", "where")).toBe("browser.local_state");
    expect(validateDiagnosticToken("browser.client_runtime", "where")).toBe(
      "browser.client_runtime",
    );
  });
});
