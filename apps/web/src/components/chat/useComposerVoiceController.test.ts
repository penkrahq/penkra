// FILE: useComposerVoiceController.test.ts
// Purpose: Covers composer guards and thread-scoped projections of the global voice coordinator.
// Layer: Chat composer hook tests

import { ContainerId, ThreadId } from "@penkra/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const reactHarness = vi.hoisted(() => {
  interface HookSlot {
    deps?: readonly unknown[];
    cleanup?: () => void;
  }
  let slots: HookSlot[] = [];
  let cursor = 0;
  const depsEqual = (left: readonly unknown[] | undefined, right: readonly unknown[]) =>
    left !== undefined &&
    left.length === right.length &&
    left.every((value, index) => Object.is(value, right[index]));
  return {
    beginRender() {
      cursor = 0;
    },
    reset() {
      for (const slot of slots) slot.cleanup?.();
      slots = [];
      cursor = 0;
    },
    useEffect(effect: () => void | (() => void), deps: readonly unknown[]) {
      const index = cursor++;
      const slot = (slots[index] ??= {});
      if (depsEqual(slot.deps, deps)) return;
      slot.cleanup?.();
      slot.deps = deps;
      const cleanup = effect();
      if (cleanup) slot.cleanup = cleanup;
      else delete slot.cleanup;
    },
    useMemo<T>(factory: () => T, _deps: readonly unknown[]) {
      return factory();
    },
  };
});

const coordinator = vi.hoisted(() => {
  type RegisteredVoiceTranscriptConsumer = {
    readonly resolveTranscriptionBackend: () => unknown;
  };
  const state = {
    capture: {
      origin: {
        threadId: "thread-a",
        providerThreadId: "thread-a",
        cwd: "/workspace/project",
      },
      phase: "recording",
      startedAtMs: 0 as number | null,
      durationMs: 0,
      waveformLevels: [] as readonly number[],
    } as {
      origin: {
        threadId: string;
        providerThreadId: string | null;
        cwd: string;
      };
      phase: "starting" | "recording" | "stopping";
      startedAtMs: number | null;
      durationMs: number;
      waveformLevels: readonly number[];
    } | null,
    transcriptions: [] as Array<{
      jobId: string;
      threadId: string;
      phase: "transcribing";
    }>,
    nativeCapabilities: { appleSpeech: null as { locale: string } | null },
    nativeCapabilitiesReady: true,
  };
  const useStore = Object.assign(<T>(selector: (snapshot: typeof state) => T) => selector(state), {
    getState: () => state,
  });
  return {
    state,
    useStore,
    startRecording: vi.fn(),
    submitRecording: vi.fn(),
    cancelForThread: vi.fn(),
    registerTranscriptConsumer: vi.fn<(consumer: RegisteredVoiceTranscriptConsumer) => () => void>(
      () => () => undefined,
    ),
  };
});

