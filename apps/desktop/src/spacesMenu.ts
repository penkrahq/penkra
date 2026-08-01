import type { DesktopSpacesMenuInput } from "@synara/contracts";

const MAX_SPACES_MENU_ITEMS = 100;
const MAX_SPACE_ID_LENGTH = 128;
const MAX_SPACE_NAME_LENGTH = 80;

export function normalizeDesktopSpacesMenuInput(input: unknown): DesktopSpacesMenuInput | null {
  if (!input || typeof input !== "object") return null;
  const candidate = input as Partial<DesktopSpacesMenuInput>;
  if (!Array.isArray(candidate.spaces)) return null;

  const seenIds = new Set<string>();
  const spaces: Array<{ id: string; name: string }> = [];
  for (const rawSpace of candidate.spaces) {
    if (!rawSpace || typeof rawSpace !== "object") continue;
    const id = typeof rawSpace.id === "string" ? rawSpace.id.trim() : "";
    const name = typeof rawSpace.name === "string" ? rawSpace.name.trim() : "";
    if (
      id.length === 0 ||
      id.length > MAX_SPACE_ID_LENGTH ||
      name.length === 0 ||
      seenIds.has(id)
    ) {
      continue;
    }
    seenIds.add(id);
    spaces.push({ id, name: name.slice(0, MAX_SPACE_NAME_LENGTH) });
    if (spaces.length === MAX_SPACES_MENU_ITEMS) break;
  }

  const activeSpaceId =
    typeof candidate.activeSpaceId === "string" && seenIds.has(candidate.activeSpaceId)
      ? candidate.activeSpaceId
      : null;
  return { activeSpaceId, spaces };
}
