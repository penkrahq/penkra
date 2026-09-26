// FILE: desktopThreadCommands.ts
// Purpose: Execute trusted App Thread and Deck operations without a shell renderer.

import { randomUUID } from "node:crypto";
import type {
  DesktopThreadApiRequest,
  DesktopThreadComposeAttachment,
  OrchestrationShellSnapshot,
  OrchestrationReadModel,
  OrchestrationCommand,
  ChatAttachment,
} from "@penkra/contracts";
import {
  CommandId,
  MessageId,
  ThreadDeckId,
  ThreadId,
  singletonThreadDeckId,
} from "@penkra/contracts";
import type { AppThreadSendReceipt, AppThreadState } from "@penkra/sdk";

type ComposeRequest = Extract<DesktopThreadApiRequest, { method: "compose" }>;
interface StagedComposition {
  readonly appId: string;
  readonly spaceId: string;
  readonly deckId: string;
  readonly tabId: string;
  readonly threadId: string;
  readonly input: ComposeRequest["input"];
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly createdAt: string;
  readonly expiresAt: number;
  result?: AppThreadSendReceipt;
  sending?: Promise<AppThreadSendReceipt>;
}

export interface DesktopThreadCommandDependencies {
  snapshot(): Promise<OrchestrationShellSnapshot>;
  readModel(): Promise<OrchestrationReadModel>;
  bindingRevision(threadId: string): Promise<number>;
  dispatch(command: OrchestrationCommand): Promise<unknown>;
  dispatchTurn(
    command: Extract<OrchestrationCommand, { type: "thread.turn.start" }>,
    ownerId: string,
  ): Promise<unknown>;
  stageAttachment(input: {
    threadId: string;
    ownerId: string;
    type: "file" | "image";
    attachment: DesktopThreadComposeAttachment;
  }): Promise<ChatAttachment>;
}

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}

const commandId = () => CommandId.makeUnsafe(randomUUID());
const threadId = () => ThreadId.makeUnsafe(randomUUID());

export class DesktopThreadCommands {
  readonly #receipts = new Map<string, StagedComposition>();
  constructor(readonly deps: DesktopThreadCommandDependencies) {}

