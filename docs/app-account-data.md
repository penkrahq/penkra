# App Account data capability

`account-data` is the public capability for an installed App whose data follows a signed-in Penkra
Account across devices. It is intentionally narrower than arbitrary authenticated fetch or a
generic `backend.*` escape hatch.

## Trust boundary

- The renderer supplies only a relative path or subscription channel.
- The desktop host derives the calling App ID from the registered renderer, chooses the configured
  Penkra Account-service origin, and attaches the Account session outside the renderer.
- HTTP requests are forced under `/api/apps/<calling-app-id>/...`. Redirects and path traversal are
  rejected, bodies and responses are bounded, and credentials are never returned.
- Realtime connections are created by the host. The backend verifies the Account session, confirms
  an install receipt for the App ID, and authorizes each channel against its resource.
- Permission grants remain App-and-Space scoped. App-owned data may be Account scoped; those are
  separate decisions.

## Canvas profile

Canvas is the first consumer. Its backend namespace owns documents, one owner per document, editor
grants by normalized email, pending grants that activate only for a matching verified Account,
append-only Yjs updates, durable snapshots, quotas, soft deletion, and audit events. Canvas does not
use Space membership for document authorization.

A Canvas realtime channel is `document:<uuid>`. Joining it requires current owner/editor access.
The server publishes incremental updates and an aggregate human-presence count. Agents mutate the
same update log but do not appear as presence cursors.
