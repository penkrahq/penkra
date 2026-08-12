import { describe, expect, it } from "vitest";

import {
  buildProjectThreadTree,
  createSidebarThreadHoverAnchorId,
  derivePinnedProjectIdsForSidebar,
  derivePinnedThreadIdsForSidebar,
  deriveSidebarProjectData,
  findDeepestWorkspaceRootMatch,
  getFallbackThreadIdAfterDelete,
  getVisibleSidebarEntriesForPreview,
  orderPinnedProjectsForSidebar,
  orderSidebarSpaceItems,
  getNextVisibleSidebarThreadId,
  getSidebarThreadIdForJumpCommand,
  getSidebarThreadIdsToPrewarm,
  getRenderedThreadsForSidebarProject,
  groupSidebarThreadsByProjectId,
  isLatestPinnedProjectMutation,
  isProjectsSidebarSurface,
  getVisibleSidebarThreadIds,
  getVisibleThreadsForProject,
  getProjectSortTimestamp,
  hasUnseenCompletion,
  partitionSidebarThreadsByProjectIds,
  isLatestPinnedThreadMutation,
  isLoopbackHostname,
  pruneProjectThreadListPagingForCollapsedProjects,
  resolveSidebarThreadListPaging,
  resolveProjectEmptyState,
  resolveSettingsBackTarget,
  resolveProjectStatusIndicator,
  resolveSidebarWorkStatus,
  resolveThreadHoverCardMetadata,
  resolveThreadRowClassName,
  resolveThreadStatusPill,
  shouldShowDebugFeatureFlagsMenu,
  shouldPrunePinnedThreads,
  shouldClearThreadSelectionOnMouseDown,
  sortProjectsForSidebar,
  sortThreadsForSidebar,
} from "./Sidebar.logic";
import { ContainerId, ThreadId } from "@penkra/contracts";
import {
  DEFAULT_RUNTIME_MODE,
  type Project,
  type SidebarThreadSummary,
  type Thread,
} from "../types";

function makeLatestTurn(overrides?: {
  completedAt?: string | null;
  startedAt?: string | null;
}): Parameters<typeof hasUnseenCompletion>[0]["latestTurn"] {
  return {
    turnId: "turn-1" as never,
    state: "completed",
    assistantMessageId: null,
    requestedAt: "2026-03-09T10:00:00.000Z",
    startedAt: overrides?.startedAt ?? "2026-03-09T10:00:00.000Z",
    completedAt: overrides?.completedAt ?? "2026-03-09T10:05:00.000Z",
  };
}

describe("isProjectsSidebarSurface", () => {
  it("enables Space shortcuts only where the Space switcher is visible", () => {
    expect(
      isProjectsSidebarSurface({
        isOnSettings: false,
        isOnStudio: false,
        isOnWorkspace: false,
      }),
    ).toBe(true);
    expect(
      isProjectsSidebarSurface({ isOnSettings: false, isOnStudio: true, isOnWorkspace: false }),
    ).toBe(false);
    expect(
      isProjectsSidebarSurface({ isOnSettings: true, isOnStudio: false, isOnWorkspace: false }),
    ).toBe(false);
  });
});

describe("hasUnseenCompletion", () => {
  it("returns true when a thread completed after its last visit", () => {
    expect(
      hasUnseenCompletion({
        latestTurn: makeLatestTurn(),
        lastVisitedAt: "2026-03-09T10:04:00.000Z",
      }),
    ).toBe(true);
  });
});

describe("shouldClearThreadSelectionOnMouseDown", () => {
  it("preserves selection for thread items", () => {
    const child = {
      closest: (selector: string) =>
        selector.includes("[data-thread-item]") ? ({} as Element) : null,
    } as unknown as HTMLElement;

    expect(shouldClearThreadSelectionOnMouseDown(child)).toBe(false);
  });

  it("preserves selection for thread list toggle controls", () => {
    const selectionSafe = {
      closest: (selector: string) =>
        selector.includes("[data-thread-selection-safe]") ? ({} as Element) : null,
    } as unknown as HTMLElement;

    expect(shouldClearThreadSelectionOnMouseDown(selectionSafe)).toBe(false);
  });

  it("clears selection for unrelated sidebar clicks", () => {
    const unrelated = {
      closest: () => null,
    } as unknown as HTMLElement;

    expect(shouldClearThreadSelectionOnMouseDown(unrelated)).toBe(true);
  });
});

describe("debug feature flags menu visibility", () => {
  it("allows loopback hostnames", () => {
    expect(isLoopbackHostname("localhost")).toBe(true);
    expect(isLoopbackHostname("127.0.0.1")).toBe(true);
    expect(isLoopbackHostname("::1")).toBe(true);
    expect(isLoopbackHostname("[::1]")).toBe(true);
  });

  it("requires dev mode, localhost, and explicit storage opt-in", () => {
    expect(
      shouldShowDebugFeatureFlagsMenu({
        isDev: true,
        hostname: "localhost",
        storageValue: "true",
      }),
    ).toBe(true);

    expect(
      shouldShowDebugFeatureFlagsMenu({
        isDev: false,
        hostname: "localhost",
        storageValue: "true",
      }),
    ).toBe(false);
    expect(
      shouldShowDebugFeatureFlagsMenu({
        isDev: true,
        hostname: "app.example.com",
        storageValue: "true",
      }),
    ).toBe(false);
    expect(
      shouldShowDebugFeatureFlagsMenu({
        isDev: true,
        hostname: "localhost",
        storageValue: null,
      }),
    ).toBe(false);
  });
});

describe("resolveThreadHoverCardMetadata", () => {
  it("includes source project and worktree names for worktree-backed chats", () => {
    const metadata = resolveThreadHoverCardMetadata({
      thread: makeSidebarThreadSummary({
        envMode: "worktree",
        branch: "codex/penkra-mobile",
        worktreePath: "/Users/me/.codex/worktrees/1234/Remodex",
        associatedWorktreePath: "/Users/me/.codex/worktrees/1234/Remodex",
        associatedWorktreeBranch: "codex/penkra-mobile",
      }),
      project: {
        name: "penkra-mobile",
        folderName: "Remodex",
        cwd: "/Users/me/Developer/Remodex",
      },
    });

    expect(metadata).toEqual({
      projectName: "penkra-mobile",
      projectCwd: "/Users/me/Developer/Remodex",
      sourceProjectName: "Remodex",
      branch: "codex/penkra-mobile",
      worktreeName: "Remodex",
    });
  });

  it("keeps local chats compact", () => {
    const metadata = resolveThreadHoverCardMetadata({
      thread: makeSidebarThreadSummary({
        branch: "main",
      }),
      project: {
        name: "penkra",
        folderName: "penkra",
        cwd: "/Users/me/Developer/penkra",
      },
    });

    expect(metadata).toEqual({
      projectName: "penkra",
      projectCwd: "/Users/me/Developer/penkra",
      sourceProjectName: null,
      branch: "main",
      worktreeName: null,
    });
  });
});

describe("resolveSettingsBackTarget", () => {
  it("keeps fresh draft chats available as settings back targets", () => {
    // Mirrors the sidebar's settings-back wiring: persisted thread summaries plus the
    // segment's draft thread ids form the restorable set.
    const availableThreadIds = new Set(["thread-latest", "thread-draft"]);

    expect(
      resolveSettingsBackTarget({
        lastThreadRoute: {
          threadId: "thread-draft",
        },
        availableThreadIds,
        latestThreadId: "thread-latest",
      }),
    ).toEqual({
      kind: "thread",
      threadId: "thread-draft",
    });
  });

  it("returns the remembered live thread route", () => {
    expect(
      resolveSettingsBackTarget({
        lastThreadRoute: {
          threadId: "thread-remembered",
          splitViewId: "split-live",
        },
        availableThreadIds: new Set(["thread-remembered", "thread-latest"]),
        availableSplitViewIds: new Set(["split-live"]),
        latestThreadId: "thread-latest",
      }),
    ).toEqual({
      kind: "thread",
      threadId: "thread-remembered",
      splitViewId: "split-live",
    });
  });

  it("falls back to the latest sidebar thread when the remembered route is stale", () => {
    expect(
      resolveSettingsBackTarget({
        lastThreadRoute: {
          threadId: "thread-missing",
        },
        availableThreadIds: new Set(["thread-latest"]),
        latestThreadId: "thread-latest",
      }),
    ).toEqual({
      kind: "thread",
      threadId: "thread-latest",
    });
  });

  it("falls back to home when no thread target is available", () => {
    expect(
      resolveSettingsBackTarget({
        lastThreadRoute: null,
        availableThreadIds: new Set(),
        latestThreadId: null,
      }),
    ).toEqual({ kind: "home" });
  });
});

describe("pruneProjectThreadListPagingForCollapsedProjects", () => {
  it("clears remembered show-more paging when a project is collapsed", () => {
    const current = new Map([
      ["/Users/tester/Code/one", 2],
      ["/Users/tester/Code/two", 1],
    ]);

    const next = pruneProjectThreadListPagingForCollapsedProjects({
      threadListExtraPagesByProjectCwd: current,
      projects: [
        { cwd: "/Users/tester/Code/one", expanded: false },
        { cwd: "/Users/tester/Code/two", expanded: true },
      ],
      normalizeProjectCwd: (cwd) => cwd.replace(/\/+$/, ""),
    });

    expect([...next]).toEqual([["/Users/tester/Code/two", 1]]);
  });

  it("preserves the existing map when no collapsed project needs pruning", () => {
    const current = new Map([["/Users/tester/Code/one", 1]]);

    const next = pruneProjectThreadListPagingForCollapsedProjects({
      threadListExtraPagesByProjectCwd: current,
      projects: [{ cwd: "/Users/tester/Code/one", expanded: true }],
      normalizeProjectCwd: (cwd) => cwd.replace(/\/+$/, ""),
    });

    expect(next).toBe(current);
  });

  it("resets a pathless folder through its stable project paging key", () => {
    const current = new Map([["project:pathless", 1]]);

    const next = pruneProjectThreadListPagingForCollapsedProjects({
      threadListExtraPagesByProjectCwd: current,
      projects: [{ id: "pathless", cwd: "", expanded: false }],
      normalizeProjectCwd: (cwd) => cwd,
      getProjectPagingKey: (project) => `project:${project.id}`,
    });

    expect(next.size).toBe(0);
  });
});

