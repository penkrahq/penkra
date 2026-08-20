/**
 * ProviderAdapter - Provider-specific runtime adapter contract.
 *
 * Defines the provider-native session/protocol operations that `ProviderService`
 * routes to after resolving the target provider. Implementations should focus
 * on provider behavior only and avoid cross-provider orchestration concerns.
 *
 * @module ProviderAdapter
 */
import type {
  ApprovalRequestId,
  ProviderComposerCapabilities,
  ProviderConnectionId,
  ProviderApprovalDecision,
  ProviderForkThreadInput,
  ProviderForkThreadResult,
  ProviderKind,
  ProviderListAgentsInput,
  ProviderListAgentsResult,
  ProviderListCommandsInput,
  ProviderListCommandsResult,
  ProviderListModelsInput,
  ProviderListModelsResult,
  ProviderListPluginsInput,
  ProviderListPluginsResult,
  ProviderGetCapabilityHealthInput,
  ProviderGetCapabilityHealthResult,
  ProviderReadPluginInput,
  ProviderReadPluginResult,
  ProviderListSkillsResult,
  ProviderListSkillsInput,
  ProviderStartReviewInput,
  ProviderUserInputAnswers,
  ProviderRuntimeEvent,
  ProviderSendTurnInput,
  ProviderSteerTurnInput,
  ProviderSession,
  ProviderSessionStartInput,
  ServerVoiceTranscriptionInput,
  ServerVoiceTranscriptionResult,
  ThreadId,
  ProviderTurnStartResult,
  TurnId,
} from "@penkra/contracts";
import { Effect } from "effect";
import type { Stream } from "effect";

export type ProviderSessionModelSwitchMode = "in-session" | "restart-session" | "unsupported";

/**
 * Per-adapter ingress budget. A bounded queue makes a slow durable consumer
 * apply backpressure to the provider instead of growing the process heap
 * without limit during a persistence outage.
 */
export const PROVIDER_ADAPTER_RUNTIME_EVENT_BUFFER_CAPACITY = 2_048;

/** Wait until an adapter's already-admitted runtime events reach its stream consumer. */
export const awaitProviderRuntimeEventsDrained = (
  isEmpty: Effect.Effect<boolean>,
): Effect.Effect<void> =>
  Effect.suspend(() =>
    isEmpty.pipe(
      Effect.flatMap((empty) =>
        empty
          ? Effect.void
          : Effect.yieldNow.pipe(Effect.andThen(awaitProviderRuntimeEventsDrained(isEmpty))),
      ),
    ),
  );

/**
 * Structured payload for steering a running subagent. Mirrors the turn-input
 * context fields so adapters can project attachments/skills/mentions into the
 * provider-native steering channel (which is typically text-only).
 */
export interface ProviderSteerSubagentPayload {
  readonly input: string;
  readonly attachments?: ProviderSendTurnInput["attachments"];
  readonly skills?: ProviderSendTurnInput["skills"];
  readonly mentions?: ProviderSendTurnInput["mentions"];
}
export type ProviderConversationRollbackMode = "native" | "unsupported";

export interface ProviderAdapterCapabilities {
  /**
   * Declares whether changing the model on an existing session is supported.
   */
  readonly sessionModelSwitch: ProviderSessionModelSwitchMode;
  /** Restart-session adapters cannot rewind provider history and must rebuild context locally. */
  readonly conversationRollback?: ProviderConversationRollbackMode;
  readonly supportsSkillMentions?: boolean;
  readonly supportsSkillDiscovery?: boolean;
  readonly supportsNativeSlashCommandDiscovery?: boolean;
  readonly supportsPluginMentions?: boolean;
  readonly supportsPluginDiscovery?: boolean;
  readonly supportsRuntimeModelList?: boolean;
  readonly supportsTurnSteering?: boolean;
}

export interface ProviderThreadTurnSnapshot {
  readonly id: TurnId;
  readonly items: ReadonlyArray<unknown>;
}

export interface ProviderThreadSnapshot {
  readonly threadId: ThreadId;
  readonly turns: ReadonlyArray<ProviderThreadTurnSnapshot>;
  readonly cwd?: string | null;
}

