export interface OperationAddress {
  /** Stable App slug, for example `linear`. */
  app: string;
  /** App-local operation key, for example `issues.create`. */
  operation: string;
}

export interface OperationInvocation<Input = unknown> extends OperationAddress {
  /** Host-minted identity for this invocation. */
  id: string;
  /** Host-validated Space that owns this invocation. */
  spaceId: string;
  threadId: string;
  /** Explicitly targeted existing App tab, when the operation needs one. */
  tabId?: string;
  input: Input;
}

export interface OperationRequest<Input = unknown> extends OperationAddress {
  input: Input;
  /** Invocation envelope field; it is not part of the App's input schema. */
  tabId?: string;
}

export const OPERATION_CANCELLATION_CODES = [
  "user",
  "tab-closed",
  "operation-cancelled",
  "timeout",
  "app-disabled",
  "app-uninstalled",
  "host-stopped",
] as const;

export type OperationCancellationCode = (typeof OPERATION_CANCELLATION_CODES)[number];

export interface AppTabHandle {
  readonly id: string;
  /** Navigate the explicitly targeted existing tab and await accepted delivery. */
  navigate(input: { route: string; state?: unknown }): Promise<void>;
  /** Navigate the targeted tab and wait for its UI to complete the request. */
  navigateForResult<Result = unknown>(input: { route: string; state?: unknown }): Promise<Result>;
  /** Send a point-to-point request to this tab's registered UI handler. */
  invoke<Result = unknown>(input: { operation: string; input: unknown }): Promise<Result>;
}

export interface AppTabs {
  /** Open a new App tab without implying a user-result wait. */
  open(input: { route: string; state?: unknown }): Promise<AppTabHandle>;
  /** Open a new App tab and wait for its UI to complete the request. */
  openForResult<Result = unknown>(input: { route: string; state?: unknown }): Promise<Result>;
}

export interface OperationContext {
  invocation: Omit<OperationInvocation, "input">;
  /** Host-asserted caller class. Caller identity is deliberately not exposed. */
  caller: { kind: "user" | "agent" | "app" | "host" };
  /** Present only when the invocation targets a validated existing App tab. */
  tab?: AppTabHandle;
  /** Manager for opening new tabs owned by the invoked App. */
  tabs: AppTabs;
  operations: {
    invoke<Result = unknown>(request: OperationRequest): Promise<Result>;
  };
  signal: AbortSignal;
}
