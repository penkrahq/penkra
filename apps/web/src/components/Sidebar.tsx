// FILE: Sidebar.tsx
// Purpose: Renders the project/thread sidebar, including row status, sorting, and thread actions.
// Exports: Sidebar

import {
  MAX_PINNED_PROJECTS,
  ContainerId,
  SpaceId,
  ThreadId,
  type DesktopUpdateState,
  type OrchestrationShellSnapshot,
  type ResolvedKeybindingsConfig,
  type SidebarItemMovePosition,
  type SidebarItemParent,
  type SidebarItemReference,
} from "@penkra/contracts";
import type { DragEndEvent, DragOverEvent } from "@dnd-kit/react";
import { isSortable } from "@dnd-kit/react/sortable";
import { getDefaultModel } from "@penkra/shared/model";
import { pluralize } from "@penkra/shared/text";
import { resolveThreadWorkspaceCwd } from "@penkra/shared/threadEnvironment";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate, useParams } from "@tanstack/react-router";
import {
  Fragment,
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useCopyPathToClipboard, useCopyThreadIdToClipboard } from "~/hooks/useCopyToClipboard";
import { DESKTOP_TOP_BAR_TRAFFIC_LIGHT_GUTTER_CLASS } from "~/hooks/useDesktopTopBarGutter";
import { useDesktopWindowState } from "~/hooks/useDesktopWindowState";
import { createCentralIconComponent } from "~/lib/central-icons";
import { PlayIcon, TriangleAlertIcon } from "~/lib/icons";
import { pinActionLabel } from "~/lib/pin";
import { cn } from "~/lib/utils";
import { useAppSettings } from "../appSettings";
import type { LastThreadRoute } from "../chatRouteRestore";
import { useComposerDraftStore } from "../composerDraftStore";
import { isElectron } from "../env";
import { useFeedbackDialogStore } from "../feedbackDialogStore";
import { useFocusedChatContext } from "../focusedChatContext";
import { useChatRouteSearch } from "../hooks/useChatRouteSearch";
import { useHandleNewChat } from "../hooks/useHandleNewChat";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import {
  firstLocalServerUrl,
  useSidebarProjectRunController,
} from "../hooks/useSidebarProjectRunController";
import { useSidebarThreadActions } from "../hooks/useSidebarThreadActions";
import { useThreadActivationController } from "../hooks/useThreadActivationController";
import {
  resolveShortcutCommand,
  shortcutLabelForCommand,
  shouldShowThreadJumpHints,
  spaceJumpIndexFromCommand,
  threadJumpCommandForIndex,
  threadJumpIndexFromCommand,
} from "../keybindings";
import { useLatestProjectStore } from "../latestProjectStore";
import { isHomeChatContainerProject, prewarmHomeChatProject } from "../lib/chatProjects";
import { reconcileDeletedThreadsFromClient } from "../lib/deletedThreadClientReconciliation";
import { waitForRecoverableProjectInReadModel } from "../lib/projectCreateRecovery";
import { deleteProjectFromClient } from "../lib/projectDelete";
import {
  resolveCurrentProjectTargetId,
  resolveLatestProjectTargetIdWithFallback,
  resolveNewThreadTarget,
} from "../lib/projectShortcutTargets";
import {
  providerComposerCapabilitiesQueryOptions,
  supportsThreadImport,
} from "../lib/providerDiscoveryReactQuery";
import {
  prefetchProviderModelsForNewThread,
  resolveNewThreadModelPrefetchCwd,
  resolveNewThreadModelPrefetchProvider,
} from "../lib/providerModelPrefetch";
import { serverConfigQueryOptions } from "../lib/serverReactQuery";
import { activeSpaceDisplayNameForReference, resolveActiveSpaceId } from "../lib/spaceGrouping";
import { moveSidebarItem, resolveSidebarMovePosition } from "../lib/sidebarOrdering";
import { archiveSpace, isOrdinarySpaceProject } from "../lib/spaces";
import { isTerminalFocused } from "../lib/terminalFocus";
import { dispatchThreadRename } from "../lib/threadRename";
import { isMacPlatform, newCommandId, newProjectId, newThreadId } from "../lib/utils";
import { readNativeApi } from "../nativeApi";
import { usePinnedProjectsStore } from "../pinnedProjectsStore";
import { reconcileOptimisticPinState } from "../pinning.logic";
import { useSpacesUiStore } from "../spacesUiStore";
import { selectSplitView, useSplitViewStore } from "../splitViewStore";
import { useSidebarInlineRenameStore } from "../sidebarInlineRenameStore";
import { persistAppStateNow, useStore } from "../store";
import {
  createAllThreadsSelector,
  createSidebarDisplayThreadsSelector,
  createSidebarThreadSummariesSelector,
  createSidebarTreeThreadsSelector,
} from "../storeSelectors";
import { selectThreadTerminalState, useTerminalStateStore } from "../terminalStateStore";
import { getThreadFromState } from "../threadDerivation";
import { useThreadDetailPrewarm } from "../threadDetailPrewarm";
import { retainThreadDetailSubscription } from "../threadDetailSubscriptionRetention";
import { useThreadSelectionStore } from "../threadSelectionStore";
import type { SidebarThreadSummary, Space } from "../types";
import { useWorkspacePathsStore } from "../workspacePathsStore";
import { useVoiceSessionCoordinatorStore } from "../voiceSessionCoordinator";
import { subscribeToSpaceUiActions } from "../spaceUiEvents";
import { shouldRenderTerminalWorkspace } from "./ChatView.logic";
import { CreateProjectDialog, type CreateProjectSubmitValue } from "./CreateProjectDialog";
import {
  DEBUG_FEATURE_FLAGS_MENU_STORAGE_KEY,
  buildProjectThreadTree,
  derivePinnedProjectIdsForSidebar,
  deriveSidebarProjectData,
  getNextVisibleSidebarThreadId,
  getSidebarThreadIdsToPrewarm,
  getVisibleSidebarEntriesForPreview,
  groupSidebarThreadsByProjectId,
  isLatestPinnedProjectMutation,
  isProjectsSidebarSurface,
  orderPinnedProjectsForSidebar,
  orderSidebarSpaceItems,
  pruneProjectThreadListPagingForCollapsedProjects,
  resolveSidebarWorkStatus,
  resolveSidebarThreadListPaging,
  resolveThreadStatusPill,
  shouldClearThreadSelectionOnMouseDown,
  shouldPrunePinnedThreads,
  shouldShowDebugFeatureFlagsMenu,
  sortProjectsForSidebar,
  sortThreadsForSidebar,
  type SidebarDerivedProjectData,
} from "./Sidebar.logic";
import {
  normalizeSidebarProjectThreadListCwd,
  persistSidebarUiState,
  readSidebarUiState,
} from "./Sidebar.uiState";
import { SidebarLeadingControls } from "./SidebarHeaderNavigationControls";
import {
  SidebarSearchPalette,
  type ImportProviderKind,
  type SidebarSearchPaletteMode,
} from "./SidebarSearchPalette";
import type {
  SidebarSearchAction,
  SidebarSearchProject,
  SidebarSearchThread,
} from "./SidebarSearchPalette.logic";
import { CHAT_SURFACE_HEADER_HEIGHT_CLASS } from "./chat/chatHeaderControls";
import {
  getArm64IntelBuildWarningDescription,
  getDesktopUpdateActionError,
  getDesktopUpdateAlreadyCurrentNotice,
  getDesktopUpdateButtonPresentation,
  getDesktopUpdateDownloadPercent,
  getDesktopUpdateErrorSignature,
  isDesktopUpdateButtonDisabled,
  resolveDesktopUpdateButtonAction,
  shouldRecommendManualDesktopDownload,
  shouldShowArm64IntelBuildWarning,
  shouldShowDesktopUpdateButton,
  shouldToastDesktopUpdateActionResult,
} from "./desktopUpdate.logic";
import {
  readSidebarDndData,
  type SidebarDropPlacement,
  sidebarItemDndId,
  sidebarParentFromDndGroup,
  sidebarParentDndGroup,
  sidebarSpaceDndId,
  SidebarContainerDropTarget,
  SidebarDndMonitor,
  SortableSidebarNode,
} from "./sidebar/SidebarDnd";
import { subscribeToDesktopUpdateState } from "./desktopUpdate.subscription";
import { FolderRowInlineEdit } from "./left-rail/folder-row-inline-edit/FolderRowInlineEdit";
import { FolderGroupShared } from "./left-rail/folder-group-shared/FolderGroupShared";
import { AccountControlShared } from "./left-rail/account-control-shared/AccountControlShared";
import { ShowMoreRow } from "./left-rail/show-more-row/ShowMoreRow";
import { SidebarHeaderShared } from "./left-rail/sidebar-header-shared/SidebarHeaderShared";
import { SidebarProjects } from "./left-rail/sidebar-projects/SidebarProjects";
import { SidebarTopNavigation } from "./left-rail/sidebar-top-navigation/SidebarTopNavigation";
import { LeftRailContentShared } from "./left-rail/left-rail-content-shared/LeftRailContentShared";
import { SpaceGroupShared } from "./left-rail/space-group-shared/SpaceGroupShared";
import { SpaceHeaderInlineEdit } from "./left-rail/space-header-inline-edit/SpaceHeaderInlineEdit";
import {
  ThreadRowShared,
  type ThreadWorkStatus,
} from "./left-rail/thread-row-shared/ThreadRowShared";
import { ThreadRowInlineEdit } from "./left-rail/thread-row-inline-edit/ThreadRowInlineEdit";
import { toDisplayName } from "./profile/profileFormatting";
import { useProfileName } from "./profile/useProfileName";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "./ui/alert";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { SidebarFooter, SidebarHeader, SidebarTrigger, useSidebar } from "./ui/sidebar";
import { toastManager } from "./ui/toast";
import { useSpacesController } from "./useSpacesController";
const AddPlusIcon = createCentralIconComponent("plus-medium");

const EMPTY_KEYBINDINGS: ResolvedKeybindingsConfig = [];
const THREAD_PREVIEW_LIMIT = 5;
// Each "Show more" click reveals this many extra rows; collapsing resets the preview.
const THREAD_PREVIEW_PAGE_SIZE = 5;
const EMPTY_THREAD_JUMP_LABELS = new Map<ThreadId, string>();
const ADD_PROJECT_SNAPSHOT_CATCH_UP_MAX_ATTEMPTS = 6;
const ADD_PROJECT_SNAPSHOT_CATCH_UP_DELAY_MS = 50;

function projectThreadListPagingKey(project: { id: ContainerId; cwd: string }): string {
  return normalizeSidebarProjectThreadListCwd(project.cwd) || `project:${project.id}`;
}

type SidebarDropIntent =
  | {
      kind: "space";
      placement: SidebarDropPlacement;
      targetSpaceId: SpaceId;
    }
  | {
      kind: "item";
      target: SidebarItemParent;
    };

const DebugFeatureFlagsMenu = import.meta.env.DEV
  ? lazy(() =>
      import("./DebugFeatureFlagsMenu").then((module) => ({
        default: module.DebugFeatureFlagsMenu,
      })),
    )
  : null;

type ProjectContextMenuId =
  | "open-in-finder"
  | "copy-path"
  | "start-dev"
  | "stop-dev"
  | "open-dev-server"
  | "rename"
  | "toggle-pin"
  | "archive-threads"
  | "delete-threads"
  | "delete";

type ProjectNativeContextMenuId = ProjectContextMenuId | "new-space" | `move-to-space:${string}`;

const MOVE_PROJECT_TO_SPACE_CONTEXT_MENU_PREFIX = "move-to-space:";

function isMoveProjectToSpaceContextMenuId(
  value: ProjectNativeContextMenuId,
): value is `move-to-space:${string}` {
  return value.startsWith(MOVE_PROJECT_TO_SPACE_CONTEXT_MENU_PREFIX);
}

type DebugFeatureFlagsWindow = Window & {
  penkraShowFeatureFlags?: () => void;
  penkraHideFeatureFlags?: () => void;
};

function readDebugFeatureFlagsMenuVisibility(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  try {
    return shouldShowDebugFeatureFlagsMenu({
      isDev: import.meta.env.DEV,
      hostname: window.location.hostname,
      storageValue: window.localStorage.getItem(DEBUG_FEATURE_FLAGS_MENU_STORAGE_KEY),
    });
  } catch {
    return false;
  }
}

function threadJumpLabelMapsEqual(
  left: ReadonlyMap<ThreadId, string>,
  right: ReadonlyMap<ThreadId, string>,
): boolean {
  if (left === right) {
    return true;
  }
  if (left.size !== right.size) {
    return false;
  }
  for (const [threadId, label] of left) {
    if (right.get(threadId) !== label) {
      return false;
    }
  }
  return true;
}

// Resolve the visible numbered-thread hints from the active keybinding config.
function buildThreadJumpLabelMap(input: {
  keybindings: ResolvedKeybindingsConfig;
  platform: string;
  terminalOpen: boolean;
  threadJumpCommandByThreadId: ReadonlyMap<
    ThreadId,
    NonNullable<ReturnType<typeof threadJumpCommandForIndex>>
  >;
}): ReadonlyMap<ThreadId, string> {
  if (input.threadJumpCommandByThreadId.size === 0) {
    return EMPTY_THREAD_JUMP_LABELS;
  }

  const shortcutLabelOptions = {
    platform: input.platform,
    context: {
      terminalFocus: false,
      terminalOpen: input.terminalOpen,
    },
  } as const;
  const mapping = new Map<ThreadId, string>();
  for (const [threadId, command] of input.threadJumpCommandByThreadId) {
    const label = shortcutLabelForCommand(input.keybindings, command, shortcutLabelOptions);
    if (label) {
      mapping.set(threadId, label);
    }
  }
  return mapping.size > 0 ? mapping : EMPTY_THREAD_JUMP_LABELS;
}

