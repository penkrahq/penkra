import {
  forwardRef,
  type FocusEvent,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  type TextareaHTMLAttributes,
  useState,
} from "react";

import { cn } from "~/lib/utils";
import {
  COMPOSER_EDITOR_MIN_HEIGHT_CLASS_NAME,
  COMPOSER_EDITOR_TYPOGRAPHY_CLASS_NAME,
} from "~/components/chat/composerPickerStyles";

import { ComposerActions } from "../composer-actions/ComposerActions";

export interface ComposerDefaultProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  onSend?: () => void;
  children?: ReactNode;
  layoutMode?: "application" | "preview";
  showHarness?: boolean;
}

export const ComposerDefault = forwardRef<HTMLTextAreaElement, ComposerDefaultProps>(
  function ComposerDefault(
    {
      children,
      className,
      disabled = false,
      layoutMode = "preview",
      onBlur,
      onFocus,
      onKeyDown,
      onSend,
      placeholder = "Do anything",
      showHarness = true,
      ...props
    },
    ref,
  ) {
    const [focused, setFocused] = useState(false);

    if (layoutMode === "application") {
      return (
        <div className={cn("contents", className)} data-pencil-component="TKKOp">
          {children}
        </div>
      );
    }

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
          "flex min-h-[88.5px] w-full flex-col rounded-[18px] border border-[var(--color-border)] bg-[var(--color-background-control-opaque)] p-2.5 transition-colors data-[focused=true]:!border-[var(--color-border-focus)]",
          className,
        )}
        data-focused={focused}
        data-pencil-component="TKKOp"
        onSubmit={submit}
      >
        <textarea
          className={cn(
            "w-full flex-1 resize-none border-0 bg-transparent p-0 text-[var(--color-text-foreground)] outline-none placeholder:text-[var(--color-text-foreground-tertiary)] placeholder:opacity-100 disabled:cursor-not-allowed",
            COMPOSER_EDITOR_MIN_HEIGHT_CLASS_NAME,
            COMPOSER_EDITOR_TYPOGRAPHY_CLASS_NAME,
          )}
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
