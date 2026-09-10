import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";

// Captured once by the exact archived canonical43 APIs. This is not a
// relabelled current database or a claim of provider/physical-memory effects.
// The sole absolute project path is deliberately public synthetic input.
// No private capture path is admitted, and no captured bytes were scrubbed.
//
// Reproduction inputs: archive sourceRevision's src, package.json and bun.lock;
// install the exact pinned dependencies without running provider commands;
// restore regenerationInputs.originalGeneratorSource at its recorded filename;
// write canonical43MemoryGeneratorSource beside src and run it under the
// repository's reviewed host scheduler. Its exact public parent and run_public1
// must both be absent; never delete/reuse an existing capture to make it run.
// A host unable to create the canonical public path must refuse rather than
// substitute a different persisted path. Random IDs mean a rerun is a new
// capture, not byte-identical regeneration. Merely importing this module or
// decoding the image performs no filesystem, SQLite, provider, or network IO.
export const canonical43MemoryFixture = {
  "sourceRevision": "eaf0448e19383ac899c30d0a9cd70bbea71ff8b3",
  "sourceTree": "5ce8a9dd0c21fe47d5724b4fc4760380aaaf6100",
  "sourceDirectoryGitTree": "d8ca2b05340bd555087d8b778e94ae3f6edf0108",
  "sourceHashes": {
    "stateStoreSha256": "7f8b283b5f8dcae738aa74d94f9466631f86350b06aa58ecb2790482890bb553",
    "packageJsonSha256": "7467e617297fedc0948818e03054ae062e3f742cfab149c9b722bd391aab6957",
    "bunLockSha256": "f06c91e2e431a9627381fb7d0417541b38e15a1de4b0cc003d4b6dd9c5a3a62f"
  },
  "originalGeneratorSha256": "8f87f678feb2ce27de26029d5475fa5935c7f131e4dd87f0d25cce7a7a7ee8da",
  "dependencies": {
    "@hraness/oh": "0.4.1",
    "@openai/codex": "0.153.2",
    "convex": "1.45.0",
    "effect": "3.22.1",
    "zod": "4.4.3"
  },
  "bunVersion": "1.3.14",
  "purpose": "Future canonical43 integration fixture only; not current49 compatibility or release proof.",
  "regeneration": "Historical APIs generate random IDs; hashes identify this captured output only.",
  "usageReservationNotice": "Revision1 is explicitly reserved but unused; next_revision2 does not prove a quota observation, poll failure, or cloud upload.",
  "publicFixtureProjectRoot": "/private/tmp/oompa-public-canonical43-fixture/project",
  "pathNotice": "The sole allowed absolute project path is intentionally public synthetic fixture input. No real project or machine path is captured.",
  "fixedTime": 43001,
  "timeZone": "UTC",
  "syntheticOnly": true,
  "nativeProviderEffects": 0,
  "networkEffects": 0,
  "physicalMemoryInitialization": false,
  "hostToolExecution": false,
  "peerActionsExecuted": false,
  "rawSqlRowOrSchemaWrites": false,
  "assertions": {
    "writableReopenAllRowsAndSchemaUnchanged": true,
    "readonlyReopenAllRowsAndSchemaUnchanged": true,
    "readonlyDatabaseHashUnchanged": true,
    "allTableSnapshot": true,
    "publicPathOnly": true,
    "memoryReservedPreparedAllocatingOnly": true,
    "noMigrationOrCurrentSchemaAcceptanceClaim": true
  },
  "databaseBytes": 1892352,
  "databaseSha256": "046f5ede0c377a0db943206e09b6dfbee5e8aa0a55d90e06f98e0faf6f9ffeb5",
  "generatorSha256": "9cf4dc9b20858d5f7bf0511e56d1643b493b47883e7c254e905cafcfe7399499",
  "timestampGuardSha256": "58bf7130250f47f8cae27ba0e58057df1483b0b325e988e0116c2512d40acd8d",
  "checkpointResult": {
    "busy": 0,
    "log": 0,
    "checkpointed": 0
  },
  "observations": {
    "profile": {
      "id": "acct_25f92394d7cb4b9dbf4ca226fe5a6a13",
      "label": "Canonical43 synthetic account",
      "state": "signed_in",
      "processGeneration": 1,
      "providerEmail": "canonical43@example.com",
      "providerPlan": "Plus",
      "createdAt": 43001,
      "updatedAt": 43001
    },
    "unusedUsageRevision": 1,
    "project": {
      "id": "proj_c64eeebae2c64591b4d21da199c64df7",
      "label": "Canonical43 fixture project",
      "rootPath": "/private/tmp/oompa-public-canonical43-fixture/project",
      "default": true,
      "createdAt": 43001,
      "updatedAt": 43001
    },
    "sessions": [
      {
        "id": "sess_c75960fd187747a3b0d29db10be8bb03",
        "profileId": "acct_25f92394d7cb4b9dbf4ca226fe5a6a13",
        "projectId": "proj_c64eeebae2c64591b4d21da199c64df7",
        "providerThreadId": "canonical43-synthetic-primary",
        "title": "Canonical43 primary",
        "note": "",
        "provider": "codex",
        "preset": "high",
        "fastEnabled": false,
        "state": "idle",
        "providerUpdatedAt": 43001,
        "revision": 2,
        "createdAt": 43001,
        "updatedAt": 43001
      },
      {
        "id": "sess_1713c5abe1f6488186498f3645d5cc6a",
        "profileId": "acct_25f92394d7cb4b9dbf4ca226fe5a6a13",
        "projectId": "proj_c64eeebae2c64591b4d21da199c64df7",
        "providerThreadId": "canonical43-synthetic-peer",
        "title": "Canonical43 peer",
        "note": "",
        "provider": "codex",
        "preset": "high",
        "fastEnabled": false,
        "state": "idle",
        "providerUpdatedAt": 43001,
        "revision": 2,
        "createdAt": 43001,
        "updatedAt": 43001
      }
    ],
    "policies": [
      {
        "sessionId": "sess_c75960fd187747a3b0d29db10be8bb03",
        "mode": "inspect",
        "revision": 2,
        "createdAt": 43001,
        "updatedAt": 43001
      },
      {
        "sessionId": "sess_1713c5abe1f6488186498f3645d5cc6a",
        "mode": "off",
        "revision": 2,
        "createdAt": 43001,
        "updatedAt": 43001
      }
    ],
    "hostCapabilities": {
      "sessionId": "sess_c75960fd187747a3b0d29db10be8bb03",
      "preambleVersion": 1,
      "preambleDigest": "efe177c5b62ecee67995575764969e581f91c2f7946241bb87e798ed5dac7eb1",
      "manifestVersion": 1,
      "manifestDigest": "b6bf9f205581dad2ed692081d3834f362c4573cd4a13d102abb96ac21e6e1b63",
      "recordedAt": 43001
    },
    "queue": [
      {
        "id": "queue_e5e7519d62124714ba02c733698bb5e8",
        "sessionId": "sess_c75960fd187747a3b0d29db10be8bb03",
        "message": "Canonical43 human queue first entry.",
        "messageActor": "human",
        "state": "pending",
        "createdAt": 43001,
        "updatedAt": 43001
      },
      {
        "id": "queue_871a5458b39c45bb9b6ed199a5fa1d68",
        "sessionId": "sess_c75960fd187747a3b0d29db10be8bb03",
        "message": "Canonical43 human queue second entry.",
        "messageActor": "human",
        "state": "pending",
        "createdAt": 43001,
        "updatedAt": 43001
      }
    ],
    "canonicalIdentity": {
      "authorityDigest": "e4ce8b512a8e562945b59326ce5499221554f1b5b7d25be74aaeab41c684f602",
      "bindingDigest": "6342d6d347ba999feedc4e2dbf1c8d76da63d1a18539a34712db19834b3de266",
      "canonicalAuthorityId": "oompa.memory.canonical.space-7afe83fff41ec7a2a2ed9e5973567c7d",
      "canonicalRealmId": "oompa:project-memory:space-7afe83fff41ec7a2a2ed9e5973567c7d",
      "canonicalSpaceId": "oompa:project:space-7afe83fff41ec7a2a2ed9e5973567c7d",
      "identityContract": 2
    },
    "memoryAuthority": {
      "projectId": "proj_c64eeebae2c64591b4d21da199c64df7",
      "identityContract": 2,
      "canonicalSpaceId": "oompa:project:space-7afe83fff41ec7a2a2ed9e5973567c7d",
      "physicalState": "reserved",
      "authorityDigest": "e4ce8b512a8e562945b59326ce5499221554f1b5b7d25be74aaeab41c684f602",
      "bindingDigest": "6342d6d347ba999feedc4e2dbf1c8d76da63d1a18539a34712db19834b3de266",
      "head": {
        "sequence": 0,
        "operationSha256": null,
        "headDigest": "1c90ceacb79d163e060443b4db9a02561059971c063558963df0794ecfbbde85"
      },
      "revision": 1,
      "syncState": "local_only",
      "createdAt": 43001,
      "updatedAt": 43001
    },
    "workingBinding": {
      "bindingDigest": "5097f9fdbbeb6082d9c26c25b8314fedaf0213e8b9e80315e60894b3254ea3a9",
      "epoch": 1,
      "ownerId": "acct_25f92394d7cb4b9dbf4ca226fe5a6a13",
      "sessionId": "sess_c75960fd187747a3b0d29db10be8bb03"
    },
    "memorySubmission": {
      "id": "memsub_1a271b7838884a44b51af88d53f4251e",
      "idempotencyKey": "43000000-0000-4000-8000-000000000003",
      "kind": "remember",
      "actorSessionId": "sess_c75960fd187747a3b0d29db10be8bb03",
      "projectId": "proj_c64eeebae2c64591b4d21da199c64df7",
      "requestDigest": "718304a7c93f6f2a4dcf9778089690ce39f35a1df3df185c0b99cdf0ca90b175",
      "contentDigest": "50719295ff0afbe96ff6e93953b4586474634118dea47940382517cd6e05068f",
      "keyDigest": "35456d7c1109923562200613ea0fd5491d7eb0799fd1979652323da4d3b47283",
      "workingBindingDigest": "5097f9fdbbeb6082d9c26c25b8314fedaf0213e8b9e80315e60894b3254ea3a9",
      "workingEpoch": 1,
      "expectedHead": {
        "sequence": 0,
        "operationSha256": null,
        "headDigest": "1c90ceacb79d163e060443b4db9a02561059971c063558963df0794ecfbbde85"
      },
      "state": "prepared",
      "createdAt": 43001,
      "updatedAt": 43001
    },
    "hostedCreate": {
      "accountBindingDigest": "482c02089cbec50bc11361cebf192ec728e5f8fc1534d27bace35dd333a7fa77",
      "authorityHead": {
        "sequence": 0,
        "operationSha256": null,
        "headDigest": "1c90ceacb79d163e060443b4db9a02561059971c063558963df0794ecfbbde85"
      },
      "authorityRevision": 1,
      "canonicalBindingDigest": "6342d6d347ba999feedc4e2dbf1c8d76da63d1a18539a34712db19834b3de266",
      "createdAt": 43001,
      "id": "cmcreate_e6f54633b6084c0eb239f896b708e32b",
      "idempotencyKey": "43000000-0000-4000-8000-000000000004",
      "projectId": "proj_c64eeebae2c64591b4d21da199c64df7",
      "remoteSpaceId": "memory_44444444444444444444444444444444",
      "state": "allocating",
      "updatedAt": 43001
    }
  },
  "notificationHours": [
    {
      "singleton": 1,
      "version": 1,
      "revision": 1,
      "start_minute": 600,
      "end_minute": 1320,
      "time_zone": "UTC",
      "created_at": 43001,
      "updated_at": 43001
    }
  ],
  "attentionEmailPolicy": [
    {
      "singleton": 1,
      "version": 1,
      "enabled": 0,
      "revision": 1,
      "created_at": 43001,
      "updated_at": 43001
    }
  ],
  "schemaVersion": 43,
  "migrations": [
    {
      "version": 1,
      "applied_at": 43001
    },
    {
      "version": 2,
      "applied_at": 43001
    },
    {
      "version": 3,
      "applied_at": 43001
    },
    {
      "version": 4,
      "applied_at": 43001
    },
    {
      "version": 5,
      "applied_at": 43001
    },
    {
      "version": 6,
      "applied_at": 43001
    },
    {
      "version": 7,
      "applied_at": 43001
    },
    {
      "version": 8,
      "applied_at": 43001
    },
    {
      "version": 9,
      "applied_at": 43001
    },
    {
      "version": 10,
      "applied_at": 43001
    },
    {
      "version": 11,
      "applied_at": 43001
    },
    {
      "version": 12,
      "applied_at": 43001
    },
    {
      "version": 13,
      "applied_at": 43001
    },
    {
      "version": 14,
      "applied_at": 43001
    },
    {
      "version": 15,
      "applied_at": 43001
    },
    {
      "version": 16,
      "applied_at": 43001
    },
    {
      "version": 17,
      "applied_at": 43001
    },
    {
      "version": 18,
      "applied_at": 43001
    },
    {
      "version": 19,
      "applied_at": 43001
    },
    {
      "version": 20,
      "applied_at": 43001
    },
    {
      "version": 21,
      "applied_at": 43001
    },
    {
      "version": 22,
      "applied_at": 43001
    },
    {
      "version": 23,
      "applied_at": 43001
    },
    {
      "version": 24,
      "applied_at": 43001
    },
    {
      "version": 25,
      "applied_at": 43001
    },
    {
      "version": 26,
      "applied_at": 43001
    },
    {
      "version": 27,
      "applied_at": 43001
    },
    {
      "version": 28,
      "applied_at": 43001
    },
    {
      "version": 29,
      "applied_at": 43001
    },
    {
      "version": 30,
      "applied_at": 43001
    },
    {
      "version": 31,
      "applied_at": 43001
    },
    {
      "version": 32,
      "applied_at": 43001
    },
    {
      "version": 33,
      "applied_at": 43001
    },
    {
      "version": 34,
      "applied_at": 43001
    },
    {
      "version": 35,
      "applied_at": 43001
    },
    {
      "version": 36,
      "applied_at": 43001
    },
    {
      "version": 37,
      "applied_at": 43001
    },
    {
      "version": 38,
      "applied_at": 43001
    },
    {
      "version": 39,
      "applied_at": 43001
    },
    {
      "version": 40,
      "applied_at": 43001
    },
    {
      "version": 41,
      "applied_at": 43001
    },
    {
      "version": 42,
      "applied_at": 43001
    },
    {
      "version": 43,
      "applied_at": 43001
    }
  ],
  "schema": [
    {
      "type": "index",
      "name": "account_rate_limit_reset_attempts_identity_window",
      "tbl_name": "account_rate_limit_reset_attempts",
      "sql": "CREATE INDEX account_rate_limit_reset_attempts_identity_window\n  ON account_rate_limit_reset_attempts(\n    profile_id,account_fingerprint,weekly_window_resets_at,attempt_sequence\n  )"
    },
    {
      "type": "index",
      "name": "account_rate_limit_reset_attempts_one_recoverable",
      "tbl_name": "account_rate_limit_reset_attempts",
      "sql": "CREATE UNIQUE INDEX account_rate_limit_reset_attempts_one_recoverable\n  ON account_rate_limit_reset_attempts(profile_id,account_fingerprint)\n  WHERE state IN ('prepared','effect_started','ambiguous','retryable')"
    },
    {
      "type": "index",
      "name": "account_rate_limit_reset_attempts_one_success",
      "tbl_name": "account_rate_limit_reset_attempts",
      "sql": "CREATE UNIQUE INDEX account_rate_limit_reset_attempts_one_success\n  ON account_rate_limit_reset_attempts(\n    profile_id,account_fingerprint,weekly_window_resets_at\n  ) WHERE outcome IN ('reset','alreadyRedeemed')"
    },
    {
      "type": "index",
      "name": "account_rate_limit_reset_rebinds_attempt",
      "tbl_name": "account_rate_limit_reset_rebinds",
      "sql": "CREATE INDEX account_rate_limit_reset_rebinds_attempt\n  ON account_rate_limit_reset_rebinds(idempotency_key,sequence)"
    },
    {
      "type": "index",
      "name": "autorespond_evidence_recent",
      "tbl_name": "autorespond_evidence",
      "sql": "CREATE INDEX autorespond_evidence_recent ON autorespond_evidence(occurred_at DESC, id DESC)"
    },
    {
      "type": "index",
      "name": "autorespond_evidence_session",
      "tbl_name": "autorespond_evidence",
      "sql": "CREATE INDEX autorespond_evidence_session ON autorespond_evidence(session_id, occurred_at DESC, id DESC)"
    },
    {
      "type": "index",
      "name": "autorespond_message_sources_recent",
      "tbl_name": "autorespond_message_sources",
      "sql": "CREATE INDEX autorespond_message_sources_recent ON autorespond_message_sources(session_id, created_at DESC)"
    },
    {
      "type": "index",
      "name": "desktop_switch_generation_unique",
      "tbl_name": "desktop_switches",
      "sql": "CREATE UNIQUE INDEX desktop_switch_generation_unique\n  ON desktop_switches(switch_generation) WHERE switch_generation IS NOT NULL"
    },
    {
      "type": "index",
      "name": "desktop_switch_resolution_generation_unique",
      "tbl_name": "desktop_switch_resolutions",
      "sql": "CREATE UNIQUE INDEX desktop_switch_resolution_generation_unique\n  ON desktop_switch_resolutions(switch_generation)"
    },
    {
      "type": "index",
      "name": "memory_page_attestation_refs_attestation",
      "tbl_name": "memory_page_attestation_refs",
      "sql": "CREATE INDEX memory_page_attestation_refs_attestation\n  ON memory_page_attestation_refs(attestation_sha256)"
    },
    {
      "type": "index",
      "name": "memory_submissions_actor_recent",
      "tbl_name": "memory_submissions",
      "sql": "CREATE INDEX memory_submissions_actor_recent\n  ON memory_submissions(actor_session_id,created_at DESC,id)"
    },
    {
      "type": "index",
      "name": "memory_submissions_one_unsettled_project",
      "tbl_name": "memory_submissions",
      "sql": "CREATE UNIQUE INDEX memory_submissions_one_unsettled_project\n  ON memory_submissions(project_id)\n  WHERE state IN ('prepared','effect_started','ambiguous')"
    },
    {
      "type": "index",
      "name": "memory_submissions_project_recent",
      "tbl_name": "memory_submissions",
      "sql": "CREATE INDEX memory_submissions_project_recent\n  ON memory_submissions(project_id,created_at DESC,id)"
    },
    {
      "type": "index",
      "name": "memory_submissions_remember_attestation",
      "tbl_name": "memory_submissions",
      "sql": "CREATE UNIQUE INDEX memory_submissions_remember_attestation\n  ON memory_submissions(attestation_sha256)\n  WHERE kind='remember' AND attestation_sha256 IS NOT NULL"
    },
    {
      "type": "index",
      "name": "memory_submissions_unsettled",
      "tbl_name": "memory_submissions",
      "sql": "CREATE INDEX memory_submissions_unsettled\n  ON memory_submissions(created_at,id)\n  WHERE state IN ('prepared','effect_started','ambiguous')"
    },
    {
      "type": "index",
      "name": "message_attachments_digest",
      "tbl_name": "message_attachments",
      "sql": "CREATE INDEX message_attachments_digest ON message_attachments(digest)"
    },
    {
      "type": "index",
      "name": "message_attachments_recent",
      "tbl_name": "message_attachments",
      "sql": "CREATE INDEX message_attachments_recent ON message_attachments(session_id, created_at DESC)"
    },
    {
      "type": "index",
      "name": "one_default_project",
      "tbl_name": "projects",
      "sql": "CREATE UNIQUE INDEX one_default_project ON projects(is_default) WHERE is_default = 1"
    },
    {
      "type": "index",
      "name": "peer_session_action_parents_parent",
      "tbl_name": "peer_session_action_parents",
      "sql": "CREATE INDEX peer_session_action_parents_parent\n  ON peer_session_action_parents(parent_action_id,action_id)"
    },
    {
      "type": "index",
      "name": "peer_session_action_roots_root",
      "tbl_name": "peer_session_action_roots",
      "sql": "CREATE INDEX peer_session_action_roots_root\n  ON peer_session_action_roots(root_action_id,action_id)"
    },
    {
      "type": "index",
      "name": "peer_session_action_visits_session",
      "tbl_name": "peer_session_action_visits",
      "sql": "CREATE INDEX peer_session_action_visits_session\n  ON peer_session_action_visits(session_id,action_id)"
    },
    {
      "type": "index",
      "name": "peer_session_actions_actor_recent",
      "tbl_name": "peer_session_actions",
      "sql": "CREATE INDEX peer_session_actions_actor_recent\n  ON peer_session_actions(actor_session_id,created_at DESC,id)"
    },
    {
      "type": "index",
      "name": "peer_session_actions_actor_target_recent",
      "tbl_name": "peer_session_actions",
      "sql": "CREATE INDEX peer_session_actions_actor_target_recent\n  ON peer_session_actions(actor_session_id,target_session_id,created_at DESC,id)"
    },
    {
      "type": "index",
      "name": "peer_session_actions_project_rate",
      "tbl_name": "peer_session_actions",
      "sql": "CREATE INDEX peer_session_actions_project_rate\n  ON peer_session_actions(project_id,created_at,id)"
    },
    {
      "type": "index",
      "name": "peer_session_actions_project_retention",
      "tbl_name": "peer_session_actions",
      "sql": "CREATE INDEX peer_session_actions_project_retention\n  ON peer_session_actions(project_id,updated_at,id)\n  WHERE state IN ('applied','failed','cancelled')"
    },
    {
      "type": "index",
      "name": "peer_session_actions_target_recent",
      "tbl_name": "peer_session_actions",
      "sql": "CREATE INDEX peer_session_actions_target_recent\n  ON peer_session_actions(target_session_id,created_at DESC,id)"
    },
    {
      "type": "index",
      "name": "peer_session_actions_unsettled",
      "tbl_name": "peer_session_actions",
      "sql": "CREATE INDEX peer_session_actions_unsettled\n  ON peer_session_actions(created_at,id)\n  WHERE state IN ('prepared','queued','effect_started','ambiguous')"
    },
    {
      "type": "index",
      "name": "peer_session_direct_message_sources_project_recent",
      "tbl_name": "peer_session_direct_message_sources",
      "sql": "CREATE INDEX peer_session_direct_message_sources_project_recent\n  ON peer_session_direct_message_sources(project_id,created_at,idempotency_key)"
    },
    {
      "type": "index",
      "name": "peer_session_direct_message_sources_target",
      "tbl_name": "peer_session_direct_message_sources",
      "sql": "CREATE INDEX peer_session_direct_message_sources_target\n  ON peer_session_direct_message_sources(target_session_id,idempotency_key)"
    },
    {
      "type": "index",
      "name": "peer_session_turn_origins_action",
      "tbl_name": "peer_session_turn_origins",
      "sql": "CREATE INDEX peer_session_turn_origins_action\n  ON peer_session_turn_origins(action_id,session_id,turn_digest)"
    },
    {
      "type": "index",
      "name": "profiles_label_active",
      "tbl_name": "profiles",
      "sql": "CREATE UNIQUE INDEX profiles_label_active ON profiles(lower(label)) WHERE state != 'removed'"
    },
    {
      "type": "index",
      "name": "profiles_label_key_active",
      "tbl_name": "profiles",
      "sql": "CREATE UNIQUE INDEX profiles_label_key_active\n  ON profiles(label_key) WHERE state!='removed'"
    },
    {
      "type": "index",
      "name": "project_memory_authorities_space_unique",
      "tbl_name": "project_memory_authorities",
      "sql": "CREATE UNIQUE INDEX project_memory_authorities_space_unique\n  ON project_memory_authorities(canonical_space_id)"
    },
    {
      "type": "index",
      "name": "project_memory_hosted_create_intents_one_unresolved_project",
      "tbl_name": "project_memory_hosted_create_intents",
      "sql": "CREATE UNIQUE INDEX project_memory_hosted_create_intents_one_unresolved_project\n  ON project_memory_hosted_create_intents(project_id)\n  WHERE state IN ('allocating','key_staged','prepared','effect_started','winner_observed')"
    },
    {
      "type": "index",
      "name": "project_memory_hosted_create_intents_project_recent",
      "tbl_name": "project_memory_hosted_create_intents",
      "sql": "CREATE INDEX project_memory_hosted_create_intents_project_recent\n  ON project_memory_hosted_create_intents(project_id,created_at DESC,id)"
    },
    {
      "type": "index",
      "name": "project_memory_hosted_create_intents_remote_space",
      "tbl_name": "project_memory_hosted_create_intents",
      "sql": "CREATE UNIQUE INDEX project_memory_hosted_create_intents_remote_space\n  ON project_memory_hosted_create_intents(remote_space_id)"
    },
    {
      "type": "index",
      "name": "project_memory_portable_adoption_proofs_record",
      "tbl_name": "project_memory_portable_adoption_proofs",
      "sql": "CREATE INDEX project_memory_portable_adoption_proofs_record\n  ON project_memory_portable_adoption_proofs(\n    project_id,canonical_binding_digest,record_sha256,key_digest,content_digest\n  )"
    },
    {
      "type": "index",
      "name": "project_memory_sync_intents_one_unresolved_project",
      "tbl_name": "project_memory_sync_intents",
      "sql": "CREATE UNIQUE INDEX project_memory_sync_intents_one_unresolved_project\n  ON project_memory_sync_intents(project_id)\n  WHERE state IN ('prepared','effect_started','response_observed')"
    },
    {
      "type": "index",
      "name": "project_memory_sync_intents_project_recent",
      "tbl_name": "project_memory_sync_intents",
      "sql": "CREATE INDEX project_memory_sync_intents_project_recent\n  ON project_memory_sync_intents(project_id,created_at DESC,id)"
    },
    {
      "type": "index",
      "name": "project_memory_sync_intents_project_settled",
      "tbl_name": "project_memory_sync_intents",
      "sql": "CREATE INDEX project_memory_sync_intents_project_settled\n  ON project_memory_sync_intents(project_id,updated_at,id) WHERE state='settled'"
    },
    {
      "type": "index",
      "name": "projects_label_key_unique",
      "tbl_name": "projects",
      "sql": "CREATE UNIQUE INDEX projects_label_key_unique\n  ON projects(label_key)"
    },
    {
      "type": "index",
      "name": "projects_label_unique",
      "tbl_name": "projects",
      "sql": "CREATE UNIQUE INDEX projects_label_unique ON projects(lower(label))"
    },
    {
      "type": "index",
      "name": "provider_interactions_due",
      "tbl_name": "provider_interactions",
      "sql": "CREATE INDEX provider_interactions_due\n  ON provider_interactions(deadline_at,public_id)\n  WHERE state='pending'"
    },
    {
      "type": "index",
      "name": "provider_interactions_listing_global",
      "tbl_name": "provider_interactions",
      "sql": "CREATE INDEX provider_interactions_listing_global\n  ON provider_interactions(requested_at DESC,public_id ASC)"
    },
    {
      "type": "index",
      "name": "provider_interactions_listing_pending_global",
      "tbl_name": "provider_interactions",
      "sql": "CREATE INDEX provider_interactions_listing_pending_global\n  ON provider_interactions(requested_at DESC,public_id ASC)\n  WHERE state IN ('pending','response_prepared','response_written')"
    },
    {
      "type": "index",
      "name": "provider_interactions_listing_pending_session",
      "tbl_name": "provider_interactions",
      "sql": "CREATE INDEX provider_interactions_listing_pending_session\n  ON provider_interactions(session_id,requested_at DESC,public_id ASC)\n  WHERE state IN ('pending','response_prepared','response_written')"
    },
    {
      "type": "index",
      "name": "provider_interactions_listing_session",
      "tbl_name": "provider_interactions",
      "sql": "CREATE INDEX provider_interactions_listing_session\n  ON provider_interactions(session_id,requested_at DESC,public_id ASC)"
    },
    {
      "type": "index",
      "name": "provider_interactions_numeric_request",
      "tbl_name": "provider_interactions",
      "sql": "CREATE UNIQUE INDEX provider_interactions_numeric_request\n  ON provider_interactions(profile_id,process_generation,connection_id,request_id_number)\n  WHERE request_id_type='number'"
    },
    {
      "type": "index",
      "name": "provider_interactions_pending",
      "tbl_name": "provider_interactions",
      "sql": "CREATE INDEX provider_interactions_pending\n  ON provider_interactions(profile_id,process_generation,requested_at,public_id)\n  WHERE state IN ('pending','response_prepared','response_written')"
    },
    {
      "type": "index",
      "name": "provider_interactions_session",
      "tbl_name": "provider_interactions",
      "sql": "CREATE INDEX provider_interactions_session\n  ON provider_interactions(session_id,requested_at DESC,public_id)"
    },
    {
      "type": "index",
      "name": "provider_interactions_string_request",
      "tbl_name": "provider_interactions",
      "sql": "CREATE UNIQUE INDEX provider_interactions_string_request\n  ON provider_interactions(profile_id,process_generation,connection_id,request_id_text)\n  WHERE request_id_type='string'"
    },
    {
      "type": "index",
      "name": "provider_login_authority_active_profile",
      "tbl_name": "provider_login_authorities",
      "sql": "CREATE UNIQUE INDEX provider_login_authority_active_profile\n  ON provider_login_authorities(profile_id) WHERE state='active'"
    },
    {
      "type": "index",
      "name": "provider_runtime_account_revocations_releasing",
      "tbl_name": "provider_runtime_account_revocations",
      "sql": "CREATE INDEX provider_runtime_account_revocations_releasing\n  ON provider_runtime_account_revocations(created_at,profile_id,provider,runtime_scope)\n  WHERE state='releasing'"
    },
    {
      "type": "index",
      "name": "queue_enqueue_sequence_unique",
      "tbl_name": "queue_entries",
      "sql": "CREATE UNIQUE INDEX queue_enqueue_sequence_unique\n  ON queue_entries(enqueue_sequence)"
    },
    {
      "type": "index",
      "name": "queue_entries_message_scrub_candidates",
      "tbl_name": "queue_entries",
      "sql": "CREATE INDEX queue_entries_message_scrub_candidates\n  ON queue_entries(id)\n  WHERE message!='[queue message removed after settlement]'"
    },
    {
      "type": "index",
      "name": "queue_peer_action",
      "tbl_name": "queue_entries",
      "sql": "CREATE INDEX queue_peer_action\n  ON queue_entries(peer_action_id) WHERE peer_action_id IS NOT NULL"
    },
    {
      "type": "index",
      "name": "queue_pending",
      "tbl_name": "queue_entries",
      "sql": "CREATE INDEX queue_pending ON queue_entries(session_id, created_at, id) WHERE state = 'pending'"
    },
    {
      "type": "index",
      "name": "queue_pending_sequence",
      "tbl_name": "queue_entries",
      "sql": "CREATE INDEX queue_pending_sequence\n  ON queue_entries(session_id,enqueue_sequence) WHERE state='pending'"
    },
    {
      "type": "index",
      "name": "session_adoption_candidates_claude_reprobe",
      "tbl_name": "session_adoption_candidates",
      "sql": "CREATE INDEX session_adoption_candidates_claude_reprobe\n  ON session_adoption_candidates(last_observed_at,provider_thread_id)\n  WHERE provider='claude'\n    AND provider_updated_at IS NOT NULL\n    AND claim_status IN ('pending','claiming')\n    AND source_pid IS NOT NULL\n    AND source_pid_domain IS NOT NULL\n    AND source_proc_start IS NOT NULL"
    },
    {
      "type": "index",
      "name": "session_adoption_candidates_pending",
      "tbl_name": "session_adoption_candidates",
      "sql": "CREATE INDEX session_adoption_candidates_pending\n  ON session_adoption_candidates(provider,last_observed_at DESC,provider_thread_id)\n  WHERE claim_status='pending'"
    },
    {
      "type": "index",
      "name": "session_claude_process_authorities_live_identity",
      "tbl_name": "session_claude_process_authorities",
      "sql": "CREATE UNIQUE INDEX session_claude_process_authorities_live_identity\n  ON session_claude_process_authorities(pid_domain,pid,proc_start)\n  WHERE state!='released'"
    },
    {
      "type": "index",
      "name": "session_claude_process_authorities_session",
      "tbl_name": "session_claude_process_authorities",
      "sql": "CREATE INDEX session_claude_process_authorities_session\n  ON session_claude_process_authorities(session_id,state)\n  WHERE session_id IS NOT NULL"
    },
    {
      "type": "index",
      "name": "session_claude_process_launch_intents_profile",
      "tbl_name": "session_claude_process_launch_intents",
      "sql": "CREATE INDEX session_claude_process_launch_intents_profile\n  ON session_claude_process_launch_intents(profile_id,profile_generation,staged_at,provider_thread_id)"
    },
    {
      "type": "index",
      "name": "session_claude_process_launch_intents_session",
      "tbl_name": "session_claude_process_launch_intents",
      "sql": "CREATE UNIQUE INDEX session_claude_process_launch_intents_session\n  ON session_claude_process_launch_intents(session_id)\n  WHERE session_id IS NOT NULL"
    },
    {
      "type": "index",
      "name": "session_events_age",
      "tbl_name": "session_events",
      "sql": "CREATE INDEX session_events_age\n  ON session_events(session_id, recorded_at, sequence)"
    },
    {
      "type": "index",
      "name": "session_message_event_sources_session_recent",
      "tbl_name": "session_message_event_sources",
      "sql": "CREATE INDEX session_message_event_sources_session_recent\n  ON session_message_event_sources(session_id,event_sequence DESC)"
    },
    {
      "type": "index",
      "name": "session_personal_runtime_bindings_active",
      "tbl_name": "session_personal_runtime_bindings",
      "sql": "CREATE INDEX session_personal_runtime_bindings_active\n  ON session_personal_runtime_bindings(provider,session_id)\n  WHERE state='active'"
    },
    {
      "type": "index",
      "name": "session_task_occurrences_by_session",
      "tbl_name": "session_task_occurrences",
      "sql": "CREATE INDEX session_task_occurrences_by_session\n  ON session_task_occurrences(session_id,created_at,task_id,scheduled_for)"
    },
    {
      "type": "index",
      "name": "session_task_receipts_by_task",
      "tbl_name": "session_task_receipts",
      "sql": "CREATE INDEX session_task_receipts_by_task\n  ON session_task_receipts(session_id,task_id,created_at)"
    },
    {
      "type": "index",
      "name": "session_tasks_by_session",
      "tbl_name": "session_tasks",
      "sql": "CREATE INDEX session_tasks_by_session\n  ON session_tasks(session_id,created_at,id) WHERE deleted_at IS NULL"
    },
    {
      "type": "index",
      "name": "session_tasks_due",
      "tbl_name": "session_tasks",
      "sql": "CREATE INDEX session_tasks_due\n  ON session_tasks(next_due_at,id) WHERE deleted_at IS NULL AND status='active'"
    },
    {
      "type": "index",
      "name": "sessions_archived",
      "tbl_name": "sessions",
      "sql": "CREATE INDEX sessions_archived ON sessions(archived_at, updated_at DESC, id)"
    },
    {
      "type": "index",
      "name": "sessions_profile_created",
      "tbl_name": "sessions",
      "sql": "CREATE INDEX sessions_profile_created\n  ON sessions(profile_id,created_at DESC,id)"
    },
    {
      "type": "index",
      "name": "sessions_recent",
      "tbl_name": "sessions",
      "sql": "CREATE INDEX sessions_recent ON sessions(updated_at DESC, id)"
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_account_rate_limit_reset_attempts_1",
      "tbl_name": "account_rate_limit_reset_attempts",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_account_rate_limit_reset_policies_1",
      "tbl_name": "account_rate_limit_reset_policies",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_account_rate_limit_reset_rebinds_1",
      "tbl_name": "account_rate_limit_reset_rebinds",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_attachments_1",
      "tbl_name": "attachments",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_autorespond_message_sources_1",
      "tbl_name": "autorespond_message_sources",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_desktop_switch_resolutions_1",
      "tbl_name": "desktop_switch_resolutions",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_desktop_switches_1",
      "tbl_name": "desktop_switches",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_device_command_ledger_1",
      "tbl_name": "device_command_ledger",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_memory_page_attestation_refs_1",
      "tbl_name": "memory_page_attestation_refs",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_memory_page_attestations_1",
      "tbl_name": "memory_page_attestations",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_memory_page_attestations_2",
      "tbl_name": "memory_page_attestations",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_memory_submissions_1",
      "tbl_name": "memory_submissions",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_memory_submissions_2",
      "tbl_name": "memory_submissions",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_memory_working_attestation_forks_1",
      "tbl_name": "memory_working_attestation_forks",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_memory_working_attestation_forks_2",
      "tbl_name": "memory_working_attestation_forks",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_memory_working_attestation_heads_1",
      "tbl_name": "memory_working_attestation_heads",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_message_attachments_1",
      "tbl_name": "message_attachments",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_mutation_attempts_1",
      "tbl_name": "mutation_attempts",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_mutation_attempts_2",
      "tbl_name": "mutation_attempts",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_mutation_effect_evidence_1",
      "tbl_name": "mutation_effect_evidence",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_mutation_resolutions_1",
      "tbl_name": "mutation_resolutions",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_peer_session_action_parents_1",
      "tbl_name": "peer_session_action_parents",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_peer_session_action_roots_1",
      "tbl_name": "peer_session_action_roots",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_peer_session_action_visits_1",
      "tbl_name": "peer_session_action_visits",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_peer_session_actions_1",
      "tbl_name": "peer_session_actions",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_peer_session_actions_2",
      "tbl_name": "peer_session_actions",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_peer_session_direct_message_sources_1",
      "tbl_name": "peer_session_direct_message_sources",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_peer_session_direct_message_sources_2",
      "tbl_name": "peer_session_direct_message_sources",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_peer_session_turn_origins_1",
      "tbl_name": "peer_session_turn_origins",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_profile_personal_authority_revocations_1",
      "tbl_name": "profile_personal_authority_revocations",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_profiles_1",
      "tbl_name": "profiles",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_project_approval_modes_1",
      "tbl_name": "project_approval_modes",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_project_memory_authorities_1",
      "tbl_name": "project_memory_authorities",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_project_memory_hosted_attachments_1",
      "tbl_name": "project_memory_hosted_attachments",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_project_memory_hosted_attachments_2",
      "tbl_name": "project_memory_hosted_attachments",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_project_memory_hosted_create_intents_1",
      "tbl_name": "project_memory_hosted_create_intents",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_project_memory_hosted_create_intents_2",
      "tbl_name": "project_memory_hosted_create_intents",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_project_memory_portable_adoption_proofs_1",
      "tbl_name": "project_memory_portable_adoption_proofs",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_project_memory_portable_adoption_proofs_2",
      "tbl_name": "project_memory_portable_adoption_proofs",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_project_memory_sync_intents_1",
      "tbl_name": "project_memory_sync_intents",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_project_memory_sync_intents_2",
      "tbl_name": "project_memory_sync_intents",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_project_memory_sync_spool_1",
      "tbl_name": "project_memory_sync_spool",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_projects_1",
      "tbl_name": "projects",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_projects_2",
      "tbl_name": "projects",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_provider_interaction_transitions_1",
      "tbl_name": "provider_interaction_transitions",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_provider_interactions_1",
      "tbl_name": "provider_interactions",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_provider_login_authorities_1",
      "tbl_name": "provider_login_authorities",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_provider_runtime_account_revocations_1",
      "tbl_name": "provider_runtime_account_revocations",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_queue_effect_evidence_1",
      "tbl_name": "queue_effect_evidence",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_queue_effect_resolutions_1",
      "tbl_name": "queue_effect_resolutions",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_queue_entries_1",
      "tbl_name": "queue_entries",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_session_account_authorities_1",
      "tbl_name": "session_account_authorities",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_session_adoption_candidates_1",
      "tbl_name": "session_adoption_candidates",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_session_adoption_policies_1",
      "tbl_name": "session_adoption_policies",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_session_adoption_profile_generation_permits_1",
      "tbl_name": "session_adoption_profile_generation_permits",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_session_approval_modes_1",
      "tbl_name": "session_approval_modes",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_session_autorespond_counters_1",
      "tbl_name": "session_autorespond_counters",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_session_claude_process_authorities_1",
      "tbl_name": "session_claude_process_authorities",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_session_claude_process_launch_intents_1",
      "tbl_name": "session_claude_process_launch_intents",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_session_claude_process_launch_intents_2",
      "tbl_name": "session_claude_process_launch_intents",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_session_conversation_automation_1",
      "tbl_name": "session_conversation_automation",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_session_event_streams_1",
      "tbl_name": "session_event_streams",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_session_event_streams_2",
      "tbl_name": "session_event_streams",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_session_events_1",
      "tbl_name": "session_events",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_session_host_capability_bindings_1",
      "tbl_name": "session_host_capability_bindings",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_session_message_event_sources_1",
      "tbl_name": "session_message_event_sources",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_session_message_event_sources_2",
      "tbl_name": "session_message_event_sources",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_session_mutation_authority_rebinds_1",
      "tbl_name": "session_mutation_authority_rebinds",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_session_mutation_authority_rebinds_2",
      "tbl_name": "session_mutation_authority_rebinds",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_session_mutation_authority_rebinds_v39_1",
      "tbl_name": "session_mutation_authority_rebinds_v39",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_session_mutation_authority_rebinds_v39_2",
      "tbl_name": "session_mutation_authority_rebinds_v39",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_session_peer_policies_1",
      "tbl_name": "session_peer_policies",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_session_personal_runtime_bindings_1",
      "tbl_name": "session_personal_runtime_bindings",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_session_personal_runtime_bindings_2",
      "tbl_name": "session_personal_runtime_bindings",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_session_provider_account_authorities_1",
      "tbl_name": "session_provider_account_authorities",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_session_provider_switch_seed_intents_1",
      "tbl_name": "session_provider_switch_seed_intents",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_session_provider_switch_seed_results_1",
      "tbl_name": "session_provider_switch_seed_results",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_session_provider_switch_source_releases_1",
      "tbl_name": "session_provider_switch_source_releases",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_session_provider_switch_target_releases_1",
      "tbl_name": "session_provider_switch_target_releases",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_session_provider_switch_targets_1",
      "tbl_name": "session_provider_switch_targets",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_session_runtime_profiles_1",
      "tbl_name": "session_runtime_profiles",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_session_runtime_profiles_2",
      "tbl_name": "session_runtime_profiles",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_session_show_thinking_1",
      "tbl_name": "session_show_thinking",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_session_start_attempts_1",
      "tbl_name": "session_start_attempts",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_session_start_attempts_2",
      "tbl_name": "session_start_attempts",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_session_states_1",
      "tbl_name": "session_states",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_session_task_occurrences_1",
      "tbl_name": "session_task_occurrences",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_session_task_occurrences_2",
      "tbl_name": "session_task_occurrences",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_session_task_receipts_1",
      "tbl_name": "session_task_receipts",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_session_tasks_1",
      "tbl_name": "session_tasks",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_session_tasks_2",
      "tbl_name": "session_tasks",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_session_turn_runtime_profiles_1",
      "tbl_name": "session_turn_runtime_profiles",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_session_turn_runtime_profiles_2",
      "tbl_name": "session_turn_runtime_profiles",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_sessions_1",
      "tbl_name": "sessions",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_sessions_2",
      "tbl_name": "sessions",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_turn_summaries_1",
      "tbl_name": "turn_summaries",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_turn_summaries_2",
      "tbl_name": "turn_summaries",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_usage_cloud_upload_anchors_1",
      "tbl_name": "usage_cloud_upload_anchors",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_usage_poll_failures_1",
      "tbl_name": "usage_poll_failures",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_usage_revision_authority_1",
      "tbl_name": "usage_revision_authority",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_usage_snapshots_1",
      "tbl_name": "usage_snapshots",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_work_attempt_reports_1",
      "tbl_name": "work_attempt_reports",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_work_attempts_1",
      "tbl_name": "work_attempts",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_work_attempts_2",
      "tbl_name": "work_attempts",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_work_attempts_3",
      "tbl_name": "work_attempts",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_work_effect_resolutions_1",
      "tbl_name": "work_effect_resolutions",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_work_events_1",
      "tbl_name": "work_events",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_work_events_2",
      "tbl_name": "work_events",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_work_events_3",
      "tbl_name": "work_events",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_work_idempotency_intents_1",
      "tbl_name": "work_idempotency_intents",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_work_members_1",
      "tbl_name": "work_members",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_work_nested_effect_settlements_1",
      "tbl_name": "work_nested_effect_settlements",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_work_nested_effect_settlements_2",
      "tbl_name": "work_nested_effect_settlements",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_work_prepared_effects_1",
      "tbl_name": "work_prepared_effects",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_work_purge_authority_1",
      "tbl_name": "work_purge_authority",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_work_purge_authority_2",
      "tbl_name": "work_purge_authority",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_work_release_tombstones_1",
      "tbl_name": "work_release_tombstones",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_work_release_tombstones_2",
      "tbl_name": "work_release_tombstones",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_work_release_tombstones_3",
      "tbl_name": "work_release_tombstones",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_work_reviews_1",
      "tbl_name": "work_reviews",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_work_reviews_2",
      "tbl_name": "work_reviews",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_work_reviews_3",
      "tbl_name": "work_reviews",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_work_routes_1",
      "tbl_name": "work_routes",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_work_routes_2",
      "tbl_name": "work_routes",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_work_signal_receipts_1",
      "tbl_name": "work_signal_receipts",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_work_signals_1",
      "tbl_name": "work_signals",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_work_signals_2",
      "tbl_name": "work_signals",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_work_submissions_1",
      "tbl_name": "work_submissions",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_work_submissions_2",
      "tbl_name": "work_submissions",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_work_submissions_3",
      "tbl_name": "work_submissions",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_work_task_dependencies_1",
      "tbl_name": "work_task_dependencies",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_work_task_dependencies_2",
      "tbl_name": "work_task_dependencies",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_work_task_history_index_1",
      "tbl_name": "work_task_history_index",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_work_task_history_versions_1",
      "tbl_name": "work_task_history_versions",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_work_task_states_1",
      "tbl_name": "work_task_states",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_work_task_states_2",
      "tbl_name": "work_task_states",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_work_tasks_1",
      "tbl_name": "work_tasks",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_work_tasks_2",
      "tbl_name": "work_tasks",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_work_tasks_3",
      "tbl_name": "work_tasks",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_work_terminal_requests_1",
      "tbl_name": "work_terminal_requests",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_work_terminal_requests_2",
      "tbl_name": "work_terminal_requests",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_works_1",
      "tbl_name": "works",
      "sql": null
    },
    {
      "type": "index",
      "name": "sqlite_autoindex_works_2",
      "tbl_name": "works",
      "sql": null
    },
    {
      "type": "index",
      "name": "usage_cloud_upload_anchors_recent",
      "tbl_name": "usage_cloud_upload_anchors",
      "sql": "CREATE INDEX usage_cloud_upload_anchors_recent\n  ON usage_cloud_upload_anchors(profile_id, source_revision DESC)"
    },
    {
      "type": "index",
      "name": "usage_poll_failures_identity_recent",
      "tbl_name": "usage_poll_failures",
      "sql": "CREATE INDEX usage_poll_failures_identity_recent\n     ON usage_poll_failures(\n       profile_id,account_fingerprint,source_revision DESC\n     )"
    },
    {
      "type": "index",
      "name": "usage_poll_failures_recent",
      "tbl_name": "usage_poll_failures",
      "sql": "CREATE INDEX usage_poll_failures_recent\n  ON usage_poll_failures(profile_id, observed_at DESC, source_revision DESC)"
    },
    {
      "type": "index",
      "name": "work_attempt_reports_attempt",
      "tbl_name": "work_attempt_reports",
      "sql": "CREATE INDEX work_attempt_reports_attempt ON work_attempt_reports(attempt_id,created_at,idempotency_key)"
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
      "type": "index",
      "name": "work_effect_subject_unique",
      "tbl_name": "work_prepared_effects",
      "sql": "CREATE UNIQUE INDEX work_effect_subject_unique\n  ON work_prepared_effects(effect_kind,subject_id)"
    },
    {
      "type": "index",
      "name": "work_events_revision",
      "tbl_name": "work_events",
      "sql": "CREATE INDEX work_events_revision ON work_events(work_id,revision)"
    },
    {
      "type": "index",
      "name": "work_idempotency_work",
      "tbl_name": "work_idempotency_intents",
      "sql": "CREATE INDEX work_idempotency_work ON work_idempotency_intents(work_id,created_at,idempotency_key)"
    },
    {
      "type": "index",
      "name": "work_prepared_effects_pending",
      "tbl_name": "work_prepared_effects",
      "sql": "CREATE INDEX work_prepared_effects_pending ON work_prepared_effects(prepared_at,idempotency_key)\n  WHERE state IN ('prepared','effect_started')"
    },
    {
      "type": "index",
      "name": "work_release_tombstones_retention",
      "tbl_name": "work_release_tombstones",
      "sql": "CREATE INDEX work_release_tombstones_retention\n  ON work_release_tombstones(released_at,work_id)"
    },
    {
      "type": "index",
      "name": "work_reviews_submission",
      "tbl_name": "work_reviews",
      "sql": "CREATE INDEX work_reviews_submission ON work_reviews(submission_id,created_at,id)"
    },
    {
      "type": "index",
      "name": "work_signal_receipts_kind",
      "tbl_name": "work_signal_receipts",
      "sql": "CREATE INDEX work_signal_receipts_kind ON work_signal_receipts(signal_id,kind,sequence)"
    },
    {
      "type": "index",
      "name": "work_signals_recipient",
      "tbl_name": "work_signals",
      "sql": "CREATE INDEX work_signals_recipient ON work_signals(work_id,to_session_id,created_at,id)"
    },
    {
      "type": "index",
      "name": "work_submissions_task",
      "tbl_name": "work_submissions",
      "sql": "CREATE INDEX work_submissions_task ON work_submissions(task_id,created_at,id)"
    },
    {
      "type": "index",
      "name": "work_task_dependencies_reverse",
      "tbl_name": "work_task_dependencies",
      "sql": "CREATE INDEX work_task_dependencies_reverse\n  ON work_task_dependencies(work_id,dependency_task_id,task_id)"
    },
    {
      "type": "index",
      "name": "work_task_history_index_page",
      "tbl_name": "work_task_history_index",
      "sql": "CREATE INDEX work_task_history_index_page\n  ON work_task_history_index(work_id,task_id,ordinal DESC)"
    },
    {
      "type": "index",
      "name": "work_task_history_versions_cut",
      "tbl_name": "work_task_history_versions",
      "sql": "CREATE INDEX work_task_history_versions_cut\n  ON work_task_history_versions(history_ordinal,event_sequence DESC,ordinal DESC)"
    },
    {
      "type": "index",
      "name": "work_task_history_versions_work",
      "tbl_name": "work_task_history_versions",
      "sql": "CREATE INDEX work_task_history_versions_work\n  ON work_task_history_versions(work_id,task_id,ordinal)"
    },
    {
      "type": "index",
      "name": "work_task_states_ready",
      "tbl_name": "work_task_states",
      "sql": "CREATE INDEX work_task_states_ready ON work_task_states(work_id,state,updated_at,task_id)"
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
      "name": "account_rate_limit_reset_attempts",
      "tbl_name": "account_rate_limit_reset_attempts",
      "sql": "CREATE TABLE account_rate_limit_reset_attempts (\n  attempt_sequence INTEGER PRIMARY KEY AUTOINCREMENT CHECK(attempt_sequence BETWEEN 1 AND 9007199254740991),\n  idempotency_key TEXT NOT NULL UNIQUE CHECK(length(idempotency_key) = 36),\n  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,\n  origin_process_generation INTEGER NOT NULL CHECK(origin_process_generation BETWEEN 1 AND 9007199254740991),\n  current_process_generation INTEGER NOT NULL CHECK(current_process_generation BETWEEN origin_process_generation AND 9007199254740991),\n  account_fingerprint TEXT NOT NULL CHECK(length(account_fingerprint) = 64 AND account_fingerprint NOT GLOB '*[^a-f0-9]*'),\n  weekly_window_resets_at INTEGER NOT NULL CHECK(weekly_window_resets_at BETWEEN 0 AND 9007199254740991),\n  observed_used_percent REAL NOT NULL CHECK(observed_used_percent BETWEEN 99 AND 100),\n  state TEXT NOT NULL CHECK(state IN ('prepared','effect_started','ambiguous','retryable','settled','closed')),\n  outcome TEXT CHECK(outcome IN ('reset','alreadyRedeemed','nothingToReset','noCredit')),\n  local_resolution TEXT CHECK(local_resolution IN ('weekly_window_changed','account_identity_changed')),\n  created_at INTEGER NOT NULL CHECK(created_at >= 0),\n  updated_at INTEGER NOT NULL CHECK(updated_at >= created_at),\n  CHECK(\n    (state='settled' AND outcome IS NOT NULL AND local_resolution IS NULL) OR\n    (state='closed' AND outcome IS NULL AND local_resolution IS NOT NULL) OR\n    (state NOT IN ('settled','closed') AND outcome IS NULL AND local_resolution IS NULL)\n  )\n) STRICT"
    },
    {
      "type": "table",
      "name": "account_rate_limit_reset_policies",
      "tbl_name": "account_rate_limit_reset_policies",
      "sql": "CREATE TABLE account_rate_limit_reset_policies (\n  profile_id TEXT PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,\n  state TEXT NOT NULL CHECK(state IN (\n    'active_unbound','reconciliation_required','window_suppressed','active_bound'\n  )),\n  account_fingerprint TEXT CHECK(\n    account_fingerprint IS NULL OR (\n      length(account_fingerprint)=64\n      AND account_fingerprint NOT GLOB '*[^a-f0-9]*'\n    )\n  ),\n  weekly_window_resets_at INTEGER CHECK(\n    weekly_window_resets_at IS NULL\n    OR weekly_window_resets_at BETWEEN 0 AND 9007199254740991\n  ),\n  revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),\n  created_at INTEGER NOT NULL CHECK(created_at >= 0),\n  updated_at INTEGER NOT NULL CHECK(updated_at >= created_at),\n  CHECK(\n    (\n      state IN ('active_unbound','reconciliation_required')\n      AND account_fingerprint IS NULL\n      AND weekly_window_resets_at IS NULL\n    ) OR (\n      state IN ('window_suppressed','active_bound')\n      AND account_fingerprint IS NOT NULL\n      AND weekly_window_resets_at IS NOT NULL\n    )\n  )\n) STRICT"
    },
    {
      "type": "table",
      "name": "account_rate_limit_reset_rebinds",
      "tbl_name": "account_rate_limit_reset_rebinds",
      "sql": "CREATE TABLE account_rate_limit_reset_rebinds (\n  sequence INTEGER PRIMARY KEY,\n  idempotency_key TEXT NOT NULL REFERENCES account_rate_limit_reset_attempts(idempotency_key) ON DELETE CASCADE,\n  from_process_generation INTEGER NOT NULL CHECK(from_process_generation BETWEEN 1 AND 9007199254740991),\n  to_process_generation INTEGER NOT NULL CHECK(to_process_generation BETWEEN 1 AND 9007199254740991),\n  account_fingerprint TEXT NOT NULL CHECK(length(account_fingerprint) = 64 AND account_fingerprint NOT GLOB '*[^a-f0-9]*'),\n  created_at INTEGER NOT NULL CHECK(created_at >= 0),\n  CHECK(to_process_generation > from_process_generation),\n  UNIQUE(idempotency_key,to_process_generation)\n) STRICT"
    },
    {
      "type": "table",
      "name": "attachments",
      "tbl_name": "attachments",
      "sql": "CREATE TABLE attachments (\n  digest TEXT PRIMARY KEY CHECK(length(digest) = 64 AND digest GLOB '[0-9a-f]*'),\n  media_type TEXT NOT NULL CHECK(media_type IN ('image/png','image/jpeg','image/gif','image/webp','text/plain')),\n  byte_length INTEGER NOT NULL CHECK(byte_length BETWEEN 1 AND 5242880),\n  created_at INTEGER NOT NULL CHECK(created_at >= 0),\n  reference_count INTEGER NOT NULL DEFAULT 0 CHECK(reference_count >= 0)\n) STRICT"
    },
    {
      "type": "table",
      "name": "attention_email_policy",
      "tbl_name": "attention_email_policy",
      "sql": "CREATE TABLE attention_email_policy (\n  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),\n  version INTEGER NOT NULL CHECK(version = 1),\n  enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),\n  revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),\n  created_at INTEGER NOT NULL CHECK(created_at >= 0),\n  updated_at INTEGER NOT NULL CHECK(updated_at >= created_at)\n) STRICT"
    },
    {
      "type": "table",
      "name": "autorespond_evidence",
      "tbl_name": "autorespond_evidence",
      "sql": "CREATE TABLE \"autorespond_evidence\" (\n  id INTEGER PRIMARY KEY AUTOINCREMENT,\n  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,\n  path TEXT NOT NULL CHECK(path IN ('protocol','prose')),\n  interaction_id TEXT CHECK(interaction_id IS NULL OR length(interaction_id) = 36),\n  kind TEXT NOT NULL CHECK(kind IN ('command_approval','file_change_approval','permission_approval','prose_approval')),\n  class TEXT NOT NULL CHECK(length(class) BETWEEN 1 AND 256),\n  rule TEXT CHECK(rule IS NULL OR length(rule) BETWEEN 1 AND 64),\n  model TEXT CHECK(model IS NULL OR length(model) BETWEEN 1 AND 128),\n  decision TEXT NOT NULL CHECK(length(decision) BETWEEN 1 AND 64),\n  mode TEXT NOT NULL CHECK(mode IN ('auto:all','auto:workspace','manual')),\n  outcome TEXT NOT NULL CHECK(\n    outcome IN ('accepted','refused','sent','verbatim_mismatch','responder_failed')\n    OR outcome GLOB 'gate_failed:[a-z_]*'\n  ),\n  latency_ms INTEGER NOT NULL CHECK(latency_ms >= 0),\n  subagent INTEGER NOT NULL CHECK(subagent IN (0,1)),\n  occurred_at INTEGER NOT NULL CHECK(occurred_at >= 0),\n  CHECK((path = 'protocol') = (interaction_id IS NOT NULL)),\n  CHECK((path = 'prose') = (kind = 'prose_approval'))\n) STRICT\n"
    },
    {
      "type": "table",
      "name": "autorespond_message_sources",
      "tbl_name": "autorespond_message_sources",
      "sql": "CREATE TABLE autorespond_message_sources (\n  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,\n  source_id TEXT NOT NULL CHECK(length(source_id) BETWEEN 1 AND 200),\n  created_at INTEGER NOT NULL CHECK(created_at >= 0),\n  PRIMARY KEY (session_id, source_id)\n) STRICT"
    },
    {
      "type": "table",
      "name": "daemon_state",
      "tbl_name": "daemon_state",
      "sql": "CREATE TABLE daemon_state (\n  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),\n  generation INTEGER NOT NULL CHECK(generation >= 0),\n  boot_id TEXT,\n  started_at INTEGER,\n  stopped_at INTEGER\n, default_approval_mode TEXT NOT NULL DEFAULT 'auto:all' CHECK(default_approval_mode IN ('auto:all','auto:workspace','manual')), default_show_thinking INTEGER NOT NULL DEFAULT 0 CHECK(default_show_thinking IN (0,1)), default_preset TEXT NOT NULL DEFAULT 'ultra' CHECK(default_preset IN ('low','high','ultra')), device_commands_allowed INTEGER NOT NULL DEFAULT 1 CHECK(device_commands_allowed IN (0,1)), account_linking_allowed INTEGER NOT NULL DEFAULT 0 CHECK(account_linking_allowed IN (0,1))) STRICT"
    },
    {
      "type": "table",
      "name": "desktop_switch_authority",
      "tbl_name": "desktop_switch_authority",
      "sql": "CREATE TABLE desktop_switch_authority (\n  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),\n  current_generation INTEGER NOT NULL CHECK(current_generation >= 0),\n  current_attempt_id TEXT REFERENCES mutation_attempts(id), released_generation INTEGER NOT NULL DEFAULT 0 CHECK(released_generation >= 0 AND released_generation <= current_generation),\n  CHECK(\n    (current_generation = 0 AND current_attempt_id IS NULL) OR\n    (current_generation > 0 AND current_attempt_id IS NOT NULL)\n  )\n) STRICT"
    },
    {
      "type": "table",
      "name": "desktop_switch_resolutions",
      "tbl_name": "desktop_switch_resolutions",
      "sql": "CREATE TABLE desktop_switch_resolutions (\n  attempt_id TEXT PRIMARY KEY REFERENCES desktop_switches(attempt_id),\n  switch_generation INTEGER NOT NULL CHECK(switch_generation > 0),\n  resolution_kind TEXT NOT NULL CHECK(resolution_kind IN ('resolved_applied','resolved_not_applied')),\n  diagnostic_code TEXT NOT NULL CHECK(diagnostic_code GLOB '[A-Z]*' AND length(diagnostic_code) BETWEEN 1 AND 80),\n  observation_digest TEXT NOT NULL CHECK(length(observation_digest) = 64),\n  receipt_json TEXT NOT NULL CHECK(length(CAST(receipt_json AS BLOB)) BETWEEN 2 AND 262144),\n  resolved_at INTEGER NOT NULL CHECK(resolved_at >= 0)\n) STRICT"
    },
    {
      "type": "table",
      "name": "desktop_switches",
      "tbl_name": "desktop_switches",
      "sql": "CREATE TABLE desktop_switches (\n  attempt_id TEXT PRIMARY KEY REFERENCES mutation_attempts(id),\n  source_profile_id TEXT REFERENCES profiles(id),\n  target_profile_id TEXT NOT NULL REFERENCES profiles(id),\n  source_generation INTEGER,\n  target_generation INTEGER NOT NULL,\n  phase TEXT NOT NULL CHECK(phase IN ('prepared','quit_started','quit_confirmed','launch_started','verify_started','applied','failed','ambiguous')),\n  diagnostic_code TEXT,\n  updated_at INTEGER NOT NULL CHECK(updated_at >= 0)\n, switch_generation INTEGER CHECK(switch_generation IS NULL OR switch_generation > 0), journal_prepared INTEGER NOT NULL DEFAULT 1 CHECK(journal_prepared IN (0,1)), journal_digest TEXT CHECK(journal_digest IS NULL OR length(journal_digest) = 64), bundle_cd_hash TEXT, source_pid INTEGER CHECK(source_pid IS NULL OR source_pid > 0), expected_account_key TEXT, launched_pid INTEGER CHECK(launched_pid IS NULL OR launched_pid > 0), ambiguous_from_phase TEXT CHECK(ambiguous_from_phase IS NULL OR ambiguous_from_phase IN ('prepared','quit_started','quit_confirmed','launch_started','verify_started')), recovery_deadline_at INTEGER CHECK(recovery_deadline_at IS NULL OR recovery_deadline_at >= 0)) STRICT"
    },
    {
      "type": "table",
      "name": "device_command_ledger",
      "tbl_name": "device_command_ledger",
      "sql": "CREATE TABLE device_command_ledger (\n  device_public_id TEXT PRIMARY KEY,\n  day_key INTEGER NOT NULL CHECK(day_key >= 0),\n  day_count INTEGER NOT NULL CHECK(day_count >= 0),\n  first_session_start_notified_at INTEGER CHECK(first_session_start_notified_at IS NULL OR first_session_start_notified_at >= 0),\n  updated_at INTEGER NOT NULL CHECK(updated_at >= 0)\n) STRICT"
    },
    {
      "type": "table",
      "name": "memory_page_attestation_refs",
      "tbl_name": "memory_page_attestation_refs",
      "sql": "CREATE TABLE memory_page_attestation_refs (\n  lane TEXT NOT NULL CHECK(lane IN ('working','canonical')),\n  authority_digest TEXT NOT NULL CHECK(length(authority_digest) = 64 AND authority_digest NOT GLOB '*[^a-f0-9]*'),\n  project_id TEXT NOT NULL CHECK(project_id GLOB 'proj_[0-9a-f]*' AND length(project_id) = 37),\n  key_digest TEXT NOT NULL CHECK(length(key_digest) = 64 AND key_digest NOT GLOB '*[^a-f0-9]*'),\n  attestation_sha256 TEXT NOT NULL REFERENCES memory_page_attestations(attestation_sha256),\n  updated_at INTEGER NOT NULL CHECK(updated_at >= 0),\n  PRIMARY KEY(lane,authority_digest,key_digest)\n) STRICT"
    },
    {
      "type": "table",
      "name": "memory_page_attestations",
      "tbl_name": "memory_page_attestations",
      "sql": "CREATE TABLE memory_page_attestations (\n  attestation_sha256 TEXT PRIMARY KEY CHECK(length(attestation_sha256) = 64 AND attestation_sha256 NOT GLOB '*[^a-f0-9]*'),\n  submission_id TEXT NOT NULL UNIQUE CHECK(submission_id GLOB 'memsub_[0-9a-f]*' AND length(submission_id) = 39),\n  idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 64),\n  actor_session_id TEXT NOT NULL CHECK(actor_session_id GLOB 'sess_[0-9a-f]*' AND length(actor_session_id) = 37),\n  project_id TEXT NOT NULL CHECK(project_id GLOB 'proj_[0-9a-f]*' AND length(project_id) = 37),\n  request_digest TEXT NOT NULL CHECK(length(request_digest) = 64 AND request_digest NOT GLOB '*[^a-f0-9]*'),\n  content_digest TEXT NOT NULL CHECK(length(content_digest) = 64 AND content_digest NOT GLOB '*[^a-f0-9]*'),\n  key_digest TEXT NOT NULL CHECK(length(key_digest) = 64 AND key_digest NOT GLOB '*[^a-f0-9]*'),\n  working_binding_digest TEXT NOT NULL CHECK(length(working_binding_digest) = 64 AND working_binding_digest NOT GLOB '*[^a-f0-9]*'),\n  working_epoch INTEGER NOT NULL CHECK(working_epoch BETWEEN 1 AND 9007199254740991),\n  effect_record_sha256 TEXT NOT NULL CHECK(length(effect_record_sha256) = 64 AND effect_record_sha256 NOT GLOB '*[^a-f0-9]*'),\n  created_at INTEGER NOT NULL CHECK(created_at >= 0)\n) STRICT"
    },
    {
      "type": "table",
      "name": "memory_submissions",
      "tbl_name": "memory_submissions",
      "sql": "CREATE TABLE memory_submissions (\n  id TEXT PRIMARY KEY CHECK(id GLOB 'memsub_[0-9a-f]*' AND length(id) = 39),\n  idempotency_key TEXT NOT NULL UNIQUE CHECK(length(idempotency_key) BETWEEN 1 AND 64),\n  kind TEXT NOT NULL CHECK(kind IN ('remember','share')),\n  actor_session_id TEXT NOT NULL REFERENCES sessions(id),\n  project_id TEXT NOT NULL REFERENCES projects(id),\n  request_digest TEXT NOT NULL CHECK(length(request_digest) = 64 AND request_digest NOT GLOB '*[^a-f0-9]*'),\n  content_digest TEXT NOT NULL CHECK(length(content_digest) = 64 AND content_digest NOT GLOB '*[^a-f0-9]*'),\n  key_digest TEXT NOT NULL CHECK(length(key_digest) = 64 AND key_digest NOT GLOB '*[^a-f0-9]*'),\n  working_binding_digest TEXT NOT NULL CHECK(length(working_binding_digest) = 64 AND working_binding_digest NOT GLOB '*[^a-f0-9]*'),\n  working_epoch INTEGER NOT NULL CHECK(working_epoch BETWEEN 1 AND 9007199254740991),\n  effect_record_sha256 TEXT CHECK(effect_record_sha256 IS NULL OR (length(effect_record_sha256) = 64 AND effect_record_sha256 NOT GLOB '*[^a-f0-9]*')),\n  attestation_sha256 TEXT CHECK(attestation_sha256 IS NULL OR (length(attestation_sha256) = 64 AND attestation_sha256 NOT GLOB '*[^a-f0-9]*')),\n  operation_id TEXT CHECK(operation_id IS NULL OR length(operation_id) BETWEEN 1 AND 128),\n  source_head_sequence INTEGER CHECK(source_head_sequence IS NULL OR source_head_sequence BETWEEN 0 AND 9007199254740991),\n  source_head_operation_sha256 TEXT CHECK(source_head_operation_sha256 IS NULL OR (length(source_head_operation_sha256) = 64 AND source_head_operation_sha256 NOT GLOB '*[^a-f0-9]*')),\n  source_head_digest TEXT CHECK(source_head_digest IS NULL OR (length(source_head_digest) = 64 AND source_head_digest NOT GLOB '*[^a-f0-9]*')),\n  nomination_sha256 TEXT CHECK(nomination_sha256 IS NULL OR (length(nomination_sha256) = 64 AND nomination_sha256 NOT GLOB '*[^a-f0-9]*')),\n  expected_head_sequence INTEGER NOT NULL CHECK(expected_head_sequence BETWEEN 0 AND 9007199254740991),\n  expected_head_operation_sha256 TEXT CHECK(expected_head_operation_sha256 IS NULL OR (length(expected_head_operation_sha256) = 64 AND expected_head_operation_sha256 NOT GLOB '*[^a-f0-9]*')),\n  expected_head_digest TEXT NOT NULL CHECK(length(expected_head_digest) = 64 AND expected_head_digest NOT GLOB '*[^a-f0-9]*'),\n  result_head_sequence INTEGER CHECK(result_head_sequence IS NULL OR result_head_sequence BETWEEN 0 AND 9007199254740991),\n  result_head_operation_sha256 TEXT CHECK(result_head_operation_sha256 IS NULL OR (length(result_head_operation_sha256) = 64 AND result_head_operation_sha256 NOT GLOB '*[^a-f0-9]*')),\n  result_head_digest TEXT CHECK(result_head_digest IS NULL OR (length(result_head_digest) = 64 AND result_head_digest NOT GLOB '*[^a-f0-9]*')),\n  receipt_digest TEXT CHECK(receipt_digest IS NULL OR (length(receipt_digest) = 64 AND receipt_digest NOT GLOB '*[^a-f0-9]*')),\n  outcome_code TEXT CHECK(outcome_code IS NULL OR outcome_code IN ('remember_committed','remember_not_applied','share_adopted','share_already_present','share_conflict','share_not_applied','share_too_large')),\n  conflict_actual_head_sequence INTEGER CHECK(conflict_actual_head_sequence IS NULL OR conflict_actual_head_sequence BETWEEN 0 AND 9007199254740991),\n  conflict_actual_head_operation_sha256 TEXT CHECK(conflict_actual_head_operation_sha256 IS NULL OR (length(conflict_actual_head_operation_sha256) = 64 AND conflict_actual_head_operation_sha256 NOT GLOB '*[^a-f0-9]*')),\n  conflict_actual_head_digest TEXT CHECK(conflict_actual_head_digest IS NULL OR (length(conflict_actual_head_digest) = 64 AND conflict_actual_head_digest NOT GLOB '*[^a-f0-9]*')),\n  conflict_canonical_record_sha256 TEXT CHECK(conflict_canonical_record_sha256 IS NULL OR (length(conflict_canonical_record_sha256) = 64 AND conflict_canonical_record_sha256 NOT GLOB '*[^a-f0-9]*')),\n  conflict_nominated_record_sha256 TEXT CHECK(conflict_nominated_record_sha256 IS NULL OR (length(conflict_nominated_record_sha256) = 64 AND conflict_nominated_record_sha256 NOT GLOB '*[^a-f0-9]*')),\n  state TEXT NOT NULL CHECK(state IN ('prepared','effect_started','applied','failed','ambiguous','cancelled')),\n  created_at INTEGER NOT NULL CHECK(created_at >= 0),\n  updated_at INTEGER NOT NULL CHECK(updated_at >= created_at),\n  CHECK((expected_head_sequence = 0) = (expected_head_operation_sha256 IS NULL)),\n  CHECK(\n    (\n      effect_record_sha256 IS NULL\n      AND attestation_sha256 IS NULL\n      AND operation_id IS NULL\n      AND source_head_sequence IS NULL\n      AND source_head_operation_sha256 IS NULL\n      AND source_head_digest IS NULL\n      AND nomination_sha256 IS NULL\n    )\n    OR (\n      effect_record_sha256 IS NOT NULL\n      AND attestation_sha256 IS NOT NULL\n      AND operation_id IS NOT NULL\n      AND (\n        (\n          kind='remember'\n          AND source_head_sequence IS NULL\n          AND source_head_operation_sha256 IS NULL\n          AND source_head_digest IS NULL\n          AND nomination_sha256 IS NULL\n        )\n        OR (\n          kind='share'\n          AND source_head_sequence IS NOT NULL\n          AND source_head_digest IS NOT NULL\n          AND nomination_sha256 IS NOT NULL\n          AND ((source_head_sequence=0) = (source_head_operation_sha256 IS NULL))\n        )\n      )\n    )\n  ),\n  CHECK(effect_record_sha256 IS NOT NULL OR state IN ('prepared','cancelled')),\n  CHECK(\n    (result_head_sequence IS NULL) = (result_head_digest IS NULL)\n    AND (result_head_sequence IS NULL) = (receipt_digest IS NULL)\n    AND (result_head_sequence IS NOT NULL OR result_head_operation_sha256 IS NULL)\n    AND (\n      result_head_sequence IS NULL\n      OR ((result_head_sequence = 0) = (result_head_operation_sha256 IS NULL))\n    )\n  ),\n  CHECK((state = 'applied') = (result_head_sequence IS NOT NULL)),\n  CHECK((state IN ('applied','failed')) = (outcome_code IS NOT NULL)),\n  CHECK(\n    (state NOT IN ('applied','failed') AND outcome_code IS NULL)\n    OR (\n      kind='remember'\n      AND (\n        (state='applied' AND outcome_code='remember_committed'\n          AND result_head_sequence=expected_head_sequence+1)\n        OR (state='failed' AND outcome_code='remember_not_applied')\n      )\n    )\n    OR (\n      kind='share'\n      AND (\n        (state='applied' AND outcome_code='share_adopted'\n          AND result_head_sequence=expected_head_sequence+1)\n        OR (state='applied' AND outcome_code='share_already_present'\n          AND result_head_sequence=expected_head_sequence\n          AND result_head_operation_sha256 IS expected_head_operation_sha256\n          AND result_head_digest=expected_head_digest)\n        OR (state='failed' AND outcome_code IN ('share_conflict','share_not_applied','share_too_large'))\n      )\n    )\n  ),\n  CHECK(\n    (\n      conflict_actual_head_sequence IS NULL\n      AND conflict_actual_head_operation_sha256 IS NULL\n      AND conflict_actual_head_digest IS NULL\n      AND conflict_canonical_record_sha256 IS NULL\n      AND conflict_nominated_record_sha256 IS NULL\n    )\n    OR (\n      outcome_code='share_conflict'\n      AND conflict_actual_head_sequence IS NOT NULL\n      AND conflict_actual_head_digest IS NOT NULL\n      AND conflict_nominated_record_sha256 IS NOT NULL\n      AND ((conflict_actual_head_sequence=0) = (conflict_actual_head_operation_sha256 IS NULL))\n    )\n  )\n) STRICT"
    },
    {
      "type": "table",
      "name": "memory_working_attestation_forks",
      "tbl_name": "memory_working_attestation_forks",
      "sql": "CREATE TABLE memory_working_attestation_forks (\n  child_authority_digest TEXT PRIMARY KEY CHECK(length(child_authority_digest) = 64 AND child_authority_digest NOT GLOB '*[^a-f0-9]*'),\n  child_session_id TEXT NOT NULL UNIQUE CHECK(child_session_id GLOB 'sess_[0-9a-f]*' AND length(child_session_id) = 37),\n  parent_authority_digest TEXT NOT NULL CHECK(length(parent_authority_digest) = 64 AND parent_authority_digest NOT GLOB '*[^a-f0-9]*'),\n  parent_head_sequence INTEGER NOT NULL CHECK(parent_head_sequence BETWEEN 0 AND 9007199254740991),\n  parent_head_operation_sha256 TEXT CHECK(parent_head_operation_sha256 IS NULL OR (length(parent_head_operation_sha256) = 64 AND parent_head_operation_sha256 NOT GLOB '*[^a-f0-9]*')),\n  parent_head_digest TEXT NOT NULL CHECK(length(parent_head_digest) = 64 AND parent_head_digest NOT GLOB '*[^a-f0-9]*'),\n  created_at INTEGER NOT NULL CHECK(created_at >= 0),\n  updated_at INTEGER NOT NULL CHECK(updated_at >= created_at),\n  CHECK(child_authority_digest!=parent_authority_digest),\n  CHECK((parent_head_sequence=0) = (parent_head_operation_sha256 IS NULL))\n) STRICT"
    },
    {
      "type": "table",
      "name": "memory_working_attestation_heads",
      "tbl_name": "memory_working_attestation_heads",
      "sql": "CREATE TABLE memory_working_attestation_heads (\n  authority_digest TEXT PRIMARY KEY CHECK(length(authority_digest) = 64 AND authority_digest NOT GLOB '*[^a-f0-9]*'),\n  head_sequence INTEGER NOT NULL CHECK(head_sequence BETWEEN 0 AND 9007199254740991),\n  head_operation_sha256 TEXT CHECK(head_operation_sha256 IS NULL OR (length(head_operation_sha256) = 64 AND head_operation_sha256 NOT GLOB '*[^a-f0-9]*')),\n  head_digest TEXT NOT NULL CHECK(length(head_digest) = 64 AND head_digest NOT GLOB '*[^a-f0-9]*'),\n  origin TEXT NOT NULL CHECK(origin IN ('create','fork')),\n  fork_child_head_sequence INTEGER CHECK(fork_child_head_sequence IS NULL OR fork_child_head_sequence BETWEEN 0 AND 9007199254740991),\n  fork_child_head_operation_sha256 TEXT CHECK(fork_child_head_operation_sha256 IS NULL OR (length(fork_child_head_operation_sha256) = 64 AND fork_child_head_operation_sha256 NOT GLOB '*[^a-f0-9]*')),\n  fork_child_head_digest TEXT CHECK(fork_child_head_digest IS NULL OR (length(fork_child_head_digest) = 64 AND fork_child_head_digest NOT GLOB '*[^a-f0-9]*')),\n  fork_parent_authority_digest TEXT CHECK(fork_parent_authority_digest IS NULL OR (length(fork_parent_authority_digest) = 64 AND fork_parent_authority_digest NOT GLOB '*[^a-f0-9]*')),\n  fork_parent_head_sequence INTEGER CHECK(fork_parent_head_sequence IS NULL OR fork_parent_head_sequence BETWEEN 0 AND 9007199254740991),\n  fork_parent_head_operation_sha256 TEXT CHECK(fork_parent_head_operation_sha256 IS NULL OR (length(fork_parent_head_operation_sha256) = 64 AND fork_parent_head_operation_sha256 NOT GLOB '*[^a-f0-9]*')),\n  fork_parent_head_digest TEXT CHECK(fork_parent_head_digest IS NULL OR (length(fork_parent_head_digest) = 64 AND fork_parent_head_digest NOT GLOB '*[^a-f0-9]*')),\n  created_at INTEGER NOT NULL CHECK(created_at >= 0),\n  updated_at INTEGER NOT NULL CHECK(updated_at >= created_at),\n  CHECK((head_sequence=0) = (head_operation_sha256 IS NULL)),\n  CHECK(\n    (origin='create'\n      AND fork_child_head_sequence IS NULL\n      AND fork_child_head_operation_sha256 IS NULL\n      AND fork_child_head_digest IS NULL\n      AND fork_parent_authority_digest IS NULL\n      AND fork_parent_head_sequence IS NULL\n      AND fork_parent_head_operation_sha256 IS NULL\n      AND fork_parent_head_digest IS NULL)\n    OR\n    (origin='fork'\n      AND fork_child_head_sequence IS NOT NULL\n      AND fork_child_head_digest IS NOT NULL\n      AND ((fork_child_head_sequence=0) = (fork_child_head_operation_sha256 IS NULL))\n      AND fork_parent_authority_digest IS NOT NULL\n      AND fork_parent_authority_digest!=authority_digest\n      AND fork_parent_head_sequence IS NOT NULL\n      AND fork_parent_head_digest IS NOT NULL\n      AND ((fork_parent_head_sequence=0) = (fork_parent_head_operation_sha256 IS NULL)))\n  )\n) STRICT"
    },
    {
      "type": "table",
      "name": "message_attachments",
      "tbl_name": "message_attachments",
      "sql": "CREATE TABLE message_attachments (\n  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,\n  source_id TEXT NOT NULL CHECK(length(source_id) BETWEEN 1 AND 200),\n  position INTEGER NOT NULL CHECK(position BETWEEN 0 AND 7),\n  digest TEXT NOT NULL REFERENCES attachments(digest),\n  name TEXT NOT NULL CHECK(length(CAST(name AS BLOB)) BETWEEN 1 AND 255),\n  media_type TEXT NOT NULL CHECK(media_type IN ('image/png','image/jpeg','image/gif','image/webp','text/plain','text/markdown','text/csv','application/json')),\n  byte_length INTEGER NOT NULL CHECK(byte_length BETWEEN 1 AND 5242880),\n  created_at INTEGER NOT NULL CHECK(created_at >= 0),\n  PRIMARY KEY (session_id, source_id, position)\n) STRICT"
    },
    {
      "type": "table",
      "name": "migrations",
      "tbl_name": "migrations",
      "sql": "CREATE TABLE migrations (\n  version INTEGER PRIMARY KEY,\n  applied_at INTEGER NOT NULL CHECK(applied_at >= 0)\n) STRICT"
    },
    {
      "type": "table",
      "name": "mutation_attempts",
      "tbl_name": "mutation_attempts",
      "sql": "CREATE TABLE mutation_attempts (\n  id TEXT PRIMARY KEY CHECK(id GLOB 'attempt_[0-9a-f]*' AND length(id) = 40),\n  idempotency_key TEXT NOT NULL UNIQUE,\n  kind TEXT NOT NULL CHECK(length(kind) BETWEEN 1 AND 80),\n  authority_id TEXT NOT NULL CHECK(length(authority_id) BETWEEN 1 AND 200),\n  authority_generation INTEGER NOT NULL CHECK(authority_generation >= 0),\n  request_digest TEXT NOT NULL CHECK(length(request_digest) = 64),\n  state TEXT NOT NULL CHECK(state IN ('prepared','effect_started','applied','failed','ambiguous','cancelled')),\n  result_json TEXT,\n  created_at INTEGER NOT NULL CHECK(created_at >= 0),\n  updated_at INTEGER NOT NULL CHECK(updated_at >= created_at)\n) STRICT"
    },
    {
      "type": "table",
      "name": "mutation_effect_evidence",
      "tbl_name": "mutation_effect_evidence",
      "sql": "CREATE TABLE mutation_effect_evidence (\n  attempt_id TEXT PRIMARY KEY REFERENCES mutation_attempts(id),\n  kind TEXT NOT NULL CHECK(length(kind) BETWEEN 1 AND 80),\n  evidence_json TEXT NOT NULL CHECK(length(CAST(evidence_json AS BLOB)) BETWEEN 2 AND 262144),\n  evidence_digest TEXT NOT NULL CHECK(length(evidence_digest) = 64),\n  recorded_at INTEGER NOT NULL CHECK(recorded_at >= 0)\n) STRICT"
    },
    {
      "type": "table",
      "name": "mutation_resolutions",
      "tbl_name": "mutation_resolutions",
      "sql": "CREATE TABLE mutation_resolutions (\n  attempt_id TEXT PRIMARY KEY REFERENCES mutation_attempts(id),\n  resolution_kind TEXT NOT NULL CHECK(resolution_kind IN ('proven_applied','provider_state_reconciled','abandoned')),\n  evidence_json TEXT NOT NULL CHECK(length(CAST(evidence_json AS BLOB)) BETWEEN 2 AND 262144),\n  receipt_json TEXT CHECK(receipt_json IS NULL OR length(CAST(receipt_json AS BLOB)) <= 262144),\n  created_at INTEGER NOT NULL CHECK(created_at >= 0)\n) STRICT"
    },
    {
      "type": "table",
      "name": "notification_hours",
      "tbl_name": "notification_hours",
      "sql": "CREATE TABLE notification_hours (\n  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),\n  version INTEGER NOT NULL CHECK(version = 1),\n  revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),\n  start_minute INTEGER NOT NULL CHECK(start_minute BETWEEN 0 AND 1439),\n  end_minute INTEGER NOT NULL CHECK(end_minute BETWEEN 0 AND 1439 AND end_minute != start_minute),\n  time_zone TEXT NOT NULL CHECK(length(CAST(time_zone AS BLOB)) BETWEEN 1 AND 255),\n  created_at INTEGER NOT NULL CHECK(created_at >= 0),\n  updated_at INTEGER NOT NULL CHECK(updated_at >= created_at)\n) STRICT"
    },
    {
      "type": "table",
      "name": "peer_session_action_parents",
      "tbl_name": "peer_session_action_parents",
      "sql": "CREATE TABLE peer_session_action_parents (\n  action_id TEXT NOT NULL REFERENCES peer_session_actions(id),\n  parent_action_id TEXT NOT NULL REFERENCES peer_session_actions(id),\n  PRIMARY KEY(action_id,parent_action_id),\n  CHECK(action_id != parent_action_id)\n) STRICT"
    },
    {
      "type": "table",
      "name": "peer_session_action_roots",
      "tbl_name": "peer_session_action_roots",
      "sql": "CREATE TABLE peer_session_action_roots (\n  action_id TEXT NOT NULL REFERENCES peer_session_actions(id),\n  root_action_id TEXT NOT NULL REFERENCES peer_session_actions(id),\n  PRIMARY KEY(action_id,root_action_id)\n) STRICT"
    },
    {
      "type": "table",
      "name": "peer_session_action_visits",
      "tbl_name": "peer_session_action_visits",
      "sql": "CREATE TABLE peer_session_action_visits (\n  action_id TEXT NOT NULL REFERENCES peer_session_actions(id),\n  session_id TEXT NOT NULL REFERENCES sessions(id),\n  PRIMARY KEY(action_id,session_id)\n) STRICT"
    },
    {
      "type": "table",
      "name": "peer_session_actions",
      "tbl_name": "peer_session_actions",
      "sql": "CREATE TABLE peer_session_actions (\n  id TEXT PRIMARY KEY CHECK(id GLOB 'peer_[0-9a-f]*' AND length(id) = 37),\n  idempotency_key TEXT NOT NULL UNIQUE CHECK(length(idempotency_key) BETWEEN 1 AND 64),\n  actor_session_id TEXT NOT NULL REFERENCES sessions(id),\n  actor_turn_digest TEXT NOT NULL CHECK(length(actor_turn_digest) = 64 AND actor_turn_digest NOT GLOB '*[^a-f0-9]*'),\n  project_id TEXT NOT NULL REFERENCES projects(id),\n  actor_policy_revision INTEGER NOT NULL CHECK(actor_policy_revision BETWEEN 1 AND 9007199254740991),\n  target_session_id TEXT NOT NULL REFERENCES sessions(id),\n  target_expected_revision INTEGER NOT NULL CHECK(target_expected_revision BETWEEN 1 AND 9007199254740991),\n  target_policy_revision INTEGER NOT NULL CHECK(target_policy_revision BETWEEN 1 AND 9007199254740991),\n  delivery TEXT NOT NULL CHECK(delivery IN ('send','queue','steer')),\n  request_digest TEXT NOT NULL CHECK(length(request_digest) = 64 AND request_digest NOT GLOB '*[^a-f0-9]*'),\n  message_digest TEXT NOT NULL CHECK(length(message_digest) = 64 AND message_digest NOT GLOB '*[^a-f0-9]*'),\n  reason_digest TEXT NOT NULL CHECK(length(reason_digest) = 64 AND reason_digest NOT GLOB '*[^a-f0-9]*'),\n  state TEXT NOT NULL CHECK(state IN ('prepared','queued','effect_started','applied','failed','ambiguous','cancelled')),\n  hop INTEGER NOT NULL CHECK(hop BETWEEN 1 AND 8),\n  target_turn_digest TEXT CHECK(target_turn_digest IS NULL OR (length(target_turn_digest) = 64 AND target_turn_digest NOT GLOB '*[^a-f0-9]*')),\n  result_digest TEXT CHECK(result_digest IS NULL OR (length(result_digest) = 64 AND result_digest NOT GLOB '*[^a-f0-9]*')),\n  created_at INTEGER NOT NULL CHECK(created_at >= 0),\n  updated_at INTEGER NOT NULL CHECK(updated_at >= created_at),\n  CHECK(actor_session_id != target_session_id),\n  CHECK((state = 'applied') = (target_turn_digest IS NOT NULL))\n) STRICT"
    },
    {
      "type": "table",
      "name": "peer_session_direct_message_sources",
      "tbl_name": "peer_session_direct_message_sources",
      "sql": "CREATE TABLE peer_session_direct_message_sources (\n  idempotency_key TEXT PRIMARY KEY CHECK(length(idempotency_key) = 36),\n  action_id TEXT NOT NULL UNIQUE CHECK(action_id GLOB 'peer_[0-9a-f]*' AND length(action_id) = 37),\n  actor_session_id TEXT NOT NULL CHECK(actor_session_id GLOB 'sess_[0-9a-f]*' AND length(actor_session_id) = 37),\n  actor_turn_digest TEXT NOT NULL CHECK(length(actor_turn_digest) = 64 AND actor_turn_digest NOT GLOB '*[^a-f0-9]*'),\n  project_id TEXT NOT NULL CHECK(project_id GLOB 'proj_[0-9a-f]*' AND length(project_id) = 37),\n  target_session_id TEXT NOT NULL CHECK(target_session_id GLOB 'sess_[0-9a-f]*' AND length(target_session_id) = 37),\n  target_expected_revision INTEGER NOT NULL CHECK(target_expected_revision BETWEEN 1 AND 9007199254740991),\n  delivery TEXT NOT NULL CHECK(delivery IN ('send','steer')),\n  request_digest TEXT NOT NULL CHECK(length(request_digest) = 64 AND request_digest NOT GLOB '*[^a-f0-9]*'),\n  message_digest TEXT NOT NULL CHECK(length(message_digest) = 64 AND message_digest NOT GLOB '*[^a-f0-9]*'),\n  reason_digest TEXT NOT NULL CHECK(length(reason_digest) = 64 AND reason_digest NOT GLOB '*[^a-f0-9]*'),\n  created_at INTEGER NOT NULL CHECK(created_at >= 0),\n  CHECK(actor_session_id != target_session_id)\n) STRICT"
    },
    {
      "type": "table",
      "name": "peer_session_turn_origins",
      "tbl_name": "peer_session_turn_origins",
      "sql": "CREATE TABLE peer_session_turn_origins (\n  session_id TEXT NOT NULL REFERENCES sessions(id),\n  turn_digest TEXT NOT NULL CHECK(length(turn_digest) = 64 AND turn_digest NOT GLOB '*[^a-f0-9]*'),\n  action_id TEXT NOT NULL REFERENCES peer_session_actions(id),\n  PRIMARY KEY(session_id,turn_digest,action_id)\n) STRICT"
    },
    {
      "type": "table",
      "name": "profile_personal_authority_revocations",
      "tbl_name": "profile_personal_authority_revocations",
      "sql": "CREATE TABLE profile_personal_authority_revocations (\n  profile_id TEXT PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,\n  profile_generation INTEGER NOT NULL CHECK(profile_generation BETWEEN 0 AND 9007199254740991),\n  state TEXT NOT NULL CHECK(state IN ('releasing','completed')),\n  revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),\n  created_at INTEGER NOT NULL CHECK(created_at >= 0),\n  updated_at INTEGER NOT NULL CHECK(updated_at >= created_at),\n  completed_at INTEGER CHECK(completed_at IS NULL OR completed_at >= created_at),\n  CHECK((state='completed')=(completed_at IS NOT NULL))\n) STRICT"
    },
    {
      "type": "table",
      "name": "profiles",
      "tbl_name": "profiles",
      "sql": "CREATE TABLE profiles (\n  id TEXT PRIMARY KEY CHECK(id GLOB 'acct_[0-9a-f]*' AND length(id) = 37),\n  label TEXT NOT NULL CHECK(length(label) BETWEEN 1 AND 160),\n  state TEXT NOT NULL CHECK(state IN ('signed_out','login_pending','signed_in','recovery_required','removed')),\n  process_generation INTEGER NOT NULL CHECK(process_generation >= 0),\n  provider_email TEXT,\n  provider_plan TEXT,\n  created_at INTEGER NOT NULL CHECK(created_at >= 0),\n  updated_at INTEGER NOT NULL CHECK(updated_at >= created_at)\n, codex_account_key TEXT CHECK(\n  codex_account_key IS NULL OR (\n    length(codex_account_key)=73\n    AND substr(codex_account_key,1,9)='v1:codex:'\n    AND substr(codex_account_key,10) NOT GLOB '*[^0-9a-f]*'\n  )\n), label_key TEXT) STRICT"
    },
    {
      "type": "table",
      "name": "project_approval_modes",
      "tbl_name": "project_approval_modes",
      "sql": "CREATE TABLE project_approval_modes (\n  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,\n  mode TEXT NOT NULL CHECK(mode IN ('auto:all','auto:workspace','manual')),\n  updated_at INTEGER NOT NULL CHECK(updated_at >= 0)\n) STRICT"
    },
    {
      "type": "table",
      "name": "project_memory_authorities",
      "tbl_name": "project_memory_authorities",
      "sql": "CREATE TABLE project_memory_authorities (\n  project_id TEXT PRIMARY KEY REFERENCES projects(id),\n  identity_contract INTEGER NOT NULL CHECK(identity_contract IN (1,2)),\n  canonical_space_id TEXT NOT NULL CHECK(\n    (\n      identity_contract=1\n      AND length(canonical_space_id)=76\n      AND canonical_space_id GLOB 'oompa:project:*'\n      AND substr(canonical_space_id,13) NOT GLOB '*[^a-f0-9]*'\n    ) OR (\n      identity_contract=2\n      AND length(canonical_space_id)=50\n      AND canonical_space_id GLOB 'oompa:project:space-*'\n      AND substr(canonical_space_id,19) NOT GLOB '*[^a-f0-9]*'\n    )\n  ),\n  physical_state TEXT NOT NULL CHECK(physical_state IN ('reserved','initialized','rejected')),\n  initialized_at INTEGER CHECK(initialized_at IS NULL OR initialized_at >= 0),\n  authority_digest TEXT NOT NULL CHECK(length(authority_digest) = 64 AND authority_digest NOT GLOB '*[^a-f0-9]*'),\n  binding_digest TEXT NOT NULL CHECK(length(binding_digest) = 64 AND binding_digest NOT GLOB '*[^a-f0-9]*'),\n  head_sequence INTEGER NOT NULL CHECK(head_sequence BETWEEN 0 AND 9007199254740991),\n  head_operation_sha256 TEXT CHECK(head_operation_sha256 IS NULL OR (length(head_operation_sha256) = 64 AND head_operation_sha256 NOT GLOB '*[^a-f0-9]*')),\n  head_digest TEXT NOT NULL CHECK(length(head_digest) = 64 AND head_digest NOT GLOB '*[^a-f0-9]*'),\n  revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),\n  sync_state TEXT NOT NULL CHECK(sync_state IN ('local_only','settled','conflict','error')),\n  last_exchange_at INTEGER CHECK(last_exchange_at IS NULL OR last_exchange_at >= 0),\n  last_exchange_sequence INTEGER CHECK(last_exchange_sequence IS NULL OR last_exchange_sequence BETWEEN 0 AND 9007199254740991),\n  last_exchange_operation_sha256 TEXT CHECK(last_exchange_operation_sha256 IS NULL OR (length(last_exchange_operation_sha256) = 64 AND last_exchange_operation_sha256 NOT GLOB '*[^a-f0-9]*')),\n  last_exchange_head_digest TEXT CHECK(last_exchange_head_digest IS NULL OR (length(last_exchange_head_digest) = 64 AND last_exchange_head_digest NOT GLOB '*[^a-f0-9]*')),\n  diagnostic_code TEXT CHECK(\n    diagnostic_code IS NULL\n    OR (\n      diagnostic_code GLOB '[A-Z]*'\n      AND diagnostic_code NOT GLOB '*[^A-Z0-9_]*'\n      AND length(diagnostic_code) BETWEEN 1 AND 80\n    )\n  ),\n  created_at INTEGER NOT NULL CHECK(created_at >= 0),\n  updated_at INTEGER NOT NULL CHECK(updated_at >= created_at),\n  CHECK((physical_state='initialized') = (initialized_at IS NOT NULL)),\n  CHECK(initialized_at IS NULL OR (initialized_at >= created_at AND initialized_at <= updated_at)),\n  CHECK((head_sequence = 0) = (head_operation_sha256 IS NULL)),\n  CHECK(head_sequence != 0 OR head_digest = '1c90ceacb79d163e060443b4db9a02561059971c063558963df0794ecfbbde85'),\n  CHECK(\n    (last_exchange_at IS NULL) = (last_exchange_sequence IS NULL)\n    AND (last_exchange_at IS NULL) = (last_exchange_head_digest IS NULL)\n    AND (last_exchange_sequence IS NOT NULL OR last_exchange_operation_sha256 IS NULL)\n    AND (\n      last_exchange_sequence IS NULL\n      OR ((last_exchange_sequence = 0) = (last_exchange_operation_sha256 IS NULL))\n    )\n  ),\n  CHECK(\n    last_exchange_sequence IS NULL\n    OR last_exchange_sequence != 0\n    OR last_exchange_head_digest = '1c90ceacb79d163e060443b4db9a02561059971c063558963df0794ecfbbde85'\n  ),\n  CHECK((sync_state IN ('conflict','error')) = (diagnostic_code IS NOT NULL)),\n  CHECK(\n    physical_state!='reserved'\n    OR (\n      head_sequence=0\n      AND head_operation_sha256 IS NULL\n      AND head_digest='1c90ceacb79d163e060443b4db9a02561059971c063558963df0794ecfbbde85'\n      AND sync_state='local_only'\n      AND last_exchange_at IS NULL\n      AND last_exchange_sequence IS NULL\n      AND last_exchange_operation_sha256 IS NULL\n      AND last_exchange_head_digest IS NULL\n      AND diagnostic_code IS NULL\n    )\n  ),\n  CHECK(\n    physical_state!='rejected'\n    OR (\n      initialized_at IS NULL\n      AND head_sequence=0\n      AND head_operation_sha256 IS NULL\n      AND head_digest='1c90ceacb79d163e060443b4db9a02561059971c063558963df0794ecfbbde85'\n      AND sync_state='error'\n      AND last_exchange_at IS NULL\n      AND last_exchange_sequence IS NULL\n      AND last_exchange_operation_sha256 IS NULL\n      AND last_exchange_head_digest IS NULL\n      AND diagnostic_code IS NOT NULL\n    )\n  ),\n  CHECK(\n    sync_state != 'settled'\n    OR (\n      last_exchange_at IS NOT NULL\n      AND last_exchange_sequence=head_sequence\n      AND last_exchange_operation_sha256 IS head_operation_sha256\n      AND last_exchange_head_digest=head_digest\n    )\n  )\n) STRICT"
    },
    {
      "type": "table",
      "name": "project_memory_hosted_attachments",
      "tbl_name": "project_memory_hosted_attachments",
      "sql": "CREATE TABLE project_memory_hosted_attachments (\n  project_id TEXT PRIMARY KEY REFERENCES project_memory_authorities(project_id),\n  remote_space_id TEXT NOT NULL UNIQUE CHECK(\n    length(remote_space_id)=39\n    AND remote_space_id GLOB 'memory_[A-Za-z0-9_-]*'\n    AND remote_space_id NOT GLOB '*[^A-Za-z0-9_-]*'\n  ),\n  account_binding_digest TEXT NOT NULL CHECK(length(account_binding_digest)=64 AND account_binding_digest NOT GLOB '*[^a-f0-9]*'),\n  canonical_binding_digest TEXT NOT NULL CHECK(length(canonical_binding_digest)=64 AND canonical_binding_digest NOT GLOB '*[^a-f0-9]*'),\n  generation INTEGER NOT NULL CHECK(generation BETWEEN 1 AND 9007199254740991),\n  revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),\n  state TEXT NOT NULL CHECK(state IN ('attached','detached','conflict','error')),\n  genesis_token TEXT NOT NULL CHECK(length(genesis_token)=64 AND genesis_token NOT GLOB '*[^a-f0-9]*'),\n  remote_revision INTEGER NOT NULL CHECK(remote_revision BETWEEN 1 AND 9007199254740991),\n  remote_key_version INTEGER NOT NULL CHECK(remote_key_version BETWEEN 1 AND 9007199254740991),\n  remote_head_sequence INTEGER NOT NULL CHECK(remote_head_sequence BETWEEN 0 AND 9007199254740991),\n  remote_head_operation_sha256 TEXT CHECK(remote_head_operation_sha256 IS NULL OR (length(remote_head_operation_sha256)=64 AND remote_head_operation_sha256 NOT GLOB '*[^a-f0-9]*')),\n  remote_head_digest TEXT NOT NULL CHECK(length(remote_head_digest)=64 AND remote_head_digest NOT GLOB '*[^a-f0-9]*'),\n  remote_head_token TEXT NOT NULL CHECK(length(remote_head_token)=64 AND remote_head_token NOT GLOB '*[^a-f0-9]*'),\n  remote_head_proof_digest TEXT NOT NULL CHECK(length(remote_head_proof_digest)=64 AND remote_head_proof_digest NOT GLOB '*[^a-f0-9]*'),\n  diagnostic_code TEXT CHECK(diagnostic_code IS NULL OR (\n    diagnostic_code GLOB '[A-Z]*'\n    AND diagnostic_code NOT GLOB '*[^A-Z0-9_]*'\n    AND length(diagnostic_code) BETWEEN 1 AND 80\n  )),\n  created_at INTEGER NOT NULL CHECK(created_at>=0),\n  updated_at INTEGER NOT NULL CHECK(updated_at>=created_at),\n  CHECK((remote_head_sequence=0)=(remote_head_operation_sha256 IS NULL)),\n  CHECK(remote_head_sequence!=0 OR remote_head_digest='1c90ceacb79d163e060443b4db9a02561059971c063558963df0794ecfbbde85'),\n  CHECK((remote_head_sequence=0 AND remote_head_token=genesis_token)\n     OR (remote_head_sequence>0 AND remote_head_token!=genesis_token)),\n  CHECK((state IN ('conflict','error'))=(diagnostic_code IS NOT NULL))\n) STRICT"
    },
    {
      "type": "table",
      "name": "project_memory_hosted_create_intents",
      "tbl_name": "project_memory_hosted_create_intents",
      "sql": "CREATE TABLE project_memory_hosted_create_intents (\n  id TEXT PRIMARY KEY CHECK(id GLOB 'cmcreate_[0-9a-f]*' AND length(id)=41),\n  idempotency_key TEXT NOT NULL UNIQUE CHECK(length(idempotency_key)=36),\n  project_id TEXT NOT NULL REFERENCES project_memory_authorities(project_id),\n  state TEXT NOT NULL CHECK(state IN (\n    'allocating','key_staged','prepared','effect_started','winner_observed',\n    'settled','conflict','error'\n  )),\n  authority_revision INTEGER NOT NULL CHECK(authority_revision BETWEEN 1 AND 9007199254740991),\n  canonical_binding_digest TEXT NOT NULL CHECK(length(canonical_binding_digest)=64 AND canonical_binding_digest NOT GLOB '*[^a-f0-9]*'),\n  authority_head_sequence INTEGER NOT NULL CHECK(authority_head_sequence BETWEEN 0 AND 9007199254740991),\n  authority_head_operation_sha256 TEXT CHECK(authority_head_operation_sha256 IS NULL OR (length(authority_head_operation_sha256)=64 AND authority_head_operation_sha256 NOT GLOB '*[^a-f0-9]*')),\n  authority_head_digest TEXT NOT NULL CHECK(length(authority_head_digest)=64 AND authority_head_digest NOT GLOB '*[^a-f0-9]*'),\n  account_binding_digest TEXT NOT NULL CHECK(length(account_binding_digest)=64 AND account_binding_digest NOT GLOB '*[^a-f0-9]*'),\n  remote_space_id TEXT NOT NULL CHECK(\n    length(remote_space_id)=39\n    AND remote_space_id GLOB 'memory_[A-Za-z0-9_-]*'\n    AND remote_space_id NOT GLOB '*[^A-Za-z0-9_-]*'\n  ),\n  space_key_version INTEGER CHECK(space_key_version IS NULL OR space_key_version BETWEEN 1 AND 9007199254740991),\n  wrapped_key_algorithm TEXT CHECK(wrapped_key_algorithm IS NULL OR wrapped_key_algorithm='A256GCM'),\n  wrapped_key_ciphertext TEXT CHECK(wrapped_key_ciphertext IS NULL OR (\n    length(wrapped_key_ciphertext) BETWEEN 22 AND 16384\n    AND wrapped_key_ciphertext NOT GLOB '*[^A-Za-z0-9_-]*'\n  )),\n  wrapped_key_version INTEGER CHECK(wrapped_key_version IS NULL OR wrapped_key_version BETWEEN 1 AND 9007199254740991),\n  wrapped_key_nonce TEXT CHECK(wrapped_key_nonce IS NULL OR (\n    length(wrapped_key_nonce)=16 AND wrapped_key_nonce NOT GLOB '*[^A-Za-z0-9_-]*'\n  )),\n  descriptor_algorithm TEXT CHECK(descriptor_algorithm IS NULL OR descriptor_algorithm='A256GCM'),\n  descriptor_ciphertext TEXT CHECK(descriptor_ciphertext IS NULL OR (\n    length(descriptor_ciphertext) BETWEEN 22 AND 16384\n    AND descriptor_ciphertext NOT GLOB '*[^A-Za-z0-9_-]*'\n  )),\n  descriptor_key_version INTEGER CHECK(descriptor_key_version IS NULL OR descriptor_key_version BETWEEN 1 AND 9007199254740991),\n  descriptor_nonce TEXT CHECK(descriptor_nonce IS NULL OR (\n    length(descriptor_nonce)=16 AND descriptor_nonce NOT GLOB '*[^A-Za-z0-9_-]*'\n  )),\n  genesis_proof_algorithm TEXT CHECK(genesis_proof_algorithm IS NULL OR genesis_proof_algorithm='A256GCM'),\n  genesis_proof_ciphertext TEXT CHECK(genesis_proof_ciphertext IS NULL OR (\n    length(genesis_proof_ciphertext) BETWEEN 22 AND 16384\n    AND genesis_proof_ciphertext NOT GLOB '*[^A-Za-z0-9_-]*'\n  )),\n  genesis_proof_key_version INTEGER CHECK(genesis_proof_key_version IS NULL OR genesis_proof_key_version BETWEEN 1 AND 9007199254740991),\n  genesis_proof_nonce TEXT CHECK(genesis_proof_nonce IS NULL OR (\n    length(genesis_proof_nonce)=16 AND genesis_proof_nonce NOT GLOB '*[^A-Za-z0-9_-]*'\n  )),\n  genesis_token TEXT CHECK(genesis_token IS NULL OR (length(genesis_token)=64 AND genesis_token NOT GLOB '*[^a-f0-9]*')),\n  request_digest TEXT CHECK(request_digest IS NULL OR (length(request_digest)=64 AND request_digest NOT GLOB '*[^a-f0-9]*')),\n  effect_started_at INTEGER CHECK(effect_started_at IS NULL OR effect_started_at>=created_at),\n  winner_digest TEXT CHECK(winner_digest IS NULL OR (length(winner_digest)=64 AND winner_digest NOT GLOB '*[^a-f0-9]*')),\n  winner_revision INTEGER CHECK(winner_revision IS NULL OR winner_revision BETWEEN 1 AND 9007199254740991),\n  winner_replay INTEGER CHECK(winner_replay IS NULL OR winner_replay IN (0,1)),\n  winner_observed_at INTEGER CHECK(winner_observed_at IS NULL OR (\n    effect_started_at IS NOT NULL AND winner_observed_at>=effect_started_at\n  )),\n  settled_at INTEGER CHECK(settled_at IS NULL OR settled_at>=created_at),\n  diagnostic_code TEXT CHECK(diagnostic_code IS NULL OR (\n    diagnostic_code GLOB '[A-Z]*'\n    AND diagnostic_code NOT GLOB '*[^A-Z0-9_]*'\n    AND length(diagnostic_code) BETWEEN 1 AND 80\n  )),\n  created_at INTEGER NOT NULL CHECK(created_at>=0),\n  updated_at INTEGER NOT NULL CHECK(updated_at>=created_at),\n  CHECK((authority_head_sequence=0)=(authority_head_operation_sha256 IS NULL)),\n  CHECK(authority_head_sequence!=0 OR authority_head_digest='1c90ceacb79d163e060443b4db9a02561059971c063558963df0794ecfbbde85'),\n  CHECK(\n    (space_key_version IS NULL AND wrapped_key_algorithm IS NULL\n      AND wrapped_key_ciphertext IS NULL AND wrapped_key_version IS NULL\n      AND wrapped_key_nonce IS NULL)\n    OR\n    (space_key_version IS NOT NULL AND wrapped_key_algorithm IS NOT NULL\n      AND wrapped_key_ciphertext IS NOT NULL AND wrapped_key_version IS NOT NULL\n      AND wrapped_key_nonce IS NOT NULL)\n  ),\n  CHECK(\n    (descriptor_algorithm IS NULL AND descriptor_ciphertext IS NULL\n      AND descriptor_key_version IS NULL AND descriptor_nonce IS NULL\n      AND genesis_proof_algorithm IS NULL AND genesis_proof_ciphertext IS NULL\n      AND genesis_proof_key_version IS NULL AND genesis_proof_nonce IS NULL\n      AND genesis_token IS NULL AND request_digest IS NULL)\n    OR\n    (space_key_version IS NOT NULL AND descriptor_algorithm IS NOT NULL\n      AND descriptor_ciphertext IS NOT NULL AND descriptor_key_version=space_key_version\n      AND descriptor_nonce IS NOT NULL AND genesis_proof_algorithm IS NOT NULL\n      AND genesis_proof_ciphertext IS NOT NULL\n      AND genesis_proof_key_version=space_key_version\n      AND genesis_proof_nonce IS NOT NULL AND genesis_token IS NOT NULL\n      AND request_digest IS NOT NULL)\n  ),\n  CHECK(\n    (winner_digest IS NULL AND winner_revision IS NULL\n      AND winner_replay IS NULL AND winner_observed_at IS NULL)\n    OR\n    (request_digest IS NOT NULL AND effect_started_at IS NOT NULL\n      AND winner_digest IS NOT NULL AND winner_revision IS NOT NULL\n      AND winner_replay IS NOT NULL AND winner_observed_at IS NOT NULL)\n  ),\n  CHECK(effect_started_at IS NULL OR request_digest IS NOT NULL),\n  CHECK((state IN ('settled','conflict','error'))=(settled_at IS NOT NULL)),\n  CHECK((state IN ('conflict','error'))=(diagnostic_code IS NOT NULL)),\n  CHECK(\n    (state='allocating' AND space_key_version IS NULL)\n    OR (state='key_staged' AND space_key_version IS NOT NULL AND request_digest IS NULL)\n    OR (state='prepared' AND request_digest IS NOT NULL AND effect_started_at IS NULL)\n    OR (state='effect_started' AND effect_started_at IS NOT NULL AND winner_digest IS NULL)\n    OR (state='winner_observed' AND winner_digest IS NOT NULL)\n    OR (state='settled' AND winner_digest IS NOT NULL)\n    OR state IN ('conflict','error')\n  )\n) STRICT"
    },
    {
      "type": "table",
      "name": "project_memory_portable_adoption_proofs",
      "tbl_name": "project_memory_portable_adoption_proofs",
      "sql": "CREATE TABLE project_memory_portable_adoption_proofs (\n  project_id TEXT NOT NULL REFERENCES project_memory_authorities(project_id),\n  canonical_space_id TEXT NOT NULL CHECK(\n    length(canonical_space_id)=50\n    AND canonical_space_id GLOB 'oompa:project:space-*'\n    AND substr(canonical_space_id,19) NOT GLOB '*[^a-f0-9]*'\n  ),\n  canonical_binding_digest TEXT NOT NULL CHECK(length(canonical_binding_digest)=64 AND canonical_binding_digest NOT GLOB '*[^a-f0-9]*'),\n  sequence INTEGER NOT NULL CHECK(sequence BETWEEN 1 AND 9007199254740991),\n  operation_sha256 TEXT NOT NULL CHECK(length(operation_sha256)=64 AND operation_sha256 NOT GLOB '*[^a-f0-9]*'),\n  record_sha256 TEXT NOT NULL CHECK(length(record_sha256)=64 AND record_sha256 NOT GLOB '*[^a-f0-9]*'),\n  key_digest TEXT NOT NULL CHECK(length(key_digest)=64 AND key_digest NOT GLOB '*[^a-f0-9]*'),\n  content_digest TEXT NOT NULL CHECK(length(content_digest)=64 AND content_digest NOT GLOB '*[^a-f0-9]*'),\n  source_receipt_sha256 TEXT NOT NULL CHECK(length(source_receipt_sha256)=64 AND source_receipt_sha256 NOT GLOB '*[^a-f0-9]*'),\n  created_at INTEGER NOT NULL CHECK(created_at>=0),\n  PRIMARY KEY(project_id,operation_sha256),\n  UNIQUE(project_id,sequence)\n) STRICT"
    },
    {
      "type": "table",
      "name": "project_memory_sync_intents",
      "tbl_name": "project_memory_sync_intents",
      "sql": "CREATE TABLE project_memory_sync_intents (\n  id TEXT PRIMARY KEY CHECK(id GLOB 'cmsync_[0-9a-f]*' AND length(id)=39),\n  idempotency_key TEXT NOT NULL UNIQUE CHECK(length(idempotency_key)=36),\n  project_id TEXT NOT NULL REFERENCES project_memory_hosted_attachments(project_id),\n  direction TEXT NOT NULL CHECK(direction IN ('pull','push')),\n  state TEXT NOT NULL CHECK(state IN ('prepared','effect_started','response_observed','settled','conflict','error')),\n  attachment_generation INTEGER NOT NULL CHECK(attachment_generation BETWEEN 1 AND 9007199254740991),\n  attachment_revision INTEGER NOT NULL CHECK(attachment_revision BETWEEN 1 AND 9007199254740991),\n  authority_revision INTEGER NOT NULL CHECK(authority_revision BETWEEN 1 AND 9007199254740991),\n  canonical_binding_digest TEXT NOT NULL CHECK(length(canonical_binding_digest)=64 AND canonical_binding_digest NOT GLOB '*[^a-f0-9]*'),\n  local_head_sequence INTEGER NOT NULL CHECK(local_head_sequence BETWEEN 0 AND 9007199254740991),\n  local_head_operation_sha256 TEXT CHECK(local_head_operation_sha256 IS NULL OR (length(local_head_operation_sha256)=64 AND local_head_operation_sha256 NOT GLOB '*[^a-f0-9]*')),\n  local_head_digest TEXT NOT NULL CHECK(length(local_head_digest)=64 AND local_head_digest NOT GLOB '*[^a-f0-9]*'),\n  local_head_token TEXT NOT NULL CHECK(length(local_head_token)=64 AND local_head_token NOT GLOB '*[^a-f0-9]*'),\n  remote_genesis_token TEXT NOT NULL CHECK(length(remote_genesis_token)=64 AND remote_genesis_token NOT GLOB '*[^a-f0-9]*'),\n  remote_revision INTEGER NOT NULL CHECK(remote_revision BETWEEN 1 AND 9007199254740991),\n  remote_key_version INTEGER NOT NULL CHECK(remote_key_version BETWEEN 1 AND 9007199254740991),\n  remote_head_sequence INTEGER NOT NULL CHECK(remote_head_sequence BETWEEN 0 AND 9007199254740991),\n  remote_head_operation_sha256 TEXT CHECK(remote_head_operation_sha256 IS NULL OR (length(remote_head_operation_sha256)=64 AND remote_head_operation_sha256 NOT GLOB '*[^a-f0-9]*')),\n  remote_head_digest TEXT NOT NULL CHECK(length(remote_head_digest)=64 AND remote_head_digest NOT GLOB '*[^a-f0-9]*'),\n  remote_head_token TEXT NOT NULL CHECK(length(remote_head_token)=64 AND remote_head_token NOT GLOB '*[^a-f0-9]*'),\n  remote_head_proof_digest TEXT NOT NULL CHECK(length(remote_head_proof_digest)=64 AND remote_head_proof_digest NOT GLOB '*[^a-f0-9]*'),\n  request_digest TEXT NOT NULL CHECK(length(request_digest)=64 AND request_digest NOT GLOB '*[^a-f0-9]*'),\n  effect_started_at INTEGER CHECK(effect_started_at IS NULL OR effect_started_at>=created_at),\n  response_digest TEXT CHECK(response_digest IS NULL OR (length(response_digest)=64 AND response_digest NOT GLOB '*[^a-f0-9]*')),\n  response_genesis_token TEXT CHECK(response_genesis_token IS NULL OR (length(response_genesis_token)=64 AND response_genesis_token NOT GLOB '*[^a-f0-9]*')),\n  response_revision INTEGER CHECK(response_revision IS NULL OR response_revision BETWEEN 1 AND 9007199254740991),\n  response_key_version INTEGER CHECK(response_key_version IS NULL OR response_key_version BETWEEN 1 AND 9007199254740991),\n  response_head_sequence INTEGER CHECK(response_head_sequence IS NULL OR response_head_sequence BETWEEN 0 AND 9007199254740991),\n  response_head_operation_sha256 TEXT CHECK(response_head_operation_sha256 IS NULL OR (length(response_head_operation_sha256)=64 AND response_head_operation_sha256 NOT GLOB '*[^a-f0-9]*')),\n  response_head_digest TEXT CHECK(response_head_digest IS NULL OR (length(response_head_digest)=64 AND response_head_digest NOT GLOB '*[^a-f0-9]*')),\n  response_head_token TEXT CHECK(response_head_token IS NULL OR (length(response_head_token)=64 AND response_head_token NOT GLOB '*[^a-f0-9]*')),\n  response_head_proof_digest TEXT CHECK(response_head_proof_digest IS NULL OR (length(response_head_proof_digest)=64 AND response_head_proof_digest NOT GLOB '*[^a-f0-9]*')),\n  response_observed_at INTEGER CHECK(response_observed_at IS NULL OR response_observed_at>=created_at),\n  result_head_sequence INTEGER CHECK(result_head_sequence IS NULL OR result_head_sequence BETWEEN 0 AND 9007199254740991),\n  result_head_operation_sha256 TEXT CHECK(result_head_operation_sha256 IS NULL OR (length(result_head_operation_sha256)=64 AND result_head_operation_sha256 NOT GLOB '*[^a-f0-9]*')),\n  result_head_digest TEXT CHECK(result_head_digest IS NULL OR (length(result_head_digest)=64 AND result_head_digest NOT GLOB '*[^a-f0-9]*')),\n  settled_at INTEGER CHECK(settled_at IS NULL OR settled_at>=created_at),\n  diagnostic_code TEXT CHECK(diagnostic_code IS NULL OR (\n    diagnostic_code GLOB '[A-Z]*'\n    AND diagnostic_code NOT GLOB '*[^A-Z0-9_]*'\n    AND length(diagnostic_code) BETWEEN 1 AND 80\n  )),\n  created_at INTEGER NOT NULL CHECK(created_at>=0),\n  updated_at INTEGER NOT NULL CHECK(updated_at>=created_at),\n  CHECK((local_head_sequence=0)=(local_head_operation_sha256 IS NULL)),\n  CHECK(local_head_sequence!=0 OR local_head_digest='1c90ceacb79d163e060443b4db9a02561059971c063558963df0794ecfbbde85'),\n  CHECK((local_head_sequence=0 AND local_head_token=remote_genesis_token)\n     OR (local_head_sequence>0 AND local_head_token!=remote_genesis_token)),\n  CHECK((remote_head_sequence=0)=(remote_head_operation_sha256 IS NULL)),\n  CHECK(remote_head_sequence!=0 OR remote_head_digest='1c90ceacb79d163e060443b4db9a02561059971c063558963df0794ecfbbde85'),\n  CHECK((remote_head_sequence=0 AND remote_head_token=remote_genesis_token)\n     OR (remote_head_sequence>0 AND remote_head_token!=remote_genesis_token)),\n  CHECK((direction='push' AND local_head_sequence>remote_head_sequence)\n     OR (direction='pull' AND local_head_sequence<=remote_head_sequence)),\n  CHECK(\n    (response_digest IS NULL AND response_genesis_token IS NULL\n      AND response_revision IS NULL AND response_key_version IS NULL\n      AND response_head_sequence IS NULL AND response_head_operation_sha256 IS NULL\n      AND response_head_digest IS NULL AND response_head_token IS NULL\n      AND response_head_proof_digest IS NULL AND response_observed_at IS NULL)\n    OR\n    (response_digest IS NOT NULL AND response_genesis_token IS NOT NULL\n      AND response_revision IS NOT NULL AND response_key_version IS NOT NULL\n      AND response_head_sequence IS NOT NULL AND response_head_digest IS NOT NULL\n      AND response_head_token IS NOT NULL AND response_head_proof_digest IS NOT NULL\n      AND response_observed_at IS NOT NULL\n      AND ((response_head_sequence=0)=(response_head_operation_sha256 IS NULL))\n      AND (response_head_sequence!=0 OR response_head_digest='1c90ceacb79d163e060443b4db9a02561059971c063558963df0794ecfbbde85')\n      AND ((response_head_sequence=0 AND response_head_token=response_genesis_token)\n        OR (response_head_sequence>0 AND response_head_token!=response_genesis_token)))\n  ),\n  CHECK(\n    (result_head_sequence IS NULL AND result_head_operation_sha256 IS NULL AND result_head_digest IS NULL)\n    OR\n    (result_head_sequence IS NOT NULL AND result_head_digest IS NOT NULL\n      AND ((result_head_sequence=0)=(result_head_operation_sha256 IS NULL))\n      AND (result_head_sequence!=0 OR result_head_digest='1c90ceacb79d163e060443b4db9a02561059971c063558963df0794ecfbbde85'))\n  ),\n  CHECK(\n    (state='prepared' AND effect_started_at IS NULL AND response_digest IS NULL\n      AND result_head_sequence IS NULL AND settled_at IS NULL AND diagnostic_code IS NULL)\n    OR\n    (state='effect_started' AND effect_started_at IS NOT NULL AND response_digest IS NULL\n      AND result_head_sequence IS NULL AND settled_at IS NULL AND diagnostic_code IS NULL)\n    OR\n    (state='response_observed' AND effect_started_at IS NOT NULL AND response_digest IS NOT NULL\n      AND (direction='pull' OR result_head_sequence IS NULL)\n      AND settled_at IS NULL AND diagnostic_code IS NULL)\n    OR\n    (state='settled' AND effect_started_at IS NOT NULL AND response_digest IS NOT NULL\n      AND result_head_sequence IS NOT NULL AND settled_at IS NOT NULL AND diagnostic_code IS NULL)\n    OR\n    (state IN ('conflict','error') AND effect_started_at IS NOT NULL\n      AND (direction='pull' OR result_head_sequence IS NULL)\n      AND settled_at IS NOT NULL AND diagnostic_code IS NOT NULL)\n  ),\n  CHECK(effect_started_at IS NULL OR effect_started_at<=updated_at),\n  CHECK(response_observed_at IS NULL OR (response_observed_at>=effect_started_at AND response_observed_at<=updated_at)),\n  CHECK(settled_at IS NULL OR (settled_at>=effect_started_at AND settled_at<=updated_at))\n) STRICT"
    },
    {
      "type": "table",
      "name": "project_memory_sync_spool",
      "tbl_name": "project_memory_sync_spool",
      "sql": "CREATE TABLE project_memory_sync_spool (\n  intent_id TEXT NOT NULL REFERENCES project_memory_sync_intents(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,\n  phase TEXT NOT NULL CHECK(phase IN ('request','response')),\n  genesis_token TEXT NOT NULL CHECK(length(genesis_token)=64 AND genesis_token NOT GLOB '*[^a-f0-9]*'),\n  prior_token TEXT NOT NULL CHECK(length(prior_token)=64 AND prior_token NOT GLOB '*[^a-f0-9]*'),\n  head_token TEXT NOT NULL CHECK(length(head_token)=64 AND head_token NOT GLOB '*[^a-f0-9]*'),\n  sequence INTEGER NOT NULL CHECK(sequence BETWEEN 1 AND 9007199254740991),\n  adoption_proof_algorithm TEXT CHECK(adoption_proof_algorithm IS NULL OR adoption_proof_algorithm='A256GCM'),\n  adoption_proof_ciphertext TEXT CHECK(adoption_proof_ciphertext IS NULL OR (\n    length(adoption_proof_ciphertext) BETWEEN 22 AND 8192\n    AND adoption_proof_ciphertext NOT GLOB '*[^A-Za-z0-9_-]*'\n  )),\n  adoption_proof_key_version INTEGER CHECK(adoption_proof_key_version IS NULL OR adoption_proof_key_version BETWEEN 1 AND 9007199254740991),\n  adoption_proof_nonce TEXT CHECK(adoption_proof_nonce IS NULL OR (\n    length(adoption_proof_nonce)=16 AND adoption_proof_nonce NOT GLOB '*[^A-Za-z0-9_-]*'\n  )),\n  operation_algorithm TEXT NOT NULL CHECK(operation_algorithm='A256GCM'),\n  operation_ciphertext TEXT NOT NULL CHECK(\n    length(operation_ciphertext) BETWEEN 22 AND 333163\n    AND operation_ciphertext NOT GLOB '*[^A-Za-z0-9_-]*'\n  ),\n  operation_key_version INTEGER NOT NULL CHECK(operation_key_version BETWEEN 1 AND 9007199254740991),\n  operation_nonce TEXT NOT NULL CHECK(length(operation_nonce)=16 AND operation_nonce NOT GLOB '*[^A-Za-z0-9_-]*'),\n  proof_algorithm TEXT NOT NULL CHECK(proof_algorithm='A256GCM'),\n  proof_ciphertext TEXT NOT NULL CHECK(\n    length(proof_ciphertext) BETWEEN 22 AND 16384\n    AND proof_ciphertext NOT GLOB '*[^A-Za-z0-9_-]*'\n  ),\n  proof_key_version INTEGER NOT NULL CHECK(proof_key_version BETWEEN 1 AND 9007199254740991),\n  proof_nonce TEXT NOT NULL CHECK(length(proof_nonce)=16 AND proof_nonce NOT GLOB '*[^A-Za-z0-9_-]*'),\n  operation_digest TEXT NOT NULL CHECK(length(operation_digest)=64 AND operation_digest NOT GLOB '*[^a-f0-9]*'),\n  created_at INTEGER NOT NULL CHECK(created_at>=0),\n  PRIMARY KEY(intent_id,phase),\n  CHECK(prior_token!=head_token AND genesis_token!=head_token),\n  CHECK(operation_key_version=proof_key_version),\n  CHECK(\n    (adoption_proof_algorithm IS NULL AND adoption_proof_ciphertext IS NULL\n      AND adoption_proof_key_version IS NULL AND adoption_proof_nonce IS NULL)\n    OR\n    (adoption_proof_algorithm IS NOT NULL AND adoption_proof_ciphertext IS NOT NULL\n      AND adoption_proof_key_version IS NOT NULL AND adoption_proof_nonce IS NOT NULL\n      AND adoption_proof_key_version=operation_key_version)\n  )\n) STRICT"
    },
    {
      "type": "table",
      "name": "projects",
      "tbl_name": "projects",
      "sql": "CREATE TABLE projects (\n  id TEXT PRIMARY KEY CHECK(id GLOB 'proj_[0-9a-f]*' AND length(id) = 37),\n  label TEXT NOT NULL CHECK(length(label) BETWEEN 1 AND 160),\n  root_path TEXT NOT NULL UNIQUE,\n  is_default INTEGER NOT NULL CHECK(is_default IN (0,1)),\n  created_at INTEGER NOT NULL CHECK(created_at >= 0),\n  updated_at INTEGER NOT NULL CHECK(updated_at >= created_at)\n, label_key TEXT) STRICT"
    },
    {
      "type": "table",
      "name": "provider_interaction_transitions",
      "tbl_name": "provider_interaction_transitions",
      "sql": "CREATE TABLE provider_interaction_transitions (\n  public_id TEXT NOT NULL REFERENCES provider_interactions(public_id) ON DELETE CASCADE,\n  revision INTEGER NOT NULL CHECK(revision > 0),\n  state TEXT NOT NULL CHECK(state IN (\n    'pending','response_prepared','response_written','resolved','declined','canceled','expired','resolution_unknown'\n  )),\n  response_digest TEXT CHECK(response_digest IS NULL OR length(response_digest) = 64),\n  recorded_at INTEGER NOT NULL CHECK(recorded_at >= 0),\n  PRIMARY KEY(public_id, revision)\n) STRICT"
    },
    {
      "type": "table",
      "name": "provider_interactions",
      "tbl_name": "provider_interactions",
      "sql": "CREATE TABLE provider_interactions (\n  public_id TEXT PRIMARY KEY CHECK(length(public_id) = 36),\n  session_id TEXT REFERENCES sessions(id),\n  profile_id TEXT NOT NULL REFERENCES profiles(id),\n  process_generation INTEGER NOT NULL CHECK(process_generation >= 0),\n  connection_id TEXT NOT NULL CHECK(length(connection_id) = 36),\n  request_id_type TEXT NOT NULL CHECK(request_id_type IN ('number','string')),\n  request_id_number INTEGER CHECK(request_id_number IS NULL OR request_id_number BETWEEN -9007199254740991 AND 9007199254740991),\n  request_id_text TEXT CHECK(request_id_text IS NULL OR length(request_id_text) BETWEEN 1 AND 512),\n  method TEXT NOT NULL CHECK(length(method) BETWEEN 1 AND 512),\n  request_digest TEXT NOT NULL CHECK(length(request_digest) = 64),\n  thread_id TEXT CHECK(thread_id IS NULL OR length(thread_id) BETWEEN 1 AND 512),\n  turn_id TEXT CHECK(turn_id IS NULL OR length(turn_id) BETWEEN 1 AND 512),\n  item_id TEXT CHECK(item_id IS NULL OR length(item_id) BETWEEN 1 AND 512),\n  approval_id TEXT CHECK(approval_id IS NULL OR length(approval_id) BETWEEN 1 AND 512),\n  kind TEXT NOT NULL CHECK(kind IN (\n    'command_approval','file_change_approval','permission_approval','user_input','mcp_elicitation'\n  )),\n  state TEXT NOT NULL CHECK(state IN (\n    'pending','response_prepared','response_written','resolved','declined','canceled','expired','resolution_unknown'\n  )),\n  revision INTEGER NOT NULL CHECK(revision > 0),\n  blocking INTEGER NOT NULL CHECK(blocking IN (0,1)),\n  display_json TEXT NOT NULL CHECK(json_valid(display_json) AND length(CAST(display_json AS BLOB)) BETWEEN 2 AND 65536),\n  response_digest TEXT CHECK(response_digest IS NULL OR length(response_digest) = 64),\n  response_expected_revision INTEGER CHECK(response_expected_revision IS NULL OR response_expected_revision > 0),\n  requested_at INTEGER NOT NULL CHECK(requested_at >= 0),\n  updated_at INTEGER NOT NULL CHECK(updated_at >= requested_at),\n  terminal_at INTEGER CHECK(terminal_at IS NULL OR terminal_at >= requested_at), deadline_at INTEGER NOT NULL DEFAULT 9007199254740991 CHECK(deadline_at>=requested_at AND deadline_at<=9007199254740991), intended_terminal_state TEXT CHECK(intended_terminal_state IS NULL OR intended_terminal_state IN ('resolved','declined','canceled','expired')), resolved_by TEXT CHECK(resolved_by IS NULL OR resolved_by = 'autorespond'),\n  CHECK(\n    (request_id_type='number' AND request_id_number IS NOT NULL AND request_id_text IS NULL)\n    OR\n    (request_id_type='string' AND request_id_number IS NULL AND request_id_text IS NOT NULL)\n  ),\n  CHECK(\n    (state='pending' AND response_digest IS NULL AND response_expected_revision IS NULL)\n    OR\n    (state!='pending' AND (\n      (response_digest IS NOT NULL AND response_expected_revision IS NOT NULL)\n      OR state IN ('resolved','canceled','expired','resolution_unknown')\n    ))\n  ),\n  CHECK(\n    (state IN ('pending','response_prepared','response_written') AND terminal_at IS NULL)\n    OR\n    (state IN ('resolved','declined','canceled','expired','resolution_unknown') AND terminal_at IS NOT NULL)\n  )\n) STRICT"
    },
    {
      "type": "table",
      "name": "provider_login_authorities",
      "tbl_name": "provider_login_authorities",
      "sql": "CREATE TABLE provider_login_authorities (\n  attempt_id TEXT PRIMARY KEY REFERENCES mutation_attempts(id),\n  profile_id TEXT NOT NULL REFERENCES profiles(id),\n  process_generation INTEGER NOT NULL CHECK(process_generation > 0),\n  login_id TEXT NOT NULL CHECK(length(login_id) BETWEEN 1 AND 512),\n  state TEXT NOT NULL CHECK(state IN ('active','settled')),\n  settlement TEXT CHECK(settlement IS NULL OR settlement IN ('canceled','not_found','signed_in','provider_disconnected')),\n  recorded_at INTEGER NOT NULL CHECK(recorded_at >= 0),\n  updated_at INTEGER NOT NULL CHECK(updated_at >= recorded_at),\n  CHECK((state='active' AND settlement IS NULL) OR (state='settled' AND settlement IS NOT NULL))\n) STRICT"
    },
    {
      "type": "table",
      "name": "provider_runtime_account_revocations",
      "tbl_name": "provider_runtime_account_revocations",
      "sql": "CREATE TABLE provider_runtime_account_revocations (\n  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,\n  profile_generation INTEGER NOT NULL CHECK(profile_generation BETWEEN 0 AND 9007199254740991),\n  provider TEXT NOT NULL CHECK(provider IN ('codex','claude')),\n  runtime_scope TEXT NOT NULL CHECK(runtime_scope IN ('managed','personal')),\n  current_account_key TEXT CHECK(\n    current_account_key IS NULL\n    OR (provider='codex' AND length(current_account_key)=73\n      AND substr(current_account_key,1,9)='v1:codex:'\n      AND substr(current_account_key,10) NOT GLOB '*[^0-9a-f]*')\n    OR (provider='claude' AND length(current_account_key)=74\n      AND substr(current_account_key,1,10)='v1:claude:'\n      AND substr(current_account_key,11) NOT GLOB '*[^0-9a-f]*')\n  ),\n  state TEXT NOT NULL CHECK(state IN ('releasing','completed')),\n  revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),\n  created_at INTEGER NOT NULL CHECK(created_at >= 0),\n  updated_at INTEGER NOT NULL CHECK(updated_at >= created_at),\n  completed_at INTEGER CHECK(completed_at IS NULL OR completed_at >= created_at),\n  CHECK((state='completed')=(completed_at IS NOT NULL)),\n  PRIMARY KEY(profile_id,provider,runtime_scope)\n) STRICT"
    },
    {
      "type": "table",
      "name": "queue_effect_evidence",
      "tbl_name": "queue_effect_evidence",
      "sql": "CREATE TABLE queue_effect_evidence (\n  queue_id TEXT PRIMARY KEY REFERENCES queue_entries(id),\n  evidence_json TEXT NOT NULL CHECK(length(CAST(evidence_json AS BLOB)) BETWEEN 2 AND 262144),\n  evidence_digest TEXT NOT NULL CHECK(length(evidence_digest) = 64),\n  recorded_at INTEGER NOT NULL CHECK(recorded_at >= 0)\n) STRICT"
    },
    {
      "type": "table",
      "name": "queue_effect_resolutions",
      "tbl_name": "queue_effect_resolutions",
      "sql": "CREATE TABLE queue_effect_resolutions (\n  queue_id TEXT PRIMARY KEY REFERENCES queue_effect_evidence(queue_id),\n  resolution_kind TEXT NOT NULL CHECK(resolution_kind IN ('proven_applied','abandoned')),\n  evidence_json TEXT NOT NULL CHECK(length(CAST(evidence_json AS BLOB)) BETWEEN 2 AND 262144),\n  receipt_json TEXT CHECK(receipt_json IS NULL OR length(CAST(receipt_json AS BLOB)) <= 262144),\n  created_at INTEGER NOT NULL CHECK(created_at >= 0)\n) STRICT"
    },
    {
      "type": "table",
      "name": "queue_entries",
      "tbl_name": "queue_entries",
      "sql": "CREATE TABLE queue_entries (\n  id TEXT PRIMARY KEY CHECK(id GLOB 'queue_[0-9a-f]*' AND length(id) = 38),\n  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,\n  message TEXT NOT NULL CHECK(length(CAST(message AS BLOB)) BETWEEN 1 AND 262144),\n  state TEXT NOT NULL CHECK(state IN ('pending','dispatching','applied','failed','ambiguous','cancelled')),\n  created_at INTEGER NOT NULL CHECK(created_at >= 0),\n  updated_at INTEGER NOT NULL CHECK(updated_at >= created_at)\n, enqueue_sequence INTEGER CHECK(enqueue_sequence IS NULL OR enqueue_sequence BETWEEN 1 AND 9007199254740990), message_actor TEXT NOT NULL DEFAULT 'human' CHECK(message_actor IN ('human','peer_session')), peer_action_id TEXT REFERENCES peer_session_actions(id)) STRICT"
    },
    {
      "type": "table",
      "name": "queue_message_scrub_authority",
      "tbl_name": "queue_message_scrub_authority",
      "sql": "CREATE TABLE queue_message_scrub_authority (\n  singleton INTEGER PRIMARY KEY CHECK(singleton=1),\n  required_at INTEGER NOT NULL CHECK(required_at >= 0),\n  requires_vacuum INTEGER NOT NULL CHECK(requires_vacuum IN (0,1)),\n  generation INTEGER NOT NULL DEFAULT 1 CHECK(generation BETWEEN 1 AND 9007199254740991)\n) STRICT"
    },
    {
      "type": "table",
      "name": "queue_sequence_authority",
      "tbl_name": "queue_sequence_authority",
      "sql": "CREATE TABLE queue_sequence_authority (\n  singleton INTEGER PRIMARY KEY CHECK(singleton=1),\n  next_sequence INTEGER NOT NULL CHECK(next_sequence BETWEEN 1 AND 9007199254740991)\n) STRICT"
    },
    {
      "type": "table",
      "name": "security_scrub_authority",
      "tbl_name": "security_scrub_authority",
      "sql": "CREATE TABLE security_scrub_authority (\n  singleton INTEGER PRIMARY KEY CHECK(singleton=1),\n  reason TEXT NOT NULL CHECK(reason='mcp_url_redaction'),\n  required_at INTEGER NOT NULL CHECK(required_at >= 0)\n) STRICT"
    },
    {
      "type": "table",
      "name": "session_account_authorities",
      "tbl_name": "session_account_authorities",
      "sql": "CREATE TABLE session_account_authorities (\n  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,\n  profile_id TEXT NOT NULL REFERENCES profiles(id),\n  account_key TEXT CHECK(account_key IS NULL OR length(CAST(account_key AS BLOB)) BETWEEN 1 AND 320),\n  recorded_at INTEGER NOT NULL CHECK(recorded_at >= 0)\n) STRICT"
    },
    {
      "type": "table",
      "name": "session_adoption_candidates",
      "tbl_name": "session_adoption_candidates",
      "sql": "CREATE TABLE session_adoption_candidates (\n  provider TEXT NOT NULL CHECK(provider IN ('codex','claude')),\n  provider_thread_id TEXT NOT NULL CHECK(length(provider_thread_id) BETWEEN 1 AND 200),\n  project_id TEXT,\n  title TEXT NOT NULL CHECK(length(CAST(title AS BLOB)) BETWEEN 1 AND 320),\n  provider_state TEXT NOT NULL CHECK(provider_state IN ('active','idle','terminal')),\n  active_turn_id TEXT CHECK(active_turn_id IS NULL OR length(active_turn_id) BETWEEN 1 AND 2048),\n  provider_updated_at REAL CHECK(provider_updated_at IS NULL OR provider_updated_at >= 0),\n  liveness TEXT NOT NULL CHECK(liveness IN ('live','not_live','unknown')),\n  source_pid INTEGER CHECK(source_pid IS NULL OR (source_pid > 0 AND source_pid <= 9007199254740991)),\n  source_pid_domain TEXT CHECK(source_pid_domain IS NULL OR source_pid_domain IN ('darwin','linux')),\n  source_proc_start TEXT CHECK(source_proc_start IS NULL OR length(CAST(source_proc_start AS BLOB)) BETWEEN 1 AND 128),\n  claim_status TEXT NOT NULL CHECK(claim_status IN ('pending','claiming','adopted','fenced')),\n  candidate_fingerprint TEXT NOT NULL CHECK(length(candidate_fingerprint)=64 AND candidate_fingerprint GLOB '[0-9a-f]*'),\n  fenced_fingerprint TEXT CHECK(fenced_fingerprint IS NULL OR (length(fenced_fingerprint)=64 AND fenced_fingerprint GLOB '[0-9a-f]*')),\n  revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),\n  first_discovered_at INTEGER NOT NULL CHECK(first_discovered_at >= 0),\n  last_observed_at INTEGER NOT NULL CHECK(last_observed_at >= first_discovered_at),\n  last_changed_at INTEGER NOT NULL CHECK(last_changed_at BETWEEN first_discovered_at AND last_observed_at),\n  last_attempt_at INTEGER CHECK(last_attempt_at IS NULL OR last_attempt_at >= first_discovered_at),\n  last_live_observed_at INTEGER CHECK(\n    last_live_observed_at IS NULL OR (\n      last_live_observed_at<=last_observed_at\n      AND (\n        provider='codex'\n        OR (\n          provider='claude'\n          AND source_pid IS NOT NULL\n          AND source_pid_domain IS NOT NULL\n          AND source_proc_start IS NOT NULL\n        )\n      )\n    )\n  ),\n  provider_project_root TEXT CHECK(\n    provider_project_root IS NULL OR (\n      length(CAST(provider_project_root AS BLOB)) BETWEEN 1 AND 8192\n      AND substr(provider_project_root,1,1)='/'\n    )\n  ),\n  PRIMARY KEY(provider,provider_thread_id),\n  CHECK(\n    (claim_status='fenced' AND fenced_fingerprint IS NOT NULL)\n    OR (claim_status!='fenced' AND fenced_fingerprint IS NULL)\n  ),\n  CHECK(\n    (source_pid IS NULL AND source_pid_domain IS NULL AND source_proc_start IS NULL)\n    OR (\n      provider='claude'\n      AND source_pid IS NOT NULL\n      AND source_pid_domain IS NOT NULL\n      AND source_proc_start IS NOT NULL\n    )\n  )\n) STRICT"
    },
    {
      "type": "table",
      "name": "session_adoption_policies",
      "tbl_name": "session_adoption_policies",
      "sql": "CREATE TABLE session_adoption_policies (\n  provider TEXT PRIMARY KEY CHECK(provider IN ('codex','claude')),\n  profile_id TEXT REFERENCES profiles(id),\n  state TEXT NOT NULL CHECK(state IN ('enabled','disabled')),\n  revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),\n  created_at INTEGER NOT NULL CHECK(created_at >= 0),\n  updated_at INTEGER NOT NULL CHECK(updated_at >= created_at),\n  CHECK(\n    (state='enabled' AND profile_id IS NOT NULL)\n    OR (state='disabled' AND profile_id IS NULL)\n  )\n) STRICT"
    },
    {
      "type": "table",
      "name": "session_adoption_profile_generation_permits",
      "tbl_name": "session_adoption_profile_generation_permits",
      "sql": "CREATE TABLE session_adoption_profile_generation_permits (\n  profile_id TEXT PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,\n  from_generation INTEGER NOT NULL CHECK(from_generation BETWEEN 0 AND 9007199254740990),\n  to_generation INTEGER NOT NULL CHECK(to_generation=from_generation+1),\n  CHECK(to_generation BETWEEN 1 AND 9007199254740991)\n) STRICT"
    },
    {
      "type": "table",
      "name": "session_approval_modes",
      "tbl_name": "session_approval_modes",
      "sql": "CREATE TABLE session_approval_modes (\n  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,\n  mode TEXT NOT NULL CHECK(mode IN ('auto:all','auto:workspace','manual')),\n  updated_at INTEGER NOT NULL CHECK(updated_at >= 0)\n) STRICT"
    },
    {
      "type": "table",
      "name": "session_autorespond_counters",
      "tbl_name": "session_autorespond_counters",
      "sql": "CREATE TABLE session_autorespond_counters (\n  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,\n  consecutive_count INTEGER NOT NULL DEFAULT 0 CHECK(consecutive_count >= 0),\n  updated_at INTEGER NOT NULL CHECK(updated_at >= 0)\n) STRICT"
    },
    {
      "type": "table",
      "name": "session_claude_process_authorities",
      "tbl_name": "session_claude_process_authorities",
      "sql": "CREATE TABLE session_claude_process_authorities (\n  provider_thread_id TEXT NOT NULL CHECK(length(provider_thread_id) BETWEEN 1 AND 200),\n  profile_id TEXT NOT NULL REFERENCES profiles(id),\n  profile_generation INTEGER NOT NULL CHECK(profile_generation BETWEEN 0 AND 9007199254740991),\n  runtime_scope TEXT NOT NULL CHECK(runtime_scope IN ('managed','personal')),\n  session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,\n  pid INTEGER NOT NULL CHECK(pid > 0 AND pid <= 9007199254740991),\n  pid_domain TEXT NOT NULL CHECK(pid_domain IN ('darwin','linux')),\n  proc_start TEXT NOT NULL CHECK(length(CAST(proc_start AS BLOB)) BETWEEN 1 AND 128),\n  state TEXT NOT NULL CHECK(state IN ('claimed','bound','releasing','released')),\n  revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),\n  recorded_at INTEGER NOT NULL CHECK(recorded_at >= 0),\n  released_at INTEGER CHECK(released_at IS NULL OR released_at >= recorded_at),\n  CHECK((state='released')=(released_at IS NOT NULL)),\n  CHECK(state!='bound' OR session_id IS NOT NULL),\n  PRIMARY KEY(runtime_scope,profile_id,provider_thread_id)\n) STRICT"
    },
    {
      "type": "table",
      "name": "session_claude_process_launch_intents",
      "tbl_name": "session_claude_process_launch_intents",
      "sql": "CREATE TABLE session_claude_process_launch_intents (\n  intent_id TEXT NOT NULL UNIQUE CHECK(length(intent_id)=36),\n  provider_thread_id TEXT NOT NULL CHECK(length(provider_thread_id) BETWEEN 1 AND 200),\n  profile_id TEXT NOT NULL REFERENCES profiles(id),\n  profile_generation INTEGER NOT NULL CHECK(profile_generation BETWEEN 0 AND 9007199254740991),\n  runtime_scope TEXT NOT NULL CHECK(runtime_scope IN ('managed','personal')),\n  provider_account_key TEXT NOT NULL CHECK(\n    length(provider_account_key)=74\n    AND substr(provider_account_key,1,10)='v1:claude:'\n    AND substr(provider_account_key,11) NOT GLOB '*[^0-9a-f]*'\n  ),\n  session_id TEXT REFERENCES sessions(id),\n  revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),\n  staged_at INTEGER NOT NULL CHECK(staged_at >= 0),\n  updated_at INTEGER NOT NULL CHECK(updated_at >= staged_at),\n  PRIMARY KEY(runtime_scope,profile_id,provider_thread_id)\n) STRICT"
    },
    {
      "type": "table",
      "name": "session_conversation_automation",
      "tbl_name": "session_conversation_automation",
      "sql": "CREATE TABLE session_conversation_automation (\n  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,\n  provider_thread_id TEXT NOT NULL CHECK(length(CAST(provider_thread_id AS BLOB)) BETWEEN 1 AND 200),\n  enabled_at INTEGER NOT NULL CHECK(enabled_at BETWEEN 0 AND 9007199254740991)\n) STRICT"
    },
    {
      "type": "table",
      "name": "session_event_streams",
      "tbl_name": "session_event_streams",
      "sql": "CREATE TABLE session_event_streams (\n  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,\n  stream_epoch TEXT NOT NULL CHECK(\n    length(stream_epoch) = 36\n    AND substr(stream_epoch,9,1) = '-'\n    AND substr(stream_epoch,14,1) = '-'\n    AND substr(stream_epoch,19,1) = '-'\n    AND substr(stream_epoch,24,1) = '-'\n  ),\n  next_sequence INTEGER NOT NULL CHECK(next_sequence BETWEEN 1 AND 9007199254740991),\n  floor_sequence INTEGER NOT NULL CHECK(floor_sequence BETWEEN 1 AND next_sequence),\n  observed_through_sequence INTEGER NOT NULL CHECK(\n    observed_through_sequence BETWEEN 0 AND 9007199254740991\n    AND observed_through_sequence = next_sequence - 1\n  ),\n  retained_count INTEGER NOT NULL CHECK(retained_count >= 0),\n  retained_bytes INTEGER NOT NULL CHECK(retained_bytes >= 0),\n  retention_gap_reason TEXT CHECK(retention_gap_reason IS NULL OR retention_gap_reason IN (\n    'retention_count','retention_age','retention_bytes'\n  )),\n  created_at INTEGER NOT NULL CHECK(created_at >= 0),\n  updated_at INTEGER NOT NULL CHECK(updated_at >= created_at),\n  UNIQUE(session_id, stream_epoch)\n) STRICT"
    },
    {
      "type": "table",
      "name": "session_events",
      "tbl_name": "session_events",
      "sql": "CREATE TABLE session_events (\n  session_id TEXT NOT NULL,\n  stream_epoch TEXT NOT NULL,\n  sequence INTEGER NOT NULL CHECK(sequence BETWEEN 1 AND 9007199254740991),\n  recorded_at INTEGER NOT NULL CHECK(recorded_at >= 0),\n  account_id TEXT NOT NULL REFERENCES profiles(id),\n  provider_generation INTEGER NOT NULL CHECK(provider_generation >= 0),\n  provider_connection_id TEXT CHECK(provider_connection_id IS NULL OR length(provider_connection_id) = 36),\n  event_json TEXT NOT NULL CHECK(json_valid(event_json)),\n  event_bytes INTEGER NOT NULL CHECK(\n    event_bytes = length(CAST(event_json AS BLOB))\n    AND event_bytes BETWEEN 2 AND 65536\n  ), projection_version INTEGER NOT NULL DEFAULT 1 CHECK(projection_version IN (1,2)),\n  PRIMARY KEY(session_id, sequence),\n  FOREIGN KEY(session_id, stream_epoch)\n    REFERENCES session_event_streams(session_id, stream_epoch) ON DELETE CASCADE\n) STRICT"
    },
    {
      "type": "table",
      "name": "session_host_capability_bindings",
      "tbl_name": "session_host_capability_bindings",
      "sql": "CREATE TABLE session_host_capability_bindings (\n  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,\n  preamble_version INTEGER NOT NULL CHECK(preamble_version BETWEEN 1 AND 9007199254740991),\n  preamble_digest TEXT NOT NULL CHECK(length(preamble_digest) = 64 AND preamble_digest NOT GLOB '*[^a-f0-9]*'),\n  manifest_version INTEGER NOT NULL CHECK(manifest_version BETWEEN 1 AND 9007199254740991),\n  manifest_digest TEXT NOT NULL CHECK(length(manifest_digest) = 64 AND manifest_digest NOT GLOB '*[^a-f0-9]*'),\n  recorded_at INTEGER NOT NULL CHECK(recorded_at >= 0)\n) STRICT"
    },
    {
      "type": "table",
      "name": "session_message_event_sources",
      "tbl_name": "session_message_event_sources",
      "sql": "CREATE TABLE session_message_event_sources (\n  source_id TEXT PRIMARY KEY CHECK(\n    (source_id GLOB 'attempt_[0-9a-f]*' AND length(source_id)=40)\n    OR (source_id GLOB 'queue_[0-9a-f]*' AND length(source_id)=38)\n  ),\n  source_kind TEXT NOT NULL CHECK(source_kind IN ('mutation','queue')),\n  session_id TEXT NOT NULL REFERENCES sessions(id),\n  actor TEXT NOT NULL CHECK(actor IN ('human','autorespond','peer_session','provider_switch')),\n  body_digest TEXT NOT NULL CHECK(length(body_digest) = 64 AND body_digest NOT GLOB '*[^a-f0-9]*'),\n  stream_epoch TEXT NOT NULL CHECK(length(stream_epoch) = 36),\n  event_sequence INTEGER NOT NULL CHECK(event_sequence BETWEEN 1 AND 9007199254740991),\n  created_at INTEGER NOT NULL CHECK(created_at >= 0),\n  UNIQUE(session_id,event_sequence),\n  FOREIGN KEY(session_id,event_sequence)\n    REFERENCES session_events(session_id,sequence)\n) STRICT"
    },
    {
      "type": "table",
      "name": "session_mutation_authority_rebinds",
      "tbl_name": "session_mutation_authority_rebinds",
      "sql": "CREATE TABLE session_mutation_authority_rebinds (\n  attempt_id TEXT NOT NULL REFERENCES mutation_attempts(id),\n  profile_id TEXT NOT NULL REFERENCES profiles(id),\n  provider TEXT NOT NULL CHECK(provider IN ('codex','claude')),\n  from_generation INTEGER NOT NULL CHECK(from_generation >= 0),\n  to_generation INTEGER NOT NULL CHECK(to_generation = from_generation + 1),\n  recorded_at INTEGER NOT NULL CHECK(recorded_at >= 0),\n  PRIMARY KEY(attempt_id,profile_id,provider,to_generation),\n  UNIQUE(attempt_id,profile_id,provider,from_generation)\n) STRICT"
    },
    {
      "type": "table",
      "name": "session_mutation_authority_rebinds_v39",
      "tbl_name": "session_mutation_authority_rebinds_v39",
      "sql": "CREATE TABLE session_mutation_authority_rebinds_v39 (\n  attempt_id TEXT NOT NULL REFERENCES mutation_attempts(id),\n  profile_id TEXT NOT NULL REFERENCES profiles(id),\n  provider TEXT NOT NULL CHECK(provider IN ('codex','claude','devin')),\n  from_generation INTEGER NOT NULL CHECK(from_generation >= 0),\n  to_generation INTEGER NOT NULL CHECK(to_generation = from_generation + 1),\n  recorded_at INTEGER NOT NULL CHECK(recorded_at >= 0),\n  PRIMARY KEY(attempt_id,profile_id,provider,to_generation),\n  UNIQUE(attempt_id,profile_id,provider,from_generation)\n) STRICT"
    },
    {
      "type": "table",
      "name": "session_peer_policies",
      "tbl_name": "session_peer_policies",
      "sql": "CREATE TABLE session_peer_policies (\n  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,\n  mode TEXT NOT NULL CHECK(mode IN ('off','inspect','coordinate')),\n  revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),\n  created_at INTEGER NOT NULL CHECK(created_at >= 0),\n  updated_at INTEGER NOT NULL CHECK(updated_at >= created_at)\n) STRICT"
    },
    {
      "type": "table",
      "name": "session_personal_runtime_bindings",
      "tbl_name": "session_personal_runtime_bindings",
      "sql": "CREATE TABLE session_personal_runtime_bindings (\n  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,\n  provider TEXT NOT NULL CHECK(provider IN ('codex','claude')),\n  provider_thread_id TEXT NOT NULL CHECK(length(provider_thread_id) BETWEEN 1 AND 200),\n  state TEXT NOT NULL CHECK(state IN ('active','detaching','detached')),\n  revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),\n  adopted_at INTEGER NOT NULL CHECK(adopted_at >= 0),\n  updated_at INTEGER NOT NULL CHECK(updated_at >= adopted_at),\n  detached_at INTEGER CHECK(detached_at IS NULL OR detached_at >= adopted_at),\n  UNIQUE(provider,provider_thread_id),\n  FOREIGN KEY(provider,provider_thread_id)\n    REFERENCES session_adoption_candidates(provider,provider_thread_id),\n  CHECK(\n    (state='active' AND detached_at IS NULL)\n    OR (state='detaching' AND detached_at IS NULL)\n    OR (state='detached' AND detached_at IS NOT NULL)\n  )\n) STRICT"
    },
    {
      "type": "table",
      "name": "session_provider_account_authorities",
      "tbl_name": "session_provider_account_authorities",
      "sql": "CREATE TABLE session_provider_account_authorities (\n  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,\n  provider TEXT NOT NULL CHECK(provider IN ('codex','claude')),\n  runtime_scope TEXT NOT NULL CHECK(runtime_scope IN ('managed','personal')),\n  account_key TEXT NOT NULL CHECK(\n    (provider='codex' AND length(account_key)=73\n      AND substr(account_key,1,9)='v1:codex:'\n      AND substr(account_key,10) NOT GLOB '*[^0-9a-f]*')\n    OR\n    (provider='claude' AND length(account_key)=74\n      AND substr(account_key,1,10)='v1:claude:'\n      AND substr(account_key,11) NOT GLOB '*[^0-9a-f]*')\n  ),\n  recorded_at INTEGER NOT NULL CHECK(recorded_at >= 0)\n) STRICT"
    },
    {
      "type": "table",
      "name": "session_provider_switch_seed_intents",
      "tbl_name": "session_provider_switch_seed_intents",
      "sql": "CREATE TABLE session_provider_switch_seed_intents (\n  attempt_id TEXT PRIMARY KEY REFERENCES session_provider_switch_targets(attempt_id),\n  client_message_id TEXT NOT NULL CHECK(client_message_id=attempt_id AND length(client_message_id) BETWEEN 1 AND 200),\n  seed_text TEXT NOT NULL CHECK(length(CAST(seed_text AS BLOB)) BETWEEN 1 AND 131072),\n  runtime_profile_json TEXT NOT NULL CHECK(length(CAST(runtime_profile_json AS BLOB)) BETWEEN 2 AND 262144),\n  recorded_at INTEGER NOT NULL CHECK(recorded_at >= 0)\n) STRICT"
    },
    {
      "type": "table",
      "name": "session_provider_switch_seed_results",
      "tbl_name": "session_provider_switch_seed_results",
      "sql": "CREATE TABLE session_provider_switch_seed_results (\n  attempt_id TEXT PRIMARY KEY REFERENCES session_provider_switch_seed_intents(attempt_id),\n  turn_id TEXT NOT NULL CHECK(length(turn_id) BETWEEN 1 AND 200),\n  turn_status TEXT NOT NULL CHECK(turn_status IN ('completed','interrupted','failed','inProgress')),\n  recorded_at INTEGER NOT NULL CHECK(recorded_at >= 0)\n) STRICT"
    },
    {
      "type": "table",
      "name": "session_provider_switch_source_releases",
      "tbl_name": "session_provider_switch_source_releases",
      "sql": "CREATE TABLE session_provider_switch_source_releases (\n  attempt_id TEXT PRIMARY KEY REFERENCES session_provider_switch_seed_results(attempt_id),\n  recorded_at INTEGER NOT NULL CHECK(recorded_at >= 0)\n) STRICT"
    },
    {
      "type": "table",
      "name": "session_provider_switch_target_releases",
      "tbl_name": "session_provider_switch_target_releases",
      "sql": "CREATE TABLE session_provider_switch_target_releases (\n  attempt_id TEXT PRIMARY KEY REFERENCES session_provider_switch_targets(attempt_id),\n  recorded_at INTEGER NOT NULL CHECK(recorded_at >= 0)\n) STRICT"
    },
    {
      "type": "table",
      "name": "session_provider_switch_targets",
      "tbl_name": "session_provider_switch_targets",
      "sql": "CREATE TABLE session_provider_switch_targets (\n  attempt_id TEXT PRIMARY KEY REFERENCES mutation_attempts(id),\n  provider_thread_id TEXT NOT NULL CHECK(length(provider_thread_id) BETWEEN 1 AND 200),\n  recorded_at INTEGER NOT NULL CHECK(recorded_at >= 0)\n) STRICT"
    },
    {
      "type": "table",
      "name": "session_runtime_profiles",
      "tbl_name": "session_runtime_profiles",
      "sql": "CREATE TABLE session_runtime_profiles (\n  session_id TEXT NOT NULL REFERENCES sessions(id),\n  revision INTEGER NOT NULL CHECK(revision > 0),\n  source_kind TEXT NOT NULL CHECK(source_kind IN ('session_start','turn_start','queue_start')),\n  source_id TEXT NOT NULL CHECK(length(source_id) BETWEEN 1 AND 200),\n  profile_id TEXT NOT NULL REFERENCES profiles(id),\n  process_generation INTEGER NOT NULL CHECK(process_generation >= 0),\n  observed_at INTEGER NOT NULL CHECK(observed_at >= 0),\n  profile_json TEXT NOT NULL CHECK(length(CAST(profile_json AS BLOB)) BETWEEN 2 AND 262144),\n  recorded_at INTEGER NOT NULL CHECK(recorded_at >= 0),\n  PRIMARY KEY(session_id, revision),\n  UNIQUE(source_kind, source_id)\n) STRICT"
    },
    {
      "type": "table",
      "name": "session_show_thinking",
      "tbl_name": "session_show_thinking",
      "sql": "CREATE TABLE session_show_thinking (\n  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,\n  enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),\n  updated_at INTEGER NOT NULL CHECK(updated_at >= 0)\n) STRICT"
    },
    {
      "type": "table",
      "name": "session_start_attempts",
      "tbl_name": "session_start_attempts",
      "sql": "CREATE TABLE session_start_attempts (\n  attempt_id TEXT PRIMARY KEY REFERENCES mutation_attempts(id),\n  session_id TEXT NOT NULL UNIQUE CHECK(session_id GLOB 'sess_[0-9a-f]*' AND length(session_id) = 37),\n  created_at INTEGER NOT NULL CHECK(created_at >= 0)\n) STRICT"
    },
    {
      "type": "table",
      "name": "session_states",
      "tbl_name": "session_states",
      "sql": "CREATE TABLE session_states (\n  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,\n  state TEXT NOT NULL CHECK(state IN ('working','needs_approval','needs_answer','needs_action','done','done_followups','done_caveats','aborted')),\n  attention INTEGER NOT NULL CHECK(attention IN (0,1)),\n  reason TEXT NOT NULL CHECK(length(reason) <= 256),\n  verbatim_required INTEGER NOT NULL CHECK(verbatim_required IN (0,1)),\n  verbatim_literal TEXT CHECK(verbatim_literal IS NULL OR length(verbatim_literal) <= 200),\n  last_activity_at INTEGER NOT NULL CHECK(last_activity_at >= 0),\n  revision INTEGER NOT NULL CHECK(revision > 0),\n  updated_at INTEGER NOT NULL CHECK(updated_at >= 0)\n) STRICT"
    },
    {
      "type": "table",
      "name": "session_task_occurrences",
      "tbl_name": "session_task_occurrences",
      "sql": "CREATE TABLE session_task_occurrences (\n  task_id TEXT NOT NULL,\n  session_id TEXT NOT NULL,\n  task_revision INTEGER NOT NULL CHECK(task_revision BETWEEN 1 AND 9007199254740990),\n  scheduled_for INTEGER NOT NULL CHECK(scheduled_for BETWEEN 0 AND 9007199254740991),\n  coalesced_intervals INTEGER NOT NULL CHECK(coalesced_intervals BETWEEN 0 AND 9007199254740991),\n  queue_id TEXT NOT NULL UNIQUE REFERENCES queue_entries(id) ON DELETE CASCADE,\n  created_at INTEGER NOT NULL CHECK(created_at BETWEEN 0 AND 9007199254740991),\n  PRIMARY KEY(task_id,scheduled_for),\n  FOREIGN KEY(task_id,session_id) REFERENCES session_tasks(id,session_id) ON DELETE CASCADE\n) STRICT"
    },
    {
      "type": "table",
      "name": "session_task_receipts",
      "tbl_name": "session_task_receipts",
      "sql": "CREATE TABLE session_task_receipts (\n  idempotency_key TEXT PRIMARY KEY CHECK(length(idempotency_key)=36),\n  request_digest TEXT NOT NULL CHECK(length(request_digest)=64 AND request_digest NOT GLOB '*[^0-9a-f]*'),\n  operation TEXT NOT NULL CHECK(operation IN ('list','view','create','edit','delete')),\n  session_id TEXT NOT NULL,\n  task_id TEXT,\n  result_revision INTEGER CHECK(result_revision IS NULL OR result_revision BETWEEN 1 AND 9007199254740991),\n  result_updated_at INTEGER CHECK(result_updated_at IS NULL OR result_updated_at BETWEEN 0 AND 9007199254740991),\n  result_next_due_at INTEGER CHECK(result_next_due_at IS NULL OR result_next_due_at BETWEEN 0 AND 9007199254740991),\n  result_deleted_at INTEGER CHECK(result_deleted_at IS NULL OR result_deleted_at BETWEEN 0 AND 9007199254740991),\n  result_json TEXT CHECK(\n    result_json IS NULL OR (\n      json_valid(result_json)\n      AND length(CAST(result_json AS BLOB)) BETWEEN 2 AND 1589248\n    )\n  ),\n  created_at INTEGER NOT NULL CHECK(created_at BETWEEN 0 AND 9007199254740991),\n  CHECK(\n    (\n      operation='list'\n      AND task_id IS NULL\n      AND result_revision IS NULL\n      AND result_updated_at IS NULL\n      AND result_next_due_at IS NULL\n      AND result_deleted_at IS NULL\n      AND result_json IS NOT NULL\n    ) OR (\n      operation='view'\n      AND task_id IS NOT NULL\n      AND result_revision IS NULL\n      AND result_updated_at IS NULL\n      AND result_next_due_at IS NULL\n      AND result_deleted_at IS NULL\n      AND result_json IS NOT NULL\n    ) OR (\n      operation='delete'\n      AND task_id IS NOT NULL\n      AND result_revision IS NOT NULL\n      AND result_updated_at IS NOT NULL\n      AND result_next_due_at IS NULL\n      AND result_deleted_at IS NOT NULL\n      AND result_json IS NOT NULL\n    ) OR (\n      operation IN ('create','edit')\n      AND task_id IS NOT NULL\n      AND result_revision IS NOT NULL\n      AND result_updated_at IS NOT NULL\n      AND result_deleted_at IS NULL\n      AND result_json IS NOT NULL\n    )\n  ),\n  FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE,\n  FOREIGN KEY(task_id,session_id) REFERENCES session_tasks(id,session_id) ON DELETE CASCADE\n) STRICT"
    },
    {
      "type": "table",
      "name": "session_tasks",
      "tbl_name": "session_tasks",
      "sql": "CREATE TABLE session_tasks (\n  id TEXT PRIMARY KEY CHECK(id GLOB 'stask_[0-9a-f]*' AND length(id)=38),\n  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,\n  name TEXT NOT NULL CHECK(length(CAST(name AS BLOB)) BETWEEN 1 AND 160),\n  prompt TEXT NOT NULL CHECK(length(CAST(prompt AS BLOB)) BETWEEN 1 AND 262144),\n  schedule_kind TEXT NOT NULL CHECK(schedule_kind='interval_minutes'),\n  interval_minutes INTEGER NOT NULL CHECK(interval_minutes BETWEEN 15 AND 10080),\n  status TEXT NOT NULL CHECK(status IN ('active','paused')),\n  revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740990),\n  next_due_at INTEGER CHECK(next_due_at IS NULL OR next_due_at BETWEEN 0 AND 9007199254740991),\n  created_at INTEGER NOT NULL CHECK(created_at BETWEEN 0 AND 9007199254740991),\n  updated_at INTEGER NOT NULL CHECK(updated_at BETWEEN created_at AND 9007199254740991),\n  deleted_at INTEGER CHECK(deleted_at IS NULL OR deleted_at BETWEEN created_at AND 9007199254740991),\n  UNIQUE(id,session_id),\n  CHECK(\n    (deleted_at IS NULL AND status='active' AND next_due_at IS NOT NULL) OR\n    (deleted_at IS NULL AND status='paused' AND next_due_at IS NULL) OR\n    (deleted_at IS NOT NULL AND status='paused' AND next_due_at IS NULL)\n  )\n) STRICT"
    },
    {
      "type": "table",
      "name": "session_turn_runtime_profiles",
      "tbl_name": "session_turn_runtime_profiles",
      "sql": "CREATE TABLE session_turn_runtime_profiles (\n  session_id TEXT NOT NULL REFERENCES sessions(id),\n  turn_id TEXT NOT NULL CHECK(length(turn_id) BETWEEN 1 AND 200),\n  source_kind TEXT NOT NULL CHECK(source_kind IN ('turn_start','queue_start')),\n  source_id TEXT NOT NULL CHECK(length(source_id) BETWEEN 1 AND 200),\n  profile_id TEXT NOT NULL REFERENCES profiles(id),\n  process_generation INTEGER NOT NULL CHECK(process_generation >= 0),\n  observed_at INTEGER NOT NULL CHECK(observed_at >= 0),\n  profile_json TEXT NOT NULL CHECK(length(CAST(profile_json AS BLOB)) BETWEEN 2 AND 262144),\n  profile_digest TEXT NOT NULL CHECK(length(profile_digest) = 64),\n  recorded_at INTEGER NOT NULL CHECK(recorded_at >= 0),\n  PRIMARY KEY(session_id, turn_id),\n  UNIQUE(source_kind, source_id),\n  FOREIGN KEY(source_kind, source_id)\n    REFERENCES session_runtime_profiles(source_kind, source_id)\n) STRICT"
    },
    {
      "type": "table",
      "name": "sessions",
      "tbl_name": "sessions",
      "sql": "CREATE TABLE sessions (\n  id TEXT PRIMARY KEY CHECK(id GLOB 'sess_[0-9a-f]*' AND length(id) = 37),\n  profile_id TEXT NOT NULL REFERENCES profiles(id),\n  project_id TEXT REFERENCES projects(id),\n  provider_thread_id TEXT,\n  title TEXT NOT NULL CHECK(length(title) <= 320),\n  note TEXT NOT NULL DEFAULT '' CHECK(length(CAST(note AS BLOB)) <= 16384),\n  provider TEXT NOT NULL DEFAULT 'codex' CHECK(provider IN ('codex','claude')),\n  preset TEXT NOT NULL CHECK(preset IN ('low','high','ultra')),\n  preset_contract INTEGER NOT NULL DEFAULT 1 CHECK(preset_contract IN (1,2)),\n  fast_enabled INTEGER NOT NULL CHECK(fast_enabled IN (0,1)),\n  state TEXT NOT NULL CHECK(state IN ('starting','active','idle','terminal','recovery_required')),\n  active_turn_id TEXT,\n  revision INTEGER NOT NULL CHECK(revision > 0),\n  created_at INTEGER NOT NULL CHECK(created_at >= 0),\n  updated_at INTEGER NOT NULL CHECK(updated_at >= created_at), provider_updated_at REAL CHECK(provider_updated_at IS NULL OR provider_updated_at >= 0), provider_v39 TEXT NOT NULL DEFAULT 'codex' CHECK(provider_v39 IN ('codex','claude','devin') AND (provider_v39!='devin' OR preset_contract=2)), archived_at INTEGER CHECK(archived_at IS NULL OR archived_at >= 0),\n  UNIQUE(profile_id, provider_thread_id)\n) STRICT"
    },
    {
      "type": "table",
      "name": "sqlite_sequence",
      "tbl_name": "sqlite_sequence",
      "sql": "CREATE TABLE sqlite_sequence(name,seq)"
    },
    {
      "type": "table",
      "name": "turn_summaries",
      "tbl_name": "turn_summaries",
      "sql": "CREATE TABLE turn_summaries (\n  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,\n  turn_id TEXT NOT NULL,\n  sequence INTEGER NOT NULL CHECK(sequence >= 0),\n  summary_json TEXT NOT NULL CHECK(length(CAST(summary_json AS BLOB)) <= 1048576),\n  created_at INTEGER NOT NULL CHECK(created_at >= 0),\n  PRIMARY KEY(session_id, turn_id),\n  UNIQUE(session_id, sequence)\n) STRICT"
    },
    {
      "type": "table",
      "name": "usage_cloud_upload_anchors",
      "tbl_name": "usage_cloud_upload_anchors",
      "sql": "CREATE TABLE usage_cloud_upload_anchors (\n  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,\n  source_revision INTEGER NOT NULL CHECK(source_revision >= 0),\n  received_at INTEGER NOT NULL CHECK(received_at >= 0),\n  PRIMARY KEY(profile_id, source_revision)\n) STRICT"
    },
    {
      "type": "table",
      "name": "usage_poll_failures",
      "tbl_name": "usage_poll_failures",
      "sql": "CREATE TABLE usage_poll_failures (\n  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,\n  source_revision INTEGER NOT NULL CHECK(source_revision >= 0),\n  observed_at INTEGER NOT NULL CHECK(observed_at >= 0),\n  reason_code TEXT NOT NULL CHECK(reason_code IN ('account_usage_read_failed')), account_fingerprint TEXT\n       CHECK(\n         account_fingerprint IS NULL OR (\n           length(account_fingerprint)=64\n           AND account_fingerprint NOT GLOB '*[^a-f0-9]*'\n         )\n       ),\n  PRIMARY KEY(profile_id, source_revision)\n) STRICT"
    },
    {
      "type": "table",
      "name": "usage_revision_authority",
      "tbl_name": "usage_revision_authority",
      "sql": "CREATE TABLE usage_revision_authority (\n  profile_id TEXT PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,\n  next_revision INTEGER NOT NULL CHECK(next_revision BETWEEN 0 AND 9007199254740991)\n) STRICT"
    },
    {
      "type": "table",
      "name": "usage_snapshots",
      "tbl_name": "usage_snapshots",
      "sql": "CREATE TABLE usage_snapshots (\n  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,\n  source_revision INTEGER NOT NULL CHECK(source_revision >= 0),\n  observed_at INTEGER NOT NULL CHECK(observed_at >= 0),\n  payload_json TEXT NOT NULL CHECK(length(CAST(payload_json AS BLOB)) <= 262144),\n  digest TEXT NOT NULL CHECK(length(digest) = 64),\n  PRIMARY KEY(profile_id, source_revision)\n) STRICT"
    },
    {
      "type": "table",
      "name": "work_attempt_reports",
      "tbl_name": "work_attempt_reports",
      "sql": "CREATE TABLE work_attempt_reports (\n  idempotency_key TEXT PRIMARY KEY CHECK(length(idempotency_key) = 36),\n  work_id TEXT NOT NULL,\n  attempt_id TEXT NOT NULL,\n  kind TEXT NOT NULL CHECK(kind IN ('checkpoint','submit','blocked','failed','unknown')),\n  report_json TEXT NOT NULL CHECK(json_valid(report_json) AND length(CAST(report_json AS BLOB)) <= 2097152),\n  report_digest TEXT NOT NULL CHECK(length(report_digest) = 64 AND report_digest NOT GLOB '*[^0-9a-f]*'),\n  created_at INTEGER NOT NULL CHECK(created_at >= 0),\n  FOREIGN KEY(work_id,attempt_id) REFERENCES work_attempts(work_id,id) ON DELETE CASCADE\n) STRICT"
    },
    {
      "type": "table",
      "name": "work_attempts",
      "tbl_name": "work_attempts",
      "sql": "CREATE TABLE work_attempts (\n  id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 6 AND 80),\n  work_id TEXT NOT NULL,\n  task_id TEXT NOT NULL,\n  worker_session_id TEXT NOT NULL REFERENCES sessions(id),\n  account_id TEXT NOT NULL REFERENCES profiles(id),\n  project_id TEXT NOT NULL REFERENCES projects(id),\n  preset TEXT NOT NULL CHECK(preset IN ('low','high','ultra')),\n  fast INTEGER NOT NULL CHECK(fast IN (0,1)),\n  fence INTEGER NOT NULL CHECK(fence > 0),\n  revision INTEGER NOT NULL CHECK(revision > 0),\n  state TEXT NOT NULL CHECK(state IN ('claimed','dispatching','running','submitted','completed','blocked','failed','released','expired','recovery_required','cancelled')),\n  lease_expires_at INTEGER NOT NULL CHECK(lease_expires_at >= 0),\n  target_session_id TEXT REFERENCES sessions(id),\n  dispatch_mode TEXT CHECK(dispatch_mode IS NULL OR dispatch_mode='send'),\n  submission_id TEXT REFERENCES work_submissions(id) DEFERRABLE INITIALLY DEFERRED,\n  account_generation INTEGER NOT NULL CHECK(account_generation >= 0),\n  daemon_generation INTEGER NOT NULL CHECK(daemon_generation >= 0),\n  created_at INTEGER NOT NULL CHECK(created_at >= 0),\n  updated_at INTEGER NOT NULL CHECK(updated_at >= created_at),\n  terminal_at INTEGER CHECK(terminal_at IS NULL OR terminal_at >= created_at),\n  UNIQUE(task_id,fence),\n  UNIQUE(work_id,id),\n  FOREIGN KEY(work_id,task_id) REFERENCES work_tasks(work_id,id) ON DELETE CASCADE,\n  CHECK((target_session_id IS NULL AND dispatch_mode IS NULL) OR (target_session_id IS NOT NULL AND dispatch_mode IS NOT NULL))\n) STRICT"
    },
    {
      "type": "table",
      "name": "work_clock",
      "tbl_name": "work_clock",
      "sql": "CREATE TABLE work_clock (\n  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),\n  logical_time INTEGER NOT NULL CHECK(logical_time >= 0)\n) STRICT"
    },
    {
      "type": "table",
      "name": "work_effect_resolutions",
      "tbl_name": "work_effect_resolutions",
      "sql": "CREATE TABLE work_effect_resolutions (\n  effect_idempotency_key TEXT PRIMARY KEY REFERENCES work_prepared_effects(idempotency_key) ON DELETE CASCADE,\n  work_id TEXT NOT NULL,\n  attempt_id TEXT NOT NULL,\n  instruction_digest TEXT NOT NULL CHECK(length(instruction_digest) = 64 AND instruction_digest NOT GLOB '*[^0-9a-f]*'),\n  outcome TEXT NOT NULL CHECK(outcome IN ('proven_applied','no_effect','failed')),\n  evidence_digest TEXT NOT NULL CHECK(length(evidence_digest) = 64 AND evidence_digest NOT GLOB '*[^0-9a-f]*'),\n  created_at INTEGER NOT NULL CHECK(created_at >= 0),\n  FOREIGN KEY(work_id,attempt_id) REFERENCES work_attempts(work_id,id) ON DELETE CASCADE\n) STRICT"
    },
    {
      "type": "table",
      "name": "work_events",
      "tbl_name": "work_events",
      "sql": "CREATE TABLE work_events (\n  work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,\n  sequence INTEGER NOT NULL CHECK(sequence > 0),\n  revision INTEGER NOT NULL CHECK(revision > 0),\n  stream_epoch TEXT NOT NULL CHECK(length(stream_epoch) = 36),\n  kind TEXT NOT NULL CHECK(length(CAST(kind AS BLOB)) BETWEEN 1 AND 120),\n  actor_session_id TEXT REFERENCES sessions(id),\n  payload_json TEXT NOT NULL CHECK(json_valid(payload_json) AND length(CAST(payload_json AS BLOB)) <= 131072),\n  payload_digest TEXT NOT NULL CHECK(length(payload_digest) = 64 AND payload_digest NOT GLOB '*[^0-9a-f]*'),\n  previous_hash TEXT CHECK(previous_hash IS NULL OR (length(previous_hash) = 64 AND previous_hash NOT GLOB '*[^0-9a-f]*')),\n  event_hash TEXT NOT NULL CHECK(length(event_hash) = 64 AND event_hash NOT GLOB '*[^0-9a-f]*'),\n  daemon_generation INTEGER NOT NULL CHECK(daemon_generation >= 0),\n  recorded_at INTEGER NOT NULL CHECK(recorded_at >= 0),\n  PRIMARY KEY(work_id,sequence),\n  UNIQUE(work_id,revision),\n  UNIQUE(work_id,event_hash),\n  CHECK((sequence = 1 AND previous_hash IS NULL) OR (sequence > 1 AND previous_hash IS NOT NULL))\n) STRICT"
    },
    {
      "type": "table",
      "name": "work_idempotency_intents",
      "tbl_name": "work_idempotency_intents",
      "sql": "CREATE TABLE work_idempotency_intents (\n  idempotency_key TEXT PRIMARY KEY CHECK(length(idempotency_key) = 36),\n  operation_kind TEXT NOT NULL CHECK(length(CAST(operation_kind AS BLOB)) BETWEEN 1 AND 120),\n  work_id TEXT REFERENCES works(id) ON DELETE CASCADE,\n  request_digest TEXT NOT NULL CHECK(length(request_digest) = 64 AND request_digest NOT GLOB '*[^0-9a-f]*'),\n  result_json TEXT NOT NULL CHECK(json_valid(result_json) AND length(CAST(result_json AS BLOB)) <= 2097152),\n  created_at INTEGER NOT NULL CHECK(created_at >= 0)\n) STRICT"
    },
    {
      "type": "table",
      "name": "work_members",
      "tbl_name": "work_members",
      "sql": "CREATE TABLE work_members (\n  work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,\n  session_id TEXT NOT NULL REFERENCES sessions(id),\n  joined_at INTEGER NOT NULL CHECK(joined_at >= 0),\n  PRIMARY KEY(work_id,session_id)\n) STRICT"
    },
    {
      "type": "table",
      "name": "work_nested_effect_settlements",
      "tbl_name": "work_nested_effect_settlements",
      "sql": "CREATE TABLE work_nested_effect_settlements (\n  effect_idempotency_key TEXT PRIMARY KEY REFERENCES work_prepared_effects(idempotency_key) ON DELETE CASCADE,\n  nested_mutation_key TEXT NOT NULL UNIQUE CHECK(length(nested_mutation_key) = 36),\n  outcome TEXT NOT NULL CHECK(outcome IN ('accepted','failed')),\n  receipt_json TEXT CHECK(receipt_json IS NULL OR (json_valid(receipt_json) AND length(CAST(receipt_json AS BLOB)) <= 65536)),\n  receipt_digest TEXT NOT NULL CHECK(length(receipt_digest) = 64 AND receipt_digest NOT GLOB '*[^0-9a-f]*'),\n  created_at INTEGER NOT NULL CHECK(created_at >= 0)\n) STRICT"
    },
    {
      "type": "table",
      "name": "work_prepared_effects",
      "tbl_name": "work_prepared_effects",
      "sql": "CREATE TABLE work_prepared_effects (\n  idempotency_key TEXT PRIMARY KEY REFERENCES work_idempotency_intents(idempotency_key) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,\n  work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,\n  effect_kind TEXT NOT NULL CHECK(effect_kind IN ('attempt_dispatch','signal_send')),\n  subject_id TEXT NOT NULL CHECK(length(subject_id) BETWEEN 6 AND 80),\n  instruction_json TEXT NOT NULL CHECK(json_valid(instruction_json) AND length(CAST(instruction_json AS BLOB)) <= 2097152),\n  instruction_digest TEXT NOT NULL CHECK(length(instruction_digest) = 64 AND instruction_digest NOT GLOB '*[^0-9a-f]*'),\n  daemon_generation INTEGER NOT NULL CHECK(daemon_generation >= 0),\n  state TEXT NOT NULL CHECK(state IN ('prepared','effect_started','accepted','failed','unknown')),\n  outcome_digest TEXT CHECK(outcome_digest IS NULL OR (length(outcome_digest) = 64 AND outcome_digest NOT GLOB '*[^0-9a-f]*')),\n  outcome_json TEXT CHECK(outcome_json IS NULL OR (json_valid(outcome_json) AND length(CAST(outcome_json AS BLOB)) <= 65536)),\n  prepared_at INTEGER NOT NULL CHECK(prepared_at >= 0),\n  finalized_at INTEGER CHECK(finalized_at IS NULL OR finalized_at >= prepared_at),\n  CHECK((state IN ('prepared','effect_started') AND outcome_digest IS NULL AND outcome_json IS NULL AND finalized_at IS NULL)\n     OR (state NOT IN ('prepared','effect_started') AND outcome_digest IS NOT NULL AND outcome_json IS NOT NULL AND finalized_at IS NOT NULL))\n) STRICT"
    },
    {
      "type": "table",
      "name": "work_purge_authority",
      "tbl_name": "work_purge_authority",
      "sql": "CREATE TABLE work_purge_authority (\n  singleton INTEGER PRIMARY KEY CHECK(singleton=1),\n  work_id TEXT NOT NULL UNIQUE CHECK(length(work_id) BETWEEN 6 AND 80),\n  idempotency_key TEXT NOT NULL UNIQUE CHECK(length(idempotency_key)=36),\n  created_at INTEGER NOT NULL CHECK(created_at>=0)\n) STRICT"
    },
    {
      "type": "table",
      "name": "work_release_tombstones",
      "tbl_name": "work_release_tombstones",
      "sql": "CREATE TABLE work_release_tombstones (\n  work_id TEXT PRIMARY KEY CHECK(length(work_id) BETWEEN 6 AND 80),\n  release_idempotency_key TEXT NOT NULL UNIQUE CHECK(length(release_idempotency_key)=36),\n  release_request_digest TEXT NOT NULL CHECK(length(release_request_digest)=64 AND release_request_digest NOT GLOB '*[^0-9a-f]*'),\n  client_ref_digest TEXT NOT NULL UNIQUE CHECK(length(client_ref_digest)=64 AND client_ref_digest NOT GLOB '*[^0-9a-f]*'),\n  coordinator_session_id TEXT NOT NULL CHECK(length(coordinator_session_id) BETWEEN 6 AND 80),\n  terminal_kind TEXT NOT NULL CHECK(terminal_kind IN ('work.complete','work.fail','work.cancel')),\n  terminal_request_digest TEXT NOT NULL CHECK(length(terminal_request_digest)=64 AND terminal_request_digest NOT GLOB '*[^0-9a-f]*'),\n  final_revision INTEGER NOT NULL CHECK(final_revision>0),\n  final_head_hash TEXT NOT NULL CHECK(length(final_head_hash)=64 AND final_head_hash NOT GLOB '*[^0-9a-f]*'),\n  discarded_counts_json TEXT NOT NULL CHECK(json_valid(discarded_counts_json) AND length(CAST(discarded_counts_json AS BLOB))<=4096),\n  discarded_records_digest TEXT NOT NULL CHECK(length(discarded_records_digest)=64 AND discarded_records_digest NOT GLOB '*[^0-9a-f]*'),\n  released_at INTEGER NOT NULL CHECK(released_at>=0),\n  retention_upper_bound_at INTEGER NOT NULL CHECK(retention_upper_bound_at>=released_at),\n  result_json TEXT NOT NULL CHECK(json_valid(result_json) AND length(CAST(result_json AS BLOB))<=65536)\n) STRICT"
    },
    {
      "type": "table",
      "name": "work_reviews",
      "tbl_name": "work_reviews",
      "sql": "CREATE TABLE work_reviews (\n  id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 6 AND 80),\n  work_id TEXT NOT NULL,\n  submission_id TEXT NOT NULL,\n  reviewer_session_id TEXT NOT NULL REFERENCES sessions(id),\n  decision TEXT NOT NULL CHECK(decision IN ('accept','revise','reject')),\n  review_json TEXT NOT NULL CHECK(json_valid(review_json) AND length(CAST(review_json AS BLOB)) <= 2097152),\n  review_digest TEXT NOT NULL CHECK(length(review_digest) = 64 AND review_digest NOT GLOB '*[^0-9a-f]*'),\n  created_at INTEGER NOT NULL CHECK(created_at >= 0),\n  UNIQUE(submission_id,reviewer_session_id),\n  UNIQUE(work_id,id),\n  FOREIGN KEY(work_id,submission_id) REFERENCES work_submissions(work_id,id) ON DELETE CASCADE\n) STRICT"
    },
    {
      "type": "table",
      "name": "work_routes",
      "tbl_name": "work_routes",
      "sql": "CREATE TABLE work_routes (\n  work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,\n  ordinal INTEGER NOT NULL CHECK(ordinal >= 0 AND ordinal < 64),\n  account_id TEXT NOT NULL REFERENCES profiles(id),\n  project_id TEXT NOT NULL REFERENCES projects(id),\n  preset TEXT NOT NULL CHECK(preset IN ('low','high','ultra')),\n  fast INTEGER NOT NULL CHECK(fast IN (0,1)),\n  PRIMARY KEY(work_id,account_id,project_id,preset,fast),\n  UNIQUE(work_id,ordinal)\n) STRICT"
    },
    {
      "type": "table",
      "name": "work_signal_receipts",
      "tbl_name": "work_signal_receipts",
      "sql": "CREATE TABLE work_signal_receipts (\n  signal_id TEXT NOT NULL REFERENCES work_signals(id) ON DELETE CASCADE,\n  sequence INTEGER NOT NULL CHECK(sequence > 0),\n  kind TEXT NOT NULL CHECK(kind IN ('accepted','ack','unknown','failed')),\n  actor_session_id TEXT REFERENCES sessions(id),\n  detail_code TEXT CHECK(detail_code IS NULL OR length(CAST(detail_code AS BLOB)) BETWEEN 1 AND 120),\n  recorded_at INTEGER NOT NULL CHECK(recorded_at >= 0),\n  PRIMARY KEY(signal_id,sequence)\n) STRICT"
    },
    {
      "type": "table",
      "name": "work_signals",
      "tbl_name": "work_signals",
      "sql": "CREATE TABLE work_signals (\n  id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 6 AND 80),\n  work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,\n  from_session_id TEXT NOT NULL REFERENCES sessions(id),\n  to_session_id TEXT NOT NULL REFERENCES sessions(id),\n  target_account_generation INTEGER NOT NULL CHECK(target_account_generation >= 0),\n  task_id TEXT,\n  reply_to_signal_id TEXT,\n  mode TEXT NOT NULL CHECK(mode IN ('queue','steer')),\n  body TEXT NOT NULL CHECK(length(CAST(body AS BLOB)) BETWEEN 1 AND 32768),\n  created_at INTEGER NOT NULL CHECK(created_at >= 0),\n  UNIQUE(work_id,id),\n  FOREIGN KEY(work_id,task_id) REFERENCES work_tasks(work_id,id) ON DELETE CASCADE,\n  FOREIGN KEY(work_id,reply_to_signal_id) REFERENCES work_signals(work_id,id) ON DELETE CASCADE\n) STRICT"
    },
    {
      "type": "table",
      "name": "work_submissions",
      "tbl_name": "work_submissions",
      "sql": "CREATE TABLE work_submissions (\n  id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 6 AND 80),\n  work_id TEXT NOT NULL,\n  task_id TEXT NOT NULL,\n  attempt_id TEXT NOT NULL,\n  worker_session_id TEXT NOT NULL REFERENCES sessions(id),\n  summary TEXT NOT NULL CHECK(length(CAST(summary AS BLOB)) BETWEEN 1 AND 16384),\n  result_json TEXT NOT NULL CHECK(json_valid(result_json) AND length(CAST(result_json AS BLOB)) <= 2097152),\n  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json) AND length(CAST(evidence_json AS BLOB)) <= 2097152),\n  content_digest TEXT NOT NULL CHECK(length(content_digest) = 64 AND content_digest NOT GLOB '*[^0-9a-f]*'),\n  created_at INTEGER NOT NULL CHECK(created_at >= 0),\n  UNIQUE(work_id,id),\n  UNIQUE(attempt_id),\n  FOREIGN KEY(work_id,task_id) REFERENCES work_tasks(work_id,id) ON DELETE CASCADE,\n  FOREIGN KEY(work_id,attempt_id) REFERENCES work_attempts(work_id,id) ON DELETE CASCADE\n) STRICT"
    },
    {
      "type": "table",
      "name": "work_task_dependencies",
      "tbl_name": "work_task_dependencies",
      "sql": "CREATE TABLE work_task_dependencies (\n  work_id TEXT NOT NULL,\n  task_id TEXT NOT NULL,\n  dependency_task_id TEXT NOT NULL,\n  ordinal INTEGER NOT NULL CHECK(ordinal >= 0 AND ordinal < 16),\n  created_at INTEGER NOT NULL CHECK(created_at >= 0),\n  PRIMARY KEY(work_id,task_id,dependency_task_id),\n  UNIQUE(work_id,task_id,ordinal),\n  FOREIGN KEY(work_id,task_id) REFERENCES work_tasks(work_id,id) ON DELETE CASCADE,\n  FOREIGN KEY(work_id,dependency_task_id) REFERENCES work_tasks(work_id,id) ON DELETE CASCADE,\n  CHECK(task_id != dependency_task_id)\n) STRICT"
    },
    {
      "type": "table",
      "name": "work_task_history_index",
      "tbl_name": "work_task_history_index",
      "sql": "CREATE TABLE work_task_history_index (\n  ordinal INTEGER PRIMARY KEY AUTOINCREMENT CHECK(ordinal > 0 AND ordinal <= 9007199254740991),\n  work_id TEXT NOT NULL,\n  task_id TEXT NOT NULL,\n  kind TEXT NOT NULL CHECK(kind IN ('attempt','attempt_report','submission','review','signal')),\n  stable_key TEXT NOT NULL CHECK(length(CAST(stable_key AS BLOB)) BETWEEN 6 AND 80),\n  created_at INTEGER NOT NULL CHECK(created_at >= 0),\n  UNIQUE(kind,stable_key),\n  FOREIGN KEY(work_id,task_id) REFERENCES work_tasks(work_id,id) ON DELETE CASCADE\n) STRICT"
    },
    {
      "type": "table",
      "name": "work_task_history_versions",
      "tbl_name": "work_task_history_versions",
      "sql": "CREATE TABLE work_task_history_versions (\n  ordinal INTEGER PRIMARY KEY AUTOINCREMENT CHECK(ordinal > 0 AND ordinal <= 9007199254740991),\n  history_ordinal INTEGER NOT NULL REFERENCES work_task_history_index(ordinal) ON DELETE CASCADE,\n  work_id TEXT NOT NULL,\n  task_id TEXT NOT NULL,\n  event_sequence INTEGER NOT NULL CHECK(event_sequence > 0),\n  record_json TEXT NOT NULL CHECK(\n    json_valid(record_json)\n    AND length(CAST(record_json AS BLOB)) <= 2097152\n  ),\n  record_digest TEXT NOT NULL CHECK(\n    length(record_digest)=64 AND record_digest NOT GLOB '*[^0-9a-f]*'\n  ),\n  created_at INTEGER NOT NULL CHECK(created_at >= 0),\n  UNIQUE(history_ordinal,event_sequence),\n  FOREIGN KEY(work_id,task_id) REFERENCES work_tasks(work_id,id) ON DELETE CASCADE,\n  FOREIGN KEY(work_id,event_sequence) REFERENCES work_events(work_id,sequence)\n    ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED\n) STRICT"
    },
    {
      "type": "table",
      "name": "work_task_states",
      "tbl_name": "work_task_states",
      "sql": "CREATE TABLE work_task_states (\n  task_id TEXT PRIMARY KEY REFERENCES work_tasks(id) ON DELETE CASCADE,\n  work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,\n  state TEXT NOT NULL CHECK(state IN ('pending','claimed','dispatching','running','submitted','completed','failed','recovery_required','cancelled')),\n  revision INTEGER NOT NULL CHECK(revision > 0),\n  next_fence INTEGER NOT NULL CHECK(next_fence > 0),\n  attempt_count INTEGER NOT NULL CHECK(attempt_count >= 0),\n  accepted_submission_id TEXT REFERENCES work_submissions(id) DEFERRABLE INITIALLY DEFERRED,\n  retry_not_before INTEGER CHECK(retry_not_before IS NULL OR retry_not_before >= 0),\n  updated_at INTEGER NOT NULL CHECK(updated_at >= 0),\n  UNIQUE(work_id,task_id),\n  CHECK((state = 'completed' AND accepted_submission_id IS NOT NULL) OR state != 'completed')\n) STRICT"
    },
    {
      "type": "table",
      "name": "work_tasks",
      "tbl_name": "work_tasks",
      "sql": "CREATE TABLE work_tasks (\n  id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 6 AND 80),\n  work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,\n  client_ref TEXT NOT NULL CHECK(length(CAST(client_ref AS BLOB)) BETWEEN 1 AND 256),\n  ordinal INTEGER NOT NULL CHECK(ordinal >= 0 AND ordinal < 256),\n  parent_task_id TEXT,\n  depth INTEGER NOT NULL CHECK(depth BETWEEN 1 AND 8),\n  objective TEXT NOT NULL CHECK(length(CAST(objective AS BLOB)) BETWEEN 1 AND 16384),\n  instructions TEXT NOT NULL CHECK(length(CAST(instructions AS BLOB)) BETWEEN 1 AND 32768),\n  criteria_json TEXT NOT NULL CHECK(json_valid(criteria_json) AND length(CAST(criteria_json AS BLOB)) <= 32768),\n  account_id TEXT NOT NULL REFERENCES profiles(id),\n  project_id TEXT NOT NULL REFERENCES projects(id),\n  preset TEXT NOT NULL CHECK(preset IN ('low','high','ultra')),\n  fast INTEGER NOT NULL CHECK(fast IN (0,1)),\n  priority INTEGER NOT NULL CHECK(priority BETWEEN -100 AND 100),\n  not_before INTEGER CHECK(not_before IS NULL OR not_before >= 0),\n  claim_by INTEGER CHECK(claim_by IS NULL OR claim_by >= 0),\n  deadline INTEGER CHECK(deadline IS NULL OR deadline >= 0),\n  max_attempts INTEGER NOT NULL CHECK(max_attempts BETWEEN 1 AND 32),\n  required_reviews INTEGER NOT NULL CHECK(required_reviews BETWEEN 0 AND 16),\n  result_kind TEXT NOT NULL CHECK(result_kind IN ('text','json')),\n  min_evidence INTEGER NOT NULL CHECK(min_evidence BETWEEN 0 AND 16),\n  created_at INTEGER NOT NULL CHECK(created_at >= 0),\n  UNIQUE(work_id,id),\n  UNIQUE(work_id,client_ref),\n  FOREIGN KEY(work_id,parent_task_id) REFERENCES work_tasks(work_id,id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,\n  FOREIGN KEY(work_id,account_id,project_id,preset,fast)\n    REFERENCES work_routes(work_id,account_id,project_id,preset,fast) ON DELETE CASCADE,\n  CHECK(parent_task_id IS NULL OR parent_task_id != id),\n  CHECK(claim_by IS NULL OR not_before IS NULL OR claim_by > not_before),\n  CHECK(deadline IS NULL OR not_before IS NULL OR deadline > not_before),\n  CHECK(deadline IS NULL OR claim_by IS NULL OR deadline >= claim_by)\n) STRICT"
    },
    {
      "type": "table",
      "name": "work_terminal_requests",
      "tbl_name": "work_terminal_requests",
      "sql": "CREATE TABLE work_terminal_requests (\n  work_id TEXT PRIMARY KEY REFERENCES works(id) ON DELETE CASCADE,\n  idempotency_key TEXT NOT NULL UNIQUE CHECK(length(idempotency_key)=36),\n  kind TEXT NOT NULL CHECK(kind IN ('work.complete','work.fail','work.cancel')),\n  state TEXT NOT NULL CHECK(state IN ('requested','settled')),\n  actor_session_id TEXT NOT NULL REFERENCES sessions(id),\n  summary TEXT NOT NULL CHECK(length(CAST(summary AS BLOB)) BETWEEN 1 AND 16384),\n  result_json TEXT CHECK(result_json IS NULL OR (\n    json_valid(result_json) AND length(CAST(result_json AS BLOB))<=2097152\n  )),\n  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json) AND length(CAST(evidence_json AS BLOB))<=2097152),\n  request_digest TEXT NOT NULL CHECK(length(request_digest)=64 AND request_digest NOT GLOB '*[^0-9a-f]*'),\n  requested_at INTEGER NOT NULL CHECK(requested_at>=0),\n  settled_at INTEGER CHECK(settled_at IS NULL OR settled_at>=requested_at),\n  CHECK((state='requested' AND settled_at IS NULL) OR (state='settled' AND settled_at IS NOT NULL)),\n  CHECK((kind='work.complete' AND (result_json IS NULL OR json_valid(result_json)))\n     OR (kind!='work.complete' AND result_json IS NULL))\n) STRICT"
    },
    {
      "type": "table",
      "name": "works",
      "tbl_name": "works",
      "sql": "CREATE TABLE works (\n  id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 6 AND 80),\n  client_ref TEXT NOT NULL UNIQUE CHECK(length(CAST(client_ref AS BLOB)) BETWEEN 1 AND 256),\n  coordinator_session_id TEXT NOT NULL REFERENCES sessions(id),\n  objective TEXT NOT NULL CHECK(length(CAST(objective AS BLOB)) BETWEEN 1 AND 16384),\n  preset_contract INTEGER NOT NULL DEFAULT 1 CHECK(preset_contract IN (1,2)),\n  state TEXT NOT NULL CHECK(state IN ('active','cancel_pending','fail_pending','completed','failed','cancelled')),\n  revision INTEGER NOT NULL CHECK(revision >= 0),\n  stream_epoch TEXT NOT NULL CHECK(length(stream_epoch) = 36),\n  next_sequence INTEGER NOT NULL CHECK(next_sequence > 0),\n  head_hash TEXT CHECK(head_hash IS NULL OR (length(head_hash) = 64 AND head_hash NOT GLOB '*[^0-9a-f]*')),\n  created_at INTEGER NOT NULL CHECK(created_at >= 0),\n  updated_at INTEGER NOT NULL CHECK(updated_at >= created_at),\n  CHECK((next_sequence = 1 AND head_hash IS NULL) OR (next_sequence > 1 AND head_hash IS NOT NULL))\n) STRICT"
    },
    {
      "type": "trigger",
      "name": "account_rate_limit_reset_attempt_identity_guard",
      "tbl_name": "account_rate_limit_reset_attempts",
      "sql": "CREATE TRIGGER account_rate_limit_reset_attempt_identity_guard\nBEFORE UPDATE OF profile_id,origin_process_generation,account_fingerprint,\n  weekly_window_resets_at,observed_used_percent,created_at\nON account_rate_limit_reset_attempts\nWHEN OLD.profile_id!=NEW.profile_id\n  OR OLD.origin_process_generation!=NEW.origin_process_generation\n  OR OLD.account_fingerprint!=NEW.account_fingerprint\n  OR OLD.weekly_window_resets_at!=NEW.weekly_window_resets_at\n  OR OLD.observed_used_percent!=NEW.observed_used_percent\n  OR OLD.created_at!=NEW.created_at\nBEGIN SELECT RAISE(ABORT, 'account rate-limit reset identity is immutable'); END"
    },
    {
      "type": "trigger",
      "name": "account_rate_limit_reset_attempt_policy_begin_guard",
      "tbl_name": "account_rate_limit_reset_attempts",
      "sql": "CREATE TRIGGER account_rate_limit_reset_attempt_policy_begin_guard\nBEFORE UPDATE OF state ON account_rate_limit_reset_attempts\nWHEN NEW.state='effect_started'\n  AND OLD.state!='effect_started'\n  AND NOT EXISTS (\n    SELECT 1 FROM account_rate_limit_reset_policies p\n    WHERE p.profile_id=OLD.profile_id\n      AND p.state='active_bound'\n      AND p.account_fingerprint=OLD.account_fingerprint\n      AND (\n        (\n          OLD.state IN ('prepared','retryable')\n          AND p.weekly_window_resets_at=OLD.weekly_window_resets_at\n        ) OR (\n          OLD.state='ambiguous'\n          AND p.weekly_window_resets_at>=OLD.weekly_window_resets_at\n        )\n      )\n  )\nBEGIN SELECT RAISE(ABORT, 'account rate-limit reset policy does not authorize dispatch'); END"
    },
    {
      "type": "trigger",
      "name": "account_rate_limit_reset_attempt_policy_close_guard",
      "tbl_name": "account_rate_limit_reset_attempts",
      "sql": "CREATE TRIGGER account_rate_limit_reset_attempt_policy_close_guard\nBEFORE UPDATE OF state ON account_rate_limit_reset_attempts\nWHEN NEW.state='closed'\n  AND OLD.state!='closed'\n  AND NOT EXISTS (\n    SELECT 1 FROM account_rate_limit_reset_policies p\n    WHERE p.profile_id=OLD.profile_id\n      AND (\n        (\n          p.state='active_bound'\n          AND p.account_fingerprint=OLD.account_fingerprint\n          AND p.weekly_window_resets_at>=OLD.weekly_window_resets_at\n        ) OR (\n          NEW.local_resolution='account_identity_changed'\n          AND p.state='window_suppressed'\n        ) OR (\n          NEW.local_resolution='weekly_window_changed'\n          AND p.state='window_suppressed'\n          AND p.account_fingerprint=OLD.account_fingerprint\n          AND p.weekly_window_resets_at>OLD.weekly_window_resets_at\n        )\n      )\n  )\nBEGIN SELECT RAISE(ABORT, 'account rate-limit reset policy does not authorize closure'); END"
    },
    {
      "type": "trigger",
      "name": "account_rate_limit_reset_attempt_policy_insert_guard",
      "tbl_name": "account_rate_limit_reset_attempts",
      "sql": "CREATE TRIGGER account_rate_limit_reset_attempt_policy_insert_guard\nBEFORE INSERT ON account_rate_limit_reset_attempts\nWHEN NOT EXISTS (\n  SELECT 1 FROM account_rate_limit_reset_policies p\n  WHERE p.profile_id=NEW.profile_id\n    AND p.state='active_bound'\n    AND p.account_fingerprint=NEW.account_fingerprint\n    AND p.weekly_window_resets_at=NEW.weekly_window_resets_at\n)\nBEGIN SELECT RAISE(ABORT, 'account rate-limit reset policy does not authorize preparation'); END"
    },
    {
      "type": "trigger",
      "name": "account_rate_limit_reset_attempt_rebind_guard",
      "tbl_name": "account_rate_limit_reset_attempts",
      "sql": "CREATE TRIGGER account_rate_limit_reset_attempt_rebind_guard\nBEFORE UPDATE OF current_process_generation ON account_rate_limit_reset_attempts\nWHEN OLD.current_process_generation!=NEW.current_process_generation\n  AND NOT EXISTS (\n    SELECT 1 FROM account_rate_limit_reset_rebinds r\n    WHERE r.idempotency_key=OLD.idempotency_key\n      AND r.from_process_generation=OLD.current_process_generation\n      AND r.to_process_generation=NEW.current_process_generation\n      AND r.account_fingerprint=OLD.account_fingerprint\n  )\nBEGIN SELECT RAISE(ABORT, 'account rate-limit reset rebind evidence is missing'); END"
    },
    {
      "type": "trigger",
      "name": "account_rate_limit_reset_attempt_terminal_evidence_guard",
      "tbl_name": "account_rate_limit_reset_attempts",
      "sql": "CREATE TRIGGER account_rate_limit_reset_attempt_terminal_evidence_guard\nBEFORE UPDATE OF outcome,local_resolution ON account_rate_limit_reset_attempts\nWHEN OLD.state IN ('settled','closed')\n  AND (\n    OLD.outcome IS NOT NEW.outcome\n    OR OLD.local_resolution IS NOT NEW.local_resolution\n  )\nBEGIN SELECT RAISE(ABORT, 'account rate-limit reset terminal evidence is immutable'); END"
    },
    {
      "type": "trigger",
      "name": "account_rate_limit_reset_attempt_transition_guard",
      "tbl_name": "account_rate_limit_reset_attempts",
      "sql": "CREATE TRIGGER account_rate_limit_reset_attempt_transition_guard\nBEFORE UPDATE OF state ON account_rate_limit_reset_attempts\nWHEN NOT (\n  (OLD.state='prepared' AND NEW.state='effect_started') OR\n  (OLD.state='effect_started' AND NEW.state IN ('ambiguous','retryable','settled')) OR\n  (OLD.state IN ('ambiguous','retryable') AND NEW.state='effect_started') OR\n  (OLD.state IN ('prepared','retryable') AND NEW.state='closed') OR\n  (\n    OLD.state='ambiguous'\n    AND NEW.state='closed'\n    AND NEW.local_resolution='account_identity_changed'\n  ) OR\n  OLD.state=NEW.state\n)\nBEGIN SELECT RAISE(ABORT, 'illegal account rate-limit reset transition'); END"
    },
    {
      "type": "trigger",
      "name": "account_rate_limit_reset_policy_delete_guard",
      "tbl_name": "account_rate_limit_reset_policies",
      "sql": "CREATE TRIGGER account_rate_limit_reset_policy_delete_guard\nBEFORE DELETE ON account_rate_limit_reset_policies\nWHEN EXISTS (\n  SELECT 1 FROM profiles p WHERE p.id=OLD.profile_id AND p.state!='removed'\n)\nBEGIN SELECT RAISE(ABORT, 'account rate-limit reset policy is required'); END"
    },
    {
      "type": "trigger",
      "name": "account_rate_limit_reset_policy_insert_guard",
      "tbl_name": "account_rate_limit_reset_policies",
      "sql": "CREATE TRIGGER account_rate_limit_reset_policy_insert_guard\nBEFORE INSERT ON account_rate_limit_reset_policies\nWHEN NEW.state NOT IN ('active_unbound','reconciliation_required')\n  OR NOT EXISTS (\n    SELECT 1 FROM profiles p\n    WHERE p.id=NEW.profile_id AND p.state!='removed'\n  )\nBEGIN SELECT RAISE(ABORT, 'account rate-limit reset policy insert is invalid'); END"
    },
    {
      "type": "trigger",
      "name": "account_rate_limit_reset_policy_transition_guard",
      "tbl_name": "account_rate_limit_reset_policies",
      "sql": "CREATE TRIGGER account_rate_limit_reset_policy_transition_guard\nBEFORE UPDATE ON account_rate_limit_reset_policies\nWHEN NEW.profile_id!=OLD.profile_id\n  OR NEW.created_at!=OLD.created_at\n  OR NEW.revision!=OLD.revision+1\n  OR NEW.updated_at<OLD.updated_at\n  OR NOT (\n    (\n      OLD.state='active_unbound'\n      AND NEW.state='active_bound'\n    ) OR (\n      OLD.state='reconciliation_required'\n      AND NEW.state='window_suppressed'\n    ) OR (\n      OLD.state='window_suppressed'\n      AND NEW.state='active_bound'\n      AND NEW.account_fingerprint=OLD.account_fingerprint\n      AND NEW.weekly_window_resets_at>OLD.weekly_window_resets_at\n      AND NEW.updated_at>=OLD.weekly_window_resets_at\n    ) OR (\n      OLD.state IN (\n        'active_unbound','reconciliation_required','window_suppressed','active_bound'\n      )\n      AND NEW.state='reconciliation_required'\n    ) OR (\n      OLD.state='active_bound'\n      AND NEW.state='active_bound'\n      AND NEW.account_fingerprint=OLD.account_fingerprint\n      AND NEW.weekly_window_resets_at>OLD.weekly_window_resets_at\n    )\n  )\nBEGIN SELECT RAISE(ABORT, 'illegal account rate-limit reset policy transition'); END"
    },
    {
      "type": "trigger",
      "name": "account_rate_limit_reset_rebind_delete_guard",
      "tbl_name": "account_rate_limit_reset_rebinds",
      "sql": "CREATE TRIGGER account_rate_limit_reset_rebind_delete_guard\nBEFORE DELETE ON account_rate_limit_reset_rebinds\nWHEN EXISTS (\n  SELECT 1 FROM account_rate_limit_reset_attempts a\n  WHERE a.idempotency_key=OLD.idempotency_key\n)\nBEGIN SELECT RAISE(ABORT, 'account rate-limit reset rebind evidence is append-only'); END"
    },
    {
      "type": "trigger",
      "name": "account_rate_limit_reset_rebind_insert_guard",
      "tbl_name": "account_rate_limit_reset_rebinds",
      "sql": "CREATE TRIGGER account_rate_limit_reset_rebind_insert_guard\nBEFORE INSERT ON account_rate_limit_reset_rebinds\nWHEN NOT EXISTS (\n  SELECT 1 FROM account_rate_limit_reset_attempts a\n  WHERE a.idempotency_key=NEW.idempotency_key\n    AND a.current_process_generation=NEW.from_process_generation\n    AND a.account_fingerprint=NEW.account_fingerprint\n    AND a.state IN ('prepared','ambiguous','retryable')\n)\nBEGIN SELECT RAISE(ABORT, 'account rate-limit reset rebind authority is invalid'); END"
    },
    {
      "type": "trigger",
      "name": "account_rate_limit_reset_rebind_policy_guard",
      "tbl_name": "account_rate_limit_reset_rebinds",
      "sql": "CREATE TRIGGER account_rate_limit_reset_rebind_policy_guard\nBEFORE INSERT ON account_rate_limit_reset_rebinds\nWHEN NOT EXISTS (\n  SELECT 1\n  FROM account_rate_limit_reset_attempts a\n  JOIN account_rate_limit_reset_policies p ON p.profile_id=a.profile_id\n  WHERE a.idempotency_key=NEW.idempotency_key\n    AND p.state='active_bound'\n    AND p.account_fingerprint=a.account_fingerprint\n    AND (\n      (\n        a.state IN ('prepared','retryable')\n        AND p.weekly_window_resets_at=a.weekly_window_resets_at\n      ) OR (\n        a.state='ambiguous'\n        AND p.weekly_window_resets_at>=a.weekly_window_resets_at\n      )\n    )\n)\nBEGIN SELECT RAISE(ABORT, 'account rate-limit reset policy does not authorize rebind'); END"
    },
    {
      "type": "trigger",
      "name": "account_rate_limit_reset_rebind_update_guard",
      "tbl_name": "account_rate_limit_reset_rebinds",
      "sql": "CREATE TRIGGER account_rate_limit_reset_rebind_update_guard\nBEFORE UPDATE ON account_rate_limit_reset_rebinds\nBEGIN SELECT RAISE(ABORT, 'account rate-limit reset rebind evidence is append-only'); END"
    },
    {
      "type": "trigger",
      "name": "attention_email_policy_delete_guard",
      "tbl_name": "attention_email_policy",
      "sql": "CREATE TRIGGER attention_email_policy_delete_guard\nBEFORE DELETE ON attention_email_policy\nBEGIN SELECT RAISE(ABORT, 'attention email policy cannot be deleted'); END"
    },
    {
      "type": "trigger",
      "name": "attention_email_policy_insert_guard",
      "tbl_name": "attention_email_policy",
      "sql": "CREATE TRIGGER attention_email_policy_insert_guard\nBEFORE INSERT ON attention_email_policy\nWHEN EXISTS(SELECT 1 FROM attention_email_policy WHERE singleton=1)\nBEGIN SELECT RAISE(ABORT, 'attention email policy already exists'); END"
    },
    {
      "type": "trigger",
      "name": "attention_email_policy_update_guard",
      "tbl_name": "attention_email_policy",
      "sql": "CREATE TRIGGER attention_email_policy_update_guard\nBEFORE UPDATE ON attention_email_policy\nWHEN NEW.singleton != OLD.singleton\n  OR NEW.version != OLD.version\n  OR NEW.created_at != OLD.created_at\n  OR NEW.revision != OLD.revision + 1\n  OR NEW.updated_at < OLD.updated_at\nBEGIN SELECT RAISE(ABORT, 'invalid attention email policy transition'); END"
    },
    {
      "type": "trigger",
      "name": "canonical_memory_sync_share_fence",
      "tbl_name": "memory_submissions",
      "sql": "CREATE TRIGGER canonical_memory_sync_share_fence\nBEFORE INSERT ON memory_submissions\nWHEN NEW.kind='share' AND (\n  EXISTS (\n    SELECT 1 FROM project_memory_authorities authority\n    WHERE authority.project_id=NEW.project_id\n      AND authority.sync_state IN ('conflict','error')\n  )\n  OR EXISTS (\n    SELECT 1 FROM project_memory_hosted_create_intents create_intent\n    WHERE create_intent.project_id=NEW.project_id\n      AND create_intent.state IN (\n        'allocating','key_staged','prepared','effect_started','winner_observed'\n      )\n  )\n  OR EXISTS (\n    SELECT 1 FROM project_memory_hosted_attachments attachment\n    WHERE attachment.project_id=NEW.project_id\n      AND (\n        attachment.state IN ('conflict','error')\n        OR EXISTS (\n          SELECT 1 FROM project_memory_sync_intents intent\n          WHERE intent.project_id=attachment.project_id\n            AND intent.state IN ('prepared','effect_started','response_observed')\n        )\n      )\n  )\n)\nBEGIN SELECT RAISE(ABORT, 'canonical memory mutation fenced by hosted sync'); END"
    },
    {
      "type": "trigger",
      "name": "desktop_switch_resolutions_immutable_delete",
      "tbl_name": "desktop_switch_resolutions",
      "sql": "CREATE TRIGGER desktop_switch_resolutions_immutable_delete\nBEFORE DELETE ON desktop_switch_resolutions\nBEGIN SELECT RAISE(ABORT, 'desktop switch resolution is immutable'); END"
    },
    {
      "type": "trigger",
      "name": "desktop_switch_resolutions_immutable_update",
      "tbl_name": "desktop_switch_resolutions",
      "sql": "CREATE TRIGGER desktop_switch_resolutions_immutable_update\nBEFORE UPDATE ON desktop_switch_resolutions\nBEGIN SELECT RAISE(ABORT, 'desktop switch resolution is immutable'); END"
    },
    {
      "type": "trigger",
      "name": "desktop_switch_transition_guard",
      "tbl_name": "desktop_switches",
      "sql": "CREATE TRIGGER desktop_switch_transition_guard BEFORE UPDATE OF phase ON desktop_switches\nWHEN NOT (\n  (OLD.phase = 'prepared' AND NEW.phase IN ('prepared','quit_started','launch_started','failed','ambiguous')) OR\n  (OLD.phase = 'quit_started' AND NEW.phase IN ('quit_started','quit_confirmed','ambiguous')) OR\n  (OLD.phase = 'quit_confirmed' AND NEW.phase IN ('quit_confirmed','launch_started','ambiguous')) OR\n  (OLD.phase = 'launch_started' AND NEW.phase IN ('launch_started','verify_started','ambiguous')) OR\n  (OLD.phase = 'verify_started' AND NEW.phase IN ('verify_started','applied','ambiguous')) OR\n  OLD.phase = NEW.phase\n)\nBEGIN SELECT RAISE(ABORT, 'illegal desktop switch transition'); END"
    },
    {
      "type": "trigger",
      "name": "detached_personal_session_active_state_guard",
      "tbl_name": "sessions",
      "sql": "CREATE TRIGGER detached_personal_session_active_state_guard\nBEFORE UPDATE OF state,active_turn_id ON sessions\nWHEN (NEW.state='active' OR NEW.active_turn_id IS NOT NULL) AND EXISTS(\n  SELECT 1 FROM session_personal_runtime_bindings b\n  WHERE b.session_id=NEW.id\n    AND b.state!='active'\n    AND b.provider=NEW.provider_v39\n    AND b.provider_thread_id=NEW.provider_thread_id\n)\nBEGIN SELECT RAISE(ABORT, 'detached personal session cannot become active'); END"
    },
    {
      "type": "trigger",
      "name": "detached_personal_session_interaction_guard",
      "tbl_name": "provider_interactions",
      "sql": "CREATE TRIGGER detached_personal_session_interaction_guard\nBEFORE INSERT ON provider_interactions\nWHEN NEW.session_id IS NOT NULL AND EXISTS(\n  SELECT 1 FROM session_personal_runtime_bindings b\n  JOIN sessions s ON s.id=b.session_id\n  WHERE b.session_id=NEW.session_id\n    AND b.state!='active'\n    AND b.provider=s.provider_v39\n    AND b.provider_thread_id=s.provider_thread_id\n)\nBEGIN SELECT RAISE(ABORT, 'detached personal session cannot accept provider interactions'); END"
    },
    {
      "type": "trigger",
      "name": "detached_personal_session_queue_guard",
      "tbl_name": "queue_entries",
      "sql": "CREATE TRIGGER detached_personal_session_queue_guard\nBEFORE INSERT ON queue_entries\nWHEN EXISTS(\n  SELECT 1 FROM session_personal_runtime_bindings b\n  JOIN sessions s ON s.id=b.session_id\n  WHERE b.session_id=NEW.session_id\n    AND b.state!='active'\n    AND b.provider=s.provider_v39\n    AND b.provider_thread_id=s.provider_thread_id\n)\nBEGIN SELECT RAISE(ABORT, 'detached personal session cannot accept queued work'); END"
    },
    {
      "type": "trigger",
      "name": "detached_personal_session_task_insert_guard",
      "tbl_name": "session_tasks",
      "sql": "CREATE TRIGGER detached_personal_session_task_insert_guard\nBEFORE INSERT ON session_tasks\nWHEN NEW.status='active' AND EXISTS(\n  SELECT 1 FROM session_personal_runtime_bindings b\n  JOIN sessions s ON s.id=b.session_id\n  WHERE b.session_id=NEW.session_id\n    AND b.state!='active'\n    AND b.provider=s.provider_v39\n    AND b.provider_thread_id=s.provider_thread_id\n)\nBEGIN SELECT RAISE(ABORT, 'detached personal session cannot activate scheduled work'); END"
    },
    {
      "type": "trigger",
      "name": "detached_personal_session_task_update_guard",
      "tbl_name": "session_tasks",
      "sql": "CREATE TRIGGER detached_personal_session_task_update_guard\nBEFORE UPDATE OF status ON session_tasks\nWHEN NEW.status='active' AND EXISTS(\n  SELECT 1 FROM session_personal_runtime_bindings b\n  JOIN sessions s ON s.id=b.session_id\n  WHERE b.session_id=NEW.session_id\n    AND b.state!='active'\n    AND b.provider=s.provider_v39\n    AND b.provider_thread_id=s.provider_thread_id\n)\nBEGIN SELECT RAISE(ABORT, 'detached personal session cannot activate scheduled work'); END"
    },
    {
      "type": "trigger",
      "name": "memory_page_attestation_delete_guard",
      "tbl_name": "memory_page_attestations",
      "sql": "CREATE TRIGGER memory_page_attestation_delete_guard\nBEFORE DELETE ON memory_page_attestations\nWHEN EXISTS (\n  SELECT 1 FROM memory_page_attestation_refs reference\n  WHERE reference.attestation_sha256=OLD.attestation_sha256\n)\nBEGIN SELECT RAISE(ABORT, 'referenced memory page attestation'); END"
    },
    {
      "type": "trigger",
      "name": "memory_page_attestation_insert_guard",
      "tbl_name": "memory_page_attestations",
      "sql": "CREATE TRIGGER memory_page_attestation_insert_guard\nBEFORE INSERT ON memory_page_attestations\nWHEN NOT EXISTS (\n  SELECT 1 FROM memory_submissions submission\n  WHERE submission.id=NEW.submission_id\n    AND submission.idempotency_key=NEW.idempotency_key\n    AND submission.kind='remember'\n    AND submission.actor_session_id=NEW.actor_session_id\n    AND submission.project_id=NEW.project_id\n    AND submission.request_digest=NEW.request_digest\n    AND submission.content_digest=NEW.content_digest\n    AND submission.key_digest=NEW.key_digest\n    AND submission.working_binding_digest=NEW.working_binding_digest\n    AND submission.working_epoch=NEW.working_epoch\n    AND submission.effect_record_sha256=NEW.effect_record_sha256\n    AND submission.attestation_sha256=NEW.attestation_sha256\n    AND submission.state='applied'\n    AND submission.outcome_code='remember_committed'\n    AND submission.created_at=NEW.created_at\n)\nBEGIN SELECT RAISE(ABORT, 'invalid memory page attestation'); END"
    },
    {
      "type": "trigger",
      "name": "memory_page_attestation_ref_insert_guard",
      "tbl_name": "memory_page_attestation_refs",
      "sql": "CREATE TRIGGER memory_page_attestation_ref_insert_guard\nBEFORE INSERT ON memory_page_attestation_refs\nWHEN NOT EXISTS (\n  SELECT 1 FROM memory_page_attestations attestation\n  WHERE attestation.attestation_sha256=NEW.attestation_sha256\n    AND attestation.project_id=NEW.project_id\n    AND attestation.key_digest=NEW.key_digest\n) OR (\n  NEW.lane='working'\n  AND NOT EXISTS (\n    SELECT 1 FROM memory_working_attestation_heads head\n    WHERE head.authority_digest=NEW.authority_digest\n  )\n  AND NOT EXISTS (\n    SELECT 1 FROM memory_working_attestation_forks fork\n    WHERE fork.child_authority_digest=NEW.authority_digest\n  )\n) OR (\n  NEW.lane='working'\n  AND NOT EXISTS (\n    SELECT 1 FROM memory_page_attestations attestation\n    WHERE attestation.attestation_sha256=NEW.attestation_sha256\n      AND (\n        attestation.working_binding_digest=NEW.authority_digest\n        OR EXISTS (\n          SELECT 1 FROM memory_page_attestation_refs source\n          WHERE source.lane='working'\n            AND source.attestation_sha256=NEW.attestation_sha256\n            AND source.project_id=NEW.project_id\n            AND source.key_digest=NEW.key_digest\n        )\n      )\n  )\n) OR (\n  NEW.lane='canonical'\n  AND NOT EXISTS (\n    SELECT 1 FROM project_memory_authorities authority\n    WHERE authority.project_id=NEW.project_id\n      AND authority.authority_digest=NEW.authority_digest\n  )\n) OR (\n  SELECT COUNT(*) FROM memory_page_attestation_refs reference\n  WHERE reference.lane=NEW.lane\n    AND reference.authority_digest=NEW.authority_digest\n)>=8192\nAND NOT EXISTS (\n  SELECT 1 FROM memory_page_attestation_refs current\n  WHERE current.lane=NEW.lane\n    AND current.authority_digest=NEW.authority_digest\n    AND current.key_digest=NEW.key_digest\n)\nBEGIN SELECT RAISE(ABORT, 'invalid memory page attestation reference'); END"
    },
    {
      "type": "trigger",
      "name": "memory_page_attestation_ref_update_guard",
      "tbl_name": "memory_page_attestation_refs",
      "sql": "CREATE TRIGGER memory_page_attestation_ref_update_guard\nBEFORE UPDATE ON memory_page_attestation_refs\nWHEN NOT (\n  NEW.lane=OLD.lane\n  AND NEW.authority_digest=OLD.authority_digest\n  AND (NEW.project_id=OLD.project_id OR OLD.lane='working')\n  AND NEW.key_digest=OLD.key_digest\n  AND NEW.updated_at>=OLD.updated_at\n  AND EXISTS (\n    SELECT 1 FROM memory_page_attestations attestation\n    WHERE attestation.attestation_sha256=NEW.attestation_sha256\n      AND attestation.project_id=NEW.project_id\n      AND attestation.key_digest=NEW.key_digest\n  )\n  AND (\n    NEW.lane!='working'\n    OR EXISTS (\n      SELECT 1 FROM memory_working_attestation_heads head\n      WHERE head.authority_digest=NEW.authority_digest\n    )\n    OR EXISTS (\n      SELECT 1 FROM memory_working_attestation_forks fork\n      WHERE fork.child_authority_digest=NEW.authority_digest\n    )\n  )\n  AND (\n    NEW.lane!='working'\n    OR NEW.attestation_sha256=OLD.attestation_sha256\n    OR EXISTS (\n      SELECT 1 FROM memory_page_attestations attestation\n      WHERE attestation.attestation_sha256=NEW.attestation_sha256\n        AND attestation.working_binding_digest=NEW.authority_digest\n    )\n  )\n  AND (\n    NEW.lane!='canonical'\n    OR EXISTS (\n      SELECT 1 FROM project_memory_authorities authority\n      WHERE authority.project_id=NEW.project_id\n        AND authority.authority_digest=NEW.authority_digest\n    )\n  )\n)\nBEGIN SELECT RAISE(ABORT, 'invalid memory page attestation reference transition'); END"
    },
    {
      "type": "trigger",
      "name": "memory_page_attestation_update_guard",
      "tbl_name": "memory_page_attestations",
      "sql": "CREATE TRIGGER memory_page_attestation_update_guard\nBEFORE UPDATE ON memory_page_attestations\nBEGIN SELECT RAISE(ABORT, 'memory page attestations are immutable'); END"
    },
    {
      "type": "trigger",
      "name": "memory_submission_delete_guard",
      "tbl_name": "memory_submissions",
      "sql": "CREATE TRIGGER memory_submission_delete_guard\nBEFORE DELETE ON memory_submissions\nWHEN OLD.state IN ('prepared','effect_started','ambiguous')\nBEGIN SELECT RAISE(ABORT, 'memory submissions are immutable'); END"
    },
    {
      "type": "trigger",
      "name": "memory_submission_insert_guard",
      "tbl_name": "memory_submissions",
      "sql": "CREATE TRIGGER memory_submission_insert_guard\nBEFORE INSERT ON memory_submissions\nWHEN NEW.state!='prepared'\n  OR NEW.effect_record_sha256 IS NOT NULL\n  OR NEW.attestation_sha256 IS NOT NULL\n  OR NEW.operation_id IS NOT NULL\n  OR NEW.source_head_sequence IS NOT NULL\n  OR NEW.source_head_operation_sha256 IS NOT NULL\n  OR NEW.source_head_digest IS NOT NULL\n  OR NEW.nomination_sha256 IS NOT NULL\n  OR NEW.result_head_sequence IS NOT NULL\n  OR NEW.result_head_operation_sha256 IS NOT NULL\n  OR NEW.result_head_digest IS NOT NULL\n  OR NEW.receipt_digest IS NOT NULL\n  OR NEW.outcome_code IS NOT NULL\n  OR NEW.conflict_actual_head_sequence IS NOT NULL\n  OR NEW.conflict_actual_head_operation_sha256 IS NOT NULL\n  OR NEW.conflict_actual_head_digest IS NOT NULL\n  OR NEW.conflict_canonical_record_sha256 IS NOT NULL\n  OR NEW.conflict_nominated_record_sha256 IS NOT NULL\nBEGIN SELECT RAISE(ABORT, 'illegal memory submission insertion'); END"
    },
    {
      "type": "trigger",
      "name": "memory_submission_retained_quota",
      "tbl_name": "memory_submissions",
      "sql": "CREATE TRIGGER memory_submission_retained_quota\nBEFORE INSERT ON memory_submissions\nWHEN (\n  SELECT COUNT(*) FROM memory_submissions WHERE project_id=NEW.project_id\n)>=10000\nBEGIN SELECT RAISE(ABORT, 'memory submission retained quota exceeded'); END"
    },
    {
      "type": "trigger",
      "name": "memory_submission_transition_guard",
      "tbl_name": "memory_submissions",
      "sql": "CREATE TRIGGER memory_submission_transition_guard\nBEFORE UPDATE ON memory_submissions\nWHEN NOT (\n  NEW.id=OLD.id\n  AND NEW.idempotency_key=OLD.idempotency_key\n  AND NEW.kind=OLD.kind\n  AND NEW.actor_session_id=OLD.actor_session_id\n  AND NEW.project_id=OLD.project_id\n  AND NEW.request_digest=OLD.request_digest\n  AND NEW.content_digest=OLD.content_digest\n  AND NEW.key_digest=OLD.key_digest\n  AND NEW.working_binding_digest=OLD.working_binding_digest\n  AND NEW.working_epoch=OLD.working_epoch\n  AND (\n    (\n      NEW.effect_record_sha256 IS OLD.effect_record_sha256\n      AND NEW.attestation_sha256 IS OLD.attestation_sha256\n      AND NEW.operation_id IS OLD.operation_id\n      AND NEW.source_head_sequence IS OLD.source_head_sequence\n      AND NEW.source_head_operation_sha256 IS OLD.source_head_operation_sha256\n      AND NEW.source_head_digest IS OLD.source_head_digest\n      AND NEW.nomination_sha256 IS OLD.nomination_sha256\n    )\n    OR (\n      OLD.state='prepared'\n      AND NEW.state='prepared'\n      AND OLD.effect_record_sha256 IS NULL\n      AND OLD.attestation_sha256 IS NULL\n      AND OLD.operation_id IS NULL\n      AND OLD.source_head_sequence IS NULL\n      AND OLD.source_head_operation_sha256 IS NULL\n      AND OLD.source_head_digest IS NULL\n      AND OLD.nomination_sha256 IS NULL\n      AND NEW.effect_record_sha256 IS NOT NULL\n      AND NEW.attestation_sha256 IS NOT NULL\n      AND NEW.operation_id IS NOT NULL\n    )\n  )\n  AND NEW.expected_head_sequence=OLD.expected_head_sequence\n  AND NEW.expected_head_operation_sha256 IS OLD.expected_head_operation_sha256\n  AND NEW.expected_head_digest=OLD.expected_head_digest\n  AND NEW.created_at=OLD.created_at\n  AND NEW.updated_at>=OLD.updated_at\n  AND (OLD.result_head_sequence IS NULL OR NEW.result_head_sequence=OLD.result_head_sequence)\n  AND (OLD.result_head_operation_sha256 IS NULL OR NEW.result_head_operation_sha256 IS OLD.result_head_operation_sha256)\n  AND (OLD.result_head_digest IS NULL OR NEW.result_head_digest IS OLD.result_head_digest)\n  AND (OLD.receipt_digest IS NULL OR NEW.receipt_digest IS OLD.receipt_digest)\n  AND (OLD.outcome_code IS NULL OR NEW.outcome_code=OLD.outcome_code)\n  AND (OLD.conflict_actual_head_sequence IS NULL OR NEW.conflict_actual_head_sequence=OLD.conflict_actual_head_sequence)\n  AND (OLD.conflict_actual_head_operation_sha256 IS NULL OR NEW.conflict_actual_head_operation_sha256 IS OLD.conflict_actual_head_operation_sha256)\n  AND (OLD.conflict_actual_head_digest IS NULL OR NEW.conflict_actual_head_digest=OLD.conflict_actual_head_digest)\n  AND (OLD.conflict_canonical_record_sha256 IS NULL OR NEW.conflict_canonical_record_sha256 IS OLD.conflict_canonical_record_sha256)\n  AND (OLD.conflict_nominated_record_sha256 IS NULL OR NEW.conflict_nominated_record_sha256=OLD.conflict_nominated_record_sha256)\n  AND (\n    NEW.state=OLD.state\n    OR (OLD.state='prepared' AND NEW.state IN ('effect_started','cancelled'))\n    OR (OLD.state='effect_started' AND NEW.state IN ('applied','failed','ambiguous'))\n    OR (OLD.state='ambiguous' AND NEW.state IN ('applied','failed'))\n  )\n  AND ((NEW.state='applied') = (NEW.result_head_sequence IS NOT NULL))\n  AND ((NEW.state IN ('applied','failed')) = (NEW.outcome_code IS NOT NULL))\n  AND (\n    NEW.state!='applied'\n    OR (OLD.kind='remember' AND NEW.outcome_code='remember_committed'\n      AND NEW.result_head_sequence=OLD.expected_head_sequence+1)\n    OR (OLD.kind='share' AND NEW.outcome_code='share_adopted'\n      AND NEW.result_head_sequence=OLD.expected_head_sequence+1)\n    OR (OLD.kind='share' AND NEW.outcome_code='share_already_present'\n      AND NEW.result_head_sequence=OLD.expected_head_sequence\n      AND NEW.result_head_operation_sha256 IS OLD.expected_head_operation_sha256\n      AND NEW.result_head_digest=OLD.expected_head_digest)\n  )\n  AND (\n    NEW.state!='failed'\n    OR (OLD.kind='remember' AND NEW.outcome_code='remember_not_applied')\n    OR (OLD.kind='share' AND NEW.outcome_code IN ('share_conflict','share_not_applied','share_too_large'))\n  )\n)\nBEGIN SELECT RAISE(ABORT, 'illegal memory submission transition'); END"
    },
    {
      "type": "trigger",
      "name": "memory_working_attestation_fork_delete_guard",
      "tbl_name": "memory_working_attestation_forks",
      "sql": "CREATE TRIGGER memory_working_attestation_fork_delete_guard\nBEFORE DELETE ON memory_working_attestation_forks\nWHEN EXISTS (\n  SELECT 1 FROM memory_page_attestation_refs reference\n  WHERE reference.lane='working'\n    AND reference.authority_digest=OLD.child_authority_digest\n) AND NOT EXISTS (\n  SELECT 1 FROM memory_working_attestation_heads child\n  WHERE child.authority_digest=OLD.child_authority_digest\n    AND child.origin='fork'\n    AND child.fork_parent_authority_digest=OLD.parent_authority_digest\n    AND child.fork_parent_head_sequence=OLD.parent_head_sequence\n    AND child.fork_parent_head_operation_sha256 IS OLD.parent_head_operation_sha256\n    AND child.fork_parent_head_digest=OLD.parent_head_digest\n)\nBEGIN SELECT RAISE(ABORT, 'unfinalized memory working attestation fork'); END"
    },
    {
      "type": "trigger",
      "name": "memory_working_attestation_fork_insert_guard",
      "tbl_name": "memory_working_attestation_forks",
      "sql": "CREATE TRIGGER memory_working_attestation_fork_insert_guard\nBEFORE INSERT ON memory_working_attestation_forks\nWHEN EXISTS (\n  SELECT 1 FROM memory_working_attestation_heads child\n  WHERE child.authority_digest=NEW.child_authority_digest\n) OR EXISTS (\n  SELECT 1 FROM memory_page_attestation_refs child\n  WHERE child.lane='working' AND child.authority_digest=NEW.child_authority_digest\n) OR NOT (\n  EXISTS (\n    SELECT 1 FROM memory_working_attestation_heads parent\n    WHERE parent.authority_digest=NEW.parent_authority_digest\n      AND parent.head_sequence=NEW.parent_head_sequence\n      AND parent.head_operation_sha256 IS NEW.parent_head_operation_sha256\n      AND parent.head_digest=NEW.parent_head_digest\n  )\n  OR (\n    NEW.parent_head_sequence=0\n    AND NOT EXISTS (\n      SELECT 1 FROM memory_working_attestation_heads parent\n      WHERE parent.authority_digest=NEW.parent_authority_digest\n    )\n    AND NOT EXISTS (\n      SELECT 1 FROM memory_page_attestation_refs reference\n      WHERE reference.lane='working'\n        AND reference.authority_digest=NEW.parent_authority_digest\n    )\n  )\n)\nBEGIN SELECT RAISE(ABORT, 'invalid memory working attestation fork insertion'); END"
    },
    {
      "type": "trigger",
      "name": "memory_working_attestation_fork_update_guard",
      "tbl_name": "memory_working_attestation_forks",
      "sql": "CREATE TRIGGER memory_working_attestation_fork_update_guard\nBEFORE UPDATE ON memory_working_attestation_forks\nBEGIN SELECT RAISE(ABORT, 'memory working attestation forks are immutable'); END"
    },
    {
      "type": "trigger",
      "name": "memory_working_attestation_head_delete_guard",
      "tbl_name": "memory_working_attestation_heads",
      "sql": "CREATE TRIGGER memory_working_attestation_head_delete_guard\nBEFORE DELETE ON memory_working_attestation_heads\nWHEN EXISTS (\n  SELECT 1 FROM memory_page_attestation_refs reference\n  WHERE reference.lane='working' AND reference.authority_digest=OLD.authority_digest\n)\nBEGIN SELECT RAISE(ABORT, 'referenced memory working attestation head'); END"
    },
    {
      "type": "trigger",
      "name": "memory_working_attestation_head_insert_guard",
      "tbl_name": "memory_working_attestation_heads",
      "sql": "CREATE TRIGGER memory_working_attestation_head_insert_guard\nBEFORE INSERT ON memory_working_attestation_heads\nWHEN (\n  NEW.origin='create'\n  AND NOT EXISTS (\n    SELECT 1 FROM memory_submissions submission\n    WHERE submission.kind='remember'\n      AND submission.working_binding_digest=NEW.authority_digest\n      AND submission.state='applied'\n      AND submission.outcome_code='remember_committed'\n      AND submission.result_head_sequence=NEW.head_sequence\n      AND submission.result_head_operation_sha256 IS NEW.head_operation_sha256\n      AND submission.result_head_digest=NEW.head_digest\n  )\n) OR (\n  NEW.origin='fork'\n  AND (\n    NEW.head_sequence!=NEW.fork_child_head_sequence\n    OR NEW.head_operation_sha256 IS NOT NEW.fork_child_head_operation_sha256\n    OR NEW.head_digest!=NEW.fork_child_head_digest\n    OR NOT EXISTS (\n      SELECT 1 FROM memory_working_attestation_forks fork\n      WHERE fork.child_authority_digest=NEW.authority_digest\n        AND fork.parent_authority_digest=NEW.fork_parent_authority_digest\n        AND fork.parent_head_sequence=NEW.fork_parent_head_sequence\n        AND fork.parent_head_operation_sha256 IS NEW.fork_parent_head_operation_sha256\n        AND fork.parent_head_digest=NEW.fork_parent_head_digest\n    )\n  )\n)\nBEGIN SELECT RAISE(ABORT, 'invalid memory working attestation head insertion'); END"
    },
    {
      "type": "trigger",
      "name": "memory_working_attestation_head_update_guard",
      "tbl_name": "memory_working_attestation_heads",
      "sql": "CREATE TRIGGER memory_working_attestation_head_update_guard\nBEFORE UPDATE ON memory_working_attestation_heads\nWHEN NOT (\n  NEW.authority_digest=OLD.authority_digest\n  AND NEW.origin=OLD.origin\n  AND NEW.fork_child_head_sequence IS OLD.fork_child_head_sequence\n  AND NEW.fork_child_head_operation_sha256 IS OLD.fork_child_head_operation_sha256\n  AND NEW.fork_child_head_digest IS OLD.fork_child_head_digest\n  AND NEW.fork_parent_authority_digest IS OLD.fork_parent_authority_digest\n  AND NEW.fork_parent_head_sequence IS OLD.fork_parent_head_sequence\n  AND NEW.fork_parent_head_operation_sha256 IS OLD.fork_parent_head_operation_sha256\n  AND NEW.fork_parent_head_digest IS OLD.fork_parent_head_digest\n  AND NEW.created_at=OLD.created_at\n  AND NEW.updated_at>=OLD.updated_at\n  AND EXISTS (\n    SELECT 1 FROM memory_submissions submission\n    WHERE submission.kind='remember'\n      AND submission.working_binding_digest=OLD.authority_digest\n      AND submission.state='applied'\n      AND submission.outcome_code='remember_committed'\n      AND submission.expected_head_sequence=OLD.head_sequence\n      AND submission.expected_head_operation_sha256 IS OLD.head_operation_sha256\n      AND submission.expected_head_digest=OLD.head_digest\n      AND submission.result_head_sequence=NEW.head_sequence\n      AND submission.result_head_operation_sha256 IS NEW.head_operation_sha256\n      AND submission.result_head_digest=NEW.head_digest\n  )\n)\nBEGIN SELECT RAISE(ABORT, 'invalid memory working attestation head transition'); END"
    },
    {
      "type": "trigger",
      "name": "message_attachments_immutable_update",
      "tbl_name": "message_attachments",
      "sql": "CREATE TRIGGER message_attachments_immutable_update\nBEFORE UPDATE ON message_attachments\nBEGIN SELECT RAISE(ABORT, 'message attachments are immutable'); END"
    },
    {
      "type": "trigger",
      "name": "message_attachments_reference_decrement",
      "tbl_name": "message_attachments",
      "sql": "CREATE TRIGGER message_attachments_reference_decrement\nAFTER DELETE ON message_attachments\nBEGIN\n  UPDATE attachments SET reference_count = MAX(reference_count - 1, 0) WHERE digest = OLD.digest;\nEND"
    },
    {
      "type": "trigger",
      "name": "message_attachments_reference_increment",
      "tbl_name": "message_attachments",
      "sql": "CREATE TRIGGER message_attachments_reference_increment\nAFTER INSERT ON message_attachments\nBEGIN\n  UPDATE attachments SET reference_count = reference_count + 1 WHERE digest = NEW.digest;\nEND"
    },
    {
      "type": "trigger",
      "name": "mutation_effect_evidence_immutable_delete",
      "tbl_name": "mutation_effect_evidence",
      "sql": "CREATE TRIGGER mutation_effect_evidence_immutable_delete\nBEFORE DELETE ON mutation_effect_evidence\nBEGIN SELECT RAISE(ABORT, 'mutation effect evidence is immutable'); END"
    },
    {
      "type": "trigger",
      "name": "mutation_effect_evidence_immutable_update",
      "tbl_name": "mutation_effect_evidence",
      "sql": "CREATE TRIGGER mutation_effect_evidence_immutable_update\nBEFORE UPDATE ON mutation_effect_evidence\nBEGIN SELECT RAISE(ABORT, 'mutation effect evidence is immutable'); END"
    },
    {
      "type": "trigger",
      "name": "mutation_resolutions_immutable_delete",
      "tbl_name": "mutation_resolutions",
      "sql": "CREATE TRIGGER mutation_resolutions_immutable_delete\nBEFORE DELETE ON mutation_resolutions\nBEGIN SELECT RAISE(ABORT, 'mutation resolution is immutable'); END"
    },
    {
      "type": "trigger",
      "name": "mutation_resolutions_immutable_update",
      "tbl_name": "mutation_resolutions",
      "sql": "CREATE TRIGGER mutation_resolutions_immutable_update\nBEFORE UPDATE ON mutation_resolutions\nBEGIN SELECT RAISE(ABORT, 'mutation resolution is immutable'); END"
    },
    {
      "type": "trigger",
      "name": "mutation_resolutions_timestamp_proof_insert",
      "tbl_name": "mutation_resolutions",
      "sql": "CREATE TRIGGER mutation_resolutions_timestamp_proof_insert\nBEFORE INSERT ON mutation_resolutions\nWHEN (SELECT kind FROM mutation_attempts WHERE id=NEW.attempt_id) IN ('session.stop','session.rename')\nBEGIN\n  SELECT CASE WHEN NEW.resolution_kind<>'proven_applied' AND NEW.receipt_json IS NOT NULL\n    THEN RAISE(ABORT,'MUTATION_RECOVERY_TIMESTAMP_RECEIPT_UNEXPECTED') END;\n  SELECT CASE WHEN NEW.resolution_kind='proven_applied' AND (\n    NOT json_valid(NEW.evidence_json) OR NEW.receipt_json IS NULL OR NOT json_valid(NEW.receipt_json)\n  ) THEN RAISE(ABORT,'MUTATION_RECOVERY_TIMESTAMP_PROOF_INVALID') END;\n  SELECT CASE WHEN NEW.resolution_kind='proven_applied' AND NOT EXISTS (\n    SELECT 1 FROM mutation_attempts m\n    JOIN mutation_effect_evidence e ON e.attempt_id=m.id\n    JOIN sessions s ON s.id=m.authority_id\n    WHERE m.id=NEW.attempt_id AND e.kind=m.kind\n      AND json_extract(e.evidence_json,'$.kind')=m.kind\n      AND json_extract(NEW.evidence_json,'$.kind')=m.kind\n      AND json_extract(e.evidence_json,'$.providerThreadId')=s.provider_thread_id\n      AND json_extract(NEW.evidence_json,'$.providerThreadId')=s.provider_thread_id\n      AND json_extract(e.evidence_json,'$.providerTimestampUnit')='unix_milliseconds_v1'\n      AND json_extract(NEW.evidence_json,'$.providerTimestampUnit')='unix_milliseconds_v1'\n      AND json_type(e.evidence_json,'$.baseline.providerUpdatedAt')='integer'\n      AND json_extract(e.evidence_json,'$.baseline.providerUpdatedAt') BETWEEN 0 AND 9007199254740991\n      AND json_type(NEW.evidence_json,'$.providerUpdatedAt')='integer'\n      AND json_extract(NEW.evidence_json,'$.providerUpdatedAt') BETWEEN 0 AND 9007199254740991\n      AND json_extract(NEW.evidence_json,'$.providerUpdatedAt')>json_extract(e.evidence_json,'$.baseline.providerUpdatedAt')\n      AND s.provider_updated_at=json_extract(NEW.evidence_json,'$.providerUpdatedAt')\n      AND (\n        (m.kind='session.stop'\n          AND s.active_turn_id IS NOT json_extract(e.evidence_json,'$.activeTurnId')\n          AND (SELECT count(*) FROM json_each(NEW.evidence_json))=6\n          AND (SELECT count(*) FROM json_each(NEW.receipt_json))=2\n          AND json_type(e.evidence_json,'$.activeTurnId')='text'\n          AND json_extract(NEW.evidence_json,'$.activeTurnId')=json_extract(e.evidence_json,'$.activeTurnId')\n          AND json_extract(NEW.receipt_json,'$.activeTurnId')=json_extract(e.evidence_json,'$.activeTurnId')\n          AND json_extract(NEW.evidence_json,'$.observedStatus') IN ('absent','completed','interrupted','failed')\n          AND json_type(NEW.receipt_json,'$.stopped')='true')\n        OR (m.kind='session.rename'\n          AND s.title=json_extract(e.evidence_json,'$.requestedName')\n          AND (SELECT count(*) FROM json_each(NEW.evidence_json))=5\n          AND (SELECT count(*) FROM json_each(NEW.receipt_json))=1\n          AND json_extract(NEW.evidence_json,'$.requestedName')=json_extract(e.evidence_json,'$.requestedName')\n          AND json_type(NEW.receipt_json,'$.renamed')='true')\n      )\n  ) THEN RAISE(ABORT,'MUTATION_RECOVERY_TIMESTAMP_PROOF_INVALID') END;\nEND"
    },
    {
      "type": "trigger",
      "name": "mutation_transition_guard",
      "tbl_name": "mutation_attempts",
      "sql": "CREATE TRIGGER mutation_transition_guard BEFORE UPDATE OF state ON mutation_attempts\nWHEN NOT (\n  (OLD.state = 'prepared' AND NEW.state IN ('effect_started','cancelled')) OR\n  (OLD.state = 'effect_started' AND NEW.state IN ('applied','failed','ambiguous')) OR\n  OLD.state = NEW.state\n)\nBEGIN SELECT RAISE(ABORT, 'illegal mutation transition'); END"
    },
    {
      "type": "trigger",
      "name": "notification_hours_delete_guard",
      "tbl_name": "notification_hours",
      "sql": "CREATE TRIGGER notification_hours_delete_guard\nBEFORE DELETE ON notification_hours\nBEGIN SELECT RAISE(ABORT, 'notification hours cannot be deleted'); END"
    },
    {
      "type": "trigger",
      "name": "notification_hours_insert_guard",
      "tbl_name": "notification_hours",
      "sql": "CREATE TRIGGER notification_hours_insert_guard\nBEFORE INSERT ON notification_hours\nWHEN EXISTS(SELECT 1 FROM notification_hours WHERE singleton=1)\nBEGIN SELECT RAISE(ABORT, 'notification hours already exists'); END"
    },
    {
      "type": "trigger",
      "name": "notification_hours_update_guard",
      "tbl_name": "notification_hours",
      "sql": "CREATE TRIGGER notification_hours_update_guard\nBEFORE UPDATE ON notification_hours\nWHEN NEW.singleton != OLD.singleton\n  OR NEW.version != OLD.version\n  OR NEW.created_at != OLD.created_at\n  OR NEW.revision != OLD.revision + 1\n  OR NEW.updated_at < OLD.updated_at\nBEGIN SELECT RAISE(ABORT, 'invalid notification hours transition'); END"
    },
    {
      "type": "trigger",
      "name": "peer_session_action_delete_guard",
      "tbl_name": "peer_session_actions",
      "sql": "CREATE TRIGGER peer_session_action_delete_guard\nBEFORE DELETE ON peer_session_actions\nWHEN OLD.state NOT IN ('applied','failed','cancelled')\nBEGIN SELECT RAISE(ABORT, 'peer session recovery evidence is immutable'); END"
    },
    {
      "type": "trigger",
      "name": "peer_session_action_insert_guard",
      "tbl_name": "peer_session_actions",
      "sql": "CREATE TRIGGER peer_session_action_insert_guard\nBEFORE INSERT ON peer_session_actions\nWHEN NEW.state NOT IN ('prepared','queued')\n  OR NEW.target_turn_digest IS NOT NULL\n  OR NEW.result_digest IS NOT NULL\nBEGIN SELECT RAISE(ABORT, 'illegal peer session action insertion'); END"
    },
    {
      "type": "trigger",
      "name": "peer_session_action_parent_insert_guard",
      "tbl_name": "peer_session_action_parents",
      "sql": "CREATE TRIGGER peer_session_action_parent_insert_guard\nBEFORE INSERT ON peer_session_action_parents\nWHEN NOT EXISTS (\n  SELECT 1 FROM peer_session_actions child\n  JOIN peer_session_actions parent ON parent.id=NEW.parent_action_id\n  WHERE child.id=NEW.action_id\n    AND child.actor_session_id=parent.target_session_id\n    AND child.project_id=parent.project_id\n    AND child.hop>parent.hop\n)\nBEGIN SELECT RAISE(ABORT, 'invalid peer session action parent'); END"
    },
    {
      "type": "trigger",
      "name": "peer_session_action_parent_quota",
      "tbl_name": "peer_session_action_parents",
      "sql": "CREATE TRIGGER peer_session_action_parent_quota\nBEFORE INSERT ON peer_session_action_parents\nWHEN (\n  SELECT COUNT(*) FROM peer_session_action_parents WHERE action_id=NEW.action_id\n)>=32\nBEGIN SELECT RAISE(ABORT, 'peer session parent fan-in quota exceeded'); END"
    },
    {
      "type": "trigger",
      "name": "peer_session_action_parents_immutable_delete",
      "tbl_name": "peer_session_action_parents",
      "sql": "CREATE TRIGGER peer_session_action_parents_immutable_delete\nBEFORE DELETE ON peer_session_action_parents\nWHEN NOT EXISTS (\n  SELECT 1 FROM peer_session_actions action\n  WHERE action.id=OLD.action_id AND action.state IN ('applied','failed','cancelled')\n)\nBEGIN SELECT RAISE(ABORT, 'peer session action parents are immutable until settlement'); END"
    },
    {
      "type": "trigger",
      "name": "peer_session_action_parents_immutable_update",
      "tbl_name": "peer_session_action_parents",
      "sql": "CREATE TRIGGER peer_session_action_parents_immutable_update\nBEFORE UPDATE ON peer_session_action_parents\nBEGIN SELECT RAISE(ABORT, 'peer session action parents are immutable'); END"
    },
    {
      "type": "trigger",
      "name": "peer_session_action_retained_quota",
      "tbl_name": "peer_session_actions",
      "sql": "CREATE TRIGGER peer_session_action_retained_quota\nBEFORE INSERT ON peer_session_actions\nWHEN (\n  SELECT COUNT(*) FROM peer_session_actions WHERE project_id=NEW.project_id\n)>=25000\nBEGIN SELECT RAISE(ABORT, 'peer session retained action quota exceeded'); END"
    },
    {
      "type": "trigger",
      "name": "peer_session_action_root_insert_guard",
      "tbl_name": "peer_session_action_roots",
      "sql": "CREATE TRIGGER peer_session_action_root_insert_guard\nBEFORE INSERT ON peer_session_action_roots\nWHEN NOT EXISTS (\n  SELECT 1 FROM peer_session_actions child\n  JOIN peer_session_actions root ON root.id=NEW.root_action_id\n  WHERE child.id=NEW.action_id\n    AND child.project_id=root.project_id\n    AND root.hop=1\n)\nBEGIN SELECT RAISE(ABORT, 'invalid peer session action root'); END"
    },
    {
      "type": "trigger",
      "name": "peer_session_action_root_quota",
      "tbl_name": "peer_session_action_roots",
      "sql": "CREATE TRIGGER peer_session_action_root_quota\nBEFORE INSERT ON peer_session_action_roots\nWHEN (\n  SELECT COUNT(*) FROM peer_session_action_roots WHERE action_id=NEW.action_id\n)>=64\nBEGIN SELECT RAISE(ABORT, 'peer session root quota exceeded'); END"
    },
    {
      "type": "trigger",
      "name": "peer_session_action_roots_immutable_delete",
      "tbl_name": "peer_session_action_roots",
      "sql": "CREATE TRIGGER peer_session_action_roots_immutable_delete\nBEFORE DELETE ON peer_session_action_roots\nWHEN NOT EXISTS (\n  SELECT 1 FROM peer_session_actions action\n  WHERE action.id=OLD.action_id AND action.state IN ('applied','failed','cancelled')\n)\nBEGIN SELECT RAISE(ABORT, 'peer session action roots are immutable until settlement'); END"
    },
    {
      "type": "trigger",
      "name": "peer_session_action_roots_immutable_update",
      "tbl_name": "peer_session_action_roots",
      "sql": "CREATE TRIGGER peer_session_action_roots_immutable_update\nBEFORE UPDATE ON peer_session_action_roots\nBEGIN SELECT RAISE(ABORT, 'peer session action roots are immutable'); END"
    },
    {
      "type": "trigger",
      "name": "peer_session_action_transition_guard",
      "tbl_name": "peer_session_actions",
      "sql": "CREATE TRIGGER peer_session_action_transition_guard\nBEFORE UPDATE ON peer_session_actions\nWHEN NOT (\n  NEW.id=OLD.id\n  AND NEW.idempotency_key=OLD.idempotency_key\n  AND NEW.actor_session_id=OLD.actor_session_id\n  AND NEW.actor_turn_digest=OLD.actor_turn_digest\n  AND NEW.project_id=OLD.project_id\n  AND NEW.actor_policy_revision=OLD.actor_policy_revision\n  AND NEW.target_session_id=OLD.target_session_id\n  AND NEW.target_expected_revision=OLD.target_expected_revision\n  AND NEW.target_policy_revision=OLD.target_policy_revision\n  AND NEW.delivery=OLD.delivery\n  AND NEW.request_digest=OLD.request_digest\n  AND NEW.message_digest=OLD.message_digest\n  AND NEW.reason_digest=OLD.reason_digest\n  AND NEW.hop=OLD.hop\n  AND NEW.created_at=OLD.created_at\n  AND NEW.updated_at>=OLD.updated_at\n  AND (OLD.target_turn_digest IS NULL OR NEW.target_turn_digest IS OLD.target_turn_digest)\n  AND (OLD.result_digest IS NULL OR NEW.result_digest IS OLD.result_digest)\n  AND (\n    NEW.state=OLD.state\n    OR (OLD.state='prepared' AND NEW.state IN ('effect_started','cancelled'))\n    OR (OLD.state='queued' AND NEW.state IN ('effect_started','cancelled','ambiguous'))\n    OR (OLD.state='effect_started' AND NEW.state IN ('applied','failed','ambiguous'))\n    OR (OLD.state='ambiguous' AND NEW.state IN ('applied','failed'))\n    OR (\n      OLD.state IN ('effect_started','ambiguous')\n      AND NEW.state='cancelled'\n      AND NOT EXISTS (\n        SELECT 1 FROM mutation_effect_evidence evidence\n        JOIN mutation_attempts mutation ON mutation.id=evidence.attempt_id\n        WHERE mutation.idempotency_key=OLD.idempotency_key\n      )\n      AND EXISTS (\n        SELECT 1 FROM mutation_attempts mutation\n        WHERE mutation.idempotency_key=OLD.idempotency_key\n          AND mutation.authority_id=OLD.target_session_id\n          AND mutation.kind=('session.' || OLD.delivery)\n          AND mutation.state='cancelled'\n      )\n    )\n  )\n  AND ((NEW.state='applied') = (NEW.target_turn_digest IS NOT NULL))\n  AND (NEW.state IN ('applied','failed','ambiguous','cancelled') OR NEW.result_digest IS NULL)\n)\nBEGIN SELECT RAISE(ABORT, 'illegal peer session action transition'); END"
    },
    {
      "type": "trigger",
      "name": "peer_session_action_turn_origin_insert_guard",
      "tbl_name": "peer_session_turn_origins",
      "sql": "CREATE TRIGGER peer_session_action_turn_origin_insert_guard\nBEFORE INSERT ON peer_session_turn_origins\nWHEN NOT EXISTS (\n  SELECT 1 FROM peer_session_actions action\n  WHERE action.id=NEW.action_id\n    AND action.target_session_id=NEW.session_id\n    AND action.target_turn_digest=NEW.turn_digest\n    AND action.state='applied'\n)\nBEGIN SELECT RAISE(ABORT, 'invalid peer session turn origin'); END"
    },
    {
      "type": "trigger",
      "name": "peer_session_action_visit_quota",
      "tbl_name": "peer_session_action_visits",
      "sql": "CREATE TRIGGER peer_session_action_visit_quota\nBEFORE INSERT ON peer_session_action_visits\nWHEN (\n  SELECT COUNT(*) FROM peer_session_action_visits WHERE action_id=NEW.action_id\n)>=64\nBEGIN SELECT RAISE(ABORT, 'peer session visit quota exceeded'); END"
    },
    {
      "type": "trigger",
      "name": "peer_session_action_visits_immutable_delete",
      "tbl_name": "peer_session_action_visits",
      "sql": "CREATE TRIGGER peer_session_action_visits_immutable_delete\nBEFORE DELETE ON peer_session_action_visits\nWHEN NOT EXISTS (\n  SELECT 1 FROM peer_session_actions action\n  WHERE action.id=OLD.action_id AND action.state IN ('applied','failed','cancelled')\n)\nBEGIN SELECT RAISE(ABORT, 'peer session action visits are immutable until settlement'); END"
    },
    {
      "type": "trigger",
      "name": "peer_session_action_visits_immutable_update",
      "tbl_name": "peer_session_action_visits",
      "sql": "CREATE TRIGGER peer_session_action_visits_immutable_update\nBEFORE UPDATE ON peer_session_action_visits\nBEGIN SELECT RAISE(ABORT, 'peer session action visits are immutable'); END"
    },
    {
      "type": "trigger",
      "name": "peer_session_direct_message_source_delete_guard",
      "tbl_name": "peer_session_direct_message_sources",
      "sql": "CREATE TRIGGER peer_session_direct_message_source_delete_guard\nBEFORE DELETE ON peer_session_direct_message_sources\nWHEN NOT EXISTS (\n  SELECT 1\n  FROM mutation_attempts mutation\n  LEFT JOIN mutation_resolutions resolution ON resolution.attempt_id=mutation.id\n  LEFT JOIN mutation_effect_evidence evidence ON evidence.attempt_id=mutation.id\n  LEFT JOIN session_message_event_sources source\n    ON source.source_id=mutation.id\n      AND source.session_id=OLD.target_session_id\n      AND source.actor='peer_session'\n  WHERE mutation.idempotency_key=OLD.idempotency_key\n    AND mutation.authority_id=OLD.target_session_id\n    AND mutation.kind=('session.' || OLD.delivery)\n    AND (\n      source.source_id IS NOT NULL\n      OR json_extract(evidence.evidence_json,'$.messageActor')='peer_session'\n      OR mutation.state IN ('failed','cancelled')\n      OR resolution.resolution_kind='abandoned'\n    )\n)\nBEGIN SELECT RAISE(ABORT, 'peer session direct message source is required'); END"
    },
    {
      "type": "trigger",
      "name": "peer_session_direct_message_source_immutable_update",
      "tbl_name": "peer_session_direct_message_sources",
      "sql": "CREATE TRIGGER peer_session_direct_message_source_immutable_update\nBEFORE UPDATE ON peer_session_direct_message_sources\nBEGIN SELECT RAISE(ABORT, 'peer session direct message source is immutable'); END"
    },
    {
      "type": "trigger",
      "name": "peer_session_direct_message_source_insert_guard",
      "tbl_name": "peer_session_direct_message_sources",
      "sql": "CREATE TRIGGER peer_session_direct_message_source_insert_guard\nBEFORE INSERT ON peer_session_direct_message_sources\nWHEN NOT EXISTS (\n  SELECT 1 FROM peer_session_actions action\n  WHERE action.id=NEW.action_id\n    AND action.idempotency_key=NEW.idempotency_key\n    AND action.actor_session_id=NEW.actor_session_id\n    AND action.actor_turn_digest=NEW.actor_turn_digest\n    AND action.project_id=NEW.project_id\n    AND action.target_session_id=NEW.target_session_id\n    AND action.target_expected_revision=NEW.target_expected_revision\n    AND action.delivery=NEW.delivery\n    AND action.request_digest=NEW.request_digest\n    AND action.message_digest=NEW.message_digest\n    AND action.reason_digest=NEW.reason_digest\n    AND action.created_at=NEW.created_at\n)\nBEGIN SELECT RAISE(ABORT, 'invalid peer session direct message source'); END"
    },
    {
      "type": "trigger",
      "name": "peer_session_direct_message_source_quota",
      "tbl_name": "peer_session_direct_message_sources",
      "sql": "CREATE TRIGGER peer_session_direct_message_source_quota\nBEFORE INSERT ON peer_session_direct_message_sources\nWHEN (\n  SELECT COUNT(*) FROM peer_session_direct_message_sources\n  WHERE project_id=NEW.project_id\n)>=25000\nBEGIN SELECT RAISE(ABORT, 'peer session direct message source quota exceeded'); END"
    },
    {
      "type": "trigger",
      "name": "peer_session_turn_origin_quota",
      "tbl_name": "peer_session_turn_origins",
      "sql": "CREATE TRIGGER peer_session_turn_origin_quota\nBEFORE INSERT ON peer_session_turn_origins\nWHEN (\n  SELECT COUNT(*) FROM peer_session_turn_origins\n  WHERE session_id=NEW.session_id AND turn_digest=NEW.turn_digest\n)>=32\nBEGIN SELECT RAISE(ABORT, 'peer session turn origin quota exceeded'); END"
    },
    {
      "type": "trigger",
      "name": "peer_session_turn_origins_immutable_delete",
      "tbl_name": "peer_session_turn_origins",
      "sql": "CREATE TRIGGER peer_session_turn_origins_immutable_delete\nBEFORE DELETE ON peer_session_turn_origins\nWHEN NOT EXISTS (\n  SELECT 1 FROM peer_session_actions action\n  WHERE action.id=OLD.action_id AND action.state IN ('applied','failed','cancelled')\n)\nBEGIN SELECT RAISE(ABORT, 'peer session turn origins are immutable until settlement'); END"
    },
    {
      "type": "trigger",
      "name": "peer_session_turn_origins_immutable_update",
      "tbl_name": "peer_session_turn_origins",
      "sql": "CREATE TRIGGER peer_session_turn_origins_immutable_update\nBEFORE UPDATE ON peer_session_turn_origins\nBEGIN SELECT RAISE(ABORT, 'peer session turn origins are immutable'); END"
    },
    {
      "type": "trigger",
      "name": "profile_codex_account_key_insert_guard",
      "tbl_name": "profiles",
      "sql": "CREATE TRIGGER profile_codex_account_key_insert_guard\nBEFORE INSERT ON profiles\nWHEN (NEW.provider_email IS NULL)!=(NEW.codex_account_key IS NULL)\nBEGIN SELECT RAISE(ABORT, 'profile Codex account key must accompany its identity'); END"
    },
    {
      "type": "trigger",
      "name": "profile_codex_account_key_update_guard",
      "tbl_name": "profiles",
      "sql": "CREATE TRIGGER profile_codex_account_key_update_guard\nBEFORE UPDATE OF provider_email,codex_account_key ON profiles\nWHEN (NEW.provider_email IS NULL)!=(NEW.codex_account_key IS NULL)\n  OR (\n    OLD.provider_email IS NOT NULL AND NEW.provider_email IS NOT NULL\n    AND lower(trim(NEW.provider_email))!=lower(trim(OLD.provider_email))\n    AND NEW.codex_account_key IS OLD.codex_account_key\n  )\n  OR (\n    OLD.provider_email IS NOT NULL AND NEW.provider_email IS NOT NULL\n    AND lower(trim(NEW.provider_email))=lower(trim(OLD.provider_email))\n    AND NEW.codex_account_key IS NOT OLD.codex_account_key\n  )\nBEGIN SELECT RAISE(ABORT, 'profile Codex account key must change with its identity'); END"
    },
    {
      "type": "trigger",
      "name": "profile_controller_authority_recovery_guard",
      "tbl_name": "profiles",
      "sql": "CREATE TRIGGER profile_controller_authority_recovery_guard\nBEFORE UPDATE OF state ON profiles\nWHEN NEW.state='recovery_required' AND OLD.state!='recovery_required'\n  AND EXISTS(\n    SELECT 1 FROM session_claude_process_authorities a\n    WHERE a.profile_id=OLD.id\n      AND a.profile_generation=OLD.process_generation\n      AND a.state!='released'\n    UNION ALL\n    SELECT 1 FROM session_claude_process_launch_intents i\n    WHERE i.profile_id=OLD.id\n      AND i.profile_generation=OLD.process_generation\n  )\n  AND NOT EXISTS(\n    SELECT 1 FROM profile_personal_authority_revocations r\n    WHERE r.profile_id=OLD.id\n      AND r.profile_generation=OLD.process_generation\n      AND r.state='releasing'\n  )\nBEGIN SELECT RAISE(ABORT, 'controller revocation must be staged before account recovery'); END"
    },
    {
      "type": "trigger",
      "name": "profile_personal_authority_revocation_revision_guard",
      "tbl_name": "profile_personal_authority_revocations",
      "sql": "CREATE TRIGGER profile_personal_authority_revocation_revision_guard\nBEFORE UPDATE ON profile_personal_authority_revocations\nWHEN NEW.revision!=OLD.revision+1 OR NEW.updated_at<OLD.updated_at\nBEGIN SELECT RAISE(ABORT, 'personal authority revocation revision is invalid'); END"
    },
    {
      "type": "trigger",
      "name": "profiles_label_key_immutable",
      "tbl_name": "profiles",
      "sql": "CREATE TRIGGER profiles_label_key_immutable\nBEFORE UPDATE OF label,label_key ON profiles\nWHEN NEW.label IS NOT OLD.label OR NEW.label_key IS NOT OLD.label_key\nBEGIN SELECT RAISE(ABORT, 'profile label identity is immutable'); END"
    },
    {
      "type": "trigger",
      "name": "profiles_label_key_insert_guard",
      "tbl_name": "profiles",
      "sql": "CREATE TRIGGER profiles_label_key_insert_guard\nBEFORE INSERT ON profiles\nWHEN NEW.label_key IS NULL\n  OR length(CAST(NEW.label_key AS BLOB)) NOT BETWEEN 1 AND 4096\nBEGIN SELECT RAISE(ABORT, 'invalid profile label key'); END"
    },
    {
      "type": "trigger",
      "name": "project_memory_authority_delete_guard",
      "tbl_name": "project_memory_authorities",
      "sql": "CREATE TRIGGER project_memory_authority_delete_guard\nBEFORE DELETE ON project_memory_authorities\nBEGIN SELECT RAISE(ABORT, 'project memory authority is immutable'); END"
    },
    {
      "type": "trigger",
      "name": "project_memory_authority_insert_guard",
      "tbl_name": "project_memory_authorities",
      "sql": "CREATE TRIGGER project_memory_authority_insert_guard\nBEFORE INSERT ON project_memory_authorities\nWHEN NEW.revision!=1\n  OR NEW.physical_state!='reserved'\n  OR NEW.initialized_at IS NOT NULL\n  OR NEW.sync_state!='local_only'\n  OR NEW.last_exchange_at IS NOT NULL\n  OR NEW.last_exchange_sequence IS NOT NULL\n  OR NEW.last_exchange_operation_sha256 IS NOT NULL\n  OR NEW.last_exchange_head_digest IS NOT NULL\n  OR NEW.diagnostic_code IS NOT NULL\nBEGIN SELECT RAISE(ABORT, 'illegal project memory authority insertion'); END"
    },
    {
      "type": "trigger",
      "name": "project_memory_authority_transition_guard",
      "tbl_name": "project_memory_authorities",
      "sql": "CREATE TRIGGER project_memory_authority_transition_guard\nBEFORE UPDATE ON project_memory_authorities\nWHEN NOT (\n  NEW.project_id=OLD.project_id\n  AND NEW.identity_contract=OLD.identity_contract\n  AND NEW.canonical_space_id=OLD.canonical_space_id\n  AND (\n    (\n      OLD.physical_state='reserved'\n      AND NEW.physical_state='initialized'\n      AND NEW.initialized_at IS NOT NULL\n      AND NEW.head_sequence=OLD.head_sequence\n      AND NEW.head_operation_sha256 IS OLD.head_operation_sha256\n      AND NEW.head_digest=OLD.head_digest\n      AND NEW.sync_state=OLD.sync_state\n      AND NEW.last_exchange_at IS OLD.last_exchange_at\n      AND NEW.last_exchange_sequence IS OLD.last_exchange_sequence\n      AND NEW.last_exchange_operation_sha256 IS OLD.last_exchange_operation_sha256\n      AND NEW.last_exchange_head_digest IS OLD.last_exchange_head_digest\n      AND NEW.diagnostic_code IS OLD.diagnostic_code\n    )\n    OR (\n      OLD.physical_state='reserved'\n      AND NEW.physical_state='rejected'\n      AND NEW.initialized_at IS NULL\n      AND NEW.head_sequence=OLD.head_sequence\n      AND NEW.head_operation_sha256 IS OLD.head_operation_sha256\n      AND NEW.head_digest=OLD.head_digest\n      AND NEW.sync_state='error'\n      AND NEW.last_exchange_at IS OLD.last_exchange_at\n      AND NEW.last_exchange_sequence IS OLD.last_exchange_sequence\n      AND NEW.last_exchange_operation_sha256 IS OLD.last_exchange_operation_sha256\n      AND NEW.last_exchange_head_digest IS OLD.last_exchange_head_digest\n      AND NEW.diagnostic_code IS NOT NULL\n    )\n    OR (\n      OLD.physical_state='initialized'\n      AND NEW.physical_state='initialized'\n      AND NEW.initialized_at=OLD.initialized_at\n    )\n  )\n  AND NEW.authority_digest=OLD.authority_digest\n  AND NEW.binding_digest=OLD.binding_digest\n  AND NEW.revision=OLD.revision+1\n  AND NEW.created_at=OLD.created_at\n  AND NEW.updated_at>=OLD.updated_at\n  AND (OLD.sync_state NOT IN ('conflict','error') OR NEW.sync_state=OLD.sync_state)\n  AND NEW.head_sequence>=OLD.head_sequence\n  AND (\n    NEW.head_sequence>OLD.head_sequence\n    OR (\n      NEW.head_operation_sha256 IS OLD.head_operation_sha256\n      AND NEW.head_digest=OLD.head_digest\n    )\n  )\n  AND (\n    NEW.sync_state!='settled'\n    OR (\n      NEW.last_exchange_sequence=NEW.head_sequence\n      AND NEW.last_exchange_operation_sha256 IS NEW.head_operation_sha256\n      AND NEW.last_exchange_head_digest=NEW.head_digest\n    )\n  )\n)\nBEGIN SELECT RAISE(ABORT, 'illegal project memory authority transition'); END"
    },
    {
      "type": "trigger",
      "name": "project_memory_hosted_attachment_delete_guard",
      "tbl_name": "project_memory_hosted_attachments",
      "sql": "CREATE TRIGGER project_memory_hosted_attachment_delete_guard\nBEFORE DELETE ON project_memory_hosted_attachments\nBEGIN SELECT RAISE(ABORT, 'canonical memory hosted attachment is permanent'); END"
    },
    {
      "type": "trigger",
      "name": "project_memory_hosted_attachment_insert_guard",
      "tbl_name": "project_memory_hosted_attachments",
      "sql": "CREATE TRIGGER project_memory_hosted_attachment_insert_guard\nBEFORE INSERT ON project_memory_hosted_attachments\nWHEN NEW.state!='attached' OR NEW.generation!=1 OR NEW.revision!=1\n  OR NOT EXISTS (\n    SELECT 1 FROM project_memory_authorities authority\n    WHERE authority.project_id=NEW.project_id\n      AND authority.identity_contract=2\n      AND authority.physical_state!='rejected'\n      AND authority.sync_state NOT IN ('conflict','error')\n      AND authority.binding_digest=NEW.canonical_binding_digest\n  )\n  OR EXISTS (\n    SELECT 1 FROM project_memory_hosted_create_intents intent\n    WHERE intent.project_id=NEW.project_id\n      AND intent.state IN ('allocating','key_staged','prepared','effect_started','winner_observed')\n  )\nBEGIN SELECT RAISE(ABORT, 'invalid canonical memory hosted attachment'); END"
    },
    {
      "type": "trigger",
      "name": "project_memory_hosted_attachment_transition_guard",
      "tbl_name": "project_memory_hosted_attachments",
      "sql": "CREATE TRIGGER project_memory_hosted_attachment_transition_guard\nBEFORE UPDATE ON project_memory_hosted_attachments\nWHEN NOT (\n  NEW.project_id=OLD.project_id\n  AND NEW.remote_space_id=OLD.remote_space_id\n  AND NEW.account_binding_digest=OLD.account_binding_digest\n  AND NEW.canonical_binding_digest=OLD.canonical_binding_digest\n  AND NEW.created_at=OLD.created_at\n  AND NEW.revision=OLD.revision+1\n  AND NEW.updated_at>=OLD.updated_at\n  AND NEW.genesis_token=OLD.genesis_token\n  AND (\n    (OLD.state='attached' AND NEW.state='detached'\n      AND NEW.generation=OLD.generation+1\n      AND NEW.remote_revision=OLD.remote_revision\n      AND NEW.remote_key_version=OLD.remote_key_version\n      AND NEW.remote_head_sequence=OLD.remote_head_sequence\n      AND NEW.remote_head_operation_sha256 IS OLD.remote_head_operation_sha256\n      AND NEW.remote_head_digest=OLD.remote_head_digest\n      AND NEW.remote_head_token=OLD.remote_head_token\n      AND NEW.remote_head_proof_digest=OLD.remote_head_proof_digest\n      AND NEW.diagnostic_code IS NULL\n      AND NOT EXISTS (\n        SELECT 1 FROM project_memory_sync_intents intent\n        WHERE intent.project_id=OLD.project_id\n          AND intent.state IN ('prepared','effect_started','response_observed')\n      ))\n    OR\n    (OLD.state='detached' AND NEW.state='attached'\n      AND NEW.generation=OLD.generation+1\n      AND NEW.diagnostic_code IS NULL\n      AND NEW.remote_revision=OLD.remote_revision\n      AND NEW.remote_key_version=OLD.remote_key_version\n      AND NEW.remote_head_sequence>=OLD.remote_head_sequence\n      AND (NEW.remote_head_sequence!=OLD.remote_head_sequence OR (\n        NEW.remote_head_operation_sha256 IS OLD.remote_head_operation_sha256\n        AND NEW.remote_head_digest=OLD.remote_head_digest\n        AND NEW.remote_head_token=OLD.remote_head_token\n        AND NEW.remote_head_proof_digest=OLD.remote_head_proof_digest)))\n    OR\n    (OLD.state='attached' AND NEW.state='attached'\n      AND NEW.generation=OLD.generation\n      AND NEW.diagnostic_code IS NULL\n      AND NOT EXISTS (\n        SELECT 1 FROM project_memory_sync_intents intent\n        WHERE intent.project_id=OLD.project_id\n          AND intent.state IN ('prepared','effect_started','response_observed')\n      )\n      AND NEW.remote_revision=OLD.remote_revision\n      AND NEW.remote_key_version=OLD.remote_key_version\n      AND NEW.remote_head_sequence>=OLD.remote_head_sequence\n      AND (NEW.remote_head_sequence!=OLD.remote_head_sequence OR (\n        NEW.remote_head_operation_sha256 IS OLD.remote_head_operation_sha256\n        AND NEW.remote_head_digest=OLD.remote_head_digest\n        AND NEW.remote_head_token=OLD.remote_head_token\n        AND NEW.remote_head_proof_digest=OLD.remote_head_proof_digest)))\n    OR\n    (OLD.state='attached' AND NEW.state IN ('conflict','error')\n      AND NEW.generation=OLD.generation\n      AND NEW.remote_revision=OLD.remote_revision\n      AND NEW.remote_key_version=OLD.remote_key_version\n      AND NEW.remote_head_sequence=OLD.remote_head_sequence\n      AND NEW.remote_head_operation_sha256 IS OLD.remote_head_operation_sha256\n      AND NEW.remote_head_digest=OLD.remote_head_digest\n      AND NEW.remote_head_token=OLD.remote_head_token\n      AND NEW.remote_head_proof_digest=OLD.remote_head_proof_digest\n      AND NEW.diagnostic_code IS NOT NULL)\n  )\n)\nBEGIN SELECT RAISE(ABORT, 'invalid canonical memory hosted attachment transition'); END"
    },
    {
      "type": "trigger",
      "name": "project_memory_hosted_create_authority_fence",
      "tbl_name": "project_memory_authorities",
      "sql": "CREATE TRIGGER project_memory_hosted_create_authority_fence\nBEFORE UPDATE ON project_memory_authorities\nWHEN EXISTS (\n  SELECT 1 FROM project_memory_hosted_create_intents intent\n  WHERE intent.project_id=OLD.project_id\n    AND intent.state IN (\n      'allocating','key_staged','prepared','effect_started','winner_observed'\n    )\n)\nBEGIN SELECT RAISE(ABORT, 'canonical memory mutation fenced by hosted create'); END"
    },
    {
      "type": "trigger",
      "name": "project_memory_hosted_create_intent_delete_guard",
      "tbl_name": "project_memory_hosted_create_intents",
      "sql": "CREATE TRIGGER project_memory_hosted_create_intent_delete_guard\nBEFORE DELETE ON project_memory_hosted_create_intents\nBEGIN SELECT RAISE(ABORT, 'canonical memory hosted create intent is immutable'); END"
    },
    {
      "type": "trigger",
      "name": "project_memory_hosted_create_intent_insert_guard",
      "tbl_name": "project_memory_hosted_create_intents",
      "sql": "CREATE TRIGGER project_memory_hosted_create_intent_insert_guard\nBEFORE INSERT ON project_memory_hosted_create_intents\nWHEN NEW.state!='allocating'\n  OR NOT EXISTS (\n    SELECT 1 FROM project_memory_authorities authority\n    WHERE authority.project_id=NEW.project_id\n      AND authority.identity_contract=2\n      AND authority.physical_state!='rejected'\n      AND authority.sync_state NOT IN ('conflict','error')\n      AND authority.binding_digest=NEW.canonical_binding_digest\n      AND authority.revision=NEW.authority_revision\n      AND authority.head_sequence=NEW.authority_head_sequence\n      AND authority.head_operation_sha256 IS NEW.authority_head_operation_sha256\n      AND authority.head_digest=NEW.authority_head_digest\n  )\n  OR EXISTS (\n    SELECT 1 FROM project_memory_hosted_attachments attachment\n    WHERE attachment.project_id=NEW.project_id\n  )\n  OR EXISTS (\n    SELECT 1 FROM project_memory_sync_intents intent\n    WHERE intent.project_id=NEW.project_id\n      AND intent.state IN ('prepared','effect_started','response_observed')\n  )\n  OR EXISTS (\n    SELECT 1 FROM memory_submissions submission\n    WHERE submission.project_id=NEW.project_id AND submission.kind='share'\n      AND submission.state IN ('prepared','effect_started','ambiguous')\n  )\n  OR EXISTS (\n    SELECT 1 FROM project_memory_hosted_create_intents create_intent\n    WHERE create_intent.project_id=NEW.project_id\n      AND create_intent.state IN (\n        'allocating','key_staged','prepared','effect_started','winner_observed'\n      )\n  )\nBEGIN SELECT RAISE(ABORT, 'invalid canonical memory hosted create intent'); END"
    },
    {
      "type": "trigger",
      "name": "project_memory_hosted_create_intent_transition_guard",
      "tbl_name": "project_memory_hosted_create_intents",
      "sql": "CREATE TRIGGER project_memory_hosted_create_intent_transition_guard\nBEFORE UPDATE ON project_memory_hosted_create_intents\nWHEN NOT (\n  NEW.id=OLD.id AND NEW.idempotency_key=OLD.idempotency_key\n  AND NEW.project_id=OLD.project_id\n  AND NEW.authority_revision=OLD.authority_revision\n  AND NEW.canonical_binding_digest=OLD.canonical_binding_digest\n  AND NEW.authority_head_sequence=OLD.authority_head_sequence\n  AND NEW.authority_head_operation_sha256 IS OLD.authority_head_operation_sha256\n  AND NEW.authority_head_digest=OLD.authority_head_digest\n  AND NEW.account_binding_digest=OLD.account_binding_digest\n  AND NEW.remote_space_id=OLD.remote_space_id\n  AND NEW.created_at=OLD.created_at AND NEW.updated_at>=OLD.updated_at\n  AND (\n    (OLD.state='allocating' AND NEW.state='key_staged'\n      AND NEW.space_key_version IS NOT NULL\n      AND NEW.wrapped_key_algorithm IS NOT NULL\n      AND NEW.wrapped_key_ciphertext IS NOT NULL\n      AND NEW.wrapped_key_version IS NOT NULL\n      AND NEW.wrapped_key_nonce IS NOT NULL\n      AND NEW.descriptor_algorithm IS NULL AND NEW.descriptor_ciphertext IS NULL\n      AND NEW.descriptor_key_version IS NULL AND NEW.descriptor_nonce IS NULL\n      AND NEW.genesis_proof_algorithm IS NULL\n      AND NEW.genesis_proof_ciphertext IS NULL\n      AND NEW.genesis_proof_key_version IS NULL\n      AND NEW.genesis_proof_nonce IS NULL AND NEW.genesis_token IS NULL\n      AND NEW.request_digest IS NULL AND NEW.effect_started_at IS NULL\n      AND NEW.winner_digest IS NULL AND NEW.winner_revision IS NULL\n      AND NEW.winner_replay IS NULL AND NEW.winner_observed_at IS NULL\n      AND NEW.settled_at IS NULL AND NEW.diagnostic_code IS NULL)\n    OR\n    (OLD.state='key_staged' AND NEW.state='prepared'\n      AND NEW.space_key_version=OLD.space_key_version\n      AND NEW.wrapped_key_algorithm=OLD.wrapped_key_algorithm\n      AND NEW.wrapped_key_ciphertext=OLD.wrapped_key_ciphertext\n      AND NEW.wrapped_key_version=OLD.wrapped_key_version\n      AND NEW.wrapped_key_nonce=OLD.wrapped_key_nonce\n      AND NEW.descriptor_algorithm IS NOT NULL\n      AND NEW.descriptor_ciphertext IS NOT NULL\n      AND NEW.descriptor_key_version=OLD.space_key_version\n      AND NEW.descriptor_nonce IS NOT NULL\n      AND NEW.genesis_proof_algorithm IS NOT NULL\n      AND NEW.genesis_proof_ciphertext IS NOT NULL\n      AND NEW.genesis_proof_key_version=OLD.space_key_version\n      AND NEW.genesis_proof_nonce IS NOT NULL AND NEW.genesis_token IS NOT NULL\n      AND NEW.request_digest IS NOT NULL AND NEW.effect_started_at IS NULL\n      AND NEW.winner_digest IS NULL AND NEW.winner_revision IS NULL\n      AND NEW.winner_replay IS NULL AND NEW.winner_observed_at IS NULL\n      AND NEW.settled_at IS NULL AND NEW.diagnostic_code IS NULL)\n    OR\n    (OLD.state='prepared' AND NEW.state='effect_started'\n      AND NEW.space_key_version=OLD.space_key_version\n      AND NEW.wrapped_key_algorithm=OLD.wrapped_key_algorithm\n      AND NEW.wrapped_key_ciphertext=OLD.wrapped_key_ciphertext\n      AND NEW.wrapped_key_version=OLD.wrapped_key_version\n      AND NEW.wrapped_key_nonce=OLD.wrapped_key_nonce\n      AND NEW.descriptor_algorithm=OLD.descriptor_algorithm\n      AND NEW.descriptor_ciphertext=OLD.descriptor_ciphertext\n      AND NEW.descriptor_key_version=OLD.descriptor_key_version\n      AND NEW.descriptor_nonce=OLD.descriptor_nonce\n      AND NEW.genesis_proof_algorithm=OLD.genesis_proof_algorithm\n      AND NEW.genesis_proof_ciphertext=OLD.genesis_proof_ciphertext\n      AND NEW.genesis_proof_key_version=OLD.genesis_proof_key_version\n      AND NEW.genesis_proof_nonce=OLD.genesis_proof_nonce\n      AND NEW.genesis_token=OLD.genesis_token\n      AND NEW.request_digest=OLD.request_digest\n      AND NEW.effect_started_at IS NOT NULL\n      AND NEW.winner_digest IS NULL AND NEW.winner_revision IS NULL\n      AND NEW.winner_replay IS NULL AND NEW.winner_observed_at IS NULL\n      AND NEW.settled_at IS NULL AND NEW.diagnostic_code IS NULL)\n    OR\n    (OLD.state='effect_started' AND NEW.state='winner_observed'\n      AND NEW.space_key_version=OLD.space_key_version\n      AND NEW.wrapped_key_algorithm=OLD.wrapped_key_algorithm\n      AND NEW.wrapped_key_ciphertext=OLD.wrapped_key_ciphertext\n      AND NEW.wrapped_key_version=OLD.wrapped_key_version\n      AND NEW.wrapped_key_nonce=OLD.wrapped_key_nonce\n      AND NEW.descriptor_algorithm=OLD.descriptor_algorithm\n      AND NEW.descriptor_ciphertext=OLD.descriptor_ciphertext\n      AND NEW.descriptor_key_version=OLD.descriptor_key_version\n      AND NEW.descriptor_nonce=OLD.descriptor_nonce\n      AND NEW.genesis_proof_algorithm=OLD.genesis_proof_algorithm\n      AND NEW.genesis_proof_ciphertext=OLD.genesis_proof_ciphertext\n      AND NEW.genesis_proof_key_version=OLD.genesis_proof_key_version\n      AND NEW.genesis_proof_nonce=OLD.genesis_proof_nonce\n      AND NEW.genesis_token=OLD.genesis_token\n      AND NEW.request_digest=OLD.request_digest\n      AND NEW.effect_started_at=OLD.effect_started_at\n      AND NEW.winner_digest IS NOT NULL AND NEW.winner_revision IS NOT NULL\n      AND NEW.winner_replay IS NOT NULL AND NEW.winner_observed_at IS NOT NULL\n      AND NEW.settled_at IS NULL AND NEW.diagnostic_code IS NULL)\n    OR\n    (OLD.state='winner_observed' AND NEW.state='settled'\n      AND NEW.space_key_version=OLD.space_key_version\n      AND NEW.wrapped_key_algorithm=OLD.wrapped_key_algorithm\n      AND NEW.wrapped_key_ciphertext=OLD.wrapped_key_ciphertext\n      AND NEW.wrapped_key_version=OLD.wrapped_key_version\n      AND NEW.wrapped_key_nonce=OLD.wrapped_key_nonce\n      AND NEW.descriptor_algorithm=OLD.descriptor_algorithm\n      AND NEW.descriptor_ciphertext=OLD.descriptor_ciphertext\n      AND NEW.descriptor_key_version=OLD.descriptor_key_version\n      AND NEW.descriptor_nonce=OLD.descriptor_nonce\n      AND NEW.genesis_proof_algorithm=OLD.genesis_proof_algorithm\n      AND NEW.genesis_proof_ciphertext=OLD.genesis_proof_ciphertext\n      AND NEW.genesis_proof_key_version=OLD.genesis_proof_key_version\n      AND NEW.genesis_proof_nonce=OLD.genesis_proof_nonce\n      AND NEW.genesis_token=OLD.genesis_token\n      AND NEW.request_digest=OLD.request_digest\n      AND NEW.effect_started_at=OLD.effect_started_at\n      AND NEW.winner_digest=OLD.winner_digest\n      AND NEW.winner_revision=OLD.winner_revision\n      AND NEW.winner_replay=OLD.winner_replay\n      AND NEW.winner_observed_at=OLD.winner_observed_at\n      AND NEW.settled_at IS NOT NULL AND NEW.diagnostic_code IS NULL)\n    OR\n    (OLD.state IN ('allocating','key_staged','prepared','effect_started','winner_observed')\n      AND NEW.state IN ('conflict','error')\n      AND NEW.space_key_version IS OLD.space_key_version\n      AND NEW.wrapped_key_algorithm IS OLD.wrapped_key_algorithm\n      AND NEW.wrapped_key_ciphertext IS OLD.wrapped_key_ciphertext\n      AND NEW.wrapped_key_version IS OLD.wrapped_key_version\n      AND NEW.wrapped_key_nonce IS OLD.wrapped_key_nonce\n      AND NEW.descriptor_algorithm IS OLD.descriptor_algorithm\n      AND NEW.descriptor_ciphertext IS OLD.descriptor_ciphertext\n      AND NEW.descriptor_key_version IS OLD.descriptor_key_version\n      AND NEW.descriptor_nonce IS OLD.descriptor_nonce\n      AND NEW.genesis_proof_algorithm IS OLD.genesis_proof_algorithm\n      AND NEW.genesis_proof_ciphertext IS OLD.genesis_proof_ciphertext\n      AND NEW.genesis_proof_key_version IS OLD.genesis_proof_key_version\n      AND NEW.genesis_proof_nonce IS OLD.genesis_proof_nonce\n      AND NEW.genesis_token IS OLD.genesis_token\n      AND NEW.request_digest IS OLD.request_digest\n      AND NEW.effect_started_at IS OLD.effect_started_at\n      AND NEW.winner_digest IS OLD.winner_digest\n      AND NEW.winner_revision IS OLD.winner_revision\n      AND NEW.winner_replay IS OLD.winner_replay\n      AND NEW.winner_observed_at IS OLD.winner_observed_at\n      AND NEW.settled_at IS NOT NULL AND NEW.diagnostic_code IS NOT NULL)\n  )\n)\nBEGIN SELECT RAISE(ABORT, 'invalid canonical memory hosted create transition'); END"
    },
    {
      "type": "trigger",
      "name": "project_memory_portable_adoption_proof_delete_guard",
      "tbl_name": "project_memory_portable_adoption_proofs",
      "sql": "CREATE TRIGGER project_memory_portable_adoption_proof_delete_guard\nBEFORE DELETE ON project_memory_portable_adoption_proofs\nBEGIN SELECT RAISE(ABORT, 'canonical memory portable adoption proof is permanent'); END"
    },
    {
      "type": "trigger",
      "name": "project_memory_portable_adoption_proof_insert_guard",
      "tbl_name": "project_memory_portable_adoption_proofs",
      "sql": "CREATE TRIGGER project_memory_portable_adoption_proof_insert_guard\nBEFORE INSERT ON project_memory_portable_adoption_proofs\nWHEN NOT EXISTS (\n  SELECT 1 FROM project_memory_authorities authority\n  WHERE authority.project_id=NEW.project_id\n    AND authority.identity_contract=2\n    AND authority.physical_state='initialized'\n    AND authority.canonical_space_id=NEW.canonical_space_id\n    AND authority.binding_digest=NEW.canonical_binding_digest\n    AND authority.head_sequence=NEW.sequence\n    AND authority.head_operation_sha256=NEW.operation_sha256\n)\nBEGIN SELECT RAISE(ABORT, 'invalid canonical memory portable adoption proof'); END"
    },
    {
      "type": "trigger",
      "name": "project_memory_portable_adoption_proof_update_guard",
      "tbl_name": "project_memory_portable_adoption_proofs",
      "sql": "CREATE TRIGGER project_memory_portable_adoption_proof_update_guard\nBEFORE UPDATE ON project_memory_portable_adoption_proofs\nBEGIN SELECT RAISE(ABORT, 'canonical memory portable adoption proof is immutable'); END"
    },
    {
      "type": "trigger",
      "name": "project_memory_sync_authority_fence",
      "tbl_name": "project_memory_authorities",
      "sql": "CREATE TRIGGER project_memory_sync_authority_fence\nBEFORE UPDATE ON project_memory_authorities\nWHEN EXISTS (\n  SELECT 1 FROM project_memory_sync_intents intent\n  WHERE intent.project_id=OLD.project_id\n    AND intent.state IN ('prepared','effect_started','response_observed')\n)\nBEGIN SELECT RAISE(ABORT, 'canonical memory mutation fenced by hosted sync'); END"
    },
    {
      "type": "trigger",
      "name": "project_memory_sync_intent_delete_guard",
      "tbl_name": "project_memory_sync_intents",
      "sql": "CREATE TRIGGER project_memory_sync_intent_delete_guard\nBEFORE DELETE ON project_memory_sync_intents\nWHEN OLD.state!='settled'\nBEGIN SELECT RAISE(ABORT, 'unsettled canonical memory sync intent is immutable'); END"
    },
    {
      "type": "trigger",
      "name": "project_memory_sync_intent_insert_guard",
      "tbl_name": "project_memory_sync_intents",
      "sql": "CREATE TRIGGER project_memory_sync_intent_insert_guard\nBEFORE INSERT ON project_memory_sync_intents\nWHEN NEW.state!='prepared'\n  OR EXISTS (\n    SELECT 1 FROM project_memory_hosted_create_intents create_intent\n    WHERE create_intent.project_id=NEW.project_id\n      AND create_intent.state IN (\n        'allocating','key_staged','prepared','effect_started','winner_observed'\n      )\n  )\n  OR NOT EXISTS (\n    SELECT 1 FROM project_memory_hosted_attachments attachment\n    WHERE attachment.project_id=NEW.project_id\n      AND attachment.state='attached'\n      AND attachment.generation=NEW.attachment_generation\n      AND attachment.revision=NEW.attachment_revision\n      AND attachment.canonical_binding_digest=NEW.canonical_binding_digest\n      AND attachment.genesis_token=NEW.remote_genesis_token\n      AND attachment.remote_revision=NEW.remote_revision\n      AND attachment.remote_key_version=NEW.remote_key_version\n      AND attachment.remote_head_sequence=NEW.remote_head_sequence\n      AND attachment.remote_head_operation_sha256 IS NEW.remote_head_operation_sha256\n      AND attachment.remote_head_digest=NEW.remote_head_digest\n      AND attachment.remote_head_token=NEW.remote_head_token\n      AND attachment.remote_head_proof_digest=NEW.remote_head_proof_digest\n  )\n  OR NOT EXISTS (\n    SELECT 1 FROM project_memory_authorities authority\n    WHERE authority.project_id=NEW.project_id\n      AND authority.physical_state='initialized'\n      AND authority.sync_state NOT IN ('conflict','error')\n      AND authority.binding_digest=NEW.canonical_binding_digest\n      AND authority.revision=NEW.authority_revision\n      AND authority.head_sequence=NEW.local_head_sequence\n      AND authority.head_operation_sha256 IS NEW.local_head_operation_sha256\n      AND authority.head_digest=NEW.local_head_digest\n  )\n  OR EXISTS (\n    SELECT 1 FROM memory_submissions submission\n    WHERE submission.project_id=NEW.project_id AND submission.kind='share'\n      AND submission.state IN ('prepared','effect_started','ambiguous')\n  )\n  OR ((NEW.direction='push') != (\n    SELECT COUNT(*)=1 FROM project_memory_sync_spool spool\n    WHERE spool.intent_id=NEW.id AND spool.phase='request'\n  ))\n  OR EXISTS (SELECT 1 FROM project_memory_sync_spool spool WHERE spool.intent_id=NEW.id AND spool.phase='response')\n  OR (NEW.direction='push' AND NOT EXISTS (\n    SELECT 1 FROM project_memory_sync_spool spool\n    WHERE spool.intent_id=NEW.id AND spool.phase='request'\n      AND spool.genesis_token=NEW.remote_genesis_token\n      AND spool.sequence=NEW.remote_head_sequence+1\n      AND spool.prior_token=NEW.remote_head_token\n      AND spool.operation_key_version=NEW.remote_key_version\n      AND spool.sequence<=NEW.local_head_sequence\n      AND (spool.sequence!=NEW.local_head_sequence OR spool.head_token=NEW.local_head_token)\n  ))\nBEGIN SELECT RAISE(ABORT, 'invalid canonical memory sync intent'); END"
    },
    {
      "type": "trigger",
      "name": "project_memory_sync_intent_retained_quota",
      "tbl_name": "project_memory_sync_intents",
      "sql": "CREATE TRIGGER project_memory_sync_intent_retained_quota\nBEFORE INSERT ON project_memory_sync_intents\nWHEN (SELECT COUNT(*) FROM project_memory_sync_intents WHERE project_id=NEW.project_id)>=10000\nBEGIN SELECT RAISE(ABORT, 'canonical memory sync retained quota exceeded'); END"
    },
    {
      "type": "trigger",
      "name": "project_memory_sync_intent_transition_guard",
      "tbl_name": "project_memory_sync_intents",
      "sql": "CREATE TRIGGER project_memory_sync_intent_transition_guard\nBEFORE UPDATE ON project_memory_sync_intents\nWHEN NOT (\n  NEW.id=OLD.id AND NEW.idempotency_key=OLD.idempotency_key\n  AND NEW.project_id=OLD.project_id AND NEW.direction=OLD.direction\n  AND NEW.attachment_generation=OLD.attachment_generation\n  AND NEW.attachment_revision=OLD.attachment_revision\n  AND NEW.authority_revision=OLD.authority_revision\n  AND NEW.canonical_binding_digest=OLD.canonical_binding_digest\n  AND NEW.local_head_sequence=OLD.local_head_sequence\n  AND NEW.local_head_operation_sha256 IS OLD.local_head_operation_sha256\n  AND NEW.local_head_digest=OLD.local_head_digest\n  AND NEW.local_head_token=OLD.local_head_token\n  AND NEW.remote_genesis_token=OLD.remote_genesis_token\n  AND NEW.remote_revision=OLD.remote_revision\n  AND NEW.remote_key_version=OLD.remote_key_version\n  AND NEW.remote_head_sequence=OLD.remote_head_sequence\n  AND NEW.remote_head_operation_sha256 IS OLD.remote_head_operation_sha256\n  AND NEW.remote_head_digest=OLD.remote_head_digest\n  AND NEW.remote_head_token=OLD.remote_head_token\n  AND NEW.remote_head_proof_digest=OLD.remote_head_proof_digest\n  AND NEW.request_digest=OLD.request_digest AND NEW.created_at=OLD.created_at\n  AND NEW.updated_at>=OLD.updated_at\n  AND (\n    (OLD.state='prepared' AND NEW.state='effect_started'\n      AND NEW.effect_started_at IS NOT NULL)\n    OR\n    (OLD.state='effect_started' AND NEW.state='response_observed'\n      AND NEW.effect_started_at=OLD.effect_started_at\n      AND NEW.result_head_sequence IS NULL\n      AND NEW.result_head_operation_sha256 IS NULL\n      AND NEW.result_head_digest IS NULL\n      AND NEW.response_digest IS NOT NULL\n      AND NEW.response_genesis_token=OLD.remote_genesis_token\n        AND ((OLD.direction='push'\n          AND NEW.response_revision=OLD.remote_revision\n          AND NEW.response_key_version=OLD.remote_key_version\n          AND NEW.response_head_sequence=OLD.remote_head_sequence+1\n          AND NOT EXISTS (SELECT 1 FROM project_memory_sync_spool spool WHERE spool.intent_id=OLD.id AND spool.phase='response'))\n        OR (OLD.direction='pull'\n          AND NEW.response_revision=OLD.remote_revision\n          AND NEW.response_key_version=OLD.remote_key_version\n          AND NEW.response_head_sequence=OLD.remote_head_sequence\n          AND NEW.response_head_operation_sha256 IS OLD.remote_head_operation_sha256\n          AND NEW.response_head_digest=OLD.remote_head_digest\n          AND NEW.response_head_token=OLD.remote_head_token\n          AND NEW.response_head_proof_digest=OLD.remote_head_proof_digest\n          AND ((OLD.remote_head_sequence=OLD.local_head_sequence\n              AND NOT EXISTS (SELECT 1 FROM project_memory_sync_spool spool WHERE spool.intent_id=OLD.id AND spool.phase='response'))\n            OR (OLD.remote_head_sequence>OLD.local_head_sequence\n              AND EXISTS (\n                SELECT 1 FROM project_memory_sync_spool spool\n                WHERE spool.intent_id=OLD.id AND spool.phase='response'\n                  AND spool.genesis_token=OLD.remote_genesis_token\n                  AND spool.prior_token=OLD.local_head_token\n                  AND spool.sequence=OLD.local_head_sequence+1\n                  AND spool.sequence<=OLD.remote_head_sequence\n                  AND spool.operation_key_version=OLD.remote_key_version\n                  AND (spool.sequence!=OLD.remote_head_sequence OR spool.head_token=OLD.remote_head_token)\n              ))))))\n    OR\n    (OLD.state='response_observed' AND NEW.state='response_observed'\n      AND OLD.direction='pull'\n      AND NEW.effect_started_at=OLD.effect_started_at\n      AND NEW.response_digest=OLD.response_digest\n      AND NEW.response_genesis_token=OLD.response_genesis_token\n      AND NEW.response_revision=OLD.response_revision\n      AND NEW.response_key_version=OLD.response_key_version\n      AND NEW.response_head_sequence=OLD.response_head_sequence\n      AND NEW.response_head_operation_sha256 IS OLD.response_head_operation_sha256\n      AND NEW.response_head_digest=OLD.response_head_digest\n      AND NEW.response_head_token=OLD.response_head_token\n      AND NEW.response_head_proof_digest=OLD.response_head_proof_digest\n      AND NEW.response_observed_at=OLD.response_observed_at\n      AND OLD.result_head_sequence IS NULL\n      AND OLD.result_head_operation_sha256 IS NULL\n      AND OLD.result_head_digest IS NULL\n      AND NEW.result_head_sequence=OLD.local_head_sequence+1\n      AND NEW.result_head_sequence<=OLD.response_head_sequence\n      AND NEW.result_head_operation_sha256 IS NOT NULL\n      AND NEW.result_head_digest IS NOT NULL\n      AND EXISTS (\n        SELECT 1 FROM project_memory_sync_spool spool\n        WHERE spool.intent_id=OLD.id AND spool.phase='response'\n          AND spool.sequence=NEW.result_head_sequence\n      )\n      AND NEW.settled_at IS NULL AND NEW.diagnostic_code IS NULL)\n    OR\n    (OLD.state='response_observed' AND NEW.state='settled'\n      AND NEW.effect_started_at=OLD.effect_started_at\n      AND NEW.response_digest=OLD.response_digest\n      AND NEW.response_genesis_token=OLD.response_genesis_token\n      AND NEW.response_revision=OLD.response_revision\n      AND NEW.response_key_version=OLD.response_key_version\n      AND NEW.response_head_sequence=OLD.response_head_sequence\n      AND NEW.response_head_operation_sha256 IS OLD.response_head_operation_sha256\n      AND NEW.response_head_digest=OLD.response_head_digest\n      AND NEW.response_head_token=OLD.response_head_token\n      AND NEW.response_head_proof_digest=OLD.response_head_proof_digest\n      AND NEW.response_observed_at=OLD.response_observed_at\n      AND NEW.result_head_sequence IS NOT NULL\n      AND (\n        (OLD.direction='push'\n          AND OLD.result_head_sequence IS NULL\n          AND NEW.result_head_sequence=OLD.local_head_sequence\n          AND NEW.result_head_operation_sha256 IS OLD.local_head_operation_sha256\n          AND NEW.result_head_digest=OLD.local_head_digest)\n        OR\n        (OLD.direction='pull' AND NOT EXISTS (\n            SELECT 1 FROM project_memory_sync_spool spool\n            WHERE spool.intent_id=OLD.id AND spool.phase='response'\n          )\n          AND OLD.result_head_sequence IS NULL\n          AND NEW.result_head_sequence=OLD.local_head_sequence\n          AND NEW.result_head_operation_sha256 IS OLD.local_head_operation_sha256\n          AND NEW.result_head_digest=OLD.local_head_digest)\n        OR\n        (OLD.direction='pull' AND EXISTS (\n            SELECT 1 FROM project_memory_sync_spool spool\n            WHERE spool.intent_id=OLD.id AND spool.phase='response'\n          )\n          AND NEW.result_head_sequence=OLD.result_head_sequence\n          AND NEW.result_head_operation_sha256 IS OLD.result_head_operation_sha256\n          AND NEW.result_head_digest=OLD.result_head_digest)\n      )\n      AND NEW.settled_at IS NOT NULL)\n    OR\n    (OLD.state IN ('prepared','effect_started','response_observed')\n      AND NEW.state IN ('conflict','error')\n      AND NEW.effect_started_at IS NOT NULL\n      AND NEW.response_digest IS OLD.response_digest\n      AND NEW.response_genesis_token IS OLD.response_genesis_token\n      AND NEW.response_revision IS OLD.response_revision\n      AND NEW.response_key_version IS OLD.response_key_version\n      AND NEW.response_head_sequence IS OLD.response_head_sequence\n      AND NEW.response_head_operation_sha256 IS OLD.response_head_operation_sha256\n      AND NEW.response_head_digest IS OLD.response_head_digest\n      AND NEW.response_head_token IS OLD.response_head_token\n      AND NEW.response_head_proof_digest IS OLD.response_head_proof_digest\n      AND NEW.response_observed_at IS OLD.response_observed_at\n      AND NEW.result_head_sequence IS OLD.result_head_sequence\n      AND NEW.result_head_operation_sha256 IS OLD.result_head_operation_sha256\n      AND NEW.result_head_digest IS OLD.result_head_digest\n      AND NEW.settled_at IS NOT NULL AND NEW.diagnostic_code IS NOT NULL)\n  )\n)\nBEGIN SELECT RAISE(ABORT, 'invalid canonical memory sync intent transition'); END"
    },
    {
      "type": "trigger",
      "name": "project_memory_sync_spool_delete_guard",
      "tbl_name": "project_memory_sync_spool",
      "sql": "CREATE TRIGGER project_memory_sync_spool_delete_guard\nBEFORE DELETE ON project_memory_sync_spool\nWHEN EXISTS (SELECT 1 FROM project_memory_sync_intents intent WHERE intent.id=OLD.intent_id)\nBEGIN SELECT RAISE(ABORT, 'canonical memory sync spool is immutable'); END"
    },
    {
      "type": "trigger",
      "name": "project_memory_sync_spool_insert_guard",
      "tbl_name": "project_memory_sync_spool",
      "sql": "CREATE TRIGGER project_memory_sync_spool_insert_guard\nBEFORE INSERT ON project_memory_sync_spool\nWHEN EXISTS (SELECT 1 FROM project_memory_sync_intents intent WHERE intent.id=NEW.intent_id)\n  AND NOT EXISTS (\n    SELECT 1 FROM project_memory_sync_intents intent\n    WHERE intent.id=NEW.intent_id\n      AND ((NEW.phase='request' AND intent.direction='push' AND intent.state='prepared')\n        OR (NEW.phase='response' AND intent.direction='pull' AND intent.state='effect_started'))\n  )\nBEGIN SELECT RAISE(ABORT, 'invalid canonical memory sync spool insertion'); END"
    },
    {
      "type": "trigger",
      "name": "project_memory_sync_spool_update_guard",
      "tbl_name": "project_memory_sync_spool",
      "sql": "CREATE TRIGGER project_memory_sync_spool_update_guard\nBEFORE UPDATE ON project_memory_sync_spool\nBEGIN SELECT RAISE(ABORT, 'canonical memory sync spool is immutable'); END"
    },
    {
      "type": "trigger",
      "name": "projects_label_key_immutable",
      "tbl_name": "projects",
      "sql": "CREATE TRIGGER projects_label_key_immutable\nBEFORE UPDATE OF label,label_key ON projects\nWHEN NEW.label IS NOT OLD.label OR NEW.label_key IS NOT OLD.label_key\nBEGIN SELECT RAISE(ABORT, 'project label identity is immutable'); END"
    },
    {
      "type": "trigger",
      "name": "projects_label_key_insert_guard",
      "tbl_name": "projects",
      "sql": "CREATE TRIGGER projects_label_key_insert_guard\nBEFORE INSERT ON projects\nWHEN NEW.label_key IS NULL\n  OR length(CAST(NEW.label_key AS BLOB)) NOT BETWEEN 1 AND 4096\nBEGIN SELECT RAISE(ABORT, 'invalid project label key'); END"
    },
    {
      "type": "trigger",
      "name": "provider_interaction_transitions_immutable_delete",
      "tbl_name": "provider_interaction_transitions",
      "sql": "CREATE TRIGGER provider_interaction_transitions_immutable_delete\nBEFORE DELETE ON provider_interaction_transitions\nBEGIN SELECT RAISE(ABORT, 'provider interaction transition is immutable'); END"
    },
    {
      "type": "trigger",
      "name": "provider_interaction_transitions_immutable_update",
      "tbl_name": "provider_interaction_transitions",
      "sql": "CREATE TRIGGER provider_interaction_transitions_immutable_update\nBEFORE UPDATE ON provider_interaction_transitions\nBEGIN SELECT RAISE(ABORT, 'provider interaction transition is immutable'); END"
    },
    {
      "type": "trigger",
      "name": "provider_interactions_authority_guard",
      "tbl_name": "provider_interactions",
      "sql": "CREATE TRIGGER provider_interactions_authority_guard\nBEFORE INSERT ON provider_interactions\nWHEN NOT EXISTS(\n  SELECT 1 FROM profiles p\n  WHERE p.id=NEW.profile_id\n    AND p.process_generation=NEW.process_generation\n    AND p.state!='removed'\n    AND (\n      NEW.session_id IS NULL\n      OR EXISTS(\n        SELECT 1 FROM sessions s\n        WHERE s.id=NEW.session_id AND s.profile_id=NEW.profile_id\n      )\n    )\n)\nBEGIN SELECT RAISE(ABORT, 'provider interaction authority mismatch'); END"
    },
    {
      "type": "trigger",
      "name": "provider_interactions_authority_immutable",
      "tbl_name": "provider_interactions",
      "sql": "CREATE TRIGGER provider_interactions_authority_immutable\nBEFORE UPDATE OF session_id,profile_id,process_generation,connection_id,\n  request_id_type,request_id_number,request_id_text,method,request_digest,\n  thread_id,turn_id,item_id,approval_id,kind,blocking,display_json,requested_at,deadline_at\nON provider_interactions\nBEGIN SELECT RAISE(ABORT, 'provider interaction authority is immutable'); END"
    },
    {
      "type": "trigger",
      "name": "provider_interactions_current_generation_prepare",
      "tbl_name": "provider_interactions",
      "sql": "CREATE TRIGGER provider_interactions_current_generation_prepare\nBEFORE UPDATE OF state ON provider_interactions\nWHEN NEW.state='response_prepared' AND NOT EXISTS(\n  SELECT 1 FROM profiles p\n  WHERE p.id=OLD.profile_id\n    AND p.process_generation=OLD.process_generation\n    AND p.state!='removed'\n)\nBEGIN SELECT RAISE(ABORT, 'provider interaction generation is stale'); END"
    },
    {
      "type": "trigger",
      "name": "provider_interactions_intent_immutable",
      "tbl_name": "provider_interactions",
      "sql": "CREATE TRIGGER provider_interactions_intent_immutable\nBEFORE UPDATE OF intended_terminal_state ON provider_interactions\nWHEN NOT (\n  (\n    OLD.state='pending'\n    AND NEW.state='response_prepared'\n    AND OLD.intended_terminal_state IS NULL\n    AND NEW.intended_terminal_state IS NOT NULL\n    AND OLD.response_digest IS NULL\n    AND NEW.response_digest IS NOT NULL\n    AND OLD.response_expected_revision IS NULL\n    AND NEW.response_expected_revision=OLD.revision\n    AND NEW.revision=OLD.revision+1\n  )\n  OR\n  (\n    OLD.state='response_prepared'\n    AND NEW.state='response_prepared'\n    AND OLD.intended_terminal_state IN ('resolved','declined','canceled')\n    AND NEW.intended_terminal_state='expired'\n    AND OLD.response_digest IS NOT NULL\n    AND NEW.response_digest IS NOT NULL\n    AND NEW.response_digest!=OLD.response_digest\n    AND NEW.response_expected_revision=OLD.response_expected_revision\n    AND NEW.revision=OLD.revision+1\n    AND NEW.terminal_at IS NULL\n    AND NEW.updated_at>=OLD.deadline_at\n  )\n)\nBEGIN SELECT RAISE(ABORT, 'provider interaction terminal intent is immutable'); END"
    },
    {
      "type": "trigger",
      "name": "provider_interactions_intent_insert_guard",
      "tbl_name": "provider_interactions",
      "sql": "CREATE TRIGGER provider_interactions_intent_insert_guard\nBEFORE INSERT ON provider_interactions\nWHEN NEW.intended_terminal_state IS NOT NULL\nBEGIN SELECT RAISE(ABORT, 'pending provider interaction cannot have terminal intent'); END"
    },
    {
      "type": "trigger",
      "name": "provider_interactions_intent_state_guard",
      "tbl_name": "provider_interactions",
      "sql": "CREATE TRIGGER provider_interactions_intent_state_guard\nBEFORE UPDATE OF state,intended_terminal_state ON provider_interactions\nWHEN\n  (NEW.state IN ('response_prepared','response_written') AND NEW.intended_terminal_state IS NULL)\n  OR (\n    OLD.state='response_written'\n    AND NEW.state IN ('resolved','declined','canceled','expired')\n    AND NEW.state IS NOT OLD.intended_terminal_state\n  )\nBEGIN SELECT RAISE(ABORT, 'provider interaction terminal state contradicts prepared intent'); END"
    },
    {
      "type": "trigger",
      "name": "provider_interactions_mcp_url_guard_insert",
      "tbl_name": "provider_interactions",
      "sql": "CREATE TRIGGER provider_interactions_mcp_url_guard_insert\nBEFORE INSERT ON provider_interactions\nWHEN NEW.kind='mcp_elicitation' AND (\n  json_extract(NEW.display_json,'$.mode')='url'\n  OR COALESCE(json_type(NEW.display_json,'$.url'),'null')!='null'\n)\nBEGIN SELECT RAISE(ABORT, 'MCP URL interaction cannot enter durable state'); END"
    },
    {
      "type": "trigger",
      "name": "provider_interactions_mcp_url_guard_update",
      "tbl_name": "provider_interactions",
      "sql": "CREATE TRIGGER provider_interactions_mcp_url_guard_update\nBEFORE UPDATE OF kind,display_json ON provider_interactions\nWHEN NEW.kind='mcp_elicitation' AND (\n  json_extract(NEW.display_json,'$.mode')='url'\n  OR COALESCE(json_type(NEW.display_json,'$.url'),'null')!='null'\n)\nBEGIN SELECT RAISE(ABORT, 'MCP URL interaction cannot enter durable state'); END"
    },
    {
      "type": "trigger",
      "name": "provider_interactions_permission_value_guard_insert",
      "tbl_name": "provider_interactions",
      "sql": "CREATE TRIGGER provider_interactions_permission_value_guard_insert\nBEFORE INSERT ON provider_interactions\nWHEN NEW.kind='permission_approval' AND EXISTS(\n  SELECT 1 FROM json_each(json_extract(NEW.display_json,'$.requested'))\n  WHERE json_type(value,'$.value') IS NOT NULL\n)\nBEGIN SELECT RAISE(ABORT, 'permission values cannot enter durable interaction display state'); END"
    },
    {
      "type": "trigger",
      "name": "provider_interactions_permission_value_guard_update",
      "tbl_name": "provider_interactions",
      "sql": "CREATE TRIGGER provider_interactions_permission_value_guard_update\nBEFORE UPDATE OF kind,display_json ON provider_interactions\nWHEN NEW.kind='permission_approval' AND EXISTS(\n  SELECT 1 FROM json_each(json_extract(NEW.display_json,'$.requested'))\n  WHERE json_type(value,'$.value') IS NOT NULL\n)\nBEGIN SELECT RAISE(ABORT, 'permission values cannot enter durable interaction display state'); END"
    },
    {
      "type": "trigger",
      "name": "provider_interactions_response_fields_guard",
      "tbl_name": "provider_interactions",
      "sql": "CREATE TRIGGER provider_interactions_response_fields_guard\nBEFORE UPDATE OF response_digest,response_expected_revision ON provider_interactions\nWHEN NOT (\n  (\n    OLD.state='pending'\n    AND NEW.state='response_prepared'\n    AND OLD.response_digest IS NULL\n    AND NEW.response_digest IS NOT NULL\n    AND OLD.response_expected_revision IS NULL\n    AND NEW.response_expected_revision=OLD.revision\n    AND OLD.intended_terminal_state IS NULL\n    AND NEW.intended_terminal_state IS NOT NULL\n    AND NEW.revision=OLD.revision+1\n  )\n  OR\n  (\n    OLD.state='response_prepared'\n    AND NEW.state='response_prepared'\n    AND OLD.intended_terminal_state IN ('resolved','declined','canceled')\n    AND NEW.intended_terminal_state='expired'\n    AND OLD.response_digest IS NOT NULL\n    AND NEW.response_digest IS NOT NULL\n    AND NEW.response_digest!=OLD.response_digest\n    AND NEW.response_expected_revision=OLD.response_expected_revision\n    AND NEW.revision=OLD.revision+1\n    AND NEW.terminal_at IS NULL\n    AND NEW.updated_at>=OLD.deadline_at\n  )\n)\nBEGIN SELECT RAISE(ABORT, 'provider interaction response authority is immutable'); END"
    },
    {
      "type": "trigger",
      "name": "provider_interactions_revision_guard",
      "tbl_name": "provider_interactions",
      "sql": "CREATE TRIGGER provider_interactions_revision_guard\nBEFORE UPDATE OF revision ON provider_interactions\nWHEN NOT (\n  NEW.revision=OLD.revision+1\n  AND (\n    NEW.state IS NOT OLD.state\n    OR (\n      OLD.state='response_prepared'\n      AND NEW.state='response_prepared'\n      AND OLD.intended_terminal_state IN ('resolved','declined','canceled')\n      AND NEW.intended_terminal_state='expired'\n      AND OLD.response_digest IS NOT NULL\n      AND NEW.response_digest IS NOT NULL\n      AND NEW.response_digest!=OLD.response_digest\n      AND NEW.response_expected_revision=OLD.response_expected_revision\n      AND NEW.terminal_at IS NULL\n      AND NEW.updated_at>=OLD.deadline_at\n    )\n  )\n)\nBEGIN SELECT RAISE(ABORT, 'illegal provider interaction revision transition'); END"
    },
    {
      "type": "trigger",
      "name": "provider_interactions_transition_guard",
      "tbl_name": "provider_interactions",
      "sql": "CREATE TRIGGER provider_interactions_transition_guard\nBEFORE UPDATE OF state ON provider_interactions\nWHEN NOT (\n  NEW.revision=OLD.revision+1\n  AND (\n    (OLD.state='pending' AND NEW.state IN ('response_prepared','resolved','declined','canceled','expired','resolution_unknown'))\n    OR (OLD.state='response_prepared' AND NEW.state IN ('response_written','resolved','declined','canceled','expired','resolution_unknown'))\n    OR (OLD.state='response_written' AND NEW.state IN ('resolved','declined','canceled','expired','resolution_unknown'))\n  )\n)\nBEGIN SELECT RAISE(ABORT, 'illegal provider interaction transition'); END"
    },
    {
      "type": "trigger",
      "name": "provider_login_authority_generation_guard",
      "tbl_name": "provider_login_authorities",
      "sql": "CREATE TRIGGER provider_login_authority_generation_guard\nBEFORE UPDATE OF process_generation ON provider_login_authorities\nWHEN OLD.state!='active' OR NEW.state!='active' OR NEW.process_generation!=OLD.process_generation+1\nBEGIN SELECT RAISE(ABORT, 'illegal provider login generation transition'); END"
    },
    {
      "type": "trigger",
      "name": "provider_login_authority_identity_immutable",
      "tbl_name": "provider_login_authorities",
      "sql": "CREATE TRIGGER provider_login_authority_identity_immutable\nBEFORE UPDATE OF attempt_id,profile_id,login_id,recorded_at ON provider_login_authorities\nBEGIN SELECT RAISE(ABORT, 'provider login identity is immutable'); END"
    },
    {
      "type": "trigger",
      "name": "provider_login_authority_immutable_delete",
      "tbl_name": "provider_login_authorities",
      "sql": "CREATE TRIGGER provider_login_authority_immutable_delete\nBEFORE DELETE ON provider_login_authorities\nBEGIN SELECT RAISE(ABORT, 'provider login authority is append-only'); END"
    },
    {
      "type": "trigger",
      "name": "provider_login_authority_state_guard",
      "tbl_name": "provider_login_authorities",
      "sql": "CREATE TRIGGER provider_login_authority_state_guard\nBEFORE UPDATE OF state,settlement ON provider_login_authorities\nWHEN NOT (\n  OLD.state='active' AND NEW.state='settled' AND OLD.settlement IS NULL AND NEW.settlement IS NOT NULL\n)\nBEGIN SELECT RAISE(ABORT, 'illegal provider login settlement transition'); END"
    },
    {
      "type": "trigger",
      "name": "provider_runtime_account_revocation_revision_guard",
      "tbl_name": "provider_runtime_account_revocations",
      "sql": "CREATE TRIGGER provider_runtime_account_revocation_revision_guard\nBEFORE UPDATE ON provider_runtime_account_revocations\nWHEN NEW.revision!=OLD.revision+1 OR NEW.updated_at<OLD.updated_at\nBEGIN SELECT RAISE(ABORT, 'provider runtime account revocation revision is invalid'); END"
    },
    {
      "type": "trigger",
      "name": "queue_effect_evidence_immutable_delete",
      "tbl_name": "queue_effect_evidence",
      "sql": "CREATE TRIGGER queue_effect_evidence_immutable_delete\nBEFORE DELETE ON queue_effect_evidence\nBEGIN SELECT RAISE(ABORT, 'queue effect evidence is immutable'); END"
    },
    {
      "type": "trigger",
      "name": "queue_effect_evidence_immutable_update",
      "tbl_name": "queue_effect_evidence",
      "sql": "CREATE TRIGGER queue_effect_evidence_immutable_update\nBEFORE UPDATE ON queue_effect_evidence\nBEGIN SELECT RAISE(ABORT, 'queue effect evidence is immutable'); END"
    },
    {
      "type": "trigger",
      "name": "queue_effect_resolution_authority_guard",
      "tbl_name": "queue_effect_resolutions",
      "sql": "CREATE TRIGGER queue_effect_resolution_authority_guard\nBEFORE INSERT ON queue_effect_resolutions\nWHEN NOT EXISTS(\n  SELECT 1\n  FROM queue_entries q\n  JOIN queue_effect_evidence e ON e.queue_id=q.id\n  JOIN sessions s ON s.id=q.session_id\n  WHERE q.id=NEW.queue_id\n    AND q.state='ambiguous'\n    AND s.state!='recovery_required'\n)\nOR json_valid(NEW.evidence_json)!=1\nOR (\n  NEW.resolution_kind='proven_applied'\n  AND (\n    NEW.receipt_json IS NULL\n    OR json_valid(NEW.receipt_json)!=1\n    OR json_type(NEW.receipt_json)!='object'\n    OR json_type(NEW.receipt_json,'$.turnId')!='text'\n    OR length(json_extract(NEW.receipt_json,'$.turnId')) NOT BETWEEN 1 AND 200\n    OR NOT EXISTS(\n      SELECT 1\n      FROM queue_entries q\n      JOIN session_turn_runtime_profiles t\n        ON t.session_id=q.session_id\n       AND t.source_kind='queue_start'\n       AND t.source_id=q.id\n       AND t.turn_id=json_extract(NEW.receipt_json,'$.turnId')\n      WHERE q.id=NEW.queue_id\n    )\n  )\n)\nOR (NEW.resolution_kind='abandoned' AND NEW.receipt_json IS NOT NULL)\nBEGIN SELECT RAISE(ABORT, 'queue effect resolution authority mismatch'); END"
    },
    {
      "type": "trigger",
      "name": "queue_effect_resolutions_immutable_delete",
      "tbl_name": "queue_effect_resolutions",
      "sql": "CREATE TRIGGER queue_effect_resolutions_immutable_delete\nBEFORE DELETE ON queue_effect_resolutions\nBEGIN SELECT RAISE(ABORT, 'queue effect resolution is immutable'); END"
    },
    {
      "type": "trigger",
      "name": "queue_effect_resolutions_immutable_update",
      "tbl_name": "queue_effect_resolutions",
      "sql": "CREATE TRIGGER queue_effect_resolutions_immutable_update\nBEFORE UPDATE ON queue_effect_resolutions\nBEGIN SELECT RAISE(ABORT, 'queue effect resolution is immutable'); END"
    },
    {
      "type": "trigger",
      "name": "queue_enqueue_identity_insert_once",
      "tbl_name": "queue_entries",
      "sql": "CREATE TRIGGER queue_enqueue_identity_insert_once\nBEFORE INSERT ON queue_entries\nWHEN EXISTS(\n  SELECT 1 FROM queue_entries\n  WHERE id=NEW.id OR enqueue_sequence=NEW.enqueue_sequence\n)\nBEGIN SELECT RAISE(ABORT, 'queue enqueue identity already exists'); END"
    },
    {
      "type": "trigger",
      "name": "queue_enqueue_sequence_immutable",
      "tbl_name": "queue_entries",
      "sql": "CREATE TRIGGER queue_enqueue_sequence_immutable\nBEFORE UPDATE OF enqueue_sequence ON queue_entries\nWHEN NEW.enqueue_sequence IS NOT OLD.enqueue_sequence\nBEGIN SELECT RAISE(ABORT, 'queue enqueue sequence is immutable'); END"
    },
    {
      "type": "trigger",
      "name": "queue_enqueue_sequence_required",
      "tbl_name": "queue_entries",
      "sql": "CREATE TRIGGER queue_enqueue_sequence_required\nBEFORE INSERT ON queue_entries\nWHEN NEW.enqueue_sequence IS NULL\nBEGIN SELECT RAISE(ABORT, 'queue enqueue sequence required'); END"
    },
    {
      "type": "trigger",
      "name": "queue_message_resolution_scrub",
      "tbl_name": "queue_effect_resolutions",
      "sql": "CREATE TRIGGER queue_message_resolution_scrub\nAFTER INSERT ON queue_effect_resolutions\nBEGIN\n  INSERT INTO queue_message_scrub_authority(singleton,required_at,requires_vacuum,generation)\n  VALUES (1,NEW.created_at,0,1)\n  ON CONFLICT(singleton) DO UPDATE SET\n    required_at=MIN(required_at,excluded.required_at),\n    requires_vacuum=MAX(requires_vacuum,excluded.requires_vacuum),\n    generation=CASE\n      WHEN generation<9007199254740991 THEN generation+1\n      ELSE RAISE(ABORT, 'queue message scrub generation exhausted')\n    END;\nEND"
    },
    {
      "type": "trigger",
      "name": "queue_message_settlement_guard",
      "tbl_name": "queue_entries",
      "sql": "CREATE TRIGGER queue_message_settlement_guard\nBEFORE UPDATE OF message ON queue_entries\nWHEN NOT (\n  NEW.message='[queue message removed after settlement]'\n  AND (\n    NEW.state IN ('applied','failed','cancelled')\n    OR EXISTS(\n      SELECT 1 FROM queue_effect_resolutions r WHERE r.queue_id=OLD.id\n    )\n  )\n  AND EXISTS(\n    SELECT 1 FROM queue_message_scrub_authority a WHERE a.singleton=1\n  )\n)\nBEGIN SELECT RAISE(ABORT, 'queue message is immutable except for settlement removal'); END"
    },
    {
      "type": "trigger",
      "name": "queue_message_terminal_insert_scrub",
      "tbl_name": "queue_entries",
      "sql": "CREATE TRIGGER queue_message_terminal_insert_scrub\nAFTER INSERT ON queue_entries\nWHEN NEW.state IN ('applied','failed','cancelled')\nBEGIN\n  INSERT INTO queue_message_scrub_authority(singleton,required_at,requires_vacuum,generation)\n  VALUES (1,NEW.updated_at,0,1)\n  ON CONFLICT(singleton) DO UPDATE SET\n    required_at=MIN(required_at,excluded.required_at),\n    requires_vacuum=MAX(requires_vacuum,excluded.requires_vacuum),\n    generation=CASE\n      WHEN generation<9007199254740991 THEN generation+1\n      ELSE RAISE(ABORT, 'queue message scrub generation exhausted')\n    END;\nEND"
    },
    {
      "type": "trigger",
      "name": "queue_message_terminal_transition_scrub",
      "tbl_name": "queue_entries",
      "sql": "CREATE TRIGGER queue_message_terminal_transition_scrub\nAFTER UPDATE OF state ON queue_entries\nWHEN NEW.state IN ('applied','failed','cancelled')\nBEGIN\n  INSERT INTO queue_message_scrub_authority(singleton,required_at,requires_vacuum,generation)\n  VALUES (1,NEW.updated_at,0,1)\n  ON CONFLICT(singleton) DO UPDATE SET\n    required_at=MIN(required_at,excluded.required_at),\n    requires_vacuum=MAX(requires_vacuum,excluded.requires_vacuum),\n    generation=CASE\n      WHEN generation<9007199254740991 THEN generation+1\n      ELSE RAISE(ABORT, 'queue message scrub generation exhausted')\n    END;\nEND"
    },
    {
      "type": "trigger",
      "name": "queue_peer_action_transition",
      "tbl_name": "queue_entries",
      "sql": "CREATE TRIGGER queue_peer_action_transition\nAFTER UPDATE OF state ON queue_entries\nWHEN NEW.peer_action_id IS NOT NULL AND NEW.state IS NOT OLD.state\nBEGIN\n  UPDATE peer_session_actions\n  SET state=CASE NEW.state\n    WHEN 'pending' THEN 'queued'\n    WHEN 'dispatching' THEN 'effect_started'\n    WHEN 'applied' THEN 'applied'\n    WHEN 'failed' THEN 'failed'\n    WHEN 'ambiguous' THEN 'ambiguous'\n    WHEN 'cancelled' THEN 'cancelled'\n  END,\n  updated_at=MAX(updated_at,NEW.updated_at)\n  WHERE id=NEW.peer_action_id;\nEND"
    },
    {
      "type": "trigger",
      "name": "queue_peer_effect_evidence_guard",
      "tbl_name": "queue_entries",
      "sql": "CREATE TRIGGER queue_peer_effect_evidence_guard\nBEFORE UPDATE OF state ON queue_entries\nWHEN OLD.peer_action_id IS NOT NULL\n  AND OLD.state='pending'\n  AND NEW.state='dispatching'\n  AND NOT EXISTS (\n    SELECT 1 FROM queue_effect_evidence evidence\n    JOIN peer_session_actions action ON action.id=OLD.peer_action_id\n    WHERE evidence.queue_id=OLD.id\n      AND action.target_session_id=OLD.session_id\n      AND action.delivery='queue'\n      AND action.state='queued'\n      AND json_extract(evidence.evidence_json,'$.messageDigest')=action.message_digest\n  )\nBEGIN SELECT RAISE(ABORT, 'peer queue effect evidence required'); END"
    },
    {
      "type": "trigger",
      "name": "queue_peer_inbound_quota_guard",
      "tbl_name": "queue_entries",
      "sql": "CREATE TRIGGER queue_peer_inbound_quota_guard\nBEFORE INSERT ON queue_entries\nWHEN NEW.message_actor='peer_session' AND (\n  (\n    SELECT COUNT(*) FROM queue_entries\n    WHERE session_id=NEW.session_id\n      AND message_actor='peer_session'\n      AND state IN ('pending','dispatching','ambiguous')\n  )>=64\n  OR (\n    SELECT COALESCE(SUM(length(CAST(message AS BLOB))),0)\n    FROM queue_entries\n    WHERE session_id=NEW.session_id\n      AND message_actor='peer_session'\n      AND state IN ('pending','dispatching','ambiguous')\n  )+length(CAST(NEW.message AS BLOB))>1048576\n)\nBEGIN SELECT RAISE(ABORT, 'peer session inbound queue quota exceeded'); END"
    },
    {
      "type": "trigger",
      "name": "queue_peer_provenance_immutable",
      "tbl_name": "queue_entries",
      "sql": "CREATE TRIGGER queue_peer_provenance_immutable\nBEFORE UPDATE OF message_actor,peer_action_id ON queue_entries\nWHEN (\n  NEW.message_actor IS NOT OLD.message_actor\n  OR NEW.peer_action_id IS NOT OLD.peer_action_id\n) AND NOT (\n  OLD.message_actor='peer_session'\n  AND NEW.message_actor='peer_session'\n  AND OLD.peer_action_id IS NOT NULL\n  AND NEW.peer_action_id IS NULL\n  AND NEW.state=OLD.state\n  AND (\n    OLD.state IN ('applied','failed','cancelled')\n    OR (\n      OLD.state='ambiguous'\n      AND EXISTS (\n        SELECT 1 FROM queue_effect_resolutions resolution\n        WHERE resolution.queue_id=OLD.id\n      )\n    )\n  )\n  AND EXISTS (\n    SELECT 1 FROM peer_session_actions action\n    WHERE action.id=OLD.peer_action_id\n      AND action.target_session_id=OLD.session_id\n      AND action.delivery='queue'\n      AND action.state IN ('applied','failed','cancelled')\n  )\n)\nBEGIN SELECT RAISE(ABORT, 'queue peer provenance is immutable'); END"
    },
    {
      "type": "trigger",
      "name": "queue_peer_provenance_insert_guard",
      "tbl_name": "queue_entries",
      "sql": "CREATE TRIGGER queue_peer_provenance_insert_guard\nBEFORE INSERT ON queue_entries\nWHEN NOT (\n  (NEW.message_actor='human' AND NEW.peer_action_id IS NULL)\n  OR (\n    NEW.message_actor='peer_session'\n    AND NEW.peer_action_id IS NOT NULL\n    AND EXISTS (\n      SELECT 1 FROM peer_session_actions action\n      WHERE action.id=NEW.peer_action_id\n        AND action.target_session_id=NEW.session_id\n        AND action.delivery='queue'\n        AND action.state='queued'\n    )\n  )\n)\nBEGIN SELECT RAISE(ABORT, 'invalid queue peer provenance'); END"
    },
    {
      "type": "trigger",
      "name": "queue_sequence_authority_insert_once",
      "tbl_name": "queue_sequence_authority",
      "sql": "CREATE TRIGGER queue_sequence_authority_insert_once\nBEFORE INSERT ON queue_sequence_authority\nWHEN EXISTS(SELECT 1 FROM queue_sequence_authority WHERE singleton=1)\nBEGIN SELECT RAISE(ABORT, 'queue sequence authority already exists'); END"
    },
    {
      "type": "trigger",
      "name": "queue_sequence_authority_monotonic",
      "tbl_name": "queue_sequence_authority",
      "sql": "CREATE TRIGGER queue_sequence_authority_monotonic\nBEFORE UPDATE OF next_sequence ON queue_sequence_authority\nWHEN NEW.next_sequence<OLD.next_sequence\nBEGIN SELECT RAISE(ABORT, 'queue sequence authority cannot regress'); END"
    },
    {
      "type": "trigger",
      "name": "queue_sequence_authority_no_delete",
      "tbl_name": "queue_sequence_authority",
      "sql": "CREATE TRIGGER queue_sequence_authority_no_delete\nBEFORE DELETE ON queue_sequence_authority\nBEGIN SELECT RAISE(ABORT, 'queue sequence authority cannot be deleted'); END"
    },
    {
      "type": "trigger",
      "name": "queue_sequence_authority_singleton_immutable",
      "tbl_name": "queue_sequence_authority",
      "sql": "CREATE TRIGGER queue_sequence_authority_singleton_immutable\nBEFORE UPDATE OF singleton ON queue_sequence_authority\nWHEN NEW.singleton IS NOT OLD.singleton\nBEGIN SELECT RAISE(ABORT, 'queue sequence authority singleton is immutable'); END"
    },
    {
      "type": "trigger",
      "name": "queue_transition_guard",
      "tbl_name": "queue_entries",
      "sql": "CREATE TRIGGER queue_transition_guard BEFORE UPDATE OF state ON queue_entries\nWHEN NOT (\n  (OLD.state = 'pending' AND NEW.state IN ('dispatching','cancelled')) OR\n  (OLD.state = 'dispatching' AND NEW.state IN ('applied','failed','ambiguous'))\n)\nBEGIN SELECT RAISE(ABORT, 'illegal queue transition'); END"
    },
    {
      "type": "trigger",
      "name": "session_account_authority_active_state_guard",
      "tbl_name": "sessions",
      "sql": "CREATE TRIGGER session_account_authority_active_state_guard\nBEFORE UPDATE OF state,active_turn_id ON sessions\nWHEN (NEW.state='active' OR NEW.active_turn_id IS NOT NULL) AND NOT EXISTS(\n  SELECT 1 FROM profiles p\n  LEFT JOIN session_provider_account_authorities pa\n    ON pa.session_id=NEW.id AND pa.provider=NEW.provider_v39\n  WHERE p.id=NEW.profile_id\n    AND NOT EXISTS(\n      SELECT 1 FROM provider_runtime_account_revocations r\n      WHERE r.profile_id=NEW.profile_id\n        AND r.profile_generation=p.process_generation\n        AND r.provider=NEW.provider_v39 AND r.runtime_scope=pa.runtime_scope\n        AND (r.state='releasing' OR r.current_account_key IS NULL\n          OR r.current_account_key!=pa.account_key)\n    )\n    AND (\n      (pa.runtime_scope='personal' AND EXISTS(\n        SELECT 1 FROM session_personal_runtime_bindings b\n        WHERE b.session_id=NEW.id AND b.provider=NEW.provider_v39\n          AND b.provider_thread_id=NEW.provider_thread_id AND b.state='active'\n      ))\n      OR (pa.runtime_scope='managed' AND NOT EXISTS(\n        SELECT 1 FROM session_personal_runtime_bindings b\n        WHERE b.session_id=NEW.id AND b.state IN ('active','detaching')\n      ))\n      OR (NEW.provider_v39='devin' AND NOT EXISTS(\n        SELECT 1 FROM session_personal_runtime_bindings b\n        WHERE b.session_id=NEW.id AND b.state IN ('active','detaching')\n      ))\n    )\n    AND (\n      (NEW.provider_v39='claude' AND p.state IN ('signed_in','signed_out'))\n      OR (NEW.provider_v39='codex' AND p.state='signed_in'\n        AND p.provider_email IS NOT NULL\n        AND p.codex_account_key=pa.account_key AND EXISTS(\n          SELECT 1 FROM session_account_authorities a\n          WHERE a.session_id=NEW.id AND a.profile_id=NEW.profile_id\n            AND a.account_key IS NOT NULL\n            AND a.account_key=lower(trim(p.provider_email))\n        ))\n      OR (NEW.provider_v39='devin' AND p.state IN ('signed_in','signed_out'))\n    )\n)\nBEGIN SELECT RAISE(ABORT, 'session provider account authority is not current'); END"
    },
    {
      "type": "trigger",
      "name": "session_account_authority_insert",
      "tbl_name": "sessions",
      "sql": "CREATE TRIGGER session_account_authority_insert\nAFTER INSERT ON sessions\nBEGIN\n  INSERT INTO session_account_authorities(session_id,profile_id,account_key,recorded_at)\n  SELECT NEW.id,NEW.profile_id,\n    CASE WHEN p.provider_email IS NULL THEN NULL ELSE lower(trim(p.provider_email)) END,\n    NEW.created_at\n  FROM profiles p WHERE p.id=NEW.profile_id;\nEND"
    },
    {
      "type": "trigger",
      "name": "session_account_authority_interaction_guard",
      "tbl_name": "provider_interactions",
      "sql": "CREATE TRIGGER session_account_authority_interaction_guard\nBEFORE INSERT ON provider_interactions\nWHEN NEW.session_id IS NOT NULL AND NOT EXISTS(\n  SELECT 1 FROM sessions s\n  JOIN profiles p ON p.id=s.profile_id\n  LEFT JOIN session_provider_account_authorities pa\n    ON pa.session_id=s.id AND pa.provider=s.provider_v39\n  WHERE s.id=NEW.session_id\n    AND NOT EXISTS(\n      SELECT 1 FROM provider_runtime_account_revocations r\n      WHERE r.profile_id=s.profile_id\n        AND r.profile_generation=p.process_generation\n        AND r.provider=s.provider_v39 AND r.runtime_scope=pa.runtime_scope\n        AND (r.state='releasing' OR r.current_account_key IS NULL\n          OR r.current_account_key!=pa.account_key)\n    )\n    AND (\n      (pa.runtime_scope='personal' AND EXISTS(\n        SELECT 1 FROM session_personal_runtime_bindings b\n        WHERE b.session_id=s.id AND b.provider=s.provider_v39\n          AND b.provider_thread_id=s.provider_thread_id AND b.state='active'\n      ))\n      OR (pa.runtime_scope='managed' AND NOT EXISTS(\n        SELECT 1 FROM session_personal_runtime_bindings b\n        WHERE b.session_id=s.id AND b.state IN ('active','detaching')\n      ))\n      OR (s.provider_v39='devin' AND NOT EXISTS(\n        SELECT 1 FROM session_personal_runtime_bindings b\n        WHERE b.session_id=s.id AND b.state IN ('active','detaching')\n      ))\n    )\n    AND (\n      (s.provider_v39='claude' AND p.state IN ('signed_in','signed_out'))\n      OR (s.provider_v39='codex' AND p.state='signed_in'\n        AND p.provider_email IS NOT NULL\n        AND p.codex_account_key=pa.account_key AND EXISTS(\n          SELECT 1 FROM session_account_authorities a\n          WHERE a.session_id=s.id AND a.profile_id=s.profile_id\n            AND a.account_key IS NOT NULL\n            AND a.account_key=lower(trim(p.provider_email))\n        ))\n      OR (s.provider_v39='devin' AND p.state IN ('signed_in','signed_out'))\n    )\n)\nBEGIN SELECT RAISE(ABORT, 'session provider account authority is not current'); END"
    },
    {
      "type": "trigger",
      "name": "session_account_authority_queue_guard",
      "tbl_name": "queue_entries",
      "sql": "CREATE TRIGGER session_account_authority_queue_guard\nBEFORE INSERT ON queue_entries\nWHEN NOT EXISTS(\n  SELECT 1 FROM sessions s\n  JOIN profiles p ON p.id=s.profile_id\n  LEFT JOIN session_provider_account_authorities pa\n    ON pa.session_id=s.id AND pa.provider=s.provider_v39\n  WHERE s.id=NEW.session_id\n    AND NOT EXISTS(\n      SELECT 1 FROM provider_runtime_account_revocations r\n      WHERE r.profile_id=s.profile_id\n        AND r.profile_generation=p.process_generation\n        AND r.provider=s.provider_v39 AND r.runtime_scope=pa.runtime_scope\n        AND (r.state='releasing' OR r.current_account_key IS NULL\n          OR r.current_account_key!=pa.account_key)\n    )\n    AND (\n      (pa.runtime_scope='personal' AND EXISTS(\n        SELECT 1 FROM session_personal_runtime_bindings b\n        WHERE b.session_id=s.id AND b.provider=s.provider_v39\n          AND b.provider_thread_id=s.provider_thread_id AND b.state='active'\n      ))\n      OR (pa.runtime_scope='managed' AND NOT EXISTS(\n        SELECT 1 FROM session_personal_runtime_bindings b\n        WHERE b.session_id=s.id AND b.state IN ('active','detaching')\n      ))\n      OR (s.provider_v39='devin' AND NOT EXISTS(\n        SELECT 1 FROM session_personal_runtime_bindings b\n        WHERE b.session_id=s.id AND b.state IN ('active','detaching')\n      ))\n    )\n    AND (\n      (s.provider_v39='claude' AND p.state IN ('signed_in','signed_out'))\n      OR (s.provider_v39='codex' AND p.state='signed_in'\n        AND p.provider_email IS NOT NULL\n        AND p.codex_account_key=pa.account_key AND EXISTS(\n          SELECT 1 FROM session_account_authorities a\n          WHERE a.session_id=s.id AND a.profile_id=s.profile_id\n            AND a.account_key IS NOT NULL\n            AND a.account_key=lower(trim(p.provider_email))\n        ))\n      OR (s.provider_v39='devin' AND p.state IN ('signed_in','signed_out'))\n    )\n)\nBEGIN SELECT RAISE(ABORT, 'session provider account authority is not current'); END"
    },
    {
      "type": "trigger",
      "name": "session_account_authority_rebind",
      "tbl_name": "sessions",
      "sql": "CREATE TRIGGER session_account_authority_rebind\nAFTER UPDATE OF profile_id ON sessions\nWHEN NEW.profile_id!=OLD.profile_id\nBEGIN\n  UPDATE session_account_authorities\n  SET profile_id=NEW.profile_id,\n    account_key=(SELECT CASE WHEN p.provider_email IS NULL THEN NULL ELSE lower(trim(p.provider_email)) END\n                 FROM profiles p WHERE p.id=NEW.profile_id),\n    recorded_at=NEW.updated_at\n  WHERE session_id=NEW.id;\nEND"
    },
    {
      "type": "trigger",
      "name": "session_account_authority_task_insert_guard",
      "tbl_name": "session_tasks",
      "sql": "CREATE TRIGGER session_account_authority_task_insert_guard\nBEFORE INSERT ON session_tasks\nWHEN NEW.status='active' AND NOT EXISTS(\n  SELECT 1 FROM sessions s\n  JOIN profiles p ON p.id=s.profile_id\n  LEFT JOIN session_provider_account_authorities pa\n    ON pa.session_id=s.id AND pa.provider=s.provider_v39\n  WHERE s.id=NEW.session_id\n    AND NOT EXISTS(\n      SELECT 1 FROM provider_runtime_account_revocations r\n      WHERE r.profile_id=s.profile_id\n        AND r.profile_generation=p.process_generation\n        AND r.provider=s.provider_v39 AND r.runtime_scope=pa.runtime_scope\n        AND (r.state='releasing' OR r.current_account_key IS NULL\n          OR r.current_account_key!=pa.account_key)\n    )\n    AND (\n      (pa.runtime_scope='personal' AND EXISTS(\n        SELECT 1 FROM session_personal_runtime_bindings b\n        WHERE b.session_id=s.id AND b.provider=s.provider_v39\n          AND b.provider_thread_id=s.provider_thread_id AND b.state='active'\n      ))\n      OR (pa.runtime_scope='managed' AND NOT EXISTS(\n        SELECT 1 FROM session_personal_runtime_bindings b\n        WHERE b.session_id=s.id AND b.state IN ('active','detaching')\n      ))\n      OR (s.provider_v39='devin' AND NOT EXISTS(\n        SELECT 1 FROM session_personal_runtime_bindings b\n        WHERE b.session_id=s.id AND b.state IN ('active','detaching')\n      ))\n    )\n    AND (\n      (s.provider_v39='claude' AND p.state IN ('signed_in','signed_out'))\n      OR (s.provider_v39='codex' AND p.state='signed_in'\n        AND p.provider_email IS NOT NULL\n        AND p.codex_account_key=pa.account_key AND EXISTS(\n          SELECT 1 FROM session_account_authorities a\n          WHERE a.session_id=s.id AND a.profile_id=s.profile_id\n            AND a.account_key IS NOT NULL\n            AND a.account_key=lower(trim(p.provider_email))\n        ))\n      OR (s.provider_v39='devin' AND p.state IN ('signed_in','signed_out'))\n    )\n)\nBEGIN SELECT RAISE(ABORT, 'session provider account authority is not current'); END"
    },
    {
      "type": "trigger",
      "name": "session_account_authority_task_update_guard",
      "tbl_name": "session_tasks",
      "sql": "CREATE TRIGGER session_account_authority_task_update_guard\nBEFORE UPDATE OF status ON session_tasks\nWHEN NEW.status='active' AND NOT EXISTS(\n  SELECT 1 FROM sessions s\n  JOIN profiles p ON p.id=s.profile_id\n  LEFT JOIN session_provider_account_authorities pa\n    ON pa.session_id=s.id AND pa.provider=s.provider_v39\n  WHERE s.id=NEW.session_id\n    AND NOT EXISTS(\n      SELECT 1 FROM provider_runtime_account_revocations r\n      WHERE r.profile_id=s.profile_id\n        AND r.profile_generation=p.process_generation\n        AND r.provider=s.provider_v39 AND r.runtime_scope=pa.runtime_scope\n        AND (r.state='releasing' OR r.current_account_key IS NULL\n          OR r.current_account_key!=pa.account_key)\n    )\n    AND (\n      (pa.runtime_scope='personal' AND EXISTS(\n        SELECT 1 FROM session_personal_runtime_bindings b\n        WHERE b.session_id=s.id AND b.provider=s.provider_v39\n          AND b.provider_thread_id=s.provider_thread_id AND b.state='active'\n      ))\n      OR (pa.runtime_scope='managed' AND NOT EXISTS(\n        SELECT 1 FROM session_personal_runtime_bindings b\n        WHERE b.session_id=s.id AND b.state IN ('active','detaching')\n      ))\n      OR (s.provider_v39='devin' AND NOT EXISTS(\n        SELECT 1 FROM session_personal_runtime_bindings b\n        WHERE b.session_id=s.id AND b.state IN ('active','detaching')\n      ))\n    )\n    AND (\n      (s.provider_v39='claude' AND p.state IN ('signed_in','signed_out'))\n      OR (s.provider_v39='codex' AND p.state='signed_in'\n        AND p.provider_email IS NOT NULL\n        AND p.codex_account_key=pa.account_key AND EXISTS(\n          SELECT 1 FROM session_account_authorities a\n          WHERE a.session_id=s.id AND a.profile_id=s.profile_id\n            AND a.account_key IS NOT NULL\n            AND a.account_key=lower(trim(p.provider_email))\n        ))\n      OR (s.provider_v39='devin' AND p.state IN ('signed_in','signed_out'))\n    )\n)\nBEGIN SELECT RAISE(ABORT, 'session provider account authority is not current'); END"
    },
    {
      "type": "trigger",
      "name": "session_account_authority_update_guard",
      "tbl_name": "session_account_authorities",
      "sql": "CREATE TRIGGER session_account_authority_update_guard\nBEFORE UPDATE ON session_account_authorities\nWHEN NOT EXISTS(\n  SELECT 1 FROM sessions s\n  WHERE s.id=NEW.session_id AND s.profile_id=NEW.profile_id\n) OR (\n  NEW.profile_id=OLD.profile_id\n  AND NEW.account_key IS NOT OLD.account_key\n  AND NOT (\n    NOT EXISTS(\n      SELECT 1 FROM session_provider_account_authorities a\n      WHERE a.session_id=NEW.session_id\n    ) AND (\n      (OLD.account_key IS NOT NULL AND NEW.account_key IS NULL)\n      OR (\n        OLD.account_key IS NULL\n        AND NEW.account_key=(\n          SELECT lower(trim(p.provider_email)) FROM profiles p\n          WHERE p.id=NEW.profile_id AND p.provider_email IS NOT NULL\n        )\n      )\n    )\n  )\n)\nBEGIN SELECT RAISE(ABORT, 'session account authority is immutable within one account profile'); END"
    },
    {
      "type": "trigger",
      "name": "session_adoption_candidate_identity_immutable",
      "tbl_name": "session_adoption_candidates",
      "sql": "CREATE TRIGGER session_adoption_candidate_identity_immutable\nBEFORE UPDATE OF provider,provider_thread_id,first_discovered_at ON session_adoption_candidates\nBEGIN SELECT RAISE(ABORT, 'session adoption candidate identity is immutable'); END"
    },
    {
      "type": "trigger",
      "name": "session_adoption_candidate_revision_guard",
      "tbl_name": "session_adoption_candidates",
      "sql": "CREATE TRIGGER session_adoption_candidate_revision_guard\nBEFORE UPDATE ON session_adoption_candidates\nWHEN NEW.revision!=OLD.revision+1\n  OR NEW.last_observed_at<OLD.last_observed_at\n  OR NEW.last_changed_at<OLD.last_changed_at\nBEGIN SELECT RAISE(ABORT, 'session adoption candidate revision is invalid'); END"
    },
    {
      "type": "trigger",
      "name": "session_adoption_candidate_source_identity_guard_insert",
      "tbl_name": "session_adoption_candidates",
      "sql": "CREATE TRIGGER session_adoption_candidate_source_identity_guard_insert\nBEFORE INSERT ON session_adoption_candidates\nWHEN NOT (\n  (\n    NEW.source_pid IS NULL\n    AND NEW.source_pid_domain IS NULL\n    AND NEW.source_proc_start IS NULL\n  )\n  OR (\n    NEW.provider='claude'\n    AND NEW.source_pid IS NOT NULL\n    AND NEW.source_pid_domain IS NOT NULL\n    AND NEW.source_proc_start IS NOT NULL\n  )\n)\nBEGIN SELECT RAISE(ABORT, 'session adoption candidate source identity is invalid'); END"
    },
    {
      "type": "trigger",
      "name": "session_adoption_candidate_source_identity_guard_update",
      "tbl_name": "session_adoption_candidates",
      "sql": "CREATE TRIGGER session_adoption_candidate_source_identity_guard_update\nBEFORE UPDATE OF provider,source_pid,source_pid_domain,source_proc_start\n  ON session_adoption_candidates\nWHEN NOT (\n  (\n    NEW.source_pid IS NULL\n    AND NEW.source_pid_domain IS NULL\n    AND NEW.source_proc_start IS NULL\n  )\n  OR (\n    NEW.provider='claude'\n    AND NEW.source_pid IS NOT NULL\n    AND NEW.source_pid_domain IS NOT NULL\n    AND NEW.source_proc_start IS NOT NULL\n  )\n)\nBEGIN SELECT RAISE(ABORT, 'session adoption candidate source identity is invalid'); END"
    },
    {
      "type": "trigger",
      "name": "session_adoption_policy_identity_immutable",
      "tbl_name": "session_adoption_policies",
      "sql": "CREATE TRIGGER session_adoption_policy_identity_immutable\nBEFORE UPDATE OF provider,created_at ON session_adoption_policies\nBEGIN SELECT RAISE(ABORT, 'session adoption policy identity is immutable'); END"
    },
    {
      "type": "trigger",
      "name": "session_adoption_policy_profile_guard_insert",
      "tbl_name": "session_adoption_policies",
      "sql": "CREATE TRIGGER session_adoption_policy_profile_guard_insert\nBEFORE INSERT ON session_adoption_policies\nWHEN NEW.state='enabled' AND NOT EXISTS(\n  SELECT 1 FROM profiles p\n  WHERE p.id=NEW.profile_id\n    AND ((NEW.provider='claude' AND p.state IN ('signed_in','signed_out'))\n      OR (NEW.provider='codex' AND p.state='signed_in'\n        AND p.provider_email IS NOT NULL AND p.codex_account_key IS NOT NULL))\n)\nBEGIN SELECT RAISE(ABORT, 'session adoption policy requires current provider authority'); END"
    },
    {
      "type": "trigger",
      "name": "session_adoption_policy_profile_guard_update",
      "tbl_name": "session_adoption_policies",
      "sql": "CREATE TRIGGER session_adoption_policy_profile_guard_update\nBEFORE UPDATE OF state,profile_id ON session_adoption_policies\nWHEN NEW.state='enabled' AND NOT EXISTS(\n  SELECT 1 FROM profiles p\n  WHERE p.id=NEW.profile_id\n    AND ((NEW.provider='claude' AND p.state IN ('signed_in','signed_out'))\n      OR (NEW.provider='codex' AND p.state='signed_in'\n        AND p.provider_email IS NOT NULL AND p.codex_account_key IS NOT NULL))\n)\nBEGIN SELECT RAISE(ABORT, 'session adoption policy requires current provider authority'); END"
    },
    {
      "type": "trigger",
      "name": "session_adoption_policy_provider_revocation_guard_insert",
      "tbl_name": "session_adoption_policies",
      "sql": "CREATE TRIGGER session_adoption_policy_provider_revocation_guard_insert\nBEFORE INSERT ON session_adoption_policies\nWHEN NEW.state='enabled' AND EXISTS(\n  SELECT 1 FROM provider_runtime_account_revocations r\n  JOIN profiles p ON p.id=r.profile_id\n  WHERE r.profile_id=NEW.profile_id AND r.provider=NEW.provider\n    AND r.runtime_scope='personal'\n    AND r.profile_generation=p.process_generation\n)\nBEGIN SELECT RAISE(ABORT, 'provider runtime account revocation must complete before adoption is enabled'); END"
    },
    {
      "type": "trigger",
      "name": "session_adoption_policy_provider_revocation_guard_update",
      "tbl_name": "session_adoption_policies",
      "sql": "CREATE TRIGGER session_adoption_policy_provider_revocation_guard_update\nBEFORE UPDATE OF state,profile_id ON session_adoption_policies\nWHEN NEW.state='enabled' AND EXISTS(\n  SELECT 1 FROM provider_runtime_account_revocations r\n  JOIN profiles p ON p.id=r.profile_id\n  WHERE r.profile_id=NEW.profile_id AND r.provider=NEW.provider\n    AND r.runtime_scope='personal'\n    AND r.profile_generation=p.process_generation\n)\nBEGIN SELECT RAISE(ABORT, 'provider runtime account revocation must complete before adoption is enabled'); END"
    },
    {
      "type": "trigger",
      "name": "session_adoption_policy_revision_guard",
      "tbl_name": "session_adoption_policies",
      "sql": "CREATE TRIGGER session_adoption_policy_revision_guard\nBEFORE UPDATE ON session_adoption_policies\nWHEN NEW.revision!=OLD.revision+1 OR NEW.updated_at<OLD.updated_at\nBEGIN SELECT RAISE(ABORT, 'session adoption policy revision is invalid'); END"
    },
    {
      "type": "trigger",
      "name": "session_adoption_policy_unsettled_claim_guard",
      "tbl_name": "session_adoption_policies",
      "sql": "CREATE TRIGGER session_adoption_policy_unsettled_claim_guard\nBEFORE UPDATE OF state,profile_id ON session_adoption_policies\nWHEN (NEW.state!=OLD.state OR NEW.profile_id IS NOT OLD.profile_id)\n  AND NOT (\n    NEW.state='disabled'\n    AND NEW.profile_id IS NULL\n    AND OLD.profile_id IS NOT NULL\n    AND EXISTS(\n      SELECT 1 FROM profile_personal_authority_revocations r\n      JOIN profiles p ON p.id=r.profile_id\n      WHERE r.profile_id=OLD.profile_id\n        AND r.profile_generation=p.process_generation\n        AND r.state='releasing'\n    )\n    OR (\n      NEW.state='disabled'\n      AND NEW.profile_id IS NULL\n      AND OLD.profile_id IS NOT NULL\n      AND EXISTS(\n        SELECT 1 FROM provider_runtime_account_revocations r\n        JOIN profiles p ON p.id=r.profile_id\n        WHERE r.profile_id=OLD.profile_id\n          AND r.profile_generation=p.process_generation\n          AND r.provider=OLD.provider\n          AND r.runtime_scope='personal'\n          AND r.state='releasing'\n      )\n    )\n  )\n  AND (\n    EXISTS(\n      SELECT 1 FROM session_adoption_candidates c\n      WHERE c.provider=OLD.provider AND c.claim_status='claiming'\n    )\n    OR (\n      OLD.provider='claude' AND EXISTS(\n        SELECT 1 FROM session_claude_process_launch_intents i\n        WHERE i.runtime_scope='personal'\n      )\n    )\n    OR (\n      OLD.provider='claude' AND NEW.profile_id IS NULL AND EXISTS(\n        SELECT 1 FROM session_claude_process_authorities a\n        WHERE a.runtime_scope='personal' AND a.state='claimed'\n      )\n    )\n    OR (\n      OLD.provider='claude' AND NEW.profile_id IS NOT NULL AND EXISTS(\n        SELECT 1 FROM session_claude_process_authorities a\n        WHERE a.runtime_scope='personal'\n          AND a.state!='released'\n          AND a.profile_id!=NEW.profile_id\n      )\n    )\n    OR (\n      NEW.profile_id IS NOT NULL AND EXISTS(\n        SELECT 1 FROM session_personal_runtime_bindings b\n        JOIN sessions s ON s.id=b.session_id\n        WHERE b.provider=OLD.provider\n          AND b.state IN ('active','detaching')\n          AND s.profile_id!=NEW.profile_id\n      )\n    )\n  )\nBEGIN SELECT RAISE(ABORT, 'unsettled personal-home claim must retain its adoption account'); END"
    },
    {
      "type": "trigger",
      "name": "session_adoption_profile_generation_guard",
      "tbl_name": "profiles",
      "sql": "CREATE TRIGGER session_adoption_profile_generation_guard\nBEFORE UPDATE OF process_generation ON profiles\nWHEN NEW.process_generation!=OLD.process_generation AND (\n  EXISTS(\n    SELECT 1 FROM session_claude_process_authorities a\n    WHERE a.profile_id=OLD.id\n      AND a.profile_generation=OLD.process_generation\n      AND a.state!='released'\n  )\n  OR EXISTS(\n    SELECT 1 FROM session_claude_process_launch_intents i\n    WHERE i.profile_id=OLD.id\n      AND i.profile_generation=OLD.process_generation\n  )\n  OR (\n    EXISTS(\n      SELECT 1 FROM session_personal_runtime_bindings b\n      JOIN sessions s ON s.id=b.session_id\n      WHERE s.profile_id=OLD.id AND b.state IN ('active','detaching')\n    )\n    AND NOT (\n      EXISTS(\n        SELECT 1 FROM session_adoption_profile_generation_permits permit\n        WHERE permit.profile_id=OLD.id\n          AND permit.from_generation=OLD.process_generation\n          AND permit.to_generation=NEW.process_generation\n      )\n      AND (\n        NEW.state=OLD.state\n        OR (\n          NEW.state='login_pending'\n          AND NOT EXISTS(\n            SELECT 1 FROM session_personal_runtime_bindings b\n            JOIN sessions s ON s.id=b.session_id\n            WHERE s.profile_id=OLD.id AND s.provider_v39='codex'\n              AND b.provider='codex' AND b.state IN ('active','detaching')\n          )\n        )\n      )\n    )\n  )\n)\nBEGIN SELECT RAISE(ABORT, 'live session controllers must release before account generation changes'); END"
    },
    {
      "type": "trigger",
      "name": "session_adoption_profile_generation_permit_no_update",
      "tbl_name": "session_adoption_profile_generation_permits",
      "sql": "CREATE TRIGGER session_adoption_profile_generation_permit_no_update\nBEFORE UPDATE ON session_adoption_profile_generation_permits\nBEGIN SELECT RAISE(ABORT, 'profile generation rollover permit is immutable'); END"
    },
    {
      "type": "trigger",
      "name": "session_adoption_profile_identity_guard",
      "tbl_name": "profiles",
      "sql": "CREATE TRIGGER session_adoption_profile_identity_guard\nBEFORE UPDATE OF provider_email ON profiles\nWHEN NEW.provider_email IS NOT OLD.provider_email AND EXISTS(\n  SELECT 1 FROM session_personal_runtime_bindings b\n  JOIN sessions s ON s.id=b.session_id\n  WHERE s.profile_id=OLD.id AND s.provider_v39='codex'\n    AND b.provider='codex' AND b.state IN ('active','detaching')\n)\nBEGIN SELECT RAISE(ABORT, 'live session controllers must release before account identity changes'); END"
    },
    {
      "type": "trigger",
      "name": "session_adoption_profile_signed_out_policy_disable",
      "tbl_name": "profiles",
      "sql": "CREATE TRIGGER session_adoption_profile_signed_out_policy_disable\nAFTER UPDATE OF state ON profiles\nWHEN NEW.state='signed_out' AND OLD.state!='signed_out'\nBEGIN\n  UPDATE session_adoption_policies\n  SET profile_id=NULL,state='disabled',revision=revision+1,\n    updated_at=MAX(updated_at,NEW.updated_at)\n  WHERE profile_id=NEW.id AND provider='codex' AND state='enabled';\nEND"
    },
    {
      "type": "trigger",
      "name": "session_adoption_profile_signout_guard",
      "tbl_name": "profiles",
      "sql": "CREATE TRIGGER session_adoption_profile_signout_guard\nBEFORE UPDATE OF state ON profiles\nWHEN NEW.state IN ('signed_out','removed') AND NEW.state!=OLD.state AND (\n  EXISTS(\n    SELECT 1 FROM session_personal_runtime_bindings b\n    JOIN sessions s ON s.id=b.session_id\n    WHERE s.profile_id=OLD.id AND b.state IN ('active','detaching')\n      AND (NEW.state='removed' OR (s.provider_v39='codex' AND b.provider='codex'))\n  )\n  OR (NEW.state='removed' AND EXISTS(\n    SELECT 1 FROM session_claude_process_authorities a\n    WHERE a.profile_id=OLD.id\n      AND a.profile_generation=OLD.process_generation\n      AND a.state!='released'\n  ))\n  OR (NEW.state='removed' AND EXISTS(\n    SELECT 1 FROM session_claude_process_launch_intents i\n    WHERE i.profile_id=OLD.id\n      AND i.profile_generation=OLD.process_generation\n  ))\n)\nBEGIN SELECT RAISE(ABORT, 'live session controllers must release before account authority ends'); END"
    },
    {
      "type": "trigger",
      "name": "session_adoption_profile_unidentified_policy_disable",
      "tbl_name": "profiles",
      "sql": "CREATE TRIGGER session_adoption_profile_unidentified_policy_disable\nAFTER UPDATE OF provider_email ON profiles\nWHEN NEW.provider_email IS NULL AND OLD.provider_email IS NOT NULL\nBEGIN\n  UPDATE session_adoption_policies\n  SET profile_id=NULL,state='disabled',revision=revision+1,\n    updated_at=MAX(updated_at,NEW.updated_at)\n  WHERE profile_id=NEW.id AND provider='codex' AND state='enabled';\nEND"
    },
    {
      "type": "trigger",
      "name": "session_claude_process_authority_revision_guard",
      "tbl_name": "session_claude_process_authorities",
      "sql": "CREATE TRIGGER session_claude_process_authority_revision_guard\nBEFORE UPDATE ON session_claude_process_authorities\nWHEN NEW.revision!=OLD.revision+1\nBEGIN SELECT RAISE(ABORT, 'Claude process authority revision is invalid'); END"
    },
    {
      "type": "trigger",
      "name": "session_claude_process_authority_session_guard_insert",
      "tbl_name": "session_claude_process_authorities",
      "sql": "CREATE TRIGGER session_claude_process_authority_session_guard_insert\nBEFORE INSERT ON session_claude_process_authorities\nWHEN NEW.state='bound' AND NOT EXISTS(\n  SELECT 1 FROM sessions s\n  WHERE s.id=NEW.session_id\n    AND s.provider_v39='claude'\n    AND s.profile_id=NEW.profile_id\n    AND s.provider_thread_id=NEW.provider_thread_id\n)\nBEGIN SELECT RAISE(ABORT, 'Claude process authority session binding mismatch'); END"
    },
    {
      "type": "trigger",
      "name": "session_claude_process_authority_session_guard_update",
      "tbl_name": "session_claude_process_authorities",
      "sql": "CREATE TRIGGER session_claude_process_authority_session_guard_update\nBEFORE UPDATE OF session_id,state ON session_claude_process_authorities\nWHEN NEW.state='bound' AND NOT EXISTS(\n  SELECT 1 FROM sessions s\n  WHERE s.id=NEW.session_id\n    AND s.provider_v39='claude'\n    AND s.profile_id=NEW.profile_id\n    AND s.provider_thread_id=NEW.provider_thread_id\n)\nBEGIN SELECT RAISE(ABORT, 'Claude process authority session binding mismatch'); END"
    },
    {
      "type": "trigger",
      "name": "session_claude_process_launch_intent_no_update",
      "tbl_name": "session_claude_process_launch_intents",
      "sql": "CREATE TRIGGER session_claude_process_launch_intent_no_update\nBEFORE UPDATE ON session_claude_process_launch_intents\nBEGIN SELECT RAISE(ABORT, 'Claude process launch intent is immutable'); END"
    },
    {
      "type": "trigger",
      "name": "session_claude_process_launch_intent_process_guard",
      "tbl_name": "session_claude_process_launch_intents",
      "sql": "CREATE TRIGGER session_claude_process_launch_intent_process_guard\nBEFORE INSERT ON session_claude_process_launch_intents\nWHEN EXISTS(\n  SELECT 1 FROM session_claude_process_authorities a\n  WHERE a.runtime_scope=NEW.runtime_scope\n    AND a.profile_id=NEW.profile_id\n    AND a.provider_thread_id=NEW.provider_thread_id\n    AND a.state!='released'\n)\nBEGIN SELECT RAISE(ABORT, 'Claude process launch intent conflicts with live process authority'); END"
    },
    {
      "type": "trigger",
      "name": "session_claude_process_launch_intent_profile_guard",
      "tbl_name": "session_claude_process_launch_intents",
      "sql": "CREATE TRIGGER session_claude_process_launch_intent_profile_guard\nBEFORE INSERT ON session_claude_process_launch_intents\nWHEN NEW.provider_account_key IS NULL\n  OR length(NEW.provider_account_key)!=74\n  OR substr(NEW.provider_account_key,1,10)!='v1:claude:'\n  OR substr(NEW.provider_account_key,11) GLOB '*[^0-9a-f]*'\n  OR NOT EXISTS(\n  SELECT 1 FROM profiles p\n  WHERE p.id=NEW.profile_id\n    AND p.process_generation=NEW.profile_generation\n    AND p.state IN ('signed_in','signed_out')\n    AND NOT EXISTS(\n      SELECT 1 FROM provider_runtime_account_revocations r\n      WHERE r.profile_id=NEW.profile_id\n        AND r.profile_generation=NEW.profile_generation\n        AND r.provider='claude'\n        AND r.runtime_scope=NEW.runtime_scope\n        AND (r.state='releasing' OR r.current_account_key IS NULL\n          OR r.current_account_key!=NEW.provider_account_key)\n    )\n)\nBEGIN SELECT RAISE(ABORT, 'Claude process launch intent requires current provider authority'); END"
    },
    {
      "type": "trigger",
      "name": "session_events_account_authority_guard",
      "tbl_name": "session_events",
      "sql": "CREATE TRIGGER session_events_account_authority_guard\nBEFORE INSERT ON session_events\nWHEN NOT EXISTS(\n  SELECT 1 FROM sessions s JOIN profiles p ON p.id=s.profile_id\n  WHERE s.id=NEW.session_id\n    AND s.profile_id=NEW.account_id\n    AND p.process_generation=NEW.provider_generation\n)\nBEGIN SELECT RAISE(ABORT, 'session event account authority mismatch'); END"
    },
    {
      "type": "trigger",
      "name": "session_events_accounting_delete",
      "tbl_name": "session_events",
      "sql": "CREATE TRIGGER session_events_accounting_delete\nAFTER DELETE ON session_events\nBEGIN\n  UPDATE session_event_streams\n  SET retained_count=retained_count-1,\n      retained_bytes=retained_bytes-OLD.event_bytes\n  WHERE session_id=OLD.session_id AND stream_epoch=OLD.stream_epoch;\nEND"
    },
    {
      "type": "trigger",
      "name": "session_events_accounting_insert",
      "tbl_name": "session_events",
      "sql": "CREATE TRIGGER session_events_accounting_insert\nAFTER INSERT ON session_events\nBEGIN\n  UPDATE session_event_streams\n  SET retained_count=retained_count+1,\n      retained_bytes=retained_bytes+NEW.event_bytes\n  WHERE session_id=NEW.session_id AND stream_epoch=NEW.stream_epoch;\nEND"
    },
    {
      "type": "trigger",
      "name": "session_events_immutable_update",
      "tbl_name": "session_events",
      "sql": "CREATE TRIGGER session_events_immutable_update\nBEFORE UPDATE ON session_events\nBEGIN SELECT RAISE(ABORT, 'session event is immutable'); END"
    },
    {
      "type": "trigger",
      "name": "session_host_capability_binding_delete_guard",
      "tbl_name": "session_host_capability_bindings",
      "sql": "CREATE TRIGGER session_host_capability_binding_delete_guard\nBEFORE DELETE ON session_host_capability_bindings\nWHEN NOT EXISTS (\n  SELECT 1 FROM sessions s\n  WHERE s.id=OLD.session_id\n    AND s.state='starting'\n    AND s.provider_thread_id IS NULL\n    AND s.active_turn_id IS NULL\n    AND s.provider_updated_at IS NULL\n) AND NOT EXISTS (\n  SELECT 1 FROM mutation_attempts mutation\n  WHERE mutation.authority_id=OLD.session_id\n    AND mutation.kind='session.switch'\n    AND mutation.state='effect_started'\n    AND EXISTS (\n      SELECT 1 FROM session_provider_switch_targets target\n      WHERE target.attempt_id=mutation.id\n    )\n    AND EXISTS (\n      SELECT 1 FROM session_provider_switch_source_releases released\n      WHERE released.attempt_id=mutation.id\n    )\n)\nBEGIN SELECT RAISE(ABORT, 'session host capability binding is immutable'); END"
    },
    {
      "type": "trigger",
      "name": "session_host_capability_binding_immutable",
      "tbl_name": "session_host_capability_bindings",
      "sql": "CREATE TRIGGER session_host_capability_binding_immutable\nBEFORE UPDATE ON session_host_capability_bindings\nBEGIN SELECT RAISE(ABORT, 'session host capability binding is immutable'); END"
    },
    {
      "type": "trigger",
      "name": "session_message_event_source_delete_guard",
      "tbl_name": "session_message_event_sources",
      "sql": "CREATE TRIGGER session_message_event_source_delete_guard\nBEFORE DELETE ON session_message_event_sources\nWHEN EXISTS (\n  SELECT 1 FROM session_events event\n  WHERE event.session_id=OLD.session_id AND event.sequence=OLD.event_sequence\n)\nBEGIN SELECT RAISE(ABORT, 'session message event source is immutable while retained'); END"
    },
    {
      "type": "trigger",
      "name": "session_message_event_source_event_delete",
      "tbl_name": "session_events",
      "sql": "CREATE TRIGGER session_message_event_source_event_delete\nAFTER DELETE ON session_events\nBEGIN\n  DELETE FROM session_message_event_sources\n  WHERE session_id=OLD.session_id AND event_sequence=OLD.sequence;\nEND"
    },
    {
      "type": "trigger",
      "name": "session_message_event_source_immutable_update",
      "tbl_name": "session_message_event_sources",
      "sql": "CREATE TRIGGER session_message_event_source_immutable_update\nBEFORE UPDATE ON session_message_event_sources\nBEGIN SELECT RAISE(ABORT, 'session message event source is immutable'); END"
    },
    {
      "type": "trigger",
      "name": "session_message_event_source_insert_guard",
      "tbl_name": "session_message_event_sources",
      "sql": "CREATE TRIGGER session_message_event_source_insert_guard\nBEFORE INSERT ON session_message_event_sources\nWHEN NOT (\n  EXISTS (\n    SELECT 1 FROM session_events event\n    WHERE event.session_id=NEW.session_id\n      AND event.sequence=NEW.event_sequence\n      AND event.stream_epoch=NEW.stream_epoch\n      AND event.recorded_at=NEW.created_at\n      AND json_extract(event.event_json,'$.body.type')='user_message'\n      AND json_extract(event.event_json,'$.body.actor')=NEW.actor\n  )\n  AND (\n    (NEW.source_kind='mutation' AND EXISTS (\n      SELECT 1\n      FROM mutation_attempts mutation\n      JOIN mutation_effect_evidence evidence ON evidence.attempt_id=mutation.id\n      LEFT JOIN mutation_resolutions resolution ON resolution.attempt_id=mutation.id\n      WHERE mutation.id=NEW.source_id\n        AND mutation.authority_id=NEW.session_id\n        AND mutation.kind IN ('session.send','session.steer')\n        AND (\n          mutation.state='applied'\n          OR resolution.resolution_kind='proven_applied'\n        )\n        AND COALESCE(\n          json_extract(evidence.evidence_json,'$.messageActor'),\n          CASE\n            WHEN EXISTS (\n              SELECT 1 FROM autorespond_message_sources autorespond\n              WHERE autorespond.session_id=mutation.authority_id\n                AND autorespond.source_id=mutation.id\n            ) THEN 'autorespond'\n            WHEN EXISTS (\n              SELECT 1 FROM peer_session_direct_message_sources peer\n              WHERE peer.idempotency_key=mutation.idempotency_key\n                AND peer.target_session_id=mutation.authority_id\n                AND mutation.kind=('session.' || peer.delivery)\n            ) OR EXISTS (\n              SELECT 1 FROM peer_session_actions action\n              WHERE action.idempotency_key=mutation.idempotency_key\n                AND action.target_session_id=mutation.authority_id\n                AND mutation.kind=('session.' || action.delivery)\n            ) THEN 'peer_session'\n            ELSE 'human'\n          END\n        )=NEW.actor\n    ))\n    OR (NEW.source_kind='queue' AND EXISTS (\n      SELECT 1\n      FROM queue_entries queue\n      LEFT JOIN queue_effect_resolutions resolution ON resolution.queue_id=queue.id\n      WHERE queue.id=NEW.source_id\n        AND queue.session_id=NEW.session_id\n        AND (\n          queue.state='applied'\n          OR resolution.resolution_kind='proven_applied'\n        )\n        AND queue.message_actor=NEW.actor\n    ))\n  )\n)\nBEGIN SELECT RAISE(ABORT, 'invalid session message event source'); END"
    },
    {
      "type": "trigger",
      "name": "session_mutation_authority_rebinds_immutable_delete",
      "tbl_name": "session_mutation_authority_rebinds",
      "sql": "CREATE TRIGGER session_mutation_authority_rebinds_immutable_delete\nBEFORE DELETE ON session_mutation_authority_rebinds\nBEGIN SELECT RAISE(ABORT, 'session mutation authority rebind is immutable'); END"
    },
    {
      "type": "trigger",
      "name": "session_mutation_authority_rebinds_immutable_update",
      "tbl_name": "session_mutation_authority_rebinds",
      "sql": "CREATE TRIGGER session_mutation_authority_rebinds_immutable_update\nBEFORE UPDATE ON session_mutation_authority_rebinds\nBEGIN SELECT RAISE(ABORT, 'session mutation authority rebind is immutable'); END"
    },
    {
      "type": "trigger",
      "name": "session_mutation_authority_rebinds_v39_immutable_delete",
      "tbl_name": "session_mutation_authority_rebinds_v39",
      "sql": "CREATE TRIGGER session_mutation_authority_rebinds_v39_immutable_delete\nBEFORE DELETE ON session_mutation_authority_rebinds_v39\nBEGIN SELECT RAISE(ABORT, 'session mutation authority rebind v39 is immutable'); END"
    },
    {
      "type": "trigger",
      "name": "session_mutation_authority_rebinds_v39_immutable_update",
      "tbl_name": "session_mutation_authority_rebinds_v39",
      "sql": "CREATE TRIGGER session_mutation_authority_rebinds_v39_immutable_update\nBEFORE UPDATE ON session_mutation_authority_rebinds_v39\nBEGIN SELECT RAISE(ABORT, 'session mutation authority rebind v39 is immutable'); END"
    },
    {
      "type": "trigger",
      "name": "session_peer_policy_default",
      "tbl_name": "sessions",
      "sql": "CREATE TRIGGER session_peer_policy_default\nAFTER INSERT ON sessions\nBEGIN\n  INSERT INTO session_peer_policies(session_id,mode,revision,created_at,updated_at)\n  VALUES (NEW.id,'coordinate',1,NEW.created_at,NEW.created_at);\nEND"
    },
    {
      "type": "trigger",
      "name": "session_peer_policy_transition_guard",
      "tbl_name": "session_peer_policies",
      "sql": "CREATE TRIGGER session_peer_policy_transition_guard\nBEFORE UPDATE ON session_peer_policies\nWHEN NOT (\n  NEW.session_id=OLD.session_id\n  AND NEW.created_at=OLD.created_at\n  AND NEW.revision=OLD.revision+1\n  AND NEW.updated_at>=OLD.updated_at\n  AND NEW.mode IN ('off','inspect','coordinate')\n)\nBEGIN SELECT RAISE(ABORT, 'illegal peer session policy transition'); END"
    },
    {
      "type": "trigger",
      "name": "session_personal_runtime_binding_authority_guard",
      "tbl_name": "session_personal_runtime_bindings",
      "sql": "CREATE TRIGGER session_personal_runtime_binding_authority_guard\nBEFORE INSERT ON session_personal_runtime_bindings\nWHEN NOT EXISTS(\n  SELECT 1 FROM sessions s\n  WHERE s.id=NEW.session_id\n    AND s.provider_v39=NEW.provider\n    AND s.provider_thread_id=NEW.provider_thread_id\n)\nBEGIN SELECT RAISE(ABORT, 'personal runtime binding session authority mismatch'); END"
    },
    {
      "type": "trigger",
      "name": "session_personal_runtime_binding_identity_immutable",
      "tbl_name": "session_personal_runtime_bindings",
      "sql": "CREATE TRIGGER session_personal_runtime_binding_identity_immutable\nBEFORE UPDATE OF session_id,provider,provider_thread_id,adopted_at\nON session_personal_runtime_bindings\nBEGIN SELECT RAISE(ABORT, 'personal runtime binding identity is immutable'); END"
    },
    {
      "type": "trigger",
      "name": "session_personal_runtime_binding_launch_intent_detach_guard",
      "tbl_name": "session_personal_runtime_bindings",
      "sql": "CREATE TRIGGER session_personal_runtime_binding_launch_intent_detach_guard\nBEFORE UPDATE OF state ON session_personal_runtime_bindings\nWHEN NEW.state IN ('detaching','detached')\n  AND NEW.state!=OLD.state\n  AND EXISTS(\n    SELECT 1 FROM session_claude_process_launch_intents i\n    WHERE i.session_id=OLD.session_id\n  )\nBEGIN SELECT RAISE(ABORT, 'Claude process launch intent must be cancelled before personal session detach'); END"
    },
    {
      "type": "trigger",
      "name": "session_personal_runtime_binding_revision_guard",
      "tbl_name": "session_personal_runtime_bindings",
      "sql": "CREATE TRIGGER session_personal_runtime_binding_revision_guard\nBEFORE UPDATE ON session_personal_runtime_bindings\nWHEN NEW.revision!=OLD.revision+1 OR NEW.updated_at<OLD.updated_at\nBEGIN SELECT RAISE(ABORT, 'personal runtime binding revision is invalid'); END"
    },
    {
      "type": "trigger",
      "name": "session_provider_account_authority_insert_guard",
      "tbl_name": "session_provider_account_authorities",
      "sql": "CREATE TRIGGER session_provider_account_authority_insert_guard\nBEFORE INSERT ON session_provider_account_authorities\nWHEN NOT EXISTS(\n    SELECT 1 FROM sessions s\n    WHERE s.id=NEW.session_id AND s.provider_v39=NEW.provider\n      AND (\n        NEW.provider!='codex' OR EXISTS(\n          SELECT 1 FROM profiles p\n          WHERE p.id=s.profile_id AND p.state='signed_in'\n            AND p.provider_email IS NOT NULL\n            AND p.codex_account_key=NEW.account_key\n        )\n      )\n      AND NOT EXISTS(\n        SELECT 1 FROM provider_runtime_account_revocations r\n        WHERE r.profile_id=s.profile_id\n          AND r.profile_generation=(\n            SELECT p.process_generation FROM profiles p WHERE p.id=s.profile_id\n          )\n          AND r.provider=NEW.provider\n          AND r.runtime_scope=NEW.runtime_scope\n          AND (r.state='releasing' OR r.current_account_key IS NULL\n            OR r.current_account_key!=NEW.account_key)\n      )\n  ) OR NOT (\n    (NEW.provider='codex' AND length(NEW.account_key)=73\n      AND substr(NEW.account_key,1,9)='v1:codex:'\n      AND substr(NEW.account_key,10) NOT GLOB '*[^0-9a-f]*')\n    OR\n    (NEW.provider='claude' AND length(NEW.account_key)=74\n      AND substr(NEW.account_key,1,10)='v1:claude:'\n      AND substr(NEW.account_key,11) NOT GLOB '*[^0-9a-f]*')\n  )\nBEGIN SELECT RAISE(ABORT, 'session provider account authority does not match its session'); END"
    },
    {
      "type": "trigger",
      "name": "session_provider_account_authority_update_guard",
      "tbl_name": "session_provider_account_authorities",
      "sql": "CREATE TRIGGER session_provider_account_authority_update_guard\nBEFORE UPDATE ON session_provider_account_authorities\nBEGIN SELECT RAISE(ABORT, 'session provider account authority is immutable'); END"
    },
    {
      "type": "trigger",
      "name": "session_provider_switch_seed_intents_immutable_delete",
      "tbl_name": "session_provider_switch_seed_intents",
      "sql": "CREATE TRIGGER session_provider_switch_seed_intents_immutable_delete\nBEFORE DELETE ON session_provider_switch_seed_intents\nBEGIN SELECT RAISE(ABORT, 'session provider switch seed intent is immutable'); END"
    },
    {
      "type": "trigger",
      "name": "session_provider_switch_seed_intents_immutable_update",
      "tbl_name": "session_provider_switch_seed_intents",
      "sql": "CREATE TRIGGER session_provider_switch_seed_intents_immutable_update\nBEFORE UPDATE ON session_provider_switch_seed_intents\nBEGIN SELECT RAISE(ABORT, 'session provider switch seed intent is immutable'); END"
    },
    {
      "type": "trigger",
      "name": "session_provider_switch_seed_results_immutable_delete",
      "tbl_name": "session_provider_switch_seed_results",
      "sql": "CREATE TRIGGER session_provider_switch_seed_results_immutable_delete\nBEFORE DELETE ON session_provider_switch_seed_results\nBEGIN SELECT RAISE(ABORT, 'session provider switch seed result is immutable'); END"
    },
    {
      "type": "trigger",
      "name": "session_provider_switch_seed_results_immutable_update",
      "tbl_name": "session_provider_switch_seed_results",
      "sql": "CREATE TRIGGER session_provider_switch_seed_results_immutable_update\nBEFORE UPDATE ON session_provider_switch_seed_results\nBEGIN SELECT RAISE(ABORT, 'session provider switch seed result is immutable'); END"
    },
    {
      "type": "trigger",
      "name": "session_provider_switch_source_releases_immutable_delete",
      "tbl_name": "session_provider_switch_source_releases",
      "sql": "CREATE TRIGGER session_provider_switch_source_releases_immutable_delete\nBEFORE DELETE ON session_provider_switch_source_releases\nBEGIN SELECT RAISE(ABORT, 'session provider switch source release is immutable'); END"
    },
    {
      "type": "trigger",
      "name": "session_provider_switch_source_releases_immutable_update",
      "tbl_name": "session_provider_switch_source_releases",
      "sql": "CREATE TRIGGER session_provider_switch_source_releases_immutable_update\nBEFORE UPDATE ON session_provider_switch_source_releases\nBEGIN SELECT RAISE(ABORT, 'session provider switch source release is immutable'); END"
    },
    {
      "type": "trigger",
      "name": "session_provider_switch_target_releases_immutable_delete",
      "tbl_name": "session_provider_switch_target_releases",
      "sql": "CREATE TRIGGER session_provider_switch_target_releases_immutable_delete\nBEFORE DELETE ON session_provider_switch_target_releases\nBEGIN SELECT RAISE(ABORT, 'session provider switch target release is immutable'); END"
    },
    {
      "type": "trigger",
      "name": "session_provider_switch_target_releases_immutable_update",
      "tbl_name": "session_provider_switch_target_releases",
      "sql": "CREATE TRIGGER session_provider_switch_target_releases_immutable_update\nBEFORE UPDATE ON session_provider_switch_target_releases\nBEGIN SELECT RAISE(ABORT, 'session provider switch target release is immutable'); END"
    },
    {
      "type": "trigger",
      "name": "session_provider_switch_targets_immutable_delete",
      "tbl_name": "session_provider_switch_targets",
      "sql": "CREATE TRIGGER session_provider_switch_targets_immutable_delete\nBEFORE DELETE ON session_provider_switch_targets\nBEGIN SELECT RAISE(ABORT, 'session provider switch target is immutable'); END"
    },
    {
      "type": "trigger",
      "name": "session_provider_switch_targets_immutable_update",
      "tbl_name": "session_provider_switch_targets",
      "sql": "CREATE TRIGGER session_provider_switch_targets_immutable_update\nBEFORE UPDATE ON session_provider_switch_targets\nBEGIN SELECT RAISE(ABORT, 'session provider switch target is immutable'); END"
    },
    {
      "type": "trigger",
      "name": "session_runtime_profile_authority_guard",
      "tbl_name": "session_runtime_profiles",
      "sql": "CREATE TRIGGER session_runtime_profile_authority_guard\nBEFORE INSERT ON session_runtime_profiles\nWHEN NOT EXISTS(\n  SELECT 1 FROM sessions s\n  WHERE s.id=NEW.session_id AND s.profile_id=NEW.profile_id\n)\nBEGIN SELECT RAISE(ABORT, 'runtime profile session authority mismatch'); END"
    },
    {
      "type": "trigger",
      "name": "session_runtime_profiles_immutable_delete",
      "tbl_name": "session_runtime_profiles",
      "sql": "CREATE TRIGGER session_runtime_profiles_immutable_delete\nBEFORE DELETE ON session_runtime_profiles\nBEGIN SELECT RAISE(ABORT, 'session runtime profile is immutable'); END"
    },
    {
      "type": "trigger",
      "name": "session_runtime_profiles_immutable_update",
      "tbl_name": "session_runtime_profiles",
      "sql": "CREATE TRIGGER session_runtime_profiles_immutable_update\nBEFORE UPDATE ON session_runtime_profiles\nBEGIN SELECT RAISE(ABORT, 'session runtime profile is immutable'); END"
    },
    {
      "type": "trigger",
      "name": "session_start_attempts_immutable_delete",
      "tbl_name": "session_start_attempts",
      "sql": "CREATE TRIGGER session_start_attempts_immutable_delete\nBEFORE DELETE ON session_start_attempts\nBEGIN SELECT RAISE(ABORT, 'session start binding is immutable'); END"
    },
    {
      "type": "trigger",
      "name": "session_start_attempts_immutable_update",
      "tbl_name": "session_start_attempts",
      "sql": "CREATE TRIGGER session_start_attempts_immutable_update\nBEFORE UPDATE ON session_start_attempts\nBEGIN SELECT RAISE(ABORT, 'session start binding is immutable'); END"
    },
    {
      "type": "trigger",
      "name": "session_task_occurrences_insert_guard",
      "tbl_name": "session_task_occurrences",
      "sql": "CREATE TRIGGER session_task_occurrences_insert_guard\nBEFORE INSERT ON session_task_occurrences\nWHEN NOT EXISTS(\n  SELECT 1 FROM session_tasks t\n  WHERE t.id=NEW.task_id\n    AND t.session_id=NEW.session_id\n    AND t.revision=NEW.task_revision\n    AND t.status='active'\n    AND t.deleted_at IS NULL\n    AND t.next_due_at=NEW.scheduled_for\n) OR NOT EXISTS(\n  SELECT 1 FROM queue_entries q\n  WHERE q.id=NEW.queue_id\n    AND q.session_id=NEW.session_id\n    AND q.state='pending'\n) OR EXISTS(\n  SELECT 1\n  FROM session_task_occurrences o\n  JOIN queue_entries q ON q.id=o.queue_id\n  WHERE o.task_id=NEW.task_id\n    AND q.state IN ('pending','dispatching','ambiguous')\n)\nBEGIN SELECT RAISE(ABORT,'SESSION_TASK_OCCURRENCE_AUTHORITY_INVALID'); END"
    },
    {
      "type": "trigger",
      "name": "session_task_occurrences_no_update",
      "tbl_name": "session_task_occurrences",
      "sql": "CREATE TRIGGER session_task_occurrences_no_update\nBEFORE UPDATE ON session_task_occurrences\nBEGIN SELECT RAISE(ABORT,'SESSION_TASK_OCCURRENCE_IMMUTABLE'); END"
    },
    {
      "type": "trigger",
      "name": "session_task_receipts_capacity_guard",
      "tbl_name": "session_task_receipts",
      "sql": "CREATE TRIGGER session_task_receipts_capacity_guard\nBEFORE INSERT ON session_task_receipts\nWHEN (\n  SELECT COUNT(*) FROM session_task_receipts WHERE session_id=NEW.session_id\n) >= CASE WHEN NEW.operation='delete' THEN 4096 ELSE 4064 END\nBEGIN SELECT RAISE(ABORT,'SESSION_TASK_RECEIPT_CAPACITY'); END"
    },
    {
      "type": "trigger",
      "name": "session_task_receipts_no_update",
      "tbl_name": "session_task_receipts",
      "sql": "CREATE TRIGGER session_task_receipts_no_update\nBEFORE UPDATE ON session_task_receipts\nBEGIN SELECT RAISE(ABORT,'SESSION_TASK_RECEIPT_IMMUTABLE'); END"
    },
    {
      "type": "trigger",
      "name": "session_tasks_due_advance_guard",
      "tbl_name": "session_tasks",
      "sql": "CREATE TRIGGER session_tasks_due_advance_guard\nBEFORE UPDATE OF next_due_at ON session_tasks\nWHEN NEW.revision=OLD.revision AND NOT EXISTS(\n  SELECT 1 FROM session_task_occurrences o\n  WHERE o.task_id=OLD.id\n    AND o.session_id=OLD.session_id\n    AND o.task_revision=OLD.revision\n    AND o.scheduled_for=OLD.next_due_at\n)\nBEGIN SELECT RAISE(ABORT,'SESSION_TASK_DUE_ADVANCE_WITHOUT_OCCURRENCE'); END"
    },
    {
      "type": "trigger",
      "name": "session_tasks_limit_guard",
      "tbl_name": "session_tasks",
      "sql": "CREATE TRIGGER session_tasks_limit_guard\nBEFORE INSERT ON session_tasks\nWHEN (SELECT COUNT(*) FROM session_tasks WHERE session_id=NEW.session_id AND deleted_at IS NULL) >= 32\nBEGIN SELECT RAISE(ABORT,'SESSION_TASK_LIMIT'); END"
    },
    {
      "type": "trigger",
      "name": "session_tasks_update_guard",
      "tbl_name": "session_tasks",
      "sql": "CREATE TRIGGER session_tasks_update_guard\nBEFORE UPDATE ON session_tasks\nWHEN NEW.id != OLD.id\n  OR NEW.session_id != OLD.session_id\n  OR NEW.schedule_kind != OLD.schedule_kind\n  OR NEW.created_at != OLD.created_at\n  OR NOT (\n    (\n      OLD.deleted_at IS NULL\n      AND NEW.revision=OLD.revision+1\n      AND NEW.updated_at>OLD.updated_at\n    ) OR (\n      OLD.deleted_at IS NULL\n      AND NEW.deleted_at IS NULL\n      AND OLD.status='active'\n      AND NEW.status='active'\n      AND NEW.revision=OLD.revision\n      AND NEW.name=OLD.name\n      AND NEW.prompt=OLD.prompt\n      AND NEW.interval_minutes=OLD.interval_minutes\n      AND NEW.updated_at=OLD.updated_at\n      AND OLD.next_due_at IS NOT NULL\n      AND NEW.next_due_at>OLD.next_due_at\n    )\n  )\nBEGIN SELECT RAISE(ABORT,'SESSION_TASK_UPDATE_INVALID'); END"
    },
    {
      "type": "trigger",
      "name": "session_turn_runtime_profile_authority_guard",
      "tbl_name": "session_turn_runtime_profiles",
      "sql": "CREATE TRIGGER session_turn_runtime_profile_authority_guard\nBEFORE INSERT ON session_turn_runtime_profiles\nWHEN NOT EXISTS(\n  SELECT 1 FROM session_runtime_profiles p\n  WHERE p.session_id=NEW.session_id\n    AND p.source_kind=NEW.source_kind\n    AND p.source_id=NEW.source_id\n    AND p.profile_id=NEW.profile_id\n    AND p.process_generation=NEW.process_generation\n    AND p.observed_at=NEW.observed_at\n    AND p.profile_json=NEW.profile_json\n)\nBEGIN SELECT RAISE(ABORT, 'turn runtime profile source authority mismatch'); END"
    },
    {
      "type": "trigger",
      "name": "session_turn_runtime_profiles_immutable_delete",
      "tbl_name": "session_turn_runtime_profiles",
      "sql": "CREATE TRIGGER session_turn_runtime_profiles_immutable_delete\nBEFORE DELETE ON session_turn_runtime_profiles\nBEGIN SELECT RAISE(ABORT, 'turn runtime profile is immutable'); END"
    },
    {
      "type": "trigger",
      "name": "session_turn_runtime_profiles_immutable_update",
      "tbl_name": "session_turn_runtime_profiles",
      "sql": "CREATE TRIGGER session_turn_runtime_profiles_immutable_update\nBEFORE UPDATE ON session_turn_runtime_profiles\nBEGIN SELECT RAISE(ABORT, 'turn runtime profile is immutable'); END"
    },
    {
      "type": "trigger",
      "name": "sessions_claude_process_authority_rebind_guard",
      "tbl_name": "sessions",
      "sql": "CREATE TRIGGER sessions_claude_process_authority_rebind_guard\nBEFORE UPDATE OF provider_v39,profile_id,provider_thread_id ON sessions\nWHEN EXISTS(\n  SELECT 1 FROM session_claude_process_authorities a\n  WHERE a.session_id=OLD.id AND a.state IN ('bound','releasing')\n  UNION ALL\n  SELECT 1 FROM session_claude_process_launch_intents i\n  WHERE i.session_id=OLD.id\n)\nBEGIN SELECT RAISE(ABORT, 'live Claude process authority must be released before session rebind'); END"
    },
    {
      "type": "trigger",
      "name": "sessions_personal_runtime_binding_rebind_guard",
      "tbl_name": "sessions",
      "sql": "CREATE TRIGGER sessions_personal_runtime_binding_rebind_guard\nBEFORE UPDATE OF provider_v39,profile_id,provider_thread_id ON sessions\nWHEN EXISTS(\n  SELECT 1 FROM session_personal_runtime_bindings b\n  WHERE b.session_id=OLD.id AND b.state IN ('active','detaching')\n)\nBEGIN SELECT RAISE(ABORT, 'active personal runtime binding must be retired before session rebind'); END"
    },
    {
      "type": "trigger",
      "name": "work_active_limit_guard",
      "tbl_name": "works",
      "sql": "CREATE TRIGGER work_active_limit_guard\nBEFORE INSERT ON works\nWHEN NEW.state IN ('active','cancel_pending','fail_pending') AND (\n  SELECT COUNT(*) FROM works WHERE state IN ('active','cancel_pending','fail_pending')\n) >= 1024\nBEGIN SELECT RAISE(ABORT,'WORK_ACTIVE_LIMIT'); END"
    },
    {
      "type": "trigger",
      "name": "work_attempt_account_authority_guard",
      "tbl_name": "work_attempts",
      "sql": "CREATE TRIGGER work_attempt_account_authority_guard\nBEFORE INSERT ON work_attempts\nWHEN NOT EXISTS (\n  SELECT 1\n  FROM sessions AS authority_session\n  JOIN profiles AS authority_profile ON authority_profile.id=authority_session.profile_id\n  LEFT JOIN session_provider_account_authorities AS provider_authority\n    ON provider_authority.session_id=authority_session.id\n      AND provider_authority.provider=authority_session.provider_v39\n  WHERE authority_session.id=NEW.worker_session_id\n    AND authority_session.state IN ('active','idle')\n    AND (authority_session.provider_v39='codex' AND authority_session.profile_id=NEW.account_id AND authority_profile.process_generation=NEW.account_generation)\n    AND NOT EXISTS (\n      SELECT 1 FROM provider_runtime_account_revocations AS authority_revocation\n      WHERE authority_revocation.profile_id=authority_session.profile_id\n        AND authority_revocation.profile_generation=authority_profile.process_generation\n        AND authority_revocation.provider=authority_session.provider_v39\n        AND authority_revocation.runtime_scope=provider_authority.runtime_scope\n        AND (\n          authority_revocation.state='releasing'\n          OR authority_revocation.current_account_key IS NULL\n          OR authority_revocation.current_account_key!=provider_authority.account_key\n        )\n    )\n    AND (\n      (provider_authority.runtime_scope='personal' AND EXISTS (\n        SELECT 1 FROM session_personal_runtime_bindings AS authority_binding\n        WHERE authority_binding.session_id=authority_session.id\n          AND authority_binding.provider=authority_session.provider_v39\n          AND authority_binding.provider_thread_id=authority_session.provider_thread_id\n          AND authority_binding.state='active'\n      ))\n      OR (provider_authority.runtime_scope='managed' AND NOT EXISTS (\n        SELECT 1 FROM session_personal_runtime_bindings AS authority_binding\n        WHERE authority_binding.session_id=authority_session.id\n          AND authority_binding.state IN ('active','detaching')\n      ))\n      OR (authority_session.provider_v39='devin' AND NOT EXISTS (\n        SELECT 1 FROM session_personal_runtime_bindings AS authority_binding\n        WHERE authority_binding.session_id=authority_session.id\n          AND authority_binding.state IN ('active','detaching')\n      ))\n    )\n    AND (\n      (authority_session.provider_v39='claude'\n        AND authority_profile.state IN ('signed_in','signed_out'))\n      OR (authority_session.provider_v39='codex'\n        AND authority_profile.state='signed_in'\n        AND authority_profile.provider_email IS NOT NULL\n        AND authority_profile.codex_account_key=provider_authority.account_key\n        AND EXISTS (\n          SELECT 1 FROM session_account_authorities AS legacy_authority\n          WHERE legacy_authority.session_id=authority_session.id\n            AND legacy_authority.profile_id=authority_session.profile_id\n            AND legacy_authority.account_key IS NOT NULL\n            AND legacy_authority.account_key=lower(trim(authority_profile.provider_email))\n        ))\n      OR (authority_session.provider_v39='devin'\n        AND authority_profile.state IN ('signed_in','signed_out'))\n    )\n)\nBEGIN SELECT RAISE(ABORT,'WORK_ATTEMPT_ACCOUNT_AUTHORITY_MISMATCH'); END"
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
      "sql": "CREATE TRIGGER work_attempt_route_guard\nBEFORE INSERT ON work_attempts\nWHEN NOT EXISTS (\n  -- Contract 1 and 2 both resolve Codex low to the exact Luna/max tuple.\n  -- High and ultra changed model and therefore remain version-fenced.\n  SELECT 1\n  FROM work_tasks AS t\n  JOIN works AS w ON w.id=t.work_id\n  JOIN sessions AS s ON s.id=NEW.worker_session_id\n  JOIN work_members AS m ON m.work_id=NEW.work_id AND m.session_id=s.id\n  WHERE t.id=NEW.task_id AND t.work_id=NEW.work_id\n    AND t.account_id=NEW.account_id AND t.project_id=NEW.project_id\n    AND t.preset=NEW.preset AND t.fast=NEW.fast\n    AND s.profile_id=NEW.account_id AND s.project_id=NEW.project_id\n    AND s.preset=NEW.preset AND s.fast_enabled=NEW.fast\n    AND s.provider_v39='codex'\n    AND (\n      s.preset_contract=w.preset_contract\n      OR NEW.preset='low'\n    )\n    AND NOT EXISTS (\n      SELECT 1\n      FROM mutation_attempts AS sm\n      LEFT JOIN mutation_resolutions AS sr ON sr.attempt_id=sm.id\n      WHERE sm.authority_id=s.id AND sm.kind='session.switch'\n        AND sm.state IN ('effect_started','ambiguous')\n        AND sr.attempt_id IS NULL\n    )\n)\nBEGIN SELECT RAISE(ABORT,'WORK_ATTEMPT_ROUTE_MISMATCH'); END"
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
      "type": "trigger",
      "name": "work_coordinator_account_authority_guard",
      "tbl_name": "works",
      "sql": "CREATE TRIGGER work_coordinator_account_authority_guard\nBEFORE INSERT ON works\nWHEN NOT EXISTS (\n  SELECT 1\n  FROM sessions AS authority_session\n  JOIN profiles AS authority_profile ON authority_profile.id=authority_session.profile_id\n  LEFT JOIN session_provider_account_authorities AS provider_authority\n    ON provider_authority.session_id=authority_session.id\n      AND provider_authority.provider=authority_session.provider_v39\n  WHERE authority_session.id=NEW.coordinator_session_id\n    AND authority_session.state IN ('active','idle')\n    \n    AND NOT EXISTS (\n      SELECT 1 FROM provider_runtime_account_revocations AS authority_revocation\n      WHERE authority_revocation.profile_id=authority_session.profile_id\n        AND authority_revocation.profile_generation=authority_profile.process_generation\n        AND authority_revocation.provider=authority_session.provider_v39\n        AND authority_revocation.runtime_scope=provider_authority.runtime_scope\n        AND (\n          authority_revocation.state='releasing'\n          OR authority_revocation.current_account_key IS NULL\n          OR authority_revocation.current_account_key!=provider_authority.account_key\n        )\n    )\n    AND (\n      (provider_authority.runtime_scope='personal' AND EXISTS (\n        SELECT 1 FROM session_personal_runtime_bindings AS authority_binding\n        WHERE authority_binding.session_id=authority_session.id\n          AND authority_binding.provider=authority_session.provider_v39\n          AND authority_binding.provider_thread_id=authority_session.provider_thread_id\n          AND authority_binding.state='active'\n      ))\n      OR (provider_authority.runtime_scope='managed' AND NOT EXISTS (\n        SELECT 1 FROM session_personal_runtime_bindings AS authority_binding\n        WHERE authority_binding.session_id=authority_session.id\n          AND authority_binding.state IN ('active','detaching')\n      ))\n      OR (authority_session.provider_v39='devin' AND NOT EXISTS (\n        SELECT 1 FROM session_personal_runtime_bindings AS authority_binding\n        WHERE authority_binding.session_id=authority_session.id\n          AND authority_binding.state IN ('active','detaching')\n      ))\n    )\n    AND (\n      (authority_session.provider_v39='claude'\n        AND authority_profile.state IN ('signed_in','signed_out'))\n      OR (authority_session.provider_v39='codex'\n        AND authority_profile.state='signed_in'\n        AND authority_profile.provider_email IS NOT NULL\n        AND authority_profile.codex_account_key=provider_authority.account_key\n        AND EXISTS (\n          SELECT 1 FROM session_account_authorities AS legacy_authority\n          WHERE legacy_authority.session_id=authority_session.id\n            AND legacy_authority.profile_id=authority_session.profile_id\n            AND legacy_authority.account_key IS NOT NULL\n            AND legacy_authority.account_key=lower(trim(authority_profile.provider_email))\n        ))\n      OR (authority_session.provider_v39='devin'\n        AND authority_profile.state IN ('signed_in','signed_out'))\n    )\n)\nBEGIN SELECT RAISE(ABORT,'WORK_COORDINATOR_AUTHORITY_MISMATCH'); END"
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
      "name": "work_devin_preset_contract_guard",
      "tbl_name": "works",
      "sql": "CREATE TRIGGER work_devin_preset_contract_guard\nBEFORE INSERT ON works\nWHEN NEW.preset_contract!=2 AND EXISTS (\n  SELECT 1 FROM sessions AS s\n  WHERE s.id=NEW.coordinator_session_id AND s.provider_v39='devin'\n)\nBEGIN SELECT RAISE(ABORT,'WORK_DEVIN_PRESET_CONTRACT_MISMATCH'); END"
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
      "name": "work_member_account_authority_guard",
      "tbl_name": "work_members",
      "sql": "CREATE TRIGGER work_member_account_authority_guard\nBEFORE INSERT ON work_members\nWHEN NOT EXISTS (\n  SELECT 1\n  FROM sessions AS authority_session\n  JOIN profiles AS authority_profile ON authority_profile.id=authority_session.profile_id\n  LEFT JOIN session_provider_account_authorities AS provider_authority\n    ON provider_authority.session_id=authority_session.id\n      AND provider_authority.provider=authority_session.provider_v39\n  WHERE authority_session.id=NEW.session_id\n    AND authority_session.state IN ('active','idle')\n    \n    AND NOT EXISTS (\n      SELECT 1 FROM provider_runtime_account_revocations AS authority_revocation\n      WHERE authority_revocation.profile_id=authority_session.profile_id\n        AND authority_revocation.profile_generation=authority_profile.process_generation\n        AND authority_revocation.provider=authority_session.provider_v39\n        AND authority_revocation.runtime_scope=provider_authority.runtime_scope\n        AND (\n          authority_revocation.state='releasing'\n          OR authority_revocation.current_account_key IS NULL\n          OR authority_revocation.current_account_key!=provider_authority.account_key\n        )\n    )\n    AND (\n      (provider_authority.runtime_scope='personal' AND EXISTS (\n        SELECT 1 FROM session_personal_runtime_bindings AS authority_binding\n        WHERE authority_binding.session_id=authority_session.id\n          AND authority_binding.provider=authority_session.provider_v39\n          AND authority_binding.provider_thread_id=authority_session.provider_thread_id\n          AND authority_binding.state='active'\n      ))\n      OR (provider_authority.runtime_scope='managed' AND NOT EXISTS (\n        SELECT 1 FROM session_personal_runtime_bindings AS authority_binding\n        WHERE authority_binding.session_id=authority_session.id\n          AND authority_binding.state IN ('active','detaching')\n      ))\n      OR (authority_session.provider_v39='devin' AND NOT EXISTS (\n        SELECT 1 FROM session_personal_runtime_bindings AS authority_binding\n        WHERE authority_binding.session_id=authority_session.id\n          AND authority_binding.state IN ('active','detaching')\n      ))\n    )\n    AND (\n      (authority_session.provider_v39='claude'\n        AND authority_profile.state IN ('signed_in','signed_out'))\n      OR (authority_session.provider_v39='codex'\n        AND authority_profile.state='signed_in'\n        AND authority_profile.provider_email IS NOT NULL\n        AND authority_profile.codex_account_key=provider_authority.account_key\n        AND EXISTS (\n          SELECT 1 FROM session_account_authorities AS legacy_authority\n          WHERE legacy_authority.session_id=authority_session.id\n            AND legacy_authority.profile_id=authority_session.profile_id\n            AND legacy_authority.account_key IS NOT NULL\n            AND legacy_authority.account_key=lower(trim(authority_profile.provider_email))\n        ))\n      OR (authority_session.provider_v39='devin'\n        AND authority_profile.state IN ('signed_in','signed_out'))\n    )\n)\nBEGIN SELECT RAISE(ABORT,'WORK_MEMBER_AUTHORITY_MISMATCH'); END"
    },
    {
      "type": "trigger",
      "name": "work_member_limit_guard",
      "tbl_name": "work_members",
      "sql": "CREATE TRIGGER work_member_limit_guard\nBEFORE INSERT ON work_members\nWHEN (SELECT COUNT(*) FROM work_members WHERE work_id=NEW.work_id) >= 256\nBEGIN SELECT RAISE(ABORT,'WORK_MEMBER_LIMIT'); END"
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
      "type": "trigger",
      "name": "work_profile_attempt_authority_guard",
      "tbl_name": "profiles",
      "sql": "CREATE TRIGGER work_profile_attempt_authority_guard\nBEFORE UPDATE OF state,process_generation ON profiles\nWHEN EXISTS (\n  SELECT 1 FROM work_attempts AS a\n  JOIN sessions AS s ON s.id=a.worker_session_id\n  WHERE a.account_id=OLD.id\n    AND a.state IN ('claimed','dispatching','running')\n    AND (\n      NEW.process_generation!=a.account_generation\n      OR (NEW.state!='signed_in' AND s.provider_v39='codex')\n    )\n)\nBEGIN SELECT RAISE(ABORT,'WORK_PROFILE_ATTEMPT_AUTHORITY'); END"
    },
    {
      "type": "trigger",
      "name": "work_profile_attempt_identity_guard",
      "tbl_name": "profiles",
      "sql": "CREATE TRIGGER work_profile_attempt_identity_guard\nBEFORE UPDATE OF provider_email ON profiles\nWHEN lower(trim(NEW.provider_email)) IS NOT lower(trim(OLD.provider_email)) AND EXISTS (\n  SELECT 1 FROM work_attempts AS a\n  WHERE a.account_id=OLD.id\n    AND a.state IN ('claimed','dispatching','running')\n)\nBEGIN SELECT RAISE(ABORT,'WORK_PROFILE_ATTEMPT_AUTHORITY'); END"
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
      "type": "trigger",
      "name": "work_release_tombstones_no_update",
      "tbl_name": "work_release_tombstones",
      "sql": "CREATE TRIGGER work_release_tombstones_no_update\nBEFORE UPDATE ON work_release_tombstones\nBEGIN SELECT RAISE(ABORT,'WORK_RELEASE_TOMBSTONE_IMMUTABLE'); END"
    },
    {
      "type": "trigger",
      "name": "work_retained_limit_guard",
      "tbl_name": "works",
      "sql": "CREATE TRIGGER work_retained_limit_guard\nBEFORE INSERT ON works\nWHEN (SELECT COUNT(*) FROM works) >= 8192\nBEGIN SELECT RAISE(ABORT,'WORK_RETAINED_LIMIT'); END"
    },
    {
      "type": "trigger",
      "name": "work_review_account_authority_guard",
      "tbl_name": "work_reviews",
      "sql": "CREATE TRIGGER work_review_account_authority_guard\nBEFORE INSERT ON work_reviews\nWHEN NOT EXISTS (\n  SELECT 1\n  FROM sessions AS authority_session\n  JOIN profiles AS authority_profile ON authority_profile.id=authority_session.profile_id\n  LEFT JOIN session_provider_account_authorities AS provider_authority\n    ON provider_authority.session_id=authority_session.id\n      AND provider_authority.provider=authority_session.provider_v39\n  WHERE authority_session.id=NEW.reviewer_session_id\n    AND authority_session.state IN ('active','idle')\n    \n    AND NOT EXISTS (\n      SELECT 1 FROM provider_runtime_account_revocations AS authority_revocation\n      WHERE authority_revocation.profile_id=authority_session.profile_id\n        AND authority_revocation.profile_generation=authority_profile.process_generation\n        AND authority_revocation.provider=authority_session.provider_v39\n        AND authority_revocation.runtime_scope=provider_authority.runtime_scope\n        AND (\n          authority_revocation.state='releasing'\n          OR authority_revocation.current_account_key IS NULL\n          OR authority_revocation.current_account_key!=provider_authority.account_key\n        )\n    )\n    AND (\n      (provider_authority.runtime_scope='personal' AND EXISTS (\n        SELECT 1 FROM session_personal_runtime_bindings AS authority_binding\n        WHERE authority_binding.session_id=authority_session.id\n          AND authority_binding.provider=authority_session.provider_v39\n          AND authority_binding.provider_thread_id=authority_session.provider_thread_id\n          AND authority_binding.state='active'\n      ))\n      OR (provider_authority.runtime_scope='managed' AND NOT EXISTS (\n        SELECT 1 FROM session_personal_runtime_bindings AS authority_binding\n        WHERE authority_binding.session_id=authority_session.id\n          AND authority_binding.state IN ('active','detaching')\n      ))\n      OR (authority_session.provider_v39='devin' AND NOT EXISTS (\n        SELECT 1 FROM session_personal_runtime_bindings AS authority_binding\n        WHERE authority_binding.session_id=authority_session.id\n          AND authority_binding.state IN ('active','detaching')\n      ))\n    )\n    AND (\n      (authority_session.provider_v39='claude'\n        AND authority_profile.state IN ('signed_in','signed_out'))\n      OR (authority_session.provider_v39='codex'\n        AND authority_profile.state='signed_in'\n        AND authority_profile.provider_email IS NOT NULL\n        AND authority_profile.codex_account_key=provider_authority.account_key\n        AND EXISTS (\n          SELECT 1 FROM session_account_authorities AS legacy_authority\n          WHERE legacy_authority.session_id=authority_session.id\n            AND legacy_authority.profile_id=authority_session.profile_id\n            AND legacy_authority.account_key IS NOT NULL\n            AND legacy_authority.account_key=lower(trim(authority_profile.provider_email))\n        ))\n      OR (authority_session.provider_v39='devin'\n        AND authority_profile.state IN ('signed_in','signed_out'))\n    )\n)\nBEGIN SELECT RAISE(ABORT,'WORK_REVIEWER_AUTHORITY_MISMATCH'); END"
    },
    {
      "type": "trigger",
      "name": "work_review_member_guard",
      "tbl_name": "work_reviews",
      "sql": "CREATE TRIGGER work_review_member_guard\nBEFORE INSERT ON work_reviews\nWHEN NOT EXISTS (SELECT 1 FROM work_members WHERE work_id=NEW.work_id AND session_id=NEW.reviewer_session_id)\n  OR EXISTS (\n    SELECT 1 FROM work_submissions AS s\n    WHERE s.id=NEW.submission_id AND s.worker_session_id=NEW.reviewer_session_id\n  )\nBEGIN SELECT RAISE(ABORT,'WORK_REVIEWER_INVALID'); END"
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
      "sql": "CREATE TRIGGER work_session_attempt_authority_guard\nBEFORE UPDATE OF profile_id,project_id,provider_v39,preset,fast_enabled,preset_contract ON sessions\nWHEN EXISTS (\n  SELECT 1 FROM work_attempts AS a\n  JOIN works AS w ON w.id=a.work_id\n  WHERE a.worker_session_id=OLD.id\n    AND a.state IN ('claimed','dispatching','running','recovery_required')\n    AND (\n      NEW.profile_id!=a.account_id OR NEW.project_id!=a.project_id\n      OR NEW.provider_v39!='codex' OR NEW.preset!=a.preset OR NEW.fast_enabled!=a.fast\n      OR (\n        NEW.preset_contract!=w.preset_contract\n        AND a.preset!='low'\n      )\n    )\n)\nBEGIN SELECT RAISE(ABORT,'WORK_SESSION_ATTEMPT_AUTHORITY'); END"
    },
    {
      "type": "trigger",
      "name": "work_session_devin_contract_guard",
      "tbl_name": "sessions",
      "sql": "CREATE TRIGGER work_session_devin_contract_guard\nBEFORE UPDATE OF provider_v39,preset_contract ON sessions\nWHEN NEW.provider_v39='devin' AND (\n  NEW.preset_contract!=2\n  OR EXISTS (\n    SELECT 1 FROM works AS w\n    WHERE w.coordinator_session_id=OLD.id\n      AND w.preset_contract!=2\n  )\n)\nBEGIN SELECT RAISE(ABORT,'WORK_DEVIN_PRESET_CONTRACT_MISMATCH'); END"
    },
    {
      "type": "trigger",
      "name": "work_session_switch_attempt_authority_guard",
      "tbl_name": "mutation_attempts",
      "sql": "CREATE TRIGGER work_session_switch_attempt_authority_guard\nBEFORE UPDATE OF state ON mutation_attempts\nWHEN OLD.kind='session.switch'\n  AND OLD.state='prepared'\n  AND NEW.state='effect_started'\n  AND EXISTS (\n    SELECT 1 FROM work_attempts AS a\n    WHERE a.worker_session_id=OLD.authority_id\n      AND a.state IN ('claimed','dispatching','running','recovery_required')\n  )\nBEGIN SELECT RAISE(ABORT,'WORK_SESSION_SWITCH_ATTEMPT_AUTHORITY'); END"
    },
    {
      "type": "trigger",
      "name": "work_signal_account_authority_guard",
      "tbl_name": "work_signals",
      "sql": "CREATE TRIGGER work_signal_account_authority_guard\nBEFORE INSERT ON work_signals\nWHEN NOT EXISTS (\n  SELECT 1\n  FROM sessions AS authority_session\n  JOIN profiles AS authority_profile ON authority_profile.id=authority_session.profile_id\n  LEFT JOIN session_provider_account_authorities AS provider_authority\n    ON provider_authority.session_id=authority_session.id\n      AND provider_authority.provider=authority_session.provider_v39\n  WHERE authority_session.id=NEW.from_session_id\n    AND authority_session.state IN ('active','idle')\n    \n    AND NOT EXISTS (\n      SELECT 1 FROM provider_runtime_account_revocations AS authority_revocation\n      WHERE authority_revocation.profile_id=authority_session.profile_id\n        AND authority_revocation.profile_generation=authority_profile.process_generation\n        AND authority_revocation.provider=authority_session.provider_v39\n        AND authority_revocation.runtime_scope=provider_authority.runtime_scope\n        AND (\n          authority_revocation.state='releasing'\n          OR authority_revocation.current_account_key IS NULL\n          OR authority_revocation.current_account_key!=provider_authority.account_key\n        )\n    )\n    AND (\n      (provider_authority.runtime_scope='personal' AND EXISTS (\n        SELECT 1 FROM session_personal_runtime_bindings AS authority_binding\n        WHERE authority_binding.session_id=authority_session.id\n          AND authority_binding.provider=authority_session.provider_v39\n          AND authority_binding.provider_thread_id=authority_session.provider_thread_id\n          AND authority_binding.state='active'\n      ))\n      OR (provider_authority.runtime_scope='managed' AND NOT EXISTS (\n        SELECT 1 FROM session_personal_runtime_bindings AS authority_binding\n        WHERE authority_binding.session_id=authority_session.id\n          AND authority_binding.state IN ('active','detaching')\n      ))\n      OR (authority_session.provider_v39='devin' AND NOT EXISTS (\n        SELECT 1 FROM session_personal_runtime_bindings AS authority_binding\n        WHERE authority_binding.session_id=authority_session.id\n          AND authority_binding.state IN ('active','detaching')\n      ))\n    )\n    AND (\n      (authority_session.provider_v39='claude'\n        AND authority_profile.state IN ('signed_in','signed_out'))\n      OR (authority_session.provider_v39='codex'\n        AND authority_profile.state='signed_in'\n        AND authority_profile.provider_email IS NOT NULL\n        AND authority_profile.codex_account_key=provider_authority.account_key\n        AND EXISTS (\n          SELECT 1 FROM session_account_authorities AS legacy_authority\n          WHERE legacy_authority.session_id=authority_session.id\n            AND legacy_authority.profile_id=authority_session.profile_id\n            AND legacy_authority.account_key IS NOT NULL\n            AND legacy_authority.account_key=lower(trim(authority_profile.provider_email))\n        ))\n      OR (authority_session.provider_v39='devin'\n        AND authority_profile.state IN ('signed_in','signed_out'))\n    )\n)\nOR NOT EXISTS (\n  SELECT 1\n  FROM sessions AS authority_session\n  JOIN profiles AS authority_profile ON authority_profile.id=authority_session.profile_id\n  LEFT JOIN session_provider_account_authorities AS provider_authority\n    ON provider_authority.session_id=authority_session.id\n      AND provider_authority.provider=authority_session.provider_v39\n  WHERE authority_session.id=NEW.to_session_id\n    AND authority_session.state IN ('active','idle')\n    AND (authority_profile.process_generation=NEW.target_account_generation)\n    AND NOT EXISTS (\n      SELECT 1 FROM provider_runtime_account_revocations AS authority_revocation\n      WHERE authority_revocation.profile_id=authority_session.profile_id\n        AND authority_revocation.profile_generation=authority_profile.process_generation\n        AND authority_revocation.provider=authority_session.provider_v39\n        AND authority_revocation.runtime_scope=provider_authority.runtime_scope\n        AND (\n          authority_revocation.state='releasing'\n          OR authority_revocation.current_account_key IS NULL\n          OR authority_revocation.current_account_key!=provider_authority.account_key\n        )\n    )\n    AND (\n      (provider_authority.runtime_scope='personal' AND EXISTS (\n        SELECT 1 FROM session_personal_runtime_bindings AS authority_binding\n        WHERE authority_binding.session_id=authority_session.id\n          AND authority_binding.provider=authority_session.provider_v39\n          AND authority_binding.provider_thread_id=authority_session.provider_thread_id\n          AND authority_binding.state='active'\n      ))\n      OR (provider_authority.runtime_scope='managed' AND NOT EXISTS (\n        SELECT 1 FROM session_personal_runtime_bindings AS authority_binding\n        WHERE authority_binding.session_id=authority_session.id\n          AND authority_binding.state IN ('active','detaching')\n      ))\n      OR (authority_session.provider_v39='devin' AND NOT EXISTS (\n        SELECT 1 FROM session_personal_runtime_bindings AS authority_binding\n        WHERE authority_binding.session_id=authority_session.id\n          AND authority_binding.state IN ('active','detaching')\n      ))\n    )\n    AND (\n      (authority_session.provider_v39='claude'\n        AND authority_profile.state IN ('signed_in','signed_out'))\n      OR (authority_session.provider_v39='codex'\n        AND authority_profile.state='signed_in'\n        AND authority_profile.provider_email IS NOT NULL\n        AND authority_profile.codex_account_key=provider_authority.account_key\n        AND EXISTS (\n          SELECT 1 FROM session_account_authorities AS legacy_authority\n          WHERE legacy_authority.session_id=authority_session.id\n            AND legacy_authority.profile_id=authority_session.profile_id\n            AND legacy_authority.account_key IS NOT NULL\n            AND legacy_authority.account_key=lower(trim(authority_profile.provider_email))\n        ))\n      OR (authority_session.provider_v39='devin'\n        AND authority_profile.state IN ('signed_in','signed_out'))\n    )\n)\nBEGIN SELECT RAISE(ABORT,'WORK_SIGNAL_ACCOUNT_AUTHORITY_MISMATCH'); END"
    },
    {
      "type": "trigger",
      "name": "work_signal_ack_account_authority_guard",
      "tbl_name": "work_signal_receipts",
      "sql": "CREATE TRIGGER work_signal_ack_account_authority_guard\nBEFORE INSERT ON work_signal_receipts\nWHEN NEW.kind='ack' AND NOT EXISTS (\n  SELECT 1 FROM work_signals AS signal\n  WHERE signal.id=NEW.signal_id\n    AND signal.to_session_id=NEW.actor_session_id\n    AND EXISTS (\n  SELECT 1\n  FROM sessions AS authority_session\n  JOIN profiles AS authority_profile ON authority_profile.id=authority_session.profile_id\n  LEFT JOIN session_provider_account_authorities AS provider_authority\n    ON provider_authority.session_id=authority_session.id\n      AND provider_authority.provider=authority_session.provider_v39\n  WHERE authority_session.id=signal.to_session_id\n    AND authority_session.state IN ('active','idle')\n    AND (authority_profile.process_generation=signal.target_account_generation)\n    AND NOT EXISTS (\n      SELECT 1 FROM provider_runtime_account_revocations AS authority_revocation\n      WHERE authority_revocation.profile_id=authority_session.profile_id\n        AND authority_revocation.profile_generation=authority_profile.process_generation\n        AND authority_revocation.provider=authority_session.provider_v39\n        AND authority_revocation.runtime_scope=provider_authority.runtime_scope\n        AND (\n          authority_revocation.state='releasing'\n          OR authority_revocation.current_account_key IS NULL\n          OR authority_revocation.current_account_key!=provider_authority.account_key\n        )\n    )\n    AND (\n      (provider_authority.runtime_scope='personal' AND EXISTS (\n        SELECT 1 FROM session_personal_runtime_bindings AS authority_binding\n        WHERE authority_binding.session_id=authority_session.id\n          AND authority_binding.provider=authority_session.provider_v39\n          AND authority_binding.provider_thread_id=authority_session.provider_thread_id\n          AND authority_binding.state='active'\n      ))\n      OR (provider_authority.runtime_scope='managed' AND NOT EXISTS (\n        SELECT 1 FROM session_personal_runtime_bindings AS authority_binding\n        WHERE authority_binding.session_id=authority_session.id\n          AND authority_binding.state IN ('active','detaching')\n      ))\n      OR (authority_session.provider_v39='devin' AND NOT EXISTS (\n        SELECT 1 FROM session_personal_runtime_bindings AS authority_binding\n        WHERE authority_binding.session_id=authority_session.id\n          AND authority_binding.state IN ('active','detaching')\n      ))\n    )\n    AND (\n      (authority_session.provider_v39='claude'\n        AND authority_profile.state IN ('signed_in','signed_out'))\n      OR (authority_session.provider_v39='codex'\n        AND authority_profile.state='signed_in'\n        AND authority_profile.provider_email IS NOT NULL\n        AND authority_profile.codex_account_key=provider_authority.account_key\n        AND EXISTS (\n          SELECT 1 FROM session_account_authorities AS legacy_authority\n          WHERE legacy_authority.session_id=authority_session.id\n            AND legacy_authority.profile_id=authority_session.profile_id\n            AND legacy_authority.account_key IS NOT NULL\n            AND legacy_authority.account_key=lower(trim(authority_profile.provider_email))\n        ))\n      OR (authority_session.provider_v39='devin'\n        AND authority_profile.state IN ('signed_in','signed_out'))\n    )\n)\n)\nBEGIN SELECT RAISE(ABORT,'WORK_SIGNAL_ACK_ACCOUNT_AUTHORITY_MISMATCH'); END"
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
      "sql": "CREATE TRIGGER work_signal_member_guard\nBEFORE INSERT ON work_signals\nWHEN NOT EXISTS (SELECT 1 FROM work_members WHERE work_id=NEW.work_id AND session_id=NEW.from_session_id)\n  OR NOT EXISTS (SELECT 1 FROM work_members WHERE work_id=NEW.work_id AND session_id=NEW.to_session_id)\n  OR NOT EXISTS (\n    SELECT 1 FROM sessions AS s JOIN profiles AS p ON p.id=s.profile_id\n    WHERE s.id=NEW.to_session_id\n      AND p.process_generation=NEW.target_account_generation\n  )\nBEGIN SELECT RAISE(ABORT,'WORK_SIGNAL_MEMBER_INVALID'); END"
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
      "type": "trigger",
      "name": "work_task_history_versions_capacity",
      "tbl_name": "work_task_history_versions",
      "sql": "CREATE TRIGGER work_task_history_versions_capacity\nBEFORE INSERT ON work_task_history_versions\nWHEN (SELECT COUNT(*) FROM work_task_history_versions WHERE work_id=NEW.work_id)\n  >= 196864\nBEGIN SELECT RAISE(ABORT,'WORK_TASK_HISTORY_VERSION_LIMIT'); END"
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
      "type": "trigger",
      "name": "works_identity_immutable",
      "tbl_name": "works",
      "sql": "CREATE TRIGGER works_identity_immutable\nBEFORE UPDATE OF id,client_ref,coordinator_session_id,objective,preset_contract,stream_epoch,created_at ON works\nBEGIN SELECT RAISE(ABORT,'WORK_IMMUTABLE'); END"
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
  "queueColumns": [
    {
      "cid": 0,
      "name": "id",
      "type": "TEXT",
      "notnull": 1,
      "dflt_value": null,
      "pk": 1
    },
    {
      "cid": 1,
      "name": "session_id",
      "type": "TEXT",
      "notnull": 1,
      "dflt_value": null,
      "pk": 0
    },
    {
      "cid": 2,
      "name": "message",
      "type": "TEXT",
      "notnull": 1,
      "dflt_value": null,
      "pk": 0
    },
    {
      "cid": 3,
      "name": "state",
      "type": "TEXT",
      "notnull": 1,
      "dflt_value": null,
      "pk": 0
    },
    {
      "cid": 4,
      "name": "created_at",
      "type": "INTEGER",
      "notnull": 1,
      "dflt_value": null,
      "pk": 0
    },
    {
      "cid": 5,
      "name": "updated_at",
      "type": "INTEGER",
      "notnull": 1,
      "dflt_value": null,
      "pk": 0
    },
    {
      "cid": 6,
      "name": "enqueue_sequence",
      "type": "INTEGER",
      "notnull": 0,
      "dflt_value": null,
      "pk": 0
    },
    {
      "cid": 7,
      "name": "message_actor",
      "type": "TEXT",
      "notnull": 1,
      "dflt_value": "'human'",
      "pk": 0
    },
    {
      "cid": 8,
      "name": "peer_action_id",
      "type": "TEXT",
      "notnull": 0,
      "dflt_value": null,
      "pk": 0
    }
  ],
  "timestampGuard": {
    "type": "trigger",
    "name": "mutation_resolutions_timestamp_proof_insert",
    "tbl_name": "mutation_resolutions",
    "sql": "CREATE TRIGGER mutation_resolutions_timestamp_proof_insert\nBEFORE INSERT ON mutation_resolutions\nWHEN (SELECT kind FROM mutation_attempts WHERE id=NEW.attempt_id) IN ('session.stop','session.rename')\nBEGIN\n  SELECT CASE WHEN NEW.resolution_kind<>'proven_applied' AND NEW.receipt_json IS NOT NULL\n    THEN RAISE(ABORT,'MUTATION_RECOVERY_TIMESTAMP_RECEIPT_UNEXPECTED') END;\n  SELECT CASE WHEN NEW.resolution_kind='proven_applied' AND (\n    NOT json_valid(NEW.evidence_json) OR NEW.receipt_json IS NULL OR NOT json_valid(NEW.receipt_json)\n  ) THEN RAISE(ABORT,'MUTATION_RECOVERY_TIMESTAMP_PROOF_INVALID') END;\n  SELECT CASE WHEN NEW.resolution_kind='proven_applied' AND NOT EXISTS (\n    SELECT 1 FROM mutation_attempts m\n    JOIN mutation_effect_evidence e ON e.attempt_id=m.id\n    JOIN sessions s ON s.id=m.authority_id\n    WHERE m.id=NEW.attempt_id AND e.kind=m.kind\n      AND json_extract(e.evidence_json,'$.kind')=m.kind\n      AND json_extract(NEW.evidence_json,'$.kind')=m.kind\n      AND json_extract(e.evidence_json,'$.providerThreadId')=s.provider_thread_id\n      AND json_extract(NEW.evidence_json,'$.providerThreadId')=s.provider_thread_id\n      AND json_extract(e.evidence_json,'$.providerTimestampUnit')='unix_milliseconds_v1'\n      AND json_extract(NEW.evidence_json,'$.providerTimestampUnit')='unix_milliseconds_v1'\n      AND json_type(e.evidence_json,'$.baseline.providerUpdatedAt')='integer'\n      AND json_extract(e.evidence_json,'$.baseline.providerUpdatedAt') BETWEEN 0 AND 9007199254740991\n      AND json_type(NEW.evidence_json,'$.providerUpdatedAt')='integer'\n      AND json_extract(NEW.evidence_json,'$.providerUpdatedAt') BETWEEN 0 AND 9007199254740991\n      AND json_extract(NEW.evidence_json,'$.providerUpdatedAt')>json_extract(e.evidence_json,'$.baseline.providerUpdatedAt')\n      AND s.provider_updated_at=json_extract(NEW.evidence_json,'$.providerUpdatedAt')\n      AND (\n        (m.kind='session.stop'\n          AND s.active_turn_id IS NOT json_extract(e.evidence_json,'$.activeTurnId')\n          AND (SELECT count(*) FROM json_each(NEW.evidence_json))=6\n          AND (SELECT count(*) FROM json_each(NEW.receipt_json))=2\n          AND json_type(e.evidence_json,'$.activeTurnId')='text'\n          AND json_extract(NEW.evidence_json,'$.activeTurnId')=json_extract(e.evidence_json,'$.activeTurnId')\n          AND json_extract(NEW.receipt_json,'$.activeTurnId')=json_extract(e.evidence_json,'$.activeTurnId')\n          AND json_extract(NEW.evidence_json,'$.observedStatus') IN ('absent','completed','interrupted','failed')\n          AND json_type(NEW.receipt_json,'$.stopped')='true')\n        OR (m.kind='session.rename'\n          AND s.title=json_extract(e.evidence_json,'$.requestedName')\n          AND (SELECT count(*) FROM json_each(NEW.evidence_json))=5\n          AND (SELECT count(*) FROM json_each(NEW.receipt_json))=1\n          AND json_extract(NEW.evidence_json,'$.requestedName')=json_extract(e.evidence_json,'$.requestedName')\n          AND json_type(NEW.receipt_json,'$.renamed')='true')\n      )\n  ) THEN RAISE(ABORT,'MUTATION_RECOVERY_TIMESTAMP_PROOF_INVALID') END;\nEND"
  },
  "rows": {
    "account_rate_limit_reset_attempts": [],
    "account_rate_limit_reset_policies": [
      {
        "profile_id": "acct_25f92394d7cb4b9dbf4ca226fe5a6a13",
        "state": "active_unbound",
        "account_fingerprint": null,
        "weekly_window_resets_at": null,
        "revision": 1,
        "created_at": 43001,
        "updated_at": 43001
      }
    ],
    "account_rate_limit_reset_rebinds": [],
    "attachments": [],
    "attention_email_policy": [
      {
        "singleton": 1,
        "version": 1,
        "enabled": 0,
        "revision": 1,
        "created_at": 43001,
        "updated_at": 43001
      }
    ],
    "autorespond_evidence": [],
    "autorespond_message_sources": [],
    "daemon_state": [
      {
        "singleton": 1,
        "generation": 0,
        "boot_id": null,
        "started_at": null,
        "stopped_at": null,
        "default_approval_mode": "auto:all",
        "default_show_thinking": 0,
        "default_preset": "ultra",
        "device_commands_allowed": 1,
        "account_linking_allowed": 0
      }
    ],
    "desktop_switch_authority": [
      {
        "singleton": 1,
        "current_generation": 0,
        "current_attempt_id": null,
        "released_generation": 0
      }
    ],
    "desktop_switch_resolutions": [],
    "desktop_switches": [],
    "device_command_ledger": [],
    "memory_page_attestation_refs": [],
    "memory_page_attestations": [],
    "memory_submissions": [
      {
        "id": "memsub_1a271b7838884a44b51af88d53f4251e",
        "idempotency_key": "43000000-0000-4000-8000-000000000003",
        "kind": "remember",
        "actor_session_id": "sess_c75960fd187747a3b0d29db10be8bb03",
        "project_id": "proj_c64eeebae2c64591b4d21da199c64df7",
        "request_digest": "718304a7c93f6f2a4dcf9778089690ce39f35a1df3df185c0b99cdf0ca90b175",
        "content_digest": "50719295ff0afbe96ff6e93953b4586474634118dea47940382517cd6e05068f",
        "key_digest": "35456d7c1109923562200613ea0fd5491d7eb0799fd1979652323da4d3b47283",
        "working_binding_digest": "5097f9fdbbeb6082d9c26c25b8314fedaf0213e8b9e80315e60894b3254ea3a9",
        "working_epoch": 1,
        "effect_record_sha256": null,
        "attestation_sha256": null,
        "operation_id": null,
        "source_head_sequence": null,
        "source_head_operation_sha256": null,
        "source_head_digest": null,
        "nomination_sha256": null,
        "expected_head_sequence": 0,
        "expected_head_operation_sha256": null,
        "expected_head_digest": "1c90ceacb79d163e060443b4db9a02561059971c063558963df0794ecfbbde85",
        "result_head_sequence": null,
        "result_head_operation_sha256": null,
        "result_head_digest": null,
        "receipt_digest": null,
        "outcome_code": null,
        "conflict_actual_head_sequence": null,
        "conflict_actual_head_operation_sha256": null,
        "conflict_actual_head_digest": null,
        "conflict_canonical_record_sha256": null,
        "conflict_nominated_record_sha256": null,
        "state": "prepared",
        "created_at": 43001,
        "updated_at": 43001
      }
    ],
    "memory_working_attestation_forks": [],
    "memory_working_attestation_heads": [],
    "message_attachments": [],
    "migrations": [
      {
        "version": 1,
        "applied_at": 43001
      },
      {
        "version": 10,
        "applied_at": 43001
      },
      {
        "version": 11,
        "applied_at": 43001
      },
      {
        "version": 12,
        "applied_at": 43001
      },
      {
        "version": 13,
        "applied_at": 43001
      },
      {
        "version": 14,
        "applied_at": 43001
      },
      {
        "version": 15,
        "applied_at": 43001
      },
      {
        "version": 16,
        "applied_at": 43001
      },
      {
        "version": 17,
        "applied_at": 43001
      },
      {
        "version": 18,
        "applied_at": 43001
      },
      {
        "version": 19,
        "applied_at": 43001
      },
      {
        "version": 2,
        "applied_at": 43001
      },
      {
        "version": 20,
        "applied_at": 43001
      },
      {
        "version": 21,
        "applied_at": 43001
      },
      {
        "version": 22,
        "applied_at": 43001
      },
      {
        "version": 23,
        "applied_at": 43001
      },
      {
        "version": 24,
        "applied_at": 43001
      },
      {
        "version": 25,
        "applied_at": 43001
      },
      {
        "version": 26,
        "applied_at": 43001
      },
      {
        "version": 27,
        "applied_at": 43001
      },
      {
        "version": 28,
        "applied_at": 43001
      },
      {
        "version": 29,
        "applied_at": 43001
      },
      {
        "version": 3,
        "applied_at": 43001
      },
      {
        "version": 30,
        "applied_at": 43001
      },
      {
        "version": 31,
        "applied_at": 43001
      },
      {
        "version": 32,
        "applied_at": 43001
      },
      {
        "version": 33,
        "applied_at": 43001
      },
      {
        "version": 34,
        "applied_at": 43001
      },
      {
        "version": 35,
        "applied_at": 43001
      },
      {
        "version": 36,
        "applied_at": 43001
      },
      {
        "version": 37,
        "applied_at": 43001
      },
      {
        "version": 38,
        "applied_at": 43001
      },
      {
        "version": 39,
        "applied_at": 43001
      },
      {
        "version": 4,
        "applied_at": 43001
      },
      {
        "version": 40,
        "applied_at": 43001
      },
      {
        "version": 41,
        "applied_at": 43001
      },
      {
        "version": 42,
        "applied_at": 43001
      },
      {
        "version": 43,
        "applied_at": 43001
      },
      {
        "version": 5,
        "applied_at": 43001
      },
      {
        "version": 6,
        "applied_at": 43001
      },
      {
        "version": 7,
        "applied_at": 43001
      },
      {
        "version": 8,
        "applied_at": 43001
      },
      {
        "version": 9,
        "applied_at": 43001
      }
    ],
    "mutation_attempts": [
      {
        "id": "attempt_3a5ff84d1a864a69b5c667f82cf1f8d5",
        "idempotency_key": "43000000-0000-4000-8000-000000000001",
        "kind": "session.queue",
        "authority_id": "sess_c75960fd187747a3b0d29db10be8bb03",
        "authority_generation": 1,
        "request_digest": "43ba14a90d894ab1095a59f54bb9b8bc0bef635f0f85afe31556feb72005ee21",
        "state": "applied",
        "result_json": "{\"queueId\":\"queue_e5e7519d62124714ba02c733698bb5e8\"}",
        "created_at": 43001,
        "updated_at": 43001
      },
      {
        "id": "attempt_9ad78dfebbbf4f6ea63669e39e70b317",
        "idempotency_key": "43000000-0000-4000-8000-000000000002",
        "kind": "session.queue",
        "authority_id": "sess_c75960fd187747a3b0d29db10be8bb03",
        "authority_generation": 1,
        "request_digest": "6648634c04486614930419d545feaae690e117000a9f9fc6527f71fba7383ad9",
        "state": "applied",
        "result_json": "{\"queueId\":\"queue_871a5458b39c45bb9b6ed199a5fa1d68\"}",
        "created_at": 43001,
        "updated_at": 43001
      }
    ],
    "mutation_effect_evidence": [],
    "mutation_resolutions": [],
    "notification_hours": [
      {
        "singleton": 1,
        "version": 1,
        "revision": 1,
        "start_minute": 600,
        "end_minute": 1320,
        "time_zone": "UTC",
        "created_at": 43001,
        "updated_at": 43001
      }
    ],
    "peer_session_action_parents": [],
    "peer_session_action_roots": [],
    "peer_session_action_visits": [],
    "peer_session_actions": [],
    "peer_session_direct_message_sources": [],
    "peer_session_turn_origins": [],
    "profile_personal_authority_revocations": [],
    "profiles": [
      {
        "id": "acct_25f92394d7cb4b9dbf4ca226fe5a6a13",
        "label": "Canonical43 synthetic account",
        "state": "signed_in",
        "process_generation": 1,
        "provider_email": "canonical43@example.com",
        "provider_plan": "Plus",
        "created_at": 43001,
        "updated_at": 43001,
        "codex_account_key": "v1:codex:478f8e0f05928cfc8bbef47f80bf42a83c57efa7588082e9bd437ae58df01e24",
        "label_key": "canonical43 synthetic account"
      }
    ],
    "project_approval_modes": [],
    "project_memory_authorities": [
      {
        "project_id": "proj_c64eeebae2c64591b4d21da199c64df7",
        "identity_contract": 2,
        "canonical_space_id": "oompa:project:space-7afe83fff41ec7a2a2ed9e5973567c7d",
        "physical_state": "reserved",
        "initialized_at": null,
        "authority_digest": "e4ce8b512a8e562945b59326ce5499221554f1b5b7d25be74aaeab41c684f602",
        "binding_digest": "6342d6d347ba999feedc4e2dbf1c8d76da63d1a18539a34712db19834b3de266",
        "head_sequence": 0,
        "head_operation_sha256": null,
        "head_digest": "1c90ceacb79d163e060443b4db9a02561059971c063558963df0794ecfbbde85",
        "revision": 1,
        "sync_state": "local_only",
        "last_exchange_at": null,
        "last_exchange_sequence": null,
        "last_exchange_operation_sha256": null,
        "last_exchange_head_digest": null,
        "diagnostic_code": null,
        "created_at": 43001,
        "updated_at": 43001
      }
    ],
    "project_memory_hosted_attachments": [],
    "project_memory_hosted_create_intents": [
      {
        "id": "cmcreate_e6f54633b6084c0eb239f896b708e32b",
        "idempotency_key": "43000000-0000-4000-8000-000000000004",
        "project_id": "proj_c64eeebae2c64591b4d21da199c64df7",
        "state": "allocating",
        "authority_revision": 1,
        "canonical_binding_digest": "6342d6d347ba999feedc4e2dbf1c8d76da63d1a18539a34712db19834b3de266",
        "authority_head_sequence": 0,
        "authority_head_operation_sha256": null,
        "authority_head_digest": "1c90ceacb79d163e060443b4db9a02561059971c063558963df0794ecfbbde85",
        "account_binding_digest": "482c02089cbec50bc11361cebf192ec728e5f8fc1534d27bace35dd333a7fa77",
        "remote_space_id": "memory_44444444444444444444444444444444",
        "space_key_version": null,
        "wrapped_key_algorithm": null,
        "wrapped_key_ciphertext": null,
        "wrapped_key_version": null,
        "wrapped_key_nonce": null,
        "descriptor_algorithm": null,
        "descriptor_ciphertext": null,
        "descriptor_key_version": null,
        "descriptor_nonce": null,
        "genesis_proof_algorithm": null,
        "genesis_proof_ciphertext": null,
        "genesis_proof_key_version": null,
        "genesis_proof_nonce": null,
        "genesis_token": null,
        "request_digest": null,
        "effect_started_at": null,
        "winner_digest": null,
        "winner_revision": null,
        "winner_replay": null,
        "winner_observed_at": null,
        "settled_at": null,
        "diagnostic_code": null,
        "created_at": 43001,
        "updated_at": 43001
      }
    ],
    "project_memory_portable_adoption_proofs": [],
    "project_memory_sync_intents": [],
    "project_memory_sync_spool": [],
    "projects": [
      {
        "id": "proj_c64eeebae2c64591b4d21da199c64df7",
        "label": "Canonical43 fixture project",
        "root_path": "/private/tmp/oompa-public-canonical43-fixture/project",
        "is_default": 1,
        "created_at": 43001,
        "updated_at": 43001,
        "label_key": "canonical43 fixture project"
      }
    ],
    "provider_interaction_transitions": [],
    "provider_interactions": [],
    "provider_login_authorities": [],
    "provider_runtime_account_revocations": [],
    "queue_effect_evidence": [],
    "queue_effect_resolutions": [],
    "queue_entries": [
      {
        "id": "queue_871a5458b39c45bb9b6ed199a5fa1d68",
        "session_id": "sess_c75960fd187747a3b0d29db10be8bb03",
        "message": "Canonical43 human queue second entry.",
        "state": "pending",
        "created_at": 43001,
        "updated_at": 43001,
        "enqueue_sequence": 2,
        "message_actor": "human",
        "peer_action_id": null
      },
      {
        "id": "queue_e5e7519d62124714ba02c733698bb5e8",
        "session_id": "sess_c75960fd187747a3b0d29db10be8bb03",
        "message": "Canonical43 human queue first entry.",
        "state": "pending",
        "created_at": 43001,
        "updated_at": 43001,
        "enqueue_sequence": 1,
        "message_actor": "human",
        "peer_action_id": null
      }
    ],
    "queue_message_scrub_authority": [],
    "queue_sequence_authority": [
      {
        "singleton": 1,
        "next_sequence": 3
      }
    ],
    "security_scrub_authority": [],
    "session_account_authorities": [
      {
        "session_id": "sess_1713c5abe1f6488186498f3645d5cc6a",
        "profile_id": "acct_25f92394d7cb4b9dbf4ca226fe5a6a13",
        "account_key": "canonical43@example.com",
        "recorded_at": 43001
      },
      {
        "session_id": "sess_c75960fd187747a3b0d29db10be8bb03",
        "profile_id": "acct_25f92394d7cb4b9dbf4ca226fe5a6a13",
        "account_key": "canonical43@example.com",
        "recorded_at": 43001
      }
    ],
    "session_adoption_candidates": [],
    "session_adoption_policies": [],
    "session_adoption_profile_generation_permits": [],
    "session_approval_modes": [],
    "session_autorespond_counters": [],
    "session_claude_process_authorities": [],
    "session_claude_process_launch_intents": [],
    "session_conversation_automation": [],
    "session_event_streams": [
      {
        "session_id": "sess_1713c5abe1f6488186498f3645d5cc6a",
        "stream_epoch": "175898e0-af55-40c8-86b9-8116c8d968d7",
        "next_sequence": 1,
        "floor_sequence": 1,
        "observed_through_sequence": 0,
        "retained_count": 0,
        "retained_bytes": 0,
        "retention_gap_reason": null,
        "created_at": 43001,
        "updated_at": 43001
      },
      {
        "session_id": "sess_c75960fd187747a3b0d29db10be8bb03",
        "stream_epoch": "bf827b34-23b3-41db-a462-5051adf31b6d",
        "next_sequence": 1,
        "floor_sequence": 1,
        "observed_through_sequence": 0,
        "retained_count": 0,
        "retained_bytes": 0,
        "retention_gap_reason": null,
        "created_at": 43001,
        "updated_at": 43001
      }
    ],
    "session_events": [],
    "session_host_capability_bindings": [
      {
        "session_id": "sess_c75960fd187747a3b0d29db10be8bb03",
        "preamble_version": 1,
        "preamble_digest": "efe177c5b62ecee67995575764969e581f91c2f7946241bb87e798ed5dac7eb1",
        "manifest_version": 1,
        "manifest_digest": "b6bf9f205581dad2ed692081d3834f362c4573cd4a13d102abb96ac21e6e1b63",
        "recorded_at": 43001
      }
    ],
    "session_message_event_sources": [],
    "session_mutation_authority_rebinds": [],
    "session_mutation_authority_rebinds_v39": [],
    "session_peer_policies": [
      {
        "session_id": "sess_1713c5abe1f6488186498f3645d5cc6a",
        "mode": "off",
        "revision": 2,
        "created_at": 43001,
        "updated_at": 43001
      },
      {
        "session_id": "sess_c75960fd187747a3b0d29db10be8bb03",
        "mode": "inspect",
        "revision": 2,
        "created_at": 43001,
        "updated_at": 43001
      }
    ],
    "session_personal_runtime_bindings": [],
    "session_provider_account_authorities": [
      {
        "session_id": "sess_1713c5abe1f6488186498f3645d5cc6a",
        "provider": "codex",
        "runtime_scope": "managed",
        "account_key": "v1:codex:478f8e0f05928cfc8bbef47f80bf42a83c57efa7588082e9bd437ae58df01e24",
        "recorded_at": 43001
      },
      {
        "session_id": "sess_c75960fd187747a3b0d29db10be8bb03",
        "provider": "codex",
        "runtime_scope": "managed",
        "account_key": "v1:codex:478f8e0f05928cfc8bbef47f80bf42a83c57efa7588082e9bd437ae58df01e24",
        "recorded_at": 43001
      }
    ],
    "session_provider_switch_seed_intents": [],
    "session_provider_switch_seed_results": [],
    "session_provider_switch_source_releases": [],
    "session_provider_switch_target_releases": [],
    "session_provider_switch_targets": [],
    "session_runtime_profiles": [],
    "session_show_thinking": [],
    "session_start_attempts": [],
    "session_states": [],
    "session_task_occurrences": [],
    "session_task_receipts": [],
    "session_tasks": [],
    "session_turn_runtime_profiles": [],
    "sessions": [
      {
        "id": "sess_1713c5abe1f6488186498f3645d5cc6a",
        "profile_id": "acct_25f92394d7cb4b9dbf4ca226fe5a6a13",
        "project_id": "proj_c64eeebae2c64591b4d21da199c64df7",
        "provider_thread_id": "canonical43-synthetic-peer",
        "title": "Canonical43 peer",
        "note": "",
        "provider": "codex",
        "preset": "high",
        "preset_contract": 2,
        "fast_enabled": 0,
        "state": "idle",
        "active_turn_id": null,
        "revision": 2,
        "created_at": 43001,
        "updated_at": 43001,
        "provider_updated_at": 43001,
        "provider_v39": "codex",
        "archived_at": null
      },
      {
        "id": "sess_c75960fd187747a3b0d29db10be8bb03",
        "profile_id": "acct_25f92394d7cb4b9dbf4ca226fe5a6a13",
        "project_id": "proj_c64eeebae2c64591b4d21da199c64df7",
        "provider_thread_id": "canonical43-synthetic-primary",
        "title": "Canonical43 primary",
        "note": "",
        "provider": "codex",
        "preset": "high",
        "preset_contract": 2,
        "fast_enabled": 0,
        "state": "idle",
        "active_turn_id": null,
        "revision": 2,
        "created_at": 43001,
        "updated_at": 43001,
        "provider_updated_at": 43001,
        "provider_v39": "codex",
        "archived_at": null
      }
    ],
    "sqlite_sequence": [
      {
        "name": "autorespond_evidence",
        "seq": 0
      }
    ],
    "turn_summaries": [],
    "usage_cloud_upload_anchors": [],
    "usage_poll_failures": [],
    "usage_revision_authority": [
      {
        "profile_id": "acct_25f92394d7cb4b9dbf4ca226fe5a6a13",
        "next_revision": 2
      }
    ],
    "usage_snapshots": [],
    "work_attempt_reports": [],
    "work_attempts": [],
    "work_clock": [
      {
        "singleton": 1,
        "logical_time": 0
      }
    ],
    "work_effect_resolutions": [],
    "work_events": [],
    "work_idempotency_intents": [],
    "work_members": [],
    "work_nested_effect_settlements": [],
    "work_prepared_effects": [],
    "work_purge_authority": [],
    "work_release_tombstones": [],
    "work_reviews": [],
    "work_routes": [],
    "work_signal_receipts": [],
    "work_signals": [],
    "work_submissions": [],
    "work_task_dependencies": [],
    "work_task_history_index": [],
    "work_task_history_versions": [],
    "work_task_states": [],
    "work_tasks": [],
    "work_terminal_requests": [],
    "works": []
  },
  "inspectionChanges": {
    "count": 0
  },
  "foreignKeyCheck": [],
  "regenerationInputs": {
    "originalGeneratorFilename": "generate-canonical43.ts",
    "originalGeneratorSha256": "8f87f678feb2ce27de26029d5475fa5935c7f131e4dd87f0d25cce7a7a7ee8da",
    "originalGeneratorSource": "import { Database } from \"bun:sqlite\";\nimport { createHash } from \"node:crypto\";\nimport { mkdir, readFile, writeFile } from \"node:fs/promises\";\nimport { gzipSync } from \"node:zlib\";\n\nconst sourceRevision = \"eaf0448e19383ac899c30d0a9cd70bbea71ff8b3\";\nconst sourceTree = \"5ce8a9dd0c21fe47d5724b4fc4760380aaaf6100\";\nconst expectedStateStoreSha256 = \"7f8b283b5f8dcae738aa74d94f9466631f86350b06aa58ecb2790482890bb553\";\nconst sha256 = (value: string | Uint8Array) => createHash(\"sha256\").update(value).digest(\"hex\");\nconst dependencies = {\n  \"@hraness/oh\": \"0.4.1\",\n  \"@openai/codex\": \"0.153.2\",\n  convex: \"1.45.0\",\n  effect: \"3.22.1\",\n  zod: \"4.4.3\",\n};\nfor (const [name, expected] of Object.entries(dependencies)) {\n  const installed = JSON.parse(await readFile(`${import.meta.dir}/node_modules/${name}/package.json`, \"utf8\"));\n  if (installed.name !== name || installed.version !== expected) {\n    throw new Error(`ARCHIVED_DEPENDENCY_MISMATCH:${name}`);\n  }\n}\nconst stateStoreSource = await readFile(`${import.meta.dir}/src/storage/state-store.ts`, \"utf8\");\nif (sha256(stateStoreSource) !== expectedStateStoreSha256) throw new Error(\"ARCHIVED_STATE_STORE_SOURCE_MISMATCH\");\nconst { StateStore } = await import(\"./src/storage/state-store\");\nconst { initializeStatePaths, resolveStatePaths } = await import(\"./src/storage/paths\");\nconst { createFactsMemoryBinding } = await import(\"./src/domain/facts-memory\");\nconst { createPortableProjectMemoryCanonicalIdentity, PROJECT_MEMORY_EMPTY_HEAD } = await import(\"./src/domain/project-memory\");\nconst paths = resolveStatePaths({ homeDirectory: `${import.meta.dir}/fixture-home`, platform: \"darwin\" });\nawait initializeStatePaths(paths);\nconst now = 43_001;\nconst store = new StateStore(paths, { now: () => now });\nconst inspect = new Database(paths.database, { readonly: true, strict: true });\nconst initialVersion = inspect.query(\"PRAGMA user_version\").get() as { user_version: number };\ninspect.close();\nif (initialVersion.user_version !== 43) throw new Error(\"ARCHIVED_SCHEMA_NOT_43\");\n\nconst projectRoot = `${import.meta.dir}/fixture-project`;\nawait mkdir(projectRoot, { mode: 0o700 });\nconst project = await store.createProject(\"Canonical43 fixture project\", projectRoot, true);\nconst profile = store.nextProfileGeneration(store.createProfile(\"Canonical43 synthetic account\").id);\nconst email = \"canonical43@example.com\";\nif (!store.setProfileState(profile.id, profile.processGeneration, \"signed_in\", { email, plan: \"Plus\" })) {\n  throw new Error(\"ARCHIVED_PROFILE_SETUP_FAILED\");\n}\nconst accountKey = `v1:codex:${sha256(email)}`;\nconst sessions = [\"primary\", \"peer\"].map((label) => {\n  const created = store.createSession({\n    profileId: profile.id, projectId: project.id, title: `Canonical43 ${label}`,\n    provider: \"codex\", preset: \"high\", fastEnabled: false,\n  });\n  store.bindSessionProviderAccountAuthority({\n    sessionId: created.id, provider: \"codex\", runtimeScope: \"managed\", accountKey,\n  });\n  return store.bindSession({\n    sessionId: created.id, expectedRevision: created.revision,\n    providerThreadId: `canonical43-synthetic-${label}`, state: \"idle\", providerUpdatedAt: now,\n  });\n});\nconst primary = sessions[0];\nconst peer = sessions[1];\nif (primary === undefined || peer === undefined) throw new Error(\"ARCHIVED_SESSIONS_MISSING\");\nconst policies = [\n  store.setPeerSessionPolicy({ sessionId: primary.id, expectedRevision: 1, mode: \"inspect\" }),\n  store.setPeerSessionPolicy({ sessionId: peer.id, expectedRevision: 1, mode: \"off\" }),\n];\nconst hostCapabilities = store.bindSessionHostCapabilities({\n  sessionId: primary.id, preambleVersion: 1, preambleDigest: sha256(\"Canonical43 synthetic host preamble\"),\n  manifestVersion: 1, manifestDigest: sha256(\"Canonical43 synthetic host capability manifest\"),\n});\nconst queue = [\n  store.enqueueIdempotent({\n    sessionId: primary.id, profileGeneration: profile.processGeneration,\n    message: \"Canonical43 human queue first entry.\", idempotencyKey: \"43000000-0000-4000-8000-000000000001\",\n  }),\n  store.enqueueIdempotent({\n    sessionId: primary.id, profileGeneration: profile.processGeneration,\n    message: \"Canonical43 human queue second entry.\", idempotencyKey: \"43000000-0000-4000-8000-000000000002\",\n  }),\n];\nconst canonicalIdentity = createPortableProjectMemoryCanonicalIdentity(project.id);\nconst memoryAuthority = store.reserveProjectMemoryAuthority({\n  projectId: project.id, identityContract: canonicalIdentity.identityContract,\n  canonicalSpaceId: canonicalIdentity.canonicalSpaceId, head: PROJECT_MEMORY_EMPTY_HEAD,\n});\nconst workingBinding = createFactsMemoryBinding({ ownerId: profile.id, sessionId: primary.id });\n// These are unexecuted requests only. No physical Oh store or memory receipt exists.\nconst localRequest = { kind: \"remember\", key: \"fixture:pending\", content: \"Synthetic pending local memory request.\" };\nconst memorySubmission = store.prepareMemorySubmission({\n  actorSessionId: primary.id, projectId: project.id, kind: \"remember\",\n  requestDigest: sha256(JSON.stringify(localRequest)), contentDigest: sha256(localRequest.content),\n  keyDigest: sha256(localRequest.key), workingBindingDigest: workingBinding.bindingDigest,\n  workingEpoch: workingBinding.epoch, expectedHead: PROJECT_MEMORY_EMPTY_HEAD,\n  idempotencyKey: \"43000000-0000-4000-8000-000000000003\",\n}).record;\n// Allocation is durable intent, not proof that the synthetic remote space exists.\nconst hostedCreate = store.allocateCanonicalMemoryHostedCreate({\n  accountBindingDigest: sha256(\"Canonical43 synthetic hosted account binding\"),\n  idempotencyKey: \"43000000-0000-4000-8000-000000000004\",\n  projectId: project.id, remoteSpaceId: `memory_${\"4\".repeat(32)}`,\n}).record;\nif (memoryAuthority.physicalState !== \"reserved\" || memoryAuthority.initializedAt !== undefined\n  || memorySubmission.state !== \"prepared\" || hostedCreate.state !== \"allocating\") {\n  throw new Error(\"ARCHIVED_MEMORY_UNSTARTED_BOUNDARY_INVALID\");\n}\nif (queue.some((entry) => entry.state !== \"pending\" || entry.messageActor !== \"human\")) {\n  throw new Error(\"ARCHIVED_HUMAN_QUEUE_INVALID\");\n}\n\nconst tables = [\n  \"profiles\", \"projects\", \"sessions\", \"session_account_authorities\", \"session_provider_account_authorities\",\n  \"queue_entries\", \"queue_sequence_authority\", \"mutation_attempts\", \"mutation_effect_evidence\", \"mutation_resolutions\",\n  \"session_peer_policies\", \"session_host_capability_bindings\", \"peer_session_actions\",\n  \"project_memory_authorities\", \"memory_submissions\", \"memory_page_attestations\", \"memory_page_attestation_refs\",\n  \"memory_working_attestation_heads\", \"memory_working_attestation_forks\",\n  \"project_memory_hosted_attachments\", \"project_memory_hosted_create_intents\", \"project_memory_sync_intents\",\n  \"project_memory_sync_spool\", \"project_memory_portable_adoption_proofs\",\n] as const;\nconst snapshot = () => {\n  const reader = new Database(paths.database, { readonly: true, strict: true });\n  try {\n    return {\n      schemaVersion: (reader.query(\"PRAGMA user_version\").get() as { user_version: number }).user_version,\n      migrations: reader.query(\"SELECT version,applied_at FROM migrations ORDER BY version\").all(),\n      queueColumns: reader.query(\"PRAGMA table_info(queue_entries)\").all(),\n      timestampGuard: reader.query(\"SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name='mutation_resolutions_timestamp_proof_insert'\").get(),\n      rows: Object.fromEntries(tables.map((table) => [table, reader.query(`SELECT * FROM ${table} ORDER BY 1`).all()])),\n      inspectionChanges: reader.query(\"SELECT total_changes() AS count\").get(),\n      foreignKeyCheck: reader.query(\"PRAGMA foreign_key_check\").all(),\n    };\n  } finally {\n    reader.close();\n  }\n};\nconst beforeClose = snapshot();\nconst expectedGuard = /const timestampMutationResolutionGuard = `([\\s\\S]*?)`;/u.exec(stateStoreSource)?.[1]?.trim().slice(0, -1);\nconst guard = beforeClose.timestampGuard as { type: string; name: string; tbl_name: string; sql: string } | null;\nif (guard === null || guard.type !== \"trigger\" || guard.tbl_name !== \"mutation_resolutions\"\n  || guard.sql !== expectedGuard || beforeClose.foreignKeyCheck.length !== 0) {\n  throw new Error(\"ARCHIVED_TIMESTAMP_OR_FOREIGN_KEY_PROOF_INVALID\");\n}\nstore.close();\nconst reopened = new StateStore(paths, { now: () => now });\nreopened.close();\nconst readonly = new StateStore(paths, { readonly: true });\nreadonly.close();\nconst afterReopen = snapshot();\nif (JSON.stringify(beforeClose) !== JSON.stringify(afterReopen)) throw new Error(\"ARCHIVED_REOPEN_REWROTE_FIXTURE\");\nconst checkpoint = new Database(paths.database, { strict: true });\ncheckpoint.exec(\"PRAGMA wal_checkpoint(TRUNCATE)\");\ncheckpoint.close();\nconst bytes = await readFile(paths.database);\nconst source = await readFile(import.meta.filename, \"utf8\");\nconst meta = {\n  sourceRevision, sourceTree, stateStoreSha256: expectedStateStoreSha256, dependencies,\n  purpose: \"Future canonical43 integration fixture only; not current49 compatibility or release proof.\",\n  regeneration: \"Historical APIs generate random IDs; hashes identify this captured output only.\",\n  nativeProviderEffects: 0, networkEffects: 0, physicalMemoryInitialization: false,\n  schemaVersion: afterReopen.schemaVersion, databaseBytes: bytes.byteLength,\n  databaseSha256: sha256(bytes), generatorSha256: sha256(source), timestampGuardSha256: sha256(guard.sql),\n  observations: { profile, project, sessions, policies, hostCapabilities, queue,\n    canonicalIdentity, memoryAuthority, workingBinding, memorySubmission, hostedCreate },\n  ...afterReopen,\n};\nawait writeFile(`${import.meta.dir}/canonical43-output.json`, JSON.stringify({ meta, source, gzip: gzipSync(bytes).toString(\"base64\") }), { mode: 0o600, flag: \"wx\" });\nconsole.log(JSON.stringify({\n  sourceRevision, sourceTree, schemaVersion: meta.schemaVersion, databaseSha256: meta.databaseSha256,\n  generatorSha256: meta.generatorSha256, timestampGuardSha256: meta.timestampGuardSha256,\n  queueColumns: afterReopen.queueColumns, inspectionChanges: afterReopen.inspectionChanges,\n  memoryStates: [memoryAuthority.physicalState, memorySubmission.state, hostedCreate.state],\n  output: `${import.meta.dir}/canonical43-output.json`, database: paths.database,\n}));\n"
  }
} as const;

// Complete unchanged executed source; retained as inert reproduction input.
export const canonical43MemoryGeneratorSource = "import assert from \"node:assert/strict\";\nimport { Database } from \"bun:sqlite\";\nimport { createHash } from \"node:crypto\";\nimport { lstat, mkdir, readFile, readdir, realpath, writeFile } from \"node:fs/promises\";\nimport { dirname, join } from \"node:path\";\nimport { gzipSync } from \"node:zlib\";\n\n// Preparation-only draft until its owner authorizes a scheduled execution.\n// This is the primary canonical43 scenario, not a supplemental peer fixture.\n// Every account, thread, preamble, memory request, and remote identifier below\n// is synthetic. No provider, network client, or physical memory store is used.\nconst sourceRevision = \"eaf0448e19383ac899c30d0a9cd70bbea71ff8b3\";\nconst sourceTree = \"5ce8a9dd0c21fe47d5724b4fc4760380aaaf6100\";\nconst expectedSourceDirectoryGitTree = \"d8ca2b05340bd555087d8b778e94ae3f6edf0108\";\nconst expectedHashes = {\n  \"src/storage/state-store.ts\": \"7f8b283b5f8dcae738aa74d94f9466631f86350b06aa58ecb2790482890bb553\",\n  \"package.json\": \"7467e617297fedc0948818e03054ae062e3f742cfab149c9b722bd391aab6957\",\n  \"bun.lock\": \"f06c91e2e431a9627381fb7d0417541b38e15a1de4b0cc003d4b6dd9c5a3a62f\",\n} as const;\nconst originalGeneratorSha256 = \"8f87f678feb2ce27de26029d5475fa5935c7f131e4dd87f0d25cce7a7a7ee8da\";\nconst dependencies = {\n  \"@hraness/oh\": \"0.4.1\",\n  \"@openai/codex\": \"0.153.2\",\n  convex: \"1.45.0\",\n  effect: \"3.22.1\",\n  zod: \"4.4.3\",\n} as const;\nconst publicProjectRoot = \"/private/tmp/oompa-public-canonical43-fixture/project\";\nconst scratchRoot = import.meta.dir;\nconst outputDirectory = join(scratchRoot, \"run_public1\");\nconst now = 43_001;\nconst options = { now: () => now, resolveMachineTimeZone: () => \"UTC\" };\nconst sha256 = (value: string | Uint8Array) => createHash(\"sha256\").update(value).digest(\"hex\");\nconst object = (value: unknown): Record<string, unknown> => {\n  assert.ok(value !== null && typeof value === \"object\" && !Array.isArray(value));\n  return value as Record<string, unknown>;\n};\nconst parseObject = (value: string): Record<string, unknown> => object(JSON.parse(value) as unknown);\nconst assertCanonicalDirectory = async (path: string, privateOwned: boolean): Promise<void> => {\n  const before = await lstat(path);\n  assert.ok(before.isDirectory() && !before.isSymbolicLink() && before.nlink > 0);\n  assert.equal(await realpath(path), path, \"Never accept an alternate canonical path.\");\n  const after = await lstat(path);\n  assert.equal(after.dev, before.dev);\n  assert.equal(after.ino, before.ino);\n  if (privateOwned) {\n    assert.equal(after.mode & 0o777, 0o700);\n    const owner = process.getuid?.();\n    assert.ok(owner !== undefined, \"This exact public-path generator requires POSIX ownership.\");\n    assert.equal(after.uid, owner);\n  }\n};\n\n// Recompute the trusted Git src tree from bounded local file bytes, without\n// invoking Git or importing archived code. This also proves transitive source\n// files, not just the main StateStore module. Symlinks and special files fail.\nconst gitObjectHash = (kind: \"blob\" | \"tree\", bytes: Uint8Array): Buffer =>\n  createHash(\"sha1\").update(`${kind} ${bytes.byteLength}\\0`).update(bytes).digest();\nlet sourceEntries = 0;\nlet sourceBytes = 0;\nconst sourceDirectoryHash = async (path: string, depth = 0): Promise<Buffer> => {\n  assert.ok(depth <= 16);\n  const entries = await readdir(path, { withFileTypes: true });\n  sourceEntries += entries.length;\n  assert.ok(sourceEntries <= 2_048, \"Bound the archived source inventory.\");\n  entries.sort((left, right) => Buffer.compare(\n    Buffer.from(`${left.name}${left.isDirectory() ? \"/\" : \"\"}`),\n    Buffer.from(`${right.name}${right.isDirectory() ? \"/\" : \"\"}`),\n  ));\n  const records: Buffer[] = [];\n  for (const entry of entries) {\n    assert.ok(!entry.isSymbolicLink());\n    assert.ok(entry.isDirectory() || entry.isFile());\n    const child = join(path, entry.name);\n    const before = await lstat(child);\n    assert.equal(before.isSymbolicLink(), false);\n    let digest: Buffer;\n    let mode: string;\n    if (entry.isDirectory()) {\n      assert.ok(before.isDirectory());\n      mode = \"40000\";\n      digest = await sourceDirectoryHash(child, depth + 1);\n    } else {\n      assert.ok(before.isFile());\n      assert.ok(before.size <= 8 * 1_024 * 1_024);\n      sourceBytes += before.size;\n      assert.ok(sourceBytes <= 64 * 1_024 * 1_024);\n      const bytes = await readFile(child);\n      assert.equal(bytes.byteLength, before.size);\n      mode = (before.mode & 0o111) === 0 ? \"100644\" : \"100755\";\n      digest = gitObjectHash(\"blob\", bytes);\n    }\n    const after = await lstat(child);\n    assert.equal(after.dev, before.dev);\n    assert.equal(after.ino, before.ino);\n    assert.equal(after.size, before.size);\n    assert.equal(after.mtimeMs, before.mtimeMs);\n    records.push(Buffer.from(`${mode} ${entry.name}\\0`), digest);\n  }\n  return gitObjectHash(\"tree\", Buffer.concat(records));\n};\n\nawait assertCanonicalDirectory(scratchRoot, true);\nassert.equal(Bun.version, \"1.3.14\");\nassert.equal(sha256(await readFile(join(scratchRoot, \"generate-canonical43.ts\"))), originalGeneratorSha256);\nfor (const [path, digest] of Object.entries(expectedHashes)) {\n  assert.equal(sha256(await readFile(join(scratchRoot, path))), digest, `ARCHIVED_FILE_MISMATCH:${path}`);\n}\nassert.equal((await sourceDirectoryHash(join(scratchRoot, \"src\"))).toString(\"hex\"), expectedSourceDirectoryGitTree);\nconst archivedPackage = parseObject(await readFile(join(scratchRoot, \"package.json\"), \"utf8\"));\nassert.equal(object(archivedPackage.engines).bun, \"1.3.14\");\nconst declaredDependencies = object(archivedPackage.dependencies);\nfor (const [name, expected] of Object.entries(dependencies)) {\n  const installed = parseObject(await readFile(join(scratchRoot, \"node_modules\", name, \"package.json\"), \"utf8\"));\n  assert.equal(declaredDependencies[name], expected);\n  assert.equal(installed.name, name);\n  assert.equal(installed.version, expected, `ARCHIVED_DEPENDENCY_MISMATCH:${name}`);\n}\nconst stateStoreSource = await readFile(join(scratchRoot, \"src/storage/state-store.ts\"), \"utf8\");\n\n// Archived imports occur only after source, package, lock, runtime, and pinned\n// direct dependency verification. No archive is created or modified here.\nconst { StateStore } = await import(\"./src/storage/state-store\");\nconst { initializeStatePaths, resolveStatePaths } = await import(\"./src/storage/paths\");\nconst { createFactsMemoryBinding } = await import(\"./src/domain/facts-memory\");\nconst { createPortableProjectMemoryCanonicalIdentity, PROJECT_MEMORY_EMPTY_HEAD } = await import(\"./src/domain/project-memory\");\n\n// Both mkdir calls are atomic absent-name admissions: no recursive mkdir,\n// reuse, chmod, deletion, or recovery of a previous capture is permitted.\n// The known public literal is intentional fixture input, not host provenance.\nfor (const ancestor of [\"/\", \"/private\", \"/private/tmp\"]) {\n  await assertCanonicalDirectory(ancestor, false);\n}\nawait mkdir(outputDirectory, { mode: 0o700 });\nawait assertCanonicalDirectory(outputDirectory, true);\nconst publicParent = dirname(publicProjectRoot);\nawait mkdir(publicParent, { mode: 0o700 });\nawait assertCanonicalDirectory(publicParent, true);\nawait mkdir(publicProjectRoot, { mode: 0o700 });\nawait assertCanonicalDirectory(publicProjectRoot, true);\nfor (const ancestor of [\"/private\", \"/private/tmp\", publicParent]) {\n  await assertCanonicalDirectory(ancestor, ancestor === publicParent);\n}\n\nconst paths = resolveStatePaths({ rootDirectory: join(outputDirectory, \"state\") });\nawait initializeStatePaths(paths);\ntype Snapshot = {\n  schemaVersion: number;\n  migrations: unknown[];\n  schema: unknown[];\n  queueColumns: unknown[];\n  timestampGuard: unknown;\n  rows: Record<string, unknown[]>;\n  inspectionChanges: unknown;\n  foreignKeyCheck: unknown[];\n};\nconst snapshot = (): Snapshot => {\n  const reader = new Database(paths.database, { readonly: true, strict: true });\n  try {\n    const tableRows = reader.query(\"SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name LIMIT 513\").all();\n    assert.ok(tableRows.length <= 512);\n    const rows: Record<string, unknown[]> = {};\n    for (const row of tableRows) {\n      const name = object(row).name;\n      assert.ok(typeof name === \"string\" && /^[A-Za-z0-9_]+$/u.test(name));\n      const values = reader.query(`SELECT * FROM \"${name}\" LIMIT 4097`).all();\n      assert.ok(values.length <= 4_096, `Bound fixture table rows:${name}`);\n      rows[name] = values.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));\n    }\n    const version = object(reader.query(\"PRAGMA user_version\").get()).user_version;\n    assert.equal(version, 43);\n    assert.equal(object(reader.query(\"PRAGMA encoding\").get()).encoding, \"UTF-8\");\n    const value: Snapshot = {\n      schemaVersion: 43,\n      migrations: reader.query(\"SELECT version,applied_at FROM migrations ORDER BY version\").all(),\n      schema: reader.query(\"SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name LIMIT 4097\").all(),\n      queueColumns: reader.query(\"PRAGMA table_info(queue_entries)\").all(),\n      timestampGuard: reader.query(\"SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name='mutation_resolutions_timestamp_proof_insert'\").get(),\n      rows,\n      inspectionChanges: reader.query(\"SELECT total_changes() AS count\").get(),\n      foreignKeyCheck: reader.query(\"PRAGMA foreign_key_check\").all(),\n    };\n    assert.ok(value.schema.length <= 4_096);\n    assert.deepEqual(value.inspectionChanges, { count: 0 });\n    assert.deepEqual(value.foreignKeyCheck, []);\n    assert.ok(Buffer.byteLength(JSON.stringify(value), \"utf8\") <= 16 * 1_024 * 1_024);\n    return value;\n  } finally {\n    reader.close(false);\n  }\n};\n\nconst store = new StateStore(paths, options);\nconst observations = await (async () => {\n  try {\n    assert.equal(snapshot().schemaVersion, 43);\n    const project = await store.createProject(\"Canonical43 fixture project\", publicProjectRoot, true);\n    assert.equal(project.rootPath, publicProjectRoot);\n    await assertCanonicalDirectory(publicProjectRoot, true);\n    const profile = store.nextProfileGeneration(store.createProfile(\"Canonical43 synthetic account\").id);\n    // Populate this sequence through its real API before the no-write reopen\n    // snapshot. Its unused reservation is not a quota observation or upload.\n    const unusedUsageRevision = store.allocateNextUsageRevision(profile.id);\n    assert.equal(unusedUsageRevision, 1);\n    const email = \"canonical43@example.com\";\n    assert.equal(store.setProfileState(profile.id, profile.processGeneration, \"signed_in\", { email, plan: \"Plus\" }), true);\n    const accountKey = `v1:codex:${sha256(email)}`;\n    const sessions = [\"primary\", \"peer\"].map((label) => {\n      const created = store.createSession({\n        profileId: profile.id, projectId: project.id, title: `Canonical43 ${label}`,\n        provider: \"codex\", preset: \"high\", fastEnabled: false,\n      });\n      store.bindSessionProviderAccountAuthority({\n        sessionId: created.id, provider: \"codex\", runtimeScope: \"managed\", accountKey,\n      });\n      return store.bindSession({\n        sessionId: created.id, expectedRevision: created.revision,\n        providerThreadId: `canonical43-synthetic-${label}`, state: \"idle\", providerUpdatedAt: now,\n      });\n    });\n    const [primary, peer] = sessions;\n    assert.ok(primary !== undefined && peer !== undefined);\n    const policies = [\n      store.setPeerSessionPolicy({ sessionId: primary.id, expectedRevision: 1, mode: \"inspect\" }),\n      store.setPeerSessionPolicy({ sessionId: peer.id, expectedRevision: 1, mode: \"off\" }),\n    ];\n    const hostCapabilities = store.bindSessionHostCapabilities({\n      sessionId: primary.id, preambleVersion: 1, preambleDigest: sha256(\"Canonical43 synthetic host preamble\"),\n      manifestVersion: 1, manifestDigest: sha256(\"Canonical43 synthetic host capability manifest\"),\n    });\n    const queue = [\n      store.enqueueIdempotent({\n        sessionId: primary.id, profileGeneration: profile.processGeneration,\n        message: \"Canonical43 human queue first entry.\", idempotencyKey: \"43000000-0000-4000-8000-000000000001\",\n      }),\n      store.enqueueIdempotent({\n        sessionId: primary.id, profileGeneration: profile.processGeneration,\n        message: \"Canonical43 human queue second entry.\", idempotencyKey: \"43000000-0000-4000-8000-000000000002\",\n      }),\n    ];\n    const canonicalIdentity = createPortableProjectMemoryCanonicalIdentity(project.id);\n    const memoryAuthority = store.reserveProjectMemoryAuthority({\n      projectId: project.id, identityContract: canonicalIdentity.identityContract,\n      canonicalSpaceId: canonicalIdentity.canonicalSpaceId, head: PROJECT_MEMORY_EMPTY_HEAD,\n    });\n    const workingBinding = createFactsMemoryBinding({ ownerId: profile.id, sessionId: primary.id });\n    const localRequest = { kind: \"remember\", key: \"fixture:pending\", content: \"Synthetic pending local memory request.\" };\n    const memorySubmission = store.prepareMemorySubmission({\n      actorSessionId: primary.id, projectId: project.id, kind: \"remember\",\n      requestDigest: sha256(JSON.stringify(localRequest)), contentDigest: sha256(localRequest.content),\n      keyDigest: sha256(localRequest.key), workingBindingDigest: workingBinding.bindingDigest,\n      workingEpoch: workingBinding.epoch, expectedHead: PROJECT_MEMORY_EMPTY_HEAD,\n      idempotencyKey: \"43000000-0000-4000-8000-000000000003\",\n    }).record;\n    const hostedCreate = store.allocateCanonicalMemoryHostedCreate({\n      accountBindingDigest: sha256(\"Canonical43 synthetic hosted account binding\"),\n      idempotencyKey: \"43000000-0000-4000-8000-000000000004\",\n      projectId: project.id, remoteSpaceId: `memory_${\"4\".repeat(32)}`,\n    }).record;\n    assert.equal(memoryAuthority.physicalState, \"reserved\");\n    assert.equal(memoryAuthority.initializedAt, undefined);\n    assert.equal(memorySubmission.state, \"prepared\");\n    assert.equal(hostedCreate.state, \"allocating\");\n    assert.ok(queue.every((entry) => entry.state === \"pending\" && entry.messageActor === \"human\"));\n    const retainedProfile = store.requireProfile(profile.id);\n    assert.equal(retainedProfile.state, \"signed_in\");\n    assert.equal(retainedProfile.processGeneration, profile.processGeneration);\n    return { profile: retainedProfile, unusedUsageRevision, project, sessions, policies, hostCapabilities, queue,\n      canonicalIdentity, memoryAuthority, workingBinding, memorySubmission, hostedCreate };\n  } finally {\n    store.close();\n  }\n})();\n\nconst beforeReopen = snapshot();\nassert.equal(beforeReopen.rows.projects?.length, 1);\nassert.equal(beforeReopen.rows.session_peer_policies?.length, 2);\nassert.equal(beforeReopen.rows.session_host_capability_bindings?.length, 1);\nassert.equal(beforeReopen.rows.queue_entries?.length, 2);\nassert.equal(beforeReopen.rows.project_memory_authorities?.length, 1);\nassert.equal(beforeReopen.rows.memory_submissions?.length, 1);\nassert.equal(beforeReopen.rows.project_memory_hosted_create_intents?.length, 1);\nassert.deepEqual(beforeReopen.rows.usage_revision_authority, [\n  { profile_id: observations.profile.id, next_revision: 2 },\n]);\nfor (const name of [\"mutation_effect_evidence\", \"mutation_resolutions\", \"peer_session_actions\",\n  \"usage_snapshots\", \"usage_poll_failures\", \"usage_cloud_upload_anchors\",\n  \"memory_page_attestations\", \"memory_page_attestation_refs\", \"memory_working_attestation_heads\",\n  \"memory_working_attestation_forks\", \"project_memory_hosted_attachments\", \"project_memory_sync_intents\",\n  \"project_memory_sync_spool\", \"project_memory_portable_adoption_proofs\"]) {\n  assert.deepEqual(beforeReopen.rows[name], [], `No invented accepted effect or physical memory evidence:${name}`);\n}\nassert.equal(beforeReopen.rows.notification_hours?.length, 1);\nconst notificationHours = beforeReopen.rows.notification_hours;\nassert.ok(notificationHours !== undefined);\nassert.equal(object(notificationHours[0]).time_zone, \"UTC\");\nassert.equal(beforeReopen.rows.attention_email_policy?.length, 1);\nconst expectedGuard = /const timestampMutationResolutionGuard = `([\\s\\S]*?)`;/u.exec(stateStoreSource)?.[1]?.trim().slice(0, -1);\nassert.ok(expectedGuard !== undefined && expectedGuard.length > 0);\nconst guard = object(beforeReopen.timestampGuard);\nassert.equal(guard.type, \"trigger\");\nassert.equal(guard.name, \"mutation_resolutions_timestamp_proof_insert\");\nassert.equal(guard.tbl_name, \"mutation_resolutions\");\nassert.equal(guard.sql, expectedGuard);\n\nconst reopened = new StateStore(paths, options);\ntry {\n  assert.deepEqual(snapshot(), beforeReopen, \"Archived writable reopen must preserve every schema object and row.\");\n} finally {\n  reopened.close();\n}\nassert.deepEqual(snapshot(), beforeReopen);\nconst checkpoint = new Database(paths.database, { create: false, strict: true });\nlet checkpointResult: unknown;\ntry {\n  checkpointResult = checkpoint.query(\"PRAGMA wal_checkpoint(TRUNCATE)\").get();\n  assert.equal(object(checkpointResult).busy, 0);\n} finally {\n  checkpoint.close(false);\n}\nconst beforeReadonlyBytes = await readFile(paths.database);\nassert.ok(beforeReadonlyBytes.byteLength <= 8 * 1_024 * 1_024);\nconst readonly = new StateStore(paths, { ...options, readonly: true });\ntry {\n  assert.deepEqual(snapshot(), beforeReopen, \"Archived readonly reopen must preserve every schema object and row.\");\n} finally {\n  readonly.close();\n}\nconst afterReopen = snapshot();\nassert.deepEqual(afterReopen, beforeReopen);\nconst bytes = await readFile(paths.database);\nassert.equal(sha256(bytes), sha256(beforeReadonlyBytes));\nassert.ok(bytes.byteLength <= 8 * 1_024 * 1_024);\n\n// No host-path replacement or database rewriting. Check the complete raw\n// UTF-8 SQLite image, including free pages, not just selected live columns.\n// Only the entire reviewed public path is permitted; descendants and sibling\n// spellings are not a prefix exemption. The all-row metadata check also checks\n// exact string values, where SQLite record boundaries are unambiguous.\n// A slash embedded in a relative filename is not an absolute-path start.\n// The independent prefix scan below has no such boundary exemption, so a\n// private host prefix cannot hide behind preceding record bytes or prose.\nconst pathTokens = /(?<![A-Za-z0-9._~%+@=:\\/-])(?:\\/[A-Za-z0-9._~%+@=-]+){2,}\\/?|[A-Za-z]:[\\\\/][^\\s\\u0000\"'<>]+|\\\\\\\\[^\\s\\u0000\"'<>]+/gu;\nconst privatePrefixes = [\"/Users/\", \"/home/\", \"/private/\", \"/tmp/\", \"/var/\", \"/Volumes/\",\n  \"/Applications/\", \"/opt/\", \"/etc/\", \"/root/\", \"/run/\", \"/workspace/\", \"/mnt/\", \"/media/\", \"/srv/\"];\nconst assertPathBytes = (value: Buffer): void => {\n  for (const forbidden of [scratchRoot, outputDirectory, paths.database, paths.root]) {\n    assert.equal(value.includes(Buffer.from(forbidden)), false, \"Private capture path must never be published.\");\n  }\n  const text = value.toString(\"latin1\");\n  const allowed: Array<{ start: number; end: number }> = [];\n  let publicOffset = text.indexOf(publicProjectRoot);\n  while (publicOffset !== -1) {\n    // Raw SQLite text fields need not have a printable delimiter before them.\n    // Still refuse a descendant or longer sibling that shares this prefix.\n    const complete = /^(?:\\/[A-Za-z0-9._~%+@=-]+){2,}\\/?/u.exec(text.slice(publicOffset))?.[0];\n    assert.equal(complete, publicProjectRoot, \"The public fixture path is not a prefix exemption.\");\n    allowed.push({ start: publicOffset, end: publicOffset + publicProjectRoot.length });\n    publicOffset = text.indexOf(publicProjectRoot, publicOffset + publicProjectRoot.length);\n  }\n  for (const match of text.matchAll(pathTokens)) {\n    assert.equal(match[0], publicProjectRoot, \"Unexpected absolute path bytes in fixture.\");\n  }\n  for (const prefix of privatePrefixes) {\n    let offset = text.indexOf(prefix);\n    while (offset !== -1) {\n      assert.ok(allowed.some((span) => offset >= span.start && offset + prefix.length <= span.end),\n        \"No broad host-path prefix is allowlisted.\");\n      offset = text.indexOf(prefix, offset + 1);\n    }\n  }\n};\nconst assertMetadataPaths = (value: unknown): void => {\n  if (typeof value === \"string\") {\n    assertPathBytes(Buffer.from(value, \"utf8\"));\n    if (value.includes(publicProjectRoot)) assert.equal(value, publicProjectRoot);\n    if (value.startsWith(\"/\")) assert.equal(value, publicProjectRoot);\n  } else if (Array.isArray(value)) {\n    for (const child of value) assertMetadataPaths(child);\n  } else if (value !== null && typeof value === \"object\") {\n    for (const [key, child] of Object.entries(value)) {\n      assertMetadataPaths(key);\n      assertMetadataPaths(child);\n    }\n  }\n};\nassertPathBytes(bytes);\nconst source = await readFile(import.meta.filename, \"utf8\");\nconst meta = {\n  sourceRevision, sourceTree, sourceDirectoryGitTree: expectedSourceDirectoryGitTree,\n  sourceHashes: {\n    stateStoreSha256: expectedHashes[\"src/storage/state-store.ts\"],\n    packageJsonSha256: expectedHashes[\"package.json\"],\n    bunLockSha256: expectedHashes[\"bun.lock\"],\n  },\n  originalGeneratorSha256, dependencies, bunVersion: Bun.version,\n  purpose: \"Future canonical43 integration fixture only; not current49 compatibility or release proof.\",\n  regeneration: \"Historical APIs generate random IDs; hashes identify this captured output only.\",\n  usageReservationNotice: \"Revision1 is explicitly reserved but unused; next_revision2 does not prove a quota observation, poll failure, or cloud upload.\",\n  publicFixtureProjectRoot: publicProjectRoot,\n  pathNotice: \"The sole allowed absolute project path is intentionally public synthetic fixture input. No real project or machine path is captured.\",\n  fixedTime: now, timeZone: \"UTC\", syntheticOnly: true,\n  nativeProviderEffects: 0, networkEffects: 0, physicalMemoryInitialization: false,\n  hostToolExecution: false, peerActionsExecuted: false, rawSqlRowOrSchemaWrites: false,\n  assertions: { writableReopenAllRowsAndSchemaUnchanged: true, readonlyReopenAllRowsAndSchemaUnchanged: true,\n    readonlyDatabaseHashUnchanged: true, allTableSnapshot: true, publicPathOnly: true,\n    memoryReservedPreparedAllocatingOnly: true, noMigrationOrCurrentSchemaAcceptanceClaim: true },\n  databaseBytes: bytes.byteLength, databaseSha256: sha256(bytes), generatorSha256: sha256(source),\n  timestampGuardSha256: sha256(expectedGuard), checkpointResult,\n  observations,\n  notificationHours: afterReopen.rows.notification_hours,\n  attentionEmailPolicy: afterReopen.rows.attention_email_policy,\n  ...afterReopen,\n};\nassertMetadataPaths(meta);\nconst metadataJson = JSON.stringify(meta);\nassert.ok(Buffer.byteLength(metadataJson, \"utf8\") <= 16 * 1_024 * 1_024);\nassertPathBytes(Buffer.from(metadataJson, \"utf8\"));\nconst artifact = JSON.stringify({ meta, source, gzip: gzipSync(bytes).toString(\"base64\") });\nassert.ok(Buffer.byteLength(artifact, \"utf8\") <= 32 * 1_024 * 1_024);\nawait writeFile(join(outputDirectory, \"canonical43-public-output.json\"), artifact, { mode: 0o600, flag: \"wx\" });\nconsole.log(JSON.stringify({\n  sourceRevision, sourceTree, schemaVersion: 43, databaseSha256: meta.databaseSha256,\n  generatorSha256: meta.generatorSha256, timestampGuardSha256: meta.timestampGuardSha256,\n  databaseBytes: bytes.byteLength, inspectionChanges: afterReopen.inspectionChanges,\n  memoryStates: [observations.memoryAuthority.physicalState, observations.memorySubmission.state, observations.hostedCreate.state],\n  allTableWritableReadonlyReopenUnchanged: true,\n  artifact: \"run_public1/canonical43-public-output.json\",\n}));\n";

const gzipBase64 = [
  "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",
  "N9Ixd+8v4F0f+KdblKpef3vGe0ER6a1dqb47JokNOmY50DN86BnXOxsRoy0XF/vbIuSXCrl0Tcws5/PZPL9YTYsLBbGaSVfpcrWaXnzkbVGlJq/u+5pjXRrY",
  "IuP7/7HYV0jsK7GvY5QDAAAAAAAAAABvApLjO5GRPjgZM/z/jfSxhPX8r5OYHvunj7t5AAAAAAAAAADAUWL12E4pMtLvAcJ/tjB24djOxak3osT6cYD1/P8z",
  "JPYzsX/3uO0CAAAAAAAAAAC8pTl9bHwnQl57fbTv/lPHxnemHOlh3/8b5//Jk4+7gQAAAAAAAAAAAHiUGN//4/kfAAAAAAAAAAA42hjf/5849lUy+yezLx77",
  "6on1E3PTPzz5/0z+8uT9yanoT47dfdz1AwCAfu6+PB6Nf+QjkS98r85XG1TkaVOROU3ndd/fx1Y22VKFZSql8+ss401h5qcZRpPkeoPqisyslSvsRXaTeWFz",
  "7Upp8xpzmb3GrFxiVy7Pd2WKTCaZmmaYOpWpyuuSJ1t5o8KUt9fX7TweiXNFJm3mqiqKzkkiU2GvVoz3ms6rOhU5Xne0WFeVVst3dTrFiLTGtxs6x7daqrLH",
  "N7imIlJTUbfgVfZCaXu9wiT4tq48yzcaCbsuwZnXysx8VzRl/XlTUa9rLV6giVSiycttvpFIJrvFa7vKTU7fleTrklzvb7pTg3RPwb3ZmPl0KuPV21KpRvWw",
  "9rQbusr3NsbOYraiodxMpBKGi9tEypa2tO9JAuUEpdnkZVHj+EZDuUnF8Hpn3DLCMro15wVBacs617AaNVy3Y5PwjLbuJLNV2VxbqTRPROP5pyKdt0uySG/Z",
  "4Xo0rsFXaYNry9KNNnUuPmGP8e3y2ovbLLNWXmWvMoE5mI2ymzBvFKzOm8nJ5Geno/HFpyKdJbM4RaZc19KmvJPtRFBhAfK+oiTNSU4yO5fYTZbpXjFm1TNT",
  "E/GVpyLELFy70ZB0yhkD0nzvaNS4Beev6WcmR8qQcf6auv3RaDT+1FORex8wlwvnuvM66VsmnKvmEmHP2ICFQRKZi+sb55mE6bf5pfTpAn+69vKpBFMqrzIN",
  "Ktf13XlJTDJFZjFvrgCmrXuGuaXKlrY6gznPVnZYtsxkTE2ZnLV+qMb60eL13R4NVk8YEh6jhqxLPglnNE8zjKBSY+H0rDq9OT0S7orWbolDcnkkzhU9pSSn",
  "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",
  "7JKA5nb9Etjy3YFwyCyOm4XeHIELmfH8H4n9BYn9xeP+JAIAAAAAAAAAAAAPn2ORY2QSv/8HAAAAAAAAAADeAsD/PwAAAAAAAAAAcPSB/z8AAAAAAAAAAODo",
  "g+//AQAAAAAAAACAow++/wcAAAAAAAAAAI4+eP4HAAAAAAAAAACOPvj9PwAAAAAAAAAAcPTB9/8AAAAAAAAAAMDRZ+ZYhMyQFJn6h5O/FP2nE79x/OvHvnVs",
  "ivz38Z8nqdm/nPnz6b+Y/vvTV6evGrKd1XPRuFCKdG5IskhviVS7ristTrsp6cIup1JNabR1SZG5OpWpypt/tmXpRpuGimrPrWyypQrLbJfXXtxmmbXyKnuV",
  "OYTmaYbZKIdn0ObtS92Mybu556LxUiny+Zs6X20MqFt4yrN2rSul8+vsgNKZ+WmG4XWdNls6J4lMhb1aYV7YXLtS2rzGXGavMZvsBXaTLa+wWz1aqDbfzZdM",
  "TTNMX0OYtXKFvchuMuWNClPeXl9nVi6xK5f7W8ycY9KmCo8hr0uyXZ2e3L0ya2VmPmFe3KMix7daDYmKiVT3kqzo7uWkWYwo8XVZ0XRJ4ARFpIHF9MpcXN84",
  "zyReKp3+5MunEkypvMo0qFzXd3sFk8x5trLDsmUmY0otWy1TqhpV96yBIUp1qumBpdo6+6WTTJHJZW0jCVRq6dwrmiIPUrJS2qrM+4RLW8z59Y3zyW4dF8w6",
  "LuQWMllHuWNIPaz7vCLnikw6OZ1ktiqbayuVreJEvF6KEHP2aTcakk45vq0r5nsufBRymfC0s1N/QSbNyS2ejc7tLE0eXNRVqV6narOtWxbyapKaxuVqg3Ii",
  "bVCdBgk5c2Nz7aLRvJH0TJ9nL2xssswqu85WWGNKB2WbPs9eXCszW+w6u1JhNktrW+x86fzGZiXFJBx5zyBnJI1xC0okzzJsebUjPnuoZrZbIv8wmmnpcZq5",
  "/cJq6dE2Uy5E514qTB5s2c3UqKYZxWg6r+qcvbT090OwWE9TR9TV36fBGQc1187BmDmYqiSLklwPbvDyIRts9cjDaXBY7z7KBu/no3NccfKA7x3ItFajgs7R",
  "PUmkskDD52yPYNiAHqZvwNztyTrSwLbyME6e4LbnDt32non8hts+dEI/orZfXJqIv7QUdhMIXIUyQVeXCYmQtzJ390vRucunJ7943B5EPTdJXeVlTbJ2nW1e",
  "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",
  "Xag2R11AeLhC2JOMnch3GXNg77KephpqSzXfZT1N1Z0LEGXzXSG1DD4OlteAC9eKOddC+gTypEjseyF3ZSWYGkslc7Bu5bJbf+cFnyvktuQOFVs7krJN+cc9",
  "qnVl/w26ThK8B1ZaWh1J10ddQ8kE8oH7F88v2bdZ9jt2f8C+e9D8HU61+Tio4tJFpsHsOHR4FdaDsA72PKhk8fxL1guLtqwbx0YkxJEZEZEn1bVR+0ZL7Uar",
  "Y1eTOQKW2laL9gzazhVyGt3q6+wvnSrsPk6qbUqG3BW7st6VjNYOE2KVh2riliR3aNu+oK1Wd9VaF4JuSwa1RT7+unT2s+IbZ8xb7VgMO5J1NWlXj2tNOQn3",
  "Dav3N6Vts52L8cO5cy0336TEeORF3NAsJ6s6FolXGc1aE1XTbJX5GM9m9TV9sgrlPOKrg3cR2+DSwVelsq+Wk4NWqFHuUl2Xtqmoq32tRfWI90ZAYubZ2BY6",
  "Wtf/z977wMaR5Xd+zZbEJqnRaC+7XmaXlre0/5o909J2k91s9sy2xlSzJHFENaVmcymtPNNbXfWarFF3VauqmpK82fioprQ76z177b14fQfcOcj92UM2RnxG",
  "cMABBnJB/tmHIAEud7HhA4zz5ZAYMWLERs7BJggS1P9X1VXV1SQ1muF8PwvMil2/93v/fu/Ve6/e+z3G10/7pDzdNXWtpdFJf21wfnJWrIYNKaIiz0fl4ezT",
  "5uDV1Gy1mjyoDvX+PuEoPTOed0GEZOCA43AdvalxWImnd3CEhrq6XG78K0YdG6bfY56Kc+PD/X8AAAAAAAAAAMDHCPj/AwAAAAAAAAAATj6Y/wMAAAAAAAAA",
  "ACcf+P8DAAAAAAAAAABOPpj/AwAAAAAAAAAAJx/s/wcAAAAAAAAAAE4++P4PAAAAAAAAAAB8POb/yfN/J3H+75z/Zy87LQAAAAAAAAAAwMeYy2cSp7YnEj/6",
  "iUpUtZkv5Rf5Itci+fZSYXk5v7xUKC+3F5cKRaHI80tc8pIuPm2L86VieSnXFvLLpVKhxC22csJCWWjlcy2y3GrlFvX9/2cm/zjx6nuv/P4rfzX19uQfv+zs",
  "AgAAAMfAzhcmZ7+5NZEQJYE8Vh92RI00ub4mG383e4q8JwpEaSp9SRO7pMnxvNyXtKZC9mSe00RZUpv5OFJf/u7i51OzW1sTP1jTuFaHxAkTR+ZL1Tq70mCZ",
  "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",
].join("");

const assertCanonical43DatabaseSize = (size: number): void => {
  if (!Number.isSafeInteger(size) || size < 100 || size > 8 * 1_024 * 1_024) {
    throw new Error("CANONICAL43_MEMORY_FIXTURE_BOUNDS_INVALID");
  }
};

export const canonical43MemoryDatabaseBytes = (): Uint8Array => {
  if (Buffer.byteLength(canonical43MemoryGeneratorSource, "utf8") > 64 * 1_024
    || createHash("sha256").update(canonical43MemoryGeneratorSource).digest("hex")
      !== canonical43MemoryFixture.generatorSha256) {
    throw new Error("CANONICAL43_MEMORY_GENERATOR_MISMATCH");
  }
  const original = canonical43MemoryFixture.regenerationInputs.originalGeneratorSource;
  const originalHash = createHash("sha256").update(original).digest("hex");
  if (Buffer.byteLength(original, "utf8") > 32 * 1_024
    || [canonical43MemoryFixture.originalGeneratorSha256,
      canonical43MemoryFixture.regenerationInputs.originalGeneratorSha256].some((expected) => originalHash !== expected)) {
    throw new Error("CANONICAL43_MEMORY_ORIGINAL_GENERATOR_MISMATCH");
  }
  assertCanonical43DatabaseSize(canonical43MemoryFixture.databaseBytes);
  if (gzipBase64.length > 2 * 1_024 * 1_024
    || gzipBase64.length % 4 !== 0
    || !/^[A-Za-z0-9+/]*={0,2}$/u.test(gzipBase64)) {
    throw new Error("CANONICAL43_MEMORY_FIXTURE_BOUNDS_INVALID");
  }
  const compressed = Buffer.from(gzipBase64, "base64");
  if (compressed.toString("base64") !== gzipBase64) {
    throw new Error("CANONICAL43_MEMORY_FIXTURE_ENCODING_INVALID");
  }
  const bytes = gunzipSync(compressed, { maxOutputLength: canonical43MemoryFixture.databaseBytes });
  if (bytes.byteLength !== canonical43MemoryFixture.databaseBytes
    || createHash("sha256").update(bytes).digest("hex") !== canonical43MemoryFixture.databaseSha256
    || !bytes.subarray(0, 16).equals(Buffer.from("SQLite format 3\0"))
    || bytes.readUInt32BE(60) !== canonical43MemoryFixture.schemaVersion) {
    throw new Error("CANONICAL43_MEMORY_FIXTURE_MISMATCH");
  }
  return bytes;
};
