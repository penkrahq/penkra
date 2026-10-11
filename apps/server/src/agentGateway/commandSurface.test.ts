import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { invokeResolvedAgentGatewayCommand } from "./commandSurface.ts";
import { GatewayToolError, gatewayToolErrorResult, type ToolContext } from "./toolRuntime.ts";
import { mcpToolResultText } from "./protocol.ts";

describe("agent gateway command authorization", () => {
  it("returns session, thread and turn authorization failures", async () => {
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
  });
});
