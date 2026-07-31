// FILE: release-smoke.ts
// Purpose: Smoke-tests release version alignment and merged macOS updater manifests.
// Layer: Release verification script
// Depends on: update-release-package-versions.ts and merge-mac-update-manifests.ts.

import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  SYNARA_DESKTOP_UPDATE_CHANNEL,
  SYNARA_PRODUCTION_BUNDLE_ID,
} from "@synara/shared/desktopIdentity";

import {
  RELEASE_LOCKFILE_PATH,
  RELEASE_PATCHES_PATH,
  RELEASE_WORKSPACE_MANIFEST_PATHS,
} from "./lib/release-workspace-manifests.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function copyWorkspaceManifestFixture(targetRoot: string): void {
  for (const relativePath of RELEASE_WORKSPACE_MANIFEST_PATHS) {
    const sourcePath = resolve(repoRoot, relativePath);
    const destinationPath = resolve(targetRoot, relativePath);
    mkdirSync(dirname(destinationPath), { recursive: true });
    cpSync(sourcePath, destinationPath);
  }
  cpSync(resolve(repoRoot, RELEASE_LOCKFILE_PATH), resolve(targetRoot, RELEASE_LOCKFILE_PATH));
  cpSync(resolve(repoRoot, RELEASE_PATCHES_PATH), resolve(targetRoot, RELEASE_PATCHES_PATH), {
    recursive: true,
  });
}

function writeMacManifestFixtures(targetRoot: string): { arm64Path: string; x64Path: string } {
  const assetDirectory = resolve(targetRoot, "release-assets");
  mkdirSync(assetDirectory, { recursive: true });

  const arm64Path = resolve(assetDirectory, "latest-mac.yml");
  const x64Path = resolve(assetDirectory, "latest-mac-x64.yml");

  writeFileSync(
    arm64Path,
    `version: 9.9.9-smoke.0
files:
  - url: Synara-9.9.9-smoke.0-arm64.zip
    sha512: arm64zip
    size: 125621344
path: Synara-9.9.9-smoke.0-arm64.zip
sha512: arm64zip
releaseDate: '2026-03-08T10:32:14.587Z'
`,
  );

  writeFileSync(
    x64Path,
    `version: 9.9.9-smoke.0
files:
  - url: Synara-9.9.9-smoke.0-x64.zip
    sha512: x64zip
    size: 132000112
path: Synara-9.9.9-smoke.0-x64.zip
sha512: x64zip
releaseDate: '2026-03-08T10:36:07.540Z'
`,
  );

  return { arm64Path, x64Path };
}

function assertContains(haystack: string, needle: string, message: string): void {
  if (!haystack.includes(needle)) {
    throw new Error(message);
  }
}

function assertNotContains(haystack: string, needle: string, message: string): void {
  if (haystack.includes(needle)) {
    throw new Error(message);
  }
}

function verifyCanonicalIdentity(): void {
  const serverPackage = JSON.parse(
    readFileSync(resolve(repoRoot, "apps/server/package.json"), "utf8"),
  ) as { name?: string; bin?: Record<string, string> };
  if (serverPackage.name !== "@synara/cli") {
    throw new Error(`Expected CLI package @synara/cli, got ${serverPackage.name ?? "<missing>"}.`);
  }
  const expectedBinaries = {
    synara: "dist/index.mjs",
    "synara-restore-migration-backup": "dist/restoreMigrationBackup.mjs",
  };
  if (JSON.stringify(serverPackage.bin ?? {}) !== JSON.stringify(expectedBinaries)) {
    throw new Error(
      "Expected the CLI to expose only the Synara entry point and migration recovery binary.",
    );
  }
  if (SYNARA_PRODUCTION_BUNDLE_ID !== "com.penkra.app") {
    throw new Error(`Unexpected production bundle ID: ${SYNARA_PRODUCTION_BUNDLE_ID}.`);
  }
  if (SYNARA_DESKTOP_UPDATE_CHANNEL !== "latest") {
    throw new Error(`Unexpected desktop update channel: ${SYNARA_DESKTOP_UPDATE_CHANNEL}.`);
  }
}

