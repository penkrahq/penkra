import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import { describe, expect, it } from "vitest";
import { RemoteLifecycleHost } from "./remoteLifecycleHost";

describe("RemoteLifecycleHost", () => {
  it("does not admit a replacement after an unconfirmed disconnect", () => {
    const snapshot = { accountServiceUrl: "https://example.test", accountId: "account", accessOn: true, suspended: false };
    const host = new RemoteLifecycleHost(snapshot);
    const makeSocket = () => {
      const socket = new EventEmitter() as EventEmitter & { write: () => void; resume: () => void; destroy: () => void };
      socket.write = () => {}; socket.resume = () => {}; socket.destroy = () => {};
      return socket;
    };
    const first = makeSocket();
    host.subscribe(first as unknown as Socket, "first");
    first.emit("close");
    expect(() => host.subscribe(makeSocket() as unknown as Socket, "replacement")).toThrow("cleanup has not been acknowledged");
    host.backendExited();
    expect(() => host.subscribe(makeSocket() as unknown as Socket, "after-exit")).not.toThrow();
  });
  it("delivers sleep before wake even when another update is awaiting acknowledgement", async () => {
    const snapshot = {
      accountServiceUrl: "https://example.test",
      accountId: "account",
      accessOn: true,
      suspended: false,
    };
    const host = new RemoteLifecycleHost(snapshot);
    const socket = new EventEmitter() as EventEmitter & {
      write: (data: string) => void;
      resume: () => void;
      destroy: () => void;
      end: () => void;
    };
    const sent: any[] = [];
    socket.write = (data) => sent.push(JSON.parse(data));
    socket.resume = () => {};
    socket.destroy = () => {};
    socket.end = () => {};
    host.subscribe(socket as unknown as Socket, "request");
    const sleeping = host.transition("suspend", { ...snapshot, suspended: true });
    const waking = host.transition("wake", snapshot);
    const ack = (revision: number) =>
      socket.emit("data", Buffer.from(JSON.stringify({ type: "ack", revision }) + "\n"));
    expect(sent.map((frame) => frame.event).filter(Boolean)).toEqual(["snapshot"]);
    ack(0);
    expect(sent.at(-1)).toMatchObject({
      revision: 1,
      event: "suspend",
      snapshot: { suspended: true },
    });
    ack(1);
    expect(sent.at(-1)).toMatchObject({
      revision: 2,
      event: "wake",
      snapshot: { suspended: false },
    });
    ack(2);
    await Promise.all([sleeping, waking]);
  });
});
