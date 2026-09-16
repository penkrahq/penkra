// FILE: chatLifecycleDiagnostics.ts
// Purpose: Captures the exact renderer inputs behind transcript working chrome.
// Layer: Web chat diagnostics

import type { OrchestrationEvent } from "@penkra/contracts";

export interface ChatLifecycleDiagnosticState {
  readonly threadId: string;
  readonly isServerThread: boolean;
  readonly isLocalDraftThread: boolean;
  readonly threadDetailSyncState: string | null;
  readonly threadDetailHydration: string;
  readonly projectedMessageCount: number;
  readonly optimisticUserMessageCount: number;
  readonly draftPromotedTo: string | null;
  readonly localDispatchActive: boolean;
  readonly localDispatchStartedAt: string | null;
  readonly localDispatchExpectedUserMessageId: string | null;
  readonly serverAcknowledgedLocalDispatch: boolean;
  readonly threadWorkStatus: string | null;
  readonly sessionStatus: string | null;
  readonly sessionUpdatedAt: string | null;
  readonly threadUpdatedAt: string | null;
  readonly orchestrationStatus: string | null;
  readonly activeTurnId: string | null;
  readonly latestTurnId: string | null;
  readonly latestTurnState: string | null;
  readonly latestTurnStartedAt: string | null;
  readonly latestTurnCompletedAt: string | null;
  // Resolved working owner, including message-delivery fallback.
  readonly pendingTurnStartMessageId: string | null;
  readonly projectedPendingTurnStartMessageId?: string | null;
  readonly hasSendPreflight?: boolean;
  readonly phase: string;
  readonly hasLiveTurnTail: boolean;
  readonly latestTurnSettledByProvider: boolean;
  readonly latestTurnSettled: boolean;
  readonly latestTurnLive: boolean;
  readonly hasLiveTurn: boolean;
  readonly isSendBusy: boolean;
  readonly hasPendingTurnStart: boolean;
  readonly isConnecting: boolean;
  readonly isEditingMessageHistory: boolean;
  readonly isTurnWorking: boolean;
  readonly isWorking: boolean;
  readonly showThinking: boolean;
  readonly activeWorkStartedAt: string | null;
  readonly streamingAssistantMessageCount: number;
  readonly latestMessageId: string | null;
  readonly latestMessageRole: string | null;
  readonly latestMessageCreatedAt: string | null;
  readonly latestMessageStreaming: boolean;
}

export interface ChatLifecycleDiagnosticSample extends ChatLifecycleDiagnosticState {
  readonly event: "derived-state";
  readonly sequence: number;
  readonly recordedAt: string;
  readonly performanceNow: number;
}

export type ChatLifecycleUiEvent =
  | "timeline-layout-committed"
  | "thinking-row-derived-visible"
  | "thinking-row-derived-hidden"
  | "working-timer-derived-visible"
  | "working-timer-derived-hidden"
  | "transcript-surface-visible"
  | "hydration-surface-visible"
  | "interrupt-dispatched"
  | "interrupt-receipt"
  | "interrupt-dispatch-failed"
  | "composer-submission-claimed"
  | "composer-visible-cleared"
  | "composer-submission-restored";

export interface ChatLifecycleUiDiagnosticSample {
  readonly event: ChatLifecycleUiEvent;
  readonly sequence: number;
  readonly recordedAt: string;
  readonly performanceNow: number;
  readonly threadId: string;
  readonly activeTurnId: string | null;
  readonly activeTurnStartedAt: string | null;
  readonly isWorking: boolean;
  readonly activeTurnInProgress?: boolean;
  readonly threadDetailHydration?: string;
  readonly visibleTimelineEntryIds?: readonly string[];
  readonly visibleWorkEntryIds?: readonly string[];
  readonly visibleWorkLogSequenceFloor?: number | null;
  readonly commandId?: string;
  readonly pendingMessageId?: string | null;
  readonly receiptSequence?: number;
  readonly composerPromptLength?: number;
  readonly composerOwnership?: "active" | "old-thread" | "none";
}

export interface ChatLifecycleSyncDiagnosticSample {
  readonly event: "sync-lifecycle-received" | "sync-lifecycle-applied";
  readonly sequence: number;
  readonly recordedAt: string;
  readonly performanceNow: number;
  readonly threadId: string;
  readonly orchestrationSequence: number;
  readonly orchestrationEventType: string;
  readonly occurredAt: string;
  readonly ingestedAt: string | null;
  readonly commandId: string | null;
}

