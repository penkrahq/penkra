import type { SpaceId } from "@penkra/contracts";
import { useFocusedChatContext } from "../focusedChatContext";
import { defaultSpaceFolderId } from "../lib/defaultSpaceFolder";
import { startContainerChat, type StartContainerChatResult } from "../lib/startContainerChat";
import { useSpacesUiStore } from "../spacesUiStore";
import { useStore } from "../store";
import { useHandleNewThread } from "./useHandleNewThread";

export function useHandleNewChat(
  handleNewThreadOverride?: ReturnType<typeof useHandleNewThread>["handleNewThread"],
) {
  const folders = useStore((state) => state.folders);
  const activeSpaceId = useSpacesUiStore((state) => state.activeSpaceId);
  const { activeFolderId } = useFocusedChatContext();
  const { handleNewThread: defaultHandleNewThread } = useHandleNewThread();
  const handleNewThread = handleNewThreadOverride ?? defaultHandleNewThread;

  const handleNewChat = async (options?: {
    fresh?: boolean;
    spaceId?: SpaceId | null;
  }): Promise<StartContainerChatResult> => {
    const spaceId = options?.spaceId !== undefined ? options.spaceId : activeSpaceId;
    if (!spaceId) {
      return {
        ok: false,
        error: "Choose a Space before starting a thread.",
      };
    }

    const spaceFolders = folders.filter((project) => project.spaceId === spaceId);
    const preferredFolderId = defaultSpaceFolderId(spaceId);
    const targetFolder =
      spaceFolders.find((project) => project.id === activeFolderId) ??
      spaceFolders.find((project) => project.id === preferredFolderId) ??
      spaceFolders[0] ??
      null;

    return startContainerChat({
      ensureFolderId: async () => targetFolder?.id ?? null,
      handleNewThread,
      fresh: options?.fresh,
      spaceId,
      errorLabel: "Add a folder to this Space before starting a thread.",
    });
  };

  return { handleNewChat };
}
