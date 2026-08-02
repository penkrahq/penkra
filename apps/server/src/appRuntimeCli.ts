// FILE: appRuntimeCli.ts
// Purpose: Implements dynamic App-root commands against the authenticated desktop bridge.
// Layer: CLI adapter

import * as Crypto from "node:crypto";
import * as Net from "node:net";

const PIPE_ENV = "PENKRA_APP_COMMAND_PIPE";
const TOKEN_ENV = "PENKRA_APP_COMMAND_TOKEN";
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const TIMEOUT_MS = 30_000;

interface BridgeResponse {
  ok: boolean;
  result?: unknown;
  error?: string;
}

interface CatalogEntry {
  slug: string;
  operations: ReadonlyArray<{ key: string; input: Readonly<Record<string, unknown>> }>;
}

export async function maybeRunAppRuntimeCli(
  args: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  if (!env[PIPE_ENV] || !env[TOKEN_ENV] || args.length === 0) return false;
  if (args[0] === "tabs") {
    const action = args[1];
    if ((action !== "current" && action !== "list") || args.length !== 2) {
      throw new Error("Usage: penkra tabs current | penkra tabs list");
    }
    writeJson(await request(`tabs.${action}`, undefined, env));
    return true;
  }
  if (args[0] === "app" || args[0]?.startsWith("-")) return false;

  const parsed = parseFlags(args);
  const catalog = (await request(
    "catalog.list",
    parsed.tabId ? { tabId: parsed.tabId } : undefined,
    env,
  )) as CatalogEntry[];
  const app = catalog.find((candidate) => candidate.slug === parsed.positionals[0]);
  if (!app) return false;

  const operationWords = parsed.positionals.slice(1);
  if (parsed.help || operationWords.length === 0) {
    const operation =
      operationWords.length === 0 ? undefined : resolveOperation(app, operationWords);
    const result = await request(
      "catalog.help",
      {
        slug: app.slug,
        ...(operation === undefined ? {} : { operation }),
        ...(parsed.tabId === undefined ? {} : { tabId: parsed.tabId }),
      },
      env,
    );
    process.stdout.write(String(result));
    return true;
  }

  const operation = resolveOperation(app, operationWords);
  const declaration = app.operations.find((candidate) => candidate.key === operation)!;
  const input = parseOperationInput(declaration.input, parsed.input, parsed.named);
  const result = await request(
    "operations.invoke",
    {
      app: app.slug,
      operation,
      input,
      ...(parsed.tabId === undefined ? {} : { tabId: parsed.tabId }),
    },
    env,
  );
  writeJson({ app: app.slug, operation, tabId: parsed.tabId ?? null, result });
  return true;
}

function parseFlags(args: ReadonlyArray<string>): {
  positionals: string[];
  help: boolean;
  input?: string;
  tabId?: string;
  named: Record<string, string>;
} {
  const positionals: string[] = [];
  let help = false;
  let input: string | undefined;
  let tabId: string | undefined;
  const named: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]!;
    if (value === "--help" || value === "-h") {
      help = true;
      continue;
    }
    if (value === "--input" || value === "--tab-id") {
      const next = args[index + 1];
      if (!next) throw new Error(`${value} requires a value.`);
      if (value === "--input") input = next;
      else tabId = next;
      index += 1;
      continue;
    }
    if (value.startsWith("--input=")) {
      input = value.slice("--input=".length);
      continue;
    }
    if (value.startsWith("--tab-id=")) {
      tabId = value.slice("--tab-id=".length);
      continue;
    }
    if (value.startsWith("--")) {
      const equals = value.indexOf("=");
      const name = value.slice(2, equals < 0 ? undefined : equals);
      const next = equals < 0 ? args[index + 1] : value.slice(equals + 1);
      if (!name || !next || (equals < 0 && next.startsWith("--"))) {
        throw new Error(`${value} requires a value.`);
      }
      named[name] = next;
      if (equals < 0) index += 1;
      continue;
    }
    if (value.startsWith("-")) throw new Error(`Unknown App command option ${value}.`);
    positionals.push(value);
  }
  return {
    positionals,
    help,
    named,
    ...(input === undefined ? {} : { input }),
    ...(tabId === undefined ? {} : { tabId }),
  };
}

