// FILE: ProviderConnectionLifecycle.ts
// Purpose: Create and terminate Connections without a durable operation journal.

import { randomUUID } from "node:crypto";
import {
  type ProviderConnection,
  ProviderConnectionId,
  type ProviderKind,
} from "@penkra/contracts";
import { Effect, Layer, Option } from "effect";

import { ProviderConnectionRepository } from "../../persistence/Services/ProviderConnections.ts";
import type { ProviderConnectionRecord } from "../../persistence/Services/ProviderConnections.ts";
import { ProviderAuthCircuits, ProviderAuthCircuitsLive } from "../providerAuthCircuit.ts";
import { ProviderCredentialBroker } from "../providerCredentialBroker.ts";
import { findStaticCredentialMethod } from "../providerConnectionManifests.ts";
import { secretSuffixConnectionLabel } from "../providerConnectionDisplayIdentity.ts";
import {
  ProviderConnectionLifecycle,
  ProviderConnectionLifecycleError,
  type ProviderConnectionLifecycleShape,
} from "../Services/ProviderConnectionLifecycle.ts";

interface CreatePayload {
  readonly harness: ProviderKind;
  readonly authenticationTargetId: string;
  readonly authenticationMethodId: string;
  readonly label: string;
  readonly providerIdentityId: string | null;
  readonly createdAt: string;
}

const fail = (detail: string, cause?: unknown) =>
  Effect.fail(
    new ProviderConnectionLifecycleError({
      detail,
      ...(cause === undefined ? {} : { cause }),
    }),
  );

const toPublicConnection = (record: ProviderConnectionRecord): ProviderConnection => ({
  id: record.id,
  harness: record.harness,
  authenticationTargetId: record.authenticationTargetId,
  authenticationMethodId: record.authenticationMethodId,
  label: record.label,
  providerIdentityId: record.providerIdentityId,
  health: record.health,
  healthReason: record.healthReason,
  lastCheckedAt: record.lastCheckedAt,
  lifecycle: record.lifecycle,
  terminationReason: record.terminationReason,
  terminatedAt: record.terminatedAt,
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
});

const matchesCreate = (
  record: ProviderConnectionRecord,
  input: { readonly credentialRef: string; readonly payload: CreatePayload },
): boolean =>
  record.harness === input.payload.harness &&
  record.authenticationTargetId === input.payload.authenticationTargetId &&
  record.authenticationMethodId === input.payload.authenticationMethodId &&
  record.label === input.payload.label &&
  record.providerIdentityId === input.payload.providerIdentityId &&
  record.credentialRef === input.credentialRef &&
  record.profileRef === null;

export function makeProviderConnectionLifecycle(
  input: {
    readonly newId?: () => string;
    readonly now?: () => string;
    readonly validateSecret?: (input: {
      readonly validate: (secret: string) => Promise<void>;
      readonly secret: string;
    }) => Promise<void>;
  } = {},
): Effect.Effect<
  ProviderConnectionLifecycleShape,
  never,
  ProviderConnectionRepository | ProviderCredentialBroker | ProviderAuthCircuits
