import "../../index.css";

import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { SpacePageShared } from "../space-page-shared/SpacePageShared";
import { SpaceViewportShared } from "./SpaceViewportShared";

describe("SpaceViewportShared", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("settles one viewport width at a time and reports the resulting page", async () => {
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
    expect(viewport.clientWidth).toBe(240);
    viewport.scrollLeft = viewport.clientWidth;
    viewport.dispatchEvent(new Event("scrollend"));

    expect(onActivePageIndexChange).toHaveBeenCalledOnce();
    expect(onActivePageIndexChange).toHaveBeenCalledWith(1);
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
