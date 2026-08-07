// FILE: useComposerVoiceController.ts
// Purpose: Own the composer voice-note state machine for recording, cancellation, and transcription.
// Layer: Chat composer hook
// Depends on: useVoiceRecorder, ChatView voice helper logic, and the native API voice endpoint.

import { type ProviderKind, type ServerProviderStatus, type ThreadId } from "@penkra/contracts";
import { useEffect, useRef, useState } from "react";

import type { Project } from "../../types";
import {
  formatVoiceRecordingDuration,
  serializeCapturedVoiceRecording,
} from "../../lib/voiceRecorder";
import { transcribeVoiceRecording } from "../../lib/voiceTranscriptionSequence";
import {
  deleteVoiceTranscriptionJob,
  listVoiceTranscriptionJobs,
  persistVoiceTranscriptionJob,
  type VoiceTranscriptionJob,
} from "../../lib/voiceTranscriptionJobStore";
import { readNativeApi } from "../../nativeApi";
import type { RefreshProviderStatusesNow } from "../../hooks/useProviderStatusRefresh";
import {
  useVoiceRecordingSessionActions,
  useVoiceRecordingSessionStore,
  type VoiceRecordingSessionOrigin,
} from "../../voiceRecordingSession";
import { toastManager } from "../ui/toast";
import {
  deriveComposerVoiceState,
  describeVoiceRecordingStartError,
  isVoiceAuthExpiredMessage,
  sanitizeVoiceErrorMessage,
} from "../ChatView.logic";

export interface ComposerVoiceFailureCopy {
  transcriptionFailedTitle: string;
  fallbackDescription: string;
  authExpiredTitle: string;
  authExpiredDescription: string;
  refreshActionLabel: string;
}

interface ComposerVoiceGuardDetails {
  readonly [key: string]: unknown;
}

export interface UseComposerVoiceControllerOptions {
  activeProject: Project | undefined;
  activeThreadId: ThreadId | null;
  threadId: ThreadId;
  selectedProvider: ProviderKind;
  activeProviderStatus: ServerProviderStatus | null;
  pendingUserInputCount: number;
  onTranscriptReady: (
    threadId: ThreadId,
    transcript: string,
    jobId: string,
  ) => void | Promise<void>;
  refreshVoiceStatus: RefreshProviderStatusesNow;
  actionArmDelayMs?: number;
  failureCopy?: Partial<ComposerVoiceFailureCopy>;
  onGuardWarning?: (message: string, details: ComposerVoiceGuardDetails) => void;
}

export interface UseComposerVoiceControllerResult {
  isVoiceRecording: boolean;
  isVoiceTranscribing: boolean;
  voiceWaveformLevels: readonly number[];
  voiceRecordingDurationLabel: string;
  showVoiceNotesControl: boolean;
  startComposerVoiceRecording: () => Promise<void>;
  submitComposerVoiceRecording: () => Promise<void>;
  cancelComposerVoiceRecording: () => void;
}

const DEFAULT_FAILURE_COPY: ComposerVoiceFailureCopy = {
  transcriptionFailedTitle: "Voice transcription failed",
  fallbackDescription: "The voice note could not be transcribed.",
  authExpiredTitle: "Sign in to ChatGPT again",
  authExpiredDescription:
    "Voice transcription uses your ChatGPT session in Codex. That session was rejected, so sign in again there and retry.",
  refreshActionLabel: "Refresh status",
};
const EMPTY_VOICE_WAVEFORM_LEVELS: readonly number[] = [];

const activeVoiceTranscriptionJobIds = new Set<string>();
const attemptedRecoveredVoiceTranscriptionJobIds = new Set<string>();

function runVoiceTranscriptionJob(input: {
  readonly job: VoiceTranscriptionJob;
  readonly isCurrent: () => boolean;
  readonly onTranscriptReady: (
    threadId: ThreadId,
    transcript: string,
    jobId: string,
  ) => void | Promise<void>;
}): Promise<void> {
  if (activeVoiceTranscriptionJobIds.has(input.job.id)) return Promise.resolve();
  activeVoiceTranscriptionJobIds.add(input.job.id);
  const api = readNativeApi();
  if (!api) {
    activeVoiceTranscriptionJobIds.delete(input.job.id);
    return Promise.reject(new Error("Voice transcription is unavailable right now."));
  }

  return serializeCapturedVoiceRecording(input.job.recording)
    .then((recording) =>
      transcribeVoiceRecording({
        recording,
        isCurrent: input.isCurrent,
        transcribeChunk: (chunk) =>
          api.server.transcribeVoice({
            provider: "codex",
            cwd: input.job.cwd,
            ...(input.job.providerThreadId ? { threadId: input.job.providerThreadId } : {}),
            ...chunk,
          }),
      }),
    )
    .then(async (transcript) => {
      if (!transcript || !input.isCurrent()) return;
      await input.onTranscriptReady(input.job.threadId, transcript, input.job.id);
      await deleteVoiceTranscriptionJob(input.job.id);
    })
    .finally(() => {
      activeVoiceTranscriptionJobIds.delete(input.job.id);
    })
    .then(() => undefined);
}

