import { Effect, Layer } from "effect";

import { parseOpenCodeModelSlug } from "../../provider/opencodeRuntime.ts";
import {
  CodexTextGeneration,
  OpenCodeTextGeneration,
  type TextGenerationShape,
  TextGeneration,
} from "../Services/TextGeneration.ts";

const makeProviderTextGeneration = Effect.gen(function* () {
  const codexTextGeneration = yield* CodexTextGeneration;
  const openCodeTextGeneration = yield* OpenCodeTextGeneration;

  const resolveImplementation = (input: {
    readonly model?: string;
    readonly modelSelection?: { provider: string };
  }): TextGenerationShape => {
    if (input.modelSelection?.provider === "opencode") {
      return openCodeTextGeneration;
    }
    return parseOpenCodeModelSlug(input.model) !== null
      ? openCodeTextGeneration
      : codexTextGeneration;
  };

  return {
    generateThreadTitle: (input) => resolveImplementation(input).generateThreadTitle(input),
  } satisfies TextGenerationShape;
});

export const ProviderTextGenerationLive = Layer.effect(TextGeneration, makeProviderTextGeneration);
