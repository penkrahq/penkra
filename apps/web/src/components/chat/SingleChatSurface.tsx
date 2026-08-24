import type { DesktopAppTabDescriptor } from "@penkra/contracts";
import type { FolderId, ThreadId } from "@penkra/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useComposerDraftStore } from "../../composerDraftStore";
import { canComposerHandlePanelWidth } from "../../lib/panelResize";
import {
  ThreadResourceOpenerContext,
  createThreadResourceOpener,
} from "../../lib/threadResourceOpener";
import { selectRightDockState, useRightDockStore } from "../../rightDockStore";
import type { RightDockPane } from "../../rightDockStore.logic";
import { useStore } from "../../store";
import {
  createProjectSelector,
  createSidebarThreadSummariesSelector,
  createThreadWorkspaceMetadataSelector,
} from "../../storeSelectors";
import { resolveThreadWorkingDirectory } from "../../routes/-chatThreadRoute.logic";
import { RouteInsetSurface } from "../RouteInsetSurface";
import { IconButton } from "../ui/icon-button";
import { toastManager } from "../ui/toast";
import { AppsIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { AppDockPane } from "./AppDockPane";
import { shouldMountAppDockPane, shouldRetryAppTabHostReady } from "./appTabRestore.logic";
import { resolveAppsLauncherAction, resolveAppsLauncherSpaceId } from "./appsLauncher.logic";
import { DeferredChatView } from "./ChatThreadSurfacePrimitives";
import {
  CHAT_BACKGROUND_CLASS_NAME,
  CHAT_MAIN_CONTENT_SURFACE_CLASS_NAME,
  CHAT_MAIN_VIEWPORT_SHELL_CLASS_NAME,
} from "./composerPickerStyles";
import { SINGLE_CHAT_PANE_SCOPE_ID } from "../../lib/chatPaneScope";
import { RightDock } from "./RightDock";

const APP_PANEL_DEFAULT_WIDTH = "max(28rem, calc(50vw - 8rem))";
const APP_PANEL_MIN_WIDTH = 26 * 16;

function shouldAcceptAppPanelWidth(input: { nextWidth: number; wrapper: HTMLElement }) {
  const previousSidebarWidth = input.wrapper.style.getPropertyValue("--sidebar-width");
  return canComposerHandlePanelWidth({
    nextWidth: input.nextWidth,
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
}

function appPaneFromTab(tab: DesktopAppTabDescriptor) {
  return {
    paneId: tab.id,
    kind: "app" as const,
    appId: tab.appId,
    appSlug: tab.slug,
    appName: tab.name,
    appIconDataUrl: tab.iconDataUrl,
    appRendererId: tab.rendererId,
    appDocumentUrl: tab.documentUrl,
    appRoute: tab.route,
    ...(tab.state === undefined ? {} : { appState: tab.state }),
    appStatus: tab.status,
  };
}

export function SingleChatSurface(props: { threadId: ThreadId; folderId: FolderId | null }) {
  const dockState = useRightDockStore(
    useMemo(() => selectRightDockState(props.threadId), [props.threadId]),
  );
  const dockStateByThreadId = useRightDockStore((store) => store.dockStateByThreadId);
  const retainedAppPanes = useMemo(() => {
    const panes = new Map<string, RightDockPane>();
    for (const state of Object.values(dockStateByThreadId)) {
      for (const pane of state?.panes ?? []) panes.set(pane.id, pane);
    }
    return [...panes.values()];
  }, [dockStateByThreadId]);
  const openPane = useRightDockStore((store) => store.openPane);
  const closePane = useRightDockStore((store) => store.closePane);
  const setActivePane = useRightDockStore((store) => store.setActivePane);
  const setDockOpen = useRightDockStore((store) => store.setDockOpen);
  const setDockWidth = useRightDockStore((store) => store.setDockWidth);
  const updatePane = useRightDockStore((store) => store.updatePane);
  const activeProject = useStore(
    useMemo(() => createProjectSelector(props.folderId), [props.folderId]),
  );
  const threadWorkspaceMetadata = useStore(
    useMemo(() => createThreadWorkspaceMetadataSelector(props.threadId), [props.threadId]),
  );
  const draftThread = useComposerDraftStore(
    (store) => store.draftThreadsByThreadId[props.threadId] ?? null,
  );
  const threadSummaries = useStore(useMemo(() => createSidebarThreadSummariesSelector(), []));
  const restoringAppPaneIdsRef = useRef(new Set<string>());
  const [confirmedAppPaneIds, setConfirmedAppPaneIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const currentSpaceId = resolveAppsLauncherSpaceId({
    persistedSpaceId:
      threadSummaries.find((thread) => thread.id === props.threadId)?.spaceId ?? null,
    draftSpaceId: draftThread?.spaceId ?? null,
    projectSpaceId: activeProject?.spaceId ?? null,
  });
  const threadDirectory = resolveThreadWorkingDirectory({
    projectCwd: activeProject?.cwd ?? null,
    threadWorkingDirectory:
      threadWorkspaceMetadata.workingDirectory ?? draftThread?.workingDirectory ?? null,
  });
  const resourceOpener = useMemo(
    () =>
      createThreadResourceOpener({
        directory: threadDirectory,
        spaceId: currentSpaceId,
        threadId: props.threadId,
      }),
    [currentSpaceId, props.threadId, threadDirectory],
  );

  useEffect(() => {
    const bridge = window.desktopBridge?.appTabs;
    if (!bridge) return;
    const removeOpened = bridge.onOpened((tab) => {
      setConfirmedAppPaneIds((current) => new Set(current).add(tab.id));
      openPane(tab.threadId as ThreadId, appPaneFromTab(tab));
    });
    const removeState = bridge.onState((tab) => {
      updatePane(tab.threadId as ThreadId, tab.id, {
        appIconDataUrl: tab.iconDataUrl,
        appRendererId: tab.rendererId,
        appDocumentUrl: tab.documentUrl,
        appRoute: tab.route,
        ...(tab.state === undefined ? { appState: undefined } : { appState: tab.state }),
        appStatus: tab.status,
      });
    });
    const removeClosed = bridge.onClosed((tab) => {
      setConfirmedAppPaneIds((current) => {
        if (!current.has(tab.id)) return current;
        const next = new Set(current);
        next.delete(tab.id);
        return next;
      });
      closePane(tab.threadId as ThreadId, tab.id);
    });
    return () => {
      removeOpened();
      removeState();
      removeClosed();
    };
  }, [closePane, openPane, updatePane]);

  useEffect(() => {
    const bridge = window.desktopBridge?.appTabs;
    if (!bridge || !currentSpaceId) return;
    let cancelled = false;
    let retryTimer: number | null = null;
    let readinessAttempt = 0;
    const reconcile = () => {
      void bridge
        .list()
        .then((tabs) => {
          if (cancelled) return;
          const tabsForThread = tabs.filter((tab) => tab.threadId === props.threadId);
          const liveIds = new Set(tabs.map((tab) => tab.id));
          setConfirmedAppPaneIds(liveIds);
          const currentDockStates = useRightDockStore.getState().dockStateByThreadId;
          for (const tab of tabs) {
            const stateForThread = currentDockStates[tab.threadId];
            if (!stateForThread?.panes.some((pane) => pane.id === tab.id)) {
              openPane(tab.threadId as ThreadId, appPaneFromTab(tab));
            } else {
              updatePane(tab.threadId as ThreadId, tab.id, {
                appIconDataUrl: tab.iconDataUrl,
                appRendererId: tab.rendererId,
                appDocumentUrl: tab.documentUrl,
                appRoute: tab.route,
                ...(tab.state === undefined ? { appState: undefined } : { appState: tab.state }),
                appStatus: tab.status,
              });
            }
          }
          for (const pane of dockState.panes) {
            if (liveIds.has(pane.id) || restoringAppPaneIdsRef.current.has(pane.id)) continue;
            restoringAppPaneIdsRef.current.add(pane.id);
            // A persisted pane ID belongs to the previous Electron process and cannot be attached.
            // Remove it before opening the replacement so AppDockPane never races the main process
            // with attach/visibility requests for a renderer that no longer exists.
            closePane(props.threadId, pane.id);
            void bridge
              .open({
                appId: pane.appId,
                spaceId: currentSpaceId,
                threadId: props.threadId,
                route: pane.appRoute,
                ...(pane.appState === undefined ? {} : { state: pane.appState }),
              })
              .catch((error: unknown) => {
                toastManager.add({
                  type: "error",
                  title: "Could not restore App",
                  description:
                    error instanceof Error ? error.message : "The App tab could not be restored.",
                });
              })
              .finally(() => restoringAppPaneIdsRef.current.delete(pane.id));
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
  }, [closePane, currentSpaceId, dockState.panes, openPane, props.threadId]);

  const openAppsListing = useCallback(
    (appId: string) => {
      const bridge = window.desktopBridge?.appTabs;
      if (!bridge || !currentSpaceId) return;
      const existing = dockState.panes.find((pane) => pane.appId === "com.penkra.apps");
      if (existing) {
        setActivePane(props.threadId, existing.id);
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
          threadId: props.threadId,
          route: "/detail",
          state: { appId, tab: "description" },
        })
        .then((tab) => openPane(props.threadId, appPaneFromTab(tab)))
        .catch((error: unknown) =>
          toastManager.add({
            type: "error",
            title: "Could not open App listing",
            description: error instanceof Error ? error.message : "The App listing could not open.",
          }),
        );
    },
    [currentSpaceId, dockState.panes, openPane, props.threadId, setActivePane],
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

  const appsPane = dockState.panes.find((pane) => pane.appId === "com.penkra.apps");
  const appsLauncherPressed = dockState.open && dockState.activePaneId === appsPane?.id;
  const handleAppsLauncher = () => {
    const action = resolveAppsLauncherAction({
      dockOpen: dockState.open,
      activePaneId: dockState.activePaneId,
      appsPaneId: appsPane?.id ?? null,
    });
    if (action.kind === "collapse") {
      setDockOpen(props.threadId, false);
      return;
    }
    if (action.kind === "switch") {
      setActivePane(props.threadId, action.paneId);
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
        threadId: props.threadId,
        route: "/",
      })
      .then((tab) => openPane(props.threadId, appPaneFromTab(tab)))
      .catch((error: unknown) =>
        toastManager.add({
          type: "error",
          title: "Could not open Apps",
          description: error instanceof Error ? error.message : "The Apps package could not open.",
        }),
      );
  };

  const renderAppPane = (pane: RightDockPane, context: { isVisible: boolean }) =>
    shouldMountAppDockPane(pane.id, confirmedAppPaneIds) && pane.appRendererId !== undefined ? (
      <AppDockPane
        appName={pane.appName}
        {...(pane.appIconDataUrl !== undefined ? { iconDataUrl: pane.appIconDataUrl } : {})}
        status={pane.appStatus}
        tabId={pane.id}
        rendererId={pane.appRendererId}
        documentUrl={pane.appDocumentUrl ?? ""}
        visible={context.isVisible}
      />
    ) : (
      <div
        aria-label={`Restoring ${pane.appName}`}
        className="flex h-full min-h-0 w-full items-center justify-center text-sm text-muted-foreground"
        role="status"
      >
        Restoring {pane.appName}…
      </div>
    );

  const closeAppPane = (paneId: string) => {
    void window.desktopBridge?.appTabs?.close({ tabId: paneId }).catch(() => undefined);
    closePane(props.threadId, paneId);
  };

  return (
    <ThreadResourceOpenerContext.Provider value={resourceOpener}>
      <div
        className={cn(
          CHAT_MAIN_VIEWPORT_SHELL_CLASS_NAME,
          CHAT_MAIN_CONTENT_SURFACE_CLASS_NAME,
          "relative",
        )}
      >
        <div className="flex h-full min-h-0 min-w-0 flex-1">
          <RouteInsetSurface
            compensateForLeftSidebar={false}
            surfaceClassName={CHAT_BACKGROUND_CLASS_NAME}
          >
            <DeferredChatView
              threadId={props.threadId}
              paneScopeId={SINGLE_CHAT_PANE_SCOPE_ID}
              deferMount={draftThread !== null}
              surfaceMode="single"
              isFocusedPane
            />
          </RouteInsetSurface>
        </div>
        <RightDock
          state={dockState}
          retainedPanes={retainedAppPanes}
          minWidth={APP_PANEL_MIN_WIDTH}
          defaultWidth={APP_PANEL_DEFAULT_WIDTH}
          shouldAcceptWidth={shouldAcceptAppPanelWidth}
          motionKey={props.threadId}
          onSelectPane={(paneId) => setActivePane(props.threadId, paneId)}
          onClosePane={closeAppPane}
          onOpenChange={(open) => setDockOpen(props.threadId, open)}
          onResize={(width) => setDockWidth(props.threadId, width)}
          renderPane={renderAppPane}
        />
        <div className="absolute right-1.5 top-1.5 z-50 [-webkit-app-region:no-drag]">
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
