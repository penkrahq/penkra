// Offline rehearsal evidence: compare meaning, not merely the number of rows.
import { createHash } from "node:crypto";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => [key, stable(value)]),
    );
  return value;
}
type Row = {
  threadId: string;
  sourceId: string;
  role: string;
  text: string | null;
  createdAt: string;
  data: string | null;
  legacySender: string | null;
};
export const captureConversationFidelity = (source: "clean-core" | "projections") =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const legacy =
      (yield* sql`SELECT 1 FROM sqlite_master WHERE type='table' AND name='projection_thread_messages'`)
        .length > 0;
    const signatures = new Map<string, string>();
    const counts = {
      messages: 0,
      agents: 0,
      knownSenders: 0,
      unknownSenders: 0,
      attachments: 0,
      skills: 0,
      mentions: 0,
      steered: 0,
    };
    let afterThread = "",
      afterMessage = "";
    while (true) {
      const rows =
        source === "clean-core"
          ? yield* sql<Row>`SELECT i.thread_id AS "threadId",i.source_id AS "sourceId",i.kind AS role,
          i.text,i.created_at AS "createdAt",i.data,
          ${legacy ? sql`(SELECT m.sender_thread_id FROM projection_thread_messages m WHERE m.thread_id=i.thread_id AND m.message_id=i.source_id)` : sql`NULL`} AS "legacySender"
          FROM thread_items i WHERE i.kind IN ('user','text') AND (i.thread_id,i.source_id)>(${afterThread},${afterMessage})
          ORDER BY i.thread_id,i.source_id LIMIT 50`
          : yield* sql<Row>`SELECT thread_id AS "threadId",message_id AS "sourceId",role,text,created_at AS "createdAt",
          json_object('attachments',json(COALESCE(attachments_json,'null')),'skills',json(COALESCE(skills_json,'null')),
            'mentions',json(COALESCE(mentions_json,'null')),'dispatchOrigin',dispatch_origin,'dispatchMode',dispatch_mode) AS data,
          sender_thread_id AS "legacySender" FROM projection_thread_messages WHERE role IN ('user','assistant')
          AND (thread_id,message_id)>(${afterThread},${afterMessage}) ORDER BY thread_id,message_id LIMIT 50`;
      for (const row of rows) {
        const data = row.role === "user" ? JSON.parse(row.data ?? "{}") : {};
        if (data.truncated === true)
          throw new Error(
            `Rehearsal cannot verify truncated user metadata: ${row.threadId}/${row.sourceId}`,
          );
        const sender =
          data.origin?.senderThreadId ?? data.senderThreadId ?? row.legacySender ?? null;
        const agent =
          data.origin?._tag === "agent" || data.dispatchOrigin === "agent" || sender !== null;
        const metadata =
          row.role === "user"
            ? {
                agent,
                sender,
                attachments: data.attachments ?? [],
                skills: data.skills ?? [],
                mentions: data.mentions ?? [],
                steered: data.steered === true || data.dispatchMode === "steer",
              }
            : null;
        const key = JSON.stringify([row.threadId, row.sourceId]);
        signatures.set(
          key,
          createHash("sha256")
            .update(
              JSON.stringify(
                stable({
                  role: row.role === "user" ? "user" : "assistant",
                  text: row.text,
                  createdAt: row.createdAt,
                  metadata,
                }),
              ),
            )
            .digest("hex"),
        );
        counts.messages++;
        if (metadata) {
          if (agent) {
            counts.agents++;
            if (sender === null) counts.unknownSenders++;
            else counts.knownSenders++;
          }
          counts.attachments += metadata.attachments.length;
          counts.skills += metadata.skills.length;
          counts.mentions += metadata.mentions.length;
          if (metadata.steered) counts.steered++;
        }
      }
      if (rows.length < 50) break;
      afterThread = rows[rows.length - 1]!.threadId;
      afterMessage = rows[rows.length - 1]!.sourceId;
    }
    return { signatures, counts };
  });
