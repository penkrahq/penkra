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
  PENKRA_DESKTOP_UPDATE_CHANNEL,
  PENKRA_PRODUCTION_BUNDLE_ID,
} from "@penkra/shared/desktopIdentity";

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
  - url: Penkra-9.9.9-smoke.0-arm64.zip
    sha512: arm64zip
    size: 125621344
path: Penkra-9.9.9-smoke.0-arm64.zip
sha512: arm64zip
releaseDate: '2026-03-08T10:32:14.587Z'
`,
  );

  writeFileSync(
    x64Path,
    `version: 9.9.9-smoke.0
files:
  - url: Penkra-9.9.9-smoke.0-x64.zip
    sha512: x64zip
    size: 132000112
path: Penkra-9.9.9-smoke.0-x64.zip
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
  if (serverPackage.name !== "@penkra/cli") {
    throw new Error(`Expected CLI package @penkra/cli, got ${serverPackage.name ?? "<missing>"}.`);
  }
  const expectedBinaries = {
    penkra: "dist/index.mjs",
    "penkra-restore-migration-backup": "dist/restoreMigrationBackup.mjs",
  };
  if (JSON.stringify(serverPackage.bin ?? {}) !== JSON.stringify(expectedBinaries)) {
    throw new Error(
      "Expected the CLI to expose only the Penkra entry point and migration recovery binary.",
    );
  }
  if (PENKRA_PRODUCTION_BUNDLE_ID !== "com.penkra.app") {
    throw new Error(`Unexpected production bundle ID: ${PENKRA_PRODUCTION_BUNDLE_ID}.`);
  }
  if (PENKRA_DESKTOP_UPDATE_CHANNEL !== "latest") {
    throw new Error(`Unexpected desktop update channel: ${PENKRA_DESKTOP_UPDATE_CHANNEL}.`);
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
    ciWorkflow,
    "name: Penkra CI Quality Gate",
    "Expected one durable aggregate CI result for release provenance.",
  );
  assertContains(
    ciWorkflow,
    "test:browser:stable",
    "Expected stable browser behavior to block CI.",
  );
  assertContains(
    ciWorkflow,
    "test:browser:geometry",
    "Expected quarantined Linux geometry checks to remain independently visible.",
  );
  assertContains(
    ciWorkflow,
    "name: Native Desktop Package (${{ matrix.name }})",
    "Expected native Windows and Linux packages to be tested before release tagging.",
  );
  assertContains(
    ciWorkflow,
    "runner: windows-2025",
    "Expected pre-release packaged startup evidence from native Windows.",
  );
  assertContains(
    ciWorkflow,
    '--platform "${{ matrix.platform }}"',
    "Expected CI to build and launch each native desktop package.",
  );
  assertContains(
    ciWorkflow,
    "DESKTOP_PLATFORM_RESULT: ${{ needs.desktop_platform.result }}",
    "Expected native packaged startup to block the aggregate quality gate.",
  );
  assertContains(
    workflow,
    'tags:\n      - "v*.*.*"',
    "Expected stable desktop releases to build from version tags.",
  );
  assertContains(
    workflow,
    "workflow_dispatch:\n    inputs:\n      release_tag:",
    "Expected failed native builds to be recoverable only from an explicitly named stable tag.",
  );
  assertContains(
    workflow,
    "RELEASE_TAG: ${{ github.event_name == 'workflow_dispatch' && inputs.release_tag || github.ref_name }}",
    "Expected push and manual release runs to resolve one explicit tag identity.",
  );
  assertContains(
    workflow,
    "ref: ${{ env.RELEASE_TAG }}",
    "Expected manual release recovery to check out the tagged source, not main.",
  );
  assertContains(
    workflow,
    '[[ ! "$version" =~ ^[0-9]+\\.[0-9]+\\.[0-9]+$ ]]',
    "Expected release tags to require stable semantic versions.",
  );
  assertContains(
    workflow,
    'select(.name == "Penkra CI Quality Gate" and .conclusion == "success"',
    "Expected releases to require successful CI for the exact tagged commit.",
  );
  assertNotContains(
    workflow,
    "bun run typecheck",
    "Release builds must consume the exact commit CI result instead of repeating typecheck.",
  );
  assertNotContains(
    workflow,
    "bun run test",
    "Release builds must consume the exact commit CI result instead of repeating tests.",
  );
  assertContains(workflow, "runner: macos-15", "Expected a supported native macOS release runner.");
  assertContains(workflow, "runner: ubuntu-24.04", "Expected a native Linux release runner.");
  assertContains(workflow, "fail-fast: false", "Expected independent platform release failures.");
  assertContains(
    workflow,
    "environment: desktop-release",
    "Expected signing secrets to be protected by the desktop release environment.",
  );
  assertContains(workflow, "--target dmg", "Expected a signed DMG and matching update ZIP.");
  assertContains(workflow, "--arch arm64", "Expected the production release to be macOS arm64.");
  assertContains(workflow, "--target AppImage", "Expected a Linux AppImage.");
  assertContains(workflow, "--target nsis", "Expected an initial Windows NSIS installer.");
  assertContains(
    workflow,
    "runner: windows-2025",
    "Expected Windows release construction on a native runner.",
  );
  assertContains(
    workflow,
    "for generated_path in bun.lock apps/web/public/mockServiceWorker.js",
    "Expected Windows dependency installation to reconcile only the two proven generated artifacts.",
  );
  assertContains(
    workflow,
    'git show "HEAD:$generated_path" > "$generated_path"',
    "Expected generated artifacts to be copied byte-identically from the tagged blob on Windows.",
  );
  assertContains(
    workflow,
    'actual_blob="$(git hash-object "$generated_path")"',
    "Expected restored Windows generated artifacts to be hash-verified against the tagged blob.",
  );
  assertContains(
    workflow,
    'git update-index --assume-unchanged "$generated_path"',
    "Expected only hash-verified generated paths to bypass Windows text-conversion status noise.",
  );
  assertContains(
    workflow,
    "changed tracked release source outside the approved generated artifacts",
    "Expected Windows dependency installation to reject every unapproved tracked change.",
  );
  assertContains(
    workflow,
    "rm -f release/latest.yml release/*.exe.blockmap",
    "Unsigned Windows releases must not publish auto-update metadata.",
  );
  assertContains(
    workflow,
    "write-release-artifact-provenance.ts",
    "Expected every platform artifact to carry verified release provenance.",
  );
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
    "The Windows x64 installer is intentionally unsigned",
    "Expected the release notes to disclose the unsigned Windows installer.",
  );
  assertContains(
    workflow,
    "Public desktop artifact contains the private Penkra CLI.",
    "Expected release verification to reject the private CLI.",
  );
  assertContains(
    workflow,
    "--allow-unsigned-windows-publication true",
    "Unsigned Windows publication must be an explicit release decision.",
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

function verifyLocalProductionQaGate(): void {
  const packageJson = readFileSync(resolve(repoRoot, "package.json"), "utf8");
  const qaScript = readFileSync(
    resolve(repoRoot, "scripts/penkra-local-production-qa.mjs"),
    "utf8",
  );
  const releaseGuide = readFileSync(resolve(repoRoot, "docs/release.md"), "utf8");
  for (const command of ["release:qa:local", "release:qa:approve", "release:qa:check"]) {
    assertContains(packageJson, `"${command}"`, `Expected the ${command} release gate.`);
  }
  assertContains(
    qaScript,
    'status: "built-awaiting-installed-manual-qa"',
    "Expected local production QA to require explicit approval after installation and testing.",
  );
  assertContains(
    qaScript,
    'status: "manual-qa-approved"',
    "Expected local production QA to record explicit manual approval.",
  );
  assertContains(
    qaScript,
    'run("git", ["status", "--porcelain=v1"])',
    "Expected local production QA to reject a dirty release source.",
  );
  assertContains(
    releaseGuide,
    'bun run release:qa:check -- "$approved_version"',
    "Expected release instructions to verify local manual QA before tagging.",
  );
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
    "--filter @penkra/",
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
    "penkraCommitHash: commitHash",
    "Expected the staged package to carry its exact source commit.",
  );
  assertContains(
    buildScript,
    "penkraLockfileSha256: resolvedLockfileSha256",
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

const tempRoot = mkdtempSync(join(tmpdir(), "penkra-release-smoke-"));

try {
  verifyCanonicalIdentity();
  verifyReleaseWorkflowSafety();
  verifyLocalProductionQaGate();
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
    "Penkra-9.9.9-smoke.0-arm64.zip",
    "Merged manifest is missing the arm64 asset.",
  );
  assertContains(
    mergedManifest,
    "Penkra-9.9.9-smoke.0-x64.zip",
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
