/**
 * ProviderHealthLive - Cache-backed provider health service.
 *
 * Seeds provider status from disk cache when available, then refreshes from
 * CLI probes without blocking the rest of server startup.
 *
 * Uses effect's ChildProcessSpawner to run CLI probes natively.
 *
 * @module ProviderHealthLive
 */
import * as OS from "node:os";
import type {
  ProviderKind,
  ServerSettings,
  ServerProviderAuthStatus,
  ServerProviderStatus,
  ServerProviderStatusState,
} from "@penkra/contracts";
import { PROVIDER_DISPLAY_NAMES, ServerProviderUpdateError } from "@penkra/contracts";
import { parseCodexConfigModelProvider } from "@penkra/shared/codexConfig";
import { decodeJsonResult } from "@penkra/shared/schemaJson";
import { prepareWindowsSafeProcess } from "@penkra/shared/windowsProcess";
import {
  Array,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Path,
  PubSub,
  Ref,
  Result,
  Schema,
  Scope,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  formatCodexCliUpgradeMessage,
  isCodexCliVersionSupported,
  parseCodexCliVersion,
} from "../codexCliVersion";
import { ServerConfig } from "../../config";
import {
  buildProviderChildEnvironment,
  type ProviderChildKind,
} from "../../providerChildEnvironment.ts";
import { ServerSettingsService } from "../../serverSettings";
import { isWindowsShellCommandMissingResult } from "../../shell-command-detection";
import {
  claudeAuthMetadata,
  isStructuredClaudeAuthFalseNegativeCandidate,
  parseClaudeAuthStatusFromOutput,
} from "../claudeAuthStatus";
import { acquireClaudeAuthStatusLock } from "../claudeAuthStatusLock";
import { buildClaudeProcessEnv, readClaudeCliCredentialsSummary } from "../claudeProcessEnv";
import {
  detailFromResult,
  extractAuthBoolean,
  extractAuthMethod,
  nonEmptyTrimmed,
  PROVIDER_COMMAND_TIMEOUT_DETAIL,
  toTitleCaseWords,
  type CommandResult,
} from "../providerCliOutput";
import { probeProviderCliVersion } from "../providerCliVersionProbe";
import { ProviderHealth, type ProviderHealthShape } from "../Services/ProviderHealth";
import {
  orderProviderStatuses,
  readProviderStatusCache,
  resolveProviderStatusCachePath,
  writeProviderStatusCache,
} from "../providerStatusCache";
import { resolveProviderBinary } from "../managedProviderRuntime";
import { compareSemverVersions, parseGenericCliVersion } from "../providerVersion";
import { resolveManagedProviderArtifact } from "../managedProviderArtifact";
import { buildCodexProcessEnv } from "../../codexProcessEnv.ts";

export { parseClaudeAuthStatusFromOutput } from "../claudeAuthStatus";
export type { CommandResult } from "../providerCliOutput";

const DEFAULT_TIMEOUT_MS = 4_000;
const CLAUDE_HEALTH_TIMEOUT_MS = 20_000;
const OPENCODE_HEALTH_TIMEOUT_MS = 20_000;
const CODEX_PROVIDER = "codex" as const;
const CLAUDE_AGENT_PROVIDER = "claudeAgent" as const;
const OPENCODE_PROVIDER = "opencode" as const;
type ProviderStatuses = ReadonlyArray<ServerProviderStatus>;
const DISABLED_PROVIDER_STATUS_MESSAGE = "Provider is disabled in Penkra settings.";

const PROVIDERS = [
  CODEX_PROVIDER,
  CLAUDE_AGENT_PROVIDER,
  OPENCODE_PROVIDER,
] as const satisfies ReadonlyArray<ProviderKind>;

const providerChildKind = (provider: ProviderKind): ProviderChildKind =>
  provider === CLAUDE_AGENT_PROVIDER ? "claude" : provider;

const providerCommandEnv = (provider: ProviderKind): NodeJS.ProcessEnv =>
  buildProviderChildEnvironment({ provider: providerChildKind(provider) });

// ── Pure helpers ────────────────────────────────────────────────────
//
// Generic CLI-output parsing lives in ../providerCliOutput; Claude auth-status
// interpretation lives in ../claudeAuthStatus.

function resolveVoiceTranscriptionAvailability(
  authMethod: string | undefined,
): boolean | undefined {
  if (!authMethod) {
    return undefined;
  }
  return authMethod === "chatgpt" || authMethod === "chatgptAuthTokens";
}

// ── Subscription type detection ─────────────────────────────────────
//
// Walks arbitrary JSON output from `<provider> auth status` looking for a
// subscription/plan identifier. Used as a best-effort first pass; the SDK
// probe below is the reliable source when available.

const SUBSCRIPTION_TYPE_KEYS = [
  "subscriptionType",
  "subscription_type",
  "plan",
  "tier",
  "planType",
  "plan_type",
] as const;

const SUBSCRIPTION_CONTAINER_KEYS = ["account", "subscription", "user", "billing"] as const;
const AUTH_METHOD_KEYS = ["authMethod", "auth_method"] as const;
const AUTH_METHOD_CONTAINER_KEYS = ["auth", "account", "session"] as const;

const asNonEmptyString = (v: unknown): Option.Option<string> =>
  typeof v === "string" && v.length > 0 ? Option.some(v) : Option.none();

const asRecord = (v: unknown): Option.Option<Record<string, unknown>> =>
  typeof v === "object" && v !== null && !Array.isArray(v)
    ? Option.some(v as Record<string, unknown>)
    : Option.none();

function findSubscriptionType(value: unknown): Option.Option<string> {
  if (Array.isArray(value)) {
    return Option.firstSomeOf(value.map(findSubscriptionType));
  }
  return asRecord(value).pipe(
    Option.flatMap((record) => {
      const direct = Option.firstSomeOf(
        SUBSCRIPTION_TYPE_KEYS.map((key) => asNonEmptyString(record[key])),
      );
      if (Option.isSome(direct)) return direct;
      return Option.firstSomeOf(
        SUBSCRIPTION_CONTAINER_KEYS.map((key) =>
          asRecord(record[key]).pipe(Option.flatMap(findSubscriptionType)),
        ),
      );
    }),
  );
}

