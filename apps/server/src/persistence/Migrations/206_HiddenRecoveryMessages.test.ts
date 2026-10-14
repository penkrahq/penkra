import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import migrate from "./206_HiddenRecoveryMessages.ts";
import { PLAY_TURN_RECOVERY_PROMPT } from "../../cleanCore/sendMessage.ts";

it.effect("retags only exact user recovery prompts and repairs visible rollups", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE threads(id TEXT PRIMARY KEY,last_message_preview TEXT,last_user_message_at TEXT)`;
    yield* sql`CREATE TABLE thread_items(thread_id TEXT,seq INTEGER,kind TEXT,text TEXT,data TEXT,created_at TEXT)`;
    yield* sql`INSERT INTO threads VALUES ('thread',${PLAY_TURN_RECOVERY_PROMPT},'3')`;
    for (const [seq, text, origin] of [
      [1, "Operator text", "user"],
      [2, PLAY_TURN_RECOVERY_PROMPT + " ", "user"],
      [3, PLAY_TURN_RECOVERY_PROMPT, "user"],
      [4, PLAY_TURN_RECOVERY_PROMPT, "agent"],
    ] as const) {
      yield* sql`INSERT INTO thread_items VALUES ('thread',${seq},'user',${text},${JSON.stringify({ origin: { _tag: origin }, attachments: [] })},${String(seq)})`;
    }
    yield* sql`INSERT INTO threads VALUES ('only-recovery',${PLAY_TURN_RECOVERY_PROMPT},'1')`;
    yield* sql`INSERT INTO thread_items VALUES ('only-recovery',1,'user',${PLAY_TURN_RECOVERY_PROMPT},${JSON.stringify({ origin: { _tag: "user" }, attachments: [] })},'1')`;
    yield* migrate;
    assert.deepStrictEqual(
      yield* sql`SELECT seq,json_extract(data,'$.origin._tag') AS origin FROM thread_items WHERE thread_id='thread' ORDER BY seq`,
      [
        { seq: 1, origin: "user" },
        { seq: 2, origin: "user" },
        { seq: 3, origin: "recovery" },
        { seq: 4, origin: "agent" },
      ],
    );
    assert.deepStrictEqual(yield* sql`SELECT * FROM threads WHERE id='thread'`, [
      { id: "thread", last_message_preview: PLAY_TURN_RECOVERY_PROMPT, last_user_message_at: "4" },
    ]);
    assert.deepStrictEqual(
      yield* sql`SELECT last_message_preview,last_user_message_at FROM threads WHERE id='only-recovery'`,
      [{ last_message_preview: null, last_user_message_at: null }],
    );
    assert.equal((yield* sql`SELECT count(*) AS count FROM thread_items`)[0]!.count, 5);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
