// FILE: codexManagedApiKeyLogin.ts
// Purpose: Imports and verifies an API key through Codex's native isolated profile.

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

import { prepareWindowsSafeProcess } from "@penkra/shared/windowsProcess";

export interface CodexManagedApiKeySnapshot {
  readonly type: "api-key";
}

export interface CodexManagedApiKeyLoginInput {
  readonly binaryPath: string;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}

export interface CodexManagedApiKeyImportHandle {
  readonly completion: Promise<CodexManagedApiKeySnapshot>;
  readonly cancel: () => Promise<void>;
}

export function isCodexManagedApiKeyStatus(stdout: string, stderr: string): boolean {
  return `${stdout}\n${stderr}`
    .split(/\r?\n/u)
    .some((line) => line.trimStart().startsWith("Logged in using an API key"));
}

export async function readCodexManagedApiKey(
  input: CodexManagedApiKeyLoginInput,
): Promise<CodexManagedApiKeySnapshot | null> {
  try {
    const { stdout, stderr } = await promisify(execFile)(input.binaryPath, ["login", "status"], {
      cwd: input.cwd,
      env: input.env,
      timeout: 30_000,
      windowsHide: true,
    });
    return isCodexManagedApiKeyStatus(stdout, stderr) ? { type: "api-key" } : null;
  } catch {
    return null;
  }
}

export function startCodexManagedApiKeyImport(
  input: CodexManagedApiKeyLoginInput & { readonly secret: string },
): CodexManagedApiKeyImportHandle {
  const prepared = prepareWindowsSafeProcess(input.binaryPath, ["login", "--with-api-key"], {
    cwd: input.cwd,
    env: input.env,
  });
  const child = spawn(prepared.command, prepared.args, {
    cwd: input.cwd,
    env: input.env,
    stdio: ["pipe", "pipe", "pipe"],
    shell: prepared.shell,
    windowsHide: prepared.windowsHide,
    windowsVerbatimArguments: prepared.windowsVerbatimArguments,
  });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = `${stderr}${chunk.toString("utf8")}`.slice(-4_000);
  });
  child.stdin.end(`${input.secret}\n`);
  let cancelled = false;
  const completion = new Promise<void>((resolve, reject) => {
    child.once("error", (cause) => {
      if (cancelled) reject(new Error("Codex API key import was cancelled."));
      else reject(cause);
    });
    child.once("exit", (code, signal) => {
      if (cancelled) return reject(new Error("Codex API key import was cancelled."));
      if (code === 0) resolve();
      else
        reject(
          new Error(
            stderr.trim() || `Codex API key import stopped (${code ?? signal ?? "unknown"}).`,
          ),
        );
    });
  }).then(async () => {
    const account = await readCodexManagedApiKey(input);
    if (account === null)
      throw new Error("Codex did not retain the API key in its isolated profile.");
    return account;
  });
  return {
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
