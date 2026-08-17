import { describe, expect, it, vi } from "vitest";

import { DEFERRED_CHAT_MOUNT_FALLBACK_MS, scheduleDeferredChatMount } from "./deferredChatMount";

describe("scheduleDeferredChatMount", () => {
  it("mounts after two animation frames when frames are available", () => {
    const frames: FrameRequestCallback[] = [];
    const onReady = vi.fn();
    const cleanup = scheduleDeferredChatMount({
      requestFrame: (callback) => {
        frames.push(callback);
        return frames.length;
      },
      cancelFrame: vi.fn(),
      setTimer: vi.fn(() => 1),
      clearTimer: vi.fn(),
      onReady,
    });

    frames[0]?.(0);
    expect(onReady).not.toHaveBeenCalled();
    frames[1]?.(16);
    expect(onReady).toHaveBeenCalledOnce();
    cleanup();
  });

  it("uses a timer when a hidden renderer pauses animation frames", () => {
    let fallback: (() => void) | undefined;
    const onReady = vi.fn();
    scheduleDeferredChatMount({
      requestFrame: vi.fn(() => 1),
      cancelFrame: vi.fn(),
      setTimer: (callback, delayMs) => {
        expect(delayMs).toBe(DEFERRED_CHAT_MOUNT_FALLBACK_MS);
        fallback = callback;
        return 2;
      },
      clearTimer: vi.fn(),
      onReady,
    });

    fallback?.();
    expect(onReady).toHaveBeenCalledOnce();
  });

  it("does not mount after cleanup", () => {
    let fallback: (() => void) | undefined;
    const onReady = vi.fn();
    const cleanup = scheduleDeferredChatMount({
      requestFrame: vi.fn(() => 1),
      cancelFrame: vi.fn(),
      setTimer: (callback) => {
        fallback = callback;
        return 2;
      },
      clearTimer: vi.fn(),
      onReady,
    });

    cleanup();
    fallback?.();
    expect(onReady).not.toHaveBeenCalled();
  });
});
