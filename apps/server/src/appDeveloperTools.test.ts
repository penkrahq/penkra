import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { packageAppDirectory, testAppDirectory } from "./appDeveloperTools";

const roots: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("App developer integration host", () => {
  it("uses the running desktop's installed test entry and removes its temporary profile", async () => {
    const source = await mkdtemp(join(tmpdir(), "penkra-app-test-source-"));
    roots.push(source);
    const host = join(source, "host.mjs");
    await writeFile(
      host,
      `import { writeFileSync } from "node:fs";
writeFileSync(process.env.PENKRA_APP_TEST_RESULT, JSON.stringify({
  ok: true,
  appId: "com.example.canvas",
  version: "1.0.0",
  tab: { id: "tab-installed", status: "ready" },
  diagnostics: [{ kind: "tab-ready" }]
}));
`,
    );
    vi.stubEnv("PENKRA_APP_TEST_ELECTRON", process.execPath);
    vi.stubEnv("PENKRA_APP_TEST_HOST", host);
    vi.stubEnv("PENKRA_APP_TEST_PACKAGED", "0");

    await expect(testAppDirectory({ directory: source })).resolves.toEqual({
      ok: true,
      appId: "com.example.canvas",
      version: "1.0.0",
      tab: { id: "tab-installed", status: "ready" },
      diagnostics: [{ kind: "tab-ready" }],
      profileRemoved: true,
    });
  });

  it("does not fall back to a source checkout outside a running desktop", async () => {
    const source = await mkdtemp(join(tmpdir(), "penkra-app-test-source-"));
    roots.push(source);
    vi.stubEnv("PENKRA_APP_TEST_ELECTRON", "");
    vi.stubEnv("PENKRA_APP_TEST_HOST", "");
    vi.stubEnv("PENKRA_APP_TEST_PACKAGED", "");

    await expect(testAppDirectory({ directory: source })).rejects.toThrow(
      "available only inside a running Penkra desktop",
    );
  });

  it("returns a schema-safe timeout message when the host produces no output", async () => {
    const source = await mkdtemp(join(tmpdir(), "penkra-app-test-source-"));
    roots.push(source);
    const host = join(source, "host.mjs");
    await writeFile(host, "setInterval(() => undefined, 1_000);\n");
    vi.stubEnv("PENKRA_APP_TEST_ELECTRON", process.execPath);
    vi.stubEnv("PENKRA_APP_TEST_HOST", host);
    vi.stubEnv("PENKRA_APP_TEST_PACKAGED", "0");

    const error = await testAppDirectory({ directory: source, timeoutMs: 20 }).catch(
      (cause: unknown) => cause,
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("App integration test exceeded 20 ms.");
  });

  it("reports structured host failures when the isolated host exits nonzero", async () => {
    const source = await mkdtemp(join(tmpdir(), "penkra-app-test-source-"));
    roots.push(source);
    const host = join(source, "host.mjs");
    await writeFile(
      host,
      `import { writeFileSync } from "node:fs";
writeFileSync(process.env.PENKRA_APP_TEST_RESULT, JSON.stringify({
  ok: false,
  error: "Manifest validation failed."
}));
process.exitCode = 1;
`,
    );
    vi.stubEnv("PENKRA_APP_TEST_ELECTRON", process.execPath);
    vi.stubEnv("PENKRA_APP_TEST_HOST", host);
    vi.stubEnv("PENKRA_APP_TEST_PACKAGED", "0");

    await expect(testAppDirectory({ directory: source })).rejects.toThrow(
      "Manifest validation failed.",
    );
  });
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
    const firstArchive = await readFile(first);
    expect(firstArchive).toEqual(await readFile(second));
    expect(firstArchive.readUInt32LE(0)).toBe(0x04034b50);
    expect(firstArchive.readUInt16LE(8)).toBe(0);
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
        manifestVersion: 2,
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
