// Post-build contract: CI runs this through test:diagnostics-bundles after build:desktop.
// The workspace test command excludes this file; missing build outputs must fail here.
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const fixture = fileURLToPath(new URL("./scripted-codex-app-server.mjs", import.meta.url));
const marker = "PENKRA_QA_SCRIPTED_PROVIDER_FIXTURE_V1";

describe("normal bundle QA exclusions", () => {
  it("is outside packaged files and absent from the built app bundles", () => {
    const serverPackage = JSON.parse(
      fs.readFileSync(path.join(repoRoot, "apps/server/package.json"), "utf8"),
    ) as { files: string[] };
    expect(serverPackage.files).toEqual(["dist"]);
    expect(fs.existsSync(path.join(repoRoot, "apps/server/dist/index.mjs"))).toBe(true);
    expect(fixture.startsWith(path.join(repoRoot, "apps/server/dist"))).toBe(false);
    // build-desktop-artifact stages dist-electron into the packaged app.
    for (const output of ["apps/server/dist", "apps/desktop/dist-electron", "apps/web/dist"]) {
      const root = path.join(repoRoot, output);
      expect(fs.statSync(root).isDirectory(), output).toBe(true);
      let inspected = 0;
      const visit = (dir: string) => {
        for (const name of fs.readdirSync(dir)) {
          const file = path.join(dir, name);
          const stat = fs.statSync(file);
          if (stat.isDirectory()) visit(file);
          else if (/\.(?:js|mjs|cjs)$/u.test(name)) {
            inspected += 1;
            expect(fs.readFileSync(file, "utf8"), file).not.toContain(marker);
          }
        }
      };
      visit(root);
      expect(inspected, output).toBeGreaterThan(0);
    }
  }, 30_000);

  it("compiles the QA account guard false in the staged desktop bundle", () => {
    const bundled = fs.readFileSync(
      path.join(repoRoot, "apps/desktop/dist-electron/main.js"),
      "utf8",
    );
    expect(/function diagnosticsQaShellEnabled\(\)\s*\{\s*return false;\s*\}/u.test(bundled)).toBe(
      true,
    );
    const preload = fs.readFileSync(
      path.join(repoRoot, "apps/desktop/dist-electron/preload.js"),
      "utf8",
    );
    expect(preload).not.toContain("qaOpenWindow");
  });

  it("compiles fixture launch permission off in the staged server bundle", () => {
    const serverBundle = fs.readFileSync(path.join(repoRoot, "apps/server/dist/index.mjs"), "utf8");
    expect(serverBundle).toContain("buildEnabled: false");
    expect(serverBundle).not.toContain("buildEnabled: true");
  });
});
