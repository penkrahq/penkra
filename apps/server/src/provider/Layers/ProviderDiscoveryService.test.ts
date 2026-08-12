// FILE: ProviderDiscoveryService.test.ts
// Purpose: Verifies the discovery service merges provider-native skills with the
//          unified Penkra catalog, filters user-disabled skills, and reports
//          skill discovery as supported for every provider.
// Layer: Server provider tests

import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type {
  ProviderComposerCapabilities,
  ProviderKind,
  ProviderListModelsResult,
  ProviderListSkillsResult,
} from "@penkra/contracts";
import { ProviderConnectionId, ProviderInstallationId } from "@penkra/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  deriveServerPaths,
  resolveDefaultChatWorkspaceRoot,
  resolveDefaultStudioWorkspaceRoot,
  ServerConfig,
  type ServerConfigShape,
} from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import type { ProviderAdapterError } from "../Errors.ts";
import { ProviderAdapterRequestError } from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import { ProviderAdapterRegistry } from "../Services/ProviderAdapterRegistry.ts";
import { ProviderDiscoveryService } from "../Services/ProviderDiscoveryService.ts";
import {
  ProviderLaunchResolutionError,
  ProviderLaunchResolver,
} from "../Services/ProviderLaunchResolver.ts";
import { ProviderConnectionRepository } from "../../persistence/Services/ProviderConnections.ts";
import { ProviderInstallationRepository } from "../../persistence/Services/ProviderInstallations.ts";
import { clearSkillsCatalogCacheForTests } from "../skillsCatalog.ts";
import { ProviderDiscoveryServiceLive } from "./ProviderDiscoveryService.ts";

let root: string;
let homeDir: string;
let baseDir: string;
let cwd: string;
const timestamp = "2026-08-08T00:00:00.000Z";

async function writeSkill(skillDir: string, name: string): Promise<void> {
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    path.join(skillDir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${name} description\n---\n\n# ${name}\n`,
  );
}

const makeConfigLayer = () =>
  Layer.effect(
    ServerConfig,
    Effect.gen(function* () {
      const derived = yield* deriveServerPaths(baseDir, undefined);
      return {
        mode: "web",
        port: 0,
        host: undefined,
        cwd,
        homeDir,
        chatWorkspaceRoot: resolveDefaultChatWorkspaceRoot({ homeDir }),
        studioWorkspaceRoot: resolveDefaultStudioWorkspaceRoot({ homeDir }),
        baseDir,
        ...derived,
        staticDir: undefined,
        devUrl: undefined,
        publicUrl: undefined,
        allowInsecureRemote: false,
        noBrowser: true,
        authToken: undefined,
        autoBootstrapProjectFromCwd: false,
        logProviderEvents: false,
        logWebSocketEvents: false,
      } satisfies ServerConfigShape;
    }),
  );

const makeRegistryLayer = (adapter: Partial<ProviderAdapterShape<ProviderAdapterError>>) =>
  Layer.succeed(ProviderAdapterRegistry, {
    getByProvider: () =>
      Effect.succeed({
        hasSession: () => Effect.succeed(false),
        ...adapter,
      } as ProviderAdapterShape<ProviderAdapterError>),
    listProviders: () => Effect.succeed([]),
  });

const managedDiscoveryDependencies = Layer.mergeAll(
  Layer.succeed(ProviderConnectionRepository, {
    list: () => Effect.succeed([]),
  } as never),
  Layer.succeed(ProviderInstallationRepository, {
    list: () => Effect.succeed([]),
  } as never),
  Layer.succeed(ProviderLaunchResolver, {
    resolve: () => Effect.die("not used"),
    resolveProfile: () => Effect.die("not used"),
  }),
);

const runListSkills = (input: {
  adapter: Partial<ProviderAdapterShape<ProviderAdapterError>>;
  disabled?: string[];
  provider: ProviderKind;
  threadId?: string;
}) => {
  const baseLayer = Layer.mergeAll(
    makeConfigLayer(),
    ServerSettingsService.layerTest({
      skills: { disabled: input.disabled ?? [] },
    }),
    makeRegistryLayer(input.adapter),
    managedDiscoveryDependencies,
  ).pipe(Layer.provideMerge(NodeServices.layer));
  const testLayer = ProviderDiscoveryServiceLive.pipe(Layer.provideMerge(baseLayer));
  const program = Effect.gen(function* () {
    const discovery = yield* ProviderDiscoveryService;
    return yield* discovery.listSkills({
      provider: input.provider,
      cwd,
      ...(input.threadId ? { threadId: input.threadId } : {}),
    });
  }).pipe(Effect.provide(testLayer));
  return Effect.runPromise(
    program as unknown as Effect.Effect<ProviderListSkillsResult, never, never>,
  );
};

