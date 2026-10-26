import { createPrivateKey, createPublicKey } from "node:crypto";
import { DESKTOP_CREDENTIAL_MAX_RESPONSE_BYTES } from "@penkra/shared/desktopCredentialLimits";
import {
  decodeRemoteLinkRegistration,
  type RemoteLinkCredentialVault,
  type RemoteLinkCredentials,
} from "./remoteLinkCredentialVault";

interface AccountSession {
  readonly accountId: string;
  readonly cookie: string;
}
export class RemoteRegistrationError extends Error {
  constructor(
    readonly code: "account-changed" | "cancelled" | "http" | "invalid-response" | "network",
    readonly status?: number,
  ) {
    super(`RemoteLink registration ${code}.`);
  }
}

/** Desktop main only. The account cookie never crosses the backend pipe. */
export class RemoteLinkRegistrationOwner {
  #queue: Promise<unknown> = Promise.resolve();
  #generation = 0;
  #active: AbortController | undefined;
  readonly #url: URL;

  constructor(
    private readonly input: {
      readonly apiUrl: string;
      readonly fetch?: typeof fetch;
      readonly vault: Pick<RemoteLinkCredentialVault, "read" | "getOrCreate" | "register">;
      readonly account: () => Promise<AccountSession | null>;
      readonly metadata: {
        readonly name: string;
        readonly model: string;
        readonly appVersion: string;
      };
    },
  ) {
    const url = new URL(input.apiUrl);
    if (
      (url.protocol !== "https:" &&
        !(
          url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
        )) ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      throw new Error("Invalid RemoteLink account service URL.");
    }
    this.#url = new URL("/v1/devices", url);
  }

  /** Called at account changes, before a new registration can be enqueued. */
  invalidate(): void {
    this.#generation++;
    this.#active?.abort();
  }

  ensure(accountId: string, signal: AbortSignal): Promise<RemoteLinkCredentials> {
    return this.#register(accountId, false, signal).then((value) => {
      if (!value) throw new RemoteRegistrationError("account-changed");
      return value;
    });
  }

  renewAfterSignIn(accountId: string, signal: AbortSignal): Promise<RemoteLinkCredentials | null> {
    return this.#register(accountId, true, signal);
  }

  #register(
    accountId: string,
    renew: boolean,
    parent: AbortSignal,
  ): Promise<RemoteLinkCredentials | null> {
    const generation = this.#generation;
    const operation = this.#queue.then(async () => {
      const controller = new AbortController();
      this.#active = controller;
      const signal = AbortSignal.any([parent, controller.signal]);
      const check = () => {
        if (signal.aborted || generation !== this.#generation)
          throw new RemoteRegistrationError("cancelled");
      };
      const account = async () => {
        check();
        const session = await this.input.account();
        check();
        if (!session || session.accountId !== accountId || !session.cookie)
          throw new RemoteRegistrationError("account-changed");
        return session;
      };
      try {
        const session = await account();
        const credentials = renew
          ? await this.input.vault.read(accountId)
          : await this.input.vault.getOrCreate(accountId);
        check();
        // Signing in never enables access or registers an unused identity.
        if (renew && !credentials?.registration) return credentials;
        if (!credentials) throw new RemoteRegistrationError("account-changed");
        if (!renew && credentials.registration) return credentials;
        const key = Buffer.from(credentials.identityPrivateKey, "base64");
        // RFC 8410 X25519 PKCS#8 wrapping of the existing raw private key.
        const wrapped = Buffer.concat([
          Buffer.from("302e020100300506032b656e04220420", "hex"),
          key,
        ]);
        let identityKey: string;
        try {
          const publicKey = createPublicKey(
            createPrivateKey({ key: wrapped, format: "der", type: "pkcs8" }),
          ).export({ format: "jwk" });
          if (!publicKey.x || key.length !== 32) throw new Error();
          identityKey = Buffer.from(publicKey.x, "base64url").toString("base64");
        } finally {
          key.fill(0);
          wrapped.fill(0);
        }
        let response: Response;
        try {
          response = await (this.input.fetch ?? fetch)(this.#url, {
            method: "POST",
            signal,
            redirect: "manual",
            credentials: "omit",
            cache: "no-store",
            headers: {
              cookie: session.cookie,
              accept: "application/json",
              "content-type": "application/json",
            },
            body: JSON.stringify({ kind: "mac", ...this.input.metadata, identityKey }),
          });
        } catch {
          throw new RemoteRegistrationError(signal.aborted ? "cancelled" : "network");
        }
        if (response.status !== 201) {
          await response.body?.cancel().catch(() => undefined);
          throw new RemoteRegistrationError("http", response.status);
        }
        const registration = await readRegistration(response, signal);
        // A delayed response must not be applied to another signed-in account.
        await account();
        await this.input.vault.register(accountId, credentials.identityPrivateKey, registration);
        check();
        return { identityPrivateKey: credentials.identityPrivateKey, registration };
      } finally {
        if (this.#active === controller) this.#active = undefined;
      }
    });
    this.#queue = operation.catch(() => undefined);
    return operation;
  }
}

async function readRegistration(response: Response, signal: AbortSignal) {
  const reader = response.body?.getReader();
  if (!reader) throw new RemoteRegistrationError("invalid-response");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > DESKTOP_CREDENTIAL_MAX_RESPONSE_BYTES) throw new Error();
      chunks.push(next.value);
    }
    return decodeRemoteLinkRegistration(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  } catch {
    throw new RemoteRegistrationError(signal.aborted ? "cancelled" : "invalid-response");
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