function resolveOperation(app: CatalogEntry, words: ReadonlyArray<string>): string {
  const key = words.join(".");
  if (!app.operations.some((candidate) => candidate.key === key)) {
    throw new Error(
      `${app.slug} does not declare operation ${key}. Run penkra ${app.slug} --help.`,
    );
  }
  return key;
}

function parseInput(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error("--input must be valid JSON.", { cause: error });
  }
}

export function parseOperationInput(
  schema: Readonly<Record<string, unknown>>,
  rawInput: string | undefined,
  named: Readonly<Record<string, string>>,
): unknown {
  const base = rawInput === undefined ? {} : parseInput(rawInput);
  if (!base || typeof base !== "object" || Array.isArray(base)) {
    if (Object.keys(named).length > 0)
      throw new Error("Named operation flags require an object input schema.");
    return base;
  }
  const properties = schema.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) {
    if (Object.keys(named).length > 0)
      throw new Error("This operation does not declare named input properties.");
    return base;
  }
  const result = { ...(base as Record<string, unknown>) };
  for (const [name, raw] of Object.entries(named)) {
    const declaration = (properties as Record<string, unknown>)[name];
    if (!declaration || typeof declaration !== "object" || Array.isArray(declaration)) {
      throw new Error(`Unknown operation option --${name}.`);
    }
    if (Object.hasOwn(result, name))
      throw new Error(`${name} was supplied by both --input and --${name}.`);
    const type = (declaration as Record<string, unknown>).type;
    if (type === "boolean") {
      if (raw !== "true" && raw !== "false") throw new Error(`--${name} must be true or false.`);
      result[name] = raw === "true";
    } else if (type === "number" || type === "integer") {
      const value = Number(raw);
      if (!Number.isFinite(value) || (type === "integer" && !Number.isInteger(value))) {
        throw new Error(`--${name} must be a${type === "integer" ? "n integer" : " number"}.`);
      }
      result[name] = value;
    } else if (type === "object" || type === "array") {
      result[name] = parseInput(raw);
    } else {
      result[name] = raw;
    }
  }
  return result;
}

async function request(method: string, params: unknown, env: NodeJS.ProcessEnv): Promise<unknown> {
  const path = env[PIPE_ENV];
  const token = env[TOKEN_ENV];
  if (!path || !token)
    throw new Error("App commands are available only inside a running Penkra environment.");
  const id = Crypto.randomUUID();
  const response = await new Promise<BridgeResponse>((resolve, reject) => {
    const socket = Net.createConnection(path);
    let bytes = Buffer.alloc(0);
    const timer = setTimeout(() => socket.destroy(new Error("App command timed out.")), TIMEOUT_MS);
    socket.once("connect", () => {
      socket.write(
        `${JSON.stringify({ id, token, method, ...(params === undefined ? {} : { params }) })}\n`,
      );
    });
    socket.on("data", (chunk) => {
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length > MAX_RESPONSE_BYTES) {
        socket.destroy(new Error("App command response exceeded the size limit."));
        return;
      }
      const newline = bytes.indexOf(10);
      if (newline < 0) return;
      clearTimeout(timer);
      socket.destroy();
      try {
        resolve(JSON.parse(bytes.subarray(0, newline).toString("utf8")) as BridgeResponse);
      } catch (error) {
        reject(new Error("Desktop returned an invalid App command response.", { cause: error }));
      }
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  if (!response.ok) throw new Error(response.error ?? "App command failed.");
  return response.result;
}

export function requestAppRuntimeBridge(
  method: string,
  params?: unknown,
  env: NodeJS.ProcessEnv = process.env,
): Promise<unknown> {
  return request(method, params, env);
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
