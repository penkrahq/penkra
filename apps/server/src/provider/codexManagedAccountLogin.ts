// FILE: codexManagedAccountLogin.ts
// Purpose: Runs one Codex-owned browser login without exposing OAuth credentials to Penkra.

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";

import { prepareWindowsSafeProcess } from "@penkra/shared/windowsProcess";

import { buildCodexInitializeParams } from "../codexAppServerManager.ts";
import { CodexJsonlFramer, CodexJsonlWriter } from "../codexAppServerTransport.ts";

type JsonRecord = Record<string, unknown>;

export interface CodexManagedAccountSnapshot {
  readonly type: "chatgpt";
  readonly email: string | null;
  readonly planType: string | null;
}

export interface CodexManagedLoginHandle {
  readonly loginId: string;
  readonly authUrl: string;
  readonly completion: Promise<CodexManagedAccountSnapshot>;
  readonly cancel: () => Promise<void>;
}

export interface CodexManagedLoginProcessFactoryInput {
  readonly binaryPath: string;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}

export type CodexManagedLoginProcessFactory = (
  input: CodexManagedLoginProcessFactoryInput,
) => ChildProcessWithoutNullStreams;

export type CodexManagedAccountProbe = (
  input: CodexManagedLoginProcessFactoryInput,
) => Promise<CodexManagedAccountSnapshot | null>;

interface CodexManagedAccountVerificationPolicy {
  readonly attempts: number;
  readonly delayMs: number;
  readonly sleep: (delayMs: number) => Promise<void>;
}

