import { describe, expect, it, vi } from "vitest";

import {
  normalizeNamespacePath,
  requestAppAccountData,
  subscribeAppAccountData,
} from "./appAccountData";

describe("App Account data", () => {
  it("keeps requests inside the calling App namespace and hides the session cookie", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json", "x-private": "hidden" },
        }),
    );

    const result = await requestAppAccountData({
      apiUrl: "https://api.penkra.test",
      appId: "com.penkra.canvas",
      cookie: "penkra.session=secret",
      request: { path: "/canvas/documents?limit=20" },
      fetch,
    });

    expect(fetch).toHaveBeenCalledWith(
      "https://api.penkra.test/api/apps/com.penkra.canvas/canvas/documents?limit=20",
      expect.objectContaining({
        headers: expect.objectContaining({
          cookie: "penkra.session=secret",
          "x-penkra-app-id": "com.penkra.canvas",
        }),
      }),
    );
    expect(result.status).toBe(200);
    expect(result.headers).toEqual({ "content-type": "application/json" });
    expect(new TextDecoder().decode(result.body)).toBe('{"ok":true}');
  });

  it("rejects namespace escapes, including encoded traversal", () => {
    expect(() => normalizeNamespacePath("https://example.com/steal")).toThrow();
    expect(() => normalizeNamespacePath("/../registry/apps")).toThrow();
    expect(() => normalizeNamespacePath("/%2e%2e/registry/apps")).toThrow();
    expect(() => normalizeNamespacePath("//registry/apps")).toThrow();
  });

  it("requires an authenticated Account without returning credentials to the App", async () => {
    await expect(
      requestAppAccountData({
        apiUrl: "https://api.penkra.test",
        appId: "com.penkra.canvas",
        cookie: "",
        request: { path: "/canvas/documents" },
      }),
    ).rejects.toMatchObject({ code: "ACCOUNT_SESSION_REQUIRED" });
  });

  it("keeps buffered Account-data payloads bounded", async () => {
    await expect(
      requestAppAccountData({
        apiUrl: "https://api.penkra.test",
        appId: "com.penkra.canvas",
        cookie: "penkra.session=secret",
        request: {
          path: "/canvas/documents",
          method: "POST",
          body: "x".repeat(24 * 1024 * 1024 + 1),
        },
        fetch: vi.fn(),
      }),
    ).rejects.toThrow("request body is too large");

    await expect(
      requestAppAccountData({
        apiUrl: "https://api.penkra.test",
        appId: "com.penkra.canvas",
        cookie: "penkra.session=secret",
        request: { path: "/canvas/documents" },
        fetch: vi.fn(
          async () =>
            new Response(null, { headers: { "content-length": String(24 * 1024 * 1024 + 1) } }),
        ),
      }),
    ).rejects.toThrow("response is too large");
  });

  it("listens before subscription acknowledgement can release the initial event", async () => {
    const listeners = new Map<string, Set<(value?: unknown) => void>>();
    const socket = {
      connected: true,
      on: vi.fn((event: string, listener: (value?: unknown) => void) => {
        const registered = listeners.get(event) ?? new Set();
        registered.add(listener);
        listeners.set(event, registered);
        return socket;
      }),
      off: vi.fn((event: string, listener: (value?: unknown) => void) => {
        listeners.get(event)?.delete(listener);
        return socket;
      }),
      emit: vi.fn((event: string, input: unknown, acknowledge?: (value: unknown) => void) => {
        if (event === "app:subscribe") {
          acknowledge?.({ ok: true });
          for (const listener of listeners.get("app:event") ?? []) {
            listener({
              channel: "document:one",
              event: "presence",
              payload: { count: 1 },
              occurredAt: "2026-08-06T00:00:00.000Z",
            });
          }
        }
        return true;
      }),
      close: vi.fn(),
    };
    const events: unknown[] = [];

    const subscription = await subscribeAppAccountData({
      apiUrl: "https://api.penkra.test",
      appId: "com.penkra.canvas",
      cookie: "penkra.session=secret",
      channel: "document:one",
      onEvent: (event) => events.push(event),
      connect: vi.fn(() => socket as never) as never,
    });

    expect(events).toEqual([
      {
        channel: "document:one",
        event: "presence",
        payload: { count: 1 },
        occurredAt: "2026-08-06T00:00:00.000Z",
      },
    ]);
    subscription.stop();
    expect(socket.close).toHaveBeenCalledOnce();
  });
});
