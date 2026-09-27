import { MessageId, ThreadId } from "@penkra/contracts";
import { Effect, Layer, ManagedRuntime } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { OrchestrationProjectionSnapshotQueryLive } from "../../server/src/orchestration/Layers/ProjectionSnapshotQuery.ts";
import { ProjectionSnapshotQuery } from "../../server/src/orchestration/Services/ProjectionSnapshotQuery.ts";
import { SqlitePersistenceMemory } from "../../server/src/persistence/Layers/Sqlite.ts";
import { ThreadErrorBanner } from "../src/components/chat/ThreadErrorBanner";
import { syncServerShellSnapshot, syncServerThreadTurnsPage } from "../src/storeProjection";
import { makeState, makeThread, threadsOf } from "../src/storeTestFixtures";

describe("failed queued delivery hydration", () => {
  it("renders the stored reason through the real snapshot query and cold shell/page hydration", async () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    const messageId = MessageId.makeUnsafe("queued-failure");
    const reason =
      "This thread uses a different provider. To use another provider, start a new thread.";
    const runtime = ManagedRuntime.make(
      OrchestrationProjectionSnapshotQueryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
    );
    try {
      const query = await runtime.runPromise(Effect.service(ProjectionSnapshotQuery));
      await runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`INSERT INTO projection_folders (
          folder_id, title, workspace_root, default_model_selection_json, scripts_json,
          created_at, updated_at, deleted_at
        ) VALUES ('project-1', 'Project', '/tmp/project', NULL, '[]',
          '2026-09-27T00:00:00.000Z', '2026-09-27T00:00:01.000Z', NULL)`;
          yield* sql`INSERT INTO projection_threads (
          thread_id, folder_id, title, model_selection_json, working_directory,
          latest_turn_id, created_at, updated_at, deleted_at
        ) VALUES (${threadId}, 'project-1', 'Thread',
          '{"provider":"codex","model":"gpt-5-codex"}', NULL, NULL,
          '2026-09-27T00:00:00.000Z', '2026-09-27T00:00:01.000Z', NULL)`;
          yield* sql`INSERT INTO projection_thread_messages (
          message_id, thread_id, turn_id, role, text, dispatch_mode,
          delivery_state, delivery_queued, delivery_sequence,
          delivery_failure_phase, delivery_failure_detail,
          is_streaming, source, sequence, created_at, updated_at
        ) VALUES (${messageId}, ${threadId}, NULL, 'user', 'Continue', 'queue',
          'failed', 0, 12, 'before-provider-dispatch', ${reason},
          0, 'native', 10, '2026-09-27T00:00:00.000Z', '2026-09-27T00:00:01.000Z')`;
        }),
      );

      const snapshot = await runtime.runPromise(query.getSnapshot());
      expect(snapshot.threads[0]?.messages[0]?.delivery?.failureDetail).toBe(reason);
      const shell = await runtime.runPromise(query.getShellSnapshot());
      const page = await runtime.runPromise(query.getThreadTurnsPage({ threadId }));
      expect(page.messages[0]?.delivery?.failureDetail).toBe(reason);

      const cold = syncServerShellSnapshot(makeState(makeThread()), shell);
      expect(threadsOf(cold)[0]?.messages).toEqual([]);
      const hydrated = syncServerThreadTurnsPage(cold, page);
      const thread = threadsOf(hydrated)[0];
      expect(thread?.messages[0]?.delivery?.state).toBe("failed");
      const markup = renderToStaticMarkup(<ThreadErrorBanner error={thread?.error ?? null} />);
      expect(markup).toContain(reason);
      expect(threadsOf(syncServerShellSnapshot(hydrated, shell))[0]?.error).toBe(reason);

      await runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`INSERT INTO projection_thread_messages (
          message_id, thread_id, turn_id, role, text, dispatch_mode,
          delivery_state, delivery_queued, delivery_sequence,
          is_streaming, source, sequence, created_at, updated_at
        ) VALUES ('later-send', ${threadId}, NULL, 'user', 'Run normally', 'queue',
          'accepted', 0, 21, 0, 'native', 20,
          '2026-09-27T00:00:02.000Z', '2026-09-27T00:00:03.000Z')`;
        }),
      );
      const laterPage = await runtime.runPromise(query.getThreadTurnsPage({ threadId }));
      const afterLaterSend = syncServerThreadTurnsPage(hydrated, laterPage);
      expect(threadsOf(afterLaterSend)[0]?.error).toBeNull();
    } finally {
      await runtime.dispose();
    }
  });
});
