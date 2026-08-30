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
import { deriveChromeUserAgent } from "@penkra/shared/browserSession";
import type { AppBrowserSessionState } from "@penkra/sdk";
import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { PanelStateMessage } from "./PanelStateMessage";

// Electron treats `allowpopups` as a boolean-by-presence webview attribute, but React removes a
// lowercase custom attribute when given `true`. Keep the type expected by React's webview
// declaration while passing the string value React will actually serialize.
const ALLOW_WEBVIEW_POPUPS_ATTRIBUTE = "true" as unknown as boolean;

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
  const frameConnectionRef = useRef<{
    port: MessagePort;
    removeHostMessage: () => void;
  } | null>(null);
  const [browserState, setBrowserState] = useState<AppBrowserSessionState | null>(null);
  const [browserSurface, setBrowserSurface] = useState<BrowserSurface | null>(null);
  const [browserSurfacePresented, setBrowserSurfacePresented] = useState(false);
  const browserSurfacePartition = browserSurface?.partition;
  const [simulatorSurface, setSimulatorSurface] = useState<SurfaceBounds | null>(null);
  const [simulatorFrame, setSimulatorFrame] = useState<string | null>(null);
  const browserPage = useMemo(
    () => browserState?.pages.find((page) => page.id === browserState.activePageId) ?? null,
    [browserState],
  );
  const browserUserAgent = useMemo(
    () =>
      deriveChromeUserAgent(typeof navigator === "undefined" ? "Mozilla/5.0" : navigator.userAgent),
    [],
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

  const disconnectFrame = useCallback(() => {
    const connection = frameConnectionRef.current;
    frameConnectionRef.current = null;
    connection?.removeHostMessage();
    connection?.port.close();
  }, []);

  const connectFrame = useCallback(
    (iframe: HTMLIFrameElement) => {
      const bridge = window.desktopBridge?.appTabs;
      if (!bridge || !props.documentUrl) return;
      disconnectFrame();
      const channel = new MessageChannel();
      const port = channel.port1;
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
                port.postMessage({
                  type: "call-result",
                  id: message.id,
                  result,
                } satisfies AppRuntimeHostMessage),
              (error: unknown) =>
                port.postMessage({
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
      const removeHostMessage = bridge.onFrameHostMessage((input) => {
        if (input.tabId !== props.tabId || input.rendererId !== props.rendererId) return;
        if (input.delivery.kind === "event" && input.delivery.name === "browser.state") {
          setBrowserState(input.delivery.payload as AppBrowserSessionState);
        }
        if (input.delivery.kind === "event" && input.delivery.name === "browser.surface") {
          const surface = isBrowserSurface(input.delivery.payload) ? input.delivery.payload : null;
          if (surface) setBrowserSurface(surface);
          setBrowserSurfacePresented(surface !== null);
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
        port.postMessage(
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
      frameConnectionRef.current = { port, removeHostMessage };
      iframe.contentWindow?.postMessage(
        {
          type: APP_RUNTIME_CONNECT_MESSAGE,
          protocolVersion: APP_RUNTIME_BRIDGE_PROTOCOL_VERSION,
        },
        "*",
        [channel.port2],
      );
    },
    [disconnectFrame, props.documentUrl, props.rendererId, props.tabId],
  );

  useEffect(() => disconnectFrame, [connectFrame, disconnectFrame]);

  return (
    <div className="relative h-full min-h-0 w-full overflow-hidden">
      {props.documentUrl ? (
        <iframe
          key={props.rendererId}
          ref={iframeRef}
          data-app-tab-id={props.tabId}
          name={`penkra-app-tab:${props.tabId}`}
          className="h-full min-h-0 w-full border-0 bg-background"
          hidden={!props.visible || props.status === "crashed"}
          sandbox="allow-forms allow-modals allow-same-origin allow-scripts"
          src={props.documentUrl}
          title={props.appName ?? "App"}
          onLoad={(event) => connectFrame(event.currentTarget)}
        />
      ) : null}
      {browserSurface && browserSurfacePartition
        ? browserState?.pages.map((page) => {
            const isActive = page.id === browserPage?.id;
            const isPresented =
              props.visible && browserSurfacePresented && isActive && !page.lastError;
            const surfaceStyle: CSSProperties = {
              top: browserSurface.insets.top,
              right: browserSurface.insets.right,
              bottom: browserSurface.insets.bottom,
              left: browserSurface.insets.left,
              visibility: isPresented ? "visible" : "hidden",
            };
            if (page.presentation === "host") {
              return (
                <HostedBrowserNativePage
                  active={isPresented}
                  key={page.id}
                  pageId={page.id}
                  rendererId={props.rendererId}
                  rendererSurfaceActive={props.visible && browserSurfacePresented}
                  style={surfaceStyle}
                  tabId={props.tabId}
                />
              );
            }
            return page.url === "about:blank" ? null : (
              <HostedBrowserWebview
                initialUrl={page.url}
                key={page.id}
                pageId={page.id}
                partition={browserSurfacePartition}
                rendererId={props.rendererId}
                tabId={props.tabId}
                useragent={browserUserAgent}
                // Presentation is independent from lifetime: hidden App tabs and inactive
                // Browser pages keep their live guest so auth and transient page state survive.
                style={surfaceStyle}
              />
            );
          })
        : null}
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

function HostedBrowserNativePage(props: {
  active: boolean;
  pageId: string;
  rendererId: number;
  rendererSurfaceActive: boolean;
  style: CSSProperties;
  tabId: string;
}) {
  const surfaceRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const bridge = window.desktopBridge?.appTabs;
    const surface = surfaceRef.current;
    if (!bridge || !surface) return;
    let scheduledFrame: number | null = null;

    const publish = () => {
      scheduledFrame = null;
      const rect = props.active ? surface.getBoundingClientRect() : null;
      const bounds =
        rect && rect.width > 0 && rect.height > 0
          ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
          : null;
      void bridge.browserHostedPageBounds({
        tabId: props.tabId,
        rendererId: props.rendererId,
        pageId: props.pageId,
        bounds,
        rendererSurfaceActive: props.rendererSurfaceActive,
      });
    };
    const schedule = () => {
      if (scheduledFrame !== null) return;
      scheduledFrame = window.requestAnimationFrame(publish);
    };

    const resizeObserver = new ResizeObserver(schedule);
    resizeObserver.observe(surface);
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    schedule();
    return () => {
      if (scheduledFrame !== null) window.cancelAnimationFrame(scheduledFrame);
      resizeObserver.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
      void bridge.browserHostedPageBounds({
        tabId: props.tabId,
        rendererId: props.rendererId,
        pageId: props.pageId,
        bounds: null,
        rendererSurfaceActive: props.rendererSurfaceActive,
      });
    };
  }, [props.active, props.pageId, props.rendererId, props.rendererSurfaceActive, props.tabId]);

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute z-10 bg-background"
      data-hosted-browser-page-id={props.pageId}
      ref={surfaceRef}
      style={props.style}
    />
  );
}

function HostedBrowserWebview(props: {
  initialUrl: string;
  pageId: string;
  partition: string;
  rendererId: number;
  tabId: string;
  useragent: string;
  style: CSSProperties;
}) {
  const webviewRef = useRef<BrowserWebviewElement | null>(null);
  // `src` bootstraps a new guest only. Once mounted, explicit Browser commands own navigation.
  // Reflecting did-navigate state back into this attribute calls loadURL again, which turns a
  // redirect chain (especially a Cloudflare challenge) into an abort/retry request storm.
  const bootstrapUrl = useRef(props.initialUrl).current;
  useEffect(() => {
    const bridge = window.desktopBridge?.appTabs;
    const webview = webviewRef.current;
    if (!bridge || !webview) return;
    let attachedWebContentsId: number | null = null;
    const didFailLoad = (event: Event) => {
      const failure = event as BrowserWebviewDidFailLoadEvent;
      void bridge.browserWebviewDidFailLoad({
        tabId: props.tabId,
        rendererId: props.rendererId,
        pageId: props.pageId,
        errorCode: failure.errorCode,
        errorDescription: failure.errorDescription,
        validatedUrl: failure.validatedURL,
        isMainFrame: failure.isMainFrame,
      });
    };
    const attach = () => {
      if (typeof webview.getWebContentsId !== "function") return;
      const webContentsId = webview.getWebContentsId();
      if (!Number.isInteger(webContentsId) || webContentsId <= 0) return;
      if (attachedWebContentsId === webContentsId) return;
      attachedWebContentsId = webContentsId;
      void bridge.browserWebviewAttach({
        tabId: props.tabId,
        rendererId: props.rendererId,
        pageId: props.pageId,
        webContentsId,
      });
    };
    webview.addEventListener("dom-ready", attach);
    webview.addEventListener("did-fail-load", didFailLoad);
    return () => {
      webview.removeEventListener("dom-ready", attach);
      webview.removeEventListener("did-fail-load", didFailLoad);
      if (attachedWebContentsId !== null) {
        void bridge.browserWebviewDetach({
          tabId: props.tabId,
          rendererId: props.rendererId,
          pageId: props.pageId,
          webContentsId: attachedWebContentsId,
        });
      }
    };
  }, [props.pageId, props.partition, props.rendererId, props.tabId]);

  return (
    <webview
      allowpopups={ALLOW_WEBVIEW_POPUPS_ATTRIBUTE}
      ref={webviewRef}
      className="absolute z-10 flex bg-background"
      partition={props.partition}
      src={bootstrapUrl}
      useragent={props.useragent}
      style={props.style}
    />
  );
}

interface BrowserWebviewElement extends HTMLElement {
  getWebContentsId(): number;
}

interface BrowserWebviewDidFailLoadEvent extends Event {
  errorCode: number;
  errorDescription: string;
  validatedURL: string;
  isMainFrame: boolean;
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
