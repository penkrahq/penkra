// FILE: claudeManagedNativeState.ts
// Purpose: Preserve and resolve Claude sessions across immutable credential-profile rotations.

import { createReadStream } from "node:fs";
import { copyFile, cp, lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import * as Path from "node:path";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";

export type ClaudeSessionCandidate = {
  readonly profileRoot: string;
  readonly transcriptPath: string;
  readonly hasConversation: boolean;
};

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw cause;
  }
}

async function visitClaudeTranscripts(root: string): Promise<string[]> {
  const matches: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true }).catch(
      (cause: NodeJS.ErrnoException) => {
        if (cause.code === "ENOENT") return [];
        throw cause;
      },
    );
    for (const entry of entries) {
      const entryPath = Path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(entryPath);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) matches.push(entryPath);
    }
  };
  await visit(Path.join(root, "claude-config", "projects"));
  return matches;
}

async function transcriptHasConversation(path: string): Promise<boolean> {
  const lines = createInterface({
    input: createReadStream(path),
    crlfDelay: Infinity,
  });
  try {
    for await (const line of lines) {
      if (line.trim().length === 0) continue;
      let decoded: unknown;
      try {
        decoded = JSON.parse(line);
      } catch {
        continue;
      }
      if (
        typeof decoded === "object" &&
        decoded !== null &&
        "type" in decoded &&
        (decoded.type === "user" || decoded.type === "assistant")
      ) {
        return true;
      }
    }
    return false;
  } finally {
    lines.close();
  }
}

async function isFilePrefix(prefixPath: string, fullPath: string): Promise<boolean> {
  const [prefixStat, fullStat] = await Promise.all([lstat(prefixPath), lstat(fullPath)]);
  if (!prefixStat.isFile() || !fullStat.isFile() || prefixStat.size > fullStat.size) return false;
  const [prefix, full] = await Promise.all([open(prefixPath, "r"), open(fullPath, "r")]);
  try {
    const chunkSize = 64 * 1024;
    let offset = 0;
    while (offset < prefixStat.size) {
      const length = Math.min(chunkSize, prefixStat.size - offset);
      const [left, right] = await Promise.all([
        prefix.read(Buffer.allocUnsafe(length), 0, length, offset),
        full.read(Buffer.allocUnsafe(length), 0, length, offset),
      ]);
      if (
        left.bytesRead !== length ||
        right.bytesRead !== length ||
        !left.buffer.subarray(0, length).equals(right.buffer.subarray(0, length))
      ) {
        return false;
      }
      offset += length;
    }
    return true;
  } finally {
    await Promise.all([prefix.close(), full.close()]);
  }
}

async function chooseCandidate(
  candidates: readonly ClaudeSessionCandidate[],
): Promise<ClaudeSessionCandidate> {
  if (candidates.length === 0) throw new Error("The exact Claude session is unavailable.");
  let selected = candidates[0]!;
  for (const candidate of candidates.slice(1)) {
    if (selected.hasConversation !== candidate.hasConversation) {
      if (candidate.hasConversation) selected = candidate;
      continue;
    }
    if (!selected.hasConversation) continue;
    if (await isFilePrefix(selected.transcriptPath, candidate.transcriptPath)) {
      selected = candidate;
      continue;
    }
    if (await isFilePrefix(candidate.transcriptPath, selected.transcriptPath)) continue;
    throw new Error("Multiple divergent Claude conversations exist for this session.");
  }
  return selected;
}

export async function resolveClaudeSessionCandidate(input: {
  readonly profileRoots: readonly string[];
  readonly providerSessionId: string;
}): Promise<ClaudeSessionCandidate> {
  const candidates: ClaudeSessionCandidate[] = [];
  for (const profileRoot of input.profileRoots) {
    const matches = (await visitClaudeTranscripts(profileRoot)).filter(
      (path) => Path.basename(path) === `${input.providerSessionId}.jsonl`,
    );
    if (matches.length > 1) {
      throw new Error("More than one exact Claude session exists in one credential profile.");
    }
    if (matches[0]) {
      candidates.push({
        profileRoot,
        transcriptPath: matches[0],
        hasConversation: await transcriptHasConversation(matches[0]),
      });
    }
  }
  return chooseCandidate(candidates);
}

