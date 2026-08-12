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

export function nativeAppViewBoundsSignature(bounds: {
  x: number;
  y: number;
  width: number;
  height: number;
}): string {
  return `${bounds.x}:${bounds.y}:${bounds.width}:${bounds.height}`;
}

export function AppDockPane(props: {
  tabId: string;
  rendererId: number;
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
  const lastBoundsSignatureRef = useRef<string | null>(null);

  useLayoutEffect(() => {
    const bridge = window.desktopBridge?.appTabs;
    const viewport = viewportRef.current;
    if (!bridge || !viewport) return;
    let stopped = false;
    let frame = 0;
    let settledFrame = 0;
    const dockShell = viewport.closest<HTMLElement>("[data-slot='sidebar-container']");

    const sync = () => {
      frame = 0;
      if (stopped || !nativeViewVisibleRef.current) return;
      const bounds = viewport.getBoundingClientRect();
      if (bounds.width <= 0 || bounds.height <= 0) return;
      const nextBounds = {
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
      };
      const signature = nativeAppViewBoundsSignature(nextBounds);
      if (signature === lastBoundsSignatureRef.current) return;
      lastBoundsSignatureRef.current = signature;
      void bridge.setBounds({
        tabId: props.tabId,
        rendererId: props.rendererId,
        bounds: nextBounds,
      });
    };
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(sync);
    };
    // Opening the dock intentionally suppresses its first transition frame. The native View can
    // therefore receive the pre-open, off-canvas rectangle without a ResizeObserver or
    // transition event to correct it. Re-sample once after that layout frame has settled.
    const scheduleSettled = () => {
      schedule();
      if (settledFrame) window.cancelAnimationFrame(settledFrame);
      settledFrame = window.requestAnimationFrame(() => {
        settledFrame = 0;
        schedule();
      });
    };
    const followDockMotion = () => {
      frame = 0;
      if (stopped || !nativeViewVisibleRef.current) return;
      sync();
      const moving = dockShell
        ?.getAnimations({ subtree: true })
        .some((animation) => animation.playState === "running");
      if (moving) frame = window.requestAnimationFrame(followDockMotion);
    };
    const followStartedDockMotion = () => {
      if (frame) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(followDockMotion);
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(viewport);
    if (dockShell) observer.observe(dockShell);
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    window.visualViewport?.addEventListener("resize", schedule);
    window.visualViewport?.addEventListener("scroll", schedule);
    dockShell?.addEventListener("transitionrun", followStartedDockMotion);
    dockShell?.addEventListener("transitionend", schedule);
    dockShell?.addEventListener("transitioncancel", schedule);
    dockShell?.addEventListener("animationstart", schedule);
    dockShell?.addEventListener("animationend", schedule);
    dockShell?.addEventListener("animationcancel", schedule);
    const unsubscribeZoomFactor = window.desktopBridge?.onZoomFactorChange?.(() => {
      lastBoundsSignatureRef.current = null;
      schedule();
    });
    scheduleBoundsRef.current = scheduleSettled;
    void bridge.attach({ tabId: props.tabId, rendererId: props.rendererId }).then(() => {
      if (!stopped) {
        void bridge.setVisible({
          tabId: props.tabId,
          rendererId: props.rendererId,
          visible: nativeViewVisibleRef.current,
        });
        if (nativeViewVisibleRef.current) scheduleSettled();
      }
    });
    return () => {
      stopped = true;
      scheduleBoundsRef.current = null;
      observer.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
      window.visualViewport?.removeEventListener("resize", schedule);
      window.visualViewport?.removeEventListener("scroll", schedule);
      dockShell?.removeEventListener("transitionrun", followStartedDockMotion);
      dockShell?.removeEventListener("transitionend", schedule);
      dockShell?.removeEventListener("transitioncancel", schedule);
      dockShell?.removeEventListener("animationstart", schedule);
      dockShell?.removeEventListener("animationend", schedule);
      dockShell?.removeEventListener("animationcancel", schedule);
      unsubscribeZoomFactor?.();
      if (frame) window.cancelAnimationFrame(frame);
      if (settledFrame) window.cancelAnimationFrame(settledFrame);
      void bridge
        .setVisible({ tabId: props.tabId, rendererId: props.rendererId, visible: false })
        .catch(() => undefined);
    };
  }, [props.rendererId, props.tabId]);

  useLayoutEffect(() => {
    const bridge = window.desktopBridge?.appTabs;
    const viewport = viewportRef.current;
    if (!bridge || !viewport) return;

    visibilityRequestRef.current = showNativeView;
    const generation = ++visibilityGenerationRef.current;

    const setNativeViewVisible = (visible: boolean) => {
      if (generation !== visibilityGenerationRef.current) return;
      nativeViewVisibleRef.current = visible;
      if (visible) lastBoundsSignatureRef.current = null;
      void bridge
        .setVisible({ tabId: props.tabId, rendererId: props.rendererId, visible })
        .catch(() => undefined);
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
  }, [props.rendererId, props.tabId, props.visible, showNativeView]);

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
