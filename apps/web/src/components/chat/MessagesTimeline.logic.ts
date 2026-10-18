// FILE: MessagesTimeline.logic.ts
// Purpose: Owns the pure row-derivation helpers used by the transcript hot path.
// Layer: Web chat presentation helpers
// Exports: row derivation, structural sharing, copy/timer helpers

import { type TurnId, type CleanCoreThreadItem } from "@penkra/contracts";
import {
  type TimelineEntry,
  type WorkLogEntry,
  formatElapsed,
  isThreadSelectionWorkEntry,
} from "../../session-logic";
import { normalizeCompactToolLabel as normalizeCompactToolLabelValue } from "../../lib/toolCallLabel";
import {
  isSummarizableToolCallEntry,
  MIN_COLLAPSIBLE_TOOL_GROUP_SIZE,
  summarizeToolCallGroup,
  type ToolCallGroupSummary,
} from "./toolCallGroup.logic";
import { type ChatMessage } from "../../types";
import { threadItemToChatMessage } from "./threadItemMappers";

export type WorkEntryChunk =
  | { kind: "item"; id: string; entry: WorkLogEntry }
  | { kind: "tool-group"; id: string; entries: WorkLogEntry[] };

export function chunkWorkEntries(entries: ReadonlyArray<WorkLogEntry>): WorkEntryChunk[] {
  const chunks: WorkEntryChunk[] = [];
  let run: WorkLogEntry[] = [];
  const flush = () => {
    if (run.length >= MIN_COLLAPSIBLE_TOOL_GROUP_SIZE)
      chunks.push({ kind: "tool-group", id: run.at(-1)!.id, entries: run });
    else for (const entry of run) chunks.push({ kind: "item", id: entry.id, entry });
    run = [];
  };
  for (const entry of entries) {
    if (isSummarizableToolCallEntry(entry)) run.push(entry);
    else {
      flush();
      chunks.push({ kind: "item", id: entry.id, entry });
    }
  }
  flush();
  return chunks;
}

export type MessagesTimelineRow =
  | { kind: "turn-divider"; id: string; createdAt: string }
  | { kind: "boundary"; id: string; createdAt: string; turnId: string | null }
  | {
      kind: "turn-header";
      id: string;
      createdAt: string;
      turnId: string;
      elapsed: string | null;
      expanded: boolean;
    }
  | { kind: "media"; id: string; createdAt: string; entries: ReadonlyArray<WorkLogEntry> }
  | { kind: "work"; id: string; createdAt: string; entry: WorkLogEntry }
  | {
      kind: "summary";
      id: string;
      createdAt: string;
      summary: ToolCallGroupSummary;
      expanded: boolean;
    }
  | {
      kind: "message";
      id: string;
      createdAt: string;
      message: ChatMessage;
      showAssistantCopyButton: boolean;
      assistantCopyStreaming: boolean;
      assistantTurnInProgress?: boolean | undefined;
      hasVisibleMediaInTurn?: boolean;
    }
  | { kind: "working"; id: string; createdAt: string | null }
  | { kind: "working-header"; id: string; createdAt: string };

export interface StableMessagesTimelineRowsState {
  byId: Map<string, MessagesTimelineRow>;
  result: MessagesTimelineRow[];
}

export function normalizeCompactToolLabel(value: string): string {
  return normalizeCompactToolLabelValue(value);
}

export function resolveAssistantMessageCopyState({
  text,
  showCopyButton,
  streaming,
}: {
  text: string | null;
  showCopyButton: boolean;
  streaming: boolean;
}) {
  const normalizedText = text?.trim() ? text : null;
  return {
    text: normalizedText,
    visible: showCopyButton && normalizedText !== null && !streaming,
  };
}

type AssistantMessageDisplayInput = {
  readonly message: Pick<ChatMessage, "text" | "streaming">;
  readonly hasVisibleMediaInTurn?: boolean;
};

/**
 * An explicitly presented image can be the entire answer, so a trailing empty
 * provider message does not add a misleading placeholder after that media.
 * Merely generating an artifact is work, not a visible presentation.
 */
export function resolveAssistantMessageDisplayText(
  input: AssistantMessageDisplayInput,
): string | null {
  if (input.message.text) {
    return input.message.text;
  }
  if (input.message.streaming) {
    return "";
  }

  return input.hasVisibleMediaInTurn ? null : "(empty response)";
}

