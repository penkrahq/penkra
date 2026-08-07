// FILE: useComposerVoiceController.test.ts
// Purpose: Covers voice transcription request identity and recorder action guards.
// Layer: Chat composer hook tests

import { ContainerId, ThreadId, type ProviderKind } from "@penkra/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const reactHarness = vi.hoisted(() => {
  interface HookSlot {
    value?: unknown;
    deps?: readonly unknown[];
  }

  let slots: HookSlot[] = [];
  let cursor = 0;

  const nextSlot = () => {
    const index = cursor;
    cursor += 1;
    slots[index] ??= {};
    return slots[index]!;
  };
  const depsEqual = (left: readonly unknown[] | undefined, right: readonly unknown[]) =>
    left !== undefined &&
    left.length === right.length &&
    left.every((value, index) => Object.is(value, right[index]));
  const runEffect = (effect: () => void | (() => void), deps: readonly unknown[]) => {
    const slot = nextSlot();
    if (depsEqual(slot.deps, deps)) {
      return;
    }
    slot.deps = deps;
    effect();
  };

  return {
    beginRender() {
      cursor = 0;
    },
    reset() {
      slots = [];
      cursor = 0;
    },
    useEffect: runEffect,
    useLayoutEffect: runEffect,
    useRef<T>(initialValue: T) {
      const slot = nextSlot();
      slot.value ??= { current: initialValue };
      return slot.value as { current: T };
    },
    useState<T>(initialValue: T) {
      const slot = nextSlot();
      if (!("value" in slot)) {
        slot.value = initialValue;
      }
      const setValue = (next: T | ((current: T) => T)) => {
        slot.value =
          typeof next === "function" ? (next as (current: T) => T)(slot.value as T) : next;
      };
      return [slot.value as T, setValue] as const;
    },
  };
});

const recorder = vi.hoisted(() => ({
  isRecording: true,
  startRecording: vi.fn(),
  stopRecording: vi.fn(),
  cancelRecording: vi.fn<() => Promise<void>>(),
}));

const voiceSession = vi.hoisted(() => {
  const state = {
    origin: {
      threadId: "thread-a",
      providerThreadId: "thread-a",
      cwd: "/workspace/project",
    } as {
      threadId: string;
      providerThreadId: string | null;
      cwd: string;
    } | null,
    phase: "recording",
    isRecording: true,
    startedAtMs: 0 as number | null,
    durationMs: 0,
    waveformLevels: [] as readonly number[],
  };
  const useStore = Object.assign(<T>(selector: (snapshot: typeof state) => T) => selector(state), {
    getState: () => state,
  });
  return { state, useStore };
});

const nativeApi = vi.hoisted(() => ({
  transcribeVoice: vi.fn(),
  available: true,
}));

const toast = vi.hoisted(() => ({ add: vi.fn() }));
const voiceAvailability = vi.hoisted(() => ({
  canStartVoiceNotes: true,
  showVoiceNotesControl: true,
}));
const voiceJobStore = vi.hoisted(() => ({
  persist: vi.fn(),
  list: vi.fn(),
  delete: vi.fn(),
}));

vi.mock("react", () => ({
  useEffect: reactHarness.useEffect,
  useLayoutEffect: reactHarness.useLayoutEffect,
  useRef: reactHarness.useRef,
  useState: reactHarness.useState,
}));

vi.mock("../../lib/voiceRecorder", () => ({
  formatVoiceRecordingDuration: () => "0:00",
  serializeCapturedVoiceRecording: (recording: unknown) => Promise.resolve(recording),
}));

vi.mock("../../voiceRecordingSession", () => ({
  useVoiceRecordingSessionActions: () => ({
    startRecording: recorder.startRecording,
    stopRecording: recorder.stopRecording,
    cancelRecording: recorder.cancelRecording,
  }),
  useVoiceRecordingSessionStore: voiceSession.useStore,
}));

