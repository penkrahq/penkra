import type { DesktopAppTabDescriptor } from "@penkra/contracts";
import { type FolderId, type ThreadId } from "@penkra/contracts";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";

import { useComposerDraftStore } from "../../composerDraftStore";
import { canComposerHandlePanelWidth } from "../../lib/panelResize";
import {
  ThreadResourceOpenerContext,
  createThreadResourceOpener,
  showThreadResourceContextMenu,
} from "../../lib/threadResourceOpener";
import { selectRightDockState, useRightDockStore } from "../../rightDockStore";
import type { RightDockPane } from "../../rightDockStore.logic";
import { useStore } from "../../store";
import { createProjectSelector, createSidebarThreadSummariesSelector } from "../../storeSelectors";
import ChatView from "../ChatView";
import { RouteInsetSurface } from "../RouteInsetSurface";
import { IconButton } from "../ui/icon-button";
import { toastManager, useThreadToastViewportHostRef } from "../ui/toast";
import { AppsIcon } from "~/lib/icons";
import { isElectron } from "~/env";
import { cn, isWindowsPlatform } from "~/lib/utils";
import { useAppInstallationSnapshot } from "~/appInstallationStore";
import { AppDockPane } from "./AppDockPane";
import {
  restoreAppTab,
  isAppPaneInSpace,
  isAppTabOutsideFolderSpace,
  shouldMountAppDockPane,
  shouldRetryAppTabHostReady,
} from "./appTabRestore.logic";
import {
  resolveAppsLauncherAction,
  resolveAppsLauncherFolderBarReservationPx,
  resolveAppsLauncherRightInsetPx,
  resolveAppsLauncherSpaceId,
} from "./appsLauncher.logic";
import {
  CHAT_BACKGROUND_CLASS_NAME,
  CHAT_MAIN_CONTENT_SURFACE_CLASS_NAME,
  CHAT_MAIN_VIEWPORT_SHELL_CLASS_NAME,
} from "./composerPickerStyles";
import { SINGLE_CHAT_PANE_SCOPE_ID } from "../../lib/chatPaneScope";
import { RightDock } from "./RightDock";

const APP_PANEL_DEFAULT_WIDTH = "max(28rem, calc(50vw - 8rem))";
const APP_PANEL_MIN_WIDTH = 26 * 16;
const THREAD_PANEL_MIN_WIDTH = 400;

function shouldAcceptAppPanelWidth(input: { nextWidth: number; wrapper: HTMLElement }) {
  const shellWidth = input.wrapper.parentElement?.getBoundingClientRect().width;
  const nextWidth =
    shellWidth === undefined
      ? input.nextWidth
      : Math.max(
          APP_PANEL_MIN_WIDTH,
          Math.min(input.nextWidth, shellWidth - THREAD_PANEL_MIN_WIDTH),
        );

  const previousSidebarWidth = input.wrapper.style.getPropertyValue("--sidebar-width");
  const accepted = canComposerHandlePanelWidth({
    nextWidth,
    paneScopeId: SINGLE_CHAT_PANE_SCOPE_ID,
    applyWidth: (width) => input.wrapper.style.setProperty("--sidebar-width", `${width}px`),
    resetWidth: () => {
      if (previousSidebarWidth) {
        input.wrapper.style.setProperty("--sidebar-width", previousSidebarWidth);
      } else {
        input.wrapper.style.removeProperty("--sidebar-width");
      }
    },
  });
  return accepted ? nextWidth : false;
}

function appPaneFromTab(tab: DesktopAppTabDescriptor) {
  return {
    paneId: tab.id,
    kind: "app" as const,
    appId: tab.appId,
    appSpaceId: tab.spaceId,
    appSlug: tab.slug,
    appName: tab.name,
    appIconDataUrl: tab.iconDataUrl,
    appPresentationTitle: tab.presentationTitle ?? null,
    appPresentationIconUrl: tab.presentationIconUrl ?? null,
    appRendererId: tab.rendererId,
    appRoute: tab.route,
    ...(tab.state === undefined ? {} : { appState: tab.state }),
    appStatus: tab.status,
  };
}