function findAuthMethodDeep(value: unknown): Option.Option<string> {
  if (Array.isArray(value)) {
    return Option.firstSomeOf(value.map(findAuthMethodDeep));
  }
  return asRecord(value).pipe(
    Option.flatMap((record) => {
      const direct = Option.firstSomeOf(
        AUTH_METHOD_KEYS.map((key) => asNonEmptyString(record[key])),
      );
      if (Option.isSome(direct)) return direct;
      return Option.firstSomeOf(
        AUTH_METHOD_CONTAINER_KEYS.map((key) =>
          asRecord(record[key]).pipe(Option.flatMap(findAuthMethodDeep)),
        ),
      );
    }),
  );
}

const decodeUnknownJson = decodeJsonResult(Schema.Unknown);

function extractSubscriptionTypeFromOutput(result: CommandResult): string | undefined {
  const parsed = decodeUnknownJson(result.stdout.trim());
  if (Result.isFailure(parsed)) return undefined;
  return Option.getOrUndefined(findSubscriptionType(parsed.success));
}

function extractClaudeAuthMethodFromOutput(result: CommandResult): string | undefined {
  const parsed = decodeUnknownJson(result.stdout.trim());
  if (Result.isFailure(parsed)) return undefined;
  return Option.getOrUndefined(findAuthMethodDeep(parsed.success));
}

// ── Codex subscription label ────────────────────────────────────────

type CodexPlanTypeLiteral =
  | "free"
  | "go"
  | "plus"
  | "pro"
  | "team"
  | "business"
  | "enterprise"
  | "edu"
  | "self_serve_business_usage_based"
  | "enterprise_cbp_usage_based"
  | "unknown";

function codexAccountAuthLabel(input: {
  readonly type: string | undefined;
  readonly planType: string | undefined;
}): string | undefined {
  if (input.type === "apiKey") return "OpenAI API Key";
  if (!input.planType) return undefined;
  switch (input.planType as CodexPlanTypeLiteral) {
    case "free":
      return "ChatGPT Free Subscription";
    case "go":
      return "ChatGPT Go Subscription";
    case "plus":
      return "ChatGPT Plus Subscription";
    case "pro":
      return "ChatGPT Pro Subscription";
    case "team":
      return "ChatGPT Team Subscription";
    case "self_serve_business_usage_based":
    case "business":
      return "ChatGPT Business Subscription";
    case "enterprise_cbp_usage_based":
    case "enterprise":
      return "ChatGPT Enterprise Subscription";
    case "edu":
      return "ChatGPT Edu Subscription";
    case "unknown":
      return "ChatGPT Subscription";
    default:
      return toTitleCaseWords(input.planType);
  }
}

function extractCodexAccountTypeFromOutput(result: CommandResult): string | undefined {
  const parsed = decodeUnknownJson(result.stdout.trim());
  if (Result.isFailure(parsed)) return undefined;
  const walk = (value: unknown): string | undefined => {
    if (Array.isArray(value)) {
      for (const entry of value) {
        const nested = walk(entry);
        if (nested) return nested;
      }
      return undefined;
    }
    const record = Option.getOrUndefined(asRecord(value));
    if (!record) return undefined;
    const direct = Option.getOrUndefined(
      Option.firstSomeOf(["type", "accountType"].map((key) => asNonEmptyString(record[key]))),
    );
    if (direct) return direct;
    for (const key of ["account", "session", "auth"] as const) {
      const nested = walk(record[key]);
      if (nested) return nested;
    }
    return undefined;
  };
  return walk(parsed.success);
}

export function parseAuthStatusFromOutput(result: CommandResult): {
  readonly status: ServerProviderStatusState;
  readonly authStatus: ServerProviderAuthStatus;
  readonly voiceTranscriptionAvailable?: boolean;
  readonly message?: string;
} {
  const lowerOutput = `${result.stdout}\n${result.stderr}`.toLowerCase();

  if (
    lowerOutput.includes("unknown command") ||
    lowerOutput.includes("unrecognized command") ||
    lowerOutput.includes("unexpected argument")
  ) {
    return {
      status: "warning",
      authStatus: "unknown",
      message: "Codex CLI authentication status command is unavailable in this Codex version.",
    };
  }

  if (
    lowerOutput.includes("not logged in") ||
    lowerOutput.includes("login required") ||
    lowerOutput.includes("authentication required") ||
    lowerOutput.includes("run `codex login`") ||
    lowerOutput.includes("run codex login")
  ) {
    return {
      status: "error",
      authStatus: "unauthenticated",
      message: "Codex CLI is not authenticated. Run `codex login` and try again.",
    };
  }

  const parsedAuth = (() => {
    const trimmed = result.stdout.trim();
    if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) {
      return {
        attemptedJsonParse: false as const,
        auth: undefined as boolean | undefined,
        authMethod: undefined as string | undefined,
      };
    }
    try {
      const parsed = JSON.parse(trimmed);
      return {
        attemptedJsonParse: true as const,
        auth: extractAuthBoolean(parsed),
        authMethod: extractAuthMethod(parsed),
      };
    } catch {
      return {
        attemptedJsonParse: false as const,
        auth: undefined as boolean | undefined,
        authMethod: undefined as string | undefined,
      };
    }
  })();

  if (parsedAuth.auth === true) {
    const voiceTranscriptionAvailable = resolveVoiceTranscriptionAvailability(
      parsedAuth.authMethod,
    );
    return {
      status: "ready",
      authStatus: "authenticated",
      ...(voiceTranscriptionAvailable !== undefined ? { voiceTranscriptionAvailable } : {}),
    };
  }
  if (parsedAuth.auth === false) {
    return {
      status: "error",
      authStatus: "unauthenticated",
      message: "Codex CLI is not authenticated. Run `codex login` and try again.",
    };
  }
  if (parsedAuth.attemptedJsonParse) {
    return {
      status: "warning",
      authStatus: "unknown",
      message:
        "Could not verify Codex authentication status from JSON output (missing auth marker).",
    };
  }
  if (result.code === 0) {
    return { status: "ready", authStatus: "authenticated" };
  }

  const detail = detailFromResult(result);
  return {
    status: "warning",
    authStatus: "unknown",
    message: detail
      ? `Could not verify Codex authentication status. ${detail}`
      : "Could not verify Codex authentication status.",
  };
}

// ── Codex CLI config detection ──────────────────────────────────────

/**
 * Providers that use OpenAI-native authentication via `codex login`.
 * When the configured `model_provider` is one of these, the `codex login
 * status` probe still runs. For any other provider value the auth probe
 * is skipped because authentication is handled externally (e.g. via
 * environment variables like `PORTKEY_API_KEY` or `AZURE_API_KEY`).
 */
const OPENAI_AUTH_PROVIDERS = new Set(["openai"]);

