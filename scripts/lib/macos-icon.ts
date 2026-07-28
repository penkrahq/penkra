// FILE: macos-icon.ts
// Purpose: Build a macOS ICNS file from one high-resolution square PNG.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const ICON_VARIANTS = [
  ["icon_16x16.png", 16],
  ["icon_16x16@2x.png", 32],
  ["icon_32x32.png", 32],
  ["icon_32x32@2x.png", 64],
  ["icon_128x128.png", 128],
  ["icon_128x128@2x.png", 256],
  ["icon_256x256.png", 256],
  ["icon_256x256@2x.png", 512],
  ["icon_512x512.png", 512],
  ["icon_512x512@2x.png", 1024],
] as const;

export function resolvePenkraDevIconSource(repoRoot: string): string {
  return join(repoRoot, "apps", "desktop", "resources", "icon.png");
}

function run(command: string, args: readonly string[]): void {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(
      `${command} failed: ${result.stderr.trim() || result.stdout.trim() || "unknown error"}`,
    );
  }
}

export function buildMacosIcon(input: {
  readonly sourcePngPath: string;
  readonly targetIcnsPath: string;
}): void {
  if (!existsSync(input.sourcePngPath)) {
    throw new Error(`Missing macOS icon source: ${input.sourcePngPath}`);
  }
  if (
    existsSync(input.targetIcnsPath) &&
    statSync(input.targetIcnsPath).mtimeMs >= statSync(input.sourcePngPath).mtimeMs
  ) {
    return;
  }

  const temporaryRoot = mkdtempSync(join(tmpdir(), "penkra-dev-icon-"));
  const iconsetPath = join(temporaryRoot, "PenkraDev.iconset");
  const builtIconPath = join(temporaryRoot, "PenkraDev.icns");
  try {
    mkdirSync(iconsetPath);
    for (const [fileName, size] of ICON_VARIANTS) {
      run("/usr/bin/sips", [
        "-z",
        String(size),
        String(size),
        input.sourcePngPath,
        "--out",
        join(iconsetPath, fileName),
      ]);
    }
    run("/usr/bin/iconutil", ["-c", "icns", iconsetPath, "-o", builtIconPath]);
    mkdirSync(dirname(input.targetIcnsPath), { recursive: true });
    rmSync(input.targetIcnsPath, { force: true });
    renameSync(builtIconPath, input.targetIcnsPath);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}
