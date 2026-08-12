import {
  ProviderConnectionId,
  ProviderInstallationId,
  type ProviderConnectionsSnapshot,
} from "@penkra/contracts";
import { describe, expect, it } from "vitest";

import {
  activeConnectionProviders,
  declaredConnectionProviders,
} from "./managedConnectionProviders";

const timestamp = "2026-08-09T00:00:00.000Z";

function snapshot(input: Partial<ProviderConnectionsSnapshot> = {}): ProviderConnectionsSnapshot {
  return {
    connections: [],
    installations: [],
    spaceDefaults: [],
    anonymousRoutes: [],
    authenticationMethods: [],
    ...input,
  };
}

describe("managed Connection providers", () => {
  it("shows only installed agents with a server-declared Connection or anonymous route", () => {
    expect(
      declaredConnectionProviders(
        snapshot({
          installations: [
            {
              id: ProviderInstallationId.makeUnsafe("installation-codex"),
              harness: "codex",
              version: "1.0.0",
              platform: "darwin",
              architecture: "arm64",
              adapterVersion: "1.0.0",
              protocolVersion: "1",
              lifecycle: "active",
              healthReason: null,
              installedAt: timestamp,
              activatedAt: timestamp,
              retiredAt: null,
            },
            {
              id: ProviderInstallationId.makeUnsafe("installation-pi"),
              harness: "pi",
              version: "1.0.0",
              platform: "darwin",
              architecture: "arm64",
              adapterVersion: "1.0.0",
              protocolVersion: "1",
              lifecycle: "active",
              healthReason: null,
              installedAt: timestamp,
              activatedAt: timestamp,
              retiredAt: null,
            },
          ],
          authenticationMethods: [
            {
              harness: "codex",
              authenticationTargetId: "openai-first-party",
              authenticationMethodId: "chatgpt",
              kind: "managed-login",
              label: "ChatGPT account",
              internalProviderIds: [null],
            },
            {
              harness: "pi",
              authenticationTargetId: "pi-first-party",
              authenticationMethodId: "account",
              kind: "managed-login",
              label: "Pi account",
              internalProviderIds: [null],
            },
          ],
        }),
      ),
    ).toEqual(["codex", "pi"]);
  });

  it("derives Space rows only from active Connections", () => {
    expect(
      activeConnectionProviders(
        snapshot({
          connections: [
            {
              id: ProviderConnectionId.makeUnsafe("connection-opencode"),
              harness: "opencode",
              authenticationTargetId: "opencode-go",
              authenticationMethodId: "api-key",
              label: "Go",
              providerIdentityId: null,
              health: "ready",
              healthReason: null,
              lastCheckedAt: timestamp,
              lifecycle: "active",
              terminationReason: null,
              terminatedAt: null,
              createdAt: timestamp,
              updatedAt: timestamp,
            },
            {
              id: ProviderConnectionId.makeUnsafe("connection-claude-retired"),
              harness: "claudeAgent",
              authenticationTargetId: "anthropic-first-party",
              authenticationMethodId: "api-key",
              label: "Old",
              providerIdentityId: null,
              health: "unavailable",
              healthReason: null,
              lastCheckedAt: timestamp,
              lifecycle: "terminated",
              terminationReason: "disconnected",
              terminatedAt: timestamp,
              createdAt: timestamp,
              updatedAt: timestamp,
            },
          ],
        }),
      ),
    ).toEqual(["opencode"]);
  });
});
