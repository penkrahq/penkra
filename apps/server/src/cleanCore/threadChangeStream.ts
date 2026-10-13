// Purpose: Independent PubSub consumers for the WebSocket thread and sidebar channels.
import { ThreadId } from "@penkra/contracts";
import { Stream } from "effect";
import type { ThreadPublisher } from "./threadStore.ts";

export const threadChangeStream = (publisher: ThreadPublisher, threadId: string) =>
  Stream.fromPubSub(publisher.threadChanges).pipe(
    Stream.filter((change) => change.threadId === threadId),
    Stream.map((change) => ({ threadId: ThreadId.makeUnsafe(change.threadId) })),
  );

export const sidebarChangeStream = (publisher: ThreadPublisher) =>
  Stream.fromPubSub(publisher.sidebarChanges);