vi.mock("../../nativeApi", () => ({
  readNativeApi: () =>
    nativeApi.available
      ? {
          server: {
            transcribeVoice: nativeApi.transcribeVoice,
          },
        }
      : null,
}));

vi.mock("../../lib/voiceTranscriptionJobStore", () => ({
  persistVoiceTranscriptionJob: voiceJobStore.persist,
  listVoiceTranscriptionJobs: voiceJobStore.list,
  deleteVoiceTranscriptionJob: voiceJobStore.delete,
}));

vi.mock("../ui/toast", () => ({ toastManager: toast }));

vi.mock("../ChatView.logic", () => ({
  deriveComposerVoiceState: () => ({ ...voiceAvailability }),
  describeVoiceRecordingStartError: (error: unknown) => String(error),
  isVoiceAuthExpiredMessage: (message: string) => message.includes("expired"),
  sanitizeVoiceErrorMessage: (message: string) => message,
}));

import type { Project } from "../../types";
import {
  useComposerVoiceController,
  type UseComposerVoiceControllerOptions,
  type UseComposerVoiceControllerResult,
} from "./useComposerVoiceController";

const THREAD_A = ThreadId.makeUnsafe("thread-a");
const THREAD_B = ThreadId.makeUnsafe("thread-b");
const PROJECT: Project = {
  id: ContainerId.makeUnsafe("project-a"),
  kind: "project",
  name: "Project",
  remoteName: "Project",
  folderName: "project",
  localName: null,
  cwd: "/workspace/project",
  defaultModelSelection: null,
  expanded: true,
  scripts: [],
};
const AUDIO_PAYLOAD = {
  chunks: [
    {
      audioBase64: "audio",
      mimeType: "audio/wav" as const,
      sampleRateHz: 24_000,
      durationMs: 500,
    },
  ],
  durationMs: 500,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("useComposerVoiceController", () => {
  let options: UseComposerVoiceControllerOptions;
  let result: UseComposerVoiceControllerResult;

  const render = (overrides: Partial<UseComposerVoiceControllerOptions> = {}) => {
    options = { ...options, ...overrides };
    reactHarness.beginRender();
    result = useComposerVoiceController(options);
    return result;
  };

  beforeEach(async () => {
    reactHarness.reset();
    recorder.isRecording = true;
    voiceSession.state.origin = {
      threadId: "thread-a",
      providerThreadId: "thread-a",
      cwd: PROJECT.cwd,
    };
    voiceSession.state.phase = "recording";
    voiceSession.state.isRecording = true;
    voiceSession.state.startedAtMs = 0;
    voiceSession.state.durationMs = 0;
    voiceSession.state.waveformLevels = [];
    recorder.startRecording.mockReset().mockImplementation(async (origin) => {
      voiceSession.state.origin = origin;
      voiceSession.state.phase = "recording";
      voiceSession.state.isRecording = true;
      voiceSession.state.startedAtMs = performance.now();
      return { status: "started" as const };
    });
    recorder.stopRecording.mockReset().mockResolvedValue(AUDIO_PAYLOAD);
    recorder.cancelRecording.mockReset().mockResolvedValue(undefined);
    nativeApi.transcribeVoice.mockReset().mockResolvedValue({ text: "transcribed once" });
    nativeApi.available = true;
    voiceAvailability.canStartVoiceNotes = true;
    voiceAvailability.showVoiceNotesControl = true;
    voiceJobStore.persist.mockReset().mockResolvedValue(undefined);
    voiceJobStore.list.mockReset().mockResolvedValue([]);
    voiceJobStore.delete.mockReset().mockResolvedValue(undefined);
    toast.add.mockReset();
    options = {
      activeProject: PROJECT,
      activeThreadId: THREAD_A,
      threadId: THREAD_A,
      selectedProvider: "codex",
      activeProviderStatus: null,
      pendingUserInputCount: 0,
      onTranscriptReady: vi.fn(),
      refreshVoiceStatus: vi.fn(),
    };
    render();
    await Promise.resolve();
    recorder.cancelRecording.mockClear();
  });

  it("applies a successful transcription exactly once", async () => {
    await result.submitComposerVoiceRecording();

    expect(options.onTranscriptReady).toHaveBeenCalledTimes(1);
    expect(options.onTranscriptReady).toHaveBeenCalledWith(
      THREAD_A,
      "transcribed once",
      expect.any(String),
    );
    expect(voiceJobStore.persist).toHaveBeenCalledTimes(1);
    expect(voiceJobStore.delete).toHaveBeenCalledTimes(1);
  });

  it("recovers a saved recording after the composer remounts", async () => {
    const recoveredJob = {
      id: "saved-voice-job",
      threadId: THREAD_A,
      providerThreadId: THREAD_A,
      cwd: PROJECT.cwd,
      recording: AUDIO_PAYLOAD,
      createdAt: "2026-08-03T01:00:00.000Z",
      updatedAt: "2026-08-03T01:00:00.000Z",
    };
    voiceJobStore.list.mockResolvedValueOnce([recoveredJob]);
    const onTranscriptReady = vi.fn();

    reactHarness.reset();
    render({ onTranscriptReady });

    await vi.waitFor(() => expect(onTranscriptReady).toHaveBeenCalledTimes(1));
    expect(onTranscriptReady).toHaveBeenCalledWith(THREAD_A, "transcribed once", "saved-voice-job");
    expect(voiceJobStore.delete).toHaveBeenCalledWith("saved-voice-job");
  });

  it("transcribes rolling chunks in order and applies one merged result", async () => {
    recorder.stopRecording.mockResolvedValueOnce({
      chunks: [
        { ...AUDIO_PAYLOAD.chunks[0], audioBase64: "first" },
        { ...AUDIO_PAYLOAD.chunks[0], audioBase64: "second" },
      ],
      durationMs: 130_000,
    });
    nativeApi.transcribeVoice
      .mockResolvedValueOnce({ text: "A sentence crosses the boundary." })
      .mockResolvedValueOnce({ text: "crosses the boundary. Then it continues." });

    await result.submitComposerVoiceRecording();

    expect(nativeApi.transcribeVoice.mock.calls.map(([input]) => input.audioBase64)).toEqual([
      "first",
      "second",
    ]);
    expect(options.onTranscriptReady).toHaveBeenCalledWith(
      THREAD_A,
      "A sentence crosses the boundary. Then it continues.",
      expect.any(String),
    );
  });

  it.each(["thread", "provider"] as const)(
    "keeps transcription bound to its originating thread after %s changes",
    async (navigationCause) => {
      const transcription = deferred<{ text: string }>();
      nativeApi.transcribeVoice.mockReturnValueOnce(transcription.promise);

      const submission = result.submitComposerVoiceRecording();
      await vi.waitFor(() => expect(nativeApi.transcribeVoice).toHaveBeenCalledTimes(1));

      if (navigationCause === "thread") {
        expect(result.isVoiceRecording).toBe(true);
        render({ activeThreadId: THREAD_B, threadId: THREAD_B });
        expect(result.isVoiceRecording).toBe(false);
      } else {
        render({ selectedProvider: "claudeAgent" as ProviderKind });
      }

      transcription.resolve({ text: "kept" });
      await submission;

      expect(options.onTranscriptReady).toHaveBeenCalledWith(THREAD_A, "kept", expect.any(String));
    },
  );

  it("keeps a cancelled transcription saved without applying it", async () => {
    const transcription = deferred<{ text: string }>();
    nativeApi.transcribeVoice.mockReturnValueOnce(transcription.promise);

    const submission = result.submitComposerVoiceRecording();
    await vi.waitFor(() => expect(nativeApi.transcribeVoice).toHaveBeenCalledTimes(1));
    result.cancelComposerVoiceRecording();
    transcription.resolve({ text: "cancelled" });
    await submission;

    expect(options.onTranscriptReady).not.toHaveBeenCalled();
    expect(voiceJobStore.delete).not.toHaveBeenCalled();
  });

  it("blocks submit and cancel until the configured action-arm delay elapses", async () => {
    let now = 1_000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    recorder.isRecording = false;
    voiceSession.state.origin = null;
    voiceSession.state.phase = "idle";
    voiceSession.state.isRecording = false;
    voiceSession.state.startedAtMs = null;
    render({ actionArmDelayMs: 250, onGuardWarning: vi.fn() });

    await result.startComposerVoiceRecording();
    recorder.isRecording = true;
    voiceSession.state.isRecording = true;
    render();
    recorder.cancelRecording.mockClear();
    now = 1_100;

    await result.submitComposerVoiceRecording();
    result.cancelComposerVoiceRecording();

    expect(recorder.stopRecording).not.toHaveBeenCalled();
    expect(recorder.cancelRecording).not.toHaveBeenCalled();
    expect(options.onGuardWarning).toHaveBeenCalledTimes(2);
  });

  it("keeps the recording UI on the origin thread and blocks another thread's microphone", async () => {
    render({ activeThreadId: THREAD_B, threadId: THREAD_B });

    expect(result.isVoiceRecording).toBe(false);
    await result.startComposerVoiceRecording();

    expect(recorder.startRecording).not.toHaveBeenCalled();
    expect(toast.add).toHaveBeenCalledWith({
      type: "info",
      title: "Voice recording is active in another thread",
    });
  });

  it("supports ChatView-specific transcription failure copy without changing defaults", async () => {
    nativeApi.transcribeVoice.mockRejectedValue(new Error("network failed"));
    render({
      failureCopy: {
        transcriptionFailedTitle: "Couldn't transcribe voice note",
      },
    });

    await result.submitComposerVoiceRecording();

    expect(toast.add).toHaveBeenCalledWith({
      type: "error",
      title: "Couldn't transcribe voice note",
      description:
        "network failed Your voice note is saved and will be retried next time Penkra opens.",
    });
  });

  it("refreshes status for expired auth and keeps the refresh action available", async () => {
    nativeApi.transcribeVoice.mockRejectedValue(new Error("session expired"));

    await result.submitComposerVoiceRecording();

    expect(options.refreshVoiceStatus).toHaveBeenCalledTimes(1);
    const failureToast = toast.add.mock.calls.at(-1)?.[0];
    expect(failureToast).toMatchObject({
      title: "Sign in to ChatGPT again",
      actionProps: { children: "Refresh status" },
    });
    failureToast?.actionProps?.onClick();
    expect(options.refreshVoiceStatus).toHaveBeenCalledTimes(2);
  });

  it("does not discard a durable voice note when provider availability changes", async () => {
    const transcription = deferred<{ text: string }>();
    nativeApi.transcribeVoice.mockReturnValueOnce(transcription.promise);

    const submission = result.submitComposerVoiceRecording();
    await vi.waitFor(() => expect(nativeApi.transcribeVoice).toHaveBeenCalledTimes(1));

    voiceAvailability.canStartVoiceNotes = false;
    render({
      activeProviderStatus: {
        provider: "codex",
        status: "error",
        available: false,
        authStatus: "unauthenticated",
        voiceTranscriptionAvailable: false,
        checkedAt: "2026-07-20T00:00:00.000Z",
      },
    });
    expect(recorder.cancelRecording).not.toHaveBeenCalled();

    transcription.resolve({ text: "kept after availability loss" });
    await submission;
    expect(options.onTranscriptReady).toHaveBeenCalledWith(
      THREAD_A,
      "kept after availability loss",
      expect.any(String),
    );
  });
});
