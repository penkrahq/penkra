// FILE: FileDiffView.tsx
// Purpose: Pull-request diff viewer chrome — a virtualized scroll surface plus a
//          themed per-file card with shared font/theme behavior, the Penkra file
//          header, and the @pierre/diffs `unsafeCSS` theming.
// Layer: Chat/diff UI primitives
// Depends on: @pierre/diffs FileDiff/Virtualizer, diffRendering (theme + unsafeCSS), FileDiffHeader

import { FileDiff, type FileDiffMetadata, Virtualizer } from "@pierre/diffs/react";
import { type ReactNode } from "react";

import { buildFileDiffUnsafeCSS, resolveDiffThemeName } from "~/lib/diffRendering";
import { cn } from "~/lib/utils";
import { FileDiffHeader } from "./FileDiffHeader";

// Keep diff virtualization tuning in one place so every diff surface scrolls identically.
const DIFF_VIRTUALIZER_CONFIG = {
  overscrollSize: 400,
  intersectionObserverMargin: 600,
};

// Virtualized scroll container for multi-file pull-request diff lists. Callers
// own the inner per-file wrapper markup because
// it differs (collapse click capture, data-diff-file-path scroll anchors, etc.).
export function FileDiffSurface(props: { className?: string; children: ReactNode }) {
  return (
    <Virtualizer
      className={cn("diff-render-surface", props.className)}
      config={DIFF_VIRTUALIZER_CONFIG}
    >
      {props.children}
    </Virtualizer>
  );
}

// A single themed file diff with Penkra's custom file header. Bakes in the shared
// `unsafeCSS` theming so every surface renders with the chat code font and
// themed addition/deletion backgrounds.
export function FileDiffCard(props: {
  fileDiff: FileDiffMetadata;
  theme: "light" | "dark";
  diffStyle?: "unified" | "split";
  overflow?: "scroll" | "wrap";
  collapsed?: boolean;
  /** Trailing header chrome (actions menu, collapse chevron). */
  renderHeaderTrailing?: () => ReactNode;
}) {
  return (
    <FileDiff
      fileDiff={props.fileDiff}
      options={{
        diffStyle: props.diffStyle ?? "unified",
        lineDiffType: "none",
        overflow: props.overflow ?? "scroll",
        theme: resolveDiffThemeName(props.theme),
        themeType: props.theme,
        unsafeCSS: buildFileDiffUnsafeCSS(props.theme),
        ...(props.collapsed !== undefined ? { collapsed: props.collapsed } : {}),
      }}
      renderCustomHeader={(fileDiff) => (
        <FileDiffHeader
          fileDiff={fileDiff}
          theme={props.theme}
          trailing={props.renderHeaderTrailing?.()}
        />
      )}
    />
  );
}
