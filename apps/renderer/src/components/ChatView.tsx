import { ArrowUpIcon, LoaderCircleIcon, SquareIcon } from "lucide-react";
import {
  type FormEvent,
  type KeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  DEFAULT_MODEL,
  DEFAULT_REASONING,
  MODEL_OPTIONS,
  REASONING_OPTIONS,
  resolveModelSlug,
} from "../model-logic";
import {
  derivePhase,
  deriveTimelineEntries,
  deriveWorkLogEntries,
  formatElapsed,
  formatTimestamp,
  readNativeApi,
} from "../session-logic";
import { useStore } from "../store";
import ChatMarkdown from "./ChatMarkdown";
import { Button } from "./ui/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupText,
  InputGroupTextarea,
} from "./ui/input-group";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "./ui/select";

function formatMessageMeta(createdAt: string, duration: string | null): string {
  if (!duration) return formatTimestamp(createdAt);
  return `${formatTimestamp(createdAt)} • ${duration}`;
}

function statusLabel(phase: string): string {
  if (phase === "running") return "Thinking / working";
  if (phase === "connecting") return "Connecting";
  if (phase === "ready") return "Ready";
  return "Disconnected";
}

function workToneClass(tone: "thinking" | "tool" | "info" | "error"): string {
  if (tone === "error") return "text-destructive/50";
  if (tone === "tool") return "text-muted-foreground";
  if (tone === "thinking") return "text-muted-foreground/70";
  return "text-muted-foreground/60";
}