const toast = vi.hoisted(() => ({ add: vi.fn() }));
vi.mock("react", () => ({ useEffect: reactHarness.useEffect, useMemo: reactHarness.useMemo }));
vi.mock("../../lib/voiceRecorder", () => ({ formatVoiceRecordingDuration: () => "0:00" }));
vi.mock("../../voiceSessionCoordinator", () => ({
  useVoiceSessionCoordinatorActions: () => ({
    startRecording: coordinator.startRecording,
    submitRecording: coordinator.submitRecording,
    cancelForThread: coordinator.cancelForThread,
    registerTranscriptConsumer: coordinator.registerTranscriptConsumer,
  }),
  useVoiceSessionCoordinatorStore: coordinator.useStore,
}));
vi.mock("../ui/toast", () => ({ toastManager: toast }));
vi.mock("../ChatView.logic", () => ({
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

describe("useComposerVoiceController", () => {
  let options: UseComposerVoiceControllerOptions;
  let result: UseComposerVoiceControllerResult;

  const render = (overrides: Partial<UseComposerVoiceControllerOptions> = {}) => {
    options = { ...options, ...overrides };
    reactHarness.beginRender();
    result = useComposerVoiceController(options);
    return result;
  };

  beforeEach(() => {
    reactHarness.reset();
    coordinator.state.capture = {
      origin: {
        threadId: "thread-a",
        providerThreadId: "thread-a",
        cwd: PROJECT.cwd,
      },
      phase: "recording",
      startedAtMs: 0,
      durationMs: 0,
      waveformLevels: [],
    };
    coordinator.state.transcriptions = [];
    coordinator.state.nativeCapabilities = { appleSpeech: null };
    coordinator.state.nativeCapabilitiesReady = true;
    coordinator.startRecording.mockReset().mockResolvedValue({ status: "started" });
    coordinator.submitRecording.mockReset().mockResolvedValue({
      status: "completed",
      jobId: "voice-job",
    });
    coordinator.cancelForThread.mockReset().mockResolvedValue(undefined);
    coordinator.registerTranscriptConsumer.mockClear();
    toast.add.mockReset();
    options = {
      activeProject: PROJECT,
      activeThreadId: THREAD_A,
      threadId: THREAD_A,
      connectionId: "connection-codex" as never,
      pendingUserInputCount: 0,
      onTranscriptReady: vi.fn(),
      refreshVoiceStatus: vi.fn(),
    };
    render();
  });

  it("projects recording and transcription state only onto their owner thread", () => {
    expect(result.isVoiceRecording).toBe(true);
    expect(result.isVoiceTranscribing).toBe(false);

    coordinator.state.capture = null;
    coordinator.state.transcriptions = [
      { jobId: "voice-job", threadId: "thread-a", phase: "transcribing" },
    ];
    render();
    expect(result.isVoiceRecording).toBe(false);
    expect(result.isVoiceTranscribing).toBe(true);

    render({ activeThreadId: THREAD_B, threadId: THREAD_B });
    expect(result.isVoiceRecording).toBe(false);
    expect(result.isVoiceTranscribing).toBe(false);
  });

  it("projects stopping as processing without dropping the final waveform", () => {
    coordinator.state.capture = {
      ...coordinator.state.capture!,
      phase: "stopping",
      durationMs: 1_250,
      waveformLevels: [0.2, 0.8],
    };
    render();

    expect(result.isVoiceRecording).toBe(false);
    expect(result.isVoiceTranscribing).toBe(true);
    expect(result.voiceWaveformLevels).toEqual([0.2, 0.8]);
  });

  it("blocks another thread's microphone while capture belongs to the origin thread", async () => {
    render({ activeThreadId: THREAD_B, threadId: THREAD_B });
    await result.startComposerVoiceRecording();

    expect(coordinator.startRecording).not.toHaveBeenCalled();
    expect(toast.add).toHaveBeenCalledWith({
      type: "info",
      title: "Voice recording is active in another thread",
    });
  });

  it("starts capture without persisting the selected backend", async () => {
    coordinator.state.capture = null;
    render();
    await result.startComposerVoiceRecording();

    expect(coordinator.startRecording).toHaveBeenCalledWith({
      threadId: THREAD_A,
      providerThreadId: THREAD_A,
      cwd: PROJECT.cwd,
    });
  });

  it("resolves Codex first when native speech is also available", async () => {
    coordinator.state.capture = null;
    coordinator.state.nativeCapabilities = { appleSpeech: { locale: "en-US" } };
    render();
    await result.startComposerVoiceRecording();

    const consumer = coordinator.registerTranscriptConsumer.mock.calls.at(-1)?.[0];
    expect(consumer?.resolveTranscriptionBackend()).toEqual({
      kind: "codex-chatgpt",
      connectionId: "connection-codex",
    });
  });

  it("resolves Apple when no Codex connection is available", async () => {
    coordinator.state.capture = null;
    coordinator.state.nativeCapabilities = { appleSpeech: { locale: "en-US" } };
    render({ connectionId: undefined });
    await result.startComposerVoiceRecording();

    const consumer = coordinator.registerTranscriptConsumer.mock.calls.at(-1)?.[0];
    expect(consumer?.resolveTranscriptionBackend()).toEqual({
      kind: "apple-speech",
      locale: "en-US",
    });
  });

  it("does not expose a backend before native capability discovery finishes", () => {
    coordinator.state.capture = null;
    coordinator.state.nativeCapabilitiesReady = false;
    render({ connectionId: undefined });

    expect(result.showVoiceNotesControl).toBe(false);
  });

  it("exposes Codex without waiting for native capability discovery", () => {
    coordinator.state.capture = null;
    coordinator.state.nativeCapabilitiesReady = false;
    render();

    expect(result.showVoiceNotesControl).toBe(true);
  });

  it("submits and cancels through the coordinator", async () => {
    await result.submitComposerVoiceRecording();
    result.cancelComposerVoiceRecording();

    expect(coordinator.submitRecording).toHaveBeenCalledTimes(1);
    expect(coordinator.cancelForThread).toHaveBeenCalledWith(THREAD_A);
  });

  it("registers the composer as a transcript delivery consumer", () => {
    expect(coordinator.registerTranscriptConsumer).toHaveBeenCalledWith(
      expect.objectContaining({ onTranscriptReady: options.onTranscriptReady }),
    );
  });
});
