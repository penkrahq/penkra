import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createPackage } from "@electron/asar";
import { expect, it } from "vitest";

const electronPath = createRequire(import.meta.url)("electron") as string;

it("accepts the desktop's real asar signature in an Electron backend", async () => {
  const root = mkdtempSync(join(tmpdir(), "penkra-diagnostics-asar-"));
  try {
    const contents = join(root, "contents");
    mkdirSync(contents);
    writeFileSync(join(contents, "package.json"), '{"name":"asar-signature-test"}');
    const archive = join(root, "app.asar");
    await createPackage(contents, archive);

    const storeSource = resolve(
      import.meta.dirname,
      "../../../packages/shared/src/diagnostics/store.ts",
    );
    const compiledStore = join(root, "store.cjs");
    execFileSync("bun", [
      "build",
      storeSource,
      "--target=node",
      "--format=cjs",
      `--outfile=${compiledStore}`,
    ]);

    const harness = join(root, "check.cjs");
    writeFileSync(
      harness,
      `const fs = require("node:fs");
const originalFs = require("original-fs");
const { DiagnosticsStore } = require(${JSON.stringify(compiledStore)});
const archive = process.argv[2];
const stateDir = process.argv[3];
const virtual = fs.statSync(archive);
const real = originalFs.statSync(archive);
const bundleSignature = { size: real.size, mtimeMs: real.mtimeMs, inode: real.ino };
const before = process.noAsar;
const store = new DiagnosticsStore({ stateDir, appVersion: "0.14.3", process: "server", bundlePath: archive, bundleSignature });
store.checkpoint({ traceId: "0123456789abcdef0123456789abcdef", spanId: "0123456789abcdef", flow: "send", step: "composer.preflight" });
store.close();
console.log(JSON.stringify({ virtualSize: virtual.size, realSize: real.size, virtualInode: virtual.ino, realInode: real.ino, restored: process.noAsar === before }));
`,
    );
    const output = execFileSync(electronPath, [harness, archive, join(root, "state")], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      encoding: "utf8",
      timeout: 30_000,
    });
    const result = JSON.parse(output.trim()) as {
      virtualSize: number;
      realSize: number;
      virtualInode: number;
      realInode: number;
      restored: boolean;
    };
    expect(result.realSize).toBeGreaterThan(0);
    expect([result.virtualSize, result.virtualInode]).not.toEqual([
      result.realSize,
      result.realInode,
    ]);
    expect(result.restored).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
