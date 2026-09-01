import { type ChildProcess, type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

import {
  ApprovalRequestId,
  EventId,
  MessageId,
  type ProviderComposerCapabilities,
  ProviderItemId,
  type ProviderListModelsResult,
  type ProviderListPluginsResult,
  type ProviderMentionReference,
  type ProviderForkThreadInput,
  type ProviderReadPluginResult,
  type ProviderForkThreadResult,
  type ProviderListSkillsResult,
  type ProviderListPluginsInput,
  type ProviderReadPluginInput,
  type ProviderStartReviewInput,
  type ProviderSkillReference,
  ProviderRequestKind,
  type ProviderUserInputAnswers,
  ThreadId,
  TurnId,
  type ProviderApprovalDecision,
  type ProviderEvent,
  type ProviderSession,
  type ProviderSessionStartInput,
  type ProviderTurnStartResult,
  RuntimeMode,
  type ServerVoiceTranscriptionInput,
  type ServerVoiceTranscriptionResult,
  type UserInputQuestion,
} from "@penkra/contracts";
import { getModelSelectionBooleanOptionValue, normalizeModelSlug } from "@penkra/shared/model";
import { PENDING_INTERACTION_NOT_FOUND_FAILURE_CODE } from "@penkra/shared/threadSummary";
import { decodeSubagentReceiverThreadIds } from "@penkra/shared/subagents";
import { prepareWindowsSafeProcess } from "@penkra/shared/windowsProcess";
import { Effect, ServiceMap } from "effect";

import {
  formatCodexCliUpgradeMessage,
  isCodexCliVersionSupported,
  parseCodexCliVersion,
} from "./provider/codexCliVersion";
import { PENKRA_AGENT_GATEWAY_TOKEN_ENV } from "./agentGateway/mcpInjection.ts";
import { PENKRA_HOST_POLICY } from "./agentGateway/harnessPolicy.ts";
import type { AgentGatewaySessionLease } from "./agentGateway/sessionLease.ts";
import type { AgentGatewayNativeToolSurface } from "./agentGateway/Services/AgentGatewayToolBridge.ts";
import { isNonFatalCodexErrorMessage } from "./codexErrorClassification.ts";
import { buildCodexProcessEnv } from "./codexProcessEnv.ts";
import { assertCodexWorkingDirectoryExists } from "./codexWorkingDirectory.ts";
import { executableIdentity, resolveExecutable } from "./executableLookup.ts";
import {
  teardownChildProcessTree,
  teardownProviderProcessTree,
} from "./provider/supervisedProcessTeardown.ts";
import { ensureIsolatedScratchWorkspace } from "./scratchWorkspaces.ts";
import type { ProviderManagedLaunchContext } from "./provider/Services/ProviderAdapter.ts";
import {
  adoptManagedCodexRollout,
  prepareManagedCodexResume,
} from "./provider/codexManagedNativeState.ts";
import { createLogger } from "./logger";
import { transcribeVoiceWithChatGptSession } from "./voiceTranscription.ts";
import {
  CodexAppServerTransportError,
  CodexJsonlFramer,
  CodexJsonlWriter,
} from "./codexAppServerTransport.ts";
import { buildCodexTurnInput, type CodexTurnInputItem } from "./codexTurnInput.ts";
import {
  parseCodexModelListResponse,
  parseCodexPluginListResponse,
  parseCodexPluginReadResponse,
  parseCodexSkillsListResponse,
} from "./provider/codexDiscoveryCatalog.ts";
import {
  classifyComputerUseCapability,
  type ComputerUseCapabilityHealth,
  type McpStartupStatusEntry,
  type McpToolInventoryEntry,
} from "./provider/computerUseCapability.ts";
import {
  CodexConversationHistoryMutationUnavailableError,
  type CodexConversationHistoryMutationCapability,
  resolveCodexConversationHistoryMutationCapability,
} from "./provider/codexConversationHistoryCapability.ts";

const log = createLogger("codex");

type PendingRequestKey = string;

class CodexPendingInteractionNotFoundError extends Error {
  readonly code = PENDING_INTERACTION_NOT_FOUND_FAILURE_CODE;
}

export function buildCodexDynamicTools(definitions: AgentGatewayNativeToolSurface["definitions"]) {
  return definitions.map((definition) => ({
    type: "function" as const,
    name: definition.name,
    description: definition.description,
    inputSchema: definition.inputSchema,
    deferLoading: false,
  }));
}

interface PendingRequest {
  method: string;
  timeout: ReturnType<typeof setTimeout>;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

interface PendingApprovalRequest {
  requestId: ApprovalRequestId;
  jsonRpcId: string | number;
  method:
    | "item/commandExecution/requestApproval"
    | "item/fileChange/requestApproval"
    | "item/fileRead/requestApproval";
  requestKind: ProviderRequestKind;
  threadId: ThreadId;
  turnId?: TurnId;
  parentTurnId?: TurnId;
  itemId?: ProviderItemId;
  providerThreadId?: string;
  providerParentThreadId?: string;
}

interface PendingUserInputRequest {
  requestId: ApprovalRequestId;
  jsonRpcId: string | number;
  threadId: ThreadId;
  turnId?: TurnId;
  parentTurnId?: TurnId;
  itemId?: ProviderItemId;
  providerThreadId?: string;
  providerParentThreadId?: string;
}

interface ResolvedCollaborationRoute {
  readonly parentTurnId?: TurnId;
  readonly providerThreadId?: string;
  readonly providerParentThreadId?: string;
  readonly isChildConversation: boolean;
}

interface CodexUserInputAnswer {
  answers: string[];
}

type CodexApprovalPolicy = "untrusted" | "on-failure" | "on-request" | "never";
type CodexSandboxMode = "read-only" | "workspace-write" | "danger-full-access";
type CodexTurnSandboxPolicy = {
  readonly type: "readOnly" | "workspaceWrite" | "dangerFullAccess";
};
type CodexSessionApprovalOverride = {
  readonly approvalPolicy: "never";
  readonly sandboxPolicy: {
    readonly type: "dangerFullAccess";
  };
};

interface CodexSessionContext {
  readonly gatewaySessionLease?: AgentGatewaySessionLease;
  session: ProviderSession;
  lifecycleGeneration?: string;
  account: CodexAccountSnapshot;
  child: ChildProcessWithoutNullStreams;
  binaryPath?: string;
  stdoutFramer: CodexJsonlFramer;
  stdinWriter: CodexJsonlWriter;
  stderrTail?: string;
  lastRequestMethod?: string;
  threadOpenRequestSent?: boolean;
  transportFailureHandled?: boolean;
  stdoutEndTimer?: ReturnType<typeof setTimeout>;
  detachStdout?: () => void;
  pending: Map<PendingRequestKey, PendingRequest>;
  pendingApprovals: Map<ApprovalRequestId, PendingApprovalRequest>;
  pendingUserInputs: Map<ApprovalRequestId, PendingUserInputRequest>;
  sessionApprovalOverride?: CodexSessionApprovalOverride;
  collabReceiverTurns: Map<string, TurnId>;
  collabReceiverParents: Map<string, string>;
  reviewTurnIds: Set<TurnId>;
  /**
   * Turn ids that reached a terminal lifecycle edge in this app-server
   * session. Codex may continue emitting output from background command items
   * after the parent turn completes. Those notifications remain useful
   * activity, but they are not evidence that the turn became active again.
   */
  terminalTurnIds: Set<TurnId>;
  mcpStartupStatuses: Map<string, McpStartupStatusEntry>;
  computerUseHealth?: ComputerUseCapabilityHealth;
  taskCompleteFallback?:
    | {
        readonly turnId: TurnId;
        readonly timeout: ReturnType<typeof setTimeout>;
      }
    | undefined;
  nextRequestId: number;
  stopping: boolean;
  stopPromise?: Promise<void>;
  discovery?: boolean;
  conversationHistoryMutationCapability?: Exclude<
    CodexConversationHistoryMutationCapability,
    { readonly state: "unavailable-until-session-open" }
  >;
}

interface CodexSkillListInput {
  readonly cwd: string;
  readonly forceReload?: boolean;
  readonly threadId?: string;
}

interface CodexPluginListInput extends Omit<ProviderListPluginsInput, "provider"> {}

interface CodexPluginReadInput extends Omit<ProviderReadPluginInput, "provider"> {}

interface JsonRpcError {
  code?: number;
  message?: string;
  data?: unknown;
}

export class CodexJsonRpcRequestError extends Error {
  readonly method: string;
  readonly code?: number;
  readonly rpcMessage: string;
  readonly data?: unknown;

  constructor(input: {
    readonly method: string;
    readonly code?: number;
    readonly rpcMessage: string;
    readonly data?: unknown;
  }) {
    super(`${input.method} failed: ${input.rpcMessage}`);
    this.name = "CodexJsonRpcRequestError";
    this.method = input.method;
    if (input.code !== undefined) this.code = input.code;
    this.rpcMessage = input.rpcMessage;
    if (input.data !== undefined) this.data = input.data;
  }
}

interface JsonRpcRequest {
  id: string | number;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  id: string | number;
  result?: unknown;
  error?: JsonRpcError;
}

interface JsonRpcNotification {
  method: string;
  params?: unknown;
}

function shouldRetrySkillsListWithCwdFallback(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  return (
    message.includes("skills/list failed") &&
    (message.includes("invalid") ||
      message.includes("unknown field") ||
      message.includes("unrecognized field") ||
      message.includes("missing field") ||
      message.includes("expected") ||
      message.includes("cwds"))
  );
}

function shouldRetryPluginListWithoutMarketplaceKinds(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  return (
    message.includes("plugin/list failed") &&
    (message.includes("marketplacekinds") ||
      message.includes("unknown field") ||
      message.includes("unrecognized field"))
  );
}

function isPluginListUnavailable(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  return (
    message.includes("plugin/list") &&
    (message.includes("method not found") || message.includes("unknown method"))
  );
}

type CodexPlanType =
  | "free"
  | "go"
  | "plus"
  | "pro"
  | "team"
  | "business"
  | "enterprise"
  | "edu"
  | "unknown";

interface CodexAccountSnapshot {
  readonly type: "apiKey" | "chatgpt" | "unknown";
  readonly planType: CodexPlanType | null;
  readonly sparkEnabled: boolean;
}

interface CodexVoiceTranscriptionAuthContext {
  readonly authMethod: "chatgpt" | "chatgptAuthTokens";
  readonly token: string;
}

export interface CodexAppServerSendTurnInput {
  readonly threadId: ThreadId;
  readonly clientMessageId?: MessageId;
  readonly input?: string;
  readonly attachments?: ReadonlyArray<{ type: "image"; url: string }>;
  readonly skills?: ReadonlyArray<ProviderSkillReference>;
  readonly mentions?: ReadonlyArray<ProviderMentionReference>;
  readonly model?: string;
  readonly serviceTier?: string | null;
  readonly effort?: string;
}

type CodexAppServerReviewTarget = ProviderStartReviewInput["target"];

export interface CodexAppServerStartSessionInput {
  readonly threadId: ThreadId;
  readonly provider?: "codex";
  readonly lifecycleGeneration?: string;
  readonly cwd?: string;
  readonly model?: string;
  readonly serviceTier?: string;
  readonly resumeCursor?: unknown;
  readonly providerOptions?: ProviderSessionStartInput["providerOptions"];
  readonly managedLaunch?: ProviderManagedLaunchContext;
  readonly runtimeMode: RuntimeMode;
}

export interface CodexThreadTurnSnapshot {
  id: TurnId;
  items: unknown[];
}

export interface CodexThreadSnapshot {
  threadId: string;
  turns: CodexThreadTurnSnapshot[];
  cwd?: string | null;
}

const CODEX_VERSION_CHECK_TIMEOUT_MS = 4_000;
const CODEX_VERSION_CHECK_MAX_OUTPUT_BYTES = 1024 * 1024;
/**
 * How long a successful `codex --version` verdict stays valid. Session start and
 * resume both gate on it, so without memoization every one of those paths spawned a
 * fresh Codex process. Failures are never cached, so installing or upgrading Codex
 * takes effect immediately.
 */
const CODEX_VERSION_CHECK_CACHE_TTL_MS = 10 * 60 * 1000;

const ANSI_ESCAPE_CHAR = String.fromCharCode(27);
const ANSI_ESCAPE_REGEX = new RegExp(`${ANSI_ESCAPE_CHAR}\\[[0-9;]*m`, "g");
const CODEX_STDERR_LOG_REGEX =
  /^\d{4}-\d{2}-\d{2}T\S+\s+(TRACE|DEBUG|INFO|WARN|ERROR)\s+\S+:\s+(.*)$/;
const BENIGN_ERROR_LOG_SNIPPETS = [
  "state db missing rollout path for thread",
  "state db record_discrepancy: find_thread_path_by_id_str_in_subdir, falling_back",
];
const BENIGN_PROCESS_OUTPUT_REGEXES = [/^(?:\^C)?Token usage:/i];
const CODEX_DISCOVERY_SESSION_IDLE_MS = 10 * 60 * 1000;
const CODEX_PENDING_SETTLE_DEADLINE_MS = 2_000;
const CODEX_STDERR_TAIL_MAX_BYTES = 64 * 1024;
const CODEX_STDOUT_END_GRACE_MS = 100;

function redactCodexProcessOutput(value: string): string {
  return value
    .replace(
      /((?:authorization|bearer|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token)\s*[:=]\s*)[^\s,;]+/gi,
      "$1[redacted]",
    )
    .replace(/\b(?:sk|sess|eyJ)[A-Za-z0-9._-]{16,}\b/g, "[redacted]");
}

function appendCodexStderrTail(context: CodexSessionContext, chunk: Buffer): void {
  // Redact after joining so a credential split across stream chunks cannot
  // bypass the diagnostic scrubber.
  const combined = redactCodexProcessOutput(`${context.stderrTail ?? ""}${chunk.toString()}`);
  const bytes = Buffer.from(combined);
  context.stderrTail =
    bytes.byteLength <= CODEX_STDERR_TAIL_MAX_BYTES
      ? combined
      : bytes.subarray(bytes.byteLength - CODEX_STDERR_TAIL_MAX_BYTES).toString();
}

function formatCodexProcessFailure(
  context: CodexSessionContext,
  reason: string,
  code: number | null = context.child.exitCode,
  signal: NodeJS.Signals | null = context.child.signalCode,
): string {
  const stderr = context.stderrTail?.trim();
  const metadata = [
    `reason=${reason}`,
    `pid=${context.child.pid ?? "unknown"}`,
    `code=${code ?? "null"}`,
    `signal=${signal ?? "null"}`,
    `request=${context.lastRequestMethod ?? "none"}`,
    `binary=${context.binaryPath ?? "unknown"}`,
    `cwd=${context.session.cwd ?? "unknown"}`,
  ].join(", ");
  return stderr
    ? `Codex app-server failed (${metadata}). stderr:\n${stderr}`
    : `Codex app-server failed (${metadata}).`;
}

export function shouldRetryCodexPreThreadOpenFailure(input: {
  readonly startupAttempt: number;
  readonly aborted: boolean;
  readonly transportFailed: boolean;
  readonly threadOpenRequestSent: boolean;
}): boolean {
  return (
    input.startupAttempt === 0 &&
    !input.aborted &&
    input.transportFailed &&
    !input.threadOpenRequestSent
  );
}

// Bounds the best-effort answers written to parked server requests: a child that
// stopped draining stdin must never hold session teardown hostage.
function withCodexPendingSettleDeadline(settle: Promise<unknown>): Promise<void> {
  return Promise.race([
    settle.then(() => undefined),
    new Promise<void>((resolve) => {
      setTimeout(resolve, CODEX_PENDING_SETTLE_DEADLINE_MS).unref();
    }),
  ]);
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function normalizeCodexProcessLine(rawLine: string): string {
  return rawLine.replaceAll(ANSI_ESCAPE_REGEX, "").trim();
}

function isIgnorableCodexProcessLine(rawLine: string): boolean {
  const line = normalizeCodexProcessLine(rawLine);
  if (!line) {
    return true;
  }
  return BENIGN_PROCESS_OUTPUT_REGEXES.some((pattern) => pattern.test(line));
}

function isCodexProtocolEnvelope(value: Record<string, unknown>): boolean {
  if (typeof value.method === "string") {
    return true;
  }
  const hasId = Object.prototype.hasOwnProperty.call(value, "id");
  return (
    hasId &&
    (Object.prototype.hasOwnProperty.call(value, "result") ||
      Object.prototype.hasOwnProperty.call(value, "error"))
  );
}

function logIgnoredCodexStdout(rawLine: string, reason: string): void {
  log.warn("ignoring non-protocol codex app-server stdout", {
    reason,
    preview: normalizeCodexProcessLine(rawLine).slice(0, 160),
    length: rawLine.length,
  });
}

function normalizeCodexUserVisibleErrorMessage(rawMessage: string): string {
  const message = normalizeCodexProcessLine(rawMessage);

  const duplicateFunctionArgMatch = message.match(
    /failed to parse function arguments: duplicate field `([^`]+)`/i,
  );
  if (duplicateFunctionArgMatch) {
    const fieldName = duplicateFunctionArgMatch[1];
    return `Tool call failed because the same argument was sent twice${fieldName ? ` (${fieldName})` : ""}.`;
  }

  return message;
}

export function readCodexAccountSnapshot(response: unknown): CodexAccountSnapshot {
  const record = asObject(response);
  const account = asObject(record?.account) ?? record;
  const accountType = asString(account?.type);

  if (accountType === "apiKey") {
    return {
      type: "apiKey",
      planType: null,
      sparkEnabled: true,
    };
  }

  if (accountType === "chatgpt") {
    const planType = (account?.planType as CodexPlanType | null) ?? "unknown";
    return {
      type: "chatgpt",
      planType,
      sparkEnabled: true,
    };
  }

  return {
    type: "unknown",
    planType: null,
    sparkEnabled: true,
  };
}

/** The canonical host policy delivered through Codex's developer-instruction channel. */
export const CODEX_DEVELOPER_INSTRUCTIONS = PENKRA_HOST_POLICY;

// Maps Penkra's simple runtime toggle to Codex thread-level permission overrides.
function mapCodexRuntimeMode(runtimeMode: RuntimeMode): {
  readonly approvalPolicy: CodexApprovalPolicy;
  readonly sandbox: CodexSandboxMode;
} {
  switch (runtimeMode) {
    case "approval-required":
      return {
        approvalPolicy: "untrusted",
        sandbox: "read-only",
      };
    case "full-access":
    default:
      return {
        approvalPolicy: "never",
        sandbox: "danger-full-access",
      };
  }
}

// turn/start uses sandboxPolicy objects, so keep this separate from thread/start.
function mapCodexRuntimeModeToTurnOverrides(runtimeMode: RuntimeMode): {
  readonly approvalPolicy: CodexApprovalPolicy;
  readonly sandboxPolicy: CodexTurnSandboxPolicy;
} {
  switch (runtimeMode) {
    case "approval-required":
      return {
        approvalPolicy: "untrusted",
        sandboxPolicy: { type: "readOnly" },
      };
    case "full-access":
    default:
      return {
        approvalPolicy: "never",
        sandboxPolicy: { type: "dangerFullAccess" },
      };
  }
}

const CODEX_ALWAYS_ALLOW_SESSION_TURN_OVERRIDES: CodexSessionApprovalOverride = {
  approvalPolicy: "never",
  sandboxPolicy: { type: "dangerFullAccess" },
};

// Penkra re-sends turn-level Codex permission overrides, so keep "always allow"
// as live session state instead of relying on one native approval reply.
function resolveCodexTurnOverrides(context: CodexSessionContext): {
  readonly approvalPolicy: CodexApprovalPolicy;
  readonly sandboxPolicy: CodexTurnSandboxPolicy;
} {
  return (
    context.sessionApprovalOverride ??
    mapCodexRuntimeModeToTurnOverrides(context.session.runtimeMode)
  );
}

export function resolveCodexModelForAccount(
  model: string | undefined,
  _account: CodexAccountSnapshot,
): string | undefined {
  return model;
}

function spawnCodexAppServer(input: {
  readonly binaryPath: string;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}): ChildProcessWithoutNullStreams {
  const prepared = prepareWindowsSafeProcess(input.binaryPath, ["app-server"], {
    cwd: input.cwd,
    env: input.env,
  });
  return spawn(prepared.command, prepared.args, {
    cwd: input.cwd,
    env: input.env,
    stdio: ["pipe", "pipe", "pipe"],
    shell: prepared.shell,
    windowsHide: prepared.windowsHide,
    windowsVerbatimArguments: prepared.windowsVerbatimArguments,
  });
}

export function normalizeCodexModelSlug(
  model: string | undefined | null,
  preferredId?: string,
): string | undefined {
  const normalized = normalizeModelSlug(model);
  if (!normalized) {
    return undefined;
  }

  if (preferredId?.endsWith("-codex") && preferredId !== normalized) {
    return preferredId;
  }

  return normalized;
}

export function buildCodexInitializeParams() {
  return {
    clientInfo: {
      name: "penkra_desktop",
      title: "Penkra Desktop",
      version: "0.1.0",
    },
    capabilities: {
      experimentalApi: true,
    },
  } as const;
}

function buildCodexCollaborationMode(input: { readonly model: string; readonly effort?: string }): {
  mode: "default";
  settings: {
    model: string;
    reasoning_effort: string;
    developer_instructions: string;
  };
} {
  return {
    mode: "default",
    settings: {
      model: input.model,
      reasoning_effort: input.effort ?? "medium",
      developer_instructions: CODEX_DEVELOPER_INSTRUCTIONS,
    },
  };
}

function toCodexUserInputAnswer(value: unknown): CodexUserInputAnswer {
  if (typeof value === "string") {
    return { answers: [value] };
  }

  if (Array.isArray(value)) {
    const answers = value.filter((entry): entry is string => typeof entry === "string");
    return { answers };
  }

  if (value && typeof value === "object") {
    const maybeAnswers = (value as { answers?: unknown }).answers;
    if (Array.isArray(maybeAnswers)) {
      const answers = maybeAnswers.filter((entry): entry is string => typeof entry === "string");
      return { answers };
    }
  }

  throw new Error("User input answers must be strings or arrays of strings.");
}

function toCodexUserInputAnswers(
  answers: ProviderUserInputAnswers,
): Record<string, CodexUserInputAnswer> {
  return Object.fromEntries(
    Object.entries(answers).map(([questionId, value]) => [
      questionId,
      toCodexUserInputAnswer(value),
    ]),
  );
}

/**
 * Canonical parse of an `item/tool/requestUserInput` payload into renderable
 * questions. This is the single source of truth shared by the manager (which
 * must refuse — and answer — requests it cannot surface) and `CodexAdapter`
 * (which folders them into `user-input.requested`); if the two ever disagree,
 * codex parks forever on a question nobody can see.
 *
 * Deliberately lenient: an option carries its label as its description when
 * codex sends none (the UI hides a description identical to the label), and a
 * question with no options is kept as a free-text prompt.
 */
export function parseCodexUserInputQuestions(
  payload: Record<string, unknown> | undefined,
): UserInputQuestion[] | undefined {
  const questions = payload?.questions;
  if (!Array.isArray(questions)) {
    return undefined;
  }

  const parsedQuestions = questions.flatMap((entry): UserInputQuestion[] => {
    const question = asObject(entry);
    if (!question) {
      return [];
    }
    const id = asString(question.id)?.trim();
    const header = asString(question.header)?.trim();
    const prompt = asString(question.question)?.trim();
    if (!id || !header || !prompt) {
      return [];
    }
    const options = (Array.isArray(question.options) ? question.options : []).flatMap(
      (option): Array<{ label: string; description: string }> => {
        const optionRecord = asObject(option);
        const label = asString(optionRecord?.label)?.trim();
        if (!label) {
          return [];
        }
        const description = asString(optionRecord?.description)?.trim();
        return [{ label, description: description || label }];
      },
    );
    return [
      {
        id,
        header,
        question: prompt,
        options,
        ...(question.multiSelect === true ? { multiSelect: true } : {}),
      },
    ];
  });

  return parsedQuestions.length > 0 ? parsedQuestions : undefined;
}

export function classifyCodexStderrLine(rawLine: string): { message: string } | null {
  if (isIgnorableCodexProcessLine(rawLine)) {
    return null;
  }
  const line = normalizeCodexProcessLine(rawLine);

  const match = line.match(CODEX_STDERR_LOG_REGEX);
  if (match) {
    const level = match[1];
    if (level && level !== "ERROR") {
      return null;
    }

    const isBenignError = BENIGN_ERROR_LOG_SNIPPETS.some((snippet) => line.includes(snippet));
    if (isBenignError) {
      return null;
    }
  }

  return { message: normalizeCodexUserVisibleErrorMessage(line) };
}

export function resumeCodexThreadWithoutHistoryReplay(input: {
  readonly threadId: string;
  readonly sessionOverrides: Readonly<Record<string, unknown>>;
  readonly request: (params: Readonly<Record<string, unknown>>) => Promise<unknown>;
}): Promise<unknown> {
  return input.request({
    ...input.sessionOverrides,
    threadId: input.threadId,
    // Penkra's event journal is the transcript source of truth. Resume only
    // Codex execution state; explicit provider history reads use paginated
    // thread APIs instead of returning all turns in this JSONL response.
    excludeTurns: true,
  });
}

export function inspectCodexThreadActivity(response: unknown): {
  readonly active: boolean;
  readonly activeTurnId?: TurnId;
} {
  const responseRecord = asObject(response);
  const thread = asObject(responseRecord?.thread) ?? responseRecord;
  const statusValue = thread?.status;
  const status =
    asString(statusValue) ??
    asString(asObject(statusValue)?.type) ??
    asString(responseRecord?.status);
  const turns = Array.isArray(thread?.turns)
    ? thread.turns
    : Array.isArray(responseRecord?.turns)
      ? responseRecord.turns
      : [];
  const activeTurn = turns.toReversed().find((value) => {
    const turnStatusValue = asObject(value)?.status;
    const turnStatus = asString(turnStatusValue) ?? asString(asObject(turnStatusValue)?.type) ?? "";
    return ["inProgress", "in_progress", "running", "active"].includes(turnStatus);
  });
  const activeTurnId = toTurnId(asString(asObject(activeTurn)?.id));
  return {
    active: status === "active" || activeTurnId !== undefined,
    ...(activeTurnId ? { activeTurnId } : {}),
  };
}

export interface CodexAppServerManagerEvents {
  event: [event: ProviderEvent];
}

const CODEX_DISCOVERY_CACHE_MAX_ENTRIES = 128;

function getRecentCacheEntry<K, V>(cache: Map<K, V>, key: K): V | undefined {
  const value = cache.get(key);
  if (value === undefined) {
    return undefined;
  }
  cache.delete(key);
  cache.set(key, value);
  return value;
}

function setRecentCacheEntry<K, V>(
  cache: Map<K, V>,
  key: K,
  value: V,
  maxEntries = CODEX_DISCOVERY_CACHE_MAX_ENTRIES,
): void {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > maxEntries) {
    const oldestKey = cache.keys().next().value as K | undefined;
    if (oldestKey === undefined) {
      return;
    }
    cache.delete(oldestKey);
  }
}

export class CodexAppServerManager extends EventEmitter<CodexAppServerManagerEvents> {
  private readonly sessions = new Map<ThreadId, CodexSessionContext>();
  private readonly discoverySessions = new Map<string, CodexSessionContext>();
  private readonly discoverySessionIdleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly skillsCache = new Map<string, ProviderListSkillsResult>();
  private readonly pluginsCache = new Map<string, ProviderListPluginsResult>();
  private readonly pluginDetailCache = new Map<string, ProviderReadPluginResult>();
  private readonly modelCache = new Map<string, ProviderListModelsResult>();

  private runPromise: (effect: Effect.Effect<unknown, never>) => Promise<unknown>;
  private readonly penkraSkillsDir: string | undefined;
  private readonly agentGatewayHostTool:
    | {
        readonly acquireSessionLease: (threadId: ThreadId) => AgentGatewaySessionLease;
        readonly requireNativeSurface: () => AgentGatewayNativeToolSurface;
      }
    | undefined;
  private readonly teardownProcessTree: typeof teardownProviderProcessTree;
  private readonly taskCompleteFallbackGraceMs: number;
  constructor(
    services?: ServiceMap.ServiceMap<never>,
    options?: {
      readonly penkraSkillsDir?: string;
      readonly agentGatewayHostTool?: {
        readonly acquireSessionLease: (threadId: ThreadId) => AgentGatewaySessionLease;
        readonly requireNativeSurface: () => AgentGatewayNativeToolSurface;
      };
      readonly teardownProcessTree?: typeof teardownProviderProcessTree;
      readonly taskCompleteFallbackGraceMs?: number;
    },
  ) {
    super();
    this.runPromise = services ? Effect.runPromiseWith(services) : Effect.runPromise;
    this.penkraSkillsDir = options?.penkraSkillsDir;
    this.agentGatewayHostTool = options?.agentGatewayHostTool;
    this.teardownProcessTree = options?.teardownProcessTree ?? teardownProviderProcessTree;
    this.taskCompleteFallbackGraceMs = Math.max(0, options?.taskCompleteFallbackGraceMs ?? 750);
  }

  // The Penkra MCP server rides on the shared overlay config (no secrets),
  // while the per-thread bearer token travels through the app-server process
  // env referenced by `bearer_token_env_var`.
  private async buildSessionProcessEnv(
    homePath: string | undefined,
    gatewayBearerToken: string | undefined,
    managedLaunch?: ProviderManagedLaunchContext,
  ) {
    const env = managedLaunch
      ? managedLaunch.childEnvironment(process.env)
      : await buildCodexProcessEnv({
          ...(homePath ? { homePath } : {}),
        });
    if (gatewayBearerToken) {
      env[PENKRA_AGENT_GATEWAY_TOKEN_ENV] = gatewayBearerToken;
    }
    return env;
  }

  // Registers `~/.penkra/skills` as a codex skill root so portable skills are
  // first-class: skills/list returns them and turn/start `skill` items inject
  // their instructions. Verified live: skill items with paths outside known
  // roots are silently ignored by codex app-server, so this call is required.
  private async registerPenkraSkillsRoot(
    context: CodexSessionContext,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!this.penkraSkillsDir) {
      return;
    }
    try {
      await this.sendRequest(
        context,
        "skills/extraRoots/set",
        { extraRoots: [this.penkraSkillsDir] },
        undefined,
        signal,
      );
    } catch (error) {
      if (signal?.aborted) throw error;
      // Older codex builds (< extra-roots support) keep working; Penkra-only
      // skills simply stay invisible to codex on those versions.
      log.warn("skills/extraRoots/set unavailable", { error });
    }
  }

  /**
   * Codex refreshes plugin catalogs in the background when app-server starts.
   * `plugin/list` is the provider-owned barrier that waits for configured local
   * plugin caches to reconcile. Run it before opening the thread, then invalidate
   * the skill cache, so the first user turn cannot race plugin materialization.
   */
  private async reconcileConfiguredPluginsBeforeThreadOpen(
    context: CodexSessionContext,
    cwd: string,
    signal?: AbortSignal,
  ): Promise<void> {
    try {
      try {
        await this.sendRequest(
          context,
          "plugin/list",
          { cwds: [cwd], marketplaceKinds: ["local"] },
          undefined,
          signal,
        );
      } catch (error) {
        if (signal?.aborted) throw error;
        if (!shouldRetryPluginListWithoutMarketplaceKinds(error)) throw error;
        await this.sendRequest(context, "plugin/list", { cwds: [cwd] }, undefined, signal);
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      if (isPluginListUnavailable(error)) {
        log.warn("Codex plugin reconciliation is unavailable in this runtime", { error });
        return;
      }
      throw error;
    }

    try {
      await this.sendRequest(
        context,
        "skills/list",
        { cwds: [cwd], forceReload: true },
        undefined,
        signal,
      );
    } catch (error) {
      if (signal?.aborted) throw error;
      if (!shouldRetrySkillsListWithCwdFallback(error)) throw error;
      await this.sendRequest(context, "skills/list", { cwd, forceReload: true }, undefined, signal);
    }
  }

  async startSession(
    input: CodexAppServerStartSessionInput,
    signal?: AbortSignal,
  ): Promise<ProviderSession> {
    return this.startSessionAttempt(input, signal, 0);
  }

  private async startSessionAttempt(
    input: CodexAppServerStartSessionInput,
    signal: AbortSignal | undefined,
    startupAttempt: number,
  ): Promise<ProviderSession> {
    const threadId = input.threadId;
    const now = new Date().toISOString();
    let context: CodexSessionContext | undefined;
    let gatewaySessionLease: AgentGatewaySessionLease | undefined;

    try {
      const existing = this.sessions.get(threadId);
      if (existing) {
        await this.stopSession(threadId);
      }

      const resolvedCwd = input.cwd ?? ensureIsolatedScratchWorkspace(threadId);

      const session: ProviderSession = {
        provider: "codex",
        status: "connecting",
        runtimeMode: input.runtimeMode,
        model: normalizeCodexModelSlug(input.model),
        cwd: resolvedCwd,
        threadId,
        createdAt: now,
        updatedAt: now,
      };

      const codexOptions = readCodexProviderOptions(input);
      const codexBinaryPath = input.managedLaunch?.binaryPath ?? codexOptions.binaryPath ?? "codex";
      const codexHomePath = codexOptions.homePath;
      if (!input.managedLaunch) {
        await this.assertSupportedCodexCliVersion({
          binaryPath: codexBinaryPath,
          cwd: resolvedCwd,
          ...(codexHomePath ? { homePath: codexHomePath } : {}),
        });
      }
      const resumeThreadId = readResumeThreadId(input);
      gatewaySessionLease = this.agentGatewayHostTool?.acquireSessionLease(threadId);
      const child = spawnCodexAppServer({
        binaryPath: codexBinaryPath,
        cwd: resolvedCwd,
        env: await this.buildSessionProcessEnv(
          codexHomePath,
          gatewaySessionLease?.connection.bearerToken,
          input.managedLaunch,
        ),
      });

      context = {
        ...(gatewaySessionLease ? { gatewaySessionLease } : {}),
        session,
        ...(input.lifecycleGeneration !== undefined
          ? { lifecycleGeneration: input.lifecycleGeneration }
          : {}),
        account: {
          type: "unknown",
          planType: null,
          sparkEnabled: true,
        },
        child,
        binaryPath: codexBinaryPath,
        stdoutFramer: new CodexJsonlFramer(),
        stdinWriter: new CodexJsonlWriter(child.stdin),
        pending: new Map(),
        pendingApprovals: new Map(),
        pendingUserInputs: new Map(),
        collabReceiverTurns: new Map(),
        collabReceiverParents: new Map(),
        reviewTurnIds: new Set(),
        terminalTurnIds: new Set(),
        mcpStartupStatuses: new Map(),
        nextRequestId: 1,
        stopping: false,
      };

      const activeContext = context;
      this.sessions.set(threadId, context);
      this.attachProcessListeners(context);

      this.emitLifecycleEvent(context, "session/connecting", "Starting codex app-server");

      await this.sendRequest(
        context,
        "initialize",
        buildCodexInitializeParams(),
        undefined,
        signal,
      );

      await this.writeMessage(context, { method: "initialized" });
      await this.registerPenkraSkillsRoot(context, signal);
      await this.reconcileConfiguredPluginsBeforeThreadOpen(context, resolvedCwd, signal);
      try {
        const modelListResponse = await this.sendRequest(
          context,
          "model/list",
          {},
          undefined,
          signal,
        );
        log.info("model/list response", { modelListResponse });
      } catch (error) {
        if (signal?.aborted) throw error;
        log.warn("model/list failed", { error });
      }
      try {
        const accountReadResponse = await this.sendRequest(
          context,
          "account/read",
          {},
          undefined,
          signal,
        );
        log.info("account/read response", { accountReadResponse });
        context.account = readCodexAccountSnapshot(accountReadResponse);
        log.info("subscription status", {
          type: context.account.type,
          planType: context.account.planType,
          sparkEnabled: context.account.sparkEnabled,
        });
      } catch (error) {
        if (signal?.aborted) throw error;
        log.warn("account/read failed", { error });
      }

      const normalizedModel = resolveCodexModelForAccount(
        normalizeCodexModelSlug(input.model),
        context.account,
      );
      const sessionOverrides = {
        model: normalizedModel ?? null,
        ...(input.serviceTier !== undefined ? { serviceTier: input.serviceTier } : {}),
        cwd: resolvedCwd,
        ...mapCodexRuntimeMode(input.runtimeMode ?? "full-access"),
      };

      const threadStartParams = {
        ...sessionOverrides,
        experimentalRawEvents: false,
        ...(gatewaySessionLease && this.agentGatewayHostTool
          ? {
              dynamicTools: buildCodexDynamicTools(
                this.agentGatewayHostTool.requireNativeSurface().definitions,
              ),
            }
          : {}),
      };
      this.emitLifecycleEvent(
        context,
        "session/threadOpenRequested",
        resumeThreadId
          ? `Attempting to resume thread ${resumeThreadId}.`
          : "Starting a new Codex thread.",
      );
      await Effect.logInfo("codex app-server opening thread", {
        threadId,
        requestedRuntimeMode: input.runtimeMode,
        requestedModel: normalizedModel ?? null,
        requestedCwd: resolvedCwd,
        resumeThreadId: resumeThreadId ?? null,
      }).pipe(this.runPromise);

      let threadOpenMethod: "thread/start" | "thread/resume" = "thread/start";
      let threadOpenResponse: unknown;
      // Any retry after this boundary could create a duplicate native thread or
      // race a resume whose response was lost. Startup retries are therefore
      // limited to app-server failures before this flag is set.
      context.threadOpenRequestSent = true;
      if (resumeThreadId) {
        try {
          threadOpenMethod = "thread/resume";
          threadOpenResponse = await resumeCodexThreadWithoutHistoryReplay({
            threadId: resumeThreadId,
            sessionOverrides,
            request: (params) =>
              this.sendRequest(activeContext, "thread/resume", params, undefined, signal),
          });
        } catch (error) {
          this.emitErrorEvent(
            context,
            "session/threadResumeFailed",
            error instanceof Error ? error.message : "Codex thread resume failed.",
          );
          await Effect.logWarning("codex app-server thread resume failed", {
            threadId,
            requestedRuntimeMode: input.runtimeMode,
            resumeThreadId,
            cause: error instanceof Error ? error.message : String(error),
          }).pipe(this.runPromise);
          throw error;
        }
      } else {
        threadOpenMethod = "thread/start";
        threadOpenResponse = await this.sendRequest(
          context,
          "thread/start",
          threadStartParams,
          undefined,
          signal,
        );
      }

      let resumedActivity = inspectCodexThreadActivity(threadOpenResponse);
      if (
        threadOpenMethod === "thread/resume" &&
        resumedActivity.active &&
        resumedActivity.activeTurnId === undefined &&
        context.session.activeTurnId === undefined
      ) {
        // `thread/resume` may omit turns while still reporting an active thread.
        // Read once to recover the running turn id; without it Penkra cannot
        // associate subsequent deltas or render a controllable live turn.
        if (!resumeThreadId) {
          throw new Error("Active thread/resume response is missing its requested thread id.");
        }
        const activeThreadResponse = await this.sendRequest(
          context,
          "thread/read",
          { threadId: resumeThreadId, includeTurns: true },
          undefined,
          signal,
        );
        resumedActivity = inspectCodexThreadActivity(activeThreadResponse);
      }

      const threadOpenRecord = this.readObject(threadOpenResponse);
      const threadIdRaw =
        this.readString(this.readObject(threadOpenRecord, "thread"), "id") ??
        this.readString(threadOpenRecord, "threadId");
      if (!threadIdRaw) {
        throw new Error(`${threadOpenMethod} response did not include a thread id.`);
      }
      const providerThreadId = threadIdRaw;
      context.conversationHistoryMutationCapability =
        resolveCodexConversationHistoryMutationCapability(threadOpenResponse);

      const activeTurnAlreadyObserved = context.session.activeTurnId;
      const resumedActiveTurnId = activeTurnAlreadyObserved ?? resumedActivity.activeTurnId;
      const shouldEmitRecoveredTurnStart =
        activeTurnAlreadyObserved === undefined && resumedActivity.activeTurnId !== undefined;
      this.updateSession(context, {
        status: resumedActiveTurnId ? "running" : "ready",
        resumeCursor: { threadId: providerThreadId },
        activeTurnId: resumedActiveTurnId,
      });
      this.emitLifecycleEvent(
        context,
        "session/threadOpenResolved",
        `Codex ${threadOpenMethod} resolved.`,
      );
      await Effect.logInfo("codex app-server thread open resolved", {
        threadId,
        threadOpenMethod,
        requestedResumeThreadId: resumeThreadId ?? null,
        resolvedThreadId: providerThreadId,
        requestedRuntimeMode: input.runtimeMode,
      }).pipe(this.runPromise);
      if (resumedActiveTurnId && shouldEmitRecoveredTurnStart) {
        this.emitEvent({
          id: EventId.makeUnsafe(randomUUID()),
          kind: "notification",
          provider: "codex",
          threadId: context.session.threadId,
          createdAt: new Date().toISOString(),
          ...(context.lifecycleGeneration !== undefined
            ? { lifecycleGeneration: context.lifecycleGeneration }
            : {}),
          method: "turn/started",
          turnId: resumedActiveTurnId,
          message: "Recovered active Codex turn while resuming the thread.",
          payload: {
            turn: { id: resumedActiveTurnId, status: "inProgress" },
            recoveredFrom: "thread/resume",
          },
        });
      }
      // Thread-open readiness is connection lifecycle, not evidence that the
      // conversation has no active turn. A restart continuation may be
      // admitted immediately after this request resolves, before this event is
      // durably projected. `session/started` preserves an already-running turn
      // at ingestion time, while still projecting an idle session as ready.
      this.emitLifecycleEvent(
        context,
        "session/started",
        `Connected to thread ${providerThreadId}`,
      );
      void this.refreshComputerUseCapabilityHealth(context, providerThreadId).catch((error) => {
        log.warn("Computer Use capability preflight failed", {
          threadId,
          error,
        });
      });
      return { ...context.session };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to start Codex session.";
      const retryPreThreadOpen = shouldRetryCodexPreThreadOpenFailure({
        startupAttempt,
        aborted: signal?.aborted === true,
        transportFailed: context?.transportFailureHandled === true,
        threadOpenRequestSent: context?.threadOpenRequestSent === true,
      });
      if (context) {
        this.updateSession(context, {
          status: "error",
          lastError: message,
        });
        await this.stopSession(threadId);
      } else {
        gatewaySessionLease?.release();
      }
      if (retryPreThreadOpen) {
        log.warn("retrying Codex app-server after pre-thread-open process failure", {
          threadId,
          startupAttempt,
          message,
        });
        return this.startSessionAttempt(input, signal, startupAttempt + 1);
      }
      if (context) {
        this.emitErrorEvent(context, "session/startFailed", message);
      } else {
        this.emitEvent({
          id: EventId.makeUnsafe(randomUUID()),
          kind: "error",
          provider: "codex",
          threadId,
          createdAt: new Date().toISOString(),
          ...(input.lifecycleGeneration !== undefined
            ? { lifecycleGeneration: input.lifecycleGeneration }
            : {}),
          method: "session/startFailed",
          message,
        });
      }
      throw new Error(message, { cause: error });
    }
  }

  async sendTurn(input: CodexAppServerSendTurnInput): Promise<ProviderTurnStartResult> {
    const context = this.requireSession(input.threadId);
    context.collabReceiverTurns.clear();
    context.collabReceiverParents.clear();

    // Normal sends never interrupt active work. The orchestration layer decides
    // when a queued follow-up is ready to become a provider turn.
    const turnInput = buildCodexTurnInput(input);
    if (turnInput.length === 0) {
      throw new Error("Turn input must include text or attachments.");
    }

    const providerThreadId = readResumeThreadId({
      threadId: context.session.threadId,
      runtimeMode: context.session.runtimeMode,
      resumeCursor: context.session.resumeCursor,
    });
    if (!providerThreadId) {
      throw new Error("Session is missing provider resume thread id.");
    }
    const turnStartParams: {
      threadId: string;
      input: CodexTurnInputItem[];
      model?: string;
      serviceTier?: string | null;
      effort?: string;
      summary: "auto" | "none";
      clientUserMessageId?: string;
      approvalPolicy?: CodexApprovalPolicy;
      sandboxPolicy?: CodexTurnSandboxPolicy;
      collaborationMode?: {
        mode: "default";
        settings: {
          model: string;
          reasoning_effort: string;
          developer_instructions: string;
        };
      };
    } = {
      threadId: providerThreadId,
      input: turnInput,
      summary: "auto",
      ...(input.clientMessageId !== undefined
        ? { clientUserMessageId: input.clientMessageId }
        : {}),
      ...resolveCodexTurnOverrides(context),
    };
    const normalizedModel = resolveCodexModelForAccount(
      normalizeCodexModelSlug(input.model ?? context.session.model),
      context.account,
    );
    if (normalizedModel) {
      turnStartParams.model = normalizedModel;
    }
    if (input.serviceTier !== undefined) {
      turnStartParams.serviceTier = input.serviceTier;
    }
    if (input.effort) {
      turnStartParams.effort = input.effort;
    }
    if (normalizedModel) {
      turnStartParams.collaborationMode = buildCodexCollaborationMode({
        model: normalizedModel,
        ...(input.effort !== undefined ? { effort: input.effort } : {}),
      });
    }

    const response = await this.sendRequest(context, "turn/start", turnStartParams);
    const turnIdRaw = this.readString(this.readObject(this.readObject(response), "turn"), "id");
    if (!turnIdRaw) {
      throw new Error("turn/start response did not include a turn id.");
    }
    const turnId = TurnId.makeUnsafe(turnIdRaw);

    this.updateSession(context, {
      status: "running",
      activeTurnId: turnId,
      ...(context.session.resumeCursor !== undefined
        ? { resumeCursor: context.session.resumeCursor }
        : {}),
    });

    return {
      threadId: context.session.threadId,
      turnId,
      ...(context.session.resumeCursor !== undefined
        ? { resumeCursor: context.session.resumeCursor }
        : {}),
    };
  }

  async steerTurn(input: CodexAppServerSendTurnInput): Promise<ProviderTurnStartResult> {
    const context = this.requireSession(input.threadId);

    const activeTurnId = context.session.activeTurnId;
    if (context.session.status !== "running" || activeTurnId === undefined) {
      return this.sendTurn(input);
    }

    const turnInput = buildCodexTurnInput(input);
    if (turnInput.length === 0) {
      throw new Error("Turn input must include text or attachments.");
    }

    const providerThreadId = readResumeThreadId({
      threadId: context.session.threadId,
      runtimeMode: context.session.runtimeMode,
      resumeCursor: context.session.resumeCursor,
    });
    if (!providerThreadId) {
      throw new Error("Session is missing provider resume thread id.");
    }

    let response: unknown;
    try {
      response = await this.sendRequest(context, "turn/steer", {
        threadId: providerThreadId,
        input: turnInput,
        expectedTurnId: activeTurnId,
        ...(input.clientMessageId !== undefined
          ? { clientUserMessageId: input.clientMessageId }
          : {}),
      });
    } catch (steerError) {
      // The turn can complete after the caller's live-state check but before
      // app-server handles turn/steer. A JSON-RPC error proves the steer was
      // not accepted, but its generic error code does not identify that race.
      // Resolve it from authoritative thread state instead of matching error
      // text: only an idle thread can safely receive the saved input as a new
      // turn. If state cannot be read or remains active, preserve the original
      // failure and do not risk a duplicate.
      let activity: ReturnType<typeof inspectCodexThreadActivity>;
      try {
        const threadResponse = await this.sendRequest(context, "thread/read", {
          threadId: providerThreadId,
          includeTurns: false,
        });
        activity = inspectCodexThreadActivity(threadResponse);
      } catch {
        throw steerError;
      }
      if (activity.active) {
        throw steerError;
      }
      this.updateSession(context, {
        status: "ready",
        activeTurnId: undefined,
        lastError: undefined,
      });
      return this.sendTurn(input);
    }

    const turnIdRaw = this.readString(this.readObject(response), "turnId");
    if (!turnIdRaw) {
      throw new Error("turn/steer response did not include a turn id.");
    }
    const turnId = TurnId.makeUnsafe(turnIdRaw);

    this.updateSession(context, {
      status: "running",
      activeTurnId: turnId,
      ...(context.session.resumeCursor !== undefined
        ? { resumeCursor: context.session.resumeCursor }
        : {}),
    });

    return {
      threadId: context.session.threadId,
      turnId,
      ...(context.session.resumeCursor !== undefined
        ? { resumeCursor: context.session.resumeCursor }
        : {}),
    };
  }

  async startReview(input: ProviderStartReviewInput): Promise<ProviderTurnStartResult> {
    const context = this.requireSession(input.threadId);
    const providerThreadId = readResumeThreadId({
      threadId: context.session.threadId,
      runtimeMode: context.session.runtimeMode,
      resumeCursor: context.session.resumeCursor,
    });
    if (!providerThreadId) {
      throw new Error("Session is missing a provider resume thread id.");
    }

    const response = await this.sendRequest(context, "review/start", {
      threadId: providerThreadId,
      delivery: "inline",
      target: this.toCodexReviewTarget(input.target),
    });

    const turn = this.readObject(this.readObject(response), "turn");
    const turnIdRaw = this.readString(turn, "id");
    if (!turnIdRaw) {
      throw new Error("review/start response did not include a turn id.");
    }
    const turnId = TurnId.makeUnsafe(turnIdRaw);
    context.reviewTurnIds.add(turnId);
    log.info("[codex-review] review/start acknowledged", {
      threadId: context.session.threadId,
      providerThreadId,
      turnId,
      target: input.target.type,
    });

    this.updateSession(context, {
      status: "running",
      activeTurnId: turnId,
      ...(context.session.resumeCursor !== undefined
        ? { resumeCursor: context.session.resumeCursor }
        : {}),
    });

    return {
      threadId: context.session.threadId,
      turnId,
      ...(context.session.resumeCursor !== undefined
        ? { resumeCursor: context.session.resumeCursor }
        : {}),
    };
  }

  async interruptTurn(
    threadId: ThreadId,
    turnId?: TurnId,
    providerThreadIdOverride?: string,
  ): Promise<void> {
    const context = this.requireSession(threadId);
    const effectiveTurnId = turnId ?? context.session.activeTurnId;

    // Stop must also unpark codex from any question/approval it is blocked on;
    // turn/interrupt alone does not settle server-initiated requests.
    await this.settlePendingHumanRequests(context, "turn interrupted");

    const providerThreadId =
      providerThreadIdOverride ??
      readResumeThreadId({
        threadId: context.session.threadId,
        runtimeMode: context.session.runtimeMode,
        resumeCursor: context.session.resumeCursor,
      });
    if (!effectiveTurnId || !providerThreadId) {
      log.info("[codex-review] turn/interrupt skipped", {
        threadId,
        requestedTurnId: turnId ?? null,
        activeTurnId: context.session.activeTurnId ?? null,
        providerThreadId: providerThreadId ?? null,
      });
      return;
    }

    log.info("[codex-review] turn/interrupt requested", {
      threadId,
      providerThreadId,
      turnId: effectiveTurnId,
      isTrackedReviewTurn: context.reviewTurnIds.has(effectiveTurnId),
    });
    try {
      await this.sendRequest(context, "turn/interrupt", {
        threadId: providerThreadId,
        turnId: effectiveTurnId,
      });
      log.info("[codex-review] turn/interrupt acknowledged", {
        threadId,
        providerThreadId,
        turnId: effectiveTurnId,
      });
    } catch (error) {
      log.warn("[codex-review] turn/interrupt failed", {
        threadId,
        providerThreadId,
        turnId: effectiveTurnId,
        isTrackedReviewTurn: context.reviewTurnIds.has(effectiveTurnId),
        error: error instanceof Error ? error.message : String(error),
      });
      if (!context.reviewTurnIds.has(effectiveTurnId) || !this.isTurnInterruptTimeout(error)) {
        throw error;
      }

      const snapshot = await this.readThread(threadId);
      const latestReviewTurnId = this.findLatestReviewTurnId(snapshot);
      log.info("[codex-review] review interrupt recovery snapshot", {
        threadId,
        currentTurnId: effectiveTurnId,
        latestReviewTurnId: latestReviewTurnId ?? null,
        latestReviewTurnExited: latestReviewTurnId
          ? this.isExitedReviewTurn(snapshot, latestReviewTurnId)
          : false,
        snapshotTurnIds: snapshot.turns.map((turn) => String(turn.id)),
      });

      if (latestReviewTurnId && this.isExitedReviewTurn(snapshot, latestReviewTurnId)) {
        log.info("[codex-review] settling review from thread/read exitedReviewMode", {
          threadId,
          turnId: latestReviewTurnId,
        });
        this.settleTrackedReview(context, {
          completedTurnId: latestReviewTurnId,
          reason: "review exited via thread/read",
        });
        return;
      }

      if (latestReviewTurnId && latestReviewTurnId !== effectiveTurnId) {
        log.info("[codex-review] retrying turn/interrupt with refreshed review turn", {
          threadId,
          previousTurnId: effectiveTurnId,
          nextTurnId: latestReviewTurnId,
        });
        await this.sendRequest(context, "turn/interrupt", {
          threadId: providerThreadId,
          turnId: latestReviewTurnId,
        });
        context.reviewTurnIds.add(latestReviewTurnId);
        this.updateSession(context, {
          activeTurnId: latestReviewTurnId,
        });
        return;
      }

      throw error;
    }
  }

  /** True while `turnId` is still the session's live turn. */
  isTurnActive(threadId: ThreadId, turnId: TurnId): boolean {
    const context = this.sessions.get(threadId);
    return (
      context !== undefined &&
      !context.stopping &&
      context.session.status === "running" &&
      context.session.activeTurnId === turnId
    );
  }

  /** True while the session is legitimately blocked on a human decision. */
  isAwaitingHumanResponse(threadId: ThreadId): boolean {
    const context = this.sessions.get(threadId);
    return context !== undefined && this.hasPendingHumanRequests(context);
  }

  /**
   * Force-settles a turn whose app-server went silent. Best-effort interrupt
   * first — a child that is merely slow settles itself and emits its own
   * terminal notification — then a synthetic `turn/aborted` so a wedged child
   * cannot leave the session "running" forever.
   */
  async abandonTurn(threadId: ThreadId, turnId: TurnId, detail: string): Promise<void> {
    const context = this.sessions.get(threadId);
    if (!context || !this.isTurnActive(threadId, turnId)) {
      return;
    }

    log.warn("abandoning stalled codex turn", { threadId, turnId, detail });
    try {
      await this.interruptTurn(threadId, turnId);
    } catch (error) {
      log.warn("turn/interrupt failed while abandoning a stalled codex turn", {
        threadId,
        turnId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    if (!this.isTurnActive(threadId, turnId)) {
      return;
    }

    this.clearTaskCompleteFallback(context);
    context.collabReceiverTurns.clear();
    context.collabReceiverParents.clear();
    context.reviewTurnIds.delete(turnId);
    this.updateSession(context, {
      status: "ready",
      activeTurnId: undefined,
      lastError: detail,
    });
    this.emitEvent({
      id: EventId.makeUnsafe(randomUUID()),
      kind: "notification",
      provider: "codex",
      threadId: context.session.threadId,
      createdAt: new Date().toISOString(),
      ...(context.lifecycleGeneration !== undefined
        ? { lifecycleGeneration: context.lifecycleGeneration }
        : {}),
      method: "turn/aborted",
      turnId,
      message: detail,
      payload: {
        turn: {
          id: turnId,
          status: "aborted",
        },
        abandonedBy: "turnIdleWatchdog",
      },
    });
  }

  async readThread(threadId: ThreadId): Promise<CodexThreadSnapshot> {
    const context = this.requireSession(threadId);
    const providerThreadId = readResumeThreadId({
      threadId: context.session.threadId,
      runtimeMode: context.session.runtimeMode,
      resumeCursor: context.session.resumeCursor,
    });
    if (!providerThreadId) {
      throw new Error("Session is missing a provider resume thread id.");
    }

    const response = await this.sendRequest(context, "thread/read", {
      threadId: providerThreadId,
      includeTurns: true,
    });
    return this.parseThreadSnapshot("thread/read", response);
  }

  async forkThread(
    input: ProviderForkThreadInput & { readonly managedLaunch?: ProviderManagedLaunchContext },
  ): Promise<ProviderForkThreadResult> {
    const threadId = input.threadId;
    const now = new Date().toISOString();
    let context: CodexSessionContext | undefined;
    let gatewaySessionLease: AgentGatewaySessionLease | undefined;

    try {
      const existing = this.sessions.get(threadId);
      if (existing) {
        await this.stopSession(threadId);
      }

      const sourceProviderThreadId = readResumeCursorThreadId(input.sourceResumeCursor);
      if (!sourceProviderThreadId) {
        throw new Error("Provider fork is missing the source thread resume id.");
      }

      const resolvedCwd = input.cwd ?? ensureIsolatedScratchWorkspace(threadId);
      const session: ProviderSession = {
        provider: "codex",
        status: "connecting",
        runtimeMode: input.runtimeMode,
        model:
          input.modelSelection?.provider === "codex"
            ? normalizeCodexModelSlug(input.modelSelection.model)
            : undefined,
        cwd: resolvedCwd,
        threadId,
        createdAt: now,
        updatedAt: now,
      };

      const codexOptions = readCodexProviderOptions({
        threadId,
        ...(input.providerOptions !== undefined ? { providerOptions: input.providerOptions } : {}),
        runtimeMode: input.runtimeMode,
        ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
      });
      const codexBinaryPath = input.managedLaunch?.binaryPath ?? codexOptions.binaryPath ?? "codex";
      const codexHomePath = codexOptions.homePath;
      await this.assertSupportedCodexCliVersion({
        binaryPath: codexBinaryPath,
        cwd: resolvedCwd,
        ...(codexHomePath ? { homePath: codexHomePath } : {}),
      });
      gatewaySessionLease = this.agentGatewayHostTool?.acquireSessionLease(threadId);
      if (input.managedLaunch) {
        await prepareManagedCodexResume(input.managedLaunch, sourceProviderThreadId);
      }
      const child = spawnCodexAppServer({
        binaryPath: codexBinaryPath,
        cwd: resolvedCwd,
        env: await this.buildSessionProcessEnv(
          codexHomePath,
          gatewaySessionLease?.connection.bearerToken,
          input.managedLaunch,
        ),
      });

      context = {
        ...(gatewaySessionLease ? { gatewaySessionLease } : {}),
        session,
        account: {
          type: "unknown",
          planType: null,
          sparkEnabled: true,
        },
        child,
        binaryPath: codexBinaryPath,
        stdoutFramer: new CodexJsonlFramer(),
        stdinWriter: new CodexJsonlWriter(child.stdin),
        pending: new Map(),
        pendingApprovals: new Map(),
        pendingUserInputs: new Map(),
        collabReceiverTurns: new Map(),
        collabReceiverParents: new Map(),
        reviewTurnIds: new Set(),
        terminalTurnIds: new Set(),
        mcpStartupStatuses: new Map(),
        nextRequestId: 1,
        stopping: false,
      };

      this.sessions.set(threadId, context);
      this.attachProcessListeners(context);
      this.emitLifecycleEvent(context, "session/connecting", "Starting codex app-server");

      await this.sendRequest(context, "initialize", buildCodexInitializeParams());
      await this.writeMessage(context, { method: "initialized" });
      await this.registerPenkraSkillsRoot(context);
      try {
        const accountReadResponse = await this.sendRequest(context, "account/read", {});
        context.account = readCodexAccountSnapshot(accountReadResponse);
      } catch {
        // Fork can proceed without account metadata; model fallback will stay best-effort.
      }

      const normalizedModel =
        input.modelSelection?.provider === "codex"
          ? resolveCodexModelForAccount(
              normalizeCodexModelSlug(input.modelSelection.model),
              context.account,
            )
          : undefined;
      const useFastServiceTier =
        input.modelSelection?.provider === "codex" &&
        getModelSelectionBooleanOptionValue(input.modelSelection, "fastMode") === true;
      const forkParams = {
        threadId: sourceProviderThreadId,
        ...(normalizedModel ? { model: normalizedModel } : {}),
        ...(useFastServiceTier ? { serviceTier: "fast" as const } : {}),
        cwd: resolvedCwd,
        ...mapCodexRuntimeMode(input.runtimeMode),
      };

      this.emitLifecycleEvent(
        context,
        "session/threadOpenRequested",
        `Forking Codex thread ${sourceProviderThreadId}.`,
      );
      const response = await this.sendRequest(context, "thread/fork", forkParams);
      const forkedProviderThreadId = this.readThreadIdFromResponse("thread/fork", response);
      context.conversationHistoryMutationCapability =
        resolveCodexConversationHistoryMutationCapability(response);

      if (input.managedLaunch) {
        await adoptManagedCodexRollout(input.managedLaunch, forkedProviderThreadId);
      }

      this.updateSession(context, {
        status: "ready",
        resumeCursor: { threadId: forkedProviderThreadId },
      });
      this.emitLifecycleEvent(context, "session/threadOpenResolved", "Codex thread/fork resolved.");
      // As with thread/resume, fork resolution proves connection readiness but
      // is not a terminal turn signal. Keep it causally distinct from a real
      // provider `turn/completed` notification.
      this.emitLifecycleEvent(
        context,
        "session/started",
        `Connected to thread ${forkedProviderThreadId}`,
      );

      return {
        threadId,
        resumeCursor: {
          threadId: forkedProviderThreadId,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to fork Codex thread.";
      if (context) {
        this.updateSession(context, {
          status: "error",
          lastError: message,
        });
        this.emitErrorEvent(context, "session/threadForkFailed", message);
        await this.stopSession(threadId);
      } else {
        gatewaySessionLease?.release();
      }
      throw new Error(message, { cause: error });
    }
  }

  async rollbackThread(threadId: ThreadId, numTurns: number): Promise<CodexThreadSnapshot> {
    const context = this.requireSession(threadId);
    const historyMutationCapability = context.conversationHistoryMutationCapability ?? {
      state: "unavailable-until-session-open" as const,
    };
    if (historyMutationCapability.state !== "supported") {
      throw new CodexConversationHistoryMutationUnavailableError(historyMutationCapability);
    }
    const providerThreadId = readResumeThreadId({
      threadId: context.session.threadId,
      runtimeMode: context.session.runtimeMode,
      resumeCursor: context.session.resumeCursor,
    });
    if (!providerThreadId) {
      throw new Error("Session is missing a provider resume thread id.");
    }
    if (!Number.isInteger(numTurns) || numTurns < 1) {
      throw new Error("numTurns must be an integer >= 1.");
    }

    const response = await this.sendRequest(context, "thread/rollback", {
      threadId: providerThreadId,
      numTurns,
    });
    this.updateSession(context, {
      status: "ready",
      activeTurnId: undefined,
    });
    return this.parseThreadSnapshot("thread/rollback", response);
  }

  getConversationHistoryMutationCapability(
    threadId: ThreadId,
  ): CodexConversationHistoryMutationCapability {
    return (
      this.sessions.get(threadId)?.conversationHistoryMutationCapability ?? {
        state: "unavailable-until-session-open",
      }
    );
  }

  async compactThread(threadId: ThreadId): Promise<void> {
    const context = this.requireSession(threadId);
    const providerThreadId = readResumeThreadId({
      threadId: context.session.threadId,
      runtimeMode: context.session.runtimeMode,
      resumeCursor: context.session.resumeCursor,
    });
    if (!providerThreadId) {
      throw new Error("Session is missing a provider resume thread id.");
    }

    await Effect.logInfo("codex app-server compact requested", {
      threadId: context.session.threadId,
      providerThreadId,
      runtimeMode: context.session.runtimeMode,
      activeTurnId: context.session.activeTurnId ?? null,
    }).pipe(this.runPromise);

    // Compaction outside a turn must not claim "running": there is no turn id to
    // reconcile it against, so the session could never be settled back to ready.
    if (context.session.activeTurnId !== undefined) {
      this.updateSession(context, {
        status: "running",
      });
    }
    this.emitEvent({
      id: EventId.makeUnsafe(randomUUID()),
      kind: "notification",
      provider: "codex",
      threadId: context.session.threadId,
      createdAt: new Date().toISOString(),
      ...(context.lifecycleGeneration !== undefined
        ? { lifecycleGeneration: context.lifecycleGeneration }
        : {}),
      ...(context.session.activeTurnId ? { turnId: context.session.activeTurnId } : {}),
      method: "thread/compacting",
      message: "Compacting context",
      payload: {
        threadId: providerThreadId,
        state: "compacting",
      },
    });
    try {
      await this.sendRequest(context, "thread/compact/start", {
        threadId: providerThreadId,
      });
      await Effect.logInfo("codex app-server compact start acknowledged", {
        threadId: context.session.threadId,
        providerThreadId,
      }).pipe(this.runPromise);
    } catch (error) {
      this.updateSession(context, {
        status: "error",
        lastError: error instanceof Error ? error.message : context.session.lastError,
      });
      await Effect.logWarning("codex app-server compact failed", {
        threadId: context.session.threadId,
        providerThreadId,
        cause: error,
      }).pipe(this.runPromise);
      throw error;
    }
  }

  private async resolveApprovalRequest(
    context: CodexSessionContext,
    pendingRequest: PendingApprovalRequest,
    decision: ProviderApprovalDecision,
  ): Promise<void> {
    await this.writeMessage(context, {
      id: pendingRequest.jsonRpcId,
      result: {
        decision,
      },
    });

    this.emitEvent({
      id: EventId.makeUnsafe(randomUUID()),
      kind: "notification",
      provider: "codex",
      threadId: context.session.threadId,
      createdAt: new Date().toISOString(),
      ...(context.lifecycleGeneration !== undefined
        ? { lifecycleGeneration: context.lifecycleGeneration }
        : {}),
      method: "item/requestApproval/decision",
      turnId: pendingRequest.turnId,
      parentTurnId: pendingRequest.parentTurnId,
      itemId: pendingRequest.itemId,
      providerThreadId: pendingRequest.providerThreadId,
      providerParentThreadId: pendingRequest.providerParentThreadId,
      requestId: pendingRequest.requestId,
      requestKind: pendingRequest.requestKind,
      payload: {
        requestId: pendingRequest.requestId,
        requestKind: pendingRequest.requestKind,
        decision,
      },
    });
  }

  private async resolveRemainingSessionApprovalRequests(
    context: CodexSessionContext,
  ): Promise<void> {
    const remainingRequests = Array.from(context.pendingApprovals.values());
    context.pendingApprovals.clear();
    for (const pendingRequest of remainingRequests) {
      await this.resolveApprovalRequest(context, pendingRequest, "acceptForSession");
    }
  }

  async respondToRequest(
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ): Promise<void> {
    const context = this.requireSession(threadId);
    const pendingRequest = context.pendingApprovals.get(requestId);
    if (!pendingRequest) {
      throw new CodexPendingInteractionNotFoundError(
        `Unknown pending approval request: ${requestId}`,
      );
    }

    context.pendingApprovals.delete(requestId);
    if (decision === "acceptForSession") {
      context.sessionApprovalOverride = CODEX_ALWAYS_ALLOW_SESSION_TURN_OVERRIDES;
    }
    await this.resolveApprovalRequest(context, pendingRequest, decision);
    if (decision === "acceptForSession") {
      await this.resolveRemainingSessionApprovalRequests(context);
    }
  }

  async respondToUserInput(
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    answers: ProviderUserInputAnswers,
  ): Promise<void> {
    const context = this.requireSession(threadId);
    const pendingRequest = context.pendingUserInputs.get(requestId);
    if (!pendingRequest) {
      throw new CodexPendingInteractionNotFoundError(
        `Unknown pending user-input request: ${requestId}`,
      );
    }

    await this.resolveUserInputRequest(context, pendingRequest, answers);
  }

  private async resolveUserInputRequest(
    context: CodexSessionContext,
    pendingRequest: PendingUserInputRequest,
    answers: ProviderUserInputAnswers,
  ): Promise<void> {
    const codexAnswers = toCodexUserInputAnswers(answers);
    // The pending entry survives a failed write so the request stays answerable;
    // dropping it first would strand codex on an id nobody can respond to.
    await this.writeMessage(context, {
      id: pendingRequest.jsonRpcId,
      result: {
        answers: codexAnswers,
      },
    });
    context.pendingUserInputs.delete(pendingRequest.requestId);

    this.emitEvent({
      id: EventId.makeUnsafe(randomUUID()),
      kind: "notification",
      provider: "codex",
      threadId: context.session.threadId,
      createdAt: new Date().toISOString(),
      ...(context.lifecycleGeneration !== undefined
        ? { lifecycleGeneration: context.lifecycleGeneration }
        : {}),
      method: "item/tool/requestUserInput/answered",
      turnId: pendingRequest.turnId,
      parentTurnId: pendingRequest.parentTurnId,
      itemId: pendingRequest.itemId,
      providerThreadId: pendingRequest.providerThreadId,
      providerParentThreadId: pendingRequest.providerParentThreadId,
      requestId: pendingRequest.requestId,
      payload: {
        requestId: pendingRequest.requestId,
        answers: codexAnswers,
      },
    });
  }

  private hasPendingHumanRequests(context: CodexSessionContext): boolean {
    return context.pendingApprovals.size > 0 || context.pendingUserInputs.size > 0;
  }

  /**
   * Answers every outstanding human-facing server request so an abnormal exit
   * (stop, interrupt, process exit, idle timeout) can never leave codex parked
   * on a JSON-RPC id nobody will ever respond to.
   *
   * Abnormal paths only: unlike the human-driven responses, an entry is dropped
   * even when its write fails, because the request is being abandoned and a
   * surviving entry would only leak into the next turn.
   */
  private async settlePendingHumanRequests(
    context: CodexSessionContext,
    reason: string,
  ): Promise<void> {
    const pendingApprovals = Array.from(context.pendingApprovals.values());
    const pendingUserInputs = Array.from(context.pendingUserInputs.values());
    if (pendingApprovals.length === 0 && pendingUserInputs.length === 0) {
      return;
    }

    log.info("settling pending codex human requests", {
      threadId: context.session.threadId,
      reason,
      pendingApprovals: pendingApprovals.length,
      pendingUserInputs: pendingUserInputs.length,
    });

    for (const pendingRequest of pendingApprovals) {
      try {
        await this.resolveApprovalRequest(context, pendingRequest, "cancel");
      } catch (error) {
        log.warn("failed to settle pending codex approval request", {
          threadId: context.session.threadId,
          reason,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        context.pendingApprovals.delete(pendingRequest.requestId);
      }
    }

    for (const pendingRequest of pendingUserInputs) {
      try {
        await this.resolveUserInputRequest(context, pendingRequest, {});
      } catch (error) {
        log.warn("failed to settle pending codex user-input request", {
          threadId: context.session.threadId,
          reason,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        context.pendingUserInputs.delete(pendingRequest.requestId);
      }
    }
  }

  private async teardownContextProcess(context: CodexSessionContext): Promise<void> {
    try {
      await teardownChildProcessTree(context.child, this.teardownProcessTree);
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      throw new Error(
        `Failed to prove Codex app-server process-tree exit for '${context.session.threadId}': ${detail}`,
        { cause },
      );
    }
  }

  private rejectPendingRequests(context: CodexSessionContext, error: Error): void {
    for (const pending of context.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    context.pending.clear();
  }

  async stopSession(threadId: ThreadId): Promise<void> {
    const context = this.sessions.get(threadId);
    if (!context) {
      return;
    }
    if (context.stopPromise) {
      return context.stopPromise;
    }

    let settleBeforeTeardown: Promise<void> | undefined;
    if (!context.stopping) {
      context.stopping = true;
      this.clearTaskCompleteFallback(context);
      context.gatewaySessionLease?.release();

      this.rejectPendingRequests(context, new Error("Session stopped before request completed."));
      if (this.hasPendingHumanRequests(context)) {
        // Answer parked server requests while stdin is still writable, then close.
        // Time-boxed so a child that stopped reading stdin cannot stall teardown.
        settleBeforeTeardown = withCodexPendingSettleDeadline(
          this.settlePendingHumanRequests(context, "session stopped"),
        ).finally(() => {
          context.stdinWriter?.close(new Error("Codex session stopped"));
        });
      } else {
        context.stdinWriter?.close(new Error("Codex session stopped"));
      }

      context.detachStdout?.();

      // The session becomes unroutable immediately, but remains in the map as a
      // replacement barrier until teardown proves the old process tree exited.
      // Otherwise a failed proof could let startSession spawn a second provider
      // process for the same thread.
      this.updateSession(context, {
        status: "closed",
        activeTurnId: undefined,
      });
      this.emitLifecycleEvent(context, "session/closed", "Session stopped");
    }
    let stopPromise: Promise<void>;
    // Teardown starts synchronously unless parked requests still need answering,
    // so a stop with nothing parked stays as prompt as it was before settling.
    const teardown = settleBeforeTeardown
      ? settleBeforeTeardown.then(() => this.teardownContextProcess(context))
      : this.teardownContextProcess(context);
    stopPromise = teardown.then(
      () => {
        if (this.sessions.get(threadId) === context) {
          this.sessions.delete(threadId);
        }
      },
      (error: unknown) => {
        log.error("codex app-server teardown did not prove process-tree exit", {
          threadId,
          error,
        });
        // A later stop/start may retry proof after the process has exited.
        if (context.stopPromise === stopPromise) {
          delete context.stopPromise;
        }
        throw error;
      },
    );
    context.stopPromise = stopPromise;
    return stopPromise;
  }

  listSessions(): ProviderSession[] {
    return Array.from(this.sessions.values())
      .filter((context) => this.isContextRoutable(context))
      .map(({ session }) => ({
        ...session,
      }));
  }

  hasSession(threadId: ThreadId): boolean {
    const context = this.sessions.get(threadId);
    return context !== undefined && this.isContextRoutable(context);
  }

  async stopAll(): Promise<void> {
    const results = await Promise.allSettled([
      ...Array.from(this.sessions.keys(), (threadId) => this.stopSession(threadId)),
      ...Array.from(this.discoverySessions.keys(), (key) => this.stopDiscoverySession(key)),
    ]);
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        "One or more Codex app-server process trees did not exit.",
      );
    }
  }

  async listSkills(input: CodexSkillListInput): Promise<ProviderListSkillsResult> {
    const cwd = input.cwd.trim();
    const cacheKey = JSON.stringify({
      cwd,
      threadId: input.threadId?.trim() || null,
    });
    if (!input.forceReload) {
      const cached = getRecentCacheEntry(this.skillsCache, cacheKey);
      if (cached) {
        return {
          ...cached,
          cached: true,
        };
      }
    }

    const context = await this.resolveContextForDiscovery(input.threadId, cwd);
    let response: Record<string, unknown>;
    try {
      response = await this.sendRequest<Record<string, unknown>>(context, "skills/list", {
        cwds: [cwd],
        ...(input.forceReload ? { forceReload: true } : {}),
      });
    } catch (error) {
      if (!shouldRetrySkillsListWithCwdFallback(error)) {
        throw error;
      }
      response = await this.sendRequest<Record<string, unknown>>(context, "skills/list", {
        cwd,
        ...(input.forceReload ? { forceReload: true } : {}),
      });
    }
    const skills = parseCodexSkillsListResponse(response, cwd);
    const result: ProviderListSkillsResult = {
      skills,
      source: "codex-app-server",
      cached: false,
    };
    setRecentCacheEntry(this.skillsCache, cacheKey, result);
    return result;
  }

  async listPlugins(input: CodexPluginListInput): Promise<ProviderListPluginsResult> {
    const cwd = input.cwd?.trim() || null;
    const cacheKey = JSON.stringify({
      cwd,
      threadId: input.threadId?.trim() || null,
      forceRemoteSync: input.forceRemoteSync === true,
    });
    if (!input.forceReload) {
      const cached = getRecentCacheEntry(this.pluginsCache, cacheKey);
      if (cached) {
        return {
          ...cached,
          cached: true,
        };
      }
    }

    const context = await this.resolveContextForDiscovery(input.threadId, cwd ?? undefined);
    const response = await this.sendRequest<Record<string, unknown>>(context, "plugin/list", {
      ...(cwd ? { cwds: [cwd] } : {}),
      ...(input.forceRemoteSync ? { forceRefetch: true } : {}),
    });
    const result: ProviderListPluginsResult = {
      ...parseCodexPluginListResponse(response),
      source: "codex-app-server",
      cached: false,
    };
    setRecentCacheEntry(this.pluginsCache, cacheKey, result);
    return result;
  }

  async getComputerUseCapabilityHealth(threadId: ThreadId): Promise<ComputerUseCapabilityHealth> {
    const context = this.requireSession(threadId);
    const providerThreadId = readResumeCursorThreadId(context.session.resumeCursor);
    if (!providerThreadId) {
      throw new Error(`Session is missing provider resume thread id: ${threadId}`);
    }
    return this.refreshComputerUseCapabilityHealth(context, providerThreadId);
  }

  private async refreshComputerUseCapabilityHealth(
    context: CodexSessionContext,
    providerThreadId: string,
  ): Promise<ComputerUseCapabilityHealth> {
    const inventory: McpToolInventoryEntry[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | null = null;

    do {
      const response: Record<string, unknown> = await this.sendRequest<Record<string, unknown>>(
        context,
        "mcpServerStatus/list",
        {
          cursor,
          limit: 100,
          detail: "toolsAndAuthOnly",
          threadId: providerThreadId,
        },
      );
      const data = Array.isArray(response.data) ? response.data : [];
      for (const rawServer of data) {
        const server = asObject(rawServer);
        const name = asString(server?.name)?.trim();
        if (!name) continue;
        const tools = asObject(server?.tools) ?? {};
        inventory.push({ name, toolNames: Object.keys(tools) });
      }
      const nextCursor: string | null = asString(response.nextCursor)?.trim() || null;
      if (nextCursor && seenCursors.has(nextCursor)) {
        throw new Error("mcpServerStatus/list returned a repeated pagination cursor.");
      }
      if (nextCursor) seenCursors.add(nextCursor);
      cursor = nextCursor;
    } while (cursor !== null);

    const health = classifyComputerUseCapability({
      inventory,
      startupStatuses: [...context.mcpStartupStatuses.values()],
    });
    context.computerUseHealth = health;
    log.info("Computer Use capability preflight completed", {
      threadId: context.session.threadId,
      state: health.state,
      preferredRoute: health.preferredRoute,
      routes: health.routes,
    });
    return health;
  }

  async readPlugin(input: CodexPluginReadInput): Promise<ProviderReadPluginResult> {
    const marketplacePath = input.marketplacePath.trim();
    const pluginName = input.pluginName.trim();
    const cacheKey = JSON.stringify({
      marketplacePath,
      pluginName,
      threadId: input.threadId?.trim() || null,
    });
    const cached = getRecentCacheEntry(this.pluginDetailCache, cacheKey);
    if (cached) {
      return {
        ...cached,
        cached: true,
      };
    }

    const context = await this.resolveContextForDiscovery(input.threadId);
    const response = await this.sendRequest<Record<string, unknown>>(context, "plugin/read", {
      marketplacePath,
      pluginName,
    });
    const result: ProviderReadPluginResult = {
      plugin: parseCodexPluginReadResponse(response),
      source: "codex-app-server",
      cached: false,
    };
    setRecentCacheEntry(this.pluginDetailCache, cacheKey, result);
    return result;
  }

  async listModels(
    threadId?: string,
    managedDiscovery?: {
      readonly cwd?: string;
      readonly managedLaunch: ProviderManagedLaunchContext;
    },
  ): Promise<ProviderListModelsResult> {
    const cacheKey = managedDiscovery
      ? `managed:${managedDiscovery.managedLaunch.isolationKey}:${managedDiscovery.cwd ?? ""}`
      : threadId?.trim() || "__default__";
    const cached = getRecentCacheEntry(this.modelCache, cacheKey);
    if (cached) {
      return {
        ...cached,
        cached: true,
      };
    }

    const context = managedDiscovery
      ? await this.getOrCreateDiscoverySession(
          managedDiscovery.cwd?.trim() || process.cwd(),
          managedDiscovery.managedLaunch,
        )
      : await this.resolveContextForDiscovery(threadId);
    const response = await this.sendRequest<Record<string, unknown>>(context, "model/list", {
      cursor: null,
      limit: 50,
      includeHidden: false,
    });
    const models = parseCodexModelListResponse(response);
    const result: ProviderListModelsResult = {
      models,
      source: "codex-app-server",
      cached: false,
    };
    setRecentCacheEntry(this.modelCache, cacheKey, result);
    return result;
  }

  async transcribeVoice(
    input: ServerVoiceTranscriptionInput & {
      readonly managedLaunch?: ProviderManagedLaunchContext;
    },
  ): Promise<ServerVoiceTranscriptionResult> {
    return transcribeVoiceWithChatGptSession({
      request: input,
      resolveAuth: (refreshToken) =>
        this.resolveVoiceTranscriptionAuth({
          cwd: input.cwd,
          ...(input.threadId ? { threadId: input.threadId } : {}),
          ...(input.managedLaunch ? { managedLaunch: input.managedLaunch } : {}),
          refreshToken,
        }),
    });
  }

  getComposerCapabilities(): ProviderComposerCapabilities {
    return {
      provider: "codex",
      supportsSkillMentions: true,
      supportsSkillDiscovery: true,
      supportsNativeSlashCommandDiscovery: false,
      supportsPluginMentions: true,
      supportsPluginDiscovery: true,
      supportsRuntimeModelList: true,
      supportsThreadCompaction: true,
      supportsThreadFork: true,
      supportsThreadImport: false,
    };
  }

  private requireSession(threadId: ThreadId): CodexSessionContext {
    const context = this.sessions.get(threadId);
    if (!context) {
      throw new Error(`Unknown session for thread: ${threadId}`);
    }

    // "Session is closed" is the phrase CodexAdapter maps to the typed
    // recoverable session error. A failed turn may leave a healthy process with
    // status "error", so only transport/process health controls routability.
    if (!this.isContextRoutable(context)) {
      throw new Error(`Session is closed for thread: ${threadId}`);
    }

    return context;
  }

  private isContextRoutable(context: CodexSessionContext): boolean {
    const stdin = context.child.stdin;
    return (
      !context.stopping &&
      context.session.status !== "closed" &&
      context.child.exitCode === null &&
      context.child.signalCode === null &&
      !context.child.killed &&
      stdin.writable &&
      !stdin.writableEnded &&
      !stdin.destroyed
    );
  }

  private async resolveContextForDiscovery(
    threadId?: string,
    cwd?: string,
  ): Promise<CodexSessionContext> {
    const normalizedThreadId = threadId?.trim();
    const normalizedCwd = cwd?.trim() || undefined;
    if (!normalizedThreadId) {
      throw new Error("Managed Codex discovery requires an exact active thread session.");
    }
    const session = this.requireSession(ThreadId.makeUnsafe(normalizedThreadId));
    if (normalizedCwd && session.session.cwd !== normalizedCwd) {
      throw new Error("The active Codex session does not match the requested working folder.");
    }
    return session;
  }

  private async resolveVoiceTranscriptionAuth(input: {
    readonly cwd?: string;
    readonly threadId?: string;
    readonly refreshToken: boolean;
    readonly managedLaunch?: ProviderManagedLaunchContext;
  }): Promise<CodexVoiceTranscriptionAuthContext> {
    const context = input.managedLaunch
      ? await this.getOrCreateDiscoverySession(
          input.cwd?.trim() || process.cwd(),
          input.managedLaunch,
        )
      : input.threadId?.trim()
        ? await this.resolveContextForDiscovery(input.threadId, input.cwd)
        : null;
    if (context === null) {
      throw new Error("Voice transcription requires an exact active Connection session.");
    }
    const readAuthStatus = async (refreshToken: boolean) => {
      const response = await this.sendRequest<Record<string, unknown>>(context, "getAuthStatus", {
        includeToken: true,
        refreshToken,
      });
      const authMethod = this.readString(response, "authMethod");
      return {
        authMethod,
        token: this.readString(response, "authToken"),
      };
    };

    let { authMethod, token } = await readAuthStatus(input.refreshToken);
    if (!token && !input.refreshToken) {
      ({ authMethod, token } = await readAuthStatus(true));
    }

    if (!token) {
      throw new Error("No ChatGPT session token is available. Sign in to ChatGPT in Codex.");
    }
    if (authMethod !== "chatgpt" && authMethod !== "chatgptAuthTokens") {
      throw new Error("Voice transcription requires a ChatGPT-authenticated Codex session.");
    }

    log.info("voice transcription auth available", {
      authMethod,
      refreshToken: input.refreshToken,
      hasThreadId: Boolean(input.threadId?.trim()),
      usedManagedLaunch: input.managedLaunch !== undefined,
    });

    return {
      authMethod,
      token,
    };
  }

  private async getOrCreateDiscoverySession(
    cwd: string,
    managedLaunch: ProviderManagedLaunchContext,
  ): Promise<CodexSessionContext> {
    const normalizedCwd = cwd.trim() || process.cwd();
    const discoveryKey = `${managedLaunch.isolationKey}\u0000${normalizedCwd}`;
    const existing = this.discoverySessions.get(discoveryKey);
    if (existing && !existing.stopping && !existing.child.killed) {
      this.scheduleDiscoverySessionIdleStop(discoveryKey);
      return existing;
    }
    if (existing) {
      await this.stopDiscoverySession(discoveryKey);
    }

    const now = new Date().toISOString();
    const child = spawnCodexAppServer({
      binaryPath: managedLaunch.binaryPath,
      cwd: normalizedCwd,
      env: managedLaunch.childEnvironment(process.env),
    });
    const context: CodexSessionContext = {
      session: {
        provider: "codex",
        status: "connecting",
        runtimeMode: "full-access",
        model: "__provider_default__",
        cwd: normalizedCwd,
        threadId: ThreadId.makeUnsafe(`__codex_discovery__:${normalizedCwd}`),
        createdAt: now,
        updatedAt: now,
      },
      account: {
        type: "unknown",
        planType: null,
        sparkEnabled: true,
      },
      child,
      binaryPath: managedLaunch.binaryPath,
      stdoutFramer: new CodexJsonlFramer(),
      stdinWriter: new CodexJsonlWriter(child.stdin),
      pending: new Map(),
      pendingApprovals: new Map(),
      pendingUserInputs: new Map(),
      collabReceiverTurns: new Map(),
      collabReceiverParents: new Map(),
      reviewTurnIds: new Set(),
      terminalTurnIds: new Set(),
      mcpStartupStatuses: new Map(),
      nextRequestId: 1,
      stopping: false,
      discovery: true,
    };

    this.discoverySessions.set(discoveryKey, context);
    this.attachProcessListeners(context);
    try {
      await this.sendRequest(context, "initialize", buildCodexInitializeParams());
      await this.writeMessage(context, { method: "initialized" });
      await this.registerPenkraSkillsRoot(context);
      try {
        const accountReadResponse = await this.sendRequest(context, "account/read", {});
        context.account = readCodexAccountSnapshot(accountReadResponse);
      } catch {
        // Discovery can still function without account metadata.
      }
      this.updateSession(context, { status: "ready" });
      this.scheduleDiscoverySessionIdleStop(discoveryKey);
      return context;
    } catch (error) {
      await this.stopDiscoverySession(discoveryKey);
      throw error;
    }
  }

  private scheduleDiscoverySessionIdleStop(discoveryKey: string): void {
    const existingTimer = this.discoverySessionIdleTimers.get(discoveryKey);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(() => {
      const context = this.discoverySessions.get(discoveryKey);
      if (!context || context.stopping) {
        this.discoverySessionIdleTimers.delete(discoveryKey);
        return;
      }
      if (
        context.pending.size > 0 ||
        context.pendingApprovals.size > 0 ||
        context.pendingUserInputs.size > 0
      ) {
        this.scheduleDiscoverySessionIdleStop(discoveryKey);
        return;
      }

      void this.stopDiscoverySession(discoveryKey).catch((error) => {
        log.warn("Failed to stop idle Codex discovery session", { discoveryKey, error });
      });
    }, CODEX_DISCOVERY_SESSION_IDLE_MS);
    timer.unref();
    this.discoverySessionIdleTimers.set(discoveryKey, timer);
  }

  private async stopDiscoverySession(discoveryKey: string): Promise<void> {
    const idleTimer = this.discoverySessionIdleTimers.get(discoveryKey);
    if (idleTimer) {
      clearTimeout(idleTimer);
      this.discoverySessionIdleTimers.delete(discoveryKey);
    }

    const context = this.discoverySessions.get(discoveryKey);
    if (!context) {
      return;
    }
    if (context.stopPromise) {
      return context.stopPromise;
    }

    context.stopping = true;
    this.rejectPendingRequests(
      context,
      new Error("Discovery session stopped before request completed."),
    );
    context.detachStdout?.();
    context.stdinWriter?.close(new Error("Codex discovery session stopped"));
    // Keep a non-routable replacement barrier until exit is proven.
    let stopPromise: Promise<void>;
    stopPromise = this.teardownContextProcess(context).then(
      () => {
        if (this.discoverySessions.get(discoveryKey) === context) {
          this.discoverySessions.delete(discoveryKey);
        }
      },
      (error: unknown) => {
        log.error("codex discovery teardown did not prove process-tree exit", {
          discoveryKey,
          error,
        });
        if (context.stopPromise === stopPromise) {
          delete context.stopPromise;
        }
        throw error;
      },
    );
    context.stopPromise = stopPromise;
    return stopPromise;
  }

  private attachProcessListeners(context: CodexSessionContext): void {
    const onStdoutData = (chunk: Buffer) => {
      if (context.stopping) return;
      try {
        for (const line of context.stdoutFramer.push(chunk)) {
          if (!isIgnorableCodexProcessLine(line)) this.handleStdoutLine(context, line);
        }
      } catch (cause) {
        this.handleTransportFailure(context, cause);
      }
    };
    const onStdoutEnd = () => {
      if (context.stopping) return;
      try {
        context.stdoutFramer.finish();
        // stdout commonly closes immediately before `exit`/`close`. Give stderr
        // and the child's exit status one event-loop beat to land so the real
        // process failure is not replaced by a generic read-closed error.
        context.stdoutEndTimer = setTimeout(() => {
          delete context.stdoutEndTimer;
          if (context.stopping || context.transportFailureHandled) return;
          this.handleTransportFailure(
            context,
            new CodexAppServerTransportError({
              reason: "read-closed",
              maxBytes: context.stdoutFramer.maxFrameBytes,
              observedBytes: 0,
            }),
          );
        }, CODEX_STDOUT_END_GRACE_MS);
        context.stdoutEndTimer.unref?.();
      } catch (cause) {
        this.handleTransportFailure(context, cause);
      }
    };
    context.child.stdout.on("data", onStdoutData);
    context.child.stdout.once("end", onStdoutEnd);
    context.detachStdout = () => {
      context.child.stdout.off("data", onStdoutData);
      context.child.stdout.off("end", onStdoutEnd);
      context.stdoutFramer.reset();
      delete context.detachStdout;
    };

    context.child.stderr.on("data", (chunk: Buffer) => {
      appendCodexStderrTail(context, chunk);
      if (context.stopping) {
        return;
      }
      const raw = chunk.toString();
      const lines = raw.split(/\r?\n/g);
      for (const rawLine of lines) {
        const classified = classifyCodexStderrLine(rawLine);
        if (!classified) {
          continue;
        }

        this.emitErrorEvent(context, "process/stderr", classified.message);
      }
    });

    context.child.on("error", (error) => this.handleTransportFailure(context, error));

    context.child.on("exit", (code, signal) => {
      if (context.stopping) {
        return;
      }

      if (context.stdoutEndTimer) {
        clearTimeout(context.stdoutEndTimer);
        delete context.stdoutEndTimer;
      }
      if (context.transportFailureHandled) return;
      context.transportFailureHandled = true;

      context.detachStdout?.();
      this.clearTaskCompleteFallback(context);
      context.gatewaySessionLease?.release();
      const message = formatCodexProcessFailure(context, "process-exit", code, signal);
      const exitError = new Error(message);
      log.error("codex app-server process exited unexpectedly", {
        threadId: context.session.threadId,
        message,
      });
      context.stdinWriter.close(exitError);
      this.rejectPendingRequests(context, exitError);
      // The child is gone, so the responses cannot land; settling still clears
      // the maps and emits the resolutions that close the pending UI cards.
      void this.settlePendingHumanRequests(context, "session exited");
      this.updateSession(context, {
        status: "closed",
        activeTurnId: undefined,
        lastError: code === 0 ? context.session.lastError : message,
      });
      this.emitLifecycleEvent(context, "session/exited", message);
      if (context.discovery) {
        const discoveryKey = context.session.cwd ?? "";
        if (discoveryKey) {
          this.discoverySessions.delete(discoveryKey);
        }
      } else {
        this.sessions.delete(context.session.threadId);
      }
    });
  }

  private handleTransportFailure(context: CodexSessionContext, cause: unknown): void {
    if (context.stopping || context.transportFailureHandled) return;
    context.transportFailureHandled = true;
    if (context.stdoutEndTimer) {
      clearTimeout(context.stdoutEndTimer);
      delete context.stdoutEndTimer;
    }
    const error =
      cause instanceof Error ? cause : new Error("Codex app-server transport failed", { cause });
    const reason =
      error instanceof CodexAppServerTransportError
        ? error.message
        : `Codex app-server transport failed: ${error.message}`;
    const message = formatCodexProcessFailure(context, reason);
    log.error("codex app-server transport failed", {
      threadId: context.session.threadId,
      message,
    });
    // Preserve the process diagnosis for whichever startup/runtime request was
    // actually waiting. stopSession's generic cancellation must not overwrite
    // the root failure after stdout or the child process has already failed.
    this.rejectPendingRequests(context, new Error(message, { cause: error }));
    this.updateSession(context, { status: "error", lastError: message });
    this.emitErrorEvent(context, "protocol/transportError", message);

    const stopping = context.discovery
      ? this.stopDiscoverySession(context.session.cwd ?? "")
      : this.stopSession(context.session.threadId);
    void stopping.catch((stopError) => {
      log.error("failed to stop Codex session after transport error", {
        threadId: context.session.threadId,
        error: stopError,
      });
    });
  }

  private handleStdoutLine(context: CodexSessionContext, line: string): void {
    if (isIgnorableCodexProcessLine(line)) {
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // App-server stdout is JSONL, but Codex subprocesses and hooks can leak
      // arbitrary output onto the same pipe, including fragments that begin
      // like JSON-RPC. An unparseable line cannot be a usable protocol frame;
      // ignore it and let any affected request fail through its normal timeout.
      logIgnoredCodexStdout(line, "invalid JSON fragment");
      return;
    }

    const protocolEnvelope = asObject(parsed);
    if (!protocolEnvelope || !isCodexProtocolEnvelope(protocolEnvelope)) {
      // Command output can also be valid standalone JSON (`{}`, `[]`, strings,
      // numbers). Only JSON-RPC-shaped envelopes belong to app-server itself.
      logIgnoredCodexStdout(line, "valid JSON without a JSON-RPC envelope");
      return;
    }

    if (this.isServerRequest(parsed)) {
      void this.handleServerRequest(context, parsed).catch((cause) =>
        this.handleTransportFailure(context, cause),
      );
      return;
    }

    if (this.isServerNotification(parsed)) {
      this.handleServerNotification(context, parsed);
      return;
    }

    if (this.isResponse(parsed)) {
      this.handleResponse(context, parsed);
      return;
    }

    this.emitErrorEvent(
      context,
      "protocol/unrecognizedMessage",
      "Received protocol message in an unknown shape.",
    );
  }

  private handleServerNotification(
    context: CodexSessionContext,
    notification: JsonRpcNotification,
  ): void {
    if (notification.method === "mcpServer/startupStatus/updated") {
      const params = asObject(notification.params);
      const name = asString(params?.name)?.trim();
      const state = asString(params?.status);
      if (
        name &&
        (state === "starting" || state === "ready" || state === "failed" || state === "cancelled")
      ) {
        context.mcpStartupStatuses.set(name, {
          name,
          state,
          error: asString(params?.error) ?? null,
        });
      }
    }
    const rawRoute = this.readRouteFields(notification.params);
    this.rememberCollabReceiverTurns(context, notification.params, rawRoute.turnId);
    const resolvedCollaborationRoute = this.resolveCollaborationRoute(context, notification.params);
    const {
      parentTurnId: childParentTurnId,
      providerThreadId,
      providerParentThreadId,
      isChildConversation,
    } = resolvedCollaborationRoute;
    if (
      isChildConversation &&
      this.shouldSuppressChildConversationNotification(notification.method)
    ) {
      return;
    }
    const isTerminalTurn =
      rawRoute.turnId !== undefined && context.terminalTurnIds.has(rawRoute.turnId);
    if (notification.method === "turn/started" && !isChildConversation && isTerminalTurn) {
      // A terminal turn is immutable within one app-server lifecycle. Do not
      // forward a delayed duplicate start, because the projection would
      // otherwise make an already-finished turn active again.
      log.warn("Ignoring turn/started for a terminal Codex turn", {
        threadId: context.session.threadId,
        turnId: rawRoute.turnId,
      });
      return;
    }
    const textDelta =
      notification.method === "item/agentMessage/delta"
        ? this.readString(notification.params, "delta")
        : undefined;

    this.emitEvent({
      id: EventId.makeUnsafe(randomUUID()),
      kind: "notification",
      provider: "codex",
      threadId: context.session.threadId,
      createdAt: new Date().toISOString(),
      ...(context.lifecycleGeneration !== undefined
        ? { lifecycleGeneration: context.lifecycleGeneration }
        : {}),
      method: notification.method,
      ...(rawRoute.turnId ? { turnId: rawRoute.turnId } : {}),
      ...(childParentTurnId ? { parentTurnId: childParentTurnId } : {}),
      ...(rawRoute.itemId ? { itemId: rawRoute.itemId } : {}),
      ...(providerThreadId ? { providerThreadId } : {}),
      ...(providerParentThreadId ? { providerParentThreadId } : {}),
      textDelta,
      payload: notification.params,
    });

    if (notification.method === "thread/started") {
      const startedThreadId = normalizeProviderThreadId(
        this.readString(this.readObject(notification.params)?.thread, "id"),
      );
      if (startedThreadId && !isChildConversation) {
        this.updateSession(context, {
          resumeCursor: { threadId: startedThreadId },
        });
      }
      return;
    }

    if (notification.method === "thread/compacted") {
      // Compaction is the only work that can hold the session "running" without
      // a turn; settle it here so the status cannot stay stuck once it lands.
      if (
        !isChildConversation &&
        context.session.activeTurnId === undefined &&
        context.session.status === "running"
      ) {
        this.updateSession(context, { status: "ready" });
      }
      return;
    }

    if (notification.method === "turn/started") {
      if (isChildConversation) {
        return;
      }
      this.clearTaskCompleteFallback(context);
      const turnId = toTurnId(this.readString(this.readObject(notification.params)?.turn, "id"));
      if (
        turnId !== undefined &&
        context.session.activeTurnId !== undefined &&
        context.reviewTurnIds.has(context.session.activeTurnId)
      ) {
        context.reviewTurnIds.add(turnId);
        log.info("[codex-review] extending tracked review turn set on turn/started", {
          threadId: context.session.threadId,
          previousTurnId: context.session.activeTurnId,
          nextTurnId: turnId,
        });
      }
      this.updateSession(context, {
        status: "running",
        activeTurnId: turnId,
      });
      return;
    }

    if (notification.method === "turn/completed") {
      if (isChildConversation) {
        return;
      }
      this.clearTaskCompleteFallback(context, rawRoute.turnId);
      context.collabReceiverTurns.clear();
      context.collabReceiverParents.clear();
      if (rawRoute.turnId) {
        context.terminalTurnIds.add(rawRoute.turnId);
        context.reviewTurnIds.delete(rawRoute.turnId);
      }
      const turn = this.readObject(notification.params, "turn");
      const status = this.readString(turn, "status");
      const errorMessageRaw = this.readString(this.readObject(turn, "error"), "message");
      const errorMessage =
        errorMessageRaw !== undefined
          ? normalizeCodexUserVisibleErrorMessage(errorMessageRaw)
          : undefined;
      this.updateSession(context, {
        status: status === "failed" ? "error" : "ready",
        activeTurnId: undefined,
        lastError: errorMessage ?? context.session.lastError,
      });
      return;
    }

    if (notification.method === "turn/aborted") {
      if (isChildConversation) {
        return;
      }
      this.clearTaskCompleteFallback(context, rawRoute.turnId);
      context.collabReceiverTurns.clear();
      context.collabReceiverParents.clear();
      if (rawRoute.turnId) {
        context.terminalTurnIds.add(rawRoute.turnId);
        context.reviewTurnIds.delete(rawRoute.turnId);
      }
      this.updateSession(context, {
        status: "ready",
        activeTurnId: undefined,
        lastError: undefined,
      });
      return;
    }

    if (notification.method === "codex/event/task_complete") {
      if (isChildConversation || rawRoute.turnId === undefined) {
        return;
      }
      this.scheduleTaskCompleteFallback(context, rawRoute.turnId);
      return;
    }

    if (this.isExitedReviewModeNotification(notification)) {
      if (isChildConversation) {
        return;
      }
      const item = this.readObject(notification.params, "item");
      const reviewTurnId = toTurnId(this.readString(item, "id")) ?? rawRoute.turnId;
      const reviewTurnTracked =
        reviewTurnId !== undefined ? context.reviewTurnIds.has(reviewTurnId) : false;
      const activeTurnTracked =
        context.session.activeTurnId !== undefined &&
        context.reviewTurnIds.has(context.session.activeTurnId);
      log.info("[codex-review] exitedReviewMode notification", {
        threadId: context.session.threadId,
        reviewTurnId: reviewTurnId ?? null,
        activeTurnId: context.session.activeTurnId ?? null,
        reviewTurnTracked,
        activeTurnTracked,
      });
      if (
        reviewTurnId !== undefined &&
        context.session.activeTurnId !== undefined &&
        reviewTurnId !== context.session.activeTurnId &&
        !reviewTurnTracked &&
        !activeTurnTracked
      ) {
        log.info("[codex-review] exitedReviewMode ignored due to turn mismatch", {
          threadId: context.session.threadId,
          reviewTurnId,
          activeTurnId: context.session.activeTurnId,
        });
        return;
      }
      // `review/start` can emit the final review result via `exitedReviewMode`
      // before the terminal `turn/completed` notification arrives. If that
      // completion never shows up, settle the session here instead of leaving
      // native review stuck in "running" forever.
      log.info("[codex-review] settling review from exitedReviewMode notification", {
        threadId: context.session.threadId,
        reviewTurnId: reviewTurnId ?? null,
      });
      this.settleTrackedReview(
        context,
        reviewTurnId !== undefined
          ? {
              completedTurnId: reviewTurnId,
              reason: "review exited via exitedReviewMode",
            }
          : {
              reason: "review exited via exitedReviewMode",
            },
      );
      return;
    }

    if (notification.method === "error") {
      if (isChildConversation) {
        return;
      }
      const rawMessage = this.readString(this.readObject(notification.params)?.error, "message");
      const message =
        rawMessage !== undefined ? normalizeCodexUserVisibleErrorMessage(rawMessage) : undefined;
      const willRetry = this.readBoolean(notification.params, "willRetry");
      const isNonFatalWarning =
        message !== undefined && !willRetry && isNonFatalCodexErrorMessage(message);

      if (willRetry) {
        // Only a live turn may restore "running"; otherwise a retryable error
        // arriving between turns would strand the session with no turn to
        // reconcile against.
        if (context.session.activeTurnId !== undefined) {
          this.updateSession(context, {
            status: "running",
          });
        }
        return;
      }

      if (isNonFatalWarning) {
        return;
      }

      this.clearTaskCompleteFallback(context);
      this.updateSession(context, {
        status: "error",
        lastError: message ?? context.session.lastError,
      });
    }
  }

  private async handleServerRequest(
    context: CodexSessionContext,
    request: JsonRpcRequest,
  ): Promise<void> {
    const rawRoute = this.readRouteFields(request.params);
    const resolvedCollaborationRoute = this.resolveCollaborationRoute(context, request.params);
    const {
      parentTurnId: childParentTurnId,
      providerThreadId,
      providerParentThreadId,
    } = resolvedCollaborationRoute;
    const requestKind = this.requestKindForMethod(request.method);
    let requestId: ApprovalRequestId | undefined;
    if (requestKind) {
      requestId = ApprovalRequestId.makeUnsafe(randomUUID());
      const pendingRequest: PendingApprovalRequest = {
        requestId,
        jsonRpcId: request.id,
        method:
          requestKind === "command"
            ? "item/commandExecution/requestApproval"
            : requestKind === "file-read"
              ? "item/fileRead/requestApproval"
              : "item/fileChange/requestApproval",
        requestKind,
        threadId: context.session.threadId,
        ...(rawRoute.turnId ? { turnId: rawRoute.turnId } : {}),
        ...(childParentTurnId ? { parentTurnId: childParentTurnId } : {}),
        ...(rawRoute.itemId ? { itemId: rawRoute.itemId } : {}),
        ...(providerThreadId ? { providerThreadId } : {}),
        ...(providerParentThreadId ? { providerParentThreadId } : {}),
      };
      if (context.sessionApprovalOverride) {
        await this.resolveApprovalRequest(context, pendingRequest, "acceptForSession");
        return;
      }
      context.pendingApprovals.set(requestId, pendingRequest);
    }

    const isUserInputRequest = request.method === "item/tool/requestUserInput";
    // Parsed up front: a request whose questions cannot be rendered must never
    // become a pending entry, because nothing would ever answer its JSON-RPC id.
    const userInputQuestions = isUserInputRequest
      ? parseCodexUserInputQuestions(asObject(request.params))
      : undefined;
    if (isUserInputRequest && userInputQuestions) {
      requestId = ApprovalRequestId.makeUnsafe(randomUUID());
      context.pendingUserInputs.set(requestId, {
        requestId,
        jsonRpcId: request.id,
        threadId: context.session.threadId,
        ...(rawRoute.turnId ? { turnId: rawRoute.turnId } : {}),
        ...(childParentTurnId ? { parentTurnId: childParentTurnId } : {}),
        ...(rawRoute.itemId ? { itemId: rawRoute.itemId } : {}),
        ...(providerThreadId ? { providerThreadId } : {}),
        ...(providerParentThreadId ? { providerParentThreadId } : {}),
      });
    }

    this.emitEvent({
      id: EventId.makeUnsafe(randomUUID()),
      kind: "request",
      provider: "codex",
      threadId: context.session.threadId,
      createdAt: new Date().toISOString(),
      ...(context.lifecycleGeneration !== undefined
        ? { lifecycleGeneration: context.lifecycleGeneration }
        : {}),
      method: request.method,
      ...(rawRoute.turnId ? { turnId: rawRoute.turnId } : {}),
      ...(childParentTurnId ? { parentTurnId: childParentTurnId } : {}),
      ...(rawRoute.itemId ? { itemId: rawRoute.itemId } : {}),
      ...(providerThreadId ? { providerThreadId } : {}),
      ...(providerParentThreadId ? { providerParentThreadId } : {}),
      requestId,
      requestKind,
      payload: request.params,
    });

    if (requestKind) {
      return;
    }

    if (isUserInputRequest) {
      if (userInputQuestions) {
        // Intentionally unanswered: a human replies through respondToUserInput.
        return;
      }

      const detail = "Codex asked a question Penkra could not render, so it was declined.";
      this.emitErrorEvent(context, "item/tool/requestUserInput/unrenderable", detail);
      await this.writeMessage(context, {
        id: request.id,
        error: {
          code: -32602,
          message: "item/tool/requestUserInput did not include a renderable question.",
        },
      });
      return;
    }

    if (request.method === "item/tool/call") {
      const params = this.readObject(request.params);
      const requestedThreadId = this.readString(params, "threadId");
      const activeProviderThreadId = readResumeCursorThreadId(context.session.resumeCursor);
      const toolName = this.readString(params, "tool");
      const namespace = params?.namespace;
      const rawArguments = params?.arguments;
      if (
        !context.gatewaySessionLease ||
        !this.agentGatewayHostTool ||
        !activeProviderThreadId ||
        requestedThreadId !== activeProviderThreadId ||
        namespace !== null ||
        !toolName ||
        !rawArguments ||
        typeof rawArguments !== "object" ||
        Array.isArray(rawArguments)
      ) {
        await this.writeMessage(context, {
          id: request.id,
          result: {
            contentItems: [
              { type: "inputText", text: "Penkra rejected an invalid dynamic tool request." },
            ],
            success: false,
          },
        });
        return;
      }
      const result = await this.agentGatewayHostTool.requireNativeSurface().invoke({
        bearerToken: context.gatewaySessionLease.connection.bearerToken,
        name: toolName,
        arguments: rawArguments as Record<string, unknown>,
      });
      await this.writeMessage(context, {
        id: request.id,
        result: {
          contentItems: result.content.map((item) =>
            item.type === "text"
              ? { type: "inputText", text: item.text }
              : {
                  type: "inputImage",
                  imageUrl: `data:${item.mimeType};base64,${item.data}`,
                },
          ),
          success: result.isError !== true,
        },
      });
      return;
    }

    await this.writeMessage(context, {
      id: request.id,
      error: {
        code: -32601,
        message: `Unsupported server request: ${request.method}`,
      },
    });
  }

  private handleResponse(context: CodexSessionContext, response: JsonRpcResponse): void {
    const key = String(response.id);
    const pending = context.pending.get(key);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timeout);
    context.pending.delete(key);

    if (response.error) {
      const rpcMessage =
        typeof response.error.message === "string"
          ? response.error.message
          : "Codex returned a JSON-RPC error without a message.";
      pending.reject(
        new CodexJsonRpcRequestError({
          method: pending.method,
          ...(typeof response.error.code === "number" ? { code: response.error.code } : {}),
          rpcMessage,
          ...(response.error.data !== undefined ? { data: response.error.data } : {}),
        }),
      );
      return;
    }

    pending.resolve(response.result);
  }

  private async sendRequest<TResponse>(
    context: CodexSessionContext,
    method: string,
    params: unknown,
    timeoutMs = 20_000,
    signal?: AbortSignal,
  ): Promise<TResponse> {
    if (signal?.aborted) {
      throw new Error(`Cancelled ${method} because Codex session startup was interrupted.`);
    }
    const id = context.nextRequestId;
    context.nextRequestId += 1;
    context.lastRequestMethod = method;

    const result = await new Promise<unknown>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
      };
      const onAbort = () => {
        context.pending.delete(String(id));
        cleanup();
        reject(new Error(`Cancelled ${method} because Codex session startup was interrupted.`));
      };
      const timeout = setTimeout(() => {
        context.pending.delete(String(id));
        signal?.removeEventListener("abort", onAbort);
        reject(new Error(`Timed out waiting for ${method}.`));
      }, timeoutMs);

      context.pending.set(String(id), {
        method,
        timeout,
        resolve: (value) => {
          cleanup();
          resolve(value);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
        return;
      }
      void this.writeMessage(context, { method, id, params }).catch((error) => {
        context.pending.delete(String(id));
        cleanup();
        reject(error);
      });
    });

    return result as TResponse;
  }

  private writeMessage(context: CodexSessionContext, message: unknown): Promise<void> {
    return context.stdinWriter.write(message).catch((cause) => {
      this.handleTransportFailure(context, cause);
      throw cause;
    });
  }

  private emitLifecycleEvent(context: CodexSessionContext, method: string, message: string): void {
    if (context.discovery) {
      return;
    }
    this.emitEvent({
      id: EventId.makeUnsafe(randomUUID()),
      kind: "session",
      provider: "codex",
      threadId: context.session.threadId,
      createdAt: new Date().toISOString(),
      ...(context.lifecycleGeneration !== undefined
        ? { lifecycleGeneration: context.lifecycleGeneration }
        : {}),
      method,
      message,
    });
  }

  private emitErrorEvent(context: CodexSessionContext, method: string, message: string): void {
    if (context.discovery) {
      return;
    }
    this.emitEvent({
      id: EventId.makeUnsafe(randomUUID()),
      kind: "error",
      provider: "codex",
      threadId: context.session.threadId,
      createdAt: new Date().toISOString(),
      ...(context.lifecycleGeneration !== undefined
        ? { lifecycleGeneration: context.lifecycleGeneration }
        : {}),
      method,
      message,
    });
  }

  private emitEvent(event: ProviderEvent): void {
    this.emit("event", event);
  }

  private clearTaskCompleteFallback(context: CodexSessionContext, turnId?: TurnId): void {
    const pending = context.taskCompleteFallback;
    if (!pending || (turnId !== undefined && pending.turnId !== turnId)) {
      return;
    }
    clearTimeout(pending.timeout);
    context.taskCompleteFallback = undefined;
  }

  private scheduleTaskCompleteFallback(context: CodexSessionContext, turnId: TurnId): void {
    if (
      context.stopping ||
      context.session.status !== "running" ||
      (context.session.activeTurnId !== undefined && context.session.activeTurnId !== turnId)
    ) {
      return;
    }

    this.clearTaskCompleteFallback(context);
    const timeout = setTimeout(() => {
      if (context.taskCompleteFallback?.turnId !== turnId) {
        return;
      }
      context.taskCompleteFallback = undefined;
      if (
        context.stopping ||
        context.session.status !== "running" ||
        (context.session.activeTurnId !== undefined && context.session.activeTurnId !== turnId)
      ) {
        return;
      }

      context.collabReceiverTurns.clear();
      context.collabReceiverParents.clear();
      context.terminalTurnIds.add(turnId);
      context.reviewTurnIds.delete(turnId);
      this.updateSession(context, {
        status: "ready",
        activeTurnId: undefined,
        lastError: undefined,
      });
      this.emitEvent({
        id: EventId.makeUnsafe(randomUUID()),
        kind: "notification",
        provider: "codex",
        threadId: context.session.threadId,
        createdAt: new Date().toISOString(),
        ...(context.lifecycleGeneration !== undefined
          ? { lifecycleGeneration: context.lifecycleGeneration }
          : {}),
        method: "turn/completed",
        turnId,
        message: "Recovered a missing turn/completed notification after task_complete.",
        payload: {
          turn: {
            id: turnId,
            status: "completed",
          },
          recoveredFrom: "codex/event/task_complete",
        },
      });
    }, this.taskCompleteFallbackGraceMs);
    timeout.unref();
    context.taskCompleteFallback = { turnId, timeout };
  }

  private settleTrackedReview(
    context: CodexSessionContext,
    input: {
      readonly completedTurnId?: TurnId;
      readonly reason: string;
    },
  ): void {
    const terminalTurnId =
      context.session.activeTurnId !== undefined &&
      context.reviewTurnIds.has(context.session.activeTurnId)
        ? context.session.activeTurnId
        : input.completedTurnId !== undefined && context.reviewTurnIds.has(input.completedTurnId)
          ? input.completedTurnId
          : context.reviewTurnIds.values().next().value;

    this.updateSession(context, {
      status: "ready",
      activeTurnId: undefined,
      lastError: undefined,
    });

    context.reviewTurnIds.clear();

    if (!terminalTurnId) {
      return;
    }

    context.terminalTurnIds.add(terminalTurnId);

    this.emitEvent({
      id: EventId.makeUnsafe(randomUUID()),
      kind: "notification",
      provider: "codex",
      threadId: context.session.threadId,
      createdAt: new Date().toISOString(),
      ...(context.lifecycleGeneration !== undefined
        ? { lifecycleGeneration: context.lifecycleGeneration }
        : {}),
      method: "turn/completed",
      turnId: terminalTurnId,
      message: input.reason,
      payload: {
        turn: {
          id: terminalTurnId,
          status: "completed",
        },
      },
    });
  }

  private async assertSupportedCodexCliVersion(input: {
    readonly binaryPath: string;
    readonly cwd: string;
    readonly homePath?: string;
  }): Promise<void> {
    await assertSupportedCodexCliVersion(input);
  }

  private updateSession(context: CodexSessionContext, updates: Partial<ProviderSession>): void {
    context.session = {
      ...context.session,
      ...updates,
      updatedAt: new Date().toISOString(),
    };
  }

  private requestKindForMethod(method: string): ProviderRequestKind | undefined {
    if (method === "item/commandExecution/requestApproval") {
      return "command";
    }

    if (method === "item/fileRead/requestApproval") {
      return "file-read";
    }

    if (method === "item/fileChange/requestApproval") {
      return "file-change";
    }

    return undefined;
  }

  private parseThreadSnapshot(method: string, response: unknown): CodexThreadSnapshot {
    const responseRecord = this.readObject(response);
    const threadRecord = this.readObject(responseRecord, "thread");
    const threadIdRaw = this.readThreadIdFromResponse(method, responseRecord);
    const turnsRaw =
      this.readArray(threadRecord, "turns") ?? this.readArray(responseRecord, "turns") ?? [];
    const turns = turnsRaw.map((turnValue, index) => {
      const turn = this.readObject(turnValue);
      const turnIdRaw = this.readString(turn, "id") ?? `${threadIdRaw}:turn:${index + 1}`;
      const turnId = TurnId.makeUnsafe(turnIdRaw);
      const items = this.readArray(turn, "items") ?? [];
      return {
        id: turnId,
        items,
      };
    });

    return {
      threadId: threadIdRaw,
      turns,
      cwd: this.readString(threadRecord, "cwd") ?? this.readString(responseRecord, "cwd") ?? null,
    };
  }

  private toCodexReviewTarget(target: CodexAppServerReviewTarget): Record<string, unknown> {
    switch (target.type) {
      case "uncommittedChanges":
        return {
          type: "uncommittedChanges",
        };
      case "baseBranch":
        return {
          type: "baseBranch",
          branch: target.branch,
        };
    }
  }

  private readThreadIdFromResponse(method: string, response: unknown): string {
    const responseRecord = this.readObject(response);
    const thread = this.readObject(responseRecord, "thread");
    const threadIdRaw =
      this.readString(thread, "id") ?? this.readString(responseRecord, "threadId");
    if (!threadIdRaw) {
      throw new Error(`${method} response did not include a thread id.`);
    }
    return threadIdRaw;
  }

  private isServerRequest(value: unknown): value is JsonRpcRequest {
    if (!value || typeof value !== "object") {
      return false;
    }

    const candidate = value as Record<string, unknown>;
    return (
      typeof candidate.method === "string" &&
      (typeof candidate.id === "string" || typeof candidate.id === "number")
    );
  }

  private isServerNotification(value: unknown): value is JsonRpcNotification {
    if (!value || typeof value !== "object") {
      return false;
    }

    const candidate = value as Record<string, unknown>;
    return typeof candidate.method === "string" && !("id" in candidate);
  }

  private isResponse(value: unknown): value is JsonRpcResponse {
    if (!value || typeof value !== "object") {
      return false;
    }

    const candidate = value as Record<string, unknown>;
    const hasId = typeof candidate.id === "string" || typeof candidate.id === "number";
    const hasMethod = typeof candidate.method === "string";
    return hasId && !hasMethod;
  }

  private readRouteFields(params: unknown): {
    turnId?: TurnId;
    itemId?: ProviderItemId;
  } {
    const route: {
      turnId?: TurnId;
      itemId?: ProviderItemId;
    } = {};

    const turnId = toTurnId(
      this.readString(params, "turnId") ??
        this.readString(this.readObject(params, "turn"), "id") ??
        this.readString(this.readObject(params, "msg"), "turn_id") ??
        this.readString(this.readObject(params, "msg"), "turnId"),
    );
    const itemId = toProviderItemId(
      this.readString(params, "itemId") ?? this.readString(this.readObject(params, "item"), "id"),
    );

    if (turnId) {
      route.turnId = turnId;
    }

    if (itemId) {
      route.itemId = itemId;
    }

    return route;
  }

  private readProviderConversationId(params: unknown): string | undefined {
    return (
      this.readString(params, "threadId") ??
      this.readString(this.readObject(params, "thread"), "id") ??
      this.readString(params, "conversationId")
    );
  }

  private resolveCollaborationRoute(
    context: CodexSessionContext,
    params: unknown,
  ): ResolvedCollaborationRoute {
    const parentTurnId = this.readChildParentTurnId(context, params);
    const providerThreadId = normalizeProviderThreadId(this.readProviderConversationId(params));
    const mappedProviderParentThreadId = this.readChildParentProviderThreadId(context, params);
    const activeProviderThreadId = normalizeProviderThreadId(
      readResumeThreadId({
        threadId: context.session.threadId,
        runtimeMode: context.session.runtimeMode,
        resumeCursor: context.session.resumeCursor,
      }),
    );
    // A child can emit events before its collab tool-call payload populates the
    // receiver maps. During a live parent turn, another provider thread belongs
    // to that active conversation. Preserve the mapped parent when one exists;
    // otherwise provide the active provider thread required for child routing.
    const isUnmappedChildConversation =
      mappedProviderParentThreadId === undefined &&
      context.session.status === "running" &&
      context.session.activeTurnId !== undefined &&
      providerThreadId !== undefined &&
      activeProviderThreadId !== undefined &&
      providerThreadId !== activeProviderThreadId;
    const providerParentThreadId =
      mappedProviderParentThreadId ??
      (isUnmappedChildConversation ? activeProviderThreadId : undefined);

    return {
      ...(parentTurnId ? { parentTurnId } : {}),
      ...(providerThreadId ? { providerThreadId } : {}),
      ...(providerParentThreadId ? { providerParentThreadId } : {}),
      isChildConversation:
        parentTurnId !== undefined ||
        providerParentThreadId !== undefined ||
        isUnmappedChildConversation,
    };
  }

  private readChildParentTurnId(context: CodexSessionContext, params: unknown): TurnId | undefined {
    const providerConversationId = this.readProviderConversationId(params);
    if (!providerConversationId) {
      return undefined;
    }
    return context.collabReceiverTurns.get(providerConversationId);
  }

  private readChildParentProviderThreadId(
    context: CodexSessionContext,
    params: unknown,
  ): string | undefined {
    const providerConversationId = this.readProviderConversationId(params);
    if (!providerConversationId) {
      return undefined;
    }
    return context.collabReceiverParents.get(providerConversationId);
  }

  private rememberCollabReceiverTurns(
    context: CodexSessionContext,
    params: unknown,
    parentTurnId: TurnId | undefined,
  ): void {
    if (!parentTurnId) {
      return;
    }
    const payload = this.readObject(params);
    const item = this.readObject(payload, "item") ?? payload;
    const itemType = this.readString(item, "type") ?? this.readString(item, "kind");
    if (itemType !== "collabAgentToolCall" && itemType !== "collabToolCall") {
      return;
    }
    const parentProviderThreadId = normalizeProviderThreadId(
      this.readProviderConversationId(params),
    );

    const receiverThreadIds = decodeSubagentReceiverThreadIds(item);
    for (const receiverThreadId of receiverThreadIds) {
      context.collabReceiverTurns.set(receiverThreadId, parentTurnId);
      if (parentProviderThreadId) {
        context.collabReceiverParents.set(receiverThreadId, parentProviderThreadId);
      }
    }
  }

  private shouldSuppressChildConversationNotification(method: string): boolean {
    // Intentionally do NOT suppress `turn/plan/updated` or `item/plan/delta` here,
    // even for child conversations. These are the events that let the active plan
    // card advance ("1 out of 5" → "2 out of 5" ...) and render streaming plan text;
    // suppressing them freezes the plan UI at its initial all-pending snapshot.
    return (
      method === "thread/started" ||
      method === "thread/status/changed" ||
      method === "thread/archived" ||
      method === "thread/unarchived" ||
      method === "thread/closed" ||
      method === "thread/compacted" ||
      method === "thread/name/updated" ||
      method === "thread/tokenUsage/updated" ||
      method === "turn/started" ||
      method === "turn/completed" ||
      method === "turn/aborted"
    );
  }

  private readObject(value: unknown, key?: string): Record<string, unknown> | undefined {
    const target =
      key === undefined
        ? value
        : value && typeof value === "object"
          ? (value as Record<string, unknown>)[key]
          : undefined;

    if (!target || typeof target !== "object") {
      return undefined;
    }

    return target as Record<string, unknown>;
  }

  private readArray(value: unknown, key?: string): unknown[] | undefined {
    const target =
      key === undefined
        ? value
        : value && typeof value === "object"
          ? (value as Record<string, unknown>)[key]
          : undefined;
    return Array.isArray(target) ? target : undefined;
  }

  private readString(value: unknown, key: string): string | undefined {
    if (!value || typeof value !== "object") {
      return undefined;
    }

    const candidate = (value as Record<string, unknown>)[key];
    return typeof candidate === "string" ? candidate : undefined;
  }

  private readBoolean(value: unknown, key: string): boolean | undefined {
    if (!value || typeof value !== "object") {
      return undefined;
    }

    const candidate = (value as Record<string, unknown>)[key];
    return typeof candidate === "boolean" ? candidate : undefined;
  }

  private readFirstBoolean(value: unknown, keys: readonly string[]): boolean | undefined {
    for (const key of keys) {
      const candidate = this.readBoolean(value, key);
      if (candidate !== undefined) {
        return candidate;
      }
    }
    return undefined;
  }

  private isExitedReviewModeNotification(notification: JsonRpcNotification): boolean {
    if (notification.method !== "item/completed") {
      return false;
    }
    const item = this.readObject(notification.params, "item");
    const itemType = this.readString(item, "type") ?? this.readString(item, "kind");
    return itemType === "exitedReviewMode";
  }

  private isTurnInterruptTimeout(error: unknown): boolean {
    return error instanceof Error && error.message.includes("Timed out waiting for turn/interrupt");
  }

  private normalizeItemType(raw: unknown): string {
    if (typeof raw !== "string") return "";
    return raw
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/[._/-]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  private turnHasReviewItem(
    turn: CodexThreadTurnSnapshot,
    itemType: "entered" | "exited",
  ): boolean {
    return turn.items.some((item) => {
      const record = this.readObject(item);
      const normalized = this.normalizeItemType(
        this.readString(record, "type") ?? this.readString(record, "kind"),
      );
      return itemType === "entered"
        ? normalized.includes("entered review mode")
        : normalized.includes("exited review mode");
    });
  }

  private findLatestReviewTurnId(snapshot: CodexThreadSnapshot): TurnId | undefined {
    const latestReviewTurn = [...snapshot.turns]
      .reverse()
      .find((turn) => this.turnHasReviewItem(turn, "entered"));
    return latestReviewTurn?.id;
  }

  private isExitedReviewTurn(snapshot: CodexThreadSnapshot, turnId: TurnId): boolean {
    const turn = snapshot.turns.find((entry) => entry.id === turnId);
    return turn ? this.turnHasReviewItem(turn, "exited") : false;
  }
}

function brandIfNonEmpty<T extends string>(
  value: string | undefined,
  maker: (value: string) => T,
): T | undefined {
  const normalized = value?.trim();
  return normalized?.length ? maker(normalized) : undefined;
}

function normalizeProviderThreadId(value: string | undefined): string | undefined {
  return brandIfNonEmpty(value, (normalized) => normalized);
}

function readCodexProviderOptions(input: CodexAppServerStartSessionInput): {
  readonly binaryPath?: string;
  readonly homePath?: string;
} {
  const options = input.providerOptions?.codex;
  if (!options) {
    return {};
  }
  return {
    ...(options.binaryPath ? { binaryPath: options.binaryPath } : {}),
    ...(options.homePath ? { homePath: options.homePath } : {}),
  };
}

function isMissingExecutableSpawnError(error: Error): boolean {
  const lower = error.message.toLowerCase();
  return (
    lower.includes("enoent") ||
    lower.includes("command not found") ||
    lower.includes("not found") ||
    lower.includes("filesystem.access")
  );
}

interface CodexVersionCommandResult {
  readonly error?: Error;
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Run `codex --version` asynchronously.
 *
 * This intentionally mirrors `spawnSync`'s result shape (`error` / `status` /
 * `stdout` / `stderr`) so the version-gate semantics below stay byte-for-byte
 * identical, but without blocking the event loop: a synchronous spawn froze the
 * WebSocket fanout, PTY drains, and every provider's stdio for the duration of the
 * probe (measured ~80-97 ms, up to the 4 s timeout when the binary hangs).
 */
function runCodexVersionCommand(input: {
  readonly binaryPath: string;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}): Promise<CodexVersionCommandResult> {
  const prepared = prepareWindowsSafeProcess(input.binaryPath, ["--version"], {
    cwd: input.cwd,
    env: input.env,
  });

  return new Promise<CodexVersionCommandResult>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(prepared.command, prepared.args, {
        cwd: input.cwd,
        env: input.env,
        stdio: ["ignore", "pipe", "pipe"],
        shell: prepared.shell,
        windowsHide: prepared.windowsHide,
        windowsVerbatimArguments: prepared.windowsVerbatimArguments,
      });
    } catch (error) {
      resolve({
        error: error instanceof Error ? error : new Error(String(error)),
        status: null,
        stdout: "",
        stderr: "",
      });
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: CodexVersionCommandResult) => {
      if (settled) return;
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      resolve(result);
    };
    // Bound captured output the same way spawnSync's maxBuffer did; `codex
    // --version` prints a single line, so truncation only affects pathological
    // output and never the parsed version.
    const append = (buffer: string, chunk: string) =>
      buffer.length >= CODEX_VERSION_CHECK_MAX_OUTPUT_BYTES
        ? buffer
        : (buffer + chunk).slice(0, CODEX_VERSION_CHECK_MAX_OUTPUT_BYTES);

    timer = setTimeout(() => {
      // SIGKILL (rather than spawnSync's SIGTERM) because the promise settles here
      // regardless: a binary that ignores SIGTERM would otherwise linger forever.
      child.kill("SIGKILL");
      finish({
        error: new Error(
          `Codex CLI version check timed out after ${CODEX_VERSION_CHECK_TIMEOUT_MS}ms.`,
        ),
        status: null,
        stdout,
        stderr,
      });
    }, CODEX_VERSION_CHECK_TIMEOUT_MS);
    timer.unref?.();

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout = append(stdout, chunk);
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr = append(stderr, chunk);
    });
    child.on("error", (error) => {
      finish({ error, status: null, stdout, stderr });
    });
    child.on("close", (code, signal) => {
      finish({ status: code ?? (signal ? -1 : 0), stdout, stderr });
    });
  });
}

