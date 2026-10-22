// FILE: opencodeRuntime.ts
// Purpose: Starts OpenCode-compatible local servers and adapts their SDK/CLI data.
// Layer: Provider runtime utility
// Exports: OpenCodeRuntime, OpenCodeRuntimeLive, model/auth parsers, SDK helpers

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  makeProviderProcessDiagnostics,
  redactProviderProcessOutput,
} from "./providerProcessDiagnostics.ts";

import type { ChatAttachment, RuntimeMode, ProviderConnectionId } from "@penkra/contracts";
import {
  createOpencodeClient,
  type FilePartInput,
  type OpencodeClient,
  type PermissionRuleset,
  type ProviderListResponse,
  type QuestionAnswer,
  type QuestionRequest,
} from "@opencode-ai/sdk/v2";
import {
  Cause,
  Data,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Predicate as P,
  Ref,
  Result,
  ServiceMap,
  Scope,
  Stream,
} from "effect";
import { makeKeyedRuntimeLock } from "./keyedRuntimeLock.ts";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { prepareWindowsSafeProcess } from "@penkra/shared/windowsProcess";
import { buildProviderChildEnvironment } from "../providerChildEnvironment.ts";
import {
  teardownEffectProcessTree,
  teardownProviderProcessTree,
} from "./supervisedProcessTeardown.ts";
import { isWindowsShellCommandMissingResult } from "../shell-command-detection.ts";

const DEFAULT_OPENCODE_SERVER_TIMEOUT_MS = 20_000;
const DEFAULT_HOSTNAME = "127.0.0.1";
const OPENCODE_STARTUP_OUTPUT_MAX_CHARS = 4_000;
const REDACTED_STARTUP_SECRET = "[redacted]";
const STARTUP_OUTPUT_AUTHORIZATION_PATTERN =
  /(["']?)(authorization)\1(\s*[:=]\s*)(["']?)(bearer\s+)?[^"'\s,;}]+\4/gi;
const STARTUP_OUTPUT_SECRET_ASSIGNMENT_PATTERN =
  /(["']?)([A-Za-z0-9_-]*(?:api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|bearer[_-]?token|token|secret|password)[A-Za-z0-9_-]*)\1(\s*[:=]\s*)(["']?)[^"'\s,;}]+\4/gi;

export interface OpenCodeCompatibleCliSpec {
  readonly defaultBinaryPath: string;
  readonly displayName: string;
  readonly serverReadyPrefix: string;
  readonly managedServerArgs: ReadonlyArray<string>;
  readonly configContentEnvVar: string;
  readonly dataDirectoryName: string;
  readonly serverAuthUsername: string;
}

export const OPENCODE_CLI_SPEC: OpenCodeCompatibleCliSpec = {
  defaultBinaryPath: "opencode",
  displayName: "OpenCode",
  serverReadyPrefix: "opencode server listening",
  managedServerArgs: [],
  configContentEnvVar: "OPENCODE_CONFIG_CONTENT",
  dataDirectoryName: "opencode",
  serverAuthUsername: "opencode",
};

export interface OpenCodeServerProcess {
  readonly url: string;
  readonly exitCode: Effect.Effect<number, never>;
}

export interface OpenCodeServerConnection {
  readonly url: string;
  readonly exitCode: Effect.Effect<number, never> | null;
  readonly external: boolean;
  readonly gatewayProcessToken?: string;
}

export interface OpenCodeGatewayProcessCredential {
  readonly url: string;
  readonly issue: () => string;
  readonly revoke: (token: string) => void;
}

interface PooledOpenCodeServer {
  readonly key: string;
  readonly server: OpenCodeServerProcess;
  readonly scope: Scope.Closeable;
  readonly connectionIds: Set<ProviderConnectionId>;
  readonly gatewayProcessToken?: string;
  refCount: number;
  exitWatchFiber: Fiber.Fiber<void, never> | null;
}

const OPENCODE_RUNTIME_ERROR_TAG = "OpenCodeRuntimeError";
export class OpenCodeRuntimeError extends Data.TaggedError(OPENCODE_RUNTIME_ERROR_TAG)<{
  readonly operation: string;
  readonly cause?: unknown;
  readonly detail: string;
}> {
  static readonly is = (u: unknown): u is OpenCodeRuntimeError =>
    P.isTagged(u, OPENCODE_RUNTIME_ERROR_TAG);
}

export function openCodeRuntimeErrorDetail(cause: unknown): string {
  if (OpenCodeRuntimeError.is(cause)) return cause.detail;
  if (cause instanceof Error && cause.message.trim().length > 0) return cause.message.trim();
  if (cause && typeof cause === "object") {
    const anyCause = cause as Record<string, unknown>;
    const status = (anyCause.response as { status?: number } | undefined)?.status;
    const body = anyCause.error ?? anyCause.data ?? anyCause.body;
    try {
      return `status=${status ?? "?"} body=${JSON.stringify(body ?? cause)}`;
    } catch {
      // ignore stringify failure
    }
  }
  return String(cause);
}

export const runOpenCodeSdk = <A>(
  operation: string,
  fn: () => Promise<A>,
): Effect.Effect<A, OpenCodeRuntimeError> =>
  Effect.tryPromise({
    try: fn,
    catch: (cause) =>
      new OpenCodeRuntimeError({ operation, detail: openCodeRuntimeErrorDetail(cause), cause }),
  }).pipe(Effect.withSpan(`opencode.${operation}`));

