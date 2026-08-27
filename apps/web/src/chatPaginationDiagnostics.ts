// FILE: chatPaginationDiagnostics.ts
// Purpose: Produces content-free evidence for transcript page composition and viewport anchoring.
// Layer: Web chat diagnostics

import type { OrchestrationGetThreadTurnsPageResult } from "@penkra/contracts";

export function readPaginationViewportAnchor(element: HTMLElement | null) {
  if (!element) return { anchorIndex: null, anchorKey: null, anchorOffset: null };
  const viewportTop = element.getBoundingClientRect().top;
  const candidates = element.querySelectorAll<HTMLElement>("[data-index]");
  for (const candidate of candidates) {
    const bounds = candidate.getBoundingClientRect();
    if (bounds.bottom > viewportTop + 0.5) {
      return {
        anchorIndex: Number(candidate.dataset.index),
        anchorKey: candidate.dataset.rowKey ?? null,
        anchorOffset: bounds.top - viewportTop,
      };
    }
  }
  return { anchorIndex: null, anchorKey: null, anchorOffset: null };
}

export function summarizeThreadTurnsPage(page: OrchestrationGetThreadTurnsPageResult) {
  const messages = page.messages;
  return {
    conversationTurnCount: page.conversationTurnCount,
    messageCount: messages.length,
    userMessageCount: messages.filter((message) => message.role === "user").length,
    assistantMessageCount: messages.filter((message) => message.role === "assistant").length,
    systemMessageCount: messages.filter((message) => message.role === "system").length,
    activityCount: page.activities.length,
    pendingInteractionCount: page.pendingInteractions.length,
    hasOlder: page.hasOlder,
    nextCursorPresent: page.nextCursor !== null,
    snapshotSequence: page.snapshotSequence,
  };
}
