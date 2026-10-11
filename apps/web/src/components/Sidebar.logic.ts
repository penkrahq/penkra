// FILE: Sidebar.logic.ts
// Purpose: Shared sidebar sorting and status helpers used by the thread list UI.
// Exports: Sidebar row state derivation, sort utilities, and visibility helpers.

import type { SidebarThreadRow } from "../sidebarThreadRows";
import {
  type KeybindingCommand,
  type FolderId,
  type SpaceId,
  type ThreadId,
} from "@penkra/contracts";
import { isWorkspaceRootWithin } from "@penkra/shared/threadWorkspace";
import type { SidebarProjectSortOrder, SidebarThreadSortOrder } from "../appSettings";
import { resolveRestorableThreadRoute, type LastThreadRoute } from "../chatRouteRestore";
import type { Project, Thread } from "../types";
import { cn } from "../lib/utils";
import {
  SIDEBAR_ROW_ACTIVE_CLASS_NAME,
  SIDEBAR_ROW_HOVER_CLASS_NAME,
  SIDEBAR_ROW_IDLE_TEXT_CLASS_NAME,
  SIDEBAR_THREAD_ROW_BASE_CLASS_NAME,
} from "../sidebarRowStyles";
import { canSessionAnswerPendingRequests, isSessionRunningTurn } from "../session-logic";
import { getThreadCompletionKey, hasUnseenThreadCompletion } from "../threadCompletion";

export const THREAD_SELECTION_SAFE_SELECTOR = "[data-thread-item], [data-thread-selection-safe]";
export const SIDEBAR_THREAD_PREWARM_LIMIT = 10;
export const DEBUG_FEATURE_FLAGS_MENU_STORAGE_KEY = "penkra:show-debug-feature-flags-menu";
export type SidebarView = "threads" | "workspace";

export function resolveProjectHeaderState(input: {
  readonly folderId: string;
  readonly activeDraftFolderId: string | null | undefined;
  readonly activeDraftPromotedTo: string | null | undefined;
}): "active" | "default" {
  return input.activeDraftFolderId === input.folderId && !input.activeDraftPromotedTo
    ? "active"
    : "default";
}

export function isFoldersSidebarSurface(input: {
  readonly isOnSettings: boolean;
  readonly isOnWorkspace: boolean;
}): boolean {
  return !input.isOnSettings && !input.isOnWorkspace;
}

/**
 * Opens folder creation without running the Space's normal restore navigation.
 * Empty inactive Spaces otherwise route Home and remount the sidebar before the
 * inline editor can remain open.
 */
export function beginInlineFolderCreation(input: {
  readonly spaceId: SpaceId;
  readonly selectSpaceForIncomingProject: (spaceId: SpaceId) => void;
  readonly openInlineFolderCreator: (spaceId: SpaceId) => void;
}): void {
  input.selectSpaceForIncomingProject(input.spaceId);
  input.openInlineFolderCreator(input.spaceId);
}

type SidebarProject = {
  id: string;
  name: string;
  sidebarSortOrder?: number | null | undefined;
  createdAt?: string | undefined;
  updatedAt?: string | undefined;
};
type SidebarThreadSortInput = {
  createdAt: string;
  sidebarSortOrder?: number | null | undefined;
  updatedAt?: string | undefined;
  latestTurn?: Thread["latestTurn"] | undefined;
  lastVisitedAt?: string | null | undefined;
  hasPendingUserInput?: boolean | undefined;
  session?: Thread["session"] | undefined;
};

export function isLoopbackHostname(hostname: string): boolean {
  const normalizedHostname = hostname.trim().toLowerCase().replace(/\.$/, "");

  return (
    normalizedHostname === "localhost" ||
    normalizedHostname === "127.0.0.1" ||
    normalizedHostname === "::1" ||
    normalizedHostname === "[::1]"
  );
}

export function shouldShowDebugFeatureFlagsMenu(input: {
  readonly isDev: boolean;
  readonly hostname: string;
  readonly storageValue: string | null;
}): boolean {
  return input.isDev && isLoopbackHostname(input.hostname) && input.storageValue === "true";
}

export type SidebarProjectEntry = {
  kind: "thread";
  rowId: ThreadId;
  thread: SidebarThreadRow;
};

export type SidebarThreadHoverAnchorScope = "chat" | "folder";

export function createSidebarThreadHoverAnchorId(input: {
  scope: SidebarThreadHoverAnchorScope;
  threadId: ThreadId;
}): string {
  return `${input.scope}:${input.threadId}`;
}

export type SidebarDerivedProjectData = {
  allProjectThreadCount: number;
  projectThreads: SidebarThreadRow[];
  orderedProjectThreadIds: ThreadId[];
  visibleEntries: SidebarProjectEntry[];
  /** Extra "Show more" pages currently applied, clamped to the real row count. */
  threadListExtraPages: number;
  canShowMoreThreads: boolean;
  canShowLessThreads: boolean;
  activeEntryId: ThreadId | null;
  projectStatus: ReturnType<typeof resolveProjectStatusIndicator>;
};

