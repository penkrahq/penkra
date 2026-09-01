export type CodexConversationHistoryMutationCapability =
  | { readonly state: "unavailable-until-session-open" }
  | { readonly state: "supported"; readonly historyMode: "legacy" }
  | {
      readonly state: "incompatible-codex-protocol";
      readonly historyMode: "paginated" | null;
    }
  | { readonly state: "unsupported-history-mode"; readonly historyMode: string };

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Resolves the history-mutation contract only from the field declared by the
 * opened native thread. Missing and malformed fields are not legacy evidence.
 */
export function resolveCodexConversationHistoryMutationCapability(
  threadOpenResponse: unknown,
): Exclude<
  CodexConversationHistoryMutationCapability,
  { readonly state: "unavailable-until-session-open" }
> {
  const response = asObject(threadOpenResponse);
  const thread = asObject(response?.thread);
  const historyMode = thread?.historyMode;

  if (historyMode === "legacy") {
    return { state: "supported", historyMode };
  }
  if (historyMode === "paginated") {
    return { state: "incompatible-codex-protocol", historyMode };
  }
  if (typeof historyMode === "string") {
    return { state: "unsupported-history-mode", historyMode };
  }
  return { state: "incompatible-codex-protocol", historyMode: null };
}

export function codexConversationHistoryMutationUnavailableMessage(
  capability: Exclude<CodexConversationHistoryMutationCapability, { readonly state: "supported" }>,
): string {
  switch (capability.state) {
    case "unavailable-until-session-open":
      return "Codex conversation history is unavailable until the native thread has opened. No history mutation was sent.";
    case "incompatible-codex-protocol":
      return capability.historyMode === "paginated"
        ? "Editing completed messages is unavailable for this paginated Codex thread because this Penkra build has not verified the required history-mutation protocol. The existing session was left running and no history mutation was sent."
        : "Codex did not report a valid thread history mode. Penkra cannot safely select a history mutation, so the existing session was left running and no history mutation was sent.";
    case "unsupported-history-mode":
      return `Codex reported unsupported thread history mode '${capability.historyMode}'. The existing session was left running and no history mutation was sent.`;
  }
}

export class CodexConversationHistoryMutationUnavailableError extends Error {
  readonly capability: Exclude<
    CodexConversationHistoryMutationCapability,
    { readonly state: "supported" }
  >;

  constructor(
    capability: Exclude<
      CodexConversationHistoryMutationCapability,
      { readonly state: "supported" }
    >,
  ) {
    super(codexConversationHistoryMutationUnavailableMessage(capability));
    this.name = "CodexConversationHistoryMutationUnavailableError";
    this.capability = capability;
  }
}
