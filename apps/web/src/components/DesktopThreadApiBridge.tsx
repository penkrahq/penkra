// FILE: DesktopThreadApiBridge.tsx
// Purpose: Implements current-Thread read, compose, and receipt-bound send for Apps.
// Layer: Trusted Penkra shell renderer

import {
  FolderId,
  ThreadDeckId,
  ThreadId,
  singletonThreadDeckId,
  type ModelSelection,
  type ProviderKind,
} from "@penkra/contracts";
import { useEffect } from "react";
import { useNavigate } from "@tanstack/react-router";

import { resolveAssistantDeliveryMode, useAppSettings } from "../appSettings";
import { useComposerDraftStore } from "../composerDraftStore";
import {
  getDesktopThreadLiveHandlers,
  requireDesktopThreadLiveHandlers,
  subscribeDesktopThreadLiveStateChanges,
} from "../desktopThreadApiBroker";
import { useProviderStatusesForLocalConfig } from "../hooks/useProviderStatusesForLocalConfig";
import { useProviderModelCatalog } from "../hooks/useProviderModelCatalog";
import { useRefreshProviderStatusesNow } from "../hooks/useProviderStatusRefresh";
import { createPastedTextDraft } from "../lib/composerPastedText";
import { deriveUnmountedThreadLiveState } from "../lib/desktopThreadState";
import { resolveProviderSendAvailabilityWithRefresh } from "../lib/providerAvailability";
import { newCommandId, newThreadId } from "../lib/utils";
import { dispatchQueuedComposerTurn } from "../lib/queuedComposerTurnDispatch";
import { findNearestVisibleDeckThread } from "../lib/threadDeckNavigation";
import { readNativeApi } from "../nativeApi";
import { useStore } from "../store";
import { composerConflictCode } from "./desktopThreadApiTarget";

const RECEIPT_TTL_MS = 10 * 60_000;
const RECEIPT_STORAGE_KEY = "penkra.app-thread-composition-receipts.v1";

interface CompositionReceipt {
  appId: string;
  spaceId: string;
  deckId: string;
  tabId: string;
  threadId: string;
  fingerprint: string;
  text: string;
  createdAt: number;
  expiresAt: number;
  result?: import("@penkra/sdk").AppThreadSendReceipt;
  queuedTurnId?: string;
  sending?: Promise<import("@penkra/sdk").AppThreadSendReceipt>;
}

const receipts = new Map<string, CompositionReceipt>();
const stateClocks = new Map<string, { fingerprint: string; updatedAt: string }>();
const publishedDeckFingerprints = new Map<string, string>();
let receiptsHydrated = false;