const defaultAccountVerificationPolicy: CodexManagedAccountVerificationPolicy = {
  attempts: 40,
  delayMs: 100,
  sleep: (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
};

const defaultProcessFactory: CodexManagedLoginProcessFactory = (input) => {
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
};

function record(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Codex login response is missing ${field}.`);
  }
  return value;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export async function readCodexManagedAccount(
  input: CodexManagedLoginProcessFactoryInput,
  processFactory: CodexManagedLoginProcessFactory = defaultProcessFactory,
): Promise<CodexManagedAccountSnapshot | null> {
  const child = processFactory(input);
  const writer = new CodexJsonlWriter(child.stdin);
  const framer = new CodexJsonlFramer();
  let nextId = 1;
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  const fail = (error: Error) => {
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  const request = async (method: string, params: unknown): Promise<unknown> => {
    const id = nextId++;
    const result = new Promise<unknown>((resolve, reject) => pending.set(id, { resolve, reject }));
    await writer.write({ id, method, params });
    return result;
  };
  child.stdout.on("data", (chunk: Buffer) => {
    try {
      for (const frame of framer.push(chunk)) {
        if (!frame.trim()) continue;
        const message = record(JSON.parse(frame));
        if (!message || typeof message.id !== "number") continue;
        const waiter = pending.get(message.id);
        if (!waiter) continue;
        pending.delete(message.id);
        const rpcError = record(message.error);
        if (rpcError) {
          waiter.reject(new Error(optionalString(rpcError.message) ?? "Codex request failed."));
        } else {
          waiter.resolve(message.result);
        }
      }
    } catch (cause) {
      fail(cause instanceof Error ? cause : new Error(String(cause)));
    }
  });
  child.once("error", (cause) => fail(cause));
  child.once("exit", (code, signal) =>
    fail(new Error(`Codex account verification stopped (${code ?? signal ?? "unknown"}).`)),
  );
  try {
    await request("initialize", buildCodexInitializeParams());
    await writer.write({ method: "initialized" });
    const account = record(record(await request("account/read", { refreshToken: false }))?.account);
    if (account === null) return null;
    if (account.type !== "chatgpt") {
      throw new Error("The isolated Codex profile does not contain a ChatGPT account.");
    }
    return {
      type: "chatgpt",
      email: optionalString(account.email),
      planType: optionalString(account.planType),
    };
  } finally {
    writer.close();
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  }
}

export async function startCodexManagedAccountLogin(
  input: CodexManagedLoginProcessFactoryInput,
  processFactory: CodexManagedLoginProcessFactory = defaultProcessFactory,
  verificationPolicy: CodexManagedAccountVerificationPolicy = defaultAccountVerificationPolicy,
): Promise<CodexManagedLoginHandle> {
  const child = processFactory(input);
  const writer = new CodexJsonlWriter(child.stdin);
  const framer = new CodexJsonlFramer();
  let nextId = 1;
  let settled = false;
  let verificationRequested = false;
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  let resolveCompletion!: (snapshot: CodexManagedAccountSnapshot) => void;
  let rejectCompletion!: (error: Error) => void;
  const completion = new Promise<CodexManagedAccountSnapshot>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });

  const fail = (error: Error) => {
    if (settled) return;
    settled = true;
    for (const request of pending.values()) request.reject(error);
    pending.clear();
    rejectCompletion(error);
  };
  const request = async (method: string, params: unknown): Promise<unknown> => {
    const id = nextId++;
    const result = new Promise<unknown>((resolve, reject) => pending.set(id, { resolve, reject }));
    await writer.write({ id, method, params });
    return result;
  };

  const verifySelectedAccount = () => {
    if (settled || verificationRequested) return;
    verificationRequested = true;
    void (async () => {
      for (let attempt = 1; attempt <= verificationPolicy.attempts; attempt += 1) {
        const account = record(
          record(await request("account/read", { refreshToken: false }))?.account,
        );
        if (account?.type === "chatgpt") {
          settled = true;
          resolveCompletion({
            type: "chatgpt",
            email: optionalString(account.email),
            planType: optionalString(account.planType),
          });
          return;
        }
        if (account !== null) throw new Error("Codex selected a non-ChatGPT account.");
        if (attempt < verificationPolicy.attempts)
          await verificationPolicy.sleep(verificationPolicy.delayMs);
      }
      throw new Error(
        "Codex reported a successful sign in, but the ChatGPT account did not become readable.",
      );
    })().catch((cause) => fail(cause instanceof Error ? cause : new Error(String(cause))));
  };

  child.stdout.on("data", (chunk: Buffer) => {
    try {
      for (const frame of framer.push(chunk)) {
        if (!frame.trim()) continue;
        const message = record(JSON.parse(frame));
        if (!message) continue;
        if (typeof message.id === "number") {
          const waiter = pending.get(message.id);
          if (!waiter) continue;
          pending.delete(message.id);
          const rpcError = record(message.error);
          if (rpcError)
            waiter.reject(new Error(optionalString(rpcError.message) ?? "Codex request failed."));
          else waiter.resolve(message.result);
          continue;
        }
        const params = record(message.params);
        if (message.method === "account/login/completed") {
          if (params?.success !== true) {
            fail(new Error(optionalString(params?.error) ?? "Codex sign in did not complete."));
            continue;
          }
          verifySelectedAccount();
          continue;
        }
        if (message.method === "account/updated" && params?.authMode === "chatgpt") {
          verifySelectedAccount();
        }
      }
    } catch (cause) {
      fail(cause instanceof Error ? cause : new Error(String(cause)));
    }
  });
  // Always consume stderr so a verbose provider cannot block on a full pipe.
  // Authentication output is intentionally not logged because it may contain secrets.
  child.stderr.resume();
  child.once("error", (cause) => fail(cause));
  const failForStoppedProcess = (code: number | null, signal: NodeJS.Signals | null) => {
    if (!settled)
      fail(new Error(`Codex sign in stopped before completion (${code ?? signal ?? "unknown"}).`));
  };
  child.once("exit", failForStoppedProcess);
  child.once("close", failForStoppedProcess);

  await request("initialize", buildCodexInitializeParams());
  await writer.write({ method: "initialized" });
  const started = record(
    await request("account/login/start", {
      type: "chatgpt",
    }),
  );
  const loginId = requiredString(started?.loginId, "loginId");
  const authUrl = requiredString(started?.authUrl, "authUrl");

  return {
    loginId,
    authUrl,
    completion: completion.finally(() => {
      writer.close();
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    }),
    cancel: async () => {
      if (!settled) await request("account/login/cancel", { loginId });
      fail(new Error("Codex sign in was cancelled."));
    },
  };
}
