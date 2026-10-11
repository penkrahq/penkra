import { assert, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Option } from "effect";

import { ProviderConnectionRepositoryLive } from "../../persistence/Layers/ProviderConnections.ts";
import { runMigrations } from "../../persistence/Migrations.ts";
import * as NodeSqliteClient from "../../persistence/NodeSqliteClient.ts";
import { ProviderConnectionRepository } from "../../persistence/Services/ProviderConnections.ts";
import {
  ProviderCredentialBroker,
  ProviderCredentialBrokerError,
  type ProviderCredentialBrokerShape,
} from "../providerCredentialBroker.ts";
import { ProviderConnectionLifecycle } from "../Services/ProviderConnectionLifecycle.ts";
import { makeProviderConnectionLifecycle } from "./ProviderConnectionLifecycle.ts";

const secrets = new Map<string, string>();
const broker: ProviderCredentialBrokerShape = {
  available: true,
  store: (secret, requestedReference) =>
    secret === "duplicate-secret"
      ? Effect.fail(
          new ProviderCredentialBrokerError({
            message: "This provider credential is already configured.",
          }),
        )
      : Effect.sync(() => {
          const reference = requestedReference ?? `provider-secret:${secrets.size + 1}`;
          const existing = secrets.get(reference);
          if (existing !== undefined && existing !== secret) throw new Error("reference collision");
          secrets.set(reference, secret);
          return reference;
        }),
  claim: (_secret, reference) => Effect.succeed(reference),
  fingerprint: (secret) =>
    Effect.succeed(Buffer.from(secret).toString("hex").padEnd(64, "0").slice(0, 64)),
  lease: () => Effect.die("not used"),
  consume: () => Effect.die("not used"),
  readOnce: () => Effect.die("not used"),
  has: (reference) => Effect.sync(() => secrets.has(reference)),
  remove: (reference) => Effect.sync(() => void secrets.delete(reference)),
};

let idCounter = 0;
let validationFailure: Error | null = null;
const sqlLayer = NodeSqliteClient.layerMemory();
const connectionRepositoryLayer = ProviderConnectionRepositoryLive.pipe(Layer.provide(sqlLayer));
const dependencies = Layer.mergeAll(
  connectionRepositoryLayer,
  Layer.succeed(ProviderCredentialBroker, broker),
);
const lifecycleLayer = Layer.effect(
  ProviderConnectionLifecycle,
  makeProviderConnectionLifecycle({
    newId: () => `lifecycle-id-${++idCounter}`,
    now: () => "2026-08-08T00:00:00.000Z",
    validateSecret: async () => {
      if (validationFailure) throw validationFailure;
    },
  }),
).pipe(Layer.provide(dependencies));
const layer = it.layer(Layer.mergeAll(sqlLayer, dependencies, lifecycleLayer));

