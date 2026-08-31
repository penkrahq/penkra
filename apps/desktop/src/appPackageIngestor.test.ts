import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import yazl from "yazl";

import { AppPackageIngestor, PENKRA_APP_MANIFEST_FILE_NAME } from "./appPackageIngestor";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) FS.rmSync(root, { recursive: true, force: true });
});

function fixture(): { root: string; sourcePath: string; storePath: string } {
  const root = FS.mkdtempSync(Path.join(OS.tmpdir(), "penkra-app-package-"));
  roots.push(root);
  const sourcePath = Path.join(root, "source");
  const storePath = Path.join(root, "store");
  FS.mkdirSync(Path.join(sourcePath, "assets"), { recursive: true });
  FS.writeFileSync(Path.join(sourcePath, "README.md"), "# Example\n");
  FS.writeFileSync(Path.join(sourcePath, "INSTRUCTIONS.md"), "Use Example.\n");
  FS.writeFileSync(Path.join(sourcePath, "app.html"), "<!doctype html><title>Example</title>");
  FS.writeFileSync(Path.join(sourcePath, "assets", "icon.svg"), "<svg/>");
  FS.writeFileSync(
    Path.join(sourcePath, PENKRA_APP_MANIFEST_FILE_NAME),
    JSON.stringify({
      id: "com.example.app",
      slug: "example",
      name: "Example",
      summary: "An example App",
      version: "1.0.0",
      compatibility: { penkra: ">=0.8.0" },
      icons: [{ src: "assets/icon.svg", sizes: "any", type: "image/svg+xml" }],
      entrypoints: { tab: "app.html" },
    }),
  );
  return { root, sourcePath, storePath };
}

