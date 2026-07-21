#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import release from "./penkra-release.json" with { type: "json" };

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = resolve(repoRoot, "..");
const { values } = parseArgs({
  options: {
    publish: { type: "boolean", default: false },
    install: { type: "boolean", default: false },
    dmg: { type: "boolean", default: false },
    "skip-quality": { type: "boolean", default: false },
    "cli-binary": { type: "string" },
    "output-dir": { type: "string", default: "release" },
    help: { type: "boolean", short: "h", default: false },
  },
});

if (values.help) {
  process.stdout.write(`Usage: node scripts/penkra-release-local.mjs [options]

  --publish          Publish versioned artifacts, then latest-mac.yml, to production S3.
  --install          Install the verified local artifact after build/publish.
  --dmg              Produce DMG + ZIP; routine internal releases are ZIP-only.
  --skip-quality     Skip the local quality suite when it already passed for this exact tree.
  --cli-binary PATH  Use an existing pinned Penkra CLI binary instead of rebuilding it.
  --output-dir PATH  Artifact directory. Defaults to ./release.
`);
  process.exit(0);
}

if (process.platform !== "darwin" || process.arch !== "arm64") {
  throw new Error("The Penkra production release command requires a macOS arm64 host.");
}
if (!process.env.PENKRA_UPDATE_TOKEN?.trim()) {
  throw new Error(
    "PENKRA_UPDATE_TOKEN is required so the packaged app can authenticate future updates.",
  );
}

function run(label, command, args, options = {}) {
  const startedAt = Date.now();
  process.stdout.write(`[release:local] ${label}...\n`);
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: options.env ?? process.env,
    stdio: "inherit",
  });
  const durationSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  if (result.status !== 0) throw new Error(`${label} failed after ${durationSeconds}s`);
  process.stdout.write(`[release:local] ${label} completed in ${durationSeconds}s.\n`);
}

function readGitHead(repository) {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`Could not read git HEAD in ${repository}`);
  return result.stdout.trim();
}

const totalStartedAt = Date.now();
const outputDir = resolve(repoRoot, values["output-dir"]);
if (!values["skip-quality"]) {
  run("Local quality suite", "node", ["scripts/penkra-release-verify.mjs"]);
}

let cliBinary = values["cli-binary"]
  ? resolve(repoRoot, values["cli-binary"])
  : process.env.PENKRA_CLI_BINARY?.trim();
if (!cliBinary) {
  const backendRoot = resolve(workspaceRoot, "backend");
  const backendHead = readGitHead(backendRoot);
  if (!backendHead.startsWith(release.backendRef)) {
    throw new Error(
      `Backend HEAD ${backendHead.slice(0, 12)} does not match pinned release ref ${release.backendRef}.`,
    );
  }
  run("Pinned backend CLI build", "pnpm", ["--filter", "@penkra/cli", "build:binary"], {
    cwd: backendRoot,
  });
  cliBinary = resolve(backendRoot, "apps/cli/dist/penkra");
}
cliBinary = resolve(cliBinary);
if (!existsSync(cliBinary)) throw new Error(`Penkra CLI binary does not exist: ${cliBinary}`);

rmSync(outputDir, { force: true, recursive: true });
run(
  `Signed macOS ${values.dmg ? "DMG + ZIP" : "ZIP"} build`,
  "node",
  [
    "scripts/build-desktop-artifact.ts",
    "--platform",
    "mac",
    "--target",
    values.dmg ? "dmg" : "zip",
    "--arch",
    "arm64",
    "--signed",
    "--build-version",
    release.version,
    "--output-dir",
    outputDir,
  ],
  { env: { ...process.env, PENKRA_CLI_BINARY: cliBinary } },
);
run("Final update artifact smoke", "node", [
  "scripts/smoke-mac-update-artifact.ts",
  "--artifact-dir",
  outputDir,
]);

if (values.publish) {
  run("Production S3 publication", "node", ["scripts/penkra-publish.mjs", outputDir]);
}
if (values.install) {
  run("Recoverable local installation", "node", ["scripts/penkra-install-local.mjs", outputDir]);
}

process.stdout.write(
  `[release:local] Penkra ${release.version} completed in ${((Date.now() - totalStartedAt) / 1000).toFixed(1)}s.\n`,
);
