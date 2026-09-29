import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DiagnosticsSpoolWriter,
  DiagnosticsStore,
  createDiagnosticOsResolver,
  openDiagnosticsReader,
  readLossLedger,
} from "./store";
import { DIAGNOSTIC_LIMITS } from "./limits";

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
  it("keeps a nearly full store within the cap during restart", () => {
    const cap = 512 * 1024;
    const { stateDir, store } = fixture("0.14.3", cap);
    store.close();
    const dir = path.join(stateDir, "diagnostics");
    const bytes = () =>
      fs.readdirSync(dir).reduce((sum, name) => {
        const file = path.join(dir, name);
        return sum + (fs.statSync(file).isFile() ? fs.statSync(file).size : 0);
      }, 0);
    fs.writeFileSync(path.join(dir, "padding"), Buffer.alloc(cap - bytes() - 1_024));
    try {
      const restarted = new DiagnosticsStore({
        stateDir,
        appVersion: "0.14.3",
        process: "server",
        maxTotalBytes: cap,
      });
      restarted.close();
    } catch (cause) {
      expect((cause as Error).message).toContain("capacity");
    }
    expect(bytes()).toBeLessThanOrEqual(cap);
  });

  it("resets a completely full old installation without manual cleanup", () => {
    const cap = 512 * 1024;
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "penkra-diagnostics-reset-cap-"));
    roots.push(stateDir);
    const oldOptions = { stateDir, appVersion: "0.14.3", buildId: "aaaaaaa", maxTotalBytes: cap };
    const old = new DiagnosticsStore({ ...oldOptions, process: "server" });
    const peer = new DiagnosticsSpoolWriter({ ...oldOptions, process: "desktop-main" });
    peer.checkpoint({ traceId, spanId, flow: "send", step: "composer.preflight" });
    peer.close();
    old.close();
    const dir = path.join(stateDir, "diagnostics");
    const bytes = () =>
      fs.readdirSync(dir).reduce((sum, name) => {
        const file = path.join(dir, name);
        return sum + (fs.statSync(file).isFile() ? fs.statSync(file).size : 0);
      }, 0);
    const padding = path.join(dir, "padding");
    fs.writeFileSync(padding, Buffer.alloc(cap - bytes()));
    expect(bytes()).toBe(cap);
    const current = new DiagnosticsStore({
      stateDir,
      appVersion: "0.14.3",
      buildId: "bbbbbbb",
      process: "server",
      maxTotalBytes: cap,
    });
    const reader = openDiagnosticsReader(stateDir)!;
    expect(
      reader
        .prepare("SELECT COUNT(*) AS count FROM incidents WHERE code = 'DIAGNOSTICS_DROPPED'")
        .get(),
    ).toMatchObject({ count: 1 });
    reader.close();
    current.close();
    expect(fs.existsSync(padding)).toBe(false);
    expect(bytes()).toBeLessThanOrEqual(cap);
  });

  it("keeps reset headroom when desktop spools are the only old files", () => {
    const cap = 512 * 1024;
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "penkra-diagnostics-desktop-cap-"));
    roots.push(stateDir);
    const desktop = new DiagnosticsSpoolWriter({
      stateDir,
      appVersion: "0.14.3",
      buildId: "aaaaaaa",
      process: "desktop-main",
      maxTotalBytes: cap,
      maxSpoolBytes: cap,
    });
    let rejected = false;
    for (let sequence = 0; sequence < 4_000; sequence++) {
      try {
        desktop.checkpoint({
          traceId,
          spanId,
          flow: "send",
          step: "composer.preflight",
          fields: { sequence },
        });
      } catch (cause) {
        expect((cause as Error).message).toContain("capacity");
        rejected = true;
        break;
      }
    }
    expect(rejected).toBe(true);
    desktop.close();
    const dir = path.join(stateDir, "diagnostics");
    const bytes = () =>
      fs.readdirSync(dir).reduce((sum, name) => {
        const file = path.join(dir, name);
        return sum + (fs.statSync(file).isFile() ? fs.statSync(file).size : 0);
      }, 0);
    expect(bytes()).toBeLessThanOrEqual(cap - cap / 8);
    const current = new DiagnosticsStore({
      stateDir,
      appVersion: "0.14.3",
      buildId: "bbbbbbb",
      process: "server",
      maxTotalBytes: cap,
    });
    current.close();
    expect(bytes()).toBeLessThanOrEqual(cap);
  }, 30_000);

  it("recovers when update reset stops after removing old SQLite files", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "penkra-diagnostics-reset-crash-"));
    roots.push(stateDir);
    const oldOptions = { stateDir, appVersion: "0.14.3", buildId: "aaaaaaa" };
    const old = new DiagnosticsStore({ ...oldOptions, process: "server" });
    const desktop = new DiagnosticsSpoolWriter({ ...oldOptions, process: "desktop-main" });
    desktop.checkpoint({ traceId, spanId, flow: "send", step: "composer.preflight" });
    desktop.close();
    old.close();
    const dir = path.join(stateDir, "diagnostics");
    for (const name of fs.readdirSync(dir)) {
      if (name === "identity" || name === "version" || name.startsWith("diagnostics.sqlite"))
        fs.rmSync(path.join(dir, name), { force: true });
    }
    expect(fs.readdirSync(dir).some((name) => name.startsWith("spool-"))).toBe(true);
    const current = new DiagnosticsStore({
      stateDir,
      appVersion: "0.14.3",
      buildId: "bbbbbbb",
      process: "server",
    });
    const reader = openDiagnosticsReader(stateDir)!;
    expect(
      reader
        .prepare("SELECT COUNT(*) AS count FROM incidents WHERE code = 'DIAGNOSTICS_DROPPED'")
        .get(),
    ).toMatchObject({ count: 1 });
    reader.close();
    current.close();
  });

  it("bounds fresh schema creation before its first SQLite write", () => {
    const cap = 128 * 1024;
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "penkra-diagnostics-"));
    roots.push(stateDir);
    expect(
      () =>
        new DiagnosticsStore({
          stateDir,
          appVersion: "0.14.3",
          process: "server",
          maxTotalBytes: cap,
        }),
    ).toThrow();
    const dir = path.join(stateDir, "diagnostics");
    const bytes = fs.readdirSync(dir).reduce((sum, name) => {
      const file = path.join(dir, name);
      return sum + (fs.statSync(file).isFile() ? fs.statSync(file).size : 0);
    }, 0);
    expect(bytes).toBeLessThanOrEqual(cap);
  });
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
    current.checkpoint({ traceId, spanId, flow: "send", step: "server.received" });
    const afterOldClose = openDiagnosticsReader(stateDir)!;
    expect(afterOldClose.prepare("SELECT step FROM detail").all()).toEqual([
      { step: "server.received" },
    ]);
    afterOldClose.close();
    current.close();
  });
  it("preserves a current desktop spool when desktop starts before the server resets", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "penkra-diagnostics-"));
    roots.push(stateDir);
    const bundlePath = path.join(stateDir, "app.asar");
    fs.writeFileSync(bundlePath, "first bundle");
    const signature = () => {
      const stats = fs.statSync(bundlePath);
      return { size: stats.size, mtimeMs: stats.mtimeMs, inode: stats.ino };
    };
    const options = {
      stateDir,
      appVersion: "0.14.3",
      bundlePath,
      process: "server" as const,
    };
    const old = new DiagnosticsStore({
      ...options,
      buildId: "aaaaaaa",
      bundleSignature: signature(),
    });
    old.checkpoint({ traceId, spanId, flow: "send", step: "server.received" });
    old.close();
    const replacement = path.join(stateDir, "replacement.asar");
    fs.writeFileSync(replacement, "second bundle");
    fs.renameSync(replacement, bundlePath);
    const currentOptions = { ...options, buildId: "bbbbbbb", bundleSignature: signature() };
    const desktop = new DiagnosticsSpoolWriter({ ...currentOptions, process: "desktop-main" });
    desktop.checkpoint({ traceId, spanId, flow: "send", step: "composer.preflight" });
    const before = openDiagnosticsReader(stateDir)!;
    expect(before.prepare("SELECT count(*) AS count FROM detail").get()).toMatchObject({
      count: 1,
    });
    before.close();
    const server = new DiagnosticsStore(currentOptions);
    const after = openDiagnosticsReader(stateDir)!;
    expect(after.prepare("SELECT step FROM detail").all()).toEqual([
      { step: "composer.preflight" },
    ]);
    after.close();
    desktop.close();
    server.close();
  });
  it("persists stale spool and loss counts before an update reset", () => {
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
    new DiagnosticsStore(oldOptions).close();
    const replacement = path.join(stateDir, "replacement.asar");
    fs.writeFileSync(replacement, "second bundle");
    fs.renameSync(replacement, bundlePath);
    const stale = new DiagnosticsSpoolWriter({ ...oldOptions, process: "desktop-main" });
    stale.checkpoint({ traceId, spanId, flow: "send", step: "composer.preflight" });
    fs.writeFileSync(
      path.join(stateDir, "diagnostics", `loss-${stale.bootId}.bin`),
      JSON.stringify({
        count: 2,
        reason: "capacity",
        reasons: { capacity: 2, sqlite: 0, spool: 0, stale: 0 },
      }).padEnd(256, " "),
    );
    const currentOptions = { ...oldOptions, buildId: "bbbbbbb", bundleSignature: signature() };
    const current = new DiagnosticsStore(currentOptions);
    const db = openDiagnosticsReader(stateDir)!;
    expect(db.prepare("SELECT code, actual_json FROM incidents").get()).toMatchObject({
      code: "DIAGNOSTICS_DROPPED",
      actual_json: '{"count":3}',
    });
    db.close();
    current.close();
    const restarted = new DiagnosticsStore(currentOptions);
    const afterRestart = openDiagnosticsReader(stateDir)!;
    expect(
      afterRestart.prepare("SELECT code, actual_json, count FROM incidents").get(),
    ).toMatchObject({
      code: "DIAGNOSTICS_DROPPED",
      actual_json: '{"count":3}',
      count: 1,
    });
    afterRestart.close();
    restarted.close();
    stale.close();
  });
  it("recovers a reset loss manifest left by a crashed startup", () => {
    const { stateDir, store } = fixture();
    store.close();
    const manifestPath = path.join(stateDir, "diagnostics", "reset-loss.json");
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        bootId: "abcdabcdabcdabcdabcdabcdabcdabcd",
        spools: { deadbeefdeadbeefdeadbeefdeadbeef: 2 },
        ledgers: {},
      }),
    );
    const resumed = new DiagnosticsStore({ stateDir, appVersion: "0.14.3", process: "server" });
    expect(fs.existsSync(manifestPath)).toBe(false);
    const db = openDiagnosticsReader(stateDir)!;
    expect(db.prepare("SELECT code, actual_json FROM incidents").get()).toMatchObject({
      code: "DIAGNOSTICS_DROPPED",
      actual_json: '{"count":2}',
    });
    db.close();
    resumed.close();
    const restarted = new DiagnosticsStore({ stateDir, appVersion: "0.14.3", process: "server" });
    const afterRestart = openDiagnosticsReader(stateDir)!;
    expect(
      afterRestart.prepare("SELECT count(*) AS count FROM incident_occurrences").get(),
    ).toMatchObject({
      count: 1,
    });
    afterRestart.close();
    restarted.close();
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

  it("closes a swept deadline in the same transaction as its incident", () => {
    const { stateDir, store } = fixture();
    const id = store.armExpectation({ traceId, spanId, kind: "turn.started", deadlineMs: 1 });
    const afterDeadline = new Date(Date.now() + 100);
    expect(store.sweepExpectations(afterDeadline)).toBe(1);
    const db = openDiagnosticsReader(stateDir)!;
    expect(db.prepare("SELECT count(*) AS count FROM expectations").get()).toMatchObject({
      count: 0,
    });
    expect(db.prepare("SELECT context_json FROM incident_occurrences").get()).toMatchObject({
      context_json: JSON.stringify({ reason: "deadline", entityId: id }),
    });
    db.close();
    store.close();
    const resumed = new DiagnosticsStore({ stateDir, appVersion: "0.14.3", process: "server" });
    expect(resumed.sweepExpectations(afterDeadline)).toBe(0);
    const replayed = openDiagnosticsReader(stateDir)!;
    expect(
      replayed.prepare("SELECT count(*) AS count FROM incident_occurrences").get(),
    ).toMatchObject({
      count: 1,
    });
    replayed.close();
    resumed.close();
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
      expect(
        environment.osMajor === "unknown" ||
          (Number.isSafeInteger(environment.osMajor) && environment.osMajor > 0),
      ).toBe(true);
    }
    db.close();
    store.close();
  });

  it("caches a failed macOS product lookup as unknown", () => {
    const macProductVersion = vi.fn(() => {
      throw new Error("sw_vers unavailable");
    });
    const resolve = createDiagnosticOsResolver({
      platform: "darwin",
      release: () => "25.0.0",
      macProductVersion,
    });
    expect(resolve()).toEqual({ osFamily: "darwin", osMajor: "unknown" });
    expect(resolve()).toEqual({ osFamily: "darwin", osMajor: "unknown" });
    expect(macProductVersion).toHaveBeenCalledExactlyOnceWith(DIAGNOSTIC_LIMITS.osProbeMs);
    expect(resolve(15)).toEqual({ osFamily: "darwin", osMajor: 15 });
    expect(macProductVersion).toHaveBeenCalledTimes(1);
  });

  it("bounds a hanging OS subprocess and caches the timeout as unknown", () => {
    const macProductVersion = vi.fn((timeoutMs: number) =>
      execFileSync(process.execPath, ["-e", "setInterval(() => {}, 1_000)"], {
        timeout: timeoutMs,
      }).toString(),
    );
    const resolve = createDiagnosticOsResolver({
      platform: "darwin",
      release: () => "25.0.0",
      macProductVersion,
    });
    const started = performance.now();
    expect(resolve()).toEqual({ osFamily: "darwin", osMajor: "unknown" });
    expect(performance.now() - started).toBeLessThan(1_500);
    expect(resolve()).toEqual({ osFamily: "darwin", osMajor: "unknown" });
    expect(macProductVersion).toHaveBeenCalledExactlyOnceWith(DIAGNOSTIC_LIMITS.osProbeMs);
  });

  it("records an unavailable OS major as unknown", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "penkra-diagnostics-"));
    roots.push(stateDir);
    const store = new DiagnosticsStore({
      stateDir,
      appVersion: "0.14.3",
      process: "desktop-main",
      osMajor: "unknown",
    });
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
    expect(JSON.parse(row.env_json).osMajor).toBe("unknown");
    db.close();
    store.close();
  });

  it("preserves Electron's product major through a desktop spool import", () => {
    const { stateDir, store } = fixture();
    const desktop = new DiagnosticsSpoolWriter({
      stateDir,
      appVersion: "0.14.3",
      process: "desktop-main",
      osMajor: 15,
    });
    desktop.incident({
      traceId,
      spanId,
      kind: "command.failed",
      code: "COMMAND_REJECTED",
      where: "server.command",
      severity: "error",
    });
    store.importPeerSpools();
    const db = openDiagnosticsReader(stateDir)!;
    const row = db
      .prepare("SELECT env_json FROM incident_occurrences WHERE boot_id = ?")
      .get(desktop.bootId) as { env_json: string };
    expect(JSON.parse(row.env_json).osMajor).toBe(15);
    db.close();
    desktop.close();
    store.close();
  });

  it("rejects extra incident limit fields before writing the spool", () => {
    const { stateDir, store } = fixture();
    expect(() =>
      store.incident({
        traceId,
        spanId,
        kind: "command.failed",
        code: "COMMAND_REJECTED",
        where: "server.command",
        severity: "error",
        limit: {
          name: "turnStartedMs",
          value: 10_000,
          observed: 10_001,
          messageContent: "private message",
        } as never,
      }),
    ).toThrow("Invalid incident limit");
    expect(fs.existsSync(store.spoolPath)).toBe(false);
    const db = openDiagnosticsReader(stateDir)!;
    expect(db.prepare("SELECT count(*) AS count FROM incidents").get()).toMatchObject({ count: 0 });
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
      context_json: JSON.stringify({ reason: "late_resolution", entityId: id }),
    });
    expect(
      JSON.parse(
        (db.prepare("SELECT limit_json FROM incidents").get() as { limit_json: string }).limit_json,
      ),
    ).toMatchObject({ name: "turnStartedMs", value: 1 });
    expect(db.prepare("SELECT count(*) AS count FROM expectations").get()).toMatchObject({
      count: 0,
    });
    expect(db.prepare("SELECT count(*) AS count FROM incident_occurrences").get()).toMatchObject({
      count: 1,
    });
    db.close();
    store.close();
    const reopened = new DiagnosticsStore({ stateDir, process: "server", appVersion: "0.14.3" });
    expect(reopened.resolveExpectation(id)).toBe(false);
    const replayed = openDiagnosticsReader(stateDir)!;
    expect(
      replayed.prepare("SELECT count(*) AS count FROM incident_occurrences").get(),
    ).toMatchObject({
      count: 1,
    });
    replayed.close();
    reopened.close();
  });

  it("marks unresolved expectations unknown after a restart", () => {
    const { stateDir, store } = fixture();
    const id = store.armExpectation({
      traceId,
      spanId,
      kind: "turn.first_output",
      deadlineMs: 30_000,
    });
    store.close();
    const restarted = new DiagnosticsStore({ stateDir, appVersion: "0.14.3", process: "server" });
    const db = openDiagnosticsReader(stateDir)!;
    expect(db.prepare("SELECT code, context_json FROM incidents").get()).toMatchObject({
      code: "EXPECTATION_MISSED",
      context_json: JSON.stringify({ reason: "unknown", entityId: id }),
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

  it("does not leave a send arm recorded after server acceptance", async () => {
    const { stateDir, store } = fixture();
    const desktop = new DiagnosticsSpoolWriter({
      stateDir,
      appVersion: "0.14.3",
      process: "desktop-main",
    });
    store.checkpoint({ traceId, spanId, flow: "send", step: "command.accepted", outcome: "ok" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const armedAt = new Date().toISOString();
    desktop.armExpectation({
      traceId,
      spanId,
      kind: "send.accepted",
      deadlineMs: 2_000,
      armedAt,
    });
    store.importPeerSpools();
    const db = openDiagnosticsReader(stateDir)!;
    expect(db.prepare("SELECT count(*) AS count FROM expectations").get()).toMatchObject({
      count: 0,
    });
    expect(db.prepare("SELECT count(*) AS count FROM incident_occurrences").get()).toMatchObject({
      count: 0,
    });
    db.close();
    desktop.close();
    store.close();
  });

  it("keeps a send arm recorded before slow server acceptance", () => {
    const { stateDir, store } = fixture();
    const desktop = new DiagnosticsSpoolWriter({
      stateDir,
      appVersion: "0.14.3",
      process: "desktop-main",
    });
    const armedAt = new Date(Date.now() - 5_000).toISOString();
    desktop.armExpectation({ traceId, spanId, kind: "send.accepted", deadlineMs: 2_000, armedAt });
    store.checkpoint({ traceId, spanId, flow: "send", step: "command.accepted", outcome: "ok" });
    store.importPeerSpools();
    expect(store.sweepExpectations()).toBe(1);
    const db = openDiagnosticsReader(stateDir)!;
    expect(db.prepare("SELECT code FROM incidents").get()).toMatchObject({
      code: "SEND_PREFLIGHT_REJECTED",
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
    expect(db.prepare("SELECT code, actual_json FROM incidents").all()).toEqual([
      { code: "DIAGNOSTICS_DROPPED", actual_json: '{"count":1}' },
    ]);
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

  it("treats a running unpackaged build as authoritative even after a version decrease", () => {
    const { stateDir, store } = fixture("0.14.3");
    store.checkpoint({ traceId, spanId, flow: "send", step: "server.received" });
    store.close();
    const desktop = new DiagnosticsSpoolWriter({
      stateDir,
      appVersion: "0.14.2",
      process: "desktop-main",
    });
    desktop.checkpoint({ traceId, spanId, flow: "send", step: "composer.preflight" });
    const current = new DiagnosticsStore({ stateDir, appVersion: "0.14.2", process: "server" });
    const db = openDiagnosticsReader(stateDir)!;
    expect(db.prepare("SELECT step FROM detail").all()).toMatchObject([
      { step: "composer.preflight" },
    ]);
    expect(db.prepare("SELECT value FROM meta WHERE key = 'app_version'").get()).toMatchObject({
      value: "0.14.2",
    });
    db.close();
    desktop.close();
    current.close();
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
    ).toMatchObject({ count: 2 });
    expect(
      db
        .prepare(`SELECT context_json FROM incident_occurrences
          WHERE incident_id IN (SELECT id FROM incidents WHERE code = 'DIAGNOSTICS_DROPPED')`)
        .all()
        .map((row) => JSON.parse((row as { context_json: string }).context_json).reason)
        .toSorted(),
    ).toEqual(["invalid-record", "sequence-gap"]);
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

  it("bounds incident-index and WAL growth with SQLite's page limit", () => {
    expect(DIAGNOSTIC_LIMITS.totalBytes).toBe(1_073_741_824);
    const cap = 384 * 1024;
    const { stateDir, store } = fixture("0.14.3", cap);
    const dir = path.join(stateDir, "diagnostics");
    const diskBytes = () =>
      fs.readdirSync(dir).reduce((sum, name) => {
        const file = path.join(dir, name);
        return sum + (fs.statSync(file).isFile() ? fs.statSync(file).size : 0);
      }, 0);
    for (let i = 0; i < 200; i++) {
      try {
        store.incident({
          traceId,
          spanId,
          kind: "command.failed",
          code: "COMMAND_REJECTED",
          where: "server.command",
          severity: "error",
          actual: { sequence: i },
        });
      } catch (cause) {
        expect((cause as Error).message).toContain("capacity");
        break;
      }
      expect(diskBytes()).toBeLessThanOrEqual(cap);
    }
    expect(diskBytes()).toBeLessThanOrEqual(cap);
    const db = openDiagnosticsReader(stateDir)!;
    const occurrences = db.prepare("SELECT count(*) AS count FROM incident_occurrences").get() as {
      count: number;
    };
    expect(occurrences.count).toBeGreaterThan(0);
    db.close();
    store.close();
  }, 30_000);

  it("keeps every diagnostic write path within the injected total cap", () => {
    const cap = 384 * 1024;
    const { stateDir, store } = fixture("0.14.3", cap);
    const peer = new DiagnosticsSpoolWriter({
      stateDir,
      appVersion: "0.14.3",
      process: "desktop-main",
      maxTotalBytes: cap,
    });
    const dir = path.join(stateDir, "diagnostics");
    const diskBytes = () =>
      fs.readdirSync(dir).reduce((sum, name) => {
        const file = path.join(dir, name);
        return sum + (fs.statSync(file).isFile() ? fs.statSync(file).size : 0);
      }, 0);
    const withinCap = () => expect(diskBytes()).toBeLessThanOrEqual(cap);
    const actions = [
      (i: number) =>
        store.checkpoint({
          traceId,
          spanId,
          flow: "send",
          step: "server.received",
          fields: { sequence: i },
        }),
      (i: number) =>
        store.incident({
          traceId,
          spanId,
          kind: "command.failed",
          code: "COMMAND_REJECTED",
          where: "server.command",
          severity: "error",
          actual: { sequence: i },
        }),
      (i: number) =>
        store.armExpectation({
          traceId,
          spanId,
          kind: "send.accepted",
          deadlineMs: 30_000,
          correlation: { sequence: i },
        }),
      (i: number) => store.sampleHealth({ eventLoopLagMs: i }),
      (i: number) =>
        store.setProvenance({
          entityKind: "thread",
          entityId: `thread:${i}`,
          field: "thread.activeTurnId",
          traceId,
        }),
    ];
    try {
      peer.recordDrop("spool");
      store.importPeerSpools();
      const db = openDiagnosticsReader(stateDir)!;
      expect(
        db
          .prepare("SELECT value FROM meta WHERE key = ?")
          .get(`loss-reported:${peer.bootId}:spool`),
      ).toMatchObject({ value: "1" });
      db.close();
      withinCap();
      for (let i = 0; i < 20; i++) {
        actions[i % actions.length]!(i);
        withinCap();
      }
      store.prune(new Date(Date.now() + 61_000), 0);
      withinCap();
      let rejected = false;
      for (let i = 20; i < 800; i++) {
        try {
          actions[i % actions.length]!(i);
        } catch (cause) {
          expect((cause as Error).message).toContain("capacity");
          rejected = true;
          withinCap();
          break;
        }
        withinCap();
      }
      expect(rejected).toBe(true);
      for (const [index, action] of actions.entries()) {
        try {
          action(900 + index);
        } catch (cause) {
          expect((cause as Error).message).toContain("capacity");
        }
        withinCap();
      }
      store.prune(new Date(Date.now() + 2 * 86_400_000), 0);
      withinCap();
      peer.recordDrop("spool");
      store.importPeerSpools();
      withinCap();
    } finally {
      peer.close();
      store.close();
      withinCap();
    }
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
    expect(readLossLedger(ledger)).toMatchObject({
      count: 1,
      reason: "capacity",
    });
    store.importPeerSpools();
    const db = openDiagnosticsReader(stateDir)!;
    expect(
      db.prepare("SELECT code FROM incidents WHERE code = 'DIAGNOSTICS_CAP_REACHED'").get(),
    ).toMatchObject({ code: "DIAGNOSTICS_CAP_REACHED" });
    expect(
      db
        .prepare("SELECT value FROM meta WHERE key = ?")
        .get(`loss-reported:${peer.bootId}:capacity`),
    ).toMatchObject({ value: "1" });
    db.close();
    peer.close();
    store.close();
    const resumed = new DiagnosticsStore({ stateDir, appVersion: "0.14.3", process: "server" });
    const afterRestart = openDiagnosticsReader(stateDir)!;
    expect(
      afterRestart
        .prepare(
          "SELECT count(*) AS count FROM incident_occurrences WHERE incident_id IN (SELECT id FROM incidents WHERE code = 'DIAGNOSTICS_CAP_REACHED')",
        )
        .get(),
    ).toMatchObject({ count: 1 });
    afterRestart.close();
    resumed.close();
  });

  it("recovers the prior loss count after a torn ledger slot rewrite", () => {
    const { stateDir, store } = fixture();
    const peer = new DiagnosticsSpoolWriter({
      stateDir,
      appVersion: "0.14.3",
      process: "desktop-main",
    });
    peer.recordDrop("spool");
    peer.recordDrop("capacity");
    const ledger = path.join(stateDir, "diagnostics", `loss-${peer.bootId}.bin`);
    expect(fs.statSync(ledger).size).toBe(512);
    expect(readLossLedger(ledger)).toMatchObject({
      count: 2,
      reasons: { spool: 1, capacity: 1 },
    });
    const handle = fs.openSync(ledger, "r+");
    try {
      fs.writeSync(handle, Buffer.alloc(32), 0, 32, 0);
      fs.fsyncSync(handle);
    } finally {
      fs.closeSync(handle);
    }
    expect(readLossLedger(ledger)).toMatchObject({
      count: 1,
      reasons: { spool: 1, capacity: 0 },
    });
    peer.recordDrop("capacity");
    expect(readLossLedger(ledger)).toMatchObject({
      count: 2,
      reasons: { spool: 1, capacity: 1 },
    });
    peer.close();
    store.close();
  });

  it("reports a loss once after a fault between its occurrence and receipt", () => {
    const { stateDir, store } = fixture();
    const peer = new DiagnosticsSpoolWriter({
      stateDir,
      appVersion: "0.14.3",
      process: "desktop-main",
    });
    peer.recordDrop("spool");
    const db = new DatabaseSync(path.join(stateDir, "diagnostics", "diagnostics.sqlite"));
    db.exec(`CREATE TRIGGER fail_loss_receipt BEFORE INSERT ON meta
      WHEN NEW.key LIKE 'loss-reported:%'
      BEGIN SELECT RAISE(ABORT, 'fault-before-loss-receipt'); END`);
    store.importPeerSpools();
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM incident_occurrences WHERE incident_id IN (SELECT id FROM incidents WHERE code = 'DIAGNOSTICS_WRITE_FAILED')",
        )
        .get(),
    ).toMatchObject({ count: 0 });
    db.exec("DROP TRIGGER fail_loss_receipt");
    store.importPeerSpools();
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM incident_occurrences WHERE incident_id IN (SELECT id FROM incidents WHERE code = 'DIAGNOSTICS_WRITE_FAILED')",
        )
        .get(),
    ).toMatchObject({ count: 1 });
    expect(
      db.prepare("SELECT value FROM meta WHERE key = ?").get(`loss-reported:${peer.bootId}:spool`),
    ).toMatchObject({ value: "1" });
    db.close();
    peer.close();
    store.close();
    const restarted = new DiagnosticsStore({ stateDir, appVersion: "0.14.3", process: "server" });
    const afterRestart = openDiagnosticsReader(stateDir)!;
    expect(
      afterRestart
        .prepare(
          "SELECT COUNT(*) AS count FROM incident_occurrences WHERE incident_id IN (SELECT id FROM incidents WHERE code = 'DIAGNOSTICS_WRITE_FAILED')",
        )
        .get(),
    ).toMatchObject({ count: 1 });
    afterRestart.close();
    restarted.close();
  });

  it("refuses spool startup before marker files exceed the total cap", () => {
    const { stateDir, store } = fixture();
    const dir = path.join(stateDir, "diagnostics");
    const diskBytes = () =>
      fs.readdirSync(dir).reduce((sum, name) => {
        const file = path.join(dir, name);
        return sum + (fs.statSync(file).isFile() ? fs.statSync(file).size : 0);
      }, 0);
    const cap = diskBytes() + 128;
    expect(
      () =>
        new DiagnosticsSpoolWriter({
          stateDir,
          appVersion: "0.14.3",
          process: "desktop-main",
          maxTotalBytes: cap,
        }),
    ).toThrow("capacity");
    expect(diskBytes()).toBeLessThanOrEqual(cap);
    expect(fs.readdirSync(dir).filter((name) => name.startsWith("spool-identity-"))).toEqual([]);
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
    const cap = 384 * 1024;
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
    expect(readLossLedger(path.join(dir, `loss-${store.bootId}.bin`))).toMatchObject({ count: 1 });
    store.close();
  });
});
