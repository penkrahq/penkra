// FILE: shellMutation.ts
// Purpose: Gives shell-changing commands a read-your-writes convergence boundary.

import type { ClientOrchestrationCommand, NativeApi } from "@penkra/contracts";

import { useStore } from "~/store";

export async function dispatchShellCommand(
  api: NativeApi,
  command: ClientOrchestrationCommand,
): Promise<{ sequence: number }> {
  const receipt = await api.orchestration.dispatchCommand(command);
  if ((useStore.getState().shellSnapshotSequence ?? 0) >= receipt.sequence) {
    return receipt;
  }

  const snapshot = await api.orchestration.getShellSnapshot();
  useStore.getState().syncServerShellSnapshot(snapshot);
  if ((useStore.getState().shellSnapshotSequence ?? 0) < receipt.sequence) {
    throw new Error(
      `The command committed at sequence ${receipt.sequence}, but the shell projection only reached ${snapshot.snapshotSequence}.`,
    );
  }
  return receipt;
}
