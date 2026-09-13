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
  it.each(["codex", "opencode"] as const)(
    "preserves the exact %s selection while isolating managed title state",
    async (provider) => {
      const { layer, codex, opencode } = makeProviderTextGenerationTestLayer();
      const selected = provider === "codex" ? codex : opencode;
      const modelSelection =
        provider === "codex"
          ? ({ provider, model: "gpt-5.6-sol" } as const)
          : ({ provider, model: "opencode/big-pickle" } as const);
      const managedLaunch = {
        binaryPath: "/selected/binary",
        profileRoot: "/selected/profile",
        nativeStateRoot: "/conversation/native",
        isolationKey: "exact-connection",
        childEnvironment: () => ({ CODEX_HOME: "/selected/profile/codex-home" }),
      };
      await Effect.runPromise(
        Effect.gen(function* () {
          const generation = yield* TextGeneration;
          return yield* generation.generateThreadTitle({
            cwd: "/repo",
            message: "Plan the workshop",
            modelSelection,
            managedLaunch,
          });
        }).pipe(Effect.provide(layer)),
      );
      const forwarded = selected.generateThreadTitle.mock.calls[0]![0];
      expect(forwarded.modelSelection).toBe(modelSelection);
      expect(forwarded.managedLaunch?.profileRoot).toBe(managedLaunch.profileRoot);
      expect(forwarded.managedLaunch?.nativeStateRoot).not.toBe(managedLaunch.nativeStateRoot);
      expect((provider === "codex" ? opencode : codex).generateThreadTitle).not.toHaveBeenCalled();
    },
  );

  it("does not send Claude title requests to another provider", async () => {
    const { layer, codex, opencode } = makeProviderTextGenerationTestLayer();
    await Effect.runPromise(
      Effect.gen(function* () {
        const generation = yield* TextGeneration;
        return yield* generation
          .generateThreadTitle({
            cwd: "/repo",
            message: "Plan a workshop",
            modelSelection: { provider: "claudeAgent", model: "sonnet-5" },
          })
          .pipe(Effect.flip);
      }).pipe(Effect.provide(layer)),
    );
    expect(codex.generateThreadTitle).not.toHaveBeenCalled();
    expect(opencode.generateThreadTitle).not.toHaveBeenCalled();
  });

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
