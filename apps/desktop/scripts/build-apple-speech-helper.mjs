// FILE: build-apple-speech-helper.mjs
// Purpose: Builds macOS native helpers for development and release target architectures.
// Layer: Desktop build tooling

import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") process.exit(0);

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const helper = process.argv[2] === "network" ? "network" : "speech";
const source = join(
  desktopRoot,
  "native",
  "macos",
  helper === "network" ? "PenkraNetworkPathMonitor.swift" : "PenkraSpeechTranscriber.swift",
);
const outputDirectory = join(desktopRoot, "resources", "native");
const output = join(
  outputDirectory,
  helper === "network" ? "penkra-network-path-monitor" : "penkra-speech-transcriber",
);
const requestedArch = process.env.PENKRA_DESKTOP_TARGET_ARCH?.trim() || process.arch;

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(`${command} failed${detail ? `:\n${detail}` : "."}`);
  }
}

function compile(arch, target) {
  const swiftArch = arch === "x64" ? "x86_64" : "arm64";
  run("xcrun", [
    "swiftc",
    "-parse-as-library",
    "-O",
    "-target",
    `${swiftArch}-apple-macos13.0`,
    source,
    "-o",
    target,
  ]);
}

mkdirSync(outputDirectory, { recursive: true });
if (requestedArch === "universal") {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "penkra-speech-helper-"));
  try {
    const arm64 = join(temporaryDirectory, "arm64");
    const x64 = join(temporaryDirectory, "x64");
    compile("arm64", arm64);
    compile("x64", x64);
    run("xcrun", ["lipo", "-create", arm64, x64, "-output", output]);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
} else if (requestedArch === "arm64" || requestedArch === "x64") {
  compile(requestedArch, output);
} else {
  throw new Error(`Unsupported macOS native helper architecture: ${requestedArch}`);
}
chmodSync(output, 0o755);
