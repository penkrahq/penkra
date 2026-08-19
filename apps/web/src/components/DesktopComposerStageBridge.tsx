// FILE: DesktopComposerStageBridge.tsx
// Purpose: Applies permission-checked App staging requests to the visible shell composer.
// Layer: Trusted Penkra shell renderer

import { ThreadId, type ModelSelection, type ProviderKind } from "@penkra/contracts";
import { useEffect } from "react";

import { useComposerDraftStore } from "../composerDraftStore";
import { useProviderStatusesForLocalConfig } from "../hooks/useProviderStatusesForLocalConfig";
import { useRefreshProviderStatusesNow } from "../hooks/useProviderStatusRefresh";
import { createPastedTextDraft } from "../lib/composerPastedText";
import { resolveProviderSendAvailabilityWithRefresh } from "../lib/providerAvailability";

export function DesktopComposerStageBridge() {
  const statuses = useProviderStatusesForLocalConfig();
  const refreshStatuses = useRefreshProviderStatusesNow();

  useEffect(() => {
    const bridge = window.desktopBridge?.composerStage;
    if (!bridge) return;
    return bridge.onRequest((request) => {
      void stage(request).then(
        (resolvedModel) => bridge.respond({ id: request.id, ok: true, resolvedModel }),
        (error: unknown) =>
          bridge.respond({
            id: request.id,
            ok: false,
            code: errorCode(error),
            message: error instanceof Error ? error.message : String(error),
          }),
      );
    });

    async function stage(request: import("@penkra/contracts").DesktopComposerStageRequest) {
      const threadId = ThreadId.makeUnsafe(request.threadId);
      const store = useComposerDraftStore.getState();
      const existing = store.draftsByThreadId[threadId];
      if (existing && hasComposerContent(existing)) {
        throw Object.assign(
          new Error("The composer must be empty before an App can stage a turn."),
          {
            code: "COMPOSER_NOT_EMPTY",
          },
        );
      }

      let resolvedModel: {
        provider: string;
        model: string;
        options?: Record<string, unknown>;
      } | null = null;
      for (const candidate of request.input.model ?? []) {
        const provider = candidate.provider as ProviderKind;
        if (!statuses.some((status) => status.provider === provider)) continue;
        const availability = await resolveProviderSendAvailabilityWithRefresh({
          provider,
          statuses,
          refreshStatuses: () => refreshStatuses({ silent: true }),
        });
        if (!availability.usable) continue;
        const options = request.input.effort
          ? { ...(candidate.options ?? {}), reasoningEffort: request.input.effort }
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
      if ((request.input.model?.length ?? 0) > 0 && !resolvedModel) {
        throw Object.assign(new Error("None of the App's requested models is currently usable."), {
          code: "NO_USABLE_MODEL",
        });
      }

      if (request.input.text !== undefined) store.setPrompt(threadId, request.input.text);
      if (request.input.documents?.length) {
        store.addPastedTexts(
          threadId,
          request.input.documents.map((document) =>
            createPastedTextDraft({
              id: crypto.randomUUID(),
              createdAt: new Date().toISOString(),
              title: document.title,
              text: document.content,
            }),
          ),
        );
      }
      if (request.input.skills?.length) store.setSkills(threadId, request.input.skills);
      if (request.input.files?.length) {
        store.addFiles(
          threadId,
          request.input.files.map((attachment) => {
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
      if (request.input.images?.length) {
        store.addImages(
          threadId,
          request.input.images.map((attachment) => {
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
      return resolvedModel;
    }
  }, [refreshStatuses, statuses]);

  return null;
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
    draft.queuedTurns.length,
  );
}

function errorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return "COMPOSER_STAGE_FAILED";
}

function attachmentBytes(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}
