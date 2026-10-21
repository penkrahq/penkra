import { describe, expect, it, vi } from "vitest";
import {
  FolderId,
  ThreadId,
  TurnId,
  SpaceId,
  type CleanCoreThreadSummary,
} from "@penkra/contracts";
import {
  buildInputNeededCopy,
  buildTaskCompletionCopy,
  createCompletedThreadTracker,
  createOpenQuestionTracker,
  focusAvailableNotificationThread,
} from "./taskCompletion.logic";
import type { Thread } from "../types";

function makeCanonicalThread(
  overrides: Partial<CleanCoreThreadSummary> = {},
): CleanCoreThreadSummary {
  return {
    id: ThreadId.makeUnsafe("thread-1"),
    spaceId: SpaceId.makeUnsafe("space-1"),
    folderId: FolderId.makeUnsafe("project-1"),
    title: "Polish notifications",
    provider: "codex",
    connectionId: null,
    model: "model",
    modelOptions: null,
    runtimeMode: "full-access",
    state: "idle",
    activeTurnId: null,
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
    createdAt: "2026-04-05T10:00:00.000Z",
    updatedAt: "2026-04-05T10:00:05.000Z",
    latestTurn: {
      turnId: TurnId.makeUnsafe("turn-1"),
      status: "done",
      startedAt: "2026-04-05T10:00:00.000Z",
      endedAt: "2026-04-05T10:00:05.000Z",
    },
    ...overrides,
  };
}
function buildCollectedTaskCompletionCopy(assistantText: string) {
  const candidate = createCompletedThreadTracker([]).consume(
    makeCanonicalThread({ lastMessagePreview: assistantText }),
    new Set(),
  );
  if (!candidate) throw new Error("Expected a canonical completion");
  return buildTaskCompletionCopy(candidate);
}

describe("notification thread activation", () => {
  it("checks the current shell when a toast or native notification is clicked", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    const navigate = vi.fn();
    const shell = { id: threadId, archivedAt: null } as Thread;
    const state = { threadShellById: { [threadId]: shell } };
    expect(focusAvailableNotificationThread({ threadId, state, navigate })).toBe(true);
    expect(navigate).toHaveBeenCalledExactlyOnceWith(threadId);

    navigate.mockClear();
    state.threadShellById[threadId] = { ...shell, archivedAt: "2026-09-26T00:00:00.000Z" };
    expect(focusAvailableNotificationThread({ threadId, state, navigate })).toBe(false);
    expect(
      focusAvailableNotificationThread({ threadId, state: { threadShellById: {} }, navigate }),
    ).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  });
});

describe("canonical completion tracking", () => {
  it("does not baseline a new completion when an already-loaded page is read again", () => {
    const row = makeCanonicalThread();
    const tracker = createCompletedThreadTracker([
      { ...row, latestTurn: { ...row.latestTurn!, status: "running", endedAt: null } },
    ]);
    tracker.observeBaseline([row]);
    expect(tracker.consume(row, new Set())).not.toBeNull();
  });
  it("notifies a hidden settled turn once across two immediate pushes", () => {
    const tracker = createCompletedThreadTracker([]);
    const row = makeCanonicalThread();
    expect(tracker.consume(row, new Set())).toMatchObject({
      threadId: row.id,
      completedAt: row.latestTurn!.endedAt,
    });
    expect(tracker.consume(row, new Set())).toBeNull();
    expect(
      tracker.consume(
        { ...row, latestTurn: { ...row.latestTurn!, turnId: TurnId.makeUnsafe("turn-2") } },
        new Set(),
      ),
    ).not.toBeNull();
  });
  it("takes existing settled turns as the baseline without catch-up notifications", () => {
    const row = makeCanonicalThread();
    expect(createCompletedThreadTracker([row]).consume(row, new Set())).toBeNull();
  });
  it("notifies a baseline running turn when it settles", () => {
    const row = makeCanonicalThread();
    const tracker = createCompletedThreadTracker([
      { ...row, latestTurn: { ...row.latestTurn!, status: "running", endedAt: null } },
    ]);
    expect(tracker.consume(row, new Set())).not.toBeNull();
  });
  it("consumes visible completions without later notifying them in the background", () => {
    const row = makeCanonicalThread();
    const tracker = createCompletedThreadTracker([]);
    expect(tracker.consume(row, new Set([row.id]))).toBeNull();
    expect(tracker.consume(row, new Set())).toBeNull();
  });
  it("uses the canonical turn record without session-status or prior-snapshot guesses", () => {
    const row = makeCanonicalThread({ state: "running" });
    const tracker = createCompletedThreadTracker([]);
    expect(
      tracker.consume(
        { ...row, latestTurn: { ...row.latestTurn!, status: "running", endedAt: null } },
        new Set(),
      ),
    ).toBeNull();
    expect(
      tracker.consume(
        { ...row, latestTurn: { ...row.latestTurn!, status: "interrupted" } },
        new Set(),
      ),
    ).not.toBeNull();
  });
});

