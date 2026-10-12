import { expect, it, vi } from "vitest";
import { enqueueTerminalResize, type TerminalResizeState } from "./terminalResizeQueue";

function state(): TerminalResizeState {
  return { resizeInFlight: false, lastSentResize: null, pendingResize: null, disposed: false };
}

it("sends immediately, coalesces pending sizes behind the RPC and releases them on completion", async () => {
  const current = state();
  let finish!: () => void;
  let secondStarted!: () => void;
  const second = new Promise<void>((resolve) => {
    secondStarted = resolve;
  });
  const send = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    )
    .mockImplementationOnce(() => {
      secondStarted();
      return Promise.resolve();
    });
  const resolve = () => send;
  enqueueTerminalResize(current, { cols: 80, rows: 24 }, resolve);
  expect(send).toHaveBeenCalledTimes(1);
  enqueueTerminalResize(current, { cols: 100, rows: 30 }, resolve);
  enqueueTerminalResize(current, { cols: 120, rows: 40 }, resolve);
  expect(send).toHaveBeenCalledTimes(1);
  finish();
  await second;
  expect(send).toHaveBeenNthCalledWith(2, { cols: 120, rows: 40 });
});

it("does not automatically retry a failure and drops pending dimensions on disposal", async () => {
  const current = state();
  let fail!: (error: Error) => void;
  let settled!: () => void;
  const done = new Promise<void>((resolve) => {
    settled = resolve;
  });
  const send = vi.fn(
    () =>
      new Promise<void>((_resolve, reject) => {
        fail = reject;
      }),
  );
  let resolutions = 0;
  const resolve = () => {
    resolutions++;
    return send;
  };
  enqueueTerminalResize(current, { cols: 80, rows: 24 }, resolve);
  fail(new Error("resize failed"));
  await send.mock.results[0]!.value.catch(settled);
  await done;
  expect(current.lastSentResize).toBeNull();
  expect(send).toHaveBeenCalledTimes(1);
  current.disposed = true;
  enqueueTerminalResize(current, { cols: 120, rows: 40 }, resolve);
  expect(send).toHaveBeenCalledTimes(1);
  expect(resolutions).toBe(1);
});

it("keeps A when dimensions change A to B to A during A's request without sending A twice", async () => {
  const current = state();
  let finish!: () => void;
  const request = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const send = vi.fn(() => request);
  const resolve = () => send;
  const a = { cols: 80, rows: 24 };
  enqueueTerminalResize(current, a, resolve);
  enqueueTerminalResize(current, { cols: 100, rows: 30 }, resolve);
  enqueueTerminalResize(current, a, resolve);
  finish();
  await request.catch(() => {});
  expect(current.pendingResize).toBeNull();
  expect(current.lastSentResize).toEqual(a);
  expect(current.resizeInFlight).toBe(false);
  expect(send).toHaveBeenCalledTimes(1);
});
