import { useEffect, useState } from "react";
import type { RemotePhone } from "@penkra/contracts";
import { useDesktopAccountAuthState } from "~/hooks/useDesktopAccountAuthState";
import { readNativeApi } from "~/nativeApi";
import { toastManager } from "~/components/ui/toast";
import { SettingsIphonePage, type RelayStatus } from "./SettingsIphonePage";

type AccessState = { signedIn: boolean; enabled: boolean };
type DeviceState = { phones: ReadonlyArray<RemotePhone>; relay: RelayStatus["kind"] };

export function SettingsIphoneContainer() {
  const { accountAuth, authState } = useDesktopAccountAuthState();
  const bridge = window.desktopBridge?.remoteAccess;
  const [access, setAccess] = useState<AccessState | null>(null);
  const [accessError, setAccessError] = useState(false);
  const [devices, setDevices] = useState<DeviceState | null>(null);
  const [deviceError, setDeviceError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const accountId = authState?.status === "authenticated" ? authState.user.id : null;

  useEffect(() => {
    let active = true;
    setAccess(null);
    setAccessError(false);
    setDevices(null);
    setDeviceError(undefined);
    if (!bridge)
      return () => {
        active = false;
      };
    if (authState?.status === "unauthenticated") {
      setAccess({ signedIn: false, enabled: false });
      return () => {
        active = false;
      };
    }
    if (authState?.status !== "authenticated")
      return () => {
        active = false;
      };
    void bridge.getState().then(
      (value) => {
        if (active) setAccess(value);
      },
      (error: unknown) => {
        if (active) {
          setAccessError(true);
          toastManager.add({
            type: "error",
            title: "Could not load iPhone access",
            description: error instanceof Error ? error.message : undefined,
          });
        }
      },
    );
    return () => {
      active = false;
    };
  }, [bridge, accountId, authState?.status]);

  useEffect(() => {
    if (!access?.signedIn || !access.enabled) return;
    const api = readNativeApi();
    if (!api) return;
    let active = true,
      revision = 0;
    const unsubscribe = api.remote.subscribeDevices(
      () => {
        const current = ++revision;
        void api.remote.listDevices().then(
          (value) => {
            if (active && current === revision) {
              setDevices(value);
              setDeviceError(undefined);
            }
          },
          () => {
            if (active && current === revision) {
              setDevices(null);
              setDeviceError("Could not load iPhones.");
            }
          },
        );
      },
      () => {
        if (active) {
          setDevices(null);
          setDeviceError("Could not load iPhones.");
        }
      },
    );
    return () => {
      active = false;
      revision++;
      unsubscribe();
    };
  }, [access?.signedIn, access?.enabled, accountId]);

  if (!bridge) return <div role="status">iPhone access is unavailable in this window.</div>;
  if (authState?.status === "error")
    return <div role="status">Could not verify your Penkra account.</div>;
  if (accessError) return <div role="status">Could not load iPhone access.</div>;
  if (!access) return <div role="status">Loading iPhone access…</div>;
  const change = async (enabled: boolean) => {
    if (!bridge || busy) return;
    setBusy(true);
    try {
      await bridge.setEnabled(enabled);
      setAccess(await bridge.getState());
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not change iPhone access",
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setBusy(false);
    }
  };
  const remove = async (deviceId: string) => {
    const phone = devices?.phones.find((value) => value.deviceId === deviceId);
    if (!phone || !window.desktopBridge) return;
    const confirmed = await window.desktopBridge.confirm({
      type: "warning",
      title: "Remove iPhone?",
      message: `Remove “${phone.name}”?`,
      detail: "It will need to be approved again.",
      confirmLabel: "Remove",
      cancelLabel: "Cancel",
    });
    if (!confirmed) return;
    try {
      await readNativeApi()!.remote.removeDevice(deviceId);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not remove iPhone",
        description: error instanceof Error ? error.message : undefined,
      });
    }
  };
  return (
    <SettingsIphonePage
      signedIn={access.signedIn}
      accessOn={access.enabled}
      busy={busy}
      onAccessChange={(value) => void change(value)}
      phones={devices?.phones ?? null}
      deviceError={deviceError}
      onRemove={(id) => void remove(id)}
      relay={{ kind: devices?.relay ?? "connecting" }}
      onSignInAgain={() => void accountAuth?.requestSignIn()}
      onCheckForUpdates={() => void window.desktopBridge?.checkForUpdates()}
    />
  );
}
