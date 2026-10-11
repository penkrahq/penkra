// FILE: voiceRecorder.ts
// Purpose: Captures microphone audio as a crash-durable recording with bounded rolling chunks.
// Layer: Client utility hook
// Exports: useVoiceRecorder, formatVoiceRecordingDuration
// Depends on: browser media devices, Web Audio API, and FileReader for base64 encoding.

import { useCallback, useEffect, useRef, useState } from "react";

import {
  encodeVoiceChunkWav,
  RollingVoiceChunker,
  VOICE_TARGET_SAMPLE_RATE_HZ,
  type CapturedVoiceRecordingChunk,
  type CapturedVoiceRecordingPayload,
  type RawVoiceChunk,
  type VoiceRecordingPayload,
} from "./voiceRecordingChunks";

export type { CapturedVoiceRecordingChunk, CapturedVoiceRecordingPayload };

interface RecorderRuntime {
  readonly audioContext: AudioContext;
  readonly sourceNode: MediaStreamAudioSourceNode;
  readonly processorNode: ScriptProcessorNode;
  readonly silentGainNode: GainNode;
  readonly stream: MediaStream;
  readonly chunker: RollingVoiceChunker;
  readonly completedChunks: EncodedVoiceChunk[];
  readonly startedAt: number;
  readonly durableJobId: string | null;
  durableAppendTail: Promise<void>;
  durableError: unknown;
  durablePending: Float32Array[];
  durablePendingSampleCount: number;
  durableSequence: number;
}

export interface VoiceRecordingOrigin {
  readonly threadId: string;
  readonly providerThreadId: string | null;
  readonly cwd: string;
}

interface EncodedVoiceChunk extends CapturedVoiceRecordingChunk {
  readonly blob: Blob;
  readonly durationMs: number;
}

const BUFFER_SIZE = 2_048;
const MAX_WAVEFORM_SAMPLES = 160;
const WAVEFORM_EMIT_INTERVAL_MS = 32;
const DURABLE_CHECKPOINT_MS = 250;

