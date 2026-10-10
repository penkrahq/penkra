// Purpose: Match the small local action, theme and folder lists; describe server thread results.
import type { ReactNode } from "react";

import type { ProviderKind } from "@penkra/contracts";
import { basenameOfPath } from "../file-icons";
import type { ThemeMode, ThemeVariant } from "../theme/theme.logic";

export interface SidebarSearchAction {
  id: string;
  label: string;
  description: string;
  keywords?: readonly string[];
  shortcutLabel?: string | null;
  /** Dynamic actions (e.g. "Switch to <space>") execute this instead of a wired-up prop. */
  run?: () => void;
  /** Overrides the id-keyed icon map for actions whose glyph is data (a space's icon). */
  icon?: (props: { className?: string }) => ReactNode;
  /**
   * Type-to-jump targets (one per space) only appear once the user types; listing them
   * all in the empty palette would push threads and folders below the fold.
   */
  requiresQuery?: boolean;
}

export interface SidebarSearchTheme {
  id: string;
  type: "mode" | "code-theme";
  label: string;
  description: string;
  keywords?: readonly string[];
  mode?: ThemeMode;
  codeThemeId?: string;
  variant?: ThemeVariant;
  isActive: boolean;
}

export interface SidebarSearchProject {
  id: string;
  name: string;
  remoteName: string;
  folderName: string;
  localName: string | null;
  cwd: string;
  spaceName: string;
  createdAt?: string | undefined;
  updatedAt?: string | undefined;
}

export interface SidebarSearchProjectMatch {
  id: string;
  project: SidebarSearchProject;
}

export interface SidebarSearchThread {
  id: string;
  title: string;
  folderId: string | null;
  projectName: string;
  provider: ProviderKind;
  createdAt: string;
  updatedAt?: string | undefined;
}

export interface SidebarSearchThreadMatch {
  id: string;
  thread: SidebarSearchThread;
  matchKind: "message" | "title";
  snippet: string | null;
}

function normalizeText(value: string): string {
  return value.trim().replaceAll(/\s+/g, " ").toLowerCase();
}

function scoreAction(action: SidebarSearchAction, query: string): number | null {
  if (!query) return 0;

  const label = normalizeText(action.label);
  const description = normalizeText(action.description);
  const keywords = (action.keywords ?? []).map(normalizeText);

  if (label === query) return 140;
  if (label.startsWith(query)) return 120;
  if (keywords.some((keyword) => keyword === query)) return 110;
  if (label.includes(query)) return 100;
  if (keywords.some((keyword) => keyword.includes(query))) return 90;
  if (description.includes(query)) return 70;
  return null;
}

function scoreTheme(theme: SidebarSearchTheme, query: string): number | null {
  if (!query) return 0;

  const label = normalizeText(theme.label);
  const description = normalizeText(theme.description);
  const keywords = (theme.keywords ?? []).map(normalizeText);

  if (label === query) return 145;
  if (keywords.some((keyword) => keyword === query)) return 135;
  if (label.startsWith(query)) return 125;
  if (label.includes(query)) return 110;
  if (keywords.some((keyword) => keyword.includes(query))) return 95;
  if (description.includes(query)) return 75;
  return null;
}

function scoreProject(project: SidebarSearchProject, query: string): number | null {
  if (!query) return null;

  const name = normalizeText(project.name);
  const remoteName = normalizeText(project.remoteName);
  const cwd = normalizeText(project.cwd);
  const folder = normalizeText(project.folderName || basenameOfPath(project.cwd));
  const spaceName = normalizeText(project.spaceName);

  if (name === query) return 150;
  if (remoteName === query) return 150;
  if (folder === query) return 145;
  if (name.startsWith(query)) return 130;
  if (remoteName.startsWith(query)) return 130;
  if (folder.startsWith(query)) return 120;
  if (name.includes(query)) return 105;
  if (remoteName.includes(query)) return 105;
  if (folder.includes(query)) return 95;
  if (spaceName === query) return 90;
  if (cwd.includes(query)) return 70;
  if (spaceName.includes(query)) return 60;
  return null;
}

export function matchSidebarSearchActions(
  actions: readonly SidebarSearchAction[],
  query: string,
): SidebarSearchAction[] {
  const normalizedQuery = normalizeText(query);

  return actions
    .filter((action) => !action.requiresQuery || normalizedQuery.length > 0)
    .map((action, index) => ({
      action,
      index,
      score: scoreAction(action, normalizedQuery),
    }))
    .filter((candidate) => candidate.score !== null)
    .toSorted((left, right) => {
      if (left.score !== right.score) return (right.score ?? 0) - (left.score ?? 0);
      return left.index - right.index;
    })
    .map((candidate) => candidate.action);
}

export function matchSidebarSearchThemes(
  themes: readonly SidebarSearchTheme[],
  query: string,
): SidebarSearchTheme[] {
  const normalizedQuery = normalizeText(query);
  if (!normalizedQuery) {
    return [...themes];
  }

  return themes
    .map((theme, index) => ({
      theme,
      index,
      score: scoreTheme(theme, normalizedQuery),
    }))
    .filter((candidate) => candidate.score !== null)
    .toSorted((left, right) => {
      if (left.score !== right.score) return (right.score ?? 0) - (left.score ?? 0);
      if (left.theme.isActive !== right.theme.isActive) {
        return left.theme.isActive ? -1 : 1;
      }
      return left.index - right.index;
    })
    .map((candidate) => candidate.theme);
}

export function matchSidebarSearchFolders(
  folders: readonly SidebarSearchProject[],
  query: string,
  limit = 6,
): SidebarSearchProjectMatch[] {
  const normalizedQuery = normalizeText(query);
  if (!normalizedQuery) return [];

  return folders
    .map((project) => ({
      id: `project:${project.id}`,
      project,
      score: scoreProject(project, normalizedQuery),
      recency: Date.parse(project.updatedAt ?? project.createdAt ?? "") || 0,
    }))
    .filter((candidate) => candidate.score !== null)
    .toSorted((left, right) => {
      if (left.score !== right.score) return (right.score ?? 0) - (left.score ?? 0);
      if (left.recency !== right.recency) return right.recency - left.recency;
      return left.project.name.localeCompare(right.project.name);
    })
    .slice(0, limit)
    .map(({ id, project }) => ({ id, project }));
}
