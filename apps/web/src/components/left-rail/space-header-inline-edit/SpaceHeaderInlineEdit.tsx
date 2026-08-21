import { cn } from "~/lib/utils";
import { useInlineNameEditor } from "../useInlineNameEditor";

export interface SpaceHeaderInlineEditProps {
  accessibleHeading?: string;
  className?: string;
  defaultValue?: string;
  existingNames?: ReadonlyArray<string>;
  inputLabel?: string;
  mode: "create" | "rename";
  onCancel: () => void;
  onSubmit: (name: string) => Promise<void> | void;
}

export function SpaceHeaderInlineEdit({
  accessibleHeading,
  className,
  defaultValue = "",
  existingNames = [],
  inputLabel,
  mode,
  onCancel,
  onSubmit,
}: SpaceHeaderInlineEditProps) {
  const editor = useInlineNameEditor({ defaultValue, existingNames, onCancel, onSubmit });

  return (
    <div
      ref={editor.rootRef}
      className={cn("flex w-full flex-col gap-1", className)}
      data-pencil-component="c9CIe"
      data-space-inline-editor={mode}
    >
      {accessibleHeading ? <h3 className="sr-only">{accessibleHeading}</h3> : null}
      <div className="flex items-center gap-2">
        <div
          className={cn(
            "flex h-[27px] min-w-0 flex-1 items-center rounded-md border bg-foreground/4 px-2.5",
            editor.visibleError ? "border-destructive" : "border-[var(--color-border-focus)]",
          )}
        >
          <input
            ref={editor.inputRef}
            aria-describedby={editor.visibleError ? editor.errorId : undefined}
            aria-invalid={Boolean(editor.visibleError)}
            aria-label={inputLabel ?? (mode === "create" ? "New Space name" : "Rename Space")}
            className="min-w-0 flex-1 border-0 bg-transparent p-0 text-[length:var(--app-font-size-ui,12px)] font-semibold text-foreground outline-none"
            disabled={editor.submitting}
            maxLength={80}
            onBlur={editor.onBlur}
            onChange={(event) => {
              editor.onChange(event.target.value);
            }}
            onKeyDown={editor.onKeyDown}
            placeholder={mode === "create" ? "New Space" : undefined}
            value={editor.value}
          />
          <span
            aria-hidden="true"
            className="ml-2 text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground"
          >
            ↵
          </span>
        </div>
      </div>
      {editor.visibleError ? (
        <p
          className="px-2.5 text-[length:var(--app-font-size-ui-xs,10px)] leading-4 text-destructive"
          id={editor.errorId}
          role="alert"
        >
          {editor.visibleError}
        </p>
      ) : null}
    </div>
  );
}
