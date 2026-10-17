// Renderers own voice activity only. Thread work comes directly from the backend.
import { useEffect } from "react";
import { useVoiceSessionCoordinatorStore } from "../voiceSessionCoordinator";

export function DesktopVoicePowerSync() {
  const voice = useVoiceSessionCoordinatorStore(
    (state) => state.capture !== null || state.transcriptions.length > 0,
  );
  useEffect(() => {
    void window.desktopBridge?.power?.setVoiceActive(voice).catch((error: unknown) => {
      console.warn("[desktop-power] Failed to synchronize voice activity.", error);
    });
  }, [voice]);
  useEffect(
    () => () => {
      void window.desktopBridge?.power?.setVoiceActive(false).catch((error: unknown) => {
        console.warn("[desktop-power] Failed to release voice activity.", error);
      });
    },
    [],
  );
  return null;
}
