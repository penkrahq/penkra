// FILE: 200_FailedSendPayload.ts
// Purpose: Replace dev-only draft recovery with complete private failed-send payloads.
import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE thread_items ADD COLUMN send_payload TEXT`;
  // A failed-send cohort transfers the claim principal within its owning thread.
  // File identity and thread ownership remain immutable.
  yield* sql`DROP TRIGGER trg_managed_attachment_blobs_immutable_metadata`;
  yield* sql`CREATE TRIGGER trg_managed_attachment_blobs_immutable_metadata
    BEFORE UPDATE OF owner_thread_id,kind,original_name,mime_type,reserved_bytes,relative_path
    ON managed_attachment_blobs BEGIN
      SELECT RAISE(ABORT,'managed attachment metadata is immutable'); END`;
  yield* sql`CREATE TRIGGER trg_managed_attachment_blobs_claim_owner
    BEFORE UPDATE OF owner_kind,owner_id ON managed_attachment_blobs
    WHEN NOT (
      OLD.state='claimed' AND NEW.state='claimed' AND NEW.owner_thread_id=OLD.owner_thread_id
      AND EXISTS (SELECT 1 FROM thread_items AS item
        WHERE item.thread_id=OLD.owner_thread_id AND item.source_id=OLD.claim_message_id
          AND item.kind='user' AND item.status='failed' AND item.send_payload IS NOT NULL
          AND EXISTS (SELECT 1 FROM json_each(item.send_payload,'$.message.attachments') AS attachment
            WHERE json_extract(attachment.value,'$.id')=OLD.attachment_id))
    ) BEGIN SELECT RAISE(ABORT,'managed attachment claim owner is immutable'); END`;

  // Preserve history without making it a retry cohort. Unacknowledged legacy
  // delivery states are failed, with no payload; only new admissions own one.
  yield* sql`UPDATE thread_items SET status='failed' WHERE kind='user' AND (
    status IN ('sending','queued') OR EXISTS (
      SELECT 1 FROM projection_thread_messages m
      WHERE m.thread_id=thread_items.thread_id AND m.message_id=thread_items.source_id
      AND m.delivery_state IN ('failed','starting','steering','queued')
    ))`;
  yield* sql`ALTER TABLE thread_items DROP COLUMN recovery_draft`;
  yield* sql`CREATE INDEX idx_thread_items_failed_send ON thread_items(thread_id,seq) WHERE kind='user' AND status='failed'`;
});
