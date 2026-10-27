import { Effect } from "effect";
import { RemoteRelayConnection } from "./relayConnection";
import { RelayFrameType } from "./relayProtocol";
import { makeRelaySessionStart } from "./relaySessionStart";
import { RelaySessions } from "./relaySessions";
import type { RelaySocketEvent } from "./relaySocket";
import type { RelayReconnectState } from "./reconnect";

/** A connection owns exactly one router; reconnect joins it before replacing it. */
export function makeSessionRelay(
  input: Parameters<typeof makeRelaySessionStart>[0] & {
    url: string;
    deviceToken: string;
    signal: AbortSignal;
    observeSocket: (event: RelaySocketEvent) => void;
    observeReconnect: (state: RelayReconnectState) => void;
    observeFailure: (error: unknown) => void;
  },
) {
  return Effect.gen(function* () {
    const start = yield* makeRelaySessionStart(input);
    const run = Effect.runPromiseWith(yield* Effect.context<never>());
    let owner: RelaySessions | undefined;
    return new RemoteRelayConnection({
      url: input.url,
      deviceToken: input.deviceToken,
      signal: input.signal,
      observe: input.observeSocket,
      observeReconnect: input.observeReconnect,
      onFrame: (frame) => {
        owner?.receive(frame);
        return undefined;
      },
      onOpen: (socket) => {
        const reconciliation = new AbortController();
        const reconciled = run(input.registry.reconcile, { signal: reconciliation.signal }).catch(
          (error) => {
            if (!reconciliation.signal.aborted) {
              try {
                input.observeFailure(error);
              } catch {
                /* Diagnostics do not own work. */
              }
            }
          },
        );
        const sessions = new RelaySessions({
          start: start(socket),
          closePeer: (sessionId, peerId) =>
            socket.send({
              type: RelayFrameType.CLOSE,
              sessionId,
              peerId,
              payload: new Uint8Array(),
            }),
          observeFailure: input.observeFailure,
        });
        owner = sessions;
        return async () => {
          if (owner === sessions) owner = undefined;
          reconciliation.abort();
          await Promise.all([sessions.close(), reconciled]);
        };
      },
    });
  });
}
