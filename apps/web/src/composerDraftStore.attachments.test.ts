import { ThreadId } from "@penkra/contracts";
import * as Schema from "effect/Schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pendingComposerAttachmentSyncGenerationCount } from "./composerDraftAttachments";
import {
  captureComposerPromptHistorySavedDraft,
  COMPOSER_DRAFT_STORAGE_KEY,
  findSupersededComposerImageBlobAttachments,
  isComposerImageBlobReferenced,
  partializeComposerDraftStoreState,
  useComposerDraftStore,
  type ComposerImageAttachment,
} from "./composerDraftStore";
import {
  makeFile,
  makeImage,
  makeTerminalContext,
  modelSelection,
  resetComposerDraftStore,
} from "./composerDraftStoreTestFixtures";
import { removeLocalStorageItem, setLocalStorageItem } from "./hooks/useLocalStorage";
import { insertInlineTerminalContextPlaceholder } from "./lib/terminalContext";

describe("composerDraftStore addImages", () => {
  const threadId = ThreadId.makeUnsafe("thread-dedupe");
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

  it("deduplicates identical images in one batch by file signature", () => {
    const first = makeImage({
      id: "img-1",
      previewUrl: "blob:first",
      name: "same.png",
      mimeType: "image/png",
      sizeBytes: 12,
      lastModified: 12345,
    });
    const duplicate = makeImage({
      id: "img-2",
      previewUrl: "blob:duplicate",
      name: "same.png",
      mimeType: "image/png",
      sizeBytes: 12,
      lastModified: 12345,
    });

    useComposerDraftStore.getState().addImages(threadId, [first, duplicate]);

    const draft = useComposerDraftStore.getState().draftsByThreadId[threadId];
    expect(draft?.images.map((image) => image.id)).toEqual(["img-1"]);
    expect(revokeSpy).toHaveBeenCalledWith("blob:duplicate");
  });

  it("deduplicates against existing images across calls by file signature", () => {
    const first = makeImage({
      id: "img-a",
      previewUrl: "blob:a",
      name: "same.png",
      mimeType: "image/png",
      sizeBytes: 9,
      lastModified: 777,
    });
    const duplicateLater = makeImage({
      id: "img-b",
      previewUrl: "blob:b",
      name: "same.png",
      mimeType: "image/png",
      sizeBytes: 9,
      lastModified: 999,
    });

    useComposerDraftStore.getState().addImage(threadId, first);
    useComposerDraftStore.getState().addImage(threadId, duplicateLater);

    const draft = useComposerDraftStore.getState().draftsByThreadId[threadId];
    expect(draft?.images.map((image) => image.id)).toEqual(["img-a"]);
    expect(revokeSpy).toHaveBeenCalledWith("blob:b");
  });

  it("does not revoke blob URLs that are still used by an accepted duplicate image", () => {
    const first = makeImage({
      id: "img-shared",
      previewUrl: "blob:shared",
    });
    const duplicateSameUrl = makeImage({
      id: "img-shared",
      previewUrl: "blob:shared",
    });

    useComposerDraftStore.getState().addImages(threadId, [first, duplicateSameUrl]);

    const draft = useComposerDraftStore.getState().draftsByThreadId[threadId];
    expect(draft?.images.map((image) => image.id)).toEqual(["img-shared"]);
    expect(revokeSpy).not.toHaveBeenCalledWith("blob:shared");
  });
});

describe("composerDraftStore voice transcript durability", () => {
  const threadId = ThreadId.makeUnsafe("thread-voice-draft");

  beforeEach(() => resetComposerDraftStore());

  it("applies a recovered voice job exactly once in one draft mutation", () => {
    const store = useComposerDraftStore.getState();
    store.setPrompt(threadId, "Existing text");

    expect(store.applyVoiceTranscript(threadId, "voice-job-1", "Recovered words")).toBe(
      "Existing text\n\nRecovered words",
    );
    expect(store.applyVoiceTranscript(threadId, "voice-job-1", "Recovered words")).toBe(
      "Existing text\n\nRecovered words",
    );
    const draft = useComposerDraftStore.getState().draftsByThreadId[threadId];
    expect(draft?.prompt).toBe("Existing text\n\nRecovered words");
    expect(draft?.appliedVoiceJobIds).toEqual(["voice-job-1"]);
    expect(
      partializeComposerDraftStoreState(useComposerDraftStore.getState()).draftsByThreadId[threadId]
        ?.appliedVoiceJobIds,
    ).toEqual(["voice-job-1"]);
  });
});