export interface ChatSyncPublicationDiagnosticSample {
  readonly event:
    | "sync-publication-queued"
    | "sync-publication-flushed"
    | "sync-publication-apply-failed"
    | "sync-publication-recovery-scheduled"
    | "sync-publication-recovered"
    | "sync-publication-recovery-exhausted";
  readonly sequence: number;
  readonly recordedAt: string;
  readonly performanceNow: number;
  readonly rendererSessionId: string;
  readonly threadId: string;
  readonly route: string;
  readonly rendererVisibility: DocumentVisibilityState;
  readonly rendererHasFocus: boolean;
  readonly reason: "delivery" | "visible-timer" | "visibility-hidden" | "window-blur";
  readonly queuedDeliveryCount: number;
  readonly firstOrchestrationSequence: number;
  readonly lastOrchestrationSequence: number;
  readonly failureName?: string;
  readonly recoveryAttempt?: number;
}

export type ChatLifecycleSample =
  | ChatLifecycleDiagnosticSample
  | ChatLifecycleUiDiagnosticSample
  | ChatLifecycleSyncDiagnosticSample
  | ChatSyncPublicationDiagnosticSample;

const MAX_SAMPLES = 1_000;
const PERSISTED_SYNC_INCIDENTS_KEY = "penkra:chat-sync-incidents:v1";
const PERSISTED_SYNC_INCIDENT_MAX_AGE_MS = 10 * 60 * 1_000;
const MAX_PERSISTED_SYNC_INCIDENTS = 100;
const PERSISTED_SYNC_INCIDENT_EVENTS = new Set<ChatSyncPublicationDiagnosticSample["event"]>([
  "sync-publication-apply-failed",
  "sync-publication-recovery-scheduled",
  "sync-publication-recovered",
  "sync-publication-recovery-exhausted",
]);
interface ChatLifecycleDiagnosticBuffer {
  nextSequence: number;
  logToConsole: boolean;
  samples: ChatLifecycleSample[];
  lastSignatureByThreadId: Map<string, string>;
  rendererSessionId: string;
}

declare global {
  interface Window {
    __penkraChatLifecycleDiagnosticBuffer?: ChatLifecycleDiagnosticBuffer;
  }
}

const state: ChatLifecycleDiagnosticBuffer =
  typeof window !== "undefined" && window.__penkraChatLifecycleDiagnosticBuffer
    ? window.__penkraChatLifecycleDiagnosticBuffer
    : {
        nextSequence: 1,
        logToConsole: false,
        samples: [],
        lastSignatureByThreadId: new Map<string, string>(),
        rendererSessionId: crypto.randomUUID(),
      };

// A renderer that hot-updated from the first instrumentation build may retain
// the older buffer shape even though new module code has the current type.
const retainedState = state as ChatLifecycleDiagnosticBuffer & {
  rendererSessionId?: string;
};
retainedState.rendererSessionId ??= crypto.randomUUID();

// Samples recorded by the first hot-loaded instrumentation build predate the
// explicit event discriminator. Preserve that evidence and label it instead of
// clearing the buffer during the very transition we are trying to diagnose.
for (const sample of state.samples) {
  if (!("event" in sample)) {
    Object.assign(sample, { event: "derived-state" as const });
  }
}

if (typeof window !== "undefined") {
  // Keep the trace across Vite hot updates. That boundary is particularly
  // important for lifecycle bugs because adding instrumentation must not erase
  // the transition that motivated it.
  window.__penkraChatLifecycleDiagnosticBuffer = state;
}

function appendSample(sample: ChatLifecycleSample): void {
  state.samples.push(sample);
  if (state.samples.length > MAX_SAMPLES) {
    state.samples.splice(0, state.samples.length - MAX_SAMPLES);
  }
  if (state.logToConsole) {
    console.debug("[chat-lifecycle]", sample);
  }
  if (
    sample.event.startsWith("sync-publication-") &&
    PERSISTED_SYNC_INCIDENT_EVENTS.has(sample.event as ChatSyncPublicationDiagnosticSample["event"])
  ) {
    persistSyncIncident(sample as ChatSyncPublicationDiagnosticSample);
  }
}

function readPersistedSyncIncidents(now = Date.now()): ChatSyncPublicationDiagnosticSample[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const parsed = JSON.parse(
      localStorage.getItem(PERSISTED_SYNC_INCIDENTS_KEY) ?? "[]",
    ) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (sample): sample is ChatSyncPublicationDiagnosticSample =>
          typeof sample === "object" &&
          sample !== null &&
          "recordedAt" in sample &&
          typeof sample.recordedAt === "string" &&
          now - Date.parse(sample.recordedAt) <= PERSISTED_SYNC_INCIDENT_MAX_AGE_MS,
      )
      .slice(-MAX_PERSISTED_SYNC_INCIDENTS);
  } catch {
    return [];
  }
}

