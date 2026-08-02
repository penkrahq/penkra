// Purpose: Durable SQLite storage for the left-rail Space navigation cursor.

import {
  ContainerId,
  SpaceId,
  ThreadId,
  type ServerSpaceNavigationState,
  type ServerUpdateSpaceNavigationStateInput,
} from "@penkra/contracts";
import { Effect } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

interface SpaceNavigationRow {
  readonly active_space_id: string | null;
  readonly last_thread_id_by_space_json: string;
  readonly last_project_id_by_space_json: string;
  readonly updated_at: string;
}

function parseIdRecord<T extends string>(
  json: string,
  make: (value: string) => T,
): Record<string, T> {
  try {
    const value = JSON.parse(json) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value)
        .filter((entry): entry is [string, string] => typeof entry[1] === "string")
        .map(([key, id]) => [key, make(id)]),
    );
  } catch {
    return {};
  }
}

export function getSpaceNavigationState(sql: SqlClient.SqlClient) {
  return Effect.gen(function* () {
    const rows = yield* sql<SpaceNavigationRow>`
      SELECT
        active_space_id,
        last_thread_id_by_space_json,
        last_project_id_by_space_json,
        updated_at
      FROM space_navigation_state
      WHERE singleton_id = 1
    `;
    const row = rows[0];
    if (!row) {
      return {
        activeSpaceId: null,
        lastThreadIdBySpace: {},
        lastProjectIdBySpace: {},
        updatedAt: null,
      } satisfies ServerSpaceNavigationState;
    }
    return {
      activeSpaceId: row.active_space_id ? SpaceId.makeUnsafe(row.active_space_id) : null,
      lastThreadIdBySpace: parseIdRecord(row.last_thread_id_by_space_json, ThreadId.makeUnsafe),
      lastProjectIdBySpace: parseIdRecord(
        row.last_project_id_by_space_json,
        ContainerId.makeUnsafe,
      ),
      updatedAt: row.updated_at,
    } satisfies ServerSpaceNavigationState;
  });
}

export function updateSpaceNavigationState(
  sql: SqlClient.SqlClient,
  input: ServerUpdateSpaceNavigationStateInput,
) {
  return Effect.gen(function* () {
    const updatedAt = new Date().toISOString();
    yield* sql`
      INSERT INTO space_navigation_state (
        singleton_id,
        active_space_id,
        last_thread_id_by_space_json,
        last_project_id_by_space_json,
        updated_at
      ) VALUES (
        1,
        ${input.activeSpaceId},
        ${JSON.stringify(input.lastThreadIdBySpace)},
        ${JSON.stringify(input.lastProjectIdBySpace)},
        ${updatedAt}
      )
      ON CONFLICT (singleton_id) DO UPDATE SET
        active_space_id = excluded.active_space_id,
        last_thread_id_by_space_json = excluded.last_thread_id_by_space_json,
        last_project_id_by_space_json = excluded.last_project_id_by_space_json,
        updated_at = excluded.updated_at
    `;
    return yield* getSpaceNavigationState(sql);
  });
}
