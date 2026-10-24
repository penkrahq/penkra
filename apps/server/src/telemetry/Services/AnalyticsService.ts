/**
 * AnalyticsService - Anonymous telemetry capture contract.
 *
 * Queues best-effort telemetry, sends full batches in the background, and
 * exposes an explicit flush for partial batches.
 *
 * @module AnalyticsService
 */
import { Effect, Layer, Context } from "effect";

export interface AnalyticsServiceShape {
  /**
   * Queue an event without waiting for the network; full batches send in the background.
   */
  readonly record: (
    event: string,
    properties?: Readonly<Record<string, unknown>>,
  ) => Effect.Effect<void, never>;

  /**
   * Flush queued telemetry.
   */
  readonly flush: Effect.Effect<void, never>;
}

export class AnalyticsService extends Context.Service<AnalyticsService, AnalyticsServiceShape>()(
  "penkra/telemetry/Services/AnalyticsService",
) {
  static readonly layerTest = Layer.succeed(AnalyticsService, {
    record: () => Effect.void,
    flush: Effect.void,
  });
}