export function formatVoiceRecordingDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export function useVoiceRecorder() {
  const runtimeRef = useRef<RecorderRuntime | null>(null);
  const timerRef = useRef<number | null>(null);
  const waveformLevelsRef = useRef<number[]>([]);
  const waveformLastEmitAtRef = useRef(0);
  const [isRecording, setIsRecording] = useState(false);
  const [durationMs, setDurationMs] = useState(0);
  const [waveformLevels, setWaveformLevels] = useState<number[]>([]);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const teardownRuntime = useCallback(
    async (disposition: "complete" | "discard" = "complete") => {
      const runtime = runtimeRef.current;
      runtimeRef.current = null;
      clearTimer();
      setIsRecording(false);

      if (!runtime) {
        setDurationMs(0);
        return null;
      }

      runtime.processorNode.onaudioprocess = null;
      runtime.sourceNode.disconnect();
      runtime.processorNode.disconnect();
      runtime.silentGainNode.disconnect();
      runtime.stream.getTracks().forEach((track) => track.stop());
      await runtime.audioContext.close().catch(() => undefined);

      const durableBridge = window.desktopBridge?.composerDrafts;
      if (runtime.durableJobId && durableBridge) {
        queueDurableSamples(runtime, durableBridge, null, true);
        await runtime.durableAppendTail;
        if (disposition === "discard") {
          await durableBridge.deleteVoice(runtime.durableJobId);
        } else {
          if (runtime.durableError) throw runtime.durableError;
          await durableBridge.completeVoice(runtime.durableJobId);
        }
      }

      const finalRawChunk = runtime.chunker.finish();
      if (finalRawChunk) {
        runtime.completedChunks.push(encodeChunk(finalRawChunk));
      }
      const duration = Math.max(0, performance.now() - runtime.startedAt);
      setDurationMs(0);

      return {
        chunks: runtime.completedChunks,
        durationMs: Math.max(runtime.chunker.totalDurationMs, duration),
        ...(runtime.durableJobId ? { durableVoiceDraftId: runtime.durableJobId } : {}),
      };
    },
    [clearTimer],
  );

  const startRecording = useCallback(
    async (origin?: VoiceRecordingOrigin) => {
      if (runtimeRef.current) {
        throw new Error("Voice recording is already running.");
      }
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("Microphone recording is unavailable in this browser.");
      }

      let stream: MediaStream | null = null;
      let audioContext: AudioContext | null = null;
      let sourceNode: MediaStreamAudioSourceNode | null = null;
      let processorNode: ScriptProcessorNode | null = null;
      let silentGainNode: GainNode | null = null;

      try {
        const desktopMedia = window.desktopBridge?.media;
        if (desktopMedia && !(await desktopMedia.requestMicrophoneAccess())) {
          throw new DOMException("Microphone access was denied.", "NotAllowedError");
        }
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
          },
        });
        audioContext = new AudioContext();
        await audioContext.resume();

        sourceNode = audioContext.createMediaStreamSource(stream);
        processorNode = audioContext.createScriptProcessor(BUFFER_SIZE, 1, 1);
        silentGainNode = audioContext.createGain();
        silentGainNode.gain.value = 0;

        const durableBridge = window.desktopBridge?.composerDrafts;
        const durableJobId = origin && durableBridge ? globalThis.crypto.randomUUID() : null;
        if (durableJobId && origin && durableBridge) {
          const now = new Date().toISOString();
          await durableBridge.createVoice({
            id: durableJobId,
            threadId: origin.threadId,
            ...(origin.providerThreadId ? { providerThreadId: origin.providerThreadId } : {}),
            cwd: origin.cwd,
            sampleRateHz: audioContext.sampleRate,
            state: "recording",
            committedBytes: 0,
            lastSequence: -1,
            createdAt: now,
            updatedAt: now,
          });
        }

        const runtime: RecorderRuntime = {
          audioContext,
          sourceNode,
          processorNode,
          silentGainNode,
          stream,
          chunker: new RollingVoiceChunker(audioContext.sampleRate),
          completedChunks: [],
          startedAt: performance.now(),
          durableJobId,
          durableAppendTail: Promise.resolve(),
          durableError: null,
          durablePending: [],
          durablePendingSampleCount: 0,
          durableSequence: 0,
        };

        processorNode.onaudioprocess = (event) => {
          const inputBuffer = event.inputBuffer;
          const channelCount = inputBuffer.numberOfChannels;
          const frameCount = inputBuffer.length;
          const monoSamples = new Float32Array(frameCount);

          for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
            const channelData = inputBuffer.getChannelData(channelIndex);
            for (let sampleIndex = 0; sampleIndex < frameCount; sampleIndex += 1) {
              monoSamples[sampleIndex] =
                (monoSamples[sampleIndex] ?? 0) + (channelData[sampleIndex] ?? 0);
            }
          }

          const normalizer = channelCount > 0 ? channelCount : 1;
          for (let sampleIndex = 0; sampleIndex < frameCount; sampleIndex += 1) {
            monoSamples[sampleIndex] = (monoSamples[sampleIndex] ?? 0) / normalizer;
          }

          for (const chunk of runtime.chunker.push(monoSamples)) {
            runtime.completedChunks.push(encodeChunk(chunk));
          }
          if (durableBridge && runtime.durableJobId) {
            queueDurableSamples(runtime, durableBridge, monoSamples, false);
          }

          const rmsLevel = Math.min(
            1,
            Math.sqrt(
              monoSamples.reduce((sum, sample) => sum + sample * sample, 0) /
                Math.max(1, monoSamples.length),
            ) * 3.2,
          );
          const now = performance.now();
          if (now - waveformLastEmitAtRef.current >= WAVEFORM_EMIT_INTERVAL_MS) {
            waveformLastEmitAtRef.current = now;
            const nextLevels = [...waveformLevelsRef.current, rmsLevel].slice(
              -MAX_WAVEFORM_SAMPLES,
            );
            waveformLevelsRef.current = nextLevels;
            setWaveformLevels(nextLevels);
          }
        };

        sourceNode.connect(processorNode);
        processorNode.connect(silentGainNode);
        silentGainNode.connect(audioContext.destination);

        runtimeRef.current = runtime;
        for (const track of stream.getTracks()) {
          track.addEventListener(
            "ended",
            () => {
              if (runtimeRef.current === runtime) {
                void teardownRuntime();
              }
            },
            { once: true },
          );
        }
        waveformLevelsRef.current = [];
        waveformLastEmitAtRef.current = 0;
        setWaveformLevels([]);
        setDurationMs(0);
        setIsRecording(true);
        timerRef.current = window.setInterval(() => {
          const activeRuntime = runtimeRef.current;
          if (!activeRuntime) {
            return;
          }
          setDurationMs(Math.max(0, performance.now() - activeRuntime.startedAt));
        }, 200);
      } catch (error) {
        processorNode?.disconnect();
        sourceNode?.disconnect();
        silentGainNode?.disconnect();
        stream?.getTracks().forEach((track) => track.stop());
        await audioContext?.close().catch(() => undefined);
        throw error;
      }
    },
    [teardownRuntime],
  );

  const stopRecording = useCallback(async (): Promise<CapturedVoiceRecordingPayload | null> => {
    const recorded = await teardownRuntime();
    if (!recorded) {
      return null;
    }

    const chunks = [...recorded.chunks];
    if (chunks.length === 0) {
      return null;
    }

    return {
      chunks,
      durationMs: Math.max(1, Math.round(recorded.durationMs)),
      ...(recorded.durableVoiceDraftId
        ? { durableVoiceDraftId: recorded.durableVoiceDraftId }
        : {}),
    };
  }, [teardownRuntime]);

  const cancelRecording = useCallback(async () => {
    await teardownRuntime("discard");
    waveformLevelsRef.current = [];
    waveformLastEmitAtRef.current = 0;
    setWaveformLevels([]);
  }, [teardownRuntime]);

  useEffect(
    () => () => {
      void teardownRuntime();
    },
    [teardownRuntime],
  );

  return {
    isRecording,
    durationMs,
    waveformLevels,
    startRecording,
    stopRecording,
    cancelRecording,
  };
}

