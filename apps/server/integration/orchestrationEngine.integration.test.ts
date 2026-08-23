import fs from "node:fs";
import path from "node:path";

import {
  ApprovalRequestId,
  CommandId,
  DEFAULT_MODEL_BY_PROVIDER,
  EventId,
  MessageId,
  FolderId,
  SpaceId,
  ProviderKind,
  ThreadId,
  ModelSelection,
} from "@penkra/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import type { TestTurnResponse } from "./TestProviderAdapter.integration.ts";
import {
  INTEGRATION_CONNECTION_ID,
  makeOrchestrationIntegrationHarness,
  type OrchestrationIntegrationHarness,
} from "./OrchestrationEngineHarness.integration.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";

const asMessageId = (value: string): MessageId => MessageId.makeUnsafe(value);
const asFolderId = (value: string): FolderId => FolderId.makeUnsafe(value);
const asEventId = (value: string): EventId => EventId.makeUnsafe(value);
const asApprovalRequestId = (value: string): ApprovalRequestId =>
  ApprovalRequestId.makeUnsafe(value);

const PROJECT_ID = asFolderId("project-1");
const THREAD_ID = ThreadId.makeUnsafe("thread-1");
const FIXTURE_TURN_ID = "fixture-turn";
const APPROVAL_REQUEST_ID = asApprovalRequestId("req-approval-1");
const itLiveUnlessCi = (process.env.CI ? it.skip : it.live) as typeof it.live;
type IntegrationProvider = ProviderKind;

function nowIso() {
  return new Date().toISOString();
}

class IntegrationWaitTimeoutError extends Schema.TaggedErrorClass<IntegrationWaitTimeoutError>()(
  "IntegrationWaitTimeoutError",
  {
    description: Schema.String,
  },
) {}

function waitForSync<A>(
  read: () => A,
  predicate: (value: A) => boolean,
  description: string,
  timeoutMs = 10_000,
): Effect.Effect<A, never> {
  return Effect.gen(function* () {
    const deadline = Date.now() + timeoutMs;

    while (true) {
      const value = read();
      if (predicate(value)) {
        return value;
      }
      if (Date.now() >= deadline) {
        return yield* Effect.die(new IntegrationWaitTimeoutError({ description }));
      }
      yield* Effect.sleep(10);
    }
  });
}

function runtimeBase(eventId: string, createdAt: string, provider: IntegrationProvider = "codex") {
  return {
    eventId: asEventId(eventId),
    provider,
    createdAt,
  };
}

function withHarness<A, E>(
  use: (harness: OrchestrationIntegrationHarness) => Effect.Effect<A, E>,
  provider: IntegrationProvider = "codex",
) {
  return Effect.acquireUseRelease(
    makeOrchestrationIntegrationHarness({ provider }),
    use,
    (harness) => harness.dispose,
  ).pipe(Effect.provide(NodeServices.layer));
}

function withRealCodexHarness<A, E>(
  use: (harness: OrchestrationIntegrationHarness) => Effect.Effect<A, E>,
) {
  return Effect.acquireUseRelease(
    makeOrchestrationIntegrationHarness({ provider: "codex", realCodex: true }),
    use,
    (harness) => harness.dispose,
  ).pipe(Effect.provide(NodeServices.layer));
}

const seedProjectAndThread = (harness: OrchestrationIntegrationHarness) =>
  Effect.gen(function* () {
    const createdAt = nowIso();
    const provider = harness.adapterHarness?.provider ?? "codex";
    const defaultModel = DEFAULT_MODEL_BY_PROVIDER[provider];
    const personalSpaceId = SpaceId.makeUnsafe("penkra-personal");

    yield* harness.engine.dispatch({
      type: "space.create",
      commandId: CommandId.makeUnsafe("cmd-space-create"),
      spaceId: personalSpaceId,
      name: "Personal",
      icon: "home",
      createdAt,
    });

    yield* harness.engine.dispatch({
      type: "folder.create",
      commandId: CommandId.makeUnsafe("cmd-project-create"),
      folderId: PROJECT_ID,
      title: "Integration Project",
      workspaceRoot: null,
      spaceId: personalSpaceId,
      defaultModelSelection: {
        provider,
        model: defaultModel,
      },
      createdAt,
    });

    yield* harness.engine.dispatch({
      type: "thread.create",
      commandId: CommandId.makeUnsafe("cmd-thread-create"),
      threadId: THREAD_ID,
      folderId: PROJECT_ID,
      title: "Integration Thread",
      modelSelection: {
        provider,
        model: defaultModel,
      },
      runtimeMode: "approval-required",
      workingDirectory: harness.workspaceDir,
      createdAt,
    });
  });

