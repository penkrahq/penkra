import {
  RelayReconnectLoop,
  type RelayAttemptEnd,
  type RelayReconnectEvent,
  type RelayReconnectState,
} from "./reconnect";
import { RemoteRelayError, RemoteRelaySocket, type RelaySocketInput } from "./relaySocket";
import { RelayFrameType, RELAY_ZERO_ID } from "./relayProtocol";

/** Mounts the approved retry policy on the real relay transport. Session routing
 * is installed synchronously on open; its cleanup completes before replacement.
 */
export class RemoteRelayConnection {
  readonly finished: Promise<void>;
  readonly #loop: RelayReconnectLoop;
  #active: RemoteRelaySocket | undefined;

  constructor(
    input: Omit<RelaySocketInput, "signal"> & {
      readonly signal: AbortSignal;
      readonly onOpen: (socket: RemoteRelaySocket) => () => Promise<void>;
      readonly observeReconnect: (state: RelayReconnectState) => void;
    },
  ) {
    this.#loop = new RelayReconnectLoop({
      observe: input.observeReconnect,
      attempt: async (signal): Promise<RelayAttemptEnd> => {
        if (input.signal.aborted) return { reason: "transport-failed" };
        let socket: RemoteRelaySocket | undefined;
        let cleanup: (() => Promise<void>) | undefined;
        try {
          socket = await RemoteRelaySocket.open({ ...input, signal });
          this.#active = socket;
          cleanup = input.onOpen(socket);
          const end = await socket.finished;
          if (
            end.reason === "protocol-failed" ||
            // RFC 6455 protocol/data/policy/extension rejection close codes.
            [1002, 1003, 1007, 1008, 1009, 1010].includes(end.code)
          )
            return { reason: "protocol-rejected" };
          return { reason: "transport-failed" };
        } catch (error) {
          if (signal.aborted) return { reason: "transport-failed" };
          if (!(error instanceof RemoteRelayError)) throw error;
          if (error.status === 401 || error.status === 403)
            return { reason: "authentication-rejected" };
          if (
            error.status === 426 ||
            error.code === "invalid-url" ||
            error.code === "protocol-failed"
          )
            return { reason: "protocol-rejected" };
          return { reason: "transport-failed" };
        } finally {
          if (this.#active === socket) this.#active = undefined;
          socket?.close();
          if (socket) await socket.finished;
          await cleanup?.();
        }
      },
    });
    const abort = () => {
      // The public finished promise remains the error reporting boundary.
      void this.#loop.close().catch(() => undefined);
    };
    input.signal.addEventListener("abort", abort, { once: true });
    this.finished = this.#loop.finished.finally(() =>
      input.signal.removeEventListener("abort", abort),
    );
    if (input.signal.aborted) abort();
  }

  reconnect(event: RelayReconnectEvent): void {
    this.#loop.reconnect(event);
  }

  close(): Promise<void> {
    return this.#loop.close();
  }

  async sleep(): Promise<void> {
    try {
      await this.#active?.finish({
        type: RelayFrameType.SLEEP,
        sessionId: RELAY_ZERO_ID,
        peerId: RELAY_ZERO_ID,
        payload: new Uint8Array(),
      });
    } finally {
      await this.#loop.close();
    }
  }
}
