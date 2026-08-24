// FILE: codexProcessEnv.ts
// Purpose: Builds the exact environment used when Penkra launches Codex subprocesses.
// Layer: Server runtime utility
// Exports: Codex process env builder and provider-overlay helpers.
// Depends on: Codex home path helpers, shared Codex config parsing, login-shell env reader.

import * as fs from "node:fs/promises";
import path from "node:path";
import { Effect } from "effect";

import { readActiveCodexProviderEnvKey } from "@penkra/shared/codexConfig";
import {
  readEnvironmentFromLoginShell,
  resolveLoginShell,
  type ShellEnvironmentReader,
} from "@penkra/shared/shell";

import { resolveBaseCodexHomePath, resolvePenkraCodexHomeOverlayPath } from "./codexHomePaths.ts";
import { writeFileStringAtomically } from "./atomicWrite.ts";
import { buildProviderChildEnvironment } from "./providerChildEnvironment.ts";

const CODEX_PROCESS_SHELL_ENV_NAMES = ["PATH", "SSH_AUTH_SOCK"] as const;
const CODEX_OVERLAY_SHARED_STATE_FILES = new Set(["auth.json"]);
const codexOverlayPreparationQueues = new Map<string, Promise<void>>();

async function writeCodexConfigIfChanged(
  configPath: string,
  contents: string,
  currentContents?: string,
): Promise<void> {
  const current =
    currentContents ??
    (await fs.readFile(configPath, "utf8").catch((cause: unknown) => {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw cause;
    }));
  if (current === contents) return;
  await Effect.runPromise(
    writeFileStringAtomically({ filePath: configPath, contents, mode: 0o600 }),
  );
}

interface CodexOverlayEntryLinker {
  readonly symlink: typeof fs.symlink;
  readonly copyFile: typeof fs.copyFile;
}

function tomlTablePath(line: string): readonly string[] | undefined {
  const normalized = normalizeTomlTableHeaderName(line);
  if (!normalized) return undefined;
  return JSON.parse(normalized) as string[];
}

/**
 * Removes only a copied server that occupies Penkra's reserved gateway name.
 * Every unrelated provider/user/project MCP server remains under the provider's
 * normal configuration. Penkra appends its authenticated gateway afterward.
 */
