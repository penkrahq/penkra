import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import type { LocalModelEntry } from "./localModelCatalog.ts";
import { downloadLocalModel, isLocalModelDownloaded, localModelDirectory } from "./localModelDownloads.ts";

const entry: LocalModelEntry = {
  id: "tiny",
  label: "Tiny",
  repo: "org/tiny",
  revision: "main",
  downloadGb: 0,
  minMemoryGb: 1,
  contextTokens: 1000,
  defaultContextTokens: 1000,
  maxOutputTokens: 100,
  thinkingBudgetChars: 1000,
  note: "",
};
const weights = Buffer.from("0123456789".repeat(100));
const sha = createHash("sha256").update(weights).digest("hex");

function fakeHub(opts: { corrupt?: boolean } = {}) {
  const ranges: (string | null)[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    if (url.includes("/api/models/")) {
      return Response.json([
        { type: "file", path: "config.json", size: 2 },
        { type: "file", path: "model.safetensors", size: 1, lfs: { oid: sha, size: weights.length } },
        { type: "file", path: "README.md", size: 5 },
      ]);
    }
    const range = (init?.headers as Record<string, string> | undefined)?.range ?? null;
    ranges.push(range);
    if (url.endsWith("config.json")) return new Response("{}");
    const body = opts.corrupt ? Buffer.alloc(weights.length) : weights;
    if (range) {
      const start = Number(/bytes=(\d+)-/.exec(range)![1]);
      return new Response(body.subarray(start), { status: 206 });
    }
    return new Response(body);
  }) as unknown as typeof fetch;
  return { fetchImpl, ranges };
}

const plenty = async () => 100 * 1024 ** 3;

describe("downloadLocalModel", () => {
  it("downloads, verifies, reports progress, and marks complete", async () => {
    const stateDir = mkdtempSync(path.join(tmpdir(), "lm-"));
    const progress: number[] = [];
    const { fetchImpl } = fakeHub();
    const dir = await downloadLocalModel({ stateDir, entry, fetchImpl, freeBytes: plenty, onProgress: (p) => progress.push(p.receivedBytes) });
    expect(readFileSync(path.join(dir, "model.safetensors"))).toEqual(weights);
    expect(progress.at(-1)).toBe(weights.length + 2);
    expect(await isLocalModelDownloaded(stateDir, entry)).toBe(true);
  });

  it("resumes a partial file with a range request", async () => {
    const stateDir = mkdtempSync(path.join(tmpdir(), "lm-"));
    const dir = localModelDirectory(stateDir, entry);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "model.safetensors.part"), weights.subarray(0, 400));
    const { fetchImpl, ranges } = fakeHub();
    await downloadLocalModel({ stateDir, entry, fetchImpl, freeBytes: plenty });
    expect(ranges).toContain("bytes=400-");
    expect(readFileSync(path.join(dir, "model.safetensors"))).toEqual(weights);
  });

  it("rejects corrupted weights", async () => {
    const stateDir = mkdtempSync(path.join(tmpdir(), "lm-"));
    await expect(downloadLocalModel({ stateDir, entry, fetchImpl: fakeHub({ corrupt: true }).fetchImpl, freeBytes: plenty })).rejects.toThrow(/corrupted/);
    expect(await isLocalModelDownloaded(stateDir, entry)).toBe(false);
  });

  it("refuses to start without enough free disk, saying how much is needed", async () => {
    const stateDir = mkdtempSync(path.join(tmpdir(), "lm-"));
    await expect(
      downloadLocalModel({ stateDir, entry, fetchImpl: fakeHub().fetchImpl, freeBytes: async () => 1024 ** 3 }),
    ).rejects.toThrow(/Needs 5\.0 GB free disk space — 1\.0 GB available/);
  });
});
