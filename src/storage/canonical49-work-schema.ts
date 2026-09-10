// Frozen released Work trigger definitions from 7ab347813f8d7e4f31e9584752c801dd1ca0cda0.
// Source Work-store SHA256: 0b79503811b93ce56171f5cdcb1d5d840e7e6c005068b579f3f1a8637eee2146.
// Canonical v42-v49 share the same Work trigger bodies; v49 adds the separate
// project companion. Literal SQL is not a populated historical database or
// complete cohort proof. Do not derive these definitions from runtime exports.

export const CANONICAL_40_WORK_AUTHORITY_TRIGGER_DEFINITIONS = Object.freeze([
  Object.freeze(["works_identity_immutable", `CREATE TRIGGER works_identity_immutable
BEFORE UPDATE OF id,client_ref,coordinator_session_id,objective,preset_contract,stream_epoch,created_at ON works
BEGIN SELECT RAISE(ABORT,'WORK_IMMUTABLE'); END;`] as const),
  Object.freeze(["work_devin_preset_contract_guard", `
CREATE TRIGGER work_devin_preset_contract_guard
BEFORE INSERT ON works
WHEN NEW.preset_contract!=2 AND EXISTS (
  SELECT 1 FROM sessions AS s
  WHERE s.id=NEW.coordinator_session_id AND s.provider_v39='devin'
)
BEGIN SELECT RAISE(ABORT,'WORK_DEVIN_PRESET_CONTRACT_MISMATCH'); END;
`] as const),
  Object.freeze(["work_session_devin_contract_guard", `
CREATE TRIGGER work_session_devin_contract_guard
BEFORE UPDATE OF provider_v39,preset_contract ON sessions
WHEN NEW.provider_v39='devin' AND (
  NEW.preset_contract!=2
  OR EXISTS (
    SELECT 1 FROM works AS w
    WHERE w.coordinator_session_id=OLD.id
      AND w.preset_contract!=2
  )
)
BEGIN SELECT RAISE(ABORT,'WORK_DEVIN_PRESET_CONTRACT_MISMATCH'); END;
  `] as const),
  Object.freeze(["work_coordinator_account_authority_guard", `CREATE TRIGGER work_coordinator_account_authority_guard
BEFORE INSERT ON works
WHEN NOT EXISTS (
  SELECT 1
  FROM sessions AS authority_session
  JOIN profiles AS authority_profile ON authority_profile.id=authority_session.profile_id
  LEFT JOIN session_provider_account_authorities AS provider_authority
    ON provider_authority.session_id=authority_session.id
      AND provider_authority.provider=authority_session.provider_v39
  WHERE authority_session.id=NEW.coordinator_session_id
    AND authority_session.state IN ('active','idle')
\x20\x20\x20\x20
    AND NOT EXISTS (
      SELECT 1 FROM provider_runtime_account_revocations AS authority_revocation
      WHERE authority_revocation.profile_id=authority_session.profile_id
        AND authority_revocation.profile_generation=authority_profile.process_generation
        AND authority_revocation.provider=authority_session.provider_v39
        AND authority_revocation.runtime_scope=provider_authority.runtime_scope
        AND (
          authority_revocation.state='releasing'
          OR authority_revocation.current_account_key IS NULL
          OR authority_revocation.current_account_key!=provider_authority.account_key
        )
    )
    AND (
      (provider_authority.runtime_scope='personal' AND EXISTS (
        SELECT 1 FROM session_personal_runtime_bindings AS authority_binding
        WHERE authority_binding.session_id=authority_session.id
          AND authority_binding.provider=authority_session.provider_v39
          AND authority_binding.provider_thread_id=authority_session.provider_thread_id
          AND authority_binding.state='active'
      ))
      OR (provider_authority.runtime_scope='managed' AND NOT EXISTS (
        SELECT 1 FROM session_personal_runtime_bindings AS authority_binding
        WHERE authority_binding.session_id=authority_session.id
          AND authority_binding.state IN ('active','detaching')
      ))
      OR (authority_session.provider_v39='devin' AND NOT EXISTS (
        SELECT 1 FROM session_personal_runtime_bindings AS authority_binding
        WHERE authority_binding.session_id=authority_session.id
          AND authority_binding.state IN ('active','detaching')
      ))
    )
    AND (
      (authority_session.provider_v39='claude'
        AND authority_profile.state IN ('signed_in','signed_out'))
      OR (authority_session.provider_v39='codex'
        AND authority_profile.state='signed_in'
        AND authority_profile.provider_email IS NOT NULL
        AND authority_profile.codex_account_key=provider_authority.account_key
        AND EXISTS (
          SELECT 1 FROM session_account_authorities AS legacy_authority
          WHERE legacy_authority.session_id=authority_session.id
            AND legacy_authority.profile_id=authority_session.profile_id
            AND legacy_authority.account_key IS NOT NULL
            AND legacy_authority.account_key=lower(trim(authority_profile.provider_email))
        ))
      OR (authority_session.provider_v39='devin'
        AND authority_profile.state IN ('signed_in','signed_out'))
    )
)
BEGIN SELECT RAISE(ABORT,'WORK_COORDINATOR_AUTHORITY_MISMATCH'); END;`] as const),
  Object.freeze(["work_member_account_authority_guard", `CREATE TRIGGER work_member_account_authority_guard
BEFORE INSERT ON work_members
WHEN NOT EXISTS (
  SELECT 1
  FROM sessions AS authority_session
  JOIN profiles AS authority_profile ON authority_profile.id=authority_session.profile_id
  LEFT JOIN session_provider_account_authorities AS provider_authority
    ON provider_authority.session_id=authority_session.id
      AND provider_authority.provider=authority_session.provider_v39
  WHERE authority_session.id=NEW.session_id
    AND authority_session.state IN ('active','idle')
\x20\x20\x20\x20
    AND NOT EXISTS (
      SELECT 1 FROM provider_runtime_account_revocations AS authority_revocation
      WHERE authority_revocation.profile_id=authority_session.profile_id
        AND authority_revocation.profile_generation=authority_profile.process_generation
        AND authority_revocation.provider=authority_session.provider_v39
        AND authority_revocation.runtime_scope=provider_authority.runtime_scope
        AND (
          authority_revocation.state='releasing'
          OR authority_revocation.current_account_key IS NULL
          OR authority_revocation.current_account_key!=provider_authority.account_key
        )
    )
    AND (
      (provider_authority.runtime_scope='personal' AND EXISTS (
        SELECT 1 FROM session_personal_runtime_bindings AS authority_binding
        WHERE authority_binding.session_id=authority_session.id
          AND authority_binding.provider=authority_session.provider_v39
          AND authority_binding.provider_thread_id=authority_session.provider_thread_id
          AND authority_binding.state='active'
      ))
      OR (provider_authority.runtime_scope='managed' AND NOT EXISTS (
        SELECT 1 FROM session_personal_runtime_bindings AS authority_binding
        WHERE authority_binding.session_id=authority_session.id
          AND authority_binding.state IN ('active','detaching')
      ))
      OR (authority_session.provider_v39='devin' AND NOT EXISTS (
        SELECT 1 FROM session_personal_runtime_bindings AS authority_binding
        WHERE authority_binding.session_id=authority_session.id
          AND authority_binding.state IN ('active','detaching')
      ))
    )
    AND (
      (authority_session.provider_v39='claude'
        AND authority_profile.state IN ('signed_in','signed_out'))
      OR (authority_session.provider_v39='codex'
        AND authority_profile.state='signed_in'
        AND authority_profile.provider_email IS NOT NULL
        AND authority_profile.codex_account_key=provider_authority.account_key
        AND EXISTS (
          SELECT 1 FROM session_account_authorities AS legacy_authority
          WHERE legacy_authority.session_id=authority_session.id
            AND legacy_authority.profile_id=authority_session.profile_id
            AND legacy_authority.account_key IS NOT NULL
            AND legacy_authority.account_key=lower(trim(authority_profile.provider_email))
        ))
      OR (authority_session.provider_v39='devin'
        AND authority_profile.state IN ('signed_in','signed_out'))
    )
)
BEGIN SELECT RAISE(ABORT,'WORK_MEMBER_AUTHORITY_MISMATCH'); END;`] as const),
  Object.freeze(["work_attempt_route_guard", `CREATE TRIGGER work_attempt_route_guard
BEFORE INSERT ON work_attempts
WHEN NOT EXISTS (
  -- Contract 1 and 2 both resolve Codex low to the exact Luna/max tuple.
  -- High and ultra changed model and therefore remain version-fenced.
  SELECT 1
  FROM work_tasks AS t
  JOIN works AS w ON w.id=t.work_id
  JOIN sessions AS s ON s.id=NEW.worker_session_id
  JOIN work_members AS m ON m.work_id=NEW.work_id AND m.session_id=s.id
  WHERE t.id=NEW.task_id AND t.work_id=NEW.work_id
    AND t.account_id=NEW.account_id AND t.project_id=NEW.project_id
    AND t.preset=NEW.preset AND t.fast=NEW.fast
    AND s.profile_id=NEW.account_id AND s.project_id=NEW.project_id
    AND s.preset=NEW.preset AND s.fast_enabled=NEW.fast
    AND s.provider_v39='codex'
    AND (
      s.preset_contract=w.preset_contract
      OR NEW.preset='low'
    )
    AND NOT EXISTS (
      SELECT 1
      FROM mutation_attempts AS sm
      LEFT JOIN mutation_resolutions AS sr ON sr.attempt_id=sm.id
      WHERE sm.authority_id=s.id AND sm.kind='session.switch'
        AND sm.state IN ('effect_started','ambiguous')
        AND sr.attempt_id IS NULL
    )
)
BEGIN SELECT RAISE(ABORT,'WORK_ATTEMPT_ROUTE_MISMATCH'); END;`] as const),
  Object.freeze(["work_attempt_account_authority_guard", `CREATE TRIGGER work_attempt_account_authority_guard
BEFORE INSERT ON work_attempts
WHEN NOT EXISTS (
  SELECT 1
  FROM sessions AS authority_session
  JOIN profiles AS authority_profile ON authority_profile.id=authority_session.profile_id
  LEFT JOIN session_provider_account_authorities AS provider_authority
    ON provider_authority.session_id=authority_session.id
      AND provider_authority.provider=authority_session.provider_v39
  WHERE authority_session.id=NEW.worker_session_id
    AND authority_session.state IN ('active','idle')
    AND (authority_session.provider_v39='codex' AND authority_session.profile_id=NEW.account_id AND authority_profile.process_generation=NEW.account_generation)
    AND NOT EXISTS (
      SELECT 1 FROM provider_runtime_account_revocations AS authority_revocation
      WHERE authority_revocation.profile_id=authority_session.profile_id
        AND authority_revocation.profile_generation=authority_profile.process_generation
        AND authority_revocation.provider=authority_session.provider_v39
        AND authority_revocation.runtime_scope=provider_authority.runtime_scope
        AND (
          authority_revocation.state='releasing'
          OR authority_revocation.current_account_key IS NULL
          OR authority_revocation.current_account_key!=provider_authority.account_key
        )
    )
    AND (
      (provider_authority.runtime_scope='personal' AND EXISTS (
        SELECT 1 FROM session_personal_runtime_bindings AS authority_binding
        WHERE authority_binding.session_id=authority_session.id
          AND authority_binding.provider=authority_session.provider_v39
          AND authority_binding.provider_thread_id=authority_session.provider_thread_id
          AND authority_binding.state='active'
      ))
      OR (provider_authority.runtime_scope='managed' AND NOT EXISTS (
        SELECT 1 FROM session_personal_runtime_bindings AS authority_binding
        WHERE authority_binding.session_id=authority_session.id
          AND authority_binding.state IN ('active','detaching')
      ))
      OR (authority_session.provider_v39='devin' AND NOT EXISTS (
        SELECT 1 FROM session_personal_runtime_bindings AS authority_binding
        WHERE authority_binding.session_id=authority_session.id
          AND authority_binding.state IN ('active','detaching')
      ))
    )
    AND (
      (authority_session.provider_v39='claude'
        AND authority_profile.state IN ('signed_in','signed_out'))
      OR (authority_session.provider_v39='codex'
        AND authority_profile.state='signed_in'
        AND authority_profile.provider_email IS NOT NULL
        AND authority_profile.codex_account_key=provider_authority.account_key
        AND EXISTS (
          SELECT 1 FROM session_account_authorities AS legacy_authority
          WHERE legacy_authority.session_id=authority_session.id
            AND legacy_authority.profile_id=authority_session.profile_id
            AND legacy_authority.account_key IS NOT NULL
            AND legacy_authority.account_key=lower(trim(authority_profile.provider_email))
        ))
      OR (authority_session.provider_v39='devin'
        AND authority_profile.state IN ('signed_in','signed_out'))
    )
)
BEGIN SELECT RAISE(ABORT,'WORK_ATTEMPT_ACCOUNT_AUTHORITY_MISMATCH'); END;`] as const),
  Object.freeze(["work_session_switch_attempt_authority_guard", `CREATE TRIGGER work_session_switch_attempt_authority_guard
BEFORE UPDATE OF state ON mutation_attempts
WHEN OLD.kind='session.switch'
  AND OLD.state='prepared'
  AND NEW.state='effect_started'
  AND EXISTS (
    SELECT 1 FROM work_attempts AS a
    WHERE a.worker_session_id=OLD.authority_id
      AND a.state IN ('claimed','dispatching','running','recovery_required')
  )
BEGIN SELECT RAISE(ABORT,'WORK_SESSION_SWITCH_ATTEMPT_AUTHORITY'); END;`] as const),
  Object.freeze(["work_session_attempt_authority_guard", `CREATE TRIGGER work_session_attempt_authority_guard
BEFORE UPDATE OF profile_id,project_id,provider_v39,preset,fast_enabled,preset_contract ON sessions
WHEN EXISTS (
  SELECT 1 FROM work_attempts AS a
  JOIN works AS w ON w.id=a.work_id
  WHERE a.worker_session_id=OLD.id
    AND a.state IN ('claimed','dispatching','running','recovery_required')
    AND (
      NEW.profile_id!=a.account_id OR NEW.project_id!=a.project_id
      OR NEW.provider_v39!='codex' OR NEW.preset!=a.preset OR NEW.fast_enabled!=a.fast
      OR (
        NEW.preset_contract!=w.preset_contract
        AND a.preset!='low'
      )
    )
)
BEGIN SELECT RAISE(ABORT,'WORK_SESSION_ATTEMPT_AUTHORITY'); END;`] as const),
  Object.freeze(["work_review_account_authority_guard", `CREATE TRIGGER work_review_account_authority_guard
BEFORE INSERT ON work_reviews
WHEN NOT EXISTS (
  SELECT 1
  FROM sessions AS authority_session
  JOIN profiles AS authority_profile ON authority_profile.id=authority_session.profile_id
  LEFT JOIN session_provider_account_authorities AS provider_authority
    ON provider_authority.session_id=authority_session.id
      AND provider_authority.provider=authority_session.provider_v39
  WHERE authority_session.id=NEW.reviewer_session_id
    AND authority_session.state IN ('active','idle')
\x20\x20\x20\x20
    AND NOT EXISTS (
      SELECT 1 FROM provider_runtime_account_revocations AS authority_revocation
      WHERE authority_revocation.profile_id=authority_session.profile_id
        AND authority_revocation.profile_generation=authority_profile.process_generation
        AND authority_revocation.provider=authority_session.provider_v39
        AND authority_revocation.runtime_scope=provider_authority.runtime_scope
        AND (
          authority_revocation.state='releasing'
          OR authority_revocation.current_account_key IS NULL
          OR authority_revocation.current_account_key!=provider_authority.account_key
        )
    )
    AND (
      (provider_authority.runtime_scope='personal' AND EXISTS (
        SELECT 1 FROM session_personal_runtime_bindings AS authority_binding
        WHERE authority_binding.session_id=authority_session.id
          AND authority_binding.provider=authority_session.provider_v39
          AND authority_binding.provider_thread_id=authority_session.provider_thread_id
          AND authority_binding.state='active'
      ))
      OR (provider_authority.runtime_scope='managed' AND NOT EXISTS (
        SELECT 1 FROM session_personal_runtime_bindings AS authority_binding
        WHERE authority_binding.session_id=authority_session.id
          AND authority_binding.state IN ('active','detaching')
      ))
      OR (authority_session.provider_v39='devin' AND NOT EXISTS (
        SELECT 1 FROM session_personal_runtime_bindings AS authority_binding
        WHERE authority_binding.session_id=authority_session.id
          AND authority_binding.state IN ('active','detaching')
      ))
    )
    AND (
      (authority_session.provider_v39='claude'
        AND authority_profile.state IN ('signed_in','signed_out'))
      OR (authority_session.provider_v39='codex'
        AND authority_profile.state='signed_in'
        AND authority_profile.provider_email IS NOT NULL
        AND authority_profile.codex_account_key=provider_authority.account_key
        AND EXISTS (
          SELECT 1 FROM session_account_authorities AS legacy_authority
          WHERE legacy_authority.session_id=authority_session.id
            AND legacy_authority.profile_id=authority_session.profile_id
            AND legacy_authority.account_key IS NOT NULL
            AND legacy_authority.account_key=lower(trim(authority_profile.provider_email))
        ))
      OR (authority_session.provider_v39='devin'
        AND authority_profile.state IN ('signed_in','signed_out'))
    )
)
BEGIN SELECT RAISE(ABORT,'WORK_REVIEWER_AUTHORITY_MISMATCH'); END;`] as const),
  Object.freeze(["work_signal_member_guard", `CREATE TRIGGER IF NOT EXISTS work_signal_member_guard
BEFORE INSERT ON work_signals
WHEN NOT EXISTS (SELECT 1 FROM work_members WHERE work_id=NEW.work_id AND session_id=NEW.from_session_id)
  OR NOT EXISTS (SELECT 1 FROM work_members WHERE work_id=NEW.work_id AND session_id=NEW.to_session_id)
  OR NOT EXISTS (
    SELECT 1 FROM sessions AS s JOIN profiles AS p ON p.id=s.profile_id
    WHERE s.id=NEW.to_session_id
      AND p.process_generation=NEW.target_account_generation
  )
BEGIN SELECT RAISE(ABORT,'WORK_SIGNAL_MEMBER_INVALID'); END;`] as const),
  Object.freeze(["work_signal_account_authority_guard", `CREATE TRIGGER work_signal_account_authority_guard
BEFORE INSERT ON work_signals
WHEN NOT EXISTS (
  SELECT 1
  FROM sessions AS authority_session
  JOIN profiles AS authority_profile ON authority_profile.id=authority_session.profile_id
  LEFT JOIN session_provider_account_authorities AS provider_authority
    ON provider_authority.session_id=authority_session.id
      AND provider_authority.provider=authority_session.provider_v39
  WHERE authority_session.id=NEW.from_session_id
    AND authority_session.state IN ('active','idle')
\x20\x20\x20\x20
    AND NOT EXISTS (
      SELECT 1 FROM provider_runtime_account_revocations AS authority_revocation
      WHERE authority_revocation.profile_id=authority_session.profile_id
        AND authority_revocation.profile_generation=authority_profile.process_generation
        AND authority_revocation.provider=authority_session.provider_v39
        AND authority_revocation.runtime_scope=provider_authority.runtime_scope
        AND (
          authority_revocation.state='releasing'
          OR authority_revocation.current_account_key IS NULL
          OR authority_revocation.current_account_key!=provider_authority.account_key
        )
    )
    AND (
      (provider_authority.runtime_scope='personal' AND EXISTS (
        SELECT 1 FROM session_personal_runtime_bindings AS authority_binding
        WHERE authority_binding.session_id=authority_session.id
          AND authority_binding.provider=authority_session.provider_v39
          AND authority_binding.provider_thread_id=authority_session.provider_thread_id
          AND authority_binding.state='active'
      ))
      OR (provider_authority.runtime_scope='managed' AND NOT EXISTS (
        SELECT 1 FROM session_personal_runtime_bindings AS authority_binding
        WHERE authority_binding.session_id=authority_session.id
          AND authority_binding.state IN ('active','detaching')
      ))
      OR (authority_session.provider_v39='devin' AND NOT EXISTS (
        SELECT 1 FROM session_personal_runtime_bindings AS authority_binding
        WHERE authority_binding.session_id=authority_session.id
          AND authority_binding.state IN ('active','detaching')
      ))
    )
    AND (
      (authority_session.provider_v39='claude'
        AND authority_profile.state IN ('signed_in','signed_out'))
      OR (authority_session.provider_v39='codex'
        AND authority_profile.state='signed_in'
        AND authority_profile.provider_email IS NOT NULL
        AND authority_profile.codex_account_key=provider_authority.account_key
        AND EXISTS (
          SELECT 1 FROM session_account_authorities AS legacy_authority
          WHERE legacy_authority.session_id=authority_session.id
            AND legacy_authority.profile_id=authority_session.profile_id
            AND legacy_authority.account_key IS NOT NULL
            AND legacy_authority.account_key=lower(trim(authority_profile.provider_email))
        ))
      OR (authority_session.provider_v39='devin'
        AND authority_profile.state IN ('signed_in','signed_out'))
    )
)
OR NOT EXISTS (
  SELECT 1
  FROM sessions AS authority_session
  JOIN profiles AS authority_profile ON authority_profile.id=authority_session.profile_id
  LEFT JOIN session_provider_account_authorities AS provider_authority
    ON provider_authority.session_id=authority_session.id
      AND provider_authority.provider=authority_session.provider_v39
  WHERE authority_session.id=NEW.to_session_id
    AND authority_session.state IN ('active','idle')
    AND (authority_profile.process_generation=NEW.target_account_generation)
    AND NOT EXISTS (
      SELECT 1 FROM provider_runtime_account_revocations AS authority_revocation
      WHERE authority_revocation.profile_id=authority_session.profile_id
        AND authority_revocation.profile_generation=authority_profile.process_generation
        AND authority_revocation.provider=authority_session.provider_v39
        AND authority_revocation.runtime_scope=provider_authority.runtime_scope
        AND (
          authority_revocation.state='releasing'
          OR authority_revocation.current_account_key IS NULL
          OR authority_revocation.current_account_key!=provider_authority.account_key
        )
    )
    AND (
      (provider_authority.runtime_scope='personal' AND EXISTS (
        SELECT 1 FROM session_personal_runtime_bindings AS authority_binding
        WHERE authority_binding.session_id=authority_session.id
          AND authority_binding.provider=authority_session.provider_v39
          AND authority_binding.provider_thread_id=authority_session.provider_thread_id
          AND authority_binding.state='active'
      ))
      OR (provider_authority.runtime_scope='managed' AND NOT EXISTS (
        SELECT 1 FROM session_personal_runtime_bindings AS authority_binding
        WHERE authority_binding.session_id=authority_session.id
          AND authority_binding.state IN ('active','detaching')
      ))
      OR (authority_session.provider_v39='devin' AND NOT EXISTS (
        SELECT 1 FROM session_personal_runtime_bindings AS authority_binding
        WHERE authority_binding.session_id=authority_session.id
          AND authority_binding.state IN ('active','detaching')
      ))
    )
    AND (
      (authority_session.provider_v39='claude'
        AND authority_profile.state IN ('signed_in','signed_out'))
      OR (authority_session.provider_v39='codex'
        AND authority_profile.state='signed_in'
        AND authority_profile.provider_email IS NOT NULL
        AND authority_profile.codex_account_key=provider_authority.account_key
        AND EXISTS (
          SELECT 1 FROM session_account_authorities AS legacy_authority
          WHERE legacy_authority.session_id=authority_session.id
            AND legacy_authority.profile_id=authority_session.profile_id
            AND legacy_authority.account_key IS NOT NULL
            AND legacy_authority.account_key=lower(trim(authority_profile.provider_email))
        ))
      OR (authority_session.provider_v39='devin'
        AND authority_profile.state IN ('signed_in','signed_out'))
    )
)
BEGIN SELECT RAISE(ABORT,'WORK_SIGNAL_ACCOUNT_AUTHORITY_MISMATCH'); END;`] as const),
  Object.freeze(["work_signal_ack_account_authority_guard", `CREATE TRIGGER work_signal_ack_account_authority_guard
BEFORE INSERT ON work_signal_receipts
WHEN NEW.kind='ack' AND NOT EXISTS (
  SELECT 1 FROM work_signals AS signal
  WHERE signal.id=NEW.signal_id
    AND signal.to_session_id=NEW.actor_session_id
    AND EXISTS (
  SELECT 1
  FROM sessions AS authority_session
  JOIN profiles AS authority_profile ON authority_profile.id=authority_session.profile_id
  LEFT JOIN session_provider_account_authorities AS provider_authority
    ON provider_authority.session_id=authority_session.id
      AND provider_authority.provider=authority_session.provider_v39
  WHERE authority_session.id=signal.to_session_id
    AND authority_session.state IN ('active','idle')
    AND (authority_profile.process_generation=signal.target_account_generation)
    AND NOT EXISTS (
      SELECT 1 FROM provider_runtime_account_revocations AS authority_revocation
      WHERE authority_revocation.profile_id=authority_session.profile_id
        AND authority_revocation.profile_generation=authority_profile.process_generation
        AND authority_revocation.provider=authority_session.provider_v39
        AND authority_revocation.runtime_scope=provider_authority.runtime_scope
        AND (
          authority_revocation.state='releasing'
          OR authority_revocation.current_account_key IS NULL
          OR authority_revocation.current_account_key!=provider_authority.account_key
        )
    )
    AND (
      (provider_authority.runtime_scope='personal' AND EXISTS (
        SELECT 1 FROM session_personal_runtime_bindings AS authority_binding
        WHERE authority_binding.session_id=authority_session.id
          AND authority_binding.provider=authority_session.provider_v39
          AND authority_binding.provider_thread_id=authority_session.provider_thread_id
          AND authority_binding.state='active'
      ))
      OR (provider_authority.runtime_scope='managed' AND NOT EXISTS (
        SELECT 1 FROM session_personal_runtime_bindings AS authority_binding
        WHERE authority_binding.session_id=authority_session.id
          AND authority_binding.state IN ('active','detaching')
      ))
      OR (authority_session.provider_v39='devin' AND NOT EXISTS (
        SELECT 1 FROM session_personal_runtime_bindings AS authority_binding
        WHERE authority_binding.session_id=authority_session.id
          AND authority_binding.state IN ('active','detaching')
      ))
    )
    AND (
      (authority_session.provider_v39='claude'
        AND authority_profile.state IN ('signed_in','signed_out'))
      OR (authority_session.provider_v39='codex'
        AND authority_profile.state='signed_in'
        AND authority_profile.provider_email IS NOT NULL
        AND authority_profile.codex_account_key=provider_authority.account_key
        AND EXISTS (
          SELECT 1 FROM session_account_authorities AS legacy_authority
          WHERE legacy_authority.session_id=authority_session.id
            AND legacy_authority.profile_id=authority_session.profile_id
            AND legacy_authority.account_key IS NOT NULL
            AND legacy_authority.account_key=lower(trim(authority_profile.provider_email))
        ))
      OR (authority_session.provider_v39='devin'
        AND authority_profile.state IN ('signed_in','signed_out'))
    )
)
)
BEGIN SELECT RAISE(ABORT,'WORK_SIGNAL_ACK_ACCOUNT_AUTHORITY_MISMATCH'); END;`] as const),
]);

