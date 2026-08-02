// FILE: spaceGrouping.ts
// Purpose: One ordering and labelling rule for lists grouped by persisted Spaces.

import { SPACE_ICON_NAMES, type SpaceIconName, type SpaceId } from "@penkra/contracts";

import type { Space } from "~/types";

export const DEFAULT_SPACE_ICON: SpaceIconName = "bag";

export function toSpaceIconName(icon: string): SpaceIconName {
  return (SPACE_ICON_NAMES as ReadonlyArray<string>).includes(icon)
    ? (icon as SpaceIconName)
    : DEFAULT_SPACE_ICON;
}

/**
 * Returns the selected persisted Space only when it is present in the snapshot.
 * Missing state remains missing; it is never represented as a synthetic Space.
 */
export function resolveActiveSpaceId(
  activeSpaceId: SpaceId | null,
  spaces: ReadonlyArray<Space>,
  pendingActiveSpaceId: SpaceId | null = null,
): SpaceId | null {
  if (activeSpaceId === null) return null;
  return activeSpaceId === pendingActiveSpaceId ||
    spaces.some((space) => space.id === activeSpaceId)
    ? activeSpaceId
    : null;
}

function requireSpace(spaceId: SpaceId, spaces: ReadonlyArray<Space>): Space {
  const space = spaces.find((candidate) => candidate.id === spaceId);
  if (!space) throw new Error(`Space '${spaceId}' is missing from the authoritative snapshot.`);
  return space;
}

export function spaceDisplayName(spaceId: SpaceId, spaces: ReadonlyArray<Space>): string {
  return requireSpace(spaceId, spaces).name;
}

export function spaceDisplayIcon(spaceId: SpaceId, spaces: ReadonlyArray<Space>): SpaceIconName {
  return requireSpace(spaceId, spaces).icon;
}

export interface SpaceGroup<T> {
  readonly spaceId: SpaceId;
  readonly name: string;
  readonly icon: SpaceIconName;
  readonly isActive: boolean;
  readonly label: string;
  readonly items: ReadonlyArray<T>;
  readonly key: string;
}

export function orderedSpaceIdsForPicker(
  spaces: ReadonlyArray<Space>,
  activeSpaceId: SpaceId | null,
): ReadonlyArray<SpaceId> {
  if (activeSpaceId === null) return spaces.map((space) => space.id);
  requireSpace(activeSpaceId, spaces);
  return [activeSpaceId, ...spaces.map((space) => space.id).filter((id) => id !== activeSpaceId)];
}

/** Groups ordinary folders by their required persisted Space. Invalid rows fail visibly. */
export function groupItemsBySpace<T>(input: {
  items: ReadonlyArray<T>;
  spaces: ReadonlyArray<Space>;
  activeSpaceId: SpaceId | null;
  spaceIdOf: (item: T) => SpaceId | null;
}): ReadonlyArray<SpaceGroup<T>> {
  const itemsBySpaceId = new Map<SpaceId, T[]>();
  for (const item of input.items) {
    const spaceId = input.spaceIdOf(item);
    if (spaceId === null) {
      throw new Error("An ordinary folder is missing its required Space assignment.");
    }
    requireSpace(spaceId, input.spaces);
    const bucket = itemsBySpaceId.get(spaceId);
    if (bucket) bucket.push(item);
    else itemsBySpaceId.set(spaceId, [item]);
  }

  return orderedSpaceIdsForPicker(input.spaces, input.activeSpaceId).flatMap((spaceId) => {
    const items = itemsBySpaceId.get(spaceId);
    if (!items) return [];
    const space = requireSpace(spaceId, input.spaces);
    const isActive = spaceId === input.activeSpaceId;
    return [
      {
        spaceId,
        name: space.name,
        icon: space.icon,
        isActive,
        label: isActive ? `${space.name} · Active` : space.name,
        items,
        key: spaceId,
      } satisfies SpaceGroup<T>,
    ];
  });
}
