import type { Writable } from "node:stream";

export const CODEX_APP_SERVER_MAX_FRAME_BYTES = 16 * 1024 * 1024;
export const CODEX_APP_SERVER_MAX_QUEUED_STDIN_BYTES = 32 * 1024 * 1024;
export const CODEX_APP_SERVER_MAX_DISCARDED_FRAME_BYTES = 512 * 1024 * 1024;
const CODEX_APP_SERVER_MAX_JSON_NESTING = 128;
const SAFE_CODEX_PROTOCOL_METHODS: ReadonlySet<string> = new Set([
  "codex/event/item_completed",
  "item/completed",
  "item/started",
  "item/fileChange/patchUpdated",
  "turn/diff/updated",
]);
const SAFE_CODEX_PROTOCOL_TYPES: ReadonlySet<string> = new Set([
  "FileChange",
  "fileChange",
  "item_completed",
  "mcpToolCall",
]);

export type CodexOversizedNotificationFrame = {
  readonly kind: "oversized-notification";
  readonly method:
    | "codex/event/item_completed"
    | "item/completed"
    | "item/started"
    | "item/fileChange/patchUpdated"
    | "turn/diff/updated";
  readonly itemType?: "fileChange";
  readonly status?: "failed" | "declined";
  readonly threadId?: string;
  readonly turnId?: string;
  readonly itemId?: string;
  readonly maxBytes: number;
  readonly observedBytes: number;
};

export type CodexJsonlFrame = string | CodexOversizedNotificationFrame;

export type CodexAppServerTransportErrorReason =
  | "frame-too-large"
  | "invalid-utf8"
  | "unterminated-frame"
  | "read-closed"
  | "write-overloaded"
  | "write-closed";

export class CodexAppServerTransportError extends Error {
  readonly reason: CodexAppServerTransportErrorReason;
  readonly maxBytes: number;
  readonly observedBytes: number;
  readonly protocolMethod: string | undefined;
  readonly protocolTypes: ReadonlyArray<string>;

  constructor(input: {
    readonly reason: CodexAppServerTransportErrorReason;
    readonly maxBytes: number;
    readonly observedBytes: number;
    readonly protocolMethod?: string;
    readonly protocolTypes?: ReadonlyArray<string>;
    readonly cause?: unknown;
  }) {
    super(transportErrorMessage(input), {
      ...(input.cause !== undefined ? { cause: input.cause } : {}),
    });
    this.name = "CodexAppServerTransportError";
    this.reason = input.reason;
    this.maxBytes = input.maxBytes;
    this.observedBytes = input.observedBytes;
    this.protocolMethod = input.protocolMethod;
    this.protocolTypes = input.protocolTypes ?? [];
  }
}

