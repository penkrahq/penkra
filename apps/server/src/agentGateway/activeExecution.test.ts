import type { OrchestrationSessionStatus, OrchestrationThreadShell } from "@penkra/contracts";
import { MessageId, ThreadId, TurnId } from "@penkra/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { PersistenceSqlError } from "../persistence/Errors.ts";
import type {
  ProjectionTurn,
  ProjectionTurnRepositoryShape,
  ProjectionTurnState,
} from "../persistence/Services/ProjectionTurns.ts";
import { resolveAuthoritativeActiveTurn } from "./activeExecution.ts";

const THREAD_ID = ThreadId.makeUnsafe("thread-authority");
const REQUESTED_AT = "2026-09-06T07:00:00.000Z";
const STARTED_AT = "2026-09-06T07:00:01.000Z";
const LATER_STARTED_AT = "2026-09-06T07:00:02.000Z";
const COMPLETED_AT = "2026-09-06T07:01:00.000Z";

function makeTurn(input: {
  readonly turnId: string;
  readonly providerTurnId?: string | null;
  readonly state?: ProjectionTurnState;
  readonly requestedAt?: string;
  readonly startedAt?: string | null;
  readonly completedAt?: string | null;
}): ProjectionTurn {
  const state = input.state ?? "running";
  return {
    threadId: THREAD_ID,
    turnId: TurnId.makeUnsafe(input.turnId),
    providerTurnId:
      input.providerTurnId === undefined || input.providerTurnId === null
        ? null
        : TurnId.makeUnsafe(input.providerTurnId),
    pendingMessageId: MessageId.makeUnsafe(`pending-${input.turnId}`),
    assistantMessageId: null,
    state,
    requestedAt: input.requestedAt ?? REQUESTED_AT,
    startedAt:
      input.startedAt === undefined ? (state === "queued" ? null : STARTED_AT) : input.startedAt,
    completedAt:
      input.completedAt === undefined
        ? ["completed", "error", "interrupted", "cancelled"].includes(state)
          ? COMPLETED_AT
          : null
        : input.completedAt,
  };
}

function makeSession(
  activeTurnId: string | null,
  status: OrchestrationSessionStatus = "running",
): NonNullable<OrchestrationThreadShell["session"]> {
  return {
    threadId: THREAD_ID,
    status,
    providerName: "codex",
    runtimeMode: "full-access",
    activeTurnId: activeTurnId === null ? null : TurnId.makeUnsafe(activeTurnId),
    lastError: null,
    updatedAt: REQUESTED_AT,
  };
}

function repository(
  turns: ReadonlyArray<ProjectionTurn>,
): Pick<ProjectionTurnRepositoryShape, "listByThreadId"> {
  return {
    listByThreadId: () => Effect.succeed(turns),
  };
}

function resolve(
  turns: ReadonlyArray<ProjectionTurn>,
  session: OrchestrationThreadShell["session"] = null,
) {
  return Effect.runPromise(
    resolveAuthoritativeActiveTurn({
      threadId: THREAD_ID,
      session,
      projectionTurns: repository(turns),
    }),
  );
}

