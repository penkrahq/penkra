import { FolderId, type SpaceId } from "@penkra/contracts";

export function defaultSpaceFolderId(spaceId: SpaceId): FolderId {
  return FolderId.make(`penkra-default-folder:${spaceId}`);
}
