import { MessageId, TurnId, ThreadId, type CleanCoreThreadItem } from "@penkra/contracts";
import { describe, expect, it } from "vitest";
import {
  chunkWorkEntries,
  computeStableMessagesTimelineRows,
  deriveMessagesTimelineRows,
  normalizeCompactToolLabel,
  resolveAssistantMessageCopyState,
  resolveAssistantMessageDisplayText,
  type MessagesTimelineRow,
  type StableMessagesTimelineRowsState,
} from "./MessagesTimeline.logic";
import type { TimelineEntry, WorkLogEntry } from "../../session-logic";
import { threadItemsToTimelineEntries } from "./threadItemMappers";
import { turnSegmentKey } from "../../threadItemsStore";

describe("normalizeCompactToolLabel", () => {
  it("removes trailing completion wording from command labels", () => {
    expect(normalizeCompactToolLabel("Ran command complete")).toBe("Ran command");
  });

  it("removes trailing completion wording from other labels", () => {
    expect(normalizeCompactToolLabel("Read file completed")).toBe("Read file");
  });
});

describe("chunkWorkEntries", () => {
  const entry = (id: string, tone: WorkLogEntry["tone"] = "tool"): WorkLogEntry => ({
    id,
    createdAt: "2026-10-17T00:00:00.000Z",
    label: id,
    tone,
  });
  it("keeps a tool run's newest-step identity when older members are added", () => {
    expect(chunkWorkEntries([entry("b"), entry("c")])[0]).toMatchObject({
      kind: "tool-group",
      id: "c",
    });
    expect(chunkWorkEntries([entry("a"), entry("b"), entry("c")])[0]).toMatchObject({
      kind: "tool-group",
      id: "c",
    });
  });
  it("keeps narration and rich individual rows between tool runs", () => {
    const chunks = chunkWorkEntries([
      entry("a"),
      entry("b"),
      entry("narration", "thinking"),
      entry("c"),
      entry("d"),
      entry("error", "error"),
    ]);
    expect(chunks.map((chunk) => [chunk.kind, chunk.id])).toEqual([
      ["tool-group", "b"],
      ["item", "narration"],
      ["tool-group", "d"],
      ["item", "error"],
    ]);
  });
});

