import {
  FolderId,
  ProviderConnectionId,
  ProviderInstallationId,
  type ProviderCatalogData,
  type ProviderCatalogScope,
} from "@penkra/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer, Logger, Option, Stream } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ServerConfig } from "../../config.ts";
import { ThreadPublisher, ThreadPublisherLive } from "../../cleanCore/ThreadPublisher.ts";
import * as portableSkills from "../skillsCatalog.ts";
import * as appSkillChanges from "../../appSkillChanges.ts";
import * as appSkills from "../../appSkillsCatalog.ts";
import * as NodeSqliteClient from "../../persistence/NodeSqliteClient.ts";
import { ProviderConnectionRepository } from "../../persistence/Services/ProviderConnections.ts";
import { ProviderInstallationRepository } from "../../persistence/Services/ProviderInstallations.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ProviderAdapterRegistry } from "../Services/ProviderAdapterRegistry.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import type { ProviderAdapterError } from "../Errors.ts";
import { ProviderCatalogService } from "../Services/ProviderCatalog.ts";
import { ProviderLaunchResolver } from "../Services/ProviderLaunchResolver.ts";
import { ProviderCatalogLive, mergeProviderCatalogRoutes } from "./ProviderCatalog.ts";

const connectionId = ProviderConnectionId.makeUnsafe("selected");
const scope: ProviderCatalogScope = { provider: "codex", connectionId };
const folderId = FolderId.makeUnsafe("folder-a");
const models: ProviderCatalogData = { models: [{ slug: "model-a", name: "Model A" }] };

afterEach(() => vi.restoreAllMocks());

function harness(
  load: NonNullable<ProviderAdapterShape<ProviderAdapterError>["loadCatalog"]>,
  disabled: string[] = [],
  desktop = false,
) {
  const resolve = vi.fn((input: { connectionId: ProviderConnectionId | null }) =>
    Effect.succeed({
      binaryPath: "/managed/codex",
      isolationKey: String(input.connectionId),
      profileRoot: "/profile",
      nativeStateRoot: "/native",
      connectionId: input.connectionId,
      installationId: ProviderInstallationId.makeUnsafe("installation"),
      childEnvironment: () => ({}),
    }),
  );
  const dependencies = Layer.mergeAll(
    desktop
      ? Layer.effect(
          ServerConfig,
          Effect.gen(function* () {
            const config = yield* ServerConfig;
            return { ...config, mode: "desktop" as const };
          }),
        ).pipe(
          Layer.provide(
            ServerConfig.layerTest(process.cwd(), { prefix: "provider-catalog-layer-test-" }),
          ),
        )
      : ServerConfig.layerTest(process.cwd(), { prefix: "provider-catalog-layer-test-" }),
    ServerSettingsService.layerTest({ skills: { disabled } }),
    ThreadPublisherLive,
    Layer.succeed(ProviderAdapterRegistry, {
      getByProvider: () =>
        Effect.succeed({
          provider: "codex",
          loadCatalog: load,
        } as ProviderAdapterShape<ProviderAdapterError>),
      listProviders: () => Effect.succeed([]),
    }),
    Layer.succeed(ProviderConnectionRepository, {
      changes: Stream.never,
      getRecord: (id: ProviderConnectionId) =>
        Effect.succeed(
          id === connectionId
            ? Option.some({
                id,
                harness: "codex",
                lifecycle: "active",
                authenticationTargetId: "openai-first-party",
                authenticationMethodId: "chatgpt",
              })
            : Option.none(),
        ),
    } as never),
    Layer.succeed(ProviderInstallationRepository, {
      changes: Stream.never,
      list: () =>
        Effect.succeed([
          {
            id: ProviderInstallationId.makeUnsafe("installation"),
            harness: "codex",
            lifecycle: "active",
          },
        ]),
    } as never),
    Layer.succeed(ProviderLaunchResolver, {
      resolveProfile: resolve,
      resolve: () => Effect.die("unexpected thread launch"),
    }),
  );
  const layer = ProviderCatalogLive.pipe(
    Layer.provideMerge(dependencies),
    Layer.provideMerge(NodeSqliteClient.layerMemory()),
    Layer.provideMerge(NodeServices.layer),
  );
  return { resolve, layer };
}

