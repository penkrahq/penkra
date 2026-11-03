// FILE: ContextWindowSlider.tsx
// Purpose: Stepped control for how much context a thread carries, inside the model picker menu.

import { Slider } from "@base-ui/react/slider";
import { useState } from "react";

import { cn } from "~/lib/utils";

export function ContextWindowSlider(props: {
  label: string;
  options: ReadonlyArray<{ readonly value: string; readonly label: string }>;
  value: string;
  onCommit: (value: string) => void;
}) {
  const committedIndex = Math.max(
    props.options.findIndex((option) => option.value === props.value),
    0,
  );
  // Only the drag in progress lives here; once released the selection owns the position.
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const index = dragIndex ?? committedIndex;
  const last = props.options.length - 1;

  return (
    <div
      className="px-2 pb-2 pt-1"
      // The menu's typeahead and arrow navigation must not take the slider's keys.
      onKeyDown={(event) => {
        if (
          [
            "ArrowLeft",
            "ArrowRight",
            "ArrowUp",
            "ArrowDown",
            "Home",
            "End",
            "PageUp",
            "PageDown",
          ].includes(event.key)
        ) {
          event.stopPropagation();
        }
      }}
    >
      <div className="flex items-baseline justify-between text-[length:var(--app-font-size-ui-sm,11px)]">
        <span className="text-muted-foreground/60">{props.label}</span>
        <span className="font-semibold tabular-nums text-foreground">
          {props.options[index]?.label}
        </span>
      </div>
      <Slider.Root
        className="mt-1.5"
        min={0}
        max={last}
        step={1}
        value={index}
        onValueChange={(next) => setDragIndex(next as number)}
        onValueCommitted={(next) => {
          setDragIndex(null);
          const option = props.options[next as number];
          if (option && option.value !== props.value) props.onCommit(option.value);
        }}
      >
        <Slider.Control className="flex h-4 w-full touch-none items-center">
          <Slider.Track className="relative h-1 w-full rounded-full bg-muted-foreground/15">
            <Slider.Indicator className="rounded-full bg-foreground/70" />
            {props.options.map((option, stop) => (
              <span
                aria-hidden="true"
                className={cn(
                  "absolute top-1/2 size-1 -translate-x-1/2 -translate-y-1/2 rounded-full",
                  stop <= index ? "bg-background/70" : "bg-muted-foreground/40",
                )}
                key={option.value}
                style={{ left: `${(stop / last) * 100}%` }}
              />
            ))}
            <Slider.Thumb
              aria-label={props.label}
              getAriaValueText={() => props.options[index]?.label ?? ""}
              className="size-3 rounded-full bg-foreground shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </Slider.Track>
        </Slider.Control>
      </Slider.Root>
      <div className="mt-0.5 flex justify-between text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground/60">
        <span>{props.options[0]?.label}</span>
        <span>{props.options[last]?.label}</span>
      </div>
      <p className="mt-1.5 text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground/70">
        Compacts at this size, from your next message.
      </p>
    </div>
  );
}
