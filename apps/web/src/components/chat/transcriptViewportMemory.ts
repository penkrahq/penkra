// FILE: transcriptViewportMemory.ts
// Purpose: Keeps bounded, session-only transcript viewport anchors across thread remounts.
// Layer: Web chat infrastructure

export interface TranscriptViewportSnapshot {
  readonly anchorKey: string;
  readonly anchorOffset: number;
  readonly isAtEnd: boolean;
}

const MAX_REMEMBERED_TRANSCRIPT_VIEWPORTS = 32;
const transcriptViewportMemory = new Map<string, TranscriptViewportSnapshot>();

export function readTranscriptViewportSnapshot(
  memoryKey: string,
): TranscriptViewportSnapshot | undefined {
  return transcriptViewportMemory.get(memoryKey);
}

export function saveTranscriptViewportSnapshot(
  memoryKey: string,
  snapshot: TranscriptViewportSnapshot,
): void {
  transcriptViewportMemory.delete(memoryKey);
  transcriptViewportMemory.set(memoryKey, snapshot);
  while (transcriptViewportMemory.size > MAX_REMEMBERED_TRANSCRIPT_VIEWPORTS) {
    const oldestKey = transcriptViewportMemory.keys().next().value as string | undefined;
    if (oldestKey === undefined) break;
    transcriptViewportMemory.delete(oldestKey);
  }
}

export function resetTranscriptViewportMemory(): void {
  transcriptViewportMemory.clear();
}