/**
 * Read the `model_provider` value from the Codex CLI config file.
 *
 * Looks for the file at `$CODEX_HOME/config.toml` (falls back to
 * `~/.codex/config.toml`). Uses a simple line-by-line scan rather than
 * a full TOML parser to avoid adding a dependency for a single key.
 *
 * Returns `undefined` when the file does not exist or does not set
 * `model_provider`.
 */
export const readCodexConfigModelProvider = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const codexHome = process.env.CODEX_HOME || path.join(OS.homedir(), ".codex");
  const configPath = path.join(codexHome, "config.toml");

  const content = yield* fileSystem
    .readFileString(configPath)
    .pipe(Effect.orElseSucceed(() => undefined));
  if (content === undefined) {
    return undefined;
  }

  return parseCodexConfigModelProvider(content);
});

/**
 * Returns `true` when the Codex CLI is configured with a custom
 * (non-OpenAI) model provider, meaning `codex login` auth is not
 * required because authentication is handled through provider-specific
 * environment variables.
 */
export const hasCustomModelProvider = Effect.map(
  readCodexConfigModelProvider,
  (provider) => provider !== undefined && !OPENAI_AUTH_PROVIDERS.has(provider),
);

// ── Effect-native command execution ─────────────────────────────────

const collectStreamAsString = <E>(stream: Stream.Stream<Uint8Array, E>): Effect.Effect<string, E> =>
  Stream.runFold(
    stream,
    () => "",
    (acc, chunk) => acc + new TextDecoder().decode(chunk),
  );

const runProviderCommand = (
  executable: string,
  args: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const prepared = prepareWindowsSafeProcess(executable, args, { env });
    const command = ChildProcess.make(prepared.command, prepared.args, {
      shell: prepared.shell,
      ...(prepared.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
      env,
      // Health probes are non-interactive. Leaving stdin as a pipe can keep CLIs
      // waiting even after a read-only subcommand has finished.
      stdin: "ignore",
    });

    const child = yield* spawner.spawn(command);

    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        collectStreamAsString(child.stdout),
        collectStreamAsString(child.stderr),
        child.exitCode.pipe(Effect.map(Number)),
      ],
      { concurrency: "unbounded" },
    );

    return { stdout, stderr, code: exitCode } satisfies CommandResult;
  }).pipe(Effect.scoped);

const runCodexCommand = (
  args: ReadonlyArray<string>,
  executable = "codex",
  env: NodeJS.ProcessEnv = providerCommandEnv(CODEX_PROVIDER),
) =>
  runProviderCommand(executable, args, env).pipe(
    Effect.flatMap((result) =>
      isWindowsShellCommandMissingResult({ code: result.code, stderr: result.stderr })
        ? Effect.fail(new Error(`spawn ${executable} ENOENT`))
        : Effect.succeed(result),
    ),
  );

const runClaudeCommand = (
  args: ReadonlyArray<string>,
  executable = "claude",
  env: NodeJS.ProcessEnv = buildClaudeProcessEnv(),
) =>
  runProviderCommand(executable, args, env).pipe(
    Effect.flatMap((result) =>
      isWindowsShellCommandMissingResult({ code: result.code, stderr: result.stderr })
        ? Effect.fail(new Error(`spawn ${executable} ENOENT`))
        : Effect.succeed(result),
    ),
  );

const runOpenCodeCommand = (args: ReadonlyArray<string>, executable = "opencode") =>
  runProviderCommand(executable, args, providerCommandEnv(OPENCODE_PROVIDER)).pipe(
    Effect.flatMap((result) =>
      isWindowsShellCommandMissingResult({ code: result.code, stderr: result.stderr })
        ? Effect.fail(new Error(`spawn ${executable} ENOENT`))
        : Effect.succeed(result),
    ),
  );

// ── Health check ────────────────────────────────────────────────────

async function makeCodexProbeEnv(homePath?: string): Promise<NodeJS.ProcessEnv> {
  const normalizedHomePath = nonEmptyTrimmed(homePath);
  return buildCodexProcessEnv({
    ...(normalizedHomePath ? { homePath: normalizedHomePath } : {}),
  });
}

const readCodexConfigModelProviderForEnv = (env: NodeJS.ProcessEnv) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const codexHome = env.CODEX_HOME?.trim() || path.join(OS.homedir(), ".codex");
    const configPath = path.join(codexHome, "config.toml");

    const content = yield* fileSystem
      .readFileString(configPath)
      .pipe(Effect.orElseSucceed(() => undefined));
    if (content === undefined) {
      return undefined;
    }

    return parseCodexConfigModelProvider(content);
  });

const hasCustomModelProviderForEnv = (env: NodeJS.ProcessEnv) =>
  Effect.map(
    readCodexConfigModelProviderForEnv(env),
    (provider) => provider !== undefined && !OPENAI_AUTH_PROVIDERS.has(provider),
  );

