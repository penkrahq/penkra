import type { ProviderConnectionId, ThreadId } from "@penkra/contracts";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import type { ProviderAuthFailure } from "./providerAuthFailure.ts";

export interface ProviderAuthCircuit extends ProviderAuthFailure {
  readonly connectionId: ProviderConnectionId;
  readonly openedAt: string;
  readonly nextProbeAt: string;
  readonly failureCount: number;
  readonly profileRef: string | null;
}

export function nextAuthProbeAt(nowMs: number, failureCount: number): string {
  // First probe after 10 seconds; cap the exponential delay at five minutes.
  const delayMs = Math.min(300_000, 10_000 * 2 ** Math.min(5, Math.max(0, failureCount - 1)));
  return new Date(nowMs + delayMs).toISOString();
}

export function makeProviderAuthCircuitStore(sql: SqlClient.SqlClient) {
  return {
    connectionForThread: (threadId: ThreadId) =>
      sql<{
        readonly connectionId: ProviderConnectionId;
        readonly authenticationMethodId: string;
        readonly harness: string;
      }>`
        SELECT binding.connection_id AS "connectionId",
               connection.authentication_method_id AS "authenticationMethodId",
               connection.harness_kind AS harness
        FROM thread_runtime_bindings AS binding
        JOIN provider_connections AS connection ON connection.connection_id = binding.connection_id
        WHERE binding.thread_id = ${threadId} AND connection.lifecycle = 'active'
        LIMIT 1
      `,
    get: (connectionId: ProviderConnectionId) =>
      sql<ProviderAuthCircuit>`
        SELECT connection_id AS "connectionId", kind, summary, detail,
               opened_at AS "openedAt", next_probe_at AS "nextProbeAt",
               failure_count AS "failureCount", profile_ref AS "profileRef"
        FROM provider_auth_circuits WHERE connection_id = ${connectionId}
      `,
    listDue: (now: string) =>
      sql<
        ProviderAuthCircuit & {
          readonly harness: string;
          readonly currentProfileRef: string | null;
        }
      >`
        SELECT circuit.connection_id AS "connectionId", circuit.kind,
               circuit.summary, circuit.detail, circuit.opened_at AS "openedAt",
               circuit.next_probe_at AS "nextProbeAt", circuit.failure_count AS "failureCount",
               circuit.profile_ref AS "profileRef", connection.profile_ref AS "currentProfileRef",
               connection.harness_kind AS harness
        FROM provider_auth_circuits AS circuit
        JOIN provider_connections AS connection ON connection.connection_id = circuit.connection_id
        WHERE (circuit.next_probe_at <= ${now}
               OR COALESCE(circuit.profile_ref, '') <> COALESCE(connection.profile_ref, ''))
          AND connection.lifecycle = 'active'
      `,
    open: (input: {
      readonly connectionId: ProviderConnectionId;
      readonly failure: ProviderAuthFailure;
      readonly now: string;
    }) =>
      sql`
        INSERT INTO provider_auth_circuits
          (connection_id, kind, summary, detail, profile_ref,
           opened_at, next_probe_at, failure_count)
        SELECT ${input.connectionId}, ${input.failure.kind}, ${input.failure.summary},
               ${input.failure.detail}, profile_ref, ${input.now},
               ${nextAuthProbeAt(Date.parse(input.now), 1)}, 1
        FROM provider_connections WHERE connection_id = ${input.connectionId}
        ON CONFLICT(connection_id) DO UPDATE SET
          kind = excluded.kind,
          summary = excluded.summary,
          detail = excluded.detail,
          profile_ref = excluded.profile_ref,
          opened_at = excluded.opened_at,
          next_probe_at = excluded.next_probe_at,
          failure_count = 1
        WHERE provider_auth_circuits.profile_ref IS NOT excluded.profile_ref
      `,
    recordFailedProbe: (input: {
      readonly connectionId: ProviderConnectionId;
      readonly now: string;
      readonly failureCount: number;
    }) =>
      sql`
        UPDATE provider_auth_circuits
        SET failure_count = ${input.failureCount + 1},
            next_probe_at = ${nextAuthProbeAt(Date.parse(input.now), input.failureCount + 1)}
        WHERE connection_id = ${input.connectionId}
      `,
    close: (connectionId: ProviderConnectionId) =>
      sql`DELETE FROM provider_auth_circuits WHERE connection_id = ${connectionId}`,
    listThreadIds: (connectionId: ProviderConnectionId) =>
      sql<{ readonly threadId: ThreadId }>`
        SELECT thread_id AS "threadId" FROM thread_runtime_bindings
        WHERE connection_id = ${connectionId}
      `,
  };
}
