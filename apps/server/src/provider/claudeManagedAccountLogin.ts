// FILE: claudeManagedAccountLogin.ts
// Purpose: Runs and verifies one Claude-owned account login in an isolated profile.

import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import { prepareWindowsSafeProcess } from "@penkra/shared/windowsProcess";

export interface ClaudeManagedAccountSnapshot {
  readonly type: "claude-account";
  readonly email: string | null;
  readonly subscriptionType: string | null;
}

export interface ClaudeManagedLoginHandle {
  readonly loginId: string;
  readonly authUrl: string | null;
  readonly completion: Promise<ClaudeManagedAccountSnapshot>;
  readonly cancel: () => Promise<void>;
}

export interface ClaudeManagedLoginInput {
  readonly binaryPath: string;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}

type ClaudeAuthStatusExec = (
  binaryPath: string,
  args: readonly string[],
  options: {
    readonly cwd: string;
    readonly env: NodeJS.ProcessEnv;
    readonly timeout: number;
    readonly windowsHide: boolean;
  },
  callback: (error: Error | null, stdout: string) => void,
) => void;

const optionalString = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value : null;

export const claudeOAuthUrlFromOutput = (output: string): string | null => {
  const candidates = output.match(/https:\/\/[^\s\u0000-\u001f\u007f]+/g) ?? [];
  for (const candidate of candidates) {
    try {
      const url = new URL(candidate);
      const isClaudeHost =
        url.hostname === "claude.com" ||
        url.hostname.endsWith(".claude.com") ||
        url.hostname === "claude.ai" ||
        url.hostname.endsWith(".claude.ai") ||
        url.hostname === "anthropic.com" ||
        url.hostname.endsWith(".anthropic.com");
      if (isClaudeHost && url.pathname.includes("/oauth/authorize")) return url.toString();
    } catch {
      // Claude's interactive output can contain partial URLs while a chunk is arriving.
    }
  }
  return null;
};

const waitForClaudeWindowsAuthUrl = async (
  child: ChildProcessWithoutNullStreams,
): Promise<string | null> =>
  new Promise((resolve) => {
    let output = "";
    let settled = false;
    const finish = (authUrl: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.stdout.off("data", onData);
      child.stderr.off("data", onData);
      resolve(authUrl);
    };
    const onData = (chunk: Buffer) => {
      output = `${output}${chunk.toString("utf8")}`.slice(-16_000);
      const authUrl = claudeOAuthUrlFromOutput(output);
      if (authUrl !== null) finish(authUrl);
    };
    const timeout = setTimeout(() => finish(null), 15_000);
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("error", () => finish(null));
    child.once("exit", () => finish(null));
  });

export async function readClaudeManagedAccount(
  input: ClaudeManagedLoginInput,
  execute: ClaudeAuthStatusExec = execFile as unknown as ClaudeAuthStatusExec,
): Promise<ClaudeManagedAccountSnapshot | null> {
  const stdout = await new Promise<string>((resolve, reject) => {
    execute(
      input.binaryPath,
      ["auth", "status", "--json"],
      {
        cwd: input.cwd,
        env: input.env,
        timeout: 30_000,
        windowsHide: true,
      },
      (error, output) => {
        // Claude returns its authoritative JSON status even when the command exits nonzero
        // for a signed-out profile. The JSON, not the exit code, is the account contract.
        if (output.trim().length > 0) {
          resolve(output);
          return;
        }
        if (error !== null) {
          reject(error);
          return;
        }
        resolve(output);
      },
    );
  });
  const raw = JSON.parse(stdout) as Record<string, unknown>;
  if (raw.loggedIn !== true || raw.authMethod === "api_key") return null;
  return {
    type: "claude-account",
    email: optionalString(raw.email),
    subscriptionType: optionalString(raw.subscriptionType),
  };
}

export async function startClaudeManagedAccountLogin(
  input: ClaudeManagedLoginInput,
  processFactory: (input: ClaudeManagedLoginInput) => ChildProcessWithoutNullStreams = (next) => {
    const prepared = prepareWindowsSafeProcess(next.binaryPath, ["auth", "login", "--claudeai"], {
      cwd: next.cwd,
      env: next.env,
    });
    return spawn(prepared.command, prepared.args, {
      cwd: next.cwd,
      env: next.env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: prepared.shell,
      windowsHide: prepared.windowsHide,
      windowsVerbatimArguments: prepared.windowsVerbatimArguments,
    });
  },
  platform: NodeJS.Platform = process.platform,
): Promise<ClaudeManagedLoginHandle> {
  const child = processFactory(input);
  let cancelled = false;
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = `${stderr}${chunk.toString("utf8")}`.slice(-4_000);
  });
  const completion = new Promise<ClaudeManagedAccountSnapshot>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (cancelled) return reject(new Error("Claude sign in was cancelled."));
      if (code !== 0) {
        return reject(
          new Error(
            stderr.trim() ||
              `Claude sign in stopped before completion (${code ?? signal ?? "unknown"}).`,
          ),
        );
      }
      void readClaudeManagedAccount(input).then(
        (account) =>
          account === null
            ? reject(new Error("Claude did not leave the isolated profile signed in."))
            : resolve(account),
        reject,
      );
    });
  });
  const authUrl = platform === "win32" ? await waitForClaudeWindowsAuthUrl(child) : null;
  return {
    loginId: `claude-auth-${child.pid ?? "pending"}`,
    authUrl,
    completion,
    cancel: async () => {
      cancelled = true;
      if (child.exitCode === null && child.signalCode === null) {
        await new Promise<void>((resolve) => {
          child.once("exit", () => resolve());
          child.once("error", () => resolve());
          child.kill("SIGTERM");
        });
      }
    },
  };
}
