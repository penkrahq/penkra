import "../../index.css";

import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

vi.mock("@tanstack/react-router", () => ({
  useParams: () => null,
}));

import { ToastProvider, toastManager, useThreadToastViewportHostRef } from "./toast";

function CenterPanelToastHarness() {
  const toastViewportHostRef = useThreadToastViewportHostRef();

  return (
    <div className="flex h-96 w-[850px]">
      <aside className="w-[60px] shrink-0 bg-red-100" data-testid="left-panel">
        <button
          type="button"
          onClick={() =>
            toastManager.add({
              type: "warning",
              title: "Input needed",
              description:
                "Marketing's corrected test is blocked again, at the first caption entry, and I am not retrying around it.",
              data: { compactContextual: true },
            })
          }
        >
          Go
        </button>
      </aside>
      <main
        ref={toastViewportHostRef}
        className="relative w-[700px] shrink-0 bg-blue-100"
        data-testid="center-panel"
      />
      <aside className="w-[90px] shrink-0 bg-green-100" data-testid="right-panel" />
    </div>
  );
}

describe("ToastProvider center panel placement", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("portals and centers global notices within the thread center panel", async () => {
    await page.viewport(1200, 800);
    const screen = await render(
      <ToastProvider position="top-center">
        <CenterPanelToastHarness />
      </ToastProvider>,
    );

    try {
      await page.getByRole("button", { name: "Go" }).click();
      await expect.element(page.getByText("Input needed")).toBeInTheDocument();

      const centerPanel = document.querySelector<HTMLElement>('[data-testid="center-panel"]');
      const viewport = document.querySelector<HTMLElement>('[data-slot="toast-viewport"]');
      expect(centerPanel).not.toBeNull();
      expect(viewport).not.toBeNull();
      expect(centerPanel!.contains(viewport)).toBe(true);

      const centerBounds = centerPanel!.getBoundingClientRect();
      const viewportBounds = viewport!.getBoundingClientRect();
      expect(viewportBounds.left + viewportBounds.width / 2).toBeCloseTo(
        centerBounds.left + centerBounds.width / 2,
        1,
      );
      const card = viewport!.querySelector<HTMLElement>('[data-position="top-center"]')!;
      const cardBounds = card.getBoundingClientRect();
      expect(cardBounds.left + cardBounds.width / 2).toBeCloseTo(
        centerBounds.left + centerBounds.width / 2,
        1,
      );
      centerPanel!.style.width = "180px";
      const narrowPanelBounds = centerPanel!.getBoundingClientRect();
      const narrowCardBounds = card.getBoundingClientRect();
      expect(narrowCardBounds.left + narrowCardBounds.width / 2).toBeCloseTo(
        narrowPanelBounds.left + narrowPanelBounds.width / 2,
        1,
      );
      centerPanel!.style.width = "700px";
      await expect
        .poll(() => card.getBoundingClientRect().top)
        .toBeCloseTo(centerBounds.top + 16, 0);
    } finally {
      await screen.unmount();
    }
  });
});
