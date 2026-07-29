import type { ComponentProps } from "react";

import { AgentCardVerticalShared } from "../agent-card-vertical-shared/AgentCardVerticalShared";

export type AgentCardCursorProps = Omit<
  ComponentProps<typeof AgentCardVerticalShared>,
  "provider"
>;

export function AgentCardCursor(props: AgentCardCursorProps) {
  return (
    <AgentCardVerticalShared
      data-pencil-component="lzAV8"
      description="Not connected"
      provider="cursor"
      {...props}
    >
      {props.children ?? "Cursor"}
    </AgentCardVerticalShared>
  );
}
