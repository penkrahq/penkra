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
  useMemo,
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
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
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
  const [frame, setFrame] = useState<HTMLDivElement | null>(null);
  const collisionBoundary = useMemo<ComposerOverlayCollisionBoundary | null>(() => {
    if (!frame) return null;
    return {
      get x() {
        return frame.getBoundingClientRect().left;
      },
      get y() {
        return 0;
      },
      get width() {
        return frame.getBoundingClientRect().width;
      },
      get height() {
        return window.innerHeight;
      },
    };
  }, [frame]);
  const contextValue = useMemo(() => ({ collisionBoundary }), [collisionBoundary]);

  return (
    <ComposerColumnFrameContext.Provider value={contextValue}>
      <div
        ref={setFrame}
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