function queueDurableSamples(
  runtime: RecorderRuntime,
  bridge: NonNullable<NonNullable<Window["desktopBridge"]>["composerDrafts"]>,
  samples: Float32Array | null,
  force: boolean,
): void {
  if (!runtime.durableJobId || runtime.durableError) return;
  if (samples && samples.length > 0) {
    const copy = samples.slice();
    runtime.durablePending.push(copy);
    runtime.durablePendingSampleCount += copy.length;
  }
  const checkpointSamples = Math.max(
    1,
    Math.round((runtime.audioContext.sampleRate * DURABLE_CHECKPOINT_MS) / 1_000),
  );
  if (!force && runtime.durablePendingSampleCount < checkpointSamples) return;
  if (runtime.durablePendingSampleCount === 0) return;

  const merged = new Float32Array(runtime.durablePendingSampleCount);
  let offset = 0;
  for (const chunk of runtime.durablePending) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  runtime.durablePending = [];
  runtime.durablePendingSampleCount = 0;
  const bytes = encodeFloat32LittleEndian(merged);
  const sequence = runtime.durableSequence;
  runtime.durableSequence += 1;
  runtime.durableAppendTail = runtime.durableAppendTail
    .then(() =>
      bridge.appendVoice({
        id: runtime.durableJobId!,
        sequence,
        bytes,
      }),
    )
    .then(() => undefined)
    .catch((error: unknown) => {
      runtime.durableError = error;
    });
}

function encodeFloat32LittleEndian(samples: Float32Array): Uint8Array {
  const bytes = new Uint8Array(samples.length * 4);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < samples.length; index += 1) {
    view.setFloat32(index * 4, samples[index] ?? 0, true);
  }
  return bytes;
}

export async function serializeCapturedVoiceRecording(
  recording: CapturedVoiceRecordingPayload,
): Promise<VoiceRecordingPayload> {
  return {
    chunks: await Promise.all(
      recording.chunks.map(async (chunk) => ({
        audioBase64: await blobToBase64(chunk.blob),
        mimeType: "audio/wav" as const,
        sampleRateHz: VOICE_TARGET_SAMPLE_RATE_HZ,
        durationMs: chunk.durationMs,
      })),
    ),
    durationMs: recording.durationMs,
  };
}

function encodeChunk(chunk: RawVoiceChunk): EncodedVoiceChunk {
  const wavBytes = encodeVoiceChunkWav(chunk);
  return {
    blob: new Blob([wavBytes], { type: "audio/wav" }),
    durationMs: chunk.durationMs,
  };
}

async function blobToBase64(blob: Blob): Promise<string> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
        return;
      }
      reject(new Error("Failed to read recorded audio."));
    });
    reader.addEventListener("error", () => {
      reject(reader.error ?? new Error("Failed to read recorded audio."));
    });
    reader.readAsDataURL(blob);
  });
  const commaIndex = dataUrl.indexOf(",");
  return commaIndex >= 0 ? dataUrl.slice(commaIndex + 1) : dataUrl;
}
