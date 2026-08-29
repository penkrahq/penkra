import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { APP_RUNTIME_DIAGNOSTICS_MAX_BYTES, AppRuntimeDiagnostics } from "./appRuntimeDiagnostics";

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
      diagnostics.record({
        kind: "app-update-failed",
        appId: "com.example.canvas",
        spaceId: "personal",
        operation: "automatic-update",
        message: "Verified package activation failed; 1.0.0 remains active.",
        failure: {
          kind: "operation",
          message: "Update and rollback failed.",
          primary: { kind: "leaf", code: "ACTIVATION_FAILED", message: "Activation failed." },
          secondary: [
            {
              role: "restore-state",
              failure: { kind: "leaf", message: "State restore failed." },
            },
          ],
        },
      }),
    ]);

    const entries = await diagnostics.list({ appId: "com.example.canvas" });
    expect(entries.map((entry) => entry.kind)).toEqual([
      "app-update-failed",
      "tab-ready",
      "tab-opened",
    ]);
    expect(entries[0]?.failure).toMatchObject({
      kind: "operation",
      primary: { code: "ACTIVATION_FAILED" },
      secondary: [{ role: "restore-state" }],
    });
    expect(
      (await readFile(join(root, "diagnostics.jsonl"), "utf8")).trim().split("\n"),
    ).toHaveLength(4);
  });

  it("fails visibly when the journal contains invalid data", async () => {
    const root = await mkdtemp(join(tmpdir(), "penkra-app-diagnostics-"));
    roots.push(root);
    const path = join(root, "diagnostics.jsonl");
    await writeFile(path, "not-json\n");

    await expect(new AppRuntimeDiagnostics(path).list()).rejects.toThrow("record 1 is invalid");
  });

  it("rejects an oversized complete record without touching the existing journal", async () => {
    const root = await mkdtemp(join(tmpdir(), "penkra-app-diagnostics-"));
    roots.push(root);
    const path = join(root, "diagnostics.jsonl");
    const existing = '{"existing":true}\n';
    await writeFile(path, existing);
    const diagnostics = new AppRuntimeDiagnostics(path);

    await expect(
      diagnostics.record({
        kind: "app-update-failed",
        appId: "com.example.canvas",
        spaceId: "personal",
        message: "x".repeat(APP_RUNTIME_DIAGNOSTICS_MAX_BYTES),
      }),
    ).rejects.toThrow("exceeds the 2 MiB journal capacity");

    await expect(readFile(path, "utf8")).resolves.toBe(existing);
  });

  it("retains the newest contiguous suffix that fits beside the incoming record", async () => {
    const root = await mkdtemp(join(tmpdir(), "penkra-app-diagnostics-"));
    roots.push(root);
    const path = join(root, "diagnostics.jsonl");
    const diagnostics = new AppRuntimeDiagnostics(path);
    const message = (label: string, bytes: number) => `${label}${"x".repeat(bytes - label.length)}`;

    await diagnostics.record({
      kind: "tab-opened",
      appId: "com.example.canvas",
      spaceId: "personal",
      message: message("oldest", 600_000),
    });
    await diagnostics.record({
      kind: "tab-ready",
      appId: "com.example.canvas",
      spaceId: "personal",
      message: message("newest", 600_000),
    });
    await diagnostics.record({
      kind: "app-update-failed",
      appId: "com.example.canvas",
      spaceId: "personal",
      message: message("incoming", 1_000_000),
    });

    const entries = await diagnostics.list({ limit: 10 });
    expect(entries.map((entry) => entry.kind)).toEqual(["app-update-failed", "tab-ready"]);
    expect(Buffer.byteLength(await readFile(path, "utf8"))).toBeLessThanOrEqual(
      APP_RUNTIME_DIAGNOSTICS_MAX_BYTES,
    );
  });
});
