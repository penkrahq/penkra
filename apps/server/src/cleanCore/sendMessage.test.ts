import { observePublisher } from "./threadPublisherTestHelpers.ts";
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
import {
  sendMessage as admitMessage,
  settleMessage,
  writeSendingMessage,
  deliverMessage,
  type SendDriver,
} from "./sendMessage";
import { seedThreadFolderFixture } from "./threadFixtures";
import { listThreadItemsPage } from "./threadItemsPage.ts";
import { findThread } from "./threadList.ts";
import { findThreadPolicyError } from "./threadErrors.ts";
import { readThreadQueue } from "./threadQueue.ts";
import { createThread, makeThreadPublisher } from "./threadStore";

const at = "2026-10-09T00:00:01.000Z";
const sendMessage = (...args: Parameters<typeof admitMessage>) =>
  admitMessage(...args).pipe(Effect.map((result) => result.admission));
const input = {
  threadId: "thread",
  draftUpdatedAt: at,
  message: {
    messageId: MessageId.makeUnsafe("message"),
    text: "Original text",
    attachments: [],
    origin: { _tag: "user" as const },
    queuedAt: at,
  },
  dispatchMode: "queue" as const,
  supportsSteer: true,
};
const driver: SendDriver = {
  isRunning: () => Effect.succeed(false),
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
const withDb = <A, E>(
  program: Effect.Effect<A, E, SqlClient.SqlClient | import("effect/Scope").Scope>,
) => program.pipe(Effect.provide(NodeSqliteClient.layerMemory()));

for (const [name, text, attachmentCount, selectionSize, code] of [
  ["text limit", "x".repeat(120_001), 0, 0, "message_too_large"],
  ["attachment limit", "prompt", 9, 1, "message_too_large"],
  ["selection schema limit", "prompt", 8, 9_000, "invalid_message_metadata"],
  ["metadata limit", "prompt", 0, 0, "message_metadata_too_large"],
] as const) {
  it.effect(`rejects a message beyond the ${name} without accepting or queuing it`, () =>
    withDb(
      Effect.gen(function* () {
        const publisher = yield* setup;
        const sql = yield* SqlClient.SqlClient;
        const attachments = Array.from({ length: attachmentCount }, (_, index) => ({
          type: "assistant-selection" as const,
          id: `selection-${index}`,
          assistantMessageId: MessageId.makeUnsafe("assistant"),
          text: "x".repeat(selectionSize),
        }));
        const failure = yield* sendMessage(publisher, driver, {
          ...input,
          message: { ...input.message, text, attachments },
          ...(code === "message_metadata_too_large"
            ? { skills: [{ name: "skill", path: "x".repeat(65_536) }] }
            : {}),
        }).pipe(Effect.flip);
        assert.equal(findThreadPolicyError(failure)?.code, code);
        assert.deepStrictEqual(yield* readThreadQueue("thread"), []);
        assert.lengthOf(yield* sql`SELECT source_id FROM thread_items WHERE kind='user'`, 0);
      }),
    ),
  );
}
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
it.effect(
  "native failure keeps a failed row and records last_error without touching the composer",
  () =>
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
        assert.deepStrictEqual(yield* sql`SELECT status FROM thread_items WHERE kind='user'`, [
          { status: "failed" },
        ]);
        const [thread] = yield* sql<{
          draft: string;
          lastError: string;
        }>`SELECT draft,last_error AS "lastError" FROM threads`;
        assert.equal(thread!.draft, null);
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
      yield* observePublisher(publisher.threadChanges, (change) => changes.push(change));
      yield* sql`CREATE TEMP TRIGGER reject_draft_clear BEFORE UPDATE OF draft ON threads BEGIN SELECT RAISE(ABORT,'injected clear failure'); END`;
      assert.isTrue(Exit.isFailure(yield* Effect.exit(sendMessage(publisher, driver, input))));
      assert.deepStrictEqual(yield* sql`SELECT * FROM thread_items`, []);
      assert.deepStrictEqual(changes, []);
    }),
  ),
);
it.effect("restart before native ack retains the failed row and its complete payload", () =>
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
        assert.deepStrictEqual(yield* sql`SELECT status FROM thread_items WHERE kind='user'`, [
          { status: "failed" },
        ]);
        const [thread] = yield* sql<{ draft: string; lastError: string }>`
          SELECT draft,last_error AS "lastError" FROM threads`;
        assert.equal(thread!.draft, null);
        assert.equal(thread!.lastError, PROVIDER_CUTOFF_NOTICE);
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename })));
    }),
  ),
);
it.effect("clears private send payload when the native send is acknowledged", () =>
  withDb(
    Effect.gen(function* () {
      const publisher = yield* setup;
      yield* sendMessage(publisher, driver, input);
      yield* settleMessage(
        publisher,
        { type: "acknowledged", threadId: "thread", messageId: "message", turnId: "native" },
        at,
      );
      const sql = yield* SqlClient.SqlClient;
      assert.deepStrictEqual(
        yield* sql`SELECT status,send_payload FROM thread_items WHERE kind='user'`,
        [{ status: "sent", send_payload: null }],
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
      yield* sendMessage(publisher, driver, input);
      const head = (yield* readThreadQueue("thread"))[0]!;
      assert.isFalse("send_payload" in head);
      const summary = yield* findThread(ThreadId.makeUnsafe("thread"));
      assert.deepStrictEqual(JSON.parse(summary!.queue), [head]);
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`UPDATE threads SET state='idle',active_turn_id=NULL WHERE id='thread'`;
          const queuedInput = input;
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
it.effect("an agent send retains its failed row without changing the composer", () =>
  withDb(
    Effect.gen(function* () {
      const publisher = yield* setup;
      const { draftUpdatedAt: _sentAt, ...agent } = input;
      yield* sendMessage(publisher, driver, {
        ...agent,
        message: {
          ...agent.message,
          origin: { _tag: "agent", senderThreadId: ThreadId.makeUnsafe("agent-sender") },
        },
      });
      yield* settleMessage(
        publisher,
        { type: "failed", threadId: "thread", messageId: "message", error: "Agent rejected" },
        at,
      );
      const sql = yield* SqlClient.SqlClient;
      assert.deepStrictEqual(yield* sql`SELECT draft,last_error FROM threads`, [
        {
          draft: JSON.stringify({ prompt: input.message.text, attachments: [], files: [] }),
          last_error: "Agent rejected",
        },
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

it.effect("a queued selection payload within admission limits stays at the head on failure", () =>
  withDb(
    Effect.gen(function* () {
      const publisher = yield* setup;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE threads SET state='running',active_turn_id='current' WHERE id='thread'`;
      const attachments = Array.from({ length: 8 }, (_, index) => ({
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
          const queuedInput = request;
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
    `${plan} retries keep their recorded admission before ack, after sent and after failure remain recorded admissions`,
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
          assert.deepStrictEqual(fresh, yield* sendMessage(publisher, driver, second));
          assert.equal(
            (yield* sql<{
              status: string;
            }>`SELECT status FROM thread_items WHERE source_id='second'`)[0]!.status,
            "failed",
          );
        }),
      ),
  );
}

it.effect("a rejected admitted user row remains failed without touching newer composer text", () =>
  withDb(
    Effect.gen(function* () {
      const publisher = yield* setup;
      const sql = yield* SqlClient.SqlClient;
      yield* sendMessage(publisher, driver, input);
      yield* sql`UPDATE threads SET draft='{"prompt":"new text","attachments":[],"files":[]}' WHERE id='thread'`;
      yield* settleMessage(
        publisher,
        { type: "failed", threadId: "thread", messageId: "message", error: "Rejected" },
        at,
      );
      assert.deepStrictEqual(yield* sql`SELECT text,status FROM thread_items WHERE kind='user'`, [
        { text: "Original text", status: "failed" },
      ]);
      assert.equal(
        (yield* sql<{ draft: string }>`SELECT draft FROM threads`)[0]!.draft,
        '{"prompt":"new text","attachments":[],"files":[]}',
      );
    }),
  ),
);

for (const succeeds of [true, false]) {
  it.effect(
    `one user send combines all failed inputs in order and ${succeeds ? "acknowledges" : "fails"} the cohort atomically`,
    () =>
      withDb(
        Effect.gen(function* () {
          const publisher = yield* setup;
          const sql = yield* SqlClient.SqlClient;
          yield* sendMessage(publisher, driver, input);
          yield* settleMessage(
            publisher,
            { type: "failed", threadId: "thread", messageId: "message", error: "first failed" },
            at,
          );
          const next = {
            ...input,
            message: {
              ...input.message,
              messageId: MessageId.makeUnsafe("next"),
              text: "New text",
            },
          };
          yield* sendMessage(publisher, driver, next);
          const observed: string[] = [];
          yield* deliverMessage(
            publisher,
            {
              isRunning: () => Effect.succeed(false),
              claimAttachments: () => Effect.void,
              dispatch: (sent) =>
                Effect.gen(function* () {
                  observed.push(sent.message.text);
                  if (!succeeds) return yield* Effect.fail(new Error("combined failed"));
                  yield* settleMessage(
                    publisher,
                    {
                      type: "acknowledged",
                      threadId: "thread",
                      messageId: "next",
                      turnId: "native",
                    },
                    at,
                  );
                }).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
            },
            next,
            "deliver",
          );
          assert.deepStrictEqual(observed, ["Original text\n\nNew text"]);
          const rows = yield* sql<{
            source_id: string;
            status: string;
            send_payload: string | null;
          }>`SELECT source_id,status,send_payload FROM thread_items WHERE kind='user' ORDER BY seq`;
          assert.deepStrictEqual(
            rows.map((row) => [row.source_id, row.status]),
            [
              ["message", succeeds ? "sent" : "failed"],
              ["next", succeeds ? "sent" : "failed"],
            ],
          );
          assert.isTrue(
            rows.every((row) => (succeeds ? row.send_payload === null : row.send_payload !== null)),
          );
          assert.equal(
            (yield* sql<{ draft: string | null }>`SELECT draft FROM threads`)[0]!.draft,
            null,
          );
        }),
      ),
  );
}

it.effect("retains a full admitted payload privately while item reads show display only", () =>
  withDb(
    Effect.gen(function* () {
      const publisher = yield* setup;
      const sql = yield* SqlClient.SqlClient;
      const large = "original".repeat(14_000);
      const request = { ...input, message: { ...input.message, text: large } };
      yield* sendMessage(publisher, driver, request);
      yield* settleMessage(
        publisher,
        { type: "failed", threadId: "thread", messageId: "message", error: "refused" },
        at,
      );
      const [row] = yield* sql<{
        send_payload: string;
      }>`SELECT send_payload FROM thread_items WHERE source_id='message'`;
      assert.equal(JSON.parse(row!.send_payload).message.text, large);
      const page = yield* listThreadItemsPage({ threadId: ThreadId.makeUnsafe("thread") });
      assert.isFalse("send_payload" in page.items[0]!);
      assert.isFalse("admission_plan" in page.items[0]!);
    }),
  ),
);

it.effect("startup fails every member of a pending cohort and keeps each payload", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const directory = yield* Effect.acquireRelease(
        Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "penkra-failed-cohort-"))),
        (directory) => Effect.promise(() => fs.rm(directory, { recursive: true, force: true })),
      );
      const filename = path.join(directory, "state.sqlite");
      yield* Effect.gen(function* () {
        const publisher = yield* setup;
        yield* sendMessage(publisher, driver, input);
        yield* settleMessage(
          publisher,
          { type: "failed", threadId: "thread", messageId: "message", error: "rejected" },
          at,
        );
        yield* sendMessage(publisher, driver, {
          ...input,
          message: { ...input.message, messageId: MessageId.makeUnsafe("next"), text: "Next" },
        });
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename })));
      yield* Effect.gen(function* () {
        yield* settleRunningThreadsOnStartup(makeThreadPublisher(), at);
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql<{
          source_id: string;
          status: string;
          send_payload: string;
        }>`SELECT source_id,status,send_payload FROM thread_items WHERE kind='user' ORDER BY seq`;
        assert.deepStrictEqual(
          rows.map((row) => [row.source_id, row.status]),
          [
            ["message", "failed"],
            ["next", "failed"],
          ],
        );
        assert.deepStrictEqual(
          rows.map((row) => JSON.parse(row.send_payload).message.text),
          ["Original text", "Next"],
        );
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename })));
    }),
  ),
);

it.effect(
  "a background dispatch defect settles the admitted user row instead of leaving sending",
  () =>
    withDb(
      Effect.gen(function* () {
        const publisher = yield* setup;
        yield* sendMessage(publisher, driver, input);
        yield* Effect.exit(
          deliverMessage(
            publisher,
            {
              ...driver,
              dispatch: () => Effect.die(new Error("dispatch initialization broke")),
            },
            input,
            "deliver",
          ),
        );
        const sql = yield* SqlClient.SqlClient;
        assert.deepStrictEqual(yield* sql`SELECT status FROM thread_items WHERE kind='user'`, [
          { status: "failed" },
        ]);
      }),
    ),
);

it.effect("shutdown interruption leaves admission for startup settlement", () =>
  withDb(
    Effect.gen(function* () {
      const publisher = yield* setup;
      yield* sendMessage(publisher, driver, input);
      const exit = yield* Effect.exit(
        deliverMessage(
          publisher,
          {
            ...driver,
            dispatch: () => Effect.interrupt,
          },
          input,
          "deliver",
        ),
      );
      assert.isTrue(Exit.isFailure(exit));
      if (Exit.isFailure(exit)) assert.isTrue(Cause.hasInterruptsOnly(exit.cause));
      const sql = yield* SqlClient.SqlClient;
      assert.deepStrictEqual(yield* sql`SELECT status FROM thread_items WHERE kind='user'`, [
        { status: "sending" },
      ]);
      yield* settleRunningThreadsOnStartup(publisher, at);
      assert.deepStrictEqual(yield* sql`SELECT status FROM thread_items WHERE kind='user'`, [
        { status: "failed" },
      ]);
    }),
  ),
);
