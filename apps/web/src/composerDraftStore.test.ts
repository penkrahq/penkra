import { FolderId, ThreadId } from "@penkra/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { selectComposerThreadDraft } from "./composerDraftDomain";
import {
  finalizePromotedDraftThreads,
  markPromotedDraftThreads,
  useComposerDraftStore,
} from "./composerDraftStore";
import {
  makeImage,
  makeQueuedChatTurn,
  resetComposerDraftStore,
} from "./composerDraftStoreTestFixtures";

describe("composerDraftStore stable empty draft identity", () => {
  it("reuses the empty draft sentinel across unrelated store updates", () => {
    resetComposerDraftStore();
    const missingThreadId = ThreadId.makeUnsafe("thread-missing");
    const otherThreadId = ThreadId.makeUnsafe("thread-other");
    const before = selectComposerThreadDraft(useComposerDraftStore.getState(), missingThreadId);

    useComposerDraftStore.getState().setPrompt(otherThreadId, "unrelated");

    const after = selectComposerThreadDraft(useComposerDraftStore.getState(), missingThreadId);
    expect(after).toBe(before);
  });

  it("does not publish a store update when the prompt is unchanged", () => {
    resetComposerDraftStore();
    const threadId = ThreadId.makeUnsafe("thread-unchanged-prompt");
    const listener = vi.fn();
    const unsubscribe = useComposerDraftStore.subscribe(listener);

    useComposerDraftStore.getState().setPrompt(threadId, "Do something");
    listener.mockClear();
    const before = useComposerDraftStore.getState();

    useComposerDraftStore.getState().setPrompt(threadId, "Do something");

    expect(useComposerDraftStore.getState()).toBe(before);
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("does not create a draft for an unchanged empty prompt", () => {
    resetComposerDraftStore();
    const threadId = ThreadId.makeUnsafe("thread-empty-prompt");
    const before = useComposerDraftStore.getState();

    useComposerDraftStore.getState().setPrompt(threadId, "");

    expect(useComposerDraftStore.getState()).toBe(before);
    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]).toBeUndefined();
  });
});

describe("composerDraftStore clearComposerContent", () => {
  const threadId = ThreadId.makeUnsafe("thread-clear");
  let originalRevokeObjectUrl: typeof URL.revokeObjectURL;
  let revokeSpy: ReturnType<typeof vi.fn<(url: string) => void>>;

  beforeEach(() => {
    resetComposerDraftStore();
    originalRevokeObjectUrl = URL.revokeObjectURL;
    revokeSpy = vi.fn();
    URL.revokeObjectURL = revokeSpy;
  });

  afterEach(() => {
    URL.revokeObjectURL = originalRevokeObjectUrl;
  });

  it("revokes blob preview URLs when clearing composer content", () => {
    const first = makeImage({
      id: "img-clear",
      previewUrl: "blob:clear",
    });
    useComposerDraftStore.getState().addImage(threadId, first);

    useComposerDraftStore.getState().clearComposerContent(threadId);

    const draft = useComposerDraftStore.getState().draftsByThreadId[threadId];
    expect(draft).toBeUndefined();
    expect(revokeSpy).toHaveBeenCalledWith("blob:clear");
  });

  it("can preserve blob preview URLs for optimistic message handoff", () => {
    const first = makeImage({
      id: "img-optimistic",
      previewUrl: "blob:optimistic",
    });
    useComposerDraftStore.getState().addImage(threadId, first);

    useComposerDraftStore.getState().clearComposerContent(threadId, { preservePreviewUrls: true });

    const draft = useComposerDraftStore.getState().draftsByThreadId[threadId];
    expect(draft).toBeUndefined();
    expect(revokeSpy).not.toHaveBeenCalledWith("blob:optimistic");
  });

  it("clears selected provider references with composer content", () => {
    const store = useComposerDraftStore.getState();

    store.setPrompt(threadId, "Use @linear and /check-code");
    store.setSkills(threadId, [{ name: "check-code", path: "/skills/check-code" }]);
    store.setMentions(threadId, [{ name: "linear", path: "plugin://linear" }]);
    store.clearComposerContent(threadId);

    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]).toBeUndefined();
  });
});

describe("composerDraftStore queued edit reconciliation", () => {
  const threadId = ThreadId.makeUnsafe("thread-queued-edit");
  beforeEach(resetComposerDraftStore);

  it("appends a cancelled turn after existing composer content and merges attachments", () => {
    const queuedTurn = makeQueuedChatTurn("queued-edit");
    const image = makeImage({ id: "queued-edit-image", previewUrl: "blob:queued-edit-image" });
    const terminalContext = {
      id: "terminal-context",
      threadId,
      createdAt: "2026-01-01T00:00:00.000Z",
      terminalId: "term",
      terminalLabel: "Terminal",
      lineStart: 1,
      lineEnd: 2,
      text: "terminal output",
    };
    const store = useComposerDraftStore.getState();
    const newerImage = makeImage({ id: "newer-image", previewUrl: "blob:newer-image" });
    store.setPrompt(threadId, "newer prompt");
    store.addImage(threadId, newerImage);
    expect(
      store.restoreFailedComposerSubmission(threadId, {
        ...queuedTurn,
        prompt: "queued prompt",
        images: [image],
        terminalContexts: [terminalContext],
      }),
    ).toBe(true);
    const draft = useComposerDraftStore.getState().draftsByThreadId[threadId]!;
    expect(draft.prompt).toBe("newer prompt\n\nqueued prompt");
    expect(draft.images.map(({ id }) => id)).toEqual(["newer-image", "queued-edit-image"]);
    expect(draft.terminalContexts).toEqual([terminalContext]);
  });
});