describe("resolveSidebarThreadListPaging", () => {
  it("keeps the base preview with no paging affordances when everything fits", () => {
    expect(
      resolveSidebarThreadListPaging({
        totalCount: 4,
        baseLimit: 5,
        pageSize: 5,
        requestedExtraPages: 0,
      }),
    ).toEqual({
      effectiveExtraPages: 0,
      previewLimit: 5,
      canShowMore: false,
      canShowLess: false,
    });
  });

  it("adds one page per show-more click and offers show-less only after the first", () => {
    expect(
      resolveSidebarThreadListPaging({
        totalCount: 12,
        baseLimit: 5,
        pageSize: 5,
        requestedExtraPages: 0,
      }),
    ).toEqual({
      effectiveExtraPages: 0,
      previewLimit: 5,
      canShowMore: true,
      canShowLess: false,
    });

    expect(
      resolveSidebarThreadListPaging({
        totalCount: 12,
        baseLimit: 5,
        pageSize: 5,
        requestedExtraPages: 1,
      }),
    ).toEqual({
      effectiveExtraPages: 1,
      previewLimit: 10,
      canShowMore: true,
      canShowLess: true,
    });
  });

  it("clamps oversized requested paging to what the list can actually use", () => {
    expect(
      resolveSidebarThreadListPaging({
        totalCount: 12,
        baseLimit: 5,
        pageSize: 5,
        requestedExtraPages: 9,
      }),
    ).toEqual({
      effectiveExtraPages: 2,
      previewLimit: 15,
      canShowMore: false,
      canShowLess: true,
    });
  });

  it("ignores negative and non-finite requested paging", () => {
    expect(
      resolveSidebarThreadListPaging({
        totalCount: 12,
        baseLimit: 5,
        pageSize: 5,
        requestedExtraPages: -3,
      }).effectiveExtraPages,
    ).toBe(0);
    expect(
      resolveSidebarThreadListPaging({
        totalCount: 12,
        baseLimit: 5,
        pageSize: 5,
        requestedExtraPages: Number.NaN,
      }).effectiveExtraPages,
    ).toBe(0);
  });
});

describe("workspace attribution", () => {
  it("attributes a nested server cwd to the deepest matching project", () => {
    const projects = [
      { id: "repo", cwd: "/Users/tester/Code/repo" },
      { id: "web", cwd: "/Users/tester/Code/repo/apps/web" },
      { id: "other", cwd: "/Users/tester/Code/other" },
    ];

    expect(
      findDeepestWorkspaceRootMatch(
        projects,
        "/Users/tester/Code/repo/apps/web/src",
        (project) => project.cwd,
      )?.id,
    ).toBe("web");
    expect(
      findDeepestWorkspaceRootMatch(
        projects,
        "/Users/tester/Code/repo/apps/server",
        (project) => project.cwd,
      )?.id,
    ).toBe("repo");
    expect(
      findDeepestWorkspaceRootMatch(
        projects,
        "/Users/tester/Code/unrelated",
        (project) => project.cwd,
      ),
    ).toBeUndefined();
  });
});

describe("pin helpers", () => {
  const makeProject = (id: string): Project =>
    ({
      id: id as ContainerId,
      kind: "project",
      name: id,
      remoteName: id,
      folderName: id,
      localName: null,
      cwd: `/tmp/${id}`,
      defaultModelSelection: null,
      expanded: true,
      spaceId: null,
      createdAt: "2026-03-09T10:00:00.000Z",
      updatedAt: "2026-03-09T10:00:00.000Z",
      scripts: [],
    }) satisfies Project;

  const makeThread = (id: string): Thread =>
    ({
      id: id as ThreadId,
      codexThreadId: null,
      projectId: "project-1" as ContainerId,
      title: id,
      modelSelection: {
        provider: "codex",
        model: "gpt-5-codex",
      },
      runtimeMode: DEFAULT_RUNTIME_MODE,
      session: null,
      messages: [],
      error: null,
      createdAt: "2026-03-09T10:00:00.000Z",
      latestTurn: null,
      turnDiffSummaries: [],
      activities: [],
      branch: null,
      worktreePath: null,
    }) satisfies Thread;

  it("lets an optimistic unpin override server and persisted pinned state", () => {
    const threads = [
      {
        ...makeThread("thread-1"),
        isPinned: true,
      },
    ];

    expect(
      derivePinnedThreadIdsForSidebar({
        threads,
        persistedPinnedThreadIds: ["thread-1" as ThreadId],
        optimisticPinnedStateByThreadId: new Map([["thread-1" as ThreadId, false]]),
      }),
    ).toEqual([]);
  });

  it("shows an optimistic pin before the server snapshot confirms it", () => {
    const threads = [makeThread("thread-1")];

    expect(
      derivePinnedThreadIdsForSidebar({
        threads,
        persistedPinnedThreadIds: [],
        optimisticPinnedStateByThreadId: new Map([["thread-1" as ThreadId, true]]),
      }),
    ).toEqual(["thread-1"]);
  });

  it("derives at most three pinned projects and keeps persisted order first", () => {
    const projects = [
      { ...makeProject("project-1"), isPinned: true },
      { ...makeProject("project-2"), isPinned: true },
      { ...makeProject("project-3"), isPinned: true },
      { ...makeProject("project-4"), isPinned: true },
    ];

    expect(
      derivePinnedProjectIdsForSidebar({
        projects,
        persistedPinnedProjectIds: ["project-3" as ContainerId, "project-1" as ContainerId],
        optimisticPinnedStateByProjectId: new Map([["project-1" as ContainerId, false]]),
      }),
    ).toEqual(["project-3", "project-2", "project-4"]);
  });

  it("moves pinned projects to the top while preserving unpinned order", () => {
    const projects = [makeProject("project-1"), makeProject("project-2"), makeProject("project-3")];

    expect(
      orderPinnedProjectsForSidebar(projects, [
        "project-3" as ContainerId,
        "project-1" as ContainerId,
      ]),
    ).toEqual([projects[2], projects[0], projects[1]]);
  });

  it("rejects stale pin mutation versions so old failures cannot roll back newer clicks", () => {
    const threadId = "thread-1" as ThreadId;
    const latestMutationVersionByThreadId = new Map<ThreadId, number>([[threadId, 2]]);
    const projectId = "project-1" as ContainerId;
    const latestMutationVersionByProjectId = new Map<ContainerId, number>([[projectId, 2]]);

    expect(
      isLatestPinnedThreadMutation({
        threadId,
        requestVersion: 1,
        latestMutationVersionByThreadId,
      }),
    ).toBe(false);
    expect(
      isLatestPinnedThreadMutation({
        threadId,
        requestVersion: 2,
        latestMutationVersionByThreadId,
      }),
    ).toBe(true);
    expect(
      isLatestPinnedProjectMutation({
        projectId,
        requestVersion: 1,
        latestMutationVersionByProjectId,
      }),
    ).toBe(false);
    expect(
      isLatestPinnedProjectMutation({
        projectId,
        requestVersion: 2,
        latestMutationVersionByProjectId,
      }),
    ).toBe(true);
  });

  it("waits for thread hydration before pruning persisted pins", () => {
    expect(shouldPrunePinnedThreads({ threadsHydrated: false })).toBe(false);
    expect(shouldPrunePinnedThreads({ threadsHydrated: true })).toBe(true);
  });

  it("shows loading before the first project snapshot can prove the list is empty", () => {
    expect(
      resolveProjectEmptyState({
        projectCount: 0,
        shouldShowProjectPathEntry: false,
        threadsHydrated: false,
      }),
    ).toBe("loading");
    expect(
      resolveProjectEmptyState({
        projectCount: 0,
        shouldShowProjectPathEntry: false,
        threadsHydrated: true,
      }),
    ).toBe("empty");
    expect(
      resolveProjectEmptyState({
        projectCount: 1,
        shouldShowProjectPathEntry: false,
        threadsHydrated: false,
      }),
    ).toBeNull();
  });
});

