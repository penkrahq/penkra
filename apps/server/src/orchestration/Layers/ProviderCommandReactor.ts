// FILE: ProviderCommandReactor.ts
// Purpose: Routes orchestration intents into provider sessions and maintains replay-safe context.
// Layer: Orchestration provider reactor

import {
  type ChatAttachment,
  CommandId,
  EventId,
  type ModelSelection,
  MessageId,
  type OrchestrationEvent,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  type ProviderMentionReference,
  type ProviderConnectionId,
  type ProviderRuntimeEvent,
  ProviderKind,
  type ProviderReviewTarget,
  type ProviderStartOptions,
  type ProviderSkillReference,
  type ProviderTurnStartResult,
  type OrchestrationSession,
  type OrchestrationFolderShell,
  type OrchestrationThread,
  ThreadId,
  type ProviderSession,
  type RuntimeMode,
  TurnId,
} from "@penkra/contracts";
import {
  Cache,
  Cause,
  Duration,
  Effect,
  Equal,
  Exit,
  Layer,
  Option,
  Queue,
  Schema,
  Semaphore,
  ServiceMap,
  Stream,
} from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  buildPromptThreadTitleFallback,
  isGenericChatThreadTitle,
} from "@penkra/shared/chatThreads";
import {
  collectTailTurnIds,
  resolveTailUserMessageEditTarget,
} from "@penkra/shared/conversationEdit";
import { claudeSelectionRequiresRestart } from "@penkra/shared/model";
import { providerSupportsNativeTurnSteering } from "@penkra/shared/providerMetadata";
import {
  formatProviderDeliveryBlockDetail,
  PROVIDER_DELIVERY_BLOCK_SUMMARY,
} from "@penkra/shared/providerDeliveryBlock";
import { buildStalePendingRequestFailureDetail } from "@penkra/shared/threadSummary";
import { resolveThreadWorkspaceCwd } from "@penkra/shared/threadEnvironment";

import {
  ProviderAdapterRequestError,
  ProviderAdapterValidationError,
  ProviderServiceError,
} from "../../provider/Errors.ts";
import { buildInlineSkillInstructions } from "../../provider/skillPromptInjection.ts";
import {
  appendThreadMentionContextBlocks,
  resolveThreadMentionPromptProjection,
  threadMentionContextSuffix,
} from "../../provider/threadMentionContext.ts";
import {
  TextGeneration,
  type ThreadTitleGenerationInput,
} from "../../textGeneration/Services/TextGeneration.ts";
import { resolveTextGenerationInputForSelection } from "../../textGeneration/textGenerationSelection.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { ProviderTurnSelectionResolver } from "../../provider/Services/ProviderTurnSelectionResolver.ts";
import { ProviderLaunchResolver } from "../../provider/Services/ProviderLaunchResolver.ts";
import type { ProviderManagedLaunchContext } from "../../provider/Services/ProviderAdapter.ts";
import { ThreadProviderBindingRepository } from "../../persistence/Services/ThreadProviderBindings.ts";
import { resolveProviderDispatchAttachments } from "../../provider/providerAttachmentPaths.ts";
import { providerNativeResumeIdentity } from "../../provider/nativeResumeIdentity.ts";
import { OrchestrationEventDeliveryRepositoryLive } from "../../persistence/Layers/OrchestrationEventDeliveries.ts";
import { ProjectionPendingInteractionRepositoryLive } from "../../persistence/Layers/ProjectionPendingInteractions.ts";
import { QueuedTurnPromotionRepositoryLive } from "../../persistence/Layers/QueuedTurnPromotions.ts";
import { ProjectionPendingInteractionRepository } from "../../persistence/Services/ProjectionPendingInteractions.ts";
import {
  OrchestrationEventDeliveryRepository,
  PROVIDER_COMMAND_REACTOR_CONSUMER,
} from "../../persistence/Services/OrchestrationEventDeliveries.ts";
import { QueuedTurnPromotionRepository } from "../../persistence/Services/QueuedTurnPromotions.ts";
import { ManagedAttachmentRepository } from "../../persistence/Services/ManagedAttachments.ts";
import { ServerConfig } from "../../config.ts";
import { LOCAL_LOOPBACK_ATTACHMENT_PRINCIPAL } from "../../managedAttachmentPrincipal.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProviderThreadSwitchCoordinator } from "../Services/ProviderThreadSwitchCoordinator.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  ProviderCommandReactor,
  type ProviderCommandReactorShape,
} from "../Services/ProviderCommandReactor.ts";
import {
  isClaimedProviderIntent,
  isProviderIntentEvent,
  isProviderSideEffectIntent,
  isQuarantineExemptProviderIntent,
  isReplaySafeClaimedProviderIntent,
  type ProviderIntentEvent,
} from "../providerIntentClassification.ts";
import { deriveTurnStartSession } from "../turnStartSession.ts";
import { RESTART_TURN_RECOVERY_PROMPT } from "../restartTurnRecovery.ts";
import { resolveProviderSessionThread as resolveProviderSessionThreadFromProjection } from "../providerSessionThread.ts";

type ProviderQueueDrainEvent = Extract<
  ProviderRuntimeEvent,
  {
    type: "turn.completed" | "turn.aborted" | "session.exited" | "runtime.error";
  }
>;

type QueuedTurnSourceEvent =
  | Extract<ProviderIntentEvent, { type: "thread.turn-queued" }>
  | Extract<ProviderIntentEvent, { type: "thread.turn-start-requested" }>;

type InteractionResponseEvent = Extract<
  ProviderIntentEvent,
  {
    type: "thread.approval-response-requested" | "thread.user-input-response-requested";
  }
>;

type ProviderAttemptOutcome =
  | { readonly _tag: "accepted" }
  | { readonly _tag: "rejected"; readonly detail: string }
  | { readonly _tag: "safe_retry"; readonly detail: string }
  | { readonly _tag: "uncertain"; readonly detail: string };

export function classifyProviderAttemptOutcome(
  exit: Exit.Exit<void, unknown>,
): ProviderAttemptOutcome {
  if (Exit.isSuccess(exit)) return { _tag: "accepted" };
  const detail = Cause.pretty(exit.cause);
  const failure = Cause.findErrorOption(exit.cause);
  if (Option.isNone(failure)) return { _tag: "uncertain", detail };

  const tag = (failure.value as { readonly _tag?: string })._tag;
  switch (tag) {
    case "ProviderAdapterValidationError":
    case "ProviderAdapterSessionNotFoundError":
    case "ProviderAdapterSessionClosedError":
    case "ProviderValidationError":
    case "ProviderUnsupportedError":
    case "ProviderSessionNotFoundError":
      return { _tag: "rejected", detail };
    case "PersistenceSqlError":
    case "PersistenceDecodeError":
      return { _tag: "safe_retry", detail };
    default:
      return { _tag: "uncertain", detail };
  }
}

type BoundedProviderCallResult<E> =
  | { readonly _tag: "ok" }
  | { readonly _tag: "timeout"; readonly detail: string }
  | {
      readonly _tag: "failed";
      readonly outcome: Exclude<ProviderAttemptOutcome, { readonly _tag: "accepted" }>;
      readonly cause: Cause.Cause<E>;
    };

/**
 * Runs a provider call under a hard deadline and reduces it to a decision.
 * A call that never returns cannot simply be awaited here: the caller holds the
 * reactor's single delivery permit, so waiting forever stalls every thread.
 * Interruption is re-raised untouched so shutdown still cancels cleanly.
 */
const runBoundedProviderCall = <E, R>(input: {
  readonly label: string;
  readonly timeout: Duration.Duration;
  readonly call: Effect.Effect<unknown, E, R>;
}): Effect.Effect<BoundedProviderCallResult<E>, E, R> =>
  Effect.suspend(() => {
    let timedOut = false;
    return input.call.pipe(
      Effect.timeoutOption(input.timeout),
      Effect.flatMap((result) =>
        Effect.sync(() => {
          timedOut = Option.isNone(result);
        }),
      ),
      Effect.exit,
      Effect.flatMap(
        (exit): Effect.Effect<BoundedProviderCallResult<E>, E> =>
          Exit.isSuccess(exit)
            ? Effect.succeed(
                timedOut
                  ? {
                      _tag: "timeout",
                      detail: `${input.label} did not respond within ${Duration.toMillis(input.timeout)}ms.`,
                    }
                  : { _tag: "ok" },
              )
            : Cause.hasInterruptsOnly(exit.cause)
              ? Effect.failCause(exit.cause)
              : Effect.sync((): BoundedProviderCallResult<E> => {
                  const outcome = classifyProviderAttemptOutcome(exit);
                  return {
                    _tag: "failed",
                    // classify only reports "accepted" for success exits, which
                    // cannot reach this branch; normalize to keep the type honest.
                    outcome:
                      outcome._tag === "accepted"
                        ? { _tag: "uncertain", detail: Cause.pretty(exit.cause) }
                        : outcome,
                    cause: exit.cause,
                  };
                }),
      ),
    );
  });

function toNonEmptyProviderInput(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

// Codex app-server still expects `$skill` text next to the structured skill item.
export function normalizeSkillMentionTextForProvider(input: {
  readonly provider: ProviderKind;
  readonly messageText: string;
  readonly skills?: ReadonlyArray<ProviderSkillReference>;
}): string {
  if (input.provider !== "codex" || !input.skills || input.skills.length === 0) {
    return input.messageText;
  }

  let nextText = input.messageText;
  for (const skill of input.skills) {
    const escapedName = skill.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    nextText = nextText.replace(
      new RegExp(`(^|\\s)/${escapedName}(?=\\s|$)`, "gi"),
      `$1$${skill.name}`,
    );
  }
  return nextText;
}

function attachmentTitleSeed(attachment: ChatAttachment | undefined): string {
  if (!attachment) {
    return "";
  }
  if (attachment.type === "image" || attachment.type === "file") {
    return attachment.name;
  }
  return attachment.text.trim();
}

const serverCommandId = (tag: string): CommandId =>
  CommandId.makeUnsafe(`server:${tag}:${crypto.randomUUID()}`);

const replaySafeServerCommandId = (tag: string, eventId: EventId): CommandId =>
  CommandId.makeUnsafe(`server:${tag}:${eventId}`);

const turnStartKeyForEvent = (event: ProviderIntentEvent): string =>
  event.commandId !== null ? `command:${event.commandId}` : `event:${event.eventId}`;

const HANDLED_TURN_START_KEY_MAX = 10_000;
const HANDLED_TURN_START_KEY_TTL = Duration.minutes(30);
const PROVIDER_COMMAND_CLAIM_LEASE_MS = 30_000;
const PROVIDER_COMMAND_SAFE_RETRY_LIMIT = 3;
const PROVIDER_COMMAND_SAFE_RETRY_DELAY = Duration.millis(50);
/**
 * Every provider intent runs under a single process-wide delivery lock, so an
 * unbounded provider call does not stall one thread — it stalls the reactor,
 * which back-pressures the orchestration event PubSub and eventually times out
 * every dispatched command. These deadlines make "hung" degrade into a normal
 * terminal delivery failure instead of a process-wide deadlock.
 */
const PROVIDER_COMMAND_INTERRUPT_TIMEOUT = Duration.seconds(10);
const PROVIDER_COMMAND_STOP_TIMEOUT = Duration.seconds(15);
const PROVIDER_COMMAND_EVENT_TIMEOUT = Duration.seconds(120);
const QUEUED_TURN_RECOVERY_INTERVAL = Duration.seconds(5);
const PROVIDER_INPUT_SAFETY_MARGIN_CHARS = 1_000;
const THREAD_MENTION_CONTEXT_SUFFIX_PREFIX_CHARS = 2;
const DEFAULT_RUNTIME_MODE: RuntimeMode = "full-access";

function availableThreadMentionContextChars(messageText: string): number {
  return Math.max(
    0,
    PROVIDER_SEND_TURN_MAX_INPUT_CHARS -
      messageText.length -
      PROVIDER_INPUT_SAFETY_MARGIN_CHARS -
      THREAD_MENTION_CONTEXT_SUFFIX_PREFIX_CHARS,
  );
}

function isUnknownPendingApprovalRequestError(cause: Cause.Cause<ProviderServiceError>): boolean {
  const error = Cause.squash(cause);
  if (Schema.is(ProviderAdapterRequestError)(error)) {
    const detail = error.detail.toLowerCase();
    return (
      detail.includes("unknown pending approval request") ||
      detail.includes("unknown pending permission request")
    );
  }
  const message = Cause.pretty(cause);
  return (
    message.includes("unknown pending approval request") ||
    message.includes("unknown pending permission request")
  );
}

function isUnknownPendingUserInputRequestError(cause: Cause.Cause<ProviderServiceError>): boolean {
  const error = Cause.squash(cause);
  if (Schema.is(ProviderAdapterRequestError)(error)) {
    return error.detail.toLowerCase().includes("unknown pending user-input request");
  }
  return Cause.pretty(cause).toLowerCase().includes("unknown pending user-input request");
}

function interactionFailureSettlementStatus(
  cause: Cause.Cause<ProviderServiceError>,
  isUnknownPendingRequest: boolean,
): "retryable" | "uncertain" {
  return Option.match(Cause.findErrorOption(cause), {
    onNone: () => "uncertain" as const,
    onSome: (error) =>
      isUnknownPendingRequest ||
      error._tag === "ProviderAdapterRequestError" ||
      error._tag === "ProviderAdapterProcessError"
        ? ("uncertain" as const)
        : ("retryable" as const),
  });
}

function isStaleCodexResumeError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  return (
    normalized.includes("thread/resume") &&
    (normalized.includes("no rollout found") ||
      normalized.includes("thread not found") ||
      normalized.includes("missing thread") ||
      normalized.includes("unknown thread"))
  );
}

function isStaleClaudeResumeError(error: unknown): boolean {
  if (Schema.is(ProviderAdapterRequestError)(error)) {
    return (
      error.provider === "claudeAgent" &&
      error.detail.toLowerCase().includes("no conversation found with session id")
    );
  }
  return String(error).toLowerCase().includes("no conversation found with session id");
}

function isRollbackStillInProgressError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  return (
    normalized.includes("rollback") &&
    (normalized.includes("turn is in progress") ||
      normalized.includes("turn in progress") ||
      normalized.includes("active turn"))
  );
}

export interface ProviderCommandReactorLiveOptions {
  readonly commandEventTimeout?: Duration.Duration;
  readonly queuedTurnRecoveryInterval?: Duration.Duration;
}

interface ProviderCommandReactorConfigShape {
  readonly commandEventTimeout: Duration.Duration;
  readonly queuedTurnRecoveryInterval: Duration.Duration;
}

class ProviderCommandReactorConfig extends ServiceMap.Service<
  ProviderCommandReactorConfig,
  ProviderCommandReactorConfigShape
>()("penkra/orchestration/Layers/ProviderCommandReactorConfig") {}