describe("composerDraftStore project draft thread mapping", () => {
  const folderId = FolderId.makeUnsafe("project-a");
  const otherFolderId = FolderId.makeUnsafe("project-b");
  const threadId = ThreadId.makeUnsafe("thread-a");
  const otherThreadId = ThreadId.makeUnsafe("thread-b");
  let originalRevokeObjectUrl: typeof URL.revokeObjectURL;
  let revokeSpy: ReturnType<typeof vi.fn<(url: string) => void>>;

  beforeEach(() => {
    resetComposerDraftStore();
    originalRevokeObjectUrl = URL.revokeObjectURL;
    revokeSpy = vi.fn();
    URL.revokeObjectURL = revokeSpy;
  });

  afterEach(() => {
    URL.revokeObjectURL = originalRevokeObjectUrl;
  });

  it("stores and reads project draft thread ids via actions", () => {
    const store = useComposerDraftStore.getState();
    expect(store.getDraftThreadByFolderId(folderId)).toBeNull();
    expect(store.getDraftThread(threadId)).toBeNull();

    store.setProjectDraftThreadId(folderId, threadId, {
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(useComposerDraftStore.getState().getDraftThreadByFolderId(folderId)).toEqual({
      threadId,

      folderId,
      spaceId: null,
      entryPoint: "chat",
      runtimeMode: "full-access",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(useComposerDraftStore.getState().getDraftThread(threadId)).toEqual({
      folderId,
      spaceId: null,
      entryPoint: "chat",
      runtimeMode: "full-access",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
  });

  it("preserves untouched thread draft identity across unrelated thread updates", () => {
    const store = useComposerDraftStore.getState();
    store.setPrompt(threadId, "thread a");
    store.setPrompt(otherThreadId, "thread b");
    const threadADraft = useComposerDraftStore.getState().draftsByThreadId[threadId];

    useComposerDraftStore.getState().setPrompt(otherThreadId, "thread b updated");

    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]).toBe(threadADraft);
  });

  it("registers a mapping-less terminal draft for staged navigation", () => {
    const store = useComposerDraftStore.getState();

    store.registerDraftThread(threadId, {
      folderId,
      entryPoint: "terminal",
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    expect(useComposerDraftStore.getState().getDraftThread(threadId)).toMatchObject({
      folderId,
      entryPoint: "terminal",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(useComposerDraftStore.getState().getDraftThreadByFolderId(folderId, "terminal")).toBe(
      null,
    );
  });

  it("keeps multiple local folder drafts independent when the primary slot changes", () => {
    const store = useComposerDraftStore.getState();
    store.registerDraftThread(threadId, { folderId, entryPoint: "chat" });
    store.registerDraftThread(otherThreadId, { folderId, entryPoint: "chat" });
    store.setProjectDraftThreadId(folderId, threadId);
    store.setProjectDraftThreadId(folderId, otherThreadId);
    expect(useComposerDraftStore.getState().getDraftThread(threadId)).toMatchObject({ folderId });
    expect(useComposerDraftStore.getState().getDraftThread(otherThreadId)).toMatchObject({
      folderId,
    });
    expect(useComposerDraftStore.getState().getDraftThreadByFolderId(folderId)?.threadId).toBe(
      otherThreadId,
    );
  });

  it("tracks chat and terminal draft threads independently for the same project", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(folderId, threadId, { entryPoint: "chat" });
    store.setProjectDraftThreadId(folderId, otherThreadId, { entryPoint: "terminal" });

    expect(
      useComposerDraftStore.getState().getDraftThreadByFolderId(folderId, "chat"),
    ).toMatchObject({
      threadId,
      folderId,
      entryPoint: "chat",
    });
    expect(
      useComposerDraftStore.getState().getDraftThreadByFolderId(folderId, "terminal"),
    ).toMatchObject({
      threadId: otherThreadId,
      folderId,
      entryPoint: "terminal",
    });
    expect(useComposerDraftStore.getState().getDraftThread(threadId)?.entryPoint).toBe("chat");
    expect(useComposerDraftStore.getState().getDraftThread(otherThreadId)?.entryPoint).toBe(
      "terminal",
    );
  });

  it("clears only matching project draft mapping entries", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(folderId, threadId);
    store.setPrompt(threadId, "hello");

    store.clearProjectDraftThreadById(folderId, otherThreadId);
    expect(useComposerDraftStore.getState().getDraftThreadByFolderId(folderId)?.threadId).toBe(
      threadId,
    );

    store.clearProjectDraftThreadById(folderId, threadId);
    expect(useComposerDraftStore.getState().getDraftThreadByFolderId(folderId)).toBeNull();
    expect(useComposerDraftStore.getState().getDraftThread(threadId)).toBeNull();
    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]).toBeUndefined();
  });

  it("clears project draft mapping by project id", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(folderId, threadId);
    store.setPrompt(threadId, "hello");
    store.clearProjectDraftThreadId(folderId);
    expect(useComposerDraftStore.getState().getDraftThreadByFolderId(folderId)).toBeNull();
    expect(useComposerDraftStore.getState().getDraftThread(threadId)).toBeNull();
    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]).toBeUndefined();
  });

  it("preserves the previous folder draft and its composer when creating another tab", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(folderId, threadId);
    store.setPrompt(threadId, "keep me");

    store.setProjectDraftThreadId(folderId, otherThreadId);

    expect(useComposerDraftStore.getState().getDraftThreadByFolderId(folderId)?.threadId).toBe(
      otherThreadId,
    );
    expect(useComposerDraftStore.getState().getDraftThread(threadId)?.folderId).toBe(folderId);
    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]?.prompt).toBe("keep me");
  });

  it("clears draft registration independently", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(folderId, threadId);
    store.setPrompt(threadId, "remove me");
    store.clearDraftThread(threadId);
    expect(useComposerDraftStore.getState().getDraftThreadByFolderId(folderId)).toBeNull();
    expect(useComposerDraftStore.getState().getDraftThread(threadId)).toBeNull();
    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]).toBeUndefined();
  });

  it("ends promoted draft identity without deleting newer composer state", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(folderId, threadId);
    store.setPrompt(threadId, "keep me while server thread hydrates");

    markPromotedDraftThreads(new Set([threadId]));

    expect(useComposerDraftStore.getState().getDraftThread(threadId)?.promotedTo).toBe(threadId);
    expect(useComposerDraftStore.getState().getDraftThreadByFolderId(folderId)).toBeNull();
    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]?.prompt).toBe(
      "keep me while server thread hydrates",
    );

    useComposerDraftStore.getState().finalizePromotedDraftThread(threadId);

    expect(useComposerDraftStore.getState().getDraftThread(threadId)).toBeNull();
    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]?.prompt).toBe(
      "keep me while server thread hydrates",
    );
  });

  it("finalizes every promoted identity while retaining each live composer draft", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(folderId, threadId);
    store.setProjectDraftThreadId(otherFolderId, otherThreadId);
    store.setPrompt(threadId, "first promoted draft");
    store.setPrompt(otherThreadId, "second promoted draft");
    markPromotedDraftThreads(new Set([threadId, otherThreadId]));

    finalizePromotedDraftThreads(new Set([threadId, otherThreadId]));

    expect(useComposerDraftStore.getState().getDraftThread(threadId)).toBeNull();
    expect(useComposerDraftStore.getState().getDraftThread(otherThreadId)).toBeNull();
    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]?.prompt).toBe(
      "first promoted draft",
    );
    expect(useComposerDraftStore.getState().draftsByThreadId[otherThreadId]?.prompt).toBe(
      "second promoted draft",
    );
  });

  it("updates branch context on an existing draft thread", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(folderId, threadId, {});
    expect(useComposerDraftStore.getState().getDraftThreadByFolderId(folderId)?.threadId).toBe(
      threadId,
    );
    expect(useComposerDraftStore.getState().getDraftThread(threadId)).toMatchObject({
      folderId,
    });
  });

  it("moves an empty draft to another project while preserving composer content", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(folderId, threadId, {});
    store.setPrompt(threadId, "keep this draft");

    store.moveDraftThreadToProject(threadId, otherFolderId, {});

    expect(useComposerDraftStore.getState().getDraftThreadByFolderId(folderId)).toBeNull();
    expect(useComposerDraftStore.getState().getDraftThreadByFolderId(otherFolderId)).toMatchObject({
      threadId,
      folderId: otherFolderId,
    });
    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]?.prompt).toBe(
      "keep this draft",
    );
  });
});

describe("composerDraftStore runtime settings", () => {
  const threadId = ThreadId.makeUnsafe("thread-settings");

  beforeEach(() => {
    resetComposerDraftStore();
  });

  it("stores runtime mode overrides in the composer draft", () => {
    const store = useComposerDraftStore.getState();

    store.setRuntimeMode(threadId, "approval-required");

    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]?.runtimeMode).toBe(
      "approval-required",
    );
  });

  it("removes empty settings-only drafts when overrides are cleared", () => {
    const store = useComposerDraftStore.getState();

    store.setRuntimeMode(threadId, "approval-required");
    store.setRuntimeMode(threadId, null);

    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]).toBeUndefined();
  });
});
