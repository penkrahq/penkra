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
  runManagedProviderBootstrapCycle,
} from "./providerUpdateCoordinator";

const installationRepository = {
  activate: () => Effect.succeed({} as never),
  list: () => Effect.succeed([]),
  getRecord: () => Effect.succeed({ _tag: "None" } as never),
  reactivate: () => Effect.die("not expected"),
};

function thread(overrides: Partial<OrchestrationThreadShell> = {}): OrchestrationThreadShell {
  return {
    id: "thread-1",
    folderId: "project-1",
    title: "Thread",
    modelSelection: { provider: "codex", model: "gpt-5" },
    runtimeMode: "full-access",
    isPinned: false,
    parentThreadId: null,
    creationSource: null,
    sourceThreadId: null,
    sourceTurnId: null,
    gatewayOperationId: null,
    gatewayOperationIndex: null,
    latestTurn: null,
    createdAt: "2026-07-30T00:00:00.000Z",
    updatedAt: "2026-07-30T00:00:00.000Z",
    archivedAt: null,
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
  } as unknown as OrchestrationThreadShell;
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
      updateCommand: null,
      canUpdate: true,
      checkedAt: "2026-07-30T00:00:00.000Z",
      message: "Update available.",
    },
  } satisfies ServerProviderStatus;
}

