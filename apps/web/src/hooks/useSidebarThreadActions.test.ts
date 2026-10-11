// FILE: useSidebarThreadActions.test.ts
// Purpose: Characterizes Sidebar archive serialization/undo, and batch deletion.
// Layer: Web hook tests

import type { SidebarThreadRow } from "../sidebarThreadRows";
import { FolderId, SpaceId, ThreadId } from "@penkra/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isLocalThreadArchiveNavigationPending } from "../lib/threadArchiveNavigation";

const reactHarness = vi.hoisted(() => {
  interface HookSlot {
    value?: unknown;
    deps?: readonly unknown[];
    cleanup?: (() => void) | undefined;
  }
  let slots: HookSlot[] = [];
  let cursor = 0;
  const nextSlot = () => {
    const slot = (slots[cursor] ??= {});
    cursor += 1;
    return slot;
  };
  // Vitest requires helpers referenced by a hoisted factory to stay inside that factory.
  // oxlint-disable-next-line consistent-function-scoping
  const depsEqual = (left: readonly unknown[] | undefined, right: readonly unknown[]) =>
    left !== undefined &&
    left.length === right.length &&
    left.every((value, index) => Object.is(value, right[index]));
  return {
    beginRender() {
      cursor = 0;
    },
    reset() {
      slots = [];
      cursor = 0;
    },
    useCallback<T>(callback: T, deps: readonly unknown[]): T {
      const slot = nextSlot();
      if (!depsEqual(slot.deps, deps)) {
        slot.deps = deps;
        slot.value = callback;
      }
      return slot.value as T;
    },
    useEffect(effect: () => void | (() => void), deps: readonly unknown[]) {
      const slot = nextSlot();
      if (depsEqual(slot.deps, deps)) return;
      slot.cleanup?.();
      slot.deps = deps;
      slot.cleanup = effect() ?? undefined;
    },
    useMemo<T>(factory: () => T, deps: readonly unknown[]): T {
      const slot = nextSlot();
      if (!depsEqual(slot.deps, deps)) {
        slot.deps = deps;
        slot.value = factory();
      }
      return slot.value as T;
    },
    useRef<T>(value: T) {
      const slot = nextSlot();
      if (!("value" in slot)) slot.value = { current: value };
      return slot.value as { current: T };
    },
    useState<T>(initialValue: T | (() => T)) {
      const slot = nextSlot();
      if (!("value" in slot)) {
        slot.value =
          typeof initialValue === "function" ? (initialValue as () => T)() : initialValue;
      }
      const setValue = (next: T | ((current: T) => T)) => {
        slot.value =
          typeof next === "function" ? (next as (current: T) => T)(slot.value as T) : next;
      };
      return [slot.value as T, setValue] as const;
    },
  };
});

const harness = vi.hoisted(() => ({
  dispatchCommand: vi.fn(),
  confirm: vi.fn(),
  archiveThread: vi.fn(),
  unarchiveThread: vi.fn(),
  activeThreadDelete: vi.fn(),
  navigate: vi.fn(),
  toast: vi.fn(),
  removeFromSelection: vi.fn(),
  reconcileDeletedThreads: vi.fn(),
  clearDraftThread: vi.fn(),
  clearProjectDraftThreadById: vi.fn(),
  clearTerminalState: vi.fn(),
  handleNewChat: vi.fn(),
  removeDeletedThreadFromClientState: vi.fn(),
}));

vi.mock("react", () => ({
  useCallback: reactHarness.useCallback,
  useEffect: reactHarness.useEffect,
  useMemo: reactHarness.useMemo,
  useRef: reactHarness.useRef,
  useState: reactHarness.useState,
}));

vi.mock("@tanstack/react-query", () => ({
  useMutation: () => ({ mutateAsync: vi.fn() }),
  useQueryClient: () => ({}),
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => harness.navigate }));
vi.mock("../lib/gitReactQuery", () => ({ gitRemoveWorktreeMutationOptions: () => ({}) }));
vi.mock("../composerDraftStore", () => ({
  useComposerDraftStore: (selector: (state: unknown) => unknown) =>
    selector({
      clearDraftThread: harness.clearDraftThread,
      clearProjectDraftThreadById: harness.clearProjectDraftThreadById,
    }),
}));
vi.mock("../threadSelectionStore", () => ({
  useThreadSelectionStore: (selector: (state: unknown) => unknown) =>
    selector({ removeFromSelection: harness.removeFromSelection }),
}));
vi.mock("../nativeApi", () => ({
  readNativeApi: () => ({
    cleanCore: { updateThread: harness.dispatchCommand },
    orchestration: { dispatchCommand: harness.dispatchCommand },
    dialogs: { confirm: harness.confirm },
  }),
}));
vi.mock("../lib/threadArchive", () => ({
  archiveThreadFromClient: harness.archiveThread,
  unarchiveThreadFromClient: harness.unarchiveThread,
}));
vi.mock("../lib/activeThreadDelete", () => ({
  deleteActiveThreadFromClient: harness.activeThreadDelete,
}));
vi.mock("../lib/deletedThreadClientReconciliation", () => ({
  reconcileDeletedThreadsFromClient: harness.reconcileDeletedThreads,
}));
vi.mock("../components/ui/toast", () => ({ toastManager: { add: harness.toast } }));
vi.mock("../store", () => ({
  useStore: {
    getState: () => ({
      removeDeletedThreadFromClientState: harness.removeDeletedThreadFromClientState,
    }),
  },
}));
vi.mock("../threadDerivation", () => ({
  getThreadFromState: (_state: unknown, threadId: ThreadId) => ({
    id: threadId,
    archivedAt: null,
  }),
}));

