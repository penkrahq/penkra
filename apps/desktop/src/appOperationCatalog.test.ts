import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createEmptyAppInstallationState,
  registerVerifiedAppPackage,
  setSpaceAppEnabled,
} from "./appInstallationState";
import { AppOperationCatalog } from "./appOperationCatalog";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) FS.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const packagePath = FS.mkdtempSync(Path.join(OS.tmpdir(), "penkra-app-operation-catalog-"));
  roots.push(packagePath);
  FS.writeFileSync(
    Path.join(packagePath, "INSTRUCTIONS.md"),
    "Confirm the destination project first.\n",
  );
  FS.mkdirSync(Path.join(packagePath, "skills", "create-issue"), { recursive: true });
  FS.writeFileSync(
    Path.join(packagePath, "skills", "create-issue", "SKILL.md"),
    "---\nname: create-issue\ndescription: Create a Linear issue.\n---\n",
  );
  let state = registerVerifiedAppPackage(
    createEmptyAppInstallationState(),
    {
      manifest: {
        manifestVersion: 2,
        id: "com.acme.linear",
        slug: "linear",
        name: "Linear",
        summary: "Manage issues.",
        version: "1.0.0",
        compatibility: { penkra: ">=0.8.0" },
        icons: [{ src: "icon.svg", sizes: "any", type: "image/svg+xml" }],
        entrypoints: { app: "app.html", operations: "operations.js" },
        operations: [
          {
            key: "issues.create",
            summary: "Create an issue.",
            input: { type: "object" },
            output: { type: "object" },
            examples: [{ name: "Create an issue", input: {} }],
            handler: "issues.create",
          },
        ],
        contributions: { skills: [{ path: "skills/create-issue" }] },
      },
      source: "registry",
      packagePath,
      sha256: "a".repeat(64),
      installedAt: "2026-08-01T00:00:00.000Z",
    },
    "personal",
  );
  state = setSpaceAppEnabled(state, {
    appId: "com.acme.linear",
    spaceId: "personal",
    enabled: true,
  });
  return { packagePath, state };
}

describe("App operation catalog", () => {
  it("lists and renders help only for Apps enabled in the selected Space", async () => {
    const { state } = fixture();
    const catalog = new AppOperationCatalog(() => state);
    expect(catalog.list("personal")).toMatchObject([
      {
        slug: "linear",
        operations: [
          { key: "issues.create", summary: "Create an issue.", input: { type: "object" } },
        ],
      },
    ]);
    expect(catalog.list("work")).toEqual([]);
    await expect(catalog.help({ spaceId: "personal", slug: "linear" })).resolves.toContain(
      "Confirm the destination project first.",
    );
    await expect(catalog.help({ spaceId: "work", slug: "linear" })).rejects.toThrow("not enabled");
    await expect(catalog.skills("personal")).resolves.toEqual([
      expect.objectContaining({
        appId: "com.acme.linear",
        path: "skills/create-issue",
        enabled: true,
        scope: "app:linear",
      }),
    ]);
    await expect(catalog.skills("work")).resolves.toEqual([]);
  });

  it("rejects symlinked package instructions", async () => {
    const { packagePath, state } = fixture();
    const outside = Path.join(
      Path.dirname(packagePath),
      `${Path.basename(packagePath)}-outside.md`,
    );
    roots.push(outside);
    FS.writeFileSync(outside, "outside\n");
    FS.rmSync(Path.join(packagePath, "INSTRUCTIONS.md"));
    FS.symlinkSync(outside, Path.join(packagePath, "INSTRUCTIONS.md"));
    await expect(
      new AppOperationCatalog(() => state).help({ spaceId: "personal", slug: "linear" }),
    ).rejects.toThrow("bounded file");
  });
});
