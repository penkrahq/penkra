export interface ChatRouteSearch {
  splitViewId?: string | undefined;
}

export function parseChatRouteSearch(search: unknown): ChatRouteSearch {
  if (typeof search !== "object" || search === null || Array.isArray(search)) {
    return {};
  }
  const candidate = search as Record<string, unknown>;
  if (typeof candidate.splitViewId !== "string") {
    return {};
  }
  const splitViewId = candidate.splitViewId.trim();
  return splitViewId.length > 0 ? { splitViewId } : {};
}

export function createStableChatRouteSearchSelector() {
  let previous: ChatRouteSearch | null = null;
  return (search: unknown): ChatRouteSearch => {
    const next = parseChatRouteSearch(search);
    if (previous !== null && previous.splitViewId === next.splitViewId) {
      return previous;
    }
    previous = next;
    return next;
  };
}
