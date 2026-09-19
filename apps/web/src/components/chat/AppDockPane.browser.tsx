import "../../index.css";

import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import type { CSSProperties } from "react";
import type { DesktopAppTabPresentation } from "@penkra/contracts";

import { AppDockPane } from "./AppDockPane";

const originalBridge = Object.getOwnPropertyDescriptor(window, "desktopBridge");

afterEach(() => {
  document.body.innerHTML = "";
  if (originalBridge) Object.defineProperty(window, "desktopBridge", originalBridge);
  else Reflect.deleteProperty(window, "desktopBridge");
});

function installBridge() {
  const present = vi.fn(async () => undefined);
  const hide = vi.fn(async () => undefined);
  let presentationListener: ((value: DesktopAppTabPresentation) => void) | null = null;
  Object.defineProperty(window, "desktopBridge", {
    configurable: true,
    value: {
      appTabs: {
        present,
        hide,
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
  it("presents from rendered geometry when deck re-entry precedes pixel width publication", async () => {
    const bridge = installBridge();
    const screen = await render(
      <div
        data-slot="sidebar-wrapper"
        style={
          {
            "--sidebar-width": "max(28rem, calc(50vw - 8rem))",
            width: 500,
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
      <div data-slot="sidebar-wrapper" style={{ "--sidebar-width": "500px" } as CSSProperties}>
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

  it("starts presenting while the App document is still loading", async () => {
    const bridge = installBridge();
    await render(
      <div data-slot="sidebar-wrapper" style={{ "--sidebar-width": "500px" } as CSSProperties}>
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

  it("shows a dimmed last-frame replica and transfers ownership when clicked", async () => {
    const bridge = installBridge();
    const screen = await render(
      <div data-slot="sidebar-wrapper" style={{ "--sidebar-width": "500px" } as CSSProperties}>
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
