import type { Socket } from "node:net";
import {
  RemoteLifecycleControl,
  type RemoteLifecycleEvent,
  type RemoteLifecycleSnapshot,
} from "@penkra/contracts";
import { DESKTOP_CREDENTIAL_MAX_RESPONSE_BYTES } from "@penkra/shared/desktopCredentialLimits";
import { Schema } from "effect";

const decodeControl = Schema.decodeUnknownSync(RemoteLifecycleControl, {
  onExcessProperty: "error",
});

/** One backend subscriber; at most one in-flight frame and one latest snapshot.
 * A transition resolves only when that latest snapshot has been acknowledged.
 * Disconnect is failure, never proof that the backend released its sessions.
 */
export class RemoteLifecycleHost {
  #current: RemoteLifecycleEvent;
  #socket: Socket | undefined;
  #inFlight: number | undefined;
  #unconfirmedDisconnect = false;
  #waiting:
    | { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void }
    | undefined;

  constructor(snapshot: RemoteLifecycleSnapshot) {
    this.#current = {
      type: "remote.lifecycle",
      revision: 0,
      event: "snapshot",
      snapshot: { ...snapshot },
    };
  }

  /** Call only from the supervised backend child's confirmed OS-exit handler,
   * never from a pipe disconnect, readiness error or an elapsed deadline.
   */
  backendExited(): void {
    const socket = this.#socket;
    this.#socket = undefined;
    this.#inFlight = undefined;
    this.#unconfirmedDisconnect = false;
    this.#waiting?.resolve();
    this.#waiting = undefined;
    socket?.destroy();
  }

  transition(
    event: Exclude<RemoteLifecycleEvent["event"], "snapshot">,
    snapshot: RemoteLifecycleSnapshot,
  ): Promise<void> {
    this.#current = {
      type: "remote.lifecycle",
      revision: this.#current.revision + 1,
      event,
      snapshot: { ...snapshot },
    };
    if (!this.#socket)
      return this.#unconfirmedDisconnect
        ? Promise.reject(new Error("RemoteLink lifecycle cleanup has not been acknowledged."))
        : Promise.resolve();
    if (!this.#waiting) {
      let resolve!: () => void;
      let reject!: (error: Error) => void;
      const promise = new Promise<void>((complete, fail) => {
        resolve = complete;
        reject = fail;
      });
      this.#waiting = { promise, resolve, reject };
    }
    this.#send();
    return this.#waiting.promise;
  }

  subscribe(socket: Socket, requestId: string): void {
    if (this.#socket) throw new Error("RemoteLink already has a lifecycle owner.");
    this.#socket = socket;
    this.#current = { ...this.#current, event: "snapshot" };
    let bytes = Buffer.alloc(0);
    const failed = () => {
      if (this.#socket !== socket) return;
      this.#socket = undefined;
      this.#unconfirmedDisconnect = true;
      this.#inFlight = undefined;
      this.#waiting?.reject(
        new Error("RemoteLink lifecycle owner disconnected before acknowledgement."),
      );
      this.#waiting = undefined;
      socket.removeListener("data", data);
      socket.removeListener("close", failed);
      socket.removeListener("error", failed);
      socket.destroy();
    };
    const data = (chunk: Buffer) => {
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length > DESKTOP_CREDENTIAL_MAX_RESPONSE_BYTES) return failed();
      let newline: number;
      while ((newline = bytes.indexOf(10)) >= 0) {
        const line = bytes.subarray(0, newline);
        bytes = bytes.subarray(newline + 1);
        try {
          const ack = decodeControl(JSON.parse(line.toString("utf8")));
          if (ack.type === "released") {
            this.#socket = undefined;
            this.#inFlight = undefined;
            this.#unconfirmedDisconnect = false;
            this.#waiting?.resolve();
            this.#waiting = undefined;
            socket.removeListener("data", data);
            socket.removeListener("close", failed);
            socket.removeListener("error", failed);
            socket.end();
            return;
          }
          if (ack.revision !== this.#inFlight) return failed();
          this.#inFlight = undefined;
          if (ack.revision === this.#current.revision) {
            this.#unconfirmedDisconnect = false;
            this.#waiting?.resolve();
            this.#waiting = undefined;
          } else this.#send();
        } catch {
          return failed();
        }
      }
    };
    socket.on("data", data);
    socket.once("close", failed);
    socket.once("error", failed);
    socket.write(`${JSON.stringify({ ok: true, id: requestId, result: { subscribed: true } })}\n`);
    this.#send();
    socket.resume();
  }

  #send(): void {
    if (!this.#socket || this.#inFlight !== undefined) return;
    this.#inFlight = this.#current.revision;
    this.#socket.write(`${JSON.stringify(this.#current)}\n`);
  }
}
