import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { describe, expect, it } from "vitest";

import {
  AppOpenWithPreferenceStore,
  resolveAppOpenWithPreferencesPath,
} from "./appOpenWithPreferences";

describe("AppOpenWithPreferenceStore", () => {
  it("persists one device-wide choice for each intent and file extension", async () => {
    const root = FS.mkdtempSync(Path.join(OS.tmpdir(), "penkra-open-with-"));
    try {
      const path = resolveAppOpenWithPreferencesPath(root);
      const store = await AppOpenWithPreferenceStore.open(path);
      await store.set("personal", "open-url", "com.penkra.browser");
      await store.set("personal", "open-file", "com.example.pdf", ".PDF");
      await store.set("personal", "open-file", "com.penkra.explorer", ".md");
      await store.set("work", "open-directory", "com.penkra.explorer");
      const reopened = await AppOpenWithPreferenceStore.open(path);
      expect(reopened.get("work", "open-url")).toBe("com.penkra.browser");
      expect(reopened.get("work", "open-file", ".pdf")).toBe("com.example.pdf");
      expect(reopened.get("work", "open-file", ".md")).toBe("com.penkra.explorer");
      expect(reopened.get("work", "open-directory")).toBe("com.penkra.explorer");
      expect(reopened.forSpace("work").files).toEqual({
        ".pdf": "com.example.pdf",
        ".md": "com.penkra.explorer",
      });
    } finally {
      FS.rmSync(root, { recursive: true, force: true });
    }
  });

  it("migrates URL and folder choices while dropping the obsolete all-files preference", async () => {
    const root = FS.mkdtempSync(Path.join(OS.tmpdir(), "penkra-open-with-"));
    try {
      const path = resolveAppOpenWithPreferencesPath(root);
      FS.mkdirSync(Path.dirname(path), { recursive: true });
      FS.writeFileSync(
        Path.join(Path.dirname(path), "open-with-v1.json"),
        JSON.stringify({
          personal: {
            "open-url": "com.penkra.browser",
            "open-file": "com.penkra.explorer",
            "open-directory": "com.penkra.explorer",
          },
        }),
      );
      const migrated = await AppOpenWithPreferenceStore.open(path);
      expect(migrated.forSpace("work")).toEqual({
        "open-url": "com.penkra.browser",
        "open-directory": "com.penkra.explorer",
        files: {},
      });
      expect(FS.existsSync(path)).toBe(true);
    } finally {
      FS.rmSync(root, { recursive: true, force: true });
    }
  });

  it("migrates per-Space v2 choices into one global preference", async () => {
    const root = FS.mkdtempSync(Path.join(OS.tmpdir(), "penkra-open-with-"));
    try {
      const path = resolveAppOpenWithPreferencesPath(root);
      FS.mkdirSync(Path.dirname(path), { recursive: true });
      FS.writeFileSync(
        path,
        JSON.stringify({
          personal: { "open-url": "com.penkra.browser", files: { ".md": "com.penkra.explorer" } },
          work: { "open-directory": "com.penkra.explorer", files: {} },
        }),
      );
      const migrated = await AppOpenWithPreferenceStore.open(path);
      expect(migrated.forSpace("any-space")).toEqual({
        "open-url": "com.penkra.browser",
        "open-directory": "com.penkra.explorer",
        files: { ".md": "com.penkra.explorer" },
      });
    } finally {
      FS.rmSync(root, { recursive: true, force: true });
    }
  });
});
