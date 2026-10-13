import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { assert, it } from "@effect/vitest";
import { MessageId, ThreadId } from "@penkra/contracts";
import { Cause, Effect, Exit } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../persistence/Migrations";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient";
import {
  applyProviderEvent,
  settleRunningThreadsOnStartup,
  PROVIDER_CUTOFF_NOTICE,
} from "./providerStreamConsumer";
import { sendMessage, settleMessage, writeSendingMessage, type SendDriver } from "./sendMessage";
import { seedThreadFolderFixture } from "./threadFixtures";
import { listThreadItemsPage } from "./threadItemsPage.ts";
import { findThread } from "./threadList.ts";
import { readThreadQueue } from "./threadQueue.ts";
import { createThread, makeThreadPublisher } from "./threadStore";

const at = "2026-10-09T00:00:01.000Z";
const input = {
  threadId: "thread",
  draft: JSON.stringify({ prompt: "Original text", attachments: [], files: [] }),
  draftUpdatedAt: at,
  message: {
    messageId: MessageId.makeUnsafe("message"),
    text: "Original text",
    attachments: [],
    senderThreadId: null,
    dispatchOrigin: "user" as const,
    queuedAt: at,
  },
  dispatchMode: "queue" as const,
  supportsSteer: true,
};
const driver: SendDriver = {
  claimAttachments: () => Effect.void,
  dispatch: () => Effect.die("admission must not dispatch"),
};
const setup = Effect.gen(function* () {
  yield* runMigrations();
  yield* seedThreadFolderFixture("folder", "space");
  yield* createThread({
    id: input.threadId,
    spaceId: "space",
    folderId: "folder",
    title: "Thread",
    provider: "codex",
    model: "gpt-5.5",
    runtimeMode: "full-access",
    createdBy: "user",
    createdAt: at,
  });
  const sql = yield* SqlClient.SqlClient;
  yield* sql`UPDATE threads SET draft=${JSON.stringify({ prompt: input.message.text, attachments: [], files: [] })},draft_updated_at=${at}`;
  return makeThreadPublisher();
});
const withDb = <A, E>(program: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  program.pipe(Effect.provide(NodeSqliteClient.layerMemory()));
for (const [state, dispatchMode, supportsSteer, plan] of [
  ["idle", "queue", true, "deliver"],
  ["running", "queue", true, "queue"],
  ["running", "steer", true, "steer"],
  ["running", "steer", false, "interrupt-deliver"],
] as const) {
  it.effect(`${plan} admission persists its final place and clears draft before replying`, () =>
    withDb(
      Effect.gen(function* () {
        const publisher = yield* setup;
        const sql = yield* SqlClient.SqlClient;
        if (state === "running")
          yield* applyProviderEvent(publisher, {
            type: "turn.started",
            threadId: "thread",
            turnId: "running",
            at,
          });
        const result = yield* sendMessage(publisher, driver, {
          ...input,
          dispatchMode,
          supportsSteer,
        });
        assert.equal(result.plan, plan);
        const [thread] = yield* sql<{
          draft: string | null;
          queue: string;
        }>`SELECT draft,queue FROM threads WHERE id='thread'`;
        assert.equal(thread!.draft, null);
        const rows = yield* sql<{
          seq: number;
          status: string;
          turnId: string | null;
        }>`SELECT seq,status,turn_id AS "turnId" FROM thread_items WHERE kind='user'`;
        if (result.plan === "queue") {
          assert.deepStrictEqual(rows, []);
          assert.equal(JSON.parse(thread!.queue)[0].text, input.message.text);
          assert.equal(result.position, 1);
          assert.equal(result.queueLength, 1);
        } else {
          assert.deepStrictEqual(rows, [{ seq: result.seq, status: "sending", turnId: null }]);
          assert.deepStrictEqual(JSON.parse(thread!.queue), []);
        }
      }),
    ),
  );
}
it.effect("an unacknowledged admission queues the next plain send", () =>
  withDb(
    Effect.gen(function* () {
      const publisher = yield* setup;
      const first = yield* sendMessage(publisher, driver, input);
      const second = yield* sendMessage(publisher, driver, {
        ...input,
        message: { ...input.message, messageId: MessageId.makeUnsafe("second") },
      });
      assert.equal(first.plan, "deliver");
      assert.equal(second.plan, "queue");
    }),
  ),
);
it.effect("a repeated admission has one item and the same seq", () =>
  withDb(
    Effect.gen(function* () {
      const publisher = yield* setup;
      const first = yield* sendMessage(publisher, driver, input);
      const repeated = yield* sendMessage(publisher, driver, input);
      assert.deepStrictEqual(repeated, first);
      const sql = yield* SqlClient.SqlClient;
      assert.deepStrictEqual(
        yield* sql`SELECT COUNT(*) AS count FROM thread_items WHERE kind='user'`,
        [{ count: 1 }],
      );
    }),
  ),
);
it.effect("native success settles the same row without changing its seq", () =>
  withDb(
    Effect.gen(function* () {
      const publisher = yield* setup;
      const admission = yield* sendMessage(publisher, driver, input);
      assert.notEqual(admission.plan, "queue");
      yield* settleMessage(
        publisher,
        { type: "acknowledged", threadId: "thread", messageId: "message", turnId: "native" },
        at,
      );
      const sql = yield* SqlClient.SqlClient;
      assert.deepStrictEqual(yield* sql`SELECT seq,status,turn_id FROM thread_items`, [
        { seq: "seq" in admission ? admission.seq : -1, status: "sent", turn_id: "native" },
      ]);
    }),
  ),
);
it.effect("native failure removes the row and restores text and last_error", () =>
  withDb(
    Effect.gen(function* () {
      const publisher = yield* setup;
      yield* sendMessage(publisher, driver, input);
      yield* settleMessage(
        publisher,
        { type: "failed", threadId: "thread", messageId: "message", error: "Provider refused" },
        at,
      );
      const sql = yield* SqlClient.SqlClient;
      assert.deepStrictEqual(yield* sql`SELECT * FROM thread_items WHERE kind='user'`, []);
      const [thread] = yield* sql<{
        draft: string;
        lastError: string;
      }>`SELECT draft,last_error AS "lastError" FROM threads`;
      assert.equal(JSON.parse(thread!.draft).prompt, input.message.text);
      assert.equal(thread!.lastError, "Provider refused");
    }),
  ),
);
it.effect("a pre-write attachment rejection is an error and preserves the draft", () =>
  withDb(
    Effect.gen(function* () {
      const publisher = yield* setup;
      const failed = yield* Effect.exit(
        sendMessage(
          publisher,
          { ...driver, claimAttachments: () => Effect.fail(new Error("Attachment denied")) },
          input,
        ),
      );
      assert.isTrue(Exit.isFailure(failed));
      if (Exit.isFailure(failed)) assert.include(Cause.pretty(failed.cause), "Attachment denied");
      const sql = yield* SqlClient.SqlClient;
      assert.deepStrictEqual(yield* sql`SELECT * FROM thread_items`, []);
      const [thread] = yield* sql<{
        draft: string;
        queue: string;
      }>`SELECT draft,queue FROM threads`;
      assert.equal(JSON.parse(thread!.draft).prompt, input.message.text);
      assert.equal(thread!.queue, "[]");
    }),
  ),
);
it.effect("a draft-clear failure rolls back admission and publishes nothing", () =>
  withDb(
    Effect.gen(function* () {
      const publisher = yield* setup;
      const sql = yield* SqlClient.SqlClient;
      const changes: unknown[] = [];
      publisher.subscribeAll((change) => changes.push(change));
      yield* sql`CREATE TEMP TRIGGER reject_draft_clear BEFORE UPDATE OF draft ON threads BEGIN SELECT RAISE(ABORT,'injected clear failure'); END`;
      assert.isTrue(Exit.isFailure(yield* Effect.exit(sendMessage(publisher, driver, input))));
      assert.deepStrictEqual(yield* sql`SELECT * FROM thread_items`, []);
      assert.deepStrictEqual(changes, []);
    }),
  ),
);
it.effect("restart before native ack removes admitted row and restores failed data shape", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const directory = yield* Effect.acquireRelease(
        Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "penkra-send-admission-"))),
        (directory) => Effect.promise(() => fs.rm(directory, { recursive: true, force: true })),
      );
      const filename = path.join(directory, "state.sqlite");
      yield* Effect.gen(function* () {
        const publisher = yield* setup;
        const admission = yield* sendMessage(publisher, driver, input);
        assert.equal(admission.plan, "deliver");
        const sql = yield* SqlClient.SqlClient;
        assert.deepStrictEqual(yield* sql`SELECT status FROM thread_items WHERE kind='user'`, [
          { status: "sending" },
        ]);
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename })));
      // The first connection and its publisher are gone before startup opens the database.
      yield* Effect.gen(function* () {
        yield* settleRunningThreadsOnStartup(makeThreadPublisher(), at);
        const sql = yield* SqlClient.SqlClient;
        assert.deepStrictEqual(yield* sql`SELECT * FROM thread_items WHERE kind='user'`, []);
        const [thread] = yield* sql<{ draft: string; lastError: string }>`
          SELECT draft,last_error AS "lastError" FROM threads`;
        assert.equal(JSON.parse(thread!.draft).prompt, input.message.text);
        assert.equal(thread!.lastError, PROVIDER_CUTOFF_NOTICE);
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename })));
    }),
  ),
);

