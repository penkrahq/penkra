import type { ProviderKind } from "@synara/contracts";
import { IconRefresh } from "@tabler/icons-react";
import type { ComponentProps } from "react";

import { ProviderIcon } from "~/components/ProviderIcon";

import { LeftRailRow } from "../row-shared/LeftRailRow";

export interface ThreadRowSharedProps
  extends Omit<ComponentProps<typeof LeftRailRow>, "leading" | "trailing"> {
  provider?: ProviderKind;
  refreshing?: boolean;
}

export function ThreadRowShared({
  children = "Main",
  provider = "claudeAgent",
  refreshing = false,
  ...props
}: ThreadRowSharedProps) {
  return (
    <LeftRailRow
      leading={<ProviderIcon className="size-3.5" provider={provider} />}
      trailing={
        refreshing ? (
          <IconRefresh aria-label="Refreshing" className="size-[13px] animate-spin" />
        ) : null
      }
      {...props}
    >
      {children}
    </LeftRailRow>
  );
}
