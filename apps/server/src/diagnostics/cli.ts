import * as fs from "node:fs";
import * as path from "node:path";
import { resolvePenkraHomeDirectory } from "@penkra/shared/penkraHome";

import { openDiagnosticsReader } from "./store";
import { INCIDENT_SUMMARIES, isIncidentCode, type IncidentCode } from "./codes";
import { validateDiagnosticFields, validateDiagnosticId, validateDiagnosticToken } from "./privacy";

type Row = Record<string, unknown>;
type Flags = Record<string, string>;

function parseArgs(args: string[]): { command: string; positional: string[]; flags: Flags } {
  const [command = "", ...rest] = args;
  const flags: Flags = {};
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const key = arg.slice(2);
    if (
      ![
        "home-dir",
        "state-dir",
        "thread",
        "since",
        "kind",
        "code",
        "limit",
        "cursor",
        "output",
      ].includes(key)
    ) {
      throw new Error(`Unknown diagnostics flag --${key}`);
    }
    if (flags[key] !== undefined) throw new Error(`Duplicate diagnostics flag --${key}`);
    const value = rest[++i];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for --${key}`);
    flags[key] = value;
  }
  return { command, positional, flags };
}

function stateDir(flags: Flags): string {
  if (flags["state-dir"]) return path.resolve(flags["state-dir"]);
  const base = resolvePenkraHomeDirectory({
    configuredHome: flags["home-dir"] ?? process.env.PENKRA_HOME,
  });
  return path.join(path.resolve(base), process.env.VITE_DEV_SERVER_URL ? "dev" : "userdata");
}

function isoSince(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) throw new Error("Invalid --since timestamp");
  return date.toISOString();
}

function pageLimit(raw: string | undefined): number {
  if (raw === undefined) return 100;
  const limit = Number(raw);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    throw new Error("--limit must be between 1 and 500");
  }
  return limit;
}

function readCursor(raw: string | undefined): { lastAt: string; id: string } | null {
  if (!raw) return null;
  let parsed: { lastAt: string; id: string };
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as typeof parsed;
  } catch {
    throw new Error("Invalid diagnostics cursor");
  }
  if (
    typeof parsed.lastAt !== "string" ||
    Number.isNaN(Date.parse(parsed.lastAt)) ||
    typeof parsed.id !== "string"
  ) {
    throw new Error("Invalid diagnostics cursor");
  }
  validateDiagnosticId(parsed.id);
  return parsed;
}

function safeTimestamp(value: unknown): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new TypeError("Invalid diagnostics timestamp");
  }
  return new Date(value).toISOString();
}

function safeJson(key: string, value: unknown): unknown {
  if (typeof value !== "string") throw new TypeError("Invalid diagnostics JSON");
  const parsed = JSON.parse(value) as unknown;
  if (key === "provenance_json") {
    if (!Array.isArray(parsed)) throw new TypeError("Invalid diagnostics provenance");
    return parsed.map((item) =>
      validateDiagnosticFields(item as Record<string, string | number | boolean | null>),
    );
  }
  if (key === "env_json") {
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new TypeError("Invalid diagnostics environment");
    const env = parsed as Record<string, unknown>;
    if (
      Object.keys(env).sort().join(",") !==
        "appVersion,bootId,buildId,channel,osFamily,osMajor,process" ||
      typeof env.appVersion !== "string" ||
      !/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/u.test(env.appVersion) ||
      typeof env.buildId !== "string" ||
      /^0{7,64}$/u.test(env.buildId) ||
      (env.buildId !== "unknown" && !/^[a-f0-9]{7,64}$/u.test(env.buildId)) ||
      !["production", "dev", "test"].includes(env.channel as string) ||
      !["darwin", "windows", "linux"].includes(env.osFamily as string) ||
      (env.osMajor !== "unknown" &&
        (!Number.isSafeInteger(env.osMajor) || (env.osMajor as number) < 0))
    ) {
      throw new TypeError("Invalid diagnostics environment");
    }
    return {
      appVersion: env.appVersion,
      buildId: env.buildId,
      channel: env.channel,
      bootId: validateDiagnosticId(env.bootId as string),
      osFamily: env.osFamily,
      osMajor: env.osMajor,
      ...validateDiagnosticFields({ process: env.process as string }),
    };
  }
  return validateDiagnosticFields(parsed as Record<string, string | number | boolean | null>);
}

function jsonFields(row: Row): Row {
  const result: Row = {};
  const jsonKeys = new Set([
    "correlation_json",
    "payload_json",
    "expected_json",
    "actual_json",
    "limit_json",
    "context_json",
    "provenance_json",
    "health_json",
    "env_json",
  ]);
  const idKeys = new Set([
    "boot_id",
    "trace_id",
    "span_id",
    "parent_span_id",
    "attempt_id",
    "thread_id",
    "turn_id",
    "command_id",
    "incident_id",
  ]);
  const timeKeys = new Set(["at", "first_at", "last_at", "pin_from", "pin_until", "pinned_until"]);
  const numberKeys = new Set(["id", "sequence", "mono_ms", "count"]);
  const enumKeys: Readonly<Record<string, "flow" | "step" | "eventType" | "kind" | "where">> = {
    flow: "flow",
    step: "step",
    event_type: "eventType",
    kind: "kind",
    where_name: "where",
    last_checkpoint: "step",
  };
  for (const [key, value] of Object.entries(row)) {
    if (
      !jsonKeys.has(key) &&
      !idKeys.has(key) &&
      !timeKeys.has(key) &&
      !numberKeys.has(key) &&
      !enumKeys[key] &&
      !["code", "severity", "fingerprint", "summary"].includes(key)
    ) {
      throw new TypeError(`Unrecognized diagnostics column ${key}`);
    }
    if (value === null) {
      result[key] = null;
      continue;
    }
    if (jsonKeys.has(key)) {
      result[key.slice(0, -5)] = safeJson(key, value);
    } else if (idKeys.has(key) || (key === "id" && typeof value === "string")) {
      result[key] = validateDiagnosticId(value as string);
    } else if (timeKeys.has(key)) {
      result[key] = safeTimestamp(value);
    } else if (numberKeys.has(key)) {
      if (typeof value !== "number" || !Number.isFinite(value))
        throw new TypeError("Invalid diagnostics number");
      result[key] = value;
    } else if (enumKeys[key]) {
      result[key] = validateDiagnosticToken(value as string, enumKeys[key]);
    } else if (key === "code") {
      if (typeof value !== "string" || !isIncidentCode(value))
        throw new TypeError("Invalid incident code");
      result[key] = value;
    } else if (key === "severity") {
      if (value !== "error" && value !== "warn") throw new TypeError("Invalid incident severity");
      result[key] = value;
    }
  }
  if ("code" in result) {
    if (row.summary !== INCIDENT_SUMMARIES[result.code as IncidentCode])
      throw new TypeError("Invalid diagnostics summary");
    result.summary = row.summary;
  }
  return result;
}

function provenanceRow(row: Row): Row {
  return validateDiagnosticFields({
    entityKind: row.entity_kind as string,
    entityId: row.entity_id as string,
    field: row.field as string,
    setByTraceId: row.set_by_trace_id as string,
    setAt: row.set_at as string,
  });
}

export function queryDiagnostics(args: string[]): unknown {
  const { command, positional, flags } = parseArgs(args);
  if (command === "help" || command === "--help" || command === "") {
    return { usage: "penkra diagnostics <incidents|thread|trace|export> [options]" };
  }
  if (!["incidents", "thread", "trace", "export"].includes(command)) {
    throw new Error(`Unknown diagnostics command ${command}`);
  }
  const database = openDiagnosticsReader(stateDir(flags));
  if (!database) return { items: [], pageInfo: { nextCursor: null } };
  try {
    if (command === "incidents") {
      if (positional.length) throw new Error("incidents takes no positional arguments");
      const where: string[] = [];
      const params: (string | number)[] = [];
      if (flags.thread) {
        where.push("o.thread_id = ?");
        params.push(validateDiagnosticId(flags.thread));
      }
      if (flags.kind) {
        where.push("i.kind = ?");
        params.push(validateDiagnosticToken(flags.kind));
      }
      if (flags.code) {
        where.push("i.code = ?");
        params.push(validateDiagnosticToken(flags.code));
      }
      const since = isoSince(flags.since);
      if (since) {
        where.push("o.at >= ?");
        params.push(since);
      }
      const cursor = readCursor(flags.cursor);
      if (cursor) {
        where.push("(o.at < ? OR (o.at = ? AND o.id < ?))");
        params.push(cursor.lastAt, cursor.lastAt, cursor.id);
      }
      const limit = pageLimit(flags.limit);
      const rows = database
        .prepare(
          `SELECT o.*, i.fingerprint, i.kind, i.code, i.severity, i.where_name,
          i.summary, i.count, i.first_at, i.last_at
          FROM incident_occurrences o JOIN incidents i ON i.id = o.incident_id
          ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
          ORDER BY o.at DESC, o.id DESC LIMIT ?`,
        )
        .all(...params, limit + 1) as Row[];
      const items = rows.slice(0, limit).map(jsonFields);
      const last = items.at(-1);
      return {
        items,
        pageInfo: {
          nextCursor:
            rows.length > limit && last
              ? Buffer.from(JSON.stringify({ lastAt: last.at, id: last.id })).toString("base64url")
              : null,
        },
      };
    }
    if (command === "thread" || command === "trace") {
      if (positional.length !== 1) throw new Error(`${command} requires exactly one identifier`);
      const id = validateDiagnosticId(positional[0]!);
      const key = command === "thread" ? "thread_id" : "trace_id";
      const incidents = database
        .prepare(`SELECT o.*, i.fingerprint, i.kind, i.code, i.severity, i.where_name,
          i.summary, i.count, i.first_at, i.last_at FROM incident_occurrences o
          JOIN incidents i ON i.id = o.incident_id WHERE o.${key} = ? ORDER BY o.at`)
        .all(id) as Row[];
      const detail = database
        .prepare(`SELECT * FROM detail WHERE ${key} = ? ORDER BY at, id`)
        .all(id) as Row[];
      const provenance =
        command === "thread"
          ? (database
              .prepare("SELECT * FROM provenance WHERE entity_id = ? ORDER BY set_at")
              .all(id) as Row[])
          : (database
              .prepare("SELECT * FROM provenance WHERE set_by_trace_id = ? ORDER BY set_at")
              .all(id) as Row[]);
      const timeline = [
        ...incidents.map((row) => ({ type: "incident", at: row.at as string, ...jsonFields(row) })),
        ...detail.map((row) => ({ type: "detail", at: row.at as string, ...jsonFields(row) })),
        ...provenance.map((row) => ({
          type: "provenance",
          at: row.set_at as string,
          ...provenanceRow(row),
        })),
      ].sort((a, b) => a.at.localeCompare(b.at));
      return {
        timeline,
        incidents: incidents.map(jsonFields),
        detail: detail.map(jsonFields),
        provenance: provenance.map(provenanceRow),
      };
    }
    if (command === "export") {
      if (positional.length) throw new Error("export takes no positional arguments");
      const since = isoSince(flags.since);
      const thread = flags.thread ? validateDiagnosticId(flags.thread) : undefined;
      const where: string[] = [];
      const params: string[] = [];
      if (thread) {
        where.push("o.thread_id = ?");
        params.push(thread);
      }
      if (since) {
        where.push("o.at >= ?");
        params.push(since);
      }
      const incidents = database
        .prepare(
          `SELECT o.*, i.fingerprint, i.kind, i.code, i.severity, i.where_name,
          i.summary, i.count, i.first_at, i.last_at FROM incident_occurrences o
          JOIN incidents i ON i.id = o.incident_id
          ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY o.at`,
        )
        .all(...params) as Row[];
      const detailWhere: string[] = [];
      const detailParams: string[] = [];
      if (thread) {
        detailWhere.push("thread_id = ?");
        detailParams.push(thread);
      }
      if (since) {
        detailWhere.push("at >= ?");
        detailParams.push(since);
      }
      const detail = database
        .prepare(
          `SELECT * FROM detail ${detailWhere.length ? `WHERE ${detailWhere.join(" AND ")}` : ""} ORDER BY at`,
        )
        .all(...detailParams) as Row[];
      const result = {
        schemaVersion: 1,
        incidents: incidents.map(jsonFields),
        detail: detail.map(jsonFields),
      };
      if (flags.output) {
        fs.writeFileSync(path.resolve(flags.output), `${JSON.stringify(result, null, 2)}\n`, {
          flag: "wx",
          mode: 0o600,
        });
        return {
          output: path.resolve(flags.output),
          incidents: incidents.length,
          detail: detail.length,
        };
      }
      return result;
    }
    throw new Error(`Unknown diagnostics command ${command}`);
  } finally {
    database.close();
  }
}

export function runDiagnosticsCli(args: string[]): void {
  process.stdout.write(`${JSON.stringify(queryDiagnostics(args), null, 2)}\n`);
}
