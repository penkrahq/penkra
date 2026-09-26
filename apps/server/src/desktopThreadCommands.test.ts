import { describe, expect, it, vi } from "vitest";
import type { DesktopThreadApiRequest, OrchestrationShellSnapshot } from "@penkra/contracts";

import { DesktopThreadCommands } from "./desktopThreadCommands";

const base = {
  id: "request",
  appId: "app",
  spaceId: "space",
  deckId: "deck",
  tabId: "tab",
  threadId: "thread",
};
const snapshot = {
  folders: [{ id: "folder", spaceId: "space" }],
  decks: [{ id: "deck", spaceId: "space", threadIds: ["thread", "target"] }],
  threads: ["thread", "target"].map((id, deckSortOrder) => ({
    id,
    deckId: "deck",
    deckSortOrder,
    folderId: "folder",
    title: id,
    archivedAt: null,
    workStatus: "idle",
    hasPendingUserInput: false,
    session: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
    modelSelection: { provider: "codex", model: "gpt-5" },
    runtimeMode: "full-access",
    workingDirectory: null,
  })),
} as unknown as OrchestrationShellSnapshot;

function harness() {
  const dispatch = vi.fn(async () => ({ sequence: 1 }));
  const dispatchTurn = vi.fn(async () => ({ sequence: 1 }));
  const bindingRevision = vi.fn(async () => 7);
  const stageAttachment = vi.fn(async () => ({
    type: "file" as const,
    id: "file",
    name: "note.txt",
    mimeType: "text/plain",
    sizeBytes: 4,
  }));
  let gate: Promise<void> | null = null;
  const commands = new DesktopThreadCommands({
    snapshot: async () => {
      if (gate) await gate;
      return snapshot;
    },
    readModel: async () =>
      snapshot as unknown as import("@penkra/contracts").OrchestrationReadModel,
    bindingRevision,
    dispatch,
    dispatchTurn,
    stageAttachment,
  });
  return {
    commands,
    dispatch,
    dispatchTurn,
    bindingRevision,
    stageAttachment,
    setGate: (value: Promise<void>) => {
      gate = value;
    },
  };
}

const cases: ReadonlyArray<{ method: DesktopThreadApiRequest["method"]; input?: unknown }> = [
  { method: "current.read" },
  { method: "list" },
  { method: "get", input: { threadId: "target" } },
  { method: "create", input: { title: "Child" } },
  { method: "add", input: { threadId: "target", position: { type: "end" } } },
  { method: "select", input: { threadId: "target" } },
  { method: "reorder", input: { threadId: "target", position: { type: "start" } } },
  { method: "leave", input: { threadId: "target" } },
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
      if (
        method === "create" ||
        method === "add" ||
        method === "reorder" ||
        method === "leave" ||
        method === "archive"
      )
        expect(h.dispatch).toHaveBeenCalledOnce();
      if (method === "send") expect(h.dispatchTurn).toHaveBeenCalledOnce();
      if (method === "compose") expect(value).toHaveProperty("composeId");
      if (method === "send") expect(h.bindingRevision).toHaveBeenCalledWith("target");
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
