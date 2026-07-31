// FILE: disclosureMotion.ts
// Purpose: Shared open/close motion tokens for collapsible UI (sidebar lists, transcript panels, etc.).
// Layer: Web UI motion primitive
// Exports: class-name helpers + Collapsible panel tokens
// Why: Open/close surfaces should use the browser's intrinsic-size interpolation rather than
//      measured heights, grid-row tricks, or content-count timing heuristics.

import { cn } from "~/lib/utils";
import type { CSSProperties } from "react";

// Carbon's productive small-expansion token and standard productive curve. The duration is a
// design-system token; it never varies based on content count or a guessed pixel distance.
export const DISCLOSURE_TRANSITION_MS = 150;

export const DISCLOSURE_INTRINSIC_SIZE_STYLE = {
  interpolateSize: "allow-keywords",
} as CSSProperties;

/** Shell animates its real intrinsic block size. Electron's Chromium runtime supports this. */
export const DISCLOSURE_SHELL_MOTION_CLASS =
  "overflow-clip transition-[height] duration-150 [transition-timing-function:ease] motion-reduce:transition-none";

export const DISCLOSURE_SHELL_OPEN_CLASS = "h-auto";
export const DISCLOSURE_SHELL_CLOSED_CLASS = "h-0";

export const DISCLOSURE_INNER_CLASS = "min-h-0";

// Content does not animate independently; one geometry transition prevents visual lag between
// the revealed rows and the siblings they move.
export const DISCLOSURE_CONTENT_MOTION_CLASS = "";
export const DISCLOSURE_CONTENT_OPEN_CLASS = "";
export const DISCLOSURE_CONTENT_CLOSED_CLASS = "pointer-events-none";

/** Chevron rotation paired with the shell motion. */
export const DISCLOSURE_CHEVRON_MOTION_CLASS =
  "size-3.5 shrink-0 text-muted-foreground transition-transform duration-150 [transition-timing-function:ease] motion-reduce:transition-none";

/** Base-ui Collapsible panel height animation using the same timing curve. */
export const DISCLOSURE_COLLAPSIBLE_PANEL_CLASS =
  "h-(--collapsible-panel-height) overflow-hidden transition-[height] duration-150 [transition-timing-function:ease] motion-reduce:transition-none data-ending-style:h-0 data-starting-style:h-0 data-open:data-ending-style:[height:var(--collapsible-panel-height)]";

/**
 * Inline-axis (width) reveal for side panels that open/close along the
 * horizontal axis. Same timing curve as the vertical disclosures so every
 * toggle in the app stays consistent. Pair `open ? openWidthClassName : "w-0"`.
 */
export const DISCLOSURE_WIDTH_MOTION_CLASS =
  "overflow-hidden transition-[width] duration-150 [transition-timing-function:ease] motion-reduce:transition-none";

export function disclosureWidthClassName(
  open: boolean,
  openWidthClassName: string,
  className?: string,
) {
  return cn(DISCLOSURE_WIDTH_MOTION_CLASS, open ? openWidthClassName : "w-0", className);
}

export function disclosureShellClassName(open: boolean, className?: string) {
  return cn(
    DISCLOSURE_SHELL_MOTION_CLASS,
    open ? DISCLOSURE_SHELL_OPEN_CLASS : DISCLOSURE_SHELL_CLOSED_CLASS,
    className,
  );
}

export function disclosureContentClassName(open: boolean, className?: string) {
  return cn(
    DISCLOSURE_CONTENT_MOTION_CLASS,
    open ? DISCLOSURE_CONTENT_OPEN_CLASS : DISCLOSURE_CONTENT_CLOSED_CLASS,
    className,
  );
}

export function disclosureChevronClassName(open: boolean, className?: string) {
  return cn(DISCLOSURE_CHEVRON_MOTION_CLASS, open && "rotate-90", className);
}
