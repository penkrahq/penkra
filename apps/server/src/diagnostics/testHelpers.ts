import { expect } from "vitest";

import type { IncidentCode } from "./codes";
import { openDiagnosticsReader } from "./store";

/** Assert occurrence rows, so a repeat cannot hide behind one aggregate row. */
export function expectIncidentOccurrences(stateDir: string, code: IncidentCode, count = 1): void {
  const database = openDiagnosticsReader(stateDir);
  expect(database, "diagnostics database should exist").not.toBeNull();
  try {
    const row = database!
      .prepare(
        `SELECT COUNT(*) AS count FROM incident_occurrences occurrence
         JOIN incidents incident ON incident.id = occurrence.incident_id
         WHERE incident.code = ?`,
      )
      .get(code) as { count: number };
    expect(row.count, `incident occurrences for ${code}`).toBe(count);
  } finally {
    database?.close();
  }
}
