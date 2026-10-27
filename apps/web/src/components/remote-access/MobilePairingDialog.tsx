import { useEffect, useState } from "react";
import type { RemotePairingRequest } from "@penkra/contracts";
import { readNativeApi } from "~/nativeApi";
import { toastManager } from "~/components/ui/toast";
import { AllowIphoneDialog } from "./AllowIphoneDialog";

export function MobilePairingDialog() {
  const [request, setRequest] = useState<RemotePairingRequest | null>(null);
  useEffect(() => {
    if (!window.desktopBridge) return;
    const api = readNativeApi();
    if (!api) return;
    return api.remote.subscribePairing(setRequest, (error) => {
      setRequest(null);
      console.error("[remote-link] Pairing subscription failed", error);
    });
  }, []);
  return (
    <AllowIphoneDialog
      request={request}
      onAnswer={(requestId, allow) => {
        void readNativeApi()
          ?.remote.answerPairing({ requestId, allow })
          .catch((error: unknown) => {
            toastManager.add({
              type: "error",
              title: "Could not answer iPhone pairing request",
              description: error instanceof Error ? error.message : undefined,
            });
          });
      }}
    />
  );
}
