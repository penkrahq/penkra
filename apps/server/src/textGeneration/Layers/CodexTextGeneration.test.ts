import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path } from "effect";
import { expect } from "vitest";

import { ServerConfig } from "../../config.ts";
import { CodexTextGenerationLive } from "./CodexTextGeneration.ts";
import { TextGenerationError } from "../Errors.ts";
import { TextGeneration } from "../Services/TextGeneration.ts";

const CodexTextGenerationTestLayer = CodexTextGenerationLive.pipe(
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), {
      prefix: "penkra-codex-text-generation-test-",
    }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

let codexEnvQueue = Promise.resolve();

function acquireCodexEnvLock() {
  return Effect.promise(async () => {
    let releaseLock = () => {};
    const previous = codexEnvQueue;
    codexEnvQueue = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    await previous;
    return releaseLock;
  });
}

function makeFakeCodexBinary(dir: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const binDir = path.join(dir, "bin");
    const codexPath = path.join(binDir, "codex");
    yield* fs.makeDirectory(binDir, { recursive: true });

    yield* fs.writeFileString(
      codexPath,
      [
        "#!/bin/sh",
        'output_path=""',
        "while [ $# -gt 0 ]; do",
        '  if [ "$1" = "--image" ]; then',
        "    shift",
        '    if [ -n "$1" ]; then',
        '      seen_image="1"',
        "    fi",
        "    continue",
        "  fi",
        '  if [ "$1" = "--skip-git-repo-check" ]; then',
        '    seen_skip_git_repo_check="1"',
        "  fi",
        '  if [ "$1" = "--config" ]; then',
        "    shift",
        '    if [ "$1" = "approval_policy=\\"never\\"" ]; then',
        '      seen_approval_never="1"',
        "    fi",
        "    continue",
        "  fi",
        '  if [ "$1" = "--output-last-message" ]; then',
        "    shift",
        '    output_path="$1"',
        "  fi",
        "  shift",
        "done",
        'stdin_content="$(cat)"',
        'if [ "$PENKRA_FAKE_CODEX_REQUIRE_IMAGE" = "1" ] && [ "$seen_image" != "1" ]; then',
        '  printf "%s\\n" "missing --image input" >&2',
        "  exit 2",
        "fi",
        'if [ "$PENKRA_FAKE_CODEX_REQUIRE_SKIP_GIT_REPO_CHECK" = "1" ] && [ "$seen_skip_git_repo_check" != "1" ]; then',
        '  printf "%s\\n" "missing --skip-git-repo-check" >&2',
        "  exit 9",
        "fi",
        'if [ "$PENKRA_FAKE_CODEX_REQUIRE_APPROVAL_NEVER" = "1" ] && [ "$seen_approval_never" != "1" ]; then',
        '  printf "%s\\n" "missing approval_policy=never" >&2',
        "  exit 10",
        "fi",
        'if [ -n "$PENKRA_FAKE_CODEX_STDIN_MUST_CONTAIN" ]; then',
        '  printf "%s" "$stdin_content" | grep -F -- "$PENKRA_FAKE_CODEX_STDIN_MUST_CONTAIN" >/dev/null || {',
        '    printf "%s\\n" "stdin missing expected content" >&2',
        "    exit 3",
        "  }",
        "fi",
        'if [ -n "$PENKRA_FAKE_CODEX_STDIN_MUST_NOT_CONTAIN" ]; then',
        '  if printf "%s" "$stdin_content" | grep -F -- "$PENKRA_FAKE_CODEX_STDIN_MUST_NOT_CONTAIN" >/dev/null; then',
        '    printf "%s\\n" "stdin contained forbidden content" >&2',
        "    exit 4",
        "  fi",
        "fi",
        'if [ "$PENKRA_FAKE_CODEX_REQUIRE_CODEX_HOME" = "1" ] && [ -z "$CODEX_HOME" ]; then',
        '  printf "%s\\n" "missing CODEX_HOME" >&2',
        "  exit 5",
        "fi",
        'if [ "$PENKRA_FAKE_CODEX_REQUIRE_AUTH_JSON" = "1" ] && [ ! -f "$CODEX_HOME/auth.json" ]; then',
        '  printf "%s\\n" "missing auth.json in CODEX_HOME" >&2',
        "  exit 6",
        "fi",
        'if [ -n "$PENKRA_FAKE_CODEX_EXPECT_CODEX_HOME" ] && [ "$CODEX_HOME" != "$PENKRA_FAKE_CODEX_EXPECT_CODEX_HOME" ]; then',
        '  printf "%s\\n" "unexpected CODEX_HOME" >&2',
        "  exit 11",
        "fi",
        'if [ -n "$PENKRA_FAKE_CODEX_EXPECT_OPENAI_API_KEY" ] && [ "$OPENAI_API_KEY" != "$PENKRA_FAKE_CODEX_EXPECT_OPENAI_API_KEY" ]; then',
        '  printf "%s\\n" "unexpected OPENAI_API_KEY" >&2',
        "  exit 12",
        "fi",
        'if [ -n "$PENKRA_FAKE_CODEX_CODEX_HOME_CONFIG_MUST_CONTAIN" ]; then',
        '  grep -F -- "$PENKRA_FAKE_CODEX_CODEX_HOME_CONFIG_MUST_CONTAIN" "$CODEX_HOME/config.toml" >/dev/null || {',
        '    printf "%s\\n" "CODEX_HOME config missing expected content" >&2',
        "    exit 7",
        "  }",
        "fi",
        'if [ -n "$PENKRA_FAKE_CODEX_CODEX_HOME_CONFIG_MUST_NOT_CONTAIN" ]; then',
        '  if grep -F -- "$PENKRA_FAKE_CODEX_CODEX_HOME_CONFIG_MUST_NOT_CONTAIN" "$CODEX_HOME/config.toml" >/dev/null; then',
        '    printf "%s\\n" "CODEX_HOME config contained forbidden content" >&2',
        "    exit 8",
        "  fi",
        "fi",
        'if [ -n "$PENKRA_FAKE_CODEX_STDERR" ]; then',
        '  printf "%s\\n" "$PENKRA_FAKE_CODEX_STDERR" >&2',
        "fi",
        'if [ -n "$output_path" ]; then',
        '  node -e \'const fs=require("node:fs"); const value=process.argv[2] ?? ""; fs.writeFileSync(process.argv[1], Buffer.from(value, "base64"));\' "$output_path" "${PENKRA_FAKE_CODEX_OUTPUT_B64:-e30=}"',
        "fi",
        'exit "${PENKRA_FAKE_CODEX_EXIT_CODE:-0}"',
        "",
      ].join("\n"),
    );
    yield* fs.chmod(codexPath, 0o755);
    return binDir;
  });
}

