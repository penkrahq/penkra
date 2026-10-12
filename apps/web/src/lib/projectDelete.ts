// FILE: projectDelete.ts
// Purpose: Removes a project locally only after the server accepts its deletion.
// Exports: deleteProjectFromClient

import type { NativeApi, FolderId } from "@penkra/contracts";

interface DeleteProjectFromClientInput {
  api: Pick<NativeApi["cleanCore"], "updateNavigation">;
  folderId: FolderId;
  removeDeletedProjectFromClientState: (folderId: FolderId) => void;
}

export async function deleteProjectFromClient(input: DeleteProjectFromClientInput): Promise<void> {
  await input.api.updateNavigation({
    update: {
      action: "folder.delete",
      folderId: input.folderId,
    },
  });
  input.removeDeletedProjectFromClientState(input.folderId);
}
