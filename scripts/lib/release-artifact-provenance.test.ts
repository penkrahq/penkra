import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  assertDeveloperIdApplicationIdentity,
  parseMacIdentity,
  writeReleaseArtifactProvenance,
} from "./release-artifact-provenance.ts";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function createAssets(): string {
  const root = mkdtempSync(join(tmpdir(), "penkra-artifact-provenance-test-"));
  temporaryRoots.push(root);
  writeFileSync(join(root, "Penkra-1.2.3-x64.AppImage"), "app-image-bytes");
  writeFileSync(join(root, "latest-linux.yml"), "version: 1.2.3\n");
  return root;
}

function createWindowsAssets(options: { updaterMetadata?: boolean } = {}): string {
  const root = mkdtempSync(join(tmpdir(), "penkra-windows-provenance-test-"));
  temporaryRoots.push(root);
  writeFileSync(join(root, "Penkra-1.2.3-x64.exe"), "unsigned-windows-bytes");
  if (options.updaterMetadata !== false) {
    writeFileSync(join(root, "latest.yml"), "version: 1.2.3\n");
  }
  return root;
}

describe("release artifact provenance", () => {
  it("accepts only the stable Developer ID Application release identity", () => {
    const releaseIdentity = parseMacIdentity(
      [
        "Authority=Developer ID Application: Penkra, Inc. (D239U9W6M6)",
        "Authority=Developer ID Certification Authority",
        "Authority=Apple Root CA",
        "TeamIdentifier=D239U9W6M6",
      ].join("\n"),
    );
    expect(() => assertDeveloperIdApplicationIdentity(releaseIdentity, "D239U9W6M6")).not.toThrow();

    const developmentIdentity = parseMacIdentity(
      [
        "Authority=Apple Development: Emmanuel Gyekye Atta-Penkra (W4HHC8PG2J)",
        "Authority=Apple Worldwide Developer Relations Certification Authority",
        "Authority=Apple Root CA",
        "TeamIdentifier=D239U9W6M6",
      ].join("\n"),
    );
    expect(() => assertDeveloperIdApplicationIdentity(developmentIdentity, "D239U9W6M6")).toThrow(
      "must use a Developer ID Application identity",
    );
  });

  it("hashes the exact collected Linux assets into a deterministic manifest", async () => {
    const assetsDirectory = createAssets();
    const result = await writeReleaseArtifactProvenance({
      assetsDirectory,
      platform: "linux",
      arch: "x64",
      target: "AppImage",
      version: "1.2.3",
      sourceCommit: "a".repeat(40),
      sourceTag: null,
      lockfileSha256: "b".repeat(64),
      publication: false,
      signed: false,
    });

    expect(result.path).toBe(join(assetsDirectory, "artifact-linux-x64.provenance.json"));
    expect(result.manifest.target).toBe("AppImage");
    expect(result.manifest.signing).toEqual({
      status: "not-applicable",
      scheme: "none",
      identity: null,
      checks: ["AppImage payload present"],
    });
    expect(result.manifest.artifacts.map((artifact) => artifact.fileName)).toEqual([
      "latest-linux.yml",
      "Penkra-1.2.3-x64.AppImage",
    ]);
    expect(
      result.manifest.artifacts.find(
        (artifact) => artifact.fileName === "Penkra-1.2.3-x64.AppImage",
      )?.sha256,
    ).toBe(createHash("sha256").update("app-image-bytes").digest("hex"));
    expect(JSON.parse(readFileSync(result.path, "utf8"))).toEqual(result.manifest);
  });

  it("rejects publication without an exact source tag", async () => {
    await expect(
      writeReleaseArtifactProvenance({
        assetsDirectory: createAssets(),
        platform: "linux",
        arch: "x64",
        target: "AppImage",
        version: "1.2.3",
        sourceCommit: "a".repeat(40),
        sourceTag: null,
        lockfileSha256: "b".repeat(64),
        publication: true,
        signed: false,
      }),
    ).rejects.toThrow("requires an exact source tag");
  });

  it("rejects unsigned Windows publication without an explicit release decision", async () => {
    await expect(
      writeReleaseArtifactProvenance({
        assetsDirectory: createWindowsAssets(),
        platform: "win",
        arch: "x64",
        target: "nsis",
        version: "1.2.3",
        sourceCommit: "a".repeat(40),
        sourceTag: "v1.2.3",
        lockfileSha256: "b".repeat(64),
        publication: true,
        signed: false,
      }),
    ).rejects.toThrow("requires verified signing");
  });

  it("records explicitly unsigned Windows installer publication without auto-update metadata", async () => {
    const result = await writeReleaseArtifactProvenance({
      assetsDirectory: createWindowsAssets({ updaterMetadata: false }),
      platform: "win",
      arch: "x64",
      target: "nsis",
      version: "1.2.3",
      sourceCommit: "a".repeat(40),
      sourceTag: "v1.2.3",
      lockfileSha256: "b".repeat(64),
      publication: true,
      signed: false,
      allowUnsignedWindowsPublication: true,
    });

    expect(result.manifest.signing).toEqual({
      status: "unsigned-explicit-release",
      scheme: "none",
      identity: null,
      checks: [
        "explicit unsigned Windows publication",
        "manual installer only",
        "auto-update metadata absent",
      ],
    });
  });

  it("rejects updater metadata in an explicitly unsigned Windows release", async () => {
    await expect(
      writeReleaseArtifactProvenance({
        assetsDirectory: createWindowsAssets(),
        platform: "win",
        arch: "x64",
        target: "nsis",
        version: "1.2.3",
        sourceCommit: "a".repeat(40),
        sourceTag: "v1.2.3",
        lockfileSha256: "b".repeat(64),
        publication: true,
        signed: false,
        allowUnsignedWindowsPublication: true,
      }),
    ).rejects.toThrow("must not include auto-update metadata");
  });
});
