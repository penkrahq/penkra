// FILE: useThreadActivationController.ts
// Purpose: Centralize sidebar thread activation side effects around the pure activation policy.
// Exports: useThreadActivationController

import type { useNavigate } from "@tanstack/react-router";
import type { ThreadId } from "@penkra/contracts";
import type { LastThreadRoute } from "../chatRouteRestore";
import { type PaneId, type SplitView, type SplitViewId } from "../splitViewStore";
import { selectThreadTerminalState } from "../terminalStateStore";
import type { SidebarThreadSummary } from "../types";
import {
  resolvePreferredSplitForCommand,
  resolveThreadCommandActivation,
} from "../threadActivation.logic";

type Navigate = ReturnType<typeof useNavigate>;
type ThreadTerminalStateById = Parameters<typeof selectThreadTerminalState>[0];
type SidebarThreadActivationSummary = Pick<SidebarThreadSummary, "id" | "folderId">;

export type ThreadActivationControllerInput = {
  activeSplitView: SplitView | null;
  clearSelection: () => void;
  navigate: Navigate;
  openChatThreadPage: (threadId: ThreadId) => void;
  openTerminalThreadPage: (threadId: ThreadId) => void;
  prewarmThreadDetailForIntent: (threadId: ThreadId) => void;
  rememberLastThreadRouteNow: (nextLastThreadRoute: LastThreadRoute) => void;
  routeSplitViewId: string | null | undefined;
  routeThreadId: ThreadId | null | undefined;
  selectedThreadCount: number;
  setOptimisticActiveThreadId: (threadId: ThreadId) => void;
  setSelectionAnchor: (threadId: ThreadId) => void;
  setSplitFocusedPane: (splitViewId: SplitViewId, paneId: PaneId) => void;
  sidebarThreadSummaryById: Readonly<Partial<Record<ThreadId, SidebarThreadActivationSummary>>>;
  splitViewsById: Record<SplitViewId, SplitView | undefined>;
  terminalStateByThreadId: ThreadTerminalStateById;
};

// Runs the complete sidebar activation side-effect chain for one thread intent.
export function activateThreadFromSidebarIntent(
  input: ThreadActivationControllerInput,
  threadId: ThreadId,
): void {
  const {
    activeSplitView,
    clearSelection,
    navigate,
    prewarmThreadDetailForIntent,
    rememberLastThreadRouteNow,
    routeSplitViewId,
    routeThreadId,
    selectedThreadCount,
    setOptimisticActiveThreadId,
    setSelectionAnchor,
    setSplitFocusedPane,
    sidebarThreadSummaryById,
    splitViewsById,
  } = input;

  // Active split wins first; otherwise every persisted split block can restore deterministically.
  const preferredSplit = resolvePreferredSplitForCommand({
    activeSplitView,
    splitViewsById,
    threadId,
  });
  const targetThread = sidebarThreadSummaryById[threadId];
  const activation = resolveThreadCommandActivation({
    threadId,
    threadExists: targetThread !== undefined,
    activeSidebarThreadId: routeThreadId,
    preferredSplitViewId: preferredSplit?.splitViewId ?? null,
    splitPaneId: preferredSplit?.paneId ?? null,
  });

  if (activation.kind === "ignore") {
    return;
  }

  if (activation.kind === "single") {
    activateThreadSingle(input, activation.threadId);
    return;
  }

  if (routeThreadId === activation.threadId && routeSplitViewId === activation.splitViewId) {
    return;
  }

  prewarmThreadDetailForIntent(activation.threadId);
  setOptimisticActiveThreadId(activation.threadId);
  if (selectedThreadCount > 0) {
    clearSelection();
  }
  setSelectionAnchor(activation.threadId);
  setSplitFocusedPane(activation.splitViewId, activation.paneId);
  rememberLastThreadRouteNow({
    threadId: activation.threadId,
    splitViewId: activation.splitViewId,
  });
  void navigate({
    to: "/$threadId",
    params: { threadId: activation.threadId },
    search: (previous) => ({
      ...previous,
      splitViewId: activation.splitViewId,
    }),
  });
}

// Opens the target as a single chat while preserving chat-vs-terminal entry point.
function activateThreadSingle(input: ThreadActivationControllerInput, threadId: ThreadId): void {
  if (!input.sidebarThreadSummaryById[threadId]) return;

  input.prewarmThreadDetailForIntent(threadId);
  input.setOptimisticActiveThreadId(threadId);
  if (input.selectedThreadCount > 0) {
    input.clearSelection();
  }
  input.setSelectionAnchor(threadId);

  const threadEntryPoint = selectThreadTerminalState(
    input.terminalStateByThreadId,
    threadId,
  ).entryPoint;
  if (threadEntryPoint === "terminal") {
    input.openTerminalThreadPage(threadId);
  } else {
    input.openChatThreadPage(threadId);
  }

  void input.navigate({
    to: "/$threadId",
    params: { threadId },
    search: (previous) => ({
      ...previous,
      splitViewId: undefined,
    }),
  });
}

export function useThreadActivationController(input: ThreadActivationControllerInput): {
  activateThreadFromSidebarIntent: (threadId: ThreadId) => void;
} {
  const {
    activeSplitView,
    clearSelection,
    navigate,
    openChatThreadPage,
    openTerminalThreadPage,
    prewarmThreadDetailForIntent,
    rememberLastThreadRouteNow,
    routeSplitViewId,
    routeThreadId,
    selectedThreadCount,
    setOptimisticActiveThreadId,
    setSelectionAnchor,
    setSplitFocusedPane,
    sidebarThreadSummaryById,
    splitViewsById,
    terminalStateByThreadId,
  } = input;

  const activateThread = (threadId: ThreadId) => {
    activateThreadFromSidebarIntent(
      {
        activeSplitView,
        clearSelection,
        navigate,
        openChatThreadPage,
        openTerminalThreadPage,
        prewarmThreadDetailForIntent,
        rememberLastThreadRouteNow,
        routeSplitViewId,
        routeThreadId,
        selectedThreadCount,
        setOptimisticActiveThreadId,
        setSelectionAnchor,
        setSplitFocusedPane,
        sidebarThreadSummaryById,
        splitViewsById,
        terminalStateByThreadId,
      },
      threadId,
    );
  };

  return { activateThreadFromSidebarIntent: activateThread };
}
