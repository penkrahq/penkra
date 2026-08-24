import "../../index.css";

import { ProviderConnectionId, type ProviderConnection } from "@penkra/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { useState } from "react";

const nativeApi = vi.hoisted(() => ({
  listProviderUsage: vi.fn(),
  openExternal: vi.fn(),
}));

vi.mock("~/nativeApi", () => ({
  ensureNativeApi: () => ({
    server: { listProviderUsage: nativeApi.listProviderUsage },
    shell: { openExternal: nativeApi.openExternal },
  }),
}));

import { ComposerConnectionControl } from "./ComposerConnectionControl";

const timestamp = "2026-08-18T12:00:00.000Z";
const connections: ProviderConnection[] = [
  {
    id: ProviderConnectionId.makeUnsafe("account-a"),
    harness: "claudeAgent",
    authenticationTargetId: "anthropic-first-party",
    authenticationMethodId: "claude-account",
    label: "emmanuel@penkra.com",
    providerIdentityId: "emmanuel@penkra.com",
    health: "ready",
    healthReason: null,
    lastCheckedAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
    lifecycle: "active",
    terminatedAt: null,
    terminationReason: null,
  },
  {
    id: ProviderConnectionId.makeUnsafe("account-b"),
    harness: "claudeAgent",
    authenticationTargetId: "anthropic-first-party",
    authenticationMethodId: "claude-account",
    label: "e.atta@gigborg.com",
    providerIdentityId: "e.atta@gigborg.com",
    health: "ready",
    healthReason: null,
    lastCheckedAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
    lifecycle: "active",
    terminatedAt: null,
    terminationReason: null,
  },
  {
    id: ProviderConnectionId.makeUnsafe("api-key"),
    harness: "claudeAgent",
    authenticationTargetId: "anthropic-first-party",
    authenticationMethodId: "api-key",
    label: "sk-ant-…7Xq2",
    providerIdentityId: null,
    health: "ready",
    healthReason: null,
    lastCheckedAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
    lifecycle: "active",
    terminatedAt: null,
    terminationReason: null,
  },
];

function Harness() {
  const [selected, setSelected] = useState(connections[0]!.id);
  return (
    <ComposerConnectionControl
      provider="claudeAgent"
      connections={connections}
      selectedConnectionId={selected}
      onConnectionChange={setSelected}
    />
  );
}

describe("ComposerConnectionControl", () => {
  it("loads account usage on open, switches to a key, and opens the provider dashboard", async () => {
    nativeApi.listProviderUsage.mockResolvedValue([
      {
        provider: "claudeAgent",
        connectionId: connections[0]!.id,
        updatedAt: timestamp,
        limits: [
          { window: "5h", usedPercent: 38, windowDurationMins: 300 },
          { window: "Weekly", usedPercent: 52, windowDurationMins: 10_080 },
        ],
        usageLines: [],
        source: "test",
        status: "ok",
      },
      {
        provider: "claudeAgent",
        connectionId: connections[1]!.id,
        updatedAt: timestamp,
        limits: [{ window: "5h", usedPercent: 82, windowDurationMins: 300 }],
        usageLines: [],
        source: "test",
        status: "ok",
      },
      {
        provider: "claudeAgent",
        connectionId: connections[2]!.id,
        updatedAt: timestamp,
        limits: [],
        usageLines: [],
        source: "test",
        status: "unsupported",
      },
    ]);
    nativeApi.openExternal.mockResolvedValue(undefined);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <Harness />
      </QueryClientProvider>,
    );

    try {
      expect(nativeApi.listProviderUsage).not.toHaveBeenCalled();

      const trigger = page.getByRole("button", { name: "Change connection" });
      expect(trigger.element().querySelectorAll("svg")).toHaveLength(1);
      await trigger.hover();
      await expect.element(page.getByText("emmanuel@penkra.com", { exact: true })).toBeVisible();
      expect(nativeApi.listProviderUsage).not.toHaveBeenCalled();
      await trigger.click();
      await vi.waitFor(() => expect(nativeApi.listProviderUsage).toHaveBeenCalledTimes(1));
      expect(nativeApi.listProviderUsage).toHaveBeenCalledWith({
        provider: "claudeAgent",
        connectionIds: connections.map((connection) => connection.id),
      });

      await expect.element(page.getByText("Session", { exact: true })).toBeVisible();
      await expect.element(page.getByText("62%", { exact: true })).toBeVisible();
      const connectionSubmenuTrigger = page.getByRole("menuitem", {
        name: "emmanuel@penkra.com",
        exact: true,
      });
      await connectionSubmenuTrigger.click();
      await expect.element(page.getByText("e.atta@gigborg.com", { exact: true })).toBeVisible();
      await expect.element(page.getByText("18%", { exact: true })).toBeVisible();
      const apiKeyRow = page.getByRole("menuitem", { name: /sk-ant-…7Xq2/ });
      expect(apiKeyRow.element().querySelectorAll("svg")).toHaveLength(1);
      expect(page.getByText("Manage connections…", { exact: true }).query()).toBeNull();
      await apiKeyRow.click();

      await page.getByRole("button", { name: "Change connection" }).click();
      await expect
        .element(page.getByText("Usage isn’t available for API keys.", { exact: true }))
        .toBeVisible();
      await page.getByRole("menuitem", { name: "View usage in Anthropic" }).click();
      expect(nativeApi.openExternal).toHaveBeenCalledWith(
        "https://console.anthropic.com/settings/usage",
      );
    } finally {
      await screen.unmount();
      queryClient.clear();
    }
  });

  it("shows persisted account totals when Claude reports only a reset window", async () => {
    nativeApi.listProviderUsage.mockResolvedValue([
      {
        provider: "claudeAgent",
        connectionId: connections[0]!.id,
        updatedAt: timestamp,
        limits: [
          {
            window: "5h",
            resetsAt: "2026-08-18T17:00:00.000Z",
            windowDurationMins: 300,
          },
        ],
        usageLines: [{ label: "Today", value: "547.1K tokens", subtitle: "19 turns" }],
        source: "provider-runtime-rate-limits",
        status: "ok",
      },
    ]);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <Harness />
      </QueryClientProvider>,
    );

    try {
      await page.getByRole("button", { name: "Change connection" }).click();
      await expect.element(page.getByText("Today", { exact: false })).toBeVisible();
      await expect.element(page.getByText("547.1K tokens", { exact: true })).toBeVisible();
      await expect.element(page.getByText("19 turns", { exact: false })).toBeVisible();
      expect(page.getByText("Usage hasn’t been reported", { exact: false }).query()).toBeNull();
    } finally {
      await screen.unmount();
      queryClient.clear();
    }
  });
});
