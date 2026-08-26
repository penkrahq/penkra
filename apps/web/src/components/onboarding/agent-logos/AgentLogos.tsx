import { IconBrandGithub } from "@tabler/icons-react";
import type { HTMLAttributes } from "react";

import { AntigravityBrandIcon } from "~/components/AntigravityIcon";
import { CursorIcon } from "~/components/Icons";
import { ProviderIcon } from "~/components/ProviderIcon";
import { cn } from "~/lib/utils";

const providers = ["claudeAgent", "codex", "opencode"] as const;

export function AgentLogos({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      aria-label="Supported agents"
      className={cn("flex h-[22px] w-fit items-center gap-3.5", className)}
      data-pencil-component="kWiGM"
      {...props}
    >
      {providers.map((provider) => (
        <span className="inline-flex size-[22px] items-center justify-center" key={provider}>
          <ProviderIcon className="size-4" provider={provider} />
        </span>
      ))}
      <span className="inline-flex size-[22px] items-center justify-center">
        <CursorIcon className="size-4" />
      </span>
      <span className="inline-flex size-[22px] items-center justify-center">
        <AntigravityBrandIcon className="size-4" />
      </span>
      <span className="inline-flex size-[22px] items-center justify-center">
        <IconBrandGithub className="size-4" />
      </span>
    </div>
  );
}
