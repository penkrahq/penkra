import type { ProviderCatalogSnapshot, ProviderConnection, ProviderKind } from "@penkra/contracts";
import { ProviderConnectionId, ProviderInstallationId } from "@penkra/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer } from "effect";
import { describe, expect, it, vi } from "vitest";
import { ServerConfig } from "../../config.ts";
import { ProviderConnectionRepository } from "../../persistence/Services/ProviderConnections.ts";
import { ProviderInstallationRepository } from "../../persistence/Services/ProviderInstallations.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import type { ProviderAdapterError } from "../Errors.ts";
import { ProviderAdapterRegistry } from "../Services/ProviderAdapterRegistry.ts";
import { ProviderCatalogService } from "../Services/ProviderCatalog.ts";
import { ProviderDiscoveryService } from "../Services/ProviderDiscoveryService.ts";
import { ProviderLaunchResolver } from "../Services/ProviderLaunchResolver.ts";
import { ProviderDiscoveryServiceLive } from "./ProviderDiscoveryService.ts";

const connectionId = ProviderConnectionId.make("selected");
const installationId = ProviderInstallationId.make("managed");
function harness(
  input: {
    provider?: ProviderKind;
    snapshot?: ProviderCatalogSnapshot;
    adapter?: Partial<ProviderAdapterShape<ProviderAdapterError>>;
    connections?: ReadonlyArray<ProviderConnection>;
  } = {},
) {
  const provider = input.provider ?? "codex";
  const get = vi.fn(() =>
    Effect.succeed(
      input.snapshot ?? { version: 1, error: null, models: [{ slug: "model-a", name: "Model A" }] },
    ),
  );
  const resolve = vi.fn(() =>
    Effect.succeed({
      binaryPath: "/managed/provider",
      assertCurrentCredentials: Effect.void,
      isolationKey: "selected",
      profileRoot: "/profile",
      nativeStateRoot: "/native",
      installationId,
      connectionId,
      childEnvironment: () => ({}),
    }),
  );
  const dependencies = Layer.mergeAll(
    ServerConfig.layerTest(process.cwd(), { prefix: "provider-discovery-metadata-test-" }),
    ServerSettingsService.layerTest(),
    Layer.succeed(ProviderAdapterRegistry, {
      listProviders: () => Effect.succeed([provider]),
      getByProvider: () =>
        Effect.succeed({
          provider,
          hasSession: () => Effect.succeed(false),
          ...input.adapter,
        } as ProviderAdapterShape<ProviderAdapterError>),
    }),
    Layer.succeed(ProviderCatalogService, { get } as never),
    Layer.succeed(ProviderConnectionRepository, {
      list: () =>
        Effect.succeed(
          input.connections ?? [{ id: connectionId, harness: provider, lifecycle: "active" }],
        ),
    } as never),
    Layer.succeed(ProviderInstallationRepository, {
      list: () => Effect.succeed([{ id: installationId, harness: provider, lifecycle: "active" }]),
    } as never),
    Layer.succeed(ProviderLaunchResolver, {
      resolveProfile: resolve,
      resolve: () => Effect.die("unexpected thread launch"),
    }),
  ).pipe(Layer.provideMerge(NodeServices.layer));
  return {
    get,
    resolve,
    layer: ProviderDiscoveryServiceLive.pipe(Layer.provideMerge(dependencies)),
  };
}

describe("provider metadata over the shared catalog", () => {
  it("keeps portable skill mentions available and preserves native capability flags", async () => {
    const { layer } = harness();
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* (yield* ProviderDiscoveryService).getComposerCapabilities({
          provider: "codex",
        });
      }).pipe(Effect.provide(layer)),
    );
    expect(result).toMatchObject({
      supportsSkillMentions: true,
      supportsSkillDiscovery: true,
      supportsPluginDiscovery: false,
    });
  });

  it("does not probe a different or nonexistent thread for capability health", async () => {
    const health = vi.fn(() => Effect.succeed({ capabilities: [], source: "native" }));
    const { layer } = harness({ adapter: { getCapabilityHealth: health } });
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* (yield* ProviderDiscoveryService).getCapabilityHealth({
          provider: "codex",
          threadId: "missing",
        });
      }).pipe(Effect.provide(layer)),
    );
    expect(result).toEqual({ capabilities: [], source: "no-active-session" });
    expect(health).not.toHaveBeenCalled();
  });

  it("formats the exact selected Connection's catalog without a native adapter call", async () => {
    const { layer, get, resolve } = harness();
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* (yield* ProviderDiscoveryService).listModels({
          provider: "codex",
          connectionId,
        });
      }).pipe(Effect.provide(layer)),
    );
    expect(result).toEqual({
      models: [{ slug: "model-a", name: "Model A" }],
      source: "provider-catalog",
      cached: true,
    });
    expect(get).toHaveBeenCalledExactlyOnceWith({ provider: "codex", connectionId }, ["models"]);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("does not silently choose the first account when the default Connection is ambiguous", async () => {
    const { layer, get } = harness({
      connections: [
        { id: connectionId, harness: "codex", lifecycle: "active" },
        { id: ProviderConnectionId.make("other"), harness: "codex", lifecycle: "active" },
      ] as ProviderConnection[],
    });
    await expect(
      Effect.runPromise(
        Effect.gen(function* () {
          return yield* (yield* ProviderDiscoveryService).listModels({ provider: "codex" });
        }).pipe(Effect.provide(layer)),
      ),
    ).rejects.toThrow("Managed provider discovery");
    expect(get).not.toHaveBeenCalled();
  });

  it("keeps usable models from a failed refresh but reports an initial load failure", async () => {
    for (const usable of [true, false]) {
      const { layer } = harness({
        snapshot: {
          version: usable ? 1 : 0,
          error: "catalog offline",
          ...(usable ? { models: [{ slug: "model-a", name: "Model A" }] } : {}),
        },
      });
      const program = Effect.gen(function* () {
        return yield* (yield* ProviderDiscoveryService).listModels({
          provider: "codex",
          connectionId,
        });
      }).pipe(Effect.provide(layer));
      if (usable) expect((await Effect.runPromise(program)).models).toHaveLength(1);
      else await expect(Effect.runPromise(program)).rejects.toThrow("catalog offline");
    }
  });

  it("uses a model from the shared catalog for a tool-free Connection probe", async () => {
    const probe = vi.fn(() => Effect.succeed(true));
    const { layer, get, resolve } = harness({
      provider: "opencode",
      snapshot: {
        version: 1,
        error: null,
        models: [
          { slug: "opencode-go/deepseek-pro", name: "Pro" },
          {
            slug: "opencode-go/deepseek-flash",
            name: "Flash",
            supportedReasoningEfforts: [{ value: "high" }, { value: "low" }],
          },
        ],
      },
      adapter: { probeTurnEndpoint: probe },
    });
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* (yield* ProviderDiscoveryService).probeConnection({
          provider: "opencode",
          connectionId,
        });
      }).pipe(Effect.provide(layer)),
    );
    expect(result).toBe(true);
    expect(get).toHaveBeenCalledExactlyOnceWith({ provider: "opencode", connectionId }, ["models"]);
    expect(probe).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ model: "opencode-go/deepseek-flash", effort: "low" }),
    );
    expect(resolve).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ connectionId, internalProviderId: "opencode-go" }),
    );
  });
});
