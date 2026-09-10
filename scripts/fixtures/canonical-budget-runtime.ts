import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";

// Exact protected-source canonical43 API output and its real canonical45
// migration successor. All paths and identities are public synthetic inputs.
// Original capture bytes contain only names accepted by their actual writers;
// later test corruption is adversarial input, not historical producer output.
// No provider/native/network effects and no raw SQL row, schema, or version
// writes occurred in the capture. Positive budget history came from the real
// 43-to-45 migration, followed by a released counter reset after its hold.
// This supplementary image records synthetic session_start runtime profiles
// through the archived API, after its real daemon generation was initialized.
// It does not replace the original budget-only captures or prove provider IO.
// Reproduce by archiving each sourceCommit's src/package.json/bun.lock, using
// the pinned production dependencies, and running the retained generator under
// the reviewed host scheduler. Refuse existing capture-runtime2 output; random IDs mean
// a rerun is a new capture, not byte-identical regeneration.
export const canonicalBudgetRuntimeFixtures = {
  "43": {
    "sourceCommit": "97cebc44ecd2d27b8c0b6399b0814b1993d94fc1",
    "sourceTree": "afb3340a1ed83b7735538aad955ad00d178dc116",
    "sourceManifestSha256": "3b4554cd03441e9bc2352d933d3f1718393d93a21ed3141561fc5fe1a1334b0e",
    "sourceFileCount": 278,
    "sourceHashes": {
      "src/storage/state-store.ts": "cfe045e01bd47585a45596b9e163f5562e25aa800bdd82f4fc1df0155eb55e31",
      "package.json": "417a70d8cd6287b45f53e667603903a86388d9f186266326f1197a94b3202088",
      "bun.lock": "db7ab88639f59ec431129416a31bb4de4ef4098d21c065d0be40d272019e46b5"
    },
    "schemaVersion": 43,
    "generatorSha256": "fb09bd5025f5bda4090aeff1747dcebc133196528d1f6ad80efd2de1dd4fece8",
    "bunVersion": "1.3.14",
    "dependencies": {
      "@hraness/oh": "0.2.7",
      "@openai/codex": "0.153.2",
      "convex": "1.45.0",
      "effect": "3.22.1",
      "zod": "4.4.3"
    },
    "fixedTime": 43000,
    "predecessorDatabaseSha256": null,
    "provenance": {
      "syntheticControlPlaneOnly": true,
      "archivedPublicApisOnly": true,
      "nativeProviderEffects": 0,
      "networkEffects": 0,
      "rawSqlRowOrSchemaWrites": false,
      "randomizedIdentifiers": true,
      "writableReopenUnchanged": true,
      "readonlyReopenUnchanged": true,
      "readonlyDatabaseHashUnchanged": true,
      "originalUnsafeNamesOrCancelledPendingRows": false,
      "currentMergedAdmissionClaim": false,
      "supplementalSyntheticRuntimeProfiles": true,
      "providerRuntimeObservationClaim": false
    },
    "databaseSha256": "7ab3b21f2cafabb0e1494a20bae58c77e08e17a82423a337976651bee61a3322",
    "databaseBytes": 1421312,
    "checkpointResult": {
      "busy": 0,
      "log": 0,
      "checkpointed": 0
    },
    "retained": {
      "bootId": "boot_44444444444444444444444444444444",
      "daemonGeneration": 1,
      "profile": {
        "id": "acct_157c3bfdb1674fc58f9c08ac2934fdf2",
        "label": "Canonical budget synthetic account",
        "state": "signed_in",
        "processGeneration": 1,
        "providerEmail": "canonical-budget@example.com",
        "providerPlan": "Plus",
        "createdAt": 43000,
        "updatedAt": 43000
      },
      "session": {
        "id": "sess_f72df16539504fc9a3026b5133d55553",
        "profileId": "acct_157c3bfdb1674fc58f9c08ac2934fdf2",
        "providerThreadId": "canonical-budget-synthetic-transcript",
        "title": "Canonical43 transcript repair source",
        "note": "",
        "provider": "codex",
        "preset": "high",
        "fastEnabled": false,
        "state": "idle",
        "revision": 1,
        "createdAt": 43000,
        "updatedAt": 43000
      },
      "attachments": {
        "pending": [
          {
            "byteLength": 4,
            "canonicalMediaType": "text/plain",
            "digest": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
            "mediaType": "text/plain",
            "name": "pre-release-safe.txt"
          }
        ],
        "dispatched": [
          {
            "byteLength": 4,
            "canonicalMediaType": "text/plain",
            "digest": "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
            "mediaType": "text/plain",
            "name": "pre-release-dispatched.txt"
          }
        ],
        "collisions": [
          {
            "byteLength": 4,
            "canonicalMediaType": "text/plain",
            "digest": "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
            "mediaType": "text/plain",
            "name": "collision-one.txt"
          },
          {
            "byteLength": 4,
            "canonicalMediaType": "text/plain",
            "digest": "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
            "mediaType": "text/plain",
            "name": "collision-two.txt"
          },
          {
            "byteLength": 4,
            "canonicalMediaType": "text/plain",
            "digest": "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
            "mediaType": "text/plain",
            "name": "same�name.txt"
          }
        ],
        "cancelled": [
          {
            "byteLength": 4,
            "canonicalMediaType": "text/plain",
            "digest": "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
            "mediaType": "text/plain",
            "name": "cancelled-v43.txt"
          }
        ]
      },
      "queues": {
        "pending": {
          "id": "queue_3bb2da8250c0467997839da049699bd3",
          "sessionId": "sess_f72df16539504fc9a3026b5133d55553",
          "message": "pre-release pending queue",
          "state": "pending",
          "createdAt": 43000,
          "updatedAt": 43000
        },
        "dispatched": {
          "id": "queue_2ffb6d4f1e784bc48c4987a4f6fb211e",
          "sessionId": "sess_f72df16539504fc9a3026b5133d55553",
          "message": "pre-release effect-crossed queue",
          "state": "dispatching",
          "createdAt": 43000,
          "updatedAt": 43000
        },
        "collisions": {
          "id": "queue_b465bb1e6ad346b8aa5793c887ff1d57",
          "sessionId": "sess_f72df16539504fc9a3026b5133d55553",
          "message": "preserve every colliding position",
          "state": "pending",
          "createdAt": 43000,
          "updatedAt": 43000
        },
        "cancelled": {
          "id": "queue_fc6d5e8948a0462b92ea63d5103f5101",
          "sessionId": "sess_f72df16539504fc9a3026b5133d55553",
          "message": "must be scrubbed after cancellation repair",
          "state": "pending",
          "createdAt": 43000,
          "updatedAt": 43000
        }
      },
      "budgetSession": {
        "id": "sess_972e05c23aee466ea11086320859a1fe",
        "profileId": "acct_157c3bfdb1674fc58f9c08ac2934fdf2",
        "providerThreadId": "canonical-budget-synthetic-budget",
        "title": "Canonical43 existing budget",
        "note": "",
        "provider": "codex",
        "preset": "high",
        "fastEnabled": false,
        "state": "idle",
        "revision": 1,
        "createdAt": 43000,
        "updatedAt": 43000
      },
      "limitedSession": {
        "id": "sess_eccc677de57d4abd86a9c54b26eacb05",
        "profileId": "acct_157c3bfdb1674fc58f9c08ac2934fdf2",
        "providerThreadId": "canonical-budget-synthetic-limited",
        "title": "Canonical43 already limited",
        "note": "",
        "provider": "codex",
        "preset": "high",
        "fastEnabled": false,
        "state": "idle",
        "revision": 1,
        "createdAt": 43000,
        "updatedAt": 43000
      },
      "historicalSourceId": "queue_53a11da282044438a917be807acf8203",
      "historicalEvent": {
        "version": 1,
        "sessionId": "sess_972e05c23aee466ea11086320859a1fe",
        "streamEpoch": "2af0533f-3b85-4875-9099-5d0da816bdfc",
        "sequence": 1,
        "recordedAt": 43000,
        "accountId": "acct_157c3bfdb1674fc58f9c08ac2934fdf2",
        "providerGeneration": 1,
        "providerConnectionId": null,
        "body": {
          "type": "user_message",
          "turnId": "opaque_v2_11aa079fd80af6ff536af67c09006b73fb753f32d673e49a924f9402adc34242",
          "sourceId": "queue_53a11da282044438a917be807acf8203",
          "actor": "human",
          "text": "Synthetic historical human continuation",
          "omittedCharacters": 0
        }
      },
      "runtimeRecords": [
        {
          "sessionId": "sess_f72df16539504fc9a3026b5133d55553",
          "revision": 1,
          "sourceKind": "session_start",
          "sourceId": "canonical43-budget-runtime-transcript",
          "profile": {
            "profileId": "acct_157c3bfdb1674fc58f9c08ac2934fdf2",
            "processGeneration": 1,
            "observedAt": 43000,
            "preset": "high",
            "model": "gpt-5.6-sol",
            "reasoningEffort": "max",
            "serviceTier": null,
            "fast": false,
            "approvalPolicy": "on-request",
            "reviewMode": "auto_review",
            "permissionProfile": ":workspace",
            "computerUse": true,
            "pluginCapability": true,
            "enabledApps": []
          },
          "recordedAt": 43000
        },
        {
          "sessionId": "sess_972e05c23aee466ea11086320859a1fe",
          "revision": 1,
          "sourceKind": "session_start",
          "sourceId": "canonical43-budget-runtime-budget",
          "profile": {
            "profileId": "acct_157c3bfdb1674fc58f9c08ac2934fdf2",
            "processGeneration": 1,
            "observedAt": 43000,
            "preset": "high",
            "model": "gpt-5.6-sol",
            "reasoningEffort": "max",
            "serviceTier": null,
            "fast": false,
            "approvalPolicy": "on-request",
            "reviewMode": "auto_review",
            "permissionProfile": ":workspace",
            "computerUse": true,
            "pluginCapability": true,
            "enabledApps": []
          },
          "recordedAt": 43000
        },
        {
          "sessionId": "sess_eccc677de57d4abd86a9c54b26eacb05",
          "revision": 1,
          "sourceKind": "session_start",
          "sourceId": "canonical43-budget-runtime-limited",
          "profile": {
            "profileId": "acct_157c3bfdb1674fc58f9c08ac2934fdf2",
            "processGeneration": 1,
            "observedAt": 43000,
            "preset": "high",
            "model": "gpt-5.6-sol",
            "reasoningEffort": "max",
            "serviceTier": null,
            "fast": false,
            "approvalPolicy": "on-request",
            "reviewMode": "auto_review",
            "permissionProfile": ":workspace",
            "computerUse": true,
            "pluginCapability": true,
            "enabledApps": []
          },
          "recordedAt": 43000
        }
      ]
    },
    "ledger": [
      {
        "version": 1,
        "applied_at": 43000
      },
      {
        "version": 10,
        "applied_at": 43000
      },
      {
        "version": 11,
        "applied_at": 43000
      },
      {
        "version": 12,
        "applied_at": 43000
      },
      {
        "version": 13,
        "applied_at": 43000
      },
      {
        "version": 14,
        "applied_at": 43000
      },
      {
        "version": 15,
        "applied_at": 43000
      },
      {
        "version": 16,
        "applied_at": 43000
      },
      {
        "version": 17,
        "applied_at": 43000
      },
      {
        "version": 18,
        "applied_at": 43000
      },
      {
        "version": 19,
        "applied_at": 43000
      },
      {
        "version": 2,
        "applied_at": 43000
      },
      {
        "version": 20,
        "applied_at": 43000
      },
      {
        "version": 21,
        "applied_at": 43000
      },
      {
        "version": 22,
        "applied_at": 43000
      },
      {
        "version": 23,
        "applied_at": 43000
      },
      {
        "version": 24,
        "applied_at": 43000
      },
      {
        "version": 25,
        "applied_at": 43000
      },
      {
        "version": 26,
        "applied_at": 43000
      },
      {
        "version": 27,
        "applied_at": 43000
      },
      {
        "version": 28,
        "applied_at": 43000
      },
      {
        "version": 29,
        "applied_at": 43000
      },
      {
        "version": 3,
        "applied_at": 43000
      },
      {
        "version": 30,
        "applied_at": 43000
      },
      {
        "version": 31,
        "applied_at": 43000
      },
      {
        "version": 32,
        "applied_at": 43000
      },
      {
        "version": 33,
        "applied_at": 43000
      },
      {
        "version": 34,
        "applied_at": 43000
      },
      {
        "version": 35,
        "applied_at": 43000
      },
      {
        "version": 36,
        "applied_at": 43000
      },
      {
        "version": 37,
        "applied_at": 43000
      },
      {
        "version": 38,
        "applied_at": 43000
      },
      {
        "version": 39,
        "applied_at": 43000
      },
      {
        "version": 4,
        "applied_at": 43000
      },
      {
        "version": 40,
        "applied_at": 43000
      },
      {
        "version": 41,
        "applied_at": 43000
      },
      {
        "version": 42,
        "applied_at": 43000
      },
      {
        "version": 43,
        "applied_at": 43000
      },
      {
        "version": 5,
        "applied_at": 43000
      },
      {
        "version": 6,
        "applied_at": 43000
      },
      {
        "version": 7,
        "applied_at": 43000
      },
      {
        "version": 8,
        "applied_at": 43000
      },
      {
        "version": 9,
        "applied_at": 43000
      }
    ],
    "schemaSha256": "db4c8c6f5b6c24b0aa3ded94a6aa2d84bf9c1239ea36b3d03cf930f010487e15",
    "allTableRowsSha256": "c7e2f06f1869a2fe71ae51841b55deeacbec24a0899b0f7a10f11c7fb40464b4",
    "rowCounts": {
      "account_rate_limit_reset_attempts": 0,
      "account_rate_limit_reset_policies": 1,
      "account_rate_limit_reset_rebinds": 0,
      "attachments": 4,
      "attention_email_policy": 1,
      "autorespond_evidence": 0,
      "autorespond_message_sources": 0,
      "daemon_state": 1,
      "desktop_switch_authority": 1,
      "desktop_switch_resolutions": 0,
      "desktop_switches": 0,
      "device_command_ledger": 0,
      "message_attachments": 6,
      "migrations": 43,
      "mutation_attempts": 5,
      "mutation_effect_evidence": 0,
      "mutation_resolutions": 0,
      "notification_hours": 1,
      "profile_personal_authority_revocations": 0,
      "profiles": 1,
      "project_approval_modes": 0,
      "projects": 0,
      "provider_interaction_transitions": 0,
      "provider_interactions": 0,
      "provider_login_authorities": 0,
      "provider_runtime_account_revocations": 0,
      "queue_effect_evidence": 0,
      "queue_effect_resolutions": 0,
      "queue_entries": 5,
      "queue_message_scrub_authority": 0,
      "queue_sequence_authority": 1,
      "security_scrub_authority": 0,
      "session_account_authorities": 3,
      "session_adoption_candidates": 0,
      "session_adoption_policies": 0,
      "session_adoption_profile_generation_permits": 0,
      "session_approval_modes": 0,
      "session_autorespond_counters": 1,
      "session_claude_process_authorities": 0,
      "session_claude_process_launch_intents": 0,
      "session_conversation_automation": 0,
      "session_event_streams": 3,
      "session_events": 1,
      "session_mutation_authority_rebinds": 0,
      "session_mutation_authority_rebinds_v39": 0,
      "session_personal_runtime_bindings": 0,
      "session_provider_account_authorities": 3,
      "session_provider_switch_seed_intents": 0,
      "session_provider_switch_seed_results": 0,
      "session_provider_switch_source_releases": 0,
      "session_provider_switch_target_releases": 0,
      "session_provider_switch_targets": 0,
      "session_runtime_profiles": 3,
      "session_show_thinking": 0,
      "session_start_attempts": 0,
      "session_states": 0,
      "session_task_occurrences": 0,
      "session_task_receipts": 0,
      "session_tasks": 0,
      "session_turn_runtime_profiles": 0,
      "sessions": 3,
      "sqlite_sequence": 1,
      "turn_summaries": 0,
      "usage_cloud_upload_anchors": 0,
      "usage_poll_failures": 0,
      "usage_revision_authority": 1,
      "usage_snapshots": 0,
      "work_attempt_reports": 0,
      "work_attempts": 0,
      "work_clock": 1,
      "work_effect_resolutions": 0,
      "work_events": 0,
      "work_idempotency_intents": 0,
      "work_members": 0,
      "work_nested_effect_settlements": 0,
      "work_prepared_effects": 0,
      "work_purge_authority": 0,
      "work_release_tombstones": 0,
      "work_reviews": 0,
      "work_routes": 0,
      "work_signal_receipts": 0,
      "work_signals": 0,
      "work_submissions": 0,
      "work_task_dependencies": 0,
      "work_task_history_index": 0,
      "work_task_history_versions": 0,
      "work_task_states": 0,
      "work_tasks": 0,
      "work_terminal_requests": 0,
      "works": 0
    }
  },
  "45": {
    "sourceCommit": "5c5c02ee5964167fb85e92da53cdb80c87991890",
    "sourceTree": "3f226e97912b667b67eea29a5f2ec66fe6f071da",
    "sourceManifestSha256": "60690e58c7b483eb3b249aaadeb877ea0a4677eb5b2e7360ac673ffed63da627",
    "sourceFileCount": 281,
    "sourceHashes": {
      "src/storage/state-store.ts": "97977822058e5adeaecdd9d455f9169f102e2a7c5e478d643e98fe492028b26a",
      "package.json": "a00f95f903852c2ba1b844b87a2061c083cfae4a29bc50262f5bbf64d17445ba",
      "bun.lock": "39bdff36e30b4af4dd4eecb060b23c742d2b0111b983d4a9d63b06cbc80a69ff"
    },
    "schemaVersion": 45,
    "generatorSha256": "fb09bd5025f5bda4090aeff1747dcebc133196528d1f6ad80efd2de1dd4fece8",
    "bunVersion": "1.3.14",
    "dependencies": {
      "@hraness/oh": "0.2.7",
      "@openai/codex": "0.153.2",
      "convex": "1.45.0",
      "effect": "3.22.1",
      "zod": "4.4.3"
    },
    "fixedTime": 90000000,
    "predecessorDatabaseSha256": "7ab3b21f2cafabb0e1494a20bae58c77e08e17a82423a337976651bee61a3322",
    "provenance": {
      "syntheticControlPlaneOnly": true,
      "archivedPublicApisOnly": true,
      "nativeProviderEffects": 0,
      "networkEffects": 0,
      "rawSqlRowOrSchemaWrites": false,
      "randomizedIdentifiers": true,
      "writableReopenUnchanged": true,
      "readonlyReopenUnchanged": true,
      "readonlyDatabaseHashUnchanged": true,
      "originalUnsafeNamesOrCancelledPendingRows": false,
      "currentMergedAdmissionClaim": false,
      "supplementalSyntheticRuntimeProfiles": true,
      "providerRuntimeObservationClaim": false
    },
    "databaseSha256": "a9bc642ef88af111b9a7d8dc358dc2819b6ca1cf710bffb9a186950316157dc0",
    "databaseBytes": 1458176,
    "checkpointResult": {
      "busy": 0,
      "log": 0,
      "checkpointed": 0
    },
    "retained": {
      "bootId": "boot_44444444444444444444444444444444",
      "daemonGeneration": 1,
      "profile": {
        "id": "acct_157c3bfdb1674fc58f9c08ac2934fdf2",
        "label": "Canonical budget synthetic account",
        "state": "signed_in",
        "processGeneration": 1,
        "providerEmail": "canonical-budget@example.com",
        "providerPlan": "Plus",
        "createdAt": 43000,
        "updatedAt": 43000
      },
      "session": {
        "id": "sess_f72df16539504fc9a3026b5133d55553",
        "profileId": "acct_157c3bfdb1674fc58f9c08ac2934fdf2",
        "providerThreadId": "canonical-budget-synthetic-transcript",
        "title": "Canonical43 transcript repair source",
        "note": "",
        "provider": "codex",
        "preset": "high",
        "fastEnabled": false,
        "state": "idle",
        "revision": 1,
        "createdAt": 43000,
        "updatedAt": 43000
      },
      "attachments": {
        "pending": [
          {
            "byteLength": 4,
            "canonicalMediaType": "text/plain",
            "digest": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
            "mediaType": "text/plain",
            "name": "pre-release-safe.txt"
          }
        ],
        "dispatched": [
          {
            "byteLength": 4,
            "canonicalMediaType": "text/plain",
            "digest": "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
            "mediaType": "text/plain",
            "name": "pre-release-dispatched.txt"
          }
        ],
        "collisions": [
          {
            "byteLength": 4,
            "canonicalMediaType": "text/plain",
            "digest": "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
            "mediaType": "text/plain",
            "name": "collision-one.txt"
          },
          {
            "byteLength": 4,
            "canonicalMediaType": "text/plain",
            "digest": "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
            "mediaType": "text/plain",
            "name": "collision-two.txt"
          },
          {
            "byteLength": 4,
            "canonicalMediaType": "text/plain",
            "digest": "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
            "mediaType": "text/plain",
            "name": "same�name.txt"
          }
        ],
        "cancelled": [
          {
            "byteLength": 4,
            "canonicalMediaType": "text/plain",
            "digest": "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
            "mediaType": "text/plain",
            "name": "cancelled-v43.txt"
          }
        ]
      },
      "queues": {
        "pending": {
          "id": "queue_3bb2da8250c0467997839da049699bd3",
          "sessionId": "sess_f72df16539504fc9a3026b5133d55553",
          "message": "pre-release pending queue",
          "state": "pending",
          "createdAt": 43000,
          "updatedAt": 43000
        },
        "dispatched": {
          "id": "queue_2ffb6d4f1e784bc48c4987a4f6fb211e",
          "sessionId": "sess_f72df16539504fc9a3026b5133d55553",
          "message": "pre-release effect-crossed queue",
          "state": "dispatching",
          "createdAt": 43000,
          "updatedAt": 43000
        },
        "collisions": {
          "id": "queue_b465bb1e6ad346b8aa5793c887ff1d57",
          "sessionId": "sess_f72df16539504fc9a3026b5133d55553",
          "message": "preserve every colliding position",
          "state": "pending",
          "createdAt": 43000,
          "updatedAt": 43000
        },
        "cancelled": {
          "id": "queue_fc6d5e8948a0462b92ea63d5103f5101",
          "sessionId": "sess_f72df16539504fc9a3026b5133d55553",
          "message": "must be scrubbed after cancellation repair",
          "state": "pending",
          "createdAt": 43000,
          "updatedAt": 43000
        }
      },
      "budgetSession": {
        "id": "sess_972e05c23aee466ea11086320859a1fe",
        "profileId": "acct_157c3bfdb1674fc58f9c08ac2934fdf2",
        "providerThreadId": "canonical-budget-synthetic-budget",
        "title": "Canonical43 existing budget",
        "note": "",
        "provider": "codex",
        "preset": "high",
        "fastEnabled": false,
        "state": "idle",
        "revision": 1,
        "createdAt": 43000,
        "updatedAt": 43000
      },
      "limitedSession": {
        "id": "sess_eccc677de57d4abd86a9c54b26eacb05",
        "profileId": "acct_157c3bfdb1674fc58f9c08ac2934fdf2",
        "providerThreadId": "canonical-budget-synthetic-limited",
        "title": "Canonical43 already limited",
        "note": "",
        "provider": "codex",
        "preset": "high",
        "fastEnabled": false,
        "state": "idle",
        "revision": 1,
        "createdAt": 43000,
        "updatedAt": 43000
      },
      "historicalSourceId": "queue_53a11da282044438a917be807acf8203",
      "historicalEvent": {
        "version": 1,
        "sessionId": "sess_972e05c23aee466ea11086320859a1fe",
        "streamEpoch": "2af0533f-3b85-4875-9099-5d0da816bdfc",
        "sequence": 1,
        "recordedAt": 43000,
        "accountId": "acct_157c3bfdb1674fc58f9c08ac2934fdf2",
        "providerGeneration": 1,
        "providerConnectionId": null,
        "body": {
          "type": "user_message",
          "turnId": "opaque_v2_11aa079fd80af6ff536af67c09006b73fb753f32d673e49a924f9402adc34242",
          "sourceId": "queue_53a11da282044438a917be807acf8203",
          "actor": "human",
          "text": "Synthetic historical human continuation",
          "omittedCharacters": 0
        }
      },
      "runtimeRecords": [
        {
          "sessionId": "sess_f72df16539504fc9a3026b5133d55553",
          "revision": 1,
          "sourceKind": "session_start",
          "sourceId": "canonical43-budget-runtime-transcript",
          "profile": {
            "profileId": "acct_157c3bfdb1674fc58f9c08ac2934fdf2",
            "processGeneration": 1,
            "observedAt": 43000,
            "preset": "high",
            "model": "gpt-5.6-sol",
            "reasoningEffort": "max",
            "serviceTier": null,
            "fast": false,
            "approvalPolicy": "on-request",
            "reviewMode": "auto_review",
            "permissionProfile": ":workspace",
            "computerUse": true,
            "pluginCapability": true,
            "enabledApps": []
          },
          "recordedAt": 43000
        },
        {
          "sessionId": "sess_972e05c23aee466ea11086320859a1fe",
          "revision": 1,
          "sourceKind": "session_start",
          "sourceId": "canonical43-budget-runtime-budget",
          "profile": {
            "profileId": "acct_157c3bfdb1674fc58f9c08ac2934fdf2",
            "processGeneration": 1,
            "observedAt": 43000,
            "preset": "high",
            "model": "gpt-5.6-sol",
            "reasoningEffort": "max",
            "serviceTier": null,
            "fast": false,
            "approvalPolicy": "on-request",
            "reviewMode": "auto_review",
            "permissionProfile": ":workspace",
            "computerUse": true,
            "pluginCapability": true,
            "enabledApps": []
          },
          "recordedAt": 43000
        },
        {
          "sessionId": "sess_eccc677de57d4abd86a9c54b26eacb05",
          "revision": 1,
          "sourceKind": "session_start",
          "sourceId": "canonical43-budget-runtime-limited",
          "profile": {
            "profileId": "acct_157c3bfdb1674fc58f9c08ac2934fdf2",
            "processGeneration": 1,
            "observedAt": 43000,
            "preset": "high",
            "model": "gpt-5.6-sol",
            "reasoningEffort": "max",
            "serviceTier": null,
            "fast": false,
            "approvalPolicy": "on-request",
            "reviewMode": "auto_review",
            "permissionProfile": ":workspace",
            "computerUse": true,
            "pluginCapability": true,
            "enabledApps": []
          },
          "recordedAt": 43000
        }
      ],
      "freshSession": {
        "id": "sess_56112e5769b64045a5924951507fbb6c",
        "profileId": "acct_157c3bfdb1674fc58f9c08ac2934fdf2",
        "providerThreadId": "canonical-budget-synthetic-fresh45",
        "title": "Canonical45 fresh budget",
        "note": "",
        "provider": "codex",
        "preset": "high",
        "fastEnabled": false,
        "state": "idle",
        "revision": 1,
        "createdAt": 90000000,
        "updatedAt": 90000000
      },
      "freshRuntimeRecord": {
        "sessionId": "sess_56112e5769b64045a5924951507fbb6c",
        "revision": 1,
        "sourceKind": "session_start",
        "sourceId": "canonical45-budget-runtime-fresh",
        "profile": {
          "profileId": "acct_157c3bfdb1674fc58f9c08ac2934fdf2",
          "processGeneration": 1,
          "observedAt": 90000000,
          "preset": "high",
          "model": "gpt-5.6-sol",
          "reasoningEffort": "max",
          "serviceTier": null,
          "fast": false,
          "approvalPolicy": "on-request",
          "reviewMode": "auto_review",
          "permissionProfile": ":workspace",
          "computerUse": true,
          "pluginCapability": true,
          "enabledApps": []
        },
        "recordedAt": 90000000
      },
      "reservationSourceId": "45000000-0000-4000-8000-000000000001",
      "legacyAvailableAt": 86445000
    },
    "ledger": [
      {
        "version": 1,
        "applied_at": 43000
      },
      {
        "version": 10,
        "applied_at": 43000
      },
      {
        "version": 11,
        "applied_at": 43000
      },
      {
        "version": 12,
        "applied_at": 43000
      },
      {
        "version": 13,
        "applied_at": 43000
      },
      {
        "version": 14,
        "applied_at": 43000
      },
      {
        "version": 15,
        "applied_at": 43000
      },
      {
        "version": 16,
        "applied_at": 43000
      },
      {
        "version": 17,
        "applied_at": 43000
      },
      {
        "version": 18,
        "applied_at": 43000
      },
      {
        "version": 19,
        "applied_at": 43000
      },
      {
        "version": 2,
        "applied_at": 43000
      },
      {
        "version": 20,
        "applied_at": 43000
      },
      {
        "version": 21,
        "applied_at": 43000
      },
      {
        "version": 22,
        "applied_at": 43000
      },
      {
        "version": 23,
        "applied_at": 43000
      },
      {
        "version": 24,
        "applied_at": 43000
      },
      {
        "version": 25,
        "applied_at": 43000
      },
      {
        "version": 26,
        "applied_at": 43000
      },
      {
        "version": 27,
        "applied_at": 43000
      },
      {
        "version": 28,
        "applied_at": 43000
      },
      {
        "version": 29,
        "applied_at": 43000
      },
      {
        "version": 3,
        "applied_at": 43000
      },
      {
        "version": 30,
        "applied_at": 43000
      },
      {
        "version": 31,
        "applied_at": 43000
      },
      {
        "version": 32,
        "applied_at": 43000
      },
      {
        "version": 33,
        "applied_at": 43000
      },
      {
        "version": 34,
        "applied_at": 43000
      },
      {
        "version": 35,
        "applied_at": 43000
      },
      {
        "version": 36,
        "applied_at": 43000
      },
      {
        "version": 37,
        "applied_at": 43000
      },
      {
        "version": 38,
        "applied_at": 43000
      },
      {
        "version": 39,
        "applied_at": 43000
      },
      {
        "version": 4,
        "applied_at": 43000
      },
      {
        "version": 40,
        "applied_at": 43000
      },
      {
        "version": 41,
        "applied_at": 43000
      },
      {
        "version": 42,
        "applied_at": 43000
      },
      {
        "version": 43,
        "applied_at": 43000
      },
      {
        "version": 44,
        "applied_at": 45000
      },
      {
        "version": 45,
        "applied_at": 45000
      },
      {
        "version": 5,
        "applied_at": 43000
      },
      {
        "version": 6,
        "applied_at": 43000
      },
      {
        "version": 7,
        "applied_at": 43000
      },
      {
        "version": 8,
        "applied_at": 43000
      },
      {
        "version": 9,
        "applied_at": 43000
      }
    ],
    "schemaSha256": "f3cd49d9332c6e28e1441e67ac599647282f8f579f2c5bb5b1913b7307817d1f",
    "allTableRowsSha256": "34c9b7d03dc74e8c2d8b49459e13d16c415bd43904c4929ba2eb0d8b056faf3f",
    "rowCounts": {
      "account_mutation_authority_rebinds": 0,
      "account_rate_limit_reset_attempts": 0,
      "account_rate_limit_reset_policies": 1,
      "account_rate_limit_reset_rebinds": 0,
      "attachments": 4,
      "attention_email_policy": 1,
      "autorespond_budget_history": 4,
      "autorespond_budget_reservations": 1,
      "autorespond_evidence": 0,
      "autorespond_message_sources": 0,
      "daemon_state": 1,
      "desktop_switch_authority": 1,
      "desktop_switch_resolutions": 0,
      "desktop_switches": 0,
      "device_command_ledger": 0,
      "message_attachments": 6,
      "migrations": 45,
      "mutation_attempts": 5,
      "mutation_effect_evidence": 0,
      "mutation_resolutions": 0,
      "notification_hours": 1,
      "profile_personal_authority_revocations": 0,
      "profiles": 1,
      "project_approval_modes": 0,
      "projects": 0,
      "provider_interaction_transitions": 1,
      "provider_interactions": 1,
      "provider_login_authorities": 0,
      "provider_runtime_account_revocations": 0,
      "queue_effect_evidence": 0,
      "queue_effect_resolutions": 0,
      "queue_entries": 5,
      "queue_message_scrub_authority": 0,
      "queue_sequence_authority": 1,
      "security_scrub_authority": 0,
      "session_account_authorities": 4,
      "session_adoption_candidates": 0,
      "session_adoption_policies": 0,
      "session_adoption_profile_generation_permits": 0,
      "session_approval_modes": 0,
      "session_autorespond_counters": 4,
      "session_claude_process_authorities": 0,
      "session_claude_process_launch_intents": 0,
      "session_conversation_automation": 0,
      "session_event_streams": 4,
      "session_events": 1,
      "session_mutation_authority_rebinds": 0,
      "session_mutation_authority_rebinds_v39": 0,
      "session_personal_runtime_bindings": 0,
      "session_provider_account_authorities": 4,
      "session_provider_switch_seed_intents": 0,
      "session_provider_switch_seed_results": 0,
      "session_provider_switch_source_releases": 0,
      "session_provider_switch_target_releases": 0,
      "session_provider_switch_targets": 0,
      "session_runtime_profiles": 4,
      "session_show_thinking": 0,
      "session_start_attempts": 0,
      "session_states": 0,
      "session_task_occurrences": 0,
      "session_task_receipts": 0,
      "session_tasks": 0,
      "session_turn_runtime_profiles": 0,
      "sessions": 4,
      "sqlite_sequence": 1,
      "turn_summaries": 0,
      "usage_cloud_upload_anchors": 0,
      "usage_poll_failures": 0,
      "usage_revision_authority": 1,
      "usage_snapshots": 0,
      "work_attempt_reports": 0,
      "work_attempts": 0,
      "work_clock": 1,
      "work_effect_resolutions": 0,
      "work_events": 0,
      "work_idempotency_intents": 0,
      "work_members": 0,
      "work_nested_effect_settlements": 0,
      "work_prepared_effects": 0,
      "work_purge_authority": 0,
      "work_release_tombstones": 0,
      "work_reviews": 0,
      "work_routes": 0,
      "work_signal_receipts": 0,
      "work_signals": 0,
      "work_submissions": 0,
      "work_task_dependencies": 0,
      "work_task_history_index": 0,
      "work_task_history_versions": 0,
      "work_task_states": 0,
      "work_tasks": 0,
      "work_terminal_requests": 0,
      "works": 0
    }
  }
} as const;

