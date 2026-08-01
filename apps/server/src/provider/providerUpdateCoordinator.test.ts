import {
  DEFAULT_SERVER_SETTINGS,
  type OrchestrationThreadShell,
  type ServerProviderStatus,
} from "@penkra/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Stream } from "effect";
import { describe, expect, it, vi } from "vitest";

import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery";
import type { ServerSettingsShape } from "../serverSettings";
import type { ProviderHealthShape } from "./Services/ProviderHealth";
import {
  hasActiveProviderThread,
  isProviderUpdateBlockedByActiveThread,
  runAutomaticProviderUpdateCycle,
} from "./providerUpdateCoordinator";

function thread(overrides: Partial<OrchestrationThreadShell> = {}): OrchestrationThreadShell {
  return {
    id: "thread-1",
    projectId: "project-1",
    title: "Thread",
    modelSelection: { provider: "codex", model: "gpt-5" },
    runtimeMode: "native",
    interactionMode: "default",
    envMode: "local",
    branch: null,
    worktreePath: null,
    associatedWorktreePath: null,
    associatedWorktreeBranch: null,
    associatedWorktreeRef: null,
    createBranchFlowCompleted: false,
    isPinned: false,
    parentThreadId: null,
    creationSource: null,
    sourceThreadId: null,
    sourceTurnId: null,
    gatewayOperationId: null,
    gatewayOperationIndex: null,
    sidechatSourceThreadId: null,
    latestTurn: null,
    createdAt: "2026-07-30T00:00:00.000Z",
    updatedAt: "2026-07-30T00:00:00.000Z",
    archivedAt: null,
    handoff: null,
    session: {
      threadId: "thread-1",
      status: "running",
      providerName: "codex",
      runtimeMode: "native",
      activeTurnId: "turn-1",
      lastError: null,
      updatedAt: "2026-07-30T00:00:00.000Z",
    },
    ...overrides,
  } as OrchestrationThreadShell;
}

function outdatedCodex(): ServerProviderStatus {
  return {
    provider: "codex",
    status: "ready",
    available: true,
    authStatus: "authenticated",
    version: "1.0.0",
    checkedAt: "2026-07-30T00:00:00.000Z",
    versionAdvisory: {
      status: "behind_latest",
      currentVersion: "1.0.0",
      latestVersion: "1.1.0",
      updateCommand: "npm install -g @openai/codex@1.1.0",
      canUpdate: true,
      checkedAt: "2026-07-30T00:00:00.000Z",
      message: "Update available.",
    },
  } satisfies ServerProviderStatus;
}

