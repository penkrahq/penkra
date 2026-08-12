import { ProviderConnectionId } from "@penkra/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";

import { ProviderConnectionOperationRepositoryLive } from "../../persistence/Layers/ProviderConnectionOperations.ts";
import { ProviderConnectionRepositoryLive } from "../../persistence/Layers/ProviderConnections.ts";
import { runMigrations } from "../../persistence/Migrations.ts";
import * as NodeSqliteClient from "../../persistence/NodeSqliteClient.ts";
import { ProviderConnectionOperationRepository } from "../../persistence/Services/ProviderConnectionOperations.ts";
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
  lease: () => Effect.die("not used"),
  consume: () => Effect.die("not used"),
  readOnce: () => Effect.die("not used"),
  has: (reference) => Effect.sync(() => secrets.has(reference)),
  remove: (reference) => Effect.sync(() => void secrets.delete(reference)),
};

let idCounter = 0;
let validationFailure: Error | null = null;
const sqlLayer = NodeSqliteClient.layerMemory();
const repositories = Layer.mergeAll(
  ProviderConnectionRepositoryLive.pipe(Layer.provide(sqlLayer)),
  ProviderConnectionOperationRepositoryLive.pipe(Layer.provide(sqlLayer)),
);
const dependencies = Layer.mergeAll(repositories, Layer.succeed(ProviderCredentialBroker, broker));
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
    }),
  );

  it.effect("recovers a vault write whose acknowledgement was lost", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const operations = yield* ProviderConnectionOperationRepository;
      const connections = yield* ProviderConnectionRepository;
      const lifecycle = yield* ProviderConnectionLifecycle;
      const connectionId = ProviderConnectionId.makeUnsafe("recovered-connection");
      const credentialRef = `provider-secret:${connectionId}`;
      secrets.set(credentialRef, "recovered-secret");
      yield* operations.begin({
        id: "recovered-operation",
        connectionId,
        kind: "create-static",
        state: "pending",
        credentialRef,
        payloadJson: JSON.stringify({
          harness: "claudeAgent",
          authenticationTargetId: "claude-subscription",
          authenticationMethodId: "token",
          label: "Recovered",
          providerIdentityId: null,
          createdAt: "2026-08-08T00:00:00.000Z",
        }),
        failureReason: null,
        createdAt: "2026-08-08T00:00:00.000Z",
        updatedAt: "2026-08-08T00:00:00.000Z",
      });

      yield* lifecycle.recover;
      const recovered = Option.getOrThrow(yield* connections.getRecord(connectionId));
      assert.strictEqual(recovered.label, "Recovered");
      assert.deepStrictEqual(yield* operations.listOpen(), []);
    }),
  );

  it.effect("allows independent credentials with the same derived display suffix", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const lifecycle = yield* ProviderConnectionLifecycle;
      const operations = yield* ProviderConnectionOperationRepository;
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
      assert.deepStrictEqual(yield* operations.listOpen(), []);
    }),
  );
});
