import {
  forwardRef,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  type TextareaHTMLAttributes,
} from "react";

import { cn } from "~/lib/utils";
import {
  COMPOSER_EDITOR_MIN_HEIGHT_CLASS_NAME,
  COMPOSER_EDITOR_TYPOGRAPHY_CLASS_NAME,
} from "~/components/chat/composerPickerStyles";

import { ComposerActions } from "../composer-actions/ComposerActions";

export interface ComposerDefaultProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  children?: ReactNode;
  draftBar?: ReactNode;
  layoutMode?: "application" | "preview";
  onSend?: () => void;
  showHarness?: boolean;
  surfaceClassName?: string;
}

export const ComposerDefault = forwardRef<HTMLTextAreaElement, ComposerDefaultProps>(
  function ComposerDefault(
    {
      children,
      className,
      disabled = false,
      draftBar,
      layoutMode = "preview",
      onBlur,
      onFocus,
      onKeyDown,
      onSend,
      placeholder = "Do something",
      showHarness = true,
      surfaceClassName,
      ...props
    },
    ref,
  ) {
    if (layoutMode === "application") {
      return (
        <div
          className={cn("relative w-full min-w-0 overflow-visible", className)}
          data-pencil-component="TKKOp"
        >
          {draftBar ? (
            <div
              className="absolute -top-10 left-4 z-0 h-10 w-[calc(100%-2rem)] rounded-t-[18px] rounded-b-none border border-[var(--color-border)] bg-[var(--color-background-control-opaque)]"
              data-pencil-node="fiR2o"
            >
              {draftBar}
            </div>
          ) : null}
          <div
            className={cn(
              "relative z-10 flex min-h-[88.5px] w-full min-w-0 flex-col rounded-[18px] border border-[var(--color-border)] bg-[var(--color-background-control-opaque)] text-left",
              surfaceClassName,
            )}
          >
            {children}
          </div>
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

    return (
      <form
        className={cn(
          "flex min-h-[88.5px] w-full flex-col rounded-[18px] border border-[var(--color-border)] bg-[var(--color-background-control-opaque)] p-2.5 text-left",
          className,
        )}
        data-pencil-component="TKKOp"
        onSubmit={submit}
      >
        <textarea
          className={cn(
            "w-full flex-1 resize-none border-0 bg-transparent p-0 text-left text-[var(--color-text-foreground)] outline-none placeholder:text-left placeholder:text-[var(--color-text-foreground-tertiary)] placeholder:opacity-100 disabled:cursor-not-allowed",
            COMPOSER_EDITOR_MIN_HEIGHT_CLASS_NAME,
            COMPOSER_EDITOR_TYPOGRAPHY_CLASS_NAME,
          )}
          disabled={disabled}
          onBlur={onBlur}
          onFocus={onFocus}
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
