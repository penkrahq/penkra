const ID = /^[a-f0-9]{32}$/u;
const TTL_MS = 120_000;
const MAX_CLIENTS = 128;

function requestId(raw: string): string | null {
  try {
    const frame = JSON.parse(raw) as { _tag?: unknown; id?: unknown };
    return frame?._tag === "Request" && typeof frame.id === "string" ? frame.id : null;
  } catch {
    return null;
  }
}

function successfulResponseId(raw: string): string | null {
  try {
    const frame = JSON.parse(raw) as {
      _tag?: unknown;
      requestId?: unknown;
      exit?: { _tag?: unknown };
    };
    return frame?._tag === "Exit" &&
      frame.exit?._tag === "Success" &&
      typeof frame.requestId === "string"
      ? frame.requestId
      : null;
  } catch {
    return null;
  }
}

/** Requires a single-use main ticket, a prior close, and a completed RPC. */
export class QaSocketReconnectTracker {
  private readonly clients = new Map<string, { closed: boolean; at: number }>();
  private readonly usedTickets = new Map<string, number>();

  constructor(
    private readonly onReconnect: (traceId: string) => void,
    private readonly verifyClient: (
      clientId: string | null,
      ticketId: string | null,
      signature: string | null,
    ) => boolean,
  ) {}

  opened(input: {
    readonly clientId: string | null;
    readonly ticketId: string | null;
    readonly signature: string | null;
    readonly traceId: string | null;
  }): {
    readonly closed: () => void;
    readonly receivedFrame: (raw: string) => void;
    readonly sentFrame: (raw: string) => void;
  } {
    const { clientId, ticketId, signature, traceId } = input;
    const noop = { closed: () => {}, receivedFrame: () => {}, sentFrame: () => {} };
    if (
      !clientId ||
      !ticketId ||
      !ID.test(clientId) ||
      !ID.test(ticketId) ||
      !this.verifyClient(clientId, ticketId, signature)
    )
      return noop;
    const now = Date.now();
    for (const [key, state] of this.clients) if (now - state.at > TTL_MS) this.clients.delete(key);
    for (const [key, at] of this.usedTickets) if (now - at > TTL_MS) this.usedTickets.delete(key);
    if (this.usedTickets.has(ticketId)) return noop;
    this.usedTickets.set(ticketId, now);
    if (this.usedTickets.size > MAX_CLIENTS * 4)
      this.usedTickets.delete(this.usedTickets.keys().next().value!);
    const previous = this.clients.get(clientId);
    const isReconnect = previous?.closed && traceId && ID.test(traceId);
    const current = { closed: false, at: now };
    this.clients.delete(clientId);
    this.clients.set(clientId, current);
    if (this.clients.size > MAX_CLIENTS) this.clients.delete(this.clients.keys().next().value!);
    let proved = false;
    const requests = new Set<string>();
    return {
      closed: () => {
        if (this.clients.get(clientId) === current) current.closed = true;
      },
      receivedFrame: (raw) => {
        if (!isReconnect || proved) return;
        if (this.clients.get(clientId) !== current || current.closed) return;
        const id = requestId(raw);
        if (id) requests.add(id);
      },
      sentFrame: (raw) => {
        if (!isReconnect || proved) return;
        if (this.clients.get(clientId) !== current || current.closed) return;
        const id = successfulResponseId(raw);
        if (!id || !requests.has(id)) return;
        proved = true;
        this.onReconnect(traceId);
      },
    };
  }
}
