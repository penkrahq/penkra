/**
 * SidebarSearchPalette - Command-style palette for sidebar actions, threads, and projects.
 *
 * Keeps the sidebar search UX aligned with the shared command primitives so
 * keyboard navigation and shortcut labels behave like the rest of the app.
 */
import {
  BugIcon,
  CheckIcon,
  DeviceLaptopIcon,
  MoonIcon,
  NewThreadIcon,
  SearchIcon,
  SettingsIcon,
  SunIcon,
} from "~/lib/icons";
import { type ProviderKind } from "@penkra/contracts";
import { isGenericChatThreadTitle } from "@penkra/shared/chatThreads";
import { BsChat } from "react-icons/bs";
import { HiOutlineFolderOpen } from "react-icons/hi2";
import { LuArrowDownToLine, LuArrowLeft } from "react-icons/lu";
import { type ComponentType, useEffect, useState } from "react";
import { FolderClosed } from "./FolderClosed";
import { ProviderIcon as SharedProviderIcon } from "./ProviderIcon";
import { formatRelativeTime } from "~/lib/relativeTime";

import {
  type SidebarSearchAction,
  type SidebarSearchProject,
  type SidebarSearchTheme,
  type SidebarSearchThread,
  matchSidebarSearchActions,
  matchSidebarSearchProjects,
  matchSidebarSearchThemes,
  matchSidebarSearchThreads,
} from "./SidebarSearchPalette.logic";
import { useTheme } from "../hooks/useTheme";
import { getAvailableCodeThemes, getCodeThemeSeed } from "../theme/theme.logic";
import {
  Command,
  CommandDialog,
  CommandDialogPopup,
  CommandEmpty,
  CommandFooter,
  CommandGroup,
  CommandGroupLabel,
  CommandInput,
  CommandItem,
  CommandList,
  CommandPanel,
  CommandSeparator,
} from "./ui/command";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { ShortcutKbd } from "./ui/shortcut-kbd";

export type SidebarSearchPaletteMode = "search" | "import";

interface SidebarSearchPaletteProps {
  open: boolean;
  mode: SidebarSearchPaletteMode;
  onModeChange: (mode: SidebarSearchPaletteMode) => void;
  onOpenChange: (open: boolean) => void;
  actions: readonly SidebarSearchAction[];
  projects: readonly SidebarSearchProject[];
  threads: readonly SidebarSearchThread[];
  onCreateChat: () => void;
  onCreateThread: () => void;
  onOpenSettings: () => void;
  onOpenFeedback: () => void;
  onOpenUsageSettings: () => void;
  onOpenProject: (projectId: string) => void;
  onOpenThread: (threadId: string) => void;
  importProviders: readonly ImportProviderKind[];
  onImportThread: (provider: ImportProviderKind, externalId: string) => Promise<void>;
}

export type ImportProviderKind = Extract<
  ProviderKind,
  "codex" | "claudeAgent" | "cursor" | "kilo" | "opencode"
>;

function actionHandler(
  actionId: string,
  props: Pick<
    SidebarSearchPaletteProps,
    "onCreateChat" | "onCreateThread" | "onOpenFeedback" | "onOpenSettings" | "onOpenUsageSettings"
  >,
): (() => void) | null {
  switch (actionId) {
    case "new-chat":
      return props.onCreateChat;
    case "new-thread":
      return props.onCreateThread;
    case "settings":
      return props.onOpenSettings;
    case "feedback":
      return props.onOpenFeedback;
    case "usage-settings":
      return props.onOpenUsageSettings;
    default:
      return null;
  }
}

type IconComponent = ComponentType<{ className?: string }>;

const ACTION_ICONS: Record<string, IconComponent> = {
  "new-chat": BsChat,
  "new-thread": NewThreadIcon,
  "add-project": FolderClosed,
  "import-thread": LuArrowDownToLine,
  feedback: BugIcon,
  settings: SettingsIcon,
  "usage-settings": SettingsIcon,
};

