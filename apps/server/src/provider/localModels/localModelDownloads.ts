// FILE: localModelDownloads.ts
// Purpose: Downloads a catalog model's MLX weights into Penkra's own model store,
// with progress, resume after interruption, sha256 verification, and a free-space
// check before starting.

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, rename, rm, stat, statfs, writeFile } from "node:fs/promises";
import path from "node:path";

import type { LocalModelEntry } from "./localModelCatalog.ts";

interface RemoteFile {
  readonly path: string;
  readonly size: number;
  readonly sha256: string | null;
}

export interface LocalModelDownloadProgress {
  readonly receivedBytes: number;
  readonly totalBytes: number;
}

const HF = "https://huggingface.co";
// Leave room for the OS and swap after the download lands.
const FREE_SPACE_MARGIN_BYTES = 5 * 1024 ** 3;

export function localModelDirectory(stateDir: string, entry: LocalModelEntry): string {
  return path.join(stateDir, "local-models", "models", entry.id);
}

export async function isLocalModelDownloaded(stateDir: string, entry: LocalModelEntry): Promise<boolean> {
  try {
    const marker = await readFile(path.join(localModelDirectory(stateDir, entry), ".complete"), "utf8");
    return marker.trim() === `${entry.repo}@${entry.revision}`;
  } catch {
    return false;
  }
}

export async function downloadLocalModel(input: {
  readonly stateDir: string;
  readonly entry: LocalModelEntry;
  readonly onProgress?: (progress: LocalModelDownloadProgress) => void;
  readonly signal?: AbortSignal;
  readonly fetchImpl?: typeof fetch;
  readonly freeBytes?: (dir: string) => Promise<number>;
}): Promise<string> {
  const { entry, stateDir } = input;
  const doFetch = input.fetchImpl ?? fetch;
  const dir = localModelDirectory(stateDir, entry);
  if (await isLocalModelDownloaded(stateDir, entry)) return dir;
  await mkdir(dir, { recursive: true });

  const listing = await doFetch(`${HF}/api/models/${entry.repo}/tree/${entry.revision}?recursive=1`, { ...(input.signal ? { signal: input.signal } : {}) });
  if (!listing.ok) throw new Error(`Could not look up ${entry.label} (${listing.status}).`);
  const files: RemoteFile[] = ((await listing.json()) as Array<{
    type: string;
    path: string;
    size: number;
    lfs?: { oid: string; size: number };
  }>)
    .filter((f) => f.type === "file" && !f.path.startsWith(".") && f.path !== "README.md")
    .map((f) => ({ path: f.path, size: f.lfs?.size ?? f.size, sha256: f.lfs?.oid ?? null }));

  const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
  let receivedBytes = 0;
  for (const f of files) receivedBytes += await existingBytes(path.join(dir, f.path), f);
  const needed = totalBytes - receivedBytes + FREE_SPACE_MARGIN_BYTES;
  const free = await (input.freeBytes ?? freeDiskBytes)(dir);
  if (free < needed) {
    throw new Error(`Needs ${gb(needed)} GB free disk space — ${gb(free)} GB available.`);
  }
  input.onProgress?.({ receivedBytes, totalBytes });

  for (const file of files) {
    const target = path.join(dir, file.path);
    if (path.relative(dir, target).startsWith("..")) throw new Error(`Unsafe file path ${file.path}`);
    if ((await existingBytes(target, file)) === file.size && (await fileExists(target))) continue;
    await mkdir(path.dirname(target), { recursive: true });
    const partial = `${target}.part`;
    const have = await sizeOf(partial);
    const response = await doFetch(`${HF}/${entry.repo}/resolve/${entry.revision}/${file.path}`, {
      headers: have > 0 ? { range: `bytes=${have}-` } : {},
      ...(input.signal ? { signal: input.signal } : {}),
    });
    if (!response.ok || !response.body) throw new Error(`Download of ${entry.label} failed (${response.status}).`);
    const resumed = have > 0 && response.status === 206;
    if (!resumed) receivedBytes -= have;
    const handle = await open(partial, resumed ? "a" : "w");
    try {
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        await handle.write(chunk);
        receivedBytes += chunk.byteLength;
        input.onProgress?.({ receivedBytes, totalBytes });
      }
    } finally {
      await handle.close();
    }
    if (file.sha256 && (await sha256File(partial)) !== file.sha256) {
      await rm(partial, { force: true });
      throw new Error(`${entry.label} download was corrupted; try again.`);
    }
    await rename(partial, target);
  }
  await writeFile(path.join(dir, ".complete"), `${entry.repo}@${entry.revision}`);
  return dir;
}

async function existingBytes(target: string, file: RemoteFile): Promise<number> {
  const done = await sizeOf(target);
  if (done === file.size) return done;
  return sizeOf(`${target}.part`);
}

async function fileExists(p: string): Promise<boolean> {
  return stat(p).then(
    () => true,
    () => false,
  );
}

async function sizeOf(p: string): Promise<number> {
  return stat(p).then(
    (s) => s.size,
    () => 0,
  );
}

async function freeDiskBytes(dir: string): Promise<number> {
  const s = await statfs(dir);
  return Number(s.bavail) * Number(s.bsize);
}

function sha256File(p: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(p)
      .on("data", (d) => hash.update(d))
      .on("end", () => resolve(hash.digest("hex")))
      .on("error", reject);
  });
}

const gb = (bytes: number) => (bytes / 1024 ** 3).toFixed(1);