export default function Sidebar() {
  const { setOpen: setSidebarOpen } = useSidebar();
  const [showDebugFeatureFlagsMenu, setShowDebugFeatureFlagsMenu] = useState(
    readDebugFeatureFlagsMenuVisibility,
  );
  const projects = useStore((store) => store.projects);
  const spaces = useStore((store) => store.spaces);
  const archivedSpaces = useStore((store) => store.archivedSpaces);
  // Selection state only; the handlers and sync effects live in useSpacesController.
  const storedActiveSpaceId = useSpacesUiStore((store) => store.activeSpaceId);
  const pendingActiveSpaceId = useSpacesUiStore(
    (store) => store.pendingActiveSpace?.spaceId ?? null,
  );
  const activeSpaceId = resolveActiveSpaceId(storedActiveSpaceId, spaces, pendingActiveSpaceId);
  const threadsHydrated = useStore((store) => store.threadsHydrated);
  const sidebarThreadSummaryById = useStore((store) => store.sidebarThreadSummaryById);
  const syncServerShellSnapshot = useStore((store) => store.syncServerShellSnapshot);
  const markThreadVisited = useStore((store) => store.markThreadVisited);
  const markThreadUnread = useStore((store) => store.markThreadUnread);
  const toggleProject = useStore((store) => store.toggleProject);
  const setProjectExpanded = useStore((store) => store.setProjectExpanded);
  const removeDeletedProjectFromClientState = useStore(
    (store) => store.removeDeletedProjectFromClientState,
  );
  const terminalStateByThreadId = useTerminalStateStore((state) => state.terminalStateByThreadId);
  const clearTerminalState = useTerminalStateStore((state) => state.clearTerminalState);
  const openChatThreadPage = useTerminalStateStore((state) => state.openChatThreadPage);
  const openTerminalThreadPage = useTerminalStateStore((state) => state.openTerminalThreadPage);
  const clearProjectDraftThreads = useComposerDraftStore((store) => store.clearProjectDraftThreads);
  const draftThreadsByThreadId = useComposerDraftStore((store) => store.draftThreadsByThreadId);
  const persistedPinnedProjectIds = usePinnedProjectsStore((store) => store.pinnedProjectIds);
  const pinProjectLocally = usePinnedProjectsStore((store) => store.pinProject);
  const unpinProject = usePinnedProjectsStore((store) => store.unpinProject);
  const prunePinnedProjects = usePinnedProjectsStore((store) => store.prunePinnedProjects);
  const homeDir = useWorkspacePathsStore((store) => store.homeDir);
  const defaultProfileName = toDisplayName(
    (homeDir ?? "").split(/[\\/]/).findLast((segment) => segment.length > 0) ?? "",
  );
  const { name: profileName } = useProfileName(defaultProfileName);
  const chatWorkspaceRoot = useWorkspacePathsStore((store) => store.chatWorkspaceRoot);
  const studioWorkspaceRoot = useWorkspacePathsStore((store) => store.studioWorkspaceRoot);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const isOnSettings = useLocation({
    select: (loc) => loc.pathname === "/settings",
  });
  const isOnWorkspace = false;
  const { settings: appSettings } = useAppSettings();
  const { handleNewThread } = useHandleNewThread();
  const { handleNewChat } = useHandleNewChat();
  const routeThreadId = useParams({
    strict: false,
    select: (params) => (params.threadId ? ThreadId.makeUnsafe(params.threadId) : null),
  });
  const routeSearch = useChatRouteSearch();
  const activeSplitView = useSplitViewStore(
    useMemo(() => selectSplitView(routeSearch.splitViewId ?? null), [routeSearch.splitViewId]),
  );
  const splitViewsById = useSplitViewStore((store) => store.splitViewsById);

  useEffect(() => {
    const api = readNativeApi();
    if (!api || !threadsHydrated || projects.length > 0) {
      return;
    }

    let cancelled = false;
    // The sidebar is the visible empty-state owner. If startup hydrated empty
    // before the desktop projection caught up, ask the lightweight shell endpoint once.
    void api.orchestration
      .getShellSnapshot()
      .then((snapshot) => {
        if (
          cancelled ||
          (snapshot.spaces.length === 0 &&
            snapshot.projects.length === 0 &&
            snapshot.threads.length === 0)
        ) {
          return;
        }
        syncServerShellSnapshot(snapshot);
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [projects.length, syncServerShellSnapshot, threadsHydrated]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const canInstallConsoleCommand = shouldShowDebugFeatureFlagsMenu({
      isDev: import.meta.env.DEV,
      hostname: window.location.hostname,
      storageValue: "true",
    });
    if (!canInstallConsoleCommand) {
      return;
    }

    const debugWindow = window as DebugFeatureFlagsWindow;
    const updateVisibility = () => {
      setShowDebugFeatureFlagsMenu(readDebugFeatureFlagsMenuVisibility());
    };
    const showFeatureFlags = () => {
      window.localStorage.setItem(DEBUG_FEATURE_FLAGS_MENU_STORAGE_KEY, "true");
      updateVisibility();
    };
    const hideFeatureFlags = () => {
      window.localStorage.removeItem(DEBUG_FEATURE_FLAGS_MENU_STORAGE_KEY);
      updateVisibility();
    };

    debugWindow.penkraShowFeatureFlags = showFeatureFlags;
    debugWindow.penkraHideFeatureFlags = hideFeatureFlags;
    window.addEventListener("storage", updateVisibility);
    updateVisibility();

    return () => {
      window.removeEventListener("storage", updateVisibility);
      if (debugWindow.penkraShowFeatureFlags === showFeatureFlags) {
        delete debugWindow.penkraShowFeatureFlags;
      }
      if (debugWindow.penkraHideFeatureFlags === hideFeatureFlags) {
        delete debugWindow.penkraHideFeatureFlags;
      }
    };
  }, []);
  const setSplitFocusedPane = useSplitViewStore((store) => store.setFocusedPane);
  const { data: keybindings = EMPTY_KEYBINDINGS } = useQuery({
    ...serverConfigQueryOptions(),
    select: (config) => config.keybindings,
  });
  const { data: serverCwd = null } = useQuery({
    ...serverConfigQueryOptions(),
    select: (config) => config.cwd ?? null,
  });
  const { activeProjectId: focusedProjectId } = useFocusedChatContext();
  const latestProjectId = useLatestProjectStore((state) => state.latestProjectId);
  const [createProjectDialogOpen, setCreateProjectDialogOpen] = useState(false);
  const [searchPaletteOpen, setSearchPaletteOpen] = useState(false);
  const openFeedbackDialog = useFeedbackDialogStore((state) => state.openDialog);
  const [searchPaletteMode, setSearchPaletteMode] = useState<SidebarSearchPaletteMode>("search");
  const inlineRenameEditor = useSidebarInlineRenameStore((state) => state.editor);
  const cancelInlineRename = useSidebarInlineRenameStore((state) => state.cancel);
  const finishInlineRename = useSidebarInlineRenameStore((state) => state.finish);
  const startFolderInlineRename = useSidebarInlineRenameStore((state) => state.startFolder);
  const startThreadInlineRename = useSidebarInlineRenameStore((state) => state.startThread);
  const updateInlineRenameValue = useSidebarInlineRenameStore((state) => state.updateValue);
  // "Show more" paging state: extra pages of THREAD_PREVIEW_PAGE_SIZE rows per project cwd.
  const [threadListExtraPagesByProjectCwd, setThreadListExtraPagesByProjectCwd] = useState<
    ReadonlyMap<string, number>
  >(() => new Map(Object.entries(readSidebarUiState().projectThreadListExtraPagesByCwd)));
  const [collapsedSpaceIds, setCollapsedSpaceIds] = useState<ReadonlySet<string>>(
    () => new Set(readSidebarUiState().collapsedSpaceIds),
  );
  const [chatThreadListExtraPages, setChatThreadListExtraPages] = useState(
    () => readSidebarUiState().chatThreadListExtraPages,
  );
  const [dismissedThreadStatusKeyByThreadId, setDismissedThreadStatusKeyByThreadId] = useState<
    Record<string, string>
  >(() => readSidebarUiState().dismissedThreadStatusKeyByThreadId);
  const [lastThreadRoute, setLastThreadRoute] = useState(
    () => readSidebarUiState().lastThreadRoute,
  );
  const [optimisticActiveThreadId, setOptimisticActiveThreadId] = useState<ThreadId | null>(null);
  const optimisticPinnedStateByProjectIdRef = useRef(new Map<ContainerId, boolean>());
  const latestPinnedMutationVersionByProjectIdRef = useRef(new Map<ContainerId, number>());
  const [desktopUpdateState, setDesktopUpdateState] = useState<DesktopUpdateState | null>(null);
  const [installingDesktopUpdate, setInstallingDesktopUpdate] = useState(false);
  const [optimisticPinnedStateByProjectId, setOptimisticPinnedStateByProjectId] = useState<
    ReadonlyMap<ContainerId, boolean>
  >(() => new Map());
  // Dedupes the manual-download fallback toast so a single failure surfaced by
  // both the click handler and the install-watchdog push only notifies once.
  const lastDesktopUpdateErrorToastSignatureRef = useRef<string | null>(null);
  const selectedThreadIds = useThreadSelectionStore((s) => s.selectedThreadIds);
  const voiceRecordingThreadId = useVoiceSessionCoordinatorStore(
    (state) => state.capture?.origin.threadId ?? null,
  );
  const toggleThreadSelection = useThreadSelectionStore((s) => s.toggleThread);
  const rangeSelectTo = useThreadSelectionStore((s) => s.rangeSelectTo);
  const clearSelection = useThreadSelectionStore((s) => s.clearSelection);
  const removeFromSelection = useThreadSelectionStore((s) => s.removeFromSelection);
  const setSelectionAnchor = useThreadSelectionStore((s) => s.setAnchor);

  const routeActiveSidebarThreadId = routeThreadId;
  const activeSidebarThreadId = optimisticActiveThreadId ?? routeActiveSidebarThreadId;
  const visualActiveSidebarThreadId = optimisticActiveThreadId ?? routeThreadId;
  const selectSidebarThreads = useMemo(() => createSidebarThreadSummariesSelector(), []);
  const selectSidebarTreeThreads = useMemo(() => createSidebarTreeThreadsSelector(), []);
  const sidebarThreads = useStore(selectSidebarThreads);
  const sidebarTreeThreads = useStore(selectSidebarTreeThreads);
  const dismissThreadStatus = useCallback(
    (threadId: ThreadId, statusKey: string | null | undefined) => {
      if (!statusKey) {
        return;
      }
      setDismissedThreadStatusKeyByThreadId((current) => {
        if (current[threadId] === statusKey) {
          return current;
        }
        return {
          ...current,
          [threadId]: statusKey,
        };
      });
    },
    [],
  );
  const clearDismissedThreadStatus = useCallback((threadId: ThreadId) => {
    setDismissedThreadStatusKeyByThreadId((current) => {
      if (!(threadId in current)) {
        return current;
      }
      const next = { ...current };
      delete next[threadId];
      return next;
    });
  }, []);
  const resolveThreadStatusForSidebar = useCallback(
    (thread: SidebarThreadSummary) =>
      resolveThreadStatusPill({
        thread: {
          ...thread,
          dismissedStatusKey: dismissedThreadStatusKeyByThreadId[thread.id],
        },
        hasPendingApprovals: thread.hasPendingApprovals,
        hasPendingUserInput: thread.hasPendingUserInput,
      }),
    [dismissedThreadStatusKeyByThreadId],
  );

  useEffect(() => {
    if (!optimisticActiveThreadId) {
      return;
    }
    if (routeActiveSidebarThreadId === optimisticActiveThreadId) {
      // The route caught up; drop the optimistic override on the next tick. Async
      // setState keeps this out of render, and activeSidebarThreadId already resolves
      // to the same thread via `optimistic ?? route`, so the deferral is invisible.
      const settle = window.setTimeout(() => {
        setOptimisticActiveThreadId((current) =>
          current === optimisticActiveThreadId ? null : current,
        );
      }, 0);
      return () => window.clearTimeout(settle);
    }

    const timeout = window.setTimeout(() => {
      setOptimisticActiveThreadId((current) =>
        current === optimisticActiveThreadId ? null : current,
      );
    }, 1_500);
    return () => window.clearTimeout(timeout);
  }, [optimisticActiveThreadId, routeActiveSidebarThreadId]);

  const clearThreadNotification = useCallback(
    (threadId: ThreadId) => {
      const thread = sidebarThreadSummaryById[threadId];
      if (!thread) {
        return;
      }
      const threadStatus = resolveThreadStatusForSidebar(thread);
      if (!threadStatus?.dismissible) {
        return;
      }
      if (threadStatus.label === "Completed") {
        markThreadVisited(threadId, thread.latestTurn?.completedAt ?? undefined);
        return;
      }
      dismissThreadStatus(threadId, threadStatus.dismissalKey);
    },
    [
      dismissThreadStatus,
      markThreadVisited,
      resolveThreadStatusForSidebar,
      sidebarThreadSummaryById,
    ],
  );
  const routeTerminalState = routeThreadId
    ? selectThreadTerminalState(terminalStateByThreadId, routeThreadId)
    : null;
  const terminalOpen = routeTerminalState?.terminalOpen ?? false;
  const terminalWorkspaceOpen = shouldRenderTerminalWorkspace({
    presentationMode: routeTerminalState?.presentationMode ?? "drawer",
    terminalOpen,
  });
  const projectById = useMemo(
    () => new Map(projects.map((project) => [project.id, project] as const)),
    [projects],
  );
  const {
    pinnedThreadIds,
    pinnedThreadIdSet,
    toggleThreadPinned,
    deleteThread,
    confirmAndDeleteThread,
    archiveThread,
    confirmAndArchiveThread,
    archiveAllThreadsInProject,
    deleteProjectThreads,
  } = useSidebarThreadActions({
    activeSplitView,
    appSettings,
    clearTerminalState,
    handleNewChat,
    projectById,
    routeSplitViewId: routeSearch.splitViewId ?? null,
    routeThreadId,
    sidebarThreads,
    sidebarTreeThreads,
    sidebarThreadSummaryById,
    threadsHydrated,
  });
  const {
    projectRunsByProjectId,
    projectRunServerByProjectId,
    projectRunDialogProjectId,
    projectRunDialogProject,
    projectRunDialogExistingRun,
    projectRunDialogCommandDraft,
    setProjectRunDialogCommandDraft,
    projectRunDialogCommandIsValid,
    openProjectRunDialog,
    closeProjectRunDialog,
    handleConfirmProjectRun,
    handleStopProjectRun,
    handleOpenProjectRunServer,
  } = useSidebarProjectRunController({
    projects,
    projectById,
    homeDir,
    chatWorkspaceRoot,
  });
  const activeRouteProjectId = routeThreadId
    ? (sidebarThreadSummaryById[routeThreadId]?.projectId ??
      draftThreadsByThreadId[routeThreadId]?.projectId ??
      null)
    : null;
  const activeRouteProject = activeRouteProjectId
    ? (projectById.get(activeRouteProjectId) ?? null)
    : null;
  const ordinarySpaceProjects = useMemo(
    () =>
      projects.filter((project) =>
        isOrdinarySpaceProject(project, {
          homeDir,
          chatWorkspaceRoot,
          studioWorkspaceRoot,
        }),
      ),
    [chatWorkspaceRoot, homeDir, projects, studioWorkspaceRoot],
  );
  const folderNamesBySpaceId = useMemo(() => {
    const namesBySpaceId = new Map<SpaceId, string[]>();
    for (const project of ordinarySpaceProjects) {
      if (!project.spaceId) continue;
      const names = namesBySpaceId.get(project.spaceId) ?? [];
      names.push(project.name);
      if (project.remoteName !== project.name) names.push(project.remoteName);
      namesBySpaceId.set(project.spaceId, names);
    }
    return namesBySpaceId;
  }, [ordinarySpaceProjects]);

  const projectCwdById = useMemo(
    () => new Map(projects.map((project) => [project.id, project.cwd] as const)),
    [projects],
  );
  const projectByIdRef = useRef(projectById);
  useEffect(() => {
    projectByIdRef.current = projectById;
  }, [projectById]);
  const setOptimisticProjectPinned = useCallback((projectId: ContainerId, isPinned: boolean) => {
    optimisticPinnedStateByProjectIdRef.current.set(projectId, isPinned);
    setOptimisticPinnedStateByProjectId((current) => {
      if (current.get(projectId) === isPinned) {
        return current;
      }
      const next = new Map(current);
      next.set(projectId, isPinned);
      return next;
    });
  }, []);
  const clearOptimisticProjectPinned = useCallback((projectId: ContainerId) => {
    optimisticPinnedStateByProjectIdRef.current.delete(projectId);
    setOptimisticPinnedStateByProjectId((current) => {
      if (!current.has(projectId)) {
        return current;
      }
      const next = new Map(current);
      next.delete(projectId);
      return next;
    });
  }, []);
  const dispatchProjectPinnedState = useCallback(
    async (projectId: ContainerId, isPinned: boolean) => {
      const api = readNativeApi();
      if (!api) return;
      await api.orchestration.dispatchCommand({
        type: "project.meta.update",
        commandId: newCommandId(),
        projectId,
        isPinned,
      });
    },
    [],
  );
  const setProjectPinned = useCallback(
    async (projectId: ContainerId, isPinned: boolean) => {
      const api = readNativeApi();
      if (!api) return;
      const project = projectByIdRef.current.get(projectId);
      if (!project || project.kind !== "project") {
        return;
      }
      const requestVersion =
        (latestPinnedMutationVersionByProjectIdRef.current.get(projectId) ?? 0) + 1;
      latestPinnedMutationVersionByProjectIdRef.current.set(projectId, requestVersion);

      setOptimisticProjectPinned(projectId, isPinned);
      if (isPinned) {
        const accepted = pinProjectLocally(projectId);
        if (!accepted) {
          clearOptimisticProjectPinned(projectId);
          toastManager.add({
            type: "warning",
            title: "Folder pin limit reached",
            description: `You can pin up to ${MAX_PINNED_PROJECTS} folders.`,
          });
          return;
        }
      } else {
        unpinProject(projectId);
      }

      try {
        await dispatchProjectPinnedState(projectId, isPinned);
      } catch (error) {
        if (
          !isLatestPinnedProjectMutation({
            projectId,
            requestVersion,
            latestMutationVersionByProjectId: latestPinnedMutationVersionByProjectIdRef.current,
          })
        ) {
          return;
        }

        const confirmedPinned = projectByIdRef.current.get(projectId)?.isPinned === true;
        if (confirmedPinned) {
          pinProjectLocally(projectId);
        } else {
          unpinProject(projectId);
        }
        clearOptimisticProjectPinned(projectId);
        throw error;
      }
    },
    [
      clearOptimisticProjectPinned,
      dispatchProjectPinnedState,
      pinProjectLocally,
      setOptimisticProjectPinned,
      unpinProject,
    ],
  );
  const toggleProjectPinned = useCallback(
    (projectId: ContainerId) => {
      const optimisticPinned = optimisticPinnedStateByProjectIdRef.current.get(projectId);
      const locallyPinned = usePinnedProjectsStore.getState().pinnedProjectIds.includes(projectId);
      const serverPinned = projectByIdRef.current.get(projectId)?.isPinned === true;
      const isPinned = optimisticPinned ?? (locallyPinned || serverPinned);
      void setProjectPinned(projectId, !isPinned).catch((error) => {
        console.error("Failed to update pinned project state", {
          projectId,
          error,
        });
        toastManager.add({
          type: "error",
          title: isPinned ? "Unable to unpin folder" : "Unable to pin folder",
          description: error instanceof Error ? error.message : undefined,
        });
      });
    },
    [setProjectPinned],
  );
  useEffect(() => {
    if (optimisticPinnedStateByProjectId.size === 0) {
      return;
    }

    const serverPinnedStateByProjectId = new Map(
      projects.map((project) => [project.id, project.isPinned === true] as const),
    );
    // Reconciliation drops optimistic entries the server has confirmed while syncing
    // the mirror ref. Deferring the setState off render (async is allowed) leaves the
    // derived pinned lists unchanged, since a confirmed entry is redundant either way.
    const settle = window.setTimeout(() => {
      setOptimisticPinnedStateByProjectId((current) => {
        const reconciled = reconcileOptimisticPinState({
          optimisticPinnedStateById: current,
          serverPinnedStateById: serverPinnedStateByProjectId,
        });
        for (const projectId of reconciled.settledIds) {
          optimisticPinnedStateByProjectIdRef.current.delete(projectId);
        }
        return reconciled.optimisticPinnedStateById;
      });
    }, 0);
    return () => window.clearTimeout(settle);
  }, [optimisticPinnedStateByProjectId, projects]);
  const focusMostRecentThreadForProject = useCallback(
    (projectId: ContainerId) => {
      const latestThread = sortThreadsForSidebar(
        sidebarThreads.filter((thread) => thread.projectId === projectId),
        appSettings.sidebarThreadSortOrder,
      )[0];
      if (!latestThread) return;

      void navigate({
        to: "/$threadId",
        params: { threadId: latestThread.id },
      });
    },
    [appSettings.sidebarThreadSortOrder, navigate, sidebarThreads],
  );

  // Poll the server read model briefly after project.create so we only recover from fresh state.
  const waitForProjectInSnapshot = useCallback(
    async (
      api: NonNullable<ReturnType<typeof readNativeApi>>,
      projectId: ContainerId,
    ): Promise<{
      project: OrchestrationShellSnapshot["projects"][number] | null;
      snapshot: OrchestrationShellSnapshot | null;
    }> =>
      waitForRecoverableProjectInReadModel({
        projectId,
        loadSnapshot: () => api.orchestration.getShellSnapshot().catch(() => null),
        maxAttempts: ADD_PROJECT_SNAPSHOT_CATCH_UP_MAX_ATTEMPTS,
        delayMs: ADD_PROJECT_SNAPSHOT_CATCH_UP_DELAY_MS,
      }),
    [],
  );

  const handleOpenProjectFromSearch = useCallback(
    (projectId: string) => {
      const typedProjectId = ContainerId.makeUnsafe(projectId);
      const hasProjectThread = sidebarThreads.some((thread) => thread.projectId === typedProjectId);
      if (hasProjectThread) {
        focusMostRecentThreadForProject(typedProjectId);
        return;
      }

      void handleNewThread(typedProjectId);
    },
    [focusMostRecentThreadForProject, handleNewThread, sidebarThreads],
  );

  useEffect(() => {
    if (!threadsHydrated || !homeDir) {
      return;
    }
    prewarmHomeChatProject({ homeDir, chatWorkspaceRoot });
  }, [chatWorkspaceRoot, homeDir, threadsHydrated]);

  // Opens a fresh home-chat draft directly on the draft thread route so the first send
  // does not need a second route swap from "/" to "/$threadId".
  const handleCreateHomeChat = useCallback(
    async (spaceId: SpaceId) => {
      await handleNewChat({ fresh: true, spaceId });
    },
    [handleNewChat],
  );

  const handleStartAddProject = useCallback(() => {
    setCreateProjectDialogOpen(true);
  }, []);

  const activeSpaceProjects = useMemo(
    () => ordinarySpaceProjects.filter((project) => (project.spaceId ?? null) === activeSpaceId),
    [activeSpaceId, ordinarySpaceProjects],
  );
  const currentProjectShortcutTargetId = useMemo(
    () => resolveCurrentProjectTargetId(activeSpaceProjects, focusedProjectId),
    [activeSpaceProjects, focusedProjectId],
  );
  const latestUsableProjectId = useMemo(
    () => resolveLatestProjectTargetIdWithFallback(activeSpaceProjects, latestProjectId),
    [activeSpaceProjects, latestProjectId],
  );
  const primaryNewThreadTarget = useMemo(
    () =>
      resolveNewThreadTarget({
        currentProjectId: currentProjectShortcutTargetId,
        latestUsableProjectId,
      }),
    [currentProjectShortcutTargetId, latestUsableProjectId],
  );

  // Warm model discovery before ChatView mounts so new-thread composers skip
  // the "Loading models" skeleton when React Query already has a fresh cache hit.
  const prefetchModelsForProjectNewThread = useCallback(
    (projectId: ContainerId, options?: { includeDroid?: boolean }) => {
      const project = projects.find((candidate) => candidate.id === projectId);
      if (!project) {
        return;
      }

      const draftStore = useComposerDraftStore.getState();
      const draftThread = draftStore.getDraftThreadByProjectId(projectId, "chat");
      const draftComposer = draftThread
        ? (draftStore.draftsByThreadId[draftThread.threadId] ?? null)
        : null;
      const provider = resolveNewThreadModelPrefetchProvider({
        draftActiveProvider: draftComposer?.activeProvider ?? null,
        stickyActiveProvider: draftStore.stickyActiveProvider,
        projectDefaultProvider: project.defaultModelSelection?.provider ?? null,
        defaultProvider: appSettings.defaultProvider,
      });
      // Droid discovery spins a disposable ACP session per model — only warm it
      // from explicit new-thread intent (hover/click), not idle project focus.
      if (provider === "droid" && options?.includeDroid !== true) {
        return;
      }
      const cwd = resolveNewThreadModelPrefetchCwd({
        draftWorktreePath: draftThread?.worktreePath ?? null,
        draftWorkingDirectory: draftThread?.workingDirectory ?? null,
        projectCwd: project.cwd,
        serverCwd,
      });

      prefetchProviderModelsForNewThread(queryClient, {
        provider,
        settings: appSettings,
        cwd,
      });
    },
    [appSettings, projects, queryClient, serverCwd],
  );

  useEffect(() => {
    if (!primaryNewThreadTarget) {
      return;
    }
    prefetchModelsForProjectNewThread(primaryNewThreadTarget.projectId);
  }, [prefetchModelsForProjectNewThread, primaryNewThreadTarget]);

  const handlePrimaryNewThread = useCallback(() => {
    if (primaryNewThreadTarget) {
      prefetchModelsForProjectNewThread(primaryNewThreadTarget.projectId, {
        includeDroid: true,
      });
      void handleNewThread(primaryNewThreadTarget.projectId);
      return;
    }

    // The projects snapshot can be temporarily empty during startup. Wait for hydration
    // before treating a missing target as a genuine no-project state.
    if (!threadsHydrated) {
      return;
    }
    handleStartAddProject();
  }, [
    handleNewThread,
    handleStartAddProject,
    prefetchModelsForProjectNewThread,
    primaryNewThreadTarget,
    threadsHydrated,
  ]);

  const handleImportThread = useCallback(
    async (provider: ImportProviderKind, externalId: string) => {
      const api = readNativeApi();
      if (!api) {
        throw new Error("The app server is unavailable.");
      }

      if (!currentProjectShortcutTargetId) {
        throw new Error("Add a folder before importing a thread.");
      }

      const activeProject = projects.find(
        (project) => project.id === currentProjectShortcutTargetId,
      );
      if (!activeProject) {
        throw new Error("The target folder could not be resolved.");
      }

      const providerDefaultModel = getDefaultModel(provider);
      const modelSelection =
        activeProject.defaultModelSelection?.provider === provider
          ? activeProject.defaultModelSelection
          : providerDefaultModel
            ? {
                provider,
                model: providerDefaultModel,
              }
            : null;
      if (!modelSelection) {
        throw new Error("Select a Pi model before importing a Pi thread.");
      }
      const threadId = newThreadId();
      const createdAt = new Date().toISOString();
      const trimmedExternalId = externalId.trim();
      const suffix = trimmedExternalId.slice(-8);
      const title =
        provider === "claudeAgent"
          ? `Imported Claude session${suffix ? ` ${suffix}` : ""}`
          : provider === "cursor"
            ? `Imported Cursor session${suffix ? ` ${suffix}` : ""}`
            : provider === "kilo"
              ? `Imported Kilo session${suffix ? ` ${suffix}` : ""}`
              : provider === "opencode"
                ? `Imported OpenCode session${suffix ? ` ${suffix}` : ""}`
                : `Imported Codex thread${suffix ? ` ${suffix}` : ""}`;
      let createdThread = false;

      try {
        await api.orchestration.dispatchCommand({
          type: "thread.create",
          commandId: newCommandId(),
          threadId,
          projectId: activeProject.id,
          title,
          modelSelection,
          runtimeMode: "full-access",
          envMode: "local",
          branch: null,
          worktreePath: null,
          createdAt,
        });
        createdThread = true;

        await api.orchestration.importThread({
          threadId,
          externalId: trimmedExternalId,
        });

        await navigate({
          to: "/$threadId",
          params: { threadId },
        });
      } catch (error) {
        if (createdThread) {
          await api.orchestration
            .dispatchCommand({
              type: "thread.delete",
              commandId: newCommandId(),
              threadId,
            })
            .catch(() => undefined);
        }
        throw error;
      }
    },
    [currentProjectShortcutTargetId, navigate, projects],
  );

  const commitRename = useCallback(
    async (threadId: ThreadId, newTitle: string, originalTitle: string) => {
      const outcome = await dispatchThreadRename({
        threadId,
        newTitle,
        unchangedTitles: [originalTitle],
      });
      if (outcome === "empty") {
        throw new Error("Thread title cannot be empty.");
      }
      if (outcome === "unavailable") {
        throw new Error("Thread rename is unavailable while disconnected.");
      }
    },
    [],
  );

  const openThreadInlineRename = useCallback(
    (threadId: ThreadId) => {
      const thread = sidebarThreadSummaryById[threadId];
      if (thread) startThreadInlineRename(threadId, thread.title);
    },
    [sidebarThreadSummaryById, startThreadInlineRename],
  );

  const commitFolderRename = useCallback(async (projectId: ContainerId, title: string) => {
    const api = readNativeApi();
    if (!api) {
      throw new Error("Folder rename is unavailable while disconnected.");
    }
    await api.orchestration.dispatchCommand({
      type: "project.meta.update",
      commandId: newCommandId(),
      projectId,
      title,
    });
  }, []);

  const { prewarmThreadDetail: prewarmThreadDetailForIntent } = useThreadDetailPrewarm();

  const primeThreadActivation = useCallback(
    (event: ReactPointerEvent<HTMLElement>, threadId: ThreadId) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return;
      }
      prewarmThreadDetailForIntent(threadId);
      setOptimisticActiveThreadId(threadId);
    },
    [prewarmThreadDetailForIntent],
  );

  const copyThreadIdToClipboard = useCopyThreadIdToClipboard();
  const copyPathToClipboard = useCopyPathToClipboard();
  const handleThreadContextMenu = useCallback(
    async (
      threadId: ThreadId,
      position: { x: number; y: number },
      options?: {
        extraItems?: Array<{
          id: "return-to-single-chat";
          label: string;
        }>;
        onExtraAction?: (itemId: "return-to-single-chat") => Promise<void> | void;
      },
    ) => {
      const api = readNativeApi();
      if (!api) return;
      const thread = getThreadFromState(useStore.getState(), threadId);
      if (!thread) return;
      const threadSummary = sidebarThreadSummaryById[threadId];
      const isPinned = pinnedThreadIdSet.has(threadId);
      const threadStatus = threadSummary ? resolveThreadStatusForSidebar(threadSummary) : null;
      const threadWorkspacePath = resolveThreadWorkspaceCwd({
        projectCwd: projectCwdById.get(thread.projectId) ?? null,
        envMode: thread.envMode,
        worktreePath: thread.worktreePath,
      });
      const clicked = await api.contextMenu.show(
        [
          { id: "rename", label: "Rename thread" },
          { id: "toggle-pin", label: pinActionLabel("thread", isPinned) },
          ...(threadStatus?.dismissible
            ? [{ id: "clear-notification", label: "Clear notification" }]
            : []),
          { id: "mark-unread", label: "Mark unread" },
          { id: "copy-path", label: "Copy Path", separatorBefore: true },
          { id: "copy-thread-id", label: "Copy Thread ID" },
          ...(options?.extraItems ?? []),
          { id: "archive", label: "Archive", separatorBefore: true },
          { id: "delete", label: "Delete", destructive: true },
        ],
        position,
      );

      if (clicked === "rename") {
        openThreadInlineRename(threadId);
        return;
      }
      if (clicked === "toggle-pin") {
        toggleThreadPinned(threadId);
        return;
      }

      if (clicked === "mark-unread") {
        clearDismissedThreadStatus(threadId);
        markThreadUnread(threadId);
        return;
      }
      if (clicked === "clear-notification") {
        clearThreadNotification(threadId);
        return;
      }
      if (clicked === "copy-path") {
        if (!threadWorkspacePath) {
          toastManager.add({
            type: "error",
            title: "Path unavailable",
            description: "This thread does not have a workspace path to copy.",
          });
          return;
        }
        copyPathToClipboard(threadWorkspacePath);
        return;
      }
      if (clicked === "copy-thread-id") {
        copyThreadIdToClipboard(threadId);
        return;
      }
      if (clicked === "return-to-single-chat") {
        await options?.onExtraAction?.("return-to-single-chat");
        return;
      }
      if (clicked === "archive") {
        await confirmAndArchiveThread(threadId);
        return;
      }
      if (clicked !== "delete") return;
      await confirmAndDeleteThread(threadId);
    },
    [
      confirmAndArchiveThread,
      confirmAndDeleteThread,
      copyPathToClipboard,
      copyThreadIdToClipboard,
      clearDismissedThreadStatus,
      clearThreadNotification,
      markThreadUnread,
      openThreadInlineRename,
      pinnedThreadIdSet,
      projectCwdById,
      resolveThreadStatusForSidebar,
      sidebarThreadSummaryById,
      toggleThreadPinned,
    ],
  );
  const handleMultiSelectContextMenu = useCallback(
    async (position: { x: number; y: number }) => {
      const api = readNativeApi();
      if (!api) return;
      const ids = [...selectedThreadIds];
      if (ids.length === 0) return;
      const count = ids.length;

      const clicked = await api.contextMenu.show(
        [
          { id: "mark-unread", label: `Mark unread (${count})` },
          { id: "archive", label: `Archive (${count})` },
          { id: "delete", label: `Delete (${count})`, destructive: true },
        ],
        position,
      );

      if (clicked === "mark-unread") {
        for (const id of ids) {
          clearDismissedThreadStatus(id);
          markThreadUnread(id);
        }
        clearSelection();
        return;
      }

      if (clicked === "archive") {
        if (appSettings.confirmThreadArchive) {
          const confirmed = await api.dialogs.confirm(
            [
              `Archive ${count} ${pluralize(count, "thread")}?`,
              "Archived threads are hidden from the sidebar but can be restored later.",
            ].join("\n"),
          );
          if (!confirmed) return;
        }

        for (const id of ids) {
          await archiveThread(id);
        }
        removeFromSelection(ids);
        return;
      }

      if (clicked !== "delete") return;

      if (appSettings.confirmThreadDelete) {
        const confirmed = await api.dialogs.confirm(
          [
            `Delete ${count} ${pluralize(count, "thread")}?`,
            "This permanently clears conversation history for these threads.",
          ].join("\n"),
        );
        if (!confirmed) return;
      }

      const deletedIds = new Set<ThreadId>(ids);
      const successfullyDeletedIds: ThreadId[] = [];
      const runDeletes = async (): Promise<void> => {
        for (const id of ids) {
          await deleteThread(id, {
            deletedThreadIds: deletedIds,
            reconcileDeletedThread: false,
          });
          successfullyDeletedIds.push(id);
        }
      };
      await runDeletes().finally(() => {
        if (successfullyDeletedIds.length > 0) {
          void reconcileDeletedThreadsFromClient({
            threadIds: successfullyDeletedIds,
            removeDeletedThreadFromClientState:
              useStore.getState().removeDeletedThreadFromClientState,
          });
        }
      });
      removeFromSelection(ids);
    },
    [
      appSettings.confirmThreadArchive,
      appSettings.confirmThreadDelete,
      archiveThread,
      clearSelection,
      clearDismissedThreadStatus,
      deleteThread,
      markThreadUnread,
      removeFromSelection,
      selectedThreadIds,
    ],
  );

  const rememberLastThreadRouteNow = useCallback(
    (nextLastThreadRoute: LastThreadRoute) => {
      setLastThreadRoute(nextLastThreadRoute);
      persistSidebarUiState({
        collapsedSpaceIds: [...collapsedSpaceIds],
        chatThreadListExtraPages,
        projectThreadListExtraPagesByCwd: Object.fromEntries(threadListExtraPagesByProjectCwd),
        dismissedThreadStatusKeyByThreadId,
        lastThreadRoute: nextLastThreadRoute,
      });
    },
    [
      collapsedSpaceIds,
      chatThreadListExtraPages,
      dismissedThreadStatusKeyByThreadId,
      threadListExtraPagesByProjectCwd,
    ],
  );
  const { activateThreadFromSidebarIntent } = useThreadActivationController({
    activeSplitView,
    clearSelection,
    navigate,
    openChatThreadPage,
    openTerminalThreadPage,
    prewarmThreadDetailForIntent,
    rememberLastThreadRouteNow,
    routeSplitViewId: routeSearch.splitViewId,
    routeThreadId,
    selectedThreadCount: selectedThreadIds.size,
    setOptimisticActiveThreadId,
    setSelectionAnchor,
    setSplitFocusedPane,
    sidebarThreadSummaryById,
    splitViewsById,
    terminalStateByThreadId,
  });

  const {
    editedSpace,
    spaceEditorOpen,
    spaceEditorMode,
    spaceEditorExistingNames,
    openSpaceCreator,
    openSpaceEditor,
    closeSpaceEditor,
    handleSelectSpace,
    handleSelectSpaceForIncomingProject,
    handleReorderSpaces,
    handleMoveProjectToSpace,
    handleSpaceEditorSubmit,
  } = useSpacesController({
    ordinarySpaceProjects,
    projectById,
    sidebarThreads,
    sidebarThreadSortOrder: appSettings.sidebarThreadSortOrder,
    routeThreadId,
    activeRouteProject,
    activeRouteProjectId,
    activateThreadFromSidebarIntent,
  });

  useEffect(
    () =>
      subscribeToSpaceUiActions((action) => {
        if (action.type === "create") {
          openSpaceCreator();
          return;
        }
        if (action.type === "rename") {
          openSpaceEditor(action.spaceId);
          return;
        }
        handleSelectSpace(action.spaceId);
      }),
    [handleSelectSpace, openSpaceCreator, openSpaceEditor],
  );

  useEffect(() => {
    void window.desktopBridge?.setSpacesMenu?.({
      activeSpaceId,
      spaces: spaces.map((space) => ({ id: space.id, name: space.name })),
    });
  }, [activeSpaceId, spaces]);

  useEffect(() => {
    const onMenuAction = window.desktopBridge?.onMenuAction;
    if (typeof onMenuAction !== "function") return;
    return onMenuAction((action) => {
      if (action === "space:new") {
        openSpaceCreator();
        return;
      }
      if (action === "space:manage") {
        void navigate({ to: "/settings", search: { section: "spaces" } });
        return;
      }
      if (!action.startsWith("space:focus:")) return;
      const spaceId = action.slice("space:focus:".length);
      if (!spaces.some((space) => space.id === spaceId)) return;
      handleSelectSpace(SpaceId.makeUnsafe(spaceId));
    });
  }, [handleSelectSpace, navigate, openSpaceCreator, spaces]);

  const handleSpaceHeaderContextMenu = useCallback(
    async (event: MouseEvent<HTMLButtonElement>, space: Space) => {
      event.preventDefault();
      const api = readNativeApi();
      if (!api) return;
      const expanded = !collapsedSpaceIds.has(space.id);
      const clicked = await api.contextMenu.show(
        [
          { id: "new-thread", label: `New thread in ${space.name}` },
          { id: "add-folder", label: `Add folder to ${space.name}` },
          { id: "rename", label: "Rename space", separatorBefore: true },
          {
            id: "toggle-expanded",
            label: expanded ? "Collapse space" : "Expand space",
          },
          { id: "archive", label: "Archive space", separatorBefore: true },
        ],
        { x: event.clientX, y: event.clientY },
      );
      if (clicked === "new-thread") {
        handleSelectSpace(space.id);
        await handleCreateHomeChat(space.id);
        return;
      }
      if (clicked === "add-folder") {
        handleSelectSpace(space.id);
        setCreateProjectDialogOpen(true);
        return;
      }
      if (clicked === "rename") {
        openSpaceEditor(space.id);
        return;
      }
      if (clicked === "archive") {
        await archiveSpace({ api, spaceId: space.id });
        return;
      }
      if (clicked === "toggle-expanded") {
        setCollapsedSpaceIds((current) => {
          const next = new Set(current);
          if (expanded) next.add(space.id);
          else next.delete(space.id);
          return next;
        });
      }
    },
    [collapsedSpaceIds, handleCreateHomeChat, handleSelectSpace, openSpaceEditor],
  );
  const handleCreateProjectSubmit = useCallback(
    async (value: CreateProjectSubmitValue) => {
      const previousSpaceId = activeSpaceId;
      const api = readNativeApi();
      if (!api) throw new Error("The app server is unavailable.");
      const projectId = newProjectId();
      handleSelectSpaceForIncomingProject(value.spaceId);
      try {
        await api.orchestration.dispatchCommand({
          type: "project.create",
          commandId: newCommandId(),
          projectId,
          kind: "project",
          title: value.name,
          workspaceRoot: null,
          defaultModelSelection: {
            provider: "codex",
            model: getDefaultModel("codex"),
          },
          spaceId: value.spaceId,
          createdAt: new Date().toISOString(),
        });
        const { project, snapshot } = await waitForProjectInSnapshot(api, projectId);
        if (snapshot) syncServerShellSnapshot(snapshot);
        if (!project) throw new Error("The folder was created but has not synced yet.");
        setProjectExpanded(projectId, true);
        await handleNewThread(projectId, { fresh: true, envMode: "local" });
      } catch (error) {
        if (previousSpaceId) handleSelectSpaceForIncomingProject(previousSpaceId);
        throw error;
      }
    },
    [
      activeSpaceId,
      handleNewThread,
      handleSelectSpaceForIncomingProject,
      setProjectExpanded,
      syncServerShellSnapshot,
      waitForProjectInSnapshot,
    ],
  );
  const handleProjectContextMenuAction = useCallback(
    async (projectId: ContainerId, clicked: ProjectContextMenuId) => {
      const api = readNativeApi();
      if (!api) return;
      const project = projectById.get(projectId);
      if (!project) return;
      const physicalPath =
        sidebarThreads
          .filter((thread) => thread.projectId === projectId && Boolean(thread.workingDirectory))
          .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt))[0]
          ?.workingDirectory?.trim() ||
        project.cwd ||
        null;

      if (clicked === "open-in-finder") {
        if (!physicalPath) return;
        try {
          await api.shell.showInFolder(physicalPath);
        } catch (error) {
          toastManager.add({
            type: "error",
            title: "Unable to open in Finder",
            description:
              error instanceof Error
                ? error.message
                : "An unknown error occurred opening the folder.",
          });
        }
        return;
      }
      if (clicked === "copy-path") {
        if (physicalPath) copyPathToClipboard(physicalPath);
        return;
      }
      if (clicked === "start-dev") {
        openProjectRunDialog(projectId);
        return;
      }
      if (clicked === "stop-dev") {
        await handleStopProjectRun(projectId);
        return;
      }
      if (clicked === "open-dev-server") {
        await handleOpenProjectRunServer(projectId);
        return;
      }
      if (clicked === "rename") {
        startFolderInlineRename(projectId, project.name);
        return;
      }
      if (clicked === "toggle-pin") {
        toggleProjectPinned(projectId);
        return;
      }
      if (clicked === "archive-threads") {
        await archiveAllThreadsInProject(projectId);
        return;
      }
      if (clicked === "delete-threads") {
        await deleteProjectThreads(projectId);
        return;
      }
      if (clicked !== "delete") return;

      const projectThreads = sidebarThreads.filter((thread) => thread.projectId === projectId);
      const confirmed = await api.dialogs.confirm(
        projectThreads.length > 0
          ? [
              `Remove folder "${project.name}"?`,
              `This will delete ${projectThreads.length} ${pluralize(projectThreads.length, "thread")} in this folder and remove the folder.`,
            ].join("\n")
          : `Remove folder "${project.name}"?`,
      );
      if (!confirmed) return;

      try {
        // `project.delete` refuses non-empty folders, so `Remove` clears threads first.
        const deletionResult = await deleteProjectThreads(projectId, {
          confirmMessage: null,
          showEmptyToast: false,
          showResultToast: false,
          worktreeCleanupMode: "skip",
        });
        if (deletionResult === null) {
          return;
        }
        if (deletionResult.failureCount > 0) {
          toastManager.add({
            type: "error",
            title: `Failed to remove "${project.name}"`,
            description: `Could not delete ${deletionResult.failureCount} ${pluralize(deletionResult.failureCount, "thread")} in "${project.name}".`,
          });
          return;
        }

        await deleteProjectFromClient({
          api: api.orchestration,
          projectId,
          removeDeletedProjectFromClientState,
        });
        clearProjectDraftThreads(projectId);
        toastManager.add({
          type: "success",
          title: `Removed "${project.name}"`,
          description:
            deletionResult.deletedCount > 0
              ? `Deleted ${deletionResult.deletedCount} ${pluralize(deletionResult.deletedCount, "thread")} and removed the folder.`
              : "Folder removed.",
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error removing folder.";
        console.error("Failed to remove project", { projectId, error });
        toastManager.add({
          type: "error",
          title: `Failed to remove "${project.name}"`,
          description: message,
        });
      }
    },
    [
      archiveAllThreadsInProject,
      clearProjectDraftThreads,
      copyPathToClipboard,
      deleteProjectThreads,
      handleOpenProjectRunServer,
      handleStopProjectRun,
      openProjectRunDialog,
      projectById,
      removeDeletedProjectFromClientState,
      sidebarThreads,
      startFolderInlineRename,
      toggleProjectPinned,
    ],
  );

  async function handleProjectContextMenu(
    projectId: ContainerId,
    position: { x: number; y: number },
  ) {
    const api = readNativeApi();
    const project = projectById.get(projectId);
    if (!api || !project) return;

    const projectThreads = sidebarThreads.filter((thread) => thread.projectId === projectId);
    const physicalPath =
      projectThreads
        .filter((thread) => Boolean(thread.workingDirectory))
        .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt))[0]
        ?.workingDirectory?.trim() ||
      project.cwd ||
      null;
    const isPinned = pinnedProjectIdSet.has(projectId);
    const isRunning = Boolean(projectRunsByProjectId[projectId]);
    const projectRunServer = projectRunServerByProjectId.get(projectId) ?? null;
    const hasOpenServer =
      projectRunServer !== null && firstLocalServerUrl(projectRunServer) !== null;
    const hasAnyThreads = projectThreads.length > 0;
    const hasArchivableThreads = projectThreads.some((thread) => thread.archivedAt == null);
    const moveTargets = spaces.filter((space) => space.id !== project.spaceId);
    const items: Array<{
      id: ProjectNativeContextMenuId;
      label: string;
      separatorBefore?: boolean;
      destructive?: boolean;
    }> = [];

    if (physicalPath) {
      items.push(
        { id: "open-in-finder", label: "Open in Finder" },
        { id: "copy-path", label: "Copy Path" },
      );
    }
    if (project.cwd) {
      items.push({
        id: isRunning ? "stop-dev" : "start-dev",
        label: isRunning ? "Stop dev" : "Start dev",
        separatorBefore: physicalPath !== null,
      });
      if (hasOpenServer) {
        items.push({ id: "open-dev-server", label: "Open dev server" });
      }
    }
    moveTargets.forEach((space, index) => {
      items.push({
        id: `${MOVE_PROJECT_TO_SPACE_CONTEXT_MENU_PREFIX}${space.id}`,
        label: `Move to ${space.name}`,
        separatorBefore: index === 0,
      });
    });
    items.push({
      id: "new-space",
      label: "New space…",
      separatorBefore: moveTargets.length === 0,
    });
    items.push(
      { id: "rename", label: "Edit name", separatorBefore: true },
      { id: "toggle-pin", label: pinActionLabel("folder", isPinned) },
    );
    if (hasArchivableThreads) {
      items.push({ id: "archive-threads", label: "Archive threads", separatorBefore: true });
    }
    if (hasAnyThreads) {
      items.push({
        id: "delete-threads",
        label: "Delete threads",
        separatorBefore: !hasArchivableThreads,
        destructive: true,
      });
    }
    items.push({ id: "delete", label: "Remove", destructive: true });

    const clicked = await api.contextMenu.show<ProjectNativeContextMenuId>(items, position);
    if (!clicked) return;
    if (clicked === "new-space") {
      openSpaceCreator(projectId);
      return;
    }
    if (isMoveProjectToSpaceContextMenuId(clicked)) {
      const spaceId = clicked.slice(MOVE_PROJECT_TO_SPACE_CONTEXT_MENU_PREFIX.length);
      if (spaces.some((space) => space.id === spaceId)) {
        await handleMoveProjectToSpace(projectId, SpaceId.makeUnsafe(spaceId));
      }
      return;
    }
    await handleProjectContextMenuAction(projectId, clicked);
  }

  // Trees need child (subagent) threads too; the flat display list stays
  // root-only for pinned rows and other non-tree consumers.
  const sidebarThreadsByProjectId = useMemo(
    () => groupSidebarThreadsByProjectId(sidebarTreeThreads),
    [sidebarTreeThreads],
  );
  const sortedSidebarThreadsByProjectId = useMemo(() => {
    const byProjectId = new Map<ContainerId, SidebarThreadSummary[]>();
    for (const [projectId, projectThreads] of sidebarThreadsByProjectId) {
      byProjectId.set(
        projectId,
        sortThreadsForSidebar(projectThreads, appSettings.sidebarThreadSortOrder),
      );
    }
    return byProjectId;
  }, [appSettings.sidebarThreadSortOrder, sidebarThreadsByProjectId]);
  const sortedProjects = useMemo(
    () => sortProjectsForSidebar(projects, sidebarThreads, appSettings.sidebarProjectSortOrder),
    [appSettings.sidebarProjectSortOrder, projects, sidebarThreads],
  );
  const chatProjects = useMemo(
    () =>
      sortedProjects.filter((project) =>
        isHomeChatContainerProject(project, { homeDir, chatWorkspaceRoot }),
      ),
    [chatWorkspaceRoot, homeDir, sortedProjects],
  );
  const visibleChatThreadRows = useMemo(() => {
    return buildProjectThreadTree({
      threads: sortThreadsForSidebar(
        chatProjects.flatMap((project) => sortedSidebarThreadsByProjectId.get(project.id) ?? []),
        appSettings.sidebarThreadSortOrder,
      ),
      forceVisibleThreadId: activeSidebarThreadId ?? undefined,
      pinnedThreadIds,
    });
  }, [
    activeSidebarThreadId,
    appSettings.sidebarThreadSortOrder,
    chatProjects,
    pinnedThreadIds,
    sortedSidebarThreadsByProjectId,
  ]);
  const visibleChatOrderedThreadIds = useMemo(
    () => visibleChatThreadRows.map((row) => row.thread.id),
    [visibleChatThreadRows],
  );
  const visibleChatPreviewEntries = useMemo(
    () =>
      visibleChatThreadRows.map((row) => ({
        rowId: row.thread.id,
        rootRowId: row.rootThreadId,
        row,
      })),
    [visibleChatThreadRows],
  );
  const allStandardProjectsBase = useMemo(
    () =>
      sortedProjects.filter((project) =>
        isOrdinarySpaceProject(project, {
          homeDir,
          chatWorkspaceRoot,
          studioWorkspaceRoot,
        }),
      ),
    [chatWorkspaceRoot, homeDir, sortedProjects, studioWorkspaceRoot],
  );
  const standardProjectsBase = useMemo(() => allStandardProjectsBase, [allStandardProjectsBase]);
  const pinnedProjectIds = useMemo(
    () =>
      derivePinnedProjectIdsForSidebar({
        projects: standardProjectsBase,
        persistedPinnedProjectIds,
        optimisticPinnedStateByProjectId,
      }),
    [optimisticPinnedStateByProjectId, persistedPinnedProjectIds, standardProjectsBase],
  );
  const pinnedProjectIdSet = useMemo(() => new Set(pinnedProjectIds), [pinnedProjectIds]);
  const standardProjects = useMemo(
    () => orderPinnedProjectsForSidebar(standardProjectsBase, pinnedProjectIds),
    [pinnedProjectIds, standardProjectsBase],
  );
  const sidebarSpaceSections = useMemo(() => {
    const buildChatData = (spaceId: SpaceId) => {
      const entries = visibleChatPreviewEntries.filter(
        (entry) => entry.row.thread.spaceId === spaceId,
      );
      const activeEntry =
        activeSidebarThreadId === undefined
          ? null
          : (entries.find((entry) => entry.rowId === activeSidebarThreadId) ?? null);
      const paging = resolveSidebarThreadListPaging({
        totalCount: entries.length,
        baseLimit: THREAD_PREVIEW_LIMIT,
        pageSize: THREAD_PREVIEW_PAGE_SIZE,
        requestedExtraPages: chatThreadListExtraPages,
      });
      const { visibleEntries } = getVisibleSidebarEntriesForPreview({
        entries,
        activeEntryId: activeEntry?.rowId,
        previewLimit: paging.previewLimit,
      });
      return {
        entries: visibleEntries,
        effectiveExtraPages: paging.effectiveExtraPages,
        canShowMore: paging.canShowMore && visibleEntries.length < entries.length,
        canShowLess: paging.canShowLess,
      };
    };
    const sections = spaces.map((space) => {
      const projects = standardProjects.filter((project) => project.spaceId === space.id);
      const chatData = buildChatData(space.id);
      const chatEntryGroupsByRootId = new Map<ThreadId, typeof chatData.entries>();
      for (const entry of chatData.entries) {
        const existing = chatEntryGroupsByRootId.get(entry.rootRowId);
        if (existing) existing.push(entry);
        else chatEntryGroupsByRootId.set(entry.rootRowId, [entry]);
      }
      const threadItems = [...chatEntryGroupsByRootId].flatMap(([rootRowId, entries]) => {
        const rootEntry = entries.find((entry) => entry.rowId === rootRowId) ?? entries[0];
        return rootEntry
          ? [
              {
                kind: "thread" as const,
                id: rootRowId,
                entries,
                thread: rootEntry.row.thread,
              },
            ]
          : [];
      });
      const projectItems = projects.map((project) => ({
        kind: "project" as const,
        id: project.id,
        project,
      }));
      const items = orderSidebarSpaceItems({
        threadItems: threadItems.map((item) => ({
          id: item.id,
          pinned: pinnedThreadIds.includes(item.id),
          sidebarSortOrder: item.thread.sidebarSortOrder ?? 0,
          threads: [item.thread],
          fallbackCreatedAt: item.thread.createdAt,
          fallbackUpdatedAt: item.thread.updatedAt,
          value: item,
        })),
        projectItems: projectItems.map((item) => ({
          id: item.id,
          pinned: pinnedProjectIdSet.has(item.id),
          sidebarSortOrder: item.project.sidebarSortOrder ?? 0,
          threads: sortedSidebarThreadsByProjectId.get(item.id) ?? [],
          fallbackCreatedAt: item.project.createdAt,
          fallbackUpdatedAt: item.project.updatedAt,
          value: item,
        })),
        sortOrder: appSettings.sidebarThreadSortOrder,
      });

      return {
        key: space.id as string,
        label: space.name,
        space,
        items,
        chatData,
      };
    });
    return sections;
  }, [
    activeSidebarThreadId,
    appSettings.sidebarThreadSortOrder,
    chatThreadListExtraPages,
    pinnedProjectIdSet,
    pinnedThreadIds,
    sortedSidebarThreadsByProjectId,
    spaces,
    standardProjects,
    visibleChatPreviewEntries,
  ]);
  const isSidebarItemPinned = useCallback(
    (item: SidebarItemReference) =>
      item.kind === "project" ? pinnedProjectIdSet.has(item.id) : pinnedThreadIdSet.has(item.id),
    [pinnedProjectIdSet, pinnedThreadIdSet],
  );
  const getOrderedSidebarItems = useCallback(
    (parent: SidebarItemParent): SidebarItemReference[] => {
      if (parent.kind === "project") {
        return (sortedSidebarThreadsByProjectId.get(parent.projectId) ?? [])
          .filter((thread) => thread.parentThreadId == null && thread.archivedAt == null)
          .map((thread) => ({ kind: "thread" as const, id: thread.id }));
      }

      const threadItems = visibleChatThreadRows
        .filter(
          (row) => row.rootThreadId === row.thread.id && row.thread.spaceId === parent.spaceId,
        )
        .map((row) => ({
          id: row.thread.id,
          pinned: pinnedThreadIdSet.has(row.thread.id),
          sidebarSortOrder: row.thread.sidebarSortOrder ?? 0,
          threads: [row.thread],
          fallbackCreatedAt: row.thread.createdAt,
          fallbackUpdatedAt: row.thread.updatedAt,
          value: { kind: "thread" as const, id: row.thread.id },
        }));
      const projectItems = standardProjects
        .filter((project) => project.spaceId === parent.spaceId)
        .map((project) => ({
          id: project.id,
          pinned: pinnedProjectIdSet.has(project.id),
          sidebarSortOrder: project.sidebarSortOrder ?? 0,
          threads: sortedSidebarThreadsByProjectId.get(project.id) ?? [],
          fallbackCreatedAt: project.createdAt,
          fallbackUpdatedAt: project.updatedAt,
          value: { kind: "project" as const, id: project.id },
        }));
      return orderSidebarSpaceItems({
        threadItems,
        projectItems,
        sortOrder: appSettings.sidebarThreadSortOrder,
      });
    },
    [
      appSettings.sidebarThreadSortOrder,
      pinnedProjectIdSet,
      pinnedThreadIdSet,
      sortedSidebarThreadsByProjectId,
      standardProjects,
      visibleChatThreadRows,
    ],
  );
  const commitSidebarItemMove = useCallback(
    async (input: {
      item: SidebarItemReference;
      target: SidebarItemParent;
      position: SidebarItemMovePosition;
    }) => {
      const api = readNativeApi();
      if (!api) return false;
      try {
        await moveSidebarItem({
          api,
          item: input.item,
          target: input.target,
          position: input.position,
        });
        return true;
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Unable to move sidebar item",
          description: error instanceof Error ? error.message : "Try again.",
        });
        return false;
      }
    },
    [],
  );
  const sidebarDropIntentRef = useRef<SidebarDropIntent | null>(null);
  const handleSidebarDragOver = useCallback(
    (event: DragOverEvent, placement: SidebarDropPlacement) => {
      const sourceData = readSidebarDndData(event.operation.source?.data);
      const targetData = readSidebarDndData(event.operation.target?.data);
      if (!sourceData || !targetData) {
        sidebarDropIntentRef.current = null;
        return;
      }

      if (sourceData.type === "space" && targetData.type === "space") {
        sidebarDropIntentRef.current =
          sourceData.spaceId === targetData.spaceId
            ? null
            : {
                kind: "space",
                placement,
                targetSpaceId: targetData.spaceId,
              };
        return;
      }

      if (sourceData.type !== "item") {
        sidebarDropIntentRef.current = null;
        return;
      }
      if (targetData.type === "container") {
        sidebarDropIntentRef.current = {
          kind: "item",
          target: targetData.parent,
        };
        return;
      }
      if (targetData.type !== "item") {
        sidebarDropIntentRef.current = null;
        return;
      }
      if (
        sourceData.item.kind === targetData.item.kind &&
        sourceData.item.id === targetData.item.id
      ) {
        sidebarDropIntentRef.current = null;
        return;
      }
      sidebarDropIntentRef.current = {
        kind: "item",
        target: targetData.parent,
      };
    },
    [],
  );
  const handleSidebarDragEnd = useCallback(
    (event: DragEndEvent) => {
      const intent = sidebarDropIntentRef.current;
      sidebarDropIntentRef.current = null;
      if (event.canceled) return;
      const source = event.operation.source;
      const sourceData = readSidebarDndData(source?.data);
      if (!source || !sourceData) return;

      if (sourceData.type === "space") {
        const sourceSpace = spaces.find((space) => space.id === sourceData.spaceId);
        if (!sourceSpace) return;
        const reordered = spaces.filter((space) => space.id !== sourceData.spaceId);
        if (isSortable(source)) {
          reordered.splice(Math.max(0, Math.min(source.index, reordered.length)), 0, sourceSpace);
        } else if (intent?.kind === "space") {
          const targetIndex = reordered.findIndex((space) => space.id === intent.targetSpaceId);
          if (targetIndex < 0) return;
          reordered.splice(targetIndex + (intent.placement === "after" ? 1 : 0), 0, sourceSpace);
        } else {
          return;
        }
        handleReorderSpaces(
          reordered.map((space) => space.id),
          sourceData.spaceId,
        );
        return;
      }
      if (sourceData.type !== "item") return;

      const target = isSortable(source)
        ? sidebarParentFromDndGroup(source.group)
        : intent?.kind === "item"
          ? intent.target
          : null;
      if (!target) return;
      const destinationItems = getOrderedSidebarItems(target).filter(
        (candidate) =>
          candidate.kind !== sourceData.item.kind || candidate.id !== sourceData.item.id,
      );
      const position = resolveSidebarMovePosition({
        item: sourceData.item,
        destinationItems,
        requestedIndex: isSortable(source)
          ? source.index
          : destinationItems.filter(isSidebarItemPinned).length,
        isPinned: isSidebarItemPinned,
      });

      // A pointer gesture must finish independently of persistence. Suspending the
      // dnd-kit operation here kept the source row and drag overlay mounted until
      // the RPC settled. If the authoritative shell reparented the item first—or
      // the response was delayed/lost—the real row and its stale preview appeared
      // together indefinitely. End the gesture now; the command and shell stream
      // continue to reconcile the durable order in the background.
      void commitSidebarItemMove({
        item: sourceData.item,
        target,
        position,
      });
    },
    [
      commitSidebarItemMove,
      getOrderedSidebarItems,
      handleReorderSpaces,
      isSidebarItemPinned,
      spaces,
    ],
  );
  const standardProjectSidebarDataById = useMemo<
    ReadonlyMap<ContainerId, SidebarDerivedProjectData>
  >(
    () =>
      deriveSidebarProjectData({
        projects: standardProjects,
        sortedSidebarThreadsByProjectId,
        pinnedThreadIds,
        threadListExtraPagesByProjectCwd,
        normalizeProjectCwd: normalizeSidebarProjectThreadListCwd,
        getProjectPagingKey: projectThreadListPagingKey,
        activeSidebarThreadId: activeSidebarThreadId ?? undefined,
        previewLimit: THREAD_PREVIEW_LIMIT,
        previewPageSize: THREAD_PREVIEW_PAGE_SIZE,
        resolveThreadStatus: resolveThreadStatusForSidebar,
      }),
    [
      activeSidebarThreadId,
      threadListExtraPagesByProjectCwd,
      pinnedThreadIds,
      sortedSidebarThreadsByProjectId,
      standardProjects,
      resolveThreadStatusForSidebar,
    ],
  );
  // Reset per-project preview paging when a folder closes so reopening starts at five rows again.
  useEffect(() => {
    const settle = window.setTimeout(() => {
      setThreadListExtraPagesByProjectCwd((current) =>
        pruneProjectThreadListPagingForCollapsedProjects({
          threadListExtraPagesByProjectCwd: current,
          projects: standardProjects,
          normalizeProjectCwd: normalizeSidebarProjectThreadListCwd,
          getProjectPagingKey: projectThreadListPagingKey,
        }),
      );
    }, 0);
    return () => window.clearTimeout(settle);
  }, [standardProjects]);

  useEffect(() => {
    if (!shouldPrunePinnedThreads({ threadsHydrated })) {
      return;
    }
    prunePinnedProjects(allStandardProjectsBase.map((project) => project.id));
  }, [allStandardProjectsBase, prunePinnedProjects, threadsHydrated]);

  useEffect(() => {
    const retainedThreadIds = new Set(sidebarThreads.map((thread) => thread.id));
    const settle = window.setTimeout(() => {
      setDismissedThreadStatusKeyByThreadId((current) => {
        const nextEntries = Object.entries(current).filter(([threadId]) =>
          retainedThreadIds.has(ThreadId.makeUnsafe(threadId)),
        );
        if (nextEntries.length === Object.keys(current).length) {
          return current;
        }
        return Object.fromEntries(nextEntries);
      });
    }, 0);
    return () => window.clearTimeout(settle);
  }, [sidebarThreads]);

  useEffect(() => {
    persistSidebarUiState({
      collapsedSpaceIds: [...collapsedSpaceIds],
      chatThreadListExtraPages,
      projectThreadListExtraPagesByCwd: Object.fromEntries(threadListExtraPagesByProjectCwd),
      dismissedThreadStatusKeyByThreadId,
      lastThreadRoute,
    });
  }, [
    collapsedSpaceIds,
    chatThreadListExtraPages,
    dismissedThreadStatusKeyByThreadId,
    threadListExtraPagesByProjectCwd,
    lastThreadRoute,
  ]);

  useEffect(() => {
    if (isOnWorkspace || isOnSettings || routeThreadId === null) {
      return;
    }

    const nextLastThreadRoute = {
      threadId: routeThreadId,
      ...(routeSearch.splitViewId ? { splitViewId: routeSearch.splitViewId } : {}),
    };
    const settle = window.setTimeout(() => {
      setLastThreadRoute((current) => {
        if (
          current?.threadId === nextLastThreadRoute.threadId &&
          current?.splitViewId === nextLastThreadRoute.splitViewId
        ) {
          return current;
        }
        return nextLastThreadRoute;
      });
    }, 0);
    return () => window.clearTimeout(settle);
  }, [isOnSettings, isOnWorkspace, routeSearch.splitViewId, routeThreadId]);

  const handleThreadClick = useCallback(
    (event: MouseEvent, threadId: ThreadId, orderedProjectThreadIds: readonly ThreadId[]) => {
      const isMac = isMacPlatform(navigator.platform);
      const isModClick = isMac ? event.metaKey : event.ctrlKey;
      const isShiftClick = event.shiftKey;

      if (isModClick) {
        event.preventDefault();
        toggleThreadSelection(threadId);
        return;
      }

      if (isShiftClick) {
        event.preventDefault();
        rangeSelectTo(threadId, orderedProjectThreadIds);
        return;
      }

      activateThreadFromSidebarIntent(threadId);
    },
    [activateThreadFromSidebarIntent, rangeSelectTo, toggleThreadSelection],
  );

  const visibleSidebarThreadIds = useMemo(() => {
    const visibleThreadIdSet = new Set<ThreadId>();
    const addVisibleThreadId = (threadId: ThreadId) => {
      visibleThreadIdSet.add(threadId);
    };

    for (const section of sidebarSpaceSections) {
      for (const item of section.items) {
        if (item.kind === "thread") {
          for (const entry of item.entries) addVisibleThreadId(entry.rowId);
          continue;
        }
        const { project } = item;
        const projectSidebarData = standardProjectSidebarDataById.get(project.id);
        if (!projectSidebarData) {
          continue;
        }

        if (!project.expanded) {
          if (projectSidebarData.activeEntryId) {
            addVisibleThreadId(projectSidebarData.activeEntryId);
          }
          continue;
        }

        for (const entry of projectSidebarData.visibleEntries) {
          addVisibleThreadId(entry.rowId);
        }
      }
    }

    return [...visibleThreadIdSet];
  }, [sidebarSpaceSections, standardProjectSidebarDataById]);
  const threadJumpCommandByThreadId = useMemo(() => {
    const mapping = new Map<ThreadId, NonNullable<ReturnType<typeof threadJumpCommandForIndex>>>();
    for (const [visibleThreadIndex, threadId] of visibleSidebarThreadIds.entries()) {
      const jumpCommand = threadJumpCommandForIndex(visibleThreadIndex);
      if (!jumpCommand) {
        break;
      }
      mapping.set(threadId, jumpCommand);
    }

    return mapping;
  }, [visibleSidebarThreadIds]);
  const threadJumpThreadIds = useMemo(
    () => [...threadJumpCommandByThreadId.keys()],
    [threadJumpCommandByThreadId],
  );
  const getCurrentSidebarShortcutContext = useCallback(
    () => ({
      terminalFocus: isTerminalFocused(),
      terminalOpen,
      terminalWorkspaceOpen,
    }),
    [terminalOpen, terminalWorkspaceOpen],
  );
  const [threadJumpLabelByThreadId, setThreadJumpLabelByThreadId] =
    useState<ReadonlyMap<ThreadId, string>>(EMPTY_THREAD_JUMP_LABELS);
  const threadJumpLabelsRef = useRef<ReadonlyMap<ThreadId, string>>(EMPTY_THREAD_JUMP_LABELS);
  useEffect(() => {
    threadJumpLabelsRef.current = threadJumpLabelByThreadId;
  }, [threadJumpLabelByThreadId]);
  const [showThreadJumpHints, setShowThreadJumpHints] = useState(false);
  const showThreadJumpHintsRef = useRef(false);
  useEffect(() => {
    showThreadJumpHintsRef.current = showThreadJumpHints;
  }, [showThreadJumpHints]);

  useEffect(() => {
    const threadIdsToPrewarm = getSidebarThreadIdsToPrewarm({
      visibleThreadIds: visibleSidebarThreadIds,
      activeThreadId: activeSidebarThreadId,
    });
    const releaseCallbacks = threadIdsToPrewarm.map((threadId) =>
      retainThreadDetailSubscription(threadId),
    );

    return () => {
      for (const release of releaseCallbacks) {
        release();
      }
    };
  }, [activeSidebarThreadId, visibleSidebarThreadIds]);

  function renderPencilProjectItem(
    project: (typeof sortedProjects)[number],
    sortableIndex: number,
  ) {
    const projectSidebarData = standardProjectSidebarDataById.get(project.id);
    if (!projectSidebarData || !project.spaceId) {
      return null;
    }
    const {
      orderedProjectThreadIds,
      projectStatus,
      projectThreads,
      visibleEntries,
      threadListExtraPages,
      canShowMoreThreads,
    } = projectSidebarData;
    const visibleRootIndexByThreadId = new Map(
      visibleEntries
        .filter((entry) => entry.thread.id === entry.rootRowId)
        .map((entry, index) => [entry.rootRowId, index] as const),
    );
    const hasProjectContent = projectThreads.length > 0 || canShowMoreThreads;
    const pagingKey = projectThreadListPagingKey(project);
    const projectWorkStatus: ThreadWorkStatus = resolveSidebarWorkStatus(
      projectStatus,
      projectThreads.some((thread) => thread.id === voiceRecordingThreadId),
    );
    const renamingThisFolder =
      inlineRenameEditor?.kind === "folder" && inlineRenameEditor.projectId === project.id;
    const existingFolderNames = projects
      .filter(
        (candidate) =>
          candidate.id !== project.id &&
          candidate.kind === "project" &&
          candidate.spaceId === project.spaceId,
      )
      .flatMap((candidate) =>
        candidate.name === candidate.remoteName
          ? [candidate.name]
          : [candidate.name, candidate.remoteName],
      );
    const createProjectThread = () => {
      prefetchModelsForProjectNewThread(project.id, { includeDroid: true });
      void handleNewThread(project.id);
    };
    const openProjectContextMenu = (event: React.MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      void handleProjectContextMenu(project.id, {
        x: event.clientX,
        y: event.clientY,
      });
    };

    return (
      <SortableSidebarNode
        key={project.id}
        id={sidebarItemDndId({ kind: "project", id: project.id })}
        group={sidebarParentDndGroup({
          kind: "space",
          spaceId: project.spaceId,
        })}
        index={sortableIndex}
        data={{
          type: "item",
          item: { kind: "project", id: project.id },
          parent: { kind: "space", spaceId: project.spaceId },
          label: project.name,
          preview: {
            kind: "project",
            label: project.name,
            expanded: project.expanded,
            pinned: pinnedProjectIdSet.has(project.id),
            workStatus: projectWorkStatus,
          },
        }}
      >
        <SidebarContainerDropTarget
          id={`sidebar-container:project:${project.id}`}
          className="pointer-events-none absolute inset-x-0 top-0 z-20 h-[27px]"
          data={{
            type: "container",
            parent: { kind: "project", projectId: project.id },
            label: project.name,
          }}
        />
        <FolderGroupShared
          expanded={project.expanded}
          hasContent={hasProjectContent}
          header={
            renamingThisFolder ? (
              <FolderRowInlineEdit
                defaultValue={project.name}
                existingNames={existingFolderNames}
                expanded={project.expanded}
                onCancel={cancelInlineRename}
                onSubmit={async (title) => {
                  if (title !== project.remoteName) {
                    await commitFolderRename(project.id, title);
                  }
                  finishInlineRename({ kind: "folder", projectId: project.id });
                }}
                onValueChange={updateInlineRenameValue}
                pinned={pinnedProjectIdSet.has(project.id)}
                value={inlineRenameEditor.value}
              />
            ) : undefined
          }
          label={project.name}
          onExpandedChange={(nextExpanded) => {
            if (!nextExpanded) setThreadListExtraPagesForProject(pagingKey, 0);
            toggleProject(project.id);
          }}
          onHeaderAction={createProjectThread}
          onHeaderContextMenu={openProjectContextMenu}
          pinned={pinnedProjectIdSet.has(project.id)}
          workStatus={projectWorkStatus}
        >
          <div className="flex flex-col gap-0.5" data-pencil-project-id={project.id}>
            {visibleEntries.map((entry) =>
              renderPencilThreadRow(
                entry.thread,
                orderedProjectThreadIds,
                entry.depth,
                "nested",
                entry.rootRowId,
                entry.thread.id === entry.rootRowId
                  ? {
                      index: visibleRootIndexByThreadId.get(entry.rootRowId) ?? 0,
                      parent: { kind: "project", projectId: project.id },
                    }
                  : undefined,
              ),
            )}
            {canShowMoreThreads ? (
              <ShowMoreRow
                onClick={() => showMoreThreadsForProject(pagingKey, threadListExtraPages)}
              >
                Show more
              </ShowMoreRow>
            ) : null}
          </div>
        </FolderGroupShared>
      </SortableSidebarNode>
    );
  }

  function renderPencilThreadRow(
    thread: SidebarThreadSummary,
    orderedProjectThreadIds: readonly ThreadId[],
    depth = 0,
    levelOverride?: "root" | "nested",
    dragRootThreadId: ThreadId = thread.id,
    sortablePosition?: { index: number; parent: SidebarItemParent },
  ) {
    const isActive = visualActiveSidebarThreadId === thread.id;
    const isSelected = selectedThreadIds.has(thread.id);
    const threadStatus = resolveThreadStatusForSidebar(thread);
    const workStatus: ThreadWorkStatus = resolveSidebarWorkStatus(
      threadStatus,
      thread.id === voiceRecordingThreadId,
    );
    const harness =
      thread.title.trim().toLowerCase() === "main"
        ? ("github" as const)
        : thread.modelSelection.provider;
    const level = levelOverride ?? (depth > 0 ? "nested" : "root");
    const renamingThisThread =
      inlineRenameEditor?.kind === "thread" && inlineRenameEditor.threadId === thread.id;
    const row = renamingThisThread ? (
      <ThreadRowInlineEdit
        defaultValue={thread.title}
        harness={harness}
        level={level}
        onCancel={cancelInlineRename}
        onSubmit={async (title) => {
          await commitRename(thread.id, title, thread.title);
          finishInlineRename({ kind: "thread", threadId: thread.id });
        }}
        onValueChange={updateInlineRenameValue}
        pinned={pinnedThreadIdSet.has(thread.id)}
        value={inlineRenameEditor.value}
      />
    ) : (
      <ThreadRowShared
        aria-label={thread.title}
        className={cn(isSelected && "ring-1 ring-[var(--color-border-focus)]")}
        data-thread-item
        onClick={(event) => handleThreadClick(event, thread.id, orderedProjectThreadIds)}
        onContextMenu={(event) => {
          event.preventDefault();
          if (selectedThreadIds.size > 0 && selectedThreadIds.has(thread.id)) {
            void handleMultiSelectContextMenu({
              x: event.clientX,
              y: event.clientY,
            });
            return;
          }
          if (selectedThreadIds.size > 0) {
            clearSelection();
          }
          void handleThreadContextMenu(thread.id, {
            x: event.clientX,
            y: event.clientY,
          });
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          activateThreadFromSidebarIntent(thread.id);
        }}
        onPointerDown={(event) => primeThreadActivation(event, thread.id)}
        harness={harness}
        level={level}
        pinned={pinnedThreadIdSet.has(thread.id)}
        state={isActive ? "active" : "default"}
        workStatus={workStatus}
      >
        {thread.title}
      </ThreadRowShared>
    );

    if (!sortablePosition) return row;

    return (
      <SortableSidebarNode
        key={thread.id}
        id={sidebarItemDndId({ kind: "thread", id: dragRootThreadId })}
        group={sidebarParentDndGroup(sortablePosition.parent)}
        index={sortablePosition.index}
        data={{
          type: "item",
          item: { kind: "thread", id: dragRootThreadId },
          parent: sortablePosition.parent,
          label: thread.title,
          preview: {
            kind: "thread",
            label: thread.title,
            harness,
            level,
            pinned: pinnedThreadIdSet.has(thread.id),
            workStatus,
          },
        }}
      >
        {row}
      </SortableSidebarNode>
    );
  }

  useEffect(() => {
    const onMouseDown = (event: globalThis.MouseEvent) => {
      if (selectedThreadIds.size === 0) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (!shouldClearThreadSelectionOnMouseDown(target)) return;
      clearSelection();
    };

    window.addEventListener("mousedown", onMouseDown);
    return () => {
      window.removeEventListener("mousedown", onMouseDown);
    };
  }, [clearSelection, selectedThreadIds.size]);

  useEffect(() => {
    const clearThreadJumpHints = () => {
      setThreadJumpLabelByThreadId((current) =>
        current === EMPTY_THREAD_JUMP_LABELS ? current : EMPTY_THREAD_JUMP_LABELS,
      );
      setShowThreadJumpHints(false);
    };
    const shouldIgnoreThreadJumpHintUpdate = (event: KeyboardEvent) =>
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.shiftKey &&
      event.key !== "Meta" &&
      event.key !== "Control" &&
      event.key !== "Alt" &&
      event.key !== "Shift" &&
      !showThreadJumpHintsRef.current &&
      threadJumpLabelsRef.current === EMPTY_THREAD_JUMP_LABELS;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;

      const shortcutContext = getCurrentSidebarShortcutContext();
      if (!shouldIgnoreThreadJumpHintUpdate(event)) {
        const shouldShowHints = shouldShowThreadJumpHints(event, keybindings, {
          platform: navigator.platform,
          context: shortcutContext,
        });
        if (!shouldShowHints) {
          if (
            showThreadJumpHintsRef.current ||
            threadJumpLabelsRef.current !== EMPTY_THREAD_JUMP_LABELS
          ) {
            clearThreadJumpHints();
          }
        } else {
          setThreadJumpLabelByThreadId((current) => {
            const nextLabelMap = buildThreadJumpLabelMap({
              keybindings,
              platform: navigator.platform,
              terminalOpen: shortcutContext.terminalOpen,
              threadJumpCommandByThreadId,
            });
            return threadJumpLabelMapsEqual(current, nextLabelMap) ? current : nextLabelMap;
          });
          setShowThreadJumpHints(true);
        }
      }

      const command = resolveShortcutCommand(event, keybindings, {
        context: shortcutContext,
      });
      if (command === "sidebar.search") {
        event.preventDefault();
        event.stopPropagation();
        setSearchPaletteMode("search");
        setSearchPaletteOpen((prev) => !prev || searchPaletteMode !== "search");
        return;
      }
      if (command === "sidebar.addProject") {
        event.preventDefault();
        event.stopPropagation();
        setCreateProjectDialogOpen(true);
        return;
      }
      // The route-level new-thread handler owns normal creation. When no project
      // exists it deliberately leaves the event untouched so the sidebar can
      // surface the project prerequisite instead of turning the shortcut into a
      // silent no-op.
      if (command === "chat.new" && threadsHydrated && !primaryNewThreadTarget) {
        event.preventDefault();
        event.stopPropagation();
        setCreateProjectDialogOpen(true);
        return;
      }
      if (command === "settings.usage") {
        event.preventDefault();
        event.stopPropagation();
        void navigate({
          to: "/settings",
          search: { section: "usage" },
        });
        return;
      }
      if (command === "space.previous" || command === "space.next") {
        if (
          !isProjectsSidebarSurface({
            isOnSettings,
            isOnStudio: false,
            isOnWorkspace,
          })
        )
          return;
        event.preventDefault();
        event.stopPropagation();
        const orderedSpaceIds = spaces.map((space) => space.id);
        if (orderedSpaceIds.length === 0) return;
        const currentIndex = activeSpaceId
          ? Math.max(0, orderedSpaceIds.indexOf(activeSpaceId))
          : 0;
        const offset = command === "space.previous" ? -1 : 1;
        const nextIndex = (currentIndex + offset + orderedSpaceIds.length) % orderedSpaceIds.length;
        const nextSpaceId = orderedSpaceIds[nextIndex];
        if (nextSpaceId) handleSelectSpace(nextSpaceId);
        return;
      }
      const spaceJumpIndex = spaceJumpIndexFromCommand(command ?? "");
      if (spaceJumpIndex !== null) {
        if (
          !isProjectsSidebarSurface({
            isOnSettings,
            isOnStudio: false,
            isOnWorkspace,
          })
        )
          return;
        const orderedSpaceIds = spaces.map((space) => space.id);
        if (spaceJumpIndex >= orderedSpaceIds.length) return;
        event.preventDefault();
        event.stopPropagation();
        const targetSpaceId = orderedSpaceIds[spaceJumpIndex];
        if (!targetSpaceId) return;
        if (targetSpaceId !== activeSpaceId) {
          handleSelectSpace(targetSpaceId);
        }
        return;
      }
      const jumpIndex = threadJumpIndexFromCommand(command ?? "");
      if (jumpIndex !== null) {
        event.preventDefault();
        event.stopPropagation();
        const threadJumpTargetId = threadJumpThreadIds[jumpIndex];
        if (threadJumpTargetId) {
          activateThreadFromSidebarIntent(threadJumpTargetId);
        }
        return;
      }
      if (command !== "chat.visible.next" && command !== "chat.visible.previous") {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      const nextThreadId = getNextVisibleSidebarThreadId({
        visibleThreadIds: visibleSidebarThreadIds,
        activeThreadId: activeSidebarThreadId ?? undefined,
        direction: command === "chat.visible.previous" ? "backward" : "forward",
      });
      if (nextThreadId && nextThreadId !== activeSidebarThreadId) {
        activateThreadFromSidebarIntent(nextThreadId);
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (shouldIgnoreThreadJumpHintUpdate(event)) {
        return;
      }
      const shortcutContext = getCurrentSidebarShortcutContext();
      const shouldShowHints = shouldShowThreadJumpHints(event, keybindings, {
        platform: navigator.platform,
        context: shortcutContext,
      });
      if (!shouldShowHints) {
        clearThreadJumpHints();
        return;
      }
      setThreadJumpLabelByThreadId((current) => {
        const nextLabelMap = buildThreadJumpLabelMap({
          keybindings,
          platform: navigator.platform,
          terminalOpen: shortcutContext.terminalOpen,
          threadJumpCommandByThreadId,
        });
        return threadJumpLabelMapsEqual(current, nextLabelMap) ? current : nextLabelMap;
      });
      setShowThreadJumpHints(true);
    };
    const onWindowBlur = () => {
      clearThreadJumpHints();
    };

    window.addEventListener("keydown", onKeyDown, { capture: true });
    window.addEventListener("keyup", onKeyUp, { capture: true });
    window.addEventListener("blur", onWindowBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown, { capture: true });
      window.removeEventListener("keyup", onKeyUp, { capture: true });
      window.removeEventListener("blur", onWindowBlur);
    };
  }, [
    activateThreadFromSidebarIntent,
    activeSidebarThreadId,
    activeSpaceId,
    handleSelectSpace,
    keybindings,
    getCurrentSidebarShortcutContext,
    homeDir,
    isOnSettings,
    isOnWorkspace,
    navigate,
    primaryNewThreadTarget,
    searchPaletteMode,
    spaces,
    threadJumpCommandByThreadId,
    threadJumpThreadIds,
    threadsHydrated,
    visibleSidebarThreadIds,
  ]);

  useEffect(() => {
    if (!isElectron) return;
    const bridge = window.desktopBridge;
    if (
      !bridge ||
      typeof bridge.getUpdateState !== "function" ||
      typeof bridge.onUpdateState !== "function"
    ) {
      return;
    }

    return subscribeToDesktopUpdateState(bridge, setDesktopUpdateState);
  }, []);

  // Single entry point for update error toasts. Attaches the manual-download
  // fallback (copy link + "Download manually") whenever a release URL is known,
  // and dedupes by error signature so the same failure is not toasted twice.
  const surfaceDesktopUpdateError = useCallback(
    (input: { title: string; description: string; state: DesktopUpdateState | null }) => {
      const signature = getDesktopUpdateErrorSignature(input.state) ?? `adhoc:${input.description}`;
      if (lastDesktopUpdateErrorToastSignatureRef.current === signature) {
        return;
      }
      lastDesktopUpdateErrorToastSignatureRef.current = signature;
      const releaseUrl = input.state?.releaseUrl ?? null;
      const recommendManualDownload = shouldRecommendManualDesktopDownload(input.state);
      const fallbackProps = releaseUrl
        ? {
            data: { copyText: releaseUrl },
            actionProps: {
              children: "Download manually",
              onClick: () => {
                void window.desktopBridge?.openExternal(releaseUrl);
              },
            },
          }
        : {};
      toastManager.add({
        type: "error",
        title: recommendManualDownload ? "Download the update manually" : input.title,
        description: recommendManualDownload
          ? `Automatic installation has failed ${input.state?.installFailureCount ?? 0} times. Download ${input.state?.availableVersion ?? "the update"} manually to finish updating.`
          : input.description,
        ...fallbackProps,
      });
    },
    [],
  );

  // The install watchdog (and any background-pushed failure) flips the update
  // state to a download/install error without going through a click handler, so
  // the fallback must also be surfaced reactively here. Dedup keeps it from
  // doubling up with the click-handler toast for user-initiated failures.
  useEffect(() => {
    const errorSignature = getDesktopUpdateErrorSignature(desktopUpdateState);
    if (!errorSignature) {
      // Returning to any non-error state (new download, success, up-to-date)
      // clears the dedup key so the next distinct failure notifies again.
      lastDesktopUpdateErrorToastSignatureRef.current = null;
      return;
    }
    setInstallingDesktopUpdate(false);
    if (!desktopUpdateState?.releaseUrl) {
      return;
    }
    surfaceDesktopUpdateError({
      title:
        desktopUpdateState.errorContext === "install"
          ? "Couldn’t finish updating"
          : "Couldn’t download the update",
      description:
        desktopUpdateState.message ??
        "The in-app update could not complete. You can download it manually.",
      state: desktopUpdateState,
    });
  }, [desktopUpdateState, surfaceDesktopUpdateError]);

  const showDesktopUpdateButton = isElectron && shouldShowDesktopUpdateButton(desktopUpdateState);

  const desktopUpdateButtonDisabled =
    isDesktopUpdateButtonDisabled(desktopUpdateState) || installingDesktopUpdate;
  const desktopUpdateButtonAction = desktopUpdateState
    ? resolveDesktopUpdateButtonAction(desktopUpdateState)
    : "none";
  const desktopUpdateButtonPresentation = getDesktopUpdateButtonPresentation(desktopUpdateState, {
    installing: installingDesktopUpdate,
  });
  const showArm64IntelBuildWarning =
    isElectron && shouldShowArm64IntelBuildWarning(desktopUpdateState);
  const arm64IntelBuildWarningDescription =
    desktopUpdateState && showArm64IntelBuildWarning
      ? getArm64IntelBuildWarningDescription(desktopUpdateState)
      : null;
  const desktopUpdateDownloadPercent = getDesktopUpdateDownloadPercent(desktopUpdateState);
  const desktopAccountUpdatePhase = installingDesktopUpdate
    ? "installing"
    : desktopUpdateState?.status === "downloading"
      ? desktopUpdateDownloadPercent === null
        ? "preparing"
        : "downloading"
      : showDesktopUpdateButton
        ? "ready"
        : "none";
  const importThreadShortcutLabel =
    shortcutLabelForCommand(keybindings, "sidebar.importThread") ??
    (isMacPlatform(navigator.platform) ? "⌘I" : "Ctrl+I");
  const addProjectShortcutLabel =
    shortcutLabelForCommand(keybindings, "sidebar.addProject") ??
    (isMacPlatform(navigator.platform) ? "⇧⌘O" : "Ctrl+Shift+O");
  const usageSettingsShortcutLabel = shortcutLabelForCommand(keybindings, "settings.usage");
  const searchPaletteProjects = useMemo<SidebarSearchProject[]>(
    () =>
      projects.flatMap((project) => {
        let spaceName = "Global";
        if (
          isOrdinarySpaceProject(project, {
            homeDir,
            chatWorkspaceRoot,
            studioWorkspaceRoot,
          })
        ) {
          if (project.spaceId == null) {
            throw new Error(`Folder '${project.id}' is missing its required Space assignment.`);
          }
          const activeSpaceName = activeSpaceDisplayNameForReference(
            project.spaceId,
            spaces,
            archivedSpaces,
          );
          if (activeSpaceName === null) return [];
          spaceName = activeSpaceName;
        }
        return [
          {
            id: project.id,
            name: project.name,
            remoteName: project.remoteName,
            folderName: project.folderName,
            localName: project.localName,
            cwd: project.cwd,
            // Containers (Chats, Studio) are reachable from every Space, so they search as "Global".
            spaceName,
            createdAt: project.createdAt,
            updatedAt: project.updatedAt,
          },
        ];
      }),
    [archivedSpaces, chatWorkspaceRoot, homeDir, projects, spaces, studioWorkspaceRoot],
  );
  const searchPaletteActions = useMemo<SidebarSearchAction[]>(
    () => [
      {
        id: "add-project",
        label: "Add folder",
        description: "Open a repository or folder in the sidebar.",
        keywords: ["folder", "repo", "repository", "open"],
        shortcutLabel: addProjectShortcutLabel,
        run: handleStartAddProject,
      },
      {
        id: "import-thread",
        label: "Import thread from...",
        description: "Attach a local thread to an existing provider session.",
        keywords: [
          "import",
          "resume",
          "thread",
          "session",
          "codex",
          "claude",
          "cursor",
          "opencode",
        ],
        shortcutLabel: importThreadShortcutLabel,
      },
      {
        id: "feedback",
        label: "Feedback Penkra",
        description: "Send feedback or report an issue to the Penkra team.",
        keywords: ["feedback", "bug", "issue", "problem", "report", "support", "penkra"],
      },
      {
        id: "settings",
        label: "Settings",
        description: "Open app settings.",
        keywords: ["preferences", "config"],
      },
      {
        id: "usage-settings",
        label: "Usage settings",
        description: "Open provider usage and remaining credits.",
        keywords: ["usage", "limits", "credits", "quota", "providers"],
        shortcutLabel: usageSettingsShortcutLabel,
      },
      // Space jumps ride the palette so keyboard users can reach any space by name
      // without learning the previous/next-space chords.
      ...spaces.map(
        (space) =>
          ({
            id: `switch-space-${space.id}`,
            label: `Switch to ${space.name}`,
            description: "Jump to this space and restore its last context.",
            keywords: ["space", "switch", space.name],
            requiresQuery: true,
            run: () => handleSelectSpace(space.id),
          }) satisfies SidebarSearchAction,
      ),
      {
        id: "new-space",
        label: "New space",
        description: "Group folders into a focused work context.",
        keywords: ["space", "create", "new", "group", "workspace"],
        run: () => openSpaceCreator(),
        icon: AddPlusIcon,
      },
    ],
    [
      addProjectShortcutLabel,
      handleSelectSpace,
      handleStartAddProject,
      importThreadShortcutLabel,
      openSpaceCreator,
      spaces,
      usageSettingsShortcutLabel,
    ],
  );

  const handleDesktopUpdateButtonClick = useCallback(() => {
    const bridge = window.desktopBridge;
    if (!bridge || !desktopUpdateState) return;
    if (desktopUpdateButtonDisabled || desktopUpdateButtonAction === "none") return;

    // Keep the sidebar action as the single visible entry point for manual checks.
    if (desktopUpdateButtonAction === "check") {
      void bridge
        .checkForUpdates()
        .then((nextState) => {
          setInstallingDesktopUpdate(false);
          setDesktopUpdateState(nextState);
          if (nextState.status === "available") {
            toastManager.add({
              type: "info",
              title: "Update available",
              description: `Click Update to download version ${nextState.availableVersion ?? "available"} and restart Penkra.`,
            });
            return;
          }

          if (nextState.status === "downloading") {
            toastManager.add({
              type: "info",
              title: "Preparing update",
              description: "Penkra is downloading the update.",
            });
            return;
          }

          if (nextState.status === "downloaded") {
            toastManager.add({
              type: "success",
              title: "Update ready",
              description: "Click Update when you’re ready to restart and install it.",
            });
            return;
          }

          if (nextState.status === "up-to-date") {
            toastManager.add({
              type: "info",
              title: "You're up to date",
              description: `Penkra ${nextState.currentVersion} is already the newest version.`,
            });
            return;
          }

          if (nextState.status === "error") {
            surfaceDesktopUpdateError({
              title: "Could not check for updates",
              description: nextState.message ?? "An unexpected error occurred.",
              state: nextState,
            });
          }
        })
        .catch((error) => {
          surfaceDesktopUpdateError({
            title: "Could not check for updates",
            description: error instanceof Error ? error.message : "An unexpected error occurred.",
            state: desktopUpdateState,
          });
        });
      return;
    }

    const installReadyUpdate = async () => {
      setInstallingDesktopUpdate(true);
      persistAppStateNow();
      try {
        const result = await bridge.installUpdate();
        setDesktopUpdateState(result.state);
        const alreadyCurrentNotice = getDesktopUpdateAlreadyCurrentNotice(result);
        if (alreadyCurrentNotice) {
          setInstallingDesktopUpdate(false);
          toastManager.add({
            type: "info",
            title: "Already up to date",
            description: alreadyCurrentNotice,
          });
          return;
        }
        const actionError = getDesktopUpdateActionError(result);
        if (actionError) {
          setInstallingDesktopUpdate(false);
          surfaceDesktopUpdateError({
            title: "Could not install update",
            description: actionError,
            state: result.state,
          });
          return;
        }
        if (!result.accepted) {
          setInstallingDesktopUpdate(false);
        }
      } catch (error) {
        setInstallingDesktopUpdate(false);
        surfaceDesktopUpdateError({
          title: "Could not install update",
          description: error instanceof Error ? error.message : "An unexpected error occurred.",
          state: desktopUpdateState,
        });
      }
    };

    if (desktopUpdateButtonAction === "download") {
      void bridge
        .downloadUpdate()
        .then(async (result) => {
          setDesktopUpdateState(result.state);
          const alreadyCurrentNotice = getDesktopUpdateAlreadyCurrentNotice(result);
          if (alreadyCurrentNotice) {
            toastManager.add({
              type: "info",
              title: "Already up to date",
              description: alreadyCurrentNotice,
            });
            return;
          }
          if (result.completed) {
            await installReadyUpdate();
            return;
          }
          if (!shouldToastDesktopUpdateActionResult(result)) return;
          const actionError = getDesktopUpdateActionError(result);
          if (!actionError) return;
          surfaceDesktopUpdateError({
            title: "Could not download update",
            description: actionError,
            state: result.state,
          });
        })
        .catch((error) => {
          surfaceDesktopUpdateError({
            title: "Could not start update download",
            description: error instanceof Error ? error.message : "An unexpected error occurred.",
            state: desktopUpdateState,
          });
        });
      return;
    }

    if (desktopUpdateButtonAction === "install") {
      void installReadyUpdate();
    }
  }, [
    desktopUpdateButtonAction,
    desktopUpdateButtonDisabled,
    desktopUpdateState,
    surfaceDesktopUpdateError,
  ]);

  // Both handlers step from the *effective* (clamped) page count reported by the derived
  // project data, so stale/oversized stored paging self-heals on the very next click.
  const setThreadListExtraPagesForProject = useCallback(
    (pagingKey: string, nextExtraPages: number) => {
      if (pagingKey.length === 0) return;
      setThreadListExtraPagesByProjectCwd((current) => {
        const clampedExtraPages = Math.max(0, nextExtraPages);
        if ((current.get(pagingKey) ?? 0) === clampedExtraPages) return current;
        const next = new Map(current);
        if (clampedExtraPages === 0) {
          next.delete(pagingKey);
        } else {
          next.set(pagingKey, clampedExtraPages);
        }
        return next;
      });
    },
    [],
  );

  const showMoreThreadsForProject = useCallback(
    (pagingKey: string, currentExtraPages: number) => {
      setThreadListExtraPagesForProject(pagingKey, currentExtraPages + 1);
    },
    [setThreadListExtraPagesForProject],
  );

  const isMacDesktop = typeof navigator !== "undefined" ? isMacPlatform(navigator.platform) : false;
  const { isFullscreen } = useDesktopWindowState();
  const showMacTrafficLightAffordance = isMacDesktop && !isFullscreen;

  // Closed-state and non-Electron hosts retain shell navigation controls. The
  // expanded desktop rail uses the Pencil header primitive directly.
  const headerControls = <SidebarLeadingControls className="ml-auto hidden md:flex" />;

  const wordmark = (
    <div className="flex w-full items-center gap-1.5">
      <SidebarTrigger className="shrink-0 text-muted-foreground/75 hover:text-foreground md:hidden" />
      {headerControls}
    </div>
  );
  const sidebarHeaderSurface = isElectron ? (
    <SidebarHeader
      className={cn(
        "drag-region flex-row items-center p-0 font-system-ui",
        CHAT_SURFACE_HEADER_HEIGHT_CLASS,
        showMacTrafficLightAffordance && DESKTOP_TOP_BAR_TRAFFIC_LIGHT_GUTTER_CLASS,
      )}
    >
      <SidebarHeaderShared
        brand="Penkra"
        className={cn("h-full w-full", showMacTrafficLightAffordance && "pl-0")}
        {...(isOnSettings
          ? {
              onBack: () => {
                if (lastThreadRoute) {
                  const rememberedThreadId = ThreadId.makeUnsafe(lastThreadRoute.threadId);
                  if (sidebarThreadSummaryById[rememberedThreadId]) {
                    activateThreadFromSidebarIntent(rememberedThreadId);
                    return;
                  }
                }
                void navigate({ to: "/" });
              },
            }
          : { onClose: () => setSidebarOpen(false) })}
      />
    </SidebarHeader>
  ) : (
    <SidebarHeader className="gap-3 px-3 py-2.5 font-system-ui sm:gap-2.5 sm:px-4 sm:py-3">
      {wordmark}
    </SidebarHeader>
  );
  return (
    <>
      {sidebarHeaderSurface}
      <LeftRailContentShared>
        <SidebarTopNavigation onSelect={() => setSearchPaletteOpen(true)} />

        {showArm64IntelBuildWarning && arm64IntelBuildWarningDescription ? (
          <div className="px-2 pt-2">
            <Alert variant="warning" className="rounded-2xl border-warning/40 bg-warning/8">
              <TriangleAlertIcon />
              <AlertTitle>Intel build on Apple Silicon</AlertTitle>
              <AlertDescription>{arm64IntelBuildWarningDescription}</AlertDescription>
              {desktopUpdateButtonAction !== "none" ? (
                <AlertAction>
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={desktopUpdateButtonDisabled}
                    onClick={handleDesktopUpdateButtonClick}
                  >
                    {desktopUpdateButtonAction === "download"
                      ? "Update ARM build"
                      : desktopUpdateButtonAction === "install"
                        ? "Update ARM build"
                        : "Check for ARM build update"}
                  </Button>
                </AlertAction>
              ) : null}
            </Alert>
          </div>
        ) : null}
        <SidebarProjects className="sidebar-surface-enter font-system-ui">
          {spaceEditorOpen && spaceEditorMode === "create" ? (
            <SpaceHeaderInlineEdit
              existingNames={spaceEditorExistingNames}
              mode="create"
              onCancel={closeSpaceEditor}
              onSubmit={async (name) => {
                await handleSpaceEditorSubmit({ name, icon: "folder" });
                closeSpaceEditor();
              }}
            />
          ) : null}
          <SidebarDndMonitor onDragEnd={handleSidebarDragEnd} onDragOver={handleSidebarDragOver}>
            <div className="flex flex-col gap-4" data-slot="space-list">
              {sidebarSpaceSections.map((section, spaceIndex) => {
                const expanded = !collapsedSpaceIds.has(section.key);
                const hasContent =
                  section.items.length > 0 ||
                  section.chatData.canShowMore ||
                  section.chatData.canShowLess;
                const editingThisSpace =
                  spaceEditorOpen &&
                  spaceEditorMode === "edit" &&
                  editedSpace?.id === section.space.id;
                return (
                  <SortableSidebarNode
                    key={section.key}
                    id={sidebarSpaceDndId(section.space.id)}
                    group="sidebar-space-order"
                    index={spaceIndex}
                    data={{
                      type: "space",
                      spaceId: section.space.id,
                      label: section.label,
                      preview: {
                        kind: "space",
                        label: section.label,
                        expanded,
                      },
                    }}
                  >
                    <SidebarContainerDropTarget
                      id={`sidebar-container:space:${section.space.id}`}
                      className="pointer-events-none absolute inset-x-0 top-0 z-20 h-[27px]"
                      data={{
                        type: "container",
                        parent: { kind: "space", spaceId: section.space.id },
                        label: section.label,
                      }}
                    />
                    <div data-space-id={section.space.id}>
                      <SpaceGroupShared
                        expanded={expanded}
                        hasContent={hasContent}
                        header={
                          editingThisSpace && editedSpace ? (
                            <SpaceHeaderInlineEdit
                              defaultValue={editedSpace.name}
                              existingNames={spaceEditorExistingNames}
                              mode="rename"
                              onCancel={closeSpaceEditor}
                              onSubmit={async (name) => {
                                await handleSpaceEditorSubmit({
                                  name,
                                  icon: editedSpace.icon,
                                });
                                closeSpaceEditor();
                              }}
                            />
                          ) : undefined
                        }
                        label={section.label}
                        onExpandedChange={(nextExpanded) => {
                          if (!nextExpanded) setChatThreadListExtraPages(0);
                          setCollapsedSpaceIds((current) => {
                            const next = new Set(current);
                            if (nextExpanded) next.delete(section.key);
                            else next.add(section.key);
                            return next;
                          });
                        }}
                        onHeaderAction={() => {
                          handleSelectSpace(section.space.id);
                          void handleCreateHomeChat(section.space.id);
                        }}
                        onHeaderContextMenu={(event: MouseEvent<HTMLButtonElement>) =>
                          void handleSpaceHeaderContextMenu(event, section.space)
                        }
                      >
                        {section.items.map((item, itemIndex) =>
                          item.kind === "thread" ? (
                            <Fragment key={`thread:${item.id}`}>
                              {item.entries.map((entry) =>
                                renderPencilThreadRow(
                                  entry.row.thread,
                                  visibleChatOrderedThreadIds,
                                  entry.row.depth,
                                  undefined,
                                  entry.rootRowId,
                                  entry.row.thread.id === entry.rootRowId
                                    ? {
                                        index: itemIndex,
                                        parent: {
                                          kind: "space",
                                          spaceId: section.space.id,
                                        },
                                      }
                                    : undefined,
                                ),
                              )}
                            </Fragment>
                          ) : (
                            renderPencilProjectItem(item.project, itemIndex)
                          ),
                        )}
                        {section.chatData.canShowMore ? (
                          <ShowMoreRow
                            onClick={() =>
                              setChatThreadListExtraPages(section.chatData.effectiveExtraPages + 1)
                            }
                          >
                            Show more
                          </ShowMoreRow>
                        ) : null}
                      </SpaceGroupShared>
                    </div>
                  </SortableSidebarNode>
                );
              })}
            </div>
          </SidebarDndMonitor>
        </SidebarProjects>
      </LeftRailContentShared>

      <SidebarFooter className="gap-1 p-0 font-system-ui">
        {DebugFeatureFlagsMenu && showDebugFeatureFlagsMenu && !isOnSettings ? (
          <Suspense fallback={null}>
            <div className="px-2">
              <DebugFeatureFlagsMenu />
            </div>
          </Suspense>
        ) : null}
        <AccountControlShared
          accountName={profileName}
          onSettings={() => void navigate({ to: "/settings", search: { section: undefined } })}
          onSupport={() => openFeedbackDialog()}
          updateAvailable={showDesktopUpdateButton}
          updateDisabled={desktopUpdateButtonDisabled}
          updateLabel={
            desktopUpdateDownloadPercent !== null
              ? `${desktopUpdateDownloadPercent}%`
              : desktopUpdateButtonPresentation.label
          }
          updatePhase={desktopAccountUpdatePhase}
          {...(showDesktopUpdateButton ? { onUpdate: handleDesktopUpdateButtonClick } : {})}
        />
      </SidebarFooter>

      <CreateProjectDialog
        open={createProjectDialogOpen}
        spaces={spaces}
        activeSpaceId={activeSpaceId}
        existingFolderNamesBySpaceId={folderNamesBySpaceId}
        onOpenChange={setCreateProjectDialogOpen}
        onSubmit={handleCreateProjectSubmit}
      />

      <Dialog
        open={projectRunDialogProjectId !== null}
        onOpenChange={(open) => {
          if (!open) {
            closeProjectRunDialog();
          }
        }}
      >
        <DialogPopup className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-[length:calc(var(--app-font-size-base,12px)*1.3333)]">
              <PlayIcon className="size-4 text-emerald-500" />
              Start dev
            </DialogTitle>
            <DialogDescription>
              {projectRunDialogProject ? projectRunDialogProject.name : "Folder"}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-2">
            <label
              htmlFor="project-run-command-input"
              className="block text-[length:var(--app-font-size-ui-xs,10px)] font-medium text-[var(--color-text-foreground-secondary)]"
            >
              Command
            </label>
            <Input
              id="project-run-command-input"
              autoFocus
              spellCheck={false}
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              placeholder="e.g. npm run dev"
              value={projectRunDialogCommandDraft}
              aria-invalid={projectRunDialogCommandIsValid ? undefined : true}
              onChange={(event) => setProjectRunDialogCommandDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  handleConfirmProjectRun();
                }
              }}
            />
            {projectRunDialogCommandIsValid ? null : (
              <p className="text-[length:var(--app-font-size-ui-sm,11px)] text-destructive">
                Enter a command to run.
              </p>
            )}
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" onClick={closeProjectRunDialog}>
              Cancel
            </Button>
            <Button
              onClick={handleConfirmProjectRun}
              disabled={!projectRunDialogCommandIsValid || Boolean(projectRunDialogExistingRun)}
            >
              <PlayIcon className="size-4" />
              Run
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>

      {searchPaletteOpen ? (
        <SidebarSearchPaletteController
          open={searchPaletteOpen}
          mode={searchPaletteMode}
          onModeChange={setSearchPaletteMode}
          onOpenChange={(open) => {
            setSearchPaletteOpen(open);
            if (!open) {
              setSearchPaletteMode("search");
            }
          }}
          actions={searchPaletteActions}
          projects={searchPaletteProjects}
          projectById={projectById}
          onCreateChat={() => {
            if (activeSpaceId) void handleCreateHomeChat(activeSpaceId);
          }}
          onCreateThread={handlePrimaryNewThread}
          onOpenSettings={() => {
            void navigate({ to: "/settings" });
          }}
          onOpenFeedback={openFeedbackDialog}
          onOpenUsageSettings={() => {
            void navigate({
              to: "/settings",
              search: { section: "usage" },
            });
          }}
          onOpenProject={handleOpenProjectFromSearch}
          onImportThread={handleImportThread}
          onOpenThread={(threadId) => {
            activateThreadFromSidebarIntent(ThreadId.makeUnsafe(threadId));
          }}
        />
      ) : null}
    </>
  );
}

