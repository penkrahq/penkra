import {
  DEFAULT_SERVER_SETTINGS,
  ProviderConnectionId,
  ProviderSessionStartInput,
} from "@penkra/contracts";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { applyServerSettingsPatch, providerStartOptionsFromServerSettings } from "./serverSettings";

describe("default Connection migration", () => {
  const oldAccount = ProviderConnectionId.makeUnsafe("old-account");
  const chosenAccount = ProviderConnectionId.makeUnsafe("chosen-account");

  it("seeds missing defaults without persisting migration commands", () => {
    const next = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      providers: {
        codex: { initializeDefaultConnectionId: oldAccount },
        opencode: { initializeDefaultConnectionId: null },
      },
    });
    expect(next.providers.codex.defaultConnectionId).toBe(oldAccount);
    expect(next.providers.opencode.defaultConnectionId).toBeNull();
    expect(next.providers.codex).not.toHaveProperty("initializeDefaultConnectionId");
  });

  it("cannot overwrite a user selection that arrived before the migration", () => {
    const current = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      providers: {
        codex: { defaultConnectionId: chosenAccount },
        opencode: { defaultConnectionId: null },
      },
    });
    const next = applyServerSettingsPatch(current, {
      providers: {
        codex: { initializeDefaultConnectionId: oldAccount },
        opencode: { initializeDefaultConnectionId: oldAccount },
      },
    });
    expect(next).toEqual(current);
  });

  it("lets explicit selection win even when supplied with a seed", () => {
    const next = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      providers: {
        codex: { defaultConnectionId: chosenAccount, initializeDefaultConnectionId: oldAccount },
      },
    });
    expect(next.providers.codex.defaultConnectionId).toBe(chosenAccount);
  });
});

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
