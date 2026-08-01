// FILE: 080_PruneRejectedSynaraSurfaces.ts
// Purpose: Removes Penkra Automation and External MCP persistence from Penkra.
// Layer: SQLite migration

import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`DROP TABLE IF EXISTS external_mcp_audit_log`;
  yield* sql`DROP TABLE IF EXISTS external_mcp_rate_windows`;
  yield* sql`DROP TABLE IF EXISTS external_mcp_tasks`;
  yield* sql`DROP TABLE IF EXISTS external_mcp_operations`;
  yield* sql`DROP TABLE IF EXISTS external_mcp_pairing_codes`;
  yield* sql`DROP TABLE IF EXISTS external_mcp_integration_projects`;
  yield* sql`DROP TABLE IF EXISTS external_mcp_integrations`;

  yield* sql`DROP VIEW IF EXISTS automation_pending_completion_evaluations`;
  yield* sql`DROP TABLE IF EXISTS automation_memory`;
  yield* sql`DROP TABLE IF EXISTS automation_runs`;
  yield* sql`DROP TABLE IF EXISTS automation_scheduler_leases`;
  yield* sql`DROP TABLE IF EXISTS automation_settings`;
  yield* sql`DROP TABLE IF EXISTS automation_definitions`;
});
