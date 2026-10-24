import { Effect, Layer } from "effect";
import { RpcSerialization } from "effect/rpc";

// Temporary observation threshold approved in TODO §7.5.9, not an enforced cap.
export const RPC_MESSAGE_OBSERVATION_BYTES = 16 * 1024 * 1024;
export interface RpcMessageSizeEvent {
  readonly method: string;
  readonly bytes: number;
  readonly aboveObservationThreshold: boolean;
}

// RpcMessage.RequestEncoded and reply frames use this exact wire union.
function isRequestId(value: unknown): value is string | number {
  return typeof value === "string" || typeof value === "number";
}

/** One tracker per server layer; high-water marks span connections. No payloads,
 * request IDs, credentials or arbitrary method names are retained in the log.
 */
export function makeObservedRpcSerialization(input: {
  methods: ReadonlySet<string>;
  report: (event: RpcMessageSizeEvent) => void;
}): typeof RpcSerialization.json {
  const largest = new Map<string, number>();
  return {
    ...RpcSerialization.json,
    makeUnsafe: () => {
      const parser = RpcSerialization.json.makeUnsafe();
      const requests = new Map<string | number, string>();
      return {
        decode: (data) => {
          const decoded = parser.decode(data);
          for (const value of decoded) {
            if (typeof value !== "object" || value === null) continue;
            const message = value as Record<string, unknown>;
            if (
              message._tag === "Request" &&
              isRequestId(message.id) &&
              typeof message.tag === "string"
            )
              requests.set(message.id, input.methods.has(message.tag) ? message.tag : "<unknown>");
          }
          return decoded;
        },
        encode: (value) => {
          const encoded = parser.encode(value);
          if (encoded === undefined) return encoded;
          const message =
            typeof value === "object" && value !== null
              ? (value as Record<string, unknown>)
              : undefined;
          const requestId = isRequestId(message?.requestId) ? message.requestId : undefined;
          const method =
            requestId === undefined ? "<control>" : (requests.get(requestId) ?? "<unknown>");
          const bytes =
            typeof encoded === "string" ? Buffer.byteLength(encoded, "utf8") : encoded.byteLength;
          const highWater = bytes > (largest.get(method) ?? 0);
          if (highWater) largest.set(method, bytes);
          if (highWater || bytes > RPC_MESSAGE_OBSERVATION_BYTES) {
            try {
              input.report({
                method,
                bytes,
                aboveObservationThreshold: bytes > RPC_MESSAGE_OBSERVATION_BYTES,
              });
            } catch {
              /* Observation must never change a reply or fail its socket. */
            }
          }
          if (message?._tag === "Exit" && requestId !== undefined) requests.delete(requestId);
          return encoded;
        },
      };
    },
  };
}

export function observedRpcJsonLayer(methods: ReadonlySet<string>) {
  return Layer.succeed(
    RpcSerialization.RpcSerialization,
    makeObservedRpcSerialization({
      methods,
      report: (event) => {
        Effect.runFork(
          Effect.logInfo("RPC outgoing message high-water").pipe(
            Effect.annotateLogs({
              method: event.method,
              bytes: event.bytes,
              aboveObservationThreshold: event.aboveObservationThreshold,
            }),
          ),
        );
      },
    }),
  );
}