function withFakeCodexEnv<A, E, R>(
  input: {
    output: string;
    exitCode?: number;
    stderr?: string;
    requireImage?: boolean;
    stdinMustContain?: string;
    stdinMustNotContain?: string;
    requireCodexHome?: boolean;
    requireAuthJson?: boolean;
    requireSkipGitRepoCheck?: boolean;
    requireApprovalNever?: boolean;
    codexHomeConfigMustContain?: string;
    codexHomeConfigMustNotContain?: string;
  },
  effect: Effect.Effect<A, E, R>,
) {
  return Effect.acquireUseRelease(
    Effect.gen(function* () {
      const releaseLock = yield* acquireCodexEnvLock();
      const fs = yield* FileSystem.FileSystem;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "penkra-codex-text-" });
      const binDir = yield* makeFakeCodexBinary(tempDir);
      const previousPath = process.env.PATH;
      const previousPenkraHome = process.env.PENKRA_HOME;
      const previousOutput = process.env.PENKRA_FAKE_CODEX_OUTPUT_B64;
      const previousExitCode = process.env.PENKRA_FAKE_CODEX_EXIT_CODE;
      const previousStderr = process.env.PENKRA_FAKE_CODEX_STDERR;
      const previousRequireImage = process.env.PENKRA_FAKE_CODEX_REQUIRE_IMAGE;
      const previousStdinMustContain = process.env.PENKRA_FAKE_CODEX_STDIN_MUST_CONTAIN;
      const previousStdinMustNotContain = process.env.PENKRA_FAKE_CODEX_STDIN_MUST_NOT_CONTAIN;
      const previousRequireCodexHome = process.env.PENKRA_FAKE_CODEX_REQUIRE_CODEX_HOME;
      const previousRequireAuthJson = process.env.PENKRA_FAKE_CODEX_REQUIRE_AUTH_JSON;
      const previousRequireSkipGitRepoCheck =
        process.env.PENKRA_FAKE_CODEX_REQUIRE_SKIP_GIT_REPO_CHECK;
      const previousRequireApprovalNever = process.env.PENKRA_FAKE_CODEX_REQUIRE_APPROVAL_NEVER;
      const previousCodexHomeConfigMustContain =
        process.env.PENKRA_FAKE_CODEX_CODEX_HOME_CONFIG_MUST_CONTAIN;
      const previousCodexHomeConfigMustNotContain =
        process.env.PENKRA_FAKE_CODEX_CODEX_HOME_CONFIG_MUST_NOT_CONTAIN;

      yield* Effect.sync(() => {
        process.env.PATH = `${binDir}:${previousPath ?? ""}`;
        process.env.PENKRA_HOME = tempDir;
        process.env.PENKRA_FAKE_CODEX_OUTPUT_B64 = Buffer.from(input.output, "utf8").toString(
          "base64",
        );

        if (input.exitCode !== undefined) {
          process.env.PENKRA_FAKE_CODEX_EXIT_CODE = String(input.exitCode);
        } else {
          delete process.env.PENKRA_FAKE_CODEX_EXIT_CODE;
        }

        if (input.stderr !== undefined) {
          process.env.PENKRA_FAKE_CODEX_STDERR = input.stderr;
        } else {
          delete process.env.PENKRA_FAKE_CODEX_STDERR;
        }

        if (input.requireImage) {
          process.env.PENKRA_FAKE_CODEX_REQUIRE_IMAGE = "1";
        } else {
          delete process.env.PENKRA_FAKE_CODEX_REQUIRE_IMAGE;
        }

        if (input.stdinMustContain !== undefined) {
          process.env.PENKRA_FAKE_CODEX_STDIN_MUST_CONTAIN = input.stdinMustContain;
        } else {
          delete process.env.PENKRA_FAKE_CODEX_STDIN_MUST_CONTAIN;
        }

        if (input.stdinMustNotContain !== undefined) {
          process.env.PENKRA_FAKE_CODEX_STDIN_MUST_NOT_CONTAIN = input.stdinMustNotContain;
        } else {
          delete process.env.PENKRA_FAKE_CODEX_STDIN_MUST_NOT_CONTAIN;
        }

        if (input.requireCodexHome) {
          process.env.PENKRA_FAKE_CODEX_REQUIRE_CODEX_HOME = "1";
        } else {
          delete process.env.PENKRA_FAKE_CODEX_REQUIRE_CODEX_HOME;
        }

        if (input.requireAuthJson) {
          process.env.PENKRA_FAKE_CODEX_REQUIRE_AUTH_JSON = "1";
        } else {
          delete process.env.PENKRA_FAKE_CODEX_REQUIRE_AUTH_JSON;
        }

        if (input.requireSkipGitRepoCheck) {
          process.env.PENKRA_FAKE_CODEX_REQUIRE_SKIP_GIT_REPO_CHECK = "1";
        } else {
          delete process.env.PENKRA_FAKE_CODEX_REQUIRE_SKIP_GIT_REPO_CHECK;
        }

        if (input.requireApprovalNever) {
          process.env.PENKRA_FAKE_CODEX_REQUIRE_APPROVAL_NEVER = "1";
        } else {
          delete process.env.PENKRA_FAKE_CODEX_REQUIRE_APPROVAL_NEVER;
        }

        if (input.codexHomeConfigMustContain !== undefined) {
          process.env.PENKRA_FAKE_CODEX_CODEX_HOME_CONFIG_MUST_CONTAIN =
            input.codexHomeConfigMustContain;
        } else {
          delete process.env.PENKRA_FAKE_CODEX_CODEX_HOME_CONFIG_MUST_CONTAIN;
        }

        if (input.codexHomeConfigMustNotContain !== undefined) {
          process.env.PENKRA_FAKE_CODEX_CODEX_HOME_CONFIG_MUST_NOT_CONTAIN =
            input.codexHomeConfigMustNotContain;
        } else {
          delete process.env.PENKRA_FAKE_CODEX_CODEX_HOME_CONFIG_MUST_NOT_CONTAIN;
        }
      });

      return {
        previousPath,
        previousPenkraHome,
        previousOutput,
        previousExitCode,
        previousStderr,
        previousRequireImage,
        previousStdinMustContain,
        previousStdinMustNotContain,
        previousRequireCodexHome,
        previousRequireAuthJson,
        previousRequireSkipGitRepoCheck,
        previousRequireApprovalNever,
        previousCodexHomeConfigMustContain,
        previousCodexHomeConfigMustNotContain,
        releaseLock,
      };
    }),
    () => effect,
    (previous) =>
      Effect.sync(() => {
        process.env.PATH = previous.previousPath;
        if (previous.previousPenkraHome === undefined) {
          delete process.env.PENKRA_HOME;
        } else {
          process.env.PENKRA_HOME = previous.previousPenkraHome;
        }

        if (previous.previousOutput === undefined) {
          delete process.env.PENKRA_FAKE_CODEX_OUTPUT_B64;
        } else {
          process.env.PENKRA_FAKE_CODEX_OUTPUT_B64 = previous.previousOutput;
        }

        if (previous.previousExitCode === undefined) {
          delete process.env.PENKRA_FAKE_CODEX_EXIT_CODE;
        } else {
          process.env.PENKRA_FAKE_CODEX_EXIT_CODE = previous.previousExitCode;
        }

        if (previous.previousStderr === undefined) {
          delete process.env.PENKRA_FAKE_CODEX_STDERR;
        } else {
          process.env.PENKRA_FAKE_CODEX_STDERR = previous.previousStderr;
        }

        if (previous.previousRequireImage === undefined) {
          delete process.env.PENKRA_FAKE_CODEX_REQUIRE_IMAGE;
        } else {
          process.env.PENKRA_FAKE_CODEX_REQUIRE_IMAGE = previous.previousRequireImage;
        }

        if (previous.previousStdinMustContain === undefined) {
          delete process.env.PENKRA_FAKE_CODEX_STDIN_MUST_CONTAIN;
        } else {
          process.env.PENKRA_FAKE_CODEX_STDIN_MUST_CONTAIN = previous.previousStdinMustContain;
        }

        if (previous.previousStdinMustNotContain === undefined) {
          delete process.env.PENKRA_FAKE_CODEX_STDIN_MUST_NOT_CONTAIN;
        } else {
          process.env.PENKRA_FAKE_CODEX_STDIN_MUST_NOT_CONTAIN =
            previous.previousStdinMustNotContain;
        }

        if (previous.previousRequireCodexHome === undefined) {
          delete process.env.PENKRA_FAKE_CODEX_REQUIRE_CODEX_HOME;
        } else {
          process.env.PENKRA_FAKE_CODEX_REQUIRE_CODEX_HOME = previous.previousRequireCodexHome;
        }

        if (previous.previousRequireAuthJson === undefined) {
          delete process.env.PENKRA_FAKE_CODEX_REQUIRE_AUTH_JSON;
        } else {
          process.env.PENKRA_FAKE_CODEX_REQUIRE_AUTH_JSON = previous.previousRequireAuthJson;
        }

        if (previous.previousRequireSkipGitRepoCheck === undefined) {
          delete process.env.PENKRA_FAKE_CODEX_REQUIRE_SKIP_GIT_REPO_CHECK;
        } else {
          process.env.PENKRA_FAKE_CODEX_REQUIRE_SKIP_GIT_REPO_CHECK =
            previous.previousRequireSkipGitRepoCheck;
        }

        if (previous.previousRequireApprovalNever === undefined) {
          delete process.env.PENKRA_FAKE_CODEX_REQUIRE_APPROVAL_NEVER;
        } else {
          process.env.PENKRA_FAKE_CODEX_REQUIRE_APPROVAL_NEVER =
            previous.previousRequireApprovalNever;
        }

        if (previous.previousCodexHomeConfigMustContain === undefined) {
          delete process.env.PENKRA_FAKE_CODEX_CODEX_HOME_CONFIG_MUST_CONTAIN;
        } else {
          process.env.PENKRA_FAKE_CODEX_CODEX_HOME_CONFIG_MUST_CONTAIN =
            previous.previousCodexHomeConfigMustContain;
        }

        if (previous.previousCodexHomeConfigMustNotContain === undefined) {
          delete process.env.PENKRA_FAKE_CODEX_CODEX_HOME_CONFIG_MUST_NOT_CONTAIN;
        } else {
          process.env.PENKRA_FAKE_CODEX_CODEX_HOME_CONFIG_MUST_NOT_CONTAIN =
            previous.previousCodexHomeConfigMustNotContain;
        }

        previous.releaseLock();
      }),
  );
}

