import { Schema } from "effect";
import { isLoopbackHost } from "../startupAccess";

const DeviceId = Schema.String.check(Schema.isUUID());
const Pairings = Schema.Array(Schema.Struct({ phoneDeviceId: DeviceId }));
const decodePairings = Schema.decodeUnknownSync(Pairings, { onExcessProperty: "error" });

export class RemoteRegistryError extends Error {
  constructor(
    readonly code:
      | "invalid-config"
      | "invalid-device-id"
      | "invalid-response"
      | "network"
      | "http"
      | "cancelled",
    readonly status?: number,
  ) {
    super(`RemoteLink registry ${code}.`);
  }
}

/** Mac device-token calls only. Account-cookie registration stays in desktop
 * main; this client never acquires or forwards an account session.
 */
export class RemoteRegistryClient {
  readonly #origin: URL;
  constructor(private readonly input: { apiUrl: string; deviceToken: string }) {
    try {
      const origin = new URL(input.apiUrl);
      if (
        (origin.protocol !== "https:" &&
          !(origin.protocol === "http:" && isLoopbackHost(origin.hostname))) ||
        origin.username ||
        origin.password ||
        origin.pathname !== "/" ||
        origin.search ||
        origin.hash ||
        !input.deviceToken
      ) {
        throw new Error();
      }
      this.#origin = origin;
    } catch {
      throw new RemoteRegistryError("invalid-config");
    }
  }

  async listPairings(signal: AbortSignal): Promise<ReadonlyArray<string>> {
    const response = await this.#request("GET", "/v1/pairings", signal);
    if (response.status !== 200) {
      await this.#discard(response);
      throw new RemoteRegistryError("invalid-response", response.status);
    }
    try {
      return decodePairings(await response.json()).map((row) => row.phoneDeviceId);
    } catch {
      throw new RemoteRegistryError(signal.aborted ? "cancelled" : "invalid-response");
    }
  }

  async pair(phoneDeviceId: string, signal: AbortSignal): Promise<void> {
    this.#validateDeviceId(phoneDeviceId);
    await this.#empty("POST", "/v1/pairings", signal, { phoneDeviceId });
  }
  async unpair(phoneDeviceId: string, signal: AbortSignal): Promise<void> {
    this.#validateDeviceId(phoneDeviceId);
    await this.#empty("DELETE", `/v1/pairings/${encodeURIComponent(phoneDeviceId)}`, signal);
  }
  async unregister(signal: AbortSignal): Promise<void> {
    await this.#empty("DELETE", "/v1/devices/self", signal);
  }
  async update(input: { name?: string; appVersion?: string }, signal: AbortSignal): Promise<void> {
    await this.#empty("PATCH", "/v1/devices/self", signal, input);
  }

  async #empty(method: string, path: string, signal: AbortSignal, body?: unknown) {
    const response = await this.#request(method, path, signal, body);
    if (response.status !== 204) {
      await this.#discard(response);
      throw new RemoteRegistryError("invalid-response", response.status);
    }
  }
  #validateDeviceId(value: string) {
    try {
      DeviceId.make(value);
    } catch {
      throw new RemoteRegistryError("invalid-device-id");
    }
  }
  async #request(
    method: string,
    path: string,
    signal: AbortSignal,
    body?: unknown,
  ): Promise<Response> {
    if (signal.aborted) throw new RemoteRegistryError("cancelled");
    let response: Response;
    try {
      response = await fetch(new URL(path, this.#origin), {
        method,
        signal,
        credentials: "omit",
        redirect: "manual",
        cache: "no-store",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${this.input.deviceToken}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new RemoteRegistryError(signal.aborted ? "cancelled" : "network");
    }
    if (!response.ok) {
      await this.#discard(response);
      throw new RemoteRegistryError("http", response.status);
    }
    return response;
  }
  async #discard(response: Response) {
    await response.body?.cancel().catch(() => undefined);
  }
}