const THREAD_JUMP_COMMANDS = [
  "thread.jump.1",
  "thread.jump.2",
  "thread.jump.3",
  "thread.jump.4",
  "thread.jump.5",
  "thread.jump.6",
  "thread.jump.7",
  "thread.jump.8",
  "thread.jump.9",
] as const satisfies readonly KeybindingCommand[];

export interface ThreadStatusPill {
  label: "Working" | "Connecting" | "Completed" | "Awaiting Input" | "Needs Attention";
  colorClass: string;
  dotClass: string;
  pulse: boolean;
  dismissible?: boolean;
  dismissalKey?: string;
}

const THREAD_STATUS_PRIORITY: Record<ThreadStatusPill["label"], number> = {
  "Awaiting Input": 5,
  "Needs Attention": 6,
  Working: 3,
  Connecting: 3,
  Completed: 1,
};

export type SidebarWorkStatus = "idle" | "running" | "done" | "attention" | "recording";

export function canArchiveSidebarThreads(statuses: ReadonlyArray<SidebarWorkStatus>): boolean {
  return statuses.length > 0 && statuses.every((status) => status === "idle");
}

export function getSidebarThreadLifecycleMenuItems(canArchive: boolean): ReadonlyArray<{
  readonly id: "archive" | "delete";
  readonly label: string;
  readonly destructive?: boolean;
  readonly separatorBefore?: boolean;
}> {
  if (canArchive) {
    return [{ id: "archive", label: "Archive", separatorBefore: true }];
  }
  return [{ id: "delete", label: "Delete", destructive: true, separatorBefore: true }];
}

export function canArchiveSidebarFolder(statuses: ReadonlyArray<SidebarWorkStatus>): boolean {
  return statuses.every((status) => status === "idle" || status === "done");
}

export function resolveSidebarWorkStatus(
  status: ThreadStatusPill | null,
  isRecording = false,
): SidebarWorkStatus {
  if (isRecording) return "recording";
  if (status === null) return "idle";
  if (status.label === "Working" || status.label === "Connecting") return "running";
  if (status.label === "Completed") return "done";
  return "attention";
}

export function resolveVisibleThreadWorkStatus(input: {
  status: ThreadStatusPill | null;
  isRecording?: boolean;
  projectedWorkStatus?: SidebarThreadRow["workStatus"];
}): SidebarWorkStatus {
  // `projectedWorkStatus` remains useful for sorting and compact shell state,
  // but it is not visit-aware enough to drive the visible row icon.
  return resolveSidebarWorkStatus(input.status, input.isRecording);
}

type ThreadStatusInput = Pick<
  Thread,
  "latestTurn" | "pendingTurnStartMessageId" | "session" | "updatedAt"
> & {
  lastVisitedAt?: string | null | undefined;
  dismissedStatusKey?: string | undefined;
  workStatus?: import("../types").SidebarThreadSummary["workStatus"];
};

function createThreadStatusDismissalKey(
  label: Extract<ThreadStatusPill["label"], "Awaiting Input">,
  thread: ThreadStatusInput,
): string {
  return [
    label,
    thread.updatedAt ?? "",
    thread.latestTurn?.turnId ?? "",
    thread.latestTurn?.completedAt ?? "",
    thread.session?.updatedAt ?? "",
  ].join(":");
}

function createCompletedDismissalKey(thread: ThreadStatusInput): string | null {
  return getThreadCompletionKey(thread.latestTurn);
}

export function shouldClearThreadSelectionOnMouseDown(target: HTMLElement | null): boolean {
  if (target === null) return true;
  return !target.closest(THREAD_SELECTION_SAFE_SELECTOR);
}

export type SettingsBackTarget =
  | {
      kind: "thread";
      threadId: string;
    }
  | {
      kind: "home";
    };

export function resolveSettingsBackTarget(input: {
  lastThreadRoute: LastThreadRoute | null;
  availableThreadIds: ReadonlySet<string>;
  latestThreadId: string | null;
}): SettingsBackTarget {
  const restorableRoute = resolveRestorableThreadRoute({
    lastThreadRoute: input.lastThreadRoute,
    availableThreadIds: input.availableThreadIds,
  });

  if (restorableRoute) {
    return {
      kind: "thread",
      threadId: restorableRoute.threadId,
    };
  }

  if (input.latestThreadId) {
    return {
      kind: "thread",
      threadId: input.latestThreadId,
    };
  }

  return { kind: "home" };
}

// Drops remembered "show more" paging for folders that are currently collapsed.
export function pruneProjectThreadListPagingForCollapsedFolders<
  T extends Pick<Project, "cwd" | "expanded">,
>(input: {
  threadListExtraPagesByProjectCwd: ReadonlyMap<string, number>;
  folders: readonly T[];
  normalizeProjectCwd: (cwd: string) => string;
  getProjectPagingKey?: (project: T) => string;
}): ReadonlyMap<string, number> {
  const { getProjectPagingKey, normalizeProjectCwd, folders, threadListExtraPagesByProjectCwd } =
    input;
  const collapsedProjectPagingKeys = new Set(
    folders
      .filter((project) => !project.expanded)
      .map((project) =>
        getProjectPagingKey ? getProjectPagingKey(project) : normalizeProjectCwd(project.cwd),
      )
      .filter((key) => key.length > 0),
  );

  if (collapsedProjectPagingKeys.size === 0) {
    return threadListExtraPagesByProjectCwd;
  }

  let changed = false;
  const nextThreadListExtraPagesByProjectCwd = new Map<string, number>();
  for (const [pagingKey, extraPages] of threadListExtraPagesByProjectCwd) {
    if (collapsedProjectPagingKeys.has(pagingKey)) {
      changed = true;
      continue;
    }
    nextThreadListExtraPagesByProjectCwd.set(pagingKey, extraPages);
  }

  return changed ? nextThreadListExtraPagesByProjectCwd : threadListExtraPagesByProjectCwd;
}