export function DesktopThreadApiBridge() {
  const navigate = useNavigate();
  const { settings } = useAppSettings();
  const assistantDeliveryMode = resolveAssistantDeliveryMode(settings);
  const statuses = useProviderStatusesForLocalConfig();
  const refreshStatuses = useRefreshProviderStatusesNow();
  const { modelOptionsByProvider } = useProviderModelCatalog({
    selectedProvider: "codex",
    discoveryEnabled: true,
    prefetchProviders: ["codex", "claudeAgent", "opencode"],
  });

  useEffect(() => {
    const bridge = window.desktopBridge?.threadApi;
    if (!bridge) return;
    let disposed = false;
    let scheduled = false;
    const publish = () => {
      scheduled = false;
      if (disposed) return;
      const state = useStore.getState();
      for (const deck of state.decks) {
        try {
          const threads = readDeckStates(deck.id);
          const fingerprint = JSON.stringify(threads);
          if (publishedDeckFingerprints.get(deck.id) === fingerprint) continue;
          publishedDeckFingerprints.set(deck.id, fingerprint);
          bridge.publishState({
            spaceId: deck.spaceId,
            deckId: deck.id,
            threads,
          });
        } catch {
          // Projection batches can briefly remove a member before replacing its deck.
        }
      }
    };
    const schedule = () => {
      if (scheduled || disposed) return;
      scheduled = true;
      queueMicrotask(publish);
    };
    const unsubscribeStore = useStore.subscribe(schedule);
    const unsubscribeDrafts = useComposerDraftStore.subscribe(schedule);
    const unsubscribeLive = subscribeDesktopThreadLiveStateChanges(schedule);
    schedule();
    return () => {
      disposed = true;
      unsubscribeStore();
      unsubscribeDrafts();
      unsubscribeLive();
    };
  }, []);

  useEffect(() => {
    hydrateReceipts();
    const bridge = window.desktopBridge?.threadApi;
    if (!bridge) return;
    return bridge.onRequest((request) => {
      void handle(request).then(
        (result) => bridge.respond({ id: request.id, ok: true, result }),
        (error: unknown) =>
          bridge.respond({
            id: request.id,
            ok: false,
            code: errorCode(error),
            message: error instanceof Error ? error.message : String(error),
          }),
      );
    });

    async function handle(request: import("@penkra/contracts").DesktopThreadApiRequest) {
      discardExpiredReceipts();
      if (request.method === "current.read") {
        requireDeckMember(request.deckId, request.threadId);
        return readState(request.threadId);
      }
      if (request.method === "list") {
        return readDeckStates(request.deckId);
      }
      if (request.method === "get") {
        requireDeckMember(request.deckId, request.input.threadId);
        return readState(request.input.threadId);
      }
      if (request.method === "compose") return compose(request);
      if (request.method === "send") return send(request);
      if (request.method === "select") {
        requireDeckMember(request.deckId, request.input.threadId);
        await selectThread(request.input.threadId);
        return;
      }
      if (request.method === "create") return create(request);
      if (request.method === "add" || request.method === "reorder") {
        return move(request);
      }
      if (request.method === "leave") return leave(request);
      return archive(request);
    }

    async function compose(
      request: Extract<import("@penkra/contracts").DesktopThreadApiRequest, { method: "compose" }>,
    ) {
      if (request.input === undefined) {
        throw Object.assign(new Error("A composition input is required."), {
          code: "COMPOSITION_INPUT_REQUIRED",
        });
      }
      const input = request.input;
      requireDeckMember(request.deckId, input.threadId);
      const threadId = ThreadId.makeUnsafe(input.threadId);
      const before = readState(threadId);
      const code = composerConflictCode(before);
      if (code) {
        throw Object.assign(new Error("The current Thread is not available for App composition."), {
          code,
        });
      }

      const store = useComposerDraftStore.getState();
      let resolvedModel: {
        provider: string;
        model: string;
        options?: Record<string, unknown>;
      } | null = null;
      for (const candidate of input.model ?? []) {
        const provider = candidate.provider as ProviderKind;
        if (!statuses.some((status) => status.provider === provider)) continue;
        if (!modelOptionsByProvider[provider]?.some((model) => model.slug === candidate.model)) {
          continue;
        }
        const availability = await resolveProviderSendAvailabilityWithRefresh({
          provider,
          statuses,
          refreshStatuses: () => refreshStatuses({ silent: true }),
        });
        if (!availability.usable) continue;
        const options = input.effort
          ? { ...(candidate.options ?? {}), reasoningEffort: input.effort }
          : candidate.options;
        const selection = {
          provider,
          model: candidate.model,
          ...(options === undefined ? {} : { options }),
        } as ModelSelection;
        store.setModelSelectionAndSticky(threadId, selection);
        resolvedModel = candidate;
        break;
      }
      if (input.text !== undefined) store.setPrompt(threadId, input.text);
      if (input.documents?.length) {
        store.addPastedTexts(
          threadId,
          input.documents.map((document) =>
            createPastedTextDraft({
              id: crypto.randomUUID(),
              createdAt: new Date().toISOString(),
              title: document.title,
              text: document.content,
            }),
          ),
        );
      }
      if (input.skills?.length) store.setSkills(threadId, input.skills);
      if (input.files?.length) {
        store.addFiles(
          threadId,
          input.files.map((attachment) => {
            const file = new File([attachmentBytes(attachment.bytes)], attachment.name, {
              type: attachment.mimeType,
            });
            return {
              type: "file" as const,
              id: crypto.randomUUID(),
              name: attachment.name,
              mimeType: attachment.mimeType,
              sizeBytes: file.size,
              file,
            };
          }),
        );
      }
      if (input.images?.length) {
        store.addImages(
          threadId,
          input.images.map((attachment) => {
            const file = new File([attachmentBytes(attachment.bytes)], attachment.name, {
              type: attachment.mimeType,
            });
            return {
              type: "image" as const,
              id: crypto.randomUUID(),
              name: attachment.name,
              mimeType: attachment.mimeType,
              sizeBytes: file.size,
              previewUrl: URL.createObjectURL(file),
              file,
            };
          }),
        );
      }

      const draft = requireDraft(threadId);
      if (!hasComposerContent(draft)) {
        throw Object.assign(new Error("A composition must contain sendable content."), {
          code: "COMPOSITION_EMPTY",
        });
      }
      const composeId = crypto.randomUUID();
      const createdAt = Date.now();
      const expiresAt = Date.now() + RECEIPT_TTL_MS;
      receipts.set(composeId, {
        appId: request.appId,
        spaceId: request.spaceId,
        deckId: request.deckId,
        tabId: request.tabId,
        threadId,
        fingerprint: draftFingerprint(draft),
        text: draft.prompt,
        createdAt,
        expiresAt,
      });
      persistReceipts();
      return {
        composeId,
        threadId,
        createdAt: new Date(createdAt).toISOString(),
        expiresAt: new Date(expiresAt).toISOString(),
        resolvedModel,
      };
    }

    async function send(
      request: Extract<import("@penkra/contracts").DesktopThreadApiRequest, { method: "send" }>,
    ) {
      const receipt = receipts.get(request.input.composeId);
      if (
        !receipt ||
        receipt.appId !== request.appId ||
        receipt.spaceId !== request.spaceId ||
        receipt.deckId !== request.deckId ||
        receipt.tabId !== request.tabId ||
        !isDeckMember(request.deckId, receipt.threadId)
      ) {
        throw Object.assign(new Error("The composition receipt is invalid for this App Thread."), {
          code: "COMPOSITION_RECEIPT_INVALID",
        });
      }
      if (receipt.result) return receipt.result;
      if (receipt.sending) return receipt.sending;
      if (receipt.expiresAt <= Date.now()) {
        receipts.delete(request.input.composeId);
        persistReceipts();
        throw Object.assign(new Error("The composition receipt has expired."), {
          code: "COMPOSITION_RECEIPT_EXPIRED",
        });
      }
      const threadId = ThreadId.makeUnsafe(receipt.threadId);
      const draft = requireDraft(threadId);
      let queuedTurn = receipt.queuedTurnId
        ? draft.queuedTurns.find((candidate) => candidate.id === receipt.queuedTurnId)
        : undefined;
      if (!queuedTurn && draftFingerprint(draft) !== receipt.fingerprint) {
        throw Object.assign(
          new Error("The staged composition changed after its receipt was issued."),
          {
            code: "COMPOSITION_CHANGED",
          },
        );
      }
      const before = readState(receipt.threadId);
      if (before.pendingQuestion) {
        throw Object.assign(new Error("The current Thread is waiting for a human answer."), {
          code: "THREAD_WAITING_FOR_USER",
        });
      }
      const mode = request.input.mode ?? "queue";
      const busy = before.phase !== "idle";
      const state = busy ? (mode === "steer" ? "steering" : "queued") : "accepted";
      const submissionId = crypto.randomUUID();
      const acceptedAt = new Date().toISOString();
      if (!queuedTurn) {
        const shell = requireDeckMember(receipt.deckId, receipt.threadId);
        const selectedProvider = draft.activeProvider ?? shell.modelSelection.provider;
        const modelSelection =
          draft.modelSelectionByProvider[selectedProvider] ??
          (shell.modelSelection.provider === selectedProvider ? shell.modelSelection : undefined);
        if (!modelSelection) {
          throw Object.assign(new Error("The staged composition has no selected model."), {
            code: "COMPOSITION_MODEL_REQUIRED",
          });
        }
        const effort = modelSelection.options
          ? "reasoningEffort" in modelSelection.options
            ? modelSelection.options.reasoningEffort
            : "effort" in modelSelection.options
              ? modelSelection.options.effort
              : undefined
          : undefined;
        const queuedTurnId = `app:${request.input.composeId}`;
        queuedTurn = {
          id: queuedTurnId,
          kind: "chat",
          createdAt: acceptedAt,
          dispatchMode: mode,
          previewText: draft.prompt || draft.pastedTexts[0]?.title || "App composition",
          prompt: draft.prompt,
          images: [...draft.images],
          files: [...draft.files],
          assistantSelections: [...draft.assistantSelections],
          terminalContexts: [...draft.terminalContexts],
          fileComments: [...draft.fileComments],
          pastedTexts: [...draft.pastedTexts],
          skills: [...draft.skills],
          mentions: [...draft.mentions],
          selectedProvider,
          selectedModel: modelSelection.model,
          selectedPromptEffort: typeof effort === "string" ? effort : null,
          modelSelection,
          connectionId: null,
          runtimeMode: draft.runtimeMode ?? shell.runtimeMode,
        };
        const draftStore = useComposerDraftStore.getState();
        draftStore.enqueueQueuedTurn(threadId, queuedTurn);
        draftStore.clearComposerContent(threadId, {
          preservePreviewUrls: true,
          preservePersistedAssets: true,
        });
        receipt.queuedTurnId = queuedTurnId;
        persistReceipts();
      }
      const targetTurn = queuedTurn;
      const api = readNativeApi();
      if (!api) {
        throw new Error("Thread sending is unavailable while disconnected.");
      }
      const sending = dispatchQueuedComposerTurn({
        api,
        threadId,
        queuedTurn: targetTurn,
        assistantDeliveryMode,
        persistDispatchAdmission: (attempt, bindingRevision) =>
          useComposerDraftStore
            .getState()
            .setQueuedTurnDispatchAdmission(threadId, targetTurn.id, attempt, bindingRevision),
      }).then(
        () => {
          useComposerDraftStore
            .getState()
            .markQueuedTurnServerAccepted(threadId, targetTurn.id, acceptedAt);
          const result = {
            submissionId,
            composeId: request.input.composeId,
            threadId: receipt.threadId,
            mode,
            state,
            acceptedAt,
          } as const;
          receipt.result = result;
          delete receipt.sending;
          persistReceipts();
          return result;
        },
        (error) => {
          delete receipt.sending;
          throw error;
        },
      );
      receipt.sending = sending;
      return sending;
    }

    async function selectThread(threadId: string): Promise<void> {
      await navigate({
        to: "/$threadId",
        params: { threadId: ThreadId.makeUnsafe(threadId) },
        search: (previous) => ({ ...previous, splitViewId: undefined }),
      });
      await waitForThreadMount(threadId);
    }

    async function create(
      request: Extract<import("@penkra/contracts").DesktopThreadApiRequest, { method: "create" }>,
    ): Promise<import("@penkra/sdk").AppThreadCreateResult> {
      const state = useStore.getState();
      const current = requireDeckMember(request.deckId, request.threadId);
      const folderId = FolderId.makeUnsafe(request.input.folderId ?? current.folderId);
      const folder = state.folders.find((candidate) => candidate.id === folderId);
      if (!folder || folder.spaceId !== request.spaceId) {
        throw Object.assign(new Error("The target folder is outside the current Space."), {
          code: "THREAD_ACCESS_DENIED",
        });
      }
      const title = request.input.title?.trim() || "New thread";
      const threadId = newThreadId();
      const api = readNativeApi();
      if (!api) throw new Error("Thread creation is unavailable while disconnected.");
      await api.orchestration.dispatchCommand({
        type: "thread.create",
        commandId: newCommandId(),
        threadId,
        deckId: current.deckId,
        folderId,
        title,
        modelSelection: current.modelSelection,
        runtimeMode: current.runtimeMode,
        workingDirectory: current.workingDirectory,
        createdAt: new Date().toISOString(),
      });
      if (request.input.select === true) await selectThread(threadId);
      return { threadId, deckId: current.deckId };
    }

    async function move(
      request: Extract<
        import("@penkra/contracts").DesktopThreadApiRequest,
        { method: "add" | "reorder" }
      >,
    ): Promise<void> {
      const target = requireSameSpaceThread(request.spaceId, request.input.threadId);
      if (request.method === "reorder" && target.deckId !== request.deckId) {
        throw Object.assign(new Error("Only a member of the current deck can be reordered."), {
          code: "THREAD_NOT_IN_DECK",
        });
      }
      const api = readNativeApi();
      if (!api) throw new Error("Thread Deck editing is unavailable while disconnected.");
      const position = request.input.position ?? { type: "end" as const };
      await api.orchestration.dispatchCommand({
        type: "thread.deck.move",
        commandId: newCommandId(),
        threadId: target.id,
        deckId: ThreadDeckId.makeUnsafe(request.deckId),
        position:
          position.type === "before" || position.type === "after"
            ? {
                type: position.type,
                threadId: ThreadId.makeUnsafe(position.threadId),
              }
            : position,
      });
    }

    async function leave(
      request: Extract<import("@penkra/contracts").DesktopThreadApiRequest, { method: "leave" }>,
    ): Promise<void> {
      const target = requireDeckMember(request.deckId, request.input.threadId);
      const api = readNativeApi();
      if (!api) throw new Error("Thread Deck editing is unavailable while disconnected.");
      await api.orchestration.dispatchCommand({
        type: "thread.deck.leave",
        commandId: newCommandId(),
        threadId: target.id,
        deckId: singletonThreadDeckId(target.id),
      });
    }

    async function archive(
      request: Extract<import("@penkra/contracts").DesktopThreadApiRequest, { method: "archive" }>,
    ): Promise<void> {
      const target = requireDeckMember(request.deckId, request.input.threadId);
      const deck = requireDeck(request.deckId);
      const visible = deck.threadIds.filter((id) => {
        const thread = useStore.getState().threadShellById?.[id];
        return thread && !thread.archivedAt && id !== target.id;
      });
      const api = readNativeApi();
      if (!api) throw new Error("Thread archiving is unavailable while disconnected.");
      await api.orchestration.dispatchCommand({
        type: "thread.archive",
        commandId: newCommandId(),
        threadId: target.id,
      });
      if (target.id === request.threadId) {
        const available = new Set(visible);
        const nearest = findNearestVisibleDeckThread({
          threadIds: deck.threadIds,
          removedThreadId: target.id,
          isVisible: (threadId) => available.has(threadId),
        });
        if (nearest) await selectThread(nearest);
        else await navigate({ to: "/" });
      }
    }
  }, [assistantDeliveryMode, modelOptionsByProvider, navigate, refreshStatuses, statuses]);

  return null;
}

