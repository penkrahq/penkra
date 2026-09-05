// FILE: ProviderLaunchResolver.ts
// Purpose: Fail-closed launch resolution with selected-only credentials and deterministic isolation.

import { mkdir } from "node:fs/promises";
import { Effect, Layer, Option } from "effect";

import { ServerConfig } from "../../config.ts";
import { prepareManagedCodexProfileConfig } from "../../codexProcessEnv.ts";
import { ProviderConnectionRepository } from "../../persistence/Services/ProviderConnections.ts";
import { ProviderInstallationRepository } from "../../persistence/Services/ProviderInstallations.ts";
import { ThreadProviderBindingRepository } from "../../persistence/Services/ThreadProviderBindings.ts";
import { buildProviderChildEnvironment } from "../../providerChildEnvironment.ts";
import { ProviderCredentialBroker } from "../providerCredentialBroker.ts";
import {
  resolveClaudeSessionCandidate,
  synchronizeClaudeSession,
} from "../claudeManagedNativeState.ts";
import {
  providerConnectionProfileRoot,
  providerCredentialProfileIdentity,
  providerNativeStateRoot,
  providerOpaquePathKey,
} from "../providerNativeStatePaths.ts";
import {
  findStaticCredentialMethod,
  findManagedLoginMethod,
  getProviderConnectionManifest,
} from "../providerConnectionManifests.ts";
import {
  ProviderLaunchResolutionError,
  ProviderLaunchResolver,
  type ProviderLaunchResolverShape,
} from "../Services/ProviderLaunchResolver.ts";

const fail = (detail: string, cause?: unknown) =>
  Effect.fail(
    new ProviderLaunchResolutionError({
      detail,
      ...(cause === undefined ? {} : { cause }),
    }),
  );

