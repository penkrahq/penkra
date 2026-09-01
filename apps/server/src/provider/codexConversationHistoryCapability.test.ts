import { describe, expect, it } from "vitest";

import {
  codexConversationHistoryMutationUnavailableMessage,
  resolveCodexConversationHistoryMutationCapability,
} from "./codexConversationHistoryCapability.ts";

describe("resolveCodexConversationHistoryMutationCapability", () => {
  it("supports only an explicitly declared legacy thread", () => {
    expect(
      resolveCodexConversationHistoryMutationCapability({
        thread: { id: "native-thread", historyMode: "legacy" },
      }),
    ).toEqual({ state: "supported", historyMode: "legacy" });
  });

  it("fails closed for a declared paginated thread", () => {
    const capability = resolveCodexConversationHistoryMutationCapability({
      thread: { id: "native-thread", historyMode: "paginated" },
    });
    expect(capability).toEqual({
      state: "incompatible-codex-protocol",
      historyMode: "paginated",
    });
    expect(
      codexConversationHistoryMutationUnavailableMessage(
        capability as Exclude<typeof capability, { state: "supported" }>,
      ),
    ).toContain("no history mutation was sent");
  });

  it.each([
    undefined,
    null,
    1,
    false,
    [],
    { thread: { id: "native-thread" } },
    { thread: { id: "native-thread", historyMode: null } },
  ])("does not infer legacy mode from missing or malformed input %#", (response) => {
    expect(resolveCodexConversationHistoryMutationCapability(response)).toEqual({
      state: "incompatible-codex-protocol",
      historyMode: null,
    });
  });

  it("keeps an unknown declared mode distinct from an invalid protocol response", () => {
    expect(
      resolveCodexConversationHistoryMutationCapability({
        thread: { id: "native-thread", historyMode: "future-mode" },
      }),
    ).toEqual({ state: "unsupported-history-mode", historyMode: "future-mode" });
  });
});
