import type { ThreadId } from "@penkra/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CodexAppServerManager } from "./codexAppServerManager";

afterEach(() => {
  vi.useRealTimers();
});

describe("Codex app-server failures", () => {
  it("rejects a malformed provider thread response", () => {
    const manager = new CodexAppServerManager();
    const readThreadIdFromResponse = (
      manager as unknown as {
        readThreadIdFromResponse: (method: string, response: unknown) => string;
      }
    ).readThreadIdFromResponse.bind(manager);
    expect(() => readThreadIdFromResponse("thread/start", { thread: {} })).toThrow(
      "thread/start response did not include a thread id.",
    );
  });

  it("rejects a provider request timeout and clears the pending request", async () => {
    vi.useFakeTimers();
    const manager = new CodexAppServerManager();
    const context = {
      child: { pid: 5544 },
      nextRequestId: 1,
      lastRequestMethod: undefined as string | undefined,
      pending: new Map(),
      stdinWriter: { write: vi.fn().mockResolvedValue(undefined) },
    };
    const request = (
      manager as unknown as {
        sendRequest: (
          context: unknown,
          ownerThreadId: ThreadId | null,
          method: string,
          params: unknown,
          timeoutMs: number,
        ) => Promise<unknown>;
      }
    ).sendRequest(context, null, "thread/read", {}, 25);
    const rejection = expect(request).rejects.toThrow("Timed out waiting for thread/read.");
    await vi.advanceTimersByTimeAsync(25);
    await rejection;
    expect(context.pending.size).toBe(0);
  });
});