export interface OpenCodeCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

export interface ParsedOpenCodeModelSlug {
  readonly providerID: string;
  readonly modelID: string;
}

export function isAuthoritativelyFreeOpenCodeModel(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const model = value as Record<string, unknown>;
  if (typeof model.isFree === "boolean") return model.isFree;
  const cost = model.cost;
  if (!cost || typeof cost !== "object" || Array.isArray(cost)) return false;
  const pricing = cost as Record<string, unknown>;
  if (pricing.input !== 0 || pricing.output !== 0) return false;
  const cache = pricing.cache;
  if (cache === undefined) return true;
  if (!cache || typeof cache !== "object" || Array.isArray(cache)) return false;
  const cachePricing = cache as Record<string, unknown>;
  return (
    (cachePricing.read === undefined || cachePricing.read === 0) &&
    (cachePricing.write === undefined || cachePricing.write === 0)
  );
}

export interface OpenCodePathInfo {
  readonly home: string;
  readonly state: string;
  readonly config: string;
  readonly worktree: string;
  readonly directory: string;
}

export interface OpenCodeRuntimeShape {
  readonly startOpenCodeServerProcess: (input: {
    readonly binaryPath: string;
    readonly cliSpec?: OpenCodeCompatibleCliSpec;
    readonly cwd?: string;
    readonly port?: number;
    readonly hostname?: string;
    readonly timeoutMs?: number;
    readonly experimentalWebSockets?: boolean;
    readonly processEnv?: NodeJS.ProcessEnv;
  }) => Effect.Effect<OpenCodeServerProcess, OpenCodeRuntimeError, Scope.Scope>;
  readonly connectToOpenCodeServer: (input: {
    readonly binaryPath: string;
    readonly cliSpec?: OpenCodeCompatibleCliSpec;
    readonly cwd?: string;
    readonly serverUrl?: string | null;
    readonly port?: number;
    readonly hostname?: string;
    readonly timeoutMs?: number;
    readonly experimentalWebSockets?: boolean;
    readonly processEnv?: NodeJS.ProcessEnv;
    /** Isolates the managed program; the runtime retains it until explicit close. */
    readonly poolIsolationKey?: string;
    readonly connectionId?: ProviderConnectionId;
    readonly assertCurrentCredentials?: Effect.Effect<void, unknown>;
    readonly gateway?: OpenCodeGatewayProcessCredential;
  }) => Effect.Effect<OpenCodeServerConnection, OpenCodeRuntimeError, Scope.Scope>;
  readonly stopAccount: (
    connectionId: ProviderConnectionId,
  ) => Effect.Effect<void, OpenCodeRuntimeError>;
  readonly stopAll: () => Effect.Effect<void, OpenCodeRuntimeError>;
  readonly runOpenCodeCommand: (input: {
    readonly binaryPath: string;
    readonly cliSpec?: OpenCodeCompatibleCliSpec;
    readonly args: ReadonlyArray<string>;
    readonly cwd?: string;
    readonly processEnv?: NodeJS.ProcessEnv;
  }) => Effect.Effect<OpenCodeCommandResult, OpenCodeRuntimeError>;
  readonly createOpenCodeSdkClient: (input: {
    readonly baseUrl: string;
    readonly directory: string;
    readonly cliSpec?: OpenCodeCompatibleCliSpec;
    readonly serverPassword?: string;
  }) => OpencodeClient;
  readonly loadOpenCodeProviderList: (
    client: OpencodeClient,
  ) => Effect.Effect<ProviderListResponse, OpenCodeRuntimeError>;
  readonly loadOpenCodeCredentialProviderIDs: (
    client: OpencodeClient,
    cliSpec?: OpenCodeCompatibleCliSpec,
  ) => Effect.Effect<ReadonlyArray<string>, never>;
}

function parseServerUrlFromOutput(output: string, readyPrefix: string): string | null {
  for (const line of output.split("\n")) {
    if (!line.startsWith(readyPrefix)) {
      continue;
    }
    const match = line.match(/on\s+(https?:\/\/[^\s]+)/);
    return match?.[1] ?? null;
  }
  return null;
}

function formatCommandPart(value: string): string {
  return /^[A-Za-z0-9_./:=@+-]+$/.test(value) ? value : JSON.stringify(value);
}

// Startup output is user-visible on failures, so keep diagnostics while masking likely secrets.
function redactStartupOutput(value: string): string {
  return value
    .replace(
      STARTUP_OUTPUT_AUTHORIZATION_PATTERN,
      (_match, keyQuote, key, separator, valueQuote, scheme = "") =>
        `${keyQuote}${key}${keyQuote}${separator}${valueQuote}${scheme}${REDACTED_STARTUP_SECRET}${valueQuote}`,
    )
    .replace(
      STARTUP_OUTPUT_SECRET_ASSIGNMENT_PATTERN,
      (_match, keyQuote, key, separator, valueQuote) =>
        `${keyQuote}${key}${keyQuote}${separator}${valueQuote}${REDACTED_STARTUP_SECRET}${valueQuote}`,
    );
}

