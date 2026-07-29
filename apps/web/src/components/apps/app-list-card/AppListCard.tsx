import type { ReactNode } from "react";

import { Switch } from "~/components/ui/switch";
import { CircleCheckIcon } from "~/lib/icons";

export interface AppListCardProps {
  checked: boolean;
  description: string;
  icon: ReactNode;
  name: string;
  onCheckedChange: (checked: boolean) => void;
}

export function AppListCard({
  checked,
  description,
  icon,
  name,
  onCheckedChange,
}: AppListCardProps) {
  return (
    <article className="flex min-h-[86px] w-full items-center gap-3 rounded-[10px] border border-[var(--pencil-border)] bg-[var(--pencil-surface-raised)] px-4 py-[17px]">
      <div className="flex size-[52px] shrink-0 items-center justify-center text-[var(--pencil-text-primary)]">
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <h3 className="truncate font-sans text-[15px] leading-[17.5px] font-semibold text-[var(--pencil-text-primary)]">
            {name}
          </h3>
          <CircleCheckIcon
            aria-hidden="true"
            className="size-3.5 shrink-0 text-[var(--pencil-accent)]"
          />
        </div>
        <p className="mt-0.5 line-clamp-2 font-sans text-xs leading-[17px] text-[var(--pencil-text-secondary)]">
          {description}
        </p>
      </div>
      <Switch
        aria-label={`${checked ? "Remove" : "Add"} ${name}`}
        checked={checked}
        className="[--thumb-size:16px] data-checked:border-[var(--pencil-accent)] data-checked:bg-[var(--pencil-accent)]"
        onCheckedChange={(next) => onCheckedChange(Boolean(next))}
      />
    </article>
  );
}
