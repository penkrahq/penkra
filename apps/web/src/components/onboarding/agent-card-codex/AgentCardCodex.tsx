import type { ComponentProps } from "react";

import { AgentCardVerticalShared } from "../agent-card-vertical-shared/AgentCardVerticalShared";

export type AgentCardCodexProps = Omit<
  ComponentProps<typeof AgentCardVerticalShared>,
  "provider"
>;

export function AgentCardCodex(props: AgentCardCodexProps) {
  return (
    <AgentCardVerticalShared
      data-pencil-component="TC6n2"
      description="Not connected"
      provider="codex"
      {...props}
    >
      {props.children ?? "Codex"}
    </AgentCardVerticalShared>
  );
}
