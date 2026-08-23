import { Effect, Layer } from "effect";
import { describe, expect, it, vi } from "vitest";

import {
  CodexTextGeneration,
  OpenCodeTextGeneration,
  type TextGenerationShape,
  TextGeneration,
} from "../Services/TextGeneration.ts";
import { ProviderTextGenerationLive } from "./ProviderTextGeneration.ts";

function createTextGenerationDouble(label: string) {
  const generateThreadTitle = vi.fn<TextGenerationShape["generateThreadTitle"]>(() =>
    Effect.succeed({
      title: `${label} title`,
    }),
  );
  return {
    service: {
      generateThreadTitle,
    } satisfies TextGenerationShape,
    generateThreadTitle,
  };
}

function makeProviderTextGenerationTestLayer() {
  const codex = createTextGenerationDouble("codex");
  const opencode = createTextGenerationDouble("opencode");
  const layer = ProviderTextGenerationLive.pipe(
    Layer.provide(Layer.succeed(CodexTextGeneration, codex.service)),
    Layer.provide(Layer.succeed(OpenCodeTextGeneration, opencode.service)),
  );

  return { layer, codex, opencode };
}

describe("ProviderTextGenerationLive", () => {
  it("routes explicit OpenCode model selections and preserves provider options", async () => {
    const { layer, codex, opencode } = makeProviderTextGenerationTestLayer();

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const textGeneration = yield* TextGeneration;
        return yield* textGeneration.generateThreadTitle({
          cwd: "/repo",
          message: "Plan the deployment work",
          modelSelection: {
            provider: "opencode",
            model: "openai/gpt-5",
            options: {
              agent: "plan",
              variant: "balanced",
            },
          },
          providerOptions: {
            opencode: {
              binaryPath: "/custom/bin/opencode",
              serverUrl: "http://127.0.0.1:4096",
            },
          },
        });
      }).pipe(Effect.provide(layer)),
    );

    expect(result.title).toBe("opencode title");
    expect(opencode.generateThreadTitle).toHaveBeenCalledWith(
      expect.objectContaining({
        modelSelection: {
          provider: "opencode",
          model: "openai/gpt-5",
          options: {
            agent: "plan",
            variant: "balanced",
          },
        },
        providerOptions: {
          opencode: {
            binaryPath: "/custom/bin/opencode",
            serverUrl: "http://127.0.0.1:4096",
          },
        },
      }),
    );
    expect(codex.generateThreadTitle).not.toHaveBeenCalled();
  });
});