describe("composerDraftStore file durability", () => {
  const threadId = ThreadId.makeUnsafe("thread-file-draft");

  beforeEach(() => resetComposerDraftStore());

  it("persists an asset-backed ordinary file in the composer snapshot", () => {
    const file = makeFile({ id: "file-1", name: "notes.txt", mimeType: "text/plain" });
    useComposerDraftStore.getState().addFiles(threadId, [{ ...file, assetKey: "asset-file-1" }]);

    expect(
      partializeComposerDraftStoreState(useComposerDraftStore.getState()).draftsByThreadId[threadId]
        ?.files,
    ).toEqual([
      {
        id: "file-1",
        name: "notes.txt",
        mimeType: "text/plain",
        sizeBytes: file.sizeBytes,
        assetKey: "asset-file-1",
      },
    ]);
  });
});

describe("composerDraftStore prompt history saved draft", () => {
  const threadId = ThreadId.makeUnsafe("thread-prompt-history-attachments");

  beforeEach(() => {
    resetComposerDraftStore();
  });

  it("moves composer attachments into the prompt-history snapshot while browsing", () => {
    const store = useComposerDraftStore.getState();
    const image = makeImage({ id: "img-history", previewUrl: "blob:history" });
    const file = makeFile({ id: "file-history" });
    const persistedAttachment = {
      id: image.id,
      name: image.name,
      mimeType: image.mimeType,
      sizeBytes: image.sizeBytes,
      dataUrl: "data:image/png;base64,aGk=",
    };

    store.setPrompt(threadId, "draft with attachments");
    store.addImage(threadId, image);
    store.addFiles(threadId, [file]);
    store.syncPersistedAttachments(threadId, [persistedAttachment]);
    const draftBeforeBrowse = useComposerDraftStore.getState().draftsByThreadId[threadId]!;

    useComposerDraftStore.getState().setPromptHistorySavedDraft(
      threadId,
      captureComposerPromptHistorySavedDraft({
        threadId,
        draft: draftBeforeBrowse,
        prompt: draftBeforeBrowse.prompt,
      }),
    );

    const browsingDraft = useComposerDraftStore.getState().draftsByThreadId[threadId]!;
    expect(browsingDraft.images).toHaveLength(0);
    expect(browsingDraft.files).toHaveLength(0);
    expect(browsingDraft.persistedAttachments).toHaveLength(0);
    expect(browsingDraft.promptHistorySavedDraft?.prompt).toBe("draft with attachments");
    expect(browsingDraft.promptHistorySavedDraft?.images.map((entry) => entry.id)).toEqual([
      "img-history",
    ]);
    expect(browsingDraft.promptHistorySavedDraft?.files.map((entry) => entry.id)).toEqual([
      "file-history",
    ]);
    expect(
      browsingDraft.promptHistorySavedDraft?.persistedAttachments.map((entry) => entry.id),
    ).toEqual(["img-history"]);
  });

  it("restores prompt-history snapshot text and attachments together", () => {
    const store = useComposerDraftStore.getState();
    const image = makeImage({ id: "img-restore", previewUrl: "blob:restore" });
    const file = makeFile({ id: "file-restore" });

    store.setPrompt(threadId, "draft before history");
    store.addImage(threadId, image);
    store.addFiles(threadId, [file]);
    const draftBeforeBrowse = useComposerDraftStore.getState().draftsByThreadId[threadId]!;
    store.setPromptHistorySavedDraft(
      threadId,
      captureComposerPromptHistorySavedDraft({
        threadId,
        draft: draftBeforeBrowse,
        prompt: draftBeforeBrowse.prompt,
      }),
    );
    store.setPrompt(threadId, "recalled history prompt");

    useComposerDraftStore.getState().restorePromptHistorySavedDraft(threadId);

    const restoredDraft = useComposerDraftStore.getState().draftsByThreadId[threadId]!;
    expect(restoredDraft.prompt).toBe("draft before history");
    expect(restoredDraft.promptHistorySavedDraft).toBeNull();
    expect(restoredDraft.images.map((entry) => entry.id)).toEqual(["img-restore"]);
    expect(restoredDraft.files.map((entry) => entry.id)).toEqual(["file-restore"]);
  });

  it("moves and restores structured composer context with the prompt-history snapshot", () => {
    const store = useComposerDraftStore.getState();
    const assistantSelection = {
      type: "assistant-selection" as const,
      id: "sel-history",
      assistantMessageId: "assistant-1",
      text: "Use this assistant answer",
    };
    const terminalContext = makeTerminalContext({
      id: "ctx-history",
      text: "bun run check",
    });
    const fileComment = {
      id: "comment-history",
      path: "apps/web/src/App.tsx",
      startLine: 4,
      endLine: 6,
      text: "Please update this range.",
    };
    const pastedText = {
      id: "paste-history",
      createdAt: "2026-03-13T12:00:00.000Z",
      text: "large pasted content",
      lineCount: 1,
      charCount: "large pasted content".length,
    };
    const selectedSkill = { name: "check-code", path: "/skills/check-code" };
    const selectedMention = { name: "linear", path: "plugin://linear" };

    store.setPrompt(threadId, "draft with structured context");
    store.addAssistantSelection(threadId, assistantSelection);
    store.addTerminalContext(threadId, terminalContext);
    store.addFileComment(threadId, fileComment);
    store.addPastedTexts(threadId, [pastedText]);
    store.setSkills(threadId, [selectedSkill]);
    store.setMentions(threadId, [selectedMention]);
    const draftBeforeBrowse = useComposerDraftStore.getState().draftsByThreadId[threadId]!;

    store.setPromptHistorySavedDraft(
      threadId,
      captureComposerPromptHistorySavedDraft({
        threadId,
        draft: draftBeforeBrowse,
        prompt: draftBeforeBrowse.prompt,
      }),
    );

    const browsingDraft = useComposerDraftStore.getState().draftsByThreadId[threadId]!;
    expect(browsingDraft.assistantSelections).toHaveLength(0);
    expect(browsingDraft.terminalContexts).toHaveLength(0);
    expect(browsingDraft.fileComments).toHaveLength(0);
    expect(browsingDraft.pastedTexts).toHaveLength(0);
    expect(browsingDraft.skills).toHaveLength(0);
    expect(browsingDraft.mentions).toHaveLength(0);
    expect(
      browsingDraft.promptHistorySavedDraft?.assistantSelections.map((entry) => entry.id),
    ).toEqual(["sel-history"]);
    expect(
      browsingDraft.promptHistorySavedDraft?.terminalContexts.map((entry) => entry.id),
    ).toEqual(["ctx-history"]);
    expect(browsingDraft.promptHistorySavedDraft?.fileComments.map((entry) => entry.id)).toEqual([
      "comment-history",
    ]);
    expect(browsingDraft.promptHistorySavedDraft?.pastedTexts.map((entry) => entry.id)).toEqual([
      "paste-history",
    ]);
    expect(browsingDraft.promptHistorySavedDraft?.skills).toEqual([selectedSkill]);
    expect(browsingDraft.promptHistorySavedDraft?.mentions).toEqual([selectedMention]);

    store.setPrompt(threadId, "recalled history prompt");
    store.restorePromptHistorySavedDraft(threadId);

    const restoredDraft = useComposerDraftStore.getState().draftsByThreadId[threadId]!;
    expect(restoredDraft.prompt).toBe(draftBeforeBrowse.prompt);
    expect(restoredDraft.assistantSelections.map((entry) => entry.id)).toEqual(["sel-history"]);
    expect(restoredDraft.terminalContexts.map((entry) => entry.id)).toEqual(["ctx-history"]);
    expect(restoredDraft.fileComments.map((entry) => entry.id)).toEqual(["comment-history"]);
    expect(restoredDraft.pastedTexts.map((entry) => entry.id)).toEqual(["paste-history"]);
    expect(restoredDraft.skills).toEqual([selectedSkill]);
    expect(restoredDraft.mentions).toEqual([selectedMention]);
  });

  it("persists and hydrates prompt-history snapshot images and structured context", () => {
    const store = useComposerDraftStore.getState();
    const image = makeImage({ id: "img-persist-history", previewUrl: "blob:persist-history" });
    const persistedAttachment = {
      id: image.id,
      name: image.name,
      mimeType: image.mimeType,
      sizeBytes: image.sizeBytes,
      dataUrl: "data:image/png;base64,aGk=",
    };
    const terminalContext = makeTerminalContext({
      id: "ctx-persist-history",
      text: "bun run test",
    });
    const pastedText = {
      id: "paste-persist-history",
      createdAt: "2026-03-13T12:00:00.000Z",
      text: "persisted paste",
      lineCount: 1,
      charCount: "persisted paste".length,
    };
    const selectedSkill = { name: "check-code", path: "/skills/check-code" };

    store.setPrompt(threadId, "persist me before history");
    store.addImage(threadId, image);
    store.syncPersistedAttachments(threadId, [persistedAttachment]);
    store.addTerminalContext(threadId, terminalContext);
    store.addPastedTexts(threadId, [pastedText]);
    store.setSkills(threadId, [selectedSkill]);
    const draftBeforeBrowse = useComposerDraftStore.getState().draftsByThreadId[threadId]!;
    store.setPromptHistorySavedDraft(
      threadId,
      captureComposerPromptHistorySavedDraft({
        threadId,
        draft: draftBeforeBrowse,
        prompt: draftBeforeBrowse.prompt,
      }),
    );

    const persistApi = useComposerDraftStore.persist as unknown as {
      getOptions: () => {
        partialize: (state: ReturnType<typeof useComposerDraftStore.getState>) => unknown;
        merge: (
          persistedState: unknown,
          currentState: ReturnType<typeof useComposerDraftStore.getState>,
        ) => ReturnType<typeof useComposerDraftStore.getState>;
      };
    };
    const persistedState = partializeComposerDraftStoreState(
      useComposerDraftStore.getState(),
    ) as unknown as {
      draftsByThreadId?: Record<string, { promptHistorySavedDraft?: Record<string, unknown> }>;
    };

    expect(
      persistedState.draftsByThreadId?.[threadId]?.promptHistorySavedDraft?.attachments,
    ).toEqual([persistedAttachment]);
    const persistedSnapshot = persistedState.draftsByThreadId?.[threadId]?.promptHistorySavedDraft;
    const persistedTerminalContexts = persistedSnapshot?.terminalContexts as
      | Array<Record<string, unknown>>
      | undefined;
    expect(persistedTerminalContexts?.[0]).toMatchObject({
      id: "ctx-persist-history",
    });
    expect(persistedTerminalContexts?.[0]).not.toHaveProperty("text");
    expect(persistedSnapshot?.pastedTexts).toEqual([
      {
        id: "paste-persist-history",
        createdAt: "2026-03-13T12:00:00.000Z",
        text: "persisted paste",
      },
    ]);
    expect(persistedSnapshot?.skills).toEqual([selectedSkill]);

    const mergedState = persistApi
      .getOptions()
      .merge(persistedState, useComposerDraftStore.getInitialState());
    const restoredSnapshot = mergedState.draftsByThreadId[threadId]?.promptHistorySavedDraft;

    expect(restoredSnapshot?.images.map((entry) => entry.id)).toEqual(["img-persist-history"]);
    expect(restoredSnapshot?.files).toEqual([]);
    expect(restoredSnapshot?.terminalContexts).toEqual([
      expect.objectContaining({
        id: "ctx-persist-history",
        text: "",
      }),
    ]);
    expect(restoredSnapshot?.pastedTexts.map((entry) => entry.id)).toEqual([
      "paste-persist-history",
    ]);
    expect(restoredSnapshot?.skills).toEqual([selectedSkill]);
  });

  it("syncs persisted images into an existing prompt-history snapshot", async () => {
    const store = useComposerDraftStore.getState();
    const image = makeImage({ id: "img-sync-history", previewUrl: "blob:sync-history" });
    const persistedAttachment = {
      id: image.id,
      name: image.name,
      mimeType: image.mimeType,
      sizeBytes: image.sizeBytes,
      dataUrl: "data:image/png;base64,aGk=",
    };

    store.setPrompt(threadId, "draft before async image persistence");
    store.addImage(threadId, image);
    const draftBeforeBrowse = useComposerDraftStore.getState().draftsByThreadId[threadId]!;
    store.setPromptHistorySavedDraft(
      threadId,
      captureComposerPromptHistorySavedDraft({
        threadId,
        draft: draftBeforeBrowse,
        prompt: draftBeforeBrowse.prompt,
      }),
    );

    setLocalStorageItem(
      COMPOSER_DRAFT_STORAGE_KEY,
      {
        version: 6,
        state: {
          draftsByThreadId: {
            [threadId]: {
              prompt: "recalled history prompt",
              promptHistorySavedDraft: {
                prompt: "draft before async image persistence",
                attachments: [persistedAttachment],
              },
              attachments: [],
            },
          },
          draftThreadsByThreadId: {},
          projectDraftThreadIdByProjectId: {},
        },
      },
      Schema.Unknown,
    );
    store.syncPromptHistorySavedDraftPersistedAttachments(threadId, [persistedAttachment]);
    await Promise.resolve();

    const savedDraft =
      useComposerDraftStore.getState().draftsByThreadId[threadId]?.promptHistorySavedDraft;
    expect(savedDraft?.persistedAttachments.map((entry) => entry.id)).toEqual(["img-sync-history"]);
    expect(savedDraft?.nonPersistedImageIds).toEqual([]);
  });
});

