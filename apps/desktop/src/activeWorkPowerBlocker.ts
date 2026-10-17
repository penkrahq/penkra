// One native assertion: server-owned working threads OR voice in any renderer.
export interface DisplaySleepBlocker {
  start(type: "prevent-display-sleep"): number;
  stop(id: number): void;
}
export interface ActiveWorkPowerBlockerOptions {
  readonly blocker: DisplaySleepBlocker;
  readonly onError?: (message: string, error: unknown) => void;
  readonly onStateChange?: (state: {
    working: ReadonlyArray<string>;
    voiceOwners: ReadonlyArray<number>;
    blocksDisplaySleep: boolean;
  }) => void;
}
export class ActiveWorkPowerBlocker {
  readonly #voiceOwners = new Set<number>();
  readonly #options: ActiveWorkPowerBlockerOptions;
  #working: ReadonlyArray<string> = [];
  #blockerId: number | null = null;
  constructor(options: ActiveWorkPowerBlockerOptions) {
    this.#options = options;
  }
  setWorkingThreads(working: ReadonlyArray<string>): void {
    const changed =
      this.#working.length !== working.length || this.#working.some((id, i) => id !== working[i]);
    this.#working = [...working];
    if (changed) this.#report();
    this.#sync();
  }
  setVoice(ownerId: number, active: boolean): void {
    const changed = this.#voiceOwners.has(ownerId) !== active;
    if (active) this.#voiceOwners.add(ownerId);
    else this.#voiceOwners.delete(ownerId);
    if (changed) this.#report();
    this.#sync();
  }
  releaseOwner(ownerId: number): void {
    this.setVoice(ownerId, false);
  }
  shutdown(): void {
    this.#working = [];
    this.#voiceOwners.clear();
    this.#report();
    this.#sync();
  }
  #hasWork(): boolean {
    return this.#working.length > 0 || this.#voiceOwners.size > 0;
  }
  #report(): void {
    this.#options.onStateChange?.({
      working: this.#working,
      voiceOwners: [...this.#voiceOwners],
      blocksDisplaySleep: this.#hasWork(),
    });
  }
  #sync(): void {
    if (this.#hasWork()) {
      if (this.#blockerId !== null) return;
      try {
        this.#blockerId = this.#options.blocker.start("prevent-display-sleep");
      } catch (error) {
        this.#options.onError?.("Failed to prevent display sleep during active work.", error);
      }
      return;
    }
    if (this.#blockerId === null) return;
    const id = this.#blockerId;
    this.#blockerId = null;
    try {
      this.#options.blocker.stop(id);
    } catch (error) {
      this.#options.onError?.("Failed to release the active-work display-sleep blocker.", error);
    }
  }
}
