import { DEFAULT_SERVER_SETTINGS } from "@penkra/contracts";
import { describe, expect, it } from "vitest";
import { resolveDefaultConnection } from "./defaultConnection.ts";

import { connectionFixture } from "./defaultConnection.test-fixture.ts";

describe("host default Connection resolution", () => {
  for (const provider of ["codex", "claudeAgent", "opencode"] as const) {
    it(`${provider}: honors defaults and overrides regardless of connection order`, () => {
      const first = connectionFixture(provider, "first");
      const chosen = connectionFixture(provider, "chosen");
      const settings = {
        ...DEFAULT_SERVER_SETTINGS,
        providers: {
          ...DEFAULT_SERVER_SETTINGS.providers,
          [provider]: {
            ...DEFAULT_SERVER_SETTINGS.providers[provider],
            defaultConnectionId: chosen.id,
          },
        },
      };
      for (const connections of [
        [first, chosen],
        [chosen, first],
      ]) {
        expect(resolveDefaultConnection({ provider, settings, connections })).toBe(chosen.id);
        expect(
          resolveDefaultConnection({ provider, settings, connections, connectionId: first.id }),
        ).toBe(first.id);
      }
      expect(() => resolveDefaultConnection({ provider, settings, connections: [first] })).toThrow(
        "unavailable",
      );
      expect(() =>
        resolveDefaultConnection({
          provider,
          settings: DEFAULT_SERVER_SETTINGS,
          connections: [first, chosen],
        }),
      ).toThrow("Choose a default");
      expect(
        resolveDefaultConnection({
          provider,
          settings: DEFAULT_SERVER_SETTINGS,
          connections: [chosen],
        }),
      ).toBe(chosen.id);
    });
  }

  it("keeps explicit OpenCode Free distinct from Go/Zen accounts", () => {
    const go = connectionFixture("opencode", "go");
    const zen = { ...connectionFixture("opencode", "zen"), authenticationTargetId: "opencode" };
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      providers: {
        ...DEFAULT_SERVER_SETTINGS.providers,
        opencode: { ...DEFAULT_SERVER_SETTINGS.providers.opencode, defaultConnectionId: null },
      },
    };
    expect(
      resolveDefaultConnection({ provider: "opencode", settings, connections: [go, zen] }),
    ).toBeNull();
    expect(
      resolveDefaultConnection({
        provider: "opencode",
        settings,
        connections: [go, zen],
        connectionId: zen.id,
      }),
    ).toBe(zen.id);
    expect(() =>
      resolveDefaultConnection({
        provider: "codex",
        settings,
        connections: [],
        connectionId: null,
      }),
    ).toThrow("anonymous");
  });
});
