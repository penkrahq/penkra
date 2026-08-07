// FILE: voiceRecordingSession.tsx
// Purpose: Own the app-wide microphone capture session and bind it to its originating thread.
// Layer: Cross-cutting voice runtime
// Depends on: useVoiceRecorder and a small observable session snapshot for composers/sidebar.

import type { ThreadId } from "@penkra/contracts";
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
  useVoiceRecorder,
  type CapturedVoiceRecordingPayload,
  type VoiceRecordingOrigin,
} from "./lib/voiceRecorder";

export interface VoiceRecordingSessionOrigin {
  readonly threadId: ThreadId;
  readonly providerThreadId: ThreadId | null;
  readonly cwd: string;
}

type VoiceRecordingSessionPhase = "idle" | "starting" | "recording";

interface VoiceRecordingSessionState {
  readonly origin: VoiceRecordingSessionOrigin | null;
  readonly phase: VoiceRecordingSessionPhase;
  readonly isRecording: boolean;
  readonly startedAtMs: number | null;
  readonly durationMs: number;
  readonly waveformLevels: readonly number[];
}

const EMPTY_WAVEFORM_LEVELS: readonly number[] = [];
const IDLE_VOICE_RECORDING_SESSION: VoiceRecordingSessionState = {
  origin: null,
  phase: "idle",
  isRecording: false,
  startedAtMs: null,
  durationMs: 0,
  waveformLevels: EMPTY_WAVEFORM_LEVELS,
};

export const useVoiceRecordingSessionStore = create<VoiceRecordingSessionState>()(() => ({
  ...IDLE_VOICE_RECORDING_SESSION,
}));

export type StartVoiceRecordingSessionResult =
  | { readonly status: "started" }
  | { readonly status: "busy"; readonly origin: VoiceRecordingSessionOrigin };

interface VoiceRecordingSessionActions {
  startRecording: (
    origin: VoiceRecordingSessionOrigin,
  ) => Promise<StartVoiceRecordingSessionResult>;
  stopRecording: () => Promise<CapturedVoiceRecordingPayload | null>;
  cancelRecording: () => Promise<void>;
}

const VoiceRecordingSessionActionsContext = createContext<VoiceRecordingSessionActions | null>(
  null,
);

function resetVoiceRecordingSession(): void {
  useVoiceRecordingSessionStore.setState({ ...IDLE_VOICE_RECORDING_SESSION });
}

export function VoiceRecordingSessionProvider({ children }: { children: ReactNode }) {
  const {
    isRecording,
    durationMs,
    waveformLevels,
    startRecording: startRecorder,
    stopRecording: stopRecorder,
    cancelRecording: cancelRecorder,
  } = useVoiceRecorder();
  const originRef = useRef<VoiceRecordingSessionOrigin | null>(null);
  const wasRecordingRef = useRef(false);

  const startRecording = useCallback(
    async (origin: VoiceRecordingSessionOrigin): Promise<StartVoiceRecordingSessionResult> => {
      const existingOrigin = originRef.current;
      if (existingOrigin) {
        return { status: "busy", origin: existingOrigin };
      }

      originRef.current = origin;
      useVoiceRecordingSessionStore.setState({
        origin,
        phase: "starting",
        isRecording: false,
        startedAtMs: null,
        durationMs: 0,
        waveformLevels: EMPTY_WAVEFORM_LEVELS,
      });

      try {
        await startRecorder(origin satisfies VoiceRecordingOrigin);
        if (originRef.current === origin) {
          useVoiceRecordingSessionStore.setState({
            phase: "recording",
            isRecording: true,
            startedAtMs: performance.now(),
          });
        }
        return { status: "started" };
      } catch (error) {
        if (originRef.current === origin) {
          originRef.current = null;
          resetVoiceRecordingSession();
        }
        throw error;
      }
    },
    [startRecorder],
  );

  const stopRecording = useCallback(async () => {
    if (!originRef.current) return null;
    originRef.current = null;
    resetVoiceRecordingSession();
    return stopRecorder();
  }, [stopRecorder]);

  const cancelRecording = useCallback(async () => {
    if (!originRef.current) return;
    originRef.current = null;
    resetVoiceRecordingSession();
    await cancelRecorder();
  }, [cancelRecorder]);

  useEffect(() => {
    const current = useVoiceRecordingSessionStore.getState();
    if (current.origin) {
      useVoiceRecordingSessionStore.setState({
        isRecording,
        durationMs,
        waveformLevels,
      });
    }

    if (wasRecordingRef.current && !isRecording && current.phase === "recording") {
      originRef.current = null;
      resetVoiceRecordingSession();
    }
    wasRecordingRef.current = isRecording;
  }, [durationMs, isRecording, waveformLevels]);

  useEffect(
    () => () => {
      originRef.current = null;
      resetVoiceRecordingSession();
    },
    [],
  );

  const actions = useMemo<VoiceRecordingSessionActions>(
    () => ({ startRecording, stopRecording, cancelRecording }),
    [cancelRecording, startRecording, stopRecording],
  );

  return (
    <VoiceRecordingSessionActionsContext.Provider value={actions}>
      {children}
    </VoiceRecordingSessionActionsContext.Provider>
  );
}

export function useVoiceRecordingSessionActions(): VoiceRecordingSessionActions {
  const actions = useContext(VoiceRecordingSessionActionsContext);
  if (!actions) {
    throw new Error(
      "useVoiceRecordingSessionActions must be used inside VoiceRecordingSessionProvider.",
    );
  }
  return actions;
}
