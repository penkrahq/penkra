import { listTrustedConnectors } from "~/connectors/trustedConnectorCatalog";

export function SettingsConnectorsPage() {
  const connectors = listTrustedConnectors();
  if (connectors.length === 0) {
    return (
      <p
        className="text-xs leading-relaxed text-[var(--color-text-foreground-secondary)]"
        data-pencil-page="connectors"
      >
        No supported connectors are available in this build.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-2.5" data-pencil-page="connectors">
      {connectors.map((connector) => (
        <p key={connector.id}>{connector.name}</p>
      ))}
    </div>
  );
}
