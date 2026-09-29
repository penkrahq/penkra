// FILE: AppDockPane.tsx
// Purpose: Presents one main-owned App view in the right dock.
// Layer: Chat right-dock App surface

import { IconPackage } from "@tabler/icons-react";
import type { DesktopAppTabPresentation } from "@penkra/contracts";
import { useCallback, useLayoutEffect, useRef, useState } from "react";

import { appDockBoundsForWidth } from "../ui/sidebar";
import { PanelStateMessage } from "./PanelStateMessage";

export function AppDockPane(props: {
  tabId: string;
  rendererId: number;
  deckId: string;
  threadId: string;
  status: "unloaded" | "loading" | "ready" | "crashed" | null;
  visible: boolean;
  animateEntrance: boolean;
  animationStartedAtEpochMs: number | null;
  appName: string | null;
  iconDataUrl?: string | null;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const wasVisibleRef = useRef(false);
  const [presentation, setPresentation] = useState<DesktopAppTabPresentation | null>(null);
  const trace = useCallback(
    (event: string, details: Record<string, unknown> = {}) => {
      window.desktopBridge?.appTabs?.trace({
        event,
        tabId: props.tabId,
        details: {
          rendererMonotonicMs: Math.round(performance.now()),
          documentVisibility: document.visibilityState,
          documentHasFocus: document.hasFocus(),
          deckId: props.deckId,
          threadId: props.threadId,
          ...details,
        },
      });
    },
    [props.deckId, props.tabId, props.threadId],
  );
  const present = useCallback(() => {
    const bridge = window.desktopBridge?.appTabs;
    const wrapper = rootRef.current?.closest<HTMLElement>("[data-slot='sidebar-wrapper']");
    if (!bridge || !wrapper) {
      trace("renderer-present-skipped", {
        reason: bridge ? "missing-sidebar-wrapper" : "missing-desktop-bridge",
      });
      return;
    }
    const width = wrapper.getBoundingClientRect().width;
    if (!Number.isFinite(width) || width <= 0) {
      trace("renderer-present-skipped", { reason: "invalid-rendered-width", width });
      return;
    }
    trace("renderer-present-requested", {
      width,
      animate: props.animateEntrance,
      status: props.status,
      paneVisible: props.visible,
    });
    void bridge.present({
      tabId: props.tabId,
      deckId: props.deckId,
      threadId: props.threadId,
      animate: props.animateEntrance,
      ...(props.animationStartedAtEpochMs === null
        ? {}
        : { animationStartedAtEpochMs: props.animationStartedAtEpochMs }),
      bounds: appDockBoundsForWidth(width),
    });
  }, [
    props.animateEntrance,
    props.animationStartedAtEpochMs,
    props.deckId,
    props.tabId,
    props.threadId,
    props.status,
    props.visible,
    trace,
  ]);

  useLayoutEffect(() => {
    trace("renderer-pane-mounted", { status: props.status, paneVisible: props.visible });
    const onVisibilityChange = () => trace("renderer-document-visibility-changed");
    const onFocus = () => trace("renderer-window-focused");
    const onBlur = () => trace("renderer-window-blurred");
    const onPageShow = (event: PageTransitionEvent) =>
      trace("renderer-page-shown", { persisted: event.persisted });
    const onPageHide = (event: PageTransitionEvent) =>
      trace("renderer-page-hidden", { persisted: event.persisted });
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    window.addEventListener("pageshow", onPageShow);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      trace("renderer-pane-unmounted", { status: props.status, paneVisible: props.visible });
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("pageshow", onPageShow);
      window.removeEventListener("pagehide", onPageHide);
    };
  }, [props.status, props.visible, trace]);

  useLayoutEffect(() => {
    const bridge = window.desktopBridge?.appTabs;
    if (!bridge) return;
    return bridge.onPresentation((next) => {
      if (next.tabId === props.tabId) {
        trace("renderer-presentation-received", {
          mode: next.mode,
          ownerWindowId: next.ownerWindowId,
        });
        setPresentation(next);
      }
    });
  }, [props.tabId, trace]);

  useLayoutEffect(() => {
    const bridge = window.desktopBridge?.appTabs;
    if (!bridge) return;
    if (!props.visible || props.status === "crashed") {
      trace("renderer-hide-requested", {
        reason: !props.visible ? "pane-not-visible" : "app-crashed",
        status: props.status,
        paneVisible: props.visible,
        animate: wasVisibleRef.current && !props.visible,
      });
      void bridge.hide({
        tabId: props.tabId,
        animate: wasVisibleRef.current && !props.visible,
      });
      wasVisibleRef.current = false;
      return;
    }
    wasVisibleRef.current = true;
    present();
  }, [
    props.animateEntrance,
    props.animationStartedAtEpochMs,
    props.deckId,
    props.status,
    props.tabId,
    props.threadId,
    props.visible,
    present,
    trace,
  ]);

  useLayoutEffect(
    () => () => {
      trace("renderer-cleanup-hide-requested");
      void window.desktopBridge?.appTabs?.hide({ tabId: props.tabId }).catch(() => undefined);
    },
    [props.tabId, trace],
  );

  return (
    <div
      ref={rootRef}
      className="relative h-full min-h-0 w-full overflow-hidden"
      data-app-tab-id={props.visible ? props.tabId : undefined}
      data-app-deck-id={props.visible ? props.deckId : undefined}
      data-app-thread-id={props.visible ? props.threadId : undefined}
    >
      {props.visible && presentation?.mode === "replica" ? (
        <button
          aria-label={`Activate ${props.appName ?? "App"} in this window`}
          className="absolute inset-0 z-10 block h-full w-full cursor-pointer overflow-hidden border-0 bg-background p-0 text-left"
          data-app-tab-replica={props.tabId}
          onClick={present}
          type="button"
        >
          {presentation.appFrameDataUrl ? (
            <img
              alt=""
              className="absolute inset-x-0 top-0 w-full object-fill"
              draggable={false}
              src={presentation.appFrameDataUrl}
              style={{
                height: presentation.pageFrameDataUrl ? (presentation.pageTop ?? 0) : "100%",
              }}
            />
          ) : null}
          {presentation.pageFrameDataUrl ? (
            <img
              alt=""
              className="absolute inset-x-0 w-full object-fill"
              draggable={false}
              src={presentation.pageFrameDataUrl}
              style={{
                top: presentation.pageTop ?? 0,
                height: `calc(100% - ${presentation.pageTop ?? 0}px)`,
              }}
            />
          ) : null}
          <span className="absolute inset-0 bg-background/45" />
          <span className="absolute inset-0 flex items-center justify-center text-sm font-medium text-foreground/80">
            Click to use {props.appName ?? "this App"} in this window
          </span>
        </button>
      ) : null}
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
