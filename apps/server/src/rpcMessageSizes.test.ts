import { describe, expect, it } from "vitest";
import {
  makeObservedRpcSerialization,
  RPC_MESSAGE_OBSERVATION_BYTES,
  type RpcMessageSizeEvent,
} from "./rpcMessageSizes";

function request(id: string, tag: string) {
  return JSON.stringify({ _tag: "Request", id, tag, payload: {}, headers: [] });
}

describe("outgoing RPC size observation", () => {
  it("measures exact UTF-8 wire bytes, attributes chunks and exit, and shares maxima across connections", () => {
    const reports: RpcMessageSizeEvent[] = [];
    const serialization = makeObservedRpcSerialization({
      methods: new Set(["read"]),
      report: (event) => reports.push(event),
    });
    const first = serialization.makeUnsafe(),
      second = serialization.makeUnsafe();
    first.decode(request("1", "read"));
    const response = { _tag: "Chunk", requestId: "1", values: ["é😀"] };
    const encoded = first.encode(response);
    expect(encoded).toBe(JSON.stringify(response));
    expect(reports).toEqual([
      {
        method: "read",
        bytes: Buffer.byteLength(JSON.stringify(response)),
        aboveObservationThreshold: false,
      },
    ]);
    second.decode(request("1", "read"));
    second.encode(response);
    expect(reports).toHaveLength(1);
    first.encode({
      _tag: "Exit",
      requestId: "1",
      exit: { _tag: "Success", value: "x".repeat(200) },
    });
    expect(reports.at(-1)?.method).toBe("read");
    first.encode({ ...response, values: ["x".repeat(500)] });
    expect(reports.at(-1)?.method).toBe("<unknown>");
  });

  it("does not truncate or reject messages above the approved observation threshold", () => {
    const reports: RpcMessageSizeEvent[] = [];
    const parser = makeObservedRpcSerialization({
      methods: new Set(["large"]),
      report: (event) => reports.push(event),
    }).makeUnsafe();
    parser.decode(request("1", "large"));
    const response = {
      _tag: "Chunk",
      requestId: "1",
      values: ["x".repeat(RPC_MESSAGE_OBSERVATION_BYTES)],
    };
    expect(parser.encode(response)).toBe(JSON.stringify(response));
    parser.encode(response);
    expect(reports).toHaveLength(2);
    expect(
      reports.every((event) => event.aboveObservationThreshold && event.method === "large"),
    ).toBe(true);
  });

  it("does not log arbitrary method names or payloads and ignores observer failures", () => {
    const reports: RpcMessageSizeEvent[] = [];
    const parser = makeObservedRpcSerialization({
      methods: new Set(["read"]),
      report: (event) => {
        reports.push(event);
        throw new Error("observer");
      },
    }).makeUnsafe();
    parser.decode(request("secret-id", "secret-method"));
    const response = { _tag: "Exit", requestId: "secret-id", exit: { value: "secret-body" } };
    expect(parser.encode(response)).toBe(JSON.stringify(response));
    expect(JSON.stringify(reports)).not.toContain("secret");
    expect(reports[0]?.method).toBe("<unknown>");
  });
});
