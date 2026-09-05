import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { findNativeUpgradeProcesses } from "./native-upgrade-processes";

it("selects only exact inherited profile markers, including relocated executables", () => {
  const root = mkdtempSync(join(tmpdir(), "native-upgrade-proc-"));
  try {
    const environments = {
      11: "APPIMAGE=/tmp/extracted\0PENKRA_DESKTOP_SMOKE_USER_DATA=/owned/profile\0",
      12: "PENKRA_DESKTOP_SMOKE_USER_DATA=/owned/profile-other\0",
      13: "OTHER=PENKRA_DESKTOP_SMOKE_USER_DATA=/owned/profile\0",
      [process.pid]: "PENKRA_DESKTOP_SMOKE_USER_DATA=/owned/profile\0",
    };
    for (const [pid, environment] of Object.entries(environments)) {
      mkdirSync(join(root, pid));
      writeFileSync(join(root, pid, "environ"), environment);
    }
    mkdirSync(join(root, "999999")); // Process exited during enumeration.
    expect(findNativeUpgradeProcesses("/owned/profile", root)).toEqual([11]);
  } finally {
    rmSync(root, { recursive: true });
  }
});
