import * as NodeServices from "@effect/platform-node/NodeServices";
import { DEFAULT_MODEL_BY_PROVIDER } from "@penkra/contracts";
import { Effect, FileSystem, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { ServerConfig } from "./config";
import {
  migratePersistedServerSettings,
  ServerSettingsLive,
  ServerSettingsService,
} from "./serverSettings";

const serverConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "penkra-settings-test-",
}).pipe(Layer.provide(NodeServices.layer));
const makeTestLayer = Layer.merge(NodeServices.layer, serverConfigLayer);
const testLayer = Layer.merge(makeTestLayer, ServerSettingsLive.pipe(Layer.provide(makeTestLayer)));

const runWithSettings = <A, E>(
  effect: Effect.Effect<A, E, ServerSettingsService | ServerConfig | FileSystem.FileSystem>,
) => Effect.runPromise(effect.pipe(Effect.provide(testLayer)) as Effect.Effect<A, E, never>);

describe("ServerSettingsService", () => {
  it("migrates the legacy update-check boolean without overriding an explicit mode", () => {
    expect(migratePersistedServerSettings({ enableProviderUpdateChecks: false })).toEqual({
      providerUpdateMode: "notify",
    });
    expect(
      migratePersistedServerSettings({
        enableProviderUpdateChecks: false,
        providerUpdateMode: "automatic",
      }),
    ).toEqual({ providerUpdateMode: "automatic" });
  });

  it("loads defaults when settings file does not exist", async () => {
    const settings = await runWithSettings(
      Effect.gen(function* () {
        const service = yield* ServerSettingsService;
        yield* service.start;
        return yield* service.getSettings;
      }),
    );

    expect(settings.providers.codex).not.toHaveProperty("binaryPath");
    expect(Object.keys(settings.providers).sort()).toEqual(["claudeAgent", "codex", "opencode"]);
    expect(settings.providerUpdateMode).toBe("automatic");
  });

  it("persists updates and reloads them", async () => {
    const result = await runWithSettings(
      Effect.gen(function* () {
        const service = yield* ServerSettingsService;
        const { settingsPath } = yield* ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        yield* service.start;

        const updated = yield* service.updateSettings({
          enableAssistantStreaming: true,
          providerUpdateMode: "notify",
          providers: {
            codex: {
              customModels: ["gpt-custom"],
            },
          },
        });
        const raw = yield* fs.readFileString(settingsPath);
        return { updated, parsed: JSON.parse(raw) as unknown };
      }),
    );

    expect(result.updated.enableAssistantStreaming).toBe(true);
    expect(result.updated.providerUpdateMode).toBe("notify");
    expect(result.updated.providers.codex.customModels).toEqual(["gpt-custom"]);
    expect(result.parsed).toMatchObject({
      revision: 1,
      migrationVersion: 2,
      settings: {
        enableAssistantStreaming: true,
        providerUpdateMode: "notify",
        providers: {
          codex: {
            customModels: ["gpt-custom"],
          },
        },
      },
    });
  });

  it("does not silently replace a disabled text generation selection", async () => {
    const settings = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* ServerSettingsService;
        return yield* service.getSettings;
      }).pipe(
        Effect.provide(
          ServerSettingsService.layerTest({
            textGenerationModelSelection: {
              provider: "opencode",
              model: DEFAULT_MODEL_BY_PROVIDER.opencode,
            },
            providers: {
              opencode: { enabled: false },
            },
          }),
        ),
      ),
    );

    expect(settings.textGenerationModelSelection.provider).toBe("opencode");
    expect(settings.textGenerationModelSelection.model).toBe(DEFAULT_MODEL_BY_PROVIDER.opencode);
  });
});