  async execute(request: DesktopThreadApiRequest): Promise<unknown> {
    for (const [id, receipt] of this.#receipts) {
      if (!receipt.sending && receipt.expiresAt <= Date.now()) this.#receipts.delete(id);
    }
    const snapshot = await this.deps.snapshot();
    const readModel =
      request.method === "current.read" || request.method === "list" || request.method === "get"
        ? await this.deps.readModel()
        : undefined;
    const deck = snapshot.decks.find((candidate) => candidate.id === request.deckId);
    if (!deck || deck.spaceId !== request.spaceId)
      fail("THREAD_DECK_NOT_FOUND", "The Thread Deck is unavailable.");
    const current = snapshot.threads.find((candidate) => candidate.id === request.threadId);
    if (!current || current.deckId !== request.deckId)
      fail("THREAD_NOT_IN_DECK", "The presenting Thread is not in this Deck.");
    const requireMember = (id: string) => {
      const member = snapshot.threads.find((candidate) => candidate.id === id);
      if (!member || member.deckId !== request.deckId)
        fail("THREAD_NOT_IN_DECK", "The Thread is not a member of this Deck.");
      return member;
    };
    const requireSameSpace = (id: string) => {
      const member = snapshot.threads.find((candidate) => candidate.id === id);
      const folder = snapshot.folders.find((candidate) => candidate.id === member?.folderId);
      if (!member || folder?.spaceId !== request.spaceId)
        fail("THREAD_ACCESS_DENIED", "The Thread is outside the current Space.");
      return member;
    };
    const state = (id: string): AppThreadState => {
      const member = requireMember(id);
      const composed = [...this.#receipts].find(
        ([, receipt]) =>
          receipt.threadId === id && !receipt.result && receipt.expiresAt > Date.now(),
      );
      const running = member.workStatus === "running";
      const receipt = composed?.[1];
      return {
        threadId: id,
        deckId: member.deckId,
        title: member.title,
        order: member.deckSortOrder,
        archived: member.archivedAt !== null,
        phase: member.hasPendingUserInput
          ? "waiting"
          : member.workStatus === "running"
            ? "running"
            : member.workStatus === "attention"
              ? "failed"
              : "idle",
        activeTurnId: member.session?.activeTurnId ?? null,
        pendingQuestion: member.hasPendingUserInput === true,
        composer: {
          empty: !receipt,
          owner: receipt ? "app" : "none",
          composeId: composed?.[0] ?? null,
        },
        queued: {
          count:
            readModel?.threads.find((thread) => thread.id === id)?.queuedMessageIds?.length ?? 0,
          hasAppSubmission: [...this.#receipts.values()].some(
            (item) => item.threadId === id && item.result?.state === "queued",
          ),
        },
        steering: {
          pending: running,
          hasAppSubmission: [...this.#receipts.values()].some(
            (item) => item.threadId === id && item.result?.state === "steering",
          ),
        },
        updatedAt: member.updatedAt,
      };
    };

    switch (request.method) {
      case "current.read":
        return state(request.threadId);
      case "list":
        return deck.threadIds.map(state);
      case "get":
        return state(request.input.threadId);
      case "select":
        requireMember(request.input.threadId);
        return { selectedThreadId: request.input.threadId };
      case "create": {
        const folderId = request.input.folderId ?? current.folderId;
        const folder = snapshot.folders.find((candidate) => candidate.id === folderId);
        if (!folder || folder.spaceId !== request.spaceId)
          fail("THREAD_ACCESS_DENIED", "The target folder is outside the current Space.");
        const created = threadId();
        await this.deps.dispatch({
          type: "thread.create",
          commandId: commandId(),
          threadId: created,
          deckId: current.deckId,
          folderId: folder.id,
          title: request.input.title?.trim() || "New thread",
          modelSelection: current.modelSelection,
          runtimeMode: current.runtimeMode,
          workingDirectory: current.workingDirectory,
          createdAt: new Date().toISOString(),
        });
        return { threadId: created, deckId: current.deckId };
      }
      case "add":
      case "reorder": {
        const target = requireSameSpace(request.input.threadId);
        if (request.method === "reorder" && target.deckId !== request.deckId)
          fail("THREAD_NOT_IN_DECK", "Only a member of this Deck can be reordered.");
        const position = request.input.position ?? { type: "end" as const };
        await this.deps.dispatch({
          type: "thread.deck.move",
          commandId: commandId(),
          threadId: target.id,
          deckId: ThreadDeckId.makeUnsafe(request.deckId),
          position:
            position.type === "before" || position.type === "after"
              ? { type: position.type, threadId: ThreadId.makeUnsafe(position.threadId) }
              : position,
        });
        return null;
      }
      case "leave": {
        const target = requireMember(request.input.threadId);
        await this.deps.dispatch({
          type: "thread.deck.leave",
          commandId: commandId(),
          threadId: target.id,
          deckId: singletonThreadDeckId(target.id),
        });
        return null;
      }
      case "archive": {
        const target = requireMember(request.input.threadId);
        const remaining = deck.threadIds.filter(
          (id) =>
            id !== target.id &&
            snapshot.threads.some(
              (candidate) => candidate.id === id && candidate.archivedAt === null,
            ),
        );
        const selectedThreadId =
          target.id === request.threadId ? (remaining[0] ?? null) : undefined;
        await this.deps.dispatch({
          type: "thread.archive",
          commandId: commandId(),
          threadId: target.id,
        });
        return { selectedThreadId };
      }
      case "compose": {
        const target = requireMember(request.input.threadId);
        if (target.hasPendingUserInput)
          fail("THREAD_WAITING_FOR_USER", "The Thread is waiting for a human answer.");
        const input = request.input;
        if (
          !(
            input.text?.trim() ||
            input.documents?.length ||
            input.files?.length ||
            input.images?.length ||
            input.skills?.length
          )
        ) {
          fail("COMPOSITION_EMPTY", "A composition must contain sendable content.");
        }
        const ownerId = `${request.appId}:${request.tabId}`;
        const attachments = await Promise.all([
          ...(input.files ?? []).map((attachment) =>
            this.deps.stageAttachment({ threadId: target.id, ownerId, type: "file", attachment }),
          ),
          ...(input.images ?? []).map((attachment) =>
            this.deps.stageAttachment({ threadId: target.id, ownerId, type: "image", attachment }),
          ),
        ]);
        const composeId = randomUUID();
        const createdAt = new Date().toISOString();
        const expiresAt = Date.now() + 10 * 60_000;
        this.#receipts.set(composeId, {
          appId: request.appId,
          spaceId: request.spaceId,
          deckId: request.deckId,
          tabId: request.tabId,
          threadId: target.id,
          input,
          attachments,
          createdAt,
          expiresAt,
        });
        const selected = input.model?.[0];
        const resolvedModel = selected
          ? {
              ...selected,
              ...(input.effort
                ? { options: { ...(selected.options ?? {}), reasoningEffort: input.effort } }
                : {}),
            }
          : null;
        return {
          composeId,
          threadId: target.id,
          createdAt,
          expiresAt: new Date(expiresAt).toISOString(),
          resolvedModel,
        };
      }
      case "send": {
        const receipt = this.#receipts.get(request.input.composeId);
        if (
          !receipt ||
          receipt.appId !== request.appId ||
          receipt.spaceId !== request.spaceId ||
          receipt.deckId !== request.deckId ||
          receipt.tabId !== request.tabId
        ) {
          fail(
            "COMPOSITION_RECEIPT_INVALID",
            "The composition receipt is invalid for this App Thread.",
          );
        }
        if (receipt.result) return receipt.result;
        if (receipt.sending) return receipt.sending;
        if (receipt.expiresAt <= Date.now())
          fail("COMPOSITION_RECEIPT_EXPIRED", "The composition receipt has expired.");
        const target = requireMember(receipt.threadId);
        if (target.hasPendingUserInput)
          fail("THREAD_WAITING_FOR_USER", "The Thread is waiting for a human answer.");
        const mode = request.input.mode ?? "queue";
        const busy = target.workStatus === "running";
        const state = busy ? (mode === "steer" ? "steering" : "queued") : "accepted";
        const submissionId = randomUUID();
        const selected = receipt.input.model?.[0];
        const modelSelection =
          selected &&
          (selected.provider === "codex" ||
            selected.provider === "claudeAgent" ||
            selected.provider === "opencode")
            ? {
                provider: selected.provider,
                model: selected.model,
                ...(selected.options || receipt.input.effort
                  ? {
                      options: {
                        ...(selected.options ?? {}),
                        ...(receipt.input.effort ? { reasoningEffort: receipt.input.effort } : {}),
                      },
                    }
                  : {}),
              }
            : target.modelSelection;
        const text = [
          receipt.input.text ?? "",
          ...(receipt.input.documents ?? []).map(
            (document) => `\n\n${document.title}\n${document.content}`,
          ),
        ].join("");
        const command: Extract<OrchestrationCommand, { type: "thread.turn.start" }> = {
          type: "thread.turn.start",
          commandId: CommandId.makeUnsafe(`app:${request.input.composeId}`),
          threadId: target.id,
          message: {
            messageId: MessageId.makeUnsafe(`app:${request.input.composeId}`),
            role: "user",
            text,
            attachments: [...receipt.attachments],
            ...(receipt.input.skills?.length ? { skills: receipt.input.skills } : {}),
          },
          modelSelection: modelSelection as typeof target.modelSelection,
          bindingRevision: await this.deps.bindingRevision(target.id),
          dispatchMode: mode,
          runtimeMode: target.runtimeMode,
          createdAt: receipt.createdAt,
        };
        const sending = this.deps.dispatchTurn(command, `${request.appId}:${request.tabId}`).then(
          () => {
            const result: AppThreadSendReceipt = {
              submissionId,
              composeId: request.input.composeId,
              threadId: target.id,
              mode,
              state,
              acceptedAt: new Date().toISOString(),
            };
            receipt.result = result;
            delete receipt.sending;
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
    }
  }
}
