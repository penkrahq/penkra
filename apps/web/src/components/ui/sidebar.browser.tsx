import "../../index.css";

import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CSSProperties } from "react";
import { render } from "vitest-browser-react";

import { Sidebar, SidebarProvider, SidebarRail } from "./sidebar";

afterEach(() => {
  document.body.innerHTML = "";
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
  shouldAcceptWidth?: (context: { nextWidth: number }) => boolean | number,
) {
  await page.viewport(1_280, 720);
  await render(
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
  rail.releasePointerCapture = () => {
    capturedPointerId = null;
  };

  return { rail, wrapper };
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
