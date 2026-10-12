// FILE: useThreadActivationController.ts
// Purpose: Centralize sidebar thread activation side effects around the pure activation policy.
// Exports: useThreadActivationController

import type { useNavigate } from "@tanstack/react-router";
import type { ThreadId } from "@penkra/contracts";
import type { LastThreadRoute } from "../chatRouteRestore";
import type { SidebarThreadSummary } from "../types";
import { resolveThreadCommandActivation } from "../threadActivation.logic";

type Navigate = ReturnType<typeof useNavigate>;
type SidebarThreadActivationSummary = Pick<SidebarThreadSummary, "id" | "folderId">;

export type ThreadActivationControllerInput = {
  clearSelection: () => void;
  navigate: Navigate;
  rememberLastThreadRouteNow: (nextLastThreadRoute: LastThreadRoute) => void;
  routeThreadId: ThreadId | null | undefined;
  selectedThreadCount: number;
  setSelectionAnchor: (threadId: ThreadId) => void;
  sidebarThreadSummaryById: Readonly<Partial<Record<ThreadId, SidebarThreadActivationSummary>>>;
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

  if (input.selectedThreadCount > 0) input.clearSelection();
  input.setSelectionAnchor(threadId);
  input.rememberLastThreadRouteNow({ threadId });

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
