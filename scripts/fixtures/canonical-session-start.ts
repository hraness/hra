import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

// Exact archived session-start producers. Synthetic receipts prove storage
// compatibility only, not native provider execution or current runtime custody.
export const canonicalSessionStartFixtures = {
  "canonical33_applied": {
    "name": "canonical33",
    "version": 33,
    "sourceCommit": "846f5c99f573f97ce99f1f23ac1ea45d93e63042",
    "sourceTree": "03d6346c19d33dda3729db65413af982d7be7cf5",
    "sourceFileCount": 229,
    "sourceManifestSha256": "3bcaeadfb5fda47fbfbe27228ff58e50b3b79e7340c8b21364788edad6db2eda",
    "sourceHashes": {
      "src/storage/state-store.ts": "9c40a3a616f308c7387ba2861e3307624f75019aed79608626a0a7325e04caad",
      "src/domain/presets.ts": "9f7473ced07f9c81b9fe44b65d86fc6a79783af57e4bc3e0b3bde483efea0d83",
      "src/domain/runtime-profile.ts": "6488d7fc1d0d769975da1de904d4927cea8ca7604cbacc22e6a951d0261df677",
      "package.json": "b24d0878dbb4ac09e58c7ca270f748aec559befddb3765772133b47e540ba1b2",
      "bun.lock": "2640e9d87062f81a175d4b022c377018e7c13bbe5065dcb904fac2b066fa703c"
    },
    "dependencies": {
      "@hraness/oh": "0.2.7",
      "@openai/codex": "0.153.2",
      "convex": "1.45.0",
      "zod": "4.4.3"
    },
    "model": "gpt-5.6-sol",
    "interpretedPresetContract": 1,
    "scenario": "applied",
    "generatorSha256": "e5345ff7b1235beb52ad979c4439b2db06e6329c9565c9c032d3837355932933",
    "dependencyManifestSha256": {
      "@hraness/oh": "ad5ea2f55afd7f2147558e8ee0ae73d6d38c96d9ae8ec97dc3aebf6d5dd5b05b",
      "@openai/codex": "4ecf4eae28684c5fcba8b9a63b946ce22b8cc2e451750f23c04e5088cf4c7a05",
      "convex": "aa9f5baee26b69a88d6b61180e540cce1f52baa31094e7124c8c0393e4b3211e",
      "zod": "c630bd10b52dcf71c112a2bf78dbf2734b9db58d62de663b8d86c2ec2c8cda2e"
    },
    "bootId": "boot_24e94126efee46a78fdf35f4937a3ee0",
    "daemonGeneration": 1,
    "originalUnusedUsageRevision": 1,
    "usageObservations": 0,
    "profile": {
      "id": "acct_49c346fece2d478eb6fb0a6243e4e951",
      "label": "Synthetic canonical33 applied",
      "state": "signed_in",
      "processGeneration": 1,
      "providerEmail": "historical-start@example.com",
      "providerPlan": "Plus",
      "createdAt": 33039,
      "updatedAt": 33039
    },
    "project": {
      "id": "proj_86cf6119f96e45ff96a6de2389776865",
      "label": "Synthetic historical start",
      "rootPath": "/opt/homebrew",
      "default": true,
      "createdAt": 33039,
      "updatedAt": 33039
    },
    "session": {
      "id": "sess_2f434b2cfddf496999d8eaee0279978c",
      "profileId": "acct_49c346fece2d478eb6fb0a6243e4e951",
      "projectId": "proj_86cf6119f96e45ff96a6de2389776865",
      "providerThreadId": "synthetic-canonical33-start",
      "title": "Untitled session",
      "note": "",
      "provider": "codex",
      "preset": "high",
      "fastEnabled": false,
      "state": "idle",
      "providerUpdatedAt": 33039,
      "revision": 2,
      "createdAt": 33039,
      "updatedAt": 33039
    },
    "idempotencyKey": "aecfb36b-405b-4f10-ba6f-08706fd9ce83",
    "request": {
      "projectId": "proj_86cf6119f96e45ff96a6de2389776865",
      "preset": "high",
      "fast": false
    },
    "runtime": {
      "profileId": "acct_49c346fece2d478eb6fb0a6243e4e951",
      "processGeneration": 1,
      "observedAt": 33039,
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
    "mutation": {
      "id": "attempt_002b67c0f5ba4e08af9758bf0d75d472",
      "idempotencyKey": "aecfb36b-405b-4f10-ba6f-08706fd9ce83",
      "kind": "session.start",
      "authorityId": "acct_49c346fece2d478eb6fb0a6243e4e951",
      "authorityGeneration": 1,
      "requestDigest": "46ed78899d5716e3542071bf6dbac803bfc4cacd22d138308e87db1dbc9c9d40",
      "state": "applied",
      "result": {
        "sessionId": "sess_2f434b2cfddf496999d8eaee0279978c",
        "sourceId": "attempt_002b67c0f5ba4e08af9758bf0d75d472",
        "effectiveRuntimeProfile": {
          "profileId": "acct_49c346fece2d478eb6fb0a6243e4e951",
          "processGeneration": 1,
          "observedAt": 33039,
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
      "evidence": {
        "attemptId": "attempt_002b67c0f5ba4e08af9758bf0d75d472",
        "digest": "1918031e55f4f8364d238a9e5464fea54f504584a523bcd847a3565883764637",
        "evidence": {
          "kind": "session.start",
          "projectId": "proj_86cf6119f96e45ff96a6de2389776865",
          "clientMessageId": null,
          "messageDigest": null,
          "runtimeProfile": {
            "profileId": "acct_49c346fece2d478eb6fb0a6243e4e951",
            "processGeneration": 1,
            "observedAt": 33039,
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
          "conversationAutomationCapability": "hra.automation_update.v1"
        },
        "recordedAt": 33039
      },
      "sessionStartId": "sess_2f434b2cfddf496999d8eaee0279978c"
    },
    "expectedReceipt": {
      "sessionId": "sess_2f434b2cfddf496999d8eaee0279978c",
      "sourceId": "attempt_002b67c0f5ba4e08af9758bf0d75d472",
      "effectiveRuntimeProfile": {
        "profileId": "acct_49c346fece2d478eb6fb0a6243e4e951",
        "processGeneration": 1,
        "observedAt": 33039,
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
    "databaseBytes": 1056768,
    "databaseSha256": "acb83665c2a475397cf8c5cd926b4e907f9533bd75abff327ad0984566bd6b81",
    "gzipBytes": 38228,
    "gzipSha256": "099e513aeabe9c974680893360520686082d5c3f80a4987191cfa270cdf43264",
    "snapshotSha256": "8e00be74aea42f763782b23cfa5f0947977c6b7ac2d89391c0a0a58e42439883",
    "schemaSha256": "2504e925e3c70a50093f2a6e805eceaca219bdd81e0b2a23838686cc5e70e10f",
    "ledger": [
      {
        "version": 1,
        "applied_at": 33039
      },
      {
        "version": 10,
        "applied_at": 33039
      },
      {
        "version": 11,
        "applied_at": 33039
      },
      {
        "version": 12,
        "applied_at": 33039
      },
      {
        "version": 13,
        "applied_at": 33039
      },
      {
        "version": 14,
        "applied_at": 33039
      },
      {
        "version": 15,
        "applied_at": 33039
      },
      {
        "version": 16,
        "applied_at": 33039
      },
      {
        "version": 17,
        "applied_at": 33039
      },
      {
        "version": 18,
        "applied_at": 33039
      },
      {
        "version": 19,
        "applied_at": 33039
      },
      {
        "version": 2,
        "applied_at": 33039
      },
      {
        "version": 20,
        "applied_at": 33039
      },
      {
        "version": 21,
        "applied_at": 33039
      },
      {
        "version": 22,
        "applied_at": 33039
      },
      {
        "version": 23,
        "applied_at": 33039
      },
      {
        "version": 24,
        "applied_at": 33039
      },
      {
        "version": 25,
        "applied_at": 33039
      },
      {
        "version": 26,
        "applied_at": 33039
      },
      {
        "version": 27,
        "applied_at": 33039
      },
      {
        "version": 28,
        "applied_at": 33039
      },
      {
        "version": 29,
        "applied_at": 33039
      },
      {
        "version": 3,
        "applied_at": 33039
      },
      {
        "version": 30,
        "applied_at": 33039
      },
      {
        "version": 31,
        "applied_at": 33039
      },
      {
        "version": 32,
        "applied_at": 33039
      },
      {
        "version": 33,
        "applied_at": 33039
      },
      {
        "version": 4,
        "applied_at": 33039
      },
      {
        "version": 5,
        "applied_at": 33039
      },
      {
        "version": 6,
        "applied_at": 33039
      },
      {
        "version": 7,
        "applied_at": 33039
      },
      {
        "version": 8,
        "applied_at": 33039
      },
      {
        "version": 9,
        "applied_at": 33039
      }
    ],
    "archivedRowsAndSchemaReopensUnchanged": true,
    "archivedReadonlyImageUnchanged": true,
    "proofScope": "exact archived public StateStore APIs with synthetic provider receipts; no native provider execution"
  },
  "canonical33_effect_started": {
    "name": "canonical33",
    "version": 33,
    "sourceCommit": "846f5c99f573f97ce99f1f23ac1ea45d93e63042",
    "sourceTree": "03d6346c19d33dda3729db65413af982d7be7cf5",
    "sourceFileCount": 229,
    "sourceManifestSha256": "3bcaeadfb5fda47fbfbe27228ff58e50b3b79e7340c8b21364788edad6db2eda",
    "sourceHashes": {
      "src/storage/state-store.ts": "9c40a3a616f308c7387ba2861e3307624f75019aed79608626a0a7325e04caad",
      "src/domain/presets.ts": "9f7473ced07f9c81b9fe44b65d86fc6a79783af57e4bc3e0b3bde483efea0d83",
      "src/domain/runtime-profile.ts": "6488d7fc1d0d769975da1de904d4927cea8ca7604cbacc22e6a951d0261df677",
      "package.json": "b24d0878dbb4ac09e58c7ca270f748aec559befddb3765772133b47e540ba1b2",
      "bun.lock": "2640e9d87062f81a175d4b022c377018e7c13bbe5065dcb904fac2b066fa703c"
    },
    "dependencies": {
      "@hraness/oh": "0.2.7",
      "@openai/codex": "0.153.2",
      "convex": "1.45.0",
      "zod": "4.4.3"
    },
    "model": "gpt-5.6-sol",
    "interpretedPresetContract": 1,
    "scenario": "effect_started",
    "generatorSha256": "e5345ff7b1235beb52ad979c4439b2db06e6329c9565c9c032d3837355932933",
    "dependencyManifestSha256": {
      "@hraness/oh": "ad5ea2f55afd7f2147558e8ee0ae73d6d38c96d9ae8ec97dc3aebf6d5dd5b05b",
      "@openai/codex": "4ecf4eae28684c5fcba8b9a63b946ce22b8cc2e451750f23c04e5088cf4c7a05",
      "convex": "aa9f5baee26b69a88d6b61180e540cce1f52baa31094e7124c8c0393e4b3211e",
      "zod": "c630bd10b52dcf71c112a2bf78dbf2734b9db58d62de663b8d86c2ec2c8cda2e"
    },
    "bootId": "boot_a2dcacfd37f545bca610cb9b4041d267",
    "daemonGeneration": 1,
    "originalUnusedUsageRevision": 1,
    "usageObservations": 0,
    "profile": {
      "id": "acct_c8e97aa24e16498b8fbb864f1f935429",
      "label": "Synthetic canonical33 effect_started",
      "state": "signed_in",
      "processGeneration": 1,
      "providerEmail": "historical-start@example.com",
      "providerPlan": "Plus",
      "createdAt": 33039,
      "updatedAt": 33039
    },
    "project": {
      "id": "proj_65ab5df04f7d49b3acde5dd8d02cc1ba",
      "label": "Synthetic historical start",
      "rootPath": "/opt/homebrew",
      "default": true,
      "createdAt": 33039,
      "updatedAt": 33039
    },
    "session": {
      "id": "sess_459d12b9bff244e7883fb82da505d6a9",
      "profileId": "acct_c8e97aa24e16498b8fbb864f1f935429",
      "projectId": "proj_65ab5df04f7d49b3acde5dd8d02cc1ba",
      "title": "Untitled session",
      "note": "",
      "provider": "codex",
      "preset": "high",
      "fastEnabled": false,
      "state": "starting",
      "revision": 1,
      "createdAt": 33039,
      "updatedAt": 33039
    },
    "idempotencyKey": "8c97d9f8-74f4-4bb4-ae8c-e642cfc6cfac",
    "request": {
      "projectId": "proj_65ab5df04f7d49b3acde5dd8d02cc1ba",
      "preset": "high",
      "fast": false
    },
    "runtime": {
      "profileId": "acct_c8e97aa24e16498b8fbb864f1f935429",
      "processGeneration": 1,
      "observedAt": 33039,
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
    "mutation": {
      "id": "attempt_3924587d665849c1a472b50e993c6cd2",
      "idempotencyKey": "8c97d9f8-74f4-4bb4-ae8c-e642cfc6cfac",
      "kind": "session.start",
      "authorityId": "acct_c8e97aa24e16498b8fbb864f1f935429",
      "authorityGeneration": 1,
      "requestDigest": "733d835a6ada2cbbd2cb8d1bf70719a13e1f82185224c0400edb0e9d14a6be19",
      "state": "effect_started",
      "evidence": {
        "attemptId": "attempt_3924587d665849c1a472b50e993c6cd2",
        "digest": "112c9f60bd333ea012c3566ab983a7395aaa8891b365841abbddefb344662a0b",
        "evidence": {
          "kind": "session.start",
          "projectId": "proj_65ab5df04f7d49b3acde5dd8d02cc1ba",
          "clientMessageId": null,
          "messageDigest": null,
          "runtimeProfile": {
            "profileId": "acct_c8e97aa24e16498b8fbb864f1f935429",
            "processGeneration": 1,
            "observedAt": 33039,
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
          "conversationAutomationCapability": "hra.automation_update.v1"
        },
        "recordedAt": 33039
      },
      "sessionStartId": "sess_459d12b9bff244e7883fb82da505d6a9"
    },
    "expectedReceipt": null,
    "databaseBytes": 1056768,
    "databaseSha256": "1f9f7b3f5fb72b93605e6a0f2829c71277a62aa22f931646dfed64285f2f5274",
    "gzipBytes": 37548,
    "gzipSha256": "af6f663e355d4481c33b269dbb656519889ccbdf303aae1c3d86280adc7f9b06",
    "snapshotSha256": "10c5151939f97a61f24e1769ad6e75e67a9646d97cd76ecfd720a8137a3d44aa",
    "schemaSha256": "2504e925e3c70a50093f2a6e805eceaca219bdd81e0b2a23838686cc5e70e10f",
    "ledger": [
      {
        "version": 1,
        "applied_at": 33039
      },
      {
        "version": 10,
        "applied_at": 33039
      },
      {
        "version": 11,
        "applied_at": 33039
      },
      {
        "version": 12,
        "applied_at": 33039
      },
      {
        "version": 13,
        "applied_at": 33039
      },
      {
        "version": 14,
        "applied_at": 33039
      },
      {
        "version": 15,
        "applied_at": 33039
      },
      {
        "version": 16,
        "applied_at": 33039
      },
      {
        "version": 17,
        "applied_at": 33039
      },
      {
        "version": 18,
        "applied_at": 33039
      },
      {
        "version": 19,
        "applied_at": 33039
      },
      {
        "version": 2,
        "applied_at": 33039
      },
      {
        "version": 20,
        "applied_at": 33039
      },
      {
        "version": 21,
        "applied_at": 33039
      },
      {
        "version": 22,
        "applied_at": 33039
      },
      {
        "version": 23,
        "applied_at": 33039
      },
      {
        "version": 24,
        "applied_at": 33039
      },
      {
        "version": 25,
        "applied_at": 33039
      },
      {
        "version": 26,
        "applied_at": 33039
      },
      {
        "version": 27,
        "applied_at": 33039
      },
      {
        "version": 28,
        "applied_at": 33039
      },
      {
        "version": 29,
        "applied_at": 33039
      },
      {
        "version": 3,
        "applied_at": 33039
      },
      {
        "version": 30,
        "applied_at": 33039
      },
      {
        "version": 31,
        "applied_at": 33039
      },
      {
        "version": 32,
        "applied_at": 33039
      },
      {
        "version": 33,
        "applied_at": 33039
      },
      {
        "version": 4,
        "applied_at": 33039
      },
      {
        "version": 5,
        "applied_at": 33039
      },
      {
        "version": 6,
        "applied_at": 33039
      },
      {
        "version": 7,
        "applied_at": 33039
      },
      {
        "version": 8,
        "applied_at": 33039
      },
      {
        "version": 9,
        "applied_at": 33039
      }
    ],
    "archivedRowsAndSchemaReopensUnchanged": true,
    "archivedReadonlyImageUnchanged": true,
    "proofScope": "exact archived public StateStore APIs with synthetic provider receipts; no native provider execution"
  },
  "canonical39_applied": {
    "name": "canonical39",
    "version": 39,
    "sourceCommit": "5f2735191640037c86d9949bc1d7f04b2ef09ffe",
    "sourceTree": "12b4cec2c26b328e41d763ecca41c9a844d3dec3",
    "sourceFileCount": 282,
    "sourceManifestSha256": "b4a34de0517950f4dc6bb2288c3f5ca79274551095a1aa63436c1099181e71fc",
    "sourceHashes": {
      "src/storage/state-store.ts": "bde901608092489d89aa9acdfde320a0cf2959a6bd3659879cf7ac9dfab43e89",
      "src/domain/runtime-profile.ts": "49305314d5619f828b685a8e45d5bd055719c7661e77db8ea9e44924de4f85b2",
      "src/domain/presets.ts": "cde66c4106ee7f2961b8c959327cc277e056b761cf282d53738792d9d99e66de",
      "package.json": "ef8779bd5fa796f395ad3d064710e247a89eb0cbd4023dc069b4daaad8e12d3c",
      "bun.lock": "5a2b90063d8eb1aa55e18be71abbca59c1f051a9358a2a36ff89698d066b182a"
    },
    "dependencies": {
      "@agentclientprotocol/sdk": "1.4.0",
      "@hraness/oh": "0.2.7",
      "@openai/codex": "0.153.2",
      "convex": "1.45.0",
      "zod": "4.4.3"
    },
    "model": "gpt-6-astra",
    "interpretedPresetContract": 2,
    "scenario": "applied",
    "generatorSha256": "e5345ff7b1235beb52ad979c4439b2db06e6329c9565c9c032d3837355932933",
    "dependencyManifestSha256": {
      "@agentclientprotocol/sdk": "89bbcd7a71a3cd6e94b7096ef1f239dda62b5fb8aef840d3475af3fbfff3a955",
      "@hraness/oh": "ad5ea2f55afd7f2147558e8ee0ae73d6d38c96d9ae8ec97dc3aebf6d5dd5b05b",
      "@openai/codex": "4ecf4eae28684c5fcba8b9a63b946ce22b8cc2e451750f23c04e5088cf4c7a05",
      "convex": "aa9f5baee26b69a88d6b61180e540cce1f52baa31094e7124c8c0393e4b3211e",
      "zod": "c630bd10b52dcf71c112a2bf78dbf2734b9db58d62de663b8d86c2ec2c8cda2e"
    },
    "bootId": "boot_00c24ce459a24e2284f938a98eddcaa3",
    "daemonGeneration": 1,
    "originalUnusedUsageRevision": 1,
    "usageObservations": 0,
    "profile": {
      "id": "acct_9bc9ef2b7e76476198a3c4dbccc97ac5",
      "label": "Synthetic canonical39 applied",
      "state": "signed_in",
      "processGeneration": 1,
      "providerEmail": "historical-start@example.com",
      "providerPlan": "Plus",
      "createdAt": 33039,
      "updatedAt": 33039
    },
    "project": {
      "id": "proj_780a9d2626504aa38762410fbe9e0130",
      "label": "Synthetic historical start",
      "rootPath": "/opt/homebrew",
      "default": true,
      "createdAt": 33039,
      "updatedAt": 33039
    },
    "session": {
      "id": "sess_1f960696ed2c4043b24ffcb05e2fff0a",
      "profileId": "acct_9bc9ef2b7e76476198a3c4dbccc97ac5",
      "projectId": "proj_780a9d2626504aa38762410fbe9e0130",
      "providerThreadId": "synthetic-canonical39-start",
      "title": "Untitled session",
      "note": "",
      "provider": "codex",
      "preset": "high",
      "fastEnabled": false,
      "state": "idle",
      "providerUpdatedAt": 33039,
      "revision": 2,
      "createdAt": 33039,
      "updatedAt": 33039
    },
    "idempotencyKey": "95eb5649-7a94-4fb9-8e15-d605992b950c",
    "request": {
      "projectId": "proj_780a9d2626504aa38762410fbe9e0130",
      "provider": "codex",
      "preset": "high",
      "fast": false
    },
    "runtime": {
      "profileId": "acct_9bc9ef2b7e76476198a3c4dbccc97ac5",
      "processGeneration": 1,
      "observedAt": 33039,
      "preset": "high",
      "model": "gpt-6-astra",
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
    "mutation": {
      "id": "attempt_d186ca9847854c508cd50c9abc00a01d",
      "idempotencyKey": "95eb5649-7a94-4fb9-8e15-d605992b950c",
      "kind": "session.start",
      "authorityId": "acct_9bc9ef2b7e76476198a3c4dbccc97ac5",
      "authorityGeneration": 1,
      "requestDigest": "deafc6a861312c43b9ab6f0b9aaca1750a8fbb91f8a1ef6cc9292caf9b778490",
      "state": "applied",
      "result": {
        "sessionId": "sess_1f960696ed2c4043b24ffcb05e2fff0a",
        "sourceId": "attempt_d186ca9847854c508cd50c9abc00a01d",
        "effectiveRuntimeProfile": {
          "profileId": "acct_9bc9ef2b7e76476198a3c4dbccc97ac5",
          "processGeneration": 1,
          "observedAt": 33039,
          "preset": "high",
          "model": "gpt-6-astra",
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
      "evidence": {
        "attemptId": "attempt_d186ca9847854c508cd50c9abc00a01d",
        "digest": "b80aaeb299474d581479cf221260dcf7945420911f06527ed5d478b434141df6",
        "evidence": {
          "kind": "session.start",
          "projectId": "proj_780a9d2626504aa38762410fbe9e0130",
          "clientMessageId": null,
          "messageDigest": null,
          "runtimeProfile": {
            "profileId": "acct_9bc9ef2b7e76476198a3c4dbccc97ac5",
            "processGeneration": 1,
            "observedAt": 33039,
            "preset": "high",
            "model": "gpt-6-astra",
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
          "conversationAutomationCapability": "hra.automation_update.v1"
        },
        "recordedAt": 33039
      },
      "sessionStartId": "sess_1f960696ed2c4043b24ffcb05e2fff0a"
    },
    "expectedReceipt": {
      "sessionId": "sess_1f960696ed2c4043b24ffcb05e2fff0a",
      "sourceId": "attempt_d186ca9847854c508cd50c9abc00a01d",
      "effectiveRuntimeProfile": {
        "profileId": "acct_9bc9ef2b7e76476198a3c4dbccc97ac5",
        "processGeneration": 1,
        "observedAt": 33039,
        "preset": "high",
        "model": "gpt-6-astra",
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
    "databaseBytes": 1175552,
    "databaseSha256": "61039aabc5babf70db06874bfcd1180bc2f1da4532f97e4f0a6b1530695a16bf",
    "gzipBytes": 42803,
    "gzipSha256": "d29428c0fb0ca7777fa530299d908dd3b73783d39d00566702798afce733cb88",
    "snapshotSha256": "95b927abe572d02a44e32611e4ed0a3fdf4bf3b3baef42b10286afeb8a358a95",
    "schemaSha256": "fa72b050f4f174ef15ea97abb4d627a7774f2cd14b034c823d1488aa2a6b01ed",
    "ledger": [
      {
        "version": 1,
        "applied_at": 33039
      },
      {
        "version": 10,
        "applied_at": 33039
      },
      {
        "version": 11,
        "applied_at": 33039
      },
      {
        "version": 12,
        "applied_at": 33039
      },
      {
        "version": 13,
        "applied_at": 33039
      },
      {
        "version": 14,
        "applied_at": 33039
      },
      {
        "version": 15,
        "applied_at": 33039
      },
      {
        "version": 16,
        "applied_at": 33039
      },
      {
        "version": 17,
        "applied_at": 33039
      },
      {
        "version": 18,
        "applied_at": 33039
      },
      {
        "version": 19,
        "applied_at": 33039
      },
      {
        "version": 2,
        "applied_at": 33039
      },
      {
        "version": 20,
        "applied_at": 33039
      },
      {
        "version": 21,
        "applied_at": 33039
      },
      {
        "version": 22,
        "applied_at": 33039
      },
      {
        "version": 23,
        "applied_at": 33039
      },
      {
        "version": 24,
        "applied_at": 33039
      },
      {
        "version": 25,
        "applied_at": 33039
      },
      {
        "version": 26,
        "applied_at": 33039
      },
      {
        "version": 27,
        "applied_at": 33039
      },
      {
        "version": 28,
        "applied_at": 33039
      },
      {
        "version": 29,
        "applied_at": 33039
      },
      {
        "version": 3,
        "applied_at": 33039
      },
      {
        "version": 30,
        "applied_at": 33039
      },
      {
        "version": 31,
        "applied_at": 33039
      },
      {
        "version": 32,
        "applied_at": 33039
      },
      {
        "version": 33,
        "applied_at": 33039
      },
      {
        "version": 34,
        "applied_at": 33039
      },
      {
        "version": 35,
        "applied_at": 33039
      },
      {
        "version": 36,
        "applied_at": 33039
      },
      {
        "version": 37,
        "applied_at": 33039
      },
      {
        "version": 38,
        "applied_at": 33039
      },
      {
        "version": 39,
        "applied_at": 33039
      },
      {
        "version": 4,
        "applied_at": 33039
      },
      {
        "version": 5,
        "applied_at": 33039
      },
      {
        "version": 6,
        "applied_at": 33039
      },
      {
        "version": 7,
        "applied_at": 33039
      },
      {
        "version": 8,
        "applied_at": 33039
      },
      {
        "version": 9,
        "applied_at": 33039
      }
    ],
    "archivedRowsAndSchemaReopensUnchanged": true,
    "archivedReadonlyImageUnchanged": true,
    "proofScope": "exact archived public StateStore APIs with synthetic provider receipts; no native provider execution"
  },
  "canonical39_effect_started": {
    "name": "canonical39",
    "version": 39,
    "sourceCommit": "5f2735191640037c86d9949bc1d7f04b2ef09ffe",
    "sourceTree": "12b4cec2c26b328e41d763ecca41c9a844d3dec3",
    "sourceFileCount": 282,
    "sourceManifestSha256": "b4a34de0517950f4dc6bb2288c3f5ca79274551095a1aa63436c1099181e71fc",
    "sourceHashes": {
      "src/storage/state-store.ts": "bde901608092489d89aa9acdfde320a0cf2959a6bd3659879cf7ac9dfab43e89",
      "src/domain/runtime-profile.ts": "49305314d5619f828b685a8e45d5bd055719c7661e77db8ea9e44924de4f85b2",
      "src/domain/presets.ts": "cde66c4106ee7f2961b8c959327cc277e056b761cf282d53738792d9d99e66de",
      "package.json": "ef8779bd5fa796f395ad3d064710e247a89eb0cbd4023dc069b4daaad8e12d3c",
      "bun.lock": "5a2b90063d8eb1aa55e18be71abbca59c1f051a9358a2a36ff89698d066b182a"
    },
    "dependencies": {
      "@agentclientprotocol/sdk": "1.4.0",
      "@hraness/oh": "0.2.7",
      "@openai/codex": "0.153.2",
      "convex": "1.45.0",
      "zod": "4.4.3"
    },
    "model": "gpt-6-astra",
    "interpretedPresetContract": 2,
    "scenario": "effect_started",
    "generatorSha256": "e5345ff7b1235beb52ad979c4439b2db06e6329c9565c9c032d3837355932933",
    "dependencyManifestSha256": {
      "@agentclientprotocol/sdk": "89bbcd7a71a3cd6e94b7096ef1f239dda62b5fb8aef840d3475af3fbfff3a955",
      "@hraness/oh": "ad5ea2f55afd7f2147558e8ee0ae73d6d38c96d9ae8ec97dc3aebf6d5dd5b05b",
      "@openai/codex": "4ecf4eae28684c5fcba8b9a63b946ce22b8cc2e451750f23c04e5088cf4c7a05",
      "convex": "aa9f5baee26b69a88d6b61180e540cce1f52baa31094e7124c8c0393e4b3211e",
      "zod": "c630bd10b52dcf71c112a2bf78dbf2734b9db58d62de663b8d86c2ec2c8cda2e"
    },
    "bootId": "boot_60a610d7b07c41b3a794f84675233e84",
    "daemonGeneration": 1,
    "originalUnusedUsageRevision": 1,
    "usageObservations": 0,
    "profile": {
      "id": "acct_574d1c53b77a412086b823c3651c0483",
      "label": "Synthetic canonical39 effect_started",
      "state": "signed_in",
      "processGeneration": 1,
      "providerEmail": "historical-start@example.com",
      "providerPlan": "Plus",
      "createdAt": 33039,
      "updatedAt": 33039
    },
    "project": {
      "id": "proj_1dccd7d659184071b135b9f033b108be",
      "label": "Synthetic historical start",
      "rootPath": "/opt/homebrew",
      "default": true,
      "createdAt": 33039,
      "updatedAt": 33039
    },
    "session": {
      "id": "sess_e58544036b22498dadd4d13e4d1d64ab",
      "profileId": "acct_574d1c53b77a412086b823c3651c0483",
      "projectId": "proj_1dccd7d659184071b135b9f033b108be",
      "title": "Untitled session",
      "note": "",
      "provider": "codex",
      "preset": "high",
      "fastEnabled": false,
      "state": "starting",
      "revision": 1,
      "createdAt": 33039,
      "updatedAt": 33039
    },
    "idempotencyKey": "9eb2f8d8-10ff-4b77-991b-bd6fba36f2f6",
    "request": {
      "projectId": "proj_1dccd7d659184071b135b9f033b108be",
      "provider": "codex",
      "preset": "high",
      "fast": false
    },
    "runtime": {
      "profileId": "acct_574d1c53b77a412086b823c3651c0483",
      "processGeneration": 1,
      "observedAt": 33039,
      "preset": "high",
      "model": "gpt-6-astra",
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
    "mutation": {
      "id": "attempt_0ef2932b798a44f98cf961858c0dacff",
      "idempotencyKey": "9eb2f8d8-10ff-4b77-991b-bd6fba36f2f6",
      "kind": "session.start",
      "authorityId": "acct_574d1c53b77a412086b823c3651c0483",
      "authorityGeneration": 1,
      "requestDigest": "45600ffe54733601438d1c2757bfa935e05343bfbb577ad4ed380d6894640eca",
      "state": "effect_started",
      "evidence": {
        "attemptId": "attempt_0ef2932b798a44f98cf961858c0dacff",
        "digest": "33f238664ac4c59a52941eff4730046e2c40b5e35840b6733ebed8a15c3b75f4",
        "evidence": {
          "kind": "session.start",
          "projectId": "proj_1dccd7d659184071b135b9f033b108be",
          "clientMessageId": null,
          "messageDigest": null,
          "runtimeProfile": {
            "profileId": "acct_574d1c53b77a412086b823c3651c0483",
            "processGeneration": 1,
            "observedAt": 33039,
            "preset": "high",
            "model": "gpt-6-astra",
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
          "conversationAutomationCapability": "hra.automation_update.v1"
        },
        "recordedAt": 33039
      },
      "sessionStartId": "sess_e58544036b22498dadd4d13e4d1d64ab"
    },
    "expectedReceipt": null,
    "databaseBytes": 1175552,
    "databaseSha256": "63032e913080ceccfa4f5c481686005c1d12851c603db299c256c27a7dc1dafe",
    "gzipBytes": 42140,
    "gzipSha256": "54c77ec1392a12ecd81ae9ec9db0482627500f58820b31679ac2d68b3a8fa315",
    "snapshotSha256": "fedda094f352f1c17a7ddfd52c8df64cc489ad0b5b5effbf38de787d6095b52a",
    "schemaSha256": "fa72b050f4f174ef15ea97abb4d627a7774f2cd14b034c823d1488aa2a6b01ed",
    "ledger": [
      {
        "version": 1,
        "applied_at": 33039
      },
      {
        "version": 10,
        "applied_at": 33039
      },
      {
        "version": 11,
        "applied_at": 33039
      },
      {
        "version": 12,
        "applied_at": 33039
      },
      {
        "version": 13,
        "applied_at": 33039
      },
      {
        "version": 14,
        "applied_at": 33039
      },
      {
        "version": 15,
        "applied_at": 33039
      },
      {
        "version": 16,
        "applied_at": 33039
      },
      {
        "version": 17,
        "applied_at": 33039
      },
      {
        "version": 18,
        "applied_at": 33039
      },
      {
        "version": 19,
        "applied_at": 33039
      },
      {
        "version": 2,
        "applied_at": 33039
      },
      {
        "version": 20,
        "applied_at": 33039
      },
      {
        "version": 21,
        "applied_at": 33039
      },
      {
        "version": 22,
        "applied_at": 33039
      },
      {
        "version": 23,
        "applied_at": 33039
      },
      {
        "version": 24,
        "applied_at": 33039
      },
      {
        "version": 25,
        "applied_at": 33039
      },
      {
        "version": 26,
        "applied_at": 33039
      },
      {
        "version": 27,
        "applied_at": 33039
      },
      {
        "version": 28,
        "applied_at": 33039
      },
      {
        "version": 29,
        "applied_at": 33039
      },
      {
        "version": 3,
        "applied_at": 33039
      },
      {
        "version": 30,
        "applied_at": 33039
      },
      {
        "version": 31,
        "applied_at": 33039
      },
      {
        "version": 32,
        "applied_at": 33039
      },
      {
        "version": 33,
        "applied_at": 33039
      },
      {
        "version": 34,
        "applied_at": 33039
      },
      {
        "version": 35,
        "applied_at": 33039
      },
      {
        "version": 36,
        "applied_at": 33039
      },
      {
        "version": 37,
        "applied_at": 33039
      },
      {
        "version": 38,
        "applied_at": 33039
      },
      {
        "version": 39,
        "applied_at": 33039
      },
      {
        "version": 4,
        "applied_at": 33039
      },
      {
        "version": 5,
        "applied_at": 33039
      },
      {
        "version": 6,
        "applied_at": 33039
      },
      {
        "version": 7,
        "applied_at": 33039
      },
      {
        "version": 8,
        "applied_at": 33039
      },
      {
        "version": 9,
        "applied_at": 33039
      }
    ],
    "archivedRowsAndSchemaReopensUnchanged": true,
    "archivedReadonlyImageUnchanged": true,
    "proofScope": "exact archived public StateStore APIs with synthetic provider receipts; no native provider execution"
  }
} as const;

export type CanonicalSessionStartScenario = keyof typeof canonicalSessionStartFixtures;
const images = {
  "canonical33_applied": "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",
  "canonical33_effect_started": "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",
  "canonical39_applied": "H4sIAAAAAAACE+y9DXAjaXrf1yBnCJKzHNzd3h3ubrS6Hp7mAOyCswC/MbOcXQzZw8UNB9wFwePMreb6Go0XZO8AaEx3gzO8D51Bzn7cnU6WZVu6RLIjybKiKHHKpSo7rkRWqZxySv5K5JKSkyuJpVLFFTm2HMWpOKpcIuft7w90gyB39m5n9/8bDAG87/M87/fb3QD6ebZe3ZA0wjZkpSVo7BzzIWZkhHmJZRmGGWWY2Kfp/wv0dYxhRrL0+QzjQtOYFDOYUebyt//0LH3xXGJcV/l04nuJf5f4PxL/OvG/Jv4w8T8nfi/xO4n/NvFbib+d+HuJv5n41cQvJf5q4juJn0r8eOLNxJ9LfDmhJdqJvUQt8aOJzyfWEtcSy4nZRDbx2QSbOJ/4aOJTiVcSn0v8emI8McIAAAAAAAAAAABDEfvhR+foEzlaoH//8IjQlI8ftejfjx49S/9OHv0wTf/e0Yfo3z8+/Dr9+y8PO/TvPzts0r/fPRSozA8dfY2+/p+OuvTvbx9u0L//5HCN/v3Hhy/Qv//ocI7+/YeHM/TvPzikV9bMbx1+jP79zcMx+vdv93Td/7yn0r+/1Nulf/9y7wv07zd7up0/13uJ/t3vLdO/r/d0C3d7z9ASn3mk6/I9/Tr8Tk9vxqv79M/ndH3uDv3zYpX+Wf4c/ZN7kf55Vm/c9CX656Ofon+efmpK1/kQRh8AAAAAAAAAAHg/o1//p87/FpP408SfJP4o8Qf0G/nfpt/H/2bi79Dv438l8fP02/ifTLxNv4t/mOjQb+K/lLhNv3N/OfES/SY+l0jT7+E/kfgQ/f6dOf+n5//k/B+d/4Pzv3f+t6k5AAAAAAAAAADgXWEsNUp/bN5LjH3Wer5kPf+I9fwZ63naer5oPbPW86et5x+2np+xnn/Ier5gPX/Kev6k9fwJ6zlpPX/cev6Y9fxR6/lp6/kj1vOHrecPWc8J6/m89TxlPT9lPZ+zniet5wnredx6jlvPY9bzWev5jPU8aj2PWM8x81m//o8lfoOhDwAAAAAAAAAAALwneSl2jpnYGWWeGU9OjNdkWeNzOXF2XiTzCwVhdp7Mzi7PNwpzy0JhmdTroiDM0Ut+oavJV4Rms9vUFMG8/icMfQAAAAAAAAAAAOCd0PtEbHJn/dMT3MdGR9cFUdT4Qk0skMZsbYksLc4vLeYLy8KcOF+viaJYWBLEha2DtrZHNElkRaEttyVRaM4VWKHTaUqkrkq7bVLnpfaepGqyomfOqJqgaC+Rh0Kr0ySXRbn1SrOr0ot9+lAH2Zo0rv+/y9AHAAAAAAAAAAAAnizSozsTQ33QYF7//z5DHwAAAAAAAAAAAHgyYUfXJwZ+/2/+/v+bDH0AAAAAAAAAAADgXUeLje8UUxOjo8WOIr/OLy3nhEJ9dnF2cSE3T2/cX15anJ3P5xo1UiC5/FzOvUPAvQuANe4CeF7uaM/vyS1SU8iD4C0AQWH8/h8AAAAAAAAAAGCe5N//D/Uxgnn9/78z9AEAAAAAAAAAAID3Bx8aTU34fh9gXv//vwx9AAAAAAAAAAAA4H3I6OjEhHn9/4cMfQAAAAAAAAAAAOCJ5ZnR4kT0/f+m/785hj4AAAAAAAAAAADg0vtc7OmdnZ3Vmankx2LjH2Nio6OjSUYlqsrnG4XF3GJhkdRnxfnc/Fxtdr7REGu5BTLbaDRywlAh+Ya6b9+5op/xOPWfMS7pt9uapDVJndWrJMltUa6Th3vS7t6IVG+SEdMjIH0Y6fD/BwAAAAAAAAAAME+y/7+hPpEwr///K4Y+AAAAAAAAAAAA8N5j7czO6sRQvygY8GMB8/r/dxj6AAAAAAAAAAAAwJND9gz98p/+vn+o7/+njKgA6DQAAAAAAAAAAOD9zCSu/wEAAAAAAAAAgPc9+vf/TzFfZs7/q/OvMl9+6uK5Pzm3O/EbE9+e+NHxfz4uj37h3Sv5jbuj8eSlS7Fvfk0TatRdoUBacpunNyVovtdnVitcscqx1eL1DY715rDpSZZVpfZuk2hymy2Vq9w6V2FfqZRuFSt32JvcHXb1ZW71ZtqVWWHzmSzV2iVtogia5FErb1bZ8vbGhqXjkbi2wuYMrZosa7xUZ6vc7ar+3riBgtR5QbOtmKlyp+NLncyyddIQuk2NFzrUu+O+0ORb1PmiYcgteI27UdzeqLIpoavJV4RmM2XVJVy5VGbTrmjWfPlAVu6pHUEkNKEltLtCM5XJuMWre/IDXtuT2vdol/Q33a5BLlBwUI1N57J5r92OQlSiRbWHSihCsDGWitGKpvyA1ld3UUmfTGnT+r4kEl6UW7QpdZWn7ZQfUL+WkfXOO2VEKTo1p/fNyN22xjfNRh1v2+6TaEXLdobdqlZKq9VvfuSpePKZZ2J/8YExvy1nnKr9POWb13aqMaetKRYyk2nO+sbmdTZl/LbntdxMQZhp3H02xRbLa2yTtHe1PSqTofN8bsmYsnTCNKQmsWet26wKd4OrcOVVbsuWUXVNS+d1IjozPSCqZ3lF96U6UejkUIhQ9y4OwwdpoFCzEVY9DYEM+wKt66y5vtqyFrkmUn7l1eJWNW3IF7fY67RLMoal/OLc8ryvZlH2DOentlFH2JiNZlY2JTaFbp3oM9GwFzLDbe3jZrKjT6dkm6aJ2vFzuF+BTeezs6a1hqBqPGkb+2bUDhaQsWe+uW9p4UNj5hgtMTY3OsH1nUXUpH19R9H9x9InjSgtqS3om45CRHmfKAe8Qu53JYXUreaaKrzWVdreSaHQhakO2HWd/GvWlivSaeXfYoMqHglno+526sdoeSSolmuD7gzOnPbI0KW6EZgr3uzSlml7sxKqbdbLzdqfK5xoWhoKYVMzm9J3unYqY6x/n/zFFSvPrJRvLq3MGjugIu7RMfL1krXFeXPcpnmTna7eLpde3ebS7j6TDdkUMpP2ptg6F08uPRPrPS21aUvs7YRvCjXS5Ltt6X6X2IlPWRukWQKt4hp3mw3VYDfL7s6k78ZK2sjOZL46GU/O0eIWjOLkNuHdw48hb6udCyssRN5XlKTa2Rl252W6R7Juin6q8fzEWHL1mRhjFK7eb0oa4fWjtPGed5oya7+afH58KIW8/Wri6LNx4xjz5qeNY4ydbj+P+44xduqwxxjDD/UQxxijrwft9OZgsNe56g7HlekOp1vKL5oTSNFPqjqCthewYI6ELuHp1IjV7JPwbHTf992DnumZE/MeOTDaY8/73tiYOfE5e+Ibh1xrGpu7pZ0Yj5j4/RrWbDSP3r6Jb81Hcz+/uMLSjbpFN+p66vmzx0wxs5S8/Wrs0cwZY4q9PWNPMSPdfj4bnGJG6rBTzLh7+V2fYsMd76TdNh1EuavRbbUp70ptvkPadfMIaGXS7TTskJd1etc+1suifn52/FVGiKQzDZ1tlLQEqekcQp3kTlNoO6nvoZmeHIknL16M9Q6M+dKSds2Gqe6rUd+ccdONWUO71neG4Jk9xolFp9OUBlbZI2E01Dn2HH4kFk+urMSOlqwTcrGrSNoBr4pKt6Yvgj1Zfx+VPhI4YQ+XOvlF6Yp5SUq7VpXbobPUzFpJtcQO31WadOLV9fUv0wO/qWnOwwF94hXxd8rU1CPmfOyXmal/MvVzsV+e/CuTXxqZmLw08XNjhYk7Ex8/vzL1Z2e+iU9JftAIiXjyOXr0iJvbtnWxSCeCSNqa/fZD1gQ1DxgBIf1QYSd5V/Uat7WapVt15tGPfSSeTKVi37hqrA56WtUl9PJBUySi+t58zLcOfFnDbvum0sB9f9ncuc0aD7x8dVqla9JWrnEbHK0evUJcLa4ZJxAtKiHsDrwYNa4nbTn3ktJ/PKHROPLz88MfUtzjR12iH8po9PTZvJ4ydyj6qkF3duOF0KpJu125q+on90JbJM2mczj5QeztpG2OkapPBFqdwBVCf7Z7mdCX5+/EQi63lC8UZhfml+ZzhULO+bzkKPupeDKTib35tDEBjUtHtUs/wdFnlv/dM74p6M8zN+DHMm+8V6+OCXNaBnolOAfsfGc0zOod8K9H7fHeeegT9n++kZtfXlhafAfTwrMq024vZe22eq/pvNl2i9wDxxtf+Fg8+fzzsW+K5nG+qxkHcVqYRlodTe1L+IT/qB/MHvqU0ZQfuHvMm22lp0mtDv2MqC0eOKcpYRcY9HO8+qBB0fODe8GyWYRz3O+faj4TXrm+bSUXtHX8iWOorDPI+uGerhm+Lu3Sp0H18kvqfbd4kg1OIR3BPAMmjYb+maH1kfjJNzn6CYV+me2sjx/MxmdP7mJyLLn9fNRVUt/c5Wf7kj5V/PjJTOT7kj7ZG/uocUju3TSUzG3VOqj4jrtJ35HfJ6fvbD5Z37J2226cA/iuGulFo30AKzw9lryVimqLzzyf9739+NUPjyU3M1Gqdl2MEqmu//1H3qh/yDgkfGvU+xG6let/9+Gwj9OtvNBDgneLOdFRYaiVoX8PYx7s24To30BYX924CW2VXq67b83zeXqmQD90sp74hqx/t9DtqHaCKOzT8dLfCjXZWGfWp610xrQHbhceAc/nIwOuOZz9QZcwjj2zC+Zxh16g1ehEbTnXv1GFhgl6Cney9TmhCNblfUDVzvOcX1g1C4qYdbS20qb+2bfxGYm+RUbvBH1yni30hJ9Un3Tb8VyD0RP8T4Sd9T9/ftBnNc4J/qz9KvH81FAK9jJTz698ciz56nNRCl39bJhX20KHfgGob1GBhB86eukT9Lrkudib5hV1IDvw9oJvhQYyjSV60i+rItan3FXol3/HDWBQzBl5uaYSZX/gSHpF3M9rhIOmTD/uHuoUzyfsO8XzXGQcf/juO2x7T++8n8kHWuu5/mfw+38AAAAAAAAAAIDB/f8AAAAAAAAAAADA9T8AAAAAAAAAAACY977/v9jULYY+AAAAAAAAAAAMyxu52NTd7dTORG/qwlsro6O2r5p6fnlRFArL80vLC/PiQm5ZrC/kxIJQE3M5IZevFxZIbWFxvjCzJBTmZ+YbtcLMMskvzNQXcwvUVVKtQKWte/YvGx5WDL+JhZpYII3Z2hJZWpxfWswXloU5cb5eE0WxsCSIC3UiNMRFYXkxP5enwd/narTAxUaOPgmikF9ayAnLjVqtkG8sC3nSWKRas4VZUWgUaktLy/OFnOXB5SvTVtGl+vSV6aGCyk9np80bzg2VYXuBapleZKhnywp1sS21yCvmLezTV74ybd3NblocpvnUnOVecd1xkTN9JZ+dtu/eL2rTV+bmcnMFXVB3kEst656bqaLuYL1J3+52tJnFGeokQtHbZDrDoG49uEaDut+g+S3hod5Wao76G69KRJm+0u42m9lp3fny9JWG0FRJdtp2/vGK3JTEA6omt2csxzuG1X2JPLhFS9RbRp0v8GaKXn/d0bLR905HTLsu3qkA9XDe6VL3F9sqzdKULi2s0+xS35WrQkeoSdSfw4GdbnmCLnY66vSV1+5+7WtML0Ef+vf/scTvMvQBAAAAAAAAAACAJ4jnRu9ODPuhi3n9/3sMfQAAAAAAAAAAAOAJIzW6PTHMz0rg/x8AAAAAAAAAAGDg/w8AAAAAAAAAAADM+8H/H67/AQAAAAAAAAAABt//AwAAAAAAAAAAANf/AAAAAAAAAAAAYPD7fwAAAAAAAAAAADD4/h8AAAAAAAAAAADMu/v9/+QIYUZ+cYSc+8zkH05sxD81dufMvxvNjfz+yG8wf435PP0HwDvh6g+NJTczMUZq18lD9X5T0ggvdDXZeM9rXaXNq91WS1AkovKz/vefvnrhBMp5//sf3rw0lhRXopRbXU3QJLnNk0aDiBpP9qU6aYuEz0flfPZo9UfiyZWV2Juf1IRak0TJRaVfWq1wxSrHVovXNzg2SopNT7KsoGmk1dF4qc5WudtV9pVK6Vaxcoe9yd1hK9wNrsKVV7kt14Ylr6aleiZL9e/RNpqa5U36f3tjg119mVu9mW6S9q62l9bzM+x1rrrDcWU2zxbLa+xyzlB1+uF1VW4PsrFa3Kqm/dLFLfb6xub1jGt61jA9uzibn5/3m69Lu0TVBhUQEM2wK+yiaUQhoqzUSZ22my2Vq9w6Vwna8IpcW2FzmckMu1WtlFarh1+ajl8opMYf3dMUaXeXKPe7pEt4TRHaqmT05m5XUOpmKmlr+lyyR65SWtfLCtegjb6xWeHY7VfWdOHNG6xKh4ewm2XWZ2xy52XaM3p99aFOb26sXTYFV9hUh7TrUns3ZXRbmduxckplNp2qS2pH0MQ9PT+bEgXaNc0mqadod29W+ix5pcOsCZ1OU6La2VRDkJrGC6FVk3a7clelJiczk9e5dSq5xW1wq1W2Uixtceni9c1KNcumJFrwrtA028W6HZHKXGW58lrv2sV48tZM7DBhrLU6Ue9pcodXH0i0QvwuaRPFnLfdtkRN+POJ+iNWd2+XS69uc7S6a9xt9jgjtANoRwdNpfvEMyztfjpKfRlsacuZRI+eZ42V/tZ9Y6UHyqabyJ6sSNpBVPpnfCs9SsoYfpWOT5NoevHWRPaudXMuuzIrbN5YAGJXUehs8tU+fB2ESBrLwWsluNscu8PQBdgkgkpX16AKrHE3itsbVTbnLMl+Jb0uxuwMy3xhJaShRs1Ng/QFnfUhLbSNhjRQH2RaOWvJhKtfG6xutS9D9d1d5ejpT8cvvPj8+Bur1q7i9Fxwm+jr0sDmEqk4YH/pszlwj1FIR1Doig/bFqyjEU1RNGNTOG6fCSicYqsxrXqNOvrD7UJ26/s3ohd/eCy5NRN1ChDcLPh8MOXiN77wTDw5MxP7qd2QjYCowffsgIVPcx/HoV2Vuwo9JnYUuUH7MmzNWlmOBh2ZXaL1aTjrdICqVVj/KvfYHbAF6FKdPbqsQw/zZo4xQ5wpmU3d70re6We8FeV2Q1JaRkJT6LbpLupK7BNFahx4Eo6Zbnql6pKw25ZVTRKp7bpZPT2926nTWTfovMIjYZ5WZMOOJJautX2HHml0k5uVEOVr+u7Mvk57vi00ebtnorfXvFVMiAabzmXzGY8170mXX8vK8dTMOgvzC9gnYWyt267TySTWeTqKe2YHOnNTqge7wJPhabubajaaPOzQvUTvXVGUu3TnvUcOLNPmsNOsfuP+LE8DvOlmAc484BuK3OI9c9M0FZrvMRme/5hncMY4wIoyTT6ge5RQb0pt4p2S7hluv4hb19B8Y87axyz9+j+W+H8Y+gAAAAAAAAAAAMD7jjOxM8w4fv8PAAAAAAAAAAAwH4zf/8emRIY+AAAAAAAAAAC8M974VGz8burtYm9q1L7xo55fXhSFwvL80vLCvLiQWxbrCzmxINTEXE7I5esqUVV6H8Bl4+fgX5nWb9WcvjLtS53OTtM7NV6nv5Uv6Xn6a35pOScU6vROy8WF3LwgzC0vLc7O53ONGimQXH4uR3VEeltEW7tFLQm7RNdsd5vN7HTLTFgzfuBvJyr05/dSi7xi3hAyfeUr09a9IUaJ9Pf5Gl+oiQXSmK0tkaXF+aXFfGFZmBPn6zVRFAtLgrhg1lKk1teduxumr+Sz03JNJco+qRdpaXNzubmCLkhUQt9O70m7e1SxRe/KaNK3ux1tZnFGUOmdPTRVobeIyW16NxzXaMiKLt4SHtJ03ZwkkqpEFLv+DUFvS0NoqiQ7Te8IUeR9ofmK3JTEA6omt2cUQm8aVDXD6r5EHtyiJeoto3cH8WaKXn96H5dkdLzTEdNXHsjKPXpvpUj0LpVbna5GlG2VZmlKlxbWaXZ3pfaq0BFqEr3h6MBOJ23jDqJip6NOX3nt7td05Tb9gb5qdEyRltsyXnk1p/cU4bLgZPHm3SeX9/PTX6vR8RZIbbZQmF+ary8s5+eXCmJjdjY/u5iri42lwvzC/GyukM83cosLs0ukvlCnM642Pzefn8/XG4tMLzFp/P7/dxn6AAAAAAAAAAAAwBPEc6N3J4b9pMm8//9XGfoAAAAAAAAAAADAD5xq7MzdnRP9goTPNwqLucXCIqnPivO5+bna7HyjIdZyC2S20WjkBHz/DwAAAAAAAAAAMB+E7//N6//vMvQBAAAAAAAAAACAJ4v06M7EUD8BmDLc/xeZ8//l+dZ59qkPn/utyX888dvjvx//N/H4GDu6O/qRkZuxG1QgisORhfgFsTh+aIfSDoQ6pk4d5GZX91yg8lJLD2lKPSDQeIQ0mDGJFg3Ewz2BzUkrQu4ajRarR8gtD1AeFFjW0rKCc7KuFiuprFOoFWP2cGT+FJ1gxRF9rJ1g2pwMhAn+vnRCb20unhSLsd79sIjfru5xwb+9lXt+iDDggyyHRQT32g+JDb41O5bcLQ4XL9g3CPnovMtvLObjyWIx9o0HYcHEPZLROTODAop75E4SYbgvVLqrZ8b+jQxrGwiJGxHClprwjI7uxiY0CnBQxoimaiTu64FgnVi+TlJb1pzk6Gi+wWKCMusbm9fZ1GvFmS/cfdYMWm3Fuw0IZmjU7eoOR4Np5w2pZbNlpgsbc7Z5g+oGSrVs9kvbcXSNThKJRLv9deraZpCR1eJWNe0TLm6x12kzMm4dZ406UidA+fl5dwT2B0Y09oqYIY3t+LC9ei5+YWdh/HA9GNN80CYcJhQV4vxkm3mY2qAdzIkLfszeVX/+RM00t9l33syo7frdamb7cvzCa4Xxwy2rmZZLKTPusBNnvG8cwsUCTR3SVv+YhisOaq6lwRoabI3uGdQhVHiDZ07YYHNEHk+Do0b33WzwQTZ+gV8ZPxSCE5k0GtRZGE/dWtVJm4bcjlyzAcGoCX2cvQFrN6A61MQ2dVhbJ7ztz5247YGF/I7bfuyCfpfavv7sWPK1haizltBdKB+Wmn30VCaeXFiIvXXVMB8mE5b2nO/sJEziJOcljr69NtLWCcmpzyZ052+k7TmX0BNodyr6IqR9pUdKb4vUu5ueJ9SEdl1uOycXzjgPdXz2Sw91gA4e/Z3o7m66N6j98ScDL6x4CxCp0zxt4AmAR8J//L+ZHkvyhah5FbEDzoanZ26mTmEsH56ePlz9bDxZKMQeXTQmarhUeGrKN1nDZR7LdLVNS8GZal3PWCfPrpR5Smpcub+WmykIM43Aqakrq58+zi290/GdQvw/AAAAAAAAAADgfc8krv8BAAAAAAAAAID3Pfj+HwAAAAAAAAAAYPD9PwAAAAAAAAAAAHD9DwAAAAAAAAAAgPc8U2c36WcA15izO7G/fubPzvwN5lri7PnJp37iqdXJF8792/E/O/dvB2kf1q9Q97or44+uBtzrKt22JrUIT71sNqhTTd3L456sSNoBv9sVlHqEWJSD3WOs2d5WS+UtrlL1OtgN2p/ceZk64NR9I3K3S1vVLd3Ho+V6Nc/eqGzesjVVVqVZVJqaVS9L9ZUyt3PZ46dR98ioXrbrY+W7byczg/y6WrViLXm7TNZpFtuS1JZAHapbzl3fPLsUT66sxL71jM/VZbB1Uen5UHeXQSnD4WWkw0qPt0u7i1yfrPuSOsA3vJNvu4RX5a5C3aNGOnD15hvOW30eOql/Vq2ruG+ol/8usd5lvPal+iBXrY5Q0Lv7bM6spTua0V1h953dFfS9qPvuPN5hfoik4ZjTdSw/0J+nV8TRs2s8lJdan/BwTmplGtZisBd5V8SplMdlqsd5adaZNYaQ6Q7VO/BZdxRdZ6WbhbGkuHKc/9jgxHbd0QZz5jaXT2UwH5UzO77FjOsb4xsHi/ELN2fGv3U2PCCIpghtVTJjVuhbWDAQw+DQH0FtNuBu+gbb2RNU0h/6wrsD6ss9vbmxdtmUXWGpS2TSERTq9dgYe2NHM7IsB8pWpr7iJM1ccMbbptBt00q5CQ3B9qPcqkm7Xbmr0oVJHRf3FegzFFZooCTjLfXT3JCU1vAFuAqRRXht9jXnuEICCmGF9NncJ4rUODhBIQGFsEL6bTrOrvute407dgYftqRmk+wKTTYQFMadjNbRigYU/pc4sfoA8OjMi8ZpyVsXjNMS80Bs+bf3OH6PSl/0nZZESRn7lJl5jBdunwXbCXvaVn3M7uPhIt45KpeujSXvLkUdRENHhc+HJi8cHqzEk0tLsTc+3D+jbKHQxPnoueRETTjpRGrTQ7d7avcuD7CjcHwkoYCoP4zQic/R3Eg/D18wo2fwg6/loqPDnO5q7iQRYvqu54YImRK82goLHPLw6omb7o8T886bflysmHep6fr9/7HzFxj6AAAAAAAAAADwweSoFju3M5G6uzMx+kZ+dKho8r4v6uzgefX88qIoFJbnl5YX5sWF3LJYX8iJBaEm5nJCLl8XRPopTaEmFkhjtrZElhbnlxbzhWVhTpyv10RRLCwJ4gLTS3xl2rqOLdWnr0wPpTWdnba+aFt3vmebvpLPTtvfnxW16Stzc7m5gi5Ir+bp2+k9aXePKrZo5Ocmfbvb0WYWZwSVfs5NU+mHYPQTHRp8lWs0ZEUXbwkPabpuThJJVSLK9JV2t9nMTjeozvSVhtBUSXaafnJIP0IUmq/ITUk8oGpye0bRP8uiMrrVfYk8uEVL1FtGPzvjzRS9/jSMqWT06itm66nElQeyck/tCCKhAqLc6nQ1omyrNEtTurSwTrO7K7VXhY5Qk+jHcQd2OmkbwceLnY46feW1u1+jnar//j+W+B8Y+gAAAAAAAAAAAMATRebMzsTEUJ/YmNf//w1DHwAAAAAAAAAAAHhPUziTujtxqh9fIP4fAAAAAAAAAADAwP8/AAAAAAAAAAAAnnjw/T8AAAAAAAAAAMDg+38AAAAAAAAAAAA88UyNPc2ci/0cM/Gvxv9s/MPxj49diP3c2b9z9u7Uzz71588dnVue/OPJP0Yv/WB46xoXT66vx779FSNio+3fQesq/eEgB2YWfNFRB4oaUVLdOO2BOKSeIKmWjBMf1bAm1QcFLrVE3CioeTMKas6MFO+J/h5qxZtvBOU17BneLozY4HrQVvNdxmtvcJ3cKPMRtbI6ZmBf2J1n94UVc4TfdYKORIVjDZE0orLqVuwYJQOiuXpFHD27xkMFqvUJDxGn1pY/PkytX/IdRqnV9TzRetPuDM3aM8+Q2S6XXt3mvFMl684DQ0IPr1paL5tWwsWoFBsy1fvWSqS+HVL3zvpYsrUeFRl54DrkZwdmX71z4/Sm8wOzr0y+wIzr20/v4Zo/Km5UiO6+AL5RgoGouEPb6w8IHKU6KCquocOaOp5I4OEBgVdP3HQzgO/ja3pUQOB3u+mvX49fuLM0frgZ1nQn9vTAIbelBjU60tIxg23rDd1cJ/53aGOLJ2tsyCCfsrFDDe9jbezmS2NJcWWoOO3eGZmPylminqPXcZb2jjmc+Fz8grQ+ftgKRB8P372joq+HSkfEIR/OcnQc9lD9QZNUVxgmHPnhROl0feEPx/44++K4wOzvWl88qr0cv0DWx9/+zBB9oa/kPVmhwd743a6g1B9XTwTt2v1QKm9xlerx/bDzMj2L1M/uuNulreqWfnVhdUqevVHZvBV5csV2qCjVpmV1Lruneytlbsfz1jhV009RqYx7MmYKue/7pSSfjM+Oe8JviLhv/TKB03ZbNpDs0fGcqxvCnvchpevn477y9YTJzInnldlC1hlFlgYTbAmauGdNMvz+HwAAAAAAAAAAYPD7fwAAAAAAAAAAAOD6HwAAAAAAAAAAAMyT4P8/lvglhj4AAAAAAAAAAADwA+QLsXM72xMT4+PjzOio7vuAzzcKi7nFwiKpz4rzufm52ux8oyHWcgtkttFo5IT5eo7M1nKLM2JdmJ+Zry0szwizjcJMQVxabpBZYaFWzzO9BH1MGtf/32XoAwAAAAAAAAAAAE8W6dGdiaE+KTCv/3+NoQ8AAAAAAAAAAAC8Z7h1hv4Y4LH9CkD//f9k7Dpzjpz71OR/F7s++VOTT02sxn967KUz/xv6ehjeulSOJzOZ2E+c9UXpI/ukran+dy+FxuEz8wYG3jPC2WkKEVo86cjiXkiuHpRID/wTEVHNyfdHuSvkckv5QmF2YX5pPlco5N9RgDZBFGUafuKkofL0kEXKcLHy+kS9Qe/MTFFut2mgIm8vBtT9EqUts4zNCusGrgsR1APYzS0aZRkDFh1eT8/g94WmVE+7khmPZu2ARqqJaqURC8Qrt8J64/V5ynai9TnhQ7xq/gh+iwsLc4tULpPVe+p1q1X7NKZMaIevcTeK2xt6jBan7/p12HQ+O5sZGJrPnnX9kfe8Qp6JHRl7z2yaKapGq+sBaaxwRbS7VotrnBOM73CrGr9wKzP+6GognI65/nhr9krt3UBgJTM/ImZOlPJk8UaVivWHTjIVzDguesBCM55QaDONWDlVuhw1QWrTtWYUseJ/O5PPGl3GumLG+K/4385sbqxd9kwPJ7aOJ7KOLuLZgPRp4+1bM9+TcHVSD9i0tTVsr0ptGvBGO2WvmspWr/YHH3rMvfrccL36nB6g55he9ccr6u9VIz/Yq0fPVmhcusz4G3cH9mpU0KcT9O3w8Z2sLh42oJPKquznNuku4QZ00q11LtM+Uf1Rlaw+uxwd3UkNRmVyDzVDRWUKHjcGB1KyKmBup/ZRLTqEUu/Gq/ELNzPjh58JH6yoIGXDjNLwYci8K2CYZoVFQxx9JZ7MZ2K9ghkiMDBhdgM1v25VvVRe426z/dJ0ZPrq59u5PScRnkPF1c2x5GbmuMimVjF5//ti6dZY8u7SUMr2fuBGWvUlXyttnNxUPjR55RufuBlPLi3F/sJm/ymiLRSa+EL0CaMtEnre6DkeR8Vs7j9SDj7J9J6e2LGTfUde/fTIXbDdGs31SWQL2bwulZpJDRTLzw8pN6S9WZ8940ykTR7S/jvmjNkvNMRpc6Mpy8qxZgNSfru+Mv1BoLU9Re7u7h1r3+iLaC27vFxoO5yOjDawEui9GTZvd6v/GBp96eCTcs7g/YfWY7VNKa82XRT6GtgVOjRKqeCcnTt6/fmec//w/DJr9mfKzTZqTeONuyl0q/O9N2pmzDWjZiI1pg28mPJIOO0xt/tBWh4JquXa8MXBjjzNts+KEf8PAAAAAAAAAABg4P8fAAAAAAAAAAAAuP4HAAAAAAAAAAAA8yTE/8P1PwAAAAAAAAAAwOD7fwAAAAAAAAAAADBP+vf/Z5l7DHMv8bfO/xdTf/epX3/XivpOedvwgvo3rxpeUB23vFJbo255De/iamjiqs8LaqiI4aex0601JTHUCarpMtF28G7LeXy6Bz2oRnhNtVzNW66IT+TmPuCaeICX+6Ck4xQyxLd9QNtqYZTnekX32qnqbpN57aBDQk0EZXQnmKl2t1UjCnVzSb1IUnfcqUzQnCngNKrPlJ3v9bgZzLR9k84E3ZIOClXgVpa6JfV7/PRn9Tv6D0hkAs5YF/KzRhktQh0/D+xuUyJK3y6mLlEPytogO35JfdwW5w0T1AsrEeqBgAZuYn/TnLyoSmldJRggwU4KsWbmRNminpFbAVt2Ur8tKyfKltDR17fQDNjzJvfb9ORG2b1H3TaHdr2R4Tp6FeVWS2hTP6qWSTrljcUu7gntXeJN7hCFOgI3Ng1Palc1dqZOV/cR2xI7PKFbjaQZC9n1CavShPDVZ+a49emQdl1fcLqDWbVDdyHCdxTSERRS96Y9oI7Jqf9ZM0lu7hu5dSI2dV+59KUoUF+9TeMlediRHG252TV2iW77Xlt+4KmhQvYldcA25eRfs/amWlMWaV/uRil48tl0jrpkNrTqktppCgdDBdPwymaMwfUGxvBZckJjhIXBsNpn9Zx3VdpN82eFbRw+Cc9CdXJoL9MNmDrk7evIQCEhgt49MlLqmuP42NgzjonW4pE5tYthrxVzD9FXQJsuO48Fayvx5rjN8Sb3GWTrdMfS52toheyIJH2HBrNAj+61FV9z9WH35L6w0n8cYfUzibbuiN6poGeBWhtahIindZEi+gF06GVJ1wVrC1NX0oGJ6ST7J4mTTN2c6z7qzXlDjenD5PELHjy4r9gHdqObwg/X9ggEJLzHVDNqy2YlogzrnGFAGYPsW+VnbC/j3uYYHbzibJKWjfDl68uLXHX+phj2LwYKSFuhQUI3Cn9vDSzN0zCzTDZ8vgy7d5uGMtEdZVo+4RHF3GlDFnRIT51wqoe3IrQ87yRwfJf3fuxOPLm+FDs6Z8RkCL0w4K3mhma+7ItgMVDfDGYRKpJ2Lwiy/WfvWe9ulHUvPdy4J6cfmt6D2/Hk9lLsUB7QAebq461qhMqsW/1geo0f2B1+a6fvFd8VSjZ4Ju50TtRe0vvKTjy5Q1veHdByusEQhfb2oKbfGL7pAXPvQtvNHXFA663duvT5QaFJwmufD01ew/f/AAAAAAAAAAAAg9//AwAAAAAAAAAAANf/AAAAAAAAAAAAwPU/AAAAAAAAAAAAmPeC/7+nYt9iEq9OffpcdfzfjH87/vrY+tnCmT+KfevML4z+CXro+8ajGokn5+Zib98z/CN2VYE6HOvIzSbfEKRml7r/CEna9PlGDBEwPSOe0GWh7tlijdvgqGHqXGu1uMYZXsvkriIS/jjXYEExx+GUXKPO0fYHepzyijh61JWd7gVMlOtRHgvdfMOPiiCKcret8WZ3GJ7w9O6wvCvZuQ3qSIQoHepPxHT/Zfnh8frNMQiT97hf8kiyjkO6fpXMyuK8V1L3chNmWW/bOvVdxqaefe2LwkwjN1O4+2zK1bTdBZk+fjw+Lr1OR4JD5fGZc3k3nizOxXqm45SQCUOVRNLWQnIqPnc50aqmZ5SQfF8VvUO9xm2t9lXaSM1wjbHknbkoXydhlciHJL6yWR9LiiuDzdgF6xl7MnWyc2Db6s8pH54T48mVldhRxrNa++Wi0m+FrNt+qdDF6/VreqL126audY5dvX4h231eLtwFpzOtDtla/IJ8a/woQf3z7BqTud/bDK8pQluVTH80UqvVNXqOr1O3UBo5TsHur0ppXa/1ie1PXudubFKfOla3RLju8ZqgGut0O9miCqvUIWyxtMWli9c3K9Usdcto6bIeXdbVZSWVdSqQylxlufLaISucuotMR3zvXheZ9u0u2n5lrfgD6SL+S2NJ9dZJ/Br52pM/TmLjkcjHk7duxd4uRLog9sofl3/zWMfEXukwH8URB+Iwl1Ku0+LQxX1ih51Pgg/Sd8lHpygr9WMcZroizmmI71hrj0aW7T/GHr18N36htTT+xoMBK13lxa6i0KOlxzOY3a3hXrCPX92DbAYX9w1rAkT5MJukLsjKbJnbuWw5Wewfe+OYoPccd7u0Vd3SZ4u1E+TZG5XNW84hie04Ls06l6X6yubG2mX3qDZpnw51Lvc7S7NlA8keHdtHo0Jasj7nJjMn3pU8vrbprkQNOjvSo+dfi1/YWRp/67WBQ+meMOx2BaV++vELGLIHrVTe4irV48bqFCOhj++wI2HJnmAk7Cz7FNmYTa6jdWvRuv4v3dqb+Ntg+2FnVUfA8qBot8RjWy9W9TQtrKX2yXTmFFPGPUWjTqBbgibuWTOml/2C4ZSytzvIJ6NZ0dDM0hBOKS39QS4I3b7weaA0T7Xdg8kUvv8HAAAAAAAAAAAY/P4fAAAAAAAAAAAAzPvg9/+xxH/P0AcAAAAAAAAAAACeJDKx0Z0YvblY4ws1sUAas7UlsrQ4v7SYLywLc+J8vSaKYmFJEBdGJo3r/+8y9AEAAAAAAAAAAIAni/TozsRQHwDg/n8AAAAAAAAAAIDB/f8AAAAAAAAAAABg3g/3/yeYF5nz5Km/de7z52KTNyZujf/d8YvxubP/55nvjv4vI78ak5gXJ38mQv0wtR+/8OrK+NFNKz4GjTTQJTQ+AX2m0V488SxaclvW5LYkRkkE4mMcb6g/ookRu8pW0UMjRBlxg5v4VF7Qg434UgbFhTCMs05xbkQIGuiGVpEGhtmlMVNUO/zTtW78AqE9RY7rKZXG2qERq/TYDXZ8pHfaZyEmQ+LB2ELD9ZwrrsfxoLFH9M5zEk/Vca7JsPhZS1r8wjbtwN3jOlCiUWoUjZdp6jvtOI+p/lgsg/vICmbij2ESpWJHMrE7YCWfOVUPCk092uEBSx5KqmZPvV5HNRbp4d3jeq4tW9HS3mm/OYb6w65F9to7WGo1wprF1e3J8kklfuFWavyo5GsyaQdKD6wwGjpJkYga2spo3f6lFJR1222V4C6jPlHPagrmHd9FlobbVWELaeU+nQ6p8UdToX1DQ8m0tdBlNEzvhGlHrRxfX0RFLvKL2iF/rIA+NNAPDRsU7KaVsH6dzAzfe3YjIpbTvU78ws3U+KE8eG7pYXf0KGenmFq26lA9FzmL9NhKJ58xdtl2az8px5OFVKzHG/GMzGKsiHBOcb5a3fYFMApXMCMX+dS8EYuCzcnY+6MZiswOSNebatNYS7RuBU/d+jqz25boK19ZO1YVt8ulV7f9NY1QD6twXy17+y0jJujh1wcetaPSP+8LJxh5qNDXiOfga0Ww80YFtcL4eQ4mTvhPd4IMCP/pCNnhP/PHhP/sLTfjyc1irNfyRJUVm3K3TkNLNmUaf5fG/qPV9weXDRPYDokxO8CQN9RsmNigoLhmfNmte2PJ3eLgwLChFchH51UPf/R1GmW3GHu06gkOGyYZnbMVEiA2TO49FN9ZHxJp/7jAio5IeGDFYYIYH81I8QsCDbB4a2BUvpbY4btK0wylNyCG6nCh+cKs9R/579F5k61LaqcpHPCvq+bJ9DEBFnWdlZRun9CobJJmxNVLOZHzdCs8XZa6YlqX95rPpn7kcosGvk5lVlK0dnrMPXpEXN0sbtDJzaUNXe2gQ0IVdYVMNtXuNukzDdxnvBh8oLy1+gq7XdnwxcKzTsKInsTWu4o+5c2t2jqGHH1izxyvz5xgvMwTiMc1Xqa1k8VT/CAMDb7/BwAAAAAAAAAAmA/E9/+4/gcAAAAAAAAAABjc/w8AAAAAAAAAAABc/wMAAAAAAAAAAIB5r//+P5b4HkMfAAAAAAAAAAAAeP8xGhtlJvD9PwAAAAAAAAAAwOD3/wAAAAAAAAAAAHjimYpPMnHmOnN+9qnNc79w9ndHf5b5Dn1L/8Vvxm8OY2GrxwyKoOoEWGzKu1LbCWNL4+fy+ei8H32T+boRQfVb54wIqtGS0Tmv+SKoRssZkRwFTSOtjuZEUPWG0/UEUdUjaeuBFXlL3oimmj1FBFZLR6Qxj/ld0qYBG7UBIVdDJK9ZwVPN5vQVa+o1SXtX20vbMplAQN+F/KxhwwgIGWrAzKERJ9MpPaLkPkllUyrRtKYeH9rUNd61aIRJ04Cl56Zakaj12JfeVN0kjU4pEt0UDXQpa3xD7rb116q02yZ6yE762hk2GiBTlNttImpO0TSYrKzUj4s364g48WbN2K2D1DwSVMtjxNA3ZdJWMGqrX4wO7W92Rm+3LWr3XJisVYGMG+X20eKPxS/cXRp/SxwYNVV/06Yxm/UizGCnp4+Z2m+rP8KtkZk1JPU+odo06LPQNJUGh1SlfWcEO/XMKoWuYJpNI4QrpCMoxlxw0h7QBUqLSWWMDjMCvkcUa/e2GWNVX9D0xcbaZavj+ywaArZRf3Xk5r5RizoRm1LbeOmZp+RhxwyOHmbBHEa93Ih6UqWBIVztrvPFcLVNWMuUrgIab7YuiZrK2p3GmgNnxXQ9nPtq/AK/NH702jATx4yM+5hmjtfYiYPtDhpca3kM7DwzKjwb2olWINw9YZ+4HerrNYY58zM4HwAAvIfoPXcQT764FOu1jPPp8N233g0PbP8Fa+8ulde422ykrn7UjNid03Ui1PXjID35yXa6NRoFXT+RpBp026abu3WAtfbe1NGXHsYvqEvjb14ceOjp6Duwquon0vtCs2uda/DmadfpD0IDzfafyejB3bPewOtDB4T3FCR0dA2haZ7UcbdLW9Ut/fzDOkTl2RuVzVtWoHhB3EsfGzJeIfe7RDXPcp1udoPFGw3T5YwX9NTIe3QcfHLhVJo1dNXw6PDeo6ZVN1/E+KObD4whfuPBaYbYPEF47ENsmj3xGQdGE9//AwAAAAAAAAAAzAfC/x+u/wEAAAAAAAAAAAb3/wMAAAAAAAAAAOCJZurch5hzo19lJq9PfCj+E2PjZ88mSuffmPryU7XRr577zsgfo4cAeHc4Otv7cDy5vh57Y8JwckHvFKI3NLWoowdhl/CqqHRrjp+Kg4GZdZ+ri4Gixs3xKr1Xr0k0j8MJr78Ly4WDLbOSt7wt3O/qt74P9LbgijjeFqxEld6vJXa7rWN0PWJsOpfNm54eBnnIWONuFLc39HuzTEMeWb+3i0Iut5QvFGYX5pfmc4VC3vW00Pt67yy9Y744figF72nzews54KWW7gKEDhZfpx4BtAGOSaJuZzvOon0T2xq960u/T7E8wHXJUL4EDC3WnQCSytLb3OgNmzNyu3lg39U30jsTv7BdHH90cFwXhHmaOHXrh3A14XGUMbgzzNv66LzQp7jH+4PXQ4fjrSHgjcMQ73da4qiEOusYfIee1GySXeplIDAQHlP0tsG2KulT1fbc8GO9UWMiPto9bhTcaf64hiJosX88QtzQDDEizkhcdIeCOulwRqI/ub+ciyu6lf705/KnGAFP9ftH4HJvJH5BLI4frR67FdTpGPpW8GPYDPps9o+C66oo63odyto+frJelzePa/Owq6XvHU7NrB7rfa4XiydfK8YOz/rvUA+2zRxk3qpzdL2+aHXWdrn06nbfveuDrQbuZO+znXZ7LOO/g92agvSw/PZ74dygd6P3Q/HknVTs8JNGr5rHdDoKiu45y39spzf+1iX9FnfVJ9Xw3fw/nAGz/3yyae/t/pYeXbKvGUJ2Aj3Kt2TqN4cVGvrdx+4edzd1+NHeU/Hk7lLsKDnAg0FTUjV6wsFbjgR4lRj3NocKi0N4NYiwN8jTgSViriHrrm19Ea1xW6uu6wO2uLUacH9gug6yXSBkh/RpdBjvnYsnyVLs8Osn6JfdplwTmqGytVN0i2luUK98P7qi91JvMp7coU4uhumKQVNDOEEfPN4p0ZvrTcST27QNu0O0YcAwfukETXgMw8fg+38AAAAAAAAAAOD9ztTYLHOWyTGJz03966lfnLpNX9r/ngmT/9aP9VLx5NWrsZ952vgQ+IGs3OMV+sWVQD/Q0eRWTaXfGBI1Irnt+54yQsj4+sbIC3PG73Nsb0m5fu0XjW9slu1vHk3T9FORVkemnzSJB/w9chBwdG99zOyzG6GZWZlb9Fm2Pl2hzul36dMgF/zhGpmVxXmjxhEGdVvrG5vX2dSzr30xN1MQZhp3n00ZVaDOyXWH2wpphJce1qw+Haf8fmuDipbpFwzUgbYmK7z7Cdmg1odrRAyb4/1b984ZatUvYXzkqM+Ey6Lc6uhfodIPGY33DUFq2q9NH+5W5ADHwPADGKHi9GCUyQH92LDk9yV1QOwHv9S1nEd1j/rm5fcEdW9QxQOiToWDJgZUVI+9IBjfKYk0RIOmms5yw8o0PJtSf6RSPR2qZHryt2q2WtyqhovRjybZ67QumcwLK/S7+sVALcyvuNQhRi1Kx+mFSKMDusNarIN/CeGIXFuxdyPd2bw+87v023eFr+nRLgaaCJe/tuIxbllWu01tqEHxiPYPhdeOZwAWFxbotuf8WIJh4p/FcRMAAAAIY7332bHkawtRUdGMC5dOV9klnp+yzIalttZ7l05sKR+W2jz8Qu9H4smFhdijHffaLSAUlnav/6otIHHqH5X6LvMGXrsMvtQ7+SVe1KWdqJBjgoO5Evqpnfsj0tneZ+LJixdjh8+7vSs2ZfGe+0rq70kj/eT9x66weSf+m0hP5DWpRaJq7JMxfpjr1Brf/wMAAAAAAAAAAAz8/wEAAAAAAAAAAADX/wAAAAAAAAAAAMD1PwAAAAAAAAAAAH7gTOH6HwAAAAAAAAAA+EBc/59jvsdMffUpcfKfTvxf47mxf3/2zhkp9s9ir9Pk9zPNo4Wx5NfvjEQ41rT91OvRbg033K57TYXUqAwNVT5X4GeHk4t9qnk0/xiKyw9Z3CffeOpojgaQvTPy9n3DHeVwekNa/4TPj+VwSoaPSzd2ccBFZ4W7QYOIlle5LdY1YwobEWh1V5du7N5oZUvGq2MGMg5zjO5kGiEERJmOAw0XIDaFbl2PIVCnPvfbVsSAhiK3+EFh6C1n/QExw9mmEXFAHkLbL7TSV+hzls9Pb4jnSO/xrohTCY8/0XR4FGm7R7K+qhjKphPV4/QCVfa4R20ezcYvbBXGD3eswNq6JdPBPWnRQA18R6ZxSQ/4OtFDOJghyMNFAsG0h7BjB9Feo7Gu9SDa5QilQSGxHQ3W0GBNDZbGlWjLGlsjrFlg3QqLfTR9lDfa+8bq4PZ2O3rk5XfeXq+dYNDwyPYaAdqNSOyOY9mLK2bEdjtBjy5rhmXfJ4oRqMKSsN66+R7XuZaIm+JKOfEuLBnnPZ3drpTZGsPWC4aYmzAw4nvbiHPARgxWf7j3maOcMUpHdwaPkkQDFivaOx8lrx17lErlLa5SPW6UuNulrepW2mp2nr1R2bwVoWBHZPY4Wz7FzBaadPTqByx5SKMNq/a0Lh49H08WCiNvXjAOK+EVCE+NJX2HjYi6n94Vsj0/I7ZEO9sWJ229AfUocTebTeey+Yy18w4O1uLk216q84aX6kIut5QvFGYX5pdoOJNC/sSept093LMwIrQ8ElTLteHZi28fXY5fuJkfP3zRmvV0C5Ma1Ee0MRx7cldRfftnf3Zgth+j37//9isMmqFeadaQjt53zx/NGG1747notnn3ytO0bfBeG9K29+s+GzIw/Xvsx46yxogcFaJHxLsvnmZEBu+rUSMSuqf2C59wPw3plNC99A3m6Ll4Mp8f+UbG2Ev7C+5PiX3Mt4eG1PX7tn8+zr1Q1QQ6ejSAVleL9GLvk7Ft5gyb+fm5grWn14+x4pHot2G88EjQpeMt1TyTp070+S/TQHWD4k4Z8ZRcSSeaUqAvZhcWfsCHAvz+HwAAAAAAAAAAYD4Q9//HEr/P0AcAAAAAAAAAAACeTNjR9Qn1oK3tEU0S9d9MyW36a5Em/aWD0Ok0JVI3r///kKEPAAAAAAAAAAAAPLE8M1r0fASwR+8/obdm088AzDsbpozr/+8xie+hpwAAAAAAAAAAgPcho7FRZnwqfoEZG3uOGftHY18Zey6xc16ZfO38jfOfYhjjv/MKAADAB5ZbvWfHksLVWIQD0weyco/6+6Qu4VTCa3KrRj9obhOVn4vIuH+rlzmNvdmIjM6tXvo09vIRGTI9Qr6EUQfgdLz9dG8mnkwmYz951nBvpq8z1fij+nyYGUmG2zLbsW+/szLLrRZ16ut40Fo0PGgtm66wRPpb1rZGV3Ej4JXL9Fob4pzLoxHtnWvRNC5TV7pSW6BfnDlumgf5ILZkHB/Ecu11ImrS/vEew1zJqDrlF+eW5y3PxtSns8aLcpt63BNDXICtcTeK2xu6Wzvb23FQgU3ns7MZ2wGbFl4/M8fwkCwYddNdJAttkVCPndRVGvUiRxMahgNP560otzqmU0Yzy3hhKumvT+hL03F4pmrUg1mLJx1Z3BvUl165DPVXN2eOY5s81OgA3u8SWpGoUv1C16yS96j3Pn5PUK1iTVE3sbRlmqBOFe06OJl6BRbnjcFzFfRC1+n4sqlnX/tibqYgzDTuPmv1y/fdGZyubooEWr9iTbq+hmaMlga7KkzYqkLG43xU6FF3kJtXxw9tx8hRR+a2bDnajBAIeIU81ky/p84IlWjnjqmdzcpNvkIzilscX928dX2rulnm+NKtW9vGbma5duxd6lHXjptXY71bxtlHVN0UYvnAjRBQrDaWymvcbfZYK7pfz8hWpa0kfcyzhgzdnxD/DwAAAAAAAAAAYD4Q/v9w/Q8AAAAAAAAAAOD6HwAAAAAAAAAAAE82+P0/AAAAAAAAAADA4Pt/AAAAAAAAAAAA4PofAAAAAAAAAAAAuP4HAAAAAAAAAAAArv8BAAAAAAAAAADAwP8fAAAAAAAAAAAAGHz/DwAAAAAAAAAAAFz/AwAAAAAAAAAAH3imzpxjJphtZuLFiafj/zQ+Gvvl0d8Z/VlmO9bU/yX+YeIvJb6Y+OIJjR4+3VuKJy9dih1JmlBrkgeyco9vkVaNKKr39ZdXK1yxyrHV4vUNjvXmsOlJ1kyQ6myVu11ly5v0//bGBlvhbnAVrrzKbRkCalqqZ9jNMrvGbXDU1mpxa7W4xmWpvkpUVZLbA01YMoYVXed1WWqTOi9obKlc5da5iqu1+jK3ejPtClxbYXOGziuV0q1i5Q57k7uTtuqcdcvOTGbYrWqltFpd6i2PJW9eijFSu04eqvebkkZ4oavJxnve234+7333laP7vfl48jOfib2VcTtUkbsaUb0v+7vTzHgsvSkrdaktNKP6xc7We4Utltcc+RfYxXmjmwRRlLttbWAdOorckJrEGQ76/nUiHqujy3h0iEq0gLxZSSurVGbTqab8IJVN7Um7e/Sp29QUIZUx9BuCGjn6Vh6bzmXzmcjBd1uadRuQNQvP6iYMze1y6dVtzlGy+sudLgu9xbFk6TMDp4s5vvys583BQm9hWL28583DiXsjf4oNEXzQ6H2ul49feDE5fljSFGl3lyjmqiCaYGz1TaklafxuV1DqxhZp77KV0rq+Q0QKT17nbmxWOLpdbHGVqr6pGuqTOy9zdAPZohvsapVd3dwuV9PPZtgblc1bpkBG30OX84VZamCd7jWWZKVY2uLSxeublWo2tbNZuclXuGqxVObW+I3SrVI1lbnKcuW1w2u9XPzC1eT4owVvawRRk/bJUG3pFx3YkjK3c1nVBI2Y26qpTbdUUWiLpMl3SJvua7s0oSFI7tuMcYzQj0vRHcFS+7TUUxifNPown5udP64Pi6vV0uc5Xw9mes+PJVeSg/ZPa8dVu5ne5eNljV1W1Rhm7C9jtQEAAMD9/wAAAAAAAAAAAGDw+38AAAAAAAAAAADg+h8AAAAAAAAAAAAMfv8PAAAAAAAAAAAABt//AwAAAAAAAAAADL7/BwAAAAAAAAAAAIPv/wEAAAAAAAAAAIDrfwAAAAAAAAAAAOD6HwAAAAAAAAAAAMz35f7/8VGZif96/M34K/FPjf3iWGr0N0blUXZEHvlM7A9if4A+AuAxsdF7aSzJF0YYqV0nD9X7TUkjvNDVZOM9/0BW7vGaoN7j66RDaFJblIjK58PTmUePSO/FeLJQGHlb1IRak4TLRWgfrVa4YpVjq8XrGxwbLsSmJ1kzS6qzVe52lS1v0v/bGxtZmmGIh2U4Jg74SBlZqUttocmWylVunas4eezqy9zqzbSdfW2FzbHF8poj/wKbX8zoBkSFCBqp84IWZcMjoZsxtF6plG4VK3fYm9ydtNWwrFXHbH+1DZXtcunVba5P2qqQIXJjs8KV1sthVjNshbvBVbjyKrfl9rLqiOkSm2V2jdvg6GCsFrdWi2tclM2QGp7WvNlF9vBcXAkZtMxkht2qVkqr1Ye9a/Hk8xdHes8ZE9Uth+8ICmlrbgJzaE2rUnmNu832SeqVCammmckH+lavfbe3Ek/O0KJTwaKpEFE8JfeiSjYEowpWJFmRtAPaQ1ur3nLnei+MJdcvxo5bqio/577++lzv6pBas+7rH5vrXRlSy90K1K/95Eu9Qjx58WLs52/6V7+74tWvhi9yc2Hby9KzJqxp0STtXW0vrU+e61x1h+PK7KKxCpfNVRS6JQRnopqOnHxiU9KHWyGNgAlf8VShmvaIFrfY6xub1zNupfJGpWYXzB3h9FuKbcE/DY26WfuZthdl1sz012jZrE/tdSJq0j45tpGuZFQb84tzy/OGVamtakqXSstt9VjDPuEo23OzS4vL1p5KZ54iCfzrqtwONa5n8PtCU6qnfcIZw5Jv4Hy23LJfWPEUKIii3KU9PmgudRS5ITWJMZ2MQVJkvbeO09FlPDpEJVpoi6ysUplNp5ryg1Q2tSft7tGnblNThFTG0G8IauRhxspj07lsPmOVZm0qERpOvj0OM/mcOSXps2GhLWt8jTRkhTg2TFVvxpZpc7PiFXeOdGJTkFp87SBgwE121Z00R7lOhHpTagdLd5NdZSfNUW4JD+kxVyOtjqZGdYFPJjgdDSsKud+VFHr4Vsi+RB5EWuqTs61ZPbpoWVPpePL36I4aOgu8+cZU0MhDjU4CffJac6AltXlahH6IJJHN8sqEVuR0py2Bc5DwMxN3q4w8KfFvcKc6eaBvqU7FOKCUyqVqqbixccdK5NaiCnYXetZdv1lz7WX1FZShimxffRS5qxH1BFYGnewEdnfPHA7k0LMhq4ej10z4QnRXkkfAYylsAYVbcpfV8JbC6uldnna+e2KH7/8BAAAAAAAAAAAGv/8HAAAAAAAAAAAAg/h/AAAAAAAAAAAAYPD9PwAAAAAAAAAAAHD9DwAAAAAAAAAAAFz/AwAAAAAAAAAAgMH9/wAAAAAAAAAAAGDw/T8AAAAAAAAAAIDrf1z/AwAAAAAAAAAA73OmEgzzVOxfMIml0Ufn3jh3ffLfT7bPLCT+68Sbo+sjD2L/IvbTseux6+inJ5re+d5GPDmXGundktp18vCBrNzjBU0jrY6m8oKoyYovifkLqxWuWOXYUnmNu82GiLObZX9y2ngn1bP6M1F4laiqJLf1FFUTNJLtdur0qU4VslI909vo3YwnC6mRw9WQGsltwjelfeKv1E9aldoul17dDq+brTjJ9ldQE1S9ghmat/MyV+FYo17UDJtOiU1BapF6KpuqS2pH0MQ9qb1L3ynddtt8pXZrLYma0mUUIsr7RDngFXK/Kyk0LXOl97mx5K3UCGO0Rr3flDTCC11NNt7z/lrO+dv153szvevxZKkw0hPdzjCqWycdQlPaokRUWhotVCXhucyb/UMWacLTPX0yzkA6iQe81XVZuwt/fKG3Hk+mUiPfSWlCrekfJ3/jftyqVrV4fYPzjwibpvWQ6myVu11lX6mUbhUrd9ib3B129WVu9Wa6Sdq72l6aFsde56o7HFdmF9lieY1dzmWyVNOqp6le3qT/tzc29Ayrlv0ZfVPTL8JWuBt0XpRXuS3WklH14nVVQRTlblsbqNNR5IbUJI4Off86EY/V0WU8OkQlWkDe7A8ry5ivTfkBnYd70u4efeo2NUVIZQz9hqDqIlVunasEDVh5bDqXzVvSdHRJpLiReY01e5vOHEnvkShpJ99WMFdXWENOve5EudVpEvN1rSmL94xXDYF2urksm0RQjZfkYcdYl2FrldoRaMuaupLZDYYab+rQ/S2yA/vkrq1YjdUEZZdofTNrwISy28u35LrVTWYh/ozSllmBzYpfYyWl0sWZMnta76LIgo1l4ooYFWDX9PyKsSRL5VK1VNzYuGMlcmve+b5L2kQRtAEDHyLpdEtdIC1aq+ON9As6NkSFWMeNKGWPhKPlHm2itDwSVMu1YY4nUVpSW2h69U01X447ON7kfnPmEcs+AmWNleXNsLdca27c2KxwpfWyvhc6WfbW2ze0eobqtaBv7WvcBkc33dXi1mpxjdNtmrVP909UuxH6zho69zJ6+yIU7S4NV7ZyM5nJDLtVrZRWq72p3g162J8Z6b0YONIZm4J+gBLqB8FU5lsRxzavkv+IZuY43dJ3CmJ350s9biy5NTPwuO0taravbt94qbd2IhP5PhNvv/mgtxpPzsyMfPvT7vHUI9Gn8Vb/UdWTbRxYfUdB79E1fAJFTpzQw2zQyAD9oY4D+pmGud+f/ojgOQ4cv+Wf+HDWJg81fuDx0iNhK1lnOryxQ0ZuoD4hZwej+yrp6LP13djeFaLR/mnLGl8jDVkhgU2uP9vd6fryTr3n5sK2QHthevYsc56ssJ7RNjaciB7y7jx6hU31iz59d0eiV0dLp7ii2ugVx5J84fhF7zv9no04d3/jSq80/OXDrP8M+yeu9F4eXjnvV/42vv8HAAAAAAAAAAAY+P8DAAAAAAAAAAAAg/v/AQAAAAAAAAAAgOt/AAAAAAAAAAAA4PofAAAAAAAAAAAAuP4HAAAAAAAAAAAArv8BAAAAAAAAAACA638AAAAAAAAAAAAg/h8AAAAAAAAAAMDg+38AAAAAAAAAAAA88UxN/CZzPvZrzNT/OPkbk+rEPzibnfjaxJXx//vMr8R+bernp0ji7ydepP//PnrqvcIbSu/z8eSlSyPfuqQJtSZ5ICv3eIXsS+SB6n3N/NxqhStWObZavL7Bsd4sNj3JslKdrXK3q+wrldKtYuUOe5O7w66+zK3eTDdJe1fbS0v1DHudq+5wXJldZIvlNXY5l8lSTcOUrV7epP+3Nzb0DLVba0mqKsnt0GyzdKLwKgkXYivcDa7ClVe5LdaSUfVq6Mp1Ikp6QkDDrLGTWSqz6ZQgiqSjpbIpvUCVGC9eJ6KWymTcavCvqxHG9Ax+X2hK9bRHNGP0gNU1q8WtqjeTLW6x1zc2r2cy7Asr7GyusJRfmPUWVpd2iaqFFmeZ9Alm2BV2cd4o0W9A112nBbGpZ1/7Ym6mIMw07j6bMkoSFSJopM4LGu2FKrfOVYIleSSurbDmWG6XS69uc2nfyGVDBsorbI1/1kq9sVnhSutlfQI5WT57Ge+4GhJutuq1xm6W2TVug6OTlvbwanGNm8ywW9VKabXaY3rb8eTSzEgvJbXr5GHQDK8J6r1gIvOz1hIolde422yojl5mX530DL1Obo/p1XtrvfdqPDkzM/ITL7orz6PWV/zP9K9AT/a7tQqtyvdnCJpGWh0tNE+3dsqVqXZbLUE5GDS5jfViy7lrxW5X3mhXfnFued5aNGq3qQ25Qh3RsBXq2olcoXSu10lbJEMV5xPuL9BvK7JIUW5rpK0NsSv4JT3bQsDEu7UvBJa6lepOpMgNwJqE/Utfzzhm0UfZ9BTbZ9bKG3Y7ealXHUtuzYwwxmai3m9KGuGFriYb7/m+nWKub23/hy/1tk5kYrbPxH/wUq9yIhP5PhPfmRKYCeO0oPfZ3ivxJLcw0rvrbpB2jymkIyuaar8Py2N+un+vjFB3tsxAvmde+HdOmijT2Soe8PfIQebl3uZY8rWFga0OlpwPrfJfeuPTvXI8ubAw8g3e3ZEDUqGaf7F/Zw6IWLuzr+rHbtX+htLVOrc4eK8etCXfo/0RujcYGcaZjrhHxHsd2nH62Y4xL/QXtaYs3iN1+qohSE3jRbd9ry0/aDtnQHoTh9xfHdGw/dW1M+AMyBAa5gzII+g7A/IaeOw73bu805wXmDPLvdtjyZuXBs5469Tc2ibsc/i/utzbGVo171P9K72R3q14ci410lvo2xFUvkkE1bdeVOanIncASzy48N0+UDXar1lDiCcPOxI98lonTXRr+ufv34sx2sdfiCevXhrpPe/2sT0e7kbtG5if7+/mfg2nq62swBm6/8R0uXdn6Eky56vLf4Tv/wEAAAAAAAAAAAb3/wMAAAAAAAAAAIDB/f8AAAAAAAAAAADA9T8AAAAAAAAAAABw/Q8AAAAAAAAAAABc/wMAAAAAAAAAAICB/z8AAAAAAAAAAAAw+P4fAAAAAAAAAADA9T+u/wEAAAAAAAAAAFz/AwAAAAAAAAAAANf/AAAAAAAAAAAAYOD/DwAAAAAAAAAAAAy+/wcAAAAAAAAAAACu/wEAAAAAAAAAAMC849//T8UKzPj/N/73xt+Kf+/sZvxXz3zvTOWppdHvjc6PPKJZHHophMP13m78wlZx/NFZTZF2d4nyQFbu8Zqg3uP3JFWTlQN+nyiqJLdVXhQ6gihpB9EiqxWuWOXYaqW0vs5V2CFsTV7nbmxWOLZU3uIqVXazPEBpcudlrsymt7gNbrXKrm5ul6vpZzPsjcrmrQFaLNWiBRgCUn2lzO1ctl5nJln22gqbLywuL87TiqyXyqxlvFIsbXHp4vXNSjWb2tms3OSrxa2b/Mulrepm5Q7/ea6yVdos8xulW6VqKnOV5cprvWyvEU/eLI70dqR2nTwc0Hg9Kzqb+RtWN5bKa9xt9hg7tA0DOy1tNTZr5NJnWalLbaGZ6a32SDxZKo4cxo+rr9jVBlT3Pxu2utTMsbW1E6xaZsk+aWu8Su53SVsk7Bq3tWq3wHiTqfbqY8nd4ghjNEK935Q0wgtdTTbe8wOqkx/Qpv+0d6lXiye5qyO97YjeMe13hF0Skcf8J8d0jGshqlsMiagRNNv/ak8YSz733MgdTag1idV+u78Cb5lfsRdo8foGxwZy022hRbL0XebRTo+PJ69eHXl71bAaUbGodv+yr5QIKTZNG223pFSucvqG8UqldKtYucPe5O6wxe3qZqlMTd3iynS1v8yt3kzb8tfYHFssrzn6L6ywhVxuKV8ozC7ML83nCoV8JkvtWz3HVrnbVba8Sf9vb2zoGVZX9mfco5Xzp1pFGxl0g0inBE0jrY6WytqveIV0ZEVPULu1lqTqU4i+Uci+RB7oqdIurWQqY1RJNXqUv0cOQotpkvautpdeLW5V0x7R4hZ7fWPzeibDXueqOxzdBheNDljOGUZFhQgaqfOC5nRlwK5Hgm55ptZ2ufTqNme0LOuWZWTpe3JpvawPRHD6ZdgKd4PuqOVVbssdXHef0SXoZF6jGymdA7Qhq8U1bjLDbtGjwmq13PvSWFK4OvxyNdPzUXPtP+6N974YTxYujfRW3Elp9rhKB0aUOhLdQbypzF/vX5d9Cs56tHLcXpDpgjGGWH/ndqve7uXe3bHkzUsDG2eXNOur0l9b7v3o0Kp5n+ovvrnYey2evHRp5Mdn3NVq5fokf6F/XVpZxmK0l4N3EfompT6yodMvdJkFp4maDp0Zun5DkVueXo22Y8kYpoxlLJ9OTVB2icYLoih36dFll7SJImhUImr1RCs4i8m7o+jv6Z7QPOD1Chpd7M1qyXUSuviNDGOPoTtyl+hbx//f3rtHuZHl933VTbIBguRQo9Vu72zvrGo0OwtgBuzpbpLd08vBrNHoIolhN8AB0ENSs7PYaqC6u4Z4sarAxz60pwFyRrOrKEfSSWzHTs6J4+Oc5BwfWbFiRbIecSI7/iuRJdlWXrKytqU8JFuyYlvxUeLce+t16wVUNx/z2O9nZ2fQVb/7+t3ffdStW/dnKIpm9RzbvdbkPoMJBXuLRVZdZ5dWll95+A6Da+mPo6+IijOo0WD0/tY6vjN6T9pvJmYLhekf/0TEOGdPCMZMFf7zCaOdMw99EgOeb/oUrNyw+vBNN+wJYnjNHHxI9U3hIuzNJ/WaZXKkQyb5abyjk7YWZvtERBTp3cZtua22Mpx8lt2jWuMbCB+h206IPpcWVlcWzy+RQHzCLXVX0Y3opK2oPdLZ/PI5lq43Dhr8EklOTL/41lcWzqzKZ3befjFtp/dQLXL8rPmJtlJf0oGo2X03bkeQaTOQCvmTBK+yplUql+qlwsbGDeuitO40ZLz/BwAAAAAAAAAABJz/BwAAAAAAAAAAAAHf/wMAAAAAAAAAAED4CLz/nzr9ewL5BwAAAAAAAAAAAB9tZqeOnE/SQ3E0Re/3ui1ymIDaoqcH4P0/AAAAAAAAAAAg4Pt/AAAAAAAAAAAACPj+HwAAAAAAAAAAAHj+BwAAAAAAAAAAAJ7/AQAAAAAAAAAA8Lg5dfL3hJNTvyGc+OPUXzv+buJ3Zv7TYwtH/tmR5NRvnPonp/78qSOnPjl1cerU1Clo6iPDcHG/n5irXEiOmoam7u4q2p2edrNhyPrNxp6qkzMg7zXUbku52+j2Gi2lrRhKhECxKhXqklivli5dkqrixGhSa9LFSlUS16UNiYSrlKOCpK5dlspiuVIXpeulWr0mZmokSLEuLooXq5VNM1h/oO0qDXJo5V5PU417IglD4ma31Fa+srE+b/3OknQvlcqiFUe1UKpJmcJapVrPpa9Vqlca9ULtSuMySahSvdEoldel643S5uZWvbC2IaWzF0SpvL6/vd9jShtKk5U26LfkR6A0MxpbaVtX1wvjlfbwpRy+tt9NzJVeSN5/ZkIpdXW3K7fZXfOnHrNcpnSqcLFOhErlmlStO2WyYrJqX7o2z8KrLbFUY8ZQ3trYMEuZEu2wpXK9EpVYxjKAnBVP7ia5nNMNebutNG4q93JNTSEabjVkI0tifLOwsSURW6Mp2yG5XOTSZv7S7KJ1j4vhQopqUN/vMA0+ODJBgxo5YlW5w+6aP+Nq0JQO16AV02NUkmVevI50V0Nm+hEaIqHd1qsPtjuqrqu9ri4WaqJObpoNWLfjzXNpiIXyOrljXXTDklum2s/vtxNzb5xJju5MMlwnrD8bcQ3YCRFhxG6MH6itOtkYa6+jH9q/mZi7cT75oDBBcbJhKJ2+QUys39MMJuW9FFeB3lDhSvTF/GTtWXa16M2HrUlyqWeQ05HvsfjGGLkVnFm47Fi4HGnhsm3hdrq2eX9h/53E3JV0cqTEqyVP6gerl7EV8oGatJWH8f3vl/bVxNxWITnSIzV1W9FY8xw3v7FlJuouGFmcWY4d6oOc6LwpVWulSjk41env7zEVDrdiqTBqtnMoFcaf8zgqfBRlJtPiz0bNl/e/f19PzH7p/PT+BWbW3FSF9AtNRSXNokFNO+yG8DNW8dmES4wM65sDOTcz1t9O61FuDei57NnL+9rM7FvnpwWWJ/1WWzWYjfTMxhya0GJoDv/a/U/v30rMnj8//d4brG2GSYWG/Gm7aqkmQ7MvZkjDdoog1qXrdWcmJ1ali8SQy0XS6PnpX4YYMlWH1X6KhVqxsC7laERW4WmvI1FbcqIqXpaKVzLO/dfEhSwNwDTrTdSUZDeI1WTScrOp9EkPkib9S/Mm+fege7Pbu0NGzfSOrLbJjSyLSm4Sq2voij3tMKPlimDdYtmnAVqKQcI3mr2WYsqaKfOX6bSW5qlSFdtKd9fYy5DC1j0iZOBY26isZbPimlS/JpHOYpGNFItLZgmJontai3WAUVrhRV7LW5q5Wi1tFqo3xCvSDc7EHOtKZcUaabDFOs7/AwAAAAAAAAAABOz/BwAAAAAAAAAAAJ7/AQAAAAAAAAAA8KEH+/8BAAAAAAAAAAAB7/8BAAAAAAAAAACA538AAAAAAAAAAADg+R8AAAAAAAAAAADCh+H7/9TUrwgndk/Mp/5l6hdTryd+P/HnZ/5k+qmpX5nqT31m6jNH6tDSh5aN/W/OzDZWx3oJNRSto5pOO4n3R93xExq4Lvzi+zv730jMrq5O/6TiegoNyEWE/ptBb6EBIeYv1PaIzLxmco4q/Q5Dx3gK9flo9vkA3SqX3tiSLPeYludNX4hs/uxyXBeiNC/zzV6nT73/Er+h7G/qPNT+3ZSJT8225UiU+D82lNAYzTssSksfzC2prhjGJD+kYT5V/Q5J9UGnI2v3QpPm3Y/acpGuR5fPvnLOcj6qD9pG4x291+VdnPKXORentGpFkV5t3JbbaouXy7KY+VzwkTg5eTW/tLC6snh+iURlqoP4m29Rj6VcJnxF4xL0CAeT9MYVTNQqM6uZRkvdJf8Zp0yvZDa/fI6l6IuAhr1E0hHTL771lYUzq/KZnbdfTPNJTXDu6sq8ljd9u1oGw4ey/eO6N9x6ca++luejY3GZAU3TzHNmyYoSjC/LKtqStg03TNYqRZZPhLaovK81sbBRFhVhS9ksszSWFRrnc6GRhsSZdf3e7j+7//XE7Ep+ev8N1+kz30fQC4GLapf8l3R1vxB0+uwP6zh8DgnvOE53vZvn/P3T1f2vzcw282N79pCorb49LNM/f/+H9+8lZvP56R+V3N49RDIyhv8q2MOHiLGOILSD5vv6sZ2zmBet7rnXVzTZoF1hZEfNN3Gf+CTvyp6RKP7oc+g+gpTrEL2ErxOO7v8O3uGKr+ZFvvdzDTKqQ+IkmLNpp0X19u8SJ+PPT+8/7TYo5TazSY30vHSo4q4JPxdsQj5ppwWZ151GY9/PLu/fmZktPT+2iVhxnuWT/i+X92/HDbjEB/zZ5f1B3ICLfMC//v4n943E7PPPT/9Ez2165k1e7r8INjDzTnDeFOVl/VG6V3dqInJwsu7bAXSDWEenofR7zb1xzYKX4xp7rCYeq2Ef2Jt7X77X7smtWM2Mlw22M09Mnoa2eHZxYWXJk9zkHsQryfUgvijG9CB9Wk+9gd7Yk/U9fiLnvcFP5ezEeQE+bU/AiKSt+RsxXy7h8EK6UlwiXNAxhWvJSofUzK7StXr+KGMNCrL+y7TzZk9rTZiHuSJOOG48c3onuxExAfNBJNhzhdzjVMDPy+wmmbcMPLTKrFmZ23yjZJ1ZmdNr4/0/AAAAAAAAAAAg4Px/AAAAAAAAAAAACPj+HwAAAAAAAAAAAHj+BwAAAAAAAAAAgID9/wAAAAAAAAAAABDw/h8AAAAAAAAAAAB4/gcAAAAAAAAAAICA/f8AAAAAAAAAAICA9/94/gcAAAAAAAAAAISP/fv/41N/Qzj9M8d/+vh28r9O/MGx00d/efqTU39j6prwVejnw8mXhzMzs73StKB2W8pd/VZbNZSGPDB67O/GnZ52s9FVdENpNZSdHaVpNHTFMNpKR+kaemNx/H3h7zx4YXgsMVsqTb9fNOTttjJefkJsf7tYlQp1SawX1jYkcbywmEmJonVZbSmdfs9Qus17jZvKPbEuXa+LV6ulzUL1hnhFuiFWpYtSVSoXpZoZa19T+rLmxKtnfDFkxUpZXJc2JJKZYqFWLKxLOZKclZnOwJANtdd10ypXyP+3NjbErXLpjS0S5rJUvJJpK91dYy8TEior5sWzy1kaZ29gNHsdxRePGYF9r1QWM2m52VT6JKJ0Lr0jq23yI8si0JSmovaNxjt6r2vGYgb2XC/VzHgrVTFDLzRuy2215ZHJioXyumjlmRS67o2hUBPXNipr2az4al5cPn+eZN+TfEvdJeUMLYYVp1eSqmD5HEvTFwUNfYkkJaZffOsrC2dW5TM7b7+YZok1NUWmupQNopO6dEmq+tPiJF7LiwvZVFas1aulYr08PDozK18Y2w4sc9IUvdce0LqyG0DwhvCrD354eCQxe+HC9LdLruUHBaPC/7dBWw9KfRBGzsKqLW9N0huyYZDwRug9tasb2qDJ7HuyJQSlOWsIiWqMRcRuPn2td1vpNuR+v62yRtTtWYrxNyjlNlFUt6nEKIhPlCuFP5JHatQ01MVKVSpdKtOaz1hVlnNrKBuwBuue7ghToYABOM1lvzKcTsxeWpkevsQaSKhFNfpKt6V2d0NvCv+NZeGl8rp0XRwbAc1IuM06F2Qj57dfooVrl0khRZ30rE41m/KkUu0xw5A12m1m9z83nErMFlam9ytukWyhwfY79L+DrnproISX529Z5bH6eK5YoZGQ3EWWygpwk+QjZ4ci9fH6UJiZfXtlbB8VUOFieG5/5Ts/sv+txOzKyvSffcbtn/xi4WF/Odg3+WVYz3TgLokPoHYNOo7H6JXInySaKstMqVyqlwobGzesi9J6ZJ/lT50mFdHncfUR2tz5++ZgbLW0lqr3ZaO5R8xNV3e7cptMUbp2R+LW7Lg+hKt/cU2qX5OksrjM+pBXzJbOd4juIO+LjBvU/fLBgT0Qo2dwX1pYXVk8v5T9QPv1lqx0iOCu0lU0Nm2K6huDgk4XaXYLYfmN1WHkQqZcufSge7Pbu9O1qtgaYjy68Qw+9h1+AmZpyyvBacoXNEJLnvT9kz/P9YjJHy8TtBFPDFGTP653jqofXsSpmR2VNBX1a96Aprz3lptzz3USERcvi9IMHa9ms2FqttPib3nUR2+E5Y6OQwSqXTN1qoHD5sBWXmgu+JuBnFg3s+6Ud2P/R2ZmG6tjhxND0To0JjLrJGOWTsaTpfDrwi/h/T8AAAAAAAAAACBg/z8AAAAAAAAAAAAEnP8HAAAAAAAAAAAAAe//AQAAAAAAAAAAIOD9PwAAAAAAAAAAAAS8/wcAAAAAAAAAAACe/wEAAAAAAAAAADCWU1O/Lzw19VnhhJr6RvLvzfzizCeOzR3NTf/j09Wntk41Tv7NE3936rPk9vck+xvDTybmiqvJYdrQ1N1dRWNeFFsKdXBMXNuqit4gDqcH/RZxEGk6WJR1733b5261dIl6wxwTPrUmUe/P4tbVdRrC9jIciJG4k71E/FDWiLvbYl2sFko1KVNYq1TrufS1SvVKY126KhEnxuXijUZpc3OLeftNZy+I5OKJN4R//T1YjUNpeDoxV3g+eX+Rr0aNeOJknjP3eppq3GvsDmSt5d4JrbrQMHbNlco1qVp3as6MJUWcWZeZH0/peqlWr4kZq+YWxYvVyibxeNrbIU5odcvptdrKl6Vr88RHbW/QZU6GqVtQ5oH0uXxaI15xb1NHoynmmXRsrO8wh86eWK2r1ClxaoIVVStbdamxWaptFurFy5b97N8cPpWYW30+OToWVGRb7ajGAZTIycdQoF2+YmWrXM+8mDWLyYlZJbV8RrPiWr+z1LHs8rl4Jd4obZbqdnGN4anE3Aop7jOB4rKG21LaitXwJ5SWE7cLa/mrPpi1mF67B9ouZ4S+klc21p2Sxyuzv5vYf2F4kpV7/+vh5eY6vDjlHtu/WbV3qIzef3p4gjTs2eR7W1xGdeKPV1PkTkNu3Za7TcW1ybB8hkv7M3tR1JTbqk4cUee6yl3i8Zf6zyXSuT1FbjX2ZH3PLpBdhcT+7CDic3mR1orz90viotWAiZQnPlvUe9GV5wyD+ScOsQ7lNnXATp07K0zEtA5lnrcPtWV6N2adizJvJ5QPJO0Rs/Of5wvnkejTq72BbmqE+C+mEToq8oiybLLLLDpeaKLZEkfIUmGzUVh/s0D8wDdK5TcLG6V1yyhG6WEqMffybPLdT/iMghjhZFtwhIImYPqB9tUzqRFaFbSg5v08q1VLtkpuZfh7xPu4od5W0kwLriBzLN2k9tdu0KFe7e5a7sm5P4nb6D7tQTyey81A9Dfx4x2Sni9Sb7p5PnhYaE8O/GGtPBDX1JMrjKiwUa8WyrVSvVQp2x3NG8PjibmXZpPDm56q8nSt4RU1oTt9VB1pjD7U3ymRCcenw2YhXx4mZmZ7pbF+u7vEJzfx/W27FVcMo610aHO2/HdH3hf+u/3e8AcSc+efS454s2fTR/9Yxa6Fddk+4YiRikk94YGqXqgFNb0vDj/Birw/CC2yb14+vsgTJ+ETx6jwPGrD70/MXXghOTrN57GjdLYVLTBnMi+HZjQYImLWZMUxcdpkyU2YNy2dX55UN5vS5ppU9c6c7g2fJhNFUuofDJbab44TCz3ZJD1lfmJGaRU8UOUvDr+PFX44FVF4zjDjFX6scdoVebjcnjr+P5I9APPCU08n30hsz7x69A+OXJh+ampemD/xGfYM/I3h5xJzzhMx+2s1nRw9z5dNNgyl0zd8FWtdDS1cIEREzdpxPOGqLdTr0ubVerBuvzx8lqwIpJPDG2HltydFXJOOowRvsIhq9mli0vwyZgGr0pulmjsiD7PDzybmLpH67YWVTx9sd1T9ECX0BwyZXLkS5KE3vNBsauKRI1NMahPlrY0Nd3YSJhEIGldBta018hRMVRQwhtH8cC4xV0snH3TClNVS9b5sNPca2yqbPx1QZeHBg4ozZGL0dDJglyznhOz0WkqEKtk0LxDUo0/yvEGFvLFxAnQRguo8Q5UeGVV4OtazT2jcgURjt9b1Uu0qXa5orJXK66XypUCNDa8MP5OY20wn758JqzF3XUftdAaGvN2O35GFhA3WFakcqwfKsXU9628yrnPV56795NwFG/JTIfO93I6sk3+xR09bblfpKpps0GfTlkwWiLr8lSZ5tqVTRtkIGkJMrRa26pcr1VI9uJ44/KHhM4k5ifQWzTB1smySGuz2jF5XbcZWpS9cxDwn2B+ycOKreTLbKWxItaKUsQeJzcL1DLvLT4DsCKxhwqqQvGnN7Hc2txDb9i5K9FGU2G9js0L+XSmXiu6q2acTc6Uz3qccc2HXfN4MGTbcu5HT1tDA41aRzegezfjBJrvmY51vCBkdHc4m5t44k3zwyYjiqmQl2wi2svhFDkYQ1i267Yv+ly1rWA3HsjPWfMaryA0lvuouzJgXrD7MG5sp5UvBFLRyZGvb/tO6a+XTvmv9eYBq8Jvd6YWpAl5vPQQP9OEPJuby6eR3ToXOhbzrSfGmQbGXl0ImvgdaZmq2ZbVDFmfC1pnswdVdZGIrSRqZh8s6+6nc7atarOUlPq6wtLRBtxtIp0leYmj3SM91axAzGTuasCTYtM4wl8W2273mTe8C2WGSc6MMXac7zDpcMBvj1cWXKjRBrrr4tFOxR6yIRbnh3PBT7KXnSBr30tO3nnTgl54Tl5g8IZ7w49+Yd6ikY/i1j9X7/yMF4fjUtnDqB6Y/P7V98siJrdT15F9N/NvE9NH80TxGgUewi+C14RfIWyoy//O8RnSfRv1rQtydsJYUGjBi3sfJTlofGvOgO3xm+AKZwZ5Pjr4UvurR72mGHr76Y98dv/7hi2D8YpAt/6RflkpXyR/BBbTvHvlbMHIAPqr9871hLuRlha7uduW2v1ezrob2y/4AEb2YJfeEe69a6VK5sBH2suKlkJcVXFn4gSlW4ccPSKaceLjcknf7L5JHsheSD+54dqaQhQvljv2KjNuCxK6H704JBonahWRGEqu6Jr5TM3dzOWt9zk4K5Y5nDdDa3zVpqwc/upP9Hjq330Oft2L3roaz5OcDa45R+YizGYMu/0jX6JslzzYM0qqyIa3K0qZ/99Skioqxf+oA1fQo5wS08GGtKhPSqriy8FuoYhV+/CYqU048XG6Hp4ZpNkEdrYyZoPKd4IEmqOM7Q1f2SXeI0fPd/deHn2fz3eFzE+a7XDUebr47tlp98uLhJqiCMP05jPIg4vl/+ivCjCAJU/++ID3106f6J3429QsH32G9OXyZ7HI5n7x/3tvfNRW1b4TPoZy74R2fP+TYyZQjH+xDUuEjpzUNsUbN1yulcnj/QgT6NLG+s39Sd9bmPWMtW+wzM0NuxZ2OVaWiVArbZ7A+nGcKHT4fpdDAvCy2QmNM0Bx58eHKcbKR/DLaGAAAAAAe2brd7eFZ8/OsZ/k5kvn9i2/KaV4Mmxj5xSPmmabYE35Eld6UymT/1VX6MrJRKW/csGeH6eGS+YHWt8JLzs0N45R87ITQ+p7okFkVhKmnYar8o9KF4SJZwiSPSqdDZvaN5p6s8vvA4k/t+aARS5nhD0t0kZD7/MzdPOc+OtH9c7ZM9qXgg5T7uGA9EdkPQuYSpPtYlFs86JNRTXpji26ts9eqNocLxPSJ+laD69UNuXnzYLrzhzuo4m6Svbl58k3XTWs3x0EfPP2LtbamrIVao+dfpCWfj/U8K7Rx9Vkokp0fxXrFv05L/f8dF35TeKp/8u+cFFK/lvzczD8/9peO/nvk0keW9/LDV8nT80ryxz3fQtmfTfk2bpGdtX1Zcz6rCu8rA0En7d/yxxqxjyvvbAAyl/zdTUP5tB1F6E4hN0eauTGIbAdW+r49QoPuzW7vTpduCwrE7osgLI2DRmnfixdXlolN/JzVzCbZ/dxrDwz7VYfGverQ5i0Zsi200+8ZpJO617ip3LM+4PNc4z5BzWS0efLtMdlbxVRNNmd1G3K/31YDysi7mc9aEZhFdyIwi0hGUjMn/jKGfDNJI3pSKoz8apBqsstpsnsATbKUu44GeTOOswlNuniR3Ijcg3Z8eIH08ivJ0cshDdg7tTtA8500yYtus09mumfqJPB6pjT8InkbsZK8/2yIMiI2Ux9AK3F2U/sq39lVbUVBh8EceZVjf6ygdslH9YMmba6Nd3TyGQJ/oaXuEoMM+VbByTP3sUKgSmLqkGzeq4d+svDScJV8AUJ2N77l2Z2uaB3VHOLJLEcPPD8E7ofuUI+OJGqfoz/Ek/6sVqpulszZFpll1YK292B++ApT1/vyRHXxn9seWl3jP8ONVpd3UE1bAiFdudn9tdLWx0ssjHmJmh39BMnzLZn3lvXlkxWWe6/Pa527G29EsqXZZJKK0B/cdf+cj8kEJoIi9wFcpyNrZmrWb+4uGUkHbYM1S/uEBu4SJ0jeKbfYlzj0OovMc8UTJdO21bLzZpT8paAs0ykvyS6kHt5ih7nhCnn1nk+OPB/lqV0jZFmArwtLIsxSA4EjmnNIdO6Hi/YOENvEgsd5PExTn6y5UrlOH9EDb5rWhstMX97dqVyRuXZ9cH2Nbc8h0YmHK8XoC8PzibkvPZ98MAisiDSacl9uek94mrAq4gsS8VTIrwmN+dDeWkCJ/s6ezsBe4mKwnr9rW5uZYqEmWQ8WLBnumaBO/16yLvsn8+zmoihtkOALVEHsUzZz5spZl29wnZjHRfE1cfn8+bMTzwS4TIy6Ur1hLQvxRwOMTg7PsTOkHlwKqSnf6sfEapq45OFZt4tc6Zi4zDGxDunChnOkT+AYHDZCWYm4B98cIH4S8zop+toN0SnAOsm6yDQrLsZcSSxeLpTK/uf/E0tCkpwBmPjNY//m6LEj4tTvP5U5JZ5oT7039R5W6z5ma48Lw0JirnIhOZJDniS4R2z/6nlAYMzjRGg0UavqgSAfzCNXVapVNrbqoXvB5OGfYTobFifrjF93fwidjV+PD+rsoQs5ujX8UmJu60Ly3bcnFJI8yCkaf2TNocvJxxTVeccwj4h5k39ks45Dsw9D80/M2Xw3dO0j5R5ZFrWfV5nnHoPJYpHvAIc0F4X7jJznvx12Igo+JzO54OXUIUzbd5rj6M3ha2Tb50ry3S+FVHrIpOkAawqx5k8Ryy3us5oz2UmZK3bfE3Ossw8/x3r3h4d5MhteSf5YKaRmrSW7w1WsJ3Bwnci+ba3x2H+yNaAd+uiufm3C+o570AurEdrU2eKnUyk5f0XY55CwSdZHbTU6+yRz/wEsBFtr7eS/9IbXPPgDX3x32AfUfAh7ucIvz6470h4T46T567F7TnLkaLGyKYV9AfzFw82/RgvD9cTc26XkA8+n1dGn/nmnYZFyYe01RqQRk7LIkA87+B5kl60S2GWrhK6mRQzaE+u4TNaOpHXnNYRUr29Im2ErC8OjwyKrs2Endp1x08BHV2djJ4XRdfao9DCqD9cSc81S8t1EPD0EZoqPSBUx5o2PzYIfYvpIO6oGOTxGIwu3Ge9Ej42O6c/Pm9neJO9g6OUryr10Nm8eQsOK07FuPKSB+2aBp+D/DwAAAAAAAAAA+NiTwvM/AAAAAAAAAADwsYe+/09OGcLxP3f8bPKZme8e+6vTf2W6OGVMP4BuHhf7V4Ybidm3N6f37zDnr7YnL012/KIzb1/k39T5m24fBDpJTvgH1lYa4v5Mui7GjZZ+uFKeKJ3xfwPsfCnz1eGVmVl9M8qz7cRsLE4s199/98jw9cTs5ub0t++wL5QnhZgY42/am47oFqeJZWf7hJwvb+g3aHSj0tVqabNQvSFekW7kyH3/vsi6dL3uetOrShfJ3iFykEktOjXb549f1VlaP9YuPbJbuVhYl2iCO1qvQ7Yq9ZrkI1DuO2onf07axctS8UomSnxNql+T2FZmuk9pdWFhZXF1den8uZVzC6uri1maEjmHJH464cIxUrH1QnZrku1lfY18EuhToplAW+nuGnuZEPEs8bSzfI6lEBYZjefSRmVNTL/41lfkMzsLZ1bffjHN0ub85EUUi5MgfnEXWKhxBX4tqn5YyK1yiXy/GmhToVGR4xRE4vK8VKwPF4elxOxuZXq0Mr7jsC2p0esq5IzlJo1xorDwG1ajMDM3qRcJS2NCV+IYONsWR0q6Q3Yv8z4PudrK3VGUm+17DdpF9u6YEdAui+4rtjbieU7fYAL0HJQ2qajWvarSUhTqASs7PDu8nJjtEaWdPYDSLH9NYzsbR3G/fnjFcenEVd54vWXdY4XcHePRu+eJwjrb6u6AfK7InEoZ2j2aF6K2Tw0vMbUN78VUm3OQhFllk9X29+INV1EJPAFjc3wF2p0/tb7t4cWZ2UHlwOOdU47Fyar5H36sNZQSs5XK9J87b8Qywslx/vfxxjzHLyZVnL/8YYOfSDyEkq3dJHa6wdTqFAMBYwwA40dQq3F5xoDAQJkXzy6zuNz6jh6ILRk63kYMsWR7+i75wjj+4BcdIEb5mwNNox8Hx09uTAg7vegcfSgH4oiGGKWAKHG79AvRpextk43kt8mIPiBe9Bp9RWsSTRLzKGwEKjVU0k5idZWlsbhgzgnMXjdMXQ/VH+eck0uIv792T2eHSLFiWIMgS9HKb5xxMUfOqzKo38Z6r2qJdHtFkifVsGImvhTZWSv2t058EoF7LC1vbZCv80mVW2eTWS6NrQ7cvpV9iMmX+UHEuFCcBAnlxsHN3djYkPGdDcPq01Giz8V4sOTmgR6W10c3NquWApGNjcj2re2NzP0MLmgEB4vf8tvtTinx/h8AAAAAAAAAABCw/x8AAAAAAAAAAAB4/gcAAAAAAAAAAIDwUfj+H8//AAAAAAAAAACAgPf/AAAAAAAAAAAAwPM/AAAAAAAAAAAAPtScOvZ3hWNCUzj6R0Lz9F9I/W7qQeoB+TOEBxeGVxNzu5Xk+1cM4lOEOPOY5ELGcp/2fmq4xVzZ/MTUeFc2/V5bbaqKPlFA+J/iubKx5ZkrG79HGN6DzYGcwsTx8MGcNxC/F4Z6W2kMutskfy3mz6PZ6zbVtso8sJBc3hqophsQy2eGPugT3yC6brnNYMHNwNRrw3jvLJxHizAZ2zdEpWplj3j4iHbgkl8+ZwkdzIkLC8RcTMTx5sJlOVLUzDaTIVk/nMMXOz+aclvVx/jTce7H8dbzQXstseqHcysT296yE+qWV7opFad6srxtcdmaaNtxsmMpKWaWeGmvw5P92rCemK2dnR6+xPx1DXR5V6E9RbuxI6vtAYnH9VND9Ed+hYgIv+XxXRYjEjPjpEMJkbV1NslLmd4bEN9DDcdK16Va0QyaPXnz6C9hNAMAfOT4ylCemb11Jcqjok4GDTp8kbGMuMrUzbGM3u6YPxcnCAi/PZoafjUxe+XK9H3Tf/CEAJPi+189088J0pbzYFNmwuTTEhsz+SQjxG0ysmgNY4/6cwv6N/S45iMB65mQIIWauEambtmsb6KzZDmxU7pUS+NmKZzEBF97zsgrCEcWYOsAxGN7+Oah/MzaT71j/Mw6D9L/M97/AwAAAAAAAAAAwvfE+X8nBENI/WHqr6duH//N48vJzx79+anvTv27U6+Sy4+F/fVhm7yCy08Pj5hLG9biqCHrNxu9ZnOgaUq3SRYwtu/Za79RIsL/7nkPFyOmFHsJFyWYcRdqc+6r1xwTI5f05p7SGtB1z52elr06vDkz28xPWrYOZGYpsjS/d3X4zqGiXIyM8ncf1IZqYjafn/72imft2y8ZGcM/DV3t9ouxZW5LT94l6VzI+jd/jwWa9GbeKzT29by5hO2pqqhYvUITFrLZS/+eTDTYJAHI+1hFuy239ci3/yGiMVK4NVAGSnBZf6tcemNL4t8VmILkzbKmjtutcqBtCjHyx725yIQ3Cyp1sVKVSpfKXinHBrIh7zyYQdFyeOQCRXLeJrzbGO4l5grp5I/J1nYkT0QNcxtFY3cgay3PHduaq6VLVBnRoVJrEi2GuHV1nQbw9Rp66tploqmydG2eVNZzebGysU5+pdguFXqVM3nrrnuFk7JU17hJWrgjyF90ZbmKsgTdK5YUqVnv7hAq1VLaim0CgY0dNGK7XeWptP3HS4s+KXdjymtUzv0zuPkjVqpjBZgayBaSgZ639oqkfcHH3w0tkk+mK3cUdp/+8N0jL83IDjZ21/zpu2+36UZH7Q4MRWeS/ouRCsyHKNAtd1e5azRapHHLUVtfWO5dqdd8obhtL2vSJbIHp0baULEuVgulmpQprFWq9Vy6JtVqpUq5US/UrjRMG2+Uym8WNkrr6ewFUSqvDz813E3MfSmdHL0R2sTMNwoHbGFcILuBlco1qVqPaGAZK+/Fyla5nnkxK16sVja9giIRrErcGJP3tT+qsqC1Zen+qrNLcVW0Udos1S3N7H9muJOYfTk9va8GZjA6rQTPBeGfRE5SmHBwSqJnuNrM0Y7QLGKwEKxsvqaw/7mhQkZ8krtmSO7CJ1W68I/HZHLc9ClqzjQu118ctmZmN9Nxpjm+6ZIu/G9fHDbjB170Bv6db58cbidm0+npn9oKzIZ0r+w/ipz3mJOdsHf55ohK7pg7I3U29r1FtkaSDZJkdySrLevdPNFP/uwr2XGzo4NtDaC92MTNAEwo6vX/4rI5dzJ7vDgbC6hY5GaC5aXFc+c8kzFzlAvdOstL5NP+njTNovFfjZrRBOScjJ03y7mw8Io1S2QtJ3Iz70DnN1aSbYt9eUD3L2Yf4W5SMyOePt+zO9Y/Glh7ePnLcSauj3gaeKB9rHZ8XBKREfOdhUcPIX0fUQN39SCpmNNp32zTv8E2Xm/LrkUM2XRSFCsuy65C4xoXj63yg8Tl2Q5Ln/+nTv+ScBq7RwEAAAAAAAAAgA8nhanktawgHD9yhOz0Nxqr281VZWdpe0VZWT63sry4+op8tnmutd1sNldX5OZ57+fBwv5p8k+KPf//Q4H8AwAAAAAAAAAAgI8WmSPXjsdaE6Dv/5PCHwundk/MJP/R0ZeO/MUjL0yfIhc+vgw/NRok5qRnk6Mta1ujfeZfoy1vK+3GTeVeQ+10BmyDmH3Pt6lxXBD/xuGLIhPKOaJ0/5YdgbuNmN22d3XQHZ3mBWvzrxvYL0EvRm9iFNNWSmYmRPtYMlHVRSfH9obPHxgZibkrRDNXxmiG7BvUrB2cB1AOFyq47zNCGU5xzd2vRBP89jOvmLsLjSrHu+OK7PtZHqchtUs2i5HNd15NkVgtvRgjPTH7pWen9p9hWwyJ2DtK0+CLN+iqZD++fWPP0oe1ad/cURkZytxSad/OOLez+ydGmpnuJTtdv1rNJT37xm5EuuGhnHTN8y7ddO39tPQEv+fy5BDBTu822VD0/sLoVmLurXzyJ2qWdVifIOzskIzTk0V67YF9+NFeT6Nn37H6jhDzW03M2ILWExW/ZU3EHKTrpVq9Rrd1WfVP97azjcSeryjEW+Ty65WSL0qFHp9EvnERFZqaMm9/opG/ZW74ZyHs/ZmizjbIzrPbnh3/plZpGLY/2Y4lZW/qvsW2tCtkY1lnW90d9AZ62rmnz7u10SS1od1zD3NMZVOkZbyjk3SYGbOGYee5Qa9nn8svpqzt+ebmeEe55nZLekSUQjTd77dVhZ01ShM1t8GZAZqKSg50pZH5T+T0JcyLsnR5MeNeXwmTSve2qfGnJwvn0p+fNwZat0Q2YZJwBtnf5oSyOgcWmFwn59MaY8OHdRXkBCw7Oq/hUDjjoUQYEIU3iQZNr6GRg3jUDjn40Wpvor3rn7VCgzMVv904u/6JkHkApFlpZsrELjQjHSrmWih3j2WG3ImtJSv4OOu1thQyEwu1L3lbJod0du1diaEmZW+ZHNdRs1RFs1mKbiqi00WIHVUnx64196ye+/7zo35irpROvid7+qwOUTA9hpMchmS0lQ6pPk9XZdZmaP8UFTI46FuSXA9lRut2S3Z7tCTz6bfMAtohrZ5XlHfIfmbRTfHtYAvlT4G1WnEuTc8XZT+aMukK2m3n5FdSUeGW7bHpQIcqapYZaG4f6Hz2ZJuBmTM++rDIHTU2tcG228WLspWCPK+Tg0/JXlfyCc+iZV4TDcPWGz+1EZW7TYXsUqcf+LkaNFUrt20zeXvUI2aST/7ol0LNhDNoluEDjWhRkaQKF+tEKMY4xgpOlGCJkn3RlfFqzDjKy9nDBP0kw/qtk+66ORh0crtKl5ziTdOg1UY+/dkiHxpkFnPej81yC7nFrDlZKFbKFzfIrmE3/qy4XrFtvibVWX1zSeY3S+UMnwVSG+1BS2nNcxfZxmsnmJ27/GbhesafY39w+4YVhVugPJkiSm7XVeZuverfES7WvQLOl2/SRk0aa2hM7VxIYmx7ZPe14TQ0YlsXUuRfDz456pK5Uzr5/tlQAyPtm3yrQL5YIP1xV1cDlhajQ4qMwrIzt2My+4qIbulAfckHYZjudwUwzIc3THP//88J5B8AAAAAAAAAAAB8uLg0dfRa8Qh9TdBY3FldXlheXVZaS81zC+fObi+d29lpbi+cV5Z2dnYWZP1e19hTDLV5hqzc9LpqU26fXT3DXhtg/z8AAAAAAAAAACB8xPf/x1odOAX/fwAAAAAAAAAAwMeeFJ7/AQAAAAAAAAAAPP8DAAAAAAAAAADgI8+po5eFo1M/LiR/IXE39dTUj9P/Hfni1JvCC+x/4InyYHmkJOZurCTf33UP4KcneWvkAH1ywCc9uJ0cCMsf8Wmfwx+UCh7KHyOm4DHGzmmhoREEDzPWyNHj9PBqdjKw/Qc7udI9sThD71mnnfeVbosc2umeDM0dP0rO0eyTROip2Upf1tj5o+xg3NvsZ0tpttUudyop+0kOylc5UfPE3UH3Zrd3p0sO/bYPQObzEExnbG7ukKNMDaX7uDNjJxORl4dNeMKRyio543VXbjvVLnLVLrpmY52gfPxPjyyg/QIQj+Fro5XE3NdvJEf2gdD2mf/03HKf3wtN2SbH6JMjhc+uul5mGi3S0g0lXjDfWHDItOzBYZ30F3RwKMeMaFw3Y8Ug2jFwZ/mbMYgkglBnNa+Nlh9Sg+ZR0k9Gg2Za/uH1A9XgiT8Qvt9rlaO3Rq3EXGMl+e5LY+cfbh55P0mHnIKERBYyC3E8YuQsDxrWzyb9ytU96DrX7HW7CouZCqTM07sV3SB/MY8iOe7v7qCzrWj8FepPJNdRSIZazuWWukv+Q6My9sih+C0ar+VFI6caSof+l5yTrlF/AvQ3dXmR2273muTHbq6l6v22fM90q2FFaZ443iJx0YGb/E5FTq/G+3UKDsxu3YdUuCAc/QS6XgCAgPf/AAAAAAAAAAAAnv8BAAAAAAAAAADwcQHn/wMAAAAAAAAAAALe/wMAAAAAAAAAAADP/wAAAAAAAAAAAMDzPwAAAAAAAAAAAIQPw/f/R6e2hJO/duJ3U89MbU0lha/S68d+BLo5ND/xZ4b9xOzKyvRfepa5X7Gd1xiyfpN49Wkqat/QQy8K/6ftMqewtiGJoTLMhx5x/NLp94h3uOa9xk3lnliXrtfFq9XSZqF6Q7wi3RCLl6XilUxb6e4aexmfdDZ/djnL+8YxXdyYkVBffuWtjQ1vDF7JbH75HPNK54uAhr20UVkT0y++9ZWFM6vymZ23X0yzpHp9y0NPaCruXebdrq3qBvFcd1tV7lCvdsTrjqFQn3Yt1WAO76gzKuLEjsbrOgbyRsz89VC1WTfM4uqDttGwnRKStOoS9Utk5iFwt2bmkLjn899ak+rXJOL3cJEpYXVhYWVxdXXp/LmVcwurq4tZLi3T7RP19xOeGn8/kB53005xYWKKXeLCqNEaKJFJegQCafJ34ydqVkl0Mfn7gSS5m/FTpP6UzBo3E2KeFPl7XDrmTVGk1xvES5PaynCSWesuTdGy9mKhVudFxEJNXCN2nc06OVxi8ovnX1ldOvcKi4H5VKQ5NO3VowyfuXMSMUrMFdAuidNe8mZb4YpgG71Vfu5OhIEHJYJGGZQJsaKgULDagzJOZVkqMnXJVxtXWNYjRBSWD/+xKbDV1z1UkSOlfMWOlDtM0SMjO0DxzcHA2/1nP1hVHL6C7d6BOrYrXSrTQTrjDl5ZsSpdlKpSuSjV7DFNz9DrxDWc5W+R9ErFwrrkj8TSQm58ZGwOQWP0yAUiT2XFGnHXV6yPSsNeYu5K2nUF6InINIfWbepw1vQc7Lkd4S0xImjQ3R9vcZyTRBbecjkc5WrY9JZLVC9dL9XqNWpUlvu8RfFitbLpnVT1ms2BppGJkaKLPSJK4iYZ6c1bSmUxq62UXcO9eVd77J77JydjTddCMsdH1NxTWgPirLex09OYEFfoca550zWpVitVyo16oXalsb4lNQrrbxZIXTeuleqXK1v1RqVY3Kqy6rcc/+3vDLuJuTfyyWEppDJ5JTS6PZ9bTL/EmKoNjyja56U/TNwyu+VrlDY3t9hc2Srpu7lhJzF3LZ/8TmVSSVXiY1kzgsZ7mMLycdnlLZVrUrU+tryO8+w4tqqLhmOgBjHKPG0Clp06dmXwBsp8RgcN1HAbjhNFwEAN5m16oOfT1LPkbWsIMu9EdILmTc6KzQzwdp5iHf24EpPnCRJW6ZLaI03yllPiW3aJTQGuOLdiFPmW39u4mZFgJmjfOrGTeL1CrNSXUVrPLI89Pof+7iSsym7xfr3t/JGnHOI4VDaae+Zfcmdb3R30Bno6G79v4NpJYYt0DdVS/UajVH6zsFFat9oLzv8DAAAAAAAAAAAE7P8HAAAAAAAAAAAAnv8BAAAAAAAAAAAgfBS+/z859afC9F+e+tPTL5z66ZP3Tr6Y+p3Ug2P/wdE/PFqf/qOp/0T4P4jIT0FTHz/2Pz/UErOXVqb3t9RuS7kbetpAY/ue+fVR6HEFv299IFUqr0vXxbERkO9d/J9C2SLcd5A5+2tG9xPp7OvDWzOzb69MC2Yub7VVg3xdNDB67O9GeKqL4Rn+v4aN4bcSs8Xi9P0iO5uBxkO+2+z3uq1GhwSRd5WG3hto5FufMbeE/9tzTsMYSfZVa9QhBQf76NOMMRiJ56AGRyjrO6VgaWHh4F+nv5YXzVD80RJ8dbmZyjqfju5/evgjRMXnp/eLrIZ47ZDPzFr0QypWI10j7Jbwxx6jGhOaqinsdsb6YIsVYV2qFXPkvAz2I7v/heE3E7MSydvb0XmzyheauX8xOXNW8Mjc8eqLzun7u8NvJGbPn5/+yV7AUO2oQnP4Lz2m+UNhMj9knSHiWABfveRTMfJ9G4lkUyrXc4/MesnHbHuhhstumB+/aT2j1+y1yfdu5KduH/Ghdg3yQXjT4PNgBvXd4Y58sA8+8QhkxbxonXxyk9R+aG7YDfO7816nIxOlyX2SGXJqBMnVjtpWGs09uUvaN3eZfK/eUU0d8VdpEdwLZlmabVnXx7VfJhBou+et81rId5R8+dnfwVLTy/4ols+xGDo98vEmH4V5IRgHu+6PZHHpFRZLS2ma31qPKYgtMyYjocHZDVYB1HK/KLepLtnPOz3tJvkmsknPAiA1M3CU2hsYpLLCo2OfWdoCZrTNptIn/RuJRVN2Bjr7pZPuhJ44o2jb5OiBToPUZ4d+fcmEWONRtMaOTOq/ZR1BQFRlR2seebNLOk1L5ItvyWe+1iBH39gf/bdl8/Cdjh7V6XISTqerD7bJSNKN7Ki5+2JmIbdoaYPrUiIC8iJOauYtsznmRbcx0lYT1tKsKLMRgWnzpSFZg7Iv8c3BGS9S14d3Z2ZvSpMGeL4na/YGNEfcOB92V/ij4cXhHdLfS9P3T3mOYgqTHhvTH4YezBQmGjri8x3sgbrNJrmrNAf0E2wzhWCdrksXC1sbdXKEjDV+B4I4dRxyHJHPNDgJFsqppY3h7ZnZxurESrIquEHbMV89nuvCPx8uDQeJ2dXV6dE3vRXjkYsI/c/CK8Mj9Gir4VF2Vw9RCUNtaCTmtlaS95thxxs4s9+mTBJWjXshpxvYMuOONoiIZ8LJBnYo81gD7qv6YmWrXM+8mA35tN451Mz8Uj76S/4s1QSpEEl0jv8IHpMj1uk9cnLSsihtENFzC+ScMvKVe9wP5qtSUSpdrTeKhauFIvlY3j4+49pQJ2ehrCSHK2O1Hn52xoEUHvfUDEfXByyZ/7wMfP8PAAAAAAAAAAAI2P8PAAAAAAAAAAAA4eOw/x/P/wAAAAAAAAAAgID3/wAAAAAAAAAAAMDzPwAAAAAAAAAAAPD8DwAAAAAAAAAAAAHf/wMAAAAAAAAAAADP/wAAAAAAAAAAABCw/x8AAAAAAAAAAAB4/gcAAAAAAAAAAATs/4ceAAAAAAAAAAAAAe//AQAAAAAAAAAA8BF//p86/esC+QcAAAAAAAAAAAAfGc4cE45cOy7sn9YVXW8s7qwuLyyvLiutpea5hXNnt5fO7ew0txfOK0s7OzsL8qnU28LTwtenThw5LZ369VMPUjvJ3dT3zXw3+emjvz7zn039O0ffPyWc3DnxZeHrqf/lEWd0+NTo+xJzb51Njp4xNHV3V9E6JMfyrtKQDUNu7nWUrqE3NGVH0ZRuU2m0lKam0IshYsWqVKhLYr1aunRJqooxI0oVLtaJ9Lq0IZHAlXJYuNSadKlUToni1tV1mgR3S6xJddGNttkbdA0xL24Wrmf8V8+IizlxISteuyxVJbGl7io6Fa1srM+bf1xISeX1B3dHJxKzZ89Of+eThrzdVkKyE3JpatoufWFtQworg5gh+afmoPa6DbUl1qXrdbFcIf/f2tgQq9JFkqlyUarZMnpGbWWpPizNFAu1YmFdytFYegONlCoQSfGyVLySaSvdXWMv4whlxTWpfk2SyuKiWCivi0sLC1kaS7+nqwZJSCyV6xKtMF88zn07+AILvsICW9qLLARX8Iwpy4J15Y4yLtOkkPUMEyrUxLWNylo2kPvz51lMHaWlyg3jXj88Pu52qSxm0mqHVMfL/e5uOmf9fqevuH/sqjvO7zvKdp/8YSh3jZf7bVnt2n90ZO1mq3fH+bup3yY/5X6/rTZlqqmX39F73XSW5W/7nqE0zFJFKZgX8Rby/NK5pVdeMauJNBPZUFrElKLi4SRey4tmqKvV0mahekO8It0QM67V5VzbyTkGkE1lxRpptcX6xdHJmdkbZ6cFtdtS7uq32irJoTwweuzvRliLXgxrDEdGtdHxxOzzz0+/e5M1Iu4mLyd4Go2/sfA2xpfHYzGWcZF2vHyO6c4KdYkYj5h+a+HMqnxm5+0X00/caD4UZuDvAgNB16WLha2NOmnbZiT+ACwmxz6WR6mZ2dLzUfbhsQu+nqeGS6NEYnZ1dXr0TWYPfa33jtI0GqTxaL3bcrvR6bUUPfyq8P95rCRciBmMfcvuGHmj4fomS2xMB0ujDLcQeoPZBi31F+V2m/YA9OednnZT78tNhVzoyN2B3LYsYNBvTag4TsKr7o1Rcma2sRql7nBNNBYj1PhvRy+MjiVmV1amH+yySmgpt1VW0R2S4RYxwRYZ/kMvCn/qqYJQGbPJmnf6g23SJ4bVAxs75HuNm8q9KHXYtx0jphcizNcNwZkrDbOjarrRsDs+3ZA1o9HtGeqO6q0KM4KJ0jUzuUp1YsRODh6i3l8fzczMvr0SVe+h6m8shtfc/0umjMfZVE8fHU3Mvvzs9P4LZrTWNKMha8099bbSsi8I/8aq7FJ5XbouBuRok3HmKPZFUogcX+R1qVbMiaSBPfUHQjrGPPTNkTAzqxYjexbySyMdRI8UzB5wzJGM9jTRN4V/NZwZnTYnuMdjTXDV7iOa4DoRWRPcUrkmVeuPbILrv/ISGTN8E9uydI2f2O5/avRUYrZwdnq/yJQanv1meNGnjnmMIjpsRAE9cxBupKJ2kt2fGp0yc/ZMZM7MgoTl7OjEnFkaiciZNYN4fXRkXKNzWvxe707D2FO7N9XubmMx9LLw/wxnR9Osqx1dYV1tqFh42D/xdLWhMqGPEhGD3eSnCaXLBoOoXsq9LWYWcosPPaiRxn79cTxy7y+PphKzbxSn95usxsZ1Gaapjus3/rXHqCbHRVU7Rmqs+eP7fwAAAAAAAAAAQMD3/wAAAAAAAAAAABBw/j8AAAAAAAAAAAAEvP8HAAAAAAAAAACAgPf/AAAAAAAAAAAAEPD+HwAAAAAAAAAAAALe/wMAAAAAAAAAAEDA+38AAAAAAAAAAADP/3j+BwAAAAAAAAAA8PwPAAAAAAAAAAAAAd//AwAAAAAAAAAAQMD7fwAAAAAAAAAAAAh4/w8AAAAAAAAAAAAB7/8BAAAAAAAAAAAgPNT7/6em/oFweu7U3z7VOjGT+gvH30n+SSI788vHfvKYOP2Xp/Pk5s9BTx8tWqPPzczeeWNaULst5a5+q60aSkMeGD32d0NXdF3tdRudgSEb9Ae5tdfTVONeQ1O2iYzeWJosM/WJ1ujZh0xmMUYy33//7uizidk33pj+0RuGvN1WJoeJEevTxapUqEtivbC2IYmTA4iZlCjKhqF0+kZDbYl16XpdLFfI/7c2NsSqdFGqSuWiVBPdKExhPaO2sjkSuK/1dtS2MjawJcOHua22FM0XonhZKl7JODdLZTGTbvaIztO5dLMtD1pKOsvC72i9TmNX6SoayxORrEuXpKo/Jr/Ya3lxgYU3ejFCe4XygURfEhdZZJrS7GktpUU0ExUVL+Jk4mq1tFmo3hCvSDcybg3kXH3mbE3kPFlhgbfKpTe2pEnhfFnOprJirV4tFeu90Vxidn/qrUk2bsfU0O+oRnOvYcjarmIQ42krMpFxDX2C4NT3DTOjzyRm33prevSCx9onBIwb/+lQu58QKtT4uWrhTXh8lDpXE4c2Cqd29kbPzMx+feuglaMrJDJN0QdtY0zN8FJTT42ujD6dmN3amn5wZ2y18KFixXwqVoXwQR5FbbD41K6hdINVYgy0brCXMuuirXR3jb2MJZIV16T6NUkqi4tiobwuLi0suDHopB8c6KGx8PetzqvTbyuG0iIdGM2Vpg365l87Mmmr5uWrWm+XqEC3+raHspzeaPZQ7VrvDbSmEqNd+wSnTg7PjD5ltuuXxxuQN2Dc+E/EMyNvqEdmSZZlPuLG/clDN27Lsic0bktq6vj9Hx79AGvcP/rJyY3bChUr5mT8xm0FeYxdbbOtkhQaHRJK3lWiWnhAKs/lhjZyqwsIyEV1Bqx0hnLXGNehFAu1esaVLNTEtY3KWtYf5+LZxYWVJdO2Bl1D7SgNezh/RydTjUkphAYKJrZkFmB5afHcuYc35K+MPjEze+vK4aYQE6cO+lRiWB19f2L2ypXp+8/EmDLok+KbOcAU4UD2Om5qbMZt7GmK3Jow+ASlo0zvoaptXx49nZjbOpscSoam7u4qmm3rJPtyc6/Dehi1Q0tFlN4Y9FsyKVZQxlZntXSJZiBOLKk16WKlKolbV9dp0Eo5LBQRukRGz5q0IRXrYrVQqkmZwlqlWs+JaUtc5MRFWVNEJ6F09oIoldex/x8AAAAAAAAAABCw/x8AAAAAAAAAAAACzv8DAAAAAAAAAACAgPf/AAAAAAAAAAAAEPD+HwAAAAAAAAAAAALe/wMAAAAAAAAAAEDA+38AAAAAAAAAAAAIeP8PAAAAAAAAAADg+R/P/wAAAAAAAAAAwMeaUyf+I+Gk8KvC1L9Ifev4K4k/mvn5Y/tHS0eefurnT2kn14VfPfUd4S8KP/XhLsPwxdGLiTn9jeRoztDU3V1F0xVdV3vdRmdgyAb9IQ+MvZ6mGvcamrKtdlt6Q+3Qm9ttpdFS2oqhTA5SrEqFuiTWq6VLl6SqeIg0UmvSxUpVEtelDYnEVCnHiISEuVQqizUSpFgXq4VSTcoU1irVek5MW6FFO7TohBbN0KKqi04m0tkLolReH86NfjAx17mSHB33aauv9W6rLUVr6HdUo7nXMGRtVzH4Ygz6LdlVVYR8hJ7ixm4raevqesGrpIgY4mjIDiqaQUUzaKh6zo2+kJi7s5UcpSeoR1eUFqklfdA2os1pXKCYihqbTrRJjYvmMCqj4UUzfITeXngovY23rUent4Na2ePX2+cPoDe1ayjdg9qbFeggeotK54D2ZkVzaL2Z4SP09vxD6S2GvT0SvR3K3h6j3oqjH0rMffOt5Gh1kt56A62pENNvKzKRiW9y3nBxtTchtQMYnjemQ+mQRSFaUUSo8bmHVeMEC3zEajywHT4RNc6NxMNORsZb4cNORg5qdY9lMkImt3/lw/8MQebf2YeYf3ubweOZf08y/ic5/y6OMvF6DtMuDt4B+8IdqAk8ig7YF9NDNInxHXD6YdUY53Hm0anxcI83j1mN9Pv/qdO/JZB/AAAAAAAAAAAA8BHjC1PHhePHp6fPHjkyff1YptBRNLUpv3x1oGhGr1FVmz1h/zT5hz7/HxV+S0h+5shXT/4s+fHcx6P8D46OOom5Wjr5/jPW8tCtgTJQGh2yUiLvKg1D0TpqV26TNy06UUlDb2qDbVOEvDjR1MB6T4zgqcLFOpEslWtStU5Xdjzxpa5dlspiWbo2r5PVQoWIiZm03O+3VaWVzqV3ZLXNfjTlblNp099Zc8knJdpRlsr1ii8jLGF31TKjq91dslrX6+Y05dZA1ci7JNmwf+uN23JzMOjkdpWuorElyyyJ/c3CxpZUEzOLOZo7c5mKBVvILdL7pCTFSvniRqlYd+PPiusVexGrJtWJmChySeY3S+UMnwXlbrM9aCmtee5iNscHs3OX3yxcz/hz7A9u37CicAuULxZqErsmikzj7q1XVxcWVhZXV5fOn1s5t7C6uijWvQIvLVoBpY2a5FtiY2oXLbWLTO1cSFG5uycPdIPVGouhvH4hRf71/vJoNzHXXEn+xNuWHTrLfPQdnSY3aXCdvmDuk/8qjR1VaZOl692BrLVCRX12eYDo/EuPF0VHrKXuKjq1E+tv5W5faRrsxfdtlS0tEiMITcoy60pdzJCCZ1jhKxvrppHn032l2yImk2bXC+V1twHk005qfU3py8QkXCkagy9zYqkmlrc2NjwxhcmQrHjkPHEFCzY22oB43ozN/MOTBHvlSizU7Rusdh4S/zhZf/bN/ISkzqyVtc9qmObHaDd+HURmlHZeJGyvfZt1Wi2l2Va7XP/lNIQJRc6niYrVWHUfrphDyT2XD0nkYBYQdTtmvbkyjj7kcBN3++PXWDQtRW5RXZMLrP6z414MOC8EuCbrtHrudVXIm4H3PzXaSczdID1XemzPZW41cN9zHL7T8scU7K+izPHJd06Pq7V/xDo+dE7onB5t52SnOGYL07uXR3uJua2V5I+dnjCnMsv08JMpPp6wWdSB5kjjdU81azYX7lHBNByn/ZitqWrJxWlYcZvWo2xcB21e8RtY/CZ2iEb2qJrZ5EYUtxmZHemExqSSR8Zd0mwiRnzLQg1N7uoqveZ5//9HAvkHAAAAAAAAAAAAHxdOTSWE48njR4647/9x/h8AAAAAAAAAACDg/H8AAAAAAAAAAADg+R8AAAAAAAAAAAAfEaY+Cx0AAAAAAAAAAAAfT+j3/0lBFE7+9olfTd1O/v3Ebx+ZPvWvyAWLB18ZfZOctfls8ttb1lmbd3razYbts1A2DKXTNzi3meyMTOu2/3jNOEGDx2uSEw13yNn4DbWVIz/fIUctWj/NgzZvn10lfxAvjkZuR9YNctw+PSq0ZV1rNHvk+H1yDCLnadE6j1O6XqrVa+wQTetExUXxYrWyaWbTyp4uFmqiTERer5CTF+kdduUOje7OvNrKy/NMXG2l2HnzJOfmFerH0SopkWInaraco1Nl3gdAsy2rHfMsTVXvy8RvIz2TOJfWBt2u9Utp9m4rGvVJap6dzx1fa58BSo+RdDX1HMmX3Gz2BvQ85RY9K9S6b6mP3nf/so8RdaQczT6XTzd7LeVu2r1JtWoGp7/s67zq6V36txutnUmRi8Opmefyd/yXHHFTWXai6Xbvjn1WaNY6GHPMoZjpa5XqlUZNqtVKlXKjUK9Lm1frjcJW/XKlWqrfsM+5vj76emIun07+5DXewm3z1HoDQzFN02MXYaYdEsY2Z9cphCcW92RYzhrPnBGLttUuijJxI7skbveMPdE6dpXcJVUiEmWIRk809hTifYDKbgy68ssd+a5oDPptZd6M6bK6u8fiIP7nNVls7sndXeIgvEOiaLPrJLym7PQ06qe5I6tdkVgaNdszOwo5zrU1zzUP8tNtIIasm23BGNM6DK51MBm7CVIxnbVJKkatItBo+GiJv4vONskXDdahwTp2xE5YaufUXDrzXLvT57mGadhJ0azb4kZYRE7rMrhWxAS4RmXed1tR3tvEuDhM+827tm9dp40kb7ceR17n2nFYmnqMNPWINHVPQ41I22n9duMPdDa6v8FGNmFPt8E1YO78ba/xUzh7ozCbcz00cx2z3rFENqSLddNaHDnWWAaGY2waszZt3m6k1Do6807nZ5oIueKOR5b9mIrpzN8kDp3ztqvdedPDbtrTUxEhrl9XdnZorZArmsG6d7mzre4OegPdOSDZCsZnynNCcIzuze7WqpWtutTYLNU2C/XiZatv29dHXyN922xy9CzXt5GT9lvkaG1WRPtobXY9pE8Lkw05l7+VI6dA08P7SVeSa/Z6GjlXXzZ6fHPO9baplaq3Ff/QnNMNTZE7DaXfa+7lmuS3eRay3Vvqk3RQ2tzcqhfWNiSr2KNnR/cSc5Vnkw9uhE1aWuQ05K6TevwZS1i40OmKf2IyZhLiH3DzaZZK2mluoQPmEjtY39tsgnMYsy9OudZ9Zz68avjpiWmSd8LTjGGP69KbpXLjalUiToEaxG1QvVoo1v12OXx9dDcxtzmbvH+BryBTwb6U3bE3tHLGhAkfez2K95eRFT5yYugZvJxhxRnBwpUb2q+alfyotPmp0Z3EnPRscrTlnodP25reaMvbSrtxU7nn8c/B7gWPvo8MEjRyJpRzRK2T71kErnrZbf7wevOCNSS4gf0S9OIEvwE0JTMTot0/hTqJ/4HR7cTcFaKZK2M0Y7rwsp0ExFUOFypoaBHKcIprdvBEE22lu2vsZYjTqnrGK0ZsbG2jspbNMuWsSfVrEolqkZkT8V61PPYw+O5tuU1Mz6spEqull/szo28Qr1QvJ987FtZBWg7oI57QAiPxuD5zfFRBw3L8uQRSMVVJjSRqILbdB9jeXTjPBj7vB76h2RKY0J0GHgknPfDxM4kU/zzzCB7+Yj/21K6VSE8R+fRDn/8Twj8VTn33xLPHz8189ch/PP0N8ufHi9En7s8k5pTN5P1vWeZuT6mJ9zal0VY7Kp250LFAU7aJdZFRhTi5sx7hJsj6zf8gUdv2v05qkdp/eVLoSUsXkcEd25W5dQrSdXb6PeKbo3mPdjnWNMBzbbzTCSs5kSZ3hiUnms8aZm5FhQ555CmS9s3E1SFxAnKm123bvdDwufvHWLWM5mJWi+kn47FUCx+1v1uKUS2PTUkPLtw/kpjbrSTfvzJJSc7yg1mi8VqK6LwPFHmw+24ONI0+BpCBp0k6wwbnIXGcFoN9fHREz5lzrcj7qYjHypgNxapQUeM6eC1WS3F7eG1+R+t1QvKWH180TxTETWtIBBPL7kZgF3GHjCN04kMcwpjDUvD6+AHlYCbcUXXqJNQ236v3pxNzN4n53oprvs4D5+MxYG/0Y5ebyeC9yx4u/HrOheiQOiK9oyg32/cad4hOenfMdHXq/LS3TSaLxF9SY6CTf/UVrUnywD3ppg7WOPh1Xu+6rzmppDKReTeDRN52Ywgp43Oe9SivAVmhIlRghoy4yeU6TFFWjsNuuSFdZVodhKvcwxj2uKeKkXJ/KjH3zUry3eNxbdpxAWW3lMdk3BHpBK2crFA3ex0l1+41ibS7VnbAbpqbyRIBw/Jg3O7p1jTVXTRktWsm6njporVqXrI9mrFnQH+WOHH/vUN3XI6bOb7r8lf0g8LoW2T57IXkt1/yPCapu1TF5pI092rAvB7+OBQMEvFmwIok+GIg5IHEXhS3VnciFsS5pxK23kuHJvea6aPxsaRERrCx6YQMy97XA2xB1+rc2KU+e7aeZwuznk4vsBbjSdtaguH9brOFSGKraovWNjdu9k2x56iLvE6P+rgzjdi7guM8vBGf1MwJHl3OydIC9u1nTFqRpP+h1z3RRwzq5FF0lzYxq+15OuTJD3ulS+XCRmNT2lyTqo1SmXj0Lq3bz/qfGf0Ie4P73iZvxLb6Ip7Mba2HGfOEoBEP9bnwOaGd0KHfyYa/UZJD3yfZDz7cS52HeTMb+RY2MOS6SQYma/T1qLM08RxvN2PeyMR++3m1WrlY2pCin/+fUoVjU08LJ//DxM/MfPFIeepp8sf3MvdX759IzA0qyfdW4w7u/V5bbXpXBB/5wB6SRnAAiTlw+/rgmA9GLAcq6Yf7TkPq+99U+vpkrj/NW11uY5vEzvnT7Yc+pkTPMu1QETPJsbPMw80UTM2LrR4perdn2E6zv6aI5gKjzHnTfLB3P5WY61WS33429szQ8cj5uKaEvgTGrLkewH6YP+2wxdYJS61ZyyE0F9Qn4Y3AGq6dN6d0PdTQ7rFJWs6Zc2YD0Y4Llz1oHs3InCKOjcue/EY4vnZzFObw2grsueWf8ubT7uhlPclamzpoOCtdN0Un9njuY6MnzH7PsUP9/nGyeldJ3s9PsnWr84q1qGp3M3HNPCTuA6yq2qlNmH04c9C+0/NZUwe3x4uYPT5cr0MeStxlf3O70t79ZGKuU0n+5A/GVHvsHuaQqp/UwcRWv38Lm1e/KWczCf+o7330d2Vsj8fPBT1sWxKuz+VXqYj7p/ugYrbeEC/b1lg26HKjWaAxBwe8bKTTbvIKuqm2VXvnilXj4fFa45o+6NP3105/ERV5hHiM7LoiB1tK5ENGjMWvjVkqmuAbe1yocB2w7tvZceOvvFyk+nMhusuF6ikb5WR9TL1G1de4evhQVlV20iLMxLHF6uwCQ8zo8v0EG2Ie7Mbs62LNwQ/Zzx1y7h3s40yjpB0MtxYRwx7jLaG4YxW3LtKfD8zQo8arw66o2SMW0xJbTTM3IVh1ST4w/7PYbv/h2/+f+ofCUeGckLhzpCWcO/XzccK8m7v/FHtv+53FmO9trRb0ON7b8lEfoFV6XqdHPBDb253jvVRni1Exnp7NJUzuwVn2TnKiXs7T1hv2yvHQD9ny2Edse2RyB0558sOQZ1tr9EO6PGHoz3q/GZAjHp4mJvTa5JQmr6MdamnANC+r6/vR0/dPJeb0SvLHdw+4pMSeBx/vihKXxCNYGQh7lPVsy3rOf+ew7+k9y1GhC1KBxwe/afPGLY5rQ7ypHXx+FcNMJ8+GA41CPMTigDc3k54PYifpzflDpPc4dRxLxVyv8Kh7BGr1A81+s/jul++fZF3Cj00dsEvYVuh7+8faJXBJPNIuIXzXJd81hEt8AF1Ef9KjVv+QD1rhfU+slca4pn643iR6jfLR9WCPsXnZL+icp43p72JyDz7G7ymL90+zh7D3GjEfwmKtjRzuIeyQSyNxHsIexb7mcY9O8pjtlO5+mYitlmYEh3mDGfUwFfHG6uG2YTsbNILLMv8/wL6KhwDwEQA=",
  "canonical39_effect_started": "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"
} as const;

export function canonicalSessionStartDatabaseBytes(scenario: CanonicalSessionStartScenario): Uint8Array {
  const metadata = canonicalSessionStartFixtures[scenario];
  const recipe = readFileSync(new URL("./canonical-session-start-generator.original.ts.txt", import.meta.url));
  if (createHash("sha256").update(recipe).digest("hex") !== metadata.generatorSha256) {
    throw new Error("CANONICAL_SESSION_START_GENERATOR_MISMATCH");
  }
  const compressed = Buffer.from(images[scenario], "base64");
  if (compressed.length !== metadata.gzipBytes
    || createHash("sha256").update(compressed).digest("hex") !== metadata.gzipSha256) {
    throw new Error("CANONICAL_SESSION_START_COMPRESSED_MISMATCH");
  }
  const bytes = gunzipSync(compressed, { maxOutputLength: metadata.databaseBytes });
  if (bytes.byteLength !== metadata.databaseBytes
    || createHash("sha256").update(bytes).digest("hex") !== metadata.databaseSha256) {
    throw new Error("CANONICAL_SESSION_START_IMAGE_MISMATCH");
  }
  return bytes;
}
