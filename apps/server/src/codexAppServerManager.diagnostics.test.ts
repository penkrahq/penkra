import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./diagnostics/recorder", () => ({ recordDiagnosticIncident: vi.fn() }));

import { recordDiagnosticIncident } from "./diagnostics/recorder";
import { CodexAppServerManager } from "./codexAppServerManager";

afterEach(() => {
  vi.useRealTimers();
  vi.mocked(recordDiagnosticIncident).mockClear();
});

describe("Codex app-server manager diagnostics", () => {
  it("records a malformed provider thread response before rejecting it", () => {
    const manager = new CodexAppServerManager();
    const readThreadIdFromResponse = (
      manager as unknown as {
        readThreadIdFromResponse: (method: string, response: unknown) => string;
      }
    ).readThreadIdFromResponse.bind(manager);
    expect(() => readThreadIdFromResponse("thread/start", { thread: {} })).toThrow(
      "thread/start response did not include a thread id.",
    );
    expect(recordDiagnosticIncident).toHaveBeenCalledWith(
      expect.objectContaining({ code: "EXTERNAL_CALL_FAILED", where: "server.codex_app" }),
    );
  });

  it("records a provider request timeout before rejecting the request", async () => {
    vi.useFakeTimers();
    const manager = new CodexAppServerManager();
    const context = {
      nextRequestId: 1,
      lastRequestMethod: undefined as string | undefined,
      pending: new Map(),
      stdinWriter: { write: vi.fn().mockResolvedValue(undefined) },
    };
    const request = (
      manager as unknown as {
        sendRequest: (
          context: unknown,
          method: string,
          params: unknown,
          timeoutMs: number,
        ) => Promise<unknown>;
      }
    ).sendRequest(context, "thread/read", {}, 25);
    const rejection = expect(request).rejects.toThrow("Timed out waiting for thread/read.");
    await vi.advanceTimersByTimeAsync(25);
    await rejection;
    expect(context.pending.size).toBe(0);
    expect(recordDiagnosticIncident).toHaveBeenCalledWith(
      expect.objectContaining({ code: "EXTERNAL_CALL_FAILED", where: "server.codex_app" }),
    );
  });
});
