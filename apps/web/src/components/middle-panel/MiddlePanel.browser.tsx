import "../../index.css";

import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { ComposerDefault } from "./composer-default/ComposerDefault";
import { MessageAssistant } from "./message-assistant/MessageAssistant";
import { MessageUser } from "./message-user/MessageUser";
import { ThreadScreen3Rails } from "./thread-screen-3-rails/ThreadScreen3Rails";

describe("Pencil middle panel", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("keeps the composer native, editable, focused, and sendable", async () => {
    const onSend = vi.fn();
    await render(<ComposerDefault aria-label="Message" onSend={onSend} />);

    const composer = page.getByRole("textbox", { name: "Message" });
    await composer.fill("Ship it");
    await expect.element(composer).toHaveValue("Ship it");
    const element = composer.element() as HTMLTextAreaElement;
    element.blur();
    const form = element.closest("form");
    const unfocusedBorder = getComputedStyle(form!).borderColor;
    element.focus();
    element.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" }),
    );
    expect(onSend).toHaveBeenCalledOnce();

    expect(document.activeElement).toBe(element);
    await vi.waitFor(() => {
      expect(getComputedStyle(form!).borderColor).not.toBe(unfocusedBorder);
    });
  });

  it("keeps the transcript in a real scroll region outside the fixed composer", async () => {
    const transcript = Array.from({ length: 12 }, (_, index) => (
      <div className="contents" key={index}>
        <MessageUser>User message {index + 1}</MessageUser>
        <MessageAssistant>Assistant response {index + 1}</MessageAssistant>
      </div>
    ));

    await render(
      <ThreadScreen3Rails className="h-80" composer={<ComposerDefault aria-label="Reply" />}>
        {transcript}
      </ThreadScreen3Rails>,
    );

    const viewport = document.querySelector<HTMLElement>(
      "[data-pencil-region='PGsVQ'] [data-slot='scroll-area-viewport']",
    );
    expect(viewport).not.toBeNull();
    expect(viewport!.scrollHeight).toBeGreaterThan(viewport!.clientHeight);
    await expect.element(page.getByRole("textbox", { name: "Reply" })).toBeVisible();
  });

  it("exposes message actions as real buttons", async () => {
    const onCopy = vi.fn();
    await render(<MessageUser onCopy={onCopy}>Copy this message</MessageUser>);

    await page.getByRole("button", { name: "Copy message" }).click();
    expect(onCopy).toHaveBeenCalledOnce();
  });
});
