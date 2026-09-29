import { describe, expect, it, vi } from "vitest";

import { PRE_STORE_BOOT_EXIT_CODES } from "@penkra/shared/diagnostics/startupExit";

import { createBackendStartupIncidentRecorder } from "./backendStartupIncident";

describe("backend pre-store startup incidents", () => {
  it.each(Object.entries(PRE_STORE_BOOT_EXIT_CODES))(
    "maps %s to its startup stage and records once per attempt",
    (bootStage, exitCode) => {
      const record = vi.fn();
      const attempt = createBackendStartupIncidentRecorder(record);
      attempt.recordExit(exitCode);
      attempt.recordExit(exitCode);
      expect(record).toHaveBeenCalledExactlyOnceWith({
        kind: "process.crashed",
        code: "BACKEND_STARTUP_FAILED",
        where: "desktop.backend_start",
        severity: "error",
        expected: { accepted: true },
        actual: { accepted: false, exitCode },
        context: { bootStage },
      });
    },
  );

  it("ignores other exits and exits after readiness", () => {
    const record = vi.fn();
    const attempt = createBackendStartupIncidentRecorder(record);
    attempt.recordExit(null);
    attempt.recordExit(0);
    attempt.recordExit(1);
    attempt.markReady();
    attempt.recordExit(PRE_STORE_BOOT_EXIT_CODES.database_lock);
    expect(record).not.toHaveBeenCalled();
  });

  it("records a new incident for a new startup attempt", () => {
    const record = vi.fn();
    createBackendStartupIncidentRecorder(record).recordExit(PRE_STORE_BOOT_EXIT_CODES.sqlite_open);
    createBackendStartupIncidentRecorder(record).recordExit(PRE_STORE_BOOT_EXIT_CODES.sqlite_open);
    expect(record).toHaveBeenCalledTimes(2);
  });
});
