import { CommandId, ThreadId } from "@penkra/contracts";
import { Effect, Option } from "effect";

import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import type {
  AgentGatewayOperationRecord,
  AgentGatewayOperationRepositoryShape,
} from "./Services/AgentGatewayOperationRepository.ts";
import { gatewayIsoNow } from "./creationUtils.ts";
import { parseRecoverableCreationPlan } from "./operationPlan.ts";
import { errorText } from "./toolInput.ts";

/**
 * Compensate durable gateway operations that were interrupted by a server
 * restart. Only operation-owned Penkra threads are compensated.
 */
export function recoverInterruptedAgentGatewayOperations(input: {
  readonly operationRepository: Pick<
    AgentGatewayOperationRepositoryShape,
    "markCompensating" | "recordCompensationFailure" | "fail"
  > & {
    readonly listNonTerminal: () => Effect.Effect<
      ReadonlyArray<Pick<AgentGatewayOperationRecord, "operationId" | "status" | "planJson">>,
      Error
    >;
  };
  readonly creationSource?: "penkra_mcp";
  readonly retainOnMissingThreadProjection?: boolean;
  readonly snapshotQuery: ProjectionSnapshotQueryShape;
  readonly orchestrationEngine: OrchestrationEngineShape;
}) {
  return Effect.gen(function* () {
    const interruptedOperations = yield* input.operationRepository.listNonTerminal().pipe(
      Effect.catch((error) =>
        Effect.logWarning("agent gateway recovery could not list interrupted operations", {
          error: errorText(error),
        }).pipe(Effect.as([])),
      ),
    );
    yield* Effect.forEach(
      interruptedOperations,
      (operation) =>
        Effect.gen(function* () {
          if (operation.status === "reserved") {
            yield* input.operationRepository.fail({
              operationId: operation.operationId,
              errorJson: JSON.stringify({
                code: "server_restarted_before_dispatch",
                message:
                  "Penkra restarted before dispatch began. No orchestration resources were touched.",
              }),
              now: gatewayIsoNow(),
            });
            return;
          }
          yield* input.operationRepository.markCompensating({
            operationId: operation.operationId,
            now: gatewayIsoNow(),
          });
          const plan = parseRecoverableCreationPlan(operation.planJson, operation.operationId);
          const recoveryErrors: string[] = [];
          yield* Effect.forEach(
            [...plan].reverse(),
            (entry) =>
              Effect.gen(function* () {
                const projected = yield* input.snapshotQuery.getThreadShellById(
                  ThreadId.makeUnsafe(entry.ids.threadId),
                );
                if (Option.isSome(projected)) {
                  if (
                    projected.value.creationSource !== (input.creationSource ?? "penkra_mcp") ||
                    projected.value.gatewayOperationId !== operation.operationId
                  ) {
                    return yield* Effect.fail(
                      new Error(
                        `Refusing to delete thread ${entry.ids.threadId}: gateway ownership does not match operation ${operation.operationId}.`,
                      ),
                    );
                  }
                  yield* input.orchestrationEngine.dispatch({
                    type: "thread.delete",
                    commandId: CommandId.makeUnsafe(entry.ids.compensateCommandId),
                    threadId: ThreadId.makeUnsafe(entry.ids.threadId),
                  });
                } else if (input.retainOnMissingThreadProjection) {
                  return yield* Effect.fail(
                    new Error(
                      `Cleanup remains pending for thread ${entry.ids.threadId}: its durable creation may still be awaiting projection.`,
                    ),
                  );
                }
              }).pipe(
                Effect.catch((error) => Effect.sync(() => recoveryErrors.push(errorText(error)))),
              ),
            { discard: true },
          );
          if (recoveryErrors.length > 0) {
            yield* input.operationRepository.recordCompensationFailure({
              operationId: operation.operationId,
              errorJson: JSON.stringify({
                code: "recovery_compensation_failed",
                message:
                  "Penkra could not fully compensate the interrupted operation during startup recovery. The sanitized operation remains retryable and some resources may require manual cleanup; no replacements will be created.",
                errors: recoveryErrors,
              }),
              now: gatewayIsoNow(),
            });
            yield* Effect.logWarning("agent gateway recovery remains incomplete", {
              operationId: operation.operationId,
              errors: recoveryErrors,
            });
            return;
          }
          yield* input.operationRepository.fail({
            operationId: operation.operationId,
            errorJson: JSON.stringify({
              code: "server_restarted",
              message:
                "Penkra restarted before the operation completed. Deterministic operation-owned resources were compensated; no replacements were created.",
              compensatedCount: plan.length,
            }),
            now: gatewayIsoNow(),
          });
        }).pipe(
          Effect.catch((error) =>
            Effect.gen(function* () {
              const detail = errorText(error);
              yield* input.operationRepository
                .recordCompensationFailure({
                  operationId: operation.operationId,
                  errorJson: JSON.stringify({
                    code: "startup_recovery_failed",
                    message:
                      "Penkra could not recover the interrupted operation. The sanitized operation remains retryable and resources may require manual cleanup; no replacements will be created.",
                    error: detail,
                  }),
                  now: gatewayIsoNow(),
                })
                .pipe(
                  Effect.catch((persistenceError) =>
                    Effect.logWarning("agent gateway recovery status could not be persisted", {
                      operationId: operation.operationId,
                      error: errorText(persistenceError),
                    }),
                  ),
                );
              yield* Effect.logWarning("agent gateway recovery failed", {
                operationId: operation.operationId,
                error: detail,
              });
            }),
          ),
        ),
      { concurrency: 1, discard: true },
    );
  });
}
