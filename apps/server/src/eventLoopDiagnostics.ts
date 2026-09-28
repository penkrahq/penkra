// Reports material backend event-loop delays so a slow socket handshake can be
// distinguished from time spent inside an asynchronous queue or provider call.
import { monitorEventLoopDelay } from "node:perf_hooks";

import type { RuntimeMode } from "./config.ts";

const DEFAULT_INTERVAL_MS = 10_000;
const DEFAULT_WARNING_DELAY_MS = 2_000;

interface DelayHistogram {
  readonly max: number;
  enable(): void;
  disable(): void;
  reset(): void;
}

export function startServerEventLoopDiagnostics(input: {
  readonly mode: RuntimeMode;
  readonly intervalMs?: number;
  readonly warningDelayMs?: number;
  readonly histogram?: DelayHistogram;
  readonly logger?: {
    warn(
      message: string,
      payload: { maxDelayMs: number; windowStartedAt: string; windowEndedAt: string },
    ): void;
  };
}): (() => void) | null {
  if (input.mode !== "desktop") return null;

  const histogram = input.histogram ?? monitorEventLoopDelay({ resolution: 20 });
  const intervalMs = input.intervalMs ?? DEFAULT_INTERVAL_MS;
  const warningDelayMs = input.warningDelayMs ?? DEFAULT_WARNING_DELAY_MS;
  const logger = input.logger ?? console;
  let windowStartedAt = new Date().toISOString();
  histogram.enable();
  const timer = setInterval(() => {
    const windowEndedAt = new Date().toISOString();
    const maxDelayMs = Math.round(histogram.max / 1_000_000);
    histogram.reset();
    if (maxDelayMs >= warningDelayMs) {
      logger.warn("[server-event-loop] delayed", { maxDelayMs, windowStartedAt, windowEndedAt });
    }
    windowStartedAt = windowEndedAt;
  }, intervalMs);
  timer.unref();
  return () => {
    clearInterval(timer);
    histogram.disable();
  };
}
