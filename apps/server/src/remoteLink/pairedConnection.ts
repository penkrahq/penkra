import { Effect } from "effect";
import { SessionCredentialService } from "../auth/Services/SessionCredentialService";
import { RemoteTrustStore } from "./trustStore";
import { openPairedSession, RemoteLinkSessionError } from "./pairedSession";
import { RemoteSessionBridge, type RemoteSessionEvent } from "./sessionBridge";

/** The relay OPEN selects a persisted phone, never supplies its identity key.
 * This whole effect must live in the relay session's scope. Revocation uses the
 * same authenticated-connection lease as local clients and interrupts this scope.
 */
export function runPairedConnection(input: {
  macDeviceId: string;
  macPrivateKey: Uint8Array;
  phoneDeviceId: string;
  sessionId: string;
  openingMessage: Uint8Array;
  origin: string;
  sendWire: (ciphertext: Uint8Array) => Promise<void>;
  sendHandshakeReply: (reply: Uint8Array) => Promise<void>;
  onBridge: (session: RemoteSessionBridge) => void;
  onViewing: (threadId: string | null) => void;
  observe: (event: RemoteSessionEvent) => void;
}) {
  return Effect.scoped(
    Effect.gen(function* () {
      const trust = yield* RemoteTrustStore;
      if (trust.scope.macDeviceId !== input.macDeviceId)
        return yield* new RemoteLinkSessionError({
          message: "Mac registration does not own this phone trust.",
        });
      const sessions = yield* SessionCredentialService;
      const phone = yield* trust.get(input.phoneDeviceId);
      if (!phone) return yield* new RemoteLinkSessionError({ message: "Phone is not paired." });
      const connected = yield* openPairedSession({
        macDeviceId: input.macDeviceId,
        macPrivateKey: input.macPrivateKey,
        phone,
        openingMessage: input.openingMessage,
      });
      return yield* sessions.runAuthenticatedConnection(
        phone.sessionId,
        Effect.acquireUseRelease(
          Effect.sync(
            () =>
              new RemoteSessionBridge({
                phoneDeviceId: phone.deviceId,
                sessionId: input.sessionId,
                origin: input.origin,
                credential: connected.credential.token,
                transport: connected.transport,
                sendWire: input.sendWire,
                onViewing: input.onViewing,
                observe: input.observe,
              }),
          ),
          (bridge) =>
            Effect.gen(function* () {
              // Key proof and the authenticated lease are complete. Register
              // the receiver before the reply write can enable peer DATA.
              yield* Effect.sync(() => input.onBridge(bridge));
              yield* Effect.tryPromise({
                try: () => input.sendHandshakeReply(connected.reply),
                catch: () =>
                  new RemoteLinkSessionError({ message: "Relay handshake reply failed." }),
              });
              yield* trust.connected(phone.deviceId, phone.sessionId);
              yield* Effect.callback<void>((resume) => {
                if (bridge.channel.signal.aborted) {
                  resume(Effect.void);
                  return;
                }
                const stop = () => resume(Effect.void);
                bridge.channel.signal.addEventListener("abort", stop, { once: true });
                return Effect.sync(() => bridge.channel.signal.removeEventListener("abort", stop));
              });
            }),
          (bridge) => Effect.promise(() => bridge.close()),
        ),
      );
    }),
  );
}
