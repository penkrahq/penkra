// FILE: stagedDraftNavigation.ts
// Purpose: Serializes draft-route creation per owning container and finalizes staged drafts only
//          after their destination route actually commits.
// Layer: Web navigation orchestration

const inFlightDraftNavigationBySlot = new Map<string, Promise<unknown>>();

export function draftNavigationSlotKey(
  container: { kind: "deck" | "folder"; id: string },
  entryPoint: string,
): string {
  return `${container.kind}\u0000${container.id}\u0000${entryPoint}`;
}

/** Coalesces repeated clicks/shortcuts that target the same container + entry-point slot. */
export function runDraftNavigationOnce<T>(slotKey: string, run: () => Promise<T>): Promise<T> {
  const existing = inFlightDraftNavigationBySlot.get(slotKey) as Promise<T> | undefined;
  if (existing) {
    return existing;
  }

  const operation = Promise.resolve().then(run);
  inFlightDraftNavigationBySlot.set(slotKey, operation);
  const clearOperation = () => {
    if (inFlightDraftNavigationBySlot.get(slotKey) === operation) {
      inFlightDraftNavigationBySlot.delete(slotKey);
    }
  };
  void operation.then(clearOperation, clearOperation);
  return operation;
}

/**
 * Keeps the previous routed draft alive while the destination loads. A superseding navigation
 * rolls the staged draft back without treating the user's newer navigation as an error.
 */
export async function stageDraftNavigation(input: {
  readonly stage: () => void;
  readonly navigate: () => Promise<void>;
  readonly isDestinationActive: () => boolean;
  readonly finalize: () => void;
  readonly rollback: () => void;
}): Promise<boolean> {
  let rolledBack = false;
  const rollbackOnce = () => {
    if (rolledBack) {
      return;
    }
    rolledBack = true;
    input.rollback();
  };

  try {
    input.stage();
    await input.navigate();
    if (!input.isDestinationActive()) {
      rollbackOnce();
      return false;
    }
    input.finalize();
    return true;
  } catch (error) {
    rollbackOnce();
    throw error;
  }
}
