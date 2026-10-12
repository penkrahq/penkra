import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadLocalProviderUsageLines } from "./providerUsageSnapshot";

describe("local archive usage reads", () => {
  let homePath: string;
  let archivePath: string;

  beforeEach(async () => {
    homePath = await fs.mkdtemp(path.join(os.tmpdir(), "penkra-usage-"));
    const now = new Date();
    const dayDir = path.join(
      homePath,
      "sessions",
      String(now.getFullYear()),
      String(now.getMonth() + 1).padStart(2, "0"),
      String(now.getDate()).padStart(2, "0"),
    );
    await fs.mkdir(dayDir, { recursive: true });
    archivePath = path.join(dayDir, "session.jsonl");
    await writeUsage(10);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(homePath, { recursive: true, force: true });
  });

  async function writeUsage(totalTokens: number) {
    await fs.writeFile(
      archivePath,
      JSON.stringify({
        type: "event_msg",
        timestamp: new Date().toISOString(),
        payload: { type: "token_count", total_tokens: totalTokens },
      }),
    );
  }

  function readUsage() {
    return loadLocalProviderUsageLines({
      provider: "codex",
      homeDir: homePath,
      homePath,
    });
  }

  it("reads the archive again on sequential requests", async () => {
    const read = vi.spyOn(fs, "readFile");
    const first = await readUsage();
    await writeUsage(20);
    const second = await readUsage();
    expect(read).toHaveBeenCalledTimes(2);
    expect(first.length).toBeGreaterThan(0);
    expect(second).not.toEqual(first);
  });

  it("shares an archive read only while concurrent requests are pending", async () => {
    const originalRead = fs.readFile.bind(fs);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const read = vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
      entered.resolve();
      await release.promise;
      return originalRead(...args);
    });
    const first = readUsage();
    await entered.promise;
    const second = readUsage();
    release.resolve();
    const results = await Promise.all([first, second]);
    expect(read).toHaveBeenCalledTimes(1);
    expect(results[0].length).toBeGreaterThan(0);
    expect(results[1]).toEqual(results[0]);
    await readUsage();
    expect(read).toHaveBeenCalledTimes(2);
  });
});
