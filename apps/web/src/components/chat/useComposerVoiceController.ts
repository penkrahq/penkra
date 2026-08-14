// FILE: useComposerVoiceController.ts
// Purpose: Project the global voice coordinator into the active composer and enforce UI guards.
// Layer: Chat composer hook
// Depends on: VoiceSessionCoordinator and ChatView voice helper logic.

import { type ProviderConnectionId, type ThreadId } from "@penkra/contracts";
import { useEffect, useMemo } from "react";

import type { Project } from "../../types";
import { formatVoiceRecordingDuration } from "../../lib/voiceRecorder";
import { resolveVoiceTranscriptionBackend } from "../../lib/voiceTranscriptionBackend";
import type { RefreshProviderStatusesNow } from "../../hooks/useProviderStatusRefresh";
import {
  useVoiceSessionCoordinatorActions,
  useVoiceSessionCoordinatorStore,
} from "../../voiceSessionCoordinator";
import { toastManager } from "../ui/toast";
import {
  describeVoiceRecordingStartError,
  isVoiceAuthExpiredMessage,
  sanitizeVoiceErrorMessage,
} from "../ChatView.logic";

export interface ComposerVoiceFailureCopy {
  transcriptionFailedTitle: string;
  fallbackDescription: string;
  authExpiredTitle: string;
  authExpiredDescription: string;
}

interface ComposerVoiceGuardDetails {
  readonly [key: string]: unknown;
}

export interface UseComposerVoiceControllerOptions {
  activeProject: Project | undefined;
  activeThreadId: ThreadId | null;
  threadId: ThreadId;
  connectionId: ProviderConnectionId | undefined;
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
  authExpiredTitle: "ChatGPT Connection unavailable",
  authExpiredDescription: "Choose an available ChatGPT Connection and try again.",
};
const EMPTY_VOICE_WAVEFORM_LEVELS: readonly number[] = [];

// Keeps the async transcription lifecycle out of ChatView so the component can stay UI-focused.
export function useComposerVoiceController(
  options: UseComposerVoiceControllerOptions,
): UseComposerVoiceControllerResult {
  const {
    activeProject,
    activeThreadId,
    threadId,
    connectionId,
    pendingUserInputCount,
    onTranscriptReady,
    refreshVoiceStatus,
    actionArmDelayMs: actionArmDelayMsProp,
    failureCopy: failureCopyOverrides,
    onGuardWarning,
  } = options;
  const actionArmDelayMs = actionArmDelayMsProp ?? 0;
  const { startRecording, submitRecording, cancelForThread, registerTranscriptConsumer } =
    useVoiceSessionCoordinatorActions();
  const isVoiceRecording = useVoiceSessionCoordinatorStore(
    (state) => state.capture?.origin.threadId === threadId && state.capture.phase === "recording",
  );
  const voiceRecordingDurationMs = useVoiceSessionCoordinatorStore((state) =>
    state.capture?.origin.threadId === threadId ? state.capture.durationMs : 0,
  );
  const voiceWaveformLevels = useVoiceSessionCoordinatorStore((state) =>
    state.capture?.origin.threadId === threadId
      ? state.capture.waveformLevels
      : EMPTY_VOICE_WAVEFORM_LEVELS,
  );
  const isVoiceTranscribing = useVoiceSessionCoordinatorStore(
    (state) =>
      (state.capture?.origin.threadId === threadId && state.capture.phase === "stopping") ||
      state.transcriptions.some((session) => session.threadId === threadId),
  );
  const appleSpeechLocale = useVoiceSessionCoordinatorStore(
    (state) => state.nativeCapabilities.appleSpeech?.locale ?? null,
  );
  const nativeCapabilitiesReady = useVoiceSessionCoordinatorStore(
    (state) => state.nativeCapabilitiesReady,
  );
  const failureCopy = {
    ...DEFAULT_FAILURE_COPY,
    ...failureCopyOverrides,
  };
  const voiceRecordingDurationLabel = formatVoiceRecordingDuration(voiceRecordingDurationMs);
  const transcriptionBackend = useMemo(
    () =>
      resolveVoiceTranscriptionBackend({
        appleSpeechLocale: nativeCapabilitiesReady ? appleSpeechLocale : null,
        codexConnectionId: connectionId,
      }),
    [appleSpeechLocale, connectionId, nativeCapabilitiesReady],
  );
  const canStartVoiceNotes = transcriptionBackend !== null;
  const showVoiceNotesControl =
    transcriptionBackend !== null || isVoiceRecording || isVoiceTranscribing;

  useEffect(() => {
    return registerTranscriptConsumer({
      resolveTranscriptionBackend: () => transcriptionBackend,
      onTranscriptReady,
      onRecoveredTranscriptionFailure: (error) => {
        const description = sanitizeVoiceErrorMessage(error.message);
        toastManager.add({
          type: "error",
          title: failureCopy.transcriptionFailedTitle,
          description,
        });
      },
    });
  }, [
    failureCopy.transcriptionFailedTitle,
    onTranscriptReady,
    registerTranscriptConsumer,
    transcriptionBackend,
  ]);

  const isVoiceActionArmed = () => {
    const recordingStartedAtMs =
      useVoiceSessionCoordinatorStore.getState().capture?.startedAtMs ?? null;
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
    const existingOrigin = useVoiceSessionCoordinatorStore.getState().capture?.origin;
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
    if (!canStartVoiceNotes || !transcriptionBackend) return;
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

    // Promise chain instead of async/try-catch-finally: React Compiler does
    // not yet support try/finally, and it would skip optimizing this hook.
    return submitRecording()
      .then((result) => {
        if (result.status === "no-audio") {
          toastManager.add({
            type: "warning",
            title: "No audio was captured.",
          });
        }
      })
      .catch((error: unknown) => {
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
          description: authExpired ? failureCopy.authExpiredDescription : description,
        });
      })
      .then(() => undefined);
  };

  const cancelComposerVoiceRecording = () => {
    if (!isVoiceActionArmed()) {
      return;
    }
    void cancelForThread(threadId);
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
