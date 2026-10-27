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
import { makeRemoteTrustStore, RemoteTrustScope, RemoteTrustStore } from "./trustStore";

/** Capture the backend's scoped persistence services; each account mounts its own trust. */
export function makeRemoteAccountWork(input: {
  relayUrl: string;
  origin: string;
  credentials: DesktopRemoteCredentials;
  approvals: RemotePairingApprovals;
  onViewing: (phoneDeviceId: string, threadId: string | null) => void;
  onSessions: (sessions: RemotePhoneSessions | null) => void;
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
      let sessionsPublished = false;
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
            input.onSessions(sessions);
            sessionsPublished = true;
            relay = yield* makeSessionRelay({
              macDeviceId: registration.deviceId,
              macPrivateKey: key,
              origin: input.origin,
              approvals: input.approvals,
              registry: phoneRegistry,
              url: input.relayUrl,
              deviceToken: registration.deviceToken,
              signal: ownerSignal,
              onViewing: input.onViewing,
              onSession: (phoneId, sessionId, connected) => {
                if (connected) sessions.open(phoneId, sessionId);
                else sessions.close(phoneId, sessionId);
              },
              observe: input.observeSession,
              observeSocket: input.observeSocket,
              observeReconnect: input.observeReconnect,
              observeFailure: input.observeFailure,
            }).pipe(Effect.provideService(RemoteTrustStore, trust));
          });
          await run(setup, { signal: preparation.signal });
          if (relay) await relay.finished;
        } finally {
          try {
            if (sessionsPublished) input.onSessions(null);
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