export default function ChatView() {
  const { state, dispatch } = useStore();
  const api = useMemo(() => readNativeApi(), []);
  const [prompt, setPrompt] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [selectedEffort, setSelectedEffort] =
    useState<string>(DEFAULT_REASONING);
  const [nowTick, setNowTick] = useState(() => Date.now());
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const activeThread = state.threads.find((t) => t.id === state.activeThreadId);
  const activeProject = state.projects.find(
    (p) => p.id === activeThread?.projectId,
  );
  const selectedModel = resolveModelSlug(
    activeThread?.model ?? activeProject?.model ?? DEFAULT_MODEL,
  );
  const phase = derivePhase(activeThread?.session ?? null);
  const isWorking = phase === "running" || isSending || isConnecting;
  const activeTurnId = activeThread?.session?.activeTurnId;
  const nowIso = new Date(nowTick).toISOString();
  const modelOptions = MODEL_OPTIONS;
  const workLogEntries = useMemo(
    () => deriveWorkLogEntries(activeThread?.events ?? [], activeTurnId),
    [activeThread?.events, activeTurnId],
  );
  const assistantCompletionByItemId = useMemo(() => {
    const map = new Map<string, string>();
    const ordered = [...(activeThread?.events ?? [])].reverse();
    for (const event of ordered) {
      if (event.method !== "item/completed") continue;
      if (!event.itemId) continue;
      map.set(event.itemId, event.createdAt);
    }
    return map;
  }, [activeThread?.events]);
  const timelineEntries = useMemo(
    () =>
      deriveTimelineEntries(
        activeThread?.messages ?? [],
        isWorking ? workLogEntries : [],
      ),
    [activeThread?.messages, isWorking, workLogEntries],
  );

  // Auto-scroll on new messages
  const messageCount = activeThread?.messages.length ?? 0;
  const workLogCount = workLogEntries.length;
  // biome-ignore lint/correctness/useExhaustiveDependencies: trigger on message count change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messageCount]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: auto-scroll while active work-log events stream in
  useEffect(() => {
    if (phase !== "running") return;
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [phase, workLogCount]);

  useEffect(() => {
    if (phase !== "running") return;
    const timer = window.setInterval(() => {
      setNowTick(Date.now());
    }, 250);
    return () => {
      window.clearInterval(timer);
    };
  }, [phase]);

  const ensureSession = async (): Promise<string | null> => {
    if (!api || !activeThread || !activeProject) return null;
    if (activeThread.session && activeThread.session.status !== "closed") {
      return activeThread.session.sessionId;
    }

    setIsConnecting(true);
    try {
      const session = await api.providers.startSession({
        provider: "codex",
        cwd: activeProject.cwd || undefined,
        model: selectedModel || undefined,
      });
      dispatch({
        type: "UPDATE_SESSION",
        threadId: activeThread.id,
        session,
      });
      return session.sessionId;
    } catch (err) {
      dispatch({
        type: "SET_ERROR",
        threadId: activeThread.id,
        error: err instanceof Error ? err.message : "Failed to connect.",
      });
      return null;
    } finally {
      setIsConnecting(false);
    }
  };

  const onSend = async (e: FormEvent) => {
    e.preventDefault();
    if (!api || !activeThread || isSending || isConnecting) return;
    const trimmed = prompt.trim();
    if (!trimmed) return;

    // Auto-title from first message
    if (activeThread.messages.length === 0) {
      const title =
        trimmed.length > 50 ? `${trimmed.slice(0, 50)}...` : trimmed;
      dispatch({
        type: "SET_THREAD_TITLE",
        threadId: activeThread.id,
        title,
      });
    }

    dispatch({
      type: "SET_ERROR",
      threadId: activeThread.id,
      error: null,
    });
    dispatch({
      type: "PUSH_USER_MESSAGE",
      threadId: activeThread.id,
      id: crypto.randomUUID(),
      text: trimmed,
    });
    setPrompt("");

    const sessionId = await ensureSession();
    if (!sessionId) return;

    setIsSending(true);
    try {
      await api.providers.sendTurn({
        sessionId,
        input: trimmed,
        model: selectedModel || undefined,
        effort: selectedEffort || undefined,
      });
    } catch (err) {
      dispatch({
        type: "SET_ERROR",
        threadId: activeThread.id,
        error: err instanceof Error ? err.message : "Failed to send message.",
      });
    } finally {
      setIsSending(false);
    }
  };

  const onInterrupt = async () => {
    if (!api || !activeThread?.session) return;
    await api.providers.interruptTurn({
      sessionId: activeThread.session.sessionId,
      turnId: activeThread.session.activeTurnId,
    });
  };

  const onModelSelect = (model: string) => {
    if (!activeThread) return;
    dispatch({
      type: "SET_THREAD_MODEL",
      threadId: activeThread.id,
      model: resolveModelSlug(model),
    });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void onSend(e as unknown as FormEvent);
    }
  };

  // Empty state: no active thread
  if (!activeThread) {
    return (
      <div className="flex flex-1 flex-col bg-background text-muted-foreground/60">
        <div className="drag-region h-[52px] shrink-0" />
        <div className="flex flex-1 items-center justify-center">
          <div className="text-center">
            <p className="text-sm">
              Select a thread or create a new one to get started.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col bg-background">
      {/* Top bar */}
      <header className="drag-region flex items-center justify-between border-b px-5 pt-[28px] pb-3">
        <div className="flex items-center gap-3">
          <h2 className="text-sm font-medium text-foreground">
            {activeThread.title}
          </h2>
          {activeProject && (
            <span className="rounded-full bg-accent px-2 py-0.5 text-[10px] text-muted-foreground/70">
              {activeProject.name}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          {/* Status indicator */}
          <div
            className={`inline-flex items-center gap-2 rounded-full border px-2.5 py-1 text-[10px] ${
              phase === "running"
                ? "border-sky-400/35 bg-sky-500/8 text-sky-700 dark:text-sky-100"
                : phase === "connecting"
                  ? "border-amber-400/35 bg-amber-500/8 text-amber-700 dark:text-amber-100"
                  : phase === "ready"
                    ? "border-emerald-400/35 bg-emerald-500/8 text-emerald-700 dark:text-emerald-100"
                    : "border-border bg-secondary text-muted-foreground"
            }`}
          >
            <span className="relative inline-flex h-2.5 w-2.5">
              {(phase === "running" || phase === "connecting") && (
                <span
                  className={`absolute inline-flex h-full w-full animate-ping rounded-full ${
                    phase === "running" ? "bg-sky-300/70" : "bg-amber-300/70"
                  }`}
                />
              )}
              <span
                className={`relative inline-flex h-2.5 w-2.5 rounded-full ${
                  phase === "running"
                    ? "bg-sky-200"
                    : phase === "connecting"
                      ? "bg-amber-200"
                      : phase === "ready"
                        ? "bg-emerald-200"
                        : "bg-muted-foreground/40"
                }`}
              />
            </span>
            <span>{statusLabel(phase)}</span>
          </div>
          {/* Diff toggle */}
          <button
            type="button"
            className={`rounded-md px-2 py-1 text-[10px] transition-colors duration-150 ${
              state.diffOpen
                ? "bg-accent text-accent-foreground"
                : "text-muted-foreground/60 hover:text-muted-foreground"
            }`}
            onClick={() => dispatch({ type: "TOGGLE_DIFF" })}
          >
            Diff
          </button>
        </div>
      </header>

      {/* Error banner */}
      {activeThread.error && (
        <div className="mx-4 mt-3 rounded-lg border border-destructive/20 bg-destructive/10 px-3 py-2 text-xs text-destructive-foreground">
          {activeThread.error}
        </div>
      )}

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-5 py-4">
        {activeThread.messages.length === 0 && !isWorking ? (
          <div className="flex h-full items-center justify-center">
            <p className="text-sm text-muted-foreground/40">
              Send a message to start the conversation.
            </p>
          </div>
        ) : (
          <div className="mx-auto max-w-3xl space-y-4">
            {timelineEntries.map((timelineEntry) =>
              timelineEntry.kind === "work" ? (
                <div
                  key={timelineEntry.id}
                  className="border-l-2 border-border/60 pl-4 py-1"
                >
                  <p
                    className={`py-[2px] text-[12px] leading-relaxed ${workToneClass(timelineEntry.entry.tone)}`}
                  >
                    {timelineEntry.entry.detail ? (
                      <>
                        {timelineEntry.entry.label}
                        <span className="ml-1.5 font-mono text-[11px] opacity-60">
                          {timelineEntry.entry.detail}
                        </span>
                      </>
                    ) : (
                      timelineEntry.entry.label
                    )}
                  </p>
                </div>
              ) : (
                <div key={timelineEntry.id}>
                  {timelineEntry.message.role === "user" ? (
                    <div className="flex justify-end">
                      <div className="max-w-[80%] rounded-2xl rounded-br-sm border border-border bg-accent px-4 py-3">
                        <pre className="whitespace-pre-wrap wrap-break-word font-mono text-sm leading-relaxed text-foreground">
                          {timelineEntry.message.text}
                        </pre>
                        <p className="mt-1.5 text-right text-[10px] text-muted-foreground/40">
                          {formatTimestamp(timelineEntry.message.createdAt)}
                        </p>
                      </div>
                    </div>
                  ) : (
                    <div className="border-l-2 border-border pl-4">
                      <ChatMarkdown
                        text={
                          timelineEntry.message.text ||
                          (timelineEntry.message.streaming
                            ? ""
                            : "(empty response)")
                        }
                      />
                      {timelineEntry.message.streaming && (
                        <div className="pt-1.5">
                          <span className="inline-flex items-center gap-2 rounded-full border border-sky-400/25 bg-sky-500/8 px-2 py-0.5 text-[10px] text-sky-700/90 dark:text-sky-100/90">
                            <span className="inline-flex gap-1">
                              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-sky-500/80 dark:bg-sky-100/80" />
                              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-sky-500/80 dark:bg-sky-100/80 [animation-delay:150ms]" />
                              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-sky-500/80 dark:bg-sky-100/80 [animation-delay:300ms]" />
                            </span>
                            <span>Thinking</span>
                          </span>
                        </div>
                      )}
                      <p className="mt-1.5 text-[10px] text-muted-foreground/40">
                        {formatMessageMeta(
                          timelineEntry.message.createdAt,
                          timelineEntry.message.streaming
                            ? formatElapsed(
                                timelineEntry.message.createdAt,
                                nowIso,
                              )
                            : formatElapsed(
                                timelineEntry.message.createdAt,
                                assistantCompletionByItemId.get(
                                  timelineEntry.message.id,
                                ),
                              ),
                        )}
                      </p>
                    </div>
                  )}
                </div>
              ),
            )}
            {isWorking && (
              <div className="border-l-2 border-border/60 pl-4 py-1">
                <div className="flex items-center pt-1">
                  <span className="inline-flex items-center gap-[3px]">
                    <span className="h-1 w-1 rounded-full bg-foreground/20 animate-pulse" />
                    <span className="h-1 w-1 rounded-full bg-foreground/20 animate-pulse [animation-delay:200ms]" />
                    <span className="h-1 w-1 rounded-full bg-foreground/20 animate-pulse [animation-delay:400ms]" />
                  </span>
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>
        )}
      </div>

      {/* Input bar */}
      <div className="px-5 pb-4 pt-2">
        <form onSubmit={onSend} className="mx-auto max-w-3xl">
          <InputGroup className="rounded-[20px] before:rounded-[19px] **:[textarea]:max-h-[200px]">
            <InputGroupTextarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder={
                phase === "disconnected"
                  ? "Ask for follow-up changes"
                  : "Ask anything..."
              }
              disabled={isSending || isConnecting}
              rows={2}
              className="font-sans!"
            />
            <InputGroupAddon align="block-end">
              {/* Model picker */}
              <Select
                value={selectedModel}
                onValueChange={(val) => val && onModelSelect(val)}
              >
                <SelectTrigger
                  size="sm"
                  className="w-auto min-w-0 border-0 shadow-none bg-transparent dark:bg-transparent before:hidden data-[popup-open]:bg-accent dark:data-[popup-open]:bg-accent"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup side="top" align="start">
                  {modelOptions.map((model) => (
                    <SelectItem key={model} value={model}>
                      {model}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>

              {/* Reasoning effort */}
              <Select
                value={selectedEffort}
                onValueChange={(val) => val && setSelectedEffort(val)}
              >
                <SelectTrigger
                  size="sm"
                  className="w-auto min-w-0 border-0 shadow-none bg-transparent dark:bg-transparent before:hidden data-[popup-open]:bg-accent dark:data-[popup-open]:bg-accent capitalize"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup side="top" align="start">
                  {REASONING_OPTIONS.map((effort) => (
                    <SelectItem key={effort} value={effort}>
                      {effort.charAt(0).toUpperCase() + effort.slice(1)}
                      {effort === DEFAULT_REASONING ? " (default)" : ""}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>

              {activeProject && (
                <InputGroupText className="ml-auto text-muted-foreground/40">
                  {activeProject.name}
                </InputGroupText>
              )}

              {phase === "running" ? (
                <Button
                  variant="destructive"
                  size="icon-sm"
                  className="rounded-full"
                  onClick={() => void onInterrupt()}
                  aria-label="Stop generation"
                >
                  <SquareIcon className="size-3" />
                </Button>
              ) : (
                <Button
                  type="submit"
                  size="icon-sm"
                  className="rounded-full"
                  disabled={isSending || isConnecting || !prompt.trim()}
                  aria-label={
                    isConnecting
                      ? "Connecting"
                      : isSending
                        ? "Sending"
                        : "Send message"
                  }
                >
                  {isConnecting || isSending ? (
                    <LoaderCircleIcon className="animate-spin" />
                  ) : (
                    <ArrowUpIcon />
                  )}
                </Button>
              )}
            </InputGroupAddon>
          </InputGroup>
        </form>
      </div>
    </div>
  );
}
