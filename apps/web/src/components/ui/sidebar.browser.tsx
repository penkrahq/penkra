import "../../index.css";

import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CSSProperties } from "react";
import { render } from "vitest-browser-react";

import { Sidebar, SidebarProvider, SidebarRail, type SidebarResizableOptions } from "./sidebar";

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("live sidebar resizing", () => {
  it("updates actual layout on the next displayed pointer frame", async () => {
    const { wrapper, rail } = await renderResizableSidebar();

    dispatchPointer(rail, "pointerdown", { button: 0, clientX: 800, pointerId: 7 });
    dispatchPointer(rail, "pointermove", { clientX: 600, pointerId: 7 });
    await nextAnimationFrame();

    expect(wrapper.style.getPropertyValue("--sidebar-width")).toBe("520px");
  });

  it("does not lose the last rapid move when release precedes animation-frame delivery", async () => {
    const onResize = vi.fn();
    const { wrapper, rail } = await renderResizableSidebar(onResize);

    dispatchPointer(rail, "pointerdown", { button: 0, clientX: 800, pointerId: 9 });
    dispatchPointer(rail, "pointermove", { clientX: 650, pointerId: 9 });
    dispatchPointer(rail, "pointerup", { button: 0, clientX: 650, pointerId: 9 });

    expect(wrapper.style.getPropertyValue("--sidebar-width")).toBe("470px");
    expect(onResize).toHaveBeenCalledOnce();
    expect(onResize).toHaveBeenCalledWith(470);
  });

  it("commits a constrained width when a rapid move crosses the boundary", async () => {
    const onResize = vi.fn();
    const { wrapper, rail } = await renderResizableSidebar(onResize, ({ nextWidth }) =>
      Math.min(nextWidth, 400),
    );

    dispatchPointer(rail, "pointerdown", { button: 0, clientX: 800, pointerId: 11 });
    dispatchPointer(rail, "pointermove", { clientX: 500, pointerId: 11 });
    dispatchPointer(rail, "pointerup", { button: 0, clientX: 500, pointerId: 11 });

    expect(wrapper.style.getPropertyValue("--sidebar-width")).toBe("400px");
    expect(onResize).toHaveBeenCalledWith(400);
  });
});

async function renderResizableSidebar(
  onResize?: (width: number) => void,
  shouldAcceptWidth?: SidebarResizableOptions["shouldAcceptWidth"],
) {
  await page.viewport(1_280, 720);
  const screen = await render(
    <SidebarProvider open style={{ "--sidebar-width": "320px" } as CSSProperties}>
      <Sidebar
        positioning="inline"
        resizable={{
          minWidth: 240,
          ...(onResize ? { onResize } : {}),
          ...(shouldAcceptWidth ? { shouldAcceptWidth } : {}),
        }}
        side="right"
      >
        <div>Hosted surface</div>
        <SidebarRail />
      </Sidebar>
    </SidebarProvider>,
  );

  const wrapper = document.querySelector<HTMLElement>("[data-slot='sidebar-wrapper']")!;
  const container = document.querySelector<HTMLElement>("[data-slot='sidebar-container']")!;
  const rail = document.querySelector<HTMLButtonElement>("[data-slot='sidebar-rail']")!;
  container.getBoundingClientRect = () =>
    ({ left: 800, right: 1_120, top: 0, bottom: 600, width: 320, height: 600 }) as DOMRect;
  let capturedPointerId: number | null = null;
  rail.setPointerCapture = (pointerId) => {
    capturedPointerId = pointerId;
  };
  rail.hasPointerCapture = (pointerId) => capturedPointerId === pointerId;
  const release = vi.fn((pointerId: number) => {
    capturedPointerId = null;
    rail.dispatchEvent(new PointerEvent("lostpointercapture", { bubbles: true, pointerId }));
  });
  rail.releasePointerCapture = release;

  return { screen, rail, wrapper, release };
}

function dispatchPointer(
  target: HTMLElement,
  type: "pointerdown" | "pointermove" | "pointerup",
  init: PointerEventInit,
): void {
  target.dispatchEvent(new PointerEvent(type, { bubbles: true, ...init }));
}

function nextAnimationFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

const POINTER_ID = 7;

async function startResize(shouldAcceptWidth?: SidebarResizableOptions["shouldAcceptWidth"]) {
  const onResize = vi.fn();
  const result = await renderResizableSidebar(onResize, shouldAcceptWidth);
  dispatchPointer(result.rail, "pointerdown", { button: 0, pointerId: POINTER_ID, clientX: 200 });
  expect(document.body.style.cursor).toBe("col-resize");
  expect(document.body.style.userSelect).toBe("none");
  return { ...result, onResize };
}

function expectReleased() {
  expect(document.body.style.cursor).toBe("");
  expect(document.body.style.userSelect).toBe("");
  for (const element of document.querySelectorAll<HTMLElement>(
    "[data-slot='sidebar-gap'], [data-slot='sidebar-container']",
  )) {
    expect(element.style.transitionDuration).toBe("");
  }
}

describe("sidebar resize cleanup", () => {
  it("clears the cursor on lost capture and commits the width once under re-entry", async () => {
    const { screen, rail, onResize, release } = await startResize();
    try {
      rail.dispatchEvent(
        new PointerEvent("lostpointercapture", { bubbles: true, pointerId: POINTER_ID }),
      );
      expectReleased();
      expect(onResize).toHaveBeenCalledTimes(1);
      expect(release).toHaveBeenCalledTimes(1);
      rail.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: POINTER_ID }));
      window.dispatchEvent(new Event("blur"));
      expect(onResize).toHaveBeenCalledTimes(1);
      expect(release).toHaveBeenCalledTimes(1);
    } finally {
      await screen.unmount();
    }
  });

  it("finishes the pending width on window blur and ignores later pointer events", async () => {
    const { screen, rail, onResize } = await startResize();
    try {
      rail.dispatchEvent(
        new PointerEvent("pointermove", { bubbles: true, pointerId: POINTER_ID, clientX: 260 }),
      );
      window.dispatchEvent(new Event("blur"));
      expectReleased();
      expect(onResize).toHaveBeenCalledTimes(1);
      const wrapper = rail.closest<HTMLElement>("[data-slot='sidebar-wrapper']");
      expect(wrapper?.style.getPropertyValue("--sidebar-width")).toBe(
        `${onResize.mock.calls[0]![0]}px`,
      );
      window.dispatchEvent(new Event("blur"));
      rail.dispatchEvent(
        new PointerEvent("pointercancel", { bubbles: true, pointerId: POINTER_ID }),
      );
      expect(onResize).toHaveBeenCalledTimes(1);
    } finally {
      await screen.unmount();
    }
  });

  it("does not commit twice when the width validator synchronously loses window focus", async () => {
    const { screen, rail, onResize } = await startResize(() => {
      window.dispatchEvent(new Event("blur"));
      return true;
    });
    try {
      rail.dispatchEvent(
        new PointerEvent("pointermove", { bubbles: true, pointerId: POINTER_ID, clientX: 260 }),
      );
      rail.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: POINTER_ID }));
      expectReleased();
      expect(onResize).toHaveBeenCalledTimes(1);
    } finally {
      await screen.unmount();
    }
  });

  it("ignores capture loss for another pointer", async () => {
    const { screen, rail, onResize } = await startResize();
    try {
      rail.dispatchEvent(
        new PointerEvent("lostpointercapture", { bubbles: true, pointerId: POINTER_ID + 1 }),
      );
      expect(document.body.style.cursor).toBe("col-resize");
      expect(onResize).not.toHaveBeenCalled();
      window.dispatchEvent(new Event("blur"));
      expectReleased();
    } finally {
      await screen.unmount();
    }
  });

  it("releases capture and cursor on unmount without committing a discarded drag", async () => {
    const { screen, release, onResize } = await startResize();
    await screen.unmount();
    expectReleased();
    expect(release).toHaveBeenCalledTimes(1);
    expect(onResize).not.toHaveBeenCalled();
    window.dispatchEvent(new Event("blur"));
    expect(onResize).not.toHaveBeenCalled();
  });
});
