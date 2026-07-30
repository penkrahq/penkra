import {
  IconBrandBlender,
  IconBrandChrome,
  IconBrandFigma,
  IconBrandGithub,
  IconBrandNotion,
  IconBrandSlack,
  IconFileSpreadsheet,
  IconFileTypeDoc,
  IconX,
} from "@tabler/icons-react";
import { useMemo, useState, type ReactNode } from "react";

import { ScrollArea } from "~/components/ui/scroll-area";
import { cn } from "~/lib/utils";

import { CardAppStore } from "../card-app-store/CardAppStore";
import { InputSearchApps } from "../input-search-apps/InputSearchApps";
import { PillCategory } from "../pill-category/PillCategory";
import { RowInstalledApp } from "../row-installed-app/RowInstalledApp";

type AppCategory =
  | "All"
  | "Featured"
  | "Productivity"
  | "Developer"
  | "Design"
  | "Data"
  | "Communication";

interface GalleryApp {
  category: Exclude<AppCategory, "All" | "Featured">;
  description: string;
  icon: ReactNode;
  name: string;
  rating: string;
  tone: "blue" | "green" | "orange" | "purple" | "slate";
}

const categories: AppCategory[] = [
  "All",
  "Featured",
  "Productivity",
  "Developer",
  "Design",
  "Data",
  "Communication",
];

const discoverApps: GalleryApp[] = [
  {
    category: "Design",
    description: "Bring design files into a thread for review.",
    icon: <IconBrandFigma />,
    name: "Figma",
    rating: "4.9",
    tone: "purple",
  },
  {
    category: "Data",
    description: "Build and analyze spreadsheets.",
    icon: <IconFileSpreadsheet />,
    name: "Excel",
    rating: "4.6",
    tone: "green",
  },
  {
    category: "Design",
    description: "Render and edit 3D scenes.",
    icon: <IconBrandBlender />,
    name: "Blender",
    rating: "4.5",
    tone: "orange",
  },
  {
    category: "Communication",
    description: "Post updates to channels from a thread.",
    icon: <IconBrandSlack />,
    name: "Slack",
    rating: "4.7",
    tone: "purple",
  },
  {
    category: "Developer",
    description: "Open issues and PRs inline in a thread.",
    icon: <IconBrandGithub />,
    name: "GitHub",
    rating: "4.9",
    tone: "slate",
  },
];

export interface ModalAppsGalleryProps {
  className?: string;
  onClose?: () => void;
  onInstall?: (appName: string) => void;
  onOpen?: (appName: string) => void;
}

export function ModalAppsGallery({
  className,
  onClose,
  onInstall,
  onOpen,
}: ModalAppsGalleryProps) {
  const [category, setCategory] = useState<AppCategory>("All");
  const [query, setQuery] = useState("");
  const visibleApps = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return discoverApps.filter((app) => {
      const matchesCategory =
        category === "All" || category === "Featured" || app.category === category;
      const matchesQuery =
        !normalizedQuery ||
        `${app.name} ${app.description}`.toLocaleLowerCase().includes(normalizedQuery);
      return matchesCategory && matchesQuery;
    });
  }, [category, query]);

  return (
    <section
      aria-label="Apps"
      aria-modal="true"
      className={cn(
        "flex h-[849px] w-[760px] max-w-full flex-col overflow-hidden border border-[var(--color-border)] bg-[var(--color-background-surface)] px-8 pb-8 pt-7 font-sans",
        className,
      )}
      data-pencil-component="WDRTD"
      role="dialog"
    >
      <header className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-[var(--color-text-foreground)]">Apps</h2>
          <p className="mt-1 text-[13px] text-[var(--color-text-foreground-tertiary)]">
            Discover and manage integrations your agent can use in threads.
          </p>
        </div>
        <button
          aria-label="Close apps"
          className="inline-flex size-7 cursor-pointer items-center justify-center rounded-md border-0 bg-transparent text-[var(--color-text-foreground-secondary)] outline-none hover:bg-[var(--color-background-button-secondary-hover)] focus-visible:ring-1 focus-visible:ring-[var(--color-border-focus)]"
          onClick={onClose}
          type="button"
        >
          <IconX className="size-3.5" />
        </button>
      </header>
      <InputSearchApps
        className="mt-4 w-full"
        onChange={(event) => setQuery(event.target.value)}
        value={query}
      />
      <ScrollArea
        aria-label="Apps gallery content"
        className="mt-6 min-h-0 flex-1"
        data-pencil-region="apps-gallery-content"
        scrollFade
        scrollbarGutter
      >
        <div className="flex flex-col gap-6 pb-2">
          <div className="flex flex-wrap gap-2">
            {categories.map((item) => (
              <PillCategory
                key={item}
                onClick={() => setCategory(item)}
                selected={category === item}
              >
                {item}
              </PillCategory>
            ))}
          </div>
          {!query && (category === "All" || category === "Featured") ? (
            <section className="flex flex-col gap-3">
              <h3 className="text-[13px] font-semibold text-[var(--color-text-foreground-secondary)]">
                Installed
              </h3>
              <div className="flex flex-col gap-2">
                <RowInstalledApp onOpen={() => onOpen?.("Browser")} />
                <RowInstalledApp
                  description="Draft and edit documents without leaving your thread."
                  icon={<IconFileTypeDoc />}
                  name="Microsoft Word"
                  onOpen={() => onOpen?.("Microsoft Word")}
                  tone="blue"
                />
                <RowInstalledApp
                  description="Search and edit your docs from a thread."
                  icon={<IconBrandNotion />}
                  name="Notion"
                  onOpen={() => onOpen?.("Notion")}
                  tone="slate"
                />
              </div>
            </section>
          ) : null}
          <section className="flex flex-col gap-3">
            <h3 className="text-[13px] font-semibold text-[var(--color-text-foreground-secondary)]">
              Discover
            </h3>
            {visibleApps.length ? (
              <div className="grid grid-cols-1 gap-4 min-[560px]:grid-cols-2 min-[720px]:grid-cols-3">
                {visibleApps.map((app) => (
                  <CardAppStore
                    description={app.description}
                    icon={app.icon}
                    key={app.name}
                    name={app.name}
                    onInstall={() => onInstall?.(app.name)}
                    rating={app.rating}
                    tone={app.tone}
                  />
                ))}
              </div>
            ) : (
              <p className="py-10 text-center text-[13px] text-[var(--color-text-foreground-tertiary)]">
                No apps match your search.
              </p>
            )}
          </section>
        </div>
      </ScrollArea>
    </section>
  );
}
