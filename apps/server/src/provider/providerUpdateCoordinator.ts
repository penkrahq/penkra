/**
 * Server-owned provider update policy and scheduling.
 *
 * Version discovery remains ProviderHealth's responsibility. This coordinator
 * decides when an allowlisted update may run, keeps active sessions safe, and
 * records a bounded durable audit trail. The installer boundary is deliberately
 * narrow so managed, versioned runtimes can replace external package-manager
 * updates without changing Settings or notification behavior.
 */
import type {
  OrchestrationThreadShell,
  ProviderKind,
  ServerSettings,
  ServerProviderStatus,
} from "@penkra/contracts";
import { ProviderInstallationId } from "@penkra/contracts";
import {
  Cause,
  Duration,
  Effect,
  FileSystem,
  Option,
  Path,
  Result,
  Schedule,
  Semaphore,
  Stream,
} from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import { writeFileStringAtomically } from "../atomicWrite";
import type { ServerConfigShape } from "../config";
import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery";
import type { ServerSettingsShape } from "../serverSettings";
import type { ProviderHealthShape } from "./Services/ProviderHealth";
import type { ProviderInstallationRepositoryShape } from "../persistence/Services/ProviderInstallations";
import {
  resolveManagedProviderArtifact,
  type ManagedProviderArtifact,
} from "./managedProviderArtifact";
import {
  installManagedProviderArtifact,
  readManagedProviderGenerationManifest,
  type ManagedProviderArtifactInstallInput,
  type ManagedProviderArtifactInstallResult,
  type ManagedProviderGenerationManifest,
} from "./managedProviderArtifactInstaller";
import {
  deactivateManagedProviderRuntimeInstallation,
  resolveProviderBinary,
  type ResolvedProviderBinary,
} from "./managedProviderRuntime";
import { compareSemverVersions } from "./providerVersion";

export const PROVIDER_UPDATE_INTERVAL = Duration.hours(1);
const PROVIDER_UPDATE_HISTORY_LIMIT = 100;

const MANAGED_PROVIDER_ADAPTER_RELEASES = {
  codex: { adapterVersion: "1", protocolVersion: "codex-app-server-v2" },
  claudeAgent: { adapterVersion: "1", protocolVersion: "claude-agent-sdk-0.3" },
  opencode: { adapterVersion: "1", protocolVersion: "opencode-http-v1" },
} as const satisfies Partial<
  Record<ProviderKind, { readonly adapterVersion: string; readonly protocolVersion: string }>
>;

const MANAGED_PROVIDER_KINDS = Object.keys(MANAGED_PROVIDER_ADAPTER_RELEASES) as ReadonlyArray<
  keyof typeof MANAGED_PROVIDER_ADAPTER_RELEASES
>;

function isManagedProviderKind(
  provider: ProviderKind,
): provider is keyof typeof MANAGED_PROVIDER_ADAPTER_RELEASES {
  return MANAGED_PROVIDER_KINDS.includes(
    provider as keyof typeof MANAGED_PROVIDER_ADAPTER_RELEASES,
  );
}

function isManagedProviderEnabled(
  settings: ServerSettings,
  provider: keyof typeof MANAGED_PROVIDER_ADAPTER_RELEASES,
): boolean {
  switch (provider) {
    case "codex":
      return settings.providers.codex.enabled;
    case "claudeAgent":
      return settings.providers.claudeAgent.enabled;
    case "opencode":
      return settings.providers.opencode.enabled;
  }
}

type ProviderUpdateHistoryStatus = "succeeded" | "failed" | "unchanged";

interface ProviderUpdateHistoryEntry {
  readonly provider: ProviderKind;
  readonly fromVersion: string | null;
  readonly targetVersion: string | null;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly status: ProviderUpdateHistoryStatus;
  readonly message: string;
}

export function isProviderUpdateBlockedByActiveThread(
  provider: ProviderKind,
  thread: OrchestrationThreadShell,
): boolean {
  if (thread.modelSelection.provider !== provider || thread.session === null) {
    return false;
  }
  return (
    thread.session.activeTurnId !== null ||
    thread.session.status === "starting" ||
    thread.session.status === "running"
  );
}

export function hasActiveProviderThread(
  provider: ProviderKind,
  threads: ReadonlyArray<OrchestrationThreadShell>,
): boolean {
  return threads.some((thread) => isProviderUpdateBlockedByActiveThread(provider, thread));
}

function isAutomaticUpdateCandidate(status: ServerProviderStatus): boolean {
  const advisory = status.versionAdvisory;
  return (
    advisory?.status === "behind_latest" &&
    advisory.latestVersion !== null &&
    status.updateState?.status !== "queued" &&
    status.updateState?.status !== "running"
  );
}

function historyPath(stateDir: string): string {
  return `${stateDir}/provider-update-history.json`;
}

