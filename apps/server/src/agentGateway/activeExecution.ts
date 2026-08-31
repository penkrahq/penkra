import type { OrchestrationThreadShell } from "@penkra/contracts";
import { Effect } from "effect";

import type {
  ProjectionTurn,
  ProjectionTurnRepositoryShape,
} from "../persistence/Services/ProjectionTurns.ts";

/**
 * Resolves execution authority from the canonical turn projection.
 *
 * `latestTurn` is intentionally absent: it is a presentation summary and can
 * legitimately point at a newer queued or terminal turn. A session pointer is
 * only a disambiguating hint. One concrete, started, non-terminal turn remains
 * authoritative even if the session summary is briefly behind it.
 */
export function resolveAuthoritativeActiveTurn(input: {
  readonly threadId: OrchestrationThreadShell["id"];
  readonly session: OrchestrationThreadShell["session"];
  readonly projectionTurns: ProjectionTurnRepositoryShape;
}): Effect.Effect<ProjectionTurn | null, unknown> {
  return input.projectionTurns.listByThreadId({ threadId: input.threadId }).pipe(
    Effect.map((turns) => {
      const activeTurns = turns.filter(
        (turn) => turn.state === "running" && turn.startedAt !== null && turn.completedAt === null,
      );
      if (activeTurns.length === 0) {
        return null;
      }

      const sessionTurnId = input.session?.activeTurnId ?? null;
      if (sessionTurnId !== null) {
        const sessionMatches = activeTurns.filter(
          (turn) => turn.turnId === sessionTurnId || turn.providerTurnId === sessionTurnId,
        );
        if (sessionMatches.length === 1) {
          return sessionMatches[0] ?? null;
        }
      }

      // Fail closed when projection corruption leaves more than one candidate;
      // guessing would let one execution inherit another execution's authority.
      return activeTurns.length === 1 ? (activeTurns[0] ?? null) : null;
    }),
  );
}
