import type { ReactNode } from "react";

import { cn } from "~/lib/utils";

import { LeftRailRowFrame } from "./row-shared/LeftRailRow";
import { useInlineNameEditor } from "./useInlineNameEditor";

export function InlineRowNameEditor(props: {
  ariaLabel: string;
  className?: string;
  defaultValue: string;
  emptyError?: string;
  existingNames?: ReadonlyArray<string>;
  leading: ReactNode;
  onCancel: () => void;
  onSubmit: (name: string) => Promise<void> | void;
  onValueChange?: (value: string) => void;
  pencilComponentId: string;
  value?: string;
}) {
  const editor = useInlineNameEditor(props);

  return (
    <div ref={editor.rootRef} className="min-w-0" data-inline-name-editor>
      <LeftRailRowFrame
        className={cn("cursor-text gap-3 pr-2.5", props.className)}
        data-pencil-component={props.pencilComponentId}
        leading={props.leading}
        leadingClassName="size-3.5"
        labelClassName="flex items-center"
        onPointerDown={(event) => event.stopPropagation()}
        state={editor.visibleError ? "error" : "focus"}
        title={editor.visibleError ?? undefined}
      >
        <input
          ref={editor.inputRef}
          aria-describedby={editor.visibleError ? editor.errorId : undefined}
          aria-invalid={Boolean(editor.visibleError)}
          aria-label={props.ariaLabel}
          className="w-full min-w-0 border-0 bg-transparent p-0 font-medium text-[var(--color-text-foreground)] outline-none disabled:opacity-60"
          disabled={editor.submitting}
          maxLength={80}
          onBlur={editor.onBlur}
          onChange={(event) => editor.onChange(event.target.value)}
          onKeyDown={editor.onKeyDown}
          value={editor.value}
        />
        <span
          aria-hidden="true"
          className="ml-2 text-[length:var(--app-font-size-ui-xs,10px)] text-[var(--color-text-foreground-tertiary)]"
        >
          ↵
        </span>
      </LeftRailRowFrame>
      {editor.visibleError ? (
        <span className="sr-only" id={editor.errorId} role="alert">
          {editor.visibleError}
        </span>
      ) : null}
    </div>
  );
}
