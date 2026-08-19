// FILE: AppDockPane.tsx
// Purpose: Mirrors one host-owned isolated App renderer into its right-dock tab viewport.
// Layer: Chat right-dock App surface

import { IconPackage } from "@tabler/icons-react";
import {
  APP_RUNTIME_BRIDGE_PROTOCOL_VERSION,
  APP_RUNTIME_CONNECT_MESSAGE,
  type AppRuntimeFrameMessage,
  type AppRuntimeHostMessage,
} from "@penkra/contracts";
import type { AppBrowserSessionState } from "@penkra/sdk";
import { useEffect, useMemo, useRef, useState } from "react";

import { PanelStateMessage } from "./PanelStateMessage";

export function AppDockPane(props: {
  tabId: string;
  rendererId: number;
  status: "loading" | "ready" | "crashed" | null;
  visible: boolean;
  appName: string | null;
  iconDataUrl?: string | null;
  documentUrl: string;
}) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const browserWebviewRef = useRef<BrowserWebviewElement | null>(null);
  const [browserState, setBrowserState] = useState<AppBrowserSessionState | null>(null);
  const [browserSurface, setBrowserSurface] = useState<BrowserSurface | null>(null);
  const [simulatorSurface, setSimulatorSurface] = useState<SurfaceBounds | null>(null);
  const [simulatorFrame, setSimulatorFrame] = useState<string | null>(null);
  const browserPage = useMemo(
    () => browserState?.pages.find((page) => page.id === browserState.activePageId) ?? null,
    [browserState],
  );

  useEffect(() => {
    const bridge = window.desktopBridge?.appTabs;
    if (!bridge) return;
    return () => {
      void bridge.setActive({ tabId: props.tabId, rendererId: props.rendererId, active: false });
    };
  }, [props.rendererId, props.tabId]);

  useEffect(() => {
    void window.desktopBridge?.appTabs?.setActive({
      tabId: props.tabId,
      rendererId: props.rendererId,
      active: props.visible,
    });
  }, [props.rendererId, props.tabId, props.visible]);

  useEffect(() => {
    const bridge = window.desktopBridge?.appTabs;
    const iframe = iframeRef.current;
    if (!bridge || !iframe || !props.documentUrl) return;
    let port: MessagePort | null = null;
    let removeHostMessage: (() => void) | null = null;
    const connect = () => {
      port?.close();
      removeHostMessage?.();
      const channel = new MessageChannel();
      port = channel.port1;
      port.onmessage = (event: MessageEvent<AppRuntimeFrameMessage>) => {
        const message = event.data;
        if (message.type === "ready") {
          void bridge.frameReady({ tabId: props.tabId, rendererId: props.rendererId });
        } else if (message.type === "renderer-message") {
          void bridge.frameMessage({
            tabId: props.tabId,
            rendererId: props.rendererId,
            message: message.message,
          });
        } else if (message.type === "call") {
          void bridge
            .frameCall({
              tabId: props.tabId,
              rendererId: props.rendererId,
              method: message.method,
              ...(message.input === undefined ? {} : { input: message.input }),
            })
            .then(
              (result) =>
                port?.postMessage({
                  type: "call-result",
                  id: message.id,
                  result,
                } satisfies AppRuntimeHostMessage),
              (error: unknown) =>
                port?.postMessage({
                  type: "call-error",
                  id: message.id,
                  code:
                    error && typeof error === "object" && "code" in error
                      ? String(error.code)
                      : "RUNTIME_ERROR",
                  message: error instanceof Error ? error.message : String(error),
                } satisfies AppRuntimeHostMessage),
            );
        }
      };
      port.start();
      removeHostMessage = bridge.onFrameHostMessage((input) => {
        if (input.tabId !== props.tabId || input.rendererId !== props.rendererId) return;
        if (input.delivery.kind === "event" && input.delivery.name === "browser.state") {
          setBrowserState(input.delivery.payload as AppBrowserSessionState);
        }
        if (input.delivery.kind === "event" && input.delivery.name === "browser.surface") {
          setBrowserSurface(
            isBrowserSurface(input.delivery.payload) ? input.delivery.payload : null,
          );
        }
        if (input.delivery.kind === "event" && input.delivery.name === "simulator.surface") {
          setSimulatorSurface(
            isSurfaceBounds(input.delivery.payload) ? input.delivery.payload : null,
          );
        }
        if (input.delivery.kind === "event" && input.delivery.name === "simulator.frame") {
          const frame = input.delivery.payload as { dataUrl?: unknown } | null;
          if (typeof frame?.dataUrl === "string") setSimulatorFrame(frame.dataUrl);
        }
        port?.postMessage(
          input.delivery.kind === "host-message"
            ? ({
                type: "host-message",
                message: input.delivery.message,
              } satisfies AppRuntimeHostMessage)
            : ({
                type: "event",
                name: input.delivery.name,
                payload: input.delivery.payload,
              } satisfies AppRuntimeHostMessage),
        );
      });
      iframe.contentWindow?.postMessage(
        {
          type: APP_RUNTIME_CONNECT_MESSAGE,
          protocolVersion: APP_RUNTIME_BRIDGE_PROTOCOL_VERSION,
        },
        "*",
        [channel.port2],
      );
    };
    iframe.addEventListener("load", connect);
    return () => {
      iframe.removeEventListener("load", connect);
      removeHostMessage?.();
      port?.close();
    };
  }, [props.documentUrl, props.rendererId, props.tabId]);

  useEffect(() => {
    const bridge = window.desktopBridge?.appTabs;
    const webview = browserWebviewRef.current;
    if (!bridge || !webview || !browserPage || !browserSurface) return;
    let attachedWebContentsId: number | null = null;
    const attach = () => {
      const webContentsId = webview.getWebContentsId();
      if (!Number.isInteger(webContentsId) || webContentsId <= 0) return;
      attachedWebContentsId = webContentsId;
      void bridge.browserWebviewAttach({
        tabId: props.tabId,
        rendererId: props.rendererId,
        pageId: browserPage.id,
        webContentsId,
      });
    };
    webview.addEventListener("dom-ready", attach);
    return () => {
      webview.removeEventListener("dom-ready", attach);
      if (attachedWebContentsId !== null) {
        void bridge.browserWebviewDetach({
          tabId: props.tabId,
          rendererId: props.rendererId,
          pageId: browserPage.id,
          webContentsId: attachedWebContentsId,
        });
      }
    };
  }, [browserPage, browserSurface, props.rendererId, props.tabId]);

  return (
    <div className="relative h-full min-h-0 w-full overflow-hidden">
      {props.documentUrl ? (
        <iframe
          ref={iframeRef}
          data-app-tab-id={props.tabId}
          className="h-full min-h-0 w-full border-0 bg-background"
          hidden={!props.visible || props.status === "crashed"}
          sandbox="allow-forms allow-modals allow-same-origin allow-scripts"
          src={props.documentUrl}
          title={props.appName ?? "App"}
        />
      ) : null}
      {props.visible && browserSurface && browserPage && browserPage.url !== "about:blank" ? (
        <webview
          key={browserPage.id}
          ref={browserWebviewRef}
          className="absolute z-10 flex bg-background"
          partition={browserSurface.partition}
          src={browserPage.url}
          style={{
            top: browserSurface.insets.top,
            right: browserSurface.insets.right,
            bottom: browserSurface.insets.bottom,
            left: browserSurface.insets.left,
          }}
        />
      ) : null}
      {props.visible && simulatorSurface && simulatorFrame ? (
        <img
          alt="Live simulator display"
          className="pointer-events-none absolute z-10 bg-black object-contain"
          src={simulatorFrame}
          style={{
            left: simulatorSurface.x,
            top: simulatorSurface.y,
            width: simulatorSurface.width,
            height: simulatorSurface.height,
          }}
        />
      ) : null}
      {props.status === "crashed" ? (
        <PanelStateMessage>
          The App stopped responding. Close this tab and open it again.
        </PanelStateMessage>
      ) : props.status !== "ready" ? (
        <div
          aria-label={`Loading ${props.appName ?? "App"}`}
          className="flex h-full min-h-0 w-full items-center justify-center"
          role="status"
        >
          {props.iconDataUrl ? (
            <img
              alt=""
              className="size-12 rounded-xl object-contain"
              draggable={false}
              src={props.iconDataUrl}
            />
          ) : (
            <span className="flex size-12 items-center justify-center rounded-xl bg-muted text-muted-foreground">
              <IconPackage aria-hidden="true" className="size-5" />
            </span>
          )}
        </div>
      ) : null}
    </div>
  );
}

interface BrowserWebviewElement extends HTMLElement {
  getWebContentsId(): number;
}

interface BrowserSurface {
  insets: { top: number; right: number; bottom: number; left: number };
  partition: string;
}

interface SurfaceBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

function isBrowserSurface(value: unknown): value is BrowserSurface {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.partition !== "string") return false;
  return isSurfaceInsets(record.insets);
}

function isSurfaceInsets(value: unknown): value is BrowserSurface["insets"] {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    ["top", "right", "bottom", "left"].every((key) => {
      const candidate = (value as Record<string, unknown>)[key];
      return typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0;
    })
  );
}

function isSurfaceBounds(value: unknown): value is SurfaceBounds {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    ["x", "y", "width", "height"].every(
      (key) => typeof (value as Record<string, unknown>)[key] === "number",
    )
  );
}
