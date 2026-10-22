import { describe, expect, it, vi } from "vitest";
import {
  CleanCoreThreadSummary,
  type CleanCoreThreadListCursor,
  type DesktopThreadApiRequest,
  type OrchestrationFolderShell,
} from "@penkra/contracts";

import { Schema } from "effect";
import { DesktopThreadCommands } from "./desktopThreadCommands";

const base = {
  id: "request",
  appId: "app",
  spaceId: "space",
  folderId: "folder",
  tabId: "tab",
  threadId: "thread",
};
const rows = ["thread", "target"].map((id, sidebarSortOrder) =>
  Schema.decodeUnknownSync(CleanCoreThreadSummary)({
    id,
    spaceId: "space",
    folderId: "folder",
    title: id,
    provider: "codex",
    connectionId: null,
    model: "gpt-5",
    modelOptions: null,
    runtimeMode: "full-access",
    state: "idle",
    activeTurnId: null,
    latestTurn: null,
    lastError: null,
    queue: "[]",
    saved: "[]",
    createdBy: "user",
    createdByThreadId: null,
    sidebarSortOrder,
    lastActivityAt: null,
    lastMessagePreview: null,
    lastUserMessageAt: null,
    lastVisitedAt: null,
    openQuestionCount: 0,
    latestOpenQuestion: null,
    archivedAt: null,
    deletedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  }),
);

function harness() {
  const createThread = vi.fn(async () => ({
    thread: {} as import("@penkra/contracts").CleanCoreThreadSummary,
    created: true,
  }));
  const updateThread = vi.fn(async () => undefined);
  const send = vi.fn(async (input: import("@penkra/contracts").CleanCoreSendMessageInput) => ({
    threadId: input.threadId,
    messageId: input.message.messageId,
    plan: "deliver" as const,
    seq: 1,
  }));
  const stageAttachment = vi.fn(async () => ({
    type: "file" as const,
    id: "file",
    name: "note.txt",
    mimeType: "text/plain",
    sizeBytes: 4,
  }));
  const listThreads = vi.fn(async () => ({
    threads: rows,
    nextCursor: null as CleanCoreThreadListCursor | null,
  }));
  let gate: Promise<void> | null = null;
  const commands = new DesktopThreadCommands({
    getFolder: async () => {
      if (gate) await gate;
      return { id: "folder", spaceId: "space" } as OrchestrationFolderShell;
    },
    getThread: async (id) => rows.find((row) => row.id === id) ?? null,
    listThreads,
    createThread,
    send,
    updateThread,
    stageAttachment,
  });
  return {
    commands,
    listThreads,
    createThread,
    send,
    updateThread,
    stageAttachment,
    setGate: (value: Promise<void>) => {
      gate = value;
    },
  };
}

const cases: ReadonlyArray<{ method: DesktopThreadApiRequest["method"]; input?: unknown }> = [
  { method: "current.read" },
  { method: "list", input: {} },
  { method: "get", input: { threadId: "target" } },
  { method: "create", input: { title: "Child" } },
  { method: "select", input: { threadId: "target" } },
  { method: "reorder", input: { threadId: "target", position: { type: "start" } } },
  { method: "archive", input: { threadId: "target" } },
  { method: "compose", input: { threadId: "target", text: "Hello" } },
  { method: "send", input: { composeId: "set-up-below" } },
];

for (const windows of ["zero windows", "one window", "window closes mid-operation"] as const) {
  describe(windows, () => {
    it.each(cases)("executes $method through the backend", async ({ method, input }) => {
      const h = harness();
      let command = {
        ...base,
        method,
        ...(input === undefined ? {} : { input }),
      } as DesktopThreadApiRequest;
      if (method === "send") {
        const composition = (await h.commands.execute({
          ...base,
          method: "compose",
          input: { threadId: "target", text: "Hello" },
        })) as { composeId: string };
        command = { ...base, method: "send", input: { composeId: composition.composeId } };
      }
      let release: (() => void) | undefined;
      if (windows === "window closes mid-operation") {
        h.setGate(
          new Promise<void>((resolve) => {
            release = resolve;
          }),
        );
      }
      const result = h.commands.execute(command);
      if (windows === "window closes mid-operation") {
        release!();
      }
      const value = await result;
      if (method === "create") {
        expect(h.createThread).toHaveBeenCalledOnce();
      }
      if (method === "archive") {
        expect(h.updateThread).toHaveBeenCalledOnce();
      }
      if (method === "reorder") {
        expect(h.updateThread).toHaveBeenCalledOnce();
      }
      if (method === "send") expect(h.send).toHaveBeenCalledOnce();
      if (method === "compose") expect(value).toHaveProperty("composeId");
    });
  });
}

it("binds a composition receipt to the App tab that created it", async () => {
  const h = harness();
  const result = (await h.commands.execute({
    ...base,
    method: "compose",
    input: { threadId: "target", text: "Hello" },
  })) as { composeId: string };
  await expect(
    h.commands.execute({
      ...base,
      tabId: "other",
      method: "send",
      input: { composeId: result.composeId },
    }),
  ).rejects.toMatchObject({ code: "COMPOSITION_RECEIPT_INVALID" });
});

it("round-trips the opaque folder cursor and returns pageInfo on the last page", async () => {
  const { commands, listThreads } = harness();
  const cursor = { sidebarSortOrder: 1, createdAt: rows[1]!.createdAt, id: rows[1]!.id };
  listThreads.mockResolvedValueOnce({ threads: rows, nextCursor: cursor });
  const first = (await commands.execute({ ...base, method: "list", input: {} })) as {
    threads: unknown[];
    pageInfo: { nextCursor: string };
  };
  expect(first.threads).toHaveLength(2);
  expect(first.pageInfo.nextCursor).toEqual(expect.any(String));
  const second = await commands.execute({
    ...base,
    method: "list",
    input: { cursor: first.pageInfo.nextCursor },
  });
  expect(listThreads).toHaveBeenLastCalledWith({
    spaceId: "space",
    folderId: "folder",
    after: cursor,
  });
  expect(second).toMatchObject({ pageInfo: { nextCursor: null } });
});
it("rejects an invalid folder cursor before reading a page", async () => {
  const { commands, listThreads } = harness();
  await expect(
    commands.execute({ ...base, method: "list", input: { cursor: "invalid" } }),
  ).rejects.toMatchObject({
    code: "BAD_CURSOR",
    message: 'Argument "cursor" is not a valid folder-list cursor.',
  });
  expect(listThreads).not.toHaveBeenCalled();
});
it("creates only in the invoking folder", async () => {
  const { commands, createThread } = harness();
  await expect(
    commands.execute({ ...base, method: "create", input: { folderId: "elsewhere" } }),
  ).rejects.toMatchObject({ code: "THREAD_ACCESS_DENIED" });
  expect(createThread).not.toHaveBeenCalled();
});
