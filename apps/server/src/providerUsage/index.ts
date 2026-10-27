// Server-owned Connection usage. Reads use only the selected managed runtime.
import type {
  ProviderConnectionId,
  ServerListProviderUsageInput,
  ServerProviderUsageSnapshot,
  ThreadId,
} from "@penkra/contracts";
import { Effect, Option } from "effect";
import { ServerConfig } from "../config.ts";
import {
  ProviderConnectionRepository,
  type ProviderConnectionRecord,
} from "../persistence/Services/ProviderConnections.ts";
import { ProviderInstallationRepository } from "../persistence/Services/ProviderInstallations.ts";
import { ProviderAdapterRegistry } from "../provider/Services/ProviderAdapterRegistry.ts";
import { ProviderLaunchResolver } from "../provider/Services/ProviderLaunchResolver.ts";
import {
  findManagedLoginMethod,
  findStaticCredentialMethod,
} from "../provider/providerConnectionManifests.ts";
import { providerModelDiscoveryStateIdentity } from "../provider/providerDiscoveryStateIdentity.ts";
import { ConnectionRateLimits } from "./ConnectionRateLimits.ts";
import { buildSnapshot, errorSnapshot, unsupportedSnapshot } from "./parse.ts";
import {
  mergeConnectionUsageSnapshots,
  snapshotFromConnectionRateLimitFact,
} from "./runtimeFacts.ts";

/** Per-Connection failure isolation, with no ambient credential or filesystem inputs. */
export async function collectProviderConnectionUsageSnapshots(input: {
  connections: ReadonlyArray<ProviderConnectionRecord>;
  nowMs: number;
  readUsage: (connection: ProviderConnectionRecord) => Promise<ServerProviderUsageSnapshot>;
}): Promise<ServerProviderUsageSnapshot[]> {
  return Promise.all(
    input.connections.map(async (connection) => {
      const managed = findManagedLoginMethod(connection);
      let snapshot: ServerProviderUsageSnapshot;
      if (findStaticCredentialMethod(connection) || managed?.loginMechanism === "secret-import") {
        snapshot = unsupportedSnapshot(
          connection.harness,
          input.nowMs,
          "provider-runtime",
          "Usage isn’t available for API keys.",
        );
      } else if (!managed || connection.harness === "opencode") {
        snapshot = unsupportedSnapshot(
          connection.harness,
          input.nowMs,
          "provider-runtime",
          "Usage isn’t available for this Connection.",
        );
      } else {
        try {
          snapshot = await input.readUsage(connection);
        } catch {
          snapshot = errorSnapshot(
            connection.harness,
            input.nowMs,
            "provider-runtime",
            connection.harness === "claudeAgent"
              ? "provider-error"
              : "Usage is temporarily unavailable.",
          );
        }
      }
      return { ...snapshot, provider: connection.harness, connectionId: connection.id };
    }),
  );
}

export const listProviderUsage = Effect.fn(function* (
  input: ServerListProviderUsageInput,
  threadId?: ThreadId,
) {
  const config = yield* ServerConfig;
  const connections = yield* ProviderConnectionRepository;
  const installations = yield* ProviderInstallationRepository;
  const registry = yield* ProviderAdapterRegistry;
  const resolver = yield* ProviderLaunchResolver;
  const facts = yield* ConnectionRateLimits;
  const records = yield* Effect.forEach([...new Set(input.connectionIds)], (id) =>
    connections.getRecord(id).pipe(Effect.map(Option.getOrNull)),
  );
  const active = records.filter(
    (record): record is ProviderConnectionRecord =>
      record !== null &&
      record.lifecycle === "active" &&
      (input.provider === undefined || input.provider === record.harness),
  );
  const runtime = yield* Effect.context<never>();
  const fetched = yield* Effect.promise((signal) =>
    collectProviderConnectionUsageSnapshots({
      connections: active,
      nowMs: Date.now(),
      readUsage: (connection) =>
        Effect.runPromiseWith(runtime)(
          Effect.gen(function* () {
            if (connection.harness === "claudeAgent" && !threadId) {
              return buildSnapshot({
                provider: "claudeAgent",
                nowMs: Date.now(),
                status: "ok",
                source: "provider-runtime-awaiting-rate-limits",
              });
            }
            const installation = yield* installations.getActiveRecord(connection.harness);
            const method = findManagedLoginMethod(connection);
            if (Option.isNone(installation) || method?.internalProviderIds.length !== 1)
              return yield* Effect.fail(new Error("The Connection runtime is unavailable."));
            const managedLaunch = yield* resolver.resolveProfile({
              harness: connection.harness,
              connectionId: connection.id,
              installationId: installation.value.id,
              internalProviderId: method.internalProviderIds[0]!,
              nativeStateIdentity: providerModelDiscoveryStateIdentity({
                provider: connection.harness,
                connectionId: connection.id,
              }),
            });
            const adapter = yield* registry.getByProvider(connection.harness);
            if (!adapter.readUsage)
              return yield* Effect.fail(new Error("The provider has no native usage report."));
            return yield* adapter.readUsage({
              cwd: config.cwd,
              managedLaunch,
              ...(threadId ? { threadId } : {}),
            });
          }).pipe(
            Effect.tapError((cause) =>
              Effect.logWarning("provider usage native read failed", {
                connectionId: connection.id,
                provider: connection.harness,
                cause,
              }),
            ),
          ),
          { signal },
        ),
    }),
  );
  return yield* Effect.forEach(fetched, (snapshot) =>
    Effect.gen(function* () {
      const fact = yield* facts.get(snapshot.connectionId as ProviderConnectionId);
      return mergeConnectionUsageSnapshots({
        fetched: snapshot,
        runtime: Option.isSome(fact) ? snapshotFromConnectionRateLimitFact(fact.value) : null,
      });
    }),
  );
});
