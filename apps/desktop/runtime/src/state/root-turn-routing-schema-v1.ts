import { z } from "@hra-internal/schema";

import {
  chatPaneIdSchema,
  chatRootTurnProfileSchema,
  chatRootTurnRoutingClassificationReasonSchema,
  chatRootTurnRoutingProfileFallbackReasonSchema,
  chatRootTurnRoutingServiceTierFallbackReasonSchema,
  chatRootTurnRoutingServiceTierSchema,
  chatRootTurnWorkClassSchema,
  chatTurnIdSchema,
} from "../../../contracts/runtime";

export const HRA_ROOT_TURN_ROUTING_POLICY_VERSION = 1 as const;

export const rootTurnRoutingClassificationReasonSchema =
  chatRootTurnRoutingClassificationReasonSchema;
export type RootTurnRoutingClassificationReasonV1 = z.infer<
  typeof rootTurnRoutingClassificationReasonSchema
>;

export const rootTurnRoutingWorkClassSchema = chatRootTurnWorkClassSchema;
export type RootTurnRoutingWorkClassV1 = z.infer<
  typeof rootTurnRoutingWorkClassSchema
>;

export const rootTurnRoutingProfileSchema = chatRootTurnProfileSchema;
export type RootTurnRoutingProfileV1 = z.infer<
  typeof rootTurnRoutingProfileSchema
>;

export const rootTurnRoutingServiceTierSchema =
  chatRootTurnRoutingServiceTierSchema;
export type RootTurnRoutingServiceTierV1 = z.infer<
  typeof rootTurnRoutingServiceTierSchema
>;

export const rootTurnRoutingProfileFallbackReasonSchema =
  chatRootTurnRoutingProfileFallbackReasonSchema;
export type RootTurnRoutingProfileFallbackReasonV1 = z.infer<
  typeof rootTurnRoutingProfileFallbackReasonSchema
>;

export const rootTurnRoutingServiceTierFallbackReasonSchema =
  chatRootTurnRoutingServiceTierFallbackReasonSchema;
export type RootTurnRoutingServiceTierFallbackReasonV1 = z.infer<
  typeof rootTurnRoutingServiceTierFallbackReasonSchema
>;

export const rootTurnRoutingStateSchema = z.enum([
  "classified",
  "resolved",
  "effectStarted",
  "accepted",
  "terminal",
  "ambiguous",
  "notApplied",
]);
export type RootTurnRoutingStateV1 = z.infer<
  typeof rootTurnRoutingStateSchema
>;

export const rootTurnRoutingOperationalOutcomeSchema = z.enum([
  "succeeded",
  "failed",
  "interrupted",
  "quotaRejected",
  "notApplied",
  "ambiguous",
]);
export type RootTurnRoutingOperationalOutcomeV1 = z.infer<
  typeof rootTurnRoutingOperationalOutcomeSchema
>;

const canonicalTimestampSchema = z.string().length(24).datetime().refine(
  (value) => new Date(Date.parse(value)).toISOString() === value,
  "timestamp must use canonical UTC milliseconds",
);

export const rootTurnRoutingClassificationV1Schema = z.object({
  paneId: chatPaneIdSchema,
  chatTurnId: chatTurnIdSchema,
  policyVersion: z.literal(HRA_ROOT_TURN_ROUTING_POLICY_VERSION),
  classificationReason: rootTurnRoutingClassificationReasonSchema,
  workClass: rootTurnRoutingWorkClassSchema,
  requestedProfile: rootTurnRoutingProfileSchema,
  requestedServiceTier: rootTurnRoutingServiceTierSchema,
}).strict().superRefine((value, context) => {
  const expectedProfile = value.workClass === "boundedLeaf"
    ? "lunaMax"
    : value.workClass === "standard"
      ? "solMax"
      : "solUltra";
  if (value.requestedProfile !== expectedProfile) {
    context.addIssue({
      code: "custom",
      message: "requested profile must match the classified work class",
      path: ["requestedProfile"],
    });
  }
  const requestedTierMatchesWorkClass = value.workClass === "boundedLeaf"
    ? value.requestedServiceTier === "fast"
    : value.workClass === "standard"
      ? true
      : value.requestedServiceTier === "standard";
  if (!requestedTierMatchesWorkClass) {
    context.addIssue({
      code: "custom",
      message: "work class must map to an allowed requested service tier",
      path: ["requestedServiceTier"],
    });
  }
  if (value.classificationReason !== "continuationInherited") {
    const reasonWorkClass = value.classificationReason === "wideResearchCue"
      ? "wideResearch"
      : value.classificationReason === "largeChangeCue"
        ? "largeChange"
        : value.classificationReason === "boundedLeafCue"
          ? "boundedLeaf"
          : "standard";
    if (value.workClass !== reasonWorkClass) {
      context.addIssue({
        code: "custom",
        message: "classification reason must match the automatic work class",
        path: ["classificationReason"],
      });
    }
    const expectedTier = value.classificationReason === "boundedLeafCue" ||
        value.classificationReason === "continuationOrAmbiguous"
      ? "fast"
      : "standard";
    if (value.requestedServiceTier !== expectedTier) {
      context.addIssue({
        code: "custom",
        message: "requested service tier must match the automatic policy",
        path: ["requestedServiceTier"],
      });
    }
  }
});
export type RootTurnRoutingClassificationV1 = z.infer<
  typeof rootTurnRoutingClassificationV1Schema
