import { describe, expect, it, vi } from "vitest";

import {
  PRE_STORE_BOOT_EXIT_CODES,
  PRE_STORE_BOOT_STAGES,
  preStoreBootStageForExitCode,
} from "@penkra/shared/diagnostics/startupExit";
import {
  validateDiagnosticFields,
  validateDiagnosticToken,
} from "@penkra/shared/diagnostics/privacy";

describe("pre-store backend exit contract", () => {
  it("has distinct exit codes and allowlisted boot stages", () => {
    expect(new Set(Object.values(PRE_STORE_BOOT_EXIT_CODES)).size).toBe(
      PRE_STORE_BOOT_STAGES.length,
    );
    for (const stage of PRE_STORE_BOOT_STAGES) {
      expect(preStoreBootStageForExitCode(PRE_STORE_BOOT_EXIT_CODES[stage])).toBe(stage);
      expect(validateDiagnosticFields({ bootStage: stage })).toEqual({ bootStage: stage });
    }
    expect(preStoreBootStageForExitCode(1)).toBeUndefined();
    expect(validateDiagnosticToken("desktop.backend_start", "where")).toBe("desktop.backend_start");
    expect(validateDiagnosticToken("BACKEND_STARTUP_FAILED", "code")).toBe(
      "BACKEND_STARTUP_FAILED",
    );
  });

  it("uses the failed phase before the store and the ordinary exit after it", async () => {
    vi.resetModules();
    const startup = await import("./preStoreStartup");
    expect(startup.serverExitCodeForRuntimeCode(1)).toBe(70);
    startup.notePreStoreBootFailure("database_lock");
    expect(startup.serverExitCodeForRuntimeCode(1)).toBe(71);
    expect(startup.serverExitCodeForRuntimeCode(130)).toBe(130);
    startup.noteDiagnosticsStoreReady();
    startup.notePreStoreBootFailure("sqlite_open");
    expect(startup.serverExitCodeForRuntimeCode(1)).toBe(1);
  });
});
