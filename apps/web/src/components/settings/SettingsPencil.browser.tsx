import "../../index.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page } from "vitest/browser";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

vi.mock("~/nativeApi", async () => {
  const { DEFAULT_SERVER_SETTINGS_VIEW } = await import("@synara/contracts");
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

import { ModalSettings } from "./modal-settings/ModalSettings";
import { SettingsDialog } from "./modal-settings/SettingsDialog";
import type { SettingsPage } from "./modal-settings/ModalSettings";
import { OpenWithRowShared } from "./open-with-row-shared/OpenWithRowShared";
import { SettingsPageContent } from "./pages/SettingsPageContent";
import { ThemePanelShared } from "./theme-panel-shared/ThemePanelShared";

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

function SettingsDialogHarness() {
  const [activePage, setActivePage] = useState<SettingsPage>("general");

  return (
    <QueryClientProvider client={queryClient}>
      <SettingsDialog onClose={() => undefined} onPageChange={setActivePage} page={activePage}>
        <SettingsPageContent page={activePage} />
      </SettingsDialog>
    </QueryClientProvider>
  );
}

describe("Pencil settings structure", () => {
  afterEach(() => {
    queryClient.clear();
    document.body.innerHTML = "";
  });

  it("keeps navigation interactive and content independently scrollable", async () => {
    const onPageChange = vi.fn();
    await render(<ModalSettings className="h-80" onPageChange={onPageChange} />);

    await page.getByRole("button", { name: "Appearance" }).click();
    expect(onPageChange).toHaveBeenCalledWith("appearance");

    const viewport = document.querySelector<HTMLElement>(
      "[data-pencil-region='settings-content'] [data-slot='scroll-area-viewport']",
    );
    expect(viewport).not.toBeNull();
    expect(viewport!.scrollHeight).toBeGreaterThan(viewport!.clientHeight);
  });

  it("presents settings as the full-shell Pencil dialog", async () => {
    const onClose = vi.fn();
    const rendered = await render(<SettingsDialog onClose={onClose} />);

    try {
      const dialog = page.getByRole("dialog", { name: "Settings" });
      await expect.element(dialog).toBeVisible();

      const popup = document.querySelector<HTMLElement>("[data-slot='dialog-popup']");
      const backdrop = document.querySelector<HTMLElement>("[data-slot='dialog-backdrop']");
      expect(popup).not.toBeNull();
      expect(backdrop).not.toBeNull();
      expect(popup!.getBoundingClientRect().width).toBe(Math.min(880, window.innerWidth - 48));
      expect(popup!.getBoundingClientRect().height).toBe(Math.min(640, window.innerHeight - 48));
      expect(getComputedStyle(backdrop!).backgroundColor).toBe("rgba(0, 0, 0, 0.7)");

      document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));
      await vi.waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    } finally {
      rendered.unmount();
    }
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

  it("renders the Pencil-defined Settings pages without legacy controls", async () => {
    await render(<SettingsDialogHarness />);

    await expect.element(page.getByText("Defaults and updates for Penkra.")).toBeVisible();
    await expect.element(page.getByText("Open with", { exact: true })).toBeVisible();
    await expect.element(page.getByText("Notifications", { exact: true })).toBeVisible();
    const providerUpdates = page.getByRole("button", { name: /Provider updates/i });
    await expect.element(providerUpdates).toHaveTextContent("Automatic");
    await providerUpdates.click();
    await page.getByRole("button", { name: "Notify me", exact: true }).click();
    await expect.element(providerUpdates).toHaveTextContent("Notify me");
    expect(document.body.textContent).not.toContain("Restore defaults");
    expect(document.body.textContent).not.toContain("Automatic CLI update checks");

    await page.getByRole("button", { name: "Agents", exact: true }).click();
    await expect
      .element(page.getByText("Choose which coding agent runs your threads."))
      .toBeVisible();
    await expect.element(page.getByText("Claude Agent")).toBeVisible();
    await expect.element(page.getByText("Model & Access")).toBeVisible();

    await page.getByRole("button", { name: "Apps", exact: true }).click();
    await expect.element(page.getByText("Installed apps from the Penkra registry.")).toBeVisible();
    await expect.element(page.getByRole("switch", { name: "Ledger installed" })).toBeChecked();
    expect(document.body.textContent).not.toContain("Installed appsInstalled");

    await page.getByRole("button", { name: "Connectors", exact: true }).click();
    await expect.element(page.getByText("Link external services and integrations.")).toBeVisible();
    await expect.element(page.getByRole("switch", { name: "Calendar connected" })).toBeChecked();

    await page.getByRole("button", { name: "Appearance", exact: true }).click();
    await expect.element(page.getByText("Customize the look and feel of Penkra.")).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "System" }))
      .toHaveAttribute("aria-pressed", "true");

    await page.getByRole("button", { name: "Account", exact: true }).click();
    await expect.element(page.getByText("Manage your profile and preferences.")).toBeVisible();
    await expect.element(page.getByText("Anthropic API key")).toBeVisible();
  });
});
