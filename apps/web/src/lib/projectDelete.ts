// FILE: projectDelete.ts
// Purpose: Removes a project locally only after the server accepts its deletion.
// Exports: deleteProjectFromClient

import type { NativeApi, FolderId } from "@penkra/contracts";

import { newCommandId } from "./utils";

interface DeleteProjectFromClientInput {
  api: Pick<NativeApi["orchestration"], "dispatchCommand">;
  folderId: FolderId;
  removeDeletedProjectFromClientState: (folderId: FolderId) => void;
}

export async function deleteProjectFromClient(input: DeleteProjectFromClientInput): Promise<void> {
  await input.api.dispatchCommand({
    type: "folder.delete",
    commandId: newCommandId(),
    folderId: input.folderId,
  });
  input.removeDeletedProjectFromClientState(input.folderId);
}