const startTurn = (input: {
  readonly harness: OrchestrationIntegrationHarness;
  readonly commandId: string;
  readonly messageId: string;
  readonly text: string;
  readonly modelSelection?: ModelSelection;
}) =>
  input.harness.engine.dispatch({
    type: "thread.turn.start",
    commandId: CommandId.makeUnsafe(input.commandId),
    threadId: THREAD_ID,
    message: {
      messageId: asMessageId(input.messageId),
      role: "user",
      text: input.text,
      attachments: [],
    },
    ...(input.modelSelection !== undefined
      ? {
          modelSelection: input.modelSelection,
        }
      : {}),
    connectionId: INTEGRATION_CONNECTION_ID,
    bindingRevision: 0,
    runtimeMode: "approval-required",
    createdAt: nowIso(),
  });

it.live("runs a single turn end-to-end and persists canonical conversation state", () =>
  withHarness((harness) =>
    Effect.gen(function* () {
      yield* seedProjectAndThread(harness);

      const turnResponse: TestTurnResponse = {
        events: [
          {
            type: "turn.started",
            ...runtimeBase("evt-single-1", "2026-02-24T10:00:00.000Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
          },
          {
            type: "message.delta",
            ...runtimeBase("evt-single-2", "2026-02-24T10:00:00.100Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
            delta: "Single turn response.\n",
          },
          {
            type: "turn.completed",
            ...runtimeBase("evt-single-3", "2026-02-24T10:00:00.200Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
            status: "completed",
          },
        ],
      };

      yield* harness.adapterHarness!.queueTurnResponseForNextSession(turnResponse);
      yield* startTurn({
        harness,
        commandId: "cmd-turn-start-single",
        messageId: "msg-user-single",
        text: "Say hello",
      });
      const thread = yield* harness.waitForThread(
        THREAD_ID,
        (entry) =>
          entry.session?.status === "ready" &&
          entry.messages.some(
            (message) => message.role === "assistant" && message.streaming === false,
          ),
      );
      assert.isTrue(
        thread.messages.some(
          (message) =>
            message.role === "assistant" &&
            message.text.includes("Single turn response.") &&
            message.streaming === false,
        ),
      );
    }),
  ),
);

it.live.skipIf(!process.env.CODEX_BINARY_PATH)(
  "keeps the same Codex provider thread across runtime mode switches",
  () =>
    withRealCodexHarness((harness) =>
      Effect.gen(function* () {
        const createdAt = nowIso();
        const personalSpaceId = SpaceId.makeUnsafe("penkra-personal-real-codex");

        yield* harness.engine.dispatch({
          type: "space.create",
          commandId: CommandId.makeUnsafe("cmd-space-create-real-codex"),
          spaceId: personalSpaceId,
          name: "Personal",
          icon: "home",
          createdAt,
        });

        yield* harness.engine.dispatch({
          type: "folder.create",
          commandId: CommandId.makeUnsafe("cmd-project-create-real-codex"),
          folderId: PROJECT_ID,
          title: "Integration Project",
          workspaceRoot: null,
          spaceId: personalSpaceId,
          defaultModelSelection: {
            provider: "codex",
            model: "gpt-5.3-codex",
          },
          createdAt,
        });

        yield* harness.engine.dispatch({
          type: "thread.create",
          commandId: CommandId.makeUnsafe("cmd-thread-create-real-codex"),
          threadId: THREAD_ID,
          folderId: PROJECT_ID,
          title: "Integration Thread",
          modelSelection: {
            provider: "codex",
            model: "gpt-5.3-codex",
          },
          runtimeMode: "full-access",
          workingDirectory: harness.workspaceDir,
          createdAt,
        });

        yield* harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.makeUnsafe("cmd-turn-start-real-codex-1"),
          threadId: THREAD_ID,
          message: {
            messageId: asMessageId("msg-real-codex-1"),
            role: "user",
            text: "Reply with exactly ALPHA.",
            attachments: [],
          },
          runtimeMode: "full-access",
          createdAt: nowIso(),
        });

        const firstThread = yield* harness.waitForThread(
          THREAD_ID,
          (entry) =>
            entry.session?.status === "ready" &&
            entry.session.providerName === "codex" &&
            entry.messages.some(
              (message) => message.role === "assistant" && message.streaming === false,
            ),
          180_000,
        );
        assert.equal(firstThread.session?.threadId, "thread-1");

        yield* harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.makeUnsafe("cmd-turn-start-real-codex-2"),
          threadId: THREAD_ID,
          message: {
            messageId: asMessageId("msg-real-codex-2"),
            role: "user",
            text: "Reply with exactly BETA.",
            attachments: [],
          },
          connectionId: INTEGRATION_CONNECTION_ID,
          bindingRevision: 0,
          runtimeMode: "approval-required",
          createdAt: nowIso(),
        });

        const secondThread = yield* harness.waitForThread(
          THREAD_ID,
          (entry) =>
            entry.session?.status === "ready" &&
            entry.session.providerName === "codex" &&
            entry.session.runtimeMode === "approval-required" &&
            entry.messages.some(
              (message) => message.role === "assistant" && message.text.includes("BETA"),
            ),
          180_000,
        );
        assert.equal(secondThread.session?.threadId, "thread-1");
      }),
    ),
);