it.effect("clear and restore strictly advance the committed draft timestamp", () =>
  withDb(
    Effect.gen(function* () {
      const publisher = yield* setup;
      const sql = yield* SqlClient.SqlClient;
      const sameMillisecond = "2099-10-09T00:00:01.000Z";
      yield* sql`UPDATE threads SET draft_updated_at=${sameMillisecond} WHERE id='thread'`;
      yield* sendMessage(publisher, driver, { ...input, draftUpdatedAt: sameMillisecond });
      const [cleared] = yield* sql<{
        draft_updated_at: string;
      }>`SELECT draft_updated_at FROM threads WHERE id='thread'`;
      assert.isAbove(Date.parse(cleared!.draft_updated_at), Date.parse(sameMillisecond));
      yield* settleMessage(
        publisher,
        { type: "failed", threadId: "thread", messageId: "message", error: "Rejected" },
        cleared!.draft_updated_at,
      );
      const [restored] = yield* sql<{
        draft: string;
        draft_updated_at: string;
      }>`SELECT draft,draft_updated_at FROM threads WHERE id='thread'`;
      assert.isAbove(Date.parse(restored!.draft_updated_at), Date.parse(cleared!.draft_updated_at));
      assert.equal(JSON.parse(restored!.draft).prompt, input.message.text);
    }),
  ),
);

