import { describe, expect, it } from "vitest";

import {
  WsBootstrapRpcGroup,
  WsFeatureRpcGroup,
  WsFoldersDiscoverScriptsRpc,
  WsRpcError,
  WsRpcGroup,
} from "./rpc";
import { ORCHESTRATION_WS_METHODS } from "./orchestration";
import { WS_METHODS } from "./ws";

describe("WS RPC contracts", () => {
  it("exports the additive Effect RPC group", () => {
    expect(WsRpcGroup).toBeDefined();
    expect(WsBootstrapRpcGroup.requests.has("bootstrap.negotiate")).toBe(true);
    expect(WsFeatureRpcGroup.requests.has("bootstrap.negotiate")).toBe(false);
    expect(
      WsFeatureRpcGroup.requests.has(ORCHESTRATION_WS_METHODS.listProviderDeliveryBlockers),
    ).toBe(true);
    expect(WsFeatureRpcGroup.requests.has(ORCHESTRATION_WS_METHODS.reconcileProviderDelivery)).toBe(
      true,
    );
    expect(WsFeatureRpcGroup.requests.has(WS_METHODS.serverGetSpaceNavigationState)).toBe(true);
    expect(WsFeatureRpcGroup.requests.has(WS_METHODS.serverUpdateSpaceNavigationState)).toBe(true);
    expect(WsFeatureRpcGroup.requests.has(WS_METHODS.subscribeProjectWorkspaceChanges)).toBe(true);
  });

  it("uses a schema-backed transport error", () => {
    expect(new WsRpcError({ message: "failed" }).message).toBe("failed");
  });

  it("exports the project script discovery RPC", () => {
    expect(WsFoldersDiscoverScriptsRpc).toBeDefined();
  });
});
