import type {
  ProviderCatalogChanged,
  ProviderCatalogData,
  ProviderCatalogKind,
  ProviderCatalogScope,
  ProviderConnectionId,
} from "@penkra/contracts";
import { Effect, Layer, Option, Scope, Stream } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import path from "node:path";
import { ServerConfig } from "../../config.ts";
import { makeInvalidationHub } from "../../cleanCore/invalidationHub.ts";
import { ThreadPublisher } from "../../cleanCore/ThreadPublisher.ts";
import { ProviderConnectionRepository } from "../../persistence/Services/ProviderConnections.ts";
import { ProviderInstallationRepository } from "../../persistence/Services/ProviderInstallations.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { discoverEnabledAppSkills } from "../../appSkillsCatalog.ts";
import { subscribeAppSkillChanges } from "../../appSkillChanges.ts";
import { ProviderValidationError } from "../Errors.ts";
import { ProviderCatalog } from "../ProviderCatalog.ts";
import { CatalogPathWatches } from "../catalogPathWatches.ts";
import { providerModelDiscoveryStateIdentity } from "../providerDiscoveryStateIdentity.ts";
import { ProviderAdapterRegistry } from "../Services/ProviderAdapterRegistry.ts";
import { ProviderLaunchResolver } from "../Services/ProviderLaunchResolver.ts";
import { ProviderCatalogService } from "../Services/ProviderCatalog.ts";
import {
  findConnectionAuthenticationMethod,
  getProviderConnectionManifest,
} from "../providerConnectionManifests.ts";
import {
  discoverSkillsCatalog,
  filterDisabledSkills,
  mergeSkillsIntoCatalog,
  skillsCatalogRoots,
} from "../skillsCatalog.ts";

const distinct = <A>(values: ReadonlyArray<A>, key: (value: A) => string): ReadonlyArray<A> => [
  ...new Map(values.map((value) => [key(value), value])).values(),
];
const scopeKey = (scope: ProviderCatalogScope) =>
  JSON.stringify([scope.provider, scope.connectionId, scope.folderId ?? null]);

/** Combines native routes belonging to one selected Connection, never other accounts. */
export function mergeProviderCatalogRoutes(
  results: ReadonlyArray<ProviderCatalogData>,
): ProviderCatalogData {
  return {
    ...(results.some((result) => result.models !== undefined)
      ? {
          models: distinct(
            results.flatMap((result) => result.models ?? []),
            (model) => JSON.stringify([model.upstreamProviderId ?? null, model.slug]),
          ),
        }
      : {}),
    ...(results.some((result) => result.commands !== undefined)
      ? {
          commands: distinct(
            results.flatMap((result) => result.commands ?? []),
            (command) => command.name,
          ),
        }
      : {}),
    ...(results.some((result) => result.skills !== undefined)
      ? {
          skills: distinct(
            results.flatMap((result) => result.skills ?? []),
            (skill) => skill.path,
          ),
        }
      : {}),
    ...(results.some((result) => result.plugins !== undefined)
      ? {
          plugins: distinct(
            results.flatMap((result) => result.plugins ?? []),
            (marketplace) => marketplace.path,
          ),
        }
      : {}),
    ...(results.some((result) => result.agents !== undefined)
      ? {
          agents: distinct(
            results.flatMap((result) => result.agents ?? []),
            (agent) => agent.name,
          ),
        }
      : {}),
  };
}

