// Remove only 0.14.4's extra reasoning rows; retained conversation text is untouched.
import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // TODO.md's observed first 0.14.4 reasoning write, not a rolling retention rule.
  const installedAt = "2026-10-13T12:14:00.000Z";
  for (const provider of ["codex", "claudeAgent", "opencode"]) {
    const predicate = sql`kind='reasoning' AND created_at>=${installedAt}
      AND thread_id IN (SELECT id FROM threads WHERE provider=${provider})
      AND (${provider}<>'codex' OR text IS NULL OR trim(text)='' OR text='Reasoning')`;
    const [row] = yield* sql<{
      count: number;
    }>`SELECT count(*) AS count FROM thread_items WHERE ${predicate}`;
    yield* sql`DELETE FROM thread_items WHERE ${predicate}`;
    yield* Effect.logInfo("Restored 0.14.3 reasoning display", {
      provider,
      removed: row!.count,
      installedAt,
    });
  }
});
