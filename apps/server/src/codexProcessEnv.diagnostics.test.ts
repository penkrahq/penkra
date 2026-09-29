import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./diagnostics/recorder", () => ({ recordDiagnosticIncident: vi.fn() }));

import { recordDiagnosticIncident } from "./diagnostics/recorder";
import {
  buildCodexProcessEnv,
  linkOrCopyCodexOverlayEntry,
  prepareManagedCodexProfileConfig,
  prepareOptionalCodexOverlayEntries,
} from "./codexProcessEnv";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
  vi.mocked(recordDiagnosticIncident).mockClear();
});

describe("Codex profile filesystem diagnostics", () => {
  it("lets the caller report a failed optional link once", async () => {
    await expect(
      linkOrCopyCodexOverlayEntry(
        {
          entryName: "sessions",
          sourcePath: "/source/sessions",
          targetPath: "/overlay/sessions",
          type: "dir",
        },
        {
          symlink: async () => {
            throw new Error("private link detail");
          },
          copyFile: vi.fn(),
        },
      ),
    ).rejects.toThrow("private link detail");
    expect(recordDiagnosticIncident).not.toHaveBeenCalled();
  });

  it("records and skips one failed optional overlay entry while preparing later entries", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "penkra-codex-overlay-diagnostic-"));
    roots.push(root);
    const sourceHomePath = path.join(root, "source");
    const overlayRoot = path.join(root, "runtime");
    await fs.mkdir(path.join(sourceHomePath, "sessions"), { recursive: true });
    await fs.mkdir(path.join(sourceHomePath, "z-state"));
    await fs.writeFile(path.join(sourceHomePath, "config.toml"), "");
    const overlayHomePath = path.join(overlayRoot, "codex-home-overlay");
    await fs.mkdir(overlayHomePath, { recursive: true });
    await prepareOptionalCodexOverlayEntries({
      sourceHomePath,
      overlayHomePath,
      entries: ["sessions", "z-state"],
      readEntryStat: (sourcePath) => {
        if (sourcePath === path.join(sourceHomePath, "sessions")) {
          return Promise.reject(
            Object.assign(new Error("private filesystem detail"), { code: "EACCES" }),
          );
        }
        return fs.lstat(sourcePath);
      },
    });
    expect(await fs.readlink(path.join(overlayHomePath, "z-state"))).toBe(
      path.join(sourceHomePath, "z-state"),
    );
    expect(recordDiagnosticIncident).toHaveBeenCalledWith(
      expect.objectContaining({ code: "EXTERNAL_CALL_FAILED", where: "server.codex_config" }),
    );
    const env = await buildCodexProcessEnv({
      env: { PENKRA_HOME: overlayRoot },
      homePath: sourceHomePath,
      platform: "win32",
    });
    expect(env.CODEX_HOME).toBe(overlayHomePath);
  });

  it("records a non-ENOENT stat failure and continues the optional profile setup", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "penkra-codex-config-diagnostic-"));
    roots.push(root);
    const sourceHomePath = path.join(root, "source");
    const codexHome = path.join(root, "overlay");
    await fs.mkdir(sourceHomePath);
    await fs.symlink("computer-use", path.join(sourceHomePath, "computer-use"));

    await expect(
      prepareManagedCodexProfileConfig({
        env: { CODEX_HOME: codexHome },
        sourceHomePath,
      }),
    ).resolves.toBeUndefined();
    expect(recordDiagnosticIncident).toHaveBeenCalledTimes(1);
    expect(recordDiagnosticIncident).toHaveBeenCalledWith(
      expect.objectContaining({ code: "EXTERNAL_CALL_FAILED", where: "server.codex_config" }),
    );
  });
});
