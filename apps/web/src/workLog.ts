// Timeline interleaving stays in the web; tool-work derivation is shared with the server.
import type { ChatMessage } from "./types";
import { isTranscriptSeparatorWorkEntry, type WorkLogEntry } from "@penkra/shared/workLog";
export * from "@penkra/shared/workLog";

export type TimelineEntry =
  | {
      id: string;
      kind: "message";
      createdAt: string;
      message: ChatMessage;
    }
  | {
      id: string;
      kind: "work";
      createdAt: string;
      entry: WorkLogEntry;
    };

function timelineEntrySequence(entry: TimelineEntry): number | undefined {
  return entry.kind === "message"
    ? entry.message.delivery?.queued === true && entry.message.delivery.state !== "queued"
      ? entry.message.delivery.sequence
      : entry.message.sequence
    : entry.entry.sequence;
}

function compareTimelineEntries(left: TimelineEntry, right: TimelineEntry): number {
  const leftSequence = timelineEntrySequence(left);
  const rightSequence = timelineEntrySequence(right);
  if (leftSequence !== undefined && rightSequence !== undefined && leftSequence !== rightSequence) {
    return leftSequence - rightSequence;
  }

  const createdAtComparison = left.createdAt.localeCompare(right.createdAt);
  if (createdAtComparison !== 0) {
    return createdAtComparison;
  }

  // A selection event and the user message that consumes it are committed with
  // the same timestamp. Keep that boundary immediately before the message;
  // otherwise the generic message-first tie order folds it into the following
  // assistant's "Worked for" disclosure.
  const leftIsSelectionBoundary =
    left.kind === "work" && isTranscriptSeparatorWorkEntry(left.entry);
  const rightIsSelectionBoundary =
    right.kind === "work" && isTranscriptSeparatorWorkEntry(right.entry);
  if (leftIsSelectionBoundary !== rightIsSelectionBoundary) {
    return leftIsSelectionBoundary ? -1 : 1;
  }

  return 0;
}

function areTimelineEntriesOrdered(entries: ReadonlyArray<TimelineEntry>): boolean {
  let previousSequenced: TimelineEntry | undefined;
  let previousUnsequenced: TimelineEntry | undefined;
  for (const entry of entries) {
    if (timelineEntrySequence(entry) === undefined) {
      if (previousUnsequenced && compareTimelineEntries(previousUnsequenced, entry) > 0) {
        return false;
      }
      previousUnsequenced = entry;
    } else {
      if (previousSequenced && compareTimelineEntries(previousSequenced, entry) > 0) {
        return false;
      }
      previousSequenced = entry;
    }
  }
  return true;
}

function sortedTimelineEntries(entries: TimelineEntry[]): TimelineEntry[] {
  if (areTimelineEntriesOrdered(entries)) return entries;

  // A sequence-null legacy entry has no defensible cross-order with sequenced
  // entries. Preserve the known/unknown slots and sort within each evidence
  // class, so timestamp fallback cannot invert the known causal subsequence.
  const sequenced = entries
    .filter((entry) => timelineEntrySequence(entry) !== undefined)
    .toSorted(compareTimelineEntries);
  const unsequenced = entries
    .filter((entry) => timelineEntrySequence(entry) === undefined)
    .toSorted(compareTimelineEntries);
  let sequencedIndex = 0;
  let unsequencedIndex = 0;
  return entries.map((entry) =>
    timelineEntrySequence(entry) === undefined
      ? unsequenced[unsequencedIndex++]!
      : sequenced[sequencedIndex++]!,
  );
}

function mergeTimelineEntries(
  left: ReadonlyArray<TimelineEntry>,
  right: ReadonlyArray<TimelineEntry>,
): TimelineEntry[] {
  if (left.length === 0) {
    return [...right];
  }
  if (right.length === 0) {
    return [...left];
  }

  const merged: TimelineEntry[] = [];
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    const leftEntry = left[leftIndex]!;
    const rightEntry = right[rightIndex]!;
    if (compareTimelineEntries(leftEntry, rightEntry) <= 0) {
      merged.push(leftEntry);
      leftIndex += 1;
    } else {
      merged.push(rightEntry);
      rightIndex += 1;
    }
  }
  while (leftIndex < left.length) {
    merged.push(left[leftIndex]!);
    leftIndex += 1;
  }
  while (rightIndex < right.length) {
    merged.push(right[rightIndex]!);
    rightIndex += 1;
  }
  return merged;
}

export function deriveTimelineEntries(
  messages: ChatMessage[],
  workEntries: WorkLogEntry[],
): TimelineEntry[] {
  const messageRows: TimelineEntry[] = messages.map((message) => ({
    id: message.id,
    kind: "message",
    createdAt: message.createdAt,
    message,
  }));
  const workRows: TimelineEntry[] = workEntries.map((entry) => ({
    id: entry.id,
    kind: "work",
    createdAt: entry.createdAt,
    entry,
  }));

  return sortedTimelineEntries(
    mergeTimelineEntries(sortedTimelineEntries(messageRows), sortedTimelineEntries(workRows)),
  );
}