import type { Project } from "../types";
import { useSidebarThreadActions } from "./useSidebarThreadActions";

const PROJECT_ID = FolderId.makeUnsafe("project-actions");
const THREAD_ID = ThreadId.makeUnsafe("thread-actions");
const FALLBACK_ID = ThreadId.makeUnsafe("thread-fallback");
const PROJECT = {
  id: PROJECT_ID,
  spaceId: SpaceId.makeUnsafe("space-test"),
  name: "Actions",
  remoteName: "Actions",
  folderName: "actions",
  localName: null,
  cwd: "/repo",
  defaultModelSelection: null,
  expanded: true,
  scripts: [],
} satisfies Project;

function makeThread(id: ThreadId, overrides: Partial<SidebarThreadRow> = {}) {
  return {
    id,
    folderId: PROJECT_ID,
    title: String(id),
    modelSelection: { provider: "codex", model: "gpt-5.6" },
    session: null,
    createdAt: id === THREAD_ID ? "2026-07-20T00:00:00.000Z" : "2026-07-19T00:00:00.000Z",
    latestTurn: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasLiveTailWork: false,
    ...overrides,
  } as SidebarThreadRow;
}

let sidebarThreads: SidebarThreadRow[];

function render(
  overrides: {
    routeThreadId?: ThreadId | null;
    threadsHydrated?: boolean;
  } = {},
) {
  reactHarness.beginRender();
  return useSidebarThreadActions({
    appSettings: {
      confirmThreadDelete: false,
      sidebarThreadSortOrder: "updated_at",
    },
    clearTerminalState: harness.clearTerminalState,
    handleNewChat: harness.handleNewChat,
    projectById: new Map([[PROJECT_ID, PROJECT]]),
    routeThreadId: overrides.routeThreadId ?? null,
    sidebarThreads,
    sidebarTreeThreads: sidebarThreads,
    sidebarThreadSummaryById: Object.fromEntries(
      sidebarThreads.map((thread) => [thread.id, thread]),
    ),
    threadsHydrated: overrides.threadsHydrated ?? false,
  });
}

beforeEach(() => {
  reactHarness.reset();
  sidebarThreads = [makeThread(THREAD_ID), makeThread(FALLBACK_ID)];
  for (const mock of [
    harness.dispatchCommand,
    harness.confirm,
    harness.archiveThread,
    harness.unarchiveThread,
    harness.activeThreadDelete,
    harness.navigate,
    harness.toast,
    harness.removeFromSelection,
    harness.reconcileDeletedThreads,
    harness.clearDraftThread,
    harness.clearProjectDraftThreadById,
    harness.clearTerminalState,
    harness.handleNewChat,
  ]) {
    mock.mockReset();
  }
  harness.dispatchCommand.mockResolvedValue(undefined);
  harness.archiveThread.mockResolvedValue(undefined);
  harness.unarchiveThread.mockResolvedValue(undefined);
  harness.confirm.mockResolvedValue(true);
  harness.handleNewChat.mockResolvedValue({ ok: true });
  harness.activeThreadDelete.mockImplementation(async (input: unknown) => {
    const action = input as {
      prepareForDelete?: () => unknown;
      onDeleted: (input: {
        thread: { id: ThreadId; folderId: FolderId };
        prepared?: unknown;
      }) => void;
    };
    const prepared = action.prepareForDelete?.();
    action.onDeleted({ thread: { id: THREAD_ID, folderId: PROJECT_ID }, prepared });
  });
  vi.stubGlobal("window", {
    setTimeout: (callback: () => void) => {
      callback();
      return 1;
    },
    clearTimeout: vi.fn(),
  });
});

