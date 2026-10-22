import { ProviderInstallationId, type ServerSettings } from "@penkra/contracts";
import { Effect, FileSystem, Path } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import type { ProviderInstallationRepositoryShape } from "../persistence/Services/ProviderInstallations.ts";
import {
  installManagedProviderArtifact,
  readManagedProviderGenerationManifest,
  type ManagedProviderArtifactInstallInput,
  type ManagedProviderArtifactInstallResult,
} from "./managedProviderArtifactInstaller.ts";
import { deactivateManagedProviderRuntimeInstallation } from "./managedProviderRuntime.ts";
import {
  PINNED_PROVIDER_KINDS,
  PINNED_PROVIDER_RUNTIMES,
  pinnedProviderArtifact,
  type PinnedProviderKind,
} from "./pinnedProviderRuntimes.ts";

/** Startup only: no scheduler, latest-version lookup, or runtime stop callback. */
export function ensurePinnedProviderRuntimes(input: {
  readonly stateDir: string;
  readonly settings: ServerSettings;
  readonly hasActiveProviderSession: (
    provider: PinnedProviderKind,
  ) => Effect.Effect<boolean, unknown>;
  readonly installations: Pick<ProviderInstallationRepositoryShape, "activate">;
  readonly install?: (
    input: ManagedProviderArtifactInstallInput,
  ) => Effect.Effect<
    ManagedProviderArtifactInstallResult,
    unknown,
    FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
  >;
  readonly deactivate?: typeof deactivateManagedProviderRuntimeInstallation;
  readonly readManifest?: typeof readManagedProviderGenerationManifest;
}) {
  return Effect.gen(function* () {
    for (const provider of PINNED_PROVIDER_KINDS) {
      if (!input.settings.providers[provider].enabled) continue;
      const release = PINNED_PROVIDER_RUNTIMES.providers[provider];
      if (yield* input.hasActiveProviderSession(provider)) {
        yield* Effect.logInfo("pinned provider activation deferred", {
          provider,
          version: release.version,
          reason: "active-thread",
        });
        continue;
      }
      const artifact = pinnedProviderArtifact(provider);
      const installedAt = new Date().toISOString();
      const installed = yield* (input.install ?? installManagedProviderArtifact)({
        stateDir: input.stateDir,
        artifact,
        adapterVersion: release.adapterVersion,
        protocolVersion: release.protocolVersion,
        installedAt,
      });
      const manifest = yield* (input.readManifest ?? readManagedProviderGenerationManifest)({
        stateDir: input.stateDir,
        provider,
        version: release.version,
      });
      if (!manifest || manifest.installationId !== installed.installationId) {
        return yield* Effect.fail(
          new Error(`Verified generation manifest missing for ${provider} ${release.version}.`),
        );
      }
      yield* input.installations
        .activate({
          id: ProviderInstallationId.makeUnsafe(installed.installationId),
          harness: provider,
          version: release.version,
          platform: artifact.platform,
          architecture: artifact.architecture,
          executablePath: installed.binaryPath,
          artifactSource: artifact.source,
          artifactUrl: artifact.url,
          artifactSha256: artifact.sha256,
          adapterVersion: release.adapterVersion,
          protocolVersion: release.protocolVersion,
          installedAt: manifest.installedAt,
          activatedAt: new Date().toISOString(),
        })
        .pipe(
          Effect.tapError(() =>
            (input.deactivate ?? deactivateManagedProviderRuntimeInstallation)({
              stateDir: input.stateDir,
              provider,
              installationId: installed.installationId,
            }).pipe(Effect.ignore),
          ),
        );
      yield* Effect.logInfo("pinned provider runtime ready", {
        provider,
        version: release.version,
        installationId: installed.installationId,
        reused: installed.reused,
      });
    }
  });
}
