import { describe, expect, it } from "vitest";
import { WS_BOOTSTRAP_METHOD } from "@penkra/contracts";
import {
  readEffectRpcClientMessage,
  sendEffectRpcChunk,
  sendEffectRpcExit,
} from "./effectRpcWebSocketMock";

describe("Effect RPC browser fixture", () => {
  it.each([0, "0"])("replies to negotiation with request ID %s unchanged", (id) => {
    const frames: unknown[] = [];
    const client = { send: (frame: string) => frames.push(JSON.parse(frame)) };
    expect(
      readEffectRpcClientMessage(
        client,
        JSON.stringify({ _tag: "Request", id, tag: WS_BOOTSTRAP_METHOD }),
      ),
    ).toEqual({ kind: "handled" });
    expect(frames).toMatchObject([{ _tag: "Exit", requestId: id, exit: { _tag: "Success" } }]);
  });

  it("preserves numeric IDs for feature requests and replies", () => {
    const frames: unknown[] = [];
    const client = { send: (frame: string) => frames.push(JSON.parse(frame)) };
    expect(
      readEffectRpcClientMessage(
        client,
        JSON.stringify({ _tag: "Request", id: 12, tag: "example", payload: { value: 1 } }),
      ),
    ).toEqual({ kind: "request", request: { id: 12, tag: "example", payload: { value: 1 } } });
    sendEffectRpcExit(client, 12, null);
    sendEffectRpcChunk(client, 12, "value");
    expect(frames).toMatchObject([
      { _tag: "Exit", requestId: 12 },
      { _tag: "Chunk", requestId: 12 },
    ]);
  });
});
