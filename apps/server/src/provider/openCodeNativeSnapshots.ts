// Preserve only snapshot trees referenced by the pinned native conversation.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { Part } from "@opencode-ai/sdk/v2";

const execute = promisify(execFile);

export async function preserveOpenCodeNativeSnapshots(input: {
  readonly parts: readonly Part[];
  readonly revertSnapshot?: string;
  readonly projectID: string;
  readonly worktree: string;
  readonly sourceDataRoot: string;
  readonly targetDataRoot: string;
  readonly env: NodeJS.ProcessEnv;
  readonly signal: AbortSignal;
}): Promise<void> {
  const hashes = new Set<string>(input.revertSnapshot === undefined ? [] : [input.revertSnapshot]);
  for (const part of input.parts) {
    if (part.type === "patch") hashes.add(part.hash);
    else if (
      (part.type === "snapshot" || part.type === "step-start" || part.type === "step-finish") &&
      part.snapshot !== undefined
    )
      hashes.add(part.snapshot);
  }
  if (hashes.size === 0) return;
  if (
    !input.projectID ||
    input.projectID === "." ||
    input.projectID === ".." ||
    input.projectID.includes("/") ||
    input.projectID.includes("\\")
  )
    throw new Error("Invalid native OpenCode snapshot project identity.");
  if (![input.worktree, input.sourceDataRoot, input.targetDataRoot].every(path.isAbsolute))
    throw new Error("OpenCode snapshot locations must be absolute.");
  for (const hash of hashes)
    if (!/^[a-f0-9]{40}$/.test(hash))
      throw new Error("Invalid native OpenCode snapshot tree identity.");
  const relative = path.join(
    "snapshot",
    input.projectID,
    createHash("sha1").update(input.worktree).digest("hex"),
  );
  const source = path.join(input.sourceDataRoot, relative);
  const target = path.join(input.targetDataRoot, relative);
  if (source === target) throw new Error("OpenCode snapshot source and destination are identical.");
  const git = (args: string[], stdin?: string, maxBuffer?: number) => {
    const running = execute("git", ["-c", "maintenance.auto=false", "-c", "gc.auto=0", ...args], {
      env: input.env,
      signal: input.signal,
      ...(maxBuffer === undefined ? {} : { maxBuffer }),
    });
    running.child.stdin?.end(stdin);
    return running;
  };
  const trees = [...hashes].map((hash) => `${hash}^{tree}\n`).join("");
  const expected = [...hashes].map((hash) => `${hash} tree\n`).join("");
  const verify = async (repository: string) => {
    const result = await git(
      ["--git-dir", repository, "cat-file", "--batch-check=%(objectname) %(objecttype)"],
      trees,
      Buffer.byteLength(expected),
    );
    if (result.stdout !== expected)
      throw new Error("OpenCode snapshot repository is missing a referenced tree.");
  };
  await verify(source);
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await git(["init", "--bare", "--quiet", target]);
  // Fetch merges immutable objects. It neither replaces a peer repository nor
  // needs refs that would change native snapshot retention semantics.
  await git(
    [
      "--git-dir",
      target,
      "fetch",
      "--quiet",
      "--stdin",
      "--no-tags",
      "--no-write-fetch-head",
      "--",
      source,
    ],
    [...hashes].join("\n") + "\n",
  );
  await verify(target);
}
