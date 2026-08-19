// FILE: providerUsage/index.ts
// Purpose: Orchestrate the live provider-usage fetchers — defensive batch fetch (one failure never
// blocks the others), and enrichment of Codex/Claude live
// snapshots with the locally-derived token-total usage lines. Exposes both a plain async API
// (for tests) and an Effect that reads ServerConfig (for the WS RPC handler).

import type {
  ProviderConnectionId,
  ProviderKind,
  ServerListProviderUsageInput,
  ServerListProviderUsageResult,
  ServerProviderUsageSnapshot,
} from "@penkra/contracts";
import { Effect, Option } from "effect";

import { ServerConfig } from "../config";
import {
  ProviderConnectionRepository,
  type ProviderConnectionRecord,
} from "../persistence/Services/ProviderConnections";
import { buildProviderChildEnvironment, type ProviderChildKind } from "../providerChildEnvironment";
import {
  providerConnectionProfileRoot,
  providerCredentialProfileIdentity,
} from "../provider/providerNativeStatePaths";
import {
  findManagedLoginMethod,
  findStaticCredentialMethod,
  getProviderConnectionManifest,
} from "../provider/providerConnectionManifests";
import { loadLocalProviderUsageLines } from "../providerUsageSnapshot";
import { errorSnapshot, unsupportedSnapshot } from "./parse";
import { PROVIDER_USAGE_FETCHERS } from "./registry";
import type { ProviderUsageContext } from "./types";

// Providers whose live snapshot is enriched with on-disk token-total lines (24h/7d/30d).
const LOCAL_ARCHIVE_PROVIDERS: ReadonlySet<ProviderKind> = new Set(["codex", "claudeAgent"]);
const CONNECTION_USAGE_CACHE_TTL_MS = 60_000;
const connectionUsageCache = new Map<
  string,
  { readonly expiresAtMs: number; readonly snapshot: ServerProviderUsageSnapshot }
>();
const connectionUsageInFlight = new Map<string, Promise<ServerProviderUsageSnapshot>>();

const providerChildKind = (provider: ProviderKind): ProviderChildKind =>
  provider === "claudeAgent" ? "claude" : provider;

function buildContext(): ProviderUsageContext {
  return {
    homeDir: "",
    env: process.env,
    platform: process.platform,
    nowMs: Date.now(),
  };
}

function connectionUsageCacheKey(connection: ProviderConnectionRecord): string {
  return `${connection.id}:${connection.updatedAt}`;
}

function withConnectionId(
  snapshot: ServerProviderUsageSnapshot,
  connectionId: ProviderConnectionId,
): ServerProviderUsageSnapshot {
  return { ...snapshot, connectionId };
}

function buildManagedConnectionContext(input: {
  connection: ProviderConnectionRecord;
  stateDir: string;
  base: ProviderUsageContext;
}): ProviderUsageContext | null {
  const manifest = getProviderConnectionManifest(input.connection.harness);
  const profileIdentity = input.connection.profileRef
    ? providerCredentialProfileIdentity(input.connection.profileRef)
    : null;
  if (!manifest || profileIdentity === null) return null;

  const profileRoot = providerConnectionProfileRoot(input.stateDir, profileIdentity);
  const environment = manifest.buildStateEnvironment({
    profileRoot,
    // Usage reads only the credential profile. Passing the profile root here
    // avoids inventing thread state while satisfying adapter-owned path construction.
    nativeStateRoot: profileRoot,
  });
  return {
    ...input.base,
    homeDir: environment.isolation.homePath,
    credentialScope: "managed-connection",
    env: buildProviderChildEnvironment({
      provider: manifest.childKind,
      baseEnv: input.base.env,
      managedConnection: true,
      isolation: environment.isolation,
      ...(manifest.preserveOsHome === undefined ? {} : { preserveOsHome: manifest.preserveOsHome }),
      overrides: environment.overrides,
    }),
  };
}

