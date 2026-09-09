import { it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { expect } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { ProviderRuntimeEventRepository } from "../Services/ProviderRuntimeEvents.ts";
import { ProviderRuntimeEventRepositoryLive } from "./ProviderRuntimeEvents.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

// Characterization only: actual migrations/repository, fresh in-memory data, no product replacement.
const reportPath = new URL(
  "../../../../../.penkra/scratch/performance-20260908/journal-control.json",
  import.meta.url,
);
const source = readFileSync(new URL("./ProviderRuntimeEvents.ts", import.meta.url), "utf8");
const section = source.slice(source.indexOf("const readPendingThreadEvents:"));
const query = section
  .slice(section.indexOf("WITH eligible AS ("), section.indexOf("`.pipe("))
  .replace(/\$\{[^}]+\}/g, "?");
const stamp = "2026-09-09T00:00:00.000Z";
const event = {
  type: "content.delta",
  eventId: "audit",
  provider: "codex",
  createdAt: stamp,
  threadId: "audit-0",
  turnId: "audit-turn",
  payload: { streamKind: "assistant_text", delta: "x" },
};
const layer = it.layer(
  ProviderRuntimeEventRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);
layer("journal measured access-path controls", (it) => {
  it.effect(
    "records retained-history scaling and checks multi-thread indexed-seek equivalence",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient,
          repository = yield* ProviderRuntimeEventRepository;
        const rows: any[] = [];
        const clear = Effect.gen(function* () {
          yield* sql`DELETE FROM provider_runtime_projection_failures`;
          yield* sql`DELETE FROM provider_runtime_thread_cursors`;
          yield* sql`DELETE FROM provider_runtime_events`;
        });
        const insert = (
          n: number,
          threads: number,
        ) => sql`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<${n})
   INSERT INTO provider_runtime_events(sequence,event_id,thread_id,turn_id,event_type,event_json,persisted_at)
   SELECT x,'audit-'||x,'audit-'||CAST(x%${threads} AS INTEGER),'audit-turn','content.delta',
    json_set(${JSON.stringify(event)},'$.eventId','audit-'||x,'$.threadId','audit-'||CAST(x%${threads} AS INTEGER)),${stamp} FROM n`;
        for (const count of [512, 8000, 32000]) {
          yield* clear;
          yield* insert(count, 1);
          yield* sql`INSERT INTO provider_runtime_thread_cursors VALUES ('audit-0',${count},${stamp},${stamp})`;
          const plans = yield* sql.unsafe("EXPLAIN QUERY PLAN " + query, [count, stamp, 32, 128]);
          for (const pending of [0, 1]) {
            yield* sql`UPDATE provider_runtime_thread_cursors SET last_acked_sequence=${count - pending}`;
            const begin = performance.now();
            for (let i = 0; i < 20; i++)
              expect((yield* sql.unsafe(query, [count, stamp, 32, 128])).length).toBe(pending);
            const originalMs = (performance.now() - begin) / 20,
              startSeek = performance.now();
            for (let i = 0; i < 20; i++)
              expect(
                (yield* sql`SELECT sequence,event_json FROM provider_runtime_events WHERE thread_id='audit-0' AND sequence>${count - pending} AND sequence<=${count} ORDER BY sequence LIMIT 32`)
                  .length,
              ).toBe(pending);
            rows.push({
              count,
              pending,
              repeats: 20,
              originalMs,
              seekMs: (performance.now() - startSeek) / 20,
              plans,
            });
          }
        }
        yield* clear;
        yield* insert(480, 12);
        let seed = 918273;
        const random = () => {
          seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
          return seed / 4294967296;
        };
        const seek = (fence: number, limit: number, max: number) =>
          Effect.gen(function* () {
            // Still scans retained Thread keys: equivalence experiment, not the final scalable design.
            const threads = yield* sql<{
              thread_id: string;
            }>`SELECT DISTINCT thread_id FROM provider_runtime_events`;
            const all: any[] = [];
            for (const { thread_id } of threads) {
              const blocked =
                yield* sql`SELECT 1 FROM provider_runtime_projection_failures WHERE thread_id=${thread_id} AND (status='quarantined' OR (status='active' AND next_retry_at>${stamp}))`;
              if (blocked.length) continue;
              const cursor = yield* repository.getThreadCursor(thread_id);
              all.push(
                ...(yield* sql`SELECT sequence,event_json AS eventJson FROM provider_runtime_events WHERE thread_id=${thread_id} AND sequence>${cursor} AND sequence<=${fence} ORDER BY sequence LIMIT ${Math.min(limit, max)}`),
              );
            }
            return all.sort((a, b) => a.sequence - b.sequence).slice(0, limit);
          });
        for (let test = 0; test < 80; test++) {
          yield* sql`DELETE FROM provider_runtime_projection_failures`;
          yield* sql`DELETE FROM provider_runtime_thread_cursors`;
          for (let thread = 0; thread < 12; thread++) {
            const id = "audit-" + thread;
            if (random() > 0.2)
              yield* sql`INSERT INTO provider_runtime_thread_cursors VALUES (${id},${Math.floor(random() * 481)},${stamp},${stamp})`;
            const state = Math.floor(random() * 5);
            if (state < 4) {
              const sequence = thread || 12,
                status = ["quarantined", "active", "active", "resolved"][state]!,
                retry = state === 1 ? "2099-01-01T00:00:00.000Z" : "2000-01-01T00:00:00.000Z";
              yield* sql`INSERT INTO provider_runtime_projection_failures(sequence,event_id,thread_id,turn_id,event_type,error_fingerprint,error_detail,attempt_count,first_failed_at,last_failed_at,next_retry_at,status) VALUES (${sequence},${"audit-" + sequence},${id},'audit-turn','content.delta','audit','fixture',1,${stamp},${stamp},${retry},${status})`;
            }
          }
          const fence = 1 + Math.floor(random() * 480),
            limit = 1 + Math.floor(random() * 128),
            max = 1 + Math.floor(random() * 32);
          const existing = yield* repository.readPendingThreadEvents({
            throughSequenceInclusive: fence,
            limit,
            maxPerThread: max,
          });
          const control = yield* seek(fence, limit, max);
          expect(control.map((r) => r.sequence)).toEqual(existing.map((r) => r.sequence));
        }
        yield* sql`DELETE FROM provider_runtime_projection_failures`;
        yield* sql`DELETE FROM provider_runtime_thread_cursors`;
        const seen = new Set<number>();
        let pages = 0;
        while (true) {
          const page = yield* seek(480, 128, 32);
          if (!page.length) break;
          pages++;
          for (const row of page) {
            expect(seen.has(row.sequence)).toBe(false);
            seen.add(row.sequence);
            expect(
              yield* repository.advanceThreadCursor({
                threadId: JSON.parse(row.eventJson).threadId,
                eventSequence: row.sequence,
                updatedAt: stamp,
              }),
            ).toBe(true);
          }
        }
        expect(seen.size).toBe(480);
        const admitted = yield* repository.append({
          ...event,
          eventId: "audit-new-thread",
          threadId: "audit-new-thread",
        } as never);
        expect(yield* seek(480, 128, 32)).toHaveLength(0);
        const admittedPage = yield* seek(admitted.sequence, 128, 32);
        expect(admittedPage.map((row) => row.sequence)).toEqual([admitted.sequence]);
        expect(
          yield* repository.advanceThreadCursor({
            threadId: "audit-new-thread",
            eventSequence: admitted.sequence,
            updatedAt: stamp,
          }),
        ).toBe(true);
        expect(yield* seek(admitted.sequence, 128, 32)).toHaveLength(0);
        mkdirSync(new URL("./", reportPath), { recursive: true });
        writeFileSync(
          reportPath,
          JSON.stringify(
            {
              utc: new Date().toISOString(),
              sqlite: process.versions.sqlite,
              query,
              rows,
              seed: 918273,
              differentialCases: 80,
              drained: seen.size,
              pages,
              newThreadAdmission: {
                sequence: admitted.sequence,
                oldFenceExcluded: true,
                newFenceIncluded: true,
                accepted: true,
                subsequentStatelessReadEmpty: true,
              },
              limitations:
                "Thread discovery scans retained keys; no process-crash or production savings assertion",
            },
            null,
            2,
          ),
        );
      }),
  );
});