> {
  return Effect.gen(function* () {
    const connections = yield* ProviderConnectionRepository;
    const credentials = yield* ProviderCredentialBroker;
    const authCircuits = yield* ProviderAuthCircuits;
    const newId = input.newId ?? randomUUID;
    const now = input.now ?? (() => new Date().toISOString());
    const validateSecret = input.validateSecret ?? ((request) => request.validate(request.secret));

    const activeConnections = new Set<ProviderConnectionId>();
    const withOperation = <A>(
      connectionId: ProviderConnectionId,
      failureDetail: string,
      effect: Effect.Effect<A, ProviderConnectionLifecycleError>,
    ) =>
      Effect.suspend(() => {
        if (activeConnections.has(connectionId)) return fail(failureDetail);
        activeConnections.add(connectionId);
        return effect.pipe(
          Effect.ensuring(
            Effect.sync(() => {
              activeConnections.delete(connectionId);
            }),
          ),
        );
      });

    const completeCreate = (operation: {
      readonly connectionId: ProviderConnectionId;
      readonly credentialRef: string;
      readonly payload: CreatePayload;
    }) =>
      Effect.gen(function* () {
        const existing = yield* connections.getRecord(operation.connectionId).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderConnectionLifecycleError({
                detail: "Could not inspect the Connection creation result.",
                cause,
              }),
          ),
        );
        let connection: ProviderConnection;
        if (Option.isSome(existing)) {
          const record = existing.value;
          if (!matchesCreate(record, operation)) {
            return yield* fail("Connection identity collides with a different durable record.");
          }
          if (record.lifecycle === "terminated" && operation.payload.providerIdentityId !== null) {
            connection = yield* connections
              .reactivateIdentity({
                id: record.id,
                harness: record.harness,
                authenticationTargetId: record.authenticationTargetId,
                authenticationMethodId: record.authenticationMethodId,
                label: operation.payload.label,
                credentialRef: operation.credentialRef,
                profileRef: null,
                providerIdentityId: operation.payload.providerIdentityId,
                updatedAt: now(),
              })
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new ProviderConnectionLifecycleError({
                      detail: "Could not reactivate the existing Connection.",
                      cause,
                    }),
                ),
                Effect.flatMap(
                  Option.match({
                    onNone: () => fail("The existing Connection could not be reactivated."),
                    onSome: Effect.succeed,
                  }),
                ),
              );
          } else {
            connection = toPublicConnection(record);
          }
        } else {
          connection = yield* connections
            .create({
              id: operation.connectionId,
              harness: operation.payload.harness,
              authenticationTargetId: operation.payload.authenticationTargetId,
              authenticationMethodId: operation.payload.authenticationMethodId,
              label: operation.payload.label,
              credentialRef: operation.credentialRef,
              profileRef: null,
              providerIdentityId: operation.payload.providerIdentityId,
              createdAt: operation.payload.createdAt,
            })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderConnectionLifecycleError({
                    detail: "Could not commit the new Connection.",
                    cause,
                  }),
              ),
              Effect.catch((createError) =>
                connections.getRecord(operation.connectionId).pipe(
                  Effect.mapError(
                    (cause) =>
                      new ProviderConnectionLifecycleError({
                        detail: "Could not determine whether Connection creation committed.",
                        cause,
                      }),
                  ),
                  Effect.flatMap(
                    Option.match({
                      onSome: (record) =>
                        matchesCreate(record, operation)
                          ? Effect.succeed(toPublicConnection(record))
                          : fail("Connection identity collides with a different durable record."),
                      onNone: () =>
                        credentials.remove(operation.credentialRef).pipe(
                          Effect.mapError(
                            (cause) =>
                              new ProviderConnectionLifecycleError({
                                detail:
                                  "Connection creation failed and its encrypted credential could not be removed.",
                                cause,
                              }),
                          ),
                          Effect.andThen(Effect.fail(createError)),
                        ),
                    }),
                  ),
                ),
              ),
            );
        }
        yield* authCircuits.close(connection.id);
        return connection;
      });

    const createStatic: ProviderConnectionLifecycleShape["createStatic"] = (createInput) =>
      Effect.gen(function* () {
        if (!credentials.available) {
          return yield* fail("Secure Connection storage is unavailable outside Penkra Desktop.");
        }
        const method = findStaticCredentialMethod({
          harness: createInput.harness,
          authenticationTargetId: createInput.authenticationTargetId,
          authenticationMethodId: createInput.authenticationMethodId,
        });
        if (!method) {
          return yield* fail("This authentication method is not enabled by the managed adapter.");
        }
        if (method.displayIdentity.kind !== "secret-suffix") {
          return yield* fail("This authentication method has no credential identity strategy.");
        }
        const displayIdentityPrefix = method.displayIdentity.prefix;
        yield* Effect.tryPromise({
          try: () =>
            validateSecret({
              validate: method.validateSecret,
              secret: createInput.secret,
            }),
          catch: (cause) =>
            new ProviderConnectionLifecycleError({
              detail:
                cause instanceof Error ? cause.message : "The provider rejected this credential.",
              cause,
            }),
        });
        const providerIdentityId = `api-key:hmac-sha256:${yield* credentials
          .fingerprint(createInput.secret)
          .pipe(
            Effect.mapError(
              (cause) =>
                new ProviderConnectionLifecycleError({
                  detail: "Could not identify the provider credential.",
                  cause,
                }),
            ),
          )}`;
        const canonical = (yield* connections.list({ includeTerminated: true }).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderConnectionLifecycleError({
                detail: "Could not inspect existing Connections.",
                cause,
              }),
          ),
        ))
          .filter(
            (connection) =>
              connection.harness === createInput.harness &&
              connection.authenticationTargetId === createInput.authenticationTargetId &&
              connection.providerIdentityId === providerIdentityId,
          )
          .sort(
            (left, right) =>
              left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
          )[0];
        const connectionId = canonical?.id ?? ProviderConnectionId.makeUnsafe(newId());
        const credentialRef = `provider-secret:${connectionId}`;
        const createdAt = now();
        const label = yield* Effect.try({
          try: () =>
            secretSuffixConnectionLabel({
              prefix: displayIdentityPrefix,
              secret: createInput.secret,
            }),
          catch: (cause) =>
            new ProviderConnectionLifecycleError({
              detail:
                cause instanceof Error
                  ? cause.message
                  : "Could not identify the provider credential.",
              cause,
            }),
        });
        const payload: CreatePayload = {
          harness: createInput.harness,
          authenticationTargetId: createInput.authenticationTargetId,
          authenticationMethodId: createInput.authenticationMethodId,
          label,
          providerIdentityId,
          createdAt,
        };
        return yield* withOperation(
          connectionId,
          "Could not begin Connection creation.",
          Effect.gen(function* () {
            yield* credentials.store(createInput.secret, credentialRef).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderConnectionLifecycleError({
                    detail: cause.message,
                    cause,
                  }),
              ),
              Effect.catch((storeError) =>
                credentials.has(credentialRef).pipe(
                  Effect.mapError(
                    (cause) =>
                      new ProviderConnectionLifecycleError({
                        detail: "Could not determine whether credential storage committed.",
                        cause,
                      }),
                  ),
                  Effect.flatMap((exists) =>
                    exists ? Effect.succeed(credentialRef) : Effect.fail(storeError),
                  ),
                ),
              ),
            );
            return yield* completeCreate({
              connectionId,
              credentialRef,
              payload,
            });
          }),
        );
      });

    const terminate: ProviderConnectionLifecycleShape["terminate"] = (terminateInput) =>
      Effect.gen(function* () {
        if (!credentials.available) {
          return yield* fail("Secure Connection storage is unavailable outside Penkra Desktop.");
        }
        const record = yield* connections.getRecord(terminateInput.connectionId).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderConnectionLifecycleError({
                detail: "Could not read the Connection.",
                cause,
              }),
          ),
        );
        if (Option.isNone(record) || record.value.lifecycle !== "active") {
          return yield* fail("The active Connection does not exist.");
        }
        const credentialRef = record.value.credentialRef;
        if (!credentialRef || record.value.profileRef) {
          return yield* fail("This Connection is not a static credential Connection.");
        }
        const terminatedAt = now();
        return yield* withOperation(
          terminateInput.connectionId,
          "Could not begin Connection termination.",
          Effect.gen(function* () {
            const exists = yield* credentials.has(credentialRef).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderConnectionLifecycleError({
                    detail: "Could not inspect the encrypted credential during termination.",
                    cause,
                  }),
              ),
            );
            if (exists)
              yield* credentials.remove(credentialRef).pipe(
                Effect.mapError(
                  (cause) =>
                    new ProviderConnectionLifecycleError({
                      detail: "Could not remove the encrypted Connection credential.",
                      cause,
                    }),
                ),
              );
            const result = yield* connections
              .terminate({
                id: terminateInput.connectionId,
                reason: terminateInput.reason,
                terminatedAt,
              })
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new ProviderConnectionLifecycleError({
                      detail: "Could not terminate the Connection.",
                      cause,
                    }),
                ),
              );
            if (Option.isSome(result)) return result.value;
            const terminated = yield* connections.getRecord(terminateInput.connectionId).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderConnectionLifecycleError({
                    detail: "Could not read the terminated Connection.",
                    cause,
                  }),
              ),
            );
            if (Option.isNone(terminated))
              return yield* fail("The terminated Connection is not readable.");
            if (terminated.value.lifecycle !== "terminated")
              return yield* fail("Connection termination did not commit.");
            return toPublicConnection(terminated.value);
          }),
        );
      });

    return {
      createStatic,
      terminate,
    };
  });
}

export const ProviderConnectionLifecycleLive = Layer.effect(
  ProviderConnectionLifecycle,
  makeProviderConnectionLifecycle(),
).pipe(Layer.provideMerge(ProviderAuthCircuitsLive));