function apiKeyUsageSnapshot(
  connection: ProviderConnectionRecord,
  nowMs: number,
): ServerProviderUsageSnapshot {
  return withConnectionId(
    unsupportedSnapshot(
      connection.harness,
      nowMs,
      "connection-usage",
      "Usage isn’t available for API keys.",
    ),
    connection.id,
  );
}

async function fetchConnectionUsage(input: {
  connection: ProviderConnectionRecord;
  stateDir: string;
  base: ProviderUsageContext;
}): Promise<ServerProviderUsageSnapshot> {
  const staticMethod = findStaticCredentialMethod(input.connection);
  const managedMethod = findManagedLoginMethod(input.connection);
  if (staticMethod || managedMethod?.loginMechanism === "secret-import") {
    return apiKeyUsageSnapshot(input.connection, input.base.nowMs);
  }
  if (!managedMethod) {
    return withConnectionId(
      unsupportedSnapshot(
        input.connection.harness,
        input.base.nowMs,
        "connection-usage",
        "Usage isn’t available for this Connection.",
      ),
      input.connection.id,
    );
  }

  const context = buildManagedConnectionContext(input);
  const fetcher = PROVIDER_USAGE_FETCHERS[input.connection.harness];
  if (!context || !fetcher) {
    return withConnectionId(
      errorSnapshot(
        input.connection.harness,
        input.base.nowMs,
        "connection-usage",
        "The Connection usage profile is unavailable.",
      ),
      input.connection.id,
    );
  }
  const snapshot = await fetcher
    .fetch(context)
    .catch(() =>
      errorSnapshot(
        input.connection.harness,
        input.base.nowMs,
        "connection-usage",
        "Usage fetch failed unexpectedly.",
      ),
    );
  return withConnectionId(snapshot, input.connection.id);
}

async function cachedConnectionUsage(input: {
  connection: ProviderConnectionRecord;
  stateDir: string;
  base: ProviderUsageContext;
  forceRefresh: boolean;
}): Promise<ServerProviderUsageSnapshot> {
  const key = connectionUsageCacheKey(input.connection);
  for (const existingKey of connectionUsageCache.keys()) {
    if (existingKey.startsWith(`${input.connection.id}:`) && existingKey !== key) {
      connectionUsageCache.delete(existingKey);
      connectionUsageInFlight.delete(existingKey);
    }
  }
  const cached = connectionUsageCache.get(key);
  if (!input.forceRefresh && cached && cached.expiresAtMs > input.base.nowMs) {
    return cached.snapshot;
  }
  const existing = connectionUsageInFlight.get(key);
  if (existing) return existing;

  const pending = fetchConnectionUsage(input).then((snapshot) => {
    const previous = cached?.snapshot;
    const resolved =
      snapshot.status === "error" && previous && (previous.status ?? "ok") === "ok"
        ? {
            ...previous,
            detail: "Usage is temporarily unavailable. Showing the last available value.",
          }
        : snapshot;
    connectionUsageCache.set(key, {
      expiresAtMs: input.base.nowMs + CONNECTION_USAGE_CACHE_TTL_MS,
      snapshot: resolved,
    });
    return resolved;
  });
  connectionUsageInFlight.set(key, pending);
  try {
    return await pending;
  } finally {
    connectionUsageInFlight.delete(key);
  }
}

/** Plain async Connection batch used by the RPC layer and isolation tests. Never throws. */
export async function collectProviderConnectionUsageSnapshots(input: {
  connections: ReadonlyArray<ProviderConnectionRecord>;
  stateDir: string;
  ctx: ProviderUsageContext;
  forceRefresh?: boolean;
}): Promise<ServerProviderUsageSnapshot[]> {
  return Promise.all(
    input.connections.map((connection) =>
      cachedConnectionUsage({
        connection,
        stateDir: input.stateDir,
        base: input.ctx,
        forceRefresh: input.forceRefresh === true,
      }),
    ),
  );
}

