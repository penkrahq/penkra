import { useEffect, useId, useRef, useState } from "react";

import { cn } from "~/lib/utils";

export interface SpaceHeaderInlineEditProps {
  accessibleHeading?: string;
  className?: string;
  defaultValue?: string;
  existingNames?: ReadonlyArray<string>;
  inputLabel?: string;
  mode: "create" | "rename";
  onCancel: () => void;
  onSubmit: (name: string) => Promise<void> | void;
  submitLabel?: string;
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
  submitLabel,
}: SpaceHeaderInlineEditProps) {
  const [value, setValue] = useState(defaultValue);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const errorId = useId();

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const trimmedValue = value.trim();
  const duplicate = existingNames.some(
    (name) => name.trim().toLocaleLowerCase() === trimmedValue.toLocaleLowerCase(),
  );
  const validationError =
    trimmedValue.length === 0 ? "Enter a name." : duplicate ? "That name is already taken." : null;
  const visibleError = submitError ?? (value.length > 0 ? validationError : null);

  const submit = async () => {
    if (validationError || submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      await onSubmit(trimmedValue);
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : "Unable to save the Space.");
      setSubmitting(false);
    }
  };

  return (
    <div
      className={cn("flex w-full flex-col gap-1", className)}
      data-pencil-component="c9CIe"
      data-space-inline-editor={mode}
    >
      {accessibleHeading ? <h3 className="sr-only">{accessibleHeading}</h3> : null}
      <div className="flex items-center gap-2">
        <div
          className={cn(
            "flex h-[27px] min-w-0 flex-1 items-center rounded-md border bg-foreground/4 px-2.5",
            visibleError ? "border-destructive" : "border-[var(--color-border-focus)]",
          )}
        >
          <input
            ref={inputRef}
            aria-describedby={visibleError ? errorId : undefined}
            aria-invalid={Boolean(visibleError)}
            aria-label={inputLabel ?? (mode === "create" ? "New Space name" : "Rename Space")}
            className="min-w-0 flex-1 border-0 bg-transparent p-0 text-[length:var(--app-font-size-ui,12px)] font-semibold text-foreground outline-none"
            disabled={submitting}
            maxLength={80}
            onChange={(event) => {
              setValue(event.target.value);
              setSubmitError(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                onCancel();
                return;
              }
              if (event.key === "Enter") {
                event.preventDefault();
                void submit();
              }
            }}
            placeholder={mode === "create" ? "New Space" : undefined}
            value={value}
          />
          <span
            aria-hidden="true"
            className="ml-2 text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground"
          >
            ↵
          </span>
        </div>
        {submitLabel ? (
          <button
            type="button"
            className="h-[27px] shrink-0 rounded-md bg-foreground px-2.5 text-[length:var(--app-font-size-ui-xs,10px)] font-medium text-background disabled:opacity-50"
            disabled={Boolean(validationError) || submitting}
            onClick={() => void submit()}
          >
            {submitting ? "Creating…" : submitLabel}
          </button>
        ) : null}
      </div>
      {visibleError ? (
        <p
          className="px-2.5 text-[length:var(--app-font-size-ui-xs,10px)] leading-4 text-destructive"
          id={errorId}
          role="alert"
        >
          {visibleError}
        </p>
      ) : null}
    </div>
  );
}
