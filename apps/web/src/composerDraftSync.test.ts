import type { ThreadId } from "@penkra/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createEmptyThreadDraft } from "./composerDraftDomain";
import {
  createComposerDraftSync,
  shouldApplyRemoteDraft,
  type ComposerDraftSyncApi,
} from "./composerDraftSync";

const THREAD_ID = "thread-1" as ThreadId;

function makeApi(initial: { draft: string | null; updatedAt: string | null }) {
  let draft = initial.draft;
  let updatedAt = initial.updatedAt;
  const listeners = new Set<(change: { readonly threadId: ThreadId }) => void>();
  const api: ComposerDraftSyncApi & {
    emit: (threadId: ThreadId) => void;
    current: () => { draft: string | null; updatedAt: string | null };
  } = {
    getThreadDraft: vi.fn(async () => ({ draft, draftUpdatedAt: updatedAt })),
    setThreadDraft: vi.fn(async (input) => {
      draft = input.draft;
      updatedAt = input.updatedAt;
      return { draft, draftUpdatedAt: updatedAt };
    }),
    onThreadChange: (callback) => {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
    emit: (threadId) => {
      for (const callback of listeners) callback({ threadId });
    },
    current: () => ({ draft, updatedAt }),
  };
  return api;
}

const serialize = (_threadId: ThreadId, draft: { prompt: string }) =>
  draft.prompt.length > 0 ? JSON.stringify({ prompt: draft.prompt }) : null;
const deserialize = async (_threadId: ThreadId, payload: string) => ({
  ...createEmptyThreadDraft(),
  prompt: (JSON.parse(payload) as { prompt: string }).prompt,
});

afterEach(() => {
  vi.useRealTimers();
});

describe("shouldApplyRemoteDraft", () => {
  it("applies a newer remote draft and never an absent one", () => {
    expect(shouldApplyRemoteDraft(null, "2026-10-09T00:00:02.000Z")).toBe(false);
    expect(shouldApplyRemoteDraft("2026-10-09T00:00:02.000Z", null)).toBe(true);
    expect(shouldApplyRemoteDraft("2026-10-09T00:00:03.000Z", "2026-10-09T00:00:02.000Z")).toBe(
      true,
    );
    expect(shouldApplyRemoteDraft("2026-10-09T00:00:02.000Z", "2026-10-09T00:00:02.000Z")).toBe(
      false,
    );
  });
});

describe("createComposerDraftSync", () => {
  it("applies a newer server draft on start", async () => {
    const api = makeApi({
      draft: JSON.stringify({ prompt: "from the server" }),
      updatedAt: "2026-10-09T00:00:05.000Z",
    });
    const applyServerDraft = vi.fn();
    const sync = createComposerDraftSync({
      api,
      threadId: THREAD_ID,
      applyServerDraft,
      serialize,
      deserialize,
      now: () => "2026-10-09T00:00:06.000Z",
    });
    await sync.start();
    expect(applyServerDraft).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "from the server" }),
    );
    sync.stop();
  });

  it("saves a local edit debounced, once, with the local timestamp", async () => {
    vi.useFakeTimers();
    const api = makeApi({ draft: null, updatedAt: null });
    const sync = createComposerDraftSync({
      api,
      threadId: THREAD_ID,
      applyServerDraft: vi.fn(),
      serialize,
      deserialize,
      now: () => "2026-10-09T00:00:07.000Z",
    });
    await sync.start();
    sync.setLocalDraft({ ...createEmptyThreadDraft(), prompt: "hel" });
    sync.setLocalDraft({ ...createEmptyThreadDraft(), prompt: "hello" });
    expect(api.setThreadDraft).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(300);
    expect(api.setThreadDraft).toHaveBeenCalledTimes(1);
    expect(api.setThreadDraft).toHaveBeenCalledWith({
      threadId: THREAD_ID,
      draft: JSON.stringify({ prompt: "hello" }),
      updatedAt: "2026-10-09T00:00:07.000Z",
    });
    expect(api.current().draft).toBe(JSON.stringify({ prompt: "hello" }));
    sync.stop();
  });

  it("does not echo an applied remote draft back to the server", async () => {
    vi.useFakeTimers();
    const api = makeApi({
      draft: JSON.stringify({ prompt: "remote" }),
      updatedAt: "2026-10-09T00:00:05.000Z",
    });
    const applyServerDraft = vi.fn();
    const sync = createComposerDraftSync({
      api,
      threadId: THREAD_ID,
      applyServerDraft,
      serialize,
      deserialize,
      now: () => "2026-10-09T00:00:08.000Z",
    });
    await sync.start();
    sync.setLocalDraft({ ...createEmptyThreadDraft(), prompt: "remote" });
    await vi.advanceTimersByTimeAsync(300);
    expect(api.setThreadDraft).not.toHaveBeenCalled();
    sync.stop();
  });

  it("applies another window's push when it is newer", async () => {
    const api = makeApi({ draft: null, updatedAt: null });
    const applyServerDraft = vi.fn();
    const sync = createComposerDraftSync({
      api,
      threadId: THREAD_ID,
      applyServerDraft,
      serialize,
      deserialize,
      now: () => "2026-10-09T00:00:09.000Z",
    });
    await sync.start();
    await api.setThreadDraft({
      threadId: THREAD_ID,
      draft: JSON.stringify({ prompt: "from another window" }),
      updatedAt: "2026-10-09T00:00:20.000Z",
    });
    api.emit(THREAD_ID);
    await vi.waitFor(() => {
      expect(applyServerDraft).toHaveBeenCalledWith(
        expect.objectContaining({ prompt: "from another window" }),
      );
    });
    sync.stop();
  });

  it("ignores pushes for other threads and unsubscribes on stop", async () => {
    const api = makeApi({ draft: null, updatedAt: null });
    const applyServerDraft = vi.fn();
    const sync = createComposerDraftSync({
      api,
      threadId: THREAD_ID,
      applyServerDraft,
      serialize,
      deserialize,
      now: () => "2026-10-09T00:00:09.000Z",
    });
    await sync.start();
    api.emit("thread-2" as ThreadId);
    await Promise.resolve();
    expect(api.getThreadDraft).toHaveBeenCalledTimes(1);
    sync.stop();
    api.emit(THREAD_ID);
    await Promise.resolve();
    expect(api.getThreadDraft).toHaveBeenCalledTimes(1);
  });
});
