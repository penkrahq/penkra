import {
  DEFAULT_SERVER_SETTINGS,
  ProviderConnectionId,
  type ProviderKind,
  type ServerSettings,
  type ServerSettingsPatch,
} from "@penkra/contracts";
import { describe, expect, it } from "vitest";
import { applyServerSettingsPatch } from "./serverSettings";

const alpha = ProviderConnectionId.makeUnsafe("alpha");
const beta = ProviderConnectionId.makeUnsafe("beta");

function settingsWithDefault(
  provider: ProviderKind,
  defaultConnectionId?: typeof alpha | null,
): ServerSettings {
  return {
    ...DEFAULT_SERVER_SETTINGS,
    providers: {
      ...DEFAULT_SERVER_SETTINGS.providers,
      [provider]: {
        ...DEFAULT_SERVER_SETTINGS.providers[provider],
        ...(defaultConnectionId !== undefined ? { defaultConnectionId } : {}),
      },
    },
  };
}

type ProviderPatchValues = {
  initializeDefaultConnectionId?: typeof alpha | null;
  defaultConnectionId?: typeof alpha | null;
  experimentalWebSockets?: boolean;
};

function providerPatch(provider: ProviderKind, values: ProviderPatchValues): ServerSettingsPatch {
  if (provider === "codex") return { providers: { codex: values } };
  if (provider === "claudeAgent") return { providers: { claudeAgent: values } };
  return { providers: { opencode: values } };
}

function expectSeedNotPersisted(settings: ServerSettings, provider: ProviderKind): void {
  expect(settings.providers[provider]).not.toHaveProperty("initializeDefaultConnectionId");
}