function recoverVoiceTranscriptionJobs(input: {
  readonly onTranscriptReady: (
    threadId: ThreadId,
    transcript: string,
    jobId: string,
  ) => void | Promise<void>;
  readonly fallbackDescription: string;
  readonly failureTitle: string;
}): void {
  void listVoiceTranscriptionJobs()
    .then((jobs) =>
      Promise.all(
        jobs.map((job) => {
          if (attemptedRecoveredVoiceTranscriptionJobIds.has(job.id)) {
            return Promise.resolve();
          }
          attemptedRecoveredVoiceTranscriptionJobIds.add(job.id);
          return runVoiceTranscriptionJob({
            job,
            isCurrent: () => true,
            onTranscriptReady: input.onTranscriptReady,
          }).catch((error: unknown) => {
            const description =
              error instanceof Error
                ? sanitizeVoiceErrorMessage(error.message)
                : input.fallbackDescription;
            toastManager.add({
              type: "error",
              title: input.failureTitle,
              description: `${description} Your voice note is saved and will be retried next time Penkra opens.`,
            });
          });
        }),
      ),
    )
    .catch((error: unknown) => {
      console.error("[voice-recorder] Could not recover saved voice notes.", error);
    });
}

// Keeps the async transcription lifecycle out of ChatView so the component can stay UI-focused.
export function useComposerVoiceController(
  options: UseComposerVoiceControllerOptions,
): UseComposerVoiceControllerResult {
  const {
    activeProject,
    activeThreadId,
    threadId,
    activeProviderStatus,
    pendingUserInputCount,
    onTranscriptReady,
    refreshVoiceStatus,
    actionArmDelayMs: actionArmDelayMsProp,
    failureCopy: failureCopyOverrides,
    onGuardWarning,
  } = options;
  const actionArmDelayMs = actionArmDelayMsProp ?? 0;
  const { startRecording, stopRecording, cancelRecording } = useVoiceRecordingSessionActions();
  const isVoiceRecording = useVoiceRecordingSessionStore(
    (state) => state.origin?.threadId === threadId && state.isRecording,
  );
  const voiceRecordingDurationMs = useVoiceRecordingSessionStore((state) =>
    state.origin?.threadId === threadId ? state.durationMs : 0,
  );
  const voiceWaveformLevels = useVoiceRecordingSessionStore((state) =>
    state.origin?.threadId === threadId ? state.waveformLevels : EMPTY_VOICE_WAVEFORM_LEVELS,
  );
  const [voiceTranscriptionThreadId, setVoiceTranscriptionThreadId] = useState<ThreadId | null>(
    null,
  );
  const isVoiceTranscribing = voiceTranscriptionThreadId === threadId;
  const voiceTranscriptionRequestIdRef = useRef(0);
  const voiceOriginRef = useRef<VoiceRecordingSessionOrigin | null>(null);
  const failureCopy = {
    ...DEFAULT_FAILURE_COPY,
    ...failureCopyOverrides,
  };
  const voiceRecordingDurationLabel = formatVoiceRecordingDuration(voiceRecordingDurationMs);
  const { canStartVoiceNotes, showVoiceNotesControl } = deriveComposerVoiceState({
    authStatus: activeProviderStatus?.authStatus,
    voiceTranscriptionAvailable: activeProviderStatus?.voiceTranscriptionAvailable,
    isRecording: isVoiceRecording,
    isTranscribing: isVoiceTranscribing,
  });

  useEffect(() => {
    recoverVoiceTranscriptionJobs({
      onTranscriptReady,
      fallbackDescription: failureCopy.fallbackDescription,
      failureTitle: failureCopy.transcriptionFailedTitle,
    });
  }, [failureCopy.fallbackDescription, failureCopy.transcriptionFailedTitle, onTranscriptReady]);

  const isVoiceActionArmed = () => {
    const recordingStartedAtMs = useVoiceRecordingSessionStore.getState().startedAtMs;
    if (actionArmDelayMs <= 0 || recordingStartedAtMs === null) {
      return true;
    }
    const recordedForMs = Math.round(performance.now() - recordingStartedAtMs);
    if (recordedForMs < 0 || recordedForMs >= actionArmDelayMs) {
      return true;
    }
    onGuardWarning?.("ignored recorder action immediately after start", {
      recordedForMs,
    });
    return false;
  };

  const startComposerVoiceRecording = async () => {
    const existingOrigin = useVoiceRecordingSessionStore.getState().origin;
    if (existingOrigin && existingOrigin.threadId !== threadId) {
      toastManager.add({
        type: "info",
        title: "Voice recording is active in another thread",
      });
      return;
    }
    if (!activeProject) {
      return;
    }
    if (activeProviderStatus?.authStatus === "unauthenticated") {
      toastManager.add({
        type: "error",
        title: "Sign in to ChatGPT in Codex before using voice notes.",
      });
      return;
    }
    if (!canStartVoiceNotes) {
      toastManager.add({
        type: "error",
        title: "Voice notes require a ChatGPT-authenticated Codex session.",
      });
      return;
    }
    if (pendingUserInputCount > 0) {
      toastManager.add({
        type: "error",
        title: "Answer plan questions before recording a voice note.",
      });
      return;
    }

    try {
      const origin = {
        threadId,
        providerThreadId: activeThreadId,
        cwd: activeProject.cwd,
      };
      const result = await startRecording(origin);
      if (result.status === "busy") {
        if (result.origin.threadId !== threadId) {
          toastManager.add({
            type: "info",
            title: "Voice recording is active in another thread",
          });
        }
        return;
      }
      voiceOriginRef.current = origin;
    } catch (error) {
      console.error("[voice-recorder] Could not start microphone capture.", error);
      toastManager.add({
        type: "error",
        title: "Could not start recording",
        description: describeVoiceRecordingStartError(error),
      });
    }
  };

  const submitComposerVoiceRecording = (): Promise<void> => {
    if (!activeProject || !isVoiceRecording) {
      return Promise.resolve();
    }
    if (!isVoiceActionArmed()) {
      return Promise.resolve();
    }

    const api = readNativeApi();
    if (!api) {
      toastManager.add({
        type: "error",
        title: "Voice transcription is unavailable right now.",
      });
      void cancelRecording();
      return Promise.resolve();
    }

    const requestId = voiceTranscriptionRequestIdRef.current + 1;
    voiceTranscriptionRequestIdRef.current = requestId;
    const origin = voiceOriginRef.current ?? {
      threadId,
      providerThreadId: activeThreadId,
      cwd: activeProject.cwd,
    };
    setVoiceTranscriptionThreadId(origin.threadId);
    let voiceJobSaved = false;
    const isCurrentVoiceRequest = () => voiceTranscriptionRequestIdRef.current === requestId;

    // Promise chain instead of async/try-catch-finally: React Compiler does
    // not yet support try/finally, and it would skip optimizing this hook.
    return stopRecording()
      .then((payload) => {
        if (!isCurrentVoiceRequest()) {
          return;
        }
        if (!payload) {
          toastManager.add({
            type: "warning",
            title: "No audio was captured.",
          });
          return;
        }
        const now = new Date().toISOString();
        const job: VoiceTranscriptionJob = {
          id: payload.durableVoiceDraftId ?? globalThis.crypto.randomUUID(),
          threadId: origin.threadId,
          ...(origin.providerThreadId ? { providerThreadId: origin.providerThreadId } : {}),
          cwd: origin.cwd,
          recording: payload,
          createdAt: now,
          updatedAt: now,
        };
        return persistVoiceTranscriptionJob(job).then(() => {
          voiceJobSaved = true;
          return runVoiceTranscriptionJob({
            job,
            isCurrent: isCurrentVoiceRequest,
            onTranscriptReady,
          });
        });
      })
      .catch((error: unknown) => {
        if (!isCurrentVoiceRequest()) {
          return;
        }

        const description =
          error instanceof Error
            ? sanitizeVoiceErrorMessage(error.message)
            : failureCopy.fallbackDescription;
        const authExpired = isVoiceAuthExpiredMessage(description);
        if (authExpired) {
          void refreshVoiceStatus();
        }
        toastManager.add({
          type: "error",
          title: authExpired ? failureCopy.authExpiredTitle : failureCopy.transcriptionFailedTitle,
          description: `${authExpired ? failureCopy.authExpiredDescription : description}${
            voiceJobSaved
              ? " Your voice note is saved and will be retried next time Penkra opens."
              : ""
          }`,
          ...(authExpired
            ? {
                actionProps: {
                  children: failureCopy.refreshActionLabel,
                  onClick: () => {
                    void refreshVoiceStatus();
                  },
                },
              }
            : {}),
        });
      })
      .finally(() => {
        if (isCurrentVoiceRequest()) {
          voiceOriginRef.current = null;
          setVoiceTranscriptionThreadId(null);
        }
      })
      .then(() => undefined);
  };

  const cancelComposerVoiceRecording = () => {
    if (!isVoiceActionArmed()) {
      return;
    }
    voiceTranscriptionRequestIdRef.current += 1;
    voiceOriginRef.current = null;
    setVoiceTranscriptionThreadId(null);
    void cancelRecording();
  };

  return {
    isVoiceRecording,
    isVoiceTranscribing,
    voiceWaveformLevels,
    voiceRecordingDurationLabel,
    showVoiceNotesControl,
    startComposerVoiceRecording,
    submitComposerVoiceRecording,
    cancelComposerVoiceRecording,
  };
}