describe("composerDraftStore copyTransferableComposerState", () => {
  const sourceThreadId = ThreadId.makeUnsafe("thread-source");
  const targetThreadId = ThreadId.makeUnsafe("thread-target");

  beforeEach(() => {
    resetComposerDraftStore();
  });

  it("copies the prompt and terminal contexts to the target thread", () => {
    const sourceContext = makeTerminalContext({
      id: "ctx-source",
      text: "pnpm lint",
    });
    const copiedPrompt = insertInlineTerminalContextPlaceholder(
      "Please reuse this context",
      24,
    ).prompt;

    useComposerDraftStore.getState().setPrompt(sourceThreadId, copiedPrompt);
    useComposerDraftStore.getState().setTerminalContexts(sourceThreadId, [sourceContext]);
    useComposerDraftStore
      .getState()
      .setSkills(sourceThreadId, [{ name: "check-code", path: "/skills/check-code" }]);
    useComposerDraftStore
      .getState()
      .setMentions(sourceThreadId, [{ name: "linear", path: "plugin://linear" }]);

    useComposerDraftStore.getState().copyTransferableComposerState(sourceThreadId, targetThreadId);

    const sourceDraft = useComposerDraftStore.getState().draftsByThreadId[sourceThreadId];
    const targetDraft = useComposerDraftStore.getState().draftsByThreadId[targetThreadId];

    expect(targetDraft).toMatchObject({
      prompt: sourceDraft?.prompt,
      terminalContexts: [
        expect.objectContaining({
          id: sourceContext.id,
          threadId: targetThreadId,
          terminalId: sourceContext.terminalId,
          terminalLabel: sourceContext.terminalLabel,
          text: sourceContext.text,
        }),
      ],
      skills: [{ name: "check-code", path: "/skills/check-code" }],
      mentions: [{ name: "linear", path: "plugin://linear" }],
    });
  });

  it("copies image attachments with fresh preview URLs", () => {
    const originalCreateObjectUrl = URL.createObjectURL;
    URL.createObjectURL = vi.fn(() => "blob:target-copy");
    try {
      const sourceImage = makeImage({
        id: "img-source",
        previewUrl: "blob:source-preview",
      });

      useComposerDraftStore.getState().addImages(sourceThreadId, [sourceImage]);
      useComposerDraftStore.setState((state) => ({
        draftsByThreadId: {
          ...state.draftsByThreadId,
          [sourceThreadId]: {
            ...state.draftsByThreadId[sourceThreadId]!,
            nonPersistedImageIds: ["img-source"],
          },
        },
      }));
      useComposerDraftStore
        .getState()
        .copyTransferableComposerState(sourceThreadId, targetThreadId);

      const targetDraft = useComposerDraftStore.getState().draftsByThreadId[targetThreadId];
      expect(targetDraft?.images).toEqual([
        expect.objectContaining({
          id: "img-source",
          file: sourceImage.file,
          previewUrl: "blob:target-copy",
        }),
      ]);
      expect(targetDraft?.nonPersistedImageIds).toEqual(["img-source"]);
    } finally {
      URL.createObjectURL = originalCreateObjectUrl;
    }
  });

  it("keeps a shared image blob referenced until every copied draft removes it", async () => {
    const blobKey = `${sourceThreadId}:shared-image`;
    const sourceImage = makeImage({ id: "shared-image", previewUrl: "blob:source-image" });
    const store = useComposerDraftStore.getState();
    store.addImage(sourceThreadId, sourceImage);
    useComposerDraftStore.setState((state) => ({
      draftsByThreadId: {
        ...state.draftsByThreadId,
        [sourceThreadId]: {
          ...state.draftsByThreadId[sourceThreadId]!,
          persistedAttachments: [
            {
              id: sourceImage.id,
              name: sourceImage.name,
              mimeType: sourceImage.mimeType,
              sizeBytes: sourceImage.sizeBytes,
              blobKey,
            },
          ],
        },
      },
    }));

    store.copyTransferableComposerState(sourceThreadId, targetThreadId);
    store.removeImage(sourceThreadId, sourceImage.id);
    await Promise.resolve();

    expect(
      isComposerImageBlobReferenced(useComposerDraftStore.getState().draftsByThreadId, blobKey),
    ).toBe(true);

    store.removeImage(targetThreadId, sourceImage.id);
    await Promise.resolve();
    expect(
      isComposerImageBlobReferenced(useComposerDraftStore.getState().draftsByThreadId, blobKey),
    ).toBe(false);
  });

  it("identifies a replaced thread-scoped blob key for cleanup", () => {
    const previousAttachment = {
      id: "blob-image-rekeyed",
      name: "capture.png",
      mimeType: "image/png",
      sizeBytes: 4,
      blobKey: `${sourceThreadId}:blob-image-rekeyed`,
    };
    const nextAttachment = {
      ...previousAttachment,
      blobKey: `${targetThreadId}:blob-image-rekeyed`,
    };

    expect(
      findSupersededComposerImageBlobAttachments([previousAttachment], [nextAttachment]),
    ).toEqual([previousAttachment]);
    expect(
      findSupersededComposerImageBlobAttachments([previousAttachment], [previousAttachment]),
    ).toEqual([]);
  });

  it("preserves unrelated target draft state while replacing transferred composer content", () => {
    useComposerDraftStore.getState().setPrompt(sourceThreadId, "follow-up for the other provider");
    useComposerDraftStore.getState().setModelSelection(
      targetThreadId,
      modelSelection("claudeAgent", "claude-sonnet-4-6", {
        effort: "high",
      }),
    );

    useComposerDraftStore.getState().copyTransferableComposerState(sourceThreadId, targetThreadId);

    expect(useComposerDraftStore.getState().draftsByThreadId[targetThreadId]).toMatchObject({
      prompt: "follow-up for the other provider",
      modelSelectionByProvider: {
        claudeAgent: {
          provider: "claudeAgent",
          model: "claude-sonnet-4-6",
          options: {
            effort: "high",
          },
        },
      },
      activeProvider: "claudeAgent",
    });
  });
});

