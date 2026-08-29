/**
 * startupTurnReconciliation - heal restart-orphaned turns at server boot.
 *
 * Provider runtimes (Codex app-server, ACP children, etc.) are purely
 * in-memory: every one of them dies with the server process. A turn only
 * leaves the "running" state when its runtime emits a terminal event, so any
 * turn that was still in flight when the process exited has no surviving runtime
 * to ever complete it. After a restart its persisted projection rows still say
 * `session.status = "running"` / `activeTurnId != null` / `latestTurn = running`,
 * and the UI shows "Working" forever (observed in the wild as multi-hour stuck
 * turns).
 *
 * `projectionPipeline.bootstrap` faithfully replays the event log into the
 * projection tables, so it restores that stale "running" state verbatim — it is
 * not its job to second-guess history. This module runs once, immediately after
 * bootstrap and before the server starts accepting client commands, and emits
 * stale pending-request failure activities plus a terminal
 * `thread.session.set { status: "interrupted", activeTurnId: null }` for each
 * orphaned thread. That reuses the normal event-sourced path: activity handlers
 * resolve dead approval/user-input requests, and the projection's session-set
 * handler closes the newest still-open turn (`finalizeTurnStateFromSessionStatus`
 * → "interrupted", with `completedAt`), so the UI clears blocked composers and
 * spinners instead of hanging.
 *
 * The runtime idle watchdog (ProviderTurnIdleWatchdog) only protects turns started in
 * the *current* process; this is its restart-time counterpart for turns
 * orphaned by a process boundary the watchdog never saw.
 *
 * @module startupTurnReconciliation
 */
import type {
  OrchestrationCommand,
  OrchestrationMessage,
  OrchestrationThreadActivity,
  OrchestrationSession,
  RuntimeMode,
  ThreadId,
  TurnId,
} from "@penkra/contracts";
import { CommandId, EventId } from "@penkra/contracts";
import {
  buildStalePendingRequestFailureDetail,
  derivePendingThreadRequestIds,
  PENDING_INTERACTION_NOT_FOUND_FAILURE_CODE,
  type PendingThreadRequestKind,
} from "@penkra/shared/threadSummary";
import { Effect } from "effect";

import {
  ProjectionPendingInteractionRepository,
  type ProjectionPendingInteraction,
} from "../persistence/Services/ProjectionPendingInteractions.ts";
import { threadHasInFlightTurn } from "./commandInvariants.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";

/** The `thread.session.set` variant of the internal orchestration command union. */
type ThreadSessionSetCommand = Extract<
  OrchestrationCommand,
  { readonly type: "thread.session.set" }
>;
type ThreadActivityAppendCommand = Extract<
  OrchestrationCommand,
  { readonly type: "thread.activity.append" }
>;
type ThreadMessageAssistantCompleteCommand = Extract<
  OrchestrationCommand,
  { readonly type: "thread.message.assistant.complete" }
>;
type RestartReconciliationCommand =
  | ThreadSessionSetCommand
  | ThreadActivityAppendCommand
  | ThreadMessageAssistantCompleteCommand;

/** Minimal persisted thread shape the planner inspects (a superset is fine). */
export interface ReconcilableThread {
  readonly id: ThreadId;
  readonly deletedAt?: string | null;
  readonly runtimeMode: RuntimeMode;
  readonly session: OrchestrationSession | null;
  readonly latestTurn: {
    readonly turnId?: TurnId;
    readonly state: "running" | "interrupted" | "completed" | "error";
  } | null;
  readonly activities?: ReadonlyArray<
    Pick<OrchestrationThreadActivity, "createdAt" | "id" | "kind" | "payload" | "sequence">
  >;
  readonly messages?: ReadonlyArray<
    Pick<OrchestrationMessage, "id" | "role" | "streaming" | "turnId">
  >;
  /** Exact unresolved rows are authoritative when supplied by startup reconciliation. */
  readonly pendingInteractions?: ReadonlyArray<
    Pick<ProjectionPendingInteraction, "interactionKind" | "requestId" | "status">
  >;
  /** Every pending/running projection row, including older rows hidden by latestTurn. */
  readonly openTurnCount?: number;
}

function planStreamingMessageSettlementCommands(input: {
  readonly thread: ReconcilableThread;
  readonly now: string;
}): ReadonlyArray<ThreadMessageAssistantCompleteCommand> {
  return (input.thread.messages ?? [])
    .filter((message) => message.role === "assistant" && message.streaming)
    .map((message) => ({
      type: "thread.message.assistant.complete",
      commandId: CommandId.makeUnsafe(
        `restart-reconcile-streaming-message:${input.thread.id}:${message.id}`,
      ),
      threadId: input.thread.id,
      messageId: message.id,
      ...(message.turnId !== null ? { turnId: message.turnId } : {}),
      createdAt: input.now,
    }));
}

