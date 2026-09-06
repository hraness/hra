/**
 * Admission-only projection. Disposed plans must never supply identity or
 * effect exceptions: use independently frozen mutation/plan evidence instead.
 * Journal reads and transitions deliberately do not use this projection.
 */
export const SESSION_SWITCH_FENCE_SOURCE = `(
  SELECT
    journal.journal_sequence,
    journal.original_session_revision,
    journal.original_authority_revision,
    journal.source_preset,
    journal.target_preset,
    journal.stream_epoch,
    journal.transcript_digest,
    journal.seed_digest,
    journal.seed_omitted_records,
    journal.seed_client_message_id,
    CASE WHEN disposition.journal_sequence IS NULL THEN journal.attempt_id
      ELSE mutation.id END AS attempt_id,
    CASE WHEN disposition.journal_sequence IS NULL THEN journal.request_key
      ELSE disposition.mutation_request_key END AS request_key,
    CASE WHEN disposition.journal_sequence IS NULL THEN journal.request_digest
      ELSE mutation.request_digest END AS request_digest,
    CASE WHEN disposition.journal_sequence IS NULL THEN journal.session_id
      ELSE disposition.session_id END AS session_id,
    CASE WHEN disposition.journal_sequence IS NULL THEN journal.phase
      ELSE CASE disposition.terminal_phase WHEN 'cancelled' THEN 'cancelled'
        ELSE 'quarantined' END END AS phase,
    CASE WHEN disposition.journal_sequence IS NULL THEN journal.source_provider_thread_id
      ELSE plan.source_provider_thread_id END AS source_provider_thread_id,
    CASE WHEN disposition.journal_sequence IS NULL THEN journal.after_sequence_exclusive
      ELSE 0 END AS after_sequence_exclusive,
    CASE WHEN disposition.journal_sequence IS NULL THEN journal.source_provider_account_id
      ELSE source.provider_account_id END AS source_provider_account_id,
    CASE WHEN disposition.journal_sequence IS NULL THEN journal.source_profile_id
      ELSE source.profile_id END AS source_profile_id,
    CASE WHEN disposition.journal_sequence IS NULL THEN journal.source_provider
      ELSE source.provider END AS source_provider,
    CASE WHEN disposition.journal_sequence IS NULL THEN journal.source_binding_generation
      ELSE source.binding_generation END AS source_binding_generation,
    CASE WHEN disposition.journal_sequence IS NULL THEN journal.source_process_generation
      ELSE source.process_generation END AS source_process_generation,
    CASE WHEN disposition.journal_sequence IS NULL THEN journal.target_provider_account_id
      ELSE target.provider_account_id END AS target_provider_account_id,
    CASE WHEN disposition.journal_sequence IS NULL THEN journal.target_profile_id
      ELSE target.profile_id END AS target_profile_id,
    CASE WHEN disposition.journal_sequence IS NULL THEN journal.target_provider
      ELSE target.provider END AS target_provider,
    CASE WHEN disposition.journal_sequence IS NULL THEN journal.target_binding_generation
      ELSE target.binding_generation END AS target_binding_generation,
    CASE WHEN disposition.journal_sequence IS NULL THEN journal.target_process_generation
      ELSE target.process_generation END AS target_process_generation
  FROM session_switch_attempts journal
  LEFT JOIN session_switch_malformed_dispositions disposition
    ON disposition.journal_sequence=journal.journal_sequence
  LEFT JOIN mutation_attempts mutation
    ON mutation.idempotency_key=disposition.mutation_request_key
  LEFT JOIN mutation_provider_authorities source
    ON source.attempt_id=mutation.id AND source.role='source'
  LEFT JOIN mutation_provider_authorities target
    ON target.attempt_id=mutation.id AND target.role='target'
  LEFT JOIN session_switch_plan_anchors plan ON plan.attempt_id=mutation.id
)`;

/** SQL consumers use the fixed `switch` alias for the admission projection. */
export const SESSION_SWITCH_BLOCKING_PREDICATE = `(
  switch.phase NOT IN ('seed_settled','failed','cancelled','abandoned')
)`;
