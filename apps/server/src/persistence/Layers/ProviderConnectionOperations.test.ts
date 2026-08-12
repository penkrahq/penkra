import { ProviderConnectionId } from "@penkra/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import { ProviderConnectionOperationRepository } from "../Services/ProviderConnectionOperations.ts";
import { ProviderConnectionOperationRepositoryLive } from "./ProviderConnectionOperations.ts";

const sqlLayer = NodeSqliteClient.layerMemory();
const layer = it.layer(
  Layer.mergeAll(sqlLayer, ProviderConnectionOperationRepositoryLive.pipe(Layer.provide(sqlLayer))),
);

layer("ProviderConnectionOperationRepository", (it) => {
  it.effect("journals exact forward-only lifecycle transitions", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const repository = yield* ProviderConnectionOperationRepository;
      const now = "2026-08-08T00:00:00.000Z";
      yield* repository.begin({
        id: "operation-1",
        connectionId: ProviderConnectionId.makeUnsafe("connection-1"),
        kind: "create-static",
        state: "pending",
        credentialRef: "provider-secret:connection-1",
        payloadJson: '{"label":"Personal"}',
        failureReason: null,
        createdAt: now,
        updatedAt: now,
      });
      yield* repository.transition({
        id: "operation-1",
        state: "credential-stored",
        credentialRef: "provider-secret:connection-1",
        failureReason: null,
        updatedAt: "2026-08-08T00:00:01.000Z",
      });
      yield* repository.transition({
        id: "operation-1",
        state: "completed",
        credentialRef: "provider-secret:connection-1",
        failureReason: null,
        updatedAt: "2026-08-08T00:00:02.000Z",
      });

      assert.deepStrictEqual(yield* repository.listOpen(), []);
      const record = yield* repository.get("operation-1");
      assert.strictEqual(Option.getOrThrow(record).state, "completed");
    }),
  );

  it.effect("rejects skipping an operation phase", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const repository = yield* ProviderConnectionOperationRepository;
      const now = "2026-08-08T01:00:00.000Z";
      yield* repository.begin({
        id: "operation-2",
        connectionId: ProviderConnectionId.makeUnsafe("connection-2"),
        kind: "terminate",
        state: "pending",
        credentialRef: "provider-secret:connection-2",
        payloadJson: '{"reason":"disconnected"}',
        failureReason: null,
        createdAt: now,
        updatedAt: now,
      });

      const error = yield* repository
        .transition({
          id: "operation-2",
          state: "completed",
          credentialRef: "provider-secret:connection-2",
          failureReason: null,
          updatedAt: "2026-08-08T01:00:01.000Z",
        })
        .pipe(Effect.flip);
      assert.match(String(error), /invalid provider connection operation transition/i);
    }),
  );
});
