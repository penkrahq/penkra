import { assert, it } from "@effect/vitest";
import { ProviderConnectionId, ThreadId } from "@penkra/contracts";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import { seedThreadFolderFixture } from "./threadFixtures.ts";
import { createThread, upsertThreadItem } from "./threadStore.ts";
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
    yield* sql`CREATE TABLE admission_writes(connection_id TEXT, native_state_id TEXT, provider_session_id TEXT, model TEXT, runtime_mode TEXT)`;
    yield* sql`CREATE TRIGGER record_admission AFTER UPDATE OF connection_id, native_state_id ON threads BEGIN INSERT INTO admission_writes VALUES (NEW.connection_id, NEW.native_state_id, NEW.provider_session_id, NEW.model, NEW.runtime_mode); END`;
    const input = {
      threadId: ThreadId.makeUnsafe("thread"),
      modelSelection: { provider: "claudeAgent", model: "model-B" } as const,
      connectionId: ProviderConnectionId.makeUnsafe("new-account"),
      nativeState: { id: "copied-native", providerSessionId: "copied-session" },
      runtimeMode: "approval-required" as const,
      updatedAt: "2026-10-11T00:00:01.000Z",
      deliveryMessageId: "message",
      connectionLabel: "New account",
      modelLabel: "Model B",
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
        runtime_mode: "approval-required",
      },
    ]);
    assert.deepStrictEqual(yield* sql`SELECT * FROM thread_items`, []);
    yield* upsertThreadItem({
      threadId: "thread",
      sourceId: "old-turn",
      turnId: "old-turn",
      kind: "turn",
      status: "done",
      createdAt: input.updatedAt,
      updatedAt: input.updatedAt,
    });
    const changed = {
      ...input,
      connectionId: ProviderConnectionId.makeUnsafe("third-account"),
      modelSelection: { provider: "claudeAgent", model: "model-C" } as const,
    };
    const beforeItems = yield* sql`SELECT * FROM thread_items`;
    yield* Effect.flip(
      sql.withTransaction(
        commitThreadTurnSelection(changed).pipe(Effect.andThen(Effect.fail(new Error("rollback")))),
      ),
    );
    assert.deepStrictEqual(yield* sql`SELECT * FROM thread_items`, beforeItems);
    yield* sql.withTransaction(commitThreadTurnSelection(changed));
    const notices = yield* sql<{
      data: string;
      turn_id: string | null;
    }>`SELECT data,turn_id FROM thread_items WHERE kind='notice' ORDER BY seq`;
    assert.deepStrictEqual(
      notices.map((row) => ({ ...JSON.parse(row.data), turnId: row.turn_id })),
      [
        {
          tone: "info",
          kind: "connection-changed",
          summary: "Connection changed to New account",
          payload: {},
          anchor: { messageId: "message" },
          turnId: null,
        },
        {
          tone: "info",
          kind: "model-changed",
          summary: "Model changed to Model B",
          payload: {},
          anchor: { messageId: "message" },
          turnId: null,
        },
      ],
    );
    yield* sql.withTransaction(commitThreadTurnSelection(changed));
    assert.deepStrictEqual(
      yield* sql`SELECT data,turn_id FROM thread_items WHERE kind='notice' ORDER BY seq`,
      notices,
    );
    const accountOnly = { ...changed, connectionId: input.connectionId };
    yield* sql.withTransaction(commitThreadTurnSelection(accountOnly));
    yield* sql.withTransaction(
      commitThreadTurnSelection({ ...accountOnly, modelSelection: input.modelSelection }),
    );
    assert.deepStrictEqual(
      (yield* sql<{
        kind: string;
      }>`SELECT json_extract(data,'$.kind') AS kind FROM thread_items WHERE kind='notice' ORDER BY seq`).map(
        (row) => row.kind,
      ),
      ["connection-changed", "model-changed", "connection-changed", "model-changed"],
    );
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