async function waitForThreadMount(threadId: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      requireDesktopThreadLiveHandlers(threadId);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw Object.assign(new Error("The linked Thread did not become available."), {
    code: "THREAD_NAVIGATION_FAILED",
  });
}

function readDeckStates(deckId: string): ReadonlyArray<import("@penkra/sdk").AppThreadState> {
  return requireDeck(deckId).threadIds.map((threadId) => readState(threadId));
}

function readState(threadId: string): import("@penkra/sdk").AppThreadState {
  const typedThreadId = ThreadId.makeUnsafe(threadId);
  const store = useStore.getState();
  const shell = store.threadShellById?.[typedThreadId];
  if (!shell) {
    throw Object.assign(new Error("The Thread is unavailable."), {
      code: "THREAD_NOT_FOUND",
    });
  }
  const draft = useComposerDraftStore.getState().draftsByThreadId[ThreadId.makeUnsafe(threadId)];
  const live =
    getDesktopThreadLiveHandlers(threadId)?.read() ??
    deriveUnmountedThreadLiveState(
      threadId,
      store.sidebarThreadSummaryById[threadId],
      draft?.queuedTurns.length ?? 0,
    );
  const empty = !draft || !hasComposerContent(draft);
  const pendingQueuedTurns =
    draft?.queuedTurns.filter((queuedTurn) => queuedTurn.serverAcceptedAt === undefined) ?? [];
  const fingerprint = draft ? draftFingerprint(draft) : null;
  const appComposition = empty
    ? undefined
    : [...receipts.entries()].find(
        ([, receipt]) =>
          receipt.threadId === threadId &&
          receipt.expiresAt > Date.now() &&
          !receipt.result &&
          receipt.fingerprint === fingerprint,
      );
  const state: Omit<import("@penkra/sdk").AppThreadState, "updatedAt"> = {
    threadId,
    deckId: shell.deckId,
    title: shell.title,
    order: shell.deckSortOrder,
    archived: shell.archivedAt != null,
    phase:
      live?.phase ??
      (shell.hasPendingUserInput
        ? "waiting"
        : shell.error
          ? "failed"
          : shell.workStatus === "running"
            ? "running"
            : "idle"),
    activeTurnId:
      live?.activeTurnId ??
      useStore.getState().threadSessionById?.[typedThreadId]?.activeTurnId ??
      null,
    pendingQuestion: live?.pendingUserInput ?? shell.hasPendingUserInput === true,
    composer: {
      empty,
      owner: empty ? "none" : appComposition ? "app" : "human",
      composeId: appComposition?.[0] ?? null,
    },
    queued: {
      count: live?.queuedCount ?? pendingQueuedTurns.length,
      hasAppSubmission: [...receipts.values()].some(
        (receipt) =>
          receipt.threadId === threadId &&
          (receipt.result?.state === "queued" ||
            (receipt.queuedTurnId !== undefined &&
              pendingQueuedTurns.some((queuedTurn) => queuedTurn.id === receipt.queuedTurnId))),
      ),
    },
    steering: {
      pending: live?.steeringPending ?? false,
      hasAppSubmission: [...receipts.values()].some(
        (receipt) => receipt.threadId === threadId && receipt.result?.state === "steering",
      ),
    },
  };
  const stateFingerprint = JSON.stringify(state);
  const previous = stateClocks.get(threadId);
  const updatedAt =
    previous?.fingerprint === stateFingerprint ? previous.updatedAt : new Date().toISOString();
  stateClocks.set(threadId, { fingerprint: stateFingerprint, updatedAt });
  return { ...state, updatedAt };
}

