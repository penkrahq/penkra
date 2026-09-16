import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { describe, expect, it } from "vitest";

import {
  claudeOAuthUrlFromOutput,
  readClaudeManagedAccount,
  startClaudeManagedAccountLogin,
} from "./claudeManagedAccountLogin.ts";

const input = {
  binaryPath: "/managed/claude",
  cwd: "/workspace",
  env: {},
};

describe("readClaudeManagedAccount", () => {
  it("uses Claude's signed-out JSON even when the native command exits nonzero", async () => {
    const account = await readClaudeManagedAccount(input, (_binary, _args, _options, done) => {
      done(new Error("exit code 1"), JSON.stringify({ loggedIn: false }));
    });

    expect(account).toBeNull();
  });

  it("returns the exact signed-in Claude account metadata", async () => {
    const account = await readClaudeManagedAccount(input, (_binary, _args, _options, done) => {
      done(
        null,
        JSON.stringify({
          loggedIn: true,
          authMethod: "claude.ai",
          email: "person@example.com",
          subscriptionType: "pro",
        }),
      );
    });

    expect(account).toEqual({
      type: "claude-account",
      email: "person@example.com",
      subscriptionType: "pro",
    });
  });

  it("does not invent account state when Claude returns no status JSON", async () => {
    await expect(
      readClaudeManagedAccount(input, (_binary, _args, _options, done) => {
        done(new Error("could not execute Claude"), "");
      }),
    ).rejects.toThrow("could not execute Claude");
  });
});

describe("startClaudeManagedAccountLogin", () => {
  it("surfaces Claude's printed OAuth URL so the Windows host can open it", async () => {
    const stdout = new PassThrough();
    const child = Object.assign(new EventEmitter(), {
      pid: 42,
      stdin: new PassThrough(),
      stdout,
      stderr: new PassThrough(),
      exitCode: null,
      signalCode: null,
      kill: () => true,
    }) as unknown as ChildProcessWithoutNullStreams;
    const authUrl =
      "https://claude.com/cai/oauth/authorize?client_id=penkra-test&state=windows-test";
    setTimeout(() => {
      stdout.write(`Open this URL to sign in: ${authUrl}\n`);
    }, 0);

    const handle = await startClaudeManagedAccountLogin(input, () => child, "win32");

    expect(handle.authUrl).toBe(authUrl);
  });

  it("extracts Claude's OSC 8 hyperlink target", () => {
    const authUrl = "https://claude.com/cai/oauth/authorize?client_id=test&state=osc";

    expect(claudeOAuthUrlFromOutput(`\u001b]8;;${authUrl}\u0007Sign in\u001b]8;;\u0007`)).toBe(
      authUrl,
    );
  });

  it("does not surface an untrusted authorization URL", () => {
    expect(
      claudeOAuthUrlFromOutput("Open https://example.com/oauth/authorize?state=secret"),
    ).toBeNull();
  });
});
