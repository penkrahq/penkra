// FILE: activeWorkPowerBlocker.ts
// Purpose: Owns the single native display-sleep assertion for renderer-reported Penkra work.
// Layer: Desktop main-process policy

export interface DisplaySleepBlocker {
  start(type: "prevent-display-sleep"): number;
  stop(id: number): void;
}

export interface ActiveWorkState {
  readonly threadExecution: boolean;
  readonly voice: boolean;
  readonly activeThreadIds?: ReadonlyArray<string>;
  readonly snapshotSequence?: number;
}

export interface ActiveWorkPowerBlockerOptions {
  readonly blocker: DisplaySleepBlocker;
  readonly onError?: (message: string, error: unknown) => void;
  readonly onStateChange?: (input: {
    readonly ownerId: number;
    readonly state: ActiveWorkState | null;
    readonly ownerCount: number;
    readonly latestSnapshotSequence: number | null;
    readonly blocksDisplaySleep: boolean;
  }) => void;
}

function sameReportedActivity(left: ActiveWorkState, right: ActiveWorkState): boolean {
  const leftThreadIds = left.activeThreadIds ?? [];
  const rightThreadIds = right.activeThreadIds ?? [];
  return (
    left.threadExecution === right.threadExecution &&
    left.voice === right.voice &&
    leftThreadIds.length === rightThreadIds.length &&
    leftThreadIds.every((threadId, index) => threadId === rightThreadIds[index])
  );
}

export class ActiveWorkPowerBlocker {
  readonly #stateByOwner = new Map<number, ActiveWorkState>();
  readonly #blocker: DisplaySleepBlocker;
  readonly #onError: (message: string, error: unknown) => void;
  readonly #onStateChange: NonNullable<ActiveWorkPowerBlockerOptions["onStateChange"]>;
  #blockerId: number | null = null;
  #latestSnapshotSequence: number | null = null;

  constructor(options: ActiveWorkPowerBlockerOptions) {
    this.#blocker = options.blocker;
    this.#onError = options.onError ?? (() => undefined);
    this.#onStateChange = options.onStateChange ?? (() => undefined);
  }

  setOwnerState(ownerId: number, state: ActiveWorkState): void {
    const previousState = this.#stateByOwner.get(ownerId);
    const previouslyBlocked = this.#hasActiveWork();
    // Inactive reports remain relevant: a newer app-wide projection must be
    // able to retire an older active report from another window.
    this.#stateByOwner.set(ownerId, state);
    if (state.snapshotSequence !== undefined) {
      this.#latestSnapshotSequence = Math.max(
        this.#latestSnapshotSequence ?? state.snapshotSequence,
        state.snapshotSequence,
      );
    }
    const blocksDisplaySleep = this.#hasActiveWork();
    if (
      previousState === undefined ||
      !sameReportedActivity(previousState, state) ||
      previouslyBlocked !== blocksDisplaySleep
    ) {
      this.#onStateChange({
        ownerId,
        state,
        ownerCount: this.#stateByOwner.size,
        latestSnapshotSequence: this.#latestSnapshotSequence,
        blocksDisplaySleep,
      });
    }
    this.#syncBlocker();
  }

  releaseOwner(ownerId: number): void {
    this.#stateByOwner.delete(ownerId);
    this.#onStateChange({
      ownerId,
      state: null,
      ownerCount: this.#stateByOwner.size,
      latestSnapshotSequence: this.#latestSnapshotSequence,
      blocksDisplaySleep: this.#hasActiveWork(),
    });
    this.#syncBlocker();
  }

  shutdown(): void {
    this.#stateByOwner.clear();
    this.#latestSnapshotSequence = null;
    this.#syncBlocker();
  }

  #syncBlocker(): void {
    if (this.#hasActiveWork()) {
      if (this.#blockerId !== null) return;
      try {
        this.#blockerId = this.#blocker.start("prevent-display-sleep");
      } catch (error) {
        this.#onError("Failed to prevent display sleep during active work.", error);
      }
      return;
    }

    if (this.#blockerId === null) return;
    const blockerId = this.#blockerId;
    this.#blockerId = null;
    try {
      this.#blocker.stop(blockerId);
    } catch (error) {
      this.#onError("Failed to release the active-work display-sleep blocker.", error);
    }
  }

  #hasActiveWork(): boolean {
    const states = [...this.#stateByOwner.values()];
    if (states.some((state) => state.voice)) return true;

    if (this.#latestSnapshotSequence === null) {
      return states.some((state) => state.threadExecution);
    }
    return states.some(
      (state) => state.snapshotSequence === this.#latestSnapshotSequence && state.threadExecution,
    );
  }
}