function requireDeck(deckId: string) {
  const deck = useStore.getState().decks.find((candidate) => candidate.id === deckId);
  if (!deck) {
    throw Object.assign(new Error("The Thread Deck is unavailable."), {
      code: "THREAD_DECK_NOT_FOUND",
    });
  }
  return deck;
}

function isDeckMember(deckId: string, threadId: string): boolean {
  return requireDeck(deckId).threadIds.includes(ThreadId.makeUnsafe(threadId));
}

function requireDeckMember(deckId: string, threadId: string) {
  const typedThreadId = ThreadId.makeUnsafe(threadId);
  const thread = useStore.getState().threadShellById?.[typedThreadId];
  if (!thread || thread.deckId !== deckId) {
    throw Object.assign(new Error("The Thread is not a member of this deck."), {
      code: "THREAD_NOT_IN_DECK",
    });
  }
  return thread;
}

function requireSameSpaceThread(spaceId: string, threadId: string) {
  const typedThreadId = ThreadId.makeUnsafe(threadId);
  const state = useStore.getState();
  const thread = state.threadShellById?.[typedThreadId];
  const threadSpaceId =
    thread?.spaceId ?? state.folders.find((folder) => folder.id === thread?.folderId)?.spaceId;
  if (!thread || threadSpaceId !== spaceId) {
    throw Object.assign(new Error("The Thread is outside the current Space."), {
      code: "THREAD_ACCESS_DENIED",
    });
  }
  return thread;
}