describe("buildTaskCompletionCopy", () => {
  it("prefers assistant output when available", () => {
    expect(
      buildCollectedTaskCompletionCopy("Finished the task and everything looks good."),
    ).toEqual({
      title: "Polish notifications",
      body: "Finished the task and everything looks good.",
    });
  });

  it("keeps compact context while stripping assistant Markdown", () => {
    expect(
      buildCollectedTaskCompletionCopy(
        "Sì, esattamente così:\n- menu principale con `Model`, **Effort** e Speed\n- slider dentro [Advanced](https://example.com)",
      ),
    ).toEqual({
      title: "Polish notifications",
      body: "Sì, esattamente così: · menu principale con Model, Effort e Speed · slider dentro Advanced",
    });
  });

  it("preserves technical underscores and cleans an unclosed code fence", () => {
    expect(
      buildCollectedTaskCompletionCopy(
        "Updated `apps/web/src/foo_bar.ts`.\n```ts\nconst result_value = true;",
      ),
    ).toEqual({
      title: "Polish notifications",
      body: "Updated apps/web/src/foo_bar.ts. const result_value = true;",
    });
  });

  it("preserves useful content inside a closed code fence", () => {
    expect(buildCollectedTaskCompletionCopy('Result:\n```json\n{"status":"ok"}\n```')).toEqual({
      title: "Polish notifications",
      body: 'Result: {"status":"ok"}',
    });
  });

  it("does not reinterpret Markdown-shaped syntax inside fenced code", () => {
    expect(
      buildCollectedTaskCompletionCopy(
        "Result:\n```python\ndef __init__(self):\n  return x - y\n```",
      ),
    ).toEqual({
      title: "Polish notifications",
      body: "Result: def __init__(self): return x - y",
    });
  });

  it.each([
    ["four-backtick", "Result:\n````python\ndef __init__(self):\n  return x * y * z\n````"],
    ["tilde", "Result:\n~~~python\ndef __init__(self):\n  return x * y * z\n~~~"],
  ])("preserves Markdown-shaped syntax inside a %s fence", (_label, assistantText) => {
    expect(buildCollectedTaskCompletionCopy(assistantText)).toEqual({
      title: "Polish notifications",
      body: "Result: def __init__(self): return x * y * z",
    });
  });

  it("recognizes CRLF fenced blocks without swallowing following prose", () => {
    expect(
      buildCollectedTaskCompletionCopy(
        "Result:\r\n```ts\r\nconst foo__bar__ = true;\r\n```\r\n**Done**",
      ),
    ).toEqual({
      title: "Polish notifications",
      body: "Result: const foo__bar__ = true; Done",
    });
  });

  it("only normalizes list markers at the start of a line", () => {
    expect(buildCollectedTaskCompletionCopy("Computed 7 * 6 = 42; auth - tests pass.")).toEqual({
      title: "Polish notifications",
      body: "Computed 7 * 6 = 42; auth - tests pass.",
    });
  });

  it("preserves spaced multiplication operators", () => {
    expect(buildCollectedTaskCompletionCopy("Computed 2 * 3 * 4 = 24.")).toEqual({
      title: "Polish notifications",
      body: "Computed 2 * 3 * 4 = 24.",
    });
  });

  it("removes GFM task-list markers with their list prefix", () => {
    expect(buildCollectedTaskCompletionCopy("- [x] Tests passed\n- [ ] Release pending")).toEqual({
      title: "Polish notifications",
      body: "· Tests passed · Release pending",
    });
  });

  it("preserves numeric prefixes longer than Markdown ordered-list markers", () => {
    expect(buildCollectedTaskCompletionCopy("1234567890. tests passed")).toEqual({
      title: "Polish notifications",
      body: "1234567890. tests passed",
    });
  });

  it("consumes balanced parentheses in Markdown link destinations", () => {
    expect(
      buildCollectedTaskCompletionCopy("Read the [docs](https://example.com/a_(b)) for details."),
    ).toEqual({
      title: "Polish notifications",
      body: "Read the docs for details.",
    });
  });

  it.each([
    ["full", "Read [the guide][docs].\n[docs]: https://example.com", "Read the guide."],
    ["collapsed", "Read [the guide][].\n[the guide]: https://example.com", "Read the guide."],
    ["shortcut", "Read [docs].\n[docs]: https://example.com", "Read docs."],
  ])("strips %s reference links and their definitions", (_label, assistantText, expectedBody) => {
    expect(buildCollectedTaskCompletionCopy(assistantText)).toEqual({
      title: "Polish notifications",
      body: expectedBody,
    });
  });

  it("preserves bracketed status text that is not a valid reference definition", () => {
    expect(buildCollectedTaskCompletionCopy("[status]: all tests passed")).toEqual({
      title: "Polish notifications",
      body: "[status]: all tests passed",
    });
  });

  it("handles bracket-heavy generated output without recursive rescanning", () => {
    expect(buildCollectedTaskCompletionCopy("[".repeat(16_000))).toEqual({
      title: "Polish notifications",
      body: `${"[".repeat(119)}…`,
    });
  });

  it("keeps separate triple-backtick inline spans independent", () => {
    expect(buildCollectedTaskCompletionCopy("Use ```foo``` now.\nThen ```bar``` next.")).toEqual({
      title: "Polish notifications",
      body: "Use foo now. Then bar next.",
    });
  });

  it("preserves shorter backtick runs inside multi-backtick code spans", () => {
    expect(buildCollectedTaskCompletionCopy("Use ``foo ` bar`` now.")).toEqual({
      title: "Polish notifications",
      body: "Use foo ` bar now.",
    });
  });

  it("preserves Markdown-shaped syntax inside code spans that cross line breaks", () => {
    expect(buildCollectedTaskCompletionCopy("Use `foo\n__bar__` now.")).toEqual({
      title: "Polish notifications",
      body: "Use foo __bar__ now.",
    });
  });

  it("does not strip underscores from inline code identifiers", () => {
    expect(buildCollectedTaskCompletionCopy("Updated `__init__.py` and `foo__bar__`.")).toEqual({
      title: "Polish notifications",
      body: "Updated __init__.py and foo__bar__.",
    });
  });

  it("does not treat intraword double underscores as emphasis", () => {
    expect(buildCollectedTaskCompletionCopy("Updated foo__bar__ successfully.")).toEqual({
      title: "Polish notifications",
      body: "Updated foo__bar__ successfully.",
    });
  });

  it("does not treat double underscores beside Unicode identifier characters as emphasis", () => {
    expect(buildCollectedTaskCompletionCopy("Updated café__menu__ and 变量__名称__.")).toEqual({
      title: "Polish notifications",
      body: "Updated café__menu__ and 变量__名称__.",
    });
  });

  it("renders escaped Markdown punctuation literally", () => {
    expect(
      buildCollectedTaskCompletionCopy("Use \\*literal\\*, \\_name\\_, and \\[raw\\]."),
    ).toEqual({
      title: "Polish notifications",
      body: "Use *literal*, _name_, and [raw].",
    });
  });

  it.each([
    [
      "blockquote",
      "Result:\n> ```python\n> def __init__(self):\n>   return value\n> ```",
      "Result: def __init__(self): return value",
    ],
    [
      "list",
      "Result:\n- ```python\n  def __init__(self):\n  return value\n  ```",
      "Result: def __init__(self): return value",
    ],
    [
      "ordered list",
      "Result:\n10. ```python\n    def __init__(self):\n    return value\n    ```\n**Done**",
      "Result: def __init__(self): return value Done",
    ],
    [
      "ordered list with an over-indented fence-like code line",
      "Result:\n10. ```python\n    def __init__(self):\n        ```\n    return value\n    ```\n**Done**",
      "Result: def __init__(self): ``` return value Done",
    ],
  ])(
    "preserves Markdown-shaped syntax inside a fence nested in a %s",
    (_label, assistantText, expectedBody) => {
      expect(buildCollectedTaskCompletionCopy(assistantText)).toEqual({
        title: "Polish notifications",
        body: expectedBody,
      });
    },
  );

  it.each([
    ["blockquote", "Result:\n> ```\n> code\n\n**Done**"],
    ["list", "Result:\n- ```\n  code\n\n**Done**"],
  ])("stops an unclosed fence at its %s container boundary", (_label, assistantText) => {
    expect(buildCollectedTaskCompletionCopy(assistantText)).toEqual({
      title: "Polish notifications",
      body: "Result: code Done",
    });
  });
});

