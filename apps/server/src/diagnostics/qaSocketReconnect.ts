const ID = /^[a-f0-9]{32}$/u;
const TTL_MS = 120_000;
const MAX_CLIENTS = 128;

function isRecoveryRpcFrame(raw: string): boolean {
  try {
    const frame = JSON.parse(raw) as { _tag?: unknown };
    return frame?._tag === "Request" || frame?._tag === "Ping";
  } catch {
    return false;
  }
}

/** Requires a main-issued transport ticket, a prior close, and resumed RPC traffic. */
export class QaSocketReconnectTracker {
  private readonly clients = new Map<string, { closed: boolean; at: number }>();

  constructor(
    private readonly onReconnect: (traceId: string) => void,
    private readonly verifyClient: (clientId: string | null, signature: string | null) => boolean,
  ) {}

  opened(input: {
    readonly clientId: string | null;
    readonly signature: string | null;
    readonly traceId: string | null;
  }): { readonly closed: () => void; readonly receivedFrame: (raw: string) => void } {
    const { clientId, signature, traceId } = input;
    const noop = { closed: () => {}, receivedFrame: () => {} };
    if (!clientId || !ID.test(clientId) || !this.verifyClient(clientId, signature)) return noop;
    const now = Date.now();
    for (const [key, state] of this.clients) if (now - state.at > TTL_MS) this.clients.delete(key);
    const previous = this.clients.get(clientId);
    const isReconnect = previous?.closed && traceId && ID.test(traceId);
    const current = { closed: false, at: now };
    this.clients.delete(clientId);
    this.clients.set(clientId, current);
    if (this.clients.size > MAX_CLIENTS) this.clients.delete(this.clients.keys().next().value!);
    let proved = false;
    return {
      closed: () => {
        if (this.clients.get(clientId) === current) current.closed = true;
      },
      receivedFrame: (raw) => {
        if (!isReconnect || proved || !isRecoveryRpcFrame(raw)) return;
        if (this.clients.get(clientId) !== current || current.closed) return;
        proved = true;
        this.onReconnect(traceId);
      },
    };
  }
}
