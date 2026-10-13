import { assert, it } from "@effect/vitest";
import { PROVIDER_SEND_TURN_MAX_INPUT_CHARS, ThreadId, TurnId } from "@penkra/contracts";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import { buildReconstructedTurnInput } from "./reconstructedTurnInput.ts";
import { seedThreadFolderFixture } from "./threadFixtures.ts";
import { createThread, upsertThreadItem, type ThreadItemInput } from "./threadStore.ts";

const threadId = ThreadId.makeUnsafe("thread");
const at = "2026-10-11T00:00:00.000Z";
const input = {
  threadId,
  provider: "claudeAgent" as const,
  currentMessageId: "current",
  currentInput: "Continue",
};
const setup = Effect.gen(function* () {
  yield* runMigrations();
  yield* seedThreadFolderFixture("folder", "space");
  yield* createThread({
    id: threadId,
    folderId: "folder",
    spaceId: "space",
    title: "Thread",
    provider: "claudeAgent",
    model: "claude-sonnet-5",
    runtimeMode: "full-access",
    createdBy: "user",
    createdAt: at,
  });
});
const item = (
  sourceId: string,
  kind: ThreadItemInput["kind"],
  text: string,
  turnId: string | null = null,
) =>
  upsertThreadItem({
    threadId,
    sourceId,
    turnId,
    kind,
    status: kind === "user" ? "sent" : "done",
    text,
    data: null,
    createdAt: at,
    updatedAt: at,
  });
const withDb = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  setup.pipe(Effect.andThen(effect), Effect.provide(NodeSqliteClient.layerMemory()));
const transcript = (result: string | null) => {
  assert.isNotNull(result);
  const start =
    result!.indexOf("<penkra-reconstructed-continuation>\n\n") +
    "<penkra-reconstructed-continuation>\n\n".length;
  const end = result!.indexOf("\n\n</penkra-reconstructed-continuation>");
  return JSON.parse(result!.slice(start, end)) as {
    boundary: unknown;
    messages: Array<{ messageId: string; text: string }>;
  };
};

it.effect(
  "reconstructs all retained messages across item pages in seq order, excluding the current message",
  () =>
    withDb(
      Effect.gen(function* () {
        for (let index = 0; index < 61; index++) {
          yield* item(`message-${index}`, index % 2 === 0 ? "user" : "text", `Exact text ${index}`);
        }
        yield* item("current", "user", "Current request already stored");
        for (const [sourceId, status, text] of [
          ["failed-member", "failed", "Failed input admitted once"],
          ["sending-member", "sending", "Pending input admitted once"],
        ] as const) {
          yield* upsertThreadItem({
            threadId,
            sourceId,
            kind: "user",
            status,
            text,
            admissionPlan: "deliver",
            sendPayload: JSON.stringify({
              message: {
                messageId: sourceId,
                text,
                attachments: [],
                origin: { _tag: "user" as const },
                queuedAt: at,
              },
              deliveryMessageId: sourceId,
              batchMessageIds: [sourceId],
            }),
            createdAt: at,
            updatedAt: at,
          });
        }
        const result = yield* buildReconstructedTurnInput({
          ...input,
          currentInput: "Failed input admitted once\nPending input admitted once\nContinue",
        });
        const retained = transcript(result);
        assert.deepStrictEqual(retained.boundary, { kind: "thread-start" });
        assert.deepStrictEqual(
          retained.messages.map((message) => message.messageId),
          Array.from({ length: 61 }, (_, index) => `message-${index}`),
        );
        assert.equal(retained.messages[0]!.text, "Exact text 0");
        assert.notInclude(result!, "Current request already stored");
        assert.include(result!, "penkra threads read --thread-id thread");
        assert.equal(result!.split("Failed input admitted once").length - 1, 1);
        assert.equal(result!.split("Pending input admitted once").length - 1, 1);
      }),
    ),
);

it.effect("stops at the latest canonical compaction across pages and excludes its turn", () =>
  withDb(
    Effect.gen(function* () {
      yield* item("older", "user", "Excluded history");
      yield* upsertThreadItem({
        threadId,
        sourceId: "compaction",
        turnId: TurnId.makeUnsafe("compacted-turn"),
        kind: "notice",
        status: "done",
        text: "Context compacted",
        data: JSON.stringify({
          kind: "context-compaction",
          tone: "info",
          summary: "Context compacted",
          payload: {},
        }),
        createdAt: at,
        updatedAt: at,
      });
      yield* item("same-turn", "text", "Excluded compaction turn", "compacted-turn");
      for (let index = 0; index < 51; index++)
        yield* item(`retained-${index}`, "text", `Retained ${index}`);
      yield* item("tool", "tool", "Tool output is not a conversation message");
      const result = yield* buildReconstructedTurnInput(input);
      const retained = transcript(result);
      assert.deepStrictEqual(retained.boundary, {
        kind: "compaction",
        activityId: "compaction",
        turnId: "compacted-turn",
      });
      assert.equal(retained.messages.length, 51);
      assert.equal(retained.messages[0]!.messageId, "retained-0");
      assert.notInclude(result!, "Excluded history");
      assert.notInclude(result!, "Excluded compaction turn");
      assert.notInclude(result!, "Tool output is not a conversation message");
    }),
  ),
);

it.effect("does not reconstruct an empty conversation or a current message alone", () =>
  withDb(
    Effect.gen(function* () {
      assert.isNull(yield* buildReconstructedTurnInput(input));
      yield* item("current", "user", "Continue");
      assert.isNull(yield* buildReconstructedTurnInput(input));
    }),
  ),
);

it.effect("refuses oversized retained history instead of trimming it", () =>
  withDb(
    Effect.gen(function* () {
      yield* item("oversized", "text", "a".repeat(PROVIDER_SEND_TURN_MAX_INPUT_CHARS));
      const error = yield* Effect.flip(buildReconstructedTurnInput(input));
      assert.equal(error._tag, "ProviderAdapterValidationError");
      if (error._tag === "ProviderAdapterValidationError") {
        assert.equal(error.operation, "thread.turn.reconstruct");
        assert.include(error.issue, "Penkra did not trim or discard it.");
      }
    }),
  ),
);
