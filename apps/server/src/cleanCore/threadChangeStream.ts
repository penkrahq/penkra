// FILE: threadChangeStream.ts
// Purpose: Bridge the in-memory ThreadPublisher to an Effect Stream for the ws
// push channel (0.14.4 design 2.2).
// Layer: Server clean core
// Exports: threadChangeStream

import { ThreadId, type CleanCoreThreadChange } from "@penkra/contracts";
import { Effect, Queue, Stream } from "effect";

import type { ThreadPublisher } from "./threadStore.ts";

/** A stream of `{ threadId }` changes for one thread, ending when unsubscribed. */
export const threadChangeStream = (publisher: ThreadPublisher, threadId: string) =>
  Stream.callback<CleanCoreThreadChange>((queue) =>
    Effect.gen(function* () {
      const unsubscribe = publisher.subscribe(threadId, (change) => {
        Effect.runFork(
          Queue.offer(queue, { threadId: ThreadId.makeUnsafe(change.threadId) }).pipe(
            Effect.asVoid,
          ),
        );
      });
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
    }),
  );
