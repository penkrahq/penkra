// Shared subagent naming and presentation rules.
import { isWorkerTierSubagentRole } from "./subagents";
import { basenameOfPath as basename } from "./pathNames";

const SUBAGENT_ACCENT_PALETTE = [
  "#b84e44",
  "#2f7a5d",
  "#345fa8",
  "#a86834",
  "#7352a8",
  "#2f7480",
  "#a84d71",
  "#6a8531",
] as const;

const GENERIC_SUBAGENT_TITLES = new Set([
  "",
  "agent",
  "chat",
  "child thread",
  "conversation",
  "new chat",
  "new conversation",
  "new thread",
  "subagent",
  "thread",
]);

export interface SubagentPresentation {
  primaryLabel: string;
  nickname: string | null;
  role: string | null;
  title: string | null;
  fullLabel: string;
  accentColor: string;
}

function fallbackSubagentLabel(value: string | null): string | null {
  const normalized = normalizeWhitespace(value);
  if (!normalized) {
    return null;
  }

  if (normalized.startsWith("subagent:")) {
    const segments = normalized.split(":").filter((segment) => segment.length > 0);
    return segments.at(-1) ?? normalized;
  }

  return basename(normalized);
}

export function normalizeWhitespace(value: string | null | undefined): string | null {
  const normalized = value?.trim().replace(/\s+/g, " ") ?? "";
  return normalized.length > 0 ? normalized : null;
}

function normalizeRole(role: string | null | undefined): string | null {
  const normalized = normalizeWhitespace(role);
  return normalized ? normalized.toLowerCase() : null;
}

// Worker-tier agent types are internal effort carriers; never surface them as a
// role even when persisted thread metadata or titles still contain them.
function suppressWorkerTierRole(role: string | null): string | null {
  return role !== null && isWorkerTierSubagentRole(role) ? null : role;
}

function isGenericSubagentTitle(title: string | null): boolean {
  if (!title) {
    return true;
  }
  const normalized = title.trim().toLowerCase();
  return GENERIC_SUBAGENT_TITLES.has(normalized) || normalized.startsWith("subagent ");
}

function parseBracketedSubagentLabel(label: string | null): {
  nickname: string | null;
  role: string | null;
} {
  if (!label) {
    return { nickname: null, role: null };
  }

  const match = /^(.*?)\s*\[([^\]]+)\]$/.exec(label.trim());
  if (!match) {
    return { nickname: null, role: null };
  }

  return {
    nickname: normalizeWhitespace(match[1]),
    role: normalizeRole(match[2]),
  };
}

function capitalizeRoleLabel(role: string | null): string | null {
  if (!role) {
    return null;
  }
  return role.charAt(0).toUpperCase() + role.slice(1);
}

function hashLabelSeed(seed: string): number {
  let hash = 0;
  for (const character of seed) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }
  return hash;
}

export function subagentAccentColor(seed: string | null | undefined): string {
  const normalized = normalizeWhitespace(seed)?.toLowerCase() ?? "subagent";
  const index = hashLabelSeed(normalized) % SUBAGENT_ACCENT_PALETTE.length;
  return SUBAGENT_ACCENT_PALETTE[index] ?? SUBAGENT_ACCENT_PALETTE[0];
}

export function resolveSubagentPresentation(input: {
  nickname?: string | null | undefined;
  role?: string | null | undefined;
  title?: string | null | undefined;
  fallbackId?: string | null | undefined;
}): SubagentPresentation {
  const explicitNickname = normalizeWhitespace(input.nickname);
  const explicitRole = suppressWorkerTierRole(normalizeRole(input.role));
  const normalizedTitle = normalizeWhitespace(input.title);
  const parsedTitle = parseBracketedSubagentLabel(normalizedTitle);
  const parsedTitleRole = suppressWorkerTierRole(parsedTitle.role);
  // Titles persisted as "Nickname [worker-low]" drop the worker-tier suffix.
  const titleWithoutWorkerRole =
    parsedTitle.role !== null && parsedTitleRole === null ? parsedTitle.nickname : normalizedTitle;
  const parsedTitleNickname = isGenericSubagentTitle(parsedTitle.nickname)
    ? null
    : parsedTitle.nickname;
  const titleLabel = isGenericSubagentTitle(titleWithoutWorkerRole) ? null : titleWithoutWorkerRole;
  const nickname = explicitNickname ?? parsedTitleNickname;
  const role = explicitRole ?? parsedTitleRole;
  const resolvedTitle = parsedTitleNickname ? null : titleLabel;
  const normalizedFallbackId = normalizeWhitespace(input.fallbackId);
  const fallbackLabel = fallbackSubagentLabel(normalizedFallbackId) ?? "Subagent";
  const primaryLabel = nickname ?? resolvedTitle ?? capitalizeRoleLabel(role) ?? fallbackLabel;
  const fullLabel = role && nickname ? `${nickname} [${role}]` : primaryLabel;

  return {
    primaryLabel,
    nickname,
    role,
    title: resolvedTitle,
    fullLabel,
    accentColor: subagentAccentColor(nickname ?? primaryLabel),
  };
}
