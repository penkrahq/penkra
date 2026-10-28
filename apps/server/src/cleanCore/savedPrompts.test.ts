import { assert, it } from "@effect/vitest";
import {
  MessageId,
  ThreadId,
  SavedRestoreDraftNotEmptyError,
  SavedPromptDraftChangedError,
} from "@penkra/contracts";
import { Effect, Exit } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import { seedThreadFolderFixture } from "./threadFixtures.ts";
import { createThread, setThreadArchived, setThreadDeleted } from "./threadStore.ts";
import { savePrompt, moveIntoDraft, deleteSavedPrompt } from "./savedPrompts.ts";
import { enqueueMessage } from "./threadQueue.ts";
import { findThread } from "./threadList.ts";
import { threadShellFromRow } from "@penkra/shared/threadView";

const threadId = ThreadId.make("saved-thread");
const at = "2026-10-20T12:00:00.000Z";
const input = {
  threadId,
  draftUpdatedAt: at,
  message: {
    messageId: MessageId.make("saved-message"),
    text: "Keep this draft",
    attachments: [],
  },
};
const seed = Effect.gen(function* () {
  yield* runMigrations();
  yield* seedThreadFolderFixture("saved-folder", "saved-space");
  yield* createThread({
    id: threadId,
    folderId: "saved-folder",
    spaceId: "saved-space",
    title: "Saved",
    provider: "codex",
    model: "model",
    runtimeMode: "full-access",
    createdBy: "user",
    createdAt: at,
  });
  const sql = yield* SqlClient.SqlClient;
  yield* sql`UPDATE threads SET draft=${JSON.stringify({ prompt: input.message.text, attachments: [], files: [], assistantSelections: [] })},draft_updated_at=${at} WHERE id=${threadId}`;
  return sql;
});
const withDb = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  effect.pipe(Effect.provide(NodeSqliteClient.layerMemory()));

it.effect("saves once without a provider turn and moves the saved entry into an empty draft", () =>
  withDb(
    Effect.gen(function* () {
      const sql = yield* seed;
      let claims = 0;
      const claim = () =>
        Effect.sync(() => {
          claims++;
        });
      yield* savePrompt(input, claim);
      yield* savePrompt(input, claim);
      const [row] = yield* sql<{
        saved: string;
        draft: string | null;
        count: number;
      }>`SELECT saved,draft,(SELECT count(*) FROM thread_items) AS count FROM threads WHERE id=${threadId}`;
      assert.equal(JSON.parse(row!.saved).length, 1);
      assert.equal(row!.draft, null);
      assert.equal(row!.count, 0);
      assert.equal(claims, 1);
      const shell = threadShellFromRow((yield* findThread(threadId))!);
      assert.notProperty(shell, "saved");
      assert.notInclude(JSON.stringify(shell), input.message.text);
      const restored = yield* moveIntoDraft("saved", {
        ...input,
        messageId: input.message.messageId,
        updatedAt: at,
      });
      assert.isTrue(restored.removed);
      const [next] = yield* sql<{
        saved: string;
        draft: string;
      }>`SELECT saved,draft FROM threads WHERE id=${threadId}`;
      assert.deepEqual(JSON.parse(next!.saved), []);
      assert.equal(JSON.parse(next!.draft).prompt, input.message.text);
    }),
  ),
);

it.effect("restores attachment IDs and assistant selections without making transcript rows", () =>
  withDb(
    Effect.gen(function* () {
      const sql = yield* seed;
      const attachments = [
        {
          id: "image",
          type: "image" as const,
          name: "image.png",
          mimeType: "image/png",
          sizeBytes: 10,
        },
        {
          id: "file",
          type: "file" as const,
          name: "notes.txt",
          mimeType: "text/plain",
          sizeBytes: 10,
        },
        {
          id: "selection",
          type: "assistant-selection" as const,
          assistantMessageId: MessageId.make("assistant"),
          text: "selected text",
        },
      ];
      const skills = [{ name: "drawing", path: "/skills/drawing/SKILL.md" }];
      const mentions = [{ name: "notes", path: "/notes.md" }];
      yield* savePrompt(
        { ...input, message: { ...input.message, attachments, skills, mentions } },
        () => Effect.void,
      );
      yield* moveIntoDraft("saved", {
        ...input,
        messageId: input.message.messageId,
        updatedAt: at,
      });
      const [row] = yield* sql<{ draft: string }>`SELECT draft FROM threads WHERE id=${threadId}`;
      const draft = JSON.parse(row!.draft);
      assert.deepEqual(
        draft.attachments.map((entry: { id: string }) => entry.id),
        ["image"],
      );
      assert.deepEqual(
        draft.files.map((entry: { id: string }) => entry.id),
        ["file"],
      );
      assert.deepEqual(draft.assistantSelections, [attachments[2]]);
      assert.deepEqual(draft.skills, skills);
      assert.deepEqual(draft.mentions, mentions);
    }),
  ),
);

