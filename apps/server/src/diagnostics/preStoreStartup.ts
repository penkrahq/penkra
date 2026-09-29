import {
  PRE_STORE_BOOT_EXIT_CODES,
  type PreStoreBootStage,
} from "@penkra/shared/diagnostics/startupExit";

let failureStage: PreStoreBootStage = "pre_store_bootstrap";
let storeReady = false;

export function notePreStoreBootFailure(stage: PreStoreBootStage): void {
  if (!storeReady) failureStage = stage;
}

export function noteDiagnosticsStoreReady(): void {
  storeReady = true;
}

/** Preserve the runtime's signal and post-store exit codes. */
export function serverExitCodeForRuntimeCode(code: number): number {
  return code === 1 && !storeReady ? PRE_STORE_BOOT_EXIT_CODES[failureStage] : code;
}
