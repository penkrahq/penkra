import type { ComponentProps } from "react";

import { SwitchShared } from "~/components/foundations/switch-shared/SwitchShared";

export type PermissionToggleSharedProps = ComponentProps<typeof SwitchShared>;

export function PermissionToggleShared(props: PermissionToggleSharedProps) {
  return <SwitchShared {...props} />;
}