it.live("tracks approval requests and resolves pending approvals on user response", () =>
  withHarness((harness) =>
    Effect.gen(function* () {
      yield* seedProjectAndThread(harness);

      yield* harness.adapterHarness!.queueTurnResponseForNextSession({
        deferCompletion: true,
        events: [
          {
            type: "turn.started",
            ...runtimeBase("evt-approval-1", "2026-02-24T10:03:00.000Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
          },
          {
            type: "approval.requested",
            ...runtimeBase("evt-approval-2", "2026-02-24T10:03:00.100Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
            requestId: APPROVAL_REQUEST_ID,
            requestKind: "command",
            detail: "Approve command execution",
          },
          {
            type: "turn.completed",
            ...runtimeBase("evt-approval-3", "2026-02-24T10:03:00.200Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
            status: "completed",
          },
        ],
      });

      yield* startTurn({
        harness,
        commandId: "cmd-turn-start-approval",
        messageId: "msg-user-approval",
        text: "Run command needing approval",
      });

      const thread = yield* harness.waitForThread(THREAD_ID, (entry) =>
        entry.activities.some((activity) => activity.kind === "approval.requested"),
      );
      assert.equal(
        thread.activities.some((activity) => activity.kind === "approval.requested"),
        true,
      );

      const pendingRow = yield* harness.waitForPendingApproval(
        THREAD_ID,
        "req-approval-1",
        (row) => row.status === "pending" && row.decision === null,
      );
      assert.equal(pendingRow.status, "pending");
      assert.notEqual(pendingRow.lifecycleGeneration, null);

      yield* harness.engine.dispatch({
        type: "thread.approval.respond",
        commandId: CommandId.makeUnsafe("cmd-approval-respond"),
        threadId: THREAD_ID,
        requestId: APPROVAL_REQUEST_ID,
        lifecycleGeneration: pendingRow.lifecycleGeneration!,
        decision: "accept",
        createdAt: nowIso(),
      });

      const resolvedRow = yield* harness.waitForPendingApproval(
        THREAD_ID,
        "req-approval-1",
        (row) => row.status === "confirmed" && row.decision === "accept",
      );
      assert.equal(resolvedRow.status, "confirmed");
      assert.equal(resolvedRow.decision, "accept");

      const approvalResponses = yield* waitForSync(
        () => harness.adapterHarness!.getApprovalResponses(THREAD_ID),
        (responses) => responses.length === 1,
        "provider approval response",
      );
      assert.equal(approvalResponses.length, 1);
      assert.equal(approvalResponses[0]?.requestId, "req-approval-1");
      assert.equal(approvalResponses[0]?.decision, "accept");
    }),
  ),
);

it.live("records failed turn runtime state as error", () =>
  withHarness((harness) =>
    Effect.gen(function* () {
      yield* seedProjectAndThread(harness);

      yield* harness.adapterHarness!.queueTurnResponseForNextSession({
        events: [
          {
            type: "turn.started",
            ...runtimeBase("evt-failure-1", "2026-02-24T10:04:00.000Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
          },
          {
            type: "content.delta",
            ...runtimeBase("evt-failure-2", "2026-02-24T10:04:00.100Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
            payload: {
              streamKind: "assistant_text",
              delta: "Partial output before failure.\n",
            },
          },
          {
            type: "runtime.error",
            ...runtimeBase("evt-failure-3", "2026-02-24T10:04:00.200Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
            payload: {
              message: "Sandbox command failed.",
            },
          },
          {
            type: "turn.completed",
            ...runtimeBase("evt-failure-4", "2026-02-24T10:04:00.300Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
            payload: {
              state: "failed",
              errorMessage: "Sandbox command failed.",
            },
          },
        ],
      });

      yield* startTurn({
        harness,
        commandId: "cmd-turn-start-failure",
        messageId: "msg-user-failure",
        text: "Run risky command",
      });

      const thread = yield* harness.waitForThread(
        THREAD_ID,
        (entry) =>
          entry.session?.status === "error" &&
          entry.session?.lastError === "Sandbox command failed." &&
          entry.activities.some((activity) => activity.kind === "runtime.error"),
      );
      assert.equal(thread.session?.status, "error");
      assert.equal(thread.session?.lastError, "Sandbox command failed.");
    }),
  ),
);

it.live("starts a claudeAgent session on first turn when provider is requested", () =>
  withHarness(
    (harness) =>
      Effect.gen(function* () {
        yield* seedProjectAndThread(harness);

        yield* harness.adapterHarness!.queueTurnResponseForNextSession({
          events: [
            {
              type: "turn.started",
              ...runtimeBase("evt-claude-start-1", "2026-02-24T10:10:00.000Z", "claudeAgent"),
              threadId: THREAD_ID,
              turnId: FIXTURE_TURN_ID,
            },
            {
              type: "message.delta",
              ...runtimeBase("evt-claude-start-2", "2026-02-24T10:10:00.050Z", "claudeAgent"),
              threadId: THREAD_ID,
              turnId: FIXTURE_TURN_ID,
              delta: "Claude first turn.\n",
            },
            {
              type: "turn.completed",
              ...runtimeBase("evt-claude-start-3", "2026-02-24T10:10:00.100Z", "claudeAgent"),
              threadId: THREAD_ID,
              turnId: FIXTURE_TURN_ID,
              status: "completed",
            },
          ],
        });

        yield* startTurn({
          harness,
          commandId: "cmd-turn-start-claude-initial",
          messageId: "msg-user-claude-initial",
          text: "Use Claude",
          modelSelection: {
            provider: "claudeAgent",
            model: "claude-sonnet-4-6",
          },
        });

        const thread = yield* harness.waitForThread(
          THREAD_ID,
          (entry) =>
            entry.session?.providerName === "claudeAgent" &&
            entry.session.status === "ready" &&
            entry.messages.some(
              (message) => message.role === "assistant" && message.text === "Claude first turn.\n",
            ),
        );
        assert.equal(thread.session?.providerName, "claudeAgent");
      }),
    "claudeAgent",
  ),
);

itLiveUnlessCi(
  "recovers claudeAgent sessions after provider stopAll using persisted resume state",
  () =>
    withHarness(
      (harness) =>
        Effect.gen(function* () {
          yield* seedProjectAndThread(harness);

          yield* harness.adapterHarness!.queueTurnResponseForNextSession({
            events: [
              {
                type: "turn.started",
                ...runtimeBase("evt-claude-recover-1", "2026-02-24T10:11:00.000Z", "claudeAgent"),
                threadId: THREAD_ID,
                turnId: FIXTURE_TURN_ID,
              },
              {
                type: "message.delta",
                ...runtimeBase("evt-claude-recover-2", "2026-02-24T10:11:00.050Z", "claudeAgent"),
                threadId: THREAD_ID,
                turnId: FIXTURE_TURN_ID,
                delta: "Turn before restart.\n",
              },
              {
                type: "turn.completed",
                ...runtimeBase("evt-claude-recover-3", "2026-02-24T10:11:00.100Z", "claudeAgent"),
                threadId: THREAD_ID,
                turnId: FIXTURE_TURN_ID,
                status: "completed",
              },
            ],
          });

          yield* startTurn({
            harness,
            commandId: "cmd-turn-start-claude-recover-1",
            messageId: "msg-user-claude-recover-1",
            text: "Before restart",
            modelSelection: {
              provider: "claudeAgent",
              model: "claude-sonnet-4-6",
            },
          });

          yield* harness.waitForThread(
            THREAD_ID,
            (entry) =>
              entry.latestTurn?.turnId === "turn-1" && entry.session?.threadId === "thread-1",
          );
          yield* harness.adapterHarness!.adapter.stopAll();
          yield* waitForSync(
            () => harness.adapterHarness!.listActiveSessionIds(),
            (sessionIds) => sessionIds.length === 0,
            "provider stopAll",
          );

          yield* harness.adapterHarness!.queueTurnResponseForNextSession({
            events: [
              {
                type: "turn.started",
                ...runtimeBase("evt-claude-recover-4", "2026-02-24T10:11:01.000Z", "claudeAgent"),
                threadId: THREAD_ID,
                turnId: FIXTURE_TURN_ID,
              },
              {
                type: "message.delta",
                ...runtimeBase("evt-claude-recover-5", "2026-02-24T10:11:01.050Z", "claudeAgent"),
                threadId: THREAD_ID,
                turnId: FIXTURE_TURN_ID,
                delta: "Turn after restart.\n",
              },
              {
                type: "turn.completed",
                ...runtimeBase("evt-claude-recover-6", "2026-02-24T10:11:01.100Z", "claudeAgent"),
                threadId: THREAD_ID,
                turnId: FIXTURE_TURN_ID,
                status: "completed",
              },
            ],
          });

          yield* startTurn({
            harness,
            commandId: "cmd-turn-start-claude-recover-2",
            messageId: "msg-user-claude-recover-2",
            text: "After restart",
          });
          yield* waitForSync(
            () => harness.adapterHarness!.getStartCount(),
            (count) => count >= 2,
            "claude provider recovery start",
            10_000,
          );

          const recoveredThread = yield* harness.waitForThread(
            THREAD_ID,
            (entry) =>
              entry.session?.providerName === "claudeAgent" &&
              entry.messages.some(
                (message) => message.role === "user" && message.text === "After restart",
              ) &&
              !entry.activities.some((activity) => activity.kind === "provider.turn.start.failed"),
          );
          assert.equal(recoveredThread.session?.providerName, "claudeAgent");
          assert.equal(recoveredThread.session?.threadId, "thread-1");
        }),
      "claudeAgent",
    ),
);

it.live("forwards claudeAgent approval responses to the provider session", () =>
  withHarness(
    (harness) =>
      Effect.gen(function* () {
        yield* seedProjectAndThread(harness);

        yield* harness.adapterHarness!.queueTurnResponseForNextSession({
          deferCompletion: true,
          events: [
            {
              type: "turn.started",
              ...runtimeBase("evt-claude-approval-1", "2026-02-24T10:12:00.000Z", "claudeAgent"),
              threadId: THREAD_ID,
              turnId: FIXTURE_TURN_ID,
            },
            {
              type: "approval.requested",
              ...runtimeBase("evt-claude-approval-2", "2026-02-24T10:12:00.050Z", "claudeAgent"),
              threadId: THREAD_ID,
              turnId: FIXTURE_TURN_ID,
              requestId: APPROVAL_REQUEST_ID,
              requestKind: "command",
              detail: "Approve Claude tool call",
            },
            {
              type: "turn.completed",
              ...runtimeBase("evt-claude-approval-3", "2026-02-24T10:12:00.100Z", "claudeAgent"),
              threadId: THREAD_ID,
              turnId: FIXTURE_TURN_ID,
              status: "completed",
            },
          ],
        });

        yield* startTurn({
          harness,
          commandId: "cmd-turn-start-claude-approval",
          messageId: "msg-user-claude-approval",
          text: "Need approval",
          modelSelection: {
            provider: "claudeAgent",
            model: "claude-sonnet-4-6",
          },
        });

        const thread = yield* harness.waitForThread(THREAD_ID, (entry) =>
          entry.activities.some((activity) => activity.kind === "approval.requested"),
        );
        assert.equal(thread.session?.threadId, "thread-1");

        const pendingRow = yield* harness.waitForPendingApproval(
          THREAD_ID,
          "req-approval-1",
          (row) => row.status === "pending" && row.lifecycleGeneration !== null,
        );

        yield* harness.engine.dispatch({
          type: "thread.approval.respond",
          commandId: CommandId.makeUnsafe("cmd-claude-approval-respond"),
          threadId: THREAD_ID,
          requestId: APPROVAL_REQUEST_ID,
          lifecycleGeneration: pendingRow.lifecycleGeneration!,
          decision: "accept",
          createdAt: nowIso(),
        });

        yield* harness.waitForPendingApproval(
          THREAD_ID,
          "req-approval-1",
          (row) => row.status === "confirmed" && row.decision === "accept",
        );

        const approvalResponses = yield* waitForSync(
          () => harness.adapterHarness!.getApprovalResponses(THREAD_ID),
          (responses) => responses.length === 1,
          "claude provider approval response",
        );
        assert.equal(approvalResponses[0]?.decision, "accept");
      }),
    "claudeAgent",
  ),
);

it.live("forwards thread.turn.interrupt to claudeAgent provider sessions", () =>
  withHarness(
    (harness) =>
      Effect.gen(function* () {
        yield* seedProjectAndThread(harness);

        yield* harness.adapterHarness!.queueTurnResponseForNextSession({
          deferCompletion: true,
          events: [
            {
              type: "turn.started",
              ...runtimeBase("evt-claude-interrupt-1", "2026-02-24T10:13:00.000Z", "claudeAgent"),
              threadId: THREAD_ID,
              turnId: FIXTURE_TURN_ID,
            },
            {
              type: "message.delta",
              ...runtimeBase("evt-claude-interrupt-2", "2026-02-24T10:13:00.050Z", "claudeAgent"),
              threadId: THREAD_ID,
              turnId: FIXTURE_TURN_ID,
              delta: "Long running output.\n",
            },
            {
              type: "turn.completed",
              ...runtimeBase("evt-claude-interrupt-3", "2026-02-24T10:13:00.100Z", "claudeAgent"),
              threadId: THREAD_ID,
              turnId: FIXTURE_TURN_ID,
              status: "completed",
            },
          ],
        });

        yield* startTurn({
          harness,
          commandId: "cmd-turn-start-claude-interrupt",
          messageId: "msg-user-claude-interrupt",
          text: "Start long turn",
          modelSelection: {
            provider: "claudeAgent",
            model: "claude-sonnet-4-6",
          },
        });

        const thread = yield* harness.waitForThread(
          THREAD_ID,
          (entry) => entry.session?.threadId === "thread-1",
        );
        assert.equal(thread.session?.threadId, "thread-1");

        yield* harness.engine.dispatch({
          type: "thread.turn.interrupt",
          commandId: CommandId.makeUnsafe("cmd-turn-interrupt-claude"),
          threadId: THREAD_ID,
          createdAt: nowIso(),
        });
        yield* harness.waitForDomainEvent(
          (event) => event.type === "thread.turn-interrupt-requested",
        );

        const interruptCalls = yield* waitForSync(
          () => harness.adapterHarness!.getInterruptCalls(THREAD_ID),
          (calls) => calls.length === 1,
          "claude provider interrupt call",
        );
        assert.equal(interruptCalls.length, 1);
      }),
    "claudeAgent",
  ),
);
