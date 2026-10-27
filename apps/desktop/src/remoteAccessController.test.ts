import { expect, it, vi } from "vitest";
import { RemoteAccessController } from "./remoteAccessController";
import { deferred } from "./deferred.test-support";

it("registers before enabling and does not register when disabling", async () => {
  const order: string[] = [];
  const controller = new RemoteAccessController({
    account: async () => "a",
    signal: new AbortController().signal,
    register: async () => {
      order.push("registered");
    },
    setAccess: async (_, enabled) => {
      order.push(String(enabled));
    },
  });
  await controller.setEnabled(true);
  await controller.setEnabled(false);
  expect(order).toEqual(["registered", "true", "false"]);
});

it("a later disable cancels an in-flight enable before it can publish", async () => {
  const started = deferred(), release = deferred();
  const setAccess = vi.fn(async () => undefined);
  const controller = new RemoteAccessController({
    account: async () => "a",
    signal: new AbortController().signal,
    register: async () => {
      started.resolve();
      await release.promise;
    },
    setAccess,
  });
  const enabling = controller.setEnabled(true);
  await started.promise;
  await controller.setEnabled(false);
  release.resolve();
  await expect(enabling).rejects.toThrow("cancelled");
  expect(setAccess).toHaveBeenCalledOnce();
  expect(setAccess).toHaveBeenCalledWith("a", false);
});

it("does not enable access if registration fails", async () => {
  const setAccess = vi.fn(async () => undefined);
  const controller = new RemoteAccessController({
    account: async () => "a",
    signal: new AbortController().signal,
    register: async () => {
      throw new Error("registration failed");
    },
    setAccess,
  });
  await expect(controller.setEnabled(true)).rejects.toThrow("registration failed");
  expect(setAccess).not.toHaveBeenCalled();
});
