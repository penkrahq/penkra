import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  AppOpenWithPreferenceStore,
  resolveAppOpenWithPreferencesPath,
} from "./appOpenWithPreferences";

const roots: string[] = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
);

describe("AppOpenWithPreferenceStore", () => {
  it("persists device-wide URL, directory, and extension choices", async () => {
    const root = await mkdtemp(join(tmpdir(), "penkra-open-with-"));
    roots.push(root);
    const path = resolveAppOpenWithPreferencesPath(root);
    const store = await AppOpenWithPreferenceStore.open(path);

    await store.set("personal", "open-url", "com.penkra.browser");
    await store.set("personal", "open-directory", "com.penkra.explorer");
    await store.set("personal", "open-file", "com.penkra.explorer", ".MD");

    const reopened = await AppOpenWithPreferenceStore.open(path);
    expect(reopened.get("work", "open-url")).toBe("com.penkra.browser");
    expect(reopened.get("work", "open-directory")).toBe("com.penkra.explorer");
    expect(reopened.get("work", "open-file", ".md")).toBe("com.penkra.explorer");
    await reopened.set("work", "open-url", null);
    expect(reopened.snapshot()).toEqual({
      "open-directory": "com.penkra.explorer",
      files: { ".md": "com.penkra.explorer" },
    });
  });

  it("migrates the previous file and URL preference files", async () => {
    const root = await mkdtemp(join(tmpdir(), "penkra-open-with-"));
    roots.push(root);
    const directory = join(root, "apps");
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "open-with-v2.json"),
      JSON.stringify({
        "open-directory": "com.penkra.explorer",
        files: { ".md": "com.penkra.explorer" },
      }),
    );
    await writeFile(
      join(directory, "open-with-v3.json"),
      JSON.stringify({ "open-url": "com.penkra.browser" }),
    );

    const store = await AppOpenWithPreferenceStore.open(resolveAppOpenWithPreferencesPath(root));

    expect(store.snapshot()).toEqual({
      "open-url": "com.penkra.browser",
      "open-directory": "com.penkra.explorer",
      files: { ".md": "com.penkra.explorer" },
    });
  });

  it("merges the first deterministic choices from legacy per-Space files", async () => {
    const root = await mkdtemp(join(tmpdir(), "penkra-open-with-"));
    roots.push(root);
    const directory = join(root, "apps");
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "open-with-v2.json"),
      JSON.stringify({
        personal: {
          "open-url": "com.penkra.browser",
          files: { ".md": "com.penkra.explorer" },
        },
        work: {
          "open-directory": "com.penkra.explorer",
          files: { ".md": "com.acme.notes", ".txt": "com.penkra.explorer" },
        },
      }),
    );

    const store = await AppOpenWithPreferenceStore.open(resolveAppOpenWithPreferencesPath(root));

    expect(store.snapshot()).toEqual({
      "open-url": "com.penkra.browser",
      "open-directory": "com.penkra.explorer",
      files: { ".md": "com.penkra.explorer", ".txt": "com.penkra.explorer" },
    });
  });
});
