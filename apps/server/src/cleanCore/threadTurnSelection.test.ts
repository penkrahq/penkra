import { assert, it } from "@effect/vitest";
import { ProviderConnectionId, ThreadId } from "@penkra/contracts";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import { seedThreadFolderFixture } from "./threadFixtures.ts";
import { createThread } from "./threadStore.ts";
import { commitThreadTurnSelection } from "./threadTurnSelection.ts";

it.effect("commits the copied native folder and selected account in one turn-admission write", () =>
  Effect.gen(function* () {
    yield* runMigrations();
    yield* seedThreadFolderFixture("folder", "space");
    yield* createThread({
      id: "thread",
      folderId: "folder",
      spaceId: "space",
      title: "Thread",
      provider: "claudeAgent",
      model: "model-A",
      runtimeMode: "full-access",
      createdBy: "user",
      createdAt: "2026-10-11T00:00:00.000Z",
    });
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE threads SET connection_id='old-account', native_state_id='old-native', provider_session_id='old-session' WHERE id='thread'`;
    yield* sql`CREATE TABLE admission_writes(connection_id TEXT, native_state_id TEXT, provider_session_id TEXT, model TEXT)`;
    yield* sql`CREATE TRIGGER record_admission AFTER UPDATE OF connection_id, native_state_id ON threads BEGIN INSERT INTO admission_writes VALUES (NEW.connection_id, NEW.native_state_id, NEW.provider_session_id, NEW.model); END`;
    const input = {
      threadId: ThreadId.makeUnsafe("thread"),
      modelSelection: { provider: "claudeAgent", model: "model-B" } as const,
      connectionId: ProviderConnectionId.makeUnsafe("new-account"),
      nativeState: { id: "copied-native", providerSessionId: "copied-session" },
      updatedAt: "2026-10-11T00:00:01.000Z",
    };
    const before = yield* sql`SELECT * FROM threads WHERE id='thread'`;
    const failure = yield* Effect.flip(
      sql.withTransaction(
        commitThreadTurnSelection(input).pipe(
          Effect.andThen(Effect.fail(new Error("admission rejected"))),
        ),
      ),
    );
    assert.equal(failure.message, "admission rejected");
    assert.deepStrictEqual(yield* sql`SELECT * FROM threads WHERE id='thread'`, before);
    assert.deepStrictEqual(yield* sql`SELECT * FROM admission_writes`, []);
    yield* sql.withTransaction(commitThreadTurnSelection(input));
    assert.deepStrictEqual(yield* sql`SELECT * FROM admission_writes`, [
      {
        connection_id: "new-account",
        native_state_id: "copied-native",
        provider_session_id: "copied-session",
        model: "model-B",
      },
    ]);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