export const CANONICAL_49_WORK_PRESET_GUARD_DEFINITIONS = Object.freeze([
  Object.freeze(["work_devin_preset_contract_guard", `CREATE TRIGGER work_devin_preset_contract_guard
BEFORE INSERT ON works
WHEN NEW.preset_contract!=1
BEGIN SELECT RAISE(ABORT,'WORK_PRESET_CONTRACT_MISMATCH'); END;`] as const),
  Object.freeze(["work_session_devin_contract_guard", `CREATE TRIGGER work_session_devin_contract_guard
BEFORE UPDATE OF provider_v39,preset_contract ON sessions
WHEN NEW.provider_v39='devin' AND (
  NEW.preset_contract!=2
  OR EXISTS (
    SELECT 1 FROM works AS w
    WHERE w.coordinator_session_id=NEW.id
      AND w.preset_contract!=2
  )
)
BEGIN SELECT RAISE(ABORT,'WORK_DEVIN_PRESET_CONTRACT_MISMATCH'); END;`] as const),
]);

export const CANONICAL_WORK_NON_AUTHORITY_TRIGGER_DEFINITIONS = Object.freeze([
  Object.freeze(["work_release_tombstones_no_update", `CREATE TRIGGER IF NOT EXISTS work_release_tombstones_no_update
BEFORE UPDATE ON work_release_tombstones
BEGIN SELECT RAISE(ABORT,'WORK_RELEASE_TOMBSTONE_IMMUTABLE'); END;`] as const),
  Object.freeze(["work_active_limit_guard", `CREATE TRIGGER IF NOT EXISTS work_active_limit_guard
BEFORE INSERT ON works
WHEN NEW.state IN ('active','cancel_pending','fail_pending') AND (
  SELECT COUNT(*) FROM works WHERE state IN ('active','cancel_pending','fail_pending')
) >= 1024
BEGIN SELECT RAISE(ABORT,'WORK_ACTIVE_LIMIT'); END;`] as const),
  Object.freeze(["work_retained_limit_guard", `CREATE TRIGGER IF NOT EXISTS work_retained_limit_guard
BEFORE INSERT ON works
WHEN (SELECT COUNT(*) FROM works) >= 8192
BEGIN SELECT RAISE(ABORT,'WORK_RETAINED_LIMIT'); END;`] as const),
  Object.freeze(["works_no_delete", `CREATE TRIGGER IF NOT EXISTS works_no_delete
BEFORE DELETE ON works
WHEN NOT EXISTS (SELECT 1 FROM work_purge_authority WHERE work_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'WORK_IMMUTABLE'); END;`] as const),
  Object.freeze(["works_state_guard", `CREATE TRIGGER IF NOT EXISTS works_state_guard
BEFORE UPDATE OF state ON works
WHEN NOT (
  OLD.state = NEW.state OR
  (OLD.state = 'active' AND NEW.state IN ('cancel_pending','fail_pending','completed','failed','cancelled')) OR
  (OLD.state = 'cancel_pending' AND NEW.state='cancelled') OR
  (OLD.state = 'fail_pending' AND NEW.state='failed')
)
BEGIN SELECT RAISE(ABORT,'WORK_STATE_TRANSITION'); END;`] as const),
  Object.freeze(["works_stream_advance_guard", `CREATE TRIGGER IF NOT EXISTS works_stream_advance_guard
BEFORE UPDATE OF revision,next_sequence,head_hash ON works
WHEN NEW.revision != OLD.revision + 1
  OR NEW.next_sequence != OLD.next_sequence + 1
  OR NOT EXISTS (
    SELECT 1 FROM work_events AS e
    WHERE e.work_id=OLD.id
      AND e.sequence=OLD.next_sequence
      AND e.revision=NEW.revision
      AND e.previous_hash IS OLD.head_hash
      AND e.event_hash=NEW.head_hash
  )
BEGIN SELECT RAISE(ABORT,'WORK_STREAM_ADVANCE_INVALID'); END;`] as const),
  Object.freeze(["work_routes_no_update", `CREATE TRIGGER IF NOT EXISTS work_routes_no_update
BEFORE UPDATE ON work_routes BEGIN SELECT RAISE(ABORT,'WORK_ROUTE_IMMUTABLE'); END;`] as const),
  Object.freeze(["work_routes_no_delete", `CREATE TRIGGER IF NOT EXISTS work_routes_no_delete
BEFORE DELETE ON work_routes
WHEN NOT EXISTS (SELECT 1 FROM work_purge_authority WHERE work_id=OLD.work_id)
BEGIN SELECT RAISE(ABORT,'WORK_ROUTE_IMMUTABLE'); END;`] as const),
  Object.freeze(["work_route_limit_guard", `CREATE TRIGGER IF NOT EXISTS work_route_limit_guard
BEFORE INSERT ON work_routes
WHEN (SELECT COUNT(*) FROM work_routes WHERE work_id=NEW.work_id) >= 64
BEGIN SELECT RAISE(ABORT,'WORK_ROUTE_LIMIT'); END;`] as const),
  Object.freeze(["work_route_authority_guard", `CREATE TRIGGER IF NOT EXISTS work_route_authority_guard
BEFORE INSERT ON work_routes
WHEN NOT EXISTS (SELECT 1 FROM profiles WHERE id=NEW.account_id AND state!='removed')
  OR NOT EXISTS (SELECT 1 FROM projects WHERE id=NEW.project_id)
BEGIN SELECT RAISE(ABORT,'WORK_ROUTE_MISMATCH'); END;`] as const),
  Object.freeze(["work_members_no_update", `CREATE TRIGGER IF NOT EXISTS work_members_no_update
BEFORE UPDATE ON work_members BEGIN SELECT RAISE(ABORT,'WORK_MEMBER_IMMUTABLE'); END;`] as const),
  Object.freeze(["work_members_no_delete", `CREATE TRIGGER IF NOT EXISTS work_members_no_delete
BEFORE DELETE ON work_members
WHEN NOT EXISTS (SELECT 1 FROM work_purge_authority WHERE work_id=OLD.work_id)
BEGIN SELECT RAISE(ABORT,'WORK_MEMBER_IMMUTABLE'); END;`] as const),
  Object.freeze(["work_member_limit_guard", `CREATE TRIGGER IF NOT EXISTS work_member_limit_guard
BEFORE INSERT ON work_members
WHEN (SELECT COUNT(*) FROM work_members WHERE work_id=NEW.work_id) >= 256
BEGIN SELECT RAISE(ABORT,'WORK_MEMBER_LIMIT'); END;`] as const),
  Object.freeze(["work_tasks_no_update", `CREATE TRIGGER IF NOT EXISTS work_tasks_no_update
BEFORE UPDATE ON work_tasks BEGIN SELECT RAISE(ABORT,'WORK_TASK_IMMUTABLE'); END;`] as const),
  Object.freeze(["work_tasks_no_delete", `CREATE TRIGGER IF NOT EXISTS work_tasks_no_delete
BEFORE DELETE ON work_tasks
WHEN NOT EXISTS (SELECT 1 FROM work_purge_authority WHERE work_id=OLD.work_id)
BEGIN SELECT RAISE(ABORT,'WORK_TASK_IMMUTABLE'); END;`] as const),
  Object.freeze(["work_dependencies_no_update", `CREATE TRIGGER IF NOT EXISTS work_dependencies_no_update
BEFORE UPDATE ON work_task_dependencies BEGIN SELECT RAISE(ABORT,'WORK_DEPENDENCY_IMMUTABLE'); END;`] as const),
  Object.freeze(["work_dependencies_no_delete", `CREATE TRIGGER IF NOT EXISTS work_dependencies_no_delete
BEFORE DELETE ON work_task_dependencies
WHEN NOT EXISTS (SELECT 1 FROM work_purge_authority WHERE work_id=OLD.work_id)
BEGIN SELECT RAISE(ABORT,'WORK_DEPENDENCY_IMMUTABLE'); END;`] as const),
  Object.freeze(["work_task_state_identity_immutable", `CREATE TRIGGER IF NOT EXISTS work_task_state_identity_immutable
BEFORE UPDATE OF task_id,work_id,next_fence,attempt_count ON work_task_states
WHEN NEW.next_fence < OLD.next_fence OR NEW.attempt_count < OLD.attempt_count OR NEW.task_id != OLD.task_id OR NEW.work_id != OLD.work_id
BEGIN SELECT RAISE(ABORT,'WORK_TASK_STATE_MONOTONIC'); END;`] as const),
  Object.freeze(["work_task_state_revision_guard", `CREATE TRIGGER IF NOT EXISTS work_task_state_revision_guard
BEFORE UPDATE ON work_task_states
WHEN NEW.revision != OLD.revision + 1
BEGIN SELECT RAISE(ABORT,'WORK_TASK_STATE_REVISION'); END;`] as const),
  Object.freeze(["work_attempt_fence_monotonic", `CREATE TRIGGER IF NOT EXISTS work_attempt_fence_monotonic
BEFORE INSERT ON work_attempts
WHEN NEW.fence <= COALESCE((SELECT MAX(fence) FROM work_attempts WHERE task_id=NEW.task_id),0)
BEGIN SELECT RAISE(ABORT,'WORK_ATTEMPT_FENCE_NOT_MONOTONIC'); END;`] as const),
  Object.freeze(["work_attempt_authority_immutable", `CREATE TRIGGER IF NOT EXISTS work_attempt_authority_immutable
BEFORE UPDATE OF id,work_id,task_id,worker_session_id,account_id,project_id,preset,fast,fence,account_generation,daemon_generation,created_at ON work_attempts
BEGIN SELECT RAISE(ABORT,'WORK_ATTEMPT_AUTHORITY_IMMUTABLE'); END;`] as const),
  Object.freeze(["work_attempt_dispatch_binding_guard", `CREATE TRIGGER IF NOT EXISTS work_attempt_dispatch_binding_guard
BEFORE UPDATE OF target_session_id,dispatch_mode ON work_attempts
WHEN (OLD.target_session_id IS NOT NULL OR OLD.dispatch_mode IS NOT NULL)
  AND (NEW.target_session_id IS NOT OLD.target_session_id OR NEW.dispatch_mode IS NOT OLD.dispatch_mode)
BEGIN SELECT RAISE(ABORT,'WORK_ATTEMPT_DISPATCH_BINDING_IMMUTABLE'); END;`] as const),
  Object.freeze(["work_attempt_submission_guard", `CREATE TRIGGER IF NOT EXISTS work_attempt_submission_guard
BEFORE UPDATE OF submission_id ON work_attempts
WHEN OLD.submission_id IS NOT NULL AND NEW.submission_id IS NOT OLD.submission_id
BEGIN SELECT RAISE(ABORT,'WORK_ATTEMPT_SUBMISSION_IMMUTABLE'); END;`] as const),
  Object.freeze(["work_attempt_revision_guard", `CREATE TRIGGER IF NOT EXISTS work_attempt_revision_guard
BEFORE UPDATE ON work_attempts
WHEN NEW.revision != OLD.revision + 1
BEGIN SELECT RAISE(ABORT,'WORK_ATTEMPT_REVISION'); END;`] as const),
  Object.freeze(["work_attempt_no_delete", `CREATE TRIGGER IF NOT EXISTS work_attempt_no_delete
BEFORE DELETE ON work_attempts
WHEN NOT EXISTS (SELECT 1 FROM work_purge_authority WHERE work_id=OLD.work_id)
BEGIN SELECT RAISE(ABORT,'WORK_ATTEMPT_IMMUTABLE'); END;`] as const),
  Object.freeze(["work_attempt_state_guard", `CREATE TRIGGER IF NOT EXISTS work_attempt_state_guard
BEFORE UPDATE OF state ON work_attempts
WHEN NOT (
  OLD.state = NEW.state OR
  (OLD.state = 'claimed' AND NEW.state IN ('dispatching','failed','released','expired','cancelled')) OR
  (OLD.state = 'dispatching' AND NEW.state IN ('running','failed','recovery_required','cancelled')) OR
  (OLD.state = 'running' AND NEW.state IN ('submitted','blocked','failed','recovery_required','cancelled')) OR
  (OLD.state = 'submitted' AND NEW.state IN ('completed','failed','cancelled')) OR
  (OLD.state = 'recovery_required' AND NEW.state IN ('running','submitted','completed','failed','released','cancelled'))
)
BEGIN SELECT RAISE(ABORT,'WORK_ATTEMPT_STATE_TRANSITION'); END;`] as const),
  Object.freeze(["work_profile_attempt_authority_guard", `CREATE TRIGGER IF NOT EXISTS work_profile_attempt_authority_guard
BEFORE UPDATE OF state,process_generation ON profiles
WHEN EXISTS (
  SELECT 1 FROM work_attempts AS a
  JOIN sessions AS s ON s.id=a.worker_session_id
  WHERE a.account_id=OLD.id
    AND a.state IN ('claimed','dispatching','running')
    AND (
      NEW.process_generation!=a.account_generation
      OR (NEW.state!='signed_in' AND s.provider_v39='codex')
    )
)
BEGIN SELECT RAISE(ABORT,'WORK_PROFILE_ATTEMPT_AUTHORITY'); END;`] as const),
  Object.freeze(["work_profile_attempt_identity_guard", `CREATE TRIGGER IF NOT EXISTS work_profile_attempt_identity_guard
BEFORE UPDATE OF provider_email ON profiles
WHEN lower(trim(NEW.provider_email)) IS NOT lower(trim(OLD.provider_email)) AND EXISTS (
  SELECT 1 FROM work_attempts AS a
  WHERE a.account_id=OLD.id
    AND a.state IN ('claimed','dispatching','running')
)
BEGIN SELECT RAISE(ABORT,'WORK_PROFILE_ATTEMPT_AUTHORITY'); END;`] as const),
  Object.freeze(["work_attempt_reports_no_update", `CREATE TRIGGER IF NOT EXISTS work_attempt_reports_no_update
BEFORE UPDATE ON work_attempt_reports BEGIN SELECT RAISE(ABORT,'WORK_REPORT_IMMUTABLE'); END;`] as const),
  Object.freeze(["work_attempt_reports_no_delete", `CREATE TRIGGER IF NOT EXISTS work_attempt_reports_no_delete
BEFORE DELETE ON work_attempt_reports
WHEN NOT EXISTS (SELECT 1 FROM work_purge_authority WHERE work_id=OLD.work_id)
BEGIN SELECT RAISE(ABORT,'WORK_REPORT_IMMUTABLE'); END;`] as const),
  Object.freeze(["work_submissions_no_update", `CREATE TRIGGER IF NOT EXISTS work_submissions_no_update
BEFORE UPDATE ON work_submissions BEGIN SELECT RAISE(ABORT,'WORK_SUBMISSION_IMMUTABLE'); END;`] as const),
  Object.freeze(["work_submissions_no_delete", `CREATE TRIGGER IF NOT EXISTS work_submissions_no_delete
BEFORE DELETE ON work_submissions
WHEN NOT EXISTS (SELECT 1 FROM work_purge_authority WHERE work_id=OLD.work_id)
BEGIN SELECT RAISE(ABORT,'WORK_SUBMISSION_IMMUTABLE'); END;`] as const),
  Object.freeze(["work_reviews_no_update", `CREATE TRIGGER IF NOT EXISTS work_reviews_no_update
BEFORE UPDATE ON work_reviews BEGIN SELECT RAISE(ABORT,'WORK_REVIEW_IMMUTABLE'); END;`] as const),
  Object.freeze(["work_reviews_no_delete", `CREATE TRIGGER IF NOT EXISTS work_reviews_no_delete
BEFORE DELETE ON work_reviews
WHEN NOT EXISTS (SELECT 1 FROM work_purge_authority WHERE work_id=OLD.work_id)
BEGIN SELECT RAISE(ABORT,'WORK_REVIEW_IMMUTABLE'); END;`] as const),
  Object.freeze(["work_review_member_guard", `CREATE TRIGGER IF NOT EXISTS work_review_member_guard
BEFORE INSERT ON work_reviews
WHEN NOT EXISTS (SELECT 1 FROM work_members WHERE work_id=NEW.work_id AND session_id=NEW.reviewer_session_id)
  OR EXISTS (
    SELECT 1 FROM work_submissions AS s
    WHERE s.id=NEW.submission_id AND s.worker_session_id=NEW.reviewer_session_id
  )
BEGIN SELECT RAISE(ABORT,'WORK_REVIEWER_INVALID'); END;`] as const),
  Object.freeze(["work_signals_no_update", `CREATE TRIGGER IF NOT EXISTS work_signals_no_update
BEFORE UPDATE ON work_signals BEGIN SELECT RAISE(ABORT,'WORK_SIGNAL_IMMUTABLE'); END;`] as const),
  Object.freeze(["work_signals_no_delete", `CREATE TRIGGER IF NOT EXISTS work_signals_no_delete
BEFORE DELETE ON work_signals
WHEN NOT EXISTS (SELECT 1 FROM work_purge_authority WHERE work_id=OLD.work_id)
BEGIN SELECT RAISE(ABORT,'WORK_SIGNAL_IMMUTABLE'); END;`] as const),
  Object.freeze(["work_task_history_index_attempt", `CREATE TRIGGER IF NOT EXISTS work_task_history_index_attempt
AFTER INSERT ON work_attempts
BEGIN
  INSERT INTO work_task_history_index(work_id,task_id,kind,stable_key,created_at)
  VALUES (NEW.work_id,NEW.task_id,'attempt',NEW.id,NEW.created_at);
END;`] as const),
  Object.freeze(["work_task_history_index_attempt_report", `CREATE TRIGGER IF NOT EXISTS work_task_history_index_attempt_report
AFTER INSERT ON work_attempt_reports
BEGIN
  INSERT INTO work_task_history_index(work_id,task_id,kind,stable_key,created_at)
  SELECT NEW.work_id,a.task_id,'attempt_report',NEW.idempotency_key,NEW.created_at
  FROM work_attempts AS a
  WHERE a.work_id=NEW.work_id AND a.id=NEW.attempt_id;
END;`] as const),
  Object.freeze(["work_task_history_index_submission", `CREATE TRIGGER IF NOT EXISTS work_task_history_index_submission
AFTER INSERT ON work_submissions
BEGIN
  INSERT INTO work_task_history_index(work_id,task_id,kind,stable_key,created_at)
  VALUES (NEW.work_id,NEW.task_id,'submission',NEW.id,NEW.created_at);
END;`] as const),
  Object.freeze(["work_task_history_index_review", `CREATE TRIGGER IF NOT EXISTS work_task_history_index_review
AFTER INSERT ON work_reviews
BEGIN
  INSERT INTO work_task_history_index(work_id,task_id,kind,stable_key,created_at)
  SELECT NEW.work_id,s.task_id,'review',NEW.id,NEW.created_at
  FROM work_submissions AS s
  WHERE s.work_id=NEW.work_id AND s.id=NEW.submission_id;
END;`] as const),
  Object.freeze(["work_task_history_index_signal", `CREATE TRIGGER IF NOT EXISTS work_task_history_index_signal
AFTER INSERT ON work_signals
WHEN NEW.task_id IS NOT NULL
BEGIN
  INSERT INTO work_task_history_index(work_id,task_id,kind,stable_key,created_at)
  VALUES (NEW.work_id,NEW.task_id,'signal',NEW.id,NEW.created_at);
END;`] as const),
  Object.freeze(["work_task_history_index_no_update", `CREATE TRIGGER IF NOT EXISTS work_task_history_index_no_update
BEFORE UPDATE ON work_task_history_index
BEGIN SELECT RAISE(ABORT,'WORK_TASK_HISTORY_INDEX_IMMUTABLE'); END;`] as const),
  Object.freeze(["work_task_history_index_no_delete", `CREATE TRIGGER IF NOT EXISTS work_task_history_index_no_delete
BEFORE DELETE ON work_task_history_index
WHEN NOT EXISTS (SELECT 1 FROM work_purge_authority WHERE work_id=OLD.work_id)
BEGIN SELECT RAISE(ABORT,'WORK_TASK_HISTORY_INDEX_IMMUTABLE'); END;`] as const),
  Object.freeze(["work_task_history_versions_capacity", `CREATE TRIGGER IF NOT EXISTS work_task_history_versions_capacity
BEFORE INSERT ON work_task_history_versions
WHEN (SELECT COUNT(*) FROM work_task_history_versions WHERE work_id=NEW.work_id)
  >= 196864
BEGIN SELECT RAISE(ABORT,'WORK_TASK_HISTORY_VERSION_LIMIT'); END;`] as const),
  Object.freeze(["work_task_history_versions_no_update", `CREATE TRIGGER IF NOT EXISTS work_task_history_versions_no_update
BEFORE UPDATE ON work_task_history_versions
BEGIN SELECT RAISE(ABORT,'WORK_TASK_HISTORY_VERSION_IMMUTABLE'); END;`] as const),
  Object.freeze(["work_task_history_versions_no_delete", `CREATE TRIGGER IF NOT EXISTS work_task_history_versions_no_delete
BEFORE DELETE ON work_task_history_versions
WHEN NOT EXISTS (SELECT 1 FROM work_purge_authority WHERE work_id=OLD.work_id)
BEGIN SELECT RAISE(ABORT,'WORK_TASK_HISTORY_VERSION_IMMUTABLE'); END;`] as const),
  Object.freeze(["work_receipts_no_update", `CREATE TRIGGER IF NOT EXISTS work_receipts_no_update
BEFORE UPDATE ON work_signal_receipts BEGIN SELECT RAISE(ABORT,'WORK_SIGNAL_RECEIPT_IMMUTABLE'); END;`] as const),
  Object.freeze(["work_receipts_no_delete", `CREATE TRIGGER IF NOT EXISTS work_receipts_no_delete
BEFORE DELETE ON work_signal_receipts
WHEN NOT EXISTS (
  SELECT 1 FROM work_signals AS s
  JOIN work_purge_authority AS p ON p.work_id=s.work_id
  WHERE s.id=OLD.signal_id
)
BEGIN SELECT RAISE(ABORT,'WORK_SIGNAL_RECEIPT_IMMUTABLE'); END;`] as const),
  Object.freeze(["work_signal_ack_guard", `CREATE TRIGGER IF NOT EXISTS work_signal_ack_guard
BEFORE INSERT ON work_signal_receipts
WHEN NEW.kind='ack' AND NOT EXISTS (
  SELECT 1 FROM work_signals AS s
  WHERE s.id=NEW.signal_id AND s.to_session_id=NEW.actor_session_id
)
BEGIN SELECT RAISE(ABORT,'WORK_SIGNAL_ACK_ACTOR_INVALID'); END;`] as const),
  Object.freeze(["work_receipt_chain_guard", `CREATE TRIGGER IF NOT EXISTS work_receipt_chain_guard
BEFORE INSERT ON work_signal_receipts
WHEN NEW.sequence != COALESCE((
  SELECT MAX(sequence)+1 FROM work_signal_receipts WHERE signal_id=NEW.signal_id
),1)
BEGIN SELECT RAISE(ABORT,'WORK_SIGNAL_RECEIPT_SEQUENCE'); END;`] as const),
  Object.freeze(["work_events_no_update", `CREATE TRIGGER IF NOT EXISTS work_events_no_update
BEFORE UPDATE ON work_events BEGIN SELECT RAISE(ABORT,'WORK_EVENT_APPEND_ONLY'); END;`] as const),
  Object.freeze(["work_events_no_delete", `CREATE TRIGGER IF NOT EXISTS work_events_no_delete
BEFORE DELETE ON work_events
WHEN NOT EXISTS (SELECT 1 FROM work_purge_authority WHERE work_id=OLD.work_id)
BEGIN SELECT RAISE(ABORT,'WORK_EVENT_APPEND_ONLY'); END;`] as const),
  Object.freeze(["work_event_chain_guard", `CREATE TRIGGER IF NOT EXISTS work_event_chain_guard
BEFORE INSERT ON work_events
WHEN NEW.sequence != COALESCE((SELECT MAX(sequence)+1 FROM work_events WHERE work_id=NEW.work_id),1)
  OR NEW.previous_hash IS NOT (SELECT event_hash FROM work_events WHERE work_id=NEW.work_id ORDER BY sequence DESC LIMIT 1)
BEGIN SELECT RAISE(ABORT,'WORK_EVENT_CHAIN_INVALID'); END;`] as const),
  Object.freeze(["work_event_capacity_guard", `CREATE TRIGGER IF NOT EXISTS work_event_capacity_guard
BEFORE INSERT ON work_events
WHEN (SELECT COUNT(*) FROM work_events WHERE work_id=NEW.work_id)
   + (SELECT COALESCE(SUM(CASE state WHEN 'prepared' THEN 2 WHEN 'effect_started' THEN 1 ELSE 0 END),0)
      FROM work_prepared_effects WHERE work_id=NEW.work_id)
   + 1 > 65536
BEGIN SELECT RAISE(ABORT,'WORK_HISTORY_EVENT_LIMIT'); END;`] as const),
  Object.freeze(["work_intents_no_update", `CREATE TRIGGER IF NOT EXISTS work_intents_no_update
BEFORE UPDATE ON work_idempotency_intents BEGIN SELECT RAISE(ABORT,'WORK_INTENT_IMMUTABLE'); END;`] as const),
  Object.freeze(["work_intents_no_delete", `CREATE TRIGGER IF NOT EXISTS work_intents_no_delete
BEFORE DELETE ON work_idempotency_intents
WHEN OLD.work_id IS NULL OR NOT EXISTS (
  SELECT 1 FROM work_purge_authority WHERE work_id=OLD.work_id
)
BEGIN SELECT RAISE(ABORT,'WORK_INTENT_IMMUTABLE'); END;`] as const),
  Object.freeze(["work_terminal_requests_no_update", `CREATE TRIGGER IF NOT EXISTS work_terminal_requests_no_update
BEFORE UPDATE ON work_terminal_requests
WHEN NOT (
  OLD.state='requested' AND NEW.state='settled'
  AND OLD.settled_at IS NULL AND NEW.settled_at IS NOT NULL
  AND NEW.work_id=OLD.work_id
  AND NEW.idempotency_key=OLD.idempotency_key
  AND NEW.kind=OLD.kind
  AND NEW.actor_session_id=OLD.actor_session_id
  AND NEW.summary=OLD.summary
  AND NEW.result_json IS OLD.result_json
  AND NEW.evidence_json=OLD.evidence_json
  AND NEW.request_digest=OLD.request_digest
  AND NEW.requested_at=OLD.requested_at
)
BEGIN SELECT RAISE(ABORT,'WORK_TERMINAL_REQUEST_IMMUTABLE'); END;`] as const),
  Object.freeze(["work_terminal_requests_no_delete", `CREATE TRIGGER IF NOT EXISTS work_terminal_requests_no_delete
BEFORE DELETE ON work_terminal_requests
WHEN NOT EXISTS (SELECT 1 FROM work_purge_authority WHERE work_id=OLD.work_id)
BEGIN SELECT RAISE(ABORT,'WORK_TERMINAL_REQUEST_IMMUTABLE'); END;`] as const),
  Object.freeze(["work_effect_identity_immutable", `CREATE TRIGGER IF NOT EXISTS work_effect_identity_immutable
BEFORE UPDATE OF idempotency_key,work_id,effect_kind,subject_id,instruction_json,instruction_digest,daemon_generation,prepared_at ON work_prepared_effects
BEGIN SELECT RAISE(ABORT,'WORK_EFFECT_IDENTITY_IMMUTABLE'); END;`] as const),
  Object.freeze(["work_effect_no_delete", `CREATE TRIGGER IF NOT EXISTS work_effect_no_delete
BEFORE DELETE ON work_prepared_effects
WHEN NOT EXISTS (SELECT 1 FROM work_purge_authority WHERE work_id=OLD.work_id)
BEGIN SELECT RAISE(ABORT,'WORK_EFFECT_IMMUTABLE'); END;`] as const),
  Object.freeze(["work_effect_state_guard", `CREATE TRIGGER IF NOT EXISTS work_effect_state_guard
BEFORE UPDATE OF state ON work_prepared_effects
WHEN NOT (
  OLD.state=NEW.state
  OR (OLD.state='prepared' AND NEW.state IN ('effect_started','accepted','failed','unknown'))
  OR (OLD.state='effect_started' AND NEW.state IN ('accepted','failed','unknown'))
  OR (OLD.state='unknown' AND NEW.state IN ('accepted','failed') AND EXISTS (
    SELECT 1 FROM work_effect_resolutions AS r
    WHERE r.effect_idempotency_key=OLD.idempotency_key
      AND ((r.outcome='proven_applied' AND NEW.state='accepted')
        OR (r.outcome IN ('no_effect','failed') AND NEW.state='failed'))
  ))
  OR (OLD.state='unknown' AND NEW.state IN ('accepted','failed') AND EXISTS (
    SELECT 1 FROM work_nested_effect_settlements AS n
    WHERE n.effect_idempotency_key=OLD.idempotency_key AND n.outcome=NEW.state
  ))
)
BEGIN SELECT RAISE(ABORT,'WORK_EFFECT_STATE_TRANSITION'); END;`] as const),
  Object.freeze(["work_effect_outcome_guard", `CREATE TRIGGER IF NOT EXISTS work_effect_outcome_guard
BEFORE UPDATE OF outcome_digest,outcome_json,finalized_at ON work_prepared_effects
WHEN OLD.state NOT IN ('prepared','effect_started')
  AND NOT (OLD.state='unknown' AND NEW.state IN ('accepted','failed') AND EXISTS (
    SELECT 1 FROM work_effect_resolutions AS r
    WHERE r.effect_idempotency_key=OLD.idempotency_key
  ))
  AND NOT (OLD.state='unknown' AND NEW.state IN ('accepted','failed') AND EXISTS (
    SELECT 1 FROM work_nested_effect_settlements AS n
    WHERE n.effect_idempotency_key=OLD.idempotency_key AND n.outcome=NEW.state
  ))
  AND (
  NEW.outcome_digest IS NOT OLD.outcome_digest OR
  NEW.outcome_json IS NOT OLD.outcome_json OR
  NEW.finalized_at IS NOT OLD.finalized_at
)
BEGIN SELECT RAISE(ABORT,'WORK_EFFECT_OUTCOME_IMMUTABLE'); END;`] as const),
  Object.freeze(["work_effect_capacity_guard", `CREATE TRIGGER IF NOT EXISTS work_effect_capacity_guard
BEFORE INSERT ON work_prepared_effects
WHEN NEW.state='prepared'
 AND (SELECT COUNT(*) FROM work_events WHERE work_id=NEW.work_id)
   + (SELECT COALESCE(SUM(CASE state WHEN 'prepared' THEN 2 WHEN 'effect_started' THEN 1 ELSE 0 END),0)
      FROM work_prepared_effects WHERE work_id=NEW.work_id)
   + 3 > 65536
BEGIN SELECT RAISE(ABORT,'WORK_HISTORY_EVENT_LIMIT'); END;`] as const),
  Object.freeze(["work_effect_resolutions_insert_guard", `CREATE TRIGGER IF NOT EXISTS work_effect_resolutions_insert_guard
BEFORE INSERT ON work_effect_resolutions
WHEN NOT EXISTS (
  SELECT 1 FROM work_prepared_effects AS e
  WHERE e.idempotency_key=NEW.effect_idempotency_key
    AND e.work_id=NEW.work_id AND e.effect_kind='attempt_dispatch'
    AND e.subject_id=NEW.attempt_id AND e.instruction_digest=NEW.instruction_digest
)
BEGIN SELECT RAISE(ABORT,'WORK_EFFECT_RESOLUTION_MISMATCH'); END;`] as const),
  Object.freeze(["work_effect_resolutions_no_update", `CREATE TRIGGER IF NOT EXISTS work_effect_resolutions_no_update
BEFORE UPDATE ON work_effect_resolutions
BEGIN SELECT RAISE(ABORT,'WORK_EFFECT_RESOLUTION_IMMUTABLE'); END;`] as const),
  Object.freeze(["work_effect_resolutions_no_delete", `CREATE TRIGGER IF NOT EXISTS work_effect_resolutions_no_delete
BEFORE DELETE ON work_effect_resolutions
WHEN NOT EXISTS (SELECT 1 FROM work_purge_authority WHERE work_id=OLD.work_id)
BEGIN SELECT RAISE(ABORT,'WORK_EFFECT_RESOLUTION_IMMUTABLE'); END;`] as const),
  Object.freeze(["work_nested_effect_settlements_insert_guard", `CREATE TRIGGER IF NOT EXISTS work_nested_effect_settlements_insert_guard
BEFORE INSERT ON work_nested_effect_settlements
WHEN NOT EXISTS (
  SELECT 1 FROM work_prepared_effects AS e
  WHERE e.idempotency_key=NEW.effect_idempotency_key
    AND json_extract(e.instruction_json,'$.nestedMutationKey')=NEW.nested_mutation_key
)
BEGIN SELECT RAISE(ABORT,'WORK_NESTED_EFFECT_SETTLEMENT_MISMATCH'); END;`] as const),
  Object.freeze(["work_nested_effect_settlements_no_update", `CREATE TRIGGER IF NOT EXISTS work_nested_effect_settlements_no_update
BEFORE UPDATE ON work_nested_effect_settlements
BEGIN SELECT RAISE(ABORT,'WORK_NESTED_EFFECT_SETTLEMENT_IMMUTABLE'); END;`] as const),
  Object.freeze(["work_nested_effect_settlements_no_delete", `CREATE TRIGGER IF NOT EXISTS work_nested_effect_settlements_no_delete
BEFORE DELETE ON work_nested_effect_settlements
WHEN NOT EXISTS (
  SELECT 1 FROM work_prepared_effects AS e
  JOIN work_purge_authority AS p ON p.work_id=e.work_id
  WHERE e.idempotency_key=OLD.effect_idempotency_key
)
BEGIN SELECT RAISE(ABORT,'WORK_NESTED_EFFECT_SETTLEMENT_IMMUTABLE'); END;`] as const),
]);
