/**
 * AnalyticsServiceLive - Anonymous PostHog telemetry layer.
 *
 * Persists a random installation-scoped anonymous id to state dir, buffers
 * events in memory, and flushes batches to PostHog over Effect HttpClient.
 *
 * @module AnalyticsServiceLive
 */

import { Config, DateTime, Duration, Effect, Layer, Queue, Ref, Semaphore } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import { ServerConfig } from "../../config.ts";
import { AnalyticsService, type AnalyticsServiceShape } from "../Services/AnalyticsService.ts";
import { getTelemetryIdentifier } from "../Identify.ts";
import { version } from "../../../package.json" with { type: "json" };

interface BufferedAnalyticsEvent {
  readonly event: string;
  readonly properties?: Readonly<Record<string, unknown>>;
  readonly capturedAt: string;
}

const TelemetryEnvConfig = Config.all({
  posthogKey: Config.string("PENKRA_POSTHOG_KEY").pipe(Config.withDefault("")),
  posthogHost: Config.string("PENKRA_POSTHOG_HOST").pipe(Config.withDefault("")),
  enabled: Config.boolean("PENKRA_TELEMETRY_ENABLED").pipe(Config.withDefault(false)),
  flushBatchSize: Config.number("PENKRA_TELEMETRY_FLUSH_BATCH_SIZE").pipe(Config.withDefault(20)),
  maxBufferedEvents: Config.number("PENKRA_TELEMETRY_MAX_BUFFERED_EVENTS").pipe(
    Config.withDefault(1_000),
  ),
});

// PostHog's standard flush interval sends partial batches without a one-second polling loop.
export const ANALYTICS_FLUSH_INTERVAL = Duration.seconds(10);

const makeAnalyticsService = Effect.gen(function* () {
  const telemetryConfig = yield* TelemetryEnvConfig.asEffect();
  const httpClient = yield* HttpClient.HttpClient;
  const serverConfig = yield* ServerConfig;
  const identifier = yield* getTelemetryIdentifier;
  const bufferRef = yield* Ref.make<ReadonlyArray<BufferedAnalyticsEvent>>([]);
  // One pending signal is enough: its worker drains every full batch in the buffer.
  const flushRequests = yield* Effect.acquireRelease(Queue.dropping<void>(1), Queue.shutdown);
  const flushLock = yield* Semaphore.make(1);
  const clientType = serverConfig.mode === "desktop" ? "desktop-app" : "cli-web-client";
  const telemetryEnabled =
    telemetryConfig.enabled &&
    telemetryConfig.posthogKey.length > 0 &&
    telemetryConfig.posthogHost.length > 0;

  const enqueueBufferedEvent = (event: string, properties?: Readonly<Record<string, unknown>>) =>
    Effect.flatMap(DateTime.now, (now) =>
      Ref.modify(bufferRef, (current) => {
        const appended = [
          ...current,
          {
            event,
            ...(properties ? { properties } : {}),
            capturedAt: DateTime.formatIso(now),
          } satisfies BufferedAnalyticsEvent,
        ];

        const next =
          appended.length > telemetryConfig.maxBufferedEvents
            ? appended.slice(appended.length - telemetryConfig.maxBufferedEvents)
            : appended;

        return [
          {
            size: next.length,
            dropped: next.length !== appended.length,
          } as const,
          next,
        ] as const;
      }),
    );

  const sendBatch = (events: ReadonlyArray<BufferedAnalyticsEvent>) =>
    Effect.gen(function* () {
      if (!telemetryEnabled || !identifier) return;

      const payload = {
        api_key: telemetryConfig.posthogKey,
        batch: events.map((event) => ({
          event: event.event,
          distinct_id: identifier,
          properties: {
            ...event.properties,
            $process_person_profile: false,
            platform: process.platform,
            wsl: process.env.WSL_DISTRO_NAME,
            arch: process.arch,
            penkraCodeVersion: version,
            clientType,
          },
          timestamp: event.capturedAt,
        })),
      };

      yield* HttpClientRequest.post(`${telemetryConfig.posthogHost}/batch/`).pipe(
        HttpClientRequest.bodyJson(payload),
        Effect.flatMap(httpClient.execute),
        Effect.flatMap(HttpClientResponse.filterStatusOk),
      );
    });

  const drainBuffer = (mode: "full" | "all") =>
    flushLock.withPermits(1)(
      Effect.gen(function* () {
        while (true) {
          const batch = yield* Ref.modify(bufferRef, (current) => {
            if (
              current.length === 0 ||
              (mode === "full" && current.length < telemetryConfig.flushBatchSize)
            ) {
              return [[] as ReadonlyArray<BufferedAnalyticsEvent>, current] as const;
            }
            const nextBatch = current.slice(0, telemetryConfig.flushBatchSize);
            const remaining = current.slice(nextBatch.length);
            return [nextBatch, remaining] as const;
          });

          if (batch.length === 0) {
            return;
          }

          yield* sendBatch(batch).pipe(
            Effect.catch((error) =>
              Ref.update(bufferRef, (current) => [...batch, ...current]).pipe(
                Effect.flatMap(() => Effect.fail(error)),
              ),
            ),
          );
        }
      }).pipe(Effect.catch((cause) => Effect.logError("Failed to flush telemetry", { cause }))),
    );
  const flush: AnalyticsServiceShape["flush"] = drainBuffer("all");

  const record: AnalyticsServiceShape["record"] = Effect.fnUntraced(function* (event, properties) {
    if (!telemetryEnabled || !identifier) return;

    const enqueueResult = yield* enqueueBufferedEvent(event, properties);
    if (enqueueResult.size >= telemetryConfig.flushBatchSize)
      yield* Queue.offer(flushRequests, undefined);
    if (enqueueResult.dropped) {
      yield* Effect.logDebug("analytics buffer full; dropping oldest event", {
        size: enqueueResult.size,
        event,
      });
    }
  });

  yield* Effect.forever(Queue.take(flushRequests).pipe(Effect.andThen(drainBuffer("full")))).pipe(
    Effect.forkScoped,
  );
  yield* Effect.sleep(ANALYTICS_FLUSH_INTERVAL).pipe(
    Effect.andThen(flush),
    Effect.forever,
    Effect.forkScoped,
  );

  yield* Effect.addFinalizer(() => flush);

  return {
    record,
    flush,
  } satisfies AnalyticsServiceShape;
});

export const AnalyticsServiceLayerLive = Layer.effect(AnalyticsService, makeAnalyticsService);