/** Raw-byte JSONL framing so split UTF-8 sequences never decode prematurely. */
export class CodexJsonlFramer {
  private readonly chunks: Buffer[] = [];
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });
  private frameBytes = 0;
  private oversizedFrame = false;
  private oversizedEnvelope: JsonTopLevelEnvelopeScanner | undefined;
  private oversizedDecoder: TextDecoder | undefined;
  private ended = false;

  constructor(
    readonly maxFrameBytes = CODEX_APP_SERVER_MAX_FRAME_BYTES,
    readonly maxDiscardedFrameBytes = CODEX_APP_SERVER_MAX_DISCARDED_FRAME_BYTES,
  ) {
    if (
      !Number.isSafeInteger(maxFrameBytes) ||
      maxFrameBytes <= 0 ||
      !Number.isSafeInteger(maxDiscardedFrameBytes) ||
      maxDiscardedFrameBytes < maxFrameBytes
    ) {
      throw new RangeError(
        "Codex JSONL frame budgets must be positive safe integers and discarded >= normal",
      );
    }
  }

  push(chunk: Buffer | Uint8Array | string): ReadonlyArray<CodexJsonlFrame> {
    if (this.ended) {
      throw new CodexAppServerTransportError({
        reason: "unterminated-frame",
        maxBytes: this.maxFrameBytes,
        observedBytes: this.frameBytes,
      });
    }

    const bytes =
      typeof chunk === "string"
        ? Buffer.from(chunk)
        : Buffer.isBuffer(chunk)
          ? chunk
          : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    const frames: CodexJsonlFrame[] = [];
    let start = 0;

    while (start < bytes.length) {
      const newline = bytes.indexOf(0x0a, start);
      const end = newline === -1 ? bytes.length : newline;
      this.append(bytes.subarray(start, end));
      if (newline === -1) break;
      frames.push(this.takeFrame());
      start = newline + 1;
    }

    return frames;
  }

  finish(): void {
    this.ended = true;
    if (this.frameBytes > 0) {
      throw new CodexAppServerTransportError({
        reason: "unterminated-frame",
        maxBytes: this.maxFrameBytes,
        observedBytes: this.frameBytes,
      });
    }
  }

  reset(): void {
    this.chunks.length = 0;
    this.frameBytes = 0;
    this.oversizedFrame = false;
    this.oversizedEnvelope = undefined;
    this.oversizedDecoder = undefined;
    this.ended = true;
  }

  get bufferedBytes(): number {
    return this.frameBytes;
  }

  private append(chunk: Buffer): void {
    if (chunk.length === 0) return;
    const observedBytes = this.frameBytes + chunk.length;
    if (this.oversizedFrame) {
      try {
        this.oversizedDecoder?.decode(chunk, { stream: true });
      } catch (cause) {
        throw new CodexAppServerTransportError({
          reason: "invalid-utf8",
          maxBytes: this.maxFrameBytes,
          observedBytes,
          cause,
        });
      }
      const envelope = this.oversizedEnvelope;
      envelope?.push(chunk);
      if (
        envelope?.isInvalid ||
        envelope?.hasId ||
        oversizedNotificationEligibility(envelope) === "ineligible"
      ) {
        throw new CodexAppServerTransportError({
          reason: "frame-too-large",
          maxBytes: this.maxFrameBytes,
          observedBytes,
          ...summarizeOversizedProtocolCandidate(envelope),
        });
      }
      if (observedBytes > this.maxDiscardedFrameBytes) {
        throw new CodexAppServerTransportError({
          reason: "frame-too-large",
          maxBytes: this.maxDiscardedFrameBytes,
          observedBytes,
          ...summarizeOversizedProtocolCandidate(envelope),
        });
      }
      this.frameBytes = observedBytes;
      return;
    }
    if (observedBytes > this.maxFrameBytes) {
      const oversizedEnvelope = new JsonTopLevelEnvelopeScanner();
      const oversizedDecoder = new TextDecoder("utf-8", { fatal: true });
      try {
        for (const retainedChunk of [...this.chunks, chunk]) {
          oversizedEnvelope.push(retainedChunk);
          oversizedDecoder.decode(retainedChunk, { stream: true });
        }
      } catch (cause) {
        throw new CodexAppServerTransportError({
          reason: "invalid-utf8",
          maxBytes: this.maxFrameBytes,
          observedBytes,
          cause,
        });
      }
      if (oversizedEnvelope.isInvalid) {
        throw new CodexAppServerTransportError({
          reason: "frame-too-large",
          maxBytes: this.maxFrameBytes,
          observedBytes,
          ...summarizeOversizedProtocolCandidate(oversizedEnvelope),
        });
      }
      if (oversizedEnvelope.hasId) {
        throw new CodexAppServerTransportError({
          reason: "frame-too-large",
          maxBytes: this.maxFrameBytes,
          observedBytes,
          ...summarizeOversizedProtocolCandidate(oversizedEnvelope),
        });
      }
      if (oversizedNotificationEligibility(oversizedEnvelope) === "ineligible") {
        throw new CodexAppServerTransportError({
          reason: "frame-too-large",
          maxBytes: this.maxFrameBytes,
          observedBytes,
          ...summarizeOversizedProtocolCandidate(oversizedEnvelope),
        });
      }
      if (observedBytes > this.maxDiscardedFrameBytes) {
        throw new CodexAppServerTransportError({
          reason: "frame-too-large",
          maxBytes: this.maxDiscardedFrameBytes,
          observedBytes,
          ...summarizeOversizedProtocolCandidate(oversizedEnvelope),
        });
      }
      this.chunks.length = 0;
      this.frameBytes = observedBytes;
      this.oversizedFrame = true;
      this.oversizedEnvelope = oversizedEnvelope;
      this.oversizedDecoder = oversizedDecoder;
      return;
    }
    // Do not retain a large source chunk through one small trailing slice.
    this.chunks.push(Buffer.from(chunk));
    this.frameBytes = observedBytes;
  }

  private takeFrame(): CodexJsonlFrame {
    if (this.oversizedFrame) {
      try {
        this.oversizedDecoder?.decode();
      } catch (cause) {
        throw new CodexAppServerTransportError({
          reason: "invalid-utf8",
          maxBytes: this.maxFrameBytes,
          observedBytes: this.frameBytes,
          cause,
        });
      }
      const envelope = this.oversizedEnvelope;
      const oversizedNotification =
        envelope?.isComplete && !envelope.hasId
          ? classifyOversizedNotification(envelope)
          : undefined;
      if (!oversizedNotification) {
        const protocolSummary = summarizeOversizedProtocolCandidate(envelope);
        throw new CodexAppServerTransportError({
          reason: "frame-too-large",
          maxBytes: this.maxFrameBytes,
          observedBytes: this.frameBytes,
          ...protocolSummary,
        });
      }
      const frame = {
        ...oversizedNotification,
        maxBytes: this.maxFrameBytes,
        observedBytes: this.frameBytes,
      } satisfies CodexOversizedNotificationFrame;
      this.oversizedFrame = false;
      this.oversizedEnvelope = undefined;
      this.oversizedDecoder = undefined;
      this.frameBytes = 0;
      return frame;
    }
    let frame = Buffer.concat(this.chunks, this.frameBytes);
    if (frame.at(-1) === 0x0d) frame = frame.subarray(0, -1);
    this.chunks.length = 0;
    this.frameBytes = 0;
    try {
      return this.decoder.decode(frame);
    } catch (cause) {
      throw new CodexAppServerTransportError({
        reason: "invalid-utf8",
        maxBytes: this.maxFrameBytes,
        observedBytes: frame.length,
        cause,
      });
    }
  }
}

