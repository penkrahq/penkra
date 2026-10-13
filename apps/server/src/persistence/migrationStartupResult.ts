// The persistence startup owns this process-local result; /status only reads it.
export type MigrationStartupResult =
  | { readonly status: "pending" }
  | { readonly status: "ok" }
  | { readonly status: "failed"; readonly reason: string };
let result: MigrationStartupResult = { status: "pending" };
export const recordMigrationStartupResult = (next: MigrationStartupResult): void => {
  result = next;
};
export const readMigrationStartupResult = (): MigrationStartupResult => result;
