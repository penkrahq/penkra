import { describe, expect, it } from "vitest";
import { runAppProcess } from "./appProcessRunner";

describe("App process boundary", () => {
  it("passes literal arguments without shell interpolation and strips ambient credentials", async () => {
    const result = await runAppProcess({
      executablePath: process.execPath,
      args: [
        "-e",
        "process.stdout.write(JSON.stringify({arg:process.argv[1],secret:process.env.SECRET_TOKEN??null}))",
        "$(touch /tmp/never-run)",
      ],
      timeoutMs: 5_000,
    });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(new TextDecoder().decode(result.stdout))).toEqual({
      arg: "$(touch /tmp/never-run)",
      secret: null,
    });
  });

  it("supports cancellation and bounds arguments", async () => {
    const controller = new AbortController();
    const running = runAppProcess({
      executablePath: process.execPath,
      args: ["-e", "setTimeout(()=>{},10000)"],
      signal: controller.signal,
    });
    controller.abort();
    await expect(running).rejects.toThrow("cancelled");
    await expect(
      runAppProcess({ executablePath: process.execPath, args: ["x".repeat(9_000)] }),
    ).rejects.toThrow("arguments");
  });
});
