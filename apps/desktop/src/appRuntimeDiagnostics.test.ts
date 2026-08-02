import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AppRuntimeDiagnostics } from "./appRuntimeDiagnostics";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("AppRuntimeDiagnostics", () => {
  it("serializes concurrent records and returns newest matching evidence first", async () => {
    const root = await mkdtemp(join(tmpdir(), "penkra-app-diagnostics-"));
    roots.push(root);
    const diagnostics = new AppRuntimeDiagnostics(join(root, "diagnostics.jsonl"));

    await Promise.all([
      diagnostics.record({
        kind: "tab-opened",
        appId: "com.example.canvas",
        spaceId: "personal",
        tabId: "a",
      }),
      diagnostics.record({
        kind: "tab-ready",
        appId: "com.example.canvas",
        spaceId: "personal",
        tabId: "a",
        durationMs: 12,
      }),
      diagnostics.record({
        kind: "tab-opened",
        appId: "com.example.other",
        spaceId: "work",
        tabId: "b",
      }),
    ]);

    const entries = await diagnostics.list({ appId: "com.example.canvas" });
    expect(entries.map((entry) => entry.kind)).toEqual(["tab-ready", "tab-opened"]);
    expect(
      (await readFile(join(root, "diagnostics.jsonl"), "utf8")).trim().split("\n"),
    ).toHaveLength(3);
  });

  it("fails visibly when the journal contains invalid data", async () => {
    const root = await mkdtemp(join(tmpdir(), "penkra-app-diagnostics-"));
    roots.push(root);
    const path = join(root, "diagnostics.jsonl");
    await writeFile(path, "not-json\n");

    await expect(new AppRuntimeDiagnostics(path).list()).rejects.toThrow("record 1 is invalid");
  });
});
