// FILE: resumeThread.ts
// Purpose: Continue a thread whose turn did not finish, with the hidden recovery
// prompt on the thread's own provider, model and account. Used by the Continue
// control and, at startup, for every thread a Penkra restart cut off.
// Layer: Clean core

import { randomUUID } from "node:crypto";

import { MessageId, ModelSelection, type RuntimeMode, ThreadId } from "@penkra/contracts";
import { Effect, Schema } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

import { PLAY_TURN_RECOVERY_PROMPT } from "./sendMessage.ts";
import { findThread } from "./threadList.ts";
import { ThreadSender } from "./ThreadSender.ts";

export const resumeThread = (input: {
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly updatedAt: string;
  readonly runtimeMode?: RuntimeMode;
}) =>
  Effect.gen(function* () {
    const row = yield* findThread(input.threadId);
    if (row === null) return yield* Effect.fail(new Error("The thread does not exist."));
    const sender = yield* ThreadSender;
    return yield* sender.send({
      threadId: input.threadId,
      message: {
        messageId: input.messageId,
        text: PLAY_TURN_RECOVERY_PROMPT,
        attachments: [],
        origin: { _tag: "recovery" as const },
        queuedAt: input.updatedAt,
      },
      dispatchMode: "queue",
      modelSelection: Schema.decodeUnknownSync(ModelSelection)({
        provider: row.provider,
        model: row.model,
        ...(row.modelOptions === null ? {} : { options: JSON.parse(row.modelOptions) }),
      }),
      connectionId: row.connectionId,
      ...(input.runtimeMode === undefined ? {} : { runtimeMode: input.runtimeMode }),
    });
  });

/**
 * Whether a thread cut off by a restart should continue on its own: it still
 * exists and isn't archived, and the turn that was cut off was not itself an
 * automatic continuation (a restart during one leaves it for the user, so a
 * crash in the middle of a turn can't loop).
 */
export const shouldResumeAfterRestart = (threadId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const [thread] = yield* sql<{ readonly archivedAt: string | null; readonly deletedAt: string | null }>`
      SELECT archived_at AS "archivedAt", deleted_at AS "deletedAt" FROM threads WHERE id = ${threadId}`;
    if (!thread || thread.archivedAt !== null || thread.deletedAt !== null) return false;
    const [last] = yield* sql<{ readonly origin: string | null }>`
      SELECT json_extract(data, '$.origin._tag') AS origin FROM thread_items
      WHERE thread_id = ${threadId} AND kind = 'user' ORDER BY seq DESC LIMIT 1`;
    return last !== undefined && last.origin !== "recovery";
  });

/**
 * After startup, continue every thread the restart cut off (operator,
 * 2026-11-19: restarting Penkra resumes running threads). One failure is
 * logged and leaves that thread idle with its cut-off notice; the rest go on.
 */
export const resumeThreadsCutOffByRestart = (threadIds: ReadonlyArray<string>) =>
  Effect.forEach(
    threadIds,
    (threadId) =>
      Effect.gen(function* () {
        if (!(yield* shouldResumeAfterRestart(threadId))) {
          yield* Effect.logInfo("thread.restart-resume.skipped", { threadId });
          return;
        }
        yield* resumeThread({
          threadId: ThreadId.make(threadId),
          messageId: MessageId.make(randomUUID()),
          updatedAt: new Date().toISOString(),
        });
        yield* Effect.logInfo("thread.restart-resume.sent", { threadId });
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("thread.restart-resume.failed", { threadId, cause }),
        ),
      ),
    { discard: true },
  );
