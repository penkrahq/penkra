import { AuthSessionId } from "@penkra/contracts";
import { DateTime, Effect, Layer, ServiceMap, Semaphore } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  SessionCredentialError,
  SessionCredentialService,
} from "../auth/Services/SessionCredentialService";

export interface PairedPhone {
  readonly deviceId: string;
  readonly name: string;
  readonly identityKey: Uint8Array;
  readonly sessionId: AuthSessionId;
  readonly pairedAt: string;
  readonly lastConnectedAt: string | null;
  readonly pendingBackend: number;
}

export const makeRemoteTrustStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const sessions = yield* SessionCredentialService;
  const mutations = yield* Semaphore.make(1);
  const queryError = () =>
    new SessionCredentialError({ message: "Could not persist paired phone trust." });
  const list = () =>
    sql<PairedPhone>`
    SELECT device_id AS "deviceId", name, identity_key AS "identityKey", session_id AS "sessionId",
      paired_at AS "pairedAt", last_connected_at AS "lastConnectedAt", pending_backend AS "pendingBackend"
    FROM remote_devices ORDER BY paired_at, device_id
  `.pipe(Effect.mapError(queryError));
  const get = (deviceId: string) =>
    sql<PairedPhone>`
    SELECT device_id AS "deviceId", name, identity_key AS "identityKey", session_id AS "sessionId",
      paired_at AS "pairedAt", last_connected_at AS "lastConnectedAt", pending_backend AS "pendingBackend"
    FROM remote_devices WHERE device_id = ${deviceId}
  `.pipe(
      Effect.map((rows) => rows[0] ?? null),
      Effect.mapError(queryError),
    );

  const allow = (input: { deviceId: string; name: string; identityKey: Uint8Array }) =>
    mutations.withPermit(
      Effect.gen(function* () {
        if (input.identityKey.length !== 32)
          return yield* new SessionCredentialError({ message: "Invalid phone identity key." });
        const issued = yield* sessions.pairClient(
          { subject: input.deviceId, client: { label: input.name, deviceType: "mobile" } },
          (sessionId) =>
            Effect.gen(function* () {
              const previous = yield* get(input.deviceId);
              const pairedAt = DateTime.formatIso(yield* DateTime.now);
              yield* sql`
            INSERT INTO remote_devices (device_id, name, identity_key, session_id, paired_at, last_connected_at, pending_backend)
            VALUES (${input.deviceId}, ${input.name}, ${input.identityKey}, ${sessionId}, ${pairedAt}, NULL, 1)
            ON CONFLICT (device_id) DO UPDATE SET name = excluded.name, identity_key = excluded.identity_key,
              session_id = excluded.session_id, paired_at = excluded.paired_at,
              last_connected_at = NULL, pending_backend = 1
          `.pipe(Effect.mapError(queryError));
              return previous?.sessionId ?? null;
            }),
        );
        yield* Effect.logInfo("Committed paired phone trust", {
          phoneDeviceId: input.deviceId,
          sessionId: issued.sessionId,
        });
        return issued;
      }),
    );

  const remove = (deviceId: string) =>
    mutations.withPermit(
      Effect.gen(function* () {
        const phone = yield* get(deviceId);
        if (!phone) return false;
        yield* sessions.unpairClient(
          phone.sessionId,
          Effect.gen(function* () {
            const deleted = yield* sql`
        DELETE FROM remote_devices WHERE device_id = ${deviceId} AND session_id = ${phone.sessionId}
        RETURNING device_id
      `.pipe(Effect.mapError(queryError));
            if (deleted.length !== 1)
              return yield* new SessionCredentialError({
                message: "Paired phone changed before removal.",
              });
          }),
        );
        yield* Effect.logInfo("Removed paired phone trust and revoked its session", {
          phoneDeviceId: deviceId,
          sessionId: phone.sessionId,
        });
        return true;
      }),
    );
  const markPaired = (deviceId: string, sessionId: AuthSessionId) =>
    mutations.withPermit(
      sql`
      UPDATE remote_devices SET pending_backend = 0
      WHERE device_id = ${deviceId} AND session_id = ${sessionId}
    `.pipe(Effect.asVoid, Effect.mapError(queryError)),
    );
  const connected = (deviceId: string, sessionId: AuthSessionId) =>
    mutations.withPermit(
      Effect.gen(function* () {
        const at = DateTime.formatIso(yield* DateTime.now);
        yield* sql`UPDATE remote_devices SET last_connected_at = ${at}
        WHERE device_id = ${deviceId} AND session_id = ${sessionId} AND pending_backend = 0
      `.pipe(Effect.mapError(queryError));
      }),
    );
  return { list, get, allow, remove, markPaired, connected };
});

export class RemoteTrustStore extends ServiceMap.Service<
  RemoteTrustStore,
  Effect.Success<typeof makeRemoteTrustStore>
>()("penkra/remoteLink/RemoteTrustStore") {}
export const RemoteTrustStoreLive = Layer.effect(RemoteTrustStore, makeRemoteTrustStore);
