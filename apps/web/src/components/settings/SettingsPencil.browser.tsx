import "../../index.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page } from "vitest/browser";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

vi.mock("~/nativeApi", async () => {
  const { DEFAULT_SERVER_SETTINGS_VIEW } = await import("@penkra/contracts");
  const api = {
    server: {
      getSettings: async () => DEFAULT_SERVER_SETTINGS_VIEW,
      updateSettings: async (patch: Record<string, unknown>) => ({
        ...DEFAULT_SERVER_SETTINGS_VIEW,
        ...patch,
      }),
    },
  };
  return {
    ensureNativeApi: () => api,
    readNativeApi: () => api,
  };
});

import { OpenWithRowShared } from "./open-with-row-shared/OpenWithRowShared";
import { SettingsPageContent } from "./pages/SettingsPageContent";
import { SettingsPage, type SettingsPageId } from "./settings-page/SettingsPage";
import { ThemePanelShared } from "./theme-panel-shared/ThemePanelShared";
import { useAppTypography } from "~/hooks/useAppTypography";
import { useSpacesUiStore } from "~/spacesUiStore";

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

function SettingsPageHarness() {
  const [activePage, setActivePage] = useState<SettingsPageId>("general");

  return (
    <QueryClientProvider client={queryClient}>
      <SettingsPage onPageChange={setActivePage} page={activePage}>
        <SettingsPageContent page={activePage} />
      </SettingsPage>
    </QueryClientProvider>
  );
}

function AppearanceTypographyHarness() {
  useAppTypography();

  return (
    <SettingsPage page="appearance">
      <SettingsPageContent page="appearance" />
    </SettingsPage>
  );
}