function classifyOversizedNotification(
  envelope: JsonTopLevelEnvelopeScanner,
): Omit<CodexOversizedNotificationFrame, "maxBytes" | "observedBytes"> | undefined {
  const { method, modernItemType, legacyItemType } = envelope;
  const isFileChangeLifecycle =
    (method === "item/started" || method === "item/completed") &&
    (modernItemType === "fileChange" || modernItemType === "FileChange");
  const isLegacyFileChangeCompletion =
    method === "codex/event/item_completed" && legacyItemType === "FileChange";
  if (
    !isFileChangeLifecycle &&
    !isLegacyFileChangeCompletion &&
    method !== "item/fileChange/patchUpdated" &&
    method !== "turn/diff/updated"
  ) {
    return undefined;
  }

  const threadId = isLegacyFileChangeCompletion ? envelope.legacyThreadId : envelope.threadId;
  const turnId = isLegacyFileChangeCompletion ? envelope.legacyTurnId : envelope.turnId;
  const itemId = isLegacyFileChangeCompletion ? undefined : envelope.itemId;
  const rawStatus = isFileChangeLifecycle ? envelope.status : undefined;
  const status = rawStatus === "failed" || rawStatus === "declined" ? rawStatus : undefined;

  return {
    kind: "oversized-notification",
    method,
    ...(isFileChangeLifecycle || isLegacyFileChangeCompletion
      ? { itemType: "fileChange" as const }
      : {}),
    ...(threadId ? { threadId } : {}),
    ...(turnId ? { turnId } : {}),
    ...(itemId ? { itemId } : {}),
    ...(status ? { status } : {}),
  };
}

