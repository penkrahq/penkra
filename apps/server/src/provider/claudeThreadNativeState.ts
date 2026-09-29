// FILE: claudeThreadNativeState.ts
// Purpose: Keep Claude's durable conversation under its Penkra Thread, independent of login profiles.

import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  cp,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import * as Path from "node:path";
import { createInterface } from "node:readline";

import { providerOpaquePathKey } from "./providerNativeStatePaths.ts";

const RETENTION_DAYS = 36_500;
const CLAUDE_THREAD_ACCOUNT_FILE = "account.json";
const CLAUDE_THREAD_ACCOUNT_TRANSITION_FILE = "account-transition.json";
export const CLAUDE_SESSION_MARKER_FILE = "claude-session.json";
const CLAUDE_SESSION_SIDECARS = ["session-env", "tasks", "file-history"] as const;

export type ClaudeThreadAccount = {
  readonly authenticationMethodId: string;
  readonly providerIdentityId: string | null;
  readonly projectRevision?: number;
};

type ClaudeThreadAccountTransition = {
  readonly commandId: string;
  readonly connectionId: string;
  readonly bindingRevision: number;
  readonly source: ClaudeThreadAccount;
  readonly target: ClaudeThreadAccount;
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

function scopedClaudeProjectRoot(
  stateDir: string,
  threadId: string,
  account: ClaudeThreadAccount,
  revision: number,
) {
  return Path.join(
    claudeThreadStateRoot(stateDir, threadId),
    "accounts",
    providerOpaquePathKey(
      `${account.authenticationMethodId}:${account.providerIdentityId?.trim().toLowerCase() ?? ""}`,
    ),
    `revision-${revision}`,
  );
}

async function activeClaudeProjectRoot(stateDir: string, threadId: string) {
  const owner = await readClaudeThreadAccount(stateDir, threadId);
  if (owner?.projectRevision !== undefined) {
    return scopedClaudeProjectRoot(stateDir, threadId, owner, owner.projectRevision);
  }
  return claudeThreadStateRoot(stateDir, threadId);
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

async function syncCopiedTree(path: string): Promise<void> {
  if (process.platform === "win32") return;
  const entry = await statOrNull(path);
  if (entry?.isDirectory()) {
    for (const child of await readdir(path)) await syncCopiedTree(Path.join(path, child));
    await syncDirectory(path);
  } else if (entry?.isFile()) {
    const file = await open(path, "r");
    try {
      await file.sync();
    } finally {
      await file.close();
    }
  }
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
  const path = Path.join(
    await activeClaudeProjectRoot(stateDir, threadId),
    "project",
    `${sessionId}.jsonl`,
  );
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
  const owner = await readClaudeThreadAccount(input.stateDir, input.threadId);
  if (owner === null || !claudeAccountsMatch(owner, input.account)) {
    throw new Error(
      "This thread's Claude conversation belongs to a different Claude account. Use a Connection signed in to that account, or start a new thread.",
    );
  }
}

/** A switch may authorize one new account only after its exact binding commits. */
export async function stageClaudeThreadAccountTransition(input: {
  readonly stateDir: string;
  readonly threadId: string;
  readonly transition: ClaudeThreadAccountTransition;
}): Promise<void> {
  const owner = await readClaudeThreadAccount(input.stateDir, input.threadId);
  if (owner === null || !claudeAccountsMatch(owner, input.transition.source)) {
    throw new Error("The Claude Thread account changed before the provider switch.");
  }
  const existing = await readClaudeAccountTransition(input.stateDir, input.threadId);
  if (existing !== null) {
    if (JSON.stringify(existing) !== JSON.stringify(input.transition)) {
      throw new Error("A different Claude account transition is already pending.");
    }
  }
  const root = claudeThreadStateRoot(input.stateDir, input.threadId);
  const sourceRoot = await activeClaudeProjectRoot(input.stateDir, input.threadId);
  const targetRoot = scopedClaudeProjectRoot(
    input.stateDir,
    input.threadId,
    input.transition.target,
    input.transition.bindingRevision,
  );
  if (sourceRoot === targetRoot)
    throw new Error("The Claude account switch has no distinct storage.");
  // Persist the cleanup intent before any target revision is created. If a
  // copy fails or the process crashes halfway through it, recovery can remove
  // that exact revision using this marker.
  const path = Path.join(root, CLAUDE_THREAD_ACCOUNT_TRANSITION_FILE);
  const staging = `${path}.penkra-${randomUUID()}`;
  await writeSyncedFile(staging, `${JSON.stringify(input.transition)}\n`);
  try {
    await link(staging, path).catch(async (cause: NodeJS.ErrnoException) => {
      if (cause.code !== "EEXIST") throw cause;
      const pending: unknown = JSON.parse(await readFile(path, "utf8"));
      if (JSON.stringify(pending) !== JSON.stringify(input.transition)) {
        throw new Error("A different Claude account transition is already pending.");
      }
    });
    await syncDirectory(root);
  } finally {
    await rm(staging, { force: true });
  }
  if (existing !== null) {
    // Verification may have written a disposable probe into this revision.
    // Unlink the target profile first, then rebuild the whole copy from the
    // settled source so no probe transcript or sidecar survives the commit.
    await revokeClaudeThreadAccountTransitionLinks({
      stateDir: input.stateDir,
      threadId: input.threadId,
      commandId: input.transition.commandId,
    });
    await rm(targetRoot, { recursive: true, force: true });
    await syncDirectory(Path.dirname(targetRoot));
  }
  await mkdir(targetRoot, { recursive: true, mode: 0o700 });
  for (const name of ["project", ...CLAUDE_SESSION_SIDECARS]) {
    const source = Path.join(sourceRoot, name);
    if ((await statOrNull(source))?.isDirectory()) {
      await cp(source, Path.join(targetRoot, name), { recursive: true, force: true });
    }
  }
  await syncCopiedTree(targetRoot);
  await syncDirectory(Path.dirname(targetRoot));
  await syncDirectory(root);
}

export async function revokeClaudeThreadAccountTransitionLinks(input: {
  readonly stateDir: string;
  readonly threadId: string;
  readonly commandId: string;
}): Promise<void> {
  const pending = await readClaudeAccountTransition(input.stateDir, input.threadId);
  if (pending?.commandId !== input.commandId) return;
  const targetRoot = scopedClaudeProjectRoot(
    input.stateDir,
    input.threadId,
    pending.target,
    pending.bindingRevision,
  );
  await removeClaudeProfileLinks(
    input.stateDir,
    input.threadId,
    (_path, target) => target === Path.join(targetRoot, "project"),
  );
}

export async function discardClaudeThreadAccountTransition(input: {
  readonly stateDir: string;
  readonly threadId: string;
  readonly commandId: string;
}): Promise<void> {
  const pending = await readClaudeAccountTransition(input.stateDir, input.threadId);
  if (pending?.commandId !== input.commandId) return;
  await revokeClaudeThreadAccountTransitionLinks(input);
  const targetRoot = scopedClaudeProjectRoot(
    input.stateDir,
    input.threadId,
    pending.target,
    pending.bindingRevision,
  );
  await rm(targetRoot, { recursive: true, force: true });
  await syncDirectory(Path.dirname(targetRoot));
  const path = Path.join(
    claudeThreadStateRoot(input.stateDir, input.threadId),
    CLAUDE_THREAD_ACCOUNT_TRANSITION_FILE,
  );
  await rm(path, { force: true });
  await syncDirectory(Path.dirname(path));
}

async function removeClaudeProfileLinks(
  stateDir: string,
  threadId: string,
  shouldRemove: (path: string, target: string) => boolean,
): Promise<void> {
  const profilesRoot = Path.join(stateDir, "provider-connections");
  const projectName = claudeThreadProjectName(threadId);
  for (const entry of await readdir(profilesRoot, { withFileTypes: true }).catch(
    (cause: NodeJS.ErrnoException) => {
      if (cause.code === "ENOENT") return [];
      throw cause;
    },
  )) {
    if (!entry.isDirectory()) continue;
    const path = Path.join(profilesRoot, entry.name, "claude-config", "projects", projectName);
    if ((await statOrNull(path))?.isSymbolicLink() && shouldRemove(path, await readlink(path))) {
      await rm(path);
      await syncDirectory(Path.dirname(path));
    }
  }
}

async function completeClaudeThreadAccountTransition(input: {
  readonly stateDir: string;
  readonly threadId: string;
  readonly connectionId: string;
  readonly bindingConnectionId: string | null;
  readonly bindingRevision: number;
  readonly account: ClaudeThreadAccount;
  readonly configDir: string;
}): Promise<void> {
  const root = claudeThreadStateRoot(input.stateDir, input.threadId);
  const path = Path.join(root, CLAUDE_THREAD_ACCOUNT_TRANSITION_FILE);
  const raw = await readFile(path, "utf8").catch((cause: NodeJS.ErrnoException) => {
    if (cause.code === "ENOENT") return null;
    throw cause;
  });
  const transition: unknown = raw === null ? null : JSON.parse(raw);
  const record = transition as Partial<ClaudeThreadAccountTransition> | null;
  const owner = await readClaudeThreadAccount(input.stateDir, input.threadId);
  if (
    record === null ||
    record.connectionId !== input.connectionId ||
    record.connectionId !== input.bindingConnectionId ||
    record.bindingRevision !== input.bindingRevision ||
    !record.source ||
    !record.target ||
    owner === null ||
    (!claudeAccountsMatch(owner, record.source) && !claudeAccountsMatch(owner, record.target)) ||
    !claudeAccountsMatch(input.account, record.target)
  ) {
    throw new Error(
      "This thread's Claude conversation belongs to a different Claude account. Use a Connection signed in to that account, or start a new thread.",
    );
  }
  const keep = Path.resolve(input.configDir, "projects", claudeThreadProjectName(input.threadId));
  await removeClaudeProfileLinks(
    input.stateDir,
    input.threadId,
    (path) => Path.resolve(path) !== keep,
  );
  const ownerPath = Path.join(root, CLAUDE_THREAD_ACCOUNT_FILE);
  if (
    !claudeAccountsMatch(owner, record.target) ||
    owner.projectRevision !== record.bindingRevision
  ) {
    const staging = `${ownerPath}.penkra-${randomUUID()}`;
    await writeSyncedFile(
      staging,
      `${JSON.stringify({ ...record.target, projectRevision: record.bindingRevision })}\n`,
    );
    try {
      await rename(staging, ownerPath);
      await syncDirectory(root);
    } finally {
      await rm(staging, { force: true });
    }
  }
  await rm(path, { force: true });
  await syncDirectory(root);
}

async function readClaudeAccountTransition(stateDir: string, threadId: string) {
  const raw = await readFile(
    Path.join(claudeThreadStateRoot(stateDir, threadId), CLAUDE_THREAD_ACCOUNT_TRANSITION_FILE),
    "utf8",
  ).catch((cause: NodeJS.ErrnoException) => {
    if (cause.code === "ENOENT") return null;
    throw cause;
  });
  return raw === null ? null : (JSON.parse(raw) as ClaudeThreadAccountTransition);
}

export async function claudeAccountTransitionMatchesCommittedBinding(input: {
  readonly stateDir: string;
  readonly threadId: string;
  readonly connectionId: string;
  readonly bindingRevision: number;
  readonly account: ClaudeThreadAccount;
}) {
  const pending = await readClaudeAccountTransition(input.stateDir, input.threadId);
  return (
    pending !== null &&
    pending.connectionId === input.connectionId &&
    pending.bindingRevision === input.bindingRevision &&
    claudeAccountsMatch(pending.target, input.account)
  );
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
  readonly connectionId?: string;
  readonly bindingConnectionId?: string | null;
  readonly bindingRevision?: number;
}): Promise<string> {
  const projectName = claudeThreadProjectName(input.threadId);
  let projectRoot = claudeThreadStateRoot(input.stateDir, input.threadId);
  if (input.account !== undefined) {
    const owner = await readClaudeThreadAccount(input.stateDir, input.threadId);
    const pending = await readClaudeAccountTransition(input.stateDir, input.threadId);
    const targetPending =
      pending !== null &&
      input.connectionId === pending.connectionId &&
      claudeAccountsMatch(input.account, pending.target);
    const bindingCommitted =
      targetPending &&
      input.bindingConnectionId === pending.connectionId &&
      input.bindingRevision === pending.bindingRevision;
    const verifyingBeforeCommit =
      targetPending &&
      owner !== null &&
      claudeAccountsMatch(owner, pending.source) &&
      input.bindingConnectionId !== pending.connectionId &&
      input.bindingRevision === pending.bindingRevision - 1;
    if (bindingCommitted) {
      await completeClaudeThreadAccountTransition({
        stateDir: input.stateDir,
        threadId: input.threadId,
        connectionId: input.connectionId!,
        bindingConnectionId: input.bindingConnectionId!,
        bindingRevision: input.bindingRevision!,
        account: input.account,
        configDir: input.configDir,
      });
    } else if (
      owner !== null &&
      !claudeAccountsMatch(owner, input.account) &&
      !verifyingBeforeCommit
    ) {
      throw new Error(
        "This thread's Claude conversation belongs to a different Claude account. Use a Connection signed in to that account, or start a new thread.",
      );
    }
    if (verifyingBeforeCommit) {
      projectRoot = scopedClaudeProjectRoot(
        input.stateDir,
        input.threadId,
        input.account,
        pending!.bindingRevision,
      );
    } else {
      // A pre-upgrade Thread's first account still uses its original project.
      projectRoot = await activeClaudeProjectRoot(input.stateDir, input.threadId);
    }
    if (!verifyingBeforeCommit) {
      await rememberClaudeThreadAccount({
        stateDir: input.stateDir,
        threadId: input.threadId,
        account: input.account,
      });
    }
  }
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
