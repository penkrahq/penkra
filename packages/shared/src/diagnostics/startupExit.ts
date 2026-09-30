/** Stable backend exit codes for failures before DiagnosticsStore exists. */
export const PRE_STORE_BOOT_EXIT_CODES = {
  pre_store_bootstrap: 70,
  database_lock: 71,
  sqlite_prepare: 72,
  sqlite_open: 73,
  database_migration: 74,
  diagnostics_store: 75,
} as const;

export type PreStoreBootStage = keyof typeof PRE_STORE_BOOT_EXIT_CODES;
export const PRE_STORE_BOOT_STAGES = Object.keys(PRE_STORE_BOOT_EXIT_CODES) as PreStoreBootStage[];

export function preStoreBootStageForExitCode(exitCode: number): PreStoreBootStage | undefined {
  return PRE_STORE_BOOT_STAGES.find((stage) => PRE_STORE_BOOT_EXIT_CODES[stage] === exitCode);
}
