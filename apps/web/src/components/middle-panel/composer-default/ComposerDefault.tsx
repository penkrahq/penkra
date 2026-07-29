import {
  forwardRef,
  type FocusEvent,
  type FormEvent,
  type KeyboardEvent,
  type TextareaHTMLAttributes,
  useState,
} from "react";

import { cn } from "~/lib/utils";

import { ComposerActions } from "../composer-actions/ComposerActions";

export interface ComposerDefaultProps
  extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  onSend?: () => void;
  showHarness?: boolean;
}

export const ComposerDefault = forwardRef<HTMLTextAreaElement, ComposerDefaultProps>(
  function ComposerDefault(
    {
      className,
      disabled,
      onBlur,
      onFocus,
      onKeyDown,
      onSend,
      placeholder = "Do anything",
      showHarness = false,
      ...props
    },
    ref,
  ) {
    const [focused, setFocused] = useState(false);

    const submit = (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!disabled) onSend?.();
    };

    const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
      onKeyDown?.(event);
      if (!event.defaultPrevented && event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        if (!disabled) onSend?.();
      }
    };

    const handleFocus = (event: FocusEvent<HTMLTextAreaElement>) => {
      setFocused(true);
      onFocus?.(event);
    };

    const handleBlur = (event: FocusEvent<HTMLTextAreaElement>) => {
      setFocused(false);
      onBlur?.(event);
    };

    return (
      <form
        className={cn(
          "flex min-h-[88px] w-full flex-col rounded-[18px] border border-[var(--color-border)] bg-[var(--color-background-control-opaque)] p-[11px] text-[var(--color-text-foreground-tertiary)] transition-colors data-[focused=true]:!border-[var(--color-border-focus)] data-[focused=true]:text-[var(--color-text-foreground)]",
          className,
        )}
        data-focused={focused}
        data-pencil-component="TKKOp"
        onSubmit={submit}
      >
        <textarea
          className="min-h-9 w-full flex-1 resize-none border-0 bg-transparent p-0 font-sans text-sm text-[var(--color-text-foreground)] outline-none placeholder:text-current placeholder:opacity-100 disabled:cursor-not-allowed"
          disabled={disabled}
          onBlur={handleBlur}
          onFocus={handleFocus}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          ref={ref}
          rows={1}
          {...props}
        />
        <ComposerActions disabled={disabled} showHarness={showHarness} />
      </form>
    );
  },
);