/**
 * Trailing padding that protects the title from the absolutely-positioned
 * trailing cluster, sized to what the slot ACTUALLY shows so the title runs as
 * far right as the on-screen content allows:
 *
 * - The relative time now lives in the row hover card, so an idle row with no
 *   status/jump glyph and no meta chips reserves almost nothing — the title runs
 *   to the row edge instead of truncating against permanently reserved space.
 * - A status/loader (or keyboard-jump) glyph occupies a ~2.25rem slot, and each
 *   fork/worktree/temporary meta chip adds width; the reserve grows only for the
 *   badges that are present.
 * - The wider reserve that clears the hover pin/archive actions is applied only
 *   on hover/focus (mirroring the project header row), so the title gives up that
 *   width exactly when those actions appear and not a moment sooner.
 *
 * Literal class strings are required so Tailwind's JIT scanner emits them.
 */
export function resolveThreadRowTrailingReserveClass(input: {
  metaChipCount: number;
  hasTrailingGlyph: boolean;
}): string {
  // Hover/focus reveals the pin/archive actions; the meta chips + glyph fade out
  // at the same time, so the hover reserve is constant regardless of rest content.
  const hoverReserve =
    "transition-[padding] duration-150 ease-out group-hover/thread-row:pr-[4.75rem] group-focus-within/thread-row:pr-[4.75rem]";
  const { metaChipCount, hasTrailingGlyph } = input;
  if (metaChipCount <= 0) {
    return cn(hasTrailingGlyph ? "pr-[1.75rem]" : "pr-2", hoverReserve);
  }
  if (metaChipCount === 1) {
    return cn(hasTrailingGlyph ? "pr-[3rem]" : "pr-[1.75rem]", hoverReserve);
  }
  if (metaChipCount === 2) {
    return cn(hasTrailingGlyph ? "pr-[4rem]" : "pr-[3rem]", hoverReserve);
  }
  return cn(hasTrailingGlyph ? "pr-[4.5rem]" : "pr-[4.25rem]", hoverReserve);
}

export function resolveThreadRowClassName(input: {
  isActive: boolean;
  isSelected: boolean;
}): string {
  // Trailing reserve for the absolute cluster is applied separately by callers
  // via resolveThreadRowTrailingReserveClass so it can flex with the chip count.
  const baseClassName = SIDEBAR_THREAD_ROW_BASE_CLASS_NAME;

  if (input.isSelected && input.isActive) {
    return cn(baseClassName, SIDEBAR_ROW_ACTIVE_CLASS_NAME);
  }

  if (input.isSelected) {
    return cn(baseClassName, SIDEBAR_ROW_ACTIVE_CLASS_NAME);
  }

  if (input.isActive) {
    return cn(baseClassName, SIDEBAR_ROW_ACTIVE_CLASS_NAME);
  }

  return cn(baseClassName, SIDEBAR_ROW_IDLE_TEXT_CLASS_NAME, SIDEBAR_ROW_HOVER_CLASS_NAME);
}

// Single definition of "this thread is actively doing work" shared by the
// Working status pill and the sidebar sort, so a thread's position and its
// pill never disagree.
export function isThreadActivelyWorking(thread: {
  session?: Thread["session"] | undefined;
  latestTurn?: Thread["latestTurn"] | undefined;
}): boolean {
  const session = thread.session ?? null;
  // `starting` is already durable evidence that a turn was dispatched, but the
  // provider's turn.started event may not have been projected yet. Treat that
  // hand-off window as active so the row does not briefly (or, under delayed
  // projection, indefinitely) fall back to idle behind an older settled turn.
  if (session?.orchestrationStatus === "starting") {
    return true;
  }
  return isSessionRunningTurn(session);
}

