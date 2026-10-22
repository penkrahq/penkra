import { type ChildProcess, type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, rm, writeFile } from "node:fs/promises";
import * as Path from "node:path";
import { StringDecoder } from "node:string_decoder";

import {
  EventId,
  MessageId,
  type ProviderComposerCapabilities,
  type ProviderCatalogData,
  type ProviderCatalogKind,
  ProviderItemId,
  type ProviderListModelsResult,
  type ProviderListPluginsResult,
  type ProviderMentionReference,
  type ProviderReadPluginResult,
  type ProviderListSkillsResult,
  type ProviderListPluginsInput,
  type ProviderReadPluginInput,
  type ProviderStartReviewInput,
  type ProviderSkillReference,
  ProviderRequestKind,
  type ProviderUserInputAnswers,
  ThreadId,
  TurnId,
  type ProviderEvent,
  type ProviderConnectionId,
  type ProviderSession,
  type ProviderSessionStartInput,
  type ProviderTurnStartResult,
  RuntimeMode,
  type ServerVoiceTranscriptionInput,
  type ServerVoiceTranscriptionResult,
  type UserInputQuestion,
} from "@penkra/contracts";
import { getModelSelectionBooleanOptionValue, normalizeModelSlug } from "@penkra/shared/model";
import { INLINE_TOOL_RESULT_BYTES } from "@penkra/shared/toolResults";
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
import { isCodexToolAttemptFailure } from "./codexErrorClassification.ts";
import { buildCodexProcessEnv } from "./codexProcessEnv.ts";
import {
  assertCodexWorkingDirectoryExists,
  CodexWorkingDirectoryAccessError,
} from "./codexWorkingDirectory.ts";
import { executableIdentity, resolveExecutable } from "./executableLookup.ts";
import {
  teardownChildProcessTree,
  teardownProviderProcessTree,
} from "./provider/supervisedProcessTeardown.ts";
import { ensureDurableThreadWorkspace } from "./scratchWorkspaces.ts";
import type { ProviderManagedLaunchContext } from "./provider/Services/ProviderAdapter.ts";
import {
  adoptManagedCodexRollout,
  prepareManagedCodexResume,
} from "./provider/codexManagedNativeState.ts";
import { createLogger } from "./logger";
import {
  observeProviderProcess,
  redactProviderProcessOutput,
  type ProviderProcessDiagnostics,
} from "./provider/providerProcessDiagnostics.ts";
import { transcribeVoiceWithChatGptSession } from "./voiceTranscription.ts";
import {
  CodexAppServerTransportError,
  CodexJsonlFramer,
  CodexJsonlWriter,
  CodexResponseTooLargeError,
  type CodexOversizedNotificationFrame,
  type CodexOversizedResponseFrame,
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
import { providerPermissionDecision } from "./provider/providerPermissionPolicy.ts";

const log = createLogger("codex");
const SESSION_STOPPED_REQUEST_MESSAGE = "Session stopped before request completed.";

export class CodexSessionStoppedRequestError extends Error {
  constructor() {
    super(SESSION_STOPPED_REQUEST_MESSAGE);
  }
}

export function recordCodexCapabilityPreflightFailure(input: {
  readonly stopping: boolean;
  readonly threadId: ThreadId;
  readonly error: unknown;
}): void {
  // stopSession rejects outstanding requests before tearing down the probe.
  // That rejection is the expected result of disposing a verification session.
  if (input.stopping && input.error instanceof CodexSessionStoppedRequestError) {
    return;
  }
  log.warn("Computer Use capability preflight failed", {
    threadId: input.threadId,
    error: input.error,
  });
}

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
  readonly ownerThreadId: ThreadId | null;
  method: string;
  timeout: ReturnType<typeof setTimeout>;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

interface PendingUserInputRequest {
  requestId: string;
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
interface CodexAccountProcess {
  readonly key: string;
  readonly token: symbol;
  readonly cwd: string;
  readonly connectionIds: Set<ProviderConnectionId>;
  readonly threads: Set<CodexSessionContext>;
  readonly pendingCloses: Map<string, { resolve: () => void; reject: (cause: Error) => void }>;
  authProbeThreadId?: string;
  authProbeTail?: Promise<boolean>;
  readonly probes: Map<
    string,
    { turnId: TurnId | null; resolve: (success: boolean) => void; reject: (cause: Error) => void }
  >;
  stopping: boolean;
  protocolClosed: boolean;
  terminationPromise?: Promise<unknown>;
  treeExitProven?: true;
  processClosed?: true;
  closePromise?: Promise<void>;
  protocolFailure?: Error;
  stopPromise?: Promise<void>;

  account: CodexAccountSnapshot;
  child: ChildProcessWithoutNullStreams;
  binaryPath?: string;
  stdoutFramer: CodexJsonlFramer;
  stdinWriter: CodexJsonlWriter;
  stderrTail?: string;
  diagnostics?: ProviderProcessDiagnostics;
  lastRequestMethod?: string;
  transportFailureHandled?: boolean;
  detachStdout?: () => void;
  detachProcessListeners?: () => void;
  pending: Map<PendingRequestKey, PendingRequest>;
  mcpStartupStatuses: Map<string, McpStartupStatusEntry>;
  reportedMcpStartupFailures: Set<string>;
  stderrLineFramer: CodexStderrLineFramer;
  stderrRecordFramer: CodexStderrRecordFramer;
  stderrRecordFlushTimer?: NodeJS.Timeout;
  nextRequestId: number;
}

interface CodexSessionContext {
  readonly transport: CodexAccountProcess;
  readonly gatewaySessionLease?: AgentGatewaySessionLease;
  session: ProviderSession;
  lifecycleGeneration?: string;
  pendingGatewayTurnStart?: { turnId?: TurnId; registered: boolean };
  nativeTurnStartTail?: Promise<void>;
  threadOpenRequestSent?: boolean;
  pendingUserInputs: Map<string, PendingUserInputRequest>;
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
  temporaryResourcePaths: Map<TurnId, Set<string>>;
  computerUseHealth?: ComputerUseCapabilityHealth;
  taskCompleteFallback?:
    | {
        readonly turnId: TurnId;
        readonly timeout: ReturnType<typeof setTimeout>;
      }
    | undefined;
  stopping: boolean;
  stopPromise?: Promise<void>;
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

export class CodexJsonRpcResponseError extends Error {
  readonly requestOutcome = "rejected" as const;

  constructor(
    readonly method: string,
    readonly code: number | undefined,
    message: string,
    readonly data?: unknown,
  ) {
    super(`${method} failed: ${message}`);
    this.name = "CodexJsonRpcResponseError";
  }
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

const ANSI_ESCAPE_CHAR = String.fromCharCode(27);
const ANSI_ESCAPE_REGEX = new RegExp(`${ANSI_ESCAPE_CHAR}\\[[0-9;]*m`, "g");
const CODEX_STDERR_LOG_REGEX =
  /^\d{4}-\d{2}-\d{2}T\S+\s+(TRACE|DEBUG|INFO|WARN|ERROR)\s+(\S+):\s+(.*)$/;
const BENIGN_PROCESS_OUTPUT_REGEXES = [/^(?:\^C)?Token usage:/i];
const CODEX_PENDING_SETTLE_DEADLINE_MS = 2_000;
const CODEX_STDERR_TAIL_MAX_BYTES = 64 * 1024;
const CODEX_MISSING_TOOL_OUTPUT_REGEX =
  /Custom tool call output is missing for call id:\s*([^\s,;]+)/;

interface CodexRuntimeDiagnostic {
  readonly key: string;
  readonly fingerprint: string;
  readonly state: "active" | "resolved";
}
// A timestamp or stream end closes multiline records; this debounce bounds the
// last record of a still-running process whose stderr has no explicit end marker.
const CODEX_STDERR_RECORD_IDLE_FLUSH_MS = 50;

export class CodexStderrLineFramer {
  private readonly decoder = new StringDecoder("utf8");
  private remainder = "";

  push(chunk: Buffer): string[] {
    const lines = `${this.remainder}${this.decoder.write(chunk)}`.split(/\r?\n/g);
    this.remainder = lines.pop() ?? "";
    return lines;
  }

  finish(): string[] {
    const finalLine = `${this.remainder}${this.decoder.end()}`;
    this.remainder = "";
    return finalLine ? [finalLine] : [];
  }
}

function isCodexStderrLogHeader(line: string): boolean {
  return CODEX_STDERR_LOG_REGEX.test(normalizeCodexProcessLine(line));
}

export class CodexStderrRecordFramer {
  private lines: string[] = [];

  pushLine(line: string): string[] {
    if (isCodexStderrLogHeader(line) && this.lines.length > 0) {
      const completed = this.flush();
      this.lines.push(line);
      return completed ? [completed] : [];
    }
    this.lines.push(line);
    return [];
  }

  flush(): string | undefined {
    if (this.lines.length === 0) {
      return undefined;
    }
    const record = this.lines.join("\n");
    this.lines = [];
    return record;
  }

  hasPendingRecord(): boolean {
    return this.lines.length > 0;
  }
}

function appendCodexStderrTail(transport: CodexAccountProcess, chunk: Buffer): void {
  // Redact after joining so a credential split across stream chunks cannot
  // bypass the diagnostic scrubber.
  const combined = redactProviderProcessOutput(`${transport.stderrTail ?? ""}${chunk.toString()}`);
  const bytes = Buffer.from(combined);
  transport.stderrTail =
    bytes.byteLength <= CODEX_STDERR_TAIL_MAX_BYTES
      ? combined
      : bytes.subarray(bytes.byteLength - CODEX_STDERR_TAIL_MAX_BYTES).toString();
}

function formatCodexProcessFailure(
  transport: CodexAccountProcess,
  reason: string,
  code: number | null = transport.child.exitCode,
  signal: NodeJS.Signals | null = transport.child.signalCode,
): string {
  const stderr = transport.stderrTail?.trim();
  const metadata = [
    `reason=${reason}`,
    `pid=${transport.child.pid ?? "unknown"}`,
    `code=${code ?? "null"}`,
    `signal=${signal ?? "null"}`,
    `request=${transport.lastRequestMethod ?? "none"}`,
    `binary=${transport.binaryPath ?? "unknown"}`,
    `cwd=${transport.cwd ?? "unknown"}`,
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
      setTimeout(() => {
        resolve();
      }, CODEX_PENDING_SETTLE_DEADLINE_MS).unref();
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
export function mapCodexRuntimeMode(runtimeMode: RuntimeMode): {
  readonly approvalPolicy: CodexApprovalPolicy;
  readonly sandbox: CodexSandboxMode;
} {
  switch (runtimeMode) {
    case "approval-required":
      return {
        // 0.14.4: approvals are removed, so never prompt. The mode still
        // restricts the sandbox.
        approvalPolicy: "never",
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
export function mapCodexRuntimeModeToTurnOverrides(runtimeMode: RuntimeMode): {
  readonly approvalPolicy: CodexApprovalPolicy;
  readonly sandboxPolicy: CodexTurnSandboxPolicy;
} {
  switch (runtimeMode) {
    case "approval-required":
      return {
        // 0.14.4: approvals are removed, so never prompt.
        approvalPolicy: "never",
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
  // 0.14.4: subagents are disabled; agents use `penkra threads` instead.
  const prepared = prepareWindowsSafeProcess(
    input.binaryPath,
    [
      "app-server",
      "-c",
      "features.multi_agent=false",
      "-c",
      `tool_output_token_limit=${INLINE_TOOL_RESULT_BYTES}`,
    ],
    {
      cwd: input.cwd,
      env: input.env,
    },
  );
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

export interface CodexStderrRecordClassification {
  readonly category: "tool-attempt-failure" | "provider-error" | "provider-trace" | "unstructured";
  readonly level?: "TRACE" | "DEBUG" | "INFO" | "WARN" | "ERROR";
  readonly target?: string;
  readonly record: string;
}

export function classifyCodexStderrRecord(
  rawRecord: string,
): CodexStderrRecordClassification | null {
  const record = rawRecord.replaceAll(ANSI_ESCAPE_REGEX, "").trim();
  if (!record) {
    return null;
  }
  const header = record.split(/\r?\n/u, 1)[0] ?? "";
  const match = header.match(CODEX_STDERR_LOG_REGEX);
  if (!match) {
    return { category: "unstructured", record };
  }

  const level = match[1] as CodexStderrRecordClassification["level"];
  const target = match[2];
  return {
    category:
      target === "codex_core::tools::router"
        ? "tool-attempt-failure"
        : level === "ERROR"
          ? "provider-error"
          : "provider-trace",
    ...(level ? { level } : {}),
    ...(target ? { target } : {}),
    record,
  };
}

export function buildCodexThreadMcpConfig(connection: {
  readonly url: string;
  readonly bearerToken: string;
}) {
  return {
    "mcp_servers.penkra": {
      url: connection.url,
      http_headers: { Authorization: `Bearer ${connection.bearerToken}` },
    },
  };
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

// A connectivity probe can stall without a turn-end event; bound only that probe.
const CODEX_AUTH_PROBE_DEADLINE_MS = 20_000;
const CODEX_DISCOVERY_CACHE_MAX_ENTRIES = 128;
const CODEX_TEMPORARY_RESOURCE_MAX_BYTES = 16 * 1024 * 1024;

function safeTemporaryResourceName(value: string | undefined): string {
  const normalized = (value?.trim() || "attachment").normalize("NFKC");
  const safe = Path.basename(normalized)
    .replace(/[^A-Za-z0-9._-]+/gu, "-")
    .slice(0, 160);
  return safe && safe !== "." && safe !== ".." ? safe : "attachment";
}

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
  private readonly accountProcesses = new Map<
    string,
    {
      readonly token: symbol;
      readonly process: Promise<CodexAccountProcess>;
      transport?: CodexAccountProcess;
    }
  >();
  private readonly pluginDetailCache = new Map<string, ProviderReadPluginResult>();
  private readonly pendingModelDiscoveries = new Map<string, Promise<ProviderListModelsResult>>();

  private runPromise: (effect: Effect.Effect<unknown, never>) => Promise<unknown>;
  private readonly penkraSkillsDir: string | undefined;
  private readonly agentGatewayHostTool:
    | {
        readonly acquireSessionLease: (
          threadId: ThreadId,
          lifecycleGeneration?: string,
        ) => AgentGatewaySessionLease;
        readonly beginTurn?: (
          threadId: ThreadId,
          turnId: TurnId,
          lifecycleGeneration?: string,
        ) => void;
        readonly requireNativeSurface: () => AgentGatewayNativeToolSurface;
      }
    | undefined;
  private readonly teardownProcessTree: typeof teardownProviderProcessTree;
  private readonly taskCompleteFallbackGraceMs: number;
  private readonly stateDir: string;

  private async materializeTemporaryResource(
    context: CodexSessionContext,
    turnId: TurnId,
    resource: { readonly name?: string; readonly blob: string },
  ): Promise<string> {
    const bytes = Buffer.from(resource.blob, "base64");
    if (bytes.byteLength > CODEX_TEMPORARY_RESOURCE_MAX_BYTES) {
      throw new Error("App operation resource exceeds the 16 MiB Codex handoff limit.");
    }
    const directory = Path.join(
      context.session.cwd ?? ensureDurableThreadWorkspace(context.session.threadId, this.stateDir),
      ".penkra",
      "operation-resources",
      String(turnId),
    );
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const filePath = Path.join(
      directory,
      `${randomUUID()}-${safeTemporaryResourceName(resource.name)}`,
    );
    await writeFile(filePath, bytes, { flag: "wx", mode: 0o600 });
    const tracked = context.temporaryResourcePaths ?? (context.temporaryResourcePaths = new Map());
    const paths = tracked.get(turnId) ?? new Set<string>();
    paths.add(filePath);
    tracked.set(turnId, paths);
    return filePath;
  }

  private async clearTemporaryResources(
    context: CodexSessionContext,
    turnId?: TurnId,
  ): Promise<void> {
    const tracked = context.temporaryResourcePaths;
    if (!tracked) return;
    const entries = turnId
      ? ([[turnId, tracked.get(turnId) ?? new Set<string>()]] as const)
      : Array.from(tracked.entries());
    if (turnId) tracked.delete(turnId);
    else tracked.clear();
    await Promise.allSettled(
      entries.flatMap(([, paths]) => Array.from(paths, (path) => rm(path, { force: true }))),
    );
  }
  constructor(
    services?: ServiceMap.ServiceMap<never>,
    options?: {
      readonly penkraSkillsDir?: string;
      readonly agentGatewayHostTool?: {
        readonly acquireSessionLease: (
          threadId: ThreadId,
          lifecycleGeneration?: string,
        ) => AgentGatewaySessionLease;
        readonly beginTurn?: (
          threadId: ThreadId,
          turnId: TurnId,
          lifecycleGeneration?: string,
        ) => void;
        readonly requireNativeSurface: () => AgentGatewayNativeToolSurface;
      };
      readonly teardownProcessTree?: typeof teardownProviderProcessTree;
      readonly taskCompleteFallbackGraceMs?: number;
      readonly stateDir?: string;
    },
  ) {
    super();
    this.runPromise = services ? Effect.runPromiseWith(services) : Effect.runPromise;
    this.penkraSkillsDir = options?.penkraSkillsDir;
    this.agentGatewayHostTool = options?.agentGatewayHostTool;
    this.teardownProcessTree = options?.teardownProcessTree ?? teardownProviderProcessTree;
    this.taskCompleteFallbackGraceMs = Math.max(0, options?.taskCompleteFallbackGraceMs ?? 750);
    // Direct manager construction is retained for focused tests and external
    // consumers. Production adapters always supply Penkra's durable stateDir.
    this.stateDir = options?.stateDir ?? Path.join(process.cwd(), ".penkra");
  }

  // The shared process has no thread credential. MCP headers belong to thread config.
  private async buildSessionProcessEnv(
    homePath: string | undefined,
    managedLaunch?: ProviderManagedLaunchContext,
  ) {
    const env = managedLaunch
      ? managedLaunch.childEnvironment(process.env)
      : await buildCodexProcessEnv({
          ...(homePath ? { homePath } : {}),
        });
    delete env[PENKRA_AGENT_GATEWAY_TOKEN_ENV];
    return env;
  }

  // Registers `~/.penkra/skills` as a codex skill root so portable skills are
  // first-class: skills/list returns them and turn/start `skill` items inject
  // their instructions. Verified live: skill items with paths outside known
  // roots are silently ignored by codex app-server, so this call is required.
  private async registerPenkraSkillsRoot(
    transport: CodexAccountProcess,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!this.penkraSkillsDir) {
      return;
    }
    try {
      await this.sendRequest(
        transport,
        null,
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
          context.transport,
          context.session.threadId,
          "plugin/list",
          { cwds: [cwd], marketplaceKinds: ["local"] },
          undefined,
          signal,
        );
      } catch (error) {
        if (signal?.aborted) throw error;
        if (!shouldRetryPluginListWithoutMarketplaceKinds(error)) throw error;
        await this.sendRequest(
          context.transport,
          context.session.threadId,
          "plugin/list",
          { cwds: [cwd] },
          undefined,
          signal,
        );
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      if (isPluginListUnavailable(error)) {
        log.warn("Codex plugin reconciliation is unavailable in this runtime", {
          error,
        });
        return;
      }
      throw error;
    }

    try {
      await this.sendRequest(
        context.transport,
        context.session.threadId,
        "skills/list",
        { cwds: [cwd], forceReload: true },
        undefined,
        signal,
      );
    } catch (error) {
      if (signal?.aborted) throw error;
      if (!shouldRetrySkillsListWithCwdFallback(error)) throw error;
      await this.sendRequest(
        context.transport,
        context.session.threadId,
        "skills/list",
        { cwd, forceReload: true },
        undefined,
        signal,
      );
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

      const resolvedCwd = input.cwd ?? ensureDurableThreadWorkspace(threadId, this.stateDir);

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
      gatewaySessionLease = this.agentGatewayHostTool?.acquireSessionLease(
        threadId,
        input.lifecycleGeneration,
      );
      const env = await this.buildSessionProcessEnv(codexHomePath, input.managedLaunch);
      const key =
        input.managedLaunch?.isolationKey ??
        JSON.stringify({ binaryPath: codexBinaryPath, homePath: env.CODEX_HOME });
      const transport = await this.getOrCreateAccountProcess({
        key,
        binaryPath: codexBinaryPath,
        cwd: resolvedCwd,
        env,
        connectionId: input.managedLaunch?.connectionId ?? null,
      });

      context = {
        transport,
        ...(gatewaySessionLease ? { gatewaySessionLease } : {}),
        session,
        ...(input.lifecycleGeneration !== undefined
          ? { lifecycleGeneration: input.lifecycleGeneration }
          : {}),
        pendingUserInputs: new Map(),
        collabReceiverTurns: new Map(),
        collabReceiverParents: new Map(),
        reviewTurnIds: new Set(),
        terminalTurnIds: new Set(),
        temporaryResourcePaths: new Map(),
        stopping: false,
      };

      if (resumeThreadId)
        context.session = { ...context.session, resumeCursor: { threadId: resumeThreadId } };
      const activeContext = context;
      this.sessions.set(threadId, context);
      transport.threads.add(context);

      this.emitLifecycleEvent(context, "session/connecting", "Starting codex app-server");

      await this.reconcileConfiguredPluginsBeforeThreadOpen(context, resolvedCwd, signal);
      try {
        const modelListResponse = await this.sendRequest(
          context.transport,
          context.session.threadId,
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
          context.transport,
          context.session.threadId,
          "account/read",
          {},
          undefined,
          signal,
        );
        log.info("account/read response", { accountReadResponse });
        context.transport.account = readCodexAccountSnapshot(accountReadResponse);
        log.info("subscription status", {
          type: context.transport.account.type,
          planType: context.transport.account.planType,
          sparkEnabled: context.transport.account.sparkEnabled,
        });
      } catch (error) {
        if (signal?.aborted) throw error;
        log.warn("account/read failed", { error });
      }

      const normalizedModel = resolveCodexModelForAccount(
        normalizeCodexModelSlug(input.model),
        context.transport.account,
      );
      const sessionOverrides = {
        ...(gatewaySessionLease
          ? { config: buildCodexThreadMcpConfig(gatewaySessionLease.connection) }
          : {}),
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
              this.sendRequest(
                activeContext.transport,
                activeContext.session.threadId,
                "thread/resume",
                params,
                undefined,
                signal,
              ),
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
          context.transport,
          context.session.threadId,
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
          context.transport,
          context.session.threadId,
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
        recordCodexCapabilityPreflightFailure({
          stopping: context?.stopping === true,
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
        transportFailed: context?.transport.transportFailureHandled === true,
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

  private async withNativeTurnStart<T>(
    context: CodexSessionContext,
    start: () => Promise<T>,
  ): Promise<T> {
    const previous = context.nativeTurnStartTail;
    let release!: () => void;
    const tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    context.nativeTurnStartTail = tail;
    await previous;
    try {
      return await start();
    } finally {
      release();
      if (context.nativeTurnStartTail === tail) delete context.nativeTurnStartTail;
    }
  }

  async sendTurn(input: CodexAppServerSendTurnInput): Promise<ProviderTurnStartResult> {
    const context = this.requireSession(input.threadId);
    return this.withNativeTurnStart(context, () => this.sendTurnInSession(context, input));
  }

  private async sendTurnInSession(
    context: CodexSessionContext,
    input: CodexAppServerSendTurnInput,
  ): Promise<ProviderTurnStartResult> {
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
      ...mapCodexRuntimeModeToTurnOverrides(context.session.runtimeMode),
    };
    const normalizedModel = resolveCodexModelForAccount(
      normalizeCodexModelSlug(input.model ?? context.session.model),
      context.transport.account,
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

    const pendingStart: { turnId?: TurnId; registered: boolean } = { registered: false };
    context.pendingGatewayTurnStart = pendingStart;
    try {
      const response = await this.sendRequest(
        context.transport,
        context.session.threadId,
        "turn/start",
        turnStartParams,
      );
      const turn = this.readObject(this.readObject(response), "turn");
      const turnIdRaw = this.readString(turn, "id");
      if (!turnIdRaw) {
        throw new Error("turn/start response did not include a turn id.");
      }
      const turnId = TurnId.makeUnsafe(turnIdRaw);
      if (pendingStart.turnId !== undefined && pendingStart.turnId !== turnId) {
        throw new Error("turn/start response does not match the registered native turn.");
      }
      pendingStart.turnId = turnId;
      const turnStatus = this.readString(turn, "status");
      if (turnStatus === "failed" || turnStatus === "completed" || turnStatus === "interrupted") {
        if (!context.terminalTurnIds.has(turnId)) {
          this.handleServerNotification(context, {
            method: "turn/completed",
            params: { threadId: providerThreadId, turn },
          });
        }
      } else if (!context.terminalTurnIds.has(turnId)) {
        if (!pendingStart.registered) {
          this.agentGatewayHostTool?.beginTurn?.(
            context.session.threadId,
            turnId,
            context.lifecycleGeneration,
          );
          pendingStart.registered = true;
        }
        this.updateSession(context, {
          status: "running",
          activeTurnId: turnId,
          ...(context.session.resumeCursor !== undefined
            ? { resumeCursor: context.session.resumeCursor }
            : {}),
        });
      }

      return {
        threadId: context.session.threadId,
        turnId,
        ...(context.session.resumeCursor !== undefined
          ? { resumeCursor: context.session.resumeCursor }
          : {}),
      };
    } finally {
      if (context.pendingGatewayTurnStart === pendingStart) delete context.pendingGatewayTurnStart;
    }
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
      response = await this.sendRequest(context.transport, context.session.threadId, "turn/steer", {
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
        const threadResponse = await this.sendRequest(
          context.transport,
          context.session.threadId,
          "thread/read",
          {
            threadId: providerThreadId,
            includeTurns: false,
          },
        );
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
    return this.withNativeTurnStart(context, () => this.startReviewInSession(context, input));
  }

  private async startReviewInSession(
    context: CodexSessionContext,
    input: ProviderStartReviewInput,
  ): Promise<ProviderTurnStartResult> {
    const providerThreadId = readResumeThreadId({
      threadId: context.session.threadId,
      runtimeMode: context.session.runtimeMode,
      resumeCursor: context.session.resumeCursor,
    });
    if (!providerThreadId) {
      throw new Error("Session is missing a provider resume thread id.");
    }

    const response = await this.sendRequest(
      context.transport,
      context.session.threadId,
      "review/start",
      {
        threadId: providerThreadId,
        delivery: "inline",
        target: this.toCodexReviewTarget(input.target),
      },
    );

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

  async interruptTurn(threadId: ThreadId, turnId?: TurnId): Promise<void> {
    const context = this.requireSession(threadId);
    const effectiveTurnId = turnId ?? context.session.activeTurnId;

    // Stop must also unpark codex from any question/approval it is blocked on;
    // turn/interrupt alone does not settle server-initiated requests.
    await this.settlePendingHumanRequests(context, "turn interrupted");

    const providerThreadId = readResumeThreadId({
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
      await this.sendRequest(context.transport, context.session.threadId, "turn/interrupt", {
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
        await this.sendRequest(context.transport, context.session.threadId, "turn/interrupt", {
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

    const response = await this.sendRequest(
      context.transport,
      context.session.threadId,
      "thread/read",
      {
        threadId: providerThreadId,
        includeTurns: true,
      },
    );
    return this.parseThreadSnapshot("thread/read", response);
  }

  async revertThread(threadId: ThreadId, beforeTurnId: TurnId): Promise<CodexThreadSnapshot> {
    const context = this.requireSession(threadId);
    const providerThreadId = readResumeThreadId({
      threadId: context.session.threadId,
      runtimeMode: context.session.runtimeMode,
      resumeCursor: context.session.resumeCursor,
    });
    if (!providerThreadId) {
      throw new Error("Session is missing a provider resume thread id.");
    }
    const response = await this.sendRequest(
      context.transport,
      context.session.threadId,
      "thread/revert",
      {
        threadId: providerThreadId,
        beforeTurnId,
      },
    );
    this.updateSession(context, {
      status: "ready",
      activeTurnId: undefined,
    });
    return this.parseThreadSnapshot("thread/revert", response);
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
      await this.sendRequest(context.transport, context.session.threadId, "thread/compact/start", {
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

  async respondToUserInput(
    threadId: ThreadId,
    requestId: string,
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
    await this.writeMessage(context.transport, {
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
    return context.pendingUserInputs.size > 0;
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
    const pendingUserInputs = Array.from(context.pendingUserInputs.values());
    if (pendingUserInputs.length === 0) {
      return;
    }

    log.info("settling pending codex human requests", {
      threadId: context.session.threadId,
      reason,
      pendingUserInputs: pendingUserInputs.length,
    });

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

  private rejectPendingRequests(
    transport: CodexAccountProcess,
    error: Error,
    ownerThreadId: ThreadId | null,
  ): void {
    for (const [id, pending] of transport.pending) {
      if (ownerThreadId !== null && pending.ownerThreadId !== ownerThreadId) continue;
      clearTimeout(pending.timeout);
      transport.pending.delete(id);
      pending.reject(error);
    }
  }

  private async finishThreadClose(context: CodexSessionContext): Promise<void> {
    await this.clearTemporaryResources(context);
    context.pendingUserInputs.clear();
    context.transport.threads.delete(context);
    if (this.sessions.get(context.session.threadId) === context)
      this.sessions.delete(context.session.threadId);
    this.updateSession(context, { status: "closed", activeTurnId: undefined });
    this.emitLifecycleEvent(context, "session/closed", "Session stopped");
  }

  async stopSession(threadId: ThreadId): Promise<void> {
    const context = this.sessions.get(threadId);
    if (!context) return;
    if (context.stopPromise) return context.stopPromise;
    context.stopping = true;
    this.clearTaskCompleteFallback(context);
    this.rejectPendingRequests(context.transport, new CodexSessionStoppedRequestError(), threadId);
    const nativeId = readResumeCursorThreadId(context.session.resumeCursor);
    const activeTurnId = context.session.activeTurnId;
    const closed =
      nativeId === undefined
        ? Promise.resolve()
        : new Promise<void>((resolve, reject) => {
            context.transport.pendingCloses.set(nativeId, { resolve, reject });
          });
    context.stopPromise = (async () => {
      try {
        await Promise.all([
          closed,
          (async () => {
            await withCodexPendingSettleDeadline(
              this.settlePendingHumanRequests(context, "session stopped"),
            );
            context.gatewaySessionLease?.release();
            if (nativeId !== undefined && !context.transport.stopping) {
              if (activeTurnId !== undefined)
                await this.sendRequest(context.transport, threadId, "turn/interrupt", {
                  threadId: nativeId,
                  turnId: activeTurnId,
                });
              await this.sendRequest(context.transport, threadId, "thread/unsubscribe", {
                threadId: nativeId,
              });
            }
          })(),
        ]);
        await this.finishThreadClose(context);
      } finally {
        if (nativeId !== undefined) context.transport.pendingCloses.delete(nativeId);
      }
    })();
    return context.stopPromise;
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
    const results = await Promise.allSettled(
      Array.from(this.accountProcesses.values(), async (entry) =>
        this.closeAccountProcess(await entry.process),
      ),
    );
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length > 0)
      throw new AggregateError(failures, "One or more Codex account process trees did not exit.");
  }

  async listSkills(input: CodexSkillListInput): Promise<ProviderListSkillsResult> {
    const cwd = input.cwd.trim();
    const transport = await this.resolveProcessForDiscovery(input.threadId, cwd);
    let response: Record<string, unknown>;
    try {
      response = await this.sendRequest<Record<string, unknown>>(transport, null, "skills/list", {
        cwds: [cwd],
        ...(input.forceReload ? { forceReload: true } : {}),
      });
    } catch (error) {
      if (!shouldRetrySkillsListWithCwdFallback(error)) {
        throw error;
      }
      response = await this.sendRequest<Record<string, unknown>>(transport, null, "skills/list", {
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
    return result;
  }

  /** Discovery uses the selected account process, without creating or requiring a thread. */
  async loadCatalog(input: {
    readonly cwd: string;
    readonly managedLaunch: ProviderManagedLaunchContext;
    readonly kinds: ReadonlyArray<ProviderCatalogKind>;
  }): Promise<ProviderCatalogData> {
    const supported = input.kinds.filter(
      (kind) => kind === "models" || kind === "skills" || kind === "plugins",
    );
    if (supported.length === 0) return {};
    const transport = await this.getOrCreateManagedProcess(input.cwd, input.managedLaunch);
    const data: { -readonly [K in keyof ProviderCatalogData]: ProviderCatalogData[K] } = {};
    await Promise.all(
      [...new Set(supported)].map(async (kind) => {
        if (kind === "models") {
          const models: ProviderListModelsResult["models"][number][] = [];
          const seenCursors = new Set<string>();
          let cursor: string | null = null;
          do {
            const response: Record<string, unknown> = await this.sendRequest(
              transport,
              null,
              "model/list",
              { cursor, includeHidden: false },
            );
            models.push(...parseCodexModelListResponse(response));
            const nextCursor = asString(response.nextCursor) ?? null;
            if (nextCursor !== null && seenCursors.has(nextCursor)) {
              throw new Error("Codex model/list repeated a pagination cursor.");
            }
            if (nextCursor !== null) seenCursors.add(nextCursor);
            cursor = nextCursor;
          } while (cursor !== null);
          data.models = models;
        } else if (kind === "skills") {
          const response = await this.sendRequest<Record<string, unknown>>(
            transport,
            null,
            "skills/list",
            { cwds: [input.cwd] },
          );
          data.skills = parseCodexSkillsListResponse(response, input.cwd);
        } else {
          const response = await this.sendRequest<Record<string, unknown>>(
            transport,
            null,
            "plugin/installed",
            { cwds: [input.cwd] },
          );
          const parsed = parseCodexPluginListResponse(response);
          if (parsed.marketplaceLoadErrors.length > 0) {
            throw new Error(parsed.marketplaceLoadErrors.map((error) => error.message).join("\n"));
          }
          data.plugins = parsed.marketplaces.map((marketplace) => ({
            ...marketplace,
            plugins: marketplace.plugins.filter((plugin) => plugin.installed),
          }));
        }
      }),
    );
    return data;
  }

  async listPlugins(input: CodexPluginListInput): Promise<ProviderListPluginsResult> {
    const cwd = input.cwd?.trim() || null;
    const transport = await this.resolveProcessForDiscovery(input.threadId, cwd ?? undefined);
    const response = await this.sendRequest<Record<string, unknown>>(
      transport,
      null,
      "plugin/list",
      {
        ...(cwd ? { cwds: [cwd] } : {}),
        ...(input.forceRemoteSync ? { forceRefetch: true } : {}),
      },
    );
    const result: ProviderListPluginsResult = {
      ...parseCodexPluginListResponse(response),
      source: "codex-app-server",
      cached: false,
    };
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
        context.transport,
        context.session.threadId,
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
        const runtimeStatus = asString(server?.runtimeStatus)?.trim();
        const startupStatus = context.transport.mcpStartupStatuses.get(name);
        const toolsError = asString(server?.toolsError)?.trim();
        const failureDetail =
          toolsError ??
          (runtimeStatus === "failed" || startupStatus?.state === "failed"
            ? startupStatus?.error?.trim() || "Startup failed."
            : undefined);
        if (runtimeStatus === "connected" || startupStatus?.state === "ready") {
          if (context.transport.reportedMcpStartupFailures.delete(name)) {
            this.emitErrorEvent(
              context,
              "mcpServer/startupRecovered",
              `MCP server “${name}” recovered.`,
              { key: `codex:mcp-startup:${name}`, fingerprint: name, state: "resolved" },
            );
          }
        }
        if (failureDetail) {
          this.reportMcpStartupFailure(context, name, failureDetail);
        }
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
      startupStatuses: [...context.transport.mcpStartupStatuses.values()],
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

    const transport = await this.resolveProcessForDiscovery(input.threadId);
    const response = await this.sendRequest<Record<string, unknown>>(
      transport,
      null,
      "plugin/read",
      {
        marketplacePath,
        pluginName,
      },
    );
    const result: ProviderReadPluginResult = {
      plugin: parseCodexPluginReadResponse(response),
      source: "codex-app-server",
      cached: false,
    };
    setRecentCacheEntry(this.pluginDetailCache, cacheKey, result);
    return result;
  }

  /** Send an isolated read-only probe using the same account transport as its threads. */
  async probeResponses(input: {
    readonly cwd: string;
    readonly managedLaunch: ProviderManagedLaunchContext;
    readonly model: string;
    readonly effort?: string;
  }): Promise<boolean> {
    const transport = await this.getOrCreateManagedProcess(input.cwd, input.managedLaunch);
    const run = () => this.runAuthProbe(transport, input);
    const previous = transport.authProbeTail;
    const result = previous === undefined ? run() : previous.then(run, run);
    transport.authProbeTail = result;
    try {
      return await result;
    } finally {
      if (transport.authProbeTail === result) delete transport.authProbeTail;
    }
  }

  private async runAuthProbe(
    transport: CodexAccountProcess,
    input: {
      readonly cwd: string;
      readonly model: string;
      readonly effort?: string;
    },
  ): Promise<boolean> {
    if (!transport.authProbeThreadId) {
      const opened = await this.sendRequest<Record<string, unknown>>(
        transport,
        null,
        "thread/start",
        {
          model: input.model,
          cwd: input.cwd,
          approvalPolicy: "untrusted",
          sandbox: "read-only",
          dynamicTools: [],
          environments: [],
          ephemeral: true,
          baseInstructions: "Connectivity check. Reply OK. Do not use tools.",
          experimentalRawEvents: false,
        },
      );
      const threadId = this.readString(this.readObject(opened, "thread"), "id");
      if (!threadId) throw new Error("Auth probe could not open a Codex thread.");
      transport.authProbeThreadId = threadId;
    }
    const nativeId = transport.authProbeThreadId;
    let resolveCompletion!: (success: boolean) => void;
    let rejectCompletion!: (cause: Error) => void;
    const completion = new Promise<boolean>((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });
    const probe = {
      turnId: null as TurnId | null,
      resolve: resolveCompletion,
      reject: rejectCompletion,
    };
    transport.probes.set(nativeId, probe);
    let deadlineFired = false;
    const deadline = setTimeout(() => {
      deadlineFired = true;
      resolveCompletion(false);
    }, CODEX_AUTH_PROBE_DEADLINE_MS);
    try {
      const [success] = await Promise.all([
        completion,
        (async () => {
          const response = await this.sendRequest<Record<string, unknown>>(
            transport,
            null,
            "turn/start",
            {
              threadId: nativeId,
              model: input.model,
              ...(input.effort ? { effort: input.effort } : {}),
              input: [{ type: "text", text: "Reply OK.", text_elements: [] }],
              summary: "none",
              approvalPolicy: "untrusted",
              sandboxPolicy: { type: "readOnly" },
            },
          );
          const turn = this.readObject(response, "turn");
          const turnId = toTurnId(this.readString(turn, "id"));
          if (!turnId) throw new Error("Auth probe did not receive a Codex turn id.");
          probe.turnId = turnId;
          if (this.readString(turn, "status") === "completed") resolveCompletion(true);
          if (this.readString(turn, "status") === "failed") resolveCompletion(false);
        })(),
      ]);
      const turnId = probe.turnId;
      if (deadlineFired)
        await this.sendRequest(transport, null, "turn/interrupt", { threadId: nativeId, turnId });
      return success;
    } finally {
      clearTimeout(deadline);
      transport.probes.delete(nativeId);
    }
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
    const existing = this.pendingModelDiscoveries.get(cacheKey);
    if (existing) return existing;
    const pending = (async (): Promise<ProviderListModelsResult> => {
      const transport = managedDiscovery
        ? await this.getOrCreateManagedProcess(
            managedDiscovery.cwd?.trim() || process.cwd(),
            managedDiscovery.managedLaunch,
          )
        : await this.resolveProcessForDiscovery(threadId);
      const response = await this.sendRequest<Record<string, unknown>>(
        transport,
        null,
        "model/list",
        { cursor: null, limit: 50, includeHidden: false },
      );
      return {
        models: parseCodexModelListResponse(response),
        source: "codex-app-server",
        cached: false,
      };
    })();
    this.pendingModelDiscoveries.set(cacheKey, pending);
    try {
      return await pending;
    } finally {
      if (this.pendingModelDiscoveries.get(cacheKey) === pending)
        this.pendingModelDiscoveries.delete(cacheKey);
    }
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
    const stdin = context.transport.child.stdin;
    return (
      !context.stopping &&
      !context.transport.stopping &&
      !context.transport.protocolClosed &&
      context.session.status !== "closed" &&
      context.transport.child.exitCode === null &&
      context.transport.child.signalCode === null &&
      !context.transport.child.killed &&
      stdin.writable &&
      !stdin.writableEnded &&
      !stdin.destroyed
    );
  }

  private async resolveProcessForDiscovery(
    threadId?: string,
    cwd?: string,
  ): Promise<CodexAccountProcess> {
    const normalizedThreadId = threadId?.trim();
    const normalizedCwd = cwd?.trim() || undefined;
    if (!normalizedThreadId) {
      throw new Error("Managed Codex discovery requires an exact active thread session.");
    }
    const session = this.requireSession(ThreadId.makeUnsafe(normalizedThreadId));
    if (normalizedCwd && session.session.cwd !== normalizedCwd) {
      throw new Error("The active Codex session does not match the requested working folder.");
    }
    return session.transport;
  }

  private async resolveVoiceTranscriptionAuth(input: {
    readonly cwd?: string;
    readonly threadId?: string;
    readonly refreshToken: boolean;
    readonly managedLaunch?: ProviderManagedLaunchContext;
  }): Promise<CodexVoiceTranscriptionAuthContext> {
    const transport = input.managedLaunch
      ? await this.getOrCreateManagedProcess(
          input.cwd?.trim() || process.cwd(),
          input.managedLaunch,
        )
      : input.threadId?.trim()
        ? await this.resolveProcessForDiscovery(input.threadId, input.cwd)
        : null;
    if (transport === null) {
      throw new Error("Voice transcription requires an exact active Connection session.");
    }
    const readAuthStatus = async (refreshToken: boolean) => {
      const response = await this.sendRequest<Record<string, unknown>>(
        transport,
        null,
        "getAuthStatus",
        {
          includeToken: true,
          refreshToken,
        },
      );
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

  private async getOrCreateManagedProcess(
    cwd: string,
    launch: ProviderManagedLaunchContext,
  ): Promise<CodexAccountProcess> {
    return this.getOrCreateAccountProcess({
      key: launch.isolationKey,
      cwd,
      binaryPath: launch.binaryPath,
      env: await this.buildSessionProcessEnv(undefined, launch),
      connectionId: launch.connectionId ?? null,
    });
  }

  private async getOrCreateAccountProcess(input: {
    readonly key: string;
    readonly cwd: string;
    readonly binaryPath: string;
    readonly env: NodeJS.ProcessEnv;
    readonly connectionId: ProviderConnectionId | null;
  }): Promise<CodexAccountProcess> {
    const existing = this.accountProcesses.get(input.key);
    if (existing) {
      const transport =
        existing.transport?.stopping || existing.transport?.protocolClosed
          ? existing.transport
          : await existing.process;
      if (transport.protocolClosed && !transport.stopping) {
        await this.terminateAccountProcess(transport);
        // attachProcessListeners installs this native-close promise before any
        // request is admitted. Acquisition cannot take requested-stop ownership.
        await transport.closePromise;
        return this.getOrCreateAccountProcess(input);
      }
      if (!transport.stopping && !transport.protocolClosed) {
        if (input.connectionId !== null) transport.connectionIds.add(input.connectionId);
        return transport;
      }
      await this.closeAccountProcess(transport);
      return this.getOrCreateAccountProcess(input);
    }
    const token = Symbol(input.key);
    const entry: {
      readonly token: symbol;
      readonly process: Promise<CodexAccountProcess>;
      transport?: CodexAccountProcess;
    } = {
      token,
      // Register ownership before startup can publish its spawned transport.
      process: Promise.resolve().then(() =>
        this.startAccountProcess(input, token, (transport) => {
          entry.transport = transport;
        }),
      ),
    };
    this.accountProcesses.set(input.key, entry);
    try {
      return await entry.process;
    } catch (cause) {
      if (
        this.accountProcesses.get(input.key) === entry &&
        (!entry.transport?.child.pid || entry.transport.treeExitProven)
      )
        this.accountProcesses.delete(input.key);
      throw cause;
    }
  }

  private async startAccountProcess(
    input: {
      readonly key: string;
      readonly cwd: string;
      readonly binaryPath: string;
      readonly env: NodeJS.ProcessEnv;
      readonly connectionId: ProviderConnectionId | null;
    },
    token: symbol,
    publishTransport: (transport: CodexAccountProcess) => void,
  ): Promise<CodexAccountProcess> {
    const child = spawnCodexAppServer(input);
    const transport: CodexAccountProcess = {
      key: input.key,
      token,
      cwd: input.cwd,
      connectionIds: new Set(input.connectionId === null ? [] : [input.connectionId]),
      threads: new Set(),
      probes: new Map(),
      pendingCloses: new Map(),
      stopping: false,
      protocolClosed: false,
      account: { type: "unknown", planType: null, sparkEnabled: true },
      child,
      binaryPath: input.binaryPath,
      stdoutFramer: new CodexJsonlFramer(),
      stdinWriter: new CodexJsonlWriter(child.stdin),
      pending: new Map(),
      nextRequestId: 1,
      mcpStartupStatuses: new Map(),
      reportedMcpStartupFailures: new Set(),
      stderrLineFramer: new CodexStderrLineFramer(),
      stderrRecordFramer: new CodexStderrRecordFramer(),
    };
    publishTransport(transport);
    transport.diagnostics = observeProviderProcess(child, {
      provider: "codex",
      context: () => ({
        binaryPath: input.binaryPath,
        requestedStop: transport.stopping,
        protocolClosed: transport.protocolClosed,
        protocolFailure: transport.protocolFailure?.message ?? null,
        connectionIds: [...transport.connectionIds],
        threadIds: [...transport.threads].map((context) => context.session.threadId),
        lastRequestMethod: transport.lastRequestMethod ?? null,
      }),
    });
    this.attachProcessListeners(transport);
    try {
      await this.sendRequest(transport, null, "initialize", buildCodexInitializeParams());
      await this.writeMessage(transport, { method: "initialized" });
      await this.registerPenkraSkillsRoot(transport);
      const response = await this.sendRequest(transport, null, "account/read", {});
      transport.account = readCodexAccountSnapshot(response);
      return transport;
    } catch (cause) {
      try {
        await this.closeAccountProcess(transport);
      } catch (stopError) {
        // Keep the transport as a respawn barrier, while preserving startup
        // failure as the caller's cause. Acquisition retries the tree proof.
        log.error("Codex startup cleanup could not prove process-tree exit", { stopError });
      }
      throw cause;
    }
  }

  private terminateAccountProcess(transport: CodexAccountProcess): Promise<unknown> {
    if (transport.terminationPromise) return transport.terminationPromise;
    const termination = teardownChildProcessTree(transport.child, this.teardownProcessTree).then(
      (result) => {
        transport.treeExitProven = true;
        if (
          transport.processClosed &&
          this.accountProcesses.get(transport.key)?.token === transport.token
        )
          this.accountProcesses.delete(transport.key);
        return result;
      },
      (cause) => {
        if (transport.terminationPromise === termination) delete transport.terminationPromise;
        throw cause instanceof Error
          ? cause
          : new Error("Codex process-tree exit proof failed", { cause });
      },
    );
    transport.terminationPromise = termination;
    return termination;
  }

  private async closeAccountProcess(transport: CodexAccountProcess): Promise<void> {
    if (transport.stopPromise) return transport.stopPromise;
    transport.stopping = true;
    for (const probe of transport.probes.values())
      probe.reject(new Error("Codex account process stopped"));
    transport.probes.clear();
    transport.stopPromise = (async () => {
      for (const context of transport.threads) {
        context.stopping = true;
        this.clearTaskCompleteFallback(context);
        context.gatewaySessionLease?.release();
        await withCodexPendingSettleDeadline(
          this.settlePendingHumanRequests(context, "account process stopped"),
        );
      }
      this.rejectPendingRequests(transport, new Error("Codex account process stopped"), null);
      transport.detachStdout?.();
      if (transport.stderrRecordFlushTimer) clearTimeout(transport.stderrRecordFlushTimer);
      transport.stdinWriter.close(new Error("Codex account process stopped"));
      try {
        await this.terminateAccountProcess(transport);
        await Promise.all(
          Array.from(transport.threads, (context) => this.finishThreadClose(context)),
        );
        if (this.accountProcesses.get(transport.key)?.token === transport.token)
          this.accountProcesses.delete(transport.key);
      } catch (cause) {
        delete transport.stopPromise;
        throw new Error(`Failed to prove Codex account process-tree exit for '${transport.key}'`, {
          cause,
        });
      }
    })();
    return transport.stopPromise;
  }

  async stopAccount(connectionId: ProviderConnectionId): Promise<void> {
    for (const entry of this.accountProcesses.values()) {
      const transport = await entry.process;
      if (transport.connectionIds.has(connectionId)) await this.closeAccountProcess(transport);
    }
  }

  private attachProcessListeners(transport: CodexAccountProcess): void {
    let resolveClose!: () => void;
    transport.closePromise = new Promise<void>((resolve) => {
      resolveClose = resolve;
    });
    const onStdoutData = (chunk: Buffer) => {
      if (transport.stopping) return;
      try {
        for (const line of transport.stdoutFramer.push(chunk)) {
          if (typeof line === "string") {
            if (!isIgnorableCodexProcessLine(line)) this.handleStdoutLine(transport, line);
          } else if (line.kind === "oversized-response") {
            this.handleOversizedResponse(transport, line);
          } else {
            const context = this.findContext(transport, line.threadId);
            if (context) this.handleOversizedNotification(context, line);
          }
        }
      } catch (cause) {
        this.handleTransportFailure(transport, cause);
      }
    };
    const onStdoutEnd = () => {
      if (transport.stopping) return;
      try {
        transport.stdoutFramer.finish();
        this.handleTransportFailure(
          transport,
          new CodexAppServerTransportError({
            reason: "read-closed",
            maxBytes: transport.stdoutFramer.maxFrameBytes,
            observedBytes: 0,
          }),
        );
      } catch (cause) {
        this.handleTransportFailure(transport, cause);
      }
    };
    transport.child.stdout.on("data", onStdoutData);
    transport.child.stdout.once("end", onStdoutEnd);
    transport.detachStdout = () => {
      transport.child.stdout.off("data", onStdoutData);
      transport.child.stdout.off("end", onStdoutEnd);
      transport.stdoutFramer.reset();
      delete transport.detachStdout;
    };

    const onStderrData = (chunk: Buffer) => {
      appendCodexStderrTail(transport, chunk);
      if (transport.stopping) {
        return;
      }
      for (const rawLine of transport.stderrLineFramer.push(chunk)) {
        this.ingestCodexStderrLine(transport, rawLine);
      }
      this.scheduleCodexStderrRecordFlush(transport);
    };
    const onStderrEnd = () => {
      for (const rawLine of transport.stderrLineFramer.finish()) {
        this.ingestCodexStderrLine(transport, rawLine);
      }
      this.flushCodexStderrRecord(transport);
    };
    const onProcessError = (error: Error) => {
      this.flushCodexStderrRecord(transport);
      this.handleTransportFailure(transport, error);
    };
    const onProcessExit = (code: number | null, signal: NodeJS.Signals | null) => {
      if (transport.stopping) {
        const error = new Error(formatCodexProcessFailure(transport, "process-exit", code, signal));
        for (const waiter of transport.pendingCloses.values()) waiter.reject(error);
        transport.pendingCloses.clear();
        return;
      }
      // Unexpected protocol closure owns reporting after stdio drains. Ordinary
      // exit keeps the existing immediate lifecycle notification.
      if (!transport.protocolClosed)
        this.reportAccountProcessCompletion(transport, { kind: "exit", code, signal });
    };
    const onProcessClose = (code: number | null, signal: NodeJS.Signals | null) => {
      for (const rawLine of transport.stderrLineFramer.finish()) {
        this.ingestCodexStderrLine(transport, rawLine);
      }
      this.flushCodexStderrRecord(transport);
      transport.processClosed = true;
      this.reportAccountProcessCompletion(transport, { kind: "exit", code, signal });
      // Requested stop owns finishThreadClose and its cut-off lifecycle event
      // after tree proof. Native close must not retire those contexts first.
      if (!transport.stopping) this.releaseAccountProcess(transport);
      transport.stdinWriter.close(new Error("Codex account process closed."));
      transport.detachProcessListeners?.();
      resolveClose();
    };
    transport.child.stderr.on("data", onStderrData);
    transport.child.stderr.once("end", onStderrEnd);
    transport.child.on("error", onProcessError);
    transport.child.on("exit", onProcessExit);
    transport.child.on("close", onProcessClose);
    transport.detachProcessListeners = () => {
      transport.detachStdout?.();
      transport.child.stderr.off("data", onStderrData);
      transport.child.stderr.off("end", onStderrEnd);
      transport.child.off("error", onProcessError);
      transport.child.off("exit", onProcessExit);
      transport.child.off("close", onProcessClose);
      delete transport.detachProcessListeners;
    };
  }

  private reportAccountProcessCompletion(
    transport: CodexAccountProcess,
    outcome:
      | { kind: "exit"; code: number | null; signal: NodeJS.Signals | null }
      | { kind: "termination-failed"; error: Error },
  ): void {
    if (transport.stopping || transport.transportFailureHandled) return;
    transport.transportFailureHandled = true;
    this.flushCodexStderrRecord(transport);
    const message =
      outcome.kind === "exit"
        ? formatCodexProcessFailure(
            transport,
            transport.protocolFailure?.message ?? "process-exit",
            outcome.code,
            outcome.signal,
          )
        : formatCodexProcessFailure(transport, outcome.error.message);
    const error =
      outcome.kind === "exit"
        ? new Error(message, { cause: transport.protocolFailure })
        : outcome.error;
    if (outcome.kind === "termination-failed") error.message = message;
    for (const waiter of transport.pendingCloses.values()) waiter.reject(error);
    transport.pendingCloses.clear();
    this.rejectPendingRequests(transport, error, null);
    for (const probe of transport.probes.values()) probe.reject(error);
    transport.probes.clear();
    if (outcome.kind === "termination-failed") {
      for (const context of transport.threads) {
        this.updateSession(context, { status: "error", lastError: message });
        this.emitErrorEvent(context, "protocol/transportError", message);
      }
      return;
    }
    transport.stdinWriter.close(error);
    for (const context of transport.threads) {
      this.updateSession(context, {
        status: "closed",
        activeTurnId: undefined,
        lastError:
          outcome.code === 0 && !transport.protocolClosed ? context.session.lastError : message,
      });
      this.emitLifecycleEvent(context, "session/exited", message);
    }
    this.releaseAccountProcess(transport);
  }

  private releaseAccountProcess(transport: CodexAccountProcess): void {
    transport.detachStdout?.();
    for (const context of transport.threads) {
      this.clearTaskCompleteFallback(context);
      context.gatewaySessionLease?.release();
      context.pendingUserInputs.clear();
      void this.clearTemporaryResources(context);
      this.sessions.delete(context.session.threadId);
    }
    transport.threads.clear();
    // A direct child's close is not proof that its descendants exited. Keep
    // the existing replacement barrier until the shared tree teardown succeeds.
    if (
      (!transport.protocolClosed || transport.treeExitProven) &&
      this.accountProcesses.get(transport.key)?.token === transport.token
    )
      this.accountProcesses.delete(transport.key);
  }

  private handleTransportFailure(transport: CodexAccountProcess, cause: unknown): void {
    if (transport.stopping || transport.protocolClosed || transport.transportFailureHandled) return;
    transport.protocolClosed = true;
    transport.protocolFailure =
      cause instanceof Error ? cause : new Error("Codex app-server transport failed", { cause });
    const frameError = cause instanceof CodexAppServerTransportError ? cause : undefined;
    const request =
      frameError?.requestId === undefined
        ? undefined
        : transport.pending.get(String(frameError.requestId));
    log.error("Codex transport failed", {
      pid: transport.child.pid,
      reason: frameError?.reason,
      observedBytes: frameError?.observedBytes,
      maxBytes: frameError?.maxBytes,
      protocolMethod: frameError?.protocolMethod,
      protocolTypes: frameError?.protocolTypes,
      requestId: frameError?.requestId,
      requestMethod: request?.method,
      threadId: request?.ownerThreadId,
    });
    // Existing requests receive the single final stderr/exit error, rather than
    // a timer or a write failure racing the native close notification.
    for (const pending of transport.pending.values()) clearTimeout(pending.timeout);
    transport.detachStdout?.();
    void this.terminateAccountProcess(transport).catch((cause) => {
      const error =
        cause instanceof Error
          ? cause
          : new Error("Codex process-tree exit proof failed", { cause });
      this.reportAccountProcessCompletion(transport, { kind: "termination-failed", error });
    });
  }

  private ingestCodexStderrLine(transport: CodexAccountProcess, rawLine: string): void {
    for (const record of transport.stderrRecordFramer.pushLine(rawLine)) {
      this.handleCodexStderrRecord(transport, record);
    }
  }

  private scheduleCodexStderrRecordFlush(transport: CodexAccountProcess): void {
    if (!transport.stderrRecordFramer.hasPendingRecord()) {
      return;
    }
    if (transport.stderrRecordFlushTimer) {
      clearTimeout(transport.stderrRecordFlushTimer);
    }
    transport.stderrRecordFlushTimer = setTimeout(() => {
      delete transport.stderrRecordFlushTimer;
      this.flushCodexStderrRecord(transport);
    }, CODEX_STDERR_RECORD_IDLE_FLUSH_MS);
    transport.stderrRecordFlushTimer.unref();
  }

  private flushCodexStderrRecord(transport: CodexAccountProcess): void {
    if (transport.stderrRecordFlushTimer) {
      clearTimeout(transport.stderrRecordFlushTimer);
      delete transport.stderrRecordFlushTimer;
    }
    const record = transport.stderrRecordFramer.flush();
    if (record !== undefined && !transport.stopping) {
      this.handleCodexStderrRecord(transport, record);
    }
  }

  private handleCodexStderrRecord(transport: CodexAccountProcess, rawRecord: string): void {
    const classified = classifyCodexStderrRecord(rawRecord);
    if (!classified) {
      return;
    }
    const missingToolOutputCallId = classified.record.match(CODEX_MISSING_TOOL_OUTPUT_REGEX)?.[1];
    if (missingToolOutputCallId) {
      for (const context of transport.threads)
        this.emitErrorEvent(
          context,
          "process/stderr",
          `Custom tool call output is missing for call id: ${missingToolOutputCallId}`,
          {
            key: `codex:missing-tool-output:${missingToolOutputCallId}`,
            fingerprint: missingToolOutputCallId,
            state: "active",
          },
        );
      return;
    }
    log.debug("ignored Codex stderr record", {
      processKey: transport.key,
      category: classified.category,
      level: classified.level,
      target: classified.target,
      record: redactProviderProcessOutput(classified.record),
    });
  }

  private reportMcpStartupFailure(
    context: CodexSessionContext,
    name: string,
    failureDetail: string,
  ): void {
    if (context.transport.reportedMcpStartupFailures.has(name)) return;
    context.transport.reportedMcpStartupFailures.add(name);
    log.warn("Codex MCP server failed to start", {
      threadId: context.session.threadId,
      serverName: name,
      error: failureDetail,
    });
    this.emitErrorEvent(
      context,
      "mcpServer/startupFailed",
      `MCP server “${name}” failed to start. Its tools are unavailable for this session.`,
      { key: `codex:mcp-startup:${name}`, fingerprint: name, state: "active" },
    );
  }

  private handleStdoutLine(transport: CodexAccountProcess, line: string): void {
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

    if (this.isResponse(parsed)) {
      this.handleResponse(transport, parsed);
      return;
    }
    if (this.isServerRequest(parsed)) {
      const nativeId = this.readProviderConversationId(parsed.params);
      const context = this.findContext(transport, nativeId);
      if (!context) {
        void this.writeMessage(transport, {
          id: parsed.id,
          error: {
            code: -32602,
            message: "Codex request does not identify an active Penkra thread.",
          },
        }).catch((cause) => this.handleTransportFailure(transport, cause));
        return;
      }
      const ingressTurnId = context.session.activeTurnId ?? null;
      void this.handleServerRequest(context, parsed, ingressTurnId).catch((cause) =>
        this.handleTransportFailure(transport, cause),
      );
      return;
    }
    if (this.isServerNotification(parsed)) {
      if (parsed.method === "turn/started" || parsed.method === "turn/completed")
        void transport.diagnostics?.sampleMemory();
      const nativeId = this.readProviderConversationId(parsed.params);
      if (parsed.method === "thread/closed" && nativeId !== undefined) {
        transport.pendingCloses.get(nativeId)?.resolve();
        return;
      }
      const probe = nativeId ? transport.probes.get(nativeId) : undefined;
      if (probe) {
        if (parsed.method === "turn/completed")
          probe.resolve(
            this.readString(this.readObject(parsed.params, "turn"), "status") === "completed",
          );
        if (parsed.method === "turn/aborted" || parsed.method === "error") probe.resolve(false);
        return;
      }
      const context = this.findContext(transport, nativeId);
      if (context) this.handleServerNotification(context, parsed);
      else if (
        parsed.method === "mcpServer/startupStatus/updated" ||
        parsed.method.startsWith("account/")
      ) {
        // Account/program notifications apply to all real threads attached to it.
        for (const attached of transport.threads) this.handleServerNotification(attached, parsed);
      }
      return;
    }
    for (const context of transport.threads)
      this.emitErrorEvent(
        context,
        "protocol/unrecognizedMessage",
        "Received protocol message in an unknown shape.",
      );
  }

  private findContext(
    transport: CodexAccountProcess,
    nativeId: string | undefined,
  ): CodexSessionContext | undefined {
    if (nativeId === undefined) return undefined;
    for (const context of transport.threads) {
      if (
        !context.stopping &&
        (readResumeCursorThreadId(context.session.resumeCursor) === nativeId ||
          context.collabReceiverParents.has(nativeId))
      )
        return context;
    }
    return undefined;
  }

  private handleOversizedResponse(
    transport: CodexAccountProcess,
    frame: CodexOversizedResponseFrame,
  ): void {
    const key = String(frame.requestId);
    const pending = transport.pending.get(key);
    log.warn("Codex response exceeded its byte limit", {
      pid: transport.child.pid,
      method: pending?.method ?? null,
      requestId: frame.requestId,
      observedBytes: frame.observedBytes,
    });
    if (!pending) return;
    transport.pending.delete(key);
    clearTimeout(pending.timeout);
    pending.reject(
      new CodexResponseTooLargeError(pending.method, frame.requestId, frame.observedBytes),
    );
  }

  private handleOversizedNotification(
    context: CodexSessionContext,
    frame: CodexOversizedNotificationFrame,
  ): void {
    const turnId = toTurnId(frame.turnId) ?? context.session.activeTurnId;
    const providerThreadId =
      frame.threadId ?? this.readString(context.session.resumeCursor, "threadId");
    log.warn("Compacted oversized Codex app-server notification", {
      threadId: context.session.threadId,
      providerThreadId: providerThreadId ?? null,
      providerTurnId: turnId ?? null,
      providerItemId: frame.itemId ?? null,
      method: frame.method,
      observedBytes: frame.observedBytes,
      maxBytes: frame.maxBytes,
      pendingRequest: context.transport.lastRequestMethod ?? null,
      pendingRequestCount: context.transport.pending.size,
      lifecycleGeneration: context.lifecycleGeneration ?? null,
      pid: context.transport.child.pid ?? null,
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
      method: "protocol/oversizedNotificationCompacted",
      ...(turnId ? { turnId } : {}),
      ...(frame.itemId ? { itemId: toProviderItemId(frame.itemId) } : {}),
      ...(providerThreadId ? { providerThreadId } : {}),
      payload: {
        sourceMethod: frame.method,
        observedBytes: frame.observedBytes,
        maxBytes: frame.maxBytes,
      },
    });

    if (
      (frame.method !== "item/started" && frame.method !== "item/completed") ||
      frame.itemType !== "fileChange"
    ) {
      return;
    }

    this.handleServerNotification(context, {
      method: frame.method,
      params: {
        ...(providerThreadId ? { threadId: providerThreadId } : {}),
        ...(turnId ? { turnId } : {}),
        item: {
          type: "fileChange",
          ...(frame.itemId ? { id: frame.itemId } : {}),
          changes: [],
          status: frame.status ?? (frame.method === "item/started" ? "inProgress" : "completed"),
          detailsOmitted: {
            reason: "frame-byte-limit",
            originalBytes: frame.observedBytes,
          },
        },
        completedAtMs: Date.now(),
      },
    });
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
        context.transport.mcpStartupStatuses.set(name, {
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
    if (
      !isChildConversation &&
      isTerminalTurn &&
      (notification.method === "turn/completed" || notification.method === "turn/aborted")
    ) {
      log.warn("Ignoring duplicate terminal notification for a terminal Codex turn", {
        threadId: context.session.threadId,
        turnId: rawRoute.turnId,
        method: notification.method,
      });
      return;
    }
    if (
      notification.method === "turn/started" &&
      !isChildConversation &&
      rawRoute.turnId !== undefined
    ) {
      const pendingStart = context.pendingGatewayTurnStart;
      if (
        pendingStart &&
        (pendingStart.turnId === undefined || pendingStart.turnId === rawRoute.turnId)
      ) {
        pendingStart.turnId = rawRoute.turnId;
        pendingStart.registered = true;
      }
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
      const turn = this.readObject(notification.params, "turn");
      const status = this.readString(turn, "status");
      if (rawRoute.turnId) {
        void this.clearTemporaryResources(context, rawRoute.turnId);
        context.terminalTurnIds.add(rawRoute.turnId);
        context.reviewTurnIds.delete(rawRoute.turnId);
      }
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
        void this.clearTemporaryResources(context, rawRoute.turnId);
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
      const isToolAttemptFailure = isCodexToolAttemptFailure({
        method: notification.method,
        payload: notification.params,
      });

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

      if (isToolAttemptFailure) {
        log.debug("ignored Codex tool-attempt failure", {
          threadId: context.session.threadId,
          message,
        });
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
    ingressTurnId: TurnId | null,
  ): Promise<void> {
    const rawRoute = this.readRouteFields(request.params);
    const resolvedCollaborationRoute = this.resolveCollaborationRoute(context, request.params);
    const {
      parentTurnId: childParentTurnId,
      providerThreadId,
      providerParentThreadId,
    } = resolvedCollaborationRoute;
    const requestKind = this.requestKindForMethod(request.method);
    if (requestKind) {
      await this.writeMessage(context.transport, {
        id: request.id,
        result: {
          decision: providerPermissionDecision(context.session.runtimeMode),
        },
      });
      return;
    }

    const isUserInputRequest = request.method === "item/tool/requestUserInput";
    // Parsed up front: a request whose questions cannot be rendered must never
    // become a pending entry, because nothing would ever answer its JSON-RPC id.
    const userInputQuestions = isUserInputRequest
      ? parseCodexUserInputQuestions(asObject(request.params))
      : undefined;
    const requestId = isUserInputRequest && userInputQuestions ? randomUUID() : undefined;
    if (requestId !== undefined) {
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
      ...(requestId === undefined ? {} : { requestId }),
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
      await this.writeMessage(context.transport, {
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
      const toolTurnId = toTurnId(this.readString(params, "turnId")) ?? ingressTurnId ?? undefined;
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
        await this.writeMessage(context.transport, {
          id: request.id,
          result: {
            contentItems: [
              {
                type: "inputText",
                text: "Penkra rejected an invalid dynamic tool request.",
              },
            ],
            success: false,
          },
        });
        return;
      }
      const pendingStart = context.pendingGatewayTurnStart;
      const canRegisterDispatchedStart =
        toolTurnId !== undefined &&
        pendingStart !== undefined &&
        !pendingStart.registered &&
        (pendingStart.turnId === undefined || pendingStart.turnId === toolTurnId);
      const currentTurnId = context.session.activeTurnId;
      if (
        (toolTurnId !== undefined && context.terminalTurnIds.has(toolTurnId)) ||
        (toolTurnId !== undefined && currentTurnId !== toolTurnId && !canRegisterDispatchedStart) ||
        toolTurnId === undefined
      ) {
        await this.writeMessage(context.transport, {
          id: request.id,
          result: {
            contentItems: [
              { type: "inputText", text: "Penkra rejected a tool request from an inactive turn." },
            ],
            success: false,
          },
        });
        return;
      }
      if (canRegisterDispatchedStart && toolTurnId !== undefined) {
        pendingStart.turnId = toolTurnId;
        pendingStart.registered = true;
        context.session = { ...context.session, status: "running", activeTurnId: toolTurnId };
        this.agentGatewayHostTool.beginTurn?.(
          context.session.threadId,
          toolTurnId,
          context.lifecycleGeneration,
        );
      }
      const result = await this.agentGatewayHostTool.requireNativeSurface().invoke({
        bearerToken: context.gatewaySessionLease.connection.bearerToken,
        name: toolName,
        arguments: rawArguments as Record<string, unknown>,
        ...(toolTurnId ? { originTurnId: toolTurnId } : {}),
      });
      const contentItems: Array<
        { type: "inputText"; text: string } | { type: "inputImage"; imageUrl: string }
      > = [];
      for (const item of result.content) {
        if (item.type === "text") {
          contentItems.push({ type: "inputText", text: item.text });
          continue;
        }
        if (item.type === "image") {
          contentItems.push({
            type: "inputImage",
            imageUrl: `data:${item.mimeType};base64,${item.data}`,
          });
          continue;
        }
        if (item.resource.mimeType?.startsWith("image/")) {
          contentItems.push({
            type: "inputImage",
            imageUrl: `data:${item.resource.mimeType};base64,${item.resource.blob}`,
          });
          continue;
        }
        if (!toolTurnId) {
          throw new Error("Codex cannot receive a temporary App resource outside an active turn.");
        }
        const filePath = await this.materializeTemporaryResource(
          context,
          toolTurnId,
          item.resource,
        );
        contentItems.push({
          type: "inputText",
          text: `Downloaded ${item.resource.name ?? "attachment"} (${item.resource.mimeType ?? "application/octet-stream"}) to ${filePath}. This temporary file is available only for the current turn.`,
        });
      }
      await this.writeMessage(context.transport, {
        id: request.id,
        result: {
          contentItems,
          success: result.isError !== true,
        },
      });
      return;
    }

    await this.writeMessage(context.transport, {
      id: request.id,
      error: {
        code: -32601,
        message: `Unsupported server request: ${request.method}`,
      },
    });
  }

  private handleResponse(transport: CodexAccountProcess, response: JsonRpcResponse): void {
    const key = String(response.id);
    const pending = transport.pending.get(key);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timeout);
    transport.pending.delete(key);

    if (response.error) {
      pending.reject(
        new CodexJsonRpcResponseError(
          pending.method,
          response.error.code,
          typeof response.error.message === "string"
            ? response.error.message
            : "Codex returned a JSON-RPC error without a message.",
          response.error.data,
        ),
      );
      return;
    }

    pending.resolve(response.result);
  }

  private async sendRequest<TResponse>(
    transport: CodexAccountProcess,
    ownerThreadId: ThreadId | null,
    method: string,
    params: unknown,
    timeoutMs = 20_000,
    signal?: AbortSignal,
  ): Promise<TResponse> {
    if (transport.protocolClosed) throw new Error("Codex account protocol is closed.");
    if (signal?.aborted) {
      throw new Error(`Cancelled ${method} because Codex session startup was interrupted.`);
    }
    const id = transport.nextRequestId;
    transport.nextRequestId += 1;
    transport.lastRequestMethod = method;
    log.debug("Codex request issued", {
      pid: transport.child.pid,
      requestId: id,
      method,
      ownerThreadId,
    });

    const result = await new Promise<unknown>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
      };
      const onAbort = () => {
        transport.pending.delete(String(id));
        cleanup();
        reject(new Error(`Cancelled ${method} because Codex session startup was interrupted.`));
      };
      const timeout = setTimeout(() => {
        transport.pending.delete(String(id));
        signal?.removeEventListener("abort", onAbort);
        reject(new Error(`Timed out waiting for ${method}.`));
      }, timeoutMs);

      transport.pending.set(String(id), {
        method,
        ownerThreadId,
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
      void this.writeMessage(transport, { method, id, params }).catch((error) => {
        if (transport.protocolClosed && !transport.stopping && !transport.transportFailureHandled)
          return;
        transport.pending.delete(String(id));
        cleanup();
        reject(error);
      });
    });

    return result as TResponse;
  }

  private writeMessage(transport: CodexAccountProcess, message: unknown): Promise<void> {
    if (transport.protocolClosed)
      return Promise.reject(new Error("Codex account protocol is closed."));
    return transport.stdinWriter.write(message).catch((cause) => {
      this.handleTransportFailure(transport, cause);
      throw cause;
    });
  }

  private emitLifecycleEvent(context: CodexSessionContext, method: string, message: string): void {
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

  private emitErrorEvent(
    context: CodexSessionContext,
    method: string,
    message: string,
    diagnostic?: CodexRuntimeDiagnostic,
  ): void {
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
      ...(diagnostic ? { payload: { diagnostic } } : {}),
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
      void this.clearTemporaryResources(context, turnId);
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
  inFlight: boolean;
  /**
   * The file the successful probe ran, or null when it could not be located.
   *
   * The path alone does not identify a binary: `npm i -g @openai/codex`, a downgrade or a local
   * rebuild all leave the path untouched, so a purely path-keyed cache would keep serving the
   * pre-upgrade verdict indefinitely, swallowing a downgrade below the
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
  try {
    assertCodexWorkingDirectoryExists(input.cwd);
  } catch (error) {
    if (error instanceof CodexWorkingDirectoryAccessError) {
      log.error("Codex workspace access preflight failed", {
        cwd: error.cwd,
        phase: error.phase,
        osErrorCode: error.osErrorCode,
        failurePhase: "before-provider-dispatch",
      });
    }
    throw error;
  }

  const key = codexCliVersionGateKey(input.binaryPath, input.homePath);
  const existing = codexCliVersionGates.get(key);
  if (existing) {
    if (existing.inFlight || !isCodexCliVersionGateStale(existing)) {
      await existing.promise;
      return;
    }
    codexCliVersionGates.delete(key);
  }

  const entry: CodexCliVersionGateEntry = {
    promise: Promise.resolve(),
    inFlight: true,
    fingerprint: null,
  };
  entry.promise = runCodexCliVersionGate(input).then(
    (fingerprint) => {
      entry.fingerprint = fingerprint;
      entry.inFlight = false;
      // Without a file identity there is no change event that could invalidate the verdict.
      if (fingerprint === null && codexCliVersionGates.get(key) === entry)
        codexCliVersionGates.delete(key);
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
