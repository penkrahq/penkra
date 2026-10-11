// FILE: conversationRollback.ts
// Purpose: Collect the concrete turns removed by a conversation rollback.
// Layer: Shared orchestration utility
// Exports: collectTailTurnIds

type TurnMessageLike<TTurnId extends string = string> = {
  readonly id: string;
  readonly turnId?: TTurnId | null | undefined;
};

function collectUniqueTurnIds<TTurnId extends string>(
  messages: ReadonlyArray<TurnMessageLike<TTurnId>>,
): TTurnId[] {
  return [...new Set(messages.flatMap((message) => (message.turnId ? [message.turnId] : [])))];
}

export function collectTailTurnIds<TTurnId extends string>(input: {
  readonly messages: ReadonlyArray<TurnMessageLike<TTurnId>>;
  readonly messageId: string;
}): TTurnId[] {
  const messageIndex = input.messages.findIndex((message) => message.id === input.messageId);
  if (messageIndex < 0) {
    return [];
  }
  return collectUniqueTurnIds(input.messages.slice(messageIndex));
}
