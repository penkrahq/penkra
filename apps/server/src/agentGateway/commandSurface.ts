import { Effect } from "effect";

import {
  parseOperationInput,
  parseRegisteredCommandFlags,
  tokenizeRegisteredCommand,
} from "../appRuntimeCli.ts";
import { mcpToolResultJson, type McpToolCallResult } from "./protocol.ts";
import {
  GatewayToolError,
  gatewayToolErrorResult,
  type ToolContext,
  type ToolEntry,
} from "./toolRuntime.ts";

export interface AgentGatewayCommandEntry {
  readonly words: ReadonlyArray<string>;
  readonly tool: ToolEntry;
  readonly fixedArguments?: Readonly<Record<string, unknown>>;
}

export type AgentGatewayCommandResolution =
  | { readonly kind: "fallback" }
  | { readonly kind: "result"; readonly result: McpToolCallResult }
  | {
      readonly kind: "call";
      readonly entry: AgentGatewayCommandEntry;
      readonly arguments: Record<string, unknown>;
    };

function commandText(entry: AgentGatewayCommandEntry): string {
  return `penkra ${entry.words.join(" ")}`;
}

function commandHelp(entry: AgentGatewayCommandEntry, includeSchema: boolean): McpToolCallResult {
  return mcpToolResultJson({
    command: commandText(entry),
    description: entry.tool.definition.description,
    ...(includeSchema ? { inputSchema: entry.tool.definition.inputSchema } : {}),
  });
}

export function agentGatewayCommandCatalog(
  entries: ReadonlyArray<AgentGatewayCommandEntry>,
): ReadonlyArray<string> {
  return entries.map(commandText);
}

export function resolveAgentGatewayCommand(
  command: string,
  entries: ReadonlyArray<AgentGatewayCommandEntry>,
): AgentGatewayCommandResolution {
  const tokens = tokenizeRegisteredCommand(command);
  if (tokens[0] !== "penkra") return { kind: "fallback" };

  const commandTokens = tokens.slice(1);
  const groupHelp = commandTokens.at(-1) === "--help" || commandTokens.at(-1) === "-h";
  const groupWords = groupHelp ? commandTokens.slice(0, -1) : commandTokens;
  const exact = entries.find(
    (entry) =>
      entry.words.length <= commandTokens.length &&
      entry.words.every((word, index) => commandTokens[index] === word),
  );

  if (!exact) {
    if (groupHelp && groupWords.length > 0) {
      const children = entries.filter(
        (entry) =>
          entry.words.length > groupWords.length &&
          groupWords.every((word, index) => entry.words[index] === word),
      );
      if (children.length > 0) {
        return {
          kind: "result",
          result: mcpToolResultJson({
            command: `penkra ${groupWords.join(" ")}`,
            commands: children.map(commandText),
          }),
        };
      }
    }
    return { kind: "fallback" };
  }

  const parsed = parseRegisteredCommandFlags(commandTokens.slice(exact.words.length));
  if (parsed.positionals.length > 0 || parsed.tabId !== undefined) {
    throw new Error(
      `Invalid arguments for ${commandText(exact)}. Run ${commandText(exact)} --help.`,
    );
  }
  if (parsed.help || parsed.schema) {
    return { kind: "result", result: commandHelp(exact, parsed.schema) };
  }
  const decoded = parseOperationInput(
    exact.tool.definition.inputSchema,
    parsed.input,
    parsed.named,
  );
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new Error(`${commandText(exact)} requires an object input.`);
  }
  for (const key of Object.keys(exact.fixedArguments ?? {})) {
    if (Object.hasOwn(decoded, key)) {
      throw new Error(`${key} is fixed by the ${commandText(exact)} command.`);
    }
  }
  return {
    kind: "call",
    entry: exact,
    arguments: { ...(decoded as Record<string, unknown>), ...exact.fixedArguments },
  };
}

export function invokeResolvedAgentGatewayCommand(input: {
  readonly resolution: Extract<AgentGatewayCommandResolution, { readonly kind: "call" }>;
  readonly context: ToolContext;
}): Effect.Effect<McpToolCallResult> {
  const { entry } = input.resolution;
  if (!input.context.callerCapabilities.has(entry.tool.requiredCapability)) {
    return Effect.succeed(
      gatewayToolErrorResult(
        new GatewayToolError(
          "capability_denied",
          `This provider session is not authorized for ${entry.tool.requiredCapability}.`,
          { requiredCapability: entry.tool.requiredCapability },
        ),
      ),
    );
  }
  const invoke = entry.tool.handler(input.resolution.arguments, input.context);
  return (
    entry.tool.requiresActiveTurn
      ? input.context.assertCallerTurnActive().pipe(Effect.andThen(invoke))
      : invoke
  ).pipe(Effect.catch((error) => Effect.succeed(gatewayToolErrorResult(error))));
}