const make = Effect.gen(function* () {
  const { commandEventTimeout, queuedTurnRecoveryInterval } = yield* ProviderCommandReactorConfig;
  const sql = yield* SqlClient.SqlClient;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const providerThreadSwitchCoordinator = yield* ProviderThreadSwitchCoordinator;
  const deliveryRepository = yield* OrchestrationEventDeliveryRepository;
  const queuedTurnPromotions = yield* QueuedTurnPromotionRepository;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const providerService = yield* ProviderService;
  const providerTurnSelectionResolver = yield* ProviderTurnSelectionResolver;
  const providerLaunchResolver = yield* ProviderLaunchResolver;
  const threadProviderBindings = yield* ThreadProviderBindingRepository;
  const pendingInteractions = yield* ProjectionPendingInteractionRepository;
  const textGeneration = yield* TextGeneration;
  const serverSettings = yield* ServerSettingsService;
  const managedAttachments = yield* ManagedAttachmentRepository;
  const serverConfig = yield* ServerConfig;
  const handledTurnStartKeys = yield* Cache.make<string, true>({
    capacity: HANDLED_TURN_START_KEY_MAX,
    timeToLive: HANDLED_TURN_START_KEY_TTL,
    lookup: () => Effect.succeed(true),
  });
  const deliverySourceLock = yield* Semaphore.make(1);
  let reconcileDeliveryRuntime: ProviderCommandReactorShape["reconcileDelivery"] | undefined;

  const hasHandledTurnStartRecently = (key: string) =>
    Cache.getOption(handledTurnStartKeys, key).pipe(
      Effect.flatMap((cached) =>
        Cache.set(handledTurnStartKeys, key, true).pipe(Effect.as(Option.isSome(cached))),
      ),
    );

  const threadProviderOptions = new Map<string, ProviderStartOptions>();
  const threadManagedBindingRevisions = new Map<string, number>();
  // The selection last applied to each live session. Keep this separate from
  // projected thread metadata so an option changed mid-turn is still compared
  // against the old subprocess configuration before the next turn starts.
  const threadSessionModelSelections = new Map<string, ModelSelection>();
  // Seeded from the engine's in-memory command read model, not a second snapshot query.
  // The engine loads that model once after the projection bootstrap and keeps it current
  // as commands commit, so reading it here is both free and strictly fresher than
  // re-running the eight-query snapshot load on the blocking startup path (~150ms on a
  // large database). It cannot fail, so there is no failure mode left to log.
  const seedThreadModelSelections = orchestrationEngine.getCommandReadModel().pipe(
    Effect.map((snapshot) => {
      for (const thread of snapshot.threads) {
        threadSessionModelSelections.set(thread.id, thread.modelSelection);
      }
    }),
  );

  const resolveThreadWorkspaceProject = Effect.fnUntraced(function* (
    thread: Pick<OrchestrationThread, "folderId">,
  ): Effect.fn.Return<OrchestrationFolderShell | undefined> {
    return Option.getOrUndefined(
      yield* projectionSnapshotQuery
        .getFolderShellById(thread.folderId)
        .pipe(Effect.catch(() => Effect.succeed(Option.none()))),
    );
  });

  const resolveProjectedThreadWorkspaceCwd = Effect.fnUntraced(function* (
    thread: Pick<OrchestrationThread, "folderId" | "workingDirectory">,
  ): Effect.fn.Return<string | undefined> {
    const project = yield* resolveThreadWorkspaceProject(thread);
    if (!project) {
      return undefined;
    }
    return (
      resolveThreadWorkspaceCwd({
        workingDirectory: thread.workingDirectory,
        projectCwd: project.workspaceRoot,
      }) ?? undefined
    );
  });
  const editResendTurnStartKeys = new Set<string>();
  const quarantinedThreads = new Set<string>();
  const drainingQueuedTurns = new Set<string>();
  // Provider sessions with a drained queued turn whose promotion is in flight.
  // The reservation survives provider startup and binds to the exact turn that
  // must settle before another queue can drain, preventing late terminal events
  // from promoting overlapping work.
  // Keyed by the session-owning thread id (child subagent threads share the
  // parent session, so per-child keys would allow overlapping promotions on
  // one session); the queued thread + message pair identifies the promoted
  // command, while object identity protects a replacement reservation for a
  // retry of that same command.
  type PendingQueuedDispatch = {
    readonly queuedThreadId: string;
    readonly messageId: string;
    releaseOnTurnId?: TurnId;
    pendingTerminalTurnIds?: Set<TurnId>;
  };
  const pendingQueuedDispatchBySessionThread = new Map<string, PendingQueuedDispatch>();
  // OpenCode steering interrupts the active turn, then promotes the steered
  // message after that exact turn's terminal event. Binding the barrier to a
  // turn prevents late parent or child events on the shared session from
  // releasing it early.
  const openCodeSteerInterruptBarriers = new Map<string, TurnId>();
  const queuedTurnPromotionOwner = `provider-queued-turn:${crypto.randomUUID()}`;
  // A pending-start interrupt is also delivered as its own durable intent.
  // Record cancellations completed by the start handler so that later intent
  // does not issue a second, unscoped provider interrupt. Replay is safe: the
  // start event is ordered before its interrupt and reconstructs this marker.
  const completedPendingTurnStartInterrupts = new Set<string>();

  const resolveThreadTextGenerationInput = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly modelSelection?: ModelSelection;
    readonly providerOptions?: ProviderStartOptions;
  }) {
    const thread = yield* resolveThread(input.threadId);
    const modelSelection =
      input.modelSelection ??
      thread?.modelSelection ??
      threadSessionModelSelections.get(input.threadId);
    const providerOptions = input.providerOptions ?? threadProviderOptions.get(input.threadId);
    return resolveTextGenerationInputForSelection(modelSelection, providerOptions);
  });

  const appendProviderFailureActivity = (input: {
    readonly threadId: ThreadId;
    readonly kind:
      | "provider.turn.start.failed"
      | "provider.turn.interrupt.failed"
      | "provider.task.stop.failed"
      | "provider.task.background.failed"
      | "provider.approval.respond.failed"
      | "provider.user-input.respond.failed"
      | "provider.session.stop.failed";
    readonly summary: string;
    readonly detail: string;
    readonly turnId: TurnId | null;
    readonly createdAt: string;
    readonly requestId?: string;
    readonly lifecycleGeneration?: string;
    readonly responseCommandId?: CommandId;
    readonly settlementStatus?: "retryable" | "uncertain";
  }) =>
    orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: serverCommandId("provider-failure-activity"),
      threadId: input.threadId,
      activity: {
        id: EventId.makeUnsafe(crypto.randomUUID()),
        tone: "error",
        kind: input.kind,
        summary: input.summary,
        payload: {
          detail: input.detail,
          ...(input.requestId ? { requestId: input.requestId } : {}),
          ...(input.lifecycleGeneration ? { lifecycleGeneration: input.lifecycleGeneration } : {}),
          ...(input.responseCommandId ? { responseCommandId: input.responseCommandId } : {}),
          ...(input.settlementStatus ? { settlementStatus: input.settlementStatus } : {}),
        },
        turnId: input.turnId,
        createdAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });

  const setThreadSession = (input: {
    readonly threadId: ThreadId;
    readonly session: OrchestrationSession;
    readonly expectedSession?: Pick<OrchestrationSession, "status" | "updatedAt">;
    readonly createdAt: string;
  }) =>
    orchestrationEngine.dispatch({
      type: "thread.session.set",
      commandId: serverCommandId("provider-session-set"),
      threadId: input.threadId,
      session: input.session,
      ...(input.expectedSession !== undefined
        ? {
            expectedSessionStatus: input.expectedSession.status,
            expectedSessionUpdatedAt: input.expectedSession.updatedAt,
          }
        : {}),
      createdAt: input.createdAt,
    });

  const setThreadSessionError = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly runtimeMode?: RuntimeMode;
    readonly detail: string;
    readonly expectedSession?: Pick<OrchestrationSession, "status" | "updatedAt">;
    readonly createdAt: string;
  }) {
    const thread = yield* resolveThread(input.threadId);
    if (!thread) {
      return;
    }
    yield* setThreadSession({
      threadId: input.threadId,
      session: {
        threadId: input.threadId,
        status: "error",
        providerName: thread.session?.providerName ?? thread.modelSelection.provider,
        runtimeMode: input.runtimeMode ?? thread.session?.runtimeMode ?? DEFAULT_RUNTIME_MODE,
        activeTurnId: null,
        lastError: input.detail,
        updatedAt: input.createdAt,
      },
      ...(input.expectedSession !== undefined ? { expectedSession: input.expectedSession } : {}),
      createdAt: input.createdAt,
    });
  });

  /**
   * Finalizes a turn the provider will never settle on its own. `Stop` is only
   * trustworthy if every dead-end branch clears the projected active turn:
   * `settleTurnStateFromSession` finalizes a running turn only when the session
   * reports `activeTurnId: null`, so leaving it set renders as "Thinking"
   * forever with no escape hatch left for the user.
   */
  const settleInterruptedProviderTurn = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly createdAt: string;
  }) {
    const thread = yield* resolveThread(input.threadId);
    const session = thread?.session;
    if (!thread || !session) {
      return;
    }
    if (session.activeTurnId === null && thread.latestTurn?.state !== "running") {
      return;
    }
    yield* setThreadSession({
      threadId: input.threadId,
      session: {
        ...session,
        threadId: input.threadId,
        // Already-terminal statuses stay as they are; anything else becomes
        // `interrupted` so the turn is never reported as a clean completion.
        status:
          session.status === "stopped" || session.status === "error"
            ? session.status
            : "interrupted",
        activeTurnId: null,
        updatedAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });
  });

  const resolveThread = Effect.fnUntraced(function* (threadId: ThreadId) {
    return Option.getOrUndefined(yield* projectionSnapshotQuery.getThreadDetailById(threadId));
  });

  const resolveProviderSessionThread = (threadId: ThreadId) =>
    resolveProviderSessionThreadFromProjection(projectionSnapshotQuery, threadId);

  const withProviderSessionLease = <A, E, R>(_threadId: ThreadId, effect: Effect.Effect<A, E, R>) =>
    effect;

  const resolveSubagentProviderThreadId = (
    threadId: ThreadId,
    parentThreadId: ThreadId | null | undefined,
  ): string | undefined => {
    if (!parentThreadId) {
      return undefined;
    }

    const prefix = `subagent:${parentThreadId}:`;
    const rawThreadId = threadId as string;
    return rawThreadId.startsWith(prefix) ? rawThreadId.slice(prefix.length) : undefined;
  };

  const enqueueQueuedTurnStart = (event: QueuedTurnSourceEvent) =>
    queuedTurnPromotions.enqueue({
      queuedEventSequence: event.sequence,
      threadId: event.payload.threadId,
      messageId: event.payload.messageId,
      dispatchMode: event.payload.dispatchMode,
      createdAt: event.payload.createdAt,
    });

  const hasQueuedTurnStart = (threadId: ThreadId, messageId: string) =>
    queuedTurnPromotions.hasPendingMessage({ threadId, messageId });

  // Live provider state, not the projection: the decider routes turn starts
  // from a projected session snapshot that can lag the runtime in both
  // directions (queueing after the turn already settled, or dispatching while
  // a turn is still live). Adapters clear `activeTurnId` synchronously with
  // emitting `turn.completed`/`turn.aborted`, so this check is authoritative.
  // Child subagent threads share their parent's provider session, so the
  // lookup must resolve to the session-owning thread — a raw child-id lookup
  // would always miss and drain queued child messages into a live turn.
  const resolveLiveProviderTurnId = Effect.fnUntraced(function* (threadId: ThreadId) {
    const providerThread = yield* resolveProviderSessionThread(threadId);
    const sessionThreadId = providerThread?.id ?? threadId;
    const session = yield* providerService
      .listSessions()
      .pipe(Effect.map((sessions) => sessions.find((entry) => entry.threadId === sessionThreadId)));
    return session?.status === "running" ? session.activeTurnId : undefined;
  });
  const hasLiveProviderTurn = (threadId: ThreadId) =>
    resolveLiveProviderTurnId(threadId).pipe(Effect.map((turnId) => turnId !== undefined));

  const editResendTurnStartKey = (threadId: ThreadId, messageId: string) =>
    `${threadId}:${messageId}`;

  const clearEditResendTurnStartKeysForThread = (threadId: ThreadId) =>
    Effect.sync(() => {
      const prefix = `${threadId}:`;
      for (const key of editResendTurnStartKeys) {
        if (key.startsWith(prefix)) {
          editResendTurnStartKeys.delete(key);
        }
      }
    });

  const clearThreadRuntimeCaches = (threadId: ThreadId) =>
    Effect.sync(() => {
      threadProviderOptions.delete(threadId);
      threadSessionModelSelections.delete(threadId);
      threadManagedBindingRevisions.delete(threadId);
      const editResendPrefix = `${threadId}:`;
      for (const key of editResendTurnStartKeys) {
        if (key.startsWith(editResendPrefix)) {
          editResendTurnStartKeys.delete(key);
        }
      }
      quarantinedThreads.delete(threadId);
      // NOTE: `drainingQueuedTurns` is intentionally NOT cleared here. It is a
      // turn-scoped in-flight guard that each drain self-clears when it settles;
      // deleting it here would let a concurrent second drain start for the same
      // thread while the first is still running.
    });

  const clearStaleProviderResumeState = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly cause: ProviderServiceError;
    readonly preserveActiveRuntime?: boolean;
  }) {
    if (providerService.clearSessionResumeCursor) {
      yield* providerService
        .clearSessionResumeCursor({
          threadId: input.threadId,
          ...(input.preserveActiveRuntime === true ? { preserveActiveRuntime: true } : {}),
        })
        .pipe(Effect.catch(() => Effect.void));
    } else if (input.preserveActiveRuntime !== true) {
      yield* providerService
        .stopSession({ threadId: input.threadId })
        .pipe(Effect.catch(() => Effect.void));
    }
    yield* Effect.logWarning("provider command reactor cleared stale provider resume state", {
      threadId: input.threadId,
      cause: input.cause.message,
    });
  });

  const rollbackProviderConversationForEdit = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly numTurns: number;
  }) {
    const projectedThread = yield* resolveThread(input.threadId);
    const provider = projectedThread
      ? Schema.is(ProviderKind)(projectedThread.session?.providerName)
        ? projectedThread.session?.providerName
        : projectedThread.modelSelection.provider
      : undefined;
    const rebuildsContext =
      provider !== undefined &&
      (yield* providerService.getCapabilities(provider)).conversationRollback === "unsupported";
    let attempt = 0;
    while (true) {
      let rollbackError: ProviderServiceError | null = null;
      yield* providerService
        .rollbackConversation({
          threadId: input.threadId,
          numTurns: input.numTurns,
        })
        .pipe(
          Effect.catch((error) =>
            Effect.sync(() => {
              rollbackError = error;
            }),
          ),
        );
      if (rollbackError === null) {
        return;
      }
      if (isStaleCodexResumeError(rollbackError)) {
        yield* clearStaleProviderResumeState({
          threadId: input.threadId,
          cause: rollbackError,
        });
        return;
      }
      if (isRollbackStillInProgressError(rollbackError) && attempt < 30) {
        attempt += 1;
        yield* Effect.sleep(100);
        continue;
      }
      return yield* Effect.fail(rollbackError);
    }
  });

  const resolveManagedTurnRuntime = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly modelSelection?: ModelSelection;
    readonly connectionId?: ProviderConnectionId | null;
    readonly bindingRevision?: number;
  }) {
    if (input.connectionId === undefined || input.bindingRevision === undefined) {
      return yield* new ProviderAdapterValidationError({
        provider: input.modelSelection?.provider ?? "codex",
        operation: "thread.turn.start",
        issue: "The turn is missing its exact managed Connection binding.",
      });
    }
    const selection = yield* providerTurnSelectionResolver
      .resolveExisting({
        threadId: input.threadId,
        ...(input.modelSelection !== undefined ? { modelSelection: input.modelSelection } : {}),
        ...(input.connectionId !== undefined ? { connectionId: input.connectionId } : {}),
        ...(input.bindingRevision !== undefined ? { bindingRevision: input.bindingRevision } : {}),
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterValidationError({
              provider: input.modelSelection?.provider ?? "codex",
              operation: "thread.turn.start",
              issue: cause.message,
              cause,
            }),
        ),
      );
    if (selection.changed) {
      return yield* new ProviderAdapterValidationError({
        provider: selection.harness,
        operation: "thread.turn.start",
        issue: "A Connection change requires verified transactional switch admission.",
      });
    }
    const state = Option.getOrUndefined(
      yield* threadProviderBindings.getHarnessState(input.threadId),
    );
    if (!state || state.revision !== selection.stateRevision) {
      return yield* new ProviderAdapterValidationError({
        provider: selection.harness,
        operation: "thread.turn.start",
        issue: "The thread native state changed before managed runtime launch.",
      });
    }
    const resumeCursor = yield* Effect.try({
      try: () => JSON.parse(state.nativeStateLocatorJson) as unknown,
      catch: (cause) =>
        new ProviderAdapterValidationError({
          provider: selection.harness,
          operation: "thread.turn.start",
          issue: "The thread native-state locator is invalid.",
          cause,
        }),
    });
    const launch = yield* providerLaunchResolver
      .resolve({
        threadId: input.threadId,
        connectionId: selection.connectionId,
        installationId: selection.installationId,
        internalProviderId: selection.internalProviderId,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterValidationError({
              provider: selection.harness,
              operation: "thread.turn.start",
              issue: cause.message,
              cause,
            }),
        ),
      );
    return {
      bindingRevision: selection.bindingRevision,
      // A first binding owns an empty managed generation but has no native
      // session identity yet. Start fresh; JSON null is a persisted sentinel,
      // not a provider resume cursor.
      resumeCursor: state.providerSessionId === null ? undefined : resumeCursor,
      managedLaunch: {
        binaryPath: launch.binaryPath,
        isolationKey: launch.isolationKey,
        profileRoot: launch.profileRoot,
        nativeStateRoot: launch.nativeStateRoot,
        childEnvironment: (baseEnv: NodeJS.ProcessEnv) => launch.childEnvironment(baseEnv),
      } satisfies ProviderManagedLaunchContext,
    };
  });

  const resolveCurrentManagedRuntime = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly modelSelection: ModelSelection;
  }) {
    const current = yield* providerTurnSelectionResolver
      .resolveExisting({
        threadId: input.threadId,
        modelSelection: input.modelSelection,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterValidationError({
              provider: input.modelSelection.provider,
              operation: "thread.turn.start",
              issue: cause.message,
              cause,
            }),
        ),
      );
    return yield* resolveManagedTurnRuntime({
      threadId: input.threadId,
      modelSelection: input.modelSelection,
      connectionId: current.connectionId,
      bindingRevision: current.bindingRevision,
    });
  });

  const ensureSessionForThread = Effect.fnUntraced(function* (
    threadId: ThreadId,
    createdAt: string,
    options?: {
      readonly modelSelection?: ModelSelection;
      readonly providerOptions?: ProviderStartOptions;
      readonly runtimeMode?: RuntimeMode;
      readonly managedLaunch?: ProviderManagedLaunchContext;
      readonly nativeResumeCursor?: unknown;
      readonly bindingRevision?: number;
    },
  ) {
    const thread = yield* resolveThread(threadId);
    if (!thread) {
      return yield* Effect.die(
        new Error(`Thread '${threadId}' was not found in projection state.`),
      );
    }
    const desiredRuntimeMode = options?.runtimeMode ?? thread.runtimeMode;
    const currentProvider: ProviderKind | undefined = Schema.is(ProviderKind)(
      thread.session?.providerName,
    )
      ? thread.session.providerName
      : undefined;
    const requestedModelSelection = options?.modelSelection;
    const threadProvider: ProviderKind = currentProvider ?? thread.modelSelection.provider;
    if (
      requestedModelSelection !== undefined &&
      requestedModelSelection.provider !== threadProvider
    ) {
      return yield* new ProviderAdapterValidationError({
        provider: threadProvider,
        operation: "thread.turn.start",
        issue: `Thread '${threadId}' is bound to provider '${threadProvider}' and cannot switch to '${requestedModelSelection.provider}'.`,
      });
    }
    const preferredProvider: ProviderKind = currentProvider ?? threadProvider;
    const desiredModelSelection = requestedModelSelection ?? thread.modelSelection;
    const settingsSnapshot = yield* serverSettings.getSnapshot;
    if (!settingsSnapshot.settings.providers[preferredProvider].enabled) {
      return yield* new ProviderAdapterValidationError({
        provider: preferredProvider,
        operation: "thread.turn.start",
        issue: `Provider '${preferredProvider}' is disabled in server settings revision ${settingsSnapshot.revision}.`,
      });
    }
    if (options?.managedLaunch === undefined) {
      return yield* new ProviderAdapterValidationError({
        provider: preferredProvider,
        operation: "thread.turn.start",
        issue: `Thread '${threadId}' has no exact managed launch binding.`,
      });
    }
    const effectiveCwd = yield* resolveProjectedThreadWorkspaceCwd(thread);
    const providerSessionOptions = {
      threadId,
      ...(effectiveCwd ? { cwd: effectiveCwd } : {}),
      modelSelection: desiredModelSelection,
      managedLaunch: options.managedLaunch,
      runtimeMode: desiredRuntimeMode,
    };

    const resolveActiveSession = (threadId: ThreadId) =>
      providerService
        .listSessions()
        .pipe(Effect.map((sessions) => sessions.find((session) => session.threadId === threadId)));

    const startProviderSession = (resumeCursor?: unknown) =>
      providerService.startSession(threadId, {
        ...providerSessionOptions,
        ...(preferredProvider ? { provider: preferredProvider } : {}),
        ...(resumeCursor !== undefined ? { resumeCursor } : {}),
      });

    const bindSessionToThread = (session: ProviderSession) =>
      setThreadSession({
        threadId,
        session: {
          threadId,
          status:
            session.status === "connecting"
              ? "starting"
              : session.status === "closed"
                ? "stopped"
                : session.status,
          providerName: session.provider,
          runtimeMode: desiredRuntimeMode,
          // Provider turn ids are not orchestration turn ids.
          activeTurnId: null,
          lastError: session.lastError ?? null,
          updatedAt: session.updatedAt,
        },
        ...(thread.session !== null ? { expectedSession: thread.session } : {}),
        createdAt,
      }).pipe(
        // startSession/resume can publish lifecycle state before returning.
        // If that newer provider event wins the CAS, its projection is already
        // authoritative and rebinding the older returned snapshot must not fail
        // the pending turn or overwrite the newer lifecycle state.
        Effect.catchTag("OrchestrationCommandInvariantError", () => Effect.void),
      );

    // Only reuse projected session state when the runtime still has a live session to attach to.
    const activeSession = yield* resolveActiveSession(threadId);
    if (activeSession && thread.forkSourceThreadId && thread.session === null) {
      const persistedIdentity = providerNativeResumeIdentity(
        desiredModelSelection.provider,
        options?.nativeResumeCursor,
      );
      const activeIdentity = providerNativeResumeIdentity(
        desiredModelSelection.provider,
        activeSession.resumeCursor,
      );
      if (
        activeSession.provider !== desiredModelSelection.provider ||
        persistedIdentity === null ||
        activeIdentity !== persistedIdentity
      ) {
        return yield* new ProviderAdapterValidationError({
          provider: desiredModelSelection.provider,
          operation: "thread.fork.create",
          issue: "The admitted native fork session does not match its exact persisted identity.",
        });
      }
      threadSessionModelSelections.set(threadId, desiredModelSelection);
      if (options?.bindingRevision !== undefined) {
        threadManagedBindingRevisions.set(threadId, options.bindingRevision);
      }
      yield* bindSessionToThread(activeSession);
      return threadId;
    }
    if (!activeSession && thread.forkSourceThreadId && options?.nativeResumeCursor !== undefined) {
      const resumed = yield* startProviderSession(options.nativeResumeCursor);
      const persistedIdentity = providerNativeResumeIdentity(
        desiredModelSelection.provider,
        options.nativeResumeCursor,
      );
      const resumedIdentity = providerNativeResumeIdentity(
        desiredModelSelection.provider,
        resumed.resumeCursor,
      );
      if (persistedIdentity === null || resumedIdentity !== persistedIdentity) {
        yield* providerService.stopSession({ threadId }).pipe(Effect.ignore);
        return yield* new ProviderAdapterValidationError({
          provider: desiredModelSelection.provider,
          operation: "thread.fork.create",
          issue: "The provider did not resume the exact admitted native fork identity.",
        });
      }
      threadSessionModelSelections.set(threadId, desiredModelSelection);
      if (options.bindingRevision !== undefined) {
        threadManagedBindingRevisions.set(threadId, options.bindingRevision);
      }
      yield* bindSessionToThread(resumed);
      return threadId;
    }
    const existingSessionThreadId =
      thread.session && thread.session.status !== "stopped" && activeSession ? thread.id : null;
    if (existingSessionThreadId) {
      const runtimeModeChanged = desiredRuntimeMode !== thread.session?.runtimeMode;
      const providerChanged =
        requestedModelSelection !== undefined &&
        requestedModelSelection.provider !== currentProvider;
      const sessionModelSwitch =
        currentProvider === undefined
          ? "in-session"
          : (yield* providerService.getCapabilities(currentProvider)).sessionModelSwitch;
      const modelChanged =
        requestedModelSelection !== undefined &&
        requestedModelSelection.model !== activeSession?.model;
      const shouldRestartForModelChange = modelChanged && sessionModelSwitch === "restart-session";
      const previousModelSelection = threadSessionModelSelections.get(threadId);
      // Claude restarts resume via `--resume`, which replays the whole conversation
      // as uncached input tokens. Only spawn-fixed options (currently `max` effort)
      // may force that; model and context-window changes switch in-session via
      // setModel, and effort/fastMode/ultracode/thinking apply via flag settings.
      // When the dispatch cache has no entry (the session was started by a turn
      // without a selection), compare against the projected thread selection the
      // session was actually spawned from so spawn-fixed changes still restart.
      const shouldRestartForModelSelectionChange =
        requestedModelSelection !== undefined &&
        (currentProvider === "claudeAgent"
          ? claudeSelectionRequiresRestart(
              previousModelSelection ?? thread.modelSelection,
              requestedModelSelection,
            )
          : false);
      const managedBindingChanged =
        options?.bindingRevision !== undefined &&
        threadManagedBindingRevisions.get(threadId) !== options.bindingRevision;

      if (
        !runtimeModeChanged &&
        !providerChanged &&
        !shouldRestartForModelChange &&
        !shouldRestartForModelSelectionChange &&
        !managedBindingChanged
      ) {
        return existingSessionThreadId;
      }

      const resumeCursor =
        options?.nativeResumeCursor ??
        (providerChanged || shouldRestartForModelChange || runtimeModeChanged
          ? undefined
          : (activeSession?.resumeCursor ?? undefined));
      yield* Effect.logInfo("provider command reactor restarting provider session", {
        threadId,
        existingSessionThreadId,
        currentProvider,
        desiredProvider: desiredModelSelection.provider,
        currentRuntimeMode: thread.session?.runtimeMode,
        desiredRuntimeMode,
        runtimeModeChanged,
        providerChanged,
        modelChanged,
        shouldRestartForModelChange,
        shouldRestartForModelSelectionChange,
        hasResumeCursor: resumeCursor !== undefined,
      });
      const restartedSession = yield* startProviderSession(resumeCursor);
      threadSessionModelSelections.set(threadId, desiredModelSelection);
      if (options?.bindingRevision !== undefined) {
        threadManagedBindingRevisions.set(threadId, options.bindingRevision);
      }
      yield* Effect.logInfo("provider command reactor restarted provider session", {
        threadId,
        previousSessionId: existingSessionThreadId,
        restartedSessionThreadId: restartedSession.threadId,
        provider: restartedSession.provider,
        runtimeMode: restartedSession.runtimeMode,
      });
      yield* bindSessionToThread(restartedSession);
      return restartedSession.threadId;
    }

    if (thread.forkSourceThreadId) {
      if (!providerService.forkThread) {
        return yield* new ProviderAdapterValidationError({
          provider: preferredProvider,
          operation: "thread.fork.create",
          issue: "This provider does not support exact native thread forks.",
        });
      }
      const forked = yield* providerService.forkThread({
        ...providerSessionOptions,
        sourceThreadId: thread.forkSourceThreadId,
      });
      if (!forked) {
        return yield* new ProviderAdapterValidationError({
          provider: preferredProvider,
          operation: "thread.fork.create",
          issue: "The provider could not create an exact native thread fork.",
        });
      }
      threadSessionModelSelections.set(threadId, desiredModelSelection);
      const forkedSession =
        (yield* resolveActiveSession(threadId)) ??
        ({
          provider: preferredProvider,
          status: "ready",
          runtimeMode: desiredRuntimeMode,
          ...(effectiveCwd ? { cwd: effectiveCwd } : {}),
          model: desiredModelSelection.model,
          threadId,
          ...(forked.resumeCursor !== undefined ? { resumeCursor: forked.resumeCursor } : {}),
          createdAt,
          updatedAt: createdAt,
        } satisfies ProviderSession);
      yield* bindSessionToThread(forkedSession);
      return threadId;
    }

    const startedSession = yield* startProviderSession(options?.nativeResumeCursor);
    // Record the exact selection the session was spawned with so later
    // restart-necessity checks compare against the live spawn state even when
    // the spawning dispatch carried no explicit model selection.
    threadSessionModelSelections.set(threadId, desiredModelSelection);
    if (options?.bindingRevision !== undefined) {
      threadManagedBindingRevisions.set(threadId, options.bindingRevision);
    }
    yield* bindSessionToThread(startedSession);
    return startedSession.threadId;
  });

  const hasTurnStartCancellationRequest = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly messageId: string;
    readonly afterSequence: number;
  }) {
    // An interrupted session is also the expected handoff state for a
    // non-native steer. Only an interrupt that explicitly names this pending
    // message cancels its start; treating the session status alone as a cancel
    // deletes the promoted steering message instead of dispatching it.
    const throughSequence = yield* orchestrationEngine.getEventHighWaterSequence;
    if (throughSequence <= input.afterSequence) {
      return false;
    }
    const events = yield* Stream.runCollect(
      orchestrationEngine.readEventsThrough(input.afterSequence, throughSequence),
    );
    return Array.from(events).some(
      (event) =>
        event.type === "thread.turn-interrupt-requested" &&
        event.payload.threadId === input.threadId &&
        event.payload.pendingMessageId === input.messageId,
    );
  });

  const completeCancelledTurnStart = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly messageId: string;
    readonly createdAt: string;
  }) {
    if (providerService.stopRuntimeSession) {
      yield* providerService
        .stopRuntimeSession({ threadId: input.threadId })
        .pipe(Effect.catch(() => Effect.void));
    }
    yield* orchestrationEngine.dispatch({
      type: "thread.turn.start.cancel.complete",
      commandId: serverCommandId("turn-start-cancel-complete"),
      threadId: input.threadId,
      messageId: MessageId.makeUnsafe(input.messageId),
      createdAt: input.createdAt,
    });
    completedPendingTurnStartInterrupts.add(input.messageId);
  });

  const dispatchTurnForThread = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly messageId: string;
    readonly messageText: string;
    readonly attachments?: ReadonlyArray<ChatAttachment>;
    readonly skills?: ReadonlyArray<ProviderSkillReference>;
    readonly mentions?: ReadonlyArray<ProviderMentionReference>;
    readonly reviewTarget?: ProviderReviewTarget;
    readonly modelSelection?: ModelSelection;
    readonly connectionId?: ProviderConnectionId | null;
    readonly bindingRevision?: number;
    readonly providerOptions?: ProviderStartOptions;
    readonly runtimeMode?: RuntimeMode;
    readonly dispatchMode?: "queue" | "steer";
    readonly createdAt: string;
    readonly startRequestSequence: number;
  }) {
    const thread = yield* resolveThread(input.threadId);
    if (!thread) {
      return;
    }
    const threadMentionProjection = yield* resolveThreadMentionPromptProjection({
      mentions: input.mentions,
      snapshotQuery: projectionSnapshotQuery,
      maxTotalContextChars: availableThreadMentionContextChars(input.messageText),
    });
    const messageText = appendThreadMentionContextBlocks({
      text: input.messageText,
      contextBlocks: threadMentionProjection.contextBlocks,
    });
    const mentionContextSuffix = threadMentionContextSuffix(threadMentionProjection.contextBlocks);
    const providerMentions = threadMentionProjection.providerMentions;
    // Subagent threads have no provider session of their own: their messages
    // steer the running child task through the parent session (mirrors the
    // interrupt seam), never the session-bootstrap path below. Parent metadata
    // may be absent on older/local-only rows, so synthetic ids use the same
    // projection-backed parent inference as interrupt routing.
    const providerThread = yield* resolveProviderSessionThread(input.threadId);
    const subagentProviderThreadId = providerThread
      ? resolveSubagentProviderThreadId(thread.id, providerThread.id)
      : undefined;
    if (providerThread && subagentProviderThreadId) {
      // Parity with the steerTurn path below: inline portable skill
      // instructions, normalize skill/agent mentions, and forward the
      // structured context so the adapter can project attachments into the
      // text-only subagent steering channel.
      const steerProvider = (providerThread.session?.providerName ??
        providerThread.modelSelection.provider) as ProviderKind;
      const steerSkillInlineText =
        input.skills !== undefined && input.skills.length > 0
          ? yield* Effect.tryPromise(() =>
              buildInlineSkillInstructions({
                provider: steerProvider,
                skills: input.skills ?? [],
                maxChars: Math.max(
                  0,
                  PROVIDER_SEND_TURN_MAX_INPUT_CHARS -
                    messageText.length -
                    PROVIDER_INPUT_SAFETY_MARGIN_CHARS,
                ),
              }),
            ).pipe(
              Effect.catch((error) =>
                Effect.logWarning("failed to inline portable skill instructions", {
                  threadId: input.threadId,
                  error,
                }).pipe(Effect.as("")),
              ),
            )
          : "";
      const steerMessageWithSkills = steerSkillInlineText
        ? `${messageText}\n\n${steerSkillInlineText}`
        : messageText;
      const normalizedSteerInput = toNonEmptyProviderInput(
        normalizeSkillMentionTextForProvider({
          provider: steerProvider,
          messageText: steerMessageWithSkills,
          ...(input.skills !== undefined ? { skills: input.skills } : {}),
        }),
      );
      const normalizedSteerAttachments = yield* resolveProviderDispatchAttachments({
        attachments: input.attachments,
        attachmentsDir: serverConfig.attachmentsDir,
        repository: managedAttachments,
        threadId: input.threadId,
        messageId: input.messageId,
        provider: steerProvider,
        operation: "thread.turn.start",
      });
      yield* providerService.steerSubagent({
        threadId: providerThread.id,
        providerThreadId: subagentProviderThreadId,
        ...(normalizedSteerInput ? { input: normalizedSteerInput } : {}),
        ...(normalizedSteerAttachments.length > 0
          ? { attachments: normalizedSteerAttachments }
          : {}),
        ...(input.skills !== undefined ? { skills: input.skills } : {}),
        ...(providerMentions !== undefined ? { mentions: providerMentions } : {}),
      });
      return;
    }
    const managedRuntime = yield* resolveManagedTurnRuntime({
      threadId: input.threadId,
      ...(input.modelSelection !== undefined ? { modelSelection: input.modelSelection } : {}),
      ...(input.connectionId !== undefined ? { connectionId: input.connectionId } : {}),
      ...(input.bindingRevision !== undefined ? { bindingRevision: input.bindingRevision } : {}),
    });
    yield* ensureSessionForThread(input.threadId, input.createdAt, {
      ...(input.modelSelection !== undefined ? { modelSelection: input.modelSelection } : {}),
      ...(input.providerOptions !== undefined ? { providerOptions: input.providerOptions } : {}),
      ...(input.runtimeMode !== undefined ? { runtimeMode: input.runtimeMode } : {}),
      ...(managedRuntime === null
        ? {}
        : {
            managedLaunch: managedRuntime.managedLaunch,
            nativeResumeCursor: managedRuntime.resumeCursor,
            bindingRevision: managedRuntime.bindingRevision,
          }),
    }).pipe(
      Effect.catch((error) =>
        hasTurnStartCancellationRequest({
          threadId: input.threadId,
          messageId: input.messageId,
          afterSequence: input.startRequestSequence,
        }).pipe(Effect.flatMap((cancelled) => (cancelled ? Effect.void : Effect.fail(error)))),
      ),
    );
    if (
      yield* hasTurnStartCancellationRequest({
        threadId: input.threadId,
        messageId: input.messageId,
        afterSequence: input.startRequestSequence,
      })
    ) {
      yield* completeCancelledTurnStart(input);
      return;
    }
    if (input.providerOptions !== undefined) {
      threadProviderOptions.set(input.threadId, input.providerOptions);
    }
    if (input.modelSelection !== undefined) {
      threadSessionModelSelections.set(input.threadId, input.modelSelection);
    }
    const selectedProvider =
      input.modelSelection?.provider ??
      threadSessionModelSelections.get(input.threadId)?.provider ??
      thread.session?.providerName ??
      thread.modelSelection.provider;
    const providerInputWithMentionContext = `${input.messageText}${mentionContextSuffix}`;
    // Portable skills fallback: providers that cannot load the referenced skill
    // file natively get the skill instructions inlined into the prompt.
    const skillInlineText =
      input.skills !== undefined && input.skills.length > 0
        ? yield* Effect.tryPromise(() =>
            buildInlineSkillInstructions({
              provider: selectedProvider as ProviderKind,
              skills: input.skills ?? [],
              maxChars: Math.max(
                0,
                PROVIDER_SEND_TURN_MAX_INPUT_CHARS -
                  providerInputWithMentionContext.length -
                  PROVIDER_INPUT_SAFETY_MARGIN_CHARS,
              ),
            }),
          ).pipe(
            Effect.catch((error) =>
              Effect.logWarning("failed to inline portable skill instructions", {
                threadId: input.threadId,
                error,
              }).pipe(Effect.as("")),
            ),
          )
        : "";
    const providerInputWithSkills = skillInlineText
      ? `${providerInputWithMentionContext}\n\n${skillInlineText}`
      : providerInputWithMentionContext;
    const normalizedInput = toNonEmptyProviderInput(
      normalizeSkillMentionTextForProvider({
        provider: selectedProvider as ProviderKind,
        messageText: providerInputWithSkills,
        ...(input.skills !== undefined ? { skills: input.skills } : {}),
      }),
    );
    const normalizedAttachments = yield* resolveProviderDispatchAttachments({
      attachments: input.attachments,
      attachmentsDir: serverConfig.attachmentsDir,
      repository: managedAttachments,
      threadId: input.threadId,
      messageId: input.messageId,
      provider: selectedProvider as ProviderKind,
      operation: "thread.turn.start",
    });
    const activeSession = yield* providerService
      .listSessions()
      .pipe(
        Effect.map((sessions) => sessions.find((session) => session.threadId === input.threadId)),
      );
    const sessionModelSwitch =
      activeSession === undefined
        ? "in-session"
        : (yield* providerService.getCapabilities(activeSession.provider)).sessionModelSwitch;
    const requestedModelSelection = input.modelSelection ?? thread.modelSelection;
    const modelForTurn =
      sessionModelSwitch === "unsupported"
        ? activeSession?.model !== undefined
          ? {
              ...requestedModelSelection,
              model: activeSession.model,
            }
          : requestedModelSelection
        : requestedModelSelection;
    const providerTurnInput = {
      threadId: input.threadId,
      clientMessageId: MessageId.makeUnsafe(input.messageId),
      ...(normalizedAttachments.length > 0 ? { attachments: normalizedAttachments } : {}),
      ...(input.skills !== undefined ? { skills: input.skills } : {}),
      ...(providerMentions !== undefined ? { mentions: providerMentions } : {}),
      ...(modelForTurn !== undefined ? { modelSelection: modelForTurn } : {}),
    };
    const sendQueuedProviderTurn = (messageText: string | undefined) =>
      providerService.sendTurn({
        ...providerTurnInput,
        ...(messageText ? { input: messageText } : {}),
      });

    let startedTurn: ProviderTurnStartResult | undefined;

    if (input.reviewTarget !== undefined) {
      startedTurn = yield* providerService.startReview({
        threadId: input.threadId,
        target: input.reviewTarget,
      });
    } else if (input.dispatchMode === "steer") {
      startedTurn = yield* providerService.steerTurn({
        ...providerTurnInput,
        ...(normalizedInput ? { input: normalizedInput } : {}),
      });
    } else {
      const ensureSessionForStaleRetry = ensureSessionForThread(input.threadId, input.createdAt, {
        ...(input.modelSelection !== undefined ? { modelSelection: input.modelSelection } : {}),
        ...(input.providerOptions !== undefined ? { providerOptions: input.providerOptions } : {}),
        ...(input.runtimeMode !== undefined ? { runtimeMode: input.runtimeMode } : {}),
        ...(managedRuntime === null
          ? {}
          : {
              managedLaunch: managedRuntime.managedLaunch,
              nativeResumeCursor: managedRuntime.resumeCursor,
              bindingRevision: managedRuntime.bindingRevision,
            }),
      });
      if (
        yield* hasTurnStartCancellationRequest({
          threadId: input.threadId,
          messageId: input.messageId,
          afterSequence: input.startRequestSequence,
        })
      ) {
        yield* completeCancelledTurnStart(input);
        return;
      }
      const sentTurn = yield* sendQueuedProviderTurn(normalizedInput).pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            if (selectedProvider !== "claudeAgent" || !isStaleClaudeResumeError(error)) {
              return yield* Effect.fail(error);
            }

            // Stale-resume errors can be transient CLI/session-file races. Retry
            // the exact native resume once; never reconstruct provider context
            // from Penkra's projected transcript.
            if (!providerService.stopRuntimeSession) {
              return yield* Effect.fail(error);
            }
            // Background tasks share the runtime subprocess with the parent turn,
            // so an exact native retry cannot safely stop this runtime yet.
            const liveBackgroundTasks = providerService.hasLiveRuntimeTasks
              ? yield* providerService.hasLiveRuntimeTasks({ threadId: input.threadId })
              : false;
            if (liveBackgroundTasks) {
              yield* Effect.logWarning(
                "provider command reactor skipping native resume retry: live background tasks",
                {
                  threadId: input.threadId,
                  messageId: input.messageId,
                },
              );
              return yield* Effect.fail(error);
            }
            yield* providerService
              .stopRuntimeSession({ threadId: input.threadId })
              .pipe(Effect.catch(() => Effect.void));
            yield* ensureSessionForStaleRetry;
            yield* Effect.logWarning(
              "provider command reactor retrying claude turn with native resume",
              {
                threadId: input.threadId,
                messageId: input.messageId,
              },
            );
            return yield* sendQueuedProviderTurn(normalizedInput);
          }),
        ),
      );
      startedTurn = sentTurn;
      if (
        yield* hasTurnStartCancellationRequest({
          threadId: input.threadId,
          messageId: input.messageId,
          afterSequence: input.startRequestSequence,
        })
      ) {
        yield* providerService.interruptTurn({
          threadId: input.threadId,
          turnId: sentTurn.turnId,
        });
        completedPendingTurnStartInterrupts.add(input.messageId);
        yield* settleInterruptedProviderTurn({
          threadId: input.threadId,
          createdAt: new Date().toISOString(),
        });
      }
    }
    return startedTurn;
  });

  const resolveFirstTurnThread = Effect.fnUntraced(function* (
    threadId: ThreadId,
    messageId: string,
  ) {
    const thread = yield* resolveThread(threadId);
    if (!thread) return null;
    const userMessages = thread.messages.filter(
      (message) => message.role === "user" && message.source === "native",
    );
    return userMessages.length === 1 && userMessages[0]?.id === messageId ? thread : null;
  });

  // Only auto-rename placeholder titles that still reflect the first-turn draft state.
  const maybeGenerateAndRenameThreadTitleForFirstTurn = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly messageId: string;
    readonly messageText: string;
    readonly attachments?: ReadonlyArray<ChatAttachment>;
    readonly modelSelection?: ModelSelection;
    readonly connectionId?: ProviderConnectionId | null;
    readonly bindingRevision?: number;
    readonly providerOptions?: ProviderStartOptions;
  }) {
    const thread = yield* resolveFirstTurnThread(input.threadId, input.messageId);
    if (!thread) return;

    const fallbackTitle = buildPromptThreadTitleFallback(
      input.messageText.trim() || attachmentTitleSeed(input.attachments?.[0]) || "",
    );
    const currentTitle = thread.title.trim();
    if (!isGenericChatThreadTitle(currentTitle) && currentTitle !== fallbackTitle) {
      return;
    }
    const cwd = yield* resolveProjectedThreadWorkspaceCwd(thread);
    const textGenerationInput = yield* resolveThreadTextGenerationInput({
      threadId: input.threadId,
      ...(input.modelSelection ? { modelSelection: input.modelSelection } : {}),
      ...(input.providerOptions ? { providerOptions: input.providerOptions } : {}),
    });
    if (!textGenerationInput) {
      return;
    }
    const managedRuntime = yield* resolveManagedTurnRuntime({
      threadId: input.threadId,
      ...(input.modelSelection !== undefined ? { modelSelection: input.modelSelection } : {}),
      ...(input.connectionId !== undefined ? { connectionId: input.connectionId } : {}),
      ...(input.bindingRevision !== undefined ? { bindingRevision: input.bindingRevision } : {}),
    });
    const textGenerationSelection = textGenerationInput.modelSelection;
    const textGenerationLogContext = {
      threadId: input.threadId,
      cwd,
      threadProvider: thread.modelSelection.provider,
      threadModel: thread.modelSelection.model,
      requestedProvider: input.modelSelection?.provider ?? null,
      requestedModel: input.modelSelection?.model ?? null,
      textGenerationProvider: textGenerationSelection.provider,
      textGenerationModel: textGenerationSelection.model,
      textGenerationOptions: textGenerationSelection.options ?? null,
    };
    yield* Effect.logDebug("provider command reactor generating thread title", {
      ...textGenerationLogContext,
      hasProviderOptions: Boolean(textGenerationInput.providerOptions),
    });
    const titleGenerationInput: ThreadTitleGenerationInput = {
      cwd: cwd ?? process.cwd(),
      message: input.messageText,
      ...(input.attachments?.length ? { attachments: input.attachments } : {}),
      modelSelection: textGenerationInput.modelSelection,
      managedLaunch: managedRuntime.managedLaunch,
      ...(textGenerationInput.providerOptions
        ? { providerOptions: textGenerationInput.providerOptions }
        : {}),
    };
    const nextTitle = yield* textGeneration.generateThreadTitle(titleGenerationInput).pipe(
      Effect.map((generated) => generated.title),
      Effect.catch((error) =>
        Effect.logWarning("provider command reactor failed to generate thread title", {
          ...textGenerationLogContext,
          reason: error.message,
        }).pipe(Effect.as(currentTitle)),
      ),
    );

    if (nextTitle === currentTitle) {
      return;
    }

    yield* orchestrationEngine.dispatch({
      type: "thread.update",
      commandId: serverCommandId("thread-title-rename"),
      threadId: input.threadId,
      title: nextTitle,
    });
  });

  const processTurnStartRequestedWithoutLease = Effect.fnUntraced(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.turn-start-requested" }>,
  ) {
    const sessionThreadId =
      (yield* resolveProviderSessionThread(event.payload.threadId))?.id ?? event.payload.threadId;
    const matchesEvent = (entry: PendingQueuedDispatch | undefined) =>
      entry?.queuedThreadId === (event.payload.threadId as string) &&
      entry.messageId === event.payload.messageId;
    const reservationAtStart = pendingQueuedDispatchBySessionThread.get(sessionThreadId);
    const isPendingQueuedDispatch = matchesEvent(reservationAtStart);
    const ownsReservation = (entry: PendingQueuedDispatch | undefined) =>
      isPendingQueuedDispatch && entry === reservationAtStart;
    const clearPendingQueuedDispatch = Effect.sync(() => {
      if (ownsReservation(pendingQueuedDispatchBySessionThread.get(sessionThreadId))) {
        pendingQueuedDispatchBySessionThread.delete(sessionThreadId);
      }
    });
    const bindPendingQueuedDispatchToTurn = Effect.fnUntraced(function* (turnId: TurnId) {
      const reservation = pendingQueuedDispatchBySessionThread.get(sessionThreadId);
      if (reservation === undefined || !ownsReservation(reservation)) {
        return;
      }
      reservation.releaseOnTurnId = turnId;
      const completedBeforeBinding = reservation.pendingTerminalTurnIds?.has(turnId);
      delete reservation.pendingTerminalTurnIds;
      if (completedBeforeBinding) {
        pendingQueuedDispatchBySessionThread.delete(sessionThreadId);
        yield* drainQueuedTurnsForSession(event.payload.threadId);
      }
    });
    // Safety net for a promoted queued dispatch that never reaches a turn. While
    // this reservation is present, `drainQueuedTurnsForThread` early-returns for
    // every thread on this provider session, and an unbound reservation also
    // absorbs terminal turn events instead of draining — so leaking it strands
    // the thread's queued messages until the process restarts.
    //
    // `Effect.onExit`, never a JS `finally`: a generator driven by
    // `Effect.fnUntraced` is not resumed when a yielded effect fails or is
    // interrupted, so a `finally` here would simply never run on those paths.
    // `onExit` rather than `ensuring` because this release is itself fallible
    // and must keep propagating its errors, exactly as the `finally` did.
    const releaseOrphanedQueuedDispatchReservation = (redrain: boolean) =>
      Effect.gen(function* () {
        const reservation = pendingQueuedDispatchBySessionThread.get(sessionThreadId);
        if (
          !isPendingQueuedDispatch ||
          reservation === undefined ||
          !ownsReservation(reservation) ||
          reservation.releaseOnTurnId !== undefined
        ) {
          return;
        }
        if (yield* hasQueuedTurnStart(event.payload.threadId, event.payload.messageId)) {
          return;
        }
        const liveTurnId = yield* resolveLiveProviderTurnId(event.payload.threadId);
        if (liveTurnId !== undefined) {
          yield* bindPendingQueuedDispatchToTurn(liveTurnId);
          return;
        }
        yield* clearPendingQueuedDispatch;
        if (redrain) {
          yield* drainQueuedTurnsForSession(event.payload.threadId);
        }
      });
    yield* Effect.gen(function* () {
      const key = turnStartKeyForEvent(event);
      if (yield* hasHandledTurnStartRecently(key)) {
        return;
      }

      const thread = yield* resolveThread(event.payload.threadId);
      if (!thread) {
        return;
      }

      const isRestartRecovery =
        event.payload.restartRecovery || event.payload.recoveryOfTurnId !== undefined;
      const message = isRestartRecovery
        ? {
            id: event.payload.messageId,
            role: "user" as const,
            text: RESTART_TURN_RECOVERY_PROMPT,
            attachments: [] as ReadonlyArray<ChatAttachment>,
            skills: undefined,
            mentions: undefined,
          }
        : thread.messages.find((entry) => entry.id === event.payload.messageId);
      if (!message || message.role !== "user") {
        yield* appendProviderFailureActivity({
          threadId: event.payload.threadId,
          kind: "provider.turn.start.failed",
          summary: "Provider turn start failed",
          detail: `User message '${event.payload.messageId}' was not found for turn start request.`,
          turnId: null,
          createdAt: event.payload.createdAt,
        });
        return;
      }

      // The decider routes turn starts from the projected session, which can lag
      // the runtime: a message dispatched right as another turn begins (e.g. the
      // gap between a steer interrupt and the steered turn's start) would race a
      // live provider turn. Providers with live-input steering ride the current
      // turn; OpenCode re-queues and promotes after the interrupted turn settles.
      const providerName = thread.session?.providerName ?? thread.modelSelection.provider;
      const liveTurnId = yield* resolveLiveProviderTurnId(event.payload.threadId);
      const hasLiveTurn = liveTurnId !== undefined;
      // Steering is only meaningful against a live turn. The projection can
      // lag the runtime in the other direction too (turn already settled but
      // still projected as running), so recheck live state and dispatch a
      // settled "steer" as a normal queued turn.
      const isNativeSteer =
        event.payload.dispatchMode === "steer" &&
        providerSupportsNativeTurnSteering(providerName) &&
        hasLiveTurn;
      if (isRestartRecovery && hasLiveTurn) {
        // Recovery admission only follows restart reconciliation, which settles
        // the dead turn first. If a newer live turn won the race, it is already
        // the continuation and must not receive a duplicate internal prompt.
        return;
      }
      if (!isNativeSteer && hasLiveTurn) {
        yield* enqueueQueuedTurnStart(event);
        // The promotion raced another live turn and was re-queued. Release
        // only when that exact blocking turn settles, not on any late
        // terminal event for the shared provider session.
        yield* bindPendingQueuedDispatchToTurn(liveTurnId);
        if (event.payload.dispatchMode === "steer") {
          // Preserve steer semantics: jump the queue (enqueue unshifts steers)
          // and ask the live turn to stop so the steer dispatches next.
          yield* interruptProviderTurn({
            threadId: event.payload.threadId,
            createdAt: event.payload.createdAt,
          });
        }
        return;
      }

      // Surface the upcoming work immediately: provider session init can take
      // seconds (e.g. Cursor), and without an early status the thread reads as
      // idle until the runtime's first event. Mirrors the message-edit-resend
      // path. Never touches a live session — a steer turn on a running Codex
      // session must keep its running state and activeTurnId. Keeps the existing
      // session's runtimeMode: ensureSessionForThread detects mode changes by
      // comparing against it, and adopting the requested mode here would mask
      // the restart.
      const turnStartSession = deriveTurnStartSession({
        threadId: event.payload.threadId,
        currentSession: thread.session,
        providerName,
        requestedRuntimeMode: event.payload.runtimeMode ?? DEFAULT_RUNTIME_MODE,
        requestedAt: event.payload.createdAt,
      });
      if (turnStartSession !== null) {
        yield* setThreadSession({
          threadId: event.payload.threadId,
          session: turnStartSession,
          createdAt: event.payload.createdAt,
        });
      }

      const resolvedAttachments = yield* resolveProviderDispatchAttachments({
        attachments: message.attachments,
        attachmentsDir: serverConfig.attachmentsDir,
        repository: managedAttachments,
        threadId: event.payload.threadId,
        messageId: message.id,
        provider: providerName as ProviderKind,
        operation: "thread.turn.start",
      });

      if (!isRestartRecovery) {
        yield* maybeGenerateAndRenameThreadTitleForFirstTurn({
          threadId: event.payload.threadId,
          messageId: message.id,
          messageText: message.text,
          ...(message.attachments !== undefined ? { attachments: resolvedAttachments } : {}),
          ...(event.payload.modelSelection !== undefined
            ? { modelSelection: event.payload.modelSelection }
            : {}),
          ...(event.payload.connectionId !== undefined
            ? { connectionId: event.payload.connectionId }
            : {}),
          ...(event.payload.bindingRevision !== undefined
            ? { bindingRevision: event.payload.bindingRevision }
            : {}),
          ...(event.payload.providerOptions !== undefined
            ? { providerOptions: event.payload.providerOptions }
            : {}),
        }).pipe(Effect.forkScoped);
      }
      // Only a native steer against a genuinely live turn keeps steer
      // semantics; anything else that reaches direct dispatch runs as a
      // normal queued turn.
      const immediateDispatchMode =
        event.payload.dispatchMode === "steer" && !isNativeSteer
          ? "queue"
          : event.payload.dispatchMode;
      const editResendKey = editResendTurnStartKey(event.payload.threadId, event.payload.messageId);

      const startedTurn = yield* dispatchTurnForThread({
        threadId: event.payload.threadId,
        messageId: message.id,
        messageText: message.text,
        ...(message.attachments !== undefined ? { attachments: resolvedAttachments } : {}),
        ...(message.skills !== undefined ? { skills: message.skills } : {}),
        ...(message.mentions !== undefined ? { mentions: message.mentions } : {}),
        ...(event.payload.modelSelection !== undefined
          ? { modelSelection: event.payload.modelSelection }
          : {}),
        ...(event.payload.connectionId !== undefined
          ? { connectionId: event.payload.connectionId }
          : {}),
        ...(event.payload.bindingRevision !== undefined
          ? { bindingRevision: event.payload.bindingRevision }
          : {}),
        ...(event.payload.providerOptions !== undefined
          ? { providerOptions: event.payload.providerOptions }
          : {}),
        ...(event.payload.runtimeMode !== undefined
          ? { runtimeMode: event.payload.runtimeMode }
          : {}),
        ...(event.payload.reviewTarget !== undefined
          ? { reviewTarget: event.payload.reviewTarget }
          : {}),
        dispatchMode: immediateDispatchMode,
        createdAt: event.payload.createdAt,
        startRequestSequence: event.sequence,
      }).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : Effect.gen(function* () {
                const detail = Cause.pretty(cause);
                if (!isRestartRecovery) {
                  yield* orchestrationEngine.dispatch({
                    type: "thread.message.delivery.set",
                    commandId: replaySafeServerCommandId("message-delivery-failed", event.eventId),
                    threadId: event.payload.threadId,
                    messageId: event.payload.messageId,
                    state: "failed",
                    createdAt: new Date().toISOString(),
                  });
                }
                yield* appendProviderFailureActivity({
                  threadId: event.payload.threadId,
                  kind: "provider.turn.start.failed",
                  summary: "Provider turn start failed",
                  detail,
                  turnId: null,
                  createdAt: event.payload.createdAt,
                });
                yield* setThreadSessionError({
                  threadId: event.payload.threadId,
                  runtimeMode: event.payload.runtimeMode,
                  detail,
                  createdAt: event.payload.createdAt,
                });
                // A direct start has no provider turn and therefore cannot emit a
                // terminal runtime event. Recover every queue sharing this
                // provider session now; otherwise follow-ups queued before the
                // failure remain stranded indefinitely (including child threads
                // multiplexed onto their parent's provider session).
                if (isPendingQueuedDispatch) {
                  yield* clearPendingQueuedDispatch;
                }
                yield* drainQueuedTurnsForSession(event.payload.threadId);
                return yield* Effect.failCause(cause);
              }),
        ),
        Effect.ensuring(Effect.sync(() => editResendTurnStartKeys.delete(editResendKey))),
      );
      if (startedTurn && isRestartRecovery) {
        const acceptedAt = new Date().toISOString();
        yield* setThreadSession({
          threadId: event.payload.threadId,
          session: {
            threadId: event.payload.threadId,
            status: "running",
            providerName,
            runtimeMode: event.payload.runtimeMode,
            activeTurnId: startedTurn.turnId,
            lastError: null,
            updatedAt: acceptedAt,
          },
          createdAt: acceptedAt,
        });
      }
      if (startedTurn && !isRestartRecovery) {
        yield* orchestrationEngine.dispatch({
          type: "thread.message.delivery.set",
          commandId: replaySafeServerCommandId("message-delivery-accepted", event.eventId),
          threadId: event.payload.threadId,
          messageId: event.payload.messageId,
          state: "accepted",
          createdAt: new Date().toISOString(),
        });
      }
      if (startedTurn && isPendingQueuedDispatch) {
        yield* bindPendingQueuedDispatchToTurn(startedTurn.turnId);
      }
    }).pipe(
      Effect.onExit((exit) =>
        releaseOrphanedQueuedDispatchReservation(
          Exit.isSuccess(exit) || !Cause.hasInterruptsOnly(exit.cause),
        ),
      ),
    );
  });

  const processTurnStartRequested = (
    event: Extract<ProviderIntentEvent, { type: "thread.turn-start-requested" }>,
  ) =>
    withProviderSessionLease(event.payload.threadId, processTurnStartRequestedWithoutLease(event));

  const processTurnQueued = Effect.fnUntraced(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.turn-queued" }>,
  ) {
    const isEditResend = editResendTurnStartKeys.has(
      editResendTurnStartKey(event.payload.threadId, event.payload.messageId),
    );
    yield* enqueueQueuedTurnStart(event);
    // Recovery drain: if the provider turn settled between the decider's
    // (stale) running check and this enqueue, the terminal
    // `turn.completed`/`turn.aborted` event has already been consumed and will
    // never drain this queue — the message would be stuck forever. Re-check
    // live provider state and promote immediately.
    if (!(yield* hasLiveProviderTurn(event.payload.threadId))) {
      yield* drainQueuedTurnsForThread(event.payload.threadId, {
        allowStartingSession: isEditResend,
      });
    }
  });

  const readOrchestrationEventAtSequence = (eventSequence: number) =>
    Stream.runCollect(
      orchestrationEngine.readEventsThrough(Math.max(0, eventSequence - 1), eventSequence),
    ).pipe(Effect.map((events) => Array.from(events)[0]));

  const claimQueuedTurnAction = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly messageId: MessageId;
    readonly actionKind: "cancel" | "edit" | "steer";
    readonly actionEventId: EventId;
    readonly createdAt: string;
  }) {
    return yield* queuedTurnPromotions.claimMessageAction({
      threadId: input.threadId,
      messageId: input.messageId,
      actionKind: input.actionKind,
      actionEventId: input.actionEventId,
      updatedAt: input.createdAt,
    });
  });

  const processQueuedTurnCancelRequested = (
    event: Extract<ProviderIntentEvent, { type: "thread.turn-cancel-queued-requested" }>,
  ) =>
    withProviderSessionLease(
      event.payload.threadId,
      Effect.gen(function* () {
        const pending = yield* claimQueuedTurnAction({
          ...event.payload,
          actionKind: "cancel",
          actionEventId: event.eventId,
        });
        if (Option.isNone(pending)) {
          return;
        }
        yield* orchestrationEngine.dispatch({
          type: "thread.turn.start.cancel.complete",
          commandId: replaySafeServerCommandId("queued-turn-cancel-complete", event.eventId),
          threadId: event.payload.threadId,
          messageId: event.payload.messageId,
          createdAt: event.payload.createdAt,
        });
      }),
    );

  const processQueuedTurnSteerRequested = (
    event: Extract<ProviderIntentEvent, { type: "thread.turn-steer-queued-requested" }>,
  ) =>
    withProviderSessionLease(
      event.payload.threadId,
      Effect.gen(function* () {
        const pending = yield* claimQueuedTurnAction({
          ...event.payload,
          actionKind: "steer",
          actionEventId: event.eventId,
        });
        if (Option.isNone(pending)) {
          return;
        }
        const sourceEvent = yield* readOrchestrationEventAtSequence(
          pending.value.queuedEventSequence,
        );
        if (sourceEvent?.type !== "thread.turn-queued") {
          return yield* Effect.fail(
            new Error(`Queued message '${event.payload.messageId}' has no source turn.`),
          );
        }
        const thread = yield* resolveThread(event.payload.threadId);
        const message = thread?.messages.find(
          (candidate) => candidate.id === event.payload.messageId && candidate.role === "user",
        );
        if (!thread || !message) {
          return yield* Effect.fail(
            new Error(`Queued message '${event.payload.messageId}' has no projected message.`),
          );
        }
        const readModel = yield* orchestrationEngine.getCommandReadModel();
        const cwd = resolveThreadWorkspaceCwd({
          workingDirectory: thread.workingDirectory,
          projectCwd:
            readModel.folders.find((project) => project.id === thread.folderId)?.workspaceRoot ??
            null,
        });
        const providerName = thread.session?.providerName ?? thread.modelSelection.provider;
        const providerThread = yield* resolveProviderSessionThread(event.payload.threadId);
        const sessionThreadId = providerThread?.id ?? event.payload.threadId;
        const liveTurnId = yield* resolveLiveProviderTurnId(event.payload.threadId);
        const addedSteerInterruptBarrier =
          providerName === "opencode" &&
          liveTurnId !== undefined &&
          !openCodeSteerInterruptBarriers.has(sessionThreadId);
        if (addedSteerInterruptBarrier) {
          openCodeSteerInterruptBarriers.set(sessionThreadId, liveTurnId);
        }
        yield* providerThreadSwitchCoordinator
          .dispatchTurnStart({
            command: {
              type: "thread.turn.start",
              commandId: replaySafeServerCommandId("steer-queued-turn", event.eventId),
              threadId: sourceEvent.payload.threadId,
              message: {
                messageId: sourceEvent.payload.messageId,
                role: "user",
                text: message.text,
                attachments: message.attachments ?? [],
                ...(message.skills !== undefined ? { skills: message.skills } : {}),
                ...(message.mentions !== undefined ? { mentions: message.mentions } : {}),
              },
              ...(sourceEvent.payload.modelSelection !== undefined
                ? { modelSelection: sourceEvent.payload.modelSelection }
                : {}),
              ...(sourceEvent.payload.connectionId !== undefined
                ? { connectionId: sourceEvent.payload.connectionId }
                : {}),
              ...(sourceEvent.payload.bindingRevision !== undefined
                ? { bindingRevision: sourceEvent.payload.bindingRevision }
                : {}),
              ...(sourceEvent.payload.providerOptions !== undefined
                ? { providerOptions: sourceEvent.payload.providerOptions }
                : {}),
              ...(sourceEvent.payload.reviewTarget !== undefined
                ? { reviewTarget: sourceEvent.payload.reviewTarget }
                : {}),
              ...(sourceEvent.payload.assistantDeliveryMode !== undefined
                ? { assistantDeliveryMode: sourceEvent.payload.assistantDeliveryMode }
                : {}),
              dispatchMode: "steer",
              ...(sourceEvent.payload.dispatchOrigin !== undefined
                ? { dispatchOrigin: sourceEvent.payload.dispatchOrigin }
                : {}),
              runtimeMode: sourceEvent.payload.runtimeMode,
              createdAt: event.payload.createdAt,
            },
            attachmentPrincipal: LOCAL_LOOPBACK_ATTACHMENT_PRINCIPAL,
            ...(cwd === null ? {} : { cwd }),
          })
          .pipe(
            Effect.onError(() =>
              Effect.sync(() => {
                if (addedSteerInterruptBarrier) {
                  openCodeSteerInterruptBarriers.delete(sessionThreadId);
                }
              }),
            ),
          );
      }),
    );

  // Promote the next queued message only after the active provider turn settles.
  const drainQueuedTurnsForThread = Effect.fnUntraced(function* (
    threadId: ThreadId,
    options?: { readonly allowStartingSession?: boolean },
  ) {
    const providerThread = yield* resolveProviderSessionThread(threadId);
    const sessionThreadId = providerThread?.id ?? threadId;
    // A queued follow-up can arrive while the predecessor is admitted but has
    // not acquired a provider turn id yet. Hold it durably through that startup
    // boundary; terminal/startup-failure handling will invoke the drain again.
    if (providerThread?.session?.status === "starting" && options?.allowStartingSession !== true) {
      return;
    }
    if (
      drainingQueuedTurns.has(threadId) ||
      openCodeSteerInterruptBarriers.has(sessionThreadId) ||
      pendingQueuedDispatchBySessionThread.has(sessionThreadId)
    ) {
      return;
    }
    drainingQueuedTurns.add(threadId);
    // `Effect.ensuring`, never a JS `finally`: a generator driven by
    // `Effect.fnUntraced` does not resume to run `finally` blocks when a
    // yielded effect fails, so a failed promotion dispatch would leak this
    // in-flight guard and silently disable every later drain for the thread.
    yield* Effect.gen(function* () {
      const claimed = yield* queuedTurnPromotions.claimNext({
        threadId,
        claimOwner: queuedTurnPromotionOwner,
        claimedAt: new Date().toISOString(),
        claimExpiresAt: new Date(Date.now() + PROVIDER_COMMAND_CLAIM_LEASE_MS).toISOString(),
      });
      if (Option.isNone(claimed)) {
        return;
      }
      const promotion = claimed.value;
      yield* Effect.gen(function* () {
        const sourceEvent = yield* readOrchestrationEventAtSequence(promotion.queuedEventSequence);
        if (
          sourceEvent === undefined ||
          (sourceEvent.type !== "thread.turn-queued" &&
            sourceEvent.type !== "thread.turn-start-requested")
        ) {
          return yield* Effect.fail(
            new Error(
              `Queued turn promotion ${promotion.queuedEventSequence} has no valid source event.`,
            ),
          );
        }
        const nextQueuedTurn = sourceEvent.payload;
        pendingQueuedDispatchBySessionThread.set(sessionThreadId, {
          queuedThreadId: threadId,
          messageId: nextQueuedTurn.messageId,
        });
        yield* orchestrationEngine.dispatch({
          type: "thread.turn.dispatch-queued",
          commandId: CommandId.makeUnsafe(
            `server:dispatch-queued-turn:${promotion.queuedEventSequence}`,
          ),
          threadId,
          turnId: nextQueuedTurn.turnId ?? TurnId.makeUnsafe(`turn:${sourceEvent.commandId}`),
          messageId: nextQueuedTurn.messageId,
          ...(nextQueuedTurn.modelSelection !== undefined
            ? { modelSelection: nextQueuedTurn.modelSelection }
            : {}),
          ...(nextQueuedTurn.connectionId !== undefined
            ? { connectionId: nextQueuedTurn.connectionId }
            : {}),
          ...(nextQueuedTurn.bindingRevision !== undefined
            ? { bindingRevision: nextQueuedTurn.bindingRevision }
            : {}),
          ...(nextQueuedTurn.providerOptions !== undefined
            ? { providerOptions: nextQueuedTurn.providerOptions }
            : {}),
          ...(nextQueuedTurn.reviewTarget !== undefined
            ? { reviewTarget: nextQueuedTurn.reviewTarget }
            : {}),
          ...(nextQueuedTurn.assistantDeliveryMode !== undefined
            ? { assistantDeliveryMode: nextQueuedTurn.assistantDeliveryMode }
            : {}),
          dispatchMode: nextQueuedTurn.dispatchMode,
          ...(nextQueuedTurn.dispatchOrigin !== undefined
            ? { dispatchOrigin: nextQueuedTurn.dispatchOrigin }
            : {}),
          runtimeMode: nextQueuedTurn.runtimeMode,
          createdAt: nextQueuedTurn.createdAt,
        });
        const promoted = yield* queuedTurnPromotions.markPromoted({
          queuedEventSequence: promotion.queuedEventSequence,
          claimOwner: queuedTurnPromotionOwner,
          promotedAt: new Date().toISOString(),
        });
        if (!promoted) {
          return yield* Effect.fail(
            new Error(
              `Queued turn promotion ${promotion.queuedEventSequence} lost claim ownership.`,
            ),
          );
        }
      }).pipe(
        Effect.onError(() =>
          Effect.all([
            Effect.sync(() => pendingQueuedDispatchBySessionThread.delete(sessionThreadId)),
            queuedTurnPromotions
              .releaseClaim({
                queuedEventSequence: promotion.queuedEventSequence,
                claimOwner: queuedTurnPromotionOwner,
                updatedAt: new Date().toISOString(),
              })
              .pipe(Effect.ignore),
          ]).pipe(Effect.asVoid),
        ),
      );
    }).pipe(Effect.ensuring(Effect.sync(() => drainingQueuedTurns.delete(threadId))));
  });

  const drainQueuedTurnsForSession = Effect.fnUntraced(function* (
    threadId: ThreadId,
    options?: { readonly allowStartingSession?: boolean },
  ) {
    const sessionThreadId = (yield* resolveProviderSessionThread(threadId))?.id ?? threadId;
    const queuedThreadIds = new Set<ThreadId>([threadId]);
    for (const queuedThreadId of yield* queuedTurnPromotions.listPendingThreadIds) {
      const queuedThread = ThreadId.makeUnsafe(queuedThreadId);
      const providerThread = yield* resolveProviderSessionThread(queuedThread);
      const queuedSessionThreadId = providerThread?.id ?? queuedThread;
      if (queuedSessionThreadId === sessionThreadId) {
        queuedThreadIds.add(queuedThread);
      }
    }
    for (const queuedThreadId of queuedThreadIds) {
      yield* drainQueuedTurnsForThread(queuedThreadId, options);
    }
  });

  const processQueueDrainEvent = Effect.fnUntraced(function* (event: ProviderQueueDrainEvent) {
    // A runtime error may be emitted before an adapter has finished tearing
    // down its active turn. Let that teardown complete; the recovery sweep will
    // promote pending work as soon as no live provider turn remains.
    if (event.type === "runtime.error" && (yield* hasLiveProviderTurn(event.threadId))) {
      return;
    }
    const sessionThreadId =
      (yield* resolveProviderSessionThread(event.threadId))?.id ?? event.threadId;
    const interruptedOpenCodeTurnId = openCodeSteerInterruptBarriers.get(sessionThreadId);
    if (interruptedOpenCodeTurnId !== undefined) {
      if (event.turnId === undefined) {
        if (yield* hasLiveProviderTurn(event.threadId)) {
          return;
        }
        openCodeSteerInterruptBarriers.delete(sessionThreadId);
      } else if (event.turnId !== interruptedOpenCodeTurnId) {
        return;
      } else {
        openCodeSteerInterruptBarriers.delete(sessionThreadId);
      }
    }
    const reservation = pendingQueuedDispatchBySessionThread.get(sessionThreadId);
    if (reservation) {
      if (event.turnId === undefined) {
        // Some adapters can only report that a stopped turn aborted, not the
        // provider turn id. Their live session state is authoritative and is
        // cleared before the terminal event is emitted. Keep the reservation
        // while a turn is genuinely live; otherwise release it so queued work
        // cannot remain stranded behind an id-less terminal event.
        if (yield* hasLiveProviderTurn(event.threadId)) {
          return;
        }
        pendingQueuedDispatchBySessionThread.delete(sessionThreadId);
      } else if (reservation.releaseOnTurnId === undefined) {
        const terminalTurnIds = reservation.pendingTerminalTurnIds ?? new Set<TurnId>();
        terminalTurnIds.add(event.turnId);
        reservation.pendingTerminalTurnIds = terminalTurnIds;
        return;
      } else if (reservation.releaseOnTurnId !== event.turnId) {
        return;
      } else {
        pendingQueuedDispatchBySessionThread.delete(sessionThreadId);
      }
    }
    // Child subagent threads queue under their own id but share the parent's
    // provider session, and terminal runtime events carry the session-owning
    // thread id — drain every queue bound to this session.
    yield* drainQueuedTurnsForSession(event.threadId, { allowStartingSession: true });
  });

  const recoverQueuedTurnPromotions = Effect.gen(function* () {
    yield* Effect.forEach(yield* queuedTurnPromotions.listPendingThreadIds, (rawThreadId) =>
      Effect.gen(function* () {
        const threadId = ThreadId.makeUnsafe(rawThreadId);
        // Resolve the projected thread first. `resolveThread` filters
        // `deleted_at IS NULL`, so a soft-deleted (or fully missing) thread
        // returns undefined; either way there is nothing to drain into, and the
        // pending promotions must be cancelled rather than promoted (otherwise a
        // deletion that raced startup would leave orphan turns to dispatch).
        const thread = yield* resolveThread(threadId);
        if (!thread || thread.deletedAt !== null) {
          yield* queuedTurnPromotions.cancelThread({
            threadId: rawThreadId,
            updatedAt: new Date().toISOString(),
          });
          return;
        }
        const restartRecoveries = yield* sql<{ readonly present: number }>`
          SELECT 1 AS present
          FROM restart_turn_recoveries AS recovery
          JOIN projection_thread_sessions AS session
            ON session.thread_id = recovery.thread_id
          WHERE recovery.thread_id = ${threadId}
            AND session.status = 'interrupted'
          LIMIT 1
        `;
        if (restartRecoveries.length > 0) {
          return;
        }
        if (yield* hasLiveProviderTurn(threadId)) {
          return;
        }
        yield* drainQueuedTurnsForThread(threadId);
      }),
    );
  });

  const recoverQueuedTurnPromotionsSafely = recoverQueuedTurnPromotions.pipe(
    Effect.catchCause((cause) => {
      if (Cause.hasInterruptsOnly(cause)) {
        return Effect.failCause(cause);
      }
      return Effect.logWarning("provider command reactor failed to recover queued turns", {
        cause: Cause.pretty(cause),
      });
    }),
  );

  const interruptProviderTurn = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly turnId?: TurnId | undefined;
    readonly createdAt: string;
  }) {
    const thread = yield* resolveThread(input.threadId);
    const providerThread = yield* resolveProviderSessionThread(input.threadId);
    if (!thread) {
      return;
    }

    const reportInterruptFailure = (detail: string, settlementStatus?: "uncertain") =>
      appendProviderFailureActivity({
        threadId: input.threadId,
        kind: "provider.turn.interrupt.failed",
        summary: "Provider turn interrupt failed",
        detail,
        turnId: input.turnId ?? null,
        createdAt: input.createdAt,
        ...(settlementStatus ? { settlementStatus } : {}),
      });

    if (!providerThread || !providerThread.session || providerThread.session.status === "stopped") {
      yield* reportInterruptFailure("No active provider session is bound to this thread.");
      // Nothing is left that could ever emit a terminal event for this turn.
      return yield* settleInterruptedProviderTurn({
        threadId: input.threadId,
        createdAt: input.createdAt,
      });
    }

    // Forward the observed turn only as an expectation. ProviderService owns the
    // exact generation-scoped provider turn and rejects a stale mismatch.
    const providerThreadId = resolveSubagentProviderThreadId(thread.id, providerThread.id);
    const turnId = input.turnId ?? thread.session?.activeTurnId ?? undefined;
    const result = yield* runBoundedProviderCall({
      label: "The provider interrupt",
      timeout: PROVIDER_COMMAND_INTERRUPT_TIMEOUT,
      call: providerService.interruptTurn({
        threadId: providerThread.id,
        ...(turnId ? { turnId } : {}),
        ...(providerThreadId ? { providerThreadId } : {}),
      }),
    });
    if (result._tag === "ok") {
      return;
    }

    // An interrupt that timed out or failed uncertainly is escalated to a full
    // session stop rather than propagated: propagating would quarantine the
    // thread, which suppresses every later side effect while still leaving the
    // turn running. The stop path always settles the projection.
    if (result._tag === "timeout" || result.outcome._tag === "uncertain") {
      const detail =
        result._tag === "timeout"
          ? `${result.detail} Stopping the provider session to settle the turn.`
          : `${result.outcome.detail}\nStopping the provider session to settle the turn.`;
      yield* reportInterruptFailure(detail, "uncertain");
      return yield* processThreadSessionStop({
        threadId: input.threadId,
        createdAt: input.createdAt,
      });
    }

    // Terminal rejections (validation and friends) would otherwise vanish
    // silently and leave the stop button looking dead; surface them on the
    // thread and settle locally, since the provider never accepted the request.
    if (result.outcome._tag === "rejected") {
      yield* reportInterruptFailure(result.outcome.detail);
      return yield* settleInterruptedProviderTurn({
        threadId: input.threadId,
        createdAt: input.createdAt,
      });
    }
    // Safe retries (persistence faults) keep propagating so the durable delivery
    // machinery can retry the whole command.
    return yield* Effect.failCause(result.cause);
  });

  const processTurnInterruptRequested = Effect.fnUntraced(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.turn-interrupt-requested" }>,
  ) {
    if (event.payload.pendingMessageId !== undefined) {
      if (completedPendingTurnStartInterrupts.delete(event.payload.pendingMessageId)) {
        return;
      }
      const thread = yield* resolveThread(event.payload.threadId);
      if (
        thread?.session?.activeTurnId === null &&
        (thread.session.status === "interrupted" || thread.session.status === "stopped")
      ) {
        return;
      }
    }
    yield* interruptProviderTurn({
      threadId: event.payload.threadId,
      turnId: event.payload.turnId,
      createdAt: event.payload.createdAt,
    });
  });

  const processTaskStopRequested = Effect.fnUntraced(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.task-stop-requested" }>,
  ) {
    const providerThread = yield* resolveProviderSessionThread(event.payload.threadId);
    const hasSession = providerThread?.session && providerThread.session.status !== "stopped";
    if (!providerThread || !hasSession) {
      return yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.task.stop.failed",
        summary: "Provider task stop failed",
        detail: "No active provider session is bound to this thread.",
        turnId: null,
        createdAt: event.payload.createdAt,
      });
    }

    yield* providerService
      .stopTask({
        threadId: providerThread.id,
        taskId: event.payload.taskId,
      })
      .pipe(
        Effect.catchCause((cause) =>
          appendProviderFailureActivity({
            threadId: event.payload.threadId,
            kind: "provider.task.stop.failed",
            summary: "Provider task stop failed",
            detail: Cause.pretty(cause),
            turnId: null,
            createdAt: event.payload.createdAt,
          }),
        ),
      );
  });

  const processTaskBackgroundRequested = Effect.fnUntraced(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.task-background-requested" }>,
  ) {
    const providerThread = yield* resolveProviderSessionThread(event.payload.threadId);
    const hasSession = providerThread?.session && providerThread.session.status !== "stopped";
    if (!providerThread || !hasSession) {
      return yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.task.background.failed",
        summary: "Provider task background failed",
        detail: "No active provider session is bound to this thread.",
        turnId: null,
        createdAt: event.payload.createdAt,
      });
    }

    yield* providerService
      .backgroundTask({
        threadId: providerThread.id,
        toolUseId: event.payload.toolUseId,
      })
      .pipe(
        Effect.catchCause((cause) =>
          appendProviderFailureActivity({
            threadId: event.payload.threadId,
            kind: "provider.task.background.failed",
            summary: "Provider task background failed",
            detail: Cause.pretty(cause),
            turnId: null,
            createdAt: event.payload.createdAt,
          }),
        ),
      );
  });

  const appendInteractionResponseFailure = (
    event: InteractionResponseEvent,
    input: {
      readonly interactionKind: "approval" | "userInput";
      readonly detail: string;
      readonly settlementStatus: "retryable" | "uncertain";
    },
  ) =>
    event.commandId === null
      ? Effect.void
      : appendProviderFailureActivity({
          threadId: event.payload.threadId,
          kind:
            input.interactionKind === "approval"
              ? "provider.approval.respond.failed"
              : "provider.user-input.respond.failed",
          summary:
            input.interactionKind === "approval"
              ? "Provider approval response failed"
              : "Provider user input response failed",
          detail: input.detail,
          turnId: null,
          createdAt: event.payload.createdAt,
          requestId: event.payload.requestId,
          responseCommandId: event.commandId,
          settlementStatus: input.settlementStatus,
          ...(event.payload.lifecycleGeneration === undefined
            ? {}
            : { lifecycleGeneration: event.payload.lifecycleGeneration }),
        });

  const claimInteractionResponse = Effect.fnUntraced(function* (input: {
    readonly event: InteractionResponseEvent;
    readonly interactionKind: "approval" | "userInput";
    readonly decision: Parameters<typeof pendingInteractions.claimResponse>[0]["decision"];
  }) {
    const { event } = input;
    if (event.commandId === null) return null;
    const claimed = yield* pendingInteractions.claimResponse({
      threadId: event.payload.threadId,
      interactionKind: input.interactionKind,
      requestId: event.payload.requestId,
      lifecycleGeneration: event.payload.lifecycleGeneration ?? null,
      responseCommandId: event.commandId,
      decision: input.decision,
      requestedAt: event.payload.createdAt,
    });
    const pending = yield* pendingInteractions.getByIdentity({
      threadId: event.payload.threadId,
      interactionKind: input.interactionKind,
      requestId: event.payload.requestId,
    });
    if (
      !claimed &&
      (Option.isNone(pending) ||
        pending.value.status !== "responding" ||
        pending.value.responseCommandId !== event.commandId)
    ) {
      return null;
    }
    const providerThread = yield* resolveProviderSessionThread(event.payload.threadId);
    if (!providerThread) return null;
    if (providerThread.session?.status !== "stopped") return providerThread.id;
    yield* appendInteractionResponseFailure(event, {
      interactionKind: input.interactionKind,
      detail: "No active provider session is bound to this thread.",
      settlementStatus: "retryable",
    });
    return null;
  });

  const processApprovalResponseRequested = Effect.fnUntraced(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.approval-response-requested" }>,
  ) {
    const providerThreadId = yield* claimInteractionResponse({
      event,
      interactionKind: "approval",
      decision: event.payload.decision,
    });
    if (providerThreadId === null) return;

    yield* providerService
      .respondToRequest({
        threadId: providerThreadId,
        requestId: event.payload.requestId,
        ...(event.payload.lifecycleGeneration !== undefined
          ? { lifecycleGeneration: event.payload.lifecycleGeneration }
          : {}),
        decision: event.payload.decision,
      })
      .pipe(
        Effect.asVoid,
        Effect.catchCause((cause) => {
          const unknownPendingRequest = isUnknownPendingApprovalRequestError(cause);
          return appendInteractionResponseFailure(event, {
            interactionKind: "approval",
            detail: unknownPendingRequest
              ? buildStalePendingRequestFailureDetail("approval", event.payload.requestId)
              : Cause.pretty(cause),
            settlementStatus: interactionFailureSettlementStatus(cause, unknownPendingRequest),
          }).pipe(Effect.asVoid);
        }),
      );
  });

  const processUserInputResponseRequested = Effect.fnUntraced(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.user-input-response-requested" }>,
  ) {
    const providerThreadId = yield* claimInteractionResponse({
      event,
      interactionKind: "userInput",
      decision: null,
    });
    if (providerThreadId === null) return;

    yield* providerService
      .respondToUserInput({
        threadId: providerThreadId,
        requestId: event.payload.requestId,
        ...(event.payload.lifecycleGeneration !== undefined
          ? { lifecycleGeneration: event.payload.lifecycleGeneration }
          : {}),
        answers: event.payload.answers,
      })
      .pipe(
        Effect.asVoid,
        Effect.catchCause((cause) => {
          const unknownPendingRequest = isUnknownPendingUserInputRequestError(cause);
          return appendInteractionResponseFailure(event, {
            interactionKind: "userInput",
            detail: unknownPendingRequest
              ? buildStalePendingRequestFailureDetail("user-input", event.payload.requestId)
              : Cause.pretty(cause),
            settlementStatus: interactionFailureSettlementStatus(cause, unknownPendingRequest),
          }).pipe(Effect.asVoid);
        }),
      );
  });

  const processConversationRollbackRequestedWithoutLease = Effect.fnUntraced(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.conversation-rollback-requested" }>,
  ) {
    const thread = yield* resolveThread(event.payload.threadId);
    const removedTurnIds = thread
      ? collectTailTurnIds<TurnId>({
          messages: thread.messages,
          messageId: event.payload.messageId,
        })
      : [];
    if (!thread || removedTurnIds.length !== event.payload.numTurns) {
      return yield* Effect.fail(
        new Error(
          `Conversation rollback target '${event.payload.messageId}' is no longer valid for ${event.payload.numTurns} turn(s).`,
        ),
      );
    }
    if (event.payload.numTurns > 0) {
      const providerThread = yield* resolveProviderSessionThread(event.payload.threadId);
      if (
        thread &&
        providerThread?.session?.status === "running" &&
        providerThread.session.activeTurnId !== null
      ) {
        const providerThreadId = resolveSubagentProviderThreadId(thread.id, providerThread.id);
        yield* providerService.interruptTurn({
          threadId: providerThread.id,
          turnId: providerThread.session.activeTurnId,
          ...(providerThreadId ? { providerThreadId } : {}),
        });
      }

      yield* rollbackProviderConversationForEdit({
        threadId: event.payload.threadId,
        numTurns: event.payload.numTurns,
      });
    }
    yield* orchestrationEngine.dispatch({
      type: "thread.conversation.rollback.complete",
      commandId: serverCommandId("conversation-rollback-complete"),
      threadId: event.payload.threadId,
      messageId: event.payload.messageId,
      numTurns: event.payload.numTurns,
      removedTurnIds,
      createdAt: event.payload.createdAt,
    });
  });

  const processConversationRollbackRequested = (
    event: Extract<ProviderIntentEvent, { type: "thread.conversation-rollback-requested" }>,
  ) =>
    withProviderSessionLease(
      event.payload.threadId,
      processConversationRollbackRequestedWithoutLease(event),
    );

  const processMessageEditResendPayload = Effect.fnUntraced(function* (
    payload: Extract<
      ProviderIntentEvent,
      { type: "thread.message-edit-resend-requested" }
    >["payload"],
    options?: {
      readonly skipProviderRollback?: boolean;
      readonly preserveQueuedTurns?: boolean;
      readonly preserveThreadSession?: boolean;
      readonly queuedActionAlreadyClaimed?: boolean;
      readonly actionEventId?: EventId;
      readonly activeTurnId?: TurnId | null;
    },
  ) {
    if (options?.preserveQueuedTurns !== true) {
      yield* queuedTurnPromotions.cancelThread({
        threadId: payload.threadId,
        updatedAt: payload.createdAt,
      });
      yield* clearEditResendTurnStartKeysForThread(payload.threadId);
    } else if (options?.queuedActionAlreadyClaimed !== true) {
      yield* queuedTurnPromotions.cancelMessage({
        threadId: payload.threadId,
        messageId: payload.messageId,
        updatedAt: new Date().toISOString(),
      });
    }
    const originalThread = yield* resolveThread(payload.threadId);
    const originalMessage = originalThread?.messages.find(
      (message) => message.id === payload.messageId,
    );
    if (!originalThread || !originalMessage || originalMessage.role !== "user") {
      return yield* Effect.fail(
        new Error(`Cannot edit missing user message '${payload.messageId}'.`),
      );
    }
    const editTarget =
      payload.removedTurnIds !== undefined && payload.rollbackTurnCount !== undefined
        ? {
            editable: true as const,
            messageId: payload.messageId,
            messageIndex: originalThread.messages.findIndex(
              (message) => message.id === payload.messageId,
            ),
            mode: payload.rollbackTurnCount > 0 ? ("rollback" as const) : ("active" as const),
            rollbackTurnCount: payload.rollbackTurnCount,
            removedTurnIds: payload.removedTurnIds,
          }
        : resolveTailUserMessageEditTarget({
            messages: originalThread.messages,
            messageId: payload.messageId,
            activeTurnId:
              options?.activeTurnId ??
              (originalThread.session?.status === "running"
                ? (originalThread.session.activeTurnId ?? null)
                : null),
          });
    if (!editTarget.editable) {
      return yield* Effect.fail(
        new Error(
          `Cannot edit non-tail user message '${payload.messageId}': ${editTarget.reason}.`,
        ),
      );
    }
    if (options?.skipProviderRollback !== true && editTarget.rollbackTurnCount > 0) {
      yield* rollbackProviderConversationForEdit({
        threadId: payload.threadId,
        numTurns: editTarget.rollbackTurnCount,
      });
    }
    yield* orchestrationEngine.dispatch({
      type: "thread.conversation.rollback.complete",
      commandId:
        options?.actionEventId === undefined
          ? serverCommandId("message-edit-rollback-complete")
          : replaySafeServerCommandId("message-edit-rollback-complete", options.actionEventId),
      threadId: payload.threadId,
      messageId: payload.messageId,
      numTurns: editTarget.rollbackTurnCount,
      removedTurnIds: editTarget.removedTurnIds.map((turnId) => TurnId.makeUnsafe(turnId)),
      skipAttachmentPrune: true,
      createdAt: payload.createdAt,
    });

    const thread = yield* resolveThread(payload.threadId);
    if (thread && options?.preserveThreadSession !== true) {
      yield* setThreadSession({
        threadId: payload.threadId,
        session: {
          threadId: payload.threadId,
          status: "starting",
          providerName: thread.session?.providerName ?? thread.modelSelection.provider,
          runtimeMode: payload.runtimeMode,
          activeTurnId: null,
          lastError: null,
          updatedAt: payload.createdAt,
        },
        createdAt: payload.createdAt,
      });
    }

    const readModel = yield* orchestrationEngine.getCommandReadModel();
    const cwd = resolveThreadWorkspaceCwd({
      workingDirectory: originalThread.workingDirectory,
      projectCwd:
        readModel.folders.find((project) => project.id === originalThread.folderId)
          ?.workspaceRoot ?? null,
    });
    editResendTurnStartKeys.add(editResendTurnStartKey(payload.threadId, payload.messageId));
    yield* providerThreadSwitchCoordinator.dispatchTurnStart({
      command: {
        type: "thread.turn.start",
        commandId:
          options?.actionEventId === undefined
            ? serverCommandId("message-edit-resend-turn-start")
            : replaySafeServerCommandId("message-edit-resend-turn-start", options.actionEventId),
        threadId: payload.threadId,
        message: {
          messageId: payload.messageId,
          role: "user",
          text: payload.text,
          attachments: originalMessage.attachments ?? [],
          ...(originalMessage.skills !== undefined ? { skills: originalMessage.skills } : {}),
          ...(originalMessage.mentions !== undefined ? { mentions: originalMessage.mentions } : {}),
        },
        ...(payload.modelSelection !== undefined ? { modelSelection: payload.modelSelection } : {}),
        connectionId: payload.connectionId,
        bindingRevision: payload.bindingRevision,
        ...(payload.providerOptions !== undefined
          ? { providerOptions: payload.providerOptions }
          : {}),
        ...(payload.assistantDeliveryMode !== undefined
          ? { assistantDeliveryMode: payload.assistantDeliveryMode }
          : {}),
        dispatchMode: "queue",
        runtimeMode: payload.runtimeMode,
        createdAt: payload.createdAt,
      },
      attachmentPrincipal: LOCAL_LOOPBACK_ATTACHMENT_PRINCIPAL,
      ...(cwd === null ? {} : { cwd }),
    });
  });

  const stopActiveProviderRuntimeForEdit = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
  }) {
    const thread = yield* resolveThread(input.threadId);
    const provider = thread
      ? Schema.is(ProviderKind)(thread.session?.providerName)
        ? thread.session?.providerName
        : thread.modelSelection.provider
      : undefined;
    const rebuildsContext =
      provider !== undefined &&
      (yield* providerService.getCapabilities(provider)).conversationRollback === "unsupported";
    if (rebuildsContext) {
      return yield* new ProviderAdapterValidationError({
        provider: provider as ProviderKind,
        operation: "thread.message.edit-and-resend",
        issue: "This provider cannot edit completed messages through exact native session state.",
      });
    }
    if (providerService.stopRuntimeSession) {
      yield* providerService.stopRuntimeSession({ threadId: input.threadId });
      return;
    }
    yield* providerService.stopSession({ threadId: input.threadId });
  });

  const processMessageEditResendRequestedWithoutLease = Effect.fnUntraced(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.message-edit-resend-requested" }>,
  ) {
    const thread = yield* resolveThread(event.payload.threadId);
    const providerThread = yield* resolveProviderSessionThread(event.payload.threadId);
    const activeTurnId =
      providerThread?.session?.status === "running"
        ? (providerThread.session.activeTurnId ?? null)
        : null;
    const queuedEditAction = yield* claimQueuedTurnAction({
      ...event.payload,
      actionKind: "edit",
      actionEventId: event.eventId,
    });
    const isQueuedMessageEdit = Option.isSome(queuedEditAction);
    if (thread && !isQueuedMessageEdit) {
      yield* setThreadSession({
        threadId: event.payload.threadId,
        session: {
          threadId: event.payload.threadId,
          status: "starting",
          providerName: thread.session?.providerName ?? thread.modelSelection.provider,
          runtimeMode: event.payload.runtimeMode,
          activeTurnId: null,
          lastError: null,
          updatedAt: event.payload.createdAt,
        },
        createdAt: event.payload.createdAt,
      });
    }
    if (
      thread &&
      providerThread?.session?.status === "running" &&
      providerThread.session.activeTurnId !== null &&
      !isQueuedMessageEdit
    ) {
      // Edits should replay from the last stable cursor, not wait for each
      // provider's interrupt lifecycle to settle.
      yield* stopActiveProviderRuntimeForEdit({ threadId: providerThread.id });
      yield* processMessageEditResendPayload(event.payload, {
        skipProviderRollback: true,
        actionEventId: event.eventId,
        activeTurnId,
      });
      return;
    }

    yield* processMessageEditResendPayload(event.payload, {
      ...(isQueuedMessageEdit ? { skipProviderRollback: true } : {}),
      preserveQueuedTurns: isQueuedMessageEdit,
      preserveThreadSession: isQueuedMessageEdit,
      queuedActionAlreadyClaimed: isQueuedMessageEdit,
      actionEventId: event.eventId,
      activeTurnId,
    });
  });

  const processMessageEditResendRequested = (
    event: Extract<ProviderIntentEvent, { type: "thread.message-edit-resend-requested" }>,
  ) =>
    withProviderSessionLease(
      event.payload.threadId,
      processMessageEditResendRequestedWithoutLease(event),
    );

  const processThreadSessionStop = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly createdAt: string;
  }) {
    const thread = yield* resolveThread(input.threadId);
    const providerThread = yield* resolveProviderSessionThread(input.threadId);
    if (!thread) {
      return;
    }

    const stoppedSessionThreadId = providerThread?.id ?? thread.id;
    const stopsProviderSession = providerThread === null || providerThread.id === thread.id;
    const clearedQueuedThreadIds = new Set<ThreadId>([thread.id]);
    openCodeSteerInterruptBarriers.delete(stoppedSessionThreadId);
    if (stopsProviderSession) {
      for (const queuedThreadId of yield* queuedTurnPromotions.listPendingThreadIds) {
        const queuedThread = ThreadId.makeUnsafe(queuedThreadId);
        const queuedProviderThread = yield* resolveProviderSessionThread(queuedThread);
        if ((queuedProviderThread?.id ?? queuedThread) === stoppedSessionThreadId) {
          clearedQueuedThreadIds.add(queuedThread);
        }
      }
    }
    for (const queuedThreadId of clearedQueuedThreadIds) {
      yield* queuedTurnPromotions.cancelThread({
        threadId: queuedThreadId,
        updatedAt: input.createdAt,
      });
      yield* clearEditResendTurnStartKeysForThread(queuedThreadId);
      drainingQueuedTurns.delete(queuedThreadId);
    }
    // Reservations are keyed by session-owning thread but may belong to a
    // stopping child's queued message. A provider-session stop clears every
    // reservation for that session; a child-only interrupt clears its own.
    for (const [sessionThreadId, reservation] of pendingQueuedDispatchBySessionThread) {
      if (
        (stopsProviderSession && sessionThreadId === stoppedSessionThreadId) ||
        clearedQueuedThreadIds.has(ThreadId.makeUnsafe(reservation.queuedThreadId))
      ) {
        pendingQueuedDispatchBySessionThread.delete(sessionThreadId);
      }
    }
    const providerThreadId =
      providerThread !== null
        ? resolveSubagentProviderThreadId(thread.id, providerThread.id)
        : undefined;
    const isChildProviderRuntime =
      providerThread !== null && providerThread.id !== thread.id && providerThreadId !== undefined;

    // Child subagents share the parent provider session, so stop requests need
    // to interrupt the child turn rather than terminate the whole session.
    if (
      isChildProviderRuntime &&
      thread.session &&
      thread.session.status === "running" &&
      thread.session.activeTurnId !== null &&
      providerThread.session &&
      providerThread.session.status !== "stopped"
    ) {
      const childInterrupt = yield* runBoundedProviderCall({
        label: "The provider interrupt",
        timeout: PROVIDER_COMMAND_INTERRUPT_TIMEOUT,
        call: providerService.interruptTurn({
          threadId: providerThread.id,
          turnId: thread.session.activeTurnId,
          providerThreadId,
        }),
      });
      if (childInterrupt._tag !== "ok") {
        const detail =
          childInterrupt._tag === "timeout" ? childInterrupt.detail : childInterrupt.outcome.detail;
        yield* appendProviderFailureActivity({
          threadId: thread.id,
          kind: "provider.turn.interrupt.failed",
          summary: "Provider turn interrupt failed",
          detail,
          turnId: thread.session.activeTurnId,
          createdAt: input.createdAt,
          settlementStatus: "uncertain",
        });
        // The parent session was never told to end this child turn, so no
        // terminal child event is coming: settle instead of waiting for one.
        yield* settleInterruptedProviderTurn({
          threadId: thread.id,
          createdAt: input.createdAt,
        });
        return;
      }

      yield* setThreadSession({
        threadId: thread.id,
        session: {
          threadId: thread.id,
          status: "interrupted",
          providerName: thread.session.providerName ?? null,
          runtimeMode: thread.session.runtimeMode ?? DEFAULT_RUNTIME_MODE,
          // Preserve the active turn until the provider emits the terminal child event.
          activeTurnId: thread.session.activeTurnId,
          lastError: null,
          updatedAt: input.createdAt,
        },
        createdAt: input.createdAt,
      });
      return;
    }

    const ownsProviderSession = providerThread !== null && providerThread.id === thread.id;
    if (thread.session && thread.session.status !== "stopped" && ownsProviderSession) {
      // A stop that cannot finish must still settle the projection: the session
      // row below is the only thing that releases the turn in the UI.
      const stopped = yield* runBoundedProviderCall({
        label: "The provider session stop",
        timeout: PROVIDER_COMMAND_STOP_TIMEOUT,
        call: providerService.stopSession({ threadId: providerThread.id }),
      });
      if (stopped._tag !== "ok") {
        yield* appendProviderFailureActivity({
          threadId: thread.id,
          kind: "provider.session.stop.failed",
          summary: "Provider session stop failed",
          detail: stopped._tag === "timeout" ? stopped.detail : stopped.outcome.detail,
          turnId: null,
          createdAt: input.createdAt,
          settlementStatus: "uncertain",
        });
      }
    }

    yield* setThreadSession({
      threadId: thread.id,
      session: {
        threadId: thread.id,
        status: "stopped",
        providerName: thread.session?.providerName ?? null,
        runtimeMode: thread.session?.runtimeMode ?? DEFAULT_RUNTIME_MODE,
        activeTurnId: null,
        lastError: thread.session?.lastError ?? null,
        updatedAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });
  });

  const processSessionStopRequested = (
    event: Extract<ProviderIntentEvent, { type: "thread.session-stop-requested" }>,
  ) =>
    processThreadSessionStop({
      threadId: event.payload.threadId,
      createdAt: event.payload.createdAt,
    });

  const surfaceTimedOutTurnStart = Effect.fnUntraced(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.turn-start-requested" }>,
    detail: string,
  ) {
    const session = (yield* resolveThread(event.payload.threadId))?.session;
    if (session?.status !== "starting" || session.activeTurnId !== null) {
      return;
    }

    const createdAt = new Date().toISOString();
    yield* setThreadSessionError({
      threadId: event.payload.threadId,
      runtimeMode: event.payload.runtimeMode,
      detail,
      expectedSession: {
        status: session.status,
        updatedAt: session.updatedAt,
      },
      createdAt,
    });
    yield* appendProviderFailureActivity({
      threadId: event.payload.threadId,
      kind: "provider.turn.start.failed",
      summary: "Provider turn start timed out",
      detail,
      turnId: null,
      createdAt,
      settlementStatus: "uncertain",
    });
  });

  const processDomainEvent = (event: ProviderIntentEvent) =>
    Effect.gen(function* () {
      switch (event.type) {
        case "thread.session-set": {
          const thread = yield* resolveThread(event.payload.threadId);
          if (thread && event.payload.session.status !== "stopped") {
            if (!threadSessionModelSelections.has(event.payload.threadId)) {
              threadSessionModelSelections.set(event.payload.threadId, thread.modelSelection);
            }
            if (!threadManagedBindingRevisions.has(event.payload.threadId)) {
              const currentBinding = yield* providerTurnSelectionResolver
                .resolveExisting({
                  threadId: event.payload.threadId,
                  modelSelection: thread.modelSelection,
                })
                .pipe(
                  Effect.mapError(
                    (cause) =>
                      new ProviderAdapterValidationError({
                        provider: thread.modelSelection.provider,
                        operation: "thread.session.set",
                        issue: cause.message,
                        cause,
                      }),
                  ),
                );
              threadManagedBindingRevisions.set(
                event.payload.threadId,
                currentBinding.bindingRevision,
              );
            }
          }
          return;
        }
        case "thread.created":
          threadSessionModelSelections.set(event.payload.threadId, event.payload.modelSelection);
          return;
        case "thread.deleted":
          // Cancel any queued/promoting turns for the deleted thread BEFORE
          // clearing runtime caches so a concurrent drain cannot resurrect them
          // (see cancelThread). Best-effort: the event stays unclaimed either way.
          yield* queuedTurnPromotions.cancelThread({
            threadId: event.payload.threadId,
            updatedAt: event.payload.deletedAt,
          });
          yield* clearThreadRuntimeCaches(event.payload.threadId);
          return;
        case "thread.archived":
          // Archive cleanup shares this durable, sequence-ordered provider
          // source with later turn-start intents. An immediate unarchive/send
          // therefore cannot race an older archive stop against the new turn.
          yield* processThreadSessionStop({
            threadId: event.payload.threadId,
            // Legacy thread.archived events may omit archivedAt; fall back like the projector.
            createdAt: event.payload.archivedAt ?? event.payload.updatedAt ?? event.occurredAt,
          });
          return;
        case "thread.updated": {
          if (event.payload.modelSelection === undefined) {
            return;
          }
          // Model selection is committed atomically with the admitting turn.
          // The following turn-start event owns the in-session switch or
          // restart. Keep the runtime cache on the profile actually running so
          // that turn can compare the admitted selection against live state.
          return;
        }
        case "thread.runtime-mode-set": {
          const thread = yield* resolveThread(event.payload.threadId);
          if (!thread?.session || thread.session.status === "stopped") {
            return;
          }
          if (thread.session.activeTurnId !== null) {
            // Restarting to apply a runtime-mode change would kill the active
            // turn. The next turn's normal session ensure applies the new mode.
            return;
          }
          const cachedProviderOptions = threadProviderOptions.get(event.payload.threadId);
          const managedRuntime = yield* resolveCurrentManagedRuntime({
            threadId: event.payload.threadId,
            modelSelection: thread.modelSelection,
          });
          yield* ensureSessionForThread(event.payload.threadId, event.occurredAt, {
            ...(cachedProviderOptions !== undefined
              ? { providerOptions: cachedProviderOptions }
              : {}),
            modelSelection: thread.modelSelection,
            runtimeMode: event.payload.runtimeMode,
            managedLaunch: managedRuntime.managedLaunch,
            nativeResumeCursor: managedRuntime.resumeCursor,
            bindingRevision: managedRuntime.bindingRevision,
          });
          return;
        }
        case "thread.turn-queued":
          yield* processTurnQueued(event);
          return;
        case "thread.turn-start-requested":
          yield* processTurnStartRequested(event);
          return;
        case "thread.turn-interrupt-requested":
          yield* processTurnInterruptRequested(event);
          return;
        case "thread.turn-cancel-queued-requested":
          yield* processQueuedTurnCancelRequested(event);
          return;
        case "thread.turn-steer-queued-requested":
          yield* processQueuedTurnSteerRequested(event);
          return;
        case "thread.task-stop-requested":
          yield* processTaskStopRequested(event);
          return;
        case "thread.task-background-requested":
          yield* processTaskBackgroundRequested(event);
          return;
        case "thread.approval-response-requested":
          yield* processApprovalResponseRequested(event);
          return;
        case "thread.user-input-response-requested":
          yield* processUserInputResponseRequested(event);
          return;
        case "thread.conversation-rollback-requested":
          yield* processConversationRollbackRequested(event);
          return;
        case "thread.message-edit-resend-requested":
          yield* processMessageEditResendRequested(event).pipe(
            Effect.catchCause((cause) =>
              setThreadSessionError({
                threadId: event.payload.threadId,
                runtimeMode: event.payload.runtimeMode,
                detail: Cause.pretty(cause),
                createdAt: event.payload.createdAt,
              }).pipe(Effect.andThen(Effect.failCause(cause))),
            ),
          );
          return;
        case "thread.session-stop-requested":
          yield* processSessionStopRequested(event);
          return;
      }
    });

  const processDomainEventSafely = (event: ProviderIntentEvent) =>
    processDomainEvent(event).pipe(
      Effect.timeoutOption(commandEventTimeout),
      Effect.flatMap((completed) =>
        Option.isSome(completed)
          ? Effect.void
          : Effect.logError("provider command reactor timed out processing event", {
              eventType: event.type,
              eventSequence: event.sequence,
              threadId: event.payload.threadId,
              timeoutMs: Duration.toMillis(commandEventTimeout),
            }),
      ),
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("provider command reactor failed to process event", {
          eventType: event.type,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const processQueueDrainEventSafely = (event: ProviderQueueDrainEvent) =>
    processQueueDrainEvent(event).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("provider command reactor failed to drain queued turn", {
          eventType: event.type,
          threadId: event.threadId,
          cause: Cause.pretty(cause),
        });
      }),
    );

  // One attach-before-replay source owns every provider intent. The claimed
  // canary classes settle before cursor advancement. Remaining classes execute
  // serially in the same source but do not acquire delivery claims yet.
  const startProviderIntentSource = Effect.gen(function* () {
    const liveEventSource = yield* orchestrationEngine.subscribeDomainEvents;
    // Detach the engine from this reactor's processing latency. The engine
    // publishes committed events into a bounded PubSub from an uninterruptible
    // section of its single command worker, so a subscriber that stalls (a hung
    // provider call, or just slow boot replay below) back-pressures the worker
    // and then fails every dispatched command with a dispatch timeout. Draining
    // into an unbounded queue immediately after subscribing keeps the engine
    // free while boot work runs; ordering is preserved because the queue is FIFO
    // and `processOrderedEvent` skips anything at or below the durable cursor.
    const liveEventQueue = yield* Queue.unbounded<OrchestrationEvent, Cause.Done>();
    yield* Stream.runIntoQueue(liveEventSource, liveEventQueue).pipe(Effect.forkScoped);
    const liveEvents = Stream.fromQueue(liveEventQueue);
    const consumerState = yield* deliveryRepository.getConsumerState(
      PROVIDER_COMMAND_REACTOR_CONSUMER,
    );
    if (Option.isNone(consumerState)) {
      return yield* Effect.die(
        new Error(`Missing durable consumer state for ${PROVIDER_COMMAND_REACTOR_CONSUMER}`),
      );
    }

    const processOwner = `provider-command-reactor:${crypto.randomUUID()}`;
    let cursor = consumerState.value.lastAckedSequence;
    const refreshCursor = Effect.gen(function* () {
      const state = yield* deliveryRepository.getConsumerState(PROVIDER_COMMAND_REACTOR_CONSUMER);
      if (Option.isSome(state)) cursor = state.value.lastAckedSequence;
    });

    const advanceCursor = Effect.fnUntraced(function* (event: OrchestrationEvent) {
      const advanced = yield* deliveryRepository.advanceCursor({
        consumerName: PROVIDER_COMMAND_REACTOR_CONSUMER,
        eventSequence: event.sequence,
        updatedAt: new Date().toISOString(),
      });
      if (advanced) cursor = event.sequence;
      return advanced;
    });

    const requireCursorAdvance = Effect.fnUntraced(function* (event: OrchestrationEvent) {
      if (yield* advanceCursor(event)) return;
      yield* refreshCursor;
      if (cursor < event.sequence) {
        return yield* Effect.die(
          new Error(`Provider command cursor could not advance through event ${event.sequence}`),
        );
      }
    });

    const isThreadQuarantined = Effect.fnUntraced(function* (threadId: string) {
      if (quarantinedThreads.has(threadId)) return true;
      const blocker = yield* deliveryRepository.firstBlockingDeliveryForThread({
        consumerName: PROVIDER_COMMAND_REACTOR_CONSUMER,
        threadId,
      });
      if (Option.isNone(blocker)) return false;
      quarantinedThreads.add(threadId);
      return true;
    });

    /**
     * A terminal delivery means Penkra cannot prove whether the provider saw
     * the command. Never retry that command. Instead, stop the owning provider
     * session as an execution barrier and durably abandon every blocker for
     * the thread. Later provider intents are safe to run because their source
     * events were only skipped locally while the quarantine was in force.
     */
    const fenceAndAbandonThreadBlockers = Effect.fnUntraced(function* (threadId: ThreadId) {
      const firstBlocker = yield* deliveryRepository.firstBlockingDeliveryForThread({
        consumerName: PROVIDER_COMMAND_REACTOR_CONSUMER,
        threadId,
      });
      if (Option.isNone(firstBlocker)) {
        quarantinedThreads.delete(threadId);
        return null;
      }

      const providerThread = yield* resolveProviderSessionThread(threadId);
      const providerThreadId = providerThread?.id ?? threadId;
      const stopped = yield* runBoundedProviderCall({
        label: "The provider recovery stop",
        timeout: PROVIDER_COMMAND_STOP_TIMEOUT,
        call: providerService.stopSession({ threadId: providerThreadId }),
      });
      if (stopped._tag !== "ok") {
        yield* Effect.logWarning("provider delivery recovery could not prove runtime stop", {
          threadId,
          providerThreadId,
          detail: stopped._tag === "timeout" ? stopped.detail : stopped.outcome.detail,
        });
        quarantinedThreads.add(threadId);
        return null;
      }

      let earliestSequence: number | null = null;
      while (true) {
        const blocker = yield* deliveryRepository.firstBlockingDeliveryForThread({
          consumerName: PROVIDER_COMMAND_REACTOR_CONSUMER,
          threadId,
        });
        if (Option.isNone(blocker)) break;
        if (blocker.value.state !== "dead" && blocker.value.state !== "uncertain") {
          return yield* Effect.die(
            new Error(
              `Provider delivery ${blocker.value.eventSequence} was returned as a blocker in state ${blocker.value.state}`,
            ),
          );
        }
        earliestSequence ??= blocker.value.eventSequence;
        const reconciledAt = new Date().toISOString();
        const reconciled = yield* deliveryRepository.reconcile({
          reconciliationId: crypto.randomUUID(),
          consumerName: PROVIDER_COMMAND_REACTOR_CONSUMER,
          eventSequence: blocker.value.eventSequence,
          threadId,
          expectedState: blocker.value.state,
          outcome: "abandon",
          reconciledBy: "system:provider-command-reactor",
          note: "The owning provider runtime was stopped before this acceptance-ambiguous command was abandoned. The ambiguous command was not replayed.",
          reconciledAt,
        });
        if (Option.isNone(reconciled)) continue;
        yield* Effect.logInfo("provider delivery blocker recovered automatically", {
          eventSequence: blocker.value.eventSequence,
          threadId,
          providerThreadId,
          previousState: blocker.value.state,
        });
      }
      quarantinedThreads.delete(threadId);

      const thread = yield* resolveThread(threadId);
      const session = thread?.session ?? null;
      if (
        thread !== undefined &&
        session !== null &&
        (session.status === "starting" ||
          session.status === "running" ||
          session.status === "error")
      ) {
        const settledAt = new Date().toISOString();
        yield* setThreadSession({
          threadId,
          session: {
            threadId,
            status: "interrupted",
            providerName: session.providerName ?? thread.modelSelection.provider,
            runtimeMode: session.runtimeMode,
            activeTurnId: null,
            lastError: null,
            updatedAt: settledAt,
          },
          expectedSession: session,
          createdAt: settledAt,
        }).pipe(
          // A newer provider event won the race; its session is authoritative.
          Effect.catchTag("OrchestrationCommandInvariantError", () => Effect.void),
        );
      }
      return earliestSequence;
    });

    const settleTerminalFailure = Effect.fnUntraced(function* (input: {
      readonly event: ProviderIntentEvent;
      readonly claimOwner: string;
      readonly state: "dead" | "uncertain";
      readonly detail: string;
    }) {
      yield* Effect.logError("provider command delivery entered terminal failure", {
        eventType: input.event.type,
        eventSequence: input.event.sequence,
        threadId: input.event.payload.threadId,
        state: input.state,
        detail: input.detail,
      });
      const settled = yield* deliveryRepository.markTerminalFailure({
        consumerName: PROVIDER_COMMAND_REACTOR_CONSUMER,
        eventSequence: input.event.sequence,
        expectedClaimOwner: input.claimOwner,
        state: input.state,
        error: input.detail,
        updatedAt: new Date().toISOString(),
      });
      if (!settled) {
        return yield* Effect.die(
          new Error(
            `Provider command delivery ${input.event.sequence} lost terminal settlement ownership`,
          ),
        );
      }
      quarantinedThreads.add(input.event.payload.threadId);
      yield* requireCursorAdvance(input.event);
    });

    const skipQuarantinedSideEffect = Effect.fnUntraced(function* (event: ProviderIntentEvent) {
      if (
        !isProviderSideEffectIntent(event) ||
        // An interrupt is the escape hatch out of a quarantined thread; skipping
        // it leaves the turn running with nothing left that could settle it.
        isQuarantineExemptProviderIntent(event) ||
        !(yield* isThreadQuarantined(event.payload.threadId))
      ) {
        return false;
      }
      // A newly accepted turn is an exact, durable signal that the user still
      // wants this thread to continue. Recover before processing it; no button,
      // timeout guess, or error-text classification participates in the decision.
      if (
        event.type === "thread.turn-start-requested" ||
        event.type === "thread.message-edit-resend-requested"
      ) {
        const recoveredAfter = yield* fenceAndAbandonThreadBlockers(event.payload.threadId);
        if (recoveredAfter !== null) {
          return false;
        }
      }
      yield* Effect.logWarning("provider command skipped for quarantined thread", {
        eventType: event.type,
        eventSequence: event.sequence,
        threadId: event.payload.threadId,
      });
      // A skipped turn start is a user-visible dead end: the projector has
      // already shown the thread as "starting", so silence here reads as an
      // infinite "Thinking". Surface the block and settle the session.
      if (
        event.type === "thread.turn-start-requested" ||
        event.type === "thread.message-edit-resend-requested"
      ) {
        yield* Effect.gen(function* () {
          const blocker = yield* deliveryRepository.firstBlockingDeliveryForThread({
            consumerName: PROVIDER_COMMAND_REACTOR_CONSUMER,
            threadId: event.payload.threadId,
          });
          const blockerDetail =
            Option.isSome(blocker) && blocker.value.lastError !== null
              ? blocker.value.lastError
              : "an earlier provider command failed";
          const createdAt = new Date().toISOString();
          yield* appendProviderFailureActivity({
            threadId: event.payload.threadId,
            kind: "provider.turn.start.failed",
            summary: PROVIDER_DELIVERY_BLOCK_SUMMARY,
            detail: `The message was not sent to the provider. Blocking failure: ${blockerDetail}`,
            turnId: null,
            createdAt,
          });
          yield* setThreadSessionError({
            threadId: event.payload.threadId,
            detail: formatProviderDeliveryBlockDetail(blockerDetail),
            createdAt,
          });
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("failed to surface quarantined-thread skip", {
              threadId: event.payload.threadId,
              cause: Cause.pretty(cause),
            }),
          ),
        );
      }
      yield* requireCursorAdvance(event);
      return true;
    });

    const processClaimedProviderIntent = Effect.fnUntraced(function* (event: ProviderIntentEvent) {
      const threadId = event.payload.threadId;
      if (yield* skipQuarantinedSideEffect(event)) return;

      const existing = yield* deliveryRepository.getDelivery({
        consumerName: PROVIDER_COMMAND_REACTOR_CONSUMER,
        eventSequence: event.sequence,
      });
      if (Option.isSome(existing)) {
        if (existing.value.state === "succeeded") {
          yield* requireCursorAdvance(event);
          return;
        }
        if (existing.value.state === "dead" || existing.value.state === "uncertain") {
          quarantinedThreads.add(threadId);
          yield* requireCursorAdvance(event);
          return;
        }
        if (existing.value.state === "inflight") {
          const expiresAt = Date.parse(existing.value.claimExpiresAt ?? "");
          const remainingMs = Number.isFinite(expiresAt) ? Math.max(0, expiresAt - Date.now()) : 0;
          if (remainingMs > 0) {
            yield* Effect.sleep(Duration.millis(remainingMs));
          }
          const expiredOwner = existing.value.claimOwner ?? "";
          if (!isReplaySafeClaimedProviderIntent(event)) {
            yield* settleTerminalFailure({
              event,
              claimOwner: expiredOwner,
              state: "uncertain",
              detail:
                "External provider command claim expired without a durable acceptance result; execution was not replayed.",
            });
            // This state is produced locally after process loss, so recovery
            // begins immediately instead of waiting for another user action.
            yield* fenceAndAbandonThreadBlockers(threadId);
            return;
          }
          const requeued = yield* deliveryRepository.requeueExpired({
            consumerName: PROVIDER_COMMAND_REACTOR_CONSUMER,
            eventSequence: event.sequence,
            expectedClaimOwner: expiredOwner,
            now: new Date().toISOString(),
            error: "Replay-safe provider command claim expired before settlement.",
          });
          if (!requeued) {
            return yield* Effect.die(
              new Error(
                `Replay-safe provider command delivery ${event.sequence} could not be requeued`,
              ),
            );
          }
        }
      }

      while (true) {
        const claimOwner = `${processOwner}:${event.sequence}`;
        const claimed = yield* deliveryRepository.claim({
          consumerName: PROVIDER_COMMAND_REACTOR_CONSUMER,
          eventSequence: event.sequence,
          threadId,
          claimOwner,
          claimedAt: new Date().toISOString(),
          claimExpiresAt: new Date(Date.now() + PROVIDER_COMMAND_CLAIM_LEASE_MS).toISOString(),
        });
        if (Option.isNone(claimed)) {
          return yield* Effect.die(
            new Error(`Provider command delivery ${event.sequence} could not be claimed`),
          );
        }

        const workerResult = yield* runBoundedProviderCall({
          label: `The provider command '${event.type}'`,
          timeout: commandEventTimeout,
          call: processDomainEvent(event),
        });
        if (workerResult._tag === "timeout") {
          // The delivery lock is single-permit and process-wide, so an attempt
          // that never returns is a total outage. Settle it as uncertain and
          // let the thread quarantine rather than block every other thread.
          if (event.type === "thread.turn-start-requested") {
            yield* surfaceTimedOutTurnStart(event, workerResult.detail).pipe(
              Effect.catchCause((cause) =>
                Effect.logError("failed to surface timed-out provider turn start", {
                  eventSequence: event.sequence,
                  threadId: event.payload.threadId,
                  cause: Cause.pretty(cause),
                }),
              ),
            );
          }
          yield* settleTerminalFailure({
            event,
            claimOwner,
            state: "uncertain",
            detail: workerResult.detail,
          });
          return;
        }
        const outcome: ProviderAttemptOutcome =
          workerResult._tag === "ok" ? { _tag: "accepted" } : workerResult.outcome;

        switch (outcome._tag) {
          case "accepted":
          case "rejected": {
            if (outcome._tag === "rejected") {
              yield* Effect.logWarning("provider command was rejected before acceptance", {
                eventType: event.type,
                eventSequence: event.sequence,
                threadId,
                detail: outcome.detail,
              });
            }
            const completed = yield* deliveryRepository.complete({
              consumerName: PROVIDER_COMMAND_REACTOR_CONSUMER,
              eventSequence: event.sequence,
              claimOwner,
              completedAt: new Date().toISOString(),
            });
            if (!completed) {
              return yield* Effect.die(
                new Error(`Provider command delivery ${event.sequence} lost settlement ownership`),
              );
            }
            yield* refreshCursor;
            return;
          }
          case "safe_retry": {
            if (claimed.value.attemptCount >= PROVIDER_COMMAND_SAFE_RETRY_LIMIT) {
              yield* settleTerminalFailure({
                event,
                claimOwner,
                state: "dead",
                detail: `Safe retry budget exhausted. ${outcome.detail}`,
              });
              return;
            }
            const retryable = yield* deliveryRepository.markRetryable({
              consumerName: PROVIDER_COMMAND_REACTOR_CONSUMER,
              eventSequence: event.sequence,
              expectedClaimOwner: claimOwner,
              error: outcome.detail,
              updatedAt: new Date().toISOString(),
            });
            if (!retryable) {
              return yield* Effect.die(
                new Error(`Provider command delivery ${event.sequence} lost retry ownership`),
              );
            }
            yield* Effect.sleep(PROVIDER_COMMAND_SAFE_RETRY_DELAY);
            break;
          }
          case "uncertain":
            yield* settleTerminalFailure({
              event,
              claimOwner,
              state: "uncertain",
              detail: outcome.detail,
            });
            return;
        }
      }
    });

    const processUnclaimedProviderIntent = Effect.fnUntraced(function* (
      event: ProviderIntentEvent,
    ) {
      if (yield* skipQuarantinedSideEffect(event)) return;
      yield* processDomainEventSafely(event);
      yield* requireCursorAdvance(event);
    });

    const processOrderedEvent = Effect.fnUntraced(function* (event: OrchestrationEvent) {
      if (event.sequence <= cursor) return;
      if (!isProviderIntentEvent(event)) {
        yield* requireCursorAdvance(event);
        return;
      }
      if (isClaimedProviderIntent(event)) {
        yield* processClaimedProviderIntent(event);
        return;
      }
      yield* processUnclaimedProviderIntent(event);
    });

    const readProviderIntentEvent = Effect.fnUntraced(function* (eventSequence: number) {
      const event = yield* readOrchestrationEventAtSequence(eventSequence);
      if (
        event === undefined ||
        event.sequence !== eventSequence ||
        !isProviderIntentEvent(event)
      ) {
        return yield* Effect.die(
          new Error(
            `Provider delivery ${eventSequence} has no matching provider-intent source event`,
          ),
        );
      }
      return event;
    });

    const replayQuarantinedThreadSideEffects = Effect.fnUntraced(function* (input: {
      readonly threadId: string;
      readonly afterSequence: number;
    }) {
      const replayThrough = cursor;
      if (replayThrough <= input.afterSequence) return;
      yield* Stream.runForEach(
        orchestrationEngine.readEventsThrough(input.afterSequence, replayThrough),
        (event) => {
          if (
            !isProviderIntentEvent(event) ||
            event.payload.threadId !== input.threadId ||
            !isProviderSideEffectIntent(event)
          ) {
            return Effect.void;
          }
          return isClaimedProviderIntent(event)
            ? processClaimedProviderIntent(event)
            : processUnclaimedProviderIntent(event);
        },
      );
    });

    const resumeRetryableDelivery = Effect.fnUntraced(function* (input: {
      readonly eventSequence: number;
      readonly threadId: string;
    }) {
      quarantinedThreads.delete(input.threadId);
      const event = yield* readProviderIntentEvent(input.eventSequence);
      if (!isClaimedProviderIntent(event)) {
        return yield* Effect.die(
          new Error(
            `Provider delivery ${input.eventSequence} does not own a claimed provider intent`,
          ),
        );
      }
      yield* processClaimedProviderIntent(event);
      const delivery = yield* deliveryRepository.getDelivery({
        consumerName: PROVIDER_COMMAND_REACTOR_CONSUMER,
        eventSequence: input.eventSequence,
      });
      if (Option.isSome(delivery) && delivery.value.state === "succeeded") {
        quarantinedThreads.delete(input.threadId);
        yield* replayQuarantinedThreadSideEffects({
          threadId: input.threadId,
          afterSequence: input.eventSequence,
        });
      }
    });

    reconcileDeliveryRuntime = (input) =>
      Effect.scoped(
        deliverySourceLock.withPermits(1)(
          Effect.gen(function* () {
            const reconciledAt = new Date().toISOString();
            const reconciled = yield* deliveryRepository.reconcile({
              reconciliationId: crypto.randomUUID(),
              consumerName: PROVIDER_COMMAND_REACTOR_CONSUMER,
              eventSequence: input.eventSequence,
              threadId: input.threadId,
              expectedState: input.expectedState,
              outcome: input.outcome,
              reconciledBy: input.reconciledBy,
              ...(input.note === undefined ? {} : { note: input.note }),
              reconciledAt,
            });
            if (Option.isNone(reconciled)) return null;

            if (input.outcome === "safe_retry") {
              yield* resumeRetryableDelivery(input);
            } else {
              quarantinedThreads.delete(input.threadId);
              yield* replayQuarantinedThreadSideEffects({
                threadId: input.threadId,
                afterSequence: input.eventSequence,
              });
            }

            const finalDelivery = yield* deliveryRepository.getDelivery({
              consumerName: PROVIDER_COMMAND_REACTOR_CONSUMER,
              eventSequence: input.eventSequence,
            });
            if (Option.isNone(finalDelivery) || finalDelivery.value.state === "inflight") {
              return yield* Effect.die(
                new Error(
                  `Provider delivery ${input.eventSequence} did not reach a reconciled state`,
                ),
              );
            }
            return {
              eventSequence: input.eventSequence,
              threadId: input.threadId,
              outcome: input.outcome,
              state: finalDelivery.value.state,
              reconciledAt,
            };
          }),
        ),
      ) as ReturnType<ProviderCommandReactorShape["reconcileDelivery"]>;

    // Every durable blocker is recovered at startup by first fencing the
    // provider runtime. The acceptance-ambiguous command itself is abandoned;
    // only later intents that Penkra provably skipped are replayed.
    yield* Effect.gen(function* () {
      const pageSize = 100;
      const failedThreads = new Set<ThreadId>();
      while (true) {
        const startupBlockers = yield* deliveryRepository.listBlockingDeliveries({
          consumerName: PROVIDER_COMMAND_REACTOR_CONSUMER,
          limit: pageSize,
        });
        if (startupBlockers.length === 0) break;
        const threadIds = new Set(startupBlockers.map((blocker) => blocker.threadId));
        let recoveredAny = false;
        for (const threadId of threadIds) {
          if (failedThreads.has(threadId)) continue;
          const recoveredAfter = yield* fenceAndAbandonThreadBlockers(threadId);
          if (recoveredAfter === null) {
            failedThreads.add(threadId);
            continue;
          }
          recoveredAny = true;
          yield* replayQuarantinedThreadSideEffects({ threadId, afterSequence: recoveredAfter });
        }
        if (!recoveredAny) break;
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("provider delivery blocker auto-heal failed", {
          cause: Cause.pretty(cause),
        }),
      ),
    );

    const retryableDeliveries = yield* deliveryRepository.listRetryableDeliveries(
      PROVIDER_COMMAND_REACTOR_CONSUMER,
    );
    yield* deliverySourceLock.withPermits(1)(
      Effect.forEach(retryableDeliveries, resumeRetryableDelivery, { discard: true }),
    );

    const processOrderedEventSerially = (event: OrchestrationEvent) =>
      deliverySourceLock.withPermits(1)(processOrderedEvent(event));

    const replayThrough = yield* orchestrationEngine.getEventHighWaterSequence;
    yield* Stream.runForEach(
      orchestrationEngine.readEventsThrough(cursor, replayThrough),
      processOrderedEventSerially,
    );
    yield* Stream.runForEach(liveEvents, processOrderedEventSerially).pipe(
      Effect.catchCause((cause) =>
        Effect.logError("provider command durable source stopped", {
          cause: Cause.pretty(cause),
        }).pipe(Effect.andThen(Effect.failCause(cause))),
      ),
      Effect.forkScoped,
    );
  });

  const start = seedThreadModelSelections.pipe(
    Effect.andThen(
      Effect.all([
        startProviderIntentSource.pipe(Effect.andThen(recoverQueuedTurnPromotionsSafely)),
        Stream.runForEach(providerService.streamEvents, (event) => {
          if (
            event.type !== "turn.completed" &&
            event.type !== "turn.aborted" &&
            event.type !== "session.exited" &&
            event.type !== "runtime.error"
          ) {
            return Effect.void;
          }
          return processQueueDrainEventSafely(event);
        }).pipe(Effect.forkScoped),
        Effect.forever(
          Effect.sleep(queuedTurnRecoveryInterval).pipe(
            Effect.andThen(recoverQueuedTurnPromotionsSafely),
          ),
        ).pipe(Effect.forkScoped),
      ]).pipe(Effect.asVoid),
    ),
    Effect.orDie,
  ) as ProviderCommandReactorShape["start"];

  const drain: ProviderCommandReactorShape["drain"] = Effect.gen(function* () {
    const targetSequence = yield* orchestrationEngine.getEventHighWaterSequence;
    while (true) {
      const consumerState = yield* deliveryRepository.getConsumerState(
        PROVIDER_COMMAND_REACTOR_CONSUMER,
      );
      if (Option.isSome(consumerState) && consumerState.value.lastAckedSequence >= targetSequence) {
        return;
      }
      yield* Effect.sleep(Duration.millis(5));
    }
  }).pipe(Effect.orDie);

  const listBlockingDeliveries: ProviderCommandReactorShape["listBlockingDeliveries"] = (input) =>
    deliveryRepository.listBlockingDeliveries({
      consumerName: PROVIDER_COMMAND_REACTOR_CONSUMER,
      ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
      limit: Math.max(1, Math.min(100, input.limit)),
    });

  const reconcileDelivery: ProviderCommandReactorShape["reconcileDelivery"] = (input) =>
    Effect.suspend(() =>
      reconcileDeliveryRuntime === undefined
        ? Effect.fail(new Error("Provider delivery reconciliation is not ready"))
        : reconcileDeliveryRuntime(input),
    );

  return {
    start,
    drain,
    listBlockingDeliveries,
    reconcileDelivery,
  } satisfies ProviderCommandReactorShape;
});

export const makeProviderCommandReactorLive = (options?: ProviderCommandReactorLiveOptions) =>
  Layer.effect(ProviderCommandReactor, make).pipe(
    Layer.provide(
      Layer.succeed(ProviderCommandReactorConfig, {
        commandEventTimeout: options?.commandEventTimeout ?? PROVIDER_COMMAND_EVENT_TIMEOUT,
        queuedTurnRecoveryInterval:
          options?.queuedTurnRecoveryInterval ?? QUEUED_TURN_RECOVERY_INTERVAL,
      }),
    ),
    Layer.provideMerge(OrchestrationEventDeliveryRepositoryLive),
    Layer.provideMerge(QueuedTurnPromotionRepositoryLive),
    Layer.provideMerge(ProjectionPendingInteractionRepositoryLive),
  );

export const ProviderCommandReactorLive = makeProviderCommandReactorLive();
