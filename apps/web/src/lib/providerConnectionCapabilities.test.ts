import { ProviderConnectionId, type ProviderConnectionsSnapshot } from "@penkra/contracts";
import { describe, expect, it } from "vitest";

import {
  anonymousRouteAuthorizesModel,
  connectionAuthorizesModel,
  isManagedHarnessConfigured,
  reconcileComposerConnectionSelection,
  resolveComposerConnection,
  resolveComposerConnectionAtAdmission,
} from "./providerConnectionCapabilities";

const goConnectionId = ProviderConnectionId.makeUnsafe("00000000-0000-4000-8000-000000000001");
const zenConnectionId = ProviderConnectionId.makeUnsafe("00000000-0000-4000-8000-000000000002");
const snapshot = {
  installations: [],
  connections: [
    {
      id: goConnectionId,
      harness: "opencode",
      authenticationTargetId: "opencode-go",
      authenticationMethodId: "api-key",
      lifecycle: "active",
    },
    {
      id: zenConnectionId,
      harness: "opencode",
      authenticationTargetId: "opencode-zen",
      authenticationMethodId: "api-key",
      lifecycle: "active",
    },
  ],
  authenticationMethods: [
    {
      harness: "opencode",
      authenticationTargetId: "opencode-go",
      authenticationMethodId: "api-key",
      internalProviderIds: ["opencode-go"],
    },
    {
      harness: "opencode",
      authenticationTargetId: "opencode-zen",
      authenticationMethodId: "api-key",
      internalProviderIds: ["opencode"],
    },
  ],
  anonymousRoutes: [{ harness: "opencode", internalProviderId: "opencode" }],
} as unknown as ProviderConnectionsSnapshot;

