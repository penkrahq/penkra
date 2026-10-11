import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildCodexProcessEnv,
  linkOrCopyCodexOverlayEntry,
  prepareManagedCodexProfileConfig,
  prepareOptionalCodexOverlayEntries,
} from "./codexProcessEnv";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe("Codex profile filesystem failures", () => {
  it("lets the caller handle a failed optional link", async () => {
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
  });

  it("skips a failed optional overlay entry while preparing later entries", async () => {
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
    const env = await buildCodexProcessEnv({
      env: { PENKRA_HOME: overlayRoot },
      homePath: sourceHomePath,
      platform: "win32",
    });
    expect(env.CODEX_HOME).toBe(overlayHomePath);
  });

  it("continues optional profile setup after a non-ENOENT stat failure", async () => {
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
  });
});
