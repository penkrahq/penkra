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
  showFileContextMenu(path: string, position: { x: number; y: number }): boolean;
  showUrlContextMenu(url: string, position: { x: number; y: number }): boolean;
}

export const ThreadResourceOpenerContext = createContext<ThreadResourceOpener | null>(null);

export function useThreadResourceOpener(): ThreadResourceOpener | null {
  return useContext(ThreadResourceOpenerContext);
}

export function showThreadResourceContextMenu(input: {
  opener: ThreadResourceOpener;
  target: EventTarget | null;
  position: { x: number; y: number };
}): boolean {
  const element = input.target instanceof Element ? input.target : null;
  if (!element) return false;

  const pathElement = element.closest<HTMLElement>("[data-thread-resource-path]");
  const path = pathElement?.dataset.threadResourcePath;
  if (path) return input.opener.showFileContextMenu(path, input.position);

  const urlElement = element.closest<HTMLElement>("[data-thread-resource-url]");
  const declaredUrl = urlElement?.dataset.threadResourceUrl;
  if (declaredUrl) return input.opener.showUrlContextMenu(declaredUrl, input.position);

  const anchor = element.closest<HTMLAnchorElement>("a[href]");
  const href = anchor?.getAttribute("href")?.trim();
  return href && /^https?:\/\//i.test(href)
    ? input.opener.showUrlContextMenu(href, input.position)
    : false;
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
  const showContextMenu = (
    resource: { path: string } | { url: string },
    position: { x: number; y: number },
  ): boolean => {
    const bridge = window.desktopBridge?.resources;
    if (!bridge || !input.spaceId) return false;
    void bridge
      .showContextMenu({
        ...resource,
        spaceId: input.spaceId,
        threadId: input.threadId,
        position,
      })
      .catch((error: unknown) => {
        toastManager.add({
          type: "error",
          title: "Could not show destinations",
          description:
            error instanceof Error ? error.message : "The resource destinations are unavailable.",
        });
      });
    return true;
  };

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
    showFileContextMenu: (rawPath, position) => {
      const path = resolveThreadResourcePath(rawPath, input.directory);
      if (!path) return false;
      return showContextMenu({ path }, position);
    },
    showUrlContextMenu: (rawUrl, position) => {
      const url = rawUrl.trim();
      if (!/^https?:\/\//i.test(url)) return false;
      return showContextMenu({ url }, position);
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
    description: "The file path or resource handler is unavailable.",
  });
}
