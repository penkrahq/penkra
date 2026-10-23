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
  it("keeps a newer edit when the preceding save fails", async () => {
    const api = makeApi({ draft: null, updatedAt: null });
    const sync = createComposerDraftSync({
      api,
      threadId: THREAD_ID,
      applyServerDraft: vi.fn(),
      serialize,
      deserialize,
    });
    await sync.start();
    let rejectWrite!: (error: Error) => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const save = api.setThreadDraft;
    api.setThreadDraft = vi.fn(() => {
      entered();
      return new Promise<Awaited<ReturnType<ComposerDraftSyncApi["setThreadDraft"]>>>(
        (_, reject) => {
          rejectWrite = reject;
        },
      );
    });
    sync.setLocalDraft({ ...createEmptyThreadDraft(), prompt: "first" });
    const writing = sync.flush();
    await started;
    sync.setLocalDraft({ ...createEmptyThreadDraft(), prompt: "second" });
    rejectWrite(new Error("Connection lost"));
    await expect(writing).rejects.toThrow("Connection lost");
    api.setThreadDraft = save;
    await sync.flush();
    expect(JSON.parse(api.current().draft!).prompt).toBe("second");
    sync.stop();
  });
  it("retains a failed clear and retries it with an explicit flush", async () => {
    const api = makeApi({
      draft: JSON.stringify({ prompt: "old text" }),
      updatedAt: "2026-10-23T00:00:00.000Z",
    });
    const sync = createComposerDraftSync({
      api,
      threadId: THREAD_ID,
      applyServerDraft: vi.fn(),
      serialize,
      deserialize,
    });
    await sync.start();
    const save = api.setThreadDraft;
    api.setThreadDraft = vi.fn(async () => {
      throw new Error("Connection lost");
    });
    sync.setLocalDraft(createEmptyThreadDraft());
    await expect(sync.flush()).rejects.toThrow("Connection lost");
    expect(JSON.parse(api.current().draft!).prompt).toBe("old text");
    api.setThreadDraft = vi.fn(save);
    await sync.flush();
    expect(api.current().draft).toBeNull();
    expect(api.setThreadDraft).toHaveBeenCalledTimes(1);
    sync.stop();
  });

  it("does not mistake a rejected stale write for a saved clear", async () => {
    const api = makeApi({
      draft: JSON.stringify({ prompt: "old text" }),
      updatedAt: "2026-10-23T00:00:00.000Z",
    });
    const applyServerDraft = vi.fn();
    const sync = createComposerDraftSync({
      api,
      threadId: THREAD_ID,
      applyServerDraft,
      serialize,
      deserialize,
    });
    await sync.start();
    api.setThreadDraft = vi.fn(async () => ({
      draft: JSON.stringify({ prompt: "other window" }),
      draftUpdatedAt: "2026-10-23T01:00:00.000Z",
    }));
    sync.setLocalDraft(createEmptyThreadDraft());
    await expect(sync.flush()).rejects.toThrow("The draft changed");
    expect(applyServerDraft).toHaveBeenLastCalledWith(
      expect.objectContaining({ prompt: "other window" }),
    );
    await sync.flush();
    expect(api.setThreadDraft).toHaveBeenCalledTimes(1);
    sync.stop();
  });
  it("a second flush waits for a draft write already in flight", async () => {
    const api = makeApi({ draft: null, updatedAt: null });
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const write = api.setThreadDraft;
    api.setThreadDraft = async (input) => {
      entered();
      await held;
      return write(input);
    };
    const sync = createComposerDraftSync({
      api,
      threadId: THREAD_ID,
      applyServerDraft: vi.fn(),
      serialize,
      deserialize,
      now: () => "2026-10-20T12:00:00.000Z",
    });
    await sync.start();
    sync.setLocalDraft({ ...createEmptyThreadDraft(), prompt: "Save this" });
    const first = sync.flush();
    await started;
    let settled = false;
    const second = sync.flush().then(() => {
      settled = true;
    });
    // Drain independent promise jobs, not a timer or polling loop.
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    await Promise.all([first, second]);
    expect(sync.draftUpdatedAt()).toBe("2026-10-20T12:00:00.000Z");
    sync.stop();
  });
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

