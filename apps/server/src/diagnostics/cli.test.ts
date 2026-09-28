import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { queryDiagnostics } from "./cli";
import { DiagnosticsStore } from "./store";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("penkra diagnostics reads", () => {
  it("pages incidents and reads a joined thread and trace timeline", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "penkra-diagnostics-cli-"));
    roots.push(home);
    const store = new DiagnosticsStore({
      stateDir: path.join(home, "userdata"),
      appVersion: "0.14.3",
      process: "server",
    });
    const traceId = "0123456789abcdef0123456789abcdef";
    const spanId = "0123456789abcdef";
    const threadId = "thread:cli-test";
    store.sampleHealth({ eventLoopLagMs: 7 });
    store.setProvenance({
      entityKind: "thread",
      entityId: threadId,
      field: "thread.activeTurnId",
      traceId,
    });
    store.checkpoint({ traceId, spanId, threadId, flow: "send", step: "server.received" });
    store.incident({
      traceId,
      spanId,
      threadId,
      kind: "command.failed",
      code: "COMMAND_REJECTED",
      where: "server.command",
      severity: "error",
    });
    store.incident({
      traceId,
      spanId,
      threadId,
      kind: "external.failed",
      code: "PROVIDER_CALL_FAILED",
      where: "server.provider",
      severity: "error",
    });
    const first = queryDiagnostics(["incidents", "--home-dir", home, "--limit", "1"]) as {
      items: unknown[];
      pageInfo: { nextCursor: string };
    };
    expect(first.items).toHaveLength(1);
    expect(first.pageInfo.nextCursor).toBeTypeOf("string");
    const second = queryDiagnostics([
      "incidents",
      "--home-dir",
      home,
      "--limit",
      "1",
      "--cursor",
      first.pageInfo.nextCursor,
    ]) as { items: unknown[]; pageInfo: { nextCursor: string | null } };
    expect(second.items).toHaveLength(1);
    expect(second.pageInfo.nextCursor).toBeNull();
    const thread = queryDiagnostics(["thread", threadId, "--home-dir", home]) as {
      incidents: unknown[];
      detail: unknown[];
      provenance: unknown[];
    };
    expect(thread.incidents).toHaveLength(2);
    expect(thread.detail).toHaveLength(1);
    expect(thread.provenance).toMatchObject([{ entityKind: "thread", setByTraceId: traceId }]);
    expect(thread.incidents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ health: expect.objectContaining({ eventLoopLagMs: 7 }) }),
      ]),
    );
    const trace = queryDiagnostics(["trace", traceId, "--home-dir", home]) as {
      incidents: unknown[];
      detail: unknown[];
    };
    expect(trace.incidents).toHaveLength(2);
    expect(trace.detail).toHaveLength(1);
    store.close();
  });

  it("exports only stored allowlisted fields to a private local file", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "penkra-diagnostics-export-"));
    roots.push(home);
    const store = new DiagnosticsStore({
      stateDir: path.join(home, "userdata"),
      appVersion: "0.14.3",
      process: "server",
    });
    store.checkpoint({
      traceId: "0123456789abcdef0123456789abcdef",
      spanId: "0123456789abcdef",
      flow: "send",
      step: "server.received",
      fields: { queueDepth: 1 },
    });
    store.incident({
      traceId: "0123456789abcdef0123456789abcdef",
      spanId: "0123456789abcdef",
      kind: "command.failed",
      code: "COMMAND_REJECTED",
      where: "server.command",
      severity: "error",
    });
    const output = path.join(home, "export.json");
    expect(queryDiagnostics(["export", "--home-dir", home, "--output", output])).toMatchObject({
      detail: 1,
    });
    const text = fs.readFileSync(output, "utf8");
    expect(text).toContain("queueDepth");
    expect(text).not.toContain("messageContent");
    if (process.platform !== "win32") expect(fs.statSync(output).mode & 0o077).toBe(0);
    store.close();
    const db = new DatabaseSync(path.join(home, "userdata", "diagnostics", "diagnostics.sqlite"));
    db.prepare("UPDATE detail SET payload_json = ?").run('{"message":"secret"}');
    db.close();
    expect(() => queryDiagnostics(["export", "--home-dir", home])).toThrow("not allowlisted");
    const secondDb = new DatabaseSync(
      path.join(home, "userdata", "diagnostics", "diagnostics.sqlite"),
    );
    secondDb.prepare("UPDATE detail SET payload_json = '{}'").run();
    secondDb.prepare("UPDATE incident_occurrences SET health_json = ?").run('{"message":"secret"}');
    secondDb.close();
    expect(() => queryDiagnostics(["export", "--home-dir", home])).toThrow("not allowlisted");
    const thirdDb = new DatabaseSync(
      path.join(home, "userdata", "diagnostics", "diagnostics.sqlite"),
    );
    thirdDb.prepare("UPDATE incident_occurrences SET health_json = '{}'").run();
    thirdDb.prepare("UPDATE incidents SET summary = ?").run("private content");
    thirdDb.close();
    expect(JSON.stringify(queryDiagnostics(["export", "--home-dir", home]))).not.toContain(
      "private content",
    );
  });
});
