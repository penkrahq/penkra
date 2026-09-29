import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  measuredBootStage,
  recordBootReady,
  recordBootSlow,
  recordBootStageFailure,
  type BootStage,
} from "./boot";
import { DiagnosticsStore, openDiagnosticsReader } from "./store";

describe("boot diagnostics", () => {
  it("records a failed stage before propagating the startup failure", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "penkra-boot-diagnostics-"));
    const store = new DiagnosticsStore({ stateDir, appVersion: "0.14.3", process: "server" });
    const traceId = "0123456789abcdef0123456789abcdef";
    const durations: Array<{ stage: BootStage; elapsedMs: number }> = [];
    await expect(
      Effect.runPromise(
        measuredBootStage(
          "default-spaces.ensure",
          Effect.fail(new Error("test startup failure")),
          durations,
          undefined,
          (stage, elapsedMs) => recordBootStageFailure(store, traceId, stage, elapsedMs),
        ),
      ),
    ).rejects.toThrow("test startup failure");
    expect(durations).toHaveLength(1);
    const db = openDiagnosticsReader(stateDir)!;
    expect(db.prepare("SELECT code, context_json FROM incidents").get()).toMatchObject({
      code: "INVARIANT_VIOLATED",
      context_json: '{"bootStage":"default-spaces.ensure"}',
    });
    expect(db.prepare("SELECT step, payload_json FROM detail").get()).toMatchObject({
      step: "server.boot_stage_failed",
      payload_json: expect.stringContaining('"outcome":"failed"'),
    });
    db.close();
    store.close();
    fs.rmSync(stateDir, { recursive: true, force: true });
  });
  it("records the slowest startup stage when readiness exceeds the budget", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "penkra-boot-diagnostics-"));
    const store = new DiagnosticsStore({ stateDir, appVersion: "0.14.3", process: "server" });
    const traceId = "0123456789abcdef0123456789abcdef";
    recordBootReady(store, traceId, 21_000, [
      { stage: "provider-connection-login.recover", elapsedMs: 12_000 },
      { stage: "http-runtime.start", elapsedMs: 2_000 },
    ]);
    const db = openDiagnosticsReader(stateDir)!;
    expect(
      db.prepare("SELECT code, expected_json, actual_json, context_json FROM incidents").get(),
    ).toMatchObject({
      code: "BOOT_SLOW",
      expected_json: '{"deadlineMs":20000}',
      actual_json: '{"elapsedMs":21000}',
      context_json: '{"bootStage":"provider-connection-login.recover"}',
    });
    expect(db.prepare("SELECT step, payload_json FROM detail").get()).toMatchObject({
      step: "server.ready",
      payload_json: '{"outcome":"ok","elapsedMs":21000}',
    });
    db.close();
    store.close();
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("records a missed boot deadline while startup is still blocked", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "penkra-boot-diagnostics-"));
    const store = new DiagnosticsStore({ stateDir, appVersion: "0.14.3", process: "server" });
    const traceId = "0123456789abcdef0123456789abcdef";
    recordBootSlow(store, traceId, 20_100, "http-runtime.start");
    recordBootReady(
      store,
      traceId,
      25_000,
      [{ stage: "http-runtime.start", elapsedMs: 24_000 }],
      true,
    );
    const db = openDiagnosticsReader(stateDir)!;
    expect(db.prepare("SELECT count, context_json FROM incidents").get()).toMatchObject({
      count: 1,
      context_json: '{"bootStage":"http-runtime.start"}',
    });
    db.close();
    store.close();
    fs.rmSync(stateDir, { recursive: true, force: true });
  });
});
