import { describe, expect, it, vi } from "vitest";

import { MjpegFrameParser, subscribeMjpegFrames } from "./simulatorMjpegStream";

describe("MJPEG simulator transport", () => {
  it("extracts complete JPEGs across arbitrary multipart chunk boundaries", () => {
    const frames: Uint8Array[] = [];
    const parser = new MjpegFrameParser((frame) => frames.push(frame));
    parser.push(new Uint8Array([1, 2, 0xff]));
    parser.push(new Uint8Array([0xd8, 10, 11, 0xff, 0xd9, 13, 0xff, 0xd8, 20]));
    parser.push(new Uint8Array([21, 0xff, 0xd9, 99]));
    expect(frames).toEqual([
      new Uint8Array([0xff, 0xd8, 10, 11, 0xff, 0xd9]),
      new Uint8Array([0xff, 0xd8, 20, 21, 0xff, 0xd9]),
    ]);
  });

  it("aborts the loopback fetch when the viewer stops", async () => {
    const captured: { signal: AbortSignal | null } = { signal: null };
    const request = vi.fn(async (_url: string, init?: RequestInit) => {
      captured.signal = init?.signal as AbortSignal;
      return new Promise<Response>((_resolve, reject) => {
        captured.signal?.addEventListener("abort", () => reject(captured.signal?.reason));
      });
    }) as unknown as typeof fetch;
    const onError = vi.fn();
    const subscription = subscribeMjpegFrames({
      url: "http://127.0.0.1:9100",
      onFrame: vi.fn(),
      onError,
      fetch: request,
    });
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    subscription.stop();
    expect(captured.signal?.aborted).toBe(true);
    await Promise.resolve();
    expect(onError).not.toHaveBeenCalled();
  });
});
