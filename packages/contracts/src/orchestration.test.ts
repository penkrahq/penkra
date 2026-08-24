import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import {
  ClientOrchestrationCommand,
  DEFAULT_RUNTIME_MODE,
  ModelSelection,
  OrchestrationCommand,
  OrchestrationEvent,
  OrchestrationLatestTurn,
  OrchestrationReadModel,
  FolderCreatedPayload,
  FolderUpdatedPayload,
  OrchestrationSession,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  ProviderStartOptions,
  FolderCreateCommand,
  THREAD_NOTES_MAX_CHARS,
  ThreadUpdatedPayload,
  ThreadTurnStartCommand,
  ThreadCreatedPayload,
  ThreadTurnStartRequestedPayload,
} from "./orchestration";

const decodeFolderCreateCommand = Schema.decodeUnknownEffect(FolderCreateCommand);
const decodeFolderCreatedPayload = Schema.decodeUnknownEffect(FolderCreatedPayload);
const decodeFolderUpdatedPayload = Schema.decodeUnknownEffect(FolderUpdatedPayload);
const decodeThreadTurnStartCommand = Schema.decodeUnknownEffect(ThreadTurnStartCommand);
const decodeThreadTurnStartRequestedPayload = Schema.decodeUnknownEffect(
  ThreadTurnStartRequestedPayload,
);
const decodeOrchestrationLatestTurn = Schema.decodeUnknownEffect(OrchestrationLatestTurn);
const decodeOrchestrationSession = Schema.decodeUnknownEffect(OrchestrationSession);
const decodeThreadCreatedPayload = Schema.decodeUnknownEffect(ThreadCreatedPayload);
const decodeThreadUpdatedPayload = Schema.decodeUnknownEffect(ThreadUpdatedPayload);
const decodeModelSelection = Schema.decodeUnknownEffect(ModelSelection);
const decodeProviderStartOptions = Schema.decodeUnknownEffect(ProviderStartOptions);
const decodeClientOrchestrationCommand = Schema.decodeUnknownEffect(ClientOrchestrationCommand);
const decodeOrchestrationCommand = Schema.decodeUnknownEffect(OrchestrationCommand);
const decodeOrchestrationEvent = Schema.decodeUnknownEffect(OrchestrationEvent);

it.effect("preserves provider turn identity on projected latest turns", () =>
  Effect.gen(function* () {
    const latestTurn = yield* decodeOrchestrationLatestTurn({
      turnId: "turn-request",
      providerTurnId: "turn-provider",
      state: "running",
      requestedAt: "2026-08-22T00:00:00.000Z",
      startedAt: "2026-08-22T00:00:01.000Z",
      completedAt: null,
      assistantMessageId: null,
    });

    assert.equal(latestTurn.providerTurnId, "turn-provider");
  }),
);

it.effect("preserves thread activity payloads through the RPC JSON codec", () =>
  Effect.gen(function* () {
    const codec = Schema.toCodecJson(OrchestrationReadModel);
    const readModel = {
      snapshotSequence: 1,
      spaces: [],
      updatedAt: "2026-01-01T00:00:00.000Z",
      folders: [],
      threads: [
        {
          id: "thread-1",
          codexThreadId: null,
          folderId: "project-1",
          title: "Thread 1",
          modelSelection: {
            provider: "codex",
            model: "gpt-5.5",
          },
          runtimeMode: "full-access",
          envMode: "local",
          branch: null,
          worktreePath: null,
          associatedWorktreePath: null,
          associatedWorktreeBranch: null,
          associatedWorktreeRef: null,
          createBranchFlowCompleted: false,
          parentThreadId: null,
          subagentAgentId: null,
          subagentNickname: null,
          subagentRole: null,
          forkSourceThreadId: null,
          lastKnownPr: null,
          latestTurn: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          archivedAt: null,
          deletedAt: null,
          messages: [],
          activities: [
            {
              id: "activity-1",
              tone: "tool",
              kind: "tool.completed",
              summary: "Ran command",
              payload: {
                itemType: "command_execution",
                data: {
                  item: {
                    command: "git status --short",
                  },
                },
              },
              turnId: null,
              sequence: 1,
              createdAt: "2026-01-01T00:00:00.000Z",
            },
          ],
          session: null,
        },
      ],
    };

    const encoded = yield* Schema.encodeUnknownEffect(codec)(readModel);
    const decoded = yield* Schema.decodeUnknownEffect(codec)(encoded);
    const activity = decoded.threads[0]?.activities[0];

    assert.deepStrictEqual(activity?.payload, {
      itemType: "command_execution",
      data: {
        item: {
          command: "git status --short",
        },
      },
    });
  }),
);

