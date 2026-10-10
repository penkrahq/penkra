import type {
  ModelSelection,
  OrchestrationSession,
  RuntimeMode,
  ThreadId,
} from "@penkra/contracts";

export function deriveTurnStartSession(input: {
  readonly threadId: ThreadId;
  readonly currentSession: OrchestrationSession | null;
  readonly providerName: OrchestrationSession["providerName"];
  readonly requestedRuntimeMode: RuntimeMode;
  readonly requestedAt: string;
}): OrchestrationSession | null {
  if (input.currentSession?.status === "starting" || input.currentSession?.status === "running") {
    return null;
  }

  return {
    threadId: input.threadId,
    status: "starting",
    providerName: input.currentSession?.providerName ?? input.providerName,
    runtimeMode: input.currentSession?.runtimeMode ?? input.requestedRuntimeMode,
    activeTurnId: null,
    lastError: null,
    updatedAt: input.requestedAt,
  };
}
