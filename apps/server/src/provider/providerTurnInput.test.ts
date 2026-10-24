// FILE: providerTurnInput.test.ts
// Purpose: Covers provider-specific prompt text normalization for selected skills.
// Layer: Server provider tests
// Exports: Vitest cases for provider prompt preparation.

import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ThreadId } from "@penkra/contracts";
import { Effect, Option } from "effect";
import { describe, expect, it, vi } from "vitest";

import {
  buildProviderTurnInput,
  formatUserTurnMember,
  normalizeSkillMentionTextForProvider,
  resolveProviderTurnContext,
} from "./providerTurnInput.ts";

describe("normalizeSkillMentionTextForProvider", () => {
  it("translates slash-selected skills to Codex dollar mentions before provider dispatch", () => {
    expect(
      normalizeSkillMentionTextForProvider({
        provider: "codex",
        messageText: "Use /check-code and /recap please",
        skills: [
          { name: "check-code", path: "/skills/check-code/SKILL.md" },
          { name: "recap", path: "/skills/recap/SKILL.md" },
        ],
      }),
    ).toBe("Use $check-code and $recap please");
  });

  it("leaves non-Codex slash skills untouched", () => {
    expect(
      normalizeSkillMentionTextForProvider({
        provider: "opencode",
        messageText: "Use /check-code please",
        skills: [{ name: "check-code", path: "/skills/check-code/SKILL.md" }],
      }),
    ).toBe("Use /check-code please");
  });
});

describe("provider turn prompt preparation", () => {
  it("keeps ordinary user input and native file mentions without reading threads", async () => {
    const getThreadDetailById = vi.fn(() => Effect.succeed(Option.none()));
    const getThreadShellById = vi.fn(() => Effect.succeed(Option.none()));
    const mention = { name: "README.md", path: "/repo/README.md" };
    const result = await Effect.runPromise(
      resolveProviderTurnContext(
        {
          messages: [{ text: "read this", origin: { _tag: "user" } }],
          mentions: [mention],
          maxContextChars: 0,
        },
        { getThreadDetailById },
      ),
    );
    expect(result).toEqual({ messageText: "read this", providerMentions: [mention] });
    expect(getThreadDetailById).not.toHaveBeenCalled();
    expect(getThreadShellById).not.toHaveBeenCalled();
  });

  it("attributes an agent message without depending on mutable sender metadata", async () => {
    const sender = ThreadId.make("sender-thread");
    const getThreadDetailById = vi.fn(() => Effect.succeed(Option.none()));
    const getThreadShellById = vi.fn(() => Effect.succeed(Option.none()));
    const result = await Effect.runPromise(
      resolveProviderTurnContext(
        {
          messages: [{ text: "a new task", origin: { _tag: "agent", senderThreadId: sender } }],
          mentions: undefined,
          maxContextChars: 0,
        },
        { getThreadDetailById },
      ),
    );
    expect(getThreadShellById).not.toHaveBeenCalled();
    expect(getThreadDetailById).not.toHaveBeenCalled();
    expect(result.messageText).toContain(`Thread ID: ${sender}`);
    expect(result.messageText).toMatch(
      /<agent_message_sender>[\s\S]*<\/agent_message_sender>\n\na new task$/,
    );
  });

  it("normalizes empty provider input without inserting text", async () => {
    expect(
      await Effect.runPromise(
        buildProviderTurnInput({
          threadId: ThreadId.make("thread"),
          provider: "codex",
          messageText: "  ",
          skills: undefined,
          maxSkillChars: 0,
        }),
      ),
    ).toBeUndefined();
  });

  it("inlines portable skill content only when it fits the supplied budget", async () => {
    const directory = await mkdtemp(join(tmpdir(), "penkra-provider-turn-input-"));
    try {
      const path = join(directory, "SKILL.md");
      await writeFile(path, "Verify the changed branch.");
      const input = {
        threadId: ThreadId.make("thread"),
        provider: "opencode" as const,
        messageText: "do this",
        skills: [{ name: "check", path }],
        maxSkillChars: 1024,
      };
      const prepared = await Effect.runPromise(buildProviderTurnInput(input));
      expect(prepared).toContain("Verify the changed branch.");
      expect(prepared?.startsWith("do this\n\n")).toBe(true);
      expect(await Effect.runPromise(buildProviderTurnInput({ ...input, maxSkillChars: 0 }))).toBe(
        "do this",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

it("passes recovery text to the provider unchanged", () => {
  const text = "Continue the existing task.";
  expect(formatUserTurnMember({ text, origin: { _tag: "recovery" } })).toBe(text);
});
