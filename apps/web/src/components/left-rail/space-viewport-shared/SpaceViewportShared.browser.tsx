import "../../../index.css";

import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { SpacePageShared } from "../space-page-shared/SpacePageShared";
import { SpaceViewportShared } from "./SpaceViewportShared";

function renderViewport({
  activePageIndex = 0,
  onActivePageIndexChange = () => undefined,
}: {
  activePageIndex?: number;
  onActivePageIndexChange?: (pageIndex: number) => void;
} = {}) {
  return render(
    <div className="h-40 w-60">
      <SpaceViewportShared
        activePageIndex={activePageIndex}
        onActivePageIndexChange={onActivePageIndexChange}
      >
        <SpacePageShared active={activePageIndex === 0} label="Current">
          <div className="h-8 overflow-y-auto" data-testid="nested-scroller">
            <div className="h-20">
              <button type="button">Current action</button>
            </div>
          </div>
        </SpacePageShared>
        <SpacePageShared active={activePageIndex === 1} label="Prototype">
          <button type="button">Prototype action</button>
        </SpacePageShared>
      </SpaceViewportShared>
    </div>,
  );
}

function getViewport() {
  return document.querySelector<HTMLElement>("[data-slot='space-viewport']")!;
}

describe("SpaceViewportShared", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("pages on a native mandatory scroll-snap container", async () => {
    await renderViewport();

    const viewport = getViewport();
    const styles = window.getComputedStyle(viewport);
    expect(styles.scrollSnapType).toBe("x mandatory");
    expect(styles.overflowX).toBe("auto");
    // Keeps a horizontal overscroll from reaching the window and triggering
    // the desktop swipe-back navigation gesture.
    expect(styles.overscrollBehaviorX).toBe("contain");
    expect(viewport.clientWidth).toBe(240);
    expect(viewport.scrollWidth).toBe(480);
  });

  it("stops on every page so one gesture can never skip a Space", async () => {
    await renderViewport();

    for (const page of document.querySelectorAll<HTMLElement>("[aria-roledescription='space']")) {
      const styles = window.getComputedStyle(page);
      expect(styles.scrollSnapAlign).toBe("start");
      expect(styles.scrollSnapStop).toBe("always");
    }
  });

  it("reports the page the scroller settles on", async () => {
    const onActivePageIndexChange = vi.fn();
    await renderViewport({ onActivePageIndexChange });

    const viewport = getViewport();
    const snapped = new Promise<void>((resolve) => {
      viewport.addEventListener("scrollsnapchange", () => resolve(), { once: true });
    });
    viewport.scrollTo({ behavior: "instant", left: 240 });
    await snapped;

    expect(onActivePageIndexChange).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("routes a horizontal wheel gesture from nested content into the Space viewport", async () => {
    const onActivePageIndexChange = vi.fn();
    await renderViewport({ onActivePageIndexChange });

    const viewport = getViewport();
    const nestedAction = document.querySelector<HTMLElement>("button")!;
    const wheelEvent = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaX: 160,
      deltaY: 4,
    });
    nestedAction.dispatchEvent(wheelEvent);

    expect(wheelEvent.defaultPrevented).toBe(true);
    expect(viewport.scrollLeft).toBe(160);
    await vi.waitFor(() => expect(viewport.scrollLeft).toBe(240));
    expect(onActivePageIndexChange).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("leaves vertical wheel gestures available to nested sidebar scrollers", async () => {
    await renderViewport();

    const viewport = getViewport();
    const nestedAction = document.querySelector<HTMLElement>("button")!;
    const wheelEvent = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaX: 2,
      deltaY: 20,
    });
    nestedAction.dispatchEvent(wheelEvent);

    expect(wheelEvent.defaultPrevented).toBe(false);
    expect(viewport.scrollLeft).toBe(0);
  });

  it("keeps a vertically locked gesture vertical until that gesture ends", async () => {
    await renderViewport();

    const viewport = getViewport();
    const nestedAction = document.querySelector<HTMLElement>("button")!;
    nestedAction.dispatchEvent(
      new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        deltaX: 1,
        deltaY: 20,
      }),
    );
    const trailingHorizontalEvent = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaX: 160,
      deltaY: 0,
    });
    nestedAction.dispatchEvent(trailingHorizontalEvent);

    expect(trailingHorizontalEvent.defaultPrevented).toBe(false);
    expect(viewport.scrollLeft).toBe(0);
  });

  it("scrolls to the active page when it is changed from outside the gesture", async () => {
    const screen = await renderViewport();

    expect(getViewport().scrollLeft).toBe(0);
    await screen.rerender(
      <div className="h-40 w-60">
        <SpaceViewportShared activePageIndex={1} onActivePageIndexChange={() => undefined}>
          <SpacePageShared active={false} label="Current">
            <button type="button">Current action</button>
          </SpacePageShared>
          <SpacePageShared active label="Prototype">
            <button type="button">Prototype action</button>
          </SpacePageShared>
        </SpaceViewportShared>
      </div>,
    );

    await vi.waitFor(() => expect(getViewport().scrollLeft).toBe(240));
  });

  it("keeps inactive Space contents outside keyboard and accessibility interaction", async () => {
    await renderViewport();

    const pages = document.querySelectorAll<HTMLElement>("[aria-roledescription='space']");
    expect(pages[0]?.inert).toBe(false);
    expect(pages[1]?.inert).toBe(true);
    expect(pages[1]?.getAttribute("aria-hidden")).toBe("true");
  });
});