describe("resolveThreadStatusPill", () => {
  const baseThread = {
    latestTurn: null,
    lastVisitedAt: undefined,
    dismissedStatusKey: undefined,
    updatedAt: "2026-03-09T10:05:00.000Z",
    session: {
      provider: "codex" as const,
      status: "running" as const,
      activeTurnId: "turn-running" as never,
      createdAt: "2026-03-09T10:00:00.000Z",
      updatedAt: "2026-03-09T10:00:00.000Z",
      orchestrationStatus: "running" as const,
    },
  };

  it("shows pending approval before all other statuses", () => {
    expect(
      resolveThreadStatusPill({
        thread: baseThread,
        hasPendingApprovals: true,
        hasPendingUserInput: true,
      }),
    ).toMatchObject({ label: "Pending Approval", pulse: false });
  });

  it("shows awaiting input when the thread is blocked on user answers", () => {
    expect(
      resolveThreadStatusPill({
        thread: baseThread,
        hasPendingApprovals: false,
        hasPendingUserInput: true,
      }),
    ).toMatchObject({ label: "Awaiting Input", pulse: false });
  });

  it("falls back to working when the thread is actively running without blockers", () => {
    expect(
      resolveThreadStatusPill({
        thread: baseThread,
        hasPendingApprovals: false,
        hasPendingUserInput: false,
      }),
    ).toMatchObject({ label: "Working", pulse: true });
  });

  it("keeps showing working while a dispatched turn is waiting for provider start", () => {
    expect(
      resolveThreadStatusPill({
        thread: {
          ...baseThread,
          // A previous turn can remain settled until the provider start event
          // arrives; the durable session state is authoritative in this gap.
          latestTurn: makeLatestTurn(),
          session: {
            ...baseThread.session,
            status: "connecting",
            orchestrationStatus: "starting",
          },
        },
        hasPendingApprovals: false,
        hasPendingUserInput: false,
      }),
    ).toMatchObject({ label: "Working", pulse: true });
  });

  it("surfaces a quarantined or errored session as attention instead of working", () => {
    expect(
      resolveThreadStatusPill({
        thread: {
          ...baseThread,
          session: {
            ...baseThread.session,
            status: "error",
            orchestrationStatus: "error",
          },
        },
        hasPendingApprovals: true,
        hasPendingUserInput: true,
      }),
    ).toMatchObject({ label: "Needs Attention", pulse: false, dismissible: false });
  });

  it("does not keep showing working after the canonical session is ready", () => {
    expect(
      resolveThreadStatusPill({
        thread: {
          ...baseThread,
          session: {
            ...baseThread.session,
            status: "ready",
            orchestrationStatus: "ready",
          },
        },
        hasPendingApprovals: false,
        hasPendingUserInput: false,
      }),
    ).toBeNull();
  });

  it("treats a settled legacy plan turn as an ordinary completion", () => {
    expect(
      resolveThreadStatusPill({
        thread: {
          ...baseThread,
          latestTurn: makeLatestTurn(),
          session: {
            ...baseThread.session,
            status: "ready",
            orchestrationStatus: "ready",
          },
        },
        hasPendingApprovals: false,
        hasPendingUserInput: false,
      }),
    ).toMatchObject({ label: "Completed", pulse: false });
  });

  it("shows completed when there is an unseen completion and no active blocker", () => {
    expect(
      resolveThreadStatusPill({
        thread: {
          ...baseThread,
          latestTurn: makeLatestTurn(),
          lastVisitedAt: "2026-03-09T10:04:00.000Z",
          session: {
            ...baseThread.session,
            status: "ready",
            orchestrationStatus: "ready",
          },
        },
        hasPendingApprovals: false,
        hasPendingUserInput: false,
      }),
    ).toMatchObject({ label: "Completed", pulse: false });
  });

  it("does not revive a removed plan-ready status from a legacy dismissal key", () => {
    expect(
      resolveThreadStatusPill({
        thread: {
          ...baseThread,
          latestTurn: makeLatestTurn(),
          dismissedStatusKey:
            "Plan Ready:2026-03-09T10:05:00.000Z:turn-1:2026-03-09T10:05:00.000Z:2026-03-09T10:00:00.000Z",
          session: {
            ...baseThread.session,
            status: "ready",
            orchestrationStatus: "ready",
          },
        },
        hasPendingApprovals: false,
        hasPendingUserInput: false,
      }),
    ).toMatchObject({ label: "Completed", pulse: false });
  });
});

describe("resolveThreadRowClassName", () => {
  it("keeps selected active rows on the selected sidebar background", () => {
    const className = resolveThreadRowClassName({ isActive: true, isSelected: true });
    expect(className).toContain("bg-[var(--sidebar-accent-active)]");
    expect(className).toContain("hover:bg-[var(--sidebar-accent-active)]");
    expect(className).toContain("text-[var(--sidebar-accent-foreground)]");
    expect(className).not.toContain("bg-[var(--color-background-button-secondary-hover)]");
  });

  it("keeps selected rows visually aligned with hover", () => {
    const className = resolveThreadRowClassName({ isActive: false, isSelected: true });
    expect(className).toContain("bg-[var(--sidebar-accent-active)]");
    expect(className).toContain("hover:bg-[var(--sidebar-accent-active)]");
    expect(className).toContain("text-[var(--sidebar-accent-foreground)]");
    expect(className).not.toContain("bg-[var(--color-background-button-secondary-hover)]");
  });

  it("uses the hover sidebar background for active-only threads", () => {
    const className = resolveThreadRowClassName({ isActive: true, isSelected: false });
    expect(className).toContain("bg-[var(--sidebar-accent-active)]");
    expect(className).toContain("hover:bg-[var(--sidebar-accent-active)]");
  });

  it("uses the sidebar accent token for hover-only rows", () => {
    const className = resolveThreadRowClassName({ isActive: false, isSelected: false });
    expect(className).toContain("hover:bg-[var(--sidebar-accent)]");
    expect(className).not.toContain("hover:bg-[var(--color-background-button-secondary-hover)]");
  });
});

describe("resolveProjectStatusIndicator", () => {
  it("returns null when no threads have a notable status", () => {
    expect(resolveProjectStatusIndicator([null, null])).toBeNull();
  });

  it("surfaces the highest-priority actionable state across project threads", () => {
    expect(
      resolveProjectStatusIndicator([
        {
          label: "Completed",
          colorClass: "text-emerald-600",
          dotClass: "bg-emerald-500",
          pulse: false,
        },
        {
          label: "Pending Approval",
          colorClass: "text-amber-600",
          dotClass: "bg-amber-500",
          pulse: false,
        },
        {
          label: "Working",
          colorClass: "text-sky-600",
          dotClass: "bg-sky-500",
          pulse: true,
        },
      ]),
    ).toMatchObject({ label: "Pending Approval", dotClass: "bg-amber-500" });
  });

  it("prefers awaiting input over completed when action is needed", () => {
    expect(
      resolveProjectStatusIndicator([
        {
          label: "Completed",
          colorClass: "text-emerald-600",
          dotClass: "bg-emerald-500",
          pulse: false,
        },
        {
          label: "Awaiting Input",
          colorClass: "text-violet-600",
          dotClass: "bg-violet-500",
          pulse: false,
        },
      ]),
    ).toMatchObject({ label: "Awaiting Input", dotClass: "bg-violet-500" });
  });

  it("lets every attention state supersede running and completed work", () => {
    expect(
      resolveProjectStatusIndicator([
        {
          label: "Working",
          colorClass: "text-sky-600",
          dotClass: "bg-sky-500",
          pulse: true,
        },
        {
          label: "Completed",
          colorClass: "text-emerald-600",
          dotClass: "bg-emerald-500",
          pulse: false,
        },
        {
          label: "Awaiting Input",
          colorClass: "text-violet-600",
          dotClass: "bg-violet-500",
          pulse: false,
        },
      ]),
    ).toMatchObject({ label: "Awaiting Input" });
  });

  it("keeps an errored thread ahead of other project activity", () => {
    expect(
      resolveProjectStatusIndicator([
        {
          label: "Working",
          colorClass: "text-sky-600",
          dotClass: "bg-sky-500",
          pulse: true,
        },
        {
          label: "Needs Attention",
          colorClass: "text-orange-600",
          dotClass: "bg-orange-500",
          pulse: false,
        },
      ]),
    ).toMatchObject({ label: "Needs Attention" });
  });
});

describe("resolveSidebarWorkStatus", () => {
  it("maps thread pills onto the shared Pencil work-status axis", () => {
    expect(resolveSidebarWorkStatus(null)).toBe("idle");
    expect(
      resolveSidebarWorkStatus({
        label: "Working",
        colorClass: "",
        dotClass: "",
        pulse: true,
      }),
    ).toBe("running");
    expect(
      resolveSidebarWorkStatus({
        label: "Completed",
        colorClass: "",
        dotClass: "",
        pulse: false,
      }),
    ).toBe("done");
    expect(
      resolveSidebarWorkStatus({
        label: "Awaiting Input",
        colorClass: "",
        dotClass: "",
        pulse: false,
      }),
    ).toBe("attention");
    expect(
      resolveSidebarWorkStatus({
        label: "Needs Attention",
        colorClass: "",
        dotClass: "",
        pulse: false,
      }),
    ).toBe("attention");
  });

  it("gives active voice recording precedence over every work status", () => {
    expect(
      resolveSidebarWorkStatus(
        {
          label: "Needs Attention",
          colorClass: "",
          dotClass: "",
          pulse: false,
        },
        true,
      ),
    ).toBe("recording");
    expect(resolveSidebarWorkStatus(null, true)).toBe("recording");
  });
});

describe("getVisibleThreadsForProject", () => {
  it("includes the active thread even when it falls below the folded preview", () => {
    const threads = Array.from({ length: 8 }, (_, index) =>
      makeThread({
        id: ThreadId.makeUnsafe(`thread-${index + 1}`),
        title: `Thread ${index + 1}`,
      }),
    );

    const result = getVisibleThreadsForProject({
      threads,
      activeThreadId: ThreadId.makeUnsafe("thread-8"),
      previewLimit: 6,
    });

    expect(result.hasHiddenThreads).toBe(true);
    expect(result.visibleThreads.map((thread) => thread.id)).toEqual([
      ThreadId.makeUnsafe("thread-1"),
      ThreadId.makeUnsafe("thread-2"),
      ThreadId.makeUnsafe("thread-3"),
      ThreadId.makeUnsafe("thread-4"),
      ThreadId.makeUnsafe("thread-5"),
      ThreadId.makeUnsafe("thread-6"),
      ThreadId.makeUnsafe("thread-8"),
    ]);
  });

  it("returns all threads when the preview limit covers the whole list", () => {
    const threads = Array.from({ length: 8 }, (_, index) =>
      makeThread({
        id: ThreadId.makeUnsafe(`thread-${index + 1}`),
      }),
    );

    const result = getVisibleThreadsForProject({
      threads,
      activeThreadId: ThreadId.makeUnsafe("thread-8"),
      previewLimit: 8,
    });

    expect(result.hasHiddenThreads).toBe(false);
    expect(result.visibleThreads.map((thread) => thread.id)).toEqual(
      threads.map((thread) => thread.id),
    );
  });
});

