import { describe, expect, it } from "vitest";
import {
  providerNativeResumeCursor,
  providerNativeResumeIdentity,
} from "./nativeResumeIdentity.ts";

describe("canonical native resume identity", () => {
  it.each([
    ["codex", { threadId: "session" }],
    ["claudeAgent", { resume: "session" }],
    ["opencode", { openCodeSessionId: "session" }],
  ] as const)("reconstructs the %s cursor solely from provider_session_id", (provider, cursor) => {
    const actual = providerNativeResumeCursor(provider, "session");
    expect(actual).toEqual(cursor);
    expect(providerNativeResumeIdentity(provider, actual)).toBe("session");
  });
});
