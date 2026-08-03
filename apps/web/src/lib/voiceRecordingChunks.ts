// FILE: voiceRecordingChunks.ts
// Purpose: Splits a continuous microphone stream into bounded overlapping WAV transcription chunks.
// Layer: Client voice utility
// Exports: RollingVoiceChunker, WAV encoding helpers, and voice recording payload contracts.

export const VOICE_TARGET_SAMPLE_RATE_HZ = 24_000;
export const VOICE_CHUNK_DURATION_SECONDS = 75;
export const VOICE_CHUNK_OVERLAP_SECONDS = 3;

export interface VoiceRecordingChunkPayload {
  readonly audioBase64: string;
  readonly mimeType: "audio/wav";
  readonly sampleRateHz: number;
  readonly durationMs: number;
}

export interface VoiceRecordingPayload {
  readonly chunks: readonly VoiceRecordingChunkPayload[];
  readonly durationMs: number;
}

export interface CapturedVoiceRecordingChunk {
  readonly blob: Blob;
  readonly durationMs: number;
}

export interface CapturedVoiceRecordingPayload {
  readonly chunks: readonly CapturedVoiceRecordingChunk[];
  readonly durationMs: number;
  readonly durableVoiceDraftId?: string;
}

export interface RawVoiceChunk {
  readonly samples: Float32Array;
  readonly sampleRateHz: number;
  readonly durationMs: number;
}

/**
 * Owns sample-accurate rolling boundaries. Every completed chunk after the
 * first repeats a short tail from its predecessor so words crossing a hard
 * boundary remain intelligible to the transcription service.
 */
export class RollingVoiceChunker {
  readonly #sampleRateHz: number;
  readonly #targetSampleCount: number;
  readonly #overlapSampleCount: number;
  #pending: Float32Array[] = [];
  #pendingSampleCount = 0;
  #totalCapturedSampleCount = 0;
  #hasUnflushedSamples = false;

