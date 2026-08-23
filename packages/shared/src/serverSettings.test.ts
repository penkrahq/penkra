import { DEFAULT_SERVER_SETTINGS, ProviderSessionStartInput } from "@penkra/contracts";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { providerStartOptionsFromServerSettings } from "./serverSettings";

const decodeProviderSessionStartInput = Schema.decodeUnknownSync(ProviderSessionStartInput);

describe("providerStartOptionsFromServerSettings", () => {
  it("omits blank launch settings from provider session input", () => {
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      providers: {
        codex: { ...DEFAULT_SERVER_SETTINGS.providers.codex },
        claudeAgent: { ...DEFAULT_SERVER_SETTINGS.providers.claudeAgent },
        opencode: {
          ...DEFAULT_SERVER_SETTINGS.providers.opencode,
        },
      },
    };

    const providerOptions = providerStartOptionsFromServerSettings(settings);

    expect(() =>
      decodeProviderSessionStartInput({
        threadId: "thread-1",
        provider: "codex",
        providerOptions,
        runtimeMode: "full-access",
      }),
    ).not.toThrow();
    expect(providerOptions.codex).toEqual({});
    expect(providerOptions.claudeAgent).toEqual({});
    expect(providerOptions.opencode).toEqual({ experimentalWebSockets: false });
  });

  it("preserves supported launch settings without accepting external managed runtimes", () => {
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      providers: {
        ...DEFAULT_SERVER_SETTINGS.providers,
        opencode: {
          ...DEFAULT_SERVER_SETTINGS.providers.opencode,
          experimentalWebSockets: true,
        },
      },
    };

    const providerOptions = providerStartOptionsFromServerSettings(settings);

    expect(providerOptions.codex).toEqual({});
    expect(providerOptions.opencode).toEqual({
      experimentalWebSockets: true,
    });
  });
});