function PaletteIcon(props: { icon: IconComponent }) {
  const Icon = props.icon;
  return (
    <div className="flex size-5 shrink-0 items-center justify-center text-muted-foreground">
      <Icon className="size-[15px]" />
    </div>
  );
}

type ThemeCommandItem = {
  description: string;
  id: string;
  isActive: boolean;
  label: string;
  mode: "system" | "light" | "dark";
};

function queryTokens(query: string): string[] {
  return query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((token) => token.length > 0);
}

function hasTokenEqual(query: string, token: string): boolean {
  return queryTokens(query).includes(token);
}

function createThemeCommandItem(
  mode: ThemeCommandItem["mode"],
  activeMode: ThemeCommandItem["mode"],
): ThemeCommandItem {
  if (mode === "system") {
    return {
      id: "theme-command:system",
      label: "Switch to system theme",
      description: "Match your OS appearance setting.",
      mode,
      isActive: activeMode === mode,
    };
  }

  return {
    id: `theme-command:${mode}`,
    label: `Switch to ${mode} theme`,
    description: mode === "light" ? "Always use the light theme." : "Always use the dark theme.",
    mode,
    isActive: activeMode === mode,
  };
}

// Treat any token of length >= 2 that is a prefix of `keyword` as a match,
// so typing `th` / `the` already starts surfacing theme actions.
function hasTokenPrefixOf(query: string, keyword: string): boolean {
  return queryTokens(query).some((token) => token.length >= 2 && keyword.startsWith(token));
}

// Keep the palette quiet by default, then expose focused appearance actions
// once the user is clearly asking about theme modes.
function buildThemeCommandItems(input: {
  query: string;
  resolvedTheme: "light" | "dark";
  theme: "system" | "light" | "dark";
}): ThemeCommandItem[] {
  const normalizedQuery = input.query.trim().toLowerCase();
  if (!normalizedQuery) {
    return [];
  }

  if (
    hasTokenEqual(normalizedQuery, "system") ||
    hasTokenEqual(normalizedQuery, "auto") ||
    hasTokenEqual(normalizedQuery, "automatic") ||
    hasTokenEqual(normalizedQuery, "os")
  ) {
    return [createThemeCommandItem("system", input.theme)];
  }

  if (hasTokenEqual(normalizedQuery, "light")) {
    return [
      createThemeCommandItem("light", input.theme),
      createThemeCommandItem("system", input.theme),
    ];
  }

  if (hasTokenEqual(normalizedQuery, "dark")) {
    return [
      createThemeCommandItem("dark", input.theme),
      createThemeCommandItem("system", input.theme),
    ];
  }

  if (
    hasTokenPrefixOf(normalizedQuery, "theme") ||
    hasTokenPrefixOf(normalizedQuery, "appearance")
  ) {
    const nextMode = input.resolvedTheme === "dark" ? "light" : "dark";
    return [
      createThemeCommandItem(nextMode, input.theme),
      createThemeCommandItem("system", input.theme),
    ];
  }

  return [];
}

function CodeThemeBadge(props: { accent: string; background: string; foreground: string }) {
  return (
    <span
      aria-hidden="true"
      className="inline-flex size-6 shrink-0 items-center justify-center rounded-full border font-medium text-[length:var(--app-font-size-ui-xs,10px)] leading-none tracking-[-0.01em]"
      style={{
        backgroundColor: props.background,
        borderColor: `${props.foreground}26`,
        color: props.accent,
      }}
    >
      Aa
    </span>
  );
}

const THEME_MODE_ICONS: Record<"system" | "light" | "dark", IconComponent> = {
  system: DeviceLaptopIcon,
  light: SunIcon,
  dark: MoonIcon,
};

function ProviderIcon(props: { provider: ProviderKind }) {
  return (
    <div className="flex size-5 shrink-0 items-center justify-center">
      <SharedProviderIcon provider={props.provider} className="size-[15px]" />
    </div>
  );
}