describe("provider Connection capabilities", () => {
  it("exposes a harness only through an active managed installation and an exact route", () => {
    expect(isManagedHarnessConfigured({ snapshot, provider: "opencode" })).toBe(false);
    const installedSnapshot = {
      ...snapshot,
      installations: [{ harness: "opencode", lifecycle: "active" }],
    } as unknown as ProviderConnectionsSnapshot;
    expect(isManagedHarnessConfigured({ snapshot: installedSnapshot, provider: "opencode" })).toBe(
      true,
    );
    expect(isManagedHarnessConfigured({ snapshot: installedSnapshot, provider: "codex" })).toBe(
      false,
    );
  });

  it("keeps OpenCode Go and anonymous Zen routes distinct", () => {
    expect(
      connectionAuthorizesModel({
        snapshot,
        connectionId: goConnectionId,
        provider: "opencode",
        model: "opencode-go/kimi-k2.5",
      }),
    ).toBe(true);
    expect(
      connectionAuthorizesModel({
        snapshot,
        connectionId: goConnectionId,
        provider: "opencode",
        model: "opencode/gpt-5-nano",
      }),
    ).toBe(false);
    expect(
      anonymousRouteAuthorizesModel({
        snapshot,
        provider: "opencode",
        model: "opencode/gpt-5-nano",
        availableConnectionIds: [null],
      }),
    ).toBe(true);
    expect(
      anonymousRouteAuthorizesModel({
        snapshot,
        provider: "opencode",
        model: "opencode-go/kimi-k2.5",
        availableConnectionIds: [goConnectionId],
      }),
    ).toBe(false);
    expect(
      connectionAuthorizesModel({
        snapshot,
        connectionId: zenConnectionId,
        provider: "opencode",
        model: "opencode/gpt-5-nano",
        availableConnectionIds: [zenConnectionId],
      }),
    ).toBe(true);
    expect(
      connectionAuthorizesModel({
        snapshot,
        connectionId: zenConnectionId,
        provider: "opencode",
        model: "opencode/nemotron-free",
        availableConnectionIds: [null, zenConnectionId],
      }),
    ).toBe(true);
    expect(
      anonymousRouteAuthorizesModel({
        snapshot,
        provider: "opencode",
        model: "opencode/gpt-5-nano",
      }),
    ).toBe(false);
  });

  it("preserves a started Thread's exact binding without falling through to another Connection", () => {
    const unavailableConnectionId = ProviderConnectionId.makeUnsafe(
      "00000000-0000-4000-8000-000000000099",
    );
    expect(
      resolveComposerConnection({
        snapshot,
        provider: "opencode",
        model: "opencode-go/kimi-k2.5",
        explicitSelection: { specified: false, connectionId: undefined },
        startedThreadBinding: { loaded: true, connectionId: unavailableConnectionId },
        hasThreadStarted: true,
      }),
    ).toBe(unavailableConnectionId);
    expect(
      resolveComposerConnection({
        snapshot,
        provider: "opencode",
        model: "opencode-go/kimi-k2.5",
        explicitSelection: { specified: true, connectionId: unavailableConnectionId },
        startedThreadBinding: { loaded: true, connectionId: goConnectionId },
        hasThreadStarted: true,
      }),
    ).toBeUndefined();
    expect(
      resolveComposerConnection({
        snapshot,
        provider: "opencode",
        model: "opencode-go/kimi-k2.5",
        explicitSelection: { specified: false, connectionId: undefined },
        startedThreadBinding: { loaded: false, connectionId: undefined },
        hasThreadStarted: false,
      }),
    ).toBe(goConnectionId);
  });

  it("honors the exact Connections that exposed a model in managed discovery", () => {
    expect(
      connectionAuthorizesModel({
        snapshot,
        connectionId: goConnectionId,
        provider: "opencode",
        model: "opencode-go/kimi-k2.5",
        availableConnectionIds: [null],
      }),
    ).toBe(false);
    expect(
      anonymousRouteAuthorizesModel({
        snapshot,
        provider: "opencode",
        model: "opencode/gpt-5-nano",
        availableConnectionIds: [goConnectionId],
      }),
    ).toBe(false);
  });

  it("treats an anonymous OpenCode model as a model route, not a Connection choice", () => {
    expect(
      resolveComposerConnection({
        snapshot,
        provider: "opencode",
        model: "opencode/gpt-5-nano",
        availableConnectionIds: [null],
        explicitSelection: { specified: false, connectionId: undefined },
        startedThreadBinding: { loaded: false, connectionId: undefined },
        hasThreadStarted: false,
      }),
    ).toBeNull();
    expect(
      reconcileComposerConnectionSelection({
        snapshot,
        provider: "opencode",
        model: "opencode/gpt-5-nano",
        availableConnectionIds: [null],
        current: { specified: true, connectionId: goConnectionId },
      }),
    ).toEqual({ specified: true, connectionId: null });
  });

  it("preserves an exact compatible Connection and clears an incompatible explicit choice", () => {
    expect(
      reconcileComposerConnectionSelection({
        snapshot,
        provider: "opencode",
        model: "opencode-go/kimi-k2.5",
        availableConnectionIds: [goConnectionId],
        current: { specified: true, connectionId: goConnectionId },
      }),
    ).toEqual({ specified: true, connectionId: goConnectionId });
    expect(
      reconcileComposerConnectionSelection({
        snapshot,
        provider: "opencode",
        model: "opencode-go/kimi-k2.5",
        availableConnectionIds: [goConnectionId],
        current: { specified: true, connectionId: null },
      }),
    ).toEqual({ specified: false, connectionId: undefined });
  });

  it("re-reads available Connections when a managed login completed behind the composer", async () => {
    const staleSnapshot = {
      ...snapshot,
      connections: [],
    } as unknown as ProviderConnectionsSnapshot;
    let refreshCount = 0;
    await expect(
      resolveComposerConnectionAtAdmission({
        snapshot: staleSnapshot,
        refreshSnapshot: async () => {
          refreshCount += 1;
          return snapshot;
        },
        provider: "opencode",
        model: "opencode-go/kimi-k2.5",
        availableConnectionIds: [goConnectionId],
        explicitSelection: { specified: false, connectionId: undefined },
        startedThreadBinding: { loaded: false, connectionId: undefined },
        hasThreadStarted: false,
      }),
    ).resolves.toBe(goConnectionId);
    expect(refreshCount).toBe(1);
  });

  it("re-reads exact model routes after a Connection login invalidates discovery", async () => {
    let modelRefreshCount = 0;
    await expect(
      resolveComposerConnectionAtAdmission({
        snapshot,
        refreshSnapshot: async () => snapshot,
        refreshAvailableConnectionIds: async () => {
          modelRefreshCount += 1;
          return [goConnectionId];
        },
        provider: "opencode",
        model: "opencode-go/kimi-k2.5",
        availableConnectionIds: [],
        explicitSelection: { specified: false, connectionId: undefined },
        startedThreadBinding: { loaded: false, connectionId: undefined },
        hasThreadStarted: false,
      }),
    ).resolves.toBe(goConnectionId);
    expect(modelRefreshCount).toBe(1);
  });
});
