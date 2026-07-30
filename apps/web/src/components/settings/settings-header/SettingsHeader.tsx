export interface SettingsHeaderProps {
  subtitle?: string;
  title?: string;
}

export function SettingsHeader({
  subtitle = "Manage your preferences",
  title = "General",
}: SettingsHeaderProps) {
  return (
    <header className="w-full min-w-0 font-sans" data-pencil-component="w2pbCe">
      <h1 className="text-xl font-semibold text-[var(--color-text-foreground)]">{title}</h1>
      <p className="mt-1 text-[13px] text-[var(--color-text-foreground-secondary)]">{subtitle}</p>
    </header>
  );
}
