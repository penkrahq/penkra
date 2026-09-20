import "../../index.css";

import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { ExpandedImageOverlay } from "./ExpandedImageOverlay";

describe("ExpandedImageOverlay", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("renders nothing without an expanded image", async () => {
    const screen = await render(
      <ExpandedImageOverlay expandedImage={null} onClose={vi.fn()} onNavigate={vi.fn()} />,
    );

    try {
      await expect
        .element(page.getByRole("dialog", { name: "Expanded image preview" }))
        .not.toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });

  it("renders the selected image and dispatches previous, next, and close", async () => {
    const onClose = vi.fn();
    const onNavigate = vi.fn();
    const screen = await render(
      <ExpandedImageOverlay
        expandedImage={{
          images: [
            { src: "data:image/png;base64,first", name: "First image" },
            { src: "data:image/png;base64,second", name: "Second image" },
            { src: "data:image/png;base64,third", name: "Third image" },
          ],
          index: 1,
        }}
        onClose={onClose}
        onNavigate={onNavigate}
      />,
    );

    try {
      await expect.element(page.getByRole("img", { name: "Second image" })).toBeInTheDocument();
      await expect.element(page.getByText("Second image (2/3)")).toBeInTheDocument();

      await page.getByRole("button", { name: "Previous image" }).click();
      await page.getByRole("button", { name: "Next image" }).click();
      document
        .querySelector<HTMLButtonElement>('button[aria-label="Close image preview"]')
        ?.click();

      expect(onNavigate).toHaveBeenNthCalledWith(1, -1);
      expect(onNavigate).toHaveBeenNthCalledWith(2, 1);
      expect(onClose).toHaveBeenCalledOnce();
    } finally {
      await screen.unmount();
    }
  });

  it("covers the left rail and chat while leaving the right dock interactive", async () => {
    const screen = await render(
      <div
        className="fixed inset-0 flex [--right-dock-overlay-inset:160px]"
        data-chat-surface-shell
      >
        <aside className="w-[160px]" data-testid="left-panel" />
        <main className="relative h-full min-w-0 flex-1" data-testid="center-panel">
          <ExpandedImageOverlay
            expandedImage={{
              images: [{ src: "data:image/png;base64,center", name: "Center image" }],
              index: 0,
            }}
            onClose={vi.fn()}
            onNavigate={vi.fn()}
          />
        </main>
        <aside
          className="h-full w-[160px] bg-background"
          data-right-dock-root
          data-testid="right-panel"
        />
      </div>,
    );

    try {
      const left = document.querySelector<HTMLElement>('[data-testid="left-panel"]');
      const right = document.querySelector<HTMLElement>('[data-testid="right-panel"]');
      const overlay = document.querySelector<HTMLElement>(
        '[role="dialog"][aria-label="Expanded image preview"]',
      );
      expect(left).not.toBeNull();
      expect(right).not.toBeNull();
      expect(overlay).not.toBeNull();

      const overlayBounds = overlay!.getBoundingClientRect();
      expect(overlayBounds.left).toBe(0);
      expect(overlayBounds.top).toBe(0);
      expect(overlayBounds.right).toBe(right!.getBoundingClientRect().left);
      expect(overlayBounds.width).toBe(window.innerWidth - right!.getBoundingClientRect().width);
      expect(overlayBounds.height).toBe(window.innerHeight);

      const imageFrame = overlay!.querySelector<HTMLElement>(":scope > div");
      expect(imageFrame).not.toBeNull();
      const imageFrameBounds = imageFrame!.getBoundingClientRect();
      expect(imageFrameBounds.left + imageFrameBounds.width / 2).toBeCloseTo(
        overlayBounds.left + overlayBounds.width / 2,
        1,
      );

      const leftBounds = left!.getBoundingClientRect();
      const leftHit = document.elementFromPoint(
        leftBounds.left + leftBounds.width / 2,
        leftBounds.height / 2,
      );
      expect(leftHit).not.toBeNull();
      expect(overlay!.contains(leftHit)).toBe(true);

      const rightBounds = right!.getBoundingClientRect();
      expect(
        document.elementFromPoint(
          rightBounds.left + rightBounds.width / 2,
          rightBounds.top + rightBounds.height / 2,
        ),
      ).toBe(right);
    } finally {
      await screen.unmount();
    }
  });
});
