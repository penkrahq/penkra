import "../../../../index.css";

import { SpaceId } from "@penkra/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const nativeApi = vi.hoisted(() => ({
  getConnections: vi.fn(),
  setSpaceDefaultConnection: vi.fn(),
}));

vi.mock("~/nativeApi", () => ({
  ensureNativeApi: () => ({
    provider: {
      getConnections: nativeApi.getConnections,
      setSpaceDefaultConnection: nativeApi.setSpaceDefaultConnection,
    },
  }),
  readNativeApi: () => null,
}));

import { useStore } from "~/store";
import { SettingsSpacesPage } from "./SettingsSpacesPage";

const timestamp = "2026-08-09T00:00:00.000Z";
const personalSpaceId = SpaceId.makeUnsafe("space-personal");

function snapshot() {
  return {
    connections: [
      {
        id: "connection-personal",
        harness: "codex" as const,
        authenticationTargetId: "openai-first-party",
        authenticationMethodId: "chatgpt",
        label: "personal@example.com",
        providerIdentityId: "personal@example.com",
        health: "ready" as const,
        healthReason: null,
        lastCheckedAt: timestamp,
        createdAt: timestamp,
        updatedAt: timestamp,
        lifecycle: "active" as const,
        terminatedAt: null,
        terminationReason: null,
      },
      {
        id: "connection-work",
        harness: "codex" as const,
        authenticationTargetId: "openai-first-party",
        authenticationMethodId: "chatgpt",
        label: "work@example.com",
        providerIdentityId: "work@example.com",
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
    installations: [],
    spaceDefaults: [
      {
        spaceId: personalSpaceId,
        harness: "codex" as const,
        connectionId: "connection-personal",
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
    anonymousRoutes: [],
    authenticationMethods: [],
  };
}

describe("Settings Space defaults", () => {
  beforeEach(() => {
    useStore.setState({
      spaces: [
        {
          id: personalSpaceId,
          name: "Personal",
          icon: "home",
          sortOrder: 0,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      ],
      archivedSpaces: [],
    });
    nativeApi.getConnections.mockResolvedValue(snapshot());
    nativeApi.setSpaceDefaultConnection.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = "";
  });

  it("expands a Space inline and changes its explicit default Connection", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await render(
      <QueryClientProvider client={queryClient}>
        <div className="w-[640px] p-6">
          <SettingsSpacesPage />
        </div>
      </QueryClientProvider>,
    );

    const spaceRow = page.getByRole("button", { name: "Personal Space" });
    await expect.element(spaceRow).toHaveAttribute("aria-expanded", "false");
    await spaceRow.click();
    await expect.element(spaceRow).toHaveAttribute("aria-expanded", "true");

    await page.getByRole("button", { name: "ChatGPT default Connection" }).click();
    const personal = page.getByRole("button", {
      name: "Use personal@example.com for ChatGPT",
    });
    const work = page.getByRole("button", { name: "Use work@example.com for ChatGPT" });
    await expect.element(personal).toHaveAttribute("aria-pressed", "true");
    await expect.element(work).toHaveAttribute("aria-pressed", "false");
    await work.click();

    expect(nativeApi.setSpaceDefaultConnection).toHaveBeenCalledWith({
      spaceId: personalSpaceId,
      harness: "codex",
      connectionId: "connection-work",
    });
  });
});