describe("getRenderedThreadsForSidebarProject", () => {
  it("pins only the active thread when the parent project is collapsed", () => {
    const threads = Array.from({ length: 4 }, (_, index) =>
      makeThread({
        id: ThreadId.makeUnsafe(`thread-${index + 1}`),
        title: `Thread ${index + 1}`,
      }),
    );

    const result = getRenderedThreadsForSidebarProject({
      project: makeProject({ expanded: false }),
      threads,
      activeThreadId: ThreadId.makeUnsafe("thread-4"),
      previewLimit: 2,
    });

    expect(result.hasHiddenThreads).toBe(true);
    expect(result.renderedThreads.map((thread) => thread.id)).toEqual([
      ThreadId.makeUnsafe("thread-4"),
    ]);
  });
});

describe("buildProjectThreadTree", () => {
  it("orders pinned threads first inside their immediate parent without moving them", () => {
    const rows = buildProjectThreadTree({
      threads: [
        makeThread({ id: ThreadId.makeUnsafe("root-unpinned") }),
        makeThread({ id: ThreadId.makeUnsafe("root-pinned") }),
        makeThread({
          id: ThreadId.makeUnsafe("child-unpinned"),
          parentThreadId: ThreadId.makeUnsafe("root-pinned"),
        }),
        makeThread({
          id: ThreadId.makeUnsafe("child-pinned"),
          parentThreadId: ThreadId.makeUnsafe("root-pinned"),
        }),
      ],
      forceVisibleThreadId: ThreadId.makeUnsafe("child-unpinned"),
      pinnedThreadIds: [ThreadId.makeUnsafe("child-pinned"), ThreadId.makeUnsafe("root-pinned")],
    });

    expect(rows.map((row) => [row.thread.id, row.depth])).toEqual([
      [ThreadId.makeUnsafe("root-pinned"), 0],
      [ThreadId.makeUnsafe("child-pinned"), 1],
      [ThreadId.makeUnsafe("child-unpinned"), 1],
      [ThreadId.makeUnsafe("root-unpinned"), 0],
    ]);
  });

  it("keeps inactive child threads out of the sidebar", () => {
    const rows = buildProjectThreadTree({
      threads: [
        makeThread({
          id: ThreadId.makeUnsafe("thread-parent"),
          createdAt: "2026-03-09T10:02:00.000Z",
        }),
        makeThread({
          id: ThreadId.makeUnsafe("thread-child"),
          parentThreadId: ThreadId.makeUnsafe("thread-parent"),
          createdAt: "2026-03-09T10:01:00.000Z",
        }),
      ],
    });

    expect(rows).toEqual([
      expect.objectContaining({
        thread: expect.objectContaining({ id: ThreadId.makeUnsafe("thread-parent") }),
        depth: 0,
      }),
    ]);
  });

  it("reveals the active child thread and its ancestors", () => {
    const rows = buildProjectThreadTree({
      threads: [
        makeThread({
          id: ThreadId.makeUnsafe("thread-parent"),
          createdAt: "2026-03-09T10:03:00.000Z",
        }),
        makeThread({
          id: ThreadId.makeUnsafe("thread-child"),
          parentThreadId: ThreadId.makeUnsafe("thread-parent"),
          createdAt: "2026-03-09T10:02:00.000Z",
        }),
        makeThread({
          id: ThreadId.makeUnsafe("thread-grandchild"),
          parentThreadId: ThreadId.makeUnsafe("thread-child"),
          createdAt: "2026-03-09T10:01:00.000Z",
        }),
      ],
      forceVisibleThreadId: ThreadId.makeUnsafe("thread-grandchild"),
    });

    expect(rows.map((row) => [row.thread.id, row.depth])).toEqual([
      [ThreadId.makeUnsafe("thread-parent"), 0],
      [ThreadId.makeUnsafe("thread-child"), 1],
      [ThreadId.makeUnsafe("thread-grandchild"), 2],
    ]);
  });
});

describe("getVisibleSidebarEntriesForPreview", () => {
  it("caps preview by rendered rows, not root-thread count", () => {
    const result = getVisibleSidebarEntriesForPreview({
      entries: [
        {
          rowId: ThreadId.makeUnsafe("thread-parent"),
          rootRowId: ThreadId.makeUnsafe("thread-parent"),
        },
        {
          rowId: ThreadId.makeUnsafe("thread-child"),
          rootRowId: ThreadId.makeUnsafe("thread-parent"),
        },
        {
          rowId: ThreadId.makeUnsafe("thread-second-root"),
          rootRowId: ThreadId.makeUnsafe("thread-second-root"),
        },
        {
          rowId: ThreadId.makeUnsafe("thread-third-root"),
          rootRowId: ThreadId.makeUnsafe("thread-third-root"),
        },
      ],
      activeEntryId: undefined,
      previewLimit: 2,
    });

    expect(result.hasHiddenEntries).toBe(true);
    expect(result.visibleEntries.map((entry) => entry.rowId)).toEqual([
      ThreadId.makeUnsafe("thread-parent"),
      ThreadId.makeUnsafe("thread-child"),
    ]);
  });

  it("reveals the active row and its ancestor chain when it falls below the preview", () => {
    const entries = [
      {
        rowId: ThreadId.makeUnsafe("thread-parent"),
        rootRowId: ThreadId.makeUnsafe("thread-parent"),
      },
      {
        rowId: ThreadId.makeUnsafe("thread-child"),
        rootRowId: ThreadId.makeUnsafe("thread-parent"),
      },
      {
        rowId: ThreadId.makeUnsafe("thread-second-root"),
        rootRowId: ThreadId.makeUnsafe("thread-second-root"),
      },
      {
        rowId: ThreadId.makeUnsafe("thread-third-root"),
        rootRowId: ThreadId.makeUnsafe("thread-third-root"),
      },
    ];

    const result = getVisibleSidebarEntriesForPreview({
      entries,
      activeEntryId: ThreadId.makeUnsafe("thread-third-root"),
      previewLimit: 2,
    });

    expect(result.hasHiddenEntries).toBe(true);
    expect(result.visibleEntries.map((entry) => entry.rowId)).toEqual([
      ThreadId.makeUnsafe("thread-parent"),
      ThreadId.makeUnsafe("thread-child"),
      ThreadId.makeUnsafe("thread-third-root"),
    ]);
  });
});

describe("getVisibleSidebarThreadIds", () => {
  it("flattens only the sidebar-visible threads in render order", () => {
    const projects = [
      makeProject({ id: ContainerId.makeUnsafe("project-1"), expanded: true }),
      makeProject({ id: ContainerId.makeUnsafe("project-2"), expanded: false }),
    ];
    const threads = [
      makeThread({
        id: ThreadId.makeUnsafe("thread-1"),
        projectId: ContainerId.makeUnsafe("project-1"),
        createdAt: "2026-03-09T10:01:00.000Z",
      }),
      makeThread({
        id: ThreadId.makeUnsafe("thread-2"),
        projectId: ContainerId.makeUnsafe("project-1"),
        parentThreadId: ThreadId.makeUnsafe("thread-1"),
        createdAt: "2026-03-09T10:02:00.000Z",
      }),
      makeThread({
        id: ThreadId.makeUnsafe("thread-3"),
        projectId: ContainerId.makeUnsafe("project-1"),
        createdAt: "2026-03-09T10:03:00.000Z",
      }),
      makeThread({
        id: ThreadId.makeUnsafe("thread-4"),
        projectId: ContainerId.makeUnsafe("project-2"),
        createdAt: "2026-03-09T10:04:00.000Z",
      }),
      makeThread({
        id: ThreadId.makeUnsafe("thread-5"),
        projectId: ContainerId.makeUnsafe("project-2"),
        createdAt: "2026-03-09T10:05:00.000Z",
      }),
    ];

    const visibleThreadIds = getVisibleSidebarThreadIds({
      projects,
      threads,
      activeThreadId: ThreadId.makeUnsafe("thread-4"),
      threadListExtraPagesByProjectId: new Map<ContainerId, number>(),
      previewLimit: 2,
      previewPageSize: 2,
      threadSortOrder: "created_at",
    });

    expect(visibleThreadIds).toEqual([
      ThreadId.makeUnsafe("thread-3"),
      ThreadId.makeUnsafe("thread-1"),
      ThreadId.makeUnsafe("thread-4"),
    ]);
  });

  it("groups interleaved thread input by project before flattening", () => {
    const visibleThreadIds = getVisibleSidebarThreadIds({
      projects: [
        makeProject({ id: ContainerId.makeUnsafe("project-1"), expanded: true }),
        makeProject({ id: ContainerId.makeUnsafe("project-2"), expanded: true }),
      ],
      threads: [
        makeThread({
          id: ThreadId.makeUnsafe("thread-project-2"),
          projectId: ContainerId.makeUnsafe("project-2"),
          createdAt: "2026-03-09T10:03:00.000Z",
        }),
        makeThread({
          id: ThreadId.makeUnsafe("thread-project-1-newer"),
          projectId: ContainerId.makeUnsafe("project-1"),
          createdAt: "2026-03-09T10:02:00.000Z",
        }),
        makeThread({
          id: ThreadId.makeUnsafe("thread-project-1-older"),
          projectId: ContainerId.makeUnsafe("project-1"),
          createdAt: "2026-03-09T10:01:00.000Z",
        }),
      ],
      activeThreadId: undefined,
      threadListExtraPagesByProjectId: new Map<ContainerId, number>(),
      previewLimit: 10,
      previewPageSize: 5,
      threadSortOrder: "created_at",
    });

    expect(visibleThreadIds).toEqual([
      ThreadId.makeUnsafe("thread-project-1-newer"),
      ThreadId.makeUnsafe("thread-project-1-older"),
      ThreadId.makeUnsafe("thread-project-2"),
    ]);
  });

  it("reveals an active subagent without persistent expansion state", () => {
    const visibleThreadIds = getVisibleSidebarThreadIds({
      projects: [makeProject({ id: ContainerId.makeUnsafe("project-1"), expanded: true })],
      threads: [
        makeThread({
          id: ThreadId.makeUnsafe("thread-parent"),
          projectId: ContainerId.makeUnsafe("project-1"),
          createdAt: "2026-03-09T10:03:00.000Z",
        }),
        makeThread({
          id: ThreadId.makeUnsafe("thread-child"),
          projectId: ContainerId.makeUnsafe("project-1"),
          parentThreadId: ThreadId.makeUnsafe("thread-parent"),
          createdAt: "2026-03-09T10:02:00.000Z",
        }),
        makeThread({
          id: ThreadId.makeUnsafe("thread-other"),
          projectId: ContainerId.makeUnsafe("project-1"),
          createdAt: "2026-03-09T10:01:00.000Z",
        }),
      ],
      activeThreadId: ThreadId.makeUnsafe("thread-child"),
      threadListExtraPagesByProjectId: new Map<ContainerId, number>(),
      previewLimit: 6,
      previewPageSize: 5,
      threadSortOrder: "created_at",
    });

    expect(visibleThreadIds).toEqual([
      ThreadId.makeUnsafe("thread-parent"),
      ThreadId.makeUnsafe("thread-child"),
      ThreadId.makeUnsafe("thread-other"),
    ]);
  });
});

