import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { DiagnosticsStore, openDiagnosticsReader } from "@penkra/shared/diagnostics/store";
import { describe, expect, it, vi } from "vitest";

import { createSendDiagnosticLifecycle } from "./sendDiagnosticLifecycle";

const trace = { traceId: "0123456789abcdef0123456789abcdef", spanId: "0123456789abcdef" };
const threadId = "thread:abc";

describe("send diagnostic lifecycle", () => {
  it("leaves an abandoned preflight without a deadline or timeout incident and arms at dispatch", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "penkra-send-diagnostics-"));
    const store = new DiagnosticsStore({ stateDir, appVersion: "0.14.3", process: "desktop-main" });
    try {
      const arm = vi.fn((input: { traceId: string; spanId: string; threadId?: string }) => {
        store.armExpectation({ ...input, kind: "send.accepted", deadlineMs: 10 });
        return Promise.resolve();
      });
      const diagnostics = createSendDiagnosticLifecycle(trace, {
        recordDiagnosticCheckpoint: (input) => {
          store.checkpoint(input);
          return Promise.resolve();
        },
        armSendDiagnosticExpectation: arm,
      });
      diagnostics.preflight(threadId);
      const db = openDiagnosticsReader(stateDir)!;
      expect(db.prepare("SELECT COUNT(*) AS count FROM expectations").get()).toMatchObject({
        count: 0,
      });
      expect(store.sweepExpectations(new Date(Date.now() + 1_000))).toBe(0);
      expect(db.prepare("SELECT COUNT(*) AS count FROM incident_occurrences").get()).toMatchObject({
        count: 0,
      });
      expect(arm).not.toHaveBeenCalled();

      const dispatch = vi.fn(() => "sent");
      expect(diagnostics.dispatch(threadId, dispatch)).toBe("sent");
      expect(dispatch).toHaveBeenCalledOnce();
      expect(arm).toHaveBeenCalledWith({ ...trace, threadId });
      expect(db.prepare("SELECT COUNT(*) AS count FROM expectations").get()).toMatchObject({
        count: 1,
      });
      expect(store.sweepExpectations(new Date(Date.now() + 1_000))).toBe(1);
      expect(db.prepare("SELECT code FROM incidents").get()).toMatchObject({
        code: "SEND_PREFLIGHT_REJECTED",
      });
      db.close();
    } finally {
      store.close();
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("dispatches without waiting for the diagnostics IPC", () => {
    const pending = new Promise<void>(() => undefined);
    const diagnostics = createSendDiagnosticLifecycle(trace, {
      armSendDiagnosticExpectation: () => pending,
    });
    expect(diagnostics.dispatch(threadId, () => "sent")).toBe("sent");
  });
});
