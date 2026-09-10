import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";

// Exact synthetic archived storage evidence. Provenance distinguishes released
// writer outputs from passive uncommitted stages. No native provider claim.
export const canonical20To40Fixture = {
  "generatorSha256": "b18f167d20805c7f88fe9ec1a38c10bdc74cff22c7eff9840f53e5f519e94baf",
  "bunVersion": "1.3.14",
  "sources": {
    "canonical17": {
      "sourceFileCount": 119,
      "manifest": "407df7c80c5b3503670a4d3b75a90619f0f32d70133b6cd01338dce124d32937",
      "pins": {
        "src/storage/state-store.ts": "31d462821d1c7830a38e917c989c0b44ba03b8f3c1812788d8eb554d24c09cd0",
        "package.json": "1ace2e19fb0f9e63e37668baea728c1063b4e7fc89865461a3e59088e9f17ad4",
        "bun.lock": "650f295c061c3573d0fb4b5542f12977d8e4b5ab8b65d1e019b290f4a205011d",
        ".bun-version": "56b0485099b6c5427d3b68c042fd05b632d5e52e924c5064473389812227164c"
      },
      "dependencies": {
        "@openai/codex": "0.149.0",
        "convex": "1.45.0",
        "zod": "4.4.3"
      },
      "dependencyManifestHashes": {
        "@openai/codex": "0580493a92b83d962b8fdc8585a66c963431c6ddb54fabe4b3797970095f000d",
        "convex": "aa9f5baee26b69a88d6b61180e540cce1f52baa31094e7124c8c0393e4b3211e",
        "zod": "c630bd10b52dcf71c112a2bf78dbf2734b9db58d62de663b8d86c2ec2c8cda2e"
      },
      "commit": "c018e91fcdeab9fe66078c96ca25c34d198a6189",
      "tree": "4b7a6d24d8be24c889b735ee9146555dc139e293"
    },
    "canonical24": {
      "sourceFileCount": 137,
      "manifest": "ec1dc3f9f4ee123e631eb1ca1da79ca5506c05ae12d9bed0133aeeb0f488d227",
      "pins": {
        "src/storage/state-store.ts": "e312e1bf91023ad0655a62eab96f69d609468399e118ff0ab4bfe9d02d782748",
        "package.json": "d1ee465269aacef1ed193c32571d1f1940074e8f3f120e6c47fd0d45b370feb9",
        "bun.lock": "650f295c061c3573d0fb4b5542f12977d8e4b5ab8b65d1e019b290f4a205011d",
        ".bun-version": "56b0485099b6c5427d3b68c042fd05b632d5e52e924c5064473389812227164c"
      },
      "dependencies": {
        "@openai/codex": "0.149.0",
        "convex": "1.45.0",
        "zod": "4.4.3"
      },
      "dependencyManifestHashes": {
        "@openai/codex": "0580493a92b83d962b8fdc8585a66c963431c6ddb54fabe4b3797970095f000d",
        "convex": "aa9f5baee26b69a88d6b61180e540cce1f52baa31094e7124c8c0393e4b3211e",
        "zod": "c630bd10b52dcf71c112a2bf78dbf2734b9db58d62de663b8d86c2ec2c8cda2e"
      },
      "commit": "cdeda22239a70c26493928bab9aa6f346f576282",
      "tree": "c457c53afb998fe60ce01d0fce4a5500196159d6"
    },
    "canonical40": {
      "sourceFileCount": 289,
      "manifest": "75e9b44a58e7063be0275839a9e632df71ac3d1e90d9dea789ff4f7b337db3f2",
      "pins": {
        "src/storage/state-store.ts": "0e9e9f772b9caeb5c1ec80f58927c643643b28ac6cc7ca1ae868028d61cef32f",
        "package.json": "ef8779bd5fa796f395ad3d064710e247a89eb0cbd4023dc069b4daaad8e12d3c",
        "bun.lock": "5a2b90063d8eb1aa55e18be71abbca59c1f051a9358a2a36ff89698d066b182a",
        ".bun-version": "56b0485099b6c5427d3b68c042fd05b632d5e52e924c5064473389812227164c"
      },
      "dependencies": {
        "@agentclientprotocol/sdk": "1.4.0",
        "@hraness/oh": "0.2.7",
        "@openai/codex": "0.153.2",
        "convex": "1.45.0",
        "zod": "4.4.3"
      },
      "dependencyManifestHashes": {
        "@agentclientprotocol/sdk": "89bbcd7a71a3cd6e94b7096ef1f239dda62b5fb8aef840d3475af3fbfff3a955",
        "@hraness/oh": "ad5ea2f55afd7f2147558e8ee0ae73d6d38c96d9ae8ec97dc3aebf6d5dd5b05b",
        "@openai/codex": "4ecf4eae28684c5fcba8b9a63b946ce22b8cc2e451750f23c04e5088cf4c7a05",
        "convex": "aa9f5baee26b69a88d6b61180e540cce1f52baa31094e7124c8c0393e4b3211e",
        "zod": "c630bd10b52dcf71c112a2bf78dbf2734b9db58d62de663b8d86c2ec2c8cda2e"
      },
      "commit": "6f056dcafd6435cd11ae504c75e9b1f869955ca7",
      "tree": "b5de09dee16ff661f6dd45fb3a2dac9e96411d10"
    }
  },
  "captures": {
    "canonical17-settled-queues": {
      "schemaVersion": 17,
      "source": "canonical17",
      "retained": {
        "profile": {
          "id": "acct_5daeb2853882433caa0ba2b48f7333e2",
          "label": "Canonical17 settled queue controls",
          "state": "signed_in",
          "processGeneration": 1,
          "providerEmail": "canonical17-queues@example.com",
          "providerPlan": "Plus",
          "createdAt": 17001,
          "updatedAt": 17001
        },
        "session": {
          "id": "sess_128bccccf4e942bfa8d0fc11a13fe397",
          "profileId": "acct_5daeb2853882433caa0ba2b48f7333e2",
          "providerThreadId": "canonical17-synthetic-queue-thread",
          "title": "Canonical17 queue controls",
          "note": "",
          "preset": "high",
          "fastEnabled": false,
          "state": "idle",
          "providerUpdatedAt": 17001,
          "revision": 3,
          "createdAt": 17001,
          "updatedAt": 17001
        },
        "runtime": {
          "profileId": "acct_5daeb2853882433caa0ba2b48f7333e2",
          "processGeneration": 1,
          "observedAt": 17001,
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
        "terminal": {
          "id": "queue_a6ab04ddcc2d484f805cd8eabc1908ec",
          "sessionId": "sess_128bccccf4e942bfa8d0fc11a13fe397",
          "message": "ARCHIVED17_TERMINAL_QUEUE_BODY_SENTINEL",
          "state": "cancelled",
          "createdAt": 17001,
          "updatedAt": 17001
        },
        "ambiguous": {
          "id": "queue_79939898bc9548b9bad24fd2907c4d64",
          "sessionId": "sess_128bccccf4e942bfa8d0fc11a13fe397",
          "message": "ARCHIVED17_RESOLVED_QUEUE_BODY_SENTINEL",
          "state": "ambiguous",
          "createdAt": 17001,
          "updatedAt": 17001
        },
        "effect": {
          "queueId": "queue_79939898bc9548b9bad24fd2907c4d64",
          "digest": "5a89463e3daa778abee10ac00993cecd39ce3d02728cd5d56ecb473c2252bf30",
          "evidence": {
            "kind": "queue.dispatch",
            "queueId": "queue_79939898bc9548b9bad24fd2907c4d64",
            "sessionId": "sess_128bccccf4e942bfa8d0fc11a13fe397",
            "providerThreadId": "canonical17-synthetic-queue-thread",
            "profileGeneration": 1,
            "baseline": {
              "providerUpdatedAt": 17001,
              "status": "idle",
              "activeTurnId": null
            },
            "clientMessageId": "queue_79939898bc9548b9bad24fd2907c4d64",
            "messageDigest": "690aac0cf05a35fcfb505bd529935f1a3e0ab997764c3905d5ba8abc9d900e59",
            "runtimeProfile": {
              "profileId": "acct_5daeb2853882433caa0ba2b48f7333e2",
              "processGeneration": 1,
              "observedAt": 17001,
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
            }
          },
          "recordedAt": 17001,
          "resolution": {
            "kind": "abandoned",
            "evidence": {
              "source": "synthetic_archived_observation"
            },
            "createdAt": 17001
          }
        },
        "terminalMessage": "ARCHIVED17_TERMINAL_QUEUE_BODY_SENTINEL",
        "ambiguousMessage": "ARCHIVED17_RESOLVED_QUEUE_BODY_SENTINEL"
      },
      "snapshot": {
        "sha256": "893211ca7235862b55eb528ae5ca39358e63b29ae63752f2eb7ee202291e406e",
        "schemaSha256": "6c9cdf192b3e989693d6f2500931f1054e65dbb30fb894e351e2d1dcf10cddf3",
        "version": {
          "user_version": 17
        },
        "ledger": [
          {
            "version": 1,
            "applied_at": 17001
          },
          {
            "version": 2,
            "applied_at": 17001
          },
          {
            "version": 3,
            "applied_at": 17001
          },
          {
            "version": 4,
            "applied_at": 17001
          },
          {
            "version": 5,
            "applied_at": 17001
          },
          {
            "version": 6,
            "applied_at": 17001
          },
          {
            "version": 7,
            "applied_at": 17001
          },
          {
            "version": 8,
            "applied_at": 17001
          },
          {
            "version": 9,
            "applied_at": 17001
          },
          {
            "version": 10,
            "applied_at": 17001
          },
          {
            "version": 11,
            "applied_at": 17001
          },
          {
            "version": 12,
            "applied_at": 17001
          },
          {
            "version": 13,
            "applied_at": 17001
          },
          {
            "version": 14,
            "applied_at": 17001
          },
          {
            "version": 15,
            "applied_at": 17001
          },
          {
            "version": 16,
            "applied_at": 17001
          },
          {
            "version": 17,
            "applied_at": 17001
          }
        ],
        "rowCounts": {
          "daemon_state": 1,
          "desktop_switch_authority": 1,
          "desktop_switch_resolutions": 0,
          "desktop_switches": 0,
          "migrations": 17,
          "mutation_attempts": 0,
          "mutation_effect_evidence": 0,
          "mutation_resolutions": 0,
          "profiles": 1,
          "projects": 0,
          "provider_interaction_transitions": 0,
          "provider_interactions": 0,
          "provider_login_authorities": 0,
          "queue_effect_evidence": 1,
          "queue_effect_resolutions": 1,
          "queue_entries": 2,
          "queue_sequence_authority": 1,
          "security_scrub_authority": 0,
          "session_event_streams": 1,
          "session_events": 0,
          "session_runtime_profiles": 0,
          "session_start_attempts": 0,
          "session_turn_runtime_profiles": 0,
          "sessions": 1,
          "turn_summaries": 0,
          "usage_cloud_upload_anchors": 0,
          "usage_poll_failures": 0,
          "usage_revision_authority": 1,
          "usage_snapshots": 0
        }
      },
      "databaseSha256": "c4eccca3631452d7ce5a6cadd4446117b6712606a5dcf5b35dfff5573eb7947e",
      "databaseBytes": 376832,
      "provenance": {
        "kind": "archived_public_writer",
        "providerEffects": 0,
        "rawLogicalWrites": false,
        "versionRestamped": false,
        "archivedWritableAndReadonlyReopensUnchanged": true,
        "archivedReadonlyBytesUnchanged": true
      }
    },
    "observed20-settled-queues": {
      "schemaVersion": 20,
      "source": "canonical24",
      "retained": {
        "profile": {
          "id": "acct_5daeb2853882433caa0ba2b48f7333e2",
          "label": "Canonical17 settled queue controls",
          "state": "signed_in",
          "processGeneration": 1,
          "providerEmail": "canonical17-queues@example.com",
          "providerPlan": "Plus",
          "createdAt": 17001,
          "updatedAt": 17001
        },
        "session": {
          "id": "sess_128bccccf4e942bfa8d0fc11a13fe397",
          "profileId": "acct_5daeb2853882433caa0ba2b48f7333e2",
          "providerThreadId": "canonical17-synthetic-queue-thread",
          "title": "Canonical17 queue controls",
          "note": "",
          "preset": "high",
          "fastEnabled": false,
          "state": "idle",
          "providerUpdatedAt": 17001,
          "revision": 3,
          "createdAt": 17001,
          "updatedAt": 17001
        },
        "runtime": {
          "profileId": "acct_5daeb2853882433caa0ba2b48f7333e2",
          "processGeneration": 1,
          "observedAt": 17001,
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
        "terminal": {
          "id": "queue_a6ab04ddcc2d484f805cd8eabc1908ec",
          "sessionId": "sess_128bccccf4e942bfa8d0fc11a13fe397",
          "message": "ARCHIVED17_TERMINAL_QUEUE_BODY_SENTINEL",
          "state": "cancelled",
          "createdAt": 17001,
          "updatedAt": 17001
        },
        "ambiguous": {
          "id": "queue_79939898bc9548b9bad24fd2907c4d64",
          "sessionId": "sess_128bccccf4e942bfa8d0fc11a13fe397",
          "message": "ARCHIVED17_RESOLVED_QUEUE_BODY_SENTINEL",
          "state": "ambiguous",
          "createdAt": 17001,
          "updatedAt": 17001
        },
        "effect": {
          "queueId": "queue_79939898bc9548b9bad24fd2907c4d64",
          "digest": "5a89463e3daa778abee10ac00993cecd39ce3d02728cd5d56ecb473c2252bf30",
          "evidence": {
            "kind": "queue.dispatch",
            "queueId": "queue_79939898bc9548b9bad24fd2907c4d64",
            "sessionId": "sess_128bccccf4e942bfa8d0fc11a13fe397",
            "providerThreadId": "canonical17-synthetic-queue-thread",
            "profileGeneration": 1,
            "baseline": {
              "providerUpdatedAt": 17001,
              "status": "idle",
              "activeTurnId": null
            },
            "clientMessageId": "queue_79939898bc9548b9bad24fd2907c4d64",
            "messageDigest": "690aac0cf05a35fcfb505bd529935f1a3e0ab997764c3905d5ba8abc9d900e59",
            "runtimeProfile": {
              "profileId": "acct_5daeb2853882433caa0ba2b48f7333e2",
              "processGeneration": 1,
              "observedAt": 17001,
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
            }
          },
          "recordedAt": 17001,
          "resolution": {
            "kind": "abandoned",
            "evidence": {
              "source": "synthetic_archived_observation"
            },
            "createdAt": 17001
          }
        },
        "terminalMessage": "ARCHIVED17_TERMINAL_QUEUE_BODY_SENTINEL",
        "ambiguousMessage": "ARCHIVED17_RESOLVED_QUEUE_BODY_SENTINEL"
      },
      "snapshot": {
        "sha256": "41f8d6ca7a5f84a59f4ec36bef11b2aa1409df8c705d0f7af03d037286377578",
        "schemaSha256": "b21cb3b3edb830d9ab64446f49528952493d96c955db89270ad8a6695e60c4fa",
        "version": {
          "user_version": 20
        },
        "ledger": [
          {
            "version": 1,
            "applied_at": 17001
          },
          {
            "version": 2,
            "applied_at": 17001
          },
          {
            "version": 3,
            "applied_at": 17001
          },
          {
            "version": 4,
            "applied_at": 17001
          },
          {
            "version": 5,
            "applied_at": 17001
          },
          {
            "version": 6,
            "applied_at": 17001
          },
          {
            "version": 7,
            "applied_at": 17001
          },
          {
            "version": 8,
            "applied_at": 17001
          },
          {
            "version": 9,
            "applied_at": 17001
          },
          {
            "version": 10,
            "applied_at": 17001
          },
          {
            "version": 11,
            "applied_at": 17001
          },
          {
            "version": 12,
            "applied_at": 17001
          },
          {
            "version": 13,
            "applied_at": 17001
          },
          {
            "version": 14,
            "applied_at": 17001
          },
          {
            "version": 15,
            "applied_at": 17001
          },
          {
            "version": 16,
            "applied_at": 17001
          },
          {
            "version": 17,
            "applied_at": 17001
          },
          {
            "version": 18,
            "applied_at": 24001
          },
          {
            "version": 19,
            "applied_at": 24001
          },
          {
            "version": 20,
            "applied_at": 24001
          }
        ],
        "rowCounts": {
          "daemon_state": 1,
          "desktop_switch_authority": 1,
          "desktop_switch_resolutions": 0,
          "desktop_switches": 0,
          "migrations": 20,
          "mutation_attempts": 0,
          "mutation_effect_evidence": 0,
          "mutation_resolutions": 0,
          "profiles": 1,
          "projects": 0,
          "provider_interaction_transitions": 0,
          "provider_interactions": 0,
          "provider_login_authorities": 0,
          "queue_effect_evidence": 1,
          "queue_effect_resolutions": 1,
          "queue_entries": 2,
          "queue_sequence_authority": 1,
          "security_scrub_authority": 0,
          "session_event_streams": 1,
          "session_events": 0,
          "session_runtime_profiles": 0,
          "session_start_attempts": 0,
          "session_turn_runtime_profiles": 0,
          "sessions": 1,
          "turn_summaries": 0,
          "usage_cloud_upload_anchors": 0,
          "usage_poll_failures": 0,
          "usage_revision_authority": 1,
          "usage_snapshots": 0
        }
      },
      "databaseSha256": "865df3729a67528897d677f9925b51a619e4abccf60d16728101ff8d2f788fc4",
      "databaseBytes": 397312,
      "input17Sha256": "c4eccca3631452d7ce5a6cadd4446117b6712606a5dcf5b35dfff5573eb7947e",
      "provenance": {
        "kind": "uncommitted_archived_migration_stage",
        "releasedWriterImage": false,
        "marker": "PRAGMA user_version = 20",
        "rawByteCopyWithoutNormalization": true,
        "observerRowOrSchemaWrites": false,
        "observedBeforeOuterCommit": true,
        "standaloneSnapshotAndBytesUnchanged": true
      }
    },
    "canonical24-scrubbed-queues": {
      "schemaVersion": 24,
      "source": "canonical24",
      "retained": {
        "profile": {
          "id": "acct_5daeb2853882433caa0ba2b48f7333e2",
          "label": "Canonical17 settled queue controls",
          "state": "signed_in",
          "processGeneration": 1,
          "providerEmail": "canonical17-queues@example.com",
          "providerPlan": "Plus",
          "createdAt": 17001,
          "updatedAt": 17001
        },
        "session": {
          "id": "sess_128bccccf4e942bfa8d0fc11a13fe397",
          "profileId": "acct_5daeb2853882433caa0ba2b48f7333e2",
          "providerThreadId": "canonical17-synthetic-queue-thread",
          "title": "Canonical17 queue controls",
          "note": "",
          "preset": "high",
          "fastEnabled": false,
          "state": "idle",
          "providerUpdatedAt": 17001,
          "revision": 3,
          "createdAt": 17001,
          "updatedAt": 17001
        },
        "runtime": {
          "profileId": "acct_5daeb2853882433caa0ba2b48f7333e2",
          "processGeneration": 1,
          "observedAt": 17001,
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
        "terminal": {
          "id": "queue_a6ab04ddcc2d484f805cd8eabc1908ec",
          "sessionId": "sess_128bccccf4e942bfa8d0fc11a13fe397",
          "message": "ARCHIVED17_TERMINAL_QUEUE_BODY_SENTINEL",
          "state": "cancelled",
          "createdAt": 17001,
          "updatedAt": 17001
        },
        "ambiguous": {
          "id": "queue_79939898bc9548b9bad24fd2907c4d64",
          "sessionId": "sess_128bccccf4e942bfa8d0fc11a13fe397",
          "message": "ARCHIVED17_RESOLVED_QUEUE_BODY_SENTINEL",
          "state": "ambiguous",
          "createdAt": 17001,
          "updatedAt": 17001
        },
        "effect": {
          "queueId": "queue_79939898bc9548b9bad24fd2907c4d64",
          "digest": "5a89463e3daa778abee10ac00993cecd39ce3d02728cd5d56ecb473c2252bf30",
          "evidence": {
            "kind": "queue.dispatch",
            "queueId": "queue_79939898bc9548b9bad24fd2907c4d64",
            "sessionId": "sess_128bccccf4e942bfa8d0fc11a13fe397",
            "providerThreadId": "canonical17-synthetic-queue-thread",
            "profileGeneration": 1,
            "baseline": {
              "providerUpdatedAt": 17001,
              "status": "idle",
              "activeTurnId": null
            },
            "clientMessageId": "queue_79939898bc9548b9bad24fd2907c4d64",
            "messageDigest": "690aac0cf05a35fcfb505bd529935f1a3e0ab997764c3905d5ba8abc9d900e59",
            "runtimeProfile": {
              "profileId": "acct_5daeb2853882433caa0ba2b48f7333e2",
              "processGeneration": 1,
              "observedAt": 17001,
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
            }
          },
          "recordedAt": 17001,
          "resolution": {
            "kind": "abandoned",
            "evidence": {
              "source": "synthetic_archived_observation"
            },
            "createdAt": 17001
          }
        },
        "terminalMessage": "ARCHIVED17_TERMINAL_QUEUE_BODY_SENTINEL",
        "ambiguousMessage": "ARCHIVED17_RESOLVED_QUEUE_BODY_SENTINEL"
      },
      "snapshot": {
        "sha256": "32b7f793ba8004c3d61f5590d2e83b320ce226be83b462de9c374775a881c24f",
        "schemaSha256": "fdb34cf11df75c7b04f8e0cd49a935a7aa791e3f5c5fcfd99a5fa5151736a1b8",
        "version": {
          "user_version": 24
        },
        "ledger": [
          {
            "version": 1,
            "applied_at": 17001
          },
          {
            "version": 2,
            "applied_at": 17001
          },
          {
            "version": 3,
            "applied_at": 17001
          },
          {
            "version": 4,
            "applied_at": 17001
          },
          {
            "version": 5,
            "applied_at": 17001
          },
          {
            "version": 6,
            "applied_at": 17001
          },
          {
            "version": 7,
            "applied_at": 17001
          },
          {
            "version": 8,
            "applied_at": 17001
          },
          {
            "version": 9,
            "applied_at": 17001
          },
          {
            "version": 10,
            "applied_at": 17001
          },
          {
            "version": 11,
            "applied_at": 17001
          },
          {
            "version": 12,
            "applied_at": 17001
          },
          {
            "version": 13,
            "applied_at": 17001
          },
          {
            "version": 14,
            "applied_at": 17001
          },
          {
            "version": 15,
            "applied_at": 17001
          },
          {
            "version": 16,
            "applied_at": 17001
          },
          {
            "version": 17,
            "applied_at": 17001
          },
          {
            "version": 18,
            "applied_at": 24001
          },
          {
            "version": 19,
            "applied_at": 24001
          },
          {
            "version": 20,
            "applied_at": 24001
          },
          {
            "version": 21,
            "applied_at": 24001
          },
          {
            "version": 22,
            "applied_at": 24001
          },
          {
            "version": 23,
            "applied_at": 24001
          },
          {
            "version": 24,
            "applied_at": 24001
          }
        ],
        "rowCounts": {
          "daemon_state": 1,
          "desktop_switch_authority": 1,
          "desktop_switch_resolutions": 0,
          "desktop_switches": 0,
          "migrations": 24,
          "mutation_attempts": 0,
          "mutation_effect_evidence": 0,
          "mutation_resolutions": 0,
          "profiles": 1,
          "projects": 0,
          "provider_interaction_transitions": 0,
          "provider_interactions": 0,
          "provider_login_authorities": 0,
          "queue_effect_evidence": 1,
          "queue_effect_resolutions": 1,
          "queue_entries": 2,
          "queue_message_scrub_authority": 0,
          "queue_sequence_authority": 1,
          "security_scrub_authority": 0,
          "session_event_streams": 1,
          "session_events": 0,
          "session_runtime_profiles": 0,
          "session_start_attempts": 0,
          "session_turn_runtime_profiles": 0,
          "sessions": 1,
          "turn_summaries": 0,
          "usage_cloud_upload_anchors": 0,
          "usage_poll_failures": 0,
          "usage_revision_authority": 1,
          "usage_snapshots": 0
        }
      },
      "databaseSha256": "399666dc67cd762f577fe5f0183a1d42f85d65a4f9760b95cf7b39592603c927",
      "databaseBytes": 417792,
      "provenance": {
        "kind": "archived_public_writer",
        "providerEffects": 0,
        "rawLogicalWrites": false,
        "versionRestamped": false,
        "archivedWritableAndReadonlyReopensUnchanged": true,
        "archivedReadonlyBytesUnchanged": true
      }
    },
    "canonical40-unmarked-resolution": {
      "schemaVersion": 40,
      "source": "canonical40",
      "retained": {
        "profile": {
          "id": "acct_d9d68434a6e74ce0a3062fe61a41751c",
          "label": "Canonical40 legacy timestamp resolution",
          "state": "signed_in",
          "processGeneration": 1,
          "providerEmail": "canonical40-legacy-resolution@example.com",
          "providerPlan": "Plus",
          "createdAt": 40001,
          "updatedAt": 40001
        },
        "session": {
          "id": "sess_b1db61e561334cf38baac37ceda33b6f",
          "profileId": "acct_d9d68434a6e74ce0a3062fe61a41751c",
          "providerThreadId": "canonical40-synthetic-rename-thread",
          "title": "Historical",
          "note": "",
          "provider": "codex",
          "preset": "high",
          "fastEnabled": false,
          "state": "idle",
          "providerUpdatedAt": 10000,
          "revision": 4,
          "createdAt": 40001,
          "updatedAt": 40001
        },
        "key": "40000000-0000-4000-8000-000000000141",
        "effect": {
          "attemptId": "attempt_88ffde57fbad4c8d99615fb086f6c9ae",
          "digest": "043152b7832947f89540bbdecbd386ec481c675c9a80db226df501b5494634c8",
          "evidence": {
            "kind": "session.rename",
            "providerThreadId": "canonical40-synthetic-rename-thread",
            "baseline": {
              "providerUpdatedAt": 10,
              "status": "idle",
              "activeTurnId": null
            },
            "requestedName": "Historical"
          },
          "recordedAt": 40001
        },
        "resolutionEvidence": {
          "source": "thread/read",
          "providerUpdatedAt": 10000
        },
        "mutation": {
          "id": "attempt_88ffde57fbad4c8d99615fb086f6c9ae",
          "idempotencyKey": "40000000-0000-4000-8000-000000000141",
          "kind": "session.rename",
          "authorityId": "sess_b1db61e561334cf38baac37ceda33b6f",
          "authorityGeneration": 1,
          "requestDigest": "5ccce53b7acca2f71379c593ca740318bfe24f2abacdbf9ebc7fb9fd4160aa36",
          "state": "reconciled",
          "result": {
            "renamed": true
          },
          "originalState": "ambiguous",
          "resolution": {
            "kind": "proven_applied",
            "evidence": {
              "source": "thread/read",
              "providerUpdatedAt": 10000
            },
            "receipt": {
              "renamed": true
            },
            "createdAt": 40001
          },
          "evidence": {
            "attemptId": "attempt_88ffde57fbad4c8d99615fb086f6c9ae",
            "digest": "043152b7832947f89540bbdecbd386ec481c675c9a80db226df501b5494634c8",
            "evidence": {
              "kind": "session.rename",
              "providerThreadId": "canonical40-synthetic-rename-thread",
              "baseline": {
                "providerUpdatedAt": 10,
                "status": "idle",
                "activeTurnId": null
              },
              "requestedName": "Historical"
            },
            "recordedAt": 40001
          }
        }
      },
      "snapshot": {
        "sha256": "dd3724ce37723a85a5048a4902fe00916593f5477493e118cc17ed4a5dec91ad",
        "schemaSha256": "732fe9f405f5ae903fe42afdb0033e2b6cd3a66ad7096e6b3c180ebaa1eb5e4f",
        "version": {
          "user_version": 40
        },
        "ledger": [
          {
            "version": 1,
            "applied_at": 40001
          },
          {
            "version": 2,
            "applied_at": 40001
          },
          {
            "version": 3,
            "applied_at": 40001
          },
          {
            "version": 4,
            "applied_at": 40001
          },
          {
            "version": 5,
            "applied_at": 40001
          },
          {
            "version": 6,
            "applied_at": 40001
          },
          {
            "version": 7,
            "applied_at": 40001
          },
          {
            "version": 8,
            "applied_at": 40001
          },
          {
            "version": 9,
            "applied_at": 40001
          },
          {
            "version": 10,
            "applied_at": 40001
          },
          {
            "version": 11,
            "applied_at": 40001
          },
          {
            "version": 12,
            "applied_at": 40001
          },
          {
            "version": 13,
            "applied_at": 40001
          },
          {
            "version": 14,
            "applied_at": 40001
          },
          {
            "version": 15,
            "applied_at": 40001
          },
          {
            "version": 16,
            "applied_at": 40001
          },
          {
            "version": 17,
            "applied_at": 40001
          },
          {
            "version": 18,
            "applied_at": 40001
          },
          {
            "version": 19,
            "applied_at": 40001
          },
          {
            "version": 20,
            "applied_at": 40001
          },
          {
            "version": 21,
            "applied_at": 40001
          },
          {
            "version": 22,
            "applied_at": 40001
          },
          {
            "version": 23,
            "applied_at": 40001
          },
          {
            "version": 24,
            "applied_at": 40001
          },
          {
            "version": 25,
            "applied_at": 40001
          },
          {
            "version": 26,
            "applied_at": 40001
          },
          {
            "version": 27,
            "applied_at": 40001
          },
          {
            "version": 28,
            "applied_at": 40001
          },
          {
            "version": 29,
            "applied_at": 40001
          },
          {
            "version": 30,
            "applied_at": 40001
          },
          {
            "version": 31,
            "applied_at": 40001
          },
          {
            "version": 32,
            "applied_at": 40001
          },
          {
            "version": 33,
            "applied_at": 40001
          },
          {
            "version": 34,
            "applied_at": 40001
          },
          {
            "version": 35,
            "applied_at": 40001
          },
          {
            "version": 36,
            "applied_at": 40001
          },
          {
            "version": 37,
            "applied_at": 40001
          },
          {
            "version": 38,
            "applied_at": 40001
          },
          {
            "version": 39,
            "applied_at": 40001
          },
          {
            "version": 40,
            "applied_at": 40001
          }
        ],
        "rowCounts": {
          "account_rate_limit_reset_attempts": 0,
          "account_rate_limit_reset_policies": 1,
          "account_rate_limit_reset_rebinds": 0,
          "attachments": 0,
          "attention_email_policy": 1,
          "autorespond_evidence": 0,
          "autorespond_message_sources": 0,
          "daemon_state": 1,
          "desktop_switch_authority": 1,
          "desktop_switch_resolutions": 0,
          "desktop_switches": 0,
          "device_command_ledger": 0,
          "message_attachments": 0,
          "migrations": 40,
          "mutation_attempts": 1,
          "mutation_effect_evidence": 1,
          "mutation_resolutions": 1,
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
          "queue_entries": 0,
          "queue_message_scrub_authority": 0,
          "queue_sequence_authority": 1,
          "security_scrub_authority": 0,
          "session_account_authorities": 1,
          "session_adoption_candidates": 0,
          "session_adoption_policies": 0,
          "session_adoption_profile_generation_permits": 0,
          "session_approval_modes": 0,
          "session_autorespond_counters": 0,
          "session_claude_process_authorities": 0,
          "session_claude_process_launch_intents": 0,
          "session_conversation_automation": 0,
          "session_event_streams": 1,
          "session_events": 0,
          "session_mutation_authority_rebinds": 0,
          "session_mutation_authority_rebinds_v39": 0,
          "session_personal_runtime_bindings": 0,
          "session_provider_account_authorities": 0,
          "session_provider_switch_seed_intents": 0,
          "session_provider_switch_seed_results": 0,
          "session_provider_switch_source_releases": 0,
          "session_provider_switch_target_releases": 0,
          "session_provider_switch_targets": 0,
          "session_runtime_profiles": 0,
          "session_show_thinking": 0,
          "session_start_attempts": 0,
          "session_states": 0,
          "session_task_occurrences": 0,
          "session_task_receipts": 0,
          "session_tasks": 0,
          "session_turn_runtime_profiles": 0,
          "sessions": 1,
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
      "databaseSha256": "ebb51598b59c07a4ecb3c7b9da1be7a73f6630e7dc98c8efa2d4d40d497b030a",
      "databaseBytes": 1400832,
      "provenance": {
        "kind": "archived_public_writer",
        "providerEffects": 0,
        "rawLogicalWrites": false,
        "versionRestamped": false,
        "archivedWritableAndReadonlyReopensUnchanged": true,
        "archivedReadonlyBytesUnchanged": true
      }
    }
  },
  "provenance": {
    "syntheticStorageOnly": true,
    "providerEffects": 0,
    "sourceAndDependenciesReverifiedAfterUse": true,
    "nativeAcceptance": false
  }
} as const;

export const canonical20To40GeneratorSource = "// Exact archived17 writer and observed uncommitted17-to24 stage20, plus\n// exact archived40 unmarked resolution. Synthetic control-plane data only.\nimport { createHash } from \"node:crypto\";\nimport { lstatSync, readdirSync, readFileSync } from \"node:fs\";\nimport { mkdir, writeFile } from \"node:fs/promises\";\nimport { join, relative } from \"node:path\";\nimport { Database } from \"bun:sqlite\";\nimport { z } from \"zod\";\n\nconst sha256 = (value: string | Uint8Array) => createHash(\"sha256\").update(value).digest(\"hex\");\nconst readBounded = (path: string, maximum = 8 * 1024 * 1024) => {\n  const stat = lstatSync(path);\n  if (!stat.isFile() || stat.size > maximum) throw new Error(\"CAPTURE_FILE_LIMIT\");\n  return readFileSync(path);\n};\nconst hostPrefixes = [[\"\", \"Users\", \"\"], [\"\", \"home\", \"\"], [\"\", \"private\", \"\"],\n  [\"\", \"tmp\", \"\"], [\"\", \"var\", \"folders\", \"\"]].map((parts) => parts.join(\"/\"));\nhostPrefixes.push([\"\", \"Users\", \"\"].join(\"\\\\\"));\nconst assertPrivatePathFree = (input: Uint8Array) => {\n  const bytes = Buffer.from(input);\n  for (const prefix of hostPrefixes) for (const needle of [Buffer.from(prefix),\n    Buffer.from(prefix, \"utf16le\"), Buffer.from(prefix, \"utf16le\").swap16()]) {\n    if (bytes.includes(needle)) throw new Error(\"CAPTURE_HOST_PATH\");\n  }\n};\nconst recipe = readBounded(import.meta.filename, 64 * 1024);\nassertPrivatePathFree(recipe);\nif (Bun.version !== \"1.3.14\" || (lstatSync(import.meta.dir).mode & 0o777) !== 0o700) {\n  throw new Error(\"CAPTURE_RUNTIME_OR_DIRECTORY_MISMATCH\");\n}\nconst sources = {\n  \"canonical17\": {\n    \"sourceFileCount\": 119,\n    \"manifest\": \"407df7c80c5b3503670a4d3b75a90619f0f32d70133b6cd01338dce124d32937\",\n    \"pins\": {\n      \"src/storage/state-store.ts\": \"31d462821d1c7830a38e917c989c0b44ba03b8f3c1812788d8eb554d24c09cd0\",\n      \"package.json\": \"1ace2e19fb0f9e63e37668baea728c1063b4e7fc89865461a3e59088e9f17ad4\",\n      \"bun.lock\": \"650f295c061c3573d0fb4b5542f12977d8e4b5ab8b65d1e019b290f4a205011d\",\n      \".bun-version\": \"56b0485099b6c5427d3b68c042fd05b632d5e52e924c5064473389812227164c\"\n    },\n    \"dependencies\": {\n      \"@openai/codex\": \"0.149.0\",\n      \"convex\": \"1.45.0\",\n      \"zod\": \"4.4.3\"\n    },\n    \"dependencyManifestHashes\": {\n      \"@openai/codex\": \"0580493a92b83d962b8fdc8585a66c963431c6ddb54fabe4b3797970095f000d\",\n      \"convex\": \"aa9f5baee26b69a88d6b61180e540cce1f52baa31094e7124c8c0393e4b3211e\",\n      \"zod\": \"c630bd10b52dcf71c112a2bf78dbf2734b9db58d62de663b8d86c2ec2c8cda2e\"\n    },\n    \"commit\": \"c018e91fcdeab9fe66078c96ca25c34d198a6189\",\n    \"tree\": \"4b7a6d24d8be24c889b735ee9146555dc139e293\"\n  },\n  \"canonical24\": {\n    \"sourceFileCount\": 137,\n    \"manifest\": \"ec1dc3f9f4ee123e631eb1ca1da79ca5506c05ae12d9bed0133aeeb0f488d227\",\n    \"pins\": {\n      \"src/storage/state-store.ts\": \"e312e1bf91023ad0655a62eab96f69d609468399e118ff0ab4bfe9d02d782748\",\n      \"package.json\": \"d1ee465269aacef1ed193c32571d1f1940074e8f3f120e6c47fd0d45b370feb9\",\n      \"bun.lock\": \"650f295c061c3573d0fb4b5542f12977d8e4b5ab8b65d1e019b290f4a205011d\",\n      \".bun-version\": \"56b0485099b6c5427d3b68c042fd05b632d5e52e924c5064473389812227164c\"\n    },\n    \"dependencies\": {\n      \"@openai/codex\": \"0.149.0\",\n      \"convex\": \"1.45.0\",\n      \"zod\": \"4.4.3\"\n    },\n    \"dependencyManifestHashes\": {\n      \"@openai/codex\": \"0580493a92b83d962b8fdc8585a66c963431c6ddb54fabe4b3797970095f000d\",\n      \"convex\": \"aa9f5baee26b69a88d6b61180e540cce1f52baa31094e7124c8c0393e4b3211e\",\n      \"zod\": \"c630bd10b52dcf71c112a2bf78dbf2734b9db58d62de663b8d86c2ec2c8cda2e\"\n    },\n    \"commit\": \"cdeda22239a70c26493928bab9aa6f346f576282\",\n    \"tree\": \"c457c53afb998fe60ce01d0fce4a5500196159d6\"\n  },\n  \"canonical40\": {\n    \"sourceFileCount\": 289,\n    \"manifest\": \"75e9b44a58e7063be0275839a9e632df71ac3d1e90d9dea789ff4f7b337db3f2\",\n    \"pins\": {\n      \"src/storage/state-store.ts\": \"0e9e9f772b9caeb5c1ec80f58927c643643b28ac6cc7ca1ae868028d61cef32f\",\n      \"package.json\": \"ef8779bd5fa796f395ad3d064710e247a89eb0cbd4023dc069b4daaad8e12d3c\",\n      \"bun.lock\": \"5a2b90063d8eb1aa55e18be71abbca59c1f051a9358a2a36ff89698d066b182a\",\n      \".bun-version\": \"56b0485099b6c5427d3b68c042fd05b632d5e52e924c5064473389812227164c\"\n    },\n    \"dependencies\": {\n      \"@agentclientprotocol/sdk\": \"1.4.0\",\n      \"@hraness/oh\": \"0.2.7\",\n      \"@openai/codex\": \"0.153.2\",\n      \"convex\": \"1.45.0\",\n      \"zod\": \"4.4.3\"\n    },\n    \"dependencyManifestHashes\": {\n      \"@agentclientprotocol/sdk\": \"89bbcd7a71a3cd6e94b7096ef1f239dda62b5fb8aef840d3475af3fbfff3a955\",\n      \"@hraness/oh\": \"ad5ea2f55afd7f2147558e8ee0ae73d6d38c96d9ae8ec97dc3aebf6d5dd5b05b\",\n      \"@openai/codex\": \"4ecf4eae28684c5fcba8b9a63b946ce22b8cc2e451750f23c04e5088cf4c7a05\",\n      \"convex\": \"aa9f5baee26b69a88d6b61180e540cce1f52baa31094e7124c8c0393e4b3211e\",\n      \"zod\": \"c630bd10b52dcf71c112a2bf78dbf2734b9db58d62de663b8d86c2ec2c8cda2e\"\n    },\n    \"commit\": \"6f056dcafd6435cd11ae504c75e9b1f869955ca7\",\n    \"tree\": \"b5de09dee16ff661f6dd45fb3a2dac9e96411d10\"\n  }\n} as const;\nconst verifySources = () => {\n  for (const [name, source] of Object.entries(sources)) {\n    const root = join(import.meta.dir, name);\n    for (const [path, expected] of Object.entries(source.pins)) {\n      if (sha256(readBounded(join(root, path))) !== expected) throw new Error(\"CAPTURE_SOURCE_MISMATCH\");\n    }\n    const files: { path: string; sha256: string }[] = [];\n    const visit = (directory: string) => {\n      for (const entry of readdirSync(directory, { withFileTypes: true })) {\n        if (!/^[A-Za-z0-9_.-]+$/u.test(entry.name)) throw new Error(\"CAPTURE_SOURCE_ENTRY_INVALID\");\n        const path = join(directory, entry.name);\n        if (entry.isDirectory()) visit(path);\n        else if (entry.isFile()) files.push({ path: relative(root, path), sha256: sha256(readBounded(path)) });\n        else throw new Error(\"CAPTURE_SOURCE_ENTRY_INVALID\");\n      }\n    };\n    visit(join(root, \"src\"));\n    files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);\n    if (files.length !== source.sourceFileCount || sha256(JSON.stringify(files)) !== source.manifest) throw new Error(\"CAPTURE_SOURCE_MANIFEST_MISMATCH\");\n    const declared = z.object({ dependencies: z.record(z.string(), z.string()) }).passthrough()\n      .parse(JSON.parse(readBounded(join(root, \"package.json\")).toString(\"utf8\")));\n    if (JSON.stringify(declared.dependencies) !== JSON.stringify(source.dependencies)) throw new Error(\"CAPTURE_DEPENDENCIES_MISMATCH\");\n    for (const [dependency, version] of Object.entries(source.dependencies)) {\n      const manifest = readBounded(join(root, \"node_modules\", dependency, \"package.json\"), 256 * 1024);\n      if (sha256(manifest) !== source.dependencyManifestHashes[dependency]) throw new Error(\"CAPTURE_DEPENDENCY_MANIFEST_MISMATCH\");\n      z.object({ name: z.literal(dependency), version: z.literal(version) }).passthrough().parse(JSON.parse(manifest.toString(\"utf8\")));\n    }\n  }\n};\nverifySources();\nconst { StateStore: Store17 } = await import(\"./canonical17/src/storage/state-store\");\nconst { StateStore: Store24 } = await import(\"./canonical24/src/storage/state-store\");\nconst { StateStore: Store40 } = await import(\"./canonical40/src/storage/state-store\");\nconst { presetRequirements } = await import(\"./canonical17/src/domain/presets\");\nconst { effectiveRuntimeProfileSchema } = await import(\"./canonical17/src/domain/runtime-profile\");\nconst paths17 = await import(\"./canonical17/src/storage/paths\");\nconst paths40 = await import(\"./canonical40/src/storage/paths\");\nconst output = join(import.meta.dir, \"capture\");\nawait mkdir(output, { mode: 0o700 });\nconst fixedTime = 17_001;\nconst metadata: Record<string, unknown> = {};\nconst quote = (value: string) => {\n  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(value)) throw new Error(\"CAPTURE_SQL_IDENTIFIER_INVALID\");\n  return `\"${value}\"`;\n};\nconst snapshot = (db: Database) => {\n  const schema = z.object({ type: z.string(), name: z.string(), tbl_name: z.string(), sql: z.string().nullable() }).strict().array().max(2048)\n    .parse(db.query(\"SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name LIMIT 2049\").all());\n  const tables = schema.filter((row) => row.type === \"table\");\n  if (tables.length > 256) throw new Error(\"CAPTURE_TABLE_LIMIT\");\n  const rows = Object.fromEntries(tables.map(({ name }) => {\n    const entries = db.query(`SELECT * FROM ${quote(name)} LIMIT 4097`).all();\n    if (entries.length > 4096) throw new Error(\"CAPTURE_ROW_LIMIT\");\n    entries.sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0);\n    return [name, entries];\n  }));\n  const value = { version: db.query(\"PRAGMA user_version\").get(),\n    ledger: db.query(\"SELECT * FROM migrations ORDER BY version\").all(),\n    foreignKeys: db.query(\"PRAGMA foreign_key_check\").all(), schema, rows };\n  if (value.foreignKeys.length !== 0 || Buffer.byteLength(JSON.stringify(value)) > 8 * 1024 * 1024) throw new Error(\"CAPTURE_SNAPSHOT_INVALID\");\n  return value;\n};\nconst inspect = (path: string) => {\n  const db = new Database(path, { create: false, strict: true });\n  try {\n    db.exec(\"PRAGMA query_only=ON\");\n    const result = db.transaction(() => snapshot(db)).deferred();\n    z.object({ n: z.literal(0) }).strict().parse(db.query(\"SELECT total_changes() AS n\").get());\n    return result;\n  } finally { db.close(false); }\n};\nconst checkpoint = (path: string) => {\n  const db = new Database(path, { create: false, strict: true });\n  try { z.object({ busy: z.literal(0), log: z.literal(0), checkpointed: z.literal(0) }).strict()\n    .parse(db.query(\"PRAGMA wal_checkpoint(TRUNCATE)\").get()); } finally { db.close(false); }\n};\n\nconst preserve = async (name: string, databasePath: string, version: number, source: string,\n  retained: unknown, reopen: (readonly: boolean) => void) => {\n  checkpoint(databasePath);\n  const original = inspect(databasePath);\n  if (JSON.stringify(original.version) !== JSON.stringify({ user_version: version })) throw new Error(\"CAPTURE_VERSION_INVALID\");\n  const ledger = Array.from({ length: version }, (_, index) => ({\n    version: index + 1, applied_at: version === 40 ? 40001 : index < 17 ? fixedTime : 24001,\n  }));\n  if (JSON.stringify(original.ledger) !== JSON.stringify(ledger)) throw new Error(\"CAPTURE_LEDGER_INVALID\");\n  for (const readonly of [false, true]) {\n    const before = readBounded(databasePath);\n    reopen(readonly);\n    if (JSON.stringify(inspect(databasePath)) !== JSON.stringify(original)) throw new Error(\"CAPTURE_REOPEN_CHANGED\");\n    checkpoint(databasePath);\n    if (readonly && sha256(readBounded(databasePath)) !== sha256(before)) throw new Error(\"CAPTURE_READONLY_BYTES_CHANGED\");\n  }\n  const bytes = readBounded(databasePath);\n  assertPrivatePathFree(bytes);\n  metadata[name] = { schemaVersion: version, source, retained, snapshot: original,\n    databaseSha256: sha256(bytes), databaseBytes: bytes.length,\n    provenance: { kind: \"archived_public_writer\", providerEffects: 0, rawLogicalWrites: false,\n      versionRestamped: false, archivedWritableAndReadonlyReopensUnchanged: true,\n      archivedReadonlyBytesUnchanged: true } };\n  await writeFile(join(output, name + \".sqlite\"), bytes, { mode: 0o600, flag: \"wx\" });\n  return { bytes, snapshot: original };\n};\n\nconst terminalMessage = \"ARCHIVED17_TERMINAL_QUEUE_BODY_SENTINEL\";\nconst ambiguousMessage = \"ARCHIVED17_RESOLVED_QUEUE_BODY_SENTINEL\";\nconst paths = paths17.resolveStatePaths({ homeDirectory: join(output, \"home17\"), platform: \"darwin\" });\nawait paths17.initializeStatePaths(paths);\nconst store = new Store17(paths, { now: () => fixedTime });\nconst created = store.createProfile(\"Canonical17 settled queue controls\");\nconst generation = store.nextProfileGeneration(created.id);\nif (store.allocateNextUsageRevision(created.id) !== 1) throw new Error(\"CAPTURE_USAGE_RESERVATION_INVALID\");\nif (!store.setProfileState(generation.id, generation.processGeneration, \"signed_in\",\n  { email: \"canonical17-queues@example.com\", plan: \"Plus\" })) throw new Error(\"CAPTURE_SIGNIN_REFUSED\");\nconst profile = store.requireProfile(created.id);\nconst session = store.upsertProviderSession({ profileId: profile.id,\n  providerThreadId: \"canonical17-synthetic-queue-thread\", title: \"Canonical17 queue controls\",\n  state: \"idle\", providerUpdatedAt: fixedTime });\nconst terminal = store.enqueue(session.id, terminalMessage);\nif (!store.transitionQueue(terminal.id, \"pending\", \"cancelled\")) throw new Error(\"CAPTURE_TERMINAL_REFUSED\");\nconst ambiguous = store.enqueue(session.id, ambiguousMessage);\nconst runtime = effectiveRuntimeProfileSchema.parse({\n  profileId: profile.id, processGeneration: profile.processGeneration, observedAt: fixedTime,\n  preset: \"high\", model: presetRequirements.high.model, reasoningEffort: presetRequirements.high.effort,\n  serviceTier: null, fast: false, approvalPolicy: \"on-request\", reviewMode: \"auto_review\",\n  permissionProfile: \":workspace\", computerUse: true, pluginCapability: true, enabledApps: [],\n});\nconst effect = store.beginQueueEffect({ queueId: ambiguous.id, sessionId: session.id,\n  profileGeneration: profile.processGeneration, evidence: {\n    kind: \"queue.dispatch\", queueId: ambiguous.id, sessionId: session.id,\n    providerThreadId: session.providerThreadId!, profileGeneration: profile.processGeneration,\n    baseline: { providerUpdatedAt: fixedTime, status: \"idle\", activeTurnId: null },\n    clientMessageId: ambiguous.id, messageDigest: sha256(ambiguousMessage), runtimeProfile: runtime,\n  } });\nstore.markQueueEffectAmbiguous(ambiguous.id, effect.digest);\nstore.resolveQueueEffect({ queueId: ambiguous.id, expectedEvidenceDigest: effect.digest,\n  resolution: \"abandoned\", resolutionEvidence: { source: \"synthetic_archived_observation\" },\n  provider: { providerThreadId: session.providerThreadId!, title: session.title, status: \"idle\", providerUpdatedAt: fixedTime } });\nconst retained = { profile, session: store.requireSession(session.id), runtime, terminal: store.requireQueue(terminal.id),\n  ambiguous: store.requireQueue(ambiguous.id), effect: store.readQueueEffect(ambiguous.id), terminalMessage, ambiguousMessage };\nif (retained.terminal.message !== terminalMessage || retained.ambiguous.message !== ambiguousMessage\n  || retained.terminal.state !== \"cancelled\" || retained.ambiguous.state !== \"ambiguous\") throw new Error(\"CAPTURE_OLD_BODY_MISSING\");\nstore.close();\nconst original17 = await preserve(\"canonical17-settled-queues\", paths.database, 17, \"canonical17\", retained,\n  (readonly) => { const reopened = new Store17(paths, { readonly, now: () => fixedTime + 1 }); reopened.close(); });\nfor (const sentinel of [terminalMessage, ambiguousMessage]) if (!original17.bytes.includes(Buffer.from(sentinel))) throw new Error(\"CAPTURE_PHYSICAL_PRECONTROL_MISSING\");\nconst nextPaths = paths17.resolveStatePaths({ homeDirectory: join(output, \"home24\"), platform: \"darwin\" });\nawait paths17.initializeStatePaths(nextPaths);\nawait writeFile(nextPaths.database, original17.bytes, { mode: 0o600, flag: \"wx\" });\ntype ExecMethod = (this: Database, ...args: Parameters<Database[\"exec\"]>) => ReturnType<Database[\"exec\"]>;\nconst descriptor: (Omit<PropertyDescriptor, \"value\"> & { value?: ExecMethod }) | undefined =\n  Object.getOwnPropertyDescriptor(Database.prototype, \"exec\");\nif (descriptor?.value === undefined || descriptor.configurable !== true) throw new Error(\"CAPTURE_EXEC_DESCRIPTOR_INVALID\");\nconst marker = \"PRAGMA user_version = 20\";\nconst oldSource = readBounded(join(import.meta.dir, \"canonical24/src/storage/state-store.ts\")).toString(\"utf8\");\nif (oldSource.split('database.exec(\"' + marker + '\");').length !== 2\n  || !oldSource.includes('database.exec(\"PRAGMA secure_delete = ON\")')) throw new Error(\"CAPTURE_MARKER_INVALID\");\nlet observed: { bytes: Buffer; sha256: string; snapshot: ReturnType<typeof snapshot> } | undefined;\nObject.defineProperty(Database.prototype, \"exec\", { ...descriptor,\n  value: function(this: Database, ...args: Parameters<Database[\"exec\"]>) {\n    if (descriptor.value === undefined) throw new Error(\"CAPTURE_EXEC_DESCRIPTOR_LOST\");\n    const result = descriptor.value.call(this, ...args);\n    if (args[0] === marker) {\n      if (this.filename !== nextPaths.database || !this.inTransaction || observed !== undefined) throw new Error(\"CAPTURE_OBSERVER_TARGET_INVALID\");\n      const changes = this.query(\"SELECT total_changes() AS count\").get();\n      const snap = snapshot(this);\n      const expectedLedger = [...original17.snapshot.ledger, ...[18,19,20].map((version) => ({ version, applied_at: 24001 }))];\n      if (JSON.stringify(snap.ledger) !== JSON.stringify(expectedLedger)) throw new Error(\"CAPTURE_STAGE_LEDGER_INVALID\");\n      if (snap.schema.some((row) => row.name === \"queue_message_scrub_authority\"\n        || row.name === \"queue_message_terminal_insert_scrub\")) throw new Error(\"CAPTURE_FUTURE_SCRUB_PRESENT\");\n      for (const [table, rows] of Object.entries(original17.snapshot.rows)) {\n        if (table !== \"migrations\" && JSON.stringify(snap.rows[table]) !== JSON.stringify(rows)) throw new Error(\"CAPTURE_STAGE_ROWS_CHANGED:\" + table);\n      }\n      const bytes = Buffer.from(this.serialize());\n      if (bytes.length > 8 * 1024 * 1024) throw new Error(\"CAPTURE_STAGE_BYTES_LIMIT\");\n      if (JSON.stringify(this.query(\"SELECT total_changes() AS count\").get()) !== JSON.stringify(changes)\n        || !this.inTransaction) throw new Error(\"CAPTURE_OBSERVER_CHANGED_TRANSACTION\");\n      observed = { bytes, sha256: sha256(bytes), snapshot: snap };\n    }\n    return result;\n  } });\nlet upgraded: Store24;\ntry { upgraded = new Store24(nextPaths, { now: () => 24001 }); }\nfinally { Object.defineProperty(Database.prototype, \"exec\", descriptor); }\nupgraded.close();\nif (Object.getOwnPropertyDescriptor(Database.prototype, \"exec\")?.value !== descriptor.value\n  || observed === undefined || sha256(observed.bytes) !== observed.sha256) throw new Error(\"CAPTURE_OBSERVER_RESTORE_OR_BYTES_INVALID\");\nconst stagePath = join(output, \"observed20-settled-queues.sqlite\");\nassertPrivatePathFree(observed.bytes);\nawait writeFile(stagePath, observed.bytes, { mode: 0o600, flag: \"wx\" });\nif (JSON.stringify(inspect(stagePath)) !== JSON.stringify(observed.snapshot)\n  || sha256(readBounded(stagePath)) !== observed.sha256) throw new Error(\"CAPTURE_STAGE_STANDALONE_CHANGED\");\nfor (const sentinel of [terminalMessage, ambiguousMessage]) if (!observed.bytes.includes(Buffer.from(sentinel))) throw new Error(\"CAPTURE_STAGE_PHYSICAL_PRECONTROL_MISSING\");\nmetadata[\"observed20-settled-queues\"] = { schemaVersion: 20, source: \"canonical24\", retained, snapshot: observed.snapshot,\n  databaseSha256: observed.sha256, databaseBytes: observed.bytes.length, input17Sha256: sha256(original17.bytes),\n  provenance: { kind: \"uncommitted_archived_migration_stage\", releasedWriterImage: false, marker,\n    rawByteCopyWithoutNormalization: true, observerRowOrSchemaWrites: false,\n    observedBeforeOuterCommit: true, standaloneSnapshotAndBytesUnchanged: true } };\nconst final24 = await preserve(\"canonical24-scrubbed-queues\", nextPaths.database, 24, \"canonical24\", retained,\n  (readonly) => { const reopened = new Store24(nextPaths, { readonly, now: () => 24002 }); reopened.close(); });\nfor (const sentinel of [terminalMessage, ambiguousMessage]) if (final24.bytes.includes(Buffer.from(sentinel))) throw new Error(\"CAPTURE_ARCHIVED_PHYSICAL_SCRUB_INCOMPLETE\");\n\nconst paths40Value = paths40.resolveStatePaths({ homeDirectory: join(output, \"home40\"), platform: \"darwin\" });\nawait paths40.initializeStatePaths(paths40Value);\nconst store40 = new Store40(paths40Value, { now: () => 40001, resolveMachineTimeZone: () => \"UTC\" });\nlet retained40: unknown;\ntry {\n  const initial = store40.createProfile(\"Canonical40 legacy timestamp resolution\");\n  if (store40.allocateNextUsageRevision(initial.id) !== 1) throw new Error(\"CAPTURE_UNUSED_USAGE_RESERVATION_INVALID\");\n  const next = store40.nextProfileGeneration(initial.id);\n  if (!store40.setProfileState(next.id, next.processGeneration, \"signed_in\",\n    { email: \"canonical40-legacy-resolution@example.com\", plan: \"Plus\" })) throw new Error(\"CAPTURE_SIGNIN_REFUSED\");\n  const profile40 = store40.requireProfile(next.id);\n  const local = store40.createSession({ profileId: next.id, title: \"Canonical40 historical rename\", preset: \"high\", fastEnabled: false });\n  const bound = store40.bindSession({ sessionId: local.id, expectedRevision: local.revision,\n    providerThreadId: \"canonical40-synthetic-rename-thread\", state: \"idle\" });\n  const key = \"40000000-0000-4000-8000-000000000141\";\n  const attempt = store40.prepareMutation({ kind: \"session.rename\", authorityId: bound.id,\n    authorityGeneration: next.processGeneration, request: {}, idempotencyKey: key });\n  const effect40 = store40.beginSessionMutationEffect({ attemptId: attempt.id, sessionId: bound.id,\n    profileGeneration: next.processGeneration, evidence: { kind: \"session.rename\",\n      providerThreadId: bound.providerThreadId!, baseline: { providerUpdatedAt: 10, status: \"idle\", activeTurnId: null },\n      requestedName: \"Historical\" } });\n  const recovery = store40.recoverEffectStartedMutations();\n  if (!recovery.recovered.includes(attempt.id) || recovery.unresolved.length !== 0) throw new Error(\"CAPTURE_RECOVERY_REFUSED\");\n  const resolutionEvidence = { source: \"thread/read\", providerUpdatedAt: 10000 };\n  store40.resolveSessionMutation({ attemptId: attempt.id, expectedOriginalState: \"ambiguous\",\n    expectedEvidenceDigest: effect40.digest, resolution: \"proven_applied\", resolutionEvidence,\n    receipt: { renamed: true }, provider: { providerThreadId: bound.providerThreadId!, title: \"Historical\", status: \"idle\", providerUpdatedAt: 10000 } });\n  retained40 = { profile: profile40, session: store40.requireSession(bound.id), key, effect: effect40,\n    resolutionEvidence, mutation: store40.readMutation(key) };\n} finally { store40.close(); }\nconst original40 = await preserve(\"canonical40-unmarked-resolution\", paths40Value.database, 40, \"canonical40\", retained40,\n  (readonly) => { const reopened = new Store40(paths40Value, { readonly, now: () => 40002,\n    resolveMachineTimeZone: () => { throw new Error(\"CAPTURE_REOPEN_MUST_NOT_RESOLVE_ZONE\"); } }); reopened.close(); });\nif (original40.snapshot.schema.some((row) => row.name === \"mutation_resolutions_timestamp_proof_insert\")) throw new Error(\"CAPTURE_FUTURE_TIMESTAMP_GUARD_PRESENT\");\nverifySources();\nif (sha256(readBounded(import.meta.filename, 64 * 1024)) !== sha256(recipe)) throw new Error(\"CAPTURE_RECIPE_CHANGED\");\nconst result = { generatorSha256: sha256(recipe), bunVersion: Bun.version, sources, captures: metadata,\n  provenance: { syntheticStorageOnly: true, providerEffects: 0, sourceAndDependenciesReverifiedAfterUse: true, nativeAcceptance: false } };\nconst resultBytes = Buffer.from(JSON.stringify(result, null, 2) + \"\\n\");\nif (resultBytes.length > 32 * 1024 * 1024) throw new Error(\"CAPTURE_METADATA_LIMIT\");\nassertPrivatePathFree(resultBytes);\nawait writeFile(join(output, \"fixture.json\"), resultBytes, { mode: 0o600, flag: \"wx\" });\nconsole.log(JSON.stringify({ generatorSha256: result.generatorSha256,\n  captures: Object.entries(metadata).map(([name, value]) => ({ name, ...z.object({ databaseSha256: z.string(), databaseBytes: z.number() }).parse(value) })) }));\n";

export type Canonical20To40Scenario = keyof typeof canonical20To40Fixture.captures;

const compressed = {
  "canonical17-settled-queues": {
    "gzipSha256": "daed87a99c60c224a3477fd4b3f75a6ef5bfc7866e4f3a7a8ee6a0862b928fe9",
    "base64": "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"
  },
  "observed20-settled-queues": {
    "gzipSha256": "6baf5dcce24d71205d9618d2d8fd48010284e448c3d72f5b47fb1dd4c8b680c1",
    "base64": "H4sIAAAAAAAAE+2dfXAb6X3fF6REgJQonF9hh7l4j7YDwgfqCL4IxN1BZ5BcSbAo8ASA5snyZb3YfQiuBexCuwtKimPfgNKdfc1Lm+aPdjKedqbTppkkbWecZJppJ9M6M5nJP0mnjePrpM0/nbSZqftPm5m8uE3b2WdfsLvYBUGKOtnU93MzR2Gf3/N73n7Ps8/us8/zq93clA3C7qpaWzDYJeY5ZmyM+SzLMgwzzjCMwPR5xDDMGc/vGMMwH2aGM85c/Nm/OsswzPnk75i/30z+7+RfJP9n8n8k/yz5X5J/kvyD5H9M/mHy96xAAAAAAAAAAAAADOF2L8EwzE7PfCLf+DzDMJ83GIb5HGEY5rNVhmEK1xmGyXEMw3xmlWGY2SzDMB97nmGYjz43bcZ/DrULAAAAAAAAAACcZszn/w8nDSb518n/lfxe8k+Tf5L8bvLfJX8v+e3kv0r+evLXkv8k+Q+Sfy/5d5LvJg+SX0ma7xUAAAAAAAAAAAAwAmc/PM6Mvfntsx+y/nzQ+vOBcWZsTT77nPUnaf25YP2Ztv6ct/6cs/5MWX8mrT8J60/c+jNh/Tlr/Tlj/Rm3/oxZf2L0j/n8H0v+FZP8KzQdAAAAAAAAAABw2piITTDmpgHr+f8tJvnW084RAAAAAAAAAABwankrNrlz8xOT5Y+MjQmiaPArkkAai6srS6uri8tLS6IgLDSExcby6m5+aWmJLK4LiqrIotDK5VmdGEaLSOzdLukSVlQVQ1Nbui43FSLxsiL2ReepiP5Zcl9od1rkoqi2X2919TV5TZ6iz//vMcn3nnZVAAAAAAAAAAAA4IjMje9MjvRCwXr+/2Mm+ceoYwAAAAAAAAAA4IePT4/fnBQP/VwA5/8DAAAAAAAAAACnH3P9H/7/AAAAAAAAAACA0w2e/wEAAAAAAAAAgNMPnv8BAAAAAAAAAIDTD57/AQAAAAAAAACA0495/l8seYtJ3nraOQEAAAAAAAAAAH4I6X0qltzZYW6Wpj+S+AgTGxsb04mu87nF1YYoiuLuMiksLzZ2hVVpYVfM5YTc0i5ZKuRHctrnOdZ/Xn+gGHvEkMV5erD/vLGnEUFa9xz87z/wf09u7slSi4yvyeZ/lv+/95jke0+7wgAAAAAAAAAAAHBE5sZ3Jkd632A9//8Gk/wN1DEAAAAAAAAAAPCDxPUzOzcnT+hDAev5/ztM8jtPu1QAAAAAAAAAAAA4Ci+eGduZXJNHWv839/+PXfgek9y/8D3UMgAAAAAAAACAU0AvMZa4tXP7E2NjMboCzucLhaXCamG1IRZWllcbhYYgLS7vSouFhby4LF1aHukBulRdv1b+PLeRy/NVrra1+Xlug7+5zW1z/NrWxi2+xlXq5Qq3KbQbcrOrdnVz0/1YLx6zszJpZUW4JDQWliVJFBel5dXl3dWFFVFaJUJDzBUWVol41KzUueqNcqW0GZYVUVBE0moRydn/P5b8VSb5q8nvPu0GAgAAAAAAAAAAAPOZ8VsjvrgYy4zfGvHFguP/L/lrqGEAAAAAAAAAAOC0Mm0//wMAAAAAAAAAAOD04qz/AwAAAAAAAAAA4HSv/z/HfIu58L0LN6d/4tz09PzUo8S7U7Wp2cS5+DfHl+J34i9PvMd8i/mB4dHXnoun0unYu68YQqNFrG0ORDE0mei+Hx9Yr3KlOsfWS2ubHOsLYuemWFaW2Dr3Rp19vVq+UareYq9zt9j1a9z69TlZYq9ubq2xaSvS7YX5gjC/++Zn0mypssG2iNI09uZkKcMW2aXVTHaKZc3zGWRV4R2dla06W9ne3GSr3BWuylXWuZojo9OYWxV2g9vk6hy7XqqtlzY4U0ub6LrQJAEVVp7sVNdLtfqcI1eqsWubW2uZDLvG1Xc4rsLmaA4XLy3mlpetjBmCEa7QCilX2Ll0hyiSrDTT2bQk6x3BEPesX0Kn05KJlM6mdwW5Rf/hnmORzqbdgyTSGZqWqBHBIBIvGGy5UueuctVgmh6Jy0V2gcbqdqRDYnkkLhc9qWSmsixRrDbSTUNQROLqsKIOBtcszVvVwaj+SiwsLORzhcLiynJ+eaFQWMhk2Fq9Wl6vf/2F8/HU88/Hfu4j1ACdZnX+TvvMzrk6qsXRgz6GGlye1lpHU3flFhlqcLYMNTg7zpeJaLhx/KJmkFd0X5aIxlteQpwoZpAhG62hJkoFMuyrRXZp0WpiRR2wwQ3uSml7s86m0yH2TeX7xv1qkc1dWlq1DLqjEZ0YoenbQdSkW+q9dDa9Jzf30tl0t2Vogm2ku4Ju8EQxW06KMriADDu3kM1lRu9OuiFoht2DREPeJ+lsWpZa5h+DaG1ZEVrpbFojorpPtAe8Ru52Zc3tRVYU3uhq7nBiXtbIvmxaUlSe3fDLdr9633tjtm81HpkqV+q3z2Cwpz+GBbv52q6Ub25zc32zz4bYaGbK6aNCMp568flYLy4rErnvdEJeIyJRDOfnc3ZPLVc2uDfYgJA5QrsjtidHG1xtPcvKUualCxOp9edjjJXC3ZZsEF7oGir9zbvaFp1/JV+aHilCzvnXhfa5eCr/fKz3ISrhdFG+JTRIi+8q8t0ucS6et4tiVZNdotAYZrnc3t5S7xFtjgZnMj81FU8tPR/rrdDkVIXwEtkVui2Dt+WdaOfCEguR9yUl605wht25xlU5tn+FLbK5hx+N01H17bfoqOrEc/4mfKOqc3XUUdWUH2VUpTUxbGyzqipwp8hdsmxUU1WD7wjGXkCDVU+mhKfIEb3LJ+EZeN7/e6vTlV6aHGa2ro0tOv+aeikxUoSc86/J3sSEZeicY+j0tmWbrTUeOhfjEYY+GMO2PusO6DN02/6sEfuFIpvWSFvdJ1L60fNnqA1+Y9qxQRrb+Xs2aIP06qg2SB12PXEbHO0GJTcVIvFq10hn0y21KSt8fwpoB8pK6D0q61aWZZcdTRXNKUuTKEQTjCE3qBBJ107doZy0BdkqvO9ypyUo7tWn2BXOHmLZlhXmnH9N9Drj8dSnPx17+ElqUJJA2qrC05bw/vuMz7C8IdS4dFlptojhqdpBM+vLFNkcLfDhLRLWEg1zDPNMO+hcxldt1lW10/FddeuolxqLp154IdZ7QIvclptWEnr/X+O+4vav08LuE803zfEUlc6OrEeSIc3okaClcnN28MFYPFUsxh7m7Xm72NVk4wGvi1q3Ybbjnmr+jro+FpjXh0sdvcGKVnNpRNBVy8gHp3ZmUDHdFjt8V2vxGpHMIU5V0nZMq28OqROviL9SsP4PAAAAAAAAAAA8G+v/08xfjid/5+x3zv/X8//oPD/1zak3E/88cTexzPxl/M8n3mROI+9+YSaemp+P/d2m9WKO6HcMtcPr92RD3CN68PeP+V/QBULpOx/BMEi7019c9b7x8Sy0trsGfdnF2/LuiquudjWROC8RI9Zofcu5hqA1CV1sOfJKsJ3Y4CtCj94h7w/pu9k9QQ9/0WyFWB8WaKQjWK+N73Zlg7ffJjo/RVXZlbU2vdASuoq455HYJ5q8+8BzYejXCNbbaEkWmoqqG7LIi6pkZe84L38XzE8LrOYNqwf7Dd5geH8xczCQrsuyX1a7miK0eKdmBvPjrIzn7GRCYjjrQq42SW4S3V4U98eyQzw5s1cR/ALm+sOl5UyWbXQVqUV4UeL3BN1ayMq6tilLwSrwBHjK3r9qFZrc7xCR1q4oql3F4O+QB7Zqq9mJFKLcH+QpgPe6lYBrB/yuprZ5j23a74TDwj0qw8NP2ILNBnMXVCQiSC1ZIV6TdN7Vhon08xoaTm3WfQU/8UH6hVTvOl2YsL5ysRd4fJ9Bfci3AO6TM1fPfLJz/U+csp7FEboU7ltQK7Lu90QPP/R8fOa1lxJvrxua3GwSzR39DE1QdJn+s9kVNGlgWHQG3Gr5qlk1kRHZNe7KVpVjt1/fMOW3rti52KoMDrVTO9e4Cu1o5oA9t7W5cbGfZaed6Wpahduxg6gRkN1d87uZfst6v3xit6oD2gIRwnQeMppZWr1K3fhTmak17mq5wta4TW69zlZL5Ro3V1rbqtazbFputUhTaLmlZ/s1ls68wnKVjdd+dCJVm49axQre3Phc8MonXvmRidRWJkoB/XBF77bbgmk2/KL/9/OvfPwIkXP+3z/6MPuxeCqTib3zIXrb9of6f834btn+MGuR5kQ+2fN+puO7Pw58kBZcjnXC3aU3K3sP+C9HrQN5P5HyCfs/lVpYXl3JX3qMrwY8Uxdfr7fL6v0exxvslKi/uFRMTaRuvhjV1l3zG0ZeV4SOvqeaHwQELvzIw89+NJ568cXYO9aCXSA48PPjvvYOBNIGP+pEKbzB7ZvbYZ9jBcXcylUbOtH2h7aJV6S/RC48aKmCNJp1+IR91uH5NNQ7aQjX5Z8bBCzD+ylWoLR9Cyh9ZCK1/VKUBQyM0PziwKVU6cNHU5EbuPSRt7/woXjqpZdif0u01qSDAgMXPuxfoQ4Gj/zJh/1MMOyrj2WreWWJtDuqQRTxgTs7CvuC6I6sSMOazAwPfhuyaiXhrlEP9gCfCq/cwJfFC0Fdh39mECrr2rW5NE10wzeFDc+XX9JjlaN949yfyA3czo/4nbNGdPMrN7cnPt2PUgofmEjdSEf1D98cjs/5fn4Q5/8BAAAAAAAAAADPBPj+HwAAAAAAAAAAOP3A/x8AAAAAAAAAAHD6wfo/AAAAAAAAAABw+sHzPwAAAAAAAAAAcPrB9/8AAAAAAAAAAMDpB+v/AAAAAAAAAADAs7H+H0t+n0l+/2nnBAAAAAAAAAAAACfPmdgZJoH1fwAAAAAAAAAA4BlZ/78Q6zHTfzA9fe5XJv908hcSNxJM/NfP/uOzt8/w4+KYFusxv+hI95RsfOZ2IXFQMzS52SSaTnRdVhVeNwTN4AXDIO2OofNyu901hEaL8BJpEYOEi61XuVKdY+vV8tWrXJUNCDHPBu9nlUbpmlrjrmxVOXaD2+TqHLtViYg4tcZdLVfYGrfJrdfZaqlc4+ZKa1vVepZN2zFYGoNtyIokK01W1lk3sXTmFZarbPSUF49Y4G5HEk6qwJYup8Dbr2+UnnyBH3wmPsMXEweCXWAz2DATI7u7RDR4si9LRBHJQLtECQYKPbK+wXaOijqs4E4c1orDOnHCy545ctmtJjq5skc1+ZMu+9W5idTtlRgjKxK5r99tyQbhha6h0t+8m7pGdLXVNf+p87mwq5lH59Px1MpK7OuvUPVhMmHX5pyqKq1tcmyYBDs3xbK2rfOyxNa5N+rs69XyjVL1Fnudu8VWuStclausc7V+fKdvzMlSJjvFsn19/B1ZsZVUtupsZXtzk12/xq1fnwvKlCvsXLqjqftE4YVOpyUTKZ2lF2SJaGYnNAivEVFVRLlFw4SGoEiqQqR0hqbqtvOXdVUJTbNFlKaxN7deqtXn/NKlGru2ubWWybBrXH2H4yrsIluqbLCLlxZzy8t2oUQidwyPdqcgnuvlmpXeVpX1JuaT6af1atGbgKgRwSASLxhsuVLnTFMO5N8jcbnILmSmMmytXi2v16//+ESKL0TZVcQIuBh+PX3908dQlgu//uMH65+KpwqF2KMXqKGGS4Vf/bTPWMNlTsRcHdVOfLfWtyvlm9ucXfkeqaubW2vWaM/fXpgvCPO7b34mTe3FbvS+bIYtskv5x23frU9OpMTioeNGcMDLRYV86uH6bDxVLMbe+bh//AjIRV3/ZPg4EpA6kcaJHEDsqjbD+702R1thdeH9GBDcCJLcJLoxLIGAqGkUl9xRRdWkoVbhFfGbxcGX2PhMIZ14dMe+ld7tki7hDU1QdJnWZrMraJJ1lSiGJpPg7Cg8Bhu4M14xpzQGMW+RPmVTO9e4Cs2v2dRzW5sbFy3BIpvuEDr9sfpFhduxQ+g4L8l6RzDEPTM8mxYFRSQtc1DPZNit6oAmr3SYtv7tYldw7g3thtzsql09nclMZYbdvuVWizSFllUutl8Rzmzl8ifiqRvzsYMk7WsS0e8YaofX78mGuMc3iUI0y267iny3S/zhRH/Brm57JClXNrg32MOUTLFmRQdVzQ2IZ9ida1yVYwcC6G3INqJHL/0Y7elfv0t7eiBtoWvsqZpsPIi6zvp6eqSU2fy6rDRbxDCTtw3Z29ftQdSVKbI5a1TsahpRDF/uI0bHQUnaHbxagqPNoSMMq5EWEXQiDc3ABneltL1ZZxfcLjkYycwLtc6wwFeLIQWlObcUTrEsy4aV0FEaUkB7rmF3mfDol4dHt8uXmWLZ/qiC8/8AAAAAAAAAAIDTD87/AwAAAAAAAAAATj9Y/wcAAAAAAAAAAE4/WP8HAAAAAAAAAABOP3j+BwAAAAAAAAAATj/4/h8AAAAAAAAAADj9YP0fAAAAAAAAAAB4Ntb/zzNXmLGt5MfPf+n8uXMbU69NvjxxefxS7P/G/hlz5XxjFC0H0mp85nYx8eiVgE93rasYcpvwHU3dlVuk70TScj0aIRbl1f0QbY6L73KlxlXrXq/uQf19V6bcG+VavWa6ZLQdhubYK9WtG05MndWnWMfz5kVZKlJvpH3nwKa7Rf2ikx87vP9zuDdSO1esLe+kyfY9bbZlvW06Q7X9k27lh3kGjips3/dzMGRh69KxFOaiQl7qSfPxmZ2VxMHVoL93r5vzSF/vHqEoP+/D9Azx8e6JNpJ/9758mGv3d86uUD+rP/28z9F1sDqirl8MdXYdlLL8rEa5q/Y4O3Vste+RfV+mhhTpY9gOv2w7VNXVriaSaPft3nDqhNfnnzudTRtdrf/Dchps/bKctdvxB8rgc5vsCgUdPC8uWLnsd6voqnDqzqmKjqaKpufuwx3Ohki6DmfVhk60/aF+m70ibjwnxyO5pPYJj+ai/sjOpM14Hj+9Htflpm9cyyqokOXC2Nvw2X4r9r3Hvv1gOT5zfT7x02ft7h7wGRx0NR10cxzo5IfEHnRU3dkTdOqoOqg4xFe1JWv6qtZIR9CI1HcvbQVRy3YDTTuWDcuM6c+W0FXEPc+FUP/THpfWboI+RWGJBlKiP0VV2ZW19ugJ9CNEJuHVOVCcwxIJRAhLZEDnPtHk3QdHSCQQISyRQZ2uR/BB7V7lrp7RfITbJmU73B50Fn4wthSfEUuJA8cfe8B6w29UEmkRI+iYO/q2dwSdzs1vg9vkrJtfdORh5Q+Ue/iN8GBs8RiVYN2tT7YSomYA70Ml9DZy8ZRYivXuhrmN78c9zIO8N3PzI/iSH6Y5zK28V3+Ig/nawkSqWYqaDA5phFx0WPbtSy/FU6VS7N17YR7pPZLRIS8O80rvkaNDfdAnvNcrvWeeELxfzPXjWTOWYO1E3WIHBZ1Jlad1IidWQRk6wNGLdCrhDmzuJUU13MvW3EqShaai6oYs8qIqkdBkgjJXN7fW2PTt0vwX3vyMNcbaE5GAYHAmtuqdDlnWJslNohvDJjeD0hm2yF5yJzFE7hijzZB8wiPNkJyKHDJD6ovQGZI7telJF4/0JGMNwo//JBM1mD+hJxl8/w8AAAAAAAAAAJx+8P0/AAAAAAAAAABw+sHzPwAAAAAAAAAAcPrB9/8AAAAAAAAAAMDpB+v/AAAAAAAAAADA6QfP/wAAAAAAAAAAwOln+uw0M83cZM58MHl2+t3py+fyU/9t8q8nzyc+EP8oc3PiX098yRbcHFHh1y+vx1NXr8Z+9is+12jUQ1iUf7TQwEuhTtJCRY/tKY1qG+6WzBaJckp2ZNdpcJX2/rtKc+QPd1bil/Q7KjlRb2uOWR3ubM2UMH2BlK9WLC0RPtlYlg0x9YG+cqhPt979QnyGLyYO+OG+PAedLz2eN89RnDlF+vMc4gjF8aoZ9LYZ4gyFYWK1JzjWPovc4iZS7auHeRgNHdX7fktDg1dvbRxfdW5ocL53f83fByyflmR3l4jGUMc9UYKBPjCyvkFHQFFRh/UBGoe14hzmzOx+6chFt7rryRU9qvs/6aJ/+bPxmVv5xMFWWNHJviwRxRwshzW5IzWs0JGaDmlsJ97IxXUihBf2taMVNqSRj1nYkZr3RAu7dXmYn+NIi8xFhaw8OlOkDoC/PkOTiZKLur7sm9tGSdFprRV4iDu70Jqbc6I+nju6jqbuE8XjjE5oCIqkKq4HOreFR5q7+aVH83MbcBHnTrf618s1K72tKjuCx7hXi94ERI2Y3iiHzOw8En4nceVXJ1Jv5keyK7fcudDLSwcPXomn8vnY2x8YtChHKPTiYrQtuV3iqIakGJrcd6L8hBvYjXD49Dwg+pjzc8+U9+UjT3mtEfvkprxRd4AnPOU19//Hzj9kzj982jNFAAAAAAAAwDPAOz8Zi9/6mU/2psesp898obBUWC2sNsTCyvJqo9AQpMXlXWmxsJAXl6VLy1+ZNV9OzL48S8UvSrLeEQxxbzZrXSi7QYdqms3O2o9KNJL5bz63uNoQRVHcXSaF5cXGrrAqLeyKuZyQW9olS4X8bHbWfCMiS0Sr72lEkGhUUVBURRaFVi4/rz9QjD1iyOI8zcW8QcWseOZj2FWiEI36Zp99OZedbQg6ackKmX35K67mbfqGTCoZsy/n8gsLueysbghGV599eVaWWmQ2OyuIhrxP6l2NZl3ptlpfzc6KLZkoxg2i60LziPXQtiJt0Ofq2ZdnLxUWBEFcEHcXVoSllV1xt7GysNKQVhYLhaWV3ZywRBaERqGQz19aFpcKCyvSSkNYFRpiQSosLJCVwmx21n76fN0qtV088580Z4IoGvyKJJDG4urK0urq4vLSkigICw1hsbG8uptfWloii1aliUTXA5XmrCF6aqijEZ2YWd+Tm6YxtFWJtGZfnm12jPmVi5fmdbVlZooIuqrISpPb3VU1U7wt3Kd2oO3LIqnLRLOqMzu7K5g1sSu0dJKdFTpm2wit19WWLD6YfXlWVeY184WMblCt+zK5d0OViFmyrqHy1hUz/0Rry9TG3IqYffmeqt3RO4JotqSotjtdg2jbOpl92dC6JDvbaXWbsrIudISG3JKNB851ophP7lKp09FnX7795le/uiKsFpYvLZElSRDy+VWhQUhuQRAXFgqFJZGI0lJBJEvSwmJ+cVWUVqSVS0RsLOeXxMXFlcXG7tLCmmx+/x9LfpdJfvdpDwMAAAAAAAAAAAA4GpnxW5Ojvfqh6//JbzLJb6KOAQAAAAAAAACAp0EjNnHrEyIz4mcx7racr8xau3rNL1qcT1F4QRP3ZHPTtfXlhPUlxVex/g8AAAAAAAAAADwr6//Mc087vwAAAAAAAAAAAHiSwP8fAAAAAAAAAABw+sHzPwAAAAAAAAAAcPqZnlCYidgfMpOfSnwsfj72hxPfntg//yvn2+f+LDbF/P7Tzh04Bu9+rEw9if78FnX06DiQJPtEMXjd0IjQ1kMvvuzzJBoqQj2J9v3YD/UlaotRN6KmJ0vbp+V6qbZe2uBMp52WUp50VHEv1O0ndWpv+/70CpuOP5cu0VDTmajebeiG5pPIFrI5Uyo9nx4qllseUW5EfYs+fdQ1qULuG7xu+goxXbFGOCf1Czm+UnM0ncLCQj5XKCyuLOeXFwqFHNW621JV7VC1ASm/Xl+aVKnjVoU39jS129w7VD+ti+hYTnoLoeVwKzJaQTFQe/OsGcv2+GoIskIkXlS7yhCnrz4p6vfVF7vxwCD6obEtKW9solA/yU2hw1s+Zfy+iUPCPT6Kw8MrtHexbLofTHOdznquCE3i+01zRm3tmM6MzViWR+5hsTwSl4ueVGj07Ur55jY31x8Xsr6u3Xe0e+5dJmEOUeXrw/wmh448/GLo5VfLnzu6qlzo5VcOJq/FZ+SriYN2wA2w0dWO4As4VDrCIfBomqO9AofGH+Ya2Iwwil/gg8mrx6sLy1CeRF1EuY1/4nXxqHElPkOuJr7xyRHqwjS+PVWTjQd8syto0knVRFCvUw/lSo2r1g+vh51rXIV2au6Ncq1eM0cau1Jy7JXq1o1IR9NsZ4pld65xVY7tXOx38WKF2/H8dMfyzkXr9CnqQd4S6v8elHIUOb88Ek7BbZH+T7+M6R2Mb7ruwRzZwGVPHPduIxhU2PM7JHXTi7kvffPCVObIdmWVkHVbkW3Letv0W2cbGcOcuYfpLgDgfcQ6//+XmOQvodoBAAAAAAAAAICnyxuxczvbk5OJRIIZGzNfuvK5xdWGKIri7jIpLC82doVVaWFXzOWE3NIuWSrkF1ZXGwtC49L8amF5ZX75kiTNr0pLu/PL0pJQyC0trzQu5ddk5/z/95jke2hjAAAAAAAAAADgh4y58Z3Jkd4TWM//32KS33raWQYAAAAAAAAAAECfG2d2tidP7BsA+P8DAAAAAAAAAABOPzj/HwAAAAAAAAAAOP3g+R8AAAAAAAAAADj9mN//xyd+l0ncTHw4/nMTv3uhdv5vzv1TK+zsf37auQMAAACG0LuyFZ+5nkkcBB20Uf9+0d7prOAIJ2wRcaP9z1kRhjkGsyVZKhnmaa43XomncplYr2C5M/RnRWgGcv6anfVyZYN7I5hxoUmm2MH8+bw0akRUNYm6PsuyrifQV25MpLYyI7lUDPpS1C+/U9uMpzKZ2M8Ig95n/W5n9WK0v9lwR7OOT8rhvmNp6CF+S4/iadVTSdF+QvsirlNNQaTeOwdy7/WR6zjZM33kmnE6mrovS0TzeK6LSjNM1E3bDRRVRSEi9RTq5CMQ3S/hcVJq+90NF7Q88NK0LCeaplu8UB++ZgC/L7Rkaa4vaTkrtX4P9cBKPfJ55YpOvtZLtbpHI1uqsWubW2uZjOvEzxvNaedFGnJpZYW6D6a58Lgv9rsw9XrGNft8+WplUMjn59RMedADst/NaHT0QSfJruPUg1o1PnMjk3j0SvgIZ9uarDQDzkhHGeIGIk+VrtS5aoi7Ue8QZ/p9tcbA0GJS/5L1gJfeov/nfM6sWhO/o92i/+f81ubGRU9juv4oPd4oTRHPcEHdM3vq1gr3XHhlynRyWrs5aq3Kik4045i1akW2a3XQYecJ1+qLo9Xqi6ZTy0Nq1e/jc7BWaXiwVh9+5vX4zK1M4u03h9ZqlKPUI9Tt6D5R7Soe1Qmqzurs57bKFXd8Zjumts5FWSrqfk+kdp1djPaI6o1AZfo3hpE8mQZH+eHOR/1zDDupaLej2P8PAAAAAAAAAACcfvD9PwAAAAAAAAAAcPrB8z8AAAAAAAAAAHD6Mb//PxP7LSb2W8nfvPAvp3/7/PTkf0pMTlwe/9uxzPiPP+3cgSj+/lgtnsrnY//ik3SbpbtNRFYMogl0l54eerHk23QZKkL3Xna6jZYsupsGPZvk7J15zvZAR86zIzC4b3NwS5x3w6O9NeZImyQDW2WG7JEMSrpbJEN2RgZi2yWM2veomfsDdXMbD2886JBQFUGZcoWdSyvddoNo6WxaNzRZaaatzZAeUUvALdSAKie8v1dzMNDZ8Dgf3NM6bKNrP7PkvuHdLRoMGtwmGpDIBHbWruQWaRptYuypQ6vbkoiK7yQjyU2iG8P0+CXNdru0TFUYexoRpMB22P7FwaK5YVGZMrpacHutcylEmxUSpUs2SDugy7k0qMsOidIldMz+LbQC+ryXB3V6QqP03pGV8CakAaaN041taVFttwVF4h2V6WyadnZxT1CaxHu5Q7S2bA0anqtdnY5Mna6RzqbbYocnLVmUDdqR0+b2XWu0MQQjvPdZIf38dIgimR0um9aI3lEVnfAdjXQEjUjea/c02TCIYl1SW/s0VCJiy9w8mc6mRUERSYv+k9zvyG5stdWlo0RXuaOo9zw51Mi+TDflRW4ft8Mv22NTo6WKd2SlGRXBE87OLWRzVjKSrHdawoORtmJ7ZTO0cb3bqn2a3I3VYZuo7fLZNeftlU7R/EFhA4dPwtNR3RByv0NEg0j8QEUGEgkR9I6RkVJOvdtjxiF7/T0y7t3EOhxiWDyPxOWiLyVrDDF7gCK0vBrsocQb0i+O9/KAQlYigmTaa2iGNrgrpe3N+sBdwE7QE/dy0Vdcs9k9oa8WB+8jrDmTUMyzENwMejqoPaBFiHhKFyli3kBH7pZWv/CcJBC8IRedmzEtWvgt1qm1gIT3Pmjt/N+qRqRh3+eHpDFMv52+mcZAcWilFN2BzdYR3uV8YZE9xV8Uqv+FQAJW2rSggyn5a2toap6CWWmy4W086nhrKcpEV5Sl+Yh3AWt0DOmEITV1RPMML0Voel4jcE+F6N37fDy1nY8dWEezhE7mzZMDzDMIbMsKleHsZ4LtSvnmtnOczCjarANmQiXn+jP77OA0POubVGeDk0d3X31UV+p9ZTue2snHDrpDSq5020STxaFFXx+96AF1T6Ds1oAwpPT2YFWuT6TezEcd0BOe+1zo5TWs/wMAAAAAAAAAAKcfPP8DAAAAAAAAAACnHzz/AwAAAAAAAAAApx/4/wMAAAAAAAAAAE4/WP8HAAAAAAAAAABOP9Nn/wMzHWOZC//vwuvnfyzRG28l2Im/OfvH556b+jexfz91P8YyzzS9iySeKi3FetZBk11daBK+o7Za/K4gt7oa0XmNiEQxQkK27LMlrUMlo6NaJ0mGhHvPkWTVhk60fesc3g2utp5ldbWriaR/pqp5NfPwY2I8tbQUe3uHOgYI0Rpy6YbPKUCIgOUS4Ihn9Zul2uA2uTrHrpdq66UNjh7XHch1xHHJQTH3pGVvPUTE9Yq48TQimMdfi6oUdVR/P5we4yqIotpVDN6qDnoEvFkd7rHCHpcIvoYK5Lx/XOsj8c146saN2DcKkT4beEMTFF2OdN/gDb92qCcHr3SYU4eIBgw70LTv5SG0UY98wvkPw6HtT+hQc1HVpENOGO+LuObrszanNbLsoJVNbTIJc+Q6YL8Un1FvJB4mDU1uNol2mIXwcrvdpZbJS6RFjEMN1LG/avmqWYoj659a465sVTnHnCJO0/WqmFrjrpYrbI3b5NbrbLVUrnFzpbWtaj3Lpp24rCcu24/LyjrrZiCdeYXlKhsHLH/sKrKOc39yVWTpd6po+/WN0lOpIv4nJlL6jaMcNewrT+4wifLDa7fjM+184u17Q9pA58WuphHF8Byj7IwC4cc6H17vw3QGq/2KPV5FHfg8tXONq7AVbueifSD74FBFT/U2Ozr3RrlWr5mDm91GOfZKdeuGe+dkO+75z52LslTc2ty42L+90DHRVNW5OHiytCMbuOyJ45znrpG2ag6RU5kj24vHl46sm/Xi2grDMNlR51WcNJG6tRRlV2FzpVzIxcpWYyIlFoercYZIM2BP1WTjgaNrMGTz4JwQTxWLsYcZz/RpUC7q+vWQidSgVOhsyuth6UgTKoXcNw6dTvmFHEceC+HOgPozlpduxWd28omv3x7aOfsV2+wKmnT8HhlQ5HTDcqXGVeuH9b5j9C2zx47at2zZI/QtJ8jxl0DHh75rLHvW0Pd+0M+9hb8MjucsVncFrJLoTkk8us1kdU/RwkpqehKw/n/0QaBvym1ZbwuGuGePAb3sG/HU1Xys1xzmksDKaGjgVd9D09D4w07g79eFc8C+58mpP5vtfW2HZvfhuSHZtWegoYFXRsiuHf/4DgO8JfBk3rXlx3BuYX7/H0v+EZP8oyf6GA0AAAAAAAAAAICTJhMb34kJomjwK5JAGourK0urq4vLS0uiICw0hMXG8upufmlpiSyOmd//x5LvMcn30AwAAAAAAAAAAMAPGXPjO5MjvQDA+X8AAAAAAAAAAMDpB+f/AQAAAAAAAAAApx88/wMAAAAAAAAAAKcffP8PAAAAAAAAAACcfrD+DwAAAAAAAAAAnH7w/A8AAAAAAAAAADwb3//Hkt9nkt9/2jkBAAAAAAAAAADAyXMmNs7Exs31/7HkXzDJ/5P8C9QyAAAAAAAAAABwmjg7HouNjY2PT0463/8nv/O08wQAAAAAAAAAAIAn+f1/knmNuUDO/+a5z5+LTV2ZvJH47cQL8aWzf37mvfE/HfuVmMy8du7bzC+GRj9IG/GZm8XEw+uGJjebRLvbJV3C6+Rulygi4YWusadqsvGAb6uKaqiKLEZJrFe5Up1j69Xy1atclT1c0dQad2WryrHbr2+YEbeusAq5b7hR2K1KpJKpnWtcha1wOxd9UV7d2tzwX5la466WK2yN2+TW62y1VK5xc6W1rWo9y6apctZNzlXOioKiqAarkaZGdD2deYXlKhsHl/X4DCkmHpLDakqXlWaLGKrCy+121xAaLfK4dRaicrD2XKHRaq4vXq6xla06a1aee/FYFddXKeusm1OnAvNafGa7mHjYPKwCZUUnmsGrivjYFedR5VRYuVLjqvXD64h7o1yr1+bsGsixV6pbNyKjsDvXuCrXr4BiLnOsGhRaGhGkByy5L+uGY3q9zl3aSQ/ePKzmFJWXSIsYj11vriKn1ja4Tc40syG19hhdrUFYKznJMZaPd+IzN9KJh2VfkYkSSD3Qw4hiaDLRQ0sZHXewKwVl++W2U+h3owFRT28Khh1eRXaMflWFdaSiGp+5mU48mg6tG1kiihHajUapnbDYUT3HVxd2d5li2bAe44iydkeRpaJZebLEblUHapsGDdRdZvTacwoR0Z3uKPGZ6+nEgTrctjRytytrRDqGaTlRR6q5SCva3tw8hsU4aTul/Xg7niqkYz1eViRy30qmQxRJVppucr5cbdtlLFc2uDfY8AhT7EBh5nSi67J5i5KyweJknPHREAxSTNva0r3pVjx1NR3rFTx5G6jMriLf7fqzWLezuF0p39z25zQieliGB3LZ278TTxWLsYO3ht61o67XHOMorW1y0bcKs494br6VOmda0uvV8o1S9RZ7nbvFrl/j1q/PeW8m2Sk2MDty4pljjWkpdiS/0BpX3+G4CptjS5UNtrCwkM8VCosry/nlhUIhl5nKsLV6tbxe761+OZ7aKsV6bdoQXV1oEl5sqV2J73ZaqiDxgiLuqZrOa0QkihEtUPUZz6GKrGaJFpvraOqu3DLHpSyrq12Ndq592TQ0doOrrWdq8kSqWYoxNOP63ZZs0LpW6W9+SAZy0WE3D764F0+VSrFH69QQoiWjQ173GUO0HDWHfinZOvdGvd+oVe4KV+Uq61zNkdHnZCljVpp9R14v1dZLG5xpIMH6iTCRoNjlIrtADcxsEnmfSLxgRMX1irjxPKY7rL365vZwvhmfEfKJt2/YI3BHU/dliWi8rBhEE0RDVhWdb4sdvqu1+GZX0MxqkwSDhEoGBuXRtQ3e+e/IipSVZL3TEh7wX9atyXSowv7gbcYppk39pCWLsiGY4Wna5czGNbXw5L5hRpwz5b3qs+lPXWyrEklniumu1kqbHaLKrm+VNrnaOjdH4xoPOiQ0ohkhk00r3VYrnXmhaP1j+I3yxvrr7HZ1k/WUxJmEEfMSK3U10+Stodq+hzz82K7VXp88QntZE4iTai9L2+D99FlvmukzAjPFfIEZ+4ULz0+r8Y8wX5hqTfzbs39+5tuJ//54bxYeXfqp+Myb+cTXxaGNbv5QDJ7myWqr4zf5oK6Qp1wzMEslJSLxBtHasiK0rEjDLWKKZWlbWaLlCjuX1ojeURWd8B2NdARz1pTtX7unyYZBlHSG2gudr0Yka8/WMpaJmJbFWo/T1nxnQCMVcJT6s6O29mkuJCK2ZIX+UxQUkbToP8n9jjW3C9PQf/CIyOcUyw61QKfqfCboqLBqnhVVxdAESRYNnXUqjcorhjNaXO/GZ/R84u17Qw2nY+q1Zoz7QqtLTmjYGKr2mOOHR6fQMWMILWsMiXroscYVQdybO3SEMafrRKdPvmajWvPk/thCy2DK0X+kM04r04eD4Y3pZpqlcfXwwcTb1HbefANM4jrzJeYJcnCxx8RnxFLi4XrQXFpqU1a8L3PcZ1PniThCdPA57Qg6B4ccwTBIu2OYcxrP9MbSJEtZjYiqZnY2wfBZ1ECeRup6NFb/CTbk+b/3ubfiqdul2MFZOseNLJrZqPvmyEazHJ2tL4Y9TI2o1Zq/R+v2zAcDz4CWnnTta8Om79GK+Vx02BcOln4yPsPnEw9vj3Lrst90nMy9y6vsyKPNsNuL0+eH9nj6WO2mEjaT2BP2SX9I943bDMP8Q+YHl4Ov9WLxGb6UeOS8QI600SZRiEaneoFWPfYwEdQ4OEh0NFUkuu6RPGQwoK3uThJecHuEOYNwb+qDlwfTeaFoahm8/mJumLHIrRZpCi02MPB4sm9ogqLLdMJsGcg7zFfpU/FPnztk8I0OueV7Ko6Wo3Oo/rhrPRV7X5F4HozN0ZG2jC1Pn5Czx3iqtuMEmzHiUThE8rL9QOzcGgLJWvFaRGkae3OOTCbwkmYlt0h1WD0/TIFnvmjbRjatE8MwZ4gZKy791SaKYSmw4/Wv2vNV06a8V02Vnsmmohr8rtpVzH/rclMh5jQqnXXvVbwk66KqKES0pi/2OwT3Zhj9DsEVcd8hWM/jw6J5JC4XvenQ+JaMVTf9PmNW6GCxM3SSbos6NRcma2cg43lR9uK9eOq1vPOiLPxWIHXDX1O84Xs3Fhk3cE/1Bs9JRJDMxwJeMLKdbqMli6YJufPGwPvVh1/apzPxd144zkz8cV+4DFV7km9enuXpOc7/BwAAAAAAAAAAno3v/839/wAAAAAAAAAAADi9YP0fAAAAAAAAAAA4/UyfyTFnY7/MjP1q7JcvvHCuOfH7TztHIIzeW71xunvxQD50m7Oz39c+gu0ENjkHNA4e6nYim5b7RxzJOit0zF1I86rSeuCcCzDWG4vPbJcSjx4cVgVhp0kcu/QjHCfh2fc1wqZNc4OPuanIc8KDd8OZu3kzsLmMig/uwXOjhO49G76JKGITp0fVwCZOhhn7Jroo+EHk3Y/2EvGZW/nEz6dH2rg/cAzEsXftRx/+cKyTZtwhYuAoGGdr5uD5LcWQw2hcqSGHurhHBXo1jnKSgFe3m7QkN4luhOoMkxmqi9zv0K3BnhPJhqkdEKf72p0fgTghEi/m6Pk25hE8YTU/pHZPoA1GOL3Hf2ZPhKaie8TPoe0TrPtR2yhEzjpCIHDxaK0UFTxiu/Vl3Powt4KH2Et/H/hlqsazJZq2/2OccGSNBmFnrrx9qRenI9O7A4dP+MaT/u32cc8TCWqKmLqMOA4Nr3znODSWnQsZqiIOqgo7N2u0w6ts0S4tXFe5o6j3FGt7tXV81tBOOzQ3zvlaTzgzTjKPdYRXdMKZI076fLYcnO89vN2boIfhvPPiUMsNeVo4vvGGKAux3/55sZ5jlQaP1cjaZ0zYsvSQCbopn5clugs/6/mtdNsNonmvGOS+kW0TY0+V3MvWAGeqMvbME4JNvUZXo/plg7TNv85RAua/6dkEjZYq3pGVpu+QAkclHZCy3rEosmMedXjyPVYFByas/wMAAAAAAAAAAM/G/v+JM19kzl2Jfz++PvHWWePMF592ngAAP/wcfLh3IZ5q5mMPU0NOu23JumG6Buu7CKOvdUOFhRFOwI3QN+xUXM+bZO/rWOogqn9MLluqrQeOyrVe2TsLHdkR3YEcxHvT8RTJxw7eOkK9NFtqQ2iFyn7pGNViqRtWK+9HVfQ+2zsfT+3kY71RqmKYafBHqIOTNYneUu9cPLWdj/WaI5RhSDP+xBGK8PjN98613lR8Zjuf+Jnk0IUdZ6XvcRck/XoGl3PcRf6TXZEM9W/jeLPxuNsZZa1/1NX+k1zvP+qK/+hr/qOv+h9j3f+kVv4PX9cfdWXf+rbjcdZGXQsdWCR991JvMj4j5hM/77jYjeoDdmF3ZdKS9MfvUiHqwnqWr32yQz6wef+/Svoh+nLoSX5Eha+S8FXSyX6V5Fg31v8BAAAAAAAAAIBnHXz/DwAAAAAAAAAAnH7w/A8AAAAAAAAAAJx+8PwPAAAAAAAAAAAwp57/D3NGvCAAEAYA"
  },
  "canonical24-scrubbed-queues": {
    "gzipSha256": "b994a63b7a0c4eda731d546175745ec8cba2cbe53b47d86d4c802af06d2ef5fe",
    "base64": "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"
  },
  "canonical40-unmarked-resolution": {
    "gzipSha256": "6c5312ada26be3b8f85ffc3bc216fcedef844f0170d6aefee0043a7b8751ef16",
    "base64": "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"
  }
} as const;

export function canonical20To40DatabaseBytes(scenario: Canonical20To40Scenario): Buffer {
  const digest = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
  if (digest(Buffer.from(canonical20To40GeneratorSource)) !== canonical20To40Fixture.generatorSha256) throw new Error("HISTORICAL_RECIPE_MISMATCH");
  const stored = compressed[scenario];
  const packed = Buffer.from(stored.base64, "base64");
  if (digest(packed) !== stored.gzipSha256) throw new Error("HISTORICAL_GZIP_MISMATCH");
  const bytes = gunzipSync(packed, { maxOutputLength: 8 * 1024 * 1024 });
  const expected = canonical20To40Fixture.captures[scenario];
  if (bytes.length !== expected.databaseBytes || digest(bytes) !== expected.databaseSha256) throw new Error("HISTORICAL_IMAGE_MISMATCH");
  return bytes;
}
