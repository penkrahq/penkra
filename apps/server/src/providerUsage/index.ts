// FILE: providerUsage/index.ts
// Purpose: Orchestrate the live provider-usage fetchers — defensive batch fetch (one failure never
// blocks the others). Exposes both a plain async API
// (for tests) and an Effect that reads ServerConfig (for the WS RPC handler).

import type {
  ProviderConnectionId,
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
import { ConnectionRateLimits, type ConnectionRateLimitObservation } from "./ConnectionRateLimits";
import { buildProviderChildEnvironment } from "../providerChildEnvironment";
import {
  providerConnectionProfileRoot,
  providerCredentialProfileIdentity,
} from "../provider/providerNativeStatePaths";
import {
  findManagedLoginMethod,
  findStaticCredentialMethod,
  getProviderConnectionManifest,
} from "../provider/providerConnectionManifests";
import { errorSnapshot, unsupportedSnapshot } from "./parse";
import { PROVIDER_USAGE_FETCHERS } from "./registry";
import { mergeConnectionUsageSnapshots, snapshotFromConnectionRateLimitFact } from "./runtimeFacts";
import type { ProviderUsageContext } from "./types";

function buildContext(): ProviderUsageContext {
  return {
    homeDir: "",
    env: process.env,
    platform: process.platform,
    nowMs: Date.now(),
  };
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

  // Managed Codex credentials are provider-owned and may live in the OS keychain.
  // The legacy fetcher can only inspect auth.json, so absence there is not evidence
  // that this already-verified Connection needs to reconnect. Login/runtime events
  // hydrate provider-owned rate-limit facts; until then the honest state is pending.
  if (input.connection.harness === "codex") {
    return {
      provider: "codex",
      connectionId: input.connection.id,
      updatedAt: new Date(input.base.nowMs).toISOString(),
      limits: [],
      usageLines: [],
      source: "provider-runtime-awaiting-rate-limits",
      status: "ok",
      detail: "Usage hasn’t been reported for this account yet.",
    };
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

/** Plain async Connection batch used by the RPC layer and isolation tests. Never throws. */
export async function collectProviderConnectionUsageSnapshots(input: {
  connections: ReadonlyArray<ProviderConnectionRecord>;
  stateDir: string;
  ctx: ProviderUsageContext;
  rateLimitFacts?: ReadonlyMap<ProviderConnectionId, ConnectionRateLimitObservation>;
}): Promise<ServerProviderUsageSnapshot[]> {
  return Promise.all(
    input.connections.map(async (connection) => {
      const fact = input.rateLimitFacts?.get(connection.id);
      const runtimeSnapshot = fact ? snapshotFromConnectionRateLimitFact(fact) : null;
      const fetchedSnapshot = await fetchConnectionUsage({
        connection,
        stateDir: input.stateDir,
        base: input.ctx,
      });
      return mergeConnectionUsageSnapshots({
        runtime: runtimeSnapshot,
        fetched: fetchedSnapshot,
      });
    }),
  );
}

export const listProviderUsage = Effect.fn(function* (input: ServerListProviderUsageInput) {
  const serverConfig = yield* ServerConfig;
  const connections = yield* ProviderConnectionRepository;
  const usageFacts = yield* ConnectionRateLimits;
  const context = { ...buildContext(), homeDir: serverConfig.homeDir };
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
  const facts = yield* Effect.forEach(activeRecords, (record) =>
    usageFacts
      .get(record.id)
      .pipe(Effect.map((fact) => [record.id, Option.getOrNull(fact)] as const)),
  );
  const rateLimitFacts = new Map(
    facts.filter(
      (entry): entry is readonly [ProviderConnectionId, ConnectionRateLimitObservation] =>
        entry[1] !== null,
    ),
  );
  return yield* Effect.tryPromise({
    try: () =>
      collectProviderConnectionUsageSnapshots({
        connections: activeRecords,
        stateDir: serverConfig.stateDir,
        ctx: context,
        rateLimitFacts,
      }),
    catch: () => [] as ServerListProviderUsageResult,
  });
});
