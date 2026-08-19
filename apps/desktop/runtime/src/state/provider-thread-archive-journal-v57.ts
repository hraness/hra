import type { Database } from "bun:sqlite";
import { z } from "@hra-internal/schema";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import {
  archiveRestartThreadDigest,
  type AccountRemovalAdmissionDescriptor,
  type ArchiveAdmissionAuthority,
  type ArchiveAdmissionDescriptor,
} from "../accounts/archive-admission-gate";
import { operationReceiptKeyByteLength } from "./operation-receipt-key";

export const PROVIDER_THREAD_ARCHIVE_MAX_ACTIVE_TARGETS_V57 = 64;
export const PROVIDER_THREAD_ARCHIVE_MAX_ATTEMPTS_PER_TARGET_V57 = 8;
export const PROVIDER_THREAD_ARCHIVE_MAX_CUTS_PER_ACCOUNT_V57 = 8;
export const PROVIDER_THREAD_ARCHIVE_MAX_MEMBERS_PER_CUT_V57 = 64;

const safeIntegerMaximum = 9_007_199_254_740_991;

/**
 * The v57 archive journal is deliberately independent from the v56 intent.
 * A v56 row remains a startup fence, but it is not authority for a provider
 * mutation. These four relations are the complete keyed authority for the new
 * transition and its account-generation containment cut.
 */