describe("default Connection migration matrix", () => {
  for (const provider of ["codex", "claudeAgent", "opencode"] as const) {
    it(`${provider}: missing default plus seed alpha applies alpha without persisting seed`, () => {
      const next = applyServerSettingsPatch(
        DEFAULT_SERVER_SETTINGS,
        providerPatch(provider, {
          initializeDefaultConnectionId: alpha,
        }),
      );

      expect(next.providers[provider].defaultConnectionId).toBe(alpha);
      expectSeedNotPersisted(next, provider);
    });

    it(`${provider}: existing default alpha wins over seed beta without persisting seed`, () => {
      const next = applyServerSettingsPatch(
        settingsWithDefault(provider, alpha),
        providerPatch(provider, { initializeDefaultConnectionId: beta }),
      );

      expect(next.providers[provider].defaultConnectionId).toBe(alpha);
      expectSeedNotPersisted(next, provider);
    });

    it(`${provider}: explicit beta in the same patch wins over seed alpha`, () => {
      const next = applyServerSettingsPatch(
        DEFAULT_SERVER_SETTINGS,
        providerPatch(provider, {
          initializeDefaultConnectionId: alpha,
          defaultConnectionId: beta,
        }),
      );

      expect(next.providers[provider].defaultConnectionId).toBe(beta);
      expectSeedNotPersisted(next, provider);
    });

    it(`${provider}: seed alpha first then explicit beta results in beta`, () => {
      const seeded = applyServerSettingsPatch(
        DEFAULT_SERVER_SETTINGS,
        providerPatch(provider, { initializeDefaultConnectionId: alpha }),
      );
      const next = applyServerSettingsPatch(
        seeded,
        providerPatch(provider, { defaultConnectionId: beta }),
      );

      expect(next.providers[provider].defaultConnectionId).toBe(beta);
      expectSeedNotPersisted(next, provider);
    });

    it(`${provider}: explicit beta first then delayed seed alpha remains beta`, () => {
      const explicitlySelected = applyServerSettingsPatch(
        DEFAULT_SERVER_SETTINGS,
        providerPatch(provider, { defaultConnectionId: beta }),
      );
      const next = applyServerSettingsPatch(
        explicitlySelected,
        providerPatch(provider, { initializeDefaultConnectionId: alpha }),
      );

      expect(next.providers[provider].defaultConnectionId).toBe(beta);
      expectSeedNotPersisted(next, provider);
    });

    it(`${provider}: applying identical seed twice is deep-equal and does not persist command`, () => {
      const patch = providerPatch(provider, { initializeDefaultConnectionId: alpha });
      const once = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, patch);
      const twice = applyServerSettingsPatch(once, patch);

      expect(twice).toEqual(once);
      expectSeedNotPersisted(once, provider);
      expectSeedNotPersisted(twice, provider);
    });

    it(`${provider}: empty patch preserves deep equality and does not mutate original`, () => {
      const current = settingsWithDefault(provider, alpha);
      const original = structuredClone(current);

      expect(applyServerSettingsPatch(current, {})).toEqual(current);
      expect(current).toEqual(original);
    });
  }

  it("opencode: missing default plus null seed applies established anonymous choice", () => {
    const next = applyServerSettingsPatch(
      DEFAULT_SERVER_SETTINGS,
      providerPatch("opencode", { initializeDefaultConnectionId: null }),
    );

    expect(next.providers.opencode.defaultConnectionId).toBeNull();
    expectSeedNotPersisted(next, "opencode");
  });

  it("opencode: established null default is not replaced by paid seed alpha", () => {
    const next = applyServerSettingsPatch(
      settingsWithDefault("opencode", null),
      providerPatch("opencode", { initializeDefaultConnectionId: alpha }),
    );

    expect(next.providers.opencode.defaultConnectionId).toBeNull();
    expectSeedNotPersisted(next, "opencode");
  });

  it("opencode: explicit null beats paid alpha seed in the same patch", () => {
    const next = applyServerSettingsPatch(
      DEFAULT_SERVER_SETTINGS,
      providerPatch("opencode", {
        initializeDefaultConnectionId: alpha,
        defaultConnectionId: null,
      }),
    );

    expect(next.providers.opencode.defaultConnectionId).toBeNull();
    expectSeedNotPersisted(next, "opencode");
  });

  it("opencode: established paid alpha is replaced by explicit null", () => {
    const next = applyServerSettingsPatch(
      settingsWithDefault("opencode", alpha),
      providerPatch("opencode", { defaultConnectionId: null }),
    );

    expect(next.providers.opencode.defaultConnectionId).toBeNull();
  });

  it("opencode: established null is replaced by explicit paid beta", () => {
    const next = applyServerSettingsPatch(
      settingsWithDefault("opencode", null),
      providerPatch("opencode", { defaultConnectionId: beta }),
    );

    expect(next.providers.opencode.defaultConnectionId).toBe(beta);
  });

  it("cross-provider seeds apply independently for Codex alpha, Claude beta, and OpenCode null", () => {
    const next = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      providers: {
        codex: { initializeDefaultConnectionId: alpha },
        claudeAgent: { initializeDefaultConnectionId: beta },
        opencode: { initializeDefaultConnectionId: null },
      },
    });

    expect(next.providers.codex.defaultConnectionId).toBe(alpha);
    expect(next.providers.claudeAgent.defaultConnectionId).toBe(beta);
    expect(next.providers.opencode.defaultConnectionId).toBeNull();
    expectSeedNotPersisted(next, "codex");
    expectSeedNotPersisted(next, "claudeAgent");
    expectSeedNotPersisted(next, "opencode");
  });

  it("updating Codex default preserves Claude, OpenCode, and text-generation settings", () => {
    const current: ServerSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      textGenerationModelSelection: { provider: "opencode", model: "model-alpha" },
      providers: {
        ...DEFAULT_SERVER_SETTINGS.providers,
        claudeAgent: {
          ...DEFAULT_SERVER_SETTINGS.providers.claudeAgent,
          defaultConnectionId: beta,
        },
        opencode: {
          ...DEFAULT_SERVER_SETTINGS.providers.opencode,
          defaultConnectionId: null,
          experimentalWebSockets: true,
        },
      },
    };
    const claudeBefore = structuredClone(current.providers.claudeAgent);
    const opencodeBefore = structuredClone(current.providers.opencode);
    const selectionBefore = structuredClone(current.textGenerationModelSelection);

    const next = applyServerSettingsPatch(current, {
      providers: { codex: { defaultConnectionId: alpha } },
    });

    expect(next.providers.codex.defaultConnectionId).toBe(alpha);
    expect(next.providers.claudeAgent).toEqual(claudeBefore);
    expect(next.providers.opencode).toEqual(opencodeBefore);
    expect(next.textGenerationModelSelection).toEqual(selectionBefore);
  });

  it("provider default patch preserves opencode.experimentalWebSockets in the same patch", () => {
    const next = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      providers: {
        opencode: {
          defaultConnectionId: alpha,
          experimentalWebSockets: true,
        },
      },
    });

    expect(next.providers.opencode.defaultConnectionId).toBe(alpha);
    expect(next.providers.opencode.experimentalWebSockets).toBe(true);
  });

  it("current and patch objects remain unchanged after migration and settings application", () => {
    const current: ServerSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      providers: {
        ...DEFAULT_SERVER_SETTINGS.providers,
        opencode: {
          ...DEFAULT_SERVER_SETTINGS.providers.opencode,
          experimentalWebSockets: false,
        },
      },
    };
    const patch: ServerSettingsPatch = {
      providers: {
        opencode: { initializeDefaultConnectionId: null, experimentalWebSockets: true },
      },
      textGenerationModelSelection: { provider: "opencode", model: "model-alpha" },
    };
    const currentBefore = structuredClone(current);
    const patchBefore = structuredClone(patch);

    const next = applyServerSettingsPatch(current, patch);

    expect(next.providers.opencode.defaultConnectionId).toBeNull();
    expect(next.providers.opencode.experimentalWebSockets).toBe(true);
    expect(current).toEqual(currentBefore);
    expect(patch).toEqual(patchBefore);
    expectSeedNotPersisted(next, "opencode");
  });
});