function requireDraft(threadId: import("@penkra/contracts").ThreadId) {
  const draft = useComposerDraftStore.getState().draftsByThreadId[threadId];
  if (!draft)
    throw Object.assign(new Error("The current Thread has no composition."), {
      code: "COMPOSITION_EMPTY",
    });
  return draft;
}

function hasComposerContent(
  draft: import("../composerDraftDomain").ComposerThreadDraftState,
): boolean {
  return Boolean(
    draft.prompt ||
    draft.pastedTexts.length ||
    draft.files.length ||
    draft.images.length ||
    draft.skills.length ||
    draft.mentions.length ||
    draft.assistantSelections.length ||
    draft.fileComments.length ||
    draft.terminalContexts.length,
  );
}

function draftFingerprint(
  draft: import("../composerDraftDomain").ComposerThreadDraftState,
): string {
  return JSON.stringify({
    prompt: draft.prompt,
    documents: draft.pastedTexts.map(({ id, title, text }) => ({
      id,
      title,
      text,
    })),
    files: draft.files.map(({ id, name, mimeType, sizeBytes }) => ({
      id,
      name,
      mimeType,
      sizeBytes,
    })),
    images: draft.images.map(({ id, name, mimeType, sizeBytes }) => ({
      id,
      name,
      mimeType,
      sizeBytes,
    })),
    skills: draft.skills,
    mentions: draft.mentions,
    assistantSelections: draft.assistantSelections,
    fileComments: draft.fileComments,
    terminalContexts: draft.terminalContexts,
    queuedTurns: draft.queuedTurns.map(({ id }) => id),
    activeProvider: draft.activeProvider,
    modelSelectionByProvider: draft.modelSelectionByProvider,
    runtimeMode: draft.runtimeMode,
  });
}