// The server's turn marker, final answer and hasSteps flag define each block.
// No message-boundary inference or folding into a preceding answer.
export function deriveMessagesTimelineRows(input: {
  timelineEntries: ReadonlyArray<TimelineEntry>;
  isWorking: boolean;
  activeTurnInProgress?: boolean;
  activeTurnId?: TurnId | null | undefined;
  activeTurnStartedAt: string | null;
  turns?: Readonly<Record<string, CleanCoreThreadItem>> | undefined;
  finals?: Readonly<Record<string, CleanCoreThreadItem>> | undefined;
  hasSteps?: Readonly<Record<string, boolean>> | undefined;
  details?:
    | Readonly<
        Record<string, { items: ReadonlyArray<CleanCoreThreadItem>; nextCursor: number | null }>
      >
    | undefined;
  expandedTurns?: Readonly<Record<string, boolean>> | undefined;
  expandedSummaries?: Readonly<Record<string, boolean>> | undefined;
  outlineCursor?: number | null | undefined;
}): MessagesTimelineRow[] {
  const turns = input.turns ?? {};
  const finals = input.finals ?? {};
  const finalIds = new Set(Object.values(finals).map((final) => final.sourceId));
  const events: Array<{ seq: number; priority: number; rows: MessagesTimelineRow[] }> = [];
  const turnOf = (entry: TimelineEntry) =>
    entry.kind === "message" ? entry.message.turnId : entry.entry.turnId;
  const seqOf = (entry: TimelineEntry) =>
    entry.kind === "message" ? (entry.message.sequence ?? 0) : (entry.entry.sequence ?? 0);
  const isQuestion = (entry: TimelineEntry) =>
    entry.kind === "work" && entry.entry.activityKind?.startsWith("question.");
  const rowsFor = (
    entries: ReadonlyArray<TimelineEntry>,
    boundary?: MessagesTimelineRow,
  ): MessagesTimelineRow[] => {
    const rows: MessagesTimelineRow[] = [];
    let work: WorkLogEntry[] = [];
    let boundaryPending = boundary;
    const runningBoundary = (
      turnId: string | null | undefined,
      seq: number | undefined,
    ): MessagesTimelineRow | undefined => {
      if (turnId == null || turns[turnId]?.status !== "running") return;
      const detail = input.details?.[turnId];
      if (detail?.nextCursor == null || detail.items[0]?.seq !== seq) return;
      return {
        kind: "boundary",
        id: "turn-boundary:" + turnId + ":" + detail.nextCursor,
        turnId,
        createdAt: turns[turnId]!.createdAt,
      };
    };
    const appendStep = (entry: WorkLogEntry) => {
      if (boundaryPending) {
        rows.push(boundaryPending);
        boundaryPending = undefined;
      }
      const previous = rows.at(-1);
      if (
        entry.presentedMedia?.presentationId &&
        previous?.kind === "media" &&
        previous.entries[0]?.presentedMedia?.presentationId === entry.presentedMedia.presentationId
      ) {
        previous.entries = [...previous.entries, entry].toSorted(
          (a, b) =>
            (a.presentedMedia?.presentationIndex ?? 0) - (b.presentedMedia?.presentationIndex ?? 0),
        );
        previous.id = "media:" + previous.entries.at(-1)!.id;
        return;
      }
      rows.push(
        entry.presentedMedia
          ? { kind: "media", id: entry.id, createdAt: entry.createdAt, entries: [entry] }
          : { kind: "work", id: entry.id, createdAt: entry.createdAt, entry },
      );
    };
    const flush = (tail: boolean) => {
      for (const entry of work) boundaryPending ??= runningBoundary(entry.turnId, entry.sequence);
      const chunks = chunkWorkEntries(work);
      for (const chunk of chunks) {
        const summary = chunk.kind === "tool-group" ? summarizeToolCallGroup(chunk.entries) : null;
        const lastEntry = chunk.kind === "item" ? chunk.entry : chunk.entries.at(-1)!;
        const liveTail =
          tail &&
          chunk === chunks.at(-1) &&
          input.activeTurnInProgress === true &&
          lastEntry.turnId === input.activeTurnId;
        if (chunk.kind === "tool-group" && summary && !summary.hasRunningEntry && !liveTail) {
          const id = "summary:" + chunk.id;
          const expanded = input.expandedSummaries?.[id] === true;
          rows.push({
            kind: "summary",
            id,
            createdAt: chunk.entries[0]!.createdAt,
            summary,
            expanded,
          });
          if (expanded) for (const entry of chunk.entries) appendStep(entry);
          else boundaryPending = undefined;
        } else {
          for (const entry of chunk.kind === "item" ? [chunk.entry] : chunk.entries)
            appendStep(entry);
        }
      }
      work = [];
    };
    const flushWork = flush;
    for (const entry of entries) {
      if (
        entry.kind === "work" &&
        !entry.entry.presentedMedia &&
        !isQuestion(entry) &&
        !isThreadSelectionWorkEntry(entry.entry)
      ) {
        if (work.length && work.at(-1)!.turnId !== entry.entry.turnId) flushWork(false);
        work.push(entry.entry);
      } else {
        flushWork(false);
        if (entry.kind === "work") appendStep(entry.entry);
        else {
          boundaryPending ??= runningBoundary(entry.message.turnId, entry.message.sequence);
          if (boundaryPending) {
            rows.push(boundaryPending);
            boundaryPending = undefined;
          }
          const active =
            input.activeTurnInProgress === true && entry.message.turnId === input.activeTurnId;
          rows.push({
            kind: "message",
            id: entry.id,
            createdAt: entry.createdAt,
            message: entry.message,
            showAssistantCopyButton:
              entry.message.role === "assistant" && finalIds.has(entry.message.id),
            assistantCopyStreaming: entry.message.streaming || active,
            assistantTurnInProgress: active,
          });
        }
      }
    }
    flushWork(true);
    return rows;
  };
  const normal: TimelineEntry[] = [];
  const entriesByTurn = new Map<string, TimelineEntry[]>();
  const seqById = new Map<string, number>();
  for (const entry of input.timelineEntries) {
    const id = turnOf(entry);
    seqById.set(entry.id, seqOf(entry));
    if (entry.kind === "work") seqById.set(entry.entry.id, seqOf(entry));
    if (id != null) {
      const entries = entriesByTurn.get(id) ?? [];
      entries.push(entry);
      entriesByTurn.set(id, entries);
    }
    const turn = id == null ? undefined : turns[id];
    if (
      turn &&
      turn.status !== "running" &&
      !(entry.kind === "message" && entry.message.role === "user") &&
      !isQuestion(entry)
    )
      continue;
    normal.push(entry);
  }
  // Group only adjacent display work/media, never across a message or turn boundary.
  for (const row of rowsFor(normal)) {
    const seq =
      row.kind === "summary"
        ? (row.summary.iconEntry.sequence ?? 0)
        : row.kind === "boundary" && row.turnId !== null
          ? (input.details?.[row.turnId]?.items[0]?.seq ?? 0)
          : seqById.get(row.id)!;
    events.push({ seq, priority: 1, rows: [row] });
  }
  for (const [id, turn] of Object.entries(turns)) {
    if (turn.status === "running") {
      if (input.isWorking && input.activeTurnStartedAt && id === input.activeTurnId)
        events.push({
          seq: turn.seq,
          priority: 0,
          rows: [
            {
              kind: "working-header",
              id: "working-header-row",
              createdAt: input.activeTurnStartedAt,
            },
          ],
        });
      continue;
    }
    const final = finals[id];
    const block: MessagesTimelineRow[] = [];
    const expanded = input.expandedTurns?.[id] === true;
    const timing =
      turn.data === null
        ? null
        : (JSON.parse(turn.data) as { startedAt: string | null; endedAt: string | null });
    if (input.hasSteps?.[id]) {
      block.push({
        kind: "turn-header",
        id: "turn-header:" + id,
        turnId: id,
        createdAt: turn.createdAt,
        expanded,
        elapsed:
          timing?.startedAt && timing.endedAt
            ? formatElapsed(timing.startedAt, timing.endedAt)
            : null,
      });
      if (expanded) {
        const detail = input.details?.[id];
        block.push(
          ...rowsFor(
            (entriesByTurn.get(id) ?? []).filter(
              (entry) =>
                !(
                  entry.kind === "message" &&
                  (entry.message.role === "user" || entry.message.id === final?.sourceId)
                ) && !isQuestion(entry),
            ),
            detail?.nextCursor != null
              ? {
                  kind: "boundary",
                  id: "turn-boundary:" + id + ":" + detail.nextCursor,
                  turnId: id,
                  createdAt: turn.createdAt,
                }
              : undefined,
          ),
        );
      }
    }
    if (input.hasSteps?.[id]) {
      block.push({ kind: "turn-divider", id: "turn-divider:" + id, createdAt: turn.createdAt });
    }
    if (final) {
      const message = threadItemToChatMessage(final);
      block.push({
        kind: "message",
        id: final.sourceId,
        createdAt: final.createdAt,
        message,
        showAssistantCopyButton: true,
        assistantCopyStreaming: false,
      });
    }
    events.push({ seq: final?.seq ?? turn.seq, priority: 1, rows: block });
  }
  const result = events
    .toSorted((a, b) => a.seq - b.seq || a.priority - b.priority)
    .flatMap((event) => event.rows);
  if (input.outlineCursor != null)
    result.unshift({
      kind: "boundary",
      id: "outline-boundary:" + input.outlineCursor,
      turnId: null,
      createdAt: result[0]?.createdAt ?? "",
    });
  if (input.isWorking)
    result.push({
      kind: "working",
      id: "working-indicator-row",
      createdAt: input.activeTurnStartedAt,
    });
  return result;
}