describe("AppPackageIngestor", () => {
  it("validates, hashes, and commits an immutable unpacked package", async () => {
    const { sourcePath, storePath } = fixture();
    const ingestor = new AppPackageIngestor(storePath);
    const first = await ingestor.ingestDirectory({
      sourcePath,
      source: "sideload",
      installedAt: "2026-08-01T00:00:00.000Z",
    });
    const second = await ingestor.ingestDirectory({
      sourcePath,
      source: "sideload",
      installedAt: "2026-08-01T00:00:00.000Z",
    });

    expect(first.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(second.packagePath).toBe(first.packagePath);
    expect(FS.readFileSync(Path.join(first.packagePath, "app.html"), "utf8")).toContain("Example");
  });

  it("rejects packages that omit required listing documentation", async () => {
    const { sourcePath, storePath } = fixture();
    FS.rmSync(Path.join(sourcePath, "INSTRUCTIONS.md"));
    await expect(
      new AppPackageIngestor(storePath).ingestDirectory({ sourcePath, source: "sideload" }),
    ).rejects.toThrow("INSTRUCTIONS.md");
  });

  it("rejects empty agent instructions before package commit", async () => {
    const { sourcePath, storePath } = fixture();
    FS.writeFileSync(Path.join(sourcePath, "INSTRUCTIONS.md"), "  \n");
    await expect(
      new AppPackageIngestor(storePath).ingestDirectory({ sourcePath, source: "sideload" }),
    ).rejects.toThrow("must not be empty");
  });

  it("ingests nonempty file-backed operation guidance and rejects an empty guide", async () => {
    const { sourcePath, storePath } = fixture();
    const manifestPath = Path.join(sourcePath, PENKRA_APP_MANIFEST_FILE_NAME);
    const manifest = JSON.parse(FS.readFileSync(manifestPath, "utf8"));
    manifest.entrypoints.controller = "operations.js";
    manifest.operations = [
      {
        key: "documents.execute",
        summary: "Edit one document.",
        instructionsPath: "operations/documents.execute.md",
        input: { type: "object", additionalProperties: false },
        output: { type: "object", additionalProperties: true },
        examples: [{ name: "Inspect a document", input: {} }],
        handler: "documents.execute",
      },
    ];
    FS.writeFileSync(manifestPath, JSON.stringify(manifest));
    FS.writeFileSync(Path.join(sourcePath, "operations.js"), "export {};\n");
    FS.mkdirSync(Path.join(sourcePath, "operations"));
    FS.writeFileSync(
      Path.join(sourcePath, "operations", "documents.execute.md"),
      "# Editing documents\n",
    );

    await expect(
      new AppPackageIngestor(storePath).ingestDirectory({
        sourcePath,
        source: "sideload",
      }),
    ).resolves.toMatchObject({ manifest: { id: "com.example.app" } });

    FS.writeFileSync(Path.join(sourcePath, "operations", "documents.execute.md"), "  \n");
    await expect(
      new AppPackageIngestor(storePath).ingestDirectory({
        sourcePath,
        source: "sideload",
      }),
    ).rejects.toThrow("must not be empty");
  });

  it("rejects symbolic links instead of copying outside the package", async () => {
    const { root, sourcePath, storePath } = fixture();
    FS.symlinkSync(Path.join(root, "outside"), Path.join(sourcePath, "escape"));
    await expect(
      new AppPackageIngestor(storePath).ingestDirectory({ sourcePath, source: "sideload" }),
    ).rejects.toThrow("symbolic links");
  });

  it("safely extracts and commits a digest-verified registry archive", async () => {
    const { storePath } = fixture();
    const packageBytes = await registryArchive();
    const expectedArchiveDigest = createHash("sha256").update(packageBytes).digest("hex");
    const archivePath = Path.join(roots[roots.length - 1]!, "package.penkra");
    FS.writeFileSync(archivePath, packageBytes);

    const installed = await new AppPackageIngestor(storePath).ingestRegistryArchive({
      archivePath,
      expectedArchiveDigest,
      installedAt: "2026-08-01T00:00:00.000Z",
    });

    expect(installed.source).toBe("registry");
    expect(installed.manifest.id).toBe("com.example.app");
    expect(FS.readFileSync(Path.join(installed.packagePath, "app.html"), "utf8")).toContain(
      "Example",
    );
  });

  it("rejects a legacy registry manifest instead of normalizing immutable package bytes", async () => {
    const { storePath } = fixture();
    const packageBytes = await registryArchive(true);
    const archivePath = Path.join(roots[roots.length - 1]!, "legacy-package.penkra");
    FS.writeFileSync(archivePath, packageBytes);

    await expect(
      new AppPackageIngestor(storePath).ingestRegistryArchive({
        archivePath,
        expectedArchiveDigest: createHash("sha256").update(packageBytes).digest("hex"),
      }),
    ).rejects.toThrow("entrypoints.tab");
  });

  it("rejects a registry archive whose digest changed before extraction", async () => {
    const { storePath } = fixture();
    const packageBytes = await registryArchive();
    const archivePath = Path.join(roots[roots.length - 1]!, "package.penkra");
    FS.writeFileSync(archivePath, packageBytes);
    await expect(
      new AppPackageIngestor(storePath).ingestRegistryArchive({
        archivePath,
        expectedArchiveDigest: "a".repeat(64),
      }),
    ).rejects.toThrow("digest changed");
  });

  it("removes only unreferenced immutable packages during startup collection", async () => {
    const { sourcePath, storePath } = fixture();
    const ingestor = new AppPackageIngestor(storePath);
    const retained = await ingestor.ingestDirectory({ sourcePath, source: "registry" });
    const stalePath = Path.join(storePath, "com.example.app", "0.9.0", "stale-digest");
    const interruptedPath = Path.join(
      storePath,
      "com.example.app",
      "2.0.0",
      ".package.interrupted.tmp",
    );
    FS.mkdirSync(stalePath, { recursive: true });
    FS.writeFileSync(Path.join(stalePath, "old.js"), "old");
    FS.mkdirSync(interruptedPath, { recursive: true });

    const result = await ingestor.collectGarbage([retained.packagePath]);

    expect(result.failures).toEqual([]);
    expect(result.removedPaths).toEqual(expect.arrayContaining([stalePath, interruptedPath]));
    expect(FS.existsSync(stalePath)).toBe(false);
    expect(FS.existsSync(interruptedPath)).toBe(false);
    expect(FS.existsSync(retained.packagePath)).toBe(true);
  });

  it("rejects retained paths outside the owned three-level package store", async () => {
    const { root, storePath } = fixture();
    await expect(new AppPackageIngestor(storePath).collectGarbage([root])).rejects.toThrow(
      "outside the package store or has an invalid shape",
    );
  });
});

async function registryArchive(legacy = false): Promise<Buffer> {
  const zip = new yazl.ZipFile();
  zip.addBuffer(
    Buffer.from(
      JSON.stringify({
        ...(legacy ? { manifestVersion: 2 } : {}),
        id: "com.example.app",
        slug: "example",
        name: "Example",
        summary: "An example App",
        version: "1.0.0",
        compatibility: { penkra: ">=0.8.0" },
        icons: [{ src: "assets/icon.svg", sizes: "any", type: "image/svg+xml" }],
        entrypoints: legacy
          ? { app: "app.html", operations: "operations.js" }
          : { tab: "app.html" },
        ...(legacy
          ? {
              operations: [
                {
                  key: "documents.list",
                  summary: "List example documents.",
                  input: { type: "object", additionalProperties: false },
                  output: { type: "object", additionalProperties: false },
                  examples: [{ name: "List documents", input: {} }],
                  handler: "documents.list",
                },
              ],
            }
          : {}),
      }),
    ),
    "penkra-app.json",
  );
  zip.addBuffer(Buffer.from("# Example\n"), "README.md");
  zip.addBuffer(Buffer.from("Use Example.\n"), "INSTRUCTIONS.md");
  zip.addBuffer(Buffer.from("<!doctype html><title>Example</title>"), "app.html");
  if (legacy) zip.addBuffer(Buffer.from("module.exports = {};\n"), "operations.js");
  zip.addBuffer(Buffer.from("<svg/>"), "assets/icon.svg");
  zip.end();
  const chunks: Buffer[] = [];
  for await (const chunk of zip.outputStream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
