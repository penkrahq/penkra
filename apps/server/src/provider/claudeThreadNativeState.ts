// FILE: claudeThreadNativeState.ts
// Purpose: Keep Claude conversations in their canonical native-state folders.

import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import * as Path from "node:path";
import { createInterface } from "node:readline";

import { providerNativeStateRoot, providerOpaquePathKey } from "./providerNativeStatePaths.ts";

const RETENTION_DAYS = 36_500;
const CLAUDE_THREAD_ACCOUNT_FILE = "account.json";
const CLAUDE_SESSION_SIDECARS = ["session-env", "tasks", "file-history"] as const;

export type ClaudeThreadAccount = {
  readonly authenticationMethodId: string;
  readonly providerIdentityId: string | null;
  readonly projectRevision?: number;
};

export function claudeAccountsMatch(
  left: ClaudeThreadAccount,
  right: ClaudeThreadAccount,
): boolean {
  const leftSubscription = left.authenticationMethodId === "claude-account";
  const rightSubscription = right.authenticationMethodId === "claude-account";
  if (!leftSubscription && !rightSubscription) return true;
  return (
    leftSubscription &&
    rightSubscription &&
    left.providerIdentityId !== null &&
    right.providerIdentityId !== null &&
    left.providerIdentityId.trim().toLowerCase() === right.providerIdentityId.trim().toLowerCase()
  );
}

export function claudeThreadProjectName(threadId: string): string {
  // Claude accepts at most 64 characters for CLAUDE_CODE_PROJECT_DIR_NAME.
  return `thread_${createHash("sha256").update(threadId).digest("hex").slice(0, 56)}`;
}

export function claudeNativeStateRoot(stateDir: string, nativeStateId: string): string {
  return Path.join(providerNativeStateRoot(stateDir, nativeStateId), "claude");
}

function scopedClaudeProjectRoot(
  stateDir: string,
  nativeStateId: string,
  account: ClaudeThreadAccount,
  revision: number,
) {
  return Path.join(
    claudeNativeStateRoot(stateDir, nativeStateId),
    "accounts",
    providerOpaquePathKey(
      `${account.authenticationMethodId}:${account.providerIdentityId?.trim().toLowerCase() ?? ""}`,
    ),
    `revision-${revision}`,
  );
}

async function activeClaudeProjectRoot(stateDir: string, nativeStateId: string) {
  const owner = await readClaudeThreadAccount(stateDir, nativeStateId);
  if (owner?.projectRevision !== undefined) {
    return scopedClaudeProjectRoot(stateDir, nativeStateId, owner, owner.projectRevision);
  }
  return claudeNativeStateRoot(stateDir, nativeStateId);
}

async function syncDirectory(path: string): Promise<void> {
  // Windows does not allow opening a directory handle through node:fs.
  if (process.platform === "win32") return;
  const directory = await open(path, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function writeSyncedFile(path: string, contents: string): Promise<void> {
  const file = await open(path, "wx", 0o600);
  try {
    await file.writeFile(contents);
    await file.sync();
  } finally {
    await file.close();
  }
}

export function claudeThreadTranscriptPath(
  stateDir: string,
  nativeStateId: string,
  sessionId: string,
): string {
  return Path.join(claudeNativeStateRoot(stateDir, nativeStateId), "project", `${sessionId}.jsonl`);
}

async function transcriptHasConversation(path: string): Promise<boolean> {
  const stream = createReadStream(path);
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      try {
        const entry: unknown = JSON.parse(line);
        if (
          typeof entry === "object" &&
          entry !== null &&
          "type" in entry &&
          (entry.type === "user" || entry.type === "assistant")
        )
          return true;
      } catch {
        // Ignore an interrupted final write; earlier conversation remains valid.
      }
    }
    return false;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw cause;
  } finally {
    lines.close();
    stream.destroy();
  }
}

export async function claudeThreadHasConversation(
  stateDir: string,
  nativeStateId: string,
  sessionId: string,
): Promise<boolean> {
  return claudeProjectHasConversation(
    await activeClaudeProjectRoot(stateDir, nativeStateId),
    sessionId,
  );
}

