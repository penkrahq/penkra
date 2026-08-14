// FILE: VoiceSessionCoordinator.browser.tsx
// Purpose: Verifies app-wide voice ownership survives composer consumer changes.

import { ProviderConnectionId, ThreadId } from "@penkra/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const recorder = vi.hoisted(() => ({
  start: vi.fn(),
  stop: vi.fn(),
  cancel: vi.fn(),
}));
const jobs = vi.hoisted(() => ({
  persist: vi.fn(),
  list: vi.fn(),
  delete: vi.fn(),
}));
const nativeApi = vi.hoisted(() => ({ transcribeVoice: vi.fn() }));

vi.mock("../../lib/voiceRecorder", () => ({
  serializeCapturedVoiceRecording: (recording: unknown) => Promise.resolve(recording),
  useVoiceRecorder: () => ({
    isRecording: false,
    durationMs: 0,
    waveformLevels: [],
    startRecording: recorder.start,
    stopRecording: recorder.stop,
    cancelRecording: recorder.cancel,
  }),
}));
vi.mock("../../lib/voiceTranscriptionJobStore", () => ({
  persistVoiceTranscriptionJob: jobs.persist,
  listVoiceTranscriptionJobs: jobs.list,
  deleteVoiceTranscriptionJob: jobs.delete,
}));
vi.mock("../../lib/voiceTranscriptionSequence", () => ({
  transcribeVoiceRecording: async (input: {
    isCurrent: () => boolean;
    transcribeChunk: (chunk: {
      audioBase64: string;
      mimeType: "audio/wav";
      sampleRateHz: number;
    }) => Promise<{ text: string }>;
  }) => {
    if (!input.isCurrent()) return "";
    const result = await input.transcribeChunk({
      audioBase64: "audio",
      mimeType: "audio/wav",
      sampleRateHz: 24_000,
    });
    return input.isCurrent() ? result.text : "";
  },
}));
vi.mock("../../nativeApi", () => ({
  readNativeApi: () => ({ server: { transcribeVoice: nativeApi.transcribeVoice } }),
}));

import {
  VoiceSessionCoordinatorProvider,
  useVoiceSessionCoordinatorActions,
  useVoiceSessionCoordinatorStore,
} from "../../voiceSessionCoordinator";

type CoordinatorActions = ReturnType<typeof useVoiceSessionCoordinatorActions>;
let actions: CoordinatorActions;

function CoordinatorProbe() {
  actions = useVoiceSessionCoordinatorActions();
  return null;
}

