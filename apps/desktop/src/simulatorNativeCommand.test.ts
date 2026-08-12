import { describe, expect, it } from "vitest";

import { DefaultSimulatorNativeCommandRunner } from "./simulatorNativeCommand";

describe("DefaultSimulatorNativeCommandRunner", () => {
  it("runs arguments without shell interpolation and captures bytes", async () => {
    const runner = new DefaultSimulatorNativeCommandRunner();

    const result = await runner.run({
      executable: process.execPath,
      args: ["-e", "process.stdout.write(process.argv[1])", "$(not-a-shell)"],
    });

    expect(Buffer.from(result.stdout).toString("utf8")).toBe("$(not-a-shell)");
  });

  it("enforces output and timeout limits", async () => {
    const runner = new DefaultSimulatorNativeCommandRunner();

    await expect(
      runner.run({
        executable: process.execPath,
        args: ["-e", "process.stdout.write('x'.repeat(100))"],
        maxOutputBytes: 10,
      }),
    ).rejects.toMatchObject({ code: "OUTPUT_LIMIT_EXCEEDED" });
    await expect(
      runner.run({
        executable: process.execPath,
        args: ["-e", "setTimeout(() => {}, 1000)"],
        timeoutMs: 20,
      }),
    ).rejects.toMatchObject({ code: "COMMAND_TIMEOUT" });
  });

  it("honors cancellation before launch", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      new DefaultSimulatorNativeCommandRunner().run({
        executable: process.execPath,
        args: ["-e", "process.exit(0)"],
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "COMMAND_ABORTED" });
  });
});
