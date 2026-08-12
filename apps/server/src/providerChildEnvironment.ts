// FILE: providerChildEnvironment.ts
// Purpose: Builds provider child environments without Penkra control-plane authority.
// Layer: Server provider process security

export type ProviderChildKind =
  | "acp"
  | "antigravity"
  | "claude"
  | "codex"
  | "cursor"
  | "droid"
  | "grok"
  | "kilo"
  | "opencode"
  | "pi";

const PROVIDER_CREDENTIAL_KEYS = new Set([
  "OPENAI_API_KEY",
  "OPENAI_ORG_ID",
  "OPENAI_PROJECT_ID",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "XAI_API_KEY",
  "GROK_CODE_XAI_API_KEY",
  "FACTORY_API_KEY",
  "CURSOR_API_KEY",
]);

const MANAGED_CONNECTION_PROVIDERS = new Set<ProviderChildKind>(["codex", "claude", "opencode"]);

const MANAGED_BASE_ENV_KEYS = new Set([
  "COLORTERM",
  "LANG",
  "NO_COLOR",
  "PATH",
  "SHELL",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "TERM",
  "TMPDIR",
  "TZ",
  "USER",
]);

const PROVIDER_CREDENTIAL_GRANTS: Record<ProviderChildKind, "all" | ReadonlySet<string>> = {
  antigravity: new Set(["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS"]),
  claude: new Set([
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "GOOGLE_APPLICATION_CREDENTIALS",
  ]),
  cursor: new Set(["CURSOR_API_KEY"]),
  droid: new Set(["FACTORY_API_KEY"]),
  grok: new Set(["XAI_API_KEY", "GROK_CODE_XAI_API_KEY"]),
  // These profiles deliberately support arbitrary upstream model providers.
  acp: "all",
  codex: "all",
  kilo: "all",
  opencode: "all",
  pi: "all",
};

const INHERITED_NATIVE_CAPABILITY_KEYS = new Set([
  "BUN_OPTIONS",
  "ELECTRON_RUN_AS_NODE",
  "NODE_OPTIONS",
  "NODE_PATH",
  "NODE_REPL_SANDBOX_ALLOWED_UNIX_SOCKETS",
]);

const isTestHarnessKey = (key: string, env: NodeJS.ProcessEnv): boolean =>
  Boolean(env.VITEST) && (key.startsWith("PENKRA_FAKE_") || key.startsWith("PENKRA_ACP_"));

const MANAGED_UPDATE_OVERRIDES: Partial<Record<ProviderChildKind, NodeJS.ProcessEnv>> = {
  claude: { DISABLE_UPDATES: "1" },
  opencode: { OPENCODE_DISABLE_AUTOUPDATE: "1" },
};

export function buildProviderChildEnvironment(input: {
  readonly provider: ProviderChildKind;
  readonly baseEnv?: NodeJS.ProcessEnv;
  readonly inheritedPenkraKeys?: ReadonlyArray<string>;
  readonly inheritedNativeCapabilityKeys?: ReadonlyArray<string>;
  /** False is reserved for non-thread compatibility utilities that do not represent a Connection. */
  readonly managedConnection?: boolean;
  readonly overrides?: NodeJS.ProcessEnv;
  readonly credentialOverrides?: NodeJS.ProcessEnv;
  readonly isolation?: {
    readonly homePath: string;
    readonly xdgConfigHome: string;
    readonly xdgDataHome: string;
    readonly xdgCacheHome: string;
    readonly xdgStateHome: string;
  };
  /** Keep the real OS home when the provider's supported credential store needs it. */
  readonly preserveOsHome?: boolean;
}): NodeJS.ProcessEnv {
  const baseEnv = input.baseEnv ?? process.env;
  const allowedPenkraKeys = new Set(input.inheritedPenkraKeys ?? []);
  const allowedNativeCapabilities = new Set(input.inheritedNativeCapabilityKeys ?? []);
  const credentialGrants = PROVIDER_CREDENTIAL_GRANTS[input.provider];
  const managedConnection =
    input.managedConnection ?? MANAGED_CONNECTION_PROVIDERS.has(input.provider);
  const childEnv: NodeJS.ProcessEnv = {};

  for (const [key, value] of Object.entries(baseEnv)) {
    if (
      key.startsWith("PENKRA_") &&
      !allowedPenkraKeys.has(key) &&
      !isTestHarnessKey(key, baseEnv)
    ) {
      continue;
    }
    if (INHERITED_NATIVE_CAPABILITY_KEYS.has(key) && !allowedNativeCapabilities.has(key)) {
      continue;
    }
    if (
      PROVIDER_CREDENTIAL_KEYS.has(key) &&
      (managedConnection || (credentialGrants !== "all" && !credentialGrants.has(key)))
    ) {
      continue;
    }
    if (
      managedConnection &&
      !MANAGED_BASE_ENV_KEYS.has(key) &&
      !(input.preserveOsHome && key === "HOME") &&
      !key.startsWith("LC_") &&
      !allowedPenkraKeys.has(key) &&
      !allowedNativeCapabilities.has(key) &&
      !isTestHarnessKey(key, baseEnv)
    ) {
      continue;
    }
    childEnv[key] = value;
  }

  for (const [key, value] of Object.entries(input.overrides ?? {})) {
    if (
      key.startsWith("PENKRA_") ||
      INHERITED_NATIVE_CAPABILITY_KEYS.has(key) ||
      PROVIDER_CREDENTIAL_KEYS.has(key)
    ) {
      continue;
    }
    childEnv[key] = value;
  }

  if (managedConnection && input.isolation) {
    if (!input.preserveOsHome) childEnv.HOME = input.isolation.homePath;
    childEnv.XDG_CONFIG_HOME = input.isolation.xdgConfigHome;
    childEnv.XDG_DATA_HOME = input.isolation.xdgDataHome;
    childEnv.XDG_CACHE_HOME = input.isolation.xdgCacheHome;
    childEnv.XDG_STATE_HOME = input.isolation.xdgStateHome;
  }

  for (const [key, value] of Object.entries(input.credentialOverrides ?? {})) {
    if (key.startsWith("PENKRA_") || INHERITED_NATIVE_CAPABILITY_KEYS.has(key)) continue;
    childEnv[key] = value;
  }

  Object.assign(childEnv, MANAGED_UPDATE_OVERRIDES[input.provider]);

  return childEnv;
}
