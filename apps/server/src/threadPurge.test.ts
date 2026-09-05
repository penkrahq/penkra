import { FolderId, SpaceId, ThreadId } from "@penkra/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ProjectionFolderRepositoryLive } from "./persistence/Layers/ProjectionFolders.ts";
import { SqlitePersistenceMemory } from "./persistence/Layers/Sqlite.ts";
import { ProjectionThreadRepositoryLive } from "./persistence/Layers/ProjectionThreads.ts";
import { ProjectionFolderRepository } from "./persistence/Services/ProjectionFolders.ts";
import { ProjectionThreadRepository } from "./persistence/Services/ProjectionThreads.ts";
import { ThreadPurge, ThreadPurgeLive } from "./threadPurge.ts";

const layer = it.layer(
  Layer.mergeAll(
    ThreadPurgeLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
    ProjectionFolderRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
    ProjectionThreadRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
    SqlitePersistenceMemory,
  ),
);

layer("ThreadPurge", (it) => {
  it.effect("purges transcript, pending input, binding, and queues native-state deletion", () =>
    Effect.gen(function* () {
      const folders = yield* ProjectionFolderRepository;
      const threads = yield* ProjectionThreadRepository;
      const purge = yield* ThreadPurge;
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-09-04T00:00:00.000Z";
      const threadId = ThreadId.makeUnsafe("thread-canonical-purge");

      yield* folders.upsert({
        folderId: FolderId.makeUnsafe("folder-canonical-purge"),
        title: "Purge",
        workspaceRoot: null,
        defaultModelSelection: { provider: "codex", model: "gpt-5.5" },
        scripts: [],
        isPinned: false,
        spaceId: SpaceId.makeUnsafe("penkra-personal"),
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      });
      yield* threads.upsert({
        threadId,
        folderId: FolderId.makeUnsafe("folder-canonical-purge"),
        title: "Irrecoverable",
        modelSelection: { provider: "codex", model: "gpt-5.5" },
        runtimeMode: "full-access",
        latestTurnId: null,
        pinnedMessages: null,
        notes: null,
        latestUserMessageAt: null,
        pendingApprovalCount: 0,
        pendingUserInputCount: 1,
        createdAt: now,
        updatedAt: now,
        deletedAt: now,
      });
      yield* sql`
        INSERT INTO provider_native_state_generations (
          native_state_generation_id, harness_kind, adapter_schema_version,
          state_manifest_json, lifecycle, created_at, owner_thread_id
        ) VALUES (
          'generation-canonical-purge', 'codex', 'test-v1', '{}', 'active', ${now}, ${threadId}
        )
      `;
      yield* sql`
        INSERT INTO thread_harness_states (
          thread_id, harness_kind, native_state_generation_id, provider_session_id,
          native_state_locator_json, last_verified_resume_at, state_revision, created_at, updated_at
        ) VALUES (
          ${threadId}, 'codex', 'generation-canonical-purge', 'session-canonical-purge',
          '{"threadId":"session-canonical-purge"}', ${now}, 0, ${now}, ${now}
        )
      `;
      yield* sql`
        INSERT INTO projection_pending_interactions (
          interaction_kind, request_id, thread_id, turn_id, lifecycle_generation,
          status, decision, response_command_id, response_requested_at, created_at, resolved_at
        ) VALUES (
          'user-input', 'request-canonical-purge', ${threadId}, NULL, 'generation-1',
          'pending', NULL, NULL, NULL, ${now}, NULL
        )
      `;

      assert.isTrue(yield* purge.purge(threadId));

      const counts = yield* sql<{
        readonly threadCount: number;
        readonly pendingCount: number;
        readonly bindingCount: number;
        readonly deletionCount: number;
      }>`
        SELECT
          (SELECT count(*) FROM projection_threads WHERE thread_id = ${threadId}) AS "threadCount",
          (SELECT count(*) FROM projection_pending_interactions WHERE thread_id = ${threadId}) AS "pendingCount",
          (SELECT count(*) FROM thread_harness_states WHERE thread_id = ${threadId}) AS "bindingCount",
          (SELECT count(*) FROM provider_native_state_deletions WHERE owner_thread_id = ${threadId}) AS "deletionCount"
      `;
      assert.deepEqual(counts[0], {
        threadCount: 0,
        pendingCount: 0,
        bindingCount: 0,
        deletionCount: 1,
      });
    }),
  );
});
