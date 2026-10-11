import { ProviderConnectionId } from "@penkra/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import {
  ConnectionRateLimits,
  ConnectionRateLimitsLive,
  makeConnectionRateLimits,
} from "./ConnectionRateLimits.ts";

const layer = it.layer(ConnectionRateLimitsLive);

layer("ConnectionRateLimits", (it) => {
  it.effect("stores quota buckets independently across login updates", () =>
    Effect.gen(function* () {
      const repository = yield* ConnectionRateLimits;
      const connectionId = ProviderConnectionId.makeUnsafe("bucket-account");
      for (const [limitId, usedPercent] of [
        ["codex", 66],
        ["codex_bengalfox", 0],
      ] as const) {
        yield* repository.update({
          connectionId,
          provider: "codex",
          status: null,
          sourceEventId: limitId,
          updatedAt: "2026-09-05T19:00:00.000Z",
          limitsJson: JSON.stringify({
            rateLimits: { limitId, primary: { usedPercent, windowDurationMins: 10080 } },
          }),
        });
      }
      const stored = Option.getOrThrow(yield* repository.get(connectionId));
      const buckets = JSON.parse(stored.limitsJson).quotaBuckets;
      assert.strictEqual(buckets.codex.bucket.primary.usedPercent, 66);
      assert.strictEqual(buckets.codex_bengalfox.bucket.primary.usedPercent, 0);
      assert.strictEqual(buckets.codex.observedAt, "2026-09-05T19:00:00.000Z");
    }),
  );
  it.effect("upserts a provider-owned rate-limit fact", () =>
    Effect.gen(function* () {
      const repository = yield* ConnectionRateLimits;
      yield* repository.update({
        connectionId: ProviderConnectionId.makeUnsafe("codex-login"),
        provider: "codex",
        limitsJson: '{"rateLimits":{"primary":{"usedPercent":12}}}',
        status: null,
        sourceEventId: "provider-login:operation-1",
        updatedAt: "2026-08-21T12:00:00.000Z",
      });

      const fact = yield* repository.get(ProviderConnectionId.makeUnsafe("codex-login"));
      assert.strictEqual(Option.getOrNull(fact)?.sourceEventId, "provider-login:operation-1");
    }),
  );

  it.effect("reads the latest observed rate limits for one Connection", () =>
    Effect.gen(function* () {
      const repository = yield* ConnectionRateLimits;
      yield* repository.update({
        connectionId: ProviderConnectionId.makeUnsafe("codex-account"),
        provider: "codex",
        limitsJson: '{"primary":{"usedPercent":38}}',
        status: null,
        sourceEventId: "event-1",
        updatedAt: "2026-08-21T12:00:00.000Z",
      });

      const fact = yield* repository.get(ProviderConnectionId.makeUnsafe("codex-account"));
      assert.deepStrictEqual(Option.getOrNull(fact), {
        connectionId: ProviderConnectionId.makeUnsafe("codex-account"),
        provider: "codex",
        limitsJson: '{"primary":{"usedPercent":38}}',
        status: null,
        sourceEventId: "event-1",
        updatedAt: "2026-08-21T12:00:00.000Z",
      });
    }),
  );
  it.effect("does not load rate limits from the previous process", () =>
    Effect.gen(function* () {
      const previous = yield* makeConnectionRateLimits;
      const connectionId = ProviderConnectionId.makeUnsafe("restart-account");
      yield* previous.update({
        connectionId,
        provider: "codex",
        limitsJson: '{"primary":{"usedPercent":38}}',
        status: null,
        sourceEventId: "restart-event",
        updatedAt: "2026-08-21T12:00:00.000Z",
      });
      assert.strictEqual(Option.isSome(yield* previous.get(connectionId)), true);
      const restarted = yield* makeConnectionRateLimits;
      assert.strictEqual(Option.isNone(yield* restarted.get(connectionId)), true);
    }),
  );
});