/**
 * Server-only launch material resolved from one managed installation and one
 * Connection. It is intentionally absent from @penkra/contracts and therefore
 * cannot cross the client command boundary.
 */
export interface ProviderManagedLaunchContext {
  readonly binaryPath: string;
  readonly isolationKey: string;
  /** Null selects the provider's explicit anonymous/free route. */
  readonly connectionId?: ProviderConnectionId | null;
  /** Connection-owned provider profile. Never contains thread-native state. */
  readonly profileRoot: string;
  /** Exact immutable-generation root for this thread's provider-native state. */
  readonly nativeStateRoot: string;
  readonly childEnvironment: (baseEnv: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
}

export type ProviderAdapterSessionStartInput = ProviderSessionStartInput & {
  readonly managedLaunch?: ProviderManagedLaunchContext;
};

export type ProviderAdapterForkThreadInput = ProviderForkThreadInput & {
  readonly managedLaunch?: ProviderManagedLaunchContext;
};

export type ProviderAdapterVoiceTranscriptionInput = ServerVoiceTranscriptionInput & {
  readonly managedLaunch?: ProviderManagedLaunchContext;
};

export interface ProviderNativeResumeVerificationInput {
  readonly sourceResumeCursor: unknown;
  readonly managedLaunch: ProviderManagedLaunchContext;
  readonly cwd?: string;
  readonly modelSelection?: ProviderSessionStartInput["modelSelection"];
  readonly runtimeMode: ProviderSessionStartInput["runtimeMode"];
}

export interface ProviderNativeResumeVerificationResult {
  readonly providerSessionId: string;
  readonly resumeCursor: unknown;
}

export interface ProviderAdapterShape<TError> {
  /**
   * Provider kind implemented by this adapter.
   */
  readonly provider: ProviderKind;
  readonly capabilities: ProviderAdapterCapabilities;

  /**
   * Start a provider-backed session.
   */
  readonly startSession: (
    input: ProviderAdapterSessionStartInput,
  ) => Effect.Effect<ProviderSession, TError>;

  /**
   * Open and prove one exact native continuation without admitting a Penkra
   * session, emitting canonical runtime events, sending a user turn, or
   * retaining a provider process after the effect settles.
   */
  readonly verifyNativeResume?: (
    input: ProviderNativeResumeVerificationInput,
  ) => Effect.Effect<ProviderNativeResumeVerificationResult, TError>;

  /**
   * Send a turn to an active provider session.
   */
  readonly sendTurn: (
    input: ProviderSendTurnInput,
  ) => Effect.Effect<ProviderTurnStartResult, TError>;

  /**
   * Redirect an active turn toward a new prompt when the provider supports it.
   */
  readonly steerTurn?: (
    input: ProviderSteerTurnInput,
  ) => Effect.Effect<ProviderTurnStartResult, TError>;

  /**
   * Start a native provider review run when the adapter supports it.
   */
  readonly startReview?: (
    input: ProviderStartReviewInput,
  ) => Effect.Effect<ProviderTurnStartResult, TError>;

  /**
   * Interrupt an active turn.
   */
  readonly interruptTurn: (
    threadId: ThreadId,
    turnId?: TurnId,
    providerThreadId?: string,
  ) => Effect.Effect<void, TError>;

  /**
   * Stop one provider-native background task when the adapter supports it.
   */
  readonly stopTask?: (threadId: ThreadId, taskId: string) => Effect.Effect<void, TError>;

  /**
   * Move one in-flight foreground task to the background when the adapter supports it.
   */
  readonly backgroundTask?: (threadId: ThreadId, toolUseId: string) => Effect.Effect<void, TError>;

  /**
   * Deliver a mid-task user message to a running subagent when the adapter supports it.
   */
  readonly steerSubagent?: (
    threadId: ThreadId,
    providerThreadId: string,
    input: ProviderSteerSubagentPayload,
  ) => Effect.Effect<void, TError>;

  /**
   * Respond to an interactive approval request.
   */
  readonly respondToRequest: (
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) => Effect.Effect<void, TError>;

  /**
   * Respond to a structured user-input request.
   */
  readonly respondToUserInput: (
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    answers: ProviderUserInputAnswers,
  ) => Effect.Effect<void, TError>;