export const PROVIDER_THREAD_ARCHIVE_JOURNAL_V57_SQL = `
  CREATE TABLE chat_provider_thread_archive_targets_v57 (
    target_id TEXT PRIMARY KEY CHECK (
      length(target_id) BETWEEN 18 AND 96
      AND target_id GLOB 'archtarget_[A-Za-z0-9_-]*'
      AND substr(target_id, 12) NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
    pane_id TEXT NOT NULL
      REFERENCES chat_panes(pane_id) ON DELETE RESTRICT,
    purpose TEXT NOT NULL CHECK (purpose IN ('start_fresh', 'pane_archive')),
    pane_revision INTEGER NOT NULL CHECK (
      pane_revision BETWEEN 1 AND ${safeIntegerMaximum}
    ),
    queue_revision INTEGER CHECK (
      queue_revision IS NULL OR queue_revision BETWEEN 1 AND ${safeIntegerMaximum}
    ),
    pane_cas_digest TEXT NOT NULL CHECK (
      length(pane_cas_digest) = 64
      AND pane_cas_digest NOT GLOB '*[^0-9a-f]*'
    ),
    queue_cas_digest TEXT CHECK (
      queue_cas_digest IS NULL OR (
        length(queue_cas_digest) = 64
        AND queue_cas_digest NOT GLOB '*[^0-9a-f]*'
      )
    ),
    account_profile_id TEXT NOT NULL CHECK (
      length(account_profile_id) BETWEEN 1 AND 128
      AND instr(account_profile_id, char(0)) = 0
    ),
    account_profile_revision INTEGER NOT NULL CHECK (
      account_profile_revision BETWEEN 1 AND ${safeIntegerMaximum}
    ),
    thread_id TEXT NOT NULL CHECK (
      length(thread_id) BETWEEN 1 AND 512
      AND instr(thread_id, char(0)) = 0
    ),
    restart_thread_id TEXT NOT NULL CHECK (
      length(restart_thread_id) BETWEEN 1 AND 512
      AND instr(restart_thread_id, char(0)) = 0
    ),
    binding_id TEXT CHECK (
      binding_id IS NULL OR (
        length(binding_id) BETWEEN 1 AND 128
        AND instr(binding_id, char(0)) = 0
      )
    ),
    binding_key_digest TEXT CHECK (
      binding_key_digest IS NULL OR (
        length(binding_key_digest) = 64
        AND binding_key_digest NOT GLOB '*[^0-9a-f]*'
      )
    ),
    binding_revision INTEGER CHECK (
      binding_revision IS NULL
      OR binding_revision BETWEEN 1 AND ${safeIntegerMaximum}
    ),
    current_attempt_id TEXT NOT NULL CHECK (
      length(current_attempt_id) BETWEEN 19 AND 96
      AND current_attempt_id GLOB 'archattempt_[A-Za-z0-9_-]*'
      AND substr(current_attempt_id, 13) NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
    current_attempt_ordinal INTEGER NOT NULL CHECK (
      current_attempt_ordinal BETWEEN 1
        AND ${PROVIDER_THREAD_ARCHIVE_MAX_ATTEMPTS_PER_TARGET_V57}
    ),
    status TEXT NOT NULL CHECK (
      status IN ('open', 'account_contained', 'committed')
    ),
    identity_hmac TEXT NOT NULL CHECK (
      length(identity_hmac) = 64 AND identity_hmac NOT GLOB '*[^0-9a-f]*'
    ),
    pointer_hmac TEXT NOT NULL CHECK (
      length(pointer_hmac) = 64 AND pointer_hmac NOT GLOB '*[^0-9a-f]*'
    ),
    account_containment_evidence_digest TEXT CHECK (
      account_containment_evidence_digest IS NULL OR (
        length(account_containment_evidence_digest) = 64
        AND account_containment_evidence_digest NOT GLOB '*[^0-9a-f]*'
      )
    ),
    account_containment_revision_digest TEXT CHECK (
      account_containment_revision_digest IS NULL OR (
        length(account_containment_revision_digest) = 64
        AND account_containment_revision_digest NOT GLOB '*[^0-9a-f]*'
      )
    ),
    account_containment_hmac TEXT CHECK (
      account_containment_hmac IS NULL OR (
        length(account_containment_hmac) = 64
        AND account_containment_hmac NOT GLOB '*[^0-9a-f]*'
      )
    ),
    account_contained_at TEXT,
    commit_evidence_digest TEXT CHECK (
      commit_evidence_digest IS NULL OR (
        length(commit_evidence_digest) = 64
        AND commit_evidence_digest NOT GLOB '*[^0-9a-f]*'
      )
    ),
    commit_revision_digest TEXT CHECK (
      commit_revision_digest IS NULL OR (
        length(commit_revision_digest) = 64
        AND commit_revision_digest NOT GLOB '*[^0-9a-f]*'
      )
    ),
    commit_hmac TEXT CHECK (
      commit_hmac IS NULL OR (
        length(commit_hmac) = 64 AND commit_hmac NOT GLOB '*[^0-9a-f]*'
      )
    ),
    created_at TEXT NOT NULL,
    committed_at TEXT,
    CHECK (
      (purpose = 'start_fresh'
        AND queue_revision IS NOT NULL AND queue_cas_digest IS NOT NULL)
      OR (purpose = 'pane_archive'
        AND queue_revision IS NULL AND queue_cas_digest IS NULL)
    ),
    CHECK (
      (binding_id IS NULL AND binding_key_digest IS NULL
        AND binding_revision IS NULL)
      OR (binding_id IS NOT NULL AND binding_key_digest IS NOT NULL
        AND binding_revision IS NOT NULL)
    ),
    CHECK (
      (status = 'open' AND account_containment_evidence_digest IS NULL
        AND account_containment_revision_digest IS NULL
        AND account_containment_hmac IS NULL AND account_contained_at IS NULL)
      OR (status IN ('account_contained', 'committed')
        AND account_containment_evidence_digest IS NOT NULL
        AND account_containment_revision_digest IS NOT NULL
        AND account_containment_hmac IS NOT NULL
        AND account_contained_at IS NOT NULL)
      OR (status = 'committed' AND account_containment_evidence_digest IS NULL
        AND account_containment_revision_digest IS NULL
        AND account_containment_hmac IS NULL AND account_contained_at IS NULL)
    ),
    CHECK (
      (status IN ('open', 'account_contained') AND commit_evidence_digest IS NULL
        AND commit_revision_digest IS NULL AND commit_hmac IS NULL
        AND committed_at IS NULL)
      OR (status = 'committed' AND commit_evidence_digest IS NOT NULL
        AND commit_revision_digest IS NOT NULL AND commit_hmac IS NOT NULL
        AND committed_at IS NOT NULL)
    ),
    FOREIGN KEY (target_id, current_attempt_id, current_attempt_ordinal)
      REFERENCES chat_provider_thread_archive_attempts_v57(
        target_id, attempt_id, ordinal
      ) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED
  ) STRICT;

  CREATE UNIQUE INDEX chat_provider_thread_archive_one_open_target_v57
    ON chat_provider_thread_archive_targets_v57(pane_id)
    WHERE status != 'committed';

  CREATE TABLE chat_provider_thread_archive_attempts_v57 (
    attempt_id TEXT PRIMARY KEY CHECK (
      length(attempt_id) BETWEEN 19 AND 96
      AND attempt_id GLOB 'archattempt_[A-Za-z0-9_-]*'
      AND substr(attempt_id, 13) NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
    target_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL CHECK (
      ordinal BETWEEN 1 AND ${PROVIDER_THREAD_ARCHIVE_MAX_ATTEMPTS_PER_TARGET_V57}
    ),
    generation INTEGER NOT NULL CHECK (
      generation BETWEEN 1 AND ${safeIntegerMaximum}
    ),
    account_profile_revision INTEGER NOT NULL CHECK (
      account_profile_revision BETWEEN 1 AND ${safeIntegerMaximum}
    ),
    predecessor_attempt_id TEXT,
    cut_id TEXT,
    state TEXT NOT NULL CHECK (state IN (
      'prepared', 'effect_started', 'ambiguous', 'direct_applied',
      'reconciled_applied', 'reconciled_not_applied',
      'abandoned_pre_effect', 'account_contained'
    )),
    request_evidence_digest TEXT NOT NULL CHECK (
      length(request_evidence_digest) = 64
      AND request_evidence_digest NOT GLOB '*[^0-9a-f]*'
    ),
    request_revision_digest TEXT NOT NULL CHECK (
      length(request_revision_digest) = 64
      AND request_revision_digest NOT GLOB '*[^0-9a-f]*'
    ),
    identity_hmac TEXT NOT NULL CHECK (
      length(identity_hmac) = 64 AND identity_hmac NOT GLOB '*[^0-9a-f]*'
    ),
    cut_binding_hmac TEXT CHECK (
      cut_binding_hmac IS NULL OR (
        length(cut_binding_hmac) = 64
        AND cut_binding_hmac NOT GLOB '*[^0-9a-f]*'
      )
    ),
    effect_evidence_digest TEXT CHECK (
      effect_evidence_digest IS NULL OR (
        length(effect_evidence_digest) = 64
        AND effect_evidence_digest NOT GLOB '*[^0-9a-f]*'
      )
    ),
    effect_revision_digest TEXT CHECK (
      effect_revision_digest IS NULL OR (
        length(effect_revision_digest) = 64
        AND effect_revision_digest NOT GLOB '*[^0-9a-f]*'
      )
    ),
    effect_started_at TEXT,
    effect_hmac TEXT CHECK (
      effect_hmac IS NULL OR (
        length(effect_hmac) = 64 AND effect_hmac NOT GLOB '*[^0-9a-f]*'
      )
    ),
    ambiguity_evidence_digest TEXT CHECK (
      ambiguity_evidence_digest IS NULL OR (
        length(ambiguity_evidence_digest) = 64
        AND ambiguity_evidence_digest NOT GLOB '*[^0-9a-f]*'
      )
    ),
    ambiguity_revision_digest TEXT CHECK (
      ambiguity_revision_digest IS NULL OR (
        length(ambiguity_revision_digest) = 64
        AND ambiguity_revision_digest NOT GLOB '*[^0-9a-f]*'
      )
    ),
    ambiguous_at TEXT,
    ambiguity_hmac TEXT CHECK (
      ambiguity_hmac IS NULL OR (
        length(ambiguity_hmac) = 64 AND ambiguity_hmac NOT GLOB '*[^0-9a-f]*'
      )
    ),
    outcome_evidence_digest TEXT CHECK (
      outcome_evidence_digest IS NULL OR (
        length(outcome_evidence_digest) = 64
        AND outcome_evidence_digest NOT GLOB '*[^0-9a-f]*'
      )
    ),
    outcome_revision_digest TEXT CHECK (
      outcome_revision_digest IS NULL OR (
        length(outcome_revision_digest) = 64
        AND outcome_revision_digest NOT GLOB '*[^0-9a-f]*'
      )
    ),
    response_generation INTEGER CHECK (
      response_generation IS NULL OR response_generation BETWEEN 1 AND ${safeIntegerMaximum}
    ),
    response_stream_position INTEGER CHECK (
      response_stream_position IS NULL
      OR response_stream_position BETWEEN 0 AND ${safeIntegerMaximum}
    ),
    outcome_at TEXT,
    outcome_hmac TEXT CHECK (
      outcome_hmac IS NULL OR (
        length(outcome_hmac) = 64 AND outcome_hmac NOT GLOB '*[^0-9a-f]*'
      )
    ),
    account_containment_prior_state TEXT CHECK (
      account_containment_prior_state IS NULL OR
      account_containment_prior_state IN (
        'prepared', 'effect_started', 'ambiguous', 'direct_applied',
        'reconciled_applied', 'reconciled_not_applied', 'abandoned_pre_effect'
      )
    ),
    account_containment_evidence_digest TEXT CHECK (
      account_containment_evidence_digest IS NULL OR (
        length(account_containment_evidence_digest) = 64
        AND account_containment_evidence_digest NOT GLOB '*[^0-9a-f]*'
      )
    ),
    account_containment_revision_digest TEXT CHECK (
      account_containment_revision_digest IS NULL OR (
        length(account_containment_revision_digest) = 64
        AND account_containment_revision_digest NOT GLOB '*[^0-9a-f]*'
      )
    ),
    account_contained_at TEXT,
    account_containment_hmac TEXT CHECK (
      account_containment_hmac IS NULL OR (
        length(account_containment_hmac) = 64
        AND account_containment_hmac NOT GLOB '*[^0-9a-f]*'
      )
    ),
    created_at TEXT NOT NULL,
    UNIQUE (target_id, ordinal),
    UNIQUE (target_id, attempt_id, ordinal),
    FOREIGN KEY (target_id)
      REFERENCES chat_provider_thread_archive_targets_v57(target_id)
      ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY (predecessor_attempt_id)
      REFERENCES chat_provider_thread_archive_attempts_v57(attempt_id)
      ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY (cut_id)
      REFERENCES chat_provider_thread_archive_cuts_v57(cut_id)
      ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
    CHECK (
      (ordinal = 1 AND predecessor_attempt_id IS NULL)
      OR (ordinal > 1 AND predecessor_attempt_id IS NOT NULL)
    ),
    CHECK ((cut_id IS NULL) = (cut_binding_hmac IS NULL)),
    CHECK (
      (effect_evidence_digest IS NULL AND effect_revision_digest IS NULL
        AND effect_started_at IS NULL AND effect_hmac IS NULL)
      OR (effect_evidence_digest IS NOT NULL AND effect_revision_digest IS NOT NULL
        AND effect_started_at IS NOT NULL AND effect_hmac IS NOT NULL)
    ),
    CHECK (
      state NOT IN ('effect_started', 'ambiguous', 'direct_applied', 'reconciled_applied')
      OR effect_hmac IS NOT NULL
    ),
    CHECK (
      (ambiguity_evidence_digest IS NULL
        AND ambiguity_revision_digest IS NULL AND ambiguous_at IS NULL
        AND ambiguity_hmac IS NULL)
      OR (ambiguity_evidence_digest IS NOT NULL
        AND ambiguity_revision_digest IS NOT NULL AND ambiguous_at IS NOT NULL
        AND ambiguity_hmac IS NOT NULL)
    ),
    CHECK (
      state NOT IN ('ambiguous', 'reconciled_applied')
      OR (cut_id IS NOT NULL AND ambiguity_hmac IS NOT NULL)
    ),
    CHECK (
      state NOT IN ('prepared', 'effect_started', 'direct_applied')
      OR ambiguity_hmac IS NULL
    ),
    CHECK (
      (state IN (
        'direct_applied', 'reconciled_applied', 'reconciled_not_applied',
        'abandoned_pre_effect'
      )
        AND outcome_evidence_digest IS NOT NULL
        AND outcome_revision_digest IS NOT NULL
        AND outcome_at IS NOT NULL AND outcome_hmac IS NOT NULL)
      OR (state NOT IN (
        'direct_applied', 'reconciled_applied', 'reconciled_not_applied',
        'abandoned_pre_effect'
      )
        AND state != 'account_contained'
        AND outcome_evidence_digest IS NULL
        AND outcome_revision_digest IS NULL
        AND response_generation IS NULL AND response_stream_position IS NULL
        AND outcome_at IS NULL AND outcome_hmac IS NULL)
      OR (state = 'account_contained' AND (
        (account_containment_prior_state IN (
          'direct_applied', 'reconciled_applied', 'reconciled_not_applied',
          'abandoned_pre_effect'
        ) AND outcome_evidence_digest IS NOT NULL
          AND outcome_revision_digest IS NOT NULL
          AND outcome_at IS NOT NULL AND outcome_hmac IS NOT NULL)
        OR (account_containment_prior_state IN (
          'prepared', 'effect_started', 'ambiguous'
        ) AND outcome_evidence_digest IS NULL
          AND outcome_revision_digest IS NULL
          AND response_generation IS NULL AND response_stream_position IS NULL
          AND outcome_at IS NULL AND outcome_hmac IS NULL)
      ))
    ),
    CHECK ((response_generation IS NULL) = (response_stream_position IS NULL)),
    CHECK (
      state != 'account_contained'
      OR (
        account_containment_prior_state IS NOT NULL
        AND account_containment_evidence_digest IS NOT NULL
        AND account_containment_revision_digest IS NOT NULL
        AND account_contained_at IS NOT NULL
        AND account_containment_hmac IS NOT NULL
      )
    ),
    CHECK (
      state != 'account_contained'
      OR account_containment_prior_state IN ('prepared', 'abandoned_pre_effect')
      OR effect_hmac IS NOT NULL
    ),
    CHECK (
      state != 'account_contained'
      OR account_containment_prior_state NOT IN (
        'ambiguous', 'reconciled_applied', 'reconciled_not_applied'
      )
      OR ambiguity_hmac IS NOT NULL
    ),
    CHECK (
      state = 'account_contained'
      OR (
        account_containment_prior_state IS NULL
        AND account_containment_evidence_digest IS NULL
        AND account_containment_revision_digest IS NULL
        AND account_contained_at IS NULL
        AND account_containment_hmac IS NULL
      )
    ),
    CHECK (state != 'abandoned_pre_effect' OR effect_hmac IS NULL)
    ,CHECK (
      state NOT IN ('reconciled_applied', 'reconciled_not_applied', 'account_contained')
      OR cut_id IS NOT NULL
    )
  ) STRICT;

  CREATE TABLE chat_provider_thread_archive_cuts_v57 (
    cut_id TEXT PRIMARY KEY CHECK (
      length(cut_id) BETWEEN 15 AND 96
      AND cut_id GLOB 'archcut_[A-Za-z0-9_-]*'
      AND substr(cut_id, 9) NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
    account_profile_id TEXT NOT NULL CHECK (
      length(account_profile_id) BETWEEN 1 AND 128
      AND instr(account_profile_id, char(0)) = 0
    ),
    account_profile_revision INTEGER NOT NULL CHECK (
      account_profile_revision BETWEEN 1 AND ${safeIntegerMaximum}
    ),
    source_generation INTEGER NOT NULL CHECK (
      source_generation BETWEEN 1 AND ${safeIntegerMaximum}
    ),
    cause TEXT NOT NULL CHECK (
      cause IN ('ambiguous_response', 'lost_response', 'account_removal')
    ),
    initiating_attempt_id TEXT,
    target_count INTEGER NOT NULL CHECK (
      target_count BETWEEN 0 AND ${PROVIDER_THREAD_ARCHIVE_MAX_ACTIVE_TARGETS_V57}
    ),
    target_inventory_digest TEXT NOT NULL CHECK (
      length(target_inventory_digest) = 64
      AND target_inventory_digest NOT GLOB '*[^0-9a-f]*'
    ),
    predecessor_cut_id TEXT,
    state TEXT NOT NULL CHECK (state IN (
      'fence_started', 'fenced', 'sealed',
      'removal_awaiting_tombstone', 'contained'
    )),
    identity_evidence_digest TEXT NOT NULL CHECK (
      length(identity_evidence_digest) = 64
      AND identity_evidence_digest NOT GLOB '*[^0-9a-f]*'
    ),
    identity_revision_digest TEXT NOT NULL CHECK (
      length(identity_revision_digest) = 64
      AND identity_revision_digest NOT GLOB '*[^0-9a-f]*'
    ),
    identity_hmac TEXT NOT NULL CHECK (
      length(identity_hmac) = 64 AND identity_hmac NOT GLOB '*[^0-9a-f]*'
    ),
    successor_generation INTEGER CHECK (
      successor_generation IS NULL
      OR successor_generation BETWEEN 1 AND ${safeIntegerMaximum}
    ),
    successor_account_profile_revision INTEGER CHECK (
      successor_account_profile_revision IS NULL
      OR successor_account_profile_revision BETWEEN 1 AND ${safeIntegerMaximum}
    ),
    fence_evidence_digest TEXT CHECK (
      fence_evidence_digest IS NULL OR (
        length(fence_evidence_digest) = 64
        AND fence_evidence_digest NOT GLOB '*[^0-9a-f]*'
      )
    ),
    fence_revision_digest TEXT CHECK (
      fence_revision_digest IS NULL OR (
        length(fence_revision_digest) = 64
        AND fence_revision_digest NOT GLOB '*[^0-9a-f]*'
      )
    ),
    fenced_at TEXT,
    fence_hmac TEXT CHECK (
      fence_hmac IS NULL OR (
        length(fence_hmac) = 64 AND fence_hmac NOT GLOB '*[^0-9a-f]*'
      )
    ),
    member_count INTEGER CHECK (
      member_count IS NULL OR member_count BETWEEN 0
        AND ${PROVIDER_THREAD_ARCHIVE_MAX_MEMBERS_PER_CUT_V57}
    ),
    inventory_digest TEXT CHECK (
      inventory_digest IS NULL OR (
        length(inventory_digest) = 64
        AND inventory_digest NOT GLOB '*[^0-9a-f]*'
      )
    ),
    enumeration_authority_digest TEXT CHECK (
      enumeration_authority_digest IS NULL OR (
        length(enumeration_authority_digest) = 64
        AND enumeration_authority_digest NOT GLOB '*[^0-9a-f]*'
      )
    ),
    seal_revision_digest TEXT CHECK (
      seal_revision_digest IS NULL OR (
        length(seal_revision_digest) = 64
        AND seal_revision_digest NOT GLOB '*[^0-9a-f]*'
      )
    ),
    sealed_at TEXT,
    seal_hmac TEXT CHECK (
      seal_hmac IS NULL OR (
        length(seal_hmac) = 64 AND seal_hmac NOT GLOB '*[^0-9a-f]*'
      )
    ),
    settlement_inventory_digest TEXT CHECK (
      settlement_inventory_digest IS NULL OR (
        length(settlement_inventory_digest) = 64
        AND settlement_inventory_digest NOT GLOB '*[^0-9a-f]*'
      )
    ),
    containment_evidence_digest TEXT CHECK (
      containment_evidence_digest IS NULL OR (
        length(containment_evidence_digest) = 64
        AND containment_evidence_digest NOT GLOB '*[^0-9a-f]*'
      )
    ),
    containment_revision_digest TEXT CHECK (
      containment_revision_digest IS NULL OR (
        length(containment_revision_digest) = 64
        AND containment_revision_digest NOT GLOB '*[^0-9a-f]*'
      )
    ),
    contained_at TEXT,
    containment_hmac TEXT CHECK (
      containment_hmac IS NULL OR (
        length(containment_hmac) = 64
        AND containment_hmac NOT GLOB '*[^0-9a-f]*'
      )
    ),
    tombstone_evidence_digest TEXT CHECK (
      tombstone_evidence_digest IS NULL OR (
        length(tombstone_evidence_digest) = 64
        AND tombstone_evidence_digest NOT GLOB '*[^0-9a-f]*'
      )
    ),
    tombstone_revision_digest TEXT CHECK (
      tombstone_revision_digest IS NULL OR (
        length(tombstone_revision_digest) = 64
        AND tombstone_revision_digest NOT GLOB '*[^0-9a-f]*'
      )
    ),
    tombstone_account_profile_revision INTEGER CHECK (
      tombstone_account_profile_revision IS NULL
      OR tombstone_account_profile_revision BETWEEN 1 AND ${safeIntegerMaximum}
    ),
    tombstone_removed_at TEXT,
    tombstone_local_data_deleted_at TEXT,
    tombstone_profile_preimage_digest TEXT CHECK (
      tombstone_profile_preimage_digest IS NULL OR (
        length(tombstone_profile_preimage_digest) = 64
        AND tombstone_profile_preimage_digest NOT GLOB '*[^0-9a-f]*'
      )
    ),
    tombstoned_at TEXT,
    tombstone_hmac TEXT CHECK (
      tombstone_hmac IS NULL OR (
        length(tombstone_hmac) = 64
        AND tombstone_hmac NOT GLOB '*[^0-9a-f]*'
      )
    ),
    created_at TEXT NOT NULL,
    FOREIGN KEY (predecessor_cut_id)
      REFERENCES chat_provider_thread_archive_cuts_v57(cut_id)
      ON DELETE RESTRICT,
    CHECK (
      (cause = 'account_removal' AND initiating_attempt_id IS NULL)
      OR (cause IN ('ambiguous_response', 'lost_response')
        AND initiating_attempt_id IS NOT NULL AND target_count > 0)
    ),
    CHECK (
      (state = 'fence_started' AND successor_generation IS NULL
        AND successor_account_profile_revision IS NULL
        AND fence_evidence_digest IS NULL AND fence_revision_digest IS NULL
        AND fenced_at IS NULL AND fence_hmac IS NULL)
      OR (state != 'fence_started'
        AND (
          (cause = 'account_removal' AND successor_generation IS NULL
            AND successor_account_profile_revision IS NULL)
          OR (cause != 'account_removal' AND successor_generation IS NOT NULL
            AND successor_account_profile_revision IS NOT NULL
            AND successor_generation = source_generation + 1)
        )
        AND fence_evidence_digest IS NOT NULL AND fence_revision_digest IS NOT NULL
        AND fenced_at IS NOT NULL AND fence_hmac IS NOT NULL)
    ),
    CHECK (
      (state IN ('sealed', 'removal_awaiting_tombstone', 'contained')
        AND member_count IS NOT NULL
        AND inventory_digest IS NOT NULL
        AND enumeration_authority_digest IS NOT NULL
        AND seal_revision_digest IS NOT NULL
        AND sealed_at IS NOT NULL AND seal_hmac IS NOT NULL)
      OR (state NOT IN ('sealed', 'removal_awaiting_tombstone', 'contained')
        AND member_count IS NULL
        AND inventory_digest IS NULL
        AND enumeration_authority_digest IS NULL
        AND seal_revision_digest IS NULL
        AND sealed_at IS NULL AND seal_hmac IS NULL)
    ),
    CHECK (
      (state IN ('removal_awaiting_tombstone', 'contained')
        AND settlement_inventory_digest IS NOT NULL
        AND containment_evidence_digest IS NOT NULL
        AND containment_revision_digest IS NOT NULL
        AND contained_at IS NOT NULL AND containment_hmac IS NOT NULL)
      OR (state NOT IN ('removal_awaiting_tombstone', 'contained')
        AND settlement_inventory_digest IS NULL
        AND containment_evidence_digest IS NULL
        AND containment_revision_digest IS NULL
        AND contained_at IS NULL AND containment_hmac IS NULL)
    ),
    CHECK (
      (cause = 'account_removal' AND state = 'contained'
        AND tombstone_evidence_digest IS NOT NULL
        AND tombstone_revision_digest IS NOT NULL
        AND tombstone_account_profile_revision IS NOT NULL
        AND tombstone_removed_at IS NOT NULL
        AND tombstone_profile_preimage_digest IS NOT NULL
        AND tombstoned_at IS NOT NULL AND tombstone_hmac IS NOT NULL)
      OR ((cause != 'account_removal' OR state != 'contained')
        AND tombstone_evidence_digest IS NULL
        AND tombstone_revision_digest IS NULL
        AND tombstone_account_profile_revision IS NULL
        AND tombstone_removed_at IS NULL
        AND tombstone_local_data_deleted_at IS NULL
        AND tombstone_profile_preimage_digest IS NULL
        AND tombstoned_at IS NULL AND tombstone_hmac IS NULL)
    )
  ) STRICT;

  CREATE UNIQUE INDEX chat_provider_thread_archive_one_active_cut_v57
    ON chat_provider_thread_archive_cuts_v57(account_profile_id)
    WHERE state IN (
      'fence_started', 'fenced', 'sealed', 'removal_awaiting_tombstone'
    );

  CREATE TABLE chat_provider_thread_archive_cut_members_v57 (
    member_id TEXT PRIMARY KEY CHECK (
      length(member_id) BETWEEN 18 AND 96
      AND member_id GLOB 'archmember_[A-Za-z0-9_-]*'
      AND substr(member_id, 12) NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
    cut_id TEXT NOT NULL
      REFERENCES chat_provider_thread_archive_cuts_v57(cut_id)
      ON DELETE CASCADE,
    ordinal INTEGER NOT NULL CHECK (
      ordinal BETWEEN 1 AND ${PROVIDER_THREAD_ARCHIVE_MAX_MEMBERS_PER_CUT_V57}
    ),
    pane_id TEXT NOT NULL CHECK (
      length(pane_id) BETWEEN 12 AND 96
      AND pane_id GLOB 'pane_[A-Za-z0-9_-]*'
      AND substr(pane_id, 6) NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
    pane_revision INTEGER NOT NULL CHECK (
      pane_revision BETWEEN 1 AND ${safeIntegerMaximum}
    ),
    pane_cas_digest TEXT NOT NULL CHECK (
      length(pane_cas_digest) = 64
      AND pane_cas_digest NOT GLOB '*[^0-9a-f]*'
    ),
    thread_id TEXT NOT NULL CHECK (
      length(thread_id) BETWEEN 1 AND 512
      AND instr(thread_id, char(0)) = 0
    ),
    restart_thread_id TEXT NOT NULL CHECK (
      length(restart_thread_id) BETWEEN 1 AND 512
      AND instr(restart_thread_id, char(0)) = 0
    ),
    role TEXT NOT NULL CHECK (role IN ('target', 'sibling')),
    target_id TEXT,
    attempt_id TEXT,
    target_attempt_ordinal INTEGER CHECK (
      target_attempt_ordinal IS NULL OR target_attempt_ordinal BETWEEN 1
        AND ${PROVIDER_THREAD_ARCHIVE_MAX_ATTEMPTS_PER_TARGET_V57}
    ),
    action TEXT NOT NULL CHECK (
      action IN (
        'preserved_target', 'contain_generation_context', 'detach_binding_only'
      )
    ),
    binding_id TEXT CHECK (
      binding_id IS NULL OR (
        length(binding_id) BETWEEN 1 AND 128
        AND instr(binding_id, char(0)) = 0
      )
    ),
    binding_key_digest TEXT CHECK (
      binding_key_digest IS NULL OR (
        length(binding_key_digest) = 64
        AND binding_key_digest NOT GLOB '*[^0-9a-f]*'
      )
    ),
    binding_revision INTEGER CHECK (
      binding_revision IS NULL
      OR binding_revision BETWEEN 1 AND ${safeIntegerMaximum}
    ),
    identity_evidence_digest TEXT NOT NULL CHECK (
      length(identity_evidence_digest) = 64
      AND identity_evidence_digest NOT GLOB '*[^0-9a-f]*'
    ),
    identity_revision_digest TEXT NOT NULL CHECK (
      length(identity_revision_digest) = 64
      AND identity_revision_digest NOT GLOB '*[^0-9a-f]*'
    ),
    identity_hmac TEXT NOT NULL CHECK (
      length(identity_hmac) = 64 AND identity_hmac NOT GLOB '*[^0-9a-f]*'
    ),
    state TEXT NOT NULL CHECK (state IN ('pending', 'settled')),
    settlement_evidence_digest TEXT CHECK (
      settlement_evidence_digest IS NULL OR (
        length(settlement_evidence_digest) = 64
        AND settlement_evidence_digest NOT GLOB '*[^0-9a-f]*'
      )
    ),
    settlement_revision_digest TEXT CHECK (
      settlement_revision_digest IS NULL OR (
        length(settlement_revision_digest) = 64
        AND settlement_revision_digest NOT GLOB '*[^0-9a-f]*'
      )
    ),
    settled_at TEXT,
    settlement_hmac TEXT CHECK (
      settlement_hmac IS NULL OR (
        length(settlement_hmac) = 64
        AND settlement_hmac NOT GLOB '*[^0-9a-f]*'
      )
    ),
    created_at TEXT NOT NULL,
    UNIQUE (cut_id, ordinal),
    UNIQUE (cut_id, pane_id),
    CHECK (
      (role = 'target' AND action IN (
        'preserved_target', 'contain_generation_context'
      ))
      OR (role = 'sibling' AND action IN (
        'contain_generation_context', 'detach_binding_only'
      ))
    ),
    CHECK (
      (role = 'target' AND target_id IS NOT NULL AND attempt_id IS NOT NULL
        AND target_attempt_ordinal IS NOT NULL)
      OR (role = 'sibling' AND target_id IS NULL AND attempt_id IS NULL
        AND target_attempt_ordinal IS NULL)
    ),
    CHECK (
      (binding_id IS NULL AND binding_key_digest IS NULL
        AND binding_revision IS NULL)
      OR (binding_id IS NOT NULL AND binding_key_digest IS NOT NULL
        AND binding_revision IS NOT NULL)
    ),
    CHECK (
      (state = 'pending' AND settlement_evidence_digest IS NULL
        AND settlement_revision_digest IS NULL
        AND settled_at IS NULL AND settlement_hmac IS NULL)
      OR (state = 'settled' AND settlement_evidence_digest IS NOT NULL
        AND settlement_revision_digest IS NOT NULL
        AND settled_at IS NOT NULL AND settlement_hmac IS NOT NULL)
    )
  ) STRICT;

  CREATE TRIGGER chat_provider_thread_archive_target_quota_v57
  BEFORE INSERT ON chat_provider_thread_archive_targets_v57
  WHEN (
    SELECT COUNT(*) FROM chat_provider_thread_archive_targets_v57
    WHERE status != 'committed'
  ) >= ${PROVIDER_THREAD_ARCHIVE_MAX_ACTIVE_TARGETS_V57}
  BEGIN
    SELECT RAISE(ABORT, 'provider thread archive active target limit reached');
  END;

  CREATE TRIGGER chat_provider_thread_archive_target_preimage_guard_v57
  BEFORE INSERT ON chat_provider_thread_archive_targets_v57
  WHEN NOT (
    NEW.status = 'open'
    AND EXISTS (
      SELECT 1 FROM chat_panes AS pane
      WHERE pane.pane_id = NEW.pane_id
        AND pane.archived_at IS NULL
        AND pane.revision = NEW.pane_revision
        AND (
          NEW.queue_revision IS NULL
          OR pane.message_queue_revision = NEW.queue_revision
        )
        AND pane.provider_account_profile_id = NEW.account_profile_id
        AND pane.provider_thread_id = NEW.thread_id
        AND pane.provider_restart_thread_id = NEW.restart_thread_id
    )
    AND NOT EXISTS (
      SELECT 1 FROM chat_provider_thread_archive_cuts_v57 AS cut
      WHERE cut.account_profile_id = NEW.account_profile_id
        AND cut.state IN (
          'fence_started', 'fenced', 'sealed', 'removal_awaiting_tombstone'
        )
    )
    AND EXISTS (
      SELECT 1 FROM account_profiles AS account
      WHERE account.profile_id = NEW.account_profile_id
        AND account.revision = NEW.account_profile_revision
        AND account.removed_at IS NULL
    )
    AND (
      (NEW.binding_id IS NULL AND (
        SELECT COUNT(*) FROM chat_provider_attachment_bindings AS binding
        WHERE binding.pane_id = NEW.pane_id
          AND binding.state IN ('active', 'ambiguous')
      ) = 0)
      OR (NEW.binding_id IS NOT NULL AND (
        SELECT COUNT(*) FROM chat_provider_attachment_bindings AS binding
        WHERE binding.pane_id = NEW.pane_id
          AND binding.state IN ('active', 'ambiguous')
          AND binding.binding_id = NEW.binding_id
          AND binding.binding_key_digest = NEW.binding_key_digest
          AND binding.revision = NEW.binding_revision
      ) = 1 AND (
        SELECT COUNT(*) FROM chat_provider_attachment_bindings AS binding
        WHERE binding.pane_id = NEW.pane_id
          AND binding.state IN ('active', 'ambiguous')
      ) = 1)
    )
  )
  BEGIN
    SELECT RAISE(ABORT, 'provider thread archive target preimage is stale');
  END;

  CREATE TRIGGER chat_provider_thread_archive_target_identity_immutable_v57
  BEFORE UPDATE OF target_id, pane_id, purpose, pane_revision, queue_revision,
    pane_cas_digest, queue_cas_digest, account_profile_id, thread_id,
    account_profile_revision, restart_thread_id,
    binding_id, binding_key_digest, binding_revision,
    identity_hmac, created_at
  ON chat_provider_thread_archive_targets_v57
  BEGIN
    SELECT RAISE(ABORT, 'provider thread archive target identity is immutable');
  END;

  CREATE TRIGGER chat_provider_thread_archive_target_pointer_guard_v57
  BEFORE UPDATE OF current_attempt_id, current_attempt_ordinal, pointer_hmac
  ON chat_provider_thread_archive_targets_v57
  WHEN NOT (
    OLD.status = 'open' AND NEW.status = 'open'
    AND NEW.current_attempt_ordinal = OLD.current_attempt_ordinal + 1
    AND NEW.current_attempt_id IS NOT OLD.current_attempt_id
    AND EXISTS (
      SELECT 1 FROM chat_provider_thread_archive_attempts_v57 AS prior
      WHERE prior.target_id = OLD.target_id
        AND prior.attempt_id = OLD.current_attempt_id
        AND prior.ordinal = OLD.current_attempt_ordinal
        AND prior.state IN ('reconciled_not_applied', 'abandoned_pre_effect')
    )
  )
  BEGIN
    SELECT RAISE(ABORT, 'invalid provider thread archive target pointer advance');
  END;

  CREATE TRIGGER chat_provider_thread_archive_target_commit_guard_v57
  BEFORE UPDATE OF status, commit_evidence_digest, commit_revision_digest,
    commit_hmac, committed_at
  ON chat_provider_thread_archive_targets_v57
  WHEN NEW.status = 'committed' AND NOT (
    OLD.status IN ('open', 'account_contained') AND NEW.status = 'committed'
    AND EXISTS (
      SELECT 1 FROM chat_provider_thread_archive_attempts_v57 AS attempt
      WHERE attempt.target_id = OLD.target_id
        AND attempt.attempt_id = OLD.current_attempt_id
        AND attempt.ordinal = OLD.current_attempt_ordinal
        AND (
          (attempt.state IN ('direct_applied', 'reconciled_applied')
            AND (
              attempt.cut_id IS NULL
              OR EXISTS (
                SELECT 1 FROM chat_provider_thread_archive_cuts_v57 AS applied_cut
                WHERE applied_cut.cut_id = attempt.cut_id
                  AND applied_cut.state = 'contained'
              )
            ))
          OR (attempt.state = 'account_contained' AND EXISTS (
            SELECT 1 FROM chat_provider_thread_archive_cuts_v57 AS cut
            WHERE cut.cut_id = attempt.cut_id AND cut.state = 'contained'
          ))
        )
    )
  )
  BEGIN
    SELECT RAISE(ABORT, 'provider thread archive target is not committable');
  END;

  CREATE TRIGGER chat_provider_thread_archive_target_account_containment_guard_v57
  BEFORE UPDATE OF status
  ON chat_provider_thread_archive_targets_v57
  WHEN NEW.status = 'account_contained' AND NOT (
    OLD.status = 'open' AND NEW.status = 'account_contained'
    AND EXISTS (
      SELECT 1 FROM chat_provider_thread_archive_attempts_v57 AS attempt
      JOIN chat_provider_thread_archive_cuts_v57 AS cut
        ON cut.cut_id = attempt.cut_id
      WHERE attempt.target_id = OLD.target_id
        AND attempt.attempt_id = OLD.current_attempt_id
        AND attempt.ordinal = OLD.current_attempt_ordinal
        AND attempt.state = 'account_contained'
        AND cut.cause = 'account_removal'
        AND cut.state = 'removal_awaiting_tombstone'
    )
  )
  BEGIN
    SELECT RAISE(ABORT, 'provider thread archive target is not account-contained');
  END;

  CREATE TRIGGER chat_provider_thread_archive_target_account_evidence_guard_v57
  BEFORE UPDATE OF account_containment_evidence_digest,
    account_containment_revision_digest, account_containment_hmac,
    account_contained_at
  ON chat_provider_thread_archive_targets_v57
  WHEN NOT (
    OLD.status = 'open' AND NEW.status = 'account_contained'
    AND EXISTS (
      SELECT 1 FROM chat_provider_thread_archive_attempts_v57 AS attempt
      JOIN chat_provider_thread_archive_cuts_v57 AS cut
        ON cut.cut_id = attempt.cut_id
      WHERE attempt.target_id = OLD.target_id
        AND attempt.attempt_id = OLD.current_attempt_id
        AND attempt.ordinal = OLD.current_attempt_ordinal
        AND attempt.state = 'account_contained'
        AND cut.cause = 'account_removal'
        AND cut.state = 'removal_awaiting_tombstone'
    )
  )
  BEGIN
    SELECT RAISE(ABORT, 'provider thread archive target account evidence is set once');
  END;

  CREATE TRIGGER chat_provider_thread_archive_target_transition_guard_v57
  BEFORE UPDATE OF status ON chat_provider_thread_archive_targets_v57
  WHEN NOT (
    (OLD.status = 'open' AND NEW.status = 'account_contained')
    OR (OLD.status IN ('open', 'account_contained') AND NEW.status = 'committed')
  )
  BEGIN
    SELECT RAISE(ABORT, 'invalid provider thread archive target transition');
  END;

  CREATE TRIGGER chat_provider_thread_archive_target_delete_guard_v57
  BEFORE DELETE ON chat_provider_thread_archive_targets_v57
  WHEN OLD.status != 'committed'
  BEGIN
    SELECT RAISE(ABORT, 'open provider thread archive target is immutable');
  END;

  CREATE TRIGGER chat_provider_thread_archive_attempt_quota_v57
  BEFORE INSERT ON chat_provider_thread_archive_attempts_v57
  WHEN (
    SELECT COUNT(*) FROM chat_provider_thread_archive_attempts_v57
    WHERE target_id = NEW.target_id
  ) >= ${PROVIDER_THREAD_ARCHIVE_MAX_ATTEMPTS_PER_TARGET_V57}
  BEGIN
    SELECT RAISE(ABORT, 'provider thread archive attempt limit reached');
  END;

  CREATE TRIGGER chat_provider_thread_archive_attempt_insert_guard_v57
  BEFORE INSERT ON chat_provider_thread_archive_attempts_v57
  WHEN NOT (
    EXISTS (
      SELECT 1 FROM chat_provider_thread_archive_targets_v57 AS target
      WHERE target.target_id = NEW.target_id
        AND target.status = 'open'
        AND target.current_attempt_id = NEW.attempt_id
        AND target.current_attempt_ordinal = NEW.ordinal
    )
    AND (
      (NEW.ordinal = 1 AND NEW.predecessor_attempt_id IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM chat_provider_thread_archive_attempts_v57
          WHERE target_id = NEW.target_id
        ))
      OR (NEW.ordinal > 1 AND EXISTS (
        SELECT 1 FROM chat_provider_thread_archive_attempts_v57 AS predecessor
        WHERE predecessor.target_id = NEW.target_id
          AND predecessor.attempt_id = NEW.predecessor_attempt_id
          AND predecessor.ordinal = NEW.ordinal - 1
          AND predecessor.state IN ('reconciled_not_applied', 'abandoned_pre_effect')
          AND NEW.generation = predecessor.generation + 1
      ))
    )
    AND EXISTS (
      SELECT 1
      FROM chat_provider_thread_archive_targets_v57 AS target
      JOIN account_profiles AS account
        ON account.profile_id = target.account_profile_id
      WHERE target.target_id = NEW.target_id
        AND account.revision = NEW.account_profile_revision
        AND account.process_generation = NEW.generation
        AND account.removed_at IS NULL
    )
  )
  BEGIN
    SELECT RAISE(ABORT, 'provider thread archive attempt lineage is invalid');
  END;

  CREATE TRIGGER chat_provider_thread_archive_attempt_identity_immutable_v57
  BEFORE UPDATE OF attempt_id, target_id, ordinal, generation,
    account_profile_revision,
    predecessor_attempt_id, request_evidence_digest, request_revision_digest,
    identity_hmac, created_at
  ON chat_provider_thread_archive_attempts_v57
  BEGIN
    SELECT RAISE(ABORT, 'provider thread archive attempt identity is immutable');
  END;

  CREATE TRIGGER chat_provider_thread_archive_attempt_cut_binding_guard_v57
  BEFORE UPDATE OF cut_id, cut_binding_hmac
  ON chat_provider_thread_archive_attempts_v57
  WHEN NOT (
    OLD.cut_id IS NULL AND OLD.cut_binding_hmac IS NULL
    AND NEW.cut_id IS NOT NULL AND NEW.cut_binding_hmac IS NOT NULL
    AND NEW.state = OLD.state
    AND EXISTS (
      SELECT 1
      FROM chat_provider_thread_archive_cuts_v57 AS cut
      JOIN chat_provider_thread_archive_targets_v57 AS target
        ON target.target_id = OLD.target_id
      WHERE cut.cut_id = NEW.cut_id
        AND cut.account_profile_id = target.account_profile_id
        AND (
          cut.cause = 'account_removal'
          OR cut.source_generation = OLD.generation
        )
        AND cut.state = 'fence_started'
        AND target.status = 'open'
        AND target.current_attempt_id = OLD.attempt_id
        AND target.current_attempt_ordinal = OLD.ordinal
        AND (
          (cut.cause != 'account_removal'
            AND OLD.state IN ('prepared', 'effect_started'))
          OR (cut.cause = 'account_removal' AND OLD.state IN (
            'prepared', 'effect_started', 'ambiguous', 'direct_applied',
            'reconciled_applied', 'reconciled_not_applied',
            'abandoned_pre_effect'
          ))
        )
    )
  )
  BEGIN
    SELECT RAISE(ABORT, 'provider thread archive attempt cut binding is invalid');
  END;

  CREATE TRIGGER chat_provider_thread_archive_attempt_effect_guard_v57
  BEFORE UPDATE OF effect_evidence_digest, effect_revision_digest,
    effect_started_at, effect_hmac
  ON chat_provider_thread_archive_attempts_v57
  WHEN NOT (OLD.state = 'prepared' AND NEW.state = 'effect_started')
  BEGIN
    SELECT RAISE(ABORT, 'provider thread archive effect evidence is set once');
  END;

  CREATE TRIGGER chat_provider_thread_archive_attempt_ambiguity_guard_v57
  BEFORE UPDATE OF ambiguity_evidence_digest, ambiguity_revision_digest,
    ambiguous_at, ambiguity_hmac
  ON chat_provider_thread_archive_attempts_v57
  WHEN NOT (OLD.state = 'effect_started' AND NEW.state = 'ambiguous')
  BEGIN
    SELECT RAISE(ABORT, 'provider thread archive ambiguity evidence is set once');
  END;

  CREATE TRIGGER chat_provider_thread_archive_attempt_outcome_guard_v57
  BEFORE UPDATE OF outcome_evidence_digest, outcome_revision_digest,
    response_generation, response_stream_position, outcome_at, outcome_hmac
  ON chat_provider_thread_archive_attempts_v57
  WHEN NOT (
    (OLD.state = 'effect_started' AND NEW.state = 'direct_applied')
    OR (OLD.state = 'prepared' AND NEW.state = 'abandoned_pre_effect')
    OR (OLD.state = 'ambiguous' AND NEW.state = 'reconciled_applied')
    OR (OLD.state IN ('prepared', 'effect_started', 'ambiguous')
      AND NEW.state = 'reconciled_not_applied')
  )
  BEGIN
    SELECT RAISE(ABORT, 'provider thread archive outcome evidence is set once');
  END;

  CREATE TRIGGER chat_provider_thread_archive_attempt_transition_guard_v57
  BEFORE UPDATE OF state ON chat_provider_thread_archive_attempts_v57
  WHEN NOT (
    (OLD.state = 'prepared' AND NEW.state = 'effect_started')
    OR (OLD.state = 'prepared' AND NEW.state = 'abandoned_pre_effect')
    OR (OLD.state IN ('prepared', 'effect_started') AND NEW.state = OLD.state
      AND OLD.cut_id IS NULL AND NEW.cut_id IS NOT NULL)
    OR (OLD.state = 'effect_started'
      AND NEW.state IN ('ambiguous', 'direct_applied'))
    OR (OLD.state = 'ambiguous' AND NEW.state = 'reconciled_applied')
    OR (OLD.state IN ('prepared', 'effect_started', 'ambiguous')
      AND NEW.state = 'reconciled_not_applied')
    OR (OLD.state IN (
      'prepared', 'effect_started', 'ambiguous', 'direct_applied',
      'reconciled_applied', 'reconciled_not_applied', 'abandoned_pre_effect'
    ) AND NEW.state = 'account_contained')
  )
  BEGIN
    SELECT RAISE(ABORT, 'invalid provider thread archive attempt transition');
  END;


  CREATE TRIGGER chat_provider_thread_archive_attempt_account_evidence_guard_v57
  BEFORE UPDATE OF account_containment_prior_state,
    account_containment_evidence_digest, account_containment_revision_digest,
    account_contained_at, account_containment_hmac
  ON chat_provider_thread_archive_attempts_v57
  WHEN NEW.state != 'account_contained' OR OLD.state = 'account_contained'
  BEGIN
    SELECT RAISE(ABORT, 'provider thread archive account evidence is set once');
  END;


  CREATE TRIGGER chat_provider_thread_archive_attempt_account_containment_guard_v57
  BEFORE UPDATE OF state ON chat_provider_thread_archive_attempts_v57
  WHEN NEW.state = 'account_contained' AND NOT EXISTS (
    SELECT 1 FROM chat_provider_thread_archive_cuts_v57 AS cut
    WHERE cut.cut_id = OLD.cut_id
      AND cut.cause = 'account_removal'
      AND cut.state = 'removal_awaiting_tombstone'
  )
  BEGIN
    SELECT RAISE(ABORT, 'provider thread archive account containment lacks removal cut');
  END;

  CREATE TRIGGER chat_provider_thread_archive_attempt_reconciliation_guard_v57
  BEFORE UPDATE OF state ON chat_provider_thread_archive_attempts_v57
  WHEN NEW.state IN ('reconciled_applied', 'reconciled_not_applied')
    AND NOT EXISTS (
      SELECT 1 FROM chat_provider_thread_archive_cuts_v57 AS cut
      WHERE cut.cut_id = OLD.cut_id
        AND cut.state = 'contained'
        AND cut.source_generation = OLD.generation
        AND (
          NEW.state = 'reconciled_not_applied'
          OR NEW.response_generation = cut.successor_generation
        )
    )
  BEGIN
    SELECT RAISE(ABORT, 'provider thread archive reconciliation lacks containment');
  END;

  CREATE TRIGGER chat_provider_thread_archive_cut_quota_v57
  BEFORE INSERT ON chat_provider_thread_archive_cuts_v57
  WHEN (
    SELECT COUNT(*) FROM chat_provider_thread_archive_cuts_v57
    WHERE account_profile_id = NEW.account_profile_id
  ) >= ${PROVIDER_THREAD_ARCHIVE_MAX_CUTS_PER_ACCOUNT_V57}
  BEGIN
    SELECT RAISE(ABORT, 'provider thread archive cut limit reached');
  END;

  CREATE TRIGGER chat_provider_thread_archive_cut_insert_guard_v57
  BEFORE INSERT ON chat_provider_thread_archive_cuts_v57
  WHEN NOT (
    (
      NEW.cause = 'account_removal' AND NEW.initiating_attempt_id IS NULL
    )
    OR (
      NEW.cause IN ('ambiguous_response', 'lost_response')
      AND EXISTS (
        SELECT 1
        FROM chat_provider_thread_archive_targets_v57 AS target
        JOIN chat_provider_thread_archive_attempts_v57 AS attempt
          ON attempt.target_id = target.target_id
          AND attempt.attempt_id = target.current_attempt_id
          AND attempt.ordinal = target.current_attempt_ordinal
        WHERE attempt.attempt_id = NEW.initiating_attempt_id
          AND target.status = 'open'
          AND target.account_profile_id = NEW.account_profile_id
          AND attempt.generation = NEW.source_generation
          AND attempt.state = 'effect_started'
          AND attempt.cut_id IS NULL
      )
    )
  ) OR NOT EXISTS (
    SELECT 1 FROM account_profiles AS account
    WHERE account.profile_id = NEW.account_profile_id
      AND account.revision = NEW.account_profile_revision
      AND account.process_generation = NEW.source_generation
      AND account.removed_at IS NULL
  ) OR NEW.target_count != (
    SELECT COUNT(*)
    FROM chat_provider_thread_archive_targets_v57 AS target
    JOIN chat_provider_thread_archive_attempts_v57 AS attempt
      ON attempt.target_id = target.target_id
      AND attempt.attempt_id = target.current_attempt_id
      AND attempt.ordinal = target.current_attempt_ordinal
    WHERE target.status = 'open'
      AND target.account_profile_id = NEW.account_profile_id
      AND (
        NEW.cause = 'account_removal'
        OR attempt.generation = NEW.source_generation
      )
      AND attempt.cut_id IS NULL
  ) OR (
    NEW.cause = 'account_removal' AND EXISTS (
      SELECT 1
      FROM chat_provider_thread_archive_targets_v57 AS target
      JOIN chat_provider_thread_archive_attempts_v57 AS attempt
        ON attempt.target_id = target.target_id
        AND attempt.attempt_id = target.current_attempt_id
        AND attempt.ordinal = target.current_attempt_ordinal
      WHERE target.status = 'open'
        AND target.account_profile_id = NEW.account_profile_id
        AND attempt.cut_id IS NOT NULL
    )
  ) OR NOT (
    (NEW.predecessor_cut_id IS NULL AND NOT EXISTS (
      SELECT 1 FROM chat_provider_thread_archive_cuts_v57 AS prior
      WHERE prior.account_profile_id = NEW.account_profile_id
    ))
    OR EXISTS (
      SELECT 1 FROM chat_provider_thread_archive_cuts_v57 AS predecessor
      WHERE predecessor.cut_id = NEW.predecessor_cut_id
        AND predecessor.account_profile_id = NEW.account_profile_id
        AND predecessor.state = 'contained'
        AND predecessor.successor_generation = NEW.source_generation
    )
  )
  BEGIN
    SELECT RAISE(ABORT, 'provider thread archive cut lineage is invalid');
  END;

  CREATE TRIGGER chat_provider_thread_archive_cut_identity_immutable_v57
  BEFORE UPDATE OF cut_id, account_profile_id, account_profile_revision,
    source_generation, cause,
    initiating_attempt_id, target_count, target_inventory_digest,
    predecessor_cut_id, identity_evidence_digest,
    identity_revision_digest, identity_hmac, created_at
  ON chat_provider_thread_archive_cuts_v57
  BEGIN
    SELECT RAISE(ABORT, 'provider thread archive cut identity is immutable');
  END;

  CREATE TRIGGER chat_provider_thread_archive_cut_fence_guard_v57
  BEFORE UPDATE OF successor_generation, successor_account_profile_revision,
    fence_evidence_digest,
    fence_revision_digest, fenced_at, fence_hmac
  ON chat_provider_thread_archive_cuts_v57
  WHEN NOT (
    OLD.state = 'fence_started' AND NEW.state = 'fenced'
    AND (
      (OLD.cause = 'account_removal'
        AND NEW.successor_generation IS NULL
        AND NEW.successor_account_profile_revision IS NULL
        AND EXISTS (
          SELECT 1 FROM account_profiles AS account
          WHERE account.profile_id = OLD.account_profile_id
            AND account.revision = OLD.account_profile_revision
            AND account.process_generation = OLD.source_generation
            AND account.removed_at IS NULL
        ))
      OR (OLD.cause != 'account_removal'
        AND NEW.successor_generation = OLD.source_generation + 1
        AND EXISTS (
          SELECT 1 FROM account_profiles AS account
          WHERE account.profile_id = OLD.account_profile_id
            AND account.revision = NEW.successor_account_profile_revision
            AND account.process_generation = NEW.successor_generation
            AND account.removed_at IS NULL
        ))
    )
  )
  BEGIN
    SELECT RAISE(ABORT, 'provider thread archive fence evidence is set once');
  END;

  CREATE TRIGGER chat_provider_thread_archive_cut_seal_guard_v57
  BEFORE UPDATE OF member_count, inventory_digest,
    enumeration_authority_digest, seal_revision_digest,
    sealed_at, seal_hmac
  ON chat_provider_thread_archive_cuts_v57
  WHEN NOT (
    OLD.state = 'fenced' AND NEW.state = 'sealed'
    AND NEW.member_count = (
      SELECT COUNT(*) FROM chat_provider_thread_archive_cut_members_v57
      WHERE cut_id = OLD.cut_id
    )
    AND OLD.target_count = (
      SELECT COUNT(*) FROM chat_provider_thread_archive_cut_members_v57
      WHERE cut_id = OLD.cut_id AND role = 'target'
    )
    AND OLD.target_count = (
      SELECT COUNT(*)
      FROM chat_provider_thread_archive_targets_v57 AS target
      JOIN chat_provider_thread_archive_attempts_v57 AS attempt
        ON attempt.target_id = target.target_id
        AND attempt.attempt_id = target.current_attempt_id
        AND attempt.ordinal = target.current_attempt_ordinal
      JOIN chat_provider_thread_archive_cut_members_v57 AS member
        ON member.cut_id = OLD.cut_id
        AND member.role = 'target'
        AND member.pane_id = target.pane_id
      WHERE target.status = 'open'
        AND target.account_profile_id = OLD.account_profile_id
        AND (
          OLD.cause = 'account_removal'
          OR attempt.generation = OLD.source_generation
        )
        AND attempt.cut_id = OLD.cut_id
    )
  )
  BEGIN
    SELECT RAISE(ABORT, 'provider thread archive cut inventory is invalid');
  END;

  CREATE TRIGGER chat_provider_thread_archive_cut_containment_guard_v57
  BEFORE UPDATE OF settlement_inventory_digest, containment_evidence_digest,
    containment_revision_digest, contained_at, containment_hmac
  ON chat_provider_thread_archive_cuts_v57
  WHEN NOT (
    OLD.state = 'sealed'
    AND (
      (OLD.cause != 'account_removal' AND NEW.state = 'contained')
      OR (OLD.cause = 'account_removal'
        AND NEW.state = 'removal_awaiting_tombstone')
    )
    AND NOT EXISTS (
      SELECT 1 FROM chat_provider_thread_archive_cut_members_v57
      WHERE cut_id = OLD.cut_id AND state != 'settled'
    )
    AND OLD.member_count = (
      SELECT COUNT(*) FROM chat_provider_thread_archive_cut_members_v57
      WHERE cut_id = OLD.cut_id
    )
  )
  BEGIN
    SELECT RAISE(ABORT, 'provider thread archive cut is not contained');
  END;

  CREATE TRIGGER chat_provider_thread_archive_cut_tombstone_guard_v57
  BEFORE UPDATE OF tombstone_evidence_digest, tombstone_revision_digest,
    tombstone_account_profile_revision, tombstone_removed_at,
    tombstone_local_data_deleted_at, tombstone_profile_preimage_digest,
    tombstoned_at, tombstone_hmac
  ON chat_provider_thread_archive_cuts_v57
  WHEN NOT (
    OLD.cause = 'account_removal'
    AND OLD.state = 'removal_awaiting_tombstone'
    AND NEW.state = 'contained'
    AND EXISTS (
      SELECT 1 FROM account_profiles AS account
      WHERE account.profile_id = OLD.account_profile_id
        AND account.revision = NEW.tombstone_account_profile_revision
        AND account.process_generation = OLD.source_generation
        AND account.removed_at = NEW.tombstone_removed_at
        AND account.removed_at IS NOT NULL
        AND account.local_data_deleted_at
          IS NEW.tombstone_local_data_deleted_at
    )
    AND NOT EXISTS (
      SELECT 1
      FROM chat_provider_thread_archive_targets_v57 AS target
      JOIN chat_provider_thread_archive_attempts_v57 AS attempt
        ON attempt.target_id = target.target_id
        AND attempt.attempt_id = target.current_attempt_id
        AND attempt.ordinal = target.current_attempt_ordinal
      WHERE target.account_profile_id = OLD.account_profile_id
        AND target.status != 'committed'
        AND (
          attempt.cut_id IS NOT OLD.cut_id
          OR attempt.state != 'account_contained'
          OR target.status != 'account_contained'
        )
    )
  )
  BEGIN
    SELECT RAISE(ABORT, 'provider thread archive removal tombstone is invalid');
  END;

  CREATE TRIGGER chat_provider_thread_archive_cut_transition_guard_v57
  BEFORE UPDATE OF state ON chat_provider_thread_archive_cuts_v57
  WHEN NOT (
    (OLD.state = 'fence_started' AND NEW.state = 'fenced')
    OR (OLD.state = 'fenced' AND NEW.state = 'sealed')
    OR (OLD.state = 'sealed' AND OLD.cause != 'account_removal'
      AND NEW.state = 'contained')
    OR (OLD.state = 'sealed' AND OLD.cause = 'account_removal'
      AND NEW.state = 'removal_awaiting_tombstone')
    OR (OLD.state = 'removal_awaiting_tombstone'
      AND NEW.state = 'contained')
  )
  BEGIN
    SELECT RAISE(ABORT, 'invalid provider thread archive cut transition');
  END;

  CREATE TRIGGER chat_provider_thread_archive_cut_delete_guard_v57
  BEFORE DELETE ON chat_provider_thread_archive_cuts_v57
  WHEN OLD.state != 'contained' OR EXISTS (
    SELECT 1 FROM chat_provider_thread_archive_attempts_v57
    WHERE cut_id = OLD.cut_id
  )
  BEGIN
    SELECT RAISE(ABORT, 'provider thread archive cut evidence is retained');
  END;

  CREATE TRIGGER chat_provider_thread_archive_member_quota_v57
  BEFORE INSERT ON chat_provider_thread_archive_cut_members_v57
  WHEN (
    SELECT COUNT(*) FROM chat_provider_thread_archive_cut_members_v57
    WHERE cut_id = NEW.cut_id
  ) >= ${PROVIDER_THREAD_ARCHIVE_MAX_MEMBERS_PER_CUT_V57}
  BEGIN
    SELECT RAISE(ABORT, 'provider thread archive cut member limit reached');
  END;

  CREATE TRIGGER chat_provider_thread_archive_member_insert_guard_v57
  BEFORE INSERT ON chat_provider_thread_archive_cut_members_v57
  WHEN NOT EXISTS (
    SELECT 1 FROM chat_provider_thread_archive_cuts_v57 AS cut
    WHERE cut.cut_id = NEW.cut_id AND cut.state = 'fenced'
      AND NEW.ordinal = 1 + (
        SELECT COUNT(*) FROM chat_provider_thread_archive_cut_members_v57
        WHERE cut_id = NEW.cut_id
      )
      AND (
        (NEW.role = 'sibling' AND NOT EXISTS (
          SELECT 1
          FROM chat_provider_thread_archive_targets_v57 AS target
          JOIN chat_provider_thread_archive_attempts_v57 AS attempt
            ON attempt.target_id = target.target_id
            AND attempt.attempt_id = target.current_attempt_id
            AND attempt.ordinal = target.current_attempt_ordinal
          WHERE target.pane_id = NEW.pane_id AND attempt.cut_id = NEW.cut_id
        ))
        OR (
          NEW.role = 'target' AND EXISTS (
            SELECT 1
            FROM chat_provider_thread_archive_targets_v57 AS target
            JOIN chat_provider_thread_archive_attempts_v57 AS attempt
              ON attempt.target_id = target.target_id
              AND attempt.attempt_id = target.current_attempt_id
              AND attempt.ordinal = target.current_attempt_ordinal
            WHERE target.pane_id = NEW.pane_id
              AND target.target_id = NEW.target_id
              AND target.status = 'open'
              AND target.account_profile_id = cut.account_profile_id
              AND (
                cut.cause = 'account_removal'
                OR attempt.generation = cut.source_generation
              )
              AND attempt.attempt_id = NEW.attempt_id
              AND attempt.ordinal = NEW.target_attempt_ordinal
              AND attempt.cut_id = cut.cut_id
          )
        )
      )
      AND EXISTS (
        SELECT 1 FROM chat_panes AS pane
        WHERE pane.pane_id = NEW.pane_id
          AND pane.archived_at IS NULL
          AND pane.revision = NEW.pane_revision
          AND pane.provider_account_profile_id = cut.account_profile_id
          AND pane.provider_thread_id = NEW.thread_id
          AND pane.provider_restart_thread_id = NEW.restart_thread_id
      )
      AND (
        (NEW.binding_id IS NULL AND (
          SELECT COUNT(*) FROM chat_provider_attachment_bindings AS binding
          WHERE binding.pane_id = NEW.pane_id
            AND binding.state IN ('active', 'ambiguous')
        ) = 0)
        OR (NEW.binding_id IS NOT NULL AND (
          SELECT COUNT(*) FROM chat_provider_attachment_bindings AS binding
          WHERE binding.pane_id = NEW.pane_id
            AND binding.state IN ('active', 'ambiguous')
            AND binding.binding_id = NEW.binding_id
            AND binding.binding_key_digest = NEW.binding_key_digest
            AND binding.revision = NEW.binding_revision
        ) = 1 AND (
          SELECT COUNT(*) FROM chat_provider_attachment_bindings AS binding
          WHERE binding.pane_id = NEW.pane_id
            AND binding.state IN ('active', 'ambiguous')
        ) = 1)
      )
  )
  BEGIN
    SELECT RAISE(ABORT, 'provider thread archive cut member is invalid');
  END;

  CREATE TRIGGER chat_provider_thread_archive_member_identity_immutable_v57
  BEFORE UPDATE OF member_id, cut_id, ordinal, pane_id, pane_revision,
    pane_cas_digest, thread_id, restart_thread_id, role, target_id,
    attempt_id, target_attempt_ordinal, action,
    binding_id, binding_key_digest, binding_revision,
    identity_evidence_digest, identity_revision_digest, identity_hmac,
    created_at
  ON chat_provider_thread_archive_cut_members_v57
  BEGIN
    SELECT RAISE(ABORT, 'provider thread archive cut member identity is immutable');
  END;

  CREATE TRIGGER chat_provider_thread_archive_member_settlement_guard_v57
  BEFORE UPDATE OF state, settlement_evidence_digest,
    settlement_revision_digest, settled_at, settlement_hmac
  ON chat_provider_thread_archive_cut_members_v57
  WHEN NOT (
    OLD.state = 'pending' AND NEW.state = 'settled'
    AND EXISTS (
      SELECT 1 FROM chat_provider_thread_archive_cuts_v57 AS cut
      WHERE cut.cut_id = OLD.cut_id AND cut.state = 'sealed'
    )
  )
  BEGIN
    SELECT RAISE(ABORT, 'provider thread archive member settlement is invalid');
  END;

  CREATE TRIGGER chat_provider_thread_archive_member_delete_guard_v57
  BEFORE DELETE ON chat_provider_thread_archive_cut_members_v57
  WHEN NOT EXISTS (
    SELECT 1 FROM chat_provider_thread_archive_cuts_v57 AS cut
    WHERE cut.cut_id = OLD.cut_id AND cut.state = 'contained'
  )
  BEGIN
    SELECT RAISE(ABORT, 'provider thread archive cut inventory is immutable');
  END;
`;

const hexDigestSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const isoDateTimeSchema = z.string().datetime();
const targetIdSchema = z.string().min(18).max(96).regex(/^archtarget_[A-Za-z0-9_-]+$/u);
const attemptIdSchema = z.string().min(19).max(96).regex(/^archattempt_[A-Za-z0-9_-]+$/u);
const cutIdSchema = z.string().min(15).max(96).regex(/^archcut_[A-Za-z0-9_-]+$/u);
const memberIdSchema = z.string().min(18).max(96).regex(/^archmember_[A-Za-z0-9_-]+$/u);
const paneIdSchema = z.string().min(12).max(96).regex(/^pane_[A-Za-z0-9_-]+$/u);
const accountIdSchema = z.string().min(1).max(128).refine((value) => !value.includes("\0"));
const providerIdSchema = z.string().min(1).max(512).refine((value) => !value.includes("\0"));
const bindingIdSchema = z.string().min(1).max(128).refine((value) => !value.includes("\0"));
const positiveSafeIntegerSchema = z.number().int().positive().safe();
const nonnegativeSafeIntegerSchema = z.number().int().nonnegative().safe();
const accountProfileAuthorityRowSchema = z.object({
  profile_id: accountIdSchema,
  revision: positiveSafeIntegerSchema,
  process_generation: nonnegativeSafeIntegerSchema,
  removed_at: isoDateTimeSchema.nullable(),
  local_data_deleted_at: isoDateTimeSchema.nullable(),
}).strict();

const targetRowSchema = z.object({
  target_id: targetIdSchema,
  pane_id: paneIdSchema,
  purpose: z.enum(["start_fresh", "pane_archive"]),
  pane_revision: positiveSafeIntegerSchema,
  queue_revision: positiveSafeIntegerSchema.nullable(),
  pane_cas_digest: hexDigestSchema,
  queue_cas_digest: hexDigestSchema.nullable(),
  account_profile_id: accountIdSchema,
  account_profile_revision: positiveSafeIntegerSchema,
  thread_id: providerIdSchema,
  restart_thread_id: providerIdSchema,
  binding_id: bindingIdSchema.nullable(),
  binding_key_digest: hexDigestSchema.nullable(),
  binding_revision: positiveSafeIntegerSchema.nullable(),
  current_attempt_id: attemptIdSchema,
  current_attempt_ordinal: positiveSafeIntegerSchema,
  status: z.enum(["open", "account_contained", "committed"]),
  identity_hmac: hexDigestSchema,
  pointer_hmac: hexDigestSchema,
  account_containment_evidence_digest: hexDigestSchema.nullable(),
  account_containment_revision_digest: hexDigestSchema.nullable(),
  account_containment_hmac: hexDigestSchema.nullable(),
  account_contained_at: isoDateTimeSchema.nullable(),
  commit_evidence_digest: hexDigestSchema.nullable(),
  commit_revision_digest: hexDigestSchema.nullable(),
  commit_hmac: hexDigestSchema.nullable(),
  created_at: isoDateTimeSchema,
  committed_at: isoDateTimeSchema.nullable(),
}).strict();

const attemptRowSchema = z.object({
  attempt_id: attemptIdSchema,
  target_id: targetIdSchema,
  ordinal: positiveSafeIntegerSchema,
  generation: positiveSafeIntegerSchema,
  account_profile_revision: positiveSafeIntegerSchema,
  predecessor_attempt_id: attemptIdSchema.nullable(),
  cut_id: cutIdSchema.nullable(),
  state: z.enum([
    "prepared",
    "effect_started",
    "ambiguous",
    "direct_applied",
    "reconciled_applied",
    "reconciled_not_applied",
    "abandoned_pre_effect",
    "account_contained",
  ]),
  request_evidence_digest: hexDigestSchema,
  request_revision_digest: hexDigestSchema,
  identity_hmac: hexDigestSchema,
  cut_binding_hmac: hexDigestSchema.nullable(),
  effect_evidence_digest: hexDigestSchema.nullable(),
  effect_revision_digest: hexDigestSchema.nullable(),
  effect_started_at: isoDateTimeSchema.nullable(),
  effect_hmac: hexDigestSchema.nullable(),
  ambiguity_evidence_digest: hexDigestSchema.nullable(),
  ambiguity_revision_digest: hexDigestSchema.nullable(),
  ambiguous_at: isoDateTimeSchema.nullable(),
  ambiguity_hmac: hexDigestSchema.nullable(),
  outcome_evidence_digest: hexDigestSchema.nullable(),
  outcome_revision_digest: hexDigestSchema.nullable(),
  response_generation: positiveSafeIntegerSchema.nullable(),
  response_stream_position: nonnegativeSafeIntegerSchema.nullable(),
  outcome_at: isoDateTimeSchema.nullable(),
  outcome_hmac: hexDigestSchema.nullable(),
  account_containment_prior_state: z.enum([
    "prepared",
    "effect_started",
    "ambiguous",
    "direct_applied",
    "reconciled_applied",
    "reconciled_not_applied",
    "abandoned_pre_effect",
  ]).nullable(),
  account_containment_evidence_digest: hexDigestSchema.nullable(),
  account_containment_revision_digest: hexDigestSchema.nullable(),
  account_contained_at: isoDateTimeSchema.nullable(),
  account_containment_hmac: hexDigestSchema.nullable(),
  created_at: isoDateTimeSchema,
}).strict();

const cutRowSchema = z.object({
  cut_id: cutIdSchema,
  account_profile_id: accountIdSchema,
  account_profile_revision: positiveSafeIntegerSchema,
  source_generation: positiveSafeIntegerSchema,
  cause: z.enum(["ambiguous_response", "lost_response", "account_removal"]),
  initiating_attempt_id: attemptIdSchema.nullable(),
  target_count: nonnegativeSafeIntegerSchema,
  target_inventory_digest: hexDigestSchema,
  predecessor_cut_id: cutIdSchema.nullable(),
  state: z.enum([
    "fence_started",
    "fenced",
    "sealed",
    "removal_awaiting_tombstone",
    "contained",
  ]),
  identity_evidence_digest: hexDigestSchema,
  identity_revision_digest: hexDigestSchema,
  identity_hmac: hexDigestSchema,
  successor_generation: positiveSafeIntegerSchema.nullable(),
  successor_account_profile_revision: positiveSafeIntegerSchema.nullable(),
  fence_evidence_digest: hexDigestSchema.nullable(),
  fence_revision_digest: hexDigestSchema.nullable(),
  fenced_at: isoDateTimeSchema.nullable(),
  fence_hmac: hexDigestSchema.nullable(),
  member_count: nonnegativeSafeIntegerSchema.nullable(),
  inventory_digest: hexDigestSchema.nullable(),
  enumeration_authority_digest: hexDigestSchema.nullable(),
  seal_revision_digest: hexDigestSchema.nullable(),
  sealed_at: isoDateTimeSchema.nullable(),
  seal_hmac: hexDigestSchema.nullable(),
  settlement_inventory_digest: hexDigestSchema.nullable(),
  containment_evidence_digest: hexDigestSchema.nullable(),
  containment_revision_digest: hexDigestSchema.nullable(),
  contained_at: isoDateTimeSchema.nullable(),
  containment_hmac: hexDigestSchema.nullable(),
  tombstone_evidence_digest: hexDigestSchema.nullable(),
  tombstone_revision_digest: hexDigestSchema.nullable(),
  tombstone_account_profile_revision: positiveSafeIntegerSchema.nullable(),
  tombstone_removed_at: isoDateTimeSchema.nullable(),
  tombstone_local_data_deleted_at: isoDateTimeSchema.nullable(),
  tombstone_profile_preimage_digest: hexDigestSchema.nullable(),
  tombstoned_at: isoDateTimeSchema.nullable(),
  tombstone_hmac: hexDigestSchema.nullable(),
  created_at: isoDateTimeSchema,
}).strict();

const memberRowSchema = z.object({
  member_id: memberIdSchema,
  cut_id: cutIdSchema,
  ordinal: positiveSafeIntegerSchema,
  pane_id: paneIdSchema,
  pane_revision: positiveSafeIntegerSchema,
  pane_cas_digest: hexDigestSchema,
  thread_id: providerIdSchema,
  restart_thread_id: providerIdSchema,
  role: z.enum(["target", "sibling"]),
  target_id: targetIdSchema.nullable(),
  attempt_id: attemptIdSchema.nullable(),
  target_attempt_ordinal: positiveSafeIntegerSchema.nullable(),
  action: z.enum([
    "preserved_target",
    "contain_generation_context",
    "detach_binding_only",
  ]),
  binding_id: bindingIdSchema.nullable(),
  binding_key_digest: hexDigestSchema.nullable(),
  binding_revision: positiveSafeIntegerSchema.nullable(),
  identity_evidence_digest: hexDigestSchema,
  identity_revision_digest: hexDigestSchema,
  identity_hmac: hexDigestSchema,
  state: z.enum(["pending", "settled"]),
  settlement_evidence_digest: hexDigestSchema.nullable(),
  settlement_revision_digest: hexDigestSchema.nullable(),
  settled_at: isoDateTimeSchema.nullable(),
  settlement_hmac: hexDigestSchema.nullable(),
  created_at: isoDateTimeSchema,
}).strict();

type TargetRow = z.infer<typeof targetRowSchema>;
type AttemptRow = z.infer<typeof attemptRowSchema>;
type CutRow = z.infer<typeof cutRowSchema>;
type MemberRow = z.infer<typeof memberRowSchema>;
type AffectedTargetV57 = Readonly<{ readonly target: TargetRow; readonly attempt: AttemptRow }>;
type TerminalCleanupComponentRowsV57 = Readonly<{
  readonly accountProfileId: string;
  readonly targets: readonly TargetRow[];
  readonly cuts: readonly CutRow[];
}>;

export type ProviderThreadArchiveAttemptStateV57 = AttemptRow["state"];
export type ProviderThreadArchiveCutStateV57 = CutRow["state"];

export interface ProviderThreadArchiveTargetSnapshotV57 {
  readonly targetId: string;
  readonly paneId: string;
  readonly purpose: TargetRow["purpose"];
  readonly status: TargetRow["status"];
  readonly currentAttempt: ProviderThreadArchiveAttemptSnapshotV57;
  readonly attempts: readonly ProviderThreadArchiveAttemptSnapshotV57[];
}

export interface ProviderThreadArchiveAttemptSnapshotV57 {
  readonly attemptId: string;
  readonly ordinal: number;
  readonly generation: number;
  readonly accountProfileRevision: number;
  readonly predecessorAttemptId: string | null;
  readonly cutId: string | null;
  readonly state: ProviderThreadArchiveAttemptStateV57;
}

export interface ProviderThreadArchiveCutSnapshotV57 {
  readonly cutId: string;
  readonly accountProfileId: string;
  readonly accountProfileRevision: number;
  readonly sourceGeneration: number;
  readonly successorGeneration: number | null;
  readonly successorAccountProfileRevision: number | null;
  readonly cause: CutRow["cause"];
  readonly initiatingAttemptId: string | null;
  readonly targetCount: number;
  readonly state: ProviderThreadArchiveCutStateV57;
  readonly members: readonly ProviderThreadArchiveCutMemberSnapshotV57[];
}

