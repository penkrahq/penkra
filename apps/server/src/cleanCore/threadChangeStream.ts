// Purpose: Independent PubSub consumers for the WebSocket thread and sidebar channels.
import { ThreadId } from "@penkra/contracts";
import { Stream } from "effect";
import type { ThreadPublisher } from "./threadStore.ts";

export const threadChangeStream = (publisher: ThreadPublisher, threadId: string) =>
  publisher.threadChanges
    .stream(threadId, { threadId })
    .pipe(Stream.map((change) => ({ threadId: ThreadId.makeUnsafe(change.threadId) })));

export const sidebarChangeStream = (publisher: ThreadPublisher) =>
  publisher.sidebarChanges.stream();
