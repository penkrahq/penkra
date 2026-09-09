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
  readonly steeringPending: boolean;
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

export function registerDesktopThreadLiveHandlers(
  threadId: string,
  handlers: DesktopThreadLiveHandlers,
): () => void {
  handlersByThreadId.set(threadId, handlers);
  return () => {
    if (handlersByThreadId.get(threadId) === handlers) handlersByThreadId.delete(threadId);
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
