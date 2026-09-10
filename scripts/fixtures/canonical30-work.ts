import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";

// Generated exclusively through StateStore APIs archived at exact canonical
// dd1f2989536074fa83e4574bb9d18086088bb7fb. No historical DDL or rows were edited.
// These hashes identify the captured output. Regeneration repeats the historical
// API semantics but uses fresh API-generated IDs, so its database bytes differ.
export const canonical30WorkFixture = {
  "sourceRevision": "dd1f2989536074fa83e4574bb9d18086088bb7fb",
  "schemaVersion": 30,
  "databaseSha256": "035b61ab4787dddaa378547ca602e2dfe4528145aa72822f748594019dc28d0d",
  "databaseBytes": 1011712,
  "generatorSha256": "f674e91fa9cdef67a211901c594706c634b29f61f4f48cc73dc1bb5968157f35",
  "profileId": "acct_1ec54a070af641a7ba045020a0d896f6",
  "sessionId": "sess_c89c2c96de0140a6b80abfdff8786e1a",
  "sessionRow": {
    "id": "sess_c89c2c96de0140a6b80abfdff8786e1a",
    "profile_id": "acct_1ec54a070af641a7ba045020a0d896f6",
    "project_id": null,
    "provider_thread_id": "canonical30-autorespond-history",
    "title": "Untitled session",
    "note": "",
    "preset": "high",
    "fast_enabled": 0,
    "state": "idle",
    "active_turn_id": null,
    "revision": 2,
    "created_at": 1000,
    "updated_at": 1000,
    "provider_updated_at": null
  },
  "evidence": [
    {
      "id": 1,
      "session_id": "sess_c89c2c96de0140a6b80abfdff8786e1a",
      "interaction_id": "30000000-0000-4000-8000-000000000030",
      "kind": "command_approval",
      "class": "canonical30-history",
      "decision": "decline",
      "mode": "manual",
      "outcome": "refused",
      "latency_ms": 4,
      "subagent": 0,
      "occurred_at": 1000
    }
  ],
  "workObjects": [
    {
      "type": "trigger",
      "name": "work_active_limit_guard",
      "tbl_name": "works",
      "sql": "CREATE TRIGGER work_active_limit_guard\nBEFORE INSERT ON works\nWHEN NEW.state IN ('active','cancel_pending','fail_pending') AND (\n  SELECT COUNT(*) FROM works WHERE state IN ('active','cancel_pending','fail_pending')\n) >= 1024\nBEGIN SELECT RAISE(ABORT,'WORK_ACTIVE_LIMIT'); END"
    },
    {
      "type": "trigger",
      "name": "work_attempt_authority_immutable",
      "tbl_name": "work_attempts",
      "sql": "CREATE TRIGGER work_attempt_authority_immutable\nBEFORE UPDATE OF id,work_id,task_id,worker_session_id,account_id,project_id,preset,fast,fence,account_generation,daemon_generation,created_at ON work_attempts\nBEGIN SELECT RAISE(ABORT,'WORK_ATTEMPT_AUTHORITY_IMMUTABLE'); END"
    },
    {
      "type": "trigger",
      "name": "work_attempt_dispatch_binding_guard",
      "tbl_name": "work_attempts",
      "sql": "CREATE TRIGGER work_attempt_dispatch_binding_guard\nBEFORE UPDATE OF target_session_id,dispatch_mode ON work_attempts\nWHEN (OLD.target_session_id IS NOT NULL OR OLD.dispatch_mode IS NOT NULL)\n  AND (NEW.target_session_id IS NOT OLD.target_session_id OR NEW.dispatch_mode IS NOT OLD.dispatch_mode)\nBEGIN SELECT RAISE(ABORT,'WORK_ATTEMPT_DISPATCH_BINDING_IMMUTABLE'); END"
    },
    {
      "type": "trigger",
      "name": "work_attempt_fence_monotonic",
      "tbl_name": "work_attempts",
      "sql": "CREATE TRIGGER work_attempt_fence_monotonic\nBEFORE INSERT ON work_attempts\nWHEN NEW.fence <= COALESCE((SELECT MAX(fence) FROM work_attempts WHERE task_id=NEW.task_id),0)\nBEGIN SELECT RAISE(ABORT,'WORK_ATTEMPT_FENCE_NOT_MONOTONIC'); END"
    },
    {
      "type": "trigger",
      "name": "work_attempt_no_delete",
      "tbl_name": "work_attempts",
      "sql": "CREATE TRIGGER work_attempt_no_delete\nBEFORE DELETE ON work_attempts\nWHEN NOT EXISTS (SELECT 1 FROM work_purge_authority WHERE work_id=OLD.work_id)\nBEGIN SELECT RAISE(ABORT,'WORK_ATTEMPT_IMMUTABLE'); END"
    },
    {
      "type": "table",
      "name": "work_attempt_reports",
      "tbl_name": "work_attempt_reports",
      "sql": "CREATE TABLE work_attempt_reports (\n  idempotency_key TEXT PRIMARY KEY CHECK(length(idempotency_key) = 36),\n  work_id TEXT NOT NULL,\n  attempt_id TEXT NOT NULL,\n  kind TEXT NOT NULL CHECK(kind IN ('checkpoint','submit','blocked','failed','unknown')),\n  report_json TEXT NOT NULL CHECK(json_valid(report_json) AND length(CAST(report_json AS BLOB)) <= 2097152),\n  report_digest TEXT NOT NULL CHECK(length(report_digest) = 64 AND report_digest NOT GLOB '*[^0-9a-f]*'),\n  created_at INTEGER NOT NULL CHECK(created_at >= 0),\n  FOREIGN KEY(work_id,attempt_id) REFERENCES work_attempts(work_id,id) ON DELETE CASCADE\n) STRICT"
    },
    {
      "type": "index",
      "name": "work_attempt_reports_attempt",
      "tbl_name": "work_attempt_reports",
      "sql": "CREATE INDEX work_attempt_reports_attempt ON work_attempt_reports(attempt_id,created_at,idempotency_key)"
    },
    {
      "type": "trigger",
      "name": "work_attempt_reports_no_delete",
      "tbl_name": "work_attempt_reports",
      "sql": "CREATE TRIGGER work_attempt_reports_no_delete\nBEFORE DELETE ON work_attempt_reports\nWHEN NOT EXISTS (SELECT 1 FROM work_purge_authority WHERE work_id=OLD.work_id)\nBEGIN SELECT RAISE(ABORT,'WORK_REPORT_IMMUTABLE'); END"
    },
    {
      "type": "trigger",
      "name": "work_attempt_reports_no_update",
      "tbl_name": "work_attempt_reports",
      "sql": "CREATE TRIGGER work_attempt_reports_no_update\nBEFORE UPDATE ON work_attempt_reports BEGIN SELECT RAISE(ABORT,'WORK_REPORT_IMMUTABLE'); END"
    },
    {
      "type": "trigger",
      "name": "work_attempt_revision_guard",
      "tbl_name": "work_attempts",
      "sql": "CREATE TRIGGER work_attempt_revision_guard\nBEFORE UPDATE ON work_attempts\nWHEN NEW.revision != OLD.revision + 1\nBEGIN SELECT RAISE(ABORT,'WORK_ATTEMPT_REVISION'); END"
    },
    {
      "type": "trigger",
      "name": "work_attempt_route_guard",
      "tbl_name": "work_attempts",
      "sql": "CREATE TRIGGER work_attempt_route_guard\nBEFORE INSERT ON work_attempts\nWHEN NOT EXISTS (\n  SELECT 1\n  FROM work_tasks AS t\n  JOIN sessions AS s ON s.id=NEW.worker_session_id\n  JOIN work_members AS m ON m.work_id=NEW.work_id AND m.session_id=s.id\n  WHERE t.id=NEW.task_id AND t.work_id=NEW.work_id\n    AND t.account_id=NEW.account_id AND t.project_id=NEW.project_id\n    AND t.preset=NEW.preset AND t.fast=NEW.fast\n    AND s.profile_id=NEW.account_id AND s.project_id=NEW.project_id\n    AND s.preset=NEW.preset AND s.fast_enabled=NEW.fast\n)\nBEGIN SELECT RAISE(ABORT,'WORK_ATTEMPT_ROUTE_MISMATCH'); END"
    },
    {
      "type": "trigger",
      "name": "work_attempt_state_guard",
      "tbl_name": "work_attempts",
      "sql": "CREATE TRIGGER work_attempt_state_guard\nBEFORE UPDATE OF state ON work_attempts\nWHEN NOT (\n  OLD.state = NEW.state OR\n  (OLD.state = 'claimed' AND NEW.state IN ('dispatching','failed','released','expired','cancelled')) OR\n  (OLD.state = 'dispatching' AND NEW.state IN ('running','failed','recovery_required','cancelled')) OR\n  (OLD.state = 'running' AND NEW.state IN ('submitted','blocked','failed','recovery_required','cancelled')) OR\n  (OLD.state = 'submitted' AND NEW.state IN ('completed','failed','cancelled')) OR\n  (OLD.state = 'recovery_required' AND NEW.state IN ('running','submitted','completed','failed','released','cancelled'))\n)\nBEGIN SELECT RAISE(ABORT,'WORK_ATTEMPT_STATE_TRANSITION'); END"
    },
    {
      "type": "trigger",
      "name": "work_attempt_submission_guard",
      "tbl_name": "work_attempts",
      "sql": "CREATE TRIGGER work_attempt_submission_guard\nBEFORE UPDATE OF submission_id ON work_attempts\nWHEN OLD.submission_id IS NOT NULL AND NEW.submission_id IS NOT OLD.submission_id\nBEGIN SELECT RAISE(ABORT,'WORK_ATTEMPT_SUBMISSION_IMMUTABLE'); END"
    },
    {
      "type": "table",
      "name": "work_attempts",
      "tbl_name": "work_attempts",
      "sql": "CREATE TABLE work_attempts (\n  id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 6 AND 80),\n  work_id TEXT NOT NULL,\n  task_id TEXT NOT NULL,\n  worker_session_id TEXT NOT NULL REFERENCES sessions(id),\n  account_id TEXT NOT NULL REFERENCES profiles(id),\n  project_id TEXT NOT NULL REFERENCES projects(id),\n  preset TEXT NOT NULL CHECK(preset IN ('low','high','ultra')),\n  fast INTEGER NOT NULL CHECK(fast IN (0,1)),\n  fence INTEGER NOT NULL CHECK(fence > 0),\n  revision INTEGER NOT NULL CHECK(revision > 0),\n  state TEXT NOT NULL CHECK(state IN ('claimed','dispatching','running','submitted','completed','blocked','failed','released','expired','recovery_required','cancelled')),\n  lease_expires_at INTEGER NOT NULL CHECK(lease_expires_at >= 0),\n  target_session_id TEXT REFERENCES sessions(id),\n  dispatch_mode TEXT CHECK(dispatch_mode IS NULL OR dispatch_mode='send'),\n  submission_id TEXT REFERENCES work_submissions(id) DEFERRABLE INITIALLY DEFERRED,\n  account_generation INTEGER NOT NULL CHECK(account_generation >= 0),\n  daemon_generation INTEGER NOT NULL CHECK(daemon_generation >= 0),\n  created_at INTEGER NOT NULL CHECK(created_at >= 0),\n  updated_at INTEGER NOT NULL CHECK(updated_at >= created_at),\n  terminal_at INTEGER CHECK(terminal_at IS NULL OR terminal_at >= created_at),\n  UNIQUE(task_id,fence),\n  UNIQUE(work_id,id),\n  FOREIGN KEY(work_id,task_id) REFERENCES work_tasks(work_id,id) ON DELETE CASCADE,\n  CHECK((target_session_id IS NULL AND dispatch_mode IS NULL) OR (target_session_id IS NOT NULL AND dispatch_mode IS NOT NULL))\n) STRICT"
    },
    {
      "type": "index",
      "name": "work_attempts_actor",
      "tbl_name": "work_attempts",
      "sql": "CREATE INDEX work_attempts_actor ON work_attempts(work_id,worker_session_id,state,updated_at,id)"
    },
    {
      "type": "index",
      "name": "work_attempts_lease",
      "tbl_name": "work_attempts",
      "sql": "CREATE INDEX work_attempts_lease ON work_attempts(work_id,state,lease_expires_at,id)"
    },
    {
      "type": "index",
      "name": "work_attempts_one_live",
      "tbl_name": "work_attempts",
      "sql": "CREATE UNIQUE INDEX work_attempts_one_live\n  ON work_attempts(task_id)\n  WHERE state IN ('claimed','dispatching','running','submitted','recovery_required')"
    },
    {
      "type": "table",
      "name": "work_clock",
      "tbl_name": "work_clock",
      "sql": "CREATE TABLE work_clock (\n  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),\n  logical_time INTEGER NOT NULL CHECK(logical_time >= 0)\n) STRICT"
    },
    {
      "type": "trigger",
      "name": "work_dependencies_no_delete",
      "tbl_name": "work_task_dependencies",
      "sql": "CREATE TRIGGER work_dependencies_no_delete\nBEFORE DELETE ON work_task_dependencies\nWHEN NOT EXISTS (SELECT 1 FROM work_purge_authority WHERE work_id=OLD.work_id)\nBEGIN SELECT RAISE(ABORT,'WORK_DEPENDENCY_IMMUTABLE'); END"
    },
    {
      "type": "trigger",
      "name": "work_dependencies_no_update",
      "tbl_name": "work_task_dependencies",
      "sql": "CREATE TRIGGER work_dependencies_no_update\nBEFORE UPDATE ON work_task_dependencies BEGIN SELECT RAISE(ABORT,'WORK_DEPENDENCY_IMMUTABLE'); END"
    },
    {
      "type": "trigger",
      "name": "work_effect_capacity_guard",
      "tbl_name": "work_prepared_effects",
      "sql": "CREATE TRIGGER work_effect_capacity_guard\nBEFORE INSERT ON work_prepared_effects\nWHEN NEW.state='prepared'\n AND (SELECT COUNT(*) FROM work_events WHERE work_id=NEW.work_id)\n   + (SELECT COALESCE(SUM(CASE state WHEN 'prepared' THEN 2 WHEN 'effect_started' THEN 1 ELSE 0 END),0)\n      FROM work_prepared_effects WHERE work_id=NEW.work_id)\n   + 3 > 65536\nBEGIN SELECT RAISE(ABORT,'WORK_HISTORY_EVENT_LIMIT'); END"
    },
    {
      "type": "trigger",
      "name": "work_effect_identity_immutable",
      "tbl_name": "work_prepared_effects",
      "sql": "CREATE TRIGGER work_effect_identity_immutable\nBEFORE UPDATE OF idempotency_key,work_id,effect_kind,subject_id,instruction_json,instruction_digest,daemon_generation,prepared_at ON work_prepared_effects\nBEGIN SELECT RAISE(ABORT,'WORK_EFFECT_IDENTITY_IMMUTABLE'); END"
    },
    {
      "type": "trigger",
      "name": "work_effect_no_delete",
      "tbl_name": "work_prepared_effects",
      "sql": "CREATE TRIGGER work_effect_no_delete\nBEFORE DELETE ON work_prepared_effects\nWHEN NOT EXISTS (SELECT 1 FROM work_purge_authority WHERE work_id=OLD.work_id)\nBEGIN SELECT RAISE(ABORT,'WORK_EFFECT_IMMUTABLE'); END"
    },
    {
      "type": "trigger",
      "name": "work_effect_outcome_guard",
      "tbl_name": "work_prepared_effects",
      "sql": "CREATE TRIGGER work_effect_outcome_guard\nBEFORE UPDATE OF outcome_digest,outcome_json,finalized_at ON work_prepared_effects\nWHEN OLD.state NOT IN ('prepared','effect_started')\n  AND NOT (OLD.state='unknown' AND NEW.state IN ('accepted','failed') AND EXISTS (\n    SELECT 1 FROM work_effect_resolutions AS r\n    WHERE r.effect_idempotency_key=OLD.idempotency_key\n  ))\n  AND NOT (OLD.state='unknown' AND NEW.state IN ('accepted','failed') AND EXISTS (\n    SELECT 1 FROM work_nested_effect_settlements AS n\n    WHERE n.effect_idempotency_key=OLD.idempotency_key AND n.outcome=NEW.state\n  ))\n  AND (\n  NEW.outcome_digest IS NOT OLD.outcome_digest OR\n  NEW.outcome_json IS NOT OLD.outcome_json OR\n  NEW.finalized_at IS NOT OLD.finalized_at\n)\nBEGIN SELECT RAISE(ABORT,'WORK_EFFECT_OUTCOME_IMMUTABLE'); END"
    },
    {
      "type": "table",
      "name": "work_effect_resolutions",
      "tbl_name": "work_effect_resolutions",
      "sql": "CREATE TABLE work_effect_resolutions (\n  effect_idempotency_key TEXT PRIMARY KEY REFERENCES work_prepared_effects(idempotency_key) ON DELETE CASCADE,\n  work_id TEXT NOT NULL,\n  attempt_id TEXT NOT NULL,\n  instruction_digest TEXT NOT NULL CHECK(length(instruction_digest) = 64 AND instruction_digest NOT GLOB '*[^0-9a-f]*'),\n  outcome TEXT NOT NULL CHECK(outcome IN ('proven_applied','no_effect','failed')),\n  evidence_digest TEXT NOT NULL CHECK(length(evidence_digest) = 64 AND evidence_digest NOT GLOB '*[^0-9a-f]*'),\n  created_at INTEGER NOT NULL CHECK(created_at >= 0),\n  FOREIGN KEY(work_id,attempt_id) REFERENCES work_attempts(work_id,id) ON DELETE CASCADE\n) STRICT"
    },
    {
      "type": "trigger",
      "name": "work_effect_resolutions_insert_guard",
      "tbl_name": "work_effect_resolutions",
      "sql": "CREATE TRIGGER work_effect_resolutions_insert_guard\nBEFORE INSERT ON work_effect_resolutions\nWHEN NOT EXISTS (\n  SELECT 1 FROM work_prepared_effects AS e\n  WHERE e.idempotency_key=NEW.effect_idempotency_key\n    AND e.work_id=NEW.work_id AND e.effect_kind='attempt_dispatch'\n    AND e.subject_id=NEW.attempt_id AND e.instruction_digest=NEW.instruction_digest\n)\nBEGIN SELECT RAISE(ABORT,'WORK_EFFECT_RESOLUTION_MISMATCH'); END"
    },
    {
      "type": "trigger",
      "name": "work_effect_resolutions_no_delete",
      "tbl_name": "work_effect_resolutions",
      "sql": "CREATE TRIGGER work_effect_resolutions_no_delete\nBEFORE DELETE ON work_effect_resolutions\nWHEN NOT EXISTS (SELECT 1 FROM work_purge_authority WHERE work_id=OLD.work_id)\nBEGIN SELECT RAISE(ABORT,'WORK_EFFECT_RESOLUTION_IMMUTABLE'); END"
    },
    {
      "type": "trigger",
      "name": "work_effect_resolutions_no_update",
      "tbl_name": "work_effect_resolutions",
      "sql": "CREATE TRIGGER work_effect_resolutions_no_update\nBEFORE UPDATE ON work_effect_resolutions\nBEGIN SELECT RAISE(ABORT,'WORK_EFFECT_RESOLUTION_IMMUTABLE'); END"
    },
    {
      "type": "trigger",
      "name": "work_effect_state_guard",
      "tbl_name": "work_prepared_effects",
      "sql": "CREATE TRIGGER work_effect_state_guard\nBEFORE UPDATE OF state ON work_prepared_effects\nWHEN NOT (\n  OLD.state=NEW.state\n  OR (OLD.state='prepared' AND NEW.state IN ('effect_started','accepted','failed','unknown'))\n  OR (OLD.state='effect_started' AND NEW.state IN ('accepted','failed','unknown'))\n  OR (OLD.state='unknown' AND NEW.state IN ('accepted','failed') AND EXISTS (\n    SELECT 1 FROM work_effect_resolutions AS r\n    WHERE r.effect_idempotency_key=OLD.idempotency_key\n      AND ((r.outcome='proven_applied' AND NEW.state='accepted')\n        OR (r.outcome IN ('no_effect','failed') AND NEW.state='failed'))\n  ))\n  OR (OLD.state='unknown' AND NEW.state IN ('accepted','failed') AND EXISTS (\n    SELECT 1 FROM work_nested_effect_settlements AS n\n    WHERE n.effect_idempotency_key=OLD.idempotency_key AND n.outcome=NEW.state\n  ))\n)\nBEGIN SELECT RAISE(ABORT,'WORK_EFFECT_STATE_TRANSITION'); END"
    },
    {
      "type": "index",
      "name": "work_effect_subject_unique",
      "tbl_name": "work_prepared_effects",
      "sql": "CREATE UNIQUE INDEX work_effect_subject_unique\n  ON work_prepared_effects(effect_kind,subject_id)"
    },
    {
      "type": "trigger",
      "name": "work_event_capacity_guard",
      "tbl_name": "work_events",
      "sql": "CREATE TRIGGER work_event_capacity_guard\nBEFORE INSERT ON work_events\nWHEN (SELECT COUNT(*) FROM work_events WHERE work_id=NEW.work_id)\n   + (SELECT COALESCE(SUM(CASE state WHEN 'prepared' THEN 2 WHEN 'effect_started' THEN 1 ELSE 0 END),0)\n      FROM work_prepared_effects WHERE work_id=NEW.work_id)\n   + 1 > 65536\nBEGIN SELECT RAISE(ABORT,'WORK_HISTORY_EVENT_LIMIT'); END"
    },
    {
      "type": "trigger",
      "name": "work_event_chain_guard",
      "tbl_name": "work_events",
      "sql": "CREATE TRIGGER work_event_chain_guard\nBEFORE INSERT ON work_events\nWHEN NEW.sequence != COALESCE((SELECT MAX(sequence)+1 FROM work_events WHERE work_id=NEW.work_id),1)\n  OR NEW.previous_hash IS NOT (SELECT event_hash FROM work_events WHERE work_id=NEW.work_id ORDER BY sequence DESC LIMIT 1)\nBEGIN SELECT RAISE(ABORT,'WORK_EVENT_CHAIN_INVALID'); END"
    },
    {
      "type": "table",
      "name": "work_events",
      "tbl_name": "work_events",
      "sql": "CREATE TABLE work_events (\n  work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,\n  sequence INTEGER NOT NULL CHECK(sequence > 0),\n  revision INTEGER NOT NULL CHECK(revision > 0),\n  stream_epoch TEXT NOT NULL CHECK(length(stream_epoch) = 36),\n  kind TEXT NOT NULL CHECK(length(CAST(kind AS BLOB)) BETWEEN 1 AND 120),\n  actor_session_id TEXT REFERENCES sessions(id),\n  payload_json TEXT NOT NULL CHECK(json_valid(payload_json) AND length(CAST(payload_json AS BLOB)) <= 131072),\n  payload_digest TEXT NOT NULL CHECK(length(payload_digest) = 64 AND payload_digest NOT GLOB '*[^0-9a-f]*'),\n  previous_hash TEXT CHECK(previous_hash IS NULL OR (length(previous_hash) = 64 AND previous_hash NOT GLOB '*[^0-9a-f]*')),\n  event_hash TEXT NOT NULL CHECK(length(event_hash) = 64 AND event_hash NOT GLOB '*[^0-9a-f]*'),\n  daemon_generation INTEGER NOT NULL CHECK(daemon_generation >= 0),\n  recorded_at INTEGER NOT NULL CHECK(recorded_at >= 0),\n  PRIMARY KEY(work_id,sequence),\n  UNIQUE(work_id,revision),\n  UNIQUE(work_id,event_hash),\n  CHECK((sequence = 1 AND previous_hash IS NULL) OR (sequence > 1 AND previous_hash IS NOT NULL))\n) STRICT"
    },
    {
      "type": "trigger",
      "name": "work_events_no_delete",
      "tbl_name": "work_events",
      "sql": "CREATE TRIGGER work_events_no_delete\nBEFORE DELETE ON work_events\nWHEN NOT EXISTS (SELECT 1 FROM work_purge_authority WHERE work_id=OLD.work_id)\nBEGIN SELECT RAISE(ABORT,'WORK_EVENT_APPEND_ONLY'); END"
    },
    {
      "type": "trigger",
      "name": "work_events_no_update",
      "tbl_name": "work_events",
      "sql": "CREATE TRIGGER work_events_no_update\nBEFORE UPDATE ON work_events BEGIN SELECT RAISE(ABORT,'WORK_EVENT_APPEND_ONLY'); END"
    },
    {
      "type": "index",
      "name": "work_events_revision",
      "tbl_name": "work_events",
      "sql": "CREATE INDEX work_events_revision ON work_events(work_id,revision)"
    },
    {
      "type": "table",
      "name": "work_idempotency_intents",
      "tbl_name": "work_idempotency_intents",
      "sql": "CREATE TABLE work_idempotency_intents (\n  idempotency_key TEXT PRIMARY KEY CHECK(length(idempotency_key) = 36),\n  operation_kind TEXT NOT NULL CHECK(length(CAST(operation_kind AS BLOB)) BETWEEN 1 AND 120),\n  work_id TEXT REFERENCES works(id) ON DELETE CASCADE,\n  request_digest TEXT NOT NULL CHECK(length(request_digest) = 64 AND request_digest NOT GLOB '*[^0-9a-f]*'),\n  result_json TEXT NOT NULL CHECK(json_valid(result_json) AND length(CAST(result_json AS BLOB)) <= 2097152),\n  created_at INTEGER NOT NULL CHECK(created_at >= 0)\n) STRICT"
    },
    {
      "type": "index",
      "name": "work_idempotency_work",
      "tbl_name": "work_idempotency_intents",
      "sql": "CREATE INDEX work_idempotency_work ON work_idempotency_intents(work_id,created_at,idempotency_key)"
    },
    {
      "type": "trigger",
      "name": "work_intents_no_delete",
      "tbl_name": "work_idempotency_intents",
      "sql": "CREATE TRIGGER work_intents_no_delete\nBEFORE DELETE ON work_idempotency_intents\nWHEN OLD.work_id IS NULL OR NOT EXISTS (\n  SELECT 1 FROM work_purge_authority WHERE work_id=OLD.work_id\n)\nBEGIN SELECT RAISE(ABORT,'WORK_INTENT_IMMUTABLE'); END"
    },
    {
      "type": "trigger",
      "name": "work_intents_no_update",
      "tbl_name": "work_idempotency_intents",
      "sql": "CREATE TRIGGER work_intents_no_update\nBEFORE UPDATE ON work_idempotency_intents BEGIN SELECT RAISE(ABORT,'WORK_INTENT_IMMUTABLE'); END"
    },
    {
      "type": "trigger",
      "name": "work_member_limit_guard",
      "tbl_name": "work_members",
      "sql": "CREATE TRIGGER work_member_limit_guard\nBEFORE INSERT ON work_members\nWHEN (SELECT COUNT(*) FROM work_members WHERE work_id=NEW.work_id) >= 256\nBEGIN SELECT RAISE(ABORT,'WORK_MEMBER_LIMIT'); END"
    },
    {
      "type": "table",
      "name": "work_members",
      "tbl_name": "work_members",
      "sql": "CREATE TABLE work_members (\n  work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,\n  session_id TEXT NOT NULL REFERENCES sessions(id),\n  joined_at INTEGER NOT NULL CHECK(joined_at >= 0),\n  PRIMARY KEY(work_id,session_id)\n) STRICT"
    },
    {
      "type": "trigger",
      "name": "work_members_no_delete",
      "tbl_name": "work_members",
      "sql": "CREATE TRIGGER work_members_no_delete\nBEFORE DELETE ON work_members\nWHEN NOT EXISTS (SELECT 1 FROM work_purge_authority WHERE work_id=OLD.work_id)\nBEGIN SELECT RAISE(ABORT,'WORK_MEMBER_IMMUTABLE'); END"
    },
    {
      "type": "trigger",
      "name": "work_members_no_update",
      "tbl_name": "work_members",
      "sql": "CREATE TRIGGER work_members_no_update\nBEFORE UPDATE ON work_members BEGIN SELECT RAISE(ABORT,'WORK_MEMBER_IMMUTABLE'); END"
    },
    {
      "type": "table",
      "name": "work_nested_effect_settlements",
      "tbl_name": "work_nested_effect_settlements",
      "sql": "CREATE TABLE work_nested_effect_settlements (\n  effect_idempotency_key TEXT PRIMARY KEY REFERENCES work_prepared_effects(idempotency_key) ON DELETE CASCADE,\n  nested_mutation_key TEXT NOT NULL UNIQUE CHECK(length(nested_mutation_key) = 36),\n  outcome TEXT NOT NULL CHECK(outcome IN ('accepted','failed')),\n  receipt_json TEXT CHECK(receipt_json IS NULL OR (json_valid(receipt_json) AND length(CAST(receipt_json AS BLOB)) <= 65536)),\n  receipt_digest TEXT NOT NULL CHECK(length(receipt_digest) = 64 AND receipt_digest NOT GLOB '*[^0-9a-f]*'),\n  created_at INTEGER NOT NULL CHECK(created_at >= 0)\n) STRICT"
    },
    {
      "type": "trigger",
      "name": "work_nested_effect_settlements_insert_guard",
      "tbl_name": "work_nested_effect_settlements",
      "sql": "CREATE TRIGGER work_nested_effect_settlements_insert_guard\nBEFORE INSERT ON work_nested_effect_settlements\nWHEN NOT EXISTS (\n  SELECT 1 FROM work_prepared_effects AS e\n  WHERE e.idempotency_key=NEW.effect_idempotency_key\n    AND json_extract(e.instruction_json,'$.nestedMutationKey')=NEW.nested_mutation_key\n)\nBEGIN SELECT RAISE(ABORT,'WORK_NESTED_EFFECT_SETTLEMENT_MISMATCH'); END"
    },
    {
      "type": "trigger",
      "name": "work_nested_effect_settlements_no_delete",
      "tbl_name": "work_nested_effect_settlements",
      "sql": "CREATE TRIGGER work_nested_effect_settlements_no_delete\nBEFORE DELETE ON work_nested_effect_settlements\nWHEN NOT EXISTS (\n  SELECT 1 FROM work_prepared_effects AS e\n  JOIN work_purge_authority AS p ON p.work_id=e.work_id\n  WHERE e.idempotency_key=OLD.effect_idempotency_key\n)\nBEGIN SELECT RAISE(ABORT,'WORK_NESTED_EFFECT_SETTLEMENT_IMMUTABLE'); END"
    },
    {
      "type": "trigger",
      "name": "work_nested_effect_settlements_no_update",
      "tbl_name": "work_nested_effect_settlements",
      "sql": "CREATE TRIGGER work_nested_effect_settlements_no_update\nBEFORE UPDATE ON work_nested_effect_settlements\nBEGIN SELECT RAISE(ABORT,'WORK_NESTED_EFFECT_SETTLEMENT_IMMUTABLE'); END"
    },
    {
      "type": "table",
      "name": "work_prepared_effects",
      "tbl_name": "work_prepared_effects",
      "sql": "CREATE TABLE work_prepared_effects (\n  idempotency_key TEXT PRIMARY KEY REFERENCES work_idempotency_intents(idempotency_key) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,\n  work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,\n  effect_kind TEXT NOT NULL CHECK(effect_kind IN ('attempt_dispatch','signal_send')),\n  subject_id TEXT NOT NULL CHECK(length(subject_id) BETWEEN 6 AND 80),\n  instruction_json TEXT NOT NULL CHECK(json_valid(instruction_json) AND length(CAST(instruction_json AS BLOB)) <= 2097152),\n  instruction_digest TEXT NOT NULL CHECK(length(instruction_digest) = 64 AND instruction_digest NOT GLOB '*[^0-9a-f]*'),\n  daemon_generation INTEGER NOT NULL CHECK(daemon_generation >= 0),\n  state TEXT NOT NULL CHECK(state IN ('prepared','effect_started','accepted','failed','unknown')),\n  outcome_digest TEXT CHECK(outcome_digest IS NULL OR (length(outcome_digest) = 64 AND outcome_digest NOT GLOB '*[^0-9a-f]*')),\n  outcome_json TEXT CHECK(outcome_json IS NULL OR (json_valid(outcome_json) AND length(CAST(outcome_json AS BLOB)) <= 65536)),\n  prepared_at INTEGER NOT NULL CHECK(prepared_at >= 0),\n  finalized_at INTEGER CHECK(finalized_at IS NULL OR finalized_at >= prepared_at),\n  CHECK((state IN ('prepared','effect_started') AND outcome_digest IS NULL AND outcome_json IS NULL AND finalized_at IS NULL)\n     OR (state NOT IN ('prepared','effect_started') AND outcome_digest IS NOT NULL AND outcome_json IS NOT NULL AND finalized_at IS NOT NULL))\n) STRICT"
    },
    {
      "type": "index",
      "name": "work_prepared_effects_pending",
      "tbl_name": "work_prepared_effects",
      "sql": "CREATE INDEX work_prepared_effects_pending ON work_prepared_effects(prepared_at,idempotency_key)\n  WHERE state IN ('prepared','effect_started')"
    },
    {
      "type": "trigger",
      "name": "work_profile_attempt_authority_guard",
      "tbl_name": "profiles",
      "sql": "CREATE TRIGGER work_profile_attempt_authority_guard\nBEFORE UPDATE OF state,process_generation ON profiles\nWHEN EXISTS (\n  SELECT 1 FROM work_attempts AS a\n  WHERE a.account_id=OLD.id\n    AND a.state IN ('claimed','dispatching','running')\n    AND (NEW.state!='signed_in' OR NEW.process_generation!=a.account_generation)\n)\nBEGIN SELECT RAISE(ABORT,'WORK_PROFILE_ATTEMPT_AUTHORITY'); END"
    },
    {
      "type": "table",
      "name": "work_purge_authority",
      "tbl_name": "work_purge_authority",
      "sql": "CREATE TABLE work_purge_authority (\n  singleton INTEGER PRIMARY KEY CHECK(singleton=1),\n  work_id TEXT NOT NULL UNIQUE CHECK(length(work_id) BETWEEN 6 AND 80),\n  idempotency_key TEXT NOT NULL UNIQUE CHECK(length(idempotency_key)=36),\n  created_at INTEGER NOT NULL CHECK(created_at>=0)\n) STRICT"
    },
    {
      "type": "trigger",
      "name": "work_receipt_chain_guard",
      "tbl_name": "work_signal_receipts",
      "sql": "CREATE TRIGGER work_receipt_chain_guard\nBEFORE INSERT ON work_signal_receipts\nWHEN NEW.sequence != COALESCE((\n  SELECT MAX(sequence)+1 FROM work_signal_receipts WHERE signal_id=NEW.signal_id\n),1)\nBEGIN SELECT RAISE(ABORT,'WORK_SIGNAL_RECEIPT_SEQUENCE'); END"
    },
    {
      "type": "trigger",
      "name": "work_receipts_no_delete",
      "tbl_name": "work_signal_receipts",
      "sql": "CREATE TRIGGER work_receipts_no_delete\nBEFORE DELETE ON work_signal_receipts\nWHEN NOT EXISTS (\n  SELECT 1 FROM work_signals AS s\n  JOIN work_purge_authority AS p ON p.work_id=s.work_id\n  WHERE s.id=OLD.signal_id\n)\nBEGIN SELECT RAISE(ABORT,'WORK_SIGNAL_RECEIPT_IMMUTABLE'); END"
    },
    {
      "type": "trigger",
      "name": "work_receipts_no_update",
      "tbl_name": "work_signal_receipts",
      "sql": "CREATE TRIGGER work_receipts_no_update\nBEFORE UPDATE ON work_signal_receipts BEGIN SELECT RAISE(ABORT,'WORK_SIGNAL_RECEIPT_IMMUTABLE'); END"
    },
    {
      "type": "table",
      "name": "work_release_tombstones",
      "tbl_name": "work_release_tombstones",
      "sql": "CREATE TABLE work_release_tombstones (\n  work_id TEXT PRIMARY KEY CHECK(length(work_id) BETWEEN 6 AND 80),\n  release_idempotency_key TEXT NOT NULL UNIQUE CHECK(length(release_idempotency_key)=36),\n  release_request_digest TEXT NOT NULL CHECK(length(release_request_digest)=64 AND release_request_digest NOT GLOB '*[^0-9a-f]*'),\n  client_ref_digest TEXT NOT NULL UNIQUE CHECK(length(client_ref_digest)=64 AND client_ref_digest NOT GLOB '*[^0-9a-f]*'),\n  coordinator_session_id TEXT NOT NULL CHECK(length(coordinator_session_id) BETWEEN 6 AND 80),\n  terminal_kind TEXT NOT NULL CHECK(terminal_kind IN ('work.complete','work.fail','work.cancel')),\n  terminal_request_digest TEXT NOT NULL CHECK(length(terminal_request_digest)=64 AND terminal_request_digest NOT GLOB '*[^0-9a-f]*'),\n  final_revision INTEGER NOT NULL CHECK(final_revision>0),\n  final_head_hash TEXT NOT NULL CHECK(length(final_head_hash)=64 AND final_head_hash NOT GLOB '*[^0-9a-f]*'),\n  discarded_counts_json TEXT NOT NULL CHECK(json_valid(discarded_counts_json) AND length(CAST(discarded_counts_json AS BLOB))<=4096),\n  discarded_records_digest TEXT NOT NULL CHECK(length(discarded_records_digest)=64 AND discarded_records_digest NOT GLOB '*[^0-9a-f]*'),\n  released_at INTEGER NOT NULL CHECK(released_at>=0),\n  retention_upper_bound_at INTEGER NOT NULL CHECK(retention_upper_bound_at>=released_at),\n  result_json TEXT NOT NULL CHECK(json_valid(result_json) AND length(CAST(result_json AS BLOB))<=65536)\n) STRICT"
    },
    {
      "type": "trigger",
      "name": "work_release_tombstones_no_update",
      "tbl_name": "work_release_tombstones",
      "sql": "CREATE TRIGGER work_release_tombstones_no_update\nBEFORE UPDATE ON work_release_tombstones\nBEGIN SELECT RAISE(ABORT,'WORK_RELEASE_TOMBSTONE_IMMUTABLE'); END"
    },
    {
      "type": "index",
      "name": "work_release_tombstones_retention",
      "tbl_name": "work_release_tombstones",
      "sql": "CREATE INDEX work_release_tombstones_retention\n  ON work_release_tombstones(released_at,work_id)"
    },
    {
      "type": "trigger",
      "name": "work_retained_limit_guard",
      "tbl_name": "works",
      "sql": "CREATE TRIGGER work_retained_limit_guard\nBEFORE INSERT ON works\nWHEN (SELECT COUNT(*) FROM works) >= 8192\nBEGIN SELECT RAISE(ABORT,'WORK_RETAINED_LIMIT'); END"
    },
    {
      "type": "trigger",
      "name": "work_review_member_guard",
      "tbl_name": "work_reviews",
      "sql": "CREATE TRIGGER work_review_member_guard\nBEFORE INSERT ON work_reviews\nWHEN NOT EXISTS (SELECT 1 FROM work_members WHERE work_id=NEW.work_id AND session_id=NEW.reviewer_session_id)\n  OR EXISTS (\n    SELECT 1 FROM work_submissions AS s\n    WHERE s.id=NEW.submission_id AND s.worker_session_id=NEW.reviewer_session_id\n  )\nBEGIN SELECT RAISE(ABORT,'WORK_REVIEWER_INVALID'); END"
    },
    {
      "type": "table",
      "name": "work_reviews",
      "tbl_name": "work_reviews",
      "sql": "CREATE TABLE work_reviews (\n  id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 6 AND 80),\n  work_id TEXT NOT NULL,\n  submission_id TEXT NOT NULL,\n  reviewer_session_id TEXT NOT NULL REFERENCES sessions(id),\n  decision TEXT NOT NULL CHECK(decision IN ('accept','revise','reject')),\n  review_json TEXT NOT NULL CHECK(json_valid(review_json) AND length(CAST(review_json AS BLOB)) <= 2097152),\n  review_digest TEXT NOT NULL CHECK(length(review_digest) = 64 AND review_digest NOT GLOB '*[^0-9a-f]*'),\n  created_at INTEGER NOT NULL CHECK(created_at >= 0),\n  UNIQUE(submission_id,reviewer_session_id),\n  UNIQUE(work_id,id),\n  FOREIGN KEY(work_id,submission_id) REFERENCES work_submissions(work_id,id) ON DELETE CASCADE\n) STRICT"
    },
    {
      "type": "trigger",
      "name": "work_reviews_no_delete",
      "tbl_name": "work_reviews",
      "sql": "CREATE TRIGGER work_reviews_no_delete\nBEFORE DELETE ON work_reviews\nWHEN NOT EXISTS (SELECT 1 FROM work_purge_authority WHERE work_id=OLD.work_id)\nBEGIN SELECT RAISE(ABORT,'WORK_REVIEW_IMMUTABLE'); END"
    },
    {
      "type": "trigger",
      "name": "work_reviews_no_update",
      "tbl_name": "work_reviews",
      "sql": "CREATE TRIGGER work_reviews_no_update\nBEFORE UPDATE ON work_reviews BEGIN SELECT RAISE(ABORT,'WORK_REVIEW_IMMUTABLE'); END"
    },
    {
      "type": "index",
      "name": "work_reviews_submission",
      "tbl_name": "work_reviews",
      "sql": "CREATE INDEX work_reviews_submission ON work_reviews(submission_id,created_at,id)"
    },
    {
      "type": "trigger",
      "name": "work_route_authority_guard",
      "tbl_name": "work_routes",
      "sql": "CREATE TRIGGER work_route_authority_guard\nBEFORE INSERT ON work_routes\nWHEN NOT EXISTS (SELECT 1 FROM profiles WHERE id=NEW.account_id AND state!='removed')\n  OR NOT EXISTS (SELECT 1 FROM projects WHERE id=NEW.project_id)\nBEGIN SELECT RAISE(ABORT,'WORK_ROUTE_MISMATCH'); END"
    },
    {
      "type": "trigger",
      "name": "work_route_limit_guard",
      "tbl_name": "work_routes",
      "sql": "CREATE TRIGGER work_route_limit_guard\nBEFORE INSERT ON work_routes\nWHEN (SELECT COUNT(*) FROM work_routes WHERE work_id=NEW.work_id) >= 64\nBEGIN SELECT RAISE(ABORT,'WORK_ROUTE_LIMIT'); END"
    },
    {
      "type": "table",
      "name": "work_routes",
      "tbl_name": "work_routes",
      "sql": "CREATE TABLE work_routes (\n  work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,\n  ordinal INTEGER NOT NULL CHECK(ordinal >= 0 AND ordinal < 64),\n  account_id TEXT NOT NULL REFERENCES profiles(id),\n  project_id TEXT NOT NULL REFERENCES projects(id),\n  preset TEXT NOT NULL CHECK(preset IN ('low','high','ultra')),\n  fast INTEGER NOT NULL CHECK(fast IN (0,1)),\n  PRIMARY KEY(work_id,account_id,project_id,preset,fast),\n  UNIQUE(work_id,ordinal)\n) STRICT"
    },
    {
      "type": "trigger",
      "name": "work_routes_no_delete",
      "tbl_name": "work_routes",
      "sql": "CREATE TRIGGER work_routes_no_delete\nBEFORE DELETE ON work_routes\nWHEN NOT EXISTS (SELECT 1 FROM work_purge_authority WHERE work_id=OLD.work_id)\nBEGIN SELECT RAISE(ABORT,'WORK_ROUTE_IMMUTABLE'); END"
    },
    {
      "type": "trigger",
      "name": "work_routes_no_update",
      "tbl_name": "work_routes",
      "sql": "CREATE TRIGGER work_routes_no_update\nBEFORE UPDATE ON work_routes BEGIN SELECT RAISE(ABORT,'WORK_ROUTE_IMMUTABLE'); END"
    },
    {
      "type": "trigger",
      "name": "work_session_attempt_authority_guard",
      "tbl_name": "sessions",
      "sql": "CREATE TRIGGER work_session_attempt_authority_guard\nBEFORE UPDATE OF profile_id,project_id,preset,fast_enabled ON sessions\nWHEN EXISTS (\n  SELECT 1 FROM work_attempts AS a\n  WHERE a.worker_session_id=OLD.id\n    AND a.state IN ('claimed','dispatching','running','recovery_required')\n    AND (\n      NEW.profile_id!=a.account_id OR NEW.project_id!=a.project_id\n      OR NEW.preset!=a.preset OR NEW.fast_enabled!=a.fast\n    )\n)\nBEGIN SELECT RAISE(ABORT,'WORK_SESSION_ATTEMPT_AUTHORITY'); END"
    },
    {
      "type": "trigger",
      "name": "work_signal_ack_guard",
      "tbl_name": "work_signal_receipts",
      "sql": "CREATE TRIGGER work_signal_ack_guard\nBEFORE INSERT ON work_signal_receipts\nWHEN NEW.kind='ack' AND NOT EXISTS (\n  SELECT 1 FROM work_signals AS s\n  WHERE s.id=NEW.signal_id AND s.to_session_id=NEW.actor_session_id\n)\nBEGIN SELECT RAISE(ABORT,'WORK_SIGNAL_ACK_ACTOR_INVALID'); END"
    },
    {
      "type": "trigger",
      "name": "work_signal_member_guard",
      "tbl_name": "work_signals",
      "sql": "CREATE TRIGGER work_signal_member_guard\nBEFORE INSERT ON work_signals\nWHEN NOT EXISTS (SELECT 1 FROM work_members WHERE work_id=NEW.work_id AND session_id=NEW.from_session_id)\n  OR NOT EXISTS (SELECT 1 FROM work_members WHERE work_id=NEW.work_id AND session_id=NEW.to_session_id)\n  OR NOT EXISTS (\n    SELECT 1 FROM sessions AS s JOIN profiles AS p ON p.id=s.profile_id\n    WHERE s.id=NEW.to_session_id AND s.state IN ('active','idle')\n      AND p.state='signed_in' AND p.process_generation=NEW.target_account_generation\n  )\nBEGIN SELECT RAISE(ABORT,'WORK_SIGNAL_MEMBER_INVALID'); END"
    },
    {
      "type": "table",
      "name": "work_signal_receipts",
      "tbl_name": "work_signal_receipts",
      "sql": "CREATE TABLE work_signal_receipts (\n  signal_id TEXT NOT NULL REFERENCES work_signals(id) ON DELETE CASCADE,\n  sequence INTEGER NOT NULL CHECK(sequence > 0),\n  kind TEXT NOT NULL CHECK(kind IN ('accepted','ack','unknown','failed')),\n  actor_session_id TEXT REFERENCES sessions(id),\n  detail_code TEXT CHECK(detail_code IS NULL OR length(CAST(detail_code AS BLOB)) BETWEEN 1 AND 120),\n  recorded_at INTEGER NOT NULL CHECK(recorded_at >= 0),\n  PRIMARY KEY(signal_id,sequence)\n) STRICT"
    },
    {
      "type": "index",
      "name": "work_signal_receipts_kind",
      "tbl_name": "work_signal_receipts",
      "sql": "CREATE INDEX work_signal_receipts_kind ON work_signal_receipts(signal_id,kind,sequence)"
    },
    {
      "type": "table",
      "name": "work_signals",
      "tbl_name": "work_signals",
      "sql": "CREATE TABLE work_signals (\n  id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 6 AND 80),\n  work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,\n  from_session_id TEXT NOT NULL REFERENCES sessions(id),\n  to_session_id TEXT NOT NULL REFERENCES sessions(id),\n  target_account_generation INTEGER NOT NULL CHECK(target_account_generation >= 0),\n  task_id TEXT,\n  reply_to_signal_id TEXT,\n  mode TEXT NOT NULL CHECK(mode IN ('queue','steer')),\n  body TEXT NOT NULL CHECK(length(CAST(body AS BLOB)) BETWEEN 1 AND 32768),\n  created_at INTEGER NOT NULL CHECK(created_at >= 0),\n  UNIQUE(work_id,id),\n  FOREIGN KEY(work_id,task_id) REFERENCES work_tasks(work_id,id) ON DELETE CASCADE,\n  FOREIGN KEY(work_id,reply_to_signal_id) REFERENCES work_signals(work_id,id) ON DELETE CASCADE\n) STRICT"
    },
    {
      "type": "trigger",
      "name": "work_signals_no_delete",
      "tbl_name": "work_signals",
      "sql": "CREATE TRIGGER work_signals_no_delete\nBEFORE DELETE ON work_signals\nWHEN NOT EXISTS (SELECT 1 FROM work_purge_authority WHERE work_id=OLD.work_id)\nBEGIN SELECT RAISE(ABORT,'WORK_SIGNAL_IMMUTABLE'); END"
    },
    {
      "type": "trigger",
      "name": "work_signals_no_update",
      "tbl_name": "work_signals",
      "sql": "CREATE TRIGGER work_signals_no_update\nBEFORE UPDATE ON work_signals BEGIN SELECT RAISE(ABORT,'WORK_SIGNAL_IMMUTABLE'); END"
    },
    {
      "type": "index",
      "name": "work_signals_recipient",
      "tbl_name": "work_signals",
      "sql": "CREATE INDEX work_signals_recipient ON work_signals(work_id,to_session_id,created_at,id)"
    },
    {
      "type": "table",
      "name": "work_submissions",
      "tbl_name": "work_submissions",
      "sql": "CREATE TABLE work_submissions (\n  id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 6 AND 80),\n  work_id TEXT NOT NULL,\n  task_id TEXT NOT NULL,\n  attempt_id TEXT NOT NULL,\n  worker_session_id TEXT NOT NULL REFERENCES sessions(id),\n  summary TEXT NOT NULL CHECK(length(CAST(summary AS BLOB)) BETWEEN 1 AND 16384),\n  result_json TEXT NOT NULL CHECK(json_valid(result_json) AND length(CAST(result_json AS BLOB)) <= 2097152),\n  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json) AND length(CAST(evidence_json AS BLOB)) <= 2097152),\n  content_digest TEXT NOT NULL CHECK(length(content_digest) = 64 AND content_digest NOT GLOB '*[^0-9a-f]*'),\n  created_at INTEGER NOT NULL CHECK(created_at >= 0),\n  UNIQUE(work_id,id),\n  UNIQUE(attempt_id),\n  FOREIGN KEY(work_id,task_id) REFERENCES work_tasks(work_id,id) ON DELETE CASCADE,\n  FOREIGN KEY(work_id,attempt_id) REFERENCES work_attempts(work_id,id) ON DELETE CASCADE\n) STRICT"
    },
    {
      "type": "trigger",
      "name": "work_submissions_no_delete",
      "tbl_name": "work_submissions",
      "sql": "CREATE TRIGGER work_submissions_no_delete\nBEFORE DELETE ON work_submissions\nWHEN NOT EXISTS (SELECT 1 FROM work_purge_authority WHERE work_id=OLD.work_id)\nBEGIN SELECT RAISE(ABORT,'WORK_SUBMISSION_IMMUTABLE'); END"
    },
    {
      "type": "trigger",
      "name": "work_submissions_no_update",
      "tbl_name": "work_submissions",
      "sql": "CREATE TRIGGER work_submissions_no_update\nBEFORE UPDATE ON work_submissions BEGIN SELECT RAISE(ABORT,'WORK_SUBMISSION_IMMUTABLE'); END"
    },
    {
      "type": "index",
      "name": "work_submissions_task",
      "tbl_name": "work_submissions",
      "sql": "CREATE INDEX work_submissions_task ON work_submissions(task_id,created_at,id)"
    },
    {
      "type": "table",
      "name": "work_task_dependencies",
      "tbl_name": "work_task_dependencies",
      "sql": "CREATE TABLE work_task_dependencies (\n  work_id TEXT NOT NULL,\n  task_id TEXT NOT NULL,\n  dependency_task_id TEXT NOT NULL,\n  ordinal INTEGER NOT NULL CHECK(ordinal >= 0 AND ordinal < 16),\n  created_at INTEGER NOT NULL CHECK(created_at >= 0),\n  PRIMARY KEY(work_id,task_id,dependency_task_id),\n  UNIQUE(work_id,task_id,ordinal),\n  FOREIGN KEY(work_id,task_id) REFERENCES work_tasks(work_id,id) ON DELETE CASCADE,\n  FOREIGN KEY(work_id,dependency_task_id) REFERENCES work_tasks(work_id,id) ON DELETE CASCADE,\n  CHECK(task_id != dependency_task_id)\n) STRICT"
    },
    {
      "type": "index",
      "name": "work_task_dependencies_reverse",
      "tbl_name": "work_task_dependencies",
      "sql": "CREATE INDEX work_task_dependencies_reverse\n  ON work_task_dependencies(work_id,dependency_task_id,task_id)"
    },
    {
      "type": "table",
      "name": "work_task_history_index",
      "tbl_name": "work_task_history_index",
      "sql": "CREATE TABLE work_task_history_index (\n  ordinal INTEGER PRIMARY KEY AUTOINCREMENT CHECK(ordinal > 0 AND ordinal <= 9007199254740991),\n  work_id TEXT NOT NULL,\n  task_id TEXT NOT NULL,\n  kind TEXT NOT NULL CHECK(kind IN ('attempt','attempt_report','submission','review','signal')),\n  stable_key TEXT NOT NULL CHECK(length(CAST(stable_key AS BLOB)) BETWEEN 6 AND 80),\n  created_at INTEGER NOT NULL CHECK(created_at >= 0),\n  UNIQUE(kind,stable_key),\n  FOREIGN KEY(work_id,task_id) REFERENCES work_tasks(work_id,id) ON DELETE CASCADE\n) STRICT"
    },
    {
      "type": "trigger",
      "name": "work_task_history_index_attempt",
      "tbl_name": "work_attempts",
      "sql": "CREATE TRIGGER work_task_history_index_attempt\nAFTER INSERT ON work_attempts\nBEGIN\n  INSERT INTO work_task_history_index(work_id,task_id,kind,stable_key,created_at)\n  VALUES (NEW.work_id,NEW.task_id,'attempt',NEW.id,NEW.created_at);\nEND"
    },
    {
      "type": "trigger",
      "name": "work_task_history_index_attempt_report",
      "tbl_name": "work_attempt_reports",
      "sql": "CREATE TRIGGER work_task_history_index_attempt_report\nAFTER INSERT ON work_attempt_reports\nBEGIN\n  INSERT INTO work_task_history_index(work_id,task_id,kind,stable_key,created_at)\n  SELECT NEW.work_id,a.task_id,'attempt_report',NEW.idempotency_key,NEW.created_at\n  FROM work_attempts AS a\n  WHERE a.work_id=NEW.work_id AND a.id=NEW.attempt_id;\nEND"
    },
    {
      "type": "trigger",
      "name": "work_task_history_index_no_delete",
      "tbl_name": "work_task_history_index",
      "sql": "CREATE TRIGGER work_task_history_index_no_delete\nBEFORE DELETE ON work_task_history_index\nWHEN NOT EXISTS (SELECT 1 FROM work_purge_authority WHERE work_id=OLD.work_id)\nBEGIN SELECT RAISE(ABORT,'WORK_TASK_HISTORY_INDEX_IMMUTABLE'); END"
    },
    {
      "type": "trigger",
      "name": "work_task_history_index_no_update",
      "tbl_name": "work_task_history_index",
      "sql": "CREATE TRIGGER work_task_history_index_no_update\nBEFORE UPDATE ON work_task_history_index\nBEGIN SELECT RAISE(ABORT,'WORK_TASK_HISTORY_INDEX_IMMUTABLE'); END"
    },
    {
      "type": "index",
      "name": "work_task_history_index_page",
      "tbl_name": "work_task_history_index",
      "sql": "CREATE INDEX work_task_history_index_page\n  ON work_task_history_index(work_id,task_id,ordinal DESC)"
    },
    {
      "type": "trigger",
      "name": "work_task_history_index_review",
      "tbl_name": "work_reviews",
      "sql": "CREATE TRIGGER work_task_history_index_review\nAFTER INSERT ON work_reviews\nBEGIN\n  INSERT INTO work_task_history_index(work_id,task_id,kind,stable_key,created_at)\n  SELECT NEW.work_id,s.task_id,'review',NEW.id,NEW.created_at\n  FROM work_submissions AS s\n  WHERE s.work_id=NEW.work_id AND s.id=NEW.submission_id;\nEND"
    },
    {
      "type": "trigger",
      "name": "work_task_history_index_signal",
      "tbl_name": "work_signals",
      "sql": "CREATE TRIGGER work_task_history_index_signal\nAFTER INSERT ON work_signals\nWHEN NEW.task_id IS NOT NULL\nBEGIN\n  INSERT INTO work_task_history_index(work_id,task_id,kind,stable_key,created_at)\n  VALUES (NEW.work_id,NEW.task_id,'signal',NEW.id,NEW.created_at);\nEND"
    },
    {
      "type": "trigger",
      "name": "work_task_history_index_submission",
      "tbl_name": "work_submissions",
      "sql": "CREATE TRIGGER work_task_history_index_submission\nAFTER INSERT ON work_submissions\nBEGIN\n  INSERT INTO work_task_history_index(work_id,task_id,kind,stable_key,created_at)\n  VALUES (NEW.work_id,NEW.task_id,'submission',NEW.id,NEW.created_at);\nEND"
    },
    {
      "type": "table",
      "name": "work_task_history_versions",
      "tbl_name": "work_task_history_versions",
      "sql": "CREATE TABLE work_task_history_versions (\n  ordinal INTEGER PRIMARY KEY AUTOINCREMENT CHECK(ordinal > 0 AND ordinal <= 9007199254740991),\n  history_ordinal INTEGER NOT NULL REFERENCES work_task_history_index(ordinal) ON DELETE CASCADE,\n  work_id TEXT NOT NULL,\n  task_id TEXT NOT NULL,\n  event_sequence INTEGER NOT NULL CHECK(event_sequence > 0),\n  record_json TEXT NOT NULL CHECK(\n    json_valid(record_json)\n    AND length(CAST(record_json AS BLOB)) <= 2097152\n  ),\n  record_digest TEXT NOT NULL CHECK(\n    length(record_digest)=64 AND record_digest NOT GLOB '*[^0-9a-f]*'\n  ),\n  created_at INTEGER NOT NULL CHECK(created_at >= 0),\n  UNIQUE(history_ordinal,event_sequence),\n  FOREIGN KEY(work_id,task_id) REFERENCES work_tasks(work_id,id) ON DELETE CASCADE,\n  FOREIGN KEY(work_id,event_sequence) REFERENCES work_events(work_id,sequence)\n    ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED\n) STRICT"
    },
    {
      "type": "trigger",
      "name": "work_task_history_versions_capacity",
      "tbl_name": "work_task_history_versions",
      "sql": "CREATE TRIGGER work_task_history_versions_capacity\nBEFORE INSERT ON work_task_history_versions\nWHEN (SELECT COUNT(*) FROM work_task_history_versions WHERE work_id=NEW.work_id)\n  >= 196864\nBEGIN SELECT RAISE(ABORT,'WORK_TASK_HISTORY_VERSION_LIMIT'); END"
    },
    {
      "type": "index",
      "name": "work_task_history_versions_cut",
      "tbl_name": "work_task_history_versions",
      "sql": "CREATE INDEX work_task_history_versions_cut\n  ON work_task_history_versions(history_ordinal,event_sequence DESC,ordinal DESC)"
    },
    {
      "type": "trigger",
      "name": "work_task_history_versions_no_delete",
      "tbl_name": "work_task_history_versions",
      "sql": "CREATE TRIGGER work_task_history_versions_no_delete\nBEFORE DELETE ON work_task_history_versions\nWHEN NOT EXISTS (SELECT 1 FROM work_purge_authority WHERE work_id=OLD.work_id)\nBEGIN SELECT RAISE(ABORT,'WORK_TASK_HISTORY_VERSION_IMMUTABLE'); END"
    },
    {
      "type": "trigger",
      "name": "work_task_history_versions_no_update",
      "tbl_name": "work_task_history_versions",
      "sql": "CREATE TRIGGER work_task_history_versions_no_update\nBEFORE UPDATE ON work_task_history_versions\nBEGIN SELECT RAISE(ABORT,'WORK_TASK_HISTORY_VERSION_IMMUTABLE'); END"
    },
    {
      "type": "index",
      "name": "work_task_history_versions_work",
      "tbl_name": "work_task_history_versions",
      "sql": "CREATE INDEX work_task_history_versions_work\n  ON work_task_history_versions(work_id,task_id,ordinal)"
    },
    {
      "type": "trigger",
      "name": "work_task_state_identity_immutable",
      "tbl_name": "work_task_states",
      "sql": "CREATE TRIGGER work_task_state_identity_immutable\nBEFORE UPDATE OF task_id,work_id,next_fence,attempt_count ON work_task_states\nWHEN NEW.next_fence < OLD.next_fence OR NEW.attempt_count < OLD.attempt_count OR NEW.task_id != OLD.task_id OR NEW.work_id != OLD.work_id\nBEGIN SELECT RAISE(ABORT,'WORK_TASK_STATE_MONOTONIC'); END"
    },
    {
      "type": "trigger",
      "name": "work_task_state_revision_guard",
      "tbl_name": "work_task_states",
      "sql": "CREATE TRIGGER work_task_state_revision_guard\nBEFORE UPDATE ON work_task_states\nWHEN NEW.revision != OLD.revision + 1\nBEGIN SELECT RAISE(ABORT,'WORK_TASK_STATE_REVISION'); END"
    },
    {
      "type": "table",
      "name": "work_task_states",
      "tbl_name": "work_task_states",
      "sql": "CREATE TABLE work_task_states (\n  task_id TEXT PRIMARY KEY REFERENCES work_tasks(id) ON DELETE CASCADE,\n  work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,\n  state TEXT NOT NULL CHECK(state IN ('pending','claimed','dispatching','running','submitted','completed','failed','recovery_required','cancelled')),\n  revision INTEGER NOT NULL CHECK(revision > 0),\n  next_fence INTEGER NOT NULL CHECK(next_fence > 0),\n  attempt_count INTEGER NOT NULL CHECK(attempt_count >= 0),\n  accepted_submission_id TEXT REFERENCES work_submissions(id) DEFERRABLE INITIALLY DEFERRED,\n  retry_not_before INTEGER CHECK(retry_not_before IS NULL OR retry_not_before >= 0),\n  updated_at INTEGER NOT NULL CHECK(updated_at >= 0),\n  UNIQUE(work_id,task_id),\n  CHECK((state = 'completed' AND accepted_submission_id IS NOT NULL) OR state != 'completed')\n) STRICT"
    },
    {
      "type": "index",
      "name": "work_task_states_ready",
      "tbl_name": "work_task_states",
      "sql": "CREATE INDEX work_task_states_ready ON work_task_states(work_id,state,updated_at,task_id)"
    },
    {
      "type": "table",
      "name": "work_tasks",
      "tbl_name": "work_tasks",
      "sql": "CREATE TABLE work_tasks (\n  id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 6 AND 80),\n  work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,\n  client_ref TEXT NOT NULL CHECK(length(CAST(client_ref AS BLOB)) BETWEEN 1 AND 256),\n  ordinal INTEGER NOT NULL CHECK(ordinal >= 0 AND ordinal < 256),\n  parent_task_id TEXT,\n  depth INTEGER NOT NULL CHECK(depth BETWEEN 1 AND 8),\n  objective TEXT NOT NULL CHECK(length(CAST(objective AS BLOB)) BETWEEN 1 AND 16384),\n  instructions TEXT NOT NULL CHECK(length(CAST(instructions AS BLOB)) BETWEEN 1 AND 32768),\n  criteria_json TEXT NOT NULL CHECK(json_valid(criteria_json) AND length(CAST(criteria_json AS BLOB)) <= 32768),\n  account_id TEXT NOT NULL REFERENCES profiles(id),\n  project_id TEXT NOT NULL REFERENCES projects(id),\n  preset TEXT NOT NULL CHECK(preset IN ('low','high','ultra')),\n  fast INTEGER NOT NULL CHECK(fast IN (0,1)),\n  priority INTEGER NOT NULL CHECK(priority BETWEEN -100 AND 100),\n  not_before INTEGER CHECK(not_before IS NULL OR not_before >= 0),\n  claim_by INTEGER CHECK(claim_by IS NULL OR claim_by >= 0),\n  deadline INTEGER CHECK(deadline IS NULL OR deadline >= 0),\n  max_attempts INTEGER NOT NULL CHECK(max_attempts BETWEEN 1 AND 32),\n  required_reviews INTEGER NOT NULL CHECK(required_reviews BETWEEN 0 AND 16),\n  result_kind TEXT NOT NULL CHECK(result_kind IN ('text','json')),\n  min_evidence INTEGER NOT NULL CHECK(min_evidence BETWEEN 0 AND 16),\n  created_at INTEGER NOT NULL CHECK(created_at >= 0),\n  UNIQUE(work_id,id),\n  UNIQUE(work_id,client_ref),\n  FOREIGN KEY(work_id,parent_task_id) REFERENCES work_tasks(work_id,id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,\n  FOREIGN KEY(work_id,account_id,project_id,preset,fast)\n    REFERENCES work_routes(work_id,account_id,project_id,preset,fast) ON DELETE CASCADE,\n  CHECK(parent_task_id IS NULL OR parent_task_id != id),\n  CHECK(claim_by IS NULL OR not_before IS NULL OR claim_by > not_before),\n  CHECK(deadline IS NULL OR not_before IS NULL OR deadline > not_before),\n  CHECK(deadline IS NULL OR claim_by IS NULL OR deadline >= claim_by)\n) STRICT"
    },
    {
      "type": "trigger",
      "name": "work_tasks_no_delete",
      "tbl_name": "work_tasks",
      "sql": "CREATE TRIGGER work_tasks_no_delete\nBEFORE DELETE ON work_tasks\nWHEN NOT EXISTS (SELECT 1 FROM work_purge_authority WHERE work_id=OLD.work_id)\nBEGIN SELECT RAISE(ABORT,'WORK_TASK_IMMUTABLE'); END"
    },
    {
      "type": "trigger",
      "name": "work_tasks_no_update",
      "tbl_name": "work_tasks",
      "sql": "CREATE TRIGGER work_tasks_no_update\nBEFORE UPDATE ON work_tasks BEGIN SELECT RAISE(ABORT,'WORK_TASK_IMMUTABLE'); END"
    },
    {
      "type": "index",
      "name": "work_tasks_order",
      "tbl_name": "work_tasks",
      "sql": "CREATE INDEX work_tasks_order ON work_tasks(work_id,priority DESC,ordinal,id)"
    },
    {
      "type": "index",
      "name": "work_tasks_parent",
      "tbl_name": "work_tasks",
      "sql": "CREATE INDEX work_tasks_parent ON work_tasks(work_id,parent_task_id,ordinal,id)"
    },
    {
      "type": "table",
      "name": "work_terminal_requests",
      "tbl_name": "work_terminal_requests",
      "sql": "CREATE TABLE work_terminal_requests (\n  work_id TEXT PRIMARY KEY REFERENCES works(id) ON DELETE CASCADE,\n  idempotency_key TEXT NOT NULL UNIQUE CHECK(length(idempotency_key)=36),\n  kind TEXT NOT NULL CHECK(kind IN ('work.complete','work.fail','work.cancel')),\n  state TEXT NOT NULL CHECK(state IN ('requested','settled')),\n  actor_session_id TEXT NOT NULL REFERENCES sessions(id),\n  summary TEXT NOT NULL CHECK(length(CAST(summary AS BLOB)) BETWEEN 1 AND 16384),\n  result_json TEXT CHECK(result_json IS NULL OR (\n    json_valid(result_json) AND length(CAST(result_json AS BLOB))<=2097152\n  )),\n  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json) AND length(CAST(evidence_json AS BLOB))<=2097152),\n  request_digest TEXT NOT NULL CHECK(length(request_digest)=64 AND request_digest NOT GLOB '*[^0-9a-f]*'),\n  requested_at INTEGER NOT NULL CHECK(requested_at>=0),\n  settled_at INTEGER CHECK(settled_at IS NULL OR settled_at>=requested_at),\n  CHECK((state='requested' AND settled_at IS NULL) OR (state='settled' AND settled_at IS NOT NULL)),\n  CHECK((kind='work.complete' AND (result_json IS NULL OR json_valid(result_json)))\n     OR (kind!='work.complete' AND result_json IS NULL))\n) STRICT"
    },
    {
      "type": "trigger",
      "name": "work_terminal_requests_no_delete",
      "tbl_name": "work_terminal_requests",
      "sql": "CREATE TRIGGER work_terminal_requests_no_delete\nBEFORE DELETE ON work_terminal_requests\nWHEN NOT EXISTS (SELECT 1 FROM work_purge_authority WHERE work_id=OLD.work_id)\nBEGIN SELECT RAISE(ABORT,'WORK_TERMINAL_REQUEST_IMMUTABLE'); END"
    },
    {
      "type": "trigger",
      "name": "work_terminal_requests_no_update",
      "tbl_name": "work_terminal_requests",
      "sql": "CREATE TRIGGER work_terminal_requests_no_update\nBEFORE UPDATE ON work_terminal_requests\nWHEN NOT (\n  OLD.state='requested' AND NEW.state='settled'\n  AND OLD.settled_at IS NULL AND NEW.settled_at IS NOT NULL\n  AND NEW.work_id=OLD.work_id\n  AND NEW.idempotency_key=OLD.idempotency_key\n  AND NEW.kind=OLD.kind\n  AND NEW.actor_session_id=OLD.actor_session_id\n  AND NEW.summary=OLD.summary\n  AND NEW.result_json IS OLD.result_json\n  AND NEW.evidence_json=OLD.evidence_json\n  AND NEW.request_digest=OLD.request_digest\n  AND NEW.requested_at=OLD.requested_at\n)\nBEGIN SELECT RAISE(ABORT,'WORK_TERMINAL_REQUEST_IMMUTABLE'); END"
    },
    {
      "type": "table",
      "name": "works",
      "tbl_name": "works",
      "sql": "CREATE TABLE works (\n  id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 6 AND 80),\n  client_ref TEXT NOT NULL UNIQUE CHECK(length(CAST(client_ref AS BLOB)) BETWEEN 1 AND 256),\n  coordinator_session_id TEXT NOT NULL REFERENCES sessions(id),\n  objective TEXT NOT NULL CHECK(length(CAST(objective AS BLOB)) BETWEEN 1 AND 16384),\n  state TEXT NOT NULL CHECK(state IN ('active','cancel_pending','fail_pending','completed','failed','cancelled')),\n  revision INTEGER NOT NULL CHECK(revision >= 0),\n  stream_epoch TEXT NOT NULL CHECK(length(stream_epoch) = 36),\n  next_sequence INTEGER NOT NULL CHECK(next_sequence > 0),\n  head_hash TEXT CHECK(head_hash IS NULL OR (length(head_hash) = 64 AND head_hash NOT GLOB '*[^0-9a-f]*')),\n  created_at INTEGER NOT NULL CHECK(created_at >= 0),\n  updated_at INTEGER NOT NULL CHECK(updated_at >= created_at),\n  CHECK((next_sequence = 1 AND head_hash IS NULL) OR (next_sequence > 1 AND head_hash IS NOT NULL))\n) STRICT"
    },
    {
      "type": "trigger",
      "name": "works_identity_immutable",
      "tbl_name": "works",
      "sql": "CREATE TRIGGER works_identity_immutable\nBEFORE UPDATE OF id,client_ref,coordinator_session_id,objective,stream_epoch,created_at ON works\nBEGIN SELECT RAISE(ABORT,'WORK_IMMUTABLE'); END"
    },
    {
      "type": "trigger",
      "name": "works_no_delete",
      "tbl_name": "works",
      "sql": "CREATE TRIGGER works_no_delete\nBEFORE DELETE ON works\nWHEN NOT EXISTS (SELECT 1 FROM work_purge_authority WHERE work_id=OLD.id)\nBEGIN SELECT RAISE(ABORT,'WORK_IMMUTABLE'); END"
    },
    {
      "type": "trigger",
      "name": "works_state_guard",
      "tbl_name": "works",
      "sql": "CREATE TRIGGER works_state_guard\nBEFORE UPDATE OF state ON works\nWHEN NOT (\n  OLD.state = NEW.state OR\n  (OLD.state = 'active' AND NEW.state IN ('cancel_pending','fail_pending','completed','failed','cancelled')) OR\n  (OLD.state = 'cancel_pending' AND NEW.state='cancelled') OR\n  (OLD.state = 'fail_pending' AND NEW.state='failed')\n)\nBEGIN SELECT RAISE(ABORT,'WORK_STATE_TRANSITION'); END"
    },
    {
      "type": "trigger",
      "name": "works_stream_advance_guard",
      "tbl_name": "works",
      "sql": "CREATE TRIGGER works_stream_advance_guard\nBEFORE UPDATE OF revision,next_sequence,head_hash ON works\nWHEN NEW.revision != OLD.revision + 1\n  OR NEW.next_sequence != OLD.next_sequence + 1\n  OR NOT EXISTS (\n    SELECT 1 FROM work_events AS e\n    WHERE e.work_id=OLD.id\n      AND e.sequence=OLD.next_sequence\n      AND e.revision=NEW.revision\n      AND e.previous_hash IS OLD.head_hash\n      AND e.event_hash=NEW.head_hash\n  )\nBEGIN SELECT RAISE(ABORT,'WORK_STREAM_ADVANCE_INVALID'); END"
    }
  ],
  "migrations": [
    {
      "version": 1,
      "applied_at": 1000
    },
    {
      "version": 2,
      "applied_at": 1000
    },
    {
      "version": 3,
      "applied_at": 1000
    },
    {
      "version": 4,
      "applied_at": 1000
    },
    {
      "version": 5,
      "applied_at": 1000
    },
    {
      "version": 6,
      "applied_at": 1000
    },
    {
      "version": 7,
      "applied_at": 1000
    },
    {
      "version": 8,
      "applied_at": 1000
    },
    {
      "version": 9,
      "applied_at": 1000
    },
    {
      "version": 10,
      "applied_at": 1000
    },
    {
      "version": 11,
      "applied_at": 1000
    },
    {
      "version": 12,
      "applied_at": 1000
    },
    {
      "version": 13,
      "applied_at": 1000
    },
    {
      "version": 14,
      "applied_at": 1000
    },
    {
      "version": 15,
      "applied_at": 1000
    },
    {
      "version": 16,
      "applied_at": 1000
    },
    {
      "version": 17,
      "applied_at": 1000
    },
    {
      "version": 18,
      "applied_at": 1000
    },
    {
      "version": 19,
      "applied_at": 1000
    },
    {
      "version": 20,
      "applied_at": 1000
    },
    {
      "version": 21,
      "applied_at": 1000
    },
    {
      "version": 22,
      "applied_at": 1000
    },
    {
      "version": 23,
      "applied_at": 1000
    },
    {
      "version": 24,
      "applied_at": 1000
    },
    {
      "version": 25,
      "applied_at": 1000
    },
    {
      "version": 26,
      "applied_at": 1000
    },
    {
      "version": 27,
      "applied_at": 1000
    },
    {
      "version": 28,
      "applied_at": 1000
    },
    {
      "version": 29,
      "applied_at": 1000
    },
    {
      "version": 30,
      "applied_at": 1000
    }
  ]
} as const;

