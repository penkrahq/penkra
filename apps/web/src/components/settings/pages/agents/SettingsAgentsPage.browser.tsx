import "../../../../index.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const nativeApi = vi.hoisted(() => ({
  beginConnectionLogin: vi.fn(),
  cancelConnectionLogin: vi.fn(),
  createStaticConnection: vi.fn(),
  getConnectionLogin: vi.fn(),
  getConnections: vi.fn(),
  openExternal: vi.fn(),
  terminateConnection: vi.fn(),
  confirm: vi.fn(),
}));

vi.mock("~/nativeApi", () => ({
  ensureNativeApi: () => ({
    dialogs: { confirm: nativeApi.confirm },
    provider: {
      beginConnectionLogin: nativeApi.beginConnectionLogin,
      cancelConnectionLogin: nativeApi.cancelConnectionLogin,
      createStaticConnection: nativeApi.createStaticConnection,
      getConnectionLogin: nativeApi.getConnectionLogin,
      getConnections: nativeApi.getConnections,
      terminateConnection: nativeApi.terminateConnection,
    },
    shell: { openExternal: nativeApi.openExternal },
  }),
}));

import { SettingsAgentsPage } from "./SettingsAgentsPage";

const timestamp = "2026-08-09T00:00:00.000Z";
const installations = ["opencode", "claudeAgent", "codex"].map((harness, index) => ({
  id: `installation-${index}`,
  harness,
  version: "1.0.0",
  platform: "darwin",
  architecture: "arm64",
  adapterVersion: "1",
  protocolVersion: "1",
  lifecycle: "active" as const,
  healthReason: null,
  installedAt: timestamp,
  activatedAt: timestamp,
  retiredAt: null,
}));

const authenticationMethods = [
  {
    harness: "opencode" as const,
    authenticationTargetId: "opencode-zen",
    authenticationMethodId: "api-key",
    kind: "static-secret" as const,
    label: "OpenCode Zen",
    secretPlaceholder: "OpenCode Zen key",
    internalProviderIds: ["opencode"],
  },
  {
    harness: "opencode" as const,
    authenticationTargetId: "opencode-go",
    authenticationMethodId: "api-key",
    kind: "static-secret" as const,
    label: "OpenCode Go",
    secretPlaceholder: "OpenCode Go key",
    internalProviderIds: ["opencode-go"],
  },
  {
    harness: "claudeAgent" as const,
    authenticationTargetId: "anthropic-first-party",
    authenticationMethodId: "claude-account",
    kind: "managed-login" as const,
    label: "Sign in",
    internalProviderIds: [null],
  },
  {
    harness: "claudeAgent" as const,
    authenticationTargetId: "anthropic-first-party",
    authenticationMethodId: "api-key",
    kind: "static-secret" as const,
    label: "API key",
    secretPlaceholder: "Anthropic API key",
    internalProviderIds: [null],
  },
  {
    harness: "codex" as const,
    authenticationTargetId: "openai-first-party",
    authenticationMethodId: "chatgpt",
    kind: "managed-login" as const,
    label: "Sign in",
    internalProviderIds: [null],
  },
  {
    harness: "codex" as const,
    authenticationTargetId: "openai-first-party",
    authenticationMethodId: "api-key",
    kind: "managed-secret" as const,
    label: "API key",
    secretPlaceholder: "OpenAI API key",
    internalProviderIds: [null],
  },
];

function snapshot() {
  return {
    connections: [
      {
        id: "connection-personal",
        harness: "opencode" as const,
        authenticationTargetId: "opencode-go",
        authenticationMethodId: "api-key",
        label: "OpenCode Go / ••••A7F2",
        providerIdentityId: null,
        health: "ready" as const,
        healthReason: null,
        lastCheckedAt: timestamp,
        createdAt: timestamp,
        updatedAt: timestamp,
        lifecycle: "active" as const,
        terminatedAt: null,
        terminationReason: null,
      },
    ],
    installations,
    spaceDefaults: [],
    anonymousRoutes: [{ harness: "opencode" as const, internalProviderId: "opencode" }],
    authenticationMethods,
  };
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <div className="w-[640px] p-6">
        <SettingsAgentsPage />
      </div>
    </QueryClientProvider>,
  );
}

