// FILE: simulatorHostRuntime.ts
// Purpose: Opens the durable simulator device store and binds it to the lifecycle manager.
// Layer: Trusted desktop simulator host

import type { SimulatorAdapter } from "./simulatorManager";
import { DesktopSimulatorManager } from "./simulatorManager";
import { resolveSimulatorDeviceStatePath, SimulatorDeviceStore } from "./simulatorDeviceStore";

export interface DesktopSimulatorHostRuntime {
  manager: DesktopSimulatorManager;
  store: SimulatorDeviceStore;
  recovery: null | { quarantinedPath: string; error: Error };
  dispose(): Promise<void>;
}

export async function openDesktopSimulatorHostRuntime(input: {
  userDataPath: string;
  adapters: ReadonlyArray<SimulatorAdapter>;
  disposeResources?: () => Promise<void>;
}): Promise<DesktopSimulatorHostRuntime> {
  const { store, recovery } = await SimulatorDeviceStore.openSafe(
    resolveSimulatorDeviceStatePath(input.userDataPath),
  );
  const manager = new DesktopSimulatorManager(input.adapters, {
    initialDevices: store.snapshot().devices,
    persistDevices: async (devices) => {
      await store.replace(devices);
    },
  });
  let disposed = false;
  return {
    manager,
    store,
    recovery,
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      const results = await Promise.allSettled([
        manager.dispose(),
        input.disposeResources?.() ?? Promise.resolve(),
      ]);
      const errors = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (errors.length > 0) throw new AggregateError(errors, "Simulator host cleanup failed.");
    },
  };
}
