import type { SpaceId } from "@penkra/contracts";
import { ensureHomeChatProject } from "../lib/chatProjects";
import { startContainerChat, type StartContainerChatResult } from "../lib/startContainerChat";
import { useWorkspacePathsStore } from "../workspacePathsStore";
import { useSpacesUiStore } from "../spacesUiStore";
import { useHandleNewThread } from "./useHandleNewThread";

export function useHandleNewChat(
  handleNewThreadOverride?: ReturnType<typeof useHandleNewThread>["handleNewThread"],
) {
  const homeDir = useWorkspacePathsStore((state) => state.homeDir);
  const chatWorkspaceRoot = useWorkspacePathsStore((state) => state.chatWorkspaceRoot);
  const activeSpaceId = useSpacesUiStore((state) => state.activeSpaceId);
  const { handleNewThread: defaultHandleNewThread } = useHandleNewThread();
  const handleNewThread = handleNewThreadOverride ?? defaultHandleNewThread;

  const handleNewChat = async (options?: {
    fresh?: boolean;
    spaceId?: SpaceId | null;
  }): Promise<StartContainerChatResult> => {
    if (!homeDir) {
      return {
        ok: false,
        error: "Home folder is not available yet.",
      };
    }

    return startContainerChat({
      ensureProjectId: () => ensureHomeChatProject({ homeDir, chatWorkspaceRoot }),
      handleNewThread,
      fresh: options?.fresh,
      spaceId: options?.spaceId !== undefined ? options.spaceId : activeSpaceId,
      errorLabel: "Unable to prepare a new chat.",
    });
  };

  return { handleNewChat };
}