export type ProviderThreadArchiveBindingPreimageV57 =
  | Readonly<{ readonly kind: "none" }>
  | Readonly<{
      readonly kind: "exact";
      readonly bindingId: string;
      readonly bindingKeyDigest: string;
      readonly bindingRevision: number;
    }>;

export interface ProviderThreadArchiveCutMemberSnapshotV57 {
  readonly memberId: string;
  readonly ordinal: number;
  readonly paneId: string;
  readonly role: MemberRow["role"];
  readonly action: MemberRow["action"];
  readonly state: MemberRow["state"];
}

export interface ProviderThreadArchiveRecoveryInventoryV57 {
  readonly admissionDescriptors: readonly ArchiveAdmissionDescriptor[];
  readonly activeCuts: readonly ProviderThreadArchiveCutSnapshotV57[];
  readonly removalAdmissionDescriptors: readonly AccountRemovalAdmissionDescriptor[];
  readonly removalCuts: readonly ProviderThreadArchiveCutSnapshotV57[];
  readonly targets: readonly ProviderThreadArchiveTargetSnapshotV57[];
}

export interface ProviderThreadArchiveTerminalCleanupV57 {
  readonly deletedTargetIds: readonly string[];
  readonly deletedCutIds: readonly string[];
}

export interface ProviderThreadArchiveTerminalCleanupComponentV57 {
  readonly accountProfileId: string;
  readonly targetIds: readonly string[];
  readonly cutIds: readonly string[];
  readonly allTargetsCommitted: boolean;
}

export interface PrepareProviderThreadArchiveTargetV57 {
  readonly targetId: string;
  readonly paneId: string;
  readonly purpose: TargetRow["purpose"];
  readonly paneRevision: number;
  readonly queueRevision: number | null;
  readonly paneCasDigest: string;
  readonly queueCasDigest: string | null;
  readonly accountProfileId: string;
  readonly accountProfileRevision: number;
  readonly threadId: string;
  readonly restartThreadId: string;
  readonly binding: ProviderThreadArchiveBindingPreimageV57;
  readonly attempt: Readonly<{
    attemptId: string;
    generation: number;
    accountProfileRevision: number;
    requestEvidenceDigest: string;
    requestRevisionDigest: string;
  }>;
  readonly now: Date;
}

export interface CreateProviderThreadArchiveCutV57 {
  readonly cutId: string;
  readonly accountProfileId: string;
  readonly accountProfileRevision: number;
  readonly sourceGeneration: number;
  readonly cause: CutRow["cause"];
  readonly initiatingAttemptId: string | null;
  readonly predecessorCutId: string | null;
  readonly identityEvidenceDigest: string;
  readonly identityRevisionDigest: string;
  readonly now: Date;
}

export interface AddProviderThreadArchiveCutMemberV57 {
  readonly memberId: string;
  readonly cutId: string;
  readonly paneId: string;
  readonly paneRevision: number;
  readonly paneCasDigest: string;
  readonly threadId: string;
  readonly restartThreadId: string;
  readonly role: MemberRow["role"];
  readonly targetId: string | null;
  readonly attemptId: string | null;
  readonly targetAttemptOrdinal: number | null;
  readonly action: MemberRow["action"];
  readonly binding: ProviderThreadArchiveBindingPreimageV57;
  readonly identityEvidenceDigest: string;
  readonly identityRevisionDigest: string;
  readonly now: Date;
}

/**
 * Content digest for the coordinator's complete, keyed pane enumeration.
 * The journal compares this preimage with every frozen member before sealing;
 * the separately supplied enumeration authority digest proves who enumerated it.
 */
export function providerThreadArchiveCompleteInventoryDigestV57(
  members: readonly AddProviderThreadArchiveCutMemberV57[],
): string {
  const parsed = members.map(parseAddMember);
  const memberIds = new Set(parsed.map(({ memberId }) => memberId));
  const paneIds = new Set(parsed.map(({ paneId }) => paneId));
  if (memberIds.size !== parsed.length || paneIds.size !== parsed.length) {
    throw new TypeError("Provider-thread archive complete inventory is duplicated");
  }
  return completeInventorySha256FromParsed(parsed);
}

/** Canonical durable account-profile preimage consumed by removal containment. */
export function providerThreadArchiveAccountTombstonePreimageDigestV57(
  input: Readonly<{
    accountProfileId: string;
    accountProfileRevision: number;
    processGeneration: number;
    removedAt: string;
    localDataDeletedAt: string | null;
  }>,
): string {
  const payload = {
    accountProfileId: accountIdSchema.parse(input.accountProfileId),
    accountProfileRevision: positiveSafeIntegerSchema.parse(
      input.accountProfileRevision,
    ),
    processGeneration: positiveSafeIntegerSchema.parse(
      input.processGeneration,
    ),
    removedAt: isoDateTimeSchema.parse(input.removedAt),
    localDataDeletedAt: input.localDataDeletedAt === null
      ? null
      : isoDateTimeSchema.parse(input.localDataDeletedAt),
  };
  return createHash("sha256").update(canonicalJson(payload)).digest("hex");
}

export interface ProviderThreadArchiveTargetPreimageV57 {
  readonly paneId: string;
  readonly purpose: TargetRow["purpose"];
  readonly paneRevision: number;
  readonly queueRevision: number | null;
  readonly paneCasDigest: string;
  readonly queueCasDigest: string | null;
  readonly accountProfileId: string;
  readonly accountProfileRevision: number;
  readonly threadId: string;
  readonly restartThreadId: string;
  readonly binding: ProviderThreadArchiveBindingPreimageV57;
}

export interface ProviderThreadArchiveMemberPreimageV57 {
  readonly paneId: string;
  readonly paneRevision: number;
  readonly paneCasDigest: string;
  readonly threadId: string;
  readonly restartThreadId: string;
  readonly binding: ProviderThreadArchiveBindingPreimageV57;
}

export interface ProviderThreadArchiveRemovalTargetEvidenceV57 {
  readonly targetId: string;
  readonly containmentEvidenceDigest: string;
  readonly containmentRevisionDigest: string;
}

export class ProviderThreadArchiveJournalV57Error extends Error {
  readonly code: "conflict" | "corrupt" | "invalid_state" | "limit" | "not_found";

  constructor(
    code: "conflict" | "corrupt" | "invalid_state" | "limit" | "not_found",
    message: string,
  ) {
    super(message);
    this.name = "ProviderThreadArchiveJournalV57Error";
    this.code = code;
  }
}

export class ProviderThreadArchiveJournalV57 {
  readonly #database: Database;
  readonly #receiptKey: Uint8Array;

  constructor(database: Database, receiptKey: Uint8Array) {
    if (receiptKey.byteLength !== operationReceiptKeyByteLength) {
      throw new Error("Provider-thread archive receipt key has an invalid length");
    }
    this.#database = database;
    this.#receiptKey = Uint8Array.from(receiptKey);
  }

