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
}

export interface ActiveWorkPowerBlockerOptions {
  readonly blocker: DisplaySleepBlocker;
  readonly onError?: (message: string, error: unknown) => void;
}

function hasActiveWork(state: ActiveWorkState): boolean {
  return state.threadExecution || state.voice;
}

export class ActiveWorkPowerBlocker {
  readonly #stateByOwner = new Map<number, ActiveWorkState>();
  readonly #blocker: DisplaySleepBlocker;
  readonly #onError: (message: string, error: unknown) => void;
  #blockerId: number | null = null;

  constructor(options: ActiveWorkPowerBlockerOptions) {
    this.#blocker = options.blocker;
    this.#onError = options.onError ?? (() => undefined);
  }

  setOwnerState(ownerId: number, state: ActiveWorkState): void {
    if (hasActiveWork(state)) {
      this.#stateByOwner.set(ownerId, state);
    } else {
      this.#stateByOwner.delete(ownerId);
    }
    this.#syncBlocker();
  }

  releaseOwner(ownerId: number): void {
    this.#stateByOwner.delete(ownerId);
    this.#syncBlocker();
  }

  shutdown(): void {
    this.#stateByOwner.clear();
    this.#syncBlocker();
  }

  #syncBlocker(): void {
    if (this.#stateByOwner.size > 0) {
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
}
