import { describe, expect, it, vi } from "vitest";

import { startServerEventLoopDiagnostics } from "./eventLoopDiagnostics.ts";

describe("server event-loop diagnostics", () => {
  it("reports a delayed loop once, then resets the interval and stops cleanly", () => {
    vi.useFakeTimers();
    const histogram = {
      max: 3_200_000_000,
      enable: vi.fn(),
      disable: vi.fn(),
      reset: vi.fn(() => {
        histogram.max = 0;
      }),
    };
    const warn = vi.fn();
    try {
      const stop = startServerEventLoopDiagnostics({
        mode: "desktop",
        intervalMs: 1_000,
        histogram,
        logger: { warn },
      });
      expect(stop).not.toBeNull();
      vi.advanceTimersByTime(2_000);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        "[server-event-loop] delayed",
        expect.objectContaining({
          maxDelayMs: 3_200,
          windowStartedAt: expect.any(String),
          windowEndedAt: expect.any(String),
        }),
      );
      expect(histogram.reset).toHaveBeenCalledTimes(2);
      stop?.();
      vi.advanceTimersByTime(1_000);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(histogram.disable).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
