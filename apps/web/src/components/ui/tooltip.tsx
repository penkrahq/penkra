import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import type { ReactNode } from "react";

import { cn } from "~/lib/utils";

const TooltipCreateHandle = TooltipPrimitive.createHandle;

const TooltipProvider = TooltipPrimitive.Provider;

const Tooltip = TooltipPrimitive.Root;

function TooltipTrigger(props: TooltipPrimitive.Trigger.Props) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />;
}

function TooltipShortcut({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-[999px] bg-[var(--color-background-button-secondary-hover)] px-1 py-0.5 font-sans text-[length:var(--app-font-size-ui-sm,11px)] leading-[13px] font-normal text-[var(--color-text-foreground-tertiary)]",
        className,
      )}
      data-pencil-node="qrW5C"
    >
      {children}
    </kbd>
  );
}

function TooltipPopup({
  className,
  positionerClassName,
  viewportClassName,
  align: alignProp,
  sideOffset: sideOffsetProp,
  side: sideProp,
  anchor,
  children,
  ...props
}: TooltipPrimitive.Popup.Props & {
  align?: TooltipPrimitive.Positioner.Props["align"];
  side?: TooltipPrimitive.Positioner.Props["side"];
  sideOffset?: TooltipPrimitive.Positioner.Props["sideOffset"];
  anchor?: TooltipPrimitive.Positioner.Props["anchor"];
  // Stacking lives on the positioner (the portaled, positioned element), so a
  // z-index override has to land here rather than on the popup className.
  positionerClassName?: string;
  // The viewport owns the Pencil 10px/6px inset for plain text tooltips; rich
  // cards that bring their own padding can zero it here so they don't double up.
  viewportClassName?: string;
}) {
  const align = alignProp ?? "center";
  // Pencil Q5AL4 places the 4px arrow 3px clear of the trigger, so the popup
  // body itself sits 7px away from the anchor.
  const sideOffset = sideOffsetProp ?? 7;
  const side = sideProp ?? "top";
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Positioner
        align={align}
        anchor={anchor}
        className={cn(
          "z-50 h-(--positioner-height) w-(--positioner-width) max-w-(--available-width) transition-[top,left,right,bottom,transform] data-instant:transition-none",
          positionerClassName,
        )}
        data-slot="tooltip-positioner"
        side={side}
        sideOffset={sideOffset}
      >
        <TooltipPrimitive.Popup
          className={cn(
            "flex h-(--popup-height,auto) w-(--popup-width,auto) origin-(--transform-origin) overflow-visible rounded-lg bg-black font-sans text-[length:var(--app-font-size-ui,12px)] leading-4 font-normal text-white shadow-none ring-1 ring-black ring-inset transition-[width,height,scale,opacity] data-ending-style:scale-98 data-starting-style:scale-98 data-ending-style:opacity-0 data-starting-style:opacity-0 data-instant:duration-0",
            className,
          )}
          data-pencil-component="Q5AL4"
          data-slot="tooltip-popup"
          {...props}
        >
          <TooltipPrimitive.Arrow
            className="bg-black data-[side=bottom]:-top-1 data-[side=bottom]:h-1 data-[side=bottom]:w-2 data-[side=bottom]:[clip-path:polygon(50%_0,100%_100%,0_100%)] data-[side=left]:-right-1 data-[side=left]:h-2 data-[side=left]:w-1 data-[side=left]:[clip-path:polygon(0_0,100%_50%,0_100%)] data-[side=right]:-left-1 data-[side=right]:h-2 data-[side=right]:w-1 data-[side=right]:[clip-path:polygon(100%_0,0_50%,100%_100%)] data-[side=top]:-bottom-1 data-[side=top]:h-1 data-[side=top]:w-2 data-[side=top]:[clip-path:polygon(0_0,100%_0,50%_100%)]"
            data-slot="tooltip-arrow"
          />
          <TooltipPrimitive.Viewport
            className={cn(
              "relative flex size-full items-center gap-2 overflow-clip px-(--viewport-inline-padding) py-1.5 [--viewport-inline-padding:--spacing(2.5)] data-instant:transition-none **:data-current:data-ending-style:opacity-0 **:data-current:data-starting-style:opacity-0 **:data-previous:data-ending-style:opacity-0 **:data-previous:data-starting-style:opacity-0 **:data-current:w-[calc(var(--popup-width)-2*var(--viewport-inline-padding)-2px)] **:data-previous:w-[calc(var(--popup-width)-2*var(--viewport-inline-padding)-2px)] **:data-previous:truncate **:data-current:opacity-100 **:data-previous:opacity-100 **:data-current:transition-opacity **:data-previous:transition-opacity",
              viewportClassName,
            )}
            data-slot="tooltip-viewport"
          >
            {children}
          </TooltipPrimitive.Viewport>
        </TooltipPrimitive.Popup>
      </TooltipPrimitive.Positioner>
    </TooltipPrimitive.Portal>
  );
}

export {
  TooltipCreateHandle,
  TooltipProvider,
  Tooltip,
  TooltipTrigger,
  TooltipPopup,
  TooltipShortcut,
};
