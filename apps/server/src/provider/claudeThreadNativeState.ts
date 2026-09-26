// FILE: claudeThreadNativeState.ts
// Purpose: Keep Claude's durable conversation under its Penkra Thread, independent of login profiles.

import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import * as Path from "node:path";
import { createInterface } from "node:readline";

const RETENTION_DAYS = 36_500;
const CLAUDE_THREAD_ACCOUNT_FILE = "account.json";
export const CLAUDE_SESSION_MARKER_FILE = "claude-session.json";
const CLAUDE_SESSION_SIDECARS = ["session-env", "tasks", "file-history"] as const;

export type ClaudeThreadAccount = {
  readonly authenticationMethodId: string;
  readonly providerIdentityId: string | null;
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

export type ClaudeSessionMarker = {
  readonly providerSessionId: string;
  readonly requiresReconstruction?: boolean;
};

export function claudeThreadProjectName(threadId: string): string {
  // Claude accepts at most 64 characters for CLAUDE_CODE_PROJECT_DIR_NAME.
  return `thread_${createHash("sha256").update(threadId).digest("hex").slice(0, 56)}`;
}

export function claudeThreadStateRoot(stateDir: string, threadId: string): string {
  return Path.join(stateDir, "provider-thread-native-state", claudeThreadProjectName(threadId));
}

export function claudeThreadTranscriptPath(
  stateDir: string,
  threadId: string,
  sessionId: string,
): string {
  return Path.join(claudeThreadStateRoot(stateDir, threadId), "project", `${sessionId}.jsonl`);
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
  threadId: string,
  sessionId: string,
): Promise<boolean> {
  const path = claudeThreadTranscriptPath(stateDir, threadId, sessionId);
  if (!(await statOrNull(path))?.isFile()) return false;
  return transcriptHasConversation(path);
}

async function statOrNull(path: string) {
  return lstat(path).catch((cause: NodeJS.ErrnoException) => {
    if (cause.code === "ENOENT") return null;
    throw cause;
  });
}

export async function readClaudeThreadAccount(
  stateDir: string,
  threadId: string,
): Promise<ClaudeThreadAccount | null> {
  const raw = await readFile(
    Path.join(claudeThreadStateRoot(stateDir, threadId), CLAUDE_THREAD_ACCOUNT_FILE),
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
  };
  return (
    typeof record.authenticationMethodId === "string" &&
    (typeof record.providerIdentityId === "string" || record.providerIdentityId === null)
  );
}

/**
 * Record the provider account that owns a Thread. The first owner wins: a later
 * login on the same Connection must not be able to repoint the Thread.
 */
export async function rememberClaudeThreadAccount(input: {
  readonly stateDir: string;
  readonly threadId: string;
  readonly account: ClaudeThreadAccount;
}): Promise<void> {
  const existing = await readClaudeThreadAccount(input.stateDir, input.threadId);
  if (existing !== null) {
    if (!claudeAccountsMatch(existing, input.account)) {
      throw new Error(
        "This thread's Claude conversation belongs to a different Claude account. Use a Connection signed in to that account, or start a new thread.",
      );
    }
    return;
  }
  const root = claudeThreadStateRoot(input.stateDir, input.threadId);
  const path = Path.join(root, CLAUDE_THREAD_ACCOUNT_FILE);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const staging = `${path}.penkra-${randomUUID()}`;
  await writeFile(staging, `${JSON.stringify(input.account)}\n`, { mode: 0o600 });
  try {
    // A hard link creates the owner file only if it does not exist. rename()
    // would let two simultaneous launches overwrite the first account.
    await link(staging, path).catch((cause: NodeJS.ErrnoException) => {
      if (cause.code !== "EEXIST") throw cause;
    });
  } finally {
    await rm(staging, { force: true });
  }
  const owner = await readClaudeThreadAccount(input.stateDir, input.threadId);
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
  readonly configDir: string;
  readonly account?: ClaudeThreadAccount;
}): Promise<string> {
  const projectName = claudeThreadProjectName(input.threadId);
  if (input.account !== undefined) {
    await rememberClaudeThreadAccount({
      stateDir: input.stateDir,
      threadId: input.threadId,
      account: input.account,
    });
  }
  await ensureLink(
    Path.join(input.configDir, "projects", projectName),
    Path.join(claudeThreadStateRoot(input.stateDir, input.threadId), "project"),
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

export async function readClaudeSessionMarker(
  generationRoot: string,
): Promise<ClaudeSessionMarker | null> {
  const raw = await readFile(Path.join(generationRoot, CLAUDE_SESSION_MARKER_FILE), "utf8").catch(
    (cause: NodeJS.ErrnoException) => {
      if (cause.code === "ENOENT") return null;
      throw cause;
    },
  );
  if (raw === null) return null;
  const decoded: unknown = JSON.parse(raw);
  if (typeof decoded !== "object" || decoded === null) return null;
  const record = decoded as {
    readonly providerSessionId?: unknown;
    readonly requiresReconstruction?: unknown;
  };
  if (typeof record.providerSessionId !== "string") return null;
  return {
    providerSessionId: record.providerSessionId,
    requiresReconstruction: record.requiresReconstruction === true,
  };
}
