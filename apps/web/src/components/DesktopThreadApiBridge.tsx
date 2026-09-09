// FILE: DesktopThreadApiBridge.tsx
// Purpose: Implements current-Thread read, compose, and receipt-bound send for Apps.
// Layer: Trusted Penkra shell renderer

import { ThreadId, type ModelSelection, type ProviderKind } from "@penkra/contracts";
import { useEffect } from "react";

import { useComposerDraftStore } from "../composerDraftStore";
import { requireDesktopThreadLiveHandlers } from "../desktopThreadApiBroker";
import { useProviderStatusesForLocalConfig } from "../hooks/useProviderStatusesForLocalConfig";
import { useRefreshProviderStatusesNow } from "../hooks/useProviderStatusRefresh";
import { createPastedTextDraft } from "../lib/composerPastedText";
import { resolveProviderSendAvailabilityWithRefresh } from "../lib/providerAvailability";

const RECEIPT_TTL_MS = 10 * 60_000;
const RECEIPT_STORAGE_KEY = "penkra.app-thread-composition-receipts.v1";

interface CompositionReceipt {
  appId: string;
  spaceId: string;
  tabId: string;
  threadId: string;
  fingerprint: string;
  text: string;
  createdAt: number;
  expiresAt: number;
  result?: import("@penkra/sdk").AppThreadSendReceipt;
  sending?: Promise<import("@penkra/sdk").AppThreadSendReceipt>;
}

const receipts = new Map<string, CompositionReceipt>();
const stateClocks = new Map<string, { fingerprint: string; updatedAt: string }>();
let receiptsHydrated = false;

export function DesktopThreadApiBridge() {
  const statuses = useProviderStatusesForLocalConfig();
  const refreshStatuses = useRefreshProviderStatusesNow();

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
      if (request.method === "read") return readState(request.threadId);
      if (request.method === "compose") {
        if (request.input === undefined) return readState(request.threadId).composer;
        return compose(request);
      }
      return send(request);
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
      const threadId = ThreadId.makeUnsafe(request.threadId);
      const before = readState(threadId);
      if (!before.composer.empty || before.phase !== "idle" || before.queued.count > 0) {
        const code = before.pendingQuestion
          ? "THREAD_WAITING_FOR_USER"
          : before.queued.count > 0
            ? "THREAD_HAS_QUEUED_COMPOSITION"
            : before.phase !== "idle"
              ? "THREAD_BUSY"
              : "COMPOSER_NOT_EMPTY";
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
      if ((input.model?.length ?? 0) > 0 && !resolvedModel) {
        throw Object.assign(new Error("None of the App's requested models is currently usable."), {
          code: "NO_USABLE_MODEL",
        });
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
        receipt.tabId !== request.tabId ||
        receipt.threadId !== request.threadId
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
      const draft = requireDraft(ThreadId.makeUnsafe(request.threadId));
      if (draftFingerprint(draft) !== receipt.fingerprint) {
        throw Object.assign(
          new Error("The staged composition changed after its receipt was issued."),
          {
            code: "COMPOSITION_CHANGED",
          },
        );
      }
      const live = requireDesktopThreadLiveHandlers(request.threadId);
      const before = live.read();
      if (before.pendingUserInput) {
        throw Object.assign(new Error("The current Thread is waiting for a human answer."), {
          code: "THREAD_WAITING_FOR_USER",
        });
      }
      const mode = request.input.mode ?? "queue";
      const busy = before.phase !== "idle";
      const state = busy ? (mode === "steer" ? "steering" : "queued") : "accepted";
      const submissionId = crypto.randomUUID();
      const acceptedAt = new Date().toISOString();
      const sending = live.send({ expectedText: receipt.text, mode }).then(
        (accepted) => {
          if (!accepted) {
            throw Object.assign(new Error("Penkra did not admit the staged composition."), {
              code: "COMPOSITION_NOT_ADMITTED",
            });
          }
          const result = {
            submissionId,
            composeId: request.input.composeId,
            threadId: request.threadId,
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
  }, [refreshStatuses, statuses]);

  return null;
}

function readState(threadId: string): import("@penkra/sdk").AppThreadState {
  const live = requireDesktopThreadLiveHandlers(threadId).read();
  const draft = useComposerDraftStore.getState().draftsByThreadId[ThreadId.makeUnsafe(threadId)];
  const empty = !draft || !hasComposerContent(draft);
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
    phase: live.phase,
    activeTurnId: live.activeTurnId,
    pendingQuestion: live.pendingUserInput,
    composer: {
      empty,
      owner: empty ? "none" : appComposition ? "app" : "human",
      composeId: appComposition?.[0] ?? null,
    },
    queued: {
      count: live.queuedCount,
      hasAppSubmission: [...receipts.values()].some(
        (receipt) => receipt.threadId === threadId && receipt.result?.state === "queued",
      ),
    },
    steering: {
      pending: live.steeringPending,
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
    draft.terminalContexts.length ||
    draft.queuedTurns.length,
  );
}

function draftFingerprint(
  draft: import("../composerDraftDomain").ComposerThreadDraftState,
): string {
  return JSON.stringify({
    prompt: draft.prompt,
    documents: draft.pastedTexts.map(({ id, title, text }) => ({ id, title, text })),
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
