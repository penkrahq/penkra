import { describe, expect, it } from "vitest";

import { DefaultSimulatorRuntimeInstaller } from "./simulatorRuntimeInstaller";

describe("DefaultSimulatorRuntimeInstaller", () => {
  it("runs an official installer without a shell", async () => {
    await expect(
      new DefaultSimulatorRuntimeInstaller().install({
        executable: process.execPath,
        args: ["-e", "process.exit(0)"],
        signal: new AbortController().signal,
      }),
    ).resolves.toBeUndefined();
  });

  it("returns bounded installer failure output", async () => {
    await expect(
      new DefaultSimulatorRuntimeInstaller().install({
        executable: process.execPath,
        args: ["-e", "process.stderr.write('download failed'); process.exit(7)"],
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({
      code: "RUNTIME_INSTALL_FAILED",
      exitCode: 7,
      stderr: "download failed",
    });
  });

  it("cancels and cleans up a long-running installer", async () => {
    const controller = new AbortController();
    const installing = new DefaultSimulatorRuntimeInstaller().install({
      executable: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      signal: controller.signal,
    });
    controller.abort();
    await expect(installing).rejects.toMatchObject({ code: "SETUP_CANCELLED" });
  });
});
