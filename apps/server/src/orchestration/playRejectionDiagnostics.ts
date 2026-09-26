import type {
  OrchestrationCommand,
  OrchestrationThread,
  ThreadRuntimeBinding,
} from "@penkra/contracts";
import { canContinueLatestTurn } from "@penkra/shared/turnContinuation";

type PlayCommand = Extract<OrchestrationCommand, { type: "thread.turn.recover" }>;
type Binding = Pick<ThreadRuntimeBinding, "connectionId" | "revision" | "modelId">;

/** Describe a rejected Play using fresh server state; keep IDs, never credentials or prompts. */
export function describeRejectedPlay(
  command: PlayCommand,
  thread: OrchestrationThread | null,
  binding: Binding | null,
) {
  const expectedTurnId = thread?.latestTurn?.turnId ?? null;
  const expectedConnectionId = binding?.connectionId ?? null;
  const expectedBindingRevision = binding?.revision ?? null;
  const receivedTurnId = command.interruptedTurnId ?? command.turnId;
  const check =
    thread === null || thread.deletedAt != null
      ? "thread_missing_or_deleted"
      : thread.archivedAt != null
        ? "thread_archived"
        : command.interruptedTurnId === undefined ||
            command.turnId !== command.interruptedTurnId ||
            expectedTurnId !== receivedTurnId
          ? "turn_id_mismatch"
          : !canContinueLatestTurn(thread, receivedTurnId)
            ? "thread_not_continuable"
            : binding?.modelId == null ||
                binding.connectionId !== command.connectionId ||
                binding.revision !== command.bindingRevision
              ? "binding_mismatch"
              : "state_changed_during_rejection";
  return {
    playCheck: check,
    expectedTurnId,
    receivedTurnId,
    receivedCommandTurnId: command.turnId,
    expectedConnectionId,
    receivedConnectionId: command.connectionId,
    expectedBindingRevision,
    receivedBindingRevision: command.bindingRevision,
    latestTurnState: thread?.latestTurn?.state ?? null,
    sessionStatus: thread?.session?.status ?? null,
    queuedMessageCount: thread?.queuedMessageIds?.length ?? 0,
    pendingInteractionCount:
      thread?.pendingInteractions?.filter((interaction) => interaction.resolvedAt === null)
        .length ?? 0,
  };
}
