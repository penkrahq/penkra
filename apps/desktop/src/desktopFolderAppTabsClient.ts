// FILE: desktopFolderAppTabsClient.ts
// Purpose: Read and update the folder's App tabs through the authenticated backend, without a window.

import {
  CleanCoreFolderAppTabsResult,
  type CleanCoreUpdateFolderAppTabsInput,
  FolderId,
  CleanCoreListFolderAppTabsResult,
} from "@penkra/contracts";
import { Schema } from "effect";

const FolderAppTabs = Schema.Struct({
  ...CleanCoreFolderAppTabsResult.fields,
  folderTitle: Schema.String,
});
type FolderAppTabs = typeof FolderAppTabs.Type;
type Backend = { url: string; token: string; fetcher?: typeof fetch };
const folderWrites = new Map<string, Promise<void>>();

async function request(backend: Backend, input: unknown): Promise<unknown> {
  const response = await (backend.fetcher ?? fetch)(`${backend.url}/api/desktop/folder-app-tabs`, {
    method: "POST",
    headers: { Authorization: `Bearer ${backend.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = (await response.json()) as { ok?: unknown; result?: unknown; message?: unknown };
  if (body.ok !== true)
    throw new Error(
      typeof body.message === "string" ? body.message : "Folder App-tab operation failed.",
    );
  return body.result;
}

export async function readDesktopFolderAppTabs(
  backend: Backend,
  folderId: string,
): Promise<FolderAppTabs | null> {
  return Schema.decodeUnknownSync(Schema.NullOr(FolderAppTabs))(
    await request(backend, { action: "get", folderId: FolderId.make(folderId) }),
  );
}

export function updateDesktopFolderAppTabs(
  backend: Backend,
  input: CleanCoreUpdateFolderAppTabsInput,
): Promise<FolderAppTabs>;
export function updateDesktopFolderAppTabs(
  backend: Backend,
  input: CleanCoreUpdateFolderAppTabsInput,
  authorize: () => boolean,
): Promise<FolderAppTabs | null>;
export async function updateDesktopFolderAppTabs(
  backend: Backend,
  input: CleanCoreUpdateFolderAppTabsInput,
  authorize?: () => boolean,
): Promise<FolderAppTabs | null> {
  const key = JSON.stringify([backend.url, input.folderId]);
  const previous = folderWrites.get(key);
  const write = (previous === undefined ? Promise.resolve() : previous.catch(() => undefined)).then(
    async () => {
      if (authorize && !authorize()) return null;
      const result = Schema.decodeUnknownSync(Schema.NullOr(FolderAppTabs))(
        await request(backend, { action: "update", ...input }),
      );
      if (result === null) throw new Error("The folder is not available.");
      return result;
    },
  );
  const completion = write.then(
    () => undefined,
    () => undefined,
  );
  folderWrites.set(key, completion);
  try {
    return await write;
  } finally {
    if (folderWrites.get(key) === completion) folderWrites.delete(key);
  }
}

export async function listDesktopFolderAppTabs(backend: Backend, afterFolderId?: string) {
  return Schema.decodeUnknownSync(CleanCoreListFolderAppTabsResult)(
    await request(backend, {
      action: "list",
      ...(afterFolderId === undefined ? {} : { afterFolderId: FolderId.make(afterFolderId) }),
    }),
  );
}
