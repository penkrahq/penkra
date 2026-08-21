import { CommandId, MessageId, ProviderConnectionId, ThreadId, TurnId } from "@penkra/contracts";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";

export const RESTART_TURN_RECOVERY_PROMPT =
  "The previous turn was interrupted because Penkra stopped. Continue the existing task from the current state. Verify the current state before repeating any action whose outcome may be uncertain.";

interface RestartTurnRecoveryRow {
  readonly threadId: string;
  readonly turnId: string;
  readonly connectionId: string | null;
  readonly bindingRevision: number;
}

/**
 * Starts one invisible continuation for every turn whose durable recovery marker
 * survived the previous server process. The normal turn-start event and provider
 * delivery ledger own dispatch/retry after admission.
 */
export const recoverRestartInterruptedTurns = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const engine = yield* OrchestrationEngineService;
  const recoveries = yield* sql<RestartTurnRecoveryRow>`
    SELECT recovery.thread_id AS "threadId", recovery.turn_id AS "turnId",
           binding.connection_id AS "connectionId",
           binding.binding_revision AS "bindingRevision"
    FROM restart_turn_recoveries AS recovery
    JOIN thread_runtime_bindings AS binding ON binding.thread_id = recovery.thread_id
    ORDER BY recovery.updated_at ASC, recovery.thread_id ASC
  `;
  if (recoveries.length === 0) return;

  const readModel = yield* engine.getCommandReadModel();
  const threadById = new Map(readModel.threads.map((thread) => [thread.id, thread] as const));

  yield* Effect.forEach(
    recoveries,
    (recovery) =>
      Effect.gen(function* () {
        const threadId = ThreadId.makeUnsafe(recovery.threadId);
        const interruptedTurnId = TurnId.makeUnsafe(recovery.turnId);
        const thread = threadById.get(threadId);

        // A natural terminal event removes its marker while the session is still
        // running. During shutdown the session is stopped first, so a later
        // provider failure leaves the marker intact and remains recoverable.
        const discardReason = !thread
          ? "thread-missing"
          : thread.deletedAt !== null
            ? "thread-deleted"
            : thread.latestTurn?.turnId !== interruptedTurnId
              ? "latest-turn-mismatch"
              : thread.latestTurn.state !== "interrupted" && thread.latestTurn.state !== "error"
                ? `latest-turn-${thread.latestTurn.state}`
                : null;
        if (discardReason !== null) {
          yield* Effect.logWarning("discarding invalid restart turn recovery", {
            threadId,
            recoveryTurnId: interruptedTurnId,
            latestTurnId: thread?.latestTurn?.turnId ?? null,
            latestTurnState: thread?.latestTurn?.state ?? null,
            reason: discardReason,
          });
          yield* sql`
            DELETE FROM restart_turn_recoveries
            WHERE thread_id = ${threadId}
          `;
          return;
        }

        const recoveryMessageId = MessageId.makeUnsafe(`restart-recovery:${crypto.randomUUID()}`);
        const commandId = CommandId.makeUnsafe(`restart-recovery:${crypto.randomUUID()}`);
        const turnId = TurnId.makeUnsafe(`turn:${commandId}`);
        const createdAt = new Date().toISOString();
        yield* engine.dispatch({
          type: "thread.turn.recover",
          commandId,
          threadId,
          turnId,
          recoveryMessageId,
          interruptedTurnId,
          connectionId:
            recovery.connectionId === null
              ? null
              : ProviderConnectionId.makeUnsafe(recovery.connectionId),
          bindingRevision: recovery.bindingRevision,
          createdAt,
        });
        yield* Effect.logInfo("started restart turn continuation", {
          threadId,
          interruptedTurnId,
          recoveryTurnId: turnId,
          connectionId: recovery.connectionId,
          bindingRevision: recovery.bindingRevision,
        });
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("failed to start restart continuation", {
            threadId: recovery.threadId,
            turnId: recovery.turnId,
            cause,
          }),
        ),
      ),
    { concurrency: 1, discard: true },
  );
});