/** Test-only reset so module-level cache state cannot cross test cases. */
export function __resetConnectionUsageCache(): void {
  connectionUsageCache.clear();
  connectionUsageInFlight.clear();
}

async function fetchProviderUsage(
  provider: ProviderKind,
  ctx: ProviderUsageContext,
): Promise<ServerProviderUsageSnapshot | null> {
  const fetcher = PROVIDER_USAGE_FETCHERS[provider];
  if (!fetcher) {
    return null;
  }

  const providerContext: ProviderUsageContext = {
    ...ctx,
    env: buildProviderChildEnvironment({
      provider: providerChildKind(provider),
      baseEnv: ctx.env,
    }),
  };
  return fetcher
    .fetch(providerContext)
    .catch(() =>
      errorSnapshot(provider, ctx.nowMs, "live-usage", "Usage fetch failed unexpectedly."),
    );
}

async function enrichWithLocalUsage(
  snapshot: ServerProviderUsageSnapshot,
  ctx: ProviderUsageContext,
): Promise<ServerProviderUsageSnapshot> {
  if ((snapshot.status ?? "ok") !== "ok" || !LOCAL_ARCHIVE_PROVIDERS.has(snapshot.provider)) {
    return snapshot;
  }
  const localLines = await loadLocalProviderUsageLines({
    provider: snapshot.provider,
    homeDir: ctx.homeDir,
  });
  if (localLines.length === 0) {
    return snapshot;
  }
  return { ...snapshot, usageLines: [...snapshot.usageLines, ...localLines] };
}

/** Plain async batch fetch for supported providers. Never throws. */
export async function collectProviderUsageSnapshots(
  ctx: ProviderUsageContext,
  options: { forceRefresh?: boolean; provider?: ProviderKind } = {},
): Promise<ServerProviderUsageSnapshot[]> {
  const providers = options.provider
    ? ([options.provider] as ProviderKind[])
    : (Object.keys(PROVIDER_USAGE_FETCHERS) as ProviderKind[]);
  const settled = await Promise.allSettled(
    providers.map(async (provider) => {
      const snapshot = await fetchProviderUsage(provider, ctx);
      return snapshot ? enrichWithLocalUsage(snapshot, ctx) : null;
    }),
  );

  return settled
    .map((result) => (result.status === "fulfilled" ? result.value : null))
    .filter((snapshot): snapshot is ServerProviderUsageSnapshot => snapshot !== null);
}

export const listProviderUsage = Effect.fn(function* (input: ServerListProviderUsageInput) {
  const serverConfig = yield* ServerConfig;
  if (input.connectionIds !== undefined) {
    const connections = yield* ProviderConnectionRepository;
    const uniqueConnectionIds = [...new Set(input.connectionIds)];
    const records = yield* Effect.forEach(uniqueConnectionIds, (connectionId) =>
      connections.getRecord(connectionId).pipe(Effect.map(Option.getOrNull)),
    );
    const activeRecords = records.filter(
      (record): record is ProviderConnectionRecord =>
        record !== null &&
        record.lifecycle === "active" &&
        (input.provider === undefined || record.harness === input.provider),
    );
    return yield* Effect.tryPromise({
      try: () =>
        collectProviderConnectionUsageSnapshots({
          connections: activeRecords,
          stateDir: serverConfig.stateDir,
          ctx: { ...buildContext(), homeDir: serverConfig.homeDir },
          forceRefresh: input.forceRefresh === true,
        }),
      catch: () => [] as unknown as ServerListProviderUsageResult,
    });
  }
  return yield* Effect.tryPromise({
    try: () =>
      collectProviderUsageSnapshots(
        {
          ...buildContext(),
          homeDir: serverConfig.homeDir,
        },
        {
          forceRefresh: input.forceRefresh === true,
          ...(input.provider ? { provider: input.provider } : {}),
        },
      ),
    catch: () => [] as unknown as ServerListProviderUsageResult,
  });
});
