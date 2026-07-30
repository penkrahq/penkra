import "../../../index.css";

import { page, userEvent } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { useState } from "react";

import { AccountControlShared } from "../account-control-shared/AccountControlShared";
import { PopupLogoutConfirmation } from "./PopupLogoutConfirmation";

function LogoutHarness({
  onConfirm,
  startOpen = true,
}: {
  onConfirm: () => Promise<void>;
  startOpen?: boolean;
}) {
  const [open, setOpen] = useState(startOpen);

  return (
    <div className="flex h-64 w-60 items-end">
      <AccountControlShared accountName="gigsama" onLogout={() => setOpen(true)} />
      <PopupLogoutConfirmation onConfirm={onConfirm} onOpenChange={setOpen} open={open} />
    </div>
  );
}

describe("Pencil logout confirmation", () => {
  let mounted: Awaited<ReturnType<typeof render>> | null = null;

  afterEach(async () => {
    await mounted?.unmount();
    mounted = null;
    document.body.innerHTML = "";
  });

  it("matches the square, centered Pencil modal with equal-width actions", async () => {
    mounted = await render(<LogoutHarness onConfirm={() => Promise.resolve()} />);

    const dialog = page.getByRole("alertdialog");
    await expect.element(dialog).toBeVisible();
    await expect.element(page.getByRole("heading", { name: "Log out" })).toBeVisible();

    const surface = document.querySelector<HTMLElement>("[data-pencil-component='r88fa']");
    const popup = document.querySelector<HTMLElement>("[data-pencil-component='hSE1M']");
    const backdrop = document.querySelector<HTMLElement>("[data-slot='alert-dialog-backdrop']");
    const icon = document.querySelector<HTMLElement>("[data-slot='logout-icon']");
    const content = document.querySelector<HTMLElement>("[data-slot='logout-content']");
    const actions = document.querySelector<HTMLElement>("[data-slot='logout-actions']");
    const cancel = page.getByRole("button", { name: "Cancel" });
    const confirm = page.getByRole("button", { name: "Log out" });

    expect(surface).not.toBeNull();
    expect(popup).not.toBeNull();
    expect(backdrop).not.toBeNull();
    expect(icon).not.toBeNull();
    expect(content).not.toBeNull();
    expect(actions).not.toBeNull();
    expect(surface!.getBoundingClientRect().width).toBe(Math.min(400, window.innerWidth - 32));
    expect(surface!.getBoundingClientRect().height).toBe(220);
    expect(getComputedStyle(surface!).borderRadius).toBe("0px");
    expect(getComputedStyle(backdrop!).backgroundColor).toBe("rgba(0, 0, 0, 0.7)");
    const surfaceRect = surface!.getBoundingClientRect();
    const iconRect = icon!.getBoundingClientRect();
    const contentRect = content!.getBoundingClientRect();
    const actionsRect = actions!.getBoundingClientRect();
    expect(Math.abs(iconRect.top - surfaceRect.top - 24)).toBeLessThan(1);
    expect(Math.abs(contentRect.top - iconRect.bottom)).toBeLessThan(1);
    expect(Math.abs(actionsRect.top - contentRect.bottom)).toBeLessThan(1);
    expect(Math.abs(surfaceRect.bottom - actionsRect.bottom - 20)).toBeLessThan(1);
    expect(
      Math.abs(
        (await cancel.element()).getBoundingClientRect().width -
          (await confirm.element()).getBoundingClientRect().width,
      ),
    ).toBeLessThan(1);
  });

  it("opens from the shared account menu and cancels without logging out", async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    mounted = await render(<LogoutHarness onConfirm={onConfirm} startOpen={false} />);

    await page.getByRole("button", { name: "gigsama" }).click();
    await page.getByRole("menuitem", { name: "Log Out" }).click();
    await expect.element(page.getByRole("alertdialog")).toBeVisible();
    await expect.element(page.getByRole("menuitem", { name: "Log Out" })).not.toBeInTheDocument();

    await page.getByRole("button", { name: "Cancel" }).click();
    await expect.element(page.getByRole("alertdialog")).not.toBeInTheDocument();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("invokes logout once and closes only after it succeeds", async () => {
    let resolveLogout: (() => void) | undefined;
    const onConfirm = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveLogout = resolve;
        }),
    );
    mounted = await render(<LogoutHarness onConfirm={onConfirm} />);

    await page.getByRole("button", { name: "Log out" }).click();
    expect(onConfirm).toHaveBeenCalledOnce();
    await expect.element(page.getByRole("button", { name: "Logging out…" })).toBeDisabled();
    await expect.element(page.getByRole("alertdialog")).toBeVisible();

    resolveLogout?.();
    await expect.element(page.getByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("supports the standard Escape dismissal", async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    mounted = await render(<LogoutHarness onConfirm={onConfirm} />);

    await userEvent.keyboard("{Escape}");

    await expect.element(page.getByRole("alertdialog")).not.toBeInTheDocument();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("keeps the dialog open and announces a logout failure", async () => {
    const onConfirm = vi.fn().mockRejectedValue(new Error("Unable to reach Penkra."));
    mounted = await render(<LogoutHarness onConfirm={onConfirm} />);

    await page.getByRole("button", { name: "Log out" }).click();

    await expect.element(page.getByRole("alertdialog")).toBeVisible();
    await expect.element(page.getByRole("status")).toHaveTextContent("Unable to reach Penkra.");
    await expect.element(page.getByRole("button", { name: "Log out" })).toBeEnabled();
  });
});
