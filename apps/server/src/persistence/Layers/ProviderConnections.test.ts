import { ProviderConnectionId, SpaceId } from "@penkra/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import { ProviderConnectionRepository } from "../Services/ProviderConnections.ts";
import { ProviderConnectionRepositoryLive } from "./ProviderConnections.ts";

const sqlLayer = NodeSqliteClient.layerMemory();
const layer = it.layer(
  Layer.mergeAll(sqlLayer, ProviderConnectionRepositoryLive.pipe(Layer.provide(sqlLayer))),
);

layer("ProviderConnectionRepository", (it) => {
  it.effect("keeps secret references internal and applies terminal Space fallback", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const repository = yield* ProviderConnectionRepository;
      yield* runMigrations();
      yield* sql`
        INSERT INTO projection_spaces (
          space_id, name, icon, sort_order, created_at, updated_at
        ) VALUES ('space-1', 'Personal', '', 0, '2026-08-08T00:00:00.000Z', '2026-08-08T00:00:00.000Z')
      `;
      const personal = yield* repository.create({
        id: ProviderConnectionId.makeUnsafe("connection-personal"),
        harness: "codex",
        authenticationTargetId: "openai-first-party",
        authenticationMethodId: "managed-login",
        label: "Personal",
        credentialRef: null,
        profileRef: "profile-personal",
        providerIdentityId: "account-personal",
        createdAt: "2026-08-08T00:00:00.000Z",
      });
      const work = yield* repository.create({
        id: ProviderConnectionId.makeUnsafe("connection-work"),
        harness: "codex",
        authenticationTargetId: "openai-first-party",
        authenticationMethodId: "managed-login",
        label: "Work",
        credentialRef: null,
        profileRef: "profile-work",
        providerIdentityId: "account-work",
        createdAt: "2026-08-08T00:00:01.000Z",
      });

      assert.notProperty(personal, "profileRef");
      assert.notProperty(personal, "credentialRef");
      yield* repository.setSpaceDefault({
        spaceId: SpaceId.makeUnsafe("space-1"),
        harness: "codex",
        connectionId: work.id,
        createdAt: "2026-08-08T00:00:01.000Z",
        updatedAt: "2026-08-08T00:00:01.000Z",
      });
      const terminated = yield* repository.terminate({
        id: work.id,
        reason: "disconnected",
        terminatedAt: "2026-08-08T00:01:00.000Z",
      });
      assert.isTrue(Option.isSome(terminated));
      assert.strictEqual(Option.getOrThrow(terminated).lifecycle, "terminated");
      const defaults = yield* repository.listSpaceDefaults(SpaceId.makeUnsafe("space-1"));
      assert.deepStrictEqual(
        defaults.map((entry) => entry.connectionId),
        [personal.id],
      );
      const active = yield* repository.list();
      assert.deepStrictEqual(
        active.map((connection) => connection.id),
        [personal.id],
      );
      const all = yield* repository.list({ includeTerminated: true });
      assert.deepStrictEqual(
        all.map((connection) => connection.id),
        [work.id, personal.id],
      );
    }),
  );
});