const make = Effect.gen(function* () {
  const registry = yield* ProviderAdapterRegistry;
  const config = yield* ServerConfig;
  const connections = yield* ProviderConnectionRepository;
  const installations = yield* ProviderInstallationRepository;
  const resolver = yield* ProviderLaunchResolver;
  const settings = yield* ServerSettingsService;
  const sql = yield* SqlClient.SqlClient;
  const publisher = yield* ThreadPublisher;
  const lifetime = yield* Scope.Scope;
  const runPromise = Effect.runPromiseWith(yield* Effect.services<never>());
  const controller = new AbortController();
  yield* Effect.addFinalizer(() => Effect.sync(() => controller.abort()));
  const changes = makeInvalidationHub<ProviderCatalogChanged>((event) =>
    JSON.stringify(event.scope),
  );
  yield* Effect.addFinalizer(() => changes.close);
  const paths = new CatalogPathWatches();
  type AppSkillSource = {
    controller: AbortController;
    ready: Promise<void>;
    error?: Error;
  };
  let appSkillSource: AppSkillSource | undefined;
  yield* Effect.addFinalizer(() => Effect.sync(() => appSkillSource?.controller.abort()));
  const ensureAppSkillSource = () => {
    if (!appSkillSource) {
      const controller = new AbortController();
      const source: AppSkillSource = { controller, ready: Promise.resolve() };
      appSkillSource = source;
      const notify = () => {
        void runPromise(
          invalidate(() => true, ["skills"]),
          { signal: controller.signal },
        ).catch((error) => {
          if (!controller.signal.aborted)
            console.error("App skill catalog invalidation failed", error);
        });
      };
      source.ready = subscribeAppSkillChanges(
        notify,
        (error) => {
          if (appSkillSource !== source || controller.signal.aborted) return;
          source.error = error;
          notify();
        },
        process.env,
        controller.signal,
      )
        .then(() => undefined)
        .catch((error: Error) => {
          source.error = error;
          throw error;
        });
    }
    if (appSkillSource.error) return Promise.reject(appSkillSource.error);
    return appSkillSource.ready;
  };
  const folderRoots = new Map<string, { cwd: string; spaceId: string }>();
  const watched = new Map<
    string,
    {
      scope: ProviderCatalogScope;
      cwd: string;
      kinds: Set<ProviderCatalogKind>;
      roots: string[];
      release: () => void;
      error?: Error;
    }
  >();
  const releaseWatches = (matches: (scope: ProviderCatalogScope) => boolean) => {
    for (const [key, entry] of watched)
      if (matches(entry.scope)) {
        entry.release();
        watched.delete(key);
      }
  };
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      releaseWatches(() => true);
      paths.close();
    }),
  );
  const watchSources = (
    scope: ProviderCatalogScope,
    cwd: string,
    requested: ReadonlyArray<ProviderCatalogKind>,
  ) => {
    if (scope.folderId === undefined) return;
    const key = scopeKey(scope);
    const existing = watched.get(key);
    if (existing?.error && existing.cwd === cwd) throw existing.error;
    const kinds = new Set([...(existing?.kinds ?? []), ...requested]);
    const roots = kinds.has("skills")
      ? skillsCatalogRoots({
          cwd,
          homeDir: config.homeDir,
          penkraBaseDir: config.baseDir,
          provider: scope.provider,
        }).map((root) => root.path)
      : [];
    if (scope.provider === "claudeAgent")
      for (const kind of ["commands", "skills", "agents"] as const) {
        if (kinds.has(kind))
          roots.push(path.join(cwd, ".claude", kind), path.join(config.homeDir, ".claude", kind));
      }
    const canonicalRoots = [...new Set(roots.map((root) => path.resolve(root)))].toSorted();
    if (
      existing &&
      existing.roots.length === canonicalRoots.length &&
      existing.roots.every((root, index) => root === canonicalRoots[index])
    ) {
      for (const kind of kinds) existing.kinds.add(kind);
      return;
    }
    existing?.release();
    watched.delete(key);
    if (canonicalRoots.length === 0) return;
    const notify = () => {
      void runPromise(
        invalidate((candidate) => scopeKey(candidate) === key, ["commands", "skills", "agents"]),
        { signal: controller.signal },
      ).catch((error) => {
        if (!controller.signal.aborted)
          console.error("Provider catalog source invalidation failed", { scope, error });
      });
    };
    const release = paths.add(canonicalRoots, notify, (error) => {
      const entry = watched.get(key);
      if (entry) entry.error = error;
      notify();
    });
    watched.set(key, { scope, cwd, kinds, roots: canonicalRoots, release });
  };
  const fail = (issue: string) =>
    new ProviderValidationError({ operation: "ProviderCatalog.load", issue });
  const readSource = <A>(run: () => Promise<A>) =>
    Effect.tryPromise({
      try: run,
      catch: (cause) => fail(cause instanceof Error ? cause.message : String(cause)),
    });

  const load = (scope: ProviderCatalogScope, kinds: ReadonlyArray<ProviderCatalogKind>) =>
    Effect.gen(function* () {
      let cwd = config.cwd;
      let spaceId: string | undefined;
      if (scope.folderId !== undefined) {
        const [folder] = yield* sql<{
          workspaceRoot: string | null;
          spaceId: string;
        }>`SELECT workspace_root AS "workspaceRoot", space_id AS "spaceId" FROM projection_folders WHERE folder_id=${scope.folderId} AND deleted_at IS NULL`;
        if (!folder) return yield* fail("The catalog's folder no longer exists.");
        cwd = folder.workspaceRoot ?? config.cwd;
        spaceId = folder.spaceId;
        folderRoots.set(scope.folderId, { cwd, spaceId });
      }
      const manifest = getProviderConnectionManifest(scope.provider);
      if (!manifest) return yield* fail("This provider has no managed catalog.");
      const installation = (yield* installations.list()).find(
        (candidate) => candidate.harness === scope.provider && candidate.lifecycle === "active",
      );
      if (!installation)
        return yield* fail("The provider's managed installation is not available.");
      const routes: {
        connectionId: ProviderConnectionId | null;
        internalProviderId: string | null;
      }[] = [];
      if (scope.connectionId === null) {
        for (const internalProviderId of manifest.anonymous?.internalProviderIds ?? [])
          routes.push({ connectionId: null, internalProviderId });
      } else {
        const connection = yield* connections.getRecord(scope.connectionId);
        if (
          Option.isNone(connection) ||
          connection.value.lifecycle !== "active" ||
          connection.value.harness !== scope.provider
        )
          return yield* fail("The catalog's selected Connection is not active for this provider.");
        const method = findConnectionAuthenticationMethod(connection.value);
        for (const internalProviderId of method?.internalProviderIds ?? [])
          routes.push({ connectionId: scope.connectionId, internalProviderId });
      }
      if (routes.length === 0)
        return yield* fail("The selected Connection cannot load this provider's catalog.");
      const adapter = yield* registry.getByProvider(scope.provider);
      if (!adapter.loadCatalog) return yield* fail("The provider adapter has no catalog loader.");
      yield* Effect.try({
        try: () => watchSources(scope, cwd, kinds),
        catch: (cause) => fail(cause instanceof Error ? cause.message : String(cause)),
      });
      const results = yield* Effect.forEach(
        routes,
        (route) =>
          Effect.gen(function* () {
            const managedLaunch = yield* resolver.resolveProfile({
              harness: scope.provider,
              installationId: installation.id,
              ...route,
              nativeStateIdentity: providerModelDiscoveryStateIdentity(scope),
            });
            return yield* adapter.loadCatalog!({
              scope,
              kinds,
              cwd,
              managedLaunch,
              internalProviderId: route.internalProviderId,
            });
          }),
        { concurrency: "unbounded" },
      );
      let data = mergeProviderCatalogRoutes(results);
      if (kinds.includes("skills")) {
        if (spaceId !== undefined && config.mode === "desktop") {
          yield* readSource(ensureAppSkillSource);
        }
        const portable = yield* readSource(() =>
          discoverSkillsCatalog({
            cwd,
            homeDir: config.homeDir,
            penkraBaseDir: config.baseDir,
            provider: scope.provider,
          }),
        );
        const appSkills =
          spaceId === undefined || config.mode !== "desktop"
            ? []
            : yield* readSource(() => discoverEnabledAppSkills(spaceId));
        const currentSettings = yield* settings.getSettings;
        data = {
          ...data,
          skills: filterDisabledSkills(
            mergeSkillsIntoCatalog({
              native: data.skills ?? [],
              catalog: [...portable, ...appSkills],
            }),
            currentSettings.skills.disabled,
          ),
        };
      }
      return {
        ...data,
        ...(data.models
          ? {
              models: data.models.map((model) => ({
                ...model,
                availableConnectionIds: [scope.connectionId],
              })),
            }
          : {}),
        ...(data.agents
          ? {
              agents: data.agents.map((agent) => ({
                ...agent,
                availableConnectionIds: [scope.connectionId],
              })),
            }
          : {}),
      };
    });

  const catalog = new ProviderCatalog((scope, kinds) => {
    const startedAt = performance.now();
    return runPromise(
      load(scope, kinds).pipe(
        Effect.tap((data) =>
          Effect.logInfo("provider.catalog.load", {
            scope,
            kinds,
            outcome: "success",
            durationMs: performance.now() - startedAt,
            counts: Object.fromEntries(
              Object.entries(data).map(([kind, items]) => [kind, items?.length]),
            ),
          }),
        ),
        Effect.tapError((error) =>
          Effect.logWarning("provider.catalog.load", {
            scope,
            kinds,
            outcome: "failure",
            durationMs: performance.now() - startedAt,
            error,
          }),
        ),
      ),
      { signal: controller.signal },
    );
  }, changes.publish);
  const wrap = <A>(run: () => Promise<A>) =>
    Effect.tryPromise({
      try: run,
      catch: (cause) =>
        cause instanceof Error ? cause : new Error("Provider catalog operation failed", { cause }),
    });
  const invalidate = (
    matches: (scope: ProviderCatalogScope) => boolean,
    kinds?: ReadonlyArray<ProviderCatalogKind>,
  ) => wrap(() => catalog.invalidate(matches, kinds));
  for (const provider of yield* registry.listProviders()) {
    const adapter = yield* registry.getByProvider(provider);
    if (adapter.catalogChanges)
      yield* adapter.catalogChanges.pipe(
        Stream.runForEach((event) =>
          invalidate(
            (scope) =>
              scope.provider === event.provider && scope.connectionId === event.connectionId,
            event.kinds,
          ),
        ),
        Effect.forkIn(lifetime, { startImmediately: true }),
      );
  }
  yield* connections.changes.pipe(
    Stream.runForEach((id) =>
      Effect.gen(function* () {
        const connection = yield* connections.getRecord(id);
        if (Option.isNone(connection) || connection.value.lifecycle !== "active") {
          releaseWatches((scope) => scope.connectionId === id);
          catalog.remove((scope) => scope.connectionId === id);
        } else yield* invalidate((scope) => scope.connectionId === id);
      }),
    ),
    Effect.forkIn(lifetime, { startImmediately: true }),
  );
  yield* installations.changes.pipe(
    Stream.runForEach((provider) => invalidate((scope) => scope.provider === provider)),
    Effect.forkIn(lifetime, { startImmediately: true }),
  );
  let disabledSkills = (yield* settings.getSettings).skills.disabled;
  yield* settings.streamChanges.pipe(
    Stream.runForEach((next) =>
      Effect.gen(function* () {
        if (JSON.stringify(next.skills.disabled) === JSON.stringify(disabledSkills)) return;
        disabledSkills = next.skills.disabled;
        yield* invalidate(() => true, ["skills"]);
      }),
    ),
    Effect.forkIn(lifetime, { startImmediately: true }),
  );
  yield* publisher.sidebarChanges.stream().pipe(
    Stream.filter((event) => event.kind === "navigation"),
    Stream.runForEach(() =>
      Effect.gen(function* () {
        const ids = [
          ...new Set(
            catalog.scopes.flatMap((scope) =>
              scope.folderId === undefined ? [] : [scope.folderId],
            ),
          ),
        ];
        if (ids.length === 0) return;
        const rows = yield* sql<{
          id: string;
          workspaceRoot: string | null;
          spaceId: string;
        }>`SELECT folder_id AS id, workspace_root AS "workspaceRoot", space_id AS "spaceId" FROM projection_folders WHERE folder_id IN (SELECT value FROM json_each(${JSON.stringify(ids)})) AND deleted_at IS NULL`;
        const current = new Map(rows.map((row) => [row.id, row]));
        for (const id of ids) {
          const row = current.get(id);
          const previous = folderRoots.get(id);
          if (!row) {
            releaseWatches((scope) => scope.folderId === id);
            catalog.remove((scope) => scope.folderId === id);
            folderRoots.delete(id);
          } else if (
            previous &&
            (previous.cwd !== (row.workspaceRoot ?? config.cwd) || previous.spaceId !== row.spaceId)
          ) {
            releaseWatches((scope) => scope.folderId === id);
            yield* invalidate((scope) => scope.folderId === id);
          }
        }
      }),
    ),
    Effect.forkIn(lifetime, { startImmediately: true }),
  );
  return {
    get: (scope: ProviderCatalogScope, kinds: ReadonlyArray<ProviderCatalogKind>) =>
      wrap(() => catalog.get(scope, kinds)),
    reload: (scope: ProviderCatalogScope) =>
      wrap(() => {
        if (appSkillSource?.error) {
          appSkillSource.controller.abort();
          appSkillSource = undefined;
        }
        releaseWatches((candidate) => scopeKey(candidate) === scopeKey(scope));
        return catalog.reload(scope);
      }),
    invalidate,
    remove: (matches: (scope: ProviderCatalogScope) => boolean) =>
      Effect.sync(() => {
        releaseWatches(matches);
        catalog.remove(matches);
      }),
    streamChanges: changes.stream(),
  };
});

export const ProviderCatalogLive = Layer.effect(ProviderCatalogService, make);
