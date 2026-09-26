import { describe, expect, it, vi } from "vitest";
import { executeDesktopThreadCommand } from "./desktopThreadClient";

const request = {
  id: "command",
  appId: "app",
  spaceId: "space",
  deckId: "deck",
  tabId: "tab",
  threadId: "thread",
  method: "list",
} as const;

describe("desktop Thread command client", () => {
  it("executes without consulting a shell window", async () => {
    const fetcher = vi.fn(async () => ({
      json: async () => ({ ok: true, result: ["thread"] }),
    })) as unknown as typeof fetch;
    await expect(
      executeDesktopThreadCommand({
        url: "http://127.0.0.1:1234",
        token: "private",
        request,
        fetcher,
      }),
    ).resolves.toEqual(["thread"]);
    expect(fetcher).toHaveBeenCalledWith(
      "http://127.0.0.1:1234/api/desktop/thread-command",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("settles when a window closes during the backend operation", async () => {
    let complete!: (value: { json(): Promise<unknown> }) => void;
    const fetcher = vi.fn(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    ) as unknown as typeof fetch;
    const result = executeDesktopThreadCommand({
      url: "http://127.0.0.1:1234",
      token: "private",
      request,
      fetcher,
    });
    const window = { destroyed: false };
    window.destroyed = true;
    complete({ json: async () => ({ ok: true, result: ["thread"] }) });
    await expect(result).resolves.toEqual(["thread"]);
    expect(window.destroyed).toBe(true);
  });

  it("preserves backend command errors", async () => {
    const fetcher = vi.fn(async () => ({
      json: async () => ({ ok: false, code: "THREAD_NOT_IN_DECK", message: "Wrong Deck" }),
    })) as unknown as typeof fetch;
    await expect(
      executeDesktopThreadCommand({
        url: "http://127.0.0.1:1234",
        token: "private",
        request,
        fetcher,
      }),
    ).rejects.toMatchObject({ code: "THREAD_NOT_IN_DECK", message: "Wrong Deck" });
  });
});
