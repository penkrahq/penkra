import type { DesktopAppDiagnosticEntry, DesktopInstalledApp } from "@penkra/contracts";
import { IconActivityHeartbeat } from "@tabler/icons-react";
import { useEffect, useState } from "react";

export function AppDiagnosticsView({
  apps,
  spaceId,
}: {
  apps: ReadonlyArray<DesktopInstalledApp>;
  spaceId: string | null;
}) {
  const [entries, setEntries] = useState<ReadonlyArray<DesktopAppDiagnosticEntry>>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const bridge = window.desktopBridge?.appDiagnostics;
    if (!bridge || !spaceId) {
      setEntries([]);
      return () => {
        active = false;
      };
    }
    void bridge
      .list({ spaceId, limit: 25 })
      .then((next) => {
        if (active) setEntries(next);
      })
      .catch((cause: unknown) => {
        if (active)
          setError(cause instanceof Error ? cause.message : "App diagnostics could not be read.");
      });
    return () => {
      active = false;
    };
  }, [spaceId]);

  const names = new Map(apps.map((app) => [app.id, app.name]));
  return (
    <section
      className="mt-4 overflow-hidden rounded-[10px] border border-[var(--color-border)] bg-[var(--color-background-surface)]"
      data-testid="app-diagnostics"
    >
      <header className="flex items-center gap-2 border-b border-[var(--color-border)] px-4 py-3">
        <IconActivityHeartbeat className="size-4 text-[var(--color-text-foreground-secondary)]" />
        <span className="text-[13px] font-medium text-[var(--color-text-foreground)]">
          Runtime diagnostics
        </span>
      </header>
      {error ? (
        <p className="px-4 py-3 text-xs text-[var(--color-text-danger)]">{error}</p>
      ) : entries.length === 0 ? (
        <p className="px-4 py-3 text-xs text-[var(--color-text-foreground-tertiary)]">
          No App runtime events for this Space.
        </p>
      ) : (
        <ul className="divide-y divide-[var(--color-border)]">
          {entries.map((entry) => (
            <li className="flex items-start justify-between gap-4 px-4 py-2.5" key={entry.id}>
              <span className="min-w-0">
                <span className="block truncate text-xs text-[var(--color-text-foreground)]">
                  {names.get(entry.appId) ?? entry.appId} · {diagnosticLabel(entry.kind)}
                </span>
                {(entry.message || entry.operation) && (
                  <span className="block truncate text-[11px] text-[var(--color-text-foreground-tertiary)]">
                    {entry.operation ?? entry.message}
                  </span>
                )}
              </span>
              <span className="shrink-0 text-[11px] text-[var(--color-text-foreground-tertiary)]">
                {metric(entry)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function diagnosticLabel(kind: DesktopAppDiagnosticEntry["kind"]): string {
  return kind
    .split("-")
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
}

function metric(entry: DesktopAppDiagnosticEntry): string {
  if (entry.durationMs !== undefined) return `${entry.durationMs} ms`;
  if (entry.memoryBytes !== undefined) return `${Math.round(entry.memoryBytes / 1024 / 1024)} MB`;
  return new Date(entry.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
