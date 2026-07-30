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
} from "@synara/contracts";
import { Cause, Duration, Effect, FileSystem, Result, Schedule, Stream } from "effect";

import { writeFileStringAtomically } from "../atomicWrite";
import type { ServerConfigShape } from "../config";
import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery";
import type { ServerSettingsShape } from "../serverSettings";
import type { ProviderHealthShape } from "./Services/ProviderHealth";

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
    advisory.canUpdate === true &&
    advisory.updateCommand !== null &&
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
}) {
  return Effect.gen(function* () {
    const settings = yield* input.serverSettings.getSettings;
    if (settings.providerUpdateMode !== "automatic") {
      return;
    }

    const statuses = yield* input.providerHealth.refresh;
    for (const candidate of statuses.filter(isAutomaticUpdateCandidate)) {
      const shell = yield* input.projectionSnapshotQuery.getShellSnapshot();
      if (hasActiveProviderThread(candidate.provider, shell.threads)) {
        yield* Effect.logInfo("provider update deferred for active session", {
          provider: candidate.provider,
        });
        continue;
      }

      const startedAt = new Date().toISOString();
      const result = yield* input.providerHealth
        .updateProvider({ provider: candidate.provider })
        .pipe(Effect.result);
      const finishedAt = new Date().toISOString();

      if (Result.isFailure(result)) {
        yield* appendHistoryEntry(input.config.stateDir, {
          provider: candidate.provider,
          fromVersion: candidate.versionAdvisory?.currentVersion ?? null,
          targetVersion: candidate.versionAdvisory?.latestVersion ?? null,
          startedAt,
          finishedAt,
          status: "failed",
          message:
            result.failure instanceof Error ? result.failure.message : String(result.failure),
        });
        continue;
      }

      const refreshed = result.success.providers.find(
        (provider) => provider.provider === candidate.provider,
      );
      const status =
        refreshed?.updateState?.status === "succeeded"
          ? "succeeded"
          : refreshed?.updateState?.status === "unchanged"
            ? "unchanged"
            : "failed";
      yield* appendHistoryEntry(input.config.stateDir, {
        provider: candidate.provider,
        fromVersion: candidate.versionAdvisory?.currentVersion ?? null,
        targetVersion: candidate.versionAdvisory?.latestVersion ?? null,
        startedAt,
        finishedAt,
        status,
        message: refreshed?.updateState?.message ?? "Provider update completed.",
      });
    }
  });
}

export function startAutomaticProviderUpdates(
  input: Parameters<typeof runAutomaticProviderUpdateCycle>[0],
) {
  const cycle = runAutomaticProviderUpdateCycle(input).pipe(
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
  return Effect.all([Effect.forkChild(scheduled), Effect.forkChild(onAutomaticSelected)], {
    discard: true,
  });
}