describe("getNextVisibleSidebarThreadId", () => {
  const visibleThreadIds = [
    ThreadId.makeUnsafe("thread-1"),
    ThreadId.makeUnsafe("thread-2"),
    ThreadId.makeUnsafe("thread-3"),
  ];

  it("advances to the next visible thread and wraps at the end", () => {
    expect(
      getNextVisibleSidebarThreadId({
        visibleThreadIds,
        activeThreadId: ThreadId.makeUnsafe("thread-3"),
        direction: "forward",
      }),
    ).toBe(ThreadId.makeUnsafe("thread-1"));
  });

  it("moves backward through the visible list and wraps at the start", () => {
    expect(
      getNextVisibleSidebarThreadId({
        visibleThreadIds,
        activeThreadId: ThreadId.makeUnsafe("thread-1"),
        direction: "backward",
      }),
    ).toBe(ThreadId.makeUnsafe("thread-3"));
  });
});

describe("getSidebarThreadIdForJumpCommand", () => {
  const visibleThreadIds = [
    ThreadId.makeUnsafe("thread-1"),
    ThreadId.makeUnsafe("thread-2"),
    ThreadId.makeUnsafe("thread-3"),
  ];

  it("resolves numbered jump commands against the visible sidebar order", () => {
    expect(
      getSidebarThreadIdForJumpCommand({
        visibleThreadIds,
        command: "thread.jump.2",
      }),
    ).toBe(ThreadId.makeUnsafe("thread-2"));
  });

  it("returns null when a jump command points past the visible rows", () => {
    expect(
      getSidebarThreadIdForJumpCommand({
        visibleThreadIds,
        command: "thread.jump.9",
      }),
    ).toBeNull();
  });
});

describe("getSidebarThreadIdsToPrewarm", () => {
  it("returns the first visible sidebar rows up to the requested limit", () => {
    expect(
      getSidebarThreadIdsToPrewarm({
        visibleThreadIds: [
          ThreadId.makeUnsafe("thread-1"),
          ThreadId.makeUnsafe("thread-2"),
          ThreadId.makeUnsafe("thread-3"),
        ],
        limit: 2,
      }),
    ).toEqual([ThreadId.makeUnsafe("thread-1"), ThreadId.makeUnsafe("thread-2")]);
  });

  it("prioritizes the active thread neighborhood before filling the limit", () => {
    expect(
      getSidebarThreadIdsToPrewarm({
        visibleThreadIds: [
          ThreadId.makeUnsafe("thread-1"),
          ThreadId.makeUnsafe("thread-2"),
          ThreadId.makeUnsafe("thread-3"),
          ThreadId.makeUnsafe("thread-4"),
          ThreadId.makeUnsafe("thread-5"),
          ThreadId.makeUnsafe("thread-6"),
        ],
        activeThreadId: ThreadId.makeUnsafe("thread-5"),
        limit: 5,
        neighborRadius: 1,
      }),
    ).toEqual([
      ThreadId.makeUnsafe("thread-4"),
      ThreadId.makeUnsafe("thread-5"),
      ThreadId.makeUnsafe("thread-6"),
      ThreadId.makeUnsafe("thread-1"),
      ThreadId.makeUnsafe("thread-2"),
    ]);
  });
});

describe("createSidebarThreadHoverAnchorId", () => {
  it("keeps duplicated thread rows addressable by sidebar surface", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");

    expect(createSidebarThreadHoverAnchorId({ scope: "pinned", threadId })).toBe("pinned:thread-1");
    expect(createSidebarThreadHoverAnchorId({ scope: "chat", threadId })).toBe("chat:thread-1");
  });
});

function makeProject(overrides: Partial<Project> = {}): Project {
  const { defaultModelSelection, ...rest } = overrides;
  return {
    id: ContainerId.makeUnsafe("project-1"),
    kind: "project",
    name: "Project",
    remoteName: "Project",
    folderName: "project",
    localName: null,
    cwd: "/tmp/project",
    defaultModelSelection: {
      provider: "codex",
      model: "gpt-5.4",
      ...defaultModelSelection,
    },
    expanded: true,
    spaceId: null,
    createdAt: "2026-03-09T10:00:00.000Z",
    updatedAt: "2026-03-09T10:00:00.000Z",
    scripts: [],
    ...rest,
  };
}

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: ThreadId.makeUnsafe("thread-1"),
    codexThreadId: null,
    projectId: ContainerId.makeUnsafe("project-1"),
    title: "Thread",
    modelSelection: {
      provider: "codex",
      model: "gpt-5.4",
      ...overrides?.modelSelection,
    },
    runtimeMode: DEFAULT_RUNTIME_MODE,
    session: null,
    messages: [],
    error: null,
    createdAt: "2026-03-09T10:00:00.000Z",
    updatedAt: "2026-03-09T10:00:00.000Z",
    latestTurn: null,
    branch: null,
    worktreePath: null,
    turnDiffSummaries: [],
    activities: [],
    ...overrides,
  };
}

function makeSidebarThreadSummary(
  overrides: Partial<SidebarThreadSummary> = {},
): SidebarThreadSummary {
  return {
    id: ThreadId.makeUnsafe("thread-1"),
    projectId: ContainerId.makeUnsafe("project-1"),
    title: "Thread",
    modelSelection: {
      provider: "codex",
      model: "gpt-5.4",
    },
    branch: null,
    worktreePath: null,
    session: null,
    createdAt: "2026-03-09T10:00:00.000Z",
    updatedAt: "2026-03-09T10:00:00.000Z",
    latestTurn: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    ...overrides,
  };
}

describe("partitionSidebarThreadsByProjectIds", () => {
  it("splits Studio threads from the regular Threads surface by project id", () => {
    const projectThread = makeSidebarThreadSummary({
      id: ThreadId.makeUnsafe("thread-project"),
      projectId: ContainerId.makeUnsafe("project-app"),
    });
    const studioThread = makeSidebarThreadSummary({
      id: ThreadId.makeUnsafe("thread-studio"),
      projectId: ContainerId.makeUnsafe("project-studio"),
    });

    const partitioned = partitionSidebarThreadsByProjectIds(
      [projectThread, studioThread],
      new Set([ContainerId.makeUnsafe("project-studio")]),
    );

    expect(partitioned.nonStudioThreads.map((thread) => thread.id)).toEqual(["thread-project"]);
    expect(partitioned.studioThreads.map((thread) => thread.id)).toEqual(["thread-studio"]);
  });
});