function oversizedNotificationEligibility(
  envelope: JsonTopLevelEnvelopeScanner | undefined,
): "eligible" | "ineligible" | "unknown" {
  const method = envelope?.method;
  if (method === undefined) return "unknown";
  if (method === "item/fileChange/patchUpdated" || method === "turn/diff/updated") {
    return "eligible";
  }
  if (method === "item/started" || method === "item/completed") {
    const itemType = envelope?.modernItemType;
    if (itemType === undefined) return "unknown";
    return itemType === "fileChange" || itemType === "FileChange" ? "eligible" : "ineligible";
  }
  if (method === "codex/event/item_completed") {
    const itemType = envelope?.legacyItemType;
    if (itemType === undefined) return "unknown";
    return itemType === "FileChange" ? "eligible" : "ineligible";
  }
  return "ineligible";
}

function summarizeOversizedProtocolCandidate(envelope: JsonTopLevelEnvelopeScanner | undefined): {
  readonly protocolMethod?: string;
  readonly protocolTypes: ReadonlyArray<string>;
} {
  const protocolMethod = envelope?.method;
  const protocolTypes = [
    envelope?.modernItemType,
    envelope?.legacyMessageType,
    envelope?.legacyItemType,
  ].filter((value): value is string => value !== undefined && SAFE_CODEX_PROTOCOL_TYPES.has(value));
  return {
    ...(protocolMethod && SAFE_CODEX_PROTOCOL_METHODS.has(protocolMethod)
      ? { protocolMethod }
      : {}),
    protocolTypes: [...new Set(protocolTypes)],
  };
}

type JsonContainerLabel =
  | "root"
  | "params"
  | "modernItem"
  | "legacyMessage"
  | "legacyItem"
  | "other";
type JsonContainerExpectation =
  | "keyOrEnd"
  | "key"
  | "colon"
  | "valueOrEnd"
  | "value"
  | "commaOrEnd";

type JsonContainerState = {
  readonly closeByte: number;
  readonly kind: "object" | "array";
  readonly label: JsonContainerLabel;
  expectation: JsonContainerExpectation;
  pendingKey: string | null | undefined;
  valueKey: string | undefined;
};

class JsonTopLevelEnvelopeScanner {
  method: string | undefined;
  hasId = false;
  modernItemType: string | undefined;
  legacyMessageType: string | undefined;
  legacyItemType: string | undefined;
  threadId: string | undefined;
  turnId: string | undefined;
  legacyThreadId: string | undefined;
  legacyTurnId: string | undefined;
  itemId: string | undefined;
  status: string | undefined;
  private readonly containers: JsonContainerState[] = [];
  private sawRootObject = false;
  private rootClosed = false;
  private invalidStructure = false;
  private inString = false;
  private escaped = false;
  private unicodeEscapeRemaining = 0;
  private stringRole: "key" | "value" | undefined;
  private stringContext: JsonContainerState | undefined;
  private stringValueKey: string | undefined;
  private stringBytes: number[] | undefined;
  private primitiveBytes: number[] | undefined;

  get isInvalid(): boolean {
    return this.invalidStructure;
  }

  get isComplete(): boolean {
    return (
      this.sawRootObject &&
      this.rootClosed &&
      !this.invalidStructure &&
      this.containers.length === 0 &&
      !this.inString &&
      !this.escaped &&
      this.unicodeEscapeRemaining === 0 &&
      this.primitiveBytes === undefined
    );
  }

