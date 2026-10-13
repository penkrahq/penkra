import { ThreadId } from "@penkra/contracts";
import { Effect, Layer, ManagedRuntime, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ThreadReads, ThreadReadsLive } from "../../server/src/cleanCore/ThreadReads.ts";
import { SqlitePersistenceMemory } from "../../server/src/persistence/Layers/Sqlite.ts";
import { seedThreadFolderFixture } from "../../server/src/cleanCore/threadFixtures.ts";
import { ThreadErrorBanner } from "../src/components/chat/ThreadErrorBanner";

describe("failed queued delivery hydration", () => {
  it("renders the stored reason through the canonical cold thread read", async () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    const reason =
      "This thread uses a different provider. To use another provider, start a new thread.";
    const runtime = ManagedRuntime.make(
      ThreadReadsLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
    );
    try {
      await runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* seedThreadFolderFixture("project-1", "penkra-personal");
          yield* sql`INSERT INTO threads (id,space_id,folder_id,title,provider,model,runtime_mode,state,last_error,queue,created_by,created_at,updated_at)
          VALUES (${threadId},'penkra-personal','project-1','Thread','codex','gpt-5-codex','full-access','error',${reason},${JSON.stringify([{ messageId: "queued-failure", text: "Continue", attachments: [], senderThreadId: null, dispatchOrigin: "user", queuedAt: "2026-09-27T00:00:00.000Z" }])},'user','2026-09-27T00:00:00.000Z','2026-09-27T00:00:01.000Z')`;
        }),
      );
      const query = await runtime.runPromise(Effect.service(ThreadReads));
      const shell = Option.getOrThrow(await runtime.runPromise(query.getThreadShellById(threadId)));
      expect(shell.session?.lastError).toBe(reason);
      expect(await runtime.runPromise(query.queueLength(threadId))).toBe(1);
      expect(
        renderToStaticMarkup(<ThreadErrorBanner error={shell.session?.lastError ?? null} />),
      ).toContain(reason);
    } finally {
      await runtime.dispose();
    }
  });
});
