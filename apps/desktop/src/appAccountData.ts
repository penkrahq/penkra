// FILE: appAccountData.ts
// Purpose: Mediates credential-hidden access to an App's own Account backend namespace.
// Layer: Trusted desktop main process

import { io, type Socket } from "socket.io-client";

// Account-data stays buffered and IPC-safe in this first contract. Canvas's
// current 8 MiB source cap needs room for the same source plus a base64 Yjs
// snapshot during create/get; larger payloads require a future streaming API.
const MAX_REQUEST_BYTES = 24 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 24 * 1024 * 1024;
const CONNECT_TIMEOUT_MS = 10_000;
const APP_ID_PATTERN = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9-]*){2,}$/;

export type AppAccountDataRequest = {
  path: string;
  method?: "DELETE" | "GET" | "PATCH" | "POST" | "PUT";
  body?: string | Uint8Array;
  contentType?: "application/json" | "application/octet-stream";
};

export type AppAccountDataResponse = {
  status: number;
  headers: Readonly<Record<string, string>>;
  body: Uint8Array;
};

export type AppAccountRealtimeEvent = {
  channel: string;
  event: string;
  payload: unknown;
  occurredAt: string;
};

export type AppAccountRealtimeConnectionState = "connected" | "reconnecting";

export async function requestAppAccountData(input: {
  apiUrl: string;
  appId: string;
  cookie: string;
  request: AppAccountDataRequest;
  fetch?: typeof fetch;
}): Promise<AppAccountDataResponse> {
  assertAppId(input.appId);
  if (!input.cookie) throw accountRequired();
  const path = normalizeNamespacePath(input.request.path);
  const method = input.request.method ?? "GET";
  const body = normalizeBody(input.request.body);
  if ((method === "GET" || method === "DELETE") && body !== undefined) {
    throw new Error(`${method} Account-data requests cannot include a body.`);
  }
  const request = input.fetch ?? fetch;
  const response = await request(
    `${input.apiUrl}/api/apps/${encodeURIComponent(input.appId)}${path}`,
    {
      method,
      headers: {
        accept: "application/json, application/octet-stream",
        cookie: input.cookie,
        "x-penkra-app-id": input.appId,
        ...(body === undefined
          ? {}
          : { "content-type": input.request.contentType ?? "application/json" }),
      },
      ...(body === undefined ? {} : { body }),
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    },
  );
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw new Error("Account-data response is too large.");
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_RESPONSE_BYTES) throw new Error("Account-data response is too large.");
  const visibleHeaders: Record<string, string> = {};
  for (const name of ["content-type", "etag", "retry-after"]) {
    const value = response.headers.get(name);
    if (value !== null) visibleHeaders[name] = value;
  }
  return {
    status: response.status,
    headers: visibleHeaders,
    body: bytes,
  };
}

export async function subscribeAppAccountData(input: {
  apiUrl: string;
  appId: string;
  cookie: string;
  channel: string;
  onEvent: (event: AppAccountRealtimeEvent) => void;
  onConnectionStateChange?: (state: AppAccountRealtimeConnectionState) => void;
  connect?: typeof io;
}): Promise<{ stop(): void }> {
  assertAppId(input.appId);
  if (!input.cookie) throw accountRequired();
  if (!input.channel || input.channel.length > 200)
    throw new Error("Account-data channel is invalid.");
  const connect = input.connect ?? io;
  const socket = connect(input.apiUrl, {
    path: "/api/socket.io",
    transports: ["websocket"],
    auth: { accountCookie: input.cookie, appId: input.appId },
    reconnection: true,
    reconnectionDelay: 500,
    reconnectionDelayMax: 10_000,
    timeout: CONNECT_TIMEOUT_MS,
  });
  const listener = (candidate: unknown) => {
    const event = parseRealtimeEvent(candidate, input.channel);
    if (event) input.onEvent(event);
  };
  // Realtime data can arrive immediately after the subscription acknowledgement.
  // Listen before subscribing so the initial presence state cannot be lost.
  socket.on("app:event", listener);
  try {
    await waitForConnection(socket);
    await subscribe(socket, input.channel);
    input.onConnectionStateChange?.("connected");
  } catch (error) {
    socket.off("app:event", listener);
    socket.close();
    throw error;
  }
  const connected = () => {
    void subscribe(socket, input.channel)
      .then(() => input.onConnectionStateChange?.("connected"))
      .catch(() => undefined);
  };
  const disconnected = () => input.onConnectionStateChange?.("reconnecting");
  socket.on("connect", connected);
  socket.on("disconnect", disconnected);
  return {
    stop: () => {
      socket.emit("app:unsubscribe", { channel: input.channel });
      socket.off("app:event", listener);
      socket.off("connect", connected);
      socket.off("disconnect", disconnected);
      socket.close();
    },
  };
}

export function normalizeNamespacePath(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.length > 2_048) {
    throw new Error("Account-data path must be a bounded absolute namespace path.");
  }
  if (
    value.startsWith("//") ||
    value.includes("\\") ||
    /(?:^|\/)(?:\.{1,2})(?:\/|$)/u.test(value)
  ) {
    throw new Error("Account-data path cannot escape the App namespace.");
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new Error("Account-data path contains invalid encoding.");
  }
  if (/(?:^|\/)(?:\.{1,2})(?:\/|$)/u.test(decoded)) {
    throw new Error("Account-data path cannot escape the App namespace.");
  }
  return value;
}

function normalizeBody(
  value: string | Uint8Array | undefined,
): string | Uint8Array<ArrayBuffer> | undefined {
  if (value === undefined) return undefined;
  const bytes = typeof value === "string" ? Buffer.byteLength(value) : value.byteLength;
  if (bytes > MAX_REQUEST_BYTES) throw new Error("Account-data request body is too large.");
  return typeof value === "string" ? value : new Uint8Array(value);
}

function waitForConnection(socket: Socket): Promise<void> {
  if (socket.connected) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => settle(new Error("Account-data realtime connection timed out.")),
      CONNECT_TIMEOUT_MS,
    );
    const settle = (error?: Error) => {
      clearTimeout(timer);
      socket.off("connect", connected);
      socket.off("connect_error", failed);
      error ? reject(error) : resolve();
    };
    const connected = () => settle();
    const failed = (error: Error) => settle(error);
    socket.once("connect", connected);
    socket.once("connect_error", failed);
  });
}

function subscribe(socket: Socket, channel: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Account-data subscription timed out.")),
      CONNECT_TIMEOUT_MS,
    );
    socket.emit("app:subscribe", { channel }, (result: { ok?: unknown; error?: unknown }) => {
      clearTimeout(timer);
      if (result?.ok === true) resolve();
      else
        reject(
          new Error(typeof result?.error === "string" ? result.error : "Subscription failed."),
        );
    });
  });
}

function parseRealtimeEvent(candidate: unknown, channel: string): AppAccountRealtimeEvent | null {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
  const value = candidate as Record<string, unknown>;
  if (
    value.channel !== channel ||
    typeof value.event !== "string" ||
    value.event.length === 0 ||
    value.event.length > 100 ||
    typeof value.occurredAt !== "string"
  ) {
    return null;
  }
  return {
    channel,
    event: value.event,
    payload: value.payload,
    occurredAt: value.occurredAt,
  };
}

function assertAppId(value: string): void {
  if (!APP_ID_PATTERN.test(value)) throw new Error("Account-data App identity is invalid.");
}

function accountRequired(): Error {
  return Object.assign(new Error("Sign in to use this App's Account data."), {
    code: "ACCOUNT_SESSION_REQUIRED",
  });
}
