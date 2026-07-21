import { useQuery } from "@tanstack/react-query";

import ChatMarkdown from "../components/ChatMarkdown";
import { PanelStateMessage } from "../components/chat/PanelStateMessage";
import { penkraInstructionsQueryOptions } from "./reactQuery";

export function PenkraInstructionsPane({
  scope,
  clientId,
}: {
  scope: "hq" | "client" | "client-specific" | null;
  clientId: string | null;
}) {
  const hqQuery = useQuery({
    ...penkraInstructionsQueryOptions({ scope: "hq" }),
    enabled: scope === "hq",
  });
  const genericClientQuery = useQuery({
    ...penkraInstructionsQueryOptions({ scope: "client" }),
    enabled: scope === "client",
  });
  const clientQuery = useQuery({
    ...penkraInstructionsQueryOptions({
      scope: "client-specific",
      clientId: clientId ?? "unselected",
    }),
    enabled: scope === "client-specific" && clientId !== null,
  });

  if (scope === null || (scope === "client-specific" && clientId === null)) {
    return <PanelStateMessage>Select a Penkra project to view its instructions.</PanelStateMessage>;
  }

  const query = scope === "hq" ? hqQuery : scope === "client" ? genericClientQuery : clientQuery;
  const error = query.error;
  if (error) {
    return <PanelStateMessage>{error.message}</PanelStateMessage>;
  }
  if (query.isPending) {
    return <PanelStateMessage>Loading instructions...</PanelStateMessage>;
  }

  const body = query.data?.body ?? "";

  if (scope === "client-specific" && body === "") {
    return (
      <PanelStateMessage>
        No client-specific instructions are set. Use penkra client update {clientId} to set them.
      </PanelStateMessage>
    );
  }

  if (body === "") {
    return <PanelStateMessage>{scope}.md is empty.</PanelStateMessage>;
  }

  return (
    <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
      <ChatMarkdown text={body} cwd={undefined} isStreaming={false} />
    </div>
  );
}
