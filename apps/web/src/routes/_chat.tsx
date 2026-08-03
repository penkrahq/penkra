import type { ResolvedKeybindingsConfig } from "@penkra/contracts";
import { useQuery } from "@tanstack/react-query";
import { Outlet, createFileRoute, useLocation, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";

import {
  goBackInAppHistory,
  goForwardInAppHistory,
  resolveAppNavigationState,
} from "../appNavigation";
import ShortcutsDialog from "../components/ShortcutsDialog";
import { RecentViewSwitcher } from "../components/RecentViewSwitcher";
import { ChatSearchBar } from "../components/ChatSearchBar";
import { FindProvider } from "../components/find/FindProvider";
import ThreadSidebar from "../components/Sidebar";
import { isElectron } from "../env";
import { useHandleNewChat } from "../hooks/useHandleNewChat";
import { useHandleNewStudioChat } from "../hooks/useHandleNewStudioChat";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { useRecentViewSwitcher } from "../hooks/useRecentViewSwitcher";
import { useLatestProjectStore } from "../latestProjectStore";
import {
  resolveCurrentProjectTargetId,
  resolveLatestProjectTargetId,
  resolveLatestProjectTargetIdWithFallback,
  resolveNewThreadTarget,
} from "../lib/projectShortcutTargets";
import { resolveInheritedThreadContext } from "../lib/threadBootstrap";
import { startFreshChatForActiveSurface } from "../lib/startContainerChat";
import { serverConfigQueryOptions } from "../lib/serverReactQuery";
import { isOrdinarySpaceProject } from "../lib/spaces";
import { resolveShortcutCommand } from "../keybindings";
import { useStore } from "../store";
import { useSpacesUiStore } from "../spacesUiStore";
import { useThreadSelectionStore } from "../threadSelectionStore";
import { onServerMaintenanceUpdated } from "../wsNativeApi";
import { useWorkspacePathsStore } from "../workspacePathsStore";
import { useProviderStatusesForLocalConfig } from "~/hooks/useProviderStatusesForLocalConfig";
import { useRefreshProviderStatusesNow } from "~/hooks/useProviderStatusRefresh";
import { resolveProviderSendAvailabilityWithRefresh } from "~/lib/providerAvailability";
import { toastManager } from "~/components/ui/toast";
import {
  Sidebar,
  SIDEBAR_OFFCANVAS_MOTION_CLASS,
  SidebarProvider,
  useSidebar,
} from "~/components/ui/sidebar";
import { cn } from "~/lib/utils";

const EMPTY_KEYBINDINGS: ResolvedKeybindingsConfig = [];
const MAINTENANCE_EVENT_STALE_MS = 5 * 60 * 1000;

type MaintenanceToastId = ReturnType<typeof toastManager.add>;

function ThreadRetentionMaintenanceToast() {
  const toastIdRef = useRef<MaintenanceToastId | null>(null);

  useEffect(() => {
    return onServerMaintenanceUpdated((event) => {
      if (event.type !== "maintenance" || event.payload.task !== "thread-retention") {
        return;
      }

      const { state, deletedCount, totalCount, error } = event.payload;
      const eventMs = Date.parse(event.payload.at);
      const isStaleEvent = Number.isFinite(eventMs)
        ? Date.now() - eventMs > MAINTENANCE_EVENT_STALE_MS
        : false;
      if (isStaleEvent && toastIdRef.current === null) {
        return;
      }

      if (state === "started") {
        toastIdRef.current = toastManager.add({
          type: "loading",
          title: "Hiding old chats...",
          description: "Preparing background maintenance.",
          timeout: 0,
          data: { allowCrossThreadVisibility: true },
        });
        return;
      }

      if (state === "progress") {
        const toastId =
          toastIdRef.current ??
          toastManager.add({
            type: "loading",
            title: "Hiding old chats...",
            timeout: 0,
            data: { allowCrossThreadVisibility: true },
          });
        toastIdRef.current = toastId;
        toastManager.update(toastId, {
          type: "loading",
          title: "Hiding old chats...",
          description:
            totalCount && totalCount > 0
              ? `${deletedCount ?? 0} of ${totalCount} chats hidden.`
              : `${deletedCount ?? 0} chats hidden.`,
          timeout: 0,
          data: { allowCrossThreadVisibility: true },
        });
        return;
      }

      if (state === "failed") {
        const toastId = toastIdRef.current;
        toastIdRef.current = null;
        if (toastId) {
          toastManager.update(toastId, {
            type: "warning",
            title: "Chat maintenance paused",
            description: error ?? "Old chats will be retried later.",
            timeout: 6000,
            data: { allowCrossThreadVisibility: true },
          });
          return;
        }
        toastManager.add({
          type: "warning",
          title: "Chat maintenance paused",
          description: error ?? "Old chats will be retried later.",
          timeout: 6000,
          data: { allowCrossThreadVisibility: true },
        });
        return;
      }

      const toastId = toastIdRef.current;
      toastIdRef.current = null;
      if (!toastId) return;
      toastManager.update(toastId, {
        type: "success",
        title: "Old chats hidden",
        description:
          deletedCount && deletedCount > 0
            ? `${deletedCount} old chats hidden from the app.`
            : "No old chats needed hiding.",
        timeout: 3500,
        data: { allowCrossThreadVisibility: true },
      });
    });
  }, []);

  return null;
}

function resolveBrowserNavigationShortcut(
  event: KeyboardEvent,
  platform: string,
): "back" | "forward" | null {
  const isMac = /Mac|iPhone|iPad|iPod/i.test(platform);
  const key = event.key.toLowerCase();

  if (
    isMac &&
    event.metaKey &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.shiftKey &&
    (key === "[" || key === "]")
  ) {
    return key === "[" ? "back" : "forward";
  }

  if (
    !isMac &&
    event.altKey &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    (event.key === "ArrowLeft" || event.key === "ArrowRight")
  ) {
    return event.key === "ArrowLeft" ? "back" : "forward";
  }

  return null;
}

function isRecentViewSwitcherCommitKey(event: KeyboardEvent): boolean {
  return event.key === "Enter" || event.key === " " || event.key === "Spacebar";
}

function ChatRouteGlobalShortcuts() {
  const navigate = useNavigate();
  const { toggleSidebar } = useSidebar();
  const [shortcutsDialogOpen, setShortcutsDialogOpen] = useState(false);
  const [chatSearchOpen, setChatSearchOpen] = useState(false);
  const [chatSearchFocusRequest, setChatSearchFocusRequest] = useState(0);
  const clearSelection = useThreadSelectionStore((state) => state.clearSelection);
  const selectedThreadIdsSize = useThreadSelectionStore((state) => state.selectedThreadIds.size);
  const {
    activeContextThreadId,
    activeDraftThread,
    activeProjectId,
    activeThread,
    handleNewThread,
    projects,
  } = useHandleNewThread();
  const {
    recentSwitcherState,
    recentViewEntries,
    openOrAdvanceRecentSwitcher,
    commitRecentSwitcherSelection,
    cancelRecentSwitcher,
  } = useRecentViewSwitcher({
    activeContextThreadId,
    activeDraftThread,
    projects,
  });
  const { handleNewChat } = useHandleNewChat(handleNewThread);
  const { handleNewStudioChat } = useHandleNewStudioChat(handleNewThread);
  const homeDir = useWorkspacePathsStore((state) => state.homeDir);
  const chatWorkspaceRoot = useWorkspacePathsStore((state) => state.chatWorkspaceRoot);
  const studioWorkspaceRoot = useWorkspacePathsStore((state) => state.studioWorkspaceRoot);
  const isStudioRoute = useLocation({
    select: (location) => location.pathname === "/studio",
  });
  const latestProjectId = useLatestProjectStore((state) => state.latestProjectId);
  const setLatestProjectId = useLatestProjectStore((state) => state.setLatestProjectId);
  const clearLatestProjectId = useLatestProjectStore((state) => state.clearLatestProjectId);
  const threadsHydrated = useStore((state) => state.threadsHydrated);
  const activeSpaceId = useSpacesUiStore((state) => state.activeSpaceId);
  const serverConfigQuery = useQuery(serverConfigQueryOptions());
  const keybindings = serverConfigQuery.data?.keybindings ?? EMPTY_KEYBINDINGS;
  const platform = typeof navigator === "undefined" ? "" : navigator.platform;
  const providerStatuses = useProviderStatusesForLocalConfig();
  const refreshProviderStatuses = useRefreshProviderStatusesNow();
  const newChatInFlightRef = useRef<Promise<unknown> | null>(null);
  const activeProject =
    activeProjectId !== null
      ? (projects.find((project) => project.id === activeProjectId) ?? null)
      : null;
  const activeProjectScripts = activeProject?.kind === "project" ? activeProject.scripts : [];
  // Shortcuts that target "a project" must stay inside the Space you are looking at, or
  // mod+alt+arrow would switch Space and the next new-thread shortcut would drop you back
  // out of it.
  const activeSpaceProjects = useMemo(
    () =>
      projects.filter(
        (project) =>
          isOrdinarySpaceProject(project, { homeDir, chatWorkspaceRoot, studioWorkspaceRoot }) &&
          (project.spaceId ?? null) === activeSpaceId,
      ),
    [activeSpaceId, chatWorkspaceRoot, homeDir, projects, studioWorkspaceRoot],
  );
  const currentProjectId = resolveCurrentProjectTargetId(
    activeSpaceProjects,
    activeProject?.id ?? null,
  );
  // The remembered project is global, so it is unusable the moment you switch Space. Fall
  // back to this Space's most recently touched project rather than to nothing.
  const latestUsableProjectId = useMemo(
    () => resolveLatestProjectTargetIdWithFallback(activeSpaceProjects, latestProjectId),
    [activeSpaceProjects, latestProjectId],
  );
  // Deliberately unscoped: the persisted id is only cleared once the project is gone from
  // the app entirely, not merely absent from the Space you happen to be in.
  const persistedLatestProjectStillExists = resolveLatestProjectTargetId(projects, latestProjectId);
  const handleNewChatForActiveSurface = useCallback(() => {
    if (newChatInFlightRef.current) {
      return newChatInFlightRef.current;
    }
    const operation = startFreshChatForActiveSurface({
      activeProject,
      isStudioRoute,
      paths: { homeDir, chatWorkspaceRoot, studioWorkspaceRoot },
      handleNewChat,
      handleNewStudioChat,
    });
    newChatInFlightRef.current = operation;
    const clearOperation = () => {
      if (newChatInFlightRef.current === operation) {
        newChatInFlightRef.current = null;
      }
    };
    void operation.then(clearOperation, clearOperation);
    return operation;
  }, [
    activeProject,
    chatWorkspaceRoot,
    handleNewChat,
    handleNewStudioChat,
    homeDir,
    isStudioRoute,
    studioWorkspaceRoot,
  ]);

  useEffect(() => {
    if (!currentProjectId) {
      return;
    }
    setLatestProjectId(currentProjectId);
  }, [currentProjectId, setLatestProjectId]);

  useEffect(() => {
    if (threadsHydrated && latestProjectId && persistedLatestProjectStillExists === null) {
      clearLatestProjectId(latestProjectId);
    }
  }, [clearLatestProjectId, latestProjectId, persistedLatestProjectStillExists, threadsHydrated]);

  useEffect(() => {
    const onWindowKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const shortcutContext = {
        terminalFocus: false,
        terminalOpen: false,
        terminalWorkspaceOpen: false,
      };

      if (recentSwitcherState && event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        cancelRecentSwitcher();
        return;
      }

      if (recentSwitcherState && isRecentViewSwitcherCommitKey(event)) {
        event.preventDefault();
        event.stopPropagation();
        commitRecentSwitcherSelection();
        return;
      }

      const isShortcutsHelpShortcut =
        (event.metaKey || event.ctrlKey) &&
        !event.shiftKey &&
        !event.altKey &&
        !event.repeat &&
        (event.key === "/" || event.code === "Slash");
      if (isShortcutsHelpShortcut) {
        event.preventDefault();
        event.stopPropagation();
        setShortcutsDialogOpen(true);
        return;
      }

      const appNavigationShortcut = isElectron
        ? resolveBrowserNavigationShortcut(event, platform)
        : null;
      if (appNavigationShortcut) {
        event.preventDefault();
        event.stopPropagation();
        const navigationState = resolveAppNavigationState();
        if (appNavigationShortcut === "back" && navigationState.canGoBack) {
          goBackInAppHistory();
        }
        if (appNavigationShortcut === "forward" && navigationState.canGoForward) {
          goForwardInAppHistory();
        }
        return;
      }

      if (event.key === "Escape" && selectedThreadIdsSize > 0) {
        event.preventDefault();
        clearSelection();
        return;
      }

      const command = resolveShortcutCommand(event, keybindings, { context: shortcutContext });
      if (command === "sidebar.toggle") {
        event.preventDefault();
        event.stopPropagation();
        toggleSidebar();
        return;
      }

      if (command === "chat.search") {
        event.preventDefault();
        event.stopPropagation();
        setChatSearchOpen(true);
        setChatSearchFocusRequest((current) => current + 1);
        return;
      }

      if (!command) return;

      if (command === "view.recent.next" || command === "view.recent.previous") {
        event.preventDefault();
        event.stopPropagation();
        // Ignore auto-repeat: holding Ctrl+Tab should not race-advance the selection.
        if (event.repeat) return;
        openOrAdvanceRecentSwitcher(command === "view.recent.next" ? "next" : "previous");
        return;
      }

      if (command === "chat.newChat" || command === "chat.newLocal") {
        event.preventDefault();
        event.stopPropagation();
        void handleNewChatForActiveSurface();
        return;
      }

      if (command === "chat.newLatestProject") {
        if (!latestUsableProjectId) return;
        event.preventDefault();
        event.stopPropagation();
        void handleNewThread(latestUsableProjectId);
        return;
      }

      if (
        command === "chat.newClaude" ||
        command === "chat.newCodex" ||
        command === "chat.newCursor"
      ) {
        const provider =
          command === "chat.newClaude"
            ? "claudeAgent"
            : command === "chat.newCodex"
              ? "codex"
              : "cursor";
        const target = resolveNewThreadTarget({ currentProjectId, latestUsableProjectId });
        if (!target) return;
        event.preventDefault();
        event.stopPropagation();
        void (async () => {
          const providerAvailability = await resolveProviderSendAvailabilityWithRefresh({
            provider,
            statuses: providerStatuses,
            refreshStatuses: () => refreshProviderStatuses({ silent: true }),
          });
          if (!providerAvailability.usable) {
            toastManager.add({
              type: "error",
              title: providerAvailability.unavailableReason,
            });
            return;
          }
          await handleNewThread(target.projectId, {
            provider,
            ...(target.inheritContext
              ? resolveInheritedThreadContext({ activeThread, activeDraftThread })
              : {}),
          });
        })();
        return;
      }

      if (command === "chat.newTerminal") {
        const target = resolveNewThreadTarget({ currentProjectId, latestUsableProjectId });
        if (!target) return;
        event.preventDefault();
        event.stopPropagation();
        void handleNewThread(target.projectId, {
          entryPoint: "terminal",
          ...(target.inheritContext
            ? resolveInheritedThreadContext({ activeThread, activeDraftThread })
            : {}),
        });
        return;
      }

      if (command !== "chat.new") return;
      // Falls back to the most recent project when none is focused (e.g. the landing
      // view) so the primary "new thread" chord always creates a thread; on that
      // fallback the active branch/worktree context belongs to the absent project, so
      // `resolveNewThreadTarget` omits it and we defer to the target's defaults.
      const target = resolveNewThreadTarget({ currentProjectId, latestUsableProjectId });
      if (!target) return;
      event.preventDefault();
      event.stopPropagation();
      void handleNewThread(
        target.projectId,
        target.inheritContext
          ? resolveInheritedThreadContext({ activeThread, activeDraftThread })
          : undefined,
      );
    };

    window.addEventListener("keydown", onWindowKeyDown, { capture: true });
    return () => {
      window.removeEventListener("keydown", onWindowKeyDown, { capture: true });
    };
  }, [
    activeDraftThread,
    activeThread,
    cancelRecentSwitcher,
    clearSelection,
    commitRecentSwitcherSelection,
    currentProjectId,
    handleNewChatForActiveSurface,
    handleNewThread,
    keybindings,
    latestUsableProjectId,
    openOrAdvanceRecentSwitcher,
    platform,
    providerStatuses,
    refreshProviderStatuses,
    recentSwitcherState,
    selectedThreadIdsSize,
    toggleSidebar,
  ]);

  useEffect(() => {
    const onMenuAction = window.desktopBridge?.onMenuAction;
    if (typeof onMenuAction !== "function") {
      return;
    }

    const unsubscribe = onMenuAction((action) => {
      if (action === "toggle-sidebar") {
        toggleSidebar();
        return;
      }
      if (action !== "open-settings") return;
      void navigate({ to: "/settings" });
    });

    return () => {
      unsubscribe?.();
    };
  }, [navigate, toggleSidebar]);

  return (
    <>
      <ShortcutsDialog
        open={shortcutsDialogOpen}
        onOpenChange={setShortcutsDialogOpen}
        keybindings={keybindings}
        projectScripts={activeProjectScripts}
        platform={platform}
        context={{
          terminalFocus: false,
          terminalOpen: false,
          terminalWorkspaceOpen: false,
        }}
      />
      <ChatSearchBar
        open={chatSearchOpen}
        focusRequest={chatSearchFocusRequest}
        onOpenChange={setChatSearchOpen}
      />
      {recentSwitcherState ? (
        <RecentViewSwitcher
          entries={recentViewEntries}
          selectedIndex={recentSwitcherState.selectedIndex}
        />
      ) : null}
    </>
  );
}