function verifyReleaseWorkflowSafety(): void {
  const workflow = readFileSync(resolve(repoRoot, ".github/workflows/release.yml"), "utf8");
  const ciWorkflow = readFileSync(resolve(repoRoot, ".github/workflows/ci.yml"), "utf8");
  assertContains(ciWorkflow, "pull_request:", "Expected CI on pull requests.");
  assertContains(
    ciWorkflow,
    "push:\n    branches:\n      - main",
    "Expected CI on pushes to main.",
  );
  assertContains(
    workflow,
    'tags:\n      - "v*.*.*"',
    "Expected stable desktop releases to build from version tags.",
  );
  assertNotContains(workflow, "workflow_dispatch:", "Release creation must start from a tag.");
  assertContains(
    workflow,
    '[[ ! "$version" =~ ^[0-9]+\\.[0-9]+\\.[0-9]+$ ]]',
    "Expected release tags to require stable semantic versions.",
  );
  assertContains(workflow, "runs-on: macos-14", "Expected the release to run on macOS.");
  assertContains(
    workflow,
    "environment: desktop-release",
    "Expected signing secrets to be protected by the desktop release environment.",
  );
  assertContains(workflow, "--target dmg", "Expected a signed DMG and matching update ZIP.");
  assertContains(workflow, "--arch arm64", "Expected the production release to be macOS arm64.");
  assertContains(
    workflow,
    "--source-commit",
    "Expected release artifacts to be bound to the tagged commit.",
  );
  assertContains(
    workflow,
    "--lockfile-sha256",
    "Expected release artifacts to be bound to the repository lockfile.",
  );
  assertContains(
    workflow,
    "uses: actions/attest@v4",
    "Expected public release artifacts to carry GitHub build provenance.",
  );
  assertContains(workflow, "--draft", "Expected an explicit draft-release review gate.");
  assertContains(workflow, "--generate-notes", "Expected GitHub-generated release notes.");
  assertContains(
    workflow,
    "Public desktop artifact contains the private Penkra CLI.",
    "Expected release verification to reject the private CLI.",
  );
  for (const forbidden of [
    "BACKEND_REPOSITORY_TOKEN",
    "penkra-backend",
    "PENKRA_UPDATE_TOKEN",
    "PENKRA_RELEASE_BUCKET",
    "AWS_ACCESS_KEY_ID",
    "release:publish:s3",
  ]) {
    assertNotContains(workflow, forbidden, `Release workflow must not contain ${forbidden}.`);
  }
}

