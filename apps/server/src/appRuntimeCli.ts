// FILE: appRuntimeCli.ts
// Purpose: Implements the agent-only registered-command gateway to the authenticated desktop bridge.
// Layer: Agent gateway adapter

import * as Crypto from "node:crypto";
import * as Net from "node:net";
import * as Path from "node:path";

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

export interface PenkraExecContext {
  spaceId: string;
  threadId: string;
  workingDirectory?: string | null;
}

/** Executes exactly one registered Penkra/App command without invoking a shell or consulting PATH. */
export async function executePenkraExec(
  command: string,
  context: PenkraExecContext,
  env: NodeJS.ProcessEnv = process.env,
  bridgeRequest: (
    method: string,
    params: unknown,
    env: NodeJS.ProcessEnv,
  ) => Promise<unknown> = request,
): Promise<unknown> {
  const args = tokenizeRegisteredCommand(command);
  if (args.length === 0) throw new Error("command must not be empty.");
  const scope = {
    spaceId: requireContextText(context.spaceId, "spaceId"),
    threadId: requireContextText(context.threadId, "threadId"),
  };
  if (args[0] === "penkra") {
    if (args.length === 2 && args[1] === "--help") {
      return coreHelp((await bridgeRequest("catalog.list", scope, env)) as CatalogEntry[]);
    }
    if (args.length === 3 && args[1] === "apps" && args[2] === "list") {
      return {
        spaceId: scope.spaceId,
        apps: summarizeCatalog((await bridgeRequest("catalog.list", scope, env)) as CatalogEntry[]),
      };
    }
    if (args.length === 3 && args[1] === "apps" && args[2] === "--help") {
      return {
        command: "penkra apps list",
        description: "List enabled Apps and their operation keys in the caller Thread's Space.",
      };
    }
    if (args.length === 3 && args[1] === "tabs" && args[2] === "--help") {
      return {
        commands: ["penkra tabs current", "penkra tabs list"],
        description: "Inspect the current or open App tabs for the caller Thread.",
      };
    }
    if (args.length === 3 && args[1] === "open" && args[2] === "--help") {
      return {
        usage: "penkra open --path <path> | --url <url> [--with <app-slug>]",
        description: "Open a local path or URL through an enabled App or the operating system.",
      };
    }
    if (args.length === 3 && args[1] === "tabs" && (args[2] === "current" || args[2] === "list")) {
      return bridgeRequest(`tabs.${args[2]}`, undefined, env);
    }
    if (args[1] === "open") {
      const parsed = parseFlags(args.slice(2));
      if (parsed.positionals.length > 0 || parsed.help || parsed.input || parsed.tabId) {
        throw new Error("Usage: penkra open --path <path> | --url <url> [--with <app-slug>]");
      }
      const allowed = new Set(["path", "url", "with"]);
      for (const key of Object.keys(parsed.named)) {
        if (!allowed.has(key)) throw new Error(`Unknown penkra open option --${key}.`);
      }
      const rawPath = parsed.named.path;
      const url = parsed.named.url;
      if ((rawPath === undefined) === (url === undefined)) {
        throw new Error("Supply exactly one of --path or --url.");
      }
      let path = rawPath;
      if (path && !Path.isAbsolute(path)) {
        if (!context.workingDirectory) {
          throw new Error("A relative path requires the caller Thread to have a directory.");
        }
        path = Path.resolve(context.workingDirectory, path);
      }
      return bridgeRequest(
        "core.open",
        {
          ...(path ? { path } : { url }),
          ...(parsed.named.with ? { requestedApp: parsed.named.with } : {}),
          spaceId: requireContextText(context.spaceId, "spaceId"),
          threadId: requireContextText(context.threadId, "threadId"),
        },
        env,
      );
    }
    throw new Error(`Unknown Penkra core command: ${args.join(" ")}. Run penkra --help.`);
  }

  const parsed = parseFlags(args);
  const appScope = {
    ...scope,
    ...(parsed.tabId === undefined ? {} : { tabId: parsed.tabId }),
  };
  const catalog = (await bridgeRequest("catalog.list", appScope, env)) as CatalogEntry[];
  const app = catalog.find((candidate) => candidate.slug === parsed.positionals[0]);
  if (!app) throw new Error(`Unknown or disabled App command root ${parsed.positionals[0]}.`);
  const operationWords = parsed.positionals.slice(1);
  if (parsed.help || parsed.schema || operationWords.length === 0) {
    const operation =
      operationWords.length === 0 ? undefined : resolveOperation(app, operationWords);
    return {
      app: app.slug,
      help: await bridgeRequest(
        "catalog.help",
        {
          slug: app.slug,
          ...(operation ? { operation } : {}),
          ...(parsed.schema ? { schema: true } : {}),
          ...appScope,
        },
        env,
      ),
    };
  }
  const operation = resolveOperation(app, operationWords);
  const declaration = app.operations.find((candidate) => candidate.key === operation)!;
  const input = parseOperationInput(declaration.input, parsed.input, parsed.named);
  const result = await bridgeRequest(
    "operations.invoke",
    { app: app.slug, operation, input, ...appScope },
    env,
  );
  return { app: app.slug, operation, tabId: parsed.tabId ?? null, result };
}

function summarizeCatalog(catalog: ReadonlyArray<CatalogEntry>): ReadonlyArray<{
  slug: string;
  operations: ReadonlyArray<string>;
}> {
  return catalog.map((app) => ({
    slug: app.slug,
    operations: app.operations.map((operation) => operation.key),
  }));
}

function coreHelp(catalog: ReadonlyArray<CatalogEntry>): unknown {
  return {
    description: "Penkra registered commands run through penkra_exec; they are not shell commands.",
    commands: [
      "penkra apps list",
      "penkra tabs current",
      "penkra tabs list",
      "penkra open --path <path> | --url <url> [--with <app-slug>]",
    ],
    appCommands: summarizeCatalog(catalog).map((app) => ({
      root: app.slug,
      help: `penkra_exec: ${app.slug} --help`,
      operations: app.operations,
    })),
  };
}

export function tokenizeRegisteredCommand(command: string): string[] {
  if (typeof command !== "string" || !command.trim()) return [];
  if (/[$`]/.test(command)) {
    throw new Error("Command expansion is not supported by penkra_exec.");
  }
  const words: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (const character of command) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = null;
      else current += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (/[|&;<>()[\]{}]/.test(character)) {
      throw new Error("Shell operators are not supported by penkra_exec.");
    }
    if (/\s/.test(character)) {
      if (current) {
        words.push(current);
        current = "";
      }
      continue;
    }
    current += character;
  }
  if (escaped || quote) throw new Error("Command contains an unfinished escape or quote.");
  if (current) words.push(current);
  return words;
}

function requireContextText(value: string, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required.`);
  return value;
}

function parseFlags(args: ReadonlyArray<string>): {
  positionals: string[];
  help: boolean;
  schema: boolean;
  input?: string;
  tabId?: string;
  named: Record<string, string>;
} {
  const positionals: string[] = [];
  let help = false;
  let schema = false;
  let input: string | undefined;
  let tabId: string | undefined;
  const named: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]!;
    if (value === "--help" || value === "-h") {
      help = true;
      continue;
    }
    if (value === "--schema") {
      schema = true;
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
    schema,
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
