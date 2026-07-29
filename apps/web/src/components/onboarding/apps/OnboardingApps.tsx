import {
  IconBrandBlender,
  IconBrandChrome,
  IconBrandNotion,
  IconBrandSlack,
  IconFileSpreadsheet,
  IconFileWord,
} from "@tabler/icons-react";
import { useMemo, useState } from "react";

import { AppListCard } from "~/components/apps/app-list-card/AppListCard";
import { InputSearchApps } from "~/components/apps/input-search-apps/InputSearchApps";
import { Button } from "~/components/ui/button";
import { ScrollArea } from "~/components/ui/scroll-area";
import { ArrowLeftIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";

const apps = [
  {
    iconClassName: "text-[#4a90e2]",
    description: "Search the web and pull in pages without leaving your thread.",
    icon: IconBrandChrome,
    id: "browser",
    name: "Browser",
  },
  {
    iconClassName: "text-[#2b579a]",
    description: "Draft and edit documents without leaving your thread.",
    icon: IconFileWord,
    id: "microsoft-word",
    name: "Microsoft Word",
  },
  {
    iconClassName: "text-[#e87d0d]",
    description: "Render previews and check scenes as you work.",
    icon: IconBrandBlender,
    id: "blender",
    name: "Blender",
  },
  {
    iconClassName: "text-white",
    description: "Sync docs and track project context across workspaces.",
    icon: IconBrandNotion,
    id: "notion",
    name: "Notion",
  },
  {
    iconClassName: "text-[#e01e5a]",
    description: "Get notifications and share updates directly in channels.",
    icon: IconBrandSlack,
    id: "slack",
    name: "Slack",
  },
  {
    iconClassName: "text-[#217346]",
    description: "Pull spreadsheet data straight into your conversation.",
    icon: IconFileSpreadsheet,
    id: "microsoft-excel",
    name: "Microsoft Excel",
  },
] as const;

export interface OnboardingAppsProps {
  onBack?: () => void;
  onContinue?: (selectedAppIds: ReadonlySet<string>) => void;
}

export function OnboardingApps({ onBack, onContinue }: OnboardingAppsProps) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    () => new Set(["browser", "microsoft-word"]),
  );
  const visibleApps = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return apps;
    return apps.filter(
      (app) =>
        app.name.toLowerCase().includes(normalized) ||
        app.description.toLowerCase().includes(normalized),
    );
  }, [query]);

  function setAppSelected(appId: string, checked: boolean) {
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(appId);
      else next.delete(appId);
      return next;
    });
  }

  return (
    <section
      aria-labelledby="onboarding-apps-title"
      className="relative flex h-[640px] w-full max-w-[1040px] overflow-hidden bg-[var(--pencil-surface-raised)] text-[var(--pencil-text-primary)]"
      data-pencil-component="YmEq2"
    >
      <div className="relative flex min-w-0 flex-1 justify-center md:w-[600px] md:flex-none">
        <Button
          aria-label="Back"
          className="absolute top-[25px] left-[22px] z-10 size-8 border-transparent bg-transparent p-0 text-[var(--pencil-text-secondary)] hover:bg-transparent hover:text-[var(--pencil-text-primary)] md:top-[21px] md:left-[20px]"
          onClick={onBack}
          size="icon"
          variant="ghost"
        >
          <ArrowLeftIcon aria-hidden="true" className="size-3.5" />
        </Button>

        <div className="flex h-full w-full max-w-[488px] min-w-0 flex-col px-3 pt-[78px] pb-[78.5px] sm:px-0">
          <header>
            <h1
              className="font-sans text-2xl leading-[29px] font-semibold tracking-[-0.02em]"
              id="onboarding-apps-title"
            >
              Add your first apps
            </h1>
            <p className="mt-[7px] font-sans text-sm leading-[17px] text-[var(--pencil-text-secondary)]">
              Choose a few essentials — you can always add more later.
            </p>
          </header>

          <InputSearchApps
            className="mt-4"
            onChange={(event) => setQuery(event.currentTarget.value)}
            value={query}
          />

          <div className="mt-4 min-h-0 flex-1">
            <ScrollArea
              aria-label="Available apps"
              className="h-[300px]"
              hideScrollbars
              scrollFade
            >
              <div className="flex flex-col gap-3 pb-1">
                {visibleApps.map((app) => {
                  const Icon = app.icon;
                  return (
                    <AppListCard
                      checked={selected.has(app.id)}
                      description={app.description}
                      icon={
                        <Icon
                          aria-hidden="true"
                          className={cn("size-7", app.iconClassName)}
                        />
                      }
                      key={app.id}
                      name={app.name}
                      onCheckedChange={(checked) => setAppSelected(app.id, checked)}
                    />
                  );
                })}
                {visibleApps.length === 0 ? (
                  <p className="py-10 text-center text-sm text-[var(--pencil-text-secondary)]">
                    No apps match “{query}”.
                  </p>
                ) : null}
              </div>
            </ScrollArea>
          </div>

          <Button
            className="mt-4 h-[41px] w-full rounded-[10px] border-transparent bg-[var(--pencil-accent)] font-sans text-sm font-semibold text-white hover:bg-[var(--pencil-accent-hover)]"
            onClick={() => onContinue?.(selected)}
          >
            Continue
          </Button>
        </div>
      </div>

      <aside
        aria-hidden="true"
        className="hidden h-full w-[440px] shrink-0 bg-[var(--pencil-surface-raised)] md:block"
      />
    </section>
  );
}
