// FILE: Sidebar.tsx
// Purpose: Renders the project/thread sidebar, including row status, sorting, and thread actions.
// Exports: Sidebar

import {
  MAX_PINNED_PROJECTS,
  FolderId,
  SpaceId,
  ThreadId,
  type DesktopUpdateState,
  type ResolvedKeybindingsConfig,
  type SidebarItemMovePosition,
  type SidebarItemParent,
  type SidebarItemReference,
} from "@penkra/contracts";
import type { DragEndEvent, DragOverEvent } from "@dnd-kit/react";
import { getDefaultModel } from "@penkra/shared/model";
import { pluralize } from "@penkra/shared/text";
import { resolveThreadWorkspaceCwd } from "@penkra/shared/threadEnvironment";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate, useParams } from "@tanstack/react-router";
import {
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
import {
  resolveDesktopAccountName,
  useDesktopAccountAuthState,
} from "~/hooks/useDesktopAccountAuthState";
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
import {
  moveSidebarItem,
  resolveSidebarInsertionIndex,
  resolveSidebarMovePosition,
} from "../lib/sidebarOrdering";
import { SquareImageError, compressSquareImage } from "../lib/squareImage";
import { isOrdinarySpaceProject } from "../lib/spaces";
import { archiveProject } from "../lib/projectArchive";
import { isTerminalFocused } from "../lib/terminalFocus";
import { dispatchThreadRename } from "../lib/threadRename";
import { isMacPlatform, newCommandId, newFolderId, newThreadId } from "../lib/utils";
import { readNativeApi } from "../nativeApi";
import { usePinnedFoldersStore } from "../pinnedFoldersStore";
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
import {
  DEBUG_FEATURE_FLAGS_MENU_STORAGE_KEY,
  beginInlineFolderCreation,
  buildProjectThreadTree,
  canArchiveSidebarFolder,
  canArchiveSidebarThreads,
  derivePinnedFolderIdsForSidebar,
  deriveSidebarProjectData,
  getNextVisibleSidebarThreadId,
  getSidebarThreadLifecycleMenuItems,
  getSidebarThreadIdsToPrewarm,
  getVisibleSidebarEntriesForPreview,
  groupSidebarThreadsByFolderId,
  isLatestPinnedProjectMutation,
  isFoldersSidebarSurface,
  orderPinnedFoldersForSidebar,
  orderSidebarSpaceItems,
  pruneProjectThreadListPagingForCollapsedFolders,
  resolveProjectHeaderState,
  resolveProjectStatusIndicator,
  resolveSidebarWorkStatus,
  resolveSidebarThreadListPaging,
  resolveThreadStatusPill,
  resolveVisibleThreadWorkStatus,
  shouldClearThreadSelectionOnMouseDown,
  shouldPrunePinnedThreads,
  shouldShowDebugFeatureFlagsMenu,
  sortFoldersForSidebar,
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
  areSidebarItemParentsEqual,
  canMoveSidebarItemToParent,
  readSidebarDndData,
  resolveSidebarDropPlacement,
  resolveSidebarItemDropTarget,
  type SidebarDropPlacement,
  type SidebarDropPreview,
  type SidebarItemDropTarget,
  sidebarItemDndId,
  sidebarParentDndGroup,
  sidebarSpaceDndId,
  SidebarContainerDropPreview,
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
import { SidebarFolders } from "./left-rail/sidebar-folders/SidebarFolders";
import { SidebarTopNavigation } from "./left-rail/sidebar-top-navigation/SidebarTopNavigation";
import { LeftRailContentShared } from "./left-rail/left-rail-content-shared/LeftRailContentShared";
import { SpaceGroupShared } from "./left-rail/space-group-shared/SpaceGroupShared";
import { SpaceHeaderInlineEdit } from "./left-rail/space-header-inline-edit/SpaceHeaderInlineEdit";
import {
  ThreadRowShared,
  type ThreadWorkStatus,
} from "./left-rail/thread-row-shared/ThreadRowShared";
import { ThreadRowInlineEdit } from "./left-rail/thread-row-inline-edit/ThreadRowInlineEdit";
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

function projectThreadListPagingKey(project: { id: FolderId; cwd: string }): string {
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
      dropTarget: SidebarItemDropTarget;
      placement: SidebarDropPlacement;
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
  | "set-icon"
  | "remove-icon"
  | "toggle-pin"
  | "archive";

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
  const folders = useStore((store) => store.folders);
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
  const persistThreadVisit = useCallback((threadId: ThreadId, lastVisitedAt: string) => {
    const api = readNativeApi();
    if (!api) return;
    void api.orchestration
      .dispatchCommand({
        type: "thread.update",
        commandId: newCommandId(),
        threadId,
        lastVisitedAt,
      })
      .catch(() => undefined);
  }, []);
  const toggleProject = useStore((store) => store.toggleProject);
  const setProjectExpanded = useStore((store) => store.setProjectExpanded);
  const terminalStateByThreadId = useTerminalStateStore((state) => state.terminalStateByThreadId);
  const clearTerminalState = useTerminalStateStore((state) => state.clearTerminalState);
  const openChatThreadPage = useTerminalStateStore((state) => state.openChatThreadPage);
  const openTerminalThreadPage = useTerminalStateStore((state) => state.openTerminalThreadPage);
  const draftThreadsByThreadId = useComposerDraftStore((store) => store.draftThreadsByThreadId);
  const persistedPinnedFolderIds = usePinnedFoldersStore((store) => store.pinnedFolderIds);
  const pinProjectLocally = usePinnedFoldersStore((store) => store.pinProject);
  const unpinProject = usePinnedFoldersStore((store) => store.unpinProject);
  const prunePinnedFolders = usePinnedFoldersStore((store) => store.prunePinnedFolders);
  const homeDir = useWorkspacePathsStore((store) => store.homeDir);
  const { authState: desktopAccountAuthState } = useDesktopAccountAuthState();
  const accountName = resolveDesktopAccountName(desktopAccountAuthState);
  const chatWorkspaceRoot = useWorkspacePathsStore((store) => store.chatWorkspaceRoot);
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
    if (!api || !threadsHydrated || folders.length > 0) {
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
            snapshot.folders.length === 0 &&
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
  }, [folders.length, syncServerShellSnapshot, threadsHydrated]);

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
  const { activeDraftThread, activeFolderId: focusedFolderId } = useFocusedChatContext();
  const latestFolderId = useLatestProjectStore((state) => state.latestFolderId);
  const [creatingFolderSpaceId, setCreatingFolderSpaceId] = useState<SpaceId | null>(null);
  const [searchPaletteOpen, setSearchPaletteOpen] = useState(false);
  const folderIconInputRef = useRef<HTMLInputElement>(null);
  const folderIconTargetFolderIdRef = useRef<FolderId | null>(null);
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
  const openInlineFolderCreator = useCallback(
    (spaceId: SpaceId | null = activeSpaceId) => {
      if (!spaceId) return;
      setCreatingFolderSpaceId(spaceId);
      setCollapsedSpaceIds((current) => {
        if (!current.has(spaceId)) return current;
        const next = new Set(current);
        next.delete(spaceId);
        return next;
      });
    },
    [activeSpaceId],
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
  const optimisticPinnedStateByFolderIdRef = useRef(new Map<FolderId, boolean>());
  const latestPinnedMutationVersionByFolderIdRef = useRef(new Map<FolderId, number>());
  const [desktopUpdateState, setDesktopUpdateState] = useState<DesktopUpdateState | null>(null);
  const [installingDesktopUpdate, setInstallingDesktopUpdate] = useState(false);
  const [optimisticPinnedStateByFolderId, setOptimisticPinnedStateByFolderId] = useState<
    ReadonlyMap<FolderId, boolean>
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
        const visitedAt = thread.latestTurn?.completedAt ?? new Date().toISOString();
        markThreadVisited(threadId, visitedAt);
        persistThreadVisit(threadId, visitedAt);
        return;
      }
      dismissThreadStatus(threadId, threadStatus.dismissalKey);
    },
    [
      dismissThreadStatus,
      markThreadVisited,
      persistThreadVisit,
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
    () => new Map(folders.map((project) => [project.id, project] as const)),
    [folders],
  );
  const {
    pinnedThreadIds,
    pinnedThreadIdSet,
    toggleThreadPinned,
    confirmAndDeleteThread,
    archiveThread,
    confirmAndArchiveThread,
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
    projectRunsByFolderId,
    projectRunServerByFolderId,
    projectRunDialogFolderId,
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
    folders,
    projectById,
    homeDir,
    chatWorkspaceRoot,
  });
  const activeRouteFolderId = routeThreadId
    ? (sidebarThreadSummaryById[routeThreadId]?.folderId ??
      draftThreadsByThreadId[routeThreadId]?.folderId ??
      null)
    : null;
  const activeRouteProject = activeRouteFolderId
    ? (projectById.get(activeRouteFolderId) ?? null)
    : null;
  const ordinarySpaceFolders = useMemo(
    () =>
      folders.filter((project) =>
        isOrdinarySpaceProject(project, {
          homeDir,
          chatWorkspaceRoot,
        }),
      ),
    [chatWorkspaceRoot, homeDir, folders],
  );
  const folderNamesBySpaceId = useMemo(() => {
    const namesBySpaceId = new Map<SpaceId, string[]>();
    for (const project of ordinarySpaceFolders) {
      if (!project.spaceId) continue;
      const names = namesBySpaceId.get(project.spaceId) ?? [];
      names.push(project.name);
      if (project.remoteName !== project.name) names.push(project.remoteName);
      namesBySpaceId.set(project.spaceId, names);
    }
    return namesBySpaceId;
  }, [ordinarySpaceFolders]);

  const projectCwdById = useMemo(
    () => new Map(folders.map((project) => [project.id, project.cwd] as const)),
    [folders],
  );
  const projectByIdRef = useRef(projectById);
  useEffect(() => {
    projectByIdRef.current = projectById;
  }, [projectById]);
  const setOptimisticProjectPinned = useCallback((folderId: FolderId, isPinned: boolean) => {
    optimisticPinnedStateByFolderIdRef.current.set(folderId, isPinned);
    setOptimisticPinnedStateByFolderId((current) => {
      if (current.get(folderId) === isPinned) {
        return current;
      }
      const next = new Map(current);
      next.set(folderId, isPinned);
      return next;
    });
  }, []);
  const clearOptimisticProjectPinned = useCallback((folderId: FolderId) => {
    optimisticPinnedStateByFolderIdRef.current.delete(folderId);
    setOptimisticPinnedStateByFolderId((current) => {
      if (!current.has(folderId)) {
        return current;
      }
      const next = new Map(current);
      next.delete(folderId);
      return next;
    });
  }, []);
  const dispatchProjectPinnedState = useCallback(async (folderId: FolderId, isPinned: boolean) => {
    const api = readNativeApi();
    if (!api) return;
    await api.orchestration.dispatchCommand({
      type: "folder.update",
      commandId: newCommandId(),
      folderId,
      isPinned,
    });
  }, []);
  const setProjectPinned = useCallback(
    async (folderId: FolderId, isPinned: boolean) => {
      const api = readNativeApi();
      if (!api) return;
      const project = projectByIdRef.current.get(folderId);
      if (!project) {
        return;
      }
      const requestVersion =
        (latestPinnedMutationVersionByFolderIdRef.current.get(folderId) ?? 0) + 1;
      latestPinnedMutationVersionByFolderIdRef.current.set(folderId, requestVersion);

      setOptimisticProjectPinned(folderId, isPinned);
      if (isPinned) {
        const accepted = pinProjectLocally(folderId);
        if (!accepted) {
          clearOptimisticProjectPinned(folderId);
          toastManager.add({
            type: "warning",
            title: "Folder pin limit reached",
            description: `You can pin up to ${MAX_PINNED_PROJECTS} folders.`,
          });
          return;
        }
      } else {
        unpinProject(folderId);
      }

      try {
        await dispatchProjectPinnedState(folderId, isPinned);
      } catch (error) {
        if (
          !isLatestPinnedProjectMutation({
            folderId,
            requestVersion,
            latestMutationVersionByFolderId: latestPinnedMutationVersionByFolderIdRef.current,
          })
        ) {
          return;
        }

        const confirmedPinned = projectByIdRef.current.get(folderId)?.isPinned === true;
        if (confirmedPinned) {
          pinProjectLocally(folderId);
        } else {
          unpinProject(folderId);
        }
        clearOptimisticProjectPinned(folderId);
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
    (folderId: FolderId) => {
      const optimisticPinned = optimisticPinnedStateByFolderIdRef.current.get(folderId);
      const locallyPinned = usePinnedFoldersStore.getState().pinnedFolderIds.includes(folderId);
      const serverPinned = projectByIdRef.current.get(folderId)?.isPinned === true;
      const isPinned = optimisticPinned ?? (locallyPinned || serverPinned);
      void setProjectPinned(folderId, !isPinned).catch((error) => {
        console.error("Failed to update pinned project state", {
          folderId,
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
    if (optimisticPinnedStateByFolderId.size === 0) {
      return;
    }

    const serverPinnedStateByFolderId = new Map(
      folders.map((project) => [project.id, project.isPinned === true] as const),
    );
    // Reconciliation drops optimistic entries the server has confirmed while syncing
    // the mirror ref. Deferring the setState off render (async is allowed) leaves the
    // derived pinned lists unchanged, since a confirmed entry is redundant either way.
    const settle = window.setTimeout(() => {
      setOptimisticPinnedStateByFolderId((current) => {
        const reconciled = reconcileOptimisticPinState({
          optimisticPinnedStateById: current,
          serverPinnedStateById: serverPinnedStateByFolderId,
        });
        for (const folderId of reconciled.settledIds) {
          optimisticPinnedStateByFolderIdRef.current.delete(folderId);
        }
        return reconciled.optimisticPinnedStateById;
      });
    }, 0);
    return () => window.clearTimeout(settle);
  }, [optimisticPinnedStateByFolderId, folders]);
  const focusMostRecentThreadForProject = useCallback(
    (folderId: FolderId) => {
      const latestThread = sortThreadsForSidebar(
        sidebarThreads.filter((thread) => thread.folderId === folderId),
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

  const handleOpenProjectFromSearch = useCallback(
    (folderId: string) => {
      const typedFolderId = FolderId.makeUnsafe(folderId);
      const hasProjectThread = sidebarThreads.some((thread) => thread.folderId === typedFolderId);
      if (hasProjectThread) {
        focusMostRecentThreadForProject(typedFolderId);
        return;
      }

      void handleNewThread(typedFolderId);
    },
    [focusMostRecentThreadForProject, handleNewThread, sidebarThreads],
  );

  // Opens a fresh draft in the Space's default folder.
  const handleCreateSpaceThread = useCallback(
    async (spaceId: SpaceId) => {
      await handleNewChat({ fresh: true, spaceId });
    },
    [handleNewChat],
  );

  const handleStartAddProject = useCallback(() => {
    openInlineFolderCreator();
  }, [openInlineFolderCreator]);

  const activeSpaceFolders = useMemo(
    () => ordinarySpaceFolders.filter((project) => (project.spaceId ?? null) === activeSpaceId),
    [activeSpaceId, ordinarySpaceFolders],
  );
  const currentProjectShortcutTargetId = useMemo(
    () => resolveCurrentProjectTargetId(activeSpaceFolders, focusedFolderId),
    [activeSpaceFolders, focusedFolderId],
  );
  const latestUsableFolderId = useMemo(
    () => resolveLatestProjectTargetIdWithFallback(activeSpaceFolders, latestFolderId),
    [activeSpaceFolders, latestFolderId],
  );
  const primaryNewThreadTarget = useMemo(
    () =>
      resolveNewThreadTarget({
        currentFolderId: currentProjectShortcutTargetId,
        latestUsableFolderId,
      }),
    [currentProjectShortcutTargetId, latestUsableFolderId],
  );

  // Warm model discovery before ChatView mounts so new-thread composers skip
  // the "Loading models" skeleton when React Query already has a fresh cache hit.
  const prefetchModelsForProjectNewThread = useCallback(
    (folderId: FolderId, options?: { includeDroid?: boolean }) => {
      const project = folders.find((candidate) => candidate.id === folderId);
      if (!project) {
        return;
      }

      const draftStore = useComposerDraftStore.getState();
      const draftThread = draftStore.getDraftThreadByFolderId(folderId, "chat");
      const draftComposer = draftThread
        ? (draftStore.draftsByThreadId[draftThread.threadId] ?? null)
        : null;
      const provider = resolveNewThreadModelPrefetchProvider({
        draftActiveProvider: draftComposer?.activeProvider ?? null,
        stickyActiveProvider: draftStore.stickyActiveProvider,
        projectDefaultProvider: project.defaultModelSelection?.provider ?? null,
        defaultProvider: appSettings.defaultProvider,
      });
      const cwd = resolveNewThreadModelPrefetchCwd({
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
    [appSettings, folders, queryClient, serverCwd],
  );

  useEffect(() => {
    if (!primaryNewThreadTarget) {
      return;
    }
    prefetchModelsForProjectNewThread(primaryNewThreadTarget.folderId);
  }, [prefetchModelsForProjectNewThread, primaryNewThreadTarget]);

  const handlePrimaryNewThread = useCallback(() => {
    if (primaryNewThreadTarget) {
      prefetchModelsForProjectNewThread(primaryNewThreadTarget.folderId, {
        includeDroid: true,
      });
      void handleNewThread(primaryNewThreadTarget.folderId);
      return;
    }

    // The folders snapshot can be temporarily empty during startup. Wait for hydration
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

      const activeProject = folders.find(
        (project) => project.id === currentProjectShortcutTargetId,
      );
      if (!activeProject) {
        throw new Error("The target folder could not be resolved.");
      }

      const providerDefaultModel = getDefaultModel(provider);
      const modelSelection =
        activeProject.defaultModelSelection?.provider === provider
          ? activeProject.defaultModelSelection
          : {
              provider,
              model: providerDefaultModel,
            };
      const threadId = newThreadId();
      const createdAt = new Date().toISOString();
      const trimmedExternalId = externalId.trim();
      const suffix = trimmedExternalId.slice(-8);
      const title =
        provider === "claudeAgent"
          ? `Imported Claude session${suffix ? ` ${suffix}` : ""}`
          : provider === "opencode"
            ? `Imported OpenCode session${suffix ? ` ${suffix}` : ""}`
            : `Imported Codex thread${suffix ? ` ${suffix}` : ""}`;
      let createdThread = false;

      try {
        await api.orchestration.dispatchCommand({
          type: "thread.create",
          commandId: newCommandId(),
          threadId,
          folderId: activeProject.id,
          title,
          modelSelection,
          runtimeMode: "full-access",
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
    [currentProjectShortcutTargetId, navigate, folders],
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

  const commitFolderRename = useCallback(async (folderId: FolderId, title: string) => {
    const api = readNativeApi();
    if (!api) {
      throw new Error("Folder rename is unavailable while disconnected.");
    }
    await api.orchestration.dispatchCommand({
      type: "folder.update",
      commandId: newCommandId(),
      folderId,
      title,
    });
  }, []);

  const updateFolderIcon = useCallback(async (folderId: FolderId, iconDataUrl: string | null) => {
    const api = readNativeApi();
    if (!api) throw new Error("Folder icon editing is unavailable while disconnected.");
    await api.orchestration.dispatchCommand({
      type: "folder.update",
      commandId: newCommandId(),
      folderId,
      iconDataUrl,
    });
  }, []);

  const handleFolderIconFile = useCallback(
    async (file: File | undefined) => {
      const folderId = folderIconTargetFolderIdRef.current;
      if (!file || !folderId) return;
      try {
        const iconDataUrl = await compressSquareImage(file, {
          maxEdge: 64,
          quality: 0.84,
          maxDataUrlLength: 100_000,
        });
        await updateFolderIcon(folderId, iconDataUrl);
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Unable to add folder icon",
          description:
            error instanceof SquareImageError || error instanceof Error
              ? error.message
              : "The selected image could not be processed.",
        });
      }
    },
    [updateFolderIcon],
  );

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
      const canArchive =
        threadSummary !== undefined &&
        canArchiveSidebarThreads([
          resolveVisibleThreadWorkStatus({
            status: threadStatus,
            isRecording: threadId === voiceRecordingThreadId,
            projectedWorkStatus: threadSummary.workStatus,
          }),
        ]);
      const threadWorkspacePath = resolveThreadWorkspaceCwd({
        projectCwd: projectCwdById.get(thread.folderId) ?? null,
        workingDirectory: thread.workingDirectory,
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
          ...getSidebarThreadLifecycleMenuItems(canArchive),
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
        const completedAt = thread.latestTurn?.completedAt;
        if (completedAt) {
          const completedAtMs = Date.parse(completedAt);
          if (!Number.isNaN(completedAtMs)) {
            persistThreadVisit(threadId, new Date(completedAtMs - 1).toISOString());
          }
        }
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
      persistThreadVisit,
      openThreadInlineRename,
      pinnedThreadIdSet,
      projectCwdById,
      resolveThreadStatusForSidebar,
      sidebarThreadSummaryById,
      toggleThreadPinned,
      voiceRecordingThreadId,
    ],
  );
  const handleMultiSelectContextMenu = useCallback(
    async (position: { x: number; y: number }) => {
      const api = readNativeApi();
      if (!api) return;
      const ids = [...selectedThreadIds];
      if (ids.length === 0) return;
      const count = ids.length;
      const canArchive = canArchiveSidebarThreads(
        ids.map((id) => {
          const thread = sidebarThreadSummaryById[id];
          if (!thread) return "attention";
          return resolveVisibleThreadWorkStatus({
            status: resolveThreadStatusForSidebar(thread),
            isRecording: id === voiceRecordingThreadId,
            projectedWorkStatus: thread.workStatus,
          });
        }),
      );

      const clicked = await api.contextMenu.show(
        [
          { id: "mark-unread", label: `Mark unread (${count})` },
          ...(canArchive ? [{ id: "archive", label: `Archive (${count})` }] : []),
        ],
        position,
      );

      if (clicked === "mark-unread") {
        for (const id of ids) {
          clearDismissedThreadStatus(id);
          markThreadUnread(id);
          const completedAt = sidebarThreadSummaryById[id]?.latestTurn?.completedAt;
          if (completedAt) {
            const completedAtMs = Date.parse(completedAt);
            if (!Number.isNaN(completedAtMs)) {
              persistThreadVisit(id, new Date(completedAtMs - 1).toISOString());
            }
          }
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
    },
    [
      appSettings.confirmThreadArchive,
      archiveThread,
      clearSelection,
      clearDismissedThreadStatus,
      markThreadUnread,
      persistThreadVisit,
      removeFromSelection,
      resolveThreadStatusForSidebar,
      selectedThreadIds,
      sidebarThreadSummaryById,
      voiceRecordingThreadId,
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
    handleArchiveSpace,
    handleMoveProjectToSpace,
    handleSpaceEditorSubmit,
  } = useSpacesController({
    ordinarySpaceFolders,
    projectById,
    sidebarThreads,
    sidebarThreadSortOrder: appSettings.sidebarThreadSortOrder,
    routeThreadId,
    activeRouteProject,
    activeRouteFolderId,
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
      if (clicked === "add-folder") {
        beginInlineFolderCreation({
          spaceId: space.id,
          selectSpaceForIncomingProject: handleSelectSpaceForIncomingProject,
          openInlineFolderCreator,
        });
        return;
      }
      if (clicked === "rename") {
        openSpaceEditor(space.id);
        return;
      }
      if (clicked === "archive") {
        await handleArchiveSpace(space.id);
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
    [
      collapsedSpaceIds,
      handleSelectSpaceForIncomingProject,
      handleArchiveSpace,
      openInlineFolderCreator,
      openSpaceEditor,
    ],
  );
  const handleCreateProjectSubmit = useCallback(
    async (value: { readonly name: string; readonly spaceId: SpaceId }) => {
      const previousSpaceId = activeSpaceId;
      const api = readNativeApi();
      if (!api) throw new Error("The app server is unavailable.");
      const folderId = newFolderId();
      const defaultCodexModel = getDefaultModel("codex");
      handleSelectSpaceForIncomingProject(value.spaceId);
      try {
        await api.orchestration.dispatchCommand({
          type: "folder.create",
          commandId: newCommandId(),
          folderId,
          title: value.name,
          workspaceRoot: null,
          ...(defaultCodexModel
            ? { defaultModelSelection: { provider: "codex", model: defaultCodexModel } }
            : {}),
          spaceId: value.spaceId,
          createdAt: new Date().toISOString(),
        });
        setProjectExpanded(folderId, true);
        // The accepted command is already durable. The unified synchronization
        // stream installs the Folder in the canonical store independently; the
        // draft only needs the known parent Space to open immediately.
        await handleNewThread(folderId, { fresh: true, spaceId: value.spaceId });
      } catch (error) {
        if (previousSpaceId) handleSelectSpaceForIncomingProject(previousSpaceId);
        throw error;
      }
    },
    [activeSpaceId, handleNewThread, handleSelectSpaceForIncomingProject, setProjectExpanded],
  );
  const handleProjectContextMenuAction = useCallback(
    async (folderId: FolderId, clicked: ProjectContextMenuId) => {
      const api = readNativeApi();
      if (!api) return;
      const project = projectById.get(folderId);
      if (!project) return;
      const physicalPath =
        sidebarThreads
          .filter((thread) => thread.folderId === folderId && Boolean(thread.workingDirectory))
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
        openProjectRunDialog(folderId);
        return;
      }
      if (clicked === "stop-dev") {
        await handleStopProjectRun(folderId);
        return;
      }
      if (clicked === "open-dev-server") {
        await handleOpenProjectRunServer(folderId);
        return;
      }
      if (clicked === "rename") {
        startFolderInlineRename(folderId, project.name);
        return;
      }
      if (clicked === "set-icon") {
        folderIconTargetFolderIdRef.current = folderId;
        if (api.dialogs.pickImage) {
          const pickedImage = await api.dialogs.pickImage();
          if (pickedImage) {
            await handleFolderIconFile(
              new File([Uint8Array.from(pickedImage.bytes)], pickedImage.name, {
                type: pickedImage.mimeType,
              }),
            );
          }
          return;
        }
        folderIconInputRef.current?.click();
        return;
      }
      if (clicked === "remove-icon") {
        await updateFolderIcon(folderId, null);
        return;
      }
      if (clicked === "toggle-pin") {
        toggleProjectPinned(folderId);
        return;
      }
      if (clicked === "archive") {
        try {
          await archiveProject(api, folderId);
        } catch (error) {
          toastManager.add({
            type: "error",
            title: "Unable to archive folder",
            description: error instanceof Error ? error.message : "Try again.",
          });
        }
      }
    },
    [
      copyPathToClipboard,
      handleOpenProjectRunServer,
      handleStopProjectRun,
      handleFolderIconFile,
      openProjectRunDialog,
      projectById,
      sidebarThreads,
      startFolderInlineRename,
      toggleProjectPinned,
      updateFolderIcon,
    ],
  );

  async function handleProjectContextMenu(folderId: FolderId, position: { x: number; y: number }) {
    const api = readNativeApi();
    const project = projectById.get(folderId);
    if (!api || !project) return;

    const projectThreads = sidebarThreads.filter((thread) => thread.folderId === folderId);
    const physicalPath =
      projectThreads
        .filter((thread) => Boolean(thread.workingDirectory))
        .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt))[0]
        ?.workingDirectory?.trim() ||
      project.cwd ||
      null;
    const isPinned = pinnedFolderIdSet.has(folderId);
    const isRunning = Boolean(projectRunsByFolderId[folderId]);
    const projectRunServer = projectRunServerByFolderId.get(folderId) ?? null;
    const hasOpenServer =
      projectRunServer !== null && firstLocalServerUrl(projectRunServer) !== null;
    const canArchive = canArchiveSidebarFolder(
      projectThreads.map((thread) =>
        resolveVisibleThreadWorkStatus({
          status: resolveThreadStatusForSidebar(thread),
          isRecording: thread.id === voiceRecordingThreadId,
          projectedWorkStatus: thread.workStatus,
        }),
      ),
    );
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
      { id: "set-icon", label: project.iconDataUrl ? "Change icon…" : "Add icon…" },
      ...(project.iconDataUrl ? [{ id: "remove-icon" as const, label: "Remove icon" }] : []),
      { id: "toggle-pin", label: pinActionLabel("folder", isPinned) },
    );
    if (canArchive) {
      items.push({ id: "archive", label: "Archive folder", separatorBefore: true });
    }

    const clicked = await api.contextMenu.show<ProjectNativeContextMenuId>(items, position);
    if (!clicked) return;
    if (clicked === "new-space") {
      openSpaceCreator(folderId);
      return;
    }
    if (isMoveProjectToSpaceContextMenuId(clicked)) {
      const spaceId = clicked.slice(MOVE_PROJECT_TO_SPACE_CONTEXT_MENU_PREFIX.length);
      if (spaces.some((space) => space.id === spaceId)) {
        await handleMoveProjectToSpace(folderId, SpaceId.makeUnsafe(spaceId));
      }
      return;
    }
    await handleProjectContextMenuAction(folderId, clicked);
  }

  // Trees need child (subagent) threads too; the flat display list stays
  // root-only for pinned rows and other non-tree consumers.
  const sidebarThreadsByFolderId = useMemo(
    () => groupSidebarThreadsByFolderId(sidebarTreeThreads),
    [sidebarTreeThreads],
  );
  const sortedSidebarThreadsByFolderId = useMemo(() => {
    const byFolderId = new Map<FolderId, SidebarThreadSummary[]>();
    for (const [folderId, projectThreads] of sidebarThreadsByFolderId) {
      byFolderId.set(
        folderId,
        sortThreadsForSidebar(projectThreads, appSettings.sidebarThreadSortOrder),
      );
    }
    return byFolderId;
  }, [appSettings.sidebarThreadSortOrder, sidebarThreadsByFolderId]);
  const sortedFolders = useMemo(
    () => sortFoldersForSidebar(folders, sidebarThreads, appSettings.sidebarProjectSortOrder),
    [appSettings.sidebarProjectSortOrder, folders, sidebarThreads],
  );
  const allStandardFoldersBase = useMemo(
    () =>
      sortedFolders.filter((project) =>
        isOrdinarySpaceProject(project, {
          homeDir,
          chatWorkspaceRoot,
        }),
      ),
    [chatWorkspaceRoot, homeDir, sortedFolders],
  );
  const standardFoldersBase = useMemo(() => allStandardFoldersBase, [allStandardFoldersBase]);
  const pinnedFolderIds = useMemo(
    () =>
      derivePinnedFolderIdsForSidebar({
        folders: standardFoldersBase,
        persistedPinnedFolderIds,
        optimisticPinnedStateByFolderId,
      }),
    [optimisticPinnedStateByFolderId, persistedPinnedFolderIds, standardFoldersBase],
  );
  const pinnedFolderIdSet = useMemo(() => new Set(pinnedFolderIds), [pinnedFolderIds]);
  const standardFolders = useMemo(
    () => orderPinnedFoldersForSidebar(standardFoldersBase, pinnedFolderIds),
    [pinnedFolderIds, standardFoldersBase],
  );
  const sidebarSpaceSections = useMemo(() => {
    const sections = spaces.map((space) => {
      const folders = standardFolders.filter((project) => project.spaceId === space.id);
      const projectItems = folders.map((project) => ({
        kind: "folder" as const,
        id: project.id,
        project,
      }));
      const items = orderSidebarSpaceItems<never, (typeof projectItems)[number]>({
        threadItems: [],
        projectItems: projectItems.map((item) => ({
          id: item.id,
          pinned: pinnedFolderIdSet.has(item.id),
          sidebarSortOrder: item.project.sidebarSortOrder ?? 0,
          threads: sortedSidebarThreadsByFolderId.get(item.id) ?? [],
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
      };
    });
    return sections;
  }, [
    appSettings.sidebarThreadSortOrder,
    pinnedFolderIdSet,
    sortedSidebarThreadsByFolderId,
    spaces,
    standardFolders,
  ]);
  const isSidebarItemPinned = useCallback(
    (item: SidebarItemReference) =>
      item.kind === "folder" ? pinnedFolderIdSet.has(item.id) : pinnedThreadIdSet.has(item.id),
    [pinnedFolderIdSet, pinnedThreadIdSet],
  );
  const getOrderedSidebarItems = useCallback(
    (parent: SidebarItemParent): SidebarItemReference[] => {
      if (parent.kind === "folder") {
        return (sortedSidebarThreadsByFolderId.get(parent.folderId) ?? [])
          .filter((thread) => thread.parentThreadId == null && thread.archivedAt == null)
          .map((thread) => ({ kind: "thread" as const, id: thread.id }));
      }

      const projectItems = standardFolders
        .filter((project) => project.spaceId === parent.spaceId)
        .map((project) => ({
          id: project.id,
          pinned: pinnedFolderIdSet.has(project.id),
          sidebarSortOrder: project.sidebarSortOrder ?? 0,
          threads: sortedSidebarThreadsByFolderId.get(project.id) ?? [],
          fallbackCreatedAt: project.createdAt,
          fallbackUpdatedAt: project.updatedAt,
          value: { kind: "folder" as const, id: project.id },
        }));
      return orderSidebarSpaceItems<never, SidebarItemReference>({
        threadItems: [],
        projectItems,
        sortOrder: appSettings.sidebarThreadSortOrder,
      });
    },
    [
      appSettings.sidebarThreadSortOrder,
      pinnedFolderIdSet,
      sortedSidebarThreadsByFolderId,
      standardFolders,
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
    (
      event: Pick<DragOverEvent, "operation">,
      placement: SidebarDropPlacement,
    ): SidebarDropPreview | null | undefined => {
      const source = event.operation.source;
      const sourceData = readSidebarDndData(source?.data);
      const targetData = readSidebarDndData(event.operation.target?.data);
      if (!sourceData || !targetData) {
        sidebarDropIntentRef.current = null;
        return null;
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
        return sourceData.spaceId === targetData.spaceId
          ? null
          : {
              kind: "space",
              placement,
              targetSpaceId: targetData.spaceId,
            };
      }

      if (sourceData.type !== "item") {
        sidebarDropIntentRef.current = null;
        return null;
      }
      const dropTarget = resolveSidebarItemDropTarget(sourceData.item, targetData);
      if (dropTarget) {
        if (
          dropTarget.targetKind === "container" &&
          areSidebarItemParentsEqual(sourceData.parent, dropTarget.parent) &&
          sidebarDropIntentRef.current?.kind === "item" &&
          sidebarDropIntentRef.current.dropTarget.targetKind === "item" &&
          areSidebarItemParentsEqual(
            sidebarDropIntentRef.current.dropTarget.parent,
            dropTarget.parent,
          )
        ) {
          return;
        }
        sidebarDropIntentRef.current = {
          kind: "item",
          dropTarget,
          placement,
        };
        if (dropTarget.targetKind === "item") {
          return {
            kind: "item",
            anchorItem: dropTarget.targetItem,
            parent: dropTarget.parent,
            placement,
            targetKind: "item",
          };
        }
        const destinationItems = getOrderedSidebarItems(dropTarget.parent).filter(
          (candidate) =>
            candidate.kind !== sourceData.item.kind || candidate.id !== sourceData.item.id,
        );
        const insertionIndex = resolveSidebarInsertionIndex({
          item: sourceData.item,
          destinationItems,
          requestedIndex: destinationItems.filter(isSidebarItemPinned).length,
          isPinned: isSidebarItemPinned,
        });
        const nextItem = destinationItems[insertionIndex];
        const previousItem = destinationItems[insertionIndex - 1];
        return {
          kind: "item",
          anchorItem: nextItem ?? previousItem ?? null,
          parent: dropTarget.parent,
          placement: nextItem ? "before" : previousItem ? "after" : "before",
          targetKind: "container",
        };
      }
      // Collision ownership can return to the source as the pointer crosses
      // nested row bounds. Preserve the last real sibling target so drag-end
      // retains the intended before/after position.
      if (
        targetData.type === "item" &&
        targetData.item.kind === sourceData.item.kind &&
        targetData.item.id === sourceData.item.id
      ) {
        return;
      }
      sidebarDropIntentRef.current = null;
      return null;
    },
    [getOrderedSidebarItems, isSidebarItemPinned],
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
        if (intent?.kind === "space") {
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

      const finalDropTarget = resolveSidebarItemDropTarget(
        sourceData.item,
        readSidebarDndData(event.operation.target?.data),
      );
      const intendedDrop = finalDropTarget
        ? {
            dropTarget: finalDropTarget,
            placement: resolveSidebarDropPlacement(event),
          }
        : intent?.kind === "item"
          ? intent
          : null;
      if (!intendedDrop) return;
      const dropTarget = intendedDrop.dropTarget;
      const target = dropTarget.parent;
      if (!target || !canMoveSidebarItemToParent(sourceData.item, target)) return;
      const destinationItems = getOrderedSidebarItems(target).filter(
        (candidate) =>
          candidate.kind !== sourceData.item.kind || candidate.id !== sourceData.item.id,
      );
      const targetIndex =
        dropTarget.targetKind === "item"
          ? destinationItems.findIndex(
              (candidate) =>
                candidate.kind === dropTarget.targetItem.kind &&
                candidate.id === dropTarget.targetItem.id,
            )
          : -1;
      const requestedIndex =
        targetIndex >= 0
          ? targetIndex + (intendedDrop.placement === "after" ? 1 : 0)
          : destinationItems.filter(isSidebarItemPinned).length;
      const position = resolveSidebarMovePosition({
        item: sourceData.item,
        destinationItems,
        requestedIndex,
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
  const standardProjectSidebarDataById = useMemo<ReadonlyMap<FolderId, SidebarDerivedProjectData>>(
    () =>
      deriveSidebarProjectData({
        folders: standardFolders,
        sortedSidebarThreadsByFolderId,
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
      sortedSidebarThreadsByFolderId,
      standardFolders,
      resolveThreadStatusForSidebar,
    ],
  );
  // Reset per-project preview paging when a folder closes so reopening starts at five rows again.
  useEffect(() => {
    const settle = window.setTimeout(() => {
      setThreadListExtraPagesByProjectCwd((current) =>
        pruneProjectThreadListPagingForCollapsedFolders({
          threadListExtraPagesByProjectCwd: current,
          folders: standardFolders,
          normalizeProjectCwd: normalizeSidebarProjectThreadListCwd,
          getProjectPagingKey: projectThreadListPagingKey,
        }),
      );
    }, 0);
    return () => window.clearTimeout(settle);
  }, [standardFolders]);

  useEffect(() => {
    if (!shouldPrunePinnedThreads({ threadsHydrated })) {
      return;
    }
    prunePinnedFolders(allStandardFoldersBase.map((project) => project.id));
  }, [allStandardFoldersBase, prunePinnedFolders, threadsHydrated]);

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

  function renderPencilProjectItem(project: (typeof sortedFolders)[number], sortableIndex: number) {
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
      inlineRenameEditor?.kind === "folder" && inlineRenameEditor.folderId === project.id;
    const existingFolderNames = folders
      .filter((candidate) => candidate.id !== project.id && candidate.spaceId === project.spaceId)
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
        id={sidebarItemDndId({ kind: "folder", id: project.id })}
        group={sidebarParentDndGroup({
          kind: "space",
          spaceId: project.spaceId,
        })}
        index={sortableIndex}
        data={{
          type: "item",
          item: { kind: "folder", id: project.id },
          parent: { kind: "space", spaceId: project.spaceId },
          label: project.name,
          preview: {
            kind: "folder",
            label: project.name,
            expanded: project.expanded,
            pinned: pinnedFolderIdSet.has(project.id),
            workStatus: projectWorkStatus,
          },
        }}
      >
        <SidebarContainerDropTarget
          id={`sidebar-container:project:${project.id}`}
          className="relative"
          data={{
            type: "container",
            parent: { kind: "folder", folderId: project.id },
            label: project.name,
          }}
        >
          <FolderGroupShared
            expanded={project.expanded}
            hasContent={hasProjectContent}
            headerState={resolveProjectHeaderState({
              folderId: project.id,
              activeDraftFolderId: activeDraftThread?.folderId,
              activeDraftPromotedTo: activeDraftThread?.promotedTo,
            })}
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
                    finishInlineRename({ kind: "folder", folderId: project.id });
                  }}
                  onValueChange={updateInlineRenameValue}
                  pinned={pinnedFolderIdSet.has(project.id)}
                  value={inlineRenameEditor.value}
                />
              ) : undefined
            }
            label={project.name}
            {...(project.iconDataUrl === undefined ? {} : { iconDataUrl: project.iconDataUrl })}
            onExpandedChange={(nextExpanded) => {
              if (!nextExpanded) setThreadListExtraPagesForProject(pagingKey, 0);
              toggleProject(project.id);
            }}
            onHeaderAction={createProjectThread}
            onHeaderContextMenu={openProjectContextMenu}
            pinned={pinnedFolderIdSet.has(project.id)}
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
                        parent: { kind: "folder", folderId: project.id },
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
          <SidebarContainerDropPreview
            enabled={!project.expanded || !hasProjectContent}
            parent={{ kind: "folder", folderId: project.id }}
          />
        </SidebarContainerDropTarget>
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
    // The server rollup is intentionally coarse and can remain `done` until its
    // visit acknowledgement reaches the next snapshot. The visible row icon is
    // visit-aware, so derive it from the resolved pill instead of falling back
    // to that transient rollup; a neutral/seen thread must render no icon.
    const workStatus: ThreadWorkStatus = resolveVisibleThreadWorkStatus({
      status: threadStatus,
      isRecording: thread.id === voiceRecordingThreadId,
      projectedWorkStatus: thread.workStatus,
    });
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
        openInlineFolderCreator();
        return;
      }
      // The route-level new-thread handler owns normal creation. When no project
      // exists it deliberately leaves the event untouched so the sidebar can
      // surface the project prerequisite instead of turning the shortcut into a
      // silent no-op.
      if (command === "chat.new" && threadsHydrated && !primaryNewThreadTarget) {
        event.preventDefault();
        event.stopPropagation();
        openInlineFolderCreator();
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
          !isFoldersSidebarSurface({
            isOnSettings,
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
          !isFoldersSidebarSurface({
            isOnSettings,
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
    openInlineFolderCreator,
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
  const searchPaletteFolders = useMemo<SidebarSearchProject[]>(
    () =>
      folders.flatMap((project) => {
        let spaceName = "Global";
        if (
          isOrdinarySpaceProject(project, {
            homeDir,
            chatWorkspaceRoot,
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
            // Managed chat containers are reachable from every Space, so they search as "Global".
            spaceName,
            createdAt: project.createdAt,
            updatedAt: project.updatedAt,
          },
        ];
      }),
    [archivedSpaces, chatWorkspaceRoot, homeDir, folders, spaces],
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
        keywords: ["import", "resume", "thread", "session", "codex", "claude", "opencode"],
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
        <SidebarFolders className="sidebar-surface-enter font-system-ui">
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
                const creatingFolderHere = creatingFolderSpaceId === section.space.id;
                const spaceParent = { kind: "space", spaceId: section.space.id } as const;
                const expanded = creatingFolderHere || !collapsedSpaceIds.has(section.key);
                const hasContent = creatingFolderHere || section.items.length > 0;
                const spaceProjectData = section.items.flatMap((item) => {
                  const projectData = standardProjectSidebarDataById.get(item.project.id);
                  return projectData ? [projectData] : [];
                });
                const spaceWorkStatus = resolveSidebarWorkStatus(
                  resolveProjectStatusIndicator(
                    spaceProjectData.map((projectData) => projectData.projectStatus),
                  ),
                  spaceProjectData.some((projectData) =>
                    projectData.projectThreads.some(
                      (thread) => thread.id === voiceRecordingThreadId,
                    ),
                  ),
                );
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
                          if (!nextExpanded && creatingFolderHere) {
                            setCreatingFolderSpaceId(null);
                          }
                          setCollapsedSpaceIds((current) => {
                            const next = new Set(current);
                            if (nextExpanded) next.delete(section.key);
                            else next.add(section.key);
                            return next;
                          });
                        }}
                        onHeaderAction={() => {
                          beginInlineFolderCreation({
                            spaceId: section.space.id,
                            selectSpaceForIncomingProject: handleSelectSpaceForIncomingProject,
                            openInlineFolderCreator,
                          });
                        }}
                        onHeaderContextMenu={(event: MouseEvent<HTMLButtonElement>) =>
                          void handleSpaceHeaderContextMenu(event, section.space)
                        }
                        workStatus={spaceWorkStatus}
                      >
                        {creatingFolderHere ? (
                          <FolderRowInlineEdit
                            defaultValue=""
                            existingNames={folderNamesBySpaceId.get(section.space.id) ?? []}
                            mode="create"
                            onCancel={() => setCreatingFolderSpaceId(null)}
                            onSubmit={async (name) => {
                              await handleCreateProjectSubmit({
                                name,
                                spaceId: section.space.id,
                              });
                              setCreatingFolderSpaceId(null);
                            }}
                          />
                        ) : null}
                        {section.items.map((item, itemIndex) =>
                          item.kind === "folder"
                            ? renderPencilProjectItem(item.project, itemIndex)
                            : null,
                        )}
                      </SpaceGroupShared>
                      <SidebarContainerDropPreview
                        enabled={!expanded || !hasContent}
                        parent={spaceParent}
                      />
                    </div>
                  </SortableSidebarNode>
                );
              })}
            </div>
          </SidebarDndMonitor>
        </SidebarFolders>
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
          accountName={accountName}
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

      <Dialog
        open={projectRunDialogFolderId !== null}
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
          folders={searchPaletteFolders}
          projectById={projectById}
          onCreateChat={() => {
            if (activeSpaceId) void handleCreateSpaceThread(activeSpaceId);
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
      <input
        ref={folderIconInputRef}
        accept="image/*"
        className="hidden"
        type="file"
        onChange={(event) => {
          void handleFolderIconFile(event.target.files?.[0]);
          event.target.value = "";
        }}
      />
    </>
  );
}

function SidebarSearchPaletteController(props: {
  open: boolean;
  mode: SidebarSearchPaletteMode;
  onModeChange: (mode: SidebarSearchPaletteMode) => void;
  onOpenChange: (open: boolean) => void;
  actions: readonly SidebarSearchAction[];
  folders: readonly SidebarSearchProject[];
  projectById: ReadonlyMap<FolderId, { name: string; remoteName: string }>;
  onCreateChat: () => void;
  onCreateThread: () => void;
  onOpenSettings: () => void;
  onOpenFeedback: () => void;
  onOpenUsageSettings: () => void;
  onOpenProject: (folderId: string) => void;
  onImportThread: (provider: ImportProviderKind, externalId: string) => Promise<void>;
  onOpenThread: (threadId: string) => void;
}) {
  const selectAllThreads = useMemo(() => createAllThreadsSelector(), []);
  const selectSidebarDisplayThreads = useMemo(() => createSidebarDisplayThreadsSelector(), []);
  const importProviderCapabilityQueries = useQueries({
    queries: (["codex", "claudeAgent", "opencode"] as const).map((provider) =>
      providerComposerCapabilitiesQueryOptions(provider),
    ),
  });
  const threads = useStore(selectAllThreads);
  const sidebarDisplayThreads = useStore(selectSidebarDisplayThreads);
  const importProviders: ReadonlyArray<ImportProviderKind> = (
    ["codex", "claudeAgent", "opencode"] as const
  ).filter((provider, index) => supportsThreadImport(importProviderCapabilityQueries[index]?.data));
  const searchPaletteThreads = useMemo<SidebarSearchThread[]>(() => {
    const threadById = new Map(threads.map((thread) => [thread.id, thread] as const));
    const searchProjectById = new Map(
      props.folders.map((project) => [project.id, project] as const),
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
          folderId: thread.folderId,
          projectName: props.projectById.get(thread.folderId)?.name ?? "Unknown folder",
          projectRemoteName: props.projectById.get(thread.folderId)?.remoteName ?? "Unknown folder",
          spaceName: searchProjectById.get(thread.folderId)?.spaceName ?? "Global",
          provider: thread.modelSelection.provider,
          createdAt: thread.createdAt,
          updatedAt: thread.updatedAt,
          messages: thread.messages.map((message) => ({
            text: message.text,
          })),
        },
      ];
    });
  }, [props.projectById, props.folders, sidebarDisplayThreads, threads]);

  return (
    <SidebarSearchPalette
      open={props.open}
      mode={props.mode}
      onModeChange={props.onModeChange}
      onOpenChange={props.onOpenChange}
      actions={props.actions}
      folders={props.folders}
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
