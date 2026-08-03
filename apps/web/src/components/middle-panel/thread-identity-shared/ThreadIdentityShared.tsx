import type { ProviderKind } from "@penkra/contracts";
import { FaGithub } from "react-icons/fa6";

import { ProviderIcon } from "~/components/ProviderIcon";
import { PinBadgeShared } from "~/components/left-rail/pin-badge-shared/PinBadgeShared";
import { cn } from "~/lib/utils";

export interface ThreadIdentitySharedProps {
  className?: string;
  harness?: ProviderKind | "github";
  pinned?: boolean;
}

/** Pencil's shared provider identity used by thread rows and thread top bars. */
export function ThreadIdentityShared({
  className,
  harness = "codex",
  pinned = false,
}: ThreadIdentitySharedProps) {
  return (
    <span
      className={cn(
        "relative inline-flex size-3.5 shrink-0 items-center justify-center",
        className,
      )}
      data-pencil-component="Z2u2n"
      data-provider={harness}
      data-slot="thread-identity"
    >
      {harness === "github" ? (
        <FaGithub aria-hidden className="size-3.5" />
      ) : (
        <ProviderIcon className="size-3.5" provider={harness} />
      )}
      {pinned ? <PinBadgeShared className="-right-0.5 -bottom-0.5 size-2" /> : null}
    </span>
  );
}