export const makeCheckCodexProviderStatus = (
  binaryPath?: string,
  homePath?: string,
): Effect.Effect<
  ServerProviderStatus,
  never,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const checkedAt = new Date().toISOString();
    const executable = nonEmptyTrimmed(binaryPath) ?? "codex";
    const probeEnv = yield* Effect.promise(() => makeCodexProbeEnv(homePath));

    // Probe 1: `codex --version` — is the CLI reachable?
    const versionProbe = yield* probeProviderCliVersion(
      runCodexCommand(["--version"], executable, probeEnv),
      DEFAULT_TIMEOUT_MS,
    );

    if (versionProbe.outcome === "missing" || versionProbe.outcome === "failure") {
      const error = versionProbe.cause;
      return {
        provider: CODEX_PROVIDER,
        status: "error" as const,
        available: false,
        authStatus: "unknown" as const,
        checkedAt,
        message:
          versionProbe.outcome === "missing"
            ? "Codex CLI (`codex`) is not installed or not on PATH."
            : `Failed to execute Codex CLI health check: ${error instanceof Error ? error.message : String(error)}.`,
      };
    }

    if (versionProbe.outcome === "timeout") {
      return {
        provider: CODEX_PROVIDER,
        status: "error" as const,
        available: false,
        authStatus: "unknown" as const,
        checkedAt,
        message: "Codex CLI is installed but failed to run. Timed out while running command.",
      };
    }

    if (versionProbe.outcome === "nonzero") {
      const version = versionProbe.result;
      const detail = detailFromResult(version);
      return {
        provider: CODEX_PROVIDER,
        status: "error" as const,
        available: false,
        authStatus: "unknown" as const,
        checkedAt,
        message: detail
          ? `Codex CLI is installed but failed to run. ${detail}`
          : "Codex CLI is installed but failed to run.",
      };
    }
    const version = versionProbe.result;

    const parsedVersion = parseCodexCliVersion(`${version.stdout}\n${version.stderr}`);
    if (parsedVersion && !isCodexCliVersionSupported(parsedVersion)) {
      return {
        provider: CODEX_PROVIDER,
        status: "error" as const,
        available: false,
        authStatus: "unknown" as const,
        checkedAt,
        message: formatCodexCliUpgradeMessage(parsedVersion),
      };
    }

    // Probe 2: `codex login status` — is the user authenticated?
    //
    // Custom model providers (e.g. Portkey, Azure OpenAI proxy) handle
    // authentication through their own environment variables, so `codex
    // login status` will report "not logged in" even when the CLI works
    // fine.  Skip the auth probe entirely for non-OpenAI providers.
    if (yield* hasCustomModelProviderForEnv(probeEnv)) {
      return {
        provider: CODEX_PROVIDER,
        status: "ready" as const,
        available: true,
        authStatus: "unknown" as const,
        version: parsedVersion,
        checkedAt,
        message: "Using a custom Codex model provider; OpenAI login check skipped.",
      } satisfies ServerProviderStatus;
    }

    const authProbe = yield* runCodexCommand(["login", "status"], executable, probeEnv).pipe(
      Effect.timeoutOption(DEFAULT_TIMEOUT_MS),
      Effect.result,
    );

    if (Result.isFailure(authProbe)) {
      const error = authProbe.failure;
      return {
        provider: CODEX_PROVIDER,
        status: "warning" as const,
        available: true,
        authStatus: "unknown" as const,
        version: parsedVersion,
        checkedAt,
        message:
          error instanceof Error
            ? `Could not verify Codex authentication status: ${error.message}.`
            : "Could not verify Codex authentication status.",
      };
    }

    if (Option.isNone(authProbe.success)) {
      return {
        provider: CODEX_PROVIDER,
        status: "warning" as const,
        available: true,
        authStatus: "unknown" as const,
        version: parsedVersion,
        checkedAt,
        message: "Could not verify Codex authentication status. Timed out while running command.",
      };
    }

    const authOutput = authProbe.success.value;
    const parsed = parseAuthStatusFromOutput(authOutput);
    const codexPlanType = extractSubscriptionTypeFromOutput(authOutput);
    const codexAccountType = extractCodexAccountTypeFromOutput(authOutput);
    const codexLabel =
      parsed.authStatus === "authenticated"
        ? codexAccountAuthLabel({ type: codexAccountType, planType: codexPlanType })
        : undefined;
    const codexAuthType =
      parsed.authStatus === "authenticated"
        ? codexAccountType === "apiKey"
          ? "apiKey"
          : codexPlanType
        : undefined;

    return {
      provider: CODEX_PROVIDER,
      status: parsed.status,
      available: true,
      authStatus: parsed.authStatus,
      version: parsedVersion,
      ...(codexAuthType ? { authType: codexAuthType } : {}),
      ...(codexLabel ? { authLabel: codexLabel } : {}),
      ...(parsed.voiceTranscriptionAvailable !== undefined
        ? { voiceTranscriptionAvailable: parsed.voiceTranscriptionAvailable }
        : {}),
      checkedAt,
      ...(parsed.message ? { message: parsed.message } : {}),
    } satisfies ServerProviderStatus;
  });

export const checkCodexProviderStatus = makeCheckCodexProviderStatus();

/**
 * Production readiness for a managed harness is deliberately installation-only.
 * Authentication belongs to an isolated Connection profile; probing the process
 * user's global provider home here would collapse every Connection into one
 * misleading account status.
 */
const makeCheckManagedProviderInstallationStatus = (
  provider: typeof CODEX_PROVIDER | typeof CLAUDE_AGENT_PROVIDER | typeof OPENCODE_PROVIDER,
  binaryPath: string,
): Effect.Effect<ServerProviderStatus, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const checkedAt = new Date().toISOString();
    const result = yield* probeProviderCliVersion(
      runProviderCommand(binaryPath, ["--version"], providerCommandEnv(provider)),
      provider === OPENCODE_PROVIDER ? OPENCODE_HEALTH_TIMEOUT_MS : DEFAULT_TIMEOUT_MS,
    );
    if (result.outcome !== "success") {
      const detail =
        result.outcome === "timeout"
          ? PROVIDER_COMMAND_TIMEOUT_DETAIL
          : result.outcome === "missing"
            ? "The managed executable is missing."
            : result.outcome === "nonzero"
              ? detailFromResult(result.result)
              : result.cause instanceof Error
                ? result.cause.message
                : String(result.cause);
      return {
        provider,
        status: "error",
        available: false,
        authStatus: "unknown",
        checkedAt,
        message: `The managed ${PROVIDER_DISPLAY_NAMES[provider]} runtime could not start.${detail ? ` ${detail}` : ""}`,
      };
    }

    const output = `${result.result.stdout}\n${result.result.stderr}`;
    const version =
      provider === CODEX_PROVIDER ? parseCodexCliVersion(output) : parseGenericCliVersion(output);
    if (provider === CODEX_PROVIDER && version && !isCodexCliVersionSupported(version)) {
      return {
        provider,
        status: "error",
        available: false,
        authStatus: "unknown",
        version,
        checkedAt,
        message: formatCodexCliUpgradeMessage(version),
      };
    }
    return {
      provider,
      status: "ready",
      available: true,
      authStatus: "unknown",
      ...(version ? { version } : {}),
      checkedAt,
    };
  });

// ── Claude Agent health check ───────────────────────────────────────

const CLAUDE_AUTH_FALSE_NEGATIVE_RETRY_DELAY_MS = 1_000;

