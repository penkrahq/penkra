const ID = /^[a-f0-9]{32}$/u;
const TTL_MS = 120_000;
const MAX_CLIENTS = 128;

function frames(raw: string): unknown[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

function requestId(frame: unknown): string | null {
  if (!frame || typeof frame !== "object") return null;
  const candidate = frame as { _tag?: unknown; id?: unknown };
  return candidate._tag === "Request" && typeof candidate.id === "string" ? candidate.id : null;
}

function successfulResponseId(frame: unknown): string | null {
  if (!frame || typeof frame !== "object") return null;
  const candidate = frame as {
    _tag?: unknown;
    requestId?: unknown;
    exit?: { _tag?: unknown };
  };
  return candidate._tag === "Exit" &&
    candidate.exit?._tag === "Success" &&
    typeof candidate.requestId === "string"
    ? candidate.requestId
    : null;
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
        for (const frame of frames(raw)) {
          const id = requestId(frame);
          if (id) requests.add(id);
        }
      },
      sentFrame: (raw) => {
        if (!isReconnect || proved) return;
        if (this.clients.get(clientId) !== current || current.closed) return;
        for (const frame of frames(raw)) {
          const id = successfulResponseId(frame);
          if (!id || !requests.has(id)) continue;
          proved = true;
          this.onReconnect(traceId);
          return;
        }
      },
    };
  }
}
