import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { describe, expect, it } from "vitest";

import {
  acknowledgePenkraStorageSnapshot,
  readPenkraStorageSnapshot,
  savePenkraStorageSnapshot,
  PENKRA_STORAGE_SNAPSHOT_MAX_BYTES,
  validatePenkraStorageSnapshot,
} from "./desktopStorageMigration";

const snapshot = (exportedAt = "2026-07-09T00:00:00.000Z") => ({
  version: 1 as const,
  exportedAt,
  entries: {
    "penkra:theme": "dark",
    "penkra.openUsage.enabled": "true",
  },
});

describe("desktopStorageMigration", () => {
  it("round-trips atomically and acknowledges the snapshot", async () => {
    const directory = FS.mkdtempSync(Path.join(OS.tmpdir(), "penkra-storage-migration-"));
    const target = Path.join(directory, "snapshot.json");
    try {
      await expect(savePenkraStorageSnapshot(target, snapshot())).resolves.toBe(true);
      expect(readPenkraStorageSnapshot(target)).toEqual(snapshot());
      expect(FS.readdirSync(directory)).toEqual(["snapshot.json"]);

      await acknowledgePenkraStorageSnapshot(target);
      expect(readPenkraStorageSnapshot(target)).toBeNull();
    } finally {
      FS.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects malformed, disallowed, and oversized snapshots", () => {
    expect(validatePenkraStorageSnapshot({ version: 1 })).toBeNull();
    expect(
      validatePenkraStorageSnapshot({
        ...snapshot(),
        entries: { "foreign:theme": "dark" },
      }),
    ).toBeNull();
    expect(
      validatePenkraStorageSnapshot({
        ...snapshot(),
        entries: { "penkra:large": "x".repeat(PENKRA_STORAGE_SNAPSHOT_MAX_BYTES) },
      }),
    ).toBeNull();
  });

  it("accepts renderer snapshots containing large composer drafts", () => {
    const largeDraft = "x".repeat(2 * 1024 * 1024);

    expect(
      validatePenkraStorageSnapshot({
        ...snapshot(),
        entries: { "penkra:composer-drafts:v1": largeDraft },
      })?.entries["penkra:composer-drafts:v1"],
    ).toBe(largeDraft);
  });

  it("does not replace a newer snapshot with an older export", async () => {
    const directory = FS.mkdtempSync(Path.join(OS.tmpdir(), "penkra-storage-migration-"));
    const target = Path.join(directory, "snapshot.json");
    try {
      await savePenkraStorageSnapshot(target, snapshot("2026-07-09T01:00:00.000Z"));
      await expect(
        savePenkraStorageSnapshot(target, snapshot("2026-07-09T00:00:00.000Z")),
      ).resolves.toBe(false);
      expect(readPenkraStorageSnapshot(target)?.exportedAt).toBe("2026-07-09T01:00:00.000Z");
    } finally {
      FS.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("treats missing and malformed files as absent", () => {
    const directory = FS.mkdtempSync(Path.join(OS.tmpdir(), "penkra-storage-migration-"));
    const target = Path.join(directory, "snapshot.json");
    try {
      expect(readPenkraStorageSnapshot(target)).toBeNull();
      FS.writeFileSync(target, "not json");
      expect(readPenkraStorageSnapshot(target)).toBeNull();
    } finally {
      FS.rmSync(directory, { recursive: true, force: true });
    }
  });
});