  constructor(
    sampleRateHz: number,
    options: {
      readonly chunkDurationSeconds?: number;
      readonly overlapSeconds?: number;
    } = {},
  ) {
    if (!Number.isFinite(sampleRateHz) || sampleRateHz <= 0) {
      throw new Error("Voice chunking requires a positive sample rate.");
    }
    const chunkDurationSeconds = options.chunkDurationSeconds ?? VOICE_CHUNK_DURATION_SECONDS;
    const overlapSeconds = options.overlapSeconds ?? VOICE_CHUNK_OVERLAP_SECONDS;
    if (
      !Number.isFinite(chunkDurationSeconds) ||
      chunkDurationSeconds <= 0 ||
      !Number.isFinite(overlapSeconds) ||
      overlapSeconds < 0 ||
      overlapSeconds >= chunkDurationSeconds
    ) {
      throw new Error("Voice chunking requires an overlap shorter than the chunk.");
    }

    this.#sampleRateHz = sampleRateHz;
    this.#targetSampleCount = Math.max(1, Math.round(sampleRateHz * chunkDurationSeconds));
    this.#overlapSampleCount = Math.min(
      this.#targetSampleCount - 1,
      Math.round(sampleRateHz * overlapSeconds),
    );
  }

  get totalDurationMs(): number {
    return Math.max(0, Math.round((this.#totalCapturedSampleCount / this.#sampleRateHz) * 1_000));
  }

  push(samples: Float32Array): RawVoiceChunk[] {
    if (samples.length === 0) {
      return [];
    }

    const completed: RawVoiceChunk[] = [];
    this.#totalCapturedSampleCount += samples.length;
    let inputOffset = 0;

    while (inputOffset < samples.length) {
      const remainingCapacity = this.#targetSampleCount - this.#pendingSampleCount;
      const take = Math.min(remainingCapacity, samples.length - inputOffset);
      const slice = samples.slice(inputOffset, inputOffset + take);
      this.#pending.push(slice);
      this.#pendingSampleCount += slice.length;
      this.#hasUnflushedSamples = true;
      inputOffset += take;

      if (this.#pendingSampleCount === this.#targetSampleCount) {
        const chunkSamples = mergeFloat32Chunks(this.#pending, this.#pendingSampleCount);
        completed.push(this.#rawChunk(chunkSamples));
        const overlap =
          this.#overlapSampleCount > 0
            ? chunkSamples.slice(chunkSamples.length - this.#overlapSampleCount)
            : new Float32Array(0);
        this.#pending = overlap.length > 0 ? [overlap] : [];
        this.#pendingSampleCount = overlap.length;
        this.#hasUnflushedSamples = false;
      }
    }

    return completed;
  }

  finish(): RawVoiceChunk | null {
    if (!this.#hasUnflushedSamples || this.#pendingSampleCount === 0) {
      this.#pending = [];
      this.#pendingSampleCount = 0;
      return null;
    }
    const samples = mergeFloat32Chunks(this.#pending, this.#pendingSampleCount);
    this.#pending = [];
    this.#pendingSampleCount = 0;
    this.#hasUnflushedSamples = false;
    return this.#rawChunk(samples);
  }

  #rawChunk(samples: Float32Array): RawVoiceChunk {
    return {
      samples,
      sampleRateHz: this.#sampleRateHz,
      durationMs: Math.max(1, Math.round((samples.length / this.#sampleRateHz) * 1_000)),
    };
  }
}

export function encodeVoiceChunkWav(
  chunk: RawVoiceChunk,
  outputSampleRateHz = VOICE_TARGET_SAMPLE_RATE_HZ,
): ArrayBuffer {
  const resampledSamples = resampleLinear(chunk.samples, chunk.sampleRateHz, outputSampleRateHz);
  return encodeMono16BitWav(resampledSamples, outputSampleRateHz);
}

export function captureVoiceRecordingFromFloat32Bytes(input: {
  readonly bytes: Uint8Array;
  readonly sampleRateHz: number;
  readonly durableVoiceDraftId: string;
}): CapturedVoiceRecordingPayload | null {
  const committedByteLength = input.bytes.byteLength - (input.bytes.byteLength % 4);
  if (committedByteLength === 0) return null;
  const samples = new Float32Array(committedByteLength / 4);
  const view = new DataView(input.bytes.buffer, input.bytes.byteOffset, committedByteLength);
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = view.getFloat32(index * 4, true);
  }
  const chunker = new RollingVoiceChunker(input.sampleRateHz);
  const rawChunks: RawVoiceChunk[] = [];
  const batchSize = Math.max(1, Math.round(input.sampleRateHz));
  for (let offset = 0; offset < samples.length; offset += batchSize) {
    rawChunks.push(...chunker.push(samples.subarray(offset, offset + batchSize)));
  }
  const finalChunk = chunker.finish();
  if (finalChunk) rawChunks.push(finalChunk);
  if (rawChunks.length === 0) return null;
  return {
    chunks: rawChunks.map((chunk) => ({
      blob: new Blob([encodeVoiceChunkWav(chunk)], { type: "audio/wav" }),
      durationMs: chunk.durationMs,
    })),
    durationMs: chunker.totalDurationMs,
    durableVoiceDraftId: input.durableVoiceDraftId,
  };
}

function mergeFloat32Chunks(chunks: readonly Float32Array[], totalLength: number): Float32Array {
  const merged = new Float32Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

function resampleLinear(
  samples: Float32Array,
  inputSampleRateHz: number,
  outputSampleRateHz: number,
): Float32Array {
  if (!Number.isFinite(inputSampleRateHz) || inputSampleRateHz <= 0) {
    return new Float32Array(0);
  }
  if (inputSampleRateHz === outputSampleRateHz) {
    return samples.slice();
  }

  const ratio = inputSampleRateHz / outputSampleRateHz;
  const outputLength = Math.max(1, Math.round(samples.length / ratio));
  const output = new Float32Array(outputLength);

  for (let index = 0; index < outputLength; index += 1) {
    const sourceIndex = index * ratio;
    const leftIndex = Math.floor(sourceIndex);
    const rightIndex = Math.min(samples.length - 1, leftIndex + 1);
    const interpolationWeight = sourceIndex - leftIndex;
    const leftValue = samples[leftIndex] ?? 0;
    const rightValue = samples[rightIndex] ?? leftValue;
    output[index] = leftValue + (rightValue - leftValue) * interpolationWeight;
  }

  return output;
}

function encodeMono16BitWav(samples: Float32Array, sampleRateHz: number): ArrayBuffer {
  const dataView = new DataView(new ArrayBuffer(44 + samples.length * 2));

  writeAscii(dataView, 0, "RIFF");
  dataView.setUint32(4, 36 + samples.length * 2, true);
  writeAscii(dataView, 8, "WAVE");
  writeAscii(dataView, 12, "fmt ");
  dataView.setUint32(16, 16, true);
  dataView.setUint16(20, 1, true);
  dataView.setUint16(22, 1, true);
  dataView.setUint32(24, sampleRateHz, true);
  dataView.setUint32(28, sampleRateHz * 2, true);
  dataView.setUint16(32, 2, true);
  dataView.setUint16(34, 16, true);
  writeAscii(dataView, 36, "data");
  dataView.setUint32(40, samples.length * 2, true);

  let offset = 44;
  for (const sample of samples) {
    const clamped = Math.max(-1, Math.min(1, sample));
    const pcm = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    dataView.setInt16(offset, Math.round(pcm), true);
    offset += 2;
  }

  return dataView.buffer;
}

function writeAscii(view: DataView, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}
