const ID = /^[a-f0-9]{32}$/u;
const TTL_MS = 120_000;
const MAX_CLIENTS = 128;

/** Observes actual feature WebSocket connections; URL claims alone never sign a proof. */
export class QaSocketReconnectTracker {
  private readonly clients = new Map<string, { closed: boolean; at: number }>();

  constructor(private readonly onReconnect: (traceId: string) => void) {}

  opened(clientId: string | null, traceId: string | null): () => void {
    if (!clientId || !ID.test(clientId)) return () => {};
    const now = Date.now();
    for (const [key, state] of this.clients) if (now - state.at > TTL_MS) this.clients.delete(key);
    const previous = this.clients.get(clientId);
    const isReconnect = previous?.closed && traceId && ID.test(traceId);
    const current = { closed: false, at: now };
    this.clients.delete(clientId);
    this.clients.set(clientId, current);
    if (this.clients.size > MAX_CLIENTS) this.clients.delete(this.clients.keys().next().value!);
    if (isReconnect) this.onReconnect(traceId);
    return () => {
      if (this.clients.get(clientId) === current) current.closed = true;
    };
  }
}