function truncateStartupOutput(value: string): string | null {
  const trimmed = redactStartupOutput(value).trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (trimmed.length <= OPENCODE_STARTUP_OUTPUT_MAX_CHARS) {
    return trimmed;
  }
  const remainingChars = trimmed.length - OPENCODE_STARTUP_OUTPUT_MAX_CHARS;
  return `${trimmed.slice(0, OPENCODE_STARTUP_OUTPUT_MAX_CHARS)}\n\n[truncated ${remainingChars} chars]`;
}

function formatOpenCodeServerStartupDetail(input: {
  readonly displayName: string;
  readonly summary: string;
  readonly binaryPath: string;
  readonly args: ReadonlyArray<string>;
  readonly readyPrefix: string;
  readonly stdout: string;
  readonly stderr: string;
}): string {
  const stdout = truncateStartupOutput(input.stdout);
  const stderr = truncateStartupOutput(input.stderr);
  const command = [input.binaryPath, ...input.args].map(formatCommandPart).join(" ");

  return [
    input.summary,
    `command: ${command}`,
    `${input.displayName} ready prefix: ${JSON.stringify(input.readyPrefix)}`,
    stdout ? `stdout:\n${stdout}` : "stdout: <empty>",
    stderr ? `stderr:\n${stderr}` : "stderr: <empty>",
  ].join("\n\n");
}

function pooledOpenCodeServerKey(input: {
  readonly binaryPath: string;
  readonly cliSpec?: OpenCodeCompatibleCliSpec;
  readonly cwd?: string;
  readonly port?: number;
  readonly hostname?: string;
  readonly experimentalWebSockets?: boolean;
  readonly poolIsolationKey?: string;
}): string {
  if (input.poolIsolationKey !== undefined) {
    return JSON.stringify({
      binaryPath: input.binaryPath,
      poolIsolationKey: input.poolIsolationKey,
    });
  }
  const cliSpec = input.cliSpec ?? OPENCODE_CLI_SPEC;
  return JSON.stringify({
    binaryPath: input.binaryPath,
    cwd: input.cwd ?? null,
    hostname: input.hostname ?? DEFAULT_HOSTNAME,
    port: input.port ?? null,
    experimentalWebSockets: input.experimentalWebSockets === true,
    poolIsolationKey: input.poolIsolationKey ?? null,
    cliSpec: {
      defaultBinaryPath: cliSpec.defaultBinaryPath,
      displayName: cliSpec.displayName,
      serverReadyPrefix: cliSpec.serverReadyPrefix,
      managedServerArgs: cliSpec.managedServerArgs,
      configContentEnvVar: cliSpec.configContentEnvVar,
      dataDirectoryName: cliSpec.dataDirectoryName,
      serverAuthUsername: cliSpec.serverAuthUsername,
    },
  });
}

export function parseOpenCodeModelSlug(
  slug: string | null | undefined,
): ParsedOpenCodeModelSlug | null {
  if (typeof slug !== "string") {
    return null;
  }

  const trimmed = slug.trim();
  const separator = trimmed.indexOf("/");
  if (separator <= 0 || separator === trimmed.length - 1) {
    return null;
  }

  return {
    providerID: trimmed.slice(0, separator),
    modelID: trimmed.slice(separator + 1),
  };
}

function trimToNull(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function resolveOpenCodeDataDirectory(
  homeDirectory: string,
  dataDirectoryName = "opencode",
): string {
  if (process.platform === "win32") {
    const appDataDirectory =
      trimToNull(process.env.APPDATA) ?? join(homeDirectory, "AppData", "Roaming");
    return join(appDataDirectory, dataDirectoryName);
  }

  const xdgDataHome =
    trimToNull(process.env.XDG_DATA_HOME) ?? join(homeDirectory, ".local", "share");
  return join(xdgDataHome, dataDirectoryName);
}

export function resolveOpenCodeAuthFilePath(
  pathInfo: Pick<OpenCodePathInfo, "home">,
  cliSpec: OpenCodeCompatibleCliSpec = OPENCODE_CLI_SPEC,
): string {
  return join(resolveOpenCodeDataDirectory(pathInfo.home, cliSpec.dataDirectoryName), "auth.json");
}

export function parseOpenCodeCredentialProviderIDs(content: string): ReadonlyArray<string> {
  const parsed = JSON.parse(content) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return [];
  }

  return Object.entries(parsed as Record<string, unknown>)
    .flatMap(([providerID, value]) =>
      value && typeof value === "object" && !Array.isArray(value) ? [providerID.trim()] : [],
    )
    .filter((providerID) => providerID.length > 0)
    .toSorted((left, right) => left.localeCompare(right));
}

export function openCodeQuestionId(
  index: number,
  question: QuestionRequest["questions"][number],
): string {
  const header = question.header
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-");
  return header.length > 0 ? `question-${index}-${header}` : `question-${index}`;
}

// OpenCode file parts reject many document MIME types; keep native parts to images.
export function toOpenCodeFileParts(input: {
  readonly attachments: ReadonlyArray<ChatAttachment> | undefined;
  readonly resolveAttachmentPath: (attachment: ChatAttachment) => string | null;
}): Array<FilePartInput> {
  const parts: Array<FilePartInput> = [];

  for (const attachment of input.attachments ?? []) {
    if (attachment.type !== "image") {
      continue;
    }

    const attachmentPath = input.resolveAttachmentPath(attachment);
    if (!attachmentPath) {
      continue;
    }

    parts.push({
      type: "file",
      mime: attachment.mimeType,
      filename: attachment.name,
      url: pathToFileURL(attachmentPath).href,
    });
  }

  return parts;
}

