import { seedThreadFolderFixture } from "./threadFixtures.ts";
import { assert, it } from "@effect/vitest";
import { MessageId, ProviderConnectionId, ThreadId } from "@penkra/contracts";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { draftAfterSend, getThreadDraft, setThreadDraft } from "./threadDraft.ts";
import { makeThreadPublisher } from "./threadStore.ts";
import { enqueueMessage } from "./threadQueue.ts";
import { createThread } from "./threadStore.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";

const withDb = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  effect.pipe(Effect.provide(NodeSqliteClient.layerMemory()));

const baseThread = {
  id: "thread-1",
  spaceId: "space-1",
  folderId: "core-test-folder",
  title: "Hello",
  provider: "codex",
  model: "gpt-5.5",
  runtimeMode: "full-access",
  createdBy: "user" as const,
  createdAt: "2026-10-09T00:00:00.000Z",
};

it.effect("keeps one draft per thread, last write wins by draft_updated_at", () =>
  withDb(
    Effect.gen(function* () {
      yield* runMigrations();
      yield* seedThreadFolderFixture("core-test-folder", "space-1");
      yield* createThread(baseThread);
      const id = ThreadId.makeUnsafe("thread-1");
      const publisher = makeThreadPublisher();
      let changes = 0;
      publisher.subscribe("thread-1", () => changes++);

      assert.deepStrictEqual(yield* getThreadDraft(id), { draft: null, draftUpdatedAt: null });

      const first = yield* setThreadDraft(publisher, id, "hello", "2026-10-09T00:00:01.000Z");
      assert.deepStrictEqual(first, { draft: "hello", draftUpdatedAt: "2026-10-09T00:00:01.000Z" });

      // A newer write wins.
      const second = yield* setThreadDraft(
        publisher,
        id,
        "hello world",
        "2026-10-09T00:00:02.000Z",
      );
      assert.equal(second.draft, "hello world");

      // An older write is ignored.
      const stale = yield* setThreadDraft(publisher, id, "stale", "2026-10-09T00:00:00.500Z");
      assert.equal(stale.draft, "hello world");
      // Each accepted save publishes so other windows update live.
      assert.equal(changes, 3);
    }),
  ),
);

for (const state of ["idle", "running"]) {
  it.effect(
    `an account/model pick in the draft leaves the ${state} thread ownership unchanged`,
    () =>
      withDb(
        Effect.gen(function* () {
          yield* runMigrations();
          yield* seedThreadFolderFixture("core-test-folder", "space-1");
          yield* createThread(baseThread);
          const sql = yield* SqlClient.SqlClient;
          yield* sql`UPDATE threads SET connection_id='old-account', native_state_id='old-native', provider_session_id='old-session', state=${state}, active_turn_id=${state === "running" ? "old-turn" : null} WHERE id='thread-1'`;
          const before =
            yield* sql`SELECT connection_id, model, model_options, native_state_id, provider_session_id, state, active_turn_id FROM threads WHERE id='thread-1'`;
          const draft = JSON.stringify({
            prompt: "",
            attachments: [],
            files: [],
            modelSelectionByProvider: { codex: { provider: "codex", model: "model-B" } },
            connectionSelectionByProvider: { codex: "new-account" },
            activeProvider: "codex",
          });
          yield* setThreadDraft(
            makeThreadPublisher(),
            "thread-1",
            draft,
            "2026-10-11T00:00:00.000Z",
          );
          assert.deepStrictEqual(
            yield* sql`SELECT connection_id, model, model_options, native_state_id, provider_session_id, state, active_turn_id FROM threads WHERE id='thread-1'`,
            before,
          );
          assert.equal((yield* getThreadDraft("thread-1")).draft, draft);
        }),
      ),
  );
}

it.effect("queue admission preserves a newer draft and its selection", () =>
  withDb(
    Effect.gen(function* () {
      yield* runMigrations();
      yield* seedThreadFolderFixture("core-test-folder", "space-1");
      yield* createThread(baseThread);
      const publisher = makeThreadPublisher();
      const choice = {
        modelSelectionByProvider: { codex: { provider: "codex", model: "model-B" } },
        connectionSelectionByProvider: { codex: "account-B" },
        activeProvider: "codex",
      };
      const draft = JSON.stringify({
        prompt: "queued content",
        attachments: [],
        files: [],
        ...choice,
      });
      yield* setThreadDraft(publisher, "thread-1", draft, "2099-10-11T00:00:02.000Z");
      yield* enqueueMessage(
        "thread-1",
        {
          messageId: MessageId.makeUnsafe("queued-pick"),
          text: "captured content",
          attachments: [],
          senderThreadId: null,
          dispatchOrigin: "user",
          queuedAt: "2099-10-11T00:00:01.000Z",
        },
        {
          modelSelection: { provider: "codex", model: "model-A" },
          connectionId: ProviderConnectionId.makeUnsafe("account-A"),
        },
      );
      const saved = (yield* getThreadDraft("thread-1")).draft!;
      assert.deepStrictEqual(JSON.parse(saved), {
        prompt: "queued content",
        attachments: [],
        files: [],
        ...choice,
      });
      assert.deepStrictEqual(JSON.parse(draftAfterSend(saved, "codex", undefined)!), {
        ...JSON.parse(saved),
        prompt: "",
      });
    }),
  ),
);