function verifyDesktopStageLockAuthority(): void {
  const buildScript = readFileSync(resolve(repoRoot, "scripts/build-desktop-artifact.ts"), "utf8");
  const desktopMain = readFileSync(resolve(repoRoot, "apps/desktop/src/main.ts"), "utf8");
  const gitAttributes = readFileSync(resolve(repoRoot, ".gitattributes"), "utf8");
  assertContains(
    gitAttributes,
    "bun.lock text eol=lf",
    "Expected bun.lock to retain byte-identical LF endings on every release runner.",
  );
  assertContains(
    buildScript,
    "bun install --frozen-lockfile --ignore-scripts --linker hoisted",
    "Expected macOS desktop staging to install from the repository's frozen workspace lockfile.",
  );
  assertNotContains(
    buildScript,
    "--production --frozen-lockfile",
    "Desktop staging must avoid Bun's divergent frozen production-workspace lockfile resolution.",
  );
  assertNotContains(
    buildScript,
    "bun install --production",
    "Desktop staging must not use Bun's production flag because it implicitly forces frozen mode.",
  );
  assertNotContains(
    buildScript,
    "--filter @synara/",
    "Desktop staging must not use Bun workspace filters because filtered hoisted installs can diverge from bun.lock.",
  );
  assertNotContains(
    buildScript,
    "npm rebuild --foreground-scripts",
    "Desktop staging must never enable every dependency lifecycle script.",
  );
  assertNotContains(
    buildScript,
    "bun pm trust --all",
    "Desktop staging must never trust every dependency lifecycle script.",
  );
  assertContains(
    buildScript,
    'createRequire(new URL("./package.json", import.meta.url))',
    "Expected desktop packaging to resolve dependencies from the owning scripts workspace.",
  );
  assertContains(
    buildScript,
    'requireFromScriptsWorkspace.resolve("electron-builder/cli.js")',
    "Expected desktop packaging to resolve electron-builder across Bun hoisting layouts.",
  );
  assertContains(
    buildScript,
    "`${process.execPath} ${electronBuilderCliPath}",
    "Expected desktop packaging to invoke electron-builder through Node without platform-specific bin shims.",
  );
  assertNotContains(
    buildScript,
    "electron-builder.cmd",
    "Desktop packaging must not depend on a Windows bin shim that Bun may hoist elsewhere.",
  );
  assertContains(buildScript, 'provider: "github"', "Expected GitHub Releases auto-updates.");
  assertContains(buildScript, 'owner: "penkrahq"', "Expected the Penkra GitHub owner.");
  assertContains(buildScript, 'repo: "penkra"', "Expected the public Penkra release repository.");
  assertNotContains(
    buildScript,
    "PENKRA_CLI_BINARY",
    "Public packaging must not require the private Penkra CLI.",
  );
  assertNotContains(
    buildScript,
    'from: "penkra-cli"',
    "Public packaging must not stage the private Penkra CLI.",
  );
  assertContains(
    buildScript,
    "resolveUnusedClaudePlatformPackageName",
    "Expected the unused Claude platform binary to be removed.",
  );
  assertContains(
    desktopMain,
    'process.platform === "darwin" || isArm64HostRunningIntelBuild(desktopRuntimeInfo)',
    "Expected macOS updates to use the validated resumable full-archive path.",
  );
  assertContains(
    buildScript,
    "synaraCommitHash: commitHash",
    "Expected the staged package to carry its exact source commit.",
  );
  assertContains(
    buildScript,
    "synaraLockfileSha256: resolvedLockfileSha256",
    "Expected the staged package to carry its repository lockfile digest.",
  );
  const lockfile = readFileSync(resolve(repoRoot, RELEASE_LOCKFILE_PATH), "utf8");
  const packagesSectionOffset = lockfile.indexOf('\n  "packages": {');
  if (packagesSectionOffset < 0) {
    throw new Error("Expected bun.lock to contain a packages section.");
  }
  const workspaceImporters = lockfile.slice(0, packagesSectionOffset);
  for (const manifestPath of RELEASE_WORKSPACE_MANIFEST_PATHS) {
    const workspacePath = manifestPath === "package.json" ? "" : dirname(manifestPath);
    if (!workspaceImporters.includes(`${JSON.stringify(workspacePath)}: {`)) {
      throw new Error(`Expected ${manifestPath} to have a matching importer in bun.lock.`);
    }
  }
}

const tempRoot = mkdtempSync(join(tmpdir(), "synara-release-smoke-"));

try {
  verifyCanonicalIdentity();
  verifyReleaseWorkflowSafety();
  verifyDesktopStageLockAuthority();
  copyWorkspaceManifestFixture(tempRoot);

  execFileSync(
    process.execPath,
    [
      resolve(repoRoot, "scripts/update-release-package-versions.ts"),
      "9.9.9-smoke.0",
      "--root",
      tempRoot,
    ],
    {
      cwd: repoRoot,
      stdio: "inherit",
    },
  );

  execFileSync("bun", ["install", "--lockfile-only", "--ignore-scripts"], {
    cwd: tempRoot,
    stdio: "inherit",
  });

  const lockfile = readFileSync(resolve(tempRoot, "bun.lock"), "utf8");
  assertContains(
    lockfile,
    `"version": "9.9.9-smoke.0"`,
    "Expected bun.lock to contain the smoke version.",
  );

  const { arm64Path, x64Path } = writeMacManifestFixtures(tempRoot);
  execFileSync(
    process.execPath,
    [resolve(repoRoot, "scripts/merge-mac-update-manifests.ts"), arm64Path, x64Path],
    {
      cwd: repoRoot,
      stdio: "inherit",
    },
  );

  const mergedManifest = readFileSync(arm64Path, "utf8");
  assertContains(
    mergedManifest,
    "Synara-9.9.9-smoke.0-arm64.zip",
    "Merged manifest is missing the arm64 asset.",
  );
  assertContains(
    mergedManifest,
    "Synara-9.9.9-smoke.0-x64.zip",
    "Merged manifest is missing the x64 asset.",
  );
  assertNotContains(
    mergedManifest,
    ".dmg",
    "macOS updater manifests must describe only the finalized ZIP artifacts.",
  );

  console.log("Release smoke checks passed.");
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
