import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import {
  readCodexManagedAccount,
  startCodexManagedAccountLogin,
} from "./codexManagedAccountLogin.ts";

function fakeCodexLoginProcess(
  accountResponses: Array<Record<string, unknown> | null> = [
    { type: "chatgpt", email: "person@example.com", planType: "pro" },
  ],
) {
  const child = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    kill: (signal?: NodeJS.Signals) => boolean;
    requests: Array<{ method: string; params?: unknown }>;
  };
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = () => true;
  child.requests = [];
  let buffer = "";
  child.stdin.on("data", (chunk) => {
    buffer += chunk.toString();
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const frame = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      const message = JSON.parse(frame) as { id?: number; method: string; params?: unknown };
      child.requests.push(message);
      if (message.method === "initialize") {
        child.stdout.write(`${JSON.stringify({ id: message.id, result: {} })}\n`);
      } else if (message.method === "account/login/start") {
        child.stdout.write(
          `${JSON.stringify({ id: message.id, result: { loginId: "login-1", authUrl: "https://auth.example/login" } })}\n`,
        );
      } else if (message.method === "account/read") {
        const account = accountResponses.shift() ?? null;
        child.stdout.write(`${JSON.stringify({ id: message.id, result: { account } })}\n`);
      }
    }
  });
  return child;
}

async function startFakeLogin(
  accountResponses?: Array<Record<string, unknown> | null>,
  verificationAttempts = 3,
) {
  const child = fakeCodexLoginProcess(accountResponses);
  const handle = await startCodexManagedAccountLogin(
    { binaryPath: "/managed/codex", cwd: "/workspace", env: {} },
    () => child as never,
    { attempts: verificationAttempts, delayMs: 0, sleep: async () => undefined },
  );
  return { child, handle };
}

describe("Codex managed account login", () => {
  it("reads the exact isolated account without starting another login", async () => {
    const child = fakeCodexLoginProcess();
    await expect(
      readCodexManagedAccount(
        { binaryPath: "/managed/codex", cwd: "/workspace", env: { CODEX_HOME: "/isolated" } },
        () => child as never,
      ),
    ).resolves.toEqual({
      type: "chatgpt",
      email: "person@example.com",
      planType: "pro",
    });
  });

  it("returns the browser URL and resolves only after provider account verification", async () => {
    const { child, handle } = await startFakeLogin();

    expect(handle.loginId).toBe("login-1");
    expect(handle.authUrl).toBe("https://auth.example/login");
    expect(
      child.requests.find((request) => request.method === "account/login/start")?.params,
    ).toEqual({ type: "chatgpt" });
    child.stdout.write(
      `${JSON.stringify({ method: "account/login/completed", params: { loginId: "login-1", success: true, error: null } })}\n`,
    );
    await expect(handle.completion).resolves.toEqual({
      type: "chatgpt",
      email: "person@example.com",
      planType: "pro",
    });
  });

  it("verifies the account when Codex reports the authoritative account update", async () => {
    const { child, handle } = await startFakeLogin();

    child.stdout.write(
      `${JSON.stringify({ method: "account/updated", params: { authMode: "chatgpt", planType: "pro" } })}\n`,
    );

    await expect(handle.completion).resolves.toEqual({
      type: "chatgpt",
      email: "person@example.com",
      planType: "pro",
    });
  });

  it("waits for the successful login's keyring entry to become readable", async () => {
    const { child, handle } = await startFakeLogin([
      null,
      { type: "chatgpt", email: "person@example.com", planType: "pro" },
    ]);

    child.stdout.write(
      `${JSON.stringify({ method: "account/login/completed", params: { loginId: "login-1", success: true, error: null } })}\n`,
    );

    await expect(handle.completion).resolves.toEqual({
      type: "chatgpt",
      email: "person@example.com",
      planType: "pro",
    });
    expect(child.requests.filter((request) => request.method === "account/read")).toHaveLength(2);
  });

  it("fails closed when a successful login never exposes an authoritative account", async () => {
    const { child, handle } = await startFakeLogin([null, null, null]);

    child.stdout.write(
      `${JSON.stringify({ method: "account/login/completed", params: { loginId: "login-1", success: true, error: null } })}\n`,
    );

    await expect(handle.completion).rejects.toThrow(
      "Codex reported a successful sign in, but the ChatGPT account did not become readable.",
    );
  });

  it("fails if the provider closes before a terminal login notification", async () => {
    const { child, handle } = await startFakeLogin();

    child.emit("close", 1, null);

    await expect(handle.completion).rejects.toThrow("Codex sign in stopped before completion (1).");
  });
});
