#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const PRODUCT_MANIFESTS = [
  "apps/desktop/package.json",
  "apps/server/package.json",
  "apps/web/package.json",
  "packages/contracts/package.json",
];
const ARTIFACT_DIRECTORY = "release-local";
const mode = process.argv[2];
const requestedVersion = process.argv[3];

if (!mode || !requestedVersion || !["prepare", "approve", "check"].includes(mode)) {
  throw new Error(
    "Usage: node scripts/penkra-local-production-qa.mjs <prepare|approve|check> <version>",
  );
}
if (!/^\d+\.\d+\.\d+$/.test(requestedVersion)) {
  throw new Error(`Local production QA requires an exact stable version, got ${requestedVersion}.`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed:\n${result.stderr || result.stdout || "no output"}`,
    );
  }
  return result.stdout?.trim() ?? "";
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function assertExactSource() {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error("Local production QA must run on the macOS arm64 release platform.");
  }
  const branch = run("git", ["branch", "--show-current"]);
  if (branch !== "main") {
    throw new Error(`Local production QA must run from main, got ${branch || "detached HEAD"}.`);
  }
  const status = run("git", ["status", "--porcelain=v1"]);
  if (status) {
    throw new Error(`Local production QA requires a clean worktree:\n${status}`);
  }
  for (const manifest of PRODUCT_MANIFESTS) {
    const version = JSON.parse(readFileSync(resolve(manifest), "utf8")).version;
    if (version !== requestedVersion) {
      throw new Error(`${manifest} is ${version}; expected ${requestedVersion}.`);
    }
  }
  run("git", ["fetch", "origin", "main"]);
  const [, behindText] = run("git", [
    "rev-list",
    "--left-right",
    "--count",
    "HEAD...origin/main",
  ]).split(/\s+/);
  if (behindText !== "0") {
    throw new Error("Local main is behind origin/main; update it before production QA.");
  }
  return {
    version: requestedVersion,
    commit: run("git", ["rev-parse", "HEAD"]),
    lockfileSha256: sha256(resolve("bun.lock")),
  };
}

function receiptPath() {
  return resolve(
    run("git", ["rev-parse", "--git-path", `penkra-release-qa-${requestedVersion}.json`]),
  );
}

function collectArtifacts() {
  const directory = resolve(ARTIFACT_DIRECTORY);
  if (!existsSync(directory)) {
    throw new Error(`Missing local production artifacts at ${directory}.`);
  }
  const names = readdirSync(directory)
    .filter((name) => /\.(dmg|zip|blockmap|yml)$/.test(name))
    .toSorted();
  if (
    !names.includes("latest-mac.yml") ||
    !names.some((name) => name.endsWith(".dmg")) ||
    !names.some((name) => name.endsWith(".zip")) ||
    !names.some((name) => name.endsWith(".zip.blockmap"))
  ) {
    throw new Error("Local production QA artifacts are incomplete.");
  }
  return Object.fromEntries(names.map((name) => [name, sha256(resolve(directory, name))]));
}

function readReceipt() {
  const path = receiptPath();
  if (!existsSync(path)) {
    throw new Error(`No local production QA receipt exists for ${requestedVersion}.`);
  }
  return JSON.parse(readFileSync(path, "utf8"));
}

function assertReceiptMatches(receipt, source) {
  if (
    receipt.version !== source.version ||
    receipt.commit !== source.commit ||
    receipt.lockfileSha256 !== source.lockfileSha256
  ) {
    throw new Error("The local production QA receipt does not match the current release source.");
  }
  const artifacts = collectArtifacts();
  if (JSON.stringify(receipt.artifacts) !== JSON.stringify(artifacts)) {
    throw new Error("Local production artifacts changed after the QA receipt was created.");
  }
}

const source = assertExactSource();
const path = receiptPath();

if (mode === "prepare") {
  run("bun", ["run", "release:verify"], { stdio: "inherit" });
  run(
    "bun",
    [
      "run",
      "dist:desktop:artifact",
      "--",
      "--platform",
      "mac",
      "--target",
      "dmg",
      "--arch",
      "arm64",
      "--build-version",
      source.version,
      "--source-commit",
      source.commit,
      "--lockfile-sha256",
      source.lockfileSha256,
      "--output-dir",
      ARTIFACT_DIRECTORY,
    ],
    { stdio: "inherit" },
  );
  run("bun", ["run", "release:smoke:mac-update", "--", "--artifact-dir", ARTIFACT_DIRECTORY], {
    stdio: "inherit",
  });
  run(
    "node",
    [
      "scripts/verify-packaged-desktop-startup.ts",
      "--assets-dir",
      ARTIFACT_DIRECTORY,
      "--platform",
      "mac",
      "--arch",
      "arm64",
      "--version",
      source.version,
    ],
    { stdio: "inherit" },
  );
  const receipt = {
    ...source,
    status: "built-awaiting-installed-manual-qa",
    preparedAt: new Date().toISOString(),
    artifacts: collectArtifacts(),
  };
  writeFileSync(path, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(
    `Built exact local Penkra ${source.version} from ${source.commit}. Install release-local, complete manual QA, then run: bun run release:qa:approve -- ${source.version}\n`,
  );
} else if (mode === "approve") {
  const receipt = readReceipt();
  assertReceiptMatches(receipt, source);
  if (receipt.status !== "built-awaiting-installed-manual-qa") {
    throw new Error(`QA receipt has unexpected status ${receipt.status}.`);
  }
  writeFileSync(
    path,
    `${JSON.stringify(
      { ...receipt, status: "manual-qa-approved", approvedAt: new Date().toISOString() },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  process.stdout.write(`Recorded manual production QA approval for Penkra ${source.version}.\n`);
} else {
  const receipt = readReceipt();
  assertReceiptMatches(receipt, source);
  if (receipt.status !== "manual-qa-approved" || typeof receipt.approvedAt !== "string") {
    throw new Error(`Penkra ${source.version} has not passed explicit local manual QA.`);
  }
  process.stdout.write(
    `Local production QA gate passed for Penkra ${source.version} at ${source.commit}.\n`,
  );
}
