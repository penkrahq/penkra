// FILE: voiceTranscriptionSequence.ts
// Purpose: Transcribes rolling voice chunks in order and removes repeated overlap from the result.
// Layer: Client voice utility

import type { VoiceRecordingChunkPayload, VoiceRecordingPayload } from "./voiceRecordingChunks";

export interface TranscribeVoiceRecordingOptions {
  readonly recording: VoiceRecordingPayload;
  readonly transcribeChunk: (chunk: VoiceRecordingChunkPayload) => Promise<{ text: string }>;
  readonly isCurrent: () => boolean;
  readonly attemptsPerChunk?: number;
}

export async function transcribeVoiceRecording(
  options: TranscribeVoiceRecordingOptions,
): Promise<string | null> {
  const transcripts: string[] = [];
  const attemptsPerChunk = Math.max(1, Math.floor(options.attemptsPerChunk ?? 2));

  for (const chunk of options.recording.chunks) {
    if (!options.isCurrent()) {
      return null;
    }

    let result: { text: string } | null = null;
    let lastError: unknown;
    for (let attempt = 0; attempt < attemptsPerChunk; attempt += 1) {
      try {
        result = await options.transcribeChunk(chunk);
        break;
      } catch (error) {
        lastError = error;
        if (!options.isCurrent()) {
          return null;
        }
      }
    }
    if (!result) {
      throw lastError;
    }
    if (!options.isCurrent()) {
      return null;
    }
    transcripts.push(result.text);
  }

  return mergeVoiceTranscripts(transcripts);
}

export function mergeVoiceTranscripts(transcripts: readonly string[]): string {
  let merged = "";
  for (const rawTranscript of transcripts) {
    const transcript = rawTranscript.trim();
    if (!transcript) {
      continue;
    }
    if (!merged) {
      merged = transcript;
      continue;
    }

    const leftTokens = tokenizeTranscript(merged);
    const rightTokens = tokenizeTranscript(transcript);
    const maximumOverlap = Math.min(32, leftTokens.length, rightTokens.length);
    let overlapTokenCount = 0;

    for (let count = maximumOverlap; count >= 2; count -= 1) {
      const leftStart = leftTokens.length - count;
      let matches = true;
      for (let index = 0; index < count; index += 1) {
        if (leftTokens[leftStart + index]?.normalized !== rightTokens[index]?.normalized) {
          matches = false;
          break;
        }
      }
      if (matches) {
        overlapTokenCount = count;
        break;
      }
    }

    if (
      overlapTokenCount === 0 &&
      leftTokens.at(-1)?.normalized === rightTokens[0]?.normalized &&
      (rightTokens[0]?.normalized.length ?? 0) >= 8
    ) {
      overlapTokenCount = 1;
    }

    const suffixStart =
      overlapTokenCount > 0
        ? (rightTokens[overlapTokenCount - 1]?.end ?? 0)
        : findCharacterOverlapEnd(merged, transcript);
    let suffix = transcript.slice(suffixStart).trimStart();
    if (
      suffixStart > 0 &&
      /[.!?…]["')\]]?$/u.test(merged.trimEnd()) &&
      /^[,;:.!?…-]/u.test(suffix)
    ) {
      suffix = suffix.replace(/^[,;:.!?…-]+\s*/u, "");
    }
    if (suffix) {
      const left = merged.trimEnd().replace(/(?:\.{3}|…)\s*$/u, "");
      merged = `${left} ${suffix}`;
    }
  }
  return merged;
}

function findCharacterOverlapEnd(left: string, right: string): number {
  const leftCharacters = normalizedTranscriptCharacters(left);
  const rightCharacters = normalizedTranscriptCharacters(right);
  const maximumOverlap = Math.min(240, leftCharacters.values.length, rightCharacters.values.length);

  for (let count = maximumOverlap; count >= 12; count -= 1) {
    const leftStart = leftCharacters.values.length - count;
    let matches = true;
    for (let index = 0; index < count; index += 1) {
      if (leftCharacters.values[leftStart + index] !== rightCharacters.values[index]) {
        matches = false;
        break;
      }
    }
    if (matches) {
      return rightCharacters.ends[count - 1] ?? 0;
    }
  }
  return 0;
}

function normalizedTranscriptCharacters(value: string): {
  readonly values: readonly string[];
  readonly ends: readonly number[];
} {
  const values: string[] = [];
  const ends: number[] = [];
  let offset = 0;
  for (const character of value) {
    offset += character.length;
    const normalized = character.toLocaleLowerCase();
    if (!/[\p{L}\p{N}]/u.test(normalized)) {
      continue;
    }
    values.push(normalized);
    ends.push(offset);
  }
  return { values, ends };
}

interface TranscriptToken {
  readonly normalized: string;
  readonly end: number;
}

function tokenizeTranscript(value: string): TranscriptToken[] {
  const tokens: TranscriptToken[] = [];
  for (const match of value.matchAll(/\S+/gu)) {
    const original = match[0];
    const normalized = original.toLocaleLowerCase().replace(/[^\p{L}\p{N}']/gu, "");
    if (!normalized) {
      continue;
    }
    const start = match.index ?? 0;
    tokens.push({
      normalized,
      end: start + original.length,
    });
  }
  return tokens;
}
