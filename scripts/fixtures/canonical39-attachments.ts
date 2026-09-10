import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

// Exact archived public writers with synthetic terminal receipts. These
// images preserve original unsafe names, not native execution or blob proof.
export const canonical39AttachmentFixtures = {
  "send": {
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
    "scenario": "send",
    "generatorSha256": "234f92ad3269388d93c6f240746967aab42fbf035a2cbd5d4eb30d6a2fb3fda3",
    "dependencyManifestSha256": {
      "@agentclientprotocol/sdk": "89bbcd7a71a3cd6e94b7096ef1f239dda62b5fb8aef840d3475af3fbfff3a955",
      "@hraness/oh": "ad5ea2f55afd7f2147558e8ee0ae73d6d38c96d9ae8ec97dc3aebf6d5dd5b05b",
      "@openai/codex": "4ecf4eae28684c5fcba8b9a63b946ce22b8cc2e451750f23c04e5088cf4c7a05",
      "convex": "aa9f5baee26b69a88d6b61180e540cce1f52baa31094e7124c8c0393e4b3211e",
      "zod": "c630bd10b52dcf71c112a2bf78dbf2734b9db58d62de663b8d86c2ec2c8cda2e"
    },
    "bootId": "boot_f3ee518e44e34c12a658fb3d6103ecdb",
    "daemonGeneration": 1,
    "originalUnusedUsageRevision": 1,
    "usageObservations": 0,
    "profile": {
      "id": "acct_24c4cd77ab7e4b7db8bb528811cf42fe",
      "label": "Synthetic historical attachment send",
      "state": "signed_in",
      "processGeneration": 1,
      "providerEmail": "historical-attachments@example.com",
      "providerPlan": "Plus",
      "createdAt": 39043,
      "updatedAt": 39043
    },
    "project": {
      "id": "proj_28adf313b7a64f08bb296516a66b6216",
      "label": "Synthetic historical attachment",
      "rootPath": "/opt/homebrew",
      "default": true,
      "createdAt": 39043,
      "updatedAt": 39043
    },
    "session": {
      "id": "sess_c37429664222442ebc7eeedf996cf544",
      "profileId": "acct_24c4cd77ab7e4b7db8bb528811cf42fe",
      "projectId": "proj_28adf313b7a64f08bb296516a66b6216",
      "providerThreadId": "synthetic-historical-attachment-send",
      "title": "Untitled session",
      "note": "",
      "provider": "codex",
      "preset": "high",
      "fastEnabled": false,
      "state": "idle",
      "providerUpdatedAt": 39043,
      "revision": 3,
      "createdAt": 39043,
      "updatedAt": 39043
    },
    "runtime": {
      "profileId": "acct_24c4cd77ab7e4b7db8bb528811cf42fe",
      "processGeneration": 1,
      "observedAt": 39043,
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
    "idempotencyKey": "2202972a-9684-4456-9811-d8dbfefb42d6",
    "request": {
      "message": "Synthetic archived send with exact unsafe names",
      "attachments": [
        {
          "byteLength": 11,
          "digest": "8a6c3fb92571d4c2baf29c5a5b55ca197ec9706c8be007534f6751e8131b2fec",
          "mediaType": "text/plain",
          "name": "legacy notes.txt"
        },
        {
          "byteLength": 11,
          "digest": "8a6c3fb92571d4c2baf29c5a5b55ca197ec9706c8be007534f6751e8131b2fec",
          "mediaType": "text/plain",
          "name": "legacy notes.txt"
        },
        {
          "byteLength": 11,
          "digest": "8a6c3fb92571d4c2baf29c5a5b55ca197ec9706c8be007534f6751e8131b2fec",
          "mediaType": "text/plain",
          "name": "legacy�notes.txt"
        }
      ]
    },
    "attachments": [
      {
        "byteLength": 11,
        "digest": "8a6c3fb92571d4c2baf29c5a5b55ca197ec9706c8be007534f6751e8131b2fec",
        "mediaType": "text/plain",
        "name": "legacy notes.txt"
      },
      {
        "byteLength": 11,
        "digest": "8a6c3fb92571d4c2baf29c5a5b55ca197ec9706c8be007534f6751e8131b2fec",
        "mediaType": "text/plain",
        "name": "legacy notes.txt"
      },
      {
        "byteLength": 11,
        "digest": "8a6c3fb92571d4c2baf29c5a5b55ca197ec9706c8be007534f6751e8131b2fec",
        "mediaType": "text/plain",
        "name": "legacy�notes.txt"
      }
    ],
    "rawNames": [
      "legacy notes.txt",
      "legacy notes.txt",
      "legacy�notes.txt"
    ],
    "manifest": [
      {
        "byteLength": 11,
        "digest": "8a6c3fb92571d4c2baf29c5a5b55ca197ec9706c8be007534f6751e8131b2fec",
        "mediaType": "text/plain",
        "name": "legacy notes.txt"
      },
      {
        "byteLength": 11,
        "digest": "8a6c3fb92571d4c2baf29c5a5b55ca197ec9706c8be007534f6751e8131b2fec",
        "mediaType": "text/plain",
        "name": "legacy notes.txt"
      },
      {
        "byteLength": 11,
        "digest": "8a6c3fb92571d4c2baf29c5a5b55ca197ec9706c8be007534f6751e8131b2fec",
        "mediaType": "text/plain",
        "name": "legacy�notes.txt"
      }
    ],
    "mutation": {
      "id": "attempt_186cea5d4fa8442c9dde41671c96eef4",
      "idempotencyKey": "2202972a-9684-4456-9811-d8dbfefb42d6",
      "kind": "session.send",
      "authorityId": "sess_c37429664222442ebc7eeedf996cf544",
      "authorityGeneration": 1,
      "requestDigest": "817b718bbe545281a7fdc5e0c587f7cd6ab1d7ec1dbb640646b1de4cfe6bbdd2",
      "state": "applied",
      "result": {
        "turnId": "synthetic-attachment-turn",
        "status": "completed",
        "sourceId": "attempt_186cea5d4fa8442c9dde41671c96eef4",
        "effectiveRuntimeProfile": {
          "profileId": "acct_24c4cd77ab7e4b7db8bb528811cf42fe",
          "processGeneration": 1,
          "observedAt": 39043,
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
        "attemptId": "attempt_186cea5d4fa8442c9dde41671c96eef4",
        "digest": "38feaf203688feab2b53ff05f1e2997aa00b35ea623ff800a344b13f53576255",
        "evidence": {
          "kind": "session.send",
          "providerThreadId": "synthetic-historical-attachment-send",
          "baseline": {
            "providerUpdatedAt": 39043,
            "status": "idle",
            "activeTurnId": null
          },
          "clientMessageId": "attempt_186cea5d4fa8442c9dde41671c96eef4",
          "messageDigest": "1d9df9da42205786cd722ca357b16af0ddc6e731167610b428c828868d277242",
          "runtimeProfile": {
            "profileId": "acct_24c4cd77ab7e4b7db8bb528811cf42fe",
            "processGeneration": 1,
            "observedAt": 39043,
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
        "recordedAt": 39043
      }
    },
    "startIdempotencyKey": "5b9e7eb6-b177-42af-898a-0b6e4690e0c6",
    "startMutation": {
      "id": "attempt_501398bbca7c4ad9bd76c7ceffae56c1",
      "idempotencyKey": "5b9e7eb6-b177-42af-898a-0b6e4690e0c6",
      "kind": "session.start",
      "authorityId": "acct_24c4cd77ab7e4b7db8bb528811cf42fe",
      "authorityGeneration": 1,
      "requestDigest": "6db5e54e6cf50de472df80a3fa21c4396b40f8b2a081f62e895a78707b886fdb",
      "state": "applied",
      "result": {
        "sessionId": "sess_c37429664222442ebc7eeedf996cf544",
        "sourceId": "attempt_501398bbca7c4ad9bd76c7ceffae56c1",
        "effectiveRuntimeProfile": {
          "profileId": "acct_24c4cd77ab7e4b7db8bb528811cf42fe",
          "processGeneration": 1,
          "observedAt": 39043,
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
        "attemptId": "attempt_501398bbca7c4ad9bd76c7ceffae56c1",
        "digest": "99debf006edcfcaec3cc856734ad454c68139a02f7a65456e2d044cd7c4ce338",
        "evidence": {
          "kind": "session.start",
          "projectId": "proj_28adf313b7a64f08bb296516a66b6216",
          "clientMessageId": null,
          "messageDigest": null,
          "runtimeProfile": {
            "profileId": "acct_24c4cd77ab7e4b7db8bb528811cf42fe",
            "processGeneration": 1,
            "observedAt": 39043,
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
        "recordedAt": 39043
      },
      "sessionStartId": "sess_c37429664222442ebc7eeedf996cf544"
    },
    "primerIdempotencyKey": null,
    "primerMutation": null,
    "expectedReceipt": {
      "turnId": "synthetic-attachment-turn",
      "status": "completed",
      "sourceId": "attempt_186cea5d4fa8442c9dde41671c96eef4",
      "effectiveRuntimeProfile": {
        "profileId": "acct_24c4cd77ab7e4b7db8bb528811cf42fe",
        "processGeneration": 1,
        "observedAt": 39043,
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
    "databaseSha256": "941741343626c45df53b13193bfb2076e407f1faa23af7c1a9f0a17cf51d6952",
    "gzipBytes": 44341,
    "gzipSha256": "edec9569d3950703a1d01c60213bf08f48c43e7ea052da8284472e56c3265be4",
    "snapshotSha256": "58f3d68177de030ecd98e19c159674d2f7c61400ca282704720d4131ada5cf27",
    "schemaSha256": "fa72b050f4f174ef15ea97abb4d627a7774f2cd14b034c823d1488aa2a6b01ed",
    "ledger": [
      {
        "version": 1,
        "applied_at": 39043
      },
      {
        "version": 10,
        "applied_at": 39043
      },
      {
        "version": 11,
        "applied_at": 39043
      },
      {
        "version": 12,
        "applied_at": 39043
      },
      {
        "version": 13,
        "applied_at": 39043
      },
      {
        "version": 14,
        "applied_at": 39043
      },
      {
        "version": 15,
        "applied_at": 39043
      },
      {
        "version": 16,
        "applied_at": 39043
      },
      {
        "version": 17,
        "applied_at": 39043
      },
      {
        "version": 18,
        "applied_at": 39043
      },
      {
        "version": 19,
        "applied_at": 39043
      },
      {
        "version": 2,
        "applied_at": 39043
      },
      {
        "version": 20,
        "applied_at": 39043
      },
      {
        "version": 21,
        "applied_at": 39043
      },
      {
        "version": 22,
        "applied_at": 39043
      },
      {
        "version": 23,
        "applied_at": 39043
      },
      {
        "version": 24,
        "applied_at": 39043
      },
      {
        "version": 25,
        "applied_at": 39043
      },
      {
        "version": 26,
        "applied_at": 39043
      },
      {
        "version": 27,
        "applied_at": 39043
      },
      {
        "version": 28,
        "applied_at": 39043
      },
      {
        "version": 29,
        "applied_at": 39043
      },
      {
        "version": 3,
        "applied_at": 39043
      },
      {
        "version": 30,
        "applied_at": 39043
      },
      {
        "version": 31,
        "applied_at": 39043
      },
      {
        "version": 32,
        "applied_at": 39043
      },
      {
        "version": 33,
        "applied_at": 39043
      },
      {
        "version": 34,
        "applied_at": 39043
      },
      {
        "version": 35,
        "applied_at": 39043
      },
      {
        "version": 36,
        "applied_at": 39043
      },
      {
        "version": 37,
        "applied_at": 39043
      },
      {
        "version": 38,
        "applied_at": 39043
      },
      {
        "version": 39,
        "applied_at": 39043
      },
      {
        "version": 4,
        "applied_at": 39043
      },
      {
        "version": 5,
        "applied_at": 39043
      },
      {
        "version": 6,
        "applied_at": 39043
      },
      {
        "version": 7,
        "applied_at": 39043
      },
      {
        "version": 8,
        "applied_at": 39043
      },
      {
        "version": 9,
        "applied_at": 39043
      }
    ],
    "archivedRowsAndSchemaReopensUnchanged": true,
    "archivedReadonlyImageUnchanged": true,
    "attachmentBlobFilesCreated": 0,
    "proofScope": "exact archived public StateStore APIs with synthetic terminal send/steer receipts and original names; no native execution or blob possession proof"
  },
  "steer": {
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
    "scenario": "steer",
    "generatorSha256": "234f92ad3269388d93c6f240746967aab42fbf035a2cbd5d4eb30d6a2fb3fda3",
    "dependencyManifestSha256": {
      "@agentclientprotocol/sdk": "89bbcd7a71a3cd6e94b7096ef1f239dda62b5fb8aef840d3475af3fbfff3a955",
      "@hraness/oh": "ad5ea2f55afd7f2147558e8ee0ae73d6d38c96d9ae8ec97dc3aebf6d5dd5b05b",
      "@openai/codex": "4ecf4eae28684c5fcba8b9a63b946ce22b8cc2e451750f23c04e5088cf4c7a05",
      "convex": "aa9f5baee26b69a88d6b61180e540cce1f52baa31094e7124c8c0393e4b3211e",
      "zod": "c630bd10b52dcf71c112a2bf78dbf2734b9db58d62de663b8d86c2ec2c8cda2e"
    },
    "bootId": "boot_1bad0099c0344362b76a09dc662a956e",
    "daemonGeneration": 1,
    "originalUnusedUsageRevision": 1,
    "usageObservations": 0,
    "profile": {
      "id": "acct_34754d375bc04a3182f006793bd65718",
      "label": "Synthetic historical attachment steer",
      "state": "signed_in",
      "processGeneration": 1,
      "providerEmail": "historical-attachments@example.com",
      "providerPlan": "Plus",
      "createdAt": 39043,
      "updatedAt": 39043
    },
    "project": {
      "id": "proj_256c6ae4246b4095b14e28e46a339819",
      "label": "Synthetic historical attachment",
      "rootPath": "/opt/homebrew",
      "default": true,
      "createdAt": 39043,
      "updatedAt": 39043
    },
    "session": {
      "id": "sess_c1c9821624f94ee09b0d4741a9cf1361",
      "profileId": "acct_34754d375bc04a3182f006793bd65718",
      "projectId": "proj_256c6ae4246b4095b14e28e46a339819",
      "providerThreadId": "synthetic-historical-attachment-steer",
      "title": "Untitled session",
      "note": "",
      "provider": "codex",
      "preset": "high",
      "fastEnabled": false,
      "state": "active",
      "activeTurnId": "synthetic-primer-turn",
      "providerUpdatedAt": 39043,
      "revision": 3,
      "createdAt": 39043,
      "updatedAt": 39043
    },
    "runtime": {
      "profileId": "acct_34754d375bc04a3182f006793bd65718",
      "processGeneration": 1,
      "observedAt": 39043,
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
    "idempotencyKey": "ef1b01c2-c0a4-4b64-bf09-8082c24b982d",
    "request": {
      "message": "Synthetic archived steer with exact unsafe names",
      "attachments": [
        {
          "byteLength": 11,
          "digest": "8a6c3fb92571d4c2baf29c5a5b55ca197ec9706c8be007534f6751e8131b2fec",
          "mediaType": "text/plain",
          "name": "legacy notes.txt"
        },
        {
          "byteLength": 11,
          "digest": "8a6c3fb92571d4c2baf29c5a5b55ca197ec9706c8be007534f6751e8131b2fec",
          "mediaType": "text/plain",
          "name": "legacy notes.txt"
        },
        {
          "byteLength": 11,
          "digest": "8a6c3fb92571d4c2baf29c5a5b55ca197ec9706c8be007534f6751e8131b2fec",
          "mediaType": "text/plain",
          "name": "legacy�notes.txt"
        }
      ]
    },
    "attachments": [
      {
        "byteLength": 11,
        "digest": "8a6c3fb92571d4c2baf29c5a5b55ca197ec9706c8be007534f6751e8131b2fec",
        "mediaType": "text/plain",
        "name": "legacy notes.txt"
      },
      {
        "byteLength": 11,
        "digest": "8a6c3fb92571d4c2baf29c5a5b55ca197ec9706c8be007534f6751e8131b2fec",
        "mediaType": "text/plain",
        "name": "legacy notes.txt"
      },
      {
        "byteLength": 11,
        "digest": "8a6c3fb92571d4c2baf29c5a5b55ca197ec9706c8be007534f6751e8131b2fec",
        "mediaType": "text/plain",
        "name": "legacy�notes.txt"
      }
    ],
    "rawNames": [
      "legacy notes.txt",
      "legacy notes.txt",
      "legacy�notes.txt"
    ],
    "manifest": [
      {
        "byteLength": 11,
        "digest": "8a6c3fb92571d4c2baf29c5a5b55ca197ec9706c8be007534f6751e8131b2fec",
        "mediaType": "text/plain",
        "name": "legacy notes.txt"
      },
      {
        "byteLength": 11,
        "digest": "8a6c3fb92571d4c2baf29c5a5b55ca197ec9706c8be007534f6751e8131b2fec",
        "mediaType": "text/plain",
        "name": "legacy notes.txt"
      },
      {
        "byteLength": 11,
        "digest": "8a6c3fb92571d4c2baf29c5a5b55ca197ec9706c8be007534f6751e8131b2fec",
        "mediaType": "text/plain",
        "name": "legacy�notes.txt"
      }
    ],
    "mutation": {
      "id": "attempt_197ab486919d4cb3a9cf7fdb857ee87b",
      "idempotencyKey": "ef1b01c2-c0a4-4b64-bf09-8082c24b982d",
      "kind": "session.steer",
      "authorityId": "sess_c1c9821624f94ee09b0d4741a9cf1361",
      "authorityGeneration": 1,
      "requestDigest": "38e74d38d007902de40479aa645e5990bca0ba27823dfef3846812ee98f4cced",
      "state": "applied",
      "result": {
        "steered": true,
        "activeTurnId": "synthetic-primer-turn"
      },
      "evidence": {
        "attemptId": "attempt_197ab486919d4cb3a9cf7fdb857ee87b",
        "digest": "caaebef20834e550c1a9959e7c3f150ece91e127935bf8281b626e1903bbbb50",
        "evidence": {
          "kind": "session.steer",
          "providerThreadId": "synthetic-historical-attachment-steer",
          "baseline": {
            "providerUpdatedAt": 39043,
            "status": "active",
            "activeTurnId": "synthetic-primer-turn"
          },
          "activeTurnId": "synthetic-primer-turn",
          "clientMessageId": "attempt_197ab486919d4cb3a9cf7fdb857ee87b",
          "messageDigest": "4e93c99c373949a2ee52cfb54d4692ac748e6a1ac8edc060ff271c196e074904"
        },
        "recordedAt": 39043
      }
    },
    "startIdempotencyKey": "c658ea32-464b-4f89-a15d-2455f5ef3fe6",
    "startMutation": {
      "id": "attempt_23a2d34867db4fd299d428bf51363bd5",
      "idempotencyKey": "c658ea32-464b-4f89-a15d-2455f5ef3fe6",
      "kind": "session.start",
      "authorityId": "acct_34754d375bc04a3182f006793bd65718",
      "authorityGeneration": 1,
      "requestDigest": "3b06e2a84ad72e087992dd905530242a68dbcca4588f6bcde9ff54e810a23e65",
      "state": "applied",
      "result": {
        "sessionId": "sess_c1c9821624f94ee09b0d4741a9cf1361",
        "sourceId": "attempt_23a2d34867db4fd299d428bf51363bd5",
        "effectiveRuntimeProfile": {
          "profileId": "acct_34754d375bc04a3182f006793bd65718",
          "processGeneration": 1,
          "observedAt": 39043,
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
        "attemptId": "attempt_23a2d34867db4fd299d428bf51363bd5",
        "digest": "3080cadf2b1581e2bd30eb7f824501122f83b3edf64e6446d25edc16902e9b65",
        "evidence": {
          "kind": "session.start",
          "projectId": "proj_256c6ae4246b4095b14e28e46a339819",
          "clientMessageId": null,
          "messageDigest": null,
          "runtimeProfile": {
            "profileId": "acct_34754d375bc04a3182f006793bd65718",
            "processGeneration": 1,
            "observedAt": 39043,
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
        "recordedAt": 39043
      },
      "sessionStartId": "sess_c1c9821624f94ee09b0d4741a9cf1361"
    },
    "primerIdempotencyKey": "61808789-c801-4584-8e3a-50e6ba5149e5",
    "primerMutation": {
      "id": "attempt_9dea4ee6c11b4b06b0d27ac05fe67fd0",
      "idempotencyKey": "61808789-c801-4584-8e3a-50e6ba5149e5",
      "kind": "session.send",
      "authorityId": "sess_c1c9821624f94ee09b0d4741a9cf1361",
      "authorityGeneration": 1,
      "requestDigest": "e08c65b114f4a1379fd3c87cf23ffa60210550a951215371515c99e71dfcd099",
      "state": "applied",
      "result": {
        "turnId": "synthetic-primer-turn",
        "status": "inProgress",
        "sourceId": "attempt_9dea4ee6c11b4b06b0d27ac05fe67fd0",
        "effectiveRuntimeProfile": {
          "profileId": "acct_34754d375bc04a3182f006793bd65718",
          "processGeneration": 1,
          "observedAt": 39043,
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
        "attemptId": "attempt_9dea4ee6c11b4b06b0d27ac05fe67fd0",
        "digest": "282576fb2c925dcfe67342eaaf42a19cdb330b1c879c65944d498cbc68e49870",
        "evidence": {
          "kind": "session.send",
          "providerThreadId": "synthetic-historical-attachment-steer",
          "baseline": {
            "providerUpdatedAt": 39043,
            "status": "idle",
            "activeTurnId": null
          },
          "clientMessageId": "attempt_9dea4ee6c11b4b06b0d27ac05fe67fd0",
          "messageDigest": "870b87371deba1d8ba5c8c9274ea45e798be4011053cef7837e3160dc298011f",
          "runtimeProfile": {
            "profileId": "acct_34754d375bc04a3182f006793bd65718",
            "processGeneration": 1,
            "observedAt": 39043,
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
        "recordedAt": 39043
      }
    },
    "expectedReceipt": {
      "steered": true,
      "activeTurnId": "synthetic-primer-turn"
    },
    "databaseBytes": 1175552,
    "databaseSha256": "688d96a14b8baa2dc609d62535a5653ef76ce56cf00554f91113f06b37d2f6f9",
    "gzipBytes": 44766,
    "gzipSha256": "6c5a5f53256c8be595bb3729c37d5e4c1622408a5a7b95473138dfea9c553a5e",
    "snapshotSha256": "04ee5170a2cffb8ef66fb0873a0e6ec3cda50f83de5898651bdd20a16e3a0a9d",
    "schemaSha256": "fa72b050f4f174ef15ea97abb4d627a7774f2cd14b034c823d1488aa2a6b01ed",
    "ledger": [
      {
        "version": 1,
        "applied_at": 39043
      },
      {
        "version": 10,
        "applied_at": 39043
      },
      {
        "version": 11,
        "applied_at": 39043
      },
      {
        "version": 12,
        "applied_at": 39043
      },
      {
        "version": 13,
        "applied_at": 39043
      },
      {
        "version": 14,
        "applied_at": 39043
      },
      {
        "version": 15,
        "applied_at": 39043
      },
      {
        "version": 16,
        "applied_at": 39043
      },
      {
        "version": 17,
        "applied_at": 39043
      },
      {
        "version": 18,
        "applied_at": 39043
      },
      {
        "version": 19,
        "applied_at": 39043
      },
      {
        "version": 2,
        "applied_at": 39043
      },
      {
        "version": 20,
        "applied_at": 39043
      },
      {
        "version": 21,
        "applied_at": 39043
      },
      {
        "version": 22,
        "applied_at": 39043
      },
      {
        "version": 23,
        "applied_at": 39043
      },
      {
        "version": 24,
        "applied_at": 39043
      },
      {
        "version": 25,
        "applied_at": 39043
      },
      {
        "version": 26,
        "applied_at": 39043
      },
      {
        "version": 27,
        "applied_at": 39043
      },
      {
        "version": 28,
        "applied_at": 39043
      },
      {
        "version": 29,
        "applied_at": 39043
      },
      {
        "version": 3,
        "applied_at": 39043
      },
      {
        "version": 30,
        "applied_at": 39043
      },
      {
        "version": 31,
        "applied_at": 39043
      },
      {
        "version": 32,
        "applied_at": 39043
      },
      {
        "version": 33,
        "applied_at": 39043
      },
      {
        "version": 34,
        "applied_at": 39043
      },
      {
        "version": 35,
        "applied_at": 39043
      },
      {
        "version": 36,
        "applied_at": 39043
      },
      {
        "version": 37,
        "applied_at": 39043
      },
      {
        "version": 38,
        "applied_at": 39043
      },
      {
        "version": 39,
        "applied_at": 39043
      },
      {
        "version": 4,
        "applied_at": 39043
      },
      {
        "version": 5,
        "applied_at": 39043
      },
      {
        "version": 6,
        "applied_at": 39043
      },
      {
        "version": 7,
        "applied_at": 39043
      },
      {
        "version": 8,
        "applied_at": 39043
      },
      {
        "version": 9,
        "applied_at": 39043
      }
    ],
    "archivedRowsAndSchemaReopensUnchanged": true,
    "archivedReadonlyImageUnchanged": true,
    "attachmentBlobFilesCreated": 0,
    "proofScope": "exact archived public StateStore APIs with synthetic terminal send/steer receipts and original names; no native execution or blob possession proof"
  }
} as const;

export type Canonical39AttachmentScenario = keyof typeof canonical39AttachmentFixtures;
const images = {
  "send": "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",
  "steer": "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"
} as const;

export function canonical39AttachmentDatabaseBytes(scenario: Canonical39AttachmentScenario): Uint8Array {
  const metadata = canonical39AttachmentFixtures[scenario];
  const recipe = readFileSync(new URL("./canonical39-attachments-generator.original.ts.txt", import.meta.url));
  if (createHash("sha256").update(recipe).digest("hex") !== metadata.generatorSha256) {
    throw new Error("CANONICAL39_ATTACHMENT_GENERATOR_MISMATCH");
  }
  const compressed = Buffer.from(images[scenario], "base64");
  if (compressed.length !== metadata.gzipBytes
    || createHash("sha256").update(compressed).digest("hex") !== metadata.gzipSha256) {
    throw new Error("CANONICAL39_ATTACHMENT_COMPRESSED_MISMATCH");
  }
  const bytes = gunzipSync(compressed, { maxOutputLength: metadata.databaseBytes });
  if (bytes.byteLength !== metadata.databaseBytes
    || createHash("sha256").update(bytes).digest("hex") !== metadata.databaseSha256) {
    throw new Error("CANONICAL39_ATTACHMENT_IMAGE_MISMATCH");
  }
  return bytes;
}
