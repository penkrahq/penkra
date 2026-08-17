import { describe, expect, it, vi } from "vitest";

import { subscribeAccountDataWithBufferedHandshake } from "./appAccountDataSubscriptionBridge";

describe("App Account-data preload subscription bridge", () => {
  it("delivers an initial event emitted before the subscription ID returns", async () => {
    type TransportListener = Parameters<
      Parameters<typeof subscribeAccountDataWithBufferedHandshake>[0]["listen"]
    >[0];
    let transportListener: TransportListener | null = null;
    const event = {
      channel: "document:one",
      event: "presence",
      payload: { count: 2 },
      occurredAt: "2026-08-07T00:00:00.000Z",
    };
    const onEvent = vi.fn();
    const stop = vi.fn();

    const unsubscribe = await subscribeAccountDataWithBufferedHandshake({
      listen: (listener) => {
        transportListener = listener;
        return () => {
          transportListener = null;
        };
      },
      start: async () => {
        transportListener?.({ subscriptionId: "subscription-1", event });
        return "subscription-1";
      },
      stop,
      onEvent,
    });

    expect(onEvent).toHaveBeenCalledWith(event);
    unsubscribe();
    expect(stop).toHaveBeenCalledWith("subscription-1");
    expect(transportListener).toBeNull();
  });

  it("reports connected after a successful start when the initial IPC state races the handshake", async () => {
    const onConnectionStateChange = vi.fn();

    const unsubscribe = await subscribeAccountDataWithBufferedHandshake({
      listen: () => () => undefined,
      start: async () => "subscription-1",
      stop: vi.fn(),
      onEvent: vi.fn(),
      onConnectionStateChange,
    });

    expect(onConnectionStateChange).toHaveBeenCalledOnce();
    expect(onConnectionStateChange).toHaveBeenCalledWith("connected");
    unsubscribe();
  });

  it("does not duplicate an initial connection state buffered during the handshake", async () => {
    type TransportListener = Parameters<
      Parameters<typeof subscribeAccountDataWithBufferedHandshake>[0]["listen"]
    >[0];
    let transportListener: TransportListener | null = null;
    const onConnectionStateChange = vi.fn();

    const unsubscribe = await subscribeAccountDataWithBufferedHandshake({
      listen: (listener) => {
        transportListener = listener;
        return () => {
          transportListener = null;
        };
      },
      start: async () => {
        transportListener?.({ subscriptionId: "subscription-1", connectionState: "connected" });
        return "subscription-1";
      },
      stop: vi.fn(),
      onEvent: vi.fn(),
      onConnectionStateChange,
    });

    expect(onConnectionStateChange).toHaveBeenCalledOnce();
    expect(onConnectionStateChange).toHaveBeenCalledWith("connected");
    unsubscribe();
  });
});
