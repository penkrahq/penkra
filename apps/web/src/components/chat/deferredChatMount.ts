// FILE: deferredChatMount.ts
// Purpose: Schedules draft chat mounting without stalling when animation frames are paused.

export const DEFERRED_CHAT_MOUNT_FALLBACK_MS = 250;

export interface DeferredChatMountScheduler {
  readonly requestFrame: (callback: FrameRequestCallback) => number;
  readonly cancelFrame: (handle: number) => void;
  readonly setTimer: (callback: () => void, delayMs: number) => number;
  readonly clearTimer: (handle: number) => void;
  readonly onReady: () => void;
}

export function scheduleDeferredChatMount(input: DeferredChatMountScheduler): () => void {
  let active = true;
  let firstFrame = 0;
  let secondFrame = 0;
  const finish = () => {
    if (!active) return;
    active = false;
    input.onReady();
  };
  const fallbackTimer = input.setTimer(finish, DEFERRED_CHAT_MOUNT_FALLBACK_MS);

  firstFrame = input.requestFrame(() => {
    secondFrame = input.requestFrame(finish);
  });

  return () => {
    active = false;
    input.cancelFrame(firstFrame);
    input.cancelFrame(secondFrame);
    input.clearTimer(fallbackTimer);
  };
}