>;

export const rootTurnRoutingReceiptV1Schema = z.object({
  paneId: chatPaneIdSchema,
  chatTurnId: chatTurnIdSchema,
  rootTurnId: z.string().min(16).max(96).nullable(),
  policyVersion: z.literal(HRA_ROOT_TURN_ROUTING_POLICY_VERSION),
  classificationReason: rootTurnRoutingClassificationReasonSchema,
  workClass: rootTurnRoutingWorkClassSchema,
  requestedProfile: rootTurnRoutingProfileSchema,
  requestedServiceTier: rootTurnRoutingServiceTierSchema,
  state: rootTurnRoutingStateSchema,
  selectedProfile: rootTurnRoutingProfileSchema.nullable(),
  profileFallbackReason: rootTurnRoutingProfileFallbackReasonSchema.nullable(),
  selectedServiceTier: rootTurnRoutingServiceTierSchema.nullable(),
  serviceTierFallbackReason:
    rootTurnRoutingServiceTierFallbackReasonSchema.nullable(),
  operationalOutcome: rootTurnRoutingOperationalOutcomeSchema.nullable(),
  acceptedGeneration: z.number().int().positive().safe().nullable(),
  acceptedStreamPosition: z.number().int().nonnegative().safe().nullable(),
  createdAt: canonicalTimestampSchema,
  updatedAt: canonicalTimestampSchema,
  resolvedAt: canonicalTimestampSchema.nullable(),
  effectStartedAt: canonicalTimestampSchema.nullable(),
  acceptedAt: canonicalTimestampSchema.nullable(),
  settledAt: canonicalTimestampSchema.nullable(),
}).strict();
export type RootTurnRoutingReceiptV1 = z.infer<
  typeof rootTurnRoutingReceiptV1Schema
>;

/**
 * Private, content-free ordinary-root routing evidence. The chat turn receipt
 * is deliberately not a foreign key: bounded receipt pruning must never erase
 * this ledger. Pane privacy deletion remains authoritative through the pane
 * foreign key and the archive trigger below.
 */
