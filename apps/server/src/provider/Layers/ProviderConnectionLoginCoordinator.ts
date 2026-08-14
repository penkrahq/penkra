// FILE: ProviderConnectionLoginCoordinator.ts
// Purpose: Journals provider-owned logins and reuses the durable Connection for a verified identity.

import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";

import { ProviderConnectionId } from "@penkra/contracts";
import { Effect, Layer, Option } from "effect";

import { ServerConfig } from "../../config.ts";
import { prepareManagedCodexProfileConfig } from "../../codexProcessEnv.ts";
import { ProviderConnectionLoginRepository } from "../../persistence/Services/ProviderConnectionLogins.ts";
import { ProviderConnectionRepository } from "../../persistence/Services/ProviderConnections.ts";
import { ProviderInstallationRepository } from "../../persistence/Services/ProviderInstallations.ts";
import { buildProviderChildEnvironment } from "../../providerChildEnvironment.ts";
import {
  readCodexManagedAccount,
  startCodexManagedAccountLogin,
  type CodexManagedAccountProbe,
  type CodexManagedAccountSnapshot,
} from "../codexManagedAccountLogin.ts";
import {
  readCodexManagedApiKey,
  startCodexManagedApiKeyImport,
  type CodexManagedApiKeySnapshot,
} from "../codexManagedApiKeyLogin.ts";
import {
  readClaudeManagedAccount,
  startClaudeManagedAccountLogin,
  type ClaudeManagedAccountSnapshot,
} from "../claudeManagedAccountLogin.ts";
import {
  findManagedLoginMethod,
  getProviderConnectionManifest,
} from "../providerConnectionManifests.ts";
import {
  accountEmailConnectionLabel,
  secretSuffixConnectionLabel,
} from "../providerConnectionDisplayIdentity.ts";
import { providerCredentialProfileRoot } from "../providerNativeStatePaths.ts";
import { ProviderCredentialBroker } from "../providerCredentialBroker.ts";
import {
  ProviderConnectionLoginCoordinator,
  ProviderConnectionLoginError,
  type ProviderConnectionLoginCoordinatorShape,
} from "../Services/ProviderConnectionLoginCoordinator.ts";

const fail = (detail: string, cause?: unknown) =>
  Effect.fail(
    new ProviderConnectionLoginError({
      detail,
      ...(cause === undefined ? {} : { cause }),
    }),
  );

type ManagedAccountSnapshot =
  | CodexManagedAccountSnapshot
  | CodexManagedApiKeySnapshot
  | ClaudeManagedAccountSnapshot;

const asLoginError = (detail: string, cause: unknown): ProviderConnectionLoginError =>
  cause instanceof ProviderConnectionLoginError
    ? cause
    : new ProviderConnectionLoginError({ detail, cause });

const providerIdentityFromSnapshot = (snapshot: unknown): string | null => {
  if (typeof snapshot !== "object" || snapshot === null) return null;
  const email = (snapshot as { readonly email?: unknown }).email;
  return typeof email === "string" && email.trim().length > 0 ? email.trim().toLowerCase() : null;
};