export const makeCheckClaudeProviderStatus = (
  resolveSubscriptionType?: Effect.Effect<string | undefined>,
  binaryPath?: string,
  homeDir?: string,
  options?: { readonly falseNegativeRetryDelayMs?: number },
): Effect.Effect<ServerProviderStatus, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const checkedAt = new Date().toISOString();
    const executable = nonEmptyTrimmed(binaryPath) ?? "claude";
    const claudeEnv = buildClaudeProcessEnv(
      homeDir ? { env: process.env, homeDir } : { env: process.env },
    );

    // Probe 1: `claude --version` — is the CLI reachable?
    const versionProbe = yield* probeProviderCliVersion(
      runClaudeCommand(["--version"], executable, claudeEnv),
      CLAUDE_HEALTH_TIMEOUT_MS,
    );

    if (versionProbe.outcome === "missing" || versionProbe.outcome === "failure") {
      const error = versionProbe.cause;
      return {
        provider: CLAUDE_AGENT_PROVIDER,
        status: "error" as const,
        available: false,
        authStatus: "unknown" as const,
        checkedAt,
        message:
          versionProbe.outcome === "missing"
            ? "Claude Agent CLI (`claude`) is not installed or not on PATH."
            : `Failed to execute Claude Agent CLI health check: ${error instanceof Error ? error.message : String(error)}.`,
      };
    }

    if (versionProbe.outcome === "timeout") {
      return {
        provider: CLAUDE_AGENT_PROVIDER,
        status: "error" as const,
        available: false,
        authStatus: "unknown" as const,
        checkedAt,
        message:
          "Claude Agent CLI is installed but failed to run. Timed out while running command.",
      };
    }

    if (versionProbe.outcome === "nonzero") {
      const version = versionProbe.result;
      const detail = detailFromResult(version);
      return {
        provider: CLAUDE_AGENT_PROVIDER,
        status: "error" as const,
        available: false,
        authStatus: "unknown" as const,
        checkedAt,
        message: detail
          ? `Claude Agent CLI is installed but failed to run. ${detail}`
          : "Claude Agent CLI is installed but failed to run.",
      };
    }
    const version = versionProbe.result;
    const parsedVersion = parseGenericCliVersion(`${version.stdout}\n${version.stderr}`);

    // Probe 2: `claude auth status` — is the user authenticated? The command can
    // redeem a single-use rotating OAuth refresh token, so it is serialized with
    // every other `claude auth status` invocation in this process (credential
    // keepalive, concurrent health probes) via the shared lock.
    const runAuthStatusProbe = Effect.acquireUseRelease(
      Effect.promise(() => acquireClaudeAuthStatusLock()),
      () =>
        runClaudeCommand(["auth", "status"], executable, claudeEnv).pipe(
          Effect.timeoutOption(CLAUDE_HEALTH_TIMEOUT_MS),
        ),
      (release) => Effect.sync(release),
    ).pipe(Effect.result);

    const authProbe = yield* runAuthStatusProbe;

    if (Result.isFailure(authProbe)) {
      const error = authProbe.failure;
      return {
        provider: CLAUDE_AGENT_PROVIDER,
        status: "warning" as const,
        available: true,
        authStatus: "unknown" as const,
        version: parsedVersion,
        checkedAt,
        message:
          error instanceof Error
            ? `Could not verify Claude authentication status: ${error.message}.`
            : "Could not verify Claude authentication status.",
      };
    }

    if (Option.isNone(authProbe.success)) {
      return {
        provider: CLAUDE_AGENT_PROVIDER,
        status: "warning" as const,
        available: true,
        authStatus: "unknown" as const,
        version: parsedVersion,
        checkedAt,
        message: "Could not verify Claude authentication status. Timed out while running command.",
      };
    }

    let authOutput = authProbe.success.value;
    let parsed = parseClaudeAuthStatusFromOutput(authOutput);
    const credentialSummary = readClaudeCliCredentialsSummary(
      homeDir ? { env: claudeEnv, homeDir } : { env: claudeEnv },
    );
    // A structured `loggedIn:false` with a clean exit and no local credential
    // record to rescue it (macOS keeps OAuth in the Keychain, not on disk) is
    // the signature of a lost refresh-token rotation race with a concurrent
    // `claude auth status` invocation. Re-probe once after the rotation settles.
    if (
      !credentialSummary.usable &&
      isStructuredClaudeAuthFalseNegativeCandidate(authOutput, parsed)
    ) {
      const retryDelayMs =
        options?.falseNegativeRetryDelayMs ?? CLAUDE_AUTH_FALSE_NEGATIVE_RETRY_DELAY_MS;
      if (retryDelayMs > 0) {
        yield* Effect.sleep(retryDelayMs);
      }
      const retryProbe = yield* runAuthStatusProbe;
      if (Result.isSuccess(retryProbe) && Option.isSome(retryProbe.success)) {
        authOutput = retryProbe.success.value;
        parsed = parseClaudeAuthStatusFromOutput(authOutput);
      }
    }
    const structuredFalseNegative = isStructuredClaudeAuthFalseNegativeCandidate(
      authOutput,
      parsed,
    );
    const credentialProbeSubscriptionType =
      credentialSummary.usable && structuredFalseNegative && resolveSubscriptionType
        ? yield* resolveSubscriptionType
        : undefined;
    // Claude 2.1.x can report `loggedIn:false` from `auth status` while a live
    // SDK init still reads account metadata. Token strings alone are not enough:
    // require the SDK probe before treating the credential file as authenticated.
    const effectiveParsed: ReturnType<typeof parseClaudeAuthStatusFromOutput> =
      credentialProbeSubscriptionType !== undefined
        ? { status: "ready", authStatus: "authenticated" }
        : parsed;
    const useCredentialMetadata = credentialProbeSubscriptionType !== undefined;

    // Determine subscription type from multiple sources (cheapest first):
    // 1. JSON output of `claude auth status` (may or may not contain it)
    // 2. Cached SDK probe (spawns a Claude process on miss, reads
    //    `initializationResult()` for account metadata, then aborts
    //    immediately — no API tokens are consumed)
    let subscriptionType =
      extractSubscriptionTypeFromOutput(authOutput) ??
      credentialProbeSubscriptionType ??
      (useCredentialMetadata ? credentialSummary.subscriptionType : undefined);
    const authMethod =
      extractClaudeAuthMethodFromOutput(authOutput) ??
      (useCredentialMetadata ? "claude.ai" : undefined);
    if (
      !subscriptionType &&
      resolveSubscriptionType &&
      effectiveParsed.authStatus === "authenticated"
    ) {
      subscriptionType = yield* resolveSubscriptionType;
    }
    const authMetadata = claudeAuthMetadata({ subscriptionType, authMethod });

    return {
      provider: CLAUDE_AGENT_PROVIDER,
      status: effectiveParsed.status,
      available: true,
      authStatus: effectiveParsed.authStatus,
      version: parsedVersion,
      ...(authMetadata ? { authType: authMetadata.type, authLabel: authMetadata.label } : {}),
      checkedAt,
      ...(effectiveParsed.message ? { message: effectiveParsed.message } : {}),
    } satisfies ServerProviderStatus;
  });

export const checkClaudeProviderStatus = makeCheckClaudeProviderStatus();

