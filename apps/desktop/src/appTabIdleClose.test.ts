import { expect, it, vi } from "vitest";
import { AppTabIdleClose } from "./appTabIdleClose";

it("selection cancels an idle close waiting to authorize its write", async () => {
  const closes = new AppTabIdleClose();
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const commit = vi.fn();
  const result = closes.close("tab", async (authorize) => {
    await waiting;
    if (!authorize()) return false;
    commit();
    return true;
  });
  await closes.select("tab");
  release();
  expect(await result).toBe(false);
  expect(commit).not.toHaveBeenCalled();
});

it("selection waits for a write already authorized, without blocking other tabs", async () => {
  const closes = new AppTabIdleClose();
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const result = closes.close("tab", async (authorize) => {
    expect(authorize()).toBe(true);
    entered();
    await waiting;
    return true;
  });
  await started;
  const selected = vi.fn();
  const selection = Promise.resolve(closes.select("tab")).then(selected);
  await closes.select("other");
  expect(selected).not.toHaveBeenCalled();
  release();
  await Promise.all([result, selection]);
  expect(selected).toHaveBeenCalledOnce();
  await expect(closes.close("tab", async (authorize) => authorize())).resolves.toBe(true);
});