const runListModels = (input: {
  adapter: Partial<ProviderAdapterShape<ProviderAdapterError>>;
  enabled: boolean;
}) => {
  const baseLayer = Layer.mergeAll(
    makeConfigLayer(),
    ServerSettingsService.layerTest({
      providers: {
        cursor: {
          enabled: input.enabled,
        },
      },
    }),
    makeRegistryLayer(input.adapter),
    managedDiscoveryDependencies,
  ).pipe(Layer.provideMerge(NodeServices.layer));
  const testLayer = ProviderDiscoveryServiceLive.pipe(Layer.provideMerge(baseLayer));
  const program = Effect.gen(function* () {
    const discovery = yield* ProviderDiscoveryService;
    return yield* discovery.listModels({ provider: "cursor" });
  }).pipe(Effect.provide(testLayer));
  return Effect.runPromise(
    program as unknown as Effect.Effect<ProviderListModelsResult, never, never>,
  );
};

beforeEach(async () => {
  clearSkillsCatalogCacheForTests();
  root = mkdtempSync(path.join(os.tmpdir(), "discovery-service-"));
  homeDir = path.join(root, "home");
  baseDir = path.join(homeDir, ".penkra");
  cwd = path.join(root, "repo");
  await mkdir(cwd, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("ProviderDiscoveryService.listSkills", () => {
  it("serves the unified catalog for providers without native skill discovery", async () => {
    await writeSkill(path.join(baseDir, "skills", "portable"), "portable");

    const result = await runListSkills({
      adapter: {},
      provider: "antigravity",
    });

    expect(result.skills.map((skill) => skill.name)).toEqual(["portable"]);
  });

  it("prefers provider-native entries and appends catalog-only skills", async () => {
    await writeSkill(path.join(baseDir, "skills", "shared"), "shared");
    await writeSkill(path.join(baseDir, "skills", "portable"), "portable");

    const nativeShared = {
      name: "shared",
      path: path.join(homeDir, ".codex", "skills", "shared", "SKILL.md"),
      enabled: true,
      scope: "user",
    };
    const result = await runListSkills({
      adapter: {
        hasSession: () => Effect.succeed(true),
        listSkills: () =>
          Effect.succeed({
            skills: [nativeShared],
            source: "codex-app-server",
            cached: false,
          }),
      },
      provider: "codex",
      threadId: "active-codex-thread",
    });

    const shared = result.skills.find((skill) => skill.name === "shared");
    expect(shared?.path).toBe(nativeShared.path);
    expect(result.skills.some((skill) => skill.name === "portable")).toBe(true);
  });

  it("filters user-disabled skills from merged results", async () => {
    await writeSkill(path.join(baseDir, "skills", "portable"), "portable");
    await writeSkill(path.join(baseDir, "skills", "muted"), "muted");

    const result = await runListSkills({
      adapter: {},
      disabled: ["Muted"],
      provider: "opencode",
    });

    expect(result.skills.map((skill) => skill.name)).toEqual(["portable"]);
  });

  it("falls back to the catalog when native discovery fails", async () => {
    await writeSkill(path.join(baseDir, "skills", "portable"), "portable");

    const result = await runListSkills({
      adapter: {
        hasSession: () => Effect.succeed(true),
        listSkills: () =>
          Effect.fail(
            new ProviderAdapterRequestError({
              provider: "codex",
              method: "skills/list",
              detail: "codex binary missing",
            }),
          ),
      },
      provider: "codex",
      threadId: "active-codex-thread",
    });

    expect(result.skills.map((skill) => skill.name)).toEqual(["portable"]);
  });
});

describe("ProviderDiscoveryService.getComposerCapabilities", () => {
  it("reports skill discovery as supported even when the adapter declines it", async () => {
    const baseLayer = Layer.mergeAll(
      makeConfigLayer(),
      ServerSettingsService.layerTest(),
      makeRegistryLayer({}),
      managedDiscoveryDependencies,
    ).pipe(Layer.provideMerge(NodeServices.layer));
    const testLayer = ProviderDiscoveryServiceLive.pipe(Layer.provideMerge(baseLayer));

    const program = Effect.gen(function* () {
      const discovery = yield* ProviderDiscoveryService;
      return yield* discovery.getComposerCapabilities({ provider: "grok" });
    }).pipe(Effect.provide(testLayer));
    const capabilities = await Effect.runPromise(
      program as unknown as Effect.Effect<ProviderComposerCapabilities, never, never>,
    );

    expect(capabilities.supportsSkillDiscovery).toBe(true);
    expect(capabilities.supportsSkillMentions).toBe(true);
  });
});

describe("ProviderDiscoveryService.listModels", () => {
  it("does not invoke the adapter for a disabled provider", async () => {
    let adapterCalls = 0;
    const result = await runListModels({
      adapter: {
        listModels: () => {
          adapterCalls += 1;
          return Effect.succeed({
            models: [{ slug: "cursor-model", name: "Cursor Model" }],
            source: "cursor.cli",
            cached: false,
          });
        },
      },
      enabled: false,
    });

    expect(result).toEqual({
      models: [],
      source: "disabled",
      cached: false,
    });
    expect(adapterCalls).toBe(0);
  });

  it("dispatches model discovery for an enabled provider", async () => {
    let adapterCalls = 0;
    const result = await runListModels({
      adapter: {
        listModels: () => {
          adapterCalls += 1;
          return Effect.succeed({
            models: [{ slug: "cursor-model", name: "Cursor Model" }],
            source: "cursor.cli",
            cached: false,
          });
        },
      },
      enabled: true,
    });

    expect(result.models).toEqual([{ slug: "cursor-model", name: "Cursor Model" }]);
    expect(adapterCalls).toBe(1);
  });

  it("discovers managed models through every exact Connection and anonymous route", async () => {
    const connectionId = ProviderConnectionId.makeUnsafe("opencode-go-connection");
    const failedConnectionId = ProviderConnectionId.makeUnsafe("opencode-go-failed-connection");
    const zenConnectionId = ProviderConnectionId.makeUnsafe("opencode-zen-connection");
    const installationId = ProviderInstallationId.makeUnsafe("managed-opencode-installation");
    const resolvedRoutes: Array<{
      connectionId: string | null;
      internalProviderId: string | null;
    }> = [];
    const adapterRoutes: Array<string | null | undefined> = [];
    const adapter = {
      listModels: (input: {
        readonly internalProviderId?: string | null;
        readonly managedLaunch?: unknown;
      }) => {
        adapterRoutes.push(input.internalProviderId);
        return Effect.succeed({
          models: [
            {
              slug: `${input.internalProviderId}/model`,
              name: `${input.internalProviderId} model`,
              upstreamProviderId: input.internalProviderId ?? undefined,
            },
          ],
          source: "test",
          cached: false,
        });
      },
    } as Partial<ProviderAdapterShape<ProviderAdapterError>>;
    const baseLayer = Layer.mergeAll(
      makeConfigLayer(),
      ServerSettingsService.layerTest(),
      makeRegistryLayer(adapter),
      Layer.succeed(ProviderConnectionRepository, {
        list: () =>
          Effect.succeed([
            {
              id: connectionId,
              harness: "opencode",
              authenticationTargetId: "opencode-go",
              authenticationMethodId: "api-key",
              label: "Go",
              providerIdentityId: null,
              health: "ready",
              healthReason: null,
              lastCheckedAt: timestamp,
              lifecycle: "active",
              terminatedAt: null,
              terminationReason: null,
              createdAt: timestamp,
              updatedAt: timestamp,
            },
            {
              id: zenConnectionId,
              harness: "opencode",
              authenticationTargetId: "opencode-zen",
              authenticationMethodId: "api-key",
              label: "Zen",
              providerIdentityId: null,
              health: "ready",
              healthReason: null,
              lastCheckedAt: timestamp,
              lifecycle: "active",
              terminatedAt: null,
              terminationReason: null,
              createdAt: timestamp,
              updatedAt: timestamp,
            },
            {
              id: failedConnectionId,
              harness: "opencode",
              authenticationTargetId: "opencode-go",
              authenticationMethodId: "api-key",
              label: "Unavailable Go",
              providerIdentityId: null,
              health: "ready",
              healthReason: null,
              lastCheckedAt: timestamp,
              lifecycle: "active",
              terminatedAt: null,
              terminationReason: null,
              createdAt: timestamp,
              updatedAt: timestamp,
            },
          ]),
      } as never),
      Layer.succeed(ProviderInstallationRepository, {
        list: () =>
          Effect.succeed([
            {
              id: installationId,
              harness: "opencode",
              version: "1.0.0",
              platform: "darwin",
              architecture: "arm64",
              adapterVersion: "1",
              protocolVersion: "v1",
              lifecycle: "active",
              healthReason: null,
              installedAt: timestamp,
              activatedAt: timestamp,
              retiredAt: null,
            },
          ]),
      } as never),
      Layer.succeed(ProviderLaunchResolver, {
        resolve: () => Effect.die("not used"),
        resolveProfile: (input) => {
          resolvedRoutes.push({
            connectionId: input.connectionId,
            internalProviderId: input.internalProviderId,
          });
          if (input.connectionId === failedConnectionId) {
            return Effect.fail(
              new ProviderLaunchResolutionError({
                detail: "isolated route unavailable",
              }),
            );
          }
          return Effect.succeed({
            binaryPath: "/managed/opencode",
            isolationKey: `route:${input.internalProviderId}`,
            profileRoot: "/managed/profile",
            nativeStateRoot: "/managed/native",
            connectionId: input.connectionId,
            installationId,
            childEnvironment: (environment: NodeJS.ProcessEnv) => environment,
          });
        },
      }),
    ).pipe(Layer.provideMerge(NodeServices.layer));
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const discovery = yield* ProviderDiscoveryService;
        return yield* discovery.listModels({ provider: "opencode" });
      }).pipe(Effect.provide(ProviderDiscoveryServiceLive.pipe(Layer.provideMerge(baseLayer)))),
    );

    expect(resolvedRoutes).toEqual([
      { connectionId, internalProviderId: "opencode-go" },
      { connectionId: zenConnectionId, internalProviderId: "opencode" },
      { connectionId: failedConnectionId, internalProviderId: "opencode-go" },
      { connectionId: null, internalProviderId: "opencode" },
    ]);
    expect(adapterRoutes).toEqual(["opencode-go", "opencode", "opencode"]);
    expect(result.models.map((model) => model.slug)).toEqual([
      "opencode-go/model",
      "opencode/model",
    ]);
    expect(result.models.map((model) => model.availableConnectionIds)).toEqual([
      [connectionId],
      [zenConnectionId, null],
    ]);
  });
});

