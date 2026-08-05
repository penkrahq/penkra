import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { replaceAppAtomically, schedulePenkraRelaunch } from "./penkra-install-local.mjs";

const roots: string[] = [];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "penkra-install-test-"));
  roots.push(root);
  const source = join(root, "source.app");
  const target = join(root, "Penkra.app");
  const staging = join(root, ".Penkra.app.install-test");
  mkdirSync(source);
  writeFileSync(join(source, "version"), "new");
  return { root, source, target, staging };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("replaceAppAtomically", () => {
  it("verifies a complete staged app before replacing the current app", () => {
    const { source, target, staging } = fixture();
    cpSync(source, target, { recursive: true });
    writeFileSync(join(target, "version"), "old");
    const observed: string[] = [];

    const result = replaceAppAtomically({
      source,
      target,
      staging,
      backupLabel: "0.9.0",
      timestamp: "2026-08-05T05:00:00.000Z",
      verify: (path) => observed.push(path),
    });

    expect(observed).toEqual([staging, target]);
    expect(readFileSync(join(target, "version"), "utf8")).toBe("new");
    expect(result.backup).not.toBeNull();
    expect(readFileSync(join(result.backup!, "version"), "utf8")).toBe("old");
  });

  it("leaves the current app untouched when staging fails", () => {
    const { source, target, staging } = fixture();
    cpSync(source, target, { recursive: true });
    writeFileSync(join(target, "version"), "old");

    expect(() =>
      replaceAppAtomically({
        source,
        target,
        staging,
        backupLabel: "0.9.0",
        copy: () => {
          throw new Error("copy interrupted");
        },
        verify: vi.fn(),
      }),
    ).toThrow("copy interrupted");
    expect(readFileSync(join(target, "version"), "utf8")).toBe("old");
    expect(existsSync(staging)).toBe(false);
  });

  it("restores the previous app when final verification fails", () => {
    const { source, target, staging } = fixture();
    cpSync(source, target, { recursive: true });
    writeFileSync(join(target, "version"), "old");

    expect(() =>
      replaceAppAtomically({
        source,
        target,
        staging,
        backupLabel: "0.9.0",
        verify: (path) => {
          if (path === target) throw new Error("final signature invalid");
        },
      }),
    ).toThrow("final signature invalid");
    expect(readFileSync(join(target, "version"), "utf8")).toBe("old");
  });
});

describe("schedulePenkraRelaunch", () => {
  it("uses a detached helper after the installer has returned", () => {
    const unref = vi.fn();
    const spawnProcess = vi.fn(() => ({ unref }));

    schedulePenkraRelaunch("/Applications/Penkra.app", spawnProcess as never);

    expect(spawnProcess).toHaveBeenCalledWith(
      "/bin/sh",
      expect.arrayContaining(["-c", "penkra-relaunch", "/Applications/Penkra.app"]),
      { detached: true, stdio: "ignore" },
    );
    expect(spawnProcess.mock.calls[0]?.[1]?.[1]).toContain("sleep 3");
    expect(spawnProcess.mock.calls[0]?.[1]?.[1]).toContain("open -n");
    expect(unref).toHaveBeenCalledOnce();
  });
});
