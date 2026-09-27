// FILE: useThreadActivationController.ts
// Purpose: Centralize sidebar thread activation side effects around the pure activation policy.
// Exports: useThreadActivationController

import type { useNavigate } from "@tanstack/react-router";
import type { ThreadId } from "@penkra/contracts";
import type { LastThreadRoute } from "../chatRouteRestore";
import { selectThreadTerminalState } from "../terminalStateStore";
import type { SidebarThreadSummary } from "../types";
import { resolveThreadCommandActivation } from "../threadActivation.logic";

type Navigate = ReturnType<typeof useNavigate>;
type ThreadTerminalStateById = Parameters<typeof selectThreadTerminalState>[0];
type SidebarThreadActivationSummary = Pick<SidebarThreadSummary, "id" | "folderId">;

export type ThreadActivationControllerInput = {
  clearSelection: () => void;
  navigate: Navigate;
  openChatThreadPage: (threadId: ThreadId) => void;
  openTerminalThreadPage: (threadId: ThreadId) => void;
  prewarmThreadDetailForIntent: (threadId: ThreadId) => void;
  rememberLastThreadRouteNow: (nextLastThreadRoute: LastThreadRoute) => void;
  routeThreadId: ThreadId | null | undefined;
  selectedThreadCount: number;
  setOptimisticActiveThreadId: (threadId: ThreadId) => void;
  setSelectionAnchor: (threadId: ThreadId) => void;
  sidebarThreadSummaryById: Readonly<Partial<Record<ThreadId, SidebarThreadActivationSummary>>>;
  terminalStateByThreadId: ThreadTerminalStateById;
};

export function activateThreadFromSidebarIntent(
  input: ThreadActivationControllerInput,
  threadId: ThreadId,
): void {
  const activation = resolveThreadCommandActivation({
    threadId,
    threadExists: input.sidebarThreadSummaryById[threadId] !== undefined,
    activeSidebarThreadId: input.routeThreadId,
  });
  if (activation.kind === "ignore") return;

  input.prewarmThreadDetailForIntent(threadId);
  input.setOptimisticActiveThreadId(threadId);
  if (input.selectedThreadCount > 0) input.clearSelection();
  input.setSelectionAnchor(threadId);
  input.rememberLastThreadRouteNow({ threadId });

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
    search: () => ({}),
  });
}

export function useThreadActivationController(input: ThreadActivationControllerInput): {
  activateThreadFromSidebarIntent: (threadId: ThreadId) => void;
} {
  return {
    activateThreadFromSidebarIntent: (threadId) => activateThreadFromSidebarIntent(input, threadId),
  };
}
