// FILE: voiceSessionCoordinator.tsx
// Purpose: Own app-wide voice capture and thread-owned transcription lifecycles.
// Layer: Cross-cutting voice runtime

import type {
  DesktopVoiceTranscriptionCapabilities,
  ThreadId,
  VoiceTranscriptionBackend,
} from "@penkra/contracts";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import { create } from "zustand";

import {
  serializeCapturedVoiceRecording,
  useVoiceRecorder,
  type VoiceRecordingOrigin,
} from "./lib/voiceRecorder";
import { transcribeVoiceRecording } from "./lib/voiceTranscriptionSequence";
import {
  deleteVoiceTranscriptionJob,
  listVoiceTranscriptionJobs,
  persistVoiceTranscriptionJob,
  type VoiceTranscriptionJob,
} from "./lib/voiceTranscriptionJobStore";
import { readNativeApi } from "./nativeApi";

export interface VoiceSessionOrigin {
  readonly threadId: ThreadId;
  readonly providerThreadId: ThreadId | null;
  readonly transcriptionBackend: VoiceTranscriptionBackend;
  readonly cwd: string;
}

export type VoiceCapturePhase = "starting" | "recording" | "stopping";

export interface VoiceCaptureSession {
  readonly origin: VoiceSessionOrigin;
  readonly phase: VoiceCapturePhase;
  readonly startedAtMs: number | null;
  readonly durationMs: number;
  readonly waveformLevels: readonly number[];
}

export interface VoiceTranscriptionSession {
  readonly jobId: string;
  readonly threadId: ThreadId;
  readonly phase: "transcribing";
}

interface VoiceSessionCoordinatorState {
  readonly capture: VoiceCaptureSession | null;
  readonly transcriptions: readonly VoiceTranscriptionSession[];
  readonly nativeCapabilities: DesktopVoiceTranscriptionCapabilities;
  readonly nativeCapabilitiesReady: boolean;
}

const EMPTY_WAVEFORM_LEVELS: readonly number[] = [];
const IDLE_VOICE_SESSION_COORDINATOR: VoiceSessionCoordinatorState = {
  capture: null,
  transcriptions: [],
  nativeCapabilities: { appleSpeech: null },
  nativeCapabilitiesReady: false,
};

export const useVoiceSessionCoordinatorStore = create<VoiceSessionCoordinatorState>()(() => ({
  ...IDLE_VOICE_SESSION_COORDINATOR,
}));

export type StartVoiceSessionResult =
  | { readonly status: "started" }
  | { readonly status: "busy"; readonly origin: VoiceSessionOrigin };

export type SubmitVoiceSessionResult =
  | { readonly status: "completed"; readonly jobId: string }
  | { readonly status: "no-audio" };

export class VoiceSessionTranscriptionError extends Error {
  readonly jobSaved: boolean;

  constructor(error: unknown, jobSaved: boolean) {
    super(error instanceof Error ? error.message : "The voice note could not be transcribed.");
    this.name = "VoiceSessionTranscriptionError";
    this.jobSaved = jobSaved;
  }
}

interface VoiceTranscriptConsumer {
  onTranscriptReady: (
    threadId: ThreadId,
    transcript: string,
    jobId: string,
  ) => void | Promise<void>;
  onRecoveredTranscriptionFailure?: (error: VoiceSessionTranscriptionError) => void;
}

interface VoiceSessionCoordinatorActions {
  startRecording: (origin: VoiceSessionOrigin) => Promise<StartVoiceSessionResult>;
  submitRecording: () => Promise<SubmitVoiceSessionResult>;
  cancelForThread: (threadId: ThreadId) => Promise<void>;
  registerTranscriptConsumer: (consumer: VoiceTranscriptConsumer) => () => void;
}

const VoiceSessionCoordinatorContext = createContext<VoiceSessionCoordinatorActions | null>(null);

