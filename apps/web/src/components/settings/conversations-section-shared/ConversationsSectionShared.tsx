import { SwitchShared } from "~/components/foundations/switch-shared/SwitchShared";
import { SettingRowShared } from "~/components/settings/setting-row-shared/SettingRowShared";
import { SettingsSectionShared } from "~/components/settings/settings-section-shared/SettingsSectionShared";

export type ConversationSteerSource = "composer" | "threads";

export interface ConversationsSectionSharedProps {
  steerComposer: boolean;
  steerThreads: boolean;
  disabled?: boolean;
  onSteerChange: (source: ConversationSteerSource, enabled: boolean) => void;
}

const SHORTCUT_CLASS =
  "rounded-[4px] border border-[var(--color-border)] px-1 font-mono text-[length:var(--app-font-size-ui-sm,11px)] text-[var(--color-text-foreground-secondary)]";

export function ConversationsSectionShared({
  steerComposer,
  steerThreads,
  disabled,
  onSteerChange,
}: ConversationsSectionSharedProps) {
  return (
    <SettingsSectionShared title="Conversations">
      <SettingRowShared
        control={
          <SwitchShared
            aria-label="Steer your messages into a running turn"
            checked={steerComposer}
            disabled={disabled}
            onCheckedChange={(checked) => onSteerChange("composer", checked)}
          />
        }
        description={
          <>
            New messages join the agent&apos;s current turn instead of waiting for it to finish.{" "}
            {steerComposer ? (
              <>
                Press <kbd className={SHORTCUT_CLASS}>⌘↩</kbd> to queue one instead.
              </>
            ) : (
              <>
                Press <kbd className={SHORTCUT_CLASS}>⌘↩</kbd> to steer one anyway.
              </>
            )}
          </>
        }
        label="Steer my messages"
      />
      <SettingRowShared
        control={
          <SwitchShared
            aria-label="Steer messages from other threads into a running turn"
            checked={steerThreads}
            disabled={disabled}
            onCheckedChange={(checked) => onSteerChange("threads", checked)}
          />
        }
        description="Messages that other threads send here join the current turn instead of waiting in the queue."
        label="Steer messages from other threads"
      />
    </SettingsSectionShared>
  );
}
