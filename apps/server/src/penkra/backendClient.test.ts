import assert from "node:assert/strict";

import { afterEach, describe, it, vi } from "@effect/vitest";

import { PenkraApiError, PenkraBackendClient } from "./backendClient";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("PenkraBackendClient", () => {
  it("enumerates the uniform items envelope across client pages", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            items: [{ id: "client-1", displayName: "Ama", status: "active" }],
            pageInfo: { nextCursor: "client-1" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            items: [{ id: "client-2", displayName: "Kojo", status: "suspended" }],
            pageInfo: { nextCursor: null },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const client = new PenkraBackendClient("https://api.penkra.com", "pk_hq_example");
    assert.deepEqual(await client.listClients(), [
      { id: "client-1", displayName: "Ama", status: "active" },
      { id: "client-2", displayName: "Kojo", status: "suspended" },
    ]);
  });

  it("keeps create idempotency keys in headers and out of request bodies", async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    const fetchMock = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      captured = { url: String(input), init };
      return new Response(
        JSON.stringify({ id: "client-1", displayName: "Ama", status: "active" }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new PenkraBackendClient("https://api.penkra.com", "pk_hq_example");

    await client.createClient({ displayName: "Ama", idempotencyKey: "request-123" });

    assert.ok(captured);
    const request = captured as { url: string; init: RequestInit };
    assert.equal(request.url, "https://api.penkra.com/api/clients");
    assert.equal(
      (request.init.headers as Record<string, string>)["idempotency-key"],
      "request-123",
    );
    assert.deepEqual(JSON.parse(String(request.init.body)), { displayName: "Ama" });
    assert.doesNotMatch(String(request.init.body), /request-123/);
  });

  it("surfaces status-aware API errors without exposing tokens", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ message: "Invalid or revoked token" }), {
            status: 401,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    const client = new PenkraBackendClient("https://api.penkra.com", "pk_hq_secret");

    await assert.rejects(
      client.getSnapshot(),
      (error: unknown) =>
        error instanceof PenkraApiError &&
        error.status === 401 &&
        error.message === "Invalid or revoked token" &&
        !error.message.includes("pk_hq_secret"),
    );
  });

  it("decodes server skill summaries from the realtime snapshot payload", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              generatedAt: "2026-07-16T00:00:00.000Z",
              clients: [],
              todos: [],
              programWarnings: [],
              skills: [
                {
                  scope: "client",
                  name: "document-intake",
                  description: "Store client documents durably",
                },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      ),
    );
    const client = new PenkraBackendClient("https://api.penkra.com", "pk_hq_example");

    const snapshot = await client.getSnapshot();

    assert.deepEqual(snapshot.skills, [
      { scope: "client", name: "document-intake", description: "Store client documents durably" },
    ]);
  });

  it("accepts the base todo returned by a mutation without snapshot-only routing fields", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              id: "todo-1",
              clientId: "client-1",
              status: "open",
              kind: "general",
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      ),
    );
    const client = new PenkraBackendClient("https://api.penkra.com", "pk_hq_example");

    const todoId = await client.updateTodo({ todoId: "todo-1", operatorTouched: true });

    assert.equal(todoId, "todo-1");
  });
});
