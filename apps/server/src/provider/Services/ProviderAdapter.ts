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
  ProviderComposerCapabilities,
  ProviderCatalogScope,
  ProviderCatalogKind,
  ProviderCatalogData,
  ProviderConnectionId,
  ProviderKind,
  ProviderGetCapabilityHealthInput,
  ProviderGetCapabilityHealthResult,
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
export type ProviderConversationRollbackMode = "native" | "unsupported";

export interface ProviderCatalogInvalidation {
  readonly provider: ProviderKind;
  readonly connectionId: ProviderConnectionId | null;
  readonly kinds: ReadonlyArray<ProviderCatalogKind>;
}

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
  /** Revalidate the exact admitted credential, not a profile folder or label. */
  readonly assertCurrentCredentials: Effect.Effect<void, unknown>;
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

export type ProviderAdapterVoiceTranscriptionInput = ServerVoiceTranscriptionInput & {
  readonly managedLaunch?: ProviderManagedLaunchContext;
};

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
  readonly interruptTurn: (threadId: ThreadId, turnId?: TurnId) => Effect.Effect<void, TError>;

  /**
   * Stop one provider-native background task when the adapter supports it.
   */
  readonly stopTask?: (threadId: ThreadId, taskId: string) => Effect.Effect<void, TError>;

  /**
   * Move one in-flight foreground task to the background when the adapter supports it.
   */
  readonly backgroundTask?: (threadId: ThreadId, toolUseId: string) => Effect.Effect<void, TError>;

  /**
   * Respond to a structured user-input request.
   */
  readonly respondToUserInput: (
    threadId: ThreadId,
    requestId: string,
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

  /** Close an account-owned program, including its idle pool entry. */
  readonly stopAccount?: (connectionId: ProviderConnectionId) => Effect.Effect<void, TError>;

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
   * Rewind a provider thread by N turns. Providers with exact-turn rewind
   * semantics use `beforeTurnId` as the first turn excluded from history.
   */
  readonly rollbackThread: (
    threadId: ThreadId,
    numTurns: number,
    beforeTurnId?: TurnId,
  ) => Effect.Effect<ProviderThreadSnapshot, TError>;

  /**
   * Trigger provider-native context compaction for a thread when supported.
   */
  readonly compactThread?: (threadId: ThreadId) => Effect.Effect<void, TError>;

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

  /** One native discovery load, authorized by the selected Connection rather than a thread. */
  readonly loadCatalog?: (input: {
    readonly scope: ProviderCatalogScope;
    readonly kinds: ReadonlyArray<ProviderCatalogKind>;
    readonly cwd: string;
    readonly managedLaunch: ProviderManagedLaunchContext;
    readonly internalProviderId: string | null;
  }) => Effect.Effect<ProviderCatalogData, TError>;
  readonly catalogChanges?: Stream.Stream<ProviderCatalogInvalidation>;

  /** Verify the provider's turn endpoint with an isolated, minimal request. */
  readonly probeTurnEndpoint?: (input: {
    readonly cwd: string;
    readonly managedLaunch: ProviderManagedLaunchContext;
    readonly model: string;
    readonly effort?: string;
  }) => Effect.Effect<boolean, TError>;

  /**
   * Transcribe one captured voice clip into plain text when supported.
   */
  readonly transcribeVoice?: (
    input: ProviderAdapterVoiceTranscriptionInput,
  ) => Effect.Effect<ServerVoiceTranscriptionResult, TError>;
}
