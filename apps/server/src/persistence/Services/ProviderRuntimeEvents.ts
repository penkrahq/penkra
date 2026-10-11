import type { ProviderRuntimeEvent } from "@penkra/contracts";
import { ServiceMap } from "effect";
import type { Effect } from "effect";

import type { PersistenceDecodeError, PersistenceSqlError } from "../Errors.ts";

export const PROVIDER_RUNTIME_INGESTION_CONSUMER = "provider-runtime-ingestion.v1";
export const PROVIDER_RUNTIME_EVENT_MAX_BYTES = 2 * 1024 * 1024;
export const PROVIDER_RUNTIME_EVENT_RETAIN_ACCEPTED = 512;
export const PROVIDER_RUNTIME_PROJECTION_FAILURE_ATTEMPT_LIMIT = 12;
export const PROVIDER_RUNTIME_PROJECTION_FAILURE_MIN_BLOCKED_MS = 30_000;
export const PROVIDER_RUNTIME_PROJECTION_RETRY_BASE_MS = 250;
export const PROVIDER_RUNTIME_PROJECTION_RETRY_MAX_MS = 5_000;

export interface PersistedProviderRuntimeEvent {
  readonly sequence: number;
  readonly event: ProviderRuntimeEvent;
  readonly persistedAt?: string;
}

export type ProviderRuntimeProjectionFailureStatus = "active" | "quarantined" | "resolved";

export interface ProviderRuntimeProjectionFailure {
  readonly sequence: number;
  readonly eventId: string;
  readonly threadId: string;
  readonly turnId: string | null;
  readonly eventType: string;
  readonly errorFingerprint: string;
  readonly errorDetail: string;
  readonly attemptCount: number;
  readonly firstFailedAt: string;
  readonly lastFailedAt: string;
  readonly nextRetryAt: string;
  readonly status: ProviderRuntimeProjectionFailureStatus;
  readonly quarantinedAt: string | null;
  readonly resolvedAt: string | null;
}

export type ProviderRuntimeEventRepositoryError = PersistenceSqlError | PersistenceDecodeError;

export interface ProviderRuntimeEventRepositoryShape {
  readonly append: (
    event: ProviderRuntimeEvent,
  ) => Effect.Effect<PersistedProviderRuntimeEvent, ProviderRuntimeEventRepositoryError>;
  readonly appendWithDiagnosticAdmission: (
    event: ProviderRuntimeEvent,
  ) => Effect.Effect<PersistedProviderRuntimeEvent | null, ProviderRuntimeEventRepositoryError>;
  readonly getHighWaterSequence: Effect.Effect<number, PersistenceSqlError>;
  readonly readAfter: (input: {
    readonly sequenceExclusive: number;
    readonly throughSequenceInclusive: number;
    readonly limit: number;
  }) => Effect.Effect<
    ReadonlyArray<PersistedProviderRuntimeEvent>,
    ProviderRuntimeEventRepositoryError
  >;
  /**
   * Returns a bounded ordered prefix for each non-quarantined thread.
   * This is the replay/drain path: it amortizes the eligibility scan while
   * preserving per-thread order and poison-head isolation.
   */
  readonly readPendingThreadEvents: (input: {
    readonly throughSequenceInclusive: number;
    readonly limit: number;
    readonly maxPerThread: number;
    readonly excludeThreadIds?: ReadonlyArray<string>;
    readonly onlyThreadId?: string;
  }) => Effect.Effect<
    ReadonlyArray<PersistedProviderRuntimeEvent>,
    ProviderRuntimeEventRepositoryError
  >;
  readonly readThreadEvents: (input: {
    readonly threadId: string;
    readonly throughSequenceInclusive: number;
    readonly beforeSequenceExclusive?: number;
    readonly limit: number;
    readonly turnId?: string;
    readonly eventTypes?: ReadonlyArray<string>;
  }) => Effect.Effect<
    ReadonlyArray<PersistedProviderRuntimeEvent>,
    ProviderRuntimeEventRepositoryError
  >;
  readonly readAcceptedOpenTurnEvents: (input: {
    readonly consumerName: string;
    readonly sequenceExclusive: number;
    readonly limit: number;
  }) => Effect.Effect<
    ReadonlyArray<PersistedProviderRuntimeEvent>,
    ProviderRuntimeEventRepositoryError
  >;
  readonly pruneSettledOpenTurns: Effect.Effect<void, PersistenceSqlError>;
  readonly getThreadCursor: (
    threadId: string,
  ) => Effect.Effect<number, ProviderRuntimeEventRepositoryError>;
  readonly advanceThreadCursor: (input: {
    readonly threadId: string;
    readonly eventSequence: number;
    readonly updatedAt: string;
  }) => Effect.Effect<boolean, PersistenceSqlError>;
  /** Same cursor transition, for callers that already own the SQL transaction. */
  readonly advanceThreadCursorInCurrentTransaction: (input: {
    readonly threadId: string;
    readonly eventSequence: number;
    readonly updatedAt: string;
  }) => Effect.Effect<boolean, PersistenceSqlError>;
  readonly recordProjectionFailure: (input: {
    readonly sequence: number;
    readonly errorFingerprint: string;
    readonly errorDetail: string;
    readonly failedAt: string;
    readonly attemptLimit?: number;
    readonly minBlockedMs?: number;
  }) => Effect.Effect<ProviderRuntimeProjectionFailure, ProviderRuntimeEventRepositoryError>;
  readonly listQuarantinedProjectionFailures: Effect.Effect<
    ReadonlyArray<ProviderRuntimeProjectionFailure>,
    ProviderRuntimeEventRepositoryError
  >;
  readonly listActiveProjectionFailures: Effect.Effect<
    ReadonlyArray<ProviderRuntimeProjectionFailure>,
    ProviderRuntimeEventRepositoryError
  >;
  readonly getThreadProjectionFailure: (
    threadId: string,
  ) => Effect.Effect<ProviderRuntimeProjectionFailure | null, ProviderRuntimeEventRepositoryError>;
  readonly releaseQuarantinedThread: (input: {
    readonly threadId: string;
    readonly releasedAt: string;
  }) => Effect.Effect<boolean, PersistenceSqlError>;
}

export class ProviderRuntimeEventRepository extends ServiceMap.Service<
  ProviderRuntimeEventRepository,
  ProviderRuntimeEventRepositoryShape
>()("penkra/persistence/Services/ProviderRuntimeEvents/ProviderRuntimeEventRepository") {}