function appendHistoryEntry(stateDir: string, entry: ProviderUpdateHistoryEntry) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const filePath = historyPath(stateDir);
    const current = yield* fs.readFileString(filePath).pipe(
      Effect.map((raw) => {
        try {
          const parsed = JSON.parse(raw) as unknown;
          return Array.isArray(parsed) ? parsed : [];
        } catch {
          return [];
        }
      }),
      Effect.orElseSucceed(() => [] as unknown[]),
    );
    const next = [...current, entry].slice(-PROVIDER_UPDATE_HISTORY_LIMIT);
    yield* writeFileStringAtomically({
      filePath,
      contents: `${JSON.stringify(next, null, 2)}\n`,
    });
  });
}

type ManagedProviderCoordinatorInput = {
  readonly providerHealth: ProviderHealthShape;
  readonly projectionSnapshotQuery: ProjectionSnapshotQueryShape;
  readonly serverSettings: ServerSettingsShape;
  readonly config: Pick<ServerConfigShape, "stateDir">;
  readonly installationRepository: ProviderInstallationRepositoryShape;
  readonly resolveManagedArtifact?: (input: {
    readonly provider: ProviderKind;
    readonly version: string;
  }) => Effect.Effect<ManagedProviderArtifact, unknown>;
  readonly installManagedArtifact?: (
    input: ManagedProviderArtifactInstallInput,
  ) => Effect.Effect<
    ManagedProviderArtifactInstallResult,
    unknown,
    FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
  >;
  readonly resolveManagedBinary?: (input: {
    readonly stateDir: string;
    readonly provider: ProviderKind;
  }) => Effect.Effect<ResolvedProviderBinary, unknown>;
  readonly readManagedManifest?: (input: {
    readonly stateDir: string;
    readonly provider: ProviderKind;
    readonly version: string;
  }) => Effect.Effect<ManagedProviderGenerationManifest | null, unknown>;
};

function installAndRecordManagedArtifact(input: {
  readonly coordinator: ManagedProviderCoordinatorInput;
  readonly artifact: ManagedProviderArtifact;
  readonly release: {
    readonly adapterVersion: string;
    readonly protocolVersion: string;
  };
}) {
  return Effect.gen(function* () {
    const installedAt = new Date().toISOString();
    const installed = yield* (
      input.coordinator.installManagedArtifact ?? installManagedProviderArtifact
    )({
      stateDir: input.coordinator.config.stateDir,
      artifact: input.artifact,
      ...input.release,
      installedAt,
    });
    const activatedAt = new Date().toISOString();
    yield* input.coordinator.installationRepository
      .activate({
        id: ProviderInstallationId.makeUnsafe(installed.installationId),
        harness: input.artifact.provider,
        version: input.artifact.version,
        platform: input.artifact.platform,
        architecture: input.artifact.architecture,
        executablePath: installed.binaryPath,
        artifactSource: input.artifact.source,
        artifactUrl: input.artifact.url,
        artifactSha256: input.artifact.sha256,
        adapterVersion: input.release.adapterVersion,
        protocolVersion: input.release.protocolVersion,
        installedAt,
        activatedAt,
      })
      .pipe(
        Effect.tapError(() =>
          deactivateManagedProviderRuntimeInstallation({
            stateDir: input.coordinator.config.stateDir,
            provider: input.artifact.provider,
            installationId: installed.installationId,
          }).pipe(Effect.ignore),
        ),
      );
    return installed;
  });
}

/**
 * Installs a missing managed runtime for every enabled first-release harness.
 * This is intentionally independent of the update preference: notify mode may
 * defer an upgrade, but a clean installation still needs an executable before
 * the harness can be configured or used.
 */
export function runManagedProviderBootstrapCycle(input: ManagedProviderCoordinatorInput) {
  return Effect.gen(function* () {
    const settings = yield* input.serverSettings.getSettings;
    let installedAny = false;

    for (const provider of MANAGED_PROVIDER_KINDS) {
      if (!isManagedProviderEnabled(settings, provider)) continue;

      const existing = yield* (input.resolveManagedBinary ?? resolveProviderBinary)({
        stateDir: input.config.stateDir,
        provider,
      }).pipe(Effect.option);
      if (Option.isSome(existing)) {
        const manifest = yield* (
          input.readManagedManifest ?? readManagedProviderGenerationManifest
        )({
          stateDir: input.config.stateDir,
          provider,
          version: existing.value.version,
        });
        if (manifest && manifest.installationId === existing.value.installationId) {
          const activatedAt = new Date().toISOString();
          yield* input.installationRepository.activate({
            id: ProviderInstallationId.makeUnsafe(manifest.installationId),
            harness: provider,
            version: manifest.version,
            platform: manifest.platform,
            architecture: manifest.architecture,
            executablePath: existing.value.binaryPath,
            artifactSource: manifest.artifact.source,
            artifactUrl: manifest.artifact.url,
            artifactSha256: manifest.artifact.sha256,
            adapterVersion: manifest.adapterVersion,
            protocolVersion: manifest.protocolVersion,
            installedAt: manifest.installedAt,
            activatedAt,
          });
          continue;
        }
        yield* deactivateManagedProviderRuntimeInstallation({
          stateDir: input.config.stateDir,
          provider,
          installationId: existing.value.installationId,
        });
      }

      const startedAt = new Date().toISOString();
      const release = MANAGED_PROVIDER_ADAPTER_RELEASES[provider];
      const result = yield* Effect.gen(function* () {
        const artifact = yield* (
          input.resolveManagedArtifact ??
          ((artifactInput) => resolveManagedProviderArtifact(artifactInput))
        )({ provider, version: "latest" });
        return yield* installAndRecordManagedArtifact({
          coordinator: input,
          artifact,
          release,
        });
      }).pipe(Effect.result);
      const finishedAt = new Date().toISOString();

      if (Result.isFailure(result)) {
        yield* appendHistoryEntry(input.config.stateDir, {
          provider,
          fromVersion: null,
          targetVersion: null,
          startedAt,
          finishedAt,
          status: "failed",
          message:
            result.failure instanceof Error ? result.failure.message : String(result.failure),
        });
        continue;
      }

      installedAny = true;
      yield* appendHistoryEntry(input.config.stateDir, {
        provider,
        fromVersion: null,
        targetVersion: result.success.version,
        startedAt,
        finishedAt,
        status: "succeeded",
        message: `Installed managed provider runtime ${result.success.version}.`,
      });
    }

    if (installedAny) {
      yield* input.providerHealth.refresh.pipe(Effect.ignore);
    }
  });
}