export const makeCheckOpenCodeProviderStatus = (
  binaryPath?: string,
): Effect.Effect<ServerProviderStatus, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const checkedAt = new Date().toISOString();
    const executable = nonEmptyTrimmed(binaryPath) ?? "opencode";

    const versionProbe = yield* probeProviderCliVersion(
      runOpenCodeCommand(["--version"], executable),
      OPENCODE_HEALTH_TIMEOUT_MS,
    );

    if (versionProbe.outcome === "missing" || versionProbe.outcome === "failure") {
      const error = versionProbe.cause;
      return {
        provider: OPENCODE_PROVIDER,
        status: "error" as const,
        available: false,
        authStatus: "unknown" as const,
        checkedAt,
        message:
          versionProbe.outcome === "missing"
            ? "OpenCode CLI (`opencode`) is not installed or not on PATH."
            : `Failed to execute OpenCode CLI health check: ${error instanceof Error ? error.message : String(error)}.`,
      } satisfies ServerProviderStatus;
    }

    if (versionProbe.outcome === "timeout") {
      return {
        provider: OPENCODE_PROVIDER,
        status: "error" as const,
        available: false,
        authStatus: "unknown" as const,
        checkedAt,
        message: `OpenCode CLI is installed but failed to run. ${PROVIDER_COMMAND_TIMEOUT_DETAIL}`,
      } satisfies ServerProviderStatus;
    }

    if (versionProbe.outcome === "nonzero") {
      const version = versionProbe.result;
      const detail = detailFromResult(version);
      return {
        provider: OPENCODE_PROVIDER,
        status: "error" as const,
        available: false,
        authStatus: "unknown" as const,
        checkedAt,
        message: detail
          ? `OpenCode CLI is installed but failed to run. ${detail}`
          : "OpenCode CLI is installed but failed to run.",
      } satisfies ServerProviderStatus;
    }
    const version = versionProbe.result;
    const parsedVersion = parseGenericCliVersion(`${version.stdout}\n${version.stderr}`);

    return {
      provider: OPENCODE_PROVIDER,
      status: "ready" as const,
      available: true,
      authStatus: "unknown" as const,
      version: parsedVersion,
      checkedAt,
      message:
        "OpenCode CLI is installed. Configure provider credentials inside OpenCode as needed.",
    } satisfies ServerProviderStatus;
  });

export const checkOpenCodeProviderStatus = makeCheckOpenCodeProviderStatus();

// ── Snapshot helpers ────────────────────────────────────────────────

function comparableProviderVersionAdvisory(
  advisory: ServerProviderStatus["versionAdvisory"] | undefined,
): Omit<NonNullable<ServerProviderStatus["versionAdvisory"]>, "checkedAt"> | null {
  if (!advisory) {
    return null;
  }
  const { checkedAt: _checkedAt, ...comparableAdvisory } = advisory;
  return comparableAdvisory;
}

export function providerStatusesEqual(
  left: ReadonlyArray<ServerProviderStatus>,
  right: ReadonlyArray<ServerProviderStatus>,
): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((status, index) => {
    const next = right[index];
    return (
      next !== undefined &&
      status.provider === next.provider &&
      status.status === next.status &&
      status.available === next.available &&
      status.authStatus === next.authStatus &&
      (status.authType ?? null) === (next.authType ?? null) &&
      (status.authLabel ?? null) === (next.authLabel ?? null) &&
      status.voiceTranscriptionAvailable === next.voiceTranscriptionAvailable &&
      (status.version ?? null) === (next.version ?? null) &&
      (status.message ?? null) === (next.message ?? null) &&
      JSON.stringify(comparableProviderVersionAdvisory(status.versionAdvisory)) ===
        JSON.stringify(comparableProviderVersionAdvisory(next.versionAdvisory)) &&
      JSON.stringify(status.updateState ?? null) === JSON.stringify(next.updateState ?? null)
    );
  });
}

function isTransientProviderCommandTimeout(status: ServerProviderStatus): boolean {
  return (
    status.status !== "ready" &&
    status.authStatus === "unknown" &&
    (status.message ?? "").includes(PROVIDER_COMMAND_TIMEOUT_DETAIL)
  );
}

function wasPreviouslyUsableProviderStatus(status: ServerProviderStatus): boolean {
  return status.available && status.status === "ready";
}

export function stabilizeProviderStatusesAgainstTransientTimeouts(
  previousStatuses: ReadonlyArray<ServerProviderStatus>,
  nextStatuses: ReadonlyArray<ServerProviderStatus>,
): ReadonlyArray<ServerProviderStatus> {
  if (previousStatuses.length === 0) {
    return nextStatuses;
  }

  const previousByProvider = new Map(
    previousStatuses.map((status) => [status.provider, status] as const),
  );

  return nextStatuses.map((status) => {
    const previous = previousByProvider.get(status.provider);
    if (
      !previous ||
      !wasPreviouslyUsableProviderStatus(previous) ||
      !isTransientProviderCommandTimeout(status)
    ) {
      return status;
    }

    // A single slow CLI probe should not make an already usable provider look broken.
    return {
      ...previous,
      checkedAt: status.checkedAt,
      ...(status.updateState !== undefined ? { updateState: status.updateState } : {}),
    };
  });
}

export function isProviderEnabledForSettings(
  provider: ProviderKind,
  settings: ServerSettings,
): boolean {
  return (
    settings.providers[provider]?.enabled !== false && settings.providers[provider] !== undefined
  );
}

export function makeDisabledProviderStatus(
  provider: ProviderKind,
  checkedAt = new Date().toISOString(),
): ServerProviderStatus {
  return {
    provider,
    status: "warning" as const,
    available: false,
    authStatus: "unknown" as const,
    checkedAt,
    message: DISABLED_PROVIDER_STATUS_MESSAGE,
  } satisfies ServerProviderStatus;
}

function makeMissingManagedRuntimeStatus(
  provider: ProviderKind,
  checkedAt = new Date().toISOString(),
): ServerProviderStatus {
  return {
    provider,
    status: "warning",
    available: false,
    authStatus: "unknown",
    checkedAt,
    message: "Provider runtime is not installed.",
  } satisfies ServerProviderStatus;
}

function isDisabledProviderStatusOverlay(status: ServerProviderStatus): boolean {
  return status.message === DISABLED_PROVIDER_STATUS_MESSAGE && status.available === false;
}

function mergeProviderStatusUpdates(
  previousStatuses: ReadonlyArray<ServerProviderStatus>,
  updatedStatuses: ReadonlyArray<ServerProviderStatus>,
): ProviderStatuses {
  const statusByProvider = new Map(
    previousStatuses.map((status) => [status.provider, status] as const),
  );
  for (const status of updatedStatuses) {
    statusByProvider.set(status.provider, status);
  }
  return orderProviderStatuses([...statusByProvider.values()]);
}