/**
 * True when a thread's persisted state implies a turn that only a now-dead
 * in-process runtime could ever advance. A clean session (idle/ready/interrupted/
 * stopped/error with no active turn and no open turn) is left untouched.
 */
function needsRestartReconciliation(
  thread: Pick<ReconcilableThread, "session" | "latestTurn">,
): boolean {
  return threadHasInFlightTurn(thread) || hasDanglingActiveTurn(thread);
}

/**
 * A session that already reports a terminal status while still naming an active
 * turn is invisible to `threadHasInFlightTurn` (its turn has been settled), but
 * the dangling `activeTurnId` keeps every "is this thread busy?" check true, so
 * the composer stays blocked and Stop stays armed with nothing to stop.
 */
function hasDanglingActiveTurn(
  thread: Pick<ReconcilableThread, "session" | "latestTurn">,
): boolean {
  return thread.session?.activeTurnId != null && !threadHasInFlightTurn(thread);
}

function planStalePendingRequestCommands(input: {
  readonly thread: ReconcilableThread;
  readonly now: string;
}): ReadonlyArray<ThreadActivityAppendCommand> {
  if (input.thread.pendingInteractions !== undefined) {
    return input.thread.pendingInteractions
      .filter((interaction) => interaction.status !== "confirmed")
      .map((interaction) =>
        buildStalePendingRequestCommand({
          threadId: input.thread.id,
          now: input.now,
          requestKind: interaction.interactionKind === "approval" ? "approval" : "user-input",
          requestId: interaction.requestId,
        }),
      );
  }
  const pendingRequestIds = derivePendingThreadRequestIds({
    activities: input.thread.activities ?? [],
  });
  const commands: ThreadActivityAppendCommand[] = [];
  for (const requestId of pendingRequestIds.approvalRequestIds) {
    commands.push(
      buildStalePendingRequestCommand({
        threadId: input.thread.id,
        now: input.now,
        requestKind: "approval",
        requestId,
      }),
    );
  }

  for (const requestId of pendingRequestIds.userInputRequestIds) {
    commands.push(
      buildStalePendingRequestCommand({
        threadId: input.thread.id,
        now: input.now,
        requestKind: "user-input",
        requestId,
      }),
    );
  }

  return commands;
}

function buildStalePendingRequestCommand(input: {
  readonly threadId: ThreadId;
  readonly now: string;
  readonly requestKind: PendingThreadRequestKind;
  readonly requestId: string;
}): ThreadActivityAppendCommand {
  const commandKey = [
    "restart-reconcile",
    input.threadId,
    input.requestKind,
    input.requestId,
    input.now,
  ].join(":");
  const isApproval = input.requestKind === "approval";
  return {
    type: "thread.activity.append",
    commandId: CommandId.makeUnsafe(commandKey),
    threadId: input.threadId,
    activity: {
      id: EventId.makeUnsafe(commandKey),
      tone: "error",
      kind: isApproval ? "provider.approval.respond.failed" : "provider.user-input.respond.failed",
      summary: isApproval
        ? "Provider approval response failed"
        : "Provider user input response failed",
      payload: {
        detail: buildStalePendingRequestFailureDetail(input.requestKind, input.requestId),
        failureCode: PENDING_INTERACTION_NOT_FOUND_FAILURE_CODE,
        requestId: input.requestId,
      },
      turnId: null,
      createdAt: input.now,
    },
    createdAt: input.now,
  };
}

/**
 * Pure planner: maps persisted threads to stale-request resolution commands and
 * terminal `thread.session.set` commands. Extracted from the effectful runner so
 * the reliability-critical selection logic is unit-testable without a database,
 * clock, or engine.
 *
 * `now` is threaded in (rather than read from a clock) so the same inputs always
 * produce the same commands — including a deterministic, per-startup `commandId`
 * that lets the engine's receipt dedup treat a re-run as a no-op.
 */