function threadMatchLabel(input: {
  matchKind: "message" | "project" | "title";
  messageMatchCount: number;
}): string | null {
  if (input.matchKind === "message") {
    return input.messageMatchCount > 1 ? `${input.messageMatchCount} chat hits` : "Chat match";
  }
  if (input.matchKind === "project") {
    return "Folder match";
  }
  return null;
}

function tokenizeHighlightQuery(query: string): string[] {
  const tokens = query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((token) => token.length > 0)
    .filter((token, index, allTokens) => allTokens.indexOf(token) === index);
  return tokens.toSorted((left, right) => right.length - left.length);
}

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function HighlightedText(props: { text: string; query: string; className?: string }) {
  const tokens = tokenizeHighlightQuery(props.query);
  let segments: Array<{ key: string; text: string; highlighted: boolean }>;
  if (tokens.length === 0) {
    segments = [{ key: "full", text: props.text, highlighted: false }];
  } else {
    const pattern = new RegExp(`(${tokens.map(escapeRegExp).join("|")})`, "gi");
    const parts = props.text.split(pattern).filter((part) => part.length > 0);
    let offset = 0;
    segments = parts.map((part) => {
      const segment = {
        key: `${offset}-${part.length}`,
        text: part,
        highlighted: tokens.some((token) => token === part.toLowerCase()),
      };
      offset += part.length;
      return segment;
    });
  }

  return (
    <span className={props.className}>
      {segments.map((segment) =>
        segment.highlighted ? (
          <mark
            key={segment.key}
            className="rounded-[3px] bg-amber-200/80 px-[1px] text-current dark:bg-amber-300/25"
          >
            {segment.text}
          </mark>
        ) : (
          <span key={segment.key}>{segment.text}</span>
        ),
      )}
    </span>
  );
}

