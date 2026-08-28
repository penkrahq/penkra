import { NonNegativeInt, ProviderRuntimeEvent } from "@penkra/contracts";
import { Effect, Layer, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  PersistenceDecodeError,
  toPersistenceDecodeError,
  toPersistenceSqlError,
} from "../Errors.ts";
import {
  PROVIDER_RUNTIME_EVENT_MAX_BYTES,
  PROVIDER_RUNTIME_EVENT_RETAIN_ACCEPTED,
  PROVIDER_RUNTIME_PROJECTION_FAILURE_ATTEMPT_LIMIT,
  PROVIDER_RUNTIME_PROJECTION_FAILURE_MIN_BLOCKED_MS,
  PROVIDER_RUNTIME_PROJECTION_RETRY_BASE_MS,
  PROVIDER_RUNTIME_PROJECTION_RETRY_MAX_MS,
  ProviderRuntimeEventRepository,
  type PersistedProviderRuntimeEvent,
  type ProviderRuntimeProjectionFailure,
  type ProviderRuntimeEventRepositoryShape,
} from "../Services/ProviderRuntimeEvents.ts";

/**
 * How far the consumer cursor may advance between journal retention scans.
 *
 * Retention keeps every event of an open turn plus a trailing diagnostic tail,
 * so while a turn streams there is nothing new to delete, yet the scan has no
 * lower bound and re-probes the whole retained backlog on every single event —
 * quadratic in the length of a turn (measured: 1.38 ms/event at 8k events,
 * 3.07 ms/event at 16k events, ~25 s cumulative).
 *
 * Scanning once per interval instead makes that cost linear-ish while changing
 * nothing about what is retained: skipping a scan can only delay a delete, and
 * every event that settles a turn forces a scan immediately, so the backlog of
 * a finished turn is still released as soon as it becomes deletable. The bound
 * on extra retained rows is one interval's worth of accepted events.
 *
 * Deliberately matched to PROVIDER_RUNTIME_EVENT_RETAIN_ACCEPTED: roughly one
 * scan per tail-length of accepted events falling out of the diagnostic tail.
 */
const PROVIDER_RUNTIME_EVENT_RETENTION_SCAN_INTERVAL = PROVIDER_RUNTIME_EVENT_RETAIN_ACCEPTED;

const ProviderRuntimeEventJson = Schema.fromJsonString(ProviderRuntimeEvent);
const encodeEvent = Schema.encodeEffect(ProviderRuntimeEventJson);
const decodeEvent = Schema.decodeUnknownEffect(ProviderRuntimeEventJson);

const StoredRowSchema = Schema.Struct({
  sequence: NonNegativeInt,
  eventJson: Schema.String,
});
const decodeStoredRow = Schema.decodeUnknownEffect(StoredRowSchema);

const ProjectionFailureRowSchema = Schema.Struct({
  sequence: NonNegativeInt,
  eventId: Schema.String,
  threadId: Schema.String,
  turnId: Schema.NullOr(Schema.String),
  eventType: Schema.String,
  errorFingerprint: Schema.String,
  errorDetail: Schema.String,
  attemptCount: NonNegativeInt,
  firstFailedAt: Schema.String,
  lastFailedAt: Schema.String,
  nextRetryAt: Schema.String,
  status: Schema.Literals(["active", "quarantined", "resolved"]),
  quarantinedAt: Schema.NullOr(Schema.String),
  resolvedAt: Schema.NullOr(Schema.String),
});
const decodeProjectionFailureRow = Schema.decodeUnknownEffect(ProjectionFailureRowSchema);

