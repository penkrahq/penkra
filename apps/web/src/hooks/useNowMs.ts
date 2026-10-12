// FILE: useNowMs.ts
// Purpose: Shared lightweight wall-clock tick for live elapsed labels.
// Layer: Web hook
// Exports: useNowMs

import { useLayoutEffect, useState } from "react";

// Elapsed labels show whole seconds, so the default clock ticks once per second (decision 6b).
const DEFAULT_CLOCK_TICK_MS = 1_000;

export function useNowMs(enabled: boolean, intervalMs = DEFAULT_CLOCK_TICK_MS): number {
  const [nowMs, setNowMs] = useState(() => Date.now());

  useLayoutEffect(() => {
    if (!enabled) {
      return;
    }
    setNowMs(Date.now());
    const intervalId = window.setInterval(() => {
      setNowMs(Date.now());
    }, intervalMs);
    return () => {
      window.clearInterval(intervalId);
    };
  }, [enabled, intervalMs]);

  return nowMs;
}
