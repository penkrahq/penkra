import {
  EventId,
  MessageId,
  OrchestrationMessage,
  OrchestrationThreadActivity,
  TurnId,
} from "@penkra/contracts";
import { describe, expect, it } from "vitest";

import { derivePendingThreadRequestIds, deriveThreadSummaryMetadata } from "./threadSummary";

describe("deriveThreadSummaryMetadata", () => {
  it("derives sidebar summary metadata from thread state", () => {
    const messages: OrchestrationMessage[] = [
      {
        id: MessageId.makeUnsafe("message-1"),
        role: "assistant",
        text: "hello",
        turnId: TurnId.makeUnsafe("turn-1"),
        streaming: false,
        source: "native",
        createdAt: "2026-02-27T00:01:00.000Z",
        updatedAt: "2026-02-27T00:01:00.000Z",
      },
      {
        id: MessageId.makeUnsafe("message-2"),
        role: "user",
        text: "ship it",
        turnId: TurnId.makeUnsafe("turn-2"),
        streaming: false,
        source: "native",
        createdAt: "2026-02-27T00:03:00.000Z",
        updatedAt: "2026-02-27T00:03:00.000Z",
      },
    ];
    const activities: OrchestrationThreadActivity[] = [
      {
        id: EventId.makeUnsafe("activity-2"),
        tone: "info",
        kind: "user-input.requested",
        summary: "Questions requested",
        payload: {
          requestId: "input-1",
          questions: [
            {
              id: "question-1",
              header: "Confirm",
              question: "Ship now?",
              options: [{ label: "Yes", description: "Ship it." }],
            },
          ],
        },
        sequence: 2,
        turnId: TurnId.makeUnsafe("turn-2"),
        createdAt: "2026-02-27T00:05:00.000Z",
      },
    ];
    expect(
      deriveThreadSummaryMetadata({
        messages,
        activities,
      }),
    ).toEqual({
      latestUserMessageAt: "2026-02-27T00:03:00.000Z",
      hasPendingUserInput: true,
    });
  });

  it("drops stale pending requests once failure events mark them obsolete", () => {
    const activities: OrchestrationThreadActivity[] = [
      {
        id: EventId.makeUnsafe("activity-3"),
        tone: "info",
        kind: "user-input.requested",
        summary: "Questions requested",
        payload: {
          requestId: "input-1",
          questions: [
            {
              id: "question-1",
              header: "Confirm",
              question: "Continue?",
              options: [{ label: "Yes", description: "Continue." }],
            },
          ],
        },
        sequence: 3,
        turnId: TurnId.makeUnsafe("turn-1"),
        createdAt: "2026-02-27T00:03:00.000Z",
      },
      {
        id: EventId.makeUnsafe("activity-4"),
        tone: "error",
        kind: "provider.user-input.respond.failed",
        summary: "User input response failed",
        payload: {
          requestId: "input-1",
          failureCode: "PENDING_INTERACTION_NOT_FOUND",
          detail: "unknown pending user-input request",
        },
        sequence: 4,
        turnId: TurnId.makeUnsafe("turn-1"),
        createdAt: "2026-02-27T00:04:00.000Z",
      },
    ];

    expect(
      deriveThreadSummaryMetadata({
        messages: [],
        activities,
      }),
    ).toEqual({
      latestUserMessageAt: null,
      hasPendingUserInput: false,
    });
  });

  it("keeps replacement requests open when an older runtime generation resolves", () => {
    const question = {
      id: "question-1",
      header: "Confirm",
      question: "Continue?",
      options: [{ label: "Yes", description: "Continue." }],
    };
    const activities: OrchestrationThreadActivity[] = [
      {
        id: EventId.makeUnsafe("input-a"),
        tone: "info",
        kind: "user-input.requested",
        summary: "Questions requested",
        payload: {
          requestId: "reused-input",
          lifecycleGeneration: "generation-a",
          questions: [question],
        },
        sequence: 4,
        turnId: TurnId.makeUnsafe("turn-1"),
        createdAt: "2026-02-27T00:04:00.000Z",
      },
      {
        id: EventId.makeUnsafe("input-b"),
        tone: "info",
        kind: "user-input.requested",
        summary: "Questions requested",
        payload: {
          requestId: "reused-input",
          lifecycleGeneration: "generation-b",
          questions: [question],
        },
        sequence: 5,
        turnId: TurnId.makeUnsafe("turn-1"),
        createdAt: "2026-02-27T00:05:00.000Z",
      },
      {
        id: EventId.makeUnsafe("input-a-resolved"),
        tone: "info",
        kind: "user-input.resolved",
        summary: "User input resolved",
        payload: {
          requestId: "reused-input",
          lifecycleGeneration: "generation-a",
        },
        sequence: 6,
        turnId: TurnId.makeUnsafe("turn-1"),
        createdAt: "2026-02-27T00:06:00.000Z",
      },
    ];

    expect(
      deriveThreadSummaryMetadata({
        messages: [],
        activities,
      }),
    ).toMatchObject({
      hasPendingUserInput: true,
    });
  });

  it("ignores malformed user-input questions that the UI could not render", () => {
    const activities: OrchestrationThreadActivity[] = [
      {
        id: EventId.makeUnsafe("activity-1"),
        tone: "info",
        kind: "user-input.requested",
        summary: "Questions requested",
        payload: {
          requestId: "input-1",
          questions: [
            {
              id: "question-1",
              header: "Confirm",
              question: "Continue?",
              options: [{ label: "Yes" }],
            },
          ],
        },
        sequence: 1,
        turnId: TurnId.makeUnsafe("turn-1"),
        createdAt: "2026-02-27T00:01:00.000Z",
      },
    ];

    expect(
      deriveThreadSummaryMetadata({
        messages: [],
        activities,
      }),
    ).toEqual({
      latestUserMessageAt: null,
      hasPendingUserInput: false,
    });
  });
});

describe("derivePendingThreadRequestIds", () => {
  it("tracks structured questions", () => {
    const at = "2026-10-11T00:00:00.000Z";
    expect(
      derivePendingThreadRequestIds({
        activities: [
          {
            id: EventId.makeUnsafe("question"),
            kind: "user-input.requested",
            createdAt: at,
            payload: {
              requestId: "question-id",
              questions: [
                {
                  id: "choice",
                  header: "Choice",
                  question: "Which?",
                  options: [{ label: "One", description: "First choice" }],
                },
              ],
            },
          },
        ],
      }),
    ).toEqual({ userInputRequestIds: ["question-id"] });
  });
});
