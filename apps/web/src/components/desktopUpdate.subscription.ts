import type { DesktopUpdateState } from "@synara/contracts";

type DesktopUpdateBridge = Pick<
  NonNullable<Window["desktopBridge"]>,
  "getUpdateState" | "onUpdateState"
>;

export function subscribeToDesktopUpdateState(
  bridge: DesktopUpdateBridge,
  onState: (state: DesktopUpdateState) => void,
): () => void {
  let disposed = false;
  const unsubscribe = bridge.onUpdateState((nextState) => {
    if (disposed) return;
    onState(nextState);
  });

  void bridge
    .getUpdateState()
    .then((nextState) => {
      // The main-process snapshot is authoritative for the instant the invoke
      // resolves. A queued progress event may arrive first, but must not suppress
      // a later "downloaded" snapshot and leave the Update button hidden.
      if (disposed) return;
      onState(nextState);
    })
    .catch(() => undefined);

  return () => {
    disposed = true;
    unsubscribe();
  };
}
