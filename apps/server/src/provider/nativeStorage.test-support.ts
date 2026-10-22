import { Effect, Layer } from "effect";
import { ProviderConnectionRepositoryLive } from "../persistence/Layers/ProviderConnections.ts";
import { ProviderInstallationRepositoryLive } from "../persistence/Layers/ProviderInstallations.ts";
import { ProviderUnsupportedError } from "./Errors.ts";
import { ProviderAdapterRegistry } from "./Services/ProviderAdapterRegistry.ts";

/** Non-OpenCode lifecycle fixtures must never invoke a native storage adapter. */
export const NativeStorageTestLayer = Layer.mergeAll(
  ProviderConnectionRepositoryLive,
  ProviderInstallationRepositoryLive,
  Layer.succeed(ProviderAdapterRegistry, {
    getByProvider: (provider) => Effect.fail(new ProviderUnsupportedError({ provider })),
    listProviders: () => Effect.succeed([]),
  }),
);