// Keeps local CLI version/status visible while removing network-backed update metadata.
function makeSuppressedProviderVersionAdvisory(
  status: ServerProviderStatus,
  currentVersion?: string | null,
): NonNullable<ServerProviderStatus["versionAdvisory"]> {
  return {
    status: "unknown",
    currentVersion: currentVersion ?? status.version ?? null,
    latestVersion: null,
    updateCommand: null,
    canUpdate: false,
    checkedAt: status.checkedAt,
    message: null,
  };
}

// Disabled providers are a settings overlay, not a probe result. Keep the raw
// cached/probed status intact so re-enabling a provider can reuse it immediately.
export function projectProviderStatusesForSettings(
  statuses: ReadonlyArray<ServerProviderStatus>,
  settings: ServerSettings,
  checkedAt = new Date().toISOString(),
): ProviderStatuses {
  const statusByProvider = new Map(statuses.map((status) => [status.provider, status] as const));
  const projected: ServerProviderStatus[] = [];

  for (const provider of PROVIDERS) {
    const status = statusByProvider.get(provider);
    if (!isProviderEnabledForSettings(provider, settings)) {
      const disabledStatus = makeDisabledProviderStatus(provider, status?.checkedAt ?? checkedAt);
      const disabledStatusWithAdvisory = {
        ...disabledStatus,
        versionAdvisory: makeSuppressedProviderVersionAdvisory(disabledStatus, status?.version),
      } satisfies ServerProviderStatus;
      projected.push(
        status?.updateState
          ? { ...disabledStatusWithAdvisory, updateState: status.updateState }
          : disabledStatusWithAdvisory,
      );
      continue;
    }

    if (status && !isDisabledProviderStatusOverlay(status)) {
      projected.push(status);
    }
  }

  return orderProviderStatuses(projected);
}

// ── Layer ───────────────────────────────────────────────────────────

