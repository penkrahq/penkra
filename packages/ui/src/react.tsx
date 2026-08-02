import type { FormEvent, ReactNode } from "react";

export interface AppBarAction {
  key: string;
  label: string;
  icon: ReactNode;
  onActivate: () => void;
  disabled?: boolean;
  pressed?: boolean;
}

export type AppBarCenter =
  | { kind: "display"; text?: string; icon?: ReactNode }
  | {
      kind: "input";
      value: string;
      placeholder?: string;
      icon?: ReactNode;
      label: string;
      onValueChange: (value: string) => void;
      onSubmit?: (value: string) => void;
    }
  | { kind: "custom"; content: ReactNode };

export interface AppBarProps {
  label?: string;
  leading?: readonly AppBarAction[];
  center?: AppBarCenter;
  trailing?: readonly AppBarAction[];
}

export function AppBar({ label = "App navigation", leading = [], center, trailing = [] }: AppBarProps) {
  return (
    <header aria-label={label} className="penkra-app-bar">
      <ActionGroup actions={leading} slot="leading" />
      <Center center={center} />
      <ActionGroup actions={trailing} slot="trailing" />
    </header>
  );
}

function ActionGroup({ actions, slot }: { actions: readonly AppBarAction[]; slot: "leading" | "trailing" }) {
  return (
    <div className={`penkra-app-bar__${slot}`}>
      {actions.map((action) => (
        <button
          aria-label={action.label}
          aria-pressed={action.pressed}
          className="penkra-app-bar__action"
          data-action={action.key}
          disabled={action.disabled}
          key={action.key}
          onClick={action.onActivate}
          type="button"
        >
          {action.icon}
        </button>
      ))}
    </div>
  );
}

function Center({ center }: { center?: AppBarCenter }) {
  if (!center) return <div className="penkra-app-bar__center" />;
  if (center.kind === "custom") return <div className="penkra-app-bar__center">{center.content}</div>;
  if (center.kind === "display") {
    return <div className="penkra-app-bar__center penkra-app-bar__display">{center.icon}{center.text}</div>;
  }
  const submit = (event: FormEvent) => {
    event.preventDefault();
    center.onSubmit?.(center.value);
  };
  return (
    <div className="penkra-app-bar__center">
      <form className="penkra-app-bar__input" onSubmit={submit}>
        {center.icon}
        <input
          aria-label={center.label}
          onChange={(event) => center.onValueChange(event.currentTarget.value)}
          placeholder={center.placeholder}
          value={center.value}
        />
      </form>
    </div>
  );
}

export function PenkraIcon({ name, label }: { name: "back" | "close" | "forward" | "more" | "search"; label?: string }) {
  const paths = {
    back: "M15 18l-6-6 6-6",
    close: "M6 6l12 12M18 6 6 18",
    forward: "m9 18 6-6-6-6",
    more: "M5 12h.01M12 12h.01M19 12h.01",
    search: "m21 21-4.35-4.35M19 11a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z",
  } as const;
  return (
    <svg aria-hidden={label ? undefined : true} aria-label={label} fill="none" role={label ? "img" : undefined} stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" viewBox="0 0 24 24">
      <path d={paths[name]} />
    </svg>
  );
}