/** Subtle top-corner sheen on the sidebar gap. The sidebar always sits on the left, so
 *  the radial highlight is anchored to the top-left corner. */
const SIDEBAR_GAP_CLASS =
  "overflow-hidden before:absolute before:inset-0 before:bg-[radial-gradient(90%_75%_at_0%_0%,rgba(255,255,255,0.06),transparent_58%),linear-gradient(180deg,rgba(255,255,255,0.025),rgba(255,255,255,0.008))] dark:before:bg-[radial-gradient(90%_75%_at_0%_0%,rgba(255,255,255,0.04),transparent_58%),linear-gradient(180deg,rgba(255,255,255,0.018),rgba(255,255,255,0.006))]";

/** No inline-start/end border: the chat content card provides the edge (rounded + overlap).
 *  A sidebar border here draws a full-height vertical line through the titlebar seam. */
const SIDEBAR_INNER_CLASS = "app-sidebar-surface";

function ChatRouteLayout() {
  const isEditorView = useLocation({
    select: (location) => (location.search as { view?: unknown }).view === "editor",
  });
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const resolvedSidebarOpen = isEditorView ? false : sidebarOpen;

  // The thread sidebar always lives on the left; the right dock is a separate surface.
  const sidebarElement = (
    <Sidebar
      data-pencil-component="UPCCE"
      side="left"
      collapsible="offcanvas"
      // Match the right dock's soft drawer slide (shared token) instead of the
      // shell's default `ease-linear`. Applied to the container + gap in lockstep.
      className={cn("text-foreground", SIDEBAR_OFFCANVAS_MOTION_CLASS)}
      gapClassName={cn(SIDEBAR_GAP_CLASS, SIDEBAR_OFFCANVAS_MOTION_CLASS)}
      innerClassName={SIDEBAR_INNER_CLASS}
      transparentSurface
    >
      <ThreadSidebar />
    </Sidebar>
  );

  // The Pencil shell has no interactive divider between the left rail and the
  // center panel. Keep this wrapper layout-only: sidebar visibility remains
  // available through explicit app commands, never through an invisible seam.
  const mainContentShell = (
    <div className="relative flex h-svh min-h-0 min-w-0 flex-1">
      <Outlet />
    </div>
  );

  return (
    <FindProvider>
      <SidebarProvider
        defaultOpen
        open={resolvedSidebarOpen}
        onOpenChange={setSidebarOpen}
        className="bg-[var(--app-shell-background)]"
        data-sidebar-side="left"
        data-find-application-root
        style={{ "--sidebar-width": "15rem" } as CSSProperties}
      >
        <ThreadRetentionMaintenanceToast />
        <ChatRouteGlobalShortcuts />
        {sidebarElement}
        {mainContentShell}
      </SidebarProvider>
    </FindProvider>
  );
}

export const Route = createFileRoute("/_chat")({
  component: ChatRouteLayout,
});