it.effect("rejects stale saves and failed attachment claims without clearing the draft", () =>
  withDb(
    Effect.gen(function* () {
      const sql = yield* seed;
      const stale = yield* Effect.flip(
        savePrompt({ ...input, draftUpdatedAt: null }, () => Effect.void),
      );
      assert.instanceOf(stale, SavedPromptDraftChangedError);
      assert.isTrue(
        Exit.isFailure(
          yield* Effect.exit(savePrompt(input, () => Effect.fail(new Error("claim rejected")))),
        ),
      );
      const [row] = yield* sql<{
        saved: string;
        draft: string;
      }>`SELECT saved,draft FROM threads WHERE id=${threadId}`;
      assert.deepEqual(JSON.parse(row!.saved), []);
      assert.equal(JSON.parse(row!.draft).prompt, input.message.text);
    }),
  ),
);

it.effect("does not replace nonempty drafts, including assistant-only drafts", () =>
  withDb(
    Effect.gen(function* () {
      const sql = yield* seed;
      yield* savePrompt(input, () => Effect.void);
      yield* sql`UPDATE threads SET draft=${JSON.stringify({ prompt: "", attachments: [], files: [], assistantSelections: [{ id: "selection" }] })} WHERE id=${threadId}`;
      const error = yield* Effect.flip(
        moveIntoDraft("saved", { ...input, messageId: input.message.messageId, updatedAt: at }),
      );
      assert.instanceOf(error, SavedRestoreDraftNotEmptyError);
      const [row] = yield* sql<{ saved: string }>`SELECT saved FROM threads WHERE id=${threadId}`;
      assert.equal(JSON.parse(row!.saved).length, 1);
      yield* deleteSavedPrompt({ ...input, messageId: input.message.messageId });
      const [next] = yield* sql<{ saved: string }>`SELECT saved FROM threads WHERE id=${threadId}`;
      assert.deepEqual(JSON.parse(next!.saved), []);
    }),
  ),
);

it.effect("queue edit uses the same draft move and preserves the remaining queue", () =>
  withDb(
    Effect.gen(function* () {
      const sql = yield* seed;
      yield* sql`UPDATE threads SET draft=NULL WHERE id=${threadId}`;
      yield* enqueueMessage(threadId, { ...input.message, origin: { _tag: "user" }, queuedAt: at });
      yield* enqueueMessage(threadId, {
        ...input.message,
        messageId: MessageId.make("next"),
        origin: { _tag: "user" },
        queuedAt: at,
      });
      assert.isTrue(
        (yield* moveIntoDraft("queue", {
          ...input,
          messageId: input.message.messageId,
          updatedAt: at,
        })).wasHead,
      );
      const [row] = yield* sql<{
        queue: string;
        draft: string;
      }>`SELECT queue,draft FROM threads WHERE id=${threadId}`;
      assert.deepEqual(
        JSON.parse(row!.queue).map((entry: { messageId: string }) => entry.messageId),
        ["next"],
      );
      assert.equal(JSON.parse(row!.draft).prompt, input.message.text);
    }),
  ),
);

it.effect("archiving retains saved prompts and deleting the thread removes them", () =>
  withDb(
    Effect.gen(function* () {
      const sql = yield* seed;
      yield* savePrompt(input, () => Effect.void);
      yield* setThreadArchived(threadId, at, at, null);
      const [archived] = yield* sql<{
        saved: string;
      }>`SELECT saved FROM threads WHERE id=${threadId}`;
      assert.equal(JSON.parse(archived!.saved).length, 1);
      yield* setThreadDeleted(threadId, at, at);
      const [deleted] = yield* sql<{
        saved: string;
      }>`SELECT saved FROM threads WHERE id=${threadId}`;
      assert.deepEqual(JSON.parse(deleted!.saved), []);
      assert.isTrue(
        Exit.isFailure(
          yield* Effect.exit(
            moveIntoDraft("saved", {
              threadId,
              messageId: input.message.messageId,
              updatedAt: at,
            }),
          ),
        ),
      );
    }),
  ),
);
