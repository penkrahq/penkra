// FILE: ComposerColumnFrame.tsx
// Purpose: Shared composer column wrapper and the stacked-activity rail that must
// live inside it (queued follow-ups, active plan/task activity). Keeps stacked panels
// aligned with the composer input instead of the full gutter viewport.
// Layer: Chat composer layout
// Exports: ComposerColumnFrame, ComposerStackedHeaderFrame

import {
  createContext,
  memo,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type HTMLAttributes,
  type ReactNode,
  type Ref,
} from "react";

import { cn } from "~/lib/utils";
import {
  COMPOSER_COLUMN_FRAME_CLASS_NAME,
  COMPOSER_STACKED_HEADER_FRAME_CLASS_NAME,
} from "./composerPickerStyles";

export interface ComposerOverlayCollisionBoundary {
  x: number;
  y: number;
  width: number;
  height: number;
}

const ComposerColumnFrameContext = createContext<{
  collisionBoundary: ComposerOverlayCollisionBoundary | null;
} | null>(null);

function useComposerColumnFrameContext(componentName: string) {
  const context = useContext(ComposerColumnFrameContext);
  if (import.meta.env.DEV && !context) {
    console.warn(
      `${componentName} must render inside ComposerColumnFrame so stacked activity stays aligned to the composer input width.`,
    );
  }
  return context;
}

export function useComposerOverlayCollisionBoundary() {
  return useContext(ComposerColumnFrameContext)?.collisionBoundary ?? null;
}

interface ComposerColumnFrameProps {
  children: ReactNode;
  className?: string;
}

/** Centers the composer column at the shared chat max width. */
export const ComposerColumnFrame = function ComposerColumnFrame({
  children,
  className,
}: ComposerColumnFrameProps) {
  const frameRef = useRef<HTMLDivElement>(null);
  const [collisionBoundary, setCollisionBoundary] =
    useState<ComposerOverlayCollisionBoundary | null>(null);

  useLayoutEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const measure = () => {
      const rect = frame.getBoundingClientRect();
      const next = { x: rect.left, y: 0, width: rect.width, height: window.innerHeight };
      setCollisionBoundary((current) =>
        current &&
        current.x === next.x &&
        current.width === next.width &&
        current.height === next.height
          ? current
          : next,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(frame);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);
  const contextValue = useMemo(() => ({ collisionBoundary }), [collisionBoundary]);

  return (
    <ComposerColumnFrameContext.Provider value={contextValue}>
      <div
        ref={frameRef}
        className={cn(COMPOSER_COLUMN_FRAME_CLASS_NAME, className)}
        data-composer-column-frame
      >
        {children}
      </div>
    </ComposerColumnFrameContext.Provider>
  );
};

interface ComposerStackedHeaderFrameProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  ref?: Ref<HTMLDivElement> | undefined;
  /** Lets clicks pass through the side margins to the transcript underneath. */
  passthroughSideMargins?: boolean;
}

/** Full-width rail for panels stacked flush above the composer input. */
export const ComposerStackedHeaderFrame = memo(function ComposerStackedHeaderFrame({
  children,
  className,
  ref,
  passthroughSideMargins: passthroughSideMarginsProp,
  ...rest
}: ComposerStackedHeaderFrameProps) {
  const passthroughSideMargins = passthroughSideMarginsProp ?? false;
  useComposerColumnFrameContext("ComposerStackedHeaderFrame");

  const frameClassName = cn(COMPOSER_STACKED_HEADER_FRAME_CLASS_NAME, className);

  if (passthroughSideMargins) {
    return (
      <div className="pointer-events-none w-full">
        <div ref={ref} className={cn("pointer-events-auto", frameClassName)} {...rest}>
          {children}
        </div>
      </div>
    );
  }

  return (
    <div ref={ref} className={frameClassName} {...rest}>
      {children}
    </div>
  );
});
