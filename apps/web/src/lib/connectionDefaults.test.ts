import { DEFAULT_SERVER_SETTINGS, ProviderConnectionId } from "@penkra/contracts";
import { describe, expect, it } from "vitest";
import { connectionDefaultMigrationPatch } from "./connectionDefaults";

describe("connection default migration", () => {
  const pro = ProviderConnectionId.makeUnsafe("pro");
  const plus = ProviderConnectionId.makeUnsafe("plus");

  it("preserves the remembered account and explicit Free selection", () => {
    expect(
      connectionDefaultMigrationPatch(DEFAULT_SERVER_SETTINGS, { codex: pro, opencode: null }),
    ).toEqual({
      providers: {
        codex: { initializeDefaultConnectionId: pro },
        opencode: { initializeDefaultConnectionId: null },
      },
    });
  });

  it("does not overwrite an established host default with stale browser state", () => {
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      providers: {
        ...DEFAULT_SERVER_SETTINGS.providers,
        codex: { ...DEFAULT_SERVER_SETTINGS.providers.codex, defaultConnectionId: plus },
      },
    };
    expect(connectionDefaultMigrationPatch(settings, { codex: pro })).toEqual({ providers: {} });
  });
});
