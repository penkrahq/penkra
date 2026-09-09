import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { AgentGatewayCreationAdmissionRepository } from "../Services/AgentGatewayCreationAdmissions.ts";
import { AgentGatewayCreationAdmissionRepositoryLive } from "./AgentGatewayCreationAdmissions.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  Layer.mergeAll(
    AgentGatewayCreationAdmissionRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
    SqlitePersistenceMemory,
  ),
);

const admission = (fingerprint: string, result: string) => ({
  operationId: "gateway:create:concurrent",
  callerThreadId: "caller",
  callerTurnId: "turn",
  requestId: "request",
  requestFingerprintVersion: 1,
  requestFingerprint: fingerprint,
  planSchemaVersion: 1,
  threadCreateCommandJson: '{"type":"thread.create"}',
  turnStartCommandJson: '{"type":"thread.turn.start"}',
  recapCommandJson: '{"type":"thread.activity.append"}',
  cwd: "/first",
  resultJson: result,
  admittedAt: "2026-09-07T05:00:00.000Z",
});

layer("AgentGatewayCreationAdmissionRepository", (it) => {
  it.effect("atomically retains one immutable winner under concurrent insertion", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const repository = yield* AgentGatewayCreationAdmissionRepository;
      yield* sql`DELETE FROM agent_gateway_creation_admissions`;
      const [left, right] = yield* Effect.all(
        [
          repository.reserve(admission("a".repeat(64), '{"winner":"left"}')),
          repository.reserve(admission("b".repeat(64), '{"winner":"right"}')),
        ],
        { concurrency: "unbounded" },
      );
      assert.deepEqual([left.kind, right.kind].toSorted(), ["existing", "reserved"]);
      const stored = Option.getOrThrow(yield* repository.get("gateway:create:concurrent"));
      assert.isTrue(
        stored.resultJson === '{"winner":"left"}' || stored.resultJson === '{"winner":"right"}',
      );
      const loser = stored.resultJson.includes("left") ? right.admission : left.admission;
      assert.strictEqual(loser.resultJson, stored.resultJson);
      assert.strictEqual(loser.requestFingerprint, stored.requestFingerprint);
    }),
  );

  it.effect("reconstructs the exact plan from SQLite without mutable process state", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const repository = yield* AgentGatewayCreationAdmissionRepository;
      yield* sql`DELETE FROM agent_gateway_creation_admissions`;
      const original = admission("c".repeat(64), '{"threadId":"durable"}');
      yield* repository.reserve(original);
      const reconstructed = Option.getOrThrow(yield* repository.get(original.operationId));
      assert.deepEqual(reconstructed, original);
    }),
  );
});