// Reuses stable row references so streaming updates only invalidate rows whose
// visible content actually changed.
export function computeStableMessagesTimelineRows(
  rows: MessagesTimelineRow[],
  previous: StableMessagesTimelineRowsState,
): StableMessagesTimelineRowsState {
  const next = new Map<string, MessagesTimelineRow>();
  let anyChanged = rows.length !== previous.byId.size;

  const result = rows.map((row, index) => {
    const prevRow = previous.byId.get(row.id);
    const nextRow = prevRow && isRowUnchanged(prevRow, row) ? prevRow : row;
    next.set(row.id, nextRow);
    if (!anyChanged && previous.result[index] !== nextRow) {
      anyChanged = true;
    }
    return nextRow;
  });

  return anyChanged ? { byId: next, result } : previous;
}

function stringArraysEqual(
  left: ReadonlyArray<string> | undefined,
  right: ReadonlyArray<string> | undefined,
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

function workLogSubagentActionsEqual(
  a: WorkLogEntry["subagentAction"],
  b: WorkLogEntry["subagentAction"],
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.tool === b.tool &&
    a.status === b.status &&
    a.summaryText === b.summaryText &&
    a.model === b.model &&
    a.prompt === b.prompt
  );
}

function workLogSubagentsEqual(
  left: WorkLogEntry["subagents"],
  right: WorkLogEntry["subagents"],
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  if (left.length !== right.length) return false;
  return left.every((a, index) => {
    const b = right[index];
    return (
      b !== undefined &&
      a.threadId === b.threadId &&
      a.providerThreadId === b.providerThreadId &&
      a.resolvedThreadId === b.resolvedThreadId &&
      a.agentId === b.agentId &&
      a.nickname === b.nickname &&
      a.role === b.role &&
      a.model === b.model &&
      a.prompt === b.prompt &&
      a.rawStatus === b.rawStatus &&
      a.latestUpdate === b.latestUpdate &&
      a.title === b.title &&
      a.statusLabel === b.statusLabel &&
      a.isActive === b.isActive
    );
  });
}