describe("provider update coordinator", () => {
  it("blocks only the active provider", () => {
    const active = thread();
    expect(isProviderUpdateBlockedByActiveThread("codex", active)).toBe(true);
    expect(isProviderUpdateBlockedByActiveThread("claudeAgent", active)).toBe(false);
    expect(hasActiveProviderThread("codex", [active])).toBe(true);
  });

  it("does not treat a ready session without a turn as active", () => {
    const ready = thread({
      session: {
        ...thread().session!,
        status: "ready",
        activeTurnId: null,
      },
    });
    expect(isProviderUpdateBlockedByActiveThread("codex", ready)).toBe(false);
  });

  it("never updates automatically in notify mode", async () => {
    const refresh = vi.fn(() => Effect.succeed([outdatedCodex()]));
    const updateProvider = vi.fn();
    await Effect.runPromise(
      runAutomaticProviderUpdateCycle({
        providerHealth: {
          getStatuses: Effect.succeed([]),
          refresh: Effect.suspend(refresh),
          updateProvider,
          streamChanges: Stream.empty,
        } as unknown as ProviderHealthShape,
        projectionSnapshotQuery: {} as ProjectionSnapshotQueryShape,
        serverSettings: {
          getSettings: Effect.succeed({
            ...DEFAULT_SERVER_SETTINGS,
            providerUpdateMode: "notify",
          }),
        } as unknown as ServerSettingsShape,
        config: { stateDir: "/unused" },
      }).pipe(Effect.provide(NodeServices.layer)),
    );
    expect(refresh).not.toHaveBeenCalled();
    expect(updateProvider).not.toHaveBeenCalled();
  });

  it("defers an automatic update while that provider has an active thread", async () => {
    const updateProvider = vi.fn();
    await Effect.runPromise(
      runAutomaticProviderUpdateCycle({
        providerHealth: {
          getStatuses: Effect.succeed([]),
          refresh: Effect.succeed([outdatedCodex()]),
          updateProvider,
          streamChanges: Stream.empty,
        } as unknown as ProviderHealthShape,
        projectionSnapshotQuery: {
          getShellSnapshot: () =>
            Effect.succeed({
              snapshotSequence: 1,
              spaces: [],
              projects: [],
              threads: [thread()],
              updatedAt: "2026-07-30T00:00:00.000Z",
            }),
        } as unknown as ProjectionSnapshotQueryShape,
        serverSettings: {
          getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
        } as unknown as ServerSettingsShape,
        config: { stateDir: "/unused" },
      }).pipe(Effect.provide(NodeServices.layer)),
    );
    expect(updateProvider).not.toHaveBeenCalled();
  });

  it("installs and confirms a managed runtime in automatic mode", async () => {
    const refreshed = {
      ...outdatedCodex(),
      version: "1.1.0",
      versionAdvisory: {
        ...outdatedCodex().versionAdvisory!,
        status: "up_to_date" as const,
        currentVersion: "1.1.0",
      },
    };
    const refresh = vi
      .fn()
      .mockReturnValueOnce(Effect.succeed([outdatedCodex()]))
      .mockReturnValueOnce(Effect.succeed([refreshed]));
    const installManagedRuntime = vi.fn(() =>
      Effect.succeed({
        binaryPath: "/managed/codex",
        version: "1.1.0",
        reused: false,
      }),
    );

    const history = await Effect.runPromise(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const stateDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "penkra-provider-update-",
        });
        yield* runAutomaticProviderUpdateCycle({
          providerHealth: {
            getStatuses: Effect.succeed([]),
            refresh: Effect.suspend(refresh),
            updateProvider: vi.fn(),
            streamChanges: Stream.empty,
          } as unknown as ProviderHealthShape,
          projectionSnapshotQuery: {
            getShellSnapshot: () =>
              Effect.succeed({
                snapshotSequence: 1,
                spaces: [],
                projects: [],
                threads: [],
                updatedAt: "2026-07-30T00:00:00.000Z",
              }),
          } as unknown as ProjectionSnapshotQueryShape,
          serverSettings: {
            getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
          } as unknown as ServerSettingsShape,
          config: { stateDir },
          installManagedRuntime,
        });
        return yield* fileSystem.readFileString(`${stateDir}/provider-update-history.json`);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );

    expect(installManagedRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "codex",
        packageName: "@openai/codex",
        version: "1.1.0",
      }),
    );
    expect(JSON.parse(history)).toEqual([
      expect.objectContaining({
        provider: "codex",
        status: "succeeded",
        targetVersion: "1.1.0",
      }),
    ]);
  });

  it("does not mutate a custom external provider binary", async () => {
    const installManagedRuntime = vi.fn();
    await Effect.runPromise(
      runAutomaticProviderUpdateCycle({
        providerHealth: {
          getStatuses: Effect.succeed([]),
          refresh: Effect.succeed([outdatedCodex()]),
          updateProvider: vi.fn(),
          streamChanges: Stream.empty,
        } as unknown as ProviderHealthShape,
        projectionSnapshotQuery: {} as ProjectionSnapshotQueryShape,
        serverSettings: {
          getSettings: Effect.succeed({
            ...DEFAULT_SERVER_SETTINGS,
            providers: {
              ...DEFAULT_SERVER_SETTINGS.providers,
              codex: {
                ...DEFAULT_SERVER_SETTINGS.providers.codex,
                binaryPath: "/custom/bin/codex",
              },
            },
          }),
        } as unknown as ServerSettingsShape,
        config: { stateDir: "/unused" },
        installManagedRuntime,
      }).pipe(Effect.provide(NodeServices.layer)),
    );

    expect(installManagedRuntime).not.toHaveBeenCalled();
  });
});
