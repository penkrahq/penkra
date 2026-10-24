// Purpose: Read only retained history that can fit after the admitted delivery.
import {
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  type ProviderKind,
  type ThreadId,
} from "@penkra/contracts";
import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import {
  formatReconstructedContinuation,
  reconstructedMessageChars,
  selectReconstructedContinuation,
} from "../provider/reconstructedContinuation.ts";
import { listThreadItemRecords, type ThreadItemRecord } from "./threadItemsPage.ts";

export const buildReconstructedTurnInput = Effect.fnUntraced(function* (input: {
  readonly threadId: ThreadId;
  readonly provider: ProviderKind;
  readonly currentMessageId: string;
  readonly currentInput: string;
}) {
  const budget = PROVIDER_SEND_TURN_MAX_INPUT_CHARS - input.currentInput.length;
  if (budget <= 0) return null;
  const sql = yield* SqlClient.SqlClient;
  const [compaction] = yield* sql<ThreadItemRecord>`
    SELECT thread_id AS "threadId",seq,source_id AS "sourceId",turn_id AS "turnId",kind,status,text,data,
      created_at AS "createdAt",updated_at AS "updatedAt" FROM thread_items
    WHERE thread_id=${input.threadId} AND kind='notice' AND json_valid(data)
      AND json_extract(data,'$.kind')='context-compaction' ORDER BY seq DESC LIMIT 1`;
  const items: ThreadItemRecord[] = compaction ? [compaction] : [];
  let beforeSeq: number | undefined;
  let chars = 0;
  let hasOlder = false;
  while (true) {
    const page = yield* listThreadItemRecords({ threadId: input.threadId, beforeSeq });
    const retained = page.items.filter(
      (item) =>
        (item.kind === "text" || (item.kind === "user" && item.status === "sent")) &&
        item.sourceId !== input.currentMessageId &&
        (!compaction ||
          (item.seq > compaction.seq &&
            (item.turnId === null || item.turnId !== compaction.turnId))),
    );
    items.push(...retained);
    chars += retained.reduce((total, item) => total + reconstructedMessageChars(item), 0);
    const reachedBoundary = compaction && page.items.some((item) => item.seq <= compaction.seq);
    if (reachedBoundary || page.nextCursor === null) break;
    if (chars >= budget) {
      hasOlder = true;
      break;
    }
    beforeSeq = page.nextCursor;
  }
  if (!compaction && !items.length) return null;
  const continuation = selectReconstructedContinuation({ ...input, items, hasOlder });
  return formatReconstructedContinuation({
    threadId: input.threadId,
    continuation,
    currentInput: input.currentInput,
  });
});
