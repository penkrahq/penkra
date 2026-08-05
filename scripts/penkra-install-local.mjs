#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed: ${result.stderr || result.stdout}`,
    );
  }
  return result.stdout.trim();
}

function safePathComponent(value) {
  return value.replaceAll(/[^A-Za-z0-9._-]+/g, "-");
}

export function replaceAppAtomically({
  source,
  target,
  backupLabel = "Previous",
  timestamp = new Date().toISOString(),
  staging = join(
    dirname(target),
    `.${basename(target)}.install-${randomUUID()}`,
  ),
  exists = existsSync,
  copy = (from, to) =>
    cpSync(from, to, { recursive: true, preserveTimestamps: true }),
  rename = renameSync,
  remove = (path) => rmSync(path, { force: true, recursive: true }),
  verify,
}) {
  if (exists(staging)) remove(staging);
  let backup = null;
  let targetMoved = false;

  try {
    // Prepare and verify the complete replacement without touching the live app.
    copy(source, staging);
    verify(staging);

    if (exists(target)) {
      const suffix = safePathComponent(timestamp);
      backup = join(
        dirname(target),
        `Penkra ${safePathComponent(backupLabel)} Backup ${suffix}.app`,
      );
      if (exists(backup))
        throw new Error(`Local install backup already exists: ${backup}`);
      rename(target, backup);
      targetMoved = true;
    }

    // Staging and target share /Applications, so this is one atomic filesystem rename.
    rename(staging, target);
    verify(target);
    return { backup };
  } catch (error) {
    if (exists(staging)) remove(staging);
    if (targetMoved && backup && exists(backup)) {
      if (exists(target)) remove(target);
      rename(backup, target);
    }
    throw error;
  }
}

export function schedulePenkraRelaunch(target, spawnProcess = spawn) {
  const script = [
    "sleep 3",
    "/usr/bin/osascript -e 'tell application \"Penkra\" to quit' >/dev/null 2>&1 || true",
    "sleep 2",
    '/usr/bin/open -n "$1"',
  ].join("; ");
  const child = spawnProcess(
    "/bin/sh",
    ["-c", script, "penkra-relaunch", target],
    {
      detached: true,
      stdio: "ignore",
    },
  );
  child.unref();
}

export function installLocalRelease(artifactDir = resolve("release")) {
  const zipNames = readdirSync(artifactDir).filter((name) =>
    name.endsWith(".zip"),
  );
  if (zipNames.length !== 1 || !zipNames[0]) {
    throw new Error(
      `Expected one update ZIP in ${artifactDir}, found ${zipNames.length}.`,
    );
  }

  const extractionRoot = mkdtempSync(join(tmpdir(), "penkra-local-install-"));
  const target = "/Applications/Penkra.app";
  try {
    run("ditto", ["-x", "-k", join(artifactDir, zipNames[0]), extractionRoot]);
    const appNames = readdirSync(extractionRoot).filter((name) =>
      name.endsWith(".app"),
    );
    if (appNames.length !== 1 || !appNames[0])
      throw new Error("Update ZIP must contain one app.");
    const source = join(extractionRoot, appNames[0]);
    const verify = (path) =>
      run("codesign", ["--verify", "--deep", "--strict", "--verbose=4", path]);
    verify(source);
    const version = run("defaults", [
      "read",
      join(source, "Contents", "Info"),
      "CFBundleShortVersionString",
    ]);
    const manifest = readdirSync(artifactDir).find(
      (name) => name === "latest-mac.yml",
    );
    if (!manifest)
      throw new Error("Release directory does not contain latest-mac.yml.");
    const manifestVersion = run("sed", [
      "-n",
      "s/^version: *//p",
      join(artifactDir, manifest),
    ]);
    if (version !== manifestVersion) {
      throw new Error(
        `Local artifact version ${version} does not match update manifest ${manifestVersion}.`,
      );
    }

    let backupLabel = "Previous";
    if (existsSync(target)) {
      try {
        backupLabel = run("defaults", [
          "read",
          join(target, "Contents", "Info"),
          "CFBundleShortVersionString",
        ]);
      } catch {
        backupLabel = "Invalid";
      }
    }
    const { backup } = replaceAppAtomically({
      source,
      target,
      backupLabel,
      copy: (from, to) => run("ditto", [from, to]),
      verify,
    });
    process.stdout.write(
      `Installed Penkra ${version} from ${basename(zipNames[0])}${backup ? `; previous app: ${backup}` : ""}. Penkra will restart.\n`,
    );
    // The installer can itself be hosted by Penkra. Commit the atomic replacement
    // first, then let an independent process quit and relaunch the application.
    schedulePenkraRelaunch(target);
  } finally {
    rmSync(extractionRoot, { force: true, recursive: true });
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  installLocalRelease(resolve(process.argv[2] ?? "release"));
}