export const ROOT_TURN_ROUTING_SCHEMA_V1_SQL = `
  CREATE TABLE harness_root_turn_routing_receipts (
    pane_id TEXT NOT NULL
      REFERENCES chat_panes(pane_id) ON DELETE CASCADE,
    chat_turn_id TEXT NOT NULL CHECK (
      length(chat_turn_id) BETWEEN 16 AND 96
      AND chat_turn_id GLOB 'chatturn_[A-Za-z0-9_-]*'
      AND substr(chat_turn_id, 10) NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
    root_turn_id TEXT
      REFERENCES harness_actor_turns(turn_id) ON DELETE RESTRICT,
    policy_version INTEGER NOT NULL CHECK (policy_version = 1),
    classification_reason TEXT NOT NULL CHECK (
      classification_reason IN (
        'wideResearchCue', 'largeChangeCue', 'boundedLeafCue',
        'continuationInherited', 'continuationOrAmbiguous',
        'conservativeDefault'
      )
    ),
    work_class TEXT NOT NULL CHECK (
      work_class IN ('largeChange', 'wideResearch', 'standard', 'boundedLeaf')
    ),
    requested_profile TEXT NOT NULL CHECK (
      requested_profile IN ('solUltra', 'solMax', 'lunaMax')
    ),
    requested_service_tier TEXT NOT NULL CHECK (
      requested_service_tier IN ('standard', 'fast')
    ),
    state TEXT NOT NULL CHECK (
      state IN (
        'classified', 'resolved', 'effectStarted', 'accepted',
        'terminal', 'ambiguous', 'notApplied'
      )
    ),
    selected_profile TEXT CHECK (
      selected_profile IS NULL
      OR selected_profile IN ('solUltra', 'solMax', 'lunaMax')
    ),
    profile_fallback_reason TEXT CHECK (
      profile_fallback_reason IS NULL
      OR profile_fallback_reason = 'lunaUnavailable'
    ),
    selected_service_tier TEXT CHECK (
      selected_service_tier IS NULL
      OR selected_service_tier IN ('standard', 'fast')
    ),
    service_tier_fallback_reason TEXT CHECK (
      service_tier_fallback_reason IS NULL
      OR service_tier_fallback_reason = 'fastUnavailable'
    ),
    operational_outcome TEXT CHECK (
      operational_outcome IS NULL OR operational_outcome IN (
        'succeeded', 'failed', 'interrupted', 'quotaRejected',
        'notApplied', 'ambiguous'
      )
    ),
    accepted_generation INTEGER CHECK (
      accepted_generation IS NULL OR accepted_generation > 0
    ),
    accepted_stream_position INTEGER CHECK (
      accepted_stream_position IS NULL
      OR accepted_stream_position BETWEEN 0 AND 9007199254740991
    ),
    created_at TEXT NOT NULL CHECK (
      length(created_at) = 24 AND substr(created_at, 24, 1) = 'Z'
    ),
    updated_at TEXT NOT NULL CHECK (
      length(updated_at) = 24 AND substr(updated_at, 24, 1) = 'Z'
    ),
    resolved_at TEXT CHECK (
      resolved_at IS NULL OR (
        length(resolved_at) = 24 AND substr(resolved_at, 24, 1) = 'Z'
      )
    ),
    effect_started_at TEXT CHECK (
      effect_started_at IS NULL OR (
        length(effect_started_at) = 24
        AND substr(effect_started_at, 24, 1) = 'Z'
      )
    ),
    accepted_at TEXT CHECK (
      accepted_at IS NULL OR (
        length(accepted_at) = 24 AND substr(accepted_at, 24, 1) = 'Z'
      )
    ),
    settled_at TEXT CHECK (
      settled_at IS NULL OR (
        length(settled_at) = 24 AND substr(settled_at, 24, 1) = 'Z'
      )
    ),
    PRIMARY KEY (pane_id, chat_turn_id),
    CHECK (
      (work_class = 'boundedLeaf' AND requested_profile = 'lunaMax')
      OR (work_class = 'standard' AND requested_profile = 'solMax')
      OR (work_class IN ('largeChange', 'wideResearch')
        AND requested_profile = 'solUltra')
    ),
    CHECK (
      (classification_reason = 'wideResearchCue'
        AND work_class = 'wideResearch')
      OR (classification_reason = 'largeChangeCue'
        AND work_class = 'largeChange')
      OR (classification_reason = 'boundedLeafCue'
        AND work_class = 'boundedLeaf')
      OR (classification_reason IN (
          'continuationOrAmbiguous', 'conservativeDefault'
        ) AND work_class = 'standard')
      OR classification_reason = 'continuationInherited'
    ),
    CHECK (
      (classification_reason IN ('boundedLeafCue', 'continuationOrAmbiguous')
        AND requested_service_tier = 'fast')
      OR (classification_reason IN (
          'wideResearchCue', 'largeChangeCue', 'conservativeDefault'
        ) AND requested_service_tier = 'standard')
      OR classification_reason = 'continuationInherited'
    ),
    CHECK (
      (work_class = 'boundedLeaf' AND requested_service_tier = 'fast')
      OR work_class = 'standard'
      OR (work_class IN ('largeChange', 'wideResearch')
        AND requested_service_tier = 'standard')
    ),
    CHECK (
      (selected_profile IS NULL AND resolved_at IS NULL
        AND profile_fallback_reason IS NULL
        AND selected_service_tier IS NULL
        AND service_tier_fallback_reason IS NULL)
      OR (selected_profile IS NOT NULL AND resolved_at IS NOT NULL
        AND selected_service_tier IS NOT NULL)
    ),
    CHECK (
      (profile_fallback_reason IS NULL AND (
        selected_profile IS NULL OR selected_profile = requested_profile
      )) OR (
        requested_profile = 'lunaMax'
        AND selected_profile = 'solMax'
        AND profile_fallback_reason = 'lunaUnavailable'
      )
    ),
    CHECK (
      (service_tier_fallback_reason IS NULL AND (
        selected_service_tier IS NULL
        OR selected_service_tier = requested_service_tier
      )) OR (
        requested_service_tier = 'fast'
        AND selected_service_tier = 'standard'
        AND service_tier_fallback_reason = 'fastUnavailable'
      )
    ),
    CHECK (
      (accepted_generation IS NULL) = (accepted_stream_position IS NULL)
      AND (accepted_generation IS NULL) = (accepted_at IS NULL)
    ),
    CHECK (effect_started_at IS NULL OR resolved_at IS NOT NULL),
    CHECK (accepted_at IS NULL OR effect_started_at IS NOT NULL),
    CHECK (
      (state IN ('terminal', 'ambiguous', 'notApplied'))
        = (settled_at IS NOT NULL)
    ),
    CHECK (
      (state IN ('terminal', 'ambiguous', 'notApplied'))
        = (operational_outcome IS NOT NULL)
    ),
    CHECK (state != 'terminal' OR operational_outcome IN (
      'succeeded', 'failed', 'interrupted', 'quotaRejected'
    )),
    CHECK (
      operational_outcome != 'succeeded' OR accepted_at IS NOT NULL
    ),
    CHECK (
      operational_outcome IS NULL
      OR operational_outcome IN ('succeeded', 'notApplied')
      OR effect_started_at IS NOT NULL
    ),
    CHECK (state != 'ambiguous' OR operational_outcome = 'ambiguous'),
    CHECK (state != 'notApplied' OR operational_outcome = 'notApplied'),
    CHECK (state != 'classified' OR (
      selected_profile IS NULL AND effect_started_at IS NULL
      AND selected_service_tier IS NULL
      AND accepted_at IS NULL AND settled_at IS NULL
    )),
    CHECK (state != 'resolved' OR (
      selected_profile IS NOT NULL AND selected_service_tier IS NOT NULL
      AND effect_started_at IS NULL
      AND accepted_at IS NULL AND settled_at IS NULL
    )),
    CHECK (state != 'effectStarted' OR (
      effect_started_at IS NOT NULL AND accepted_at IS NULL
      AND settled_at IS NULL
    )),
    CHECK (state != 'accepted' OR (
      accepted_at IS NOT NULL AND settled_at IS NULL
    )),
    CHECK (state != 'notApplied' OR (
      effect_started_at IS NULL AND accepted_at IS NULL
    )),
    CHECK (updated_at >= created_at),
    CHECK (resolved_at IS NULL OR resolved_at >= created_at),
    CHECK (effect_started_at IS NULL OR effect_started_at >= resolved_at),
    CHECK (accepted_at IS NULL OR accepted_at >= effect_started_at),
    CHECK (settled_at IS NULL OR settled_at >= created_at)
  ) STRICT;

  CREATE UNIQUE INDEX harness_root_turn_routing_root_turn_idx
    ON harness_root_turn_routing_receipts(root_turn_id)
    WHERE root_turn_id IS NOT NULL;
  CREATE INDEX harness_root_turn_routing_pane_timeline_idx
    ON harness_root_turn_routing_receipts(
      pane_id, created_at DESC, chat_turn_id DESC
    );
  CREATE INDEX harness_root_turn_routing_recovery_idx
    ON harness_root_turn_routing_receipts(
      state, updated_at, pane_id, chat_turn_id
    ) WHERE state IN ('classified', 'resolved', 'effectStarted', 'accepted');
  CREATE INDEX harness_root_turn_routing_arm_idx
    ON harness_root_turn_routing_receipts(
      work_class, requested_profile, selected_profile,
      requested_service_tier, selected_service_tier, created_at, pane_id
    );

  CREATE TRIGGER harness_root_turn_routing_root_lineage_insert_guard
  BEFORE INSERT ON harness_root_turn_routing_receipts
  WHEN NEW.root_turn_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM harness_actor_turns AS turn
    JOIN harness_actors AS actor ON actor.actor_id = turn.actor_id
    JOIN harness_actor_pane_bindings AS binding
      ON binding.actor_id = actor.actor_id
    WHERE turn.turn_id = NEW.root_turn_id
      AND actor.parent_actor_id IS NULL
      AND actor.work_class = 'standard'
      AND binding.pane_id = NEW.pane_id
      AND binding.state = 'attached'
  )
  BEGIN
    SELECT RAISE(ABORT, 'root routing receipt requires a stable standard root');
  END;

  CREATE TRIGGER harness_root_turn_routing_root_lineage_update_guard
  BEFORE UPDATE OF root_turn_id ON harness_root_turn_routing_receipts
  WHEN NOT (
    OLD.root_turn_id IS NULL
    AND NEW.root_turn_id IS NOT NULL
    AND OLD.state = 'classified'
    AND NEW.state = 'classified'
    AND EXISTS (
      SELECT 1
      FROM harness_actor_turns AS turn
      JOIN harness_actors AS actor ON actor.actor_id = turn.actor_id
      JOIN harness_actor_pane_bindings AS binding
        ON binding.actor_id = actor.actor_id
      WHERE turn.turn_id = NEW.root_turn_id
        AND actor.parent_actor_id IS NULL
        AND actor.work_class = 'standard'
        AND binding.pane_id = NEW.pane_id
        AND binding.state = 'attached'
    )
  )
  BEGIN
    SELECT RAISE(ABORT, 'root routing turn binding is immutable');
  END;

  CREATE TRIGGER harness_root_turn_routing_identity_immutable
  BEFORE UPDATE OF pane_id, chat_turn_id, policy_version,
    classification_reason, work_class, requested_profile,
    requested_service_tier, created_at
  ON harness_root_turn_routing_receipts
  BEGIN
    SELECT RAISE(ABORT, 'root routing classification is immutable');
  END;

  CREATE TRIGGER harness_root_turn_routing_resolution_immutable
  BEFORE UPDATE OF selected_profile, profile_fallback_reason,
    selected_service_tier, service_tier_fallback_reason, resolved_at
  ON harness_root_turn_routing_receipts
  WHEN OLD.resolved_at IS NOT NULL
  BEGIN
    SELECT RAISE(ABORT, 'root routing resolution is immutable');
  END;

  CREATE TRIGGER harness_root_turn_routing_effect_immutable
  BEFORE UPDATE OF effect_started_at
  ON harness_root_turn_routing_receipts
  WHEN OLD.effect_started_at IS NOT NULL
  BEGIN
    SELECT RAISE(ABORT, 'root routing effect evidence is immutable');
  END;

  CREATE TRIGGER harness_root_turn_routing_acceptance_immutable
  BEFORE UPDATE OF accepted_generation, accepted_stream_position, accepted_at
  ON harness_root_turn_routing_receipts
  WHEN OLD.accepted_at IS NOT NULL
  BEGIN
    SELECT RAISE(ABORT, 'root routing acceptance evidence is immutable');
  END;

  CREATE TRIGGER harness_root_turn_routing_transition_guard
  BEFORE UPDATE OF state ON harness_root_turn_routing_receipts
  WHEN NEW.state != OLD.state AND NOT (
    (OLD.state = 'classified' AND NEW.state IN ('resolved', 'notApplied'))
    OR (OLD.state = 'resolved' AND NEW.state IN (
      'effectStarted', 'notApplied'
    ))
    OR (OLD.state = 'effectStarted' AND NEW.state IN (
      'accepted', 'terminal', 'ambiguous'
    ))
    OR (OLD.state = 'accepted' AND NEW.state IN ('terminal', 'ambiguous'))
  )
  BEGIN
    SELECT RAISE(ABORT, 'invalid root routing transition');
  END;

  CREATE TRIGGER harness_root_turn_routing_time_guard
  BEFORE UPDATE OF updated_at ON harness_root_turn_routing_receipts
  WHEN NEW.updated_at < OLD.updated_at OR OLD.settled_at IS NOT NULL
  BEGIN
    SELECT RAISE(ABORT, 'root routing receipt time is immutable or regressed');
  END;

  CREATE TRIGGER harness_root_turn_routing_settlement_immutable
  BEFORE UPDATE OF operational_outcome, settled_at
  ON harness_root_turn_routing_receipts
  WHEN OLD.settled_at IS NOT NULL
  BEGIN
    SELECT RAISE(ABORT, 'root routing settlement is immutable');
  END;

  CREATE TRIGGER harness_root_turn_routing_pane_privacy_delete
  AFTER UPDATE OF archived_at ON chat_panes
  WHEN OLD.archived_at IS NULL AND NEW.archived_at IS NOT NULL
  BEGIN
    DELETE FROM harness_root_turn_routing_receipts
    WHERE pane_id = NEW.pane_id;
  END;
`;
