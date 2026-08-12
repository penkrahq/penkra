// FILE: ProviderConnectionLifecycle.ts
// Purpose: Exact, recoverable Connection lifecycle implementation with no credential fallback.

import { randomUUID } from "node:crypto";
import {
  type ProviderConnection,
  ProviderConnectionId,
  ProviderConnectionTerminationReason,
  ProviderKind,
} from "@penkra/contracts";
import { Effect, Layer, Option, Schema } from "effect";

import {
  type ProviderConnectionOperationRecord,
  ProviderConnectionOperationRepository,
} from "../../persistence/Services/ProviderConnectionOperations.ts";
import { ProviderConnectionRepository } from "../../persistence/Services/ProviderConnections.ts";
import type { ProviderConnectionRecord } from "../../persistence/Services/ProviderConnections.ts";
import { ProviderCredentialBroker } from "../providerCredentialBroker.ts";
import { findStaticCredentialMethod } from "../providerConnectionManifests.ts";
import { secretSuffixConnectionLabel } from "../providerConnectionDisplayIdentity.ts";
import {
  ProviderConnectionLifecycle,
  ProviderConnectionLifecycleError,
  type ProviderConnectionLifecycleShape,
} from "../Services/ProviderConnectionLifecycle.ts";

const CreatePayload = Schema.Struct({
  harness: ProviderKind,
  authenticationTargetId: Schema.String,
  authenticationMethodId: Schema.String,
  label: Schema.String,
  providerIdentityId: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
});
type CreatePayload = typeof CreatePayload.Type;

const TerminatePayload = Schema.Struct({
  reason: ProviderConnectionTerminationReason,
  terminatedAt: Schema.String,
});
type TerminatePayload = typeof TerminatePayload.Type;

const fail = (detail: string, cause?: unknown) =>
  Effect.fail(
    new ProviderConnectionLifecycleError({
      detail,
      ...(cause === undefined ? {} : { cause }),
    }),
  );

const parseCreatePayload = (json: string, operationId: string) =>
  Effect.try({
    try: () => Schema.decodeUnknownSync(CreatePayload)(JSON.parse(json)),
    catch: (cause) =>
      new ProviderConnectionLifecycleError({
        detail: `Connection operation ${operationId} has an invalid recovery payload.`,
        cause,
      }),
  });

const parseTerminatePayload = (json: string, operationId: string) =>
  Effect.try({
    try: () => Schema.decodeUnknownSync(TerminatePayload)(JSON.parse(json)),
    catch: (cause) =>
      new ProviderConnectionLifecycleError({
        detail: `Connection operation ${operationId} has an invalid recovery payload.`,
        cause,
      }),
  });

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
  ProviderConnectionOperationRepository | ProviderConnectionRepository | ProviderCredentialBroker