export function buildOpenCodePermissionRules(runtimeMode: RuntimeMode): PermissionRuleset {
  const runtimeRules: PermissionRuleset =
    runtimeMode === "full-access"
      ? [{ permission: "*", pattern: "*", action: "allow" }]
      : [
          { permission: "*", pattern: "*", action: "ask" },
          { permission: "bash", pattern: "*", action: "ask" },
          { permission: "edit", pattern: "*", action: "ask" },
          { permission: "webfetch", pattern: "*", action: "ask" },
          { permission: "websearch", pattern: "*", action: "ask" },
          { permission: "codesearch", pattern: "*", action: "ask" },
          { permission: "external_directory", pattern: "*", action: "ask" },
          { permission: "doom_loop", pattern: "*", action: "ask" },
          { permission: "question", pattern: "*", action: "allow" },
        ];

  return runtimeRules;
}

export function buildOpenCodeServerProcessEnv(input: {
  readonly cliSpec?: OpenCodeCompatibleCliSpec;
  readonly experimentalWebSockets?: boolean;
  readonly baseEnv?: NodeJS.ProcessEnv;
}): NodeJS.ProcessEnv {
  return buildProviderChildEnvironment({
    provider: "opencode",
    baseEnv: input.baseEnv ?? process.env,
    overrides: input.experimentalWebSockets ? { OPENCODE_EXPERIMENTAL_WEBSOCKETS: "true" } : {},
  });
}

export function toOpenCodeQuestionAnswers(
  request: QuestionRequest,
  answers: Record<string, unknown>,
): Array<QuestionAnswer> {
  return request.questions.map((question, index) => {
    const raw =
      answers[openCodeQuestionId(index, question)] ??
      answers[question.header] ??
      answers[question.question];
    if (Array.isArray(raw)) {
      return raw.filter((value): value is string => typeof value === "string");
    }
    if (typeof raw === "string") {
      return raw.trim().length > 0 ? [raw] : [];
    }
    return [];
  });
}

function ensureRuntimeError(
  operation: OpenCodeRuntimeError["operation"],
  detail: string,
  cause: unknown,
): OpenCodeRuntimeError {
  return OpenCodeRuntimeError.is(cause)
    ? cause
    : new OpenCodeRuntimeError({ operation, detail, cause });
}

const collectStreamAsString = <E>(stream: Stream.Stream<Uint8Array, E>): Effect.Effect<string, E> =>
  Stream.runFold(
    stream,
    () => "",
    (acc, chunk) => acc + new TextDecoder().decode(chunk),
  );

export interface OpenCodeRuntimeLiveOptions {
  readonly teardownProcessTree?: typeof teardownProviderProcessTree;
}