export function planRestartTurnReconciliation(input: {
  readonly threads: ReadonlyArray<ReconcilableThread>;
  readonly now: string;
}): ReadonlyArray<RestartReconciliationCommand> {
  const commands: RestartReconciliationCommand[] = [];
  for (const thread of input.threads) {
    // Deleted threads are immutable. They can retain historical session state,
    // but startup must neither hydrate their full history nor dispatch commands
    // that the orchestration invariant layer will necessarily reject.
    if (thread.deletedAt != null) continue;

    const openTurnCount = thread.openTurnCount ?? 0;
    const activeTurnAlreadyTerminal =
      openTurnCount === 0 &&
      thread.session?.activeTurnId !== null &&
      thread.session?.activeTurnId !== undefined &&
      thread.latestTurn?.turnId === thread.session.activeTurnId &&
      (thread.latestTurn.state === "completed" || thread.latestTurn.state === "error");
    const hasInFlightTurn =
      !activeTurnAlreadyTerminal && (threadHasInFlightTurn(thread) || openTurnCount > 0);
    // A streaming message cannot have a surviving producer across a process
    // boundary. Plan its settlement independently from current session state so
    // the lightweight session pass may run before detail hydration.
    commands.push(...planStreamingMessageSettlementCommands({ thread, now: input.now }));
    commands.push(...planStalePendingRequestCommands({ thread, now: input.now }));
    if (activeTurnAlreadyTerminal) {
      // A late/replayed running session event must not turn a durably terminal
      // turn back into interrupted work. The turn identity is the causal guard:
      // a new turn may legitimately start while the previous latest turn is
      // terminal, so terminal state only wins when both rows name the same turn.
      commands.push({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe(
          `restart-reconcile-terminal-turn:${thread.id}:${input.now}`,
        ),
        threadId: thread.id,
        session: {
          threadId: thread.id,
          status: thread.latestTurn?.state === "error" ? "error" : "ready",
          providerName: thread.session?.providerName ?? null,
          runtimeMode: thread.session?.runtimeMode ?? thread.runtimeMode,
          activeTurnId: null,
          lastError:
            thread.latestTurn?.state === "error"
              ? (thread.session?.lastError ?? "Turn failed")
              : null,
          updatedAt: input.now,
        },
        createdAt: input.now,
      });
      continue;
    }
    if (!hasInFlightTurn) {
      if (!hasDanglingActiveTurn(thread)) {
        continue;
      }
      // Preserve the terminal status (and its banner) - only the stale active
      // turn pointer is wrong here.
      commands.push({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe(`restart-reconcile-active-turn:${thread.id}:${input.now}`),
        threadId: thread.id,
        session: {
          threadId: thread.id,
          status: thread.session?.status ?? "interrupted",
          providerName: thread.session?.providerName ?? null,
          runtimeMode: thread.session?.runtimeMode ?? thread.runtimeMode,
          activeTurnId: null,
          lastError: thread.session?.lastError ?? null,
          updatedAt: input.now,
        },
        createdAt: input.now,
      });
      continue;
    }
    const settlementPasses = Math.max(1, openTurnCount);
    for (let pass = 0; pass < settlementPasses; pass += 1) {
      const baseCommandId = `restart-reconcile:${thread.id}:${input.now}`;
      commands.push({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe(
          settlementPasses === 1 ? baseCommandId : `${baseCommandId}:open-turn:${pass + 1}`,
        ),
        threadId: thread.id,
        session: {
          threadId: thread.id,
          status: "interrupted",
          providerName: thread.session?.providerName ?? null,
          // Prefer the session's own mode; fall back to the thread default when the
          // thread never had a materialized session row.
          runtimeMode: thread.session?.runtimeMode ?? thread.runtimeMode,
          activeTurnId: null,
          // "interrupted" is a clean stop, not an error: no lastError banner.
          lastError: null,
          updatedAt: input.now,
        },
        createdAt: input.now,
      });
    }
  }
  return commands;
}

/**
 * Reconcile restart-orphaned turns once at boot.
 *
 * Reads the engine's in-memory command read model (post-bootstrap projection
 * state, kept current as commands commit) and synchronously settles exact open
 * turns, streaming assistant messages, and unresolved human requests through
 * targeted projection queries. It never hydrates transcript bodies.
 *
 * Deliberately not a second `getCommandReadModel()` load. That query costs ~150ms
 * on a large database and this runs on the blocking startup path before provider
 * replay begins, so re-reading it would be both slower and staler than the model
 * the engine is already maintaining.
 */
export const reconcileRestartStuckTurns: Effect.Effect<
  void,
  never,
  OrchestrationEngineService | ProjectionSnapshotQuery | ProjectionPendingInteractionRepository
> = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const snapshotQuery = yield* ProjectionSnapshotQuery;
  const pendingInteractionRepository = yield* ProjectionPendingInteractionRepository;

  const readModel = yield* engine.getCommandReadModel();
  const openTurnCountRows = yield* snapshotQuery.listOpenTurnCounts().pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("restart turn reconciliation continuing without open-turn counts", {
        cause,
      }).pipe(Effect.as([] as const)),
    ),
  );
  const openTurnCounts = new Map(
    openTurnCountRows.map(({ threadId, count }) => [threadId, count] as const),
  );
  const unresolvedInteractions = yield* pendingInteractionRepository
    .listUnresolved()
    .pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning(
          "restart turn reconciliation continuing without unresolved interactions",
          { cause },
        ).pipe(Effect.as([] as const)),
      ),
    );
  const unresolvedByThread = new Map<ThreadId, ProjectionPendingInteraction[]>();
  for (const interaction of unresolvedInteractions) {
    const rows = unresolvedByThread.get(interaction.threadId) ?? [];
    rows.push(interaction);
    unresolvedByThread.set(interaction.threadId, rows);
  }
  const streamingMessages = yield* snapshotQuery
    .listStreamingAssistantMessages()
    .pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning(
          "restart turn reconciliation continuing without streaming assistant messages",
          { cause },
        ).pipe(Effect.as([] as const)),
      ),
    );
  const streamingMessagesByThread = new Map<ThreadId, typeof streamingMessages>();
  for (const message of streamingMessages) {
    streamingMessagesByThread.set(message.threadId, [
      ...(streamingMessagesByThread.get(message.threadId) ?? []),
      message,
    ]);
  }

  const now = new Date().toISOString();
  const commandThreadIds = new Set(readModel.threads.map((thread) => thread.id));
  const unrepresentedOpenTurnThreadIds = Array.from(openTurnCounts.keys()).filter(
    (threadId) => !commandThreadIds.has(threadId),
  );
  const unrepresentedInteractionThreadIds = Array.from(unresolvedByThread.keys()).filter(
    (threadId) => !commandThreadIds.has(threadId),
  );
  const unrepresentedStreamingMessageThreadIds = Array.from(
    streamingMessagesByThread.keys(),
  ).filter((threadId) => !commandThreadIds.has(threadId));
  const deletedThreadIdsWithRestartArtifacts = readModel.threads
    .filter(
      (thread) =>
        thread.deletedAt !== null &&
        ((openTurnCounts.get(thread.id) ?? 0) > 0 ||
          unresolvedByThread.has(thread.id) ||
          streamingMessagesByThread.has(thread.id)),
    )
    .map((thread) => thread.id);
  const threadsNeedingRestartCleanup = readModel.threads
    .filter(
      (thread) =>
        thread.deletedAt === null &&
        (needsRestartReconciliation(thread) ||
          (openTurnCounts.get(thread.id) ?? 0) > 0 ||
          thread.hasPendingApprovals ||
          thread.hasPendingUserInput ||
          unresolvedByThread.has(thread.id) ||
          streamingMessagesByThread.has(thread.id)),
    )
    .map((thread) => ({
      ...thread,
      openTurnCount: openTurnCounts.get(thread.id) ?? 0,
      pendingInteractions: unresolvedByThread.get(thread.id) ?? [],
      messages: (streamingMessagesByThread.get(thread.id) ?? []).map((message) => ({
        id: message.messageId,
        role: "assistant" as const,
        streaming: true,
        turnId: message.turnId,
      })),
    }));
  yield* Effect.logInfo("restart turn reconciliation inspected persisted state", {
    inspectedThreadCount: readModel.threads.length,
    openTurnThreadCount: openTurnCounts.size,
    unresolvedInteractionCount: unresolvedInteractions.length,
    unresolvedInteractionThreadCount: unresolvedByThread.size,
    unrepresentedInteractionThreadIds,
    streamingAssistantMessageCount: streamingMessages.length,
    streamingAssistantMessageThreadCount: streamingMessagesByThread.size,
    unrepresentedStreamingMessageThreadIds,
    unrepresentedOpenTurnThreadIds,
    deletedThreadIdsWithRestartArtifacts,
    selectedThreadCount: threadsNeedingRestartCleanup.length,
    selectedThreadIds: threadsNeedingRestartCleanup.map((thread) => thread.id),
  });
  if (threadsNeedingRestartCleanup.length === 0) {
    return;
  }

  const reconciliationCommands = planRestartTurnReconciliation({
    threads: threadsNeedingRestartCleanup,
    now,
  });

  yield* Effect.logInfo("reconciling restart-stuck turns", {
    commandCount: reconciliationCommands.length,
    threadCount: threadsNeedingRestartCleanup.length,
    threadIds: threadsNeedingRestartCleanup.map((thread) => thread.id),
  });

  yield* Effect.forEach(
    reconciliationCommands,
    (command) =>
      engine.dispatch(command).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("failed to reconcile restart-stuck turn", {
            threadId: command.threadId,
            cause,
          }),
        ),
      ),
    { discard: true },
  );

  yield* Effect.logInfo("restart turn reconciliation completed", {
    interactionCommandCount: reconciliationCommands.filter(
      (command) => command.type === "thread.activity.append",
    ).length,
    streamingMessageCommandCount: reconciliationCommands.filter(
      (command) => command.type === "thread.message.assistant.complete",
    ).length,
    sessionCommandCount: reconciliationCommands.filter(
      (command) => command.type === "thread.session.set",
    ).length,
    threadCount: threadsNeedingRestartCleanup.length,
  });
});