export function resolveThreadStatusPill(input: {
  thread: ThreadStatusInput;
  hasPendingUserInput: boolean;
  /** Local ownership bridges draft promotion until the first server lifecycle projection. */
  isPromotedDraftPending?: boolean;
  /** A shell summary exists for this thread, so promotion alone is no longer lifecycle evidence. */
  hasCanonicalThreadSummary?: boolean;
  /** The shared composer send registry still owns work for this thread. */
  hasLocalSendOwner?: boolean;
}): ThreadStatusPill | null {
  const { thread } = input;
  // A dead session cannot receive question answers anymore — drop the
  // actionable pills instead of advertising a request nobody can fulfill.
  // Mirrored by the kanban board's deriveKanbanColumn.
  const canAnswerPendingRequests = canSessionAnswerPendingRequests(thread.session);
  const hasPendingUserInput = input.hasPendingUserInput && canAnswerPendingRequests;

  if (hasPendingUserInput) {
    const dismissalKey = createThreadStatusDismissalKey("Awaiting Input", thread);
    if (thread.dismissedStatusKey === dismissalKey) {
      return null;
    }
    return {
      label: "Awaiting Input",
      colorClass: "text-indigo-600 dark:text-indigo-300/90",
      dotClass: "bg-indigo-500 dark:bg-indigo-300/90",
      pulse: false,
      dismissible: true,
      dismissalKey,
    };
  }

  if (thread.session?.status === "error") {
    return {
      label: "Needs Attention",
      colorClass: "text-orange-600 dark:text-orange-300/90",
      dotClass: "bg-orange-500 dark:bg-orange-300/90",
      pulse: false,
      dismissible: false,
    };
  }

  if (
    (input.isPromotedDraftPending && !input.hasCanonicalThreadSummary) ||
    input.hasLocalSendOwner ||
    thread.pendingTurnStartMessageId != null
  ) {
    return {
      label: "Working",
      colorClass: "text-sky-600 dark:text-sky-300/80",
      dotClass: "bg-sky-500 dark:bg-sky-300/80",
      pulse: true,
      dismissible: false,
    };
  }

  if (thread.workStatus === "running" || isThreadActivelyWorking(thread)) {
    return {
      label: "Working",
      colorClass: "text-sky-600 dark:text-sky-300/80",
      dotClass: "bg-sky-500 dark:bg-sky-300/80",
      pulse: true,
      dismissible: false,
    };
  }

  if (thread.session?.status === "connecting") {
    return {
      label: "Connecting",
      colorClass: "text-sky-600 dark:text-sky-300/80",
      dotClass: "bg-sky-500 dark:bg-sky-300/80",
      pulse: true,
      dismissible: false,
    };
  }

  if (hasUnseenThreadCompletion(thread)) {
    const dismissalKey = createCompletedDismissalKey(thread);
    if (dismissalKey && thread.dismissedStatusKey === dismissalKey) {
      return null;
    }
    return {
      label: "Completed",
      colorClass: "text-emerald-600 dark:text-emerald-300/90",
      dotClass: "bg-emerald-500 dark:bg-emerald-300/90",
      pulse: false,
      dismissible: true,
      ...(dismissalKey ? { dismissalKey } : {}),
    };
  }

  return null;
}

/**
 * Adapts the canonical shell summary to the shared visible lifecycle resolver.
 * Every surface representing a Thread (sidebar rows, folder tabs, and future
 * switchers) must use this path instead of rendering the coarse work-status
 * rollup directly.
 */
export function resolveSidebarThreadSummaryStatus(input: {
  readonly thread: import("../types").SidebarThreadSummary;
  readonly lastVisitedAt: string | undefined;
  readonly dismissedStatusKey?: string | undefined;
  readonly isPromotedDraftPending?: boolean;
  readonly hasLocalSendOwner?: boolean;
}): ThreadStatusPill | null {
  return resolveThreadStatusPill({
    thread: {
      ...input.thread,
      lastVisitedAt: input.lastVisitedAt,
      dismissedStatusKey: input.dismissedStatusKey,
    },
    hasPendingUserInput: input.thread.hasPendingUserInput,
    ...(input.isPromotedDraftPending === undefined
      ? {}
      : { isPromotedDraftPending: input.isPromotedDraftPending }),
    hasCanonicalThreadSummary: true,
    ...(input.hasLocalSendOwner === undefined
      ? {}
      : { hasLocalSendOwner: input.hasLocalSendOwner }),
  });
}

export function resolveProjectStatusIndicator(
  statuses: ReadonlyArray<ThreadStatusPill | null>,
): ThreadStatusPill | null {
  let highestPriorityStatus: ThreadStatusPill | null = null;

  for (const status of statuses) {
    if (status === null) continue;
    if (
      highestPriorityStatus === null ||
      THREAD_STATUS_PRIORITY[status.label] > THREAD_STATUS_PRIORITY[highestPriorityStatus.label]
    ) {
      highestPriorityStatus = status;
    }
  }

  return highestPriorityStatus;
}

// Finds the item whose workspace root most specifically contains `targetPath`
// (equal to it, or its closest ancestor). Used to attribute a dev server's cwd
// to a project even when it runs from a nested package directory; the deepest root
// wins so a nested project beats its parent.
export function findDeepestWorkspaceRootMatch<T>(
  items: readonly T[],
  targetPath: string,
  getWorkspaceRoot: (item: T) => string,
): T | undefined {
  let best: T | undefined;
  let bestRootLength = -1;
  for (const item of items) {
    const root = getWorkspaceRoot(item);
    if (!isWorkspaceRootWithin(targetPath, root)) {
      continue;
    }
    if (root.length > bestRootLength) {
      best = item;
      bestRootLength = root.length;
    }
  }
  return best;
}

