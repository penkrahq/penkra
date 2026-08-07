// FILE: macos-icon.ts
// Purpose: Build a macOS ICNS file from one high-resolution square PNG.

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
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
  readonly badgeText?: string;
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
    const iconSourcePath = input.badgeText
      ? buildBadgedIconSource(temporaryRoot, input.sourcePngPath, input.badgeText)
      : input.sourcePngPath;
    mkdirSync(iconsetPath);
    for (const [fileName, size] of ICON_VARIANTS) {
      run("/usr/bin/sips", [
        "-z",
        String(size),
        String(size),
        iconSourcePath,
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

function buildBadgedIconSource(
  temporaryRoot: string,
  sourcePngPath: string,
  badgeText: string,
): string {
  if (!/^[1-9]\d{0,2}$/u.test(badgeText)) {
    throw new Error(`Invalid Penkra Dev icon badge: ${badgeText}`);
  }
  const scriptPath = join(temporaryRoot, "badge.swift");
  const outputPath = join(temporaryRoot, "badged.png");
  writeFileSync(
    scriptPath,
    `import AppKit

let arguments = CommandLine.arguments
guard arguments.count == 4,
      let source = NSImage(contentsOfFile: arguments[1]) else {
  fputs("Unable to read icon source\\n", stderr)
  exit(1)
}
let output = arguments[2]
let badge = arguments[3]
let size = NSSize(width: 1024, height: 1024)
let canvas = NSImage(size: size)
canvas.lockFocus()
source.draw(in: NSRect(origin: .zero, size: size))

let badgeRect = NSRect(x: 668, y: 52, width: 284, height: 284)
NSColor.white.setFill()
NSBezierPath(ovalIn: badgeRect).fill()
NSColor.black.setStroke()
let border = NSBezierPath(ovalIn: badgeRect.insetBy(dx: 10, dy: 10))
border.lineWidth = 20
border.stroke()

let paragraph = NSMutableParagraphStyle()
paragraph.alignment = .center
let attributes: [NSAttributedString.Key: Any] = [
  .font: NSFont.systemFont(ofSize: badge.count > 1 ? 142 : 172, weight: .bold),
  .foregroundColor: NSColor.black,
  .paragraphStyle: paragraph,
]
let textRect = NSRect(x: badgeRect.minX, y: badgeRect.minY + 42, width: badgeRect.width, height: 210)
(badge as NSString).draw(in: textRect, withAttributes: attributes)
canvas.unlockFocus()

guard let tiff = canvas.tiffRepresentation,
      let bitmap = NSBitmapImageRep(data: tiff),
      let png = bitmap.representation(using: .png, properties: [:]) else {
  fputs("Unable to render icon badge\\n", stderr)
  exit(1)
}
try png.write(to: URL(fileURLWithPath: output))
`,
  );
  run("/usr/bin/swift", [scriptPath, sourcePngPath, outputPath, badgeText]);
  return outputPath;
}
