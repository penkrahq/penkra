import {
  DEFAULT_SERVER_SETTINGS,
  type ProviderConnection,
  type ProviderConnectionId,
  type ProviderKind,
  type ServerSettings,
} from "@penkra/contracts";
import { describe, expect, it } from "vitest";
import { connectionFixture } from "./defaultConnection.test-fixture.ts";
import { resolveDefaultConnection } from "./defaultConnection.ts";

function settingsWithDefault(
  provider: ProviderKind,
  defaultConnectionId?: ProviderConnectionId | null,
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

function terminatedConnection(provider: ProviderKind): ProviderConnection {
  return {
    ...connectionFixture(provider, "retired"),
    lifecycle: "terminated",
    terminationReason: "signed-out",
    terminatedAt: "2026-09-05T01:00:00.000Z",
  };
}

function otherHarness(provider: ProviderKind): ProviderKind {
  return provider === "codex" ? "claudeAgent" : "codex";
}

describe("host default Connection resolution matrix", () => {
  for (const provider of ["codex", "claudeAgent", "opencode"] as const) {
    it(`${provider}: no default and zero matching active Connections`, () => {
      const result = () =>
        resolveDefaultConnection({
          provider,
          settings: DEFAULT_SERVER_SETTINGS,
          connections: [],
        });

      if (provider === "opencode") {
        expect(result()).toBeNull();
      } else {
        expect(result).toThrow("No Connection is available");
      }
    });

    it(`${provider}: no default and exactly one matching active Connection returns its ID`, () => {
      const connection = connectionFixture(provider, "alpha");

      expect(
        resolveDefaultConnection({
          provider,
          settings: DEFAULT_SERVER_SETTINGS,
          connections: [connection],
        }),
      ).toBe(connection.id);
    });

    for (const [label, connections] of [
      [
        "alpha then beta",
        [connectionFixture(provider, "alpha"), connectionFixture(provider, "beta")],
      ],
      [
        "beta then alpha",
        [connectionFixture(provider, "beta"), connectionFixture(provider, "alpha")],
      ],
    ] as const) {
      it(`${provider}: no default and two matching active Connections requires selection (${label})`, () => {
        expect(() =>
          resolveDefaultConnection({
            provider,
            settings: DEFAULT_SERVER_SETTINGS,
            connections,
          }),
        ).toThrow("Choose a default Connection");
      });
    }

    for (const [label, connections] of [
      [
        "active then terminated",
        [connectionFixture(provider, "alpha"), terminatedConnection(provider)],
      ],
      [
        "terminated then active",
        [terminatedConnection(provider), connectionFixture(provider, "alpha")],
      ],
    ] as const) {
      it(`${provider}: one matching active plus one terminated returns active ID (${label})`, () => {
        expect(
          resolveDefaultConnection({
            provider,
            settings: DEFAULT_SERVER_SETTINGS,
            connections,
          }),
        ).toBe(connections.find((connection) => connection.lifecycle === "active")!.id);
      });
    }

    it(`${provider}: no default and only terminated matching Connections has the zero-active outcome`, () => {
      const result = () =>
        resolveDefaultConnection({
          provider,
          settings: DEFAULT_SERVER_SETTINGS,
          connections: [terminatedConnection(provider)],
        });

      if (provider === "opencode") {
        expect(result()).toBeNull();
      } else {
        expect(result).toThrow("No Connection is available");
      }
    });

    for (const [label, connections] of [
      [
        "beta then retired",
        [
          connectionFixture(provider, "alpha"),
          connectionFixture(otherHarness(provider), "beta"),
          connectionFixture(otherHarness(provider), "retired"),
        ],
      ],
      [
        "retired then beta",
        [
          connectionFixture(provider, "alpha"),
          connectionFixture(otherHarness(provider), "retired"),
          connectionFixture(otherHarness(provider), "beta"),
        ],
      ],
    ] as const) {
      it(`${provider}: other-harness active Connections do not count (${label})`, () => {
        expect(
          resolveDefaultConnection({
            provider,
            settings: DEFAULT_SERVER_SETTINGS,
            connections,
          }),
        ).toBe(connections[0].id);
      });
    }

    for (const [label, connections] of [
      [
        "alpha then beta",
        [connectionFixture(provider, "alpha"), connectionFixture(provider, "beta")],
      ],
      [
        "beta then alpha",
        [connectionFixture(provider, "beta"), connectionFixture(provider, "alpha")],
      ],
    ] as const) {
      it(`${provider}: explicit active ID beats a different saved active default (${label})`, () => {
        const explicit = connectionFixture(provider, "alpha");

        expect(
          resolveDefaultConnection({
            provider,
            settings: settingsWithDefault(provider, connectionFixture(provider, "beta").id),
            connections,
            connectionId: explicit.id,
          }),
        ).toBe(explicit.id);
      });
    }

    it(`${provider}: explicit missing ID is unavailable despite saved default and active alternative`, () => {
      const saved = connectionFixture(provider, "beta");
      const alternative = connectionFixture(provider, "alpha");

      expect(() =>
        resolveDefaultConnection({
          provider,
          settings: settingsWithDefault(provider, saved.id),
          connections: [saved, alternative],
          connectionId: connectionFixture(provider, "unrelated").id,
        }),
      ).toThrow("unavailable");
    });

    it(`${provider}: explicit terminated ID is unavailable despite active alternative`, () => {
      expect(() =>
        resolveDefaultConnection({
          provider,
          settings: DEFAULT_SERVER_SETTINGS,
          connections: [terminatedConnection(provider), connectionFixture(provider, "alpha")],
          connectionId: connectionFixture(provider, "retired").id,
        }),
      ).toThrow("unavailable");
    });

    it(`${provider}: explicit other-harness ID is unavailable despite matching active alternative`, () => {
      const other = connectionFixture(otherHarness(provider), "unrelated");

      expect(() =>
        resolveDefaultConnection({
          provider,
          settings: DEFAULT_SERVER_SETTINGS,
          connections: [connectionFixture(provider, "alpha"), other],
          connectionId: other.id,
        }),
      ).toThrow("unavailable");
    });

    it(`${provider}: saved missing ID is unavailable when explicit ID is omitted`, () => {
      expect(() =>
        resolveDefaultConnection({
          provider,
          settings: settingsWithDefault(provider, connectionFixture(provider, "unrelated").id),
          connections: [connectionFixture(provider, "alpha")],
        }),
      ).toThrow("unavailable");
    });

    it(`${provider}: saved terminated ID is unavailable when explicit ID is omitted`, () => {
      expect(() =>
        resolveDefaultConnection({
          provider,
          settings: settingsWithDefault(provider, connectionFixture(provider, "retired").id),
          connections: [terminatedConnection(provider), connectionFixture(provider, "alpha")],
        }),
      ).toThrow("unavailable");
    });

    it(`${provider}: saved other-harness ID is unavailable when explicit ID is omitted`, () => {
      const other = connectionFixture(otherHarness(provider), "unrelated");

      expect(() =>
        resolveDefaultConnection({
          provider,
          settings: settingsWithDefault(provider, other.id),
          connections: [connectionFixture(provider, "alpha"), other],
        }),
      ).toThrow("unavailable");
    });

    it(`${provider}: explicit valid active ID beats stale missing saved default`, () => {
      const explicit = connectionFixture(provider, "alpha");

      expect(
        resolveDefaultConnection({
          provider,
          settings: settingsWithDefault(provider, connectionFixture(provider, "unrelated").id),
          connections: [explicit],
          connectionId: explicit.id,
        }),
      ).toBe(explicit.id);
    });

    it(`${provider}: successful and failing resolution leave settings and connections unchanged`, () => {
      const settings = settingsWithDefault(provider, connectionFixture(provider, "alpha").id);
      const expected = connectionFixture(provider, "alpha");
      const connections = [expected, connectionFixture(provider, "beta")];
      const settingsBefore = structuredClone(settings);
      const connectionsBefore = structuredClone(connections);
      const defaultSettingsBefore = structuredClone(DEFAULT_SERVER_SETTINGS);

      expect(resolveDefaultConnection({ provider, settings, connections })).toBe(expected.id);
      expect(() =>
        resolveDefaultConnection({
          provider,
          settings,
          connections,
          connectionId: connectionFixture(provider, "unrelated").id,
        }),
      ).toThrow("unavailable");

      expect(settings).toEqual(settingsBefore);
      expect(connections).toEqual(connectionsBefore);
      expect(DEFAULT_SERVER_SETTINGS).toEqual(defaultSettingsBefore);
    });

    if (provider === "opencode") {
      it("opencode: explicit null overrides a saved paid ID with two paid active Connections", () => {
        const savedPaid = connectionFixture("opencode", "alpha");
        const paid = [savedPaid, connectionFixture("opencode", "beta")];

        expect(
          resolveDefaultConnection({
            provider,
            settings: settingsWithDefault(provider, savedPaid.id),
            connections: paid,
            connectionId: null,
          }),
        ).toBeNull();
      });

      it("opencode: saved null and omitted explicit ID stays anonymous with paid Connections present", () => {
        expect(
          resolveDefaultConnection({
            provider,
            settings: settingsWithDefault(provider, null),
            connections: [connectionFixture("opencode", "alpha")],
          }),
        ).toBeNull();
      });

      it("opencode: explicit paid ID overrides saved null", () => {
        const paid = connectionFixture("opencode", "alpha");

        expect(
          resolveDefaultConnection({
            provider,
            settings: settingsWithDefault(provider, null),
            connections: [paid],
            connectionId: paid.id,
          }),
        ).toBe(paid.id);
      });
    } else {
      it(`${provider}: explicit null errors even with a valid saved active account`, () => {
        expect(() =>
          resolveDefaultConnection({
            provider,
            settings: settingsWithDefault(provider, connectionFixture(provider, "alpha").id),
            connections: [connectionFixture(provider, "alpha")],
            connectionId: null,
          }),
        ).toThrow("anonymous");
      });

      it(`${provider}: saved null and omitted explicit ID errors instead of selecting active account`, () => {
        expect(() =>
          resolveDefaultConnection({
            provider,
            settings: settingsWithDefault(provider, null),
            connections: [connectionFixture(provider, "alpha")],
          }),
        ).toThrow("anonymous");
      });
    }
  }
});
