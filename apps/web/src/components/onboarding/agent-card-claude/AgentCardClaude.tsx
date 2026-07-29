import type { ComponentProps } from "react";

import { AgentCardVerticalShared } from "../agent-card-vertical-shared/AgentCardVerticalShared";

export type AgentCardClaudeProps = Omit<
  ComponentProps<typeof AgentCardVerticalShared>,
  "provider"
>;

export function AgentCardClaude(props: AgentCardClaudeProps) {
  return (
    <AgentCardVerticalShared
      data-pencil-component="k5hz3"
      description="Not connected"
      provider="claudeAgent"
      {...props}
    >
      {props.children ?? "Claude"}
    </AgentCardVerticalShared>
  );
}
