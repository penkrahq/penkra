import { Effect, Stream } from "effect";
import { expect, it, vi } from "vitest";
import { CurrentWsSessionRole } from "../wsConnectionSessions";
import {
  RemoteDevicesControlState,
  ownerDeviceChanges,
  ownerDevices,
  ownerRemoveDevice,
} from "./devicesControl";

it("rejects a stale account's list when ownership changes during the read", async () => {
  const control = new RemoteDevicesControlState(),
    ready = Promise.withResolvers<void>(),
    finish = Promise.withResolvers<void>();
  const release = control.attach({
    list: async () => {
      ready.resolve();
      await finish.promise;
      return [{ deviceId: "old", name: "Old", connected: false, lastConnectedAt: null }];
    },
    remove: async () => undefined,
  });
  const read = control.list();
  await ready.promise;
  release();
  control.attach({ list: async () => [], remove: async () => undefined });
  finish.resolve();
  await expect(read).rejects.toThrow("account changed");
});

it("prevents phone clients from reading, changing, or subscribing to device state", async () => {
  const control = new RemoteDevicesControlState(),
    list = vi.fn(async () => []),
    remove = vi.fn(async () => undefined);
  control.attach({ list, remove });
  const client = <A, E>(effect: Effect.Effect<A, E>) =>
    Effect.runPromise(effect.pipe(Effect.provideService(CurrentWsSessionRole, "client")));
  await Promise.all([
    expect(client(ownerDevices(control))).rejects.toThrow("Only the Mac owner"),
    expect(client(ownerRemoveDevice(control, "phone"))).rejects.toThrow("Only the Mac owner"),
    expect(client(Stream.runHead(ownerDeviceChanges(control)))).rejects.toThrow(
      "Only the Mac owner",
    ),
  ]);
  expect(list).not.toHaveBeenCalled();
  expect(remove).not.toHaveBeenCalled();
});
