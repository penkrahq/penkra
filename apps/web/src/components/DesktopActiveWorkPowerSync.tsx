// FILE: DesktopActiveWorkPowerSync.tsx
// Purpose: Reports app-wide executing-thread and voice activity to the desktop power owner.
// Layer: Desktop integration

import { useEffect } from "react";

import { activeThreadExecutionIds } from "../lib/activeWorkPower";
import { useStore } from "../store";
import { useVoiceSessionCoordinatorStore } from "../voiceSessionCoordinator";

export function DesktopActiveWorkPowerSync() {
  const activeThreadIdsKey = useStore((state) => activeThreadExecutionIds(state).join("\n"));
  const activeThreadIds = activeThreadIdsKey === "" ? [] : activeThreadIdsKey.split("\n");
  const threadExecution = activeThreadIds.length > 0;
  const voice = useVoiceSessionCoordinatorStore(
    (state) => state.capture !== null || state.transcriptions.length > 0,
  );

  useEffect(() => {
    const setActiveWork = window.desktopBridge?.power?.setActiveWork;
    if (!setActiveWork) return;
    void setActiveWork({ threadExecution, voice, activeThreadIds }).catch((error: unknown) => {
      console.warn("[desktop-power] Failed to synchronize active work.", error);
    });
  }, [activeThreadIdsKey, threadExecution, voice]);

  useEffect(
    () => () => {
      void window.desktopBridge?.power
        ?.setActiveWork({
          threadExecution: false,
          voice: false,
          activeThreadIds: [],
        })
        .catch(() => undefined);
    },
    [],
  );

  return null;
}
