import { TurnId, type NativeApi } from "@penkra/contracts";

import { createWsNativeApi } from "./wsNativeApi";

let cachedDesktopApi: NativeApi | undefined;
let cachedTurnOriginApi: NativeApi | undefined;
let cachedTurnOriginBase: NativeApi | undefined;

function withTurnOriginBinding(api: NativeApi): NativeApi {
  if (cachedTurnOriginApi && cachedTurnOriginBase === api) return cachedTurnOriginApi;
  const dispatchCommand: NativeApi["orchestration"]["dispatchCommand"] = async (command) => {
    if (command.type !== "thread.turn.start") {
      return api.orchestration.dispatchCommand(command);
    }
    const turnId = TurnId.makeUnsafe(`turn:${command.commandId}`);
    const bridge = window.desktopBridge?.threadApi;
    bridge?.bindTurnOrigin({ turnId });
    try {
      return await api.orchestration.dispatchCommand(command);
    } catch (error) {
      bridge?.unbindTurnOrigin({ turnId });
      throw error;
    }
  };
  cachedTurnOriginBase = api;
  cachedTurnOriginApi = {
    ...api,
    orchestration: { ...api.orchestration, dispatchCommand },
  };
  return cachedTurnOriginApi;
}

export function readNativeApi(): NativeApi | undefined {
  if (typeof window === "undefined") return undefined;
  if (cachedDesktopApi && window.nativeApi === cachedDesktopApi) return cachedDesktopApi;

  if (window.nativeApi) {
    cachedDesktopApi = window.nativeApi;
    return withTurnOriginBinding(cachedDesktopApi);
  }

  return withTurnOriginBinding(createWsNativeApi());
}

export function ensureNativeApi(): NativeApi {
  const api = readNativeApi();
  if (!api) {
    throw new Error("Native API not found");
  }
  return api;
}
