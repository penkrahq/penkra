import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import { penkraQueryKeys } from "./reactQuery";
import { PenkraInstructionsPane } from "./PenkraInstructionsPane";

function renderPane(input: {
  scope: "hq" | "client" | "client-specific";
  clientId?: string;
  records: ReadonlyArray<{
    scope: "hq" | "client" | "client-specific";
    clientId?: string;
    body: string;
  }>;
}): string {
  const queryClient = new QueryClient();
  for (const record of input.records) {
    queryClient.setQueryData(
      penkraQueryKeys.instruction({
        scope: record.scope,
        ...(record.clientId ? { clientId: record.clientId } : {}),
      }),
      { body: record.body, revision: "test-revision", updatedAt: "2026-07-20T00:00:00Z" },
    );
  }

  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <PenkraInstructionsPane scope={input.scope} clientId={input.clientId ?? null} />
    </QueryClientProvider>,
  );
}

describe("PenkraInstructionsPane", () => {
  it("renders one remote authorship per existing dock pane", () => {
    const markup = renderPane({
      scope: "hq",
      records: [{ scope: "hq", body: "HQ-only rule" }],
    });

    expect(markup).toContain("HQ-only rule");
    expect(markup).not.toContain("Generic client rule");
    expect(markup).not.toContain('role="dialog"');
  });

  it("renders the generic client document in its own pane", () => {
    const markup = renderPane({
      scope: "client",
      records: [{ scope: "client", body: "Generic client rule" }],
    });

    expect(markup).toContain("Generic client rule");
    expect(markup).not.toContain("HQ-only rule");
  });

  it("renders only the selected client's remote instructions", () => {
    const markup = renderPane({
      scope: "client-specific",
      clientId: "client-1",
      records: [{ scope: "client-specific", clientId: "client-1", body: "Client-only rule" }],
    });

    expect(markup).toContain("Client-only rule");
    expect(markup).not.toContain("hq.md");
    expect(markup).not.toContain("client.md");
  });

  it("uses the existing panel empty state when the remote client document is blank", () => {
    const markup = renderPane({
      scope: "client-specific",
      clientId: "client-1",
      records: [{ scope: "client-specific", clientId: "client-1", body: "" }],
    });

    expect(markup).toContain("No client-specific instructions are set");
    expect(markup).toContain("penkra client update client-1");
  });
});
