// FILE: codexManagedNativeState.ts
// Purpose: Keep Codex rollout files generation-owned while exposing them in one Connection profile.

import { link, lstat, mkdir, readdir, rm } from "node:fs/promises";
import * as Path from "node:path";

import type { ProviderManagedLaunchContext } from "./Services/ProviderAdapter.ts";

const CODEX_ROLLOUT_COLLECTIONS = ["sessions", "archived_sessions"] as const;
const MANAGED_ROLLOUT_ROOT = "codex-rollouts";

function requireNativeThreadId(value: string): string {
  const threadId = value.trim();
  if (
    threadId.length === 0 ||
    threadId === "." ||
    threadId === ".." ||
    threadId.includes("/") ||
    threadId.includes("\\") ||
    threadId.includes("\0")
  ) {
    throw new Error("Codex returned an invalid native thread id.");
  }
  return threadId;
}

const isExactRollout = (name: string, threadId: string): boolean =>
  name.startsWith("rollout-") && name.endsWith(`-${threadId}.jsonl`);

async function collectExactRollouts(root: string, threadId: string): Promise<string[]> {
  const found: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true }).catch(
      (cause: NodeJS.ErrnoException) => {
        if (cause.code === "ENOENT") return [];
        throw cause;
      },
    );
    for (const entry of entries) {
      const entryPath = Path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(entryPath);
      } else if (entry.isFile() && isExactRollout(entry.name, threadId)) {
        found.push(entryPath);
      }
    }
  };
  await visit(root);
  return found;
}

export async function requireOneExactCodexRollout(
  root: string,
  nativeThreadIdValue: string,
): Promise<string> {
  const threadId = requireNativeThreadId(nativeThreadIdValue);
  const matches = await collectExactRollouts(root, threadId);
  if (matches.length !== 1) {
    throw new Error(
      matches.length === 0
        ? "The exact Codex rollout is unavailable."
        : "More than one exact Codex rollout exists.",
    );
  }
  return matches[0]!;
}

async function sameFile(left: string, right: string): Promise<boolean> {
  const [leftStat, rightStat] = await Promise.all([lstat(left), lstat(right)]);
  return leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino;
}

const profileCodexHome = (launch: ProviderManagedLaunchContext): string =>
  Path.join(launch.profileRoot, "codex-home");

const generationRolloutHome = (launch: ProviderManagedLaunchContext): string =>
  Path.join(launch.nativeStateRoot, MANAGED_ROLLOUT_ROOT);

/**
 * Adopt a newly created rollout without moving or copying it. The generation
 * gains a second directory entry for the same inode, so either side survives a
 * crash and every later append remains generation-owned.
 */
export async function adoptManagedCodexRollout(
  launch: ProviderManagedLaunchContext,
  nativeThreadIdValue: string,
): Promise<void> {
  const nativeThreadId = requireNativeThreadId(nativeThreadIdValue);
  const profileHome = profileCodexHome(launch);
  const profileRollout = await requireOneExactCodexRollout(profileHome, nativeThreadId);
  const relativePath = Path.relative(profileHome, profileRollout);
  if (relativePath.startsWith("..") || Path.isAbsolute(relativePath)) {
    throw new Error("The exact Codex rollout escaped its Connection profile.");
  }
  const generationRollout = Path.join(generationRolloutHome(launch), relativePath);
  await mkdir(Path.dirname(generationRollout), { recursive: true, mode: 0o700 });
  try {
    await link(profileRollout, generationRollout);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
    if (!(await sameFile(profileRollout, generationRollout))) {
      throw new Error("The Codex generation already contains a different exact rollout.");
    }
  }
}

/**
 * Point the selected Connection profile at the cloned generation before Codex
 * attempts a native resume. Stale links for this exact provider thread are
 * removed; no other thread in the profile is touched.
 */
export async function prepareManagedCodexResume(
  launch: ProviderManagedLaunchContext,
  nativeThreadIdValue: string,
): Promise<void> {
  const nativeThreadId = requireNativeThreadId(nativeThreadIdValue);
  const generationHome = generationRolloutHome(launch);
  const generationRollout = await requireOneExactCodexRollout(generationHome, nativeThreadId);
  const relativePath = Path.relative(generationHome, generationRollout);
  if (relativePath.startsWith("..") || Path.isAbsolute(relativePath)) {
    throw new Error("The exact Codex rollout escaped its native-state generation.");
  }

  const profileHome = profileCodexHome(launch);
  const target = Path.join(profileHome, relativePath);
  await mkdir(Path.dirname(target), { recursive: true, mode: 0o700 });
  for (const collection of CODEX_ROLLOUT_COLLECTIONS) {
    const collectionRoot = Path.join(profileHome, collection);
    for (const existing of await collectExactRollouts(collectionRoot, nativeThreadId)) {
      if (existing === target && (await sameFile(existing, generationRollout))) return;
      await rm(existing, { force: true });
    }
  }
  await link(generationRollout, target);
}
