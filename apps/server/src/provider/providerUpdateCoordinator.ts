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
  ServerProviderStatus,
} from "@penkra/contracts";
import {
  Cause,
  Duration,
  Effect,
  FileSystem,
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
import { isCanonicalProviderBinaryPath } from "./managedProviderRuntime";
import {
  installManagedProviderRuntime,
  type ManagedProviderRuntimeInstallInput,
  type ManagedProviderRuntimeInstallResult,
} from "./managedProviderRuntimeInstaller";
import { PACKAGE_MANAGED_PROVIDER_UPDATES } from "./Layers/ProviderHealth";
import { compareSemverVersions } from "./providerMaintenance";

export const PROVIDER_UPDATE_INITIAL_DELAY = Duration.seconds(10);
export const PROVIDER_UPDATE_INTERVAL = Duration.hours(1);
const PROVIDER_UPDATE_HISTORY_LIMIT = 100;

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

export function runAutomaticProviderUpdateCycle(input: {
  readonly providerHealth: ProviderHealthShape;
  readonly projectionSnapshotQuery: ProjectionSnapshotQueryShape;
  readonly serverSettings: ServerSettingsShape;
  readonly config: Pick<ServerConfigShape, "stateDir">;
  readonly installManagedRuntime?: (
    input: ManagedProviderRuntimeInstallInput,
  ) => Effect.Effect<
    ManagedProviderRuntimeInstallResult,
    unknown,
    FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
  >;
}) {
  return Effect.gen(function* () {
    const settings = yield* input.serverSettings.getSettings;
    if (settings.providerUpdateMode !== "automatic") {
      return;
    }

    const statuses = yield* input.providerHealth.refresh;
    for (const candidate of statuses.filter(isAutomaticUpdateCandidate)) {
      const definition = PACKAGE_MANAGED_PROVIDER_UPDATES[candidate.provider];
      const targetVersion = candidate.versionAdvisory?.latestVersion ?? null;
      const configuredBinaryPath = settings.providers[candidate.provider].binaryPath;
      if (
        !definition?.npmPackageName ||
        !targetVersion ||
        !isCanonicalProviderBinaryPath(candidate.provider, configuredBinaryPath)
      ) {
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
      const result = yield* (input.installManagedRuntime ?? installManagedProviderRuntime)({
        stateDir: input.config.stateDir,
        provider: candidate.provider,
        version: targetVersion,
        packageName: definition.npmPackageName,
        binaryName: definition.binaryName,
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

export function startAutomaticProviderUpdates(
  input: Parameters<typeof runAutomaticProviderUpdateCycle>[0],
) {
  return Effect.gen(function* () {
    const semaphore = yield* Semaphore.make(1);
    const cycle = semaphore
      .withPermits(1)(runAutomaticProviderUpdateCycle(input))
      .pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : Effect.logWarning("automatic provider update cycle failed", {
                cause: Cause.pretty(cause),
              }),
        ),
      );
    const scheduled = Effect.sleep(PROVIDER_UPDATE_INITIAL_DELAY).pipe(
      Effect.andThen(cycle),
      Effect.repeat(Schedule.spaced(PROVIDER_UPDATE_INTERVAL)),
    );
    const onAutomaticSelected = input.serverSettings.streamChanges.pipe(
      Stream.filter((settings) => settings.providerUpdateMode === "automatic"),
      Stream.runForEach(() => cycle),
    );
    yield* Effect.all([Effect.forkChild(scheduled), Effect.forkChild(onAutomaticSelected)], {
      discard: true,
    });
  });
}
