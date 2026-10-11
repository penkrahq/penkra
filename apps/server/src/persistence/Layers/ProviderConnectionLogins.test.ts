import { ProviderConnectionId } from "@penkra/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import type { ProviderConnectionLoginRecord } from "../Services/ProviderConnectionLogins.ts";
import { makeProviderConnectionLogins } from "./ProviderConnectionLogins.ts";

const baseRecord: ProviderConnectionLoginRecord = {
  operationId: "login-one",
  connectionId: ProviderConnectionId.makeUnsafe("connection-one"),
  committedConnectionId: null,
  harness: "codex",
  authenticationTargetId: "openai-first-party",
  authenticationMethodId: "chatgpt",
  label: "Pending account email",
  profileRef: "provider-profile:one",
  providerLoginId: null,
  state: "starting",
  providerIdentityId: null,
  failureReason: null,
  createdAt: "2026-10-11T00:00:00.000Z",
  updatedAt: "2026-10-11T00:00:00.000Z",
};

it.layer(NodeSqliteClient.layerMemory())("in-process Connection sign-in", (it) => {
  it.effect("keeps sign-in progress in memory and only the credential profile in SQLite", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const record = { ...baseRecord, operationId: "FIRST", profileRef: "provider-profile:FIRST" };
      const sql = yield* SqlClient.SqlClient;
      const logins = yield* makeProviderConnectionLogins;
      yield* logins.begin(record);
      const committedConnectionId = ProviderConnectionId.makeUnsafe("canonical-one");
      const completed = yield* logins.transition({
        operationId: record.operationId,
        state: "completed",
        providerLoginId: "provider-login-one",
        providerIdentityId: "person@example.com",
        committedConnectionId,
        failureReason: null,
        updatedAt: record.updatedAt,
      });
      assert.strictEqual(Option.getOrThrow(completed).committedConnectionId, committedConnectionId);
      assert.deepStrictEqual(yield* logins.listOpen(), []);
      assert.strictEqual(
        Option.getOrThrow(yield* logins.get(record.operationId)).state,
        "completed",
      );
      assert.deepStrictEqual(yield* sql`SELECT operation_id FROM provider_connection_logins`, []);
      assert.deepStrictEqual(
        yield* sql`SELECT profile_ref FROM provider_credential_profiles WHERE profile_ref = ${record.profileRef}`,
        [{ profile_ref: record.profileRef }],
      );
    }),
  );

  it.effect("a fresh server has no interrupted login to resume", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const record = {
        ...baseRecord,
        operationId: "SECOND",
        profileRef: "provider-profile:SECOND",
      };
      const first = yield* makeProviderConnectionLogins;
      yield* first.begin(record);
      assert.strictEqual((yield* first.listOpen()).length, 1);
      const restarted = yield* makeProviderConnectionLogins;
      assert.strictEqual(Option.isNone(yield* restarted.get(record.operationId)), true);
      assert.deepStrictEqual(yield* restarted.listOpen(), []);
      assert.strictEqual(
        Option.isNone(
          yield* restarted.transition({
            operationId: record.operationId,
            state: "cancelled",
            providerLoginId: null,
            providerIdentityId: null,
            failureReason: null,
            updatedAt: record.updatedAt,
          }),
        ),
        true,
      );
      yield* restarted.begin({
        ...record,
        operationId: "login-two",
        profileRef: "provider-profile:two",
      });
      assert.strictEqual((yield* restarted.listOpen()).length, 1);
    }),
  );

  it.effect("a failed profile insert cannot expose an in-memory login", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const record = { ...baseRecord, operationId: "THIRD", profileRef: "provider-profile:THIRD" };
      const logins = yield* makeProviderConnectionLogins;
      yield* logins.begin(record);
      const failed = yield* Effect.exit(
        logins.begin({ ...record, operationId: "duplicate-profile" }),
      );
      assert.strictEqual(failed._tag, "Failure");
      assert.strictEqual(Option.isNone(yield* logins.get("duplicate-profile")), true);
      assert.strictEqual((yield* logins.listOpen()).length, 1);
    }),
  );
});