export function SingleChatSurface(props: { threadId: ThreadId; folderId: FolderId }) {
  const threadToastViewportHostRef = useThreadToastViewportHostRef();
  const isWindowsDesktop =
    typeof navigator !== "undefined" && isWindowsPlatform(navigator.platform);
  const appsLauncherRightInsetPx = resolveAppsLauncherRightInsetPx({
    isElectron,
    isWindowsDesktop,
  });
  const draftThread = useComposerDraftStore(
    (store) => store.draftThreadsByThreadId[props.threadId],
  );
  const folderId = props.folderId;
  const dockState = useRightDockStore(useMemo(() => selectRightDockState(folderId), [folderId]));
  const appsLauncherFolderBarReservationPx = resolveAppsLauncherFolderBarReservationPx({
    appsLauncherRightInsetPx,
    dockOpen: dockState.open,
    isElectron,
    isWindowsDesktop,
  });
  const openPane = useRightDockStore((store) => store.openPane);
  const closePane = useRightDockStore((store) => store.closePane);
  const setActivePane = useRightDockStore((store) => store.setActivePane);
  const setDockOpen = useRightDockStore((store) => store.setDockOpen);
  const setDockWidth = useRightDockStore((store) => store.setDockWidth);
  const updatePane = useRightDockStore((store) => store.updatePane);
  const appInstallations = useAppInstallationSnapshot();
  const activeProject = useStore(
    useMemo(() => createProjectSelector(props.folderId), [props.folderId]),
  );
  const threadSummaries = useStore(useMemo(() => createSidebarThreadSummariesSelector(), []));
  const loadingAppPaneIdsRef = useRef(new Set<string>());
  const [confirmedAppPaneIds, setConfirmedAppPaneIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const currentSpaceId = resolveAppsLauncherSpaceId({
    persistedSpaceId:
      threadSummaries.find((thread) => thread.id === props.threadId)?.spaceId ?? null,
    draftSpaceId: draftThread?.spaceId ?? null,
    projectSpaceId: activeProject?.spaceId ?? null,
  });
  const threadDirectory = activeProject?.cwd ?? null;
  const resourceOpener = useMemo(
    () =>
      createThreadResourceOpener({
        directory: threadDirectory,
        spaceId: currentSpaceId,
        folderId,
        threadId: props.threadId,
      }),
    [currentSpaceId, folderId, props.threadId, threadDirectory],
  );

  useEffect(() => {
    if (!appInstallations || !currentSpaceId) return;
    const installedById = new Map(
      appInstallations.installed
        .filter((app) => app.spaceId === currentSpaceId)
        .map((app) => [app.id, app]),
    );
    for (const pane of dockState.panes) {
      const installed = installedById.get(pane.appId);
      if (installed && pane.appIconDataUrl !== installed.iconDataUrl) {
        updatePane(folderId, pane.id, { appIconDataUrl: installed.iconDataUrl });
      }
    }
  }, [appInstallations, currentSpaceId, folderId, dockState.panes, updatePane]);

  const loadAppPane = useCallback(
    (pane: RightDockPane) => {
      const bridge = window.desktopBridge?.appTabs;
      if (pane.appStatus !== "unloaded" || !bridge || loadingAppPaneIdsRef.current.has(pane.id)) {
        return;
      }
      loadingAppPaneIdsRef.current.add(pane.id);
      updatePane(folderId, pane.id, { appStatus: "loading" });
      void restoreAppTab(pane, folderId, props.threadId, bridge)
        .then((tab) => {
          setConfirmedAppPaneIds((current) => new Set(current).add(tab.id));
          openPane(folderId, appPaneFromTab(tab));
        })
        .catch((error: unknown) => {
          updatePane(folderId, pane.id, { appStatus: "unloaded" });
          toastManager.add({
            type: "error",
            title: `Could not open ${pane.appName}`,
            description: error instanceof Error ? error.message : "The App could not be opened.",
          });
        })
        .finally(() => loadingAppPaneIdsRef.current.delete(pane.id));
    },
    [folderId, openPane, props.threadId, updatePane],
  );

  useEffect(() => {
    const bridge = window.desktopBridge?.appTabs;
    if (!bridge) return;
    let disposed = false;
    const removeActivation = bridge.onActivationRequested(({ requestId, tab }) => {
      if (tab.folderId !== folderId || tab.spaceId !== currentSpaceId) return;
      void bridge
        .claimActivation(requestId)
        .then((valid) => {
          if (!valid || disposed) return;
          setConfirmedAppPaneIds((current) => new Set(current).add(tab.id));
          openPane(folderId, { ...appPaneFromTab(tab), preserveSelection: false });
        })
        .catch((error: unknown) => {
          if (disposed) return;
          toastManager.add({
            type: "error",
            title: `Could not activate ${tab.name}`,
            description:
              error instanceof Error ? error.message : "The App tab could not be activated.",
          });
        });
    });
    const removeOpened = bridge.onOpened((tab) => {
      if (tab.folderId !== folderId) return;
      if (currentSpaceId && isAppTabOutsideFolderSpace(tab, folderId, currentSpaceId)) {
        void bridge.close({ tabId: tab.id }).catch(() => undefined);
        closePane(folderId, tab.id);
        return;
      }
      setConfirmedAppPaneIds((current) => new Set(current).add(tab.id));
      openPane(folderId, {
        ...appPaneFromTab(tab),
        preserveSelection: tab.selection === "preserve",
      });
    });
    const removeState = bridge.onState((tab) => {
      if (tab.folderId !== folderId) return;
      updatePane(folderId, tab.id, {
        appIconDataUrl: tab.iconDataUrl,
        appPresentationTitle: tab.presentationTitle ?? null,
        appPresentationIconUrl: tab.presentationIconUrl ?? null,
        appRendererId: tab.rendererId,
        appRoute: tab.route,
        ...(tab.state === undefined ? { appState: undefined } : { appState: tab.state }),
        appStatus: tab.status,
      });
    });
    const removeClosed = bridge.onClosed((tab) => {
      if (tab.folderId !== folderId) return;
      setConfirmedAppPaneIds((current) => {
        if (!current.has(tab.id)) return current;
        const next = new Set(current);
        next.delete(tab.id);
        return next;
      });
      closePane(folderId, tab.id);
    });
    return () => {
      disposed = true;
      removeActivation();
      removeOpened();
      removeState();
      removeClosed();
    };
  }, [closePane, currentSpaceId, folderId, openPane, props.threadId, updatePane]);

  useEffect(() => {
    const bridge = window.desktopBridge?.appTabs;
    if (!bridge || !currentSpaceId) return;
    let cancelled = false;
    let retryTimer: number | null = null;
    let readinessAttempt = 0;
    const reconcile = () => {
      void bridge
        .list({ folderId })
        .then((tabs) => {
          if (cancelled) return;
          const currentTabs = tabs.filter(
            (tab) => tab.folderId === folderId && tab.spaceId === currentSpaceId,
          );
          for (const tab of tabs) {
            if (isAppTabOutsideFolderSpace(tab, folderId, currentSpaceId)) {
              void bridge.close({ tabId: tab.id }).catch(() => undefined);
              closePane(folderId, tab.id);
            }
          }
          const liveIds = new Set(currentTabs.map((tab) => tab.id));
          setConfirmedAppPaneIds(liveIds);
          const currentDockStates = useRightDockStore.getState().dockStateByFolderId;
          for (const tab of currentTabs) {
            const stateForThread = currentDockStates[folderId];
            if (!stateForThread?.panes.some((pane) => pane.id === tab.id)) {
              openPane(folderId, {
                ...appPaneFromTab(tab),
                preserveSelection: tab.selection !== "activate",
              });
            } else {
              updatePane(folderId, tab.id, {
                appIconDataUrl: tab.iconDataUrl,
                appPresentationTitle: tab.presentationTitle ?? null,
                appPresentationIconUrl: tab.presentationIconUrl ?? null,
                appRendererId: tab.rendererId,
                appRoute: tab.route,
                ...(tab.state === undefined ? { appState: undefined } : { appState: tab.state }),
                appStatus: tab.status,
              });
              if (tab.selection === "activate") setActivePane(folderId, tab.id);
            }
          }
          for (const pane of dockState.panes) {
            if (!isAppPaneInSpace(pane, currentSpaceId)) {
              void bridge.close({ tabId: pane.id }).catch(() => undefined);
              closePane(folderId, pane.id);
              continue;
            }
            if (
              !liveIds.has(pane.id) &&
              pane.appStatus !== "unloaded" &&
              pane.appStatus !== "loading"
            ) {
              updatePane(folderId, pane.id, {
                appStatus: "unloaded",
              });
            }
          }
        })
        .catch((error: unknown) => {
          if (cancelled) return;
          if (shouldRetryAppTabHostReady(error, readinessAttempt++)) {
            retryTimer = window.setTimeout(reconcile, 100);
            return;
          }
          toastManager.add({
            type: "error",
            title: "Could not restore Apps",
            description:
              error instanceof Error ? error.message : "The App tabs could not be restored.",
          });
        });
    };
    reconcile();
    return () => {
      cancelled = true;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
    };
  }, [closePane, currentSpaceId, folderId, dockState.panes, openPane, props.threadId, updatePane]);

  useEffect(() => {
    if (!currentSpaceId || !dockState.open || dockState.activePaneId === null) return;
    const activePane = dockState.panes.find((pane) => pane.id === dockState.activePaneId);
    if (activePane && isAppPaneInSpace(activePane, currentSpaceId)) loadAppPane(activePane);
  }, [currentSpaceId, dockState.activePaneId, dockState.open, dockState.panes, loadAppPane]);

  const openAppsListing = useCallback(
    (appId: string) => {
      const bridge = window.desktopBridge?.appTabs;
      if (!bridge || !currentSpaceId) return;
      const existing = dockState.panes.find(
        (pane) => pane.appId === "com.penkra.apps" && isAppPaneInSpace(pane, currentSpaceId),
      );
      if (existing) {
        setActivePane(folderId, existing.id);
        void bridge
          .navigate({
            tabId: existing.id,
            route: "/detail",
            state: { appId, tab: "description" },
          })
          .catch((error: unknown) =>
            toastManager.add({
              type: "error",
              title: "Could not open App listing",
              description:
                error instanceof Error ? error.message : "The App listing could not open.",
            }),
          );
        return;
      }
      void bridge
        .open({
          appId: "com.penkra.apps",
          spaceId: currentSpaceId,
          folderId,
          threadId: props.threadId,
          route: "/detail",
          state: { appId, tab: "description" },
        })
        .then((tab) => openPane(folderId, appPaneFromTab(tab)))
        .catch((error: unknown) =>
          toastManager.add({
            type: "error",
            title: "Could not open App listing",
            description: error instanceof Error ? error.message : "The App listing could not open.",
          }),
        );
    },
    [currentSpaceId, folderId, dockState.panes, openPane, props.threadId, setActivePane],
  );

  useEffect(() => {
    const bridge = window.desktopBridge?.appTabs;
    if (!bridge) return;
    const remove = bridge.onListingRequested(({ appId }) => openAppsListing(appId));
    void bridge.consumeListingRequest().then((request) => {
      if (request) openAppsListing(request.appId);
    });
    return remove;
  }, [openAppsListing]);

  const appsPane = dockState.panes.find(
    (pane) =>
      pane.appId === "com.penkra.apps" &&
      currentSpaceId !== null &&
      isAppPaneInSpace(pane, currentSpaceId),
  );
  const appsLauncherPressed = dockState.open && dockState.activePaneId === appsPane?.id;
  const handleAppsLauncher = () => {
    const action = resolveAppsLauncherAction({
      dockOpen: dockState.open,
      activePaneId: dockState.activePaneId,
      appsPaneId: appsPane?.id ?? null,
    });
    if (action.kind === "collapse") {
      setDockOpen(folderId, false);
      return;
    }
    if (action.kind === "switch") {
      setActivePane(folderId, action.paneId);
      return;
    }
    const bridge = window.desktopBridge?.appTabs;
    if (!bridge || !currentSpaceId) {
      toastManager.add({
        type: "warning",
        title: "Apps is unavailable",
        description: "Open a Thread that belongs to a Space and try again.",
      });
      return;
    }
    void bridge
      .open({
        appId: "com.penkra.apps",
        spaceId: currentSpaceId,
        folderId,
        threadId: props.threadId,
        route: "/",
      })
      .then((tab) => openPane(folderId, appPaneFromTab(tab)))
      .catch((error: unknown) =>
        toastManager.add({
          type: "error",
          title: "Could not open Apps",
          description: error instanceof Error ? error.message : "The Apps package could not open.",
        }),
      );
  };

  const renderAppPane = (
    pane: RightDockPane,
    context: {
      isVisible: boolean;
      animateEntrance: boolean;
      animationStartedAtEpochMs: number | null;
    },
  ) =>
    shouldMountAppDockPane(pane.id, confirmedAppPaneIds) && pane.appRendererId !== undefined ? (
      <AppDockPane
        appName={pane.appName}
        folderId={folderId}
        threadId={props.threadId}
        {...(pane.appIconDataUrl !== undefined ? { iconDataUrl: pane.appIconDataUrl } : {})}
        status={pane.appStatus}
        tabId={pane.id}
        rendererId={pane.appRendererId}
        visible={context.isVisible}
        animateEntrance={context.animateEntrance}
        animationStartedAtEpochMs={context.animationStartedAtEpochMs}
      />
    ) : (
      <div
        aria-label={`${pane.appName} is unloaded`}
        className="flex h-full min-h-0 w-full items-center justify-center text-sm text-muted-foreground"
        role="status"
      >
        Select {pane.appName} to load it.
      </div>
    );

  const selectAppPane = (paneId: string) => {
    setActivePane(folderId, paneId);
    const pane = dockState.panes.find((candidate) => candidate.id === paneId);
    if (pane) loadAppPane(pane);
  };

  const closeAppPane = (paneId: string) => {
    void window.desktopBridge?.appTabs?.close({ tabId: paneId }).catch(() => undefined);
    closePane(folderId, paneId);
  };

  return (
    <ThreadResourceOpenerContext.Provider value={resourceOpener}>
      <div
        className={cn(
          CHAT_MAIN_VIEWPORT_SHELL_CLASS_NAME,
          CHAT_MAIN_CONTENT_SURFACE_CLASS_NAME,
          "relative",
        )}
        data-chat-surface-shell
        data-folder-id={folderId}
        style={
          {
            "--apps-launcher-right-inset": `${appsLauncherRightInsetPx}px`,
            "--apps-launcher-folder-bar-right-reservation": `${appsLauncherFolderBarReservationPx}px`,
          } as CSSProperties
        }
        onContextMenuCapture={(event) => {
          if (
            !showThreadResourceContextMenu({
              opener: resourceOpener,
              target: event.target,
              position: { x: event.clientX, y: event.clientY },
            })
          ) {
            return;
          }
          event.preventDefault();
          event.stopPropagation();
        }}
      >
        <div
          ref={threadToastViewportHostRef}
          className="relative flex h-full min-h-0 flex-1"
          data-thread-toast-viewport-host
          style={{ minWidth: THREAD_PANEL_MIN_WIDTH }}
        >
          <RouteInsetSurface
            compensateForLeftSidebar={false}
            surfaceClassName={CHAT_BACKGROUND_CLASS_NAME}
          >
            <ChatView threadId={props.threadId} paneScopeId={SINGLE_CHAT_PANE_SCOPE_ID} />
          </RouteInsetSurface>
        </div>
        <RightDock
          state={dockState}
          minWidth={APP_PANEL_MIN_WIDTH}
          contentMinWidth={THREAD_PANEL_MIN_WIDTH}
          defaultWidth={APP_PANEL_DEFAULT_WIDTH}
          shouldAcceptWidth={shouldAcceptAppPanelWidth}
          motionKey={folderId}
          onSelectPane={selectAppPane}
          onClosePane={closeAppPane}
          onOpenChange={(open) => setDockOpen(folderId, open)}
          onResize={(width) => setDockWidth(folderId, width)}
          renderPane={renderAppPane}
        />
        <div
          className="absolute top-1.5 z-50 [-webkit-app-region:no-drag]"
          style={{ right: "var(--apps-launcher-right-inset)" }}
        >
          <IconButton
            variant="chrome"
            size="icon-xs"
            label="Apps"
            tooltip="Apps"
            tooltipSide="bottom"
            aria-pressed={appsLauncherPressed}
            className="!size-8 shrink-0 rounded-lg [&_svg,&_[data-slot=central-icon]]:mx-0"
            onClick={handleAppsLauncher}
          >
            <AppsIcon />
          </IconButton>
        </div>
      </div>
    </ThreadResourceOpenerContext.Provider>
  );
}