function outdatedOpenCode(): ServerProviderStatus {
  return {
    ...outdatedCodex(),
    provider: "opencode",
    version: "1.18.5",
    versionAdvisory: {
      ...outdatedCodex().versionAdvisory!,
      currentVersion: "1.18.5",
      latestVersion: "1.18.10",
      updateCommand: null,
    },
  };
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

  it("bootstraps missing managed runtimes even in notify mode", async () => {
    const installManagedArtifact = vi.fn(
      (input: { artifact: { provider: string; version: string } }) =>
        Effect.succeed({
          binaryPath: `/managed/${input.artifact.provider}`,
          installationId: `install-${input.artifact.provider}`,
          version: input.artifact.version,
          reused: false,
        }),
    );
    const refresh = vi.fn(() => Effect.succeed([]));

    const history = await Effect.runPromise(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const stateDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "penkra-provider-bootstrap-",
        });
        yield* runManagedProviderBootstrapCycle({
          providerHealth: {
            getStatuses: Effect.succeed([]),
            refresh: Effect.suspend(refresh),
            updateProvider: vi.fn(),
            streamChanges: Stream.empty,
          } as unknown as ProviderHealthShape,
          projectionSnapshotQuery: {} as ProjectionSnapshotQueryShape,
          serverSettings: {
            getSettings: Effect.succeed({
              ...DEFAULT_SERVER_SETTINGS,
              providerUpdateMode: "notify",
            }),
          } as unknown as ServerSettingsShape,
          config: { stateDir },
          installationRepository,
          resolveManagedBinary: () => Effect.fail(new Error("not installed")),
          resolveManagedArtifact: ({ provider }) =>
            Effect.succeed({
              provider,
              version: "1.2.3",
              platform: "darwin",
              architecture: "arm64",
              url: `https://example.invalid/${provider}`,
              sha256: "a".repeat(64),
              assetName: provider,
              archive: "raw",
              executableRelativePath: provider,
              metadataUrl: "https://example.invalid/release.json",
              source: provider === "claudeAgent" ? "anthropic-release-manifest" : "github-release",
            }),
          installManagedArtifact: installManagedArtifact as never,
        });
        return yield* fileSystem.readFileString(`${stateDir}/provider-update-history.json`);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );

    expect(installManagedArtifact).toHaveBeenCalledTimes(3);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(JSON.parse(history)).toEqual([
      expect.objectContaining({ provider: "codex", status: "succeeded" }),
      expect.objectContaining({ provider: "claudeAgent", status: "succeeded" }),
      expect.objectContaining({ provider: "opencode", status: "succeeded" }),
    ]);
  });

  it("does not resolve release metadata when a managed runtime is already active", async () => {
    const resolveManagedArtifact = vi.fn();
    const installManagedArtifact = vi.fn();
    await Effect.runPromise(
      runManagedProviderBootstrapCycle({
        providerHealth: {
          getStatuses: Effect.succeed([]),
          refresh: Effect.succeed([]),
          updateProvider: vi.fn(),
          streamChanges: Stream.empty,
        } as unknown as ProviderHealthShape,
        projectionSnapshotQuery: {} as ProjectionSnapshotQueryShape,
        serverSettings: {
          getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
        } as unknown as ServerSettingsShape,
        config: { stateDir: "/unused" },
        installationRepository,
        resolveManagedBinary: ({ provider }) =>
          Effect.succeed({
            binaryPath: `/managed/${provider}`,
            ownership: "managed",
            installationId: `install-${provider}`,
            version: "1.2.3",
          }),
        readManagedManifest: ({ provider }) =>
          Effect.succeed({
            schemaVersion: 1,
            provider,
            installationId: `install-${provider}`,
            version: "1.2.3",
            platform: "darwin",
            architecture: "arm64",
            adapterVersion: "1",
            protocolVersion: "test-protocol",
            executableRelativePath: provider,
            installedAt: "2026-08-08T00:00:00.000Z",
            artifact: {
              source: provider === "claudeAgent" ? "anthropic-release-manifest" : "github-release",
              metadataUrl: "https://example.invalid/metadata",
              url: "https://example.invalid/artifact",
              assetName: provider,
              sha256: "a".repeat(64),
              integrity: "verified",
            },
          }),
        resolveManagedArtifact,
        installManagedArtifact,
      }).pipe(Effect.provide(NodeServices.layer)),
    );

    expect(resolveManagedArtifact).not.toHaveBeenCalled();
    expect(installManagedArtifact).not.toHaveBeenCalled();
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
        installationRepository,
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
              folders: [],
              threads: [thread()],
              updatedAt: "2026-07-30T00:00:00.000Z",
            }),
        } as unknown as ProjectionSnapshotQueryShape,
        serverSettings: {
          getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
        } as unknown as ServerSettingsShape,
        config: { stateDir: "/unused" },
        installationRepository,
      }).pipe(Effect.provide(NodeServices.layer)),
    );
    expect(updateProvider).not.toHaveBeenCalled();
  });

  it("does not let legacy thread-continuation rejection block a later update attempt", async () => {
    const resolveManagedArtifact = vi.fn(() => Effect.fail(new Error("expected update attempt")));
    const getShellSnapshot = vi.fn(() =>
      Effect.succeed({
        snapshotSequence: 1,
        spaces: [],
        folders: [],
        threads: [],
        updatedAt: "2026-08-08T00:00:00.000Z",
      }),
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const stateDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "penkra-provider-rejected-retry-",
        });
        yield* runAutomaticProviderUpdateCycle({
          providerHealth: {
            getStatuses: Effect.succeed([]),
            refresh: Effect.succeed([outdatedCodex()]),
            updateProvider: vi.fn(),
            streamChanges: Stream.empty,
          } as unknown as ProviderHealthShape,
          projectionSnapshotQuery: {
            getShellSnapshot,
          } as unknown as ProjectionSnapshotQueryShape,
          serverSettings: {
            getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
          } as unknown as ServerSettingsShape,
          config: { stateDir },
          installationRepository,
          readManagedActivation: () =>
            Effect.succeed({
              schemaVersion: 2,
              provider: "codex",
              active: {
                installationId: "install-codex-1-0-0",
                version: "1.0.0",
                executableRelativePath: "bin/codex",
                activatedAt: "2026-08-08T00:00:00.000Z",
              },
              previous: null,
              rejected: {
                installationId: "install-codex-1-1-0",
                version: "1.1.0",
                executableRelativePath: "bin/codex",
                activatedAt: "2026-08-08T01:00:00.000Z",
              },
            }),
          resolveManagedArtifact,
        });
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );

    expect(getShellSnapshot).toHaveBeenCalledOnce();
    expect(resolveManagedArtifact).toHaveBeenCalledWith({ provider: "codex", version: "1.1.0" });
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
    const installManagedArtifact = vi.fn(() =>
      Effect.succeed({
        binaryPath: "/managed/codex",
        installationId: "install-codex-1-1-0",
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
                folders: [],
                threads: [],
                updatedAt: "2026-07-30T00:00:00.000Z",
              }),
          } as unknown as ProjectionSnapshotQueryShape,
          serverSettings: {
            getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
          } as unknown as ServerSettingsShape,
          config: { stateDir },
          installationRepository,
          resolveManagedArtifact: () =>
            Effect.succeed({
              provider: "codex",
              version: "1.1.0",
              platform: "darwin",
              architecture: "arm64",
              url: "https://example.invalid/codex.tar.gz",
              sha256: "a".repeat(64),
              assetName: "codex-package-aarch64-apple-darwin.tar.gz",
              archive: "tar.gz",
              executableRelativePath: "bin/codex",
              metadataUrl: "https://example.invalid/codex-release.json",
              source: "github-release",
            }),
          installManagedArtifact,
        });
        return yield* fileSystem.readFileString(`${stateDir}/provider-update-history.json`);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );

    expect(installManagedArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        artifact: expect.objectContaining({ provider: "codex", version: "1.1.0" }),
        adapterVersion: "1",
        protocolVersion: "codex-app-server-v2",
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

  it("does not consult a custom external provider binary", async () => {
    const installManagedArtifact = vi.fn(() =>
      Effect.succeed({
        binaryPath: "/managed/codex",
        installationId: "install-codex-1-1-0",
        version: "1.1.0",
        reused: false,
      }),
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const stateDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "penkra-provider-custom-path-",
        });
        yield* runAutomaticProviderUpdateCycle({
          providerHealth: {
            getStatuses: Effect.succeed([]),
            refresh: Effect.succeed([outdatedCodex()]),
            updateProvider: vi.fn(),
            streamChanges: Stream.empty,
          } as unknown as ProviderHealthShape,
          projectionSnapshotQuery: {
            getShellSnapshot: () =>
              Effect.succeed({
                snapshotSequence: 1,
                spaces: [],
                folders: [],
                threads: [],
                updatedAt: "2026-07-30T00:00:00.000Z",
              }),
          } as unknown as ProjectionSnapshotQueryShape,
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
          config: { stateDir },
          installationRepository,
          resolveManagedArtifact: () =>
            Effect.succeed({
              provider: "codex",
              version: "1.1.0",
              platform: "darwin",
              architecture: "arm64",
              url: "https://example.invalid/codex.tar.gz",
              sha256: "a".repeat(64),
              assetName: "codex.tar.gz",
              archive: "tar.gz",
              executableRelativePath: "bin/codex",
              metadataUrl: "https://example.invalid/release.json",
              source: "github-release",
            }),
          installManagedArtifact,
        });
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );

    expect(installManagedArtifact).toHaveBeenCalledTimes(1);
  });

  it("installs OpenCode from its official artifact instead of a lifecycle-script package", async () => {
    const installManagedArtifact = vi.fn(() =>
      Effect.succeed({
        binaryPath: "/managed/opencode",
        installationId: "install-opencode-1-18-10",
        version: "1.18.10",
        reused: false,
      }),
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const stateDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "penkra-provider-opencode-update-",
        });
        yield* runAutomaticProviderUpdateCycle({
          providerHealth: {
            getStatuses: Effect.succeed([]),
            refresh: Effect.succeed([outdatedOpenCode()]),
            updateProvider: vi.fn(),
            streamChanges: Stream.empty,
          } as unknown as ProviderHealthShape,
          projectionSnapshotQuery: {
            getShellSnapshot: () =>
              Effect.succeed({
                snapshotSequence: 1,
                spaces: [],
                folders: [],
                threads: [],
                updatedAt: "2026-07-30T00:00:00.000Z",
              }),
          } as unknown as ProjectionSnapshotQueryShape,
          serverSettings: {
            getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
          } as unknown as ServerSettingsShape,
          config: { stateDir },
          installationRepository,
          resolveManagedArtifact: () =>
            Effect.succeed({
              provider: "opencode",
              version: "1.18.10",
              platform: "darwin",
              architecture: "arm64",
              url: "https://example.invalid/opencode.zip",
              sha256: "b".repeat(64),
              assetName: "opencode-darwin-arm64.zip",
              archive: "zip",
              executableRelativePath: "opencode",
              metadataUrl: "https://example.invalid/release.json",
              source: "github-release",
            }),
          installManagedArtifact,
        });
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );

    expect(installManagedArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        artifact: expect.objectContaining({ provider: "opencode" }),
      }),
    );
  });
});
