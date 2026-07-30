import { TopBarThread, type TopBarThreadProps } from "./TopBarThread";

/**
 * Production adapter for Pencil's thread top bar.
 *
 * The application header remains the behavior owner until each action has a
 * Pencil counterpart; this adapter supplies the shared component boundary.
 */
export function TopBarThreadAdapter(props: TopBarThreadProps) {
  return <TopBarThread {...props} />;
}
