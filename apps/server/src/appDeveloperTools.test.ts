import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { packageAppDirectory } from "./appDeveloperTools";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("App developer packaging", () => {
  it("creates reproducible archives and complete submission evidence", async () => {
    const root = await fixture();
    const first = join(root, "..", "first.penkra");
    const second = join(root, "..", "second.penkra");

    const one = await packageAppDirectory({ directory: root, output: first });
    const two = await packageAppDirectory({ directory: root, output: second });

    expect(one).toEqual(
      expect.objectContaining({
        appId: "com.example.canvas",
        slug: "canvas",
        version: "1.0.0",
        compatibilityRange: ">=0.8.0",
        packageSizeBytes: expect.any(Number),
        permissions: [
          { permission: "network-fetch", required: false, rationale: "Sync documents" },
        ],
      }),
    );
    expect(one.packageDigest).toBe(two.packageDigest);
    expect(await readFile(first)).toEqual(await readFile(second));
  });

  it("rejects missing manifest references before writing an archive", async () => {
    const root = await fixture();
    await rm(join(root, "assets", "icon.svg"));

    await expect(
      packageAppDirectory({ directory: root, output: join(root, "..", "bad.penkra") }),
    ).rejects.toThrow("Manifest reference is missing");
  });

  it("rejects symlinks and output paths inside the package root", async () => {
    const root = await fixture();
    await expect(
      packageAppDirectory({ directory: root, output: join(root, "app.penkra") }),
    ).rejects.toThrow("outside the packaged directory");
    await rm(join(root, "app.html"));
    await import("node:fs/promises").then(({ symlink }) =>
      symlink("README.md", join(root, "app.html")),
    );
    await expect(
      packageAppDirectory({ directory: root, output: join(root, "..", "bad.penkra") }),
    ).rejects.toThrow("Symbolic links are not allowed");
  });
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "penkra-app-package-"));
  roots.push(
    root,
    join(root, "..", "first.penkra"),
    join(root, "..", "second.penkra"),
    join(root, "..", "bad.penkra"),
  );
  await mkdir(join(root, "assets"));
  await writeFile(join(root, "README.md"), "# Canvas\n");
  await writeFile(join(root, "INSTRUCTIONS.md"), "Use the declared operations safely.\n");
  await writeFile(join(root, "app.html"), "<!doctype html><title>Canvas</title>\n");
  await writeFile(
    join(root, "assets", "icon.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg"></svg>\n',
  );
  await writeFile(
    join(root, "penkra-app.json"),
    JSON.stringify(
      {
        manifestVersion: 1,
        id: "com.example.canvas",
        slug: "canvas",
        name: "Canvas",
        summary: "Edit visual documents.",
        version: "1.0.0",
        compatibility: { penkra: ">=0.8.0" },
        icons: [{ src: "assets/icon.svg", sizes: "any", type: "image/svg+xml" }],
        entrypoints: { app: "app.html" },
        permissions: [{ name: "network-fetch", required: false, reason: "Sync documents" }],
      },
      null,
      2,
    ),
  );
  return root;
}
