import { describe, expect, it } from "vitest";

import { readClaudeManagedAccount } from "./claudeManagedAccountLogin.ts";

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
