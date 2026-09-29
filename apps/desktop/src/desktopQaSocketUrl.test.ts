import { describe, expect, it } from "vitest";

import { verifyQaSocketClient } from "@penkra/shared/diagnostics/qaSocketTicket";

import { desktopQaSocketUrl } from "./desktopQaSocketUrl";

describe("desktopQaSocketUrl", () => {
  it("adds a valid single-use ticket while preserving the server token", () => {
    const config = {
      dir: "/tmp/diagnostics-qa-proof",
      runId: "00000000-0000-4000-8000-000000000000",
      secret: "a".repeat(64),
    };
    const url = new URL(
      desktopQaSocketUrl({
        baseUrl: "ws://127.0.0.1:1234/?token=server-token",
        config,
        clientId: "b".repeat(32),
        ticketId: "c".repeat(32),
      }),
    );

    expect(url.searchParams.get("token")).toBe("server-token");
    expect(
      verifyQaSocketClient(
        config,
        url.searchParams.get("qaClientId"),
        url.searchParams.get("qaTicketId"),
        url.searchParams.get("qaClientSignature"),
      ),
    ).toBe(true);
  });
});