const largeStructuredDraft = JSON.stringify({
  prompt: "raw prompt",
  attachments: [],
  files: [],
  fileComments: [
    { id: "comment", path: "code.ts", startLine: 1, endLine: 1, text: "detail".repeat(20_000) },
  ],
  pastedTexts: [{ id: "paste", createdAt: at, text: "pasted".repeat(20_000) }],
});
it.effect("restores a structured draft beyond the data cap without exposing recovery storage", () =>
  withDb(
    Effect.gen(function* () {
      const publisher = yield* setup;
      const sql = yield* SqlClient.SqlClient;
      yield* sendMessage(publisher, driver, { ...input, draft: largeStructuredDraft });
      const [stored] = yield* sql<{
        recovery_draft: string;
        data: string;
      }>`SELECT recovery_draft,data FROM thread_items WHERE kind='user'`;
      assert.equal(stored!.recovery_draft, largeStructuredDraft);
      assert.isBelow(new TextEncoder().encode(stored!.data).length, 64 * 1024);
      const page = yield* listThreadItemsPage({ threadId: ThreadId.makeUnsafe("thread") });
      assert.isFalse("recovery_draft" in page.items[0]!);
      assert.isFalse("admission_plan" in page.items[0]!);
      yield* settleMessage(
        publisher,
        { type: "failed", threadId: "thread", messageId: "message", error: "Rejected" },
        at,
      );
      assert.deepStrictEqual(yield* sql`SELECT draft,last_error FROM threads`, [
        { draft: largeStructuredDraft, last_error: "Rejected" },
      ]);
    }),
  ),
);
it.effect("clears private recovery storage when the native send is acknowledged", () =>
  withDb(
    Effect.gen(function* () {
      const publisher = yield* setup;
      yield* sendMessage(publisher, driver, { ...input, draft: largeStructuredDraft });
      yield* settleMessage(
        publisher,
        { type: "acknowledged", threadId: "thread", messageId: "message", turnId: "native" },
        at,
      );
      const sql = yield* SqlClient.SqlClient;
      assert.deepStrictEqual(
        yield* sql`SELECT status,recovery_draft FROM thread_items WHERE kind='user'`,
        [{ status: "sent", recovery_draft: null }],
      );
    }),
  ),
);
it.effect("a failed queued head remains editable without restoring a draft", () =>
  withDb(
    Effect.gen(function* () {
      const publisher = yield* setup;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE threads SET state='running',active_turn_id='current' WHERE id='thread'`;
      yield* sendMessage(publisher, driver, { ...input, draft: largeStructuredDraft });
      const head = (yield* readThreadQueue("thread"))[0]!;
      assert.isFalse("recovery_draft" in head);
      const summary = yield* findThread(ThreadId.makeUnsafe("thread"));
      assert.deepStrictEqual(JSON.parse(summary!.queue), [head]);
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`UPDATE threads SET state='idle',active_turn_id=NULL WHERE id='thread'`;
          const { draft: _draft, ...queuedInput } = input;
          yield* writeSendingMessage({ ...queuedInput, message: head }, "deliver");
        }),
      );
      yield* settleMessage(
        publisher,
        { type: "failed", threadId: "thread", messageId: "message", error: "Queued rejected" },
        at,
      );
      assert.deepStrictEqual(yield* readThreadQueue("thread"), [head]);
      assert.deepStrictEqual(yield* sql`SELECT draft,last_error,state FROM threads`, [
        { draft: null, last_error: "Queued rejected", state: "error" },
      ]);
    }),
  ),
);
it.effect("an agent send without a recovery draft records only the failure", () =>
  withDb(
    Effect.gen(function* () {
      const publisher = yield* setup;
      const { draft: _draft, ...agent } = input;
      yield* sendMessage(publisher, driver, {
        ...agent,
        message: { ...agent.message, dispatchOrigin: "agent" },
      });
      yield* settleMessage(
        publisher,
        { type: "failed", threadId: "thread", messageId: "message", error: "Agent rejected" },
        at,
      );
      const sql = yield* SqlClient.SqlClient;
      assert.deepStrictEqual(yield* sql`SELECT draft,last_error FROM threads`, [
        { draft: input.draft, last_error: "Agent rejected" },
      ]);
    }),
  ),
);

it.effect("stale draft admission preserves a newer draft and failure cannot overwrite it", () =>
  withDb(
    Effect.gen(function* () {
      const publisher = yield* setup;
      const sql = yield* SqlClient.SqlClient;
      const newer = JSON.stringify({ prompt: "Newer edit", attachments: [], files: [] });
      const newerAt = "2026-10-09T00:00:02.000Z";
      yield* sql`UPDATE threads SET draft=${newer},draft_updated_at=${newerAt} WHERE id='thread'`;
      yield* sendMessage(publisher, driver, input);
      let [row] = yield* sql<{
        draft: string;
        draftUpdatedAt: string;
      }>`SELECT draft,draft_updated_at AS "draftUpdatedAt" FROM threads WHERE id='thread'`;
      assert.equal(row!.draft, newer);
      assert.equal(row!.draftUpdatedAt, newerAt);
      yield* settleMessage(
        publisher,
        { type: "failed", threadId: "thread", messageId: "message", error: "Native failure" },
        "2026-10-09T00:00:03.000Z",
      );
      [row] = yield* sql<{
        draft: string;
        draftUpdatedAt: string;
      }>`SELECT draft,draft_updated_at AS "draftUpdatedAt" FROM threads WHERE id='thread'`;
      assert.equal(row!.draft, newer);
      assert.equal(row!.draftUpdatedAt, newerAt);
    }),
  ),
);

it.effect("a queued selection payload beyond the item-data cap stays at the head on failure", () =>
  withDb(
    Effect.gen(function* () {
      const publisher = yield* setup;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE threads SET state='running',active_turn_id='current' WHERE id='thread'`;
      const attachments = Array.from({ length: 17 }, (_, index) => ({
        type: "assistant-selection" as const,
        id: `selection-${index}`,
        assistantMessageId: MessageId.makeUnsafe("assistant"),
        text: "x".repeat(4000),
      }));
      const request = { ...input, message: { ...input.message, attachments } };
      yield* sendMessage(publisher, driver, request);
      const head = (yield* readThreadQueue("thread"))[0]!;
      yield* sql.withTransaction(
        Effect.gen(function* () {
          const { draft: _draft, ...queuedInput } = request;
          yield* writeSendingMessage({ ...queuedInput, message: head }, "deliver");
          yield* sql`UPDATE threads SET state='idle',active_turn_id=NULL WHERE id='thread'`;
        }),
      );
      yield* settleMessage(
        publisher,
        { type: "failed", threadId: "thread", messageId: "message", error: "Rejected" },
        at,
      );
      assert.deepStrictEqual((yield* readThreadQueue("thread"))[0]!.attachments, attachments);
    }),
  ),
);

