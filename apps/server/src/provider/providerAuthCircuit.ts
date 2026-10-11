import type { ProviderConnectionId, ProviderKind, ThreadId } from "@penkra/contracts";
import { Effect, Layer, ServiceMap } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import type { ProviderAuthFailure } from "./providerAuthFailure.ts";

export interface ProviderAuthCircuit extends ProviderAuthFailure {
  readonly connectionId: ProviderConnectionId;
  readonly harness: ProviderKind;
  readonly openedAt: string;
  readonly failureCount: number;
  readonly profileRef: string | null;
  readonly credentialRef: string | null;
}

function makeCircuits(sql: SqlClient.SqlClient) {
  const circuits = new Map<ProviderConnectionId, ProviderAuthCircuit>();
  const readConnection = (connectionId: ProviderConnectionId) =>
    sql<{
      readonly harness: ProviderKind;
      readonly profileRef: string | null;
      readonly credentialRef: string | null;
    }>`
      SELECT harness_kind AS harness, profile_ref AS "profileRef", credential_ref AS "credentialRef"
      FROM provider_connections WHERE connection_id = ${connectionId} AND lifecycle = 'active'
    `;
  return {
    connectionForThread: (threadId: ThreadId) =>
      sql<{
        readonly connectionId: ProviderConnectionId;
        readonly authenticationMethodId: string;
        readonly harness: ProviderKind;
      }>`
        SELECT thread.connection_id AS "connectionId",
               connection.authentication_method_id AS "authenticationMethodId",
               connection.harness_kind AS harness
        FROM threads AS thread
        JOIN provider_connections AS connection ON connection.connection_id = thread.connection_id
        WHERE thread.id = ${threadId} AND connection.lifecycle = 'active'
      `,
    get: (connectionId: ProviderConnectionId) =>
      Effect.gen(function* () {
        if (!circuits.has(connectionId)) return [];
        const connection = (yield* readConnection(connectionId))[0];
        const circuit = circuits.get(connectionId);
        if (!circuit) return [];
        if (
          !connection ||
          connection.profileRef !== circuit.profileRef ||
          connection.credentialRef !== circuit.credentialRef
        ) {
          circuits.delete(connectionId);
          return [];
        }
        return [circuit];
      }),
    open: (input: {
      readonly connectionId: ProviderConnectionId;
      readonly failure: ProviderAuthFailure;
      readonly now: string;
    }) =>
      Effect.gen(function* () {
        const connection = (yield* readConnection(input.connectionId))[0];
        if (!connection) return yield* Effect.fail(new Error("The Connection is not active."));
        const current = circuits.get(input.connectionId);
        if (
          current &&
          current.profileRef === connection.profileRef &&
          current.credentialRef === connection.credentialRef
        )
          return;
        circuits.set(input.connectionId, {
          ...input.failure,
          ...connection,
          connectionId: input.connectionId,
          openedAt: input.now,
          failureCount: 1,
        });
      }),
    recordFailedProbe: (connectionId: ProviderConnectionId) =>
      Effect.sync(() => {
        const circuit = circuits.get(connectionId);
        if (circuit)
          circuits.set(connectionId, { ...circuit, failureCount: circuit.failureCount + 1 });
      }),
    close: (connectionId: ProviderConnectionId) =>
      Effect.sync(() => {
        circuits.delete(connectionId);
      }),
  };
}

/** One ephemeral auth block per Connection, shared by ingestion, dispatch and sign-in. */
export class ProviderAuthCircuits extends ServiceMap.Service<
  ProviderAuthCircuits,
  ReturnType<typeof makeCircuits>
>()("penkra/provider/ProviderAuthCircuits") {}

export const ProviderAuthCircuitsLive = Layer.effect(
  ProviderAuthCircuits,
  Effect.map(Effect.service(SqlClient.SqlClient), makeCircuits),
);