describe("deriveSidebarProjectData", () => {
  it("keeps a pinned thread in its folder and orders it first", () => {
    const project = makeProject();
    const pinnedThread = makeSidebarThreadSummary({
      id: ThreadId.makeUnsafe("thread-pinned"),
      title: "Pinned",
    });
    const unpinnedThread = makeSidebarThreadSummary({
      id: ThreadId.makeUnsafe("thread-unpinned"),
      title: "Unpinned",
      createdAt: "2026-03-09T10:05:00.000Z",
      updatedAt: "2026-03-09T10:05:00.000Z",
    });

    const data = deriveSidebarProjectData({
      projects: [project],
      sortedSidebarThreadsByProjectId: groupSidebarThreadsByProjectId([
        pinnedThread,
        unpinnedThread,
      ]),
      pinnedThreadIds: [pinnedThread.id],
      threadListExtraPagesByProjectCwd: new Map(),
      normalizeProjectCwd: (cwd) => cwd,
      activeSidebarThreadId: undefined,
      previewLimit: 5,
      previewPageSize: 5,
    });

    expect(data.get(project.id)).toMatchObject({
      allProjectThreadCount: 2,
      orderedProjectThreadIds: [pinnedThread.id, unpinnedThread.id],
      visibleEntries: [
        expect.objectContaining({ rowId: pinnedThread.id }),
        expect.objectContaining({ rowId: unpinnedThread.id }),
      ],
    });
  });

  it("shows split member threads as normal project rows", () => {
    const project = makeProject();
    const sourceThread = makeSidebarThreadSummary({
      id: ThreadId.makeUnsafe("thread-source"),
      title: "Source",
    });
    const droppedThread = makeSidebarThreadSummary({
      id: ThreadId.makeUnsafe("thread-dropped"),
      title: "Dropped",
      createdAt: "2026-03-09T10:05:00.000Z",
      updatedAt: "2026-03-09T10:05:00.000Z",
    });
    const standaloneThread = makeSidebarThreadSummary({
      id: ThreadId.makeUnsafe("thread-standalone"),
      title: "Standalone",
      createdAt: "2026-03-09T10:10:00.000Z",
      updatedAt: "2026-03-09T10:10:00.000Z",
    });

    const data = deriveSidebarProjectData({
      projects: [project],
      sortedSidebarThreadsByProjectId: groupSidebarThreadsByProjectId([
        sourceThread,
        droppedThread,
        standaloneThread,
      ]),
      pinnedThreadIds: [],
      threadListExtraPagesByProjectCwd: new Map(),
      normalizeProjectCwd: (cwd) => cwd,
      activeSidebarThreadId: undefined,
      previewLimit: 5,
      previewPageSize: 5,
    });

    expect(data.get(project.id)?.visibleEntries).toEqual([
      expect.objectContaining({ kind: "thread", rowId: sourceThread.id }),
      expect.objectContaining({ kind: "thread", rowId: droppedThread.id }),
      expect.objectContaining({ kind: "thread", rowId: standaloneThread.id }),
    ]);
  });

  it("keeps the active thread visible when its project is collapsed", () => {
    const project = makeProject({ expanded: false });
    const threadOne = makeSidebarThreadSummary({
      id: ThreadId.makeUnsafe("thread-1"),
      title: "One",
    });
    const threadTwo = makeSidebarThreadSummary({
      id: ThreadId.makeUnsafe("thread-2"),
      title: "Two",
      createdAt: "2026-03-09T10:01:00.000Z",
      updatedAt: "2026-03-09T10:01:00.000Z",
    });
    const threadThree = makeSidebarThreadSummary({
      id: ThreadId.makeUnsafe("thread-3"),
      title: "Three",
      createdAt: "2026-03-09T10:02:00.000Z",
      updatedAt: "2026-03-09T10:02:00.000Z",
    });

    const data = deriveSidebarProjectData({
      projects: [project],
      sortedSidebarThreadsByProjectId: groupSidebarThreadsByProjectId([
        threadOne,
        threadTwo,
        threadThree,
      ]),
      pinnedThreadIds: [],
      threadListExtraPagesByProjectCwd: new Map(),
      normalizeProjectCwd: (cwd) => cwd,
      activeSidebarThreadId: threadThree.id,
      previewLimit: 1,
      previewPageSize: 1,
    });

    expect(data.get(project.id)).toMatchObject({
      activeEntryId: threadThree.id,
      visibleEntries: [
        expect.objectContaining({
          kind: "thread",
          rowId: threadThree.id,
        }),
      ],
    });
  });

  it("uses the provided thread-status resolver for project status", () => {
    const project = makeProject();
    const threadOne = makeSidebarThreadSummary({
      id: ThreadId.makeUnsafe("thread-1"),
      title: "One",
      hasPendingApprovals: true,
    });

    const data = deriveSidebarProjectData({
      projects: [project],
      sortedSidebarThreadsByProjectId: groupSidebarThreadsByProjectId([threadOne]),
      pinnedThreadIds: [],
      threadListExtraPagesByProjectCwd: new Map(),
      normalizeProjectCwd: (cwd) => cwd,
      activeSidebarThreadId: undefined,
      previewLimit: 5,
      previewPageSize: 5,
      resolveThreadStatus: () => null,
    });

    expect(data.get(project.id)?.projectStatus).toBeNull();
  });

  it("pages the thread preview five rows at a time and clamps stale paging", () => {
    const project = makeProject({ cwd: "/Users/tester/Code/demo" });
    const threads = Array.from({ length: 12 }, (_, index) =>
      makeSidebarThreadSummary({
        id: ThreadId.makeUnsafe(`thread-${index + 1}`),
        title: `Thread ${index + 1}`,
        createdAt: `2026-03-09T10:${String(index).padStart(2, "0")}:00.000Z`,
        updatedAt: `2026-03-09T10:${String(index).padStart(2, "0")}:00.000Z`,
      }),
    );
    const derive = (requestedExtraPages: number) =>
      deriveSidebarProjectData({
        projects: [project],
        sortedSidebarThreadsByProjectId: groupSidebarThreadsByProjectId(threads),
        pinnedThreadIds: [],
        threadListExtraPagesByProjectCwd: new Map([[project.cwd, requestedExtraPages]]),
        normalizeProjectCwd: (cwd) => cwd,
        activeSidebarThreadId: undefined,
        previewLimit: 5,
        previewPageSize: 5,
      }).get(project.id);

    expect(derive(0)).toMatchObject({
      threadListExtraPages: 0,
      canShowMoreThreads: true,
      canShowLessThreads: false,
    });
    expect(derive(0)?.visibleEntries).toHaveLength(5);

    expect(derive(1)).toMatchObject({
      threadListExtraPages: 1,
      canShowMoreThreads: true,
      canShowLessThreads: true,
    });
    expect(derive(1)?.visibleEntries).toHaveLength(10);

    // Stale persisted paging beyond the real thread count clamps to the last useful page.
    expect(derive(7)).toMatchObject({
      threadListExtraPages: 2,
      canShowMoreThreads: false,
      canShowLessThreads: true,
    });
    expect(derive(7)?.visibleEntries).toHaveLength(12);
  });

  it("pages a pathless folder using its project id fallback key", () => {
    const project = makeProject({ cwd: "" });
    const pagingKey = `project:${project.id}`;
    const threads = Array.from({ length: 8 }, (_, index) =>
      makeSidebarThreadSummary({
        id: ThreadId.makeUnsafe(`pathless-thread-${index + 1}`),
        title: `Pathless thread ${index + 1}`,
      }),
    );

    const data = deriveSidebarProjectData({
      projects: [project],
      sortedSidebarThreadsByProjectId: groupSidebarThreadsByProjectId(threads),
      pinnedThreadIds: [],
      threadListExtraPagesByProjectCwd: new Map([[pagingKey, 1]]),
      normalizeProjectCwd: (cwd) => cwd,
      getProjectPagingKey: (candidate) => `project:${candidate.id}`,
      activeSidebarThreadId: undefined,
      previewLimit: 5,
      previewPageSize: 5,
    }).get(project.id);

    expect(data?.threadListExtraPages).toBe(1);
    expect(data?.visibleEntries).toHaveLength(8);
    expect(data?.canShowMoreThreads).toBe(false);
  });
});

