import { EventEmitter } from "node:events";
import type { Writable } from "node:stream";

import { describe, expect, it } from "vitest";

import {
  CodexAppServerTransportError,
  CodexJsonlFramer,
  CodexJsonlWriter,
} from "./codexAppServerTransport.ts";

describe("Codex app-server transport", () => {
  it("frames split UTF-8 and rejects invalid, oversize, or unterminated input", () => {
    const framer = new CodexJsonlFramer(64);
    const encoded = Buffer.from('{"text":"A😀B"}\r\n{"id":2}\n', "utf8");
    const emojiStart = encoded.indexOf(Buffer.from("😀", "utf8"));

    expect(framer.push(encoded.subarray(0, emojiStart + 2))).toEqual([]);
    expect(framer.push(encoded.subarray(emojiStart + 2))).toEqual(['{"text":"A😀B"}', '{"id":2}']);
    framer.finish();
    expect(framer.bufferedBytes).toBe(0);

    expect(() => new CodexJsonlFramer(8).push(Buffer.from("123456789"))).toThrowError(
      expect.objectContaining({ reason: "frame-too-large" }),
    );

    const unterminated = new CodexJsonlFramer(64);
    unterminated.push(Buffer.from('{"id":1}'));
    expect(() => unterminated.finish()).toThrowError(
      expect.objectContaining({ reason: "unterminated-frame" }),
    );

    expect(() => new CodexJsonlFramer(64).push(Buffer.from([0xff, 0x0a]))).toThrowError(
      expect.objectContaining({ reason: "invalid-utf8" }),
    );
  });

  it("compacts an oversized file-change notification instead of breaking the stream", () => {
    const maxFrameBytes = 1_024;
    const framer = new CodexJsonlFramer(maxFrameBytes);
    const notification = `${JSON.stringify({
      method: "item/completed",
      params: {
        threadId: "provider-thread",
        turnId: "provider-turn",
        item: {
          type: "fileChange",
          id: "patch-1",
          changes: [
            {
              path: "generated.js",
              kind: "delete",
              diff: "x".repeat(maxFrameBytes * 2),
            },
          ],
          status: "completed",
        },
        completedAtMs: 123,
      },
    })}\n${JSON.stringify({ id: 7, result: {} })}\n`;

    const frames = [
      ...framer.push(Buffer.from(notification.slice(0, 1_400))),
      ...framer.push(Buffer.from(notification.slice(1_400))),
    ];

    expect(frames).toEqual([
      {
        kind: "oversized-notification",
        method: "item/completed",
        itemType: "fileChange",
        threadId: "provider-thread",
        turnId: "provider-turn",
        itemId: "patch-1",
        maxBytes: maxFrameBytes,
        observedBytes: Buffer.byteLength(notification.split("\n", 1)[0] ?? ""),
      },
      JSON.stringify({ id: 7, result: {} }),
    ]);
    framer.finish();
  });

  it("reproduces the Production deleted-file frame above the 16 MiB boundary", () => {
    const deletedFileBytes = 17_798_953;
    const framer = new CodexJsonlFramer();
    const frame = JSON.stringify({
      method: "item/completed",
      params: {
        item: {
          type: "fileChange",
          id: "patch-production",
          changes: [
            {
              path: "startup-render.js",
              kind: "delete",
              diff: "x".repeat(deletedFileBytes),
            },
          ],
          status: "completed",
        },
        threadId: "provider-thread",
        turnId: "provider-turn",
        completedAtMs: 123,
      },
    });
    const detectionPoint = 16_842_752;

    expect(framer.push(Buffer.from(frame.slice(0, detectionPoint)))).toEqual([]);
    expect(framer.push(Buffer.from(`${frame.slice(detectionPoint)}\n`))).toEqual([
      {
        kind: "oversized-notification",
        method: "item/completed",
        itemType: "fileChange",
        itemId: "patch-production",
        threadId: "provider-thread",
        turnId: "provider-turn",
        maxBytes: 16_777_216,
        observedBytes: Buffer.byteLength(frame),
      },
    ]);
    framer.finish();
  });

  it("classifies a file-change notification whose method follows the oversized payload", () => {
    const maxFrameBytes = 1_024;
    const framer = new CodexJsonlFramer(maxFrameBytes);
    const frame = JSON.stringify({
      params: {
        item: {
          type: "fileChange",
          id: "patch-method-after-payload",
          changes: [{ path: "generated.js", kind: "delete", diff: "x".repeat(2_048) }],
          status: "completed",
        },
        threadId: "provider-thread",
        turnId: "provider-turn",
      },
      method: "item/completed",
    });

    expect(framer.push(`${frame}\n`)).toEqual([
      {
        kind: "oversized-notification",
        method: "item/completed",
        itemType: "fileChange",
        itemId: "patch-method-after-payload",
        threadId: "provider-thread",
        turnId: "provider-turn",
        maxBytes: maxFrameBytes,
        observedBytes: Buffer.byteLength(frame),
      },
    ]);
    framer.finish();
  });

  it("compacts the legacy raw FileChange completion emitted before the modern notification", () => {
    const maxFrameBytes = 1_024;
    const framer = new CodexJsonlFramer(maxFrameBytes);
    const frame = JSON.stringify({
      method: "codex/event/item_completed",
      params: {
        id: "provider-turn",
        msg: {
          type: "item_completed",
          thread_id: "provider-thread",
          turn_id: "provider-turn",
          item: {
            type: "FileChange",
            id: "patch-legacy",
            changes: {
              "generated.js": { type: "delete", content: "x".repeat(2_048) },
            },
          },
        },
      },
    });

    expect(framer.push(`${frame}\n`)).toEqual([
      {
        kind: "oversized-notification",
        method: "codex/event/item_completed",
        itemType: "fileChange",
        threadId: "provider-thread",
        turnId: "provider-turn",
        maxBytes: maxFrameBytes,
        observedBytes: Buffer.byteLength(frame),
      },
    ]);
    framer.finish();
  });

  it("structurally consumes uncaptured long keys inside an oversized legacy file change", () => {
    const maxFrameBytes = 1_024;
    const framer = new CodexJsonlFramer(maxFrameBytes);
    const frame = JSON.stringify({
      method: "codex/event/item_completed",
      params: {
        msg: {
          type: "item_completed",
          thread_id: "provider-thread",
          turn_id: "provider-turn",
          item: {
            type: "FileChange",
            changes: {
              ["nested/".repeat(100)]: { type: "delete", content: "x".repeat(2_048) },
            },
          },
        },
      },
    });

    expect(framer.push(`${frame}\n`)).toEqual([
      expect.objectContaining({
        kind: "oversized-notification",
        method: "codex/event/item_completed",
        itemType: "fileChange",
        threadId: "provider-thread",
        turnId: "provider-turn",
      }),
    ]);
    framer.finish();
  });

  it("compacts the oversized file-change start emitted by Codex 0.154", () => {
    const maxFrameBytes = 1_024;
    const framer = new CodexJsonlFramer(maxFrameBytes);
    const frame = JSON.stringify({
      method: "item/started",
      params: {
        threadId: "provider-thread",
        turnId: "provider-turn",
        item: {
          type: "fileChange",
          id: "patch-start",
          changes: [{ path: "generated.js", kind: "delete", diff: "x".repeat(2_048) }],
          status: "inProgress",
        },
      },
    });

    expect(framer.push(`${frame}\n`)).toEqual([
      {
        kind: "oversized-notification",
        method: "item/started",
        itemType: "fileChange",
        threadId: "provider-thread",
        turnId: "provider-turn",
        itemId: "patch-start",
        maxBytes: maxFrameBytes,
        observedBytes: Buffer.byteLength(frame),
      },
    ]);
    framer.finish();
  });

  it.each(["item/fileChange/patchUpdated", "turn/diff/updated"] as const)(
    "compacts oversized %s snapshots and continues framing",
    (method) => {
      const framer = new CodexJsonlFramer(128);
      const oversized = JSON.stringify({ method, params: { diff: "x".repeat(512) } });
      const response = JSON.stringify({ id: 9, result: {} });

      expect(framer.push(`${oversized}\n${response}\n`)).toEqual([
        {
          kind: "oversized-notification",
          method,
          maxBytes: 128,
          observedBytes: Buffer.byteLength(oversized),
        },
        response,
      ]);
      framer.finish();
    },
  );

  it("waits for a trailing top-level snapshot method across stdout chunks", () => {
    const framer = new CodexJsonlFramer(256, 2_048);
    const frame = JSON.stringify({
      params: { diff: "x".repeat(768) },
      method: "turn/diff/updated",
    });
    const methodStart = frame.indexOf('"method"');

    expect(framer.push(frame.slice(0, methodStart))).toEqual([]);
    expect(framer.push(`${frame.slice(methodStart)}\n`)).toEqual([
      {
        kind: "oversized-notification",
        method: "turn/diff/updated",
        maxBytes: 256,
        observedBytes: Buffer.byteLength(frame),
      },
    ]);
    framer.finish();
  });

  it("keeps the hard limit for other oversized protocol frames", () => {
    const framer = new CodexJsonlFramer(256);
    const frame = JSON.stringify({
      method: "item/completed",
      params: { item: { type: "mcpToolCall", result: "x".repeat(512) } },
    });

    expect(() => framer.push(`${frame}\n`)).toThrowError(
      expect.objectContaining({
        reason: "frame-too-large",
        protocolMethod: "item/completed",
        protocolTypes: ["mcpToolCall"],
      }),
    );
  });

  it("does not classify a nested fileChange value as the protocol item type", () => {
    const framer = new CodexJsonlFramer(256);
    const frame = JSON.stringify({
      method: "item/completed",
      params: {
        item: {
          type: "mcpToolCall",
          result: {
            content: [
              {
                type: "bearer-secret-value-that-must-not-leak",
                text: "x".repeat(512),
              },
            ],
          },
        },
      },
    });

    expect(() => framer.push(`${frame}\n`)).toThrowError(
      expect.objectContaining({
        reason: "frame-too-large",
        protocolMethod: "item/completed",
        protocolTypes: ["mcpToolCall"],
      }),
    );
  });

  it("stops discarding a recognized notification at the absolute wire-frame limit", () => {
    const framer = new CodexJsonlFramer(256, 512);
    const prefix = `{"method":"item/started","params":{"item":{"type":"fileChange","diff":"${"x".repeat(300)}`;

    expect(framer.push(prefix)).toEqual([]);
    expect(() => framer.push("x".repeat(256))).toThrowError(
      expect.objectContaining({
        reason: "frame-too-large",
        maxBytes: 512,
      }),
    );
  });

  it("enforces the absolute wire-frame limit on the threshold-crossing chunk", () => {
    const framer = new CodexJsonlFramer(256, 512);
    const frame = JSON.stringify({
      method: "item/started",
      params: {
        item: { type: "fileChange", diff: "x".repeat(768) },
      },
    });

    expect(() => framer.push(`${frame}\n`)).toThrowError(
      expect.objectContaining({
        reason: "frame-too-large",
        maxBytes: 512,
      }),
    );
  });

  it("does not treat a response's nested method as a top-level notification method", () => {
    const framer = new CodexJsonlFramer(256, 2_048);
    const frame = JSON.stringify({
      id: 7,
      result: {
        diff: "x".repeat(768),
        method: "turn/diff/updated",
      },
    });

    expect(() => framer.push(`${frame}\n`)).toThrowError(
      expect.objectContaining({ reason: "frame-too-large" }),
    );
  });

  it("does not retain a large unrelated top-level string in scanner memory", () => {
    const framer = new CodexJsonlFramer(256, 2_048);

    expect(framer.push(`{"result":"${"x".repeat(1_024)}`)).toEqual([]);
    const scanner = (
      framer as unknown as {
        oversizedEnvelope?: { stringBytes?: ReadonlyArray<number> };
      }
    ).oversizedEnvelope;
    expect(scanner?.stringBytes).toBeUndefined();
  });

  it("rejects an identified response at the normal frame limit", () => {
    const framer = new CodexJsonlFramer(256, 2_048);
    const partialResponse = `{"id":7,"result":"${"x".repeat(512)}`;

    expect(() => framer.push(partialResponse)).toThrowError(
      expect.objectContaining({
        reason: "frame-too-large",
        maxBytes: 256,
      }),
    );
  });

  it("rejects a known unsupported notification at the normal frame limit", () => {
    const framer = new CodexJsonlFramer(256, 2_048);
    const partialNotification = `{"method":"item/completed","params":{"item":{"type":"mcpToolCall","result":"${"x".repeat(512)}`;

    expect(() => framer.push(partialNotification)).toThrowError(
      expect.objectContaining({
        reason: "frame-too-large",
        maxBytes: 256,
        protocolMethod: "item/completed",
        protocolTypes: ["mcpToolCall"],
      }),
    );
  });

  it("rejects invalid UTF-8 inside an otherwise compactable oversized notification", () => {
    const framer = new CodexJsonlFramer(256, 2_048);
    const prefix = Buffer.from(
      `{"method":"turn/diff/updated","params":{"diff":"${"x".repeat(300)}`,
    );
    const suffix = Buffer.from(`"}}\n`);

    expect(() => framer.push(Buffer.concat([prefix, Buffer.from([0xff]), suffix]))).toThrowError(
      expect.objectContaining({ reason: "invalid-utf8" }),
    );
  });

  it("classifies oversized notifications with legal JSON whitespace", () => {
    const framer = new CodexJsonlFramer(256, 2_048);
    const frame = `  { "method" : "item/completed", "params" : { "item" : { "type" : "fileChange", "id" : "patch-spaced", "changes" : [{"diff":"${"x".repeat(512)}"}], "status" : "failed" }, "threadId" : "thread-spaced", "turnId" : "turn-spaced" } }`;

    expect(framer.push(`${frame}\n`)).toEqual([
      expect.objectContaining({
        kind: "oversized-notification",
        method: "item/completed",
        itemType: "fileChange",
        itemId: "patch-spaced",
        threadId: "thread-spaced",
        turnId: "turn-spaced",
        status: "failed",
      }),
    ]);
  });

  it("preserves a failed status serialized after the discarded file diff", () => {
    const framer = new CodexJsonlFramer(1_024);
    const frame = JSON.stringify({
      method: "item/completed",
      params: {
        item: {
          type: "fileChange",
          id: "patch-trailing-status",
          changes: [{ diff: "x".repeat(70_000) }],
          status: "failed",
        },
        threadId: "thread-trailing-status",
        turnId: "turn-trailing-status",
      },
    });

    expect(framer.push(`${frame}\n`)).toEqual([
      expect.objectContaining({
        method: "item/completed",
        status: "failed",
      }),
    ]);
  });

  it("rejects a newline-terminated oversized notification with an unclosed envelope", () => {
    const framer = new CodexJsonlFramer(256, 2_048);
    const truncated = `{"method":"item/completed","params":{"item":{"type":"fileChange","changes":[{"diff":"${"x".repeat(512)}"}]`;

    expect(() => framer.push(`${truncated}\n`)).toThrowError(
      expect.objectContaining({ reason: "frame-too-large" }),
    );
  });

  it("does not expose unrecognized structural protocol labels in diagnostics", () => {
    const framer = new CodexJsonlFramer(256, 2_048);
    const frame = JSON.stringify({
      method: "bearer-secret-value-that-must-not-leak",
      params: {
        item: {
          type: "another-secret-value-that-must-not-leak",
          result: "x".repeat(512),
        },
      },
    });

    expect(() => framer.push(`${frame}\n`)).toThrowError(
      expect.objectContaining({
        reason: "frame-too-large",
        protocolMethod: undefined,
        protocolTypes: [],
      }),
    );
  });

  it("classifies a file-change item whose type follows the discarded diff", () => {
    const framer = new CodexJsonlFramer(1_024);
    const frame = JSON.stringify({
      method: "item/completed",
      params: {
        item: {
          changes: [{ diff: "x".repeat(70_000) }],
          status: "failed",
          id: "patch-type-after-diff",
          type: "fileChange",
        },
        threadId: "thread-type-after-diff",
        turnId: "turn-type-after-diff",
      },
    });

    expect(framer.push(`${frame}\n`)).toEqual([
      expect.objectContaining({
        method: "item/completed",
        itemType: "fileChange",
        itemId: "patch-type-after-diff",
        status: "failed",
      }),
    ]);
  });

  it("rejects excessive JSON nesting at the normal frame limit", () => {
    const framer = new CodexJsonlFramer(256, 2_048);
    const partialFrame = `{"payload":${"[".repeat(300)}${"0,".repeat(200)}`;

    expect(() => framer.push(partialFrame)).toThrowError(
      expect.objectContaining({
        reason: "frame-too-large",
        maxBytes: 256,
      }),
    );
  });

  it("rejects a balanced oversized envelope with invalid JSON grammar", () => {
    const framer = new CodexJsonlFramer(256, 2_048);
    const malformed = `{"method":"item/completed","params":{"item":{"type":"fileChange","changes":[{"diff":"${"x".repeat(512)}"}]}},garbage}`;

    expect(() => framer.push(`${malformed}\n`)).toThrowError(
      expect.objectContaining({ reason: "frame-too-large" }),
    );
  });

  it("serializes slow stdin writes within one retained-byte budget", async () => {
    class ControlledWritable extends EventEmitter {
      writable = true;
      autoComplete = false;
      readonly chunks: Array<Buffer> = [];
      readonly callbacks: Array<(error?: Error | null) => void> = [];

      write(chunk: Uint8Array, callback: (error?: Error | null) => void): boolean {
        this.chunks.push(Buffer.from(chunk));
        if (this.autoComplete) {
          queueMicrotask(() => callback());
          return true;
        }
        this.callbacks.push(callback);
        return false;
      }

      release(): void {
        this.autoComplete = true;
        for (const callback of this.callbacks.splice(0)) callback();
        this.emit("drain");
      }
    }

    const stream = new ControlledWritable();
    const writer = new CodexJsonlWriter(stream as unknown as Writable, 64, 120);
    const messages = [1, 2, 3].map((id) => ({ id, payload: "x".repeat(16) }));
    const writes = messages.map((message) => writer.write(message));

    expect(stream.chunks).toHaveLength(1);
    expect(writer.bufferedBytes).toBeLessThanOrEqual(120);
    await expect(writer.write({ id: 4, payload: "x".repeat(16) })).rejects.toMatchObject({
      reason: "write-overloaded",
    });
    expect(writer.bufferedBytes).toBeLessThanOrEqual(120);

    stream.release();
    await Promise.all(writes);
    expect(writer.bufferedBytes).toBe(0);
    expect(stream.chunks.map((chunk) => JSON.parse(chunk.toString("utf8")))).toEqual(messages);

    const blockedStream = new ControlledWritable();
    const blockedWriter = new CodexJsonlWriter(blockedStream as unknown as Writable, 64, 120);
    const blockedWrite = blockedWriter.write({ id: "blocked" });
    blockedWriter.close(new Error("session stopped"));
    await expect(blockedWrite).rejects.toThrow("session stopped");
    expect(blockedWriter.bufferedBytes).toBe(0);
  });

  it("reports typed output frame errors", async () => {
    const stream = new EventEmitter() as EventEmitter & {
      writable: boolean;
      write: Writable["write"];
    };
    stream.writable = true;
    stream.write = (() => true) as Writable["write"];
    const writer = new CodexJsonlWriter(stream as unknown as Writable, 16, 32);

    await expect(writer.write({ payload: "x".repeat(32) })).rejects.toBeInstanceOf(
      CodexAppServerTransportError,
    );
  });
});