export function makeProviderHealthLive() {
  return Layer.effect(
    ProviderHealth,
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const serverConfig = yield* ServerConfig;
      const serverSettings = yield* ServerSettingsService;
      const changesPubSub = yield* Effect.acquireRelease(
        PubSub.unbounded<ReadonlyArray<ServerProviderStatus>>(),
        PubSub.shutdown,
      );
      const refreshScope = yield* Scope.make("sequential");
      yield* Effect.addFinalizer(() => Scope.close(refreshScope, Exit.void));

      const cachePathByProvider = new Map(
        PROVIDERS.map(
          (provider) =>
            [
              provider,
              resolveProviderStatusCachePath({
                stateDir: serverConfig.stateDir,
                provider,
              }),
            ] as const,
        ),
      );

      const cachedStatuses: ProviderStatuses = yield* Effect.forEach(
        PROVIDERS,
        (provider) =>
          readProviderStatusCache(cachePathByProvider.get(provider)!).pipe(
            Effect.provideService(FileSystem.FileSystem, fileSystem),
          ),
        { concurrency: "unbounded" },
      ).pipe(
        Effect.map((statuses) =>
          orderProviderStatuses(
            statuses.filter(
              (status): status is ServerProviderStatus =>
                status !== undefined && !isDisabledProviderStatusOverlay(status),
            ),
          ),
        ),
      );

      const statusesRef = yield* Ref.make<ProviderStatuses>(cachedStatuses);
      const refreshFiberRef = yield* Ref.make<Fiber.Fiber<ProviderStatuses, never> | null>(null);

      const getProviderBinaryPath = (provider: ProviderKind) =>
        resolveProviderBinary({
          stateDir: serverConfig.stateDir,
          provider,
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
          Effect.map((resolution) => resolution.binaryPath),
        );

      const applyVolatileProviderState = (status: ServerProviderStatus) => {
        const { updateState: _obsoleteUpdateState, ...statusWithoutUpdateState } = status;
        return Effect.succeed(statusWithoutUpdateState);
      };

      const projectStatusesForCurrentSettings = Effect.fn(
        "projectProviderStatusesForCurrentSettings",
      )(function* (statuses: ReadonlyArray<ServerProviderStatus>) {
        return yield* serverSettings.getSettings.pipe(
          Effect.map((settings) => projectProviderStatusesForSettings(statuses, settings)),
          Effect.catch(() => Effect.succeed(statuses)),
          Effect.flatMap((projected) =>
            Effect.forEach(projected, applyVolatileProviderState, {
              concurrency: "unbounded",
            }),
          ),
        );
      });

      const publishProjectedStatuses = Effect.fn("publishProjectedProviderStatuses")(function* () {
        const rawStatuses = yield* Ref.get(statusesRef);
        const projectedStatuses = yield* projectStatusesForCurrentSettings(rawStatuses);
        yield* PubSub.publish(changesPubSub, projectedStatuses);
        return projectedStatuses;
      });

      const enrichStatuses = Effect.fn("enrichProviderStatuses")(function* (
        statuses: ReadonlyArray<ServerProviderStatus>,
      ) {
        yield* serverSettings.ready.pipe(Effect.catch(() => Effect.void));
        const enriched = yield* Effect.forEach(
          statuses,
          (status) => {
            const currentVersion = status.version ?? null;
            if (
              currentVersion === null ||
              (status.provider !== CODEX_PROVIDER &&
                status.provider !== CLAUDE_AGENT_PROVIDER &&
                status.provider !== OPENCODE_PROVIDER)
            ) {
              return Effect.succeed({
                ...status,
                versionAdvisory: makeSuppressedProviderVersionAdvisory(status),
              });
            }
            return resolveManagedProviderArtifact({
              provider: status.provider,
              version: "latest",
            }).pipe(
              Effect.map((artifact) => {
                const behind = compareSemverVersions(currentVersion, artifact.version) < 0;
                return {
                  ...status,
                  versionAdvisory: {
                    status: behind ? ("behind_latest" as const) : ("current" as const),
                    currentVersion,
                    latestVersion: artifact.version,
                    updateCommand: null,
                    canUpdate: false,
                    checkedAt: new Date().toISOString(),
                    message: behind ? "A managed provider update is available." : null,
                  },
                };
              }),
              Effect.catch(() =>
                Effect.succeed({
                  ...status,
                  versionAdvisory: makeSuppressedProviderVersionAdvisory(status),
                }),
              ),
            );
          },
          { concurrency: "unbounded" },
        );
        return yield* Effect.forEach(enriched, applyVolatileProviderState, {
          concurrency: "unbounded",
        });
      });

      const checkManagedProviderWhenEnabled = <R>(
        settings: ServerSettings,
        provider: ProviderKind,
        check: (binaryPath: string) => Effect.Effect<ServerProviderStatus, never, R>,
      ): Effect.Effect<Option.Option<ServerProviderStatus>, never, R> =>
        isProviderEnabledForSettings(provider, settings)
          ? getProviderBinaryPath(provider).pipe(
              Effect.flatMap(check),
              Effect.catch(() => Effect.succeed(makeMissingManagedRuntimeStatus(provider))),
              Effect.map(Option.some),
            )
          : Effect.succeed(Option.none());

      const loadProviderStatuses = serverSettings.ready
        .pipe(
          Effect.flatMap(() => serverSettings.getSettings),
          Effect.flatMap((settings) =>
            Effect.all(
              [
                checkManagedProviderWhenEnabled(settings, CODEX_PROVIDER, (binaryPath) =>
                  makeCheckManagedProviderInstallationStatus(CODEX_PROVIDER, binaryPath),
                ),
                checkManagedProviderWhenEnabled(settings, CLAUDE_AGENT_PROVIDER, (binaryPath) =>
                  makeCheckManagedProviderInstallationStatus(CLAUDE_AGENT_PROVIDER, binaryPath),
                ),
                checkManagedProviderWhenEnabled(settings, OPENCODE_PROVIDER, (binaryPath) =>
                  makeCheckManagedProviderInstallationStatus(OPENCODE_PROVIDER, binaryPath),
                ),
              ],
              {
                concurrency: "unbounded",
              },
            ),
          ),
        )
        .pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
          Effect.map((statuses) =>
            orderProviderStatuses(
              statuses.flatMap((status) => (Option.isSome(status) ? [status.value] : [])),
            ),
          ),
          Effect.flatMap(enrichStatuses),
        );

      const persistStatuses = (statuses: ProviderStatuses) =>
        Effect.forEach(
          statuses,
          (status) => {
            const { updateState: _updateState, ...statusToPersist } = status;
            return writeProviderStatusCache({
              filePath: cachePathByProvider.get(status.provider)!,
              provider: statusToPersist,
            }).pipe(
              Effect.provideService(FileSystem.FileSystem, fileSystem),
              Effect.provideService(Path.Path, path),
              Effect.tapError(Effect.logError),
              Effect.ignore,
            );
          },
          { concurrency: "unbounded", discard: true },
        );

      const refreshNow = Effect.gen(function* () {
        const refreshRevision = (yield* serverSettings.getSnapshot).revision;
        const loadedStatuses = yield* loadProviderStatuses;
        if ((yield* serverSettings.getSnapshot).revision !== refreshRevision) {
          const currentStatuses = yield* Ref.get(statusesRef);
          return yield* projectStatusesForCurrentSettings(currentStatuses);
        }
        const previousRawStatuses = yield* Ref.get(statusesRef);
        const previousStatuses = yield* projectStatusesForCurrentSettings(previousRawStatuses);
        const stabilizedLoadedStatuses = stabilizeProviderStatusesAgainstTransientTimeouts(
          previousRawStatuses,
          loadedStatuses,
        );
        const nextRawStatuses = mergeProviderStatusUpdates(
          previousRawStatuses,
          stabilizedLoadedStatuses,
        );
        const nextStatuses = yield* projectStatusesForCurrentSettings(nextRawStatuses);
        yield* Ref.set(statusesRef, nextRawStatuses);
        if (providerStatusesEqual(previousStatuses, nextStatuses)) {
          return nextStatuses;
        }
        yield* persistStatuses(nextRawStatuses);
        yield* PubSub.publish(changesPubSub, nextStatuses);
        return nextStatuses;
      });

      // Keep a single refresh in flight so repeated config reads do not spawn
      // overlapping CLI probes while the cache already gives us a usable answer.
      const ensureRefreshFiber: Effect.Effect<Fiber.Fiber<ProviderStatuses, never>> = Effect.gen(
        function* () {
          const inFlight = yield* Ref.get(refreshFiberRef);
          if (inFlight) {
            return inFlight;
          }
          const refreshFiber = yield* Effect.gen(function* () {
            const refreshExit = yield* Effect.exit(refreshNow);
            if (Exit.isSuccess(refreshExit)) {
              return refreshExit.value;
            }
            // Keep the current in-memory snapshot as the source of truth if a
            // foreground refresh fails after startup.
            const rawStatuses = yield* Ref.get(statusesRef);
            return yield* projectStatusesForCurrentSettings(rawStatuses);
          }).pipe(Effect.ensuring(Ref.set(refreshFiberRef, null)), Effect.forkIn(refreshScope));
          yield* Ref.set(refreshFiberRef, refreshFiber);
          return refreshFiber;
        },
      );

      yield* serverSettings.streamChanges.pipe(
        Stream.runForEach(() => publishProjectedStatuses().pipe(Effect.asVoid)),
        Effect.forkIn(refreshScope),
      );

      const refresh: Effect.Effect<ProviderStatuses> = ensureRefreshFiber.pipe(
        Effect.flatMap(Fiber.join),
      );

      const updateProvider: ProviderHealthShape["updateProvider"] = Effect.fn(
        "ProviderHealth.updateProvider",
      )(function* (input) {
        const provider = input.provider;
        const toUpdateError = (reason: unknown) =>
          new ServerProviderUpdateError({
            provider,
            reason: reason instanceof Error ? reason.message : String(reason),
          });
        const settings = yield* serverSettings.getSettings.pipe(Effect.mapError(toUpdateError));
        if (!isProviderEnabledForSettings(provider, settings)) {
          return yield* new ServerProviderUpdateError({
            provider,
            reason: "Provider is disabled in Penkra settings.",
          });
        }
        return yield* new ServerProviderUpdateError({
          provider,
          reason: "Provider runtimes are updated by Penkra's managed update service.",
        });
      });

      return {
        // Mirror upstream's behavior here: reads consume the latest stable
        // snapshot, while refreshes happen explicitly or from provider streams.
        getStatuses: Ref.get(statusesRef).pipe(Effect.flatMap(projectStatusesForCurrentSettings)),
        refresh,
        updateProvider,
        get streamChanges() {
          return Stream.fromPubSub(changesPubSub);
        },
      } satisfies ProviderHealthShape;
    }),
  );
}

export const ProviderHealthLive = makeProviderHealthLive();
