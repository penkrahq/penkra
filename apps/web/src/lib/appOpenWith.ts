// FILE: appOpenWith.ts
// Purpose: Folders enabled App handler declarations into flat file-type settings rows.
// Layer: Web UI domain logic

import type { DesktopInstalledApp } from "@penkra/contracts";

type FileHandlerApp = Pick<DesktopInstalledApp, "handlers" | "id" | "name">;

export interface FileHandlerRow {
  extension: string;
  apps: ReadonlyArray<{ id: string; name: string }>;
}

export function collectFileHandlerRows(apps: ReadonlyArray<FileHandlerApp>): FileHandlerRow[] {
  const byExtension = new Map<string, Map<string, { id: string; name: string }>>();
  for (const app of apps) {
    for (const handler of app.handlers) {
      if (handler.intent !== "open-file") continue;
      for (const extension of handler.extensions) {
        const normalized = extension.toLowerCase();
        const candidates = byExtension.get(normalized) ?? new Map();
        candidates.set(app.id, { id: app.id, name: app.name });
        byExtension.set(normalized, candidates);
      }
    }
  }
  return [...byExtension.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([extension, candidates]) => ({
      extension,
      apps: [...candidates.values()].sort((left, right) => left.name.localeCompare(right.name)),
    }));
}

export function fileTypeLabel(extension: string): string {
  const known: Readonly<Record<string, string>> = {
    ".jpeg": "JPEG",
    ".jpg": "JPEG",
    ".md": "Markdown",
    ".pdf": "PDF",
    ".png": "PNG",
    ".svg": "SVG",
    ".txt": "Text",
  };
  return known[extension] ?? extension.slice(1).toUpperCase();
}
