import {
  CommandId,
  MessageId,
  ProviderConnectionId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationThread,
} from "@penkra/contracts";
import { describe, expect, it } from "vitest";

import { describeRejectedPlay } from "./playRejectionDiagnostics.ts";

const threadId = ThreadId.makeUnsafe("f4fe9a91-30a7-4afd-8b14-18348aa85399");
const logicalTurnId = TurnId.makeUnsafe("turn:5e4001b7-a59c-42de-b1dd-20e7d27640be");
const providerTurnId = TurnId.makeUnsafe("a3f9d56b-1701-49a9-9787-d529072d9b5f");
const connectionId = ProviderConnectionId.makeUnsafe("a14baace-7fc4-46e0-a516-bd421b7ae629");
const thread = {
  id: threadId,
  latestTurn: { turnId: logicalTurnId, providerTurnId, state: "interrupted" },
  session: { status: "interrupted", activeTurnId: null },
  queuedMessageIds: [],
  pendingTurnStartMessageId: null,
  pendingInteractions: [],
  archivedAt: null,
  deletedAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
} as unknown as OrchestrationThread;
const command = {
  type: "thread.turn.recover",
  reason: "play",
  threadId,
  commandId: CommandId.makeUnsafe("a4ae8208-c6c1-4dbd-8ef9-375b58da97c5"),
  turnId: providerTurnId,
  interruptedTurnId: providerTurnId,
  recoveryMessageId: MessageId.makeUnsafe("play-recovery"),
  connectionId,
  bindingRevision: 0,
  createdAt: "2026-09-26T22:18:23.579Z",
} as Extract<OrchestrationCommand, { type: "thread.turn.recover" }>;
const binding = { connectionId, revision: 0, modelId: "claude-haiku-4-5-20251001" } as const;

describe("rejected Play diagnostics", () => {
  it("identifies the logical versus provider turn mismatch with the recorded values", () => {
    expect(describeRejectedPlay(command, thread, binding)).toMatchObject({
      playCheck: "turn_id_mismatch",
      expectedTurnId: logicalTurnId,
      receivedTurnId: providerTurnId,
      expectedConnectionId: connectionId,
      receivedConnectionId: connectionId,
      expectedBindingRevision: 0,
      receivedBindingRevision: 0,
    });
  });

  it("identifies a binding revision mismatch after the correct turn is sent", () => {
    expect(
      describeRejectedPlay(
        { ...command, turnId: logicalTurnId, interruptedTurnId: logicalTurnId, bindingRevision: 1 },
        thread,
        binding,
      ),
    ).toMatchObject({
      playCheck: "binding_mismatch",
      expectedBindingRevision: 0,
      receivedBindingRevision: 1,
    });
  });
});
