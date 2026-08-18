/**
 * Additive, content-free longitudinal routing memory. The observation ledger
 * captures immutable route/outcome facts. Token dimensions remain sourced
 * from the terminal attempt ledger so late positioned breakdown evidence is
 * never frozen as a falsely complete snapshot.
 */
export const LONGITUDINAL_ROUTING_SCHEMA_V1_SQL = `
  ALTER TABLE harness_program_operation_receipts
    ADD COLUMN semantic_operation TEXT CHECK (
      semantic_operation IS NULL OR semantic_operation = 'routing.inspect'
    );

  CREATE TRIGGER harness_program_receipt_semantic_operation_insert_guard
  BEFORE INSERT ON harness_program_operation_receipts
  WHEN NEW.semantic_operation IS NOT NULL AND NOT (
    NEW.semantic_operation = 'routing.inspect'
    AND NEW.operation = 'agent.status'
    AND NEW.replay_class = 'pureRead'
  )
  BEGIN
    SELECT RAISE(ABORT, 'invalid semantic operation compatibility pair');
  END;

  CREATE TRIGGER harness_program_receipt_semantic_operation_immutable
  BEFORE UPDATE OF semantic_operation, operation
  ON harness_program_operation_receipts
  WHEN NEW.semantic_operation IS NOT OLD.semantic_operation
    OR NEW.operation != OLD.operation
  BEGIN
    SELECT RAISE(ABORT, 'program receipt operation identity is immutable');
  END;

  CREATE TABLE harness_longitudinal_routing_observations (
    result_id TEXT PRIMARY KEY
      REFERENCES harness_actor_results(result_id) ON DELETE CASCADE,
    pane_id TEXT NOT NULL
      REFERENCES chat_panes(pane_id) ON DELETE CASCADE,
    policy_version INTEGER NOT NULL CHECK (policy_version IN (0, 1)),
    work_class TEXT NOT NULL CHECK (work_class IN (
      'legacyUnclassified', 'largeChange', 'wideResearch',
      'standard', 'boundedLeaf'
    )),
    routed_profile TEXT NOT NULL CHECK (routed_profile IN (
      'solUltra', 'solMax', 'lunaMax', 'unobserved'
    )),
    requested_service_tier TEXT NOT NULL CHECK (
      requested_service_tier IN ('standard', 'fast', 'unobserved')
    ),
    realized_service_tier TEXT NOT NULL CHECK (
      realized_service_tier IN ('standard', 'fast', 'unobserved')
    ),
    operational_outcome TEXT NOT NULL CHECK (
      operational_outcome IN (
        'succeeded', 'failed', 'cancelled', 'quotaRejected'
      )
    ),
    quality_state TEXT NOT NULL DEFAULT 'unobserved'
      CHECK (quality_state = 'unobserved')
  ) STRICT;

  CREATE INDEX harness_longitudinal_routing_observation_pane_idx
    ON harness_longitudinal_routing_observations(
      pane_id, policy_version, work_class, routed_profile,
      realized_service_tier, result_id
    );

  CREATE TABLE harness_longitudinal_routing_usage_current (
    result_id TEXT PRIMARY KEY
      REFERENCES harness_longitudinal_routing_observations(result_id)
      ON DELETE CASCADE,
    input_tokens INTEGER CHECK (
      input_tokens IS NULL OR input_tokens BETWEEN 0 AND 9007199254740991
    ),
    cached_input_tokens INTEGER CHECK (
      cached_input_tokens IS NULL
      OR cached_input_tokens BETWEEN 0 AND 9007199254740991
    ),
    uncached_input_tokens INTEGER CHECK (
      uncached_input_tokens IS NULL
      OR uncached_input_tokens BETWEEN 0 AND 9007199254740991
    ),
    output_tokens INTEGER CHECK (
      output_tokens IS NULL OR output_tokens BETWEEN 0 AND 9007199254740991
    ),
    reasoning_output_tokens INTEGER CHECK (
      reasoning_output_tokens IS NULL
      OR reasoning_output_tokens BETWEEN 0 AND 9007199254740991
    ),
    elapsed_milliseconds INTEGER CHECK (
      elapsed_milliseconds IS NULL
      OR elapsed_milliseconds BETWEEN 0 AND 9007199254740991
    ),
    CHECK (
      uncached_input_tokens IS NULL OR (
        input_tokens IS NOT NULL AND cached_input_tokens IS NOT NULL
        AND cached_input_tokens <= input_tokens
        AND uncached_input_tokens = input_tokens - cached_input_tokens
      )
    )
  ) STRICT;

  CREATE TABLE harness_longitudinal_routing_arm_stats (
    pane_id TEXT NOT NULL
      REFERENCES chat_panes(pane_id) ON DELETE CASCADE,
    policy_version INTEGER NOT NULL CHECK (policy_version IN (0, 1)),
    work_class TEXT NOT NULL CHECK (work_class IN (
      'legacyUnclassified', 'largeChange', 'wideResearch',
      'standard', 'boundedLeaf'
    )),
    routed_profile TEXT NOT NULL CHECK (routed_profile IN (
      'solUltra', 'solMax', 'lunaMax', 'unobserved'
    )),
    requested_service_tier TEXT NOT NULL CHECK (
      requested_service_tier IN ('standard', 'fast', 'unobserved')
    ),
    realized_service_tier TEXT NOT NULL CHECK (
      realized_service_tier IN ('standard', 'fast', 'unobserved')
    ),
    result_count INTEGER NOT NULL CHECK (result_count > 0),
    succeeded_count INTEGER NOT NULL CHECK (succeeded_count >= 0),
    failed_count INTEGER NOT NULL CHECK (failed_count >= 0),
    cancelled_count INTEGER NOT NULL CHECK (cancelled_count >= 0),
    quota_rejected_count INTEGER NOT NULL CHECK (quota_rejected_count >= 0),
    quality_evaluated_count INTEGER NOT NULL DEFAULT 0
      CHECK (quality_evaluated_count = 0),
    input_observed_count INTEGER NOT NULL CHECK (input_observed_count >= 0),
    input_tokens_total INTEGER NOT NULL CHECK (input_tokens_total >= 0),
    cached_input_observed_count INTEGER NOT NULL
      CHECK (cached_input_observed_count >= 0),
    cached_input_tokens_total INTEGER NOT NULL
      CHECK (cached_input_tokens_total >= 0),
    uncached_input_observed_count INTEGER NOT NULL
      CHECK (uncached_input_observed_count >= 0),
    uncached_input_tokens_total INTEGER NOT NULL
      CHECK (uncached_input_tokens_total >= 0),
    output_observed_count INTEGER NOT NULL CHECK (output_observed_count >= 0),
    output_tokens_total INTEGER NOT NULL CHECK (output_tokens_total >= 0),
    reasoning_output_observed_count INTEGER NOT NULL
      CHECK (reasoning_output_observed_count >= 0),
    reasoning_output_tokens_total INTEGER NOT NULL
      CHECK (reasoning_output_tokens_total >= 0),
    elapsed_observed_count INTEGER NOT NULL CHECK (elapsed_observed_count >= 0),
    elapsed_milliseconds_total INTEGER NOT NULL
      CHECK (elapsed_milliseconds_total >= 0),
    PRIMARY KEY (
      pane_id, policy_version, work_class, routed_profile,
      requested_service_tier, realized_service_tier
    ),
    CHECK (
      succeeded_count + failed_count + cancelled_count +
        quota_rejected_count = result_count
    ),
    CHECK (input_observed_count <= result_count),
    CHECK (cached_input_observed_count <= result_count),
    CHECK (uncached_input_observed_count <= result_count),
    CHECK (output_observed_count <= result_count),
    CHECK (reasoning_output_observed_count <= result_count),
    CHECK (elapsed_observed_count <= result_count)
  ) STRICT;

  CREATE TABLE harness_longitudinal_routing_pane_heads (
    pane_id TEXT PRIMARY KEY
      REFERENCES chat_panes(pane_id) ON DELETE CASCADE,
    observation_revision INTEGER NOT NULL CHECK (observation_revision > 0),
    analyzed_revision INTEGER NOT NULL DEFAULT 0 CHECK (
      analyzed_revision BETWEEN 0 AND observation_revision
    ),
    result_count INTEGER NOT NULL CHECK (result_count >= 0)
  ) STRICT;

  CREATE INDEX harness_longitudinal_routing_dirty_heads_idx
    ON harness_longitudinal_routing_pane_heads(
      pane_id, observation_revision
    ) WHERE analyzed_revision < observation_revision;

  CREATE TABLE harness_longitudinal_routing_analyses (
    pane_id TEXT NOT NULL
      REFERENCES chat_panes(pane_id) ON DELETE CASCADE,
    observation_revision INTEGER NOT NULL CHECK (observation_revision > 0),
    shadow_status TEXT NOT NULL CHECK (shadow_status IN (
      'collectingOperationalEvidence', 'qualityEvidenceRequired'
    )),
    reason TEXT NOT NULL CHECK (reason IN (
      'insufficientOperationalEvidence', 'qualityEvidenceAbsent'
    )),
    summary_digest TEXT NOT NULL CHECK (
      length(summary_digest) = 64
      AND summary_digest NOT GLOB '*[^0-9a-f]*'
    ),
    policy_authorization TEXT NOT NULL DEFAULT 'none'
      CHECK (policy_authorization = 'none'),
    PRIMARY KEY (pane_id, observation_revision),
    CHECK (
      (shadow_status = 'collectingOperationalEvidence'
        AND reason = 'insufficientOperationalEvidence')
      OR (shadow_status = 'qualityEvidenceRequired'
        AND reason = 'qualityEvidenceAbsent')
    )
  ) STRICT;

  CREATE TRIGGER harness_longitudinal_routing_analysis_immutable
  BEFORE UPDATE ON harness_longitudinal_routing_analyses
  BEGIN
    SELECT RAISE(ABORT, 'longitudinal routing analysis is immutable');
  END;

  CREATE VIEW harness_longitudinal_routing_result_projection_v1 AS
  SELECT result.result_id,
    binding.pane_id,
    actor.dispatch_policy_version AS policy_version,
    actor.work_class,
    CASE
      WHEN incarnation.requested_model = 'gpt-5.6-sol'
        AND incarnation.requested_reasoning_effort = 'ultra'
        THEN 'solUltra'
      WHEN incarnation.requested_model = 'gpt-5.6-sol'
        AND incarnation.requested_reasoning_effort = 'max'
        THEN 'solMax'
      WHEN incarnation.requested_model = 'gpt-5.6-luna'
        AND incarnation.requested_reasoning_effort = 'max'
        THEN 'lunaMax'
      ELSE 'unobserved'
    END AS routed_profile,
    COALESCE(attempt.requested_service_tier, 'unobserved')
      AS requested_service_tier,
    COALESCE(attempt.realized_service_tier, 'unobserved')
      AS realized_service_tier,
    result.outcome AS operational_outcome
  FROM harness_actor_results AS result
  JOIN harness_actor_epochs AS epoch ON epoch.epoch_id = result.epoch_id
  JOIN harness_actors AS actor ON actor.actor_id = result.actor_id
  JOIN (
    SELECT actor_id, MIN(pane_id) AS pane_id
    FROM harness_actor_pane_bindings
    GROUP BY actor_id
    HAVING COUNT(DISTINCT pane_id) = 1
  ) AS binding ON binding.actor_id = epoch.root_actor_id
  LEFT JOIN harness_actor_turn_attempts AS attempt
    ON attempt.attempt_id = result.terminal_attempt_id
  LEFT JOIN harness_actor_incarnations AS incarnation
    ON incarnation.incarnation_id = attempt.incarnation_id;

  CREATE TRIGGER harness_longitudinal_routing_observation_immutable
  BEFORE UPDATE ON harness_longitudinal_routing_observations
  BEGIN
    SELECT RAISE(ABORT, 'longitudinal routing observation is immutable');
  END;

  CREATE TRIGGER harness_longitudinal_routing_observation_rollup
  AFTER INSERT ON harness_longitudinal_routing_observations
  BEGIN
    INSERT INTO harness_longitudinal_routing_usage_current (
      result_id, input_tokens, cached_input_tokens, uncached_input_tokens,
      output_tokens, reasoning_output_tokens, elapsed_milliseconds
    ) SELECT result.result_id, attempt.input_tokens,
      attempt.cached_input_tokens,
      CASE WHEN attempt.input_tokens IS NOT NULL
          AND attempt.cached_input_tokens IS NOT NULL
          AND attempt.cached_input_tokens <= attempt.input_tokens
        THEN attempt.input_tokens - attempt.cached_input_tokens
        ELSE NULL END,
      attempt.output_tokens, attempt.reasoning_output_tokens,
      CASE WHEN attempt.started_at IS NOT NULL
          AND attempt.settled_at IS NOT NULL
          AND attempt.settled_at >= attempt.started_at
        THEN MAX(0, CAST(ROUND(
          (julianday(attempt.settled_at) - julianday(attempt.started_at))
            * 86400000.0
        ) AS INTEGER)) ELSE NULL END
    FROM harness_actor_results AS result
    LEFT JOIN harness_actor_turn_attempts AS attempt
      ON attempt.attempt_id = result.terminal_attempt_id
    WHERE result.result_id = NEW.result_id;

    INSERT INTO harness_longitudinal_routing_arm_stats (
      pane_id, policy_version, work_class, routed_profile,
      requested_service_tier, realized_service_tier,
      result_count, succeeded_count,
      failed_count, cancelled_count, quota_rejected_count,
      quality_evaluated_count,
      input_observed_count, input_tokens_total,
      cached_input_observed_count, cached_input_tokens_total,
      uncached_input_observed_count, uncached_input_tokens_total,
      output_observed_count, output_tokens_total,
      reasoning_output_observed_count, reasoning_output_tokens_total,
      elapsed_observed_count, elapsed_milliseconds_total
    ) SELECT
      NEW.pane_id, NEW.policy_version, NEW.work_class,
      NEW.routed_profile, NEW.requested_service_tier,
      NEW.realized_service_tier, 1,
      CASE WHEN NEW.operational_outcome = 'succeeded' THEN 1 ELSE 0 END,
      CASE WHEN NEW.operational_outcome = 'failed' THEN 1 ELSE 0 END,
      CASE WHEN NEW.operational_outcome = 'cancelled' THEN 1 ELSE 0 END,
      CASE WHEN NEW.operational_outcome = 'quotaRejected' THEN 1 ELSE 0 END,
      0,
      CASE WHEN usage.input_tokens IS NULL THEN 0 ELSE 1 END,
      COALESCE(usage.input_tokens, 0),
      CASE WHEN usage.cached_input_tokens IS NULL THEN 0 ELSE 1 END,
      COALESCE(usage.cached_input_tokens, 0),
      CASE WHEN usage.uncached_input_tokens IS NULL THEN 0 ELSE 1 END,
      COALESCE(usage.uncached_input_tokens, 0),
      CASE WHEN usage.output_tokens IS NULL THEN 0 ELSE 1 END,
      COALESCE(usage.output_tokens, 0),
      CASE WHEN usage.reasoning_output_tokens IS NULL THEN 0 ELSE 1 END,
      COALESCE(usage.reasoning_output_tokens, 0),
      CASE WHEN usage.elapsed_milliseconds IS NULL THEN 0 ELSE 1 END,
      COALESCE(usage.elapsed_milliseconds, 0)
    FROM harness_longitudinal_routing_usage_current AS usage
    WHERE usage.result_id = NEW.result_id
    ON CONFLICT (
      pane_id, policy_version, work_class, routed_profile,
      requested_service_tier, realized_service_tier
    ) DO UPDATE SET
      result_count = result_count + 1,
      succeeded_count = succeeded_count + excluded.succeeded_count,
      failed_count = failed_count + excluded.failed_count,
      cancelled_count = cancelled_count + excluded.cancelled_count,
      quota_rejected_count =
        quota_rejected_count + excluded.quota_rejected_count,
      input_observed_count =
        input_observed_count + excluded.input_observed_count,
      input_tokens_total = input_tokens_total + excluded.input_tokens_total,
      cached_input_observed_count =
        cached_input_observed_count + excluded.cached_input_observed_count,
      cached_input_tokens_total =
        cached_input_tokens_total + excluded.cached_input_tokens_total,
      uncached_input_observed_count = uncached_input_observed_count +
        excluded.uncached_input_observed_count,
      uncached_input_tokens_total = uncached_input_tokens_total +
        excluded.uncached_input_tokens_total,
      output_observed_count =
        output_observed_count + excluded.output_observed_count,
      output_tokens_total = output_tokens_total + excluded.output_tokens_total,
      reasoning_output_observed_count = reasoning_output_observed_count +
        excluded.reasoning_output_observed_count,
      reasoning_output_tokens_total = reasoning_output_tokens_total +
        excluded.reasoning_output_tokens_total,
      elapsed_observed_count =
        elapsed_observed_count + excluded.elapsed_observed_count,
      elapsed_milliseconds_total = elapsed_milliseconds_total +
        excluded.elapsed_milliseconds_total;

    INSERT INTO harness_longitudinal_routing_pane_heads (
      pane_id, observation_revision, analyzed_revision, result_count
    ) VALUES (NEW.pane_id, 1, 0, 1)
    ON CONFLICT (pane_id) DO UPDATE SET
      observation_revision = observation_revision + 1,
      result_count = result_count + 1;
  END;

  CREATE TRIGGER harness_longitudinal_routing_observation_delete_rollup
  BEFORE DELETE ON harness_longitudinal_routing_observations
  BEGIN
    DELETE FROM harness_longitudinal_routing_arm_stats
    WHERE pane_id = OLD.pane_id
      AND policy_version = OLD.policy_version
      AND work_class = OLD.work_class
      AND routed_profile = OLD.routed_profile
      AND requested_service_tier = OLD.requested_service_tier
      AND realized_service_tier = OLD.realized_service_tier
      AND result_count = 1;

    UPDATE harness_longitudinal_routing_arm_stats SET
      result_count = result_count - 1,
      succeeded_count = succeeded_count -
        CASE WHEN OLD.operational_outcome = 'succeeded' THEN 1 ELSE 0 END,
      failed_count = failed_count -
        CASE WHEN OLD.operational_outcome = 'failed' THEN 1 ELSE 0 END,
      cancelled_count = cancelled_count -
        CASE WHEN OLD.operational_outcome = 'cancelled' THEN 1 ELSE 0 END,
      quota_rejected_count = quota_rejected_count -
        CASE WHEN OLD.operational_outcome = 'quotaRejected' THEN 1 ELSE 0 END,
      input_observed_count = input_observed_count - CASE WHEN (
        SELECT input_tokens FROM harness_longitudinal_routing_usage_current
        WHERE result_id = OLD.result_id
      ) IS NULL THEN 0 ELSE 1 END,
      input_tokens_total = input_tokens_total - COALESCE((
        SELECT input_tokens FROM harness_longitudinal_routing_usage_current
        WHERE result_id = OLD.result_id
      ), 0),
      cached_input_observed_count = cached_input_observed_count -
        CASE WHEN (
          SELECT cached_input_tokens
          FROM harness_longitudinal_routing_usage_current
          WHERE result_id = OLD.result_id
        ) IS NULL THEN 0 ELSE 1 END,
      cached_input_tokens_total = cached_input_tokens_total - COALESCE((
        SELECT cached_input_tokens
        FROM harness_longitudinal_routing_usage_current
        WHERE result_id = OLD.result_id
      ), 0),
      uncached_input_observed_count = uncached_input_observed_count -
        CASE WHEN (
          SELECT uncached_input_tokens
          FROM harness_longitudinal_routing_usage_current
          WHERE result_id = OLD.result_id
        ) IS NULL THEN 0 ELSE 1 END,
      uncached_input_tokens_total = uncached_input_tokens_total - COALESCE((
        SELECT uncached_input_tokens
        FROM harness_longitudinal_routing_usage_current
        WHERE result_id = OLD.result_id
      ), 0),
      output_observed_count = output_observed_count - CASE WHEN (
        SELECT output_tokens FROM harness_longitudinal_routing_usage_current
        WHERE result_id = OLD.result_id
      ) IS NULL THEN 0 ELSE 1 END,
      output_tokens_total = output_tokens_total - COALESCE((
        SELECT output_tokens FROM harness_longitudinal_routing_usage_current
        WHERE result_id = OLD.result_id
      ), 0),
      reasoning_output_observed_count = reasoning_output_observed_count -
        CASE WHEN (
          SELECT reasoning_output_tokens
          FROM harness_longitudinal_routing_usage_current
          WHERE result_id = OLD.result_id
        ) IS NULL THEN 0 ELSE 1 END,
      reasoning_output_tokens_total = reasoning_output_tokens_total -
        COALESCE((
          SELECT reasoning_output_tokens
          FROM harness_longitudinal_routing_usage_current
          WHERE result_id = OLD.result_id
        ), 0),
      elapsed_observed_count = elapsed_observed_count - CASE WHEN (
        SELECT elapsed_milliseconds
        FROM harness_longitudinal_routing_usage_current
        WHERE result_id = OLD.result_id
      ) IS NULL THEN 0 ELSE 1 END,
      elapsed_milliseconds_total = elapsed_milliseconds_total - COALESCE((
        SELECT elapsed_milliseconds
        FROM harness_longitudinal_routing_usage_current
        WHERE result_id = OLD.result_id
      ), 0)
    WHERE pane_id = OLD.pane_id
      AND policy_version = OLD.policy_version
      AND work_class = OLD.work_class
      AND routed_profile = OLD.routed_profile
      AND requested_service_tier = OLD.requested_service_tier
      AND realized_service_tier = OLD.realized_service_tier
      AND result_count > 1;

    UPDATE harness_longitudinal_routing_pane_heads SET
      observation_revision = observation_revision + 1,
      result_count = result_count - 1
    WHERE pane_id = OLD.pane_id;
  END;

  CREATE TRIGGER harness_longitudinal_routing_result_materialize
  AFTER INSERT ON harness_actor_results
  BEGIN
    INSERT INTO harness_longitudinal_routing_observations (
      result_id, pane_id, policy_version, work_class, routed_profile,
      requested_service_tier, realized_service_tier,
      operational_outcome, quality_state
    ) SELECT
      projection.result_id, projection.pane_id,
      projection.policy_version, projection.work_class,
      projection.routed_profile, projection.requested_service_tier,
      projection.realized_service_tier,
      projection.operational_outcome, 'unobserved'
    FROM harness_longitudinal_routing_result_projection_v1 AS projection
    WHERE projection.result_id = NEW.result_id;
  END;

  CREATE TRIGGER harness_longitudinal_routing_pane_binding_recovery
  AFTER INSERT ON harness_actor_pane_bindings
  BEGIN
    INSERT OR IGNORE INTO harness_longitudinal_routing_observations (
      result_id, pane_id, policy_version, work_class, routed_profile,
      requested_service_tier, realized_service_tier,
      operational_outcome, quality_state
    ) SELECT
      projection.result_id, projection.pane_id,
      projection.policy_version, projection.work_class,
      projection.routed_profile, projection.requested_service_tier,
      projection.realized_service_tier,
      projection.operational_outcome, 'unobserved'
    FROM harness_longitudinal_routing_result_projection_v1 AS projection
    JOIN harness_actor_results AS result
      ON result.result_id = projection.result_id
    JOIN harness_actor_epochs AS epoch ON epoch.epoch_id = result.epoch_id
    WHERE epoch.root_actor_id = NEW.actor_id
      AND projection.pane_id = NEW.pane_id
    ORDER BY projection.result_id;
  END;

  CREATE TRIGGER harness_longitudinal_routing_usage_dirty_head
  AFTER UPDATE OF input_tokens, cached_input_tokens, output_tokens,
    reasoning_output_tokens ON harness_actor_turn_attempts
  WHEN NEW.state IN (
    'completed', 'failed', 'quotaRejected', 'interrupted'
  ) AND (
    NEW.input_tokens IS NOT OLD.input_tokens
    OR NEW.cached_input_tokens IS NOT OLD.cached_input_tokens
    OR NEW.output_tokens IS NOT OLD.output_tokens
    OR NEW.reasoning_output_tokens IS NOT OLD.reasoning_output_tokens
  )
  BEGIN
    UPDATE harness_longitudinal_routing_arm_stats SET
      input_observed_count = input_observed_count +
        CASE WHEN NEW.input_tokens IS NULL THEN 0 ELSE 1 END -
        CASE WHEN (
          SELECT input_tokens FROM harness_longitudinal_routing_usage_current
          WHERE result_id = (
            SELECT result_id FROM harness_actor_results
            WHERE terminal_attempt_id = NEW.attempt_id
          )
        ) IS NULL THEN 0 ELSE 1 END,
      input_tokens_total = input_tokens_total +
        COALESCE(NEW.input_tokens, 0) - COALESCE((
          SELECT input_tokens FROM harness_longitudinal_routing_usage_current
          WHERE result_id = (
            SELECT result_id FROM harness_actor_results
            WHERE terminal_attempt_id = NEW.attempt_id
          )
        ), 0),
      cached_input_observed_count = cached_input_observed_count +
        CASE WHEN NEW.cached_input_tokens IS NULL THEN 0 ELSE 1 END -
        CASE WHEN (
          SELECT cached_input_tokens
          FROM harness_longitudinal_routing_usage_current
          WHERE result_id = (
            SELECT result_id FROM harness_actor_results
            WHERE terminal_attempt_id = NEW.attempt_id
          )
        ) IS NULL THEN 0 ELSE 1 END,
      cached_input_tokens_total = cached_input_tokens_total +
        COALESCE(NEW.cached_input_tokens, 0) - COALESCE((
          SELECT cached_input_tokens
          FROM harness_longitudinal_routing_usage_current
          WHERE result_id = (
            SELECT result_id FROM harness_actor_results
            WHERE terminal_attempt_id = NEW.attempt_id
          )
        ), 0),
      uncached_input_observed_count = uncached_input_observed_count +
        CASE WHEN NEW.input_tokens IS NOT NULL
            AND NEW.cached_input_tokens IS NOT NULL
            AND NEW.cached_input_tokens <= NEW.input_tokens
          THEN 1 ELSE 0 END - CASE WHEN (
          SELECT uncached_input_tokens
          FROM harness_longitudinal_routing_usage_current
          WHERE result_id = (
            SELECT result_id FROM harness_actor_results
            WHERE terminal_attempt_id = NEW.attempt_id
          )
        ) IS NULL THEN 0 ELSE 1 END,
      uncached_input_tokens_total = uncached_input_tokens_total +
        CASE WHEN NEW.input_tokens IS NOT NULL
            AND NEW.cached_input_tokens IS NOT NULL
            AND NEW.cached_input_tokens <= NEW.input_tokens
          THEN NEW.input_tokens - NEW.cached_input_tokens ELSE 0 END -
        COALESCE((
          SELECT uncached_input_tokens
          FROM harness_longitudinal_routing_usage_current
          WHERE result_id = (
            SELECT result_id FROM harness_actor_results
            WHERE terminal_attempt_id = NEW.attempt_id
          )
        ), 0),
      output_observed_count = output_observed_count +
        CASE WHEN NEW.output_tokens IS NULL THEN 0 ELSE 1 END -
        CASE WHEN (
          SELECT output_tokens FROM harness_longitudinal_routing_usage_current
          WHERE result_id = (
            SELECT result_id FROM harness_actor_results
            WHERE terminal_attempt_id = NEW.attempt_id
          )
        ) IS NULL THEN 0 ELSE 1 END,
      output_tokens_total = output_tokens_total +
        COALESCE(NEW.output_tokens, 0) - COALESCE((
          SELECT output_tokens FROM harness_longitudinal_routing_usage_current
          WHERE result_id = (
            SELECT result_id FROM harness_actor_results
            WHERE terminal_attempt_id = NEW.attempt_id
          )
        ), 0),
      reasoning_output_observed_count = reasoning_output_observed_count +
        CASE WHEN NEW.reasoning_output_tokens IS NULL THEN 0 ELSE 1 END -
        CASE WHEN (
          SELECT reasoning_output_tokens
          FROM harness_longitudinal_routing_usage_current
          WHERE result_id = (
            SELECT result_id FROM harness_actor_results
            WHERE terminal_attempt_id = NEW.attempt_id
          )
        ) IS NULL THEN 0 ELSE 1 END,
      reasoning_output_tokens_total = reasoning_output_tokens_total +
        COALESCE(NEW.reasoning_output_tokens, 0) - COALESCE((
          SELECT reasoning_output_tokens
          FROM harness_longitudinal_routing_usage_current
          WHERE result_id = (
            SELECT result_id FROM harness_actor_results
            WHERE terminal_attempt_id = NEW.attempt_id
          )
        ), 0)
    WHERE EXISTS (
      SELECT 1
      FROM harness_longitudinal_routing_observations AS observation
      JOIN harness_actor_results AS result
        ON result.result_id = observation.result_id
      WHERE result.terminal_attempt_id = NEW.attempt_id
        AND observation.pane_id =
          harness_longitudinal_routing_arm_stats.pane_id
        AND observation.policy_version =
          harness_longitudinal_routing_arm_stats.policy_version
        AND observation.work_class =
          harness_longitudinal_routing_arm_stats.work_class
        AND observation.routed_profile =
          harness_longitudinal_routing_arm_stats.routed_profile
        AND observation.requested_service_tier =
          harness_longitudinal_routing_arm_stats.requested_service_tier
        AND observation.realized_service_tier =
          harness_longitudinal_routing_arm_stats.realized_service_tier
    );

    UPDATE harness_longitudinal_routing_usage_current SET
      input_tokens = NEW.input_tokens,
      cached_input_tokens = NEW.cached_input_tokens,
      uncached_input_tokens = CASE WHEN NEW.input_tokens IS NOT NULL
          AND NEW.cached_input_tokens IS NOT NULL
          AND NEW.cached_input_tokens <= NEW.input_tokens
        THEN NEW.input_tokens - NEW.cached_input_tokens ELSE NULL END,
      output_tokens = NEW.output_tokens,
      reasoning_output_tokens = NEW.reasoning_output_tokens
    WHERE result_id = (
      SELECT result_id FROM harness_actor_results
      WHERE terminal_attempt_id = NEW.attempt_id
    );

    UPDATE harness_longitudinal_routing_pane_heads SET
      observation_revision = observation_revision + 1
    WHERE pane_id = (
      SELECT observation.pane_id
      FROM harness_longitudinal_routing_observations AS observation
      JOIN harness_actor_results AS result
        ON result.result_id = observation.result_id
      WHERE result.terminal_attempt_id = NEW.attempt_id
      LIMIT 1
    );
  END;

  INSERT INTO harness_longitudinal_routing_observations (
    result_id, pane_id, policy_version, work_class, routed_profile,
    requested_service_tier, realized_service_tier,
    operational_outcome, quality_state
  ) SELECT
    projection.result_id, projection.pane_id,
    projection.policy_version, projection.work_class,
    projection.routed_profile, projection.requested_service_tier,
    projection.realized_service_tier,
    projection.operational_outcome, 'unobserved'
  FROM harness_longitudinal_routing_result_projection_v1 AS projection
  ORDER BY projection.pane_id, projection.result_id;
`;
