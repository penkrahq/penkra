import "../../index.css";

import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import type { CSSProperties } from "react";
import type { DesktopAppTabPresentation } from "@penkra/contracts";
import { page } from "vitest/browser";

import { AppDockPane } from "./AppDockPane";
import { publishNativeAppBounds } from "../ui/sidebar";

const originalBridge = Object.getOwnPropertyDescriptor(window, "desktopBridge");
const originalVisibilityState = Object.getOwnPropertyDescriptor(document, "visibilityState");

afterEach(() => {
  document.body.innerHTML = "";
  if (originalBridge) Object.defineProperty(window, "desktopBridge", originalBridge);
  else Reflect.deleteProperty(window, "desktopBridge");
  if (originalVisibilityState) {
    Object.defineProperty(document, "visibilityState", originalVisibilityState);
  } else {
    Reflect.deleteProperty(document, "visibilityState");
  }
});

function installBridge(zoomFactor = 1) {
  const present = vi.fn(
    async (_input: { bounds: { x: number; y: number; width: number; height: number } }) =>
      undefined,
  );
  const hide = vi.fn(async () => undefined);
  let presentationListener: ((value: DesktopAppTabPresentation) => void) | null = null;
  Object.defineProperty(window, "desktopBridge", {
    configurable: true,
    value: {
      getZoomFactor: () => zoomFactor,
      appTabs: {
        present,
        hide,
        trace: vi.fn(async () => undefined),
        onPresentation: (listener: (value: DesktopAppTabPresentation) => void) => {
          presentationListener = listener;
          return () => {
            presentationListener = null;
          };
        },
      },
    },
  });
  return {
    present,
    hide,
    publishPresentation: (value: DesktopAppTabPresentation) => presentationListener?.(value),
  };
}