describe("composerDraftStore syncPersistedAttachments", () => {
  const threadId = ThreadId.makeUnsafe("thread-sync-persisted");

  beforeEach(() => {
    removeLocalStorageItem(COMPOSER_DRAFT_STORAGE_KEY);
    useComposerDraftStore.setState({
      draftsByThreadId: {},
      draftThreadsByThreadId: {},
      projectDraftThreadIdByProjectId: {},
      stickyModelSelectionByProvider: {},
      stickyConnectionByProvider: {},
      stickyActiveProvider: null,
    });
  });

  afterEach(() => {
    removeLocalStorageItem(COMPOSER_DRAFT_STORAGE_KEY);
  });

  it("stages overlapping attachment syncs immediately and serializes verification", async () => {
    const firstImage = makeImage({
      id: "blob-sync-first",
      previewUrl: "blob:blob-sync-first",
      name: "blob-sync-first.png",
    });
    const secondImage = makeImage({
      id: "blob-sync-second",
      previewUrl: "blob:blob-sync-second",
      name: "blob-sync-second.png",
    });
    const attachmentFor = (image: ComposerImageAttachment) => ({
      id: image.id,
      name: image.name,
      mimeType: image.mimeType,
      sizeBytes: image.sizeBytes,
      dataUrl: "data:image/png;base64,aGk=",
    });
    const store = useComposerDraftStore.getState();
    store.addImages(threadId, [firstImage, secondImage]);

    const firstSync = store.syncPersistedAttachments(threadId, [attachmentFor(firstImage)]);
    const secondSync = store.syncPersistedAttachments(threadId, [
      attachmentFor(firstImage),
      attachmentFor(secondImage),
    ]);

    // Staging is synchronous even while an earlier sync is still verifying, so
    // a reload in that window cannot lose the newer attachment metadata.
    expect(
      useComposerDraftStore
        .getState()
        .draftsByThreadId[threadId]?.persistedAttachments.map((attachment) => attachment.id),
    ).toEqual([firstImage.id, secondImage.id]);
    await expect(Promise.all([firstSync, secondSync])).resolves.toEqual([
      "unverified",
      "unverified",
    ]);
    expect(
      useComposerDraftStore
        .getState()
        .draftsByThreadId[threadId]?.persistedAttachments.map((attachment) => attachment.id),
    ).toEqual([firstImage.id, secondImage.id]);
  });

  it("retires the sync generation entry once the newest sync for a slot settles", async () => {
    const image = makeImage({
      id: "blob-sync-generation",
      previewUrl: "blob:blob-sync-generation",
      name: "blob-sync-generation.png",
    });
    const attachment = {
      id: image.id,
      name: image.name,
      mimeType: image.mimeType,
      sizeBytes: image.sizeBytes,
      dataUrl: "data:image/png;base64,aGk=",
    };
    const store = useComposerDraftStore.getState();
    store.addImages(threadId, [image]);

    const before = pendingComposerAttachmentSyncGenerationCount();
    const firstSync = store.syncPersistedAttachments(threadId, [attachment]);
    const secondSync = store.syncPersistedAttachments(threadId, [attachment]);

    // Overlapping syncs share one (slot, thread) key, so only one entry is tracked at a time.
    expect(pendingComposerAttachmentSyncGenerationCount()).toBe(before + 1);

    await Promise.all([firstSync, secondSync]);

    // Nothing is left to invalidate once the newest sync settled, so the key must be released.
    expect(pendingComposerAttachmentSyncGenerationCount()).toBe(before);
    expect(
      useComposerDraftStore
        .getState()
        .draftsByThreadId[threadId]?.persistedAttachments.map((persisted) => persisted.id),
    ).toEqual([image.id]);
  });

  it("treats malformed persisted draft storage as empty", async () => {
    const image = makeImage({
      id: "img-persisted",
      previewUrl: "blob:persisted",
    });
    useComposerDraftStore.getState().addImage(threadId, image);
    setLocalStorageItem(
      COMPOSER_DRAFT_STORAGE_KEY,
      {
        version: 2,
        state: {
          draftsByThreadId: {
            [threadId]: {
              attachments: "not-an-array",
            },
          },
        },
      },
      Schema.Unknown,
    );

    const persisted = await useComposerDraftStore.getState().syncPersistedAttachments(threadId, [
      {
        id: image.id,
        name: image.name,
        mimeType: image.mimeType,
        sizeBytes: image.sizeBytes,
        dataUrl: image.previewUrl,
      },
    ]);
    expect(persisted).toBe("unverified");

    expect(
      useComposerDraftStore.getState().draftsByThreadId[threadId]?.persistedAttachments,
    ).toHaveLength(1);
    expect(
      useComposerDraftStore.getState().draftsByThreadId[threadId]?.nonPersistedImageIds,
    ).toEqual([image.id]);
  });
});