  push(chunk: Buffer): void {
    for (const byte of chunk) {
      if (this.invalidStructure) return;
      if (this.inString) {
        if (this.escaped) {
          if (this.unicodeEscapeRemaining > 0) {
            if (!isJsonHexByte(byte)) {
              this.invalidStructure = true;
              return;
            }
            this.unicodeEscapeRemaining -= 1;
            if (this.unicodeEscapeRemaining === 0) this.escaped = false;
          } else if (byte === 0x75) {
            this.unicodeEscapeRemaining = 4;
          } else if (isJsonSimpleEscapeByte(byte)) {
            this.escaped = false;
          } else {
            this.invalidStructure = true;
            return;
          }
          this.appendStringByte(byte);
        } else if (byte === 0x5c) {
          this.escaped = true;
          this.appendStringByte(byte);
        } else if (byte === 0x22) {
          this.finishString();
        } else if (byte < 0x20) {
          this.invalidStructure = true;
          return;
        } else {
          this.appendStringByte(byte);
        }
        continue;
      }

      if (this.primitiveBytes) {
        if (isJsonValueDelimiterByte(byte)) {
          this.finishPrimitive();
          if (this.invalidStructure) return;
        } else {
          if (this.primitiveBytes.length >= 64) {
            this.invalidStructure = true;
            return;
          }
          this.primitiveBytes.push(byte);
          continue;
        }
      }

      if (isJsonWhitespaceByte(byte)) continue;

      if (this.containers.length === 0) {
        if (!this.sawRootObject && byte === 0x7b) {
          this.sawRootObject = true;
          this.containers.push(createJsonContainer(0x7d, "root"));
          continue;
        }
        this.invalidStructure = true;
        continue;
      }

      const context = this.containers.at(-1);
      if (!context) {
        this.invalidStructure = true;
        return;
      }
      if (byte === 0x22) {
        const isKey =
          context.kind === "object" &&
          (context.expectation === "keyOrEnd" || context.expectation === "key");
        if (!isKey && !canStartJsonValue(context)) {
          this.invalidStructure = true;
          return;
        }
        this.inString = true;
        this.stringContext = context;
        this.stringValueKey = context.valueKey;
        this.stringRole = isKey
          ? "key"
          : context.kind === "object" &&
              shouldCaptureProtocolString(context.label, context.valueKey)
            ? "value"
            : undefined;
        if (!isKey) markJsonValueStarted(context);
        this.stringBytes = this.stringRole ? [] : undefined;
      } else if (byte === 0x7b || byte === 0x5b) {
        if (!canStartJsonValue(context)) {
          this.invalidStructure = true;
          return;
        }
        if (this.containers.length >= CODEX_APP_SERVER_MAX_JSON_NESTING) {
          this.invalidStructure = true;
          return;
        }
        const childLabel =
          byte === 0x7b ? childJsonContainerLabel(context.label, context.valueKey) : "other";
        markJsonValueStarted(context);
        context.valueKey = undefined;
        this.containers.push(createJsonContainer(byte === 0x7b ? 0x7d : 0x5d, childLabel));
      } else if (byte === 0x7d || byte === 0x5d) {
        if (context.closeByte !== byte || !canCloseJsonContainer(context)) {
          this.invalidStructure = true;
          return;
        }
        this.containers.pop();
        if (this.containers.length === 0) this.rootClosed = true;
      } else if (context.kind === "object" && context.expectation === "colon" && byte === 0x3a) {
        context.valueKey = context.pendingKey ?? undefined;
        this.hasId ||= context.label === "root" && context.pendingKey === "id";
        context.pendingKey = undefined;
        context.expectation = "value";
      } else if (byte === 0x2c && context.expectation === "commaOrEnd") {
        context.pendingKey = undefined;
        context.valueKey = undefined;
        context.expectation = context.kind === "object" ? "key" : "value";
      } else if (isJsonPrimitiveStartByte(byte) && canStartJsonValue(context)) {
        markJsonValueStarted(context);
        this.primitiveBytes = [byte];
      } else {
        this.invalidStructure = true;
        return;
      }
    }
  }

