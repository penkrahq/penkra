import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import {
  CleanCoreAnswerThreadQuestionInput,
  CleanCoreFolderCreateUpdate,
  CleanCoreFolderUpdate,
} from "./cleanCore";
import {
  DEFAULT_RUNTIME_MODE,
  ModelSelection,
  OrchestrationLatestTurn,
  OrchestrationReadModel,
  OrchestrationSession,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  ProviderStartOptions,
} from "./orchestration";

const decodeFolderCreateCommand = Schema.decodeUnknownEffect(CleanCoreFolderCreateUpdate);
const decodeFolderCreatedPayload = Schema.decodeUnknownEffect(CleanCoreFolderCreateUpdate);
const decodeFolderUpdatedPayload = Schema.decodeUnknownEffect(CleanCoreFolderUpdate);
const decodeOrchestrationLatestTurn = Schema.decodeUnknownEffect(OrchestrationLatestTurn);
const decodeOrchestrationSession = Schema.decodeUnknownEffect(OrchestrationSession);
const decodeModelSelection = Schema.decodeUnknownEffect(ModelSelection);
const decodeProviderStartOptions = Schema.decodeUnknownEffect(ProviderStartOptions);

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
          subagentAgentId: null,
          subagentNickname: null,
          subagentRole: null,
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

it.effect("trims branded ids and command string fields at decode boundaries", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeFolderCreateCommand({
      action: "folder.create",
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
    assert.strictEqual(parsed.folderId, "project-1");
    assert.strictEqual(parsed.title, "Project Title");
    assert.strictEqual(parsed.workspaceRoot, "/tmp/workspace");
    assert.deepStrictEqual(parsed.defaultModelSelection, {
      provider: "codex",
      model: "gpt-5.2",
    });
  }),
);

it.effect("decodes folder creation with a default provider", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeFolderCreatedPayload({
      action: "folder.create",
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
  }),
);

it.effect("decodes folder updates with explicit default provider", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeFolderUpdatedPayload({
      action: "folder.update",
      folderId: "project-1",
      defaultModelSelection: {
        provider: "claudeAgent",
        model: "claude-opus-4-6",
      },
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.defaultModelSelection?.provider, "claudeAgent");
  }),
);

it.effect("accepts bounded raster folder icons and rejects untrusted image data URLs", () =>
  Effect.gen(function* () {
    const iconDataUrl = "data:image/webp;base64,Y3VzdG9t";
    const parsed = yield* decodeFolderUpdatedPayload({
      action: "folder.update",
      folderId: "project-1",
      iconDataUrl,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.iconDataUrl, iconDataUrl);

    const svg = yield* Effect.exit(
      decodeFolderUpdatedPayload({
        action: "folder.update",
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
        action: "folder.create",
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

it.effect("keeps preferred runtime mode out of orchestration sessions", () =>
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
    assert.strictEqual(Object.hasOwn(parsed, "runtimeMode"), false);
  }),
);

it.effect("encodes a partly answered question with only answered keys and mixed values", () =>
  Effect.gen(function* () {
    const codec = Schema.toCodecJson(CleanCoreAnswerThreadQuestionInput);
    const wire = {
      threadId: "thread-1",
      requestId: "req-1",
      answers: {
        single: "Purple",
        multi: ["Reading", "Coding"],
      },
    };
    const decoded = yield* Schema.decodeUnknownEffect(codec)(wire);
    assert.deepStrictEqual(decoded.answers, {
      single: "Purple",
      multi: ["Reading", "Coding"],
    });
    assert.equal(Object.hasOwn(decoded.answers, "skipped"), false);
  }),
);

it.effect("rejects null question-answer entries at the clean-core contract", () =>
  Effect.gen(function* () {
    const failure = yield* Effect.flip(
      Schema.decodeUnknownEffect(CleanCoreAnswerThreadQuestionInput)({
        threadId: "thread-1",
        requestId: "req-1",
        answers: { answered: "Bun", skipped: null },
      }),
    );
    assert.equal(failure._tag, "SchemaError");
  }),
);