describe("computeStableMessagesTimelineRows", () => {
  type MessageTimelineRow = Extract<MessagesTimelineRow, { kind: "message" }>;
  type WorkTimelineRow = Extract<MessagesTimelineRow, { kind: "work" }>;

  const emptyStableRows = (): StableMessagesTimelineRowsState => ({
    byId: new Map(),
    result: [],
  });

  it("reuses stable work rows without rereading unchanged entry payloads", () => {
    let payloadReadCount = 0;
    const entry = {
      id: "activity-stable-payload",
      createdAt: "2026-05-09T10:00:00.000Z",
      label: "Ran command",
      tone: "tool" as const,
      get detail() {
        payloadReadCount += 1;
        return "large stable output";
      },
    } satisfies WorkLogEntry;
    const firstRow: WorkTimelineRow = {
      kind: "work",
      id: "work-group-stable-payload",
      createdAt: entry.createdAt,
      entry,
    };
    const first = computeStableMessagesTimelineRows([firstRow], emptyStableRows());
    const secondRow: WorkTimelineRow = { ...firstRow, entry };
    const second = computeStableMessagesTimelineRows([secondRow], first);

    expect(second).toBe(first);
    expect(payloadReadCount).toBe(0);
  });

  it("replaces work rows when later tool metadata adds visible details", () => {
    const firstRows: MessagesTimelineRow[] = [
      {
        kind: "work",
        id: "work-group-1",
        createdAt: "2026-05-09T10:00:00.000Z",
        entry: {
          id: "activity-read",
          createdAt: "2026-05-09T10:00:00.000Z",
          label: "Read",
          tone: "tool",
          itemType: "dynamic_tool_call",
          toolTitle: "Read",
        },
      },
    ];
    const first = computeStableMessagesTimelineRows(firstRows, emptyStableRows());

    const enrichedRows: MessagesTimelineRow[] = [
      {
        kind: "work",
        id: "work-group-1",
        createdAt: "2026-05-09T10:00:00.000Z",
        entry: {
          id: "activity-read",
          createdAt: "2026-05-09T10:00:00.000Z",
          label: "Read",
          tone: "tool",
          itemType: "dynamic_tool_call",
          toolTitle: "Read",
          detail: "apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts:12",
          changedFiles: ["apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts"],
        },
      },
    ];

    const second = computeStableMessagesTimelineRows(enrichedRows, first);

    expect(second).not.toBe(first);
    expect(second.result[0]).toBe(enrichedRows[0]);
  });

  it("replaces work rows when live activity settles without a final tool event", () => {
    const firstRow: WorkTimelineRow = {
      kind: "work",
      id: "work-group-live-activity",
      createdAt: "2026-05-09T10:00:00.000Z",
      entry: {
        id: "activity-command",
        createdAt: "2026-05-09T10:00:00.000Z",
        label: "Bash",
        tone: "tool",
        itemType: "command_execution",
        liveActivity: {
          state: "running_tool",
          label: "Bash",
          startedAt: "2026-05-09T10:00:00.000Z",
          lastActivityAt: "2026-05-09T10:00:01.000Z",
          detail: "Running",
          progress: 0.5,
          elapsedSeconds: 1,
        },
      },
    };
    const first = computeStableMessagesTimelineRows([firstRow], emptyStableRows());
    const settledRow: WorkTimelineRow = {
      ...firstRow,
      entry: {
        ...firstRow.entry,
        liveActivity: {
          state: "completed",
          label: "Bash completed",
          startedAt: "2026-05-09T10:00:00.000Z",
          lastActivityAt: "2026-05-09T10:00:05.000Z",
          detail: "Done",
          progress: 1,
          elapsedSeconds: 5,
        },
      },
    };

    const second = computeStableMessagesTimelineRows([settledRow], first);

    expect(second).not.toBe(first);
    expect(second.result[0]).toBe(settledRow);
  });

  it("replaces work rows when the activity kind changes", () => {
    const firstRow: WorkTimelineRow = {
      kind: "work",
      id: "work-group-user-input",
      createdAt: "2026-05-09T10:00:00.000Z",
      entry: {
        id: "activity-user-input",
        createdAt: "2026-05-09T10:00:00.000Z",
        label: "Needs input",
        tone: "info",
      },
    };
    const firstRows: MessagesTimelineRow[] = [firstRow];
    const first = computeStableMessagesTimelineRows(firstRows, emptyStableRows());

    const enrichedRows: MessagesTimelineRow[] = [
      {
        ...firstRow,
        entry: {
          ...firstRow.entry,
          activityKind: "user-input.requested",
        },
      },
    ];

    const second = computeStableMessagesTimelineRows(enrichedRows, first);

    expect(second).not.toBe(first);
    expect(second.result[0]).toBe(enrichedRows[0]);
  });
});

describe("resolveAssistantMessageCopyState", () => {
  it("shows copy only for non-empty settled assistant text", () => {
    expect(
      resolveAssistantMessageCopyState({
        text: "Hello",
        showCopyButton: true,
        streaming: false,
      }),
    ).toEqual({ text: "Hello", visible: true });
  });

  it("hides copy while the active assistant response is still streaming", () => {
    expect(
      resolveAssistantMessageCopyState({
        text: "Hello",
        showCopyButton: true,
        streaming: true,
      }),
    ).toEqual({ text: "Hello", visible: false });
  });

  it("hides copy for empty responses", () => {
    expect(
      resolveAssistantMessageCopyState({
        text: "   ",
        showCopyButton: true,
        streaming: false,
      }),
    ).toEqual({ text: null, visible: false });
  });
});

