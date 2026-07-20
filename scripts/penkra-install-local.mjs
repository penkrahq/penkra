#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import release from "./penkra-release.json" with { type: "json" };

const artifactDir = resolve(process.argv[2] ?? "release");
const zipNames = readdirSync(artifactDir).filter((name) => name.endsWith(".zip"));
if (zipNames.length !== 1 || !zipNames[0]) {
  throw new Error(`Expected one update ZIP in ${artifactDir}, found ${zipNames.length}.`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

const extractionRoot = mkdtempSync(join(tmpdir(), "penkra-local-install-"));
const target = "/Applications/Penkra.app";
let backup = null;
try {
  run("ditto", ["-x", "-k", join(artifactDir, zipNames[0]), extractionRoot]);
  const appNames = readdirSync(extractionRoot).filter((name) => name.endsWith(".app"));
  if (appNames.length !== 1 || !appNames[0]) throw new Error("Update ZIP must contain one app.");
  const source = join(extractionRoot, appNames[0]);
  run("codesign", ["--verify", "--deep", "--strict", "--verbose=4", source]);
  const version = run("defaults", [
    "read",
    join(source, "Contents", "Info"),
    "CFBundleShortVersionString",
  ]);
  if (version !== release.version) {
    throw new Error(`Local artifact version ${version} does not match release ${release.version}.`);
  }

  run("osascript", ["-e", 'tell application "Penkra" to quit']);
  if (existsSync(target)) {
    const currentVersion = run("defaults", [
      "read",
      join(target, "Contents", "Info"),
      "CFBundleShortVersionString",
    ]);
    const suffix = new Date().toISOString().replaceAll(":", "-");
    backup = `/Applications/Penkra ${currentVersion} Backup ${suffix}.app`;
    renameSync(target, backup);
  }
  run("ditto", [source, target]);
  run("codesign", ["--verify", "--deep", "--strict", "--verbose=4", target]);
  run("open", [target]);
  process.stdout.write(
    `Installed Penkra ${version} from ${basename(zipNames[0])}${backup ? `; previous app: ${backup}` : ""}.\n`,
  );
} catch (error) {
  if (!existsSync(target) && backup && existsSync(backup)) renameSync(backup, target);
  throw error;
} finally {
  rmSync(extractionRoot, { force: true, recursive: true });
}