function discardExpiredReceipts(): void {
  const now = Date.now();
  let changed = false;
  for (const [id, receipt] of receipts) {
    if (!receipt.sending && receipt.expiresAt <= now) {
      receipts.delete(id);
      changed = true;
    }
  }
  if (changed) persistReceipts();
}

function hydrateReceipts(): void {
  if (receiptsHydrated) return;
  receiptsHydrated = true;
  try {
    const raw = window.localStorage.getItem(RECEIPT_STORAGE_KEY);
    if (!raw) return;
    const stored = JSON.parse(raw) as Array<[string, Omit<CompositionReceipt, "sending">]>;
    for (const [id, receipt] of stored) {
      if (receipt && typeof id === "string" && receipt.expiresAt > Date.now()) {
        receipts.set(id, receipt);
      }
    }
  } catch {
    window.localStorage.removeItem(RECEIPT_STORAGE_KEY);
  }
}

function persistReceipts(): void {
  if (typeof window === "undefined") return;
  const stored = [...receipts.entries()].map(([id, { sending: _sending, ...receipt }]) => [
    id,
    receipt,
  ]);
  window.localStorage.setItem(RECEIPT_STORAGE_KEY, JSON.stringify(stored));
}

function errorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string")
    return error.code;
  return "THREAD_API_FAILED";
}

function attachmentBytes(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}
