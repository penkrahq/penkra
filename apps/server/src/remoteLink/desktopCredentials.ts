// Backend-only access to desktop's OS-encrypted RemoteLink identity. Never sent to a phone.
import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { Schema } from "effect";
import { DESKTOP_CREDENTIAL_MAX_RESPONSE_BYTES } from "@penkra/shared/desktopCredentialLimits";
import { appCommandTimeoutMs } from "../appRuntimeCli";

const Credentials = Schema.Struct({
  identityPrivateKey: Schema.String,
  registration: Schema.NullOr(
    Schema.Struct({ deviceId: Schema.String, deviceToken: Schema.String }),
  ),
});
const Snapshot = Schema.Struct({
  accountId: Schema.String,
  credentials: Schema.NullOr(Credentials),
});
export type RemoteCredentialSnapshot = typeof Snapshot.Type;

export class DesktopRemoteCredentials {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  private request(
    action: "read" | "create" | "register" | "remove",
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const path = this.env.PENKRA_APP_COMMAND_PIPE;
    const token = this.env.PENKRA_APP_COMMAND_TOKEN;
    const adminToken = this.env.PENKRA_APP_COMMAND_ADMIN_TOKEN;
    if (!path || !token || !adminToken)
      return Promise.reject(
        new Error("RemoteLink requires the trusted desktop backend capability."),
      );
    if (signal?.aborted)
      return Promise.reject(new Error("RemoteLink credential request cancelled."));
    const method = `remote.credentials.${action}`;
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const socket = createConnection(path);
      let bytes = Buffer.alloc(0);
      let settled = false;
      const finish = (error?: Error, result?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        socket.destroy();
        if (error) reject(error);
        else resolve(result);
      };
      const abort = () => finish(new Error("RemoteLink credential request cancelled."));
      const timer = setTimeout(
        () => finish(new Error("RemoteLink credential request timed out.")),
        appCommandTimeoutMs(method),
      );
      signal?.addEventListener("abort", abort, { once: true });
      socket.once("connect", () =>
        socket.write(`${JSON.stringify({ id, token, adminToken, method, params })}\n`),
      );
      socket.on("data", (chunk: Buffer) => {
        bytes = Buffer.concat([bytes, chunk]);
        if (bytes.length > DESKTOP_CREDENTIAL_MAX_RESPONSE_BYTES) {
          finish(new Error("RemoteLink credential response exceeded its size limit."));
          return;
        }
        const newline = bytes.indexOf(10);
        if (newline < 0) return;
        try {
          const response = JSON.parse(bytes.subarray(0, newline).toString("utf8"));
          if (response?.id !== id || response.ok !== true)
            throw new Error("Desktop rejected the RemoteLink credential request.");
          finish(undefined, response.result);
        } catch {
          finish(new Error("Desktop returned an invalid RemoteLink credential response."));
        }
      });
      socket.once("error", () => finish(new Error("RemoteLink credential connection failed.")));
      socket.once("close", () =>
        finish(new Error("RemoteLink credential connection closed without a response.")),
      );
    });
  }

  async read(signal?: AbortSignal): Promise<RemoteCredentialSnapshot> {
    return this.snapshot(await this.request("read", {}, signal));
  }
  async getOrCreate(signal?: AbortSignal): Promise<RemoteCredentialSnapshot> {
    const snapshot = this.snapshot(await this.request("create", {}, signal));
    if (!snapshot.credentials) throw new Error("Desktop did not create a RemoteLink identity.");
    return snapshot;
  }
  private snapshot(value: unknown): RemoteCredentialSnapshot {
    let snapshot: RemoteCredentialSnapshot;
    try {
      snapshot = Schema.decodeUnknownSync(Snapshot)(value);
    } catch {
      // Schema errors may contain the input; never propagate credential-bearing diagnostics.
      throw new Error("Desktop returned an invalid RemoteLink credential snapshot.");
    }
    if (!snapshot.accountId) throw new Error("RemoteLink requires a signed-in account.");
    if (snapshot.credentials) {
      const key = snapshot.credentials.identityPrivateKey;
      if (
        Buffer.from(key, "base64").length !== 32 ||
        Buffer.from(key, "base64").toString("base64") !== key
      )
        throw new Error("Desktop returned an invalid RemoteLink identity.");
    }
    return snapshot;
  }
  async register(
    identityPrivateKey: string,
    registration: { deviceId: string; deviceToken: string },
    signal?: AbortSignal,
  ) {
    await this.request("register", { identityPrivateKey, ...registration }, signal);
  }
  async remove(identityPrivateKey: string, signal?: AbortSignal) {
    await this.request("remove", { identityPrivateKey }, signal);
  }
}
