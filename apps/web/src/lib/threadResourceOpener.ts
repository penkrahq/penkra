// FILE: threadResourceOpener.ts
// Purpose: Route Thread file references through Penkra's configured App/OS handlers.
// Layer: Web UI resource activation

import type { ThreadId } from "@penkra/contracts";
import { isLocalAbsolutePath, isWorkspaceRelativePathSafe } from "@penkra/shared/path";
import { createContext, useContext } from "react";

import { toastManager } from "../components/ui/toast";

const FILE_POSITION_SUFFIX_PATTERN = /:\d+(?::\d+)?$/;

export interface ThreadResourceOpener {
  openFile(path: string): boolean;
  openUrl(url: string): boolean;
}

export const ThreadResourceOpenerContext = createContext<ThreadResourceOpener | null>(null);

export function useThreadResourceOpener(): ThreadResourceOpener | null {
  return useContext(ThreadResourceOpenerContext);
}

export function resolveThreadResourcePath(
  rawPath: string,
  directory: string | null,
): string | null {
  const path = rawPath.trim().replace(FILE_POSITION_SUFFIX_PATTERN, "");
  if (!path) return null;
  if (isLocalAbsolutePath(path)) return path;
  if (!directory || !isWorkspaceRelativePathSafe(path)) return null;
  return `${directory.replace(/[\\/]+$/, "")}/${path}`;
}

export function createThreadResourceOpener(input: {
  directory: string | null;
  spaceId: string | null;
  threadId: ThreadId;
}): ThreadResourceOpener {
  return {
    openFile: (rawPath) => {
      const path = resolveThreadResourcePath(rawPath, input.directory);
      const bridge = window.desktopBridge?.resources;
      if (!path || !bridge || !input.spaceId) return false;
      void bridge
        .open({ path, spaceId: input.spaceId, threadId: input.threadId })
        .catch((error: unknown) => {
          toastManager.add({
            type: "error",
            title: "Could not open file",
            description: error instanceof Error ? error.message : "The file could not be opened.",
          });
        });
      return true;
    },
    openUrl: (rawUrl) => {
      const url = rawUrl.trim();
      const bridge = window.desktopBridge?.resources;
      if (!/^https?:\/\//i.test(url) || !bridge || !input.spaceId) return false;
      void bridge
        .open({ url, spaceId: input.spaceId, threadId: input.threadId })
        .catch((error: unknown) => {
          toastManager.add({
            type: "error",
            title: "Could not open link",
            description: error instanceof Error ? error.message : "The link could not be opened.",
          });
        });
      return true;
    },
  };
}

export function openThreadUrlReference(opener: ThreadResourceOpener | null, url: string): void {
  if (opener?.openUrl(url)) return;
  toastManager.add({
    type: "error",
    title: "Could not open link",
    description: "No eligible URL handler is available in this Space.",
  });
}

export function openThreadFileReference(opener: ThreadResourceOpener | null, path: string): void {
  if (opener?.openFile(path)) return;
  toastManager.add({
    type: "error",
    title: "Could not open file",
    description: "The file is outside this Thread's directory or no handler is available.",
  });
}