  private finishString(): void {
    const value = this.decodeString();
    if (this.stringRole === "key" && this.stringContext) {
      this.stringContext.pendingKey = value ?? null;
      this.stringContext.expectation = "colon";
    } else if (this.stringRole === "value" && value !== undefined && this.stringContext) {
      this.captureProtocolString(this.stringContext.label, this.stringValueKey, value);
    }
    this.inString = false;
    this.escaped = false;
    this.unicodeEscapeRemaining = 0;
    this.stringRole = undefined;
    this.stringContext = undefined;
    this.stringValueKey = undefined;
    this.stringBytes = undefined;
  }

  private appendStringByte(byte: number): void {
    if (!this.stringBytes) return;
    if (this.stringBytes.length >= 512) {
      this.stringBytes = undefined;
      return;
    }
    this.stringBytes.push(byte);
  }

  private finishPrimitive(): void {
    const value = Buffer.from(this.primitiveBytes ?? []).toString("ascii");
    this.primitiveBytes = undefined;
    if (!/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)$/.test(value)) {
      this.invalidStructure = true;
    }
  }

  private decodeString(): string | undefined {
    if (!this.stringBytes || this.stringBytes.length > 512) return undefined;
    try {
      const value: unknown = JSON.parse(`"${Buffer.from(this.stringBytes).toString("utf8")}"`);
      return typeof value === "string" ? value : undefined;
    } catch {
      return undefined;
    }
  }

  private captureProtocolString(
    label: JsonContainerLabel,
    key: string | undefined,
    value: string,
  ): void {
    if (label === "root" && key === "method") this.method = value;
    else if (label === "params" && key === "threadId") this.threadId = value;
    else if (label === "params" && key === "turnId") this.turnId = value;
    else if (label === "modernItem" && key === "type") this.modernItemType = value;
    else if (label === "modernItem" && key === "id") this.itemId = value;
    else if (label === "modernItem" && key === "status") this.status = value;
    else if (label === "legacyMessage" && key === "type") this.legacyMessageType = value;
    else if (label === "legacyMessage" && key === "thread_id") this.legacyThreadId = value;
    else if (label === "legacyMessage" && key === "turn_id") this.legacyTurnId = value;
    else if (label === "legacyItem" && key === "type") this.legacyItemType = value;
  }
}

function createJsonContainer(closeByte: number, label: JsonContainerLabel): JsonContainerState {
  return {
    closeByte,
    kind: closeByte === 0x7d ? "object" : "array",
    label,
    expectation: closeByte === 0x7d ? "keyOrEnd" : "valueOrEnd",
    pendingKey: undefined,
    valueKey: undefined,
  };
}

function canStartJsonValue(context: JsonContainerState): boolean {
  return (
    (context.kind === "object" && context.expectation === "value") ||
    (context.kind === "array" &&
      (context.expectation === "valueOrEnd" || context.expectation === "value"))
  );
}

function markJsonValueStarted(context: JsonContainerState): void {
  context.expectation = "commaOrEnd";
}

function canCloseJsonContainer(context: JsonContainerState): boolean {
  return context.kind === "object"
    ? context.expectation === "keyOrEnd" || context.expectation === "commaOrEnd"
    : context.expectation === "valueOrEnd" || context.expectation === "commaOrEnd";
}

function childJsonContainerLabel(
  parentLabel: JsonContainerLabel,
  valueKey: string | undefined,
): JsonContainerLabel {
  if (parentLabel === "root" && valueKey === "params") return "params";
  if (parentLabel === "params" && valueKey === "item") return "modernItem";
  if (parentLabel === "params" && valueKey === "msg") return "legacyMessage";
  if (parentLabel === "legacyMessage" && valueKey === "item") return "legacyItem";
  return "other";
}

