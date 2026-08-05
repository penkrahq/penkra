import "../../index.css";

import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { COMPOSER_FOOTER_ROW_CLASS_NAME } from "../chat/composerPickerStyles";

import { ComposerDefault } from "./composer-default/ComposerDefault";
import { DraftFolderBar } from "./composer-default/DraftFolderBar";
import { ButtonSend } from "./button-send/ButtonSend";
import { AccessPillTrigger } from "./access-pill-trigger/AccessPillTrigger";
import { ComposerActions } from "./composer-actions/ComposerActions";
import { FolderPromptShared } from "./folder-prompt-shared/FolderPromptShared";
import { MessageAssistant } from "./message-assistant/MessageAssistant";
import { MessageUser } from "./message-user/MessageUser";
import { ThreadScreen3Rails } from "./thread-screen-3-rails/ThreadScreen3Rails";
import { TopBarThread } from "./top-bar-thread/TopBarThread";

describe("Pencil middle panel", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("replaces the thread identity without shifting the collapsed top-bar title", async () => {
    const view = await render(<TopBarThread title="Initial greeting" />);
    const expandedHeader = document.querySelector<HTMLElement>("[data-pencil-component='Kpx7i']")!;
    const expandedIdentity = expandedHeader.querySelector<HTMLElement>(
      "[data-slot='thread-identity']",
    )!;
    const expandedTitle = expandedHeader.querySelector<HTMLElement>("span.truncate")!;

    expect(
      expandedIdentity.getBoundingClientRect().left - expandedHeader.getBoundingClientRect().left,
    ).toBe(14);
    expect(
      expandedTitle.getBoundingClientRect().left - expandedHeader.getBoundingClientRect().left,
    ).toBe(36);

    await view.rerender(<TopBarThread leftRailCollapsed title="Initial greeting" />);
    const collapsedHeader = document.querySelector<HTMLElement>("[data-pencil-component='Kpx7i']")!;
    const restore = collapsedHeader.querySelector<HTMLElement>("[data-slot='left-rail-restore']")!;
    const collapsedTitle = collapsedHeader.querySelector<HTMLElement>("span.truncate")!;

    expect(collapsedHeader.querySelector("[data-slot='thread-identity']")).toBeNull();
    expect(
      restore.getBoundingClientRect().left - collapsedHeader.getBoundingClientRect().left,
    ).toBe(14);
    expect(restore.getBoundingClientRect().width).toBe(16);
    expect(
      collapsedTitle.getBoundingClientRect().left - collapsedHeader.getBoundingClientRect().left,
    ).toBe(36);
  });

  it("stretches assistant content across the shared message rail", async () => {
    await render(
      <div className="w-[640px]">
        <MessageAssistant layoutMode="application">
          <div data-testid="assistant-body">Response</div>
        </MessageAssistant>
      </div>,
    );

    const message = document.querySelector<HTMLElement>("[data-pencil-component='kUqNe']")!;
    const body = page.getByTestId("assistant-body").element();
    expect(message.getBoundingClientRect().width).toBe(640);
    expect(body.getBoundingClientRect().width).toBe(640);
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
      new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Enter",
      }),
    );
    expect(onSend).toHaveBeenCalledOnce();

    expect(document.activeElement).toBe(element);
    await vi.waitFor(() => {
      expect(getComputedStyle(form!).borderColor).toBe(unfocusedBorder);
    });

    const formRect = form!.getBoundingClientRect();
    const editorRect = element.getBoundingClientRect();
    const actions = form!.querySelector<HTMLElement>("[data-pencil-component='JwTiI']")!;
    const actionsRect = actions.getBoundingClientRect();
    expect(formRect.height).toBeCloseTo(100, 0);
    expect(getComputedStyle(element).fontSize).toBe("13px");
    expect(getComputedStyle(element).lineHeight).toBe("16px");
    expect(getComputedStyle(element).textAlign).toBe("left");
    expect(Math.abs(editorRect.left - formRect.left - 11)).toBeLessThan(1);
    expect(Math.abs(actionsRect.left - formRect.left - 11)).toBeLessThan(1);
    expect(Math.abs(actionsRect.top - formRect.top - 63)).toBeLessThan(1);
  });

  it("shows the model selector in the default composer", async () => {
    await render(<ComposerDefault aria-label="Message" />);

    await expect
      .element(page.getByRole("button", { name: "Claude Sonnet 5 High", exact: true }))
      .toBeVisible();
  });

  it("renders every approved send-control state from the shared component", async () => {
    await render(
      <div>
        <ButtonSend aria-label="Ready" visualState="ready" />
        <ButtonSend aria-label="Hover" visualState="hover" />
        <ButtonSend aria-label="Disabled" visualState="disabled" />
        <ButtonSend aria-label="Sending" visualState="sending" />
        <ButtonSend aria-label="Stop" type="button" visualState="stop" />
      </div>,
    );

    for (const state of ["ready", "hover", "disabled", "sending", "stop"] as const) {
      const button = document.querySelector<HTMLButtonElement>(`[data-send-state='${state}']`);
      expect(button).not.toBeNull();
      expect(button?.dataset.pencilComponent).toBe("eFqUm");
    }
    expect(page.getByRole("button", { name: "Disabled" }).element()).toBeDisabled();
    expect(page.getByRole("button", { name: "Sending" }).element()).toBeDisabled();
    expect(page.getByRole("button", { name: "Stop" }).element()).not.toBeDisabled();
  });

  it("uses the exact Pencil shield geometry for full access", async () => {
    await render(<AccessPillTrigger />);

    const icon = document.querySelector<SVGSVGElement>("[data-pencil-node='Bo845']");
    const path = icon?.querySelector<SVGPathElement>("[data-pencil-node='z9iYLc']");
    expect(icon).not.toBeNull();
    expect(icon?.getAttribute("viewBox")).toBe("0 0 13.99993896484375 14");
    expect(path?.getAttribute("d")).toContain("M6.84619 0.60156");
    expect(path?.getAttribute("d")).not.toContain("15.7001");
    expect(icon?.getBoundingClientRect().width).toBe(13);
    expect(icon?.getBoundingClientRect().height).toBe(13);
  });

  it("owns the production composer shell instead of passing legacy markup through", async () => {
    await render(
      <ComposerDefault
        layoutMode="application"
        draftBar={<div data-testid="draft-bar">Choose Folder · This Mac</div>}
      >
        <div data-testid="live-editor">Live editor</div>
      </ComposerDefault>,
    );

    const root = document.querySelector<HTMLElement>("[data-pencil-component='TKKOp']");
    const surface = root?.lastElementChild as HTMLElement | null;
    const draftBar = root?.querySelector<HTMLElement>("[data-pencil-node='fiR2o']");
    expect(root).not.toBeNull();
    expect(surface).not.toBeNull();
    expect(draftBar).not.toBeNull();
    expect(getComputedStyle(surface!).minHeight).toBe("100px");
    expect(getComputedStyle(surface!).borderRadius).toBe("18px");
    expect(getComputedStyle(surface!).textAlign).toBe("left");
    const rootRect = root!.getBoundingClientRect();
    const surfaceRect = surface!.getBoundingClientRect();
    const draftBarRect = draftBar!.getBoundingClientRect();
    expect(rootRect.height).toBeCloseTo(100, 0);
    expect(surfaceRect.height).toBeCloseTo(100, 0);
    expect(draftBarRect.height).toBe(40);
    expect(draftBarRect.left - rootRect.left).toBe(16);
    expect(draftBarRect.top - rootRect.top).toBe(-40);
    expect(rootRect.width - draftBarRect.width).toBe(32);
    await expect.element(page.getByTestId("draft-bar")).toBeVisible();
    await expect.element(page.getByTestId("live-editor")).toBeVisible();
  });

  it("pins production composer actions to the bottom of the 100px shell", async () => {
    await render(
      <ComposerDefault layoutMode="application">
        <div className="min-h-7 px-[10px] pt-[14px] pb-2" data-testid="live-editor">
          Do something
        </div>
        <div className={COMPOSER_FOOTER_ROW_CLASS_NAME} data-testid="composer-footer">
          <div className="h-[26px]" data-testid="composer-actions" />
        </div>
      </ComposerDefault>,
    );

    const root = document.querySelector<HTMLElement>("[data-pencil-component='TKKOp']")!;
    const surface = root.lastElementChild as HTMLElement;
    const footer = page.getByTestId("composer-footer").element();
    const actions = page.getByTestId("composer-actions").element();
    const surfaceRect = surface.getBoundingClientRect();
    const footerRect = footer.getBoundingClientRect();
    const actionsRect = actions.getBoundingClientRect();

    expect(footerRect.bottom).toBeCloseTo(surfaceRect.bottom - 1, 0);
    expect(surfaceRect.bottom - actionsRect.bottom).toBeCloseTo(11, 0);
  });

  it("lets the recording controls fill the toolbar after the attach action", async () => {
    await render(
      <div className="w-[618px]">
        <ComposerActions
          applicationLeading={<div className="h-[26px] w-[26px]" data-testid="attach-action" />}
          applicationTrailing={<div className="h-[26px] w-full" data-testid="voice-recorder" />}
          applicationTrailingExpands
        />
      </div>,
    );

    const actions = document.querySelector<HTMLElement>("[data-pencil-component='JwTiI']")!;
    const attach = page.getByTestId("attach-action").element();
    const recorder = page.getByTestId("voice-recorder").element();
    const actionsRect = actions.getBoundingClientRect();
    const attachRect = attach.getBoundingClientRect();
    const recorderRect = recorder.getBoundingClientRect();

    expect(recorderRect.left - attachRect.right).toBe(4);
    expect(actionsRect.right - recorderRect.right).toBeCloseTo(0, 0);
  });

  it("matches every approved responsive rail width without shrinking the screen", async () => {
    await render(
      <div>
        {[800, 780, 640, 560, 430, 320].map((width) => (
          <div className="chat-pane-container" key={width} style={{ width }}>
            <div className="chat-pane-responsive-rail" data-testid={`responsive-rail-${width}`} />
          </div>
        ))}
      </div>,
    );

    for (const [containerWidth, railWidth] of [
      [800, 640],
      [780, 640],
      [640, 592],
      [560, 512],
      [430, 406],
      [320, 296],
    ] as const) {
      expect(
        page.getByTestId(`responsive-rail-${containerWidth}`).element().getBoundingClientRect()
          .width,
      ).toBe(railWidth);
    }
  });

  it("matches the approved parent prompt typography at all three composer sizes", async () => {
    await render(
      <div>
        {[512, 406, 296].map((width) => (
          <div className="@container" key={width} style={{ width }}>
            <FolderPromptShared className="w-full" folderName="Personal" />
          </div>
        ))}
      </div>,
    );

    const prompts = Array.from(
      document.querySelectorAll<HTMLElement>("[data-pencil-component='dZsWR']"),
    );
    expect(prompts).toHaveLength(3);
    expect(prompts.map((prompt) => getComputedStyle(prompt).fontSize)).toEqual([
      "28px",
      "26px",
      "24px",
    ]);
    expect(prompts[0]!.getBoundingClientRect().height).toBeCloseTo(43, 0);
    expect(prompts[1]!.getBoundingClientRect().height).toBeGreaterThan(64);
    expect(prompts[2]!.getBoundingClientRect().height).toBeGreaterThan(60);
  });

  it("keeps a long parent name on one line at the full composer size", async () => {
    await render(
      <div className="@container" style={{ width: 512 }}>
        <FolderPromptShared className="w-full" folderName="emmanuelgyekyeatta-penkra" />
      </div>,
    );

    const prompt = document.querySelector<HTMLElement>("[data-pencil-component='dZsWR']")!;
    const folderName = prompt.querySelector<HTMLElement>("span > span.border-current")!;
    expect(prompt.getBoundingClientRect().height).toBeCloseTo(43, 0);
    expect(getComputedStyle(folderName).whiteSpace).toBe("nowrap");
    expect(folderName.scrollWidth).toBeGreaterThanOrEqual(folderName.clientWidth);
  });

  it("uses the compact Pencil runtime menu above the draft bar", async () => {
    await render(<DraftFolderBar folderPicker={<button type="button">Choose Folder</button>} />);

    await page.getByRole("button", { name: "This Mac" }).click();
    const popup = document.querySelector<HTMLElement>("[data-pencil-component='DJLI5']");
    expect(popup).not.toBeNull();
    expect(popup!.getBoundingClientRect().width).toBe(160);
    await page.getByRole("button", { name: "This Mac" }).click();
    await vi.waitFor(() => {
      expect(document.querySelector("[data-pencil-component='DJLI5']")).toBeNull();
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
