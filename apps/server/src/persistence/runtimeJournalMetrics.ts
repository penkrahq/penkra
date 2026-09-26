/** Process-local journal timings. A drain emits and resets the buckets periodically. */
export type RuntimeJournalTiming =
  | "sqliteSemaphoreWait"
  | "sqliteTransactionHold"
  | "journalPageRead"
  | "journalEventProcessing"
  | "journalRetentionScan";

const boundsMs = [1, 5, 25, 100, 500, 1_000, 5_000, 30_000];
const timings = new Map<
  RuntimeJournalTiming,
  { count: number; sumMs: number; maxMs: number; buckets: number[] }
>();

export const observeRuntimeJournalTiming = (name: RuntimeJournalTiming, durationMs: number) => {
  if (!Number.isFinite(durationMs) || durationMs < 0) return;
  let timing = timings.get(name);
  if (!timing) {
    timing = {
      count: 0,
      sumMs: 0,
      maxMs: 0,
      buckets: Array(boundsMs.length + 1).fill(0) as number[],
    };
    timings.set(name, timing);
  }
  timing.count++;
  timing.sumMs += durationMs;
  timing.maxMs = Math.max(timing.maxMs, durationMs);
  const bucket = boundsMs.findIndex((bound) => durationMs <= bound);
  timing.buckets[bucket < 0 ? boundsMs.length : bucket]!++;
};

export const takeRuntimeJournalTimings = () => {
  const snapshot = Object.fromEntries(timings);
  timings.clear();
  return { bucketUpperBoundsMs: boundsMs, timings: snapshot };
};
