/**
 * Immutable delivery intent for app-owned composer message IDs. The original
 * request can be proved after a renderer loses its command response without
 * retaining a second copy of private message or attachment content.
 */
export const CHAT_MESSAGE_IDEMPOTENCY_SCHEMA_V1_SQL = `
  ALTER TABLE chat_message_ledger
    ADD COLUMN request_delivery_kind TEXT NOT NULL DEFAULT 'legacy'
      CHECK (request_delivery_kind IN ('legacy', 'queue', 'steer_head'));
  ALTER TABLE chat_message_ledger
    ADD COLUMN request_steer_turn_id TEXT CHECK (
      request_steer_turn_id IS NULL OR (
        length(request_steer_turn_id) BETWEEN 16 AND 96
        AND request_steer_turn_id GLOB 'chatturn_[A-Za-z0-9_-]*'
        AND substr(request_steer_turn_id, 10) NOT GLOB '*[^A-Za-z0-9_-]*'
      )
    );
  ALTER TABLE chat_message_ledger
    ADD COLUMN request_fingerprint_hmac TEXT CHECK (
      request_fingerprint_hmac IS NULL OR (
        length(request_fingerprint_hmac) = 64
        AND request_fingerprint_hmac NOT GLOB '*[^a-f0-9]*'
      )
    );
  ALTER TABLE chat_message_ledger
    ADD COLUMN request_delivery_outcome TEXT NOT NULL DEFAULT 'legacy'
      CHECK (request_delivery_outcome IN (
        'legacy', 'pending', 'accepted', 'effect_started',
        'not_applied', 'ambiguous'
      ));

  CREATE TRIGGER chat_message_request_intent_insert_guard
  BEFORE INSERT ON chat_message_ledger
  WHEN NOT (
    (NEW.request_delivery_kind = 'queue'
      AND NEW.request_steer_turn_id IS NULL
      AND NEW.request_fingerprint_hmac IS NOT NULL
      AND NEW.request_delivery_outcome = 'accepted')
    OR
    (NEW.request_delivery_kind = 'steer_head'
      AND NEW.request_steer_turn_id IS NOT NULL
      AND NEW.request_fingerprint_hmac IS NOT NULL
      AND NEW.request_delivery_outcome = 'pending')
    OR
    (NEW.request_delivery_kind = 'legacy'
      AND NEW.request_steer_turn_id IS NULL
      AND NEW.request_fingerprint_hmac IS NULL
      AND NEW.request_delivery_outcome = 'legacy')
  )
  BEGIN
    SELECT RAISE(ABORT, 'chat message request intent is invalid');
  END;

  CREATE TRIGGER chat_message_request_intent_immutable
  BEFORE UPDATE OF request_delivery_kind, request_steer_turn_id,
    request_fingerprint_hmac
    ON chat_message_ledger
  WHEN NEW.request_delivery_kind IS NOT OLD.request_delivery_kind
    OR NEW.request_steer_turn_id IS NOT OLD.request_steer_turn_id
    OR NEW.request_fingerprint_hmac IS NOT OLD.request_fingerprint_hmac
  BEGIN
    SELECT RAISE(ABORT, 'chat message request intent is immutable');
  END;

  CREATE TRIGGER chat_message_request_outcome_transition_guard
  BEFORE UPDATE OF request_delivery_outcome ON chat_message_ledger
  WHEN NOT (
    NEW.request_delivery_kind = 'steer_head'
    AND (
      (OLD.request_delivery_outcome = 'pending'
        AND NEW.request_delivery_outcome IN ('effect_started', 'not_applied'))
      OR
      (OLD.request_delivery_outcome = 'effect_started'
        AND NEW.request_delivery_outcome IN ('accepted', 'ambiguous'))
    )
  )
  BEGIN
    SELECT RAISE(ABORT, 'chat message request outcome transition is invalid');
  END;
`;
