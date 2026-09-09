import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

// Exact archived public storage writers, not restamped current databases.
// Synthetic project metadata grants no project-file or provider authority.
export const canonicalLabelPresetFixture = {
  "generatorSha256": "b07017eaba5bc540c6059d25f4851ebf34178af8c3a01c90f23ab5e0673cdfea",
  "bunVersion": "1.3.14",
  "sources": {
    "canonical17": {
      "commit": "c018e91fcdeab9fe66078c96ca25c34d198a6189",
      "tree": "4b7a6d24d8be24c889b735ee9146555dc139e293",
      "sourceFileCount": 119,
      "manifest": "407df7c80c5b3503670a4d3b75a90619f0f32d70133b6cd01338dce124d32937",
      "pins": {
        "src/storage/state-store.ts": "31d462821d1c7830a38e917c989c0b44ba03b8f3c1812788d8eb554d24c09cd0",
        "package.json": "1ace2e19fb0f9e63e37668baea728c1063b4e7fc89865461a3e59088e9f17ad4",
        "bun.lock": "650f295c061c3573d0fb4b5542f12977d8e4b5ab8b65d1e019b290f4a205011d",
        ".bun-version": "56b0485099b6c5427d3b68c042fd05b632d5e52e924c5064473389812227164c"
      }
    },
    "canonical25": {
      "commit": "5ac4359abb7b23887abeb7bfc11e32b3efcc7180",
      "tree": "f811c3d03e8738e92224225c285a4acd6921d275",
      "sourceFileCount": 146,
      "manifest": "2da9b24b18ed4ed29fec7ed916c0d2fef1bc4283f1ffde3947aa3c752fb2adf3",
      "pins": {
        "src/storage/state-store.ts": "f92aead85ce5a052ee595ac2b92ea538594beaffcc300cd70fcead6b235ef653",
        "package.json": "3f256386d6b2b6bcfbd30c1753dc72b4489ddc2c144b71bea02c1bb0a58270d7",
        "bun.lock": "71b613bb93f0ddf11b6e3affdb3033cb23c1be9e9d977c207df6cd31d477e8fa",
        ".bun-version": "56b0485099b6c5427d3b68c042fd05b632d5e52e924c5064473389812227164c"
      }
    }
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
  "fixedTime": 17001,
  "captures": {
    "canonical17-account-collision": {
      "schemaVersion": 17,
      "source": "canonical17",
      "retained": {
        "profiles": [
          {
            "id": "acct_2c416ee77f264edd905f7666bac2b6c5",
            "label": "Équipe",
            "state": "signed_out",
            "processGeneration": 0,
            "createdAt": 17001,
            "updatedAt": 17001
          },
          {
            "id": "acct_56e7f38e22dd453e917ab37c3222cf1f",
            "label": "équipe",
            "state": "signed_out",
            "processGeneration": 0,
            "createdAt": 17001,
            "updatedAt": 17001
          }
        ]
      },
      "databaseSha256": "c894869f1cc4fb56c34647083d4d2c165a7e4e448b8084b55865f9ee87e3564b",
      "databaseBytes": 376832,
      "compressedSha256": "4269a91956cbc7c0bb2e90b4d5bcc1e36f8527feec0d5dd589ad8b29113b4b62",
      "provenance": {
        "kind": "archived_public_writer",
        "syntheticStorageOnly": true,
        "providerEffects": 0,
        "rawLogicalWrites": false,
        "versionRestamped": false,
        "migrationStageImage": false
      },
      "gzipSha256": "4269a91956cbc7c0bb2e90b4d5bcc1e36f8527feec0d5dd589ad8b29113b4b62",
      "gzipBytes": 11800,
      "snapshotSha256": "0272f38020d8a6a1ec10b2a6d8e6dc0fe60fb670a02abe0cdd34feb491f5af10",
      "schemaSha256": "6c9cdf192b3e989693d6f2500931f1054e65dbb30fb894e351e2d1dcf10cddf3",
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
        "profiles": 2,
        "projects": 0,
        "provider_interaction_transitions": 0,
        "provider_interactions": 0,
        "provider_login_authorities": 0,
        "queue_effect_evidence": 0,
        "queue_effect_resolutions": 0,
        "queue_entries": 0,
        "queue_sequence_authority": 1,
        "security_scrub_authority": 0,
        "session_event_streams": 0,
        "session_events": 0,
        "session_runtime_profiles": 0,
        "session_start_attempts": 0,
        "session_turn_runtime_profiles": 0,
        "sessions": 0,
        "turn_summaries": 0,
        "usage_cloud_upload_anchors": 0,
        "usage_poll_failures": 0,
        "usage_revision_authority": 2,
        "usage_snapshots": 0
      }
    },
    "canonical17-project-collision": {
      "schemaVersion": 17,
      "source": "canonical17",
      "retained": {
        "projects": [
          {
            "id": "proj_68ad2382f9014d3c99ad9caab7132371",
            "label": "Café",
            "rootPath": "/",
            "default": false,
            "createdAt": 17001,
            "updatedAt": 17001
          },
          {
            "id": "proj_52c117b815b24105b57a2257ddf21d3c",
            "label": "Café",
            "rootPath": "/usr",
            "default": false,
            "createdAt": 17001,
            "updatedAt": 17001
          }
        ],
        "projectDirectoriesInspectedOnly": true
      },
      "databaseSha256": "aa46a11f493a40200afc4d76220b71e285c6ca16ea72d69b6830b927c0373984",
      "databaseBytes": 376832,
      "compressedSha256": "54f54bd66a9cc8e9fd990c359aaa3784eced6df5b5e888ecc7db90395e4e8077",
      "provenance": {
        "kind": "archived_public_writer",
        "syntheticStorageOnly": true,
        "providerEffects": 0,
        "rawLogicalWrites": false,
        "versionRestamped": false,
        "migrationStageImage": false
      },
      "gzipSha256": "54f54bd66a9cc8e9fd990c359aaa3784eced6df5b5e888ecc7db90395e4e8077",
      "gzipBytes": 11724,
      "snapshotSha256": "05690868ba01611ac7b9140d9759130558e77046670fe700abbefb3d8e2fafe3",
      "schemaSha256": "6c9cdf192b3e989693d6f2500931f1054e65dbb30fb894e351e2d1dcf10cddf3",
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
        "profiles": 0,
        "projects": 2,
        "provider_interaction_transitions": 0,
        "provider_interactions": 0,
        "provider_login_authorities": 0,
        "queue_effect_evidence": 0,
        "queue_effect_resolutions": 0,
        "queue_entries": 0,
        "queue_sequence_authority": 1,
        "security_scrub_authority": 0,
        "session_event_streams": 0,
        "session_events": 0,
        "session_runtime_profiles": 0,
        "session_start_attempts": 0,
        "session_turn_runtime_profiles": 0,
        "sessions": 0,
        "turn_summaries": 0,
        "usage_cloud_upload_anchors": 0,
        "usage_poll_failures": 0,
        "usage_revision_authority": 0,
        "usage_snapshots": 0
      }
    },
    "canonical17-approval-controls": {
      "schemaVersion": 17,
      "source": "canonical17",
      "retained": {
        "profile": {
          "id": "acct_14733eb559f4462f88b3e598bc7a3e4b",
          "label": "Canonical17 approval controls",
          "state": "signed_out",
          "processGeneration": 1,
          "createdAt": 17001,
          "updatedAt": 17001
        },
        "session": {
          "id": "sess_df2de0c4cadc4b39b8a0df8d3df348c7",
          "profileId": "acct_14733eb559f4462f88b3e598bc7a3e4b",
          "providerThreadId": "canonical17-synthetic-approval-thread",
          "title": "Canonical17 approval controls",
          "note": "",
          "preset": "high",
          "fastEnabled": false,
          "state": "idle",
          "providerUpdatedAt": 17001,
          "revision": 1,
          "createdAt": 17001,
          "updatedAt": 17001
        },
        "command": {
          "record": {
            "version": 1,
            "publicId": "17000000-0000-4000-8000-000000000026",
            "sessionId": "sess_df2de0c4cadc4b39b8a0df8d3df348c7",
            "authority": {
              "profileId": "acct_14733eb559f4462f88b3e598bc7a3e4b",
              "processGeneration": 1,
              "connectionId": "17000000-0000-4000-8000-000000000025",
              "requestId": {
                "type": "number",
                "value": 1
              },
              "method": "item/commandExecution/requestApproval",
              "requestDigest": "893352b179a5431e90a58140e0d9090fc528c705aeb241ca59772f0ce73b5833",
              "threadId": "canonical17-synthetic-approval-thread",
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
              "summary": "Synthetic command approval",
              "reason": null,
              "commandClass": "fixture",
              "workingDirectory": null,
              "allowsSessionApproval": true
            },
            "responseDigest": null,
            "intendedTerminalState": null,
            "requestedAt": 17001,
            "deadlineAt": 1817001,
            "updatedAt": 17001,
            "terminalAt": null
          },
          "replayed": false
        },
        "fileChange": {
          "record": {
            "version": 1,
            "publicId": "17000000-0000-4000-8000-000000000027",
            "sessionId": "sess_df2de0c4cadc4b39b8a0df8d3df348c7",
            "authority": {
              "profileId": "acct_14733eb559f4462f88b3e598bc7a3e4b",
              "processGeneration": 1,
              "connectionId": "17000000-0000-4000-8000-000000000025",
              "requestId": {
                "type": "number",
                "value": 2
              },
              "method": "item/fileChange/requestApproval",
              "requestDigest": "34078c2971f270229f55f09b0ec9d0d868bd853dd0076d44f94812deae3cf5b1",
              "threadId": "canonical17-synthetic-approval-thread",
              "turnId": null,
              "itemId": null,
              "approvalId": null
            },
            "kind": "file_change_approval",
            "state": "pending",
            "revision": 1,
            "blocking": true,
            "display": {
              "kind": "file_change_approval",
              "summary": "Synthetic file approval",
              "reason": null,
              "grantRoot": null,
              "allowsSessionApproval": false
            },
            "responseDigest": null,
            "intendedTerminalState": null,
            "requestedAt": 17001,
            "deadlineAt": 1817001,
            "updatedAt": 17001,
            "terminalAt": null
          },
          "replayed": false
        }
      },
      "databaseSha256": "0b62032aeb09b8da0f8f8a0783c1afef436c592deaee4e159fca72f050285f23",
      "databaseBytes": 376832,
      "compressedSha256": "612eecb527dd743827579d916ba11cb7c67d3988178211ec0ea781a02971a2cf",
      "provenance": {
        "kind": "archived_public_writer",
        "syntheticStorageOnly": true,
        "providerEffects": 0,
        "rawLogicalWrites": false,
        "versionRestamped": false,
        "migrationStageImage": false
      },
      "gzipSha256": "612eecb527dd743827579d916ba11cb7c67d3988178211ec0ea781a02971a2cf",
      "gzipBytes": 12637,
      "snapshotSha256": "c01f4e2ab8c82f28843ad00388c0853f11e458a62202f358025c5c8003e24e57",
      "schemaSha256": "6c9cdf192b3e989693d6f2500931f1054e65dbb30fb894e351e2d1dcf10cddf3",
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
        "provider_interaction_transitions": 2,
        "provider_interactions": 2,
        "provider_login_authorities": 0,
        "queue_effect_evidence": 0,
        "queue_effect_resolutions": 0,
        "queue_entries": 0,
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
    "canonical25-preset": {
      "schemaVersion": 25,
      "source": "canonical25",
      "retained": {
        "profile": {
          "id": "acct_5d2e841b8e7749099a69c98c8c4f715c",
          "label": "Canonical25 preset control",
          "state": "signed_out",
          "processGeneration": 0,
          "createdAt": 17001,
          "updatedAt": 17001
        },
        "session": {
          "id": "sess_6d229ac404eb4545be8f299caeaea649",
          "profileId": "acct_5d2e841b8e7749099a69c98c8c4f715c",
          "title": "Canonical25 high preset",
          "note": "",
          "preset": "high",
          "fastEnabled": false,
          "state": "starting",
          "revision": 1,
          "createdAt": 17001,
          "updatedAt": 17001
        },
        "originalPresetRequirement": {
          "model": "gpt-5.6-sol",
          "effort": "max"
        }
      },
      "databaseSha256": "9cdf8a60bc1adaac1c67bb6bcc00bbdddd7547393ad9bc0b1588579612858c8d",
      "databaseBytes": 421888,
      "compressedSha256": "8019fe4554198739b17aaca6fc4cc9c6968f07a3f21361cfb7e5032aab027229",
      "provenance": {
        "kind": "archived_public_writer",
        "syntheticStorageOnly": true,
        "providerEffects": 0,
        "rawLogicalWrites": false,
        "versionRestamped": false,
        "migrationStageImage": false
      },
      "gzipSha256": "8019fe4554198739b17aaca6fc4cc9c6968f07a3f21361cfb7e5032aab027229",
      "gzipBytes": 14028,
      "snapshotSha256": "76c0ac703daa0d69d8dd0e74f1e993e0586b09dfd35e62f4c31acbfd913ce2eb",
      "schemaSha256": "a54b2dd4ac6261d904d205e069c06bbdd3c1301c45be1a029010aea2da909d10",
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
          "applied_at": 17001
        },
        {
          "version": 19,
          "applied_at": 17001
        },
        {
          "version": 20,
          "applied_at": 17001
        },
        {
          "version": 21,
          "applied_at": 17001
        },
        {
          "version": 22,
          "applied_at": 17001
        },
        {
          "version": 23,
          "applied_at": 17001
        },
        {
          "version": 24,
          "applied_at": 17001
        },
        {
          "version": 25,
          "applied_at": 17001
        }
      ],
      "rowCounts": {
        "daemon_state": 1,
        "desktop_switch_authority": 1,
        "desktop_switch_resolutions": 0,
        "desktop_switches": 0,
        "migrations": 25,
        "mutation_attempts": 0,
        "mutation_effect_evidence": 0,
        "mutation_resolutions": 0,
        "profiles": 1,
        "projects": 0,
        "provider_interaction_transitions": 0,
        "provider_interactions": 0,
        "provider_login_authorities": 0,
        "queue_effect_evidence": 0,
        "queue_effect_resolutions": 0,
        "queue_entries": 0,
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
    }
  }
} as const;
export type CanonicalLabelPresetScenario = keyof typeof canonicalLabelPresetFixture.captures;
const images = {
  "canonical17-account-collision": "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",
  "canonical17-project-collision": "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",
  "canonical17-approval-controls": "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",
  "canonical25-preset": "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"
} as const;

export function canonicalLabelPresetDatabaseBytes(scenario: CanonicalLabelPresetScenario): Uint8Array {
  const metadata = canonicalLabelPresetFixture.captures[scenario];
  const recipe = readFileSync(new URL("./canonical-label-preset-generator.original.ts.txt", import.meta.url));
  if (createHash("sha256").update(recipe).digest("hex") !== canonicalLabelPresetFixture.generatorSha256) {
    throw new Error("CANONICAL_LABEL_PRESET_GENERATOR_MISMATCH");
  }
  const compressed = Buffer.from(images[scenario], "base64");
  if (compressed.length !== metadata.gzipBytes
    || createHash("sha256").update(compressed).digest("hex") !== metadata.gzipSha256) {
    throw new Error("CANONICAL_LABEL_PRESET_COMPRESSED_MISMATCH");
  }
  const bytes = gunzipSync(compressed, { maxOutputLength: metadata.databaseBytes });
  if (bytes.byteLength !== metadata.databaseBytes
    || createHash("sha256").update(bytes).digest("hex") !== metadata.databaseSha256) {
    throw new Error("CANONICAL_LABEL_PRESET_IMAGE_MISMATCH");
  }
  return bytes;
}