// One "Show more" click reveals one extra page of rows; "Show less" hides one page again.
// The requested page count is clamped to what the list can actually use, so stale persisted
// values (or shrinking thread lists) self-heal instead of requiring dead "Show less" clicks.
export type SidebarThreadListPaging = {
  /** Requested pages clamped to what `totalCount` can actually consume. */
  effectiveExtraPages: number;
  /** Row cap to render: `baseLimit + effectiveExtraPages * pageSize`. */
  previewLimit: number;
  canShowMore: boolean;
  canShowLess: boolean;
};

export function resolveSidebarThreadListPaging(input: {
  totalCount: number;
  baseLimit: number;
  pageSize: number;
  requestedExtraPages: number;
}): SidebarThreadListPaging {
  const { baseLimit, pageSize, totalCount } = input;
  const hiddenBeyondBase = Math.max(0, totalCount - baseLimit);
  const maxExtraPages = pageSize > 0 ? Math.ceil(hiddenBeyondBase / pageSize) : 0;
  const requestedExtraPages = Number.isFinite(input.requestedExtraPages)
    ? Math.floor(input.requestedExtraPages)
    : 0;
  const effectiveExtraPages = Math.min(Math.max(0, requestedExtraPages), maxExtraPages);
  const previewLimit = baseLimit + effectiveExtraPages * pageSize;

  return {
    effectiveExtraPages,
    previewLimit,
    canShowMore: totalCount > previewLimit,
    canShowLess: effectiveExtraPages > 0,
  };
}

export function getVisibleThreadsForProject<T extends Pick<SidebarThreadRow, "id">>(input: {
  threads: readonly T[];
  activeThreadId: Thread["id"] | undefined;
  previewLimit: number;
}): {
  hasHiddenThreads: boolean;
  visibleThreads: T[];
} {
  const { activeThreadId, previewLimit, threads } = input;
  const hasHiddenThreads = threads.length > previewLimit;

  if (!hasHiddenThreads) {
    return {
      hasHiddenThreads,
      visibleThreads: [...threads],
    };
  }

  const previewThreads = threads.slice(0, previewLimit);
  if (!activeThreadId || previewThreads.some((thread) => thread.id === activeThreadId)) {
    return {
      hasHiddenThreads: true,
      visibleThreads: previewThreads,
    };
  }

  const activeThread = threads.find((thread) => thread.id === activeThreadId);
  if (!activeThread) {
    return {
      hasHiddenThreads: true,
      visibleThreads: previewThreads,
    };
  }

  const visibleThreadIds = new Set([...previewThreads, activeThread].map((thread) => thread.id));

  return {
    hasHiddenThreads: true,
    visibleThreads: threads.filter((thread) => visibleThreadIds.has(thread.id)),
  };
}

export function getVisibleSidebarEntriesForPreview<
  T extends {
    rowId: Thread["id"];
  },
>(input: {
  entries: readonly T[];
  activeEntryId: Thread["id"] | undefined;
  previewLimit: number;
}): {
  hasHiddenEntries: boolean;
  visibleEntries: T[];
} {
  const { activeEntryId, entries, previewLimit } = input;
  const hasHiddenEntries = entries.length > previewLimit;

  if (!hasHiddenEntries) {
    return {
      hasHiddenEntries,
      visibleEntries: [...entries],
    };
  }

  const previewEntries = entries.slice(0, previewLimit);
  const visibleEntryIds = new Set(previewEntries.map((entry) => entry.rowId));

  if (!activeEntryId || visibleEntryIds.has(activeEntryId)) {
    return {
      hasHiddenEntries: true,
      visibleEntries: previewEntries,
    };
  }

  const activeEntryIndex = entries.findIndex((entry) => entry.rowId === activeEntryId);
  if (activeEntryIndex === -1) {
    return {
      hasHiddenEntries: true,
      visibleEntries: previewEntries,
    };
  }

  const activeEntry = entries[activeEntryIndex];
  if (!activeEntry) {
    return {
      hasHiddenEntries: true,
      visibleEntries: previewEntries,
    };
  }

  visibleEntryIds.add(activeEntry.rowId);

  return {
    hasHiddenEntries: true,
    visibleEntries: entries.filter((entry) => visibleEntryIds.has(entry.rowId)),
  };
}

export type ProjectEmptyState = "loading" | "empty" | null;

// Keep the initial shell bootstrap visually distinct from a genuinely empty project list.
export function resolveProjectEmptyState(input: {
  readonly folderCount: number;
  readonly shouldShowProjectPathEntry: boolean;
  readonly threadsHydrated: boolean;
}): ProjectEmptyState {
  if (input.folderCount > 0 || input.shouldShowProjectPathEntry) {
    return null;
  }

  return input.threadsHydrated ? "empty" : "loading";
}

// Match the exact rows the sidebar renders for one project, including folded previews.
export function getRenderedThreadsForSidebarProject<
  T extends Pick<SidebarThreadRow, "id"> & SidebarThreadSortInput,
>(input: {
  project: Pick<Project, "expanded">;
  threads: readonly T[];
  activeThreadId: Thread["id"] | undefined;
  previewLimit: number;
}): {
  hasHiddenThreads: boolean;
  renderedThreads: T[];
} {
  const { activeThreadId, previewLimit, project, threads } = input;
  const activeCollapsedThread =
    !project.expanded && activeThreadId
      ? (threads.find((thread) => thread.id === activeThreadId) ?? null)
      : null;
  const { hasHiddenThreads, visibleThreads } = getVisibleThreadsForProject({
    threads,
    activeThreadId,
    previewLimit,
  });

  return {
    hasHiddenThreads,
    renderedThreads: activeCollapsedThread ? [activeCollapsedThread] : visibleThreads,
  };
}

