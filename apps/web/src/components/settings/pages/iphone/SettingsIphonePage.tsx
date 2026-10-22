// FILE: SettingsIphonePage.tsx
// Purpose: Settings → iPhone. Turn phone access on, see paired iPhones, remove one (TODO §7.2.10).
// Layer: Settings presentation (planner-owned design; callers supply data and callbacks).

import { SwitchShared } from "~/components/foundations/switch-shared/SwitchShared";
import { SettingRowShared } from "~/components/settings/setting-row-shared/SettingRowShared";
import { SettingsSectionShared } from "~/components/settings/settings-section-shared/SettingsSectionShared";
import { formatRelativeTime } from "~/lib/relativeTime";

import { SettingsTextAction } from "../shared/SettingsPageControls";

export interface PairedIphone {
  readonly deviceId: string;
  readonly name: string;
  /** A Noise session from this iPhone is open now. */
  readonly connected: boolean;
  readonly lastConnectedAt: string | null;
}

export function SettingsIphonePage(props: {
  /** Penkra account sign-in on this Mac; phone access needs it. */
  readonly signedIn: boolean;
  readonly accessOn: boolean;
  /** Turning access on registers this Mac; off stops RemoteLink (paired iPhones stay paired). */
  readonly onAccessChange: (on: boolean) => void;
  readonly phones: ReadonlyArray<PairedIphone>;
  /** Removes the iPhone's trust and session on this Mac; the caller confirms first. */
  readonly onRemove: (deviceId: string) => void;
}) {
  return (
    <div className="flex flex-col gap-6" data-pencil-page="iphone">
      <SettingsSectionShared title="Phone access">
        <SettingRowShared
          label="Allow access from iPhone"
          description={
            props.signedIn
              ? "Use this Mac's threads from Penkra on your iPhone, at home or away. Everything between them is end-to-end encrypted."
              : "Sign in to your Penkra account in Settings → Account to use Penkra on iPhone."
          }
          control={
            <SwitchShared
              aria-label="Allow access from iPhone"
              checked={props.signedIn && props.accessOn}
              disabled={!props.signedIn}
              onCheckedChange={(checked) => props.onAccessChange(checked)}
            />
          }
        />
      </SettingsSectionShared>

      {props.signedIn && props.accessOn ? (
        <SettingsSectionShared title="iPhones">
          {props.phones.length === 0 ? (
            <SettingRowShared
              label="No iPhones yet"
              description="Open Penkra on your iPhone, sign in with the same account and choose this Mac. You'll approve it here."
            />
          ) : (
            props.phones.map((phone) => (
              <SettingRowShared
                key={phone.deviceId}
                label={phone.name}
                description={
                  phone.connected
                    ? "Connected now"
                    : phone.lastConnectedAt
                      ? lastConnectedLabel(phone.lastConnectedAt)
                      : "Not connected yet"
                }
                control={
                  <SettingsTextAction
                    tone="destructive"
                    onClick={() => props.onRemove(phone.deviceId)}
                  >
                    Remove
                  </SettingsTextAction>
                }
              />
            ))
          )}
        </SettingsSectionShared>
      ) : null}
    </div>
  );
}

function lastConnectedLabel(iso: string): string {
  const age = formatRelativeTime(iso);
  return age === "now" ? "Last connected just now" : `Last connected ${age} ago`;
}
