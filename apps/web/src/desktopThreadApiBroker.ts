// FILE: desktopThreadApiBroker.ts
// Purpose: Connects the trusted desktop App bridge to the live ChatView send lifecycle.
// Layer: Trusted Penkra shell renderer

export interface DesktopThreadLiveState {
  readonly threadId: string;
  readonly phase: "idle" | "submitting" | "running" | "waiting" | "stopping" | "failed";
  readonly activeTurnId: string | null;
  readonly queuedCount: number;
  readonly pendingUserInput: boolean;
  readonly sendBusy: boolean;
}

export interface DesktopThreadSendRequest {
  readonly expectedText: string;
  readonly mode: "queue" | "steer";
}

export interface DesktopThreadLiveHandlers {
  read(): DesktopThreadLiveState;
  send(request: DesktopThreadSendRequest): Promise<boolean>;
}

const handlersByThreadId = new Map<string, DesktopThreadLiveHandlers>();
const stateListeners = new Set<(threadId: string) => void>();

function publishStateChange(threadId: string): void {
  for (const listener of stateListeners) listener(threadId);
}

export function subscribeDesktopThreadLiveStateChanges(
  listener: (threadId: string) => void,
): () => void {
  stateListeners.add(listener);
  return () => stateListeners.delete(listener);
}

export function registerDesktopThreadLiveHandlers(
  threadId: string,
  handlers: DesktopThreadLiveHandlers,
): () => void {
  handlersByThreadId.set(threadId, handlers);
  publishStateChange(threadId);
  return () => {
    if (handlersByThreadId.get(threadId) === handlers) {
      handlersByThreadId.delete(threadId);
      publishStateChange(threadId);
    }
  };
}

export function requireDesktopThreadLiveHandlers(threadId: string): DesktopThreadLiveHandlers {
  const handlers = handlersByThreadId.get(threadId);
  if (!handlers) {
    throw Object.assign(new Error("The App's current Thread is not mounted in the Penkra shell."), {
      code: "THREAD_NOT_MOUNTED",
    });
  }
  return handlers;
}

export function getDesktopThreadLiveHandlers(
  threadId: string,
): DesktopThreadLiveHandlers | undefined {
  return handlersByThreadId.get(threadId);
}
