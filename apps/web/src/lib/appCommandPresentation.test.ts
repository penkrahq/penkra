import type { DesktopAppInstallationSnapshot } from "@penkra/contracts";
import { describe, expect, it } from "vitest";

import { resolveInstalledAppCommandPresentation } from "./appCommandPresentation";

function snapshot(): DesktopAppInstallationSnapshot {
  return {
    currentSpaceId: "space-active",
    installed: [
      {
        id: "com.penkra.canvas.other",
        spaceId: "space-other",
        slug: "canvas",
        name: "Canvas",
        summary: "Canvas",
        version: "1.0.0",
        source: "registry",
        installedAt: "2026-08-19T00:00:00.000Z",
        iconDataUrl: "data:image/png;base64,other",
        permissions: [],
        skills: [],
        handlers: [],
      },
      {
        id: "com.penkra.canvas",
        spaceId: "space-active",
        slug: "canvas",
        name: "Canvas",
        summary: "Canvas",
        version: "1.0.0",
        source: "registry",
        installedAt: "2026-08-19T00:00:00.000Z",
        iconDataUrl: "data:image/png;base64,active",
        permissions: [],
        skills: [],
        handlers: [],
      },
    ],
    spaces: [],
  };
}

describe("resolveInstalledAppCommandPresentation", () => {
  it("resolves the command root to the App installed in the active Space", () => {
    const presentation = resolveInstalledAppCommandPresentation(
      "canvas documents mutate --document-id doc-1",
      snapshot(),
    );

    expect(presentation?.slug).toBe("canvas");
    expect(presentation?.app.iconDataUrl).toBe("data:image/png;base64,active");
    expect(presentation?.command).toBe("canvas documents mutate --document-id doc-1");
  });

  it("does not treat core Penkra or unknown commands as App commands", () => {
    expect(resolveInstalledAppCommandPresentation("penkra tabs list", snapshot())).toBeNull();
    expect(resolveInstalledAppCommandPresentation("unknown records list", snapshot())).toBeNull();
  });
});
