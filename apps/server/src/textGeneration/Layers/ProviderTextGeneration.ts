import { Effect, Layer } from "effect";

import { parseOpenCodeModelSlug } from "../../provider/opencodeRuntime.ts";
import { withAuxiliaryNativeState } from "../auxiliaryNativeState.ts";
import { TextGenerationError } from "../Errors.ts";
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
    generateThreadTitle: (input) => {
      if (input.modelSelection?.provider === "claudeAgent") {
        return Effect.fail(
          new TextGenerationError({
            operation: "generateThreadTitle",
            detail: "Claude does not provide dedicated title generation.",
          }),
        );
      }
      const implementation = resolveImplementation(input);
      return input.managedLaunch
        ? withAuxiliaryNativeState(
            implementation === openCodeTextGeneration ? "opencode" : "codex",
            input.managedLaunch,
            (managedLaunch) => implementation.generateThreadTitle({ ...input, managedLaunch }),
          )
        : implementation.generateThreadTitle(input);
    },
  } satisfies TextGenerationShape;
});

export const ProviderTextGenerationLive = Layer.effect(TextGeneration, makeProviderTextGeneration);
