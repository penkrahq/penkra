// FILE: SettingsIphonePage.tsx
// Purpose: Settings → Phone. Turn phone access on, see paired iPhones, remove one (TODO §7.2.10).
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

/**
 * This Mac's connection to the relay (TODO §7.5.10). `rejected-*` are the relay's refusals that
 * retrying cannot fix, so Penkra stops and says what to do instead.
 */
export type RelayStatus =
  | { readonly kind: "connected" }
  | { readonly kind: "connecting" }
  | { readonly kind: "rejected-sign-in" }
  | { readonly kind: "rejected-protocol" };

export function SettingsIphonePage(props: {
  /** Penkra account sign-in on this Mac; phone access needs it. */
  readonly signedIn: boolean;
  readonly accessOn: boolean;
  readonly busy?: boolean;
  /** Turning access on registers this Mac; off stops RemoteLink (paired iPhones stay paired). */
  readonly onAccessChange: (on: boolean) => void;
  readonly phones: ReadonlyArray<PairedIphone> | null;
  readonly deviceError?: string | undefined;
  /** Removes the iPhone's trust and session on this Mac; the caller confirms first. */
  readonly onRemove: (deviceId: string) => void;
  /** Shown under the switch while access is on. */
  readonly relay: RelayStatus;
  /** "Sign in again" for `rejected-sign-in` (opens the existing account sign-in). */
  readonly onSignInAgain: () => void;
  /** "Check for updates" for a protocol rejection (the existing desktop updater). */
  readonly onCheckForUpdates: () => void;
}) {
  const on = props.signedIn && props.accessOn;
  return (
    <div className="flex flex-col gap-6" data-pencil-page="iphone">
      <SettingsSectionShared title="Phone access">
        <SettingRowShared
          label="Allow access from your phone"
          description={
            props.signedIn
              ? "Use this Mac's threads from Penkra on your phone, at home or away. Everything between them is end-to-end encrypted."
              : "Sign in to your Penkra account in Settings → Account to use Penkra on your phone."
          }
          status={
            on ? (
              <RelayStatusLine
                relay={props.relay}
                onSignInAgain={props.onSignInAgain}
                onCheckForUpdates={props.onCheckForUpdates}
              />
            ) : undefined
          }
          control={
            <SwitchShared
              aria-label="Allow access from your phone"
              checked={props.signedIn && props.accessOn}
              disabled={!props.signedIn || props.busy}
              onCheckedChange={(checked) => props.onAccessChange(checked)}
            />
          }
        />
      </SettingsSectionShared>

      {props.signedIn && props.accessOn ? (
        <SettingsSectionShared title="Phones">
          {props.phones === null ? (
            <SettingRowShared label={props.deviceError ?? "Loading phones…"} />
          ) : props.phones.length === 0 ? (
            <SettingRowShared
              label="No phones yet"
              description="Open Penkra on your phone, sign in with the same account and choose this Mac. You'll approve it here."
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

function RelayStatusLine(props: {
  relay: RelayStatus;
  onSignInAgain: () => void;
  onCheckForUpdates: () => void;
}) {
  const dot = (color: string) => (
    <span aria-hidden="true" className={`inline-block size-1.5 rounded-full ${color}`} />
  );
  switch (props.relay.kind) {
    case "connected":
      return (
        <span className="inline-flex items-center gap-1.5">
          {dot("bg-emerald-500")}Ready for your phone
        </span>
      );
    case "connecting":
      return (
        <span className="inline-flex items-center gap-1.5">
          {dot("bg-muted-foreground/50")}Connecting…
        </span>
      );
    case "rejected-sign-in":
      return (
        <span className="inline-flex flex-wrap items-center gap-1.5">
          {dot("bg-amber-500")}Your Penkra sign-in on this Mac needs renewing.
          <button
            type="button"
            className="text-[var(--color-text-foreground)] underline-offset-2 hover:underline"
            onClick={props.onSignInAgain}
          >
            Sign in again
          </button>
        </span>
      );
    case "rejected-protocol":
      return (
        <span className="inline-flex flex-wrap items-center gap-1.5">
          {dot("bg-amber-500")}Penkra couldn't connect to your phone.
          <button
            type="button"
            className="text-[var(--color-text-foreground)] underline-offset-2 hover:underline"
            onClick={props.onCheckForUpdates}
          >
            Check for updates
          </button>
        </span>
      );
  }
}
