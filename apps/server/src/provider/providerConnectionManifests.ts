// FILE: providerConnectionManifests.ts
// Purpose: Adapter-owned Connection/authentication capabilities for managed harnesses.

import type { ProviderKind } from "@penkra/contracts";

import type { ProviderChildKind } from "../providerChildEnvironment.ts";
import type { ProviderConnectionDisplayIdentityStrategy } from "./providerConnectionDisplayIdentity.ts";

export interface StaticCredentialMethodManifest {
  readonly authenticationTargetId: string;
  readonly authenticationMethodId: string;
  readonly credentialBackend: "desktop-static-secret";
  readonly label: string;
  readonly displayIdentity: ProviderConnectionDisplayIdentityStrategy;
  readonly secretPlaceholder: string;
  readonly internalProviderIds: readonly (string | null)[];
  readonly authorizesInternalProvider: (internalProviderId: string | null) => boolean;
  readonly buildCredentialEnvironment: (secret: string) => NodeJS.ProcessEnv;
  readonly validateSecret: (secret: string) => Promise<void>;
}

interface ManagedLoginMethodManifestBase {
  readonly authenticationTargetId: string;
  readonly authenticationMethodId: string;
  readonly credentialBackend: "provider-native-profile";
  readonly label: string;
  readonly displayIdentity: ProviderConnectionDisplayIdentityStrategy;
  readonly internalProviderIds: readonly (string | null)[];
  readonly authorizesInternalProvider: (internalProviderId: string | null) => boolean;
}

export type ManagedLoginMethodManifest = ManagedLoginMethodManifestBase &
  (
    | {
        readonly loginMechanism: "browser";
        readonly secretPlaceholder?: never;
      }
    | {
        readonly loginMechanism: "secret-import";
        readonly secretPlaceholder: string;
      }
  );

export interface ProviderConnectionManifest {
  readonly harness: ProviderKind;
  readonly childKind: ProviderChildKind;
  readonly preserveOsHome?: boolean;
  readonly buildStateEnvironment: (input: {
    readonly profileRoot: string;
    readonly nativeStateRoot: string;
  }) => {
    readonly isolation: {
      readonly homePath: string;
      readonly xdgConfigHome: string;
      readonly xdgDataHome: string;
      readonly xdgCacheHome: string;
      readonly xdgStateHome: string;
    };
    readonly overrides: NodeJS.ProcessEnv;
  };
  readonly staticCredentialMethods: readonly StaticCredentialMethodManifest[];
  readonly managedLoginMethods: readonly ManagedLoginMethodManifest[];
  readonly anonymous?: {
    readonly internalProviderIds: readonly string[];
    readonly authorizesInternalProvider: (internalProviderId: string | null) => boolean;
  };
}

const noInternalProvider = (internalProviderId: string | null) => internalProviderId === null;

async function validateHttpCredential(input: {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly label: string;
}) {
  let response: Response;
  try {
    response = await fetch(input.url, {
      method: "GET",
      headers: input.headers,
      signal: AbortSignal.timeout(15_000),
    });
  } catch (cause) {
    throw new Error(`${input.label} could not verify this credential.`, {
      cause,
    });
  }
  if (!response.ok) {
    throw new Error(`${input.label} rejected this credential (${response.status}).`);
  }
}

