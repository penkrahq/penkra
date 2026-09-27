// FILE: userStopPending.ts
// Purpose: Recognize a durable user Stop until another turn is admitted.

import type { ThreadId } from "@penkra/contracts";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { toPersistenceSqlError } from "../persistence/Errors.ts";

/** A queued steer also requests an interrupt; its command has a queued event. */
export const userStopPending = (threadId: ThreadId, sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    const rows = yield* sql<{ readonly eventType: string }>`
      SELECT event.event_type AS "eventType"
      FROM orchestration_events AS event
      WHERE event.aggregate_kind = 'thread'
        AND event.stream_id = ${threadId}
        AND event.event_type IN ('thread.turn-start-requested', 'thread.turn-interrupt-requested')
        AND (
          event.event_type <> 'thread.turn-interrupt-requested'
          OR json_extract(event.metadata_json, '$.userStopRequested') = 1
        )
      ORDER BY event.sequence DESC
      LIMIT 1
    `.pipe(Effect.mapError(toPersistenceSqlError("userStopPending")));
    return rows[0]?.eventType === "thread.turn-interrupt-requested";
  });