interface PendingTranscriptDelivery {
  readonly job: VoiceTranscriptionJob;
  readonly transcript: string;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

function removeTranscription(jobId: string): void {
  useVoiceSessionCoordinatorStore.setState((state) => ({
    transcriptions: state.transcriptions.filter((session) => session.jobId !== jobId),
  }));
}

export function VoiceSessionCoordinatorProvider({ children }: { children: ReactNode }) {
  const {
    isRecording,
    durationMs,
    waveformLevels,
    startRecording: startRecorder,
    stopRecording: stopRecorder,
    cancelRecording: cancelRecorder,
  } = useVoiceRecorder();
  const captureOriginRef = useRef<VoiceSessionOrigin | null>(null);
  const consumerRef = useRef<VoiceTranscriptConsumer | null>(null);
  const pendingDeliveriesRef = useRef<PendingTranscriptDelivery[]>([]);
  const activeJobIdsRef = useRef(new Set<string>());
  const cancelledJobIdsRef = useRef(new Set<string>());
  const attemptedRecoveryJobIdsRef = useRef(new Set<string>());
  const recoveryStartedRef = useRef(false);
  const wasRecordingRef = useRef(false);

  const deliverTranscript = useCallback(
    (job: VoiceTranscriptionJob, transcript: string): Promise<void> => {
      const consumer = consumerRef.current;
      if (consumer) {
        return Promise.resolve(consumer.onTranscriptReady(job.threadId, transcript, job.id));
      }
      return new Promise<void>((resolve, reject) => {
        pendingDeliveriesRef.current.push({ job, transcript, resolve, reject });
      });
    },
    [],
  );

  const runTranscriptionJob = useCallback(
    (job: VoiceTranscriptionJob): Promise<void> => {
      if (activeJobIdsRef.current.has(job.id)) return Promise.resolve();
      activeJobIdsRef.current.add(job.id);
      useVoiceSessionCoordinatorStore.setState((state) => ({
        transcriptions: state.transcriptions.some((session) => session.jobId === job.id)
          ? state.transcriptions
          : [
              ...state.transcriptions,
              { jobId: job.id, threadId: job.threadId, phase: "transcribing" as const },
            ],
      }));

      const api = readNativeApi();
      if (!api && job.transcriptionBackend.kind === "codex-chatgpt") {
        activeJobIdsRef.current.delete(job.id);
        removeTranscription(job.id);
        return Promise.reject(new Error("Voice transcription is unavailable right now."));
      }
      const isCurrent = () => !cancelledJobIdsRef.current.has(job.id);

      return serializeCapturedVoiceRecording(job.recording)
        .then((recording) =>
          transcribeVoiceRecording({
            recording,
            isCurrent,
            transcribeChunk: (chunk) => {
              if (job.transcriptionBackend.kind === "apple-speech") {
                const appleVoice = window.desktopBridge?.voice;
                if (!appleVoice) {
                  return Promise.reject(
                    new Error("Apple on-device transcription is unavailable right now."),
                  );
                }
                return appleVoice.transcribeWithApple({
                  locale: job.transcriptionBackend.locale,
                  ...chunk,
                });
              }
              return api!.server.transcribeVoice({
                provider: "codex",
                connectionId: job.transcriptionBackend.connectionId,
                cwd: job.cwd,
                ...(job.providerThreadId ? { threadId: job.providerThreadId } : {}),
                ...chunk,
              });
            },
          }),
        )
        .then(async (transcript) => {
          if (!transcript || !isCurrent()) return;
          await deliverTranscript(job, transcript);
          if (!isCurrent()) return;
          await deleteVoiceTranscriptionJob(job.id);
        })
        .finally(() => {
          activeJobIdsRef.current.delete(job.id);
          cancelledJobIdsRef.current.delete(job.id);
          removeTranscription(job.id);
        })
        .then(() => undefined);
    },
    [deliverTranscript],
  );

  const recoverTranscriptionJobs = useCallback(() => {
    if (recoveryStartedRef.current) return;
    recoveryStartedRef.current = true;
    void listVoiceTranscriptionJobs()
      .then((jobs) =>
        Promise.all(
          jobs.map((job) => {
            if (attemptedRecoveryJobIdsRef.current.has(job.id)) return Promise.resolve();
            attemptedRecoveryJobIdsRef.current.add(job.id);
            return runTranscriptionJob(job).catch((error: unknown) => {
              consumerRef.current?.onRecoveredTranscriptionFailure?.(
                new VoiceSessionTranscriptionError(error, true),
              );
            });
          }),
        ),
      )
      .catch((error: unknown) => {
        console.error("[voice-session] Could not recover saved voice notes.", error);
      });
  }, [runTranscriptionJob]);

  const registerTranscriptConsumer = useCallback(
    (consumer: VoiceTranscriptConsumer) => {
      consumerRef.current = consumer;
      const pending = pendingDeliveriesRef.current.splice(0);
      for (const delivery of pending) {
        Promise.resolve(
          consumer.onTranscriptReady(delivery.job.threadId, delivery.transcript, delivery.job.id),
        ).then(delivery.resolve, delivery.reject);
      }
      recoverTranscriptionJobs();
      return () => {
        if (consumerRef.current === consumer) consumerRef.current = null;
      };
    },
    [recoverTranscriptionJobs],
  );

  const startRecording = useCallback(
    async (origin: VoiceSessionOrigin): Promise<StartVoiceSessionResult> => {
      const existingCapture = useVoiceSessionCoordinatorStore.getState().capture;
      if (existingCapture) return { status: "busy", origin: existingCapture.origin };

      captureOriginRef.current = origin;
      useVoiceSessionCoordinatorStore.setState({
        capture: {
          origin,
          phase: "starting",
          startedAtMs: null,
          durationMs: 0,
          waveformLevels: EMPTY_WAVEFORM_LEVELS,
        },
      });
      try {
        await startRecorder(origin satisfies VoiceRecordingOrigin);
        if (captureOriginRef.current === origin) {
          useVoiceSessionCoordinatorStore.setState({
            capture: {
              origin,
              phase: "recording",
              startedAtMs: performance.now(),
              durationMs: 0,
              waveformLevels: EMPTY_WAVEFORM_LEVELS,
            },
          });
        }
        return { status: "started" };
      } catch (error) {
        if (captureOriginRef.current === origin) {
          captureOriginRef.current = null;
          useVoiceSessionCoordinatorStore.setState({ capture: null });
        }
        throw error;
      }
    },
    [startRecorder],
  );

  const submitRecording = useCallback(async (): Promise<SubmitVoiceSessionResult> => {
    const capture = useVoiceSessionCoordinatorStore.getState().capture;
    if (!capture || capture.phase !== "recording") return { status: "no-audio" };

    const origin = capture.origin;
    useVoiceSessionCoordinatorStore.setState({
      capture: { ...capture, phase: "stopping" },
    });
    let jobSaved = false;
    try {
      const payload = await stopRecorder();
      if (!payload) {
        captureOriginRef.current = null;
        useVoiceSessionCoordinatorStore.setState({ capture: null });
        return { status: "no-audio" };
      }

      const now = new Date().toISOString();
      const job: VoiceTranscriptionJob = {
        id: payload.durableVoiceDraftId ?? globalThis.crypto.randomUUID(),
        threadId: origin.threadId,
        ...(origin.providerThreadId ? { providerThreadId: origin.providerThreadId } : {}),
        transcriptionBackend: origin.transcriptionBackend,
        cwd: origin.cwd,
        recording: payload,
        createdAt: now,
        updatedAt: now,
      };
      await persistVoiceTranscriptionJob(job);
      jobSaved = true;
      const transcription = runTranscriptionJob(job);
      captureOriginRef.current = null;
      useVoiceSessionCoordinatorStore.setState({ capture: null });
      await transcription;
      return { status: "completed", jobId: job.id };
    } catch (error) {
      captureOriginRef.current = null;
      useVoiceSessionCoordinatorStore.setState({ capture: null });
      throw new VoiceSessionTranscriptionError(error, jobSaved);
    }
  }, [runTranscriptionJob, stopRecorder]);

  const cancelForThread = useCallback(
    async (threadId: ThreadId) => {
      const capture = useVoiceSessionCoordinatorStore.getState().capture;
      if (capture?.origin.threadId === threadId) {
        captureOriginRef.current = null;
        useVoiceSessionCoordinatorStore.setState({ capture: null });
        await cancelRecorder();
      }
      const transcriptions = useVoiceSessionCoordinatorStore
        .getState()
        .transcriptions.filter((session) => session.threadId === threadId);
      for (const session of transcriptions) cancelledJobIdsRef.current.add(session.jobId);
      const cancelledJobIds = new Set(transcriptions.map((session) => session.jobId));
      if (cancelledJobIds.size > 0) {
        const retainedDeliveries: PendingTranscriptDelivery[] = [];
        for (const delivery of pendingDeliveriesRef.current) {
          if (cancelledJobIds.has(delivery.job.id)) {
            delivery.resolve();
          } else {
            retainedDeliveries.push(delivery);
          }
        }
        pendingDeliveriesRef.current = retainedDeliveries;
      }
      if (transcriptions.length > 0) {
        useVoiceSessionCoordinatorStore.setState((state) => ({
          transcriptions: state.transcriptions.filter((session) => session.threadId !== threadId),
        }));
      }
    },
    [cancelRecorder],
  );

  useEffect(() => {
    const capture = useVoiceSessionCoordinatorStore.getState().capture;
    if (capture && capture.phase !== "stopping") {
      useVoiceSessionCoordinatorStore.setState({
        capture: { ...capture, durationMs, waveformLevels },
      });
    }
    if (wasRecordingRef.current && !isRecording && capture?.phase === "recording") {
      captureOriginRef.current = null;
      useVoiceSessionCoordinatorStore.setState({ capture: null });
    }
    wasRecordingRef.current = isRecording;
  }, [durationMs, isRecording, waveformLevels]);

  useEffect(() => {
    const voiceBridge = window.desktopBridge?.voice;
    if (!voiceBridge) {
      useVoiceSessionCoordinatorStore.setState({ nativeCapabilitiesReady: true });
      return;
    }
    let current = true;
    void voiceBridge
      .getCapabilities()
      .then((nativeCapabilities) => {
        if (current) {
          useVoiceSessionCoordinatorStore.setState({
            nativeCapabilities,
            nativeCapabilitiesReady: true,
          });
        }
      })
      .catch((error: unknown) => {
        console.warn("[voice-session] Native transcription discovery failed.", error);
        if (current) useVoiceSessionCoordinatorStore.setState({ nativeCapabilitiesReady: true });
      });
    return () => {
      current = false;
    };
  }, []);

  useEffect(
    () => () => {
      captureOriginRef.current = null;
      consumerRef.current = null;
      useVoiceSessionCoordinatorStore.setState({ ...IDLE_VOICE_SESSION_COORDINATOR });
    },
    [],
  );

  const actions = useMemo<VoiceSessionCoordinatorActions>(
    () => ({ startRecording, submitRecording, cancelForThread, registerTranscriptConsumer }),
    [cancelForThread, registerTranscriptConsumer, startRecording, submitRecording],
  );

  return (
    <VoiceSessionCoordinatorContext.Provider value={actions}>
      {children}
    </VoiceSessionCoordinatorContext.Provider>
  );
}

export function useVoiceSessionCoordinatorActions(): VoiceSessionCoordinatorActions {
  const actions = useContext(VoiceSessionCoordinatorContext);
  if (!actions) {
    throw new Error(
      "useVoiceSessionCoordinatorActions must be used inside VoiceSessionCoordinatorProvider.",
    );
  }
  return actions;
}
