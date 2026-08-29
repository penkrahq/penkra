// FILE: rollbackScope.ts
// Purpose: Provides strong exception safety for staged App runtime acquisitions.
// Layer: Trusted desktop App runtime

import { AppRuntimeFailureError, appRuntimeOperationFailure } from "./appRuntimeFailure";

type Rollback = () => void | Promise<void>;

export class RollbackScope {
  readonly #entries: Array<{ role: string; rollback: Rollback }> = [];
  #committed = false;

  defer(role: string, rollback: Rollback): void {
    if (this.#committed) throw new Error("Rollback scope is already committed.");
    this.#entries.push({ role, rollback });
  }

  commit(): void {
    this.#committed = true;
    this.#entries.length = 0;
  }

  async fail(message: string, primary: unknown): Promise<never> {
    const secondary: Array<{ role: string; failure: unknown }> = [];
    for (const entry of this.#entries.toReversed()) {
      try {
        await entry.rollback();
      } catch (failure) {
        secondary.push({ role: entry.role, failure });
      }
    }
    this.#entries.length = 0;
    throw new AppRuntimeFailureError(
      appRuntimeOperationFailure({ message, primary, secondary }),
      primary,
    );
  }
}