function shouldCaptureProtocolString(label: JsonContainerLabel, key: string | undefined): boolean {
  return (
    (label === "root" && key === "method") ||
    (label === "params" && (key === "threadId" || key === "turnId")) ||
    (label === "modernItem" && (key === "type" || key === "id" || key === "status")) ||
    (label === "legacyMessage" && (key === "type" || key === "thread_id" || key === "turn_id")) ||
    (label === "legacyItem" && key === "type")
  );
}

function isJsonSimpleEscapeByte(byte: number): boolean {
  return (
    byte === 0x22 ||
    byte === 0x5c ||
    byte === 0x2f ||
    byte === 0x62 ||
    byte === 0x66 ||
    byte === 0x6e ||
    byte === 0x72 ||
    byte === 0x74
  );
}

function isJsonHexByte(byte: number): boolean {
  return (
    (byte >= 0x30 && byte <= 0x39) ||
    (byte >= 0x41 && byte <= 0x46) ||
    (byte >= 0x61 && byte <= 0x66)
  );
}

function isJsonPrimitiveStartByte(byte: number): boolean {
  return (
    byte === 0x2d ||
    (byte >= 0x30 && byte <= 0x39) ||
    byte === 0x66 ||
    byte === 0x6e ||
    byte === 0x74
  );
}

function isJsonValueDelimiterByte(byte: number): boolean {
  return isJsonWhitespaceByte(byte) || byte === 0x2c || byte === 0x5d || byte === 0x7d;
}

function isJsonWhitespaceByte(byte: number): boolean {
  return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;
}

type PendingWrite = {
  readonly frame: Buffer;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
};

/** Serializes JSONL writes, bounds retained frames, and honors stream drain. */
export class CodexJsonlWriter {
  private readonly pending: PendingWrite[] = [];
  private queuedBytes = 0;
  private pumping = false;
  private closed = false;
  private activeAbort: AbortController | undefined;

  constructor(
    private readonly writable: Writable,
    readonly maxFrameBytes = CODEX_APP_SERVER_MAX_FRAME_BYTES,
    readonly maxQueuedBytes = CODEX_APP_SERVER_MAX_QUEUED_STDIN_BYTES,
  ) {
    if (
      !Number.isSafeInteger(maxFrameBytes) ||
      maxFrameBytes <= 0 ||
      !Number.isSafeInteger(maxQueuedBytes) ||
      maxQueuedBytes < maxFrameBytes
    ) {
      throw new RangeError("Codex stdin budgets must be positive and queue >= frame");
    }
  }

  write(message: unknown): Promise<void> {
    let encoded: string | undefined;
    try {
      encoded = JSON.stringify(message);
    } catch (cause) {
      return Promise.reject(cause instanceof Error ? cause : new Error(String(cause)));
    }
    if (encoded === undefined) {
      return Promise.reject(new TypeError("Codex app-server message is not JSON serializable"));
    }

    const frame = Buffer.from(`${encoded}\n`);
    if (frame.length > this.maxFrameBytes) {
      return Promise.reject(
        new CodexAppServerTransportError({
          reason: "frame-too-large",
          maxBytes: this.maxFrameBytes,
          observedBytes: frame.length,
        }),
      );
    }
    if (this.closed || !this.writable.writable) {
      return Promise.reject(this.closedError(frame.length));
    }
    if (this.queuedBytes + frame.length > this.maxQueuedBytes) {
      return Promise.reject(
        new CodexAppServerTransportError({
          reason: "write-overloaded",
          maxBytes: this.maxQueuedBytes,
          observedBytes: this.queuedBytes + frame.length,
        }),
      );
    }

    this.queuedBytes += frame.length;
    const result = new Promise<void>((resolve, reject) => {
      this.pending.push({ frame, resolve, reject });
    });
    void this.pump();
    return result;
  }