describe("Settings Agents Connections", () => {
  beforeEach(() => {
    nativeApi.getConnections.mockResolvedValue(snapshot());
    nativeApi.beginConnectionLogin.mockResolvedValue({
      operationId: "login-codex-work",
      connectionId: "connection-codex-work",
      state: "starting",
      authUrl: "https://auth.example.test/codex",
      connection: null,
      failureReason: null,
    });
    nativeApi.getConnectionLogin.mockResolvedValue({
      operationId: "login-codex-work",
      connectionId: "connection-codex-work",
      state: "starting",
      authUrl: "https://auth.example.test/codex",
      connection: null,
      failureReason: null,
    });
    nativeApi.createStaticConnection.mockResolvedValue(snapshot().connections[0]);
    nativeApi.terminateConnection.mockResolvedValue(snapshot().connections[0]);
    nativeApi.confirm.mockResolvedValue(true);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("adds an OpenCode Connection from the inline API-key state", async () => {
    await renderPage();

    await page.getByRole("button", { name: "Add OpenCode Connection" }).click();
    await expect
      .element(page.getByRole("button", { name: "Cancel adding OpenCode Connection" }))
      .toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Manage OpenCode Go / ••••A7F2" }))
      .toBeVisible();
    await page.getByRole("button", { name: "OpenCode Go for OpenCode", exact: true }).click();
    await page.getByLabelText("API key").fill("secret-key");
    await page.getByRole("button", { name: "Add", exact: true }).click();

    expect(nativeApi.createStaticConnection).toHaveBeenCalledWith({
      harness: "opencode",
      authenticationTargetId: "opencode-go",
      authenticationMethodId: "api-key",
      secret: "secret-key",
    });
  });

  it("starts ChatGPT account sign-in directly from the inline card", async () => {
    const screen = await renderPage();

    await page.getByRole("button", { name: "ChatGPT agent" }).click();
    await page.getByRole("button", { name: "Sign in for ChatGPT" }).click();

    await vi.waitFor(() => {
      expect(nativeApi.beginConnectionLogin).toHaveBeenCalledWith({
        harness: "codex",
        authenticationTargetId: "openai-first-party",
        authenticationMethodId: "chatgpt",
      });
      expect(nativeApi.openExternal).toHaveBeenCalledWith("https://auth.example.test/codex");
    });
    await screen.unmount();
  });

  it("imports an OpenAI API key through the ChatGPT native profile", async () => {
    const screen = await renderPage();

    await page.getByRole("button", { name: "ChatGPT agent" }).click();
    await page.getByRole("button", { name: "API key for ChatGPT" }).click();
    await page.getByLabelText("API key").fill("sk-platform");
    await page.getByRole("button", { name: "Add", exact: true }).click();

    await vi.waitFor(() => {
      expect(nativeApi.beginConnectionLogin).toHaveBeenCalledWith({
        harness: "codex",
        authenticationTargetId: "openai-first-party",
        authenticationMethodId: "api-key",
        secret: "sk-platform",
      });
      expect(nativeApi.createStaticConnection).not.toHaveBeenCalled();
    });
    await screen.unmount();
  });

  it("keeps Connection management limited to disconnect", async () => {
    await renderPage();

    await page.getByRole("button", { name: "OpenCode agent" }).click();
    const manage = page.getByRole("button", { name: "Manage OpenCode Go / ••••A7F2" });
    await manage.click();
    await expect.element(page.getByRole("menuitem", { name: "Disconnect" })).toBeVisible();
    await expect.element(page.getByRole("menuitem", { name: "Rename" })).not.toBeInTheDocument();
  });

  it("disconnects only after the native confirmation is accepted", async () => {
    nativeApi.confirm.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    await renderPage();

    await page.getByRole("button", { name: "OpenCode agent" }).click();
    await page.getByRole("button", { name: "Manage OpenCode Go / ••••A7F2" }).click();
    await page.getByRole("menuitem", { name: "Disconnect" }).click();

    expect(nativeApi.confirm).toHaveBeenCalledWith(
      "Disconnect “OpenCode Go / ••••A7F2”?\n\nExisting Threads using it will show an error until you choose another Connection.",
    );
    expect(nativeApi.terminateConnection).not.toHaveBeenCalled();

    await page.getByRole("button", { name: "Manage OpenCode Go / ••••A7F2" }).click();
    await page.getByRole("menuitem", { name: "Disconnect" }).click();
    await vi.waitFor(() => {
      expect(nativeApi.terminateConnection).toHaveBeenCalledWith({
        connectionId: "connection-personal",
        reason: "disconnected",
      });
    });
  });
});
