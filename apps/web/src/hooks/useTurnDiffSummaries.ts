import { useMemo } from "react";

import { inferCheckpointTurnCountByTurnId } from "../session-logic";
import type { Thread } from "../types";

const EMPTY_TURN_DIFF_SUMMARIES: Thread["turnDiffSummaries"] = [];

export function useTurnDiffSummaries(activeThread: Thread | undefined) {
  const turnDiffSummaries = activeThread?.turnDiffSummaries ?? EMPTY_TURN_DIFF_SUMMARIES;

  const inferredCheckpointTurnCountByTurnId = useMemo(
    () => inferCheckpointTurnCountByTurnId(turnDiffSummaries),
    [turnDiffSummaries],
  );

  return useMemo(
    () => ({ turnDiffSummaries, inferredCheckpointTurnCountByTurnId }),
    [inferredCheckpointTurnCountByTurnId, turnDiffSummaries],
  );
}