export const canonicalBudgetRuntimeGeneratorSource = "import assert from \"node:assert/strict\";\nimport { createHash } from \"node:crypto\";\nimport { existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from \"node:fs\";\nimport { mkdir } from \"node:fs/promises\";\nimport { join, relative } from \"node:path\";\nimport { gzipSync } from \"node:zlib\";\nimport { Database } from \"bun:sqlite\";\n\nconst root = import.meta.dir;\nconst output = join(root, \"capture-runtime2\");\n// Supplemental archived-API capture only. Keep the already-reviewed capture1\n// originals byte-identical; never open them through either archived writer.\nconst originalCaptures = {\n  43: \"b541c3d22359e4c02b8c499b23b13e9f9e39c0f12d830e29f9f1ed58ef841f82\",\n  45: \"532c3c694567528f215f445b7f30fe8ddd90cee399b4b1cdbbc1df28c0ecfea4\",\n} as const;\nconst hash = (value: string | Uint8Array) => createHash(\"sha256\").update(value).digest(\"hex\");\nassert.equal(Bun.version, \"1.3.14\");\nassert.equal(lstatSync(root).mode & 0o777, 0o700);\nassert.equal(existsSync(output), false, \"Never overwrite an archived capture.\");\nfor (const version of [43, 45] as const) {\n  assert.equal(hash(readFileSync(join(root, \"capture1\", `canonical${version}`, \"state/control-plane.sqlite\"))), originalCaptures[version]);\n}\nconst definitions = {\n  43: { sourceCommit: \"97cebc44ecd2d27b8c0b6399b0814b1993d94fc1\", sourceTree: \"afb3340a1ed83b7735538aad955ad00d178dc116\",\n    sourceManifestSha256: \"3b4554cd03441e9bc2352d933d3f1718393d93a21ed3141561fc5fe1a1334b0e\", sourceFileCount: 278,\n    sourceHashes: { \"src/storage/state-store.ts\": \"cfe045e01bd47585a45596b9e163f5562e25aa800bdd82f4fc1df0155eb55e31\",\n      \"package.json\": \"417a70d8cd6287b45f53e667603903a86388d9f186266326f1197a94b3202088\",\n      \"bun.lock\": \"db7ab88639f59ec431129416a31bb4de4ef4098d21c065d0be40d272019e46b5\" } },\n  45: { sourceCommit: \"5c5c02ee5964167fb85e92da53cdb80c87991890\", sourceTree: \"3f226e97912b667b67eea29a5f2ec66fe6f071da\",\n    sourceManifestSha256: \"60690e58c7b483eb3b249aaadeb877ea0a4677eb5b2e7360ac673ffed63da627\", sourceFileCount: 281,\n    sourceHashes: { \"src/storage/state-store.ts\": \"97977822058e5adeaecdd9d455f9169f102e2a7c5e478d643e98fe492028b26a\",\n      \"package.json\": \"a00f95f903852c2ba1b844b87a2061c083cfae4a29bc50262f5bbf64d17445ba\",\n      \"bun.lock\": \"39bdff36e30b4af4dd4eecb060b23c742d2b0111b983d4a9d63b06cbc80a69ff\" } },\n} as const;\nconst dependencies = { \"@hraness/oh\": \"0.2.7\", \"@openai/codex\": \"0.153.2\", convex: \"1.45.0\", effect: \"3.22.1\", zod: \"4.4.3\" };\nconst snapshot = (path: string) => {\n  const db = new Database(path, { create: false, strict: true });\n  db.exec(\"PRAGMA query_only=ON\");\n  try {\n    const schema = db.query(\"SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name\").all();\n    const tables = db.query(\"SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name\").all() as { name: string }[];\n    assert.ok(tables.length <= 256);\n    const rows: Record<string, unknown[]> = {};\n    for (const { name } of tables) {\n      assert.match(name, /^[a-zA-Z0-9_]+$/);\n      rows[name] = db.query(`SELECT * FROM \"${name}\"`).all().sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));\n      assert.ok(rows[name].length <= 4096);\n    }\n    const result = { userVersion: db.query(\"PRAGMA user_version\").get(), schema, rows,\n      foreignKeyCheck: db.query(\"PRAGMA foreign_key_check\").all(), inspectionChanges: db.query(\"SELECT total_changes() AS count\").get() };\n    assert.deepEqual(result.foreignKeyCheck, []);\n    assert.deepEqual(result.inspectionChanges, { count: 0 });\n    assert.ok(Buffer.byteLength(JSON.stringify(result)) < 8 * 1024 * 1024);\n    return result;\n  } finally { db.close(false); }\n};\nawait mkdir(output, { mode: 0o700 });\nconst generatorSource = readFileSync(import.meta.path, \"utf8\");\nlet original43: Uint8Array | undefined;\nlet retained43: Record<string, unknown> | undefined;\nconst summaries = [];\nfor (const version of [43, 45] as const) {\n  const sourceRoot = join(root, `canonical${version}`);\n  const definition = definitions[version];\n  for (const [path, expected] of Object.entries(definition.sourceHashes)) assert.equal(hash(readFileSync(join(sourceRoot, path))), expected);\n  for (const [name, expected] of Object.entries(dependencies)) assert.equal(JSON.parse(readFileSync(join(sourceRoot, \"node_modules\", name, \"package.json\"), \"utf8\")).version, expected);\n  const sourceFiles: { path: string; sha256: string }[] = [];\n  function visit(directory: string) {\n    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {\n      const path = join(directory, entry.name);\n      if (entry.isDirectory()) visit(path);\n      else if (entry.isFile()) sourceFiles.push({ path: relative(sourceRoot, path), sha256: hash(readFileSync(path)) });\n      else throw new Error(\"Unexpected archived source entry.\");\n    }\n  }\n  visit(join(sourceRoot, \"src\"));\n  assert.equal(sourceFiles.length, definition.sourceFileCount);\n  assert.equal(hash(JSON.stringify(sourceFiles)), definition.sourceManifestSha256);\n  const { StateStore } = await import(`./canonical${version}/src/storage/state-store`);\n  const { initializeStatePaths, resolveStatePaths } = await import(`./canonical${version}/src/storage/paths`);\n  const directory = join(output, `canonical${version}`);\n  await mkdir(directory, { mode: 0o700 });\n  const paths = resolveStatePaths({ rootDirectory: join(directory, \"state\") });\n  await initializeStatePaths(paths);\n  if (version === 45) {\n    assert.ok(original43);\n    writeFileSync(paths.database, original43, { mode: 0o600, flag: \"wx\" });\n    assert.deepEqual(snapshot(paths.database).userVersion, { user_version: 43 });\n  }\n  const clock = { now: version * 1000 };\n  const store = new StateStore(paths, { now: () => clock.now });\n  const sessionInput = (profileId: string, title: string, suffix: string) => ({ profileId, provider: \"codex\" as const,\n    providerThreadId: `canonical-budget-synthetic-${suffix}`, providerAccountKey: \"v1:codex:\" + hash(\"canonical-budget@example.com\"),\n    title, preset: \"high\" as const, fastEnabled: false, state: \"idle\" as const });\n  const recordRuntime = (session: { id: string; profileId: string }, sourceId: string) => {\n    const profile = store.requireProfile(session.profileId);\n    // Resolve the stored session contract through this exact archived writer.\n    // Canonical43/45 High selects contract1 (Sol), not its Astra alternative.\n    const binding = store.requireSessionPresetRequirement(session.id);\n    assert.equal(binding.preset, \"high\");\n    assert.deepEqual(binding.requirement, { model: \"gpt-5.6-sol\", effort: \"max\" });\n    return store.recordSessionRuntimeProfile({ sessionId: session.id, sourceKind: \"session_start\", sourceId,\n      profile: { profileId: profile.id, processGeneration: profile.processGeneration, observedAt: clock.now,\n        preset: binding.preset, model: binding.requirement.model, reasoningEffort: binding.requirement.effort, serviceTier: null, fast: false,\n        approvalPolicy: \"on-request\", reviewMode: \"auto_review\", permissionProfile: \":workspace\",\n        computerUse: true, pluginCapability: true, enabledApps: [] } });\n  };\n  let retained: Record<string, unknown>;\n  if (version === 43) {\n    // Initialize synthetic daemon custody before all profile/session/runtime\n    // rows. Reopening the capture must not retire their original generation.\n    const bootId = \"boot_\" + \"4\".repeat(32);\n    const daemonGeneration = store.nextDaemonGeneration(bootId);\n    assert.equal(daemonGeneration, 1);\n    const created = store.createProfile(\"Canonical budget synthetic account\");\n    const advanced = store.nextProfileGeneration(created.id);\n    assert.equal(store.setProfileState(advanced.id, advanced.processGeneration, \"signed_in\", { email: \"canonical-budget@example.com\", plan: \"Plus\" }), true);\n    const profile = store.requireProfile(advanced.id);\n    assert.equal(store.allocateNextUsageRevision(profile.id), 1);\n    const session = store.upsertProviderSession(sessionInput(profile.id, \"Canonical43 transcript repair source\", \"transcript\"));\n    const attachments = {\n      pending: [{ byteLength: 4, canonicalMediaType: \"text/plain\", digest: \"c\".repeat(64), mediaType: \"text/plain\", name: \"pre-release-safe.txt\" }],\n      dispatched: [{ byteLength: 4, canonicalMediaType: \"text/plain\", digest: \"d\".repeat(64), mediaType: \"text/plain\", name: \"pre-release-dispatched.txt\" }],\n      collisions: [\"collision-one.txt\", \"collision-two.txt\", \"same�name.txt\"].map(name => ({ byteLength: 4, canonicalMediaType: \"text/plain\", digest: \"f\".repeat(64), mediaType: \"text/plain\", name })),\n      cancelled: [{ byteLength: 4, canonicalMediaType: \"text/plain\", digest: \"e\".repeat(64), mediaType: \"text/plain\", name: \"cancelled-v43.txt\" }],\n    };\n    const queues: Record<string, unknown> = {};\n    for (const [index, [kind, storedAttachments]] of Object.entries(attachments).entries()) {\n      const messages = { pending: \"pre-release pending queue\", dispatched: \"pre-release effect-crossed queue\", collisions: \"preserve every colliding position\", cancelled: \"must be scrubbed after cancellation repair\" };\n      const queue = store.enqueueIdempotent({ sessionId: session.id, profileGeneration: profile.processGeneration,\n        idempotencyKey: `43000000-0000-4000-8000-${String(index + 10).padStart(12, \"0\")}`, message: messages[kind as keyof typeof messages],\n        attachments: storedAttachments.map(({ canonicalMediaType: _canonical, ...ref }) => ref), storedAttachments });\n      if (kind === \"dispatched\") assert.equal(store.transitionQueue(queue.id, \"pending\", \"dispatching\"), true);\n      queues[kind] = store.requireQueue(queue.id);\n    }\n    const budgetSession = store.upsertProviderSession(sessionInput(profile.id, \"Canonical43 existing budget\", \"budget\"));\n    const limitedSession = store.upsertProviderSession(sessionInput(profile.id, \"Canonical43 already limited\", \"limited\"));\n    // Storage-contract fixtures report synthetic reviewed profiles through the\n    // exact archived API. This is not a claim that a provider process ran.\n    const runtimeRecords = [\n      recordRuntime(session, \"canonical43-budget-runtime-transcript\"),\n      recordRuntime(budgetSession, \"canonical43-budget-runtime-budget\"),\n      recordRuntime(limitedSession, \"canonical43-budget-runtime-limited\"),\n    ];\n    for (const record of runtimeRecords) assert.equal(record.revision, 1);\n    for (let i = 0; i < 4; i++) store.bumpAutorespondCounter(limitedSession.id);\n    const historical = store.enqueueIdempotent({ sessionId: budgetSession.id, profileGeneration: profile.processGeneration,\n      message: \"Synthetic historical human continuation\", actor: \"human\", idempotencyKey: \"43000000-0000-4000-8000-000000000099\" });\n    assert.equal(store.transitionQueue(historical.id, \"pending\", \"dispatching\"), true);\n    assert.equal(store.transitionQueue(historical.id, \"dispatching\", \"applied\"), true);\n    const historicalEvent = store.finalizeSessionUserMessageSource({ sessionId: budgetSession.id, sourceKind: \"queue\", sourceId: historical.id, turnId: \"synthetic-turn\" });\n    assert.equal(historicalEvent?.body.type, \"user_message\");\n    retained = { bootId, daemonGeneration, profile, session, attachments, queues, budgetSession, limitedSession, historicalSourceId: historical.id, historicalEvent, runtimeRecords };\n    retained43 = retained;\n  } else {\n    assert.ok(retained43);\n    const budgetSession = retained43.budgetSession as { id: string; profileId: string };\n    assert.equal(store.readAutorespondBudgets(budgetSession.id).consecutive, 3);\n    assert.equal(store.readAutorespondBudgetHistoryAvailableAt(budgetSession.id), 86_445_000);\n    clock.now = 90_000_000;\n    assert.equal(store.readAutorespondBudgetHistoryAvailableAt(budgetSession.id), null);\n    store.resetAutorespondCounter(budgetSession.id);\n    const freshSession = store.upsertProviderSession(sessionInput(budgetSession.profileId, \"Canonical45 fresh budget\", \"fresh45\"));\n    const freshRuntimeRecord = recordRuntime(freshSession, \"canonical45-budget-runtime-fresh\");\n    assert.equal(freshRuntimeRecord.revision, 1);\n    const publicId = \"45000000-0000-4000-8000-000000000001\";\n    store.admitInteraction({ publicId, sessionId: freshSession.id,\n      authority: { profileId: freshSession.profileId, processGeneration: 1, connectionId: \"45000000-0000-4000-8000-999999999999\",\n        requestId: { type: \"string\", value: publicId }, method: \"item/commandExecution/requestApproval\", requestDigest: \"a\".repeat(64),\n        threadId: freshSession.providerThreadId, turnId: null, itemId: null, approvalId: null },\n      kind: \"command_approval\", blocking: true, display: { kind: \"command_approval\", summary: \"Review synthetic command\", reason: null,\n        commandClass: \"test\", workingDirectory: null, availableDecisions: [\"once\", \"decline\", \"cancel\"] } });\n    assert.deepEqual(store.reserveAutorespondBudget({ sessionId: freshSession.id, sourceId: publicId, sourceKind: \"protocol\", expectedMode: \"auto:all\" }), { state: \"reserved\" });\n    assert.deepEqual(store.readAutorespondBudgets(freshSession.id), { consecutive: 1, lastHour: 1, lastDay: 1 });\n    retained = { ...retained43, freshSession, freshRuntimeRecord, reservationSourceId: publicId, legacyAvailableAt: 86_445_000 };\n  }\n  const finalSnapshot = snapshot(paths.database);\n  assert.deepEqual(finalSnapshot.userVersion, { user_version: version });\n  assert.equal(finalSnapshot.rows.session_runtime_profiles.length, version === 43 ? 3 : 4);\n  assert.equal(finalSnapshot.rows.session_turn_runtime_profiles.length, 0);\n  for (const row of finalSnapshot.rows.session_runtime_profiles as { source_kind: string; source_id: string }[]) {\n    assert.equal(row.source_kind, \"session_start\");\n    assert.match(row.source_id, /^canonical4[35]-budget-runtime-(transcript|budget|limited|fresh)$/);\n  }\n  store.close();\n  const reopened = new StateStore(paths, { now: () => clock.now });\n  assert.deepEqual(snapshot(paths.database), finalSnapshot);\n  reopened.close();\n  const checkpoint = new Database(paths.database, { create: false, strict: true });\n  const checkpointResult = checkpoint.query(\"PRAGMA wal_checkpoint(TRUNCATE)\").get();\n  checkpoint.close(false);\n  assert.equal((checkpointResult as { busy: number }).busy, 0);\n  const beforeReadonly = hash(readFileSync(paths.database));\n  const readonly = new StateStore(paths, { readonly: true });\n  assert.deepEqual(snapshot(paths.database), finalSnapshot);\n  readonly.close();\n  const bytes = readFileSync(paths.database);\n  assert.equal(hash(bytes), beforeReadonly);\n  assert.ok(bytes.byteLength < 4 * 1024 * 1024, \"Bound the supplemental database.\");\n  const metadata = { ...definition, schemaVersion: version, sourceManifestSha256: hash(JSON.stringify(sourceFiles)), sourceFileCount: sourceFiles.length,\n    generatorSha256: hash(generatorSource), bunVersion: Bun.version, dependencies, fixedTime: clock.now,\n    predecessorDatabaseSha256: version === 45 ? hash(original43!) : null,\n    provenance: { syntheticControlPlaneOnly: true, archivedPublicApisOnly: true, nativeProviderEffects: 0, networkEffects: 0,\n      rawSqlRowOrSchemaWrites: false, randomizedIdentifiers: true, writableReopenUnchanged: true, readonlyReopenUnchanged: true,\n      readonlyDatabaseHashUnchanged: true, originalUnsafeNamesOrCancelledPendingRows: false, currentMergedAdmissionClaim: false,\n      supplementalSyntheticRuntimeProfiles: true, providerRuntimeObservationClaim: false },\n    databaseSha256: hash(bytes), databaseBytes: bytes.length, checkpointResult, retained, snapshot: finalSnapshot };\n  const text = JSON.stringify(metadata);\n  for (const forbidden of [root, \"/Users/\", \"/private/\", \"/tmp/\", \"/home/\", \"/Volumes/\"]) {\n    assert.equal(text.includes(forbidden), false); assert.equal(bytes.includes(Buffer.from(forbidden)), false);\n  }\n  writeFileSync(join(directory, \"state.sqlite.gz\"), gzipSync(bytes), { mode: 0o600, flag: \"wx\" });\n  writeFileSync(join(directory, \"fixture.json\"), JSON.stringify(metadata, null, 2) + \"\\n\", { mode: 0o600, flag: \"wx\" });\n  writeFileSync(join(directory, \"source-manifest.json\"), JSON.stringify(sourceFiles, null, 2) + \"\\n\", { mode: 0o600, flag: \"wx\" });\n  if (version === 43) original43 = Uint8Array.from(bytes);\n  for (const [path, expected] of Object.entries(definition.sourceHashes)) assert.equal(hash(readFileSync(join(sourceRoot, path))), expected);\n  summaries.push({ version, sourceCommit: definition.sourceCommit, databaseSha256: hash(bytes), databaseBytes: bytes.length,\n    sourceManifestSha256: metadata.sourceManifestSha256, sourceFileCount: sourceFiles.length,\n    sessions: finalSnapshot.rows.sessions.length, queues: finalSnapshot.rows.queue_entries.length, archivedReopensUnchanged: true });\n}\nfor (const version of [43, 45] as const) {\n  assert.equal(hash(readFileSync(join(root, \"capture1\", `canonical${version}`, \"state/control-plane.sqlite\"))), originalCaptures[version]);\n}\nconsole.log(JSON.stringify({ generatorSha256: hash(generatorSource), summaries, originalCapturesUnchanged: true }));\n\n";