const ORIGIN = {
  threadId: ThreadId.makeUnsafe("thread-a"),
  providerThreadId: ThreadId.makeUnsafe("provider-thread-a"),
  cwd: "/workspace/project",
};
const TRANSCRIPTION_BACKEND = {
  kind: "codex-chatgpt" as const,
  connectionId: ProviderConnectionId.makeUnsafe("connection-codex"),
};
const RECORDING = {
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

describe("VoiceSessionCoordinatorProvider", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  beforeEach(() => {
    recorder.start.mockReset().mockResolvedValue(undefined);
    recorder.stop.mockReset().mockResolvedValue(RECORDING);
    recorder.cancel.mockReset().mockResolvedValue(undefined);
    jobs.persist.mockReset().mockResolvedValue(undefined);
    jobs.list.mockReset().mockResolvedValue([]);
    jobs.delete.mockReset().mockResolvedValue(undefined);
    nativeApi.transcribeVoice.mockReset().mockResolvedValue({ text: "Owned transcript" });
  });

  it("keeps transcription owned by its origin while no composer consumer is mounted", async () => {
    await render(
      <VoiceSessionCoordinatorProvider>
        <CoordinatorProbe />
      </VoiceSessionCoordinatorProvider>,
    );
    const unregisterInitialConsumer = actions.registerTranscriptConsumer({
      resolveTranscriptionBackend: () => TRANSCRIPTION_BACKEND,
      onTranscriptReady: vi.fn(),
    });
    await actions.startRecording(ORIGIN);
    unregisterInitialConsumer();

    const submission = actions.submitRecording();
    await vi.waitFor(() =>
      expect(useVoiceSessionCoordinatorStore.getState().transcriptions).toEqual([
        expect.objectContaining({ threadId: ORIGIN.threadId, phase: "transcribing" }),
      ]),
    );

    const secondOrigin = { ...ORIGIN, threadId: ThreadId.makeUnsafe("thread-b") };
    expect(await actions.startRecording(secondOrigin)).toEqual({ status: "started" });
    expect(useVoiceSessionCoordinatorStore.getState().capture?.origin).toEqual(secondOrigin);

    const onTranscriptReady = vi.fn().mockResolvedValue(undefined);
    actions.registerTranscriptConsumer({
      resolveTranscriptionBackend: () => TRANSCRIPTION_BACKEND,
      onTranscriptReady,
    });
    await submission;

    expect(onTranscriptReady).toHaveBeenCalledWith(
      ORIGIN.threadId,
      "Owned transcript",
      expect.any(String),
    );
    expect(jobs.delete).toHaveBeenCalledTimes(1);
    expect(useVoiceSessionCoordinatorStore.getState().transcriptions).toEqual([]);
    await actions.cancelForThread(secondOrigin.threadId);
  });

  it("keeps the microphone capture bound to its first thread", async () => {
    await render(
      <VoiceSessionCoordinatorProvider>
        <CoordinatorProbe />
      </VoiceSessionCoordinatorProvider>,
    );

    expect(await actions.startRecording(ORIGIN)).toEqual({ status: "started" });
    expect(
      await actions.startRecording({ ...ORIGIN, threadId: ThreadId.makeUnsafe("thread-b") }),
    ).toEqual({ status: "busy", origin: ORIGIN });
    expect(recorder.start).toHaveBeenCalledTimes(1);
  });

  it("hands stopping capture directly to transcription without an idle snapshot", async () => {
    let releasePersistence!: () => void;
    let finishTranscription!: (result: { text: string }) => void;
    jobs.persist.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releasePersistence = resolve;
        }),
    );
    nativeApi.transcribeVoice.mockImplementationOnce(
      () =>
        new Promise<{ text: string }>((resolve) => {
          finishTranscription = resolve;
        }),
    );
    await render(
      <VoiceSessionCoordinatorProvider>
        <CoordinatorProbe />
      </VoiceSessionCoordinatorProvider>,
    );
    actions.registerTranscriptConsumer({
      resolveTranscriptionBackend: () => TRANSCRIPTION_BACKEND,
      onTranscriptReady: vi.fn(),
    });
    await actions.startRecording(ORIGIN);

    const idleSnapshots: string[] = [];
    const unsubscribe = useVoiceSessionCoordinatorStore.subscribe((state) => {
      if (state.capture === null && state.transcriptions.length === 0) {
        idleSnapshots.push("idle");
      }
    });
    const submission = actions.submitRecording();
    await vi.waitFor(() =>
      expect(useVoiceSessionCoordinatorStore.getState().capture?.phase).toBe("stopping"),
    );

    releasePersistence();
    await vi.waitFor(() => {
      const state = useVoiceSessionCoordinatorStore.getState();
      expect(state.capture).toBeNull();
      expect(state.transcriptions).toEqual([
        expect.objectContaining({ threadId: ORIGIN.threadId, phase: "transcribing" }),
      ]);
    });
    expect(idleSnapshots).toEqual([]);

    finishTranscription({ text: "Owned transcript" });
    await submission;
    unsubscribe();
  });

  it("silently deletes a recovered recording when no speech is detected", async () => {
    jobs.list.mockResolvedValueOnce([
      {
        id: "silent-job",
        threadId: ORIGIN.threadId,
        providerThreadId: ORIGIN.providerThreadId,
        cwd: ORIGIN.cwd,
        recording: RECORDING,
        createdAt: "2026-08-13T00:00:00.000Z",
        updatedAt: "2026-08-13T00:00:00.000Z",
      },
    ]);
    nativeApi.transcribeVoice.mockResolvedValueOnce({ text: "" });
    await render(
      <VoiceSessionCoordinatorProvider>
        <CoordinatorProbe />
      </VoiceSessionCoordinatorProvider>,
    );
    const onTranscriptReady = vi.fn();
    const onRecoveredTranscriptionFailure = vi.fn();

    actions.registerTranscriptConsumer({
      resolveTranscriptionBackend: () => TRANSCRIPTION_BACKEND,
      onTranscriptReady,
      onRecoveredTranscriptionFailure,
    });

    await vi.waitFor(() => expect(jobs.delete).toHaveBeenCalledWith("silent-job"));
    expect(onTranscriptReady).not.toHaveBeenCalled();
    expect(onRecoveredTranscriptionFailure).not.toHaveBeenCalled();
  });

  it("deletes a recovered recording after a terminal transcription failure", async () => {
    jobs.list.mockResolvedValueOnce([
      {
        id: "failed-job",
        threadId: ORIGIN.threadId,
        providerThreadId: ORIGIN.providerThreadId,
        cwd: ORIGIN.cwd,
        recording: RECORDING,
        createdAt: "2026-08-13T00:00:00.000Z",
        updatedAt: "2026-08-13T00:00:00.000Z",
      },
    ]);
    nativeApi.transcribeVoice.mockRejectedValueOnce(new Error("transcription unavailable"));
    await render(
      <VoiceSessionCoordinatorProvider>
        <CoordinatorProbe />
      </VoiceSessionCoordinatorProvider>,
    );
    const onRecoveredTranscriptionFailure = vi.fn();

    actions.registerTranscriptConsumer({
      resolveTranscriptionBackend: () => TRANSCRIPTION_BACKEND,
      onTranscriptReady: vi.fn(),
      onRecoveredTranscriptionFailure,
    });

    await vi.waitFor(() => expect(jobs.delete).toHaveBeenCalledWith("failed-job"));
    expect(onRecoveredTranscriptionFailure).toHaveBeenCalledWith(
      expect.objectContaining({ message: "transcription unavailable" }),
    );
  });
});
