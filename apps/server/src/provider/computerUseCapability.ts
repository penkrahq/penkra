// FILE: computerUseCapability.ts
// Purpose: Normalizes provider-native tool inventories into one Computer Use health snapshot.

export type ComputerUseRouteId = "node-repl" | "raw-mcp";
export type ComputerUseRouteState = "ready" | "starting" | "failed" | "missing";

export interface ComputerUseRouteHealth {
  readonly id: ComputerUseRouteId;
  readonly state: ComputerUseRouteState;
  readonly serverName: string | null;
  readonly toolCount: number;
  readonly error: string | null;
}

export interface ComputerUseCapabilityHealth {
  readonly state: "available" | "degraded" | "unavailable";
  readonly preferredRoute: ComputerUseRouteId | null;
  readonly routes: readonly [ComputerUseRouteHealth, ComputerUseRouteHealth];
  readonly checkedAt: string;
}

export interface McpToolInventoryEntry {
  readonly name: string;
  readonly toolNames: readonly string[];
}

export interface McpStartupStatusEntry {
  readonly name: string;
  readonly state: "starting" | "ready" | "failed" | "cancelled";
  readonly error: string | null;
}

const routeState = (
  inventory: McpToolInventoryEntry | undefined,
  startup: McpStartupStatusEntry | undefined,
): ComputerUseRouteState => {
  if (inventory && inventory.toolNames.length > 0) return "ready";
  if (startup?.state === "starting") return "starting";
  if (startup?.state === "failed" || startup?.state === "cancelled") return "failed";
  return "missing";
};

export function classifyComputerUseCapability(input: {
  readonly inventory: readonly McpToolInventoryEntry[];
  readonly startupStatuses?: readonly McpStartupStatusEntry[];
  readonly checkedAt?: string;
}): ComputerUseCapabilityHealth {
  const startupStatuses = input.startupStatuses ?? [];
  const nodeInventory = input.inventory.find(
    (server) => server.name === "node_repl" && server.toolNames.includes("js"),
  );
  const nodeStartup = startupStatuses.find((server) => server.name === "node_repl");
  const rawInventory = input.inventory.find(
    (server) =>
      server.name !== "node_repl" &&
      /(?:^|[-_])computer[-_]?use(?:$|[-_])/.test(server.name.toLowerCase()),
  );
  const rawStartup = startupStatuses.find(
    (server) =>
      server.name !== "node_repl" &&
      /(?:^|[-_])computer[-_]?use(?:$|[-_])/.test(server.name.toLowerCase()),
  );

  const nodeState = routeState(nodeInventory, nodeStartup);
  const rawState = routeState(rawInventory, rawStartup);
  const readyCount = Number(nodeState === "ready") + Number(rawState === "ready");
  const routes = [
    {
      id: "node-repl" as const,
      state: nodeState,
      serverName: nodeInventory?.name ?? nodeStartup?.name ?? null,
      toolCount: nodeInventory?.toolNames.length ?? 0,
      error: nodeStartup?.error ?? null,
    },
    {
      id: "raw-mcp" as const,
      state: rawState,
      serverName: rawInventory?.name ?? rawStartup?.name ?? null,
      toolCount: rawInventory?.toolNames.length ?? 0,
      error: rawStartup?.error ?? null,
    },
  ] as const;

  return {
    state: readyCount === 2 ? "available" : readyCount === 1 ? "degraded" : "unavailable",
    preferredRoute: nodeState === "ready" ? "node-repl" : rawState === "ready" ? "raw-mcp" : null,
    routes,
    checkedAt: input.checkedAt ?? new Date().toISOString(),
  };
}
