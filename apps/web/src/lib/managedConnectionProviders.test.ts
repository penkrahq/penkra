import { ProviderInstallationId, type ProviderConnectionsSnapshot } from "@penkra/contracts";
import { describe, expect, it } from "vitest";

import { declaredConnectionProviders } from "./managedConnectionProviders";

const timestamp = "2026-08-09T00:00:00.000Z";

function snapshot(input: Partial<ProviderConnectionsSnapshot> = {}): ProviderConnectionsSnapshot {
  return {
    connections: [],
    installations: [],
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
              id: ProviderInstallationId.makeUnsafe("installation-opencode"),
              harness: "opencode",
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
              harness: "opencode",
              authenticationTargetId: "opencode-first-party",
              authenticationMethodId: "account",
              kind: "managed-login",
              label: "OpenCode account",
              internalProviderIds: [null],
            },
          ],
        }),
      ),
    ).toEqual(["codex", "opencode"]);
  });
});
