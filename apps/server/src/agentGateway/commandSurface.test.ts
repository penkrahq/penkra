import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { installDiagnosticsStore } from "../diagnostics/recorder.ts";
import { DiagnosticsStore, openDiagnosticsReader } from "../diagnostics/store.ts";
import { invokeResolvedAgentGatewayCommand } from "./commandSurface.ts";
import { GatewayToolError, gatewayToolErrorResult, type ToolContext } from "./toolRuntime.ts";
import { mcpToolResultText } from "./protocol.ts";

describe("agent gateway command authorization diagnostics", () => {
  it("records consumed session and thread authorization failures without changing the response", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "penkra-command-authorization-"));
    const store = new DiagnosticsStore({ stateDir, appVersion: "0.14.3", process: "server" });
    const uninstall = installDiagnosticsStore(store);
    try {
      const handler = () => Effect.succeed(mcpToolResultText("ok"));
      const resolution = {
        kind: "call" as const,
        arguments: {},
        entry: {
          words: ["test"],
          examples: [],
          tool: {
            definition: { name: "test", description: "test", inputSchema: {} },
            requiredCapability: "thread:write" as const,
            requiresThreadAuthority: true,
            handler,
          },
        },
      };
      for (const code of [
        "caller_session_inactive",
        "caller_thread_inactive",
        "caller_turn_inactive",
      ]) {
        const error = new GatewayToolError(code, "Authorization failed");
        const context = {
          callerThreadId: "thread-command-auth",
          callerTurnId: null,
          callerWriteTurnId: null,
          callerCapabilities: new Set(["thread:write"]),
          assertCallerThreadAuthorized: () => Effect.fail(error),
        } as unknown as ToolContext;
        const result = await Effect.runPromise(
          invokeResolvedAgentGatewayCommand({ resolution, context }),
        );
        expect(result).toEqual(gatewayToolErrorResult(error));
      }
      const db = openDiagnosticsReader(stateDir)!;
      try {
        expect(db.prepare("SELECT code, count FROM incidents").all()).toEqual([
          { code: "COMMAND_REJECTED", count: 2 },
        ]);
      } finally {
        db.close();
      }
    } finally {
      uninstall();
      store.close();
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