it.effect("drops legacy provider passwords from decoded provider options", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeProviderStartOptions({
      opencode: {
        binaryPath: "/custom/bin/opencode",
        serverUrl: "http://127.0.0.1:4096",
        serverPassword: "legacy-opencode-secret",
      },
    });

    assert.deepStrictEqual(parsed, {
      opencode: {
        binaryPath: "/custom/bin/opencode",
        serverUrl: "http://127.0.0.1:4096",
      },
    });
    assert.doesNotMatch(JSON.stringify(parsed), /serverPassword|legacy-.*-secret/);
  }),
);

it.effect("keeps generic conversation rollback internal-only", () =>
  Effect.gen(function* () {
    const rollbackCommand = {
      type: "thread.conversation.rollback",
      commandId: "cmd-rollback",
      threadId: "thread-1",
      messageId: "message-1",
      numTurns: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
    };

    const clientResult = yield* Effect.exit(decodeClientOrchestrationCommand(rollbackCommand));
    assert.strictEqual(clientResult._tag, "Failure");

    const parsedInternal = yield* decodeOrchestrationCommand(rollbackCommand);
    assert.strictEqual(parsedInternal.type, "thread.conversation.rollback");
  }),
);

it.effect("trims branded ids and command string fields at decode boundaries", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeFolderCreateCommand({
      type: "folder.create",
      commandId: " cmd-1 ",
      folderId: " project-1 ",
      spaceId: " space-1 ",
      title: " Project Title ",
      workspaceRoot: " /tmp/workspace ",
      defaultModelSelection: {
        provider: "codex",
        model: " gpt-5.2 ",
      },
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.commandId, "cmd-1");
    assert.strictEqual(parsed.folderId, "project-1");
    assert.strictEqual(parsed.title, "Project Title");
    assert.strictEqual(parsed.workspaceRoot, "/tmp/workspace");
    assert.deepStrictEqual(parsed.defaultModelSelection, {
      provider: "codex",
      model: "gpt-5.2",
    });
  }),
);

it.effect("decodes folder.created payloads with a default provider", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeFolderCreatedPayload({
      folderId: "project-1",
      spaceId: "space-1",
      title: "Project Title",
      workspaceRoot: "/tmp/workspace",
      defaultModelSelection: {
        provider: "codex",
        model: "gpt-5.4",
      },
      scripts: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.defaultModelSelection?.provider, "codex");
    assert.strictEqual(parsed.isPinned, false);
  }),
);

it.effect("decodes folder.updated payloads with explicit default provider", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeFolderUpdatedPayload({
      folderId: "project-1",
      defaultModelSelection: {
        provider: "claudeAgent",
        model: "claude-opus-4-6",
      },
      isPinned: true,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.defaultModelSelection?.provider, "claudeAgent");
    assert.strictEqual(parsed.isPinned, true);
  }),
);