for (const plan of ["deliver", "steer", "interrupt-deliver"] as const) {
  it.effect(
    `${plan} retries keep their recorded admission before ack and after sent; failure permits fresh admission`,
    () =>
      withDb(
        Effect.gen(function* () {
          const publisher = yield* setup;
          const sql = yield* SqlClient.SqlClient;
          if (plan !== "deliver")
            yield* sql`UPDATE threads SET state='running',active_turn_id='native' WHERE id='thread'`;
          const request = {
            ...input,
            dispatchMode: plan === "deliver" ? ("queue" as const) : ("steer" as const),
            supportsSteer: plan !== "interrupt-deliver",
          };
          const admission = yield* sendMessage(publisher, driver, request);
          assert.equal(admission.plan, plan);
          assert.deepStrictEqual(yield* sendMessage(publisher, driver, request), admission);
          yield* settleMessage(
            publisher,
            { type: "acknowledged", threadId: "thread", messageId: "message", turnId: "native" },
            at,
          );
          yield* sql`UPDATE threads SET state='idle',active_turn_id=NULL WHERE id='thread'`;
          assert.deepStrictEqual(
            yield* sendMessage(publisher, driver, { ...request, dispatchMode: "queue" }),
            admission,
          );
          const second = {
            ...request,
            message: { ...request.message, messageId: MessageId.makeUnsafe("second") },
          };
          yield* sql`UPDATE threads SET state=${plan === "deliver" ? "idle" : "running"} WHERE id='thread'`;
          yield* sendMessage(publisher, driver, second);
          yield* settleMessage(
            publisher,
            { type: "failed", threadId: "thread", messageId: "second", error: "Rejected" },
            at,
          );
          yield* sql`UPDATE threads SET state='idle',active_turn_id=NULL WHERE id='thread'`;
          const fresh = yield* sendMessage(publisher, driver, { ...second, dispatchMode: "queue" });
          assert.equal(fresh.plan, "deliver");
        }),
      ),
  );
}
