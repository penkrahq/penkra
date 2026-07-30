import "../../../index.css";

import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { SpacePageShared } from "../space-page-shared/SpacePageShared";
import { SpaceViewportShared } from "./SpaceViewportShared";

describe("SpaceViewportShared", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("keeps the track hard-clamped at the outer boundary", async () => {
    const onActivePageIndexChange = vi.fn();
    await render(
      <div className="h-40 w-60">
        <SpaceViewportShared
          activePageIndex={0}
          onActivePageIndexChange={onActivePageIndexChange}
          pageCount={2}
        >
          <SpacePageShared active label="Current">
            Current
          </SpacePageShared>
          <SpacePageShared active={false} label="Prototype">
            Prototype
          </SpacePageShared>
        </SpaceViewportShared>
      </div>,
    );

    const viewport = document.querySelector<HTMLElement>("[data-slot='space-viewport']")!;
    const track = document.querySelector<HTMLElement>("[data-slot='space-track']")!;
    expect(viewport.clientWidth).toBe(240);
    viewport.dispatchEvent(
      new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        deltaX: -100,
      }),
    );

    expect(track.style.transform).toBe("translate3d(0px, 0px, 0px)");
    expect(onActivePageIndexChange).not.toHaveBeenCalled();
  });

  it("applies engagement resistance before approaching direct tracking", async () => {
    await render(
      <div className="h-40 w-60">
        <SpaceViewportShared
          activePageIndex={0}
          onActivePageIndexChange={() => undefined}
          pageCount={2}
        >
          <SpacePageShared active label="Current">
            Current
          </SpacePageShared>
          <SpacePageShared active={false} label="Prototype">
            Prototype
          </SpacePageShared>
        </SpaceViewportShared>
      </div>,
    );

    const viewport = document.querySelector<HTMLElement>("[data-slot='space-viewport']")!;
    const track = document.querySelector<HTMLElement>("[data-slot='space-track']")!;
    viewport.dispatchEvent(
      new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        deltaX: 16,
      }),
    );

    const initialTranslation = Number.parseFloat(
      track.style.transform.match(/translate3d\(([-\d.]+)px/)?.[1] ?? "0",
    );
    expect(initialTranslation).toBeLessThan(0);
    expect(initialTranslation).toBeGreaterThan(-8);
  });

  it("commits at most one page after a deliberate horizontal gesture", async () => {
    const onActivePageIndexChange = vi.fn();
    await render(
      <div className="h-40 w-60">
        <SpaceViewportShared
          activePageIndex={0}
          onActivePageIndexChange={onActivePageIndexChange}
          pageCount={3}
        >
          <SpacePageShared active label="Current">
            Current
          </SpacePageShared>
          <SpacePageShared active={false} label="Prototype">
            Prototype
          </SpacePageShared>
          <SpacePageShared active={false} label="Third">
            Third
          </SpacePageShared>
        </SpaceViewportShared>
      </div>,
    );

    const viewport = document.querySelector<HTMLElement>("[data-slot='space-viewport']")!;
    for (let index = 0; index < 4; index += 1) {
      viewport.dispatchEvent(
        new WheelEvent("wheel", {
          bubbles: true,
          cancelable: true,
          deltaX: 30,
        }),
      );
    }
    await new Promise((resolve) => window.setTimeout(resolve, 100));

    expect(onActivePageIndexChange).toHaveBeenCalledOnce();
    expect(onActivePageIndexChange).toHaveBeenCalledWith(1);
  });

  it("leaves vertically dominant gestures available to the project scroller", async () => {
    await render(
      <div className="h-40 w-60">
        <SpaceViewportShared
          activePageIndex={0}
          onActivePageIndexChange={() => undefined}
          pageCount={2}
        >
          <SpacePageShared active label="Current">
            Current
          </SpacePageShared>
          <SpacePageShared active={false} label="Prototype">
            Prototype
          </SpacePageShared>
        </SpaceViewportShared>
      </div>,
    );

    const viewport = document.querySelector<HTMLElement>("[data-slot='space-viewport']")!;
    const verticalWheel = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaX: 2,
      deltaY: 20,
    });
    viewport.dispatchEvent(verticalWheel);

    expect(verticalWheel.defaultPrevented).toBe(false);
  });

  it("keeps inactive Space contents outside keyboard and accessibility interaction", async () => {
    await render(
      <div className="h-40 w-60">
        <SpaceViewportShared
          activePageIndex={0}
          onActivePageIndexChange={() => undefined}
          pageCount={2}
        >
          <SpacePageShared active label="Current">
            <button type="button">Current action</button>
          </SpacePageShared>
          <SpacePageShared active={false} label="Prototype">
            <button type="button">Prototype action</button>
          </SpacePageShared>
        </SpaceViewportShared>
      </div>,
    );

    const pages = document.querySelectorAll<HTMLElement>("[aria-roledescription='space']");
    expect(pages[0]?.inert).toBe(false);
    expect(pages[1]?.inert).toBe(true);
    expect(pages[1]?.getAttribute("aria-hidden")).toBe("true");
  });
});