describe("Pencil settings structure", () => {
  afterEach(() => {
    queryClient.clear();
    document.body.innerHTML = "";
  });

  it("keeps navigation interactive and content independently scrollable", async () => {
    const onPageChange = vi.fn();
    await render(<SettingsPage className="h-80" onPageChange={onPageChange} />);

    await page.getByRole("button", { name: "Appearance" }).click();
    expect(onPageChange).toHaveBeenCalledWith("appearance");

    const viewport = document.querySelector<HTMLElement>(
      "[data-pencil-region='settings-content'] [data-slot='scroll-area-viewport']",
    );
    expect(viewport).not.toBeNull();
    expect(viewport!.scrollHeight).toBeGreaterThan(viewport!.clientHeight);
  });

  it("presents settings as a route-native page without dialog chrome", async () => {
    const rendered = await render(
      <div className="h-[640px] w-[880px]">
        <SettingsPage />
      </div>,
    );

    try {
      const settingsPage = page.getByRole("main", { name: "Settings" });
      await expect.element(settingsPage).toBeVisible();

      const backdrop = document.querySelector<HTMLElement>("[data-slot='dialog-backdrop']");
      expect(document.querySelector("[role='dialog']")).toBeNull();
      expect(backdrop).toBeNull();
      expect(settingsPage.element().getBoundingClientRect().width).toBe(880);
      expect(settingsPage.element().getBoundingClientRect().height).toBe(640);
    } finally {
      rendered.unmount();
    }
  });

  it("matches each Pencil settings page content measure", async () => {
    const view = await render(
      <div className="h-[640px] w-[880px]">
        <SettingsPage page="general">
          <div data-testid="settings-content-measure" />
        </SettingsPage>
      </div>,
    );

    const measure = () => page.getByTestId("settings-content-measure").element().parentElement!;
    expect(measure().getBoundingClientRect().width).toBe(560);

    await view.rerender(
      <div className="h-[640px] w-[880px]">
        <SettingsPage page="appearance">
          <div data-testid="settings-content-measure" />
        </SettingsPage>
      </div>,
    );
    expect(measure().getBoundingClientRect().width).toBe(560);

    await view.rerender(
      <div className="h-[640px] w-[880px]">
        <SettingsPage page="spaces">
          <div data-testid="settings-content-measure" />
        </SettingsPage>
      </div>,
    );
    expect(measure().getBoundingClientRect().width).toBe(596);
  });

  it("uses native interactive controls for expandable and theme settings", async () => {
    await render(
      <div>
        <OpenWithRowShared />
        <ThemePanelShared />
      </div>,
    );

    await page.getByRole("button", { name: /Open with/i }).click();
    await expect.element(page.getByRole("button", { name: "Finder", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Finder", exact: true }).click();
    await expect.element(page.getByRole("button", { name: /Finder/i })).toBeVisible();

    await page.getByRole("slider", { name: "Contrast" }).fill("62");
    await expect.element(page.getByText("62", { exact: true })).toBeVisible();
    const uiFont = page.getByRole("textbox", { name: "UI font" });
    await uiFont.fill("Inter");
    await expect.element(uiFont).toHaveValue("Inter");
  });

  it("applies valid UI font size changes immediately", async () => {
    const rendered = await render(
      <QueryClientProvider client={queryClient}>
        <AppearanceTypographyHarness />
      </QueryClientProvider>,
    );

    try {
      await page.getByRole("spinbutton", { name: "UI font size" }).fill("16");
      await vi.waitFor(() => {
        expect(document.documentElement.style.getPropertyValue("--app-font-size-ui")).toBe("16px");
        expect(document.documentElement.style.getPropertyValue("--app-font-size-chat")).toBe(
          "16px",
        );
      });
    } finally {
      rendered.unmount();
      window.localStorage.removeItem("penkra:app-settings:v1");
    }
  });

  it("renders the Pencil-defined Settings pages without legacy controls", async () => {
    const signOut = vi.fn(async () => undefined);
    const installationSnapshot = {
      installed: [
        {
          id: "com.penkra.apps",
          spaceId: "personal",
          slug: "apps",
          name: "Apps",
          summary: "Discover and manage Apps.",
          version: "0.1.0",
          source: "registry" as const,
          installedAt: "2026-08-01T00:00:00.000Z",
          permissions: [],
          handlers: [],
          skills: [],
        },
      ],
      spaces: [
        {
          appId: "com.penkra.apps",
          spaceId: "personal",
          enabled: true,
          permissions: {},
        },
      ],
    };
    Object.defineProperty(window, "desktopBridge", {
      configurable: true,
      value: {
        confirm: async () => true,
        setTheme: async () => undefined,
        accountAuth: {
          getState: async () => ({
            status: "authenticated" as const,
            user: {
              id: "account-1",
              email: "gigsama@penkra.com",
              name: "gigsama",
              image: null,
            },
          }),
          onAuthenticated: () => () => undefined,
          onUserUpdated: () => () => undefined,
          signOut,
        },
        appInstallations: {
          getState: async () => installationSnapshot,
          onState: () => () => undefined,
          setEnabled: async () => installationSnapshot,
        },
      },
    });
    useSpacesUiStore.getState().setActiveSpaceId("personal" as never);
    await render(<SettingsPageHarness />);

    await expect.element(page.getByText("Defaults and updates for Penkra.")).toBeVisible();
    await expect.element(page.getByText("Open with", { exact: true })).toBeVisible();
    await expect.element(page.getByText("Notifications", { exact: true })).toBeVisible();
    const providerUpdates = page.getByRole("button", { name: /Provider updates/i });
    await expect.element(providerUpdates).toHaveTextContent("Automatic");
    await providerUpdates.click();
    const notifyOption = page.getByRole("button", { name: "Notify me", exact: true });
    await expect.element(notifyOption).toBeVisible();
    const providerUpdatesElement = Array.from(document.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Provider updates"),
    );
    const notifyOptionElement = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Notify me",
    );
    expect(providerUpdatesElement).toBeDefined();
    expect(notifyOptionElement).toBeDefined();
    const providerUpdatesBounds = providerUpdatesElement!.getBoundingClientRect();
    const notifyOptionBounds = notifyOptionElement!.getBoundingClientRect();
    expect(notifyOptionBounds.height).toBeGreaterThanOrEqual(38);
    expect(notifyOptionBounds.top).toBeGreaterThanOrEqual(providerUpdatesBounds.bottom);
    await notifyOption.click();
    await expect.element(providerUpdates).toHaveTextContent("Notify me");
    expect(document.body.textContent).not.toContain("Restore defaults");
    expect(document.body.textContent).not.toContain("Automatic CLI update checks");

    await page.getByRole("button", { name: "Permissions", exact: true }).click();
    await expect.element(page.getByText("No additional permissions")).toBeVisible();
    await expect
      .element(page.getByText("Installed Apps have not requested additional permissions."))
      .toBeVisible();

    await page.getByRole("button", { name: "Agents", exact: true }).click();
    await expect
      .element(page.getByText("Choose which coding agent runs your threads."))
      .toBeVisible();
    await expect.element(page.getByText("Claude Agent")).toBeVisible();
    await expect.element(page.getByText("Model & Access")).toBeVisible();

    await page.getByRole("button", { name: "Apps", exact: true }).click();
    await expect.element(page.getByText("Installed apps from the Penkra registry.")).toBeVisible();
    await expect.element(page.getByRole("switch", { name: "Apps installed" })).toBeChecked();
    expect(document.body.textContent).not.toContain("Installed appsInstalled");

    await page.getByRole("button", { name: "Connectors", exact: true }).click();
    await expect.element(page.getByText("Link external services and integrations.")).toBeVisible();
    await expect
      .element(page.getByText("No supported connectors are available in this build."))
      .toBeVisible();

    await page.getByRole("button", { name: "Appearance", exact: true }).click();
    await expect.element(page.getByText("Customize the look and feel of Penkra.")).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "System" }))
      .toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: "Dark" }).click();
    await expect
      .element(page.getByRole("button", { name: "Dark" }))
      .toHaveAttribute("aria-pressed", "true");
    expect(JSON.parse(localStorage.getItem("penkra:theme") ?? "null")).toMatchObject({
      mode: "dark",
    });
    await page.getByRole("button", { name: "System" }).click();

    await page.getByRole("button", { name: "Account", exact: true }).click();
    await expect.element(page.getByText("Manage your profile and preferences.")).toBeVisible();
    await expect.element(page.getByText("Personal account")).toBeVisible();
    await expect.element(page.getByText("gigsama@penkra.com")).toBeVisible();
    await page.getByRole("button", { name: "Log Out" }).click();
    expect(signOut).toHaveBeenCalledOnce();
  });
});
