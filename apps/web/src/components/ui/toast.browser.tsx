import "../../index.css";

import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

vi.mock("@tanstack/react-router", () => ({
  useParams: () => null,
}));

vi.mock("../../hooks/useChatRouteSearch", () => ({
  useChatRouteSearch: () => ({}),
}));

vi.mock("../../splitViewStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../splitViewStore")>()),
  selectSplitView: () => () => null,
  useSplitViewStore: (selector: (state: object) => unknown) => selector({}),
}));

import { ToastProvider, toastManager, useThreadToastViewportHostRef } from "./toast";

function CenterPanelToastHarness() {
  const toastViewportHostRef = useThreadToastViewportHostRef();

  return (
    <div className="flex h-96 w-[330px]">
      <aside className="w-[60px] shrink-0 bg-red-100" data-testid="left-panel">
        <button
          type="button"
          onClick={() => toastManager.add({ type: "warning", title: "Input needed" })}
        >
          Go
        </button>
      </aside>
      <main
        ref={toastViewportHostRef}
        className="relative w-[180px] shrink-0 bg-blue-100"
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
    } finally {
      await screen.unmount();
    }
  });
});
