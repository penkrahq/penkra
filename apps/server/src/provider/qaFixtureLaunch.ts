import * as fs from "node:fs";
import * as path from "node:path";

/** A scripted provider can run only in an explicitly built, disposable Dev QA instance. */
export function qaFixtureLaunchAllowed(input: {
  readonly buildEnabled: boolean;
  readonly stateDir: string;
  readonly env: NodeJS.ProcessEnv;
}): boolean {
  if (
    !input.buildEnabled ||
    input.env.PENKRA_DESKTOP_FLAVOR !== "development" ||
    input.env.PENKRA_DIAGNOSTICS_QA_PROVIDER_SOURCE !== "scripted-fixture" ||
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(
      input.env.PENKRA_DIAGNOSTICS_QA_RUN_ID ?? "",
    ) ||
    !/^[0-9a-f]{64}$/u.test(input.env.PENKRA_DIAGNOSTICS_QA_SECRET ?? "")
  )
    return false;
  try {
    const stateDir = fs.realpathSync(input.stateDir);
    const tmpRoot = fs.realpathSync("/tmp");
    const relative = path.relative(tmpRoot, stateDir).split(path.sep);
    const qaSegment = relative[0];
    if (
      relative.length !== 4 ||
      !qaSegment ||
      !/^penkra-diagnostics-qa-0143\.[A-Za-z0-9]+$/u.test(qaSegment) ||
      relative[1] !== "root" ||
      relative[2] !== ".penkra" ||
      relative[3] !== "dev"
    )
      return false;
    const qaRoot = path.join(tmpRoot, qaSegment);
    return (
      fs.realpathSync(input.env.PENKRA_ROOT ?? "") === path.join(qaRoot, "root") &&
      fs.realpathSync(input.env.PENKRA_DIAGNOSTICS_QA_PROOF_DIR ?? "") ===
        path.join(qaRoot, "proofs")
    );
  } catch {
    return false;
  }
}
