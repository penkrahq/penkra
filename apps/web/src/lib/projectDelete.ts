// FILE: projectDelete.ts
// Purpose: Removes a project locally only after the server accepts its deletion.
// Exports: deleteProjectFromClient

import type { NativeApi, ContainerId } from "@penkra/contracts";

import { newCommandId } from "./utils";

interface DeleteProjectFromClientInput {
  api: Pick<NativeApi["orchestration"], "dispatchCommand">;
  projectId: ContainerId;
  removeDeletedProjectFromClientState: (projectId: ContainerId) => void;
}

export async function deleteProjectFromClient(input: DeleteProjectFromClientInput): Promise<void> {
  await input.api.dispatchCommand({
    type: "project.delete",
    commandId: newCommandId(),
    projectId: input.projectId,
  });
  input.removeDeletedProjectFromClientState(input.projectId);
}
