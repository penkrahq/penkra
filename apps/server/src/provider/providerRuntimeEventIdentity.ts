import { createHash } from "node:crypto";

import { EventId, type ProviderRuntimeEvent } from "@penkra/contracts";

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Derive a replay-stable canonical id from one provider-native notification.
 * The provider/source/thread namespace prevents unrelated adapters or sessions
 * from colliding when their native payloads happen to be byte-identical.
 */
export function providerRuntimeEventIdFromNative(input: {
  readonly provider: string;
  readonly source: string;
  readonly threadId: string;
  readonly nativeEvent: unknown;
}): EventId {
  const digest = createHash("sha256")
    .update(
      canonicalJson({
        provider: input.provider,
        source: input.source,
        threadId: input.threadId,
        nativeEvent: input.nativeEvent,
      }),
    )
    .digest("hex");
  return EventId.makeUnsafe(`native:${input.provider}:${digest}`);
}

/**
 * One provider-native notification may expand into multiple canonical events.
 * The durable journal keys events by `eventId`, so derived events must receive
 * stable, distinct ids while preserving the native id as their common prefix.
 */
export function assignDerivedProviderRuntimeEventIds(
  events: ReadonlyArray<ProviderRuntimeEvent>,
): ReadonlyArray<ProviderRuntimeEvent> {
  const occurrences = new Map<string, number>();
  for (const event of events) {
    occurrences.set(event.eventId, (occurrences.get(event.eventId) ?? 0) + 1);
  }

  const ordinals = new Map<string, number>();
  return events.map((event) => {
    if ((occurrences.get(event.eventId) ?? 0) <= 1) {
      return event;
    }
    const ordinal = ordinals.get(event.eventId) ?? 0;
    ordinals.set(event.eventId, ordinal + 1);
    return {
      ...event,
      eventId: EventId.makeUnsafe(`${event.eventId}:${event.type}:${ordinal}`),
    };
  });
}
