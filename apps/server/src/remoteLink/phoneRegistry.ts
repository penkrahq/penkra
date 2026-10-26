import { Effect } from "effect";
import { makeKeyedLock } from "../keyedLock";
import { RemoteRegistryClient, RemoteRegistryError } from "./registry";
import { RemoteTrustStore, type PairedPhone } from "./trustStore";

/** All Allow/Remove/reconciliation for one mounted account passes through this
 * owner. Network ordering is per phone, never a lock shared across phones.
 * SQLite trust remains authoritative; backend writes are idempotent.
 */
export const makeRemotePhoneRegistry = (registry: RemoteRegistryClient) =>
  Effect.gen(function* () {
    const trust = yield* RemoteTrustStore;
    const withPhone = makeKeyedLock<string>();
    const request = <A>(operation: (signal: AbortSignal) => Promise<A>) =>
      Effect.tryPromise({
        try: operation,
        catch: (error) => error,
      }).pipe(
        Effect.catch((error) =>
          error instanceof RemoteRegistryError
            ? Effect.fail(error)
            : Effect.die(new Error("Unexpected RemoteLink registry failure.")),
        ),
      );
    const record = (deviceId: string, operation: "pair" | "unpair", error: RemoteRegistryError) =>
      Effect.logWarning("RemoteLink pairing registry request failed", {
        macDeviceId: trust.scope.macDeviceId,
        phoneDeviceId: deviceId,
        operation,
        code: error.code,
        status: error.status,
      });
    const pair = (deviceId: string, expectedSessionId: PairedPhone["sessionId"]) =>
      Effect.gen(function* () {
        const phone = yield* trust.get(deviceId);
        if (!phone || phone.sessionId !== expectedSessionId) return false;
        if (phone.pendingBackend === 0) return true;
        const result = yield* request((signal) => registry.pair(deviceId, signal)).pipe(
          Effect.result,
        );
        if (result._tag === "Failure") {
          yield* record(deviceId, "pair", result.failure);
          return false;
        }
        yield* trust.markPaired(deviceId, phone.sessionId);
        return true;
      });
    const unpair = (deviceId: string) =>
      request((signal) => registry.unpair(deviceId, signal)).pipe(
        Effect.as(true),
        Effect.catch((error) => record(deviceId, "unpair", error).pipe(Effect.as(false))),
      );

    const allow = (input: Parameters<typeof trust.allow>[0]) =>
      Effect.gen(function* () {
        // Local trust changes never wait for a network operation. Only the
        // remote writes are ordered, then guarded by the current generation.
        const credential = yield* trust.allow(input);
        const backendPaired = yield* withPhone(
          input.deviceId,
          pair(input.deviceId, credential.sessionId),
        );
        return { credential, backendPaired };
      });
    const remove = (deviceId: string) =>
      Effect.gen(function* () {
        // This transaction revokes and joins live local sessions before I/O.
        yield* trust.remove(deviceId);
        return yield* withPhone(
          deviceId,
          Effect.gen(function* () {
            // A newer Allow may have committed before this remote write got
            // its turn. Do not delete that newer pairing.
            if (yield* trust.get(deviceId)) return true;
            return yield* unpair(deviceId);
          }),
        );
      });
    const reconcile = Effect.gen(function* () {
      // Capture local generations before the remote read. A response cannot
      // revoke a new Allow committed while that read was in flight.
      const before = new Map((yield* trust.list()).map((phone) => [phone.deviceId, phone]));
      const remote = new Set(yield* request((signal) => registry.listPairings(signal)));
      const deviceIds = new Set([...before.keys(), ...remote]);
      yield* Effect.forEach(
        deviceIds,
        (deviceId) =>
          withPhone(
            deviceId,
            Effect.gen(function* () {
              const current = yield* trust.get(deviceId);
              if (!current) {
                if (remote.has(deviceId)) yield* unpair(deviceId);
                return;
              }
              if (current.pendingBackend !== 0) {
                yield* pair(deviceId, current.sessionId);
                return;
              }
              const captured = before.get(deviceId);
              if (
                !remote.has(deviceId) &&
                captured?.sessionId === current.sessionId &&
                captured.pendingBackend === 0
              ) {
                // Backend cascade/removal is authoritative for a previously
                // completed pairing. Never recreate it by POSTing automatically.
                yield* trust.remove(deviceId, current.sessionId);
              }
            }),
          ),
        { concurrency: "unbounded", discard: true },
      );
    });
    return { scope: trust.scope, allow, remove, reconcile };
  });
