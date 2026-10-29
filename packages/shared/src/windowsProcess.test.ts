// FILE: windowsProcess.test.ts
// Purpose: Verifies Windows process preparation avoids Node shell-mode deprecations.
// Layer: Shared Node runtime utility tests

import { spawnSync as spawnChildSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as Path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildWindowsBatchCommandArgs,
  isWindowsBatchCommand,
  prepareWindowsSafeProcess,
  resolveWindowsCommandPath,
  resolveWindowsComSpec,
} from "./windowsProcess";

describe("windowsProcess", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("skips current-directory command hits from where.exe", () => {
    const spawnSync = vi.fn(() => ({
      stdout: [
        "C:\\folders\\penkra\\codex.cmd",
        "C:\\Users\\test\\AppData\\Roaming\\npm\\codex.cmd",
      ].join("\r\n"),
      status: 0,
    }));

    expect(
      resolveWindowsCommandPath("codex", {
        platform: "win32",
        cwd: "C:\\folders\\penkra",
        env: { SystemRoot: "C:\\Windows" },
        spawnSync,
      }),
    ).toBe("C:\\Users\\test\\AppData\\Roaming\\npm\\codex.cmd");
  });

  it("rejects batch tokens with cmd.exe control characters", () => {
    expect(() => buildWindowsBatchCommandArgs("C:\\tools\\bad%path\\codex.cmd", [])).toThrow(
      /Cannot safely execute Windows batch command/,
    );
    expect(() => buildWindowsBatchCommandArgs("C:\\tools\\codex.cmd", ["one&two"])).toThrow(
      /Cannot safely execute Windows batch argument/,
    );
  });
});
