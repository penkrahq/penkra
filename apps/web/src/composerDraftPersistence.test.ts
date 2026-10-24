import { ProviderConnectionId, ThreadId } from "@penkra/contracts";
import { describe, expect, it } from "vitest";

import { createEmptyThreadDraft } from "./composerDraftDomain";
import {
  hydrateComposerThreadDraftFromServer,
  serializeComposerThreadDraft,
} from "./composerDraftPersistence";

const THREAD_ID = "thread-1" as ThreadId;

describe("composer draft server payload", () => {
  it("carries the whole draft and hydrates every composed field", async () => {
    const draft = {
      ...createEmptyThreadDraft(),
      prompt: "please build the thing",
      pastedTexts: [
        {
          id: "p1",
          createdAt: "2026-10-09T00:00:00.000Z",
          text: "pasted body",
          lineCount: 1,
          charCount: 11,
        },
      ],
      fileComments: [
        { id: "c1", path: "src/app.ts", startLine: 3, endLine: 5, text: "check this" },
      ],
      skills: [{ name: "skill-a", path: "skills/a" }],
      mentions: [{ name: "app.ts", path: "src/app.ts" }],
      assistantSelections: [
        {
          type: "assistant-selection" as const,
          id: "s1",
          assistantMessageId: "m1",
          text: "picked",
        },
      ],
      terminalContexts: [
        {
          id: "t1",
          threadId: THREAD_ID,
          createdAt: "2026-10-09T00:00:00.000Z",
          terminalId: "term-1",
          terminalLabel: "Terminal",
          lineStart: 1,
          lineEnd: 2,
          text: "",
        },
      ],
    };

    const payload = serializeComposerThreadDraft(draft);
    expect(payload).not.toBeNull();
    const hydrated = await hydrateComposerThreadDraftFromServer(THREAD_ID, payload!, async () => 0);

    expect(hydrated.prompt).toBe("please build the thing");
    expect(hydrated.pastedTexts.map((entry) => entry.id)).toEqual(["p1"]);
    expect(hydrated.fileComments.map((entry) => entry.id)).toEqual(["c1"]);
    expect(hydrated.skills).toEqual([{ name: "skill-a", path: "skills/a" }]);
    expect(hydrated.mentions).toEqual([{ name: "app.ts", path: "src/app.ts" }]);
    expect(hydrated.assistantSelections.map((entry) => entry.id)).toEqual(["s1"]);
    expect(hydrated.terminalContexts.map((entry) => entry.id)).toEqual(["t1"]);
  });

  it("returns null for an empty draft and does not carry voice or prompt-history", () => {
    expect(serializeComposerThreadDraft(createEmptyThreadDraft())).toBeNull();
    const payload = serializeComposerThreadDraft({
      ...createEmptyThreadDraft(),
      prompt: "x",
      appliedVoiceJobIds: ["voice-1"],
    });
    expect(payload).not.toBeNull();
    expect(payload).not.toHaveProperty("appliedVoiceJobIds");
    expect(payload).not.toHaveProperty("promptHistorySavedDraft");
  });
});

it.each(["codex", "claudeAgent", "opencode"] as const)(
  "round-trips %s account and model picks with no composed content",
  async (provider) => {
    const draft = createEmptyThreadDraft();
    draft.modelSelectionByProvider[provider] = { provider, model: "model-B" };
    draft.connectionSelectionByProvider[provider] = ProviderConnectionId.make("account-B");
    draft.activeProvider = provider;
    const payload = serializeComposerThreadDraft(draft)!;
    expect(payload.prompt).toBe("");
    const reloaded = await hydrateComposerThreadDraftFromServer(THREAD_ID, payload, async () => 0);
    expect(reloaded.modelSelectionByProvider).toEqual(draft.modelSelectionByProvider);
    expect(reloaded.connectionSelectionByProvider).toEqual(draft.connectionSelectionByProvider);
  },
);

it("keeps an explicit anonymous account selection through a draft reload", async () => {
  const draft = createEmptyThreadDraft();
  draft.connectionSelectionByProvider.opencode = null;
  const payload = serializeComposerThreadDraft(draft)!;
  expect(payload).not.toBeNull();
  expect(
    (await hydrateComposerThreadDraftFromServer(THREAD_ID, payload, async () => 0))
      .connectionSelectionByProvider,
  ).toEqual({ opencode: null });
});
