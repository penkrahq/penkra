// FILE: build-computer-helper.mjs
// Purpose: Builds Penkra's Computer Use driver (P57) from open-computer-use (MIT), pinned to a
// reviewed commit, as one plain binary in resources/native. It ships inside Penkra.app and is
// signed with Penkra's identity, so macOS keeps Accessibility and Screen Recording on Penkra.
// Layer: Desktop build tooling

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") process.exit(0);

const REPOSITORY = "https://github.com/iFurySt/open-computer-use.git";
const TAG = "v1.1.4";
const COMMIT = "97a8810182a2d09fbccd15387f4628aa1916e7d7";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(desktopRoot, "resources", "native", "penkra-computer");
const requestedArch = process.env.PENKRA_DESKTOP_TARGET_ARCH?.trim() || process.arch;
// SwiftPM shells out to `git`; make sure the system one is found first.
const env = { ...process.env, PATH: `/usr/bin:${process.env.PATH ?? ""}` };

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(`${command} ${args.join(" ")} failed${detail ? `:\n${detail}` : "."}`);
  }
  return result.stdout.trim();
}

// Dev starts run build:native every time; rebuild only when the pin or the architecture changes.
const stamp = `${output}.version`;
const wanted = `${COMMIT} ${requestedArch}`;
if (existsSync(output) && existsSync(stamp) && readFileSync(stamp, "utf8").trim() === wanted) {
  process.exit(0);
}

const source = mkdtempSync(join(tmpdir(), "penkra-computer-src-"));
try {
  run("git", ["clone", "--quiet", "--depth", "1", "--branch", TAG, REPOSITORY, source]);
  const head = run("git", ["rev-parse", "HEAD"], source);
  if (head !== COMMIT) throw new Error(`${TAG} moved: expected ${COMMIT}, got ${head}.`);
  const archs =
    requestedArch === "universal"
      ? ["arm64", "x86_64"]
      : requestedArch === "x64"
        ? ["x86_64"]
        : requestedArch === "arm64"
          ? ["arm64"]
          : null;
  if (!archs) throw new Error(`Unsupported macOS native helper architecture: ${requestedArch}`);
  run(
    "swift",
    [
      "build",
      "-c",
      "release",
      "--product",
      "OpenComputerUse",
      ...archs.flatMap((arch) => ["--arch", arch]),
    ],
    source,
  );
  const built = [
    join(source, ".build", "apple", "Products", "Release", "OpenComputerUse"),
    join(source, ".build", "release", "OpenComputerUse"),
  ].find((candidate) => existsSync(candidate));
  if (!built) throw new Error("open-computer-use build produced no binary.");
  mkdirSync(dirname(output), { recursive: true });
  copyFileSync(built, output);
  chmodSync(output, 0o755);
  writeFileSync(stamp, `${wanted}\n`);
  console.log(`penkra-computer ${TAG} (${archs.join("+")}) -> ${output}`);
} finally {
  rmSync(source, { recursive: true, force: true });
}
