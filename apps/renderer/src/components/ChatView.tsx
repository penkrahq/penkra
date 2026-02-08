import type { ProviderModel } from "@acme/contracts";
import {
  type FormEvent,
  type KeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { derivePhase, formatTimestamp, readNativeApi } from "../session-logic";
import { useStore } from "../store";

const DEFAULT_MODEL = "gpt-5.2-codex";

export default function ChatView() {
  const { state, dispatch } = useStore();
  const api = useMemo(() => readNativeApi(), []);
  const [prompt, setPrompt] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isModelMenuOpen, setIsModelMenuOpen] = useState(false);
  const [isLoadingModels, setIsLoadingModels] = useState(false);
  const [modelLoadError, setModelLoadError] = useState<string | null>(null);
  const [availableModels, setAvailableModels] = useState<ProviderModel[]>([]);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const modelMenuRef = useRef<HTMLDivElement>(null);

  const activeThread = state.threads.find((t) => t.id === state.activeThreadId);
  const activeProject = state.projects.find(
    (p) => p.id === activeThread?.projectId,
  );
  const selectedModel =
    activeThread?.model || activeProject?.model || DEFAULT_MODEL;
  const phase = derivePhase(activeThread?.session ?? null);
  const modelOptions = useMemo(() => {
    const deduped = new Map<string, ProviderModel>();
    for (const model of availableModels) {
      deduped.set(model.model, model);
    }
    if (!deduped.has(selectedModel)) {
      deduped.set(selectedModel, {
        id: selectedModel,
        model: selectedModel,
        displayName: selectedModel,
        description: "Current model for this thread.",
      });
    }
    return Array.from(deduped.values());
  }, [availableModels, selectedModel]);

  // Auto-scroll on new messages
  const messageCount = activeThread?.messages.length ?? 0;
  // biome-ignore lint/correctness/useExhaustiveDependencies: trigger on message count change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messageCount]);

  // Auto-resize textarea
  // biome-ignore lint/correctness/useExhaustiveDependencies: trigger on prompt change
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
  }, [prompt]);

  useEffect(() => {
    if (!isModelMenuOpen) return;

    const handleClickOutside = (event: MouseEvent) => {
      if (!modelMenuRef.current) return;
      if (
        event.target instanceof Node &&
        !modelMenuRef.current.contains(event.target)
      ) {
        setIsModelMenuOpen(false);
      }
    };

    window.addEventListener("mousedown", handleClickOutside);
    return () => {
      window.removeEventListener("mousedown", handleClickOutside);
    };
  }, [isModelMenuOpen]);

  useEffect(() => {
    if (!api || !state.activeThreadId) return;

    let cancelled = false;

    const loadModels = async () => {
      setIsLoadingModels(true);
      setModelLoadError(null);
      try {
        const models = await api.providers.listModels(
          activeProject?.cwd ? { cwd: activeProject.cwd } : undefined,
        );
        if (cancelled) return;

        const sorted = [...models].sort((a, b) => {
          if ((a.isDefault ?? false) && !(b.isDefault ?? false)) return -1;
          if ((b.isDefault ?? false) && !(a.isDefault ?? false)) return 1;
          return a.displayName.localeCompare(b.displayName);
        });
        setAvailableModels(sorted);
      } catch (err) {
        if (cancelled) return;
        setAvailableModels([]);
        setModelLoadError(
          err instanceof Error
            ? err.message
            : "Could not load available models from Codex.",
        );
      } finally {
        if (!cancelled) {
          setIsLoadingModels(false);
        }
      }
    };

    void loadModels();

    return () => {
      cancelled = true;
    };
  }, [api, activeProject?.cwd, state.activeThreadId]);

  const ensureSession = async (): Promise<boolean> => {
    if (!api || !activeThread || !activeProject) return false;
    if (activeThread.session && activeThread.session.status !== "closed")
      return true;

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
      return true;
    } catch (err) {
      dispatch({
        type: "SET_ERROR",
        threadId: activeThread.id,
        error: err instanceof Error ? err.message : "Failed to connect.",
      });
      return false;
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

    const connected = await ensureSession();
    if (!connected) return;

    // Re-read thread to get session after potential connection
    const updatedThread = state.threads.find((t) => t.id === activeThread.id);
    const sessionId =
      updatedThread?.session?.sessionId ?? activeThread.session?.sessionId;
    if (!sessionId) return;

    setIsSending(true);
    try {
      await api.providers.sendTurn({
        sessionId,
        input: trimmed,
        model: selectedModel || undefined,
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
      model,
    });
    setIsModelMenuOpen(false);
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
      <div className="flex flex-1 flex-col bg-[#0c0c0c] text-[#a0a0a0]/40">
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
    <div className="flex flex-1 flex-col bg-[#0c0c0c]">
      {/* Top bar */}
      <header className="drag-region flex items-center justify-between border-b border-white/[0.08] px-5 pt-[28px] pb-3">
        <div className="flex items-center gap-3">
          <h2 className="text-sm font-medium text-[#e0e0e0]">
            {activeThread.title}
          </h2>
          {activeProject && (
            <span className="rounded-full bg-white/[0.06] px-2 py-0.5 text-[10px] text-[#a0a0a0]/50">
              {activeProject.name}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          {/* Status indicator */}
          <div className="flex items-center gap-1.5">
            <div
              className={`h-2 w-2 rounded-full ${
                phase === "running"
                  ? "animate-pulse bg-emerald-400"
                  : phase === "ready"
                    ? "bg-emerald-400"
                    : phase === "connecting"
                      ? "animate-pulse bg-amber-400"
                      : "bg-[#a0a0a0]/30"
              }`}
            />
            <span className="text-[10px] text-[#a0a0a0]/50">{phase}</span>
          </div>
          {/* Diff toggle */}
          <button
            type="button"
            className={`rounded-md px-2 py-1 text-[10px] transition-colors duration-150 ${
              state.diffOpen
                ? "bg-white/10 text-white"
                : "text-[#a0a0a0]/40 hover:text-[#a0a0a0]/60"
            }`}
            onClick={() => dispatch({ type: "TOGGLE_DIFF" })}
          >
            Diff
          </button>
        </div>
      </header>

      {/* Error banner */}
      {activeThread.error && (
        <div className="mx-4 mt-3 rounded-lg border border-rose-400/20 bg-rose-900/20 px-3 py-2 text-xs text-rose-200">
          {activeThread.error}
        </div>
      )}

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-5 py-4">
        {activeThread.messages.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <p className="text-sm text-[#a0a0a0]/30">
              Send a message to start the conversation.
            </p>
          </div>
        ) : (
          <div className="mx-auto max-w-3xl space-y-4">
            {activeThread.messages.map((msg) => (
              <div key={msg.id}>
                {msg.role === "user" ? (
                  <div className="flex justify-end">
                    <div className="max-w-[80%] rounded-2xl rounded-br-sm border border-white/[0.08] bg-white/[0.05] px-4 py-3">
                      <pre className="whitespace-pre-wrap break-words font-mono text-sm leading-relaxed text-[#e0e0e0]">
                        {msg.text}
                      </pre>
                      <p className="mt-1.5 text-right text-[10px] text-[#a0a0a0]/30">
                        {formatTimestamp(msg.createdAt)}
                      </p>
                    </div>
                  </div>
                ) : (
                  <div className="border-l-2 border-white/[0.15] pl-4">
                    <pre className="whitespace-pre-wrap break-words font-mono text-sm leading-relaxed text-[#d0d0d0]">
                      {msg.text || (msg.streaming ? "" : "(empty response)")}
                    </pre>
                    {msg.streaming && (
                      <span className="inline-flex gap-1 pt-1">
                        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white/50" />
                        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white/50 [animation-delay:150ms]" />
                        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white/50 [animation-delay:300ms]" />
                      </span>
                    )}
                    {!msg.streaming && (
                      <p className="mt-1.5 text-[10px] text-[#a0a0a0]/30">
                        {formatTimestamp(msg.createdAt)}
                      </p>
                    )}
                  </div>
                )}
              </div>
            ))}
            <div ref={messagesEndRef} />
          </div>
        )}
      </div>

      {/* Input bar */}
      <div className="border-t border-white/[0.08] px-5 py-3">
        <form
          onSubmit={onSend}
          className="mx-auto flex max-w-3xl items-end gap-2"
        >
          <div className="flex-1 rounded-2xl border border-white/[0.1] bg-[#121214] px-3 py-3">
            <textarea
              ref={textareaRef}
              className="w-full resize-none bg-transparent px-1 pb-1 font-mono text-sm text-[#e0e0e0] placeholder:text-[#a0a0a0]/30 focus:outline-none"
              rows={1}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder={
                phase === "disconnected"
                  ? "Type a message (session auto-connects)..."
                  : "Type a message..."
              }
              disabled={isSending || isConnecting}
            />
            <div className="mt-2 flex items-center justify-between gap-2">
              <div className="relative" ref={modelMenuRef}>
                <button
                  type="button"
                  className="inline-flex items-center gap-2 rounded-full border border-white/[0.1] bg-white/[0.04] px-3 py-1.5 text-xs text-[#d8d8d8] transition-colors duration-150 hover:bg-white/[0.08]"
                  onClick={() => setIsModelMenuOpen((open) => !open)}
                >
                  <span className="max-w-[180px] truncate">
                    {selectedModel}
                  </span>
                  <span className="text-[10px] text-[#a0a0a0]/70">▼</span>
                </button>
                {isModelMenuOpen && (
                  <div className="absolute bottom-full left-0 z-20 mb-2 w-[340px] rounded-2xl border border-white/[0.1] bg-[#1b1b1d]/95 p-2 shadow-[0_16px_40px_rgba(0,0,0,0.55)] backdrop-blur">
                    <p className="px-2 py-1 text-[11px] text-[#a0a0a0]/70">
                      Select model
                    </p>
                    <div className="max-h-72 overflow-y-auto">
                      {modelOptions.map((model) => {
                        const isSelected = model.model === selectedModel;
                        return (
                          <button
                            key={model.id}
                            type="button"
                            className={`mb-0.5 flex w-full items-start justify-between gap-2 rounded-xl px-2 py-2 text-left transition-colors duration-150 ${
                              isSelected
                                ? "bg-white/[0.08] text-white"
                                : "text-[#d4d4d4] hover:bg-white/[0.05]"
                            }`}
                            onClick={() => onModelSelect(model.model)}
                          >
                            <span className="min-w-0">
                              <span className="block truncate text-sm">
                                {model.displayName}
                              </span>
                              {model.description && (
                                <span className="block pt-0.5 text-[10px] text-[#a0a0a0]/65">
                                  {model.description}
                                </span>
                              )}
                            </span>
                            <span
                              className={`pt-0.5 text-sm ${
                                isSelected ? "text-white" : "text-transparent"
                              }`}
                            >
                              ✓
                            </span>
                          </button>
                        );
                      })}
                    </div>
                    {isLoadingModels && (
                      <p className="px-2 pt-2 text-[10px] text-[#a0a0a0]/60">
                        Refreshing available models...
                      </p>
                    )}
                    {modelLoadError && (
                      <p className="px-2 pt-2 text-[10px] text-amber-200/80">
                        Could not load full model list from Codex:{" "}
                        {modelLoadError}
                      </p>
                    )}
                  </div>
                )}
              </div>
              {activeProject && (
                <span className="text-[10px] text-[#a0a0a0]/35">
                  {activeProject.name}
                </span>
              )}
            </div>
          </div>
          {phase === "running" ? (
            <button
              type="button"
              className="shrink-0 rounded-xl bg-rose-600/80 px-4 py-3 text-xs font-medium text-white transition-colors duration-150 hover:bg-rose-600"
              onClick={() => void onInterrupt()}
            >
              Stop
            </button>
          ) : (
            <button
              type="submit"
              className="shrink-0 rounded-xl bg-white px-4 py-3 text-xs font-medium text-[#0c0c0c] transition-colors duration-150 hover:bg-white/90 disabled:opacity-40"
              disabled={isSending || isConnecting || !prompt.trim()}
            >
              {isConnecting
                ? "Connecting..."
                : isSending
                  ? "Sending..."
                  : "Send"}
            </button>
          )}
        </form>
      </div>
    </div>
  );
}
