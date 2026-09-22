// FILE: ComposerExtrasMenu.browser.tsx
// Purpose: Verifies the composer `+` button opens the general file picker directly.
// Layer: Browser UI test
// Depends on: vitest browser rendering helpers and the ComposerExtrasMenu component.

import "../../index.css";

import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { ComposerExtrasMenu } from "./ComposerExtrasMenu";

async function mountButton() {
  const onAddAttachments = vi.fn<(files: File[]) => void>();
  const host = document.createElement("div");
  document.body.append(host);
  const screen = await render(
    <ComposerExtrasMenu onAddAttachments={onAddAttachments} />,
    {
      container: host,
    },
  );

  const cleanup = async () => {
    await screen.unmount();
    host.remove();
  };

  return {
    [Symbol.asyncDispose]: cleanup,
    cleanup,
    onAddAttachments,
  };
}

describe("ComposerExtrasMenu", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("uses a general file picker and forwards mixed attachments together", async () => {
    await using button = await mountButton();

    const input = document.querySelector<HTMLInputElement>(
      "[data-testid='composer-file-input']",
    );
    expect(input).not.toBeNull();
    expect(input?.hasAttribute("accept")).toBe(false);

    const files = new DataTransfer();
    files.items.add(new File(["photo"], "photo.png", { type: "image/png" }));
    files.items.add(
      new File(["report"], "report.pdf", { type: "application/pdf" }),
    );
    Object.defineProperty(input, "files", {
      configurable: true,
      value: files.files,
    });
    input?.dispatchEvent(new Event("change", { bubbles: true }));

    expect(button.onAddAttachments).toHaveBeenCalledTimes(1);
    expect(
      button.onAddAttachments.mock.calls[0]?.[0]?.map((file) => file.name),
    ).toEqual(["photo.png", "report.pdf"]);
  });

  it("opens the file picker directly without rendering a popup", async () => {
    await using _ = await mountButton();
    const input = document.querySelector<HTMLInputElement>(
      "[data-testid='composer-file-input']",
    );
    expect(input).not.toBeNull();
    const clickPicker = vi
      .spyOn(input!, "click")
      .mockImplementation(() => undefined);

    await page.getByLabelText("Attach files").click();

    expect(clickPicker).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).not.toContain("Add files");
    expect(document.body.textContent).not.toContain("Fast");
  });
});