describe("resolveAssistantMessageDisplayText", () => {
  it("does not call an explicit image presentation an empty response", () => {
    expect(
      resolveAssistantMessageDisplayText({
        message: { text: "", streaming: false },
        hasVisibleMediaInTurn: true,
      }),
    ).toBeNull();
  });

  it("does not treat an unpresented generated artifact as a visible answer", () => {
    expect(
      resolveAssistantMessageDisplayText({
        message: { text: "", streaming: false },
      }),
    ).toBe("(empty response)");
  });

  it("keeps the placeholder when a settled turn produced no visible content", () => {
    expect(
      resolveAssistantMessageDisplayText({
        message: { text: "", streaming: false },
      }),
    ).toBe("(empty response)");
  });

  it("preserves real assistant text beside explicitly presented media", () => {
    expect(
      resolveAssistantMessageDisplayText({
        message: { text: "Here is your image.", streaming: false },
        hasVisibleMediaInTurn: true,
      }),
    ).toBe("Here is your image.");
  });
});

describe("server-defined transcript rows", () => {
  const item = (
    seq: number,
    kind: CleanCoreThreadItem["kind"],
    extra: Partial<CleanCoreThreadItem> = {},
  ): CleanCoreThreadItem => ({
    threadId: ThreadId.makeUnsafe("thread"),
    seq,
    sourceId: "item-" + seq,
    turnId: TurnId.makeUnsafe("t1"),
    kind,
    status: "done",
    text: "row " + seq,
    data: kind === "user" ? '{"origin":{"_tag":"user"},"attachments":[]}' : null,
    createdAt: "2026-10-17T00:00:00.000Z",
    updatedAt: "2026-10-17T00:05:00.000Z",
    ...extra,
  });
  const marker = item(2, "turn", {
    sourceId: "turn:t1",
    data: '{"startedAt":"2026-10-17T00:00:00.000Z","endedAt":"2026-10-17T00:05:00.000Z"}',
  });
  const final = item(7, "text");
  const history = [
    item(1, "user"),
    item(3, "tool"),
    item(4, "text"),
    item(5, "user"),
    item(6, "question", { status: "answered", text: "Which?", data: '{"answers":{"q":"Yes"}}' }),
    final,
  ];
  const base = {
    timelineEntries: threadItemsToTimelineEntries(history),
    isWorking: false,
    activeTurnStartedAt: null,
    turns: { t1: marker },
    finals: { t1: final },
    segments: {
      t1: [
        {
          fromSeq: 0,
          toSeq: null,
          hasSteps: true,
          startedAt: marker.createdAt,
          endedAt: marker.updatedAt,
        },
      ],
    },
  };
  it.each([false, true])(
    "keeps cut-off work at its turn and steer positions without a final answer (steer=%s)",
    (steered) => {
      const steer = item(5, "user", {
        data: '{"origin":{"_tag":"user"},"attachments":[],"steered":true}',
      });
      const segment = base.segments.t1[0]!;
      const rows = deriveMessagesTimelineRows({
        ...base,
        turns: { t1: { ...marker, status: "interrupted" } },
        finals: {},
        timelineEntries: threadItemsToTimelineEntries([
          history[0]!,
          history[1]!,
          ...(steered ? [steer, item(6, "tool")] : []),
        ]),
        segments: {
          t1: steered
            ? [
                { ...segment, toSeq: 5 },
                { ...segment, fromSeq: 5 },
              ]
            : [segment],
        },
      });
      expect(rows.map((row) => row.id)).toEqual(
        steered
          ? ["item-1", 'turn-header:["t1",0,5]', "item-5", 'turn-header:["t1",5,null]']
          : ["item-1", 'turn-header:["t1",0,null]'],
      );
    },
  );
  it("places independent settled folds on either side of a steer, with no fold for an empty segment", () => {
    const steer = item(5, "user", {
      data: JSON.stringify({
        origin: { _tag: "agent", senderThreadId: "sender" },
        attachments: [],
        steered: true,
      }),
    });
    const after = item(6, "tool");
    const input = {
      ...base,
      timelineEntries: threadItemsToTimelineEntries([
        history[0]!,
        history[1]!,
        history[2]!,
        steer,
        after,
        final,
      ]),
      segments: {
        t1: [
          {
            fromSeq: 0,
            toSeq: 5,
            hasSteps: true,
            startedAt: marker.createdAt,
            endedAt: marker.updatedAt,
          },
          {
            fromSeq: 5,
            toSeq: null,
            hasSteps: true,
            startedAt: marker.createdAt,
            endedAt: marker.updatedAt,
          },
        ],
      },
    };
    const rows = deriveMessagesTimelineRows(input);
    expect(rows.map((row) => row.id)).toEqual([
      "item-1",
      'turn-header:["t1",0,5]',
      "item-5",
      'turn-header:["t1",5,null]',
      "turn-divider:t1",
      "item-7",
    ]);
    const open = deriveMessagesTimelineRows({
      ...input,
      expandedTurns: { [turnSegmentKey("t1", 5)]: true },
    });
    expect(open.map((row) => row.id)).toEqual([
      "item-1",
      'turn-header:["t1",0,5]',
      "item-5",
      'turn-header:["t1",5,null]',
      "item-6",
      "turn-divider:t1",
      "item-7",
    ]);
    const empty = deriveMessagesTimelineRows({
      ...input,
      segments: {
        t1: input.segments.t1.map((segment, index) => ({ ...segment, hasSteps: index === 0 })),
      },
    });
    expect(empty.filter((row) => row.kind === "turn-header")).toHaveLength(1);
    const paged = deriveMessagesTimelineRows({
      ...input,
      outlineCursor: 5,
      timelineEntries: threadItemsToTimelineEntries([steer, after, final]),
    });
    expect(paged.map((row) => row.id)).toEqual([
      "outline-boundary:5",
      "item-5",
      'turn-header:["t1",5,null]',
      "turn-divider:t1",
      "item-7",
    ]);
  });
  it("anchors a Claude steer after the previous final and before the consuming turn, preserving stored sequence", () => {
    const consuming = item(9, "turn", { sourceId: "turn:t2", turnId: TurnId.makeUnsafe("t2") });
    const answer = item(10, "text", { turnId: TurnId.makeUnsafe("t2") });
    const steer = item(5, "user", {
      turnId: TurnId.makeUnsafe("t2"),
      data: JSON.stringify({
        origin: { _tag: "user" },
        attachments: [],
        steered: true,
        anchor: { turnRowSourceId: "turn:t2" },
      }),
    });
    const rows = deriveMessagesTimelineRows({
      ...base,
      timelineEntries: threadItemsToTimelineEntries([history[0]!, steer, final, consuming, answer]),
      turns: { t1: marker, t2: consuming },
      finals: { t1: final, t2: answer },
      segments: { t1: [], t2: [] },
    });
    expect(rows.map((row) => row.id)).toEqual(["item-1", "item-7", "item-5", "item-10"]);
    expect(steer.seq).toBe(5);
  });
  it.each([false, true])(
    "anchors changes above visible or hidden inputs (hidden=%s), without moving stored order",
    (hidden) => {
      const message = item(1, "user", {
        sourceId: "input",
        data: JSON.stringify({ origin: { _tag: hidden ? "recovery" : "user" }, attachments: [] }),
      });
      const notice = item(3, "notice", {
        turnId: null,
        data: JSON.stringify({
          tone: "info",
          kind: "model-changed",
          summary: "Model changed to Opus",
          payload: {},
          anchor: { messageId: "input" },
        }),
      });
      const timelineEntries = threadItemsToTimelineEntries([message, notice]);
      const rows = deriveMessagesTimelineRows({
        ...base,
        timelineEntries,
        finals: {},
        turns: { t1: { ...marker, status: "running" } },
        isWorking: true,
        activeTurnId: TurnId.makeUnsafe("t1"),
        activeTurnStartedAt: marker.createdAt,
      });
      expect(rows.map((row) => row.id)).toEqual(
        hidden
          ? ["item-3", "working-header-row", "working-indicator-row"]
          : ["item-3", "input", "working-header-row", "working-indicator-row"],
      );
      expect(notice.seq).toBe(3);
      expect(timelineEntries.find((entry) => entry.id === "item-3")).toMatchObject({
        entry: { sequence: 3 },
      });
      const unloaded = deriveMessagesTimelineRows({
        ...base,
        timelineEntries: threadItemsToTimelineEntries([notice]),
        finals: {},
        turns: { t1: { ...marker, status: "running" } },
        isWorking: true,
        activeTurnId: TurnId.makeUnsafe("t1"),
        activeTurnStartedAt: marker.createdAt,
      });
      expect(unloaded.map((row) => row.id)).toEqual([
        "working-header-row",
        "item-3",
        "working-indicator-row",
      ]);
    },
  );
  it("keeps a summary keyed by its newest step and each opened member as a separate row", () => {
    const steps = (first: number): TimelineEntry[] =>
      Array.from({ length: 202 - first }, (_, index) => {
        const seq = first + index;
        return {
          kind: "work",
          id: "step-" + seq,
          createdAt: marker.createdAt,
          entry: {
            id: "step-" + seq,
            sequence: seq,
            turnId: TurnId.makeUnsafe("t1"),
            createdAt: marker.createdAt,
            label: "Ran command",
            tone: "tool",
            itemType: "command_execution",
            toolStatus: "completed",
          },
        };
      });
    const derive = (first: number, expanded: boolean) =>
      deriveMessagesTimelineRows({
        ...base,
        finals: {},
        timelineEntries: steps(first),
        expandedTurns: { [turnSegmentKey("t1", 0)]: true },
        expandedSummaries: { "summary:step-201": expanded },
        details: { [turnSegmentKey("t1", 0)]: { items: [item(first, "tool")], nextCursor: first } },
      });
    const closed = derive(152, false);
    expect(closed.map((row) => row.kind)).toEqual(["turn-header", "summary"]);
    expect(closed[1]).toMatchObject({ id: "summary:step-201", summary: { entryCount: 50 } });
    const before = derive(152, true);
    const after = derive(102, true);
    expect(after.find((row) => row.id === "summary:step-201")).toMatchObject({
      expanded: true,
      summary: { entryCount: 100 },
    });
    expect(before.find((row) => row.id === "step-152")).toEqual(
      after.find((row) => row.id === "step-152"),
    );
    expect(after.filter((row) => row.kind === "work")).toHaveLength(100);
    expect(after.findIndex((row) => row.kind === "boundary")).toBe(2);
  });
  it("keeps ordinary inputs and questions in sequence before the settled block, with exact timing", () => {
    const rows = deriveMessagesTimelineRows(base);
    expect(rows.map((row) => row.kind)).toEqual([
      "message",
      "message",
      "work",
      "turn-header",
      "turn-divider",
      "message",
    ]);
    expect(rows.map((row) => row.id)).toEqual([
      "item-1",
      "item-5",
      "item-6",
      'turn-header:["t1",0,null]',
      "turn-divider:t1",
      "item-7",
    ]);
    expect(rows[3]).toMatchObject({ elapsed: "5m", expanded: false });
    const open = deriveMessagesTimelineRows({
      ...base,
      expandedTurns: { [turnSegmentKey("t1", 0)]: true },
    });
    expect(open.map((row) => row.id)).toEqual([
      "item-1",
      "item-5",
      "item-6",
      'turn-header:["t1",0,null]',
      "item-3",
      "item-4",
      "turn-divider:t1",
      "item-7",
    ]);
  });
  it("keeps a running turn inline and interleaved with steers", () => {
    const rows = deriveMessagesTimelineRows({
      ...base,
      turns: { t1: { ...marker, status: "running" } },
      isWorking: true,
      activeTurnInProgress: true,
      activeTurnId: TurnId.makeUnsafe("t1"),
      activeTurnStartedAt: marker.createdAt,
    });
    expect(rows.map((row) => row.id)).toEqual([
      "item-1",
      "working-header-row",
      "item-3",
      "item-4",
      "item-5",
      "item-6",
      "item-7",
      "working-indicator-row",
    ]);
  });
  it("has no disclosure for an answer-only turn and no boundary when exhausted", () => {
    const rows = deriveMessagesTimelineRows({
      ...base,
      timelineEntries: threadItemsToTimelineEntries([history[0]!, final]),
      segments: { t1: [] },
    });
    expect(rows.map((row) => row.kind)).toEqual(["message", "message"]);
    expect(rows.at(-1)).toMatchObject({ showAssistantCopyButton: true });
  });
  it("places a boundary above every expanded sequence that has older items", () => {
    const rows = deriveMessagesTimelineRows({
      ...base,
      outlineCursor: 1,
      expandedTurns: { [turnSegmentKey("t1", 0)]: true },
      details: { [turnSegmentKey("t1", 0)]: { items: [item(3, "tool")], nextCursor: 3 } },
    });
    expect(rows.filter((row) => row.kind === "boundary").map((row) => row.id)).toEqual([
      "outline-boundary:1",
      'turn-boundary:["t1",0,null]:3',
    ]);
    const closed = deriveMessagesTimelineRows({
      ...base,
      details: { [turnSegmentKey("t1", 0)]: { items: [], nextCursor: 3 } },
    });
    expect(closed.some((row) => row.kind === "boundary")).toBe(false);
  });
  it("retains the previously oldest displayed step when an older details page is inserted", () => {
    const derivePage = (firstSeq: number) => {
      const steps = Array.from({ length: 202 - firstSeq }, (_, index) =>
        item(firstSeq + index, "tool"),
      );
      return deriveMessagesTimelineRows({
        ...base,
        finals: {},
        timelineEntries: threadItemsToTimelineEntries(steps),
        expandedTurns: { [turnSegmentKey("t1", 0)]: true },
        details: { [turnSegmentKey("t1", 0)]: { items: steps, nextCursor: firstSeq } },
      });
    };
    const before = derivePage(152);
    const boundary = before.findIndex((row) => row.kind === "boundary");
    const oldestDisplayedKey = before[boundary + 1]!.id;
    expect(derivePage(102).some((row) => row.id === oldestDisplayedKey)).toBe(true);
  });
  it("renders a no-answer turn's steps without manufacturing an empty assistant response", () => {
    const rows = deriveMessagesTimelineRows({
      ...base,
      finals: {},
      timelineEntries: threadItemsToTimelineEntries([item(3, "tool")]),
      expandedTurns: { [turnSegmentKey("t1", 0)]: true },
    });
    expect(rows.map((row) => row.kind)).toEqual(["turn-header", "work"]);
  });
  it("does not merge adjacent provider turns into one user response", () => {
    const other = item(10, "turn", { sourceId: "turn:t2", turnId: TurnId.makeUnsafe("t2") });
    const answer = item(11, "text", { turnId: TurnId.makeUnsafe("t2") });
    const rows = deriveMessagesTimelineRows({
      ...base,
      turns: { t1: marker, t2: other },
      finals: { t1: final, t2: answer },
      segments: { ...base.segments, t2: [] },
    });
    expect(rows.filter((row) => row.kind === "message").map((row) => row.id)).toEqual([
      "item-1",
      "item-5",
      "item-7",
      "item-11",
    ]);
  });
  it("retains an ordered explicit image gallery when its turn is expanded", () => {
    const media = (id: string, index: number): TimelineEntry => ({
      id,
      kind: "work",
      createdAt: marker.createdAt,
      entry: {
        id,
        createdAt: marker.createdAt,
        tone: "tool",
        label: "Image",
        turnId: TurnId.makeUnsafe("t1"),
        sequence: 3 + index,
        presentedMedia: {
          attachmentId: id,
          name: id,
          mimeType: "image/png",
          sizeBytes: 100,
          type: "image",
          presentationId: "gallery",
          presentationIndex: index,
        },
      },
    });
    const rows = deriveMessagesTimelineRows({
      ...base,
      timelineEntries: [media("second", 1), media("first", 0)],
      expandedTurns: { [turnSegmentKey("t1", 0)]: true },
    });
    const gallery = rows.find((row) => row.kind === "media");
    expect(gallery?.kind === "media" && gallery.entries.map((entry) => entry.id)).toEqual([
      "first",
      "second",
    ]);
    const live = deriveMessagesTimelineRows({
      ...base,
      timelineEntries: [media("second", 1), media("first", 0)],
      turns: { t1: { ...marker, status: "running" } },
      isWorking: true,
      activeTurnId: TurnId.makeUnsafe("t1"),
      activeTurnInProgress: true,
      activeTurnStartedAt: marker.createdAt,
    });
    expect(live.map((row) => row.kind)).toEqual(["working-header", "media", "working"]);
  });
});
