import { Effect } from "effect";
import { SessionCredentialService } from "../auth/Services/SessionCredentialService";
import { runPairedConnection } from "./pairedConnection";
import { runPairingConnection } from "./pairingConnection";
import { type RemotePairingApprovals } from "./pairingApprovals";
import { type makeRemotePhoneRegistry } from "./phoneRegistry";
import { RelayFrameType, RelayOpenMode, type RelayFrame } from "./relayProtocol";
import { type RemoteRelaySocket } from "./relaySocket";
import { type RelaySessionWork } from "./relaySessions";
import { type RemoteSessionEvent } from "./sessionBridge";
import { RemoteTrustStore } from "./trustStore";

/** Captures the scoped trust services while the account owner is mounted. */
export function makeRelaySessionStart(input: {
  macDeviceId: string;
  macPrivateKey: Uint8Array;
  origin: string;
  approvals: RemotePairingApprovals;
  registry: Effect.Success<ReturnType<typeof makeRemotePhoneRegistry>>;
  onViewing: (phoneDeviceId: string, threadId: string | null) => void;
  observe: (event: RemoteSessionEvent) => void;
}) {
  return Effect.gen(function* () {
    const context = yield* Effect.context<RemoteTrustStore | SessionCredentialService>();
    const run = Effect.runPromiseWith(context);
    return (socket: RemoteRelaySocket) =>
      (open: RelayFrame, signal: AbortSignal): RelaySessionWork => {
        if (
          open.type !== RelayFrameType.OPEN ||
          (open.mode !== RelayOpenMode.PAIRING && open.mode !== RelayOpenMode.SESSION)
        )
          throw new Error("Expected relay OPEN.");
        let receiver: ((bytes: Uint8Array) => void) | null = null;
        const send = (payload: Uint8Array) =>
          socket.send({
            type: RelayFrameType.DATA,
            sessionId: open.sessionId,
            peerId: open.peerId,
            payload,
          });
        const task: Effect.Effect<void, unknown, RemoteTrustStore | SessionCredentialService> =
          open.mode === RelayOpenMode.PAIRING
            ? runPairingConnection({
                macDeviceId: input.macDeviceId,
                macPrivateKey: input.macPrivateKey,
                phoneDeviceId: open.peerId,
                openingMessage: open.payload,
                approvals: input.approvals,
                registry: input.registry,
                setReceiver: (next) => {
                  receiver = next;
                },
                sendWire: (bytes) => send(bytes),
              }).pipe(Effect.asVoid)
            : runPairedConnection({
                macDeviceId: input.macDeviceId,
                macPrivateKey: input.macPrivateKey,
                phoneDeviceId: open.peerId,
                sessionId: open.sessionId,
                origin: input.origin,
                openingMessage: open.payload,
                sendWire: send,
                sendHandshakeReply: send,
                onBridge: (bridge) => {
                  receiver = (bytes) => bridge.receive(bytes);
                },
                onViewing: (threadId) => input.onViewing(open.peerId, threadId),
                observe: input.observe,
              });
        // The router installs the entry before any handshake response can make
        // peer DATA arrive, including a response delivered during the send call.
        const finished = Promise.resolve()
          .then(() => run(task, { signal }))
          .then(() => undefined)
          .catch((error) => {
            if (!signal.aborted) throw error;
          });
        return {
          receive: (bytes) => {
            if (!receiver) throw new Error("Unexpected relay DATA before session readiness.");
            receiver(bytes);
          },
          finished,
        };
      };
  });
}
