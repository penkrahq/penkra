import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import {
  readCodexManagedAccount,
  startCodexManagedAccountLogin,
} from "./codexManagedAccountLogin.ts";

function fakeCodexLoginProcess() {
  const child = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    kill: (signal?: NodeJS.Signals) => boolean;
  };
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = () => true;
  let buffer = "";
  child.stdin.on("data", (chunk) => {
    buffer += chunk.toString();
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const frame = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      const message = JSON.parse(frame) as { id?: number; method: string };
      if (message.method === "initialize") {
        child.stdout.write(`${JSON.stringify({ id: message.id, result: {} })}\n`);
      } else if (message.method === "account/login/start") {
        child.stdout.write(
          `${JSON.stringify({ id: message.id, result: { loginId: "login-1", authUrl: "https://auth.example/login" } })}\n`,
        );
      } else if (message.method === "account/read") {
        child.stdout.write(
          `${JSON.stringify({ id: message.id, result: { account: { type: "chatgpt", email: "person@example.com", planType: "pro" } } })}\n`,
        );
      }
    }
  });
  return child;
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
    const child = fakeCodexLoginProcess();
    const handle = await startCodexManagedAccountLogin(
      { binaryPath: "/managed/codex", cwd: "/workspace", env: {} },
      () => child as never,
    );

    expect(handle.loginId).toBe("login-1");
    expect(handle.authUrl).toBe("https://auth.example/login");
    child.stdout.write(
      `${JSON.stringify({ method: "account/login/completed", params: { loginId: "login-1", success: true, error: null } })}\n`,
    );
    await expect(handle.completion).resolves.toEqual({
      type: "chatgpt",
      email: "person@example.com",
      planType: "pro",
    });
  });
});
