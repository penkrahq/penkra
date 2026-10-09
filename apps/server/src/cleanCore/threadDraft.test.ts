import { assert, it } from "@effect/vitest";
import { ThreadId } from "@penkra/contracts";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { getThreadDraft, setThreadDraft } from "./threadDraft.ts";
import { createThread } from "./threadStore.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";

const withDb = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  effect.pipe(Effect.provide(NodeSqliteClient.layerMemory()));

const baseThread = {
  id: "thread-1",
  spaceId: "space-1",
  title: "Hello",
  provider: "codex",
  model: "gpt-5.5",
  createdAt: "2026-10-09T00:00:00.000Z",
};

it.effect("keeps one draft per thread, last write wins by draft_updated_at", () =>
  withDb(
    Effect.gen(function* () {
      yield* runMigrations();
      yield* createThread(baseThread);
      const id = ThreadId.makeUnsafe("thread-1");

      assert.deepStrictEqual(yield* getThreadDraft(id), { draft: null, draftUpdatedAt: null });

      const first = yield* setThreadDraft(id, "hello", "2026-10-09T00:00:01.000Z");
      assert.deepStrictEqual(first, { draft: "hello", draftUpdatedAt: "2026-10-09T00:00:01.000Z" });

      // A newer write wins.
      const second = yield* setThreadDraft(id, "hello world", "2026-10-09T00:00:02.000Z");
      assert.equal(second.draft, "hello world");

      // An older write is ignored.
      const stale = yield* setThreadDraft(id, "stale", "2026-10-09T00:00:00.500Z");
      assert.equal(stale.draft, "hello world");
    }),
  ),
);