layer("ProviderConnectionLifecycle", (it) => {
  it.effect("rejects an invalid credential before storing any secret or Connection", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const lifecycle = yield* ProviderConnectionLifecycle;
      const repository = yield* ProviderConnectionRepository;
      const secretCount = secrets.size;
      const connectionCount = (yield* repository.list()).length;
      validationFailure = new Error("OpenCode Go rejected this credential (401).");
      const result = yield* Effect.exit(
        lifecycle.createStatic({
          harness: "opencode",
          authenticationTargetId: "opencode-go",
          authenticationMethodId: "api-key",
          secret: "invalid",
        }),
      );
      validationFailure = null;

      assert.strictEqual(result._tag, "Failure");
      assert.strictEqual(secrets.size, secretCount);
      assert.strictEqual((yield* repository.list()).length, connectionCount);
    }),
  );

  it.effect("preserves the exact duplicate-credential error from secure storage", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const lifecycle = yield* ProviderConnectionLifecycle;
      const repository = yield* ProviderConnectionRepository;
      const connectionCount = (yield* repository.list()).length;

      const result = yield* Effect.exit(
        lifecycle.createStatic({
          harness: "opencode",
          authenticationTargetId: "opencode-go",
          authenticationMethodId: "api-key",
          secret: "duplicate-secret",
        }),
      );

      assert.strictEqual(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.match(String(result.cause), /already configured/);
      }
      assert.strictEqual((yield* repository.list()).length, connectionCount);
    }),
  );

  it.effect("creates and terminally disconnects a static credential Connection", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const lifecycle = yield* ProviderConnectionLifecycle;
      const repository = yield* ProviderConnectionRepository;
      const created = yield* lifecycle.createStatic({
        harness: "opencode",
        authenticationTargetId: "opencode-go",
        authenticationMethodId: "api-key",
        secret: "test-secret",
      });
      const record = Option.getOrThrow(yield* repository.getRecord(created.id));
      const credentialRef = record.credentialRef;
      if (credentialRef === null) throw new Error("Expected a stored credential reference.");
      assert.strictEqual(credentialRef, `provider-secret:${created.id}`);
      assert.strictEqual(secrets.get(credentialRef), "test-secret");
      assert.strictEqual(created.label, "OpenCode Go / ••••cret");

      const terminated = yield* lifecycle.terminate({
        connectionId: created.id,
        reason: "disconnected",
      });
      assert.strictEqual(terminated.lifecycle, "terminated");
      assert.strictEqual(secrets.has(credentialRef), false);

      const reauthenticated = yield* lifecycle.createStatic({
        harness: "opencode",
        authenticationTargetId: "opencode-go",
        authenticationMethodId: "api-key",
        secret: "test-secret",
      });
      assert.strictEqual(reauthenticated.id, created.id);
      assert.strictEqual(reauthenticated.lifecycle, "active");
      assert.strictEqual((yield* repository.list()).length, 1);
    }),
  );

  it.effect("allows independent credentials with the same derived display suffix", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const lifecycle = yield* ProviderConnectionLifecycle;
      const first = yield* lifecycle.createStatic({
        harness: "opencode",
        authenticationTargetId: "opencode-go",
        authenticationMethodId: "api-key",
        secret: "anchor-A7F2",
      });
      const before = secrets.size;
      const second = yield* lifecycle.createStatic({
        harness: "opencode",
        authenticationTargetId: "opencode-go",
        authenticationMethodId: "api-key",
        secret: "another-A7F2",
      });

      assert.strictEqual(first.label, "OpenCode Go / ••••A7F2");
      assert.strictEqual(second.label, first.label);
      assert.notStrictEqual(second.id, first.id);
      assert.strictEqual(secrets.size, before + 1);
    }),
  );
  it.effect("blocks overlapping Connection work and releases it on interruption", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const base = yield* ProviderConnectionLifecycle;
      const request = {
        harness: "opencode" as const,
        authenticationTargetId: "opencode-go",
        authenticationMethodId: "api-key",
        secret: "interrupt-progress-A7F2",
      };
      const connection = yield* base.createStatic(request);
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let stores = 0;
      const controlled = yield* makeProviderConnectionLifecycle({
        validateSecret: async () => {},
      }).pipe(
        Effect.provideService(ProviderCredentialBroker, {
          ...broker,
          store: (secret, reference) =>
            Effect.gen(function* () {
              stores += 1;
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
              return yield* broker.store(secret, reference);
            }),
        }),
      );
      const pending = yield* controlled.createStatic(request).pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      const overlap = yield* controlled.createStatic(request).pipe(Effect.flip);
      assert.strictEqual(overlap.detail, "Could not begin Connection creation.");
      assert.strictEqual(stores, 1);
      yield* Fiber.interrupt(pending);
      yield* Deferred.succeed(release, undefined);
      const result = yield* controlled.createStatic(request);
      assert.strictEqual(result.id, connection.id);
      assert.strictEqual(stores, 2);
    }),
  );

  it.effect("releases failed in-flight work and preserves a lost credential acknowledgement", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const base = yield* ProviderConnectionLifecycle;
      const request = {
        harness: "opencode" as const,
        authenticationTargetId: "opencode-go",
        authenticationMethodId: "api-key",
        secret: "failed-progress-B7F2",
      };
      const connection = yield* base.createStatic(request);
      let failing = true;
      const controlled = yield* makeProviderConnectionLifecycle({
        validateSecret: async () => {},
      }).pipe(
        Effect.provideService(ProviderCredentialBroker, {
          ...broker,
          store: (secret, reference) =>
            Effect.gen(function* () {
              if (!failing) yield* broker.store(secret, reference);
              return yield* Effect.fail(
                new ProviderCredentialBrokerError({ message: "acknowledgement lost" }),
              );
            }),
          has: (reference) =>
            failing
              ? Effect.fail(new ProviderCredentialBrokerError({ message: "desktop disconnected" }))
              : broker.has(reference),
        }),
      );
      const error = yield* controlled.createStatic(request).pipe(Effect.flip);
      assert.strictEqual(error.detail, "Could not determine whether credential storage committed.");
      failing = false;
      const result = yield* controlled.createStatic(request);
      assert.strictEqual(result.id, connection.id);
    }),
  );

  it.effect("a new server lifetime does not replay or retain an interrupted setup", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const base = yield* ProviderConnectionLifecycle;
      const request = {
        harness: "opencode" as const,
        authenticationTargetId: "opencode-go",
        authenticationMethodId: "api-key",
        secret: "restart-progress-C7F2",
      };
      const connection = yield* base.createStatic(request);
      const entered = yield* Deferred.make<void>();
      const oldLifetime = yield* makeProviderConnectionLifecycle({
        validateSecret: async () => {},
      }).pipe(
        Effect.provideService(ProviderCredentialBroker, {
          ...broker,
          store: () =>
            Effect.gen(function* () {
              yield* Deferred.succeed(entered, undefined);
              return yield* Effect.never;
            }),
        }),
      );
      const pending = yield* oldLifetime.createStatic(request).pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      const newLifetime = yield* makeProviderConnectionLifecycle({
        validateSecret: async () => {},
      });
      const result = yield* newLifetime.createStatic(request);
      assert.strictEqual(result.id, connection.id);
      yield* Fiber.interrupt(pending);
    }),
  );
});
