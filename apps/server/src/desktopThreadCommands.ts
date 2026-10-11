// FILE: desktopThreadCommands.ts
// Purpose: Execute trusted App folder thread operations without a shell renderer.

import { randomUUID } from "node:crypto";
import type {
  DesktopThreadApiRequest,
  DesktopThreadComposeAttachment,
  CleanCoreThreadSummary,
  OrchestrationFolderShell,
  OrchestrationCommand,
  ChatAttachment,
  CleanCoreThreadUpdate,
  CleanCoreCreateThreadInput,
  CleanCoreCreateThreadResult,
} from "@penkra/contracts";
import {
  CommandId,
  MessageId,
  FolderId,
  ModelSelection,
  RuntimeMode,
  CleanCoreThreadListCursor,
  ThreadId,
} from "@penkra/contracts";
import { Schema } from "effect";
import type { AppThreadSendReceipt, AppThreadState } from "@penkra/sdk";

type ComposeRequest = Extract<DesktopThreadApiRequest, { method: "compose" }>;
interface StagedComposition {
  readonly appId: string;
  readonly spaceId: string;
  readonly folderId: string;
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
  getThread(threadId: string): Promise<CleanCoreThreadSummary | null>;
  getFolder(folderId: string): Promise<OrchestrationFolderShell | null>;
  listThreads(input: {
    spaceId: string;
    folderId: string;
    after: CleanCoreThreadListCursor | null;
  }): Promise<{
    threads: readonly CleanCoreThreadSummary[];
    nextCursor: CleanCoreThreadListCursor | null;
  }>;
  dispatch(command: OrchestrationCommand): Promise<unknown>;
  createThread(input: CleanCoreCreateThreadInput): Promise<CleanCoreCreateThreadResult>;
  updateThread(
    update: Extract<CleanCoreThreadUpdate, { action: "moveSidebarItem" | "archive" }>,
  ): Promise<void>;
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
    const folder = await this.deps.getFolder(request.folderId);
    if (!folder || folder.spaceId !== request.spaceId)
      fail("TAB_FOLDER_NOT_AVAILABLE", "The folder is unavailable.");
    const requireMember = async (id: string) => {
      const member = await this.deps.getThread(id);
      if (!member || member.folderId !== request.folderId || member.deletedAt !== null)
        fail("THREAD_NOT_IN_FOLDER", "The Thread is not in this folder.");
      return member;
    };
    const current = await requireMember(request.threadId);
    const modelOf = (row: CleanCoreThreadSummary) =>
      Schema.decodeUnknownSync(ModelSelection)({
        provider: row.provider,
        model: row.model,
        ...(row.modelOptions === null ? {} : { options: JSON.parse(row.modelOptions) }),
      });
    const state = (member: CleanCoreThreadSummary): AppThreadState => {
      const id = member.id;
      const composed = [...this.#receipts].find(
        ([, receipt]) =>
          receipt.threadId === id && !receipt.result && receipt.expiresAt > Date.now(),
      );
      const running = member.state === "running";
      const receipt = composed?.[1];
      return {
        threadId: id,
        folderId: member.folderId,
        title: member.title,
        order: member.sidebarSortOrder ?? 0,
        archived: member.archivedAt !== null,
        phase:
          member.openQuestionCount > 0
            ? "waiting"
            : member.state === "running"
              ? "running"
              : member.state === "error"
                ? "failed"
                : "idle",
        activeTurnId: member.activeTurnId,
        pendingQuestion: member.openQuestionCount > 0,
        composer: {
          empty: !receipt,
          owner: receipt ? "app" : "none",
          composeId: composed?.[0] ?? null,
        },
        queued: {
          count: (JSON.parse(member.queue) as unknown[]).length,
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
        return state(current);
      case "list": {
        let after: CleanCoreThreadListCursor | null = null;
        if (request.input.cursor !== undefined) {
          try {
            after = Schema.decodeUnknownSync(CleanCoreThreadListCursor)(
              JSON.parse(Buffer.from(request.input.cursor, "base64url").toString("utf8")),
            );
          } catch {
            fail("BAD_CURSOR", 'Argument "cursor" is not a valid folder-list cursor.');
          }
        }
        const page = await this.deps.listThreads({
          spaceId: request.spaceId,
          folderId: request.folderId,
          after,
        });
        return {
          threads: page.threads.map(state),
          pageInfo: {
            nextCursor:
              page.nextCursor === null
                ? null
                : Buffer.from(JSON.stringify(page.nextCursor), "utf8").toString("base64url"),
          },
        };
      }
      case "get":
        return state(await requireMember(request.input.threadId));
      case "select":
        await requireMember(request.input.threadId);
        return { selectedThreadId: request.input.threadId };
      case "create": {
        if (request.input.folderId !== undefined && request.input.folderId !== request.folderId)
          fail("THREAD_ACCESS_DENIED", "Create the Thread in the invoking folder.");
        const created = threadId();
        await this.deps.createThread({
          creator: { kind: "user" },
          connection: { kind: "default" },
          threadId: created,
          folderId: folder.id,
          title: request.input.title?.trim() || "New thread",
          modelSelection: modelOf(current),
          runtimeMode: Schema.decodeUnknownSync(RuntimeMode)(current.runtimeMode),
          createdAt: new Date().toISOString(),
        });
        return { threadId: created, folderId: folder.id };
      }
      case "reorder": {
        const target = await requireMember(request.input.threadId);
        const position = request.input.position;
        const normalized =
          position.type === "before" || position.type === "after"
            ? ({ type: position.type, itemId: ThreadId.makeUnsafe(position.threadId) } as const)
            : position.type === "start"
              ? { type: "start" as const }
              : { type: "end" as const };
        await this.deps.updateThread({
          action: "moveSidebarItem",
          threadId: target.id,
          folderId: folder.id,
          position: normalized,
          updatedAt: new Date().toISOString(),
        });
        return null;
      }
      case "archive": {
        const target = await requireMember(request.input.threadId);
        const page = await this.deps.listThreads({
          spaceId: request.spaceId,
          folderId: request.folderId,
          after: null,
        });
        const selectedThreadId =
          target.id === request.threadId
            ? (page.threads.find((row) => row.id !== target.id)?.id ?? null)
            : undefined;
        const updatedAt = new Date().toISOString();
        await this.deps.updateThread({
          action: "archive",
          threadId: target.id,
          archivedAt: updatedAt,
          updatedAt,
        });

        return { selectedThreadId };
      }
      case "compose": {
        const target = await requireMember(request.input.threadId);
        if (target.openQuestionCount > 0)
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
          folderId: request.folderId,
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
          receipt.folderId !== request.folderId ||
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
        const target = await requireMember(receipt.threadId);
        if (target.openQuestionCount > 0)
          fail("THREAD_WAITING_FOR_USER", "The Thread is waiting for a human answer.");
        const mode = request.input.mode ?? "queue";
        const busy = target.state === "running";
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
            : modelOf(target);
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
          modelSelection: Schema.decodeUnknownSync(ModelSelection)(modelSelection),
          dispatchMode: mode,
          runtimeMode: Schema.decodeUnknownSync(RuntimeMode)(target.runtimeMode),
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
