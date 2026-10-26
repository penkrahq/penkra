import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { RemoteLifecycleEvent } from "@penkra/contracts";
import { DESKTOP_CREDENTIAL_MAX_RESPONSE_BYTES } from "@penkra/shared/desktopCredentialLimits";
import { Schema } from "effect";

const decode = Schema.decodeUnknownSync(RemoteLifecycleEvent, { onExcessProperty: "error" });

/** One private backend subscription, not a polling/reconnect owner. The caller
 * closes and joins old sessions in apply before returning. New network startup
 * is owned separately and must not be awaited before the transition ACK.
 * closeOwner joins all account work on disconnect/cancellation, even after error.
 */
export async function watchDesktopRemoteLifecycle(input: {
  readonly env?: NodeJS.ProcessEnv;
  readonly signal: AbortSignal;
  readonly apply: (event: RemoteLifecycleEvent, signal: AbortSignal) => Promise<void>;
  readonly closeOwner: () => Promise<void>;
}): Promise<void> {
  const env = input.env ?? process.env;
  const path = env.PENKRA_APP_COMMAND_PIPE;
  const token = env.PENKRA_APP_COMMAND_TOKEN;
  const adminToken = env.PENKRA_APP_COMMAND_ADMIN_TOKEN;
  if (!path || !token || !adminToken)
    throw new Error("RemoteLink lifecycle requires trusted backend authority.");
  const id = randomUUID();
  const socket = createConnection(path);
  let accepted = false;
  let releasing: Promise<void> | undefined;
  const release = () =>
    (releasing ??= (async () => {
      await input.closeOwner();
      if (accepted && !socket.destroyed && socket.writable) {
        await new Promise<void>((resolve, reject) =>
          socket.write(`${JSON.stringify({ type: "released" })}\n`, (error) =>
            error ? reject(new Error("RemoteLink release acknowledgement failed.")) : resolve(),
          ),
        );
        socket.end();
      } else socket.destroy();
    })());
  const abort = () => {
    void release().catch(() => socket.destroy());
  };
  input.signal.addEventListener("abort", abort, { once: true });
  socket.once("connect", () =>
    socket.write(
      `${JSON.stringify({
        id,
        token,
        adminToken,
        method: "remote.lifecycle.subscribe",
      })}\n`,
    ),
  );
  let revision = -1;
  let bytes = Buffer.alloc(0);
  try {
    if (input.signal.aborted) socket.destroy();
    for await (const chunk of socket) {
      bytes = Buffer.concat([bytes, chunk]);
      // Per-line ceiling, not an ever-growing stream or history buffer.
      let newline: number;
      while ((newline = bytes.indexOf(10)) >= 0) {
        if (newline > DESKTOP_CREDENTIAL_MAX_RESPONSE_BYTES)
          throw new Error("RemoteLink lifecycle frame exceeded its size limit.");
        const line = bytes.subarray(0, newline);
        bytes = bytes.subarray(newline + 1);
        let value: unknown;
        try {
          value = JSON.parse(line.toString("utf8"));
        } catch {
          throw new Error("Invalid RemoteLink lifecycle frame.");
        }
        if (!accepted) {
          const response = value as {
            id?: unknown;
            ok?: unknown;
            result?: { subscribed?: unknown };
          } | null;
          if (
            !response ||
            response.id !== id ||
            response.ok !== true ||
            response.result?.subscribed !== true
          )
            throw new Error("Desktop rejected the RemoteLink lifecycle subscription.");
          accepted = true;
          continue;
        }
        let event: RemoteLifecycleEvent;
        try {
          event = decode(value);
        } catch {
          throw new Error("Invalid RemoteLink lifecycle event.");
        }
        if (event.revision <= revision || (revision === -1 && event.event !== "snapshot"))
          throw new Error("Invalid RemoteLink lifecycle ordering.");
        revision = event.revision;
        await input.apply(event, input.signal);
        if (input.signal.aborted) return;
        await new Promise<void>((resolve, reject) =>
          socket.write(`${JSON.stringify({ type: "ack", revision })}\n`, (error) =>
            error ? reject(new Error("RemoteLink lifecycle acknowledgement failed.")) : resolve(),
          ),
        );
      }
      if (bytes.length > DESKTOP_CREDENTIAL_MAX_RESPONSE_BYTES)
        throw new Error("RemoteLink lifecycle frame exceeded its size limit.");
    }
    if (!input.signal.aborted) throw new Error("Desktop RemoteLink lifecycle disconnected.");
  } catch (error) {
    if (!input.signal.aborted) throw error;
  } finally {
    input.signal.removeEventListener("abort", abort);
    try {
      await release();
    } finally {
      socket.destroy();
    }
  }
}
