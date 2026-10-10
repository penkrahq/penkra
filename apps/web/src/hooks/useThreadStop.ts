import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import type { ThreadId } from "@penkra/contracts";
import { readNativeApi } from "../nativeApi";
import { createThreadStopController } from "../threadStopController";

const subscribeEmpty = () => () => {};
const idleSnapshot = () => false;

export function useThreadStop(threadId: ThreadId | null, onError: (error: unknown) => void) {
  const errorHandler = useRef(onError);
  errorHandler.current = onError;
  const api = readNativeApi();
  const controller = useMemo(
    () =>
      api === undefined || threadId === null
        ? null
        : createThreadStopController(api.cleanCore, threadId, (error) =>
            errorHandler.current(error),
          ),
    [api, threadId],
  );
  useEffect(() => {
    controller?.connect();
    return () => controller?.dispose();
  }, [controller]);
  const stopping = useSyncExternalStore(
    controller?.subscribe ?? subscribeEmpty,
    controller?.getSnapshot ?? idleSnapshot,
  );
  return { stopping, stop: controller?.stop };
}