export function runAutomaticProviderUpdateCycle(input: ManagedProviderCoordinatorInput) {
  return Effect.gen(function* () {
    const settings = yield* input.serverSettings.getSettings;
    if (settings.providerUpdateMode !== "automatic") {
      return;
    }

    const statuses = yield* input.providerHealth.refresh;
    for (const candidate of statuses.filter(isAutomaticUpdateCandidate)) {
      if (!isManagedProviderKind(candidate.provider)) {
        continue;
      }
      const release = MANAGED_PROVIDER_ADAPTER_RELEASES[candidate.provider];
      const targetVersion = candidate.versionAdvisory?.latestVersion ?? null;
      if (!release || !targetVersion) {
        continue;
      }
      const shell = yield* input.projectionSnapshotQuery.getShellSnapshot();
      if (hasActiveProviderThread(candidate.provider, shell.threads)) {
        yield* Effect.logInfo("provider update deferred for active session", {
          provider: candidate.provider,
        });
        continue;
      }

      const startedAt = new Date().toISOString();
      const result = yield* Effect.gen(function* () {
        const artifact = yield* (
          input.resolveManagedArtifact ??
          ((artifactInput) => resolveManagedProviderArtifact(artifactInput))
        )({ provider: candidate.provider, version: targetVersion });
        return yield* installAndRecordManagedArtifact({
          coordinator: input,
          artifact,
          release,
        });
      }).pipe(Effect.result);
      const finishedAt = new Date().toISOString();

      if (Result.isFailure(result)) {
        yield* appendHistoryEntry(input.config.stateDir, {
          provider: candidate.provider,
          fromVersion: candidate.versionAdvisory?.currentVersion ?? null,
          targetVersion,
          startedAt,
          finishedAt,
          status: "failed",
          message:
            result.failure instanceof Error ? result.failure.message : String(result.failure),
        });
        continue;
      }

      const refreshed = (yield* input.providerHealth.refresh).find(
        (provider) => provider.provider === candidate.provider,
      );
      const status =
        refreshed?.version && compareSemverVersions(refreshed.version, targetVersion) === 0
          ? "succeeded"
          : "failed";
      yield* appendHistoryEntry(input.config.stateDir, {
        provider: candidate.provider,
        fromVersion: candidate.versionAdvisory?.currentVersion ?? null,
        targetVersion,
        startedAt,
        finishedAt,
        status,
        message:
          status === "succeeded"
            ? `Activated managed provider runtime ${targetVersion}.`
            : "Managed runtime was installed, but the provider health check did not confirm its version.",
      });
    }
  });
}

export function startAutomaticProviderUpdates(input: ManagedProviderCoordinatorInput) {
  return Effect.gen(function* () {
    const semaphore = yield* Semaphore.make(1);
    const cycle = semaphore
      .withPermits(1)(
        runManagedProviderBootstrapCycle(input).pipe(
          Effect.andThen(runAutomaticProviderUpdateCycle(input)),
        ),
      )
      .pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : Effect.logWarning("automatic provider update cycle failed", {
                cause: Cause.pretty(cause),
              }),
        ),
      );
    const scheduled = cycle.pipe(Effect.repeat(Schedule.spaced(PROVIDER_UPDATE_INTERVAL)));
    const onSettingsChanged = input.serverSettings.streamChanges.pipe(
      Stream.runForEach(() => cycle),
    );
    yield* Effect.all([Effect.forkChild(scheduled), Effect.forkChild(onSettingsChanged)], {
      discard: true,
    });
  });
}