describe("AppDockPane native view controller", () => {
  it("converts the clipped host rect from CSS pixels to native DIP once", async () => {
    await page.viewport(1280, 800);
    const bridge = installBridge(1.25);
    await render(
      <div style={{ marginLeft: 200, width: 180, height: 600 }} data-slot="sidebar-container">
        <div data-slot="sidebar-wrapper" style={{ width: 180, height: 600 }}>
          <AppDockPane
            deckId="deck-1"
            threadId="thread-1"
            appName="Apps"
            rendererId={101}
            status="ready"
            tabId="zoomed-tab"
            visible
            animateEntrance={false}
            animationStartedAtEpochMs={null}
          />
        </div>
      </div>,
    );
    await vi.waitFor(() => expect(bridge.present).toHaveBeenCalledOnce());
    expect(bridge.present.mock.lastCall?.[0].bounds).toEqual({
      x: 250,
      y: 0,
      width: 225,
      height: 750,
    });
  });

  it("presents within the actual narrow dock host instead of a right-anchored minimum", async () => {
    await page.viewport(1280, 800);
    const bridge = installBridge();
    await render(
      <div style={{ marginLeft: 500, width: 180, height: 600 }} data-slot="sidebar-container">
        <div data-slot="sidebar-wrapper" style={{ width: 180, height: 600 }}>
          <AppDockPane
            deckId="deck-1"
            threadId="thread-1"
            appName="Apps"
            rendererId={101}
            status="ready"
            tabId="narrow-tab"
            visible
            animateEntrance={false}
            animationStartedAtEpochMs={null}
          />
        </div>
      </div>,
    );
    await vi.waitFor(() => expect(bridge.present).toHaveBeenCalledOnce());
    expect(bridge.present).toHaveBeenCalledWith(
      expect.objectContaining({ bounds: { x: 500, y: 0, width: 180, height: 600 } }),
    );
  });

  it("clips a wide host to its panel and follows shrink after grow", async () => {
    await page.viewport(1280, 800);
    const bridge = installBridge();
    const screen = await render(
      <div style={{ marginLeft: 200, width: 500, height: 600 }} data-slot="sidebar-container">
        <div data-slot="sidebar-wrapper" style={{ width: 500, height: 600 }}>
          <AppDockPane
            deckId="deck-1"
            threadId="thread-1"
            appName="Apps"
            rendererId={101}
            status="ready"
            tabId="resizing-tab"
            visible
            animateEntrance={false}
            animationStartedAtEpochMs={null}
          />
        </div>
      </div>,
    );
    await vi.waitFor(() => expect(bridge.present).toHaveBeenCalledOnce());
    const panel = screen.container.querySelector<HTMLElement>("[data-slot='sidebar-container']")!;
    const wrapper = screen.container.querySelector<HTMLElement>("[data-slot='sidebar-wrapper']")!;
    expect(bridge.present.mock.lastCall?.[0].bounds).toEqual({
      x: 200,
      y: 0,
      width: 500,
      height: 600,
    });
    expect(publishNativeAppBounds(wrapper)).toBe(false);
    expect(bridge.present).toHaveBeenCalledOnce();

    panel.style.width = "180px";
    publishNativeAppBounds(wrapper);
    expect(bridge.present).toHaveBeenCalledTimes(2);
    expect(bridge.present.mock.lastCall?.[0].bounds).toEqual({
      x: 200,
      y: 0,
      width: 180,
      height: 600,
    });

    panel.style.width = "500px";
    publishNativeAppBounds(wrapper);
    expect(bridge.present).toHaveBeenCalledTimes(3);
    expect(bridge.present.mock.lastCall?.[0].bounds).toEqual({
      x: 200,
      y: 0,
      width: 500,
      height: 600,
    });

    panel.style.width = "0px";
    expect(publishNativeAppBounds(wrapper)).toBe(false);
    expect(bridge.hide).not.toHaveBeenCalled();
    panel.style.width = "500px";
    expect(publishNativeAppBounds(wrapper)).toBe(true);
    expect(bridge.present).toHaveBeenCalledTimes(4);

    bridge.publishPresentation({ tabId: "resizing-tab", mode: "hidden", ownerWindowId: 1 });
    expect(publishNativeAppBounds(wrapper)).toBe(true);
    expect(bridge.present).toHaveBeenCalledTimes(5);
  });
  it("presents from rendered geometry when deck re-entry precedes pixel width publication", async () => {
    const bridge = installBridge();
    const screen = await render(
      <div
        data-slot="sidebar-wrapper"
        style={
          {
            "--sidebar-width": "max(28rem, calc(50vw - 8rem))",
            width: 500,
            height: 600,
          } as CSSProperties
        }
      >
        <AppDockPane
          deckId="returning-deck"
          threadId="returning-thread"
          appName="Apps"
          rendererId={101}
          status="ready"
          tabId="returning-tab"
          visible
          animateEntrance={false}
          animationStartedAtEpochMs={null}
        />
      </div>,
    );

    await vi.waitFor(() => expect(bridge.present).toHaveBeenCalledOnce());
    screen.container
      .querySelector<HTMLElement>("[data-slot='sidebar-wrapper']")!
      .style.setProperty("--sidebar-width", "500px");
    expect(bridge.present).toHaveBeenCalledOnce();
  });

  it("presents the main-owned view without rendering an iframe or webview", async () => {
    const bridge = installBridge();
    const screen = await render(
      <div
        data-slot="sidebar-wrapper"
        style={{ "--sidebar-width": "500px", height: 600 } as CSSProperties}
      >
        <AppDockPane
          deckId="deck-1"
          threadId="thread-1"
          appName="Canvas"
          rendererId={101}
          status="ready"
          tabId="stable-tab"
          visible
          animateEntrance
          animationStartedAtEpochMs={1234}
        />
      </div>,
    );
    await vi.waitFor(() => expect(bridge.present).toHaveBeenCalledOnce());
    expect(bridge.present).toHaveBeenCalledWith(
      expect.objectContaining({
        tabId: "stable-tab",
        animate: true,
        animationStartedAtEpochMs: 1234,
      }),
    );
    expect(screen.container.querySelector("iframe, webview")).toBeNull();
  });

  it("hides the main-owned view for an inactive tab", async () => {
    const bridge = installBridge();
    await render(
      <AppDockPane
        deckId="deck-1"
        threadId="thread-1"
        appName="Canvas"
        rendererId={101}
        status="ready"
        tabId="stable-tab"
        visible={false}
        animateEntrance={false}
        animationStartedAtEpochMs={null}
      />,
    );
    await vi.waitFor(() =>
      expect(bridge.hide).toHaveBeenCalledWith({
        tabId: "stable-tab",
        animate: false,
      }),
    );
  });

  it("hides the main-owned view when the App renderer crashes", async () => {
    const bridge = installBridge();
    await render(
      <AppDockPane
        deckId="deck-1"
        threadId="thread-1"
        appName="Canvas"
        rendererId={101}
        status="crashed"
        tabId="crashed-tab"
        visible
        animateEntrance={false}
        animationStartedAtEpochMs={null}
      />,
    );
    await vi.waitFor(() =>
      expect(bridge.hide).toHaveBeenCalledWith({
        tabId: "crashed-tab",
        animate: false,
      }),
    );
    expect(bridge.present).not.toHaveBeenCalled();
  });

  it("starts presenting while the App document is still loading", async () => {
    const bridge = installBridge();
    await render(
      <div
        data-slot="sidebar-wrapper"
        style={{ "--sidebar-width": "500px", height: 600 } as CSSProperties}
      >
        <AppDockPane
          deckId="deck-1"
          threadId="thread-1"
          appName="Apps"
          rendererId={101}
          status="loading"
          tabId="loading-tab"
          visible
          animateEntrance
          animationStartedAtEpochMs={1234}
        />
      </div>,
    );
    await vi.waitFor(() =>
      expect(bridge.present).toHaveBeenCalledWith(
        expect.objectContaining({
          tabId: "loading-tab",
          animate: true,
          animationStartedAtEpochMs: 1234,
        }),
      ),
    );
  });

  it("preserves presentation intent when the shell document is hidden", async () => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    const bridge = installBridge();
    await render(
      <div
        data-slot="sidebar-wrapper"
        style={{ "--sidebar-width": "500px", height: 600 } as CSSProperties}
      >
        <AppDockPane
          deckId="deck-1"
          threadId="thread-1"
          appName="Browser"
          rendererId={101}
          status="ready"
          tabId="hidden-window-tab"
          visible
          animateEntrance={false}
          animationStartedAtEpochMs={null}
        />
      </div>,
    );

    await vi.waitFor(() => expect(bridge.present).toHaveBeenCalledOnce());
    expect(bridge.hide).not.toHaveBeenCalled();
  });

  it("shows a dimmed last-frame replica and transfers ownership when clicked", async () => {
    const bridge = installBridge();
    const screen = await render(
      <div
        data-slot="sidebar-wrapper"
        style={{ "--sidebar-width": "500px", height: 600 } as CSSProperties}
      >
        <AppDockPane
          deckId="deck-1"
          threadId="thread-1"
          appName="Browser"
          rendererId={101}
          status="ready"
          tabId="shared-tab"
          visible
          animateEntrance={false}
          animationStartedAtEpochMs={null}
        />
      </div>,
    );
    await vi.waitFor(() => expect(bridge.present).toHaveBeenCalledOnce());
    bridge.publishPresentation({
      tabId: "shared-tab",
      mode: "replica",
      ownerWindowId: 22,
      appFrameDataUrl: "data:image/png;base64,YXBw",
      pageFrameDataUrl: "data:image/png;base64,cGFnZQ==",
      pageTop: 46,
    });
    await vi.waitFor(() =>
      expect(screen.container.querySelector("[data-app-tab-replica='shared-tab']")).not.toBeNull(),
    );
    screen.container
      .querySelector<HTMLButtonElement>("[data-app-tab-replica='shared-tab']")!
      .click();
    await vi.waitFor(() => expect(bridge.present).toHaveBeenCalledTimes(2));
  });
});