const compressedImages = "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";

export function canonicalBudgetRuntimeDatabaseBytes(version: 43 | 45): Uint8Array {
  const expectedBytes = canonicalBudgetRuntimeFixtures[43].databaseBytes + canonicalBudgetRuntimeFixtures[45].databaseBytes;
  const images = gunzipSync(Buffer.from(compressedImages, "base64"), { maxOutputLength: expectedBytes });
  if (images.byteLength !== expectedBytes) throw new Error("Canonical budget runtime fixture size mismatch.");
  if ([43, 45].some(version => createHash("sha256").update(canonicalBudgetRuntimeGeneratorSource).digest("hex")
    !== canonicalBudgetRuntimeFixtures[version as 43 | 45].generatorSha256)) {
    throw new Error("Canonical budget runtime fixture generator mismatch.");
  }
  let offset = 0;
  let selected: Uint8Array | undefined;
  for (const candidate of [43, 45] as const) {
    const fixture = canonicalBudgetRuntimeFixtures[candidate];
    const bytes = images.subarray(offset, offset + fixture.databaseBytes);
    if (createHash("sha256").update(bytes).digest("hex") !== fixture.databaseSha256) {
      throw new Error("Canonical budget fixture integrity mismatch.");
    }
    if (candidate === version) selected = Uint8Array.from(bytes);
    offset += fixture.databaseBytes;
  }
  if (offset !== images.length || selected === undefined) throw new Error("Canonical budget fixture framing mismatch.");
  return selected;
}