  prepareTarget(input: PrepareProviderThreadArchiveTargetV57): ProviderThreadArchiveTargetSnapshotV57 {
    const parsed = parsePrepareTarget(input);
    return this.#database.transaction(() => {
      const existing = this.#targetRow(parsed.targetId);
      if (existing !== null) {
        const reopened = this.#reopenTargetRow(existing);
        const initialAttempt = this.#attemptRowForTargetOrdinal(existing.target_id, 1);
        if (
          initialAttempt === null
          || !targetInputMatches(existing, parsed)
          || !initialAttemptInputMatches(initialAttempt, parsed, existing.created_at)
        ) {
          throw conflict("Provider-thread archive target identity was already used");
        }
        return reopened;
      }
      this.#requireActiveProfileGeneration({
        accountProfileId: parsed.accountProfileId,
        accountProfileRevision: parsed.accountProfileRevision,
        generation: parsed.attempt.generation,
      });
      const createdAt = parseDate(parsed.now);
      const targetIdentity = targetIdentityPayload(parsed, createdAt);
      const identityHmac = this.#hmac("target-identity", targetIdentity);
      const pointerHmac = this.#hmac("target-pointer", {
        targetIdentity,
        currentAttemptId: parsed.attempt.attemptId,
        currentAttemptOrdinal: 1,
      });
      const attemptIdentity = attemptIdentityPayload({
        attemptId: parsed.attempt.attemptId,
        targetId: parsed.targetId,
        ordinal: 1,
        generation: parsed.attempt.generation,
        accountProfileRevision: parsed.attempt.accountProfileRevision,
        predecessorAttemptId: null,
        cutId: null,
        requestEvidenceDigest: parsed.attempt.requestEvidenceDigest,
        requestRevisionDigest: parsed.attempt.requestRevisionDigest,
        createdAt,
      });
      try {
        this.#database.query(`
          INSERT INTO chat_provider_thread_archive_targets_v57 (
            target_id, pane_id, purpose, pane_revision, queue_revision,
            pane_cas_digest, queue_cas_digest, account_profile_id,
            account_profile_revision, thread_id, restart_thread_id,
            binding_id, binding_key_digest, binding_revision,
            current_attempt_id, current_attempt_ordinal, status,
            identity_hmac, pointer_hmac, created_at
          ) VALUES (
            ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13,
            ?14, ?15, 1, 'open', ?16, ?17, ?18
          )
        `).run(
          parsed.targetId,
          parsed.paneId,
          parsed.purpose,
          parsed.paneRevision,
          parsed.queueRevision,
          parsed.paneCasDigest,
          parsed.queueCasDigest,
          parsed.accountProfileId,
          parsed.accountProfileRevision,
          parsed.threadId,
          parsed.restartThreadId,
          parsed.binding.bindingId,
          parsed.binding.bindingKeyDigest,
          parsed.binding.bindingRevision,
          parsed.attempt.attemptId,
          identityHmac,
          pointerHmac,
          createdAt,
        );
        this.#database.query(`
          INSERT INTO chat_provider_thread_archive_attempts_v57 (
            attempt_id, target_id, ordinal, generation, predecessor_attempt_id,
            account_profile_revision, cut_id, state,
            request_evidence_digest, request_revision_digest,
            identity_hmac, created_at
          ) VALUES (
            ?1, ?2, 1, ?3, NULL, ?4, NULL, 'prepared', ?5, ?6, ?7, ?8
          )
        `).run(
          parsed.attempt.attemptId,
          parsed.targetId,
          parsed.attempt.generation,
          parsed.attempt.accountProfileRevision,
          parsed.attempt.requestEvidenceDigest,
          parsed.attempt.requestRevisionDigest,
          this.#hmac("attempt-identity", attemptIdentity),
          createdAt,
        );
      } catch (error: unknown) {
        throw sqliteError(error, "Provider-thread archive target could not be prepared");
      }
      return this.reopenTarget(parsed.targetId);
    })();
  }

  markEffectStarted(input: Readonly<{
    attemptId: string;
    effectEvidenceDigest: string;
    effectRevisionDigest: string;
    now: Date;
  }>): ProviderThreadArchiveAttemptSnapshotV57 {
    const attemptId = attemptIdSchema.parse(input.attemptId);
    const evidenceDigest = hexDigestSchema.parse(input.effectEvidenceDigest);
    const revisionDigest = hexDigestSchema.parse(input.effectRevisionDigest);
    const at = parseDate(input.now);
    return this.#database.transaction(() => {
      const attempt = this.#requireAttempt(attemptId);
      this.#verifyAttempt(attempt);
      if (attempt.state !== "prepared") {
        throw invalidState("Provider-thread archive attempt is not prepared");
      }
      const effectHmac = this.#hmac("attempt-effect", {
        identity: attemptIdentityPayloadFromRow(attempt),
        state: "effect_started",
        effectEvidenceDigest: evidenceDigest,
        effectRevisionDigest: revisionDigest,
        effectStartedAt: at,
      });
      this.#updateOne(`
        UPDATE chat_provider_thread_archive_attempts_v57 SET
          state = 'effect_started', effect_evidence_digest = ?2,
          effect_revision_digest = ?3, effect_started_at = ?4, effect_hmac = ?5
        WHERE attempt_id = ?1 AND state = 'prepared'
      `, [attemptId, evidenceDigest, revisionDigest, at, effectHmac],
      "Provider-thread archive effect could not be marked started");
      return attemptSnapshot(this.#requireAttempt(attemptId));
    })();
  }

  recordPreparedNotStarted(input: Readonly<{
    attemptId: string;
    outcomeEvidenceDigest: string;
    outcomeRevisionDigest: string;
    now: Date;
  }>): ProviderThreadArchiveAttemptSnapshotV57 {
    const attemptId = attemptIdSchema.parse(input.attemptId);
    const evidenceDigest = hexDigestSchema.parse(input.outcomeEvidenceDigest);
    const revisionDigest = hexDigestSchema.parse(input.outcomeRevisionDigest);
    const at = parseDate(input.now);
    return this.#database.transaction(() => {
      const attempt = this.#requireAttempt(attemptId);
      this.#verifyAttempt(attempt);
      if (attempt.state !== "prepared" || attempt.cut_id !== null) {
        throw invalidState("Provider-thread archive attempt is not an unfenced preparation");
      }
      const outcomeHmac = this.#hmac("attempt-outcome", {
        identity: attemptIdentityPayloadFromRow(attempt),
        cutId: null,
        state: "abandoned_pre_effect",
        outcomeEvidenceDigest: evidenceDigest,
        outcomeRevisionDigest: revisionDigest,
        responseGeneration: null,
        responseStreamPosition: null,
        outcomeAt: at,
      });
      this.#updateOne(`
        UPDATE chat_provider_thread_archive_attempts_v57 SET
          state = 'abandoned_pre_effect', outcome_evidence_digest = ?2,
          outcome_revision_digest = ?3, outcome_at = ?4, outcome_hmac = ?5
        WHERE attempt_id = ?1 AND state = 'prepared' AND cut_id IS NULL
      `, [attemptId, evidenceDigest, revisionDigest, at, outcomeHmac],
      "Provider-thread archive preparation could not be abandoned");
      return attemptSnapshot(this.#requireAttempt(attemptId));
    })();
  }

  createCut(input: CreateProviderThreadArchiveCutV57): ProviderThreadArchiveCutSnapshotV57 {
    const parsed = parseCreateCut(input);
    return this.#database.transaction(() => {
      const existing = this.#cutRow(parsed.cutId);
      if (existing !== null) {
        this.#verifyCut(existing, this.#memberRows(parsed.cutId));
        if (!cutInputMatches(existing, parsed)) {
          throw conflict("Provider-thread archive cut identity was already used");
        }
        return this.reopenCut(parsed.cutId);
      }
      this.#requireActiveProfileGeneration({
        accountProfileId: parsed.accountProfileId,
        accountProfileRevision: parsed.accountProfileRevision,
        generation: parsed.sourceGeneration,
      });
      const createdAt = parseDate(parsed.now);
      const affectedTargets = this.#affectedTargets(
        parsed.accountProfileId,
        parsed.sourceGeneration,
        parsed.cause,
      );
      if (parsed.cause !== "account_removal") {
        const initiating = affectedTargets.find(({ attempt }) =>
          attempt.attempt_id === parsed.initiatingAttemptId
        );
        if (initiating === undefined || initiating.attempt.state !== "effect_started") {
          throw invalidState("Provider-thread archive cut lacks its initiating effect");
        }
      }
      const targetInventoryDigest = targetInventorySha256(affectedTargets);
      const identity = cutIdentityPayload({
        ...parsed,
        targetCount: affectedTargets.length,
        targetInventoryDigest,
      }, createdAt);
      try {
        this.#database.query(`
          INSERT INTO chat_provider_thread_archive_cuts_v57 (
            cut_id, account_profile_id, account_profile_revision,
            source_generation, cause,
            initiating_attempt_id, target_count, target_inventory_digest,
            predecessor_cut_id, state, identity_evidence_digest,
            identity_revision_digest, identity_hmac, created_at
          ) VALUES (
            ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9,
            'fence_started', ?10, ?11, ?12, ?13
          )
        `).run(
          parsed.cutId,
          parsed.accountProfileId,
          parsed.accountProfileRevision,
          parsed.sourceGeneration,
          parsed.cause,
          parsed.initiatingAttemptId,
          affectedTargets.length,
          targetInventoryDigest,
          parsed.predecessorCutId,
          parsed.identityEvidenceDigest,
          parsed.identityRevisionDigest,
          this.#hmac("cut-identity", identity),
          createdAt,
        );
      } catch (error: unknown) {
        throw sqliteError(error, "Provider-thread archive cut could not be created");
      }
      return this.reopenCut(parsed.cutId);
    })();
  }

  bindAttemptToCut(attemptIdValue: string, cutIdValue: string): ProviderThreadArchiveAttemptSnapshotV57 {
    const attemptId = attemptIdSchema.parse(attemptIdValue);
    const cutId = cutIdSchema.parse(cutIdValue);
    return this.#database.transaction(() => {
      const attempt = this.#requireAttempt(attemptId);
      const cut = this.#requireCut(cutId);
      this.#verifyAttempt(attempt);
      this.#verifyCut(cut, this.#memberRows(cutId));
      if (attempt.cut_id !== null) {
        if (attempt.cut_id === cutId) return attemptSnapshot(attempt);
        throw conflict("Provider-thread archive attempt is already bound to another cut");
      }
      if (
        cut.state !== "fence_started"
        || (cut.cause !== "account_removal"
          && attempt.generation !== cut.source_generation)
        || (cut.cause === "account_removal"
          ? ![
              "prepared",
              "effect_started",
              "ambiguous",
              "direct_applied",
              "reconciled_applied",
              "reconciled_not_applied",
              "abandoned_pre_effect",
            ].includes(attempt.state)
          : !["prepared", "effect_started"].includes(attempt.state))
      ) {
        throw invalidState("Provider-thread archive attempt cannot bind this containment cut");
      }
      const bindingHmac = this.#hmac("attempt-cut-binding", {
        identity: attemptIdentityPayloadFromRow(attempt),
        cutId,
      });
      this.#updateOne(`
        UPDATE chat_provider_thread_archive_attempts_v57
        SET cut_id = ?2, cut_binding_hmac = ?3
        WHERE attempt_id = ?1 AND cut_id IS NULL
      `, [attemptId, cutId, bindingHmac],
      "Provider-thread archive attempt could not bind its containment cut");
      return attemptSnapshot(this.#requireAttempt(attemptId));
    })();
  }

  bindAllAffectedTargets(cutIdValue: string): readonly ProviderThreadArchiveAttemptSnapshotV57[] {
    const cutId = cutIdSchema.parse(cutIdValue);
    return this.#database.transaction(() => {
      const cut = this.#requireCut(cutId);
      const members = this.#memberRows(cutId);
      this.#verifyCut(cut, members);
      if (cut.state !== "fence_started") {
        throw invalidState("Provider-thread archive cut is not accepting target bindings");
      }
      const targets = this.#assertCutTargetInventory(cut, false);
      for (const { attempt } of targets) {
        if (attempt.cut_id === null) this.bindAttemptToCut(attempt.attempt_id, cutId);
      }
      const bound = this.#assertCutTargetInventory(this.#requireCut(cutId), true);
      return Object.freeze(bound.map(({ attempt }) => attemptSnapshot(attempt)));
    })();
  }

  recordAmbiguous(input: Readonly<{
    attemptId: string;
    ambiguityEvidenceDigest: string;
    ambiguityRevisionDigest: string;
    now: Date;
  }>): ProviderThreadArchiveAttemptSnapshotV57 {
    const attemptId = attemptIdSchema.parse(input.attemptId);
    const evidenceDigest = hexDigestSchema.parse(input.ambiguityEvidenceDigest);
    const revisionDigest = hexDigestSchema.parse(input.ambiguityRevisionDigest);
    const at = parseDate(input.now);
    return this.#database.transaction(() => {
      const attempt = this.#requireAttempt(attemptId);
      this.#verifyAttempt(attempt);
      if (attempt.state !== "effect_started" || attempt.cut_id === null) {
        throw invalidState("Provider-thread archive attempt lacks a bound containment cut");
      }
      const ambiguityHmac = this.#hmac("attempt-ambiguity", {
        identity: attemptIdentityPayloadFromRow(attempt),
        cutId: attempt.cut_id,
        state: "ambiguous",
        ambiguityEvidenceDigest: evidenceDigest,
        ambiguityRevisionDigest: revisionDigest,
        ambiguousAt: at,
      });
      this.#updateOne(`
        UPDATE chat_provider_thread_archive_attempts_v57 SET
          state = 'ambiguous', ambiguity_evidence_digest = ?2,
          ambiguity_revision_digest = ?3, ambiguous_at = ?4,
          ambiguity_hmac = ?5
        WHERE attempt_id = ?1 AND state = 'effect_started' AND cut_id IS NOT NULL
      `, [attemptId, evidenceDigest, revisionDigest, at, ambiguityHmac],
      "Provider-thread archive ambiguity could not be recorded");
      return attemptSnapshot(this.#requireAttempt(attemptId));
    })();
  }

  recordFence(input: Readonly<{
    cutId: string;
    successorGeneration: number | null;
    successorAccountProfileRevision: number | null;
    fenceEvidenceDigest: string;
    fenceRevisionDigest: string;
    now: Date;
  }>): ProviderThreadArchiveCutSnapshotV57 {
    const cutId = cutIdSchema.parse(input.cutId);
    const successorGeneration = input.successorGeneration === null
      ? null
      : positiveSafeIntegerSchema.parse(input.successorGeneration);
    const successorAccountProfileRevision =
      input.successorAccountProfileRevision === null
        ? null
        : positiveSafeIntegerSchema.parse(
            input.successorAccountProfileRevision,
          );
    const evidenceDigest = hexDigestSchema.parse(input.fenceEvidenceDigest);
    const revisionDigest = hexDigestSchema.parse(input.fenceRevisionDigest);
    const at = parseDate(input.now);
    return this.#database.transaction(() => {
      const cut = this.#requireCut(cutId);
      this.#verifyCut(cut, this.#memberRows(cutId));
      this.#assertCutTargetInventory(cut, true);
      if (
        cut.state !== "fence_started"
        || (cut.cause === "account_removal"
          ? successorGeneration !== null
            || successorAccountProfileRevision !== null
          : successorGeneration !== cut.source_generation + 1
            || successorAccountProfileRevision === null)
      ) {
        throw invalidState("Provider-thread archive fence generation is incoherent");
      }
      this.#requireActiveProfileGeneration({
        accountProfileId: cut.account_profile_id,
        accountProfileRevision: successorAccountProfileRevision
          ?? cut.account_profile_revision,
        generation: successorGeneration ?? cut.source_generation,
      });
      const fenceHmac = this.#hmac("cut-fence", {
        identity: cutIdentityPayloadFromRow(cut),
        state: "fenced",
        successorGeneration,
        successorAccountProfileRevision,
        fenceEvidenceDigest: evidenceDigest,
        fenceRevisionDigest: revisionDigest,
        fencedAt: at,
      });
      this.#updateOne(`
        UPDATE chat_provider_thread_archive_cuts_v57 SET
          state = 'fenced', successor_generation = ?2,
          successor_account_profile_revision = ?3,
          fence_evidence_digest = ?4, fence_revision_digest = ?5,
          fenced_at = ?6, fence_hmac = ?7
        WHERE cut_id = ?1 AND state = 'fence_started'
      `, [
        cutId,
        successorGeneration,
        successorAccountProfileRevision,
        evidenceDigest,
        revisionDigest,
        at,
        fenceHmac,
      ],
      "Provider-thread archive fence could not be recorded");
      return this.reopenCut(cutId);
    })();
  }

  addCutMember(input: AddProviderThreadArchiveCutMemberV57): ProviderThreadArchiveCutMemberSnapshotV57 {
    const parsed = parseAddMember(input);
    return this.#database.transaction(() => {
      const existing = this.#memberRow(parsed.memberId);
      if (existing !== null) {
        this.#verifyMember(existing);
        if (!memberInputMatches(existing, parsed)) {
          throw conflict("Provider-thread archive member identity was already used");
        }
        return memberSnapshot(existing);
      }
      const cut = this.#requireCut(parsed.cutId);
      this.#verifyCut(cut, this.#memberRows(parsed.cutId));
      if (cut.state !== "fenced") {
        throw invalidState("Provider-thread archive inventory is not open");
      }
      const ordinal = this.#memberRows(parsed.cutId).length + 1;
      const createdAt = parseDate(parsed.now);
      const identity = memberIdentityPayload({ ...parsed, ordinal, createdAt });
      try {
        this.#database.query(`
          INSERT INTO chat_provider_thread_archive_cut_members_v57 (
            member_id, cut_id, ordinal, pane_id, pane_revision,
            pane_cas_digest, thread_id, restart_thread_id,
            role, target_id, attempt_id, target_attempt_ordinal, action,
            binding_id, binding_key_digest, binding_revision,
            identity_evidence_digest, identity_revision_digest,
            identity_hmac, state, created_at
          ) VALUES (
            ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12,
            ?13, ?14, ?15, ?16, ?17, ?18, ?19, 'pending', ?20
          )
        `).run(
          parsed.memberId,
          parsed.cutId,
          ordinal,
          parsed.paneId,
          parsed.paneRevision,
          parsed.paneCasDigest,
          parsed.threadId,
          parsed.restartThreadId,
          parsed.role,
          parsed.targetId,
          parsed.attemptId,
          parsed.targetAttemptOrdinal,
          parsed.action,
          parsed.binding.bindingId,
          parsed.binding.bindingKeyDigest,
          parsed.binding.bindingRevision,
          parsed.identityEvidenceDigest,
          parsed.identityRevisionDigest,
          this.#hmac("member-identity", identity),
          createdAt,
        );
      } catch (error: unknown) {
        throw sqliteError(error, "Provider-thread archive cut member could not be added");
      }
      return memberSnapshot(this.#requireMember(parsed.memberId));
    })();
  }

  sealCutInventory(input: Readonly<{
    cutId: string;
    expectedMemberCount: number;
    expectedInventoryDigest: string;
    enumerationAuthorityDigest: string;
    sealRevisionDigest: string;
    now: Date;
  }>): ProviderThreadArchiveCutSnapshotV57 {
    const cutId = cutIdSchema.parse(input.cutId);
    const expectedMemberCount = nonnegativeSafeIntegerSchema
      .max(PROVIDER_THREAD_ARCHIVE_MAX_MEMBERS_PER_CUT_V57)
      .parse(input.expectedMemberCount);
    const expectedInventoryDigest = hexDigestSchema.parse(
      input.expectedInventoryDigest,
    );
    const enumerationAuthorityDigest = hexDigestSchema.parse(
      input.enumerationAuthorityDigest,
    );
    const revisionDigest = hexDigestSchema.parse(input.sealRevisionDigest);
    const at = parseDate(input.now);
    return this.#database.transaction(() => {
      const cut = this.#requireCut(cutId);
      const members = this.#memberRows(cutId);
      this.#verifyCut(cut, members);
      if (cut.state !== "fenced") {
        throw invalidState("Provider-thread archive cut is not ready to seal");
      }
      this.#assertCutTargetInventory(cut, true, members);
      const inventoryDigest = completeInventorySha256FromRows(members);
      if (
        members.length !== expectedMemberCount
        || !safeHexEqual(inventoryDigest, expectedInventoryDigest)
      ) {
        throw invalidState(
          "Provider-thread archive members do not equal the complete enumeration",
        );
      }
      const sealHmac = this.#hmac("cut-seal", {
        identity: cutIdentityPayloadFromRow(cut),
        state: "sealed",
        successorGeneration: cut.successor_generation,
        successorAccountProfileRevision:
          cut.successor_account_profile_revision,
        memberCount: members.length,
        inventoryDigest,
        enumerationAuthorityDigest,
        sealRevisionDigest: revisionDigest,
        sealedAt: at,
      });
      this.#updateOne(`
        UPDATE chat_provider_thread_archive_cuts_v57 SET
          state = 'sealed', member_count = ?2, inventory_digest = ?3,
          enumeration_authority_digest = ?4,
          seal_revision_digest = ?5, sealed_at = ?6, seal_hmac = ?7
        WHERE cut_id = ?1 AND state = 'fenced'
      `, [
        cutId,
        members.length,
        inventoryDigest,
        enumerationAuthorityDigest,
        revisionDigest,
        at,
        sealHmac,
      ],
      "Provider-thread archive cut inventory could not be sealed");
      return this.reopenCut(cutId);
    })();
  }

  settleMember(input: Readonly<{
    memberId: string;
    settlementEvidenceDigest: string;
    settlementRevisionDigest: string;
    now: Date;
  }>): ProviderThreadArchiveCutMemberSnapshotV57 {
    const memberId = memberIdSchema.parse(input.memberId);
    const evidenceDigest = hexDigestSchema.parse(input.settlementEvidenceDigest);
    const revisionDigest = hexDigestSchema.parse(input.settlementRevisionDigest);
    const at = parseDate(input.now);
    return this.#database.transaction(() => {
      const member = this.#requireMember(memberId);
      this.#verifyMember(member);
      const cut = this.#requireCut(member.cut_id);
      this.#verifyCut(cut, this.#memberRows(cut.cut_id));
      if (member.state !== "pending" || cut.state !== "sealed") {
        throw invalidState("Provider-thread archive member is not pending in a sealed cut");
      }
      const settlementHmac = this.#hmac("member-settlement", {
        identity: memberIdentityPayloadFromRow(member),
        state: "settled",
        settlementEvidenceDigest: evidenceDigest,
        settlementRevisionDigest: revisionDigest,
        settledAt: at,
      });
      this.#updateOne(`
        UPDATE chat_provider_thread_archive_cut_members_v57 SET
          state = 'settled', settlement_evidence_digest = ?2,
          settlement_revision_digest = ?3, settled_at = ?4,
          settlement_hmac = ?5
        WHERE member_id = ?1 AND state = 'pending'
      `, [memberId, evidenceDigest, revisionDigest, at, settlementHmac],
      "Provider-thread archive member could not be settled");
      return memberSnapshot(this.#requireMember(memberId));
    })();
  }

  markCutContained(input: Readonly<{
    cutId: string;
    containmentEvidenceDigest: string;
    containmentRevisionDigest: string;
    now: Date;
  }>): ProviderThreadArchiveCutSnapshotV57 {
    const cutId = cutIdSchema.parse(input.cutId);
    const evidenceDigest = hexDigestSchema.parse(input.containmentEvidenceDigest);
    const revisionDigest = hexDigestSchema.parse(input.containmentRevisionDigest);
    const at = parseDate(input.now);
    return this.#database.transaction(() => {
      const cut = this.#requireCut(cutId);
      const members = this.#memberRows(cutId);
      this.#verifyCut(cut, members);
      if (
        cut.cause === "account_removal"
        || cut.state !== "sealed"
        || members.some((member) => member.state !== "settled")
      ) {
        throw invalidState("Provider-thread archive cut still has unsettled members");
      }
      this.#assertCutTargetInventory(cut, true, members);
      const inventoryDigest = completeInventorySha256FromRows(members);
      if (cut.inventory_digest === null || !safeHexEqual(cut.inventory_digest, inventoryDigest)) {
        throw corrupt("Provider-thread archive cut inventory changed after sealing");
      }
      const settlementInventoryDigest = settlementInventorySha256(members);
      const containmentHmac = this.#hmac("cut-containment", {
        identity: cutIdentityPayloadFromRow(cut),
        state: "contained",
        successorGeneration: cut.successor_generation,
        successorAccountProfileRevision:
          cut.successor_account_profile_revision,
        memberCount: members.length,
        inventoryDigest,
        enumerationAuthorityDigest: cut.enumeration_authority_digest,
        fenceHmac: cut.fence_hmac,
        sealHmac: cut.seal_hmac,
        settlementInventoryDigest,
        containmentEvidenceDigest: evidenceDigest,
        containmentRevisionDigest: revisionDigest,
        containedAt: at,
      });
      this.#updateOne(`
        UPDATE chat_provider_thread_archive_cuts_v57 SET
          state = 'contained', settlement_inventory_digest = ?2,
          containment_evidence_digest = ?3, containment_revision_digest = ?4,
          contained_at = ?5, containment_hmac = ?6
        WHERE cut_id = ?1 AND state = 'sealed'
      `, [cutId, settlementInventoryDigest, evidenceDigest, revisionDigest, at, containmentHmac],
      "Provider-thread archive cut could not be marked contained");
      return this.reopenCut(cutId);
    })();
  }

  markRemovalAwaitingTombstone(input: Readonly<{
    cutId: string;
    containmentEvidenceDigest: string;
    containmentRevisionDigest: string;
    targets: readonly ProviderThreadArchiveRemovalTargetEvidenceV57[];
    now: Date;
  }>): ProviderThreadArchiveCutSnapshotV57 {
    const cutId = cutIdSchema.parse(input.cutId);
    const evidenceDigest = hexDigestSchema.parse(input.containmentEvidenceDigest);
    const revisionDigest = hexDigestSchema.parse(input.containmentRevisionDigest);
    const at = parseDate(input.now);
    const targetEvidence = new Map<string, Readonly<{
      containmentEvidenceDigest: string;
      containmentRevisionDigest: string;
    }>>();
    for (const value of input.targets) {
      const targetId = targetIdSchema.parse(value.targetId);
      if (targetEvidence.has(targetId)) {
        throw new TypeError("Provider-thread archive removal target evidence is duplicated");
      }
      targetEvidence.set(targetId, Object.freeze({
        containmentEvidenceDigest: hexDigestSchema.parse(value.containmentEvidenceDigest),
        containmentRevisionDigest: hexDigestSchema.parse(value.containmentRevisionDigest),
      }));
    }
    return this.#database.transaction(() => {
      const cut = this.#requireCut(cutId);
      const members = this.#memberRows(cutId);
      this.#verifyCut(cut, members);
      if (
        cut.cause !== "account_removal"
        || cut.state !== "sealed"
        || members.some((member) => member.state !== "settled")
      ) {
        throw invalidState("Provider-thread archive removal cut is not settled");
      }
      const targets = this.#assertCutTargetInventory(cut, true, members);
      if (
        targetEvidence.size !== targets.length
        || targets.some(({ target }) => !targetEvidence.has(target.target_id))
      ) {
        throw invalidState("Provider-thread archive removal evidence is not the exact target inventory");
      }
      const inventoryDigest = completeInventorySha256FromRows(members);
      if (cut.inventory_digest === null || !safeHexEqual(cut.inventory_digest, inventoryDigest)) {
        throw corrupt("Provider-thread archive removal inventory changed after sealing");
      }
      const settlementInventoryDigest = settlementInventorySha256(members);
      const containmentHmac = this.#hmac("cut-containment", {
        identity: cutIdentityPayloadFromRow(cut),
        state: "removal_awaiting_tombstone",
        successorGeneration: null,
        successorAccountProfileRevision: null,
        memberCount: members.length,
        inventoryDigest,
        enumerationAuthorityDigest: cut.enumeration_authority_digest,
        fenceHmac: cut.fence_hmac,
        sealHmac: cut.seal_hmac,
        settlementInventoryDigest,
        containmentEvidenceDigest: evidenceDigest,
        containmentRevisionDigest: revisionDigest,
        containedAt: at,
      });
      this.#updateOne(`
        UPDATE chat_provider_thread_archive_cuts_v57 SET
          state = 'removal_awaiting_tombstone', settlement_inventory_digest = ?2,
          containment_evidence_digest = ?3, containment_revision_digest = ?4,
          contained_at = ?5, containment_hmac = ?6
        WHERE cut_id = ?1 AND cause = 'account_removal' AND state = 'sealed'
      `, [cutId, settlementInventoryDigest, evidenceDigest, revisionDigest, at, containmentHmac],
      "Provider-thread archive removal could not await its tombstone");

      for (const { target, attempt } of targets) {
        const targetReceipt = targetEvidence.get(target.target_id)!;
        const priorState = attempt.state;
        const attemptContainmentHmac = this.#hmac("attempt-account-containment", {
          identity: attemptIdentityPayloadFromRow(attempt),
          cutId,
          cutContainmentHmac: containmentHmac,
          priorState,
          cutBindingHmac: attempt.cut_binding_hmac,
          effectHmac: attempt.effect_hmac,
          ambiguityHmac: attempt.ambiguity_hmac,
          outcomeHmac: attempt.outcome_hmac,
          accountContainmentEvidenceDigest: targetReceipt.containmentEvidenceDigest,
          accountContainmentRevisionDigest: targetReceipt.containmentRevisionDigest,
          accountContainedAt: at,
        });
        this.#updateOne(`
          UPDATE chat_provider_thread_archive_attempts_v57 SET
            state = 'account_contained', account_containment_prior_state = ?2,
            account_containment_evidence_digest = ?3,
            account_containment_revision_digest = ?4,
            account_contained_at = ?5, account_containment_hmac = ?6
          WHERE attempt_id = ?1 AND cut_id = ?7 AND state = ?2
        `, [
          attempt.attempt_id,
          priorState,
          targetReceipt.containmentEvidenceDigest,
          targetReceipt.containmentRevisionDigest,
          at,
          attemptContainmentHmac,
          cutId,
        ], "Provider-thread archive attempt could not be account-contained");

        const targetContainmentHmac = this.#hmac("target-account-containment", {
          identity: targetIdentityPayloadFromRow(target),
          pointerHmac: target.pointer_hmac,
          attemptId: attempt.attempt_id,
          attemptAccountContainmentHmac: attemptContainmentHmac,
          cutId,
          cutContainmentHmac: containmentHmac,
          accountContainmentEvidenceDigest: targetReceipt.containmentEvidenceDigest,
          accountContainmentRevisionDigest: targetReceipt.containmentRevisionDigest,
          accountContainedAt: at,
        });
        this.#updateOne(`
          UPDATE chat_provider_thread_archive_targets_v57 SET
            status = 'account_contained', account_containment_evidence_digest = ?2,
            account_containment_revision_digest = ?3,
            account_contained_at = ?4, account_containment_hmac = ?5
          WHERE target_id = ?1 AND status = 'open'
        `, [
          target.target_id,
          targetReceipt.containmentEvidenceDigest,
          targetReceipt.containmentRevisionDigest,
          at,
          targetContainmentHmac,
        ], "Provider-thread archive target could not be account-contained");
      }
      return this.reopenCut(cutId);
    })();
  }

  markRemovalTombstoned(input: Readonly<{
    cutId: string;
    tombstoneEvidenceDigest: string;
    tombstoneRevisionDigest: string;
    accountProfileRevision: number;
    removedAt: string;
    localDataDeletedAt: string | null;
    profilePreimageDigest: string;
    now: Date;
  }>): ProviderThreadArchiveCutSnapshotV57 {
    const cutId = cutIdSchema.parse(input.cutId);
    const evidenceDigest = hexDigestSchema.parse(input.tombstoneEvidenceDigest);
    const revisionDigest = hexDigestSchema.parse(input.tombstoneRevisionDigest);
    const accountProfileRevision = positiveSafeIntegerSchema.parse(
      input.accountProfileRevision,
    );
    const removedAt = isoDateTimeSchema.parse(input.removedAt);
    const localDataDeletedAt = input.localDataDeletedAt === null
      ? null
      : isoDateTimeSchema.parse(input.localDataDeletedAt);
    const profilePreimageDigest = hexDigestSchema.parse(
      input.profilePreimageDigest,
    );
    const at = parseDate(input.now);
    return this.#database.transaction(() => {
      const cut = this.#requireCut(cutId);
      const members = this.#memberRows(cutId);
      this.#verifyCut(cut, members);
      if (cut.cause !== "account_removal" || cut.state !== "removal_awaiting_tombstone") {
        throw invalidState("Provider-thread archive removal is not awaiting a tombstone");
      }
      const profile = this.#accountProfile(cut.account_profile_id);
      if (
        profile.revision !== accountProfileRevision
        || profile.process_generation !== cut.source_generation
        || profile.removed_at !== removedAt
        || profile.local_data_deleted_at !== localDataDeletedAt
        || !safeHexEqual(
          profilePreimageDigest,
          providerThreadArchiveAccountTombstonePreimageDigestV57({
            accountProfileId: profile.profile_id,
            accountProfileRevision: profile.revision,
            processGeneration: profile.process_generation,
            removedAt: profile.removed_at ?? removedAt,
            localDataDeletedAt: profile.local_data_deleted_at,
          }),
        )
      ) {
        throw invalidState(
          "Provider-thread archive removal lacks its exact account tombstone",
        );
      }
      const targets = this.#assertCutTargetInventory(cut, true, members);
      if (targets.some(({ target, attempt }) =>
        target.status !== "account_contained" || attempt.state !== "account_contained"
      )) {
        throw invalidState("Provider-thread archive removal targets are not account-contained");
      }
      const tombstoneHmac = this.#hmac("cut-tombstone", {
        identity: cutIdentityPayloadFromRow(cut),
        containmentHmac: cut.containment_hmac,
        state: "contained",
        tombstoneEvidenceDigest: evidenceDigest,
        tombstoneRevisionDigest: revisionDigest,
        accountProfileRevision,
        removedAt,
        localDataDeletedAt,
        profilePreimageDigest,
        tombstonedAt: at,
      });
      this.#updateOne(`
        UPDATE chat_provider_thread_archive_cuts_v57 SET
          state = 'contained', tombstone_evidence_digest = ?2,
          tombstone_revision_digest = ?3,
          tombstone_account_profile_revision = ?4,
          tombstone_removed_at = ?5,
          tombstone_local_data_deleted_at = ?6,
          tombstone_profile_preimage_digest = ?7,
          tombstoned_at = ?8, tombstone_hmac = ?9
        WHERE cut_id = ?1 AND cause = 'account_removal'
          AND state = 'removal_awaiting_tombstone'
      `, [
        cutId,
        evidenceDigest,
        revisionDigest,
        accountProfileRevision,
        removedAt,
        localDataDeletedAt,
        profilePreimageDigest,
        at,
        tombstoneHmac,
      ],
      "Provider-thread archive removal tombstone could not be recorded");
      return this.reopenCut(cutId);
    })();
  }

  recordDirectApplied(input: Readonly<{
    attemptId: string;
    responseGeneration: number;
    responseStreamPosition: number;
    outcomeEvidenceDigest: string;
    outcomeRevisionDigest: string;
    now: Date;
  }>): ProviderThreadArchiveAttemptSnapshotV57 {
    return this.#recordApplied(input, "direct_applied");
  }

  recordReconciledApplied(input: Readonly<{
    attemptId: string;
    responseGeneration: number;
    responseStreamPosition: number;
    outcomeEvidenceDigest: string;
    outcomeRevisionDigest: string;
    now: Date;
  }>): ProviderThreadArchiveAttemptSnapshotV57 {
    return this.#recordApplied(input, "reconciled_applied");
  }

  recordReconciledNotApplied(input: Readonly<{
    attemptId: string;
    outcomeEvidenceDigest: string;
    outcomeRevisionDigest: string;
    now: Date;
  }>): ProviderThreadArchiveAttemptSnapshotV57 {
    const attemptId = attemptIdSchema.parse(input.attemptId);
    const evidenceDigest = hexDigestSchema.parse(input.outcomeEvidenceDigest);
    const revisionDigest = hexDigestSchema.parse(input.outcomeRevisionDigest);
    const at = parseDate(input.now);
    return this.#database.transaction(() => {
      const attempt = this.#requireAttempt(attemptId);
      this.#verifyAttempt(attempt);
      if (
        attempt.cut_id === null
        || !["prepared", "effect_started", "ambiguous"].includes(attempt.state)
      ) {
        throw invalidState("Provider-thread archive attempt is not reconcilable");
      }
      const cut = this.#requireCut(attempt.cut_id);
      this.#verifyCut(cut, this.#memberRows(cut.cut_id));
      if (cut.cause === "account_removal" || cut.state !== "contained") {
        throw invalidState("Provider-thread archive generation is not contained");
      }
      const outcomeHmac = this.#hmac("attempt-outcome", {
        identity: attemptIdentityPayloadFromRow(attempt),
        cutId: attempt.cut_id,
        state: "reconciled_not_applied",
        outcomeEvidenceDigest: evidenceDigest,
        outcomeRevisionDigest: revisionDigest,
        responseGeneration: null,
        responseStreamPosition: null,
        outcomeAt: at,
      });
      this.#updateOne(`
        UPDATE chat_provider_thread_archive_attempts_v57 SET
          state = 'reconciled_not_applied', outcome_evidence_digest = ?2,
          outcome_revision_digest = ?3, outcome_at = ?4, outcome_hmac = ?5
        WHERE attempt_id = ?1 AND state IN ('prepared', 'effect_started', 'ambiguous')
      `, [attemptId, evidenceDigest, revisionDigest, at, outcomeHmac],
      "Provider-thread archive not-applied outcome could not be recorded");
      return attemptSnapshot(this.#requireAttempt(attemptId));
    })();
  }

  appendSuccessorAttempt(input: Readonly<{
    targetId: string;
    attemptId: string;
    generation: number;
    accountProfileRevision: number;
    requestEvidenceDigest: string;
    requestRevisionDigest: string;
    now: Date;
  }>): ProviderThreadArchiveTargetSnapshotV57 {
    const targetId = targetIdSchema.parse(input.targetId);
    const attemptId = attemptIdSchema.parse(input.attemptId);
    const generation = positiveSafeIntegerSchema.parse(input.generation);
    const accountProfileRevision = positiveSafeIntegerSchema.parse(
      input.accountProfileRevision,
    );
    const requestEvidenceDigest = hexDigestSchema.parse(input.requestEvidenceDigest);
    const requestRevisionDigest = hexDigestSchema.parse(input.requestRevisionDigest);
    const createdAt = parseDate(input.now);
    return this.#database.transaction(() => {
      const target = this.#requireTarget(targetId);
      const reopened = this.#reopenTargetRow(target);
      const predecessor = this.#requireAttempt(target.current_attempt_id);
      if (
        target.status !== "open"
        || !["reconciled_not_applied", "abandoned_pre_effect"].includes(predecessor.state)
      ) {
        throw invalidState("Provider-thread archive target cannot append a successor");
      }
      if (generation !== predecessor.generation + 1) {
        throw invalidState("Provider-thread archive successor generation must be exact");
      }
      this.#requireActiveProfileGeneration({
        accountProfileId: target.account_profile_id,
        accountProfileRevision,
        generation,
      });
      const ordinal = predecessor.ordinal + 1;
      if (ordinal > PROVIDER_THREAD_ARCHIVE_MAX_ATTEMPTS_PER_TARGET_V57) {
        throw new ProviderThreadArchiveJournalV57Error(
          "limit",
          "Provider-thread archive attempt limit reached",
        );
      }
      const targetIdentity = targetIdentityPayloadFromRow(target);
      const pointerHmac = this.#hmac("target-pointer", {
        targetIdentity,
        currentAttemptId: attemptId,
        currentAttemptOrdinal: ordinal,
      });
      const identity = attemptIdentityPayload({
        attemptId,
        targetId,
        ordinal,
        generation,
        accountProfileRevision,
        predecessorAttemptId: predecessor.attempt_id,
        cutId: null,
        requestEvidenceDigest,
        requestRevisionDigest,
        createdAt,
      });
      try {
        this.#database.query(`
          UPDATE chat_provider_thread_archive_targets_v57
          SET current_attempt_id = ?2, current_attempt_ordinal = ?3,
            pointer_hmac = ?4
          WHERE target_id = ?1 AND status = 'open'
        `).run(targetId, attemptId, ordinal, pointerHmac);
        this.#database.query(`
          INSERT INTO chat_provider_thread_archive_attempts_v57 (
            attempt_id, target_id, ordinal, generation, predecessor_attempt_id,
            account_profile_revision, cut_id, state,
            request_evidence_digest, request_revision_digest,
            identity_hmac, created_at
          ) VALUES (
            ?1, ?2, ?3, ?4, ?5, ?6, NULL, 'prepared', ?7, ?8, ?9, ?10
          )
        `).run(
          attemptId,
          targetId,
          ordinal,
          generation,
          predecessor.attempt_id,
          accountProfileRevision,
          requestEvidenceDigest,
          requestRevisionDigest,
          this.#hmac("attempt-identity", identity),
          createdAt,
        );
      } catch (error: unknown) {
        throw sqliteError(error, "Provider-thread archive successor could not be appended");
      }
      void reopened;
      return this.reopenTarget(targetId);
    })();
  }

  markTargetCommitted(input: Readonly<{
    targetId: string;
    commitEvidenceDigest: string;
    commitRevisionDigest: string;
    now: Date;
  }>): ProviderThreadArchiveTargetSnapshotV57 {
    const targetId = targetIdSchema.parse(input.targetId);
    const evidenceDigest = hexDigestSchema.parse(input.commitEvidenceDigest);
    const revisionDigest = hexDigestSchema.parse(input.commitRevisionDigest);
    const at = parseDate(input.now);
    return this.#database.transaction(() => {
      const target = this.#requireTarget(targetId);
      this.#reopenTargetRow(target);
      if (target.status === "committed") {
        throw invalidState("Provider-thread archive target is already committed");
      }
      const attempt = this.#requireAttempt(target.current_attempt_id);
      const boundCut = attempt.cut_id === null ? null : this.#requireCut(attempt.cut_id);
      if (boundCut !== null) this.#verifyCut(boundCut, this.#memberRows(boundCut.cut_id));
      const accountContained = attempt.state === "account_contained"
        && boundCut?.cause === "account_removal"
        && boundCut.state === "contained";
      const reconciledApplied = attempt.state === "reconciled_applied"
        && boundCut?.cause !== "account_removal"
        && boundCut?.state === "contained";
      if (
        !accountContained
        && !(attempt.state === "direct_applied" && attempt.cut_id === null)
        && !reconciledApplied
      ) {
        throw invalidState("Provider-thread archive target lacks an applied outcome");
      }
      const commitHmac = this.#hmac("target-commit", {
        identity: targetIdentityPayloadFromRow(target),
        pointerHmac: target.pointer_hmac,
        currentAttemptId: target.current_attempt_id,
        currentAttemptOrdinal: target.current_attempt_ordinal,
        currentAttemptAuthorityHmac: this.#attemptAdmissionAuthority(attempt).hmac,
        accountContainmentHmac: target.account_containment_hmac,
        status: "committed",
        commitEvidenceDigest: evidenceDigest,
        commitRevisionDigest: revisionDigest,
        committedAt: at,
      });
      this.#updateOne(`
        UPDATE chat_provider_thread_archive_targets_v57 SET
          status = 'committed', commit_evidence_digest = ?2,
          commit_revision_digest = ?3, committed_at = ?4, commit_hmac = ?5
        WHERE target_id = ?1 AND status IN ('open', 'account_contained')
      `, [targetId, evidenceDigest, revisionDigest, at, commitHmac],
      "Provider-thread archive target could not be committed");
      return this.reopenTarget(targetId);
    })();
  }

  terminalCleanupComponent(
    targetIdValue: string,
  ): ProviderThreadArchiveTerminalCleanupComponentV57 {
    const targetId = targetIdSchema.parse(targetIdValue);
    return this.#database.transaction(() =>
      this.#terminalCleanupComponentSnapshot(
        this.#terminalCleanupComponentRows(targetId),
      ))();
  }

  deleteCommittedTargetSafely(
    targetIdValue: string,
    expectedComponent?: ProviderThreadArchiveTerminalCleanupComponentV57,
  ): ProviderThreadArchiveTerminalCleanupV57 {
    const targetId = targetIdSchema.parse(targetIdValue);
    const parsedExpected = expectedComponent === undefined
      ? null
      : this.#parseTerminalCleanupComponent(expectedComponent);
    return this.#database.transaction(() => {
      const component = this.#terminalCleanupComponentRows(targetId);
      const requested = component.targets.find((target) =>
        target.target_id === targetId
      );
      if (requested?.status !== "committed") {
        throw invalidState("Provider-thread archive target is not committed");
      }
      if (component.targets.some((target) => target.status !== "committed")) {
        return emptyTerminalCleanup();
      }
      const observed = this.#terminalCleanupComponentSnapshot(component);
      if (
        parsedExpected !== null
          ? !terminalCleanupComponentsEqual(parsedExpected, observed)
          : component.targets.length !== 1
      ) {
        throw invalidState(
          "Provider-thread archive terminal cleanup component was not approved exactly",
        );
      }
      const cutDeletionOrder = this.#terminalCutDeletionOrder(component.cuts);
      try {
        for (const target of component.targets) {
          this.#database.query(`
            DELETE FROM chat_provider_thread_archive_targets_v57
            WHERE target_id = ?1 AND status = 'committed'
          `).run(target.target_id);
          if (this.#targetRow(target.target_id) !== null) {
            throw invalidState(
              "Provider-thread archive component target could not be deleted",
            );
          }
        }
        for (const target of component.targets) {
          this.#database.query(`
            DELETE FROM chat_provider_thread_archive_attempts_v57
            WHERE target_id = ?1
          `).run(target.target_id);
          const remainingAttempts = z.object({
            count: nonnegativeSafeIntegerSchema,
          }).strict().parse(this.#database.query(`
              SELECT COUNT(*) AS count
              FROM chat_provider_thread_archive_attempts_v57
              WHERE target_id = ?1
            `).get(target.target_id)).count;
          if (remainingAttempts !== 0) {
            throw invalidState(
              "Provider-thread archive component attempts could not be deleted",
            );
          }
        }
        for (const cut of cutDeletionOrder) {
          if (cut.cause === "account_removal") {
            this.#assertExactAccountRemovalTombstone(cut);
          }
          this.#database.query(`
            DELETE FROM chat_provider_thread_archive_cut_members_v57
            WHERE cut_id = ?1
              AND EXISTS (
                SELECT 1 FROM chat_provider_thread_archive_cuts_v57
                WHERE cut_id = ?1 AND state = 'contained'
              )
          `).run(cut.cut_id);
          if (this.#memberRows(cut.cut_id).length !== 0) {
            throw invalidState(
              "Provider-thread archive component members could not be deleted",
            );
          }
          this.#database.query(`
            DELETE FROM chat_provider_thread_archive_cuts_v57
            WHERE cut_id = ?1 AND state = 'contained'
              AND NOT EXISTS (
                SELECT 1 FROM chat_provider_thread_archive_attempts_v57
                WHERE cut_id = ?1
              )
              AND NOT EXISTS (
                SELECT 1 FROM chat_provider_thread_archive_cuts_v57
                WHERE predecessor_cut_id = ?1
              )
              AND NOT EXISTS (
                SELECT 1 FROM chat_provider_thread_archive_cut_members_v57
                WHERE cut_id = ?1
              )
          `).run(cut.cut_id);
          if (this.#cutRow(cut.cut_id) !== null) {
            throw invalidState(
              "Provider-thread archive component cut could not be deleted",
            );
          }
        }
      } catch (error: unknown) {
        if (error instanceof ProviderThreadArchiveJournalV57Error) throw error;
        throw sqliteError(
          error,
          "Provider-thread archive terminal component could not be deleted",
        );
      }
      return Object.freeze({
        deletedTargetIds: observed.targetIds,
        deletedCutIds: observed.cutIds,
      });
    })();
  }

  /**
   * Removes the terminal residue of an account-removal cut that never owned a
   * target. The durable account tombstone remains the authority for releasing
   * its admission hold, so it is rechecked in the same SQLite transaction.
   */
  deleteContainedZeroTargetRemovalCutSafely(cutIdValue: string): void {
    const cutId = cutIdSchema.parse(cutIdValue);
    this.#database.transaction(() => {
      const cut = this.#requireCut(cutId);
      const members = this.#memberRows(cutId);
      this.#verifyCut(cut, members);
      if (
        cut.cause !== "account_removal"
        || cut.state !== "contained"
        || cut.target_count !== 0
      ) {
        throw invalidState(
          "Provider-thread archive cut is not a contained zero-target account removal",
        );
      }
      this.#assertExactAccountRemovalTombstone(cut);
      const tombstoneRevision = cut.tombstone_account_profile_revision!;
      const removedAt = cut.tombstone_removed_at!;
      const profilePreimageDigest = cut.tombstone_profile_preimage_digest!;
      try {
        const deletedMembers = this.#database.query(`
          DELETE FROM chat_provider_thread_archive_cut_members_v57
          WHERE cut_id = ?1
            AND EXISTS (
              SELECT 1 FROM chat_provider_thread_archive_cuts_v57 AS cut
              WHERE cut.cut_id = ?1 AND cut.cause = 'account_removal'
                AND cut.state = 'contained' AND cut.target_count = 0
                AND NOT EXISTS (
                  SELECT 1 FROM chat_provider_thread_archive_attempts_v57
                  WHERE cut_id = cut.cut_id
                )
            )
        `).run(cutId);
        if (deletedMembers.changes !== members.length) {
          throw invalidState(
            "Provider-thread archive removal members could not be deleted",
          );
        }
        const deletedCut = this.#database.query(`
          DELETE FROM chat_provider_thread_archive_cuts_v57
          WHERE cut_id = ?1 AND cause = 'account_removal'
            AND state = 'contained' AND target_count = 0
            AND tombstone_account_profile_revision = ?2
            AND tombstone_removed_at = ?3
            AND tombstone_local_data_deleted_at IS ?4
            AND tombstone_profile_preimage_digest = ?5
            AND NOT EXISTS (
              SELECT 1 FROM chat_provider_thread_archive_attempts_v57
              WHERE cut_id = ?1
            )
            AND NOT EXISTS (
              SELECT 1 FROM chat_provider_thread_archive_cut_members_v57
              WHERE cut_id = ?1
            )
            AND EXISTS (
              SELECT 1 FROM account_profiles AS account
              WHERE account.profile_id =
                chat_provider_thread_archive_cuts_v57.account_profile_id
                AND account.revision = ?2
                AND account.process_generation =
                  chat_provider_thread_archive_cuts_v57.source_generation
                AND account.removed_at = ?3
                AND account.local_data_deleted_at IS ?4
            )
        `).run(
          cutId,
          tombstoneRevision,
          removedAt,
          cut.tombstone_local_data_deleted_at,
          profilePreimageDigest,
        );
        if (deletedCut.changes !== 1) {
          throw invalidState(
            "Provider-thread archive removal cut could not be deleted",
          );
        }
      } catch (error: unknown) {
        if (error instanceof ProviderThreadArchiveJournalV57Error) throw error;
        throw sqliteError(
          error,
          "Provider-thread archive removal cut could not be deleted",
        );
      }
    })();
  }

  /**
   * Crash-recovery sweep for terminal authority that no longer belongs in the
   * admission replay inventory. The entire sweep either commits or rolls back.
   */
  deleteAllTerminalAuthoritySafely():
    ProviderThreadArchiveTerminalCleanupV57 {
    return this.#database.transaction(() => {
      const beforeTargetIds = this.#database.query<{
        target_id: string;
      }, []>(`
        SELECT target_id FROM chat_provider_thread_archive_targets_v57
      `).all().map(({ target_id }) => targetIdSchema.parse(target_id));
      const beforeCutIds = this.#database.query<{ cut_id: string }, []>(`
        SELECT cut_id FROM chat_provider_thread_archive_cuts_v57
      `).all().map(({ cut_id }) => cutIdSchema.parse(cut_id));
      const committedTargetIds = this.#database.query<{
        target_id: string;
      }, []>(`
        SELECT target_id FROM chat_provider_thread_archive_targets_v57
        WHERE status = 'committed'
      `).all().map(({ target_id }) => targetIdSchema.parse(target_id))
        .sort(compareCanonicalCodeUnits);
      for (const targetId of committedTargetIds) {
        if (this.#targetRow(targetId) === null) continue;
        const component = this.terminalCleanupComponent(targetId);
        if (!component.allTargetsCommitted) continue;
        this.deleteCommittedTargetSafely(targetId, component);
      }
      const zeroTargetRemovalCutIds = this.#database.query<{
        cut_id: string;
      }, []>(`
        SELECT cut_id FROM chat_provider_thread_archive_cuts_v57
        WHERE cause = 'account_removal' AND state = 'contained'
          AND target_count = 0
      `).all().map(({ cut_id }) => cutIdSchema.parse(cut_id))
        .sort(compareCanonicalCodeUnits);
      for (const cutId of zeroTargetRemovalCutIds) {
        this.deleteContainedZeroTargetRemovalCutSafely(cutId);
      }
      const remainingCutIds = new Set(this.#database.query<{
        cut_id: string;
      }, []>(`
        SELECT cut_id FROM chat_provider_thread_archive_cuts_v57
      `).all().map(({ cut_id }) => cutIdSchema.parse(cut_id)));
      const remainingTargetIds = new Set(this.#database.query<{
        target_id: string;
      }, []>(`
        SELECT target_id FROM chat_provider_thread_archive_targets_v57
      `).all().map(({ target_id }) => targetIdSchema.parse(target_id)));
      const deletedTargetIds = beforeTargetIds.filter((targetId) =>
        !remainingTargetIds.has(targetId)
      ).sort(compareCanonicalCodeUnits);
      const deletedCutIds = beforeCutIds.filter((cutId) =>
        !remainingCutIds.has(cutId)
      ).sort(compareCanonicalCodeUnits);
      return Object.freeze({
        deletedTargetIds: Object.freeze(deletedTargetIds),
        deletedCutIds: Object.freeze(deletedCutIds),
      });
    })();
  }

  reopenTarget(targetIdValue: string): ProviderThreadArchiveTargetSnapshotV57 {
    return this.#database.transaction(() =>
      this.#reopenTargetRow(this.#requireTarget(targetIdSchema.parse(targetIdValue))))();
  }

  assertTargetPreimage(
    targetIdValue: string,
    input: ProviderThreadArchiveTargetPreimageV57,
  ): void {
    const targetId = targetIdSchema.parse(targetIdValue);
    const parsed = parseTargetPreimage(input);
    this.#database.transaction(() => {
      const target = this.#requireTarget(targetId);
      this.#reopenTargetRow(target);
      const observed = {
        paneId: target.pane_id,
        purpose: target.purpose,
        paneRevision: target.pane_revision,
        queueRevision: target.queue_revision,
        paneCasDigest: target.pane_cas_digest,
        queueCasDigest: target.queue_cas_digest,
        accountProfileId: target.account_profile_id,
        accountProfileRevision: target.account_profile_revision,
        threadId: target.thread_id,
        restartThreadId: target.restart_thread_id,
        binding: bindingPreimageFromColumns(target),
      };
      if (canonicalJson(observed) !== canonicalJson(parsed)) {
        throw conflict("Provider-thread archive target preimage does not match");
      }
    })();
  }

  assertMemberPreimage(
    memberIdValue: string,
    input: ProviderThreadArchiveMemberPreimageV57,
  ): void {
    const memberId = memberIdSchema.parse(memberIdValue);
    const parsed = parseMemberPreimage(input);
    this.#database.transaction(() => {
      const member = this.#requireMember(memberId);
      this.#verifyMember(member);
      const observed = {
        paneId: member.pane_id,
        paneRevision: member.pane_revision,
        paneCasDigest: member.pane_cas_digest,
        threadId: member.thread_id,
        restartThreadId: member.restart_thread_id,
        binding: bindingPreimageFromColumns(member),
      };
      if (canonicalJson(observed) !== canonicalJson(parsed)) {
        throw conflict("Provider-thread archive member preimage does not match");
      }
    })();
  }

  admissionDescriptor(targetIdValue: string): ArchiveAdmissionDescriptor {
    const targetId = targetIdSchema.parse(targetIdValue);
    return this.#database.transaction(() => {
      const target = this.#requireTarget(targetId);
      this.#reopenTargetRow(target);
      if (target.status === "committed") {
        throw invalidState("Committed provider-thread archive target needs no admission hold");
      }
      const attempt = this.#requireAttempt(target.current_attempt_id);
      const cut = attempt.cut_id === null ? null : this.#requireCut(attempt.cut_id);
      if (cut !== null) this.#verifyCut(cut, this.#memberRows(cut.cut_id));
      return Object.freeze({
        accountProfileId: target.account_profile_id,
        attemptAuthority: this.#attemptAdmissionAuthority(attempt),
        attemptOrdinal: attempt.ordinal,
        attemptPhase: attempt.state,
        cutAuthority: cut === null ? null : this.#cutAdmissionAuthority(cut),
        expectedGeneration: attempt.generation,
        paneId: target.pane_id,
        purpose: target.purpose,
        restartThreadDigest: archiveRestartThreadDigest(target.restart_thread_id),
        successorGeneration: cut?.successor_generation ?? null,
        targetAuthority: this.#targetAdmissionAuthority(target),
        transitionId: target.target_id,
      } satisfies ArchiveAdmissionDescriptor);
    })();
  }

  recoveryTargets(): readonly ProviderThreadArchiveTargetSnapshotV57[] {
    return this.#database.transaction(() => {
      const values: unknown[] = this.#database.query(`
        SELECT * FROM chat_provider_thread_archive_targets_v57
        WHERE status != 'committed' ORDER BY created_at, target_id
      `).all();
      return values.map((value) => this.#reopenTargetRow(targetRowSchema.parse(value)));
    })();
  }

  recoveryInventory(): ProviderThreadArchiveRecoveryInventoryV57 {
    return this.#database.transaction(() => {
      const targetValues: unknown[] = this.#database.query(`
        SELECT target_id FROM chat_provider_thread_archive_targets_v57
        WHERE status != 'committed' ORDER BY created_at, target_id
      `).all();
      const targetIds = targetValues.map((value) => z.object({
        target_id: targetIdSchema,
      }).strict().parse(value).target_id);
      const targets = targetIds.map((targetId) => this.reopenTarget(targetId));
      const activeValues: unknown[] = this.#database.query(`
        SELECT * FROM chat_provider_thread_archive_cuts_v57
        WHERE state != 'contained'
        ORDER BY created_at, cut_id
      `).all();
      const activeRows = activeValues.map((value) => {
        const cut = cutRowSchema.parse(value);
        const members = this.#memberRows(cut.cut_id);
        this.#verifyCut(cut, members);
        return { cut, snapshot: cutSnapshot(cut, members) };
      });
      const removalRows = activeRows.filter(({ cut }) => cut.cause === "account_removal");
      return Object.freeze({
        admissionDescriptors: Object.freeze(targetIds.map((targetId) =>
          this.admissionDescriptor(targetId)
        )),
        activeCuts: Object.freeze(activeRows.map(({ snapshot }) => snapshot)),
        removalAdmissionDescriptors: Object.freeze(removalRows.map(({ cut }) =>
          Object.freeze({
            accountProfileId: cut.account_profile_id,
            cutAuthority: this.#cutAdmissionAuthority(cut),
            expectedGeneration: cut.source_generation,
            transitionId: cut.cut_id,
          } satisfies AccountRemovalAdmissionDescriptor)
        )),
        removalCuts: Object.freeze(removalRows.map(({ snapshot }) => snapshot)),
        targets: Object.freeze(targets),
      });
    })();
  }

  reopenCut(cutIdValue: string): ProviderThreadArchiveCutSnapshotV57 {
    const cutId = cutIdSchema.parse(cutIdValue);
    return this.#database.transaction(() => {
      const cut = this.#requireCut(cutId);
      const members = this.#memberRows(cutId);
      this.#verifyCut(cut, members);
      return cutSnapshot(cut, members);
    })();
  }

  recoveryCuts(accountProfileIdValue: string): readonly ProviderThreadArchiveCutSnapshotV57[] {
    const accountProfileId = accountIdSchema.parse(accountProfileIdValue);
    return this.#database.transaction(() => {
      const values: unknown[] = this.#database.query(`
        SELECT * FROM chat_provider_thread_archive_cuts_v57
        WHERE account_profile_id = ?1 AND state != 'contained'
        ORDER BY created_at, cut_id
      `).all(accountProfileId);
      return values.map((value) => {
        const cut = cutRowSchema.parse(value);
        const members = this.#memberRows(cut.cut_id);
        this.#verifyCut(cut, members);
        return cutSnapshot(cut, members);
      });
    })();
  }

  #recordApplied(input: Readonly<{
    attemptId: string;
    responseGeneration: number;
    responseStreamPosition: number;
    outcomeEvidenceDigest: string;
    outcomeRevisionDigest: string;
    now: Date;
  }>, state: "direct_applied" | "reconciled_applied"): ProviderThreadArchiveAttemptSnapshotV57 {
    const attemptId = attemptIdSchema.parse(input.attemptId);
    const responseGeneration = positiveSafeIntegerSchema.parse(input.responseGeneration);
    const responseStreamPosition = nonnegativeSafeIntegerSchema.parse(input.responseStreamPosition);
    const evidenceDigest = hexDigestSchema.parse(input.outcomeEvidenceDigest);
    const revisionDigest = hexDigestSchema.parse(input.outcomeRevisionDigest);
    const at = parseDate(input.now);
    return this.#database.transaction(() => {
      const attempt = this.#requireAttempt(attemptId);
      this.#verifyAttempt(attempt);
      if (state === "direct_applied") {
        if (attempt.state !== "effect_started" || attempt.cut_id !== null
          || responseGeneration !== attempt.generation) {
          throw invalidState("Direct provider-thread archive outcome is incoherent");
        }
      } else {
        if (attempt.state !== "ambiguous" || attempt.cut_id === null) {
          throw invalidState("Provider-thread archive attempt is not reconcilable");
        }
        const cut = this.#requireCut(attempt.cut_id);
        this.#verifyCut(cut, this.#memberRows(cut.cut_id));
        if (cut.state !== "contained" || cut.successor_generation !== responseGeneration) {
          throw invalidState("Reconciled provider-thread archive lacks exact containment");
        }
      }
      const outcomeHmac = this.#hmac("attempt-outcome", {
        identity: attemptIdentityPayloadFromRow(attempt),
        cutId: attempt.cut_id,
        state,
        outcomeEvidenceDigest: evidenceDigest,
        outcomeRevisionDigest: revisionDigest,
        responseGeneration,
        responseStreamPosition,
        outcomeAt: at,
      });
      this.#updateOne(`
        UPDATE chat_provider_thread_archive_attempts_v57 SET
          state = ?2, outcome_evidence_digest = ?3,
          outcome_revision_digest = ?4, response_generation = ?5,
          response_stream_position = ?6, outcome_at = ?7, outcome_hmac = ?8
        WHERE attempt_id = ?1 AND state = ?9
      `, [
        attemptId,
        state,
        evidenceDigest,
        revisionDigest,
        responseGeneration,
        responseStreamPosition,
        at,
        outcomeHmac,
        state === "direct_applied" ? "effect_started" : "ambiguous",
      ], "Provider-thread archive applied outcome could not be recorded");
      return attemptSnapshot(this.#requireAttempt(attemptId));
    })();
  }

  #targetAdmissionAuthority(target: TargetRow): ArchiveAdmissionAuthority {
    return Object.freeze({
      hmac: this.#hmac("admission-target-authority", {
        identityHmac: target.identity_hmac,
        pointerHmac: target.pointer_hmac,
        status: target.status,
        accountContainmentHmac: target.account_containment_hmac,
        commitHmac: target.commit_hmac,
      }),
      revision: target.current_attempt_ordinal,
    });
  }

  #attemptAdmissionAuthority(attempt: AttemptRow): ArchiveAdmissionAuthority {
    return Object.freeze({
      hmac: this.#hmac("admission-attempt-authority", {
        identityHmac: attempt.identity_hmac,
        cutBindingHmac: attempt.cut_binding_hmac,
        effectHmac: attempt.effect_hmac,
        ambiguityHmac: attempt.ambiguity_hmac,
        outcomeHmac: attempt.outcome_hmac,
        accountContainmentHmac: attempt.account_containment_hmac,
        state: attempt.state,
      }),
      revision: attemptAuthorityRevision(attempt),
    });
  }

  #cutAdmissionAuthority(cut: CutRow): ArchiveAdmissionAuthority {
    return Object.freeze({
      hmac: this.#hmac("admission-cut-authority", {
        identityHmac: cut.identity_hmac,
        fenceHmac: cut.fence_hmac,
        sealHmac: cut.seal_hmac,
        containmentHmac: cut.containment_hmac,
        tombstoneHmac: cut.tombstone_hmac,
        state: cut.state,
      }),
      revision: cutAuthorityRevision(cut),
    });
  }

  #reopenTargetRow(target: TargetRow): ProviderThreadArchiveTargetSnapshotV57 {
    this.#verifyTarget(target);
    const values: unknown[] = this.#database.query(`
      SELECT * FROM chat_provider_thread_archive_attempts_v57
      WHERE target_id = ?1 ORDER BY ordinal
    `).all(target.target_id);
    const attempts = values.map((value) => attemptRowSchema.parse(value));
    if (attempts.length === 0 || attempts.length > PROVIDER_THREAD_ARCHIVE_MAX_ATTEMPTS_PER_TARGET_V57) {
      throw corrupt("Provider-thread archive target has an invalid attempt count");
    }
    for (const attempt of attempts) this.#verifyAttempt(attempt);
    const verifiedCuts = new Map<string, CutRow>();
    for (const attempt of attempts) {
      if (attempt.cut_id === null || verifiedCuts.has(attempt.cut_id)) continue;
      const cut = this.#requireCut(attempt.cut_id);
      this.#verifyCut(cut, this.#memberRows(cut.cut_id));
      verifiedCuts.set(cut.cut_id, cut);
    }
    const current = attempts.find((attempt) =>
      attempt.attempt_id === target.current_attempt_id
      && attempt.ordinal === target.current_attempt_ordinal
    );
    if (current === undefined || current.ordinal !== attempts.length) {
      throw corrupt("Provider-thread archive current attempt pointer is invalid");
    }
    for (let index = 0; index < attempts.length; index += 1) {
      const attempt = attempts[index]!;
      const predecessor = attempts[index - 1];
      if (
        attempt.ordinal !== index + 1
        || (predecessor === undefined
          ? attempt.predecessor_attempt_id !== null
          : attempt.predecessor_attempt_id !== predecessor.attempt_id
            || attempt.generation <= predecessor.generation
            || !["reconciled_not_applied", "abandoned_pre_effect"]
              .includes(predecessor.state))
      ) {
        throw corrupt("Provider-thread archive attempt lineage is invalid");
      }
    }
    const expectedPointer = this.#hmac("target-pointer", {
      targetIdentity: targetIdentityPayloadFromRow(target),
      currentAttemptId: target.current_attempt_id,
      currentAttemptOrdinal: target.current_attempt_ordinal,
    });
    this.#assertHmac(target.pointer_hmac, expectedPointer, "target pointer");
    const currentCut = current.cut_id === null ? null : verifiedCuts.get(current.cut_id) ?? null;
    if (target.account_containment_hmac !== null) {
      if (current.state !== "account_contained" || current.cut_id === null) {
        throw corrupt("Account-contained provider-thread archive target lacks its attempt");
      }
      const cut = currentCut!;
      if (
        cut.cause !== "account_removal"
        || !["removal_awaiting_tombstone", "contained"].includes(cut.state)
      ) {
        throw corrupt("Account-contained provider-thread archive target lacks its removal cut");
      }
      this.#assertHmac(
        target.account_containment_hmac,
        this.#hmac("target-account-containment", {
          identity: targetIdentityPayloadFromRow(target),
          pointerHmac: target.pointer_hmac,
          attemptId: current.attempt_id,
          attemptAccountContainmentHmac: current.account_containment_hmac,
          cutId: cut.cut_id,
          cutContainmentHmac: cut.containment_hmac,
          accountContainmentEvidenceDigest: target.account_containment_evidence_digest,
          accountContainmentRevisionDigest: target.account_containment_revision_digest,
          accountContainedAt: target.account_contained_at,
        }),
        "target account containment",
      );
    }
    if (target.status === "committed") {
      const expectedCommit = this.#hmac("target-commit", {
        identity: targetIdentityPayloadFromRow(target),
        pointerHmac: target.pointer_hmac,
        currentAttemptId: target.current_attempt_id,
        currentAttemptOrdinal: target.current_attempt_ordinal,
        currentAttemptAuthorityHmac: this.#attemptAdmissionAuthority(current).hmac,
        accountContainmentHmac: target.account_containment_hmac,
        status: "committed",
        commitEvidenceDigest: target.commit_evidence_digest,
        commitRevisionDigest: target.commit_revision_digest,
        committedAt: target.committed_at,
      });
      this.#assertHmac(target.commit_hmac, expectedCommit, "target commit");
      if (
        current.state !== "account_contained"
        && current.state !== "direct_applied"
        && current.state !== "reconciled_applied"
      ) {
        throw corrupt("Committed provider-thread archive target lacks an applied attempt");
      }
    }
    return {
      targetId: target.target_id,
      paneId: target.pane_id,
      purpose: target.purpose,
      status: target.status,
      currentAttempt: attemptSnapshot(current),
      attempts: attempts.map(attemptSnapshot),
    };
  }

  #verifyTarget(target: TargetRow): void {
    const expected = this.#hmac("target-identity", targetIdentityPayloadFromRow(target));
    this.#assertHmac(target.identity_hmac, expected, "target identity");
    const accountContainmentPresent = receiptGroupPresence(
      "target account containment",
      [
        target.account_containment_evidence_digest,
        target.account_containment_revision_digest,
        target.account_containment_hmac,
        target.account_contained_at,
      ],
    );
    const commitPresent = receiptGroupPresence("target commit", [
      target.commit_evidence_digest,
      target.commit_revision_digest,
      target.commit_hmac,
      target.committed_at,
    ]);
    const derivedStatus: TargetRow["status"] = commitPresent
      ? "committed"
      : accountContainmentPresent
      ? "account_contained"
      : "open";
    if (target.status !== derivedStatus) {
      throw corrupt(
        "Provider-thread archive target status contradicts its receipt topology",
      );
    }
  }

  #verifyAttempt(attempt: AttemptRow): void {
    this.#assertHmac(
      attempt.identity_hmac,
      this.#hmac("attempt-identity", attemptIdentityPayloadFromRow(attempt)),
      "attempt identity",
    );
    const receiptState = this.#deriveAttemptReceiptState(attempt);
    if (attempt.cut_id !== null) {
      this.#assertHmac(
        attempt.cut_binding_hmac,
        this.#hmac("attempt-cut-binding", {
          identity: attemptIdentityPayloadFromRow(attempt),
          cutId: attempt.cut_id,
        }),
        "attempt cut binding",
      );
    }
    if (attempt.effect_hmac !== null) {
      this.#assertHmac(
        attempt.effect_hmac,
        this.#hmac("attempt-effect", {
          identity: attemptIdentityPayloadFromRow(attempt),
          state: "effect_started",
          effectEvidenceDigest: attempt.effect_evidence_digest,
          effectRevisionDigest: attempt.effect_revision_digest,
          effectStartedAt: attempt.effect_started_at,
        }),
        "attempt effect",
      );
    }
    if (attempt.ambiguity_hmac !== null) {
      this.#assertHmac(
        attempt.ambiguity_hmac,
        this.#hmac("attempt-ambiguity", {
          identity: attemptIdentityPayloadFromRow(attempt),
          cutId: attempt.cut_id,
          state: "ambiguous",
          ambiguityEvidenceDigest: attempt.ambiguity_evidence_digest,
          ambiguityRevisionDigest: attempt.ambiguity_revision_digest,
          ambiguousAt: attempt.ambiguous_at,
        }),
        "attempt ambiguity",
      );
    }
    if (
      [
        "direct_applied",
        "reconciled_applied",
        "reconciled_not_applied",
        "abandoned_pre_effect",
      ].includes(receiptState)
    ) {
      const receiptCutId = receiptState === "direct_applied"
          || receiptState === "abandoned_pre_effect"
        ? null
        : attempt.cut_id;
      this.#assertHmac(
        attempt.outcome_hmac,
        this.#hmac("attempt-outcome", {
          identity: attemptIdentityPayloadFromRow(attempt),
          cutId: receiptCutId,
          state: receiptState,
          outcomeEvidenceDigest: attempt.outcome_evidence_digest,
          outcomeRevisionDigest: attempt.outcome_revision_digest,
          responseGeneration: attempt.response_generation,
          responseStreamPosition: attempt.response_stream_position,
          outcomeAt: attempt.outcome_at,
        }),
        "attempt outcome",
      );
    }
    const accountReceiptPresent = receiptGroupPresence(
      "attempt account containment",
      [
        attempt.account_containment_prior_state,
        attempt.account_containment_evidence_digest,
        attempt.account_containment_revision_digest,
        attempt.account_contained_at,
        attempt.account_containment_hmac,
      ],
    );
    if (accountReceiptPresent) {
      if (
        attempt.state !== "account_contained"
        || attempt.account_containment_prior_state !== receiptState
        || attempt.cut_id === null
      ) {
        throw corrupt("Provider-thread archive account-contained attempt lacks authority");
      }
      const cut = this.#requireCut(attempt.cut_id);
      if (
        cut.cause !== "account_removal"
        || !["removal_awaiting_tombstone", "contained"].includes(cut.state)
      ) {
        throw corrupt("Provider-thread archive account-contained attempt lacks its removal cut");
      }
      this.#assertHmac(
        attempt.account_containment_hmac,
        this.#hmac("attempt-account-containment", {
          identity: attemptIdentityPayloadFromRow(attempt),
          cutId: attempt.cut_id,
          cutContainmentHmac: cut.containment_hmac,
          priorState: attempt.account_containment_prior_state,
          cutBindingHmac: attempt.cut_binding_hmac,
          effectHmac: attempt.effect_hmac,
          ambiguityHmac: attempt.ambiguity_hmac,
          outcomeHmac: attempt.outcome_hmac,
          accountContainmentEvidenceDigest: attempt.account_containment_evidence_digest,
          accountContainmentRevisionDigest: attempt.account_containment_revision_digest,
          accountContainedAt: attempt.account_contained_at,
        }),
        "attempt account containment",
      );
    } else if (
      attempt.state === "account_contained"
      || attempt.account_containment_prior_state !== null
      || attempt.state !== receiptState
    ) {
      throw corrupt(
        "Provider-thread archive attempt state contradicts its receipt topology",
      );
    }
  }

  #deriveAttemptReceiptState(
    attempt: AttemptRow,
  ): Exclude<ProviderThreadArchiveAttemptStateV57, "account_contained"> {
    const effectPresent = receiptGroupPresence("attempt effect", [
      attempt.effect_evidence_digest,
      attempt.effect_revision_digest,
      attempt.effect_started_at,
      attempt.effect_hmac,
    ]);
    const ambiguityPresent = receiptGroupPresence("attempt ambiguity", [
      attempt.ambiguity_evidence_digest,
      attempt.ambiguity_revision_digest,
      attempt.ambiguous_at,
      attempt.ambiguity_hmac,
    ]);
    const outcomePresent = receiptGroupPresence("attempt outcome", [
      attempt.outcome_evidence_digest,
      attempt.outcome_revision_digest,
      attempt.outcome_at,
      attempt.outcome_hmac,
    ]);
    if (ambiguityPresent && !effectPresent) {
      throw corrupt("Provider-thread archive ambiguity lacks an effect receipt");
    }
    if (
      (attempt.response_generation === null)
      !== (attempt.response_stream_position === null)
    ) {
      throw corrupt("Provider-thread archive response receipt is partial");
    }
    if (!outcomePresent) {
      if (
        attempt.response_generation !== null
        || attempt.response_stream_position !== null
      ) {
        throw corrupt("Provider-thread archive response lacks an outcome receipt");
      }
      return ambiguityPresent
        ? "ambiguous"
        : effectPresent
        ? "effect_started"
        : "prepared";
    }

    const candidates: readonly Exclude<
      ProviderThreadArchiveAttemptStateV57,
      "prepared" | "effect_started" | "ambiguous" | "account_contained"
    >[] = attempt.response_generation !== null
      ? ambiguityPresent
        ? ["reconciled_applied"]
        : effectPresent
        ? ["direct_applied"]
        : []
      : ambiguityPresent || effectPresent
      ? ["reconciled_not_applied"]
      : attempt.cut_id === null
      ? ["abandoned_pre_effect"]
      : ["abandoned_pre_effect", "reconciled_not_applied"];
    const matches = candidates.filter((candidate) => {
      const receiptCutId = candidate === "direct_applied"
          || candidate === "abandoned_pre_effect"
        ? null
        : attempt.cut_id;
      const expected = this.#hmac("attempt-outcome", {
        identity: attemptIdentityPayloadFromRow(attempt),
        cutId: receiptCutId,
        state: candidate,
        outcomeEvidenceDigest: attempt.outcome_evidence_digest,
        outcomeRevisionDigest: attempt.outcome_revision_digest,
        responseGeneration: attempt.response_generation,
        responseStreamPosition: attempt.response_stream_position,
        outcomeAt: attempt.outcome_at,
      });
      return attempt.outcome_hmac !== null
        && safeHexEqual(attempt.outcome_hmac, expected);
    });
    if (matches.length !== 1) {
      throw corrupt("Provider-thread archive attempt outcome receipt is invalid");
    }
    return matches[0]!;
  }

  #verifyCut(cut: CutRow, members: readonly MemberRow[]): void {
    this.#assertHmac(
      cut.identity_hmac,
      this.#hmac("cut-identity", cutIdentityPayloadFromRow(cut)),
      "cut identity",
    );
    const derivedState = this.#deriveCutReceiptState(cut);
    if (cut.state !== derivedState) {
      throw corrupt(
        "Provider-thread archive cut state contradicts its receipt topology",
      );
    }
    for (const member of members) this.#verifyMember(member);
    this.#assertCutTargetInventory(cut, false, members);
    if (cut.state !== "fence_started") {
      this.#assertHmac(
        cut.fence_hmac,
        this.#hmac("cut-fence", {
          identity: cutIdentityPayloadFromRow(cut),
          state: "fenced",
          successorGeneration: cut.successor_generation,
          successorAccountProfileRevision:
            cut.successor_account_profile_revision,
          fenceEvidenceDigest: cut.fence_evidence_digest,
          fenceRevisionDigest: cut.fence_revision_digest,
          fencedAt: cut.fenced_at,
        }),
        "cut fence",
      );
    }
    if (["sealed", "removal_awaiting_tombstone", "contained"].includes(cut.state)) {
      const inventoryDigest = completeInventorySha256FromRows(members);
      if (cut.member_count !== members.length || cut.inventory_digest === null
        || cut.enumeration_authority_digest === null
        || !safeHexEqual(cut.inventory_digest, inventoryDigest)) {
        throw corrupt("Provider-thread archive sealed inventory is inconsistent");
      }
      this.#assertHmac(
        cut.seal_hmac,
        this.#hmac("cut-seal", {
          identity: cutIdentityPayloadFromRow(cut),
          state: "sealed",
          successorGeneration: cut.successor_generation,
          successorAccountProfileRevision:
            cut.successor_account_profile_revision,
          memberCount: cut.member_count,
          inventoryDigest,
          enumerationAuthorityDigest: cut.enumeration_authority_digest,
          sealRevisionDigest: cut.seal_revision_digest,
          sealedAt: cut.sealed_at,
        }),
        "cut seal",
      );
    }
    if (["removal_awaiting_tombstone", "contained"].includes(cut.state)) {
      if (members.some((member) => member.state !== "settled")) {
        throw corrupt("Provider-thread archive contained cut has an unsettled member");
      }
      const settlementDigest = settlementInventorySha256(members);
      if (cut.settlement_inventory_digest === null
        || !safeHexEqual(cut.settlement_inventory_digest, settlementDigest)) {
        throw corrupt("Provider-thread archive settlement inventory is inconsistent");
      }
      this.#assertHmac(
        cut.containment_hmac,
        this.#hmac("cut-containment", {
          identity: cutIdentityPayloadFromRow(cut),
          state: cut.cause === "account_removal"
            ? "removal_awaiting_tombstone"
            : "contained",
          successorGeneration: cut.successor_generation,
          successorAccountProfileRevision:
            cut.successor_account_profile_revision,
          memberCount: cut.member_count,
          inventoryDigest: cut.inventory_digest,
          enumerationAuthorityDigest: cut.enumeration_authority_digest,
          fenceHmac: cut.fence_hmac,
          sealHmac: cut.seal_hmac,
          settlementInventoryDigest: settlementDigest,
          containmentEvidenceDigest: cut.containment_evidence_digest,
          containmentRevisionDigest: cut.containment_revision_digest,
          containedAt: cut.contained_at,
        }),
        "cut containment",
      );
    }
    if (cut.cause === "account_removal" && cut.state === "contained") {
      this.#assertHmac(
        cut.tombstone_hmac,
        this.#hmac("cut-tombstone", {
          identity: cutIdentityPayloadFromRow(cut),
          containmentHmac: cut.containment_hmac,
          state: "contained",
          tombstoneEvidenceDigest: cut.tombstone_evidence_digest,
          tombstoneRevisionDigest: cut.tombstone_revision_digest,
          accountProfileRevision:
            cut.tombstone_account_profile_revision,
          removedAt: cut.tombstone_removed_at,
          localDataDeletedAt: cut.tombstone_local_data_deleted_at,
          profilePreimageDigest:
            cut.tombstone_profile_preimage_digest,
          tombstonedAt: cut.tombstoned_at,
        }),
        "cut tombstone",
      );
    }
  }

  #deriveCutReceiptState(cut: CutRow): ProviderThreadArchiveCutStateV57 {
    const fencePresent = receiptGroupPresence("cut fence", [
      cut.fence_evidence_digest,
      cut.fence_revision_digest,
      cut.fenced_at,
      cut.fence_hmac,
    ]);
    const sealPresent = receiptGroupPresence("cut seal", [
      cut.member_count,
      cut.inventory_digest,
      cut.enumeration_authority_digest,
      cut.seal_revision_digest,
      cut.sealed_at,
      cut.seal_hmac,
    ]);
    const containmentPresent = receiptGroupPresence("cut containment", [
      cut.settlement_inventory_digest,
      cut.containment_evidence_digest,
      cut.containment_revision_digest,
      cut.contained_at,
      cut.containment_hmac,
    ]);
    const tombstonePresent = receiptGroupPresence("cut tombstone", [
      cut.tombstone_evidence_digest,
      cut.tombstone_revision_digest,
      cut.tombstone_account_profile_revision,
      cut.tombstone_removed_at,
      cut.tombstone_profile_preimage_digest,
      cut.tombstoned_at,
      cut.tombstone_hmac,
    ]);
    if (
      (!fencePresent && (sealPresent || containmentPresent || tombstonePresent))
      || (!sealPresent && (containmentPresent || tombstonePresent))
      || (!containmentPresent && tombstonePresent)
      || (!tombstonePresent && cut.tombstone_local_data_deleted_at !== null)
    ) {
      throw corrupt("Provider-thread archive cut receipt topology is discontinuous");
    }
    if (!fencePresent) {
      if (
        cut.successor_generation !== null
        || cut.successor_account_profile_revision !== null
      ) {
        throw corrupt("Provider-thread archive unfenced cut invented a successor");
      }
      return "fence_started";
    }
    if (cut.cause === "account_removal") {
      if (
        cut.successor_generation !== null
        || cut.successor_account_profile_revision !== null
      ) {
        throw corrupt("Provider-thread archive removal invented a successor");
      }
    } else if (
      cut.successor_generation !== cut.source_generation + 1
      || cut.successor_account_profile_revision === null
    ) {
      throw corrupt("Provider-thread archive fence successor is incoherent");
    }
    if (!sealPresent) return "fenced";
    if (!containmentPresent) return "sealed";
    if (cut.cause === "account_removal") {
      return tombstonePresent ? "contained" : "removal_awaiting_tombstone";
    }
    if (tombstonePresent || cut.tombstone_local_data_deleted_at !== null) {
      throw corrupt("Provider-thread archive non-removal cut invented a tombstone");
    }
    return "contained";
  }

  #verifyMember(member: MemberRow): void {
    this.#assertHmac(
      member.identity_hmac,
      this.#hmac("member-identity", memberIdentityPayloadFromRow(member)),
      "member identity",
    );
    const settlementPresent = receiptGroupPresence("member settlement", [
      member.settlement_evidence_digest,
      member.settlement_revision_digest,
      member.settled_at,
      member.settlement_hmac,
    ]);
    if (
      member.state !== (settlementPresent ? "settled" : "pending")
    ) {
      throw corrupt(
        "Provider-thread archive member state contradicts its receipt topology",
      );
    }
    if (settlementPresent) {
      this.#assertHmac(
        member.settlement_hmac,
        this.#hmac("member-settlement", {
          identity: memberIdentityPayloadFromRow(member),
          state: "settled",
          settlementEvidenceDigest: member.settlement_evidence_digest,
          settlementRevisionDigest: member.settlement_revision_digest,
          settledAt: member.settled_at,
        }),
        "member settlement",
      );
    }
  }

  #hmac(domain: string, payload: unknown): string {
    return createHmac("sha256", this.#receiptKey)
      .update(`hra-provider-thread-archive-v57.${domain}\0`)
      .update(canonicalJson(payload))
      .digest("hex");
  }

  #assertHmac(observed: string | null, expected: string, label: string): void {
    if (observed === null || !safeHexEqual(observed, expected)) {
      throw corrupt(`Provider-thread archive ${label} receipt is invalid`);
    }
  }

  #terminalCleanupComponentRows(
    targetId: string,
  ): TerminalCleanupComponentRowsV57 {
    const requested = this.#requireTarget(targetId);
    this.#reopenTargetRow(requested);
    const values: unknown[] = this.#database.query(`
      WITH RECURSIVE
      edges(from_kind, from_id, to_kind, to_id) AS (
        SELECT 'target', attempt.target_id, 'cut', attempt.cut_id
        FROM chat_provider_thread_archive_attempts_v57 AS attempt
        WHERE attempt.cut_id IS NOT NULL
        UNION ALL
        SELECT 'cut', attempt.cut_id, 'target', attempt.target_id
        FROM chat_provider_thread_archive_attempts_v57 AS attempt
        WHERE attempt.cut_id IS NOT NULL
        UNION ALL
        SELECT 'cut', cut.cut_id, 'cut', cut.predecessor_cut_id
        FROM chat_provider_thread_archive_cuts_v57 AS cut
        WHERE cut.predecessor_cut_id IS NOT NULL
        UNION ALL
        SELECT 'cut', cut.predecessor_cut_id, 'cut', cut.cut_id
        FROM chat_provider_thread_archive_cuts_v57 AS cut
        WHERE cut.predecessor_cut_id IS NOT NULL
      ),
      component(kind, id) AS (
        SELECT 'target', ?1
        UNION
        SELECT edge.to_kind, edge.to_id
        FROM component AS node
        JOIN edges AS edge
          ON edge.from_kind = node.kind AND edge.from_id = node.id
      )
      SELECT kind, id FROM component ORDER BY kind, id
    `).all(targetId);
    const targetIds: string[] = [];
    const cutIds: string[] = [];
    for (const value of values) {
      const node = z.object({
        kind: z.enum(["target", "cut"]),
        id: z.string(),
      }).strict().parse(value);
      if (node.kind === "target") {
        targetIds.push(targetIdSchema.parse(node.id));
      } else {
        cutIds.push(cutIdSchema.parse(node.id));
      }
    }
    targetIds.sort(compareCanonicalCodeUnits);
    cutIds.sort(compareCanonicalCodeUnits);
    if (!targetIds.includes(targetId) || new Set(targetIds).size !== targetIds.length
      || new Set(cutIds).size !== cutIds.length) {
      throw corrupt(
        "Provider-thread archive terminal cleanup component is not canonical",
      );
    }
    const targets = targetIds.map((componentTargetId) => {
      const target = this.#requireTarget(componentTargetId);
      this.#reopenTargetRow(target);
      return target;
    });
    const cuts = cutIds.map((cutId) => {
      const cut = this.#requireCut(cutId);
      this.#verifyCut(cut, this.#memberRows(cutId));
      return cut;
    });
    if (
      targets.some((target) =>
        target.account_profile_id !== requested.account_profile_id
      )
      || cuts.some((cut) =>
        cut.account_profile_id !== requested.account_profile_id
      )
    ) {
      throw corrupt(
        "Provider-thread archive terminal cleanup crossed account lineages",
      );
    }
    return Object.freeze({
      accountProfileId: requested.account_profile_id,
      targets: Object.freeze(targets),
      cuts: Object.freeze(cuts),
    });
  }

  #terminalCleanupComponentSnapshot(
    component: TerminalCleanupComponentRowsV57,
  ): ProviderThreadArchiveTerminalCleanupComponentV57 {
    return Object.freeze({
      accountProfileId: component.accountProfileId,
      targetIds: Object.freeze(component.targets.map(({ target_id }) =>
        target_id
      )),
      cutIds: Object.freeze(component.cuts.map(({ cut_id }) => cut_id)),
      allTargetsCommitted: component.targets.every(({ status }) =>
        status === "committed"
      ),
    });
  }

  #parseTerminalCleanupComponent(
    input: ProviderThreadArchiveTerminalCleanupComponentV57,
  ): ProviderThreadArchiveTerminalCleanupComponentV57 {
    const targetIds = input.targetIds.map((targetId) =>
      targetIdSchema.parse(targetId)
    );
    const cutIds = input.cutIds.map((cutId) => cutIdSchema.parse(cutId));
    const canonicalTargetIds = [...targetIds].sort(compareCanonicalCodeUnits);
    const canonicalCutIds = [...cutIds].sort(compareCanonicalCodeUnits);
    if (
      targetIds.length === 0
      || new Set(targetIds).size !== targetIds.length
      || new Set(cutIds).size !== cutIds.length
      || !canonicalStringArraysEqual(targetIds, canonicalTargetIds)
      || !canonicalStringArraysEqual(cutIds, canonicalCutIds)
    ) {
      throw new TypeError(
        "Provider-thread archive terminal cleanup snapshot is not canonical",
      );
    }
    return Object.freeze({
      accountProfileId: accountIdSchema.parse(input.accountProfileId),
      targetIds: Object.freeze(targetIds),
      cutIds: Object.freeze(cutIds),
      allTargetsCommitted: z.boolean().parse(input.allTargetsCommitted),
    });
  }

  #terminalCutDeletionOrder(cuts: readonly CutRow[]): readonly CutRow[] {
    if (cuts.some(({ state }) => state !== "contained")) {
      throw corrupt(
        "Provider-thread archive terminal component retained a non-contained cut",
      );
    }
    const cutsById = new Map(cuts.map((cut) => [cut.cut_id, cut]));
    const children = new Map<string, string[]>();
    for (const cut of cuts) {
      if (cut.predecessor_cut_id === null) continue;
      if (!cutsById.has(cut.predecessor_cut_id)) {
        throw corrupt(
          "Provider-thread archive terminal component lost a predecessor cut",
        );
      }
      const existing = children.get(cut.predecessor_cut_id) ?? [];
      existing.push(cut.cut_id);
      existing.sort(compareCanonicalCodeUnits);
      children.set(cut.predecessor_cut_id, existing);
    }
    const ordered: CutRow[] = [];
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (cutId: string): void => {
      if (visited.has(cutId)) return;
      if (visiting.has(cutId)) {
        throw corrupt("Provider-thread archive cut cleanup lineage is cyclic");
      }
      visiting.add(cutId);
      for (const childId of children.get(cutId) ?? []) visit(childId);
      visiting.delete(cutId);
      visited.add(cutId);
      ordered.push(cutsById.get(cutId)!);
    };
    for (const cutId of [...cutsById.keys()].sort(compareCanonicalCodeUnits)) {
      visit(cutId);
    }
    return Object.freeze(ordered);
  }

  #assertExactAccountRemovalTombstone(cut: CutRow): void {
    const tombstoneRevision = cut.tombstone_account_profile_revision;
    const removedAt = cut.tombstone_removed_at;
    const profilePreimageDigest = cut.tombstone_profile_preimage_digest;
    if (
      cut.cause !== "account_removal"
      || cut.state !== "contained"
      || tombstoneRevision === null
      || removedAt === null
      || profilePreimageDigest === null
    ) {
      throw corrupt(
        "Provider-thread archive removal lost its durable tombstone authority",
      );
    }
    const profile = this.#accountProfile(cut.account_profile_id);
    const exactProfilePreimage = profile.removed_at === null
      ? null
      : providerThreadArchiveAccountTombstonePreimageDigestV57({
          accountProfileId: profile.profile_id,
          accountProfileRevision: profile.revision,
          processGeneration: profile.process_generation,
          removedAt: profile.removed_at,
          localDataDeletedAt: profile.local_data_deleted_at,
        });
    if (
      profile.revision !== tombstoneRevision
      || profile.process_generation !== cut.source_generation
      || profile.removed_at !== removedAt
      || profile.local_data_deleted_at !== cut.tombstone_local_data_deleted_at
      || exactProfilePreimage === null
      || !safeHexEqual(profilePreimageDigest, exactProfilePreimage)
    ) {
      throw invalidState(
        "Provider-thread archive removal lacks its exact durable account tombstone",
      );
    }
  }

  #accountProfile(accountProfileId: string): z.infer<
    typeof accountProfileAuthorityRowSchema
  > {
    const value: unknown = this.#database.query(`
      SELECT profile_id, revision, process_generation,
        removed_at, local_data_deleted_at
      FROM account_profiles WHERE profile_id = ?1
    `).get(accountProfileId);
    if (value === null) {
      throw invalidState("Provider-thread archive account profile is missing");
    }
    return accountProfileAuthorityRowSchema.parse(value);
  }

  #requireActiveProfileGeneration(input: Readonly<{
    accountProfileId: string;
    accountProfileRevision: number;
    generation: number;
  }>): void {
    const profile = this.#accountProfile(input.accountProfileId);
    if (
      profile.revision !== input.accountProfileRevision
      || profile.process_generation !== input.generation
      || profile.removed_at !== null
    ) {
      throw invalidState(
        "Provider-thread archive generation lacks its exact active profile revision",
      );
    }
  }

  #targetRow(targetId: string): TargetRow | null {
    const value: unknown = this.#database.query(`
      SELECT * FROM chat_provider_thread_archive_targets_v57 WHERE target_id = ?1
    `).get(targetId);
    return value === null ? null : targetRowSchema.parse(value);
  }

  #requireTarget(targetId: string): TargetRow {
    const value = this.#targetRow(targetId);
    if (value === null) throw notFound("Provider-thread archive target was not found");
    return value;
  }

  #requireAttempt(attemptId: string): AttemptRow {
    const value: unknown = this.#database.query(`
      SELECT * FROM chat_provider_thread_archive_attempts_v57 WHERE attempt_id = ?1
    `).get(attemptId);
    if (value === null) throw notFound("Provider-thread archive attempt was not found");
    return attemptRowSchema.parse(value);
  }

  #attemptRowForTargetOrdinal(targetId: string, ordinal: number): AttemptRow | null {
    const value: unknown = this.#database.query(`
      SELECT * FROM chat_provider_thread_archive_attempts_v57
      WHERE target_id = ?1 AND ordinal = ?2
    `).get(targetId, ordinal);
    if (value === null) return null;
    const attempt = attemptRowSchema.parse(value);
    this.#verifyAttempt(attempt);
    return attempt;
  }

  #cutRow(cutId: string): CutRow | null {
    const value: unknown = this.#database.query(`
      SELECT * FROM chat_provider_thread_archive_cuts_v57 WHERE cut_id = ?1
    `).get(cutId);
    return value === null ? null : cutRowSchema.parse(value);
  }

  #requireCut(cutId: string): CutRow {
    const value = this.#cutRow(cutId);
    if (value === null) throw notFound("Provider-thread archive cut was not found");
    return value;
  }

  #memberRow(memberId: string): MemberRow | null {
    const value: unknown = this.#database.query(`
      SELECT * FROM chat_provider_thread_archive_cut_members_v57 WHERE member_id = ?1
    `).get(memberId);
    return value === null ? null : memberRowSchema.parse(value);
  }

  #requireMember(memberId: string): MemberRow {
    const value = this.#memberRow(memberId);
    if (value === null) throw notFound("Provider-thread archive cut member was not found");
    return value;
  }

  #memberRows(cutId: string): readonly MemberRow[] {
    const values: unknown[] = this.#database.query(`
      SELECT * FROM chat_provider_thread_archive_cut_members_v57
      WHERE cut_id = ?1 ORDER BY ordinal
    `).all(cutId);
    const members = values.map((value) => memberRowSchema.parse(value));
    for (let index = 0; index < members.length; index += 1) {
      if (members[index]!.ordinal !== index + 1) {
        throw corrupt("Provider-thread archive cut member ordinals are not canonical");
      }
    }
    return members;
  }

  #affectedTargets(
    accountProfileId: string,
    generation: number,
    cause: CutRow["cause"],
  ): readonly AffectedTargetV57[] {
    const values: unknown[] = this.#database.query(`
      SELECT target.*
      FROM chat_provider_thread_archive_targets_v57 AS target
      JOIN chat_provider_thread_archive_attempts_v57 AS attempt
        ON attempt.target_id = target.target_id
        AND attempt.attempt_id = target.current_attempt_id
        AND attempt.ordinal = target.current_attempt_ordinal
      WHERE target.status != 'committed'
        AND target.account_profile_id = ?1
        AND (?3 = 'account_removal' OR attempt.generation = ?2)
        AND attempt.cut_id IS NULL
      ORDER BY target.target_id
    `).all(accountProfileId, generation, cause);
    return values.map((value) => {
      const target = targetRowSchema.parse(value);
      const attempt = this.#requireAttempt(target.current_attempt_id);
      this.#verifyTarget(target);
      this.#verifyAttempt(attempt);
      return { target, attempt };
    });
  }

  #cutTargets(cut: CutRow): readonly AffectedTargetV57[] {
    const values: unknown[] = this.#database.query(`
      SELECT target.*
      FROM chat_provider_thread_archive_targets_v57 AS target
      JOIN chat_provider_thread_archive_attempts_v57 AS attempt
        ON attempt.target_id = target.target_id
        AND attempt.attempt_id = target.current_attempt_id
        AND attempt.ordinal = target.current_attempt_ordinal
      WHERE target.status != 'committed'
        AND target.account_profile_id = ?1
        AND (?4 = 'account_removal' OR attempt.generation = ?2)
        AND (attempt.cut_id IS NULL OR attempt.cut_id = ?3)
      ORDER BY target.target_id
    `).all(
      cut.account_profile_id,
      cut.source_generation,
      cut.cut_id,
      cut.cause,
    );
    return values.map((value) => {
      const target = targetRowSchema.parse(value);
      const attempt = this.#requireAttempt(target.current_attempt_id);
      this.#verifyTarget(target);
      this.#verifyAttempt(attempt);
      return { target, attempt };
    });
  }

  #assertCutTargetInventory(
    cut: CutRow,
    requireBound: boolean,
    members?: readonly MemberRow[],
  ): readonly AffectedTargetV57[] {
    if (members !== undefined && cut.state !== "fence_started" && cut.state !== "fenced") {
      const targetMembers = members.filter((member) => member.role === "target");
      if (
        targetMembers.length !== cut.target_count
        || !safeHexEqual(
          cut.target_inventory_digest,
          targetMemberInventorySha256(targetMembers),
        )
      ) {
        throw corrupt("Provider-thread archive canonical target inventory changed");
      }
      if (!requireBound) return [];
    }
    const targets = this.#cutTargets(cut);
    if (
      targets.length !== cut.target_count
      || !safeHexEqual(cut.target_inventory_digest, targetInventorySha256(targets))
    ) {
      throw corrupt("Provider-thread archive affected target inventory changed");
    }
    if (requireBound && targets.some(({ attempt }) => attempt.cut_id !== cut.cut_id)) {
      throw invalidState("Provider-thread archive cut has an unbound affected target");
    }
    return targets;
  }

  #updateOne(sql: string, values: readonly (string | number | null)[], message: string): void {
    try {
      const result = this.#database.query(sql).run(...values);
      if (result.changes !== 1) throw invalidState(message);
    } catch (error: unknown) {
      if (error instanceof ProviderThreadArchiveJournalV57Error) throw error;
      throw sqliteError(error, message);
    }
  }
}

function parsePrepareTarget(input: PrepareProviderThreadArchiveTargetV57) {
  const targetId = targetIdSchema.parse(input.targetId);
  const paneId = paneIdSchema.parse(input.paneId);
  const purpose = z.enum(["start_fresh", "pane_archive"]).parse(input.purpose);
  const paneRevision = positiveSafeIntegerSchema.parse(input.paneRevision);
  const queueRevision = input.queueRevision === null
    ? null
    : positiveSafeIntegerSchema.parse(input.queueRevision);
  const paneCasDigest = hexDigestSchema.parse(input.paneCasDigest);
  const queueCasDigest = input.queueCasDigest === null
    ? null
    : hexDigestSchema.parse(input.queueCasDigest);
  if ((purpose === "start_fresh") !== (queueRevision !== null && queueCasDigest !== null)) {
    throw new TypeError("Start-fresh archive targets require exact queue CAS evidence");
  }
  const accountProfileRevision = positiveSafeIntegerSchema.parse(
    input.accountProfileRevision,
  );
  const attemptAccountProfileRevision = positiveSafeIntegerSchema.parse(
    input.attempt.accountProfileRevision,
  );
  if (accountProfileRevision !== attemptAccountProfileRevision) {
    throw new TypeError("Initial archive attempt lost its target profile revision");
  }
  return {
    targetId,
    paneId,
    purpose,
    paneRevision,
    queueRevision,
    paneCasDigest,
    queueCasDigest,
    accountProfileId: accountIdSchema.parse(input.accountProfileId),
    accountProfileRevision,
    threadId: providerIdSchema.parse(input.threadId),
    restartThreadId: providerIdSchema.parse(input.restartThreadId),
    binding: parseBindingPreimage(input.binding),
    attempt: {
      attemptId: attemptIdSchema.parse(input.attempt.attemptId),
      generation: positiveSafeIntegerSchema.parse(input.attempt.generation),
      accountProfileRevision: attemptAccountProfileRevision,
      requestEvidenceDigest: hexDigestSchema.parse(input.attempt.requestEvidenceDigest),
      requestRevisionDigest: hexDigestSchema.parse(input.attempt.requestRevisionDigest),
    },
    now: input.now,
  } as const;
}

function parseCreateCut(input: CreateProviderThreadArchiveCutV57) {
  const cause = z.enum(["ambiguous_response", "lost_response", "account_removal"])
    .parse(input.cause);
  const initiatingAttemptId = input.initiatingAttemptId === null
    ? null
    : attemptIdSchema.parse(input.initiatingAttemptId);
  if ((cause === "account_removal") !== (initiatingAttemptId === null)) {
    throw new TypeError("Only account-removal cuts omit an initiating attempt");
  }
  return {
    cutId: cutIdSchema.parse(input.cutId),
    accountProfileId: accountIdSchema.parse(input.accountProfileId),
    accountProfileRevision: positiveSafeIntegerSchema.parse(
      input.accountProfileRevision,
    ),
    sourceGeneration: positiveSafeIntegerSchema.parse(input.sourceGeneration),
    cause,
    initiatingAttemptId,
    predecessorCutId: input.predecessorCutId === null
      ? null
      : cutIdSchema.parse(input.predecessorCutId),
    identityEvidenceDigest: hexDigestSchema.parse(input.identityEvidenceDigest),
    identityRevisionDigest: hexDigestSchema.parse(input.identityRevisionDigest),
    now: input.now,
  } as const;
}

function parseAddMember(input: AddProviderThreadArchiveCutMemberV57) {
  const role = z.enum(["target", "sibling"]).parse(input.role);
  const targetId = input.targetId === null ? null : targetIdSchema.parse(input.targetId);
  const attemptId = input.attemptId === null ? null : attemptIdSchema.parse(input.attemptId);
  const targetAttemptOrdinal = input.targetAttemptOrdinal === null
    ? null
    : positiveSafeIntegerSchema.parse(input.targetAttemptOrdinal);
  if ((role === "target") !== (
    targetId !== null && attemptId !== null && targetAttemptOrdinal !== null
  )) {
    throw new TypeError("Archive target members require exact target and attempt identities");
  }
  return {
    memberId: memberIdSchema.parse(input.memberId),
    cutId: cutIdSchema.parse(input.cutId),
    paneId: paneIdSchema.parse(input.paneId),
    paneRevision: positiveSafeIntegerSchema.parse(input.paneRevision),
    paneCasDigest: hexDigestSchema.parse(input.paneCasDigest),
    threadId: providerIdSchema.parse(input.threadId),
    restartThreadId: providerIdSchema.parse(input.restartThreadId),
    role,
    targetId,
    attemptId,
    targetAttemptOrdinal,
    action: z.enum([
      "preserved_target",
      "contain_generation_context",
      "detach_binding_only",
    ]).parse(input.action),
    binding: parseBindingPreimage(input.binding),
    identityEvidenceDigest: hexDigestSchema.parse(input.identityEvidenceDigest),
    identityRevisionDigest: hexDigestSchema.parse(input.identityRevisionDigest),
    now: input.now,
  } as const;
}

function parseTargetPreimage(input: ProviderThreadArchiveTargetPreimageV57) {
  const purpose = z.enum(["start_fresh", "pane_archive"]).parse(input.purpose);
  const queueRevision = input.queueRevision === null
    ? null
    : positiveSafeIntegerSchema.parse(input.queueRevision);
  const queueCasDigest = input.queueCasDigest === null
    ? null
    : hexDigestSchema.parse(input.queueCasDigest);
  if ((purpose === "start_fresh") !== (queueRevision !== null && queueCasDigest !== null)) {
    throw new TypeError("Start-fresh archive target preimages require exact queue CAS evidence");
  }
  return {
    paneId: paneIdSchema.parse(input.paneId),
    purpose,
    paneRevision: positiveSafeIntegerSchema.parse(input.paneRevision),
    queueRevision,
    paneCasDigest: hexDigestSchema.parse(input.paneCasDigest),
    queueCasDigest,
    accountProfileId: accountIdSchema.parse(input.accountProfileId),
    accountProfileRevision: positiveSafeIntegerSchema.parse(
      input.accountProfileRevision,
    ),
    threadId: providerIdSchema.parse(input.threadId),
    restartThreadId: providerIdSchema.parse(input.restartThreadId),
    binding: parseBindingPreimage(input.binding),
  } as const;
}

function parseMemberPreimage(input: ProviderThreadArchiveMemberPreimageV57) {
  return {
    paneId: paneIdSchema.parse(input.paneId),
    paneRevision: positiveSafeIntegerSchema.parse(input.paneRevision),
    paneCasDigest: hexDigestSchema.parse(input.paneCasDigest),
    threadId: providerIdSchema.parse(input.threadId),
    restartThreadId: providerIdSchema.parse(input.restartThreadId),
    binding: parseBindingPreimage(input.binding),
  } as const;
}

function parseBindingPreimage(input: ProviderThreadArchiveBindingPreimageV57) {
  if (input.kind === "none") {
    return {
      kind: "none" as const,
      bindingId: null,
      bindingKeyDigest: null,
      bindingRevision: null,
    };
  }
  if (input.kind !== "exact") {
    throw new TypeError("Provider-thread archive binding preimage is invalid");
  }
  return {
    kind: "exact" as const,
    bindingId: bindingIdSchema.parse(input.bindingId),
    bindingKeyDigest: hexDigestSchema.parse(input.bindingKeyDigest),
    bindingRevision: positiveSafeIntegerSchema.parse(input.bindingRevision),
  };
}

function bindingPreimageFromColumns(row: Readonly<{
  binding_id: string | null;
  binding_key_digest: string | null;
  binding_revision: number | null;
}>): ReturnType<typeof parseBindingPreimage> {
  if (
    row.binding_id === null
    && row.binding_key_digest === null
    && row.binding_revision === null
  ) {
    return { kind: "none", bindingId: null, bindingKeyDigest: null, bindingRevision: null };
  }
  if (
    row.binding_id === null
    || row.binding_key_digest === null
    || row.binding_revision === null
  ) {
    throw corrupt("Provider-thread archive binding preimage is partial");
  }
  return {
    kind: "exact",
    bindingId: row.binding_id,
    bindingKeyDigest: row.binding_key_digest,
    bindingRevision: row.binding_revision,
  };
}

function targetIdentityPayload(input: ReturnType<typeof parsePrepareTarget>, createdAt: string) {
  return {
    targetId: input.targetId,
    paneId: input.paneId,
    purpose: input.purpose,
    paneRevision: input.paneRevision,
    queueRevision: input.queueRevision,
    paneCasDigest: input.paneCasDigest,
    queueCasDigest: input.queueCasDigest,
    accountProfileId: input.accountProfileId,
    accountProfileRevision: input.accountProfileRevision,
    threadId: input.threadId,
    restartThreadId: input.restartThreadId,
    bindingId: input.binding.bindingId,
    bindingKeyDigest: input.binding.bindingKeyDigest,
    bindingRevision: input.binding.bindingRevision,
    createdAt,
  } as const;
}

function targetIdentityPayloadFromRow(row: TargetRow) {
  return {
    targetId: row.target_id,
    paneId: row.pane_id,
    purpose: row.purpose,
    paneRevision: row.pane_revision,
    queueRevision: row.queue_revision,
    paneCasDigest: row.pane_cas_digest,
    queueCasDigest: row.queue_cas_digest,
    accountProfileId: row.account_profile_id,
    accountProfileRevision: row.account_profile_revision,
    threadId: row.thread_id,
    restartThreadId: row.restart_thread_id,
    bindingId: row.binding_id,
    bindingKeyDigest: row.binding_key_digest,
    bindingRevision: row.binding_revision,
    createdAt: row.created_at,
  } as const;
}

function attemptIdentityPayload(input: Readonly<{
  attemptId: string;
  targetId: string;
  ordinal: number;
  generation: number;
  accountProfileRevision: number;
  predecessorAttemptId: string | null;
  cutId: null;
  requestEvidenceDigest: string;
  requestRevisionDigest: string;
  createdAt: string;
}>) {
  return input;
}

function attemptIdentityPayloadFromRow(row: AttemptRow) {
  return {
    attemptId: row.attempt_id,
    targetId: row.target_id,
    ordinal: row.ordinal,
    generation: row.generation,
    accountProfileRevision: row.account_profile_revision,
    predecessorAttemptId: row.predecessor_attempt_id,
    cutId: null,
    requestEvidenceDigest: row.request_evidence_digest,
    requestRevisionDigest: row.request_revision_digest,
    createdAt: row.created_at,
  } as const;
}

function cutIdentityPayload(input: ReturnType<typeof parseCreateCut> & Readonly<{
  targetCount: number;
  targetInventoryDigest: string;
}>, createdAt: string) {
  return {
    cutId: input.cutId,
    accountProfileId: input.accountProfileId,
    accountProfileRevision: input.accountProfileRevision,
    sourceGeneration: input.sourceGeneration,
    cause: input.cause,
    initiatingAttemptId: input.initiatingAttemptId,
    targetCount: input.targetCount,
    targetInventoryDigest: input.targetInventoryDigest,
    predecessorCutId: input.predecessorCutId,
    identityEvidenceDigest: input.identityEvidenceDigest,
    identityRevisionDigest: input.identityRevisionDigest,
    createdAt,
  } as const;
}

function cutIdentityPayloadFromRow(row: CutRow) {
  return {
    cutId: row.cut_id,
    accountProfileId: row.account_profile_id,
    accountProfileRevision: row.account_profile_revision,
    sourceGeneration: row.source_generation,
    cause: row.cause,
    initiatingAttemptId: row.initiating_attempt_id,
    targetCount: row.target_count,
    targetInventoryDigest: row.target_inventory_digest,
    predecessorCutId: row.predecessor_cut_id,
    identityEvidenceDigest: row.identity_evidence_digest,
    identityRevisionDigest: row.identity_revision_digest,
    createdAt: row.created_at,
  } as const;
}

function memberIdentityPayload(input: ReturnType<typeof parseAddMember> & {
  ordinal: number;
  createdAt: string;
}) {
  return {
    memberId: input.memberId,
    cutId: input.cutId,
    ordinal: input.ordinal,
    paneId: input.paneId,
    paneRevision: input.paneRevision,
    paneCasDigest: input.paneCasDigest,
    threadId: input.threadId,
    restartThreadId: input.restartThreadId,
    role: input.role,
    targetId: input.targetId,
    attemptId: input.attemptId,
    targetAttemptOrdinal: input.targetAttemptOrdinal,
    action: input.action,
    bindingId: input.binding.bindingId,
    bindingKeyDigest: input.binding.bindingKeyDigest,
    bindingRevision: input.binding.bindingRevision,
    identityEvidenceDigest: input.identityEvidenceDigest,
    identityRevisionDigest: input.identityRevisionDigest,
    createdAt: input.createdAt,
  } as const;
}

function memberIdentityPayloadFromRow(row: MemberRow) {
  return {
    memberId: row.member_id,
    cutId: row.cut_id,
    ordinal: row.ordinal,
    paneId: row.pane_id,
    paneRevision: row.pane_revision,
    paneCasDigest: row.pane_cas_digest,
    threadId: row.thread_id,
    restartThreadId: row.restart_thread_id,
    role: row.role,
    targetId: row.target_id,
    attemptId: row.attempt_id,
    targetAttemptOrdinal: row.target_attempt_ordinal,
    action: row.action,
    bindingId: row.binding_id,
    bindingKeyDigest: row.binding_key_digest,
    bindingRevision: row.binding_revision,
    identityEvidenceDigest: row.identity_evidence_digest,
    identityRevisionDigest: row.identity_revision_digest,
    createdAt: row.created_at,
  } as const;
}

function completeInventoryMemberPayloadFromParsed(
  input: ReturnType<typeof parseAddMember>,
) {
  return {
    memberId: input.memberId,
    cutId: input.cutId,
    paneId: input.paneId,
    paneRevision: input.paneRevision,
    paneCasDigest: input.paneCasDigest,
    threadId: input.threadId,
    restartThreadId: input.restartThreadId,
    role: input.role,
    targetId: input.targetId,
    attemptId: input.attemptId,
    targetAttemptOrdinal: input.targetAttemptOrdinal,
    action: input.action,
    bindingId: input.binding.bindingId,
    bindingKeyDigest: input.binding.bindingKeyDigest,
    bindingRevision: input.binding.bindingRevision,
    identityEvidenceDigest: input.identityEvidenceDigest,
    identityRevisionDigest: input.identityRevisionDigest,
  } as const;
}

function completeInventoryMemberPayloadFromRow(row: MemberRow) {
  return {
    memberId: row.member_id,
    cutId: row.cut_id,
    paneId: row.pane_id,
    paneRevision: row.pane_revision,
    paneCasDigest: row.pane_cas_digest,
    threadId: row.thread_id,
    restartThreadId: row.restart_thread_id,
    role: row.role,
    targetId: row.target_id,
    attemptId: row.attempt_id,
    targetAttemptOrdinal: row.target_attempt_ordinal,
    action: row.action,
    bindingId: row.binding_id,
    bindingKeyDigest: row.binding_key_digest,
    bindingRevision: row.binding_revision,
    identityEvidenceDigest: row.identity_evidence_digest,
    identityRevisionDigest: row.identity_revision_digest,
  } as const;
}

function completeInventorySha256FromParsed(
  members: readonly ReturnType<typeof parseAddMember>[],
): string {
  return createHash("sha256").update(canonicalJson(members
    .map(completeInventoryMemberPayloadFromParsed)
    .sort((left, right) => compareCanonicalCodeUnits(
      left.memberId,
      right.memberId,
    ))))
    .digest("hex");
}

function completeInventorySha256FromRows(members: readonly MemberRow[]): string {
  return createHash("sha256").update(canonicalJson(members
    .map(completeInventoryMemberPayloadFromRow)
    .sort((left, right) => compareCanonicalCodeUnits(
      left.memberId,
      right.memberId,
    ))))
    .digest("hex");
}

function targetInventorySha256(targets: readonly AffectedTargetV57[]): string {
  return createHash("sha256").update(canonicalJson(targets.map(({ target, attempt }) => ({
    targetId: target.target_id,
    attemptId: attempt.attempt_id,
    attemptOrdinal: attempt.ordinal,
    paneId: target.pane_id,
  })).sort((left, right) => compareCanonicalCodeUnits(
    left.targetId,
    right.targetId,
  )))).digest("hex");
}

function targetMemberInventorySha256(members: readonly MemberRow[]): string {
  return createHash("sha256").update(canonicalJson(members.map((member) => ({
    targetId: member.target_id,
    attemptId: member.attempt_id,
    attemptOrdinal: member.target_attempt_ordinal,
    paneId: member.pane_id,
  })).sort((left, right) => compareCanonicalCodeUnits(
    left.targetId ?? "",
    right.targetId ?? "",
  ))))
    .digest("hex");
}

function settlementInventorySha256(members: readonly MemberRow[]): string {
  return createHash("sha256").update(canonicalJson(members.map((member) => ({
    identity: memberIdentityPayloadFromRow(member),
    state: member.state,
    settlementEvidenceDigest: member.settlement_evidence_digest,
    settlementRevisionDigest: member.settlement_revision_digest,
    settledAt: member.settled_at,
    settlementHmac: member.settlement_hmac,
  })))).digest("hex");
}

function targetInputMatches(row: TargetRow, input: ReturnType<typeof parsePrepareTarget>): boolean {
  return canonicalJson(targetIdentityPayloadFromRow(row))
    === canonicalJson(targetIdentityPayload(input, row.created_at));
}

function initialAttemptInputMatches(
  row: AttemptRow,
  input: ReturnType<typeof parsePrepareTarget>,
  targetCreatedAt: string,
): boolean {
  return row.attempt_id === input.attempt.attemptId
    && row.target_id === input.targetId
    && row.ordinal === 1
    && row.generation === input.attempt.generation
    && row.account_profile_revision === input.attempt.accountProfileRevision
    && row.predecessor_attempt_id === null
    && row.request_evidence_digest === input.attempt.requestEvidenceDigest
    && row.request_revision_digest === input.attempt.requestRevisionDigest
    && row.created_at === targetCreatedAt;
}

function cutInputMatches(row: CutRow, input: ReturnType<typeof parseCreateCut>): boolean {
  return row.cut_id === input.cutId
    && row.account_profile_id === input.accountProfileId
    && row.account_profile_revision === input.accountProfileRevision
    && row.source_generation === input.sourceGeneration
    && row.cause === input.cause
    && row.initiating_attempt_id === input.initiatingAttemptId
    && row.predecessor_cut_id === input.predecessorCutId
    && row.identity_evidence_digest === input.identityEvidenceDigest
    && row.identity_revision_digest === input.identityRevisionDigest;
}

function memberInputMatches(row: MemberRow, input: ReturnType<typeof parseAddMember>): boolean {
  const payload = memberIdentityPayloadFromRow(row);
  return canonicalJson({ ...payload, ordinal: undefined, createdAt: undefined })
    === canonicalJson({
      ...memberIdentityPayload({ ...input, ordinal: row.ordinal, createdAt: row.created_at }),
      ordinal: undefined,
      createdAt: undefined,
    });
}

function attemptSnapshot(row: AttemptRow): ProviderThreadArchiveAttemptSnapshotV57 {
  return {
    attemptId: row.attempt_id,
    ordinal: row.ordinal,
    generation: row.generation,
    accountProfileRevision: row.account_profile_revision,
    predecessorAttemptId: row.predecessor_attempt_id,
    cutId: row.cut_id,
    state: row.state,
  };
}

function memberSnapshot(row: MemberRow): ProviderThreadArchiveCutMemberSnapshotV57 {
  return {
    memberId: row.member_id,
    ordinal: row.ordinal,
    paneId: row.pane_id,
    role: row.role,
    action: row.action,
    state: row.state,
  };
}

function cutSnapshot(
  row: CutRow,
  members: readonly MemberRow[],
): ProviderThreadArchiveCutSnapshotV57 {
  return {
    cutId: row.cut_id,
    accountProfileId: row.account_profile_id,
    accountProfileRevision: row.account_profile_revision,
    sourceGeneration: row.source_generation,
    successorGeneration: row.successor_generation,
    successorAccountProfileRevision:
      row.successor_account_profile_revision,
    cause: row.cause,
    initiatingAttemptId: row.initiating_attempt_id,
    targetCount: row.target_count,
    state: row.state,
    members: members.map(memberSnapshot),
  };
}

function attemptAuthorityRevision(attempt: AttemptRow): number {
  const ordinalBase = (attempt.ordinal - 1) * 16;
  switch (attempt.state) {
    case "prepared":
      return ordinalBase + (attempt.cut_id === null ? 1 : 2);
    case "effect_started":
      return ordinalBase + (attempt.cut_id === null ? 3 : 4);
    case "ambiguous":
      return ordinalBase + 5;
    case "direct_applied":
      return ordinalBase + (attempt.cut_id === null ? 5 : 6);
    case "reconciled_applied":
    case "reconciled_not_applied":
      return ordinalBase + 7;
    case "abandoned_pre_effect":
      return ordinalBase + (attempt.cut_id === null ? 3 : 4);
    case "account_contained":
      return ordinalBase + 9;
  }
}

function cutAuthorityRevision(cut: CutRow): number {
  switch (cut.state) {
    case "fence_started":
      return 1;
    case "fenced":
      return 2;
    case "sealed":
      return 3;
    case "removal_awaiting_tombstone":
      return 4;
    case "contained":
      return cut.cause === "account_removal" ? 5 : 4;
  }
}

function parseDate(value: Date): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError("Provider-thread archive timestamp is invalid");
  }
  return isoDateTimeSchema.parse(value.toISOString());
}

function receiptGroupPresence(
  label: string,
  values: readonly unknown[],
): boolean {
  const present = values.filter((value) => value !== null).length;
  if (present !== 0 && present !== values.length) {
    throw corrupt(`Provider-thread archive ${label} receipt is partial`);
  }
  return present === values.length;
}

function safeHexEqual(left: string, right: string): boolean {
  if (!hexDigestSchema.safeParse(left).success || !hexDigestSchema.safeParse(right).success) {
    return false;
  }
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function emptyTerminalCleanup(): ProviderThreadArchiveTerminalCleanupV57 {
  return Object.freeze({
    deletedTargetIds: Object.freeze([]),
    deletedCutIds: Object.freeze([]),
  });
}

function canonicalStringArraysEqual(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function terminalCleanupComponentsEqual(
  left: ProviderThreadArchiveTerminalCleanupComponentV57,
  right: ProviderThreadArchiveTerminalCleanupComponentV57,
): boolean {
  return left.accountProfileId === right.accountProfileId
    && left.allTargetsCommitted === right.allTargetsCommitted
    && canonicalStringArraysEqual(left.targetIds, right.targetIds)
    && canonicalStringArraysEqual(left.cutIds, right.cutIds);
}

function compareCanonicalCodeUnits(left: string, right: string): number {
  const sharedLength = Math.min(left.length, right.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const difference = left.charCodeAt(index) - right.charCodeAt(index);
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
    case "number":
    case "string":
      return JSON.stringify(value);
    case "object":
      if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
      return `{${Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => compareCanonicalCodeUnits(left, right))
        .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
        .join(",")}}`;
    case "bigint":
    case "function":
    case "symbol":
    case "undefined":
      throw new TypeError("Provider-thread archive receipts require JSON values");
  }
  throw new TypeError("Provider-thread archive receipts require JSON values");
}

function conflict(message: string): ProviderThreadArchiveJournalV57Error {
  return new ProviderThreadArchiveJournalV57Error("conflict", message);
}

function corrupt(message: string): ProviderThreadArchiveJournalV57Error {
  return new ProviderThreadArchiveJournalV57Error("corrupt", message);
}

function invalidState(message: string): ProviderThreadArchiveJournalV57Error {
  return new ProviderThreadArchiveJournalV57Error("invalid_state", message);
}

function notFound(message: string): ProviderThreadArchiveJournalV57Error {
  return new ProviderThreadArchiveJournalV57Error("not_found", message);
}

function sqliteError(error: unknown, message: string): ProviderThreadArchiveJournalV57Error {
  const detail = error instanceof Error ? error.message : String(error);
  const code = detail.includes("limit reached") ? "limit" : "conflict";
  return new ProviderThreadArchiveJournalV57Error(code, `${message}: ${detail}`);
}
