import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { InstalledAppPackage } from "./appInstallationState";
import { APP_ICON_MAX_BYTES, resolveInstalledAppIconDataUrl } from "./appIconDataUrl";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) FS.rmSync(root, { force: true, recursive: true });
});

function app(
  packagePath: string,
  icons: InstalledAppPackage["manifest"]["icons"],
): InstalledAppPackage {
  return {
    appId: "com.acme.figma",
    slug: "figma",
    name: "Figma",
    summary: "Design collaboratively.",
    version: "1.0.0",
    source: "registry",
    packagePath,
    sha256: "a".repeat(64),
    installedAt: "2026-08-02T00:00:00.000Z",
    manifest: {
      id: "com.acme.figma",
      slug: "figma",
      name: "Figma",
      summary: "Design collaboratively.",
      version: "1.0.0",
      compatibility: { penkra: ">=0.8.0" },
      icons,
      entrypoints: { tab: "app.html" },
    },
  };
}

describe("resolveInstalledAppIconDataUrl", () => {
  it("returns the first small supported icon as a data URL", async () => {
    const root = FS.mkdtempSync(Path.join(OS.tmpdir(), "penkra-app-icon-"));
    roots.push(root);
    FS.mkdirSync(Path.join(root, "assets"));
    FS.writeFileSync(Path.join(root, "assets", "icon.svg"), "<svg></svg>");

    await expect(
      resolveInstalledAppIconDataUrl(
        app(root, [{ src: "assets/icon.svg", sizes: "any", type: "image/svg+xml" }]),
      ),
    ).resolves.toBe("data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=");
  });

  it("skips missing, unsupported, and oversized icons without blocking startup", async () => {
    const root = FS.mkdtempSync(Path.join(OS.tmpdir(), "penkra-app-icon-"));
    roots.push(root);
    FS.writeFileSync(Path.join(root, "large.png"), Buffer.alloc(APP_ICON_MAX_BYTES + 1));

    await expect(
      resolveInstalledAppIconDataUrl(
        app(root, [
          { src: "missing.svg", sizes: "any", type: "image/svg+xml" },
          { src: "large.png", sizes: "256x256", type: "image/png" },
          { src: "icon.ico", sizes: "32x32", type: "image/x-icon" },
        ]),
      ),
    ).resolves.toBeNull();
  });
});