  /**
   * Stop one provider session.
   */
  /**
   * Stop and release every resource owned by a thread.
   *
   * This operation is idempotent: an already-stopped or unknown thread is a
   * successful no-op. Callers use it as a cleanup barrier after restarts, when
   * the persisted binding can outlive the adapter's in-memory session.
   */
  readonly stopSession: (threadId: ThreadId) => Effect.Effect<void, TError>;

  /**
   * List currently active provider sessions for this adapter.
   */
  readonly listSessions: () => Effect.Effect<ReadonlyArray<ProviderSession>>;

  /**
   * Check whether this adapter owns an active session id.
   */
  readonly hasSession: (threadId: ThreadId) => Effect.Effect<boolean>;

  /**
   * Read a provider thread snapshot.
   */
  readonly readThread: (threadId: ThreadId) => Effect.Effect<ProviderThreadSnapshot, TError>;

  /**
   * Roll back a provider thread by N turns.
   */
  readonly rollbackThread: (
    threadId: ThreadId,
    numTurns: number,
  ) => Effect.Effect<ProviderThreadSnapshot, TError>;

  /**
   * Trigger provider-native context compaction for a thread when supported.
   */
  readonly compactThread?: (threadId: ThreadId) => Effect.Effect<void, TError>;

  /**
   * Fork one provider thread into another persisted thread cursor when supported.
   *
   * Adapters may omit this to signal that exact native forking is unavailable.
   * Callers must not replace it with conversation-history reconstruction.
   */
  readonly forkThread?: (
    input: ProviderAdapterForkThreadInput,
  ) => Effect.Effect<ProviderForkThreadResult, TError>;

  /**
   * Stop all sessions owned by this adapter.
   */
  readonly stopAll: () => Effect.Effect<void, TError>;

  /**
   * Stop callback admission and drain every accepted runtime event into the
   * stream while its server-side consumer is still alive.
   */
  readonly drainRuntimeEvents: Effect.Effect<void, TError>;

  /**
   * Canonical runtime event stream emitted by this adapter.
   */
  readonly streamEvents: Stream.Stream<ProviderRuntimeEvent>;

  /**
   * Read provider-specific composer capabilities.
   */
  readonly getComposerCapabilities?: () => Effect.Effect<ProviderComposerCapabilities, TError>;

  /** Read health for optional provider capabilities in one active thread. */
  readonly getCapabilityHealth?: (
    input: ProviderGetCapabilityHealthInput,
  ) => Effect.Effect<ProviderGetCapabilityHealthResult, TError>;

  /**
   * List skills available for a given cwd.
   */
  readonly listSkills?: (
    input: ProviderListSkillsInput,
  ) => Effect.Effect<ProviderListSkillsResult, TError>;

  /**
   * List provider-native slash commands available for a given cwd.
   */
  readonly listCommands?: (
    input: ProviderListCommandsInput,
  ) => Effect.Effect<ProviderListCommandsResult, TError>;

  /**
   * List plugins available for the current provider/runtime.
   */
  readonly listPlugins?: (
    input: ProviderListPluginsInput,
  ) => Effect.Effect<ProviderListPluginsResult, TError>;

  /**
   * Read one plugin in detail from a marketplace entry.
   */
  readonly readPlugin?: (
    input: ProviderReadPluginInput,
  ) => Effect.Effect<ProviderReadPluginResult, TError>;

  /**
   * List models directly from the provider runtime when supported.
   */
  readonly listModels?: (
    input: ProviderListModelsInput & {
      readonly managedLaunch?: ProviderManagedLaunchContext;
      readonly internalProviderId?: string | null;
    },
  ) => Effect.Effect<ProviderListModelsResult, TError>;

  /**
   * List agents/subagents directly from the provider runtime when supported.
   */
  readonly listAgents?: (
    input: ProviderListAgentsInput & {
      readonly managedLaunch?: ProviderManagedLaunchContext;
      readonly internalProviderId?: string | null;
    },
  ) => Effect.Effect<ProviderListAgentsResult, TError>;

  /**
   * Transcribe one captured voice clip into plain text when supported.
   */
  readonly transcribeVoice?: (
    input: ProviderAdapterVoiceTranscriptionInput,
  ) => Effect.Effect<ServerVoiceTranscriptionResult, TError>;
}
