import { Context, Effect, Layer, Queue, Stream } from "effect";
import { WsRpcError } from "@penkra/contracts";
import { CurrentWsSessionRole } from "../wsConnectionSessions";

export interface RemotePhoneView {
  readonly deviceId: string;
  readonly name: string;
  readonly connected: boolean;
  readonly lastConnectedAt: string | null;
}
export interface RemoteDevicesOwner {
  list(): Promise<ReadonlyArray<RemotePhoneView>>;
  remove(deviceId: string): Promise<void>;
}
export type RemoteRelayStatus =
  | "connecting"
  | "connected"
  | "rejected-sign-in"
  | "rejected-protocol";

/** Exposes only the current account's owner, never its keys or session tokens. */
export class RemoteDevicesControlState {
  #owner: RemoteDevicesOwner | undefined;
  #status: RemoteRelayStatus = "connecting";
  readonly #listeners = new Set<() => void>();

  attach(owner: RemoteDevicesOwner): {
    detach: () => void;
    setStatus: (status: RemoteRelayStatus) => void;
  } {
    if (this.#owner) throw new Error("Remote devices already have an owner.");
    this.#owner = owner;
    this.#status = "connecting";
    this.changed();
    const detach = () => {
      if (this.#owner === owner) {
        this.#owner = undefined;
        this.changed();
      }
    };
    const setStatus = (status: RemoteRelayStatus) => {
      if (this.#owner !== owner || this.#status === status) return;
      this.#status = status;
      this.changed();
    };
    return { detach, setStatus };
  }

  async list(): Promise<{ phones: ReadonlyArray<RemotePhoneView>; relay: RemoteRelayStatus }> {
    const owner = this.#owner;
    if (!owner) throw new Error("iPhone access is unavailable.");
    const result = await owner.list();
    if (this.#owner !== owner) throw new Error("The signed-in account changed.");
    return { phones: result, relay: this.#status };
  }

  async remove(deviceId: string): Promise<void> {
    const owner = this.#owner;
    if (!owner) throw new Error("iPhone access is unavailable.");
    await owner.remove(deviceId);
    if (this.#owner !== owner) throw new Error("The signed-in account changed.");
    this.changed();
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    listener();
    return () => {
      this.#listeners.delete(listener);
    };
  }

  changed(): void {
    for (const listener of this.#listeners) {
      try {
        listener();
      } catch {
        /* Observers do not own device state. */
      }
    }
  }
}

export class RemoteDevicesControl extends Context.Service<
  RemoteDevicesControl,
  RemoteDevicesControlState
>()("penkra/remoteLink/DevicesControl") {}
export const RemoteDevicesControlLive = Layer.sync(
  RemoteDevicesControl,
  () => new RemoteDevicesControlState(),
);

export const ownerDevices = (control: RemoteDevicesControlState) =>
  Effect.gen(function* () {
    if ((yield* CurrentWsSessionRole) !== "owner")
      return yield* new WsRpcError({ message: "Only the Mac owner can manage iPhones." });
    return yield* Effect.tryPromise({
      try: () => control.list(),
      catch: () => new WsRpcError({ message: "Could not load paired iPhones." }),
    });
  });
export const ownerRemoveDevice = (control: RemoteDevicesControlState, deviceId: string) =>
  Effect.gen(function* () {
    if ((yield* CurrentWsSessionRole) !== "owner")
      return yield* new WsRpcError({ message: "Only the Mac owner can manage iPhones." });
    return yield* Effect.tryPromise({
      try: () => control.remove(deviceId),
      catch: () => new WsRpcError({ message: "Could not remove iPhone." }),
    });
  });
export const ownerDeviceChanges = (control: RemoteDevicesControlState) =>
  Stream.unwrap(
    Effect.gen(function* () {
      if ((yield* CurrentWsSessionRole) !== "owner")
        return yield* new WsRpcError({ message: "Only the Mac owner can manage iPhones." });
      return Stream.callback<void>(
        (queue) =>
          Effect.acquireRelease(
            Effect.sync(() =>
              control.subscribe(() => {
                Queue.offerUnsafe(queue, undefined);
              }),
            ),
            (unsubscribe) => Effect.sync(unsubscribe),
          ),
        { bufferSize: 1, strategy: "sliding" },
      );
    }),
  );