it.effect("accepts bounded raster folder icons and rejects untrusted image data URLs", () =>
  Effect.gen(function* () {
    const iconDataUrl = "data:image/webp;base64,Y3VzdG9t";
    const parsed = yield* decodeFolderUpdatedPayload({
      folderId: "project-1",
      iconDataUrl,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.iconDataUrl, iconDataUrl);

    const svg = yield* Effect.exit(
      decodeFolderUpdatedPayload({
        folderId: "project-1",
        iconDataUrl: "data:image/svg+xml;base64,PHN2Zy8+",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    assert.strictEqual(svg._tag, "Failure");
  }),
);

it.effect("rejects command fields that become empty after trim", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      decodeFolderCreateCommand({
        type: "folder.create",
        commandId: "cmd-1",
        folderId: "project-1",
        title: "  ",
        workspaceRoot: "/tmp/workspace",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    assert.strictEqual(result._tag, "Failure");
  }),
);

it.effect("decodes thread.turn.start defaults for provider, runtime mode, and dispatch mode", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadTurnStartCommand({
      type: "thread.turn.start",
      commandId: "cmd-turn-1",
      threadId: "thread-1",
      message: {
        messageId: "msg-1",
        role: "user",
        text: "hello",
        attachments: [],
      },
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.modelSelection, undefined);
    assert.strictEqual(parsed.runtimeMode, DEFAULT_RUNTIME_MODE);
    assert.strictEqual(parsed.dispatchMode, "queue");
  }),
);

it.effect("bounds initial turn text while preserving attachment-only turns", () =>
  Effect.gen(function* () {
    const command = (text: string, attachments: ReadonlyArray<unknown> = []) => ({
      type: "thread.turn.start",
      commandId: "cmd-turn-input-limit",
      threadId: "thread-1",
      message: { messageId: "msg-input-limit", role: "user", text, attachments },
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    const exact = yield* decodeThreadTurnStartCommand(
      command("x".repeat(PROVIDER_SEND_TURN_MAX_INPUT_CHARS)),
    );
    assert.strictEqual(exact.message.text.length, PROVIDER_SEND_TURN_MAX_INPUT_CHARS);

    const overLimit = yield* Effect.exit(
      decodeThreadTurnStartCommand(command("x".repeat(PROVIDER_SEND_TURN_MAX_INPUT_CHARS + 1))),
    );
    assert.strictEqual(overLimit._tag, "Failure");

    const whitespaceOnly = yield* Effect.exit(decodeThreadTurnStartCommand(command("   ")));
    assert.strictEqual(whitespaceOnly._tag, "Failure");

    const attachmentOnly = yield* decodeThreadTurnStartCommand(
      command("", [
        {
          type: "image",
          id: "thread-1-11111111-1111-4111-8111-111111111111",
          name: "screen.png",
          mimeType: "image/png",
          sizeBytes: 1,
        },
      ]),
    );
    assert.strictEqual(attachmentOnly.message.attachments.length, 1);
  }),
);

it.effect("preserves explicit provider and runtime mode in thread.turn.start", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadTurnStartCommand({
      type: "thread.turn.start",
      commandId: "cmd-turn-2",
      threadId: "thread-1",
      message: {
        messageId: "msg-2",
        role: "user",
        text: "hello",
        attachments: [],
      },
      modelSelection: {
        provider: "codex",
        model: "gpt-5.4",
      },
      runtimeMode: "full-access",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.modelSelection?.provider, "codex");
    assert.strictEqual(parsed.runtimeMode, "full-access");
  }),
);

it.effect("decodes thread.created runtime mode for historical events", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadCreatedPayload({
      threadId: "thread-1",
      folderId: "project-1",
      title: "Thread title",
      modelSelection: {
        provider: "codex",
        model: "gpt-5.4",
      },
      branch: null,
      worktreePath: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    assert.strictEqual(parsed.runtimeMode, DEFAULT_RUNTIME_MODE);
    assert.strictEqual(parsed.modelSelection.provider, "codex");
  }),
);

it.effect("decodes thread archive and unarchive commands", () =>
  Effect.gen(function* () {
    const archive = yield* decodeOrchestrationCommand({
      type: "thread.archive",
      commandId: "cmd-archive-1",
      threadId: "thread-1",
    });
    const unarchive = yield* decodeOrchestrationCommand({
      type: "thread.unarchive",
      commandId: "cmd-unarchive-1",
      threadId: "thread-1",
    });

    assert.strictEqual(archive.type, "thread.archive");
    assert.strictEqual(unarchive.type, "thread.unarchive");
  }),
);

it.effect("decodes thread archived and unarchived events", () =>
  Effect.gen(function* () {
    const archived = yield* decodeOrchestrationEvent({
      sequence: 1,
      eventId: "event-archive-1",
      aggregateKind: "thread",
      aggregateId: "thread-1",
      type: "thread.archived",
      occurredAt: "2026-01-01T00:00:00.000Z",
      commandId: "cmd-archive-1",
      causationEventId: null,
      correlationId: "cmd-archive-1",
      metadata: {},
      payload: {
        threadId: "thread-1",
        archivedAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    });
    const unarchived = yield* decodeOrchestrationEvent({
      sequence: 2,
      eventId: "event-unarchive-1",
      aggregateKind: "thread",
      aggregateId: "thread-1",
      type: "thread.unarchived",
      occurredAt: "2026-01-02T00:00:00.000Z",
      commandId: "cmd-unarchive-1",
      causationEventId: null,
      correlationId: "cmd-unarchive-1",
      metadata: {},
      payload: {
        threadId: "thread-1",
        updatedAt: "2026-01-02T00:00:00.000Z",
      },
    });

    assert.strictEqual(archived.type, "thread.archived");
    assert.strictEqual(archived.payload.archivedAt, "2026-01-01T00:00:00.000Z");
    assert.strictEqual(unarchived.type, "thread.unarchived");
    assert.strictEqual(unarchived.payload.updatedAt, "2026-01-02T00:00:00.000Z");
  }),
);

it.effect("decodes thread.updated payloads with explicit provider", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadUpdatedPayload({
      threadId: "thread-1",
      modelSelection: {
        provider: "claudeAgent",
        model: "claude-opus-4-6",
      },
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.modelSelection?.provider, "claudeAgent");
  }),
);

it.effect("strips client-sent dispatchOrigin from thread.turn.start commands", () =>
  Effect.gen(function* () {
    // dispatchOrigin is server-assigned. The client command schema deliberately
    // omits it, so a spoofed trusted source must not survive decoding.
    const command = yield* decodeClientOrchestrationCommand({
      type: "thread.turn.start",
      commandId: "cmd-turn-start-origin",
      threadId: "thread-1",
      message: {
        messageId: "message-1",
        role: "user",
        text: "hello",
        attachments: [],
      },
      dispatchMode: "queue",
      dispatchOrigin: "automation",
      runtimeMode: "full-access",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(command.type, "thread.turn.start");
    assert.strictEqual("dispatchOrigin" in command, false);
  }),
);

it.effect("strips client-sent agent dispatchOrigin from thread.turn.start commands", () =>
  Effect.gen(function* () {
    // The "agent" origin is reserved for turns dispatched through the Penkra
    // agent gateway; WS clients must not be able to spoof it either.
    const command = yield* decodeClientOrchestrationCommand({
      type: "thread.turn.start",
      commandId: "cmd-turn-start-agent-origin",
      threadId: "thread-1",
      message: {
        messageId: "message-1",
        role: "user",
        text: "hello",
        attachments: [],
      },
      dispatchMode: "queue",
      dispatchOrigin: "agent",
      runtimeMode: "full-access",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(command.type, "thread.turn.start");
    assert.strictEqual("dispatchOrigin" in command, false);
  }),
);

it.effect("decodes pinned-message commands and events", () =>
  Effect.gen(function* () {
    const command = yield* decodeClientOrchestrationCommand({
      type: "thread.pinned-message.label.set",
      commandId: "cmd-pin-label",
      threadId: "thread-1",
      messageId: "message-1",
      label: "Review this",
    });
    assert.strictEqual(command.type, "thread.pinned-message.label.set");

    const event = yield* decodeOrchestrationEvent({
      sequence: 1,
      eventId: "event-pin-added",
      aggregateKind: "thread",
      aggregateId: "thread-1",
      type: "thread.pinned-message-added",
      occurredAt: "2026-01-01T00:00:00.000Z",
      commandId: "cmd-pin-add",
      causationEventId: null,
      correlationId: "cmd-pin-add",
      metadata: {},
      payload: {
        threadId: "thread-1",
        pin: {
          messageId: "message-1",
          label: null,
          done: false,
          pinnedAt: "2026-01-01T00:00:00.000Z",
        },
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    });
    assert.strictEqual(event.type, "thread.pinned-message-added");
  }),
);

it.effect("rejects removed marker commands but keeps historical marker events readable", () =>
  Effect.gen(function* () {
    const command = yield* Effect.exit(
      decodeClientOrchestrationCommand({
        type: "thread.marker.add",
        commandId: "cmd-marker-add",
        threadId: "thread-1",
        markerId: "marker-1",
        messageId: "message-1",
        startOffset: 7,
        endOffset: 21,
        selectedText: "important text",
        style: "highlight",
        color: "yellow",
      }),
    );
    assert.strictEqual(command._tag, "Failure");

    const event = yield* decodeOrchestrationEvent({
      sequence: 1,
      eventId: "event-marker-added",
      aggregateKind: "thread",
      aggregateId: "thread-1",
      type: "thread.marker-added",
      occurredAt: "2026-01-01T00:00:00.000Z",
      commandId: "cmd-marker-add",
      causationEventId: null,
      correlationId: "cmd-marker-add",
      metadata: {},
      payload: {
        threadId: "thread-1",
        marker: {
          id: "marker-1",
          messageId: "message-1",
          startOffset: 7,
          endOffset: 21,
          selectedText: "important text",
          style: "highlight",
          color: "yellow",
          label: null,
          done: false,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    });
    assert.strictEqual(event.type, "thread.marker-added");
    assert.deepStrictEqual(event.payload, {
      threadId: "thread-1",
      marker: {
        id: "marker-1",
        messageId: "message-1",
        startOffset: 7,
        endOffset: 21,
        selectedText: "important text",
        style: "highlight",
        color: "yellow",
        label: null,
        done: false,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
  }),
);

it.effect("rejects oversized thread notes payloads", () =>
  Effect.gen(function* () {
    const failed = yield* decodeThreadUpdatedPayload({
      threadId: "thread-1",
      notes: "x".repeat(THREAD_NOTES_MAX_CHARS + 1),
      updatedAt: "2026-01-01T00:00:00.000Z",
    }).pipe(
      Effect.match({
        onFailure: () => true,
        onSuccess: () => false,
      }),
    );
    assert.strictEqual(failed, true);
  }),
);

it.effect("accepts provider-scoped model options in thread.turn.start", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadTurnStartCommand({
      type: "thread.turn.start",
      commandId: "cmd-turn-options",
      threadId: "thread-1",
      message: {
        messageId: "msg-options",
        role: "user",
        text: "hello",
        attachments: [],
      },
      modelSelection: {
        provider: "codex",
        model: "gpt-5.3-codex",
        options: {
          reasoningEffort: "high",
          fastMode: true,
        },
      },
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.modelSelection?.provider, "codex");
    assert.strictEqual(parsed.modelSelection?.options?.reasoningEffort, "high");
    assert.strictEqual(parsed.modelSelection?.options?.fastMode, true);
  }),
);

it.effect("rejects normalized thread.turn.start commands with too many attachments", () =>
  Effect.gen(function* () {
    const failed = yield* decodeThreadTurnStartCommand({
      type: "thread.turn.start",
      commandId: "cmd-turn-too-many-attachments",
      threadId: "thread-1",
      message: {
        messageId: "msg-too-many-attachments",
        role: "user",
        text: "hello",
        attachments: Array.from({ length: PROVIDER_SEND_TURN_MAX_ATTACHMENTS + 1 }, (_, index) => ({
          type: "image",
          id: `attachment-${index}`,
          name: `image-${index}.png`,
          mimeType: "image/png",
          sizeBytes: 1,
        })),
      },
      createdAt: "2026-01-01T00:00:00.000Z",
    }).pipe(
      Effect.match({
        onFailure: () => true,
        onSuccess: () => false,
      }),
    );
    assert.strictEqual(failed, true);
  }),
);

it.effect("rejects client thread.turn.start commands with too many upload attachments", () =>
  Effect.gen(function* () {
    const failed = yield* decodeClientOrchestrationCommand({
      type: "thread.turn.start",
      commandId: "cmd-client-turn-too-many-attachments",
      threadId: "thread-1",
      message: {
        messageId: "msg-client-too-many-attachments",
        role: "user",
        text: "hello",
        attachments: Array.from({ length: PROVIDER_SEND_TURN_MAX_ATTACHMENTS + 1 }, (_, index) => ({
          type: "image",
          id: `thread-1-00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
          name: `image-${index}.png`,
          mimeType: "image/png",
          sizeBytes: 1,
        })),
      },
      runtimeMode: "full-access",
      createdAt: "2026-01-01T00:00:00.000Z",
    }).pipe(
      Effect.match({
        onFailure: () => true,
        onSuccess: () => false,
      }),
    );
    assert.strictEqual(failed, true);
  }),
);

it.effect("decodes thread.turn-start-requested defaults for provider and runtime mode", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadTurnStartRequestedPayload({
      threadId: "thread-1",
      messageId: "msg-1",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.modelSelection, undefined);
    assert.strictEqual(parsed.runtimeMode, DEFAULT_RUNTIME_MODE);
    assert.strictEqual(parsed.dispatchMode, "queue");
  }),
);

it.effect("decodes orchestration session runtime mode defaults", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeOrchestrationSession({
      threadId: "thread-1",
      status: "idle",
      providerName: null,
      providerSessionId: null,
      providerThreadId: null,
      activeTurnId: null,
      lastError: null,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.runtimeMode, DEFAULT_RUNTIME_MODE);
  }),
);

it.effect("preserves user-input answer values through the RPC JSON codec", () =>
  Effect.gen(function* () {
    const codec = Schema.toCodecJson(ClientOrchestrationCommand);
    const wire = {
      type: "thread.user-input.respond",
      commandId: "cmd-1",
      threadId: "thread-1",
      requestId: "req-1",
      answers: {
        single: "Purple",
        multi: ["Reading", "Coding"],
        skipped: null,
      },
      createdAt: "2026-05-19T16:14:28.202Z",
    };
    const decoded = yield* Schema.decodeUnknownEffect(codec)(wire);
    assert.deepStrictEqual(
      (decoded as Extract<typeof decoded, { type: "thread.user-input.respond" }>).answers,
      {
        single: "Purple",
        multi: ["Reading", "Coding"],
        skipped: null,
      },
    );
  }),
);
