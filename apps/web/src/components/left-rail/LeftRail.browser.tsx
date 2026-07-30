import "../../index.css";

import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { AccountRowShared } from "./account-row-shared/AccountRowShared";
import { AccountControlShared } from "./account-control-shared/AccountControlShared";
import { FolderGroupShared } from "./folder-group-shared/FolderGroupShared";
import { SidebarProjects } from "./sidebar-projects/SidebarProjects";

const threads = Array.from({ length: 12 }, (_, index) => ({
  id: `thread-${index}`,
  label: `Thread ${index + 1}`,
  provider: (index % 2 === 0 ? "claudeAgent" : "codex") as "claudeAgent" | "codex",
}));

describe("Pencil left rail", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("uses a real bounded vertical scroll viewport for overflowing projects", async () => {
    await render(
      <div className="h-32 w-60">
        <SidebarProjects>
          <FolderGroupShared defaultExpanded label="penkra" threads={threads} />
        </SidebarProjects>
      </div>,
    );

    const viewport = document.querySelector<HTMLElement>("[data-slot='scroll-area-viewport']");
    expect(viewport).not.toBeNull();
    expect(viewport!.scrollHeight).toBeGreaterThan(viewport!.clientHeight);

    viewport!.scrollTop = 40;
    viewport!.dispatchEvent(new Event("scroll"));
    expect(viewport!.scrollTop).toBeGreaterThan(0);
  });

  it("keeps folder disclosure state native and observable", async () => {
    await render(<FolderGroupShared label="penut" threads={threads.slice(0, 2)} />);

    const disclosure = page.getByRole("button", { name: "penut" });
    await expect.element(disclosure).toHaveAttribute("aria-expanded", "false");
    await disclosure.click();
    await expect.element(disclosure).toHaveAttribute("aria-expanded", "true");
    await expect.element(page.getByRole("button", { name: "Thread 1" })).toBeVisible();
  });

  it("keeps account and help as separate actions", async () => {
    const onAccount = vi.fn();
    const onHelp = vi.fn();
    await render(<AccountRowShared name="gigsama" onAccount={onAccount} onHelp={onHelp} />);

    await page.getByRole("button", { name: "gigsama" }).click();
    await page.getByRole("button", { name: "Help" }).click();

    expect(onAccount).toHaveBeenCalledOnce();
    expect(onHelp).toHaveBeenCalledOnce();
    expect(page.getByRole("button", { name: "Settings" }).query()).toBeNull();
  });

  it("keeps the account row surface transparent on hover", async () => {
    await render(<AccountRowShared name="gigsama" />);

    await page.getByRole("button", { name: "gigsama" }).hover();
    const row = document.querySelector<HTMLElement>(".group\\/account-row");
    const help = document.querySelector<HTMLElement>("button[aria-label='Help']");

    expect(row).not.toBeNull();
    expect(help).not.toBeNull();
    expect(getComputedStyle(row!).backgroundColor).toBe("rgba(0, 0, 0, 0)");
  });

  it("keeps an available update independent from the account menu", async () => {
    const onAccount = vi.fn();
    const onUpdate = vi.fn();
    await render(
      <AccountRowShared
        name="gigsama"
        onAccount={onAccount}
        onUpdate={onUpdate}
        updateLabel="Update"
        updatePhase="ready"
      />,
    );

    await page.getByRole("button", { name: "Update" }).click();

    expect(onUpdate).toHaveBeenCalledOnce();
    expect(onAccount).not.toHaveBeenCalled();
  });

  it("matches the Pencil lifecycle treatments without changing account-row geometry", async () => {
    const { rerender } = await render(
      <AccountRowShared
        name="gigsama"
        onUpdate={vi.fn()}
        updateDisabled
        updateLabel="Preparing…"
        updatePhase="preparing"
      />,
    );

    const preparing = page.getByRole("button", { name: "Preparing…" });
    const row = preparing.element().closest<HTMLElement>(".h-11");
    await expect.element(preparing).toBeDisabled();
    expect(preparing.element().querySelector(".animate-spin")).not.toBeNull();

    await rerender(
      <AccountRowShared
        name="gigsama"
        onUpdate={vi.fn()}
        updateDisabled
        updateLabel="42%"
        updatePhase="downloading"
      />,
    );
    const downloading = page.getByRole("button", { name: "42%" });
    await expect.element(downloading).toBeDisabled();
    expect(downloading.element().querySelector(".animate-spin")).toBeNull();
    const neutralUpdateBackground = getComputedStyle(downloading.element()).backgroundColor;

    await rerender(
      <AccountRowShared
        name="gigsama"
        onUpdate={vi.fn()}
        updateLabel="Update"
        updatePhase="ready"
      />,
    );
    const ready = page.getByRole("button", { name: "Update" });
    await expect.element(ready).toBeEnabled();
    expect(ready.element().getBoundingClientRect().height).toBe(26);
    expect(getComputedStyle(ready.element()).backgroundColor).not.toBe(neutralUpdateBackground);

    await rerender(
      <AccountRowShared
        name="gigsama"
        onUpdate={vi.fn()}
        updateDisabled
        updateLabel="Updating…"
        updatePhase="installing"
      />,
    );
    const installing = page.getByRole("button", { name: "Updating…" });
    await expect.element(installing).toBeDisabled();
    expect(installing.element().querySelector(".animate-spin")).not.toBeNull();
    expect(row?.getBoundingClientRect().height).toBe(44);
    expect(row?.getBoundingClientRect().width).toBe(240);
    expect(page.getByRole("button", { name: "Help" }).element().getBoundingClientRect().width).toBe(
      28,
    );
  });

  it("opens the shared account popup from its semantic menu trigger", async () => {
    const onSettings = vi.fn();
    await render(
      <div className="flex h-64 items-end">
        <AccountControlShared accountName="gigsama" onSettings={onSettings} />
      </div>,
    );

    const trigger = page.getByRole("button", { name: "gigsama" });
    await expect.element(trigger).toHaveAttribute("aria-expanded", "false");
    await trigger.click();

    await expect.element(trigger).toHaveAttribute("aria-expanded", "true");
    const row = document.querySelector<HTMLElement>(".group\\/account-row");
    expect(row).not.toBeNull();
    expect(row!.getAttribute("data-selected")).toBe("true");
    expect(row!.getBoundingClientRect().height).toBe(44);
    expect(getComputedStyle(row!).backgroundColor).toBe("rgba(0, 0, 0, 0)");
    await expect.element(page.getByRole("menuitem", { name: "Settings" })).toBeVisible();
    await expect.element(page.getByRole("menuitem", { name: "Give Feedback" })).toBeVisible();
    await expect.element(page.getByRole("menuitem", { name: "Support Us" })).toBeVisible();
    await expect.element(page.getByRole("menuitem", { name: "Log Out" })).toBeVisible();

    const popup = document.querySelector<HTMLElement>("[data-slot='menu-popup']");
    expect(popup).not.toBeNull();
    expect(popup!.getBoundingClientRect().width).toBe(220);
    expect(popup!.getBoundingClientRect().height).toBe(139);
    expect(getComputedStyle(popup!).flexDirection).toBe("column");
    expect(getComputedStyle(popup!).borderTopWidth).toBe("1px");
    const popupRect = popup!.getBoundingClientRect();
    const rowRect = row!.getBoundingClientRect();

    expect(Math.abs(popupRect.bottom - rowRect.top)).toBeLessThan(1);
    expect(
      Math.abs(popupRect.left - rowRect.left - (rowRect.width - popupRect.width) / 2),
    ).toBeLessThan(1);

    await page.getByRole("menuitem", { name: "Settings" }).click();
    expect(onSettings).toHaveBeenCalledOnce();
  });
});