describe("useSidebarThreadActions", () => {
  it("keeps archive available while server-side runtime cleanup is pending", async () => {
    await expect(render().archiveThread(THREAD_ID)).resolves.toBe(true);

    expect(harness.archiveThread).toHaveBeenCalledWith(expect.anything(), THREAD_ID);
  });

  it("requires native confirmation before archiving a thread", async () => {
    harness.confirm.mockResolvedValue(false);

    await render().confirmAndArchiveThread(THREAD_ID);

    expect(harness.confirm).toHaveBeenCalledWith(
      expect.stringContaining(`Archive thread "${THREAD_ID}"?`),
    );
    expect(harness.archiveThread).not.toHaveBeenCalled();
  });

  it("serializes archives and navigates the active thread to its fallback", async () => {
    let releaseArchive!: () => void;
    harness.archiveThread.mockImplementation(
      () => new Promise<void>((resolve) => (releaseArchive = resolve)),
    );
    const controller = render({ routeThreadId: THREAD_ID });

    const first = controller.archiveThread(THREAD_ID);
    expect(isLocalThreadArchiveNavigationPending(THREAD_ID)).toBe(true);
    const duplicate = controller.archiveThread(THREAD_ID);
    await expect(duplicate).resolves.toBe(false);
    releaseArchive();
    await expect(first).resolves.toBe(true);
    expect(isLocalThreadArchiveNavigationPending(THREAD_ID)).toBe(false);

    expect(harness.archiveThread).toHaveBeenCalledOnce();
    expect(harness.navigate).toHaveBeenCalledWith(
      expect.objectContaining({ params: { threadId: FALLBACK_ID }, replace: true }),
    );
  });

  it("treats the idempotent restore result as successful Undo", async () => {
    harness.unarchiveThread.mockResolvedValue(undefined);
    const controller = render({ routeThreadId: THREAD_ID });
    await controller.archiveThreadWithUndo(THREAD_ID);
    const toast = harness.toast.mock.calls.at(-1)?.[0] as {
      data: { archiveUndo: { onUndo: () => Promise<boolean> } };
    };

    harness.navigate.mockClear();
    await expect(toast.data.archiveUndo.onUndo()).resolves.toBe(true);

    expect(harness.unarchiveThread).toHaveBeenCalledOnce();
    expect(harness.navigate).toHaveBeenCalledWith(
      expect.objectContaining({ params: { threadId: THREAD_ID }, replace: true }),
    );
    expect(harness.unarchiveThread.mock.invocationCallOrder[0]).toBeLessThan(
      harness.navigate.mock.invocationCallOrder[0]!,
    );
  });

  it("deduplicates concurrent Undo requests", async () => {
    let resolveUndo!: () => void;
    harness.unarchiveThread.mockImplementation(
      () => new Promise<void>((resolve) => (resolveUndo = resolve)),
    );
    const controller = render({ routeThreadId: THREAD_ID });
    await controller.archiveThreadWithUndo(THREAD_ID);
    const toast = harness.toast.mock.calls.at(-1)?.[0] as {
      data: { archiveUndo: { onUndo: () => Promise<boolean> } };
    };

    const first = toast.data.archiveUndo.onUndo();
    await expect(toast.data.archiveUndo.onUndo()).resolves.toBe(false);
    resolveUndo();
    await expect(first).resolves.toBe(true);

    expect(harness.unarchiveThread).toHaveBeenCalledOnce();
  });

  it("continues project deletion after failures and reconciles only successful ids", async () => {
    const thirdId = ThreadId.makeUnsafe("thread-third");
    sidebarThreads = [makeThread(THREAD_ID), makeThread(thirdId)];
    harness.activeThreadDelete
      .mockRejectedValueOnce(new Error("first failed"))
      .mockImplementationOnce(async (input: unknown) => {
        const action = input as {
          onDeleted: (input: { thread: { id: ThreadId; folderId: FolderId } }) => void;
        };
        action.onDeleted({ thread: { id: thirdId, folderId: PROJECT_ID } });
      });

    const result = await render().deleteProjectThreads(PROJECT_ID, { confirmMessage: null });

    expect(harness.activeThreadDelete).toHaveBeenCalledTimes(2);
    expect(harness.reconcileDeletedThreads).toHaveBeenCalledWith(
      expect.objectContaining({ threadIds: [thirdId] }),
    );
    expect(result).toMatchObject({ deletedCount: 1, failureCount: 1, totalCount: 2 });
  });

  it("opens a fresh chat when deleting the last thread leaves no fallback", async () => {
    sidebarThreads = [makeThread(THREAD_ID)];
    await render({ routeThreadId: THREAD_ID }).deleteThread(THREAD_ID);
    expect(harness.navigate).not.toHaveBeenCalled();
    expect(harness.handleNewChat).toHaveBeenCalledWith({ fresh: true });
  });
});
