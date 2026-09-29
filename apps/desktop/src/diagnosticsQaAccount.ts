import * as path from "node:path";

/** Unlocks only a disposable Dev smoke profile for scripted diagnostics QA. */
export function diagnosticsQaAccountEnabled(input: {
  readonly isPackaged: boolean;
  readonly isDevelopment: boolean;
  readonly root: string;
  readonly smokeProfile: string | undefined;
  readonly proofDir: string | undefined;
  readonly runId: string | undefined;
  readonly secret: string | undefined;
}): boolean {
  const root = path.resolve(input.root);
  return (
    !input.isPackaged &&
    input.isDevelopment &&
    /^\/tmp\/penkra-diagnostics-qa-0143\.[A-Za-z0-9]+$/u.test(root) &&
    !!input.smokeProfile &&
    path.resolve(input.smokeProfile) === path.join(root, "electron-profile") &&
    input.proofDir === path.join(root, "proofs") &&
    /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(input.runId ?? "") &&
    /^[0-9a-f]{64}$/u.test(input.secret ?? "")
  );
}
