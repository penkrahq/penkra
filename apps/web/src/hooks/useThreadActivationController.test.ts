import { describe, expect, it, vi } from "vitest";

import { FolderId, ThreadId } from "@penkra/contracts";
import {
  activateThreadFromSidebarIntent,
  type ThreadActivationControllerInput,
} from "./useThreadActivationController";

const THREAD_A = ThreadId.makeUnsafe("thread-a");
const THREAD_B = ThreadId.makeUnsafe("thread-b");
const PROJECT_ID = FolderId.makeUnsafe("project-1");

function makeControllerInput(
  overrides: Partial<ThreadActivationControllerInput> = {},
): ThreadActivationControllerInput & {
  navigate: ReturnType<typeof vi.fn>;
  clearSelection: ReturnType<typeof vi.fn>;
  openChatThreadPage: ReturnType<typeof vi.fn>;
  openTerminalThreadPage: ReturnType<typeof vi.fn>;
  prewarmThreadDetailForIntent: ReturnType<typeof vi.fn>;
  rememberLastThreadRouteNow: ReturnType<typeof vi.fn>;
  setOptimisticActiveThreadId: ReturnType<typeof vi.fn>;
  setSelectionAnchor: ReturnType<typeof vi.fn>;
} {
  return {
    clearSelection: vi.fn(),
    navigate: vi.fn(),
    openChatThreadPage: vi.fn(),
    openTerminalThreadPage: vi.fn(),
    prewarmThreadDetailForIntent: vi.fn(),
    rememberLastThreadRouteNow: vi.fn(),
    routeThreadId: THREAD_A,
    selectedThreadCount: 0,
    setOptimisticActiveThreadId: vi.fn(),
    setSelectionAnchor: vi.fn(),
    sidebarThreadSummaryById: {
      [THREAD_A]: { id: THREAD_A, folderId: PROJECT_ID },
      [THREAD_B]: { id: THREAD_B, folderId: PROJECT_ID },
    },
    terminalStateByThreadId: {},
    ...overrides,
  } as unknown as ThreadActivationControllerInput & {
    navigate: ReturnType<typeof vi.fn>;
    clearSelection: ReturnType<typeof vi.fn>;
    openChatThreadPage: ReturnType<typeof vi.fn>;
    openTerminalThreadPage: ReturnType<typeof vi.fn>;
    prewarmThreadDetailForIntent: ReturnType<typeof vi.fn>;
    rememberLastThreadRouteNow: ReturnType<typeof vi.fn>;
    setOptimisticActiveThreadId: ReturnType<typeof vi.fn>;
    setSelectionAnchor: ReturnType<typeof vi.fn>;
  };
}

describe("activateThreadFromSidebarIntent", () => {
  it("opens a thread and records the single-thread route", () => {
    const input = makeControllerInput({ selectedThreadCount: 1 });
    activateThreadFromSidebarIntent(input, THREAD_B);
    expect(input.prewarmThreadDetailForIntent).toHaveBeenCalledWith(THREAD_B);
    expect(input.clearSelection).toHaveBeenCalledOnce();
    expect(input.openChatThreadPage).toHaveBeenCalledWith(THREAD_B);
    expect(input.rememberLastThreadRouteNow).toHaveBeenCalledWith({ threadId: THREAD_B });
    expect(input.navigate).toHaveBeenCalledOnce();
  });

  it("ignores the active thread", () => {
    const input = makeControllerInput();
    activateThreadFromSidebarIntent(input, THREAD_A);
    expect(input.navigate).not.toHaveBeenCalled();
  });
});
