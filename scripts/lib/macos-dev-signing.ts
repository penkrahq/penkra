// FILE: macos-dev-signing.ts
// Purpose: Resolve a stable local Apple Development identity for macOS dev apps.

import { spawnSync } from "node:child_process";

export function parseAppleDevelopmentIdentity(output: string): string | null {
  const match = output.match(/"([^"]*Apple Development:[^"]+)"/u);
  return match?.[1] ?? null;
}

export function resolveMacDevelopmentSigningIdentity(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.PENKRA_DEV_CODESIGN_IDENTITY?.trim();
  if (configured) return configured;

  const identities = spawnSync("/usr/bin/security", ["find-identity", "-v", "-p", "codesigning"], {
    encoding: "utf8",
  });
  if (identities.status === 0) {
    const appleDevelopmentIdentity = parseAppleDevelopmentIdentity(identities.stdout);
    if (appleDevelopmentIdentity) return appleDevelopmentIdentity;
  }
  return "-";
}
