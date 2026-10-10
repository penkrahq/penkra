import { EventId, MessageId, ThreadId, TurnId } from "@penkra/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AppState } from "../store";
import type { ChatMessage, Thread, ThreadShell } from "../types";
import { createThreadLineageSelector } from "./ChatView.selectors";

const rootThreadId = ThreadId.makeUnsafe("thread-root");
const childThreadId = ThreadId.makeUnsafe("thread-child");
const unrelatedThreadId = ThreadId.makeUnsafe("thread-unrelated");
const messageId = MessageId.makeUnsafe("message-1");

const rootShell = {
  id: rootThreadId,
  title: "Root thread",
} as ThreadShell;

const childShell = {
  id: childThreadId,
  title: "Child thread",
  parentThreadId: rootThreadId,
} as ThreadShell;

const unrelatedShell = {
  id: unrelatedThreadId,
  title: "Unrelated thread",
} as ThreadShell;

const threadIds = [rootThreadId, childThreadId];
const threadShellById = {
  [rootThreadId]: rootShell,
  [childThreadId]: childShell,
};

const rootActivity = {
  id: EventId.makeUnsafe("activity-root"),
  kind: "tool.completed",
  tone: "tool",
  summary: "Delegated work",
  payload: {},
  turnId: TurnId.makeUnsafe("turn-1"),
  createdAt: "2026-06-01T00:00:00.000Z",
} satisfies Thread["activities"][number];

const activityIdsByThreadId = {
  [rootThreadId]: [rootActivity.id],
};

const activityByThreadId = {
  [rootThreadId]: {
    [rootActivity.id]: rootActivity,
  },
};

const message = {
  id: messageId,
  role: "assistant",
  text: "Streaming detail changed",
  createdAt: "2026-06-01T00:00:01.000Z",
  streaming: true,
} satisfies ChatMessage;

function makeState(overrides: Partial<AppState> = {}): AppState {
  return {
    threadIds,
    threadShellById,
    activityIdsByThreadId,
    activityByThreadId,
    messageIdsByThreadId: {},
    messageByThreadId: {},
    ...overrides,
  } as AppState;
}

describe("createThreadLineageSelector", () => {
  it("reads parent membership from canonical rows instead of stale shell fields", () => {
    const selectLineage = createThreadLineageSelector(childThreadId, [
      { id: rootThreadId, parentThreadId: null },
      { id: childThreadId, parentThreadId: null },
    ]);
    expect(selectLineage(makeState()).map((row) => row.id)).toEqual([childThreadId]);
    expect(selectLineage(makeState())[0]?.parentThreadId).toBeNull();
  });

  it("stays stable when only message detail slices change", () => {
    const selectLineage = createThreadLineageSelector(childThreadId, [
      { id: rootThreadId, parentThreadId: null },
      { id: childThreadId, parentThreadId: rootThreadId },
    ]);
    const before = selectLineage(makeState());
    const after = selectLineage(
      makeState({
        messageIdsByThreadId: {
          [childThreadId]: [messageId],
        },
        messageByThreadId: {
          [childThreadId]: {
            [messageId]: message,
          },
        },
      }),
    );

    expect(after).toBe(before);
    expect(after.map((thread) => thread.id)).toEqual([rootThreadId, childThreadId]);
  });

  it("updates when parent activity identity hints change", () => {
    const selectLineage = createThreadLineageSelector(childThreadId, [
      { id: rootThreadId, parentThreadId: null },
      { id: childThreadId, parentThreadId: rootThreadId },
    ]);
    const before = selectLineage(makeState());
    const nextActivity = {
      ...rootActivity,
      payload: { data: { item: { agents: [{ id: "agent-1", nickname: "Planner" }] } } },
    };
    const after = selectLineage(
      makeState({
        activityByThreadId: {
          [rootThreadId]: {
            [rootActivity.id]: nextActivity,
          },
        },
      }),
    );

    expect(after).not.toBe(before);
    expect(after[0]?.activities[0]).toBe(nextActivity);
  });

  it("stays stable when unrelated thread shells change", () => {
    const selectLineage = createThreadLineageSelector(childThreadId, [
      { id: rootThreadId, parentThreadId: null },
      { id: childThreadId, parentThreadId: rootThreadId },
    ]);
    const before = selectLineage(makeState());
    const after = selectLineage(
      makeState({
        threadIds: [...threadIds, unrelatedThreadId],
        threadShellById: {
          ...threadShellById,
          [unrelatedThreadId]: unrelatedShell,
        },
      }),
    );

    expect(after).toBe(before);
  });
});

