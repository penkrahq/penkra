// FILE: FindProvider.tsx
// Purpose: Owns the application find coordinator and exposes it to open-view surfaces.
// Layer: Web application context
// Exports: FindProvider, useFind, useOptionalFind

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type PropsWithChildren,
} from "react";
import { createDomFindSurface } from "../../lib/find/domFindSurface";
import { FindCoordinator, type FindState, type FindSurface } from "../../lib/find/findCoordinator";

interface FindContextValue {
  readonly state: FindState;
  setQuery(query: string): void;
  next(): Promise<void>;
  previous(): Promise<void>;
  clear(): void;
  register(surface: FindSurface): () => void;
}

const FindContext = createContext<FindContextValue | null>(null);
type FindActions = Omit<FindContextValue, "state">;
const FIND_HIGHLIGHT_STYLE_ID = "penkra-find-highlight-styles";
const FIND_HIGHLIGHT_STYLES = `
::highlight(penkra-find-match) {
  color: inherit;
  background-color: color-mix(in srgb, var(--warning, #f59e0b) 48%, transparent);
}
::highlight(penkra-find-active),
::highlight(penkra-find-transcript-active),
::highlight(penkra-find-diff-active),
::highlight(penkra-find-pdf-active) {
  color: inherit;
  background-color: color-mix(in srgb, var(--warning, #f59e0b) 82%, transparent);
  text-decoration: underline;
  text-decoration-thickness: 2px;
}`;

export function FindProvider({ children }: PropsWithChildren) {
  const coordinator = useMemo(() => new FindCoordinator(), []);
  const disposeEpochRef = useRef(0);
  const state = useSyncExternalStore(
    coordinator.subscribe,
    coordinator.getSnapshot,
    coordinator.getSnapshot,
  );

  useEffect(() => {
    let style = document.getElementById(FIND_HIGHLIGHT_STYLE_ID) as HTMLStyleElement | null;
    if (!style) {
      style = document.createElement("style");
      style.id = FIND_HIGHLIGHT_STYLE_ID;
      style.textContent = FIND_HIGHLIGHT_STYLES;
      document.head.append(style);
    }
    return () => style?.remove();
  }, []);

  useEffect(() => {
    const root = document.querySelector<HTMLElement>("[data-find-application-root]");
    if (!root) return;
    return coordinator.register(
      createDomFindSurface({
        id: "rendered-application",
        order: 0,
        root,
      }),
    );
  }, [coordinator]);

  useEffect(() => {
    const epoch = ++disposeEpochRef.current;
    return () => {
      // React Strict Mode probes effects with a setup → cleanup → setup cycle
      // while preserving memoized values. Defer permanent disposal so the
      // immediate second setup can cancel the probe cleanup.
      queueMicrotask(() => {
        if (disposeEpochRef.current === epoch) coordinator.dispose();
      });
    };
  }, [coordinator]);

  const actions = useMemo<FindActions>(
    () => ({
      setQuery: (query) => coordinator.setQuery(query),
      next: () => coordinator.next(),
      previous: () => coordinator.previous(),
      clear: () => coordinator.clear(),
      register: (surface) => coordinator.register(surface),
    }),
    [coordinator],
  );
  const value = useMemo<FindContextValue>(() => ({ state, ...actions }), [actions, state]);
  return <FindContext.Provider value={value}>{children}</FindContext.Provider>;
}

export function useFind(): FindContextValue {
  const context = useContext(FindContext);
  if (!context) throw new Error("useFind must be used within FindProvider");
  return context;
}

export function useOptionalFind(): FindContextValue | null {
  return useContext(FindContext);
}
