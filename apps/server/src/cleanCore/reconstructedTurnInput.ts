// FILE: reconstructedTurnInput.ts
// Purpose: Read retained continuation from canonical, bounded item pages.
// Layer: Server clean core

import {
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  type ProviderKind,
  type ThreadId,
} from "@penkra/contracts";
import { Effect } from "effect";
import { ProviderAdapterValidationError } from "../provider/Errors.ts";
import {
  formatReconstructedContinuation,
  isContextCompaction,
  selectReconstructedContinuation,
} from "../provider/reconstructedContinuation.ts";
import { listThreadItemsPage, type ThreadItemRecord } from "./threadItemsPage.ts";

export const buildReconstructedTurnInput = Effect.fnUntraced(function* (input: {
  readonly threadId: ThreadId;
  readonly provider: ProviderKind;
  readonly currentMessageId: string;
  readonly currentInput: string;
}) {
  const items: ThreadItemRecord[] = [];
  let beforeSeq: number | undefined;
  let foundCompaction = false;
  do {
    const page = yield* listThreadItemsPage({ threadId: input.threadId, beforeSeq });
    // An unacknowledged user input belongs to the current delivery cohort, not
    // to provider history; including it here would send that input twice.
    items.push(...page.items.filter((item) => item.kind !== "user" || item.status === "sent"));
    foundCompaction = page.items.some(isContextCompaction);
    if (foundCompaction || page.nextCursor === null) break;
    beforeSeq = page.nextCursor;
  } while (true);

  if (
    !foundCompaction &&
    !items.some(
      (item) =>
        (item.kind === "user" || item.kind === "text") && item.sourceId !== input.currentMessageId,
    )
  )
    return null;
  const continuation = selectReconstructedContinuation({
    items,
    currentMessageId: input.currentMessageId,
  });
  const reconstructed = formatReconstructedContinuation({
    threadId: input.threadId,
    continuation,
    currentInput: input.currentInput,
  });
  if (reconstructed.length > PROVIDER_SEND_TURN_MAX_INPUT_CHARS) {
    return yield* new ProviderAdapterValidationError({
      provider: input.provider,
      operation: "thread.turn.reconstruct",
      issue: `The deterministic retained transcript is ${reconstructed.length} characters, exceeding the provider input limit of ${PROVIDER_SEND_TURN_MAX_INPUT_CHARS}. Penkra did not trim or discard it.`,
    });
  }
  return reconstructed;
});
