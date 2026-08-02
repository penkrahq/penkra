import type { OperationContext } from "./operations";

export type AppOperationHandler<Input = unknown, Result = unknown> = (
  input: Input,
  context: OperationContext,
) => Promise<Result> | Result;

export interface AppTabHandlerContext {
  signal: AbortSignal;
}

export type AppTabOperationHandler<Input = unknown, Result = unknown> = (
  input: Input,
  context: AppTabHandlerContext,
) => Promise<Result> | Result;

export interface AppTabNavigationInput {
  route: string;
  state?: unknown;
}

export type AppTabNavigationHandler<Result = void> = (
  input: AppTabNavigationInput,
  context: AppTabHandlerContext,
) => Promise<Result> | Result;

export interface PenkraAppRuntimeApi {
  operations: {
    handle<Input = unknown, Result = unknown>(
      handlerKey: string,
      handler: AppOperationHandler<Input, Result>,
    ): () => void;
  };
  tab: {
    handle<Input = unknown, Result = unknown>(
      operation: string,
      handler: AppTabOperationHandler<Input, Result>,
    ): () => void;
    onNavigate<Result = void>(handler: AppTabNavigationHandler<Result>): () => void;
  };
}

function runtime(): PenkraAppRuntimeApi {
  const candidate = (globalThis as { penkra?: PenkraAppRuntimeApi }).penkra;
  if (!candidate) {
    throw new Error("Penkra App runtime is unavailable. Run this package inside Penkra.");
  }
  return candidate;
}

/** Framework-neutral operation registration backed by the host preload bridge. */
export const operations: PenkraAppRuntimeApi["operations"] = {
  handle: (handlerKey, handler) => runtime().operations.handle(handlerKey, handler),
};

/** Framework-neutral tab registration backed by the host preload bridge. */
export const tab: PenkraAppRuntimeApi["tab"] = {
  handle: (operation, handler) => runtime().tab.handle(operation, handler),
  onNavigate: (handler) => runtime().tab.onNavigate(handler),
};
