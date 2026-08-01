import * as Path from "node:path";

import { describe, expect, it } from "vitest";

import {
  createDesktopStaticProtocolResolver,
  resolveDesktopAppRoot,
} from "./desktopStaticProtocol";

const staticRoot = Path.resolve("/virtual/penkra-static");
const rootIndex = Path.join(staticRoot, "index.html");

function resolverWithExistingPaths(paths: ReadonlyArray<string>) {
  const existingPaths = new Set(paths.map((entry) => Path.resolve(entry)));
  return createDesktopStaticProtocolResolver(staticRoot, (candidate) =>
    existingPaths.has(Path.resolve(candidate)),
  );
}

describe("createDesktopStaticProtocolResolver", () => {
  it("uses the source checkout for Dev and the packaged root for Stable", () => {
    expect(
      resolveDesktopAppRoot({
        isPackagedRuntime: false,
        sourceRoot: "/checkout",
        packagedAppRoot: "/Applications/Penkra.app",
      }),
    ).toBe("/checkout");
    expect(
      resolveDesktopAppRoot({
        isPackagedRuntime: true,
        sourceRoot: "/checkout",
        packagedAppRoot: "/Applications/Penkra.app",
      }),
    ).toBe("/Applications/Penkra.app");
  });

  it("resolves an existing asset inside the static root", () => {
    const assetPath = Path.join(staticRoot, "assets", "app.js");
    const resolveRequest = resolverWithExistingPaths([rootIndex, assetPath]);

    expect(resolveRequest("penkra://app/assets/app.js")).toEqual({ path: assetPath });
  });

  it("returns Electron file-not-found for a missing asset", () => {
    const resolveRequest = resolverWithExistingPaths([rootIndex]);

    expect(resolveRequest("penkra://app/assets/missing.js")).toEqual({ error: -6 });
  });

  it("resolves an extensionless route to its existing nested index", () => {
    const nestedIndex = Path.join(staticRoot, "settings", "index.html");
    const resolveRequest = resolverWithExistingPaths([rootIndex, nestedIndex]);

    expect(resolveRequest("penkra://app/settings")).toEqual({ path: nestedIndex });
  });

  it("falls back to the root index for a missing navigation route", () => {
    const resolveRequest = resolverWithExistingPaths([rootIndex]);

    expect(resolveRequest("penkra://app/thread/missing")).toEqual({ path: rootIndex });
  });

  it("keeps encoded traversal inside the root and safely handles malformed encoding", () => {
    const observedPaths: string[] = [];
    const resolveRequest = createDesktopStaticProtocolResolver(staticRoot, (candidate) => {
      const resolvedCandidate = Path.resolve(candidate);
      observedPaths.push(resolvedCandidate);
      return resolvedCandidate === rootIndex;
    });

    expect(resolveRequest("penkra://app/..%2Foutside.js")).toEqual({ error: -6 });
    expect(resolveRequest("penkra://app/%E0%A4%A")).toEqual({ path: rootIndex });
    expect(
      observedPaths.every(
        (candidate) => candidate === staticRoot || candidate.startsWith(`${staticRoot}${Path.sep}`),
      ),
    ).toBe(true);
  });
});