export const canonical30WorkFixtureGeneratorSource = "import { createHash } from \"node:crypto\";\nimport { readFile } from \"node:fs/promises\";\nimport { gzipSync } from \"node:zlib\";\nimport { Database } from \"bun:sqlite\";\nimport { StateStore } from \"./src/storage/state-store\";\nimport { initializeStatePaths, resolveStatePaths } from \"./src/storage/paths\";\n\nconst paths = resolveStatePaths({ homeDirectory: `${import.meta.dir}/fixture-home`, platform: \"darwin\" });\nawait initializeStatePaths(paths);\nconst store = new StateStore(paths, { now: () => 1_000 });\nconst profile = store.nextProfileGeneration(store.createProfile(\"Canonical30 Work migration\").id);\nif (!store.setProfileState(profile.id, profile.processGeneration, \"signed_in\", {\n  email: \"canonical30@example.com\", plan: \"Plus\",\n})) throw new Error(\"Archived sign-in failed.\");\nconst starting = store.createSession({ profileId: profile.id, preset: \"high\", fastEnabled: false });\nconst session = store.bindSession({ sessionId: starting.id, expectedRevision: starting.revision,\n  providerThreadId: \"canonical30-autorespond-history\", state: \"idle\" });\nstore.recordAutorespondEvidence({\n  sessionId: session.id, interactionId: \"30000000-0000-4000-8000-000000000030\",\n  kind: \"command_approval\", approvalClass: \"canonical30-history\", decision: \"decline\",\n  mode: \"manual\", outcome: \"refused\", latencyMs: 4, subagent: false,\n});\nstore.close();\nconst database = new Database(paths.database);\ndatabase.exec(\"PRAGMA wal_checkpoint(TRUNCATE)\");\nif ((database.query(\"PRAGMA user_version\").get() as { user_version: number }).user_version !== 30) {\n  throw new Error(\"Wrong archived schema.\");\n}\nconst migrations = database.query(\"SELECT version,applied_at FROM migrations ORDER BY version\").all();\nconst evidence = database.query(\"SELECT * FROM autorespond_evidence ORDER BY id\").all();\nconst sessionRow = database.query(\"SELECT * FROM sessions WHERE id=?\").get(session.id);\nconst workObjects = database.query(\"SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name='works' OR name GLOB 'work_*' OR name GLOB 'works_*' ORDER BY name\").all();\nif (database.query(\"SELECT name FROM pragma_table_info('sessions') WHERE name='provider'\").get() !== null\n  || database.query(\"SELECT name FROM pragma_table_info('autorespond_evidence') WHERE name='path'\").get() !== null) {\n  throw new Error(\"Archived schema unexpectedly has later columns.\");\n}\ndatabase.close();\nconst bytes = await readFile(paths.database);\nconst source = await readFile(import.meta.filename, \"utf8\");\nconst meta = {\n  sourceRevision: \"dd1f2989536074fa83e4574bb9d18086088bb7fb\", schemaVersion: 30,\n  databaseSha256: createHash(\"sha256\").update(bytes).digest(\"hex\"), databaseBytes: bytes.length,\n  generatorSha256: createHash(\"sha256\").update(source).digest(\"hex\"),\n  profileId: profile.id, sessionId: session.id, sessionRow, evidence, workObjects, migrations,\n};\nconsole.log(JSON.stringify({ meta, source, gzip: gzipSync(bytes).toString(\"base64\") }));\n";

const encodedDatabase = [
  "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",
].join("");

export function canonical30WorkDatabaseBytes(): Uint8Array {
  const bytes = gunzipSync(Buffer.from(encodedDatabase, "base64"), {
    maxOutputLength: canonical30WorkFixture.databaseBytes,
  });
  if (bytes.byteLength !== canonical30WorkFixture.databaseBytes
    || createHash("sha256").update(bytes).digest("hex") !== canonical30WorkFixture.databaseSha256
    || createHash("sha256").update(canonical30WorkFixtureGeneratorSource).digest("hex") !== canonical30WorkFixture.generatorSha256) {
    throw new Error("The archived canonical30-work fixture does not match its frozen provenance.");
  }
  return new Uint8Array(bytes);
}
