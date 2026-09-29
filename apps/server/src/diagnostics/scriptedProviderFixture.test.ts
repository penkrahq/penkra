import { fileURLToPath } from "node:url";
import { ThreadId } from "@penkra/contracts";
import { describe, expect, it } from "vitest";

import { CodexAppServerManager } from "../codexAppServerManager";

const fixture = fileURLToPath(
  new URL("../../../../scripts/diagnostics-qa/scripted-codex-app-server.mjs", import.meta.url),
);
const repoRoot = fileURLToPath(new URL("../../../..", import.meta.url));

describe("scripted provider fixture through the real adapter", () => {
  it("starts a session, sends a held turn, and interrupts it", async () => {
    const manager = new CodexAppServerManager();
    const threadId = ThreadId.makeUnsafe("thread-diagnostics-qa-fixture");
    try {
      const session = await manager.startSession({
        threadId,
        provider: "codex",
        runtimeMode: "full-access",
        cwd: repoRoot,
        providerOptions: { codex: { binaryPath: fixture } },
      });
      expect(session.status).toBe("ready");
      const turn = await manager.sendTurn({ threadId, input: "qa:hold" });
      expect(turn.threadId).toBe(threadId);
      await manager.interruptTurn(threadId, turn.turnId);
    } finally {
      await manager.stopAll();
    }
  }, 30_000);
});
