// FILE: AppDockPane.tsx
// Purpose: Mirrors one host-owned isolated App renderer into its right-dock tab viewport.
// Layer: Chat right-dock App surface

import { IconPackage } from "@tabler/icons-react";
import { useLayoutEffect, useRef } from "react";

import { PanelStateMessage } from "./PanelStateMessage";

export function shouldShowNativeAppView(
  visible: boolean,
  status: "loading" | "ready" | "crashed" | null,
): boolean {
  return visible && status === "ready";
}

export function hasRunningNativeViewExitTransition(
  animations: ReadonlyArray<Pick<Animation, "playState">>,
): boolean {
  return animations.some((animation) => animation.playState === "running");
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
  const nativeViewVisibleRef = useRef(false);
  const visibilityRequestRef = useRef(showNativeView);
  const visibilityGenerationRef = useRef(0);
  const scheduleBoundsRef = useRef<(() => void) | null>(null);

  useLayoutEffect(() => {
    const bridge = window.desktopBridge?.appTabs;
    const viewport = viewportRef.current;
    if (!bridge || !viewport) return;
    let stopped = false;
    let frame = 0;
    const dockShell = viewport.closest<HTMLElement>("[data-slot='sidebar-wrapper']")?.parentElement;

    const sync = () => {
      frame = 0;
      if (stopped || !nativeViewVisibleRef.current) return;
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
    scheduleBoundsRef.current = schedule;
    void bridge.attach({ tabId: props.tabId }).then(() => {
      if (!stopped) {
        void bridge.setVisible({
          tabId: props.tabId,
          visible: nativeViewVisibleRef.current,
        });
        if (nativeViewVisibleRef.current) schedule();
      }
    });
    return () => {
      stopped = true;
      scheduleBoundsRef.current = null;
      observer.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
      dockShell?.removeEventListener("transitionrun", handleTransitionRun);
      if (frame) window.cancelAnimationFrame(frame);
      void bridge.setVisible({ tabId: props.tabId, visible: false }).catch(() => undefined);
    };
  }, [props.tabId]);

  useLayoutEffect(() => {
    const bridge = window.desktopBridge?.appTabs;
    const viewport = viewportRef.current;
    if (!bridge || !viewport) return;

    visibilityRequestRef.current = showNativeView;
    const generation = ++visibilityGenerationRef.current;

    const setNativeViewVisible = (visible: boolean) => {
      if (generation !== visibilityGenerationRef.current) return;
      nativeViewVisibleRef.current = visible;
      void bridge.setVisible({ tabId: props.tabId, visible }).catch(() => undefined);
      if (visible) scheduleBoundsRef.current?.();
    };

    if (showNativeView) {
      setNativeViewVisible(true);
      return;
    }

    // Loading/crashed renderers hide immediately. Exit retention applies only
    // when the host has actually closed or switched away from a ready App pane.
    if (props.visible) {
      setNativeViewVisible(false);
      return;
    }

    if (!nativeViewVisibleRef.current) {
      setNativeViewVisible(false);
      return;
    }

    // App content lives in a native Electron WebContentsView, outside the DOM.
    // Keep it visible while its dock ancestor is animating out, update its bounds
    // through the existing transition follower above, and hide it only when the
    // browser reports that transition as finished. A tab switch has no running
    // dock transition, so its previous native view still hides on the next frame.
    let frame = window.requestAnimationFrame(() => {
      frame = 0;
      const transitionRoot = viewport.closest<HTMLElement>("[data-slot='sidebar-container']");
      const animations = transitionRoot?.getAnimations() ?? [];
      if (!hasRunningNativeViewExitTransition(animations)) {
        setNativeViewVisible(false);
        return;
      }

      void Promise.allSettled(animations.map((animation) => animation.finished)).then(() => {
        if (generation === visibilityGenerationRef.current && !visibilityRequestRef.current) {
          setNativeViewVisible(false);
        }
      });
    });

    return () => {
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [props.tabId, props.visible, showNativeView]);

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