function SidebarSearchPaletteController(props: {
  open: boolean;
  mode: SidebarSearchPaletteMode;
  onModeChange: (mode: SidebarSearchPaletteMode) => void;
  onOpenChange: (open: boolean) => void;
  actions: readonly SidebarSearchAction[];
  projects: readonly SidebarSearchProject[];
  projectById: ReadonlyMap<ContainerId, { name: string; remoteName: string }>;
  onCreateChat: () => void;
  onCreateThread: () => void;
  onOpenSettings: () => void;
  onOpenFeedback: () => void;
  onOpenUsageSettings: () => void;
  onOpenProject: (projectId: string) => void;
  onImportThread: (provider: ImportProviderKind, externalId: string) => Promise<void>;
  onOpenThread: (threadId: string) => void;
}) {
  const selectAllThreads = useMemo(() => createAllThreadsSelector(), []);
  const selectSidebarDisplayThreads = useMemo(() => createSidebarDisplayThreadsSelector(), []);
  const importProviderCapabilityQueries = useQueries({
    queries: (["codex", "claudeAgent", "cursor", "kilo", "opencode"] as const).map((provider) =>
      providerComposerCapabilitiesQueryOptions(provider),
    ),
  });
  const threads = useStore(selectAllThreads);
  const sidebarDisplayThreads = useStore(selectSidebarDisplayThreads);
  const importProviders: ReadonlyArray<ImportProviderKind> = (
    ["codex", "claudeAgent", "cursor", "kilo", "opencode"] as const
  ).filter((provider, index) => supportsThreadImport(importProviderCapabilityQueries[index]?.data));
  const searchPaletteThreads = useMemo<SidebarSearchThread[]>(() => {
    const threadById = new Map(threads.map((thread) => [thread.id, thread] as const));
    const searchProjectById = new Map(
      props.projects.map((project) => [project.id, project] as const),
    );
    return sidebarDisplayThreads.flatMap((threadSummary) => {
      const thread = threadById.get(threadSummary.id);
      if (!thread) {
        return [];
      }

      return [
        {
          id: thread.id,
          title: thread.title,
          projectId: thread.projectId,
          projectName: props.projectById.get(thread.projectId)?.name ?? "Unknown folder",
          projectRemoteName:
            props.projectById.get(thread.projectId)?.remoteName ?? "Unknown folder",
          spaceName: searchProjectById.get(thread.projectId)?.spaceName ?? "Global",
          provider: thread.modelSelection.provider,
          createdAt: thread.createdAt,
          updatedAt: thread.updatedAt,
          messages: thread.messages.map((message) => ({
            text: message.text,
          })),
        },
      ];
    });
  }, [props.projectById, props.projects, sidebarDisplayThreads, threads]);

  return (
    <SidebarSearchPalette
      open={props.open}
      mode={props.mode}
      onModeChange={props.onModeChange}
      onOpenChange={props.onOpenChange}
      actions={props.actions}
      projects={props.projects}
      threads={searchPaletteThreads}
      onCreateChat={props.onCreateChat}
      onCreateThread={props.onCreateThread}
      onOpenSettings={props.onOpenSettings}
      onOpenFeedback={props.onOpenFeedback}
      onOpenUsageSettings={props.onOpenUsageSettings}
      onOpenProject={props.onOpenProject}
      importProviders={importProviders}
      onImportThread={props.onImportThread}
      onOpenThread={props.onOpenThread}
    />
  );
}
