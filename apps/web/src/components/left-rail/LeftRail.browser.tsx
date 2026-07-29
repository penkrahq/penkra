import "../../index.css";

import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { AccountRowShared } from "./account-row-shared/AccountRowShared";
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

  it("keeps account, settings, and help as separate actions", async () => {
    const onAccount = vi.fn();
    const onHelp = vi.fn();
    const onSettings = vi.fn();
    await render(
      <AccountRowShared
        name="gigsama"
        onAccount={onAccount}
        onHelp={onHelp}
        onSettings={onSettings}
      />,
    );

    await page.getByRole("button", { name: "gigsama" }).click();
    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByRole("button", { name: "Help" }).click();

    expect(onAccount).toHaveBeenCalledOnce();
    expect(onSettings).toHaveBeenCalledOnce();
    expect(onHelp).toHaveBeenCalledOnce();
  });
});
