// P29: observe missing shell surfaces without polling or changing layout.
import { useEffect } from "react";
import { useRightDockStore } from "../rightDockStore";
import { useStore } from "../store";

let lastBoundaryError: string | null = null;
export function recordP29BoundaryError(error: unknown): void {
  lastBoundaryError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

export function useP29LayoutTrace(input: {
  threadId: string;
  folderId: string | null;
  expected: boolean;
}): void {
  const { threadId, folderId, expected } = input;
  useEffect(() => {
    if (!expected || !folderId) return;
    let frame = 0;
    let anomaly: Record<string, unknown> | null = null;
    let observedShell: HTMLElement | null = null;
    const observer = new MutationObserver((records) => {
      const relevant =
        "[data-chat-surface-shell], [data-p29-thread-content], [data-p29-thread-hydration], [data-right-dock-root], [role=tablist]";
      if (
        records.some(
          (record) =>
            (record.type === "attributes" &&
              record.target instanceof Element &&
              (record.target === observedShell ||
                record.target.matches(relevant) ||
                Boolean(record.target.querySelector(relevant)))) ||
            [...record.addedNodes, ...record.removedNodes].some(
              (node) =>
                node instanceof Element && (node.matches(relevant) || node.querySelector(relevant)),
            ),
        )
      )
        schedule();
    });
    const inspect = () => {
      frame = 0;
      const shell = document.querySelector<HTMLElement>("[data-chat-surface-shell]");
      if (shell !== observedShell) {
        observer.disconnect();
        observedShell = shell;
        if (shell) {
          observer.observe(shell, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ["class", "style"],
          });
          if (shell.parentElement) observer.observe(shell.parentElement, { childList: true });
        }
      }
      const content = shell?.querySelector<HTMLElement>("[data-p29-thread-content]");
      const hydration = shell?.querySelector("[data-p29-thread-hydration]");
      const dock = shell?.querySelector<HTMLElement>("[data-right-dock-root]");
      const tabs = dock?.querySelector<HTMLElement>('[role="tablist"]');
      const state = useRightDockStore.getState().dockStateByFolderId[folderId];
      const bounds = (element: HTMLElement | null | undefined) => {
        if (!element) return null;
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return {
          width: rect.width,
          height: rect.height,
          display: style.display,
          visibility: style.visibility,
        };
      };
      const contentBounds = bounds(content);
      const tabBounds = bounds(tabs);
      const missingChat =
        !hydration &&
        (!contentBounds ||
          contentBounds.width === 0 ||
          contentBounds.height === 0 ||
          contentBounds.display === "none" ||
          contentBounds.visibility === "hidden");
      const missingTabs = Boolean(
        state?.open &&
        state.panes.length &&
        (!tabBounds ||
          tabBounds.width === 0 ||
          tabBounds.height === 0 ||
          tabBounds.display === "none" ||
          tabBounds.visibility === "hidden"),
      );
      const snapshot = {
        route: location.hash || location.pathname,
        threadId,
        folderId,
        mounted: {
          shell: !!shell,
          content: !!content,
          hydration: !!hydration,
          dock: !!dock,
          tabs: !!tabs,
        },
        bounds: {
          shell: bounds(shell),
          content: contentBounds,
          dock: bounds(dock),
          tabs: tabBounds,
        },
        dockState: state
          ? {
              open: state.open,
              activePaneId: state.activePaneId,
              width: state.width,
              paneIds: state.panes.map((pane) => pane.id),
            }
          : null,
        lastBoundaryError,
      };
      if ((missingChat || missingTabs) && anomaly === null) {
        anomaly = snapshot;
        console.warn("[p29] missing chat or dock surface", {
          missingChat,
          missingTabs,
          ...snapshot,
        });
      } else if (anomaly && !missingChat && !missingTabs) {
        console.warn("[p29] surface restored", { before: anomaly, after: snapshot });
        anomaly = null;
      }
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(inspect);
    };
    const stopStore = useStore.subscribe((state, previous) => {
      if (state.folders !== previous.folders) schedule();
    });
    const stopDock = useRightDockStore.subscribe((state, previous) => {
      if (state.dockStateByFolderId[folderId] !== previous.dockStateByFolderId[folderId])
        schedule();
    });
    window.addEventListener("resize", schedule);
    schedule();
    return () => {
      observer.disconnect();
      stopStore();
      stopDock();
      window.removeEventListener("resize", schedule);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [threadId, folderId, expected]);
}
