import type { Database } from "bun:sqlite";

/** Additive v48 columns. Kept independent of custody/owner implementations so the v45 audit can recognize
 * the exact suffix without importing the custody implementation. */
export const ATTACHMENT_CUSTODY_COLUMNS = [
  "attachment_input_format TEXT CHECK(attachment_input_format IS NULL OR attachment_input_format IN ('empty_v1','retained_v1'))",
  "attachment_custody_id TEXT REFERENCES attachment_custody_sets(id) DEFERRABLE INITIALLY DEFERRED",
  "attachment_input_digest TEXT REFERENCES attachment_custody_anchors(digest) DEFERRABLE INITIALLY DEFERRED",
  "attachment_cleanup_terminal_digest TEXT CHECK(attachment_cleanup_terminal_digest IS NULL OR (length(attachment_cleanup_terminal_digest)=64 AND attachment_cleanup_terminal_digest NOT GLOB '*[^a-f0-9]*')) CHECK((attachment_input_format IS NULL AND attachment_custody_id IS NULL AND attachment_input_digest IS NULL) OR (attachment_input_format IS 'empty_v1' AND attachment_custody_id IS NULL AND attachment_input_digest IS NOT NULL) OR (attachment_input_format IS 'retained_v1' AND attachment_custody_id IS NOT NULL AND attachment_input_digest IS NOT NULL))",
] as const;
export type InitialAttachmentInput = Readonly<{
  format: "empty_v1" | "retained_v1";
  custodyId: string | null;
  digest: string;
}>;

export class AttachmentCustodyNamespaceError extends Error {
  constructor() { super("ATTACHMENT_CUSTODY_CORRUPT"); this.name = "AttachmentCustodyNamespaceError"; }
}
/** The shared legacy classifier only checks immutable namespace linkage. It
 * does not grant retention or dispatch, and bare invocation tokens own no key. */
export function assertAttachmentCustodyNamespace(db: Database, lookup: { idempotencyKey: string } | { attemptId: string }): void {
  const marker = db.query("SELECT 1 FROM pragma_table_info('mutation_attempts') WHERE name='attachment_input_format'").get();
  const artifact = db.query("SELECT 1 FROM sqlite_master WHERE name IN ('attachment_custody_anchors','attachment_custody_dispositions','attachment_legacy_cleanup_blockers') LIMIT 1").get();
  if (marker === null && artifact === null) return;
  if (marker === null || artifact === null) throw new AttachmentCustodyNamespaceError();
  const byKey = "idempotencyKey" in lookup;
  const value = byKey ? lookup.idempotencyKey : lookup.attemptId;
  const parent = db.query(`SELECT id,idempotency_key,attachment_input_format,attachment_input_digest,attachment_custody_id FROM mutation_attempts WHERE ${byKey ? "idempotency_key" : "id"}=?`).get(value) as
    { id: string; idempotency_key: string; attachment_input_format: string | null; attachment_input_digest: string | null; attachment_custody_id: string | null } | null;
  const anchors = db.query(`SELECT attempt_id,original_key FROM (SELECT attempt_id,original_key FROM attachment_custody_anchors ${byKey ? "INDEXED BY attachment_custody_parent_anchor_key" : ""}
      WHERE kind!='custody' AND ${byKey ? "original_key" : "attempt_id"}=? LIMIT 3)
    UNION SELECT attempt_id,original_key FROM (SELECT attempt_id,original_key FROM attachment_custody_anchors
      WHERE kind!='custody' AND attempt_id=? LIMIT 3) LIMIT 3`).all(value, parent?.id ?? null) as { attempt_id: string; original_key: string }[];
  const owned = db.query(`SELECT attempt_id,original_key,custody_id FROM (SELECT attempt_id,original_key,custody_id FROM attachment_custody_dispositions
      WHERE kind='mutation_owned' AND ${byKey ? "original_key" : "attempt_id"}=? LIMIT 3)
    UNION SELECT attempt_id,original_key,custody_id FROM (SELECT attempt_id,original_key,custody_id FROM attachment_custody_dispositions
      WHERE kind='mutation_owned' AND attempt_id=? LIMIT 3) LIMIT 3`).all(value, parent?.id ?? null) as
    { attempt_id: string; original_key: string; custody_id: string }[];
  const blockers = db.query(`SELECT attempt_id,original_key FROM attachment_legacy_cleanup_blockers WHERE ${byKey ? "original_key" : "attempt_id"}=? OR attempt_id=? LIMIT 2`).all(value, parent?.id ?? null) as { attempt_id: string; original_key: string }[];
  if (anchors.length > 1 || owned.length > 1 || blockers.length > 1 || [...anchors, ...owned, ...blockers].some((entry) => parent === null
    || entry.attempt_id !== parent.id || entry.original_key !== parent.idempotency_key)) throw new AttachmentCustodyNamespaceError();
  if (parent?.attachment_input_format === "retained_v1" && (owned.length !== 1 || owned[0]?.custody_id !== parent.attachment_custody_id)) throw new AttachmentCustodyNamespaceError();
  if (parent?.attachment_input_format === "empty_v1" && anchors.length !== 1) throw new AttachmentCustodyNamespaceError();
}