const MANIFESTS = new Map<ProviderKind, ProviderConnectionManifest>([
  [
    "codex",
    {
      harness: "codex",
      childKind: "codex",
      // Codex's keyring backend needs the real OS-home Keychain. CODEX_HOME
      // still namespaces the provider-owned credential entry per Connection.
      preserveOsHome: process.platform === "darwin",
      buildStateEnvironment: ({ profileRoot, nativeStateRoot }) => ({
        isolation: {
          homePath: `${profileRoot}/home`,
          xdgConfigHome: `${profileRoot}/xdg-config`,
          xdgDataHome: `${profileRoot}/xdg-data`,
          xdgCacheHome: `${profileRoot}/xdg-cache`,
          xdgStateHome: `${profileRoot}/xdg-state`,
        },
        overrides: {
          // Authentication remains in a Connection-scoped native profile while
          // conversation metadata uses the separately versioned native state.
          CODEX_HOME: `${profileRoot}/codex-home`,
          CODEX_SQLITE_HOME: `${nativeStateRoot}/sqlite-home`,
        },
      }),
      // Codex credentials are provider-managed inside a Connection-scoped
      // CODEX_HOME. API keys are imported through Codex's native login command.
      staticCredentialMethods: [],
      managedLoginMethods: [
        {
          authenticationTargetId: "openai-first-party",
          authenticationMethodId: "chatgpt",
          credentialBackend: "provider-native-profile",
          loginMechanism: "browser",
          label: "Sign in",
          displayIdentity: { kind: "account-email" },
          internalProviderIds: [null],
          authorizesInternalProvider: noInternalProvider,
        },
        {
          authenticationTargetId: "openai-first-party",
          authenticationMethodId: "api-key",
          credentialBackend: "provider-native-profile",
          loginMechanism: "secret-import",
          label: "API key",
          displayIdentity: { kind: "secret-suffix", prefix: "API" },
          secretPlaceholder: "OpenAI API key",
          internalProviderIds: [null],
          authorizesInternalProvider: noInternalProvider,
        },
      ],
    },
  ],
  [
    "claudeAgent",
    {
      harness: "claudeAgent",
      childKind: "claude",
      // Claude stores OAuth credentials in the user's login Keychain on macOS.
      // The explicit secure-storage namespace below keeps each Connection
      // separate while the real OS home keeps that Keychain reachable.
      preserveOsHome: true,
      buildStateEnvironment: ({ profileRoot }) => ({
        isolation: {
          homePath: `${profileRoot}/home`,
          xdgConfigHome: `${profileRoot}/xdg-config`,
          xdgDataHome: `${profileRoot}/xdg-data`,
          xdgCacheHome: `${profileRoot}/xdg-cache`,
          xdgStateHome: `${profileRoot}/xdg-state`,
        },
        // Claude keeps authentication and sessions under one config root. Keep
        // that whole native profile Connection-scoped; exact session artifacts
        // are copied between profiles when the user switches Connections.
        overrides: {
          CLAUDE_CONFIG_DIR: `${profileRoot}/claude-config`,
          // Claude's secure-storage namespace is independently selectable.
          // Set it explicitly so concurrent Connections never share the
          // default macOS Keychain item, even when another Claude login exists.
          CLAUDE_SECURESTORAGE_CONFIG_DIR: `${profileRoot}/claude-config`,
        },
      }),
      staticCredentialMethods: [
        {
          authenticationTargetId: "anthropic-first-party",
          authenticationMethodId: "api-key",
          credentialBackend: "desktop-static-secret",
          label: "API key",
          displayIdentity: { kind: "secret-suffix", prefix: "API" },
          secretPlaceholder: "Anthropic API key",
          internalProviderIds: [null],
          authorizesInternalProvider: noInternalProvider,
          buildCredentialEnvironment: (secret) => ({
            ANTHROPIC_API_KEY: secret,
          }),
          validateSecret: (secret) =>
            validateHttpCredential({
              url: "https://api.anthropic.com/v1/models",
              headers: {
                "x-api-key": secret,
                "anthropic-version": "2023-06-01",
              },
              label: "Anthropic",
            }),
        },
      ],
      managedLoginMethods: [
        {
          authenticationTargetId: "anthropic-first-party",
          authenticationMethodId: "claude-account",
          credentialBackend: "provider-native-profile",
          loginMechanism: "browser",
          label: "Sign in",
          displayIdentity: { kind: "account-email" },
          internalProviderIds: [null],
          authorizesInternalProvider: noInternalProvider,
        },
      ],
    },
  ],
  [
    "opencode",
    {
      harness: "opencode",
      childKind: "opencode",
      buildStateEnvironment: ({ profileRoot, nativeStateRoot }) => ({
        isolation: {
          homePath: `${profileRoot}/home`,
          xdgConfigHome: `${profileRoot}/xdg-config`,
          xdgDataHome: `${nativeStateRoot}/xdg-data`,
          xdgCacheHome: `${profileRoot}/xdg-cache`,
          xdgStateHome: `${nativeStateRoot}/xdg-state`,
        },
        overrides: {
          OPENCODE_DB: `${nativeStateRoot}/opencode.db`,
        },
      }),
      staticCredentialMethods: [
        {
          authenticationTargetId: "opencode-zen",
          authenticationMethodId: "api-key",
          credentialBackend: "desktop-static-secret",
          label: "OpenCode Zen",
          displayIdentity: { kind: "secret-suffix", prefix: "OpenCode Zen" },
          secretPlaceholder: "OpenCode Zen key",
          internalProviderIds: ["opencode"],
          authorizesInternalProvider: (internalProviderId) => internalProviderId === "opencode",
          buildCredentialEnvironment: (secret) => ({
            OPENCODE_AUTH_CONTENT: JSON.stringify({
              opencode: { type: "api", key: secret },
            }),
          }),
          validateSecret: (secret) =>
            validateHttpCredential({
              url: "https://opencode.ai/zen/v1/models",
              headers: { Authorization: `Bearer ${secret}` },
              label: "OpenCode Zen",
            }),
        },
        {
          authenticationTargetId: "opencode-go",
          authenticationMethodId: "api-key",
          credentialBackend: "desktop-static-secret",
          label: "OpenCode Go",
          displayIdentity: { kind: "secret-suffix", prefix: "OpenCode Go" },
          secretPlaceholder: "OpenCode Go key",
          internalProviderIds: ["opencode-go"],
          authorizesInternalProvider: (internalProviderId) => internalProviderId === "opencode-go",
          buildCredentialEnvironment: (secret) => ({
            OPENCODE_AUTH_CONTENT: JSON.stringify({
              "opencode-go": { type: "api", key: secret },
            }),
          }),
          validateSecret: (secret) =>
            validateHttpCredential({
              url: "https://opencode.ai/zen/go/v1/models",
              headers: { Authorization: `Bearer ${secret}` },
              label: "OpenCode Go",
            }),
        },
      ],
      managedLoginMethods: [],
      anonymous: {
        internalProviderIds: ["opencode"],
        authorizesInternalProvider: (internalProviderId) => internalProviderId === "opencode",
      },
    },
  ],
]);

