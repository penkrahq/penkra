# Runtime and permissions

Each enabled App has isolated storage and an Electron session per Space. Each visual App tab has a
separate renderer and stable host-minted `tabId`. Tabs in one App/Space may share explicit durable
storage, but Penkra never broadcasts operation requests for tabs to filter.

The runtime exposes identity, settings, encrypted secrets, scoped file handles, permissions,
mediated HTTP/socket/process services, hosted browser sessions, operations, and point-to-point tab
routing. Apps receive a pairwise Account subject and opaque per-App Space identifier, not the
Space's display name.

Special permissions are `network-fetch`, `raw-socket`, `process-spawn`, and `browser-session`.
Required permissions must be granted before enablement; optional permissions are requested only in
response to a user action. Revocation applies to one App in one Space. Standard browser permissions
such as microphone and camera use host-intercepted browser permission flows.

File access is always handle-based. A handle authorizes only the selected file or directory and
validated descendants. A Browser session can control only pages created for the calling App and
Space; it cannot expose Electron, another App's pages, or raw host objects.
