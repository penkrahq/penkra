import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { RemoteLifecycleSnapshot } from "@penkra/contracts";
import { SessionCredentialService } from "../auth/Services/SessionCredentialService";
import { type RemoteAccountWork } from "./accountLifetime";
import { DesktopRemoteCredentials } from "./desktopCredentials";
import { RemotePairingApprovals } from "./pairingApprovals";
import { makeRemotePhoneRegistry } from "./phoneRegistry";
import { RemoteRegistryClient } from "./registry";
import { type RemoteRelayConnection } from "./relayConnection";
import type { RelaySocketEvent } from "./relaySocket";
import type { RelayReconnectState } from "./reconnect";
import type { RemoteSessionEvent } from "./sessionBridge";
import { makeSessionRelay } from "./sessionRelay";
import { RemotePhoneSessions } from "./phoneSessions";
import { RemoteDevicesControlState } from "./devicesControl";
import { makeRemoteTrustStore, RemoteTrustScope, RemoteTrustStore } from "./trustStore";

/** Capture the backend's scoped persistence services; each account mounts its own trust. */
export function makeRemoteAccountWork(input: {
  relayUrl: string;
  origin: string;
  credentials: DesktopRemoteCredentials;
  approvals: RemotePairingApprovals;
  onViewing: (phoneDeviceId: string, threadId: string | null) => void;
  devices: RemoteDevicesControlState;
  observeSocket: (event: RelaySocketEvent) => void;
  observeReconnect: (state: RelayReconnectState) => void;
  observeSession: (event: RemoteSessionEvent) => void;
  observeFailure: (error: unknown) => void;
}) {
  return Effect.gen(function* () {
    const run = Effect.runPromiseWith(
      yield* Effect.context<SqlClient.SqlClient | SessionCredentialService>(),
    );
    return (
      snapshot: RemoteLifecycleSnapshot & { accountId: string },
      ownerSignal: AbortSignal,
    ): RemoteAccountWork => {
      const preparation = new AbortController();
      const abort = () => preparation.abort();
      ownerSignal.addEventListener("abort", abort, { once: true });
      if (ownerSignal.aborted) abort();
      let relay: RemoteRelayConnection | undefined;
      const sessions = new RemotePhoneSessions();
      let detachDevices: (() => void) | undefined;
      let unsubscribeSessions: (() => void) | undefined;
      let closing = false;
      const ready = (async () => {
        const result = await input.credentials.read(preparation.signal);
        if (result.accountId !== snapshot.accountId || !result.credentials?.registration)
          throw new Error("RemoteLink account registration is unavailable.");
        const { identityPrivateKey, registration } = result.credentials;
        const key = Buffer.from(identityPrivateKey, "base64");
        try {
          const scope = {
            accountServiceUrl: snapshot.accountServiceUrl,
            accountId: snapshot.accountId,
            macDeviceId: registration.deviceId,
          };
          const setup = Effect.gen(function* () {
            const trust = yield* makeRemoteTrustStore.pipe(
              Effect.provideService(RemoteTrustScope, scope),
            );
            const registry = new RemoteRegistryClient({
              apiUrl: snapshot.accountServiceUrl,
              deviceToken: registration.deviceToken,
            });
            const phoneRegistry = yield* makeRemotePhoneRegistry(registry).pipe(
              Effect.provideService(RemoteTrustStore, trust),
            );
            if (closing || ownerSignal.aborted) return undefined;
            const trackedRegistry = {
              ...phoneRegistry,
              allow: (value: Parameters<typeof phoneRegistry.allow>[0]) =>
                phoneRegistry
                  .allow(value)
                  .pipe(Effect.tap(() => Effect.sync(() => input.devices.changed()))),
              reconcile: phoneRegistry.reconcile.pipe(
                Effect.ensuring(Effect.sync(() => input.devices.changed())),
              ),
            };
            const deviceOwner = input.devices.attach({
              list: async () =>
                (await run(trust.list(), { signal: ownerSignal })).map((phone) => ({
                  deviceId: phone.deviceId,
                  name: phone.name,
                  connected: sessions.connected(phone.deviceId),
                  lastConnectedAt: phone.lastConnectedAt,
                })),
              remove: async (deviceId) => {
                await run(
                  phoneRegistry.remove(deviceId, () => input.devices.changed()),
                  { signal: ownerSignal },
                );
              },
            });
            detachDevices = deviceOwner.detach;
            unsubscribeSessions = sessions.subscribe(() => input.devices.changed());
            relay = yield* makeSessionRelay({
              macDeviceId: registration.deviceId,
              macPrivateKey: key,
              origin: input.origin,
              approvals: input.approvals,
              registry: trackedRegistry,
              url: input.relayUrl,
              deviceToken: registration.deviceToken,
              signal: ownerSignal,
              onViewing: input.onViewing,
              onSession: (phoneId, sessionId, connected) => {
                if (connected) sessions.open(phoneId, sessionId);
                else sessions.close(phoneId, sessionId);
              },
              observe: input.observeSession,
              observeSocket: (event) => {
                if (event.event === "opened") deviceOwner.setStatus("connected");
                input.observeSocket(event);
              },
              observeReconnect: (state) => {
                if (state.state === "rejected")
                  deviceOwner.setStatus(
                    state.reason === "authentication-rejected"
                      ? "rejected-sign-in"
                      : "rejected-protocol",
                  );
                else if (state.state === "connecting" || state.state === "waiting")
                  deviceOwner.setStatus("connecting");
                input.observeReconnect(state);
              },
              observeFailure: input.observeFailure,
            }).pipe(Effect.provideService(RemoteTrustStore, trust));
          });
          await run(setup, { signal: preparation.signal });
          if (relay) await relay.finished;
        } finally {
          try {
            unsubscribeSessions?.();
            detachDevices?.();
          } finally {
            key.fill(0);
          }
        }
      })()
        .catch((error) => {
          if (!preparation.signal.aborted && !ownerSignal.aborted) {
            try {
              input.observeFailure(error);
            } catch {
              /* Diagnostics do not own account work. */
            }
          }
        })
        .finally(() => ownerSignal.removeEventListener("abort", abort));
      return {
        reconnect: (event) => relay?.reconnect(event),
        close: async (reason) => {
          closing = true;
          try {
            if (relay) {
              if (reason === "suspend") await relay.sleep();
              else await relay.close();
            } else preparation.abort();
          } finally {
            await ready;
          }
        },
      };
    };
  });
}