export async function claudeProjectHasConversation(
  nativeStateRoot: string,
  sessionId: string,
): Promise<boolean> {
  const path = Path.join(nativeStateRoot, "project", `${sessionId}.jsonl`);
  if (!(await statOrNull(path))?.isFile()) return false;
  return transcriptHasConversation(path);
}

/** Resolve the one conversation directory recorded in this native-state folder. */
export async function claudeNativeProjectRoot(nativeStateRoot: string): Promise<string> {
  const root = Path.join(nativeStateRoot, "claude");
  const raw = await readFile(Path.join(root, CLAUDE_THREAD_ACCOUNT_FILE), "utf8").catch(
    (cause: NodeJS.ErrnoException) => {
      if (cause.code === "ENOENT") return null;
      throw cause;
    },
  );
  if (raw === null) return root;
  const account: unknown = JSON.parse(raw);
  if (!isClaudeThreadAccount(account))
    throw new Error(
      `Claude account metadata is invalid: ${Path.join(root, CLAUDE_THREAD_ACCOUNT_FILE)}`,
    );
  if (account.projectRevision === undefined) return root;
  return Path.join(
    root,
    "accounts",
    providerOpaquePathKey(
      `${account.authenticationMethodId}:${account.providerIdentityId?.trim().toLowerCase() ?? ""}`,
    ),
    `revision-${account.projectRevision}`,
  );
}

async function statOrNull(path: string) {
  return lstat(path).catch((cause: NodeJS.ErrnoException) => {
    if (cause.code === "ENOENT") return null;
    throw cause;
  });
}

export async function readClaudeThreadAccount(
  stateDir: string,
  nativeStateId: string,
): Promise<ClaudeThreadAccount | null> {
  const raw = await readFile(
    Path.join(claudeNativeStateRoot(stateDir, nativeStateId), CLAUDE_THREAD_ACCOUNT_FILE),
    "utf8",
  ).catch((cause: NodeJS.ErrnoException) => {
    if (cause.code === "ENOENT") return null;
    throw cause;
  });
  if (raw === null) return null;
  const decoded: unknown = JSON.parse(raw);
  return isClaudeThreadAccount(decoded) ? decoded : null;
}

function isClaudeThreadAccount(value: unknown): value is ClaudeThreadAccount {
  if (typeof value !== "object" || value === null) return false;
  const record = value as {
    readonly authenticationMethodId?: unknown;
    readonly providerIdentityId?: unknown;
    readonly projectRevision?: unknown;
  };
  return (
    typeof record.authenticationMethodId === "string" &&
    (typeof record.providerIdentityId === "string" || record.providerIdentityId === null) &&
    (record.projectRevision === undefined ||
      (typeof record.projectRevision === "number" &&
        Number.isSafeInteger(record.projectRevision) &&
        record.projectRevision >= 0))
  );
}

/**
 * Record the provider account that owns a Thread. The first owner wins: a later
 * login on the same Connection must not be able to repoint the Thread.
 */
export async function rememberClaudeThreadAccount(input: {
  readonly stateDir: string;
  readonly nativeStateId: string;
  readonly account: ClaudeThreadAccount;
}): Promise<void> {
  const existing = await readClaudeThreadAccount(input.stateDir, input.nativeStateId);
  if (existing !== null) {
    if (!claudeAccountsMatch(existing, input.account)) {
      throw new Error(
        "This thread's Claude conversation belongs to a different Claude account. Use a Connection signed in to that account, or start a new thread.",
      );
    }
    return;
  }
  const root = claudeNativeStateRoot(input.stateDir, input.nativeStateId);
  const path = Path.join(root, CLAUDE_THREAD_ACCOUNT_FILE);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const staging = `${path}.penkra-${randomUUID()}`;
  await writeSyncedFile(staging, `${JSON.stringify(input.account)}\n`);
  try {
    // A hard link creates the owner file only if it does not exist. rename()
    // would let two simultaneous launches overwrite the first account.
    await link(staging, path).catch((cause: NodeJS.ErrnoException) => {
      if (cause.code !== "EEXIST") throw cause;
    });
    await syncDirectory(root);
  } finally {
    await rm(staging, { force: true });
  }
  const owner = await readClaudeThreadAccount(input.stateDir, input.nativeStateId);
  if (owner === null || !claudeAccountsMatch(owner, input.account)) {
    throw new Error(
      "This thread's Claude conversation belongs to a different Claude account. Use a Connection signed in to that account, or start a new thread.",
    );
  }
}

