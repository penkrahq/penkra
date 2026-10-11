// FILE: desktopFolderAppTabsClient.ts
// Purpose: Read and update the folder's App tabs through the authenticated backend, without a window.

import {
  CleanCoreFolderAppTabsResult,
  type CleanCoreUpdateFolderAppTabsInput,
  FolderId,
} from "@penkra/contracts";
import { Schema } from "effect";

const FolderAppTabs = Schema.Struct({
  ...CleanCoreFolderAppTabsResult.fields,
  folderTitle: Schema.String,
});
type FolderAppTabs = typeof FolderAppTabs.Type;
type Backend = { url: string; token: string; fetcher?: typeof fetch };

async function request(backend: Backend, input: unknown): Promise<FolderAppTabs | null> {
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
  return Schema.decodeUnknownSync(Schema.NullOr(FolderAppTabs))(body.result);
}

export function readDesktopFolderAppTabs(
  backend: Backend,
  folderId: string,
): Promise<FolderAppTabs | null> {
  return request(backend, { action: "get", folderId: FolderId.makeUnsafe(folderId) });
}

export async function updateDesktopFolderAppTabs(
  backend: Backend,
  input: CleanCoreUpdateFolderAppTabsInput,
): Promise<FolderAppTabs> {
  const result = await request(backend, { action: "update", ...input });
  if (result === null) throw new Error("The folder is not available.");
  return result;
}
