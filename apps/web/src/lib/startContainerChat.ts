// FILE: startContainerChat.ts
// Purpose: Shared "ensure the hidden container project, then open a thread inside it" flow
//          used by the home-chat hook.
// Layer: Web orchestration helper
// Exports: Container-chat startup plus active-surface draft selection.

import type { FolderId, SpaceId, ThreadId } from "@penkra/contracts";
import type { NewThreadOptions } from "./threadBootstrap";

export type StartContainerChatResult =
  | { ok: true; threadId: ThreadId | null }
  | { ok: false; error: string };

type StartContainerChat = () => Promise<StartContainerChatResult>;

/**
 * Selects the unused draft or starts a chat in the managed chat container.
 */
export function startChatForActiveSurface(input: {
  readonly handleNewChat: StartContainerChat;
}): Promise<StartContainerChatResult> {
  return input.handleNewChat();
}

/**
 * Resolves (creating if needed) the backing container project, then starts a thread inside it.
 * The container resolver and user-facing failure label are supplied by the caller.
 */
export async function startContainerChat(input: {
  readonly ensureFolderId: () => Promise<FolderId | null>;
  readonly handleNewThread: (
    folderId: FolderId,
    options?: NewThreadOptions,
  ) => Promise<ThreadId | null>;
  readonly spaceId?: SpaceId | null | undefined;
  readonly errorLabel: string;
}): Promise<StartContainerChatResult> {
  try {
    const folderId = await input.ensureFolderId();
    if (!folderId) {
      return { ok: false, error: input.errorLabel };
    }
    const threadOptions: NewThreadOptions | undefined =
      input.spaceId === undefined ? undefined : { spaceId: input.spaceId };
    const threadId = await input.handleNewThread(folderId, threadOptions);
    return { ok: true, threadId };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : input.errorLabel,
    };
  }
}
