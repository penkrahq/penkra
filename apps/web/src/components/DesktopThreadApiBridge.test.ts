import {
  FolderId,
  SpaceId,
  ThreadId,
  TurnId,
  type CleanCoreThreadSummary,
} from "@penkra/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ rows: [] as CleanCoreThreadSummary[] }));
vi.mock("../store", () => ({
  useStore: { getState: () => ({ sidebarThreadSummaryById: {}, threadSessionById: {} }) },
}));
vi.mock("../threadListStore", () => ({
  getThreadList: () => fixture.rows,
  subscribeThreadList: vi.fn(),
}));
vi.mock("../composerDraftStore", () => ({
  useComposerDraftStore: { getState: () => ({ draftsByThreadId: {} }) },
}));
import { folderStates } from "./DesktopThreadApiBridge";
import { registerDesktopThreadLiveHandlers } from "../desktopThreadApiBroker";

const folderId = FolderId.make("folder");
function row(overrides: Partial<CleanCoreThreadSummary> = {}): CleanCoreThreadSummary {
  return {
    id: ThreadId.make("canonical-background"),
    spaceId: SpaceId.make("space"),
    folderId,
    title: "Existing background chat",
    provider: "claudeAgent",
    connectionId: null,
    model: "model",
    modelOptions: null,
    runtimeMode: "full-access",
    state: "running",
    activeTurnId: TurnId.make("canonical-turn"),
    latestTurn: null,
    lastError: null,
    queue: "[]",
    saved: "[]",
    createdBy: "user",
    createdByThreadId: null,
    sidebarSortOrder: null,
    lastActivityAt: null,
    lastMessagePreview: null,
    lastUserMessageAt: null,
    lastVisitedAt: null,
    openQuestionCount: 0,
    latestOpenQuestion: null,
    archivedAt: null,
    deletedAt: null,
    createdAt: "2026-10-25T15:00:00.000Z",
    updatedAt: "2026-10-25T15:01:00.000Z",
    ...overrides,
  };
}
beforeEach(() => {
  fixture.rows = [];
});
describe("folder App thread state", () => {
  it("preserves a mounted composer's immediate state including a deliberately cleared turn", () => {
    fixture.rows = [row({ openQuestionCount: 1 })];
    const unregister = registerDesktopThreadLiveHandlers("canonical-background", {
      read: () => ({
        threadId: "canonical-background",
        phase: "submitting",
        activeTurnId: null,
        queuedCount: 2,
        pendingUserInput: false,
        sendBusy: true,
      }),
      send: async () => true,
    });
    try {
      expect(folderStates(folderId)[0]).toMatchObject({
        phase: "submitting",
        activeTurnId: null,
        pendingQuestion: false,
        queued: { count: 2 },
      });
    } finally {
      unregister();
    }
  });
  it.each([
    { state: "running", openQuestionCount: 0, phase: "running" },
    { state: "running", openQuestionCount: 1, phase: "waiting" },
    { state: "error", openQuestionCount: 0, phase: "failed" },
    { state: "idle", openQuestionCount: 0, phase: "idle" },
  ])(
    "reads $phase from an existing canonical row without a mounted chat or projection",
    ({ state, openQuestionCount, phase }) => {
      fixture.rows = [
        row({
          state,
          openQuestionCount,
          activeTurnId: state === "running" ? TurnId.make("canonical-turn") : null,
          queue: '[{"id":"queued"}]',
        }),
      ];
      const result = folderStates(folderId);
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        threadId: "canonical-background",
        phase,
        pendingQuestion: openQuestionCount > 0,
        queued: { count: 1 },
      });
      expect(result[0]?.activeTurnId).toBe(state === "running" ? "canonical-turn" : null);
    },
  );
  it("omits archived, deleted, and other-folder rows without treating unloaded chats as deleted", () => {
    fixture.rows = [
      row(),
      row({ id: ThreadId.make("archived"), archivedAt: "2026-10-25T15:02:00.000Z" }),
      row({ id: ThreadId.make("deleted"), deletedAt: "2026-10-25T15:02:00.000Z" }),
      row({ id: ThreadId.make("elsewhere"), folderId: FolderId.make("other") }),
    ];
    expect(folderStates(folderId).map((entry) => entry.threadId)).toEqual(["canonical-background"]);
  });
});
