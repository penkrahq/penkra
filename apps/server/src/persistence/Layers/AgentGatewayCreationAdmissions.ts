import { Effect, Layer, Option, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlOrDecodeError } from "../Errors.ts";
import {
  AgentGatewayCreationAdmission,
  AgentGatewayCreationAdmissionRepository,
  type AgentGatewayCreationAdmissionRepositoryShape,
} from "../Services/AgentGatewayCreationAdmissions.ts";

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const select = SqlSchema.findOneOption({
    Request: Schema.Struct({ operationId: Schema.String }),
    Result: AgentGatewayCreationAdmission,
    execute: ({ operationId }) => sql`
      SELECT operation_id AS "operationId", caller_thread_id AS "callerThreadId",
        caller_turn_id AS "callerTurnId", request_id AS "requestId",
        request_fingerprint_version AS "requestFingerprintVersion",
        request_fingerprint AS "requestFingerprint", plan_schema_version AS "planSchemaVersion",
        thread_create_command_json AS "threadCreateCommandJson",
        turn_start_command_json AS "turnStartCommandJson", recap_command_json AS "recapCommandJson",
        cwd, result_json AS "resultJson", admitted_at AS "admittedAt"
      FROM agent_gateway_creation_admissions WHERE operation_id = ${operationId}
    `,
  });
  const map = <A>(operation: string, effect: Effect.Effect<A, unknown>) =>
    effect.pipe(
      Effect.mapError(toPersistenceSqlOrDecodeError(`${operation}:query`, `${operation}:decode`)),
    );

  const get: AgentGatewayCreationAdmissionRepositoryShape["get"] = (operationId) =>
    map("AgentGatewayCreationAdmissionRepository.get", select({ operationId }));

  const reserve: AgentGatewayCreationAdmissionRepositoryShape["reserve"] = (admission) =>
    map(
      "AgentGatewayCreationAdmissionRepository.reserve",
      sql.withTransaction(
        Effect.gen(function* () {
          const inserted = yield* sql<{ readonly operationId: string }>`
            INSERT INTO agent_gateway_creation_admissions (
              operation_id, caller_thread_id, caller_turn_id, request_id,
              request_fingerprint_version, request_fingerprint, plan_schema_version,
              thread_create_command_json, turn_start_command_json, recap_command_json,
              cwd, result_json, admitted_at
            ) VALUES (
              ${admission.operationId}, ${admission.callerThreadId}, ${admission.callerTurnId},
              ${admission.requestId}, ${admission.requestFingerprintVersion},
              ${admission.requestFingerprint}, ${admission.planSchemaVersion},
              ${admission.threadCreateCommandJson}, ${admission.turnStartCommandJson},
              ${admission.recapCommandJson}, ${admission.cwd}, ${admission.resultJson},
              ${admission.admittedAt}
            ) ON CONFLICT DO NOTHING RETURNING operation_id AS "operationId"
          `;
          const stored = yield* select({ operationId: admission.operationId });
          if (Option.isNone(stored)) {
            return yield* Effect.die(
              "Reserved creation admission was not readable by operation id.",
            );
          }
          return {
            kind: inserted.length > 0 ? "reserved" : "existing",
            admission: stored.value,
          } as const;
        }),
      ),
    );

  return { reserve, get } satisfies AgentGatewayCreationAdmissionRepositoryShape;
});

export const AgentGatewayCreationAdmissionRepositoryLive = Layer.effect(
  AgentGatewayCreationAdmissionRepository,
  make,
);
