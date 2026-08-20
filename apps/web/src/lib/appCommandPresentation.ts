// FILE: appCommandPresentation.ts
// Purpose: Resolves a Penkra App command to its installed App presentation.
// Layer: UI utility

import type { DesktopAppInstallationSnapshot, DesktopInstalledApp } from "@penkra/contracts";

import { deriveInlineCommandCall } from "./toolCallLabel";

export interface InstalledAppCommandPresentation {
  readonly app: DesktopInstalledApp;
  readonly command: string;
  readonly slug: string;
}

function commandRoot(command: string): string | null {
  const inlineCommand = deriveInlineCommandCall(command).trim();
  const match = /^(?:['"])?([A-Za-z0-9][A-Za-z0-9._-]*)(?:['"])?(?:\s|$)/u.exec(inlineCommand);
  return match?.[1]?.toLowerCase() ?? null;
}

export function resolveInstalledAppCommandPresentation(
  command: string,
  snapshot: DesktopAppInstallationSnapshot | null,
): InstalledAppCommandPresentation | null {
  if (!snapshot) return null;
  const slug = commandRoot(command);
  if (!slug || slug === "penkra") return null;

  const candidates = snapshot.installed.filter((app) => app.slug.toLowerCase() === slug);
  const app =
    candidates.find((candidate) => candidate.spaceId === snapshot.currentSpaceId) ?? candidates[0];
  if (!app) return null;

  return {
    app,
    command: deriveInlineCommandCall(command),
    slug: app.slug,
  };
}
