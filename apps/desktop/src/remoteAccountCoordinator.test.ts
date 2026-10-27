import { describe, expect, it, vi } from "vitest";
import { RemoteAccountCoordinator } from "./remoteAccountCoordinator";
import { deferred } from "./deferred.test-support";

describe("RemoteAccountCoordinator", () => {
  it("keeps the sleep state across an account change until wake", async () => {
    const transition = vi.fn(async (_event: string, _snapshot: unknown) => undefined);
    const coordinator = new RemoteAccountCoordinator({
      accountServiceUrl: "https://example.test",
      readAccess: async () => true,
      transition,
    });
    await coordinator.afterSignIn("account-a");
    await coordinator.setSuspended(true);
    await coordinator.beforeAccountChange();
    await coordinator.afterSignIn("account-b");
    expect(transition.mock.calls.at(-1)).toEqual([
      "sign-in",
      {
        accountServiceUrl: "https://example.test",
        accountId: "account-b",
        accessOn: true,
        suspended: true,
      },
    ]);
    await coordinator.setSuspended(false);
    expect(transition.mock.calls.at(-1)).toEqual([
      "wake",
      {
        accountServiceUrl: "https://example.test",
        accountId: "account-b",
        accessOn: true,
        suspended: false,
      },
    ]);
  });
  it("cannot restore a stale startup account after sign-out", async () => {
    const account = deferred<string | null>();
    const transition = vi.fn(async (_event: string, _snapshot: unknown) => undefined);
    const coordinator = new RemoteAccountCoordinator({
      accountServiceUrl: "https://example.test",
      readAccess: async () => true,
      transition,
    });
    const startup = coordinator.initialize(() => account.promise);
    await coordinator.beforeAccountChange();
    account.resolve("account-a");
    await startup;
    expect(transition).toHaveBeenCalledTimes(1);
    expect(transition.mock.calls[0]?.[0]).toBe("sign-out");
  });
  it("never publishes an account after sign-out overtakes its access read", async () => {
    const reading = deferred<boolean>();
    const entered = deferred();
    const transition = vi.fn(async () => undefined);
    const coordinator = new RemoteAccountCoordinator({
      accountServiceUrl: "https://example.test",
      readAccess: async () => {
        entered.resolve();
        return reading.promise;
      },
      transition,
    });
    const signIn = coordinator.afterSignIn("account-a");
    await entered.promise;
    await coordinator.beforeAccountChange();
    reading.resolve(true);
    await signIn;
    expect(transition).toHaveBeenCalledTimes(1);
    expect(transition).toHaveBeenCalledWith("sign-out", {
      accountServiceUrl: "https://example.test",
      accountId: null,
      accessOn: false,
      suspended: false,
    });
  });

  it("waits for the old account to close before returning from account change", async () => {
    const release = deferred();
    const entered = deferred();
    const coordinator = new RemoteAccountCoordinator({
      accountServiceUrl: "https://example.test",
      readAccess: async () => true,
      transition: async (event) => {
        if (event === "sign-out") {
          entered.resolve();
          await release.promise;
        }
      },
    });
    let finished = false;
    const close = coordinator.beforeAccountChange().then(() => {
      finished = true;
    });
    await entered.promise;
    expect(finished).toBe(false);
    release.resolve();
    await close;
    expect(finished).toBe(true);
  });
});