  get bufferedBytes(): number {
    return this.queuedBytes;
  }

  close(cause?: unknown): void {
    if (this.closed) return;
    this.closed = true;
    const error = cause instanceof Error ? cause : this.closedError(this.queuedBytes, cause);
    this.activeAbort?.abort(error);
    for (const pending of this.pending.splice(0)) pending.reject(error);
    this.queuedBytes = 0;
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (!this.closed) {
        const next = this.pending.shift();
        if (!next) break;
        const activeAbort = new AbortController();
        this.activeAbort = activeAbort;
        try {
          await writeWithDrain(this.writable, next.frame, activeAbort.signal);
          next.resolve();
        } catch (cause) {
          const error = cause instanceof Error ? cause : new Error(String(cause));
          next.reject(error);
          this.close(error);
        } finally {
          if (this.activeAbort === activeAbort) this.activeAbort = undefined;
          this.queuedBytes = Math.max(0, this.queuedBytes - next.frame.length);
        }
      }
    } finally {
      this.pumping = false;
      if (!this.closed && this.pending.length > 0) void this.pump();
    }
  }

  private closedError(observedBytes: number, cause?: unknown): CodexAppServerTransportError {
    return new CodexAppServerTransportError({
      reason: "write-closed",
      maxBytes: this.maxQueuedBytes,
      observedBytes,
      ...(cause !== undefined ? { cause } : {}),
    });
  }
}

function writeWithDrain(writable: Writable, frame: Buffer, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let callbackComplete = false;
    let drainComplete = true;
    let writeReturned = false;
    let settled = false;

    const cleanup = () => {
      writable.off("error", onError);
      writable.off("close", onClose);
      writable.off("drain", onDrain);
      signal.removeEventListener("abort", onAbort);
    };
    const settle = () => {
      if (settled || !writeReturned || !callbackComplete || !drainComplete) return;
      settled = true;
      cleanup();
      resolve();
    };
    const fail = (cause: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(cause instanceof Error ? cause : new Error(String(cause)));
    };
    const onError = (error: Error) => fail(error);
    const onClose = () => fail(new Error("Codex app-server stdin closed during write"));
    const onAbort = () => fail(signal.reason ?? new Error("Codex app-server stdin write aborted"));
    const onDrain = () => {
      drainComplete = true;
      settle();
    };

    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    writable.once("error", onError);
    writable.once("close", onClose);
    let accepted: boolean;
    try {
      accepted = writable.write(frame, (error?: Error | null) => {
        if (error) {
          fail(error);
          return;
        }
        callbackComplete = true;
        settle();
      });
    } catch (cause) {
      fail(cause);
      return;
    }
    drainComplete = accepted;
    writeReturned = true;
    if (!accepted && !settled) {
      writable.once("drain", onDrain);
    }
    settle();
  });
}

function transportErrorMessage(input: {
  readonly reason: CodexAppServerTransportErrorReason;
  readonly maxBytes: number;
  readonly observedBytes: number;
}): string {
  switch (input.reason) {
    case "invalid-utf8":
      return `Codex app-server emitted invalid UTF-8 (${input.observedBytes} bytes).`;
    case "read-closed":
      return "Codex app-server stdout closed before process shutdown.";
    case "unterminated-frame":
      return `Codex app-server stdout ended with an unterminated JSONL frame (${input.observedBytes}/${input.maxBytes} bytes).`;
    case "frame-too-large":
      return `Codex app-server JSONL frame exceeded its byte limit (${input.observedBytes}/${input.maxBytes}).`;
    case "write-overloaded":
      return `Codex app-server stdin queue exceeded its byte limit (${input.observedBytes}/${input.maxBytes}).`;
    case "write-closed":
      return "Codex app-server stdin closed before the frame was written.";
  }
}
