import type { SpaceId } from "@penkra/contracts";

const SPACE_UI_EVENT = "penkra:space-ui-action";

export type SpaceUiAction =
  | { type: "create" }
  | { type: "focus"; spaceId: SpaceId }
  | { type: "rename"; spaceId: SpaceId };

export function dispatchSpaceUiAction(action: SpaceUiAction): void {
  window.dispatchEvent(new CustomEvent<SpaceUiAction>(SPACE_UI_EVENT, { detail: action }));
}

export function subscribeToSpaceUiActions(listener: (action: SpaceUiAction) => void): () => void {
  const handleAction = (event: Event) => {
    listener((event as CustomEvent<SpaceUiAction>).detail);
  };
  window.addEventListener(SPACE_UI_EVENT, handleAction);
  return () => window.removeEventListener(SPACE_UI_EVENT, handleAction);
}
