import type { OrchestrationThreadShell } from "@penkra/contracts";
import { Effect } from "effect";

import type {
  ProjectionTurn,
  ProjectionTurnRepositoryShape,
} from "../persistence/Services/ProjectionTurns.ts";

type StartedTurn = ProjectionTurn & { readonly startedAt: string };

/**
 * Resolves execution authority from the canonical turn projection.
 *
 * `latestTurn` is intentionally absent: it is a presentation summary and can
 * legitimately point at a newer queued or terminal turn. A session pointer is
 * only a disambiguating hint. One concrete, started, non-terminal turn remains
 * authoritative even if the session summary is briefly behind it. Multiple
 * logical requests can share one provider-native execution after an accepted
 * steer, so those rows are one candidate group. The group's stable
 * representative is the earliest logical request, keeping authority unchanged
 * when a later steer is projected.
 */
export function resolveAuthoritativeActiveTurn(input: {
  readonly threadId: OrchestrationThreadShell["id"];
  readonly session: OrchestrationThreadShell["session"];
  readonly projectionTurns: Pick<ProjectionTurnRepositoryShape, "listByThreadId">;
}): Effect.Effect<ProjectionTurn | null, unknown> {
  return input.projectionTurns.listByThreadId({ threadId: input.threadId }).pipe(
    Effect.map((turns) => {
      const activeTurns = turns.filter(
        (turn): turn is StartedTurn =>
          turn.state === "running" && turn.startedAt !== null && turn.completedAt === null,
      );
      if (activeTurns.length === 0) {
        return null;
      }

      const groups = new Map<string, StartedTurn[]>();
      for (const turn of activeTurns) {
        const key =
          turn.providerTurnId === null
            ? `logical:${turn.turnId}`
            : `provider:${turn.providerTurnId}`;
        const group = groups.get(key);
        if (group) {
          group.push(turn);
        } else {
          groups.set(key, [turn]);
        }
      }

      const candidates = [...groups.values()];
      const sessionTurnId = input.session?.activeTurnId ?? null;
      let selectedGroup: ReadonlyArray<StartedTurn> | undefined;
      if (sessionTurnId !== null) {
        const sessionMatches = candidates.filter((group) =>
          group.some(
            (turn) => turn.turnId === sessionTurnId || turn.providerTurnId === sessionTurnId,
          ),
        );
        if (sessionMatches.length === 1) {
          selectedGroup = sessionMatches[0];
        }
      }

      // Fail closed when projection corruption leaves more than one candidate;
      // guessing would let one execution inherit another execution's authority.
      if (selectedGroup === undefined) {
        if (candidates.length !== 1) return null;
        selectedGroup = candidates[0];
      }

      if (selectedGroup === undefined) return null;
      return (
        selectedGroup.toSorted((a, b) => {
          const startedAt = a.startedAt.localeCompare(b.startedAt);
          if (startedAt !== 0) return startedAt;
          const requestedAt = a.requestedAt.localeCompare(b.requestedAt);
          if (requestedAt !== 0) return requestedAt;
          return a.turnId.localeCompare(b.turnId);
        })[0] ?? null
      );
    }),
  );
}