// Flatten the sidebar's current project/thread visibility into the same order the user sees.
export function getVisibleSidebarThreadIds(input: {
  folders: readonly Pick<Project, "id" | "expanded">[];
  threads: readonly (Pick<Thread, "id" | "folderId"> & SidebarThreadSortInput)[];
  activeThreadId: Thread["id"] | undefined;
  threadListExtraPagesByFolderId: ReadonlyMap<Project["id"], number>;
  previewLimit: number;
  previewPageSize: number;
  threadSortOrder: SidebarThreadSortOrder;
}): Thread["id"][] {
  const {
    activeThreadId,
    previewLimit,
    previewPageSize,
    folders,
    threadListExtraPagesByFolderId,
    threadSortOrder,
    threads,
  } = input;
  const visibleThreadIds: Thread["id"][] = [];
  const threadsByFolderId = new Map<FolderId, (typeof threads)[number][]>();

  for (const thread of threads) {
    const projectThreads = threadsByFolderId.get(thread.folderId);
    if (projectThreads) {
      projectThreads.push(thread);
    } else {
      threadsByFolderId.set(thread.folderId, [thread]);
    }
  }

  for (const project of folders) {
    const projectThreads = sortThreadsForSidebar(
      threadsByFolderId.get(project.id) ?? [],
      threadSortOrder,
    );
    const paging = resolveSidebarThreadListPaging({
      totalCount: projectThreads.length,
      baseLimit: previewLimit,
      pageSize: previewPageSize,
      requestedExtraPages: threadListExtraPagesByFolderId.get(project.id) ?? 0,
    });
    const { visibleEntries } = getVisibleSidebarEntriesForPreview({
      entries: projectThreads.map((thread) => ({
        rowId: thread.id,
        threadId: thread.id,
      })),
      activeEntryId: activeThreadId,
      previewLimit: paging.previewLimit,
    });
    const activeCollapsedThread =
      !project.expanded && activeThreadId
        ? (projectThreads.find((thread) => thread.id === activeThreadId) ?? null)
        : null;

    if (activeCollapsedThread) {
      visibleThreadIds.push(activeCollapsedThread.id);
      continue;
    }

    for (const entry of visibleEntries) {
      visibleThreadIds.push(entry.threadId);
    }
  }

  return visibleThreadIds;
}

// Resolve the next sidebar-visible thread for keyboard cycling with wraparound.
export function getNextVisibleSidebarThreadId(input: {
  visibleThreadIds: readonly Thread["id"][];
  activeThreadId: Thread["id"] | undefined;
  direction: "forward" | "backward";
}): Thread["id"] | null {
  const { activeThreadId, direction, visibleThreadIds } = input;
  if (visibleThreadIds.length === 0) {
    return null;
  }

  if (!activeThreadId) {
    return direction === "forward"
      ? (visibleThreadIds[0] ?? null)
      : (visibleThreadIds.at(-1) ?? null);
  }

  const activeIndex = visibleThreadIds.findIndex((threadId) => threadId === activeThreadId);
  if (activeIndex === -1) {
    return direction === "forward"
      ? (visibleThreadIds[0] ?? null)
      : (visibleThreadIds.at(-1) ?? null);
  }

  const nextIndex =
    direction === "forward"
      ? (activeIndex + 1) % visibleThreadIds.length
      : (activeIndex - 1 + visibleThreadIds.length) % visibleThreadIds.length;

  return visibleThreadIds[nextIndex] ?? null;
}

export function getSidebarThreadIdForJumpCommand(input: {
  visibleThreadIds: readonly Thread["id"][];
  command: string | null;
}): Thread["id"] | null {
  if (!input.command) {
    return null;
  }

  const jumpIndex = THREAD_JUMP_COMMANDS.indexOf(
    input.command as (typeof THREAD_JUMP_COMMANDS)[number],
  );
  if (jumpIndex === -1) {
    return null;
  }

  return input.visibleThreadIds[jumpIndex] ?? null;
}

export function getSidebarThreadIdsToPrewarm(input: {
  visibleThreadIds: readonly Thread["id"][];
  activeThreadId?: Thread["id"] | null;
  limit?: number;
  neighborRadius?: number;
}): Thread["id"][] {
  const limit = Math.max(0, input.limit ?? SIDEBAR_THREAD_PREWARM_LIMIT);
  if (limit === 0) {
    return [];
  }
  const prewarmedThreadIds = new Set<Thread["id"]>();
  const neighborRadius = Math.max(0, input.neighborRadius ?? 2);
  const activeIndex =
    input.activeThreadId === undefined || input.activeThreadId === null
      ? -1
      : input.visibleThreadIds.indexOf(input.activeThreadId);

  if (activeIndex >= 0) {
    const start = Math.max(0, activeIndex - neighborRadius);
    const end = Math.min(input.visibleThreadIds.length - 1, activeIndex + neighborRadius);
    for (let index = start; index <= end; index += 1) {
      if (prewarmedThreadIds.size >= limit) {
        break;
      }
      const threadId = input.visibleThreadIds[index];
      if (threadId) {
        prewarmedThreadIds.add(threadId);
      }
    }
  }

  for (const threadId of input.visibleThreadIds) {
    if (prewarmedThreadIds.size >= limit) {
      break;
    }
    prewarmedThreadIds.add(threadId);
  }

  return [...prewarmedThreadIds];
}

