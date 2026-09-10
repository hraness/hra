import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";

// Exact archived44/45/46 public-API outputs, beginning with the already
// retained canonical43 runtime capture. Actual44 migration creates the old
// budget hold; actual45 APIs create a pending-login cancellation successor;
// actual46 migration and its public CAS establish after-hours policy.
// Synthetic reviewed runtime profiles are storage-contract inputs, not
// provider observations. No provider/native/network effects or raw SQL row,
// schema, or version writes occurred. Original captures remain unchanged.
// Reproduce with each sourceCommit's src/package.json/bun.lock and the pinned
// dependencies, inputs/canonical43.sqlite from canonical-budget-runtime,
// inputs/canonical43.json from the retained metadata export below, and the
// retained generator under the reviewed host scheduler. Its capture2 output
// must not already exist; randomized IDs make a rerun a new capture.
export const canonicalAuthBudgetFixtures = {
  "44": {
    "sourceCommit": "a75e7487594ce5b68345ccd3536974a10f7a93ee",
    "sourceTree": "b9025a56a9db70a194284ff81570e08e7994eb46",
    "sourceManifestSha256": "854c9d8d77a6a24a650702e914724db771c170aff3057537b37f06d31ee91689",
    "sourceFileCount": 279,
    "sourceHashes": {
      "src/storage/state-store.ts": "40e7a3a6c868f626b73fb6eb8a47b3c0080e03a394166a394dc48aaf7659e94d",
      "package.json": "0b5b1b9ba0e3f6524d4b2320ebb188978653235a6bf44cad6dd7e8365023f784",
      "bun.lock": "17a71da0d346e20153c61e3d54bd7db8eb16b6f21f2d93340f6fc88c15fc678e"
    },
    "schemaVersion": 44,
    "generatorSha256": "d5128066b55682139960b92ffe7b45cd3b446e133301ef00fba6273aae9a35d1",
    "bunVersion": "1.3.14",
    "dependencies": {
      "@hraness/oh": "0.2.7",
      "@openai/codex": "0.153.2",
      "convex": "1.45.0",
      "effect": "3.22.1",
      "zod": "4.4.3"
    },
    "predecessorSchemaVersion": 43,
    "predecessorDatabaseSha256": "7ab3b21f2cafabb0e1494a20bae58c77e08e17a82423a337976651bee61a3322",
    "fixedTime": 44000,
    "provenance": {
      "syntheticControlPlaneOnly": true,
      "archivedPublicApisOnly": true,
      "nativeProviderEffects": 0,
      "networkEffects": 0,
      "rawSqlRowOrSchemaWrites": false,
      "randomizedIdentifiers": true,
      "reservedUsageRevisionForEveryNewProfile": true,
      "writableReopenUnchanged": true,
      "readonlyReopenUnchanged": true,
      "readonlyDatabaseHashUnchanged": true,
      "supplementalSyntheticRuntimeProfiles": true,
      "providerRuntimeObservationClaim": false,
      "currentMergedAdmissionClaim": false,
      "inheritedCanonical43BytesPreserved": true,
      "actualCanonical44BudgetMigration": true,
      "actualCanonical45AuthSuccessor": false,
      "actualCanonical46AfterHoursPolicy": false
    },
    "databaseSha256": "2e077eb2f798fc2f5eff2a923b6b09ea2778da635052c0acf07feb7748c97f4c",
    "databaseBytes": 1445888,
    "checkpointResult": {
      "busy": 0,
      "log": 0,
      "checkpointed": 0
    },
    "retained": {
      "inherited43": {
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
      "heldSession": {
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
      "legacyAvailableAt": 86444000,
      "sibling": {
        "id": "acct_52eea28183c94583874ea7b03fb8dedf",
        "label": "Canonical auth budget sibling44",
        "state": "signed_in",
        "processGeneration": 1,
        "providerEmail": "canonical-auth-budget-sibling44@example.com",
        "providerPlan": "Plus",
        "createdAt": 44000,
        "updatedAt": 44000
      },
      "fresh": {
        "session": {
          "id": "sess_7d69248633a24b77ab921c717704286c",
          "profileId": "acct_52eea28183c94583874ea7b03fb8dedf",
          "providerThreadId": "canonical-auth-budget-fresh44",
          "title": "Canonical auth budget fresh44",
          "note": "",
          "provider": "codex",
          "preset": "high",
          "fastEnabled": false,
          "state": "idle",
          "revision": 1,
          "createdAt": 44000,
          "updatedAt": 44000
        },
        "runtime": {
          "sessionId": "sess_7d69248633a24b77ab921c717704286c",
          "revision": 1,
          "sourceKind": "session_start",
          "sourceId": "canonical-auth-budget-runtime-fresh44",
          "profile": {
            "profileId": "acct_52eea28183c94583874ea7b03fb8dedf",
            "processGeneration": 1,
            "observedAt": 44000,
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
          "recordedAt": 44000
        }
      },
      "approval": {
        "publicId": "44000000-0000-4000-8000-000000000001",
        "interaction": {
          "record": {
            "version": 1,
            "publicId": "44000000-0000-4000-8000-000000000001",
            "sessionId": "sess_7d69248633a24b77ab921c717704286c",
            "authority": {
              "profileId": "acct_52eea28183c94583874ea7b03fb8dedf",
              "processGeneration": 1,
              "connectionId": "44000000-0000-4000-8000-999999999999",
              "requestId": {
                "type": "string",
                "value": "44000000-0000-4000-8000-000000000001"
              },
              "method": "item/commandExecution/requestApproval",
              "requestDigest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              "threadId": "canonical-auth-budget-fresh44",
              "turnId": null,
              "itemId": null,
              "approvalId": null
            },
            "kind": "command_approval",
            "state": "pending",
            "revision": 1,
            "blocking": true,
            "display": {
              "kind": "command_approval",
              "summary": "Review synthetic command",
              "reason": null,
              "commandClass": "test",
              "workingDirectory": null,
              "availableDecisions": [
                "once",
                "decline",
                "cancel"
              ]
            },
            "responseDigest": null,
            "intendedTerminalState": null,
            "resolvedBy": null,
            "requestedAt": 44000,
            "deadlineAt": 1844000,
            "updatedAt": 44000,
            "terminalAt": null
          },
          "replayed": false
        }
      },
      "pending": {
        "queue": {
          "id": "queue_0476f2cbcd46438480565ca8869a254b",
          "sessionId": "sess_7d69248633a24b77ab921c717704286c",
          "message": "Retain the canonical44 pending human transcript",
          "state": "pending",
          "createdAt": 44000,
          "updatedAt": 44000
        },
        "source": {
          "status": "pending",
          "intent": {
            "version": 1,
            "accountId": "acct_52eea28183c94583874ea7b03fb8dedf",
            "providerGeneration": 1,
            "providerConnectionId": null,
            "actor": "human",
            "text": "Retain the canonical44 pending human transcript",
            "omittedCharacters": 0
          }
        },
        "idempotencyKey": "44000000-0000-4000-8000-000000000002"
      },
      "claude": {
        "session": {
          "id": "sess_bc4447047c1c4968b5b5c1c1fb246f6a",
          "profileId": "acct_52eea28183c94583874ea7b03fb8dedf",
          "providerThreadId": "canonical-auth-budget-claude44",
          "title": "Canonical auth budget claude44",
          "note": "",
          "provider": "claude",
          "preset": "fable-max",
          "fastEnabled": false,
          "state": "idle",
          "revision": 1,
          "createdAt": 44000,
          "updatedAt": 44000
        },
        "runtime": {
          "sessionId": "sess_bc4447047c1c4968b5b5c1c1fb246f6a",
          "revision": 1,
          "sourceKind": "session_start",
          "sourceId": "canonical-auth-budget-runtime-claude44",
          "profile": {
            "profileId": "acct_52eea28183c94583874ea7b03fb8dedf",
            "processGeneration": 1,
            "observedAt": 44000,
            "preset": "fable-max",
            "model": "claude-fable-5-1",
            "reasoningEffort": "max",
            "claudeVersion": "2.1.260",
            "permissionMode": "default",
            "configHome": "isolated",
            "outputFormat": "stream-json",
            "inputFormat": "stream-json"
          },
          "recordedAt": 44000
        }
      },
      "claudeApproval": {
        "publicId": "44000000-0000-4000-8000-000000000003",
        "interaction": {
          "record": {
            "version": 1,
            "publicId": "44000000-0000-4000-8000-000000000003",
            "sessionId": "sess_bc4447047c1c4968b5b5c1c1fb246f6a",
            "authority": {
              "profileId": "acct_52eea28183c94583874ea7b03fb8dedf",
              "processGeneration": 1,
              "connectionId": "44000000-0000-4000-8000-999999999999",
              "requestId": {
                "type": "string",
                "value": "44000000-0000-4000-8000-000000000003"
              },
              "method": "item/commandExecution/requestApproval",
              "requestDigest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              "threadId": "canonical-auth-budget-claude44",
              "turnId": null,
              "itemId": null,
              "approvalId": null
            },
            "kind": "command_approval",
            "state": "pending",
            "revision": 1,
            "blocking": true,
            "display": {
              "kind": "command_approval",
              "summary": "Review synthetic command",
              "reason": null,
              "commandClass": "test",
              "workingDirectory": null,
              "availableDecisions": [
                "once",
                "decline",
                "cancel"
              ]
            },
            "responseDigest": null,
            "intendedTerminalState": null,
            "resolvedBy": null,
            "requestedAt": 44000,
            "deadlineAt": 1844000,
            "updatedAt": 44000,
            "terminalAt": null
          },
          "replayed": false
        }
      },
      "usage": {
        "sourceRevision": 1,
        "observedAt": 44000,
        "payload": {
          "totalTokens": 100
        }
      },
      "loginProfile": {
        "id": "acct_72855ddcf2a94fb4bfbbbd8213e29ac9",
        "label": "Canonical44 pending login origin",
        "state": "login_pending",
        "processGeneration": 1,
        "createdAt": 44000,
        "updatedAt": 44000
      },
      "login": {
        "id": "attempt_fad6b4fc97d043e3a835adaabefca6ee",
        "state": "prepared",
        "replay": false
      },
      "loginKey": "44000000-0000-4000-8000-000000000100",
      "daemonGeneration": 1,
      "bootId": "boot_44444444444444444444444444444444"
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
        "applied_at": 44000
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
    "schemaSha256": "21c9064bbcd9175298db69d44c5d13bb99adfc7a2e46ffdf31d1d267475c43b8",
    "allTableRowsSha256": "8ffc66cdd45fbefc1d9f37a283b7b089b1498f79adff112caa7e3682f17fc9cf",
    "rowCounts": {
      "account_rate_limit_reset_attempts": 0,
      "account_rate_limit_reset_policies": 3,
      "account_rate_limit_reset_rebinds": 0,
      "attachments": 4,
      "attention_email_policy": 1,
      "autorespond_budget_history": 5,
      "autorespond_budget_reservations": 2,
      "autorespond_evidence": 1,
      "autorespond_message_sources": 0,
      "daemon_state": 1,
      "desktop_switch_authority": 1,
      "desktop_switch_resolutions": 0,
      "desktop_switches": 0,
      "device_command_ledger": 0,
      "message_attachments": 6,
      "migrations": 44,
      "mutation_attempts": 7,
      "mutation_effect_evidence": 1,
      "mutation_resolutions": 0,
      "notification_hours": 1,
      "profile_personal_authority_revocations": 0,
      "profiles": 3,
      "project_approval_modes": 0,
      "projects": 0,
      "provider_interaction_transitions": 2,
      "provider_interactions": 2,
      "provider_login_authorities": 0,
      "provider_runtime_account_revocations": 2,
      "queue_effect_evidence": 0,
      "queue_effect_resolutions": 0,
      "queue_entries": 6,
      "queue_message_scrub_authority": 0,
      "queue_sequence_authority": 1,
      "security_scrub_authority": 0,
      "session_account_authorities": 5,
      "session_adoption_candidates": 0,
      "session_adoption_policies": 0,
      "session_adoption_profile_generation_permits": 0,
      "session_approval_modes": 2,
      "session_autorespond_counters": 5,
      "session_claude_process_authorities": 0,
      "session_claude_process_launch_intents": 0,
      "session_conversation_automation": 0,
      "session_event_streams": 5,
      "session_events": 1,
      "session_mutation_authority_rebinds": 0,
      "session_mutation_authority_rebinds_v39": 0,
      "session_personal_runtime_bindings": 0,
      "session_provider_account_authorities": 5,
      "session_provider_switch_seed_intents": 0,
      "session_provider_switch_seed_results": 0,
      "session_provider_switch_source_releases": 0,
      "session_provider_switch_target_releases": 0,
      "session_provider_switch_targets": 0,
      "session_runtime_profiles": 5,
      "session_show_thinking": 0,
      "session_start_attempts": 0,
      "session_states": 0,
      "session_task_occurrences": 0,
      "session_task_receipts": 0,
      "session_tasks": 0,
      "session_turn_runtime_profiles": 0,
      "sessions": 5,
      "sqlite_sequence": 1,
      "turn_summaries": 0,
      "usage_cloud_upload_anchors": 1,
      "usage_poll_failures": 0,
      "usage_revision_authority": 3,
      "usage_snapshots": 1,
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
    "generatorSha256": "d5128066b55682139960b92ffe7b45cd3b446e133301ef00fba6273aae9a35d1",
    "bunVersion": "1.3.14",
    "dependencies": {
      "@hraness/oh": "0.2.7",
      "@openai/codex": "0.153.2",
      "convex": "1.45.0",
      "effect": "3.22.1",
      "zod": "4.4.3"
    },
    "predecessorSchemaVersion": 44,
    "predecessorDatabaseSha256": "2e077eb2f798fc2f5eff2a923b6b09ea2778da635052c0acf07feb7748c97f4c",
    "fixedTime": 45002,
    "provenance": {
      "syntheticControlPlaneOnly": true,
      "archivedPublicApisOnly": true,
      "nativeProviderEffects": 0,
      "networkEffects": 0,
      "rawSqlRowOrSchemaWrites": false,
      "randomizedIdentifiers": true,
      "reservedUsageRevisionForEveryNewProfile": true,
      "writableReopenUnchanged": true,
      "readonlyReopenUnchanged": true,
      "readonlyDatabaseHashUnchanged": true,
      "supplementalSyntheticRuntimeProfiles": true,
      "providerRuntimeObservationClaim": false,
      "currentMergedAdmissionClaim": false,
      "inheritedCanonical43BytesPreserved": true,
      "actualCanonical44BudgetMigration": true,
      "actualCanonical45AuthSuccessor": true,
      "actualCanonical46AfterHoursPolicy": false
    },
    "databaseSha256": "beca810524a7a575fac10e7d27d7e8b40169eb340cf3e9824fcdb45fd80c126c",
    "databaseBytes": 1466368,
    "checkpointResult": {
      "busy": 0,
      "log": 0,
      "checkpointed": 0
    },
    "retained": {
      "previous44": {
        "inherited43": {
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
        "heldSession": {
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
        "legacyAvailableAt": 86444000,
        "sibling": {
          "id": "acct_52eea28183c94583874ea7b03fb8dedf",
          "label": "Canonical auth budget sibling44",
          "state": "signed_in",
          "processGeneration": 1,
          "providerEmail": "canonical-auth-budget-sibling44@example.com",
          "providerPlan": "Plus",
          "createdAt": 44000,
          "updatedAt": 44000
        },
        "fresh": {
          "session": {
            "id": "sess_7d69248633a24b77ab921c717704286c",
            "profileId": "acct_52eea28183c94583874ea7b03fb8dedf",
            "providerThreadId": "canonical-auth-budget-fresh44",
            "title": "Canonical auth budget fresh44",
            "note": "",
            "provider": "codex",
            "preset": "high",
            "fastEnabled": false,
            "state": "idle",
            "revision": 1,
            "createdAt": 44000,
            "updatedAt": 44000
          },
          "runtime": {
            "sessionId": "sess_7d69248633a24b77ab921c717704286c",
            "revision": 1,
            "sourceKind": "session_start",
            "sourceId": "canonical-auth-budget-runtime-fresh44",
            "profile": {
              "profileId": "acct_52eea28183c94583874ea7b03fb8dedf",
              "processGeneration": 1,
              "observedAt": 44000,
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
            "recordedAt": 44000
          }
        },
        "approval": {
          "publicId": "44000000-0000-4000-8000-000000000001",
          "interaction": {
            "record": {
              "version": 1,
              "publicId": "44000000-0000-4000-8000-000000000001",
              "sessionId": "sess_7d69248633a24b77ab921c717704286c",
              "authority": {
                "profileId": "acct_52eea28183c94583874ea7b03fb8dedf",
                "processGeneration": 1,
                "connectionId": "44000000-0000-4000-8000-999999999999",
                "requestId": {
                  "type": "string",
                  "value": "44000000-0000-4000-8000-000000000001"
                },
                "method": "item/commandExecution/requestApproval",
                "requestDigest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "threadId": "canonical-auth-budget-fresh44",
                "turnId": null,
                "itemId": null,
                "approvalId": null
              },
              "kind": "command_approval",
              "state": "pending",
              "revision": 1,
              "blocking": true,
              "display": {
                "kind": "command_approval",
                "summary": "Review synthetic command",
                "reason": null,
                "commandClass": "test",
                "workingDirectory": null,
                "availableDecisions": [
                  "once",
                  "decline",
                  "cancel"
                ]
              },
              "responseDigest": null,
              "intendedTerminalState": null,
              "resolvedBy": null,
              "requestedAt": 44000,
              "deadlineAt": 1844000,
              "updatedAt": 44000,
              "terminalAt": null
            },
            "replayed": false
          }
        },
        "pending": {
          "queue": {
            "id": "queue_0476f2cbcd46438480565ca8869a254b",
            "sessionId": "sess_7d69248633a24b77ab921c717704286c",
            "message": "Retain the canonical44 pending human transcript",
            "state": "pending",
            "createdAt": 44000,
            "updatedAt": 44000
          },
          "source": {
            "status": "pending",
            "intent": {
              "version": 1,
              "accountId": "acct_52eea28183c94583874ea7b03fb8dedf",
              "providerGeneration": 1,
              "providerConnectionId": null,
              "actor": "human",
              "text": "Retain the canonical44 pending human transcript",
              "omittedCharacters": 0
            }
          },
          "idempotencyKey": "44000000-0000-4000-8000-000000000002"
        },
        "claude": {
          "session": {
            "id": "sess_bc4447047c1c4968b5b5c1c1fb246f6a",
            "profileId": "acct_52eea28183c94583874ea7b03fb8dedf",
            "providerThreadId": "canonical-auth-budget-claude44",
            "title": "Canonical auth budget claude44",
            "note": "",
            "provider": "claude",
            "preset": "fable-max",
            "fastEnabled": false,
            "state": "idle",
            "revision": 1,
            "createdAt": 44000,
            "updatedAt": 44000
          },
          "runtime": {
            "sessionId": "sess_bc4447047c1c4968b5b5c1c1fb246f6a",
            "revision": 1,
            "sourceKind": "session_start",
            "sourceId": "canonical-auth-budget-runtime-claude44",
            "profile": {
              "profileId": "acct_52eea28183c94583874ea7b03fb8dedf",
              "processGeneration": 1,
              "observedAt": 44000,
              "preset": "fable-max",
              "model": "claude-fable-5-1",
              "reasoningEffort": "max",
              "claudeVersion": "2.1.260",
              "permissionMode": "default",
              "configHome": "isolated",
              "outputFormat": "stream-json",
              "inputFormat": "stream-json"
            },
            "recordedAt": 44000
          }
        },
        "claudeApproval": {
          "publicId": "44000000-0000-4000-8000-000000000003",
          "interaction": {
            "record": {
              "version": 1,
              "publicId": "44000000-0000-4000-8000-000000000003",
              "sessionId": "sess_bc4447047c1c4968b5b5c1c1fb246f6a",
              "authority": {
                "profileId": "acct_52eea28183c94583874ea7b03fb8dedf",
                "processGeneration": 1,
                "connectionId": "44000000-0000-4000-8000-999999999999",
                "requestId": {
                  "type": "string",
                  "value": "44000000-0000-4000-8000-000000000003"
                },
                "method": "item/commandExecution/requestApproval",
                "requestDigest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "threadId": "canonical-auth-budget-claude44",
                "turnId": null,
                "itemId": null,
                "approvalId": null
              },
              "kind": "command_approval",
              "state": "pending",
              "revision": 1,
              "blocking": true,
              "display": {
                "kind": "command_approval",
                "summary": "Review synthetic command",
                "reason": null,
                "commandClass": "test",
                "workingDirectory": null,
                "availableDecisions": [
                  "once",
                  "decline",
                  "cancel"
                ]
              },
              "responseDigest": null,
              "intendedTerminalState": null,
              "resolvedBy": null,
              "requestedAt": 44000,
              "deadlineAt": 1844000,
              "updatedAt": 44000,
              "terminalAt": null
            },
            "replayed": false
          }
        },
        "usage": {
          "sourceRevision": 1,
          "observedAt": 44000,
          "payload": {
            "totalTokens": 100
          }
        },
        "loginProfile": {
          "id": "acct_72855ddcf2a94fb4bfbbbd8213e29ac9",
          "label": "Canonical44 pending login origin",
          "state": "login_pending",
          "processGeneration": 1,
          "createdAt": 44000,
          "updatedAt": 44000
        },
        "login": {
          "id": "attempt_fad6b4fc97d043e3a835adaabefca6ee",
          "state": "prepared",
          "replay": false
        },
        "loginKey": "44000000-0000-4000-8000-000000000100",
        "daemonGeneration": 1,
        "bootId": "boot_44444444444444444444444444444444"
      },
      "sibling": {
        "id": "acct_aae05cc2e5ac4e02ab4e26112ed3946d",
        "label": "Canonical auth budget sibling45",
        "state": "signed_in",
        "processGeneration": 1,
        "providerEmail": "canonical-auth-budget-sibling45@example.com",
        "providerPlan": "Plus",
        "createdAt": 45002,
        "updatedAt": 45002
      },
      "fresh": {
        "session": {
          "id": "sess_81ace583b81a460e9b2fb8ce329b6cb3",
          "profileId": "acct_aae05cc2e5ac4e02ab4e26112ed3946d",
          "providerThreadId": "canonical-auth-budget-fresh45",
          "title": "Canonical auth budget fresh45",
          "note": "",
          "provider": "codex",
          "preset": "high",
          "fastEnabled": false,
          "state": "idle",
          "revision": 1,
          "createdAt": 45002,
          "updatedAt": 45002
        },
        "runtime": {
          "sessionId": "sess_81ace583b81a460e9b2fb8ce329b6cb3",
          "revision": 1,
          "sourceKind": "session_start",
          "sourceId": "canonical-auth-budget-runtime-fresh45",
          "profile": {
            "profileId": "acct_aae05cc2e5ac4e02ab4e26112ed3946d",
            "processGeneration": 1,
            "observedAt": 45002,
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
          "recordedAt": 45002
        }
      },
      "approval": {
        "publicId": "45000000-0000-4000-8000-000000000001",
        "interaction": {
          "record": {
            "version": 1,
            "publicId": "45000000-0000-4000-8000-000000000001",
            "sessionId": "sess_81ace583b81a460e9b2fb8ce329b6cb3",
            "authority": {
              "profileId": "acct_aae05cc2e5ac4e02ab4e26112ed3946d",
              "processGeneration": 1,
              "connectionId": "45000000-0000-4000-8000-999999999999",
              "requestId": {
                "type": "string",
                "value": "45000000-0000-4000-8000-000000000001"
              },
              "method": "item/commandExecution/requestApproval",
              "requestDigest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              "threadId": "canonical-auth-budget-fresh45",
              "turnId": null,
              "itemId": null,
              "approvalId": null
            },
            "kind": "command_approval",
            "state": "pending",
            "revision": 1,
            "blocking": true,
            "display": {
              "kind": "command_approval",
              "summary": "Review synthetic command",
              "reason": null,
              "commandClass": "test",
              "workingDirectory": null,
              "availableDecisions": [
                "once",
                "decline",
                "cancel"
              ]
            },
            "responseDigest": null,
            "intendedTerminalState": null,
            "resolvedBy": null,
            "requestedAt": 45002,
            "deadlineAt": 1845002,
            "updatedAt": 45002,
            "terminalAt": null
          },
          "replayed": false
        }
      },
      "pending": {
        "queue": {
          "id": "queue_1f427c32b5734e4f8a4a3b85e8e3e4dd",
          "sessionId": "sess_81ace583b81a460e9b2fb8ce329b6cb3",
          "message": "Retain the canonical45 pending human transcript",
          "state": "pending",
          "createdAt": 45002,
          "updatedAt": 45002
        },
        "source": {
          "status": "pending",
          "intent": {
            "version": 1,
            "accountId": "acct_aae05cc2e5ac4e02ab4e26112ed3946d",
            "providerGeneration": 1,
            "providerConnectionId": null,
            "actor": "human",
            "text": "Retain the canonical45 pending human transcript",
            "omittedCharacters": 0
          }
        },
        "idempotencyKey": "45000000-0000-4000-8000-000000000002"
      },
      "loginId": "canonical-auth45-synthetic-pending-login",
      "cancellation": {
        "id": "attempt_71f4b7192b4f454db6a5f959ed34a299",
        "state": "prepared",
        "replay": false
      },
      "cancellationKey": "45000000-0000-4000-8000-000000000100",
      "loginProfile": {
        "id": "acct_72855ddcf2a94fb4bfbbbd8213e29ac9",
        "label": "Canonical44 pending login origin",
        "state": "recovery_required",
        "processGeneration": 2,
        "createdAt": 44000,
        "updatedAt": 45001
      },
      "daemonGeneration": 2,
      "bootId": "boot_55555555555555555555555555555555"
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
        "applied_at": 44000
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
    "allTableRowsSha256": "a354f9bf76456e99c3806c8632d686cbd410f817320d73f412e34bcbef7bd78e",
    "rowCounts": {
      "account_mutation_authority_rebinds": 1,
      "account_rate_limit_reset_attempts": 0,
      "account_rate_limit_reset_policies": 4,
      "account_rate_limit_reset_rebinds": 0,
      "attachments": 4,
      "attention_email_policy": 1,
      "autorespond_budget_history": 6,
      "autorespond_budget_reservations": 3,
      "autorespond_evidence": 1,
      "autorespond_message_sources": 0,
      "daemon_state": 1,
      "desktop_switch_authority": 1,
      "desktop_switch_resolutions": 0,
      "desktop_switches": 0,
      "device_command_ledger": 0,
      "message_attachments": 6,
      "migrations": 45,
      "mutation_attempts": 9,
      "mutation_effect_evidence": 2,
      "mutation_resolutions": 0,
      "notification_hours": 1,
      "profile_personal_authority_revocations": 0,
      "profiles": 4,
      "project_approval_modes": 0,
      "projects": 0,
      "provider_interaction_transitions": 5,
      "provider_interactions": 3,
      "provider_login_authorities": 1,
      "provider_runtime_account_revocations": 2,
      "queue_effect_evidence": 0,
      "queue_effect_resolutions": 0,
      "queue_entries": 7,
      "queue_message_scrub_authority": 0,
      "queue_sequence_authority": 1,
      "security_scrub_authority": 0,
      "session_account_authorities": 6,
      "session_adoption_candidates": 0,
      "session_adoption_policies": 0,
      "session_adoption_profile_generation_permits": 0,
      "session_approval_modes": 3,
      "session_autorespond_counters": 6,
      "session_claude_process_authorities": 0,
      "session_claude_process_launch_intents": 0,
      "session_conversation_automation": 0,
      "session_event_streams": 6,
      "session_events": 8,
      "session_mutation_authority_rebinds": 0,
      "session_mutation_authority_rebinds_v39": 0,
      "session_personal_runtime_bindings": 0,
      "session_provider_account_authorities": 6,
      "session_provider_switch_seed_intents": 0,
      "session_provider_switch_seed_results": 0,
      "session_provider_switch_source_releases": 0,
      "session_provider_switch_target_releases": 0,
      "session_provider_switch_targets": 0,
      "session_runtime_profiles": 6,
      "session_show_thinking": 0,
      "session_start_attempts": 0,
      "session_states": 0,
      "session_task_occurrences": 0,
      "session_task_receipts": 0,
      "session_tasks": 0,
      "session_turn_runtime_profiles": 0,
      "sessions": 6,
      "sqlite_sequence": 1,
      "turn_summaries": 0,
      "usage_cloud_upload_anchors": 1,
      "usage_poll_failures": 0,
      "usage_revision_authority": 4,
      "usage_snapshots": 1,
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
  "46": {
    "sourceCommit": "0aa3fd563e369f75875136ca1f550016e70035e8",
    "sourceTree": "b065429452fe86e017cad8c4ce3bd7f48cd943b8",
    "sourceManifestSha256": "b1a390df12864357cf973a09607b618969073c893e748b5cbcdc7f3374304441",
    "sourceFileCount": 283,
    "sourceHashes": {
      "src/storage/state-store.ts": "9c8b9214e230e851634b5dceb42bcb9c5d680671ce8c04b5ee216c608552a993",
      "package.json": "a00f95f903852c2ba1b844b87a2061c083cfae4a29bc50262f5bbf64d17445ba",
      "bun.lock": "39bdff36e30b4af4dd4eecb060b23c742d2b0111b983d4a9d63b06cbc80a69ff"
    },
    "schemaVersion": 46,
    "generatorSha256": "d5128066b55682139960b92ffe7b45cd3b446e133301ef00fba6273aae9a35d1",
    "bunVersion": "1.3.14",
    "dependencies": {
      "@hraness/oh": "0.2.7",
      "@openai/codex": "0.153.2",
      "convex": "1.45.0",
      "effect": "3.22.1",
      "zod": "4.4.3"
    },
    "predecessorSchemaVersion": 45,
    "predecessorDatabaseSha256": "beca810524a7a575fac10e7d27d7e8b40169eb340cf3e9824fcdb45fd80c126c",
    "fixedTime": 46000,
    "provenance": {
      "syntheticControlPlaneOnly": true,
      "archivedPublicApisOnly": true,
      "nativeProviderEffects": 0,
      "networkEffects": 0,
      "rawSqlRowOrSchemaWrites": false,
      "randomizedIdentifiers": true,
      "reservedUsageRevisionForEveryNewProfile": true,
      "writableReopenUnchanged": true,
      "readonlyReopenUnchanged": true,
      "readonlyDatabaseHashUnchanged": true,
      "supplementalSyntheticRuntimeProfiles": true,
      "providerRuntimeObservationClaim": false,
      "currentMergedAdmissionClaim": false,
      "inheritedCanonical43BytesPreserved": true,
      "actualCanonical44BudgetMigration": true,
      "actualCanonical45AuthSuccessor": true,
      "actualCanonical46AfterHoursPolicy": true
    },
    "databaseSha256": "d1d04b879f3185ce07d9d562e757f9992216185a19ddf6381e3b4af0372fa893",
    "databaseBytes": 1482752,
    "checkpointResult": {
      "busy": 0,
      "log": 0,
      "checkpointed": 0
    },
    "retained": {
      "previous45": {
        "previous44": {
          "inherited43": {
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
          "heldSession": {
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
          "legacyAvailableAt": 86444000,
          "sibling": {
            "id": "acct_52eea28183c94583874ea7b03fb8dedf",
            "label": "Canonical auth budget sibling44",
            "state": "signed_in",
            "processGeneration": 1,
            "providerEmail": "canonical-auth-budget-sibling44@example.com",
            "providerPlan": "Plus",
            "createdAt": 44000,
            "updatedAt": 44000
          },
          "fresh": {
            "session": {
              "id": "sess_7d69248633a24b77ab921c717704286c",
              "profileId": "acct_52eea28183c94583874ea7b03fb8dedf",
              "providerThreadId": "canonical-auth-budget-fresh44",
              "title": "Canonical auth budget fresh44",
              "note": "",
              "provider": "codex",
              "preset": "high",
              "fastEnabled": false,
              "state": "idle",
              "revision": 1,
              "createdAt": 44000,
              "updatedAt": 44000
            },
            "runtime": {
              "sessionId": "sess_7d69248633a24b77ab921c717704286c",
              "revision": 1,
              "sourceKind": "session_start",
              "sourceId": "canonical-auth-budget-runtime-fresh44",
              "profile": {
                "profileId": "acct_52eea28183c94583874ea7b03fb8dedf",
                "processGeneration": 1,
                "observedAt": 44000,
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
              "recordedAt": 44000
            }
          },
          "approval": {
            "publicId": "44000000-0000-4000-8000-000000000001",
            "interaction": {
              "record": {
                "version": 1,
                "publicId": "44000000-0000-4000-8000-000000000001",
                "sessionId": "sess_7d69248633a24b77ab921c717704286c",
                "authority": {
                  "profileId": "acct_52eea28183c94583874ea7b03fb8dedf",
                  "processGeneration": 1,
                  "connectionId": "44000000-0000-4000-8000-999999999999",
                  "requestId": {
                    "type": "string",
                    "value": "44000000-0000-4000-8000-000000000001"
                  },
                  "method": "item/commandExecution/requestApproval",
                  "requestDigest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                  "threadId": "canonical-auth-budget-fresh44",
                  "turnId": null,
                  "itemId": null,
                  "approvalId": null
                },
                "kind": "command_approval",
                "state": "pending",
                "revision": 1,
                "blocking": true,
                "display": {
                  "kind": "command_approval",
                  "summary": "Review synthetic command",
                  "reason": null,
                  "commandClass": "test",
                  "workingDirectory": null,
                  "availableDecisions": [
                    "once",
                    "decline",
                    "cancel"
                  ]
                },
                "responseDigest": null,
                "intendedTerminalState": null,
                "resolvedBy": null,
                "requestedAt": 44000,
                "deadlineAt": 1844000,
                "updatedAt": 44000,
                "terminalAt": null
              },
              "replayed": false
            }
          },
          "pending": {
            "queue": {
              "id": "queue_0476f2cbcd46438480565ca8869a254b",
              "sessionId": "sess_7d69248633a24b77ab921c717704286c",
              "message": "Retain the canonical44 pending human transcript",
              "state": "pending",
              "createdAt": 44000,
              "updatedAt": 44000
            },
            "source": {
              "status": "pending",
              "intent": {
                "version": 1,
                "accountId": "acct_52eea28183c94583874ea7b03fb8dedf",
                "providerGeneration": 1,
                "providerConnectionId": null,
                "actor": "human",
                "text": "Retain the canonical44 pending human transcript",
                "omittedCharacters": 0
              }
            },
            "idempotencyKey": "44000000-0000-4000-8000-000000000002"
          },
          "claude": {
            "session": {
              "id": "sess_bc4447047c1c4968b5b5c1c1fb246f6a",
              "profileId": "acct_52eea28183c94583874ea7b03fb8dedf",
              "providerThreadId": "canonical-auth-budget-claude44",
              "title": "Canonical auth budget claude44",
              "note": "",
              "provider": "claude",
              "preset": "fable-max",
              "fastEnabled": false,
              "state": "idle",
              "revision": 1,
              "createdAt": 44000,
              "updatedAt": 44000
            },
            "runtime": {
              "sessionId": "sess_bc4447047c1c4968b5b5c1c1fb246f6a",
              "revision": 1,
              "sourceKind": "session_start",
              "sourceId": "canonical-auth-budget-runtime-claude44",
              "profile": {
                "profileId": "acct_52eea28183c94583874ea7b03fb8dedf",
                "processGeneration": 1,
                "observedAt": 44000,
                "preset": "fable-max",
                "model": "claude-fable-5-1",
                "reasoningEffort": "max",
                "claudeVersion": "2.1.260",
                "permissionMode": "default",
                "configHome": "isolated",
                "outputFormat": "stream-json",
                "inputFormat": "stream-json"
              },
              "recordedAt": 44000
            }
          },
          "claudeApproval": {
            "publicId": "44000000-0000-4000-8000-000000000003",
            "interaction": {
              "record": {
                "version": 1,
                "publicId": "44000000-0000-4000-8000-000000000003",
                "sessionId": "sess_bc4447047c1c4968b5b5c1c1fb246f6a",
                "authority": {
                  "profileId": "acct_52eea28183c94583874ea7b03fb8dedf",
                  "processGeneration": 1,
                  "connectionId": "44000000-0000-4000-8000-999999999999",
                  "requestId": {
                    "type": "string",
                    "value": "44000000-0000-4000-8000-000000000003"
                  },
                  "method": "item/commandExecution/requestApproval",
                  "requestDigest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                  "threadId": "canonical-auth-budget-claude44",
                  "turnId": null,
                  "itemId": null,
                  "approvalId": null
                },
                "kind": "command_approval",
                "state": "pending",
                "revision": 1,
                "blocking": true,
                "display": {
                  "kind": "command_approval",
                  "summary": "Review synthetic command",
                  "reason": null,
                  "commandClass": "test",
                  "workingDirectory": null,
                  "availableDecisions": [
                    "once",
                    "decline",
                    "cancel"
                  ]
                },
                "responseDigest": null,
                "intendedTerminalState": null,
                "resolvedBy": null,
                "requestedAt": 44000,
                "deadlineAt": 1844000,
                "updatedAt": 44000,
                "terminalAt": null
              },
              "replayed": false
            }
          },
          "usage": {
            "sourceRevision": 1,
            "observedAt": 44000,
            "payload": {
              "totalTokens": 100
            }
          },
          "loginProfile": {
            "id": "acct_72855ddcf2a94fb4bfbbbd8213e29ac9",
            "label": "Canonical44 pending login origin",
            "state": "login_pending",
            "processGeneration": 1,
            "createdAt": 44000,
            "updatedAt": 44000
          },
          "login": {
            "id": "attempt_fad6b4fc97d043e3a835adaabefca6ee",
            "state": "prepared",
            "replay": false
          },
          "loginKey": "44000000-0000-4000-8000-000000000100",
          "daemonGeneration": 1,
          "bootId": "boot_44444444444444444444444444444444"
        },
        "sibling": {
          "id": "acct_aae05cc2e5ac4e02ab4e26112ed3946d",
          "label": "Canonical auth budget sibling45",
          "state": "signed_in",
          "processGeneration": 1,
          "providerEmail": "canonical-auth-budget-sibling45@example.com",
          "providerPlan": "Plus",
          "createdAt": 45002,
          "updatedAt": 45002
        },
        "fresh": {
          "session": {
            "id": "sess_81ace583b81a460e9b2fb8ce329b6cb3",
            "profileId": "acct_aae05cc2e5ac4e02ab4e26112ed3946d",
            "providerThreadId": "canonical-auth-budget-fresh45",
            "title": "Canonical auth budget fresh45",
            "note": "",
            "provider": "codex",
            "preset": "high",
            "fastEnabled": false,
            "state": "idle",
            "revision": 1,
            "createdAt": 45002,
            "updatedAt": 45002
          },
          "runtime": {
            "sessionId": "sess_81ace583b81a460e9b2fb8ce329b6cb3",
            "revision": 1,
            "sourceKind": "session_start",
            "sourceId": "canonical-auth-budget-runtime-fresh45",
            "profile": {
              "profileId": "acct_aae05cc2e5ac4e02ab4e26112ed3946d",
              "processGeneration": 1,
              "observedAt": 45002,
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
            "recordedAt": 45002
          }
        },
        "approval": {
          "publicId": "45000000-0000-4000-8000-000000000001",
          "interaction": {
            "record": {
              "version": 1,
              "publicId": "45000000-0000-4000-8000-000000000001",
              "sessionId": "sess_81ace583b81a460e9b2fb8ce329b6cb3",
              "authority": {
                "profileId": "acct_aae05cc2e5ac4e02ab4e26112ed3946d",
                "processGeneration": 1,
                "connectionId": "45000000-0000-4000-8000-999999999999",
                "requestId": {
                  "type": "string",
                  "value": "45000000-0000-4000-8000-000000000001"
                },
                "method": "item/commandExecution/requestApproval",
                "requestDigest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "threadId": "canonical-auth-budget-fresh45",
                "turnId": null,
                "itemId": null,
                "approvalId": null
              },
              "kind": "command_approval",
              "state": "pending",
              "revision": 1,
              "blocking": true,
              "display": {
                "kind": "command_approval",
                "summary": "Review synthetic command",
                "reason": null,
                "commandClass": "test",
                "workingDirectory": null,
                "availableDecisions": [
                  "once",
                  "decline",
                  "cancel"
                ]
              },
              "responseDigest": null,
              "intendedTerminalState": null,
              "resolvedBy": null,
              "requestedAt": 45002,
              "deadlineAt": 1845002,
              "updatedAt": 45002,
              "terminalAt": null
            },
            "replayed": false
          }
        },
        "pending": {
          "queue": {
            "id": "queue_1f427c32b5734e4f8a4a3b85e8e3e4dd",
            "sessionId": "sess_81ace583b81a460e9b2fb8ce329b6cb3",
            "message": "Retain the canonical45 pending human transcript",
            "state": "pending",
            "createdAt": 45002,
            "updatedAt": 45002
          },
          "source": {
            "status": "pending",
            "intent": {
              "version": 1,
              "accountId": "acct_aae05cc2e5ac4e02ab4e26112ed3946d",
              "providerGeneration": 1,
              "providerConnectionId": null,
              "actor": "human",
              "text": "Retain the canonical45 pending human transcript",
              "omittedCharacters": 0
            }
          },
          "idempotencyKey": "45000000-0000-4000-8000-000000000002"
        },
        "loginId": "canonical-auth45-synthetic-pending-login",
        "cancellation": {
          "id": "attempt_71f4b7192b4f454db6a5f959ed34a299",
          "state": "prepared",
          "replay": false
        },
        "cancellationKey": "45000000-0000-4000-8000-000000000100",
        "loginProfile": {
          "id": "acct_72855ddcf2a94fb4bfbbbd8213e29ac9",
          "label": "Canonical44 pending login origin",
          "state": "recovery_required",
          "processGeneration": 2,
          "createdAt": 44000,
          "updatedAt": 45001
        },
        "daemonGeneration": 2,
        "bootId": "boot_55555555555555555555555555555555"
      },
      "sibling": {
        "id": "acct_74d8f9ed5ee044ddb5d4a857f1266ce9",
        "label": "Canonical auth budget sibling46",
        "state": "signed_in",
        "processGeneration": 1,
        "providerEmail": "canonical-auth-budget-sibling46@example.com",
        "providerPlan": "Plus",
        "createdAt": 46000,
        "updatedAt": 46000
      },
      "fresh": {
        "session": {
          "id": "sess_4a137167b4d348788c7e29ac9b4340b7",
          "profileId": "acct_74d8f9ed5ee044ddb5d4a857f1266ce9",
          "providerThreadId": "canonical-auth-budget-fresh46",
          "title": "Canonical auth budget fresh46",
          "note": "",
          "provider": "codex",
          "preset": "high",
          "fastEnabled": false,
          "state": "idle",
          "revision": 1,
          "createdAt": 46000,
          "updatedAt": 46000
        },
        "runtime": {
          "sessionId": "sess_4a137167b4d348788c7e29ac9b4340b7",
          "revision": 1,
          "sourceKind": "session_start",
          "sourceId": "canonical-auth-budget-runtime-fresh46",
          "profile": {
            "profileId": "acct_74d8f9ed5ee044ddb5d4a857f1266ce9",
            "processGeneration": 1,
            "observedAt": 46000,
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
          "recordedAt": 46000
        }
      },
      "approval": {
        "publicId": "46000000-0000-4000-8000-000000000001",
        "interaction": {
          "record": {
            "version": 1,
            "publicId": "46000000-0000-4000-8000-000000000001",
            "sessionId": "sess_4a137167b4d348788c7e29ac9b4340b7",
            "authority": {
              "profileId": "acct_74d8f9ed5ee044ddb5d4a857f1266ce9",
              "processGeneration": 1,
              "connectionId": "46000000-0000-4000-8000-999999999999",
              "requestId": {
                "type": "string",
                "value": "46000000-0000-4000-8000-000000000001"
              },
              "method": "item/commandExecution/requestApproval",
              "requestDigest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              "threadId": "canonical-auth-budget-fresh46",
              "turnId": null,
              "itemId": null,
              "approvalId": null
            },
            "kind": "command_approval",
            "state": "pending",
            "revision": 1,
            "blocking": true,
            "display": {
              "kind": "command_approval",
              "summary": "Review synthetic command",
              "reason": null,
              "commandClass": "test",
              "workingDirectory": null,
              "availableDecisions": [
                "once",
                "decline",
                "cancel"
              ]
            },
            "responseDigest": null,
            "intendedTerminalState": null,
            "resolvedBy": null,
            "requestedAt": 46000,
            "deadlineAt": 1846000,
            "updatedAt": 46000,
            "terminalAt": null
          },
          "replayed": false
        }
      },
      "pending": {
        "queue": {
          "id": "queue_cee6c5821f3641b2b3da911646541677",
          "sessionId": "sess_4a137167b4d348788c7e29ac9b4340b7",
          "message": "Retain the canonical46 pending human transcript",
          "state": "pending",
          "createdAt": 46000,
          "updatedAt": 46000
        },
        "source": {
          "status": "pending",
          "intent": {
            "version": 1,
            "accountId": "acct_74d8f9ed5ee044ddb5d4a857f1266ce9",
            "providerGeneration": 1,
            "providerConnectionId": null,
            "actor": "human",
            "text": "Retain the canonical46 pending human transcript",
            "omittedCharacters": 0
          }
        },
        "idempotencyKey": "46000000-0000-4000-8000-000000000002"
      },
      "policy": {
        "kind": "autorespond_after_hours",
        "version": 1,
        "revision": 2,
        "enabled": true
      },
      "daemonGeneration": 2,
      "bootId": "boot_55555555555555555555555555555555"
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
        "applied_at": 44000
      },
      {
        "version": 45,
        "applied_at": 45000
      },
      {
        "version": 46,
        "applied_at": 46000
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
    "schemaSha256": "68d6c5649b26439a03edf21fbe0f872919c9746c5f34f31d96fca9ffe0046b94",
    "allTableRowsSha256": "325c2bd8901307cd22e67ad79d552d0d8191a577cde30b91f0a49b66498c2cf0",
    "rowCounts": {
      "account_mutation_authority_rebinds": 1,
      "account_rate_limit_reset_attempts": 0,
      "account_rate_limit_reset_policies": 5,
      "account_rate_limit_reset_rebinds": 0,
      "attachments": 4,
      "attention_email_policy": 1,
      "autorespond_after_hours_history": 7,
      "autorespond_after_hours_policy": 1,
      "autorespond_budget_history": 7,
      "autorespond_budget_reservations": 4,
      "autorespond_evidence": 1,
      "autorespond_message_sources": 0,
      "daemon_state": 1,
      "desktop_switch_authority": 1,
      "desktop_switch_resolutions": 0,
      "desktop_switches": 0,
      "device_command_ledger": 0,
      "message_attachments": 6,
      "migrations": 46,
      "mutation_attempts": 10,
      "mutation_effect_evidence": 2,
      "mutation_resolutions": 0,
      "notification_hours": 1,
      "profile_personal_authority_revocations": 0,
      "profiles": 5,
      "project_approval_modes": 0,
      "projects": 0,
      "provider_interaction_transitions": 6,
      "provider_interactions": 4,
      "provider_login_authorities": 1,
      "provider_runtime_account_revocations": 2,
      "queue_effect_evidence": 0,
      "queue_effect_resolutions": 0,
      "queue_entries": 8,
      "queue_message_scrub_authority": 0,
      "queue_sequence_authority": 1,
      "security_scrub_authority": 0,
      "session_account_authorities": 7,
      "session_adoption_candidates": 0,
      "session_adoption_policies": 0,
      "session_adoption_profile_generation_permits": 0,
      "session_approval_modes": 4,
      "session_autorespond_counters": 7,
      "session_claude_process_authorities": 0,
      "session_claude_process_launch_intents": 0,
      "session_conversation_automation": 0,
      "session_event_streams": 7,
      "session_events": 8,
      "session_mutation_authority_rebinds": 0,
      "session_mutation_authority_rebinds_v39": 0,
      "session_personal_runtime_bindings": 0,
      "session_provider_account_authorities": 7,
      "session_provider_switch_seed_intents": 0,
      "session_provider_switch_seed_results": 0,
      "session_provider_switch_source_releases": 0,
      "session_provider_switch_target_releases": 0,
      "session_provider_switch_targets": 0,
      "session_runtime_profiles": 7,
      "session_show_thinking": 0,
      "session_start_attempts": 0,
      "session_states": 0,
      "session_task_occurrences": 0,
      "session_task_receipts": 0,
      "session_tasks": 0,
      "session_turn_runtime_profiles": 0,
      "sessions": 7,
      "sqlite_sequence": 1,
      "turn_summaries": 0,
      "usage_cloud_upload_anchors": 1,
      "usage_poll_failures": 0,
      "usage_revision_authority": 5,
      "usage_snapshots": 1,
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

export const canonicalAuthBudgetGeneratorSource = "import assert from \"node:assert/strict\";\nimport { createHash } from \"node:crypto\";\nimport { existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from \"node:fs\";\nimport { mkdir } from \"node:fs/promises\";\nimport { join, relative } from \"node:path\";\nimport { gzipSync } from \"node:zlib\";\nimport { Database } from \"bun:sqlite\";\n\n// Root reviews this complete recipe and owns its scheduled execution. All\n// database mutations below use exact archived public StateStore APIs. Raw SQL\n// is restricted to query-only inspection and the final WAL checkpoint.\nconst root = import.meta.dir;\nconst output = join(root, \"capture2\");\nconst hash = (value: string | Uint8Array) => createHash(\"sha256\").update(value).digest(\"hex\");\nconst input43Sha256 = \"7ab3b21f2cafabb0e1494a20bae58c77e08e17a82423a337976651bee61a3322\";\n// The coordinator independently checks the earlier original captures. This\n// portable recipe opens only its pinned copied input, never those originals.\nconst assertInputUnchanged = () => {\n  assert.equal(hash(readFileSync(join(root, \"inputs/canonical43.sqlite\"))), input43Sha256);\n};\nassert.equal(Bun.version, \"1.3.14\");\nassert.equal(lstatSync(root).mode & 0o777, 0o700);\nassert.equal(existsSync(output), false, \"Never overwrite a capture, even a failed one.\");\nassertInputUnchanged();\n\nconst definitions = {\n  44: {\n    sourceCommit: \"a75e7487594ce5b68345ccd3536974a10f7a93ee\",\n    sourceTree: \"b9025a56a9db70a194284ff81570e08e7994eb46\",\n    sourceManifestSha256: \"854c9d8d77a6a24a650702e914724db771c170aff3057537b37f06d31ee91689\",\n    sourceFileCount: 279,\n    sourceHashes: {\n      \"src/storage/state-store.ts\": \"40e7a3a6c868f626b73fb6eb8a47b3c0080e03a394166a394dc48aaf7659e94d\",\n      \"package.json\": \"0b5b1b9ba0e3f6524d4b2320ebb188978653235a6bf44cad6dd7e8365023f784\",\n      \"bun.lock\": \"17a71da0d346e20153c61e3d54bd7db8eb16b6f21f2d93340f6fc88c15fc678e\",\n    },\n  },\n  45: {\n    sourceCommit: \"5c5c02ee5964167fb85e92da53cdb80c87991890\",\n    sourceTree: \"3f226e97912b667b67eea29a5f2ec66fe6f071da\",\n    sourceManifestSha256: \"60690e58c7b483eb3b249aaadeb877ea0a4677eb5b2e7360ac673ffed63da627\",\n    sourceFileCount: 281,\n    sourceHashes: {\n      \"src/storage/state-store.ts\": \"97977822058e5adeaecdd9d455f9169f102e2a7c5e478d643e98fe492028b26a\",\n      \"package.json\": \"a00f95f903852c2ba1b844b87a2061c083cfae4a29bc50262f5bbf64d17445ba\",\n      \"bun.lock\": \"39bdff36e30b4af4dd4eecb060b23c742d2b0111b983d4a9d63b06cbc80a69ff\",\n    },\n  },\n  46: {\n    sourceCommit: \"0aa3fd563e369f75875136ca1f550016e70035e8\",\n    sourceTree: \"b065429452fe86e017cad8c4ce3bd7f48cd943b8\",\n    sourceManifestSha256: \"b1a390df12864357cf973a09607b618969073c893e748b5cbcdc7f3374304441\",\n    sourceFileCount: 283,\n    sourceHashes: {\n      \"src/storage/state-store.ts\": \"9c8b9214e230e851634b5dceb42bcb9c5d680671ce8c04b5ee216c608552a993\",\n      \"package.json\": \"a00f95f903852c2ba1b844b87a2061c083cfae4a29bc50262f5bbf64d17445ba\",\n      \"bun.lock\": \"39bdff36e30b4af4dd4eecb060b23c742d2b0111b983d4a9d63b06cbc80a69ff\",\n    },\n  },\n} as const;\nconst dependencies = {\n  \"@hraness/oh\": \"0.2.7\", \"@openai/codex\": \"0.153.2\", convex: \"1.45.0\", effect: \"3.22.1\", zod: \"4.4.3\",\n};\nconst verifySource = (version: keyof typeof definitions) => {\n  const sourceRoot = join(root, `canonical${version}`);\n  const definition = definitions[version];\n  for (const [path, expected] of Object.entries(definition.sourceHashes)) {\n    assert.equal(hash(readFileSync(join(sourceRoot, path))), expected, path);\n  }\n  const sourceFiles: { path: string; sha256: string }[] = [];\n  function visit(directory: string) {\n    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {\n      const path = join(directory, entry.name);\n      if (entry.isDirectory()) visit(path);\n      else if (entry.isFile()) sourceFiles.push({ path: relative(sourceRoot, path), sha256: hash(readFileSync(path)) });\n      else throw new Error(\"Unexpected archived source entry.\");\n    }\n  }\n  visit(join(sourceRoot, \"src\"));\n  assert.equal(sourceFiles.length, definition.sourceFileCount);\n  assert.equal(hash(JSON.stringify(sourceFiles)), definition.sourceManifestSha256);\n  const packageJson = JSON.parse(readFileSync(join(sourceRoot, \"package.json\"), \"utf8\"));\n  assert.deepEqual(packageJson.dependencies, dependencies);\n  for (const [name, expected] of Object.entries(dependencies)) {\n    assert.equal(JSON.parse(readFileSync(join(sourceRoot, \"node_modules\", name, \"package.json\"), \"utf8\")).version, expected);\n  }\n  return sourceFiles;\n};\nconst snapshot = (path: string) => {\n  // A writable handle is needed to initialize WAL sidecars for a detached\n  // captured image. query_only forbids durable writes by this inspector.\n  const database = new Database(path, { create: false, strict: true });\n  database.exec(\"PRAGMA query_only=ON\");\n  try {\n    const schema = database.query(\"SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name LIMIT 2049\").all();\n    assert.ok(schema.length <= 2048);\n    const tables = database.query(\"SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name LIMIT 257\").all() as { name: string }[];\n    assert.ok(tables.length <= 256);\n    const rows: Record<string, unknown[]> = {};\n    for (const { name } of tables) {\n      assert.match(name, /^[a-zA-Z0-9_]+$/);\n      rows[name] = database.query(`SELECT * FROM \"${name}\" LIMIT 4097`).all().sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));\n      assert.ok(rows[name].length <= 4096);\n    }\n    const result = {\n      userVersion: database.query(\"PRAGMA user_version\").get(), schema, rows,\n      foreignKeyCheck: database.query(\"PRAGMA foreign_key_check\").all(),\n      inspectionChanges: database.query(\"SELECT total_changes() AS count\").get(),\n    };\n    assert.deepEqual(result.foreignKeyCheck, []);\n    assert.deepEqual(result.inspectionChanges, { count: 0 });\n    assert.ok(Buffer.byteLength(JSON.stringify(result)) < 8 * 1024 * 1024);\n    return result;\n  } finally { database.close(false); }\n};\n\n// The input metadata is retained beside the immutable input bytes. Its exact\n// database digest is checked before using the synthetic session/profile IDs.\nconst inputMetadataBytes = readFileSync(join(root, \"inputs/canonical43.json\"));\nassert.ok(inputMetadataBytes.length < 8 * 1024 * 1024);\nassert.equal(hash(inputMetadataBytes), \"5b368703cf944e97298152465c113a2e1913403d08ebaa8f110e451d4a963152\");\nconst inputMetadata = JSON.parse(inputMetadataBytes.toString(\"utf8\"));\nassert.equal(inputMetadata.databaseSha256, input43Sha256);\nassert.equal(inputMetadata.schemaVersion, 43);\nassert.equal(inputMetadata.generatorSha256, \"fb09bd5025f5bda4090aeff1747dcebc133196528d1f6ad80efd2de1dd4fece8\");\nassert.equal(inputMetadata.retained.daemonGeneration, 1);\nconst inherited43 = inputMetadata.retained;\nlet predecessorBytes = readFileSync(join(root, \"inputs/canonical43.sqlite\"));\nlet predecessorVersion = 43;\nlet retained44: Record<string, any> | undefined;\nlet retained45: Record<string, any> | undefined;\nconst generatorSource = readFileSync(import.meta.path, \"utf8\");\nconst summaries = [];\nfor (const version of [44, 45, 46] as const) verifySource(version);\nawait mkdir(output, { mode: 0o700 });\n\nfor (const version of [44, 45, 46] as const) {\n  const sourceFiles = verifySource(version);\n  const { StateStore } = await import(`./canonical${version}/src/storage/state-store`);\n  const { initializeStatePaths, resolveStatePaths } = await import(`./canonical${version}/src/storage/paths`);\n  const { CLAUDE_PIN } = await import(`./canonical${version}/src/claude/pin`);\n  assert.equal(CLAUDE_PIN, \"2.1.260\");\n  const directory = join(output, `canonical${version}`);\n  await mkdir(directory, { mode: 0o700 });\n  const paths = resolveStatePaths({ rootDirectory: join(directory, \"state\") });\n  await initializeStatePaths(paths);\n  writeFileSync(paths.database, predecessorBytes, { mode: 0o600, flag: \"wx\" });\n  const predecessorDatabaseSha256 = hash(predecessorBytes);\n  const beforeMigration = snapshot(paths.database);\n  assert.deepEqual(beforeMigration.userVersion, { user_version: predecessorVersion });\n  const clock = { now: version * 1000 };\n  const store = new StateStore(paths, { now: () => clock.now });\n  assert.deepEqual(snapshot(paths.database).userVersion, { user_version: version });\n\n  const signIn = (suffix: string) => {\n    const created = store.createProfile(`Canonical auth budget ${suffix}`);\n    // Reserve one real usage revision even when no observation follows. The\n    // archived constructor otherwise initializes its absent allocator later.\n    assert.equal(store.allocateNextUsageRevision(created.id), 1);\n    const advanced = store.nextProfileGeneration(created.id);\n    assert.equal(advanced.processGeneration, 1);\n    const email = `canonical-auth-budget-${suffix}@example.com`;\n    assert.equal(store.setProfileState(advanced.id, 1, \"signed_in\", { email, plan: \"Plus\" }), true);\n    return store.requireProfile(advanced.id);\n  };\n  const sessionWithRuntime = (profile: { id: string; processGeneration: number; providerEmail: string }, suffix: string, provider: \"codex\" | \"claude\" = \"codex\") => {\n    const session = store.upsertProviderSession({\n      profileId: profile.id, provider, providerThreadId: `canonical-auth-budget-${suffix}`,\n      providerAccountKey: `v1:${provider}:${hash(provider === \"codex\" ? profile.providerEmail : `synthetic-claude-${suffix}`)}`,\n      title: `Canonical auth budget ${suffix}`, preset: provider === \"codex\" ? \"high\" : \"fable-max\", fastEnabled: false, state: \"idle\",\n    });\n    const binding = store.requireSessionPresetRequirement(session.id);\n    assert.deepEqual(binding.requirement, provider === \"codex\"\n      ? { model: \"gpt-5.6-sol\", effort: \"max\" }\n      : { model: \"claude-fable-5-1\", effort: \"max\" });\n    // Synthetic reviewed-profile metadata reported through the archived API;\n    // never a claim that a Codex or Claude process was started or observed.\n    const common = { profileId: profile.id, processGeneration: profile.processGeneration, observedAt: clock.now,\n      preset: binding.preset, model: binding.requirement.model, reasoningEffort: binding.requirement.effort };\n    const runtime = store.recordSessionRuntimeProfile({\n      sessionId: session.id, sourceKind: \"session_start\", sourceId: `canonical-auth-budget-runtime-${suffix}`,\n      profile: provider === \"codex\"\n        ? { ...common, serviceTier: null, fast: false, approvalPolicy: \"on-request\", reviewMode: \"auto_review\",\n          permissionProfile: \":workspace\", computerUse: true, pluginCapability: true, enabledApps: [] }\n        : { ...common, claudeVersion: CLAUDE_PIN, permissionMode: \"default\", configHome: \"isolated\", outputFormat: \"stream-json\", inputFormat: \"stream-json\" },\n    });\n    assert.equal(runtime.revision, 1);\n    return { session, runtime };\n  };\n  const reserve = (session: { id: string; profileId: string; providerThreadId: string }, index: number) => {\n    const profile = store.requireProfile(session.profileId);\n    store.setSessionApprovalMode(session.id, \"auto:all\");\n    const publicId = `${version}000000-0000-4000-8000-${String(index).padStart(12, \"0\")}`;\n    const interaction = store.admitInteraction({\n      publicId, sessionId: session.id,\n      authority: { profileId: profile.id, processGeneration: profile.processGeneration,\n        connectionId: `${version}000000-0000-4000-8000-999999999999`,\n        requestId: { type: \"string\", value: publicId }, method: \"item/commandExecution/requestApproval\",\n        requestDigest: \"a\".repeat(64), threadId: session.providerThreadId, turnId: null, itemId: null, approvalId: null },\n      kind: \"command_approval\", blocking: true,\n      display: { kind: \"command_approval\", summary: \"Review synthetic command\", reason: null, commandClass: \"test\",\n        workingDirectory: null, availableDecisions: [\"once\", \"decline\", \"cancel\"] },\n    });\n    assert.deepEqual(store.reserveAutorespondBudget({ sessionId: session.id, sourceId: publicId, sourceKind: \"protocol\", expectedMode: \"auto:all\" }), { state: \"reserved\" });\n    assert.deepEqual(store.readAutorespondBudgets(session.id), { consecutive: 1, lastHour: 1, lastDay: 1 });\n    return { publicId, interaction };\n  };\n  const pendingHuman = (session: { id: string; profileId: string }, index: number) => {\n    const profile = store.requireProfile(session.profileId);\n    const idempotencyKey = `${version}000000-0000-4000-8000-${String(index).padStart(12, \"0\")}`;\n    const queue = store.enqueueIdempotent({ sessionId: session.id, profileGeneration: profile.processGeneration,\n      message: `Retain the canonical${version} pending human transcript`, actor: \"human\", idempotencyKey });\n    const source = store.readSessionUserMessageSource(session.id, \"queue\", queue.id);\n    assert.equal(source.status, \"pending\");\n    assert.equal(source.intent.actor, \"human\");\n    return { queue, source, idempotencyKey };\n  };\n\n  let retained: Record<string, any>;\n  if (version === 44) {\n    // The actual44 migration, not this script, creates the complete-window\n    // history hold and conservative floor for every real pre44 session.\n    const heldSession = inherited43.budgetSession;\n    const legacyAvailableAt = 86_444_000;\n    assert.equal(store.readAutorespondBudgetHistoryAvailableAt(heldSession.id), legacyAvailableAt);\n    assert.deepEqual(store.readAutorespondBudgets(heldSession.id), { consecutive: 3, lastHour: 0, lastDay: 0 });\n    store.setDefaultApprovalMode(\"auto:workspace\");\n    const sibling = signIn(\"sibling44\");\n    const fresh = sessionWithRuntime(sibling, \"fresh44\");\n    const approval = reserve(fresh.session, 1);\n    const pending = pendingHuman(fresh.session, 2);\n    store.bumpAutorespondCounter(fresh.session.id);\n    assert.deepEqual(store.readAutorespondBudgets(fresh.session.id), { consecutive: 2, lastHour: 1, lastDay: 1 });\n    assert.equal(store.readAutorespondBudgetHistoryAvailableAt(fresh.session.id), null);\n    const claude = sessionWithRuntime(sibling, \"claude44\", \"claude\");\n    const claudeApproval = reserve(claude.session, 3);\n    store.recordAutorespondEvidence({ sessionId: claude.session.id, interactionId: claudeApproval.publicId,\n      kind: \"command_approval\", approvalClass: \"test\", decision: \"once\", mode: \"auto:all\", outcome: \"unknown\", latencyMs: 1, subagent: false });\n    // Use the revision reserved by signIn; do not allocate a second key.\n    store.recordUsage(sibling.id, 1, clock.now, { totalTokens: 100 });\n    const usage = store.latestUsage(sibling.id);\n    const loginProfile = store.createProfile(\"Canonical44 pending login origin\");\n    assert.equal(loginProfile.processGeneration, 0);\n    assert.equal(store.allocateNextUsageRevision(loginProfile.id), 1);\n    const loginKey = \"44000000-0000-4000-8000-000000000100\";\n    const login = store.prepareMutation({ kind: \"account.login\", authorityId: loginProfile.id,\n      authorityGeneration: 1, request: { deviceCode: true }, idempotencyKey: loginKey });\n    // No processes, bindings, sessions, or Work exist under this new profile.\n    // Complete only the archived API's empty local retirement bookkeeping.\n    // Any attempted cursor/capability use is an unexpected fixture effect.\n    const unexpected = () => { throw new Error(\"Unexpected synthetic Work capability access.\"); };\n    const workStore = store.createWorkStore(1, unexpected, { issue: unexpected, verify: unexpected });\n    for (const runtimeScope of [\"personal\", \"managed\"] as const) {\n      const begun = store.beginProviderRuntimeAccountRevocation({ profileId: loginProfile.id, expectedGeneration: 0,\n        provider: \"codex\", runtimeScope, currentAccountKey: null, workStore });\n      assert.deepEqual(begun.bindings, []);\n      assert.deepEqual(begun.interactions, []);\n      assert.deepEqual(begun.sessionIds, []);\n      assert.deepEqual(begun.affectedWorkIds, []);\n      const completed = store.completeProviderRuntimeAccountRevocation({ profileId: loginProfile.id, expectedGeneration: 0,\n        provider: \"codex\", runtimeScope, expectedRevision: begun.revocation.revision });\n      assert.equal(completed.state, \"completed\");\n    }\n    store.beginAccountMutationEffect({ attemptId: login.id, profileId: loginProfile.id, profileGeneration: 1,\n      evidence: { kind: \"account.login\", method: \"device_code\" } });\n    assert.equal(store.readMutation(loginKey).state, \"effect_started\");\n    retained = { inherited43, heldSession, legacyAvailableAt, sibling, fresh, approval, pending, claude, claudeApproval,\n      usage, loginProfile: store.requireProfile(loginProfile.id), login, loginKey,\n      daemonGeneration: 1, bootId: inherited43.bootId };\n    retained44 = retained;\n  } else if (version === 45) {\n    assert.ok(retained44);\n    // Preserve the exact44 origin and account-login effect JSON, completing\n    // only its genuine pending receipt before the cancellation successor.\n    const { login, loginProfile } = retained44;\n    const loginId = \"canonical-auth45-synthetic-pending-login\";\n    store.completeAccountLoginMutation({ attemptId: login.id, profileId: loginProfile.id, processGeneration: 1,\n      receipt: { status: \"pending\", loginId } });\n    const cancellationKey = \"45000000-0000-4000-8000-000000000100\";\n    const cancellation = store.prepareMutation({ kind: \"account.login-cancel\", authorityId: loginProfile.id,\n      authorityGeneration: 1, request: { loginId }, idempotencyKey: cancellationKey });\n    store.beginLoginCancelMutationEffect({ attemptId: cancellation.id, profileId: loginProfile.id, processGeneration: 1, loginId });\n    clock.now = 45_001;\n    const bootId = \"boot_\" + \"5\".repeat(32);\n    const daemonGeneration = store.nextDaemonGeneration(bootId);\n    assert.equal(daemonGeneration, 2);\n    const recovery = store.recoverEffectStartedMutations();\n    assert.deepEqual(recovery.unresolved, []);\n    assert.deepEqual(recovery.recovered, [cancellation.id]);\n    assert.equal(store.readMutation(cancellationKey).state, \"ambiguous\");\n    assert.equal(store.readPendingLoginAuthority(loginProfile.id, 2)?.loginId, loginId);\n    assert.equal(store.isAccountMutationAuthorityCurrent({ attemptId: cancellation.id, profileId: loginProfile.id, originGeneration: 1 }), true);\n    // A real boot retires old runtime generations; never rewrite those rows.\n    // This fresh sibling is created after that boot for live continuation.\n    clock.now = 45_002;\n    const sibling = signIn(\"sibling45\");\n    const fresh = sessionWithRuntime(sibling, \"fresh45\");\n    const approval = reserve(fresh.session, 1);\n    const pending = pendingHuman(fresh.session, 2);\n    assert.equal(store.readAutorespondBudgetHistoryAvailableAt(fresh.session.id), null);\n    assert.equal(store.readAutorespondBudgetHistoryAvailableAt(retained44.heldSession.id), retained44.legacyAvailableAt);\n    const rows = snapshot(paths.database).rows;\n    assert.equal(rows.account_mutation_authority_rebinds.length, 1);\n    assert.deepEqual(rows.account_mutation_authority_rebinds.map((row: any) => ({\n      attempt_id: row.attempt_id, profile_id: row.profile_id, kind: row.kind, from_generation: row.from_generation, to_generation: row.to_generation,\n    })), [{ attempt_id: cancellation.id, profile_id: loginProfile.id, kind: \"account.login-cancel\", from_generation: 1, to_generation: 2 }]);\n    retained = { previous44: retained44, sibling, fresh, approval, pending, loginId, cancellation, cancellationKey,\n      loginProfile: store.requireProfile(loginProfile.id), daemonGeneration, bootId };\n    retained45 = retained;\n  } else {\n    assert.ok(retained45);\n    assert.deepEqual(store.readAutorespondAfterHoursPolicy(), { kind: \"autorespond_after_hours\", version: 1, revision: 1, enabled: false });\n    const policy = store.updateAutorespondAfterHoursPolicy({ enabled: true, expectedRevision: 1 });\n    assert.equal(policy.revision, 2);\n    assert.equal(policy.enabled, true);\n    const sibling = signIn(\"sibling46\");\n    const fresh = sessionWithRuntime(sibling, \"fresh46\");\n    const approval = reserve(fresh.session, 1);\n    const pending = pendingHuman(fresh.session, 2);\n    assert.equal(store.readAutorespondBudgetHistoryAvailableAt(fresh.session.id), null);\n    assert.equal(store.readPendingLoginAuthority(retained45.loginProfile.id, 2)?.loginId, retained45.loginId);\n    assert.equal(store.readMutation(retained45.cancellationKey).state, \"ambiguous\");\n    retained = { previous45: retained45, sibling, fresh, approval, pending, policy,\n      daemonGeneration: retained45.daemonGeneration, bootId: retained45.bootId };\n  }\n\n  const finalSnapshot = snapshot(paths.database);\n  assert.deepEqual(finalSnapshot.userVersion, { user_version: version });\n  assert.equal(finalSnapshot.rows.session_runtime_profiles.length, version === 44 ? 5 : version === 45 ? 6 : 7);\n  assert.equal(finalSnapshot.rows.session_turn_runtime_profiles.length, 0);\n  for (const table of [\"session_claude_process_authorities\", \"session_claude_process_launch_intents\"]) {\n    assert.equal(finalSnapshot.rows[table].length, 0);\n  }\n  if (version >= 45) {\n    // After their one real45 successor, all older effect preimages and\n    // historical runtime documents remain byte-identical, not reconstructed.\n    for (const table of [\"mutation_effect_evidence\", \"session_runtime_profiles\"]) {\n      for (const row of beforeMigration.rows[table]) assert.ok(finalSnapshot.rows[table].some((value) => JSON.stringify(value) === JSON.stringify(row)));\n    }\n  }\n  store.close();\n  const reopened = new StateStore(paths, { now: () => clock.now });\n  assert.deepEqual(snapshot(paths.database), finalSnapshot);\n  reopened.close();\n  const checkpoint = new Database(paths.database, { create: false, strict: true });\n  const checkpointResult = checkpoint.query(\"PRAGMA wal_checkpoint(TRUNCATE)\").get() as { busy: number };\n  checkpoint.close(false);\n  assert.equal(checkpointResult.busy, 0);\n  const beforeReadonly = hash(readFileSync(paths.database));\n  const readonly = new StateStore(paths, { readonly: true });\n  assert.deepEqual(snapshot(paths.database), finalSnapshot);\n  readonly.close();\n  const bytes = readFileSync(paths.database);\n  assert.equal(hash(bytes), beforeReadonly);\n  assert.ok(bytes.length < 4 * 1024 * 1024);\n  const metadata = {\n    ...definitions[version], schemaVersion: version, generatorSha256: hash(generatorSource), bunVersion: Bun.version, dependencies,\n    predecessorSchemaVersion: predecessorVersion, predecessorDatabaseSha256, fixedTime: clock.now,\n    sourceManifestSha256: hash(JSON.stringify(sourceFiles)), sourceFileCount: sourceFiles.length,\n    provenance: { syntheticControlPlaneOnly: true, archivedPublicApisOnly: true, nativeProviderEffects: 0, networkEffects: 0,\n      rawSqlRowOrSchemaWrites: false, randomizedIdentifiers: true, reservedUsageRevisionForEveryNewProfile: true, writableReopenUnchanged: true, readonlyReopenUnchanged: true,\n      readonlyDatabaseHashUnchanged: true, supplementalSyntheticRuntimeProfiles: true, providerRuntimeObservationClaim: false,\n      currentMergedAdmissionClaim: false, inheritedCanonical43BytesPreserved: true, actualCanonical44BudgetMigration: true,\n      actualCanonical45AuthSuccessor: version >= 45, actualCanonical46AfterHoursPolicy: version === 46 },\n    databaseSha256: hash(bytes), databaseBytes: bytes.length, checkpointResult, retained, snapshot: finalSnapshot,\n  };\n  const text = JSON.stringify(metadata);\n  assert.ok(Buffer.byteLength(text) < 8 * 1024 * 1024);\n  for (const forbidden of [root, \"/Users/\", \"/private/\", \"/tmp/\", \"/home/\", \"/Volumes/\"]) {\n    assert.equal(text.includes(forbidden), false);\n    assert.equal(bytes.includes(Buffer.from(forbidden)), false);\n  }\n  writeFileSync(join(directory, \"state.sqlite.gz\"), gzipSync(bytes), { mode: 0o600, flag: \"wx\" });\n  writeFileSync(join(directory, \"fixture.json\"), JSON.stringify(metadata, null, 2) + \"\\n\", { mode: 0o600, flag: \"wx\" });\n  writeFileSync(join(directory, \"source-manifest.json\"), JSON.stringify(sourceFiles, null, 2) + \"\\n\", { mode: 0o600, flag: \"wx\" });\n  summaries.push({ version, sourceCommit: definitions[version].sourceCommit, databaseSha256: hash(bytes), databaseBytes: bytes.length,\n    sourceManifestSha256: hash(JSON.stringify(sourceFiles)), sourceFileCount: sourceFiles.length,\n    sessions: finalSnapshot.rows.sessions.length, runtimeProfiles: finalSnapshot.rows.session_runtime_profiles.length,\n    queues: finalSnapshot.rows.queue_entries.length, archivedReopensUnchanged: true });\n  predecessorBytes = Buffer.from(bytes);\n  predecessorVersion = version;\n  verifySource(version);\n  assertInputUnchanged();\n}\nconsole.log(JSON.stringify({ generatorSha256: hash(generatorSource), summaries, inputCaptureUnchanged: true, earlierOriginalCapturesOpened: false }));\n\n";

const compressedImages = "H4sIAAAAAAAAE+y9e3AcR3rgWY0G0ABIouQZjzEyrZlSz6PRUoOsd3VBAmdAsEnBBAERj4E4NKcnqyoLKLG7qlVVDZKjlWdAUprxzHrPjznb6z/2vHG7IZ/lWT8i7PX57Ng9392e1xfhc3h9mjnf7Z7W4bjzrX3n2XWEQzu7vr3IenRXd1c/QFKihvp+UrDQmV9+mfnlo56Z39blNcvHjOm4deQzAvUYNTZGfZphKIqaoKgMoqjMZymKylBU1qEoapxqk6EoqkQNZoI69aNvT9AXqedmP0OSIPo/0H89+//R/5b+C/r/ov+E/pf0t+h/Qf8+/c/p/47+bfoN+h/S/wX9k/SP0l+mD+mX6Sbt0BZ9jd6lP0UL9AJdoD9E0/Q0nZ19e/bfzf7F7P85+9bsH8/+0ezvz/7u7O/M/tbsr8/+8uwvzP4DWqUvz/4Erc9+adaftWd/Zvbv0ZXZ12b/9uwX6F+Z3aefnNXof0yfpP/u7A/NfiYoFgAAAAAAAAAAAHDPZKqvfo6iMldfJXeP//bVOYrKvHD3sxSV2b2rUFRm865MUZnP3N2lKOqtuwWKymzf3aKozM7dbYqi/re7xymKunFXpSjq/7h7maIy5++8TFGZyh2PojLLd2yKyqh3MEVl5DtXKCoj3dmmqIx4h2gQ7mxSVIa/Q1Jxd56nqMzCnYsUlXnqzqcpKvPxOxJFZebukBxzdx6nKCr/EXIne2eaoqj/eIfc0v7F7S9QFPXntxsUlbn46g9SFPXtu1cpivqT26Qq//o2KeD/fvsSRVFfvUtuh//49gpFZbbublIUNRnU/Vt3cxRF/a+3WYqivnm7QFHUv7z7SYqi3rz9EYqifv/291AU9d/fJjn+1uEXKYr61UOPoqj/8tCkKOpnDolJ7h6SIl95leR15/AcRVG1Q5GiqBcPn6Ioyr37AkVlLr+6TFGUeXiMoqjPHZKS77oURW0aFEWtVymKeo7c2n56g6IolUieJgqe/iRFZR77GEVR3/u9FEV98NgJUuDHoKMDAAAAAAAAAAAAwKMMuf8vzf4cRb9Nf5v+M/ot+lv0H9C/S/9T+jfoX6Z/nv45+mfoH6O/Qn+Jvkk36H368/QL9PP0c/Sn6TLN0vM0Q3+YfoyeoqnZt2e/Pftns2/Nfmv2D2Z/d/afzv7G7C/P/vzszz3s+gEAAAAAAAAAAADfHUyWslSWeuOtyafJ8fW3J5+KjsXoOB8dC9Hxk9HxE9Hx49HxY9ExHx2fjI5MdPxodPxIdHwiOv5AdDwZHb8/Oj4eHT8cHeei4/dFxw9Fx++Njh+Mjh+Ijt8THR+LjnR0nI2OJ6Lj8eh4LDrORMfp6DgVHXPRcTI6TkTH8eiYjY5j0TETHsn9f4b+DYr+jYfd0gAAAAAAAAAAAAAAdHM+c4ya3s1Sxam56SnNcfyqOATq9bdR03cWbzjuda+BdNys+S4i9//ZEz9O0Y/Nzp34cbAzAAAAAAAAAADAu8ZhNnts91JhmqKyWeoS0nW/qvBlSTIM3eSRKpqaqJmaphllnhMwryJdXUG2Y1s6qoki08C2Ydl7TM3Zs2zGca09yw7+rkYx1BtvUW+8pQ9Jcngwdnz34ken9Q9ls4cfvRgUQ+IxRnyZKwu6KkploayIGCkaK5ha2cCG2SoGg5r+PqM1jT3sM56l1Sx7TxQ9a8/GRtWyW3kvELmFUG6hJfdpfBPVGzV8Snfqz9eaXljgA25Rdwx8c1GQNEUQJCwIOotUQzEM1hAV0zQ4QymXeRljbMoc5hDPCrzB8oKqyxInI4RMpOmsqA8u5WE9c3z38kenK0HFLwcV5yRFFzTT0DhZEU1dKpuqzpaRzquCaBom3654rO2W7e9j39IZpOtO0/ZT6h6K9lT29bep199uVVZlsYQExEoqz2NW4iRBNATTLPM6J5SRILBlASFJQ4qBNYkVWE6QFV3neBlrGq9Lmj60ZDPk/p++Q9HfpL9B34FxDgAAAAAAAAAAAADvEMXsbmak5zzZluSwRzFj89nd6ZGeXYT3/z9O0b9O/zEN7/8BAAAAAAAAAAAA4N3h49lLmWFfZ2Q/lr2YGfIhw9gnspenh7//h/3/AQAAAAAAAAAAAODRh7z/B/9/AAAAAAAAAAAAAPBoA/f/AAAAAAAAAAAAAPDoA/f/AAAAAAAAAAAAAPDoA/f/AAAAAAAAAAAAAPDoQ/b/mzhep+hPzX7txJsnPn68/rBLBAAAAAAAAADAI8GhOPHB3V1qdfXE43PTUx+iprNZ6nHKw55X1XRRFBVWVHROF1W5rEmapHM6Z2q8KJsyGsntWbpneb2GmgYWxXT/9HFseGzWfBdZRg2HXufDwMPT46TYFy6cmPtQXOy5sNiKIau8WJYFAfGipihIU3lOVzhFYUW+LOv3UWzTxd5+v1JHkYGX+H1rbz9RZBJ0yGdJiS+v9JYY67ouK4qBJcUQkWaUZaTqkqjxMka6xkojeY3rdmO/0NpXfqFm1S0fG61iiwKDai5Gxi0miuosdODwPiw0N0YKvZFSaFXhMSvpvIAwFmUZI45jy7LAs2VJRZyJ77fQYUCyzPim5flk3/0wqm+Zz2RImXd3estsKrxhcrIkqBIrmrqKBJaXNYkTBEOSJEm43zL7LrI93bUaHeVuhzIubiDLZTyn6eq4XwXI+/8J+jRFX6G/QZ+m79DffNiTBAAAAAAAAAAAAAA8dIrZ3cxIz6smWpLDHhGNtySHPZrJtiSHPQ8Zm8/uTo/0FCK4/5/9MkVj+sP0r8x+efYPOompaJAQAAAAAAAAAAgEeY58Z3VzMP4BuPiQvjuxfuR1H0YcX42vju5cwD+hYie3F8d+O+lYUBY+vju7vTD+7bgfD9/0mKXqVP0v+QvkH/i4fdFQAAAAAAAAAAAADgXWVhPLubod54a7T3/R3SQ9/5h9Kvvz3ae/8O6aHv/kvj2d3pWHrY+3+y/p96DHoWAAAAAAAAAAAAADzKwP7/AAAAAAAAAAAAAPDoQ97/Hxv/TWr2z2cvj//msbVjJ2d+Yur/nvqNqS9PTed+duzVh10+AACAXl69ls3NfeITma++4iOthg2E645d9Xzkd/w9vrJZWd6uMNvLZ9cqTDKGmZ9hGM+y92rYd2xmdX27cqGyyTy/uXppefMKc7FyhVl5rrJycb4ts8RwxdIMw+xhG7vItxLJ1je2mfWdtbUoTULizBLDBqk0x/GrlsFsV17YJr89H7k+NqrIj7WEoU6j0RE6U2IMbKJmza+iRsN1DlCtWncMHChqZ3yucn55Z22bKaCm7yyiWq0QlSU98eo6M98WLYV/3nDc614D6bhQKtSR3US1QrHYzt7bd25U/X3Lvk62xu2pelwCtivj7mTMPFviknobLvaw368+wabM3ZWJkgS1qDk3CqUC2d22UIqkQ+0Hlo6rulOvI9vwqqhWc25go3+5uVYe/RK2So503WnafrUWVmq47tgm/RNGuovM1vbm6sp2/VhuTnkic/hByzbwzYbrvIh136vWkIZr1aZtvdTEceDxqI/vrK9e3qkwq+vnKi8wqSmYjfVWxDzJ2J0PoovFvzWTmxOeyBxKQXaOjattSwfycbJjaZmlyHdkZXlxdJHZfa6yWWHaIWRUnZ6enFt5IkMFmXsv1SwfV0mHDH7HGr0qH/81c3pqpARc/Nf0nU/mcnNPPJF57aPBdBGHx8epjmkiDg2miGjEpkwMlsFcWNs4yxSIfPUqu6CiBfPaUwVmef0cU8P2nr8/bxlFZokRlGAGCGzd1c1DVZF02BjM2cr2bqWyznCBJk4O5w+XzB8N5O93aQhbgkgkjNpnXuqQiHvzDMPoLiYTZ2LW6U6ZkGjNaM2GMSRVQuLMUiKX4kwptEb1Or4V1Cfu94eTk2HHr8Qd37RqOO7GSPetAxwH5vp0/N4UUW8MIjo7ftQfw1PCk0tMwcV15wAbhdMTQ7pYmAsX/zX52th40MW+tht3sSA8Pk50d7EgdNQuFiz5fce7WGiFtNRhTDDdetaejY2q0/QLpULN2bPsagPbhmXvFUpxpGUXSgUX684Bdm9VXfxS03KxEYSF1g27XcN1dPKZ8vATaopkqxuS05plYLeK68gKK98R3KghuxX6MHp6sNV6NZ764x4fJSRl6olf3Qp1b2wGHYSJ27pHsrikCIEAaUavqXm+2ytU4kpqcalwwC0GUYuFEVKwxaCGYe976urnWl1vhmGKM8W+w3duLDf35JOZw1vBIKhbe2Free2/sh0DoR0e1PQAu16yGySGBGkH1GjUrIHtkJAIWm8mLtntD2Ryc0tLmTtKUDIP603X8m9VPd1tamRk7zvkd7/wsY5S95M6+kXlUnhJ6WLkOWEv7a5RGLVUqOuNatOtVV1skEnNsQtRynBwDbBJUqTTKOT+f3psgZr585nfnPmRmU/mPpUbG1uY/B8nz2SPwV0H0MFXZj+QmysUMv/Z1WAEvdTETVzFtu9a2Ov48aGOsdIRNer5Lkw08IRXDk9Z2CMTRnxj1e76m5Xzlc3K+kplK5bxgpQb68y5ylplu8KsLG+tLJ8Lrpzq2PPQXvqpL8p1ZXlrez6WW95izq5tnC12n0h5medEcfRzafvEaVheA/n6fvgrmsUKpYKJrFrwB6pr1l7TaXqFUkFHto5rJPzhXb5hO2wjj3QEW8ctHWHS3uj2Ka0nrtOIKssqnKrykqiIrKqyxVLCr0nVtGxUs74wys1Wn1Stu7hEPGmTptfvFtR2bBzfgfYmCloyECklGrSVI7kptdEBsmpk1JCW1JBtOHbYeslCWLaPbb/6YnwmIKfpnkyTQj2XCQwJrh6gmmX0SVMM5RLDKejYfTJo9fNnl2RJEmSSuH2Pejj5vcGEcHgxuCgOGzWyQMeon4smhPAKvUOOjMcO2fn2iC4lulyJIYM3ebG+xLSsrX5wcu5Sod+1eof6Ktfx8/ue+Z7JuY1iv6RxWYIcvSrX+fsDrxqP5eaKxczXstE1RTK289f3dF0/JOPCq4auiSw5OR5pLhtp4iFPesJ+amNMnnFED4faAbZ3A7vtn+EVR6lAOm50qJoOeXrRbHhxgI4OMPLJT6Q55OFWND8hn3SpAZf3SYHEbemAq6Ko84YSRebZJYaX5CDRAXY15Fv11m1Hv0zTBBOZt6JJn3BRdFfVlTSOS4zEqGTdImEZ2XDqrSHPD29NyUVk/wm4R641ebv4wOq4Uu655oviz9zjbJ+4SkR0bu7pJzKHuXCQRD2w6mId237887GOMd4lRHpqq+cm8jlX2VoJRvbp2UF32y1tfPwXffrESAniEevNfvUDx4Pb85+8kRyr8Sj1TqSNz5EvV4LFtiPcnke3/QOvVlrPKSwjTkOeRrXSdIpGD9haouEtr79PfK4lnzb7ll8beH0TCASdVODDHmM7PfNI64wYnw2T55BAvn1l9OwSw8lCWewoWT99wR1orLQlHExVYVSpEG7y1npykPLIOE497NFwK31Vd2zfRbo//KFwbwJmnivxoTaTDFNsBy8i+o2uLpnERDPaUxfytiC6OAweaRVKBeLMrVAq+Nitk4uN1Ecu0QQcJKn6Tbd1grmnSeRdv9Astft0Qmazspx4MNQTnZiM06LDcrWjDgT1SN0ySJDWNUsF8urALhSD8d8h/+RSFBcWqqMvLZFexCBX37cOOq0UnRyTMe2qJYNbpg4fhc6355lSyqTQef8/Of5b1OyHj89NZyb//eTC+G/BXS8AAO91btuTx6/sXj+ZzWamTt4Rwts6VlRkk9c13RBlUSiLZVaSJR2Vy7KKeEnURtqfZRP7yLIZfx8zrV1URZGJ71j3m3VkJ+7bo/DQAe9k9OvlfPQoO7/IlfLRo/VVI7+YH2l72nwpH8/bF1qvPAJVcfCKY9s4uCsjWu1mrUay8R03v5gPSpgv5X18088v5o9Yn3wp79Qtn7jx3UfkBIVdL7/IvnK4OnHsyu41YvDpjzZDe0sC4jgD8WWeFUVRKCOVUzRcZhWkm2WeFUbas+ZqoKv1EC56R8Qg08cu42Hfr+E6tv1r0VOx0H/tROsBS7epO22wj4xl30f6PlHh5RdNVPPwK3cnxo9f2UVh53n1elgZU5cNCZdVsYxYUeY1lcdIFgyJYwVT4lhupC116k3PZzTMBG8GtFY1okd24aur0Ddv3G+C6oyP1m+G7fr7QPvN6FXp02VKeZQ0/dWX89otH68F9wz5RbGUN6w97JGs8H2SL+Xr2LDQ9q0Gzi8GFTjdqCGL1MZGdRLWemi6cCAKp/ybfv6Va6+89sHs8Su7G2E/+OrjYT/QRFnSNA7LyBBEWSsjJCmqoJfLimlyhqSM1A+Cizz3ADOYXJAzulOrWcFwazieRUzX0fzZ92DzD63Bfbe6eZ+M0uqk1MSgC46Nw1YvvUcK5N9w3gsF8lAd/+U/+W3yKx4Vd3547PiV3UsfC2dH8uVQE1d509RkQzQ5rJRFTRfLuqiWFSSasqnxHIdHHRULLq5h5GEGmybW/QXddTwPG+FT4MRrkHBgjL03B8bAStz3uDDukxFaPVGHhdjo2Gh1AJw5fmX3Uyez2empk69uhB1A0DTeQGVeYnVWlBVVVcqCaiBWVGVV1QzhyB0gvgAJ1HdMh+/xRu8o+H23tn6fHLG1PWS2BjpZ/z85+5+o2f9Ev0G/ST9Ff4needjX9QAAAAAAAAAAAADwgHkqeyUz2nujybbosFceE23RYS8Uxtuiw545Z9uiwx7EjRWzV6ZHe2RD7v/HZ79BzX6D/kV6lx6DHgYAAAAAAAAAAAA8dLYndrNXMiN9wUm98daI9/UJpcM+XaBef3vE2/p7UTr0AcAWUTp9NKXD7v/J9/+5qZ+lZv/8xJvH/9tjvzjz09O3p372YTc0AAAAAADvTw5xjr62U9idPjxRpLLZqQ9RZI+AOtnKAxmyRq56FIMVBSygsiAhAyENmzqSMRZFNmAh+If8WCjHPwM4lo0+JT0VbF8WfEuq8GVJMgzd5JEqmpqomZqmGWWeEzCvIl3FEifxWGRlU5NUXjAFQZB0QUa8zJrlssZKooSUsiCoIsshzZSRwvNlrLBcuYxYrVwOvxMmGz6QfRHCtUJkz5DbH5iM63my2VlPkdd4Hkss0lnRQIKqK1gwWUlBsiaWTX1oPVk2Xi5/KrgaHOnKmdVVjHTBwJLJlyVVkWVNQaxkKpouYs3gNWyWNaMssKqGtDKHVF5WZEEr6wZnsIKCozU6L+eDLINvdUe7Es+/kjTKRB+jcBKHFUnXJF2URcMUVIGVBF1iOcyxZQ1zojDMKKraa5RhC5RMTdKQpMpG2ZBUpLCyaCiqjGRRQ0hkdSyWsSSpsigJpswqHCtKkiSrLKfyrII0Re5rlGHvEvOvhN9Dh0YZ72OUsqaxiq5gjVNEkS+bGmuKksqbrGlKpihrw43CCb1GGXaToZRNrmxoiOcFXtBFXmUlSeVRWRB0RSmbsqDohiQj3dTLGldGskq6lmDwIockUxPZvkYZdnvVaZRsP6OUDcPghbJSlsoiq3JlAQmI53nOLJs6J4gjGIU/ulF4URN1rEimrpk8J5V5ndNZJHCipqmY9BuV5UxN5USd42RZkSVJFyXdLCvBxKHofY0y7Paw0yhjfYwiYw4ZrCmrWGZFjeWRzHOqIamGaAiqLikjGIU7ulEEBesKKnNc2eA1pCuIlSVWYw2EdJ3F5bIgaaJp6JIic5yJJUPlNY5nJdnQFdXAHN/XKMPehHcaJdPHKKJuGqzKyhwvqiI2VU1ArGoIoiBJPC/K6ghGYY9uFGxIgiZpZUUXZZnlFJ5nRcks82VdlzAnimVT5FTSXGaZlTSsybwqmmSOEcsyIhNPP6MMu+dPGoW8/8/N/jOKZug/ol+nv0Bfmv2r2X/2sM/9AAAAAAAAAAAAAJBGKXstM+rT4VyH8JBHrJNJ4WGPHieSwsMeyY13CA95VJVNCg97hDP2dPba9KiPNsL7/z+h6G/Rv0S/Rl+jRfrY7J9ALwMAAAAAAAAAAAC+25jP7mRG+SIsN5Igy/KTgeAInxlNjCbICeMjCvLZEQW5sUJ2Z3qUzxbI9/8Z+mWKfvlhtxMAAAAAAAAAAAAAPJIcjmVyu9NZ4fDESA6hqDfeejnvOz6qbTvXse3lFzmWfYVl1XLZVGVDUBWd12RsIkWSNFkjHxHwLFlEpGmYR4bCK0iTOKSpmskrwdIcgzWD7/8z9JsU/ebDNgcAAAAAAAAAAAAAAEejOL47PT3SUwXy/p96DOwLAAAAAAAAAAAAAI8y5P0/3P8DAAAAAAAAAAAAwKMN3P8DAAAAAAAAAAAAwKMPfP8PAAAAAAAAAAAAAI8+8P4fAAAAAAAAAAAAAB59Tkzq1EzmNWry79N/i1ZPHJxQjn3l2MVjs5nX6H/ysMv2/uFHPvtEbm5hIfMTez7SatjA3nXfaVS9G5av72Ov+zezsllZ3q4w28tn1ypMT+z8DMMg38f1hl+1DGa78sI28/zm6qXlzSvMxcoVZrNyvrJZWV+pbDH1po98y7Grkbw3bxnF0gzDeE7T1XG14TqmVcMtNYmkUVQrhY/cPez3pFjf2GbWd9bWBiWNMtvDNnaD4jCr69uVC5XNhN7eyJZqItXYRx7uynHlucrKxfkwZnWdmS80XNxALjYKpcJLTcuvej5y/fZP3bFNy60HATXUtPX9hMQBdi3zViIANRo1K/jLRFYtDKpr1l7TaXqFYlAvw0J7tuP5ll7VHSMsHglvNgzkY6OK/J66RIVOSJxZYtjiTIkJmzfNDmGSlPitUOXGZkriMwxbLDEvOk3XRrVqbJne8pyrnF/eWdtmuCiblBTMPFviiglthrWHPT9sjc5UUUyiZDVs7/n7XQJFZomRxWKJ0Zq2UcNV3ajuI28/NGCrb1pGtwkSEYm6t0PDSuObDawH1tV1p2n71ev4VqQ6bHZspCjvjEpUIBkeZtDqB1XTderVRN8MVaXGJ1Smxz/gHkwazMW6c4DdW1UDI6Nm2TjZJcOypou0y5oaH/TZIrO1vbm6sk1R1Jl7nxq/8uKHcnOnT2d+PBtMjT0TVk/Ahzsmx57oYHZMmxXD6loGc2Ft4yxTiCfQq+yCihbMa08VmOX1c3F3tQzSRUU2GOaWgesNx8e2fqvVldoDaGd99fJOhchdt+zuSTHqWqFSEl9kzla2dyuVdYYL8iuHWaCmv++4ln+rd17tUJGU61bFs926BsypcU9Nkw1al2hy8UtN7Pkd4z29XJ2S8fAmU7+P/PR5O4zp7vXYNLHujzoNlwo6snVcI+HhlOxir1nzqy96jt2ajnUXD5mOExKtyh91Em/rILO57yLb012r4VdNy0Y16wuDJl820tgnVWsCTsQT8zW9LsvG+gq2Y+NCr9IoUWD0QKRUaGDbsOw9Yt84x0Kp0LTRAbJqZEQSg2vINhw7mlQS+izbx3bC2jMM05tpUigxsZBxyjAMCa4eoJpl9ElTDOUSg3NleWu7XwbLW8zZtY2zxeKzS7IkCTJJXGxNVc/8wOTcRjFDWbaBb3ov1SwfV1HTd4LfVb/p2lWvWa8j18Jele/8/dFnTh4hMdf5+yN3St+fmysWM699MJjmOmM7fz3RMcF1xgVW87DnkSlv0CVYJBNcgjEb68y5ylplu8KsLG+tLJ8LZqtAcbeKYMiSsWzruF+3b8W3hkpYvFvtftBnlggarkO41VzMs0sMx4plSZGL9z5mE/P9fNtKpbiugUw4X3dExzUqzsQdZenxybnLT/dr66aH9nDVs1HD23d8r8p1BfzAnU9/ODf39NOZ15Sgtbuiu36e7GjvrsigwY96zZ3e4NF1kosPLFLzvs3bJdYyrqN52D0Y2CZJkVa6BrpVc5AxWu/oEO7oHbzMc2J4Uhl+Puo5DyV7RtucrWvNuLbtHrA8Nzm3c7pfD+i57KjyPUHfv/x9R1PB9QQ9/qmPTM5tLfRT0X1nWOW6Q54k3/9PnPhViv4xmpn95VnuxK8+yPtaAAAAAAAAAAAA4N55ZWJid1fPkucTVU0XRVFhRUXndFGVy5qkSTqnc6bGi7Ipo5FcwOnIdmxLR7UF8rR3QWsae9hf8CytZtl7ovhpfBPVGzV8Snfq1BtvvTLezl4xZJUXy7IgIF7UFAVpKs/pCqcorMiXZf0dyN7OTuzuVsLssa7rsqIYWFIMEWlGWUaqLokaL2Oka6wUZM9Jii5opqFxsiKaulQ2VZ0tI51XBdE0TL6dfZhzR36vv22PtfNTFR6zks4LCGNRljHiOLYsCzxbllTEmfiB5Jdp52cqvGFysiSoEiuauooElpc1iRMEQ5IkSXgQ+ZHv/yfo0xR9hf4GfZq+Q38TxiYAAAAAAAAAAADwvqeY3c2M9ORloiU57CHJeEty2POMbEty2JOIsfns7vRIzxDI+/8x+hpF/yP62vu+dQEAAAAAAAAAAADgXtgYO7Y7NXeS+mgmm80Gb+sVvixJhqGbPFJFUxM1U9M0o8xzAuZVpKtkmfDNOrLRHjZ0h7yn97ExRr3xVvj/8xmi8ImjKmxg13NsVEvRSN7/j9E/Rr7//11oZAAAAAAAAAAAAAB4d1AmdudOZo78rGCMpHti+uiPBML1/1cp+tbsv5u9fuJPT1yFlgYAAAAAAAAAADgih5MTud3HTx4+Odpafb2GmgaO7ucOuMXw96LIi2xZF3UWi6oqSqrAmgZvlnVNkhVWVHmsSSqWRFPieVkXVUEwZVHi+bLEShxnGiz1xluH4+O53bmThx8dbdV+8r6SlIP8XBQkTREECQuCziLVUAyDNUTFNA3OUMplXsYYmzKHOcSzAm+wvKDqssTJCCETaTorBsXIJosx7Gv31GKoLJaQgFhJ5ckX8JwkiIZgmmVe54QyEgS2LCAkaUgxsCaxAssJsqLrHC9jTeN1SaNef/twfCxZjGGf0r9zxcgkizHsO/13qhiw/h8AAAAAAAAAAAAA3h/r/6nHoKUBAAAAAAAAAAAA4FGGvP+H+38AAAAAAAAAAAAAeLQh7/+zmdeozGv0T49/NXM6i7P4YZfp/cdrmY/n5nZ2Ml/FPtJqmHy5YTl2teE6B5aB3SrSdadp+1XiIdNxLd/C3igyhZXNyvJ2hdlePrtWYUZJwczPMC1By2C2Ky9sM89vrl5a3rzCXKxcYTYr5yublfWVylYs5s1bRpHZWGfOVdYq2xVmZXlrZflcpTTDMHFOoZr1jW1mfWdtjVl5rrJycb4VubrOzBeCBS2FUiFc9VQoFkl6t2n7Vh1XPd1p4FQlnRKBpmiRTKFUiPe4iLTF1b2Ob6XqmmEYhmkVaykqErO8fo6pYXvP359PaCguKUKQgAkEvKbm+W5SoMSV1OJSobVWpzBEmi0G5bmwtnGWKTx19XPsgooWzGtPFYpBwo3NnuKFlupfPnFY+Tg2KmC40mxYCblBJQzbC+uOa2CjinxmdX27cqGy2dNgCZEzSwxbnCkyW9ubqyvbPzXzydzcykrmjZMdYwAZTsMnf+jINiwD+e2unxJVTO3xKYJBR7/f/tkaSf6+i5HRGjBdmqLW6ZUuMmcr27uVyjrDBVbnWTbW+yLW/VgfCfItv4YHaV9Z3tqeD6WWt5izaxtni93qBb6lPiyI5yM/XWmXSGACpPvWAS6UCpZRIwcfu3UrObxIdNVvuu2ZI1TWFbO6Fea0sdnut0mBXquI5c5yNxukDYM+tFlZ7ilzIjqRV1p00AOJ6pp1gG3seekWjiMDM5BfhVLBdvxq9GfTvm47N+zIDp7TdHVcbZCaRmMgVJOMaBcrGXyGYcPR1w56dolRWVbhVJWXREVkVZXrzqZqOHVk2UmL90YmckyJJPUykHvDsgulQs2ymze7KuM6OukKrp+WSzuyt2mDbtkr2K+LcnzY1HoNWfWg8zXT26RDICh/A9uGZe+FY9Sqh38GIz84GZjY1rERVas1D1RNy97DbsO1bH/Q6EpNUFySxaDU6erCifJqe5okOYfF6M02zC0lNtlVosL0SrVKkqKgpxjRVH1gkbmx/zwdxXe2T09fDOpkuZ5fNSxPdw6wO3D6TxNtD0Lk+VVH87B7MFBJj9yZpbQytHXq+8jeG64yIRbXOq28wQm3qwjtvJDv43qDHLuGf09sYqx0RQ2rD5l3Ug2VuJDpI5joTdHpPlXw2aXuGiYuDuKU7Rk5vlhqRST0d8mF589EXNeER0oYtU1foeSkNli2c2rqlg0vreJj6zKmdaaIz8Ou43QM00A8XSrNwImZMD1Rv9mwzKl870VZqg5yOVdcKpwudFYlceneSldKuRAhssmr4OT0uhTPnf1mmIRp44vVTg1PjqQiSt5TlpTzZv/u0B3bc25ql3BmcN8c2i9H7ZOj9ceg6q2L4b1PTM69vJOhLNvAN72XapaPyW2aE/yujnInV+VGkZqH7/8BAAAAAAAAAAAA4NEHvv8HAAAAAAAAAAAAgEcfuP8HAAAAAAAAAAAAgEcf8v3/CeoulV049jfHfvaYMj0xdW7yX0+cHP+97N2xt8Z+krq7tJR57fFgSW696aNgGS02TbLuBJNlBbbeN5zvWIzbT4qZv3tczM1JUubLz3Rm42LPqTXJn15amJKuPiERrPGI11UNWc3eSh/JB8vaw5Vysb7qdctOX+HbLRMuSHSdA2xXUaNRs8L16B2LaqtkKbStW7UgDmnINhy7tUIxtk71Rc+xh6777ZTuXU7EhwtpZZ4TxXilNrYafkJ7a3l2O7zPas4OmXZezy4lM9Bd3FqDm77kLiHRuRD8ojA5V1WHrX0JVtG0GqvKp4fLF/l7UMalh0s7hck5a2WYspTV5m2NKZFP3V7hcnOqmrn7ZMfK987M00PF1PXunTIPZBR07wnRasyd9dXLO5V4RXBbKlx2Gvggaa89TW5W0JYtMkuMoNxvt9lgJ+f0pX6N02/2qXL9YoQ7K6dzc+/87PcAGqfvvBSZmsT3rC1k3415ppXAsPawN3CJdZco6RSyeP/bStz+/ELupFqYunvdd629Pey+1MRNXPVdZHtWYM29JnKNMBTbvmthL265zdULJK/0FMzZyvmNzQqz8/w5Irxxngn3SthYZzqUzew+V1kPykuaen5j7dypUHCJaa1ZD8y2XtmNYsL1+JbXQL6+H61pR7aOa+RcUSyGm4F0akpKp2lrn4VMFJ9y6pq113SaXqFYnCnOnK1cWF1ntiprlZVtZnN5dasyv3x2Y3O7xBSsWg3voVpYL6ZtiELxGaayfu7wTCk3d2khc5sOxpqBveu+06h6Nyxf36/uYRu7Yb9t2tZLTdwZjz0uMnc0k6yun6u8wAxTMsMQQ3ermu8RLzK7z1U2K0xPRHIB5t3TTwcj/csvBSO9K+94ueStfuFsx0jvJxVurWPZezXsJ9bdJ8d6NIm2ZJaYcIG93nRdbPsdpe8zO/ZKtpbXx3Hds83QGYZxcQ0jDxsDC3Cucn55Z22bYVtDsjcRKUvQO9Min11KqWjvyuTeGsZKUyoYL/pt7Z+TZqDByRMrm9uzCnpqcq65MXR9brQBUTXepkizgvGeuFzpK3IKFe8vC26oyMJXqPnc3MZG5u84ndtO9UswVKCUvuFUP/H31m5T79RuPv132UnbXMfAPoon/fDv1j3Bg9yzI9oYZcApNSHRmkKSO+ukp+rcXKetI0ge16d3y4qOmPZtRzK4V114whi6rwE5S69eWB+6B0IwQfT2uLRL9iPtpRC08lLcwkGTpFS3vS9BJN/uCEdMEm+z0J0idSIj9/8Z+jsU/Z2H/SQCAAAAAAAAAAAAAIAHz3hmnJqC7/8BAAAAAAAAAAAA4H1A+P5/g6I3HnZJAAAAAAAAAAAAAOC7hsNTmdy1wvXDE9l4FZGJDFkTTV1VDFYUsIDKgoQMhDRs6kjGOHLKd6rm7Fn2y3myVDO/mO8IzZfydezvOyTCwAeWjqtkAUv+FUMXeZXDqiCJosGJmmDqZtnASBJRmeMMHcusIMoyEmSO5zidHGQVSaZGBGTJpN54i+z/l6H/iKL/6GGbDgAAAAAAAAAAAACAo/B09tr0qI8fyPt/6jGwLwAAAAAAAAAAAAA8yoD/PwAAAAAAAAAAAAB49IH7fwAAAAAAAAAAAAB49IHv/wEAAAAAAAAAAADg0Qfe/wMAAAAAAAAAAADAo8+J8Qx1gipR078y9Wu5/3rydye+Of7t8Wnqr7K/SJVm/8OJv575zsx/NfPCzAtE9vDcmdycvpw5fMmyDXzTwN5132lUvRuWr+9XXew5taZvOXZ1D9vYRcGfTdt6qYn7inrPrmxWlrcrzM766uWdCrO6fq7yAnMEzTMMs7HeP4E3HwW1ExZflZ/NzS0vZ37kho+02oCy9Y9ZjEq9vXx2rTIgd2Z+hmHirRgtg9muvLDNPL+5eml58wpzsXKF2aycr2xW1lcqW11asDffTlcszTBMT0WY1fXtyoXKJrO+sc2s76ytMSvPVVYu9taYOcOwgYqEIYmfibA4Xam7ZVbXmflCEHiAjSpqNGoWNgqldpDt+K3gYpCNYaE92/F8Sw/8VKRm0y1zYW3jLFO4urzw2WtPFZjl9XNMDdt7/n63YJE5W9nerVTWGS6QKoc1czQPuwdhxzCsPez5qblGOnuli8wSI4uRkXRsNfzqi55jD1Kysry1Pd8hvLzFnF3bOFtsl5EPysjLPCfGymND+v2aLylyZolhizNFZmt7c3Vle2tpcm5vOUMFo897qWb5uIqavhP8rvbvhVWuf9wz09+hpoLBbTyTO7krTd2+4LvW3h52600/tFBSk1UnwVoNVw1cwz5OE4rHxubqBVK9kfTMnK2c39isMOcqa5XtChnSaclmzlYurK4zW5W1yso2s7m8ulWZXz67sbldYgqxfKKTM5bHtDIqFJ9hKuvnDo3FI1Wz2TDQg6hmqCeu5s7z55bf2Wraau7kVXXq9lZUTQ97HsnG85HrV6Oppbcd0sW6qjqirt42TU84qLpRCiZIwWiWbVj2XnqFy0escNgiD6bC/Vr3nazwLSV3sro0dRt1d2Rsmlj3q/jAMrCt4/5jtkuwX4cepm/A2O1KOlLHDtMwcZr0ustHrnvXQL7vug8d0O9Q3S9Ik3NXpX4ngdRZiEsLLVNUhno/8+qt5dzJiwtTX5uIOlHXSdJ3ke1Z4VVnE7lG9/VZV5cZkprp6ijnmcY+8nDvxSv2Znafq6wHVwXk6nF+Y+3cqVB2iSk0XNxALjbCS6T1ym4UFVyltSJLhZealh/OOsHPGmra+n4iwERWLfgD1TVrr+k0vUKxyGxs9mTYoSgt066cgp+6Y5uWWx89g3aCvlkkdfZUZ1gmXQnSMunReYBdy7x1hEy6EqRl0quzdT3dqz2pvKVnpjhoIrFqNbyHanGXiu4ZmHZnjCaR22Ofzp3Ul6duX0/v+4Mu1fqLDh4RR7v86594UP276j34Gun22KfuwQjhvP9gjdDvXPIuGAG+/wcAAAAAAAAAAACARx/4/h8AAAAAAAAAAAAAHn3g/h8AAAAAAAAAAAAAHn3I9/8Tk79DzX7k+Kdn0NQXJ3/nYZcIAAAAAEbhzuLEsd3pwpXd6exdnCXr56uaLoqiwoqKzumiKpc1SZN0TudMjRdlU0Ydy/J1ZDu2paPaAmr6+wta09jD/oLbtH2rjhf0GmoaWBSRrvtViccY8WWuLOiqKJWFsiJipGisYGplAxsm9cZbL+cbrmNaNbxq5BfzI6XKl0gaHXvehdaWLflFrpQPtynBxrKfXxRFlmWJIPawn1/Mm2QN30Id3cyX8nXHwLX8Yj4s60IYJS1w+VLexchzbMveq5im45KEYZJQ9DPYJXbIL+b5U9wpXmZJUbBbtwLzXHIMnF/MG9hEzZpPEpEluHvPOXUSbHlOjSyEzJfyTtNvNP3zjltHJAfPdzGqL5AtUfKlvGX3i3uFeuOtO9Vx0ni7u9PZV7mw8RRDVnmxLAsC4kVNUZCm8pyucIrCinxZ1o/QeKaLvf33XtvtW3v7iWbba/gL0il5wXNqA1qMqLN0vG1hN79oN2u1Ut5Enp9fNFHNw6U8ajRc5wDVnndqln4rv5h37AUXv9TEHmk6Fx9Y+EbUomS7gGoY0tHgz4e1zy/mF2847nWvgXQcNHu90fSxu+Ph/KLvNnEp36g19yx7BTWQZtUs/1Ycju1gR6XlRsPLL169FrTwD2VJC19OtDDWdV1WFANLiiEizSjLSNUlUeNljHSNldJbWBS6m7dm1S0fG0FDcZKiC5ppaJysiKYulU1VZ8tI51VBNA2Tp15/O6V5h6UarXmF923zvv72natjpHk3Es2rKjxmJZ0XEMaiLGPEcWxZFni2LKmIM/GozRv+hNZ9mK1bzXRPz6bCGyYnS4IqsaKpq0hgeVmTOEEwJEmShFFbN9iTQHetBrTww2xh8v5/gn6KonfoN+in6C/Rb8JVJwAAAAAAAAAAAPB+5qnx3enMSK8XJtqiwx5mj7dFhz0VzbZFhz1hGyuO705Pj/S4Jrj/n/1LavYv6Xn6P6c/T//zh21nAAAAAAAAAAAAALhvyuOFK5l7+PxvQhkv7GaO/unZuDheuJw54gdNWWG8sDFyovDnmDxe2J0++scXJ8Y/RM1SL1BTP5D7n3JfmPzgxIfHnxhbz/7eiX9/4ueP/zfHfj+zRb1AvU6tUWtHM/ThzY3QRU81cq7wUhM3cewUZ5AviH6CXY4VRtbX61uiX9JBThWCNLF/niG+t26uH7nqoQeIB1f1fh4l3uGq3771XG5OUTKvfk8Q2pFb7NQoNXC5w6FiqkjgDSeMGeJJMUpu+66FvfnIfWLLhdNIfv06pUdw7NdKMNz7YJdop+tBxzWGeAdsi3R6B1xdnZy7pvRzDJVq0iqXGnz22Mcjn4A3L3T25Hh+ieaRavRBZX8/ct2CfRyrDdXX35dcd9JRnKtFaZgoTfogPn/kqnd6lLv/qg/zKvcOVf22UcmdvLo0dfeZwVUnvWvfcS3/Vuji6v4q3q0trvbq+lZlc3tgtVv+siovrG5tb5F5IrIBx5zf3LgUp/QYb4Zhdp+rbFYY75RlLBGvSrFWywiGtHcqLk8U3/452PVSt2Fjg7eqxdQtr458fT8y88a5yTl9qd947ds9+H4xn9pYuSeFXL+YM69NnM3NLS1lvvZE0D36yfULX+qY0/tJBdN6ohE6J87ErB43Yjyhky8kAwv3nSmj+Nj7rec0XR3393ybjA+8dXVcTRVKBb/ptn+EM2f4K3R7G6XvqUPH5N8S6nZky7NhKdv9rb8pYtvFpoi+UR/BN3CKZHAWafvQHXj2SYq00sUlHunE2iE8ksPco58SSbrEpcF8u3eVWr0mEAqdTicbvtRuxfaZlaKoX/juuPc6fPFS7uQVZer2RtqlZ18PnqlSgy46j+ALNDXdyJebA72Avrh2tMqmXGTfY2VHurx+oJXduDhocu97R8D1izl3d/wHg8n9yyd7L9UTcn1vSfpfsHf7Pz/KNXun5ebjpPfnvZysnMF2wnc50pBtOHbLYfk7fG/Q61G8NXG1w1e3wvw2NpkRHIw/u5TMQHcxWYo3YI5MSHTeNYD/PwAAAAAAAAAAAAB49IH9/wEAAAAAAAAAAADg0Qfe/wMAAAAAAAAAAADAow+8/wcAAAAAAAAAAACARx94/w8AAAAAAAAAAAAAjz7w/h8AAAAAAAAAAAAAHn3g/h8AAAAAAAAAAAAA3h/f/+fGXqKOf+rYnx77kemPT304d3zspcxPUVTmp8i/FDV26WGXEXiE+JEPfyY3pyiZH9/ocCqND7DtVz3fxajupQauprqT7hBJ9SXdx+Fo0p00cd0aeaxdWd5aWT5XCfw5B0qruOHo+6lOQWcYhomddSaFi8wSI8hBbOBSvKl5vtshUVJLHJEqLBQGinHiiHIj6uM79AW+Q2180696xP8r8Tzbx31op1Cn42qVZRVOVXlJVERWVblAq1lzHHeo2i6pTr0deXY6qPb3Xae5tz9Uf2CL/qni/NjUerQM2V/BUpf1FhiSKvL56iPLxkZVd5r2ANfVHVIt79WtcO2Wj72hqUOpZGpsBz5w91Cj6mLU43c2JT7hfzY9fj0YXQxTaEcHpS6UEiFoD3f8DkoW9LV7dFRLUoXelgelSkicWUrk0uHlO+EFvGO0tnzh3p7eyZ20LkzdrkcOpeMkgeP3bsf1Pb6vB0p3OZg+muZer9oD0w9yOE0SMFGC2HN7mr/p29Pb92aLsCneCVv0c7r9jtvirraVO4kvTH3lYyPYgnjl3ndcy79V3Wsi13hQlujWG9thdX2rsrk93A67z1XWg2FTeWF1a3uLjOXIKBxzfnPjUit5d0qmMcMwu89VNitM41R7EC2tV3YTP1uzZeOU5zRdHQf+t0Oh9u9eqVhR/CshEVc8Emn/7JTRsedV97CNXUSmnFi2KziRpjWfIz8QTvxOyZ043u7InwTMFI/cr8IaMq1WZOqWV0e+vh91siubk3P1C/0cvA8eI/zA6AtXLt+7am5g9Pkvn3k+N3fhQuZHX+64mksVHhhZSb26SxVNvcprnRD6XOKRE0GgrSdBh4P3SKTYdS3Cs+GZKNGVU7Uk4wPX84E+z0cuOU2G3uzDX+H5sNXtB5WpJdSvVO2R0d8WsfFiW/SOkH7n1hTJ1pk5MXT6JU+KtNIlx9Kgqq8sb23PdwgvbzFn1zbOFtu24ENbyDwnih3KDWsPe/4g9Z2S5MJYDlW4WHdcY2C9kiKteiXuNTquN+JulbwcaXeVUrsfBBJkXl+9sB5qSRcLJqrert4zVvqmj695yP3/xCxH0f9g9kdn/4J+bpZ72DeIAAAAAAAAAAAAwHuCz04c292Znp6amqKyWXLbWdV0URQVVlR0ThdVuaxJmqRzOmdqvCibMpJlU2BVSVoQJFNeEA2RW9BUzC1gXBZETdV0zGHqjbeoN966NnZsdyczPT09FutWFR6zks4LCGNRljHiOLYsCzxbllTEmZhHJisJgrkgaGVpQSwr0oLKquqCZLAGKnOyZpj6WOZvqNffpl5/+7PZ7qJjXddlRTGwpBgi0oyyjFRdEjVexkjXWMk0NEHAprKglFluQWQlcwEJCC/IrKZIEtYljZUj3ePduhVDVnmxLAsC4kVNUZCm8pyucIrCinxZ1hVkcFiRywuyrMkLoqSJC5qgyQuSqvK6ZmqyxKPQLJ/NdOs2Fd4wOVkSVIkVTV1FAsvLmsQJgiFJkiTIEos5oSwvYAEHJi8vqKzCLpRZ3hQlTtBYUQnLTb7/n6BPU/QV+hv0afoO/c2H3cEAAAAAAAAAAAAA4KFTzO5mRnroMdGSHPYcYLwlOexpRLYlOeyxyNh8dnd6pCcFwf3/7AE1+z/Q+uwB/b30rz5sEwMAAAAAAAAAAACPDuvjuzuZB/bxwERb3YN46T7eVvcgvg/IttU9kK8ZLo3v7kw/sK8AyPf/mRNfok586WH3CQAAAAAAAAAAgEebu69kju/uTGd3p6mv5MYe3G0i9frbSNf9KicpuqCZhsbJimjqUtlUdbaMdF4VRNMw+ZfzB9glS8fzi1wpHy0jXzXyi/mRipIv5cO9dCpkK538Yn6UspFE0ZZJQa7xUvplP78oCizLlvJID/YWCgoyUj3ypXzDdQ4sA7sXWhsVBNrj4BXHtrFOgolWu1mrlfKaY9zKL76c9281cH4x3/SwW61jz0N7pGZk1X5QAqeBXmri6gFf5TiEWEU1jTKLTNk0JUFGpqzorMqysqYIpqZIginwhqwIWFSRyoumKrI8MnRB5EVSzHARfqA33BBCEhDHGYgv86woikIZqZyi4TKrIN0s86yQJ+bwHTe/mN9v1pFNSoZv+vnF/NYt29/HvqUz+5bnO66loxoTyDC6Y/uW3QzNUMo7dcv3sbGyj1yk+9j18ovsK69k/maMvP/P0G9S9JsPeyQAAAAAAAAAAAAAAHA0iuO709MjPcA5Mf5pairzderY98/8z8dfyD07+esT/8/Yv8l8PfP1zDL5Dyz/7nN7q5o7eak4dfeZrv2Gg83uvWr0cMyy97p2ng7j+2wq3C/xzPL57cpmyt7SYYJwo1uyb2W44XLqxvvBZsLbXZueL3X+XODI3paEzn3Llzp/LmysnTsVKg9+tzYfTmw9TEQSG8AGu90ndvQO4xMBz8yQHa23PjeqVS3bw65/j1YNE0dW7d2d+QFb9enRrPo02cF4iFU7N3TutWoQ323V3K3MN2CO+C7h8PwP5U5eLE7d7t7IPOrF/XZxH2UEjL5Pe3IEpG+gHUkygWTajuyH2au5Oa6YOVTDPa27BuNeV8k3oqKvrp+rvNAzdPfwDNNbvo79exOb/ZaYlk+KZz47ObdRHLavdpQN1/n70jGc/czD7g8A8Gix+sLk3DVlpCEZn2Xbu+d3BF9c3T26Ki41+Acpivor6v3Flz9xJTdXLGb+zkSvm6dO/07eWn/HToP3+h/spCmIHeIg6Cguje51T/jo0vCou/MH76xH256/RzS5z34YqbdefrfK0ZW8UyLhDai9V36KYOjqKsgr7PJ9d/QnEdUDVLOM+bZk6AUhcV060JNTUm6JSboISOTdchDQ8uWRTNbpNEAmH8kHHpuIpV6MahV9ENFblHOV88s7a8RhSst2vWmYea7EFwd6A+hwatWx2X9fF0V9tvvvmGb6J+/1b9ba/z98//+HFP2HD3vGAAAAAAAAAAAAAABgdBYmdrMjvvynXn+brP8fO/Y6deKPjr0OVgYAAAAAAACA9wR3nxr7yM7u7vTO49TO7uGJVXKdf3J6+vYeRWWzVJaiRJENWAj+IT8WyvHPCGGkDdeC1dYSjzHiy1xZ0FVRKgtlRcRI0VjB1MoGNsx+uakJPN+17L1RymX5uH5ad+p1ZBuVm1hvkleqp13yltTzlxvkzTOqoftER7ZjkwXSC6jp7y9oTWMP+wt6DTUNLIpR7lUU5dbAtmHZey/nieP0/GK+O56s427W68i9lV/Mb+IDC99gvNZq7Eg6T5a2I4+sQw+Xm0fhKzXkefnFvI89P1/K33Dc65a9d85yMVnmfSuWRgfIqpGPJ85h3SIvdr384tW8Q1bNl/IG1muWTf7Ska3jWv7aK6GzuB/4GHO3mEl2lgv30lm4kbbTe/c7C/cQO4vpYm//Eesr5P3/GP1LFP0t+pce9iQHAAAAAAAAAAAAAEDAfHYnM8ojtbFCdmd6lMcp5P3/BHWdoq7Tvzb7j0/89vHfescs/TPrn8/NKUrml58JlgS1FpRYto/JroTkqUVq4PMdC4RSRYJ1Qo2mVrP01gKXxPKLaMFGvJQllkusXuleY9S72CK5OIcs1jnqgh6dPFAbaT1Pt2RrOU/KKp6u1FEN+63RiR6TVS2jSra8TFXRLUOWtBTsZl3DbqFUCB/UFcIFLgnRUKBVqR5VcXx7XVFvZLw4Z6F7/dWgRVntwuKbfnJlU3dU75KmLoli1yowieODPOrY33cGmjuU6Jc+zsaw9rDnD9LTKUnaTRYDFf6+i5HRtXSrHdhbtVZcv0KRvU279UVBKdrCmH66yCPZLl1xUK+uKKafrvihaZe+ZHCvzkRsP73k2Wyq6YMI0seDNVaF7oe3hVIhGOz6PrL3cDK4gd26FU4aidBgC1nLbjT9QqlQ1xtVXLN0yw8GcoEsNQtnGx/56aMvjGmXJ3q4XCgVXOw1HNvD1YaLG8jFRjLshkv2d7XDIKd2EMRGz33Jn+GD3+BPfLNhtVI7teD5ebVpX7edG4kSuvggeI7cf6ljFH8mmpu0mqOTR9P9EiTimXm2xIXZGJbXqKFbIy0bTMoWg8ZNLgHs0NRaBJi24C+qX2S55KiMq9YZlTZxdEgkBmorBt9sYN3HRrXHkF2ZpAgm58i+UrHdozljyLrUhEzrbBLu0zAoXULizFJHTuEcQkaAjWpJDdFUkoxpVycZ3KOQMTAySH9NLVC89rLn1BBmmEh7ZqmjuqTZE7HPLvWeRxhyJWGTdbutAiYGaDSh9RFJ1K6vCDmBjjwsi0Wy3UQoXNVudXXMVnBnJ2kFLzEFskY97DdGIWimxAra7pP7UnxiD8yUfrqOW6BLInlODdenbmz2ySO6ZhiQxyD9Uf4kj57qBAZeak2SkY704dsR13fUdVYl0P9kVwZh3kFFe3PqtNbA3BIVC/Nk0vvLqHN3qKjY31Ch5iOeUcKZNmVAp1jqiF09vRap+SU7QWvt8uEPG7m5C0rmzrFgT4bUG4NqVN3UyJ2OfWEGpg+3iEkVmW/fEJR6r95Lydmo1L71aO/AdO9Nc3hDz83tKJnb4aYU6RUIR181KkaqzHZkh5311cs7g83Rqe3erdJxh1LqvhJvGaffXHL4spab21Uyt5sDam4369i19IFV3xq96l3q3oG6hzPigNpHs/UqGrQ1SXrpudTgy+T9P/UYPF0BAAAAAAAAAAAAgEeZ8Pv/OYr+2/Tcwy4LAAAAAAAAAAAAALzL+JO70zs7mQe2v8FI3+x7QabT72amXHj/f4Wiv0FfgV4GAAAAAAAAAAAAAEdka3J3OjviEwTqjbdGekCwGeicfoA6o/v/qxT9j+ir0MYAAAAAAAAAAAAAcGQ2J3azO5mRnG6M+gDgMlE5PZJrhhHv/8n+f8czX6Poyyc+emx76v+d+tHci5MXJtTxP8t8bfzvZ78N7f6ucVdr5OYEIfOV68H+iE0P7eFqw6nVqiayak0XeylBP9SxN2KKQLgz4hG3LCQ7W5yrrFW2K8zK8tbK8rlKsGuZ03R13LujVfcWZl1irQ2nHM3D7sHAHaeSIq10oWOMqu4Y/XYsbMcH+6ggXXeatl8NzRHshEfMEe2uFMealr2H3YZr2eH2X9E+PMl9cwLS5BPbLyUkmdaGdL1JikuymJQku9ykaSZ1u7C2cZYpPHX1c2jBZBfUa0+Rfdki4u2Cwj1+EntcJjcd6W6qxJ45p9zc3LKQOQw3TknpMFUX69j202I6tsvpnzTcGSUlvqOIyaY+V9la6Sl0EFqsvDQ5d0Xot9dJWiG4lMBrG87knL40WE2cMYnYd1zLvxXr6o25evuYnZtbWsrcKSZGa69cv/DPpozbXqnUwZvc1/RI49fGN/2ho7dTKN4+j03fgrPVrW4z9dxJ59LUHdp3rb2gM/fuNlP1XWR7VrgfjVWvNwPLVQ1cwz4eliC21+bqBVLqI+ufOVs5v7FZic3SZ+uepIqZs5ULq+vMVmWtsrLNbC6vblXml89ubG6XmEKclkmkZdppGctjWgUoFJ9hKuvnbjO1ezZRuBHfO2eiUH9sop3nzy0/FBNVr0/OeZeOsq9RR324YRJX7uov5uYuXcp8Re27BXFSflj8C0M3Jk5Kp+1R3OdEnLalVHvT4tTBfeQNO78b9iB9h/bo1B3XGLJhZlukdRnSca6NW4Ns1th9jr3z3H7uZF2ZevXGgJHuVfWm62LbT+wMFps1VX6E0T1IZ/fgPh91gH57mM3sPldZZ9Yru6eiTRZ72z44JxDLVV5Y3dreIr0lmgk45vzmxqXWKYlptLY0a5yyjKWNtXOn2me1oJMRVY1TvZulxbJdwYk08R6NLq47pM/NFI88KyX22rY8YpfWjHT3tJk7uatMffnqwKZsXzDsNZFr3Hv7dSmKG211fauyuT2sre6hJUj7jtoSkewRWiKOii+Rg97U3mg9GrTt/S/bpQ/prEO8DzvjtQSiHRTjmiR0k2y9RNXSahpfTBfvocu0L9HqlldHvr4f9ZjDEg42pTzcG7QnY1jQ1MjPjLApZZR+0BaEbVt07EAZXmq3Tybk/n+M/jpF/x79dbjXBwAAAAAAAAAAAIB3D3Fscmf6JJUd5ZOA6NksedufGTkV104Vfv//DYr+Jv0NaGMAAAAAAAAAAAAAeA9QHN+Zzoy0UGB+fGd6etTv/7P0Fyn6f6F/gf7iw64gAAAAAAAAAAAAADySFLPZ3XCPQIUvS5Jh6CaPVNHURM3UNM0o85yAeRXp6lhxLBYdtvXfWDETi3KSoguaaWicrIimLpVNVWfLSOdVQTQNkx8j7/+z9J3g/T9952GbAwAAAAAAAAAAAAAeWYqjPgLIFkd+AjCf3Z0e6QEAef9PPfawTQAAAAAAAAAAAAAAwDsJef8P9/8AAAAAAAAAAAAA8GhD3v/T1BI1i4//2rHPHMvMnJ++NPXbU0/mhIm/Gv9m9k/HfiGzTy3N/HRq4tuFw0zu5OWlqTsXI/cYLzVxE1c94nDA1nHCnUXdsR3fsS29n0SXe4zhinodmgSuq+IkxDNCPyVt3yYdSZ4lvkY6Qga5hQiUM63s2g4hdGTbjs+4eM/Fnhd7fzpzSOVO4qWpO3iYqTzL3qthn/huiP0j3a/RUlSm+IOJhUYzXVuc+PHY2GaI9VqB92S5tso0/1nKF3Mnd5am7uwNM6Ble9j1q46t37fhEqp6fbEMtlHkzKTTh0m/JLEnk9gAS1zxniyIasTb4S0G37Q8P+57h40fDkbp7WvDLGc7kbe0+7VbS1Gv27W+VruPsaZhJszOiDvL46/kTl4qTN1Z7agytrty7xph2PZdC3e76hmWtncodcu26x3l0B5GPaKJ0dQdN9xEUYq2qdIG0tLfyp28XJi6eyLVNpaBbT91GI1inbTU/UZOhy36eS7qFI1d/kQOfSyDuA3qNlMQ1WO74ujWiyvRZzhdfzl38mJh6rYzuG8RtzvEy9k9dK046UiW69uLiG+lo/eYOO+4to9/ITenFjKH1cCfUZhNtH9wK7uOUuEOB0bpCULPRR3Jkh6LuqtTjOfH0BVZ7JDu8MSt3NyFQuZQTZStx5hN23qp2VlEIyrizvrq5Z3OkvZJnlbgnlIeHtwMfILe/uLAs3a/cL3DnWDfUwUZI4mTb+TBLukVNHLjlziZtNx/tjvIAPefLaHY/Sc3xP3nYflGbm5jOXNYT3iV1WtO06g2GzUHGVVk6/uO2+lcNk1AS/ExO0BR0tVsmtggp7ihf9mtg8m5veXBjmFTC8D1j0O3f6iZm1teztxdSTiHTZPsH/P5FAexaXLvIf/OpEmswf6dkyLpjhVHcWJ8Z8HPnUTK1KuXBnrlq+uNatOtha70BvhQHc01X5q23jP/dcs2SoblNWroVvVFL7yYHuJgkaRZKhD9uGbplh/41Qu9K5LGJVqq+KZPEs4T+aT6UuHjp+qOgQvFpULTrRGfexubzMrG8lpla6UyH6T1bzVwakKSoFgq2M1arVB8cin8Y/CJ8tLK88zO5lqHL7zoIgyTIMZouqTLh1N1dA6582EvbK+PHaG9wguIB9Veobaj+VN8PzQNvP8HAAAAAAAAAAAAgPfH+/8M/YcU/YcPuyQAAAAAAAAAAAAAAIxOKTO+O50daZtA6o23yPv/DP0mRb8JNgYAAAAAAAAAAACA7y6K47vT0yM9AoD7fwAAAAAAAAAAAAB49O//w+//v0PR33nYZQYAAAAAAAAAAAAA4MEznslSmRx5/z9J/yuK/o/0X9Pfpv8N/af0vwJrAwAAAAAAAAAAAMB3ExPZTGZykvw7MUH+HR8n/2az5N+xsWx2eprc/4/TmxS9Sb9J/wL9ww+7xAAAAAAAAAAAAADw3cHT47uZDPFlW1UMWeXFsiwIiBc1RUGaynO6wikKK/JlWZ+cbMuaCm+YnCwJqsSKpq4igeVlTeIEwZAkSRLGx0eXzWaD7/9Hkj2Rm6By1CI1yx2/dOzvTfx+9uvUj1GL5L/c+dz5QfXcOjw2yHNqy7Fizdmz7Jb7Wgt7Va5/nPUadTgTuE792rHAdWp/0f4x+x2uU/vLBS4cke/jesNvuU5N+tFNeE8lLrSJR8VqJB+4US3dg+vVKI1OGmcP29gN1Pbzl5oieSbymhpWpyfbMF0N23v+/nwsU+zy5CtxfKAj8ASZqiCMWV1n5gvEleQBLpQKHvb9GnEMHaYNftWx7YcKonTt0MgFNXF6mQwlKnVk65ioKhVsx6+aTtMmf3vWno2Jr85CqdBqNsPydMe2sR54d48dzTquMczRbEuk5Wg2dNo6KFlC4sxSMp8gfSgT2mYptktg0N5qF0m9Y9HYcmmyUQGKbfe2d+XD6dzJa8rUl/WB/lLJD9uvBnmEbk7v3Vtqr65e37ZBZCmQJEbxsVu3bFQLEw12pjrDMIGb00S3crHXcGwPVxsubiDicLzUDrvhWr6P7UIxsFjg6r1PtrG5Q++qZEQzzMbauTCnpV6NgUCstLM4Tu0gKIWB9ZplB38mOiq+2QjdoqdpCNuR5NunnDMMM9B5a2y6Du+tsYponOqO7bvIsHTfY2KjBfK2H3lzvS0c5nInq8rUnauj9JzQKe4D6jpJZUf2szuodaMBMtB6oUP4Vi5pPnD30QFuW7TDbBQ1/nffvQsEAACAETh8+nA8N/cpJXNYD66q0ydgo5nu1n4vmr5X189VXugzeRtNcmrqN0HPGxgZ5FxYRX6p0dRqlk6uJmcYZve5ymYlPC8txdNv4c7nD7O5k54y9f+z9+5RbmT5fR+6m2w0MeRwpdUutGqtdalZLhockNvd7AdbHHAWjS6SWKIBDoAekjuarVQXbnfXEKgCqwpN9mpXa4DNmV1rvdbKD63ycCSfxGtbsbSyFcuRHEuRj2RZjh3bkvNPnHOcSHH+SOLYVhJH0bFPTt16vwB0k0PuYr6fOYfTqPu7v3vv7z7q3qpbv/vuuYG3n44xCmuaMZ3eF1pda8LBm5Ov49+IBqoNT2eMs91z3nPXRz4P3pOQ0DFiCC1zasfdLdUbdWMSYt2mFsj1WnXTOideEPfmhp4Yr9IHXaqZc13Hzu5Z8axghhz7I5P13SEHzzCcTBMWV4s+HN5757Ty5jsw/vGt3iSr4ycPj1PH5izhmdexqfbI0w5Up/H+f/LsNxNnf/fsNzEkAwAAAAAAAAAAL5Tciamtie9/hSwtzTMusn+MHxev2D8tLk++emJq69RowguG/7/Eh1C7AAAAAAAAAADAOGO8/8f6HwAAAAAAAAAAGG/OvPShxEtTX0ik1k99KPm16ZmTJ8+WXn5y5vOnt6e+8NI3Jv+Pl85N/NMXnUcAxpHHJ3vfn0zfuDHx5BTzdfGgS7uUb1NNE3Ypr4lqd9txV3EwONDn8WKgKPtEXpPk3RbVPX4nvG4vLE8Otkx+wXK68KBrfAA/0OmCK+I4XbAuavy+IHa77SFxPWJkbj63YDp8GOQoY4O7XtgqG5/amYo8sn6nF2vz86sLa2uLy0urS/Nrawuuw4Xel3ofSs7yhZm+FPymze805ICX2oYnkO0W5Zu0RT1fK4a8i8R9zjZMo/0R2wZX5owPFT0fsYXSGMmjAItF3AYgaUToGJ9sXlTk1oH9Wd9k72xydqswc3gwzARR/iaOXfoRHE54/GUMNob5WV+1wZq4xweE11GH47Mh4JSDiYd9lzhRIn12DP7gUmq16K7QIoGK8KjSVUHWJKOp2v4bfrT3MmuIh7vDasFt5s+qKoIaw/UR4Y1mhBpxauKcWxXVmlsT4cvhdM7lDS3h668uHKMGPNkP18Cl3pnkrFiYeVwcOhQ0qaz7evAzGAxCOsO14HosyrnOh3K2q5+c1/PNsxo87GwZY4eTM8tivc/0TifTbxUm+if936gHy2ZWMm/lOT5f9y1jbVVKb2yFvl4frDXwLXtI95xrsaz/G3arCSYSiS8nvg3oXe9lkul7mYn+x5hVzXs6lXXV8KDlv7eLgtyUjG/cNZ+U3ehMA46mwLSfT9ZwWuV8iG7FO5fPvMWE7AtEpW1lnzaJsGN8TO6OcW9n+t/TSyfTu6sTj9MDfBi0JE2X5F3eciXAG87LJEWOFO6M4NcgRt8gXweWiNmHrI/wjU60wdWLrvMDUqgXAw4QTAdCthOE3IiejfrJ3keTabo60f/SEeyy21K2hVakrHIMs5jqBlnleZii9+neR5LpO6sTvVFMMahpyEewwbNtEr3Lve9JprdWJ3q7I5RhQDW2j1CEZ1B9xmCD/f8AAAAAAAAAAMBYc+b0LyaSU+8kXvr3qZ9OvZk6fSI19ctT75j/vei8ATA+bPaWptPC1bjzMh4q6n1epS0qaJTXlfa2pisy1fjFmIAvbvYuH0ffQkzAF37sR3uLyfTVqxM/+WH2eidGLubyj/h2IMQIsRezLCzqtA3fyRWWlHtwxQp7F3vF3lNgqpaatN1RdCqLB/x9ehA4ycJ6geTTGxMzm7+84tNsPTflm9Iu1fRBZ2xEx8jmV5ZYjmMUGrpulKvrJHPhrc/NX1wTLu68fSHDsiC2JMOfvkp3olOPKlYojpN+WNugpBVFbUqyoCuq/Xh8yAkj0TFiqs1x7m/43Y3U6pdgLxOMlnBJVNodY3NEJmf+3hGklv23eUaDdTSIo2D0CoyJ4lgwTuUAO+5Y8vsS87ccs+XFL3XNtJF5cY8KTX5P0PYGZTwg6mQ4qGJARo3DVQT2tlhUurKumX6wo9JkLqj3hZbUnIuMZJ7UYeWsWKg3osVIoU7Wy9X1bPa1/NL8mtnpXEnz5bU2Qq3FxXGsEKt0gDmszjp4j5Mjci1vj0bGWRJGy+92OlTlt43jbAaqiJa/lvcotzRr3ZY+UqV4RMNV4dXjqYCV5eXLK+42qBu9hen0W8sD7yidrrpLPa/fF6Oufv5Gb/7Imhairh70P9v7VDK9vDxxeMe9KwWEoq49Ct+PAhLH3gjnu4ENHJUH38SOfvOKu2mJKh1yrpErYTRad+PbYu9SMn3u3ET/U651xZYi3nf/2g9bkl0/uv1InpgWNLZliEKL16U2jcuxT4ZtJnRynUhMlV/0bA6AcQD+/wEAAAAAAAAAgG8v//+Jn/3no/v/H014wVz/v5U4+3Nn33rRhQQAAAAAAAAAAL4DqZ28M7U1YWyK5LfFpaWl1fmlVXFBXFpbubK9vL0sLogLO9uLSys7K8KoK/s3DJWnmMrV5sra4tKVlcuXhcWl7dVVYXttcUFcXVhdnV9avLIiHmn9/83E2d89+80XbTAAAAAAAAAAAOADDt7/AwAAAAAAAAAA3558R7z/P2Pk9EOJxNn/50WbCwAAAAAAAAAAAO8Xxvp/YurLiakvTxRhZQBeDN/QD+8mZ+vnZ771I9a505YP/X2JPuQFkbnQ9h7WbZzQ7REJnjA9Qmz7ZOlSpc7VGsYRol597mnq3N1SvVFn7n6ts6IXUoRcr1U3ieXxXTOcSnvOdHcOVv1MtcQOJjWOXA4IWVeNZEMXL0nNfEjdJffo5hQhZe56w1Rve513zj8NFlcyk3bDbc0pQvwnpzohl1xX9hEZYRkwMJw5R0S2L0WXwZTev7zmnJwblULeOAfdrArq9ayfstMNR/IcwGsdZp3LSE3jnG4WyYkZqFMDu17NWnUyqXZlw/2yY1GV7isiOzg9UJlugKUwWDBXwFONw+rYNfJARe5x7vlwSwofGT+S4hHrb4gi236aqHRoPqKl+AR8+uyaMYjUbR1bbnqMNw5b9kSo1qLjiF1VNQ6DsOvT8DpeqjOv28eLfS6qUJ5wR6vZBM1/vcWbG2aUfKZDVU2RhVaGRQw03GDTdQYDK5LThLcldiR1oN1aVx1lwWZrhY84HITbgh3/qC1qmB5e31ON4x3i+lBAaKheqzFZw4YlnjWrizWIEeqpLcjCLm1m4saY75CqihpFm1QXxD2jk2WjbDO4UvOZJt2X5A+UXSI6+jAjiS2h23TaXjAX9nDuyYUm7cq0yUtyJmf/rXT1zJFqRlSa9NFIaeY96Q2Rd5KgbUFqsQHWOtpgSESWG+/wOuroGjkwxrWrmOlRi+4K4kFgcuRtUkGBI7QoM4chBUedCcQqCt7PguYeJWK+pTyk6pyuSu25YXXqtLFjDQTPqolnU9nUOnejVLErulYo1bm5wnq11shl7lRrt/ga92aJu8PV+MJW42a1Vmrc4zdL9c1Co3gzk71KuMqG8f3/ybMXEmcvnP3Zs//92T9+dgsrQAAAAAAAAAAAH2QuTN2beNClXcrPL62u7CyK22JzaWXp8pWlK/PLK8uicOXKypqwuLy0Pe2K7ogrzWV6ZW3pijC/tLK4vbZIhZXLzeWF+cs7ywvzCydc0e2lleXt7QW6IjQvL61sXxGE5dW1y+KVK6s7OwvN5dUpV3RxZ2d7pbm0s0BXryxti0tXxKW1K6vC0s7KzvbiwgKdzE7dO2WKXt7eXmwKVxaX58X5pZXVtbXVK5fXmsL80trK2tp287Kx/p86+/XE2X929m+c/fqLtjEAAAAAAAAAAPAB4RNTmxOiICuyJAqtpSXSoWz/DWkpu5JMFFXaleSp81NvnHKEyHa3uUt1oh3I+h7VJZFY2xpembrlqmI7DRxRabslybtLS5Mp6/t/AAAAAAAAAAAAjPn3/2f/KHH2j150TgAAAAAAAAAAAPA+MDUxlZgx1v+TicXEVCKxOFq0J585XEvOvp2Z+ROzlqcy80sDXRVkTVSljs6LgizSVou5DeI1qust2qaybspRWVclGvRXNqqOVOF6g6uRrdsbRuzqdWK6S6hWiE+76b2sWt6wvXdY2ygsLyzcHfu6lQxtZkxfCili6/bpI3WuQTy5M2J3tXxG2BbkpiLTZibHfDJ4RCRZN7wlvaMpct74h1e236GibjvoyOxT1XARkcktmFEJMRyrKGomx6TpI10VRH0uWmMu84lLpnTWib0nNAu64ZDFsJNmqpkrFuqc4cCjQorVQpmrF7k5pl5QVeGAb1F5V99zfYaMmrInmWw2N5+9Nu+oaBhpZXS1SzOEK9c5ktkRWprxo7LBHFeY3kQsD2dSk1VIhGXtCruaImSDK3MNznRj0qaaJuxS3pMHR6nHIwmrYucnS0RTuqrIvI2YKV9NcZWNn/rC4ZXkbD0z89dPxbXmHUkWWtLnzZbIPOcdqSGHo9uO99xGHBanzVzIKLnoGolp/IYXFKNm54zSRiWQN7pHVIDrKc4f06qaQDTzalwcbz5LddYjo0ONpmH4UInUns/IikzNzhuX67zZBiNEAnlwXMPEFzE8XAxJcXCpbYc03jIOGZfs63FliszoCKZ5RuX1DRTxhTcGC3ucy+YXjhPd2stWamay+YC7Qs3jJCjgj1KzR4RLobEge5xc2H58bjhuBMPZ6UQ4Gwxly+8Rs2M7D6qQjpFTX4lGLYF+0KEjZr+oyDIVjYwZ9rQSZ66G5G6rlclldPpItwKOXE/sbpSPvpfE90hP3OMka2b4WKkev6xKW9J12izuCYYwVbVj5iBCj5Md/+16xDrw3pdzmbfe9uYrWuGQigkrdD27Wc2edc+5C1mzqZvKBXFvQFazWdbmVnNXskNG/Wc0ujmiQ8a3hRcyvj3jfjPCcBCYKZrVYc7ZctZ07Vj9IqjXLdTcKLPPo5U9PAd9Nm0zf/n5NEp36fDteNNFo/y2a5QDvP2RDFsAeNYRxIz+KbO1mQESm5FI8r7QkpqW/z/7/D8AAAAAAAAAAACML/j+HwAAAAAAAAAAGH+w/gcAAAAAAAAAAMYf7P8HAAAAAAAAAADGH7z/BwAAAAAAAAAAxh+s/wEAAAAAAAAAgPEH638AAAAAAAAAAGD8wfofAAAAAAAAAAAYf+D/DwAAAAAAAAAAGH/w/h8AAAAAAAAAABh/sP4HAAAAAAAAAADGnzMv7ybOTP1S4uy3zibP9E+9cyp/6kPJf5hMnEy9/A9f/rNT/2bql150DgEAAa70NqbTt85PJiS5SR9pD1qSTnmhqyvsN/9QUe/zbdrepqrGL3h/Jb7S/55eMZk+f37ysaQL2y3qDfVJfrlY4woNjjQK62WOeIPIXIqYF6QmaXB3G6RSbZDKVrlMatx1rsZVilydCWhzUjNLqhWywZW5BkeKhXqxsMHlUoRoVNMkRR6owpJhWow47yiSTJu8oJNSpcHd4GpurOJNrnhrzhW4lifzLM7tWmmzULtHbnH35qw859y0s6ksqTdqpWLjsdr7dDL9yiuT72Vdu6hKV6ea58/Ek7BVzJBnYhRFbUqy0Iornh1sFI4UKhuO/GtkZYmVVhBFpSvrA/PQUZUdqUUdq3ZU5R0qDo1jyHjiUI3qAXkzk1ZQqULmMi3lYSaX2ZN29zK5TLelq0Imy+LvCFpsJVphZG4+t5CNrUO3pDm3ADkz8ZyhgsXcqpTe2OKcSJa93Frvfab3WnL29fRMv6Sr0u4uVc0qpbrAWlJLaks6v9sV1CarOrv2a6UbRs5jhVPr3PVqjSOlSp2rNYzKZtFTd25yFTJX58pcsUGK1a1KY+5CllyvVTdNgaxRt1cW1hZT69yNUoVYkrVCqc7NFdartUYuc6dau8XXuEahVOE2+HJps9TIZK8SrrLRv9a7mpy9mp45XPaWRhB1aZ+OVJaw6MCSVLg7lzRd0KlZ3WbsTC4jCrJIW3yHyk1J3s3kMjuC5P7MsrZr9Jd4Q5A7N7kaR46hPMVsuDC/uDTMhoVio/Qm57Pghd4PTafz6UEDq8Yvsv8l+hd6a8OF2fCrJXpf/p7elWQ6nZ788ZPO+MJGFi3xx0Njijma2B3S0/ytLtKi8q6+x8aRda5xh+MqZIUZ9Yo56Iktico6r9KdQBc1+4NfS7FQb8x5YhTqZL1cXc+6uheY7sXlFVO5YnYjXVH544ziyrbRW6V9Gjl8eDPlSsblaWHl8hVz5DN7Pi8qsq4KYsTgssFdL2yVG2TBN055I5C5hdyiOeKY7S4qf0dvkbmMqLQ7LarTphXE/jAjGX+bSap0XzLsFDcsOuHOrU3TVSq0edpRxL1BtvTKZUmeXDbrUaaPdF6jD7pUFmlcqn6ha1bKe1Ro8nuCZiVriroXS3VTRbVG7Dw4gUYGVpZY5bkRjERvlKvrJHPhrc/NX1wTLu68fcGyi6hSQR941/dIOLbpdppDYnkkruU9qbDopkig9Hmr0YUKmmUlDZoqStjKQtZzBxJ6q8nZ6tWZftF/B2pRQaO8rrS3NV2RqcbLCm/mOUYg+t4Ur8Ye2bdubxjxrJE9Isrwe1GZK9Q5vlHdXK83qhWOL21ubrHRzBpWE4nEpdEn8Su99el06ZWBs1tz0mUOxfbc7L2VXmHUiAveiO/2zvdWkunq1YneJhONs51KdSrrkiLHCHzJqoNSZYO7S4ZqSZEBVp+zLhltMmdNYLKbveXptHB1YmAJwylejgn4UeP7/+TULyeSv5I8TG4mPzr956dfmfplrLcA+PbmkPZuJdNra5NfFt31qi5o9/kmNWYeVBYla+kaupr4engVGxKKX9AaN0gmHhXgqDjgY2WOv8xdWHmKOUHUMtLKYy6c7aj1oy1tryMNEeMeWrpRidKaDS79mW7NEYt9DhClMyKHx1VvmsiunnP5iEpzJyiPep9Jpj91brL3qntrZOnwHUGlsu5eSPx4+PbnlXRudv5smoF8wLZG7ru9UjJ98dxkLxNMWlGb1kTJTPlPxaXMBOMSViVFlfQDssHVi950l3o3p9M3zg2cR5jqL3vy8LWl3o0Roy16ov3Jpd71EaMteKJ99ccLPS6ZPndu8qdv+QcAt9NriR+L7uhPu7582udcsevTp1qYHn9YsTX4myLLmzWm6Xtxas1Af46uvI8LXUnWdLUrGvNHbahin3Cc7suLqytmjkVV0qkqCfw7miJHKjcC+H2hJTXnfMLmMx1fxfl0uWm/lvckOJ7PK52BJSaGE27Xw8WFebNJLsybHUxWdH6b7iiquzC31uOeAHeV7bnq3O3EliC1+W03E9aN0bnsRneuOZGbVGi2JDmYunvZjexccyK3hUe8oOu03dG1OBP4ZILN0Xoe8qArqbTJGw8+6MNYTSE5W5tlUbNnq1TrtnT+viQHW42txQ1nTUGnj/RMLmM0XqsNtCWZp/tSc9DjEp9MZEaON3UJzEOiZyfuUBk7MfEPcMeaQBgP0rhajd1QSpVSo1Qol+9ZF7mNuISHP65PEUJC+TEX6EfQMmjCExjdPW04EHIuTywLx/eZ6I7o9iSPgEdTVAeK1uR2q9E1ReXT2z3tcHdyB/9/AAAAAAAAAADA+IPv/wEAAAAAAAAAgPEH638AAAAAAAAAAGD8wf5/AAAAAAAAAABg/MH7fwAAAAAAAAAAYPw5M/2hxKlEITGzOP2xyX908mcmaonCy4enP3nqF0dU0D9zOJFMS1uT/V3mrrijKob7S5VXu7IutSlvu2xU6b4iCswRrXUQgSTvjiI9UfH5dj5aAuYJC6PE8bjdzFkeZy03kyxqzo6qiUqHGs4qPQcU5TNOgpn+5w8TydnuvZnDBes8D1tbh6qaIgstw7fzHvP/6kmfeS9lR+mwU5dGihM88eM4CYUPARktaff8J1vfuXy1vOH8enXBcD5phLvnrLxmCLg/448VIRk7ceIkTtzE3aNyJI1IMvNGbB008mTz8Y8m0/fuTX5FY06xRyvMaFITZZ8z7dEiMUfbbnsKO9yOcXQc7cfUVrRLZaqatoh1MRyS9LujXZufX11YW1tcXlpdml9bWxj92CO3rXtPNjriIUZ+l7+RmXkhB/84BfIqsFLzBXm8rnqvxx4lZA0UHoPlwxrDxwO1Hn9pOv2le3HO4UdrhPzCiC1889SjxCk2rh9+5PEXk7PSx2fe+5Q1jNnHePFiS+g2qZG0SDXNp2lbkpvmuGJLB4aooykJDk7X3ZF8//Ja1DDN63uqceCS1DQ6kJ2aOVhxd0v1Rt1z7NyCed6cfYZZTJaMozAEZ7wXLrlHnrEBT2qyFix4z8HbVrqyccSX21OMG8ZWpVStkEK5PGoOWkJXFvd4STaOC9KI5GRCCmcilR00nLYM1/JFpp1Y2j0ja7ur6WSbEvvAIWJ5I7YSIWaV2GcMrj/+QnL2/hszj+v+hjGoSr13nOHmjm4zo+oP39GGpzj8bjbIurGGjb9PJRKJ1447ZzuUD08kZ7/4+syXXw3UgNBUOuwe31FaknjAu/Me9/bPbGSdABYdL74Gjqo/3H9ZJ/F0XG/1hHIROGMyn6GycU9vZliPi+vOo0z2iJoi5DPVkjPb0UiHzX0uSc28esnNn9PlvBfzRpY8ZTByw8JZunYo+8Gcmpvhvglk3pnhZDwi4Zt2vnPJbq7uxcF93U6aWAnaZyx4J1Csx9t3H7u72/Y3WqttabO1Hn72cMpscVPHbnGSrFFVf/9anKk/fFopWte3e+vqPzqcTM4+2HJPrR2hC4fXS0M7fXi1dMREItdKQ5N9v1dKI1RI/H0I+/8BAAAAAAAAAIDxB/v/AQAAAAAAAACA8QfrfwAAAAAAAAAAYPzB+h8AAAAAAAAAABh/sP4HAAAAAAAAAADGH6z/AQAAAAAAAACA8Qf+/wEAAAAAAAAAgPEH7/8BAAAAAAAAAIDxB+t/AAAAAAAAAABg/MH6HwAAAAAAAAAAGH/w/T8AAAAAAAAAADD+4P0/AAAAAAAAAAAw/mD9DwAAAAAAAAAAjD9nzm4nTk9eTUz95NTNl3/hpZXUH6S+lfqBqX9x9u+cfXfqpcmrE3954kbiDxJ/cPJzLzqn4NuMXrl3J5ley0z2i5LcpI8eKup9XtB12u7oGq/IlG9J+9R3NfHnizWu0ODIVqX0xhZHSpUN7i6JjpgipFrxh83pgnafl5rZFCF3bnI1jmi6oFNSqpC5jNgSpDZtZnKZpqR1BF3ck+TdTC6jdmXZ/EvrbrclXWcyKhWVfaoe8Cp90JVU2sxkf6j35nR6MzOZYKXRHrQknfJCV1fYb96fy8v+cv0n5d7mdJpfGxiZ5b5JO1RuUlmUqMYvRl9P/Olyr3wMdQsx6n7iq8u9ejKdyUx+I6ML2y1/pfhL8h9aNdQorJc5v/nJXIoQqUka3N0GuV0rbRZq98gt7h4p3uSKt+ZaVN7V9+akZpasc407HFchK6RQ2SBX5rO5FDF12dEr1QapbJXLRoBVq+EAIwZVeY1qmqTIIRFS465zNa5S5OrEktGM5I2ogigqXVkfGKejKjtSizpxOqryDhWHxjFkPHGoRvWAvGkPK4g1zpbyMJPL7Em7e5lcptvSVSGTZfF3BM0QaXA3uFpQgRVG5uZzC5Y0lUUaK84CrxHT2irdlwyLxEk74XYEsytFFeTYnUxU2p0WNf/ebiniffbXjiC1rD7YooLG/qSPOqwTRnXMXEYUZJG2jEimGVg03oyj8UKsAUNy1/JWYXVB3aV6qGUNaFB2efm20rTMZCbiDyjVzQxUa/4Y+YxG5WbGtLRhotiEWTdxRVgGyIYRXmNdslQpNUqFcvmedZHb8Lb3XSpTVdAHVHyEpGOWpkDbijyCkrCgo0NUqaDT5oBq8Ug4sbqd5pBYHolreU8qZn1StS3JQssb34zmC3Erx3s5rM68Pdm3mxzrWd4AayjLWW3jerXGlW5UjLHQCbJvVaGqNQI0rwbjNrfBlbkGR4qFerGwwRk6zdzPhRuqXQhjZI1se1mjfDERbZNGR7ZCs9lUltQbtVKx0TvTqyXTaxcne6+793hWNDYoaLxKheZB8Grip6ybiOf+Hork3N09IY5Z2M+cW+WOOT/de2M6Xb84/MZoJbUYyttPfrp3+0gqFkIq/ty7D3vVZPrixck/+QPu/dQjEYrxZ8N3VU8wu7H67oLeu2t0A4ptOJG32aCSAfFHug8YkwtzvD/+HcFzHxg+5B/5dibTRzo/8H7pkbAjWTMdno2QsQOoT8gZwQRRpB2jtb4fw7tKdfWAlxWd36Y7iuqWyS59MNgd6UJhxx5z56OGQLtjesYss53kiae22YATYyHvyGNk2Ix+zhffMyJd7FWS6dLaZE8MjEi+qbBK96mq0ZgJ8Z+JGZ+iVHjWISEZxwrOxQNTyGOYRCLxiWFLqR/qbY2+9Fj0T9j/4x/qNUaPvOCP/B/h/T8AAAAAAAAAADD+wP8fAAAAAAAAAAAw/uD9PwAAAAAAAAAAMP5g/Q8AAAAAAAAAAIw/WP8DAAAAAAAAAADjD9b/AAAAAAAAAADA+IP1PwAAAAAAAAAAMP5g/Q8AAAAAAAAAAIw/OP8PAAAAAAAAAAAYf/D+HwAAAAAAAAAAGH/OnPq1xNmJv5Y4e/nM/5D62ynt1N87mTv1xVM/NPNvT/ylib925qfP0LO/8fJfPfsbLzqfwOaJ2ttOps+fn/yx87qw3aIPFfU+r9J9iT7UvH8n/kqxxhUaHGkU1ssc8QaRuRQhUpM0uLsNcrtW2izU7pFb3D1SvMkVb821qLyr781JzSxZ5xp3OK5CVkihskGuzGdzKWKqsqNXqg1S2SqXjQCtu92WNE1S5MhgM3Wq8hqNFiI17jpX4ypFrk4sGc3IhhG5SUXJuBCIYebYCSxVyFxGEEXa0TO5jJGgRtkf71BRz2Szbjb4d7QYZUYAvy+0pOacRzTLLGCZplioN7yBpFAn6+XqejZLXsuTxfm11YXlRW9iTWmXanpkcpZKn2CW5MnKEkvRr8CIe6NcXSeZC299bv7imnBx5+0LGZaSqFJBp01e0Emp0uBucLVgSh6Ja3li1uVWpfTGFjfnq7lcREV5ha36z1lXr1drXOlGxWhATpBPX9Zbr0zCDda82ki1Qja4MtfgSLFQLxY2uFSW1Bu1UrHRS/SEZHr14mQvI8lN+iiohtcF7X7wYuIvW12gVNng7pLIOEaaoTwZAUaeXIsZ2XvvRu/tZPrixcmvve72PE+0UPL/ebgHeoLfr15oZT4cIOg6bXf0yDBD2zF7ptZttwX1YFDjZv3FlnP7il2uBVauhZXLV5asTqN1W/qIPdQRjeqhrp7YHkr3pSaVRTpScj7hcIJ+XbFJioqsU1kfYVTwS3qGhYCK92tcCHR166rbkGIHAKsRhru+ETCk08fp9CQbUmuFjTqcfLr3H0yn6xcnE2ww0R60JJ3yQldX2G8+NFJcDvXtv/TpHn8kFYshFd/8dO9zR1KxEFLxF88IiVNsWtD7ZO+Hk2luebL3tjtA2hZTaUdRdc3+HRWW+M/CY2VMdGfIDIR72oV/5KTtjqJTWTzg79OD7M3eW9Ppt5YHljqY8kJklv/Ckx/ofTaZXl6e/ArvjsgBqciYPxMemQMi1ujsy/rQodpfUJInl1cGj9WDhuT7khwchc3kWACb6Yh7VLzfUSTZmO2wdmH8sd1SxPu0mclldgSpxf7oyvdl5aHszICMIo44vjqiUeOrq2fADIgJjTID8gj6ZkBeBc98pHufR5qXhcSJK73mdPrW+YEt3pqaW8OEPYf/L670xJGjLvii/mxvsncvmb6cmewth0YEjW9RQfP1Fy3x07EjgCUe7PiuDTRd0GmOCfH0UUdSqTFaGKZJJBLlZ7V46032dpLpq+cne59yS2SX3h0WfWb4uXChwjGcgllBgfmwfxrYe7l317TrZoRdBVFXVL9d/9MBdmXi8XYNTcssS3c7TU+OrvToyI3kss86fxXv/wEAAAAAAAAAgPEH3/8DAAAAAAAAAADjD97/AwAAAAAAAAAA4w/W/wAAAAAAAAAAwPiD9T8AAAAAAAAAADD+YP0PAAAAAAAAAACMP/D/BwAAAAAAAAAAjD94/w8AAAAAAAAAAIw/WP8DAAAAAAAAAADjD9b/AAAAAAAAAADA+IP1PwAAAAAAAAAAMP7A/x8AAAAAAAAAADD+4P0/AAAAAAAAAAAw/mD9DwAAAAAAAAAAfDD2/5+ZWEvM/LuZX595L/lHJ6vJv3Lij07UTq9O/dHU0uThxFqCe9F5/Lakf6OnJWfrhZnDk7oq7e5S9aGi3ud1QbvP70marqgH/D5VNUmRNV4UOoIo6QfxIsUaV2hwpFEr3bjB1cgIulLr3PVqjSOlSp2rNUi1MiBS6s5NrkLm6lyZKzZIsbpVacxdyJLrtermgFjkzk2uxpkCUjNf4e5csv7Opgi5licLaytXVpZS69yNUoVYymuFUp2bK6xXa41c5k61dotvFOq3+JuleqNau8e/ydXqpWqFL5c2S41M9irhKhu9XE9Npm8VJnt3JLlJHw0ovBEUH5z4FcuMpcoGd3eQEY2gFBlstDmrsDkWKjVzitqUZKGV7RV7D5LpUmGynxyWX7GrD8juL4+aXbGrD82tfcHKZY7uU1nnNfqgS2WRkg2uXrRLwH5kG73OdHq3MJlghdAetCSd8kJXV9hvfkB2FgaU6b/qne/JyTR3dbK3FWMdU39H2KUxYYlfGmIYV0OcWZhEXA2a5X+j155Ov/rq5D1d2G5Rq/y2vQI/E3/D7qCF9TJHAqFzstCmOY0+yB7e6d1Ppq9enfxykWmNyVhcuX/Rl0qMFJlLEWKXpFRpcMaAcbtW2izU7pFb3D1S2GpUS5VijdvkKg1SvMkVb83Z8tfIPClUNpz4r+XJ2vz86sLa2uLy0urS/NraQjaXInanJw3uboNUqg1S2SqXjQDLlOGA+5IcuGolzQJKFTKXEXSdtjt6Jmf/xau0o6jGBa273ZY0owllchmV7kv0oXFV2pWFVibLsqQxi/L36UFkMi0q7+p7c8VCvTHnES3UyXq5up7NknWucYfjKmSFGeDKPFMqqlTQaZMXdMeUAb0eiWt5YsbaqpTe2OJYyXJuWizIGJNLNypGRQSbX5bUuOtcjasUubpbue44Y0hUK2SDK3MNjhQL9WJhg0tlSb1RKxUblV5rOi1cHb27mtcX4traf9mb6b2TTK+dn+zl3UZpWlzjVSpKHYnKuvdq4q+H+2UogtMfrRDXCgqvUVbFxi/XrEa5r/Sk6fSt8wMLZ6e06MvSL1zp7Y0cdcEX9VvvrvR2k+nz5ye/etHtrVaoT/Lnw/3SCmKd0e4O3k7oa5RGzUY2v8huFmwm2lxkyzDi76hK22PVeD2WDFPFurFyvGiCukt1XhBFpSvr/C6VqSrokiLH9Z74CE5n8o4oxm+VdloHvJFBZmJvUFtp0sjOzwLYGPOgS7vUGDp0SlVr5NhWmsPHDCYUHi0WWHVdXlxdufL0A4anp78fY0WczrBFw+qDvXXwYPQe11OS6UJh8msfjrnP2ROCAVOFvznkbufMQ5/HDS8wfQpXblR9BKYb9gQxumaOfksNTOFi2ltA6prV5FQqKmqTf0dT5Mi2nyKEECOU3xdaUnPOI29M7wmzmreDeBW6/eS1PFmcX1tdWF5MEeJNuCntUk2PT9pS7ZPO5leWWLp+HUb0G+XqOslceOtz8xfXhIs7b1/I2Ok9VY8cPGt+rr00kHRINQt3dTuCzJqhVMiGEb3GulapUmqUCuXyPesit+F0ZLz/BwAAAAAAAAAAxh/4/wMAAAAAAAAAAMYfvP8HAAAAAAAAAADGnzNnfy8xcfa3E2d/++xvv+i8AAAAAAAAAAAAYBjpyanlU4bfG5VqHUVu8nRfajLfVYnEx2Nj4f0/AAAAAAAAAAAw/uD7fwAAAAAAAAAAYPzB+38AAAAAAAAAAGD8wfofAAAAAAAAAAAYf7D+BwAAAAAAAAAAxp8zp//XxOmJ30m89Aepb516N/nPp795cn7qX07NTPzOmd8/81Nnps58ZOL6xJkJ5iYAfEfQX+h9ITlbvTrzWNRVaXeXqg8V9T6vC9p9fk/SdEU94CW5SR/xssI3aYvqNEagWOMKDY40aqUbN7gaGaomtc5dr9Y4ssGVuQZHqpW4KKk7N7kKqVQbhLtbqjfqZK7OlbligyyQ67Xqphmt01V3KS909T1FlfQDcucmV+PMIKmZr5Y3Lll/Z1Pr3I1ShVg6aoVSnZsrrFdrjVzmTrV2i28U6rf4m6V6o1q7x5cqG9xdvrS5udUorJe5TPYq4Sobve3ejzCj9bnhRut2msIzMJqpxjba1u2NwmCjPX0p+9d6n0/Ols7PHH5sSCk1aVcWWizU/FMbsVymdKpwvcHVSKlS52oNp0yWJqv2uTuXWHypSUp11hgqW+WyWcoUseOWKo1qXGJzVgPIWXpy9yW5mdN0YbtF+fv0ICeqVNBpkxf0bIqQNwvlLa5O5oyU7ZieXOQyZv4y7KIV5tFwNWVYUOsdMAs+mRpiQZXuS/QhCzX/HNWCpnS0BS1N76ORrObltZHmWshMP8ZCKeLpvVp3uy1pmqTIGinUiZYiVgfWbL15TxqkUNkg2iXrohuXl5qm2Zd7j5Kzb1ycefxwWMN14gazMWoDdmLENGJX4wttq042BrbXxz/Ye5icvbc886QwxHCCrtN2R+dV2lFUnUn5L41qQH+saCMGND/f9iy4VvTnw7YkbXcUncriAdM3oJFb0VkLF5wWLsS2cMFu4Xa6dvP+ZG8/OXsrM/OYjlZLvtSPVi8DK+SFNmkrD4PH39d73eTsVmHmsRZrqX2qsu45aH5jywy1XVjZKLMcO9aLnOi8ydXqpWolPNXp9HRmwv7WSCaMm+0cy4Sjz3kcEz6LMicSie+Pmy/3vrv3pWT69eXJ3lXWrD1TFV6lIpU6usYbTTsqIPGrVvHZhIvExg3MgZzAOeu303vog67htD17s/ej0+m3licTLE/ag5akszaimJ05MqGFyBz+7cPv7X0xmV5ennzvDdY3o6QiY/7XdtUalozMPplLEeIUgTS4uw1nJkdq3HWuxlWKXN03/ZuTmlnDHFb/KRbqxcIGlzMUWYU3Rh3OaEuOquJNrnhrzgm/RuazRgRmWX+ipiQLKFXIXEYQRdrRaTOTywji/Uwu05Xvy8pDOZPL7AhSizYzWaZKEHVF5TVqTztMtZ4iWEEs+0aEJtUFqcWLSpOasmbK3svGtNbIU7VGWlTe1ffmioV6wydSqJP1cnU9myXrXOMOx1XIArtTLCyaJVSpqKhNNgDGWcUrci1vWeZ2rbRZqN0jt7h7nibmtK5UltQbtVKxAf9/AAAAAAAAAADA+IP9/wAAAAAAAAAAwPiD9T8AAAAAAAAAADD+YP8/AAAAAAAAAAAw/uD9PwAAAAAAAAAAMP5g/Q8AAAAAAAAAAIw/WP8DAAAAAAAAAAAfjO//UxO/mnhp96VLqf879bdSn0n+78mfmv5/J1+e+NWJzsT3TXzfVONF5xHEUu6fmk7zawNPCdWp2pbMQzsfdKnmnBMaup747a/s9GeS6bW1yZ+g7kmhIbmY2H8vfFpoSIidF2qfiMxOzfQcVBk8MHTASaGBM5oDZ4BuVUpvbHHW8ZjWyZuBGNn85ZVRjxA18nJJVNod4/TfTM78bRweav8tCrJIW9ZBopou6NaJoMHjS1kIU2nZgx1LqlFdH3YOadSZqsEDSbVuuy2oQVv4jMCOH7XlYo8eXbl8Zck6fFTrtnT+HU2RvUecei97jjg1qpYQ4yq/L7SkplcuyzR7c+FV4uTktfzi/NrqwvJiihDTHHRfahonlnoyESiaJ0GfcDhJv65wolaZWc3wTWmXavogY/ols/mVJZZiQIER90a5uk4yF9763PzFNeHiztsXMt6khhzu6spcy5tnu1oNxhvLPh/XDXDrxb16Le9Vx3SZEc2mmfc0S1aUsL4sq2hL2m64UbJWKbLeRIwelQ/0JhY3rkXFtKWscZo4ISwrhs5zkUojdGbdc297H+8nk+nV/GTvDffQZ+8YYVwIXZRkncq6lvit8KHPwbjOgc8R8Z2D093TzXPB8el2f3o6LeYHjuwRqq2xPSrTf/fws/2TyXQ+P/llzh3dIyRjNfxmeISPEGMDQeQA7R3rBw7OJE+s4VnpUFXQjaEwdqD2dvGA+LDTlX13otHvPsceI0ieHGOUCAzC8ePf0Qdc8lqeeEc/t0HGDUgeCXbYtNOjlP6JZHr5lcned7kdiu6zNqnSfcm4VXmuJX4j3IUC0k4PMq87ncYOz670p6bTpVcGdhFL52Vv0n9npT85asRFb8RfX+lPjBpxwRvxv/nKR/qJZPqVVya/rrhdzwz0yv1auIOZIeF5U9wp68/yeHWnJmJvTla4HUHTVSq0edpRxL1B3cIr5+nsI3XxkTr2kU9z7wgHLUVojtTNvLLhfubT5OtoC5cX5lfNfmYLDR9B/JKeESSgYsAI0jHqSelq/J6gWdViJuEP8E7l7MS9At60fRFjkrbmb1TWPQlHF9KV8iTiiTqgcE2BthWZ36WyNfLHNdawIBu/zHYuKmpzyDzMFXHiee5nzuhkdyImYC5EwiNXRJjHBN55md0l81YDj6wya1bmdt84WWdW5ozaeP8PAAAAAAAAAACMP/D/DwAAAAAAAAAAjD94/w8AAAAAAAAAAIw/WP8DAAAAAAAAAADjD/b/AwAAAAAAAAAA4w/e/wMAAAAAAAAAAOMP1v8AAAAAAAAAAMD4g/3/AAAAAAAAAADA+IP3/wAAAAAAAAAAwPhz5uTZxMzEbyZO/Nqpf3/qF06dnXnt5OdOKBO/OfEXEz//ovMGRuXJ+f53JdOl0uRXirqw3aIPFfU+L1NNp02e7uxQUec1qust2qayrg0OTfxOscYVGhxpFNbLHBksTOZShFiXpSZtdxSdyuIBf58ekAZ3t0Fu10qbhdo9cou7R2rcda7GVYpc3dTaUWlHUB292lxAQ5ZUK2SDK3MNjhQL9WJhg8ulCLEy0+7qgi4psptWpdogla1ymWxVSm9scaR4kyvemmtReVffm4uIlSV5cnkla+hUurqotGlAj6nADitVyFxGEEXa0Wkzk8vsCFKLNjNZpkClIpU6Ov+OpsimFjOy73qpbuqt1siccYHfF1pS0yeTJYXKBrHyXCzUG34NhTpZL1fXs1nyWp6sLC9fXvEn35R2qaZHFsPS6Zc0TLCyxNIMqDBi3yhX10nmwlufm7+4JlzceftChiUmqlQwbCnopFRpcDe4WjAtj8S1PJnPprKk3qiVio1K/0PTaeHqZEKSm/SR9qAl6ZQXurrCfvOsWVjNSaWa0uoadaXxCzEBiX9S7qem0/zaQIU6VduSLLR4lT7oUk3X+MXo64m/n0gkqs9w2Hny2f7ZZPrq1ck/UXL7ZbgYcaX7x+GeGJZ6EV2QxZWa/nZmBAi6TtsdPTJMkjVd7Yqs9w1vp2FpT1uNUDWgvY7cuTuqsk9lXuh0WhLr4rJiGSbY3em+1KSySEcoSEDUU4qgkmfa5YxY16s1rnSjYtT8nFVlObeGsqHWYIVpjrAhFGoATmfuVfsvJ9M3Vif7r7LeFtmi+A6Vm5K8GxmY+EdWCy9VNri7ZKACIyPRbda5IOi5YPtNEXLnJlfjiKYLulPNpnwml7HvaLqgGoN6tvfH+meS6cLqZK/qFskW6m6/Y/y/K0sPujS6PP+dVR7rDuQpVqSSFIkvlRXhviQ3c3YsqZn9TP/0dPrt1YEDXsiEC9G5/Qc/9qP9l5Lp1dXJn/yYOz4FxaLj/rfhsSkow0amIw9J3giSrBuzjBFGJbJhqKmxzJQqpUapUC7fsy5yG7FjVjB1I6mYMc9TH5Hd3RtuThWsntaUtI6gi3uZXEaTdo37jUZleyBxa3bQGOKpf7LONe5wXIWssDHkitnTvQOiOwUJKPNMOYLy4WlHSKNv6rE4v7a6sLyYfaHjelOgbUXmd6lMVTapixsbw4LOEGkOC1H5HWnAyEVMCHOZrnxfVh7KVhVbtxifbXw3HzvEOz20rOWX8FgqEDXGSr70g1NT3/WYqalXJtxGfBripqae0TmufrwiTs3sGFMz6fP+iKa8P8jNue/6tbw3aabSjD1azZqljakhb5DPfEZAVO6M+xAhzLpm6oYFjpsD23iRufAGhnJiBWbdCTne/wMAAAAAAAAAAOMP1v8AAAAAAAAAAMD4A/9/AAAAAAAAAADA+IP3/wAAAAAAAAAAwPiD9/8AAAAAAAAAAMD4g/f/AAAAAAAAAADA+IP1PwAAAAAAAAAAMP6ceemNxOnEeuL0N0/fTH1h5h9P/63pD5+cPZGb/L3J5YkrifXE+jANPbX/x5KzV8/PPD6rq9LuLlXZSatt2t6mKt+S2pLO73YFtem5rNmHx9ZKN4xjHWNipNY54whjUqrUuVrDOSrX0pG6c5OrkLk6V+aKDVKsblUacxey5HqtuumTsw4Ats5/zVe4O5esv7PGIZGLyyupde5GqUIsTbVCqc7NFdartUYuc6dau8VvcpvrXI0vlzZLjUz2KuEqG72D/seTs2vnZx7/QLjUGi8rfJO2qE5HK7Qngl1m6wDayDIb5zhyd0v1Rt0p/oKn3J2uusvOBN5TVEk/CJS/Wt5wyj9iwUubm1vsnF+78Bf6388K35+IKXy30xSOVHgzgl34rdsbhXDhyfFy2+f6s8nZwiszhwve3KpKV/dYydNGWUhkhiPjxLRSU8uwCuuoyo7UonYjtdqnIIpKV2anAhvneLIjQ8/lMyptK/vGyaDGudG1wVqN84IDWq2ro1R8rbrV4PjNUn2z0CjetKv9fv/7krNrr8w8Phk2ZLCjDzPi8G7uNeCAXm6KDenkK0ujldjXxfX+x5Kzq6/MPP5YqLjBHj6ktMP792it5Rl3b7PMod59vv+9rNy9H4kut6dzj1LugV3bqr1jZfTwu/rp5GwhPfPeliejGq/pKhXavNDcF2SRum0yKp/R0sHMXicq3Zc0SZFzMn2k8xp90KWySHN7VGjye4K2ZxfIrkLuziU7CjmXJ0atOL9fJQtWB+buXPLps0X9F115T8NgBwpHtA66b5yYbpzGbJwuT6zWQS9524fUNI8jZoMLvWQnlA8l7ROz8886l/3DJ9ExripdzbRIqc7K4pjIJ8qyyS4zdV6hoc223qhxhU2+sPFmoVLk+FLlzUK5tGE1iseZ/keTs59Kz7z74UCjEPQR2oIjFG4C5sHNgXquNlhVGAU1w/OsVi3ZWoqQOW9YRhB1aZ9mmBVcQXYStGi0vxbfoXJTknet88Q9P0Wl3TFGEN9R42Yk4+9sNiq9gFJ/unlv9KjYvhwE41p5yKZGqLBCg+MbtUKlXmqUqhV7oHmj/5Hk7Kvpmf59X1X5htboihoynD6rgXSEMTQ4KJ2ZTvzbxAePH+5/eDqtlCYTktykj7QHLcmcKCnsN8+MKlNNp03ePuac6nqLto3Ril8cHJ74pz/c/+6nUL8wRP3vJhKT/9+LtiAAL+b7/5nk1xJnf/hl6cxPnf586t+kpmb+x+TXTv6zEz+P+gAAAACeB/1b/UxydjMzc3jR++hF0HXa7uieB49Su93Vhe0W9YZHPocZEDe8xJWaOWv5k9MFjf3f+E1VXqOasdw3rrgPJ3PuE8VcR6Ua1XM7gqbndtizEVtul8pUFXTj4UlToG1F9l4RVSoYs3JBdx4J2aUZtvIqNBrc5u0GX9hq3KzWSo174Se/P9j/ZHKWy8w8FqPMybLJtxVZ0RVZEkc2ZSBezONLpxjOAyEWj7yWJ8VqoczVi9ycvSrdLNydY6HeB5u2AmtdalUIe1xi/Z3NzWdHtdJ1znhWUqk2+M1qpdqoVkpF97Hu+eRs6aJ/Gc6zNMwHIvbDHs/jXTc00lSxkWMeA3rUjfgAbUixG4W6/dyhxr1ZqrtPHR6f6H8iOfvGxZknH4kprtSksh7uZaMXOawg3NW8/cv4P3vuZnUcq52x7jPYRG4s8pr75NC8YD1g9GszpQIpmIJWjmxr2z+tUCufdqj18wjVEGx2/dn+K8nZ4trMY85bD01qPG+isiiFHrKzHHnDo6ohOn7MU/eQxuf8AH6Du81VNrhKMTx29cr9H2Tm6WcGmcfzLP5Y5hn4cD6kkTxFeZT+ueTs8rmZx97nsiyJqHqO7WKjVerzrkjWzkNFJn3CitzrRhY5UHeDizy0ooZWTmQez5z5WmJq4tOJEz8z8emX05jlHZV33z6cTs6KH5/5qj2KWW90eVGRdVVptajqmXupVFT2qWq9ObZf/gYq/ggaBrylsJW7Nwvrub2jQaUPupJKm+aTfefB/7kokZT54sbsTFEvn+wJotgSuk3Kd1RFpJrmZNwYPATPCynhkl3KqHdSbqg7VWRStlr3si+Wm/8WFTQz24RsVUrVCimUy6NnuyV0ZXGPl2SdvU2TPDmXBuZcOlLOjRf57K2KM05FmdbW2KGqpshCy9ca9hWRadOI6smkOjCT6rHMq7oNyLCu8Upo8Ns6knFbMHFzStpdTSfb1Giqu7RJtumOolJiLReI3fasAerr0uHJ5Ozu6zN/YdXqYHaVCU2lY+jjO0pLEg/4rmw+028alSm1zQ4SLRy+OR5JaUyvy7k2NzpgbNLWlganS55jtrdfGbKu6tFUqrPmYVWPddXbcMwm4+ngTUkz5pxW67ff2gVUblndwe764RR9It7W+VTtk5DPVEvu6EQ6bKy6JDXz3jZricY05pDcgGbdiW/Ug5q12TfZW3e70LEWHmrjkawcZecIS+9LTaryalfWpTbl7TV2lJ2PZOmj2Pq41vbEY6Ww9bMfISm7iJqodGg+Yzcu2+TDqs+uQONfu7eYZh3UlEN9VhTkpmTMvDQi+hqlGF0Mlo54yRwsjJx1tXyG/YpvWN74TLjbtHYIDG4NR7l3ee9fQyybPWouo1v+8QsQnjO4uRdic++dAlgmdzvosyiT1Vmfd7kC7T1ukuOVcDN+zt745+/DMeZ4JoV27gJ2gbYltn9EI9v+gcmKoBGN3S2NgWn7kvucMWCg7ZGGjW3vhhprr00u06S6IO4ZHTAbkNeOYquBUx1nokBsA1zcU9qUsIZoTnlUqguSTCRdI/b4Ys96rMlOIpH4yrfFGuwxPUwmZ+9kZt69Y826TBvSplu/dlU96NKutWnK/JPKuhqeYY2kIPws1afSnDm57fA4LXDEtme3Ovciax6B9ulpc+fydoPzhDhtljU08969f3ktQoLX91RjE5zU9Mo6FwdtsiJWA/e0PbuARBRkWdGNZkY7umnMJntmYK//kxcTJ6c3E6k7py5Mb55NnD41IUwIL7r5AQAA+I6i98P9C8nZYmamfy/qfWvEa8RRXreO9AIx/Lb1ad4e2i9NA68OE4mJf/eibQxeEP1sP5ucvZGZeaxENW6tu92WtGM072DEiIeLroT5ZDGixbMniD654OqNzV6jJEJRR+0d9a31zVLd6B+h10qPL/XnkrP1zMyTdpSxmpLWEXRxz56ZH9Fk0dGj3rGru1T37l1xYraVJo0xJfsEIhTVZ89qjVnNr80j4DxwMt+rx6iKTsd6AhypO5ToyNs/Nkr128anfPx6qbJRqtwI1dgTrZ9LzuYzMz92JrJ5+z+fGa1lj/w1TXD4PupXNfbTnqjPamx7ud/UsA9nnKcnuQx91GHvuIZ/TePVFZWW2pXlUDrBV2nDk7HVRCXBeqpufgW03VLE+/7vgY6TnKsy8rOk43x2FPOOMdZc3lJFJuipLm/aw789cgarmG+QvtB/NTm7lpl5/EpUs/dvTBil0Q/bnRBu6c9lg4JthvD7//858XLiIHF65aW91K1TX5l5lPzt6X9w8gfP1l7eOvHZqVMTfzNx8P7cTq/2i8nZ/PLMoc9tgEpFKhk7k/YEyXsn1aRd9kTHDI7+4jQcNWZrXkCZ5w255ztMd5Oe+6DJ2Kdny2Rf9dZUQKVVU9ZV+9mR/SuVzS0M/2iudKNSKPM1rsiVjPbLvbFlbOGzd09t9gvJ2dXlmcM1r/msJATx/tFsF4x3VMPdl+Sm8fzrvtXP/R+qRrRsUxP7TlVznrax53A+S1kPaXXFc4e0vpDXFe+u1NSo9iwUb/GFYqNaC3w32t/sfzo5e3V55nA5oj0GtyiN3hyH71eKNupRLcgea0YOGoW6/erPHjg0Z/uez/JsBHfb6BEbaGj300b/dWbQvm9k9ZrFswHqiAYduBsq2BefrhyPM/215Gz+/MyTh/5y7Ev0oe20xOP3gF2PKUAoSpzrA1PJSPeIoV5OzD7k7z5mAr593ZZTiWHfl7srBafphbuvb5lhduHQPvK4fIzyBbixLufucME+3DvoX4lwymJZM+iyYVhFjeC04QjV9Ay9NrDCRzllWY1wyuIpi9dvw0iFH+y5wZQjx8tt/0x/JTlbuDjz2N7WE2xdwRHXDYm8gUVFjBtwXdnnXHUDVsy9a/1lZpC+z9tIoFzeEfNIBhk8YHr69PFL0P9Yfyk5W1qeefx69NO/jqKGbqSB0MHPAQMKBs+wbfnn3jtvV2sRd8PP9C8z4/TPDTGOp4qPZ5yBVR2QJ8crzeO5/mJytv7xmSe+T0bsd+d2Is53EIN2u44QM/z0wHlBStuC1Apvd20pD6k6p6tSmz2C8Ytns/bzFI+Yd1OBI+bueoibhTkf6RTqbE+HvZvD/UjKu/3Ss4HDWlxbDy5ygccU9sp4hAXu7Vr1eqnMhT+HcvcUaInnS++g/1rEfdiasUZOpQesSkadQT/3wdycN0bch69G3Ic9ZQlNe4cVfoTZ7qiz3ND6P5FInDxxKnHmn7z066e+lfwzJ05N/G+J/+s5txcAwIvlveTh6eTsveLMV78Y3Gdv3crcXd3meBTYYB+QGrDFfqC+8Cg3IIXgiB+7J0yLfMrkvnQJ7gUMbgU0HnKzKYD/eniHtP2U287sfXrgfXnjuRzewR/4CCR2e5s9S4kwiLOv1J6HDN6+Zs5w7OTYHCgi475XiMFw621XYCep+e4mQta39T6gL+/GdsrumaF1wvMzvwvNjie6WX622z2wq9VIOKgqYjO+vfHTvwF04C48e8+d/SWLO8mQNOJ8CkweSvqeJBNFdr95sbJn+zX83sOXkrNiZuY922Fp/N5J9olmVH+M+qLwCGqiX9h1ze2S3iT8n5cZu929Lu6wVfMYWzV1ad9YIGiGWLfl3695+PJhymwbHx+tbUiyRlX9qduGV034oSVaxAtsEacPTyVn6cdn3rOfLMRXpdk1vS/m7fvjyK0hrCLuazhLUu+q9r4VO7HgB3DumGH7LPBH9e6seAbDSszW7qNu6fY9WBi6qdsn/axaxjYVjW8MrExa7eHC4UxyVlydec/+Ijm+Mo1vhFQjtr35yMmhJ2T0thFSFx4pIhPwvoCN3b+EW8lxd/0736Z5be5Z/6cm/1Xi7NbLb53++y+dS7116tXpg5Ofmfp3k/8KSzIwbvRP9TeTs6urM48/5X06ZzmF9T+Z7Ki0I6iOy9jIp3TBiDFPKIOqnvOjSu76da4YfozfL/XLydnS6syhPZn0linGDdIRrDKKHySpSdsdRaeyeGCsAR1/SJYKY2NJTutu227GJFnT1a55i3lHU2Tfhaa0SzU9wsuYk2ePm7FQlYxoww2u0oh0NvZq/1ZydnNt5vFbPm8vVG1L5naEB12qhV6AhcIjvcDEK4lzghOM8bwd4nC1zZK5reKNLa4ebntPLvU/w8z1FWGoubyOco5trsEOdOLN5duIanx1ywRCOxrzGev7T9tVCotj+Y4QdN9X0eZMxxfkPnywBSKs7gkNdBvrJZPvmkeabc8yRIw/fE+p/LuomExoa5Urr3XbbUE1U7P+9oSqVOu2dNYtbef/nkseQWpMRwwfesZ1psx3xaeSWdvq2UzUfyksy2zqlWQXUk/fYvu5fik5u5afeezb0259Zx/o1t66sCSiWmoockx3jlDn7vu39/nYTSx8UsTTdPXhlitVGlwl4pX3ev8ms5d/R4OnyJ5+fXR7DezPEerI8Urx+JP9G8nZ11+ZeeJz4mWeXyEKHUH0Hx5knr8ReVOMiBKz/8tUMvToG+usj/ijb4wl6aseDdaO1vrW5lyxUOesTfgsmYx9P8yQhvF70bpsu8vXBVV3AhcIV65zZN4wEHNCaT4p9bSuwM11aB4XyDWysrx8eehZXDdL9Ua1do/n3jRqy3tez+PT/evseKInNyJqKrCfeGg1Dd1E7K2j+L3DQzcOD61DY6uwc1pM6IQVdoeyEnHPVDmCflKtbXA1sn6POAXY4OpFwixLhm9TNuuheLNQqgR34+33OfP8JP/scj9iuBxSHcMHSF9tPLdpNSt74bbh9JCvVsr2lotepr9hnqD0peiSewa+UUo+cKizKviYWTXW/1OnniRevn361KknL3p1BgAAAADwAeFJ4vCTydkfKc58eTPOx6njh5DXlK4qenzMszWKNUUc4L5wmL/T0RKI34mds6J1pKbnT76ptAVJdq6oimguJY0lTYSLVDe//gdwHh+nju6QG1N/sJX0QCknOx4pa7XlphhyEBiTYKTf1Pg8DZL058uVHHUDku1dzjEnMTUTu1LZjiR5X2hJTfu1cfHwPGuD79WP2wbNPSLvYxs0E4jffoJm9MKb0ePc4SeSaaE4+eR186jG+Kqx3WOqtKMq24PGromq1XJKlQ3uLhld59BRZq4laDqvbGtU3WfPiXPhPRrGgGBtJ4wdCZxY5jAZ8VjflPP6hTW/APGc72p7iTUfp7EtqYMHl9EGloGtwbj9sCf/7m5cy1yuy3DnyxVHxNpOM6KzzazX3ahvw2k4Ue+GGr+Zw7mwdk36vGNIuzI1BgrDp4T5t9LVDUcR7hbVoYkqTfpopDTznvSGyI+w3zQ6IsuNs9XXeNXj7v+1hQPbil11vo95B+0pjtpKXKiTFt0VxAM3odAG26CAd0/VkBZl5jCkwLO5OrKiws6oYxTFbGQ+UsS8Z/vxsDp12pjT4Edrbk26P7z5jNzEjaE9/v1PigR2xRtfrQXzZzsTcPZV+4Ssq8a4Gs7m8Eorc9cbPhesg7ezG74LQs3ddFvs2Ut21ObnG7F9Tc8c3gdXmfuVX0QK5vFcXncV7od/IfGo4VNqGvvA3aEystkFPKxbZ4IxT1LhU9dcZaHz44/lX97XHNwA/4cHEQJH7tp+o0Uo8lhgFDONpHjEFjBEkd+Zd0Rb8wn49HkH60jdcf7urQEnMo7YVVXj5dCgLzKOFPvcqLeh2Hv/MKMEXbuH7mVH3frra7fW1aAX9vAMZ+T7WfQM6agtapgez47iARrd/cXD9Pr3X6ci7l/D66ktyMZBLpGuf76DqupIk9mj3Ns/SHbBJB+TfEzyn8Mkf1RvZ2zbkOeM3M1SfdNwBOp5/38i8dHE2bkz702cSXw08Z7xX087fCM5m0/7t25oMVuCo3YvRMlGnjcstiRjaqHSnZyoKGpTkgX/9sOcwjb/SvvUOmPYPBdPEPWcpqtUaPO0o4h7EScJD93SG9zr9Y39w9vJ2bfTM78w5d234c1X+ONlZ09R5CaOEeJG7y8a7AcOC7nnspCLbpHHX9FhJYaVGFZiWIlhJYaVGFZieN2C1y1j8LplyCKjWK3WNkqVguFyOnYZ9vjjh9XkbPXjM098J+fYc06WaWfdM9Bzw9B4A5wp7l9eC66xwm4bgm4PfE+5XBdJPi3n8osjeRdmU4OHHpfCD2Om4F6HDWYlPoxOc4QK2uDeLFX42zWuzjX4YrXSqBWKjWAF9RqHleTsZnqmX/VWkGngQMpDloQD4gxeCkbZdehRRkPKZaz/J6Z+PDH144mfm0i/6I1wAHyw+UbrMJOcFZdnvnXLGmeMh2ds15JKNaXVZe9geeO1gKYL7Y5xy1J2rJ1xUaKBEegI2sKDUVRk/0eKxvfF5nDuyDoecq3jp63zGxxHv1nrPus8QVE6xq3W+qlSWWgbj0/YMOc+AWOfL3rOerPzwxwGvHYtY9yhqMwLnU5L8n6rbR8SYn+k7NsWwr5t9A2hxvNB47QY43SA6ptc7R7fKG1y9UZh87ZzYMBWhbt7mys2uI1M1hhSr46Yy3xkJl1fgEYWeba3jnlK8n0izfwRRpbH8wFwQIFXlHmzO2J5b9eq1evuN35PX9TQKzH/hCDcgtpMiu0ecQKt71Nt6xC2M4V62le+bU8U4k7+bV9yZ4CWqNlWjZiB1soyTs0P6tv25/T2HIQZnD5it+Y56q+xXOYTTDyTHRIvVNcjx4xI0Z6oNdgL4ZKhI9JB2VHy8pQ6B+XSHoe2ZEnPZPOZriw94ttSqyVpVFTkpsbvL2SOl9ljqdYPOjQqw9uCRluS7K5JtsxtnwWm2vjgfJeqsRk9okKyzjXucFyFzDNVa/Pzqwtra4vLS6tL82trC5F5HmiLI2V2VE1HzOVR1V97Ggt6Eve0VHerbv5YWfJodd/oz5ldNO+/n4VOnY92cDesjGasRleVjV4XUGrfgtlq2vETYKoUxL2Ie0g2v3IMHb7bSJYtsrwqBvYbfwHyGZ0+0oPGGV4XAS1PZbVQat7ive+JhaLbO9HrbId4xpobCdsalfXA0XjMmZva7fgOyotM0RkRgmUz2mbHiJXP6GrXfkllP0kJtmRrKhZqy7qkt+hQwzjOWCrmfO7pG+/y0zfehSNXUKAYT1nswdVjGjxcPc9s8mat/5MT5xKnX5/5n5LJk9994uLkH06cS3zsRa+Dvm143Og3krNiaebdpPfBj2w6FrK9ozBnTm3mr8HrKXewaNTDodH0xrgkiY086plyIbcthToxdqea02Ea8jrFuojj6y3gfCpy5hPy35b5xCUz25vWjP4WPchkmWarOM5U31A79Glehas3uA3bW1udazTK3Kbh+yLw4Ks/368nZ6tXZx77/I9ZpfGujgOeSkICAxzgRaqJ82ASivJinATWuHq1vMXGkZBHJ6FfYzbrF4fbzOvj5ClsNtj3SdhmT13Ixw/6byRnt67OvPv2kEKGevqxyzlC3x6leTy3Tk0vxZ0zSO2o1omggRO73S/m6CXXq2P0Gjvs2dF86h+6PHxQCNd68P3Lm/3bydnC6sy7vrPLrLJEuPk6ghfMkTx+xTgIdb0LOu65Ur7Jznh7Bbv89F7B3v1sv5qcfX115quliJpVurrhQft4FeuLHH6tZgdbXkntn+yut2M4m5Q+P8QjqePhz6wRo6ub34zalZILVoR98Dz7bt7jtbIr35eVh3LkKdyml2jfKiL8wUXEuBIekYyRRfU8P1NjxpEYb5XZ55n72LmSUQjZUwj5CIVgKcuXrKrOO1n1Fs5+RepvHt5DYgIh7Hh1bwzvs2uvPLvuSPuamEfae33kkbO61ShWN7nQzfK9fL+SnL26OvO1D0f0Ls8hAUftW8PPFxjBt7Lfdau3Noz1raeBuaNcRAsLdLFcRJPLOU2UVXNAe3CwHKkVD1b5HdGfnYX5nOp0idgXM86HSFbm/c8iHAVmEWXFym2wjB5N9nW2Wn5OJnwBg8qoPbjeKDQ4vlErVOolYwZkv/+f+sPE9OS/Tkz+65fLyd9Pfmmanrw09YeJP5VInH6uuwG+2uzfSaarzzNJ8EGkf6K/lZx9uzTT93lxjn/u4l/KPqOHOcMWtvFPco77+CN4504kJpZfdF18x9G/3P9sMq1UJx9fZt5tnM/jjclKS2pL7PZpfIVvvbLmFdlwRiMq+1Q1PoEaGiHxL6yGtFUpvbFle7w5cjqm45uh0ebcr+5ztvCOJO9StaNKsu56vvHcG+MXH7mM0N6WdrtKVzOOMKa6emDkJZPtf7R/j5mtfzCi2ZyPxx5KclN5ONxs/4vPQ9CRExjVXuwWPthouYeU3m/Zik0FmuFZyH7AYftZNu7f2/270+ludTJhOkt60JJ09jBPYb/54eVYGG6a37furdXJbyyz7/CGRhmu8/fs4c4YUYbbjc2YguUnhsd1Y6y8XSttFmr3yC3uHilsNaqlSrHGBi1SvMkVb82FItqvmhciXzVncykSPFaENLi7Dfc8KatzmepbVN7V9+YCMbIkTy6vMF2ewyP9amrcda7GVYpc3XGWMmdsaKpW7Ie7xUK9WNjgDC2KKu2yfZ9BtxSOHRy9Zr7iI4xQfvszo9GTGxDDTi8+R7H5iOggASP6KiFqECJ5srJkbtSOUGbouVGurpPMhbc+J1zcmb+49vaFDEs7piPGGSBOfPDGBpaS40Csq5nnoolU1kmNK5RDlRopaSextsbSWJifZ2rNUTfKXE81Hueco0oMp2OKxlZJrBjWGoulaOXXu+xiNjHUtow9Pgc12qTUPL1eVowzTXcbSs0SkZWiSpvGVhumuaWI7HAVe2npTSIUxtLy14a4J8i79uKbtQFnALeDzIQ8XwHHtXNX4lqemIb2em2LjuWRuJb3pMKimyLs3jAXOAyG1adjxMCRduGSWwfqmk9xXG1WLYWUDVTknJjoU+Y+RQw3gqPpt07+zaaypN6olYqNx/P9N9nU+ol98uDwWbDnzdqzm1oPfM/2vr0kZdsLI9/JGV6smMMq57WJ8wJlwHsYdi5O9HuY7DNbBhjv/xMfetHzagAAAAAAAAAAALyfpIx/sP4HAAAAAAAAAADGGqz/AQAAAAAAAACA8QfrfwAAAAAAAAAAYPzB+h8AAAAAAAAAABh/4P8PAAAAAAAAAAAYf/D+HwAAAAAAAAAAGH+w/gcAAAAAAAAAAD4Y+/+TJ34rkfqJ0394+s+99HdP/crJiyd+a+IbE9/zYvP15HZfSM7er8585YGuSru7VBVEUenKOq8KOuVbUlvSeZVqVOcFXaftjs5LTSrrkn7A73YFtWmKv9hCAACeC9v9vel0tzqZkOQmfaQ9aEk65YWurrDffOzg0VFakihRjV8YKpL4P7+S6u8m09Xq5NcndGG7RYdGGa7zXxZrXKHBkUZhvcyRofJkLkVIR1V2pBblpSZpcHcb5HattFmo3SO3uHukxl3nalylyNVtMW1OamZJtUI2uDLX4EixUC8WNrhcihBNF3Rq6qhUG6SyVS6T4k2ueGvODClVWHqEZARRl/Yp35W3la7czOQyKhUVWZRakqBLisyr9EFXUqkR8lCSm8pDXut2OirVNHbNim5GThGSzRrJ26Xd+f/ZexvgNrL8sBMEJQKkRuLauzv0Li27tV8gZiANQIIfmFloDIEtCSMKGAHgcGRZ0250P5A9ArrB7gYlebNZixBnd9auZNfriu9cSXxl57KVmtu65JK6Kl/iSqoud9lzJfdhp2qdSsW3jq/q7FzZOfsSZy+pXK7e66/Xje5Gg6SGM5z/b6pGRPf//d/X/71+/V6//5PkbaT2VEnWjcQYaSAx+8lUGkZSa3UzeQzTQfK2vrPgI50uruRNoVJ13VcfzvuNjdo1JvXCvbf4y+3s5cL9F3AyGSaNE4vT+hChB53HnJk5Uikax+tMpdpkb7B1OsmBokayiUytHih2jW1usWyVyZL0FrLZ1VyhsLicX81nC4WclR4V7UmapMh2AjwVaN+31OV81RFdgop4HYl0djzaKImrRSZLQvV74ohQlMTVIhULCU4VmFWJjtFFt7f0iLqlC92QilI9adq2qGSNtO0oyTELKWKSaGlijTNpptGsV8rNJ439dmKusRTff5F0cn2N30a4p+hwbV7q9FWkOWMiFQlI1n1EYn9k9kCV6jr7JhNBiZHwWtVP1iozqo/K+JRDRlP6qoA420rX2UbZCJrez+3fS8xt1+KDVZKtUeM+jVNkxGl9QUCaNlI49n+a2d2sVu5sWrkeK44ZkvmRQYyiGFEOATWP65nZusnWWUbp64LSNe2PCGCb66iIFx/XkYhQF7eCJ7f230rM3b8df/IwvNBU1JJkUbNSOUou9q9c1hFV7YgiMqUXJBF1e4qOZOEx9wA9zmhot49kAaV/ev/+1Jx2e+ynuZWM3Mh8/eE7k/s/lZi7fTv+9Yfhz3IzxEiNfxDtSW6Kk97Fyq/dgVJPctxHesrH86SmHvWjjdGjKmBA0FaVLtdTFWzm3DaSkUq626AOPkg8wjNHV8aIx184QiyBIwxPBCHDB6bIrOTHHDoc4akaluGrQfVDQhod2lCb8lXlPETw+/90/LdjF7504dPTM8l/kvxG4o8Tr0+txH8bXlyADyXvcPs/k5gvpZI/z5tTRxrS8CiD03ntgcYZw1Jjlsh1x+rA65UbuLUGh5q5xl6v1Vlm8/V1HKBWdcvObN1kq0yV3boiicylIlPbWL8iifiZWCdXLWHnrnOFkhJ2kNjvIO6BJDuC9EVHlupJTEHniilVa5oDWmuIhqVE1EFWHzU0UMaKrQFaEUtbP17MeaScgf5VLOf8HB5MR4o1VIAUg87rfa1ojr1TnuDhd32z5JGR+S4i9/Efnns9Ven2dHLX+NNzX5J1pO7xHa4ryX0daUTSezGwAIs+BejkW0aPdE7sI7+XAyr1jhSpD+o39Rpxjb1RqTINdoMtN5l6qdJgF0rXavVmJtVgG41Krco1S41bnGHjXKX6Rmmjsp5Kv8Kw1fX95/cfJ+ZfTSUHd3ybmDEEGbOFUYGsBlapNth6M6CBLZhpL9c2q82FF9LM9XrttlvQHEM7zavoaX+4yIatLY2fx0uLUYtoo3K70jRL5smn9x8l5l5KxZ9IxtjVlUWxj1wXYj9wDa+HhI1xtOvyAlWbGTyzY2RxOBMkb56m8OTH9h8m5oqp+BPBJ3Wtx5x5wZ3IfxeSSCeMX1qdks44HVJoql/e35uau50KGvm7I190p/PPXt7vRw+ccwf+t19/bl9PzKVS8W9tkhcC12237L9xDfXdFoc7Or+JOWNgJ4nmcFHD0ty97OUCf7l9/4UUqS1zGCqJ6eLSGhnUUaYaOPi36ix4ng/3YmHj3nKp0VwgQqUGc22jdi2d9oyucyvG8NTo8UbqMsWCtC2uLObyeSODrqec71QkLVFMeXtSY7DtvRo05B6SsxO2bOQzm10zcmq0nMDJ0b5GT1SlMqke38fzQeljnJ0zEuLq812zjd6ngTknSl8On0wc/z0lgr6x5gUtfVQUgYrpzsJVDj59X61Oi48Ti/0alXHa3tCEZbTellwLeGTjQVEkXaZd+eoK02MV+Ti6XNOLb+1rU3O7t0Z1poIi7yFVM6Zl8e2u8WduhEDs/xlM7KuJuVu34k+NGZgRAUbp+1PfTjlA2px+cXeuAesoo/vXnqrsSSJSOX0Hz8sN99a+PaQ3SGBvmTU6AiTjUgprWJTEiIZq1zJ8/w8AAAAAAAAAAAAApx+8/j85uxqb/Y3Zn5ldPenUAAAAAAAAAAAAAMAHitJkcisdi01PTvKCoHOri2vLy6IotBf5Qr7dyrfarVZLXFvMLaHFAi8U3NvZYu99P/be90txl4rlRYT4xbXc2pJQyC+vLa2t5hG/2soutVtrIhLbviomXCpyy6vCUqsttnIrq/m2sLzWLgjZNV5YLCzl22J70aPi2z+IffsHeP1/cnYQm/3e7HdmByddrAAAAAAAAAAAAABwaklPbk1EmkWYtCVHTRbEFya3piPNCeD1/4n4V2Lxr8T+0kkXBPCR45e//PReYv7ecvLv9M2NxA8V9QGnSdsy3+F44YHt64Xv6zuKart3pMWwWyKpp3t3F0fUNLzX2E+3s6ff2IbICw+MfVR4Cw77ZqXRbJA9ReZm4ZyxGZnSpOH9PcafM4y1L5n8vGJtSzZiJD4AjM3c5n1dsXdbmaK8oCsqddEO4ZOSGca1MZqkwykCZ/Pua7VK1fYZ5xYyrxKfPt6LOPVD6q44bo9mGGaDvd401Fsptnc/eesEu7grEdd15n1Ls+E1repzh9rO7ZMQs2yM0vEJbF3yz4MhvbdUsKvML4aiXz3ZVTIcYsjPWSqTksQOMr2H4UALw+U87MXFjpdXt7GvH7MsaTcvtlsAt5Vi3JZqZ1bty7rURY6PJbSnCMYGPLdRODdMhd4CcgQocxhlK5T7tDBFVCFEKalIiiPawQhFVvlpgtJDRR+Lcwm49NnO07DfQz/dxHCKKRV1EK9J8rbl2sL0KOgbRuirKsItzKxP7EfK7VRjzNCX/DJF3be1GtZH2bR5Z2FUoRRTPaRqisx3jC7WY7he07U7FTOQbcLY0ZYkb3vs1rxqK/OarXk/YrcybAtW+HEtapQeZ6domEZbaKRe05jcTlLSlgND7LJldD11eZnftnYU+/QxH5Kq8uuQRaTzwg5uZGm/sgmv1GJKRHuS/JEqF5+GPqqQhA7fF23b86bC6s6pVOAHHhI5SU5lrL+Vvp4aq2YERUSPIsVZpOIbIW9Hgbq81PHxzRMUkKSG7l6j9q6+HWOQXQUMszpomxceewZZtEl5BcawKCOFQwrGHQkEKvI+z7zFHSVgsaM8ROqCrkrdhVF1atvYoTqC4zLx9Az+L9gv0VatfotrVG5USxtcqXyLK5WJdySutNm8WatXmne525XG7VKzfNP0V3Q++Rux5ORvxiZ/c/aNC//d+b9+vvbcG+eU6VryjycnJ/70pF8PAQCIxrvKwccSc8vL8V/4iuHQtq8rKtJ6iixyCHdIsuB7beJ1t+NaHxHLqZWPm1qmtNmsVarlOnubrTaPz2VVj9d3fJ2okBukp+ypiq4ISgc7X1IVDZm+l4iLJzxcodJAOX9y7lC+gizHWy4B7Pp1aYXoDHRORW6Q1AhKt8vLIsf3cP/P41SRZ5mww8vbiL7cQ2pXMp/L1FWcBeeCkRehw2v+PqjMFBOBIYcxy0aq1X7HdPtlep3Cv4dzjS97VawY3rm6iog6tArjwrAOcn3Iadii4cRMRILh7SokI5ZMSEJ8g5Mbxgi1rysv8x1cluRPPPem9XgBD1q7vNy3C9XyqO2njjxkXS63eUFAPZ14eldRm/hPyqT68gNZeUge0UjGDrn3kNridanLdSWty+vCDhEnrQipxDu67au+VrcjMFzBbWO/oobIy/f4yz/DGYcPkLR2eMOTbzfQoxklYTsR1votfhthd/P+Yaj7zEI2kzPLRSBv+2EOhmgRj8tio2EWGadZ4vbj1+YsD1gBgXFDxiFJ07Iu0Q3D5bvoFz5Yj4enP3owR3xaffXyUCfc6ot4mg475lb3jBm1Ebcn7gd2zT7Svj6tDtf7mu75g33yUffD+mJTLtwfli0U5PjqSI3fcsiHyynUtmmRCG7uqGcg7eaSKhnrb0mkzmwQDp5PzDcuJvc9vok1zqd2dyRNV9THloi/99SwkDOl6022PuxGVTNeIWYY61al2qwxwXroHPJ7vNTBto1P8mDeKG1ssg1mwfB2nMmmX5nBXlD7B59MzG+WkvucdXpXoG5O6nb7QY3FlPHkPIqyYR/NIcUU+ELFpKhQjBGKMUMxksbY0ZmvU82DT0zNbZcCDy4ITngu+N7ET+1/7ODjiblSKT5IjyipEC0zozoTK1/H6huPNpegpueSieq57smPHPxwYq68HH9SNo688Bm4mieW+A57k+6TLYJDe23Huu16GuIDTDJ4jIz/SD/5wsEPJebY5fiT+8FpM8vON3FToxNnBg9MHdVkmeCU4vX/2MdO+rEJAAAAAAAAAAAAAMCzBPz/AwAAAAAAAAAAAMDpB9b/AQAAAAAAAAAAAOD0A+v/AAAAAAAAAAAAAHD6gfd/AAAAAAAAAAAAADj9wPs/AAAAAAAAAAAAAJx+4P0fAAAAAAAAAAAAAE4/4P8PAAAAAAAAAAAAAE4/sP4PAAAAAAAAAAAAAKcfeP8HAAAAAAAAAAAAgNPP+el/EEtM8LGp8nR3+tNnvxS/NcFfWDr/L87/i5NO2SnhSXsQS8zfKSb3K7oqbW8jVUOaJikyp/PaA04RhL6qIllAGicrXL8n8joKkijX2VKTZZr1yo0bbJ0ZrWjmGnu9VmeZzdfXccBaNTDMzDX2RqXKNNgNttxk6qVKg10oXavVm5lUg200KrUq1yw1bnG1cnmzXmerZZar3L692Sxd22BT6VcYtrr+Tmb/K4n5rWLy52qjcirJGlJ1brvPq+JRM0vrsvJbqTbYejM0v1s32SpTrTUZ9s1Ko9lYmGGszOeY6/XabVdIjdFnGGbrJltnGf2KJBar7NYVolISZxiGYUrVdUa/YgUxBZyflIyK9iR81VFhXaEV6bze14opXtClPZSi7oiog3QkcrzOVBpMdXNjg7opo0c6J/YRx+tGAoQdJPY7SOTaijqTZmr10Bzv9lEfcUjWVQlpzK6d410rx4YAlZ3dCFneJblBxVQPyaIkb6eMhAwnYoYZLni6yhhlhmFeq1Wq3oTieiZpVOgUGmlXrGryrTIzbUylyizY6cukREnr8bqwY/ziuy1pu6/0tVR6Jn2IdlLabN6s1SvNu1yl+kZpo7Jutpcn6/t/PjHXKMb3JyVZRI8CLbz1mDPvBYnE/qPZWirVdfZNJoKmGSasdSw49ZgRVMQbFpcxiy/jsqv0QWP/S4m5YjH+9VWdb3UCe6/AxP+/VlPHnUlw9WNbMVPANNk3m8SWcQvIzDB2KL97rlbGVKpNFncolgRTvsmWby24ha6xzS2WrTI5YiaFbHY1VygsLudX89lCIZsmMdKFEKTVLWRpzfppzRGtgsJ3kCYgkZNkHal7fEcL0u0nGiEGq4m4y4nZrFbubLJMnb3OErNtuFvZgiSmscWssxtsk2XKpUa5tM6SFNv2EZhQRyJC+l6vV26X6neZW+zdBX+Dw1K4m6/cqLqlbBtI0/lwdeQLHrmhLM2kmUazXik3X9//8tScUIzHjMa525F0xPF9XSG/ucA2thho5//h9f0/dyiVuUCV/z4WO6Od9BAHAICPDIPKYCIxfyuVfOdFn3G+ZgxAxT1eFtDwCD9sWO8T1PsCc52hxrjeEYw1qGe3nFF2bWPd/kGeOVGH/EMjT+94EmumhpIKPRTG93yGwmZg38TRiuinHRGiMh19CLq+yXKl9TdKeAy6VWnerG02qWGpOQiF9X8AAAAAAAAAAAAAOP2A/z8AAAAAAAAAAAAAOP3A+j8AAAAAAAAAAAAAfDTW/5MTqVjii1P/eurG2c7kn8X/QXx3IhX7x5N/dNJp+wCxf30wnZhj2fjT8649rnjznoq0niKLnKD08T5MLezexBnfva5+omS/q3dbK7U50meLY9guTbx5WOjj7eRGDMObNdfZ66XNjSaTtfeXeoNcLTLG3lfDu0DYnk9KgoSyt1VuDJJTc1xh1B5IvtdTlT2+w3UVkd4B6b4+Mbm/OEgk5gqF+ODL7opxyQWEjvtXhkvoeKsBq/RsvDXKi9wg29BxWbzMdzp45zn+86GiPtB6vIBSmVSXl/t8J5U+aiXsq4OpxPzmavKp4OeqQUUCknq6xgl8jxck/bGPpwZLJsxNQ4CeEV4arFDGbi5ql1a5tlltLryQ9tmsZYUxd2kFeyVI45IolxosY+8VU3pI5XW8HytleFdIMU18L58trDDsRoNl8tmVPNksFXHnVZ0ts5XXm1y59HqpXGnetTb8bw3OJuZvrSb3V0NL3d8PyFgFHtUDiF3WY+bM6/vjyecGZxJzN1bjTzaHfRnYqWo9Nvbp+d2cmAh2YeBV4OO8wBKhPRdY+8Kd/efp1waTU3P3VyPtwLZjzflejv2nb/7EIJ6YW12N/+rFYccHlph/2P8v2OWBbcrY8iURdXuKjmThMfcAPR7ufYyG3kHytr6z4JFOF5dWSE+hot0+0nROlLaRpvv2P6YGt2S6uJInexI9CnDYGxu1a0zqhXtvZS8X+Mvt+y+kSFR2Y/KNxblLurqOpOmpTGpPQg9TmZRRTalMCokSvmw2RqOzG+nfwbxhZFfrd/Rhjw9GGobuGm5UsE8S761QLxCGtwIziE9f7IqNvj8UH3Uzgn8EMxC9D9Y3SpfAUJz03eiR0t5n/OIc9k5DRUndjB7j25plSkZEZJssfY+Kx7jJMPg6t8d3JNFKF76SNu/iGE1rL5caTVqEKTWYaxu1a+m0ncJFIp9bXiss5teIBqwn/SwcX1AZtHJCPZpIW6GyYBk97QXIuBNg4MMSw0Y5LONjRcNCAU6JXDJ2ZZlFZJQlXW1UZkmPEJBZOvypybDZ1x0py4FSnmwHyh0m64HKxsi+8TBwd//pky2Kw1ew1TvQDmrCHdOEvC48ey83sP4PAAAAAAAAAAAAAB+N9f/47C/GZn9z9hdPOi0AAAAAAAAAAAAA8FEiHz+zdXESr99zLSGfz69m86tCTsgXVtZay61lISfk2q3F/Ep7hbc+Fo699/38hB1qVVzBnyutLC3xi/nW6irfKizmhNXc6mo2v7i2IlCh8Pp/fPY7sdnvzX7npPMNAAAAAAAAAAAAAEAsFktPbk1EmhaIL0xuTUeaCsDr/2dnn4/N/m+zvzqrza7PPg8lDQAAAAAAAAAAAHxUyJw9szUdbQU+9t73L585szURbeU9jsUnbfH26qLYzq0sLxWWs/m2UOCXsosrreXc0pK4vLy8vDSJxeO2eGF1EWWXhcUlHqH8ygric7ns2srSYnZtucDn2oiIT9jiSBCEldVVES2vinm+Ja6t8AVhOd9aXEG80MounzHX/8/OvhSbvTv7ndmXZr83OzjpsgcAAAAAAAAAAACAD88K/FlbctSUwBlbcuRsgC05aiLAWf8fNQeA3/8nZn8rNvtbJ120AAAAAAAAAAAAAABE5/LZrcnp6ajfLpyffSs2kxjEkr9+/j+c/9Xn/uDcPzn3s+dmpvnpTyQGxn9Q9gAAAADwDNhfHHyKPsK0pypvI0H3nEPqf3Xi466DBP2FyIlL1q0RR5iaYh/8I0zfHMxMzT1gR54j63OyLnWarN8RvWdfG/xI2CGRItqTBHwkbrfLyyLXQeI2Urmc7+WJHx58fjBHDok82Ca16yvmH/aHXHXrK0Oq1rzT67c6kuBXwbioRd44QTKgnK3b9hG/+ELAQcFOCM+xwG1J1XS76DWdV3VOVnSpLfmdGThS2jnZb5TocRxMrA2eT8y9dDH+5PP0CaYax6vCjrSHrNNvtYlZv4NKHTnqaFJtwbrI8XqGTtw62yhnGElMvzb4ZJQDSbUd5SGn70jyA0neduzXdXniwv7c4BPE1ga3XAeSusT8w573PZDUJXO8JyEjmbSGoGpybjML2UzuyN3Fk5XBxxNzd8rxJwIpWbrld5Gm8duI05S+KiCNnMAq6yESE8+5TGC0LlwEIVL0obX0sZLYStJvDH54ak4qB1lIWOS5sDyc2+cGP5SYK5fjT8vEWkKEw/RMuywnRNLXfuz6G8t4DI3DSlxn2dpCac9BrovZ7PgHeNpdDG3xropz4rOtLhaL/eoHe8xkrP//IDb7g5NOCQAAAAAAAAAAAAAAx03izOT0NF7/xz8+BuULAAAAAAAAAAAAAKcZw///Z2KzvzX712b3ZjdmP3PSKQIAAAAAAAAAAACAk2Dh7ORWMtJ2+oUzluQon3+ZycmtM5F8/p1NJb6fiVvSo7z5EekJS3qUl0Asjb//h/V/AAAAAAAAAAAAADjdwPs/AAAAAAAAAAAAAJx+YP8/AAAAAAAAAAAAAJx+YP0fAAAAAAAAAAAAAD4a7/9nZ5+PzbKzz8/+2qw++1snnSIAAAAAAAAAAAAAeL+4cjY2uTURe+/7kfz+nXWLj3L+d8YU//YPIvn0m3SLj3LqF7+Mxact8VH+BYn//6nfi114+7nvPfezidemfg+sDAAAADgFbH92au5LmxMxSRbRI223I+mI4/u6Qn5zPVXZk0Skcmpf1qUu4nhBUPqyzqloTxF4XVJkjctFkfrC15c+k5jb3Jz4VkXnWx0UJUwUmc+X62ypyTLN0rUNlokSglmYYbBgW+ogThKZJvtmk6nWmkx1c2ODqbPX2TpbLbMNS0ZbkMQ0U6sy6+wG22SZcqlRLq2zGUrLNpKRSrQzlWqTvcHWHYXlm2z51oKP5DW2ucWyVSbLlKrrTCGbXc0VCovL+dV8tlDIpU39JDueNNoqjZuVKrOQEhQRPUplUkKH74solSbhrVLQBKWHfJW4JYimLi/z20hMZVI9pGqKzHdMbUJfVZGs22X6AD02dBqqZhjGX6bSIDGS+7U6Yye8aCaa5L+D5G19Z8EnfLq4ukTCMkRQ67c0XfUTzOQyhXQxtZd7meh9ORUxVDZNSuXGRu0ak3rh3lvZywX+cvv+C6m0X5KN8h2d5nzUNOeyZqKJ5sipzoWlmtSXpvO6f60bd0htq6iDeE2St7HtKN1eB+lItMwH7UlaiFHb9y1TzgWbsqAiXkcix+tB2iiJq0UmS0L1e+KIUJTE1SIVixGplSFagRmb65ZhobiqXdeHNRqBjQIs0gVWHNZoJtQoy9frldul+l3mFnvX7gwkMWMZVsbVENMzaabRrFfKzc1LU3NSOah7xq8wkiLbhsH39R1FlXQJaVwu5ObnBh9jEnPl8sRBinTGIaIhtz7r6npDBEmPa923elyqQOhO1xSL0OlG7bpxmIAuy6eXwjZgtutyqdF0iZQazLWN2rV02mPwS4uGtapIUFQx1FxpEWLldk0PPv7jiflXX0oelHVV2t5GarevkwcFp6u8rEnkz+0+r4r2DV7XUbena1Y91Cs3cJSBAZlr7PVanWU2X1/H8rXrZhdRqzJDOme2brJVknpceQu1jfUrhnCRSfVU1ONVJBq9YJXdukJ1KKjdRoLOaTqv4oaRSQm8LKBOh/QqTK0+pM0TwE8n3+t1JKKszUtYUybFd1vSdl/pa7ZWWqkdfiY9c429UakyDXaDLTeZeqnSYBdK12r1ZoZJSZ0O2uY7du4Zp8RS6VcYtroO+/8BAAAAAAAAAAAA4PQD+/8BAAAAAAAAAAAA4PQD6/8AAAAAAAAAAAAAcPqB9X8AAAAAAAAAAAAA+Gis/5+58Gux2b8xW7/w7y/82kmnBwAAAAAAAAAAAPjIsnkm8eT8pYnJaXREdPRIf6nX4SX5TOzbP3hj0lA70T4ibrWTm3EzueIRcevdnDDVCkfErRav/5+58Iex2b8727/wh7MvnXRlAwAAAAAAAAAAAMCRYM88OT9x1BmEM0TLUScMJomWo04PxNfPPDl/5NkAvP5/YeLvxeKpC+nz//fMv5l5b+YL0z+f3E/0pn7u7PKZfxrfm/h7sZ+b/u1YLPZdsMAPFjuDFD7bKj7i8BT7zCjtoaQLO5yGkMhJso5knTpFJUxq4sc3Bp+emuMKQVH1VOVtfMYF38Nq+A7XVUR8RIv/9YlPPP3JwRfwYVnxr33SdT5LWCIiJfTHfI9sCQtCjv8wDwWJeHbLkD6dV7eRri04aozTeToSPtWoizSN3/Y5z8U8qMcrVaRSQ5/C5JXzntKymDVOaSG5w7N8vtHRZ784kkEnv+SWctnVRddZW9bxNG9rijwyBt9Aw5EtGhlYWczl80c/aeatween5nZvjdsuzFoMbhKmwMTF/frgc4m5W7fiTz8Var5mgFH6fjSS0ZrS49jr0KE31nFBtm59R0W8GGSaZk0OSweZ3pGq7Qk/+GxifnMpuc9aJwSZts7rOi/sdEmHJXVxrlodxBknY/nIeI8LiqBlxnNyUNUvVNhJO6Y4Q4kzvIoYOyLzvJ39C4PPJObvLSUHnwrJpIraSEWygDgRCSrCFw+XTx9FM6XrTbZunTsVltMZxioPOlcNtsk4asnhUUyRuV16c8F79TKTyzDZNLN1k62zjChtIw2L4nOMjB+vzOASmRpcMkpkOlKJSPIxlYityCyRSrXB1pvHViLeKy8yOW9J4FOcqJJ48vyAScyVluJPyqSn8k++4J/1iXkz85XqOvsmExw2IIMLzvllGfowu3W2UU4/mRj8uJGyTwWmzMiIX8o+PTJlZokEpMy4m74++LGpubtLQd26n96cX3I+dfBocDExt7QU/zlj9OEj5BfuR1zdtI+E7zFwfqe3jT4DTlP6KjbR0H7ZFgrqjnuKcdZX4KGd1n33UZ2rJLBZJ4GZ8KkhHEzmu2jksIAIBY05FpeXiaYuEiWe0x8HnOxJ3SZnqEldfhu91CMHPRp/v91Dzo9tqW3//RC1eqlMylkJtX50efWBqDy0fwvaHj6KDZ/OZhyu+hIewJinR7Ye64gzchVUwLSIO5PLi/nFtbXsEY6OpJ/5rsZrm0XGNgDnIbsy+NGpucpngxqRq/HQxv/8oDGYT8x99rPxdx6QRkPdpOU+6Wok3sZB2xSdfpeFmMbEFJmVPCkrM5RxEug95xzQ99tIPhDV7n2sDAVdZ6+XNjeaTNYecLkDuAdd+P1/6tx7sdnrF945/7+c/5HnWufeO+n3WgAAAAAAAAAAYk/yUzNbd5NPzr90aWISv/Bx7dVFsZ1bWV4qLGfzbaHAL2UXV1rLuaUlcXl5eXlpt4/6iGsLK+IyWivk1/hsfmWxVVhE/MqSuJzLLrWXc9ncURdF7fPPL+/ll67oj3T3F8ZPls7ObN2deHL+xfGS3cqvLLdaObTCi0v5ldYazy+vFpaEtbXVdjsnLq/Gj7oMq/Fd9K///m/guQifVOfPzGzdnR67sEel+qiJFpROR8Kv+pf1h4pfsicPZSPvX7IV2a+0i3Ej2aXxkr3YbrdWxHw7h1bX8i0hvybkC2urfL690m4t5nLoqGvsPRVdVlEH8Rq6LEpaj9eFHST6pH91wkj/8njpX2q1FkV+bXE5K2TzK6uFwuraUkHks/nCSqHQEpeOurpPp1/j2z4lj7//n7rwidjs/dn/evbchV+/0L7wCehrAQAAAAAAAAAAPhrcObt1NzlxjDNMU/WzW3cnJo5z8ucsTuT0cao8M3a2R2mcHFvjqPmM+OtY4/QxzjAY7//3jf3/92dfuvCH4AMQAAAAAAAAAAAAOIk991PHsuf+7LFoOX37/433/z+Kzf727H85+3C2Mjt/4Y/AzgEAAAAAAAAAAIAPNZfPbE1GW46PffsHU2NJnx1L+sxY0pNjScczZ7Ymo30iEPv2D/D+/9jHTrpiAAAAAAAAAAAAAAB4luD1f3j/BwAAAAAAAAAAAIDTDaz/AwAAAAAAAAAAAMDpB9b/AQAAAAAAAAAAAOD0A+v/AAAAAAAAAAAAAHD6gfV/AAAAAAAAAAAAADj9wPo/AAAAAAAAAAAAAJx+YP0fAAAAAAAAAAAAAE4/58+eiV2I/ctY/NNnfuFC7vz/+NwvP7cw/V9Ns8nfTfz9qf/i7N3JW7F/GftQs58fLCfmH24mByldlba3kaohTZMUmeupyp4kIpXTHkq6sMNpCImcJOtI1jVO6nb7Ot/qIK7fE3kdRQlUrrOlJss065UbN9g6c6h4Zq6x12t1ltl8fR3rqlUjqZm5xt6oVJkGu8GWm0y9VGmwC6VrtXozw6TM8IwVnjHCMzg8Y4RnJI2xE5JKv8Kw1fX9y4OFxNy9e/HBS+RyYDKUviogTkUdxGOZaGITjFVYpWsbLBMxFLMwwzC8rqNuT+ckkWmybzaZ1+uV26X6XeYWe5eps9fZOlsts43wYlOR1u/o2oKjK52ZYRgVCYoqIpHjdaZSbbK4Fqu1JlPd3NhgyjfZ8q0FWuRqkcmmZ9JMo1mvlJv75UE+Mf/le8lBYZShuXNF2YCIOijE1tzhoprbiNgsi1tnN9gRFufWdCijIyoYU4Wf3SmDdGLuycS9eEySRfRI2+1IOuL4vq6Q31zUbOaiWuKlWCy2efzdTnmwdFRrGNHzHLM1jN3/vB/WsD8/WEzMd28lB9MjilHn1W2kR29MpnzEYgvSHr3xmBoOU0xG0IDiyR22eMKt66jFM641PZPiEQfZqbmHd0Z1JTiQjv/g+/qOokr6Y05FLUkWNW5xtMxEWhy8dMRochGiWXj6aHAlMXfnTvxrd11P5OAwEbSmfJ/DwQF8H8H2M5J6/joqDGFtwXzI9lSlLXVQaGBThg5jVLk7hPFItm9WqsxCSlBE9CiVSQkdvi+iVJqEb6tKl9tGMlJJmoIe7l4x8oDH4XUlQmi3UHEo0heZ3KFHGTgcNdChBi4ZpzwzVklkXEkhgTerlTub7KhwniQ7gxtlcPlQT2WjbUZ4KnsEJ76wvzDIGOPPz4eOPz0Bo+r/fKTxpyfUcYw/zY7uWIeeO4MXp+a+tDn2kIkaCoeMlyipic8Obg1eSMxtbsYPHoa/FlChImn+TLQXAirIsb0NmC9R3irR+6o83EsZddFB8ra+s2CKpJlrbHOLZatMjilV15nFrNlt4Nuazut9zVcLfd/svLo9PKwQU5kUTpWq9nvGrzYvdczLr6vKtoo0zezbjmQ58P0/AAAAAAAAAAAAAJx+4Pt/AAAAAAAAAAAAADj9wPo/AAAAAAAAAAAAAJx+YP0fAAAAAAAAAAAAAE4/8P4PAAAAAAAAAAAAAKef82f+VezcxHps8r+58N3z33iuci4+/U+Tf33qM2en48zE+nO9k07fh4Enbw5+IjF/K5fcf9V0wiwrutSWBMP/7Y7SVzXTXTS33edVcfi2x83yiPDDTqeHA4Q5UqalGSLNCLwsKzrTQowRkWh6UB5cGLxK8nbwYnDeDF/Ph88bHX7YY7RP3rZuslWmym5d0SR5u4N0RWYuFZnaxrpzYYZhanUis4dU4jbalDB/OvcFFfG64RvTFHGuOFIq2pNoNfbvF5mcI2XkhOj6IhFzLoRViCTv8R1JZHwqRld5WZPwBcvld36wcqTzLEacMXBs51mMfbrAsz3PIhaL/XhII97/5OAqMXTbX7+PoUqyhlT98IZOh7cKplJtsPVmmKGzb1YazcaCWRg55nq9dttHmNm6ydZZxm4BxVx6zE6A76iIFx8z6JGk6ZpZbgexQTExl8vF302T4hyOePjKxIsuZ74+acWue53Ga7mtpZ33Gp5rHZmi6T3bas4Brm6t25a43U4DXeOa990efAvZ7GquUFhczq/ms4WCoUvTeVXnupLc11GQPpeMpTNLdObySwWiB8niCC2UxLAO8gclcanoSpnheVjqIu5nFBmFeS8ulxrNBUey1GCubdSupYe8GS8vE51URxmQbErC9lpOdYkBoSiJq0UqFupolRcGX0zMa3eSg3lPnxfiUz+oxwsOEtDfjRFHcG8XrCRKX2eFZuzQjBHa91CIFwavHKG03OdCPJvSGnU6xPtZWuXBy9EOavH6sh/vpJFxD2oZFdu4J48c6aAW84iNsINayoPCUYsxyokkx1eMhzuh5FkXY36wNsboznLeP9bozgw0zuguKJ4xR3emmkOP7ozwAeW2eqRyi3DK27GU26FOeXt25Yb3/0/M/k5s9nfexxdmAAAAAAAAAAAAAACOhS9MTMemp+PxpcnJ+JtnF0pdpEoC/9LrfaTqCleXBCX27R/Evv0D4/3/T2KzfwIFDwAAAAAAAAAAAACnhvMTidh0cnpy0nn/PxcTYhdeOT9zTpzRE/9Hop+YOvsPz+xPvhkTjiXGg93BrcT83YvJrz80P83oqUpb6iBOUET0iOMFQenLOvcAPXZ9CW5Keb+3iBbY+4HFdfvDCA51eamTGQqOP8KwojS+u13AX3S7gzGVBvlyMX2pSO4Oa7EEjG/C8WeuDPkQ3EeP9RUk/sYyICpThGjBYh3lIVIXdFXq+iQunb5UpASGY02nbUWBiSffv3tvzDDMyWTo6PnBMQbnKeSDGtMWmDIOyJgBGay129d0Rtjh5W3EPJT0HUbSNUYSkaxL+mPre6QvDF4jRj/gRxo9/VX42EYf/kn5cRr04csKX+j2ePmxb0ldHVQS81+6mxwsRf9adW+pcIjve3Gw8b9a9YvrMN/5YkVH+3p1b6ng++3b1cHNI5Zg1G9+j6MED//t7zMrwc7gxtTcV+7GY5IsokfabkfSEY5eIb+5iFlcjCY3ke0Mrh9DdLmI0b108NyATczdvRv/2i7JdLRwEbVfce30iBaIPEV4XUfdns5JomeLQp29ztbZaplt2BXJmcLagiSSTQVWfxgW2Or7qDDGl5F+OyLsm5Uqs5AivWAqkxI6fF9EqUxKRHuSnEoTPW1V6XLbSEaqYWQBuxq8YvaGCF2JENotVByK9EV7e4ugqGLo9gpaxE4EtdNmwamJjFOuGatEMq6kkMCb1cqdTXZUOE+Snd0cTzqD9cR8o5Dc3zL7K6xJJhVNHkpcT+lIwmPXnkd/EU9fFEHPcM/tHyisn7FDMMYz1AgRvIfyM4Myye9BOTy/9AD2KPkN308ZkN/TuqcyoLKG91VeHlwjtTS4G15L9IjrKLUUPnILqyXfDYH+AcbcFBhQWL4bAwelQSkxVyjE35knjxX/BPhfnci4HhsBaX/fNgkiGWdADN6NZ91mFrKZXPrYNxae3M46OP8PAAAAAAAAAAAAAE4/4P8fAAAAAAAAAAAAAE4/8P4PAAAAAAAAAAAAAKef8+d+L3Zm4kbs7L87848nr0zceK5/0in6UDIQBrXE/O2LyXe2PVtwra3UQxshjftBp0kEBZspXW+ydbdbA2snpLOHljohz7l/qWjuoDd/G/uA8HY+Q1lQ1BLSZhimwTapuIpu1Xg3CsNQu8aL1uakcqnB4j1IVaYXsPOcaZKk4r/YjQZLewTwBkmn8b4jEpcLsv/J2u7J9Mw9T70rQ+kk22ZcmyaJALWhjLE2TJmFYaqQxFdm8JanTw+qpJoPNkdWs7G9a+xqNoKZ1exsB7Mr1qo081al2qyF1dyCkxF6kyZVVRmqNLA/BbPijFxn/Or5GdSpodi9c3BmjIoltbOfGtxOzD/YTA4+FXQGzHB503slR4pLo48dCo8hwrkvfs1vnHNfLO8Lzt53nw3vP9cebJCi+ktz0YuK3rD4bIoqfEtkpKIyOr5a09okSQzLvVPSaksM7tfsBm8ZldNgyH49zbHXvaWCZXbkgtkRYSkjGsuGLYFLRXMnOd7KSqfHwJ0qx8wpEcrgSUKsrh7H2bui6byOiilN2pbJ0ZkpV9doyIzwweIWHvL+QfLrdppiYHhecf4lPlg8pe6bRyMxal8m5w5aqlW0pxjnQ2qMVa5W7lUq465SoDKAo3fknE3nRbq87dSQUhGQptE76kP6moBI034JIPnzMxNHysq8Jig9RERdVzzyC6pVz8axYZK8TexJvSL0VRVh8x/21uLKdZDwJW/t0pWaJtuva03TtF2uY2yzJh58jLMkvaqKq0uUaWj9lqarXqFMLlNIF1N7uZeJvpdTEUJk0yRVNzZq15jUC/feyl4u8Jfb919IGYmv1X2Ta/hxCE9vPkp6c1kzwURjpBTnwlKcPmLfLipIw+erMl0en/aF/euYoexjb8+EHXsLAMBHF+L/P/l8LPn8SacEAAAAAICT5S+2B3cS81up5F+1fGEFT1ju9lHfnN0y/kSyrgbP/oQqGJ7zcan0m9wJmdp5rVZxPKAyPeIP1ed1foO93jRko0wwMT3eeNGsMj2emiwq4gkkYxqFd9483bNHMyGTTTPBsyhHmEOJOoMSOH/iN1UyHMovs76THT0+YK7jOGY6guc5evzwNIfjO9gq5wVv6oqpHlI1ReY7xtRB+OSWbT1mGLuC8LqNJG9rTMszs9XytZ9WiPnQxeXIcfoO9s9m167noiltli0v6NIesiYuTBfKhm/n4fx3eZnfRmIq4vze8RUBSazhjNNMMHbCqfPCDraKtF/qPTO1ps/OD3bKfYzQmw167qpHa3emfTPW30pfT4WWCTVvFzZ9HHnqOGja2N3gfBtPUA349blGl0uXvn/Xy0eYKjYS7U5f2Ky4S7IYupLlzI5HtMsx6jM9c9SpQsmYKDQ7SHN6kLz/J/55LPHPYcwFAAAAAKeAb1wa1BPzwmryV7zHQvh9eKEjFQ9XFdk+h8QYslB3xvmIyaPO92SS4QgoJ+TOVxhDJ8vA+z+8/8P7P7z/w/s/vP/D+/9xvP9/N5b47kkPVwAAAAAAGJdv5AeNxDy6mPyV3ZEv+8ayFEeWHly7OaK/4A+rGD5wl9zMmJJ6X5V996iR76XdS5PWwV+eoNQ8QHrkRIBrN8UxrfAbW6KG1vhdh6rSq/w++5Tet1V+n2iPbZ3fm2FY6R9vsZiyo1aoGY1c7XeF+fCt97sK4hAr/t4ie3/X/A+fep9V/+GsHGnd30fdqVz5p+qAj9D9ncDqf6iNflDW//80lvhTGHMBAAAAwOnlGzODZmJeSCV/5ZMjZwp0Xnvg6/YB34g+WzCkJti3A1FMfQag83pfc2YGYP0fvv+H7//h+3/4/h++/4fv/4/j/T/x9djZ2LuxxB+cLSS+Ff+/Yu+e0LDk6VuDu4l59Grya5/1DktEpUe+JOwpHUl4zNmz13gkYXrX8pcN2YUYQWfQioavx73hmN2DGFRMIRk74PKdWw1Zuxi9lLAQ4uzmSBOHxzZpGDRZ6FrSiTjBZZUzY9Qco6LdvqQizbJrqgVYlm+a+tPXBm8SC/vql8ayMJcjv2OyMNPLX+AwGKzpA29NtwdvJOZefTX+tRRxrBdYc4E3JlYt0yld26Dcb3rlyCKBnY4m+2aTeb1euV2q32VusXeZ8k22fGvBvk9autFuM1ZXkCZ+L6l+iyips9fZOlstsw27x1kwXWQanQaRskvdiIfqTqz+LJMSJc3404hIRXsSKd1KtcniNuHRYd+/xja3WLbK5EiVFrLZ1VyhsLicX81nC4Uc0eW4gwzSRklcLTJZEspx6BkUipK4WqRiIcENEcORmF/nTZUkbXOmAzI7jF0sfoHMAOmZNNNo1ivlZiwWmyZPwvpga2oOvRqPSbKIHmm7HUlH+GVaIb+5QDvhcsGmtvaNTww2jbf+dLS3fj+/mId46w9zfmk8UPsavP/D/n/Y/w/7/2H/P+z/h/3/7//6f+xjJ/TODwAAAAAAAAAAAADA+8IM/h+8/wMAAAAAAAAAAADAqQav/z838UuxC98//1efe+9ca/p3kv82uTv1186WJ383/kMTvxRrzvynk07jR5CHA5SYezItRP8IdMilD3Zr0pV0389CA4Unrg4qAzExJwjxg62A75oDA48TT3HEt8+BIa2voV2fMtPfQwd81ow/Ml1nN9gmi8+vL5fWWfylb1tVuvQh0AFfC3vFrA+Xs34fLhufIOtKBL0uoaInlheNL6B9JEd9OG1/U7zPD4TE/INa8unHvce8B/i84ayPsz3HvAe5yAk64z2aeu8XwZSDrqAInW01lqpLxdrGuv3rxZzlPsz5xPuLWMD5GfYdlRUvY8bLmPE6H7VLGiPJe3xHEs1PqPbvD1qJea2WfDoZtZAlEck6cZTe7fZdzezYCno4Cp/Pr+0tdBnru7HMsDupDGmVRslFqqHDFK+VXFK8VorNAh5UBnxivltLHvBRC9j5Cv3ZmLFHf/BGnlF2HNWX/ehz4zzHDA2dQO+RGeVELPxzw8B6tDfW2J8ddiWNnE1uVuaT2OCnE3PFi/EnOePRZubS7vLNvRjW9YkvmnVTqa6zbzJB4jPEX591d8F5QGSo/SHrbKOckcT0E27AJebu1+L7F+k0BFeW6e9wpNzEK36JHanXlfhgaXuTT8ap/rRjGy53b4OpwVuJea6cfNoP2uwm8LIokd0Z/n3+sODIvW5BKoP7eZ9IRvfwuLyMPr7DazqntDSk7jk9vfeiR1zY4eVtj7RzbaxdY3aiwx4P7OB+Yn67nBw8GF0TwQ+GI9VGlIdB2BOgLamazomSJih7SDUa04hKPFwxhj0GniiDn0rMNcrx/Yar1frEzvWQ0WSCRSZe9m2qIcrcrdRH0GmfXgs0ep7hgnVar9DhpS5nuTsxY0ztXx3cS8zffTU5UEZsWR3RhMfcrDp26x3e9PxMRmfB2zYDW9+PDn4yMc+/mhyM2lYeoemNWYpjtTrqMRVawIconbBGBev/AAAAAAAAAAAAAHD6gfd/AAAAAAAAAAAAAPhovP+fvXA/Nnt39uzsdy78rQv3TzpFAAAAAAAAAAAAwIeOxtmtya0JXhB0bnkRIX5xLbe2JBTyy2tLa6t5xK+2skvt1pqIxHbsve/jz9e5lpDP51ez+VUhJ+QLK2ut5daykBNy7dZifqW9wp89hM5VcaWwmF9bWVriF/Ot1VW+VVjMCau51dVsfnFtRThD6cwtrwpLrbbYyq2s5tvC8lq7IGTXeGGxsJRvi+3F2Ld/QHQiQRBWVldFtLwq5vmWuLbCF4TlfGtxBfFCK7s8eQidhdVFlF0WFpd4hPIrK4jP5bJrK0uL2bXlAp9ro3gd65weS2d7dVFs51aWlwrL2XxbKPBL2cWV1nJuaUlcXl5eXgL//wAAAAAAAAAAAABw+oHv/wEAAAAAAAAAAADg9APr/wAAAAAAAAAAAABw+oH1fwAAAAAAAAAAAAD4aKz/T8feisXfeS527lvnvjBzafoLZ/548n+KvXUc2p9+biAn5ne3kl895zl9UejwfRHhU3wF7Kagw/dlYYeTZB3Jun3VdZZlWIigExmjxxJ8gnNovMZ5lyNOcPaqsM5GlpDG8PYJoPwV67xfTVB6iBzL7Lpin+LMX3GON7ZObzZ/umUinvTshCFnCF8qplTUQbyGxFT4KdBlki/GzBdjFA1jFA0jKHK7Iwm6xjyU9B2mI+05kvbp0NYpna8O2on5vpAc5AJP6TTzuI1kpPLGJaR2JZ2TFc44PTR6mNEneI6OLcqpqIHxh56tbYRinFCMqnQ6+ORdxgjud5Dn/qVBNzEvbSUH58dpakOFd+zNLEKBhTexwxqgTyF9LT/okP7oL744Zn9k1OOz7o+cWI7UH7naOS8ISl/WuQfoMVNpMNXNjQ3jQOwOkrf1nYUg4fSl4mrekNT6LU1XAyUzuUwum75UTO3lXjZS93IqYsBcmrmxUbvGpF6491b2coG/3L7/ghm2WmsGdqxmUWlMz+4+e1eCO8PeFbuvt9uUS9a5TIUhnSFTqTILKU3alpHISXIqY/2t9PVU2pZ2JxYzlGAj91aPbpWCivYUgcSsMaoZ1MiQOqKXt6J25KJlzhWOJKqYMmot5bkf5XlkSS+oRnlZzw58ejWuRfWK0FdVbN7+dmgRJHqpGGifJHT6CE8oFe32JRVpjBmvXUtDz6cnDwcPEnPbW/H9V1xHj4e2Rc6UiiQ8sW52GZvVyp1N76nkkeJxn08eGmTBkqKPIHeukfqpNUkd7U8M3jayXhsj61YDjZT1su9J7JEiGCfPTvvJDDeNjKbz2+T4bb9j2t8eSFNzX96Kx4wi2O1IOsLDOIX85qIleTFaaVx7e7Bz9Mhy0SL7ia/+ucF2Ym5rK/4XNl1nnocGi6b7VeshWLq24VhXaBgG957m41ASmSb7ZtM2RKtllG+y5VsL5sPLlk0Xl1bSmRmGGa49jxpXeJ+6Zq6xzS2WrTI50rEtZrOWXtN6PPrq7HW2zlbLbMN+LC1IoisMNZKrVJssHhF4kuMjaSUjS5JRyGZXc4XC4nJ+NZ8tFHJEv6s79s2mW4I8y7q8jC09lUn1kKopMt9Jpd0lR/fUfkpJx+stQLpnNgYOxoPBHAIEjxu8w4YIwXJpkiTfkQPJCtWVkQxQdWR1ylYdqWhP0kJqxr7vNgvf+rD7kCBljsDVImPYlTE2DgtESVwtOnGQ0K/XK7dL9bvMLfauu64z7t7Oa+QzaabRrFfKTVj/BwAAAAAAAAAAAIDTD7z/AwAAAAAAAAAAAMDpB97/AQAAAAAAAAAAAOCjsf//bCwVO//75/6HmXNT2VjKV+znzw60xDx3MflLnxpjgzbZyWptijnElmvXTlhr2/B1azcfvVmmVrU337i2wHrkLhVrG+s+140tjDOMaw/nofbyO7v5qd2bOFJ716Z7Bz+1Z9M/aa5Qw/vz8Q5Isnty7JR7dl5JVOKl0MRLYyXeTJ6RsLAtslYyrV1J9lbZliSLkrytMS0z3Gu1ir3nT2M0sgMQ7/5tXXH2/bi20mrD+SE5adF7fHlBl/ZQKpMSkc4LO3gDq7XFlN7layXenZWgzERwBWDu6bcVmduZycXAerB3KRtibVXpRjYlT1hd8dk47B/SKAlzw6+tDQcx9v7iaMlf9j275r2iqY6yLeEyIHXr7DwO2k59NIsZ226iWA+5bmys2lsqFFOCIqJHdE6s3LTondZEaAzrc5e885djmyO2QBPHG2YGsVMOHTuTQKrGdPsa3gNNehKmhdqKihhzmx3te0LY4eVtpJk7ob+6NVAT83cvJv9CedSDAG+UV/r64Z4CrsDDjwCj5Hx7/eFt+3irfialoq6yh8RU2rAwS9J4JBiBoj8FRplcZFM7jg7KbJBU47LyStqfv50GWGbasCij5fppxME+jE/JY8/T+/X8fBbN2/ZvwCBZtJr2YGWwm5iXLiYPdt1NWws0d05F+C+XY5SAJh5Rie9ozzbe8F2tlCuAiI6ZwpuxUZl0kx2vbYbWmxGCsVJg7eVmzBQY1ddCjIp0SUWiVYNWTRtlZtbc008Peon5exeTX70xqlOWRCTrkv74cL2yO3RIXaEuL3UCR+W0jOlqwrR/+o67VR6mAiP2wod+zB/p4X78rdqqHc8j++mnBkpy/slkLfmO5DGPwCbp9kxkJNvt/iiw5ANs6RBRhTz2R6bCdzzgFL9VFXg8MMMEjgjMW8f7bPB0Jy5TPLwzG6u/EHhZQJ2O02PYPYxlTkbOTePA7//JiUzswtXnxMTfSdyeunn2JydvT2Te94mIDwFPLw6+lJh/eCf5zpfDvYfZj1fbWQux53BPa9QYKZr3sPBYfBqPbWiZoXYUnBZPQyqmWkpfNsdMYS66nG6X6mFNT1aeMbBvL0t5pLLvj/B5qI3h83CchuaMlqwmZD+kJa3L63Zjejo9+BnDQDYPZyCSrCFVf9YGYsQS2cMcGMOhjOHJ24PHiTn+Tnz/cpjjLKp0RzgMoyQnXoviMstHdai/LEp+wdtZRHAT9igx170zwk0YnSQ8xrFHlBHyXBnDQ1pgPJELoCeJnKh0eUnO9Iy3DYHTdF7VqZLwvmeKg4dTcw/vjOm5i05rLkI53Hw3M9hLzN25E/9mKcxnFxUmgtYbUbx10e/xuMsHZ1uHdbYV0UMVNtZ1doNtskyDNSIjrrpw4wvwJCaJzFXTaRj++4tFf19Vjn37+viibhtDZ159SNxfdiS5/8jxGGY2ijAfa+VSo7lAiZYazLWN2rW019NabnHN8qKl+3szo4byQoeXuqRgjfFIhvI7af2NB/fH7uNLRYKiiqEOu2gR28+XlSQ6nCVO3TEcYxJ3mNTlq0U6XqLPCGsUCdUFpYtD+szEGUVBFeQleyyHPbX69urH42Ns8Magn5jvX0y+8/lR0xN92eio2xISuZ7SkYTHnChpuJcbd64iRNVM6XqTrR993gLXFDYUn8kLqhCNkeYMY8U3nGKcODzUxmPoJuVpsEjau1nFZtrFVMYy16L1x4s5XE+0L7ni7dKblOO4DM6A89N5hHkG1eaUh++MhpkMJBupeGUGTxleHeiJ+d2LyYPHUVYDjLn4I9ZroKKhWh21SFCkFwjsirTaBnXvFNcgfv+Pfeyk36wBAAAAAAAAAAAAAHiWwP5/AAAAAAAAAAAAADj9wPs/AAAAAAAAAAAAAJx+4P0fAAAAAAAAAAAAAD4q/v8fxc5dT/z7s2r8n8Uexb7+fsT79P7Ba4n5SjH5tVdNzxG7fdRHXBdpGr+NOBVpSqdPnCtogtpvGXdRu40Enbrp9RoRrsT0EOF4PAvSajt8MEUr1WbNo5sodFysLWDPMx2kK3JGRbt97LIVe20w/9a4PV7o97sZx7Uv9uDwRmljk20wCzni3UFQkeXsIZvJEX/FVaZcq17fqJSbjv40s16zHFE02CZxG0FFWbxdqS7QSUCPhE5fROIV6iLx62IHs1JHXE54U+wNbt0wVVAujMulBuu43a9St77o9aTDNN0CL+Ysr/obDdbjjI8UO2MWO0OKnXZPjh7t8H1NNx15MtjzGnFscfDJg0pi/l4q+e6Sr4Hp2Ps99hyqq7ysSUOWJuvqsKO9iCqCPZG4lPv6KOV7vY5EHBu1eYk4C0nZLj1T6RMxTMoLCRjm0Q3zzMHNxHwjlXzXOkolwKoMN42HNko6eFDHB3b40e0g37l5UE7Mb64mf37WtEPbhRV2Kaxip9XYbbvlosj2GD4s4zHIKHqG3dPaTtgMh03DGszu0jyDBXdMthsl7LfJcaVkem02/DVT3avjadw5pIQ6oMS+gd2paT3sh5PrqajHq8YRAvbhJPQJAiFyxIc4ds6MvbbZzZLq6smAAx9AgL1RCx1Jpnp7u7qcOAN0FVPoUU/yidtOnChtI83lC86j+dCShqtsz8WgIOhRDwn4OeKptqDbHj12rh03eR4J5zl1lagWES/iUuV4PephKVKng7b5jm2ADGWAjoU6z3vT1+u7KwfXEvPCavKb90e0JTOzbQl1RO3oTcpHnV/LctVPJrjII7Y9o8VQ7cV1jE+0NhJmpVbVRrXPIV3DGQtVG2SZlB2ObNA++sNkvckP786Mw0v8Sj6kdKPXwdF7qfH6qKg91Dj1P1bvdDx90+h6G917Reu7RvRaAb2VkXjKY7WkMVK32ydOgyn//+D/DwAAAAAAAAAAAABON/D9PwAAAAAAAAAAAAB8dN7/Z//hSacEAAAAAAAAAAAAAIBnBaz/AwAAAAAAAAAAAMDpB+//n5jVYrPaSacEAAAAAAAAAAAAAE4VT2YmZmNbFzcvfzIW++TF+enkpIY0jWsJ+Xx+NZtfFXJCvrCy1lpuLQs5IdduLeZX2it8T1V0RVA6+XyWcJn8D/+4vGb9NFkSlG6Xl0WO72HXgHxHR5quyALi+7ryMt/p9OUHsvJQjr33/fPT/2tsanIrdv4fnY9dWEj8ycz1ya3kd5PfndKn9JMuKAD4kPLu8welxPzd1eQ3U6EOgYm/VJ2zvXIe3hewV9OwG+AgL6/vv8/fZ+VE90PmTxh8/oLP3+P1+Wu1EaOt634Ofwf3Dl5NzHOryXdeDO2ZbK/Bx9E5+Sgb7p/wKAifDyCJmZ6qtKUOMv8U8PDIOdEgIyiyjIhmLDBjHNOANJ2TRE5/3EMZ6rfc77aQSl/R0SM900X6jiLal03H6DMMo++oiBexXr2vEv2Sjrr4X2sshf9+IMliptVRhAeSvJ0RJa3X4R9zb2vmISsIH7eAj5agazSwmx23kkP9Oc8WYnvv/+PuYOXgJ8jj7t3tUKOiDso5out7ryYfcxrj4Rb1MIkFn+ef+9ln+0z3PP8yo/yoZ2wX6aaocW6VOVJPpdP2cRWh3t9DU/NQlXQdyc86MVY0AWk5asRHOcJh6OSGJ+WDTyXm7t6KP+lKsoge4TckIyMi1+qL24icC4bUPdL1aNxDSRaVhyOkJn7atOFKdZ19k4mm0zjva4TsAtVJGteN42reOviRqbndW/EYyYS225F0hHtdhfzmRqUgNypDb+2fP/h0Yp67ldz/ktnCR+m0e6YRgp7mHlmtt8WPLLswo6GCMkZQhgrq19HGYrF/FDsl6/+Tb8Um3zrbTP7ZSacGAE4T//mPPV1JzN9NJ/8Wa/aaVv+N9pCsaxwvCEpf1qkBMhnNuKU8PWQ0FVb36Jz55g7nDIDYNyuNZgMPcMyuMcdcr9duW/IaozGv1SpkHIUH5RrTI6OqK5JY1K44I/UZcqpZnWU0fIc89u1nlf3KSwcgMlbqKRnrPK7eleGxPwljD+ic69YRXs5pXv7hr4aHNxKAx/EceqTjQcMCDkBKzBjepz53paWIj6/g94xUupjqa0i1zt6zDuByZ4OcuWYXsYO7sPHDhQx1eF1H3Z6uMV2XtFG03SvUm5RvITvgNHSv4DcVY+RlCl7RkIxHV/ZPHSHVPmvMHVgSUben6EgWHnMP0ONilILRlL4qoIoYoJIaCprHrmo6r+LT6TLU0Zd8tyVt95W+FqCFDOMEVeqR4Hpf80xHhci38fux9DNILGZ9RF05dIUz59esvJp2i/PpZ8eH1GpZ5g3bMFPpokchZpQVHyHqsv1y7VOHGDzzRUfvehs/WpHqiuqf3yiGZwY/Sgrw1MDhE2CEPkr8She/OInlHR6LIlU7fGJ8VPmkrFwrbbCNMrsQvZJ0nRd2uvgJkkpnUvfu+yfRX3FQzQ3rpFTSf9fqEbpS19mmzK5PN7pL9ZqjO9Fd/Dw7cte3S3d9eMaI14Ud3GFF7/d2x+z3dg/Z7+0+k35v9+T6vd0T7/d2T7zf2z3hfm/3g9/v7X5A+z3rL+PfEdNfZlfGkPgYs3lSc8ZdSeviroc6/29i8luxyW+d9LsSAACxWOw/k57WE/ONzyf/JjInDR4q6gOui/BKVtDrPiXinS+IEHp4soDW550qIK+21phrhvHMFpQaTm/DmVdnGM8UgkvIvGpO4bov4rHXkDr3rMMGe71pqLeGcfYz2ptdPCAsNZwVIVuzsZ5R9blDDxWHE2I/+fFTxSewdck/D4b03lLBnjvxiyFoLmVYlhph4vWOPZTKpCQRT1mTQM6HB+6qHB5C22lT+7IudZFdkCraUwRjOt1dh84N54R7V34cAXoKaETVOmUbqoiaHxo2oOFJoEiKI1bbCEVW+WmC0kNFHwNxCQTOH/nqtpfdOojXPK8Atbp/GKGvqngcYtXnA/TYc5j6mKEv+WWKuu8ZxDinRVvZWxhVKPgVR9UUme8YC4oeww2YteSsQLYJtyTyouSxW/Oqrcxrtub9iL3AsC1Y4ce1qFF6OPtDhTCNttBIvaYxmd2GNeBMU/Oqo+upy8v8tr0GPdzHfEiqyq8XFREequNGlvYrm/BKLaZEtCfJH6ly8WnoowpJ6PB90TOJPtydU6nQpG0ZiZyEP2gw/1b6emqsmhEUET2KFGeRim+EvB0F6vJSZ+jzwuCAJDV09xq1d/XtGIPsKmBUhD+bEB57xkS0SXkFxrAoI4VDCsYdCQQq8j7PvMUdJWCxozxE6oKuSt2FUXVq29ihOoLjMvHQqYDUVq1+i7vN3r7G1rnSZvNmrV5p3uVuVxq3S83yTfr9/9znYuc+B+9eAAAAAAAAAIB5982njcR8MZX8hS16Qt78UotTlb6OqFl46wsuv2l4nzABc++WFt/J98uXmbIik8VFJsfwssgsMi1F32HMz+uZMn6RZDrKQ0ZXGH0HMegRlt3oy/xLXf4Ro/d7HXTF0HRT2t4hOvodXeUZYYeXt5HIdBURdch1fQepqK2oiFHxy4/M7CEVv9tcbiNZQOIVn9UAkgWd1x6QN0u8nYlM0OPL5MpDkk88ua1fIbLkJY+exCdiGvlu0ZoDx4JItd6sqCD0YgUO1sXBupZiOywnidZXaM6LK9ZuT7/rVlQ46Za47qfInt7QqU8gPF9EmPd7qvI2/tDNvO/8pHT08Nfmunkf/2leb/OacRX/EeUrSuf+iDi1gDg1EhWHZPytuxgQt/8ECj3bY6nHn0kQOy0+9F5xXpudJBRTHeVhyjODFLJcYf4M+IQSW5D1GaWzSmTLORtMDFGVWJt6xWqk2DrwR5CuFQ3N8w0mth+jYIyPLYvOl5UPJbzO7nrZ10Z8Aenz/Q8JRifKNWEfYQqg1Gyyt19vcvXaZpP1ff+P/34s/vuxfwa9PXAK+eVPPW0m5jdTyb9d8nt8hy2oR3mUj7ekHvpYhzX193VN3W88ccildfLoi7bWEBBB+BM9yrK2K5xzOdJzFJb9Ydkflv1h2X94RQuW/WHZH5b9Ydkflv0/TMv+1jt/qVyubVab4ev/k8k/i53/s3OfgP3/AAAAAACcXp5++ulWYn7zYvKrt+kpYWsOzp7adU/pWruX/GaDRwQNcE/n493Q3IVEIjImiX0miKlFVnqxiw9fQ+V9ZzzNSVJ6GZP4aKVmQ+mhqdDhpa7hv821iV3ty7LzHTi9FGguQHryeanoROnrx8V2HHeJ/vI6ZA0y8uD49XrtemWDdQbJ1uDYHBMfvPX0DWIdX9+krcP+fNq/iq0y97OOEUGHrcPtANNcu83Quc4YC6YZerU241lhpbz+HN6WfNbsDUNym8+QaR3JirD3P0HZQyref7TbJx4BAy3LLCnaoiTRWVe2ig/f9yyEU6vPTslesmfqXUvTRnCyTm5ep4se37XXyT2OiBwdds1cClwOtwrLitRZEI+0Adyw8AbbaFRq1UALfzr1dDMxL7yU/OpZPws3Vq6DrHVonT3M4sNVhXjtHIrFMGBsVEHL7JbbZstBJ+V72uOf2rPwbgq41kYiNI9Rxk9/J0AtaR1LQ4hsAo2tSrN8M9ASyPp/YiqWmDrpZzIAAAAAvN98c+/pamL+7kvJX1XM8ZA9/Bh2oWVcjzQUiqZleBTk57crM+T8K+Pvrihk9ET7OyejKGs45fZyTr6A9XMdhsX9blCjG09Y002ZJ6BxNTgUnZtKgwzq/O+6HZGP6ezSGi/6eFWTFRkZ75pBWbbdqPkIeZJP7UQNLqFhf/IjYw0vNGsP7LMqIld6I5VSQMZt4RFZtz729XXRGuy5y/xYPZU+rAIf/2yu0MGVT4X2Ro39x46Id4cXS7SHMKPadLWPvz1r8x3N+vhs7Bx5NdNZW3C7MONVlX/MdZC8re+4nS6OUwZ0ZOlMNn01S6d8wXyJIa/uCy+kjVcuQz8v7IRkJp0uLn3g7Ztv8bKo4IMOojdtsG+wb8q+R/j8s5721LjBPAHoJcMIqXMvGEne4zuSSL3/x882Y+f/7tkmjDsBAACOxt+89/QniQPH71dcs+vSNnbmFLbfxBDxn1APDR2w28TUB5tNTt6BY1tVusey1QS2c4AXR/DiCF4cwYvjR9iLYywW+92npad3E/PFzye/Zp3kSg8UTIfP44wt6CDjDih8lssthwxGToKcMXhO4vA8JnH14K8tnkFMuhIej89XAO7PqoY8WgeeizV0MpYrbnoAErStU+dVfJyh7wdToz8FqNyoljYsV4CV6huljcq69f6f/POx6dhfiU1tTfzaxCdif+XCH5z/n5/7b8/95em//QF4C9APqom5Vy9OPPkUOcbS/HhH4zp8C3Wwy0auL0u7fWTd6JvGvVmt3Nm0Tt8MDGUcuGndXrBvp5+cO7htxHvDipfUMaXB6FKsG3pAvP6h7HjJbSpey0rMj95U1FXwSanvZg82EvP3islvNsx2bp5wY3zEQh2T6nkpCBDzdgERtQ33CEH6w46WsxzEDB/SQ5qTSyXCfa8sIIZ8EISuGDclsYhP5Bn61NH5zpE+3scemJNTfHBTsrTMeE7mKVLeNyhvJ05teD/DmUnP1OrGTC2ZUTOP+TDSbExPXyrmsIxzxLBduMY3TPj5gmTOOgDItQpnBBAQniQeWkkajpgWJfHSYvZqg0cqpbSw8adGC5NjYvoqORznUjFFznyxQpmrA0Nz1kHh08Q2rrHNLZatMjmS58WsMf3t6oTDvL34n/LkOgaAnOBtPXXtjtr50K5WZXTaFZDHbuxeWTdPdjIrzYiZfDuW8hVzLJS6Zx4nXoxcSi6vM/7Wa00NW5/LDtmXz9LDkEnZy4QhE8wkVsZolowTS/CxMk8/e3ArMV9JJb/Ku/os86RETkO63kF4RcjVVRm16ds/BYUcXjw3JakeylA7vARuShZT94wMWiHNnpfh2zpSGSfG+8MtlB5m2sd4tXmpQ51rjf+2V6n8Ldtl00MdKqOaZqA6fSD1da1hBvQ3jH6DF08xCmq/5XTxDG9/y4iPEuggXZFJHzJi5cFdbvQxyQx6JKCezrQVugSNouU79iHKE8snPcj40DFAB83E/JdryXemraO4rdM5eB1xHakrGQdf6/ZntzpSu3id0X6kGm1nVLihs7kPGc9wG1X6uqB0UaajCPjNyOlR8Bkwo1LlfAlMb5klNkYaXUfRzBbntFUsbUZq93rslnXJapxYaihJlLj3Xvjom0lZx2/hrFwmWSHHiuuMVVCMPcbxOWJ8//mDemKevZgcWPsQfMaydiDrnqfOwoIM1wsRytii9ADZ7D5xKeDbVrGQIiMXzK/incBeCeKxPqS0zJiMRDC4XHTcNfmVzCcO7iTmb11MDm6FlIysIdV8SoxROFSo4SFvQGF4zlFxxkTlUqO54BYrNZhrG7VrvqOgfLawElZC5tot4y6pB+ixYzGvD1mM9y2Ethi//UxhQaJaDLV96RlbDDk5KpLF1IYsZiibbouJWjijLMavME7AYqiScizmpB9mAAAAAAAAAAAAAAA8e84n/vfY2fhG7Oy5+MZzvzjzH6dz07nYz0LJA+Nz8MrBG4n57VryXWuObeSCgYrwd03PaDWCVj48cWl9ROnvgmmMRYhgRZfIkm3wfcsxSfhXR4FJMfKnMSr1iZF6RRJRt6foSBYek1NNjYVC1zXqiyPV+OLK57Oj8Ky5VOiKn4KReXcUWFlsSzKZmZVk3fCgMnz90EsuRmm5Fly6kkYOTjfdPr1+sJmYf1BLvrsb1XytGednZMBu9aFeohRV2pZkn3LO+JRhZoZhHiL0oPOYeyjJovLQiFfjeD2jtDSk7iGR62tIxB8vCkjWM4KKeB2JHK/PjNc4aPdMbndNxqw3WZcLSrsRJPC2o8Enj0ZYfwMyQwUUgREy4CaVar+CMlPsd8sJ6RSm2UE4hXsYww5b9jj/6xN1eJQdJ4ObBz+ZmEe15MH2qF6ip3Qkwb0+FC47/O3LOLqH155GxuYsShkr6fhJRH0yzfXlltIn26fx52+yIHUk6+gsyhfV6A9n7Y+vetSjinwp6+4TzI9gvV9AHrrPN0qJMUqJtA/X5tfBxw/uJubR7eTTr4yqS3MsIaIOsg7uG/VcjlqVPqqtqlxnN1jc1YdUpRnZCPd+I3ts4tDM+gQoyhDi2B7CfA/vtL+syB17FfvSwZukWgbzEaul3xP5Z1QttGrvEzhCtTyzQorF4jegZweOyEwsFjs7+1Js9u7s92Zfmv3O7ACKFAAAAAAAAAAAAPjIk57cmsCbRLmWkM/nV7P5VSEn5Asra63l1rKQE3Lt1mJ+pb3Cn7UlV8WVwmJ+bWVpiV/Mt1ZX+VZhMSes5lZXs/nFtRXhjC3ZXl0U27mV5aXCcjbfFgr8UnZxpbWcW1oSl5eXl5cmbUkkCMLK6qqIllfFPN8S11b4grCcby2uIF5oZZfjC5Nb00SysLqIssvC4hKPUH5lBfG5XHZtZWkxu7Zc4HNtRPz/za7FZv/y7NpHvnYBAAAAAAAAAAAAwEMrPrV1cfPiZKTJgJ6q6IqgdPL5LOEy+R/+cXnN+mmyxPd15WW+04m99/3WBBXHqGmEMeLIUXHg9f/47J3Y7N+YvQOVDAAAAAAAAAAAAAAR2Tq7dXFz4tinBeJvYL3Txz4VgNf/z5zRY8nvJX76jH7+v5/4BNQ0AADPjoOdg/uJeaWW/PrFyA6s7fNLn5Xnak8Ew5vtjR2y0Xe/W47mybHE5gkTPRX1eJV2x2/eMH2+k0MF8K5aplb3BPVIuBWYm3bt8yvwfl1dfUw2gmds19jpIbVh4dLjptFQ9v+z9+ZBclzngWdWV3dXdwOopCXLLRmimCwd1UVWAXkfIBtUo1EA2wC6iT5UgCCo/DLzZXcS1VnFzKwGIA7HbgAEdVheX+vRzB+7nsNDr2ENbEfY8viImZ29RE6Ex7vWSlrvTizG4Zj1ju0dzThigmPP7mzkVZVVlXU0DjUJfj8ykF35vve963svM1/m+14jKuJAXZGP7lBHy0V3/504eiN3BHV75p6Plle2nShoW8jaDFcTB+m2U2xpH7yu1azV8CaqUf39erfMKFrL6rz+OX+5+K35EZeLj7TE+D6Xi9/nGuPO5eJ9Fxm3V3nHV3h3eoHot8L7wdZ3O1R7Qbpf7V/aev1S5vD2ytTPPDVitY88wtxn1Q8bYPa0Wj/uVaOzfsPl+B1eJQKZmJeJloyNd0xvw5NAIvr1LNOWCJY/e7Ge90TaP9vr/oPeG+1oEe/FnU4EunZK7xSKiXidM0ldPxcEyXpDxx1Os9GwsdMaL/op7yM+QnbbInvzYhOP2cfZyPEBXkq6NLQb5vj8sFjJdeAP3629cUb3AFFMqLtiYj0Vkqt0YLv2a69B7fCubKpgk5YHubaEg13PJeaW8vrnM4ebK1NvKKPeTu3FM8n93lE9mIeS3nupvfu2iMZN3+tIdEVqD5W9/oiiTfj6GlAQnGQ8/Z0NRbH6GMdAZ0MPdFXU69ihrLob7dL0BUwFN2coZjzB+/9fJMg/JH8RnnkAAAAAAAAAAAAAYB8pjVfSo31SQNy5N1Ycr6RH+1CAuHPPf/+f/iHi4C9MfXXicvqHoJ0B4Nbi66rvgfaN6ogeaEeaSr0/D7T3OYPa4Rj4/iZQR3IO7M1fJu0v4M16ogEbAPgR+2w+EFNwP5OtqM8L6T4vuh/Ml3F7D/Ue/9K3i68j34y+woxoRuGk+aMwo7jqh2xGM9ReDOlHVpZGeNlJNfzdc+Pz9ahztv5+DPK+5vYTjbAVJ3o51X531s/84iYXyQ5+N4CGvP3reDvWSrjn+4mhCR0fnlL4Euthv5EIzCvsL18kX//RzGFnZeonh/rW73rL5H8S8mhfZMWSeAgfByV9zeI1UesV59PdIfe7S0zHW7DE92A9XxB0m3bcuKlBfShuant/xTqCmQ5/Id7TKaj7+D6oMzfDPhEYOcnOnD9Aeo+yjkeq4tio8LBHBM/qm3a0gcntz71e9YeEn0jtcUhQsbdrzCMdEmJJPNQhoetLu4ShIVliH4aIgYPB/Rpp/7FnpI8NRzX1+xtN+n+m+PBGsEfYvXTTaSBX2wr719r5s6aLKaNubyOX4ogniLEx4tMURRBEhiBSBkGkEEEQKW+WwJsqiD0bpryZiSHPihniyFffmSAIYin7GS+KQf41+R+y/x/578g/J/8v8o/Jf0l+l/xD8vfJt8j/jvw98g75i+R/Tf4s+VXyDXKXfJVsknXSJC+TFfIFkiNLZJ78EEmS02Q6+07232f/PPuvs/eyf5T9Vvb3s9/M/rPs72Z/M/ur2V/O/gNSIc9nf4bUsj+edbNW9mvZ/4osZ29nfyL7BfLXslvk01k1+znyb5OHyTPkN7Kfyb4Ez7sAAAAAAAAAAAD3T0q//SxBpM7c9j4w/3evf4QgUhdufZYgUpVbEkGkVm+JBJH6zK0KQRD3buUJIrV+a40gUhu31gmC+N9vHSQI4uothSCI//PWeYJInbr5KkGkyjcdgkgt3LQIIqXcxASREm9eJIiUcHOdIFL8TU8Dd3OVIFLsTS8Wc/MlgkiVbp4hiNQzNz9NEKlP3BQIIjV700sxc/MjBEHkPuY9yd6cJgjiP930Hmn//MYXCIL4sxsNgkhVb88SBPG9W5cIgvjjG58lCOJf3fAy+H/cOEcQxJdveY/Df3RjkSBSa7e8ZC/efpogiO/eyhAE8b/doAmC+M6NPEEQ//LWpwiC+PaNjxEE8fs3foAgiP/+hpfi7+7+GEEQv77rEATx93cNgiC+tutVya1dL8vnb2e9DWd3TxIEUdvlCYJ4efcZgiDsWxcIIqXd9jQbuwcIgvj8rpfzik0QxKpOEMRylSCIF70n7k+vEAShLBAEcdRT8OynCCL1xMcJgvhBb6H/Bw947/+JJ8DSAQAAAAAAAAAAAOBxxnv+L2W/RpDvkN8j/5S8R36X/APym+Q/JX+L/FXyl8hfIL9G/hT5RfLHyWtkg9wif5S8QL5Evkh+mpRJmpwjKfLD5BPkFElk38l+L/un2XvZ72b/IPvN7D/N/lb2V7O/lP2F7Nf2u4QAAAAAAAAAAADAu5nJUppIE3e/OVn0jnfuTT7rHd98Z/KZ8FgIj3PhMR8ePxUePxkePxEePx4ec+Hx6fBIhcenwuPHwuOT4fGj4fFwePzh8PiR8Pjh8DgbHn8oPH4oPP5gePxgePxAePyB8PhEeCTDYzY8HgqPB8PjgfA4Ex6nw+NUeMyEx8nwOBEex8NjOjyOhcdUcPSe/1PkNwjyG/vd4gAAAAAAAAAAAAAAdHE6dYBIVdJEYWp2empMrdfdqjAE4u5bqOnWj12t21ecBtJws+ba6NChnybGD7xJHPwFcjL76oE3oaYBAAAAAAAAYN/Z3Rk/WDnz1LT2oXR696kzSNPcKkKYFjSNxQLSeEyzSOUxKzIMi3VO4UV9EVl1y9S8LeWa7halNvVN7FKOqdZMa5MXHHPTwp53YS2SK3lypUCu1JL7NL6Gths1fESrb79UazrE3beJu2/vMMe0uo6vHdNkVlZZltYFVhFYjeE5XUeiwHGSqCOapRValhVDQpiRMM0anttyVtM8SVlDIuK0wbnctVIHK+efSpX9gp/3C84Iksaphq4yosQbmiAbikbLSGMVjjd0g20XPNJ23XK3sGtqkQu8VtnH2oUPZHtK++Y7xN23WqVVaCwgDtGCwrKYFhiB43XOMGRWYzgZcRwtcwgJKpJ0rAo0RzOcKGkaw4pYVVlNULWhWSMI4t8Q7wt2p9IHKueOpgginSbO+S0rsbIg6LpmsEjhDZVXDVVVdZllOMwqSFNaLcvzVANbumltUrX6pmlRddvcNC1vK8kdbF9vbSI5Rty5R9x9SxsSb/fqmNe9UvHuJbAYI1ZmZE5TeEHmZInHSFJpzlBlHevG4O7FJ5lYUv/ieyzOz3HL4jhBlThOwByn0UjRJV2ndV4yDJ3RJVlmRYyxITKYQSzNsTrNcoomCoyIEDKQqtH84P7Fe+4ZxsmLBPkd8uvkTfLifhsFAAAAAAAAAAAAALynKKQrqZGm6cZbksNmP9ItyWFzE2Nz6cr0SHNlwfP/NkH+JrlN/hH50/tdbQAAAAAAAAAAAADwnufj6TOpId+7jH8ifS417HOF9HBF/Ngn0+enh39uAv7/AQAAAAAAAAAAAODxx3v/D/v/AQAAAAAAAAAAAMDjDTz/AwAAAAAAAAAAAMDjDzz/AwAAAAAAAAAAAMDjDzz/AwAAAAAAAAAAAMDjj+f/b/LA7xDkC9mvHPr2oU8c3D7wO/udJwAAAAAAAAAAetg9OvnBSoU4ffrQ7Iempz5ETKfTxCzhYMepygzSsCBzqswgXqSxorKGKmuYYxVV1FRupI3JkvctN2zsbPFC8u7nYaC/c/mWubll6jVM3H2buPu2f2qXn/ByvLR06COzUY4/EuRY1Xiel2he0hiNV0RZFVRBYzTGUFleNEQ00rZnyTnWaqipY55PznIUGhybNddGfq7v3CPu3AtO7h4d71fRki4qLC+LHIdYXpUkpCoso0mMJNE8K4vaA2Q7qMs+uQ4DOys6yLJf0Wzay/H5xd4cY03TREnSsSDpPFJ1WUSKJvAqK2KkqbQw0q5x7RxHu9lHfuVLNXPbdLHeyjbPUahmY6Rfp8Kgzky/+Q7x5jtBppkxL9MrCZlWJNazVZZDGPOiiBHD0LLIsbQsKIgx8INmOjgRzzO+Zjqu53c/COqb5+MpL8+Vjd48GxKrG4wocIpA84amII5mRVVgOE4XBEHgHjTPro0sR7PNRke+22cpGzeQaVNOvWlruF8BvPf/k+QEQV4kJ8ivk0fJm+R3YKwFAAAAAAAAAAAAHksK6UpqpHmzyZbksPmqiZbksCmi8ZbksKmZdEty2HzI2Fy6Mj3SLIT//J99gSAx+WHy17JvZP8g+8J+NwcAAAAAAAAAAADwruP0eOV06sG/Jpl8cbyylHoI33hMtDP0QF9djJ8dr5xPPaRvIdJnxisrD6wsODG2PF6pTD+8bweC5/+/ILJ/QS6Rh8lfJK+Sf7jfRgUAAAAAAAAAAAAAD0RpPF1JEXffHu1dfyB9595o7/s7pIe+8w+k33xntPf+HdJD3/0Xx9OV6Uh62Pt/b/0/8QTYFQAAAAAAAAAAAAA8zoD/fwAAAAAAAAAAAAB4/PHe/x8Y/20i+2fZ8+O/feDsgcMzPzP1f0/91tQbU9OZvzP2+n7nDwAAoJfXL6czs5/8ZOrLr7lIrWEd4e26VXVc5Hb8Pb64Wl5YL1PrCyfOlql4CDU3Q1GOaW3WsFu3qKXl9fLp8ir10urSuYXVi9SZ8kVq8cXy4pm5tsw8xRSKMxS1iS1sI9eMRVteWaeWN86eDePEJI7PU7QfS63X3aqpU+vlC+veb8dFtov1KnIjLcHZeqPRcXamSOnYQM2aW0WNhl3fQbXqdl3HvqJ2wifLpxY2zq5TedR068dQrZYP85IceWmZmmuLFoM/r9btK04DaThfzG8jq4lq+UKhnbyzVb9adbdM64rnGren6FEO6K6Eu6NRc3SRiett2NjBbr/y+E6ZuwsTRvFLUatfzRfznnfbfDGUDrTvmBquavXtbWTpThXVavWrWO+fb6aVRr+IrZwjTas3LbdaCwo1XHdUJ/0jhroL1Nr66tLi+vaBzKz0ZGr3g6al42sNu/4y1lynWkMqrlWblvlKE0cnD4Y2vrG8dH6jTC0tnyxfoBJjUCvLrYA5L2F7zg8uFP7GTGaWezK1K/jJ1S1cbde0Lx9FO5CUWIJ8R1KmEwUXqMqL5dUy1T7j9aqj05Ozi0+mCD9x55Wa6eKqZ5D+70ijU2Wjv2aOTo0UgYn+mr75qUxm9sknU7ef8oeL6Hx0nOoYJqKz/hAR9tiEgcHUqdNnV05QeU++eokuKahkXH4mTy0sn6Rq2Np0t+ZMvUDNU5zkjwB+XXeZeaAqlA4agzpRXq+Uy8sU42tixGD8sL3xo4HcrS4NQUt4ErFK7TMudUhE1jxDUZqNvYEzNup0x4xJtEa0ZkMfEismcXw+lkphphjURvUKvu6XJ7L73cnJwPDLkeEbZg1HZow019zB0clMH8PvjRFaox/QafihPQaXhKfnqbyNt+s7WM8fnRhiYkEqTPTX5O2xcd/EvlKJTMw/Hx0nuk3MPzuqiflLfh+5iQW1kBQ7CPGHW8fctLBerTfdfDFfq2+aVrWBLd20NvPFKNC08sW8jbX6DravV238StO0se6fC2o3MLuGXde8z5SHX1ATJFtm6F3WTB3bVbyNzKDwHacbNWS1zu6Hpfuu1qvR0B9ZfBjRy1NP+NJaoHtl1TcQKmrrHsnCvMT5Al4zOk3Vce1eoSJTVArz+R3mmB90LD9CDLrglzCwvmcufb5lejMUVZgp9O2+s2OZ2aefTu1e9zvBtrkZtJbT/ivd0RHa5/2S7mDbiZtBrEt47YAajZo5sB1iEn7rzUQ5u/GBVGZ2fj51U/Jz5mCtaZvu9aqj2U3V69lbde93v/NjHbnuJ7X3m8r54JbSxsipB1baXaIgaD6/rTWqTbtWtbHuDWp1Kx/GDDrXgDqJi3RWivf8Pz1WImb+bOa3Z74086nMC5mxsdLk/zR5PH0AnjqADr6Y/UBmNp9P/ReX/B70ShM3cRVbrm1ip+PHhzr6SkfQqNe7INLAC54cXLKw4w0Y0YNV2/RXy6fKq+XlxfJaJOP4MVeWqZPls+X1MrW4sLa4cNK/c9rGjoM2ky99YaqLC2vrc5Hcwhp14uzKiUL3hZQVWYbnR7+Wti+cuuk0kKttBb/CUSxfzBvIrPl/oG3V3GzWm06+mNeQpeGad37/bt+wFbSR4xmCpeGWjiBqb3D7ktYT1lmJCk1LjKKwAi/xtKLQhWJsX5OqYVqoZn5hlIetPrFaT3GxcK9Nmk6/R1CrbuHoCbQ3kt+Svkgx1qCtFL2HUgvtILPm9RqvJVVk6XUraL14JkzLxZZbfTm6EniX6Z5E40I9twmUd7q6g2qm3idOIZCLdSffsPsk0LLz5+dFQeBEL3L7GXV38gf9AWH3jH9THDRqWAMdvX42HBCCO/QOOa8/dsjOtXt0MWZyRcrrvPGb9XmqVdvKBydnz+X73at3qK8yHT9/6LkfmJxdKfSLGuXFT9GpMp2/P/C6/kRmtlBIfSUd3lPEQzt//UDX/UM8LLhr6BrI4oPjnsaykQYeb6YnsFMLY2+OI5wcap+wnKvYbv8M7jiKec9ww0PVqHuzF82GE53Q0A5GrvcTqXVvciscn5DrmdSA2/u4QOyxdMBdUWi8gUSBen6eYgXRj7SDbRW55nbrsaNfokmCscRbwZ5N2Ch8quqKGoXFemKYs26RII90MPTWkOMGj6beTWT/AbhHrjV423jH7LhT7rnnC8OP3+doH7tLRGRm9tknU7uZoJOEFli1sYYtN/r5REcf7xLyLLVlubF0TpbXFv2efTQ76Gm7pY2N/iKPHhopQtRjneyXP3DQfzz/2avxvhr1UudQUv8c+XbFX2w7wuN5+Ng/8G6lNU9h6lEcbzaqFadTNJxga4kGj7zulrfnWny22TXd2sD7G1/AN1KODSzGqveMI60rYnQ1jF9DfPn2ndHz8xQjcjLfkbN++vwn0EhpS9gfqoKgYj5w8taaOUiYMo5iD5sabsWvanXLtZHmDp8U7o1AzTFFNtBmeN0UW/6LiH69q0smNtCMNuvivS0Ibw79Ka18Me9t5pYv5l1sb3s3G4lTLuEA7Eepuk27dYG5r0Hk+36jWWzbdExmtbwQmxjqCY4NxknBQb7aQTucsiez9CMkmWYx7706sPIFv/93yD89H4YFmeqwpXnPiihka1vmTmcthRfHeEi7aPHTraoOpkLn2uNMMWFQ6Hz+z6TPENkPH5ydTk3+x8nS+O+mz8BzLwDskRtW5uDFypXD6XRq6vBNLnjKYAyelTSOVQWJ4zFvyIhHnCoLWMYc5nV9JFckq9hFpkW5W5hqOfXkBSp6gNpqbiMr9hgZng823s2Ev17NhTOruWNMMRfO9C7puWO5kdy35oq5aBg53ZqB91VFpxfrloX9hwRPq9Ws1bxk3LqdO5bzc5gr5lx8zc0dy+2xPLlirr5tut6uslvIGy+x7eSO0a/dsCZ7K5zmJdFgNVXTeZHnZF6mBVHQkCyLCmIFXh3JP0tiBvmhFe5vwDs5WoUPc0/76Cuc33OF7y5NHLhYuexV+PRTzaC+BQ4xjI5YmaV5nudkpDCSimVaQpohszQ3ks+aS76u1iRc+I6IQoaLbcrBrlvD29hyL4ezYsH+tROtCZbuqu6sgy2kL7gu0rY8FU7umIFqDn7t1sT4wYsVFBjP61eCwhiaqAtYVngZ0bzIqgqLkcjpAkNzhsDQzEgudbabjkupmPLfDKitYoRTdsGrq2Bv3shu/OKMj2Y3w7z+PlS7Gb0ofUymmEPxqr/0ak697uKz/jND7hhfzOnmJna8pPADkivmtrFuovXrDZw75hfgaKOGTK80Ftr2zrUmTUs7PHfEvebmXrv82u0Ppg9erKwEdvDljwR2oPKioKoMFpHO8aIqIyRICqfJsmQYjC5II9mBf5Nn72AKezfklFav1Uy/uzXqjulVXUfzp9+FzT+0BA/c6sYDMkqre7n2KrRUt3DQ6sV3SYbcq/V3Q4YctI3/7T/5Pe9X1Ctu/s2xgxcr5z4ejI7el0NNXGUNQxV13mCwJPOqxssar8gS4g3RUFmGwaP2ipKNaxg5mMKGgTW3pNl1x8F6MAscew0SdIyxd2fHGFiIB+4X+gMyQqvHylCKKh3rLQPAqYMXKy8cTqenpw6/vhIYAKeqrI5kVqA1mhclRZFkTtERzSuioqg6t2cDiG5AfPUdw+G7vNE7Mv7Ara09IHtsbQcZrY7urf/PZL9FZP9z9lvkHfLb5DPkj5Mb8OwHAAAAAAAAAAAAvPt5Jn0xNdrbt0xbdNh7o8m26LBXHhNt0WEvFMbbosPmnNNt0WETcWOF9MXp0aZsvOf/iewFIvv17AXyV8gKObbfrQcAAAAAAAAAAAC8l1ifqKQvpkb6upW4+/aIT+sxpcO+4CTu3BvxuT6mdNinC8Sb74z4WH8/SodOAKx5Sqf3pnTY87+//n/yBSL7Z4e+ffC/PfArM39r+sZUJbM++cJ+WxAAAADwLubGB6bJyxv5yvTuocPNdHrqQ4S3kHu74VZ5VqV1Duu6QiOeZjTFMCSO5RiOFWld1GReoH1K/j+8948c/QyJ1voe8S9lI91L0CxtGAxHa5oqIGwgnhYkRUOCwrG8oSJGElQRCyLNKoqAvQumzgo8ZjVJVRVD4phwgcGrOT9J/0PD0e5Ncq8Fy208LxA3iCny8obgVcpTL3RUisQYvCoxCqvyBi/wuioiwVAEBescj1hFGVopDE2HH0Ee8R1vlYJv2v2PISVWFgRd1wwWKbyh8qqhqqouswyHWQVpCpJkhdY1Buu6rimCrjI0pyNDUnSNV3ld4QVG4WUs8ljHqqzzMmJkmVNUndE57N2PRP5HXs15yx5zx3InF8rnVparq+W19YXVda8KvkncfcuvgrnME5Fd7D7VUQcG0kXVu2eRdJrnMIdkTkA6Qio2NCRizPN7rIORCo8FRmAxT4uGKigsZ3AcJ2iciFiRNmRZpQVeQJLMcQpPM0g1RCSxrIwlmpFlRKuy3DKMwOWH90Vl8Alorpjzc+HbSmtxTclzCMULJee65W5h19RKoXjJF8695q0VuvtNv6o+MNmnCxk8q7IsFmik0byOOEWTMGfQgoRElZcNbWhNJXahYXfOtKZgpHE6FgxWFhRJFFUJ0YIhqRqPVZ1VsSGruszRioq8bqiwoiRyqqzpjE5zEu7bhYbdiQeVcudeUCkTfSqFERgsCZoqaLzI6wancLTAaQLNYIaWVczw3LBKUZTeShm2QMlQBRUJiqjLuqAgiRZ5XVJEJPIqQjytYV7GgqCIvMAZIi0xNC8IgqjQjMLSElIlsW+lDHuXmHst+B46qJTxPpUiqyotaRJWGYnnWdlQaYMXFNagDUMweFEdXikM11spwx4yJNlgZF1FLMuxnMazCi0ICotkjtMkSTZETtJ0QUSaockqIyNR8UyL01meQYKh8nTfShn2eNVZKel+lSLrus5ysiQLMk8rjMwhDrEsyxiyoTEcP0KlsHuvFJZXeQ1LgqGpBssIMqsxGo04hldVBXt2o9CMoSoMrzGMKEqiIGi8oBmy5A89kta3UoY9HnZWylifShExg3TaEBUs0rxKs0hkGUUXFJ3XOUUTpBEqhdl7pXAS1iQkM4yssyrSJESLAq3SOkKaRmNZ5gSVN3RNkESGMbCgK6zKsLQg6pqk6Jhh+1bKsDfhnZWS6nevohk6rdAiw/IKjw1F5RCt6BzPCQLL8qIyQqXQe68UrAucKqiypPGiSDMSy9K8YMisrGkCZnheNnhG8ZrLkGlBxarIKrzhjTG8LCJv4OlXKcOe+eOV4r3/n87WCJLK1shvkW9m/zb5BfJc9i+z/+N+31oCAAAAAAAAAAAA71WK6cupUV8PTMeFh02bT8WFh80vZzqEh0yxTsaFh009TsSFh03JjXcID5mqSseFh03hjD2bvjw96tRG8Pz/UwT5XfIueZu8TPLkgewfZ38q+4/321oAAAAAAAAAAACAx5m59EZqlE8Dp0cSZGh6yhcc4ZuyzEiCNM1O+oIjfGY0MZogw42PKMimRxRkxvLpjelRPlvwvv9Pka8S5Kv73fIAAAAAAAAAAAAA8FiyO5bKVKbT3O6hkTaEIu7cezXn1l1UW69fwZaTO8bQ9Gs0rciyoYg6p0gaq4rYQJIgqKLqfUTA0t4iIlXFLNIlVkKqwCBVUQ1W8pfm6LThf/+fIr9NkN/e7+oAAAAAAAAAAAAAAGBvFMYr09MjzSp47/+JJ6B+AQAAAAAAAAAAAOBxxnv/D8//AAAAAAAAAAAAAPB4A8//AAAAAAAAAAAAAPD4A9//AwAAAAAAAAAAAMDjD7z/BwAAAAAAAAAAAIDHn0OTGjGTuk1M/l3yb5DKoZ1D0oEvHjhzIJu6Tf6T/c7b+4cvffbJzGyplPqZTRepNaxj54pbb1Sdq6arbWGn+ze1uFpeWC9T6wsnzpapntC5GYpCrou3G27V1Kn18oV16qXVpXMLqxepM+WL1Gr5VHm1vLxYXqO2my5yzbpVDeWdOVMvFGcoyqk3bQ1XG3bdMGu4pSYWNQxqxXCRvYndnhjLK+vU8sbZs4OiholtYgvbfnaopeX18unyakxvb2BLtSfV2EIO7kpx8cXy4pm5IGRpmZrLN2zcQDbW88X8K03TrToust32T61uGaa97Z+ooaalbcUkdrBtGtdjJ1CjUTP9vwxk1oJT26q52aw3nXzBL5duok2r7rimVtXqepA973yzoSMX61Xk9pQlzHRM4vg8RRdmilTQvEn1EERJCF8LVK6sJkQ+TtGFIvVyvWlbqFaNaqY3PyfLpxY2zq5TTJhMQgxqji4yhZg23dzEjhu0RmesMCSWsxq2Nt2tLoECNU+JfKFIqU1Lr+Gqple3kLMVVGDLNk29uwpiAbGyt88GhcbXGljza1fT6k3LrV7B10PVQbNjPUF5Z1CsAPHzQQItO6gadn27GrPNQFVieExlcvhDtmCvwWys1Xewfb2qY6TXTAvHTTLIa7JIO6+J4b7NFqi19dWlxXWCII7f/9D4xZc/lJk9ejT102l/aOwZsHpOfLhjcOwJ9kfHpFExKK6pU6fPrpyg8tEAeokuKahkXH4mTy0sn4zM1dQ9E+Vpv5ubOt5u1F1saddbptTuQBvLS+c3yp7cFdPqHhRD0wqUeuEF6kR5vVIuL1OMn54cJIGa7lbdNt3rveNqh4q4XLcqlu7WNWBMjSw1SdZvXU+TjV9pYsft6O/J+eqUjLq3N/S7yE0et4OQbqvHhoE1d9RhuJjXkKXhmnc+GJJt7DRrbvVlp261hmPNxkOG45hEq/B7HcTbOrzR3LWR5Wi22XCrhmmhmvmFQYMvHWrsE6s1AMfCveprOl01G+nLW3UL53uVhpH8SvdFivkGtnTT2vTqN0oxX8w3LbSDzJrXI70KV5Gl161wUInpMy0XW7HanqGo3kTjQrGBxeunFEV5p6s7qGbqfeIUArlY51xcWFvvl8DCGnXi7MqJQuH5eVEQONGLXGgNVc99dHJ2pZAiTEvH15xXaqaLq6jp1v3fVbdpW1Wnub2NbBM7Vbbz91PPHd5DZKbz98duFn84M1sopG5/0B/mOkM7fz3ZMcB1hvm15mDH8Ya8QbdgoYx/C0atLFMny2fL62VqcWFtceGkP1r5irtV+F3W68uWhvuZfSu81VWC7F1v20GfUcJvuA7hVnNRz89TDM3LgiQW7r/Pxsb7uXYtFaOy+jLBeN0RHJWoMBMZyvxHJmfPP9uvrZsO2sRVx0INZ6vuOlWm68RHb376w5nZZ59N3Zb81u4K7vp5uKO9uwL9Bt/rPXdyg4f3STbeMb2S923eLrFW5dZVB9s7A9skLtKK10DXa3Wkj2YdHcId1sGKLMMHF5Xh16Oe61DcMtrV2brXjErbtoCF2cnZjaP9LKDntqPK9pz64YUf2psKpufUR1742OTsWqmfiu4nwyrTfeZp7/v/yUMcQf4USWV/Ncsc+vVD3MN8sgUAAAAAAAAAAHgP89rkRKWipb0JgqrMIA0LMqfKDOJFGisqa6iyhjlWUUVN5fw92BDCtKBpLBaQxmOaRSqPWZFhWKxzCi/qGrLqlqmhWsmbbi2pTX0TuyXHVGumtckLn8bX0Hajho9o9W3i7tuvTbSTVzWe5yWalzRG4xVRVgVV0BiNMVSWFw0RjbQF3ODk+Y7k79x7bbydvKSLCsvLIschllclCakKy2gSI0k0z8qi9giSt9ITlUo5SB5rmiZKko4FSeeRqssiUjSBV1kRI02lBT95RpA0TjV0lREl3tAE2VA0WkYaq3C8oRtsO/kg5Y703nzHGmunp0is15AshzDmRREjhqFlkWNpWVAQY+CHkl6qnZ4hsbrBiAKnCDRvaAriaFZUBYbjdEEQBO5hpOd9/z9JThDkRXKC/Dp5lLxJfme/OxgAAAAAAAAAAAAAPBIK6UpqpOmcyZbksJmXiZbksEmS8ZbksPmMdEty2EzE2Fy6Mj3SHIL3/n+MvEyQ/4i8DNYFAAAAAAAAAAAAAPfBytiBytTsYeKpVDqd9t/WS6wsCLquGSxSeEPlVUNVVV1mGQ6zCtIUb5nwtW1koU2sa3XvPb2L9THizr3g/5dSnsIn96qwgW2nbqFagkbv/f8Y+VPe9//fhDYGAAAAAAAAAAAAgO8P0kRl9nBqz3MFY168J6f3PiXgr/8/+C2CvJ7999krh/7k0KWD34K2BgAAAAAAAADgvcLu+GSmMnt496nR1ujHn6N2mGP+z2OazMoqy9K6wCoCqzE8p+tIFDhOEnVEs7RCy7JiSAgzEqZZw/sInNU0T1LWkIg44u7bu5MTmcpHDu8+Pdpafa2GmjqO5cP/fYxneVrWeI3GvKLwgsLRhs4asqYKokTzCotVQcECbwgsK2q8wnGGyAssKwu0wDCGThN37u2Oj8frY9gH6Yn1wQmqxHEC5jiNRoou6Tqt85Jh6IwuyTIrYowNkcEMYmmO1WmWUzRRYESEkIFUjeb9bKTj2Rj2tXtiNhQaC4hDtKCw3hfwjMDxOmcYMqsxnIw4jpY5hAQVSTpWBZqjGU6UNI1hRayqrCaoxJvv7I6PxbMx7FP6R5eNVDwbw77Tf1TZgPX/AAAAAAAAAAAAwPuG9/n6f+KJ/W4AAAAAAAAAAAAAAAAeJd77f3j+BwAAAAAAAAAAAIDHG+/9fzp1m0jdJv/W+JdTR9M4jfc7T+8/bqc+kZnd2Eh9GbtIrWHvyw2zblUbdn3H1LFdRZpWb1pu1dshs26bromdUWTyi6vlhfUytb5w4myZGiUGNTdDtQRNnVovX1inXlpdOrewepE6U75IrZZPlVfLy4vltUjMmTP1ArWyTJ0sny2vl6nFhbXFhZPl4gxFRSkFapZX1qnljbNnqcUXy4tn5lqBS8vUXN5f0JIv5oNVT/lCwYtvNy3X3MZVR6s3cKKSTglfU7hIJl/MRz4uQm1Rca/g64m6ZiiKolrZmg+zRC0sn6Rq2Np0t+ZiGgrzEudHoHwBp6k6rh0XKDJFpTCfb63VyQ+Rpgt+fk6fXTlB5Z+59Hm6pKCScfmZfMGPuLLak72gpvrnjx+WP4YOMxisNBuWQ2ZQDoP2wlrd1rFeRS61tLxePl1e7WmwmMjxeYouzBSotfXVpcX1n5/5VGZ2cTF153BHH0B6veF6f2jI0k0duW3TTwgqJFp8gqBv6A9qn62e5G7ZGOmtDtOlKWydXukCdaK8XimXlynGr3WWpiO9L2PNjfR5p1zTreFB2hcX1tbnAqmFNerE2ZUThW71HNtSH2TEcZGbrLRLxK8CpLnmDs4X86Ze8w4utrfNePfygqtu026PHIGyrpCltSClldW23cYFemuFlzvz3Wx4bejb0Gp5oSfPseBYWknBvgV6qmvmDraw4yTXcBToV4P3K1/MW3W3Gv7ZtK5Y9atWWA9OvWlruNrwShr2gUBNPKCdrfjp4xQd9L72qefnKYWmJUZRWIGXeFpRmO5kqnp9G5lWvMZ7A2MpJgR65dKRfdW08sV8zbSa17oKY9c1zxRsNymVdmBv0/pm2SvYz0QZNmhqrYbMbd/4mslt0iHg57+BLd20NoM+am4Hf/o9378YGNjSsB4WqzUOVA3T2sR2wzYtd1DvSoxQmBd5P9fJ6oKB8lJ7mPRSDrLRm2yQWkJo3FTCzPRKtXKSoKAnG+FQvWN6Y2P/cToM72yfHlv0y2TajlvVTUer72B74PCfJNruhMhxq3XVwfbOQCU9csfnk/LQ1qltIWtzuMqYWFTqpPz6F9yuLLTTQq6Ltxvesav794TG+kpX0LDyeONOYkXFbmT6CMasKbzcJwo+P99dwtjNQRSzPSJHN0utgJj+Lrng+hkL6xrwvByGbdNXKD6oDZbtHJq6ZYNbq+jYuo1pXSmi67Bdr3d0U188WSqpgmMjYXKkfqOhzChs701Zog7vdq4wnz+a7yxK7Na9Fa+YcCPiycbvguPD63w0dvYbYWJVG92sdmp4eiQVYfSevCRcN/ubQ3doz7WpncOZwbY51C5HtcnR7NEveutmePOTk7OvbqQI09LxNeeVmuli7zGt7v+ujvIkV2VGkZqD7/8BAAAAAAAAAAAA4PEHvv8HAAAAAAAAAAAAgMcfeP4HAAAAAAAAAAAAgMcf7/v/Q8QtIl068P8e+DsHpOmJqZOT/2ri8Pjb6Vtj98Z+lrg1P5+6/RF/Se5200X+MlpsGN66E+wtK7C0vufZjsW4/aSouVsH+cysIKTeeK4zGRs79VrT+9NJOiclq49J+Gs8onVVQ1azt+KH8v6y9mClXKSvesW0klf4dssECxLt+g62qqjRqJnBevSORbVVbym0pZk1PwypyNLrVmuFYlQ71ZedujV03W+ndO9yIjZYSCuyDM9HK7Wx2XBj2lvLs9vn+6zm7JBpp/X8fDwBzcatNbjJS+5iEp0Lwc9wk7NVZdjaF38VTauxqmzyefEMex/KmOTzwkZ+ctZcHKYsYbV5W2NC4DM3FpnMrKKkbj3dsfK9M/Hks3zievdOmYfSC7p9QrQac2N56fxGOVoR3JYKlp36e5C0157GnRW0ZQvUPMVJD2o2K/TkrDbfr3H6jT5Vpl8Id3PxaGb20Y9+D6Fx+o5LYVV74T1rC+nvxzjTiqCbm9gZuMS6S9QzCpF/cLcSN360lDms5KduXXFtc3MT2680cRNXXRtZjunX5mYT2XpwFluubWInarnVpdNeWskxqBPlUyurZWrjpZOe8MopKvCVsLJMdSibqbxYXvbz6zX13MrZk0cCwXmqtWbdr7blciUMCdbjm04DudpWuKYdWRquedeKQiFwBtKpKS6dpK19FTJQdMnZVs3NZr3p5AuFmcLMifLppWVqrXy2vLhOrS4srZXnFk6srK4XqbxZq+FNVAvKRbUrIl94jiovn9w9XszMniulbpB+X9Oxc8WtN6rOVdPVtqqb2MJ2YLdNy3yliTvDscOE1R2OJEvLJ8sXqGFKZiivortVzfWIF6jKi+XVMtUTEF+Aeevos35Pf+MVv6d3pR0tl7ze7zzd0dP7SQWudUxrs4bd2Lr7eF8PB9GWzDwVLLDXmraNLbcj931Gx17J1vL6KKx7tBk6wlA2rmHkYH1gBk6WTy1snF2n6FaX7I3k5cW3zqTA5+cTCtq7Mrm3hJHShAJGi35b/nOSKmhw9NjK5vaogp6ZnG2uDF2fGzogqkZuilTT7++x25W+IkdQ4cGSYIaKlL5IzGVmV1ZSP1nvdDvVL8JQgWKyw6l+4u8ub1OPyptPfy87Sc51dOyiaNAP/m49EzxMnx2hY5QBl9SYRGsIiXvWSY7V6VynrcOPHpWn12VFR0j7sSN+ulddcMEY6tfAu0ovnV4e6gPBHyB6LS7pln1PvhT8Vp6PWthvkoTitv0ShPJtQ9hjlMjNQneMxIHMe/5PkX9FkH+13zMRAAAAAAAAAAAAAAA8fMZT48QUfP8PAAAAAAAAAAAAAO8DvPf/Y9lXCHIl+8p+5wUAAAAAAAAAAAB4jNi9NDZ1WdgVdg+lo4U2EmPwqsQorMobvMDrqogEQxEUrHM8YhUl3LfuSK2+aVqlYCXcqzlvUWPuWC4pMFfM+T+XPAENWXXL1FCt5C3F4oWSc91yt7BraqVw+V3JF869xnCiIeq8bjACR2sMxiIjiqJmsAoWOUmQJJ4zGF5CAmtwOmMwLKMgBusSMiSapnWVuPvN3SOpzOX8lVjhDKSLKm9oiqTTPIc5JHMC0hFSsaEhEeOO/CeXKlfMbWN3q+4F6HjH1HDVW8CSe03XeFZhsMIJPK8zvMoZmiHrGAk8khlG17BIc7woIk5kWIbRvIOoIMFQPQFRMIg79zz/f2PkmwT5Jvmt/TYNAAAAAAAAAAAAAHifU0xfTo06XTL2bPry9KjTD977f+KJ/S4eAAAAAAAAAAAAAACPEtj/DwAAAAAAAAAAAAAef+D5HwAAAAAAAAAAAAAef+D7fwAAAAAAAAAAAAB4/IH3/wAAAAAAAAAAAADw+HNoPEUcIorE9K9N/UbmH09+c+I7498bnyb+Mv0rRDH714f+w8xfzfw3MxdmLniyuyePZ2a1hdTuK6al42s6dq649UbVuWq62lbVxk691nTNulXdxBa2kf9n0zJfaeK+os7zi6vlhfUytbG8dH6jTC0tnyxfoPageYaiVpb7R3DmwlPtiIXXxeczswsLqS9ddZFaG5C3/iHHwlyvL5w4Wx6QOjU3Q1GRK0ZTp9bLF9apl1aXzi2sXqTOlC9Sq+VT5dXy8mJ5rUsLduba8QrFGYrqKQi1tLxePl1epZZX1qnljbNnqcUXy4tnektMHadoX0WsIr19JoLsdMXulllapuby/skdrFdRo1EzsZ4vtk9Zdbd1uuAno5to06o7rqn5+1QkJtMtc/rsygkqf2mh9NnLz+SpheWTVA1bm+5Wt2CBOlFer5TLyxTjS8lByeqqg+2dwDB0cxM7bmKqoc5e6QI1T4l8WEkaNhtu9WWnbg1Ssriwtj7XIbywRp04u3Ki0M4j6+eRFVmGj5RHFen2a764yPF5ii7MFKi19dWlxfW1+cnZzYUU4fc+55Wa6eIqarp1/3e1vxVWmf5hz03/FTHld279uczhijB147Rrm5ub2N5uukENxTWZ295ptYarOq5hFycJRX1jdem0V7yR9MycKJ9aWS1TJ8tny+tlr0snRZs5UT69tEytlc+WF9ep1YWltfLcwomV1fUilY/kY0ZOmQ7VSihfeI4qL5/c1Y/tqZjNho4eRjEDPVExN146ufBoi2kpmcOXlKkba2ExHew4XjKOi2y3Gg4tve2QLNZV1BF19bZpcsRBxQ1jUH4MSjX9/XqSCyzvscBBizycAvdr3UdZ4OtS5nB1fuoG6jZkbBhYc6t4x9SxpeH+fbZLsJ9BD9M3oO92RR3JsIM4VBQnuezinsve1ZEfuOxDO/QjKvtpYXL2ktDvIpA4CjFJZ2WCSBHvZ16/vpA5fKY09ZWJ0Ii6LpKujSzHDO46m8jWu+/PukxmSGyqy1BOUY0t5ODem1fszFReLC/7dwXe3ePcytmTRwLZeSrfsHED2VgPbpGWy5UwyL9LawUW8680TTcYdfyfNdS0tK3YCQOZNf8PtK2am81608kXCtTKak+CHYqSEu1Kyf+p1S3DtLdHT6AdoW8ScZ09xRmWSFeEpER6dO5g2zSu7yGRrghJifTqbN1P92qPK2/pmSkMGkjMWg1volpkUuEzA9U2xnAQuTH26cxhbWHqxpVk2x90q9ZfdHCP2NvtX//Ig8rfVe7B90g3xl64j0oIxv2HWwn9riXfh0qA7/8BAAAAAAAAAAAA4PEHvv8HAAAAAAAAAAAAgMcfeP4HAAAAAAAAAAAAgMcf7/v/yfF7RPZjBz89g6Z+bPKfjd/b7zwBAAA8DG5WJw9UpvOVynT6dSbtra6uygzSsCBzqswgXqSxorKGKmuYYxVV1FSuY9G2hqy6ZWqoVkJNd6ukNvVN7JbspuWa27hk2NjZ4gWkaW4VIUwLmsZiAWk8plmk8pgVGYbFOqfwok7cffvVXMOuG2YNL+m5Y7mRYuWKXhwNO87plj+P3DGmmAt8WGB9wc0d4wWaZj1B7GA3dyy3ZW5u5Yq57bqOa7ljuc2GWxKOiCWnXssVczZGTt0yrc2yYdRtT3wbXcsVc546U8PrJrZzx6xmrVbMGchxc8cMVHNwMYcaDbu+g2ov1Wumdj13LFe3SjZ+pYkd19e6Y+Kr5+o69krWdOvV4IyXf2xvm36VvhSUPncsd+xq3b7iNJCGc8WcVt9uNF1sbzg4d8y1m7iYa9Sam6a1iBpINWumez06jy3fZctCo+Hkjl26/Bpx9+2bxya8Fr5YmU7fwkELqxrP8xLNSxqj8Yooq4IqaIzGGCrLi4aI9tDCWg01dczzfmMJLMaIlRmZ0xRekDlZ4jGSVJozVFnHukHcuZfQxMNijdbEPE3TsSY2vHooBS0XtXOQ11IQJJSYAY0diH4G21495I7l2CPMEVakO1orbEwdG6hZ89rYX4K7+WJ92zttOvWatxAyV8zVm26j6Z6q29vIS8FxbYy2S55LlFwxZ1r9wl4j7ty7WR3v7p6SLiosL4sch1helSSkKiyjSYwk0Twri9qeu+e7ru3eR93zzr2bn0t7LXw+1sJY0zRRknQsSDqPVF0WkaIJvMqKGGkqLSS3MM91N2/N3DZdrPsNxQiSxqmGrjKixBuaIBuKRstIYxWON3SDJd58J6F5h8UarXm5923zvvnOzUtjXvOuxJpXkVjvmsZyCGNeFDFiGFoWOZaWBQUxBh61eYOf0Lr72brVVPfwbEisbjCiwCkCzRuagjiaFVWB4ThdEASBG7V1fZ8Emm02oIX3s4W99/+T2f9MkBvZ/0zeIZ8hf5z8Njx5AAAAAAAAAAAAAI8Zz4xXplMjvRWabIsOe70w0RYdNpk93hYdNiuabosOm2EbK4xXpqdHmq4Jnv+/QWT/LTmX/Qb5X5I/Sr61340CAAAAAAAAAAAAACHSeL6S2vuHmpPyeP7iXuJFn/9N3F+C/Dg/nj+f2uMHTWluPL8ycqTg55g4nq9M7/3ji0PjHyKyxAVi6qOZf575wuQHJz48/uTYcvrtQ//x0C8d/J0Dv59aIy4QbxJnibN7s73dayvBFj3VcHOFV5q4iaNNcQbtBdFPsGtjhZH19e4t0S/qoE0V/DjR/jxD9t66trznogc7QDy8ovfbUeIRF/3G9Rczs5KUev0H/LMdqUWbGiWeXOjYUDFRxN8NJwgZspNiGN1ybRM7c+H2ia0tnEba169TeoSN/VoRhu8+2CXaufVg3daH7A7YFuncHXBpaXL2stRvY6jEKq0yiadPHPhEuCfgtdOdlhyNL+E4Ug0/qOy/j1y3YJ+N1Ybq67+XXHfUUTZXC+NQYZzkTnxqz0Xv3FHuwYs+bFe5R1T0G3o5c/jS/NSt5wYX3bOurbptuteDLa4erODd2qJiLy2vlVfXBxa7tV9W+cLS2vqaN06EdcBQp1ZXzkUxHcqZoajKi+XVMuUcMfV5b1elSKup+13aORLlJwxv/xy89VJ3xUYV3ioWtW0628jVtsJqXjk5OavN9+uvfc2D7RfywsrifSlk+oUcvz1xIjM7P5/6ypO+efST63d+vmNM7yflD+uxRugcOGOjetSI0YDufSHp13DfkTIMj3a/depNW8P9d76Nh/u7dXXcTeWLebdpt38EI2fwK9j2NozfU4aOwb8l1L2RLUsHuWzbW/+qiOouqorwG/UR9gZOkPSvIu09dAdefeIirXhRjke6sHYIj7Rh7t4viV682K3BXNu6ii2r8YWCTafjDV9st2L7ykoQxC+/N568dl8+lzl8UZq6sZJ069l3B89EqUE3nXvYCzQx3si3mwN3AX357N4Km3CTfZ+FHen2+qEWduXMoMG97xMB0y/k5K3xH/EH9zcO996qx+T6PpL0v2Hv3v98L/fsnTU3F0V9sN3LvZUz2IrtXY5UZOl1q7Vh+SN+NujdUbw1cLXPL60F6a2sUiNsMP78fDwBzcbeUrwBY2RMovOpAfb/AwAAAAAAAAAAAIDHH/D/DwAAAAAAAAAAAACPP/D+HwAAAAAAAAAAAAAef+D9PwAAAAAAAAAAAAA8/sD7fwAAAAAAAAAAAAB4/IH3/wAAAAAAAAAAAADw+APP/wAAAAAAAAAAAADw/vj+PzP2CnHwhQN/cuBL05+Y+nDm4NgrqZ8niNTPe/8SxNi5/c4j8BjxpQ9/JjMrSamfXunYVBrvYMutOq6N0baTeHIpcTvpDpHEvaT7bDga307a27o13LF2cWFtceFk2d/P2VdaxY26tpW4KegMRVHRZp1x4QI1T3GiH+pvKd5UHdfukCgqRcaTypfyA8UYfkS5EfWxHfr8vUMtfM2tOt7+r97Os322D+0U6ty4WqFpiVEUVuAlnlYUxtdq1Op1e6jaLqlOvR1pdm5Q7W7Z9ebm1lD9fl30jxWlRyeWo1WR/RXMd9VeifJihXu+usi0sF7V6k1rwNbVHVKt3atb59XrLnaGxg6k4rGx5e+Bu4kaVRujnn1nE8Jj+88mhy/7vYui8u1gP9f5YuwM2sQdv/2c+bZ2nxvVerGC3ZYHxYpJHJ+PpdKxy3dsF/CO3traC/fG9EbmsHl66sZ2uKF0FMXf+L174/qeva8HSndtML03zb27ag+MP2jDaS8CFUaIdm5P2m/6xvT6/dVF0BSPoi76bbr9yOvilrqWOYxPT33x4yPUhbcr91bdNt3r1c0msvWHVRPdeqN6WFpeK6+uD6+HyovlZb/blC8sra2veX05rBSGOrW6cq4VvTsm1ZihqMqL5dUy1TjS7kTzy+VK7GdrtGwccepNW8P+/tuBUPt3r1SkKPoVk4gKHoq0f3bKaNhxqpvYwjbyhpxItut0LE5rPEeuLxz7nZC6t/F2R/reiZnCnu0qKCHVakVq23S2katthUZ2cXVydvt0vw3eB/cRdmDw6Yvn7181MzD41BvHX8rMnj6d+uqrHXdzicIDA8uJd3eJool3ea0LQp9bPO9C4GvridCxwXsoUui6F2Hp4EoUM+VELfFwf+t5X5/jItu7TAa72Qe/guthy+wH5akl1C9X7Z7Rvy6iyovqoreH9Lu2Jki2rsyxrtMvelykFS/elwYVfXFhbX2uQ3hhjTpxduVEoV0XbFAXIsvwfIdy3dzEjjtIfaekd2MsBipsrNVtfWC54iKtcsWeNTruNyKzit+OtE2l2LYDX8Ib15dOLwdaksX8garX1Hv6St/40T3PoUMOMXnoA0T2Xx/6AFnOFg/9c/If7PcjIgAAAAAAAAAAwPeH6tiBykZqOpUaI9Jp77mqqkgspgWN5RDGvChixDC0LHIsLQsKYgzMIoMWOM4ocaoslHhZEkoKrSglQad1JDOiqhtaemwsfZ548x3i7lvZrxIXHknGJ7ozrmo8z0s0L2mMxiuirAqqoDEaY6gsLxoiEkWDoxVBKHGCIZZ4nWdKqoKZEsYyx6uKqmEGp8fGxv6CuHOPuPtWdbw7AUkXFZaXRY5DLK9KElIVltEkRpJonpVFTUI6gyVRLomiKpZ4QeVLKqeKJUFRWE01VFFgUSwBgiAuPoqaIS6n/JxPT7dybkisbjCiwCkCzRuagjiaFVWB4ThdEASBEwUaM5wsljCH/aqRSwot0SWZZg1eYDiV5qWx1HrQopfT3eqxpmmiJOlYkHQeqbosIkUTeJUVMdJUWjB0leOwIZUkmWZKPC0YJcQhXBJpVRIErAkqLbbUf3byQGVjenpqaipSLzNIw4LMqTKDeJHGisoaqqxhjlVUUVM5zDGKrgpCSZEQXeJ5LJYUnZFKiFdFXRBZWsQ6cfdt4u7b3vf/k+QEQV4kJ8ivk0fJm+R3HkkTAAAAAAAAAAAAAMB+U0hXUiM9V0+2JIdNrUy0JIfNkYy3JIdNGqRbksNmpMbm0pXpkeY5/Of/bJ7I/g/ZPKlld8gfJH99v5sDAAAAAAAAAAAA2DeWxysbqYf26nmyre5hfKIw0Vb3MD5IGG+rexiv8dNtdQ/jQ5Kxc+OVjemH9g3DBEEQKfKvvX+xfwAAAAAAAAAAAAAA4PEidSnjvf+fyv5DgrxDrpPfJufIH8/+p+z/nP2H+501AAAAAAAAAAAA4P3IM+OV6dRI77yn2qLDXt5nnh2vpEb7CmFssi079Nv7ibbssM8Rxsbb2R2Wh3RbdKjawnhlenqk3B4a/zQxlfo54sAPz/yLgxcyz0/+5sRfjP2b1M+lfi614P233y3/fuTGWjVz+Fxh6tZzXf6GfWf3ThVpvuNt09rs8jwdhPdxKtwv8szCqfXyaoJv6SBC4OjW81sZOFxOdLzvOxNe73J6Pt/5s8R4vi09Ov2Wz3f+LK2cPXkkUO7/bjkfjrke9kRiDmB9b/cxj95BeOzEczOeR+u1z49aq6blYNu9z1oNIoe12uud+SHX6rOj1eqzngfjIbXa6dC5t1b98O5azVxPfX2/+wswIrunPpc5fKYwdaPbkXloxf28uI/SA0b30x7vAckOtENJypdM8si+m76UmWUKqV0l8Gnd1Rk3u3K+EmZ9aflk+UJP193EM1Rv/jr898ac/Rap1p4Uz312cnalMMyvdpgM0/n73AGc/gwYLgA8TJYuTM5elkbqktFVtu09v+P0maXK3lUxiad/hCCIv3yftfMbn7yYmS0UUj850bvNU+f+Ts7Z/hs7Dfb1P3iTJj90yAZBe9nS6H59woe3hnv1zr9j6tgezT1/j2jcz34QqNUtC2v+ljxRPrqid0rEdgNq+8pPEAy2uvLTCky+r0d/L6C6g2qmPteWDHZBiN2XDtzJKS43T8W3CIil3dogoLWXRzxa56YBoveRvL9jk1dTL4el2sG2f/fRk5WT5VMLG2e9DVNaddcbh5pjimxh4G4AHZtadTj777tFUR93/x3DTP/ovfubtfz/B+//bxPk3ydPkv8L+YOkm/2T7G9kb+/3+AEAAAAAAAAAAAA8jhyZqKRHfMFP3H1rKiY+7CU/cfetzNGJSnrEF/3E3bfGJmPyw16fe/ITMflhb+Y9+fFY9kfITzomPor6kic+2st/4s13Dh14k0hnzhDTVw/9i8yZ/bYDAAAAAHjPcauQ/thGpTK98RFio7J76DRBEKXD09M3NgkinSbSBMELtE/J/4f3/pGjnyHMSD6WkKa5VYS8a7vGYgFpPKZZpPKYFRmGxTqn8KLeLzUlhuPaprU5Sr5MF28f1erb28jSy9ew1vReexy1vTcZjrvQ8N4OoRp6QDRk1S1TQ7WSt016SW3qm9gtGTZ2tnghTLyKwsQa2NJNa/PVnLe3ce5Yrjs8V8w5ze1tZF/PHcut4h0TX6Wc65a7hV1To0LpXDFnY+TUrdwxq1mrFSMtizXkOLljORc7bq6Yu1q3r5jW5knTxppb9zQG0mgHmTXv/eZJrJn+XuO5Y5dydUvDuWJOx1rNtLy/NGRpuJa7/Fqw59JH8zO3SqleW0mFtpL2bIUf0VaG3RL6tiKwGCNWZmROU3hB5mSJx0hSac5QZR3rRr/UEmyFfw/YCt9tC/haw7SxPvbeMpZgT7S7b3304xRBjM3t9/gGvPu5dWQsPq4s3c+4wo30ZPr9H1e4fRxXtBpq6vgxHFi89/9p8jZBfpe8S8JbfwAAAAAAAAAAAAB4hMylN1KjzMKnfcERpkrG8umN6VHmag8RBDFBXCGIK+RvZL9x6PcO/u4jK+TXln80MytJqV99zl8S1FpQYloutpG/jsJJPPlSxwKhRBF/nVCjqdZMrbXAJbb8IlywES1lieRiq1e61xj1LraIL87xFuvsdUGP5s2qjbSep1uytZwnYRVPV+ywhP3W6IRzZVVTr7rXGzhRRbeMt6QlbzW3VWzni/lgti4fLHCJiQYCrUL1qIrC2+uKegOjxTml7vVXgxZltTOLr7nxlU3dQb1LmrokCl2rwASG9dPYxu5WfWB1BxL94kfJ6OYmdtxBejolvXYTeV+Fu2VjpHct3Wqf7C1aK6xfptym3b0ULDqVoC0I6afLm5ft0hWd6tUVhvTTFc2bdumLn+7VGQvtp9ebnk2sej/As3F/jVW+e/42X8z7nV3bQtYmjp9uYHvbDAaN2Nmm449MjaabL+a3tUYV10zNdP2OnPeWmgWjjYvc5N4XhLTzE77lzBfzNnYadcvB1YaNG8jGevzcVdt0XWwFp+q1HT80nPr1/gzmfv0/wynrSNSfRK82rStW/Woshzbe8aeS+y91DMOPh2OTWqtr3ux0vwixcGqOLjJBMrrpNGro+kjLBuOyBb9x40sAOzS1FgEmLfgLyxfWXLxXRkXrDEoaODokYh21FYKvNbDmYr3aU5FdiSQIxsfIvlJRvYdjxpB1qTGZ1tUk8NMwKF5M4vh8R0rBGOL1AAvV4hrCoSQe0i5O/HSPQkrHSPfsNTFD0drLnktDkGAs7vH5juJ6zR4LfX6+9zpCeXcSlrdut5XBWAcNB7Q+IrHS9RXxLqAjd8tCwXM3EQhX1etdhtk63WkkrdPzVN5box7YjZ73mym2grb74j4fXdj9akq+XEct0CURv6YG61NXVvukEd4zDEhjkP4wfS+NnuL4FTzfGiRDHcndtyOsb6/rLIqv/+muBIK0/YL2ptRZWwNTixUsSJNKtpdRx+5AUaF/RQWa93hFCUbahA6dUFN7NPXkUiSmFzeC1trl3b+pZ2ZPS6mbB3yfDIkPBtWwuImBGx1+YQbGD1zEJIrMtR8Iir1378X4aFRsP3q0PTDdf9PsXtUysxtS6kbglCK5AEHvq4bZSJRZD+thY3np/Mbg6ujUdv+10vGEUuy+E29VTr+xZPdVNTNbkVI3mgNKbjW3sW1qA4u+NnrRu9Q9grIHI+KA0oej9RIa5JokOfdM4unz3vt/4olH9swPAAAAAAAAAAAAAMC7AP/7/+zfI8ifIGezf2+/cwMAAAAAAAAAAAC8f3EnK9MbG6mH5vNmpO/s44k+DCcHI32z7/iJTn8/E2W85/8U+SsE+Svkxf1uaQAAAAAAAAAAAAAACGJtsjKdHnEmhLj79kgTHYH/vymC/EfkFHkJahkAAAAAAAAAAAB4vFmdqKQ3UiPtvjPqo3VM5dBt/u7cG+kLgfOeyunRtgIcSaXv/+9g6isEef7QUwfWp/6fqa9mXp48PaGM/2nqK+N/N/29/W6X9xG31EZmluNSX7zi+0dsOmgTVxv1Wq1qILPWtLGTcOpzHb4REwQCz4h7dFnoebY4WT5bXi9Tiwtriwsny77XsnrT1nCvR6tuF2ZdYi2HU3XVwfbOQI9TcZFWvGBvjKpW1/t5LGyH+35UkKbVm5ZbDarD94TnVUfoXSkKNUxrE9sN27QC91+hH5643xyfJPmY+6WYJNVySNcbpTAv8nFJz8tNkmavbKfPrpyg8s9c+jwqGXRJufyM55ctJHIXFPj4ifm4jDsd6W6qmM+cI3ZmdoFL7QaOUxIMpmpjDVtuUkiHu5z+UQPPKAnhHVmMN/XJ8tpiT6b9s4XyK5OzF7l+vk6SMsEknLy8Up+c1eYHq4kS9gK26rbpXo909YZcunHAyszOz6duFmK9tVeu3/nPJvTbXqnEzhv3a7qn/mvha+7Q3tspFLnPo5NdcLbM6ga1nTlcPzd1k3Rtc9M35l5vM1XXRpZjBv5ozO3tpl9zVR3XsIuHRYjqa3XptJfrPeufOVE+tbJajqqlj+ueuIqZE+XTS8vUWvlseXGdWl1YWivPLZxYWV0vUvkoLhWLS7XjUqZDtTKQLzxHlZdP3qBq911FgSO+R1dFgf6oijZeOrmwL1VUvTI565zbi1+jjvIwwyQu3tJezsyeO5f6otLXBXFcflj4haGOiePSST6K+1yIk1xKtZ0WJ3buPTvsfC/4IH1EPjq1uq0PcZjZFmndhnRca6PW8Jw1dl9jb764lTm8LU29fnVAT3eqWtO2seXGPINF1ZooP0LvHqSzu3OfCg2gnw+zmcqL5WVquVw5EjpZ7G17/5rg1Vz5wtLa+ppnLeFIwFCnVlfOtS5JVKPl0qxxxNTnV86ePNK+qvlG5qlqHOl1lhbJdp2OxYl8NNp4u+7Z3Exhz6NSzNe26Xj10hqRbh01Mocr0tQblwY2ZfuGYbOJbP3+269LUdRoS8tr5dX1YW11Hy3hte+oLRHK7qEloqDoFtm3praj9bDTtv1ftnMf0FmGyA875bQEQg+KUUliur1knVjRkkoa3UwX7sNk2rdo26azjVxtK7SY3SL2nVLubg7yyRhkNDHwMyM4pQzjD3JB2K6LDg+Uwa12+2Li+//Pfo8g3yZ/jrxMfioLT/wAAAAAAAAAAADAYwA/MbkxfZhIj/IGP5z3JO6+LYxPbqS8WKO8pA8nN4m7bwnpkaMxsWj8WJjHEVKL8njnHp8aOVarZHfued//T5AlgvwOeYP8OlkhS/vdQgAAAAAAAAAAAACwzxTGN6ZTo8wcTDwzvpFKjTRbMD6qKDOWDtIfRevc+Mb09Kjf/4+T6wT5v5K/TP4Yub7fVQwAAAAAAAAAAAAA7xUK4+nKaF76xgrpSFRiZUHQdc1gkcIbKq8aqqrqMstw+P9n732AG8nu+06QnCFI7M5Sji3DMq34jVcjELOYEcH/1CxmBYI9M9ghgR0A3NnRatVudD+SvQN0Y7obnKH+BiBHK0WOIvucs3WX+OzUXZzYZ0tOnLPP+WOfU/bFysWXWI6dqstduS6uu6r7V674Lrmyz8lV//8PgNzZHYn6frZqluj3e7/33u/96fe6X7/fwjrHr49nx23RYb4BxrNjtmh+eZVfbO4KzfzK6tIuv7y2u87Pr3H8wvri0q6wuzCuv/8/N3NPf///czNH8AEAAAAAAAAAAACc7CHAqM8AzmVHfQQwkR35CcDcxN3pkR4A6O//E+9B3QIAAAAAAAAAAGcZ/f0/1v8AAAAAAAAAAMDZRn//P5MoJJ6jz/7dZ159Zix1Y3p76h9MXUwunv/jc78/8YfjPzO2nyikfiwycj/TG0vO3ilMHd223GM86NIuZVXd4YDEU487i7YsyZosiXycRMA9xnBFYYcmhusqO4ruGSFOievbxBflRd3XiO/KILcQhnLiJOc6hOA5SZI1otA9haqq7f3pei+RnKWFqSM6zFSqKO21qKb7brD9I71do0WojPAHYwuNZjpXXPfjUW0Q3XrOxVNZzlUZ5T9r9bPJ2Z3C1NHeMAOKkkoVjZUl/m0bzqMq7ItlsI0sZyZ+HyZxUWxPJrYBCvnsqSzItXRvh4eEPhJVzW57vc5njF7af2OY5STZ8pb2du3mKAq7XYu12tvoa01KzOQEu7G879PJ2e3M1FHZV2QqBVIP9DAqaYpIg656hsUNd6WgrFtuKwW3G4VEPb0pGDbcRFYM11RRHanwqeTsnczU8YVI24gClbTIbjSKdaJix/Ucny3iPBf5RW2XP5ZDH1HQ3QYFzWQEhWyXHd16diFiutP9TyZnb2em+vLgtqW73dFP9D1F07KjjmS52Fak+1Y6eYux07ZL+75PJNPrmbEea/gzMpOxzg92kvPlivocGEVHMD0X+aJ5PRYFi5O1x0fTFZntkK534TCZvpkZ66178hYyZlcSH3T9WRSsLO5Uynd2/DmNiR6V4VAuewePDJ+g/c8OvGvHXed97gRjbxV6H/HcfC0Pdl6voJYbP8/NxHH/6TaQAe4/HSHb/Wd+iPvP3trDZLpaHOu1PV5l+ZbcFdhupyVzAstJ/L6s+J3LRgk0I3zMDlDkdTUbJTbIKa7pX7Z+MJneKw52DBuZgXx8GNf/WDeZLhbHjkse57BRkvEhPxjhIDZK7pvIv7NeJeJg/85ekWjHiqM4MT66oiVnudWpx9sDvfK1+Q7bVVqmK70BPlRHc80XpS18578vSkJOENVOiztk31TNyfQQB4t6nEJG109bIi9qhl8907uiXrm6FpY+0vSIc7q8V30u84GrbVmgmWwh01Vaus+9ao2UqsUtpl5i5oy42mGHRkbUI2RzGanbamWyFwvmH4NvlNulV8hObcvnC8+ahFH9EhG6it7kzaHauoccfY9q1tfzJ6gvcwLxpOrL1HYyf4rfDlWD9/8AAAAAAAAAAMC3x/v/sZnfScz8ztPOCQAAAAAAAAAAAEYnN3bu7vTESMcEJn72D/T3/2Mzv5eY+T3YGAAAAAAAAAAA+NYie+7u9PRIjwCw/gcAAAAAAAAAAM7++t/c//8niZk/edp5BgAAAAAAAAAAwJPn3NhEYmxKf/+fnPmXiZn/b+bfzvzRzP8284cz/9PMv4S9AQAAAAAAAACAbwXOT4yNJZP6v5OT+r/nz+v/njun/zsxof87Pj4xMT2tr//Pz3wwMVOb+eDM7838zMxnnnbOAQAAAAAAAACAp8UL5+6Ojen+adm1PMfT5bXF5lqeW1qZp+vNhd3mGk8XF9abK3xzMZl0ZVeFlfWFpbWVxUVuYam5uso11xfy/Gp+dXV+aWFthZ+cdGV3VxeE3fzK8uL68vzSLr/OLc4vrDSX84uLwvLy8vLiuXOjy05MGPv/R5K9kDyfSCY+nHgu/+z2Mz9x/rcnfjTx5cSH9f+SN5I3Btmk3ntmkOdUx7FiS94TJcd9rUhVNh8fJn4u0UsZrlO/+IzhOjVeND5k3+c6NV7OcOHIaRptdzTHdarXj67He6ruQlv3qMha8oYb1dwpXK9acXi9cvaoRBVDbZy/1AjJ65bXVLM4oWTNeC0q7Wn7c7ZMNuDJdzm/YOgwPEFGKjBDyhUyl9FdSR7QTC6jUk1r6Y6hzbjGrzaVNFOBFc+9armg1p1eeq/qKnlO4qmuKpeRZI3dlbuS/rcq7klU99WZyWWcahNElZclifKGd3fb0aysCMMczToijqNZ02nroGgeiesFbzpGfFPGtE3Btoth0HCxs3q5bVHbclGyVgayrnvb45XedHL2jdWpt/iB/lL1H5LGGmmYbk5P7y01rCvs29YIzBmSulE0qrRFiWuZkQY7U00RYrg59TQrhaodWVIp21Foh9Mdjufcaw8VUdOolMkaFjNcvccka5vb9K6q92hCqlubZkqFsEZDwFbqz47cOjByIVC+JUrGn56GSh91TLfoURrMetTTjclnipCBzltt0/m8t9oqrH7Ky5KmcILIayqxjWbIS5rlzbW/2EsmZ9nVqaPXR2k5plPcJ9R0vMpO7Gd3UO1aHWSg9UyH8E4qUT5w97kD6lrUZ7ZE4txX3r3JBAAAjEDvhd65ZPql1bFe25hVRw/AQjfarf2eNXyXK5vMazGDt9DVb01xA/ScQDlBvxeynJbrdJstkddnkylC7t5iaox5XyrYw2/m6Ad7E8lZdXXqcxcH3n46+iisqvp0+oBrda0JB2tOvk5/IxqoNjyd0X2757x+10f2B+9JiOvoMbiWObVjXivXG3V9EmLdpvLkRq26bfmJ5/j9uaEe4xX6oEtVc67r2Nn1FW8UTJcz/shkfXfIwTMMJ9PEiKtGO4f33jmtvPkcxh/d7o0bdfz44Wnq2JwlPPE6NtWeeNqB6jTP//tGYuYbMz+NIRkAAAAAAAAAAPiWIXduYmfs+zKppeV5gyvGP0v6P2v2T4v8hHn+n5KYUZ52tgEAAAAAAAAAgLNE75mx6Tfujr3xvsTEhL35fJcTVpr69vxVYX5pkS5ya4vLnMBxTbrLcyuUGkf5ry6sLS8LAr+7wK0v7TaXmrvNZlNYW8gv0oV1jl8f5zlJlkSea13RN7kvLV9RDyVtn2oif8XaoXPF2BBublxOfPUfJ776W+b7/99NzPzu07YLAAAAAAAAAAAATsILE29Mj/pk4cIz70k8M/GpRGpj+j3JL01OnT8/U37u8YVPPNuc+NQzPz7+fz5zcexfwPoAPHmOzve+L5m+eXPs8bRx1sWDLu1Stk1VldujrMor3aZzXMXh4EDfiRcDRY1P5FVR2mtRzXPuhPfYC+skB1umkLcOXXjQ1T+AH3jogiviHLpgXVTZA47vdttD4nrEyNx8Lm8e+DDooIxN5kZxZ0v/1M5U5JH1H3qxPj+/ml9fX1heWl2aX1/Puwcu9D7be09yli1O9cXgN23+Q0MOWbGtnwTSbFFWoC3q+VoxdLpI3OdswzTaH7FtMluM/qGi5yO2UBojnShgxCJuAxBVwnX0B8JXZKl1aH/WN96bSc7uFKeOD4eZIOq8iVOXfoQDJzznZQw2hvlZX7VhNHHPGRDegzqcMxsCh3IY4uGzS5wokWd2DP7gUmy16B7XIoGK8KjSFE5SRb2p2uc3fKb3nNEQj/eG1YLbzJ9UVQQ1husj4jSaEWrEqYmLblVUa25NhC+H07lY0LWEr7+QP0UNeLIfroGrvQvJWb44dVQaOhQIVNJ8PfgJDAYhneFacE8syrmHD+Xso35y3pNvntTgYWdLHzucnFkW673cezaZfr041j/v/0Y9WDazklkrz/H5um8Za6dSvrMT+np9sNbAt+wh3XOuxbL+b9itJphIJD7/zTDX6d3oZZLpe5mx/vsMq5r3dCppin6Clv/eznOSIOrfuKs+KbvRmQYcTYFpP5+sfmiV8yG6Fe9iIfO6IWRfIAptywdUINyu/jG5O8a9kel/Vy+dTO+tjh2lB5xh0BJVTZT2WOtFJasfXibKUqRwZ4RzDWL0DTrrwBIx+5D1Eb7eiTaZesk9/IAU66XAAQjmAUL2IQi5EU826id7351M09Wx/mdPYJe9ltzkWpGy8inMYqobZJV3wxS9j/Tem0zfXR3rjWKKQU1DOoENnmyT6C32viuZ3lkd6+2NUIYB1dg+QRGeQPUZ7/9/PzHz+097xAMAAAAAAAAAAMAJmZu4Oz3SRwMXnv3FRHLizcQz/z71k6lXU8+eS038ysSb5n+wOgBPiu3e0mSauxbnL+OhrNxnFdqinEpZTW43VU2WqMouxAR8eru3eBp9+ZiAT33xM72FZPratbEf+07j9U6MXMzlT/p2IMQIGS9mjbAobxs+zxWWlOu4YsV4F7tm7ykwVYsCbXdkjUr8IXufHgY8WVgvkHx6Y2JmC4srPs3Wc1NWEPeoqg3ysREdI1tYWTJyHKNQ13Vzq7pBMpdf//j8lXXuyu4blzNGFviWqJ+nr9Dd6NSjihWK46Qf1jYoaVlWBFHiNFmxH48P8TASHSOm2pzD/fVzdyO1+iWMlwl6S7jKy+2OvjkikzN/73Jiy/7b9NFguQZxFIxegTFRHAvGqRxgx11L/kA0zluO2fLil7pu2si8uE85gd3n1P1BGQ+IOhkOqhiQUd25Cme8LeblrqSp5jnYUWkaR1AfcC1RmIuMZHrqsHJWKtYb0WKkWCcbW9WNbPbFwtL8utnpXEnz5bU6Qq3FxXGsEKt0gDmszjp4j5Mjcr1gj0a6Lwm95Xc7HaqwTd2dzUAV0fLXCx7llma129JGqhSPaLgqvHo8FbCyvLy44m6DutnLT6ZfXx54R+l0lT3qef2+EHX1Ezd78yfWlI+6etj/aO9DyfTy8tjxXfeuFBCKuvYofD8KSJx6I5zvBjZwVB58Ezv5zSvupsUrdIhfI1dCb7TuxreF3tVk+uLFsf6HXOvyLZm/7/51ELakcf3k9iMFYlpQ35bBcy1WE9s0Lsc+GWMzoZPrRGJiC/NSAN4++vv/iZlPJGY+MfO78AAAAAAAAAAAAAC8I8f0J7769ZGO6TeFf/YPlpaGCi+Ov3BuYmd6NOG8uf6fSsz8/MzUzOuoZQAAAAAAAAAAZ5va+bsTO2P6DkZ2Lc/xdHltsbmW55ZW5ul6c2G3ucbTxYX15grfXBx1ze5R2eSXlpZW55dW+Ty/tL6y1lxuLvN5Pr/bXFha2V3hRl3Z39FVThsqV4WV9YWltZXFRW5hqbm6yjXXF/L8an51dX5pYW2FP8H6f2zmG4mZb+DtPwAAAAAAAAAAcFY3Fpjr/59LzPwc3v4DAAAAAAAAAABndZPCBV3vexKJmX/7tAsHAAAAAAAAAACAdwp9/T828fnExOfHSrAyAE+HH9eOX0vO1i9Nfe2Tlt9p6wz9A5E+ZDneOELb66xb99DtEQl6mB4htu1ZulypM7WG7kLUq8/1ps68Vq436sZxv5av6HyKkBu16jaxTnxX9UOlPT7dHceqL1fLhmNS3eVyQMi6qicbunhVFAohdVdd180pQraYGw1TvX3qvOP/NFhc0UzaDbc1pwjxe051Qq66R9lHZMTIgI5+mHNEZPtSdBlM6YPFdcdzblQKBd0PulkV1HuyfspONxzJ44DXcmady4iC7qfbiOTEDNSpjl2vZq06mVS6kn78smNRhR7IvOE4PVCZboClMFgwV8BTjcPq2DXyQEWuO/dCuCWFXcaPpHjE+huiyLafyssdWohoKT4Bnz67ZnQidVtuy80T43Vny54I1Vp0HL6rKLozCLs+9VPHy3Xj1O3Txb4YVShPuKPVbILmv97izQ0zSiHToYoqS1wrY0QMNNxg03UGAyuS04SbouGSOtBurauOsmCztcJHHA7CbcGOf9IWNUwPq+0runuHuD4UEBqq12pM1rBhiWfN6jIaxAj11OYkbo8Kmbgx5lukqqJGUYFqHL+vd7JslG0GV2ohI9ADUfq2sktERx9mJL7FdQWn7QVzYQ/nnlyo4p5EBVaUMjn7b7mrZU5UM7ws0EcjpVnwpDdE3kmCtjmxZQywlmuDIRGN3HiH11FH18iBMa5dxUyPWnSP4w8DkyNvkwoKnKBFmTkMKTjpTCBWUfB+FjT3KBELLfkhVeY0RWzPDatTp42daiB4Uk08m8qmNpib5Ypd0bViuc7MFTeqtUYuc7dau83WmFfLzF2mxhZ3GreqtXLjHrtdrm8XG6Vbmew1wlQ29f3/k8/9h8TM5ef+w8zPzvzezF+Y2cEaEAAAAAAAAADAGePyxL2xB13apWx+d2lhlV9caC6vLi7Rpd01bolbbK4t0zW6SJcEIemKzi+truwu8E1eWFpZWlxbWptfXlnmubW1lXVuYXmpOemK7vIrwjJdW19a4+aXVhaa6wuUW1kUlvPzi7vL+fn8OVe0ubSy3Gzm6QonLC6tNNc4bnl1fZFfW1vd3c0Ly6sTrujC7m5zRVjazdPVtaUmv7TGL62vrXJLuyu7zYV8no5nJ+5Nm6KLzeaCwK0tLM/z80srq+vrq2uL6wI3v7S+sr7eFBb19f+5mXZi5l/N/PLMj8y0n3aFAAAAAAAAAAAA3/J8YGJ7jOckWRJ5rrW0RDrU2FtDWvKeKBFZEfdEaeLSxJ1pR4g0u8Ie1Yh6KGn7VBN5Ym1ZeH7itqvK2EXgiIrNlijtLS2fGy6zNJ6yvv8HAAAAAAAAAADAGf/+f+ZPEzN/+rRzAgAAAAAAAAAAgHeAibGJxJS+/h9PLCQmEomF0aI9fvl4PTn7RmbqL85aJ5WZXxpoCiepvCJ2NJbnJJ62WsaxQaxKNa1F21TSTDkqaYpIg+eVjaojVbzRYGpk55VNPXb1BjGPS6hWiE+7eXpZdWvTPr3D2mphncLC3LWvW8lQIWOepZAitm6fPlJnGsSTOz12Vy1kuCYnCbJEhUzOOJPBIyJKmn5a0puqLBX0f1i5+SblNfuAjswBVfQjIjK5vBmVEP1gFVnJ5Axp+khTOF6bi9aYy3zgqimddWLvc0JR0w9k0e2kmmrmSsU6ox/gUSGlanGLqZeYOUM9pyjcIdui0p62754ZMmrKnmSy2dx89vq8o6Khp5XRlC7NEGarzpDMLtdS9R+VTePgCvM0EeuEM1EwKiTCsnaFXUsRsslsMQ3GPMakTVWV26OsJw+OUs+JJEYVOz+NRFS5q/DGaSNmytdSTGXzK586XkvO1jNTf2c6rjXvihLXEj9htkTj5LwTNeRwdPvgPbcRh8WpkAsZJRddIzGNXz8FRa/ZOb20UQkU9O4RFeCeFOePaVVNIJp5NS6ON5/lutEjo0P1pqGfoRKpvZCRZImanTcu1wWzDUaIBPLgHA0TX8TwcDEkxcGltg+k8ZZxyLhkX48rU2RGRzDNEyqvb6CIL7w+WNjjXLaQP010a79bWchkC4HjClXPIUGB8yhVe0S4GhoLsqfJhX2Oz03nGMFwdjoRhw2GsuU/EbNjHx5UIR09p74SjVoC7bBDR8x+SZYkyusZ0+1pJW4cNSR1W61MLqPRR5oVcOJ6Mu5Gheh7SXyP9MQ9TbJmhk+V6unLKrdFTaNCaZ/ThaminjIHEXqc7Phv1yPWgfe+nMu8/oY3X9EKh1RMWKF7spvV7I3uOXc5azZ1UznH7w/IajZrtLnV3Fp2yKj/hEY3R3TI+JZ/KuPbE+43IwwHgZmiWR3mnC1nTddO1S+Cet1CzY0y+zxZ2cNz0CfTNguL706jdJcO34w3XTTKb7pGOeC0P5IxFgCedQQxo3/IbG1mgGjMSETpgGuJgnX+n+3/DwAAAAAAAAAAAGcXfP8PAAAAAAAAAACcfbD+BwAAAAAAAAAAzj7Y/w8AAAAAAAAAAJx98P4fAAAAAAAAAAA4+2D9DwAAAAAAAAAAnH2w/gcAAAAAAAAAAM4+WP8DAAAAAAAAAABnH5z/BwAAAAAAAAAAnH3w/h8AAAAAAAAAADj7YP0PAAAAAAAAAACcfS48t5e4MPFLiZmvzSQv9KffnC5Mvyf528nE+dRzv/3cX5n4NxO/9LRzCAAIsNbbnEzfvjSeECWBPlIftESNslxXk43f7ENZuc+2abtJFZXNe38lvtD/rl4pmb50afxI1Lhmi3pDfZKfL9WYYoMhjeLGFkO8QWQuRcwLokAazGsNUqk2SGVna4vUmBtMjamUmLohoM6JQpZUK2ST2WIaDCkV66XiJpNLEaJSVRVlaaAKS8bQosd5UxYlKrCcRsqVBnOTqbmxSreY0u05V+B6gcwbcV6plbeLtXvkNnNvzspzzk07m8qSeqNWLjWOlN5Hkunnnx9/K+vaRZG7GlU9fyYeh61ihjwRo8iKIEpcK654drBeOFKsbDryL5KVJaO0HM/LXUkbmIeOIu+KLepYtaPIb1J+aBxdxhOHqlQLyJuZtILKFTKXackPM7nMvri3n8llui1N4TJZI/4up8ZWohVG5uZz+WxsHbolzbkFyJmJ53QVRsydSvnODuNEsuzl1nrv5d6LydmX0lP9sqaIe3tUMauUapzRklpiW9TYvS6nCEbV2bVfK9/Ucx4rnNpgblRrDClX6kytoVe2ET119xZTIXN1ZospNUipulNpzF3Okhu16rYpkNXrdi2/vpDaYG6WK8SSrBXLdWauuFGtNXKZu9XabbbGNIrlCrPJbpW3y41M9hphKpv9671rydlr6anjZW9pOF4TD+hIZQmLDixJhbl7VdU4jZrVbcbO5DI8J/G0xXaoJIjSXiaX2eVE92fWaLt6f4k3BLl7i6kx5BTKU4YN8/MLS8NsWCw1yq8yPgte7n14Ml1IDxpYVXbB+F+if7m3PlzYGH7VRO/z39VbS6bT6fEvn3fGF2NkURN/ITSmmKOJ3SE9zd/qIi0q7Wn7xjiywTTuMkyFrBhGXTMHPb4lUkljFbob6KJmf/BrKRXrjTlPjGKdbGxVN7Ku7ryhe2F5xVQum91IkxX2NKO43NR7q3hAI4cPb6Zcybg85VcW18yRz+z5LC9LmsLxEYPLJnOjuLPVIHnfOOWNQObyuQVzxDHbXVT+Tt4icxlebndaVKOCFWT8YUbS/zaTVOiBqNspblh0wp1bm6oplGuztCPz+4Ns6ZXLkgJZNOtRoo80VqUPulTiaVyqfqHrVsr7lBPYfU61kjVF3YvluqmiWiN2HpxAPQMrS0bluRH0RG9uVTdI5vLrH5+/ss5d2X3jsmUXXqGcNvCu75FwbNPtCENieSSuFzypGNFNkUDpC1ajCxU0a5Q0aKooYSsLWc8diOutJmer16b6Jf8dqEU5lbKa3G6qmixRlZVk1sxzjED0vSlejT2y77yyqcezRvaIKMPvRVtMsc6wjer2Rr1RrTBseXt7xxjNrGE1kUhcHX0Sv9LbmEyXnx84uzUnXeZQbM/N3lrpFUeNmPdG/FzvUm8lma5eG+ttG6JxtlOoRiVNlKUYgc9adVCubDKvkaFaUmSA1eesS3qbzFkTmOx2b3kyzV0bG1jCcIqLMQGf0b//T078SiL595LHye3kd0/+xOTzE7+C9RYA39wc097tZHp9ffzzvLte1Tj1PitQfeZBJV60lq6hq4kfDq9iQ0LxC1r9BmmIRwU4Kg7ZWJnTL3PzK29jThC1jLTymAtnO2r9aEvb60hdRL+Hlm9WorRmg0t/Q7fqiMU+B4jSGZHD06o3TWRXz8VCRKW5E5RHvZeT6Q9dHO+94N4ajXTYDqdQSXMvJL4cvv15JZ2bnT+bZiAbsK2e+26vnExfuTjeywSTlhXBmiiZKf/luJQNwbiEFVFWRO2QbDL1kjfdpd6tyfTNiwPnEab6RU8evrTUuzlitAVPtL+01LsxYrS8J9oPfbnYY5LpixfHf/K2fwBwO72a+GJ0R3+768u3+5wrdn36thampx9WbA3+pmjkzRrTtP04tWagP0dr7+BCV5RUTeny+vxRHarYJxyne3FhdcXMMa+IGlVEjn1TlaVI5XoAe8C1RGHOJ2w+0/FVnE+Xm/aLBU+CZ/N5pTOwxMRwwu16uJKfN5tkft7sYJKssU26Kyvuwtxaj3sC3FW256pzt+NbnNhmm24mrBujc9mN7lxzIguUE1qiFEzdvexGdq45kdvcI5bTNNruaGqcCXwyweZoPQ950BUVKrD6gw/6MFZTSM7WZlnU7NkKVbstjb0vSsFWY2txw42moNFHWiaX0Ruv1QbaosTSA1EY9LjEJxOZkdNNXQLzkOjZiTtUxk5M/APcqSYQ+oM0plYzbijlSrlRLm5t3bMuMptxCQ9/XJ8ihITyYy7QT6Bl0IQnMLp72nAg5GKBWBaO7zPRHdHtSR4Bj6aoDhStye1Wo2uKyqe3e9rh7uQO5/8BAAAAAAAAAABnH3z/DwAAAAAAAAAAnH2w/gcAAAAAAAAAAM4+2P8PAAAAAAAAAACcffD+HwAAAAAAAAAAOPtcmHxPYjpRTEwtTL5v/J+d/6mxWqL43PGzH5z+xREV9C8cjyXT4s54f884rrijyPrxlwqrdCVNbFPWPrJRoQcyzxkH0VqOCERpbxTpsYrvbOeTJWB6WBgljufYzZx14qx1zKQRNWdHVXm5Q/XDKj0OigoZJ8FM/xPHieRs997Ucd7y52Fr61BFlSWupZ/tvG+c/+pJ3zi91HClY3hdGilO0OPHaRIKOwEZLWnX/5Ot72KhurXp/Hohrx8+qYe7flZe1AXcn/FuRUjGTpw4iRM3cddVjqgSUTJOI7YcjTzePvpMMn3v3vgXVONQ7NEKM5rU2JbvMO3RIhkHbbvtKXzgdsxBx9HnmNqK9qhEFdMWsUcMhyT9x9Guz8+v5tfXF5aXVpfm19fzo7s9ctu617PRCZ0Y+Y/8jczMU3H84xTIq8BKzRfkOXXVez3WlZA1UHgMVghrDLsHah19djL92Xtxh8OP1gjZ/IgtfHv6UWLaGNeP33v06eSs+P6ptz5kDWO2Gy+Wb3FdgepJ81RVfZqaoiSY44otHRiiTqYkODjdcEfyg8X1qGGa1fYV3eGSKOgdyE7NHKyY18r1Rt3jdi5v+puzfZjFZEl3hcE54z131XV5Zgx4omC0YM7rB68pdyXdxZfbU/Qbxk6lXK2Q4tbWqDlocV2J32dFSXcXpBLRyYQYzkQqO2g4belHy5cM7cTS7hlZ211VI01KbIdDxDqN2EqEmFVi+xjcOPpUcvb+namjur9hDKpS7x1nuLmj28yo+sN3tOEpDr+bDbJurGHj71OJROLF087ZjqXjc8nZT7809fkXAjXACXLHuMd35JbIH7LuvMe9/Rs2sjyARceLr4GT6g/3X6OTeDqut3pCuQj4mCxkqKTf04WM0ePiuvMokz2ipAh5uVp2Zjsq6Rhzn6uiUFCuuvlzupz3YkHPkqcMem6McCNdO9T4YRxqbob7JpAFZ4aT8YiEb9qFzlW7uboXB/d1O2liJWj7WPBOoIweb9997O5u219vrbalzdZ6/NHjCbPFTZy6xYmSShXtnWtxpv6wt1K0rm/21tV/dDyenH2w43qtHaELh9dLQzt9eLV0wkQi10pDk32nV0ojVEj8fQj7/wEAAAAAAAAAgLMP9v8DAAAAAAAAAABnH6z/AQAAAAAAAACAsw/W/wAAAAAAAAAAwNkH638AAAAAAAAAAODsg/U/AAAAAAAAAABw9sH5/wAAAAAAAAAAwNkH7/8BAAAAAAAAAICzD9b/AAAAAAAAAADA2QfrfwAAAAAAAAAA4OyD7/8BAAAAAAAAAICzD97/AwAAAAAAAAAAZx+s/wEAAAAAAAAAgLPPhZlm4tnxa4mJH5u49dwvPLOS+uPU11LfP/G/zPyjmc9NPDN+bexvjd1M/HHij89//GnnFHyT0dvq3U2m1zPj/ZIoCfTRQ1m5z3KaRtsdTWVlibIt8YD6riZ+olRjig2G7FTKd3YYUq5sMq+R6IgpQqoVf9icxqn3WVHIpgi5e4upMUTVOI2ScoXMZfgWJ7apkMllBFHtcBq/L0p7mVxG6UqS+ZfabbZFTTNkFMrLB1Q5ZBX6oCsqVMhkP9x7dTK9nRlPGKVRH7REjbJcV5ON36w/l4v+cv21rd72ZJpdHxjZyL1AO1QSqMSLVGUXoq8n/qOt3tYp1OVj1P3IDy336sl0JjP+4xmNa7b8leIvyX9i1VCjuLHF+M1P5lKEiAJpMK81yCu18naxdo/cZu6R0i2mdHuuRaU9bX9OFLJkg2ncZZgKWSHFyiZZm8/mUsTUZUevVBuksrO1pQdYtRoO0GNQhVWpqoqyFBIhNeYGU2MqJaZOLBlVT16PyvG83JW0gXE6irwrtqgTp6PIb1J+aBxdxhOHqlQLyJv2sIKMxtmSH2ZymX1xbz+Ty3RbmsJlskb8XU7VRRrMTaYWVGCFkbn5XN6SphJPY8WNwOvEtLZCD0TdInHSTrgdwexKUQU5dSfj5XanRc2/my2Zv2/8tcuJLasPtiinGn/SRx2jE0Z1zFyG5ySetvRIphmMaKwZR2W5WAOG5K4XrMJqnLJHtVDLGtCg7PKybVmwzGQm4g8o180MVGv+GIWMSiUhY1paN1FswkY3cUWMDJBNPbxmdMlypdwoF7e27lkXmU1ve9+jElU4bUDFR0g6ZhE42palEZSEBR0dvEI5jQoDqsUj4cTqdoQhsTwS1wueVMz6pEpblLiWN74ZzRfiVo73clideXuybzc5o2d5A6yhLGe1jRvVGlO+WdHHQifIvlWFqlYPUL0a9NvcJrPFNBhSKtZLxU1G12nmfi7cUO1C6CNrZNvL6uWLiWibNDqyFZrNprKk3qiVS43ehV4tmV6/Mt57yb3HG0UzBgWVVSgnHAavJr5i3UQ89/dQJOfu7glxzGL8zLlV7pjzI707k+n6leE3RiuphVDefuwjvVdOpCIfUvEff+5hr5pMX7ky/pe+372feiRCMf5K+K7qCTZurL67oPfuGt2AYhtO5G02qGRA/JHuA/rkwhzvT39H8NwHhg/5J76dSfSRxg68X3ok7EjWTIc1RsjYAdQn5IxgHM/Tjt5a34nhXaGacshKssY26a6suGWySx8Mdke6UNipx9z5qCHQ7pieMctsJwXiqW1jwImxkHfk0TNsRr/oi+8Zka70Ksl0eX28xwdGJN9UWKEHVFFpzIT4R2PGpygVnnVISMaxgnPx0BTyGCaRSHxg2FLqw72d0ZceC/4J+1/9cK8xeuS8P/J/ivf/AAAAAAAAAADA2Qfn/wEAAAAAAAAAAGcfvP8HAAAAAAAAAADOPlj/AwAAAAAAAAAAZx+s/wEAAAAAAAAAgLMP1v8AAAAAAAAAAMDZB+t/AAAAAAAAAADg7IP1PwAAAAAAAAAAcPaB/z8AAAAAAAAAAODsg/f/AAAAAAAAAADA2efC9K8lZsb+dmJm8cL/kPqHKXX6t87npj89/eGpf3fub4797Qs/eYHO/MZzPzfzG087n8DmsdJrJtOXLo1/8ZLGNVv0oazcZxV6INKHqvfvxM+UakyxwZBGcWOLId4gMpciRBRIg3mtQV6plbeLtXvkNnOPlG4xpdtzLSrtaftzopAlG0zjLsNUyAopVjbJ2nw2lyKmKjt6pdoglZ2tLT1A7TbboqqKshQZbKZOFVal0UKkxtxgakylxNSJJaPq2dAjC5QX9QuBGGaOncByhcxlOJ6nHS2Ty+gJqtT4403Ka5ls1s0G+6Yao0wPYA+4lijMeUSzhgUs05SK9YY3kBTrZGOrupHNkhcLZGF+fTW/vOBNTBD3qKpFJmep9AlmSYGsLBkp+hXocW9uVTdI5vLrH5+/ss5d2X3jcsZIiVcop1GB5TRSrjSYm0wtmJJH4nqBmHW5Uynf2WHmfDWXi6gor7BV/znr6o1qjSnfrOgNyAny6ct669WQcINVrzZSrZBNZotpMKRUrJeKm0wqS+qNWrnU6CV6XDK9emW8lxElgT4KqmE1Tr0fvJj4W1YXKFc2mddIZBw9zVCe9AA9T67F9Oy9dbP3RjJ95cr4l15ye54nWij5/yLcAz3B71QvtDIfDuA0jbY7WmSYru2UPVPtttuccjiocRv9xZZz+4pdrrxRrvzK4tqS1WnUbksbsYc6olE91NUT20PpgShQiacjJecTDifo1xWbJC9LGpW0EUYFv6RnWAioeKfGhUBXt666DSl2ALAaYbjr6wFDOn2cTk+yIbVW2KjDyUd6PziZrl8ZTxiDifqgJWqU5bqabPxmQyPFYqhv/82P9NgTqVgIqfjpj/Q+fiIV+ZCKv3GBS0wb04LeB3sfS6aZ5fHeG+4AaVtMoR1Z0VT7d1RY4j8Pj5Ux0Z0hMxDuaRf+kZO2O7JGJf6QvU8Ps7d6r0+mX18eWOpgyvnILP/1x9/f+2gyvbw8/gXWHZEDUpExfyo8MgdErNHZl/WhQ7W/oKRAFlcGj9WDhuT7ohQchc3kjABjpsPvU/5+RxYlfbZjtAv9j2ZL5u9TIZPL7HJiy/ijK92X5IeSMwPSizji+OqIRo2vrp4BMyBDaJQZkEfQNwPyKnjiI907PNI8xyXOrfWEyfTtSwNbvDU1t4YJew7/X671+JGj5n1Rf7Y33ruXTC9mxnvLoRFBZVuUU339RU38ZOwIYIkHO75rA1XjNJozhFj6qCMqVB8tdNMkEomtJ7V46433dpPpa5fGex9yS2SX3h0WfWb4+XChwjGcgllBgfmwfxrYe673mmnX7Qi7crwmK367/mcD7GqIx9s1NC2zLN3tCJ4crfXoyI1k0Wedn8P7fwAAAAAAAAAA4OyD7/8BAAAAAAAAAICzD97/AwAAAAAAAAAAZx+s/wEAAAAAAAAAgLMP1v8AAAAAAAAAAMDZB+t/AAAAAAAAAADg7IPz/wAAAAAAAAAAgLMP3v8DAAAAAAAAAABnH6z/AQAAAAAAAACAsw/W/wAAAAAAAAAAwNkH638AAAAAAAAAAODsg/P/AAAAAAAAAACAsw/e/wMAAAAAAAAAAGcfrP8BAAAAAAAAAIBvj/3/F8bWE1N/NvXrU28l//R8Nfkz5/70XO3Z1Yk/nVgaPx5bTzBPO4/flPRv9tTkbL04dXxeU8S9Pao8lJX7rMap99l9UdVk5ZA9oIoqypLK8lyH40XtMF6kVGOKDYY0auWbN5kaGUFXaoO5Ua0xpFypM7UGqVYGRErdvcVUyFyd2WJKDVKq7lQac5ez5Eatuj0gFrl7i6kxpoAoFCrM3avW39kUIdcLJL++sraylNpgbpYrxFJeK5brzFxxo1pr5DJ3q7XbbKNYv83eKtcb1do99lWmVi9XK+xWebvcyGSvEaay2cv1lGT6dnG8d1eUBPpoQOH1oPjgxN+zzFiubDKvDTKiHpQig402ZxU2Z4SKQk5WBFHiWtleqfcgmS4Xx/vJYfnlu9qA7P7KqNnlu9rQ3NoXrFzm6AGVNFalD7pU4inZZOoluwTGj2yj15lM7xXHE0Yh1ActUaMs19Vk4zc7IDv5AWX6r3uXelIyzVwb7+3EWMfU3+H2aExY4peGGMbVEGcWQyKuBs3y3+m1J9MvvDB+T+OaLWqV37ZX4Gfiv7I7aHFjiyGB0DmJa9OcSh9kj+/27ifT166Nf75kaI3JWFy5f9GXSowUmUsRYpekXGkw+oDxSq28XazdI7eZe6S406iWK6Uas81UGqR0iyndnrPlr5N5UqxsOvFfLJD1+fnV/Pr6wvLS6tL8+no+m0sRu9OTBvNag1SqDVLZ2drSAyxThgPui1LgqpW0EVCukLkMp2m03dEyOfsvVqEdWdEvqN1mW1T1JpTJZRR6INKH+lVxT+JamayRJdWwKHufHkYm06LSnrY/VyrWG3Me0WKdbGxVN7JZssE07jJMhawYBlibN5TyCuU0KrCc5pgyoNcjcb1AzFg7lfKdHcYoWc5NywjSx+TyzYpeEcHmlyU15gZTYyolpu5WrjvO6BLVCtlktpgGQ0rFeqm4yaSypN6olUuNSq81meaujd5dzev5uLb2d3tTvTeT6fVL472C2yhNi6usQnmxI1JJ815N/J1wvwxFcPqjFeJaQWZValSx/ss1q17utZ44mb59aWDh7JQWfFn6hbXe/shR876oX/vcSm8vmb50afyHrri91Qr1SX413C+tIKMz2t3B2wl9jVKv2cjmF9nNgs1EnYtsGXr8XUVue6war8eSMVQZ3Vg+XTRO2aMay/G83JU0do9KVOE0UZbiek98BKczeUcU/bdCO61DVs+gYWJvUFsWaGTnNwKMMeZBl3apPnRolCrWyNGUheFjhiEUHi3yRnUtLqyurL39AcPT09+JsSJOZ9iiYfXB3jp4MHqL6cnJdLE4/qXvjLnP2ROCAVOFXx5yt3Pmoe/GDS8wfQpXblR9BKYb9gQxumZOfksNTOFi2ltA6rrV5BTKy4rAvqnKUmTbTxFCiB7KHnAtUZjzyOvTe2JYzdtBvArdfvJigSzMr6/mlxdShHgTFsQ9qmrxSVuqfdLZwsqSka5fhx795lZ1g2Quv/7x+Svr3JXdNy5n7PTeVo8cPGt+V3tpIOmQaiPc1e0IGtYMpUI29eg1o2uVK+VGubi1dc+6yGw6HRnv/wEAAAAAAAAAgLMPzv8DAAAAAAAAAADOPnj/DwAAAAAAAAAAnH0uzPzrxNjM1xMzX5/5+tPOCwAAAAAAAAAAAIaRHp9YntbPvVGo2pElgaUHomCcXZVIvD82Ft7/AwAAAAAAAAAAZx98/w8AAAAAAAAAAJx98P4fAAAAAAAAAAA4+2D9DwAAAAAAAAAAnH2w/gcAAAAAAAAAAM4+F579XxPPjn0j8cwfp742/bnkH0z+9Pn5if9rYmrsGxf+8MJXLkxceO/YjbELY8YxAeBbgn6+96nkbPXa1BGvKeLeHlUeysp9VuPU++y+qGqycsiKkkAfsZLMCrRFNRojUKoxxQZDGrXyzZtMjQxVk9pgblRrDNlktpgGQ6qVuCipu7eYCqlUG4R5rVxv1MlcndliSg2SJzdq1W0zWqer7FGW62r7siJqh+TuLabGmEGiUKhubV61/s6mNpib5QqxdNSK5TozV9yo1hq5zN1q7TbbKNZvs7fK9Ua1do8tVzaZ19jy9vZOo7ixxWSy1whT2ew1e580jNZnhhut2xG4J2A0U41ttJ1XNouDjfb2S9m/3vtEcrZ8aer4fUNKqYp7EtcyQs0/1RHLZUqnijcaTI2UK3Wm1nDKZGmyap+5e9WILwqkXDcaQ2Vna8ssZYrYccuVRjUusTmrAeQsPbn7oiTkVI1rtih7nx7meIVyGhVYTsumCHm1uLXD1MmcnrId05OLXMbMX8a4aIV5NFxL6RZUe4eGBR9PDLGgQg9E+tAINf8c1YKmdLQFLU3voJGs5uW1kepayEw/xkIp4um9arfZFlVVlCWVFOtETRGrA6u23oInDVKsbBL1qnXRjcuKgmn25d6j5OydK1NHD4c1XCduMBujNmAnRkwjdjU+1bbqZGNgez36gd7D5Oy95anHxSGG4zSNtjsaq9COrGiGlP/SqAb0x4o2YkDzu9ueOdeK/nzYlqTtjqxRiT809A1o5FZ0o4VzTgvnYls4Z7dwO127eX+wd5CcvZ2ZOqKj1ZIv9ZPVy8AKeapN2srD4PH3pV43ObtTnDpSYy11QBWjew6a39gyQ20XVjbKLMeO9TQnOq8ytXq5WglPdTo9zTBhf2ckE8bNdk5lwtHnPI4Jn0SZE4nE98XNl3t/rvfZZPql5fHeNaNZe6YqrEJ5KnY0ldWbdlRA4let4hsTLhIbNzAHcgLnrN9O76EPuvqh7dlbvc9Mpl9fHk8YeVIftETNaCOy2ZkjE8pH5vAfHn9P79PJ9PLy+Ft3jL4ZJRUZ8x/YVatbMjL7ZC5FiFME0mBeazgzOVJjbjA1plJi6r7p35woZHVzWP2nVKyXiptMTldkFV4fdRi9LTmqSreY0u05J/w6mc/qEQzL+hM1JY2AcoXMZTiepx2NCplchuPvZ3KZrnRfkh9KmVxmlxNbVMhkDVUcr8kKq1J72mGq9RTBCjKyr0cQqMaJLZaXBWrKmil7L+vTWj1P1RppUWlP258rFesNn0ixTja2qhvZLNlgGncZpkLyxp0iv2CWUKG8rAjGABhnFa/I9YJlmVdq5e1i7R65zdzzNDGndaWypN6olUsNnP8HAAAAAAAAAACcfbD/HwAAAAAAAAAAOPtg/Q8AAAAAAAAAAJx9sP8fAAAAAAAAAAA4++D9PwAAAAAAAAAAcPbB+h8AAAAAAAAAADj7YP0PAAAAAAAAAAB8e3z/nxr71cQze89cTf0/qb+fejn5fyS/Mvn/jj839qtjnbHvHfveicbTziOIZas/PZlm1wd6CdWo0hZNp50PulR1/ISGrie+/oXd/lQyvb4+/iPU9RQakouJ/Vthb6EhIcNfqO0R2fCa6XFUGXQYOsBTaMBHc8AH6E6lfGeHsdxjWp43AzGyhcWVUV2I6nm5ysvtju79N5Mzf+vOQ+2/eU7iactyJKpqnGZ5BA26LzVCDJWWPQy3pCrVtGF+SKN8qgYdkqrddptTgrbwGcFwP2rLxboeXVlcW7Kcj6rdlsa+qcqS18Wp97LHxaletYToV9kDriUKXrmsodmbC68SJycvFhbm11fzywspQkxz0ANR0D2WejIRKJonQZ9wOEm/rnCiVpmNmmEFcY+q2iBj+iWzhZUlI8WAAj3uza3qBslcfv3j81fWuSu7b1zOeJMa4tzVlbleMH27Wg3GG8v2j+sGuPXiXr1e8KozdJkRzaZZ8DRLoyhhfVmjoi1pu+FGyVqlyHoT0XtUIdCbjLhxLSqmLWV1b+KEGFnRdV6MVBqhM+v6ve29v59MplcL4707rtNn7xihXwhdFCWNSpqa+Mdhp8/BuI7D54j4juN017t5Ljg+vdKfnEzzhYEje4Rqa2yPyvR/e/zR/vlkulAY/zzjju4RkrEafjM8wkeIGQNB5ADtHesHDs6kQKzhWe5QhdP0oTB2oPZ28YD4MO/KvjvR6HefU48RpEBOMUoEBuH48e/kAy55sUC8o5/bIOMGJI+E4Wza6VFy/1wyvfz8eO873A5FD4w2qdADUb9Vea4lfiPchQLSTg8yrzudxg7PrvQnJtPl5wd2EUvnojfpf7TSHx814oI34q+v9MdGjZj3RvxvvvDefiKZfv758R+W3a5nBnrlfi3cwcyQ8Lwpzsv6k3Sv7tRE7M3JCrcjqJpCuTZLOzK/P6hbeOU8nX2kLj5Sxz6xN/cOd9iSOWGkbuaVDfcznyZfR8sv5udXzX5mCw0fQfySnhEkoGLACNLR60nuquw+p1rVYibhD/BO5ezEvQLetH0RY5K25m9U0jwJRxfSlfIk4ok6oHACR9uyxO5RyRr54xprWNAYv8x2zsuKMGQe5oo48Tz3M2d0sjuRIWAuRMIjV0SYxwTeeZndJQtWA4+sMmtW5nbfOFlnVuaM2nj/DwAAAAAAAAAAnH1w/j8AAAAAAAAAAHD2wft/AAAAAAAAAADg7IP1PwAAAAAAAAAAcPbB/n8AAAAAAAAAAODsg/f/AAAAAAAAAADA2QfrfwAAAAAAAAAA4OyD/f8AAAAAAAAAAMDZB+//AQAAAAAAAACAs8+F8zOJqbHfTJz7tel/P/0L0zNTL57/+Dl57DfH/kbiq087b2BUHl/qf0cyXS6Pf6Gkcc0WfSgr91mJqhoVWLq7S3mNVammtWibSpo6ODTxjVKNKTYY0ihubDFksDCZSxFiXRYF2u7IGpX4Q/Y+PSQN5rUGeaVW3i7W7pHbzD1SY24wNaZSYuqm1o5CO5zi6FXnAhqypFohm8wW02BIqVgvFTeZXIoQKzPtrsZpoiy5aVWqDVLZ2doiO5XynR2GlG4xpdtzLSrtaftzEbGypEAWV7K6Trmr8XKbBvSYCuywcoXMZTiepx2NCplcZpcTW1TIZA0FCuWp2NHYN1VZMrWYkX3Xy3VTb7VG5vQL7AHXEgWfTJYUK5vEynOpWG/4NRTrZGOrupHNkhcLZGV5eXHFn7wg7lFViyyGpdMvqZtgZclIM6BCj31zq7pBMpdf//j8lXXuyu4blzNGYrxCOd2WnEbKlQZzk6kF0/JIXC+Q+WwqS+qNWrnUqPTfM5nmro0nREmgj9QHLVGjLNfVZOM3azQLqzkpVJVbXb2uVDYfE5D4na1+ajLNrg9UqFGlLUpci1Xogy5VNZVdiL6e+CeJRKL6BIedxx/tzyTT166N/8Wy2y/DxYgr3T8P98Sw1NPogkZcUfC3Mz2A0zTa7miRYaKkakqXN3rf8HYalva01QhVA9rryJ27o8gHVGK5TqclGl1cki3DBLs7PRAFKvF0hIIERD2lCCp5ol1Oj3WjWmPKNyt6zc9ZVZZzaygbag1WmOoI60KhBuB05l61/1wyfXN1vP+C0dsiWxTboZIgSnuRgYl/ZrXwcmWTeY0MVKBnJLrNOhc4LRdsvylC7t5iagxRNU5zqtmUz+Qy9h1N4xR9UM/2/nz/QjJdXB3vVd0i2ULd5pv6/7uS+KBLo8vz31vlse5AnmJFKkmR+FJZEe6LkpCzY4lC9uX+s5PpN1YHDnghE+ajc/tPv/iZ/jPJ9Orq+I+9zx2fgmLRcf+78NgUlDFGphMPSd4IoqTps4wRRiWyqaupGZkpV8qNcnFr6551kdmMHbOCqetJxYx5nvqI7O7ecHOqYPU0QVQ7nMbvZ3IZVdzT7zcqleyBxK3ZQWOIp/7JBtO4yzAVsmKMIWtmT/cOiO4UJKDMM+UIyoenHSGNvqnHwvz6an55IftUx3WBo21ZYveoRBVjUhc3NoYFnSHSHBai8jvSgJGLmBDmMl3pviQ/lKwqtm4xPtv4bj52iHd6aFnLL+GxVCBqjJV86Qenpr7rMVNTr0y4jfg0xE1NPaNzXP14RZya2dWnZuIn/BFNeX+Qm3Pf9esFb9KGSjP2aDVrljamhrxBPvPpAVG50+9DhBjWNVPXLXDaHNjGi8yFNzCUEysw607I8f4fAAAAAAAAAAA4+2D9DwAAAAAAAAAAnH1w/h8AAAAAAAAAAHD2wft/AAAAAAAAAADg7IP3/wAAAAAAAAAAwNkH7/8BAAAAAAAAAICzD9b/AAAAAAAAAADA2efCM3cSzyY2Es/+9LO3Up+a+ueTf3/yO8/PnsuN/+vx5bG1xEZiY5iGntL/88nZa5emjmY0Rdzbo4rhabVN202qsC2xLWrsXpdTBM9l1XYeWyvf1N06xsRIbTC6C2NSrtSZWsNxlWvpSN29xVTIXJ3ZYkoNUqruVBpzl7PkRq267ZOzHABb/l8LFebuVevvrO4kcmF5JbXB3CxXiKWpVizXmbniRrXWyGXuVmu32W1me4OpsVvl7XIjk71GmMpm77D//uTs+qWpo+8Pl1plJZkVaItqdLRCeyLYZbYc0EaWWffjyLxWrjfqTvHznnJ3usqe4RN4X1ZE7TBQ/urWplP+EQte3t7eMfz82oW/3P8+o/D9sZjCdzsCd6LCmxHswu+8slkMF56cLrd9pj+bnC0+P3Wc9+ZWkbuax0qeNmqERGY4Mk5MKzW1DKuwjiLvii1qN1KrfXI8L3clwyuw7sfTcBl6sZBRaFs+0D2D6n6ja4O16v6CA1qtq6NUfK2602DY7XJ9u9go3bKr/X7/e5Oz689PHZ0PGzLY0YcZcXg39xpwQC83xYZ08pWl0Urs6+Ja/33J2dXnp47eFypusIcPKe3w/j1aa3nC3dssc6h3X+p/j1Hu3iejy+3p3KOUe2DXtmrvVBk9/o5+OjlbTE+9tePJqMqqmkK5NssJB5zEU7dNRuUzWjqY2RtEoQeiKspSTqKPNFalD7pU4mlun3ICu8+p+3aB7Cpk7l61o5CLBaLXivP7BZK3OjBz96pPny3qv+jKexqG4VA4onXQA91juu6NWfcuT6zWQa9624comO6IjcGFXrUTKoSS9onZ+Tc6l/3DJ9HRr8pd1bRIuW6UxTGRT9TIpnHZUOcVGtps640aU9xmi5uvFislhi1XXi1ulTetRnGU6X93cvZD6anPfWegUXDaCG3BEQo3AdNxc6Ceqw2jKvSCmuEFo1Yt2VqKkDlvWIbjNfGAZgwruIKGJ2heb38ttkMlQZT2LH/inp+83O7oI4jP1bgZSf87m41KL6DUn27BGz0qti8HwbhWHrKpESqs2GDYRq1YqZcb5WrFHmju9N+bnH0hPdW/76sq39AaXVFDhtMnNZCOMIYGB6ULk4l/l/j242P975xMy+XxhCgJ9JH6oCWaEyXZ+M0aRpWoqlGBtd2cU01r0bY+WrELg8MT/+Jj/T/3NtTnh6j/3URi/E+etgUBeDrf/08lv5SY+dhz4oWvPPuJ1L9JTUz9j8kvnf9X576K+gAAAADeDfq3+5nk7HZm6viK99ELp2m03dE8Dx7Fdrurcc0W9YZHPocZEDe8xBWFnLX8yWmcavxf/00VVqWqvtzXr7gPJ3PuE8VcR6Eq1XK7nKrldo1nI7bcHpWowmn6wxOBo21Z8l7hFcrps3JOcx4J2aUZtvIqNhrM9isNtrjTuFWtlRv3wk9+f6D/weQsk5k64qPMaWSTbcuSrMmSyI9sykC8mMeXTjGcB0JGPPJigZSqxS2mXmLm7FXpdvG1OSPU+2DTVmCtS60KMR6XWH9nc/PZUa10g9GflVSqDXa7Wqk2qpVyyX2seyk5W77iX4azRhrmAxH7YY/n8a4bGmmq2MgxjwE96kZ8gDak2I1i3X7uUGNeLdfdpw5H5/ofSM7euTL1+L0xxRUFKmnhXjZ6kcMKwl3N27/0/xvP3ayOY7Uzo/sMNpEbi7zoPjk0L1gPGP3aTKlACqaglSPb2vZPK9TKpx1q/TxBNQSbXX+2/3xytrQ+dcR460Gg+vMmKvFi6CG7kSNveFQ1RMePeeoe0vguP4DfZF5hKptMpRQeu3pb/R8wzNPPDDKP51n8qcwz8OF8SCN5G+WR+xeTs8sXp468z2WNJKLqObaLjVap73ZFGu08VGTSJ0aRe93IIgfqbnCRh1bU0MqJzOOFC19KTIx9JHHup8Y+8lwas7yT8rk3jieTs/z7p37IHsWsN7osL0uaIrdaVPHMvRTKywdUsd4c2y9/AxV/Ag0D3lLYyt2bhfXc3tGg0AddUaGC+WTfefB/MUokZb64MTtT1Msne4LIt7iuQNmOIvNUVZ2M64MH53khxV21Sxn1TsoNdaeKhpSt1r3si+Xmv0U51cw2ITuVcrVCiltbo2e7xXUlfp8VJc14myZ6ci4OzLl4opzrL/KNtyrOOBVlWltjhyqqLHEtX2s4kHlDm0oUTyaVgZlUTmVexW1AunX1V0KD39aRjNuCiZtT0u6qGmlSvanuUYE06a6sUGItF4jd9qwB6ofF4/PJ2b2Xpv76qtXB7CrjBLmj62M7ckvkD9muZD7TF/TKFNtmB4kWDt8cT6Q0ptflXJvrHTA2aWtLg9MlLxq2t18ZGl3Vo6lcN5qHVT3WVW/DMZuMp4MLoqrPOa3Wb7+1C6jcsbqD3fXDKfpEvK3zbbVPQl6ult3RiXSMseqqKBS8bdYSjWnMIbkBzboT36gHNWuzbxpv3e1Cx1p4qI1HsnKUnSMsfSAKVGGVrqSJbcraa+woO5/I0iex9Wmt7YlnlMLWb/wISdlFVHm5QwsZu3HZJh9WfXYF6v/avcU066CmHOqzPCcJoj7zUgnva5R8dDGMdPir5mCh56yrFjLGr/iG5Y1vCHcFa4fA4NZwknuX9/41xLLZk+YyuuWfvgDhOYObey42994pgGVyt4M+iTJZnfXdLlegvcdNcrwSbsYv2hv//H04xhxPpNDOXcAuUFM09o+opOkfmKwIKlGNu6U+MDWvus8ZAwZqjjRsNL0baqy9NrmMQDWO39c7YDYgr57EVgOnOs5EgdgGuLIvtykxGqI55VGoxokSETWV2OOLPeuxJjuJROIL3xRrsCN6nEzO3s1Mfe6uNesybUgFt37tqnrQpV1r05T5J5U0JTzDGklB+FmqT6U5c3Lb4Wla4Ihtz2517kWjeQTap6fNXSzYDc4T4rRZo6GZ9+6DxfUICVbbV/RNcKLglXUuDtpkRawG7ml7dgEJz0mSrOnNjHY005iC8czAXv8nryTOT24nUnenL09uzySenR7jxrin3fwAAAB8S9H7WP9ycraUmerfi3rfGvEacZTXrSO9QAy/bX07bw/tl6aBV4eJxNifPW0bg6dEP9vPJmdvZqaO5KjGrXabbVE9RfMORox4uOhKmE8WI1q88QTRJxdcvRmz1yiJUNRRe0d9Z2O7XNf7R+i10tHV/lxytp6ZetyOMpYgqh1O4/ftmfkJTRYdPeodu7JHNe/eFSdmWxZojCmNTyBCUX32rNYMq/m1eQScB07me/UYVdHpWE+AI3WHEh15+8dmuf6K/ikfu1GubJYrN0M19ljt55KzhczUFy9ENm//5zOjteyRv6YJDt8n/arGftoT9VmNbS/3mxrjwxnn6UkuQx91jHdcw7+m8eqKSkvpSlIoneCrtOHJ2GqikjB6qmZ+BdRsyfx9//dAp0nOVRn5WdJpPjuKeccYay5vqSIT9FSXN+3h3x45g1XMN0if6r+QnF3PTB09H9Xs/RsTRmn0w3YnhFv6u7JBwTZD+P3//5x4LnGYeHblmf3U7ekvTD1Kfn3yn57/gZnaczvnPjoxPfbLicN35nZ6rV9KzhaWp459xwYolKeivjNpnxO9d1JV3DOe6JjB0V+chqPGbM0LKPO8Ifd8h+lu0nMfNOn79GyZ7AvemgqotGrKumo/O7J/pbK5/PCP5so3K8UttsaUmLLefpk7O/oWPnv31Ha/mJxdXZ46Xveaz0qC4++fzHbBeCc13H1REvTnX/etfu7/UDWiZZuajO9UVedpm/Eczmcp6yGtJnvukNYX8prs3ZWaGtWexdJttlhqVGuB70b72/2PJGevLU8dL0e0x+AWpdGb4/D9StFGPakFjceakYNGsW6/+rMHDtXZvuezvDGCu230hA00tPtps/+SYdC+b2T1msWzAeqEBh24GyrYF99eOY4y/fXkbOHS1OOH/nIciPShfWiJ59wD43pMAUJR4o4+MJWMdI8YesqJ2Yf83cdMwLev2zpUYtj35e5KwWl64e7rW2aYXTi0jzwuH6N8Aa6vy5m7TLAP9w77axGHsljWDB7ZMKyiRji04QTV9ARPbTAKH3Uoy2rEoSyesnjPbRip8INPbjDlyOly27/QX0nOFq9MHdnbeoKtKzjiuiGRN7CoiHEDriv7LlfdgBVz73p/2TBI33faSKBc3hHzRAYZPGB6+vTpS9B/X38pOVtenjp6KfrpX0dWQjfSQOjg54ABBYNn2Lb8u947X6nWIu6GL/cXDeP0Lw4xjqeKT2ecgVUdkCenK83RXH8hOVt//9Rj3ycj9rtzOxHnO4hBu11HiBl+euC8IKVtTmyFt7u25IdUmdMUsW08gvGLZ7P28xSPmHdTgSPm7nqIm4U5H+kU68aeDns3h/uRlHf7pWcDh7W4th5c5AKPKeyV8QgL3Fdq1RvlLSb8OZS7p0BNvLv0DvsvRtyHrRlr5FR6wKpk1Bn0uz6Ym/PGiPvwtYj7sKcsoWnvsMKPMNsddZYbWv8nEonz56YTF37nmV+f/lryR89Nj/3vif/7XW4vAICny1vJ42eTs/dKUz/06eA+e+tW5u7qNsejwAb7gNSALfYD9YVHuQEpBEf82D1hauRTJvelS3AvYHAroP6Q25gC+K+Hd0jbT7ntzN6nh96XN57L4R38gY9AYre32bOUCIM4+0rtecjg7WvmDMdOzpgDRWTc9woxGG697QrsJDXf3UTI+rbeB/QV3NhO2T0ztE54fuY/QrPjiW6W39jtHtjVqiccVBWxGd/e+OnfADpwF569587+ksWdZIgqcT4FJg9FbV+UiCy537xY2bPPNfye42eSs3xm6i37wNL4vZPGJ5pR/THqi8ITqIl+Ydc1t0t6k/B/XqbvdvcecYetmqfYqqmJB/oCQdXFui3/fs3j545TZtt4/2htQ5RUqmhvu2141YQfWqJFPMUW8ezxdHKWvn/qLfvJQnxVml3T+2Levj+O3BrCKuK+hrMkta5i71uxEwt+AOeOGfaZBf6o3p0VT2BYidnafdIt3b4HC0M3dfukn1TLaFJe/8bAyqTVHi4fTyVn+dWpt+wvkuMrU/9GSNFj25uPnBx6QkZvGyF14ZEiMgHvC9jY/Uu4lZx217/zbZrX5p71f2r8jxIzO8+9/uw/eeZi6vXpFyYPz7888Wfjf4QlGThr9Kf728nZ1dWpow95n85Zh8L6n0x2FNrhFOfI2MindMGIMU8og6re5UeVzI0bTCn8GL9f7m8lZ8urU8f2ZNJbpphjkE5glVHOQRIF2u7IGpX4Q30N6JyHZKnQN5bk1G7TPmZMlFRN6Zq3mDdVWfJdEMQ9qmoRp4w5efYcMxaqkhFtuMlUGpGHjb3Qv52c3V6fOnrdd9oLVdqiuR3hQZeqoRdgofDIU2DilcQdghOM8W4fiMPUtsvmtoo7O0w93PYeX+2/bJjrC9xQc3kPyjm1uQYfoBNvLt9GVP2rW0MgtKOxkLG+/7SPSjHiWGdHcJrvq2hzpuMLch8+2AIRVveEBrqN9ZLJd80jbWzP0kX0P3xPqfy7qAyZ0NYqV17tttucYqZm/e0JVajabWlGt7QP//dc8ghSfTqin6GnXzeU+a74VBrWtnq2Ieq/FJY1bOqVNC6k3n6L7ef65eTsemHqyLen3frOPtCtvXVhSUS11FDkmO4coc7d92/v87GbWNhTxNvp6sMtV640mErEK++N/i3DXv4dDZ4ie/r1ye01sD9HqCOnK8XRB/s3k7MvPT/12HeIl+m/guc6HO93HmT634i8KUZEidn/ZSoZ6vrG8vUR7/pGX5K+4NFg7Wit72zPlYp1xtqEbySTse+HGdLQfy9Yl+3j8jVO0ZzAPGG26gyZ1w1kHEJpPin1tK7AzXVoHvPkOllZXl4c6ovrVrneqNbuscyrem15/fUcPdu/YbgnenwzoqYC+4mHVtPQTcTeOorfOzx04/DQOtS3CjveYkIeVow7lJWI61PlBPpJtbbJ1MjGPeIUYJOpl4hhWTJ8m7JZD6VbxXIluBvvoM+Y/pP8s8uDiOFySHUMHyB9tfGuTauNshdf0Q89ZKuVLXvLRS/T3zQ9KH02uuSegW+Ukg8c6qwKPmVW9fX/xPTjxHOvPDs9/fhpr84AAAAAAL5NeJw4/mBy9pOlqc9vx51x6pxDyKpyV+E9Z8wbaxRrijjg+MJh552OlkD8TuycFa0jCp4/WUFuc6LkXFFk3lxK6kuaiCNS3fz6H8B5zjh1dIeOMfUHW0kPlHKy45GyVltuiqEDAmMSjDw3NT5PgyT9+XIlR92AZJ8u55iTmJqJXanGjiTpgGuJgv3auHR8yWiDb9VP2wbNPSLvYBs0E4jffoJm9NSb0VHu+APJNFcaf/yS6aoxvmrs4zEV2lHk5qCxa6xqtZxyZZN5jYyuc+goM9fiVI2VmypVDoznxLnwHg19QLC2E8aOBE4sc5iMeKxvynnPhTW/APH4d7VPiTUfpxlbUgcPLqMNLANbg377MZ78u7txLXO5R4Y7X644ItZ2mhEP28x6jxv1bTgNJ+rdUOM3czgX1q5J3+kY4p5E9YFCP1PC/FvuavpBEe4W1aGJygJ9NFKaBU96Q+RH2G8aHdHIjbPVV3/V4+7/tYUD24pddb6PeQftKY7aSlyskxbd4/hDN6HQBtuggHdP1ZAWZeYwpMCzuTqyosKHUccoitnIfKKIBc/242F16rQxp8GP1twEejC8+YzcxPWhPf79T4oEdsXrX60F82cfJuDsq/YJWVf1cTWczeGVtsXcaPiOYB28nV0/uyDU3M1jiz17yU7a/Hwjtq/pmcP74Cpzv/KLSMF0z+U9rsL98C8kHjV8ioK+D9wdKiObXeCEdcsnmHGSVNjrmqss5D/+VOfL+5qDG+D/8CBC4MRd22+0CEUeC4xippEUj9gChijyH+Yd0dZ8Aj593sE6UnfceffWgBMZh+8qiv5yaNAXGSeKfXHU21DsvX+YUYJHu4fuZSfd+utrt9bV4Cns4RnOyPez6BnSSVvUMD2eHcUDNLr7i4fp9e+/TkXcv4bXU5uTdEcukUf/fAtV1Ykmsye5t3872QWTfEzyMcl/Fyb5o552Zmwb8vjI3S7Xt/WDQD3v/88lvjsxM3fhrbELie9OvKX/11OP7yRnC2n/1g01Zktw1O6FKNlIf8N8S9SnFgrdzfGyrAiixPm3H+ZkY/OveEAtH8OmXzyO13KqplCuzdKOzO9HeBIeuqU3uNfrxw+OX0nOvpGe+oUJ774Nb77CHy87e4oiN3GMEDd6f9Hgc+CwkHtXFnLRLfL0KzqsxLASw0oMKzGsxLASw0oMr1vwuuUMvG4ZssgoVau1zXKlqB85HbsMO3r/cTU5W33/1GOf5xx7zmlk2ln3DDy5YWi8AYcpHiyuB9dY4WMbgsce+J5yuUck+bRcLCyMdLqwMTV46DlS+GHMFNx7YINZiQ+j0xyhgjaZV8sV9pUaU2cabKlaadSKpUawgnqN40pydjs91a96K8g0cCDlIUvCAXEGLwWj7DrUldGQcunr/7GJLycmvpz4+bH0094IB8C3Nz/eOs4kZ/nlqa/dtsYZ/eGZsWtJoarc6hrvYNn/n713D24kSQ87QZBNkOwHV9rdoXapkar3BWAG3QOQ4AMzix6BYHU3ptlANwAOu3fUUypUJcCaBqrAqgK7e9d76ya6Zx/akFbaC0mnP6wLyeeNiznFnu/8h322wv7Dd7e3YcXFSY6QLhz2rSzdSfKFpJMsyyM77nyRWa+sQhVQINnDGc73m4hpourLL99ZmVmV36dLHaTpfKeLH1lK0/wyzk/UMwKNoW1wMPIL7D6kiM8XG8O5LWtbyDXdT5v+G2xDv0nzOWvvoChd/Kg1f6pI5jt4+4QMc84OGDm+SPl6s9JDDAZ8/kocP6GQzPHdbluiz2pbTkKsQ8quz0LI2UbXEIr3B7G3GOwdoPI6W73L1Us32Vq9cPOW7TBgu8zeucUW6+xmPImH1FdCpjLvm0jHFiBOIke+rSOWklxHpIk9Qt/8UAeAPQpoUWLNbsz83qpWKledM35Hz+rAKzH3hGCwBXWIFPl6xL5pnk+1SochX6Ygqn3lO9ZEIcjzb+eyMwM0RY22ikN6WitJODIO1Hes4/TWHIQUOHpIHs0J5K6xVPwzRDyeHBFuoK5Dh/SJ0Zqo1ckL4RLW4WugbJy0HFHnsFRa49C2LOnxZD7ek6WHXEdqtyUNCYosatx+Jn64xB5Ktf6oi/wS3OA11JZkZ02ybXz2WSCq8YHzFlIDEzqmQmaDre+wbJlJE1W5dHotk8strWTXsulcLuOb5qFlMVZiw2oaM5Xjqr9ylBKkIqdaqvOpbv5QSaK0Om/0E0YXzbufZwNe5/0N3I3KoxGq3lNl3Os8Sq1HMFlN23YCDJW8sOvzDEnmVw+hw/UYSZJFFq1iaL9xZyAf19FD3Vs4o+vCo+VIpTYQG529Zx7ZQHDrS/Qa+UI8bs6N+IaGZN3jGo8Yc1N7XZejPN8Y7RHBmzfcNrs4VD6uqz3rJZW1k+JtyeZUbKAt65LeRiMLxjbGUjbmc0dvvCtHb7yZsSvIk40jZnt49RgFPlg9xzZ5M9f/sYmLkXOvzvxeLHbmh6cuRf964mLkEye9Dnrf0K8f1GOLQmnm7Ri98SMbhoUs6yjEmFOH2GugLeUOF/XbHAqnN8AkSWDgsD7lBsy2FGoM/jrVmA6jAatTpIvYtt48xqd8Zz4D9tvin7lsJPumOaO/gR7Fk0SzmR17qo/VjtzNK7O1OrtpWWursfX6FnsT277wbHwdpA9qscXKKzN9l/0xMzf06thjqWRAYIgBPF81QRZMBoKcjJHAKlurbG2TcWTAohN/UCVldlAcXWa0jZMjlNlw2yeDZXbkTPb3Dm7HFrdfmXn73ohMDvT0Q+czRN8O0zzes06NLgf5GURWUNMjqMdjt3NiDl12rDr6r7EHLTsau/4Dl0cPCoO17n3/8vrBrdhiYW3mbZfvMjMvPma+xrCCGcriV4CBUMe6oG2ea8412TndVsGWj24V7O0vHFRii6+uzXyz5FOzSk/HFrQPV7GuwIOv1azbplVS6yd56jWxsUnpiyMsktoW/owawV3dODNqVUrKWxGW43lybp6yWtmT78vKA9nXC7dhJdq1ihg8cOEzrgyOSHhkUan9MzVgHAmwVpl8L1MfOFfCmZCpTMhjZILELF82qzpvJ5XOnPWK1N08aCcxnjvEvTodgt67puXJdVva1cQoafp66JGzsl0vVm6yAw/Lr+YPyrHFV9ZmfuajPr2LchIwbt8a7V8ghG1lt+lWujbw+pZqYM4o59PCPF0s5dPkUnYTJdXs0e4dLEO14uEqPxD92V6YJ1S7SwS+mLEPIpmJd+9F2AqMLMqKmVpvHilN1nWyWn6PivAEBpWwPbhWL9RZrl4tlGslPAOy3v9P/nVkOvrnkeifX9iK/UHsK9PozOXJv478bCRy7j39GuCb4sFObKHyXkYJfBg5mDrYji3eK80cuKw4B++7uJeyx7SZM2phG7yTc9jtD++TOxKZWDnpuvjAcbB88IXYglKJ9peJdRv7eDyerLSljkQen/gUvvnKmlNkbIxGUPaRio9AjQwQ+b/MhrRdLt3etizejB2PYfhmZLCEc+o+ZQk3JbmF1K4qybpj+YZ6NgYvPlJxvtOQWj2lp2EXxkhXH+G0xJMHzx3cJcV28ChksdmHxx5Isqg8GF1s/6fLQtDYEYQtL/IIH15oqQcI3W9big0FGrYsZG1wWHaW8fO7cXBneqFXiUYMY0l7bUknm3kK+c2NzkdmdNH8gflsrUR/aYWcwxsZZLTO37eGOzyijC43MmPy5p/BFtfxWHmrWrpZqN5lbrB3mcJ2vVIqF6tk0GKK19nijcRAQOtVc8b3VXMyNcd43YowdfZO3fEnZXYuQ30byS19N+EJkWTyzPIq0UU5j3SrqbJX2SpbLrI121hKAn/QVClbm7vFQq1Y2GSxFkWVWuS7T69ZCrscbL1GuoIDhMi/dcwofHRDQljxBacoMB0+HcRTiK5K8BuEmDyzmjU+1PZRhvVc26psMPEX3niTv9RMX8rdeyFO4g7oiEEFECQ+/MMGEpNtQKynGX7RBCTrTJUtbA1Uqq+kFUUuR+LIpNNErTHq+hXXkcbjlO2qBBsdUzSySiLZMNdYJEYzvfSyi5QJVtvG3/g8qiIRIcN7vaxgn6atulI1RWSlqCIRf2pDNLcVgThXsZaWdBQD90hc7toQdnm5ZS2+SRuwB3DrlhERdQo4qJ07ElfyjFHQtNU2/1CUxJU8FQsJboiQZ0PC4wyG1KddiB6XdoM5Nx3qGrs4jjazlgaUDVVke0x0KXN2EQcbwXj6Tc+/ybkkU6tXS8V6P33wOplaP7U8D46eBVNv1o5vaj30Pdsze0lKPi/0fSeHrVgRg1X2axP7BcqQ9zDEL47/e5jksS0D8Pv/yEdOel4NAAAAAAAAAAAAAMCzZA7/D9b/AAAAAAAAAAAAAHCqgfU/AAAAAAAAAAAAAJx+YP0PAAAAAAAAAAAAAKcfWP8DAAAAAAAAAAAAwOkH7P8BAAAAAAAAAAAAwOkH3v8DAAAAAAAAAAAAwOkH1v8AAAAAAAAAAAAA8OH4/j829b3I3M+f++tzv3D2f579h2cuTX1v4pcmPnay6Xp664CPLd6vzHx9T1elVgupvCAoPVnnVF5HXFvqSDqnIg3pHK/rqNPVOUlEsi7pj7hWj1dFQ/xkMwEAwHtC42B3eqFXiUYkWUQPtb22pCOO7+kK+c0FDh5dpS0JEtK4zEiRyJ99fe6gFVuoVKI/N6HzjTYaGWS0zj8tVtlCnWXqhY0tlhkpzyTmGKarKk2pjThJZOrsnTpzq1q6WajeZW6wd5kqe5WtsuUiW7PEtIQkJplKmdlkt9g6yxQLtWJhk03NMYym8zoydJQrdaa8vbXFFK+zxRsJ406pTOJjmDgv6NI+4npyQ+nJYjwVV5GgyILUlnhdUmRORXs9SUX4zgNJFpUHnNbrdlWkaeSaGdwIPMcwySSO3sptU5JbSO2qkqwbiTHSQGL2kynVjKRWqmbyGKaN5Ja+m/CRTuZXs6ZQobzpqw/n/dpWZYOJv/DGm/ylZvpS7t4LOJkMk8SJxWl9gND99iPOzBypFI3jdaZUrrPX2Cqd5EBRI9lEplINFNtg6zssW2bSJL25dHotk8strWTXsulcLmOlR0X7kiYpsp0ATwXa9y11GV91RJegIl5HIp0djzZK4kqeSZNQva44IhQlcSVPxUKCUwVmVaLT6MK3t+SIuqUL3ZAKUz1Jum1RyRrZtsMkxyykkEmipUlrnEsytXq1VKw/rh00Ywu15ejBi2SQ62l8C+GRos01eandU5HmzIlUJCBZ9xGJ/Ik5ApXKm+wdJoQSI+GVsp+sVWbUGJXyKYeUpvRUAXF2K91ka0UjaPIgc/BGbKFVifbXSLZGzfs0TpERp/UEAWnaSOHIH5rZ3S6Xbm9buR4rjjmS+ZFBjKIYUQ4BNY/rmdm5zlZZRunpgtIx2x8RwG2urSJefFRFIkId3Ase3zh4M7Zw72b08YPhhaaihiSLmpXKUXKRf+NqHWHVjigiUzohiajTVXQkC4+4++hRSkN7PSQLKPlTB/emF7SbYz/NrWRkRubrj9+ePPjJ2MLNm9FvPBj+LDdDjNT4R+Ge5KY4GV2s/NoDKPUkx2Okp3w8T2rqUT+6MXpUBUwImqrS4bqqgps510IyUslwGzTAB4mHeOboyhjx+AuHiCVwhuGJYMj0gckzq9kxpw5HeKoOy/CVoPohIY0BbaBP+apyHiJ4/T8b/e3IhS9d+OTs3Mxvznwr9qexW9Or0d+GhQvwgeRt7uCLscVCfOabvLl1pCENzzI4ndfua5wxLTV2iVx3rAG8WrqGe2twqLkN9mqlyjLbtzZxgErZLTu3c50tM2V257IkMhfzTGVr87Ik4mdilVy1hJ27zhVKSthFYq+NuPuS7AjSFx1ZaiQxBZ0rplSlbk5orSkalhJRG1lj1MBEGSu2Jmh5LG39eDHjkXIm+lewnPNzcDIdKtahAqQYdF7vaXlz7h33BB9+1zdLHhmZ7yByH//huddVlU5XJ3eNPz33JVlH6j7f5jqS3NORRiS9FwMLMO9TgE6+ZfRQ58Qe8lscUKl3pEh9UL+pZcQGe61UZmrsFlusM9VCqcYmChuVaj0Vr7G1WqlS5uqF2g3OaONcqfx6Yau0GU++wrDlzYPnDh7FFl+Nz/Rv+3YxYwoyZg+jAlkdrFSusdV6QAdLmGkvVrbL9cQLSeZqtXLTLWjOoZ3ulff0P1xkg60tiZ/Hy0thi2irdLNUN0vm8ScPHsYWXopHH0vG3NWVRbGHXBci77qm1wPCxjzadTlB1WYK7+wYWRzMBMmbpys8/rGDB7GFfDz6WPBJXeMRZ15wJ/LfD0mkE8YvrU5Jp5wBaWiqXz7Yn164GQ+a+bsjX3Kn869ePuiFD5xxB/533zh3oMcW4vHot7fJgsB12y37l66pvrvF4YHOb2POmNhJojld1LA090b6Uo6/1Lz3QpzUljkNlcRkfnmdTOqopho4+bfqLHifD49iw+a9xUKtniBChRqzsVXZSCY9s+vMqjE9NUa8kbpMsSBtS6tLmWzWyKDrKee7FUlL5OPekdSYbHuvBk25B+TshK0Y+Uyn142cGj0ncHO0p9EbVfFUvMv38H5Q8hh354yEuMZ8126j92lg7onSl4dvJo6/Tgmhb6x9QUsfFUWgYnqwcJWDz9hXqdLi48RiL6NSTt8b2LAMN9qSawGPbDwpCqXLbFe+uobpsYp8HF2u7cU3D7Tphb0bowZTQZH3kaoZ27L4dsf4MzNCIPJv+xMHamzhxo3oE2MHZkSAUfr+wndQDpA2t1/cg2vAe5TR42tXVfYlEamcvov35QZHa98R0hskcLRMGwMBknEpDetYlMSIjmrXMnz/DwAAAAAAAAAAAACnH/z+f+rCX0bmf2P+i/NrF/7ypNMDAAAAAAAAAAAAAMdFYWpmJxmJzE5O8oKgczyP0iuCsIRWeCGL0kt8I4uWVjOZJSQu57KrovssWuS734989/uFSZeKtaX1lRVRFJpLfC7bbGQbzUajIa4vZZbRUo4Xch4V7/wg8s4PClGXipUlhPil9cz6spDLrqwvr69lEb/WSC83G+siEpu+KiZcKjIra8Jyoyk2Mqtr2aawst7MCel1XljKLWebYnPJo+I770a+8y5+/z81fzcy/zvzvz7fn78LrQwAAAAAAAAAAAAAxiA5uTMRanthypYctYswaUuO2iyIJiZ3ZkPtCeD3/xPRr0SiX4n8AtQv8B7zy19+8kZs8Y2Vmb/XMw8SP1DU+5wmtWS+zfHCfdvWC9/TdxXVNu9Ii2GzRFJX954uDqlp8Kyxn27nTL9xDJEX7hvnqPARHPZOqVavkTNF5mHhjHEYmdKk4fM9xp9zjHUumfy8bB1LNmIkNgCMw9zmfV2xT1uZorygKyp10Q7hk5I5xnUwmqTDKQLn8O5rlVLZthnnFjKvEps+3os49QPqLjtmj+YYZou9WjfUWym2Tz956wSbuCsQ03XmfUuzYTWt7HOHOs7tkxCzbIzS8QlsXfLPgyG9v5yzq8wvhrxfPdlVMhhiwM5ZPBWXxDYyrYfhQInBch604mLHy6stbOvHLEvazIttFsDdSjHulmpnVu3JutRBjo0ltK8IxgE8d6NwbpgKvQXkCFDNYVRbocynDVNEFUKYkgqlOGQ7GKHIKj9NULoo79PiXAIufbbxNGz30E83aTj5uIraiNckuWWZtjAtCvqGEXqqinAPM+sT25FyG9UYM/RFv0xR922tRuuj2rR5JzGqUPLxLlI1RebbxhDrabjepmsPKmYguwljQ1uS3PK0W/OqrczbbM37IYeVwbZghR+3RY3S45wUHabRFhqp12xMbiMpScuAITbZMrqeOrzMt6wTxT5jzAekqvwGZBHpvLCLO1nSr2yGV2o+LqJ9Sf5QlYtPRx9VSEKb74l22/OmwhrOqVTgBx4SOUmOp6y/lZ4eH6tmBEVED0PFmafiGyFvR4E6vNT2sc0TFJCkhh5ew46uvgNjULsKmGa1UYsXHnkmWXST8gqM0aKMFA4oGHcmEKjI+zzzFneYgPm28gCpCV2VOolRdWq3sUMNBMfVxJNz+L9gu0Q7leoNrla6Vi5scYXiDa5QJNaRuMJ2/XqlWqrf5W6WajcL9eJ1017R+ZnfiMxNTkYmvz//+oX/4fzfOV859/pZZbYy86eTkxN/Aeth4NTzuPj0E7GFuzeijzuG7dyerqhI6yqyyDV6Il5aYWOq6r6xCjKN9Y6Qmvgpt+HcUDpNs7nDZWmjWsZ1w6j215WnH4ktrKxEf/4rhkFbSg3CA5Is+F6buOU2XOsjYhm18jFTyxS265VSuVhlb7Ll+vGZrOry+q6vERVyg4yUXVXRFUFpY+NLqqIh0/YSMfGEpytUGijjT84dylaQZXjLJYBNvy6vEp2BxqnIDZIaQel0eFnk+C4e/3mcKvIsE3Z5uYXoy12kdiTzuUxdxVlwLhh5Edq85m+DykwxERgwGLNipFrttU2zX6bVKfx7MNf4slfFqmGdq6OIqE2rMC4M6iDXB4yGLRlGzEQkGNauhmTEkhmSEN/g5IYxQ+3pyst8G5cl+RPvvWldXsCT1g4v9+xCtSxq+6kjD1mXyW1eEFBXJ5beVdQk9pNS8Z58X1YekEc0krFB7n2kNnhd6nAdSevwurBLxEkvQiqxjm7bqq9U7QgMU3AtbFfUEHn5Df7SFznD+QBJa5s3LPl2Ai2aURK2EWGt1+BbCJub9w9D3WcS6VTGLBeBrPaHGRiiRTwmi42OmWecbon7j1+fsyxgBQTGHRmHJF3LukR3DJftosxYQ/2bT39kmE2rUaN0ZtSg/+aTH326QGxaffXSwCDsE2CUvnuBQ7OPtK9Nq8ONvqZ5/mCbfNT9YWOxKTfcHpYtFGT46kid3zLIZz8og23yOSIhzNxRz0D6iUyVjPW3JFI+G4Snz8UWa8/PHHhsE2t+jW9X0nRFfWSJ+FtPHRZyrnC1zlYHzahqxhJijrFulcr1ChOsh84hv89Lbdy28aSDeb2wtc3WmIRh7TiVTr4yh62g9p5+PLa4XZg54CzvXYG6OanT6QV1FlPGk/MwygZtNA8ppsAFFROnQjFGKMYMxUgaY0dnLqfqTz82vdAqjDHAWAnPBN+b+MmDjzz9aGyhUIj2kyNKaoiWuVGDiZWvY7WNRzeXoK7nkglrue7xjzz94dhCcSX6uDgwbbcmrqbHEt9p70zgBN0T2tt2rNuupyF2YJLCc2T8R/Lx557+UGyBXYk+vhecNrPsfBM3PTpxZvDA1FFdlglOKX7/H/nIs1paAQAAAAAAAAAAAADwfgDs/wMAAAAAAAAAAADA6Qfe/wMAAAAAAAAAAADA6Qfe/wMAAAAAAAAAAADA6QfW/wAAAAAAAAAAAABw+oH1PwAAAAAAAAAAAACcfmD9DwAAAAAAAAAAAACnH7D/BwAAAAAAAAAAAACnH3j/DwAAAAAAAAAAAACnH1j/AwAAAAAAAAAAAMDp5/zsP4nEJvjIdHG2M/vJM1+K3pjgLyyf/5fn/+VJp+yU8LjZj8QWb+dnDkq6KrVaSNWQpkmKzOm8dp9TBKGnqkgWkMbJCtfriryOgiSKVbZQZ5l6tXTtGltlRiua22CvVqoss31rEweslAPDzG2w10plpsZuscU6Uy2UamyisFGp1lPxGlurlSplrl6o3eAqxeJ2tcqWiyxXunlzu17Y2GLjyVcYtrz5durgK7HFnfzMT1dG5VSSNaTqXKvHq+JRM0vrsvJbKtfYan1ofneus2WmXKkz7J1SrV5LzDFW5jPM1WrlpiukxuhzDLNzna2yjH5ZEvNlducyUSmJcwzDMIXyJqNftoKYAs5PSkZF+xK+6qiwrtCKdF7vafk4L+jSPopTd0TURjoSOV5nSjWmvL21Rd2U0UOdE3uI43UjAcIuEnttJHJNRZ1LMpXq0Bzv9VAPcUjWVQlpzJ6d4z0rx4YAlZ29EFneI7lB+XgXyaIkt+JGQgYTMccMFjxdZYwyxzCvVUplb0JxPZM0KnQKjbQrVjX5VpmZNqZUZhJ2+lJxUdK6vC7sGr/4TkNq9ZSeFk/OJQ/RTwrb9euVaql+lyuVXy9slTbN/vJ48+A/iy3U8tGDSUkW0cPAFt54xJn3gkQi/6/ZW0rlTfYOE0LTHDOsdyScekwJKuKNFpcyiy/lalfJp7WDL8UW8vnoN9Z0vtEOHL0CE//XVlfHg0lw9eO2YqaAqbN36qQt4x6QmmPsUH73XL2MKZXrLB5QLAmmeJ0t3ki4hTbY+g7LlpkMaSa5dHotk8strWTXsulcLp0kMdKFEKTVLWRpTftpzRCtgsK3kSYgkZNkHan7fFsL0u0nGiIGq4u4y4nZLpdub7NMlb3KkmZbc/eyhCQmcYvZZLfYOssUC7ViYZMlKbbbR2BCHYkQ6btVLd0sVO8yN9i7Cf8Gh6XwMF+6VnZL2W0gSefDNZAnPHIDWZpLMrV6tVSs3zr48vSCkI9GjM6515Z0xPE9XSG/ucA+thTYzv/jrYO/cSiVmUCV/yESmdJOeooDAMCHhn6pPxFbvBGfeftFn3m+ZkxAxX1eFtDgDH/YtN4nqHcBc5Wh5rjeGYw1qWd3nFl2ZWvT/kGeOWGn/AMzT+98EmumppIKPRXG93ymwmZg38TRiuinHRGiMh1+Crq5zXKFzdcLeA66U6pfr2zXqWmpOQmF9/8AAAAAAAAAAAAAcPoB+38AAAAAAAAAAAAAcPqB9/8AAAAAAAAAAAAA8OF4/z8zEY/EPj/9Z9PXzrQn/yr6T6J7E/HIP5v8k5NO2/uIg6v92dgCy0afnHedccWH91SkdRVZ5ASlh89hasPuTUz5nnX1EyXnXb3HWqnDkT5HHIed0sSHh4UePk5uxDB4WHOTvVrY3qozaft8qTfIlTxjnH01rAsMO/NJSZBQ9rHKrf7M9AKXG3UGku92VWWfb3MdRaRPQLqvT0weLPVjsYVcLtr/srtiXHIBoaP+leESOt5qwCo9B2+N8iI3yDF0XBYv8+02PnmO/3ygqPe1Li+geCre4eUe344nj1oJB2p/Ora4vTbzRPAz1aAiAUldXeMEvssLkv7Ix1KDJTPMTEOAnhFWGqxQxmku6pRWsbJdrideSPoc1rLCmKe0gq0SJHFJFAs1lrHPiildpPI6Po8VN6wrxJk6vpdN51YZdqvGMtn0apYclgp58qrKFtnSrTpXLNwqFEv1u9aB/53+mdjijbWZg7Whpe5vB2SsAg9rAcQu6zFz5rX98fgz/anYwrW16OPtQVsGdqoaj4xzen43JyaCTRh4FfgYL7BEaMsF1rlw5/x58rX+5PTCvbVQJ7DtWDO+lyP/6ed+oh+NLaytRX/1+UHDB5aYf9j/L9jkgd2UccuXRNTpKjqShUfcffRocPQxOnobyS19N+GRTuaXV8lIoaK9HtJ0TpRaSNN9xx9Tg1symV/NkjOJHgU47LWtygYTf+GNN9OXcvyl5r0X4iQquzP5xuLcJUNdW9L0eCq+L6EH8VTcqKZ4Ko5ECV82O6Mx2I2072DeMLKr9dr6oMUHIw0Ddw0zKtgmiffWUCsQhrUCM4jPWOyKjb4/EB91M4R9BDMQfQ7WN0qXwECc9N3wkdLWZ/ziHLROQ0VJ3Qwf41ua1ZSMiMgxWfoeFY9xk2HwdW6fb0uilS58JWnexTGarb1YqNVpEaZQYza2KhvJpJ3CJSKfWVnPLWXXiQasJ/ksDF9QGbRyQj2aSF+hsmA1etoKkHEnoIEPSgw2ykEZn1Y0KBRglMglY1eWWURGWdLVRmWWjAgBmaXDn5oMm2PdkbIcKOXJdqDcYbIeqGyM7BsPA/fwnzzZojh8BVujA22gZrhhmiHLhWdv5Qbe/wMAAAAAAAAAAADAh+P9/+T8m5H578//5/NvnnRqAAAAAAAAAAAAAOCDSHZyauf5SfwmnlvP8AJaWV9urGf47Goa5RpLzca6gJaXco1VobFsffYb+e73s1E7VEPIZrNr6eyakBGyudX1xkpjRcgImWZjKbvaXOXtUO/8IDthh1oTV/HnSqvLy/xStrG2xjdySxlhLbO2ls4ura8KVCj8/n9yvh+Z/535/vyvn3R5AQAAAAAAAAAAAMCpJTm5MxFqi2DSlhy1LRBNTO7MhtoKwO//py/8UWT+f5v/1XltfnP+uQt/dNIFAgAAAAAAAAAAAACHJTU9tTMb7k185LvfT52xpUcttSPv/ODS1NTORLg371EsPmmLN9eWxGZmdWU5t5LONoUcv5xeWm2sZJaXxZWVlZXlSSwetcVza0sovSIsLfMIZVdXEZ/JpNdXl5fS6ys5PtNERHzCFkeCIKyurYloZU3M8g1xfZXPCSvZxtIq4oVGemXKfP8/PX8mMn93/sz8r8+/hL8DgFYGAAAAAAAAAAAAfLjfwE+HfgN/xpYctSUwZUuO3A2wJUdtBDjv/0ftAeD1/8T8b0Xmf+ukKwEAAAAAAAAAAAAAgPBcOrMzOTsb9tuF8/NvRuZi/cjMPzj/H8//6rk/OvubZ//m2blZfvZjsb7xH5Q9AAAAADwDDpb6n6BdmHZV5S0k6B4/pP5XJz7qciToL0Q8Llm3RrgwNcXe/y5M7/TnphfusyP9yPp41qW8yfq56D3zWv9HhjmJFNG+JGCXuJ0OL4tcG4ktpHIZ38sTP9z/bH+BOIl82iK16yvmH/aHXHXrK0Oq1rzT7TXakuBXwbioRd7wIBlQztZt28UvvhDgKNgJ4XEL3JRUTbeLXtN5VedkRZeakp/PwJHSjme/UaLH4ZhY6z8XW3jp+ejjz9IeTDWOV4VdaR9Z3m+1iXk/R6WOHOWaVEtYFzleT9GJ22RrxRQjicnX+h8P45BU21UecPquJN+X5JbTfl2XJy4cLPQ/Rtpa/4bLIalLzD/seV+HpC6Z4/WEjGTSG4KqybnNJNKpzJGHi8er/Y/GFm4Xo48FUrJ0z+8gTeNbiNOUniogjXhglfUhEhPnXE1gtC5cBEOkaKe1tFtJ3EqSr/d/eHpBKga1kGGRZ4bl4ewB1/+h2EKxGH1SJK1liPAwPbOuljNE0rf92PU3VuMxNA4qcfmytYWSHkeuS2ljsBjLgac9xNAt3lVxTnx2q4tEIr/6/p4zGe//343Mv3vSKQEAAAAAAAAAAAAA4LiJTU3OzuL3//jHR6B8AQAAAAAAAAAAAOA0Y9j/fzcy/1vzf3t+f35r/lMX4EsAAAAAAAAAAAAA4NSQmJ7cmQll8y9xxpIcdZw+MWVJjrL5l5qc3JkKZfPvTDz2g1TUkh5lzY9IT1jSo6wEYmn8/T+8/wcAAAAAAAAAAACA0w2s/wEAAAAAAAAAAADg9APn/wEAAAAAAAAAAADg9APv/wEAAAAAAAAAAADgw7H+n77wh5ELfzjPzj83/2vz+vxvnXSaAAAAAAAAAAAAAOCQXD4TmdyZiHz3+6FM/k2b4u/8IJTdvzNu8VHG/6ZM8e+8G8qm36RbfJRRv+glLD5riY+yL4i//z8z/XuRC2+d+51zfzP22vTvQRsDAAAATgGtT08vfGl7IiLJInqo7bUlHXF8T1fIb66rKvuSiFRO7cm61EEcLwhKT9Y5Fe0rAq9LiqxxmTBSn/vG8qdiC9vbE98u6XyjjcKECSPz2WKVLdRZpl7Y2GKZMCGYxByDBZtSG3GSyNTZO3WmXKkz5e2tLabKXmWrbLnI1iwZLSGJSaZSZjbZLbbOMsVCrVjYZFOUlhaSkUq0M6Vynb3GVh2Fxets8UbCR3KDre+wbJlJM4XyJpNLp9cyudzSSnYtm87lMklTP8mOJ422SuNmqcwk4oIioofxVFxo8z0RxZMkvFUKmqB0ka8StwTR1OFlvoXEeCreRaqmyHzb1Cb0VBXJul2m99EjQ6ehao5h/GVKNRIjuV+pMnbC82aiSf7bSG7puwmf8Mn82jIJyxBBrdfQdNVPMJVJ5ZL5+H7mZaL35XjIUOkkKZVrW5UNJv7CG2+mL+X4S817L8STfkk2ynd0mrNh05xJm4kmmkOnOjMs1aS+NJ3X/WvduENqW0VtxGuS3MJtR+l020hHotV80L6kDWnU9n2rKWeCm7KgIl5HIsfrQdooiSt5Jk1C9briiFCUxJU8FYsRqZUhWoEZm+uW0UJxVbuuD2o0AhsFmKcLLD+o0UyoUZa3qqWbhepd5gZ71x4MJDFlNayUqyMm55JMrV4tFevbF6cXpGLQ8IyXMJIi2w2D7+m7iirpEtK4zJCbn+l/hIktFIsTT+NkMB4iOuTWp11D7xBBMuJa960RlyoQetA1xUIMumGHbhwmYMjyGaVwGzD7dbFQq7tECjVmY6uykUx6GvzyktFaVSQoqji0udIipJXbNd3/6I/HFl99aeZpUVelVgupnZ5OHhScrvKyJpE/Wz1eFe0bvK6jTlfXrHqolq7hKAMDMhvs1UqVZbZvbWL5ylVziKiUmQGdczvX2TJJPa68RGVr87IhnGfiXRV1eRWJxihYZncuUwMKajaRoHOazqu4Y6TiAi8LqN0mowpTqQ5o8wTw08l3u22JKGvyEtaUivOdhtTqKT3N1kortcPPJec22GulMlNjt9hinakWSjU2UdioVOspJi6126jFt+3cM06JxZOvMGx5E87/AwAAAAAAAAAAAMDpB87/AwAAAAAAAAAAAMDpB97/AwAAAAAAAAAAAMDpB97/AwAAAAAAAAAAAMCH4/3/1IVfi8z/1/PVC//hwq+ddHoAAAAAAAAAAACADy3bU7HH5y9OTM6iI6Kjh/pL3TYvyVOR77z7+qShdqJ5RNxqJ7ejZnLFI+LWuz1hqhWOiFstfv8/deGPI/P/cL534Y/nXzrpygYAAAAAAAAAAACAI8FOPT4/cdQdhCmi5agbBpNEy1G3B6KbU4/PH3k3AL//vzDxjyLR+IXk+f9n7i/n3pn73Ow3Zw5i3emfPrMy9c+j+xP/KPLTs78diUS+By3w/cVuP459W0VHOE+xfUZpDyRd2OU0hEROknUk65QXlWFSEz++1f/k9AKXC4qqqypvYR8XfBer4dtcRxGxixb/6xMfe/KF/uews6zo1z7u8s8yLBGhEvpjvi5bhgUh7j9MpyAhfbcM6NN5tYV0LeGoMbzztCXs1aiDNI1v+fhzMR31eKXyVGpoL0xeOa+XlqW04aWF5A7v8vlGR/t+cSSDPL9kljPptSWXry3LPc1bmiKPjME30GBkS0YGVpcy2ezRPc282f/s9MLejXH7hVmLwV3CFJh4/qDa/0xs4caN6JNPDG2+ZoBR+n40VKM1pcdprwNObyx3QbZufVdFvBjUNM2aHJQOanpHqrbHfP/TscXt5ZkD1vIQZLZ1Xtd5YbdDBiypg3PVaCPO8IzlI+N1FxRCy5zHc1DZL9QwTzumOEOJM7yKGDsi09/OwYX+p2KLbyzP9D8xJJMqaiIVyQLiRCSoCF88XD59FM0VrtbZquV3alhO5xirPOhc1dg646glzqOYPHOzcCfhvXqJyaSYdJLZuc5WWUaUWkjDotiPkfHjlTlcItP9i0aJzIYqEUk+phKxFZklUirX2Gr92ErEe+VFJuMtCezFiSqJx8/1mdhCYTn6uEhGKv/kC/5Zn1g0M18qb7J3mOCwARlMOP7LUrQzu022Vkw+nuj/uJGyTwSmzMiIX8o+OTJlZokEpMy4m7za/7HphbvLQcO6n96MX3I+8fRh//nYwvJy9KeN2YePkF+4H3EN0z4Svm7g/Ly3jfYBpyk9FTfRoeOyLRQ0HHcVw9dXoNNO677bVecaCWzWSWAmfGoIB5P5Dho5LSBCQXOOpZUVoqmDRInn9EcBnj2p28SHmtThW+ilLnH0aPz9Vhc5P1pS0/77AWp046m48ybU+tHh1fui8sD+LWj72BUb9s5mOFd9CU9gTO+RjUc64oxcBRUwLeLO5MpSdml9PX0E15H0M9/Vee1mkbIbgPOQXe3/6PRC6dNBncjVeejG/1y/1l+MLXz609G375NOQ92k5T7u6iTezkG3KTr9rhZiNiYmz6xmSVmZoQxPoG84fkDf60byvqh272NlIOgme7WwvVVn0vaEyx3APenC6//ps+9E5q9eePv8/3r+R841zr5z0utaAAAAAAAAAAAij7PTczt3Zx6ff+nixCRe8HHNtSWxmVldWc6tpLNNIccvp5dWGyuZ5WVxZWVlZXmvh3qIawqr4gpaz2XX+XR2damRW0L86rK4kkkvN1cy6cxRX4ra/s8v7WeXL+sPdfcXxo+Xz8zt3J14fP7F8ZLdyK6uNBoZtMqLy9nVxjrPr6zlloX19bVmMyOurEWP+hpW4zvoz/7xb+C9CJ9UZ6fmdu7Ojl3Yo1J91EQLSrst4aX+Jf2B4pfsyUO1kfcu2YrsV9r5qJHswnjJXmo2G6titplBa+vZhpBdF7K59TU+21xtNpYyGXTUd+xdFV1SURvxGrokSlqX14VdJPqkf23CSP/KeOlfbjSWRH59aSUtpLOra7nc2vpyTuTT2dxqLtcQl4/6dp9Ov8Y3fUoef/8/feFjkfl789+dP3vhH1xoXvgYjLUAAAAAAAAAAAAfDm6f2bk7M3GMO0zT1TM7dycmjnPz5wxO5OxxqpwaO9ujNE6OrXHUfkb0FtY4e4w7DMb6/55x/v/e/EsX/hhsAAIAAAAAAAAAAAAnceZ++ljO3J85Fi2n7/y/sf7/k8j8b8//V/MP5kvzixf+BNo5AAAAAAAAAAAA8IHm0tTOZLjX8ZHvvDs9lvSZsaSnxpKeHEs6mpramQz3iUDkO+/i8/+Rj5x0xQAAAAAAAAAAAAAA8CzB7/9h/Q8AAAAAAAAAAAAApxt4/w8AAAAAAAAAAAAApx94/w8AAAAAAAAAAAAApx94/w8AAAAAAAAAAAAApx94/w8AAAAAAAAAAAAApx94/w8AAAAAAAAAAAAApx94/w8AAAAAAAAAAAAAp5/zZ6YiFyL/OhL95NTPX8ic/5/O/fK5xOx/M8vO/KvYP57+L8/cnbwR+deRDzQH2f5KbPHB9kw/rqtSq4VUDWmapMhcV1X2JRGpnPZA0oVdTkNI5CRZR7KucVKn09P5Rhtxva7I6yhMoGKVLdRZpl4tXbvGVplDxTO3wV6tVFlm+9Ym1lUph1Izt8FeK5WZGrvFFutMtVCqsYnCRqVaTzFxMzxjhWeM8AwOzxjhGUlj7ITEk68wbHnz4FI/EVt4441o/yVyOTAZSk8VEKeiNuKxTDixCcYqrMLGFsuEDMUk5hiG13XU6eqcJDJ19k6duVUt3SxU7zI32LtMlb3KVtlyka0NLzYVab22riUcXcnUHMOoSFBUEYkcrzOlcp3FtViu1Jny9tYWU7zOFm8kaJEreSadnEsytXq1VKwfFPvZ2OKX35jp50Y1NHeuqDYgojYa0tbc4cI2txGxWS1uk91iR7Q4t6ZDNTqigjFV+LU7pZ+MLTyeeCMakWQRPdT22pKOOL6nK+Q3FzabmbAt8WIkEtk+/mGn2F8+amsYMfIcc2sYe/x5L1rDwWJ/KbbYuTHTnx1RjDqvtpAevjOZ8iGLLUh7+M5jajhMMRlBA4onc9jiGd66jlo847amZ1I8Yj89vfDg9qihBAfS8R98T99VVEl/xKmoIcmixi2NlplIiv2XjhhNJkQ0iScP+5djC7dvR7921/VEDg4TQmvc9zkcHMD3EWw/I6nnr6PCENYS5kO2qypNqY2GBjZl6DBGlbtDGI9k+2apzCTigiKih/FUXGjzPRHFkyR8U1U6XAvJSCVpCnq4e8XIAx6H15UQod1C+YFIX2Qyh55l4HDURIeauKSc8kxZJZFyJYUE3i6Xbm+zo8J5kuxMbpT+pUM9lY2+GeKp7BGc+NxBop8y5p+fHTr/9AQMq/+zoeafnlDHMf80B7pjnXru9l+cXvjS9thTJmoqPGS+RElNfLp/o/9CbGF7O/r0wfBlARUqlOZPhVsQUEGObTVgLqK8VaL3VHlwlDLqoo3klr6bMEWSzAZb32HZMpNhCuVNZiltDhv4tqbzek/z1ULfNwevThdPK8R4Ko5Tpaq9rvGryUtt8/ItVWmpSNPMse1ILQe+/wcAAAAAAAAAAACA0w98/w8AAAAAAAAAAAAApx94/w8AAAAAAAAAAAAApx94/w8AAAAAAAAAAAAApx9Y/wMAAAAAAAAAAADA6ef81L+JnJ3YjEz+dxe+d/5b50pno7P/fObvTH/qzGyUmdg81z3p9H0QeHyn/xOxxRuZmYNXTSPMsqJLTUkw7N/uKj1VM81Fc60er4qDtz1mlkeEHzQ6PRhgmCFlWpoh0ozAy7KiMw3EGBGJpgXl/oX+qyRvT18Mzpth6/nweaPDD1qM9snbznW2zJTZncuaJLfaSFdk5mKeqWxtOhfmGKZSJTL7SCVmo00J86dzX1ARrxu2MU0R54ojpaJ9iVZj/36RyThSRk6Irs8TMefCsAqR5H2+LYmMT8XoKi9rEr5gmfzO9leP5M9ihI+BY/NnMbZ3gWfrzyISifz4kE588PH+FdLQbXv9Pg1VkjWk6odv6HR4q2BK5RpbrQ9r6OydUq1eS5iFkWGuVis3fYSZnetslWXsHpDPJMccBPi2injxEYMeSpqumeX2NNLPxxYymejXk6Q4ByMevDLxosuYr09aselep/NaZmtp472G5VpHJm9az7a6c4CpW+u2JW7300DTuOZ9twXfXDq9lsnlllaya9l0Lmfo0nRe1bmOJPd0FKTPJWPpTBOdmexyjuhBsjhCCyUxqIP8QUlczLtSZlgeljqI+6Iio2HWi4uFWj3hSBZqzMZWZSM5YM14ZYXopAbKgGRTErbVcmpIDAhFSVzJU7FQrlVe6H8+tqjdnukvesa8ITb1g0a84CAB490YcQSPdsFKwox1VmjGDs0YoX2dQrzQf+UIpeX2C/FsSmuUd4j3srSK/ZfDOWrx2rIfz9PIuI5aRsU2rueRIzlqMV1sDHPUUuznjlqMYTySHF8xHs5DybMuxmx/fYzZnWW8f6zZnRlonNldUDxjzu5MNYee3RnhA8pt7UjlFsLL27GU26G8vD27csPn/yfmfzcy/7vv4YIZAAAAAAAAAAAAAIBj4XMTs5HZ2Wh0eXIyeudMotBBqiTwL93qIVVXuKokKJHvvBv5zrvG+v/PI/N/DgUPAAAAAAAAAAAAAKeG8xOxyOzM7OSks/4/GxEiF145P3dWnNNjfxDrxabP/NOpg8k7EeFYYny6178RW7z7/Mw3HpifZnRVpSm1EScoInrI8YKg9GSdu48eub4EN6W831uEC+z9wOKq/WEEhzq81E4NBMcfYVhRGt/dJvAX3e5gTKlGvlxMXsyTu4NaLAHjm3D8mStDPgT30WN9BYm/sQyIyhQhWrBYW3mA1ISuSh2fxCWTF/OUwGCsyaStKDDx5Pt37405hjmZDB09PzjG4DwN+aDGbAtMEQdkzIAM1trpaToj7PJyCzEPJH2XkXSNkUQk65L+yPoe6XP910ij7/MjGz39VfjYjX74J+XH2aAPX1b4QqfLy498S+pKvxRb/NLdmf5y+K9V95dzh/i+Fwcb/6tVv7gO850vVnS0r1f3l3O+375d6V8/YgmG/eb3OErw8N/+PrMSbPevTS985W40IskieqjttSUd4egV8psLmcWlcHIT6Xb/6jFElwkZ3UtPz/XZ2MLdu9Gv7ZFMhwsXUvtl10mPcIHIU4TXddTp6pwkeo4oVNmrbJUtF9maXZGcKawlJJEcKrDGw2GBrbGPCmN8Gel3IsK+WSoziTgZBeOpuNDmeyKKp+Ii2pfkeJLoaapKh2shGalGIws41eAVsw9E6EqI0G6h/ECkL9rHWwRFFYcer6BF7ERQJ20STk2knHJNWSWSciWFBN4ul25vs6PCeZLsnOZ43O5vxhZruZmDHXO8wppkUtHkocR1lbYkPHKdefQX8YxFIfQMjtz+gYaNM3YIxniGGiGCz1B+ql8k+X1aHJ5fegJ7lPwOP08ZkN/TeqYyoLIGz1Ve6m+QWurfHV5L9IzrKLU0fOY2rJZ8DwT6BxjzUGBAYfkeDOwX+oXYQi4XfXuRPFb8E+B/dSLlemwEpP09OySIZJwBMfg0nnWbSaRTmeSxHyw8uZN14P8PAAAAAAAAAAAAAE4/YP8fAAAAAAAAAAAAAE4/sP4HAAAAAAAAAAAAgNPP+bO/F5mauBY58++n/tnk5Ylr53onnaIPJH2hX4kt3nx+5u2W5wiudZR64CCkcT/Im0RQsLnC1TpbdZs1sE5COmdoKQ95zv2LefMEvfnbOAeEj/MZyoKilpA2xzA1tk7FlXerxqdRGIY6NZ63DicVCzUWn0EqM92Ak+dMnSQV/8Vu1VjaIoA3SDKJzx2RuFyQ80/WcU+ma5556l4eSCc5NuM6NEkEqANljHVgyiwMU4UkvjKHjzx9sl8m1fx0e2Q1G8e7xq5mI5hZzc5xMLtirUozb5XK9cqwmks4GaEPaVJVlaJKA9tTMCvOyHXKr56fQZ0ait0nB+fGqFhSOwfx/s3Y4v3tmf4ngnzADJY3fVZypLg02u3Q8BhC+H3x637j+H2xrC84Z999Drz/dLO/RYrqFxbCFxV9YPHZFNXwI5GhisoY+Cp165AkaVjuk5JWX2LwuGZ3eKtROR2GnNfTnPa6v5yzmh25YA5EWMqIxmrDlsDFvHmSHB9lpdNj4E6V08wpEarBk4RYQz2Os3tZ03kd5eOa1JKJ68y4a2g0ZEbYYHELD1j/IPl1G00xMCyvOP8SGyyeUvfNo5EYtScTv4OWahXtK4Z/SI2xytXKvUpl3FUKVAZw9I6cc+g8T5e3nRpSKgLSNPpE/ZCxJiDSpF8CSP78mokjZWVeE5QuIqKuKx75hGrVs+E2TJJbpD2pl4WeqiLc/AettbhyHSR80Vu7dKUmyfHrSt1s2i7TMXazJhZ8DF+SXlX5tWWqaWi9hqarXqFUJpVL5uP7mZeJvpfjIUKkkyRV17YqG0z8hTfeTF/K8Zea916IG4mvVH2Ta9hxGJ7ebJj0ZtJmgonGUCnODEtx8ohju6ggDftXZTo89vaF7euYoWy3t1PD3N4CAPDhhdj/n3kuMvPcSacEAAAAAICT5Web/duxxZ34zN+ybGEFb1ju9VDP3N0y/kSyrgbv/gxVMLjn41Lpt7kzZGvntUrJsYDKdIk9VJ/l/BZ7tW7IhtlgYrq8sdAsM12e2izK4w0kYxuFd1ae7t2juSGbTXPBuyhH2EMJu4MSuH/it1UyGMovs76bHV0+YK/jOHY6gvc5uvzgNodjO9gq54Q3dfl4F6maIvNtY+tg+OaW3XrMMHYF4fc2ktzSmIZnZ6vh234aQ5oPXVyOHKfvYvtsdu16LprSZtnygi7tI2vjwjShbNh2Hsx/h5f5FhLjIff3jq8ISGINY5xmgrERTp0XdnGrSPql3rNTa9rsfH+n3KcRerNB7111ae3Otm/K+lvp6fGhZULt2w3bPg69dRy0bezucL6dJ6gG/MZcY8ilS99/6OVDbBUbiXanb9iuuEsyP/RNlrM7HrJdjlGfybmjbhVKxkahOUCa24Nk/R/7F5HYv4A5FwAAAACcAr51sV+NLQprM7/idQvh9+GFjlQ8XVVk2w+JMWWh7ozzEZNHna9nksEIKCPkzlcYA55lYP0P639Y/8P6H9b/sP6H9f9xrP+/F4l976SnKwAAAAAAjMu3sv1abBE9P/MreyMX+8ZrKY68enCd5gi/wB9UMehwl9xMmZJ6T5V9z6iR76XdryYtx1+eoNQ+QHLkRoDrNMUxveE3jkQNvON3OVWl3/L7nFN6z97y+0R7bO/5vRmGN/3jvSym2lFjaDMa+bbfFeaD977fVRCHeOPvLbL39p3/4VPv89Z/MCtHeu/vo+5Uvvmn6oAPMfydwNv/oW30/fL+/y8isb+AORcAAAAAnF6+NdevxxaF+MyvfHzkToHOa/d9zT7gG+F3CwbUBNt2IIqpzwB0Xu9pzs4AvP+H7//h+3/4/h++/4fv/+H7/+NY/8e+ETkT+Xok9kdncrFvR//vyNdPaFry5M3+3dgienXma5/2TktEpUu+JOwqbUl4xNm713gmYVrX8pcdcgoxhM6gNxq+FvcGY3ZPYlA+jmRsgMt3b3XIu4vRrxISQ4zdHGnj8Ng2DYM2C12vdEJucFnlzBg1x6horyepSLPaNdUDrJZvNvUnr/XvkBb21S+N1cJchvyOqYWZVv4Cp8HQmt73relm//XYwquvRr8WJ4b1Amsu8MbEmtV0ChtblPlNrxx5SWCno87eqTO3qqWbhepd5gZ7lyleZ4s3EvZ90tONfpuyhoIksXtJjVtESZW9ylbZcpGt2SNOwjSRaQwaRMoudSMeajixxrNUXJQ0408jIhXtS6R0S+U6i/uER4d9f4Ot77BsmcmQKs2l02uZXG5pJbuWTedyGaLLMQcZpI2SuJJn0iSUY9AzKBQlcSVPxUKCGyKGITG/wZsqSbrNmQbI7DB2sfgFMgMk55JMrV4tFeuRSGSWPAmr/Z3pBfRqNCLJInqo7bUlHeHFtEJ+c4HthMsEN7X1b32sv22s+pPhVv1+djEPseofZvzSeKD2NFj/w/l/OP8P5//h/D+c/4fz/+/9+//IR05ozQ8AAAAAAAAAAAAAwHvCHP4frP8BAAAAAAAAAAAA4FSD3/+fm/jFyIUfnP9b594525j93Zl/N7M3/bfPFCf/VfSHJn4xUp/7Tyedxg8hD/ootvB4Vgj/EeiASR9s1qQj6b6fhQYKT1zpl/pibEEQok93Ar5rDgw8Tjz5Ed8+B4a0voZ2fcpMfw8d8Fkz/sh0k91i6yz2X18sbLL4S9+mqnRoJ9ABXwt7xawPl9N+Hy4bnyDrSgi9LqG8J5YXjS+gfSRHfThtf1N8wPeF2OL9ysyTj3rdvAfYvOGsj7M9bt6DTOQE+XgPp977RTBloCsoQudYjaXqYr6ytWn/ejFjmQ9zPvH+PBZwfg77jsqKlzHjZcx4nY/aJY2R5H2+LYnmJ1QH9/qN2KJWmXkyGbaQJRHJOjGU3un0XN3s2Ap6MAqfz6/tI3Qp67ux1KA5qRTplUbJhaqhwxSvlVxSvFaKzQLul/p8bLFTmXnKhy1g5yv0Z9OMPfqDD/KMasdhbdmP9hvncTM04IHeIzPKiNjwzw0D69E+WGN/dtiRNOKb3KzMx5H+T8UW8s9HH2eMR5uZS3vIN89iWNcnPm/WTam8yd5hgsTniL0+627CeUCkqPMhm2ytmJLE5GOuz8UW7lWiB8/TaQiuLNPe4Ui5iVf8EjtSryvxwdL2IZ+UU/1Jp224zL31p/tvxha54syTXtBhN4GXRYmczvAf8wcFR551C1IZPM77RDJ6hMflZYzxbV7TOaWhIXXfGem9Fz3iwi4vtzzSzrWxTo3ZiR72eGD792KLreJM//7omgh+MBypNsI8DIY9AZqSqumcKGmCso9UozONqMTDFeOwx8Bjpf+TsYVaMXpQc/Van9i5LjK6TLDIxMu+XXWIMncv9RF0+qe3BRojz2DBOr1XaPNSh7PMnZgxxg+u9N+ILd59daavjDiyOqILj3lYdezeO3jo+ZnMzoKPbQb2vh/tfyG2yL860x91rDxE1xuzFMfqddRjamgBH6J0hnUqeP8PAAAAAAAAAAAAAKcfWP8DAAAAAAAAAAAAwIdj/T99YTYyf3f+zPyvX/i7F+5dMKwQAwAAAAAAAAAAAKeT2pmdyZ0JXhB0judRekUQltAKL2RReolvZNHSaiazhMTlXHZVjHz3+/hTc249wwtoZX25sZ7hs6tplGssNRvrAlpeyjVWhcbyNKVzZQkhfmk9s74s5LIr68vra1nErzXSy83GuojEZuSdHxCdDSGbza6ls2tCRsjmVtcbK40VISNkmo2l7GpzlT9zCJ1r4mpuKbu+urzML2Uba2t8I7eUEdYya2vp7NL6qjBF6cysrAnLjabYyKyuZZvCynozJ6TXeWEpt5xtis2lyHfeJTqRIAira2siWlkTs3xDXF/lc8JKtrG0inihkV6ZPITO3NoSLvilZR6h7Ooq4jOZ9Prq8lJ6fSXHZ5ooWsU6Z8fS2VxbEpuZ1ZXl3Eo62xRy/HJ6abWxklleFldWVlaWwf4/AAAAAAAAAAAAAJx+4Pt/AAAAAAAAAAAAADj9wPt/AAAAAAAAAAAAADj9wPt/AAAAAAAAAAAAAPhwvP+fjbwZib59LnL222c/N3dx9nNTfzr5v0TePA7tTz7Tl2OLezszXz3r8b4otPmeiLAXXwGbKWjzPVnY5SRZR7JuX3X5shwWIsgjY/hYgj04D43X8Hc5woOzV4XlG1lCGsPbHkD5y5a/X01Quoi4ZXZdsb0485cd98aW92bzp1smpKdnJwzxIXwxH1dRG/EaEuPDvUAXSb4YM1+MUTSMUTSMoMjNtiToGvNA0neZtrTvSNreoS0vna/2m7HFnjDTzwR66TTz2EIyUnnjElI7ks7JCmd4Dw0fZrQHz9GxhfGKGhj/UN/aRijGCcWoSruNPe8yRnA/R54HF/ud2KK0M9M/P05XGyi8Y+9mIQpseBc7bAP0KaSvZfttMh797ItjjkdGPT7r8ciJ5Ujjkauf84Kg9GSdu48eMaUaU97e2jIcYreR3NJ3E0HCyYv5tawhqfUamq4GSqYyqUw6eTEf38+8bKTu5XjIgJkkc22rssHEX3jjzfSlHH+pee8FM2y5Ug8cWM2i0piuPXx2LwcPht3L9lhv9ymXrHOZCkMGQ6ZUZhJxTWrJSOQkOZ6y/lZ6ejxpS7sTixlIsJF7a0S3SkFF+4pAYtYY1QxqZEgdMcpbUTty4TLnCkcSlY8btRb33A/zPLKkE6pRXtazA3uvxrWoXhZ6qoqbt387tAgSvZgPbJ8kdPIITygV7fUkFWmMGa9dSwPPp8cP+vdjC62d6MErLtfjQ/siZ0qFEp7YNIeM7XLp9rbXK3moeNz+yYcGSVhStAty5xqpn0qd1NHBRP8tI+uVMbJuddBQWS/6emIPFcE4eXb6T2qwa6Q0nW8R99t+btrf6kvTC1/eiUaMIthrSzrC0ziF/ObCJXkpXGlsvNXfPXpkmXCR/cRX/0a/FVvY2Yn+zLbL5/nQYOF0v2o9BAsbW07rGhqGwaOn+TiURKbO3qnbDdHqGcXrbPFGwnx42bLJ/PJqMjXHMIO151HjCu9T18wGW99h2TKTIQPbUjpt6TVbj0dflb3KVtlyka3Zj6WEJLrCUDO5UrnO4hmBJzk+klYy0iQZuXR6LZPLLa1k17LpXC5D9LuGY99suiXIs6zDy7ilx1PxLlI1Rebb8aS75OiR2k8pGXi9BUiPzMbEwXgwmFOA4HmDd9oQIlgmSZLkO3MgWaGGMpIBqo6sQdmqIxXtS9qQmrHvu5uFb33YY0iQMkfgSp4x2pUxNx4WiJK4knfiIKFvVUs3C9W7zA32rruuU+7RztvI55JMrV4tFevw/h8AAAAAAAAAAAAATj+w/gcAAAAAAAAAAACA0w+s/wEAAAAAAAAAAADgw3H+/0wkHjn/+2f/x7mz0+lI3Ffsm2f6WmyRe37mFz8xxgFtcpLVOhRziCPXrpOw1rHhq9ZpPvqwTKVsH75xHYH1yF3MV7Y2fa4bRxjnGNcZzkOd5XdO81OnN3Gk9qlN9wl+6symf9JcoQbP5+MTkOT05Ngp95y8kqjES0MTL42VeDN5RsKGHZG1kmmdSrKPyjYkWZTklsY0zHCvVUr2mT+N0cgJQHz6t3HZOffjOkqrDeaH5KRBn/HlBV3aR/FUXEQ6L+ziA6zWEVP6lK+VeHdWgjITwhSAeabfVmQeZyYXA+vBPqVsiDVVpRO6KXnC6orPwWH/kEZJmAd+bW04iHH2F0dL/rLv2TXvFY23lZaEy4DUrXPyOOg49dFazNjtJkzrIdeNg1X7y7l8XFBE9JDOiZWbBn3SmgiN0frcJe/85bTNEUegieENM4PYKIeOjUkgVWM6PQ2fgSYjCdNATUVFjHnMjrY9Iezycgtp5knor+701dji3ednfqY46kGAD8orPf1wTwFX4MFHgFFyvqP+4LF9fFQ/FVdRR9lHYjxptDBL0ngkGIHCPwVGNbnQTe04BiizQ1Kdy8or6X/+7TSgZSaNFmX0XD+NONgH8Sl57Hl6r56fz6J72/YNGCSLVtfur/b3YovS8zNP99xdWwts7pyK8F8uwygBXTykEt/Znt14h59qpUwBhDTMNLwbG5VJd9nx+ubQejNCMFYKrLPcjJkCo/oaiFGRLqlItGrQqmmjzMyae/LJfje2+MbzM1+9NmpQlkQk65L+6HCjsjv0kLpCHV5qB87KaRnT1ITZ/uk77l55mAoMOQof+jF/pIf78fdqq3Y8j+wnn+grM4uPJyszb0ue5hHYJd2WiYxku80fBZZ8QFs6RFRDHvsjU+E7H3CK36oKPB+YYwJnBOat4302eIYTV1M8vDEba7wQeFlA7bYzYtgjjNWcjJybjQOv/2cmUpELV86Jsb8Xuzl9/cwXJm9OpN7zjYgPAE+e738ptvjg9szbXx5uPcx+vNrGWkh7Hm5pjZojhbMeNjwWn85jN7TUQD8KTounI+XjDaUnm3OmYSa6nGGXGmFNS1aeObDvKEtZpLLvj7B5qI1h83CcjubMlqwuZD+kJa3D63ZnejLb/6LRQLYP10AkWUOq/qwbiBFLaAtz0BgO1Rgev9V/FFvgb0cPLg0znEWV7giDYZTkxGthTGb5qB5qL4uST3gHixBmwh7GFjq3R5gJo5OE5zj2jDJEnktjWEgLjCd0AXQlkROVDi/Jqa6x2hA4TedVnSoJ7zpT7D+YXnhwe0zLXXRaMyHK4frXU/392MLt29GfKwyz2UWFCaH1WhhrXfQ6Hg/5YGzrsMa2Qlqowo11k91i6yxTY43IiKku3PkCLIlJInPFNBqG//583t9WldO+fW18UbeNqTOvPiDmL9uS3HvoWAwzO8UwG2vFQq2eoEQLNWZjq7KR9FpayyytW1a0dH9rZtRUXmjzUocUrDEfSVF2J62/8eT+2G18qUhQVHGowS5axLbzZSWJDmeJU3cMw5jEHCZ1+UqejpfoM8IaRUINQcn8gD4zcUZRUAV50Z7LYUutvqP68dgY67/e78UWe8/PvP3ZUdsTPdkYqJsSErmu0paER5woaXiUG3evYoiqucLVOls9+r4FrincUHw2L6hCNGaac4wV32CKceLwVBvPoeuUpcE86e9mFZtpF+Mpq7nmrT9ezOB6om3J5W8W7lCG41I4A85P5xHmmVSbWx6+OxpmMpBspOKVObxleKWvxxb3np95+ijM2wBjL/6I9RqoaKBWR70kyNMvCOyKtPoGde8U1yBe/0c+ctIrawAAAAAAAAAAAAAAniVw/h8AAAAAAAAAAAAATj+w/gcAAAAAAAAAAACA0w+s/wEAAAAAAAAAAADg9IPP/09P/f3IhT87+2/PfnPuzdn01N+f+NrE1LQ+rZ902gAAAPz4mv60FVu8f3vmW2um5RnTCi7X6emGfwXH/KFhLFkzDR8aVhBHi3sM0oypf9C84mgFpn0a26omM2hW0wms66jT1TWmYxk6tm+hZhMJOoewBRhZQAyxgYMumyGwpZiOZScGXb4vyfg3/sdSZJnLYbrEeA622tm57CSWspmM9RCzM45uotYtHmSv04iV3MV/mAmyks2JUgtpOrntuUZpoEyCmdkmRsaIZTC+05BaPaWnmXby3SZLmURAyapIU9o9/KfGqGZGVW/pORq7lL15yp5818ecO8mLx1eHrcfydEGXXYiglPMXytWGO2ujW55plZ+2zO/XXFz2+n1qlbbCP1i3fOi6pfUM+ifxLwbLIcYIq+uGqWyrJChznkZJMLu8xsgKgx7ygs50VSQiXImKalr1PHjhaTO2qN2e6S+OMe508M1GG3EiaiMdPZOxxxOHNf6Y1gPDjT9HKjlJY+xEOKWFjlBahr2rZ1ta/taST6S0xKfiMPOhIbKVGS0z0Xj68KlAzId+4y6JfXSYEFq/4DIfGmLAwWMV9dRwm3ukrGEOPPCwWUzT+KQ59AQHtp5kVhgyFPlZliQ3TFv9JOmXiX8i/BBxfht+ZFwClwxz66adSc9QNswopkc0mV/NGs8/jwoc+tpWZYOJv/DGm+lLOf5S894LcRKbZxgMskbpEbuSN2yDei5/3tfYpWvsDYrAPUB79L54GKuZVhqpS5/P+yaQtk3ptKaUJxGOKcqD808/GVvkbswcfMkakHq6oiKtq8gi1+iJLaTjCQBS90lIaqQYIegdg8Kq9Rl5hgcdOuw4QRkjKEMF9RtzwP4fAAAAAAAAAAAAAJx+4Pt/AAAAAAAAAAAAAPjwrP/n/+lJpwQAAAAAAAAAAAAAgGcFvP8HAAAAAAAAAAAAgNMPPv8/Ma9F5rWTTgkAAAAAAAAAAAAAnCoez03MR3ae37708Ujk488vzs5MathMcEPIZrNr6eyakBGyudX1xkpjRcgImWZjKbvaXOW7qqIrgtLOZtOES+R/+MeldeunybKgdDq8LHJ8t6sq+3xbR5quyAKxYfgy32735Puy8kCOvPMDvP6fnP7NyIWLZ1vTv3nuN879xuT/gf876UICAAAAgNB8/bm3L8QW767N/FzctO6LH3+SiFROknVsfNw0vivrSNYdG7y+Uh6DvuE0ea35XmWIBLZhrCO1I8l8Gzso0IlLBl+Vjg8IbCHbsOhf2do0nAzk410ki5LcijsODdgd655h+VdDXFdFXV5FoiOFNQSlpFQjZphdGofJmmabXbrtqE2z1X46/WSG6kIPu0jQkcipaF/SiAXqYWoHxPOGNuOHJ4yPxIuZOcOLQKXqV/JDSvcY6gCbHieOJ7ADiVRcREJbksmfhoVxJNJOLIJrKB9HD7vSQLxhyj5sHfnIXTQL0nVxvFoKuh2y3hwZuzywqXGf9mIY/DfMjGM1IuJFXNYcj1M8wn+E1WUZqssyVoxGX9f9zGw/XX37PBmZvt4aOjLpKi9rErF3T7zIHH5k8moaHJnGGYeGF77jviThM1S5u4jd1D3dJDWq+afslm2KEhctnLmUiSeN7lGputIwGM/Q1DxQJV1H8rNOjBVNQFqOGvGINiy126jFtxn/tmw3G7Pl9t94+1xskVubefvFoS2Xcvhz9MeqjzKf9os03AKxvX/HF0Rq0OtOSlBkGRHNWIB4I9jrIQ17CuD0R12Uon7LvU4DqfQVHT3UUx2k7yqifdkY4IiHhF0V8SLWq/dUol/SUQf/a6298d/YvUSq0VaE+5LcSomS1m3zj7i3NEW2VJIBKUWPRYEdc9zhyXE9EmD/f2Lyzcjkm2fqM38Fc00AOD7+ix97shpbvJuc+busOXhagxbaR7Ku2T59KJdf+GHtlvIMmeFUDPqfc4fz+pobdDVnymuMFugWTnM7ADNch2mWUzhngLYnYHQAw3GcmXpKxvJiFuhBzR4W/VyhOT7Q/MJfGR7eSAAelzn0UMcDaMJwUYYXeWS4jn/mckMRH13Gz414Mh/vaUjlOkjT+BYyptzebGCcInYI49fPwfK3N+BXz1PIbu9phoc9Y2JhCl7WkIwnD/ZPHSHVXFt4A0si6nQVHcnCI+4+epQPUzCa0lMFVBIDVA7119fttiVfz31eLWSWIqhSlwTXe5pnYTxEvoln6tIXkZhP+4i6cugKZ670rbya7Rbn068dH1Kr1TKv2Q0znsx7FGJGteIjRF20J0s+dYjBayo6etfs6mhFqmM3e375DdPwzOBHSQGe6h0+AUboo8SvdPC6QCzu8lgUqdrhE+OjyidlxUphi60V2UT4StJ1Xtjt4CdIPJmKv3HPP4n+ioNqblAnpZL+23Z1OWwo3euhHuKQrKsS0pg9n2F0jxo1Rw+ie/h5duShb48e+vAKgNeFXTxghR/39sYc9/YOOe7tPZNxb+/kxr29Ex/39k583Ns74XFv7/0/7u29T8e95Dgebs2hjCHxWY44qT2AjqR18NDjWv9/OzL5bVj3AcD7gF+SnlRji7XPzvy3yNw0eKCo97kOwjuTQct9SsS7XxAi9OBmAa1vqFv6OcazW1CoOaMNZ14d8CzvEjKvmr5P3Rfx3GtAnXvXYYu9WjfUW9M4+xntzS6eEBaIW2DzvqXZ2K4v+9yhp4qDCbGf/MTl+2Bg65J/Hgzp/eWcvXfiF0PQXsqgLDXDxHu/+yieiksi3uslgZzXYO6qHJxC22lTe7IudZBdkCraVwTDD627Dp0bpkJvfhwBegtoRNU6ZTtUEbU/NNiABjeBQikOWW0jFFnlpwlKF+V9GohLIHD/yFe3/VapjXjNswSoVP3DCD1VxfMQqz7vo0eul6Rjh77olynqvmcS47zDtrKXGFUoeImjaorMt433ZZ6GG7BryVmB7CaM3Y5LcsvTbs2rtjJvszXvhxwFBtuCFX7cFjVKD2e/eBqm0RYaqddsTOawYU04k9S+6uh66vAy37JfsQ6OMR+QqvIbRUWEp+q4kyX9ymZ4pebjItqX5A9Vufh09FGFJLT5nujZRB8czqlUaFJLRiIn4ff15t9KT4+PVTOCIqKHoeLMU/GNkLejQB1eag98RBMckKSGHl7Djq6+A2NQuwqYFeGvAoRHnjkR3aS8AmO0KCOFAwrGnQkEKvI+z7zFHSZgvq08QGpCV6VOYlSd2m3sUAPBcTXxoVsB8Z1K9QZ3k725wVa5wnb9eqVaqt/lbpZqNwv14nV6/X/2M5GznznpZQ8AAAAAAAAAvD/4+p0ntdhiPj7z8zv0hrz5pRanKj0dUbvw1hdcftvwPmEC9t4tLb6b75cuMUVFJi8XmQzDyyKzxDQUfZcxvx5ninghybSVB4yuMPouYtBDLLvVk/mXOvxDRu912+iyoem61NolOnptXeUZYZeXW0hkOoqI2uS6votU1FRUxKh48SMz+0jFa5tLTSQLSLzs8zaAZEHntftkZYkPVpANenyZXHlA8ok3t/XLRJYs8uhNfCKmke8WrT1wLIhUa2VFBaFfVuBgHRysYym2w3KSaH2F5ixcsXZ7+123osJJt8R1P0X29oZOfQLh+SLCvN9Vlbfwh27mfecnpaOrIg3p5n38p3m9yWvGVfxHmK8onfsj4tQC4tRIVByS8UfiYkDc/hso9G6PpR5/JkHaaf6B94qzbHaSkI+3lQeGtmSY1xXmz4BPKHELsj6jdN4S2XLO+QlDVCWtTb1sdVLcOvBHkK43GprnG0zcfoyCMT62zDtfVj6Q8Ht212JfG/EFpM/3PyQYnSjXhn2ILYBCvc7evFXnqpXtOuu7/o/+fiT6+5H//aTHWQB4BvzyJ57UY4vb8Zn/vvD/s/fmwXFc6YFnFgpAASBZKfeFlmG1ktXuLpRUIPM+0ILUIFiiYEKAhKMhWqbLL1++BLJZyCpWZoFkyxw3SAp92J7ptjd27Al717uzDo2XtiWPZn2NJzw7s7HbrT8cjnBHt8fe2eE4Nna9a2+sZybCI3vWno28qrKqsg7waErU9wsGE5Xve/f3Xr77uQmf734T6sN8yo82pd73sw5z6t/VOfWk9sRdTq37n77h5hp6eND/iz7MtHabvdbrob6jMO0P0/4w7Q/T/t0zWjDtD9P+MO0P0/4w7f9+mvaP+vyLS0trW6ub/ef/0xN/SZ34y2Mfgf3/AAAAAAA8utz63lvbmZmtJya+9GJ8SDgag2sO7bYP6Ua7l5JGgwdY7XH6WsJpVeEuJN+jYJA4YYA4Nskan+xC/edQUeKIZzhIGp/G9E8qjI2GxpumuIKsveB4srZN7PWGbbfWgcenAsMJyI54nlxoeZl4jkvzXLST8ZXXfeYgh24cv7S+9vzySqnVSI4ax9FhfT9863O+dnx1K64dzeXTyVkcpXmSdgyw2q0d7QeahXO3xXisi8GEaTE+W1vsmGGNnfpz97qUMGcfKFK7+nSp1j1pkXe4Ha7uk7q3/+hywz/wrqdmhSkV1yjLaM0rR8nnmXdMhMdmn1spe7I5Ut82NR1Y9+fJw/fxpPdMm/PkHQcRtdxo5szJntPhUWJFnrYmxIfaAB5o+EZpY2N5bbWnht8av7WVmcGnJ740lqThwcx1L23tmmfvp/H9nepzKGWXL4ECe0rVa5o9Ouw0On8ydgJrxymtHRPvoUDb3MgQxWOQ8sfXCcSmtO5LQRhaBTa2lzeXXuipCf78f2acyow/7G8yAAAAAHy3+fr+LSUzc+H0xH9bDdtDzeZH9xFawfuhmkLDudLdCko6t6vYdfhXMfm4oj6tp/hx3n4rKmpOtR/i7a+ATTo6zBNPMoi1bjrshseUdVgM3va2FY/N8obfqEs2bT9n+4iHXUbtxYRT1eyqTYK+Zq8oN49RSxDqCH5sJ2rvFOo+Ln2gr/0TLdoD+6CSqC28Q6VSj4g3hQdEPVrsm3hEa++Tu8LF6vnC3TqQcD5bm+3emR+z3em1d37sAH93kbEYPyEsyDa33vDWnpmo4kSLz44co06X41GbbT/CDNXr6Fq5Quwdd7f90MWjpEHcs0KRLTzLxkM+G3Zi/K777FOFoMsVuI/wbp/IFAoLwntev5GObKPqneM/fNEG/Qb9jun3gDP/oq99rN0Q3kVyOlDC2LUOjGXvo4plxPr/I2Ob1Il/OrYJ7U4AAIB7461Xb/2gf4DjneW20XVrx7+Wqs9+k0AkeUC9r+0eu01C92CzycM/wNGsV/fuy1YT2M4BpzjCKY5wiiOc4vgBPsWRoqj/7dbirQuZmYVPTXw5upkv3lAID3w+StsibuWoDYqE6fLoQIYgJr0OY+i4iaPjMxlcx/pAfHKr/f1JWAXQvqyq60Trnvdidd2M1eZ3vAHSa1uni+o7pLXXuG3B1OClAMvnVhdXoqMAl1c/t7iyfDbq/0/8HWqS+nlqfDv1D1MfoX4++6cnfu/4rx/7ucm33wO9APdwJjP93BOpg8ct2yBXw8U7TrmCdFLxjmwsN2zrcoNEBo1QubdWl1/e8nT3bOkVpqctL8tXm8azTePCwbHD7w38PRf56+dxzIWgSokM3B7+Jttq+usbx/yNtCRc9FYne1XvItCvsIePZ2ZeXZj4+kZYzsMbboJFLLFbQDs6BT3EOquAIV3rrhF6ud/varnogJjuS3r84tTmJPHqXhsTxl8QRE4Fhpax4N3I07XUsbXOMX69T7Nh7t/i4xWlyJWpjpt5FmKnb8ROO2nlRucynKnC1Np6MFLrj6iF13wEYQ6Gp08ucJ5M6wbdZuIGa5i87wuxy9EFQG2zcIEFTLxB4q6ZpG6P46K+v3Gx5mxDh1S+qnvKnx8s7F8T06j7l+OcXMj7d75EtsLZga4x6172C75unCltbpdKqwznx5lng+Hvtkq432kvybc8tV0D4N/IGn11mxV1a6Hd2irjxo8C6tCbZq3shjc7hZkW+OyvHcsnirU0NGYWXg+7MHQqtZ06k6y90dBwtFy2S78Sph66VKo5TdhngNn3lQmKJdPypfe1Mrc+efjxzMxyfuJLqK3OCm9KLDvEdSvEmxFqq6qC3Eysn3rZ7J48DyVjNVTgbPcUeCi5kH81iGBkM6x5GWS6pM60fLzYXULjzczmNV4msiqxa5tbl7d33V+WeHNZV4XK1EM1qLfqwNjq2kAN4msYkxovHcmI6w29VcUzqLmW0btKoELcqu3XIQNmHtrTLX6/MEOuYlJzGbMaT8EgaVElVBOKSkkPu5HxvuMmOTyZmbm+NnE4GZat5u0cyCXlirVn+drjtRfDZbfRDfXNT2pQdgbZ6yyJd+tPdxmtNlxc3SPFShV7PaNWjeLdATMoVK2VwPEts76O+YWuUnXCEtcqq5506Gmz1ittR6+iwulJdQUpJt5p1r/1zeSj67e8qMz5UfFqT+IyUUIxzTZOwt3cNz52+GRmpvTExM1oH0JCWzZ+27pv1n3Bek8r3fniCxWbovEGclh9eqngGUfJ4ieZ/yJcFd+y3Cnhn1jf//Zyz6cgEIyXLm6PW8tvfOTwE5mZ809M3DzfJ2Vsh9TDr8QREidmq7vJ2yMxOu5RabWJlhY3NmfbxRY3mDMra2cSW0Eiq8n9Uiicu2XaU+oSudbSmCe6NKazFxLXmKT9TP2sDKsxse1LD1hj/JujhtKY7+vSmK5otmvMsIkzSGOSEuMhaEwspVoa46//p9coeu1hf9YAAAAAAAAAAAAA4H3DwanU5MVt6eDEZCodDYoqnCnqCqfxumiKkmjoMpJMTdKIIYiI1zSEsVtWeFWSDAObPNJEUxd1U9d1Q+U5gfAawlo4kniqUt2x7LlgXoETZFM2RMPkJIHFHCEyJ8syNnmNyIIiKYoomJyoIIk3BYMzOZ7TEEcMBZkKy7KGPkK9+U2v/59J/Tx14ovHPjtJZfJjq+lG6ucfdjICPje3Mse3tybT2ynqdWkk5c1OlgnGWFYUg0iKISLdUGWkYUnUeZkgrLOSaeiCQExlTlFZbk5kJXMOCYjMyayuSBLBks7K1Jvf9JWOkxQs6Kahc7IimlhSTQ2zKsK8JoimYfIjr+XC3XO5ea6YC2dHl43cfG6osOSKOcetE7RXqlXxbm4+N0zgPEvkcsMbFPd99Sbe6wYxFt3cvCixLFfMhYXBD8hQEckVc9FSrnPNpTO5eb71eqlq2wR7rz1X7UalUszpVeNabv61nDchnpvP7aBazgsOcjy7TZvedIA3F5wr5rzFSxvxsLu79WpjZzf27vr11ObIzc+NH9/eSrXlq45FUVRYUcEcFjVZ1SVdwhzmTJ0XZVNGsmwKrCZJc4JkynOiIXJzuka4OUJUQdQ1HROOeAXaTw+JJwTxKqcKWBMlVVAVkSBFZwVTVw1imIMydlBgujJ2mNC1ZSw/XMYOishDyVg+IWP5MGPHujJWU3jCSpgXECGiLBPEcawqCzyrShriTMIjk5UEwZwTdFWaE1VFmtNYTZuTDNZAKifrholH7leJHRSYrowdJnR3k7HvyRLbL2NHuzJWMWSNF1VZEBAv6oqCdI3nsMIpCivyqowVZHBEkdU5WdblOVHSxTld0OU5SdN4rJu6LPHovpXYQYHpythhQvcBKLG3FtLBJ3Zy6/C5+1gVD5uvosj6zPn/eT/mVO8/LcZDr6y5B5r1XK+szw2TOLku5fB2vnqrq/zjx7wFArli/F1fl9kWgp9unvX5HLla85b8+Tq3bwVZ4enPz47cWhjp0p/7UTF8F/XnwVcdH0j94YbTn+upUH+oL2fuY4uBeuPdob6zD7290KkbAsuy96+9wB3ps9JwSD1aIZcr5oKVmLn5XLWGLjdIeZ8vcxxCrKKZhsoiUzZNSZCRKSuY1VhW1hXB1BVJMAXekBWBiBrSeNHURJZHBhZEXvSCGSwS9d0NluRJAuI4A/Eqz4qiKKhI4xSdqKyCsKnyfj3kHyKSm8/tNvaQ7YWMXHVz87mNa7a7S1wLM7uW41brFkYVxpdhvFMlLbsRJEMxV92zXJcYS7vI02JSd3Lz7PXrqb8ZmaIoapweo+gL9Bj9Hfo0/Sv0Teh9AwAAAAAAAAAAAI8khfR2MPKicggTSRV0lUOizBJN501dxUTgNV3GujDelBw06DrWlBw0vDbalDQV3jA5WRI0iRVNrCGB5WVd4gTBkCRJEtJNyUETryOz6e3JoQZw/Pv/st+i6J+j1ey3HnZGAAAAAAAAAAAAAMDw6Onx7Se2nkgP1aWv1atuFVcr3qKUQSs6UMOtzqNKhXrzHX0k5segwYCmH0OsOmr6cfuOnor5MWgY4Qh+tOJx+443/5/O/hVF/1L2r+iXQcsAAAAAAAAAAACAR4ztse0ntlL3fYggHXP3fg4LjHzOc3fyvg8FePP/Y9RV6tjzmb8eq4/8K+oq9dXvRvLfung4nZlZXpj48nOJB0THjrL2jyo+0ln2vRyZWnx+s7Q+zAn2/omKU0wkury6udb/AOXZ5rHJxeiA+DJyo7+d8j7CjcZesXVxg3c87ecWV7ZKG8wsV/QOfMR1gtzAGlvk/BspVpmltdXnV5aXNlvuF5iza9H5mxulTf/o2piXCy8ur87Gg0Cu4krDIMap2MtCMW4tCt3Ci4uvzHaGuNN6ZBA6EbunYmlxo9Q6tHw1ZvSMxrIKp2m8JCoiq2kcs9ku8HR0tHtpZaPU94hpP9ljNhlydRc1HLd5xHZp9exnpkqrZ1//6OHHMjOv5ie+IiQqWPOo4tbVmG2aNsRR5D2dCPWsdUhqcE5xjwPJj3SK+MNQzEbNAMW8f4o5evjRzMxGfuIrj/dXzPBc2btVyrj1XhUf6OEHt4I8fOHwsczMljLxE3TrRORgG31st6tTjnasNo9F7pbpPiN5oDvdB0lH5uGhyd0udN/fEFnxL0OIfvhJlXhJQ+twaf9F897w6AqwyMC77MWpVW3HuzWE1JB/2Uv7Nd/DyPk3NHi3MBvEaBXLWFXvNzi8G368m8lwxbJjtX0zu1p+9nBrIR/uLu70uxk4w9ohjhu/7KPD5buWPBmmfNvLXlbI1RrBXgOnI9t6GXferB7FGgUB7A5c6zv1rO+0QZDhpWoZBWEa4iZtq1IhO6jSVEAmpoAtDW1978NTtL8iH9KZGaxMfP3igLIURta0SMVw7r1IJTiXVLLa8qfYO8mHLHutKxVCDawR/3K61r1Jg8tIPy2NsnZY/exyqztifZ3tpZkxPRxYoBPc7yfbGfz+1VlwPV1SyvdJ3eHz4N5rqaPVUcPWUEfJ/yPVTvenbhqcb4Nrr+HqrgG1Vo/aKgh87JKmhHsR/Pl/+gpF/wF9hf7F70bPHwAAAAAAAAAAAAA+MMyNbqeHW3xAvflOuiU9aEkBdfvOSHF0Oz3cQgHq9p1WkFIXHmaCAAAAAAAAAAAAAADw4PDm/1P0H1D0H0AqAwAAAAAAAAAAAMD7iOLoxclJ5Lpkr+aWFc4UdYXTeF00RUk0dBlJpiZpxBBExGvaicy/ocZGVqixYyMrx/+Lqb+Z5CY56osPOwrA+5HXP3P4yczMztrEV86Hu+DCazzLdeSScsXas/xTFohbjtSzTnTLNoKNa4OEO/fEHcnx7l1xuFGvE9st1+pV7C2WiW2ZXVsd6Hi4I87bqtPboZML/rkOPc3DjareXqbSK8sbmxvh/q5wkw/HPL++9mLvoATxc5i6b2n7hdJ6iamfsgyyV6u6xMbXypfINX83Uce72L7J+invpuyEsPn2+ga95YRbTXJgYNxbDkRRNC3b3ztp2a7vf8J7fzdUn71QoRXGS605P7W8nVDE+99LLYZ4O6VsTLzNUHuW452OEG6Fev2lw1xm5tLaxFcuD6u+nlOu5V57QArc7ny3CtfqVdOqkLJlFKt1a8eyE9K5mJCG3s70K4RcqlwrX7Fso3ol8NfxdsNXdYfU94lRbjjEKNdIHRPbLbbOJpk6WuFoBTEoDK3f/pZGX6Zn2AMrPY1bLiTEMbCbrEChrR5JENjsYRgLdVJChSFOMmrZbCVmWEG0EvduFDvSkqTtfSd+K7X+sD8LjxY3XzjMZ2bI2sTrO4NqiVq1YuFr0UEc/asIX7b7bI+juB3VD61TPgb61nkCjfclCk6hwa61T8oNW682bG+/r3dHt42tiuWXvHJ0VIa//XdtfdAnLCz1DlOLfapqpyyjo07wPwe1IDAnvW3Le1Vv5/Fd1/lBKjFBKvnlw95HFcsIS8fNDx9+OjNDXpy49WOD8jJsSxikQlwyIC/D7/KwWZngdJSVZ0srJa+q75OVoWdBTsayYMg2RFRjM2gqyhc0VBPivn2EUc07PWCualeuhdly4+Thp/xsuTkzZLYEu6cfSLbEne78Ag+RLQ8skShq5NzDrguB9z3e+X+joy418Z3Mj4y6J/5l6iMPO0QAADzKvL57+FRmpro28dUnhu1ox05YfDBd7U4PujvbzTMch+z9Ng9Lip+TFB2/03lAT3gEqeOiun9SW3jaT8xqh0S7A2GjfU+3dhrVhuO31936Nb8jWMw7xHX9o3q6nO1nr3DUMAaONaPY1y1cqToxNzpPNWqFKOk0o9Bym1GlilEldoTrQtS8ag2i4F1k74S9icDflo9N14c7Hqxn063rZLAbzmHB7y7eWhiyuzhUF+Muu4t32cdo7y727GS0ennxHl77KFCvHt699e+c5gm40YFsu4ezmZm9tYmfenLIZB+6hrnLpB9UwRyptx4fVWtP37A73jaqFMjERpmaMtFhVSe7j64KJVrnUj3jibR+tvr9QelNOEWxYxAh+QjFUCgmUuh5KGPyEESyu+HAndOo1erEadYXvRzvIT5EcFsiRxvFjtvsMdj4bJ9RygFnH/azlZwGfvUdvmSY4UeAiglpV0xMp84DLYfJ11751S8f3pNZFRw+eS/flrCy6/rE3NIOn87MNNYmvqQN25w6ysjk3bao7m2EsrstdfSxraje9Ecdoy9Sq6rsno9g4l+nJAUKjJOUp/dkQ2Srh3L0nWy4p6+iUSUOY1fd6ADALxAmaJz55SyaIPDW/2dnqezsw+4VAAAAAAAAAAAAAO8Fbm5NHN/emkxvp6jXpZHgMDpT4Q2TkyVBk1jRxBoSWF7WJU4QDEmSJEGWWMIJqjxHBCLPiYaozmms4l1Cx5uixAk6KyrUm99EGLtlTlKwoJuGzsmKaGJJNTXMqgjzmiCahsmPvJbbJ3VvdDI3zxVznv9W1V42cvO5ocKSK+Yct07QXqlWxbu5+dwwgfMskcsNbxGG76s3UlU3iLHo5ua9ywC5Yi7shPsBGSoiuWIuOq7/XHMlY26eb71eqto28c/w91y1G5VKMadXjWu5+ddy7rUayc3ndlAt5wUHOZ7dpk1v5MCbnckVc96q3o142N3derWxsxt7d/16anPEn/9Pf4w6/gsTPzl2Mf2xh61nAPDwubV0eNpfgfal8pAr0IYaSr27FWh3OYLatjDw7gZQh1oc6F/7krC/wBv1RH02APgWe2w+iDlwN4OtqMeEdI+J7ntby9h+vUrb+tLD4uEpX41+nBtSjcJB8wehRnGn77MaTTFHUaQfWFseYrKTqfmXUcXH61H7aP3dKORdje0nKmHTTjQ51Zo766V+cZWLZPvPDaABs39ts2NNj7vWTwz06NnBPoWTWPd7RiJQr7C8fJk+nMvMOGsTf3fg2vqOWSZ/SciDnciKeXEfFgclrWaJrsWKFke0m9ztLrG2WbDEebCuFQSdqh1XbqZfGYqr2tGnWIdQ08ET4l2FgrmL9UHtoRm0RGBoL9tDfg/+Pcg0HiqJY7XC/a4RPK1v1KMNTIc/dFj0q4SfSB2xStCJt2vsgVYJMS/ua5XQsdIuoWpIlngIVUTfyuBulbR33TPUYsNhVf3uapPeyxTvXw32AIuXYTk15OLdsHxtvLxiuYQxq/U95DIC9Rg1MkJ9lmEoipqkqNTnw3sBUhQ1+nPeUEGsk5SiKOrUgI7UJHXqJ98do3+W+oHsD3hWPk//J/ovs39L/zv6z+n/k/4T+l/Tf0j/Af179Dfpf0n/M/o2/Yv0f03/NP2T9JfoA/o1ukFXaYu+SG/Tz9ECPUfn6Y/SND1Jp7PvZv999s+z/0f2TvaPst/K/l72G9l/kf2d7K9n38r+99n/jtbol7M/RePsF7Nu1s7+TPa/okvZw+xPZL9A/1p2lz6Z1bM/RM9kP0f/Bn0++1I2CBoAAAAAAAAAAAAwNCnr8EcpKmUeXqGoFD4sU1Tq/OEcRVH/7vXHKSr1yq0fpKjU9i2FolLrt2SKSn3u1jZFUXdu5SkqtXlrg6JSW7c2KYr641vHKYq6ckujKOrf3HqZolLP33yNolKlmw5FpRZv2hSV0m4SikrJNy9QVEq6uUlRKfGm54Jwc52iUvxNzxZ38yWKSs3dPE9RqadufpaiUt9/U6Ko1PRNz8fMzccpisp9wuvJ3pykKOr/u+l1af/8xhcoivqzGzWKSr18KFEU9Re3XqUo6k9u/CBFUf/2hhfA//XGixRFffWW1x3+oxtLFJXauOV5Wz6sUhT1h7cyFEX9qxssRVHfuZGnKOpf3/o0RVHfvvEJiqJ+78b3UBT1P93wfPydgx+jKOofHzgURf3DA5OiqJ858JLk1sF5iqLG/VS9eXCWoqjKgUhR1OcPnqIoqn7rFYpKGYc7FEWZB8coivrhAy/k23WKotYNiqJWyxRFvfA5iqI+u0ZRlLZIUdRpz4GnP01Rqcc+SVHUR7yN/h8+5s3/U4+BkgMAAAAAAAAAAADAo4zX/z+V/RpFv0v/Bf2n9B36D+nfp79B/3P6N+m36H9E/wL9M/TX6C/TX6Sv0jV6l/4R+hX6JfoF+rO0SrP0LM3QH6cfoydoKvtu9i+yf5q9k/3D7O9nv5H959nfzL6V/UfZX8j+TPZrDzuOAAAAAAAAAAAAwHuP8VNpKk29/db4nPd88xvjRe95+874097zjXfHnwqfhfA5Gz7z4fPT4fNT4fP7w+cnw2cufJ4Mn0z4fDJ8fiJ8PhE+vy98zoTP7w2fj4fPj4fP6fD5sfD50fD5kfD54fD5ofD5PeHzsfBJh89s+DwRPo+Hz2Phcyp8TobPifCZCZ/j4XMsfI6Gz3T4HAmfqeDpn/9H/wZF/8bDznkAAAAAAAAAAAAAADo4lzpGpbbTVGFienJiRK9W3bI0AO+kxYZbnb9SrV9yagiTRsWtoxMnvk6NTf0qdfwX6PHsa8femPpVSGsAAAAAAADgvcLB/tjx7fNPTuKPptMHT573D9xWREM1NWJIhLCiaBi6ZIhIlRST42UZE20J2VXbwt7Nag13l9Ebxg5xGcfSK5a9I8qOtWMT75BdHMnNeXJzgdxcU+6z5Craq1XIKVzde6nScKi336Lefmufm8dVg1ydl3hO4JEhmgpCBssRASuaacoKETkZK4LEq0TSNV0XdEnUZWwigk3Cq7JsIKRwgon7h/Jgf7Qr4ggRVsKYJxLCImF5pIuElzmOJ4agibLRP+LSkBGXuiL+5jvUm+80I45VXtV5njUkXpN4zImCYSBZEgRFNhDLsxqrqpqpIMIphOVNDosaj7EnqWIkI6F/xKUDO3V8++UnUyU/4i8PdcR6K+KRa9dsd5e4Fo6OwGvGfaQV+UC2K7ZvvEu9+c1mbDWWSEhArKTxPGElThJEQzBNlcecoCJBYFUBIUlHikF0iRVYTpAVjDleJrrOY0nHA4NGUdT/TX0gOJhIH9t+8XSKotJp6sWgLPOqJBkGNnmkiaYu6qau64bKcwLhNYRbZVkUmRqxDcveYSrVHctmqnVrx7K9A/r3Sf1a8xLJEer2HerNb+IB9g6ujHjFKxUvXhJPCOJVThWwJkqqoCoiQYrOCqauGsQw+xcvMUnFksqX2KVxfoibGidIuiIIEhEEzCLNUAyDNUTFNA3OUFSVlwkhpswRDvGswBssL2hYljgZIWQiHbNi//IlTlEUNUafpujv0L9C36RP095pfwAAAAAAAAAAAADwwaaQ3k4NNeo41pQcNEw32nJzwOhHuik5aGxiZDa9PTnUWFnQ/1+m6F+n9+hl+o/orz/sJAYAAAAAAAAAAACA9zCfTJ9PDVjEMzZYRhr9/vSLqUHLFdKDHRJHPpV+eXLwchM4/x8AAAAAAAAAAAAAHn28+X+4/w8AAAAAAAAAAAAAHm2g/w8AAAAAAAAAAAAAjz7Q/wcAAAAAAAAAAACARx/o/wMAAAAAAAAAAADAo493/l/m2CRFP5f98RPfPvH9x/eO/dNjkw87VAAAAAAAAADwgDk4nfnw9jZ17tyJ6Y9OTnyUmkynqWnKIY5TFhEnKJys6KIhiKqiqlgJLuTSRUFkdWWoC8GSbwE368TZFeXku8RDQ/8e8F1rZ9cyKoR6+y3q7bf8Vwenx3uFWOUQJpIq6CqHRJklms6buoqJwGu6jHVhqIvJ+oVY6hdiqT3Eb75DvflOEGJxzAvx8vKJx6ejED8ehFjHoigqrKhgDouarOqSLmEOc6bOi7Ipo6GuPUsOMa6ghkFEMTnIkWnwbFTcOvJDffsOdftO8PLg9GivhFYMWeNFVRYExIu6oiBd4zmscIrCirwq43sIdpCWPUIdGrYndBBkP6H5tBfil5e6Q0wwxrKiGERSDBHphiojDUuizssEYZ2Vhro1rhXi6Db76Fz5uYq1Z7nEaAZbFBhUqRNkXGNCo/ZAv/Eu9ca7QaC5ES/QawmB1hTe01VeQISIskwQx7GqLPCsKmmIM8m9Bjp4EQ8zuWo5rnfufmDUM8zPprwwb291h9lUeMPkZEnQJFY0sYYElpd1iRMEQ5IkSbjXMLt1ZDu4btXawt16y9RJDVl1xqk26pj0ioA3/5/J/jGV/WP6Aj1G/wp9mr5Jfwe+NgAAAAAAAAAAAMD7hkJ6OzXU+F2mKTlo3Gy8KTlovGqsKTloiGi0KTloaCbdlBw0HjIym96eHGoUwu//n/iPFE3oj9O/lv1S9vdP/Mfscw876wAAAAAAAAAAAID7xLnR7XOpe1+3kmm5c0+rScZfGN1eTt2HNR5jrQDd06qL0ZXR7ZdT92ktRPr86PbaPTsWvBhZHd3enrx/aweC+f/fpbK/m/1/6GV6hv5F+gr9B1DOAAAAAAAAAAAAgPcUc6Pp7RT19lvDzfMH0m++M9xcfyB9+85w8/1t0gPn/APpN94dbt6/TXrg3H9xNL09GUkPmv/39v9Tjz3sbAQAAAAAAAAAAAAA4EEC5/8DAAAAAAAAAAAAwKOPN/9/bPS3qeyfZV8e/e1jK8dmpn5q4v+a+M2JL01MZv7ByOsPO3wAAADdvH4xnZn+1KdSX73uIr1CDET2qnbZcZHb9vfo0nppcbPEbC6eWSkxcRNmdophHMveqRC3ajPLq5ulc6V15qX15RcX1y8w50sXmKUXSkvnZ1syCwxXKE4xzA6xSR25Vsza6toms7q1shLaiUk8u8Cwvi29WnXLlsFsll7Z9H47Lqq7xCgjN3IleFut1dreThUZg5ioUXHLqFarV/dRpbxXNYjvUMvjs6XnF7dWNpk8arjVeVSp5MOwJFteXmVmW6LF4M8r1folp4YwyRfze8huoEq+UGh57+xWr5TdXcu+5B2N2xX1KARsh8ed1phZtsjF3a3ViUPcXvHxD2XujExoxY9FpXolX8x7p9vmi6F04Pq+hUkZV/f2kG04ZVSpVK8Qo3e4uaYfvSw2Q44wrjZst1wJIjXY7ShNelsM3S4wG5vry0ube8cy08oTqYMPW7ZBrtbq1c8T7DrlCtJJpdywrcsNEr08Hur41uryy1slZnn1bOkVJtEGs7baNJj1PK7P+saFwo9OZaaFJ1IHku9d1SblVkr78pG1Y0meJci3eWU5kXGB2X6htF5iWm+8UnV6cnx66YkU5XvuXK5YLil7Cun/jlx0ynz019TpiaEscNFfkzc/nclMP/FE6vBJv7qI3kfPibZqInrrVxFhiU2oGCyDObeydobJe/LlV9k5Dc2ZF5/KM4urZ5kKsXfc3VnLKDALjKD4NYCf1h1qHjgVSgeZwZwpbW6XSqsM57vEyUH9UffqjxpydztcCHLCk4glao96qU0i0uYphsF14lWcsVqn02ZMolmjNWrGAFsxiWcXYr4UpopBapQvkWt+fCK9PxgfDxS/FCm+aVVIpMYIu9Y+iV5meih+t41QG32DdsUP9TH4JJxcYPJ1slfdJ0b+9NgAFQt84aK/xg9HRn0V+/HtSMX899FzrFPF/LfDqpi/5feBq1iQCkm2AxO/unWsHZsY5WrDzRfzleqOZZdrxDYseydfjAwtO1/M1wmu7pP6tXKdXG5YdWL474LUDdSuVq9ib5ny4A9qgmRTDb3PmmWQepnsISuIfNvrWgXZzbcPQ9P9o9bLUdUfaXxo0QtTl/nyRuD22rqvIEyU112ShQVF8AW8bHQauuPWu4WKXFErLOT3uXnfaD4/hA224Mcw0L6nXv3hpupNMUxhqtCz+E6PZKZPnkwdXPMLwZ61E+SW0/or3VYQWu/9mO6TuhNXg1iR8PIB1WoVq28+xCT83JuKQnbjQ6nM9MJC6qbih8whuFG33GtlB9cbuleyd6ve717vR9pC3Uvq6I3KhaBJWSfIqQZa2hmjwGghv4dr5Ua9Uq4Tw6vUqnY+tBkUrj5pEhdpTxSv/z85MkdN/dnUb099ZerTmecyIyNz4//L+LPpY9DrANr4cvZDmel8PvX3XvVL0OUGaZAysd26RZy2Hx9tKyttRsN+7wJLfT94avDJIo5XYUQdq5bqr5eeL62XVpdKG5GM49tcW2XOllZKmyVmaXFjafGs33LaI46DdpI/faGvS4sbm7OR3OIGc2Zl7Uyh80PKyzwnisN/S1sfTsNyasjFu8GvsBbLF/Mmsir+H2hPt3Ya1YaTL+YxsjGpeO8fXvON2EEeOZ4i2Jg03Qisdhu3PmldZu2JqLGswmkaL4mKyGoaWyjG7jUpm5aNKtYXhuls9bDV7MXFzL08aTi9uqB21SZRD7Tbkp+TvkgxlqFNH71OqY32kVXxSo2Xkzqyjaod5F48EJbtEtstfz76Enif6S5P40JdzQTGe13eRxXL6GGnEMjFipOv2D08aOr5MwuyJAmyZ7nVRz0Y/4hfIRyc9xvFQaaGKdBW6qfDCiFoobfJeeWxTXa2VaKLMZUrMl7hjTfWF5hmamsfHp9+Md+rrd7mfJlr+/mxz3zP+PRaoZfVKCy+j06Za//9odeNxzLThULqx9NhmyJu2v7rezraD3GzoNXQUZHFK8cj1WVDVTzeSE+gpzYh3hhHODjUemE7V0i99TNocRTznuKGj7JZ9UYvGjUneoHRPkGu9xPpVW9wK6yfkOupVJ/mfVwg1i3t0yoKlTeQKDDPLDC8JPuW9kldR6611+x29PI0STDmedPY04k6CntVHVYjs1hJDEPWKRKEkQ2q3gpy3KBr6jUie1fAXXLNyrtO9q22lnJXmy80f/Yua/tYKxHRmemnn0gdZIJCEmpguU4wsd3o52NtZbxDyNPUpubG/Dlb2ljyS/bpbL/edtM1PvqLPn1iKAtRiXWyX/3Qcb97/tNX4mU1KqXOiaTyOXRzxd9sO0T3POz2922tNMcpLCOy441GNe20i4YDbE3RoMvr7np3rsVHm13LrfRt3/gCvpIKfKAxdrWrHml+EaOvYfwb4su3WkbPLDCcLKhiW8h6uef3QCNHm8J+VRUYFfPBIW/NkYOEIePI9qCh4ab9Mq7abh1hd/CgcLcFZpYr8oFrpldMie1PRPQqXR0ysYpmuFEXb7YgbBz6Q1r5Yt67zC1fzLukvuc1NhKHXMIK2LdSdhv15gfmriqR73pDs9jS6ZjMemkxNjDUZRyrjJOMg3C1jPYF7Uhq6VtIUs1i3ps6sPMFv/y3yZ9cCM2CQLXp0oKnRQyq411rvz2Vwo9j3KQVtfjrZlIHQ6GzrXqmmFAptPf/J1J/RGU/fnx6MjX+V+Nzo7+TPp/6I+j5vt+5YU8cv7B9aSadTk3M3BSCRi8mRMaSynOmIIuczuuCgTSOk0VZEjlZUYY6R2OduMiyGXeXMM0zJkWZidrzu409ZMd6NeH74ObaifDXa7lwoC83zxVz4cDjspGbzw11KmmumIu0+lxzQNh3Knq9VLVt4rdZPVftRqXieeNW67n5nB/CXDHnkqtubj53xPjkirnqnuV6l5zuIq/4krqTm2ev37Az3QnOmSKvYIHXJUUQiWiqSESCrkpEJQIRDWOoo0gSAygNTHD/4t3McAk+6PjWB5/g0l0k+Hh3grOiIps81rEhyqKgiioryRJGqipriJdEfajzWRIDKA5McP8C3vHhEnzQ8bQPPsHFIyf4wfLYsQvbF70En3yyEaS3JCCOMxCv8qwoioKKNE7RicoqCJsqzwpDnVnzqu9WcxAunCNikOmSOuMQ162QPWK7F8NRseD+2rHmAEtnUrenwS4yFl0X4V3PCSc3b6KKQ67fGhs9fmEbBcrz+qUgMiaWDYmomqgiVpR5XeMJkgVD4ljBlDiWG+pInb2G4zI6YfyZAb0ZjXDILpi6Cu7mjfTGj87ocHoz6NTf+6o3w0elh8oUcyie9K++ltOvuWTF7zPk5sVizrB2iON5Re6RXDG3RwwLbV6rkdy8H4HTtQqyvNjYaM971xw0ndsXhVPuVTd3/eL1ww+nj1/YXgv04KuPB3qgi7Kk6xyRkSGIsq4iJCmagFVVMU3OkJSh9MBv5NX3CUO8BjmDq5WK5Re3WtWxvKRry/70ezD7B8bgnnPdvEeGyXUv1F6CzlVtEuR68T0SIPdK9b0QIAftkf/3d/+Z9ysqFTf/zsjxC9svfjKoHb2VQw1S5k1Tlw3R5IiiijoWVSxqqoJEUzZ1nuPIsKVirk4qBDmEIaZJsDuH61XHIUYwChybBgkKxsh7s2D0jcQ9lwvjHhki12NxmIsSnRhNBSCp4xe2n5tJpycnZl5fCxRA0HXeQCovsZgVZUXTFFXQDMSKmqxpuiEcWQGiBojvfFt1+B7P9LaA33Nu43vkiLntILNZ0L39/xPZX6Ky/zn7Lfo2/W36KfqL2V+itx527xUAAAAAAAAAAAD4gPJU+kJquDnMiZbooNm3TEt00LzReEt00JTHWEt00ITCaEt00JhzuiU6aCBupJC+MDnckI3X/x/PpqlsOvsr2VfoX6a36ZGHndUAAAAAAAAAAADAA2FzbDt9ITXUyl/q7beG7IPHHB20upV6850he+sxRwet4KRu3xmyXx9zdNDSBeqNd4fs1t+NowMHADY8RyeP5uig/r+3/n9q7Ckq+2cnvn38fzz2y1N/f/LGxHZmc/y5saegvAEAAHjc+NAUfXErvz15cGKmkU5PfJTy9izv1dyyYRLekDWOGLwusixWOYmXeSyyisoj/8PD+sz5/4nef2r0MyTa1nrKr7WH+hYris4hAfGsyYoS5rFGOCwI3v+Gjk1TFmRimIRIIlEEyeSwJmJNkUSFyKrCGaYcrqV/Led76a+pG+7bnrsebOXxDjy48aHJHoki8jprCMQwNBaJLIc101QEXuAEXmYNGauidDeJMqgtwfKsaXICi7EuIWIikZUUDSNJE3jR1BGnSLpMJJnlNU0i3gfT4CWR8FjRdc1UBK5nogxqm+SuB9tt/EShJuiLW5KXKE8+15YoCmeKusJpvC6aoiQauowkU5M0Yggi4jVtYKJwLBsugjzlH7w1F6xpD/ZM8aokGQY2eaSJpi7qpq7rhspzQqA3SFE11sAcMQwDa5Khc6xgIFPRDCzqoqGJEqeJKpFFYhBdNUQVcaoqaLrBGQLx2iPR+SOv5bxtj7n53NnF0otrq+X10sbm4vqmlwTfoN78pp8Es5nHIr04eLItDUxkyLrXZlEMVhSIgFRBQgZCOjExkgkRxSOmwVCRJxIn8URkZVOXNF4wBUGQsCAjXmZNVdVZSZSQogqCJrIc0k0ZKTyvEoXlVBWxuqo2FSM48sNbURksAc0Vc34ofF1pbq6Z8w6EEqU555rt7hLXwnOh+JwvnLvu7RV68xtBERrvUYRMkdd5nkgswqxoIEHDChFMVlKQrIuqiQemVGIRGtRyZrFGEBYMIpm8KmmKLOsKYiVT0bFIdIPXianqhiqwmo68YqjxsiILuooNzmAFhfQsQoNa4kGi3L4TJMpYj0ThJI4oEtYlLMqiYQqawEoClliOcKyqE04UBiWKpnUnyqANSqYu6UjSZEM1JA0prCwaiiYjWdQREllMRJVIkiaLkmDKrMKxoiRJssZyGs8qSFd6V7aD5hJz14P10EGijPZIFFXXWQUrROcUUeRVU2dNUdJ4kzVNyRRlfXCicEJ3ogzqZCiqyamGjnhe4AUs8horSRqPVEHAiqKasqBgQ5IRNrGqcyqSNU+1BIMXOSSZusj2TJRB3av2REn3ShTVMAxeUBVVUkVW41TB+1zyPGeqJuYEcYhE4Y+eKLyoi5gokol1k+cklcccZpHAibquEU9vNJYzdY0TMcfJsiJLEhYlbKqKX/UouGeiDOoetifKSI9EkQmHDNaUNSKzos7ySOY5zZA0QzQEDUvKEInCHT1RBIVgBakcpxq8jrCCWFliddZACGOWqKog6aJpYEmROc4kkqHxOsezkmxgRTMIx/dMlEEz4e2JkurVVsGmwWqszPGiJhJT0wXEaoYgCpLE86KsDZEo7NEThRiSoEu6qmBRlllO4XlWlEyVVzGWCCeKqilympddpspKOtFlXhNNr44RVRl5FU+vRBnU548nijf/P5V9jqKZbIX+Fv1G9mfpL9AvZp/L/ofs/wztfgAAAAAAAAAAACCkmL6YGnYaZCouPGh6YDIuPGjYfCIuPGh8OdMmPGCIdTwuPGjocSwuPGhIbrRNeMBQVTouPGgIZ+Tp9MXJYYc2gv7/DkX/If0mfUhfpEX6WPZPsl/L/lZ2B7QcAAAAAAAAAAAAOCKz6a3UMMsgp3zBIZYGTg4lyLHshC84xJqyzFCCLMuP+4JDLDMaG06QE0aHFOTTQwpyI/n01uQwyxa89f8p+jWKfg10GgAAAAAAAAAAAAAeAAcjqcz2ZFo4ODHUhVDU7Tuv5dyqiyqb1UvEdnLzHMteZ1lNVU1NNgRNwbwuExMpkqTLureIgGe9TUS6TnhkKLyCdIlDuqabvOJvzTFY01//n6K/TdHfhjwGAAAAAAAAAAAAgPcXhdHtycmhRhW8+X/qsYcdXgAAAAAAAAAAAAAAHiTe/D/0/wEAAAAAAAAAAADg0Qb6/wAAAAAAAAAAAADw6APr/wEAAAAAAAAAAADg0Qfm/wEAAAAAAAAAAADg0efEOKamUofU+H9D/yitndg/oRz78rHzx7KpQ/p3H3bYPjh85QefyEzPzaV+asdFeoUYxLnkVmtl54rl4l3idP5mltZLi5slZnPxzEqJ6TKdnWIY5Lpkr+aWLYPZLL2yyby0vvzi4voF5nzpArNeer60XlpdKm0wew0XuVbVLofyzqxlFIpTDONUG3VMyrV61bQqpOlMzGpo1LThovoOcbtsrK5tMqtbKyv9rIae7RCb1P3gMMurm6VzpfWYu92GTac9qdouckiHj0svlJbOzwYmy6vMbL5WJzVUJ0a+mL/csNyy46K62/qJq7Zp1ff8FxXUsPFuTGKf1C3zWuwFqtUqlv+XiaxK8GpPt3Ya1YaTL/jxMiy0Y1cd18JlXDWC4HnvGzUDucQoI7crLmGgYxLPLjBsYarIBNmblA6BlQTzjcDJtfUEy88ybKHIfL7aqNuoUo5Spjs8Z0vPL26tbDJc6E2CDWaWLXKFmGuGtUMcN8iNdluhSSxkFWLvuLsdAgVmgZHFQpHRG7ZRIWVslHeRsxskYFM3LaMzCWIGsbi33gaRJldrBPupi3G1YbvlS+Ra6HSQ7cRIcLzdKBaB+PvAg6YelM16da8c083AqUTzmJPJ5vdZg70MqxNc3Sf1a2WDIKNi2SSukkFYk0VaYU0093W2wGxsri8vbVIU9ezdV41f/vxHM9OnT6e+nvarxq4Kq+vFx9sqxy5jv3ZMqhWD6FoGc25l7QyTjyrQV9k5Dc2ZF5/KM4urZyN1tQxPRUXWL+aWQfZqVZfY+FpTlVoFaGt1+eWtkid3ybI7K8VQtQJHPfMCc6a0uV0qrTKc758aeIEa7m61brnXuuvVNificp1O8WynW33q1EhTk2T93PVcqpPLDeK4beU9OVztklHx9qp+F7nJ9XZg0qn1xDQJdoethot5jGxMKt77oEquE6dRccufd6p2szrGdTKgOo5JNCN/1Eq85YZXm7t1ZDu4btXcsmnZqGJ9oV/ly4Yu9rDVrIBj5l7yNZyOlI3cy9tVm+S7HQ0t+YnuixTzNWIblr3jpW/kY76Yb9hoH1kVr0R6Ca4j26jaYaUSc8+yXWLHUnuKYbo9jQvFKhavnDIM470u76OKZfSwUwjkYoVzaXFjs5cHixvMmZW1M4XCMwuyJAmyZ7nQrKo+833j02uFFGXZBrnqXK5YLimjhlv1f5fdRt0uO429PVS3iFPm238/+ZmZI1jm2n9/4mbxezPThULq8MN+Nddu2v7ribYKrt3MTzWHOI5X5fVrgoUyfhOMWVtlzpZWSpslZmlxY2nxrF9b+Q53OuEXWa8s25j0UvumebOoBMG71tKDHrWEn3Ftws3sYp5ZYDhWVCVFLtx9mY3V97OtVCpGcfVlgvq6zTiKUWEqUpSFx8enX366V143HLRDyo6Nas5u1XXKXMeL77v52Y9npp9+OnWo+LndYdzxc6YtvzsM/Qw/aps7OcPDdlKd7FtezHtmb4dYM3GrukPq+33zJC7StFdD1ypVZAynHW3CbdrByzwnBh+Vwd+jru9QXDNaydlsa0axbWnA4vT49NbpXhrQ1ewo812vvnfxY0dzgut69fhznxif3pjr5URnz7DMdb456a3/zxz/JxT9NZrJvpXlTvzjE8Lxf3I/+7YAAAAAAAAAAAB3z/XM2PY2Tns99LKIOEHhZEUXDUFUFVXFCuE1hDVdFERWV/xL0BTRUE2NGBIhrCgahi4ZIlIlxeR4WcZEw8iu2hZGlTlvvHNObxg7xJ1zLL1i2Tui/FlyFe3VKuQUru5Rb791fbzlvcohTCRV0FUOiTJLNJ03dRUTgdd0GeuC7z1ChJUw5omEsEhYHuki4WWO44khaKJs9PdeavP+zXeuj7W817EoigorKpjDoiaruqRLmMOcqfOibMpoqCvg+nsvtnl/+8710Zb3iiFrvKjKgoB4UVcUpGs8hxVOUViRV2X8ALy302Pb26XAe4IxlhXFIJJiiEg3VBlpWBJ1XiYI66zke89JChZ009A5WRFNLKmmhlkVYV4TRNMw+Zb3gc9t/r3xrj3S8k9TeC8jeQERIsoyQRzHqrLAs6qkIc4k98W/VMs/U+ENk5MlQZNY0cQaElhe1iVOEAxJkiThfvjnrf/PZP+Yyv4xfYEeo3+FPk3fpL8DtRMAAAAAAAAAAADwvqGQ3k4NNUaUaUoOGs4Zb0oOGnkZa0oOGiQZbUoOGs9INyUHjUSMzKa3J4caQ/Dm/0foixT9q/TFh51hAAAAAAAAAAAAAPC+ZG3k2PbE9Az1ZCqdTgcrUXhVkgwDmzzSRFMXdVPXdUPlOSEYkfC2CV/dQzbaIQauevP0LjFGqNt3gn8vpTwHnziqgzVSd6o2qiS46M3/j9Bf89b/f+NhJxcAAAAAAAAAAAAAfFBQxranZ1JHHisY8ew9MXn0IYFg//+LFH0t+++zl0787ydePf6t4y8+7FQAAAAAAAAAAOA9z8FoJrM9PXPw5HB78+MdmH1u3v85L/GcwCNDNBWEDJYjAlY005QVInIyVgSJV4mka7ou6JKoy9hEBJuEV2XZQEjhBJN6+62D0fF4MAYt6k4MBlZ5Ved51pB4TeIxJwqGgWRJEBTZQCzPaqyqaqaCCKcQlje9ReA8xp6kipGMBOrNdw7GxzLbj88cnBxurz6uoIZBYuHwf8+LvMiqWMQsETVNlDSBNQ3eVLEuyQorajzRJY1IoinxvIxFTRBMWZR4XpVYieNMg6Vu3zkYHY2nx6AF6YnpIUi6IggSEQTMIs1QDIM1RMU0Dc5QVJWXCSGmzBEO8azAGywvaFiWOBkhZCIds6IfjHQ8GINWuycGQ2OJhATEShrvrYDnJEE0BNNUecwJKhIEVhUQknSkGESXWIHlBFnBmONlous8lnTqjXcPRkfiwRi0lP7BBSMVD8agdfoPKhiw/x8AAAAAAAAAAAB4nwP7/4fc/0899rCzCgAAAAAAAAAAAACAB4k3/w/9fwAAAAAAAAAAAAB4tPHm/9OpQyp1SP/90a+mTqdJmjzsMH3wOEx9f2Z6ayv1VeIivUK8HSFW1S7X6tV9yyD1MsK42rDdsndDZrVuuRZxhpHJL62XFjdLzObimZUSM4wNZnaKaQpaBrNZemWTeWl9+cXF9QvM+dIFZr30fGm9tLpU2ojEnFnLKDBrq8zZ0kpps8QsLW4sLZ4tFacYJvIpcGZ1bZNZ3VpZYZZeKC2dn20aLq8ys3l/Q0u+mA92PeULBc9+vWG71h4pO7haI4mOtEv4LoWbZPLFfHTGRehaFN1L5FqiW1MMwzDNYC2EQWIWV88yFWLvuLuzMRcKC4rgW2B8AaehO249LlDkilphId/cq5MfIM0W/PCcW1k7w+SfevWH2TkNzZkXn8oXfItr613BC1Kqd/jEQeHj2DCAwU6zQSHk+oUwyC+Cq3WDGGXkMsurm6VzpfWuDIuJPLvAsIWpArOxub68tPlfTn06M720lLo901YGkFGtud4fGNmGZSC3pfoJRoVEjU8Q9BX9XvWzWZLc3TpBRrPAdLgU5k63dIE5U9rcLpVWGc5PdZ5lI3c/T7Abuee9ci23Qvq5vrS4sTkbSC1uMGdW1s4UOp0X+KbzQUAcF7nJjnaI+EmAsGvtk3wxbxkV7+GS+p4VL16ecdlt1Fs1R+BYh8nyRuDT2npLb+MC3akiqu3hbtS8PPR1aL202BXmmHHMryRjXwM9pyvWPrGJ4ySncGToJ4P3K1/M21W3HP7ZsC/Z1St2mA5OtVHHpFzzYhqWgcCZuEErWPHXzzJsUPpar55ZYDSWVThN4yVREVlN4zq9KRvVPWTZ8RTvNoz5mGDoxctA9SuWnS/mK5bduNoRmXoVe6pQd5N8aRl2Z62vlt2CvVSU44OsxhVk7fnK10jOkzYBP/w1YhuWvROUUWsv+NMv+f7HwCQ2JkYYrWY9UDYte4fUa3XLdvuVrkQLhQVZ9EOd7FxQUb7aqiY9n4NgdHsb+JZgGleVMDDdUs2QJDjQFYywqt63vLqxdz0dmrfnT5cu+nGy6o5bNiwHV/dJvW/1nyTaKoTIcctV3SH1/b6OdMk9u5AUhpabeBfZO4OdjIlFsU4Kr//B7QhCyy/kumSv5j07in+XaaysdBgNio9X7yQmVKwh00Mwpk3h5z5R8JmFzhjGGgeRzVaNHDWWmgYx9zvkgu9nzKyjwvNCGOZNT6F4pdZftr1q6pQNmlbRs9mMaX4pou9wvVptK6a+eLJUUgLHasJkS71qQ5XT+O5GWaIbXnOusJA/nW+PSqzp3rRXTGiIeLLxVnC8el2I6s5eNUwsaaPGarsLJ4dyIrTeFZaE72Zvdeg07fo2tUI41V83B+rlsDo5nD76UW82hnc+NT792laKsmyDXHUuVyyXeN20qv+7PExPrswNIzUL6/8BAAAAAAAAAAAA4NEH1v8DAAAAAAAAAAAAwKMP9P8BAAAAAAAAAAAA4NHHW/9/grpFpeeO/c2xf3BMmRybODv+b8dmRt9J3xq5M/LT1K2FhdTh4/6W3L2Gi/xttMQ0vX0nxNtWYOOe7/m2zbi9pJjZW8fFzLQkpb70mXZv6sSpVhren07SOyXZ+ZiEv8cj2lc1YDd7034o729rD3bKRe6VL1l28g7fTplgQ2K9uk/sMqrVKlawH71tU23Z2wptY6vimyEd2UbVbu5QjFKn/Hmnag/c99su3b2diA820so8J4rRTm1i1dyY683t2a33PXZztsm0/HpmIe4BrpPmHtzkLXcxifaN4OeF8emyNmjvi7+LpplZZT75vXyevwvHuOT30lZ+fNpaGuRYwm7zlosJhk/dWOIy05qWunWybed7u+fJb8XE/e7tMvelFHSeCdHMzK3V5Ze3StGO4JZUsO3Uv9u0tfc0flhBS7bALDCCcq9qs8aOT+OFXpnTq/Ypc71MhJtLpzPTD772uw+Z07NeCpPaM+/aW8h+N+qZpgXD2iFO3y3WHaKeUsjivR8rceNH5jIzWn7i1iW3bu3skPrlBmmQsltHtmP5qbnTQHUjeEtst24RJ8q59eVznl/JNpgzpefX1kvM1ktnPeG155ngrIS1VabNsantF0qrfni9rJ5dWzl7KhBcYJp71v1kWy1thybBfnzLqSEX74Z72pGNScX7VhQKwWEg7S7FpZNca32FTBR9cvZ0a6dRbTj5QmGqMHWmdG55ldkorZSWNpn1xeWN0uzimbX1zSKTtyoVsoMqQbyYVkLkC59hSqtnD54tZqZfnEvdoP2yZhDnklutlZ0rlot3yzvEJvVAbxu2dblB2s2Jw4XJHdYky6tnS68wgxyZYryE7nRqtku8wGy/UFovMV0G8Q2Yt04/7Zf0L132S3qH39F2yWu93rNtJb2XVHC0jmXvVIgb23cfL+thJdqUWWCCDfa4Ua8T220LfY/asVuyub0+MuusbQbWMEydVAhyiNE3AGdLzy9urWwybLNIdlvywuJrZ5LhMwsJEe3emdwdw8jRhAhGm36b5+ckJVB/67Gdza1aBT01Pt1YG7g/NzyAqBwdU6RbfnmPNVd6ipxChXvzghsoMvdlajYzvbaW+rvV9mOnelkYKFBMPnCql/h767SpB3WaT+9TdpIO1zGIi6JKP/i72Se4n2d2hAej9PmkxiSaVUj8ZJ1kW+2H67Tc8K1H8ek+sqLNpNXtiL/udi74YAw818D7Si+fWx14BoJfQXRrXFKT/UhnKfi5vBDlsJ8lCdFtnUsQyrcU4YhWomMWOm0kVmRe/z9F/zVF//XDHokAAAAAAAAAAAAAAOD+M5oapSZg/T8AAAAAAAAAAAAAfADw5v9Hspcpei17+WGHBQAAAAAAAAAAAHiEOHh1ZOKidCAdnEhHG20UzhR1hdN4XTRFSTR0GUmmJmnEEETEa1p4b92pSnXHsueCnXCv5bxNjbn5XJJhrpjzfy57AhjZVdvCqDLnbcUSpTnnmu3uEtfCc+H2uzlfOHedE2RTNkTD5CSBxRwhMifLMjZ5jciCIimKKJicqCCJNwWDMzme0xBHDAWZCsuyhk69+Y2DU6nMxfylWORMZMi6aGJNMVhRIAJSBQkZCOnExEgmpC38ybHKFXN7xN2tegYG2bcwKXsbWHLXDSzyGkc0QRJFgxN1wcSmahAkiUjlOAMTmRVEWUaCzPEch72HrCHJ1D0BWTKp23e88/9G6Dco+g36Ww9bNQAAAAAAAAAAAADgA04xfTE17HDJyNPpi5PDDj948//UYw87egAAAAAAAAAAAAAAPEjg/j8AAAAAAAAAAAAAePSB/j8AAAAAAAAAAAAAPPrA+n8AAAAAAAAAAAAAePSB+X8AAAAAAAAAAAAAePQ5MZqiTlBFavLXJv6HzG+Nf2PsO6N/MTpJ/Yf0L1PF7H868ZdTfz31S1OvTL3iyR6cfTYzjRdTB5ct2yBXDeJccqu1snPFcvFuuU6caqXhWlW7vENsUkf+nw3butwgPUWdZ5bWS4ubJWZrdfnlrRKzvHq29ApzBJenGGZttbcFZzZ81bJYeF1+JjO9uJj6yhUX6ZU+YettMh+GenPxzEqpj+/M7BTDREcxWgazWXplk3lpffnFxfULzPnSBWa99HxpvbS6VNrocIU4sy17heIUw3RFhFle3SydK60zq2ubzOrWygqz9EJp6Xx3jJlnGdZ3IpaQ3j0TQXA6bHfKLK8ys3n/5T4xyqhWq1jEyBdbr+yq23xd8L0xLLRjVx3Xwv49FYnedMqcW1k7w+RfXZz7wYtP5ZnF1bNMhdg77m6nYIE5U9rcLpVWGc6XUoOYVXWH1PcDxTCsHeK4ib6GbnZLF5gFRhbDRMLEqrnlzztVu58jS4sbm7NtwosbzJmVtTOFVhh5P4y8zHNi5HiUkG6v7IuLPLvAsIWpArOxub68tLmxMD69s5ii/NLnXK5YLimjhlv1f5d7a2GZ6232mcm/pib8wm18JjOzLU3cOOfWrZ0dUt9ruEEKxV2y9rzXeoWUDVIhLkkSisrG+vI5L3pDuTN1pvT82nqJOVtaKW2WvCKdZG3qTOnc8iqzUVopLW0y64vLG6XZxTNr65tFJh/Jx5ScsRym6VG+8BmmtHr2wJg/UjQbNQPdj2gG7kTR3Hrp7OKDjaatZWZe1SZubITRdIjjeN44Lqq75bBq6c6HZLGOqA7pVneeJlvsF93QBuPbYHTLv68nOcLqESMc5Mj9iXCv3H2QEb6mZGbKCxM3UKciE9Mk2C2TfcsgNia9y2yHYC+FHuRen7LbYXUoxQ7sMJGd5LjLR457R0G+57gPLNAPKO7npPHpV6VeH4HEWohLeqtSVIr6IPP6tcXMzPm5iR8fC5Wo4yPp1pHtWEGrs4HqRmf7rENlBthmOhTleaa2ixzS3XglztT2C6VVv1XgtR5n11bOngpkF5h8rU5qqE6MoIm0WtoOjfxWWtOwmL/csNyg1vF/VlDDxruxFyayKv4faE+3dhrVhpMvFJi19S4P2xxK8rTDJ/8nrtqmVd8b3oOWhZ5exN3sis4gTzosJHnS5eY+qVvmtSN40mEhyZNuN5vt6W7X44433Zkq9KtIrEqF7KBKpFJhn4FpKWNYidwY+WxmBi9O3LiUrPv9mmq9RfuXiKM1/3pb7hf/jnj3byPdGHnuLhIhqPfvbyL0+pZ8FxIB1v8DAAAAAAAAAAAAwKMPrP8HAAAAAAAAAAAAgEcf6P8DAAAAAAAAAAAAwKOPt/4/M/K3VPYTxz87hSZ+bPxfjN4Z+duHHSoA+G5ws5w5tj2Z396eTL/Opb29t2URcYLCyYouGoKoKqqKFcJrCGu6KIisrrRt6cXIrtoWRpU51HB35/SGsUPcuXrDdq09MmfWibMryghjt6yIhmpqxJAIYUXRMHTJEJEqKSbHyzImGvX2W6/lavWqaVXIspGbzw1lK1f07GDiOOeapz3k5rliLjjhgBiLbm5elFmW9QSJQ9zcfG7X2tnNFXN7VYNUcvO5nZo7J52S55xqJVfM1QlyqrZl75RMs1r3xPfQ1Vwx5zlnYbJpkXpu3m5UKsWciRw3N2+iikOKOVSr1av7qPJStWLha7n5XNWeq5PLDeK4vqv7FrnyYtUgXswabrUcvPHCT+p7lp+kLwWxz83n5q9U65ecGsIkV8zh6l6t4ZL6lkNy8269QYq5WqWxY9lLqIZ0q2K516L3xPYP9Fis1Zzc/KsXr1Nvv3WzPN6ZwyqHMJFUQVc5JMos0XTe1FVMBF7TZawLR85hyc8rhAgrYcwTCWGRsDzSRcLLHMcTQ9BE2aDefCchhwfZGi6HJZblP5g5/OY7N+fHvBy+sD2ZvkWCHNaxKIoKKyqYw6Imq7qkS5jDnKnzomzK6Ag5jCuoYRBR9DNL4glBvMqpAtZESRVURSRI0VnB1FWDGCZ1+05CFg+yNVwWi+2F2PTSYS7IuSifg7DOBUbSHNcnswPRz5G6lw65+Rx/ijvFy2xbboWZaRATNSpeHvtbcHdeqO55ry2nWvE2QuaKuWrDrTXc56v1PeT54Lh1gvbmvCNRcsWcZfcyu07dvnOzPNpZPBVD1nhRlQUB8aKuKEjXeA4rnKKwIq/K+MjF8z2Xdx+g4nn7zs0fSns5/HIshwnGWFYUg0iKISLdUGWkYUnUeZkgrLNScg6LQmf2Vqw9yyWGn1GcpGBBNw2dkxXRxJJqaphVEeY1QTQNk6feeDchewfZGi57hQ9s9r7x7s1XR7zsXYtlr6bw3jeNFxAhoiwTxHGsKgs8q0oa4kwybPYGPyF3H2bullOd1bOp8IbJyZKgSaxoYg0JLC/rEicIhiRJkjBs7vpnEuC6VYMcfpg57M3/Z7LforLforey/5m+TT9Ff5H+NvQ+AQAAAAAAAAAAgPc+T41uT6aGmszLtEQHzQqNt0QHTS+MtUQHDWaPtkQHjYqmW6KDRthGCqPbk5NDDdf8/+y9C5Ab+X3n18A8MDNcEvJZPlimHPXuao3BLoaL92O5oATONEmIM5glgNGQWlPtRvd/ZnqJaYDdjSGppzHkaleR7dgX+ZWHY18ukk86eWXLsi/y+ezclZ2TrsqX2D7bVU6lVBXXJXUVX1xR5XKxL5dUv7uBbgAzS4q7s9/PVnEH/f/9f/////d/9L9fv9+Sfv3/aerM/xFdPvObZz4d/enoj0S/+bh7EAAAAAAAAADACaM4G98OHf2V2sjx8uXnS7PxG6FjvP43d7wCc7O52fi10BFfaJrJzsY3p85k/AwXZuPbi0d/+eL07PdRZ6jr1MJ7I/888rH57537/tkfDNdnvnX6/zn9y0/81qk/CDWp69QXqXVq/WgdO7i7aYToYc3gCrf7pE+soDjjYkEECQ4FVpha32hsiaCs44Iq6Hms+DwTYm/drR+56UYEiIfX9KCIEo+46Yf3rkRixWLo1e/Rj3pKs4Ia+R6segIq+oro0XCMlAmRFM3skiqLRFk2wyfaIZymiuvnlZ4isJ+dYXL0wSFRb+jBrixMiA7oiHijA9Zq87GbxaDAUL4mZdO+hy+eer8ZE/DuZe9IttYXcx1hzRcqg+PIDQsGBFabqC84ltxw1mmCq5l5aDOP/yS+dOSmeyPKvfmmT4oq94iafigwkbMvVxYenB/fdG107XVlUb1nhLh6cw0f1mY1u1ZvMo3W2Gbb8bKY67Vmq6mtE6YN0vSlxuaGlVOhlSWa3r7CNBhaOScKFS2qkqVVFPQprZyz6mOmOz/Hh14aNqxlcLtZ9L6o7HMqv2eaeXNtPsZXguZr4PDIBKV8YHP1WArTQSkXPjN3MRKrVEKf+0F9eATJBR2veNb0ICl9WXd1gnfhdK3qVidaC7r2hqRu4cCV0ky3ot8q3b7Mk+DIt+50PVqXZzcVT8bVvuz8MFZO45cR9tbMP9IGz+JvCw0Hss2kjFo64y3YFJbtLFOY76hPERvYR1I/izgxdMeefdwidj6rxlOdWD3CUwXMPfopUcvn2hosO6MraY8aXcgIOu3u+KTTi86ZlaKoL1FvCwavbETO3iguHG76bT0DI3j6So3bdB4hFqhvvqm3m2OjgL6yfrTG+myyj9nYqbbXD7Wxm1fHLe6BVwTpoJS1B7Mf0hf3186ObtVdcoGXJMEb9uH450fZs3stt2xlfXPRy7UvZ4jkil3OtTlJ6Ep2wPJHfG0wGlHcXric47WmUd5mg54iwPiLFXcBvEy0T/HGrJEuCe9VA+L/AQAAAAAAAAAAJx/4/wcAAAAAAAAAAE4+eP4PAAAAAAAAAACcfPD8HwAAAAAAAAAAOPng+T8AAAAAAAAAAHDywfN/AAAAAAAAAADg5IPrfwAAAAAAAAAA4J3x/n8kfJt64gOn/uLUZxffv/D9kSfCt0M/Q1Ghn9H+pajwxuOuIzhBfPb7PxyJFYuhn9r0BJUmB0RSWUWVCbev+B6s+YaT9oj4xpIOCDjqDiethW41I9auVpur1TVGj+esK2VJr8vv+QYFXaJp2grW6RZO0BU6W9BT9ZDi/baiyh6JZDmZ1qTiK/GxYunclHJT6st49OmxQyVyV2UVLf6rFnk2IHyoV8gbuLqcShXT5XImnyvmUuVyWte60+l25Ylqh6S8ej1legNUq3tyt7+7N1G/bovgXFZ5Kd922IYMVlAZst4KreUyY76qnCgRgeW7fWlM6GqPlB292j7evqcSZWJuQ8qdm0h6DNxdrsfKhBuJO+uT7oo/659e12cXTcedZL3W8aTrCLdLPL/1mulj7ZiBarVcRrTlcblcEhcqrlI8Ub5dUcA9s9WOhXu4uBU5K15eONw3A0pbWfTA78OB60diX4+VHgowfTTNo1G1x+YfF3Bay0CbGazI7X7xpg8XW8ezhdEVj8IWQUG3H7ktHrSbkbPk8sLrT09hCy0q915XFtV77G6fk4WHZYlhvZYdavUm02hNtsP2FaauTxvmeq3Zampz2TRKmr7U2Nywsw/npHtLNL19hWkwdO+cM4kqdWbb9dNeLXvnlG5f5okef9sQcn6PSlmKrF8uCavhpojz0yvDE0Vhd4lEZE5bcizZocOuPPZ6zqm6sOu3T+la4G1P+dqBpcSRx5XRQtruRXpfVPY5ld8zB9mNxnxs/3JQgPfxcyQzNvnyjWvHV50em3zptQsvRWKXL4d+/OOe3Zyv8NhExnd35yvqu8uzTwgBWzztRKBrG8ngCfBuiiSG9iKZlHEmcg1lXy3udD30vK5PUTlZO00a0eyNX8b50B724+pkCwXVypkZwbawjGfZYnSGBJ1bfSTtM7Nr6gRld4vY+dxzaVzTV6vN1rJHuNqkL65vXkw4tsgYtihk0rmcR7kg7hJFHafeK6ltjAuGCpnwXVkY2y63iN0u17WGZ79hDSv3dsQZKklnHOgS2rpeu1w3tPiL6QvV6FAfmSuB+a09z+nTChV54jeoM//q9N+KMmeSp/959O898RuP+yIRAAAAAAAAACw+Ejm1vbW4uLCwQM3MaNc+bI5LZ4vpQrGdE7K5UrFU4oskU+b4cjuXzaXaRaFAUtksn13hSCazkstyZIUjJLuSFXZyqWIxVSrmOOprX6W+9lU2fGp7K7QYCoUt3eVihqTyfCbLEZIrFAiXTqdKhWwmVcqXufQOyXA7qXw2u7OSbZfyK7lSMb9STpXLK3khJXCldKEt7PAz4fDMNeqL/45645tnfpy6/ii6kp0brnibz+VyxVSuyKf5XLlQaufbeT7Np3famVxhp8AVCjvZVDmfX8nmdworOSGXXmmXSXqFkFI21y63eZImM+Fw+C+pL3+beuOb7OxwAUWhUM7kSoVslsvk2sUi1y5n0nwxXSymcplSgS9yQpoUC6WVQqFdWMnl27mVdrZdWMmXyxm+vdMu5DOcqwCKom48kkF+M6TXfHHRrvlOMSPspAv5bDmfyu3wZS6byhTa+XQ2K+Tz+Xy2kE+RdLZUWCFZopumtFJOFVMrpVRmJ5dPZ9upXDEcahk9enNmWD3heb5QLAokXxRyXFsoFbgyn8+1MwXC8e1UfkdoZ7Nkp7hSLKXSK7lUfmeF08ZkIdUu5vOEz7dTBVv9R+aHR3spzfEkX8q2S2kuV0iRcjuz0y7xJJsptwt8O0uy6bLQzudXykUutZLLkcJKWUgXV7hcuyDkC5lUgQjUG9+i3viW9v5/5MyfU2f+PHojOhf9SvT56P3onz6STgAAAAAAAAAAAB4FiZnt0FT3hiK25KTr6nlbctKtlTlbctI9kllbctJNgxlbctIdqfDyzPbiVPc59Ov/039Gnf6zM793Jh7lzxxE3x39NQxIAAAAAAAAAHi7UJ/d3go9tDcjIo66h/Hoed5R9zBeUZhz1D2MFxJmHXUP4zH+jKPuYbxIEt6Y3d5afGjvMMxRFBWK/o32L9H/BwAAAAAAAAAAgJNF6OWI9vx/4cwXqOiXo63on0SXoz965t+f+R/PfOFxVw0AAAAAAAAAwDuRZ2e3F0NTPfNecEQnPbyPPDe7HZruLYTwvCM78d37OUd20usI4VmnupPqMOOITlSbmN1eXJyqtqdnP0gthD5PnfqBpX/xxPXIi/O/MfeX4X8d+nzo86Gq9t/j7vl3IodNNnJ2I7Hw4PyQv2Hd2b3CcrzueFuUdoc8TxvpAU6FgzIvVS+1mIaPb2kjg+HoVvNbaThc9nW8rzsTbg05Pa94f66kNd+WGl6/5RXvz5XN9bVzhnL9t+182OV6WBNxOYDVvd27PHob6a4D55c0j9bNj05rVVFSiKwe06pGZtOqo96ZH7JVn5vOqs9pHownWNXr0HnUqnr6sFUj90JfedzzBUzJ4NIPR85eTSwcDjsyN0dxkBf3aWbA9H7a3TPA34G2KUnrkn4e2QczL0di6URoUDZ8Wg9Nxt2hmm+aVa/V15jrI1N3lyzRo/Xz+O91OftN0nZMivMfmY9tJib51TaLSXt/b5wiMx/GwAXgYVK7Ph+7WZxqSlpnWcd7vufw1dr20VWlfQ9/iKKo77zD+vm1Z25EYolE6CfmRsM8eeM7KevBgZ3G+/ofH6RJT50QIOgoIY2O6xPe3Boe1Tv/gSgQeTr3/COibj/7RiLflSTC6yF5rHoMZfdKuKIBOb7yfQSNUFd6WcaQD/ToryWwB1xHFJYdSSMKgmtfOjaSk1uuQrtDBLjKtgME2LE83Nm8QQMK2kvyesQmzVKvmK06ILK++xipyhpzqbq1rgVMsW03modeTiczibHRADxBrTzO/gNDFAW4+/csM8HZR+Ob2f7/jef/n6Gi/3V0LfqH0XdH1TN/cebrZz7zuNcPAAAAAAAAAAAnkXNz2zNTPuCn3vjmgkt80kN+6o1vRp6f256Z8kE/9cY3w/Mu+UmPzzX5OZf8pCfzmvysq/pT1GfGJT6N+hVNfLqH/9QX/93pU1+kZufeRy3eOf0vIlfn3ve4RwIAALxFeJCY/Y+2trcXt95DbW0PTl+mKGrl7OLi4S5FzcxQMxSVK6R0VvR/cto/JeunSXoqNzwcz6tsMSeUdspEyBOSyuUEoZ0XclwpX9xJZwoFnpSDSiu7UFRZlHanqZeokv3n+e7+PicJzF3C97Vb2c/L2t1pRa32tDv+XId7k/Cc1JVEnuusaKGvV9p9YZeoKzsyUfZyBbNwljML6xFJEKXdjz+lxat96oWnhtOfSj6l9Pf3OfneUy881SAHIrlDK/ckdY+oIk+b0k8ln5IJp3Slp16Q+p1O0tKy2uEU5akXnlKJoj6VfOpOV74lSrtrokx4tatpNKS5A07saM+s1ggv6vGjn3rh5ae6Ek+eSj4lEL4jStpfPCfxpPPUzU8aUaPe++xfPUjMTBgr+SnHyiQfS/pY4Tjt3M5nSJ7jcySV4do5kimk0xkiZMu5ghBUms9Yyb8Nxkr+RIwVPebSe+NLD1ZCo2MlZI6VGW2s5KYcK5O2hPpYyWcI4TKldCnLl3P5UrZUzBGu2E5ld9olgQg7QaX5jJXc22Cs5IbHArnbE2UihN9eg8WIifbGN9/7NE1R4eXHfS4Eb30enAu715XacdaV7FRXpt/9dSX7GNcVvsP1BXICFxbt+f9s9CYV/bPoG9HPRG8+7gEMAAAAAAAAAAC87Vie2QpN8yBmVhec4i78jC44xa2ScHxma3Gae7WnKYqao25R1K3o18/85unffuIfPTJr/Fz9RyKxYjH01fP6J0H2ByWipBKZ07+jUHwPvuT5QMhXRP9OqNdvd0Te/sDF9fmF+cGG9SmLJef6emX4G6PRjy3cH+doH+sc9YMeXrurNtX3PMOS9uc8Pl/xDOU2Wxj0jY55r4wVBVa91yO+KoZltE9a4lJ/v03keDJu3K2LGx+4uEQNAbtRI6qsdOe7otFE6+OcleHvr8Z9lOVUltxV3V82DSeNftI0JJEY+gosn87oZewTda871tyGRFB+qxhB3CWKOk6PV1Lrt0JOV6HuyYQThj7dcg6ONs1OC6qU2peHPwWzDvloM1KCdGn3ZYd0WYdGdZkpQbqs+6ZD+tyHR3W6UoP0ardnfU2vJ2hjXP/GKj58/zaejOuTnd/jpF3iPtwj8r5oLBquo31FX5l6fTWejO/zPZZ0RF5U9Ykc1z41M1YblVP9Z5+R4tTHfMoZT8ZlovS6kkLYnkx6nEwE97E7sqiqRDIOdTsHeqp561f707j3q/9p3rK2RPWb6GxfuiV177hqKJMD/VZy8KeOZvoFc21qd7q8dnc6KIMrnV5OJdNGMYKo9Drcvak+G3TLJvTOdX8C6NFkfwTo98Gf2T7Tcu5ZaTXNm+S3cHgkXBPVTiF3e4RXicCOGHKoEB9B9xoZKGXZ3VwzJnyX6pKxzyaGn4Zx+VwSFyqekow1RJsBEtdxazCXEneK0xz34RGFtEA4QRuvvhWyvr0cOTUYBbryXqh4mqt1uyv1xcroeYTWdhKS9t2uXUHXBDUXtAARV+sCRbQT6NTTMpHQ3E0Ywmz73tDAtA97B4l9uELHtW/UjXEjxPVucn1BO3xyr1gndt1M/qdrqweGJNznVOP71M1GQBnmnmFMGeP0m+VrZYw0RzdwxV4kTR3+09eTFjjrvE3R9T85VIBRtt7Q0ZK81hpbmqthRpm0/3iZdu02FCWCDWVoPuIZxVhpfSa0j6WOONT9W+FbnnsQ2N8uDz4lRGKXi6H7p3SfDL4XBqzZXN/ELY9fmLH5DRcxviLLzgVBcnT3nnSvRknn0sPxwHT8rhnc4SOxrWLo0HBK4d8AY/axZjV8ZVqmHbbqtWtb483h1XZ8q3iuUJLDO3HbOEFryeDj7Uhsuxg67I9pudTfJ7LIj216c/qmD6l7BG03VsQxrTdX6xo3zjWJf+3Tvoevac//qXc9smt+AAAAAAAAAAAAvAXQ3/8/s0JFfywaO7Ny5u8+7voAAAAAAAAAAHgLoM5vL25thR6aq6Kp3o13F/owfN5M9Z69u9CH4eRgqnf2Fb3Qxe9moWnt+j8cvU5Fr0f/weMeXgAAAAAAAAAAwNuN5vz24syUt0qor311qjshbp2T7oRQb3xrqhsdxvP/r1Nnvh79lehC9OXHbTcAAAAAAAAAAMCmMbc9sxWaKqzStNfWLpWTou9Me2ntUjkxzN+Xvz3VGwLXNJWL04UCnEql7v/vidDnqOi10+871Vr4Nws/Hnll/vJcefZ/C31u9pdm/gqj7rvGg3YvEstmQ6/f0v0j9hVul7C9bqfD7nBipy8TxefQD3t8I/oIGJ4Rj+iyUPNsscasMy2GXq02V6trjO61rNuXeTLq0WrYhdmQmO1wqttWiHww1uOUW8TOZ8TGYPmuEOSx0EnX/ahwPN/tSyprmEP3hKeZw/SuZKXuiNIukXuyKBnuv0w/PG6/OTp+8i73Sy5J2nZIN5olUSnk3JKalxs/zVrbLq9vXqTjz778UW5lJ7VSvvms5pfNxHIXZPj4cfm4dDsdGe4ql8+cc3IkVs2GBobjFJ8Bw8qEJ5Lql+JxlxOc1fCM4pPuqaK7q9eY5upIpfWjCeb2fOxGNsjXiV8l0j4Hb25252N8Zbwaq2AtYa8ri+o9S9doysuHp6RIrFIJ3U+4ZuuoXNDxj/jM21Ep38nr9mt6pPkrkbvqxNnrFbLc56X8XXDaw+qQ3o+c7W4s3I+qsrirD+ZRbzOsKnOSIhr+aMT9/b5uOVYgHaKSSRksezVql7VaH1n/0kXm0maDscwS4LrHrWLpInO5VqebzDqz2qIb1VqTWa5e3Gy0knTcyku78tJOXlpUaLsC8cR5mqmvHdKdY5vIcMT36Exk6LdMtPXSWvWxmIi9NR9TNo7i18jTnvQkiRsP+FcisY2N0OvlQBfEbvlJ6dcnOiZ2S/v5KA44Efu5lHKcFvtO7iM77Hw7+CB9RD46+a4sTHCY6YjY2xDPudbqDc1Z4/A59v6VvcjZ/eLCq3fGzHSF5fuyTCTV5RnMMquv/BSze5zO4cl9yRwAQT7MlravMHW6zmyfM50sjva9fk7QLMdcrzVbTW20mCtBmr7U2NywT0l0z3Zp1jsnCpXN9bVzzllNH2Saqt65UWdpluzQYVcey0ejTPa72phbShx5VXL52hYVzS72ivTg+Z3I2e3iwmsvj+1KZ8Ow2+dk4fj9N6TI6rRavck0WpP66hg9ofXvtD1hyh6hJ6wka4usjybH0bo5aR3/l07tDbxtsPyw04otYHpQtFri0q0Vq7ia5tdSazOdOMaQcbZo+6Kyz6n8njliBkmiO6Uc7I7zyWhU1Dfxw1M4pTTzj3NB6NjC44HS2Go7JxPt+n/+zDeo6Lein4/ejP7Qmb868w1c8wMAAAAAAAAAeOuQm5/fWjxLzUzzeN+8g6m9DDBn5spPn+uNb+Vn57dCWq5pHtKbNzepN76Zn5k6W9qVLRc26zhFaVYdv/ztXGjqXHbLvvxt7f3/+egMFf3T6GH0K9Ht6Ep05nH3LAAAAAAAAAAA8AhIzG4thqa5izBvSE5x52Du2dmtUGiquwWz04qmwzNG+dNoXZ7dWlyc9v3/uWiCiv7L6Jein462ogmMMQAAAAAAAAAA72ASczPb07nzCydmLdFJXvrCiRlba6aUzwsCv5Phyrmddq690263hVImnTX8GYQTYUt0UmyAcCJkiabzRT7b3hHa6UIxt8PnSztlPlXi+Ew5m9sRdjJh7fn/XPR57fn/V6L3o89HbzxuQwMAAAAAAAAAAI+dxLQ3AeYS094DmE1MewtgJjH1HYDlme3FqW4AaM//qXc9brMCAAAAAAAAAADgUaI9/8f1PwAAAAAAAAAAcLLRnv9HqQp1hjzx9VMfPhVaurS4sfDbC09GsnPfmf3Tmb8Ifym0R1WWftY382F8EIqcvVZZuH/VDI9xu0/6hFW0gAMST1zhLPa7UlftSiIfJDEUHmOyotGAJnroKiuLFhkhSIkT28ST5UUt1ojnyLiwELpy2i7OCQjBc5LUVWmZ7MpEUazoTxcGVOQsqSzcJ5NMpYjSboeoWuwGKz7SmzWaj0qfeDCW0HSmc8S1OB6bLVqznn3wWJZzVPrFzyp+OnJ2q7Jwf3eSAUVJIbLKdiX+TRvOpWo0Fst4G5nBTLwxTIKyWJFMLANU0oljWZDraNEO79Hkrqio1tgb9D6lz9LDm5MsJ3XNaGlv1m62otGwa4FWexNzrU1oozjBGizv+WTk7EZ84X7N02QiDZU+NMOIpMoiGQ7VMynv6FQalnXabZbgTKMRUddsGk6bbCIzh2Mqv4lU+UTk7LX4woPTvrYRBSKpvtNoGuv45Q6aOR5bBEUu8opaIX/MgD6ioIUNGjaTnjRiu8T01rMaETCdbn08cvZqfOGwO35saWF3NI++xxhaVtapLBc4irTYSkcfMVbZVmvf87FIrBwPDVg9npFRjOk/2C7OUyviCWDkn8GIXOTJ5o5YNNychLU+GqHIrIB0g9P3IrHL8dCg7KrbiDH7kni7762iYFZxq167tuWtaUB2vwqP1HJwcFePCXr46bFn7aDjvCecYOCpQpsjrpOvGcHOHRXUDOPnOpnY4T+dATIm/KctZIX/TE8I/zko3YnENquhwb4rqizf6fYFtt/rdDmB5SR+ryt7g8v6CbR9YsyOUeQONesnNi4orhFftnkwH9utjg8M61uBdHAad/jD/UisWg09WHUFh/WTDE75EZ8AsX5yb6H4zlqXiOPjO7tF/AMrThPE+P6KGjnLFRde3RgblW+f77F9uWOE0hsTQ3W60Hx+2kbP/LdESUgKotLrcPfYVxRjMz0hwKKWpxLX9JOOyIuqHlfPiK6oda6mhSV3VS3jsibvVp+Mv//cflcg8UQl3pc7Wsy9zQa9ulldZ5qrzLKeV73XI74ZtQyJZFzqdzrxxJMV44/xJ8qN1Zforca6JxaeuQkj2iFa6MvakDeWavMccv/7FaO/nj5CfxkbiIfVX4a2o8VTfCd0DZ7/AwAAAAAAAAAA74zn/6HoH1LRP3zcNQEAAAAAAAAAAMD0JEOz24szU7kJpL78be35fyj6J1T0T2BjAAAAAAAAAADg7UVidntxcapbALj+BwAAAAAAAAAATv71v/H+/19T0b9+3HUGAAAAAAAAAADAw2c2NEOFFrXn/wva9///Pvpvo38V/dfRv4j+z9E/gzcAAAAAAAAAAADgrc3cTCi0sKD9G4lo/87Pa//OzWn/zs5q/87MaP+GwzMzi/r1//yZv6bO/HW0Ef2h6J9EvxT91ONuAQAAAAAAAAAA8PB4bnY7FNJizrI5Lp0tpgvFdk7I5krFUokvkkyZ48vtXDaXahcXFhzZUprjSb6UbZfSXK6QIuV2Zqdd4kk2U24X+HY2EnFki0KhnMmVCtksl8m1i0WuXc6k+WK6WEzlMqUCPz/vyO4UM8JOupDPlvOp3A5f5rKpTKGdT2ezQj6fz2dnZ6eXnZnR3/+fSvZ0ZI6KUC9QZ9JPbJz6hbk/mPk89ZPUC9p/kUuRS+Ps1xycGhc51Q6s2OnuipIdvlYkCpsOThM/Qw2W9NCpnzulh04NFg1O2fOETg2W00M4cqpK9nuqHTrVHUfXFT1VC6GtRVRkTXk9jGryGKFXzTy81jm7RCKyrjYoXqqP5AUzaqrRnJFijXwdIu2qe8uWTGIokm8+ndF16JEgfRUYKbU6vRzXQkkekHgyrhBV7WiBoY28+q99IqmGAjOfc9QMQa0FvXQf1VTynMQTTVUyLnVVdqfbl7S/FXFXIlqszngybnebICp8V5IIr0d3twLNdmVhUqBZW8QONGsEbR2XzSVxoeIuR89vyBi2qVh20Q062uyE1m5L1LKcn6xZgYQT3vZBYbAYOXuzuPAaPzZeqvZDUlm9DCPM6fGjpY7qGo1tqycmdUnNKCqR90WJ6xiZxgdTXaJpPcypa1jJROl1JYWwPZn0OC3geNI5dkcWVZVI8YRuMT3Ue0CxlrmN6KrajKbpzfU1o6TKqEZdwFLqrU63c6DXQiB8R5T0P10DldztGWHR/TQY/aiVG1DPJZoeG7zVMp0nequlwpynfFdSZU4QeVWhLaPp8pJqRnM9zA4ikbNsceH+y9OMHCMo7kMaOm5lR46zO653zQky1npGQHi7FL8YuHvcAXEs6jEbRc3+PLZWAIC3FIPnBrOR2AeKocG+vqv2X4CFvn9Y+11z+a7V15jrAYu30NdOTUEL9LJAOEE7F7Kcmuz12x2R13aTSzS9fYVpMMZ5qWItv/H7PzKYiZxVigufeXLs6aenrcKKom2nD7hO39xwsMbm6/gnorFqR7czWmz3pDvu+tTx4F0FcT0tB9cxtnbM9Vqz1dQ2IeZpKk1famxumHHiOX5veWLEeJnc7hPF2OvadnZixesN0+T0P+IJzxly/A7DrjSt51X8g8O7z5xm3TwB4+9fHYT1Pn71znH62NglPPQ+NtQeeduB7tSe/4ejX6CifxT9wuNe7QAAAAAAAAAAgHc2ydmZrdB7n/2rXCGls6L/k9P+KVk/TdKzhnB8KZefLDxj+P+Tqaj8uNsIAAAAAAAAAACcJAanQos3t0M330PNzFgvn+9wQqGtvZ5fFFK5LMlypWyeEziuTXZ4rkCI7sq/mCnl84LA72S4cm6nnWvvtNttoZRJZ42vFcI8J3Ulkec6K9pL7rn8inJPUveIKvIr5hs6K/oL4caLy9Qb/4x645tG/L8/pqJ//LjtAgAAAAAAAAAAgKPw3MzNxWnvLJw+9S7q1MwnqKWLi++K/MT8wtxctHbm1dMfe6I984lTPxf+y1NPhv4lrA/Aw+f+3OC9kdjly6FXF3VfF7f7pE/YfaIo3C5hFV7ut213FffGJ3o8XowV1T+RV0Rpt0NUl98Jt9sL05ODJVNJm04Xbve1D+DHOl1wRGynC+ZBhT3g+H5/f0Jelxi9nEqmDYcP4xxlrDGXqlvr2qd2hiKXrNfpRTmVKqbL5Uw+V8ylyuW043Bh8OnBuyJn2erCoTj8TZvXacg9VtzXPIG0O4QVSIe4vlYc8S4S9DnbJI3WR2xrzDqjfajo+ohtpIypPArouWhnAIgKzfW0G8IrXalzz/qsLzyIRs5uVRce3JtkAj9/E8du/RQOJ1z+MsYbw/isb7OlD3GXDwi3ow7bZ8OQUw5dfNR3iZ3F12fH+A8uxU6H7HIdeqgjXKpUmZMUURuqlv+GTw3O6APxwe6kXnCG+cPqimGNo/3h441mih6xe+JJpys2G05PjB4eLefJiqZl9Phz6WP0gKv6oz1wbnA6cpavLtxfnbgUCERSPTP4ISwGIzpHe8HxWJR0nA8lLVc/Sbfnm4e1eFjV0tYOu2amxQYfGjwRib1cDR3Oeb9RH26b0cmsWefget0yjbVVr13bGvl6fbzWoW/ZR3QvOxZLeL9hN4cgRVGvvxX2OoNLg3gkdiMeOnyPblXjnE4kVdY8aHnP7TwnCaL2jbvikbIGnWHA6RQY9vPIak6r7A/RzXxPVuIv60LWAVom+90DItDcjvYxubPG3YwfvnsQi8R2i6H7sTE+DDqioorSLms+qGQ152ViV/IV7k3h1yBA3zhfB6aIMYfMj/C1SbTGNFcd5wd0tbk65ADBcCBkOUFITunZ6DAy+NuRGCmGDj99BLvsdrptruMr2z2GWQx146zy3TDF4IOD74vEtouhwTSmGDc0pCPY4OEOiUF28O5IbKsYGuxO0YYx3bh/hCY8hO7Tn///KRX908e94gEAAAAAAAAAAOCILM9sL0710cDpJ36disy8Qp36D0u/uPThpSdml2a+MfOK8R+sDsDDYmOQm49x54PiZdzpyrdYmXQIpxBW7e63FbUrEYXNBCR8cmOQPY6+dEDCJz73qUEmEjt/PvSz36s/3gmQCzj8cc8bCAFC+oNZPc0v2oYncoUp5QSuKOjPYkvWOwWGalEg+72uSiT+HnuL3BuKZGE+QPLoDciZqGQLHs3mfVNWEHeJoo6LseGfI1Ep5PQaByjUdF1e37xIx599+aOplTK3snPz2bheBb4jav70ZbLjX7pfs0by2OWPahtXdLcrC6LEqV3Zuj0+IcKIf46AbrOd+2t+d321eiX0hwnaSDjHd/d72ssR8aTxe4cTO9bfRowGMzSIrWD6DgzIYlswSOUYO+6Y8gei7m854JUXr9QFw0bGwT3CCewep+yNq/iQqF3hYRVjKqoFV+H0p8V8ty+piuEH269M3QX1AdcRhWXfTEakDrNmq9Vmy1+Mrjbpi+ubFxOJFyu5VNmYdI6k8fBamaLXgvLYVghUOsYc5mQd/46TLXKhYq1GWiwJbeT3ez0is20tnM1YFf7yFyou5aZmpd9Rp+oUl+hoV7j1uDqgkM9nC85rUJcH6fnYy/mxZ5ReX94lrsfvGb+jH7s8SB1ZU9rv6L3Djwyej8Ty+dCDbeesNCTkd+zu6PloSOLYL8J5TmBjV+XxJ7Gjn7yCTlq8TCbENXIktEHrvPiWGZyLxJ58MnT4vGNdvtPlbzl/HYxaUj9+dPvRFdqwoPZaBs91WFXcJ0E19sjoLxPataaomXXsSwF482jP/2ejG1R0I/qx6B9HvwibAgAAAAAAAAAAE9A971Nf++r0bvqpN741lZt+Q/jL387lJgpnw8/NzmwtTiec1q//z3ydOvP16K9EF6Ivo48BAAAAAAAAALxlaMxtz2yFtNcN2RyXzhbThWI7J2RzpWKpxBeNF9vbuWwu1S5OezXuUllKczzJl7LtUprLFVKk3M7stEs8yWbK7QLfzk57ze5S2eZzuVwxlSvyaT5XLpTa+XaeT/PpnXYmV9gpcNNe2V/TVC7qKotCoZzJlQrZLJfJtYtFrl3OpPliulhM5TKlAn+E6/9w9AtU9AvRP3rc3QoAAAAAAAAAALyzeXQvFhjX/x+hoh+JfuVxtxIAAAAAAAAAAHj78fZ4SeG0VtV3UVT03z5uewEAAAAAAAAAAOBRoV3/h2Zep2ZeD63CygA8Hn5OfXA9crb5zMJXP27GnTZ96B+I5A7L8boLbXewbi1Ct0tkOML0FLmtyNK1epNptLQQom59TjR15nqt2Wrq7n7NWNHpJZq+1NjcoE2P74rmVNoV090OrPqhzZoemFQLuTwkZB7Vih05eE4UKiPqzjmhm5doep251DLUW17n7finw80VjaKddEvzEk17I6faKeccV/Y+FdEroKE5c/bJbB3yb4MhfZAt25Fz/UqoaHHQja4gbs/6S1a5o5lcAXjNYNbJuChocbr1THbOoT7VsPrV6FW7knJf0twv2xaVyUGX1wOnD3Wmk2AqHG6YI+Dqxkl97Bh5rCInnHtldCSNhoyfSvGU/TdBkWU/he/2SMVnpHgEPPqsntHw1W2GLTc8xmvBll0ZNhv+efi+LGvBIKz+1LyO15q61+3j5X7Sr1GudFurMQSNf93NW55klEq8R2SlK3GduJ5xaOAOD117MTAz2UO4LeohqYfGrXnUVjY8bM30KZeD0bFg5T/qiJqkh1X3ZC28Q9AcGhKaqNccTOayYYonjO7SB8QU/bTPSdwuEeJBa8zbpKv8VlGBqBy/p02yhJ9txndqJS6QA1F6R9nFZ6JPMhLf4fqCPfaGa2Et565aKOKuRARWlOJJ6+9uX40fqWf4rkDuTlVmxVXeBHm7CLLPiR19gTVDG0zIqNfGvbxOu7r6LoxB4ypge9Qhuxx/b2hz5B5SwwJHGFFGDUcUHHUnEKho+Hw2bO5pMlY63TtEXlZlcX95Up/aY+xYC8HDGuKJpcTSReZyrW51dKNaazLL1YubjVYyvr3ZuMo2mA/XmG2mwVa3Wlc2G7XWDXaj1tyotlavxBPnaaa+pr3/Hznzx1T02TP/X/TL0T+J/uiZP45u4SoQAAAAAAAAAMBbn2dnboRu90mfsDwhBT5fyqR3soVcup1pZwWunE4XcoV8Ll0oFhcc0fROLlPks5l2vpjNkdxOictx2XYpT0okS3KCEHFEU7liYSfDt3khV8hlS7lSKl/I81ypVChzmXyuPe+I7vAFIU9K5VyJS+UKmXY5Q7hCVsinU9mdfDqVnnVE27lCvt1OkwInZHOFdonj8sVyli+Vijs7aSFfnHFEMzs77YKQ20mTYinX5nMlPlcuFbncTmGnnUmnSTgxc2PREM222xmBK2XyKT6VKxTL5WIpWxa4VK5cKJfbQla7/p+L1qjo/xT9h9HPR6Vo7XH3HgAAAAAAAAAA8Bbm/TMbIZ6TupLIc51cju4R/b0ZutPdFSW6K4u7ojTzzMy1RVuIbveFXaLSyj1J3SOqyNPm6whPz1x1VOlvCNiiYrsjSru5wtxkmfzsZJlceMn8/h8AAAAAAAAAAAAn/Pv/6N9Q0b953DUBAAAAAAAAAADAI2AmNEMtaNf/YSpDzVBUZrpsr37oQTly9mZ84T8+a3oqM740UGVOUnhZ7Kksz0k86XR0t0GsQlS1Q/aJpBpyRFJlkQz7K5tWx1L1Uotp0FsvrWm5Ny/RhruEzTrt0W54L9tcX7O8d5ivY5heWJht67hZDBHihi+FJdrS7dFHN5kW7aqdlruvVOJcm5OErkSEeFL3yeASESVV85b0itKVKto/bLf9CuFVy0FH/IDImouIeDJtZKVpzbFKV44ndWlyV5U5Xl3215iMv/+cIZ2wc+9xQlXVHLJodlIMNcur1SajOfCo06ub1XWmucos6+o5WebusR0i7ap7js+QaUt2FZNIJFOJCylbRUsrK67KfRKnmfUmQ8d3uI6i/aiv6Y4rDG8ipoczUdA7xMeyVoedX6LpNWadaTGGG5N9oijcLmFddbCVujyS6F1s/9QLUbp9mde9jRgln19i6ms//4kHpcjZZnzha4tBo3lHlLiO+DFjJOqe8440kEezW473nEE8Kk6E5IhRkv49EjD4NS8oWs8ua631K6CiTQ+/BMdTnDen2TVD2YyjQXnc9aw19Rnpn6oNDc2Hiq/2SlzqSsSYvEG1rhhj0EdkqA62a5jgJo4uFxNKHN9qyyGNu40T1iXreFCbfCs6hWkeUns9C0Vw47XFwlrnEpX0cbKb78TVhHiiMuSuUHE5CRryR6lYK8K5kbUgcZxaWH58LttuBEer0/NxNjhSLa9HzJ7lPKhO97Saelo0bQvUez0yZfVXu5JEeK1imj3NwnVXQ1K/04kn4yq5q5oJR+4n/WxU8T+XBM9IV97jFGtU+FilHr+t3X1RVYmwusdpwkRWjlkDHz12dbyn6yn7wH1eTsZfvumul7/CCR0zqtDx7GYOe316Lj+bMIa6oZzj98ZUNZHQx1wxWUpMWPUf0upmi05Y39KPZX17yPNmiuVgaKdodIexZ0ua27VjzYthvU6jlqfZfR6t7aN70IczNivZ786gdC4d3oonXQzKt9ygHOPtj47rFwCu6wjayP68MdqMBFHfkYjSAdcRBdP/nxX/DwAAAAAAAAAAACcXfP8PAAAAAAAAAACcfHD9DwAAAAAAAAAAnHzw/j8AAAAAAAAAAHDywfN/AAAAAAAAAADg5IPrfwAAAAAAAAAA4OSD638AAAAAAAAAAODkg+t/AAAAAAAAAADg5AP/fwAAAAAAAAAAwMkHz/8BAAAAAAAAAICTD67/AQAAAAAAAACAk8/pM7vU6ZnfpKJfjUZOHy6+slhZfFfkDyLU3NKZPzjz0zP/58xvPu4aAgCGKA3W5mNXnwlToiSQu8rtjqgSluurXf03e6cr32L3yX6byAqbdv+iPnv47sFqJPbMM+H7osq1O8Sd6pF8fbXBVFsM3apeXGdodxK9vEQbB0SBbjHXW3R9s0XXt9bX6QZziWkw9VWmqQsoy6KQoDfr9BqzzrQYerXaXK2uMcklmlaIoohdaawKU0bXouV5pStKRGA5la7VW8xlpuHkWr3CrF5ddgQuVOiUnuelRm2j2rhBX2VuLJt1TjplJ5YSdLPVqK227suDD0ZiTz8dfi3h2EXu9lWiuP6kXh21ipHyUIzSlQVR4jpBzbOStcbR1fqaLf8iXcjpreV4vtuX1LF16MndHbFDbKv25O4rhJ+YR5Nx5SEKUYfkjUqaSbU6vRzvdO/Ek/E9cXcvnoz3O6rMxRN6/h1OCexEM41eTiXTicA+dFqadBqQNApPair0nFv12rUtxs5k2svp9cGHBi9Gzn4gtnBYU2Vxd5fIRpcSldNHUkfcF1V2t8/Jgt51Vu83ape1mgcKL11kLm02GLpWbzKNltbZeval7StMnV5uMuvMaote3dyqt5afTdCXGpsbhkBC69tSupxZushcrtVpU7JRrTWZ5erFzUYrGd/ebFxlG0yrWqsza+x6baPWiifO00x97fDC4Hzk7PnYwoO8uzUcr4oHZKq2jIqObUmd2T6nqJxKjO42cseTcZ6TeNJhe0QSRGk3nozvcKLzM6GPXW2+BBuC3r7CNBj6GMqXdBumU5ncJBtWV1u1DzMeCz47eGE+VomNW1gVNqP/jzp8dlCeLKwvvwo1eP3dg1IkFouFf3LOXl/0lUWhfnRkTTFWE2tCuoa/OUU6RNpV9/R15CLT2maYOl3QjVoyFj2+IxJJZWWyMzRFjfng1bJabbaWXTmqTfri+ubFhKM7revO5AuG8q4xjdSuzB5nFe+2tdkqHhDf5cNdKUcyqE7pQrZkrHzGzGf5rqTKHO+zuKwxl6pb6y067Vmn3Bno5XQyY6w4xrjzq9/RR2Qyznf3ex2iEsFM0v8wMml/G0XK5EDU7BS0LNrp9qlNUWXC7bOk1+X3xtnSLZegK3TW6EeJ3FVZhdzuE4knQaV6hS6YJe8RTmD3OMUs1hB1DtaahorNBm3VwU7UKlDI6Z3nZNAKvby+eZGOP/vyR1MrZW5l5+azpl14mXDq2LO+S8K2Tb8nTMjlkrhQcZWiZzdEhlpfMQfdSEMTekuHTeUnbFYh4ToDcYNi5Ozm+YXDVe8ZqEM4hbBqd7+tqF2JKKzUZY06Bwj4n5uC1Vgr+9ZLa1o+c2X3yTL5XLTOVJsM29rcuNhsbdYZtraxsaWvZuaySlHUuek38YXBxflY7emxu1tj02Usxdbe7LXCoDptxrQ742cGzwwKkdjm+dBgQxcNsp1MVCKpYlcKEPi02Qe1+hpznZ6oZYkeY/Vl85A2JpPmBiaxMcjPx7jzobEtHC0xG5DwKe37/8jMN6jIb0UeRDYif3v+F+afnvkGrrcAeGvzgAyuRmLlcvh13rleVTnlFisQbedBJF40L11HjlI/NXoVOyIUfEGrnSB1cb8EW8U9NlDm+Je56cKb2BP4XUaadUyOVtvv+tGStq4jNRHtHFq7XPfTmhi+9Nd1K7ZY4H0AP50+NTyuesNEVvc8WfHpNGeDcnfwoUjs+SfDg+ecU6NeDtvjZCKpzgHqJ0dPf25J+2TnraaRyA7ZVqt9f1CLxFaeDA/iw0V3ZcHcKBkl/ydBJeuCQQXLYlcW1Xv0GtNcdZebG1yZj11+cuw+wlCfddXhJ3KDy1Nmy7iy/XhucGnKbGlXth/7yeqAicSefDL8i1e9C4Az6RXqc/4T/c1eX77Z+1yB16dv6sL0+MuKpcE7FPW6mWuauhek1kj01qj0CC90RUlR5T6v7R+ViYo9wkG6s5liwagxL4sqkUWOfUXpSr7KtQT2gOuIwrJH2Lin4+k4jy6n7BcrrgJP5v1Ke2EJyGGnW/2wkk4ZQzKdMiaY1FXZNtnpys6FuXk97kpwrrJdR+2zHd/hxH227VTCPDHah53s9jE7s0A4oSNKw6U7h53M9jE78z53l+VUlez3VCXIBB6Z4eFo3g+53RdlIrDajQ9yJ1DTiJylzbSoMbNlovQ7KntLlIZHjaXFSdeHgkruqvFkXBu85hjYFyWWHIjCuNslHhnfihxv6zK0D/HfnThLZeDGxLvAHWsDod1IYxoN/YRSq9dater6+g3zILMWVPDk2/VLNE2P1Me4QD+ClnEbnqHV3TWGh1KerNCmhYPnjP9EdGaSS8ClyW8C+WtyptX0mvzq6Z6eVrqzuYP/PwAAAAAAAAAA4OSD7/8BAAAAAAAAAICTD67/AQAAAAAAAACAkw/e/wcAAAAAAAAAAE4+eP4PAAAAAAAAAACcfE7Pv4tapKrUQmb+PeH/Ye6XQg2qeubBEz+0+OtTKjg8/SAUiYlb4cNd3V1xT+5q7i9lVu5LqrhPWMtlo0wOujynO6I1AxGI0u400qG6x7fz0QowIixMk8fldjNpepw13UzqWZNWVoXv9ojmrNIVoKgStwuMH37sARU527+x8CBtxvOwtPWIrHQlrqP5dt7T/b+6yte9l+qhdPSoS1PlGY74cZyCRoOATFe0E//J0vdkZXN9zf71XFpzPqmlO3FWXtQEnJ/BYUXouFU4bRdOO4U7oXJEhRYl3RuxGWjk1Y37n4rEbtwIf1bRnWJP15jppELrHmfa02XSHW0742nU4XaAo2N/P6aWol0iEdmwRaCL4RFJrzvacipVTJfLmXyumEuVy+npwx45Y90d2eiIQYy8Ln99K/NYAv/YDXIrMEvzJLm8rrqPB4YSMhcKl8EqoxpHwwN17n96PvbpG0HO4acbhGx6yhG+sXiXWtTX9Qffd/+TkbPiDy689ry5jFlhvFi+w/UFohXNE0XxaGqLkmCsK5b00BJ1NCXDi9MlZyU/yJb9lmlW3ZO1gEuioE0gqzRjsWKu15qtpivsXNqIN2fFMAuokhYKg7PXe+6cE/JMX/BEQR/BnDsOXrvbl7QQX85M0U4YW/XaZp2urq9PW4MO15f4PVaUtHBBCi3alRBHK7GUGLecdjTX8qu6dtrU7lpZ9/uKSrcJbQUcok1vxGYhtNElVozBi/c/ETl769rC/aZ3YIzrUvcZZ7K5/cfMtPpHz2iTS5x8Nhtn3UDDBp+nKIp68bh7tgfSg9nI2U9+YOH154Z6gBO6Pf0c3+t2RP4e6+x7nNO/biMzAph/vuAeOKr+0fmrTxLXxHV3z0gthmJMVuJE0s7pQlyfcUHTeZrNHi0v0fSHNmv2bkehe/re55woVORzTv3sKec+WNGq5GqDVhs9XS/XStV/6E7NjXTPBrJi73DiLpHRk3ald84ars7B8XPdKpo2C7RiLLg3UPqMt84+1nS37K+NVsvSxmh98JEHM8aImzn2iBMlhcjqoxtxhv7RaKUYXW/10XV490E4cvb2lhO1doopPHq9NHHSj14tHbEQ32ulicU+6iulKTok+DyE9/8BAAAAAAAAAICTD97/BwAAAAAAAAAATj64/gcAAAAAAAAAAE4+uP4HAAAAAAAAAABOPrj+BwAAAAAAAAAATj64/gcAAAAAAAAAAE4+8P8PAAAAAAAAAACcfPD8HwAAAAAAAAAAOPng+h8AAAAAAAAAADj54PofAAAAAAAAAAA4+eD7fwAAAAAAAAAA4OSD5/8AAAAAAAAAAMDJB9f/AAAAAAAAAADAyed0tE09ET5PzfzszJUzv3qqsPSdpa8uvW/mX0X/afQzM6fC50N/P3SZ+g71nbmPPu6agrcYg/XBdiRWjocPV0VJIHfvdOVbLKeqZL+nKmxXImxHPCCeo9QvrDaYaouht+q1a1sMXauvMddp/4xLNL1Z96Ytq5xyixWFxBJNb19hGgytqJxK6FqdXo7zHU7cJ0I8GRdEpcep/J4o7caTcbkvScZfSr+9L6qqLiMTvntA5HusTG73RZkI8cQLgw/PxzbiYUpvjXK7I6qE5fpqV//NemuZ9bbrv1wfbMzH2PLYzHrtBdIjkkAkXiQKm/E/Tv2n64P1Y6hLB6j7Oz+WHzQjsXg8/HNxlWt3vJ3ibcl/ZvZQq3pxnfGan15eomlRoFvM9Rb9UqO2UW3coK8yN+jVK8zq1eUOkXbVvWVRSNAXmdY2w9TpAl2tr9GlVCK5RBu6rOz1zRZd31pf1xLMXh1N0HIQmVWIoohdaUSEbjCXmAZTX2WatCmjaMVrWTme7/YldWyentzdETvEztOTu68QfmIeTcaVhyhEHZI37GEm6YOz070TT8b3xN29eDLe76gyF0/o+Xc4RRNpMZeZxrACM41eTiXTpjSReBIorideoA1ry+RA1CwSJG2nWxmMqeTXkGNPMr673+sQ4+92p8vf0v/a4cSOOQc7hFP0P8ndnj4J/SZmMs5zEk86WibDDHo21sijsFygAUfkLlTMxqqcvEvUkZE1ZkBZ7WX3u4JpJqMQb0KtaVRgs+HNUYkrRBLihqU1EwUWrE8TR0SvAL2mpTf0KVmr11q16vr6DfMgs+Ye77tEIjKnjul4H0nbLAJH9rvSFEpGBW0dvEw4lQhjusUlYefq94QJuVwSFyquUoz+JPK+KHEdd34jmyfF6Rz34VF1xunJOt0k9ZnlTjCXsqQ5Ni5tNpja5bq2FtpJ1qlqpGu1BMWtQTvNrTHrTIuhV6vN1eoao+k0ar88OlCtRmgrq+/YS2jtC8homdQ/s5maSCwl6GarUVttDU4PGpFYeSU8+IBzjtebpi8KCisTTrg3fJT6efMk4jq/j2Syz+6uFNss+s+k0+W2OT84uDYfa65MPjGaRWVG6vazHxy8dCQV6REVP/OZO4PNSGxlJfzj73POpy6JkRw/PXpWdSXrJ1bPWdB9dvUfQIEDx/c0O6xkTP6pzgPa5sJY749/RnCdByYv+Uc+nUnkrsqOPV+6JKxM5k6H1VfIwAXUI2SvYBzPk542Wh/F8i4TVb7HSl2VbZOdruy0yWr9cLKz0o2kHXvNTfktgdbEdK1Zxjip0K7e1hecAAu5Vx6twkb2Jz35XSvSyqAeidXK4QE/tCJ5tsIyOSCyQgI2xJ8PWJ/8VLiuQ0ZkbCvYB+8ZQi7DUBT1/kmXUi8Mtqa/9Mh4N+z/xQuD1vSZ097M/zme/wMAAAAAAAAAACcf+P8DAAAAAAAAAABOPnj+DwAAAAAAAAAAnHxw/Q8AAAAAAAAAAJx8cP0PAAAAAAAAAACcfHD9DwAAAAAAAAAAnHxw/Q8AAAAAAAAAAJx8cP0PAAAAAAAAAACcfBD/DwAAAAAAAAAAOPng+T8AAAAAAAAAAHDyOb34u1Q09GtUNHv6z5f+8ZKy+M255OInF19Y+L9nfzn0a6d/8TSJ/t6Zr0R/73HXE1i8Kg/akdgzz4Q/94zKtTvkTle+xcrkQCR3FPff1JdWG0y1xdCt6sV1hnYn0ctLNC0KdIu53qJfatQ2qo0b9FXmBr16hVm9utwh0q66tywKCfoi09pmmDpdoKv1NbqUSiSXaEOVlb2+2aLrW+vrWoLSb++LiiJ2Jd9ko3QiswrxF6IbzCWmwdRXmSZtyihaNbTMAuFF7cBQDqPGdmKtTi/HOZ4nPTWejGsFKkT/4xXCq/FEwqkG+4oSoExLYA+4jigsu0QTugVM06xWmy13Il1t0hfXNy8mEvSLFTqTKhfT+Yy7MEHcJYrqW5yp0iOYoCt0IaeX6FWg5b28vnmRjj/78kdTK2VuZefms3G9JF4mnEoEllPpWr3FXGYawyW5JC5UaKMvt+q1a1vMsqfnkj4d5RY2+z9pHr202WBql+vaALKTPPoS7n7VJZxkxa2N3qzTa8w602Lo1WpztbrGLCXoZqtRW20NqAEXiRVXwoO4KAnk7rAaVuWUW8MHqb9vToFafY25Tvvm0cocqZOWoNXJsZhWvdcuD25GYisr4Z/4gDPzXNlGiv9vRmegK/lRzUKz8qMJnKqS/Z7qm6ZpO+bMVPr7+5x8b9zg1ueLJefMFatdab1d6UK2lDMnjdLvqFPOUFvUb4Y6egJnKDkQBSLxZKriPMKjBXp1BRbJdyWVSOoUq4JX0rUsDKl4VOvC0FQ3jzoDKXABMAfh6NTXEiZM+iCdrmJH1Jpp0y4nHxz8yHysuRKm9MVEud0RVcJyfbWr/2ZHVorsyNz+5Q8O2COpyIyo+OIHBx89kor0iIovnOaoRX1bMPihwQ9HYkw+PLjpLJCWxWTS68qqYv32S6P+3uhaGZDdXjKH0l3jwrtykv1eVyUSf4+9Re4lrgxeno+9nB/b6uGS075V/ruvvm/wkUgsnw9/lnVW5CEp35y/NLoyD4mYq7On6hOXam9D6QqdLYxfq8ctybdEaXgVNorTE/SdDr9H+Fu9rihpux19XGh/tDtd/hYR4sn4Did29D/60i2pe0eyd0BaE6dcX21Rv/XV0TNmB6QLTbMDcgl6dkBuBQ99pXvEK80ZjpotDYT52NVnxo54c2tuLhPWHv4flAb81FnTnqxfHoQHNyKxbDw8yI+sCArbIZzimS8K9YuBK4ApPjzxHRsoKqeSpC7Ekrs9USbaaqGZhqKo9Yd18TYID3YisfPPhAfPOy2yWu8six4z/Mpoo0Zz2A0zk4b2w95t4ODM4Lph1w0fu3K82pW9dv2vxthVFw+268i2zLR0vye4alQakKkHSdZjna/g+T8AAAAAAAAAAHDywff/AAAAAAAAAADAyQfP/wEAAAAAAAAAgJMPrv8BAAAAAAAAAICTD67/AQAAAAAAAACAkw+u/wEAAAAAAAAAgJMP/P8BAAAAAAAAAAAnHzz/BwAAAAAAAAAATj64/gcAAAAAAAAAAE4+uP4HAAAAAAAAAABOPrj+BwAAAAAAAAAATj7w/wcAAAAAAAAAAJx88PwfAAAAAAAAAAA4+eD6HwAAAAAAAAAAeGe8/386VKYW/t+Ff7LwWuRv5jYjX5r9m9nGE8WZv5nJhR+EyhTzuOv4luTw8kCJnG1WFx7MqbK4u0vkO135Fqtyyi12T1TUrnyPPSCyInYlheW5HseL6r1gkdUGU20xdKtRu3yZadBT6Fq6yFzabDB0rd5kGi16sz4m09L2FaZOLzeZdWa1Ra9ubtVby88m6EuNzY0xuejtK0yDMQREoVJnts+ZfyeWaPpChU6XC6VCbukic7lWp03ljWqtySxXL242Wsn49mbjKtuqNq+yV2rN1mbjBvthptGsbdbZ9dpGrRVPnKeZ+togOZAjsavV8GBblARyd0zjtaTgZOq3TDPW6mvM9XFG1JKW6PFGWzYbm9RTRSHZlQVR4jqJwergdiRWq4YPI5Pqy/fVMdX9xrTV5fvqxNpaB8xaJskBkVRWIbf7ROIJvcY0V60W6D8SrUFvPrZbDVN6I5TbHVElLNdXu/pvdkx10mPa9N8OnhlIkRhzPjzYCrCOob/H7ZKANOo3JxjG0RBkFl0iqAeN9l8b7M/HnnsufEPl2h1itt+y19BP6jesCVq9uM7QQ6nLErdPkgq5nXiwPbgViZ0/H359VdcaULGgdv+6p5QAKXp5iaatltTqLUZbMF5q1DaqjRv0VeYGXd1qbdbqqw1mg6m36NUrzOrVZUv+Ap2iq/U1O/+LFbqcShXT5XImnyvmUuVyOpFcoq1JT7eY6y26vtmi61vr61qCacrRhFuiNHTULFpPqNXp5TinqmS/p8aT1l+sTHpdWTug9Nv7oqINoXgyLpMDkdzRjoq7EteJJ/QqKbpF2Vvknm8xHSLtqnvLq9Vma9klWm3SF9c3LyYS9EWmtc0wdbqgG6CU0pXyMuFUIrCcaptySK9L4kKFNnJt1WvXthi9ZUmnLD1JW5Nrl+taRwwPvwTdYC4xDaa+yjSdznXWGU1is06vMetMi6FXq83V6hqzlKCbrUZttVUfdOZj3Pnpp6txPB001r4+WBi8EomVnwkPKs6gNCyusDLhxZ5IJNV9lPra6LwcyWDPRzPFsUKXVYjexdovx6xau0sDcT529ZmxjbNKyniq9Kulwd7UWdOerF/9TGGwG4k980z4x1ac2WqmeiTfGJ2XZpI+Ga3p4J6EnkGp9azv8POdZsPDRFn2HRla/h25u++yarAeU0ZXpU/j7vGycfIuUVmO57t9SWV3iURkThW7UtDsCc5gTyb3iqL9lkmvc4/VKqib2J203xWI7+TXE/Q15naf9Im2dKiEyObK0e4Kk9cMXWh0tUjr3ZXNFAulN79guGb6o1grgnSOWnRU/fBsHb8YvcYMupFYtRr+ie8NOM9ZG4IxW4V/OOFsZ+9DvxsnvKHt02jn+vXH0HbD2iD698zRT6lDW7iA8TYkdcEccjLhu7LAvqJ0Jd+xv0TTNK2lsgdcRxSWXfLa9p7WreaeIG6Fzjx5sUJnUuViOp9Zoml3wYK4SxQ1uGhTtUc6USnk9HK9OrTsl9c3L9LxZ1/+aGqlzK3s3Hw2bpX3pmbk+F3zd3WWDhU9olpPd3Tbgro1R0qh17TsDX1q1eq1Vq26vn7DPMis2RMZz/8BAAAAAAAAAICTD/z/AQAAAAAAAAAAJx88/wcAAAAAAAAAAE4+p6P/CxWKfouKfiv6rcddFwAAAAAAAAAAAEwiFp7JL2p+b2Si9LqSwJIDUdB9V1HUDwbmwvN/AAAAAAAAAADg5IPv/wEAAAAAAAAAgJMPnv8DAAAAAAAAAAAnH1z/AwAAAAAAAAAAJx9c/wMAAAAAAAAAACef00/8r9QToT+iTn1n6auLn4l8e/6Lc6mZfzOzEPqj039x+udPz5z+vtCl0OmQ7iYAvC04TA8+ETm7eX7hPq/K4u4uke905Vusyim32D1RUbvyPVaUBHKXlbqsQDpEJQECqw2m2mLoVqN2+TLToCeqWbrIXNpsMPQas860GHqzHpRlafsKU6frmy2auV5rtpr0cpNZZ1ZbdJq+1NjcMLL1+vIuYbm+uteVRfUevX2FaTBGkihUNtfXzpl/J5YuMpdrddrU0ajWmsxy9eJmo5WMb282rrKtavMqe6XWbG02brC1+hpzna1tbGy1qhfXmXjiPM3U1wbtwcd1ox0yk43W7wncQzCaocYy2tZLa9XxRnvzrTy8MPhY5GztmYUH75nQSkXclbiOnmr8qUzZLkN6qXqpxTToWr3JNFp2m0xNZu8z2+f0/KJA15r6YKhvra8brVyirby1emszqLBlcwAkTT3JW6IkJBWVa3cIe4vcS/Iy4VQisJyaWKLpD1fXt5gmvayVbOV01SIZN+oX1w+aaS4N55c0CyqDe7oFX52ZYEGZHIjkjp5q/DmtBQ1pfwuamh6hkczh5baR4ljIKD/AQku0a/Yq/fa+qChiV1LoapNWlmhzAiuW3oqrDLpaX6OVc+ZBJy8rCobZ84O7kbPXVhbu35k0cO28w9WYdgDbOQIGsaPxsY5Vuxpjx+v9pwZ3Imdv5BderU4wHKeqZL+nsjLpdWVVl/IemtaA3lz+RhzS/N0dz5xjRW89LEuS/V5XJRJ/T9c3ZpCb2fURztkjnAsc4Zw1wq1yreH9Q4ODyNmr8YX7ZLpe8pR+tH4Z2yGPdUibdRi//n5g0I+c3aou3FcCLXVAZH16jtvfWDITbTeqbJpdjpXrcW50Psw0mrXN+uhWpzdQdRMebk1lwqDdzrFMOP2exzbhw2gzRVHvDdovD/7W4NOR2Afy4cF5fVi7tiqsTHgi9lSF1Ya2XwL1O2bz9Q0XHZh3aA9kJy6bv+3ZQ273NaftiSuDT83HXs6HKb1Oyu2OqOpjpGtMZt+C0r41/McPvn/wyUgsnw+/dk2fm35Svjl/2+pazZK+1aeXl2jabgLdYq637J0c3WAuMQ2mvso0Pdu/ZVFIaOYw589qtblaXWOSmiKz8dqqw2hjyVa1eoVZvbpsp1+gUwktg25Zb6GGpJ5Qq9PLcY7nSU8lQjwZ5/hb8WS8L92SunekeDK+w4kdIsQTuiqOV7syqxBr22GodTXBTNKrr2UQiMqJHZbvCsSQNUp2H9a2tVqdNht0h0i76t7yarXZ8ohUm/TF9c2LiQR9kWltM0ydTutninTGaKFM+K4s6AtgkFXcIhcqpmVeatQ2qo0b9FXmhmuI2aNrKUE3W43aagv+/wAAAAAAAAAAgJMP3v8HAAAAAAAAAABOPrj+BwAAAAAAAAAATj54/x8AAAAAAAAAADj54Pk/AAAAAAAAAABw8sH1PwAAAAAAAAAAcPLB9T8AAAAAAAAAAPDO+P5/KfQ71KndU+eW/q+lf7T0ocj/Hvn5+X8XPhP6nVAv9AOhH5hpPe46gkDWDxfnY2x5bJRQlcj7ohG083afKHac0JHj1Lc+u3O4EImVy+G/Q5xIoSNyAbm/ORotdERIjxdqRUTWo2a6AlUOBwwdEyl0KEbzUAzQrXrt2hZjhsc0I28O5UhUsoVpQ4hqdTnHd/d7WvTfeNL4rQUPtf7mOYknHTOQqKJyqhkRdDh8qZ6iqzTtoYclVYiqTopD6hdTdTggqdLf3+fkYVt4jKCHH7XkAkOPFrKlnBl8VOl3VPYVpSu5Q5y6D7tCnGpdS9PaUfaA64iCWy6ha3bXwq3ErsmLlUyqXEznM0s0bZiDHIiCFrHUVYmhprkK9AiPFunVNVqo2Wa9Z1hB3CWKOs6YXslEpZDTSxxSoOW9vL55kY4/+/JHUytlbmXn5rNxd1ETgrs6MhcqRmxXc8C4c1nxcZ0Ep1+coxcqbnW6LiOjMTQrrmGpN2VUX0LvaFPaGrh+smYrEu5CtBlVGZpNet6gERUwlhJaNHGa1qui6XzSV6mPzoQT93bwg4eRSKxYCQ+uOUGf3WuEdmDkoCipRFIV6p+NBn0ezmsHfPbJbwdOd6KbJ4fXp5cO5+djfGXsyu6j2lzb/Sr93z/4yOFcJFaphF9nnNXdRzJQw++PrvA+YvpC4LtAu9f6sYszXaHN5bnbIzKnakth4ELtnuJD4pOiK3vORNOffY69RtAV+hirxNAiHLz+HX3BpV+s0O7VzxmQQQuSS0IPNm3PqO7hbCSWfzo8+B5nQpEDfUzK5EDUTlWuY9TvjU6hIWl7BhnH7UljpScKhzPzsdrTY6eIqTPrLvqfFg7D02bMuDP+k8JhaNqMaXfG/+6z33dIRWJPPx3+qa4z9YxEt9zvjk4wI2V03xQUZf1hhle3eyLw5GSmWxkUVSbcPkt6XX5v3LRwy7km+1RTfKqJfeRo7j3uXqfLCVNNM7fs6DzzaPJMtHQ2nSoa88wSmryCeCVdK8iQijErSE/rp25fYfc4xewWowhvgnsrZxXuFnCX7ckYULS5fyOS6irYv5GOlKsQV9YxjRM4st+V2F0imSt/0GAdFdTXL2Oc811ZmLAPc0TsfK7zmb06WZNIFzAuREZXLp80lwnc+zJrSlbMAe7bZeauzJm+QbL2rsxetfH8HwAAAAAAAAAAOPnA/z8AAAAAAAAAAHDywfN/AAAAAAAAAADg5IPrfwAAAAAAAAAA4OSD9/8BAAAAAAAAAICTD57/AwAAAAAAAAAAJx9c/wMAAAAAAAAAACcfvP8PAAAAAAAAAACcfPD8HwAAAAAAAAAAOPmcnotSC6Hfp2Z/d/E/LP7qYnThxbmPznZDvx/6AvXG464bmJZXnzn8nkisVgt/dlXl2h1ypyvfYiWiqERgyc7O/8/euwc5cpwHnujHNNDgzLRsSWxRbdo5oigAJGbY6OdAFEij0TUz4HQDQwDNnjFF1lZXZXeXBqjCVBV6ZqT1ahuYoZ7hle0Nr2//ON/Zd6u40Pkkn+8Pr9eO3bi4uFNo7d2z7AtvhM8Xstd3a++Gn+db097w3UVmPZD1AgrdzRmy+f0YwWlUffnl68usrKzML7Fo8Do2jCZuYcXQB9+N/WapxhUbHGoU1zY4NFgYpZMIWZdlCbfaqoEV8T5/G99HDe5mA92olTeLtVvoOncL1bgrXI2rlLi6qbWt4bagOXr1tEdDBlUraJ3b4BocKhXrpeI6l00iZCWm1TEEQ1aVflyVagNVtjY20Fal/OoWh0rXuNL1dBMre8Z+OiBUBhXQ4kqG6FQ7hqi2sEePqcC+V66gdEoQRdw2sJTKpnYFuYmlVIYq0LCI5bbBf0ZXFVOLGdh1vVw39VZrKE0u8AdCU5ZcMhlUrKwjK82lYr3h1lCso7WN6lomgz5VQCvLy4sr7ugleQ/rRmA2LJ1uSVIEK0s0To8KEvrqRnUNpZ57/c35i3nh4u4bz6VoZKKGBVKWgoHKlQZ3lat542IkXiqg+Uwyg+qNWrnUqHQ/MDUrvDgekxUJ39PvNGUD80LHUOlvnpqFZU4a1tVmh9SVzudCbsS+u9FNTs3y+YEKDay1ZEVo8hq+08G6ofMLwddj/zIWi1VPsNt5+CPdmfjsiy+Of7ncb5f+bITl7jf8LdEv9TiaIA0rS247IzcEw8CtthF4T1Z0Q+uItPUNt1O/NGOrAaoG2Gvkxt3W1AOs8EK73ZRpE1dUq2C8zR0fyBJWRBwhIx5RJhdeJSfa5EioK9UaV75aITWftqos26+hjM8arHu6I0yEfAbgNObDavd8fPbq6nj3edraAi2Kb2NFkpW9wJux/9Wy8HJlnbuJBiogCQm2WeeCYGS99ptEaPsaV+OQbgiGU82mfCqbsp9ohqCRTj1z+IPdc/HZ4ur4YbWfJVuos/MZ8m9Hke90cHB+/rWVH+sJxGQrUEkShefKCnBbVqSsHUqWMq90z07NvrE6sMPzFWEuOLW//pW/130iPru6Ov6Pnur3T16x4LC/5u+bvDK0Zxq5S2IDyIpBRhkReiW0TtTUaGLKlXKjXNzYuGVd5NZD+yxv7CSqkD6PqY/A5s7eN4cKVkuTZL0tGOJ+KpvS5T3yvNGxYnck/Zod1Icw9Y/WuMY2x1XQCu1DLpstne0Q+0MQjzJmyOGV9w87fBpdQ4+F+fxqbnkh81j7dUnALVXh97CCNTqoC+sb/YJOF2l2C0HpjdRhZAMGhNlUR7mtqHcVq4qtR4yrbFwPH/sOOzy0SsstwZSUJ2hIKbni9w5NXddDhqasjN9GXBrChqZM7xxWP6yIUzO7ZGgmf9Yd0JR33+qn3HX9pQIbNVVpho5Ws2ZuQ2qIveUqPnIjKHXkOYQQLV0zdlICR02BXXiBqWBv+lJi3cz0B+Tw/R8AAAAAAAAAAAAATj/w/g8AAAAAAAAAAAAApx/w/wcAAAAAAAAAAAAApx/4/g8AAAAAAAAAAAAApx/4/g8AAAAAAAAAAAAApx/4/g8AAAAAAAAAAAAApx94/wcAAAAAAAAAAACA08+5J16NnY2txc5+/ey15N9N/MbUr0x98MzcZHb8344vj12OrcXWhmk41Lo/GJ978dlEb8bQ5L09rNGTVlu4tYM1vim3ZIPf6wiaxFzW7cNja+Wr5FjHkBDJNY4cYYzKlTpXazhH5Vo6ktvXuApK17kNrtRApepWpZF+LoOu1KqbLjnrAGDr/NdChdu+ZP2dIYdELiyvJNe4q+UKsjTViuU6ly6uVWuNbGq7WrvOb3Kba1yN3yhvlhupzIuIq6wf3u8+HZ/LP5vo/ZA/1zqvqLyEm9jA0TLNBLDzbB1AG5hnco4jd7Ncb9Sd7OeYfLc72h49E3hf1WTjvif/1Y11J/8RM17e3Nyi5/zamX+u+wM0892xkMx32pIwUubNAHbmt26sF/2ZR0dLbZfrzsXnis8kHuTY1Gpqx2BKibFReicwwYFhQqzU1DKswtqauis3sW2kln0Koqh2FHoqMDnHkx4ZeqGQ0nBLPSAng5Jzo2uDtZLzgj1aratRKr5W3Wpw/Ga5vllslK7Z1X67+9H4XP6ZRO+MvyC9DX1YIQ5v5mwBDmjlptiQRr6yFC3HriZudJ+Kz60+k+g95cuut4UPye3w9h3NWk64eZt59rXuZ7sfofk+/FxwvpnGHSXfA5u2VXtHSuiD7+vOxueKs4kvbDEJ1Xnd0LDQ4gXpQFBE3LfJoHQGS3sTewVp+EDWZVXJKviewev4TgcrIs7uY0Hi9wV9386QXYXc9iU7CLpQQKRWnN/Po5zVgLntSy59tqj7Yl+eMQx6oHCAdeADcmI6OY2ZnC6PLOvAl1j7kCXzOGLaueBLdkQFX9QuMTv9tHHZP1wSbXJV7ehmiZTrNC9OEblEaTLpZaqOFRpqtvVGjStu8sX114qVEseXK68VN8rrllH0Ut0n43MvzCbe+qDHKAQjgi04Qn4TMA9u9tRztUGrgmTUvF+gtWrJ1pIIpdl7KUE05AOcoqXQF6QnQYvE/pp8GyuSrOxZ54kzP0W11SY9iOuocTMQ+TuTCYrPo9Qdb4ENHhTalQJvWCsNmWSECis2OL5RK1bq5Ua5WrE7mle7H47PPT+b6N52VZWraw2uqCHd6Ul1pBH6UG+ndG4q9lex9x+f7n5walYtj8dkRcL39DtN2RwoqfQ3TwtVwbqBJd4+5hwbRhO3SG/FLwy+H/vfPt39/mOozw1R/1ux2PjfPO4SBIDHs/8/Ef+x2Mynz8vn/rOzn03+RXIi8bvxHzvzv09+E+oDAAAAAB4F3evdVHxuM5V4cJGdehEMA7faBjPxKLdaHUPYaWL2fuA8zICw/ldcWcparz9ZQ9Dpv+Q31ngd6+R1n1zpT05m+zOK2baGdWxkdwXdyO7SuRFbbg8rWBMMMnkiCbilKuwVUcMCGZULhjMlZOdm2JtXsdHgNm80+OJW41q1Vm7c8s/8fqz7ifgcl0r0xKDipMnkW6qiGqoii5GL0hMuZPrSyYYzIUTDoU8VUKla3ODqJS5tv5VuFm+m6V12YtNWYL2XWhVCp0usvzPZ+UzUUrrCkbmSSrXBb1Yr1Ua1Ui71p3Wfjc+VL7pfw3kahzkhYk/2MNO7/buBRRUaOGQakFEXcQJtSLYbxbo971DjXivX+7MOvcnux+Nzr15MPPxwSHZlCSuGv5VFz7Jfgb+pse2L/Evn3ayGY9kZbT6Di6gfCn2qP3NoXrAmGN3aTClPDKaglSK7tO2f1l0rnfZd6+cI1eA1u+5c95n4XCmf6HFsPUiYzDdhRZR9k+w0Rez9oGoIDh8y6+7T+Ign4Ne5G1xlnauU/H3X4Ub3Y7R4uqlBxcPMxR+peAZOzvs0omPkR+1eiM8tX0j02HlZGkVQPYc2sWiV+qgrktq5L8uoi2iWDzuBWfbU3eAsD62ooZUTmMZz534sNjH2w7HJ/3Lsh8/PwihvVN5648FUfE58OvFVuxezvujyoqoYmtpsYo0Ze2lYVA+wZn05tj/+eip+BA0DvlLYyvsPC2ve3tGg4TsdWcOSObPvTPxfCBJJmh9uzMYU9PHJHiCKTaEjYb6tqSLWdSfhpPMQmA9SwiU7l0HfpPp3+0NFKmWr7V92heqnv4kF3Uw2QluVcrWCihsb0ZPdFDqKuM/LikG/pslMyuWBKZdHSjn5kE+/qjj9VFDR2hrbWNNVRWi6rOFAFak2HWlMIrWBidSOVLxa34BI6ZJPQoO/1qFU34JRP6Wo1dENtIOJqe5hCe3gXVXDyHpdQLbtWR3Uj8sPzsTn9l5O/Oyq1cDsKhMktU308W21KYv3+Y5izulLpDLlltlAgoX9D8eRlIa0umy/zEkDDI3aWtLgNMkLtOztT4a0qTKaynVqHlb1WFdZwzFNhmngkqyTMadl/fZXO4/KLas52E3fH6NLhLXOY9knQq9Uy/3eCbVpX3VJlgqszVqiIcbskxtg1u1wox5k1mbbpF/d7UyHlvDQMo5UykHlHFDSB7KENV7rKIbcwrz9jh1UziOV9ChlfdTSZsLRXNj66Q+flJ1FXVTbuJCyjcsu8mHVZ1cg+b/dWsxiHWTKvjYrCookk5GXjkSXUYrB2aDxiJfMzoKkrKMXUvRXuGGx4alwR7JWCAy2hlGeXezza0jJZkZNZbDlHz0D/jFDP/VCaOrZIYBV5P0GehJ5shrro86Xx97DBjmsRD/hF+yFf+42HFIcJ5Jp5ylgZ2hHputHdLTj7pisADrS6dOSdEw7l/rzjJ4C2onUbeywC2qstTbZlIQNQdwnDTDjkddHKauBQx1noIDsAri4r7YwooZoDnk0bAiygmRDR3b/Yo96rMFOLBb70rviHayHH8Tjc9upxFvb1qjLLEMs9evXrqo7HdyxFk2Zf2LF0PwjrEgK/HOpLpXmyKlvh0exwIi2Z1td/yI1D499MjZ3oWAbHHPHsVlqaOaz+2AxHyDBG/saWQQnS6ysc3HQIitkGThje3YGkSgoimoQM8NtwyxMic4Z2O//8YuxM1ObseT29HNTmzOxs9NjwpjwuM0PAAAAeE9x+Onuc/G5UirRvRX0vTXgM2KUz62RPiD6v7Ye5+uh/dHU8+kwFhv728ddxsBjopvpZuJzV1OJnhpk3HpnpyXrRzBvb8CAycW+hDmzGGDxdAbRJed9e6Oj1yAJX9CoraO+tbZZrpP24fus1LvUTcfn6qnEw1ZQYUmy3hYMcd8emY9YZMHBg76xa3vYYNeuOCFbqoRDipJugfAFdZVntUZLza2NEXAmnMzv6iGqguOxZoADdfsijbz8Y71cv0G28vFr5cp6uXLVV2MP9W42PldIJb5yLtC83dtnoll25N003u571F019mxP0LYau7z6e2roxhln9iSbwvfa9BvX8N00rK6guLSOovji8X5KGx6NrSYoCtpSDXMX0E5TFW+79wMdJbq+ysBtSUfZdhTyjTG0uNhcBUbIVBcb9/C9R05nFbIH6e92n4/P5VOJ3jNBZu9emBDF6IetTvBb+iNZoGAXg//7/+/Hzsfux86uPLGfvD79pcS9+Hemfv3Mx2Zq57cmf2RieuyXYvffmcfpi91SfK6wnHjgchugYRHLZGXSviCzT1Jd3qMzOubt4B2n/qAhS/M8ypgv5Mw+zP4ivf5EE1mnZ8tknmdryqPSqinrqj13ZP9KZrK54ZvmylcrxQ2+xpW4MrFf7tUtsoTPXj212S3G51aXEw/ybPFZUQji7dHKzhtu1IK7LSsSmf+6bbVz90bVAMs2NdF9qroz20bn4VwlZU3SGirzhLR2yBsquyo1GbU8i6XrfLHUqNY8+0a7m90fjs+9uJx4sBxgj94lStHNcfh6peBCHbUE6bRmYKdRrNuf/uyOQ3eW77lKnvbgfRsd0UB9q5/Wuy/TAu26ela2WJgFUCMW6MDVUN62eLx89FLdfHyu8Gzi4V13Pg5kfNd2WsL4PaDXQzLgCxLm+sBUEukZMdTLidmG3M3HjMC1rttyKjFsf3n/TcExPX/zdb1mmE3Yt448LB1RdoCT93Jum/O24cP73csBTlms0vS6bBhWURGcNoxQTSfotYFmPsgpy2qAUxYmL6zfhkiZH+y5wZRDR0tt91x3JT5XvJjo2ct6vNbl7XH7dwIfYEEBwzrcvuwjrroBb8yHL3WXaYF0Xd5GPPlie8yRCmRwh8m06aPnoPtUdyk+V15O9F4Onv1rq5rvQeq5O3ge0KNg8Ajbln/krfNGtRbwNHylu0gLp3thSOEwVXy0whlY1R55dLTc9NLdhfhc/enEQ9eWEfvbuR2Jsw9i0GrXCCH9swfOB1LcEuSmf7lrU72LtbShyS06BeMWz2Ts+RRGjF1U4Ij1Vz2EjcKcTTrFOl3TYa/m6G+SYpdfMgs4rJdra+Ii65mmsN+MI7zg3qhVr5Q3OP92qP6aAj32aDm83/1UwHPYGrEGDqUHvJVEHUE/8s7cHDcGPIdfDHgOM3nxDXuHZT7CaDfqKNf3/h+Lxc5MTsfOffeJ/3H6W/F/ODk99h9if/mI7QUAgMfLF+IPzsbnbpUSX/1R7zp761HWX9Vt9keeBfYeqQFL7Afq8/dyA2Lw9viha8L0wFmm/kcX71pA71JAMslNhwDu6/4V0vYst53Y2/g++/GGuexfwe/ZBBK6vM0epQQUiLOu1B6HDF6+Zo5w7OjoGCgg4a5PiN771tcuz0pS89tNgKxr6b1HX6Ef2sk7M0Jr+8dnbheabSa4mX+62t2zqpVE7FUVsBjfXvjpXgA6cBWevebO3snSH2TIOnK2AqO7srEvK0hV+nterOTZfg0/8uCJ+JyYSnzBdlgavnaSbtEMao9BOwpHUBP8wa5jLpdko3BvLyOr3VkXd7BU8whLNQ35gLwg6ESs03Sv13xw/kHStI2no9mGrOhYM45tG6wa/6QlWMRjtIizD6bjc/jpxBfsmYXwqjSbJvth3n4+RrYGv4qw3XCWpNHR7HUrdmTeDXD9PsP2WeAOyq6sOIFuJWRp96hLul0TC0MXdbukT8oydrBI9hhYibTs4bkHificuJr4gr0jObwyyR4hjYS2Fx85KWTuRLcNnzp/TxEYAfsBNnT9EjxKjrrq39mbxpY58/6fHP+z2MzW+dfP/ssnLiRfn35+6v6ZVyb+dvzP4JUMOG10p7ub8bnV1UTvBXZ2znIK656ZbGu4LWiOy9jAWTpvwJAZSq+qRzxVyV25wpX80/jdcncjPldeTTywB5NsnkLcII1QKlH8IMkSbrVVAyviffIO6PhDslSQhSVZvbNjuxmTFd3QOuYj5jO6qrguSPIe1o0AL2NOmhk3Y74qiViG61ylEehs7Pnu9fjcZj7Re93l7QVrLdlcjnCng3XfBzDf/UAvMOFKwpzgeEM8aoc4XG2zbC6reHWLq/tt7+Gl7iu0uL4kDC0u1lHOkYtrsAOd8OJyLUQlu26pgG9FYyFl7f+0XaXQMJbvCMFw7Yo2RzquW/3JB1sgoNSZu55mY31kcl1jpOnyLCJC/nDNUrlXUVEZ39KqvrzeabUEzYzN+pu5q2G90zRos7Sd/zOXGEFMhiPEhx65TpW5rrhU0tK2WjYVdV/yy9IyZSXpheTxLbab7Zbjc/lCouda027ts/c0a7YuLIkgS/UFDmnOAer66/7tdT62iflPijhOUx9ecuVKg6sEfPJe616j5eVe0cBkmWnXo5fXwPYcoA4dLRe9T3Svxudefibx0OXEyzy/QhTagug+PMg8fyPwoRgQJGT9l6lk6NE31lkf4UffkFfS5xkN1orW+tZmulSsc9YifBpNyn4eplCD/F6wLtvu8g1BM5ybOcRt1Dk0TwqIOqE0Z0oZ6/I8XIemMYdeQivLy4tDz+K6Vq43qrVbPPcaqS32vJ7e2e4VejzRw6sBNeVZTzy0moYuImbrKHzt8NCFw0PrkCwVdk6L8Z2wQp9QViT9M1VG0I+qtXWuhtZuIScD61y9hGjJouHLlM16KF0rlive1XgHXc48P8k9ujwI6C6HVMfwDtJVG49sWE3zXrxBnB7y1cqGveTiMNVdN09Q+nxwzpmOL0rOB3Z1VgUfMank/X9i+mHs/I2z09MPH/fbGQAAAAAAwPuEh7EHn4jPfa6U+OJmmI9Txw8hr6sdTWR8zNN3FGuIOMB94TB/p9EiCF+JnbWCtWWJ+ZOX1JYgK84VTRXNV0nyShPgIrWfXvcEHOPj1NHtc2Pqvm1FPVDKSQ4jZb1t9WP0OQgMiTDQb2p4mgZJutPVl4y6AMn2LucUJzI1I7tS6Yok5UBoypL92bj04Flqg1+oH9UGzTUi76ANmhGELz8BM3rsZtTLPvh4fFYojT982TyqMbxqbPeYGm5r6s6gvmusallOubLO3UTRdQ7tZdJNQTd4dUfH2gGdJ87612iQDsFaThjaEzihzG4yYFrflGP9wpo7QJjzXW0vseZ0Gl2SOrhzidaxDLQG8vihM//91bhWcfVdhjs7VxwRazlNRGebGdbdqGvBqT9SdkGNu5j9qbBWTbq8Y8h7CiYdBfEpYf6tdgziKKK/RHVopKqE70WKs8DEN0Q+wnrT4IA0Nc5SX/Kpp7/+1xb2LCvuq3Nt5h20pjhoKXGxjpp4TxDv9yPyLbD1CrBrqoZYlJlCnwJmcXVgRfmdUYcoClnIPFLAArP8eFidOjbmGHw0c5PwwXDziWzipGsP//6TRJ5V8WTXmjd9tjMBZ121S8i6SvpVfzKHV9oGd6XhcsE6eDk78V3gM3fTbTGzlmxU83P12C7TM7v3wVXW3+UXEIN5PBfrrqK/8c8nHtR9yhJZB97vKgPNzuNh3ToTjHqS8p+61lfmOz/+SP7lXebQv+HeeBAgMHLTdhdagCKmBKIUUyTFES1giCK3M+8AW3MJuPSxnXWg7jB/91aHExhG7Gga+Tg0aEfGSKEvRH0MhT77hxWK17W771k26tJfl91aV71e2P0jnMjPs+AR0qgWNUwPs6J4gMb++uJhet3rr5MBz6/h9dQSFHKQS6Drn/dQVY00mB3l2f5+KhcY5MMgHwb5j2CQH9XbGV02xJyRu1mubxJHoMz3/8nYk7GZ9LkvjJ2LPRn7AvnvUH/wanyuMOteuqGHLAkOWr0QJBt43rDYlMnQQsO7WVFVNUlWBPfyw6xKF//KB9g6Y9g8F08QjaxuaFho8bitivsBJwkPXdLrXev10wcPbsTn3phN/MIEu26DTZd/87KzpihwEUeEsMHriwb7gYMXuUfyIhdskUd/o4M3MXgTgzcxeBODNzF4E4M3MfjcAp9bTsHnliEvGaVqtbZerhSJy+nQ17De0w+q8bnq04mHrpNz7DEnTbTz3jPQc8PQcAOcKR4s5r3vWH63DV63B65Zrr6LJJeWC4WFSN6F6dDgLuNS+G7IEJx12GBW4t3gOCNU0Dr3WrnC36hxda7Bl6qVRq1Yangr6LDxoBKf25xNdKtsBZkF7Il5yCvhgDCDXwWDynXoUUZD8kXe/8cmvhab+FrsvxubfdwL4QDg/c1PNx+k4nPicuJb161+hkye0VVLGtbVZod+g+XJZwHdEFpt8shSd62VcUGinh5oBG3+zigosHuTItlfbHbnjqzjIdc6fto6v8Fx9JuxnrPODIraJo9a66eGFaFFpk9oN9efAaPbF5mz3uz0UIcBn3opRZ5QWOGFdrsps3u17UNC7E3KrmUhdG+jqwsl84PktBhyOkD1Na52i2+UN7l6o7h5wzkwYKvC3bzBlRrceipDutQXI6ayEJjIvi9AkkSerq2jnpJcW6SpP8LA/DAbgD0KWFHqzW7E/N6oVatX+nv8jp9V3ycx94DAb0EtKkVXjzg3rf2pdukgujIFM/ZVaNkDhbCTf1uX+iNAS9S0VRLSY6004djcUN+yt9PbYxBa4PgefTSnsbvGsqmPU/FUZkg4X11HDhkQoz1Qa9APwmWiI9BB2ShpOabOQam0+6EtRTZSmUKqo8j3+JbcbMo6FlVF0vmDXOpoiT2SauN+GwcleEfQcVNW+u8kW+ayzyJVTTac72EtNKEjKkRrXGOb4yponqrKz8+v5vL5heWl1aX5fD4XmOaBZTFSYqNqGjGVo6p/6TglyETOWGp/qW7hSElitPa/6KfNJlpwP898p84HO7gblkczVKOjKaTVeZTaj2D6Nu34CTBVCuJ+wDMkU1g5gg7XYyRDX7JYFQPbjTsDhZSB7xnewhleFx4txyo1X2xs9t7xyHzB7ZXodbpCPGWNjYQdHSuG52g86sxN67RdB+UFxuj0CN68Edtsk1CFlKF17I9U9kyK15KtoZjPlg3ZaOKhBeM4Y6mY47njG+/y8Y03N3IFebJxzGwPrh6zwP3Vc2KDN+v9Pz52IXb25cTvxeNnvn/y4vhfj12IPfW434PeNfQa3UZ8Tiwn3oqzEz+K6VjI9o5CnTm1qL8G1lPuYNGgyaFoekNckoQGjnqmnM9tS7GOyOpUcziMfV6naBNxfL15nE8Fjnx8/ttSH79kJnvTGtFfx/dTGarZyo4z1Cdqh87mVbh6g1u3vbXVuUZjg9skvi88E1/d+W49Pld9MdFz+R+zcsO+HXs8lfgEBjjAC1QT5sHEF+TxOAmscfXqxhbtR3wenYRujZZZtzS8zFgfJ8cos8G+T/xlduxM9u50X43Pbb2YeOuNIZn0tfQj5zNC245iHo+sUeNLYecMYjuodSKo58Tu/o45fKnv1TH4Hdvv2dGc9fddHt4p+Gvd+/3lte6N+FxxNfGW6+wyKy8Bbr5G8IIZyeNXiIPQvndBxz1X0jXYOd1ewRaP7xXsrR/pVuNzL68mvloOqFm1YxAP2kerWFdg/2c1+7blldT+SZ96u8TZpPzZIR5JHQ9/Zo2Qpm7uGbUrJeutCPvgebpvnvFa2VFuK+pdJfAUbtNLtOstwr/hIqBf8fdIpGfRmPkzLaQfCfFWmXmUqQ8dK5FMKEwmlBEyQWNWLllVXXCSymbO/kTqNg/2kBjPHXq8OhuCnbtm5el1R9plYow0ez1yz1ndapSqm5zvYfmFQrcSn3txNfFjHwxoXcwhAaO2reHnC0Twrex23crWBnm/ZQys38sFWJiniWUDTC7rmCitZo92b2cZyYoHq3xPtGfnxTytOU0i9MOMsxHJSrx7LsJRYGZRUa3UevPIaLKv07flR1SEj6FTidqC641ig+MbtWKlXiYjIPv7/8Rfx6bG/zw2/ufnN+J/EP/8FD5zaeKvY/8gFjv7SFcDfFXqbsdnq48ySuD9SHeyuxWfe6Oc6Lq8OIfPu7hfZU9oMmfYi234TM5Rpz+8T+5YbGz5cdfFe47uYvdH4rNqdby3SL3bONvjyWClKbdk+vgku/CtT9a8qhBnNKJ6gDWyBWpogNj/ZRnSVqX86pbt8WbkeEzHN0ODpfu77rO28K6s7GGtrcmK0fd8wzwbw18+simhtSPvddSOTo4wxoZ2n6Qllek+2b1Fi617P2KxOZvH7sqKpN4dXmz/p8tD0MgRRC0v+ggfXGjZuxjfbtqKTQU68SxkT3DYfpbJ83une3NqtlMdj5nOku40ZYNO5qn0Nz88H7nhRfMH1rO1Ov7Ty3Qf3tAgw3X+W7u7Iz3K8HKjIyZv/hHxuE76yhu18maxdgtd526h4lajWq6UarTTQqVrXOl62hfQ/tScC/zUnMkmkfdYEdTgbjb650lZjctU38TKnrGf9oTIoAJaXKG6mMMj3Wpq3BWuxlVKXN1xlpImC5qqFXtyt1Ssl4rrHNGiavIeXffpdUvhlIOj10xXeIAI+be3GUWPbkAIO77wFIWmI6CBeArRVQlBnRAqoJUlc6F2gDKi5+pGdQ2lnnv9TeHi7vzF/BvPpWjcIQ0xrADCxAcvbKAxOQ7EOrp5LpqIFQPVuOKGr1IDJe0o8nkaR25+nqo1e92g4jpWf5x1jiohTsdUnb4l0WxY71g0Riu97GsXLROitknW+NyvYQlj8/R6RSVnmu411JoloqglDUtkqQ3V3FRFeriK/WrJRuG7R+Ny14a4Lyh79ss3tQGnA7dvmRExu4DD7Lwv8VIBmQXNem0LDsVIvFRgYqHBTRH6bEh7DoOh9ekUoudIO3/OrQN1zVmcvjarlnzKBipyTkx0KevPIvqNYDT91sm/mWQG1Ru1cqnRm+++RofWD+2TB4ePgpkvayc3tB74ne0d+0hKlxcGfpMjXqyowyrns4nzAWXAdxh6Lk7wd5jMib0GkO//sQ887nE1AAAAAAAAAAAAAADvJEnyP3j/BwAAAAAAAAAAAIBTDbz/AwAAAAAAAAAAAMDpB97/AQAAAAAAAAAAAOD0A+//AAAAAAAAAAAAAHD6Af9/AAAAAAAAAAAAAHD6ge//AAAAAAAAAAAAAHD6gfd/AAAAAAAAAAAAAHh/rP+PT347lvyJs3999qee+F+m/9mZi5PfHvvpsQ893nQ9vNEV4nO3q4kv3TE0eW8Pa4Ioqh3F4DXBwHxTbskGr2EdG7xgGLjVNnhZwoohG/f5vY6gSab4480EAACPhJ3u/tRspzoekxUJ39PvNGUD80LHUOlvPrTzaKtNWZSxzueGisT+9EvJ7l58tlod//ExQ9hp4qFBhuv8k1KNKzY41CiubXBoqDxKJxFqa+qu3MS8LKEGd7OBbtTKm8XaLXSdu4Vq3BWuxlVKXN0W09OylEHVClrnNrgGh0rFeqm4zmWTCOmGYGBTR6XaQJWtjQ1UusaVrqfNO+UKjQ+hlCAa8gHmO8qO2lGkVDalYVFVRLkpC4asKryG73RkDZM7d2VFUu/yeqfd1rCu02tWcDNwEqFMhkRv53ZXVvaw1tZkxTATY6aBxhwkU66bSa3WrOQh1MTKnrGfDpDOFFaWLKFiZT1QH8n71Y3qGko99/qbwsXd+Yv5N54jyUQoQxJL0noX49vN+7yVOVopOi8YqFxpcFe5GpvkUFEz2VSmWgsVW+Ma2xxXQfM0vfn5+dVcPr+wvLS6NJ/P5+z0aPhA1mVVcRLgqUDnvq0uF6iO6hI1LBhYYrPj0cZIvFRA8zRUpy0NCcVIvFRgYqHBmQKzK7FvdNHtLTOkbtlCN6WiVE+GtS0mWUNtO0pyrEKKmCRWmlpjMoPqjVq51Disd3fjs/XF8e7ztJPr6MIeJj1Fk98V5GZHw3p/TKRhEStGgEjsj60eqFxZ526iCErMhFcrQbJ2mTF9VDagHLK62tFEzDtWus7VS2bQTDfXfT0+u1cd763SbA0b9+m8qmBe74gi1vWhwrF/Z2V3q1J+dcvO9UhxJGnmhwYxi2JIOYTUPKlntH2Nq3FI7Rii2rLsjwoQm2tqWJDu17CEcYu0gsPr3Tfjs29sjh/eHVxoGt6RFUm3UzlMLvbvXdYRVe2QIrKk07KEW23VwIp4n7+N72d1fKeDFRFn/k73jalZfXPkp7mdjNzQfP3RWxPdT8dnNzfHv3x38LPcCjFU4x9Ge5Jb4rR3sfPrdKDMk5z0kZ7y8TypmUf9cGP0qAoZEOxqaotvayoxc34PK1ij3W1YBx8mHuGZY6gjxBMsHCGW0BGGJ4IBwwdUQCtLIw4djvFUHZThl8Lqh4Y0OzRfmwpU1X+IkPf/6fHfjJ3/3PmPTicTv574WvxP4jemVsZ/E15cgPckb/Hdz8bniqnEVwVr6kjHOhll8Iag39Z5c1hqzhK57tgdeK18lbTW8FDJNe5KtcahrRvrJEC14pZNbl/jKqjCbV+SJXShgKob65dkiTwTa/SqLdy/27/CSIn7WOo0MX9bVvqC7MW+LNOTWIL9K5ZUtWENaO0hGpGScBPbfZRvoEwU2wO0ApG2fzyf80j1B/ovEbn+T/9gOlKsAwVoMRiC0dEL1tg75Qk++G5gljwyitDC9D75w3OvramttkHvmn967suKgbUDocm3ZKVjYJ1Kei+GFmAhoAD7+VbwPYOXOjjo5YBJfV+K1gfzm3mNWOOuliuozm1wpQaqFct1Ll1cq9Ya2VSdq9fL1QrfKNav86aN8+XKa8WN8noq8yLiKuvdJ7v343MvpxK9VwObmDkEGbGFMYHsBlau1LlaI6SBpa20l6pblUb6uQy6UqtuugWtMXS/eRU87Y8Umd/aMuR5vLgQtYg2ypvlhlUyhx/t3ovPvpAaP5TNsasri1IHuy7E3nYNr33C5jjadTnN1GaWzOyYWfRngubN0xQOf7B7Nz5bSI0figGp27nPWxfcifyrAYnshwlKa7+ks/0OaWCqP9k9mJrdTIWN/N2RL7jT+R8/2e1ED5xzB/5/vny2a8RnU6nxn9yiLwSu227Zv3QN9d0WRzq6oIk5c2AnS9ZwUSfS/OvzF/PCxd03nkvR2rKGobKUKSxepoM6xlRDB/92nYXP85FebNC4t1SsN9JUqFhHaxvVtUzGM7rOrZjDU7PHG6rLEgvTtrCykFtaMjPoesoFTkWyEoWUtyc1B9veq2FDbp+ck7BlM5/z85fNnJotJ3RytKOzE1WpbKotdMh8UOYEZ+fMhLj6fNdso/dpYM2JspcHTyaO/p4SQd9I84K2PiaKUMVsZ+Eqh4C+r1pjxUeJxXmNyvbbnm/CMlpvS6+FPLLJoCiSLsuuAnUN0mMX+Si6XNOLb3b1qdk714d1pqKqHGBNN6dlye2W+WduiEDs/+6NdbX47PXr4w/MGZghAYbp+4vATjlE2pp+cXeuId9RhvevbU09kCWs8cY+mZfz99aBPaQ3SGhvOW92BFghpTSoYTESQxqqU8uw/h8AAAAAAAAAAAAATj/k+/+Z878Qm/nVmc/OrJ7/y/O/8LhTBAAAAAAAAAAAAACxWKx4JrGdicWmJyYEUTT41SXp8m4eS8sYzy8tSdLOsrQkXF5e3c0trKyIOO/eSBb7xW/FfvFbxUmXCkHA88uiuICXBXEJzy8IO0t4YSWXW8DSYn5pRfKo+OZ3Yt/8TnHCnYqFy8vLkiTuLgj5pd2dpZ3dnZ0d6fJCbhEv5AXRm4pvfC/2je8Vx10qlhcwFhYu5y4vivml5cuLl1eXsLC6M7+4u3NZwtJuoIoxl4rc8qq4uLMr7eRWVpd2xeXLu3lx/rIgLuQXl3al3QWPiq+/Hfv62+T7/5mZF2Izvz3z8zO9mRdmboGVAQAAAAAAAAAAAO97MhPbY5HmHc44ksOmFyb7OofMIkw4ksMmC8bTE9vTkeYEyPf/sfHPx8Y/H/up933tAo+af/yjD16Pz72+nPgfOtZG4ruqdpvX5T1FaPKCeNvx9SJ0jH1Vc9w7smLELZHcNry7iyNq8u81DtLd39NvbkMUxNvmPiqyBYe7Wa436nRPkbVZOGduRmY06WR/j/lnEtn7kunPS/a2ZDNG6gPA3Mxt3TdUZ7eVJSqIhqoxF50QASlJItfGaJqOfhH0N+++Ui1XHJ9xbiHrKvXp471IUu9Td6nv9iiJ0AZ3pWGqt1Ps7H7y1glxcVekruus+7Zm02taJeAOs507ICFW2ZilExDYvhScB1P6YDHvVFlQDIWgenKqxB/C5+cslU3JUhNb3sNIoLS/nP1eXJx4BW2P+PqxypJ18+K4BXBbKcFtqU5mtY5iyC3c97GED1TR3IDnNor+DUuht4D6Aow5DLMVxn3aIEVMIUQpqUiKI9rBEEV2+emi2saFAItzCbj0Oc7TiN/DIN3UcAopDTexoMvKnu3awvIoGBhG7GgaJi3Mqk/iR8rtVGPE0BeCMsXcd7Sa1sfYtHUnPaxQCqk21nRVEZpmF+sxXK/pOp2KFcgxYeJoS1b2PHZrXXWUec3Wuh+xW/Hbgh1+VIsapqe/U3SQRkdoqF7LmNxOUjK2A0PismV4PbUERdizdxQH9DHvkaoK6pAlbAjiPmlkmaCyGVyphZSED2TlfVUuAQ19WCGJTaEjObbnTYXdnTOpIA88LPGyksraf6sdIzVSzYiqhO9FirPAxDdE3okCtwS5GeCbJywgTQ3bvUbtXQM7xjC7ChlmNfGeIN73DLJYk/IKjGBRZgp9CkYdCYQq8j7PvMUdJWChqd7FWtrQ5FZ6WJ06NnakjuCkTDyTJP+F+yXartau8/Xy1Upxgy+WrvPFEvWOxBe3GteqtXLjFr9Zrm8WG6Vrlr+ic4lfjSUnJmIT35l57fwvn/sn56pnX3tCna4m/mRiYuwv4IUYOPUclh4+FZ+9dX38sGX6zu0Yqob1tqpI/E5HIq9WxJmqdmC+BVnOeodIjf0dt+PcSDott7mDZVmnWuZ106n2l9SHH4jPLi+P/8TnTYe2jBpMOiRFDLw2dsPtuDZAxHZqFeCmFhW3GtVypVTjNrlK4+RcVrUFYz/QiQq9QXvKtqYaqqg2ifMlTdWx5XuJungiwxUmDYzzp/4dxleQ7XjLJUBcvy6uUJ2hzqnoDZoaUW21BEXihTbp/wWSKvosE/cFZQ+zl9tYa8nWc5m5SrLQv2DmRWwKerAPKivFVMDnMGbZTLXWaVpuvyyvU+S3P9fkslfFiumdq6VKuMmqMC/4ddDrPqdhC6YTMwmLprerARmxZQYkJDA4vWGOUDuG+kmhScqS/knm3vS2IJJBa0tQOk6h2h61g9TRh6zL5bYgirhtUE/vGt6l/pOyqY5yW1Hv0kc0VohD7gOs7QiG3OJbst4SDHGfitNWhDXqHd3xVV+tORGYruD2iF9RU+STrwsXP8ubhw/QtDYF05NvK9SjGSPhOBHWOzvCHibu5oPDMPdRej6bs8pFpG/7gxwMsSIel8VmwyygfrMk7SeozdkesEICk4ZMQtKmZV9iG4bLd1FupK7+zYcfGeTTalgvnRvW6b/54AcezlKfVl+46OuEAwIM0/dGaNccIB3o0+pova/lnj/cJx9zf1BfbMkN9oflCIU5vjpW47cd8jkPynCffH2RCG7umGcg+0RmSsb+W5aYMxvEh0/G5+pPJ7oe38R6kPHty7qhavdtkWDvqYNCJotXGlzN70ZVN18hksi+Va40qihcD5tD4UCQm8S2yaADvVbc2OLqKG16O87OZ15MEi+onYcfjs9tFRNd3j69K1Q3L7danbDGYsl4ch5Fmd9H84BiCn2hQikmFDJDISsUknXkRGe9TjUefmhqdq84QgdjJzwXfm/s090PPPxgfLZYHO9lhpTUAC3JYZ2Jna8T9Y3HmktY03PJRPVcd/iRh98fny0tjx+WfMN2e+BqnVgSOOxNhA7QPaG9tmPfdj0NyQEmWTJGJn9kDj/x8Pvis9zy+OEb4Wmzyi4wcVPDE2cFD00d02RReErJ9//YB96pVysAAAAAAAAAAAAAAN4NgP9/AAAAAAAAAAAAADj9wPd/AAAAAAAAAAAAADj9wPd/AAAAAAAAAAAAADj9wPs/AAAAAAAAAAAAAJx+4P0fAAAAAAAAAAAAAE4/8P4PAAAAAAAAAAAAAKcf8P8HAAAAAAAAAAAAAKcf+P4PAAAAAAAAAAAAAKcfeP8HAAAAAAAAAAAAgNPPuel/EYuPCbGp0nRr+qNnPjd+fUw4v3jud8/97uNO2SnhcLcXi8+9Wkh0y4Ym7+1hTce6LqsKbwj6bV4VxY6mYUXEOq+ofKctCQYOkyjVuGKDQ41a+epVroaGK0qucVeqNQ5t3VgnAauV0DDJNe5quYLq3AZXaqBasVzn0sW1aq2RTdW5er1crfCNYv06Xy2Vtmo1rlLi+PLm5lajuLbBpTIvIq6y/la2+/n43HYh8ZXqsJzKio41g9/rCJp03Myyuuz8lit1rtYYmN/ta1wFVaoNxN0s1xv1dBLZmc+hK7XqpiukjowkQtvXuBqHjEuyVKhw25eoSllKIoRQsbKOjEt2EEug/5OR0fCBTK72VdhXWEWGYHT0QkoQDfkAp5g7Em5iA0u8YKByHVW2NjaYmwq+Z/BSB/OCYSZA3MdSp4klflfVkhlUrQ3M8Z0O7mAeK4YmYx3dcXJ8x86xKcBk506ELN+hucGFVBsrkqzspcyE+BORRP6CZ6sMqUmEXqmWK96EknqmaVTZFJppV+1qCqwyK22oXEFpJ33ZlCTrbcEQ981fQmtH3uuoHT2VSWaO0E6KW41r1Vq5cYsvV14rbpTXrfZyuN79e/HZemG8OyErEr4XauE793nrXphI7G+t1lKurHM3UQRNSTSodaT79ZgVNSyYFpe1ii/rsqvMw3r3c/HZQmH8y6uGsNMM7b1CE//XdlMnnUl49RNbsVKAGtzNBrVl0gKySeSECrrnamWoXGlwpEOxJVDpGle6nnYLrXGNbY6roBw1k/z8/Goun19YXlpdms/n5zM0RrYQwrS6hWyt80Fac1SrqApNrItY4mXFwNqB0NTDdAeJRojBbiLuckJblfKrWxyqcVc4arZ1dytLy1KGWMw6t8E1OFQq1kvFdY6m2LGP0IT2JSKk70atvFms3ULXuVvpYIMjUqSbL1+tuKUcG8iw+XB15GmPnC9LyQyqN2rlUuNG90enZsXCeMxsnHeasoF5oWOo9Dcf2sYWQu38P93o/t0jqcyFqvybWGxSf9xDHAAA3jf0yr2x+Nz1VOKt5wPG+bo5AJUOBEXE/hH+oGF9QFDvC8wVxIxxvSMYe1DPbfdH2dWNdecHfeZEHfL7Rp7e8STRzAwlVXYoTO4FDIWtwIGJYxWxTzsqxGQ6+hB0fYvji+uvFckYdLvcuFbdajDDUmsQCt//AQAAAAAAAAAAAOD0A/7/AAAAAAAAAAAAAOD0A9//AQAAAAAAAAAAAOD98f0/MZaKxT819adTV880J/7j+L8YvzOWiv3axB8/7rS9i+he6U3HZzlu/ME51x5XsnlPw3pbVSReVDtkH6Y+6N7YZOBe1yBRut/Vu62V2RwZsMVx0C5NsnlY7JDt5GYM/s2a69yV4tZGA807+0u9QV4qIHPvq+ldYNCeT0aChnK2VW70ElOzfH7YHkih3dbUA6HJt1SJ3QHpvj420V3oxeOz+fx470fdFeOSCwk9HlwZLqGTrQai0rPx1iwveoNuQydl8Umh2SQ7z8mfd1Xttt4WRJzKplqC0hGaqcxxK6Gr9abic1uriQdikKsGDYtYbhs6LwptQZSN+wGeGmyZQW4aQvQM8dJghzJ3czG7tErVrUoj/VwmYLOWHcbapRXulSBDSqJUrHPI2SumtrEmGGQ/Vsr0rpBCDXJvaT6/griNOoeW5leW6GapiDuvalyJK99o8KXijWKp3Lhlb/jf7p2Jz11fTXRXB5Z6sB+QkQo8qgcQp6xHzJnX98fhx3uT8dmrq+OHW35fBk6qdu6b+/SCbo6Nhbsw8CoIcF5gi7CeC+x94f3955lXehNTs2+sRtqB7cSaC7wc+/9+/Id74/HZ1dXxn33a7/jAFgsO+/+GuzxwTJlYvizhVls1sCLe52/j+/7ex2zoTazsGftpj3SmsLhCewoN3+lg3eAleQ/rRmD/Y2lwS2YKK0t0T6JHAQl7daO6hlLPvf7m/MW8cHH3jedSNCqnMQXG0r9Lu7qmrBupbOpAxndT2ZRZTalsCksyuWw1RrOzG+rfwbphZlfvNA2/xwczDb67phsV4pPEe2ugFwjTW4EVJKAvdsXG3vfFx9yM4B/BCsTugw2M0iXgi5O9Gz1S1vtMUJx+7zRMlMzN6DF+RrdNyYyIbpNl7zHxmDcRItf5A6EpS3a6yJWMdZfEaFl7qVhvsCKoWEdrG9W1TMZJ4QKVzy1fzi8sXaYaiJ7MO+H4gsmgnRPm0UTbCpMF2+hZL0DmnRAD90v4jdIvE2BFfqEQp0QuGaeyrCIyy5KtNiaztEcIySwb/tRk2OrrjpXlUClPtkPljpL1UGUjZN98GLi7/8zjLYqjV7DdO7AOagY7phnwuvDOe7mB7/8AAAAAAAAAAAAA8P74/j85k47NfGfmH868OZN+3OkBAAAAAAAAAAAAgMfJ0uTk9tMT5Js6vyTkFldzK6s7S9Li0uXVy5fFVbyQF8T8ztLi0vzOqr2AN/aL31qacEJdzgkiXr68uHM5JyytzOP8zsLuzmURLy7kd1bEnUUn1De/szTuhNoRl5aWVueXVsWcuJRfubyzvLMs5sTc7s7C0sruiuCE+sb3lsacUKvSClmutLK4KCws7ayuCjv5hZy4mltdnV9auLwiMqHI9//JmVuxmVszvz3Tm/l5sDIAAAAAAAAAAAAAGIHMxPZYpOmCSUdy2BTBhCM5bFpgPD2xPR1pKoB8/4+f/+XYzG/M/OyMPrM+8+T5Pzz/y1DTAAAAAAAAAAAAwLuFbHxyezraF/nYL34rO+VID3vNjn3zO9kzjvSwV+3YN753cXJyeyzal/dxIj7hiO+uLki7uZXlxfzy/NKumBcW5xdWdpZzi4vS8vLy8uIEER93xPOrC3h+WVxYFDBeWlnBQi43f3llcWH+8nJeyO1iKj7miGNRFFdWVyW8vCotCTvS5RUhLy4v7SysYEHcmV+etL7/x8//Tuz878zcmjkz8/MzL5B1AI+7bgEAAAAAAAAAAADg5L/AxyN/gZ+K/AX+jCM5bEqg//1/6GyAIzlsIqD//X/YHAB5/x+b+W5s5rtgWQAAAAAAAAAAAADw3uHime2J6emoaxfOzbwZS8Z7scQ/Pfefzv3s2T984tef+PtPJKeF6Q/Fe+Z/jzs/AAAAAHAq6S70nmKPMG1r6mewaHjOIQ2+OvZB10GCwUL0xCX71pAjTC2xd/8Rpjd7yanZ29zQc2QDTtZlTpMNOqL3zCu9jww6JFLCB7JIjsRttQRF4ptY2sManwu8PPb9vWd7s/SQyId7tHYDxYLDfp+rbgNlaNVad9qdnaYsBlUwKWpJME+QDCln+7ZzxC+5EHJQcD+E51jgXVnTDafodUPQDF5RDXlXDjozcKh0/2S/YaIncTCx3nsyPvvC0+OHz7InmOq8oIn78gG2T7/Vx2aCDirtyzFHk+pp+yIvGFk2cetcvZRFspR5pffhKAeS6vvqXd7Yl5XbsrLXt1/X5bHz3dneh6it9a67DiR1iQWHPRd4IKlL5mRPQsYKbQ1h1dS/jdLz2dyxu4vDld4H47OvlsYPRVqybMtvYV0X9jCvqx1NxDo9gVUxBkiMnXWZwHBdpAgGSLGH1rLHShIrybzW+/6pWbkUZiGDIs8NysMTXb73ffHZUmn8QYlaywDhQXqmXZYzQDLQfpz6G8l4TI1+Ja6zbB2hjOcg14X5+dEP8HS6GNbiXRXXj8+xulgs9rOxdzXm9/+3YzNvP+6UAAAAAAAAAAAAAABw0sQnJ6anyfd/8uMDUL4AAAAAAAAAAAAAcJox/f//q9jMd2f+q5mDmY2Zj51/+/y/etypAgAAAAAAAAAAAIBBpOMT24lIPv/SU7bkMJ9/6TO25LDt9OlJW3KYz7/sxMT2ZCSff2dS8e9lx23pYd78qPSYLT3MSyCRJuv/4fs/AAAAAAAAAAAAAJxu4P0fAAAAAAAAAAAAAE4/sP8fAAAAAAAAAAAAAE4/8P0fAAAAAAAAAAAAAN4f7//x878UO/9L5//dDDfz5MzPzRgz333cqQIAAAAAAAAAAAAAk0tnYhPbY7Ff/FYkb39xS/yb34nk8m/KEv/G9yL5/TvjFh/m/G/SEv/625F8+k24xYc59Ru/SMSnbfFh/gXJ+v8zU78XO/+Zs7999u/HX5n6PbAwAAAA4BSw98zU7Oe2xmKyIuF7+p2mbGBe6Bgq/c23NfVAlrDGax3FkFuYF0RR7SgGr+EDVRQMWVV0PhdF6hNfXvxYfHZra+wny4aw08RRwkSRebZU44oNDjWKaxscihICpZOICO7KTczLEmpwNxuoUm2gytbGBqpxV7gaVylxdVtGT8tSBlUraJ3b4BocKhXrpeI6l2W07GEFa1Q7Klca3FWu1ldYusaVrqcDJNe4xjbHVdA8KlbWUX5+fjWXzy8sL60uzefzuYyln2bHk0ZHpXmzXEHplKhK+F4qmxKbQkfCqQwNb5eCLqptHKjELUE1tQRF2MNSKptqY01XFaFpaRM7moYVwynT2/i+qdNUlUQoWKZcpzHS+9UachJesBJN89/Eyp6xnw4InymsLtKwiArqnR3d0IIEs7lsPlNIHeQ+SfV+MhUx1HyGlsrVjeoaSj33+pvzF/PCxd03nktlgpJslu/wNC9FTXNu3ko01Rw51blBqab1pRuCEVzr5h1a2xpuYkGXlT1iO2qr3cQGlmzzwQeyPsConfu2KefCTVnUsGBgiReMMG2MxEsFNE9DddrSkFCMxEsFJhYzUjtDrAIrNtct00JJVbuu+zWagc0CLLAFVvBrtBJqluWNWnmzWLuFrnO3nM5AlrK2YWVdDTGTzKB6o1YuNbYuTM3KpbDumbzCyKriGIbQMfZVTTZkrPO5ATc/3vsAis+WSmMPU7QzHiA64NYzrq53gCDtce37do/LFAjb6VpiETrdqF03CRPSZQX0UsQGrHZdKtYbLpFiHa1tVNcyGY/BLy6Y1qphUdWkgebKilArd2q698Efis+9/ELiYcnQ5L09rLU6Bn1Q8IYmKLpM/9zrCJrk3BAMA7fahm7XQ618lUQZGhCtcVeqNQ5t3Vgn8tUrVhdRrSCfzuT2Na5CU08qL13dWL9kChdQqq3htqBhyewFK9z2JaZDwbu7WDR43RA00jCyKVFQRNxs0l4FVWs+bZ4AQTqFdrspU2W7gkw0ZVNCa0fe66gd3dHKKnXCJzPJNe5quYLq3AZXaqBasVzn0sW1aq2RRSm52cR7QtPJPeqXWCrzIuIq67D/HwAAAAAAAAAAAABOP7D/HwAAAAAAAAAAAABOP/D9HwAAAAAAAAAAAABOP/D9HwAAAAAAAAAAAADeH9//J8//XGzmv5mpnf+b8z/3uNMDAAAAAAAAAAAAvG/ZmowfnrswNjGNj4mB7xkvtJuCrEzGvv72axOm2rHdY+JWO7E1biVXOiZuvVtjllrxmLjVku//k+f/KDbzz2Y65/9o5oXHXdkAAAAAAAAAAAAAcCy4ycNzY8edQZikWo47YTBBtRx3emB8ffLw3LFnA8j3//NjvxIbT53PnPuz5F8mv5H8xPRXE914e+orZ5Ynf2v8YOxXYl+Z/s1YLPZtsMB3F/u9FDnbanzI4SnOmVH6XdkQ93kdY4mXFQMrBnOKyiCpsR/a6H10apbPh0XV1tTPkDMuhDZRIzT5liqRI1qCr4996MGP9D5BDssa/+KHXeezDEpEpIT+YOCRLYOC0OM/rENBIp7d4tNnCNoeNvR0X415Ok9TJqcatbCuC3sB57lYB/V4pQpMathTmLxy3lNaFubNU1po7sgsX2B07Nkvfcmwk19yi7n51QXXWVv28TSf0VVlaAyBgfyRLZgZWFnILS0d/6SZN3vPTs3euT5qu7BqMbxJWAJjT3drvY/HZ69fH3/w1EDztQIM0/cDkYzWkh7FXn2H3tjHBTm6jX0NC1KYaVo16ZcOM71jVduh0HsmPre1mOhy9glBlq0LhiGI+y3aYcktkqudJubNk7ECZLzHBUXQkvScHFQJCjXopB1LHDHiSNAwciKyztvpnu99LD73+mKi99SATGp4F2tYETEvYVHD5OLR8hmgKFm80uBq9rlTg3KaRHZ5sLmqcw3UV0sPj0IFtFm8mfZevYhyWTSfQdvXuBqHJHkP60SUnGNk/ngxSUpkqnfBLJHpSCUiKydUIo4iq0TKlTpXa5xYiXivPI9y3pIgpzgxJXH4ZA/FZ4uL44cl2lMFJ18MzvrYnJX5cmWdu4nCw4ZkMN0/vyzLHma3ztVLmcOx3g+ZKXsqNGVmRoJS9tGhKbNKJCRl5t3Mld4PTs3eWgzr1oP05oKS89TDe72n47OLi+NfMUcfAUJB4T7i6qYDJAKPgQs6vW34GXC62tGIiQ7slx2hsO64rZpnfYUe2mnfdx/VuUoDW3USmomAGiLBFKGFhw4LqFDYmGNheZlqamFJFnjjfsjJnsxteoaa3BL28AttetCj+fdn2rj/Y0/edf6+i3faqWyq/yXU/tEStNuSetf5LeoH5Cg2cjqbebjqC2QAY50euXPfwLyZq7ACZkXcmVxeWFq4fHn+GEdHss98V+N1zCLrGED/IbvS+4Gp2fIzYY3I1XhY43+yV+/NxWefeWb8rdu00TA3WbkPuxqJt3GwNsWm32UhljGhAlpZomVlhTJPAn29fw7oozaSd0W1ex8rvqDr3JXi1kYDzTsDLncA96CLvP9PPfGN2MyV82+d+9fnPnJ254lvPO73WgAAAAAAAAAAYodLU8ntW4nDcy9cGJsgL3z87uqCtJtbWV7ML88v7Yp5YXF+YWVnObe4KC0vLy8v3ungDuZ3xRVpGV/OL10W5pdWFnbyC1hYWZSWc/OLu8u5+dxxP4o6559fPFhavGTcM9wrjA8XzyS3b40dnnt+tGTvLK0s7+zk8IogLS6t7FwWhOXV/KJ4+fLq7m5OWl4dP+5nWF1o4T/9579K5iICUr00mdy+NT1yYQ9L9XETLarNpkxe9S8ad9WgZE8cyUYeXbJVJai0C+NmsoujJXthd3dnRVrazeHVy0s74tJlcSl/eVVY2l3Z3VnI5fBxv7G3NXxRw00s6PiiJOttwRD3sRSQ/tUxM/3Lo6V/cWdnQRIuLyzPi/NLK6v5/OrlxbwkzC/lV/L5HWnxuF/32fTrwm5AyZP1/1PnPxSbeWPmmzNPnP+n53fPfwj6WgAAAAAAAAAAgPcHr57ZvpUYO8EZpqname1bY2MnOflzhiRy+iRVTo6c7WEaJ0bWOGw+Y/wG0Th9gjMM5vv/G+b+/zdmXjj/R+ADEAAAAAAAAAAAAHgce+6nTmTP/ZkT0XL69v+b7/9/HJv5zZn/eubuTHlm7vwfg50DAAAAAAAAAAAA72kuTm5PRPscH/v621MjSZ8ZSXpyJOmJkaTHs5PbE9GWCMS+/jbZ/x/7wOOuGAAAAAAAAAAAAAAA3knI9394/wcAAAAAAAAAAACA0w18/wcAAAAAAAAAAACA0w98/wcAAAAAAAAAAACA0w98/wcAAAAAAAAAAACA0w98/wcAAAAAAAAAAACA0w98/wcAAAAAAAAAAACA0w98/wcAAAAAAAAAAACA08+5M5Ox87Hfj41/dPInzufO/c9n//HZ9PR/O80l/o/4P5/6L87cmrge+/3Ye5ruUm85Pnd3K9FLGZq8t4c1Heu6rCp8W1MPZAlrvH5XNsR9XsdY4mXFwIqh83Kr1TGEnSbmO21JMHCUQKUaV2xwqFErX73K1dCR4kmucVeqNQ5t3VgnuqqVSGqSa9zVcgXVuQ2u1EC1YrnOpYtr1Voji1JWeGSHR2Z4RMIjMzySdeQkJJV5EXGV9e7FXjo++/rr470X6OXQZKgdTcS8hptYIDLRxMaQXVjFtQ0ORQyF0kmEBMPArbbByxJqcDcb6EatvFms3ULXuVuoxl3halylxNUHF5uG9U7T0NN9XZlsEiENi6omYYkXDFSuNDhSi5VqA1W2NjZQ6RpXup5mRV4qoPlMMoPqjVq51OiWekvxuR99PdHLDzM0d64YG5BwEw+wNXe4qOY2JDbb4ta5DW6Ixbk1HcnoqApkqQiyO7WXic8ejr0+HpMVCd/T7zRlA/NCx1Dpbz5qNnNRLfFCLBbbOvlup9RbPK41DOl5TtgaRu5/HoU1dOd6C/G51vVEb3pIMRqCtoeN6I3Jko9YbGHaozceS8NRiskMGlI8uaMWz2DrOm7xjGpN70jxSL35qdm7rw7rSkggg/whdIx9VZON+7yGd2RF0vmF4TJjGan3wjGjyUWIJv3gXu9SfPbVV8e/eMv1RA4PE0FrKvA5HB4g8BHsPCOZ529fhSmsp62HbFtTd+UmHhjYkmHDmFXuDmE+kp2b5QpKp0RVwvdS2ZTYFDoSTmVo+F1NbfF7WMEaTVPYw90rRh/wJLyhRgjtFir4In0e5Y48yiDhmIEOM3DJ9ssza5dE1pUUGnirUn51ixsWzpPk/uBG7V080lPZbJsRnsoewbFPdNO9rDn+fHbg+NMTMKr+ZyONPz2hTmL8aXV0Jzr03O89PzX7ua2Rh0zMUHjAeImRGnumd733XHx2a2v84d3BrwVMqEiaPxbthYAJcmJvA9ZLlLdKjI6m+Hspsy6aWNkz9tOWSAatcY1tjqugHCpW1tHCvNVtkNu6IRgdPVALe9/qvFptMqyQUtkUSZWmddrmr11BblqXb2jqnoZ13erbjmU5sP4fAAAAAAAAAAAAAE4/sP4fAAAAAAAAAAAAAE4/8P0fAAAAAAAAAAAAAE4/8P0fAAAAAAAAAAAAAE4/8P4PAAAAAAAAAAAAAKefc5P/PvbE2Hps4r8//+1zXztbfmJ8+rcS/2TqY2emx9HY+tn2407fe4HDm70fjs9dzyW6L1tOmBXVkHdl0fR/u692NN1yF83vdQRN8t/2uFkeEt7vdNofYJAjZVYaUWkkCoqiGmgHIzMiyfKg3Dvfe5nm7eHz4XkzfT0fPW9seL/H6IC8bV/jKqjCbV/SZWWviQ1VQRcKqLqx3r+QRKhaozIHWKNuoy0J62f/vqhhwTB9Y1oi/St9KQ0fyKwa5/fzKNeXMnNCdX2KivUvDKoQWTkQmrKEAirG0ARFl8kF2+X3Um/lWOdZDDlj4MTOsxj5dIF39jyLWCz2QwMacffDvZeooTv++gMMVVZ0rBlHN3Q2vF0w5UqdqzUGGTp3s1xv1NNWYeTQlVp1M0AYbV/jahxyWkAhlxmxExCaGhak+wjfk3VDt8rtYaxXiM/mcuNfytDi9EfsvzL2vMuZb0BaievefuO13dayzntNz7V9mYLlPdtuziGubu3btrjTTkNd41r33R588/Pzq7l8fmF5aXVpPp83demGoBl8S1Y6Bg7T55Kxdc5TnbmlxTzVgxVpiBZGwq+D/sFIXCi4UmZ6HpZbmP+squBB3otLxXoj3Zcs1tHaRnUt4/NmvLxMdTIdZUiyGQnHaznTJYaEYiReKjCxMEerPNf7VHxOfzXRm/P0eQN86of1eOFBQvq7EeII7+3ClUTp6+zQyAmNzNCBh0I813vxGKXlPhfinSmtYadDPMrSKvU+Ge2gFq8v+9FOGhn1oJZhsY168sixDmqxjtgYdFBLqZc/bjFGOZHk5IrxaCeUvNPFuNS7PMLoznbeP9Lozgo0yuguLJ4RR3eWmiOP7szwIeW2eqxyi3DK24mU25FOeXvnyo3s/x+b+TexmX/zCF+YAQAAAAAAAAAAAAA4ET4xNh2bnh4fX5yYGL95Jl1sYU0WhRdudLBmqHxNFtXY19+Off1t8/3/z2Mzfw4FDwAAAAAAAAAAAACnhnNj8dh0Ynpiov/+/0RMjJ1/8VzyCSlpxP8g3olPnfmfJrsTN2PiicT48E7venzu1tOJL9+1lma0NXVXbmJeVCV8jxdEUe0oBn8b33etBLekvOstogX2LrC44iyM4HFLkJtZX3CyCMOO0lx3myYrut3BULlOVy5mLhToXb8WW8BcE06WuSK6EDxAj70KkqyxDInKEqFaiFhTvYu1tKHJrYDEZTIXCoyAP9ZMxlEUmni6/t17I4nQ48nQ8fNDYgzP04AFNZYtoBIJiKyAiGhtdXQDifuCsofRXdnYR7KhI1nCiiEb9+31SJ/ovUKNvicMNXp2VfjIRj94SflJGvTRy4pcaLUF5X5gSb3UK8fnPncr0VuMvlr1YDF/hPW9JNjoq1aD4jrKOl+i6HirVw8W84Fr317qXTtmCUZd83sSJXj0tb/vWAk2e1enZj9/azwmKxK+p99pygYm0av0Nx8xiwvR5Mbmm70rJxBdLmJ0Lzw82+Pis7dujX/xDs10tHARtV9y7fSIFog+RQTDwK22wcuSZ4tCjbvC1bhKias7FclbwnpaluimArs/HBTY7vuYMObKyKAdEc7NcgWlU7QXTGVTYlPoSDiVTUn4QFZSGapnV1Nb/B5WsGYaWciuBq+YsyHCUCOEdgsVfJE+72xvEVVNGri9ghVxEsHstEn3ayLbL9esXSJZV1Jo4K1K+dUtblg4T5L7uzkOm731+Fw9n+huW/0V0aTQiqYPJb6tNmXxvmvPY7CIpy+KoMffcwcHGtTPOCGQ+Qw1Q4TvofxYr0Tz+7A0OL/sAPY4+R28nzIkv6d1T2VIZfn3VV7srdFa6t0aXEvsiOs4tTR45DaolgI3BAYHGHFTYEhhBW4M7BV7xfhsPj/+1hx9rAQnIPjqWNb12AhJ+yPbJIgVkgEpfDeefRul57O5zIlvLHx8O+vg/D8AAAAAAAAAAAAAOP2A/38AAAAAAAAAAAAAOP3A+z8AAAAAAAAAAAAAnH7OPfF7scmxq7EzfzX5axOXxq6e7TzuFL0n6Ym9anxu8+nEW3ueLbj2VmrfRkjzfthpEmHBksUrDa7mdmtg74Ts76FlTsjr379QsHbQW7/NfUBkO5+pLCxqGetJhOpcg4mr4FZNdqMgxOwaL9ibk0rFOkf2IFVQO2TnOWrQpJK/uI06x3oE8AbJZMi+IxqXC7r/yd7uidrWnqf2JV866bYZ16ZJKsBsKEP2himrMCwVsvRikmx5+mivQqv54dbQaja3d41czWYwq5r728GcirUrzbpVrjSqg2ou3c8Iu0mTqaosUxrEn4JVcWaus0H1/A7UqanYvXMwOULF0trppnqb8bnbW4neU2FnwPjLm90rOVRcHn7s0OAYIpz7EtT8Rjn3xfa+0N/7HrDh/Su7vQ1aVD81G72o2A2L70xRDd4SGamozI6v2rA3SVLDcu+UtNsSIv2a0+Bto+o3GLpfT+/b68Fi3jY7esHqiIiUGY1tw7bAhYK1k5xsZWXTY+JOVd/MGRHG4GlC7K6exNm+pBuCgQspXd5T6NGZKVfXaMoM8cHiFvZ5/6D5dTtNMTE9r/T/pT5YPKUemEczMVpHoecO2qo1fKCa50PqyC5XO/cak3FXKTAZINH35fqbzgtseTupoaUiYl1nd9QP6GtCIs0EJYDmL8hM+lJ25nVRbWMq6rrikU9rdj2bx4bJyh61J+2S2NE0TMzf763Flesw4Qve2mUrNUO3X1cblmm7XMc4Zk09+JhnSXpVFVYXGdPQOzu6oXmFsrlsPlNIHeQ+SfV9MhUhxHyGpurqRnUNpZ57/c35i3nh4u4bz6XMxFdrgck1/TgMTu9SlPTm5q0EU42RUpwblOLMMft2ScU6OV8VtQRy2hfxr2OFco69nRx07C0AAO9fqP//xJOxxJOPOyUAAAAAADxe/sFu79X43HYq8Z/bvrDCJyzvdHDHmt0y/8SKoYXP/gxU4J/zcakMmtwZMLXzSrXc94CK2tQfasDr/AZ3pWHKRplgQm3BfNGsoLbATBYVyASSOY0i9N883bNHyQGTTcnwWZRjzKFEnUEJnT8JmirxhwrKbOBkR1sImes4iZmO8HmOtuCf5uj7DrbLOe1NXSHVxpquKkLTnDoYPLnlWI8Vxqkg8t1GVvZ0tOOZ2doJtJ+dAebDFldfjjf2iX82p3Y9Fy1pq2wF0ZAPsD1xYblQNn07+/PfEhRhD0upiPN7J1cENLGmM04rwcQJpyGI+8QqMkGp98zUWj47390pDzBCbzbYuas2q70/7Zu1/1Y7RmpgmTDzdoOmjyNPHYdNG7sbXGDjCauBoD7X7HLZ0g/ueoUIU8Vmot3pGzQr7pIsDPyS1Z8dj2iXI9RnJnncqULZnCi0OkhrepC+/8d/Jxb/HRhzAQAAAMAp4GsXerX4nLia+BnvsRBBCy8MrJHhqqo455CYQxbmziiLmDzqAk8m8UfAOCHvr8LwnSwD7//w/g/v//D+D+//8P4P7/8n8f7/7Vj82497uAIAAAAAwKh8balXj8/hpxM/c2foy775WYqnnx5cuzmiv+D7VfgP3KU3s5ak0dGUwD1qdL20+9OkffCXJygzD5AZOhHg2k1xQl/4zS1Rvm/8rkNV2a/8AfuUHtlX/oBoT+w7vzfD8KV/tI/FjB3tDDSjoV/7XWHee9/7XQVxhC/+3iJ7tN/8j576gK/+/qwc67t/gLpT+eWfqQMhQvf3GL7+D7TRd8v3/7+Ixf8CxlwAAAAAcHr5WrLXiM+JqcTPfHjoTIEh6LcD3T6QG9FnC3xqwn07UMXMMgBDMDp6f2YAvv/D+n9Y/w/r/2H9P6z/h/X/J/H+H/9y7EzsS7H4H57Jx39y/D/EvvSYhiUP3uzdis/hlxNffMY7LJHUNl1J2Fabsnifd2avyUjC8q4VLDtgF2IEnWFfNAI97vljdg9icCGFFeKAK3BudcC3i+GfEtIDnN0ca+LwxCYNwyYLXZ90Ik5w2eWMzJpDGr7TkTWs23bNtADb8i1Tf/BK7ya1sC98biQLcznyOyELs7z8hQ6DwZre9da02XstPvvyy+NfTFHHeqE1F3pjbNU2neLaBuN+0ytHPxI46WhwNxvoRq28WazdQte5W6h0jStdTzv3aUs3223W7goy1O8l029RJTXuClfjKiWu7vQ4actFptlpUCmn1M14mO7E7s+yKUnWzT/NiDR8INPSLVcaHGkTHh3O/TWusc1xFZSjVZqfn1/N5fMLy0urS/P5fI7q6ruDDNPGSLxUQPM0VN+hZ1goRuKlAhMLDW6KmI7EgjpvpiRZm7MckDlhnGIJCmQF+P/b+/rYSI7sviG5y5nlapcOfOfFmd6kl7nzkNKQNz3T87WnWZnijiRaK/K05Iqnk6Vxf9SQrZ3pHnb3cJd3pzi7w6Wk88Hx2YAdB3YABzGc5GKfjIsBA/krSIL4DP8RwAZ8zgGOEAP5z8kfRgz7jyBBVfVHdU9/DckVpdX7CVhxul+9+nr1qrqq3nuLM4vc5tbttdWtTCZzgcyEt4fb01fQc5MZVVPQfXOvq1oIf0zr5Hc7Uk7afLSo1X/xM8M79Kt/Md1Xf5hfzGN89cc5v6QT6sCE73+w/wf7f7D/B/t/sP8H+/+P/vw/8yNn9M0PAAAAAAAAAAAAAAAA4CPBDP4Hvv8BAAAAAAAAAAAAAAB4ooHP/5+a+NXM5Q8v/fOnvnNRuvCD3P/J7U3/y/OrU38x+fcmfjWzNfP/zrqMn0LcG6LslQcX5PSXQEdc+mC3Jj3VCr0WGkk8cWO4NlSyV2R58tF2xL3myMTj5NNMuPscmdK5De27yszeh4641owvmd5s3WpttXD8+tWVmy1807dj6D02CHTEbeEgmXNxuRh2cZleQbb0FHx9RM1ALs/QG9AhlEkXp907xQ/FoZydu7uRO/zRYJj3CJ83bedydiDMe5SLnKgY7+nYB28EMw66ojL0zGocVteaG7duur+e4R33Yd4V72cxgfcz7h6Vky9n58vZ+XqX2lWTU7V9sasq9hWqh28OpeycuZE7nErbyKqCNIs4Su/1Br5hdmoNPZpFyPVr14Su4NwbK4y6kyqQUUlbLlUPHad5neKS5nVKbDfwcG0oZud6G7lHYtoG9m6hPx4xDvCPNuRJkuO0vuyT48YFwgyNRKAP0CQ5EYu/bhjZj65hjXvtsKeaJDa53ZkPMsOfzV5pXp18wNOpza6lq/JtWwzn+cSzdt+srd9sfYWLIp8h/vqctwveBFFg7ENutjZXC6qy+KA9bGevvLkx+fAqW4bozrL9HSbSTXwprLCJfH2Fj6Z2jXwKXvcverLhc/c2nB6+lZ1rr+YOB1HGbrKoKSqxzgjX+aOEibZuUSyj9XxIJskaHrcX1fFd0bTaumQiY9/T9MGHAXJ5V9R2AtTes7GsxtxCx00PreGb2bmd1dzwbnJPRE8MJ+qNNJNB3AzQUQ3TaiuqKev7yKCDKaETj9eMcdPAA334M9krm6uTDzd9ozYk93Yf0SETTTJxPXSoxjDzj9IQQm98BiWQap7RhvVGr9wV1V7bcXdi55h/eGP4Rnbu9edyQz3BZDVhCI9prDr26B01en4sq7Nos83I0fcTw69m58TncsMks/IUQ2/MVhxr1DHTVGwDH6N14gYVnP8DAAAAAAAAAAAAAADw5AO+/wEAAAAAAAAAAAAAAPh0fP9nL/1+Zvb12fOzv3P59y6/een3L1M/xAAAAAAAAAAAAAAAOGtsnt+e2p4QZdlq1wSl3mkgpYJQURAURaoogliv1Dp8qVqVUSPzvQ/wtfC2IPLlGl+tSYJSFuq1el2uoVJDlBuSUBaKUi3L8BRFVKzIcglVRFlAxZIoCahU5fkSUsoNoapkvvtHhGedF2VUqZelOi8K1SJqSKWOVJdRudSQqrJUnmZ4VkoIiaU6Xy/LDaFSL9drAhJrUrHckeoKUjqZ73xIeEqyIAi1olCTeVloVOtSRarIvMx3pJJQ7VTF88fgWVOqjZJQr5bLYkmQajVRapR4ucbXakWhVK/K5xiefKUml6WOIvHVmtCRK/VOQy7WRbnUKAsdpVPK/PbfEp5IluVqraagSk0RREmpV8WGXBGkUhWJslSsTB2DZ6NWwg1fKosICdUqEnm+WK+WS8V6pSHyHTR5G/O8MBbPTq2kdPhqpdyoFIWO3BDLxVJVqvDlslKpVCpl8P8PAAAAAAAAAAAAAADAkw+4/w8AAAAAAAAAAAAAAMCTDzj/BwAAAAAAAAAAAAAA4MkHnP8DAAAAAAAAAAAAAADw6Tj/v5B5KzN59FTm4i9f/MmZaxd+8tz/mvp+5q3T4H74+aGWndvbzr17MRB9Ue6KAwXhKL4ydlPQFQeavNtWNQtplvvUF8syLkVURMb0uURHcI7Nl8a7TIjgHGThxEZWkcmJbgRQcdmJ92vKeh+RsMy+J24UZ3HZC2/sRG+2f/ppUkZ69tKQGMLXmnkDdZFoIiUfHwV6ldSLs+vF0abhaNNwsq51uqpsmdw91drluuq+R+lGh3aidD437GTnBnJuyEdG6bTruIM0ZIj0ETJ6qtXW9DaNHpo+TXIEz+Tc0kRFjcw/NrY2TcV5qThD73Zx5F2OJg8L5Pnw2rCXnVO3c8NL4wy1kcY79WGWosHih9hxBTCkkd4Thl2ij/7JM2PqI9qPj1sfebmcSB/5xrkoy/pAs9p30QG3tsmt37l1iwbE7iJtx9pdiCJevNasCZTSHEimZURSFvgCX1y81szv89dp6a7nUybkF7kXb208z+WffuOt4lJDXOq8+bSddn1jK1Kx2k1lcn1XffaXo5Vhf9nV9e6Y8tF6j5k0RBlya+vcQt5UdzSktFUtX3D+1gdWftGl9hcWY6TAtPaORndawUD7ukxyNjnDTkorZCRoeSdrjy5d5XzpSKGaedpr+cD7NPORQ71g0PZy5g4cvRr3orEsDwwDi3e4HDqIIr3WjJRPknrxBDOUgfYGqoFMzs7X7aWR+enBveHd7JWd7cmHX/KFHo8di22bKhXxxE1bZdxZX3v1TjAqeap8/PHJY5MsOFRsCHLvGemfjS3SRw8nhm/Tqm+MUXVngKaq+mpoJPZUGYxTZ2/8FEaHRsG0xB0SfjssTPvbQ3X6yjvbkxnaBHtd1UJ4GaeT3+10RS6la43n3x7unjwzPl1mP/XuN4Y72Svb25O/cMcX8zw2WTrezzmT4Mrztzzpik3DYe1pT4eqwm21vrLlCqIzMlZfaq2+vGBPXi7tYrNcXSzMcNxo7wXY+NKH9DX3fGtru9Va53ii2ErFosPXlp4Av9utF1q3W+urrU13WlpQFV8aZiW3tr7VwiuCQHFCKJ1iFEkxGsVijW80ShWhJhQbDZ7w96nj0Gr6Kchc1hM1LOn5Qr6PDFPXxG5+0d9yrKYOY0oUb7ABWc1MFw50YrCXANHrhuCyIUUyfpEUKXTlQKrCqDJSAaaPHKXs9JGB9lUzpmfc936xCO0PV4dEMfMIbjQ5Kld0bRyXiKG40fTyIKm/fHvtlZXbr3Mvt17393XBr+2CQj6zyG1u3V5b3YLzfwAAAAAAAAAAAAAAAJ58wPc/AAAAAAAAAAAAAAAATz7g+x8AAAAAAAAAAAAAAIBPh/3/+Uw+c+kvL/7nmYvTxUw+lOxb54dmdq59NfernxvDQJtYsjpGMccwufZZwjpmwy841nyssczGumt84zOBDdBda27cuhnynJowznA+G85j2fJ71vyM9SbO1LXa9FvwMzab4UXzpRq1z8cWkMR6cuySByyvVKbwamzh1bEKbxePFizORNYppmOV5JrKSqqmqNqOyUl2up/eWHNt/kzOJBaA2PpXWvbsfnymtOZofUhNJNbGV5QtdR/lC3kFWaK8iw1YHRNT1srXKby/KlGVSeEKwLbpdxnZ5szkYWQ/uFbKlKxj6L3UohRIa+khhsPhKWlL2Aa/LjechNr+4mzJX+47t+eDpPmuvqPiNiB961keR5lTn0xixpabNNJDnlPDqv1yo5mXdQXdZ2vi1EZiLa0J0RjS52957y9PNhNMoInjDbuC2CmHhZ1JIMPkegMT20ATTcJJqKMbiLPN7FjfE/KuqO0g07aEfnd7aGTnXr+a+4XVpIkAG8rrA+t4s4Av8egUQFsuVOuPmu1jU/1C3kA9fR8p+UUqYQ4lnRJoovSzQJLIpRa101BQ9oBkBpdTVzL+wuU0QjIXqUTRkRvGESf7JM6Sp16nj2r+fBzD2/VvwCFNcYb2sDrcy86pV3OP9vxD24wU97aB8F8+xygRQzwlk9DVniu88VatjCuAlI6Z4ocx7Ux2yI43NmP7jabgnBI4ttycXQLafRLiDGSpBlKcHnR6mraZ3XOHPz7sZ+feuJp798UkpawqSLNU6+B4WtmfOqavUE9Uu5GrcpbGdjVhyz/7xj8qj9OBKbXwsaf5E03upz+qnd4JTNmHnxvqubkHUxu5IzUgHpFD0u+ZiBbb7/4osuUjZOkYWcVM+4mlCF0PeM3vdAVeD8xwkSsC+9Xpzg0BdeITxeM7s3H0hSxqMup2PY3hahhHnGjNbeHA3/+5iULm8o2nlOy/y74y/dL5r069MlH4yDciPgE4vDr8enbu3qu5o3fivYe506vrrIXIc7ynNWaNlM57WHwuIYPHFbTCyDiKLktgIDXzkj7Q7DVTnIsuT+0yGtb2ZBVYA4dqWcYjlfs+weehOYbPw3EGmrdacoaQO0mrZk+03MF0eGH4NSogd44nIKpmIsN63AJCc0ntYQ6E4VjC8ODt4UH2ivjq5MOlOMdZTOsmOAxjKCd+Oo3LrBDWsf6yGPqFoLJI4SbsfvZK79UEN2FskfAax11Rpqjz2hge0iLzSd0AfVVpK3pPVLVCn35tyG3TEg2LaYngd6YyvDd95d6rY3ruYsvKp2iHl94vDPezV159dfLbK3E+u5g0Kbi+mMZbF/sdj1U+ONs6rrOtlB6qsLDebN1qbbW4zRbNjLjqwoMvwpOYqnA3bKdh+O9nm+G+qjz5DvXxxbymS2fRuEfcX3ZVbXDf8xhmD4o4H2urK5tbCwzpyib3/K2N5xeDntb4Ut3xomWFezNjlvJyV1R7pGHpeqTA+J10/saL+1P38WUgWTeUWIddLInr58spEpvOIWfeUMeYxB0m8/hGk82X8KNpaZMwKmixOcLPLhxtCqYhr7lrOeypNVSrn46PseFrw0F2bnA1d/SFpO2JgUYVdUdFSruvd1X5oK2oJtZy4+5VxLCaWXlhq3X75PsWuKewoIRsXjCNSFeaM5yT32iJceHwUhuvobcYT4NNMt7tLrbLruQLjrg2nT+e4XE/sb7kmq+sfIVxHFfAFfB+elNYYFFtb3mE7mjYxUAaLcWXZvCW4Y2hlZ3bu5p7dJDmNIDuxZ+wXyMZjfRq0iFBkz0gcDvSGRvMuye4B/H3f+ZHzvrLGgAAAAAAAAAAAAAAAMDjBNj/AwAAAAAAAAAAAAAA8OQDvv8BAAAAAAAAAAAAAAB48gHf/wAAAAAAAAAAAAAAADz5wPb/0+f+IHP5f1/864vfmnnrQvHcH2R+a+LctDVtnXXZAAAAIAzvWY92snN3X839Ys32PGN7wW33BhaNr+C5P6TOkk3b8SH1gphMHnBIMyb/UfeKyQxs/zSuV01u1K2ml9iyUK9vmVzPcXTsvkKdDpKtNsIeYDQZccQHDlq2U2BPMT3HTwxavqtq+Df+n8PIcZfD9YnzHOy1s7fsFZbxmYz5ELczHm/C1k8e5a+T5kre4j/sAjnFbivqDjIt8jrwjOHAuASzq02cjBHPYGJPUncG+sC0/eT7XZZyCxEtayBT7w7wnyZn2BU1gq3ncewz/uYZf/L9EHfupC6BWB0uHyfSBdt2KZIywV+YUBv+qiVLnu2Vn/XMHyYuPn/9Ib3KeuEf7Vsxdd+yfEbjk4Q3gxMQI8HrOnWV7bQE486TtgS3K5qcpnPovihbXN9ACsKdqBu2V8+HTz/qZOfMV3PDuTH0Tg+/lLqoraAustBj0T2BPBz9Y3sPTKd/TtRyqsm5hfBaC52gtai/q8fbWuHeks+ktZRHSpz70BTV4pNpJqRH9x/JxH3oN18nuSenScH1qz73oSkUDtZVzKzhd/fIeMMcmfCwW0zb+aSteqITOzOZk4aoojDPkuSF7aufFH2ZxCfCk4j3m8aR8REsUXfrtp/JgCqLc4oZIF1sVgU6/wVY4NQv3tp4nss//cZbxaWGuNR58+k8yS2gBqO8UQbIbjSpb9DA42dDnV36dG9UBn4FHeD7zHG8ZjplZB492wwtIOub0pOmQqAQnivKh5ce/Xh2rv1y7uHXHYU0sHQDmX1dU9rSQNlBFl4AIGOfpGQ0RQJhUAelZRuieeKTxqodLylHk3JM0jCdA/7/AAAAAAAAAAAAAAAAePIB9/8BAAAAAAAAAAAAAAD49Hz/z/6nsy4JAAAAAAAAAAAAAAAAgMcFOP8HAAAAAAAAAAAAAADgyQe2/5+YNTOz5lmXBAAAAAAAAAAAAAAAgCcKD2YmZjPbV+8sfTaT+ezVuQu5KRO7CZZkQRBqRaEm87LQqNalilSReZnvSCWh2qmKfUO3dFnvCkKRYIn8g38s1Z2fNsqy3uuJmtIW+31D3xe7FjItXZOJD8PrYrc70O5q+j0t850PLz31XzPTU9/KzLx74WJWmP6Jqb+a+tbUt6b+burvzrqZAIBPF946qkxf2Xs50v8v4xdU7FjIaO/qA8Ns76qmpRsHbT6BYGL38JkjIXvl5Zcn3315xKVpSIIkfjt+n7/x1MThL1Z02Jev47OXcd/Kuu21yYjbXuwR1fZhvbqyubpys4X9vu4OeiLx1E6co+4NVAMpUY5lI2i5hWKBp3576TtTHxgyans+gh2/tMGXxE+w45c4X8jvDdAA2S6AfdRONX2efwMUi9zzra3tVmud44nP21KxSBjRNGG5b5LKLTaDnNw3TPqwujeL2GV8NGPPWe5njsrZOXktN8yGOMtl+7ivd1X5wPY8bsdXiCWN8ZabwDfEr3ls4rTucknKJZKSoyk5WdQ03eIkxNECKLbP3OHmUYm0y9H5dO1CfYyffruwfOP9CIe0C4010dpeNlVtp4ssXbvW3Lh10/uJpcTx309fETGxn+4jA49R+sL+McM5b2UDiRZx3EwJvN8OhYH2VY+B8+sZ3uNBa0ecP2MS7+cJutQyRM1UXWfI2r7YVZ1ufXj/iCfderiRrlt94UROsVsTwoik6NbwCBfxKXH8hJG+4Z1HSMMThnKtWTxB6/cGpsWR+BycopqEod32h62jYvbK2trke1OxMxNlFP92Qkw1L9llItOSK/LOFMJOTFSTujRNPtmVfDMfkSv13G4Pl6gJy35tZ+R0RrTfdPu9fx4JdZdu92IUK+81MzkyQzciGUPhlKEYXQZvHEfxYygcfkwWoYzdOSuTmSqe9ToOAPhEnf9PvZWZeuv8Vu5vzro0AMCThF/7+4fV7Nzri7nfa9lLSucLGO0jzTLdmD5MyC+86vNTBVaP6ViMLhz96YKx5kZDzTlf4ZwZGRbO9AcAo6HDTCconPe17wY5YxPQwHF26RkaJ4pZZAQ1vKepKsgIDYXmxUALS38jPj0twNsmbqX7liHK1gINUYY0q40fF/KfX5Z05WDZOuij/GIzPzCR0e4h0xR3UN7HxSsIxzSxhzRx/Tw48fZG4uoFGtkfPY1G2KMbFjbhsok0HBzP/WkhZNgB8oKJVQX1+rqFNPmgfRcdNNM0DN1RWFMiWMbG6+v3u2po5L4gF/IZJxtqnyS3BmYz30eaomo7+ST6jqqJXfVreBskhNRXQ186VbPYutpyi+sZJsfH5OpI5ouuYOYXmwGGGElSfIKsV3VNQzLmFtKHGHibiM1edhOcsPKibOEwe2H1TSN4dvKTlMBC963jF4CmPkn+ek+1LKSs7oqYFOHPxeMWJoRVSMlWN1ZutTZXWwvpO8myRHm3h2eQ/GIh/8ab4UUMZxzVc6M8GZbs326oyzhVSrZj20izDBWZ3F6IGt1jtGayEt3D89mJVd8eq/oU1eyLlryLFVZ6vbc3pt7bO6be23ssem/v7PTe3pnrvb0z13t7Z6z39j7+em/vY6r3FseJcGurMo7k5wTiZMKP9lSzh1UPE/9vYuqXM1O/fNbfSgAAIJPJ/FP18HZ2bvMLuQ+QvWlwTzfutnuoJyEj6nOfIQnuF6RIPbpZwPKLDUs/wwV2C1Y2PW3Ttp+ORJb3EdlP7cMt/0O89hph5991uNV6YYuyd5Zx7hwdrC5eEK6QsMD2e4cz0ax4V2PkDbtUHC2IO/OTkO+jiZ1H4XWg1Pvlhrt3EpZD1F7KKC2zwhRlS91H+UJeVXCsV5LITRnoytEltFs2Y6BZag+5DWmgfV2mcWj9fei9sBkG6+MRsFtACV3rtW0sI2Z/aFSARjeBUjFO2W0JjJz2M2W9j5ohAuIjiNw/CuVNeruZN1AXiWbgE2DjdngaeWAYeB3i9OdddODc+zhe6mthlWLeBxYx9F+2egtJjYI/cQxT18RuniQMCG7ErmXbSeSKMA47rmo7Abm1n7rMgmJrv0+pBUZlwUk/rkQl8WlbuwYSlcgxFCBK5GsLk602nAXnIrOvmtxPPVETd5CSj9Ixn5CuCtOiCsJLdTzIFsPaJr5Tm3kF7avap6pdQgZ6UiPJXXGgBDbRR9U5UwpT3dGQ0lbxHTz7b31g5cfqGVlX0P1UeTaZ/BLo3SxQT1S7RMHaNxwSEpLSsOo1rXYNVYxRchWxKuqiHVE+CKyJWJEKEowhUbSEIwzGXQlEMgrOZ8HmTpOw2dXvIWPBMtTeQlKfujJ2LEVwWiIeuxWQ3964/XL7ldYrz7dut1fubL20cXtt6/X2K2ubr6xsrb7Efv9f/Hzm4ufh2wsAAAAAAAAAAMB4/yuHm9m5Zj73S9vshrx9U6tt6APHCId9HroNH5ImYu/d4RK6+b60xK3qGjlc5HhO1BSuxEm6tYutuvTuPuJW8Yck19XvcZbOWbuIQ/cx7a2BJn6xJ97nrEG/i5Ypp5fUnV3CY9C1DJGTd0VtBylcT1dQlzy3dpGBOrqBOAN//GiO/cJSB2kyUpZDTgNIFSzRvEu+LC1n/x8/Jk/ukXrizW1rmdCSjzx2E5+QmeTeorMHjgmR4XxZMUnYwwqcrIeT9RzGblpsI2ffQvM+XDF3d/vdcrLCRXfIrTBG7vaGxVyBCNyIsN/3Df1tfNHNfu/9ZHj0iTme/R7/aT/viCZ9iv9Ic4vSe5+QpxmRp0myatumIBF5h2+gsLs9Dnt8TYLIafNe8In32ewVoZnv6vfygR2kmOMK+2fEFUosQc41Su+UyKUjg2XgHmaYBpE2Y9kZpFg68CVI34mGGbiDieWHNgy9bNn0blbeU/E5u+9j30y4ARly/4ckYwvl27BPsQWwsrXVeuXLW+3bG3e2WqHf/5N/mZn8y8yfg7YHPIH4Z5873MrO3cnnvrcSNn3HHainmcrHO1KPndbhTP0jPVMPW08c82idTH3pzhoiMoif0dMca/vSeY9TzaNw7A/H/nDsD8f+oydacOwPx/5w7A/H/nDs/0k69ne++VdWVzfurG/Fn/9P5f4mc+lvLn4G7P8BAAAAAAA8uTj88cPt7Nydq7l3X2G3hJ09OHdr17+l61gvhe0GJyQNemd8AbvBs1BhdBfPtkIiGfmd+Y04aPFtKJM74fFnqGLojqe9ScoeY2J3i+xuKLs0lbui2iOHVX4jdmOgad49cPYo0D6ADNTzWtPLMtSPC7F6wvleY29ex5xBpl4cf/n2xgtrt1reItlZHNtr4kdvHb5GpOObd1jpcK9Ph3ex0+Zh0pGQdFQ6vN3ggnd2W2BrXaAHpgX2tLYQOGFlvP4cX5ZCzuypIPnFZ0S0TiRFhbyBZH0fGQeu29poybJbipUo1fVT6jUffh84CGdOn72Wvebu1PuOpmlyck5uP2ebHr91z8kDjog8Hm7PXIs8Dncay8nUOxBPZQBOJXyztbm5trEeKeGH04d3snPyF3PvOh5sfWJKT66jpHXknD1O4uNZRahFcn0jmAsVYMcNbdgxO2444sGWmmv0DdQXseDYr1yF0gwevNsEvrORFMMjSfjZewLMkdapDITUIrC5vba1+lKkJJDz/+x0Jjt91nMyAAAAAAAfNb69f1jLzr3+xdy/0O31kLv8GHWhRZ+nWgql4zK6Cgrz21UYcf5VCHdXFLN6wjdA8PLGcevvevW3V0B06UM+vUJdh2HysBfM6iaQ1nZTFkhIn0anYmuztkkWdeFv6YoYr7bd+ATpnV0668UQr2qariH6rRlVZdeNWghRoPiMJWp0C7mO3MJownONbzTHBvZxNZGvvKlaKaLiLnFC1Z3LvqEuWqM9d9mX1fOLx2UQ4p/Nlzq685nUwayx/9iEfHdFZYX1EEa7zTIG+O5ZR+yazuWzsWsU5MxWbcHvwkw0DPGgbYeu8ZlTj9MGbGaLheLijSJbcidMBfl0X3h6kX5yUf6ivBtTmcXFZvljL9+iJGqKriXKN8sK5Bvkm5HvBJ9/zmzPrBs4Okq+SIXQF/fGF/QGf/9Pnt/KXPr357dg3QkAAAAnwwdvHH6VOHD8cM23u67uYGdOcfYmlCR8Qz02dYS1ic0PjE3O3oFjx9B7p2JqAuYc4MURvDiCF0fw4vgp9uKYyWT+4nDl8PXsXPMLufeeCVlm2A6fx1lbsEnGXVCEHJc7DhloTaKcMQQicQSmSSco6WPIydLj8wm5BeC/VjXi0ToyLtZIZCxf3uwCJMqs0xKNHeTZGvsuTCVfBVh7cX3lluMKcG39tZVbazft739Y6wMAAAAAAAAAAAAAAPDkg9z/n93IzG6cdUkAAAAAAAAAAAAAAAD4xODB8sSFN7crDy5dmJhyfB7U+I4g1fhGSRI6QkVQpKpY6TQqDaSUBbHUaIiybLVrpXqloihypyQ2hI4kSB1JkpR6iS+jUkOUG/bJ/3JX31G1JVnUZNTly9VOVRGUDl8pF2UeoSpfrVblTqmBquVapVYTyh1eqImVUqes8B2+xDdEHik1sVMrFouKNJn57vfx93924jcyl/7xxZ+6kMnmz69PDSZ+46ybEUAwvJN9avvOhanticyjyuQEvjLSRrIsV2s1BVVqiiBKSr0qNuSKIJWqSJSlYqWjSOUy6tSWavUivyQUK50lsSyipWpRqlUqSK5IxWrmu98nQsdXanJZ6igSX60JHblS7zTkYl2US42y0FE6pcmvz9vWc/PX+cK8fWVlTZm/Pp+qLPOFedMykNhr9XV5d/76fJrC4URob4BDy5Bcsf8LQ0HKijV/XagUi3xh3h4MpCCpKjJfmHeucr3oXp2Zv17yHq/qmoZk/Bhz1QbdbmFe0pWD+etfn8e2evPX53fE/jwujmjitG5KHEYE+xGZL8zjy0ubbNmtXUMf7Owyz955Z2Jrcvja9FPbdyZ8/SrJgiDUikJN5mWhUa1LFaki8zLfkUpCtVMVq9VOudioVJbKlU51SVAEfklqIH4JoXpZkBqSjHiEBzRpj0oJIbFU5+tluSFU6uV6TUBiTSqWO1JdQUonqWOTCjPSsWlK5+vYUrqOTarImXRsKaRjS3bHnh/p2EathIoVuVQWERKqVSTyfLFeLZeK9UpD5DuoJHaKlXK5s1SW6pUloV6rLDWKjcZSRSkqYp2vSkpHnjytEZtUmJGOTVO643Tsx3LExnXsuZGOrSnVRkmoV8tlsSRItZooNUq8XONrtaJQqlflmqjwqFatL1WrUnVJqEjCklSWqkuVRqMkSx2pWimJpzZikwoz0rFpSvcpGLGHzSk6xV64c/TcKaritP0qCEWCJfIP/rFUx/80GJy5suYfa9fzUV0/n6Zx5keEA1u+YqN04n4M3wKfL7DPYjkXPZRJu+Hk1+fR/T72vEVkbl+lXYHl59cmD5uTI/JzGorhI5Sfx686PpXyw6eTn3cmbPnJvJc9xRVD5rf/NtU8e+brhaBslIvF4umtF/ixppWBiYx2D5mmuINrZg0M2hR6X9wboPZ+qc3zolisNTpKvSh2qp1OpVwVO9WaXGwUi1WpVu5ItUq5Uy4p1VoZCQ2xURI6DaFYEhW5LJQEXExTHxgyInz3BmiA2pWyyPOKWKqXioIglOtig69JqF6siXKnXiJ6iDgRmb8+vzvoiRouGbpvzV+f3zzQrF1kqTK3q5qWbqiy2OUIDYe9SqragDZDYV7vqZaFlNVdEUsxMsz568V33pn4v5Mz+Pv/8g8zl384+/rs+dk/m/3i7O/MDuH7GwAAAAAAAAAAAAAAnxgsTm3T/RRB5Ms1vlqTBKUs1Gv1ulyjh+qSUBaKUi3rUtZ5UUaVelmq86JQLaKGVOpIdRmVSw2pKkvlaZcyadP1vEuZtL12zqXs1EpKh69Wyo1KUejIDbFcLFWlCl8uK5VKpVKecimTDl4nF6a2L6TawMHn/+cu9zOzvz5bv/ynl/tn3WkAAAAAAAAAAAAAAHgyIJ2b3r565+pUqg/zvqFbuqx3hWrybQtxYOnXxW43870PpCkmj6RPejePyhh5fPePpEkmj6TNADePFLeO3Dy+86E0weSRtI0wRh5ePb7zIT7/P3f5NzOXf3P2X1/+u9lXz1o+AAAAAAAAAAAAAADwKcX2+e2rdyZOfbvgHMP3NLcIphi+p7ktMPka5nvh1LcC8Pl/LvPXmUs7F6dz//3cM1O/PvWFyUuZv848uXj4Y0d6dq51NTe8Y8fNcII4tLuihLrtu+igrfZwUEWpi5x3gbgZcUlG4zkTooJLSuJE2AzsUBqt7WXy2onciwOO0gc4LIXzliQOUuCHcdEh7ZxoIThVQZqlWgecanJuie1gEA8/c6Rl516+mhu+HNMymokMi0YJGaNxmFSjsUUiGsOtLg2gvHGbswPRrq5sbi34yVY2uedvbTy/uEga5/nW1nartc7xJKyGUGxU41rIDonJ+VvqLjqw28U66mWvPHd14sHnVE1B9/uG/jaSLbZ6A03dGyDnxcBujzvra6/ewfW82foKF5kK12zdfb3gvl58cPGoS/N90ck32Kw0tI3zworINzyVmy95zeTrRCvBxmvXmnkD9fR9pOTfLx7dzc690cx9e9OWDmq/hDodJFvY9lbvDmjQcX9wugiyoNSk5DYqPVH8g1FqcEgXJ6DLDEdDuthpNctQkcntzXA0rIuPJcL2Y5qMOIRzQ8v0pao092j4OJLCjQ1jYiIS6WVv2RfkhbYqTkNCujhc3HhuezRmUTMv9iR1Z6APzLz7zlz2ekPW95Fx0DbQ3gAbFeZnFmc2btOIwUSMycBwykzDJF9r8pjGCf3ONC6JAo9VxD7S2mK/31UxRzYaPE0gIxyseCSi+WjGLCnJlyVzo14HqPK6hIU/n0yMw0lTu7w8TocN4dxUtnIYiZ0clT5MVZSKNAyzLxiQE+KJER6MCAHCYEWijfNzoz+5AYMsN9TTxjpnMaISlBs3OpC1TG0H7U6jOROD93womSehzDtSGFVppm4lO3mc9DohirGIhcpXSAjsEZFyw9XHKGqSK0eHJefl4oXJ4nqq2RMtedfW3If/8Ojt7NxaPveu6NNZtpFn20SW1UU4MrlPVdHeDNVPUSlHJ32bktFQlK2nlpzxaFM282/QCjopbc3LiR0LGZyX45ujI5QNd2aPYhwkXu2SP6i/KPy3Gy09XLJ9Mj2iUDnDFgPD04F4GeITA1oyln0Yc7cZZWMgeSqeE53AZ8umqu10kaVrRIckRMD2txu7tOHQfRn1La6jsy1Im1bsOmLy5pGanVtr5t57LlRMGIEmBR5rRotiMrPywlbrdpp5jFR8hnNI19a3NuKbccFtvIIzTbRFy/nbbO+L8mDQK3hhxHC3vbZy605rk1vgC1igZAOJFk1WLPAkPto6t7qx/sKttdUtj/8id3PDkfnN1hbpbybL5itr6wtsEdB9uTtQkLLMPFwssMmc0jVfWfnKQrDEweTOC5sFEzVtdWWz5amudebVs41iscY3GqWKUBOKjQbPbfkJnnEUfOvWZitW0EizMyk5dH9XHJiWO9Ba6ze/NNNav/nos0e72bk38rn3y6ECZiGjp+IYfF6gdp+kpVBIkSxsOfMUE9UVEWppLF1yFoI56CsgmKcmmOT8f3YtM7s2+yez92Z/66w/zgEAAAAAAAAAAAAAAPhYY+nc9lS6awqZ731wzqNOunyQ+e4fTXnUSVcKMt/5cLJwbnsq3UWBzHc+pPH/fpCZ/cFZNyAAAAAAAAAAAAAAAACAcfGTE7nMly5MXJiawsb+BjL7uqa0yUWy9q4+MMzJzPc+yHzvA3z+PzH7J5nZP4E2BgAAAAAAAAAAAAAA4BOEwrk3L1wQLQv1+la7xncEqcY3SpLQESqCIlXFSqdRaSClLIilRuPSzIPMdOZ3M7kPs0fTR5nfvXzt4s7F+0/94cUPMh9D/PzWUSM7h17O/cqUbUYTsbvRpgERD9rUWoSa6CXQBqxrxuEcNP5bT0rNGNu4pp7XiC2d9xtb6eEnJKAjtgdD2CqMGs1Qw1rbNUA4QdF5TV8wpqN+k3rPzJULM9dzyoP2kWaZHPKbtpKnbRoC1ORM226KGEAzBq2IrZVjzoyTtBEOG4rfMz8JE2oFyCYkZqcBPvg9DSTaNJc1dN9qO7/tkmAin6UrWqZFdqxccQTQZWxpnF9s5tn4n/mxOJAAnZgF6Yvx0joBQfOLzZHuIpaVi15H0R5aCO3WZh6bPGJrH2pl6+vUYLc6pG1bUZhcz2fo21v2zO7D2763rCqo19ctpMkH2G9AROm9pugtU+nDhmU2s2UTadiozP1pIWS4NsdOMmLRJhvYXBjbpg3MZr6DTd3Ur1Fj9YjW9iXEEXyZlg/rsMVF3MxRjUsMrFK0bLhBuGM+HS/Prnl1XDPuHbc99sZuDyJ8MWa3jJajRspLRMvZ4WgPXJNODt0XZcsOTWsXlUoqtb998I2jenbuzau54QVbrzvuFNoJitShCyjvtMlHbHCdhKGmjQnMFrzeLITpZNaWEXeyqhSKi8QK7+FrRzUyrx1mU85rCuqixzOvsZydee1m61ZrjHnNGR+hM4lpjwXbdtxrsxNJmixqmm5xEuJo+RVbsoZXj6qkZR99NmXLsp5qTrdl433gnKBlE5I6/lyiVI8zv0SuFWzXDKfTPwbqd0XZ7aBMJvM/M088HlWP2tm512u593c8z0okLHmbCS1vsrbbjoOlUapRb0spOI36p3DNwEMZjHqpcELXk2Hr/CC28p4rigUypKkbmz7SFFXb8Vx+MHblVFRM7A4F9UXsxaaAn+ld7GiokFeQ3FU1xtyc/Inu91WGlLpSGGh3Nf2elieTFZFjtgyj+cSW5p6Bw6Rrj7swTjYRZTlpxgm+MtRuF+2IXbfbOabbOU9sHAX6xtFb2bl2LXf0TKzkMstFxnXaMYU3hFmI/Hqzre1Ux/5TxnffPdv3gqxrGiKcMcEM9TSBTKutKsTJUIH5rQ16EjLYJ9jFUKGHrF1dcR8r6g4yLczK2jWQqGC+tmOdgmqhHv6/2Md1E7v4b6xJC1JXl++q2k5BUc1+Vzygay+bJfWDoCBRwV3eFq2ZyIEZ7+pttEs95yohLt9I/L/MDzIXO9P/dupnMz+Y/B/4v8wnHo/OHe1k5zbzufc/F+9ww56Uj+tsg00e5dAF/Gt8eh2/HL10JGXn7tRy35qNVZ/OfHrSad/PZ1RpOu9Ped5nJjHPOyV54E6Ezt5Q3OTM7Ju4HBPoiP8p/C2rIMUblukn1MVAnhG8mu68G8jbLRydE3zrZT/nY1PSjcHAw6gk6H4fyXg6CXRb1OsAH7fWIi3gaOE8/zs3CGt2zmKdwR13BeJK6MhS5P3qkZidk2u5b7+ZMJbsynZU1FXMkw+pEHZhI8vXP4XoJk859uiICVlQz6QfI3FS6nRtWvkc4TVasVi2UZLJyGHigA7hH0cbLH68OqPfwWEtH9O66fvg5FpqPB2VVkON0/9jaafT0U3J/ZasvdLprgStFaGtaOHjV9nv/9jRz5LP/2/nYzWXvSl7Cl9QQU6j+ipKHD965fS4RvsnTPGBcgLldLrKyRkjdKxbUd//E5cXMpcXzvqLHQAAAAAAAAAAAAAAHwcM7+Se2r5zYWp7IvOoMkmd0XVqJaXDVyvlRqUodOSGWC6WqlKFL5eVSqVSKVcrRcSX69UlVEbVJUER6kuNYg0HoSt1hApflopCLfPd74uybLX5Sk0uSx1F4qs1oSNX6p2GXKyLcqlRFjpKpzT59fl9ZOD9kvnrfGHePvtfU+avz6cqy3xhnt4xbuErxvPX59MUDiey7xOTXHHsJUNByoo1fx0HA+QL86Is6wPNIgVJVZH5wrzzrf6ie3w4f73kPV51rytgrtqg2y3M44vC89e/Po+vK8xfn98R+/O4OKKJ07op8VEFDgc0X5jvGHpvky27tWvog51d5tk770xsTV7K/pvM9ORfZS5+MPMr5//D5F9dWrmwd2Ev+9/OWt4AgFPHoy8fWdm5uxu59/ecy6B0+LYNbMrRVXsqCbyDLOdafNsJl2jfB00gD+7Nj8l+dJOeudikG+qOqrVD7jc5uXRUjZwsqBq5mnQPobvdg/Y9VVP0ezRfE9/E0CUTGftIaQ9MpLT7yJCRZhW8eD/45lFiRelpAN6m9Ip4jdwr9X7Ta6WYJrLsNEnka49DSB1p2pAXXqqIJqApI14ypQ5rKLvEYa+8lF5jUnKmcePu0NKqcLjRl0ij4+MlZMXG7ByiIzM7985G7si5Op8odO7RiRsk8PEId0Q+o1KuDyxZ76FCV5fFLhP5ihtPEpnjVBrpixyhdnXTPkD1rquQ3qWZuqc9uFfpI+fKComwGiwSQx58l2gtEdW/7j69G2kypKOf+sOJ/wJzwiceD68d3cvOoVdyw7mk8WogSdUUvwljPG3qIRrCOsSGMSGzY8k6TeuTdLGPD4+XdK3rBNx9+GNHeyMhmoPRc9lTcvJu9GA8MknaEM2EwUcSohnnlC5Ec38kRPNINf0hmtM2TlKI5rDGOIMQzUxLeSGaM5nMwZmM50dfOhpk53Y2cu87HZI4L9qD7/FMuizzUSmXB4aB74WMLrXGnGujGdkrnsj39kScYHacpHs4gzETNkZMUWlUUt8z5hqjsYw/j0PKRtLFFt1jYelhDBLr7jEIWbmS/MNXtIunpW17qomDMDLn/9nLf5yZ/dPZfzX7jdkvz37+8t9e/uMzGUkAAAAAAAAAAAAAAACkwtPZ89u5TCZVEL6npz3apBB8T5/3aJMC8D19zqNNCr/39NT57Qs2bdL9hacnPVoky3K1VlNQpaYIoqTUq2JDrghSqYpEWSpWnp7waBu1EipW5FJZREioVpHI88V6tVwq1isNke8g7P8/e/mHmcs/nH199vzsn81+cfZ3ZocgcAAAAAAAAAAAAAAA+MRgcWp7ItVeQNalTNoJmHYpk/YBzruUSbsA51zKpD2AKZcyaQdgcmFq+0Kq7/9LuRuZ8xNHmZnpaWPi6PL7F3/jrLvt04j3d4++lp3rbeR+6R8kXSLq611VPhhx7xpPP+rOcFz+Y9wOdHL0boqxV8T9V8Y9z8PslWn/FWrWOzF1mXJt1AeQTeE5+HkWk3g/R1zoj7qjw04z9lF7oEn6QIvyRWcTMSSLkd7tZF2T1a5K/ew7bg8j+Nq30M1Bv28gE99YjmUeQZ6iuB7JePeP2JQRN+dvxFy5T3AiF5cqvA3IPW/X132w8wqRzV8IabtCaDsFPQOm6deo/orrh49lVyW6/nd8+EVePaOKJMSh8EtHB9k5tJF75LjCTtJFPo/sp6znEnyyp9dxVCixgiEGCKnlkQnuEXMd0taYJtdnrj32nWgRnj4l/d6nhbmGZbWnY6dyx74/aHcibSVyH5new3Vv3U784VnPnYCTY/ijR/eJUcLhz6U0SvDFnzhdo4SEABRJRgm+OAkzqe8Vu3FwxBlnfImprhUvPj4ziEe7R9/IzukbuW9eTW3blXZdeGyjrvRxBVJeJ3ddCrLeBMPd9TfzqNNBMgl7YxBny7bDTiZpgCLMx77Yk9SdgT4wiV62jANiYFFwrcYWR9jGpVsct4yUmS/yQSQvx3wtwjGpV6Iwv4t2Yt+roNEaXnjQbnJtUeVdUduxZw2ar5ejyz2dh99ok7fgsuChefR1siw4bKZcFqRSQcdcFhxTB/mXBZFKyJvN2Znc/2UUNZOfbB43HWfrCnP//3zmzzOX/uOMPP3lKS7z50/IfHq4+u4EmdLebaec0lItM483pR1zlemb0gIrxNOc1mgwqlFrGSyCYow5C0kYYUrDMAj7eok23XZShavKCBV8slnY77vXt8I9KrybIWL083xKMbI1yOMQI5b1KYvRDDeOIJEYkIlakOsTw0FGqTVF/97PcQSyH/3BTF+HiVuoELppnA92bz8hSvxYkXNoaa4RH9NNMWFHxLdj4GY8MrMnZnQjOSf7w/5EM4iiI5PDkbzsMfM1HNALi5c9Xt6bPfq57Jy5kfuFxK97Z0VpSzVZrDymRetoFqewbA1bZzmuop1p2//muDaP3oDyff0z42pkVzUo2qxwc3FjiBW18bedUohp8ibhyKDgjrFy9Zcmads0dZb+kp8gv8fZxqmamNEKp60RsNQPDMdk/ehnjv4RUQnfmhhTJUgIu4V5rCqByeJUVULgGzBENYRTnIGKiFUGxxXSaN2T6jM4ragfT5tEf0CfngZ7jMMLx48TLXnXHl+HjaN3snODjdy7jTHHV6ovnhMOsGN++oxuEY3/7eMbEyEjYj3oreoEC8yk75loCY5zRXXakkMHGxt5+f8D7+PbQgAQQwA=";
const compressedInputMetadata = "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";

export function canonicalAuthBudgetInputMetadataBytes(): Uint8Array {
  const bytes = gunzipSync(Buffer.from(compressedInputMetadata, "base64"), { maxOutputLength: 302642 });
  if (bytes.length !== 302642 || createHash("sha256").update(bytes).digest("hex") !== "5b368703cf944e97298152465c113a2e1913403d08ebaa8f110e451d4a963152") {
    throw new Error("Canonical auth budget input metadata mismatch.");
  }
  return Uint8Array.from(bytes);
}

export function canonicalAuthBudgetDatabaseBytes(version: 44 | 45 | 46): Uint8Array {
  const versions = [44, 45, 46] as const;
  const expectedBytes = versions.reduce((total, candidate) => total + canonicalAuthBudgetFixtures[candidate].databaseBytes, 0);
  const images = gunzipSync(Buffer.from(compressedImages, "base64"), { maxOutputLength: expectedBytes });
  if (images.byteLength !== expectedBytes) throw new Error("Canonical auth budget fixture size mismatch.");
  const generatorSha256 = createHash("sha256").update(canonicalAuthBudgetGeneratorSource).digest("hex");
  let offset = 0;
  let selected: Uint8Array | undefined;
  for (const candidate of versions) {
    const fixture = canonicalAuthBudgetFixtures[candidate];
    if (fixture.generatorSha256 !== generatorSha256) throw new Error("Canonical auth budget generator mismatch.");
    const bytes = images.subarray(offset, offset + fixture.databaseBytes);
    if (createHash("sha256").update(bytes).digest("hex") !== fixture.databaseSha256) {
      throw new Error("Canonical auth budget fixture integrity mismatch.");
    }
    if (candidate === version) selected = Uint8Array.from(bytes);
    offset += fixture.databaseBytes;
  }
  if (offset !== images.length || selected === undefined) throw new Error("Canonical auth budget fixture framing mismatch.");
  return selected;
}
