import { describe, it, assert } from "@effect/vitest";

import {
  createProviderVersionAdvisory,
  deriveNpmGlobalPrefix,
  parseGenericCliVersion,
  resolveHomebrewNameFromReceipt,
  resolvePackageManagedProviderMaintenance,
  type PackageManagedProviderMaintenanceDefinition,
} from "./providerMaintenance";

const CODEX_DEFINITION = {
  provider: "codex",
  binaryName: "codex",
  npmPackageName: "@openai/codex",
  homebrew: { name: "codex", kind: "cask" },
  nativeUpdate: null,
} as const satisfies PackageManagedProviderMaintenanceDefinition;

const OPENCODE_DEFINITION = {
  provider: "opencode",
  binaryName: "opencode",
  npmPackageName: "opencode-ai",
  homebrew: {
    name: "opencode",
    kind: "formula",
    alternatives: ["anomalyco/tap/opencode"],
  },
  nativeUpdate: {
    executable: "opencode",
    args: () => ["upgrade"],
    lockKey: "opencode-native",
    strategy: "matching-path",
  },
} as const satisfies PackageManagedProviderMaintenanceDefinition;

describe("providerMaintenance", () => {
  it("parses generic CLI versions", () => {
    assert.strictEqual(parseGenericCliVersion("codex-cli 0.130.0\n"), "0.130.0");
    assert.strictEqual(parseGenericCliVersion("claude 2.1\n"), "2.1.0");
    assert.strictEqual(parseGenericCliVersion("no version here"), null);
  });

  it("resolves npm global update commands for unqualified binaries", () => {
    const capabilities = resolvePackageManagedProviderMaintenance(CODEX_DEFINITION, {
      binaryPath: "codex",
      realCommandPath: "/Users/test/.npm-global/lib/node_modules/@openai/codex/bin/codex",
    });

    assert.deepStrictEqual(capabilities.update, {
      command: "npm install -g --prefix /Users/test/.npm-global @openai/codex@latest",
      executable: "npm",
      args: ["install", "-g", "--prefix", "/Users/test/.npm-global", "@openai/codex@latest"],
      lockKey: "npm-global",
    });
  });

  it("pins the npm global prefix that owns the detected binary", () => {
    // npm's global prefix follows the node that runs it, so without --prefix a
    // second node install (e.g. nvm) would receive the update while Penkra
    // keeps checking the copy it originally detected.
    assert.strictEqual(
      deriveNpmGlobalPrefix("/opt/homebrew/lib/node_modules/@openai/codex/bin/codex.js"),
      "/opt/homebrew",
    );
    assert.strictEqual(
      deriveNpmGlobalPrefix(
        "C:\\Users\\Test User\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js",
      ),
      "C:\\Users\\Test User\\AppData\\Roaming\\npm",
    );
    // Project-local node_modules paths are not global installs; no prefix.
    assert.strictEqual(deriveNpmGlobalPrefix("/repo/node_modules/.bin/codex"), null);
  });

  it("quotes update command arguments containing spaces", () => {
    const capabilities = resolvePackageManagedProviderMaintenance(CODEX_DEFINITION, {
      binaryPath: "codex",
      realCommandPath:
        "C:\\Users\\Test User\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js",
    });

    assert.strictEqual(
      capabilities.update?.command,
      'npm install -g --prefix "C:\\Users\\Test User\\AppData\\Roaming\\npm" @openai/codex@latest',
    );
  });

  it("does not guess an update command for unclassified binaries", () => {
    const capabilities = resolvePackageManagedProviderMaintenance(CODEX_DEFINITION, {
      binaryPath: "/custom/bin/codex",
      realCommandPath: "/custom/bin/codex",
    });

    assert.strictEqual(capabilities.update, null);
  });

  it("resolves Homebrew cask update commands", () => {
    const capabilities = resolvePackageManagedProviderMaintenance(CODEX_DEFINITION, {
      binaryPath: "/opt/homebrew/bin/codex",
      realCommandPath: "/opt/homebrew/Caskroom/codex/0.130.0/codex",
    });

    assert.deepStrictEqual(capabilities.update, {
      command: "brew upgrade --cask codex",
      executable: "brew",
      args: ["upgrade", "--cask", "codex"],
      lockKey: "homebrew",
    });
    assert.strictEqual(capabilities.packageName, null);
  });

  it("updates package-managed OpenCode through the manager that owns it", () => {
    const capabilities = resolvePackageManagedProviderMaintenance(OPENCODE_DEFINITION, {
      binaryPath: "opencode",
      realCommandPath: "/Users/test/.local/share/pnpm/opencode",
    });

    assert.deepStrictEqual(capabilities.update, {
      command: "pnpm add -g opencode-ai@latest",
      executable: "pnpm",
      args: ["add", "-g", "opencode-ai@latest"],
      lockKey: "pnpm-global",
    });
    assert.deepStrictEqual(capabilities.latestVersionSource, {
      kind: "npm",
      name: "opencode-ai",
    });
  });

  it("treats Homebrew's nested npm payload as owned by Homebrew", () => {
    const capabilities = resolvePackageManagedProviderMaintenance(OPENCODE_DEFINITION, {
      binaryPath: "opencode",
      realCommandPath:
        "/usr/local/Cellar/opencode/1.17.15/libexec/lib/node_modules/opencode-ai/bin/opencode.exe",
    });

    assert.deepStrictEqual(capabilities.update, {
      command: "brew upgrade opencode",
      executable: "brew",
      args: ["upgrade", "opencode"],
      lockKey: "homebrew",
    });
    assert.deepStrictEqual(capabilities.latestVersionSource, {
      kind: "homebrew",
      name: "opencode",
      homebrewKind: "formula",
    });
  });

  it("keeps the upstream OpenCode tap distinct from Homebrew Core", () => {
    const receipt = JSON.stringify({ source: { tap: "anomalyco/tap" } });
    const verifiedHomebrewName = resolveHomebrewNameFromReceipt(OPENCODE_DEFINITION, receipt);
    const capabilities = resolvePackageManagedProviderMaintenance(OPENCODE_DEFINITION, {
      binaryPath: "opencode",
      realCommandPath: "/opt/homebrew/Cellar/opencode/1.18.0/bin/opencode",
      verifiedHomebrewName,
    });

    assert.strictEqual(verifiedHomebrewName, "anomalyco/tap/opencode");
    assert.strictEqual(capabilities.update?.command, "brew upgrade anomalyco/tap/opencode");
  });

  it("marks older semver versions as behind latest", () => {
    const advisory = createProviderVersionAdvisory({
      provider: "codex",
      currentVersion: "0.129.0",
      latestVersion: "0.130.0",
    });

    assert.strictEqual(advisory.status, "behind_latest");
    assert.strictEqual(advisory.currentVersion, "0.129.0");
    assert.strictEqual(advisory.latestVersion, "0.130.0");
  });
});