function toSortableTimestamp(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

function getThreadSortTimestamp(
  thread: SidebarThreadSortInput,
  sortOrder: SidebarThreadSortOrder | Exclude<SidebarProjectSortOrder, "manual">,
): number {
  if (sortOrder === "created_at") {
    return toSortableTimestamp(thread.createdAt) ?? Number.NEGATIVE_INFINITY;
  }
  return toSortableTimestamp(thread.updatedAt ?? thread.createdAt) ?? Number.NEGATIVE_INFINITY;
}

export function sortThreadsForSidebar<T extends { id: Thread["id"] } & SidebarThreadSortInput>(
  threads: readonly T[],
  _sortOrder: SidebarThreadSortOrder,
): T[] {
  return threads.toSorted((left, right) => {
    const byManualOrder = (left.sidebarSortOrder ?? 0) - (right.sidebarSortOrder ?? 0);
    if (byManualOrder !== 0) return byManualOrder;
    const byCreatedAt = right.createdAt.localeCompare(left.createdAt);
    return byCreatedAt || left.id.localeCompare(right.id);
  });
}

type SidebarSpaceSortCandidate<T> = {
  id: string;
  sidebarSortOrder?: number | undefined;
  threads: readonly ({ id: Thread["id"] } & SidebarThreadSortInput)[];
  fallbackCreatedAt?: string | undefined;
  fallbackUpdatedAt?: string | undefined;
  value: T;
};

export function orderSidebarSpaceItems<TThreadItem, TProjectItem>(input: {
  threadItems: readonly SidebarSpaceSortCandidate<TThreadItem>[];
  projectItems: readonly SidebarSpaceSortCandidate<TProjectItem>[];
  sortOrder: SidebarThreadSortOrder;
}): Array<TThreadItem | TProjectItem> {
  const items: ReadonlyArray<SidebarSpaceSortCandidate<TThreadItem | TProjectItem>> = [
    ...input.threadItems,
    ...input.projectItems,
  ];
  return items
    .toSorted((left, right) => {
      const byManualOrder = (left.sidebarSortOrder ?? 0) - (right.sidebarSortOrder ?? 0);
      if (byManualOrder !== 0) return byManualOrder;
      const byCreatedAt = (right.fallbackCreatedAt ?? "").localeCompare(
        left.fallbackCreatedAt ?? "",
      );
      if (byCreatedAt !== 0) return byCreatedAt;
      return left.id.localeCompare(right.id);
    })
    .map((item) => item.value);
}

export function getFallbackThreadIdAfterDelete<
  T extends { id: Thread["id"]; folderId: Thread["folderId"] } & SidebarThreadSortInput,
>(input: {
  threads: readonly T[];
  deletedThreadId: T["id"];
  sortOrder: SidebarThreadSortOrder;
  deletedThreadIds?: ReadonlySet<T["id"]>;
}): T["id"] | null {
  const { deletedThreadId, deletedThreadIds, sortOrder, threads } = input;
  const deletedThread = threads.find((thread) => thread.id === deletedThreadId);
  if (!deletedThread) {
    return null;
  }

  return (
    sortThreadsForSidebar(
      threads.filter(
        (thread) =>
          thread.folderId === deletedThread.folderId &&
          thread.id !== deletedThreadId &&
          !deletedThreadIds?.has(thread.id),
      ),
      sortOrder,
    )[0]?.id ?? null
  );
}

export function getProjectSortTimestamp(
  project: SidebarProject,
  projectThreads: readonly SidebarThreadSortInput[],
  sortOrder: Exclude<SidebarProjectSortOrder, "manual">,
): number {
  if (projectThreads.length > 0) {
    return projectThreads.reduce(
      (latest, thread) => Math.max(latest, getThreadSortTimestamp(thread, sortOrder)),
      Number.NEGATIVE_INFINITY,
    );
  }

  if (sortOrder === "created_at") {
    return toSortableTimestamp(project.createdAt) ?? Number.NEGATIVE_INFINITY;
  }
  return toSortableTimestamp(project.updatedAt ?? project.createdAt) ?? Number.NEGATIVE_INFINITY;
}

export function sortFoldersForSidebar<
  TProject extends SidebarProject,
  TThread extends { folderId: Thread["folderId"] } & SidebarThreadSortInput,
>(
  folders: readonly TProject[],
  threads: readonly TThread[],
  sortOrder: SidebarProjectSortOrder,
): TProject[] {
  void threads;
  void sortOrder;
  return [...folders].toSorted((left, right) => {
    const byManualOrder = (left.sidebarSortOrder ?? 0) - (right.sidebarSortOrder ?? 0);
    if (byManualOrder !== 0) return byManualOrder;
    const byCreatedAt = (right.createdAt ?? "").localeCompare(left.createdAt ?? "");
    return byCreatedAt || left.id.localeCompare(right.id);
  });
}

// Groups thread summaries once so project-specific sidebar derivations can reuse the same slices.
export function groupSidebarThreadsByFolderId(
  threads: readonly SidebarThreadRow[],
): ReadonlyMap<FolderId, SidebarThreadRow[]> {
  const byFolderId = new Map<FolderId, SidebarThreadRow[]>();
  for (const thread of threads) {
    const existing = byFolderId.get(thread.folderId);
    if (existing) {
      existing.push(thread);
    } else {
      byFolderId.set(thread.folderId, [thread]);
    }
  }
  return byFolderId;
}

// Centralizes the expensive per-project row derivation so Sidebar.tsx can mostly orchestrate UI state.
export function deriveSidebarProjectData(input: {
  folders: readonly Pick<Project, "id" | "cwd" | "expanded">[];
  sortedSidebarThreadsByFolderId: ReadonlyMap<FolderId, SidebarThreadRow[]>;
  threadListExtraPagesByProjectCwd: ReadonlyMap<string, number>;
  normalizeProjectCwd: (cwd: string) => string;
  getProjectPagingKey?: (project: Pick<Project, "id" | "cwd" | "expanded">) => string;
  activeSidebarThreadId: ThreadId | undefined;
  previewLimit: number;
  previewPageSize: number;
  resolveThreadStatus?: (thread: SidebarThreadRow) => ReturnType<typeof resolveThreadStatusPill>;
}): ReadonlyMap<FolderId, SidebarDerivedProjectData> {
  const byFolderId = new Map<FolderId, SidebarDerivedProjectData>();

  for (const project of input.folders) {
    const allProjectThreads = input.sortedSidebarThreadsByFolderId.get(project.id) ?? [];
    const projectThreads = [...allProjectThreads];
    const projectStatus = resolveProjectStatusIndicator(
      allProjectThreads.map((thread) =>
        input.resolveThreadStatus
          ? input.resolveThreadStatus(thread)
          : resolveThreadStatusPill({
              thread,
              hasPendingUserInput: thread.hasPendingUserInput,
            }),
      ),
    );
    const projectPagingKey = input.getProjectPagingKey
      ? input.getProjectPagingKey(project)
      : input.normalizeProjectCwd(project.cwd);
    const requestedExtraPages = input.threadListExtraPagesByProjectCwd.get(projectPagingKey) ?? 0;
    const orderedProjectThreadIds = projectThreads.map((thread) => thread.id);
    // Collapsed folders should not build or render their full list; large folders can
    // contain hundreds of rows and folder toggles are on the sidebar hot path.
    if (!project.expanded) {
      const activeThread =
        input.activeSidebarThreadId === undefined
          ? null
          : (projectThreads.find((thread) => thread.id === input.activeSidebarThreadId) ?? null);
      const visibleEntries =
        activeThread === null
          ? []
          : [
              {
                kind: "thread" as const,
                rowId: activeThread.id,
                thread: activeThread,
              },
            ];

      byFolderId.set(project.id, {
        allProjectThreadCount: allProjectThreads.length,
        projectThreads,
        orderedProjectThreadIds,
        visibleEntries,
        // The thread list is hidden while the folder is closed, so paging affordances are moot.
        threadListExtraPages: 0,
        canShowMoreThreads: false,
        canShowLessThreads: false,
        activeEntryId: activeThread?.id ?? null,
        projectStatus,
      });
      continue;
    }

    const orderedEntries: SidebarProjectEntry[] = projectThreads.map((thread) => ({
      kind: "thread",
      rowId: thread.id,
      thread,
    }));

    const activeEntry =
      input.activeSidebarThreadId === undefined
        ? null
        : (orderedEntries.find((entry) => entry.rowId === input.activeSidebarThreadId) ?? null);
    const paging = resolveSidebarThreadListPaging({
      totalCount: orderedEntries.length,
      baseLimit: input.previewLimit,
      pageSize: input.previewPageSize,
      requestedExtraPages,
    });
    const { visibleEntries: renderedEntries } = getVisibleSidebarEntriesForPreview({
      entries: orderedEntries,
      activeEntryId: activeEntry?.rowId,
      previewLimit: paging.previewLimit,
    });

    byFolderId.set(project.id, {
      allProjectThreadCount: allProjectThreads.length,
      projectThreads,
      orderedProjectThreadIds,
      visibleEntries: renderedEntries,
      threadListExtraPages: paging.effectiveExtraPages,
      // The active-thread reveal can force rows beyond the page cap; only offer "Show more"
      // while rows are genuinely hidden.
      canShowMoreThreads: paging.canShowMore && renderedEntries.length < orderedEntries.length,
      canShowLessThreads: paging.canShowLess,
      activeEntryId: activeEntry?.rowId ?? null,
      projectStatus,
    });
  }

  return byFolderId;
}

// PR-state presentation (label/color/glyph) moved to
// ~/components/pullRequest/pullRequestStatePresentation so the sidebar badge, kanban chip,
// and the pull request feature surfaces all share one mapping.
