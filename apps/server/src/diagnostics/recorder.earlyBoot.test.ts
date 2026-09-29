import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DiagnosticsStore, openDiagnosticsReader, type IncidentInput } from "./store";

import { installDiagnosticsStore, recordDiagnosticIncident } from "./recorder";

function incident(index: number): IncidentInput {
  return {
    traceId: index.toString(16).padStart(32, "0"),
    spanId: index.toString(16).padStart(16, "0"),
    kind: "external.failed",
    code: "EXTERNAL_CALL_FAILED",
    where: "server.boot",
    severity: "error",
    expected: { accepted: true },
    actual: { accepted: false },
  };
}

function fakeStore() {
  const incidentWrite = vi.fn();
  const store = {
    incident: incidentWrite,
    startHealthSampling: () => () => undefined,
    startProcessWatchdog: () => () => undefined,
    importPeerSpools: vi.fn(),
    sweepExpectations: vi.fn(),
  } as unknown as DiagnosticsStore;
  return { store, incidentWrite };
}

describe("early boot diagnostics", () => {
  it("drains startup incidents after installation without writing on its call stack", async () => {
    recordDiagnosticIncident(incident(1));
    recordDiagnosticIncident(incident(2));
    const { store, incidentWrite } = fakeStore();
    const uninstall = installDiagnosticsStore(store);
    try {
      expect(incidentWrite).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(incidentWrite).toHaveBeenCalledTimes(2));
      expect(incidentWrite.mock.calls.map(([input]) => input.traceId)).toEqual([
        incident(1).traceId,
        incident(2).traceId,
      ]);
    } finally {
      uninstall();
    }
  });

  it("bounds the buffer and counts overwritten incidents after installation", async () => {
    for (let index = 1; index <= 257; index++) recordDiagnosticIncident(incident(index));
    const { store, incidentWrite } = fakeStore();
    const uninstall = installDiagnosticsStore(store);
    try {
      expect(incidentWrite).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(incidentWrite).toHaveBeenCalledTimes(257));
      expect(incidentWrite.mock.calls[0]?.[0]).toMatchObject({
        code: "DIAGNOSTICS_DROPPED",
        actual: { count: 1 },
      });
      expect(incidentWrite.mock.calls[1]?.[0].traceId).toBe(incident(2).traceId);
    } finally {
      uninstall();
    }
  });

  it("persists a pre-store incident without retaining arbitrary content", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "penkra-early-boot-diagnostic-"));
    recordDiagnosticIncident(incident(999));
    const store = new DiagnosticsStore({ stateDir, appVersion: "0.14.3", process: "server" });
    const uninstall = installDiagnosticsStore(store);
    try {
      await vi.waitFor(() => {
        const reader = openDiagnosticsReader(stateDir)!;
        try {
          expect(
            reader
              .prepare("SELECT count(*) AS count FROM incidents WHERE code = ?")
              .get("EXTERNAL_CALL_FAILED"),
          ).toMatchObject({ count: 1 });
        } finally {
          reader.close();
        }
      });
      const reader = openDiagnosticsReader(stateDir)!;
      try {
        const row = reader
          .prepare("SELECT expected_json, actual_json FROM incidents WHERE code = ?")
          .get("EXTERNAL_CALL_FAILED") as {
          expected_json: string;
          actual_json: string;
        };
        expect(row).toEqual({
          expected_json: '{"accepted":true}',
          actual_json: '{"accepted":false}',
        });
      } finally {
        reader.close();
      }
    } finally {
      uninstall();
      store.close();
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