export function getProviderConnectionManifest(
  harness: ProviderKind,
): ProviderConnectionManifest | null {
  return MANIFESTS.get(harness) ?? null;
}

export function listProviderConnectionManifests(): readonly ProviderConnectionManifest[] {
  return [...MANIFESTS.values()];
}

export function findStaticCredentialMethod(input: {
  readonly harness: ProviderKind;
  readonly authenticationTargetId: string;
  readonly authenticationMethodId: string;
}): StaticCredentialMethodManifest | null {
  const manifest = getProviderConnectionManifest(input.harness);
  return (
    manifest?.staticCredentialMethods.find(
      (method) =>
        method.authenticationTargetId === input.authenticationTargetId &&
        method.authenticationMethodId === input.authenticationMethodId,
    ) ?? null
  );
}

export function findManagedLoginMethod(input: {
  readonly harness: ProviderKind;
  readonly authenticationTargetId: string;
  readonly authenticationMethodId: string;
}): ManagedLoginMethodManifest | null {
  const manifest = getProviderConnectionManifest(input.harness);
  return (
    manifest?.managedLoginMethods.find(
      (method) =>
        method.authenticationTargetId === input.authenticationTargetId &&
        method.authenticationMethodId === input.authenticationMethodId,
    ) ?? null
  );
}

export function findConnectionAuthenticationMethod(input: {
  readonly harness: ProviderKind;
  readonly authenticationTargetId: string;
  readonly authenticationMethodId: string;
}): StaticCredentialMethodManifest | ManagedLoginMethodManifest | null {
  return findStaticCredentialMethod(input) ?? findManagedLoginMethod(input);
}
