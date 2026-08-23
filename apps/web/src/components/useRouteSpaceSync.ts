// FILE: useRouteSpaceSync.ts
// Purpose: Synchronize the selected Space only when route identity actually changes.

import type { FolderId, SpaceId, ThreadId } from "@penkra/contracts";
import { useEffect } from "react";

import { useSpacesUiStore } from "../spacesUiStore";

export function useRouteSpaceSync(input: {
  routeFolderId: FolderId | null;
  routeSpaceId: SpaceId | null | undefined;
  routeThreadId: ThreadId | null;
}): void {
  const { routeFolderId, routeSpaceId, routeThreadId } = input;
  const setActiveSpaceId = useSpacesUiStore((store) => store.setActiveSpaceId);
  const rememberSpaceThread = useSpacesUiStore((store) => store.rememberThread);

  // Deliberately exclude activeSpaceId: a tab click updates selection before navigation lands,
  // and the still-current route must not immediately overwrite that user intent. Primitive route
  // inputs rerun this effect once navigation really changes identity.
  useEffect(() => {
    if (routeFolderId === null || routeSpaceId == null) return;
    if (useSpacesUiStore.getState().activeSpaceId !== routeSpaceId) {
      setActiveSpaceId(routeSpaceId);
    }
    if (routeThreadId) {
      rememberSpaceThread(routeSpaceId, routeThreadId);
    }
  }, [rememberSpaceThread, routeFolderId, routeSpaceId, routeThreadId, setActiveSpaceId]);
}