> {
  return Effect.gen(function* () {
    const operations = yield* ProviderConnectionOperationRepository;
    const connections = yield* ProviderConnectionRepository;
    const credentials = yield* ProviderCredentialBroker;
    const newId = input.newId ?? randomUUID;
    const now = input.now ?? (() => new Date().toISOString());
    const validateSecret = input.validateSecret ?? ((request) => request.validate(request.secret));

    const transition = (transitionInput: Parameters<typeof operations.transition>[0]) =>
      operations.transition(transitionInput).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderConnectionLifecycleError({
              detail: `Could not persist Connection operation ${transitionInput.id}.`,
              cause,
            }),
        ),
        Effect.flatMap(
          Option.match({
            onNone: () => fail(`Connection operation ${transitionInput.id} no longer exists.`),
            onSome: Effect.succeed,
          }),
        ),
      );

    const completeCreate = (operation: {
      readonly id: string;
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
          connection = toPublicConnection(record);
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
                          Effect.andThen(
                            transition({
                              id: operation.id,
                              state: "failed",
                              credentialRef: operation.credentialRef,
                              failureReason: createError.detail,
                              updatedAt: now(),
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
        yield* transition({
          id: operation.id,
          state: "completed",
          credentialRef: operation.credentialRef,
          failureReason: null,
          updatedAt: now(),
        });
        return connection;
      });

    const recoverOne = (operation: ProviderConnectionOperationRecord) =>
      Effect.gen(function* () {
        if (!operation.credentialRef) {
          return yield* fail(`Connection operation ${operation.id} has no credential reference.`);
        }
        if (operation.kind === "create-static") {
          const payload = yield* parseCreatePayload(operation.payloadJson, operation.id);
          let state = operation.state;
          if (state === "pending") {
            const exists = yield* credentials.has(operation.credentialRef).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderConnectionLifecycleError({
                    detail: "Could not inspect the encrypted credential during recovery.",
                    cause,
                  }),
              ),
            );
            if (!exists) {
              yield* transition({
                id: operation.id,
                state: "failed",
                credentialRef: operation.credentialRef,
                failureReason: "Credential storage did not complete before restart.",
                updatedAt: now(),
              });
              return;
            }
            yield* transition({
              id: operation.id,
              state: "credential-stored",
              credentialRef: operation.credentialRef,
              failureReason: null,
              updatedAt: now(),
            });
            state = "credential-stored";
          }
          if (state === "credential-stored") {
            yield* completeCreate({
              id: operation.id,
              connectionId: operation.connectionId,
              credentialRef: operation.credentialRef,
              payload,
            });
          }
          return;
        }

        const payload = yield* parseTerminatePayload(operation.payloadJson, operation.id);
        let state = operation.state;
        if (state === "pending") {
          const exists = yield* credentials.has(operation.credentialRef).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderConnectionLifecycleError({
                  detail: "Could not inspect the encrypted credential during recovery.",
                  cause,
                }),
            ),
          );
          if (exists) {
            yield* credentials.remove(operation.credentialRef).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderConnectionLifecycleError({
                    detail: "Could not remove the encrypted Connection credential.",
                    cause,
                  }),
              ),
            );
          }
          yield* transition({
            id: operation.id,
            state: "credential-removed",
            credentialRef: operation.credentialRef,
            failureReason: null,
            updatedAt: now(),
          });
          state = "credential-removed";
        }
        if (state === "credential-removed") {
          const terminated = yield* connections
            .terminate({
              id: operation.connectionId,
              reason: payload.reason,
              terminatedAt: payload.terminatedAt,
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
          if (Option.isNone(terminated)) {
            const record = yield* connections.getRecord(operation.connectionId).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderConnectionLifecycleError({
                    detail: "Could not verify Connection termination.",
                    cause,
                  }),
              ),
            );
            if (Option.isNone(record) || record.value.lifecycle !== "terminated") {
              return yield* fail("Connection termination did not commit.");
            }
          }
          yield* transition({
            id: operation.id,
            state: "completed",
            credentialRef: operation.credentialRef,
            failureReason: null,
            updatedAt: now(),
          });
        }
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
        const connectionId = ProviderConnectionId.makeUnsafe(newId());
        const operationId = newId();
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
          providerIdentityId: null,
          createdAt,
        };
        yield* operations
          .begin({
            id: operationId,
            connectionId,
            kind: "create-static",
            state: "pending",
            credentialRef,
            payloadJson: JSON.stringify(payload),
            failureReason: null,
            createdAt,
            updatedAt: createdAt,
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new ProviderConnectionLifecycleError({
                  detail: "Could not begin Connection creation.",
                  cause,
                }),
            ),
          );
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
                exists
                  ? Effect.succeed(credentialRef)
                  : transition({
                      id: operationId,
                      state: "failed",
                      credentialRef,
                      failureReason: storeError.detail,
                      updatedAt: now(),
                    }).pipe(Effect.andThen(Effect.fail(storeError))),
              ),
            ),
          ),
        );
        yield* transition({
          id: operationId,
          state: "credential-stored",
          credentialRef,
          failureReason: null,
          updatedAt: now(),
        });
        return yield* completeCreate({
          id: operationId,
          connectionId,
          credentialRef,
          payload,
        });
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
        if (!record.value.credentialRef || record.value.profileRef) {
          return yield* fail("This Connection is not a static credential Connection.");
        }
        const operationId = newId();
        const terminatedAt = now();
        const payload: TerminatePayload = {
          reason: terminateInput.reason,
          terminatedAt,
        };
        yield* operations
          .begin({
            id: operationId,
            connectionId: terminateInput.connectionId,
            kind: "terminate",
            state: "pending",
            credentialRef: record.value.credentialRef,
            payloadJson: JSON.stringify(payload),
            failureReason: null,
            createdAt: terminatedAt,
            updatedAt: terminatedAt,
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new ProviderConnectionLifecycleError({
                  detail: "Could not begin Connection termination.",
                  cause,
                }),
            ),
          );
        yield* recoverOne({
          id: operationId,
          connectionId: terminateInput.connectionId,
          kind: "terminate",
          state: "pending",
          credentialRef: record.value.credentialRef,
          payloadJson: JSON.stringify(payload),
          failureReason: null,
          createdAt: terminatedAt,
          updatedAt: terminatedAt,
        });
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
        return toPublicConnection(terminated.value);
      });

    return {
      createStatic,
      terminate,
      recover: operations.listOpen().pipe(
        Effect.mapError(
          (cause) =>
            new ProviderConnectionLifecycleError({
              detail: "Could not read Connection recovery operations.",
              cause,
            }),
        ),
        Effect.flatMap((pending) => Effect.forEach(pending, recoverOne, { concurrency: 1 })),
        Effect.asVoid,
      ),
    };
  });
}

export const ProviderConnectionLifecycleLive = Layer.effect(
  ProviderConnectionLifecycle,
  makeProviderConnectionLifecycle(),
);
