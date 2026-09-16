import { CommandId, MessageId, ThreadId } from "@penkra/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { readNativeApi } from "./nativeApi";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("readNativeApi turn origin binding", () => {
  it("binds the renderer window to the server-derived turn identity before dispatch", async () => {
    const bindTurnOrigin = vi.fn();
    const unbindTurnOrigin = vi.fn();
    const dispatchCommand = vi.fn(async () => ({ sequence: 7 }));
    vi.stubGlobal("window", {
      nativeApi: { orchestration: { dispatchCommand } },
      desktopBridge: { threadApi: { bindTurnOrigin, unbindTurnOrigin } },
    });

    await readNativeApi()!.orchestration.dispatchCommand({
      type: "thread.turn.start",
      commandId: CommandId.makeUnsafe("command-1"),
      threadId: ThreadId.makeUnsafe("thread-1"),
      message: {
        messageId: MessageId.makeUnsafe("message-1"),
        role: "user",
        text: "Hello",
        attachments: [],
      },
      runtimeMode: "full-access",
      createdAt: "2026-09-16T00:00:00.000Z",
    });

    expect(bindTurnOrigin).toHaveBeenCalledWith({ turnId: "turn:command-1" });
    expect(dispatchCommand).toHaveBeenCalledOnce();
    expect(unbindTurnOrigin).not.toHaveBeenCalled();
  });

  it("releases a turn origin when admission fails", async () => {
    const bindTurnOrigin = vi.fn();
    const unbindTurnOrigin = vi.fn();
    const dispatchCommand = vi.fn(async () => {
      throw new Error("rejected");
    });
    vi.stubGlobal("window", {
      nativeApi: { orchestration: { dispatchCommand } },
      desktopBridge: { threadApi: { bindTurnOrigin, unbindTurnOrigin } },
    });

    await expect(
      readNativeApi()!.orchestration.dispatchCommand({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("command-2"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: MessageId.makeUnsafe("message-2"),
          role: "user",
          text: "Hello",
          attachments: [],
        },
        runtimeMode: "full-access",
        createdAt: "2026-09-16T00:00:00.000Z",
      }),
    ).rejects.toThrow("rejected");

    expect(bindTurnOrigin).toHaveBeenCalledWith({ turnId: "turn:command-2" });
    expect(unbindTurnOrigin).toHaveBeenCalledWith({ turnId: "turn:command-2" });
  });
});
