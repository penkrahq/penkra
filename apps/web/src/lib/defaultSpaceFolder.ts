import { ContainerId, type SpaceId } from "@penkra/contracts";

export function defaultSpaceFolderId(spaceId: SpaceId): ContainerId {
  return ContainerId.makeUnsafe(`penkra-default-folder:${spaceId}`);
}