function workLogPenkraThreadCreationsEqual(
  a: WorkLogEntry["penkraThreadCreation"],
  b: WorkLogEntry["penkraThreadCreation"],
) {
  if (a === b) return true;
  if (!a || !b) return false;
  if (
    a.operationId !== b.operationId ||
    a.requestedCount !== b.requestedCount ||
    a.createdCount !== b.createdCount ||
    a.threads.length !== b.threads.length
  ) {
    return false;
  }
  return a.threads.every((thread, index) => {
    const other = b.threads[index];
    return (
      other !== undefined &&
      thread.threadId === other.threadId &&
      thread.title === other.title &&
      thread.provider === other.provider &&
      thread.model === other.model &&
      thread.status === other.status
    );
  });
}

function workLogToolOutputsEqual(
  a: NonNullable<WorkLogEntry["toolDetails"]>["output"],
  b: NonNullable<WorkLogEntry["toolDetails"]>["output"],
) {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.output === b.output &&
    a.stdout === b.stdout &&
    a.stderr === b.stderr &&
    a.exitCode === b.exitCode &&
    a.truncated === b.truncated
  );
}

function workLogToolEditsEqual(
  left: NonNullable<WorkLogEntry["toolDetails"]>["edits"],
  right: NonNullable<WorkLogEntry["toolDetails"]>["edits"],
) {
  if (left === right) return true;
  if (!left || !right) return false;
  if (left.length !== right.length) return false;
  return left.every((edit, index) => {
    const other = right[index];
    return (
      other !== undefined &&
      edit.path === other.path &&
      edit.oldText === other.oldText &&
      edit.newText === other.newText
    );
  });
}

function workLogToolDetailsEqual(a: WorkLogEntry["toolDetails"], b: WorkLogEntry["toolDetails"]) {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.kind === b.kind &&
    a.title === b.title &&
    a.command === b.command &&
    a.diff === b.diff &&
    a.content === b.content &&
    stringArraysEqual(a.files, b.files) &&
    workLogToolOutputsEqual(a.output, b.output) &&
    workLogToolEditsEqual(a.edits, b.edits)
  );
}

