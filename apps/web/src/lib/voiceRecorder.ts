// FILE: voiceRecorder.ts
// Purpose: Captures microphone audio as bounded rolling WAV transcription chunks.
// Layer: Client utility hook
// Exports: useVoiceRecorder, formatVoiceRecordingDuration
// Depends on: browser media devices, Web Audio API, and FileReader for base64 encoding.

import { useCallback, useEffect, useRef, useState } from "react";

import {
  encodeVoiceChunkWav,
  RollingVoiceChunker,
  VOICE_TARGET_SAMPLE_RATE_HZ,
  type RawVoiceChunk,
  type VoiceRecordingPayload,
} from "./voiceRecordingChunks";

interface RecorderRuntime {
  readonly audioContext: AudioContext;
  readonly sourceNode: MediaStreamAudioSourceNode;
  readonly processorNode: ScriptProcessorNode;
  readonly silentGainNode: GainNode;
  readonly stream: MediaStream;
  readonly chunker: RollingVoiceChunker;
  readonly completedChunks: EncodedVoiceChunk[];
  readonly startedAt: number;
}

interface EncodedVoiceChunk {
  readonly blob: Blob;
  readonly durationMs: number;
}

const BUFFER_SIZE = 4_096;
const MAX_WAVEFORM_SAMPLES = 160;

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

  const teardownRuntime = useCallback(async () => {
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

    const finalRawChunk = runtime.chunker.finish();
    if (finalRawChunk) {
      runtime.completedChunks.push(encodeChunk(finalRawChunk));
    }
    const duration = Math.max(0, performance.now() - runtime.startedAt);
    setDurationMs(0);

    return {
      chunks: runtime.completedChunks,
      durationMs: Math.max(runtime.chunker.totalDurationMs, duration),
    };
  }, [clearTimer]);

  const startRecording = useCallback(async () => {
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

      const runtime: RecorderRuntime = {
        audioContext,
        sourceNode,
        processorNode,
        silentGainNode,
        stream,
        chunker: new RollingVoiceChunker(audioContext.sampleRate),
        completedChunks: [],
        startedAt: performance.now(),
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

        const rmsLevel = Math.min(
          1,
          Math.sqrt(
            monoSamples.reduce((sum, sample) => sum + sample * sample, 0) /
              Math.max(1, monoSamples.length),
          ) * 3.2,
        );
        const now = performance.now();
        if (now - waveformLastEmitAtRef.current >= 45) {
          waveformLastEmitAtRef.current = now;
          const nextLevels = [...waveformLevelsRef.current, rmsLevel].slice(-MAX_WAVEFORM_SAMPLES);
          waveformLevelsRef.current = nextLevels;
          setWaveformLevels(nextLevels);
        }
      };

      sourceNode.connect(processorNode);
      processorNode.connect(silentGainNode);
      silentGainNode.connect(audioContext.destination);

      runtimeRef.current = runtime;
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
  }, []);

  const stopRecording = useCallback(async (): Promise<VoiceRecordingPayload | null> => {
    const recorded = await teardownRuntime();
    if (!recorded) {
      return null;
    }

    const chunks = [...recorded.chunks];
    if (chunks.length === 0) {
      return null;
    }

    const payloadChunks = [];
    for (const chunk of chunks) {
      payloadChunks.push({
        audioBase64: await blobToBase64(chunk.blob),
        mimeType: "audio/wav" as const,
        sampleRateHz: VOICE_TARGET_SAMPLE_RATE_HZ,
        durationMs: chunk.durationMs,
      });
    }

    return {
      chunks: payloadChunks,
      durationMs: Math.max(1, Math.round(recorded.durationMs)),
    };
  }, [teardownRuntime]);

  const cancelRecording = useCallback(async () => {
    await teardownRuntime();
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
