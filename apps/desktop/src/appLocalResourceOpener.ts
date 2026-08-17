// FILE: appLocalResourceOpener.ts
// Purpose: Routes one validated local resource into an App handle or the operating-system fallback.
// Layer: Trusted desktop App routing boundary

import * as FS from "node:fs";
import * as Path from "node:path";

import type { AppIntentRouter } from "./appIntentRouter";
import { resolvePathIntent } from "./appFileIntentResolver";
import type { AppOpenWithPreferenceStore } from "./appOpenWithPreferences";
import type { AppScopedFileHandleStore } from "./appScopedFileHandleStore";

interface ResourceTab {
  id: string;
  appId: string;
  spaceId: string;
  threadId: string;
}

export async function openLocalAppResource(input: {
  appTabs: {
    currentFor(spaceId: string, threadId: string): ResourceTab | null;
    list(): ReadonlyArray<ResourceTab>;
    present(tabId: string): void;
  };
  broker: {
    invoke(input: {
      app: string;
      operation: string;
      input: unknown;
      spaceId: string;
      threadId: string;
      tabId?: string;
      callerKind: "agent" | "user";
    }): Promise<unknown>;
  };
  callerKind?: "agent" | "user";
  fileHandles: AppScopedFileHandleStore;
  intents: AppIntentRouter;
  openSystem(path: string): Promise<void>;
  openWith: AppOpenWithPreferenceStore;
  path: string;
  requestedApp?: string;
  spaceId: string;
  threadId: string;
}): Promise<unknown> {
  if (!Path.isAbsolute(input.path))
    throw new Error("Penkra open requires a validated absolute path.");
  const path = await FS.promises.realpath(input.path);
  const stats = await FS.promises.stat(path);
  const kind = stats.isDirectory() ? "directory" : stats.isFile() ? "file" : null;
  if (!kind) throw new Error("Only regular files and directories can be opened.");
  const intent = kind === "directory" ? ("open-directory" as const) : ("open-file" as const);
  const resolved = resolvePathIntent({
    intents: input.intents,
    kind,
    openWith: input.openWith,
    path,
    spaceId: input.spaceId,
    ...(input.requestedApp ? { requestedApp: input.requestedApp } : {}),
  });
  if (!resolved) {
    await input.openSystem(path);
    return { destination: "system", intent, path };
  }

  const handle = await input.fileHandles.grant({
    appId: resolved.appId,
    spaceId: input.spaceId,
    path,
    kind,
  });
  const current = input.appTabs.currentFor(input.spaceId, input.threadId);
  const reusableTab =
    current?.appId === resolved.appId
      ? current
      : input.appTabs
          .list()
          .find(
            (tab) =>
              tab.appId === resolved.appId &&
              tab.spaceId === input.spaceId &&
              tab.threadId === input.threadId,
          );
  if (reusableTab) input.appTabs.present(reusableTab.id);
  const result = await input.broker.invoke({
    app: resolved.slug,
    operation: resolved.operation,
    input: { handleId: handle.id, kind: handle.kind, name: handle.name },
    spaceId: input.spaceId,
    threadId: input.threadId,
    ...(reusableTab ? { tabId: reusableTab.id } : {}),
    callerKind: input.callerKind ?? "agent",
  });
  return {
    destination: "app",
    appId: resolved.appId,
    slug: resolved.slug,
    intent,
    path,
    handle,
    result,
  };
}
