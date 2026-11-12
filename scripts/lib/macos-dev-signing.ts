// FILE: macos-dev-signing.ts
// Purpose: Resolve a stable local Apple Development identity for macOS dev apps.
// macOS keys Accessibility and Screen Recording grants to the signature, so every dev launcher and
// runtime must keep signing with the same certificate. With several Apple Development
// certificates in the keychain, "the first one listed" changes as certificates come and go; the
// first choice is pinned by its SHA-1 and reused for as long as it stays valid.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

interface CodesignIdentity {
  readonly sha1: string;
  readonly name: string;
}

export function parseCodesignIdentities(output: string): CodesignIdentity[] {
  return [...output.matchAll(/^\s*\d+\)\s+([0-9A-F]+)\s+"([^"]+)"/gmu)].map((match) => ({
    sha1: match[1]!,
    name: match[2]!,
  }));
}

export function parseAppleDevelopmentIdentity(output: string): string | null {
  return (
    parseCodesignIdentities(output).find((identity) => identity.name.includes("Apple Development:"))
      ?.name ?? null
  );
}

export function macDevelopmentSigningPinPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.PENKRA_DEV_CODESIGN_PIN?.trim() || join(homedir(), "Penkra_Dev", ".codesign-identity");
}

export function resolveMacDevelopmentSigningIdentity(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.PENKRA_DEV_CODESIGN_IDENTITY?.trim();
  if (configured) return configured;

  const identities = spawnSync("/usr/bin/security", ["find-identity", "-v", "-p", "codesigning"], {
    encoding: "utf8",
  });
  if (identities.status !== 0) return "-";
  const development = parseCodesignIdentities(identities.stdout).filter((identity) =>
    identity.name.includes("Apple Development:"),
  );
  if (development.length === 0) return "-";

  const pinPath = macDevelopmentSigningPinPath(env);
  const pinned = existsSync(pinPath) ? readFileSync(pinPath, "utf8").trim() : "";
  const kept = development.find((identity) => identity.sha1 === pinned);
  if (kept) return kept.sha1;

  const chosen = development[0]!;
  try {
    mkdirSync(dirname(pinPath), { recursive: true });
    writeFileSync(pinPath, `${chosen.sha1}\n`);
  } catch {
    // Unwritable home: still sign, just without the pin.
  }
  return chosen.sha1;
}
