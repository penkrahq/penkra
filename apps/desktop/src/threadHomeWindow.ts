/** Window affinity is transient UI state. Thread and Deck records stay in the server. */
export class ThreadHomeWindow {
  readonly #home = new Map<string, number>();
  readonly #view = new Map<number, Map<string, string>>();
  readonly #activeThread = new Map<number, string>();
  readonly #syncRevision = new Map<number, number>();
  readonly #pending = new Map<string, string>();
  readonly #pendingThreadSelection = new Map<string, string>();
  readonly #agentNavigation = new Map<number, Set<string>>();

  agentNavigation(windowId: number, threadId: string): void {
    const targets = this.#agentNavigation.get(windowId) ?? new Set<string>();
    targets.add(threadId);
    this.#agentNavigation.set(windowId, targets);
  }

  #consumeAgentNavigation(windowId: number, threadId: string): boolean {
    const targets = this.#agentNavigation.get(windowId);
    if (!targets) return false;
    if (!targets.has(threadId)) return false;
    targets.delete(threadId);
    if (targets.size === 0) this.#agentNavigation.delete(windowId);
    return true;
  }

  view(
    windowId: number,
    threadId: string,
    deckId: string,
    userAction: boolean,
    active = true,
  ): void {
    const views = this.#view.get(windowId) ?? new Map<string, string>();
    views.set(threadId, deckId);
    this.#view.set(windowId, views);
    if (active) this.#activeThread.set(windowId, threadId);
    const agentNavigation = active && this.#consumeAgentNavigation(windowId, threadId);
    if (userAction && !agentNavigation) this.#home.set(threadId, windowId);
  }

  replaceViews(
    windowId: number,
    views: readonly { threadId: string; deckId: string }[],
    activeThreadId: string,
    userAction: boolean,
  ): { readonly windowId: number; readonly revision: number } {
    this.#view.set(windowId, new Map(views.map((view) => [view.threadId, view.deckId])));
    this.#activeThread.set(windowId, activeThreadId);
    const revision = (this.#syncRevision.get(windowId) ?? 0) + 1;
    this.#syncRevision.set(windowId, revision);
    const agentNavigation = this.#consumeAgentNavigation(windowId, activeThreadId);
    if (userAction && !agentNavigation) this.#home.set(activeThreadId, windowId);
    return { windowId, revision };
  }

  snapshot(windowId: number): {
    readonly activeThreadId: string;
    readonly views: readonly { threadId: string; deckId: string }[];
  } | null {
    const activeThreadId = this.#activeThread.get(windowId);
    const views = this.#view.get(windowId);
    if (!activeThreadId || !views?.has(activeThreadId)) return null;
    return {
      activeThreadId,
      views: [...views].map(([threadId, deckId]) => ({ threadId, deckId })),
    };
  }

  leave(windowId: number): void {
    this.#view.delete(windowId);
    this.#activeThread.delete(windowId);
  }

  focus(windowId: number): void {
    const threadId = this.#activeThread.get(windowId);
    if (threadId) this.#home.set(threadId, windowId);
  }

  send(windowId: number, threadId: string): void {
    this.#home.set(threadId, windowId);
  }

  inherit(parentThreadId: string, childThreadId: string): void {
    const home = this.#home.get(parentThreadId);
    if (home !== undefined) this.#home.set(childThreadId, home);
  }

  close(windowId: number): void {
    this.#view.delete(windowId);
    this.#activeThread.delete(windowId);
    this.#syncRevision.delete(windowId);
    this.#agentNavigation.delete(windowId);
    for (const [threadId, home] of this.#home) {
      if (home === windowId) this.#home.delete(threadId);
    }
  }

  presentingWindow(
    threadId: string,
    deckId: string,
    readyWindowIds: readonly number[],
  ): number | null {
    const showing = readyWindowIds.filter((id) =>
      [...(this.#view.get(id)?.values() ?? [])].includes(deckId),
    );
    if (showing.length === 0) return null;
    const home = this.#home.get(threadId);
    return home !== undefined && showing.includes(home) ? home : showing[0]!;
  }

  homeWindow(threadId: string, readyWindowIds: readonly number[]): number | null {
    const home = this.#home.get(threadId);
    return home !== undefined && readyWindowIds.includes(home) ? home : null;
  }

  defer(deckId: string, tabId: string): void {
    this.#pending.set(deckId, tabId);
  }

  select(
    presentingThreadId: string,
    selectedThreadId: string,
    deckId: string,
    readyWindowIds: readonly number[],
  ): number | null {
    const target = this.presentingWindow(presentingThreadId, deckId, readyWindowIds);
    if (target === null) this.#pendingThreadSelection.set(deckId, selectedThreadId);
    return target;
  }

  consumeThreadSelection(deckId: string): string | null {
    const threadId = this.#pendingThreadSelection.get(deckId) ?? null;
    if (threadId !== null) this.#pendingThreadSelection.delete(deckId);
    return threadId;
  }

  consume(deckId: string, tabIds: readonly string[]): string | null {
    const pending = this.#pending.get(deckId);
    if (!pending || !tabIds.includes(pending)) return null;
    this.#pending.delete(deckId);
    return pending;
  }

  forgetTab(tabId: string): void {
    for (const [deckId, pending] of this.#pending) {
      if (pending === tabId) this.#pending.delete(deckId);
    }
  }
}
