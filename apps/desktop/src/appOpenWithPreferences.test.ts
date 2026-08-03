import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { describe, expect, it } from "vitest";

import {
  AppOpenWithPreferenceStore,
  resolveAppOpenWithPreferencesPath,
} from "./appOpenWithPreferences";

describe("AppOpenWithPreferenceStore", () => {
  it("persists independent choices for each Space and intent", async () => {
    const root = FS.mkdtempSync(Path.join(OS.tmpdir(), "penkra-open-with-"));
    try {
      const path = resolveAppOpenWithPreferencesPath(root);
      const store = await AppOpenWithPreferenceStore.open(path);
      await store.set("personal", "open-url", "com.penkra.browser");
      await store.set("work", "open-directory", "com.penkra.explorer");
      const reopened = await AppOpenWithPreferenceStore.open(path);
      expect(reopened.get("personal", "open-url")).toBe("com.penkra.browser");
      expect(reopened.get("work", "open-directory")).toBe("com.penkra.explorer");
      expect(reopened.get("work", "open-url")).toBeUndefined();
    } finally {
      FS.rmSync(root, { recursive: true, force: true });
    }
  });
});