function workLogLiveActivitiesEqual(
  a: WorkLogEntry["liveActivity"],
  b: WorkLogEntry["liveActivity"],
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.state === b.state &&
    a.label === b.label &&
    a.startedAt === b.startedAt &&
    a.lastActivityAt === b.lastActivityAt &&
    a.detail === b.detail &&
    a.progress === b.progress &&
    a.elapsedSeconds === b.elapsedSeconds
  );
}

function workLogEntryContentEqual(a: WorkLogEntry, b: WorkLogEntry): boolean {
  if (a === b) return true;
  return (
    a.id === b.id &&
    a.createdAt === b.createdAt &&
    a.sequence === b.sequence &&
    a.turnId === b.turnId &&
    a.label === b.label &&
    a.detail === b.detail &&
    a.toolTitle === b.toolTitle &&
    a.command === b.command &&
    a.rawCommand === b.rawCommand &&
    a.preview === b.preview &&
    a.tone === b.tone &&
    a.itemType === b.itemType &&
    a.requestKind === b.requestKind &&
    a.activityKind === b.activityKind &&
    a.presentedMedia?.attachmentId === b.presentedMedia?.attachmentId &&
    a.presentedMedia?.name === b.presentedMedia?.name &&
    a.presentedMedia?.mimeType === b.presentedMedia?.mimeType &&
    a.presentedMedia?.sizeBytes === b.presentedMedia?.sizeBytes &&
    a.presentedMedia?.type === b.presentedMedia?.type &&
    a.presentedMedia?.presentationId === b.presentedMedia?.presentationId &&
    a.presentedMedia?.presentationIndex === b.presentedMedia?.presentationIndex &&
    a.toolName === b.toolName &&
    a.toolCallId === b.toolCallId &&
    a.toolStatus === b.toolStatus &&
    stringArraysEqual(a.changedFiles, b.changedFiles) &&
    workLogSubagentActionsEqual(a.subagentAction, b.subagentAction) &&
    workLogSubagentsEqual(a.subagents, b.subagents) &&
    workLogPenkraThreadCreationsEqual(a.penkraThreadCreation, b.penkraThreadCreation) &&
    workLogLiveActivitiesEqual(a.liveActivity, b.liveActivity) &&
    workLogToolDetailsEqual(a.toolDetails, b.toolDetails)
  );
}

function workLogEntryArraysEqual(
  left: ReadonlyArray<WorkLogEntry> | undefined,
  right: ReadonlyArray<WorkLogEntry> | undefined,
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  if (left.length !== right.length) return false;
  return left.every((entry, index) => workLogEntryContentEqual(entry, right[index]!));
}

function isRowUnchanged(a: MessagesTimelineRow, b: MessagesTimelineRow): boolean {
  if (a.kind !== b.kind || a.id !== b.id) return false;

  switch (a.kind) {
    case "turn-divider":
      return a.createdAt === (b as typeof a).createdAt;
    case "boundary":
      return a.turnId === (b as typeof a).turnId;
    case "turn-header": {
      const other = b as typeof a;
      return (
        a.expanded === other.expanded &&
        a.elapsed === other.elapsed &&
        a.createdAt === other.createdAt
      );
    }
    case "media":
      return (
        a.createdAt === (b as typeof a).createdAt &&
        workLogEntryArraysEqual(a.entries, (b as typeof a).entries)
      );
    case "summary": {
      const other = b as typeof a;
      return (
        a.expanded === other.expanded &&
        a.summary.label === other.summary.label &&
        a.summary.entryCount === other.summary.entryCount &&
        workLogEntryContentEqual(a.summary.iconEntry, other.summary.iconEntry)
      );
    }
    case "working":
      return a.createdAt === (b as typeof a).createdAt;

    case "working-header":
      return a.createdAt === (b as typeof a).createdAt;

    case "work":
      return (
        a.createdAt === (b as typeof a).createdAt &&
        workLogEntryContentEqual(a.entry, (b as typeof a).entry)
      );

    case "message": {
      const bm = b as typeof a;
      return (
        a.message === bm.message &&
        a.hasVisibleMediaInTurn === bm.hasVisibleMediaInTurn &&
        a.showAssistantCopyButton === bm.showAssistantCopyButton &&
        a.assistantCopyStreaming === bm.assistantCopyStreaming &&
        a.assistantTurnInProgress === bm.assistantTurnInProgress
      );
    }
  }
}
