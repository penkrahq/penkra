// FILE: ThreadPublisher.ts
// Purpose: The one shared in-memory thread change publisher (0.14.4 design 2.2).
// Windows subscribe to receive changed rows; there is no persisted stream.
// Layer: Server clean core
// Exports: ThreadPublisher, ThreadPublisherLive

import * as Layer from "effect/Layer";
import * as ServiceMap from "effect/ServiceMap";
import { Effect } from "effect";

import {
  makeThreadPublisher,
  type ThreadPublisher as ThreadPublisherValue,
} from "./threadStore.ts";

export class ThreadPublisher extends ServiceMap.Service<ThreadPublisher, ThreadPublisherValue>()(
  "penkra/cleanCore/ThreadPublisher",
) {}

export const ThreadPublisherLive = Layer.effect(
  ThreadPublisher,
  Effect.acquireRelease(Effect.sync(makeThreadPublisher), (publisher) => publisher.close),
);
