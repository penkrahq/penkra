import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { installBundledPenkraCli } from "./penkraCliLink";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    FS.rmSync(directory, { recursive: true, force: true });
  }
});

describe("installBundledPenkraCli", () => {
  it("atomically installs, refreshes, and globally links the bundled CLI", async () => {
    const fixture = createFixture("version-one");
    const first = await installBundledPenkraCli(fixture);

    expect(first.status).toBe("installed");
    expect(first.globalLink).toBe("linked");
    expect(FS.readFileSync(first.localPath!, "utf8")).toBe("version-one");
    expect(FS.realpathSync(Path.join(fixture.globalBinDirectory, "penkra"))).toBe(
      FS.realpathSync(first.localPath!),
    );
    expect(FS.statSync(first.localPath!).mode & 0o777).toBe(0o755);

    FS.writeFileSync(Path.join(fixture.resourcesPath, "penkra-cli", "penkra"), "version-two");
    const refreshed = await installBundledPenkraCli(fixture);
    expect(refreshed.globalLink).toBe("current");
    expect(FS.readFileSync(refreshed.localPath!, "utf8")).toBe("version-two");
  });

  it("relinks an old symlink but does not overwrite a regular command", async () => {
    const fixture = createFixture("bundled");
    FS.mkdirSync(fixture.globalBinDirectory, { recursive: true });
    FS.symlinkSync("/old/Penkra/penkra", Path.join(fixture.globalBinDirectory, "penkra"));

    const relinked = await installBundledPenkraCli(fixture);
    expect(relinked.globalLink).toBe("linked");
    expect(FS.realpathSync(Path.join(fixture.globalBinDirectory, "penkra"))).toBe(
      FS.realpathSync(relinked.localPath!),
    );

    FS.rmSync(Path.join(fixture.globalBinDirectory, "penkra"));
    FS.writeFileSync(Path.join(fixture.globalBinDirectory, "penkra"), "operator-owned");
    const conflict = await installBundledPenkraCli(fixture);
    expect(conflict.globalLink).toBe("conflict");
    expect(FS.readFileSync(Path.join(fixture.globalBinDirectory, "penkra"), "utf8")).toBe(
      "operator-owned",
    );
  });

  it("reports a missing package and keeps the workspace PATH install usable without a global link", async () => {
    const root = makeTemporaryDirectory();
    await expect(
      installBundledPenkraCli({
        resourcesPath: Path.join(root, "missing-resources"),
        penkraRoot: Path.join(root, "Penkra"),
        platform: "darwin",
        globalBinDirectory: Path.join(root, "global-bin"),
      }),
    ).resolves.toEqual({
      status: "not-bundled",
      localPath: null,
      globalLink: "not-applicable",
    });

    const fixture = createFixture("bundled");
    FS.writeFileSync(fixture.globalBinDirectory, "not-a-directory");
    const unavailable = await installBundledPenkraCli(fixture);
    expect(unavailable.globalLink).toBe("unavailable");
    expect(FS.readFileSync(unavailable.localPath!, "utf8")).toBe("bundled");
  });
});

function createFixture(contents: string) {
  const root = makeTemporaryDirectory();
  const resourcesPath = Path.join(root, "resources");
  const globalBinDirectory = Path.join(root, "global-bin");
  FS.mkdirSync(Path.join(resourcesPath, "penkra-cli"), { recursive: true });
  FS.writeFileSync(Path.join(resourcesPath, "penkra-cli", "penkra"), contents);
  return {
    resourcesPath,
    penkraRoot: Path.join(root, "Penkra"),
    platform: "darwin" as const,
    globalBinDirectory,
  };
}

function makeTemporaryDirectory(): string {
  const directory = FS.mkdtempSync(Path.join(OS.tmpdir(), "penkra-cli-link-"));
  temporaryDirectories.push(directory);
  return directory;
}