async function atomicCopyFile(source: string, target: string): Promise<void> {
  await mkdir(Path.dirname(target), { recursive: true, mode: 0o700 });
  const staging = Path.join(
    Path.dirname(target),
    `.staging-${Path.basename(target)}-${randomUUID()}`,
  );
  try {
    await copyFile(source, staging);
    await rename(staging, target);
  } catch (cause) {
    await rm(staging, { force: true });
    throw cause;
  }
}

async function copyOptionalEntry(source: string, target: string): Promise<void> {
  if (!(await exists(source)) || (await exists(target))) return;
  await mkdir(Path.dirname(target), { recursive: true, mode: 0o700 });
  const staging = Path.join(
    Path.dirname(target),
    `.staging-${Path.basename(target)}-${randomUUID()}`,
  );
  try {
    await cp(source, staging, {
      recursive: true,
      force: false,
      errorOnExist: true,
      preserveTimestamps: true,
      verbatimSymlinks: true,
    });
    await rename(staging, target);
  } catch (cause) {
    await rm(staging, { recursive: true, force: true });
    throw cause;
  }
}

export async function synchronizeClaudeSession(input: {
  readonly sourceProfileRoot: string;
  readonly targetProfileRoot: string;
  readonly providerSessionId: string;
}): Promise<"copied" | "kept" | "replaced"> {
  const source = await resolveClaudeSessionCandidate({
    profileRoots: [input.sourceProfileRoot],
    providerSessionId: input.providerSessionId,
  });
  const targetMatches = await resolveClaudeSessionCandidate({
    profileRoots: [input.targetProfileRoot],
    providerSessionId: input.providerSessionId,
  }).catch((cause: unknown) => {
    if (cause instanceof Error && cause.message === "The exact Claude session is unavailable.") {
      return null;
    }
    throw cause;
  });

  let outcome: "copied" | "kept" | "replaced";
  let targetTranscript: string;
  if (targetMatches === null) {
    targetTranscript = Path.join(
      input.targetProfileRoot,
      Path.relative(input.sourceProfileRoot, source.transcriptPath),
    );
    await atomicCopyFile(source.transcriptPath, targetTranscript);
    outcome = "copied";
  } else {
    targetTranscript = targetMatches.transcriptPath;
    const selected = await chooseCandidate([targetMatches, source]);
    if (selected.transcriptPath === targetMatches.transcriptPath) {
      outcome = "kept";
    } else {
      await atomicCopyFile(source.transcriptPath, targetTranscript);
      outcome = "replaced";
    }
  }

  if (outcome !== "kept") {
    const sourceStem = source.transcriptPath.slice(0, -".jsonl".length);
    const targetStem = targetTranscript.slice(0, -".jsonl".length);
    await copyOptionalEntry(sourceStem, targetStem);
    for (const directory of ["session-env", "tasks"] as const) {
      await copyOptionalEntry(
        Path.join(input.sourceProfileRoot, "claude-config", directory, input.providerSessionId),
        Path.join(input.targetProfileRoot, "claude-config", directory, input.providerSessionId),
      );
    }
  }
  return outcome;
}

export async function synchronizeClaudeSessions(input: {
  readonly sourceProfileRoot: string;
  readonly targetProfileRoot: string;
}): Promise<{
  readonly copied: number;
  readonly kept: number;
  readonly replaced: number;
}> {
  const totals = { copied: 0, kept: 0, replaced: 0 };
  const transcripts = await visitClaudeTranscripts(input.sourceProfileRoot);
  const sessionIds = [...new Set(transcripts.map((path) => Path.basename(path, ".jsonl")))];
  for (const providerSessionId of sessionIds) {
    const outcome = await synchronizeClaudeSession({
      ...input,
      providerSessionId,
    });
    totals[outcome] += 1;
  }
  return totals;
}