export function removeReservedPenkraMcpServer(config: string): string {
  const output: string[] = [];
  let removingReservedTable = false;
  let inMcpRootTable = false;
  let atTomlRoot = true;

  for (const line of config.split(/\r?\n/)) {
    const tablePath = tomlTablePath(line);
    if (tablePath !== undefined) {
      removingReservedTable = tablePath[0] === "mcp_servers" && tablePath[1] === "penkra";
      inMcpRootTable = tablePath.length === 1 && tablePath[0] === "mcp_servers";
      atTomlRoot = false;
    }
    if (removingReservedTable) continue;
    if (inMcpRootTable && /^\s*(?:penkra|["']penkra["'])\s*=/.test(line)) continue;
    if (
      atTomlRoot &&
      /^\s*(?:mcp_servers|["']mcp_servers["'])\s*\.\s*(?:penkra|["']penkra["'])\s*=/.test(line)
    ) {
      continue;
    }
    output.push(line);
  }

  return output.join("\n").replace(/\n{3,}/g, "\n\n");
}

const COMPUTER_USE_PLUGIN_HEADER = '[plugins."computer-use@openai-bundled"]';
const COMPUTER_USE_PLUGIN_MCP_SERVER_HEADER =
  '[plugins."computer-use@openai-bundled".mcp_servers."computer-use"]';

function setTomlTableBoolean(
  config: string,
  header: string,
  key: string,
  value: boolean,
  createWhenMissing: boolean,
): string {
  const target = normalizeTomlTableHeaderName(header);
  const lines = config.split(/\r?\n/);
  const output: string[] = [];
  let inTargetTable = false;
  let sawTargetTable = false;
  let wroteValue = false;

  const closeTargetTable = () => {
    if (inTargetTable && !wroteValue) output.push(`${key} = ${String(value)}`);
  };

  for (const line of lines) {
    const table = normalizeTomlTableHeaderName(line);
    if (table !== undefined) {
      closeTargetTable();
      inTargetTable = table === target;
      if (inTargetTable) sawTargetTable = true;
      wroteValue = false;
      output.push(line);
      continue;
    }
    if (inTargetTable && new RegExp(`^\\s*${key}\\s*=`).test(line)) {
      output.push(`${key} = ${String(value)}`);
      wroteValue = true;
      continue;
    }
    output.push(line);
  }

  closeTargetTable();
  if (!sawTargetTable && createWhenMissing) {
    const base = output.join("\n").trimEnd();
    return `${base}\n\n${header}\n${key} = ${String(value)}\n`;
  }
  return output.join("\n");
}

/** Makes both official Computer Use routes available without inventing a node_repl command. */
export function enableOfficialComputerUseRoutes(config: string): string {
  let next = setTomlTableBoolean(config, COMPUTER_USE_PLUGIN_HEADER, "enabled", true, true);
  next = setTomlTableBoolean(next, COMPUTER_USE_PLUGIN_MCP_SERVER_HEADER, "enabled", true, true);
  return setTomlTableBoolean(next, "[mcp_servers.node_repl]", "enabled", true, false);
}

/**
 * Codex keeps `request_user_input` out of Default mode unless this upstream
 * feature is enabled. Penkra's managed profile turns it on so provider turns
 * can render the same native question UI in Default mode as other providers.
 * This intentionally overrides a copied user value only inside the managed
 * overlay; the user's source `config.toml` is never modified.
 */
export function enableDefaultModeRequestUserInput(config: string): string {
  return setTomlTableBoolean(config, "[features]", "default_mode_request_user_input", true, true);
}

/**
 * ChatGPT can leave a disabled legacy top-level server named `computer-use`.
 * That name masks the enabled plugin-owned server in app-server inventory, so
 * omit only the disabled legacy definition from Penkra's effective profile.
 */
export function removeDisabledLegacyComputerUseServer(config: string): string {
  const lines = config.split(/\r?\n/);
  let parentDisabled = false;
  for (let index = 0; index < lines.length; index += 1) {
    const tablePath = tomlTablePath(lines[index] ?? "");
    if (
      tablePath?.length !== 2 ||
      tablePath[0] !== "mcp_servers" ||
      tablePath[1] !== "computer-use"
    ) {
      continue;
    }
    for (let bodyIndex = index + 1; bodyIndex < lines.length; bodyIndex += 1) {
      if (tomlTablePath(lines[bodyIndex] ?? "") !== undefined) break;
      if (/^\s*enabled\s*=\s*false\s*(?:#.*)?$/.test(lines[bodyIndex] ?? "")) {
        parentDisabled = true;
        break;
      }
    }
    break;
  }
  if (!parentDisabled) return config;

  const output: string[] = [];
  let removing = false;
  for (const line of lines) {
    const tablePath = tomlTablePath(line);
    if (tablePath !== undefined) {
      removing = tablePath[0] === "mcp_servers" && tablePath[1] === "computer-use";
    }
    if (!removing) output.push(line);
  }
  return output.join("\n").replace(/\n{3,}/g, "\n\n");
}

function prepareEffectiveCodexConfig(config: string): string {
  return enableDefaultModeRequestUserInput(
    enableOfficialComputerUseRoutes(
      removeDisabledLegacyComputerUseServer(removeReservedPenkraMcpServer(config)),
    ),
  );
}

export async function linkOrCopyCodexOverlayEntry(
  input: {
    readonly entryName: string;
    readonly sourcePath: string;
    readonly targetPath: string;
    readonly type: "dir" | "file";
  },
  linker: CodexOverlayEntryLinker = {
    symlink: fs.symlink,
    copyFile: fs.copyFile,
  },
): Promise<void> {
  try {
    await linker.symlink(input.sourcePath, input.targetPath, input.type);
  } catch (error: unknown) {
    if (input.type === "file" && CODEX_OVERLAY_SHARED_STATE_FILES.has(input.entryName)) {
      await linker.copyFile(input.sourcePath, input.targetPath);
      return;
    }
    throw error;
  }
}

export function prioritizeCodexOverlayEntries(entries: readonly string[]): string[] {
  const sharedStateEntries: string[] = [];
  const otherEntries: string[] = [];

  for (const entry of entries) {
    if (CODEX_OVERLAY_SHARED_STATE_FILES.has(entry)) {
      sharedStateEntries.push(entry);
    } else {
      otherEntries.push(entry);
    }
  }

  return [...sharedStateEntries, ...otherEntries];
}

async function ensureCodexOverlaySymlink(input: {
  readonly entryName: string;
  readonly sourcePath: string;
  readonly targetPath: string;
  readonly type: "dir" | "file";
}): Promise<void> {
  let targetStat: Awaited<ReturnType<typeof fs.lstat>> | undefined;
  try {
    targetStat = await fs.lstat(input.targetPath);
  } catch {
    targetStat = undefined;
  }

  if (targetStat) {
    if (targetStat.isSymbolicLink() && (await fs.readlink(input.targetPath)) === input.sourcePath) {
      return;
    }

    if (
      targetStat.isSymbolicLink() ||
      /^.+\.sqlite(?:-(?:wal|shm|journal))?$/.test(input.entryName) ||
      CODEX_OVERLAY_SHARED_STATE_FILES.has(input.entryName)
    ) {
      // SQLite files must stay generation-matched, and auth must mirror the
      // user's real Codex home so external `codex login` changes are visible.
      await fs.rm(input.targetPath, { recursive: true, force: true });
    } else {
      return;
    }
  }

  await linkOrCopyCodexOverlayEntry(input);
}

export function appendCodexConfigSection(config: string, section: string): string {
  const trimmedSection = section.trim();
  if (!trimmedSection) {
    return config;
  }
  if (config.includes(trimmedSection.split("\n")[0] ?? trimmedSection)) {
    return config;
  }
  const base = config.trimEnd();
  return base.length > 0 ? `${base}\n\n${trimmedSection}\n` : `${trimmedSection}\n`;
}

export const PENKRA_MANAGED_CODEX_CONFIG_BEGIN = "# >>> penkra managed config >>>";
export const PENKRA_MANAGED_CODEX_CONFIG_END = "# <<< penkra managed config <<<";

export function extractManagedCodexConfigSection(config: string): string | undefined {
  const begin = config.indexOf(PENKRA_MANAGED_CODEX_CONFIG_BEGIN);
  if (begin === -1) {
    return undefined;
  }
  const contentStart = begin + PENKRA_MANAGED_CODEX_CONFIG_BEGIN.length;
  const end = config.indexOf(PENKRA_MANAGED_CODEX_CONFIG_END, contentStart);
  if (end === -1) {
    return undefined;
  }
  const content = config.slice(contentStart, end).trim();
  return content.length > 0 ? content : undefined;
}

function normalizeTomlTableHeaderName(line: string): string | undefined {
  const match = /^\s*\[\s*(.*?)\s*\]\s*(?:#.*)?$/.exec(line);
  if (!match) {
    return undefined;
  }
  const tableName = match[1];
  if (tableName === undefined) {
    return undefined;
  }
  const parts: string[] = [];
  let index = 0;
  const skipWhitespace = () => {
    while (index < tableName.length && /[\t ]/.test(tableName[index]!)) index += 1;
  };
  const parseBasicQuotedKey = (): string | undefined => {
    index += 1;
    let value = "";
    while (index < tableName.length) {
      const character = tableName[index++]!;
      if (character === '"') return value;
      if (character !== "\\") {
        if (character.charCodeAt(0) < 0x20) return undefined;
        value += character;
        continue;
      }
      const escape = tableName[index++];
      const simpleEscapes: Readonly<Record<string, string>> = {
        b: "\b",
        t: "\t",
        n: "\n",
        f: "\f",
        r: "\r",
        '"': '"',
        "\\": "\\",
      };
      if (escape !== undefined && simpleEscapes[escape] !== undefined) {
        value += simpleEscapes[escape];
        continue;
      }
      if (escape !== "u" && escape !== "U") return undefined;
      const length = escape === "u" ? 4 : 8;
      const hexadecimal = tableName.slice(index, index + length);
      if (!new RegExp(`^[0-9A-Fa-f]{${length}}$`).test(hexadecimal)) return undefined;
      const codePoint = Number.parseInt(hexadecimal, 16);
      if (codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) return undefined;
      value += String.fromCodePoint(codePoint);
      index += length;
    }
    return undefined;
  };
  const parseLiteralQuotedKey = (): string | undefined => {
    index += 1;
    const end = tableName.indexOf("'", index);
    if (end === -1) return undefined;
    const value = tableName.slice(index, end);
    index = end + 1;
    return value;
  };

  while (index < tableName.length) {
    skipWhitespace();
    let part: string | undefined;
    if (tableName[index] === '"') {
      part = parseBasicQuotedKey();
    } else if (tableName[index] === "'") {
      part = parseLiteralQuotedKey();
    } else {
      const start = index;
      while (index < tableName.length && /[A-Za-z0-9_-]/.test(tableName[index]!)) index += 1;
      part = index > start ? tableName.slice(start, index) : undefined;
    }
    if (part === undefined) return undefined;
    parts.push(part);
    skipWhitespace();
    if (index === tableName.length) break;
    if (tableName[index] !== ".") return undefined;
    index += 1;
    skipWhitespace();
    if (index === tableName.length) return undefined;
  }
  return parts.length > 0 ? JSON.stringify(parts) : undefined;
}

function findTomlTableHeader(config: string, header: string) {
  const target = normalizeTomlTableHeaderName(header);
  if (!target) {
    return undefined;
  }
  let offset = 0;
  for (const rawLine of config.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (normalizeTomlTableHeaderName(line) === target) {
      return { index: offset, end: offset + line.length };
    }
    offset += rawLine.length + 1;
  }
  return undefined;
}

function findNextTomlTableHeaderIndex(config: string, start: number): number {
  const tail = config.slice(start);
  let offset = 0;
  for (const rawLine of tail.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (normalizeTomlTableHeaderName(line) !== undefined) {
      return start + offset;
    }
    offset += rawLine.length + 1;
  }
  return config.length;
}

export function configHasTomlTableHeader(config: string, header: string): boolean {
  return findTomlTableHeader(config, header) !== undefined;
}

function splitTomlTables(snippet: string): string[] {
  const tables: string[] = [];
  let current: string[] = [];
  for (const line of snippet.split("\n")) {
    if (/^\s*\[/.test(line) && current.length > 0) {
      tables.push(current.join("\n").trim());
      current = [];
    }
    current.push(line);
  }
  if (current.length > 0) {
    tables.push(current.join("\n").trim());
  }
  return tables.filter((table) => table.length > 0);
}

function maskTomlComments(input: string): string {
  let result = "";
  let quote: '"' | "'" | undefined;
  let escaped = false;
  let inComment = false;

  for (const character of input) {
    if (inComment) {
      if (character === "\n" || character === "\r") {
        inComment = false;
        result += character;
      } else {
        result += " ";
      }
      continue;
    }

    if (quote) {
      result += character;
      if (quote === '"' && escaped) {
        escaped = false;
      } else if (quote === '"' && character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = undefined;
      }
      continue;
    }

    if (character === '"' || character === "'") {
      quote = character;
      result += character;
    } else if (character === "#") {
      inComment = true;
      result += " ";
    } else {
      result += character;
    }
  }

  return result;
}

function findTomlArrayEnd(input: string, openBracketIndex: number): number | undefined {
  let quote: '"' | "'" | undefined;
  let escaped = false;
  let depth = 0;

  for (let index = openBracketIndex; index < input.length; index += 1) {
    const character = input[index];
    if (quote) {
      if (quote === '"' && escaped) {
        escaped = false;
      } else if (quote === '"' && character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = undefined;
      }
      continue;
    }

    if (character === '"' || character === "'") {
      quote = character;
    } else if (character === "[") {
      depth += 1;
    } else if (character === "]") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }

  return undefined;
}

function mergeTomlStringArrayValues(
  config: string,
  tableHeader: string,
  key: string,
  values: readonly string[],
): string {
  const additions = [...new Set(values.filter(Boolean))];
  if (additions.length === 0) {
    return config;
  }
  const headerMatch = findTomlTableHeader(config, tableHeader);
  if (!headerMatch) {
    return appendCodexConfigSection(
      config,
      `${tableHeader}\n${key} = [${additions.map((value) => JSON.stringify(value)).join(", ")}]`,
    );
  }
  const tableStart = headerMatch.end;
  const tableEnd = findNextTomlTableHeaderIndex(config, tableStart);
  const tableBody = config.slice(tableStart, tableEnd);
  const activeTableBody = maskTomlComments(tableBody);
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const arrayPattern = new RegExp(`(^[\\t ]*${escapedKey}[\\t ]*=[\\t ]*\\[)`, "m");
  const arrayMatch = arrayPattern.exec(activeTableBody);

  if (arrayMatch) {
    const openBracketIndex = arrayMatch.index + arrayMatch[0].lastIndexOf("[");
    const closeBracketIndex = findTomlArrayEnd(activeTableBody, openBracketIndex);
    if (closeBracketIndex === undefined) {
      return config;
    }
    const activeArray = activeTableBody.slice(openBracketIndex + 1, closeBracketIndex);
    const missing = additions.filter((value) => {
      const escapedValue = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return !new RegExp(`(["'])${escapedValue}\\1`).test(activeArray);
    });
    if (missing.length === 0) {
      return config;
    }

    const insertAt = tableStart + openBracketIndex + 1;
    const separator = activeArray.trim().length > 0 ? ", " : "";
    return `${config.slice(0, insertAt)}${missing.map((value) => JSON.stringify(value)).join(", ")}${separator}${config.slice(insertAt)}`;
  }

  return `${config.slice(0, tableStart)}\n${key} = [${additions.map((value) => JSON.stringify(value)).join(", ")}]${config.slice(tableStart)}`;
}

export function mergeShellEnvPolicyExclude(config: string, envVarName: string): string {
  return mergeTomlStringArrayValues(
    config,
    "[shell_environment_policy]",
    "exclude",
    envVarName ? [envVarName] : [],
  );
}

function setRootTomlString(config: string, key: string, value: string): string {
  const lines = config.split(/\r?\n/);
  const assignment = `${key} = ${JSON.stringify(value)}`;
  let firstTableIndex = lines.length;
  let matched = false;
  const pattern = new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=`);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (normalizeTomlTableHeaderName(line) !== undefined) {
      firstTableIndex = index;
      break;
    }
    if (pattern.test(line)) {
      lines[index] = assignment;
      matched = true;
    }
  }

  if (!matched) {
    lines.splice(firstTableIndex, 0, assignment, "");
  }
  return lines.join("\n");
}

function appendManagedCodexConfigSection(config: string, section: string): string {
  const tables = splitTomlTables(section.trim()).filter((table) => {
    const header = table.split("\n")[0]?.trim();
    return header === undefined || !configHasTomlTableHeader(config, header);
  });
  if (tables.length === 0) {
    return config;
  }
  return appendCodexConfigSection(
    config,
    `${PENKRA_MANAGED_CODEX_CONFIG_BEGIN}\n${tables.join("\n\n")}\n${PENKRA_MANAGED_CODEX_CONFIG_END}`,
  );
}

async function serializeCodexOverlayPreparation<A>(
  overlayHomePath: string,
  prepare: () => Promise<A>,
): Promise<A> {
  const previous = codexOverlayPreparationQueues.get(overlayHomePath) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(prepare);
  const queued = current.then(
    () => undefined,
    () => undefined,
  );
  codexOverlayPreparationQueues.set(overlayHomePath, queued);
  try {
    return await current;
  } finally {
    if (codexOverlayPreparationQueues.get(overlayHomePath) === queued) {
      codexOverlayPreparationQueues.delete(overlayHomePath);
    }
  }
}

async function preparePenkraCodexHomeOverlayUnlocked(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly homePath?: string;
  readonly appendConfigToml?: string;
}): Promise<string | undefined> {
  const sourceHomePath = resolveBaseCodexHomePath(input.env, input.homePath);
  const overlayHomePath = resolvePenkraCodexHomeOverlayPath(input.env, sourceHomePath);
  if (path.resolve(sourceHomePath) === path.resolve(overlayHomePath)) {
    return undefined;
  }

  await fs.mkdir(overlayHomePath, { recursive: true });

  try {
    // Auth must get a best-effort link/copy before optional entries whose
    // symlinks may fail on restricted Windows installs.
    for (const entry of prioritizeCodexOverlayEntries(await fs.readdir(sourceHomePath))) {
      if (entry === "config.toml") {
        continue;
      }
      const sourcePath = path.join(sourceHomePath, entry);
      const targetPath = path.join(overlayHomePath, entry);
      const stat = await fs.lstat(sourcePath);
      await ensureCodexOverlaySymlink({
        entryName: entry,
        sourcePath,
        targetPath,
        type: stat.isDirectory() ? "dir" : "file",
      });
    }
  } catch {
    // If the source home is partially missing, Codex can still start with the
    // overlay config and create any required state lazily.
  }

  const sourceConfigPath = path.join(sourceHomePath, "config.toml");
  const sourceConfig = await fs.readFile(sourceConfigPath, "utf8").catch((cause: unknown) => {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
      return "";
    }
    throw cause;
  });
  const overlayConfigPath = path.join(overlayHomePath, "config.toml");
  // Provider plugins and MCP servers retain their normal Codex configuration.
  // Penkra owns only its reserved gateway entry, which is appended below.
  let overlayConfig = prepareEffectiveCodexConfig(sourceConfig);
  const managedSection =
    input.appendConfigToml ??
    (await fs
      .readFile(overlayConfigPath, "utf8")
      .then(extractManagedCodexConfigSection)
      .catch((cause: unknown) => {
        if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
          return undefined;
        }
        throw cause;
      }));
  if (managedSection) {
    overlayConfig = appendManagedCodexConfigSection(overlayConfig, managedSection);
    const tokenEnvVar = /bearer_token_env_var\s*=\s*"([^"]+)"/.exec(managedSection)?.[1];
    if (tokenEnvVar) {
      overlayConfig = mergeShellEnvPolicyExclude(overlayConfig, tokenEnvVar);
    }
  }
  await writeCodexConfigIfChanged(overlayConfigPath, overlayConfig);

  return overlayHomePath;
}

async function preparePenkraCodexHomeOverlay(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly homePath?: string;
  readonly appendConfigToml?: string;
}): Promise<string | undefined> {
  const sourceHomePath = resolveBaseCodexHomePath(input.env, input.homePath);
  const overlayHomePath = resolvePenkraCodexHomeOverlayPath(input.env, sourceHomePath);
  if (path.resolve(sourceHomePath) === path.resolve(overlayHomePath)) {
    return undefined;
  }
  return serializeCodexOverlayPreparation(overlayHomePath, () =>
    preparePenkraCodexHomeOverlayUnlocked(input),
  );
}

/**
 * Builds the effective config for an isolated managed Codex profile. Provider
 * credentials and native state remain Connection-owned, while ordinary user
 * configuration (plugins, MCP servers, preferences) follows the user's Codex
 * config. Penkra replaces only its reserved gateway entry.
 */
export async function prepareManagedCodexProfileConfig(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly sourceHomePath?: string;
  readonly appendConfigToml?: string;
  readonly cliAuthCredentialsStore?: "file" | "keyring";
}): Promise<void> {
  const codexHome = input.env.CODEX_HOME?.trim();
  if (!codexHome) throw new Error("The managed Codex profile has no CODEX_HOME.");
  await serializeCodexOverlayPreparation(codexHome, async () => {
    await fs.mkdir(codexHome, { recursive: true, mode: 0o700 });
    const configPath = path.join(codexHome, "config.toml");
    const existing = await fs.readFile(configPath, "utf8").catch((cause: unknown) => {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw cause;
    });
    const sourceHomePath = input.sourceHomePath ?? resolveBaseCodexHomePath(process.env);
    if (path.resolve(sourceHomePath) !== path.resolve(codexHome)) {
      const sourceComputerUsePath = path.join(sourceHomePath, "computer-use");
      const sourceComputerUseStat = await fs.stat(sourceComputerUsePath).catch(() => undefined);
      if (sourceComputerUseStat?.isDirectory()) {
        await ensureCodexOverlaySymlink({
          entryName: "computer-use",
          sourcePath: sourceComputerUsePath,
          targetPath: path.join(codexHome, "computer-use"),
          type: "dir",
        });
      }
    }
    const sourceConfigPath = path.join(sourceHomePath, "config.toml");
    const sourceConfig =
      path.resolve(sourceConfigPath) === path.resolve(configPath)
        ? existing
        : await fs.readFile(sourceConfigPath, "utf8").catch((cause: unknown) => {
            if ((cause as NodeJS.ErrnoException).code === "ENOENT") return existing;
            throw cause;
          });
    let config = prepareEffectiveCodexConfig(sourceConfig);
    if (input.cliAuthCredentialsStore) {
      config = setRootTomlString(
        config,
        "cli_auth_credentials_store",
        input.cliAuthCredentialsStore,
      );
    }
    if (input.appendConfigToml) {
      config = appendManagedCodexConfigSection(config, input.appendConfigToml);
      const tokenEnvVar = /bearer_token_env_var\s*=\s*"([^"]+)"/.exec(input.appendConfigToml)?.[1];
      if (tokenEnvVar) config = mergeShellEnvPolicyExclude(config, tokenEnvVar);
    }
    await writeCodexConfigIfChanged(configPath, config, existing);
  });
}

export async function buildCodexProcessEnv(
  input: {
    readonly env?: NodeJS.ProcessEnv;
    readonly homePath?: string;
    readonly platform?: NodeJS.Platform;
    readonly readEnvironment?: ShellEnvironmentReader;
    readonly appendConfigToml?: string;
  } = {},
): Promise<NodeJS.ProcessEnv> {
  const baseEnv = { ...(input.env ?? process.env) };
  const overlayHomePath = await preparePenkraCodexHomeOverlay({
    env: baseEnv,
    ...(input.homePath ? { homePath: input.homePath } : {}),
    ...(input.appendConfigToml ? { appendConfigToml: input.appendConfigToml } : {}),
  });
  const configuredEnv =
    overlayHomePath || input.homePath
      ? { ...baseEnv, CODEX_HOME: overlayHomePath ?? input.homePath }
      : baseEnv;
  const platform = input.platform ?? process.platform;
  const effectiveEnv = buildProviderChildEnvironment({
    provider: "codex",
    baseEnv: configuredEnv,
    managedConnection: false,
  });

  if (platform === "darwin" || platform === "linux") {
    try {
      const shell = resolveLoginShell(platform, effectiveEnv.SHELL);
      const providerEnvKey = readActiveCodexProviderEnvKey(effectiveEnv);
      if (shell && providerEnvKey && !effectiveEnv[providerEnvKey]?.trim()) {
        const shellEnvironment = (input.readEnvironment ?? readEnvironmentFromLoginShell)(shell, [
          ...CODEX_PROCESS_SHELL_ENV_NAMES,
          providerEnvKey,
        ]);

        if (shellEnvironment.PATH) {
          effectiveEnv.PATH = shellEnvironment.PATH;
        }
        if (!effectiveEnv.SSH_AUTH_SOCK && shellEnvironment.SSH_AUTH_SOCK) {
          effectiveEnv.SSH_AUTH_SOCK = shellEnvironment.SSH_AUTH_SOCK;
        }
        if (shellEnvironment[providerEnvKey]) {
          effectiveEnv[providerEnvKey] = shellEnvironment[providerEnvKey];
        }
      }
    } catch {
      // Keep inherited environment if shell lookup fails.
    }
  }

  return effectiveEnv;
}