const ancestorHarness = vi.hoisted(() => {
  let key: string | undefined;
  return {
    loadThread: vi.fn(),
    toast: vi.fn(),
    reset() {
      key = undefined;
    },
    useEffect(effect: () => void, dependencies: string[]) {
      if (key !== dependencies[0]) {
        key = dependencies[0];
        effect();
      }
    },
  };
});
vi.mock("react", () => ({
  useMemo: (compute: () => unknown) => compute(),
  useEffect: ancestorHarness.useEffect,
}));
vi.mock("../threadListStore", () => ({ loadThread: ancestorHarness.loadThread }));
vi.mock("./ui/toast", () => ({ toastManager: { add: ancestorHarness.toast } }));
import { useLoadThreadAncestors } from "../hooks/useLoadThreadAncestors";

beforeEach(() => {
  vi.clearAllMocks();
  ancestorHarness.reset();
});
it("loads a missing grandparent by ID and continues the lineage when it arrives", async () => {
  const grandparentId = ThreadId.makeUnsafe("grandparent");
  const rows: { id: ThreadId; parentThreadId: ThreadId | null }[] = [
    { id: childThreadId, parentThreadId: rootThreadId },
    { id: rootThreadId, parentThreadId: grandparentId },
  ];
  const state = makeState({
    threadShellById: {
      ...threadShellById,
      [grandparentId]: { ...rootShell, id: grandparentId, title: "Grandparent" },
    },
  });
  expect(createThreadLineageSelector(childThreadId, rows)(state).map((row) => row.id)).toEqual([
    rootThreadId,
    childThreadId,
  ]);
  let finish!: () => void;
  const reply = new Promise<void>((resolve) => {
    finish = resolve;
  });
  ancestorHarness.loadThread.mockImplementation(async () => {
    await reply;
    rows.push({ id: grandparentId, parentThreadId: null });
  });
  useLoadThreadAncestors(childThreadId, rows);
  expect(ancestorHarness.loadThread).toHaveBeenCalledExactlyOnceWith(grandparentId);
  useLoadThreadAncestors(childThreadId, [...rows]);
  expect(ancestorHarness.loadThread).toHaveBeenCalledTimes(1);
  finish();
  await ancestorHarness.loadThread.mock.results[0]!.value;
  useLoadThreadAncestors(childThreadId, [...rows]);
  expect(createThreadLineageSelector(childThreadId, rows)(state).map((row) => row.title)).toEqual([
    "Grandparent",
    "Root thread",
    "Child thread",
  ]);
  expect(ancestorHarness.loadThread).toHaveBeenCalledTimes(1);
});
it("shows a failed ancestor read without retrying the same missing IDs", async () => {
  const rows = [{ id: childThreadId, parentThreadId: rootThreadId }];
  ancestorHarness.loadThread.mockRejectedValue(new Error("read failed"));
  useLoadThreadAncestors(childThreadId, rows);
  await Promise.resolve();
  expect(ancestorHarness.toast).toHaveBeenCalledWith({
    type: "error",
    title: "Could not load thread",
    description: "read failed",
  });
  useLoadThreadAncestors(childThreadId, [...rows]);
  expect(ancestorHarness.loadThread).toHaveBeenCalledTimes(1);
});
