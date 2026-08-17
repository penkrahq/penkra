// FILE: appRuntimeBridge.ts
// Purpose: Defines the structured-clone protocol between a Runtime v2 App iframe and its host.
// Layer: Shared schema-only contracts

export const APP_RUNTIME_BRIDGE_PROTOCOL_VERSION = 2 as const;
export const APP_RUNTIME_CONNECT_MESSAGE = "penkra:runtime-connect" as const;

export interface AppRuntimeConnectMessage {
  type: typeof APP_RUNTIME_CONNECT_MESSAGE;
  protocolVersion: typeof APP_RUNTIME_BRIDGE_PROTOCOL_VERSION;
}

export type AppRuntimeFrameMessage =
  | { type: "ready" }
  | { type: "call"; id: string; method: string; input?: unknown }
  | { type: "renderer-message"; message: unknown };

export type AppRuntimeHostMessage =
  | { type: "call-result"; id: string; result: unknown }
  | { type: "call-error"; id: string; code: string; message: string }
  | { type: "host-message"; message: unknown }
  | { type: "event"; name: string; payload: unknown };