export const makeProviderLaunchResolver = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const connections = yield* ProviderConnectionRepository;
  const installations = yield* ProviderInstallationRepository;
  const threads = yield* ThreadProviderBindingRepository;
  const credentials = yield* ProviderCredentialBroker;

  const resolveProfile: ProviderLaunchResolverShape["resolveProfile"] = (input) =>
    Effect.gen(function* () {
      const manifest = getProviderConnectionManifest(input.harness);
      if (!manifest) return yield* fail("The thread harness has no enabled managed adapter.");

      const installation = yield* installations.getRecord(input.installationId).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderLaunchResolutionError({
              detail: "Could not read the managed installation.",
              cause,
            }),
        ),
      );
      if (
        Option.isNone(installation) ||
        installation.value.harness !== input.harness ||
        (installation.value.lifecycle !== "active" &&
          !(input.allowRetiredInstallation === true && installation.value.lifecycle === "retired"))
      ) {
        return yield* fail("The selected managed installation is not active for this harness.");
      }

      let credentialEnvironment: NodeJS.ProcessEnv = {};
      let profileIdentity: string = input.connectionId ?? `anonymous:${input.harness}`;
      if (input.connectionId === null) {
        if (!manifest.anonymous?.authorizesInternalProvider(input.internalProviderId)) {
          return yield* fail("The selected route requires a Connection.");
        }
      } else {
        const connection = yield* connections.getRecord(input.connectionId).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderLaunchResolutionError({
                detail: "Could not read the selected Connection.",
                cause,
              }),
          ),
        );
        if (
          Option.isNone(connection) ||
          connection.value.lifecycle !== "active" ||
          connection.value.harness !== input.harness
        ) {
          return yield* fail("The selected Connection is not active for this harness.");
        }
        const staticMethod = findStaticCredentialMethod({
          harness: connection.value.harness,
          authenticationTargetId: connection.value.authenticationTargetId,
          authenticationMethodId: connection.value.authenticationMethodId,
        });
        const managedMethod = findManagedLoginMethod({
          harness: connection.value.harness,
          authenticationTargetId: connection.value.authenticationTargetId,
          authenticationMethodId: connection.value.authenticationMethodId,
        });
        const method = staticMethod ?? managedMethod;
        if (!method || !method.authorizesInternalProvider(input.internalProviderId)) {
          return yield* fail("The selected Connection cannot authorize this route.");
        }
        if (staticMethod) {
          if (!connection.value.credentialRef || connection.value.profileRef) {
            return yield* fail("The selected Connection credential backend is incompatible.");
          }
          const secret = yield* credentials.readOnce(connection.value.credentialRef).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderLaunchResolutionError({
                  detail: "The selected Connection credential is unavailable.",
                  cause,
                }),
            ),
          );
          credentialEnvironment = staticMethod.buildCredentialEnvironment(secret);
        } else {
          const profileRef = connection.value.profileRef;
          const managedProfileIdentity =
            profileRef === null ? null : providerCredentialProfileIdentity(profileRef);
          if (connection.value.credentialRef !== null || managedProfileIdentity === null) {
            return yield* fail("The selected Connection profile is incompatible.");
          }
          profileIdentity = managedProfileIdentity;
        }
      }

      const profileRoot = providerConnectionProfileRoot(config.stateDir, profileIdentity);
      const nativeStateRoot = providerNativeStateRoot(config.stateDir, input.nativeStateIdentity);
      const environment = manifest.buildStateEnvironment({
        profileRoot,
        nativeStateRoot,
      });
      yield* Effect.tryPromise({
        try: async () => {
          await Promise.all(
            [
              profileRoot,
              nativeStateRoot,
              environment.isolation.homePath,
              environment.isolation.xdgConfigHome,
              environment.isolation.xdgDataHome,
              environment.isolation.xdgCacheHome,
              environment.isolation.xdgStateHome,
            ].map((path) => mkdir(path, { recursive: true, mode: 0o700 })),
          );
          if (input.harness === "codex") {
            await prepareManagedCodexProfileConfig({
              env: environment.overrides,
              cliAuthCredentialsStore: "keyring",
            });
          }
        },
        catch: (cause) =>
          new ProviderLaunchResolutionError({
            detail: "Could not prepare the isolated provider runtime directories.",
            cause,
          }),
      });

      return {
        binaryPath: installation.value.executablePath,
        profileRoot,
        nativeStateRoot,
        isolationKey: providerOpaquePathKey(
          `${installation.value.id}:${profileIdentity}:${input.nativeStateIdentity}`,
        ),
        connectionId: input.connectionId,
        installationId: input.installationId,
        childEnvironment: (baseEnv, overrides) =>
          buildProviderChildEnvironment({
            provider: manifest.childKind,
            baseEnv,
            managedConnection: true,
            isolation: environment.isolation,
            ...(manifest.preserveOsHome === undefined
              ? {}
              : { preserveOsHome: manifest.preserveOsHome }),
            overrides: { ...environment.overrides, ...overrides },
            credentialOverrides: credentialEnvironment,
          }),
      };
    });

  const resolve: ProviderLaunchResolverShape["resolve"] = (input) =>
    Effect.gen(function* () {
      const state = yield* threads.getHarnessState(input.threadId).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderLaunchResolutionError({
              detail: "Could not read thread native state.",
              cause,
            }),
        ),
      );
      if (Option.isNone(state))
        return yield* fail("The thread has not started a provider harness.");
      const nativeStateGenerationId =
        input.nativeStateGenerationId ?? state.value.nativeStateGenerationId;
      const launch = yield* resolveProfile({
        harness: state.value.harness,
        connectionId: input.connectionId,
        installationId: input.installationId,
        internalProviderId: input.internalProviderId,
        nativeStateIdentity: nativeStateGenerationId,
        allowRetiredInstallation: true,
      });
      if (
        state.value.harness === "claudeAgent" &&
        state.value.providerSessionId !== null &&
        input.connectionId !== null
      ) {
        const profiles = yield* connections
          .listManagedProfilesForConnection(input.connectionId)
          .pipe(
            Effect.mapError(
              (cause) =>
                new ProviderLaunchResolutionError({
                  detail: "Could not inspect Claude credential-profile lineage.",
                  cause,
                }),
            ),
          );
        const lineageRoots = [
          launch.profileRoot,
          ...profiles.flatMap((profile) => {
            const identity = providerCredentialProfileIdentity(profile.profileRef);
            return identity === null
              ? []
              : [providerConnectionProfileRoot(config.stateDir, identity)];
          }),
        ].filter((root, index, roots) => roots.indexOf(root) === index);
        const reconciliation = yield* Effect.tryPromise({
          try: async () => {
            const source = await resolveClaudeSessionCandidate({
              profileRoots: lineageRoots,
              providerSessionId: state.value.providerSessionId!,
            });
            const outcome = await synchronizeClaudeSession({
              sourceProfileRoot: source.profileRoot,
              targetProfileRoot: launch.profileRoot,
              providerSessionId: state.value.providerSessionId!,
            });
            return { sourceProfileRoot: source.profileRoot, outcome };
          },
          catch: (cause) =>
            new ProviderLaunchResolutionError({
              detail: "Could not prepare the exact Claude conversation for resume.",
              cause,
            }),
        });
        yield* Effect.logInfo("provider.claude_native_state.resume_prepared", {
          threadId: input.threadId,
          providerSessionId: state.value.providerSessionId,
          sourceWasActiveProfile: reconciliation.sourceProfileRoot === launch.profileRoot,
          inspectedProfileCount: lineageRoots.length,
          outcome: reconciliation.outcome,
        });
      }
      return launch;
    });

  return { resolve, resolveProfile } satisfies ProviderLaunchResolverShape;
});

export const ProviderLaunchResolverLive = Layer.effect(
  ProviderLaunchResolver,
  makeProviderLaunchResolver,
);
