// FILE: providerCredentialBroker.ts
// Purpose: Talks to desktop main's encrypted provider vault without persisting secret material server-side.

import * as Crypto from "node:crypto";
import * as Net from "node:net";
import { Data, Effect, Layer, ServiceMap } from "effect";

const PIPE_ENV = "PENKRA_APP_COMMAND_PIPE";
const TOKEN_ENV = "PENKRA_APP_COMMAND_TOKEN";
const TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 128 * 1024;

export class ProviderCredentialBrokerError extends Data.TaggedError(
  "ProviderCredentialBrokerError",
)<{ readonly message: string; readonly cause?: unknown }> {}

export interface ProviderCredentialBrokerShape {
  readonly available: boolean;
  readonly store: (
    secret: string,
    reference?: string,
  ) => Effect.Effect<string, ProviderCredentialBrokerError>;
  readonly claim: (
    secret: string,
    reference: string,
  ) => Effect.Effect<string, ProviderCredentialBrokerError>;
  readonly fingerprint: (secret: string) => Effect.Effect<string, ProviderCredentialBrokerError>;
  readonly lease: (reference: string) => Effect.Effect<string, ProviderCredentialBrokerError>;
  readonly consume: (capability: string) => Effect.Effect<string, ProviderCredentialBrokerError>;
  readonly readOnce: (reference: string) => Effect.Effect<string, ProviderCredentialBrokerError>;
  readonly has: (reference: string) => Effect.Effect<boolean, ProviderCredentialBrokerError>;
  readonly remove: (reference: string) => Effect.Effect<void, ProviderCredentialBrokerError>;
}

export class ProviderCredentialBroker extends ServiceMap.Service<
  ProviderCredentialBroker,
  ProviderCredentialBrokerShape
>()("penkra/provider/ProviderCredentialBroker") {}

interface BridgeResponse {
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: { readonly message?: string };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Desktop returned an invalid provider credential response.");
  }
  return value as Record<string, unknown>;
}

function requiredResultString(response: BridgeResponse, key: string): string {
  if (!response.ok)
    throw new Error(response.error?.message ?? "Provider credential request failed.");
  const value = asRecord(response.result)[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("Desktop returned an invalid provider credential response.");
  }
  return value;
}

function request(input: {
  readonly method: string;
  readonly params: Record<string, unknown>;
  readonly env: NodeJS.ProcessEnv;
}): Promise<BridgeResponse> {
  const path = input.env[PIPE_ENV];
  const token = input.env[TOKEN_ENV];
  if (!path || !token) {
    return Promise.reject(
      new Error("Secure provider credential storage is unavailable outside Penkra Desktop."),
    );
  }
  const id = Crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const socket = Net.createConnection(path);
    let bytes = Buffer.alloc(0);
    const timer = setTimeout(
      () => socket.destroy(new Error("Provider credential request timed out.")),
      TIMEOUT_MS,
    );
    socket.once("connect", () => {
      socket.write(
        `${JSON.stringify({ id, token, method: input.method, params: input.params })}\n`,
      );
    });
    socket.on("data", (chunk) => {
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length > MAX_RESPONSE_BYTES) {
        socket.destroy(new Error("Provider credential response exceeded the size limit."));
        return;
      }
      const newline = bytes.indexOf(10);
      if (newline < 0) return;
      clearTimeout(timer);
      socket.destroy();
      try {
        resolve(JSON.parse(bytes.subarray(0, newline).toString("utf8")) as BridgeResponse);
      } catch (cause) {
        reject(new Error("Desktop returned an invalid provider credential response.", { cause }));
      }
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

export function makeProviderCredentialBroker(
  env: NodeJS.ProcessEnv = process.env,
): ProviderCredentialBrokerShape {
  const call = (method: string, params: Record<string, unknown>) =>
    Effect.tryPromise({
      try: () => request({ method, params, env }),
      catch: (cause) =>
        new ProviderCredentialBrokerError({
          message: cause instanceof Error ? cause.message : String(cause),
          cause,
        }),
    });
  const store: ProviderCredentialBrokerShape["store"] = (secret, reference) =>
    call("providers.credentials.store", {
      secret,
      ...(reference ? { reference } : {}),
    }).pipe(
      Effect.flatMap((response) =>
        Effect.try({
          try: () => requiredResultString(response, "reference"),
          catch: (cause) =>
            new ProviderCredentialBrokerError({
              message: cause instanceof Error ? cause.message : String(cause),
              cause,
            }),
        }),
      ),
    );
  const lease: ProviderCredentialBrokerShape["lease"] = (reference) =>
    call("providers.credentials.issue-lease", { reference }).pipe(
      Effect.flatMap((response) =>
        Effect.try({
          try: () => requiredResultString(response, "capability"),
          catch: (cause) =>
            new ProviderCredentialBrokerError({
              message: cause instanceof Error ? cause.message : String(cause),
              cause,
            }),
        }),
      ),
    );
  const claim: ProviderCredentialBrokerShape["claim"] = (secret, reference) =>
    call("providers.credentials.claim", { secret, reference }).pipe(
      Effect.flatMap((response) =>
        Effect.try({
          try: () => requiredResultString(response, "reference"),
          catch: (cause) =>
            new ProviderCredentialBrokerError({
              message: cause instanceof Error ? cause.message : String(cause),
              cause,
            }),
        }),
      ),
    );
  const fingerprint: ProviderCredentialBrokerShape["fingerprint"] = (secret) =>
    call("providers.credentials.fingerprint", { secret }).pipe(
      Effect.flatMap((response) =>
        Effect.try({
          try: () => requiredResultString(response, "fingerprint"),
          catch: (cause) =>
            new ProviderCredentialBrokerError({
              message: cause instanceof Error ? cause.message : String(cause),
              cause,
            }),
        }),
      ),
    );
  const consume: ProviderCredentialBrokerShape["consume"] = (capability) =>
    call("providers.credentials.consume-lease", { capability }).pipe(
      Effect.flatMap((response) =>
        Effect.try({
          try: () => requiredResultString(response, "secret"),
          catch: (cause) =>
            new ProviderCredentialBrokerError({
              message: cause instanceof Error ? cause.message : String(cause),
              cause,
            }),
        }),
      ),
    );
  const remove: ProviderCredentialBrokerShape["remove"] = (reference) =>
    call("providers.credentials.remove", { reference }).pipe(
      Effect.flatMap((response) =>
        response.ok
          ? Effect.void
          : Effect.fail(
              new ProviderCredentialBrokerError({
                message: response.error?.message ?? "Provider credential removal failed.",
              }),
            ),
      ),
    );
  const has: ProviderCredentialBrokerShape["has"] = (reference) =>
    call("providers.credentials.has", { reference }).pipe(
      Effect.flatMap((response) => {
        if (!response.ok) {
          return Effect.fail(
            new ProviderCredentialBrokerError({
              message: response.error?.message ?? "Provider credential lookup failed.",
            }),
          );
        }
        const value = asRecord(response.result).exists;
        return typeof value === "boolean"
          ? Effect.succeed(value)
          : Effect.fail(
              new ProviderCredentialBrokerError({
                message: "Desktop returned an invalid provider credential response.",
              }),
            );
      }),
    );
  return {
    available: Boolean(env[PIPE_ENV] && env[TOKEN_ENV]),
    store,
    claim,
    fingerprint,
    lease,
    consume,
    readOnce: (reference) => lease(reference).pipe(Effect.flatMap(consume)),
    has,
    remove,
  };
}

export const ProviderCredentialBrokerLive = Layer.succeed(
  ProviderCredentialBroker,
  makeProviderCredentialBroker(),
);
