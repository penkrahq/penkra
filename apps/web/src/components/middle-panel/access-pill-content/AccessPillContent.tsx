import { IconChevronDown } from "@tabler/icons-react";

import { CentralIcon } from "~/lib/central-icons";

export interface AccessPillContentProps {
  hideLabel?: boolean;
  label?: string;
}

export function AccessPillContent({
  hideLabel = false,
  label = "Full access",
}: AccessPillContentProps) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1" data-pencil-component="k4x6m">
      <CentralIcon
        aria-hidden="true"
        className="size-[13px] shrink-0"
        data-pencil-node="Bo845"
        name="shield-access"
      />
      <span className={hideLabel ? "sr-only" : undefined}>{label}</span>
      <IconChevronDown className={hideLabel ? "hidden" : "size-[11px]"} />
    </span>
  );
}
