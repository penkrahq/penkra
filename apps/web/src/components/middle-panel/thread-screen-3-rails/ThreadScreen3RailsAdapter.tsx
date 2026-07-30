import type { ComponentProps } from "react";

import { ThreadScreen3Rails } from "./ThreadScreen3Rails";

type ThreadScreen3RailsAdapterProps = Omit<
  ComponentProps<typeof ThreadScreen3Rails>,
  "layoutMode"
>;

/**
 * Production adapter for Pencil's three-rail thread shell.
 *
 * ChatView keeps ownership of its real transcript, composer, streaming state,
 * dialogs, and overlays while this component makes the Pencil shell the live
 * application boundary.
 */
export function ThreadScreen3RailsAdapter(props: ThreadScreen3RailsAdapterProps) {
  return <ThreadScreen3Rails {...props} layoutMode="application" />;
}
