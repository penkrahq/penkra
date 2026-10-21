// Operator-only drafts. These operations never dispatch provider work.
import {
  CleanCoreSavedPrompt,
  CleanCoreQueuedMessage,
  QueuedEditDraftNotEmptyError,
  SavedRestoreDraftNotEmptyError,
  QUEUED_MESSAGE_EDIT_NONEMPTY_DRAFT_ERROR,
  SAVED_PROMPT_RESTORE_NONEMPTY_DRAFT_ERROR,
  type CleanCoreSavePromptInput,
  type ThreadId,
} from "@penkra/contracts";
import { Effect, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { nextCommittedDraftTimestamp } from "./threadDraftTimestamp.ts";
import { encodeUserItemAdmission } from "./userItemAdmission.ts";
import { draftAfterSend } from "./threadDraft.ts";
import type { SendDriver } from "./sendMessage.ts";

const decodeSaved = Schema.decodeUnknownSync(Schema.Array(CleanCoreSavedPrompt));
const decodeQueue = Schema.decodeUnknownSync(Schema.Array(CleanCoreQueuedMessage));
const decodeContent = Schema.decodeUnknownSync(
  Schema.Struct({
    prompt: Schema.String,
    attachments: Schema.Array(Schema.Unknown),
    files: Schema.Array(Schema.Unknown),
    assistantSelections: Schema.optionalKey(Schema.Array(Schema.Unknown)),
  }),
);

export const savePrompt = (
  input: CleanCoreSavePromptInput,
  claim: SendDriver["claimAttachments"],
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const [row] = yield* sql<{
          saved: string;
          draft: string | null;
          draftUpdatedAt: string | null;
          provider: string;
        }>`
        SELECT saved,draft,draft_updated_at AS "draftUpdatedAt",provider FROM threads
        WHERE id=${input.threadId} AND deleted_at IS NULL`;
        if (!row) return yield* Effect.fail(new Error("The thread does not exist."));
        const saved = decodeSaved(JSON.parse(row.saved));
        if (saved.some((entry) => entry.messageId === input.message.messageId))
          return { threadId: input.threadId, messageId: input.message.messageId, removed: false };
        if (row.draftUpdatedAt !== input.draftUpdatedAt)
          return yield* Effect.fail(new Error("The draft changed. Try again."));
        if (!input.message.text.trim() && !input.message.attachments.length)
          return yield* Effect.fail(new Error("Nothing to save."));
        const now = new Date().toISOString();
        const message = { ...input.message, origin: { _tag: "user" as const }, queuedAt: now };
        const admission = { ...input, message, skills: message.skills, mentions: message.mentions };
        yield* encodeUserItemAdmission(admission, false);
        yield* claim({ ...admission, dispatchMode: "queue", supportsSteer: false });
        const next = [...saved, { ...input.message, savedAt: now }];
        const at = nextCommittedDraftTimestamp(row.draftUpdatedAt, now);
        const draft = draftAfterSend(row.draft, row.provider, undefined);
        yield* sql`UPDATE threads SET saved=${JSON.stringify(next)},draft=${draft},draft_updated_at=${at},updated_at=${at}
        WHERE id=${input.threadId}`;
        return { threadId: input.threadId, messageId: input.message.messageId, removed: true };
      }),
    );
  });

export const moveIntoDraft = (
  source: "queue" | "saved",
  input: { threadId: ThreadId; messageId: string; updatedAt: string },
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const [row] = yield* sql<{
          queue: string;
          saved: string;
          draft: string | null;
          draftUpdatedAt: string | null;
        }>`
      SELECT queue,saved,draft,draft_updated_at AS "draftUpdatedAt" FROM threads
      WHERE id=${input.threadId} AND deleted_at IS NULL`;
        if (!row) return yield* Effect.fail(new Error("The thread does not exist."));
        const messages =
          source === "queue"
            ? decodeQueue(JSON.parse(row.queue))
            : decodeSaved(JSON.parse(row.saved));
        const message = messages.find((entry) => entry.messageId === input.messageId);
        if (!message) return { ...input, removed: false, wasHead: false };
        if (row.draft !== null) {
          const content = decodeContent(JSON.parse(row.draft));
          if (
            content.prompt.length ||
            content.attachments.length ||
            content.files.length ||
            content.assistantSelections?.length
          )
            return yield* Effect.fail(
              source === "queue"
                ? new QueuedEditDraftNotEmptyError({
                    message: QUEUED_MESSAGE_EDIT_NONEMPTY_DRAFT_ERROR,
                  })
                : new SavedRestoreDraftNotEmptyError({
                    message: SAVED_PROMPT_RESTORE_NONEMPTY_DRAFT_ERROR,
                  }),
            );
        }
        const reference = (attachment: { id: string; name: string; mimeType: string }) => ({
          id: attachment.id,
          name: attachment.name,
          mimeType: attachment.mimeType,
        });
        const draft = JSON.stringify({
          ...(row.draft === null ? {} : JSON.parse(row.draft)),
          prompt: message.text,
          attachments: message.attachments.filter((a) => a.type === "image").map(reference),
          files: message.attachments.filter((a) => a.type === "file").map(reference),
          assistantSelections: message.attachments.filter((a) => a.type === "assistant-selection"),
          skills: message.skills ?? [],
          mentions: message.mentions ?? [],
        });
        const remaining = JSON.stringify(
          messages.filter((entry) => entry.messageId !== input.messageId),
        );
        const at = nextCommittedDraftTimestamp(row.draftUpdatedAt, input.updatedAt);
        if (source === "queue")
          yield* sql`UPDATE threads SET queue=${remaining},draft=${draft},draft_updated_at=${at},updated_at=${at} WHERE id=${input.threadId}`;
        else
          yield* sql`UPDATE threads SET saved=${remaining},draft=${draft},draft_updated_at=${at},updated_at=${at} WHERE id=${input.threadId}`;
        return {
          ...input,
          removed: true,
          wasHead: source === "queue" && messages[0]?.messageId === input.messageId,
        };
      }),
    );
  });

export const deleteSavedPrompt = (input: { threadId: ThreadId; messageId: string }) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const [row] = yield* sql<{
          saved: string;
        }>`SELECT saved FROM threads WHERE id=${input.threadId} AND deleted_at IS NULL`;
        if (!row) return yield* Effect.fail(new Error("The thread does not exist."));
        const saved = decodeSaved(JSON.parse(row.saved));
        const remaining = saved.filter((entry) => entry.messageId !== input.messageId);
        if (remaining.length === saved.length) return { ...input, removed: false };
        // Like queue cancellation, claimed bytes remain under the thread's attachment lifecycle.
        yield* sql`UPDATE threads SET saved=${JSON.stringify(remaining)},updated_at=${new Date().toISOString()} WHERE id=${input.threadId}`;
        return { ...input, removed: true };
      }),
    );
  });
