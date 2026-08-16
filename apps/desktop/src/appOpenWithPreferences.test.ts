import { mkdtemp, rm } from "node:fs/promises";
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
  it("persists one device-wide URL handler choice", async () => {
    const root = await mkdtemp(join(tmpdir(), "penkra-open-with-"));
    roots.push(root);
    const path = resolveAppOpenWithPreferencesPath(root);
    const store = await AppOpenWithPreferenceStore.open(path);

    await store.set("personal", "open-url", "com.penkra.browser");

    const reopened = await AppOpenWithPreferenceStore.open(path);
    expect(reopened.get("work", "open-url")).toBe("com.penkra.browser");
    await reopened.set("work", "open-url", null);
    expect(reopened.snapshot()).toEqual({});
  });
});