describe("ProviderCatalog layer", () => {
  it("writes asynchronous catalog load evidence through the configured server logger", async () => {
    const messages: unknown[] = [];
    const logger = Logger.make(({ message }) => messages.push(message));
    const { layer } = harness(() => Effect.succeed(models));
    await Effect.runPromise(
      Effect.gen(function* () {
        return yield* (yield* ProviderCatalogService).get(scope, ["models"]);
      }).pipe(
        Effect.provide(
          layer.pipe(Layer.provide(Logger.layer([logger], { mergeWithExisting: false }))),
        ),
      ),
    );
    expect(
      messages.some((message) => Array.isArray(message) && message[0] === "provider.catalog.load"),
    ).toBe(true);
  });
  it("subscribes once to App skill changes, preserves items after source loss, and reconnects only on Retry", async () => {
    vi.spyOn(portableSkills, "skillsCatalogRoots").mockReturnValue([]);
    vi.spyOn(portableSkills, "discoverSkillsCatalog").mockResolvedValue([]);
    let changed!: () => void, failed!: (error: Error) => void;
    const subscribe = vi
      .spyOn(appSkillChanges, "subscribeAppSkillChanges")
      .mockImplementation(async (onChanged, onFailed) => {
        changed = onChanged;
        failed = onFailed;
        return () => {};
      });
    const skill = { name: "app", path: "/app/SKILL.md", enabled: true };
    const discover = vi.spyOn(appSkills, "discoverEnabledAppSkills").mockResolvedValue([skill]);
    const { layer } = harness(() => Effect.succeed({}), [], true);
    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`CREATE TABLE projection_folders (folder_id TEXT, workspace_root TEXT, space_id TEXT, deleted_at TEXT)`;
        yield* sql`INSERT INTO projection_folders VALUES (${folderId}, '/folder', 'space-a', NULL)`;
        const catalog = yield* ProviderCatalogService;
        const selected = { ...scope, folderId };
        expect((yield* catalog.get(selected, ["skills"])).skills).toEqual([skill]);
        changed();
        expect((yield* catalog.get(selected, ["skills"])).error).toBeNull();
        expect(discover).toHaveBeenCalledTimes(2);
        expect(subscribe).toHaveBeenCalledTimes(1);
        failed(new Error("source lost"));
        const unavailable = yield* catalog.get(selected, ["skills"]);
        expect(unavailable.error).toContain("source lost");
        expect(unavailable.skills).toEqual([skill]);
        expect(subscribe).toHaveBeenCalledTimes(1);
        expect((yield* catalog.reload(selected)).error).toBeNull();
        expect(subscribe).toHaveBeenCalledTimes(2);
      }).pipe(Effect.provide(layer)),
    );
  });
  it("merges portable skills and applies the same disabled-name policy", async () => {
    vi.spyOn(portableSkills, "skillsCatalogRoots").mockReturnValue([]);
    vi.spyOn(portableSkills, "discoverSkillsCatalog").mockResolvedValue([
      { name: "portable", path: "/portable/SKILL.md", enabled: true },
      { name: "native", path: "/old-native/SKILL.md", enabled: true },
    ]);
    const load = vi.fn(() =>
      Effect.succeed({ skills: [{ name: "native", path: "/native/SKILL.md", enabled: true }] }),
    );
    const { layer } = harness(load, ["portable"]);
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`CREATE TABLE projection_folders (folder_id TEXT, workspace_root TEXT, space_id TEXT, deleted_at TEXT)`;
        yield* sql`INSERT INTO projection_folders VALUES (${folderId}, '/selected/folder', 'space-a', NULL)`;
        return yield* (yield* ProviderCatalogService).get({ ...scope, folderId }, ["skills"]);
      }).pipe(Effect.provide(layer)),
    );
    expect(result.error).toBeNull();
    expect(result.skills).toEqual([{ name: "native", path: "/native/SKILL.md", enabled: true }]);
  });

  it("registers navigation before serving reads and invalidates a loaded folder when its workspace changes", async () => {
    let loadedAgain!: () => void;
    const secondLoad = new Promise<void>((resolve) => {
      loadedAgain = resolve;
    });
    const load = vi.fn((input: { cwd: string }) => {
      if (load.mock.calls.length === 2) loadedAgain();
      return Effect.succeed({ commands: [{ name: input.cwd }] });
    });
    const { layer } = harness(load);
    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`CREATE TABLE projection_folders (folder_id TEXT, workspace_root TEXT, space_id TEXT, deleted_at TEXT)`;
        yield* sql`INSERT INTO projection_folders VALUES (${folderId}, '/before', 'space-a', NULL)`;
        const catalog = yield* ProviderCatalogService;
        const publisher = yield* ThreadPublisher;
        yield* catalog.get({ ...scope, folderId }, ["commands"]);
        yield* sql`UPDATE projection_folders SET workspace_root='/after' WHERE folder_id=${folderId}`;
        publisher.publishSidebar({ kind: "navigation" });
        yield* Effect.promise(() => secondLoad);
        expect((yield* catalog.get({ ...scope, folderId }, ["commands"])).commands).toEqual([
          { name: "/after" },
        ]);
        expect(load).toHaveBeenCalledTimes(2);
      }).pipe(Effect.provide(layer)),
    );
  });

  it("resolves only the selected Connection and shares the load between readers", async () => {
    const load = vi.fn(() => Effect.succeed(models));
    const { resolve, layer } = harness(load);
    const results = await Effect.runPromise(
      Effect.gen(function* () {
        const catalog = yield* ProviderCatalogService;
        return yield* Effect.all([catalog.get(scope, ["models"]), catalog.get(scope, ["models"])], {
          concurrency: "unbounded",
        });
      }).pipe(Effect.provide(layer)),
    );
    expect(load).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ connectionId, harness: "codex", internalProviderId: null }),
    );
    expect(results[0]).toEqual({
      models: [{ ...models.models![0], availableConnectionIds: [connectionId] }],
      version: 1,
      error: null,
    });
    expect(results[1]).toEqual(results[0]);
  });

  it("takes the folder path from server data, without any thread or client-supplied path", async () => {
    const load = vi.fn(() => Effect.succeed({ commands: [{ name: "review" }] }));
    const { layer } = harness(load);
    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`CREATE TABLE projection_folders (folder_id TEXT, workspace_root TEXT, space_id TEXT, deleted_at TEXT)`;
        yield* sql`INSERT INTO projection_folders VALUES (${folderId}, '/selected/folder', 'space-a', NULL)`;
        const catalog = yield* ProviderCatalogService;
        const result = yield* catalog.get({ ...scope, folderId }, ["commands"]);
        expect(result.error).toBeNull();
        expect(load).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ cwd: "/selected/folder", scope: { ...scope, folderId } }),
        );
      }).pipe(Effect.provide(layer)),
    );
  });

  it("fails a missing selected Connection without choosing another account or loading", async () => {
    const load = vi.fn(() => Effect.succeed(models));
    const { resolve, layer } = harness(load);
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const catalog = yield* ProviderCatalogService;
        return yield* catalog.get(
          { ...scope, connectionId: ProviderConnectionId.makeUnsafe("not-selected") },
          ["models"],
        );
      }).pipe(Effect.provide(layer)),
    );
    expect(result.version).toBe(0);
    expect(result.error).toContain("selected Connection is not active");
    expect(load).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
  });

  it("keeps unsupported kinds absent while merging distinct native routes", () => {
    expect(
      mergeProviderCatalogRoutes([
        {},
        { models: [{ slug: "a", name: "A" }] },
        {
          models: [
            { slug: "a", name: "A" },
            { slug: "b", name: "B" },
          ],
        },
      ]),
    ).toEqual({
      models: [
        { slug: "a", name: "A" },
        { slug: "b", name: "B" },
      ],
    });
    expect(mergeProviderCatalogRoutes([{}, {}])).toEqual({});
  });
});