/** What the probe observed about the file it actually ran, so a later swap can be detected. */
interface CodexCliBinaryFingerprint {
  readonly path: string;
  readonly identity: string;
}

async function runCodexCliVersionGate(input: {
  readonly binaryPath: string;
  readonly cwd: string;
  readonly homePath?: string;
}): Promise<CodexCliBinaryFingerprint | null> {
  const env = await buildCodexProcessEnv({
    ...(input.homePath ? { homePath: input.homePath } : {}),
  });
  // Resolved against the env the spawn below uses, never `process.env`. On macOS and Linux
  // `buildCodexProcessEnv` can replace PATH with the login shell's, so resolving through the
  // process environment could fingerprint a different `codex` than the one being probed — or
  // none at all — and the staleness check would then be watching the wrong file.
  const resolvedPath = resolveExecutable(input.binaryPath, { env });
  const identity = resolvedPath ? executableIdentity(resolvedPath) : null;
  const result = await runCodexVersionCommand({
    binaryPath: input.binaryPath,
    cwd: input.cwd,
    env,
  });

  if (result.error) {
    if (isMissingExecutableSpawnError(result.error)) {
      // Race: cwd may have disappeared between the pre-check and spawn.
      assertCodexWorkingDirectoryExists(input.cwd);
      throw new Error(`Codex CLI (${input.binaryPath}) is not installed or not executable.`);
    }
    throw new Error(
      `Failed to execute Codex CLI version check: ${result.error.message || String(result.error)}`,
    );
  }

  const { stdout, stderr } = result;
  if (result.status !== 0) {
    const detail = stderr.trim() || stdout.trim() || `Command exited with code ${result.status}.`;
    throw new Error(`Codex CLI version check failed. ${detail}`);
  }

  const parsedVersion = parseCodexCliVersion(`${stdout}\n${stderr}`);
  if (parsedVersion && !isCodexCliVersionSupported(parsedVersion)) {
    throw new Error(formatCodexCliUpgradeMessage(parsedVersion));
  }

  return resolvedPath && identity ? { path: resolvedPath, identity } : null;
}

