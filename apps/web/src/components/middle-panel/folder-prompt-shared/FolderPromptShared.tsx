import { cn } from "~/lib/utils";

export function FolderPromptShared({
  folderName,
  className,
}: {
  folderName: string;
  className?: string;
}) {
  return (
    <h2
      className={cn(
        "flex h-[43px] min-h-[43px] max-w-full items-start justify-center pb-2 text-center text-[length:var(--app-font-size-display-lg,28px)] font-medium leading-[35px] tracking-normal text-[var(--color-text-foreground)] @max-[407px]:h-auto @max-[407px]:flex-col @max-[407px]:items-center @max-[407px]:gap-0.5 @max-[407px]:text-[length:var(--app-font-size-display-md,26px)] @max-[407px]:leading-[32px] @max-[297px]:text-[length:var(--app-font-size-display-sm,24px)] @max-[297px]:leading-[30px]",
        className,
      )}
      data-pencil-component="dZsWR"
      data-testid="empty-landing-heading"
    >
      <span className="shrink-0 whitespace-nowrap">
        What should we do in<span className="@max-[407px]:hidden">&nbsp;</span>
      </span>
      <span className="inline-flex min-w-0 items-start">
        <span className="min-w-0 truncate whitespace-nowrap border-b border-current leading-[35px] @max-[407px]:max-w-full @max-[407px]:leading-[32px] @max-[297px]:leading-[30px]">
          {folderName}
        </span>
        <span>?</span>
      </span>
    </h2>
  );
}