describe("ProviderDiscoveryService.listAgents", () => {
  it("discovers agents through exact managed Connection routes and reports availability", async () => {
    const connectionId = ProviderConnectionId.makeUnsafe("opencode-go-agent-connection");
    const installationId = ProviderInstallationId.makeUnsafe("managed-opencode-agents");
    const resolvedRoutes: Array<string | null> = [];
    const adapter = {
      listAgents: (input: {
        readonly internalProviderId?: string | null;
        readonly managedLaunch?: unknown;
      }) => {
        expect(input.managedLaunch).toBeDefined();
        return Effect.succeed({
          agents: [
            { name: "review", displayName: "Review" },
            ...(input.internalProviderId === "opencode-go"
              ? [{ name: "work-only", displayName: "Work only" }]
              : []),
          ],
          source: "test",
          cached: false,
        });
      },
    } as Partial<ProviderAdapterShape<ProviderAdapterError>>;
    const baseLayer = Layer.mergeAll(
      makeConfigLayer(),
      ServerSettingsService.layerTest(),
      makeRegistryLayer(adapter),
      Layer.succeed(ProviderConnectionRepository, {
        list: () =>
          Effect.succeed([
            {
              id: connectionId,
              harness: "opencode",
              authenticationTargetId: "opencode-go",
              authenticationMethodId: "api-key",
              label: "Go",
              providerIdentityId: null,
              health: "ready",
              healthReason: null,
              lastCheckedAt: timestamp,
              lifecycle: "active",
              terminatedAt: null,
              terminationReason: null,
              createdAt: timestamp,
              updatedAt: timestamp,
            },
          ]),
      } as never),
      Layer.succeed(ProviderInstallationRepository, {
        list: () =>
          Effect.succeed([
            {
              id: installationId,
              harness: "opencode",
              version: "1.0.0",
              platform: "darwin",
              architecture: "arm64",
              adapterVersion: "1",
              protocolVersion: "v1",
              lifecycle: "active",
              healthReason: null,
              installedAt: timestamp,
              activatedAt: timestamp,
              retiredAt: null,
            },
          ]),
      } as never),
      Layer.succeed(ProviderLaunchResolver, {
        resolve: () => Effect.die("not used"),
        resolveProfile: (input) => {
          resolvedRoutes.push(input.connectionId);
          return Effect.succeed({
            binaryPath: "/managed/opencode",
            isolationKey: `agent-route:${input.connectionId ?? "anonymous"}`,
            profileRoot: "/managed/profile",
            nativeStateRoot: "/managed/native",
            connectionId: input.connectionId,
            installationId,
            childEnvironment: (environment: NodeJS.ProcessEnv) => environment,
          });
        },
      }),
    ).pipe(Layer.provideMerge(NodeServices.layer));

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const discovery = yield* ProviderDiscoveryService;
        return yield* discovery.listAgents({ provider: "opencode" });
      }).pipe(Effect.provide(ProviderDiscoveryServiceLive.pipe(Layer.provideMerge(baseLayer)))),
    );

    expect(resolvedRoutes).toEqual([connectionId, null]);
    expect(result.agents).toEqual([
      {
        name: "review",
        displayName: "Review",
        availableConnectionIds: [connectionId, null],
      },
      {
        name: "work-only",
        displayName: "Work only",
        availableConnectionIds: [connectionId],
      },
    ]);
  });
});
