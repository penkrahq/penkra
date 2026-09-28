import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { DiagnosticsSpoolWriter, DiagnosticsStore, openDiagnosticsReader } from "./store";

const roots: string[] = [];

function fixture(version = "0.14.3", maxTotalBytes?: number) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "penkra-diagnostics-"));
  roots.push(stateDir);
  return {
    stateDir,
    store: new DiagnosticsStore({
      stateDir,
      appVersion: version,
      process: "server",
      ...(maxTotalBytes === undefined ? {} : { maxTotalBytes }),
    }),
  };
}

const traceId = "0123456789abcdef0123456789abcdef";
const spanId = "0123456789abcdef";

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("diagnostics store", () => {
  it("rejects a fabricated all-zero build ID", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "penkra-diagnostics-"));
    roots.push(stateDir);
    expect(
      () =>
        new DiagnosticsStore({
          stateDir,
          appVersion: "0.14.3",
          process: "server",
          buildId: "0000000",
        }),
    ).toThrow("Invalid diagnostics build ID");
  });
  it("resets a same-version installed rebuild and rejects the stale process", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "penkra-diagnostics-"));
    roots.push(stateDir);
    const bundlePath = path.join(stateDir, "app.asar");
    fs.writeFileSync(bundlePath, "first bundle");
    const signature = () => {
      const stats = fs.statSync(bundlePath);
      return { size: stats.size, mtimeMs: stats.mtimeMs, inode: stats.ino };
    };
    const oldOptions = {
      stateDir,
      appVersion: "0.14.3",
      buildId: "aaaaaaa",
      bundlePath,
      bundleSignature: signature(),
      process: "server" as const,
    };
    const old = new DiagnosticsStore(oldOptions);
    old.incident({
      traceId,
      spanId,
      kind: "command.failed",
      code: "COMMAND_REJECTED",
      where: "server.command",
      severity: "error",
    });
    const replacement = path.join(stateDir, "replacement.asar");
    fs.writeFileSync(replacement, "second bundle");
    fs.renameSync(replacement, bundlePath);
    expect(() =>
      old.checkpoint({ traceId, spanId, flow: "send", step: "server.received" }),
    ).toThrow("stale app bundle");
    const stale = new DiagnosticsSpoolWriter({ ...oldOptions, process: "desktop-main" });
    stale.checkpoint({ traceId, spanId, flow: "send", step: "composer.preflight" });
    const current = new DiagnosticsStore({
      ...oldOptions,
      buildId: "bbbbbbb",
      bundleSignature: signature(),
    });
    stale.checkpoint({ traceId, spanId, flow: "send", step: "composer.preflight" });
    current.importPeerSpools();
    const db = openDiagnosticsReader(stateDir)!;
    expect(
      db
        .prepare("SELECT SUM(count) AS count FROM incidents WHERE code = 'DIAGNOSTICS_DROPPED'")
        .get(),
    ).toMatchObject({ count: 2 });
    expect(db.prepare("SELECT count(*) AS count FROM detail").get()).toMatchObject({ count: 0 });
    expect(() => new DiagnosticsStore(oldOptions)).toThrow("stale app bundle");
    db.close();
    stale.close();
    old.close();
    current.close();
  });
  it("copies last-changed-by provenance into a related incident", () => {
    const { stateDir, store } = fixture();
    store.setProvenance({
      entityKind: "thread",
      entityId: "thread:abc",
      field: "thread.activeTurnId",
      traceId,
    });
    store.incident({
      traceId,
      spanId,
      threadId: "thread:abc",
      kind: "invariant.violated",
      code: "TURN_STATE_DIVERGED",
      where: "orchestration.worker",
      severity: "error",
    });
    const db = openDiagnosticsReader(stateDir)!;
    const row = db.prepare("SELECT provenance_json FROM incidents").get() as {
      provenance_json: string;
    };
    expect(JSON.parse(row.provenance_json)).toMatchObject([
      { field: "thread.activeTurnId", setByTraceId: traceId },
    ]);
    expect(() =>
      store.setProvenance({
        entityKind: "thread",
        entityId: "thread:abc",
        field: "private.message",
        traceId,
      }),
    ).toThrow("Invalid diagnostic field");
    db.close();
    store.close();
  });
  it("stores typed external outcomes and expectation resolutions without payload content", () => {
    const { stateDir, store } = fixture();
    store.externalOutcome({
      traceId,
      spanId,
      flow: "provider_delivery",
      step: "provider.call_accepted",
      outcome: "ok",
      elapsedMs: 42,
    });
    const id = store.armExpectation({ traceId, spanId, kind: "turn.started", deadlineMs: 10_000 });
    store.resolveExpectation(id);
    const db = openDiagnosticsReader(stateDir)!;
    expect(db.prepare("SELECT event_type FROM detail ORDER BY id").all()).toMatchObject([
      { event_type: "external_outcome" },
      { event_type: "expectation_resolved" },
    ]);
    expect(() =>
      store.externalOutcome({
        traceId,
        spanId,
        flow: "provider_delivery",
        step: "provider.call_accepted",
        outcome: "ok",
        elapsedMs: 1,
        fields: { output: "private answer" },
      }),
    ).toThrow("not allowlisted");
    db.close();
    store.close();
  });
  it("reports stalled and crashed peer processes once per observed failure", () => {
    const { stateDir, store } = fixture();
    const desktop = new DiagnosticsSpoolWriter({
      stateDir,
      appVersion: "0.14.3",
      process: "desktop-main",
    });
    desktop.sampleHealth({ eventLoopLagMs: 0 });
    store.importPeerSpools();
    const databasePath = path.join(stateDir, "diagnostics", "diagnostics.sqlite");
    const writer = new DatabaseSync(databasePath);
    const stale = new Date(Date.now() - 20_000).toISOString();
    writer.prepare("UPDATE health SET at = ? WHERE boot_id = ?").run(stale, desktop.bootId);
    writer.close();
    expect(store.checkProcessHealth()).toBe(1);
    expect(store.checkProcessHealth()).toBe(0);
    const activePath = path.join(stateDir, "diagnostics", `active-${desktop.bootId}.json`);
    fs.writeFileSync(activePath, JSON.stringify({ pid: 999_999_999, process: "desktop-main" }));
    expect(store.checkProcessHealth()).toBe(1);
    const db = openDiagnosticsReader(stateDir)!;
    expect(db.prepare("SELECT code FROM incidents ORDER BY code").all()).toMatchObject([
      { code: "PROCESS_CRASHED" },
      { code: "PROCESS_UNRESPONSIVE" },
    ]);
    db.close();
    desktop.close();
    store.close();
  });
  it("records allowlisted process health and attaches it to incidents", () => {
    const { stateDir, store } = fixture();
    store.sampleHealth({ eventLoopLagMs: 12, queueDepth: 3, oldestQueuedMs: 50 });
    store.incident({
      traceId,
      spanId,
      kind: "command.failed",
      code: "COMMAND_DISPATCH_TIMEOUT",
      where: "orchestration.worker",
      severity: "error",
    });
    const db = openDiagnosticsReader(stateDir)!;
    expect(
      db.prepare("SELECT process, event_loop_lag_ms, queue_depth FROM health").get(),
    ).toMatchObject({
      process: "server",
      event_loop_lag_ms: 12,
      queue_depth: 3,
    });
    const row = db.prepare("SELECT health_json FROM incidents").get() as { health_json: string };
    expect(JSON.parse(row.health_json)).toMatchObject({ eventLoopLagMs: 12, queueDepth: 3 });
    db.close();
    store.close();
  });
  it("thins old health to one sample per process per minute", () => {
    const { stateDir, store } = fixture();
    store.sampleHealth({ eventLoopLagMs: 1 });
    store.sampleHealth({ eventLoopLagMs: 2 });
    store.sampleHealth({ eventLoopLagMs: 3 });
    const writer = new DatabaseSync(path.join(stateDir, "diagnostics", "diagnostics.sqlite"));
    writer
      .prepare("UPDATE health SET at = ? WHERE id <= 2")
      .run(new Date(Date.now() - 2 * 86_400_000).toISOString());
    writer.close();
    store.prune(new Date(Date.now() + 61_000));
    const db = openDiagnosticsReader(stateDir)!;
    expect(db.prepare("SELECT count(*) AS count FROM health").get()).toMatchObject({ count: 2 });
    db.close();
    store.close();
  });
  it("joins desktop and server checkpoints in one trace while both processes are live", () => {
    const { stateDir, store } = fixture();
    const desktop = new DiagnosticsSpoolWriter({
      stateDir,
      appVersion: "0.14.3",
      process: "desktop-main",
    });
    desktop.checkpoint({
      traceId,
      spanId,
      threadId: "thread:abc",
      flow: "send",
      step: "composer.preflight",
    });
    desktop.armExpectation({
      traceId,
      spanId,
      threadId: "thread:abc",
      kind: "send.accepted",
      deadlineMs: 2_000,
    });
    const beforeImport = openDiagnosticsReader(stateDir)!;
    expect(beforeImport.prepare("SELECT count(*) AS count FROM detail").get()).toMatchObject({
      count: 0,
    });
    beforeImport.close();
    store.importPeerSpools();
    store.checkpoint({
      traceId,
      spanId: "1111111111111111",
      threadId: "thread:abc",
      flow: "send",
      step: "server.received",
    });
    expect(store.resolveExpectationsForTrace(traceId, "send.accepted")).toBe(1);
    expect(store.resolveExpectationsForTrace(traceId, "send.accepted")).toBe(0);
    const db = openDiagnosticsReader(stateDir)!;
    expect(
      db.prepare("SELECT step FROM detail WHERE trace_id = ? ORDER BY id").all(traceId),
    ).toMatchObject([
      { step: "composer.preflight" },
      { step: "server.received" },
      { step: "expectation.resolved" },
    ]);
    db.close();
    desktop.close();
    store.close();
  });
  it("imports a gracefully closed desktop spool without marking a crash", () => {
    const { stateDir, store } = fixture();
    const desktop = new DiagnosticsSpoolWriter({
      stateDir,
      appVersion: "0.14.3",
      process: "desktop-main",
    });
    desktop.sampleHealth({ eventLoopLagMs: 8 });
    desktop.incident({
      traceId,
      spanId,
      kind: "timeout",
      code: "WS_HANDSHAKE_SLOW",
      where: "browser.socket_connect",
      severity: "error",
      expected: { deadlineMs: 3_000 },
    });
    desktop.close();
    expect(store.importPeerSpools()).toBe(0);
    const db = openDiagnosticsReader(stateDir)!;
    expect(db.prepare("SELECT process, event_loop_lag_ms FROM health").get()).toMatchObject({
      process: "desktop-main",
      event_loop_lag_ms: 8,
    });
    expect(db.prepare("SELECT code FROM incidents").all()).toMatchObject([
      { code: "WS_HANDSHAKE_SLOW" },
    ]);
    db.close();
    store.close();
  });

  it("imports a crashed desktop spool and reports the unclean shutdown", () => {
    const { stateDir, store } = fixture();
    const desktop = new DiagnosticsSpoolWriter({
      stateDir,
      appVersion: "0.14.3",
      process: "desktop-main",
    });
    desktop.checkpoint({ traceId, spanId, flow: "send", step: "composer.preflight" });
    const marker = path.join(stateDir, "diagnostics", `active-${desktop.bootId}.json`);
    fs.writeFileSync(marker, JSON.stringify({ pid: 999_999_999, process: "desktop-main" }));
    expect(store.importPeerSpools()).toBe(1);
    const db = openDiagnosticsReader(stateDir)!;
    expect(
      db.prepare("SELECT step FROM detail WHERE boot_id = ?").get(desktop.bootId),
    ).toMatchObject({
      step: "composer.preflight",
    });
    expect(db.prepare("SELECT code FROM incidents").all()).toMatchObject([
      { code: "UNCLEAN_SHUTDOWN" },
    ]);
    db.close();
    store.close();
  });
  it("resolves expectations and records missed deadlines with the last checkpoint", () => {
    const { stateDir, store } = fixture();
    store.checkpoint({ traceId, spanId, flow: "send", step: "server.received" });
    const met = store.armExpectation({ traceId, spanId, kind: "send.accepted", deadlineMs: 2_000 });
    expect(store.resolveExpectation(met)).toBe(true);
    expect(store.resolveExpectation(met)).toBe(false);
    store.armExpectation({ traceId, spanId, kind: "turn.started", deadlineMs: 10_000 });
    expect(store.sweepExpectations(new Date(Date.now() + 11_000))).toBe(1);
    const db = openDiagnosticsReader(stateDir)!;
    expect(db.prepare("SELECT count(*) AS count FROM expectations").get()).toMatchObject({
      count: 0,
    });
    expect(
      db.prepare("SELECT code, last_checkpoint, expected_json FROM incidents").get(),
    ).toMatchObject({
      code: "TURN_START_TIMEOUT",
      last_checkpoint: "expectation.resolved",
      expected_json: '{"deadlineMs":10000}',
    });
    const limit = db.prepare("SELECT limit_json FROM incident_occurrences").get() as {
      limit_json: string;
    };
    expect(JSON.parse(limit.limit_json)).toMatchObject({
      name: "turnStartedMs",
      value: 10_000,
    });
    db.close();
    store.close();
  });

  it("records the supported OS family and product major in the incident environment", () => {
    const { stateDir, store } = fixture();
    store.incident({
      traceId,
      spanId,
      kind: "command.failed",
      code: "COMMAND_REJECTED",
      where: "server.command",
      severity: "error",
    });
    const db = openDiagnosticsReader(stateDir)!;
    const row = db.prepare("SELECT env_json FROM incident_occurrences").get() as {
      env_json: string;
    };
    const environment = JSON.parse(row.env_json);
    expect(environment.osFamily).toBe(process.platform === "win32" ? "windows" : process.platform);
    if (process.platform === "darwin") {
      expect(environment.osMajor).toBe(
        Number.parseInt(execFileSync("/usr/bin/sw_vers", ["-productVersion"]).toString(), 10),
      );
    }
    db.close();
    store.close();
  });

  it("records a late resolution as a missed deadline before the sweep", async () => {
    const { stateDir, store } = fixture();
    const id = store.armExpectation({
      traceId,
      spanId,
      kind: "turn.started",
      deadlineMs: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(store.resolveExpectation(id)).toBe(true);
    const db = openDiagnosticsReader(stateDir)!;
    expect(db.prepare("SELECT code, context_json FROM incidents").get()).toMatchObject({
      code: "TURN_START_TIMEOUT",
      context_json: '{"reason":"late_resolution"}',
    });
    expect(
      JSON.parse(
        (db.prepare("SELECT limit_json FROM incidents").get() as { limit_json: string }).limit_json,
      ),
    ).toMatchObject({ name: "turnStartedMs", value: 1 });
    expect(db.prepare("SELECT count(*) AS count FROM expectations").get()).toMatchObject({
      count: 0,
    });
    db.close();
    store.close();
  });

  it("marks unresolved expectations unknown after a restart", () => {
    const { stateDir, store } = fixture();
    store.armExpectation({ traceId, spanId, kind: "turn.first_output", deadlineMs: 30_000 });
    store.close();
    const restarted = new DiagnosticsStore({ stateDir, appVersion: "0.14.3", process: "server" });
    const db = openDiagnosticsReader(stateDir)!;
    expect(db.prepare("SELECT code, context_json FROM incidents").get()).toMatchObject({
      code: "EXPECTATION_MISSED",
      context_json: '{"reason":"unknown"}',
    });
    expect(db.prepare("SELECT count(*) AS count FROM expectations").get()).toMatchObject({
      count: 0,
    });
    db.close();
    restarted.close();
  });

  it("keeps a live desktop expectation pending when the server restarts", () => {
    const { stateDir, store } = fixture();
    const desktop = new DiagnosticsSpoolWriter({
      stateDir,
      appVersion: "0.14.3",
      process: "desktop-main",
    });
    desktop.armExpectation({ traceId, spanId, kind: "send.accepted", deadlineMs: 30_000 });
    store.close();
    const restarted = new DiagnosticsStore({ stateDir, appVersion: "0.14.3", process: "server" });
    const db = openDiagnosticsReader(stateDir)!;
    expect(db.prepare("SELECT count(*) AS count FROM expectations").get()).toMatchObject({
      count: 1,
    });
    expect(db.prepare("SELECT count(*) AS count FROM incidents").get()).toMatchObject({ count: 0 });
    db.close();
    desktop.close();
    restarted.close();
  });

  it("does not leave a late imported send expectation after server acceptance", () => {
    const { stateDir, store } = fixture();
    const desktop = new DiagnosticsSpoolWriter({
      stateDir,
      appVersion: "0.14.3",
      process: "desktop-main",
    });
    store.checkpoint({ traceId, spanId, flow: "send", step: "command.accepted", outcome: "ok" });
    desktop.armExpectation({ traceId, spanId, kind: "send.accepted", deadlineMs: 2_000 });
    store.importPeerSpools();
    const db = openDiagnosticsReader(stateDir)!;
    expect(db.prepare("SELECT count(*) AS count FROM expectations").get()).toMatchObject({
      count: 0,
    });
    db.close();
    desktop.close();
    store.close();
  });

  it("rejects content in expectation correlation before persisting it", () => {
    const { stateDir, store } = fixture();
    expect(() =>
      store.armExpectation({
        traceId,
        spanId,
        kind: "turn.started",
        deadlineMs: 10_000,
        correlation: { message: "private prompt content" },
      }),
    ).toThrow("not allowlisted");
    const db = openDiagnosticsReader(stateDir)!;
    expect(db.prepare("SELECT count(*) AS count FROM expectations").get()).toMatchObject({
      count: 0,
    });
    db.close();
    store.close();
  });
  it("records checkpoints and collapses repeated incidents with allowed evidence", () => {
    const { stateDir, store } = fixture();
    store.checkpoint({
      traceId,
      spanId,
      threadId: "thread:abc",
      flow: "send",
      step: "server.received",
      fields: { queueDepth: 2 },
    });
    const failure = {
      traceId,
      spanId,
      threadId: "thread:abc",
      kind: "command.failed",
      code: "COMMAND_DISPATCH_TIMEOUT",
      where: "orchestration.worker",
      severity: "error",
      expected: { deadlineMs: 45_000 },
      actual: { elapsedMs: 45_300 },
    } as const;
    store.incident(failure);
    const secondTraceId = "fedcba9876543210fedcba9876543210";
    store.incident({ ...failure, traceId: secondTraceId, actual: { elapsedMs: 45_900 } });
    const db = openDiagnosticsReader(stateDir)!;
    expect(db.prepare("SELECT count FROM incidents").get()).toMatchObject({ count: 2 });
    expect(db.prepare("SELECT count(*) AS count FROM incident_occurrences").get()).toMatchObject({
      count: 2,
    });
    expect(
      db.prepare("SELECT trace_id, actual_json FROM incident_occurrences ORDER BY sequence").all(),
    ).toMatchObject([
      { trace_id: traceId, actual_json: '{"elapsedMs":45300}' },
      { trace_id: secondTraceId, actual_json: '{"elapsedMs":45900}' },
    ]);
    expect(db.prepare("SELECT count(*) AS count FROM detail").get()).toMatchObject({ count: 1 });
    expect(db.prepare("SELECT expected_json FROM incidents").get()).toMatchObject({
      expected_json: '{"deadlineMs":45000}',
    });
    db.close();
    store.close();
  });

  it("pins detail recorded after an incident within its evidence window", () => {
    const { stateDir, store } = fixture();
    store.incident({
      traceId,
      spanId,
      kind: "command.failed",
      code: "COMMAND_REJECTED",
      where: "server.command",
      severity: "error",
    });
    store.checkpoint({ traceId, spanId, flow: "send", step: "server.received" });
    const db = openDiagnosticsReader(stateDir)!;
    expect(db.prepare("SELECT pinned_until FROM detail").get()).toMatchObject({
      pinned_until: expect.any(String),
    });
    db.close();
    store.close();
  });

  it("resets the database and spools on every version change", () => {
    const { stateDir, store } = fixture("0.14.2");
    store.incident({
      traceId,
      spanId,
      kind: "command.failed",
      code: "COMMAND_REJECTED",
      where: "orchestration.worker",
      severity: "error",
    });
    store.close();
    const oldSpool = path.join(
      stateDir,
      "diagnostics",
      "spool-deadbeefdeadbeefdeadbeefdeadbeef.jsonl",
    );
    fs.writeFileSync(oldSpool, "old-version-content");
    const next = new DiagnosticsStore({ stateDir, appVersion: "0.14.3", process: "server" });
    expect(fs.existsSync(oldSpool)).toBe(false);
    const db = openDiagnosticsReader(stateDir)!;
    expect(db.prepare("SELECT count(*) AS count FROM incidents").get()).toMatchObject({ count: 0 });
    expect(db.prepare("SELECT value FROM meta WHERE key='app_version'").get()).toMatchObject({
      value: "0.14.3",
    });
    db.close();
    next.close();
  });

  it("resets old data when the desktop starts the new version first", () => {
    const { stateDir, store } = fixture("0.14.2");
    store.incident({
      traceId,
      spanId,
      kind: "command.failed",
      code: "COMMAND_REJECTED",
      where: "orchestration.worker",
      severity: "error",
    });
    store.close();
    const desktop = new DiagnosticsSpoolWriter({
      stateDir,
      appVersion: "0.14.3",
      process: "desktop-main",
    });
    desktop.checkpoint({ traceId, spanId, flow: "send", step: "composer.preflight" });
    const next = new DiagnosticsStore({ stateDir, appVersion: "0.14.3", process: "server" });
    const db = openDiagnosticsReader(stateDir)!;
    expect(db.prepare("SELECT count(*) AS count FROM incidents").get()).toMatchObject({ count: 0 });
    expect(db.prepare("SELECT step FROM detail").all()).toMatchObject([
      { step: "composer.preflight" },
    ]);
    expect(db.prepare("SELECT value FROM meta WHERE key='reset_at'").get()).toMatchObject({
      value: expect.any(String),
    });
    db.close();
    desktop.close();
    next.close();
  });

  it("rejects a late old process without erasing the new version", () => {
    const { stateDir, store } = fixture("0.14.3");
    store.checkpoint({ traceId, spanId, flow: "send", step: "server.received" });
    const databasePath = path.join(stateDir, "diagnostics", "diagnostics.sqlite");
    const before = fs.statSync(databasePath).size;
    expect(
      () => new DiagnosticsSpoolWriter({ stateDir, appVersion: "0.14.2", process: "desktop-main" }),
    ).toThrow("newer app version");
    expect(
      () => new DiagnosticsStore({ stateDir, appVersion: "0.14.2", process: "server" }),
    ).toThrow("newer app version");
    expect(fs.statSync(databasePath).size).toBe(before);
    const db = openDiagnosticsReader(stateDir)!;
    expect(db.prepare("SELECT step FROM detail").all()).toMatchObject([
      { step: "server.received" },
    ]);
    db.close();
    store.close();
  });

  it("replays an orphaned spool once and marks the unclean shutdown", () => {
    const { stateDir, store } = fixture();
    store.close();
    const bootId = randomBytes(16).toString("hex");
    const dir = path.join(stateDir, "diagnostics");
    const event = {
      version: 1,
      bootId,
      sequence: 1,
      type: "checkpoint",
      at: "2026-09-28T12:00:00.000Z",
      monoMs: 12,
      process: "desktop-main",
      data: {
        traceId,
        spanId,
        flow: "send",
        step: "composer.preflight",
        fields: { queueDepth: 0 },
      },
    };
    fs.writeFileSync(
      path.join(dir, `spool-${bootId}.jsonl`),
      `${JSON.stringify(event)}\n${JSON.stringify(event)}\n`,
    );
    fs.writeFileSync(path.join(dir, `active-${bootId}.json`), JSON.stringify({ pid: 999_999_999 }));
    const recovered = new DiagnosticsStore({ stateDir, appVersion: "0.14.3", process: "server" });
    const db = openDiagnosticsReader(stateDir)!;
    expect(
      db.prepare("SELECT count(*) AS count FROM detail WHERE boot_id = ?").get(bootId),
    ).toMatchObject({ count: 1 });
    expect(db.prepare("SELECT at FROM detail WHERE boot_id = ?").get(bootId)).toMatchObject({
      at: event.at,
    });
    expect(db.prepare("SELECT code FROM incidents").get()).toMatchObject({
      code: "UNCLEAN_SHUTDOWN",
    });
    db.close();
    recovered.close();
  });

  it("records torn spool lines and missing sequence numbers before removing recovery data", () => {
    const { stateDir, store } = fixture();
    store.close();
    const bootId = randomBytes(16).toString("hex");
    const dir = path.join(stateDir, "diagnostics");
    const event = {
      version: 1,
      bootId,
      sequence: 1,
      type: "checkpoint",
      at: new Date().toISOString(),
      monoMs: 1,
      process: "desktop-main",
      data: { traceId, spanId, flow: "send", step: "composer.preflight" },
    };
    const spoolPath = path.join(dir, `spool-${bootId}.jsonl`);
    const spoolContent = `${JSON.stringify(event)}\n{"private":"torn"\n${JSON.stringify({ ...event, sequence: 3 })}\n`;
    fs.writeFileSync(spoolPath, spoolContent);
    const recovered = new DiagnosticsStore({ stateDir, appVersion: "0.14.3", process: "server" });
    const db = openDiagnosticsReader(stateDir)!;
    expect(
      db.prepare("SELECT value FROM meta WHERE key = ?").get(`spool-invalid:${bootId}`),
    ).toMatchObject({ value: "1" });
    expect(
      db.prepare("SELECT value FROM meta WHERE key = ?").get(`sequence-gap:${bootId}`),
    ).toMatchObject({ value: "1" });
    expect(
      db
        .prepare(
          "SELECT count(*) AS count FROM incident_occurrences WHERE incident_id IN (SELECT id FROM incidents WHERE code = 'DIAGNOSTICS_DROPPED')",
        )
        .get(),
    ).toMatchObject({ count: 1 });
    db.close();
    fs.writeFileSync(spoolPath, spoolContent);
    recovered.importPeerSpools();
    const replayed = openDiagnosticsReader(stateDir)!;
    expect(
      replayed.prepare("SELECT value FROM meta WHERE key = ?").get(`spool-invalid:${bootId}`),
    ).toMatchObject({ value: "1" });
    replayed.close();
    recovered.close();
  });

  it("rejects content fields before any spool or database write", () => {
    const { stateDir, store } = fixture();
    const secret = "private prompt content and token";
    expect(() =>
      store.checkpoint({
        traceId,
        spanId,
        flow: "send",
        step: "server.received",
        fields: { message: secret } as never,
      }),
    ).toThrow("not allowlisted");
    expect(() => store.checkpoint({ traceId, spanId, flow: "send", step: "secret" })).toThrow(
      "Invalid diagnostic step",
    );
    expect(() =>
      store.checkpoint({
        traceId,
        spanId,
        flow: "send",
        step: "server.received",
        fields: { provider: "secret" },
      }),
    ).toThrow("not allowlisted");
    store.checkpoint({
      traceId,
      spanId,
      flow: "send",
      step: "server.received",
      content: secret,
    } as never);
    store.close();
    const dir = path.join(stateDir, "diagnostics");
    for (const name of fs.readdirSync(dir)) {
      if (fs.statSync(path.join(dir, name)).isFile()) {
        expect(fs.readFileSync(path.join(dir, name)).includes(secret)).toBe(false);
      }
    }
  });

  it("rejects content fields from the desktop before writing a spool", () => {
    const { stateDir, store } = fixture();
    const desktop = new DiagnosticsSpoolWriter({
      stateDir,
      appVersion: "0.14.3",
      process: "desktop-main",
    });
    const secret = "private prompt content and token";
    expect(() =>
      desktop.checkpoint({
        traceId,
        spanId,
        flow: "send",
        step: "composer.preflight",
        fields: { message: secret } as never,
      }),
    ).toThrow("not allowlisted");
    expect(fs.existsSync(path.join(stateDir, "diagnostics", `spool-${desktop.bootId}.jsonl`))).toBe(
      false,
    );
    desktop.close();
    store.close();
  });

  it("keeps writes inside an injected cap", () => {
    const cap = 2 * 1024 * 1024;
    const { stateDir, store } = fixture("0.14.3", cap);
    const dir = path.join(stateDir, "diagnostics");
    const diskBytes = () =>
      fs.readdirSync(dir).reduce((sum, name) => {
        const file = path.join(dir, name);
        return sum + (fs.statSync(file).isFile() ? fs.statSync(file).size : 0);
      }, 0);
    expect(diskBytes()).toBeLessThan(cap);
    const peer = new DiagnosticsSpoolWriter({
      stateDir,
      appVersion: "0.14.3",
      process: "desktop-main",
      maxTotalBytes: cap,
    });
    peer.checkpoint({ traceId, spanId, flow: "send", step: "composer.preflight" });
    expect(diskBytes()).toBeLessThanOrEqual(cap);
    store.importPeerSpools();
    expect(diskBytes()).toBeLessThanOrEqual(cap);
    for (let i = 0; i < 250; i++) {
      try {
        store.checkpoint({
          traceId,
          spanId,
          flow: "send",
          step: "server.received",
          fields: { sequence: i },
        });
        if (i % 25 === 0)
          store.incident({
            traceId,
            spanId,
            kind: "command.failed",
            code: "COMMAND_REJECTED",
            where: "server.command",
            severity: "error",
            actual: { sequence: i },
          });
        expect(diskBytes()).toBeLessThanOrEqual(cap);
      } catch (cause) {
        expect((cause as Error).message).toContain("capacity");
        break;
      }
    }
    const db = openDiagnosticsReader(stateDir)!;
    const row = db.prepare("SELECT count(*) AS count FROM detail").get() as { count: number };
    expect(row.count).toBeGreaterThan(0);
    expect(diskBytes()).toBeLessThanOrEqual(cap);
    db.close();
    peer.close();
    store.close();
  }, 30_000);

  it("preserves a drop count and reports it after a peer spool fills", () => {
    const { stateDir, store } = fixture();
    const peer = new DiagnosticsSpoolWriter({
      stateDir,
      appVersion: "0.14.3",
      process: "desktop-main",
      maxSpoolBytes: 1,
    });
    expect(() =>
      peer.checkpoint({ traceId, spanId, flow: "send", step: "composer.preflight" }),
    ).toThrow("capacity");
    const ledger = path.join(stateDir, "diagnostics", `loss-${peer.bootId}.bin`);
    expect(JSON.parse(fs.readFileSync(ledger, "utf8"))).toMatchObject({
      count: 1,
      reason: "capacity",
    });
    store.importPeerSpools();
    const db = openDiagnosticsReader(stateDir)!;
    expect(
      db.prepare("SELECT code FROM incidents WHERE code = 'DIAGNOSTICS_CAP_REACHED'").get(),
    ).toMatchObject({ code: "DIAGNOSTICS_CAP_REACHED" });
    db.close();
    peer.close();
    store.close();
  });

  it("keeps separate durable counts for each write failure reason", () => {
    const { stateDir, store } = fixture();
    const peer = new DiagnosticsSpoolWriter({
      stateDir,
      appVersion: "0.14.3",
      process: "desktop-main",
    });
    const ledger = path.join(stateDir, "diagnostics", `loss-${peer.bootId}.bin`);
    const record = JSON.stringify({
      count: 3,
      reason: "spool",
      reasons: { capacity: 1, sqlite: 1, spool: 1, stale: 0 },
    });
    fs.writeFileSync(ledger, record.padEnd(256, " "));
    store.importPeerSpools();
    const db = openDiagnosticsReader(stateDir)!;
    expect(
      db
        .prepare(
          "SELECT code, count FROM incidents WHERE kind = 'diagnostics.degraded' ORDER BY code",
        )
        .all(),
    ).toMatchObject([
      { code: "DIAGNOSTICS_CAP_REACHED", count: 1 },
      { code: "DIAGNOSTICS_WRITE_FAILED", count: 1 },
      { code: "DIAGNOSTICS_WRITE_FAILED", count: 1 },
    ]);
    db.close();
    peer.close();
    store.close();
  });

  it("keeps an unimported recovery spool within the total cap and counts rejected writes", () => {
    const cap = 320 * 1024;
    const { stateDir, store } = fixture("0.14.3", cap);
    const dir = path.join(stateDir, "diagnostics");
    const diskBytes = () =>
      fs.readdirSync(dir).reduce((sum, name) => {
        const file = path.join(dir, name);
        return sum + (fs.statSync(file).isFile() ? fs.statSync(file).size : 0);
      }, 0);
    const recoveryPath = path.join(dir, `spool-${randomBytes(16).toString("hex")}.jsonl`);
    const recoveryBytes = cap - diskBytes() - 128;
    expect(recoveryBytes).toBeGreaterThan(0);
    fs.writeFileSync(recoveryPath, Buffer.alloc(recoveryBytes, 0x20));
    expect(() =>
      store.checkpoint({ traceId, spanId, flow: "send", step: "server.received" }),
    ).toThrow("capacity");
    expect(fs.statSync(recoveryPath).size).toBe(recoveryBytes);
    expect(diskBytes()).toBeLessThanOrEqual(cap);
    expect(
      JSON.parse(fs.readFileSync(path.join(dir, `loss-${store.bootId}.bin`), "utf8")),
    ).toMatchObject({ count: 1 });
    store.close();
  });
});
