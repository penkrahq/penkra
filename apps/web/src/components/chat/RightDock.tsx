// FILE: RightDock.tsx
// Purpose: Tabbed App panel beside a Thread.
// Layer: Chat right-dock UI
// Depends on: ui/sidebar primitive, right-dock pane metadata, and a caller-provided pane renderer.

import {
  type CSSProperties,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { cn } from "~/lib/utils";
import type { RightDockPane, RightDockDeckState } from "~/rightDockStore.logic";
import { resolveActivePane } from "~/rightDockStore.logic";
import { PanelTabShared } from "../right-panel/panel-tab-shared/PanelTabShared";
import {
  Sidebar,
  SIDEBAR_OFFCANVAS_MOTION_CLASS,
  SIDEBAR_OFFCANVAS_MOTION_SUPPRESSED_CLASS,
  SidebarProvider,
  SidebarRail,
  publishNativeAppBoundsForWidth,
} from "../ui/sidebar";
import { CHAT_BACKGROUND_CLASS_NAME } from "./composerPickerStyles";
import {
  CHAT_SURFACE_HEADER_ROW_CLASS_NAME,
  SURFACE_TAB_DIVIDER_CLASS_NAME,
} from "./chatHeaderControls";
import { resolveRightDockPaneIcon, resolveRightDockPaneLabel } from "./rightDockPaneMeta";
import { useDesktopTopBarWindowControlsGutterClassName } from "~/hooks/useDesktopTopBarGutter";
import { useOptionalFind } from "../find/FindProvider";
import { createDomFindSurface } from "~/lib/find/domFindSurface";
import { isFindSurfaceVisible } from "~/lib/find/findVisibility";

// Shared sizing defaults for dock hosts: the resize floor for a single readable pane and the
// "half the shell, but never cramped" opening width. The thread route tunes its own values
// around the composer; simpler hosts (e.g. the /pull-requests route) use these as-is.
export const RIGHT_DOCK_MIN_WIDTH = 26 * 16;
export const RIGHT_DOCK_DEFAULT_WIDTH = "max(28rem, calc(50vw - 8rem))";

interface RightDockProps {
  state: RightDockDeckState;
  minWidth: number;
  contentMinWidth?: number;
  defaultWidth: string;
  shouldAcceptWidth: (context: { nextWidth: number; wrapper: HTMLElement }) => boolean | number;
  onSelectPane: (paneId: string) => void;
  onClosePane: (paneId: string) => void;
  onOpenChange: (open: boolean) => void;
  onResize?: (width: number) => void;
  motionKey?: string;
  renderPane: (
    pane: RightDockPane,
    context: {
      isVisible: boolean;
      animateEntrance: boolean;
      animationStartedAtEpochMs: number | null;
    },
  ) => ReactNode;
}

function RightDockTab(props: {
  pane: RightDockPane;
  label: string;
  icon?: ReactNode;
  active: boolean;
  onSelect: () => void;
  onClose: () => void;
}) {
  return (
    <PanelTabShared
      active={props.active}
      title={props.label}
      icon={props.icon ?? resolveRightDockPaneIcon(props.pane)}
      className={props.pane.appStatus === "unloaded" ? "opacity-50" : undefined}
      onClick={props.onSelect}
      onClose={props.onClose}
    >
      {props.label}
    </PanelTabShared>
  );
}

export function RightDock(props: RightDockProps) {
  const registerFindSurface = useOptionalFind()?.register;
  const activePane = resolveActivePane(props.state);
  // The dock is the right-most surface when open, so its header sits under the
  // fixed Windows caption cluster — reserve the same gutter the chat header uses.
  const desktopTopBarWindowControlsGutterClassName =
    useDesktopTopBarWindowControlsGutterClassName();

  // A Thread without a saved width opens as an exact 50/50 split of the chat
  // shell. The CSS default can only approximate half (it cannot observe the
  // resizable left sidebar), so measure the shell row hosting chat + dock. A
  // saved width takes precedence and is reapplied when navigating between
  // Threads that share this mounted shell.
  const contentRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const root = contentRef.current;
    if (!root || !registerFindSurface) return;
    return registerFindSurface(
      createDomFindSurface({
        id: "right-dock-rendered",
        order: 19,
        root,
        isVisible: () => props.state.open && isFindSurfaceVisible(root),
      }),
    );
  }, [props.state.open, registerFindSurface]);
  const minWidth = props.minWidth;
  const previousOpenRef = useRef(props.state.open);
  const openingThisRender = props.state.open && !previousOpenRef.current;
  const openingStartedAtRef = useRef<number | null>(null);
  if (openingThisRender) openingStartedAtRef.current = Date.now();
  const [openingMotion, setOpeningMotion] = useState(false);
  useEffect(() => {
    const wasOpen = previousOpenRef.current;
    previousOpenRef.current = props.state.open;
    if (!props.state.open) {
      setOpeningMotion(false);
      openingStartedAtRef.current = null;
      return;
    }
    if (wasOpen) return;
    setOpeningMotion(true);
    const timer = window.setTimeout(() => {
      setOpeningMotion(false);
      openingStartedAtRef.current = null;
    }, 300);
    return () => window.clearTimeout(timer);
  }, [props.state.open]);
  useLayoutEffect(() => {
    if (!props.state.open) {
      return;
    }
    const wrapper = contentRef.current?.closest<HTMLElement>("[data-slot='sidebar-wrapper']");
    const shell = wrapper?.parentElement;
    if (!wrapper || !shell) {
      return;
    }
    let resizeFrameId: number | null = null;
    const applyAvailableWidth = () => {
      const shellWidth = wrapper.parentElement?.clientWidth ?? window.innerWidth;
      const preferredWidth = props.state.width ?? Math.round(shellWidth / 2);
      const maximumWidth = Math.max(minWidth, shellWidth - (props.contentMinWidth ?? 0));
      const nextWidth = Math.max(minWidth, Math.min(preferredWidth, maximumWidth));
      if (nextWidth > 0) {
        publishNativeAppBoundsForWidth(wrapper, nextWidth);
        wrapper.style.setProperty("--sidebar-width", `${nextWidth}px`);
      }
    };
    const scheduleAvailableWidth = () => {
      if (resizeFrameId !== null) return;
      resizeFrameId = window.requestAnimationFrame(() => {
        resizeFrameId = null;
        applyAvailableWidth();
      });
    };

    applyAvailableWidth();
    // The dock's available width can change without a BrowserWindow resize:
    // switching shell layouts, changing the left rail, and leaving fullscreen
    // all resize this parent. Observe that element so the CSS dock and the
    // native App bounds are reconciled in the same frame.
    const resizeObserver = new ResizeObserver(scheduleAvailableWidth);
    resizeObserver.observe(shell);
    window.addEventListener("resize", scheduleAvailableWidth);
    const removeWindowStateListener = window.desktopBridge?.windowControls?.onState(() =>
      scheduleAvailableWidth(),
    );
    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", scheduleAvailableWidth);
      removeWindowStateListener?.();
      if (resizeFrameId !== null) {
        window.cancelAnimationFrame(resizeFrameId);
      }
    };
  }, [props.contentMinWidth, props.motionKey, props.state.open, props.state.width, minWidth]);
  // Motion allowance keyed to the current motionKey: a key change (reposition/
  // remount) derives straight back to "suppressed" in that same render, and the
  // rAF below re-enables motion once the suppressed frame has painted. Mounting
  // with the dock open starts suppressed for the same reason.
  const [motionState, setMotionState] = useState<{
    key: RightDockProps["motionKey"];
    allow: boolean;
  }>(() => ({ key: props.motionKey, allow: !props.state.open }));
  const shouldSuppressChromeMotion = !(motionState.key === props.motionKey && motionState.allow);

  useEffect(() => {
    if (!shouldSuppressChromeMotion) {
      return;
    }
    const frameId = window.requestAnimationFrame(() => {
      setMotionState({ key: props.motionKey, allow: true });
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [props.motionKey, shouldSuppressChromeMotion]);

  // Smooth drawer-style easing for the open/close slide. `ease-linear` (the
  // sidebar default) reads as stepped/janky on the wide dock; this curve front-
  // loads motion and settles softly. Applied to both the width gap and the
  // sliding container so they stay in lockstep.
  const chromeMotionClass = shouldSuppressChromeMotion
    ? SIDEBAR_OFFCANVAS_MOTION_SUPPRESSED_CLASS
    : SIDEBAR_OFFCANVAS_MOTION_CLASS;

  return (
    <SidebarProvider
      defaultOpen={false}
      open={props.state.open}
      onOpenChange={props.onOpenChange}
      className="w-auto min-h-0 flex-none bg-transparent"
      style={{ "--sidebar-width": props.defaultWidth } as CSSProperties}
    >
      <Sidebar
        data-pencil-component="ayA7J"
        side="right"
        positioning="inline"
        collapsible="offcanvas"
        className={cn(
          "border-l border-[var(--app-surface-divider)] text-foreground",
          chromeMotionClass,
          !props.state.open && "pointer-events-none invisible",
        )}
        innerClassName={CHAT_BACKGROUND_CLASS_NAME}
        gapClassName={chromeMotionClass}
        transparentSurface
        resizable={{
          minWidth: props.minWidth,
          ...(props.onResize ? { onResize: props.onResize } : {}),
          shouldAcceptWidth: props.shouldAcceptWidth,
        }}
      >
        <div
          ref={contentRef}
          data-right-dock-content
          data-find-model-owned
          className="flex h-full min-h-0 w-full flex-col"
        >
          <div
            className={cn(
              CHAT_SURFACE_HEADER_ROW_CLASS_NAME,
              // The Apps launcher is a fixed host-level overlay, not dock content. Reserve its
              // footprint so tabs slide beneath the launcher without occupying its space.
              "gap-1 pl-1.5 pr-11",
              desktopTopBarWindowControlsGutterClassName,
            )}
          >
            <div
              className="flex min-w-0 flex-1 items-center overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
              data-pencil-component="x1igca"
              role="tablist"
            >
              {props.state.panes.map((pane, index) => {
                const active = pane.id === props.state.activePaneId;
                const previousActive =
                  props.state.panes[index - 1]?.id === props.state.activePaneId;
                return (
                  <div key={pane.id} className="flex shrink-0 items-center">
                    {index > 0 ? (
                      <span
                        aria-hidden="true"
                        className={cn(
                          SURFACE_TAB_DIVIDER_CLASS_NAME,
                          (active || previousActive) && "invisible",
                        )}
                        data-slot="right-dock-tab-divider"
                      />
                    ) : null}
                    <RightDockTab
                      pane={pane}
                      label={resolveRightDockPaneLabel(pane)}
                      active={active}
                      onSelect={() => props.onSelectPane(pane.id)}
                      onClose={() => props.onClosePane(pane.id)}
                    />
                  </div>
                );
              })}
            </div>
          </div>
          <div className="relative min-h-0 flex-1">
            {activePane ? (
              <div className="absolute inset-0 flex min-h-0 w-full">
                {props.renderPane(activePane, {
                  isVisible: props.state.open,
                  animateEntrance: openingThisRender || openingMotion,
                  animationStartedAtEpochMs: openingStartedAtRef.current,
                })}
              </div>
            ) : null}
          </div>
        </div>
        <SidebarRail />
      </Sidebar>
    </SidebarProvider>
  );
}

export default RightDock;
