import { Effect, Layer } from "effect";

import { CodexTextGenerationServiceLive } from "./Layers/CodexTextGeneration";
import { makeOpenCodeTextGenerationServiceLive } from "./Layers/OpenCodeTextGeneration";
import { ProviderTextGenerationLive } from "./Layers/ProviderTextGeneration";
import { OpenCodeRuntimeLive } from "../provider/opencodeRuntime";
import {
  makeProviderServerPasswordResolver,
  ProviderCredentials,
  ProviderCredentialsLive,
} from "../providerCredentials";

const textGenerationProviderLayers = Effect.gen(function* () {
  const credentials = yield* ProviderCredentials;
  const resolveProviderServerPassword = makeProviderServerPasswordResolver(credentials);
  return Layer.mergeAll(
    makeOpenCodeTextGenerationServiceLive(resolveProviderServerPassword).pipe(
      Layer.provide(OpenCodeRuntimeLive),
    ),
  );
}).pipe(Effect.provide(ProviderCredentialsLive.pipe(Layer.orDie)), Layer.unwrap);

export const TextGenerationLayerLive = ProviderTextGenerationLive.pipe(
  Layer.provide(CodexTextGenerationServiceLive),
  Layer.provide(textGenerationProviderLayers),
);
