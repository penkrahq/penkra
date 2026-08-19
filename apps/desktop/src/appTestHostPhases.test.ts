import { describe, expect, it } from "vitest";

import { withAppTestPhaseTimeout } from "./appTestHostPhases";

describe("App test host phase deadlines", () => {
  it("returns a completed phase result", async () => {
    await expect(
      withAppTestPhaseTimeout({ phase: "runtime-start", timeoutMs: 50, run: () => "ready" }),
    ).resolves.toBe("ready");
  });

  it("reports the exact phase that stalled", async () => {
    const stalled = new Promise<never>(() => undefined);

    await expect(
      withAppTestPhaseTimeout({ phase: "test-shell-load", timeoutMs: 5, run: () => stalled }),
    ).rejects.toThrow('App integration phase "test-shell-load" exceeded 5 ms.');
  });

  it("rejects invalid phase configuration before starting work", async () => {
    let started = false;

    await expect(
      withAppTestPhaseTimeout({
        phase: "",
        timeoutMs: 10,
        run: () => {
          started = true;
        },
      }),
    ).rejects.toThrow("App test phase name is required");
    expect(started).toBe(false);
  });
});