it.layer(CodexTextGenerationTestLayer)("CodexTextGenerationLive", (it) => {
  it.effect("generates compact thread titles from the first user message", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          title: ' "Polish sidebar loading state." ',
        }),
        stdinMustContain: "Never exceed 6 words.",
        requireSkipGitRepoCheck: true,
        requireApprovalNever: true,
      },
      Effect.gen(function* () {
        const textGeneration = yield* TextGeneration;

        const generated = yield* textGeneration.generateThreadTitle({
          cwd: process.cwd(),
          message: "The sidebar loading state feels noisy and needs polish.",
        });

        expect(generated.title).toBe("Polish sidebar loading state");
      }),
    ),
  );

  it.effect("uses the exact managed Codex profile and selected credential", () =>
    withFakeCodexEnv(
      { output: JSON.stringify({ title: "Managed Codex title" }) },
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const textGeneration = yield* TextGeneration;
        const managedHome = path.join(process.env.PENKRA_HOME ?? "", "managed-codex-home");
        yield* fs.makeDirectory(managedHome, { recursive: true });
        process.env.PENKRA_FAKE_CODEX_EXPECT_CODEX_HOME = managedHome;
        process.env.PENKRA_FAKE_CODEX_EXPECT_OPENAI_API_KEY = "selected-connection-key";

        return yield* textGeneration
          .generateThreadTitle({
            cwd: process.cwd(),
            message: "Use the selected managed Codex Connection",
            managedLaunch: {
              binaryPath: "codex",
              isolationKey: "managed-codex-connection",
              profileRoot: path.dirname(managedHome),
              nativeStateRoot: path.join(path.dirname(managedHome), "native-state"),
              childEnvironment: (baseEnv) => ({
                ...baseEnv,
                CODEX_HOME: managedHome,
                OPENAI_API_KEY: "selected-connection-key",
              }),
            },
          })
          .pipe(
            Effect.tap((generated) =>
              Effect.sync(() => expect(generated.title).toBe("Managed Codex title")),
            ),
            Effect.ensuring(
              Effect.sync(() => {
                delete process.env.PENKRA_FAKE_CODEX_EXPECT_CODEX_HOME;
                delete process.env.PENKRA_FAKE_CODEX_EXPECT_OPENAI_API_KEY;
              }),
            ),
          );
      }),
    ),
  );
});