export function makeProviderConnectionLoginCoordinator(
  options: {
    readonly newId?: () => string;
    readonly now?: () => string;
    readonly startLogin?: typeof startCodexManagedAccountLogin;
    readonly startApiKeyImport?: typeof startCodexManagedApiKeyImport;
    readonly probeAccount?: CodexManagedAccountProbe;
    readonly logout?: (input: {
      readonly binaryPath: string;
      readonly env: NodeJS.ProcessEnv;
    }) => Promise<void>;
  } = {},
) {
  return Effect.gen(function* () {
    const config = yield* ServerConfig;
    const logins = yield* ProviderConnectionLoginRepository;
    const connections = yield* ProviderConnectionRepository;
    const installations = yield* ProviderInstallationRepository;
    const credentials = yield* ProviderCredentialBroker;
    const handles = new Map<
      string,
      {
        authUrl: string | null;
        handle: {
          readonly loginId: string;
          readonly completion: Promise<unknown>;
          readonly cancel: () => Promise<void>;
        };
      }
    >();
    const cancellationRequests = new Set<string>();
    const now = options.now ?? (() => new Date().toISOString());
    const newId = options.newId ?? randomUUID;
    const startLogin = options.startLogin ?? startCodexManagedAccountLogin;
    const startApiKeyImport = options.startApiKeyImport ?? startCodexManagedApiKeyImport;
    const probeAccount = options.probeAccount ?? readCodexManagedAccount;
    const execFileAsync = promisify(execFile);
    const logoutCodex =
      options.logout ??
      (async (input: { readonly binaryPath: string; readonly env: NodeJS.ProcessEnv }) => {
        await execFileAsync(input.binaryPath, ["logout"], {
          env: input.env,
          timeout: 30_000,
          windowsHide: true,
        });
      });

    const probeManagedAccount = async (input: {
      readonly harness: Parameters<typeof getProviderConnectionManifest>[0];
      readonly authenticationMethodId: string;
      readonly binaryPath: string;
      readonly env: NodeJS.ProcessEnv;
    }): Promise<ManagedAccountSnapshot | null> => {
      const runtime = {
        binaryPath: input.binaryPath,
        cwd: process.cwd(),
        env: input.env,
      };
      if (input.harness === "codex") {
        return await (input.authenticationMethodId === "api-key"
          ? readCodexManagedApiKey(runtime)
          : probeAccount(runtime));
      }
      if (input.harness === "claudeAgent") return await readClaudeManagedAccount(runtime);
      throw new Error("This provider does not support managed sign in.");
    };

    const logoutManagedAccount = async (input: {
      readonly harness: Parameters<typeof getProviderConnectionManifest>[0];
      readonly binaryPath: string;
      readonly env: NodeJS.ProcessEnv;
    }) => {
      if (input.harness === "codex") {
        await logoutCodex({ binaryPath: input.binaryPath, env: input.env });
        return;
      }
      if (input.harness === "claudeAgent") {
        await execFileAsync(input.binaryPath, ["auth", "logout"], {
          env: input.env,
          timeout: 30_000,
          windowsHide: true,
        });
        return;
      }
      throw new Error("This provider does not support managed sign out.");
    };

    const loadManagedRuntime = (record: {
      readonly harness: Parameters<typeof getProviderConnectionManifest>[0];
      readonly authenticationTargetId: string;
      readonly authenticationMethodId: string;
      readonly profileRef: string;
    }) =>
      Effect.gen(function* () {
        const method = findManagedLoginMethod(record);
        const manifest = getProviderConnectionManifest(record.harness);
        const profileRoot = providerCredentialProfileRoot(config.stateDir, record.profileRef);
        if (!method || !manifest || profileRoot === null) {
          return yield* fail("This sign-in method is unavailable.");
        }
        const installation = (yield* installations.list().pipe(
          Effect.mapError(
            (cause) =>
              new ProviderConnectionLoginError({
                detail: "Could not inspect the managed provider installation.",
                cause,
              }),
          ),
        )).find(
          (candidate) => candidate.harness === record.harness && candidate.lifecycle === "active",
        );
        if (!installation) return yield* fail("The managed provider is not ready.");
        const installed = yield* installations.getRecord(installation.id).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderConnectionLoginError({
                detail: "Could not read the managed provider.",
                cause,
              }),
          ),
          Effect.flatMap(
            Option.match({
              onNone: () => fail("The managed provider is unavailable."),
              onSome: Effect.succeed,
            }),
          ),
        );
        const nativeStateRoot = path.join(profileRoot, "login-state");
        const stateEnvironment = manifest.buildStateEnvironment({
          profileRoot,
          nativeStateRoot,
        });
        const env = buildProviderChildEnvironment({
          provider: manifest.childKind,
          baseEnv: process.env,
          managedConnection: true,
          isolation: stateEnvironment.isolation,
          preserveOsHome: manifest.preserveOsHome === true,
          overrides: stateEnvironment.overrides,
        });
        return { installed, manifest, method, stateEnvironment, env };
      });

    const releaseManagedCredentialIdentity = (record: {
      readonly connectionId: ProviderConnectionId;
      readonly harness: Parameters<typeof getProviderConnectionManifest>[0];
      readonly authenticationTargetId: string;
      readonly authenticationMethodId: string;
    }) => {
      const method = findManagedLoginMethod(record);
      if (method?.loginMechanism !== "secret-import") return Effect.void;
      return credentials.remove(`provider-secret:${record.connectionId}`).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderConnectionLoginError({
              detail: "Could not release the provider credential identity.",
              cause,
            }),
        ),
      );
    };

    const cleanupUncommittedProfile = (record: {
      readonly connectionId: ProviderConnectionId;
      readonly harness: Parameters<typeof getProviderConnectionManifest>[0];
      readonly authenticationTargetId: string;
      readonly authenticationMethodId: string;
      readonly profileRef: string;
    }) =>
      Effect.gen(function* () {
        const runtime = yield* loadManagedRuntime(record);
        yield* Effect.tryPromise(() =>
          logoutManagedAccount({
            harness: record.harness,
            binaryPath: runtime.installed.executablePath,
            env: runtime.env,
          }),
        );
        const account = yield* Effect.tryPromise(() =>
          probeManagedAccount({
            harness: record.harness,
            authenticationMethodId: record.authenticationMethodId,
            binaryPath: runtime.installed.executablePath,
            env: runtime.env,
          }),
        );
        if (account !== null) return yield* fail("The failed provider profile is still signed in.");
        const existing = yield* connections.getRecord(record.connectionId);
        if (Option.isSome(existing) && existing.value.lifecycle === "active") {
          yield* connections.terminate({
            id: record.connectionId,
            reason: "disconnected",
            terminatedAt: now(),
          });
        }
        yield* releaseManagedCredentialIdentity(record);
        const retiredAt = now();
        yield* connections.retireManagedProfile({ profileRef: record.profileRef, retiredAt });
        const profileRoot = providerCredentialProfileRoot(config.stateDir, record.profileRef);
        if (profileRoot !== null) {
          yield* Effect.tryPromise(() => rm(profileRoot, { recursive: true, force: true }));
          yield* connections.markManagedProfileRemoved({
            profileRef: record.profileRef,
            removedAt: now(),
          });
        }
      });

    const commitVerified = (record: {
      readonly operationId: string;
      readonly connectionId: ProviderConnectionId;
      readonly harness: Parameters<typeof getProviderConnectionManifest>[0];
      readonly authenticationTargetId: string;
      readonly authenticationMethodId: string;
      readonly label: string;
      readonly profileRef: string;
      readonly providerLoginId: string | null;
      readonly providerIdentityId: string | null;
      readonly createdAt: string;
    }) =>
      Effect.gen(function* () {
        const method = findManagedLoginMethod({
          harness: record.harness,
          authenticationTargetId: record.authenticationTargetId,
          authenticationMethodId: record.authenticationMethodId,
        });
        if (!method) {
          return yield* fail("The verified Connection authentication method is unavailable.");
        }
        const label =
          method.displayIdentity.kind === "account-email"
            ? yield* Effect.try({
                try: () => accountEmailConnectionLabel(record.providerIdentityId),
                catch: (cause) =>
                  new ProviderConnectionLoginError({
                    detail:
                      cause instanceof Error
                        ? cause.message
                        : "Could not identify the provider account.",
                    cause,
                  }),
              })
            : record.label;
        if (record.providerIdentityId === null) {
          return yield* fail("The verified Connection has no durable provider identity.");
        }
        const committed = yield* connections
          .commitManagedProfile({
            id: record.connectionId,
            harness: record.harness,
            authenticationTargetId: record.authenticationTargetId,
            authenticationMethodId: record.authenticationMethodId,
            label,
            credentialRef: null,
            profileRef: record.profileRef,
            providerIdentityId: record.providerIdentityId,
            createdAt: record.createdAt,
            updatedAt: now(),
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new ProviderConnectionLoginError({
                  detail: "Could not commit the verified Connection.",
                  cause,
                }),
            ),
            Effect.flatMap(
              Option.match({
                onNone: () =>
                  fail("The verified Connection identity conflicts with durable state."),
                onSome: Effect.succeed,
              }),
            ),
          );
        yield* transition({
          operationId: record.operationId,
          state: "completed",
          providerLoginId: record.providerLoginId,
          providerIdentityId: record.providerIdentityId,
          committedConnectionId: committed.connection.id,
          failureReason: null,
          updatedAt: now(),
        });
        yield* releaseManagedCredentialIdentity(record);
      });

    const transition = (input: Parameters<typeof logins.transition>[0]) =>
      logins.transition(input).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderConnectionLoginError({
              detail: "Could not update Connection sign in.",
              cause,
            }),
        ),
        Effect.flatMap(
          Option.match({
            onNone: () => fail("Connection sign in no longer exists."),
            onSome: Effect.succeed,
          }),
        ),
      );

    const get: ProviderConnectionLoginCoordinatorShape["get"] = ({ operationId }) =>
      Effect.gen(function* () {
        const record = yield* logins.get(operationId).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderConnectionLoginError({
                detail: "Could not read Connection sign in.",
                cause,
              }),
          ),
          Effect.flatMap(
            Option.match({
              onNone: () => fail("Connection sign in does not exist."),
              onSome: Effect.succeed,
            }),
          ),
        );
        const committedConnectionId = record.committedConnectionId ?? record.connectionId;
        const connection = yield* connections.getRecord(committedConnectionId).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderConnectionLoginError({
                detail: "Could not read signed-in Connection.",
                cause,
              }),
          ),
          Effect.map(
            Option.map((entry) => ({
              id: entry.id,
              harness: entry.harness,
              authenticationTargetId: entry.authenticationTargetId,
              authenticationMethodId: entry.authenticationMethodId,
              label: entry.label,
              providerIdentityId: entry.providerIdentityId,
              health: entry.health,
              healthReason: entry.healthReason,
              lastCheckedAt: entry.lastCheckedAt,
              lifecycle: entry.lifecycle,
              terminationReason: entry.terminationReason,
              terminatedAt: entry.terminatedAt,
              createdAt: entry.createdAt,
              updatedAt: entry.updatedAt,
            })),
          ),
        );
        return {
          operationId: record.operationId,
          connectionId: committedConnectionId,
          state: record.state === "verified" ? ("starting" as const) : record.state,
          authUrl: handles.get(record.operationId)?.authUrl ?? null,
          connection: Option.getOrNull(connection),
          failureReason: record.failureReason,
        };
      });

    const begin: ProviderConnectionLoginCoordinatorShape["begin"] = (input) =>
      Effect.gen(function* () {
        const method = findManagedLoginMethod(input);
        if (!method) {
          return yield* fail("This sign-in method is not enabled by the managed adapter.");
        }
        const secretIdentityPrefix =
          method.displayIdentity.kind === "secret-suffix" ? method.displayIdentity.prefix : null;
        const label =
          secretIdentityPrefix !== null
            ? yield* Effect.try({
                try: () =>
                  secretSuffixConnectionLabel({
                    prefix: secretIdentityPrefix,
                    secret: input.secret ?? "",
                  }),
                catch: (cause) =>
                  new ProviderConnectionLoginError({
                    detail:
                      cause instanceof Error
                        ? cause.message
                        : "Could not identify the provider credential.",
                    cause,
                  }),
              })
            : "Pending account email";
        const connectionId = ProviderConnectionId.makeUnsafe(newId());
        const operationId = newId();
        const profileRef = `provider-profile:${connectionId}`;
        const createdAt = now();
        yield* logins
          .begin({
            operationId,
            connectionId,
            harness: input.harness,
            authenticationTargetId: input.authenticationTargetId,
            authenticationMethodId: input.authenticationMethodId,
            label,
            profileRef,
            providerLoginId: null,
            state: "starting",
            providerIdentityId: null,
            failureReason: null,
            createdAt,
            updatedAt: createdAt,
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new ProviderConnectionLoginError({
                  detail: "Could not begin Connection sign in.",
                  cause,
                }),
            ),
          );
        yield* Effect.logInfo("provider.connection_login.started", {
          operationId,
          connectionId,
          harness: input.harness,
          authenticationTargetId: input.authenticationTargetId,
          authenticationMethodId: input.authenticationMethodId,
        });
        return yield* Effect.gen(function* () {
          const runtime = yield* loadManagedRuntime({
            ...input,
            profileRef,
          });
          if (runtime.method.loginMechanism === "secret-import" && !input.secret) {
            return yield* fail("This sign-in method requires a credential.");
          }
          if (runtime.method.loginMechanism === "browser" && input.secret !== undefined) {
            return yield* fail("This sign-in method does not accept a credential.");
          }
          if (runtime.method.loginMechanism === "secret-import") {
            yield* credentials.claim(input.secret!, `provider-secret:${connectionId}`).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderConnectionLoginError({
                    detail: cause.message,
                    cause,
                  }),
              ),
            );
          }
          const stateEnvironment = runtime.stateEnvironment;
          yield* Effect.tryPromise({
            try: async () => {
              await Promise.all(
                [
                  stateEnvironment.overrides.CODEX_HOME,
                  stateEnvironment.overrides.CODEX_SQLITE_HOME,
                  ...Object.values(stateEnvironment.isolation),
                ]
                  .filter((entry): entry is string => typeof entry === "string")
                  .map((entry) => mkdir(entry, { recursive: true, mode: 0o700 })),
              );
              if (input.harness === "codex") {
                await prepareManagedCodexProfileConfig({
                  env: stateEnvironment.overrides,
                  cliAuthCredentialsStore: "keyring",
                });
              }
            },
            catch: (cause) =>
              new ProviderConnectionLoginError({
                detail: "Could not prepare isolated sign in.",
                cause,
              }),
          });
          const handle = yield* Effect.tryPromise({
            try: async () => {
              const processInput = {
                binaryPath: runtime.installed.executablePath,
                cwd: process.cwd(),
                env: runtime.env,
              };
              if (input.harness === "codex" && runtime.method.loginMechanism === "browser") {
                return startLogin(processInput);
              }
              if (input.harness === "codex" && runtime.method.loginMechanism === "secret-import") {
                const imported = startApiKeyImport({
                  ...processInput,
                  secret: input.secret!,
                });
                return {
                  loginId: `codex-api-key-${operationId}`,
                  authUrl: null,
                  completion: imported.completion,
                  cancel: imported.cancel,
                };
              }
              if (input.harness === "claudeAgent" && runtime.method.loginMechanism === "browser") {
                return startClaudeManagedAccountLogin(processInput);
              }
              throw new Error("This managed sign-in method is unavailable.");
            },
            catch: (cause) =>
              new ProviderConnectionLoginError({
                detail: "Could not start provider sign in.",
                cause,
              }),
          });
          handles.set(operationId, { authUrl: handle.authUrl, handle });
          yield* transition({
            operationId,
            state: "awaiting-user",
            providerLoginId: handle.loginId,
            providerIdentityId: null,
            failureReason: null,
            updatedAt: now(),
          });
          yield* Effect.logInfo("provider.connection_login.awaiting_user", {
            operationId,
            connectionId,
            harness: input.harness,
            providerLoginId: handle.loginId,
          });
          void handle.completion.then(
            async (snapshot) => {
              try {
                if (cancellationRequests.has(operationId)) return;
                const providerIdentityId =
                  runtime.method.loginMechanism === "secret-import"
                    ? `api-key:hmac-sha256:${await Effect.runPromise(
                        credentials.fingerprint(input.secret!),
                      )}`
                    : providerIdentityFromSnapshot(snapshot);
                await Effect.runPromise(
                  Effect.logInfo("provider.connection_login.provider_verified", {
                    operationId,
                    connectionId,
                    harness: input.harness,
                    providerLoginId: handle.loginId,
                    providerIdentityId,
                  }),
                );
                await Effect.runPromise(
                  transition({
                    operationId,
                    state: "verified",
                    providerLoginId: handle.loginId,
                    providerIdentityId,
                    failureReason: null,
                    updatedAt: now(),
                  }),
                );
                if (cancellationRequests.has(operationId)) return;
                await Effect.runPromise(
                  commitVerified({
                    operationId,
                    connectionId,
                    harness: input.harness,
                    authenticationTargetId: input.authenticationTargetId,
                    authenticationMethodId: input.authenticationMethodId,
                    label,
                    profileRef,
                    providerLoginId: handle.loginId,
                    providerIdentityId,
                    createdAt,
                  }),
                );
                await Effect.runPromise(
                  Effect.logInfo("provider.connection_login.committed", {
                    operationId,
                    connectionId,
                    harness: input.harness,
                    providerLoginId: handle.loginId,
                    providerIdentityId,
                  }),
                );
              } catch (cause) {
                if (cancellationRequests.has(operationId)) return;
                let failureReason =
                  cause instanceof Error ? cause.message : "Connection sign in failed.";
                await Effect.runPromise(
                  Effect.logWarning("provider.connection_login.commit_failed", {
                    operationId,
                    connectionId,
                    harness: input.harness,
                    providerLoginId: handle.loginId,
                    failureReason,
                  }),
                );
                try {
                  await Effect.runPromise(
                    cleanupUncommittedProfile({
                      connectionId,
                      harness: input.harness,
                      authenticationTargetId: input.authenticationTargetId,
                      authenticationMethodId: input.authenticationMethodId,
                      profileRef,
                    }),
                  );
                } catch (cleanupCause) {
                  failureReason = `${failureReason} The isolated profile could not be cleaned: ${
                    cleanupCause instanceof Error ? cleanupCause.message : String(cleanupCause)
                  }`;
                }
                await Effect.runPromise(
                  transition({
                    operationId,
                    state: "failed",
                    providerLoginId: handle.loginId,
                    providerIdentityId: null,
                    failureReason,
                    updatedAt: now(),
                  }).pipe(Effect.ignore),
                );
              } finally {
                handles.delete(operationId);
              }
            },
            async (cause) => {
              if (cancellationRequests.has(operationId)) return;
              const failureReason =
                cause instanceof Error ? cause.message : "Connection sign in failed.";
              await Effect.runPromise(
                Effect.logWarning("provider.connection_login.provider_failed", {
                  operationId,
                  connectionId,
                  harness: input.harness,
                  providerLoginId: handle.loginId,
                  failureReason,
                }),
              );
              await Effect.runPromise(
                cleanupUncommittedProfile({
                  connectionId,
                  harness: input.harness,
                  authenticationTargetId: input.authenticationTargetId,
                  authenticationMethodId: input.authenticationMethodId,
                  profileRef,
                }).pipe(Effect.ignore),
              );
              await Effect.runPromise(
                transition({
                  operationId,
                  state: "failed",
                  providerLoginId: handle.loginId,
                  providerIdentityId: null,
                  failureReason,
                  updatedAt: now(),
                }).pipe(Effect.ignore),
              );
              handles.delete(operationId);
            },
          );
          return yield* get({ operationId });
        }).pipe(
          Effect.catch((cause) =>
            Effect.gen(function* () {
              const active = handles.get(operationId);
              if (active) {
                cancellationRequests.add(operationId);
                yield* Effect.tryPromise({
                  try: () => active.handle.cancel(),
                  catch: (cause) => cause,
                }).pipe(Effect.ignore);
                handles.delete(operationId);
              }
              yield* cleanupUncommittedProfile({
                ...input,
                connectionId,
                profileRef,
              }).pipe(Effect.ignore);
              yield* transition({
                operationId,
                state: "failed",
                providerLoginId: active?.handle.loginId ?? null,
                providerIdentityId: null,
                failureReason: cause.message,
                updatedAt: now(),
              }).pipe(Effect.ignore);
              return yield* Effect.fail(cause);
            }),
          ),
        );
      }).pipe(
        Effect.mapError((cause) =>
          asLoginError("Could not complete the managed Connection sign in.", cause),
        ),
      );

    const cancel: ProviderConnectionLoginCoordinatorShape["cancel"] = ({ operationId }) =>
      Effect.gen(function* () {
        cancellationRequests.add(operationId);
        const active = handles.get(operationId);
        if (active)
          yield* Effect.tryPromise({
            try: () => active.handle.cancel(),
            catch: (cause) => cause,
          }).pipe(Effect.ignore);
        handles.delete(operationId);
        const record = yield* logins.get(operationId).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderConnectionLoginError({
                detail: "Could not cancel Connection sign in.",
                cause,
              }),
          ),
          Effect.flatMap(
            Option.match({
              onNone: () => fail("Connection sign in does not exist."),
              onSome: Effect.succeed,
            }),
          ),
        );
        if (record.state === "completed" || record.state === "cancelled")
          return yield* get({ operationId });
        const runtime = yield* loadManagedRuntime(record);
        yield* Effect.tryPromise({
          try: () =>
            logoutManagedAccount({
              harness: record.harness,
              binaryPath: runtime.installed.executablePath,
              env: runtime.env,
            }),
          catch: (cause) =>
            new ProviderConnectionLoginError({
              detail: "The provider could not cancel the isolated sign in.",
              cause,
            }),
        });
        const account = yield* Effect.tryPromise({
          try: () =>
            probeManagedAccount({
              harness: record.harness,
              authenticationMethodId: record.authenticationMethodId,
              binaryPath: runtime.installed.executablePath,
              env: runtime.env,
            }),
          catch: (cause) =>
            new ProviderConnectionLoginError({
              detail: "The cancelled provider profile could not be verified.",
              cause,
            }),
        });
        if (account !== null)
          return yield* fail("The cancelled provider profile is still signed in.");
        const retiredAt = now();
        yield* connections.retireManagedProfile({ profileRef: record.profileRef, retiredAt });
        const profileRoot = providerCredentialProfileRoot(config.stateDir, record.profileRef);
        if (profileRoot !== null) {
          yield* Effect.tryPromise(() => rm(profileRoot, { recursive: true, force: true }));
          yield* connections.markManagedProfileRemoved({
            profileRef: record.profileRef,
            removedAt: now(),
          });
        }
        yield* transition({
          operationId,
          state: record.state === "verified" ? "failed" : "cancelled",
          providerLoginId: record.providerLoginId,
          providerIdentityId: null,
          failureReason:
            record.state === "verified"
              ? "Connection sign in was cancelled after provider verification."
              : null,
          updatedAt: now(),
        });
        yield* releaseManagedCredentialIdentity(record).pipe(Effect.ignore);
        return yield* get({ operationId });
      }).pipe(
        Effect.mapError((cause) => asLoginError("Could not cancel Connection sign in.", cause)),
      );

    const terminateProfile: ProviderConnectionLoginCoordinatorShape["terminateProfile"] = (input) =>
      Effect.gen(function* () {
        const record = yield* connections.getRecord(input.connectionId).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderConnectionLoginError({
                detail: "Could not read the Connection.",
                cause,
              }),
          ),
          Effect.flatMap(
            Option.match({
              onNone: () => fail("The Connection does not exist."),
              onSome: Effect.succeed,
            }),
          ),
        );
        if (record.credentialRef !== null || record.profileRef === null) {
          return yield* fail("This is not a managed account Connection.");
        }
        const runtime = yield* loadManagedRuntime({
          ...record,
          profileRef: record.profileRef,
        });
        yield* Effect.tryPromise({
          try: () =>
            logoutManagedAccount({
              harness: record.harness,
              binaryPath: runtime.installed.executablePath,
              env: runtime.env,
            }),
          catch: (cause) =>
            new ProviderConnectionLoginError({
              detail: "The provider could not disconnect this account.",
              cause,
            }),
        });
        const account = yield* Effect.tryPromise({
          try: () =>
            probeManagedAccount({
              harness: record.harness,
              authenticationMethodId: record.authenticationMethodId,
              binaryPath: runtime.installed.executablePath,
              env: runtime.env,
            }),
          catch: (cause) =>
            new ProviderConnectionLoginError({
              detail: "The disconnected provider profile could not be verified.",
              cause,
            }),
        });
        if (account !== null) return yield* fail("The provider profile is still signed in.");
        const terminated = yield* connections
          .terminate({
            id: record.id,
            reason: input.reason,
            terminatedAt: now(),
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new ProviderConnectionLoginError({
                  detail: "Could not commit Connection disconnection.",
                  cause,
                }),
            ),
            Effect.flatMap(
              Option.match({
                onNone: () => fail("Connection disconnection did not commit."),
                onSome: Effect.succeed,
              }),
            ),
          );
        yield* releaseManagedCredentialIdentity({
          ...record,
          connectionId: record.id,
        });
        const retiredAt = now();
        yield* connections.retireManagedProfile({ profileRef: record.profileRef, retiredAt });
        const profileRoot = providerCredentialProfileRoot(config.stateDir, record.profileRef);
        if (profileRoot !== null) {
          yield* Effect.tryPromise(() => rm(profileRoot, { recursive: true, force: true }));
          yield* connections.markManagedProfileRemoved({
            profileRef: record.profileRef,
            removedAt: now(),
          });
        }
        return terminated;
      }).pipe(
        Effect.mapError((cause) => asLoginError("Could not disconnect the Connection.", cause)),
      );

    const reconcileActiveManagedConnections = Effect.gen(function* () {
      const activeConnections = yield* connections.list().pipe(
        Effect.mapError(
          (cause) =>
            new ProviderConnectionLoginError({
              detail: "Could not inspect active Connections during recovery.",
              cause,
            }),
        ),
      );
      yield* Effect.forEach(
        activeConnections,
        (connection) =>
          connections.getRecord(connection.id).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderConnectionLoginError({
                  detail: "Could not inspect a managed Connection during recovery.",
                  cause,
                }),
            ),
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.void,
                onSome: (record) => {
                  if (
                    record.lifecycle !== "active" ||
                    record.credentialRef !== null ||
                    record.profileRef === null
                  ) {
                    return Effect.void;
                  }
                  const profileRef = record.profileRef;
                  return Effect.gen(function* () {
                    const runtime = yield* loadManagedRuntime({
                      ...record,
                      profileRef,
                    });
                    const account = yield* Effect.tryPromise({
                      try: () =>
                        probeManagedAccount({
                          harness: record.harness,
                          authenticationMethodId: record.authenticationMethodId,
                          binaryPath: runtime.installed.executablePath,
                          env: runtime.env,
                        }),
                      catch: (cause) =>
                        new ProviderConnectionLoginError({
                          detail: "Could not verify a managed Connection during recovery.",
                          cause,
                        }),
                    });
                    if (account !== null) {
                      const method = findManagedLoginMethod(record);
                      if (method?.displayIdentity.kind === "account-email") {
                        const providerIdentityId = providerIdentityFromSnapshot(account);
                        if (providerIdentityId === null) {
                          return yield* fail(
                            "The provider did not return the account email for this Connection.",
                          );
                        }
                        const label = yield* Effect.try({
                          try: () => accountEmailConnectionLabel(providerIdentityId),
                          catch: (cause) =>
                            new ProviderConnectionLoginError({
                              detail:
                                cause instanceof Error
                                  ? cause.message
                                  : "Could not identify the recovered provider account.",
                              cause,
                            }),
                        });
                        if (record.providerIdentityId === null) {
                          yield* connections
                            .identifyManaged({
                              id: record.id,
                              label,
                              providerIdentityId,
                              updatedAt: now(),
                            })
                            .pipe(
                              Effect.mapError(
                                (cause) =>
                                  new ProviderConnectionLoginError({
                                    detail: "Could not migrate the recovered Connection identity.",
                                    cause,
                                  }),
                              ),
                              Effect.flatMap(
                                Option.match({
                                  onNone: () =>
                                    fail("The recovered Connection identity did not commit."),
                                  onSome: Effect.succeed,
                                }),
                              ),
                            );
                        } else if (record.label !== record.providerIdentityId) {
                          yield* connections
                            .rename({
                              id: record.id,
                              label: accountEmailConnectionLabel(record.providerIdentityId),
                              updatedAt: now(),
                            })
                            .pipe(
                              Effect.mapError(
                                (cause) =>
                                  new ProviderConnectionLoginError({
                                    detail: "Could not migrate the recovered Connection label.",
                                    cause,
                                  }),
                              ),
                              Effect.flatMap(
                                Option.match({
                                  onNone: () =>
                                    fail("The recovered Connection label did not commit."),
                                  onSome: Effect.succeed,
                                }),
                              ),
                            );
                        }
                      }
                      return;
                    }
                    yield* connections
                      .terminate({
                        id: record.id,
                        reason: "signed-out",
                        terminatedAt: now(),
                      })
                      .pipe(
                        Effect.mapError(
                          (cause) =>
                            new ProviderConnectionLoginError({
                              detail: "Could not commit a recovered provider sign-out.",
                              cause,
                            }),
                        ),
                        Effect.flatMap(
                          Option.match({
                            onNone: () => fail("The recovered provider sign-out did not commit."),
                            onSome: Effect.succeed,
                          }),
                        ),
                      );
                    yield* releaseManagedCredentialIdentity({
                      ...record,
                      connectionId: record.id,
                    });
                    yield* connections.retireManagedProfile({
                      profileRef,
                      retiredAt: now(),
                    });
                  });
                },
              }),
            ),
          ),
        { concurrency: 1 },
      );
    });

    const cleanupManagedProfiles = connections.listManagedProfilesPendingCleanup().pipe(
      Effect.flatMap((profiles) =>
        Effect.forEach(
          profiles,
          (profile) =>
            Effect.gen(function* () {
              if (profile.lifecycle !== "retired") {
                yield* connections.retireManagedProfile({
                  profileRef: profile.profileRef,
                  retiredAt: now(),
                });
              }
              const profileRoot = providerCredentialProfileRoot(
                config.stateDir,
                profile.profileRef,
              );
              if (profileRoot === null)
                return yield* fail("The retired profile reference is invalid.");
              const profileExists = yield* Effect.tryPromise(async () => {
                try {
                  await stat(profileRoot);
                  return true;
                } catch (cause) {
                  if (
                    typeof cause === "object" &&
                    cause !== null &&
                    "code" in cause &&
                    cause.code === "ENOENT"
                  )
                    return false;
                  throw cause;
                }
              });
              if (!profileExists) {
                yield* connections.markManagedProfileRemoved({
                  profileRef: profile.profileRef,
                  removedAt: now(),
                });
                return;
              }
              const runtime = yield* loadManagedRuntime({
                harness: profile.harness,
                authenticationTargetId: profile.authenticationTargetId,
                authenticationMethodId: profile.authenticationMethodId,
                profileRef: profile.profileRef,
              });
              yield* Effect.tryPromise(() =>
                logoutManagedAccount({
                  harness: profile.harness,
                  binaryPath: runtime.installed.executablePath,
                  env: runtime.env,
                }),
              );
              const account = yield* Effect.tryPromise(() =>
                probeManagedAccount({
                  harness: profile.harness,
                  authenticationMethodId: profile.authenticationMethodId,
                  binaryPath: runtime.installed.executablePath,
                  env: runtime.env,
                }),
              );
              if (account !== null)
                return yield* fail("The retired provider profile is signed in.");
              yield* Effect.tryPromise(() => rm(profileRoot, { recursive: true, force: true }));
              yield* connections.markManagedProfileRemoved({
                profileRef: profile.profileRef,
                removedAt: now(),
              });
            }).pipe(
              Effect.catch((cause) =>
                Effect.logWarning("provider.connection_profile.cleanup_failed", {
                  profileRef: profile.profileRef,
                  harness: profile.harness,
                  cause: cause instanceof Error ? cause.message : String(cause),
                }),
              ),
            ),
          { concurrency: 1 },
        ),
      ),
      Effect.asVoid,
    );

    return {
      begin,
      get,
      cancel,
      terminateProfile,
      recover: logins.listOpen().pipe(
        Effect.mapError(
          (cause) =>
            new ProviderConnectionLoginError({
              detail: "Could not recover Connection sign in.",
              cause,
            }),
        ),
        Effect.flatMap((records) =>
          Effect.forEach(
            records,
            (record) =>
              record.state === "verified"
                ? commitVerified(record)
                : Effect.gen(function* () {
                    const runtime = yield* loadManagedRuntime(record);
                    const probeResult = yield* Effect.tryPromise({
                      try: () =>
                        probeManagedAccount({
                          harness: record.harness,
                          authenticationMethodId: record.authenticationMethodId,
                          binaryPath: runtime.installed.executablePath,
                          env: runtime.env,
                        }),
                      catch: (cause) =>
                        new ProviderConnectionLoginError({
                          detail: "The isolated provider profile could not be verified.",
                          cause,
                        }),
                    }).pipe(
                      Effect.map((account) => ({ account })),
                      Effect.catch(() =>
                        transition({
                          operationId: record.operationId,
                          state: "failed",
                          providerLoginId: record.providerLoginId,
                          providerIdentityId: null,
                          failureReason: "The isolated provider profile could not be verified.",
                          updatedAt: now(),
                        }).pipe(Effect.as(null)),
                      ),
                    );
                    if (probeResult === null) {
                      yield* releaseManagedCredentialIdentity(record);
                      return;
                    }
                    const { account } = probeResult;
                    if (account === null) {
                      yield* transition({
                        operationId: record.operationId,
                        state: "failed",
                        providerLoginId: record.providerLoginId,
                        providerIdentityId: null,
                        failureReason: "The isolated provider profile is not signed in.",
                        updatedAt: now(),
                      });
                      yield* releaseManagedCredentialIdentity(record);
                      return;
                    }
                    const providerIdentityId = providerIdentityFromSnapshot(account);
                    const awaiting =
                      record.state === "starting"
                        ? yield* transition({
                            operationId: record.operationId,
                            state: "awaiting-user",
                            providerLoginId: record.providerLoginId,
                            providerIdentityId,
                            failureReason: null,
                            updatedAt: now(),
                          })
                        : record;
                    const verified = yield* transition({
                      operationId: record.operationId,
                      state: "verified",
                      providerLoginId: awaiting.providerLoginId,
                      providerIdentityId,
                      failureReason: null,
                      updatedAt: now(),
                    });
                    yield* commitVerified(verified);
                  }),
            { concurrency: 1 },
          ),
        ),
        Effect.andThen(reconcileActiveManagedConnections),
        Effect.andThen(cleanupManagedProfiles),
        Effect.asVoid,
        Effect.mapError((cause) => asLoginError("Could not recover managed Connections.", cause)),
      ),
    };
  });
}

export const ProviderConnectionLoginCoordinatorLive = Layer.effect(
  ProviderConnectionLoginCoordinator,
  makeProviderConnectionLoginCoordinator(),
);
