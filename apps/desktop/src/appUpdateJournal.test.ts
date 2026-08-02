import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createEmptyAppInstallationState,
  registerVerifiedAppPackage,
  replaceVerifiedRegistryAppPackage,
} from "./appInstallationState";
import { AppInstallationStore, resolveAppInstallationStatePath } from "./appInstallationStore";
import { AppUpdateJournal, resolveAppUpdateJournalPath } from "./appUpdateJournal";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = FS.mkdtempSync(Path.join(OS.tmpdir(), "penkra-app-update-journal-"));
  temporaryDirectories.push(directory);
  return directory;
}

function appPackage(version: string) {
  return {
    manifest: {
      manifestVersion: 1 as const,
      id: "com.acme.canvas",
      slug: "canvas",
      name: "Canvas",
      summary: "Create visual documents.",
      version,
      compatibility: { penkra: ">=0.8.0" },
      icons: [{ src: "icon.svg", sizes: "any", type: "image/svg+xml" }],
      entrypoints: { app: "app.html" },
    },
    source: "registry" as const,
    packagePath: `/profile/apps/com.acme.canvas/${version}`,
    sha256: version === "1.0.0" ? "a".repeat(64) : "b".repeat(64),
    installedAt: "2026-08-02T00:00:00.000Z",
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    FS.rmSync(directory, { recursive: true, force: true });
  }
});

describe("App update journal", () => {
  it("restores the exact previous snapshot after an interrupted package switch", async () => {
    const root = temporaryDirectory();
    const store = await AppInstallationStore.open(resolveAppInstallationStatePath(root));
    await store.mutate((state) => registerVerifiedAppPackage(state, appPackage("1.0.0")));
    const previous = store.snapshot();
    const journal = new AppUpdateJournal(resolveAppUpdateJournalPath(root));
    await journal.prepare({
      appId: "com.acme.canvas",
      targetVersion: "2.0.0",
      previousState: previous,
    });
    await store.mutate((state) => replaceVerifiedRegistryAppPackage(state, appPackage("2.0.0")));

    const restartedStore = await AppInstallationStore.open(resolveAppInstallationStatePath(root));
    await expect(journal.recoverSafe(restartedStore)).resolves.toEqual({
      status: "restored",
      appId: "com.acme.canvas",
      targetVersion: "2.0.0",
    });
    expect(restartedStore.snapshot()).toEqual(previous);
    expect(FS.existsSync(resolveAppUpdateJournalPath(root))).toBe(false);
  });

  it("quarantines a malformed journal without replacing committed installation state", async () => {
    const root = temporaryDirectory();
    const store = await AppInstallationStore.open(resolveAppInstallationStatePath(root));
    await store.mutate((state) => registerVerifiedAppPackage(state, appPackage("1.0.0")));
    const journalPath = resolveAppUpdateJournalPath(root);
    FS.mkdirSync(Path.dirname(journalPath), { recursive: true });
    FS.writeFileSync(journalPath, "{invalid", "utf8");
    const before = store.snapshot();

    const recovery = await new AppUpdateJournal(journalPath).recoverSafe(store);

    expect(recovery).toMatchObject({ status: "corrupt" });
    expect(store.snapshot()).toEqual(before);
    expect(recovery?.status === "corrupt" && FS.readFileSync(recovery.quarantinedPath, "utf8")).toBe("{invalid");
  });
});