describe("authoritative active turn resolution", () => {
  it("returns null when there are no projection turns", async () => {
    await expect(resolve([])).resolves.toBeNull();
  });

  for (const testCase of [
    { label: "null session", session: null },
    { label: "stale session pointer", session: makeSession("stale") },
    { label: "ready session", session: makeSession(null, "ready") },
  ] as const) {
    it(`returns the only started running native row with a ${testCase.label}`, async () => {
      const original = makeTurn({ turnId: "original", providerTurnId: "native-original" });

      await expect(resolve([original], testCase.session)).resolves.toEqual(original);
    });
  }

  it("ignores queued, unstarted, completed, interrupted, error, and cancelled rows", async () => {
    const ignored = [
      makeTurn({ turnId: "queued", state: "queued" }),
      makeTurn({ turnId: "unstarted", state: "running", startedAt: null }),
      makeTurn({ turnId: "completed", state: "completed" }),
      makeTurn({ turnId: "interrupted", state: "interrupted" }),
      makeTurn({ turnId: "error", state: "error" }),
      makeTurn({ turnId: "cancelled", state: "cancelled" }),
    ];

    await expect(resolve(ignored)).resolves.toBeNull();
  });

  for (const [label, turns] of [
    [
      "original then steer",
      [
        makeTurn({ turnId: "original", providerTurnId: "native-shared" }),
        makeTurn({ turnId: "steer", providerTurnId: "native-shared", startedAt: LATER_STARTED_AT }),
      ],
    ],
    [
      "steer then original",
      [
        makeTurn({ turnId: "steer", providerTurnId: "native-shared", startedAt: LATER_STARTED_AT }),
        makeTurn({ turnId: "original", providerTurnId: "native-shared" }),
      ],
    ],
  ] as const) {
    it(`selects original for one shared native execution with native session pointer (${label})`, async () => {
      const original = turns.find((turn) => turn.turnId === TurnId.makeUnsafe("original"));

      await expect(resolve(turns, makeSession("native-shared"))).resolves.toEqual(original);
    });
  }

  it("selects original from three accepted requests sharing one provider ID without a session pointer", async () => {
    const original = makeTurn({ turnId: "original", providerTurnId: "native-shared" });
    const steerOne = makeTurn({
      turnId: "steer-one",
      providerTurnId: "native-shared",
      startedAt: LATER_STARTED_AT,
    });
    const steerTwo = makeTurn({
      turnId: "steer-two",
      providerTurnId: "native-shared",
      startedAt: "2026-09-06T07:00:03.000Z",
    });

    await expect(resolve([steerTwo, original, steerOne])).resolves.toEqual(original);
  });

  it("selects original when the session pointer is the logical ID of a steer in its shared group", async () => {
    const original = makeTurn({ turnId: "original", providerTurnId: "native-shared" });
    const steer = makeTurn({
      turnId: "steer",
      providerTurnId: "native-shared",
      startedAt: LATER_STARTED_AT,
    });

    await expect(resolve([original, steer], makeSession("steer"))).resolves.toEqual(original);
  });

  it("keeps the pre-steer authority stable after a later accepted same-native steer is appended", async () => {
    const original = makeTurn({ turnId: "original", providerTurnId: "native-shared" });
    const steer = makeTurn({
      turnId: "steer",
      providerTurnId: "native-shared",
      startedAt: LATER_STARTED_AT,
    });

    const before = await resolve([original], makeSession("native-shared"));
    const after = await resolve([original, steer], makeSession("native-shared"));

    expect(before).toEqual(original);
    expect(after).toEqual(original);
    expect(after).toEqual(before);
  });

  for (const testCase of [
    { label: "absent pointer", session: null },
    { label: "stale pointer", session: makeSession("stale") },
  ] as const) {
    it(`returns null for two distinct provider executions with a ${testCase.label}`, async () => {
      const first = makeTurn({ turnId: "first", providerTurnId: "native-first" });
      const second = makeTurn({
        turnId: "second",
        providerTurnId: "native-second",
        startedAt: LATER_STARTED_AT,
      });

      await expect(resolve([first, second], testCase.session)).resolves.toBeNull();
    });
  }

  it("selects the representative of the group matching an exact native session pointer", async () => {
    const original = makeTurn({ turnId: "original", providerTurnId: "native-first" });
    const steer = makeTurn({
      turnId: "steer",
      providerTurnId: "native-first",
      startedAt: LATER_STARTED_AT,
    });
    const other = makeTurn({ turnId: "other", providerTurnId: "native-second" });

    await expect(resolve([other, steer, original], makeSession("native-first"))).resolves.toEqual(
      original,
    );
  });

  it("selects the correct group when the session pointer is a logical member", async () => {
    const first = makeTurn({ turnId: "first", providerTurnId: "native-first" });
    const firstSteer = makeTurn({
      turnId: "first-steer",
      providerTurnId: "native-first",
      startedAt: LATER_STARTED_AT,
    });
    const second = makeTurn({ turnId: "second", providerTurnId: "native-second" });

    await expect(resolve([second, firstSteer, first], makeSession("first-steer"))).resolves.toEqual(
      first,
    );
  });

  it("keeps null-native rows separate and uses an exact logical pointer for a singleton", async () => {
    const first = makeTurn({ turnId: "first", providerTurnId: null });
    const second = makeTurn({
      turnId: "second",
      providerTurnId: null,
      startedAt: LATER_STARTED_AT,
    });

    await expect(resolve([first, second])).resolves.toBeNull();
    await expect(resolve([first, second], makeSession("second"))).resolves.toEqual(second);
  });

  it("does not collapse a null-native logical ID with a different row native ID", async () => {
    const logical = makeTurn({ turnId: "same-id", providerTurnId: null });
    const native = makeTurn({
      turnId: "native-owner",
      providerTurnId: "same-id",
      startedAt: LATER_STARTED_AT,
    });

    await expect(resolve([logical, native])).resolves.toBeNull();
  });

  it("uses deterministic nonmutating tie sorting by logical turn ID", async () => {
    const laterLexical = makeTurn({
      turnId: "zeta",
      providerTurnId: "native-shared",
      requestedAt: REQUESTED_AT,
      startedAt: STARTED_AT,
    });
    const earlierLexical = makeTurn({
      turnId: "alpha",
      providerTurnId: "native-shared",
      requestedAt: REQUESTED_AT,
      startedAt: STARTED_AT,
    });
    const turns = [laterLexical, earlierLexical];
    const before = structuredClone(turns);

    await expect(resolve(turns)).resolves.toEqual(earlierLexical);
    expect(turns).toEqual(before);
  });

  it("propagates projection repository errors unchanged", async () => {
    const failure = new PersistenceSqlError({
      operation: "test-list-projection-turns",
      detail: "synthetic failure",
    });
    const projectionTurns: Pick<ProjectionTurnRepositoryShape, "listByThreadId"> = {
      listByThreadId: () => Effect.fail(failure),
    };

    await expect(
      Effect.runPromise(
        resolveAuthoritativeActiveTurn({
          threadId: THREAD_ID,
          session: null,
          projectionTurns,
        }),
      ),
    ).rejects.toBe(failure);
  });

  it("selects original from a shared-native group while ignoring unrelated pending and terminal rows", async () => {
    const original = makeTurn({ turnId: "original", providerTurnId: "native-shared" });
    const steer = makeTurn({
      turnId: "steer",
      providerTurnId: "native-shared",
      startedAt: LATER_STARTED_AT,
    });
    const unrelatedQueued = makeTurn({ turnId: "queued", state: "queued" });
    const unrelatedCompleted = makeTurn({ turnId: "completed", state: "completed" });
    const unrelatedError = makeTurn({ turnId: "error", state: "error" });

    await expect(
      resolve([unrelatedError, steer, unrelatedQueued, original, unrelatedCompleted]),
    ).resolves.toEqual(original);
  });
});