const makeOpenCodeRuntime = (options?: OpenCodeRuntimeLiveOptions) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const pooledServerScope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
      Scope.close(scope, Exit.void),
    );
    const withPoolLock = makeKeyedRuntimeLock<string>();
    const pendingServers = new Map<string, { connectionId: ProviderConnectionId | undefined }>();
    let stoppingAll = 0;
    let disposed = false;
    const pooledServers = new Map<string, PooledOpenCodeServer>();

    const runOpenCodeCommand: OpenCodeRuntimeShape["runOpenCodeCommand"] = (input) =>
      Effect.gen(function* () {
        const childEnv =
          input.processEnv ??
          buildOpenCodeServerProcessEnv({
            ...(input.cliSpec ? { cliSpec: input.cliSpec } : {}),
          });
        const prepared = prepareWindowsSafeProcess(input.binaryPath, input.args, {
          cwd: input.cwd,
          env: childEnv,
        });
        const child = yield* spawner.spawn(
          ChildProcess.make(prepared.command, prepared.args, {
            shell: prepared.shell,
            ...(prepared.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
            ...(input.cwd ? { cwd: input.cwd } : {}),
            env: childEnv,
          }),
        );
        const [stdout, stderr, code] = yield* Effect.all(
          [
            collectStreamAsString(child.stdout),
            collectStreamAsString(child.stderr),
            child.exitCode,
          ],
          { concurrency: "unbounded" },
        );
        const exitCode = Number(code);
        if (isWindowsShellCommandMissingResult({ code: exitCode, stderr })) {
          return yield* new OpenCodeRuntimeError({
            operation: "runOpenCodeCommand",
            detail: `spawn ${input.binaryPath} ENOENT`,
          });
        }
        return {
          stdout,
          stderr,
          code: exitCode,
        } satisfies OpenCodeCommandResult;
      }).pipe(
        Effect.scoped,
        Effect.mapError((cause) =>
          ensureRuntimeError(
            "runOpenCodeCommand",
            `Failed to execute '${input.binaryPath} ${input.args.join(" ")}': ${openCodeRuntimeErrorDetail(cause)}`,
            cause,
          ),
        ),
      );

    const startOpenCodeServerProcess: OpenCodeRuntimeShape["startOpenCodeServerProcess"] = (
      input,
    ) =>
      Effect.gen(function* () {
        const runtimeScope = yield* Scope.Scope;
        const cliSpec = input.cliSpec ?? OPENCODE_CLI_SPEC;

        const hostname = input.hostname ?? DEFAULT_HOSTNAME;
        // Let the OS allocate the port at the provider's actual bind. A probe
        // cannot reserve it across process startup and may use another address family.
        const port = input.port ?? 0;
        const timeoutMs = input.timeoutMs ?? DEFAULT_OPENCODE_SERVER_TIMEOUT_MS;
        const args = [
          "serve",
          ...cliSpec.managedServerArgs,
          "--hostname",
          hostname,
          "--port",
          String(port),
        ];

        const child = yield* spawner
          .spawn(
            ChildProcess.make(input.binaryPath, args, {
              env:
                input.processEnv ??
                buildOpenCodeServerProcessEnv({
                  cliSpec,
                  ...(input.experimentalWebSockets !== undefined
                    ? { experimentalWebSockets: input.experimentalWebSockets }
                    : {}),
                }),
              ...(input.cwd ? { cwd: input.cwd } : {}),
              detached: false,
              killSignal: "SIGKILL",
              forceKillAfter: "1500 millis",
            }),
          )
          .pipe(
            Effect.provideService(Scope.Scope, runtimeScope),
            Effect.mapError(
              (cause) =>
                new OpenCodeRuntimeError({
                  operation: "startOpenCodeServerProcess",
                  detail: `Failed to spawn OpenCode server process: ${openCodeRuntimeErrorDetail(cause)}`,
                  cause,
                }),
            ),
          );
        let requestedStop = false;
        let exitCause: string | null = null;
        const diagnostics = makeProviderProcessDiagnostics({
          provider: "opencode",
          pid: Number(child.pid),
          context: () => ({ binaryPath: input.binaryPath, requestedStop, exitCause }),
        });
        void diagnostics.sampleMemory();
        // Observe native completion independently of the stream-reader scope: that
        // scope is interrupted before its process teardown finalizer runs.
        void Effect.runPromise(Effect.exit(child.exitCode)).then((exit) => {
          if (Exit.isSuccess(exit)) diagnostics.recordExit(Number(exit.value), null);
          else {
            exitCause = redactProviderProcessOutput(Cause.pretty(exit.cause));
            diagnostics.recordExit(null, null);
          }
        });
        yield* Scope.addFinalizer(
          runtimeScope,
          Effect.tryPromise({
            try: () => {
              requestedStop = true;
              return teardownEffectProcessTree(
                child,
                options?.teardownProcessTree ?? teardownProviderProcessTree,
              );
            },
            catch: (cause) =>
              new OpenCodeRuntimeError({
                operation: "stopOpenCodeServerProcess",
                detail: `Failed to prove ${cliSpec.displayName} server process-tree exit: ${openCodeRuntimeErrorDetail(cause)}`,
                cause,
              }),
          }).pipe(Effect.asVoid, Effect.orDie),
        );

        const stdoutRef = yield* Ref.make("");
        const stderrRef = yield* Ref.make("");
        const serverReadyRef = yield* Ref.make(false);
        const readyDeferred = yield* Deferred.make<string, OpenCodeRuntimeError>();

        const setReadyFromStdoutChunk = (chunk: string) =>
          Ref.updateAndGet(stdoutRef, (stdout) => `${stdout}${chunk}`).pipe(
            Effect.flatMap((nextStdout) => {
              const parsed = parseServerUrlFromOutput(nextStdout, cliSpec.serverReadyPrefix);
              return parsed
                ? Effect.gen(function* () {
                    yield* Ref.set(serverReadyRef, true);
                    void diagnostics.sampleMemory();
                    yield* Deferred.succeed(readyDeferred, parsed).pipe(Effect.ignore);
                  })
                : Effect.void;
            }),
          );

        const stdoutFiber = yield* child.stdout.pipe(
          Stream.decodeText(),
          Stream.runForEach(setReadyFromStdoutChunk),
          Effect.ignore,
          Effect.forkIn(runtimeScope),
        );
        const stderrFiber = yield* child.stderr.pipe(
          Stream.tap((chunk) => Effect.sync(() => diagnostics.appendStderr(Buffer.from(chunk)))),
          Stream.decodeText(),
          Stream.splitLines,
          Stream.runForEach((record) =>
            Effect.gen(function* () {
              if (yield* Ref.get(serverReadyRef)) {
                yield* Effect.logDebug(`${cliSpec.displayName} server stderr`, {
                  binaryPath: input.binaryPath,
                  record: redactStartupOutput(record),
                });
                return;
              }
              yield* Ref.update(stderrRef, (stderr) => `${stderr}${record}\n`);
            }),
          ),
          Effect.ignore,
          Effect.forkIn(runtimeScope),
        );

        const exitFiber = yield* child.exitCode.pipe(
          Effect.flatMap((code) =>
            Effect.gen(function* () {
              const stdout = yield* Ref.get(stdoutRef);
              const stderr = yield* Ref.get(stderrRef);
              const redactedStdout = redactStartupOutput(stdout);
              const redactedStderr = redactStartupOutput(stderr);
              const exitCode = Number(code);
              yield* Deferred.fail(
                readyDeferred,
                new OpenCodeRuntimeError({
                  operation: "startOpenCodeServerProcess",
                  detail: formatOpenCodeServerStartupDetail({
                    displayName: cliSpec.displayName,
                    summary: `${cliSpec.displayName} server exited before startup completed (code: ${String(exitCode)}).`,
                    binaryPath: input.binaryPath,
                    args,
                    readyPrefix: cliSpec.serverReadyPrefix,
                    stdout: redactedStdout,
                    stderr: redactedStderr,
                  }),
                  cause: {
                    exitCode,
                    stdout: redactedStdout,
                    stderr: redactedStderr,
                    binaryPath: input.binaryPath,
                    args,
                    readyPrefix: cliSpec.serverReadyPrefix,
                  },
                }),
              ).pipe(Effect.ignore);
            }),
          ),
          Effect.ignore,
          Effect.forkIn(runtimeScope),
        );

        const readyExit = yield* Effect.exit(
          Deferred.await(readyDeferred).pipe(Effect.timeoutOption(timeoutMs)),
        );

        yield* Fiber.interrupt(stdoutFiber).pipe(Effect.ignore);

        if (Exit.isFailure(readyExit)) {
          yield* Fiber.interrupt(stderrFiber).pipe(Effect.ignore);
          yield* Fiber.interrupt(exitFiber).pipe(Effect.ignore);
          const squashed = Cause.squash(readyExit.cause);
          return yield* ensureRuntimeError(
            "startOpenCodeServerProcess",
            [
              `Failed while waiting for ${cliSpec.displayName} server startup:`,
              openCodeRuntimeErrorDetail(squashed),
            ].join(" "),
            squashed,
          );
        }

        const readyOption = readyExit.value;
        if (Option.isNone(readyOption)) {
          yield* Fiber.interrupt(stderrFiber).pipe(Effect.ignore);
          yield* Fiber.interrupt(exitFiber).pipe(Effect.ignore);
          const stdout = yield* Ref.get(stdoutRef);
          const stderr = yield* Ref.get(stderrRef);
          const redactedStdout = redactStartupOutput(stdout);
          const redactedStderr = redactStartupOutput(stderr);
          return yield* new OpenCodeRuntimeError({
            operation: "startOpenCodeServerProcess",
            detail: formatOpenCodeServerStartupDetail({
              displayName: cliSpec.displayName,
              summary: `Timed out waiting for ${cliSpec.displayName} server start after ${timeoutMs}ms.`,
              binaryPath: input.binaryPath,
              args,
              readyPrefix: cliSpec.serverReadyPrefix,
              stdout: redactedStdout,
              stderr: redactedStderr,
            }),
            cause: {
              timeoutMs,
              stdout: redactedStdout,
              stderr: redactedStderr,
              binaryPath: input.binaryPath,
              args,
              readyPrefix: cliSpec.serverReadyPrefix,
            },
          });
        }

        return {
          url: readyOption.value,
          exitCode: child.exitCode.pipe(
            Effect.map(Number),
            Effect.orElseSucceed(() => 0),
          ),
        } satisfies OpenCodeServerProcess;
      });

    const detachPooledServer = (pooledServer: PooledOpenCodeServer) =>
      Effect.sync(() => {
        pooledServers.delete(pooledServer.key);
        pooledServer.refCount = 0;
      });

    const closePooledServer = Effect.fn("closePooledServer")(function* (
      pooledServer: PooledOpenCodeServer,
    ) {
      // Keep the pool entry authoritative while scope finalization proves the server tree exited.
      // Acquirers serialize only on this process key until exit proof settles.

      const exitWatchFiber = pooledServer.exitWatchFiber;
      pooledServer.exitWatchFiber = null;
      if (exitWatchFiber !== null) {
        yield* Fiber.interrupt(exitWatchFiber).pipe(Effect.ignore);
      }

      yield* Scope.close(pooledServer.scope, Exit.void);
      yield* detachPooledServer(pooledServer);
    });

    const watchPooledServerExit = Effect.fn("watchPooledServerExit")(function* (
      pooledServer: PooledOpenCodeServer,
    ) {
      const exitWatchFiber = yield* pooledServer.server.exitCode.pipe(
        Effect.flatMap(() =>
          withPoolLock(
            pooledServer.key,
            Effect.gen(function* () {
              if (pooledServers.get(pooledServer.key) !== pooledServer) {
                return;
              }
              pooledServer.exitWatchFiber = null;
              yield* Scope.close(pooledServer.scope, Exit.void);
              yield* detachPooledServer(pooledServer);
            }),
          ),
        ),
        Effect.ignore,
        Effect.forkIn(pooledServerScope),
      );
      pooledServer.exitWatchFiber = exitWatchFiber;
    });

    const acquirePooledServer = (input: {
      readonly binaryPath: string;
      readonly cliSpec?: OpenCodeCompatibleCliSpec;
      readonly cwd?: string;
      readonly port?: number;
      readonly hostname?: string;
      readonly timeoutMs?: number;
      readonly experimentalWebSockets?: boolean;
      readonly poolIsolationKey?: string;
      readonly connectionId?: ProviderConnectionId;
      readonly assertCurrentCredentials?: Effect.Effect<void, unknown>;
      readonly gateway?: OpenCodeGatewayProcessCredential;
      readonly processEnv?: NodeJS.ProcessEnv;
    }) =>
      withPoolLock(
        pooledOpenCodeServerKey(input),
        Effect.gen(function* () {
          if (disposed || stoppingAll > 0)
            return yield* new OpenCodeRuntimeError({
              operation: "connectToOpenCodeServer",
              detail: "Provider process admission is closed during shutdown.",
            });
          if (input.connectionId !== undefined && input.assertCurrentCredentials === undefined)
            return yield* new OpenCodeRuntimeError({
              operation: "connectToOpenCodeServer",
              detail: "A Connection-owned process requires current credential admission.",
            });
          const validate =
            input.assertCurrentCredentials === undefined
              ? Effect.void
              : input.assertCurrentCredentials.pipe(
                  Effect.mapError(
                    (cause) =>
                      new OpenCodeRuntimeError({
                        operation: "connectToOpenCodeServer",
                        detail: "The Connection is no longer current for native admission.",
                        cause,
                      }),
                  ),
                );
          const key = pooledOpenCodeServerKey(input);
          const existing = pooledServers.get(key);
          if (existing) {
            yield* validate;
            if (input.gateway !== undefined && existing.gatewayProcessToken === undefined) {
              return yield* new OpenCodeRuntimeError({
                operation: "connectToOpenCodeServer",
                detail: "The existing provider process has no gateway ownership.",
              });
            }
            if (input.connectionId !== undefined) existing.connectionIds.add(input.connectionId);
            existing.refCount += 1;
            return existing;
          }

          // Start lazily and keep the shared program until quit, removal or update.
          pendingServers.set(key, {
            connectionId: input.connectionId,
          });
          return yield* Effect.uninterruptibleMask((restore) =>
            Effect.gen(function* () {
              const serverScope = yield* Scope.make();
              const gatewayProcessToken = input.gateway?.issue();
              if (gatewayProcessToken !== undefined) {
                yield* Scope.addFinalizer(
                  serverScope,
                  Effect.sync(() => input.gateway!.revoke(gatewayProcessToken)),
                );
              }
              const processInput =
                gatewayProcessToken === undefined
                  ? input
                  : {
                      ...input,
                      processEnv: {
                        ...input.processEnv,
                        PENKRA_GATEWAY_URL: input.gateway!.url,
                        PENKRA_GATEWAY_PROCESS_TOKEN: gatewayProcessToken,
                      },
                    };
              const startedExit = yield* Effect.exit(
                restore(
                  validate.pipe(
                    Effect.andThen(startOpenCodeServerProcess(processInput)),
                    Effect.provideService(Scope.Scope, serverScope),
                  ),
                ),
              );

              if (Exit.isFailure(startedExit)) {
                yield* Scope.close(serverScope, Exit.void).pipe(Effect.ignore);
                return yield* Effect.failCause(startedExit.cause);
              }

              const pooledServer: PooledOpenCodeServer = {
                key,
                server: startedExit.value,
                scope: serverScope,
                connectionIds: new Set(
                  input.connectionId === undefined ? [] : [input.connectionId],
                ),
                ...(gatewayProcessToken === undefined ? {} : { gatewayProcessToken }),
                refCount: 1,
                exitWatchFiber: null,
              };
              pooledServers.set(key, pooledServer);
              yield* watchPooledServerExit(pooledServer);
              return pooledServer;
            }),
          ).pipe(Effect.ensuring(Effect.sync(() => pendingServers.delete(key))));
        }),
      );

    const releasePooledServer = (pooledServer: PooledOpenCodeServer) =>
      withPoolLock(
        pooledServer.key,
        Effect.sync(() => {
          if (pooledServers.get(pooledServer.key) !== pooledServer) return;
          pooledServer.refCount = Math.max(0, pooledServer.refCount - 1);
        }),
      );

    const closeProcessKeys = (keys: ReadonlySet<string>) =>
      Effect.gen(function* () {
        const exits = yield* Effect.forEach(
          [...keys],
          (key) =>
            Effect.exit(
              withPoolLock(
                key,
                Effect.suspend(() => {
                  const server = pooledServers.get(key);
                  return server ? closePooledServer(server) : Effect.void;
                }),
              ),
            ),
          { concurrency: "unbounded" },
        );
        const failed = exits.filter(Exit.isFailure);
        if (failed.length)
          return yield* new OpenCodeRuntimeError({
            operation: "stopOpenCodeServerProcess",
            detail: "Could not close every owned provider process.",
            cause: failed.map((exit) => exit.cause),
          });
      });
    const stopAll: OpenCodeRuntimeShape["stopAll"] = () =>
      Effect.uninterruptible(
        Effect.suspend(() => {
          stoppingAll++;
          return closeProcessKeys(
            new Set([...pendingServers.keys(), ...pooledServers.keys()]),
          ).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                stoppingAll--;
              }),
            ),
          );
        }),
      );
    const stopAccount: OpenCodeRuntimeShape["stopAccount"] = (connectionId) =>
      Effect.uninterruptible(
        Effect.suspend(() => {
          const keys = new Set<string>();
          for (const [key, pending] of pendingServers)
            if (pending.connectionId === connectionId) keys.add(key);
          for (const [key, server] of pooledServers)
            if (server.connectionIds.has(connectionId)) keys.add(key);
          return closeProcessKeys(keys);
        }),
      );
    yield* Effect.addFinalizer(() =>
      Effect.suspend(() => {
        disposed = true;
        return stopAll().pipe(Effect.orDie);
      }),
    );

    const connectToOpenCodeServer: OpenCodeRuntimeShape["connectToOpenCodeServer"] = (input) => {
      const serverUrl = input.serverUrl?.trim();
      if (serverUrl) {
        return Effect.succeed({
          url: serverUrl,
          exitCode: null,
          external: true,
        });
      }

      return Effect.gen(function* () {
        if (input.processEnv !== undefined && input.poolIsolationKey === undefined) {
          return yield* new OpenCodeRuntimeError({
            operation: "connectToOpenCodeServer",
            detail: "A managed OpenCode environment requires an explicit isolation key.",
          });
        }
        const callerScope = yield* Scope.Scope;
        const pooledServer = yield* acquirePooledServer({
          binaryPath: input.binaryPath,
          ...(input.cliSpec !== undefined ? { cliSpec: input.cliSpec } : {}),
          ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
          ...(input.port !== undefined ? { port: input.port } : {}),
          ...(input.hostname !== undefined ? { hostname: input.hostname } : {}),
          ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
          ...(input.experimentalWebSockets !== undefined
            ? { experimentalWebSockets: input.experimentalWebSockets }
            : {}),
          ...(input.poolIsolationKey !== undefined
            ? { poolIsolationKey: input.poolIsolationKey }
            : {}),
          ...(input.processEnv !== undefined ? { processEnv: input.processEnv } : {}),
          ...(input.connectionId !== undefined ? { connectionId: input.connectionId } : {}),
          ...(input.assertCurrentCredentials !== undefined
            ? { assertCurrentCredentials: input.assertCurrentCredentials }
            : {}),
          ...(input.gateway !== undefined ? { gateway: input.gateway } : {}),
        });
        yield* Scope.addFinalizer(callerScope, releasePooledServer(pooledServer));
        return {
          url: pooledServer.server.url,
          exitCode: pooledServer.server.exitCode,
          external: false,
          ...(pooledServer.gatewayProcessToken === undefined
            ? {}
            : { gatewayProcessToken: pooledServer.gatewayProcessToken }),
        };
      });
    };

    const createOpenCodeSdkClient: OpenCodeRuntimeShape["createOpenCodeSdkClient"] = (input) =>
      createOpencodeClient({
        baseUrl: input.baseUrl,
        directory: input.directory,
        ...(input.serverPassword
          ? {
              headers: {
                Authorization: `Basic ${Buffer.from(`${(input.cliSpec ?? OPENCODE_CLI_SPEC).serverAuthUsername}:${input.serverPassword}`, "utf8").toString("base64")}`,
              },
            }
          : {}),
        throwOnError: true,
      });

    const loadOpenCodeProviderList: OpenCodeRuntimeShape["loadOpenCodeProviderList"] = (client) =>
      runOpenCodeSdk("provider.list", () => client.provider.list()).pipe(
        Effect.filterMapOrFail(
          (list) =>
            list.data
              ? Result.succeed(list.data)
              : Result.fail(
                  new OpenCodeRuntimeError({
                    operation: "provider.list",
                    detail: "OpenCode provider list was empty.",
                  }),
                ),
          (result) => result,
        ),
      );

    const loadOpenCodePaths = (client: OpencodeClient) =>
      runOpenCodeSdk("path.get", () => client.path.get()).pipe(
        Effect.filterMapOrFail(
          (response) =>
            response.data
              ? Result.succeed(response.data as OpenCodePathInfo)
              : Result.fail(
                  new OpenCodeRuntimeError({
                    operation: "path.get",
                    detail: "OpenCode path.get returned no path payload.",
                  }),
                ),
          (result) => result,
        ),
      );

    const loadOpenCodeCredentialProviderIDs: OpenCodeRuntimeShape["loadOpenCodeCredentialProviderIDs"] =
      (client, cliSpec = OPENCODE_CLI_SPEC) =>
        loadOpenCodePaths(client).pipe(
          Effect.flatMap((pathInfo) =>
            Effect.tryPromise({
              try: () => readFile(resolveOpenCodeAuthFilePath(pathInfo, cliSpec), "utf8"),
              catch: (cause) =>
                new OpenCodeRuntimeError({
                  operation: "readOpenCodeCredentialProviderIDs",
                  detail: openCodeRuntimeErrorDetail(cause),
                  cause,
                }),
            }),
          ),
          Effect.flatMap((content) =>
            Effect.try({
              try: () => parseOpenCodeCredentialProviderIDs(content),
              catch: (cause) =>
                new OpenCodeRuntimeError({
                  operation: "parseOpenCodeCredentialProviderIDs",
                  detail: openCodeRuntimeErrorDetail(cause),
                  cause,
                }),
            }),
          ),
          // Explicit credential metadata is optional. Discovery should still work when
          // the auth file does not exist, is unreadable, or belongs to another machine.
          Effect.catch(() => Effect.succeed([])),
        );

    return {
      startOpenCodeServerProcess,
      connectToOpenCodeServer,
      stopAccount,
      stopAll,
      runOpenCodeCommand,
      createOpenCodeSdkClient,
      loadOpenCodeProviderList,
      loadOpenCodeCredentialProviderIDs,
    } satisfies OpenCodeRuntimeShape;
  });

export class OpenCodeRuntime extends ServiceMap.Service<OpenCodeRuntime, OpenCodeRuntimeShape>()(
  "penkra/provider/opencodeRuntime",
) {}

export const makeOpenCodeRuntimeLive = (options?: OpenCodeRuntimeLiveOptions) =>
  Layer.effect(OpenCodeRuntime, makeOpenCodeRuntime(options));

export const OpenCodeRuntimeLive = makeOpenCodeRuntimeLive();