const encodePersistableEvent = (event: ProviderRuntimeEvent) =>
  Effect.gen(function* () {
    const eventJson = yield* encodeEvent(event).pipe(
      Effect.mapError(toPersistenceDecodeError("ProviderRuntimeEvent.append.encode")),
    );
    const originalBytes = Buffer.byteLength(eventJson, "utf8");
    if (originalBytes <= PROVIDER_RUNTIME_EVENT_MAX_BYTES) {
      return { event, eventJson };
    }

    if (event.raw !== undefined) {
      const compactedEvent = {
        ...event,
        raw: {
          source: event.raw.source,
          ...(event.raw.method !== undefined ? { method: event.raw.method } : {}),
          ...(event.raw.messageType !== undefined ? { messageType: event.raw.messageType } : {}),
          payload: {
            penkraTruncated: true,
            reason: "provider runtime event exceeded the durable journal size limit",
            originalBytes,
          },
        },
      } satisfies ProviderRuntimeEvent;
      const compactedJson = yield* encodeEvent(compactedEvent).pipe(
        Effect.mapError(toPersistenceDecodeError("ProviderRuntimeEvent.append.compact")),
      );
      if (Buffer.byteLength(compactedJson, "utf8") <= PROVIDER_RUNTIME_EVENT_MAX_BYTES) {
        return { event: compactedEvent, eventJson: compactedJson };
      }
    }

    return yield* new PersistenceDecodeError({
      operation: "ProviderRuntimeEvent.append",
      issue: `Provider runtime event exceeds ${PROVIDER_RUNTIME_EVENT_MAX_BYTES} bytes after raw payload compaction.`,
    });
  });

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const appendInCurrentTransaction = (event: ProviderRuntimeEvent) =>
    Effect.gen(function* () {
      const persistable = yield* encodePersistableEvent(event);
      const persistedEvent = persistable.event;
      const eventJson = persistable.eventJson;
      const rows = yield* sql<Record<string, unknown>>`
        INSERT INTO provider_runtime_events (
          event_id, thread_id, turn_id, lifecycle_generation, event_type,
          event_json, persisted_at
        ) VALUES (
          ${event.eventId}, ${event.threadId}, ${event.turnId ?? null},
          ${event.lifecycleGeneration ?? null},
          ${event.type}, ${eventJson}, ${new Date().toISOString()}
        )
        ON CONFLICT(event_id) DO UPDATE SET event_id = excluded.event_id
        RETURNING sequence, event_json AS "eventJson"
      `.pipe(Effect.mapError(toPersistenceSqlError("ProviderRuntimeEvent.append")));
      const row = yield* decodeStoredRow(rows[0]).pipe(
        Effect.mapError(toPersistenceDecodeError("ProviderRuntimeEvent.append.row")),
      );
      if (row.eventJson !== eventJson) {
        const existingEvent = yield* decodeEvent(row.eventJson).pipe(
          Effect.mapError(toPersistenceDecodeError("ProviderRuntimeEvent.append.existing")),
        );
        const existingAtReplayTime = yield* encodeEvent({
          ...existingEvent,
          // Adapters with a provider-native cursor may intentionally reuse a stable event id on
          // replay while the local observation time and lifecycle fence change. Adapters without
          // such an occurrence identity keep their unique per-delivery ids.
          createdAt: persistedEvent.createdAt,
          ...(persistedEvent.lifecycleGeneration !== undefined
            ? { lifecycleGeneration: persistedEvent.lifecycleGeneration }
            : { lifecycleGeneration: undefined }),
        }).pipe(Effect.mapError(toPersistenceDecodeError("ProviderRuntimeEvent.append.replay")));
        if (existingAtReplayTime !== eventJson) {
          return yield* new PersistenceDecodeError({
            operation: "ProviderRuntimeEvent.append",
            issue: `Provider event '${event.eventId}' was reused with different content.`,
          });
        }
      }
      return {
        sequence: row.sequence,
        event: persistedEvent,
      } satisfies PersistedProviderRuntimeEvent;
    });

  // One SQLite statement is already atomic. The conflict path only validates
  // immutable content, so live delivery does not need an explicit transaction.
  const append: ProviderRuntimeEventRepositoryShape["append"] = appendInCurrentTransaction;

  const getHighWaterSequence = sql<{ readonly highWaterSequence: number }>`
    SELECT COALESCE(MAX(sequence), 0) AS "highWaterSequence"
    FROM provider_runtime_events
  `.pipe(
    Effect.map((rows) => rows[0]?.highWaterSequence ?? 0),
    Effect.mapError(toPersistenceSqlError("ProviderRuntimeEvent.getHighWaterSequence")),
  );

  const readAfter: ProviderRuntimeEventRepositoryShape["readAfter"] = (input) => {
    const limit = Math.max(1, Math.min(1_000, Math.floor(input.limit)));
    return Effect.gen(function* () {
      const rows = yield* sql<Record<string, unknown>>`
        SELECT sequence, event_json AS "eventJson"
        FROM provider_runtime_events
        WHERE sequence > ${input.sequenceExclusive}
          AND sequence <= ${input.throughSequenceInclusive}
        ORDER BY sequence ASC
        LIMIT ${limit}
      `.pipe(Effect.mapError(toPersistenceSqlError("ProviderRuntimeEvent.readAfter")));
      return yield* Effect.forEach(
        rows,
        (unknownRow) =>
          Effect.gen(function* () {
            const row = yield* decodeStoredRow(unknownRow).pipe(
              Effect.mapError(toPersistenceDecodeError("ProviderRuntimeEvent.readAfter.row")),
            );
            const event = yield* decodeEvent(row.eventJson).pipe(
              Effect.mapError(
                toPersistenceDecodeError(
                  `ProviderRuntimeEvent.readAfter(sequence=${row.sequence})`,
                ),
              ),
            );
            return { sequence: row.sequence, event } satisfies PersistedProviderRuntimeEvent;
          }),
        { concurrency: 1 },
      );
    });
  };

  const readPendingThreadHeads: ProviderRuntimeEventRepositoryShape["readPendingThreadHeads"] = (
    input,
  ) => {
    const limit = Math.max(1, Math.min(1_000, Math.floor(input.limit)));
    const availableAt = new Date().toISOString();
    return Effect.gen(function* () {
      const rows = yield* sql<Record<string, unknown>>`
        WITH eligible AS (
          SELECT
            event.sequence,
            event.event_json AS "eventJson",
            ROW_NUMBER() OVER (
              PARTITION BY event.thread_id
              ORDER BY event.sequence ASC
            ) AS thread_position
          FROM provider_runtime_events AS event
          LEFT JOIN provider_runtime_thread_cursors AS cursor
            ON cursor.thread_id = event.thread_id
          WHERE event.sequence > COALESCE(cursor.last_acked_sequence, 0)
            AND event.sequence <= ${input.throughSequenceInclusive}
            AND NOT EXISTS (
              SELECT 1
              FROM provider_runtime_projection_failures AS failure
              WHERE failure.thread_id = event.thread_id
                AND (
                  failure.status = 'quarantined'
                  OR (failure.status = 'active' AND failure.next_retry_at > ${availableAt})
                )
            )
        )
        SELECT sequence, "eventJson"
        FROM eligible
        WHERE thread_position = 1
        ORDER BY sequence ASC
        LIMIT ${limit}
      `.pipe(Effect.mapError(toPersistenceSqlError("ProviderRuntimeEvent.readPendingThreadHeads")));
      return yield* Effect.forEach(
        rows,
        (unknownRow) =>
          Effect.gen(function* () {
            const row = yield* decodeStoredRow(unknownRow).pipe(
              Effect.mapError(
                toPersistenceDecodeError("ProviderRuntimeEvent.readPendingThreadHeads.row"),
              ),
            );
            const event = yield* decodeEvent(row.eventJson).pipe(
              Effect.mapError(
                toPersistenceDecodeError(
                  `ProviderRuntimeEvent.readPendingThreadHeads(sequence=${row.sequence})`,
                ),
              ),
            );
            return { sequence: row.sequence, event } satisfies PersistedProviderRuntimeEvent;
          }),
        { concurrency: 1 },
      );
    });
  };

  const readPendingThreadEvents: ProviderRuntimeEventRepositoryShape["readPendingThreadEvents"] = (
    input,
  ) => {
    const limit = Math.max(1, Math.min(1_000, Math.floor(input.limit)));
    const maxPerThread = Math.max(1, Math.min(limit, Math.floor(input.maxPerThread)));
    const availableAt = new Date().toISOString();
    return Effect.gen(function* () {
      const rows = yield* sql<Record<string, unknown>>`
        WITH eligible AS (
          SELECT
            event.sequence,
            event.event_json AS "eventJson",
            ROW_NUMBER() OVER (
              PARTITION BY event.thread_id
              ORDER BY event.sequence ASC
            ) AS thread_position
          FROM provider_runtime_events AS event
          LEFT JOIN provider_runtime_thread_cursors AS cursor
            ON cursor.thread_id = event.thread_id
          WHERE event.sequence > COALESCE(cursor.last_acked_sequence, 0)
            AND event.sequence <= ${input.throughSequenceInclusive}
            AND NOT EXISTS (
              SELECT 1
              FROM provider_runtime_projection_failures AS failure
              WHERE failure.thread_id = event.thread_id
                AND (
                  failure.status = 'quarantined'
                  OR (failure.status = 'active' AND failure.next_retry_at > ${availableAt})
                )
            )
        )
        SELECT sequence, "eventJson"
        FROM eligible
        WHERE thread_position <= ${maxPerThread}
        ORDER BY sequence ASC
        LIMIT ${limit}
      `.pipe(
        Effect.mapError(toPersistenceSqlError("ProviderRuntimeEvent.readPendingThreadEvents")),
      );
      return yield* Effect.forEach(
        rows,
        (unknownRow) =>
          Effect.gen(function* () {
            const row = yield* decodeStoredRow(unknownRow).pipe(
              Effect.mapError(
                toPersistenceDecodeError("ProviderRuntimeEvent.readPendingThreadEvents.row"),
              ),
            );
            const event = yield* decodeEvent(row.eventJson).pipe(
              Effect.mapError(
                toPersistenceDecodeError(
                  `ProviderRuntimeEvent.readPendingThreadEvents(sequence=${row.sequence})`,
                ),
              ),
            );
            return { sequence: row.sequence, event } satisfies PersistedProviderRuntimeEvent;
          }),
        { concurrency: 1 },
      );
    });
  };

  const getThreadCoverage: ProviderRuntimeEventRepositoryShape["getThreadCoverage"] = (threadId) =>
    sql<{
      readonly retainedCount: number;
      readonly oldestSequence: number | null;
      readonly highWaterSequence: number;
    }>`
      SELECT
        COUNT(*) AS "retainedCount",
        MIN(sequence) AS "oldestSequence",
        COALESCE(MAX(sequence), 0) AS "highWaterSequence"
      FROM provider_runtime_events
      WHERE thread_id = ${threadId}
    `.pipe(
      Effect.map(
        (rows) => rows[0] ?? { retainedCount: 0, oldestSequence: null, highWaterSequence: 0 },
      ),
      Effect.mapError(toPersistenceSqlError("ProviderRuntimeEvent.getThreadCoverage")),
    );

  const readThreadEvents: ProviderRuntimeEventRepositoryShape["readThreadEvents"] = (input) => {
    const beforeSequence = input.beforeSequenceExclusive ?? Number.MAX_SAFE_INTEGER;
    const turnFilter = input.turnId === undefined ? sql`` : sql`AND turn_id = ${input.turnId}`;
    const typeFilter =
      input.eventTypes === undefined || input.eventTypes.length === 0
        ? sql``
        : sql`AND event_type IN ${sql.in(input.eventTypes)}`;
    return Effect.gen(function* () {
      const rows = yield* sql<Record<string, unknown>>`
        SELECT sequence, event_json AS "eventJson"
        FROM provider_runtime_events
        WHERE thread_id = ${input.threadId}
          AND sequence <= ${input.throughSequenceInclusive}
          AND sequence < ${beforeSequence}
          ${turnFilter}
          ${typeFilter}
        ORDER BY sequence DESC
        LIMIT ${Math.max(1, Math.min(201, Math.floor(input.limit)))}
      `.pipe(Effect.mapError(toPersistenceSqlError("ProviderRuntimeEvent.readThreadEvents")));
      return yield* Effect.forEach(
        rows,
        (unknownRow) =>
          Effect.gen(function* () {
            const row = yield* decodeStoredRow(unknownRow).pipe(
              Effect.mapError(
                toPersistenceDecodeError("ProviderRuntimeEvent.readThreadEvents.row"),
              ),
            );
            const event = yield* decodeEvent(row.eventJson).pipe(
              Effect.mapError(
                toPersistenceDecodeError(
                  `ProviderRuntimeEvent.readThreadEvents(sequence=${row.sequence})`,
                ),
              ),
            );
            return { sequence: row.sequence, event } satisfies PersistedProviderRuntimeEvent;
          }),
        { concurrency: 1 },
      );
    });
  };

  const readAcceptedOpenTurnEvents: ProviderRuntimeEventRepositoryShape["readAcceptedOpenTurnEvents"] =
    (input) => {
      // The consumer name remains in the public shape for compatibility with
      // diagnostic callers. Acceptance is now owned by each thread cursor.
      void input.consumerName;
      const limit = Math.max(1, Math.min(1_000, Math.floor(input.limit)));
      return Effect.gen(function* () {
        const rows = yield* sql<Record<string, unknown>>`
          SELECT event.sequence, event.event_json AS "eventJson"
          FROM provider_runtime_events AS event
          INNER JOIN provider_runtime_open_turns AS open_turn
            ON open_turn.thread_id = event.thread_id
           AND open_turn.turn_id = event.turn_id
           AND event.sequence >= open_turn.first_sequence
          INNER JOIN provider_runtime_thread_cursors AS cursor
            ON cursor.thread_id = event.thread_id
           AND event.sequence <= cursor.last_acked_sequence
          WHERE event.sequence > ${input.sequenceExclusive}
          ORDER BY event.sequence ASC
          LIMIT ${limit}
        `.pipe(
          Effect.mapError(toPersistenceSqlError("ProviderRuntimeEvent.readAcceptedOpenTurnEvents")),
        );
        return yield* Effect.forEach(
          rows,
          (unknownRow) =>
            Effect.gen(function* () {
              const row = yield* decodeStoredRow(unknownRow).pipe(
                Effect.mapError(
                  toPersistenceDecodeError("ProviderRuntimeEvent.readAcceptedOpenTurnEvents.row"),
                ),
              );
              const event = yield* decodeEvent(row.eventJson).pipe(
                Effect.mapError(
                  toPersistenceDecodeError(
                    `ProviderRuntimeEvent.readAcceptedOpenTurnEvents(sequence=${row.sequence})`,
                  ),
                ),
              );
              return { sequence: row.sequence, event } satisfies PersistedProviderRuntimeEvent;
            }),
          { concurrency: 1 },
        );
      });
    };

  const pruneSettledOpenTurns: ProviderRuntimeEventRepositoryShape["pruneSettledOpenTurns"] = sql`
      DELETE FROM provider_runtime_open_turns
      WHERE EXISTS (
        SELECT 1
        FROM projection_turns AS turn
        WHERE turn.thread_id = provider_runtime_open_turns.thread_id
          AND turn.turn_id = provider_runtime_open_turns.turn_id
          AND (
            turn.state IN ('interrupted', 'completed', 'error')
            OR turn.completed_at IS NOT NULL
          )
      )
    `.pipe(
    Effect.asVoid,
    Effect.mapError(toPersistenceSqlError("ProviderRuntimeEvent.pruneSettledOpenTurns")),
  );

  const getThreadCursor: ProviderRuntimeEventRepositoryShape["getThreadCursor"] = (threadId) =>
    sql<{ readonly lastAckedSequence: number }>`
      SELECT last_acked_sequence AS "lastAckedSequence"
      FROM provider_runtime_thread_cursors
      WHERE thread_id = ${threadId}
    `.pipe(
      Effect.map((rows) => rows[0]?.lastAckedSequence ?? 0),
      Effect.mapError(toPersistenceSqlError("ProviderRuntimeEvent.getThreadCursor")),
    );

  const updateOpenTurnLedger = (input: {
    readonly eventType: string;
    readonly threadId: string;
    readonly turnId: string | null;
    readonly eventSequence: number;
    readonly updatedAt: string;
  }) =>
    Effect.gen(function* () {
      const isTerminalTurnEvent =
        input.eventType === "turn.completed" || input.eventType === "turn.aborted";
      const isThreadTerminalEvent =
        input.eventType === "session.exited" || input.eventType === "runtime.error";
      if (input.turnId !== null && !isTerminalTurnEvent && !isThreadTerminalEvent) {
        yield* sql`
          INSERT INTO provider_runtime_open_turns (
            thread_id, turn_id, first_sequence, updated_at
          )
          SELECT
            ${input.threadId}, ${input.turnId}, ${input.eventSequence}, ${input.updatedAt}
          WHERE NOT EXISTS (
            SELECT 1
            FROM projection_turns AS turn
            WHERE turn.thread_id = ${input.threadId}
              AND turn.turn_id = ${input.turnId}
              AND (
                turn.state IN ('interrupted', 'completed', 'error')
                OR turn.completed_at IS NOT NULL
              )
          )
          ON CONFLICT (thread_id, turn_id) DO UPDATE SET
            first_sequence = MIN(
              provider_runtime_open_turns.first_sequence,
              excluded.first_sequence
            ),
            updated_at = excluded.updated_at
        `;
      } else if (input.turnId !== null) {
        yield* sql`
          DELETE FROM provider_runtime_open_turns
          WHERE thread_id = ${input.threadId} AND turn_id = ${input.turnId}
        `;
      } else if (isThreadTerminalEvent) {
        yield* sql`
          DELETE FROM provider_runtime_open_turns
          WHERE thread_id = ${input.threadId}
        `;
      } else if (isTerminalTurnEvent) {
        yield* sql`
          DELETE FROM provider_runtime_open_turns
          WHERE thread_id = ${input.threadId}
            AND 1 = (
              SELECT COUNT(*) FROM provider_runtime_open_turns
              WHERE thread_id = ${input.threadId}
            )
        `;
      }
      return isTerminalTurnEvent || isThreadTerminalEvent;
    });

  // Highest accepted sequence whose retention scan has already run. This is a
  // process-local performance hint only; losing it causes an earlier safe scan.
  let lastThreadRetentionScanSequence = 0;

  const advanceThreadCursorInCurrentTransaction: ProviderRuntimeEventRepositoryShape["advanceThreadCursorInCurrentTransaction"] =
    (input) => {
      let retentionScanSequence: number | null = null;
      return Effect.gen(function* () {
        const cursorRows = yield* sql<{ readonly lastAckedSequence: number }>`
            SELECT last_acked_sequence AS "lastAckedSequence"
            FROM provider_runtime_thread_cursors
            WHERE thread_id = ${input.threadId}
          `;
        const cursor = cursorRows[0]?.lastAckedSequence ?? 0;
        if (cursor >= input.eventSequence) return true;

        const nextRows = yield* sql<{ readonly sequence: number | null }>`
            SELECT MIN(sequence) AS sequence
            FROM provider_runtime_events
            WHERE thread_id = ${input.threadId}
              AND sequence > ${cursor}
          `;
        if (nextRows[0]?.sequence !== input.eventSequence) return false;

        const eventRows = yield* sql<{
          readonly eventType: string;
          readonly threadId: string;
          readonly turnId: string | null;
        }>`
            SELECT event_type AS "eventType", thread_id AS "threadId", turn_id AS "turnId"
            FROM provider_runtime_events
            WHERE sequence = ${input.eventSequence}
          `;
        const event = eventRows[0];
        if (!event || event.threadId !== input.threadId) return false;

        yield* sql`
            INSERT INTO provider_runtime_thread_cursors (
              thread_id, last_acked_sequence, created_at, updated_at
            ) VALUES (
              ${input.threadId}, ${input.eventSequence}, ${input.updatedAt}, ${input.updatedAt}
            )
            ON CONFLICT (thread_id) DO UPDATE SET
              last_acked_sequence = excluded.last_acked_sequence,
              updated_at = excluded.updated_at
            WHERE provider_runtime_thread_cursors.last_acked_sequence = ${cursor}
          `;

        const acceptedRows = yield* sql<{ readonly lastAckedSequence: number }>`
            SELECT last_acked_sequence AS "lastAckedSequence"
            FROM provider_runtime_thread_cursors
            WHERE thread_id = ${input.threadId}
          `;
        if (acceptedRows[0]?.lastAckedSequence !== input.eventSequence) return false;

        yield* sql`
            UPDATE provider_runtime_projection_failures
            SET status = 'resolved', resolved_at = ${input.updatedAt}
            WHERE sequence = ${input.eventSequence}
              AND status = 'active'
          `;

        const settlesOpenTurns = yield* updateOpenTurnLedger({
          eventType: event.eventType,
          threadId: event.threadId,
          turnId: event.turnId,
          eventSequence: input.eventSequence,
          updatedAt: input.updatedAt,
        });

        if (
          !settlesOpenTurns &&
          input.eventSequence - lastThreadRetentionScanSequence <
            PROVIDER_RUNTIME_EVENT_RETENTION_SCAN_INTERVAL
        ) {
          return true;
        }
        retentionScanSequence = input.eventSequence;

        yield* sql`
            DELETE FROM provider_runtime_events AS event
            WHERE EXISTS (
                SELECT 1
                FROM provider_runtime_thread_cursors AS cursor
                WHERE cursor.thread_id = event.thread_id
                  AND cursor.last_acked_sequence >= event.sequence
              )
              AND NOT EXISTS (
                SELECT 1
                FROM provider_runtime_projection_failures AS failure
                WHERE failure.sequence = event.sequence
                  AND failure.status = 'quarantined'
              )
              AND NOT EXISTS (
                SELECT 1
                FROM provider_runtime_open_turns AS open_turn
                WHERE open_turn.thread_id = event.thread_id
                  AND open_turn.turn_id = event.turn_id
                  AND event.sequence >= open_turn.first_sequence
              )
              AND event.sequence NOT IN (
                SELECT sequence
                FROM provider_runtime_events
                ORDER BY sequence DESC
                LIMIT ${PROVIDER_RUNTIME_EVENT_RETAIN_ACCEPTED}
              )
          `;
        return true;
      }).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            if (retentionScanSequence !== null) {
              lastThreadRetentionScanSequence = Math.max(
                lastThreadRetentionScanSequence,
                retentionScanSequence,
              );
            }
          }),
        ),
        Effect.mapError(toPersistenceSqlError("ProviderRuntimeEvent.advanceThreadCursor")),
      );
    };

  const advanceThreadCursor: ProviderRuntimeEventRepositoryShape["advanceThreadCursor"] = (input) =>
    sql
      .withTransaction(advanceThreadCursorInCurrentTransaction(input))
      .pipe(
        Effect.mapError(
          toPersistenceSqlError("ProviderRuntimeEvent.advanceThreadCursor.transaction"),
        ),
      );

  const decodeProjectionFailure = (unknownRow: Record<string, unknown>, operation: string) =>
    decodeProjectionFailureRow(unknownRow).pipe(
      Effect.map((row) => row satisfies ProviderRuntimeProjectionFailure),
      Effect.mapError(toPersistenceDecodeError(operation)),
    );

  const recordProjectionFailure: ProviderRuntimeEventRepositoryShape["recordProjectionFailure"] = (
    input,
  ) => {
    const attemptLimit = Math.max(
      1,
      Math.floor(input.attemptLimit ?? PROVIDER_RUNTIME_PROJECTION_FAILURE_ATTEMPT_LIMIT),
    );
    const minBlockedMs = Math.max(
      0,
      Math.floor(input.minBlockedMs ?? PROVIDER_RUNTIME_PROJECTION_FAILURE_MIN_BLOCKED_MS),
    );
    const boundedErrorDetail = input.errorDetail.slice(0, 32_768);
    return sql
      .withTransaction(
        Effect.gen(function* () {
          const eventRows = yield* sql<{
            readonly eventId: string;
            readonly threadId: string;
            readonly turnId: string | null;
            readonly eventType: string;
          }>`
              SELECT
                event_id AS "eventId",
                thread_id AS "threadId",
                turn_id AS "turnId",
                event_type AS "eventType"
              FROM provider_runtime_events
              WHERE sequence = ${input.sequence}
            `;
          const event = eventRows[0];
          if (!event) {
            return yield* new PersistenceDecodeError({
              operation: "ProviderRuntimeEvent.recordProjectionFailure",
              issue: `Provider runtime event sequence ${input.sequence} does not exist.`,
            });
          }

          const existingRows = yield* sql<{
            readonly errorFingerprint: string;
            readonly attemptCount: number;
            readonly firstFailedAt: string;
            readonly status: string;
          }>`
              SELECT
                error_fingerprint AS "errorFingerprint",
                attempt_count AS "attemptCount",
                first_failed_at AS "firstFailedAt",
                status
              FROM provider_runtime_projection_failures
              WHERE sequence = ${input.sequence}
            `;
          const existing = existingRows[0];
          const sameFailure =
            existing?.status !== "resolved" &&
            existing?.errorFingerprint === input.errorFingerprint;
          const attemptCount = sameFailure ? existing.attemptCount + 1 : 1;
          const firstFailedAt = sameFailure ? existing.firstFailedAt : input.failedAt;
          const firstFailedMs = Date.parse(firstFailedAt);
          const failedAtMs = Date.parse(input.failedAt);
          const hasWaitedLongEnough =
            Number.isFinite(firstFailedMs) &&
            Number.isFinite(failedAtMs) &&
            failedAtMs - firstFailedMs >= minBlockedMs;
          const status =
            attemptCount >= attemptLimit && hasWaitedLongEnough ? "quarantined" : "active";
          const quarantinedAt = status === "quarantined" ? input.failedAt : null;
          const backoffExponent = Math.min(8, Math.max(0, attemptCount - 1));
          const retryBaseMs = Math.min(
            PROVIDER_RUNTIME_PROJECTION_RETRY_MAX_MS,
            PROVIDER_RUNTIME_PROJECTION_RETRY_BASE_MS * 2 ** backoffExponent,
          );
          const jitterSeed = Number.parseInt(input.errorFingerprint.slice(0, 8), 16);
          const jitterFactor = Number.isFinite(jitterSeed) ? 0.8 + (jitterSeed % 401) / 1_000 : 1;
          const nextRetryAt = new Date(
            (Number.isFinite(failedAtMs) ? failedAtMs : Date.now()) +
              Math.max(1, Math.round(retryBaseMs * jitterFactor)),
          ).toISOString();

          yield* sql`
              INSERT INTO provider_runtime_projection_failures (
                sequence, event_id, thread_id, turn_id, event_type,
                error_fingerprint, error_detail, attempt_count,
                first_failed_at, last_failed_at, next_retry_at,
                status, quarantined_at, resolved_at
              ) VALUES (
                ${input.sequence}, ${event.eventId}, ${event.threadId}, ${event.turnId},
                ${event.eventType}, ${input.errorFingerprint}, ${boundedErrorDetail},
                ${attemptCount}, ${firstFailedAt}, ${input.failedAt}, ${nextRetryAt}, ${status},
                ${quarantinedAt}, NULL
              )
              ON CONFLICT (sequence) DO UPDATE SET
                error_fingerprint = excluded.error_fingerprint,
                error_detail = excluded.error_detail,
                attempt_count = excluded.attempt_count,
                first_failed_at = excluded.first_failed_at,
                last_failed_at = excluded.last_failed_at,
                next_retry_at = excluded.next_retry_at,
                status = excluded.status,
                quarantined_at = excluded.quarantined_at,
                resolved_at = NULL
            `;

          const rows = yield* sql<Record<string, unknown>>`
              SELECT
                sequence,
                event_id AS "eventId",
                thread_id AS "threadId",
                turn_id AS "turnId",
                event_type AS "eventType",
                error_fingerprint AS "errorFingerprint",
                error_detail AS "errorDetail",
                attempt_count AS "attemptCount",
                first_failed_at AS "firstFailedAt",
                last_failed_at AS "lastFailedAt",
                next_retry_at AS "nextRetryAt",
                status,
                quarantined_at AS "quarantinedAt",
                resolved_at AS "resolvedAt"
              FROM provider_runtime_projection_failures
              WHERE sequence = ${input.sequence}
            `;
          return yield* decodeProjectionFailure(
            rows[0] ?? {},
            "ProviderRuntimeEvent.recordProjectionFailure.row",
          );
        }),
      )
      .pipe(
        Effect.mapError((error) =>
          error instanceof PersistenceDecodeError
            ? error
            : toPersistenceSqlError("ProviderRuntimeEvent.recordProjectionFailure")(error),
        ),
      );
  };

  const listQuarantinedProjectionFailures: ProviderRuntimeEventRepositoryShape["listQuarantinedProjectionFailures"] =
    Effect.gen(function* () {
      const rows = yield* sql<Record<string, unknown>>`
        SELECT
          sequence,
          event_id AS "eventId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          event_type AS "eventType",
          error_fingerprint AS "errorFingerprint",
          error_detail AS "errorDetail",
          attempt_count AS "attemptCount",
          first_failed_at AS "firstFailedAt",
          last_failed_at AS "lastFailedAt",
          next_retry_at AS "nextRetryAt",
          status,
          quarantined_at AS "quarantinedAt",
          resolved_at AS "resolvedAt"
        FROM provider_runtime_projection_failures
        WHERE status = 'quarantined'
        ORDER BY sequence ASC
      `.pipe(
        Effect.mapError(
          toPersistenceSqlError("ProviderRuntimeEvent.listQuarantinedProjectionFailures"),
        ),
      );
      return yield* Effect.forEach(
        rows,
        (row) =>
          decodeProjectionFailure(
            row,
            "ProviderRuntimeEvent.listQuarantinedProjectionFailures.row",
          ),
        { concurrency: 1 },
      );
    });

  const getThreadProjectionFailure: ProviderRuntimeEventRepositoryShape["getThreadProjectionFailure"] =
    (threadId) =>
      Effect.gen(function* () {
        const rows = yield* sql<Record<string, unknown>>`
          SELECT
            sequence,
            event_id AS "eventId",
            thread_id AS "threadId",
            turn_id AS "turnId",
            event_type AS "eventType",
            error_fingerprint AS "errorFingerprint",
            error_detail AS "errorDetail",
            attempt_count AS "attemptCount",
            first_failed_at AS "firstFailedAt",
            last_failed_at AS "lastFailedAt",
            next_retry_at AS "nextRetryAt",
            status,
            quarantined_at AS "quarantinedAt",
            resolved_at AS "resolvedAt"
          FROM provider_runtime_projection_failures
          WHERE thread_id = ${threadId}
            AND status IN ('active', 'quarantined')
          ORDER BY sequence ASC
          LIMIT 1
        `.pipe(
          Effect.mapError(toPersistenceSqlError("ProviderRuntimeEvent.getThreadProjectionFailure")),
        );
        if (!rows[0]) return null;
        return yield* decodeProjectionFailure(
          rows[0],
          "ProviderRuntimeEvent.getThreadProjectionFailure.row",
        );
      });

  const releaseQuarantinedThread: ProviderRuntimeEventRepositoryShape["releaseQuarantinedThread"] =
    (input) =>
      sql<{ readonly sequence: number }>`
        UPDATE provider_runtime_projection_failures
        SET
          status = 'active',
          attempt_count = 1,
          first_failed_at = ${input.releasedAt},
          last_failed_at = ${input.releasedAt},
          next_retry_at = ${input.releasedAt},
          quarantined_at = NULL,
          resolved_at = NULL
        WHERE thread_id = ${input.threadId}
          AND status = 'quarantined'
        RETURNING sequence
      `.pipe(
        Effect.map((rows) => rows.length === 1),
        Effect.mapError(toPersistenceSqlError("ProviderRuntimeEvent.releaseQuarantinedThread")),
      );

  const getConsumerCursor: ProviderRuntimeEventRepositoryShape["getConsumerCursor"] = (
    consumerName,
  ) =>
    sql<{ readonly lastAckedSequence: number }>`
        SELECT last_acked_sequence AS "lastAckedSequence"
        FROM provider_runtime_event_consumers
        WHERE consumer_name = ${consumerName}
      `.pipe(
      Effect.flatMap((rows) =>
        rows[0] === undefined
          ? Effect.fail(
              new PersistenceDecodeError({
                operation: "ProviderRuntimeEvent.getConsumerCursor",
                issue: `Consumer '${consumerName}' is not registered.`,
              }),
            )
          : Effect.succeed(rows[0].lastAckedSequence),
      ),
      Effect.mapError((error) =>
        error instanceof PersistenceDecodeError
          ? error
          : toPersistenceSqlError("ProviderRuntimeEvent.getConsumerCursor")(error),
      ),
    );

  // Highest cursor position whose retention scan has already run. Process-local
  // on purpose: it is a "do not rescan yet" hint, never a durability record. A
  // restart resets it to 0, which makes the next cursor advance scan — the safe
  // direction, since the only effect of losing it is pruning sooner.
  let lastRetentionScanSequence = 0;

  const advanceConsumerCursor: ProviderRuntimeEventRepositoryShape["advanceConsumerCursor"] = (
    input,
  ) => {
    let retentionScanSequence: number | null = null;
    return sql
      .withTransaction(
        Effect.gen(function* () {
          const consumerRows = yield* sql<{ readonly lastAckedSequence: number }>`
            SELECT last_acked_sequence AS "lastAckedSequence"
            FROM provider_runtime_event_consumers
            WHERE consumer_name = ${input.consumerName}
          `;
          const cursor = consumerRows[0]?.lastAckedSequence;
          if (cursor === undefined) return false;
          if (cursor >= input.eventSequence) return true;

          // Event ids are idempotent and SQLite may leave sequence gaps after a
          // conflicting insert. Contiguity therefore means the exact next
          // stored row, not arithmetic sequence + 1.
          const nextRows = yield* sql<{ readonly sequence: number | null }>`
            SELECT MIN(sequence) AS sequence
            FROM provider_runtime_events
            WHERE sequence > ${cursor}
          `;
          if (nextRows[0]?.sequence !== input.eventSequence) return false;

          const eventRows = yield* sql<{
            readonly eventType: string;
            readonly threadId: string;
            readonly turnId: string | null;
          }>`
            SELECT event_type AS "eventType", thread_id AS "threadId", turn_id AS "turnId"
            FROM provider_runtime_events
            WHERE sequence = ${input.eventSequence}
          `;
          const event = eventRows[0];
          if (!event) return false;

          const advanced = yield* sql<{ readonly sequence: number }>`
            UPDATE provider_runtime_event_consumers
            SET last_acked_sequence = ${input.eventSequence}, updated_at = ${input.updatedAt}
            WHERE consumer_name = ${input.consumerName}
              AND last_acked_sequence = ${cursor}
            RETURNING last_acked_sequence AS sequence
          `;
          if (advanced.length !== 1) return false;

          const isTerminalTurnEvent =
            event.eventType === "turn.completed" || event.eventType === "turn.aborted";
          const isThreadTerminalEvent =
            event.eventType === "session.exited" || event.eventType === "runtime.error";
          if (event.turnId !== null && !isTerminalTurnEvent && !isThreadTerminalEvent) {
            yield* sql`
              INSERT INTO provider_runtime_open_turns (
                thread_id, turn_id, first_sequence, updated_at
              ) VALUES (
                ${event.threadId}, ${event.turnId}, ${input.eventSequence}, ${input.updatedAt}
              )
              ON CONFLICT (thread_id, turn_id) DO UPDATE SET
                first_sequence = MIN(
                  provider_runtime_open_turns.first_sequence,
                  excluded.first_sequence
                ),
                updated_at = excluded.updated_at
            `;
          } else if (event.turnId !== null) {
            yield* sql`
              DELETE FROM provider_runtime_open_turns
              WHERE thread_id = ${event.threadId} AND turn_id = ${event.turnId}
            `;
          } else if (isThreadTerminalEvent) {
            yield* sql`
              DELETE FROM provider_runtime_open_turns
              WHERE thread_id = ${event.threadId}
            `;
          } else if (isTerminalTurnEvent) {
            yield* sql`
              DELETE FROM provider_runtime_open_turns
              WHERE thread_id = ${event.threadId}
                AND 1 = (
                  SELECT COUNT(*) FROM provider_runtime_open_turns
                  WHERE thread_id = ${event.threadId}
                )
            `;
          }

          // Nothing below the cursor can become deletable while a turn only
          // grows, so the scan is worth running when a turn just settled (its
          // whole backlog is releasable now) or when enough events have piled up
          // since the last scan. See the interval constant for why this is safe.
          const settlesOpenTurns = isTerminalTurnEvent || isThreadTerminalEvent;
          if (
            !settlesOpenTurns &&
            input.eventSequence - lastRetentionScanSequence <
              PROVIDER_RUNTIME_EVENT_RETENTION_SCAN_INTERVAL
          ) {
            return true;
          }
          retentionScanSequence = input.eventSequence;

          // Pending rows are above the cursor. Accepted rows for an open turn
          // remain replayable until its terminal output is accepted; all other
          // accepted history is bounded to a diagnostic tail.
          yield* sql`
            DELETE FROM provider_runtime_events AS event
            WHERE event.sequence <= ${input.eventSequence}
              AND NOT EXISTS (
                SELECT 1
                FROM provider_runtime_open_turns AS open_turn
                WHERE open_turn.thread_id = event.thread_id
                  AND open_turn.turn_id = event.turn_id
                  AND event.sequence >= open_turn.first_sequence
              )
              AND event.sequence NOT IN (
                SELECT sequence
                FROM provider_runtime_events
                WHERE sequence <= ${input.eventSequence}
                ORDER BY sequence DESC
                LIMIT ${PROVIDER_RUNTIME_EVENT_RETAIN_ACCEPTED}
              )
          `;
          return true;
        }),
      )
      .pipe(
        // Only a committed scan may move the hint forward; a rolled back
        // transaction leaves it where it was so the next advance rescans.
        Effect.tap(() =>
          Effect.sync(() => {
            if (retentionScanSequence !== null) {
              lastRetentionScanSequence = Math.max(
                lastRetentionScanSequence,
                retentionScanSequence,
              );
            }
          }),
        ),
        Effect.mapError(toPersistenceSqlError("ProviderRuntimeEvent.advanceConsumerCursor")),
      );
  };

  return {
    append,
    getHighWaterSequence,
    readAfter,
    readPendingThreadHeads,
    readPendingThreadEvents,
    getThreadCoverage,
    readThreadEvents,
    readAcceptedOpenTurnEvents,
    pruneSettledOpenTurns,
    getThreadCursor,
    advanceThreadCursor,
    advanceThreadCursorInCurrentTransaction,
    recordProjectionFailure,
    listQuarantinedProjectionFailures,
    getThreadProjectionFailure,
    releaseQuarantinedThread,
    getConsumerCursor,
    advanceConsumerCursor,
  } satisfies ProviderRuntimeEventRepositoryShape;
});

export const ProviderRuntimeEventRepositoryLive = Layer.effect(
  ProviderRuntimeEventRepository,
  make,
);
