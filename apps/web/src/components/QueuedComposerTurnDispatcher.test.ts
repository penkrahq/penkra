import { describe, expect, it } from "vitest";

import { queuedComposerTurnRetryDelayMs } from "./QueuedComposerTurnDispatcher";

describe("queuedComposerTurnRetryDelayMs", () => {
  it("backs off failed background sends and caps their retry rate", () => {
    expect(queuedComposerTurnRetryDelayMs(0)).toBe(2_000);
    expect(queuedComposerTurnRetryDelayMs(1)).toBe(4_000);
    expect(queuedComposerTurnRetryDelayMs(2)).toBe(8_000);
    expect(queuedComposerTurnRetryDelayMs(20)).toBe(30_000);
  });

  it("normalizes invalid attempt counts", () => {
    expect(queuedComposerTurnRetryDelayMs(-1)).toBe(2_000);
    expect(queuedComposerTurnRetryDelayMs(1.9)).toBe(4_000);
  });
});