describe("canonical open-question tracking", () => {
  const question = {
    id: "question-1",
    summary: "Continue?",
    createdAt: "2020-01-01T00:00:00.000Z",
  };
  it("does not notify questions open at the first canonical read", () => {
    const row = makeCanonicalThread({ latestOpenQuestion: question });
    const tracker = createOpenQuestionTracker([row]);
    expect(tracker.consume(row, new Set())).toBeNull();
  });
  it("notifies a new question once across duplicate pushes without a clock", () => {
    const row = makeCanonicalThread({ latestOpenQuestion: question });
    const tracker = createOpenQuestionTracker([makeCanonicalThread()]);
    expect(tracker.consume(row, new Set())).toMatchObject({
      requestId: question.id,
      summary: question.summary,
    });
    expect(tracker.consume(row, new Set())).toBeNull();
  });
  it("consumes visible questions without notifying later", () => {
    const row = makeCanonicalThread({ latestOpenQuestion: question });
    const tracker = createOpenQuestionTracker([]);
    expect(tracker.consume(row, new Set([row.id]))).toBeNull();
    expect(tracker.consume(row, new Set())).toBeNull();
  });
  it("baselines a newly loaded page but not a new question on an already loaded page", () => {
    const row = makeCanonicalThread({ latestOpenQuestion: question });
    const tracker = createOpenQuestionTracker([]);
    tracker.observeBaseline([row]);
    expect(tracker.consume(row, new Set())).toBeNull();
    const next = { ...row, latestOpenQuestion: { ...question, id: "question-2" } };
    tracker.observeBaseline([next]);
    expect(tracker.consume(next, new Set())).toMatchObject({ requestId: "question-2" });
  });
});

describe("buildInputNeededCopy", () => {
  it("describes user-input requests succinctly", () => {
    expect(
      buildInputNeededCopy({
        kind: "user-input",
        threadId: ThreadId.makeUnsafe("thread-1"),
        folderId: FolderId.makeUnsafe("project-1"),
        title: "Polish notifications",
        createdAt: "2026-04-05T10:00:06.000Z",
        requestId: "user-input-request-1",
      }),
    ).toEqual({
      title: "Input needed",
      body: "Polish notifications: User input requested.",
    });
  });
});