describe("sortThreadsForSidebar", () => {
  it("keeps pinned items in a manually ordered top block", () => {
    const sorted = sortThreadsForSidebar(
      [
        makeThread({
          id: ThreadId.makeUnsafe("unpinned-first"),
          createdAt: "2026-03-09T12:00:00.000Z",
          sidebarSortOrder: 0,
          isPinned: false,
        }),
        makeThread({
          id: ThreadId.makeUnsafe("pinned-second"),
          createdAt: "2026-03-09T08:00:00.000Z",
          sidebarSortOrder: 1,
          isPinned: true,
        }),
        makeThread({
          id: ThreadId.makeUnsafe("pinned-first"),
          createdAt: "2026-03-09T07:00:00.000Z",
          sidebarSortOrder: 0,
          isPinned: true,
        }),
      ],
      "updated_at",
    );

    expect(sorted.map((thread) => thread.id)).toEqual([
      ThreadId.makeUnsafe("pinned-first"),
      ThreadId.makeUnsafe("pinned-second"),
      ThreadId.makeUnsafe("unpinned-first"),
    ]);
  });

  it("does not reorder idle threads when updatedAt changes", () => {
    const sorted = sortThreadsForSidebar(
      [
        makeThread({
          id: ThreadId.makeUnsafe("thread-1"),
          createdAt: "2026-03-09T10:00:00.000Z",
          updatedAt: "2026-03-09T10:10:00.000Z",
          messages: [
            {
              id: "message-1" as never,
              role: "user",
              text: "older",
              createdAt: "2026-03-09T10:01:00.000Z",
              streaming: false,
              completedAt: "2026-03-09T10:01:00.000Z",
            },
          ],
        }),
        makeThread({
          id: ThreadId.makeUnsafe("thread-2"),
          createdAt: "2026-03-09T10:05:00.000Z",
          updatedAt: "2026-03-09T10:05:00.000Z",
          messages: [
            {
              id: "message-2" as never,
              role: "user",
              text: "newer",
              createdAt: "2026-03-09T10:06:00.000Z",
              streaming: false,
              completedAt: "2026-03-09T10:06:00.000Z",
            },
          ],
        }),
      ],
      "updated_at",
    );

    expect(sorted.map((thread) => thread.id)).toEqual([
      ThreadId.makeUnsafe("thread-2"),
      ThreadId.makeUnsafe("thread-1"),
    ]);
  });

  it("orders untouched idle threads by when they entered idle", () => {
    const sorted = sortThreadsForSidebar(
      [
        makeThread({
          id: ThreadId.makeUnsafe("thread-1"),
          createdAt: "2026-03-09T10:00:00.000Z",
          updatedAt: "2026-03-09T10:01:00.000Z",
          messages: [
            {
              id: "message-1" as never,
              role: "assistant",
              text: "assistant only",
              createdAt: "2026-03-09T10:02:00.000Z",
              streaming: false,
              completedAt: "2026-03-09T10:02:00.000Z",
            },
          ],
        }),
        makeThread({
          id: ThreadId.makeUnsafe("thread-2"),
          createdAt: "2026-03-09T10:05:00.000Z",
          updatedAt: "2026-03-09T10:05:00.000Z",
          messages: [],
        }),
      ],
      "updated_at",
    );

    expect(sorted.map((thread) => thread.id)).toEqual([
      ThreadId.makeUnsafe("thread-2"),
      ThreadId.makeUnsafe("thread-1"),
    ]);
  });

  it("uses deterministic id ordering when manual positions tie", () => {
    const sorted = sortThreadsForSidebar(
      [
        makeThread({
          id: ThreadId.makeUnsafe("thread-1"),
          createdAt: "" as never,
          updatedAt: undefined,
          messages: [],
        }),
        makeThread({
          id: ThreadId.makeUnsafe("thread-2"),
          createdAt: "" as never,
          updatedAt: undefined,
          messages: [],
        }),
      ],
      "updated_at",
    );

    expect(sorted.map((thread) => thread.id)).toEqual([
      ThreadId.makeUnsafe("thread-1"),
      ThreadId.makeUnsafe("thread-2"),
    ]);
  });

  it("can sort threads by createdAt when configured", () => {
    const sorted = sortThreadsForSidebar(
      [
        makeThread({
          id: ThreadId.makeUnsafe("thread-1"),
          createdAt: "2026-03-09T10:05:00.000Z",
          updatedAt: "2026-03-09T10:05:00.000Z",
        }),
        makeThread({
          id: ThreadId.makeUnsafe("thread-2"),
          createdAt: "2026-03-09T10:00:00.000Z",
          updatedAt: "2026-03-09T10:10:00.000Z",
        }),
      ],
      "created_at",
    );

    expect(sorted.map((thread) => thread.id)).toEqual([
      ThreadId.makeUnsafe("thread-1"),
      ThreadId.makeUnsafe("thread-2"),
    ]);
  });

  it("does not let work status change the persisted order", () => {
    const sorted = sortThreadsForSidebar(
      [
        makeThread({
          id: ThreadId.makeUnsafe("thread-idle"),
          createdAt: "2026-03-09T14:00:00.000Z",
          updatedAt: "2026-03-09T14:00:00.000Z",
        }),
        makeThread({
          id: ThreadId.makeUnsafe("thread-completed"),
          createdAt: "2026-03-09T13:00:00.000Z",
          updatedAt: "2026-03-09T13:05:00.000Z",
          latestTurn: makeLatestTurn({ completedAt: "2026-03-09T13:05:00.000Z" }),
        }),
        makeThread({
          id: ThreadId.makeUnsafe("thread-attention"),
          createdAt: "2026-03-09T12:00:00.000Z",
          updatedAt: "2026-03-09T12:05:00.000Z",
          hasPendingApprovals: true,
        }),
        {
          ...makeThread({
            id: ThreadId.makeUnsafe("thread-running"),
            createdAt: "2026-03-09T09:00:00.000Z",
            updatedAt: "2026-03-09T09:05:00.000Z",
          }),
          hasLiveTailWork: true,
        },
      ],
      "updated_at",
    );

    expect(sorted.map((thread) => thread.id)).toEqual([
      ThreadId.makeUnsafe("thread-idle"),
      ThreadId.makeUnsafe("thread-completed"),
      ThreadId.makeUnsafe("thread-attention"),
      ThreadId.makeUnsafe("thread-running"),
    ]);
  });

  it("does not reorder running threads when ordinary updatedAt activity changes", () => {
    const sorted = sortThreadsForSidebar(
      [
        {
          ...makeThread({
            id: ThreadId.makeUnsafe("thread-started-earlier"),
            updatedAt: "2026-03-09T12:00:00.000Z",
            latestTurn: makeLatestTurn({
              startedAt: "2026-03-09T10:00:00.000Z",
              completedAt: null,
            }),
          }),
          hasLiveTailWork: true,
        },
        {
          ...makeThread({
            id: ThreadId.makeUnsafe("thread-started-later"),
            updatedAt: "2026-03-09T11:00:00.000Z",
            latestTurn: makeLatestTurn({
              startedAt: "2026-03-09T11:00:00.000Z",
              completedAt: null,
            }),
          }),
          hasLiveTailWork: true,
        },
      ],
      "updated_at",
    );

    expect(sorted.map((thread) => thread.id)).toEqual([
      ThreadId.makeUnsafe("thread-started-earlier"),
      ThreadId.makeUnsafe("thread-started-later"),
    ]);
  });

  it("keeps an unseen finished thread above idle threads", () => {
    const sorted = sortThreadsForSidebar(
      [
        makeThread({
          id: ThreadId.makeUnsafe("thread-finished"),
          createdAt: "2026-03-09T10:00:00.000Z",
          updatedAt: "2026-03-09T10:00:00.000Z",
          latestTurn: makeLatestTurn({ completedAt: "2026-03-09T10:05:00.000Z" }),
          lastVisitedAt: "2026-03-09T10:01:00.000Z",
        }),
        makeThread({
          id: ThreadId.makeUnsafe("thread-newer"),
          createdAt: "2026-03-09T11:00:00.000Z",
          updatedAt: "2026-03-09T11:00:00.000Z",
        }),
      ],
      "updated_at",
    );

    expect(sorted.map((thread) => thread.id)).toEqual([
      ThreadId.makeUnsafe("thread-newer"),
      ThreadId.makeUnsafe("thread-finished"),
    ]);
  });

  it("does not reorder a finished thread when it is opened", () => {
    const sorted = sortThreadsForSidebar(
      [
        makeThread({
          id: ThreadId.makeUnsafe("thread-finished"),
          createdAt: "2026-03-09T10:00:00.000Z",
          updatedAt: "2026-03-09T10:00:00.000Z",
          latestTurn: makeLatestTurn({ completedAt: "2026-03-09T10:05:00.000Z" }),
          lastVisitedAt: "2026-03-09T10:06:00.000Z",
        }),
        makeThread({
          id: ThreadId.makeUnsafe("thread-newer"),
          createdAt: "2026-03-09T11:00:00.000Z",
          updatedAt: "2026-03-09T11:00:00.000Z",
        }),
      ],
      "updated_at",
    );

    expect(sorted.map((thread) => thread.id)).toEqual([
      ThreadId.makeUnsafe("thread-newer"),
      ThreadId.makeUnsafe("thread-finished"),
    ]);
  });

  it("groups running, completed, and idle threads before comparing transition times", () => {
    const sorted = sortThreadsForSidebar(
      [
        makeThread({
          id: ThreadId.makeUnsafe("thread-newest-plain"),
          createdAt: "2026-03-09T11:00:00.000Z",
          updatedAt: "2026-03-09T11:00:00.000Z",
        }),
        {
          ...makeThread({
            id: ThreadId.makeUnsafe("thread-working"),
            createdAt: "2026-03-09T09:00:00.000Z",
            updatedAt: "2026-03-09T09:00:00.000Z",
          }),
          hasLiveTailWork: true,
        },
        makeThread({
          id: ThreadId.makeUnsafe("thread-finished"),
          createdAt: "2026-03-09T10:00:00.000Z",
          updatedAt: "2026-03-09T10:00:00.000Z",
          latestTurn: makeLatestTurn({ completedAt: "2026-03-09T10:05:00.000Z" }),
        }),
      ],
      "updated_at",
    );

    expect(sorted.map((thread) => thread.id)).toEqual([
      ThreadId.makeUnsafe("thread-newest-plain"),
      ThreadId.makeUnsafe("thread-finished"),
      ThreadId.makeUnsafe("thread-working"),
    ]);
  });

  it("keeps a running session above newer idle threads", () => {
    const sorted = sortThreadsForSidebar(
      [
        makeThread({
          id: ThreadId.makeUnsafe("thread-newer"),
          createdAt: "2026-03-09T11:00:00.000Z",
          updatedAt: "2026-03-09T11:00:00.000Z",
        }),
        makeThread({
          id: ThreadId.makeUnsafe("thread-running"),
          createdAt: "2026-03-09T09:00:00.000Z",
          updatedAt: "2026-03-09T09:00:00.000Z",
          session: {
            provider: "codex" as const,
            status: "running" as const,
            createdAt: "2026-03-09T09:00:00.000Z",
            updatedAt: "2026-03-09T09:00:00.000Z",
            orchestrationStatus: "running" as const,
          },
        }),
      ],
      "updated_at",
    );

    expect(sorted.map((thread) => thread.id)).toEqual([
      ThreadId.makeUnsafe("thread-newer"),
      ThreadId.makeUnsafe("thread-running"),
    ]);
  });

  it("keeps a provider-starting thread in the running group", () => {
    const sorted = sortThreadsForSidebar(
      [
        makeThread({
          id: ThreadId.makeUnsafe("thread-newer"),
          createdAt: "2026-03-09T11:00:00.000Z",
          updatedAt: "2026-03-09T11:00:00.000Z",
        }),
        makeThread({
          id: ThreadId.makeUnsafe("thread-starting"),
          createdAt: "2026-03-09T09:00:00.000Z",
          updatedAt: "2026-03-09T09:00:00.000Z",
          latestTurn: makeLatestTurn(),
          session: {
            provider: "codex" as const,
            status: "connecting" as const,
            createdAt: "2026-03-09T09:00:00.000Z",
            updatedAt: "2026-03-09T09:00:00.000Z",
            orchestrationStatus: "starting" as const,
          },
        }),
      ],
      "updated_at",
    );

    expect(sorted.map((thread) => thread.id)).toEqual([
      ThreadId.makeUnsafe("thread-newer"),
      ThreadId.makeUnsafe("thread-starting"),
    ]);
  });
});