interface CodexCliVersionGateEntry {
  promise: Promise<void>;
  /** 0 until the probe resolves successfully; failed verdicts are never reused. */
  expiresAt: number;
  /**
   * The file the successful probe ran, or null when it could not be located.
   *
   * The path alone does not identify a binary: `npm i -g @openai/codex`, a downgrade or a local
   * rebuild all leave the path untouched, so a purely path-keyed cache would keep serving the
   * pre-upgrade verdict for the rest of the TTL — long enough to swallow a downgrade below the
   * supported floor. Re-stat'ing this exact file on a cache hit costs one syscall and needs no
   * environment, which is why the fingerprint lives on the entry instead of in the key.
   */
  fingerprint: CodexCliBinaryFingerprint | null;
}

const codexCliVersionGates = new Map<string, CodexCliVersionGateEntry>();

function codexCliVersionGateKey(binaryPath: string, homePath: string | undefined): string {
  // The installed version depends only on which binary runs and which CODEX_HOME
  // shapes its environment — never on the caller's cwd. JSON encoding keeps the
  // components unambiguous, since a path may contain any separator we'd pick.
  return JSON.stringify([binaryPath, homePath ?? ""]);
}

/** True when the file behind a cached verdict is no longer the one that was probed. */
function isCodexCliVersionGateStale(entry: CodexCliVersionGateEntry): boolean {
  if (!entry.fingerprint) {
    // Nothing was located at probe time, so there is nothing to compare against. The probe is
    // what reports that failure, and failures are never cached, so no stale pass can hide here.
    return false;
  }
  return executableIdentity(entry.fingerprint.path) !== entry.fingerprint.identity;
}