it("applies a committed null draft as a clear", async () => {
  const api = makeApi({
    draft: JSON.stringify({ prompt: "before clear" }),
    updatedAt: "2026-10-12T00:00:00.000Z",
  });
  const applied = vi.fn();
  const sync = createComposerDraftSync({
    api,
    threadId: THREAD_ID,
    applyServerDraft: applied,
    serialize,
    deserialize,
  });
  await sync.start();
  await api.setThreadDraft({
    threadId: THREAD_ID,
    draft: null,
    updatedAt: "2026-10-12T00:00:00.001Z",
  });
  await sync.start();
  expect(applied).toHaveBeenLastCalledWith(
    expect.objectContaining({ prompt: "", images: [], files: [] }),
  );
  sync.stop();
});
it("does not let an older decoding draft overwrite a newer restoration", async () => {
  let releaseOld!: () => void, enteredOld!: () => void, restored!: () => void;
  const oldGate = new Promise<void>((resolve) => {
    releaseOld = resolve;
  });
  const oldEntered = new Promise<void>((resolve) => {
    enteredOld = resolve;
  });
  const restorationApplied = new Promise<void>((resolve) => {
    restored = resolve;
  });
  const api = makeApi({
    draft: JSON.stringify({ prompt: "old" }),
    updatedAt: "2026-10-12T00:00:00.000Z",
  });
  const applied: string[] = [];
  const sync = createComposerDraftSync({
    api,
    threadId: THREAD_ID,
    serialize,
    deserialize: async (id, payload) => {
      if (JSON.parse(payload).prompt === "old") {
        enteredOld();
        await oldGate;
      }
      return deserialize(id, payload);
    },
    applyServerDraft: (draft) => {
      applied.push(draft.prompt);
      if (draft.prompt === "restored") restored();
    },
  });
  const oldRead = sync.start();
  await oldEntered;
  await api.setThreadDraft({
    threadId: THREAD_ID,
    draft: JSON.stringify({ prompt: "restored" }),
    updatedAt: "2026-10-12T00:00:00.001Z",
  });
  api.emit(THREAD_ID);
  await restorationApplied;
  releaseOld();
  await oldRead;
  expect(applied).toEqual(["restored"]);
  sync.stop();
});

it("saves newer local input before applying a remote admission clear", async () => {
  const api = makeApi({
    draft: JSON.stringify({ prompt: "submitted" }),
    updatedAt: "2026-10-12T00:00:00.000Z",
  });
  const applyServerDraft = vi.fn();
  const sync = createComposerDraftSync({
    api,
    threadId: THREAD_ID,
    applyServerDraft,
    serialize,
    deserialize,
    now: () => "2026-10-12T00:00:01.000Z",
  });
  await sync.start();
  sync.setLocalDraft({ ...createEmptyThreadDraft(), prompt: "newer" });
  await api.setThreadDraft({
    threadId: THREAD_ID,
    draft: null,
    updatedAt: "2026-10-12T00:00:00.001Z",
  });
  await sync.start();
  expect(JSON.parse(api.current().draft!).prompt).toBe("newer");
  expect(applyServerDraft.mock.calls.map(([draft]) => draft.prompt)).not.toContain("");
  sync.stop();
});

it("does not apply an earlier read over input composed while that read is pending", async () => {
  const api = makeApi({
    draft: JSON.stringify({ prompt: "old server text" }),
    updatedAt: "2026-10-12T00:00:00.000Z",
  });
  let releaseRead!: (value: Awaited<ReturnType<ComposerDraftSyncApi["getThreadDraft"]>>) => void;
  api.getThreadDraft = vi.fn(
    () =>
      new Promise<Awaited<ReturnType<ComposerDraftSyncApi["getThreadDraft"]>>>((resolve) => {
        releaseRead = resolve;
      }),
  );
  const applyServerDraft = vi.fn();
  const sync = createComposerDraftSync({
    api,
    threadId: THREAD_ID,
    applyServerDraft,
    serialize,
    deserialize,
    now: () => "2026-10-12T00:00:01.000Z",
  });
  const loading = sync.start();
  sync.setLocalDraft({ ...createEmptyThreadDraft(), prompt: "newer editor input" });
  releaseRead({
    draft: JSON.stringify({ prompt: "old server text" }),
    draftUpdatedAt: "2026-10-12T00:00:00.000Z",
  });
  await loading;
  expect(applyServerDraft).not.toHaveBeenCalled();
  expect(JSON.parse(api.current().draft!).prompt).toBe("newer editor input");
  sync.stop();
});
