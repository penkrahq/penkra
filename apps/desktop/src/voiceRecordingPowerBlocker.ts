// FILE: voiceRecordingPowerBlocker.ts
// Purpose: Keeps the display awake only while one or more trusted renderers record voice.
// Layer: Desktop main-process policy

export interface DisplaySleepBlocker {
  start(type: "prevent-display-sleep"): number;
  stop(id: number): void;
}

export interface VoiceRecordingPowerBlockerOptions {
  readonly blocker: DisplaySleepBlocker;
  readonly onError?: (message: string, error: unknown) => void;
}

export class VoiceRecordingPowerBlocker {
  readonly #recordingIdsByOwner = new Map<number, Set<string>>();
  readonly #blocker: DisplaySleepBlocker;
  readonly #onError: (message: string, error: unknown) => void;
  #blockerId: number | null = null;

  constructor(options: VoiceRecordingPowerBlockerOptions) {
    this.#blocker = options.blocker;
    this.#onError = options.onError ?? (() => undefined);
  }

  setRecordingActive(ownerId: number, recordingId: string, active: boolean): void {
    if (active) {
      const recordingIds = this.#recordingIdsByOwner.get(ownerId) ?? new Set<string>();
      recordingIds.add(recordingId);
      this.#recordingIdsByOwner.set(ownerId, recordingIds);
      this.#startIfNeeded();
      return;
    }

    const recordingIds = this.#recordingIdsByOwner.get(ownerId);
    recordingIds?.delete(recordingId);
    if (recordingIds?.size === 0) {
      this.#recordingIdsByOwner.delete(ownerId);
    }
    this.#stopIfUnused();
  }

  releaseOwner(ownerId: number): void {
    this.#recordingIdsByOwner.delete(ownerId);
    this.#stopIfUnused();
  }

  shutdown(): void {
    this.#recordingIdsByOwner.clear();
    this.#stopIfUnused();
  }

  #startIfNeeded(): void {
    if (this.#blockerId !== null || this.#recordingIdsByOwner.size === 0) return;

    try {
      this.#blockerId = this.#blocker.start("prevent-display-sleep");
    } catch (error) {
      this.#onError("Failed to prevent display sleep during voice recording.", error);
    }
  }

  #stopIfUnused(): void {
    if (this.#recordingIdsByOwner.size > 0 || this.#blockerId === null) return;

    const blockerId = this.#blockerId;
    this.#blockerId = null;
    try {
      this.#blocker.stop(blockerId);
    } catch (error) {
      this.#onError("Failed to release the voice recording display-sleep blocker.", error);
    }
  }
}
