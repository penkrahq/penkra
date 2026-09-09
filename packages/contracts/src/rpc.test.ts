import { describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";

import {
  WsBootstrapRpcGroup,
  WsFeatureRpcGroup,
  WsFoldersDiscoverScriptsRpc,
  WsRpcError,
  WsRpcGroup,
} from "./rpc";
import { ORCHESTRATION_WS_METHODS, OrchestrationRpcSchemas } from "./orchestration";
import { WS_METHODS } from "./ws";

describe("WS RPC contracts", () => {
  it.each(Object.keys(OrchestrationRpcSchemas) as Array<keyof typeof OrchestrationRpcSchemas>)(
    "registers the declared orchestration contract %s in the feature transport",
    (name) => {
      expect(WsFeatureRpcGroup.requests.has(ORCHESTRATION_WS_METHODS[name])).toBe(true);
    },
  );

  it("constructs the pending-start recovery handler in the feature RPC group", async () => {
    const handlerLayer = WsFeatureRpcGroup.toLayerHandler(
      ORCHESTRATION_WS_METHODS.getPendingStartOutcome,
      () => Effect.die("not invoked"),
    );
    await expect(
      Effect.runPromise(Effect.scoped(Layer.build(handlerLayer))),
    ).resolves.toBeDefined();
    expect(WsFeatureRpcGroup.requests.has(ORCHESTRATION_WS_METHODS.getPendingStartOutcome)).toBe(
      true,
    );
  });

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
