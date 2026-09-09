import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS agent_gateway_creation_admissions (
      operation_id TEXT PRIMARY KEY,
      caller_thread_id TEXT NOT NULL,
      caller_turn_id TEXT NOT NULL,
      request_id TEXT NOT NULL,
      request_fingerprint_version INTEGER NOT NULL CHECK (request_fingerprint_version > 0),
      request_fingerprint TEXT NOT NULL CHECK (
        length(request_fingerprint) = 64 AND request_fingerprint NOT GLOB '*[^0-9a-f]*'
      ),
      plan_schema_version INTEGER NOT NULL CHECK (plan_schema_version > 0),
      thread_create_command_json TEXT NOT NULL CHECK (json_valid(thread_create_command_json)),
      turn_start_command_json TEXT NOT NULL CHECK (json_valid(turn_start_command_json)),
      recap_command_json TEXT NOT NULL CHECK (json_valid(recap_command_json)),
      cwd TEXT NOT NULL,
      result_json TEXT NOT NULL CHECK (json_valid(result_json)),
      admitted_at TEXT NOT NULL,
      UNIQUE (caller_thread_id, caller_turn_id, request_id)
    )
  `;
});