async function assertSupportedCodexCliVersion(input: {
  readonly binaryPath: string;
  readonly cwd: string;
  readonly homePath?: string;
}): Promise<void> {
  // Prefer an explicit cwd check before spawning. A missing working directory
  // produces ENOENT that is otherwise misreported as a missing Codex binary. This
  // is per-call state, so it must run even when the version verdict is cached.
  assertCodexWorkingDirectoryExists(input.cwd);

  const key = codexCliVersionGateKey(input.binaryPath, input.homePath);
  const now = Date.now();
  const existing = codexCliVersionGates.get(key);
  if (existing) {
    // expiresAt === 0 means the probe is still in flight: concurrent session
    // starts share it instead of each spawning their own Codex process.
    if (existing.expiresAt === 0) {
      await existing.promise;
      return;
    }
    if (existing.expiresAt > now && !isCodexCliVersionGateStale(existing)) {
      await existing.promise;
      return;
    }
    codexCliVersionGates.delete(key);
  }

  for (const [otherKey, entry] of codexCliVersionGates) {
    if (entry.expiresAt !== 0 && entry.expiresAt <= now) {
      codexCliVersionGates.delete(otherKey);
    }
  }

  const entry: CodexCliVersionGateEntry = {
    promise: Promise.resolve(),
    expiresAt: 0,
    fingerprint: null,
  };
  entry.promise = runCodexCliVersionGate(input).then(
    (fingerprint) => {
      entry.fingerprint = fingerprint;
      entry.expiresAt = Date.now() + CODEX_VERSION_CHECK_CACHE_TTL_MS;
    },
    (error: unknown) => {
      // Never cache a failure: the user may install or upgrade Codex at any time.
      if (codexCliVersionGates.get(key) === entry) {
        codexCliVersionGates.delete(key);
      }
      throw error;
    },
  );
  codexCliVersionGates.set(key, entry);
  await entry.promise;
}

export const __codexCliVersionGateTesting = {
  assertSupportedCodexCliVersion,
  reset: () => codexCliVersionGates.clear(),
  cacheTtlMs: CODEX_VERSION_CHECK_CACHE_TTL_MS,
};

function readResumeCursorThreadId(resumeCursor: unknown): string | undefined {
  if (!resumeCursor || typeof resumeCursor !== "object" || Array.isArray(resumeCursor)) {
    return undefined;
  }
  const rawThreadId = (resumeCursor as Record<string, unknown>).threadId;
  return typeof rawThreadId === "string" ? normalizeProviderThreadId(rawThreadId) : undefined;
}

function readResumeThreadId(input: CodexAppServerStartSessionInput): string | undefined {
  return readResumeCursorThreadId(input.resumeCursor);
}

function toTurnId(value: string | undefined): TurnId | undefined {
  return brandIfNonEmpty(value, TurnId.makeUnsafe);
}

function toProviderItemId(value: string | undefined): ProviderItemId | undefined {
  return brandIfNonEmpty(value, ProviderItemId.makeUnsafe);
}