/** Replace only a link Penkra owns. Never discard a real provider directory. */
async function ensureLink(path: string, target: string): Promise<void> {
  await mkdir(target, { recursive: true, mode: 0o700 });
  await mkdir(Path.dirname(path), { recursive: true, mode: 0o700 });
  const current = await statOrNull(path);
  if (current?.isSymbolicLink() && (await readlink(path)) === target) return;
  if (current !== null && !current.isSymbolicLink()) {
    throw new Error(`Claude native-state path is occupied by a non-link: ${path}`);
  }
  const staging = `${path}.penkra-link-${randomUUID()}`;
  await symlink(target, staging, process.platform === "win32" ? "junction" : "dir");
  try {
    await replaceLink(staging, path);
  } finally {
    await rm(staging, { force: true });
  }
}

/**
 * POSIX rename atomically replaces an existing directory symlink. Windows
 * MoveFileEx cannot replace an existing directory junction, so fall back to
 * removing the stale link first.
 */
async function replaceLink(staging: string, path: string): Promise<void> {
  try {
    await rename(staging, path);
    return;
  } catch (cause) {
    if (process.platform !== "win32") throw cause;
    const current = await statOrNull(path);
    if (current !== null && !current.isSymbolicLink()) throw cause;
    await rm(path, { recursive: true, force: true });
    try {
      await rename(staging, path);
    } catch (retryCause) {
      // A concurrent repair may have installed the same link first.
      const replacement = await statOrNull(path);
      if (!replacement?.isSymbolicLink() || (await readlink(path)) !== (await readlink(staging))) {
        throw retryCause;
      }
    }
  }
}

/** Claude does not provide a supported zero/disabled retention setting. */
export async function ensureClaudeManagedRetention(configDir: string): Promise<void> {
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  const settingsPath = Path.join(configDir, "settings.json");
  const raw = await readFile(settingsPath, "utf8").catch((cause: NodeJS.ErrnoException) => {
    if (cause.code === "ENOENT") return null;
    throw cause;
  });
  const parsed: unknown = raw === null ? {} : JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("The Claude profile settings file must contain a JSON object.");
  }
  const settings = parsed as Record<string, unknown>;
  if (settings.cleanupPeriodDays === RETENTION_DAYS) return;
  const staging = `${settingsPath}.penkra-${randomUUID()}`;
  await writeFile(
    staging,
    `${JSON.stringify({ ...settings, cleanupPeriodDays: RETENTION_DAYS }, null, 2)}\n`,
    {
      mode: 0o600,
    },
  );
  try {
    await rename(staging, settingsPath);
  } finally {
    await rm(staging, { force: true });
  }
}

export async function prepareClaudeThreadProject(input: {
  readonly stateDir: string;
  readonly threadId: string;
  readonly nativeStateId: string;
  readonly configDir: string;
  readonly account?: ClaudeThreadAccount;
}): Promise<string> {
  const projectName = claudeThreadProjectName(input.threadId);
  if (input.account !== undefined) {
    await rememberClaudeThreadAccount({
      stateDir: input.stateDir,
      nativeStateId: input.nativeStateId,
      account: input.account,
    });
  }
  const projectRoot = await activeClaudeProjectRoot(input.stateDir, input.nativeStateId);
  await ensureLink(
    Path.join(input.configDir, "projects", projectName),
    Path.join(projectRoot, "project"),
  );
  await ensureClaudeManagedRetention(input.configDir);
  return projectName;
}

export async function prepareClaudeThreadSidecars(input: {
  readonly configDir: string;
  readonly projectName: string;
  readonly sessionId: string;
}): Promise<void> {
  const projectLink = Path.join(input.configDir, "projects", input.projectName);
  const link = await statOrNull(projectLink);
  if (!link?.isSymbolicLink()) throw new Error("Claude Thread project link is unavailable.");
  const root = Path.dirname(await readlink(projectLink));
  for (const name of CLAUDE_SESSION_SIDECARS) {
    await ensureLink(
      Path.join(input.configDir, name, input.sessionId),
      Path.join(root, name, input.sessionId),
    );
  }
}
