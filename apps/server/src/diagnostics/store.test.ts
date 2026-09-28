import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { DiagnosticsStore, openDiagnosticsReader } from "./store";

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
    store.incident(failure);
    const db = openDiagnosticsReader(stateDir)!;
    expect(db.prepare("SELECT count FROM incidents").get()).toMatchObject({ count: 2 });
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

  it("keeps writes inside an injected cap", () => {
    const cap = 320 * 1024;
    const { stateDir, store } = fixture("0.14.3", cap);
    const dir = path.join(stateDir, "diagnostics");
    const diskBytes = () =>
      fs.readdirSync(dir).reduce((sum, name) => {
        const file = path.join(dir, name);
        return sum + (fs.statSync(file).isFile() ? fs.statSync(file).size : 0);
      }, 0);
    expect(diskBytes()).toBeLessThan(cap);
    let blocked = false;
    for (let i = 0; i < 1_000; i++) {
      try {
        store.checkpoint({
          traceId,
          spanId,
          flow: "send",
          step: "server.received",
          fields: { sequence: i },
        });
      } catch (cause) {
        expect((cause as Error).message).toContain("capacity");
        blocked = true;
        break;
      }
    }
    const db = openDiagnosticsReader(stateDir)!;
    const row = db.prepare("SELECT count(*) AS count FROM detail").get() as { count: number };
    expect(blocked || row.count < 1_000).toBe(true);
    expect(diskBytes()).toBeLessThanOrEqual(cap);
    db.close();
    store.close();
  });
});