export function SidebarSearchPalette(props: SidebarSearchPaletteProps) {
  const { activeTheme, resolvedTheme, setCodeThemeId, setTheme, theme } = useTheme();
  const [query, setQuery] = useState("");
  const [importProviderState, setImportProvider] = useState<ImportProviderKind>(
    props.importProviders[0] ?? "codex",
  );
  const [importId, setImportId] = useState("");
  const [importError, setImportError] = useState<string | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  // Derived fallback (no syncing effect): an unavailable provider renders as
  // the first available one, and the user's pick resurfaces if it comes back.
  const importProvider = props.importProviders.includes(importProviderState)
    ? importProviderState
    : (props.importProviders[0] ?? "codex");
  useEffect(() => {
    if (props.open) {
      return;
    }
    // Timeout-0 keeps the reset writes asynchronous (the palette is already
    // hidden), which keeps this component eligible for React Compiler.
    const timeoutId = window.setTimeout(() => {
      setQuery("");
      setImportProvider(props.importProviders[0] ?? "codex");
      setImportId("");
      setImportError(null);
      setIsImporting(false);
    }, 0);
    return () => window.clearTimeout(timeoutId);
  }, [props.importProviders, props.open]);

  const matchedActions = matchSidebarSearchActions(props.actions, query);
  const themeCommandItems = buildThemeCommandItems({
    query,
    resolvedTheme,
    theme,
  });
  const currentCodeThemeItems: SidebarSearchTheme[] = getAvailableCodeThemes(resolvedTheme).map(
    (option) => ({
      id: `theme-code:${resolvedTheme}:${option.id}`,
      type: "code-theme",
      label: option.label,
      description: `Apply to the current ${resolvedTheme} theme slot.`,
      keywords: ["appearance", "theme", resolvedTheme, option.id],
      codeThemeId: option.id,
      variant: resolvedTheme,
      isActive: activeTheme.codeThemeId === option.id,
    }),
  );
  const matchedCurrentThemes =
    query.trim().length === 0 ? [] : matchSidebarSearchThemes(currentCodeThemeItems, query);
  const showThemeSection =
    query.trim().length > 0 && (themeCommandItems.length > 0 || matchedCurrentThemes.length > 0);
  const matchedProjects = matchSidebarSearchProjects(props.projects, query);
  const matchedThreads = matchSidebarSearchThreads(props.threads, query);
  const hasSearchResults =
    matchedActions.length > 0 ||
    themeCommandItems.length > 0 ||
    matchedCurrentThemes.length > 0 ||
    matchedProjects.length > 0 ||
    matchedThreads.length > 0;
  const importFieldLabel = importProvider === "codex" ? "Thread ID" : "Session ID";
  const importPlaceholder =
    importProvider === "claudeAgent"
      ? "Paste a Claude session id"
      : importProvider === "cursor"
        ? "Paste a Cursor session id"
        : importProvider === "kilo"
          ? "Paste a Kilo session id"
          : importProvider === "opencode"
            ? "Paste an OpenCode session id"
            : "Paste a Codex thread id";

  const submitImport = () => {
    const normalizedImportId = importId.trim();
    if (!normalizedImportId || isImporting) {
      return;
    }
    setImportError(null);
    setIsImporting(true);
    void Promise.resolve(props.onImportThread(importProvider, normalizedImportId))
      .then(() => {
        props.onOpenChange(false);
      })
      .catch((error: unknown) => {
        setImportError(error instanceof Error ? error.message : "Failed to import thread.");
      })
      .finally(() => {
        setIsImporting(false);
      });
  };

  return (
    <CommandDialog open={props.open} onOpenChange={props.onOpenChange}>
      <CommandDialogPopup className="max-w-2xl">
        {props.mode === "import" ? (
          <div className="flex flex-col overflow-hidden">
            <div className="border-b border-border/70 px-4 py-3">
              <div className="flex items-start gap-3">
                <Button
                  size="icon"
                  variant="ghost"
                  className="-ml-1 mt-[-2px] size-8 shrink-0"
                  onClick={() => {
                    setImportError(null);
                    props.onModeChange("search");
                  }}
                >
                  <LuArrowLeft className="size-4" />
                </Button>
                <div>
                  <p className="text-[length:calc(var(--app-font-size-base,12px)*1.1667)] font-medium text-foreground">
                    Import thread from provider
                  </p>
                  <p className="mt-1 text-[length:var(--app-font-size-ui,12px)] text-muted-foreground">
                    Create a local app thread and resume it from an existing provider id.
                  </p>
                </div>
              </div>
            </div>
            <div className="space-y-4 px-4 py-4">
              <div className="space-y-2">
                <p className="text-[length:var(--app-font-size-ui,12px)] font-medium text-muted-foreground">
                  Provider
                </p>
                <div className="flex gap-2">
                  {props.importProviders.map((provider) => (
                    <Button
                      key={provider}
                      className={
                        importProvider === provider
                          ? "flex-1 justify-start border-border bg-muted text-foreground hover:bg-muted/80"
                          : "flex-1 justify-start"
                      }
                      variant="outline"
                      onClick={() => setImportProvider(provider)}
                    >
                      <ProviderIcon provider={provider} />
                      {provider === "claudeAgent"
                        ? "Claude"
                        : provider === "cursor"
                          ? "Cursor"
                          : provider === "kilo"
                            ? "Kilo"
                            : provider === "opencode"
                              ? "OpenCode"
                              : "Codex"}
                    </Button>
                  ))}
                </div>
                {props.importProviders.length === 0 ? (
                  <p className="text-[length:var(--app-font-size-ui,12px)] text-muted-foreground">
                    No connected providers expose chat import in this build.
                  </p>
                ) : null}
              </div>
              <div className="space-y-2">
                <p className="text-[length:var(--app-font-size-ui,12px)] font-medium text-muted-foreground">
                  {importFieldLabel}
                </p>
                <Input
                  autoFocus
                  nativeInput
                  placeholder={importPlaceholder}
                  value={importId}
                  disabled={props.importProviders.length === 0}
                  onChange={(event) => setImportId(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void submitImport();
                    }
                  }}
                />
                <p className="text-[length:var(--app-font-size-ui,12px)] text-muted-foreground">
                  {importProvider === "claudeAgent"
                    ? "Claude resumes a persisted session by session id."
                    : importProvider === "cursor"
                      ? "Cursor resumes a persisted session by session id."
                      : importProvider === "kilo"
                        ? "Kilo resumes a persisted session by session id."
                        : importProvider === "opencode"
                          ? "OpenCode resumes a persisted session by session id."
                          : "Codex resumes a persisted thread by thread id."}
                </p>
              </div>
              {importError ? (
                <p className="rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2 text-[length:calc(var(--app-font-size-base,12px)*1.1667)] text-destructive">
                  {importError}
                </p>
              ) : null}
              <div className="flex justify-end gap-2">
                <Button
                  variant="ghost"
                  onClick={() => {
                    setImportError(null);
                    props.onOpenChange(false);
                  }}
                >
                  Cancel
                </Button>
                <Button
                  disabled={
                    props.importProviders.length === 0 ||
                    importId.trim().length === 0 ||
                    isImporting
                  }
                  onClick={submitImport}
                >
                  {isImporting ? "Importing..." : "Import"}
                </Button>
              </div>
            </div>
          </div>
        ) : (
          <>
            <Command autoHighlight="always" mode="none">
              <CommandPanel className="overflow-hidden">
                <div className="relative">
                  <CommandInput
                    placeholder="Search folders, threads, and actions"
                    value={query}
                    onChange={(event) => setQuery(event.currentTarget.value)}
                    startAddon={<SearchIcon className="text-muted-foreground" />}
                  />
                </div>
                <CommandList className="max-h-[min(24rem,60vh)] not-empty:px-1.5 not-empty:pt-0 not-empty:pb-1.5">
                  {matchedActions.length > 0 ? (
                    <CommandGroup>
                      <CommandGroupLabel className="pt-0 pb-1.5 pl-3">Suggested</CommandGroupLabel>
                      {matchedActions.map((action) => {
                        const onSelect = action.run ?? actionHandler(action.id, props);
                        const Icon = action.icon ?? ACTION_ICONS[action.id];
                        return (
                          <CommandItem
                            key={action.id}
                            value={`action:${action.id}`}
                            className="cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5"
                            onMouseDown={(event) => {
                              event.preventDefault();
                            }}
                            onClick={() => {
                              if (action.id === "import-thread") {
                                setImportError(null);
                                setImportId("");
                                setImportProvider(props.importProviders[0] ?? "codex");
                                props.onModeChange("import");
                                return;
                              }
                              if (!onSelect) return;
                              props.onOpenChange(false);
                              onSelect();
                            }}
                          >
                            {Icon ? <PaletteIcon icon={Icon} /> : null}
                            <span className="min-w-0 flex-1 truncate text-[length:calc(var(--app-font-size-base,12px)*1.1667)] text-foreground">
                              {action.label}
                            </span>
                            {action.shortcutLabel ? (
                              <ShortcutKbd
                                shortcutLabel={action.shortcutLabel}
                                groupClassName="shrink-0"
                              />
                            ) : null}
                          </CommandItem>
                        );
                      })}
                    </CommandGroup>
                  ) : null}

                  {matchedActions.length > 0 &&
                  (matchedThreads.length > 0 || matchedProjects.length > 0 || showThemeSection) ? (
                    <CommandSeparator />
                  ) : null}

                  {matchedThreads.length > 0 ? (
                    <CommandGroup>
                      <CommandGroupLabel className="py-1.5 pl-3">
                        {query ? "Threads" : "Recent"}
                      </CommandGroupLabel>
                      {matchedThreads.map(
                        ({ id, matchKind, messageMatchCount, snippet, thread }) => (
                          <CommandItem
                            key={id}
                            value={id}
                            className="cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2"
                            onMouseDown={(event) => {
                              event.preventDefault();
                            }}
                            onClick={() => {
                              props.onOpenChange(false);
                              props.onOpenThread(thread.id);
                            }}
                          >
                            {isGenericChatThreadTitle(thread.title) ? null : (
                              <ProviderIcon provider={thread.provider} />
                            )}
                            <div className="min-w-0 flex-1">
                              <div className="flex items-baseline gap-3">
                                <div className="min-w-0 flex-1 truncate text-[length:var(--app-font-size-ui,12px)] text-foreground">
                                  <HighlightedText
                                    text={thread.title || "Untitled thread"}
                                    query={query}
                                  />
                                </div>
                                {/* Project only, not "project · space": this column is
                                    96px, and a thread's Space is already implied by its
                                    project. Space stays searchable — it just does not
                                    get to eat the name the user is scanning for. */}
                                <span className="w-24 shrink-0 truncate text-right text-[length:var(--app-font-size-ui-meta,10px)] text-muted-foreground/79">
                                  {thread.projectName}
                                </span>
                                {thread.updatedAt || thread.createdAt ? (
                                  <span className="w-10 shrink-0 text-right text-[length:var(--app-font-size-ui-timestamp,10px)] text-muted-foreground/79">
                                    {formatRelativeTime(thread.updatedAt ?? thread.createdAt)}
                                  </span>
                                ) : (
                                  <span className="w-10 shrink-0" />
                                )}
                              </div>
                              {snippet ? (
                                <div className="mt-0.5 flex items-start gap-3">
                                  <div className="min-w-0 flex-1 line-clamp-1 text-[length:var(--app-font-size-ui-meta,10px)] leading-5 text-muted-foreground/78">
                                    <HighlightedText text={snippet} query={query} />
                                  </div>
                                  <div className="flex w-[8.5rem] shrink-0 justify-end">
                                    {threadMatchLabel({ matchKind, messageMatchCount }) ? (
                                      <span className="truncate text-[length:var(--app-font-size-ui-meta,10px)] text-muted-foreground/58">
                                        {threadMatchLabel({ matchKind, messageMatchCount })}
                                      </span>
                                    ) : null}
                                  </div>
                                </div>
                              ) : threadMatchLabel({ matchKind, messageMatchCount }) ? (
                                <div className="mt-0.5 text-[length:var(--app-font-size-ui-meta,10px)] text-muted-foreground/58">
                                  {threadMatchLabel({ matchKind, messageMatchCount })}
                                </div>
                              ) : null}
                            </div>
                          </CommandItem>
                        ),
                      )}
                    </CommandGroup>
                  ) : null}

                  {matchedThreads.length > 0 && (matchedProjects.length > 0 || showThemeSection) ? (
                    <CommandSeparator />
                  ) : null}

                  {matchedProjects.length > 0 ? (
                    <CommandGroup>
                      <CommandGroupLabel className="py-1.5 pl-3">Folders</CommandGroupLabel>
                      {matchedProjects.map(({ id, project }) => (
                        <CommandItem
                          key={id}
                          value={id}
                          className="cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5"
                          onMouseDown={(event) => {
                            event.preventDefault();
                          }}
                          onClick={() => {
                            props.onOpenChange(false);
                            props.onOpenProject(project.id);
                          }}
                        >
                          <PaletteIcon icon={HiOutlineFolderOpen} />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-baseline gap-3">
                              <div className="min-w-0 flex-1 truncate text-[length:var(--app-font-size-ui,12px)] text-foreground">
                                {project.name || "Untitled folder"}
                              </div>
                              {/* Opening a project from here can switch Space, so the
                                  destination is worth naming. It rides in the same right-hand
                                  column the thread rows use for their parent, rather than
                                  in front of the path, which is what identifies a project. */}
                              <span className="w-24 shrink-0 truncate text-right text-[length:var(--app-font-size-ui-meta,10px)] text-muted-foreground/79">
                                {project.spaceName}
                              </span>
                            </div>
                            <div className="truncate text-[length:var(--app-font-size-ui-meta,10px)] text-muted-foreground/79">
                              {project.localName
                                ? `${project.folderName} · ${project.cwd}`
                                : project.cwd}
                            </div>
                          </div>
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  ) : null}

                  {showThemeSection && matchedProjects.length > 0 ? <CommandSeparator /> : null}

                  {showThemeSection ? (
                    <>
                      {themeCommandItems.length > 0 ? (
                        <CommandGroup>
                          <CommandGroupLabel className="py-1.5 pl-3">Configure</CommandGroupLabel>
                          {themeCommandItems.map((themeCommandItem) => (
                            <CommandItem
                              key={themeCommandItem.id}
                              value={themeCommandItem.id}
                              className="cursor-pointer items-center gap-3 rounded-lg px-3 py-1.5"
                              onMouseDown={(event) => {
                                event.preventDefault();
                              }}
                              onClick={() => {
                                if (themeCommandItem.isActive) return;
                                props.onOpenChange(false);
                                setTheme(themeCommandItem.mode);
                              }}
                            >
                              <PaletteIcon icon={THEME_MODE_ICONS[themeCommandItem.mode]} />
                              <span className="min-w-0 flex-1 truncate text-[length:var(--app-font-size-ui,12px)] text-foreground">
                                {themeCommandItem.label}
                              </span>
                              <span
                                className="flex size-3.5 shrink-0 items-center justify-center"
                                aria-hidden={!themeCommandItem.isActive}
                              >
                                {themeCommandItem.isActive ? (
                                  <CheckIcon className="size-3.5 text-muted-foreground/79" />
                                ) : null}
                              </span>
                            </CommandItem>
                          ))}
                        </CommandGroup>
                      ) : null}
                      {matchedCurrentThemes.length > 0 ? (
                        <CommandGroup>
                          <CommandGroupLabel className="py-1.5 pl-3">
                            {resolvedTheme === "dark" ? "Dark themes" : "Light themes"}
                          </CommandGroupLabel>
                          {matchedCurrentThemes.map((themeItem) => {
                            const seed =
                              themeItem.codeThemeId && themeItem.variant
                                ? getCodeThemeSeed(themeItem.codeThemeId, themeItem.variant)
                                : null;
                            return (
                              <CommandItem
                                key={themeItem.id}
                                value={themeItem.id}
                                className="cursor-pointer items-center gap-3 rounded-lg px-3 py-1.5"
                                onMouseDown={(event) => {
                                  event.preventDefault();
                                }}
                                onClick={() => {
                                  if (!themeItem.codeThemeId || !themeItem.variant) return;
                                  props.onOpenChange(false);
                                  setCodeThemeId(themeItem.variant, themeItem.codeThemeId);
                                }}
                              >
                                {seed ? (
                                  <CodeThemeBadge
                                    accent={seed.accent}
                                    background={seed.surface}
                                    foreground={seed.ink}
                                  />
                                ) : null}
                                <span className="min-w-0 flex-1 truncate text-[length:var(--app-font-size-ui,12px)] text-foreground">
                                  {themeItem.label}
                                </span>
                                <span className="shrink-0 text-[length:var(--app-font-size-ui-meta,10px)] text-muted-foreground/79">
                                  {resolvedTheme === "dark"
                                    ? "Dark color theme"
                                    : "Light color theme"}
                                </span>
                                <span
                                  className="flex size-3.5 shrink-0 items-center justify-center"
                                  aria-hidden={!themeItem.isActive}
                                >
                                  {themeItem.isActive ? (
                                    <CheckIcon className="size-3.5 text-muted-foreground/79" />
                                  ) : null}
                                </span>
                              </CommandItem>
                            );
                          })}
                        </CommandGroup>
                      ) : null}
                    </>
                  ) : null}

                  {!hasSearchResults ? (
                    <CommandEmpty className="py-10">
                      <div className="flex flex-col items-center justify-center gap-2 text-center text-[length:calc(var(--app-font-size-base,12px)*1.1667)] text-muted-foreground/79">
                        <SearchIcon className="size-4 opacity-70" />
                        <div>No matches.</div>
                      </div>
                    </CommandEmpty>
                  ) : null}
                </CommandList>
                <div className="h-1.5" />
              </CommandPanel>
              <CommandFooter>
                <span>Jump to threads, folders, actions, or appearance.</span>
                <span>Enter to open</span>
              </CommandFooter>
            </Command>
          </>
        )}
      </CommandDialogPopup>
    </CommandDialog>
  );
}
