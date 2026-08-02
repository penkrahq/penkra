import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createEmptyAppInstallationState,
  registerVerifiedAppPackage,
  setSpaceAppEnabled,
} from "./appInstallationState";
import {
  AppInstallationStore,
  readAppInstallationState,
  resolveAppInstallationStatePath,
  writeAppInstallationState,
} from "./appInstallationStore";

const temporaryDirectories: string[] = [];

function createTemporaryDirectory(): string {
  const directory = FS.mkdtempSync(Path.join(OS.tmpdir(), "penkra-app-installations-"));
  temporaryDirectories.push(directory);
  return directory;
}

function packageInput() {
  return {
    manifest: {
      manifestVersion: 1,
      id: "com.penkra.apps",
      slug: "apps",
      name: "Apps",
      summary: "Discover and manage Penkra Apps.",
      version: "0.1.0",
      compatibility: { penkra: ">=0.8.0" },
      icons: [{ src: "assets/icon.svg", sizes: "any", type: "image/svg+xml" }],
      entrypoints: { app: "app.html", operations: "operations.html" },
    } as const,
    source: "registry" as const,
    packagePath: "/profile/apps/com.penkra.apps/0.1.0",
    sha256: "a".repeat(64),
    installedAt: "2026-08-01T00:00:00.000Z",
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    FS.rmSync(directory, { force: true, recursive: true });
  }
});

describe("App installation persistence", () => {
  it("resolves the state beneath the desktop profile", () => {
    expect(resolveAppInstallationStatePath("/profile")).toBe(
      Path.join("/profile", "apps", "installations-v1.json"),
    );
  });

  it("returns an explicit empty state only when the file is missing", async () => {
    const filePath = resolveAppInstallationStatePath(createTemporaryDirectory());
    await expect(readAppInstallationState(filePath)).resolves.toEqual({
      status: "missing",
      state: createEmptyAppInstallationState(),
    });
  });

  it("round-trips valid state through an atomic file", async () => {
    const root = createTemporaryDirectory();
    const filePath = resolveAppInstallationStatePath(root);
    const state = registerVerifiedAppPackage(createEmptyAppInstallationState(), packageInput());

    await writeAppInstallationState(filePath, state);

    await expect(readAppInstallationState(filePath)).resolves.toEqual({ status: "ready", state });
    const temporaryFiles = FS.readdirSync(Path.dirname(filePath)).filter((name) =>
      name.endsWith(".tmp"),
    );
    expect(temporaryFiles).toEqual([]);
    if (process.platform !== "win32") {
      expect(FS.statSync(filePath).mode & 0o777).toBe(0o600);
    }
  });

  it("reports corrupt state instead of silently replacing it", async () => {
    const filePath = resolveAppInstallationStatePath(createTemporaryDirectory());
    FS.mkdirSync(Path.dirname(filePath), { recursive: true });
    FS.writeFileSync(filePath, "{not-json", "utf8");

    const result = await readAppInstallationState(filePath);
    expect(result.status).toBe("corrupt");
    await expect(AppInstallationStore.open(filePath)).rejects.toThrow(
      "Unable to read App installation state",
    );
    expect(FS.readFileSync(filePath, "utf8")).toBe("{not-json");
  });

  it("serializes mutations and retains the previous snapshot after a failed transition", async () => {
    const filePath = resolveAppInstallationStatePath(createTemporaryDirectory());
    const store = await AppInstallationStore.open(filePath);

    const install = store.mutate((state) => registerVerifiedAppPackage(state, packageInput()));
    const enable = store.mutate((state) =>
      setSpaceAppEnabled(state, {
        appId: "com.penkra.apps",
        spaceId: "personal",
        enabled: true,
      }),
    );
    await expect(Promise.all([install, enable])).resolves.toHaveLength(2);
    expect(Object.values(store.snapshot().spaceStateByKey)).toEqual([
      expect.objectContaining({ spaceId: "personal", enabled: true }),
    ]);

    await expect(
      store.mutate(() => {
        throw new Error("simulated transition failure");
      }),
    ).rejects.toThrow("simulated transition failure");
    expect(store.snapshot().packagesByAppId["com.penkra.apps"]?.version).toBe("0.1.0");

    await expect(readAppInstallationState(filePath)).resolves.toEqual({
      status: "ready",
      state: store.snapshot(),
    });
  });
});