function persistSyncIncident(sample: ChatSyncPublicationDiagnosticSample): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(
      PERSISTED_SYNC_INCIDENTS_KEY,
      JSON.stringify(
        [...readPersistedSyncIncidents(), sample].slice(-MAX_PERSISTED_SYNC_INCIDENTS),
      ),
    );
  } catch {
    // Diagnostics must never interfere with transcript recovery.
  }
}

function diagnosticsAvailable(): boolean {
  return typeof performance !== "undefined";
}

export function recordChatLifecycleDiagnostic(input: ChatLifecycleDiagnosticState): void {
  if (!diagnosticsAvailable()) return;
  const signature = JSON.stringify(input);
  if (state.lastSignatureByThreadId.get(input.threadId) === signature) return;
  state.lastSignatureByThreadId.set(input.threadId, signature);

  const sample: ChatLifecycleDiagnosticSample = {
    event: "derived-state",
    sequence: state.nextSequence,
    recordedAt: new Date().toISOString(),
    performanceNow: performance.now(),
    ...input,
  };
  state.nextSequence += 1;
  appendSample(sample);
}

export function recordChatLifecycleUiDiagnostic(
  input: Omit<ChatLifecycleUiDiagnosticSample, "sequence" | "recordedAt" | "performanceNow">,
): void {
  if (!diagnosticsAvailable()) return;
  const sample: ChatLifecycleUiDiagnosticSample = {
    ...input,
    sequence: state.nextSequence,
    recordedAt: new Date().toISOString(),
    performanceNow: performance.now(),
  };
  state.nextSequence += 1;
  appendSample(sample);
}

/** Trace lifecycle delivery without retaining payloads or logging each text delta. */
export function recordChatLifecycleSyncDiagnostic(
  event: OrchestrationEvent,
  stage: "received" | "applied",
): void {
  if (!diagnosticsAvailable() || event.aggregateKind !== "thread") return;
  if (
    event.type !== "thread.turn-interrupt-requested" &&
    event.type !== "thread.turn-start-requested" &&
    event.type !== "thread.session-set" &&
    !(event.type === "thread.activity-appended" && event.payload.activity.kind === "turn.completed")
  )
    return;
  appendSample({
    event: stage === "received" ? "sync-lifecycle-received" : "sync-lifecycle-applied",
    sequence: state.nextSequence++,
    recordedAt: new Date().toISOString(),
    performanceNow: performance.now(),
    threadId: String(event.aggregateId),
    orchestrationSequence: event.sequence,
    orchestrationEventType: event.type,
    occurredAt: event.occurredAt,
    ingestedAt: event.metadata.ingestedAt ?? null,
    commandId: event.commandId === null ? null : String(event.commandId),
  });
}

/** Records renderer publication boundaries without retaining event payloads. */
export function recordChatSyncPublicationDiagnostic(
  input: Omit<
    ChatSyncPublicationDiagnosticSample,
    "sequence" | "recordedAt" | "performanceNow" | "rendererSessionId" | "route"
  >,
): void {
  if (!diagnosticsAvailable()) return;
  appendSample({
    ...input,
    sequence: state.nextSequence++,
    recordedAt: new Date().toISOString(),
    performanceNow: performance.now(),
    rendererSessionId: state.rendererSessionId,
    route: `${location.pathname}${location.hash}`,
  });
}

export function getChatLifecycleDiagnosticSamples(
  threadId?: string,
): readonly ChatLifecycleSample[] {
  return state.samples
    .filter((sample) => threadId === undefined || sample.threadId === threadId)
    .map((sample) => Object.assign({}, sample));
}

export function getPersistedChatSyncIncidents(): readonly ChatSyncPublicationDiagnosticSample[] {
  return readPersistedSyncIncidents().map((sample) => Object.assign({}, sample));
}

export function resetChatLifecycleDiagnostics(): void {
  state.nextSequence = 1;
  state.samples = [];
  state.lastSignatureByThreadId.clear();
}

export function setChatLifecycleConsoleLogging(enabled: boolean): void {
  state.logToConsole = enabled;
}

declare global {
  interface Window {
    penkraChatLifecycle?: {
      samples: typeof getChatLifecycleDiagnosticSamples;
      incidents: typeof getPersistedChatSyncIncidents;
      reset: typeof resetChatLifecycleDiagnostics;
      logToConsole: typeof setChatLifecycleConsoleLogging;
    };
  }
}

if (typeof window !== "undefined") {
  window.penkraChatLifecycle = {
    samples: getChatLifecycleDiagnosticSamples,
    incidents: getPersistedChatSyncIncidents,
    reset: resetChatLifecycleDiagnostics,
    logToConsole: setChatLifecycleConsoleLogging,
  };
}
