import { AccountRowShared, type AccountUpdatePhase } from "../account-row-shared/AccountRowShared";

export interface AccountControlSharedProps {
  accountName?: string;
  onSettings?: () => void;
  onSupport?: () => void;
  onUpdate?: () => void;
  updateAvailable?: boolean;
  updateDisabled?: boolean;
  updateLabel?: string;
  updatePhase?: AccountUpdatePhase;
}

export function AccountControlShared({
  accountName = "gigsama",
  onSettings,
  onSupport,
  onUpdate,
  updateAvailable,
  updateDisabled,
  updateLabel,
  updatePhase,
}: AccountControlSharedProps) {
  return (
    <div data-pencil-component="ptpcV">
      <AccountRowShared
        name={accountName}
        {...(onSettings === undefined ? {} : { onAccount: onSettings })}
        {...(onSupport === undefined ? {} : { onHelp: onSupport })}
        {...(onUpdate === undefined ? {} : { onUpdate })}
        {...(updateAvailable === undefined ? {} : { updateAvailable })}
        {...(updateDisabled === undefined ? {} : { updateDisabled })}
        {...(updateLabel === undefined ? {} : { updateLabel })}
        {...(updatePhase === undefined ? {} : { updatePhase })}
      />
    </div>
  );
}