describe("orderSidebarSpaceItems", () => {
  it("places a pinned folder above unpinned direct threads", () => {
    const directThread = {
      ...makeThread({ id: ThreadId.makeUnsafe("thread-running") }),
      hasLiveTailWork: true,
    };
    const folderThread = makeThread({ id: ThreadId.makeUnsafe("thread-in-folder") });

    const ordered = orderSidebarSpaceItems({
      threadItems: [
        {
          id: "direct",
          pinned: false,
          threads: [directThread],
          value: "direct-thread",
        },
      ],
      projectItems: [
        {
          id: "folder",
          pinned: true,
          threads: [folderThread],
          value: "folder",
        },
      ],
      sortOrder: "updated_at",
    });

    expect(ordered).toEqual(["folder", "direct-thread"]);
  });

  it("does not let folder activity change mixed manual order", () => {
    const directIdle = makeThread({
      id: ThreadId.makeUnsafe("direct-idle"),
      createdAt: "2026-03-09T12:00:00.000Z",
    });
    const folderIdle = makeThread({
      id: ThreadId.makeUnsafe("folder-idle"),
      createdAt: "2026-03-09T08:00:00.000Z",
    });
    const folderRunning = {
      ...makeThread({
        id: ThreadId.makeUnsafe("folder-running"),
        latestTurn: makeLatestTurn({
          startedAt: "2026-03-09T09:00:00.000Z",
          completedAt: null,
        }),
      }),
      hasLiveTailWork: true,
    };

    const ordered = orderSidebarSpaceItems({
      threadItems: [{ id: "direct", pinned: false, threads: [directIdle], value: "direct-thread" }],
      projectItems: [
        {
          id: "folder",
          pinned: false,
          threads: [folderIdle, folderRunning],
          value: "folder",
        },
      ],
      sortOrder: "updated_at",
    });

    expect(ordered).toEqual(["direct-thread", "folder"]);
  });

  it("uses a folder timestamp only when the folder has no threads", () => {
    const directIdle = makeThread({
      id: ThreadId.makeUnsafe("direct-idle"),
      createdAt: "2026-03-09T10:00:00.000Z",
    });

    const ordered = orderSidebarSpaceItems({
      threadItems: [{ id: "direct", pinned: false, threads: [directIdle], value: "direct-thread" }],
      projectItems: [
        {
          id: "empty-folder",
          pinned: false,
          threads: [],
          fallbackCreatedAt: "2026-03-09T11:00:00.000Z",
          fallbackUpdatedAt: "2026-03-09T12:00:00.000Z",
          value: "empty-folder",
        },
      ],
      sortOrder: "updated_at",
    });

    expect(ordered).toEqual(["empty-folder", "direct-thread"]);
  });
});

describe("getFallbackThreadIdAfterDelete", () => {
  it("returns the top remaining thread in the deleted thread's project sidebar order", () => {
    const fallbackThreadId = getFallbackThreadIdAfterDelete({
      threads: [
        makeThread({
          id: ThreadId.makeUnsafe("thread-oldest"),
          projectId: ContainerId.makeUnsafe("project-1"),
          createdAt: "2026-03-09T10:00:00.000Z",
          messages: [],
        }),
        makeThread({
          id: ThreadId.makeUnsafe("thread-active"),
          projectId: ContainerId.makeUnsafe("project-1"),
          createdAt: "2026-03-09T10:05:00.000Z",
          messages: [],
        }),
        makeThread({
          id: ThreadId.makeUnsafe("thread-newest"),
          projectId: ContainerId.makeUnsafe("project-1"),
          createdAt: "2026-03-09T10:10:00.000Z",
          messages: [],
        }),
        makeThread({
          id: ThreadId.makeUnsafe("thread-other-project"),
          projectId: ContainerId.makeUnsafe("project-2"),
          createdAt: "2026-03-09T10:20:00.000Z",
          messages: [],
        }),
      ],
      deletedThreadId: ThreadId.makeUnsafe("thread-active"),
      sortOrder: "created_at",
    });

    expect(fallbackThreadId).toBe(ThreadId.makeUnsafe("thread-newest"));
  });

  it("skips other threads being deleted in the same action", () => {
    const fallbackThreadId = getFallbackThreadIdAfterDelete({
      threads: [
        makeThread({
          id: ThreadId.makeUnsafe("thread-active"),
          projectId: ContainerId.makeUnsafe("project-1"),
          createdAt: "2026-03-09T10:05:00.000Z",
          messages: [],
        }),
        makeThread({
          id: ThreadId.makeUnsafe("thread-newest"),
          projectId: ContainerId.makeUnsafe("project-1"),
          createdAt: "2026-03-09T10:10:00.000Z",
          messages: [],
        }),
        makeThread({
          id: ThreadId.makeUnsafe("thread-next"),
          projectId: ContainerId.makeUnsafe("project-1"),
          createdAt: "2026-03-09T10:07:00.000Z",
          messages: [],
        }),
      ],
      deletedThreadId: ThreadId.makeUnsafe("thread-active"),
      deletedThreadIds: new Set([
        ThreadId.makeUnsafe("thread-active"),
        ThreadId.makeUnsafe("thread-newest"),
      ]),
      sortOrder: "created_at",
    });

    expect(fallbackThreadId).toBe(ThreadId.makeUnsafe("thread-next"));
  });
});

describe("sortProjectsForSidebar", () => {
  it("sorts projects by the most recent thread updatedAt", () => {
    const projects = [
      makeProject({ id: ContainerId.makeUnsafe("project-1"), name: "Older project" }),
      makeProject({ id: ContainerId.makeUnsafe("project-2"), name: "Newer project" }),
    ];
    const threads = [
      makeThread({
        projectId: ContainerId.makeUnsafe("project-1"),
        updatedAt: "2026-03-09T10:20:00.000Z",
        messages: [
          {
            id: "message-1" as never,
            role: "user",
            text: "older project user message",
            createdAt: "2026-03-09T10:01:00.000Z",
            streaming: false,
            completedAt: "2026-03-09T10:01:00.000Z",
          },
        ],
      }),
      makeThread({
        id: ThreadId.makeUnsafe("thread-2"),
        projectId: ContainerId.makeUnsafe("project-2"),
        updatedAt: "2026-03-09T10:05:00.000Z",
        messages: [
          {
            id: "message-2" as never,
            role: "user",
            text: "newer project user message",
            createdAt: "2026-03-09T10:05:00.000Z",
            streaming: false,
            completedAt: "2026-03-09T10:05:00.000Z",
          },
        ],
      }),
    ];

    const sorted = sortProjectsForSidebar(projects, threads, "updated_at");

    expect(sorted.map((project) => project.id)).toEqual([
      ContainerId.makeUnsafe("project-1"),
      ContainerId.makeUnsafe("project-2"),
    ]);
  });

  it("does not let project activity timestamps change manual order", () => {
    const sorted = sortProjectsForSidebar(
      [
        makeProject({
          id: ContainerId.makeUnsafe("project-1"),
          name: "Older project",
          updatedAt: "2026-03-09T10:01:00.000Z",
        }),
        makeProject({
          id: ContainerId.makeUnsafe("project-2"),
          name: "Newer project",
          updatedAt: "2026-03-09T10:05:00.000Z",
        }),
      ],
      [],
      "updated_at",
    );

    expect(sorted.map((project) => project.id)).toEqual([
      ContainerId.makeUnsafe("project-1"),
      ContainerId.makeUnsafe("project-2"),
    ]);
  });

  it("falls back to name and id ordering when projects have no sortable timestamps", () => {
    const sorted = sortProjectsForSidebar(
      [
        makeProject({
          id: ContainerId.makeUnsafe("project-2"),
          name: "Beta",
          createdAt: undefined,
          updatedAt: undefined,
        }),
        makeProject({
          id: ContainerId.makeUnsafe("project-1"),
          name: "Alpha",
          createdAt: undefined,
          updatedAt: undefined,
        }),
      ],
      [],
      "updated_at",
    );

    expect(sorted.map((project) => project.id)).toEqual([
      ContainerId.makeUnsafe("project-1"),
      ContainerId.makeUnsafe("project-2"),
    ]);
  });

  it("preserves manual project ordering", () => {
    const projects = [
      makeProject({
        id: ContainerId.makeUnsafe("project-2"),
        name: "Second",
        sidebarSortOrder: 0,
      }),
      makeProject({
        id: ContainerId.makeUnsafe("project-1"),
        name: "First",
        sidebarSortOrder: 1,
      }),
    ];

    const sorted = sortProjectsForSidebar(projects, [], "manual");

    expect(sorted.map((project) => project.id)).toEqual([
      ContainerId.makeUnsafe("project-2"),
      ContainerId.makeUnsafe("project-1"),
    ]);
  });

  it("returns the project timestamp when no threads are present", () => {
    const timestamp = getProjectSortTimestamp(
      makeProject({ updatedAt: "2026-03-09T10:10:00.000Z" }),
      [],
      "updated_at",
    );

    expect(timestamp).toBe(Date.parse("2026-03-09T10:10:00.000Z"));
  });
});
