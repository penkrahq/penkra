import type { NativeApi } from "@penkra/contracts";

import { createWsNativeApi, reconnectWsNativeApiForQa } from "./wsNativeApi";

let cachedDesktopApi: NativeApi | undefined;
export function readNativeApi(): NativeApi | undefined {
  if (typeof window === "undefined") return undefined;
  if (cachedDesktopApi && window.nativeApi === cachedDesktopApi) return cachedDesktopApi;

  if (window.nativeApi) {
    cachedDesktopApi = window.nativeApi;
    return cachedDesktopApi;
  }

  return createWsNativeApi();
}

export function ensureNativeApi(): NativeApi {
  const api = readNativeApi();
  if (!api) {
    throw new Error("Native API not found");
  }
  return api;
}

export async function reconnectNativeApiTransportForQa(): Promise<void> {
  if (!import.meta.env.DEV || !window.desktopBridge?.qaOpenWindow)
    throw new Error("Diagnostics QA transport action is unavailable");
  readNativeApi();
  await reconnectWsNativeApiForQa();
}
