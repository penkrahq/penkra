// FILE: AppDockPane.tsx
// Purpose: Mirrors one host-owned isolated App renderer into its right-dock tab viewport.
// Layer: Chat right-dock App surface

import { IconPackage } from "@tabler/icons-react";
import { useEffect, useLayoutEffect, useRef } from "react";

import { PanelStateMessage } from "./PanelStateMessage";

export function shouldShowNativeAppView(
  visible: boolean,
  status: "loading" | "ready" | "crashed" | null,
): boolean {
  return visible && status === "ready";
}

export function AppDockPane(props: {
  tabId: string;
  status: "loading" | "ready" | "crashed" | null;
  visible: boolean;
  appName: string | null;
  iconDataUrl?: string | null;
}) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const showNativeView = shouldShowNativeAppView(props.visible, props.status);

  useLayoutEffect(() => {
    const bridge = window.desktopBridge?.appTabs;
    const viewport = viewportRef.current;
    if (!bridge || !viewport) return;
    let stopped = false;
    let frame = 0;
    const dockShell = viewport.closest<HTMLElement>("[data-slot='sidebar-wrapper']")?.parentElement;

    const sync = () => {
      frame = 0;
      if (stopped || !showNativeView) return;
      const bounds = viewport.getBoundingClientRect();
      if (bounds.width <= 0 || bounds.height <= 0) return;
      void bridge.setBounds({
        tabId: props.tabId,
        bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
      });
    };
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(sync);
    };
    const followRunningTransitions = () => {
      if (stopped) return;
      sync();
      const hasRunningTransition = dockShell
        ?.getAnimations({ subtree: true })
        .some((animation) => animation.playState === "running");
      if (hasRunningTransition) frame = window.requestAnimationFrame(followRunningTransitions);
    };
    const handleTransitionRun = () => {
      if (frame) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(followRunningTransitions);
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(viewport);
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    dockShell?.addEventListener("transitionrun", handleTransitionRun);
    void bridge.attach({ tabId: props.tabId }).then(() => {
      if (!stopped) {
        void bridge.setVisible({ tabId: props.tabId, visible: showNativeView });
        schedule();
      }
    });
    return () => {
      stopped = true;
      observer.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
      dockShell?.removeEventListener("transitionrun", handleTransitionRun);
      if (frame) window.cancelAnimationFrame(frame);
      void bridge.setVisible({ tabId: props.tabId, visible: false }).catch(() => undefined);
    };
  }, [props.tabId, showNativeView]);

  useEffect(() => {
    void window.desktopBridge?.appTabs
      ?.setVisible({ tabId: props.tabId, visible: showNativeView })
      .catch(() => undefined);
  }, [props.tabId, showNativeView]);

  return (
    <div ref={viewportRef} className="relative h-full min-h-0 w-full overflow-hidden">
      {props.status === "crashed" ? (
        <PanelStateMessage>
          The App stopped responding. Close this tab and open it again.
        </PanelStateMessage>
      ) : props.status !== "ready" ? (
        <div
          aria-label={`Loading ${props.appName ?? "App"}`}
          className="flex h-full min-h-0 w-full items-center justify-center"
          role="status"
        >
          {props.iconDataUrl ? (
            <img
              alt=""
              className="size-12 rounded-xl object-contain"
              draggable={false}
              src={props.iconDataUrl}
            />
          ) : (
            <span className="flex size-12 items-center justify-center rounded-xl bg-muted text-muted-foreground">
              <IconPackage aria-hidden="true" className="size-5" />
            </span>
          )}
        </div>
      ) : null}
    </div>
  );
}
