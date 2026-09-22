// FILE: ComposerExtrasMenu.browser.tsx
// Purpose: Verifies the composer `+` menu exposes file attachments and quick mode toggles.
// Layer: Browser UI test
// Depends on: vitest browser rendering helpers and the ComposerExtrasMenu component.

import "../../index.css";

import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { ComposerExtrasMenu } from "./ComposerExtrasMenu";

async function mountMenu(props?: { fastModeEnabled?: boolean; supportsFastMode?: boolean }) {
  const onAddAttachments = vi.fn<(files: File[]) => void>();
  const onToggleFastMode = vi.fn();
  const onOutsideAction = vi.fn();
  const host = document.createElement("div");
  const outsideAction = document.createElement("button");
  outsideAction.type = "button";
  outsideAction.textContent = "Outside action";
  outsideAction.style.position = "fixed";
  outsideAction.style.right = "16px";
  outsideAction.style.bottom = "16px";
  outsideAction.addEventListener("click", onOutsideAction);
  document.body.append(host);
  document.body.append(outsideAction);
  const screen = await render(
    <ComposerExtrasMenu
      supportsFastMode={props?.supportsFastMode ?? true}
      fastModeEnabled={props?.fastModeEnabled ?? false}
      onAddAttachments={onAddAttachments}
      onToggleFastMode={onToggleFastMode}
    />,
    { container: host },
  );

  const cleanup = async () => {
    await screen.unmount();
    host.remove();
    outsideAction.remove();
  };

  return {
    [Symbol.asyncDispose]: cleanup,
    cleanup,
    onAddAttachments,
    onOutsideAction,
    onToggleFastMode,
  };
}

describe("ComposerExtrasMenu", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("uses a general file picker and forwards mixed attachments together", async () => {
    await using menu = await mountMenu();

    const input = document.querySelector<HTMLInputElement>("[data-testid='composer-file-input']");
    expect(input).not.toBeNull();
    expect(input?.hasAttribute("accept")).toBe(false);

    const files = new DataTransfer();
    files.items.add(new File(["photo"], "photo.png", { type: "image/png" }));
    files.items.add(new File(["report"], "report.pdf", { type: "application/pdf" }));
    Object.defineProperty(input, "files", {
      configurable: true,
      value: files.files,
    });
    input?.dispatchEvent(new Event("change", { bubbles: true }));

    expect(menu.onAddAttachments).toHaveBeenCalledTimes(1);
    expect(menu.onAddAttachments.mock.calls[0]?.[0]?.map((file) => file.name)).toEqual([
      "photo.png",
      "report.pdf",
    ]);
  });

  it("shows the attachment action in the menu", async () => {
    await using _ = await mountMenu({ fastModeEnabled: true });

    await page.getByLabelText("Attach files").click();

    await vi.waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text).toContain("Add files");
      expect(text).toContain("Fast");
      expect(text).not.toContain("Plan mode");
      expect(text).not.toContain("Plugins");
    });
  });

  it("dismisses without blocking interaction outside the composer", async () => {
    await using menu = await mountMenu();

    await page.getByLabelText("Attach files").click();

    expect(document.documentElement).not.toHaveAttribute("data-base-ui-scroll-locked");

    await page.getByRole("button", { name: "Outside action" }).click();

    expect(menu.onOutsideAction).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => {
      expect(document.body.textContent).not.toContain("Add files");
    });
  });

  it("wires the speed control", async () => {
    await using menu = await mountMenu();

    await page.getByLabelText("Attach files").click();
    await page.getByText("Fast").click();
    await page.getByRole("menuitemradio", { name: "Fast" }).click();

    expect(menu.onToggleFastMode).toHaveBeenCalledTimes(1);
  });
});
