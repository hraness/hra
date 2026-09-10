import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";

// Source-pinned archived public storage output with synthetic inputs.
// No native provider, process launch, or transport authentication proof.
export const canonical38RuntimeFixture = {
  "generatorSha256": "471e32a90ff21422bf513b6c1bcf6cb33ded04449ab0f4f3409775cb0974838d",
  "bunVersion": "1.3.14",
  "sources": {
    "canonical38": {
      "commit": "a35d8f2e02833f752aab9ac716b3a96b6c5e449b",
      "tree": "15382f740abdd24e76a32e3aebafa10c8ff5d43a",
      "sourceFileCount": 267,
      "manifest": "9bf742767c4fbcbe14c6fb77c837fc92b9c9de57c564a4e9375d159776024e81",
      "pins": {
        "src/storage/state-store.ts": "46b9ee2fc46379283742fee4cd222fd9a092ebe5a258b02f38b57a156937fab1",
        "package.json": "ed19d38bdc178935b720798ff79b1be72f2540913a93e5a7549a0775961daa71",
        "bun.lock": "b66ab5fd314deb7b2dc221bebc80ce14f6cd1c192ab9ac8ce4a2882e9bab5b38"
      }
    }
  },
  "dependencies": {
    "@hraness/oh": "0.2.7",
    "@openai/codex": "0.153.2",
    "convex": "1.45.0",
    "zod": "4.4.3"
  },
  "dependencyManifestHashes": {
    "@hraness/oh": "ad5ea2f55afd7f2147558e8ee0ae73d6d38c96d9ae8ec97dc3aebf6d5dd5b05b",
    "@openai/codex": "4ecf4eae28684c5fcba8b9a63b946ce22b8cc2e451750f23c04e5088cf4c7a05",
    "convex": "aa9f5baee26b69a88d6b61180e540cce1f52baa31094e7124c8c0393e4b3211e",
    "zod": "c630bd10b52dcf71c112a2bf78dbf2734b9db58d62de663b8d86c2ec2c8cda2e"
  },
  "databaseSha256": "51126603f010fd0883aec3e17064f90ec0c3fdc6df2ffc44c8926ac407ae2037",
  "databaseBytes": 1163264,
  "provenance": {
    "syntheticStorageOnly": true,
    "providerOperations": 0,
    "nativeObservations": false,
    "publicArchivedWritersOnly": true,
    "rawRowOrSchemaWrites": false,
    "noCurrentProviderAccountAuthority": true,
    "archivedReadonlyBytesUnchanged": true
  },
  "retained": {
    "bootId": "boot_88888888888888888888888888888888",
    "daemonGeneration": 1,
    "first": {
      "id": "acct_e4f995917ea9438ea647ad58d6a2b39b",
      "label": "Canonical38 earlier signed out",
      "state": "signed_out",
      "processGeneration": 0,
      "createdAt": 38000,
      "updatedAt": 38000
    },
    "signedIn": {
      "id": "acct_e3ccb1e999164aa292f3c79741272e6d",
      "label": "Canonical38 source",
      "state": "signed_in",
      "processGeneration": 1,
      "providerEmail": "canonical38-source@example.com",
      "providerPlan": "Plus",
      "createdAt": 38001,
      "updatedAt": 38001
    },
    "target": {
      "id": "acct_c829cb868aa647bdb18c09b6d59290a5",
      "label": "Canonical38 target",
      "state": "signed_in",
      "processGeneration": 1,
      "providerEmail": "canonical38-target@example.com",
      "providerPlan": "Plus",
      "createdAt": 38002,
      "updatedAt": 38002
    },
    "restartTarget": {
      "id": "acct_e23d35cd5f7d48c0ba84b275b3ecc287",
      "label": "Canonical38 restart target",
      "state": "signed_in",
      "processGeneration": 1,
      "providerEmail": "canonical38-restart@example.com",
      "providerPlan": "Plus",
      "createdAt": 38003,
      "updatedAt": 38003
    },
    "advanced": {
      "profile": {
        "id": "acct_e23d35cd5f7d48c0ba84b275b3ecc287",
        "label": "Canonical38 restart target",
        "state": "signed_in",
        "processGeneration": 2,
        "providerEmail": "canonical38-restart@example.com",
        "providerPlan": "Plus",
        "createdAt": 38003,
        "updatedAt": 38200
      },
      "affectedWorkIds": []
    },
    "codex": {
      "session": {
        "id": "sess_dfa34724543d4cd09f5e4bf5d4d6dd6b",
        "profileId": "acct_e3ccb1e999164aa292f3c79741272e6d",
        "title": "canonical38-codex",
        "note": "",
        "provider": "codex",
        "preset": "high",
        "fastEnabled": false,
        "state": "starting",
        "revision": 1,
        "createdAt": 38003,
        "updatedAt": 38003
      },
      "runtime": {
        "profileId": "acct_e3ccb1e999164aa292f3c79741272e6d",
        "processGeneration": 1,
        "observedAt": 38003,
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
      "record": {
        "sessionId": "sess_dfa34724543d4cd09f5e4bf5d4d6dd6b",
        "revision": 1,
        "sourceKind": "session_start",
        "sourceId": "canonical38-codex",
        "profile": {
          "profileId": "acct_e3ccb1e999164aa292f3c79741272e6d",
          "processGeneration": 1,
          "observedAt": 38003,
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
        "recordedAt": 38003
      }
    },
    "claude": {
      "session": {
        "id": "sess_7faa768bdfae4617b724252099a2e6b9",
        "profileId": "acct_e3ccb1e999164aa292f3c79741272e6d",
        "title": "canonical38-claude",
        "note": "",
        "provider": "claude",
        "preset": "fable-max",
        "fastEnabled": false,
        "state": "starting",
        "revision": 1,
        "createdAt": 38003,
        "updatedAt": 38003
      },
      "runtime": {
        "profileId": "acct_e3ccb1e999164aa292f3c79741272e6d",
        "processGeneration": 1,
        "observedAt": 38003,
        "preset": "fable-max",
        "model": "claude-fable-5-1",
        "reasoningEffort": "max",
        "claudeVersion": "2.1.260",
        "permissionMode": "default",
        "isolatedConfigDir": true,
        "outputFormat": "stream-json",
        "inputFormat": "stream-json"
      },
      "record": {
        "sessionId": "sess_7faa768bdfae4617b724252099a2e6b9",
        "revision": 1,
        "sourceKind": "session_start",
        "sourceId": "canonical38-claude",
        "profile": {
          "profileId": "acct_e3ccb1e999164aa292f3c79741272e6d",
          "processGeneration": 1,
          "observedAt": 38003,
          "preset": "fable-max",
          "model": "claude-fable-5-1",
          "reasoningEffort": "max",
          "claudeVersion": "2.1.260",
          "permissionMode": "default",
          "isolatedConfigDir": true,
          "outputFormat": "stream-json",
          "inputFormat": "stream-json"
        },
        "recordedAt": 38003
      }
    },
    "conflictingBaseline": {
      "session": {
        "id": "sess_83642a3884f04ef68405577d214fed5f",
        "profileId": "acct_e3ccb1e999164aa292f3c79741272e6d",
        "title": "canonical38-conflicting-baseline",
        "note": "",
        "provider": "claude",
        "preset": "fable-max",
        "fastEnabled": false,
        "state": "starting",
        "revision": 1,
        "createdAt": 38003,
        "updatedAt": 38003
      },
      "runtime": {
        "profileId": "acct_e3ccb1e999164aa292f3c79741272e6d",
        "processGeneration": 1,
        "observedAt": 38003,
        "preset": "fable-max",
        "model": "claude-fable-5-1",
        "reasoningEffort": "max",
        "claudeVersion": "2.1.260",
        "permissionMode": "default",
        "isolatedConfigDir": true,
        "outputFormat": "stream-json",
        "inputFormat": "stream-json"
      },
      "record": {
        "sessionId": "sess_83642a3884f04ef68405577d214fed5f",
        "revision": 1,
        "sourceKind": "session_start",
        "sourceId": "canonical38-conflicting-baseline",
        "profile": {
          "profileId": "acct_e3ccb1e999164aa292f3c79741272e6d",
          "processGeneration": 1,
          "observedAt": 38003,
          "preset": "fable-max",
          "model": "claude-fable-5-1",
          "reasoningEffort": "max",
          "claudeVersion": "2.1.260",
          "permissionMode": "default",
          "isolatedConfigDir": true,
          "outputFormat": "stream-json",
          "inputFormat": "stream-json"
        },
        "recordedAt": 38003
      }
    },
    "invalidLatestBaseline": {
      "session": {
        "id": "sess_6b2da319b0ec4591bdcaed822bf75f50",
        "profileId": "acct_e3ccb1e999164aa292f3c79741272e6d",
        "title": "canonical38-invalid-latest-baseline",
        "note": "",
        "provider": "codex",
        "preset": "high",
        "fastEnabled": false,
        "state": "starting",
        "revision": 1,
        "createdAt": 38003,
        "updatedAt": 38003
      },
      "runtime": {
        "profileId": "acct_e3ccb1e999164aa292f3c79741272e6d",
        "processGeneration": 1,
        "observedAt": 38003,
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
      "record": {
        "sessionId": "sess_6b2da319b0ec4591bdcaed822bf75f50",
        "revision": 1,
        "sourceKind": "session_start",
        "sourceId": "canonical38-invalid-latest-baseline",
        "profile": {
          "profileId": "acct_e3ccb1e999164aa292f3c79741272e6d",
          "processGeneration": 1,
          "observedAt": 38003,
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
        "recordedAt": 38003
      }
    },
    "revisionPrecedence": {
      "session": {
        "id": "sess_975ed8da48a4479c86e57a18e8664703",
        "profileId": "acct_e3ccb1e999164aa292f3c79741272e6d",
        "title": "canonical38-revision-precedence",
        "note": "",
        "provider": "claude",
        "preset": "fable-max",
        "fastEnabled": false,
        "state": "starting",
        "revision": 1,
        "createdAt": 38003,
        "updatedAt": 38003
      },
      "runtime": {
        "profileId": "acct_e3ccb1e999164aa292f3c79741272e6d",
        "processGeneration": 1,
        "observedAt": 38003,
        "preset": "fable-max",
        "model": "claude-fable-5-1",
        "reasoningEffort": "max",
        "claudeVersion": "2.1.260",
        "permissionMode": "default",
        "isolatedConfigDir": true,
        "outputFormat": "stream-json",
        "inputFormat": "stream-json"
      },
      "record": {
        "sessionId": "sess_975ed8da48a4479c86e57a18e8664703",
        "revision": 1,
        "sourceKind": "session_start",
        "sourceId": "canonical38-revision-precedence",
        "profile": {
          "profileId": "acct_e3ccb1e999164aa292f3c79741272e6d",
          "processGeneration": 1,
          "observedAt": 38003,
          "preset": "fable-max",
          "model": "claude-fable-5-1",
          "reasoningEffort": "max",
          "claudeVersion": "2.1.260",
          "permissionMode": "default",
          "isolatedConfigDir": true,
          "outputFormat": "stream-json",
          "inputFormat": "stream-json"
        },
        "recordedAt": 38003
      },
      "second": {
        "sessionId": "sess_975ed8da48a4479c86e57a18e8664703",
        "revision": 2,
        "sourceKind": "session_start",
        "sourceId": "canonical38-revision-precedence-second",
        "profile": {
          "profileId": "acct_e3ccb1e999164aa292f3c79741272e6d",
          "processGeneration": 1,
          "observedAt": 37998,
          "preset": "fable-max",
          "model": "claude-fable-5-1",
          "reasoningEffort": "max",
          "claudeVersion": "2.1.260",
          "permissionMode": "default",
          "isolatedConfigDir": true,
          "outputFormat": "stream-json",
          "inputFormat": "stream-json"
        },
        "recordedAt": 37999
      }
    },
    "unproved": {
      "session": {
        "id": "sess_aeb91ae032544063aa18bdc003a4babb",
        "profileId": "acct_e3ccb1e999164aa292f3c79741272e6d",
        "providerThreadId": "canonical38-unproved-synthetic-thread",
        "title": "Canonical38 unproved",
        "note": "",
        "provider": "codex",
        "preset": "high",
        "fastEnabled": false,
        "state": "idle",
        "revision": 1,
        "createdAt": 38100,
        "updatedAt": 38100
      },
      "queue": {
        "id": "queue_5047226050674db299e35d1bc63404d2",
        "sessionId": "sess_aeb91ae032544063aa18bdc003a4babb",
        "message": "Canonical38 unproved queue body",
        "state": "pending",
        "createdAt": 38100,
        "updatedAt": 38100
      },
      "interaction": {
        "version": 1,
        "publicId": "38000000-0000-4000-8000-000000000001",
        "sessionId": "sess_aeb91ae032544063aa18bdc003a4babb",
        "authority": {
          "profileId": "acct_e3ccb1e999164aa292f3c79741272e6d",
          "processGeneration": 1,
          "connectionId": "38000000-0000-4000-8000-000000000002",
          "requestId": {
            "type": "string",
            "value": "canonical38-unproved-request"
          },
          "method": "item/commandExecution/requestApproval",
          "requestDigest": "31d498eb8b268073ac135d3e81ab767f529c7a40662fbb3d5c5c9238894fd5da",
          "threadId": "canonical38-unproved-synthetic-thread",
          "turnId": "canonical38-unproved-turn",
          "itemId": "canonical38-unproved-item",
          "approvalId": null
        },
        "kind": "command_approval",
        "state": "pending",
        "revision": 1,
        "blocking": true,
        "display": {
          "kind": "command_approval",
          "summary": "Synthetic archived approval",
          "reason": null,
          "commandClass": "test",
          "workingDirectory": null,
          "availableDecisions": [
            "once",
            "session",
            "decline",
            "cancel"
          ]
        },
        "responseDigest": null,
        "intendedTerminalState": null,
        "resolvedBy": null,
        "requestedAt": 38100,
        "deadlineAt": 1838100,
        "updatedAt": 38100,
        "terminalAt": null
      },
      "mutationKey": "38000000-0000-4000-8000-000000000003",
      "mutation": {
        "id": "attempt_616e1021e3af43fa91b7f3e5506c45a3",
        "idempotencyKey": "38000000-0000-4000-8000-000000000003",
        "kind": "session.rename",
        "authorityId": "sess_aeb91ae032544063aa18bdc003a4babb",
        "authorityGeneration": 1,
        "requestDigest": "18577538fced97d988ebc48b45945fe4bc51881fc43df35c9f3589a3a4c952bb",
        "state": "effect_started"
      },
      "event": {
        "version": 1,
        "sessionId": "sess_aeb91ae032544063aa18bdc003a4babb",
        "streamEpoch": "2627353a-f59a-414b-90ca-e71d717855b9",
        "sequence": 1,
        "recordedAt": 38100,
        "accountId": "acct_e3ccb1e999164aa292f3c79741272e6d",
        "providerGeneration": 1,
        "providerConnectionId": null,
        "body": {
          "type": "warning",
          "code": "UNPROVED",
          "message": "Synthetic unproved source"
        }
      }
    },
    "switched": {
      "original": {
        "session": {
          "id": "sess_fd7d9638ffef4f9182bec760d9acc427",
          "profileId": "acct_e3ccb1e999164aa292f3c79741272e6d",
          "providerThreadId": "canonical38-switched-synthetic-thread",
          "title": "canonical38-switched",
          "note": "",
          "provider": "codex",
          "preset": "high",
          "fastEnabled": false,
          "state": "idle",
          "providerUpdatedAt": 38100,
          "revision": 2,
          "createdAt": 38100,
          "updatedAt": 38100
        },
        "runtime": {
          "profileId": "acct_e3ccb1e999164aa292f3c79741272e6d",
          "processGeneration": 1,
          "observedAt": 38100,
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
        "record": {
          "sessionId": "sess_fd7d9638ffef4f9182bec760d9acc427",
          "revision": 1,
          "sourceKind": "session_start",
          "sourceId": "canonical38-switched",
          "profile": {
            "profileId": "acct_e3ccb1e999164aa292f3c79741272e6d",
            "processGeneration": 1,
            "observedAt": 38100,
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
          "recordedAt": 38100
        }
      },
      "session": {
        "id": "sess_fd7d9638ffef4f9182bec760d9acc427",
        "profileId": "acct_c829cb868aa647bdb18c09b6d59290a5",
        "providerThreadId": "canonical38-completed-synthetic-target",
        "title": "canonical38-switched",
        "note": "",
        "provider": "claude",
        "preset": "fable-max",
        "fastEnabled": false,
        "state": "idle",
        "revision": 3,
        "createdAt": 38100,
        "updatedAt": 38100
      },
      "event": {
        "version": 1,
        "sessionId": "sess_fd7d9638ffef4f9182bec760d9acc427",
        "streamEpoch": "cff9afcf-911f-4006-980e-b893d3be21ea",
        "sequence": 1,
        "recordedAt": 38100,
        "accountId": "acct_e3ccb1e999164aa292f3c79741272e6d",
        "providerGeneration": 1,
        "providerConnectionId": null,
        "body": {
          "type": "warning",
          "code": "SOURCE_PROVIDER",
          "message": "Canonical38 immutable source event"
        }
      },
      "queue": {
        "id": "queue_6a4f5bdeec6d415fbee15d691f3baba9",
        "sessionId": "sess_fd7d9638ffef4f9182bec760d9acc427",
        "message": "[queue message removed after settlement]",
        "state": "failed",
        "createdAt": 38100,
        "updatedAt": 38100
      },
      "queueEffect": {
        "queueId": "queue_6a4f5bdeec6d415fbee15d691f3baba9",
        "digest": "e90851741712c5fb61377da64266616031075101e744cd627c1d7b9c5a3ce0c0",
        "evidence": {
          "kind": "queue.dispatch",
          "queueId": "queue_6a4f5bdeec6d415fbee15d691f3baba9",
          "sessionId": "sess_fd7d9638ffef4f9182bec760d9acc427",
          "providerThreadId": "canonical38-switched-synthetic-thread",
          "profileGeneration": 1,
          "baseline": {
            "providerUpdatedAt": 38100,
            "status": "idle",
            "activeTurnId": null
          },
          "clientMessageId": "queue_6a4f5bdeec6d415fbee15d691f3baba9",
          "messageDigest": "ddb6bbf0e4ffa373ac9571be6e4b4f03fbfc1f6a88da0b892c1e359d812a3de5",
          "runtimeProfile": {
            "profileId": "acct_e3ccb1e999164aa292f3c79741272e6d",
            "processGeneration": 1,
            "observedAt": 38100,
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
        "recordedAt": 38100
      },
      "switch": {
        "key": "38000000-0000-4000-8000-000000000004",
        "attempt": {
          "id": "attempt_b5301a6f19954488a8a858728e6cad0c",
          "state": "prepared",
          "replay": false
        },
        "effect": {
          "attemptId": "attempt_b5301a6f19954488a8a858728e6cad0c",
          "digest": "59977a231e7fcf82320df278364437da4b9ff97b2a660a16c189277ec3fd7728",
          "evidence": {
            "kind": "session.switch",
            "daemonGeneration": 1,
            "requestedAccountId": "acct_c829cb868aa647bdb18c09b6d59290a5",
            "requestedPreset": "fable-max",
            "sourceProfileId": "acct_e3ccb1e999164aa292f3c79741272e6d",
            "sourceProcessGeneration": 1,
            "sourceProvider": "codex",
            "sourceProviderThreadId": "canonical38-switched-synthetic-thread",
            "sourcePreset": "high",
            "targetProfileId": "acct_c829cb868aa647bdb18c09b6d59290a5",
            "targetProcessGeneration": 1,
            "targetProvider": "claude",
            "targetPreset": "fable-max",
            "transcriptDigest": "bf7a162e55223d2f6743f76d8ae5d8233f264e1ab4915298ef16059550c2f561",
            "seedDigest": "f685b28f7e0642314064f12e4a47023e962884b2834e43ce99129f9a64d2148c",
            "seedIncludedRecords": 1,
            "seedOmittedRecords": 0,
            "runtimeProfile": {
              "profileId": "acct_c829cb868aa647bdb18c09b6d59290a5",
              "processGeneration": 1,
              "observedAt": 38100,
              "preset": "fable-max",
              "model": "claude-fable-5-1",
              "reasoningEffort": "max",
              "claudeVersion": "2.1.260",
              "permissionMode": "default",
              "isolatedConfigDir": true,
              "outputFormat": "stream-json",
              "inputFormat": "stream-json"
            }
          },
          "recordedAt": 38100
        },
        "runtime": {
          "profileId": "acct_c829cb868aa647bdb18c09b6d59290a5",
          "processGeneration": 1,
          "observedAt": 38100,
          "preset": "fable-max",
          "model": "claude-fable-5-1",
          "reasoningEffort": "max",
          "claudeVersion": "2.1.260",
          "permissionMode": "default",
          "isolatedConfigDir": true,
          "outputFormat": "stream-json",
          "inputFormat": "stream-json"
        },
        "evidence": {
          "kind": "session.switch",
          "daemonGeneration": 1,
          "requestedAccountId": "acct_c829cb868aa647bdb18c09b6d59290a5",
          "requestedPreset": "fable-max",
          "runtimeProfile": {
            "profileId": "acct_c829cb868aa647bdb18c09b6d59290a5",
            "processGeneration": 1,
            "observedAt": 38100,
            "preset": "fable-max",
            "model": "claude-fable-5-1",
            "reasoningEffort": "max",
            "claudeVersion": "2.1.260",
            "permissionMode": "default",
            "isolatedConfigDir": true,
            "outputFormat": "stream-json",
            "inputFormat": "stream-json"
          },
          "transcriptDigest": "bf7a162e55223d2f6743f76d8ae5d8233f264e1ab4915298ef16059550c2f561",
          "seedDigest": "f685b28f7e0642314064f12e4a47023e962884b2834e43ce99129f9a64d2148c",
          "seedIncludedRecords": 1,
          "seedOmittedRecords": 0,
          "sourcePreset": "high",
          "sourceProfileId": "acct_e3ccb1e999164aa292f3c79741272e6d",
          "sourceProcessGeneration": 1,
          "sourceProvider": "codex",
          "sourceProviderThreadId": "canonical38-switched-synthetic-thread",
          "targetPreset": "fable-max",
          "targetProfileId": "acct_c829cb868aa647bdb18c09b6d59290a5",
          "targetProcessGeneration": 1,
          "targetProvider": "claude"
        }
      },
      "receipt": {
        "id": "attempt_b5301a6f19954488a8a858728e6cad0c",
        "idempotencyKey": "38000000-0000-4000-8000-000000000004",
        "kind": "session.switch",
        "authorityId": "sess_fd7d9638ffef4f9182bec760d9acc427",
        "authorityGeneration": 1,
        "requestDigest": "9989a3575824d157655e50f14b7a4667e2c496977b6d002f8dfa063e6aa87ad5",
        "state": "applied",
        "result": {
          "from": {
            "account": "acct_e3ccb1e999164aa292f3c79741272e6d",
            "preset": "high",
            "provider": "codex"
          },
          "providerThreadId": "canonical38-completed-synthetic-target",
          "request": {
            "accountId": "acct_c829cb868aa647bdb18c09b6d59290a5",
            "preset": "fable-max",
            "provider": "claude"
          },
          "seed": {
            "digest": "f685b28f7e0642314064f12e4a47023e962884b2834e43ce99129f9a64d2148c",
            "includedRecords": 1,
            "omittedRecords": 0,
            "status": "completed"
          },
          "sessionId": "sess_fd7d9638ffef4f9182bec760d9acc427",
          "to": {
            "account": "acct_c829cb868aa647bdb18c09b6d59290a5",
            "preset": "fable-max",
            "provider": "claude"
          },
          "transcriptDigest": "bf7a162e55223d2f6743f76d8ae5d8233f264e1ab4915298ef16059550c2f561",
          "turnId": "canonical38-completed-synthetic-turn",
          "session": {
            "createdAt": 38100,
            "fastEnabled": false,
            "id": "sess_fd7d9638ffef4f9182bec760d9acc427",
            "note": "",
            "preset": "fable-max",
            "profileId": "acct_c829cb868aa647bdb18c09b6d59290a5",
            "provider": "claude",
            "providerThreadId": "canonical38-completed-synthetic-target",
            "revision": 3,
            "state": "idle",
            "title": "canonical38-switched",
            "updatedAt": 38100
          }
        },
        "evidence": {
          "attemptId": "attempt_b5301a6f19954488a8a858728e6cad0c",
          "digest": "59977a231e7fcf82320df278364437da4b9ff97b2a660a16c189277ec3fd7728",
          "evidence": {
            "kind": "session.switch",
            "daemonGeneration": 1,
            "requestedAccountId": "acct_c829cb868aa647bdb18c09b6d59290a5",
            "requestedPreset": "fable-max",
            "sourceProfileId": "acct_e3ccb1e999164aa292f3c79741272e6d",
            "sourceProcessGeneration": 1,
            "sourceProvider": "codex",
            "sourceProviderThreadId": "canonical38-switched-synthetic-thread",
            "sourcePreset": "high",
            "targetProfileId": "acct_c829cb868aa647bdb18c09b6d59290a5",
            "targetProcessGeneration": 1,
            "targetProvider": "claude",
            "targetPreset": "fable-max",
            "transcriptDigest": "bf7a162e55223d2f6743f76d8ae5d8233f264e1ab4915298ef16059550c2f561",
            "seedDigest": "f685b28f7e0642314064f12e4a47023e962884b2834e43ce99129f9a64d2148c",
            "seedIncludedRecords": 1,
            "seedOmittedRecords": 0,
            "runtimeProfile": {
              "profileId": "acct_c829cb868aa647bdb18c09b6d59290a5",
              "processGeneration": 1,
              "observedAt": 38100,
              "preset": "fable-max",
              "model": "claude-fable-5-1",
              "reasoningEffort": "max",
              "claudeVersion": "2.1.260",
              "permissionMode": "default",
              "isolatedConfigDir": true,
              "outputFormat": "stream-json",
              "inputFormat": "stream-json"
            }
          },
          "recordedAt": 38100
        }
      },
      "progress": {
        "sourceReleased": true,
        "targetReleased": false,
        "seed": {
          "clientMessageId": "attempt_b5301a6f19954488a8a858728e6cad0c",
          "runtimeProfile": {
            "profileId": "acct_c829cb868aa647bdb18c09b6d59290a5",
            "processGeneration": 1,
            "observedAt": 38100,
            "preset": "fable-max",
            "model": "claude-fable-5-1",
            "reasoningEffort": "max",
            "claudeVersion": "2.1.260",
            "permissionMode": "default",
            "isolatedConfigDir": true,
            "outputFormat": "stream-json",
            "inputFormat": "stream-json"
          },
          "text": "Canonical38 synthetic provider switch seed."
        },
        "seedTurnId": "canonical38-completed-synthetic-turn",
        "seedTurnStatus": "completed",
        "targetProviderThreadId": "canonical38-completed-synthetic-target"
      }
    },
    "pendingSwitch": {
      "source": {
        "session": {
          "id": "sess_dfa524d420c94010aa993226ff5fcd33",
          "profileId": "acct_e3ccb1e999164aa292f3c79741272e6d",
          "providerThreadId": "canonical38-pending-switch-synthetic-thread",
          "title": "canonical38-pending-switch",
          "note": "",
          "provider": "codex",
          "preset": "high",
          "fastEnabled": false,
          "state": "idle",
          "providerUpdatedAt": 38100,
          "revision": 2,
          "createdAt": 38100,
          "updatedAt": 38100
        },
        "runtime": {
          "profileId": "acct_e3ccb1e999164aa292f3c79741272e6d",
          "processGeneration": 1,
          "observedAt": 38100,
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
        "record": {
          "sessionId": "sess_dfa524d420c94010aa993226ff5fcd33",
          "revision": 1,
          "sourceKind": "session_start",
          "sourceId": "canonical38-pending-switch",
          "profile": {
            "profileId": "acct_e3ccb1e999164aa292f3c79741272e6d",
            "processGeneration": 1,
            "observedAt": 38100,
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
          "recordedAt": 38100
        }
      },
      "key": "38000000-0000-4000-8000-000000000005",
      "attempt": {
        "id": "attempt_90e09745d09a4587a73129ce4e15fef4",
        "state": "prepared",
        "replay": false
      },
      "effect": {
        "attemptId": "attempt_90e09745d09a4587a73129ce4e15fef4",
        "digest": "1a09e80ac5864f1fb20bff6fe2c1681b1017f7fc1490c10504379dd671c3c02c",
        "evidence": {
          "kind": "session.switch",
          "daemonGeneration": 1,
          "requestedAccountId": "acct_e23d35cd5f7d48c0ba84b275b3ecc287",
          "requestedPreset": "fable-max",
          "sourceProfileId": "acct_e3ccb1e999164aa292f3c79741272e6d",
          "sourceProcessGeneration": 1,
          "sourceProvider": "codex",
          "sourceProviderThreadId": "canonical38-pending-switch-synthetic-thread",
          "sourcePreset": "high",
          "targetProfileId": "acct_e23d35cd5f7d48c0ba84b275b3ecc287",
          "targetProcessGeneration": 1,
          "targetProvider": "claude",
          "targetPreset": "fable-max",
          "transcriptDigest": "0dd90747f426d4d81d414019926e2731b8cfb2d83c710d6c7845761336c5544e",
          "seedDigest": "dea59cf8ac345f511d9c7f3d00ee6fa6d42c6415697de20d071c1a86e8075f88",
          "seedIncludedRecords": 1,
          "seedOmittedRecords": 0,
          "runtimeProfile": {
            "profileId": "acct_e23d35cd5f7d48c0ba84b275b3ecc287",
            "processGeneration": 1,
            "observedAt": 38100,
            "preset": "fable-max",
            "model": "claude-fable-5-1",
            "reasoningEffort": "max",
            "claudeVersion": "2.1.260",
            "permissionMode": "default",
            "isolatedConfigDir": true,
            "outputFormat": "stream-json",
            "inputFormat": "stream-json"
          }
        },
        "recordedAt": 38100
      },
      "runtime": {
        "profileId": "acct_e23d35cd5f7d48c0ba84b275b3ecc287",
        "processGeneration": 1,
        "observedAt": 38100,
        "preset": "fable-max",
        "model": "claude-fable-5-1",
        "reasoningEffort": "max",
        "claudeVersion": "2.1.260",
        "permissionMode": "default",
        "isolatedConfigDir": true,
        "outputFormat": "stream-json",
        "inputFormat": "stream-json"
      },
      "evidence": {
        "kind": "session.switch",
        "daemonGeneration": 1,
        "requestedAccountId": "acct_e23d35cd5f7d48c0ba84b275b3ecc287",
        "requestedPreset": "fable-max",
        "runtimeProfile": {
          "profileId": "acct_e23d35cd5f7d48c0ba84b275b3ecc287",
          "processGeneration": 1,
          "observedAt": 38100,
          "preset": "fable-max",
          "model": "claude-fable-5-1",
          "reasoningEffort": "max",
          "claudeVersion": "2.1.260",
          "permissionMode": "default",
          "isolatedConfigDir": true,
          "outputFormat": "stream-json",
          "inputFormat": "stream-json"
        },
        "transcriptDigest": "0dd90747f426d4d81d414019926e2731b8cfb2d83c710d6c7845761336c5544e",
        "seedDigest": "dea59cf8ac345f511d9c7f3d00ee6fa6d42c6415697de20d071c1a86e8075f88",
        "seedIncludedRecords": 1,
        "seedOmittedRecords": 0,
        "sourcePreset": "high",
        "sourceProfileId": "acct_e3ccb1e999164aa292f3c79741272e6d",
        "sourceProcessGeneration": 1,
        "sourceProvider": "codex",
        "sourceProviderThreadId": "canonical38-pending-switch-synthetic-thread",
        "targetPreset": "fable-max",
        "targetProfileId": "acct_e23d35cd5f7d48c0ba84b275b3ecc287",
        "targetProcessGeneration": 1,
        "targetProvider": "claude"
      },
      "mutation": {
        "id": "attempt_90e09745d09a4587a73129ce4e15fef4",
        "idempotencyKey": "38000000-0000-4000-8000-000000000005",
        "kind": "session.switch",
        "authorityId": "sess_dfa524d420c94010aa993226ff5fcd33",
        "authorityGeneration": 1,
        "requestDigest": "039757517626fade7e5ab98fcd94c427013a9494a1f2c69d9d68ad775115b564",
        "state": "effect_started",
        "evidence": {
          "attemptId": "attempt_90e09745d09a4587a73129ce4e15fef4",
          "digest": "1a09e80ac5864f1fb20bff6fe2c1681b1017f7fc1490c10504379dd671c3c02c",
          "evidence": {
            "kind": "session.switch",
            "daemonGeneration": 1,
            "requestedAccountId": "acct_e23d35cd5f7d48c0ba84b275b3ecc287",
            "requestedPreset": "fable-max",
            "sourceProfileId": "acct_e3ccb1e999164aa292f3c79741272e6d",
            "sourceProcessGeneration": 1,
            "sourceProvider": "codex",
            "sourceProviderThreadId": "canonical38-pending-switch-synthetic-thread",
            "sourcePreset": "high",
            "targetProfileId": "acct_e23d35cd5f7d48c0ba84b275b3ecc287",
            "targetProcessGeneration": 1,
            "targetProvider": "claude",
            "targetPreset": "fable-max",
            "transcriptDigest": "0dd90747f426d4d81d414019926e2731b8cfb2d83c710d6c7845761336c5544e",
            "seedDigest": "dea59cf8ac345f511d9c7f3d00ee6fa6d42c6415697de20d071c1a86e8075f88",
            "seedIncludedRecords": 1,
            "seedOmittedRecords": 0,
            "runtimeProfile": {
              "profileId": "acct_e23d35cd5f7d48c0ba84b275b3ecc287",
              "processGeneration": 1,
              "observedAt": 38100,
              "preset": "fable-max",
              "model": "claude-fable-5-1",
              "reasoningEffort": "max",
              "claudeVersion": "2.1.260",
              "permissionMode": "default",
              "isolatedConfigDir": true,
              "outputFormat": "stream-json",
              "inputFormat": "stream-json"
            }
          },
          "recordedAt": 38100
        }
      }
    }
  },
  "snapshot": {
    "sha256": "81b538e7a6fc3e7502960d48494ddb83bf9ede3a04581043c19f2b93aad65ae1",
    "schemaSha256": "fc88d36660857b2fb8b97e40b88e9bccab1f42b0403098abd1ff917a5ae9c4b9",
    "version": {
      "user_version": 38
    },
    "ledger": [
      {
        "version": 1,
        "applied_at": 38000
      },
      {
        "version": 2,
        "applied_at": 38000
      },
      {
        "version": 3,
        "applied_at": 38000
      },
      {
        "version": 4,
        "applied_at": 38000
      },
      {
        "version": 5,
        "applied_at": 38000
      },
      {
        "version": 6,
        "applied_at": 38000
      },
      {
        "version": 7,
        "applied_at": 38000
      },
      {
        "version": 8,
        "applied_at": 38000
      },
      {
        "version": 9,
        "applied_at": 38000
      },
      {
        "version": 10,
        "applied_at": 38000
      },
      {
        "version": 11,
        "applied_at": 38000
      },
      {
        "version": 12,
        "applied_at": 38000
      },
      {
        "version": 13,
        "applied_at": 38000
      },
      {
        "version": 14,
        "applied_at": 38000
      },
      {
        "version": 15,
        "applied_at": 38000
      },
      {
        "version": 16,
        "applied_at": 38000
      },
      {
        "version": 17,
        "applied_at": 38000
      },
      {
        "version": 18,
        "applied_at": 38000
      },
      {
        "version": 19,
        "applied_at": 38000
      },
      {
        "version": 20,
        "applied_at": 38000
      },
      {
        "version": 21,
        "applied_at": 38000
      },
      {
        "version": 22,
        "applied_at": 38000
      },
      {
        "version": 23,
        "applied_at": 38000
      },
      {
        "version": 24,
        "applied_at": 38000
      },
      {
        "version": 25,
        "applied_at": 38000
      },
      {
        "version": 26,
        "applied_at": 38000
      },
      {
        "version": 27,
        "applied_at": 38000
      },
      {
        "version": 28,
        "applied_at": 38000
      },
      {
        "version": 29,
        "applied_at": 38000
      },
      {
        "version": 30,
        "applied_at": 38000
      },
      {
        "version": 31,
        "applied_at": 38000
      },
      {
        "version": 32,
        "applied_at": 38000
      },
      {
        "version": 33,
        "applied_at": 38000
      },
      {
        "version": 34,
        "applied_at": 38000
      },
      {
        "version": 35,
        "applied_at": 38000
      },
      {
        "version": 36,
        "applied_at": 38000
      },
      {
        "version": 37,
        "applied_at": 38000
      },
      {
        "version": 38,
        "applied_at": 38000
      }
    ],
    "rowCounts": {
      "account_rate_limit_reset_attempts": 0,
      "account_rate_limit_reset_policies": 4,
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
      "migrations": 38,
      "mutation_attempts": 3,
      "mutation_effect_evidence": 2,
      "mutation_resolutions": 0,
      "notification_hours": 1,
      "profiles": 4,
      "project_approval_modes": 0,
      "projects": 0,
      "provider_interaction_transitions": 1,
      "provider_interactions": 1,
      "provider_login_authorities": 0,
      "queue_effect_evidence": 1,
      "queue_effect_resolutions": 0,
      "queue_entries": 2,
      "queue_message_scrub_authority": 0,
      "queue_sequence_authority": 1,
      "security_scrub_authority": 0,
      "session_approval_modes": 0,
      "session_autorespond_counters": 0,
      "session_conversation_automation": 0,
      "session_event_streams": 8,
      "session_events": 4,
      "session_mutation_authority_rebinds": 1,
      "session_provider_switch_seed_intents": 1,
      "session_provider_switch_seed_results": 1,
      "session_provider_switch_source_releases": 1,
      "session_provider_switch_target_releases": 0,
      "session_provider_switch_targets": 1,
      "session_runtime_profiles": 10,
      "session_show_thinking": 0,
      "session_start_attempts": 0,
      "session_states": 0,
      "session_task_occurrences": 0,
      "session_task_receipts": 0,
      "session_tasks": 0,
      "session_turn_runtime_profiles": 1,
      "sessions": 8,
      "sqlite_sequence": 1,
      "turn_summaries": 0,
      "usage_cloud_upload_anchors": 0,
      "usage_poll_failures": 0,
      "usage_revision_authority": 4,
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

export const canonical38RuntimeGeneratorSource = "// Coordinator-reviewed execution only. Exact canonical38 public storage APIs\n// author every row. Synthetic runtime/seed observations are NOT provider calls.\n// No current authority, opaque-row repair, or released-stage relabeling is claimed.\nimport { createHash } from \"node:crypto\";\nimport { lstatSync, readdirSync, readFileSync } from \"node:fs\";\nimport { mkdir, writeFile } from \"node:fs/promises\";\nimport { join, relative } from \"node:path\";\nimport { Database } from \"bun:sqlite\";\nimport { z } from \"zod\";\n\nconst sha256 = (value: string | Uint8Array) => createHash(\"sha256\").update(value).digest(\"hex\");\nconst readBounded = (path: string, bytes = 8 * 1024 * 1024) => {\n  const stat = lstatSync(path);\n  if (!stat.isFile() || stat.size > bytes) throw new Error(\"CAPTURE_FILE_LIMIT\");\n  return readFileSync(path);\n};\nconst hostPrefixes = [[\"\", \"Users\", \"\"], [\"\", \"home\", \"\"], [\"\", \"private\", \"\"],\n  [\"\", \"tmp\", \"\"], [\"\", \"var\", \"folders\", \"\"]].map((parts) => parts.join(\"/\"));\nhostPrefixes.push([\"\", \"Users\", \"\"].join(\"\\\\\"));\nconst assertPrivatePathFree = (bytes: Uint8Array) => {\n  const value = Buffer.from(bytes);\n  for (const prefix of hostPrefixes) for (const needle of [\n    Buffer.from(prefix, \"utf8\"), Buffer.from(prefix, \"utf16le\"), Buffer.from(prefix, \"utf16le\").swap16(),\n  ]) {\n    if (value.includes(needle)) throw new Error(\"CAPTURE_HOST_PATH\");\n  }\n};\nconst recipe = readBounded(import.meta.filename, 64 * 1024);\nassertPrivatePathFree(recipe);\nif (Bun.version !== \"1.3.14\" || (lstatSync(import.meta.dir).mode & 0o777) !== 0o700) {\n  throw new Error(\"CAPTURE_RUNTIME_OR_DIRECTORY_MISMATCH\");\n}\nconst dependencies = { \"@hraness/oh\": \"0.2.7\", \"@openai/codex\": \"0.153.2\", convex: \"1.45.0\", zod: \"4.4.3\" } as const;\nconst dependencyManifestHashes: Readonly<Record<string, string>> = {\n  \"@hraness/oh\": \"ad5ea2f55afd7f2147558e8ee0ae73d6d38c96d9ae8ec97dc3aebf6d5dd5b05b\",\n  \"@openai/codex\": \"4ecf4eae28684c5fcba8b9a63b946ce22b8cc2e451750f23c04e5088cf4c7a05\",\n  \"convex\": \"aa9f5baee26b69a88d6b61180e540cce1f52baa31094e7124c8c0393e4b3211e\",\n  \"zod\": \"c630bd10b52dcf71c112a2bf78dbf2734b9db58d62de663b8d86c2ec2c8cda2e\"\n};\nconst sources = { canonical38: {\n  commit: \"a35d8f2e02833f752aab9ac716b3a96b6c5e449b\",\n  tree: \"15382f740abdd24e76a32e3aebafa10c8ff5d43a\",\n  sourceFileCount: 267,\n  manifest: \"9bf742767c4fbcbe14c6fb77c837fc92b9c9de57c564a4e9375d159776024e81\",\n  pins: {\n    \"src/storage/state-store.ts\": \"46b9ee2fc46379283742fee4cd222fd9a092ebe5a258b02f38b57a156937fab1\",\n    \"package.json\": \"ed19d38bdc178935b720798ff79b1be72f2540913a93e5a7549a0775961daa71\",\n    \"bun.lock\": \"b66ab5fd314deb7b2dc221bebc80ce14f6cd1c192ab9ac8ce4a2882e9bab5b38\",\n  },\n} } as const;\nconst verifySources = () => {\n  for (const [name, source] of Object.entries(sources)) {\n    const root = join(import.meta.dir, name);\n    for (const [path, expected] of Object.entries(source.pins)) {\n      if (sha256(readBounded(join(root, path))) !== expected) throw new Error(\"CAPTURE_SOURCE_MISMATCH\");\n    }\n    const files: { path: string; sha256: string }[] = [];\n    const visit = (directory: string) => {\n      for (const entry of readdirSync(directory, { withFileTypes: true })) {\n        if (!/^[A-Za-z0-9_.-]+$/u.test(entry.name)) throw new Error(\"CAPTURE_SOURCE_ENTRY_INVALID\");\n        const path = join(directory, entry.name);\n        if (entry.isDirectory()) visit(path);\n        else if (entry.isFile()) files.push({ path: relative(root, path), sha256: sha256(readBounded(path)) });\n        else throw new Error(\"CAPTURE_SOURCE_ENTRY_INVALID\");\n      }\n    };\n    visit(join(root, \"src\"));\n    files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);\n    if (files.length !== source.sourceFileCount || sha256(JSON.stringify(files)) !== source.manifest) {\n      throw new Error(\"CAPTURE_SOURCE_MANIFEST_MISMATCH\");\n    }\n    const declared = z.object({ dependencies: z.record(z.string(), z.string()) }).passthrough()\n      .parse(JSON.parse(readBounded(join(root, \"package.json\")).toString(\"utf8\")));\n    if (JSON.stringify(declared.dependencies) !== JSON.stringify(dependencies)) throw new Error(\"CAPTURE_DEPENDENCIES_MISMATCH\");\n    for (const [dependency, version] of Object.entries(dependencies)) {\n      const manifest = readBounded(join(root, \"node_modules\", dependency, \"package.json\"), 256 * 1024);\n      if (sha256(manifest) !== dependencyManifestHashes[dependency]) throw new Error(\"CAPTURE_DEPENDENCY_MANIFEST_MISMATCH\");\n      z.object({ name: z.literal(dependency), version: z.literal(version) }).passthrough()\n        .parse(JSON.parse(manifest.toString(\"utf8\")));\n    }\n  }\n};\nverifySources();\n\nconst identifier = (name: string) => {\n  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) throw new Error(\"CAPTURE_IDENTIFIER_INVALID\");\n  return `\"${name}\"`;\n};\nconst schemaRow = z.object({ type: z.string(), name: z.string(), tbl_name: z.string(), sql: z.string().nullable() }).strict();\nconst snapshot = (database: Database) => {\n  const schema = z.array(schemaRow).max(2048).parse(database.query(\n    \"SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name LIMIT 2049\").all());\n  const tables = schema.filter((entry) => entry.type === \"table\").map((entry) => entry.name).sort();\n  if (tables.length > 256) throw new Error(\"CAPTURE_TABLE_LIMIT\");\n  const rows: Record<string, unknown[]> = {};\n  const logicalText: string[] = [];\n  for (const table of tables) {\n    const columns = z.array(z.object({ name: z.string() }).passthrough()).max(128)\n      .parse(database.query(`PRAGMA table_xinfo(${identifier(table)})`).all());\n    const projection = columns.map(({ name }) => {\n      const quoted = identifier(name);\n      return `json_array(typeof(${quoted}),CASE WHEN typeof(${quoted}) IN ('text','blob') THEN hex(${quoted}) ELSE ${quoted} END) AS ${quoted}`;\n    }).join(\",\");\n    const selected = database.query(`SELECT ${projection} FROM ${identifier(table)} LIMIT 4097`).all();\n    if (selected.length > 4096) throw new Error(\"CAPTURE_ROW_LIMIT\");\n    rows[table] = selected.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));\n    logicalText.push(JSON.stringify(selected));\n  }\n  const result = { version: database.query(\"PRAGMA user_version\").get(),\n    ledger: database.query(\"SELECT * FROM migrations ORDER BY version\").all(),\n    foreignKeys: database.query(\"PRAGMA foreign_key_check\").all(), schema, rows };\n  if (Buffer.byteLength(JSON.stringify(result)) > 8 * 1024 * 1024) throw new Error(\"CAPTURE_SNAPSHOT_LIMIT\");\n  if (result.foreignKeys.length !== 0) throw new Error(\"CAPTURE_FOREIGN_KEYS_INVALID\");\n  return { result, logicalHex: logicalText.join(\"\") };\n};\nconst inspect = (path: string) => {\n  const database = new Database(path, { create: false, strict: true });\n  try {\n    database.exec(\"PRAGMA query_only=ON\");\n    const result = database.transaction(() => snapshot(database)).deferred();\n    z.object({ count: z.literal(0) }).strict().parse(database.query(\"SELECT total_changes() AS count\").get());\n    if (database.inTransaction) throw new Error(\"CAPTURE_INSPECTOR_TRANSACTION_LEAK\");\n    return result;\n  } finally { database.close(false); }\n};\nconst checkpoint = (path: string) => {\n  const database = new Database(path, { create: false, strict: true });\n  try {\n    z.object({ busy: z.literal(0), log: z.literal(0), checkpointed: z.literal(0) }).strict()\n      .parse(database.query(\"PRAGMA wal_checkpoint(TRUNCATE)\").get());\n  } finally { database.close(false); }\n};\n\n// Only now, after all source/dependency proofs, import the archived producer.\nconst { StateStore } = await import(\"./canonical38/src/storage/state-store\");\nconst { initializeStatePaths, resolveStatePaths } = await import(\"./canonical38/src/storage/paths\");\nconst { effectiveRuntimeProfileSchema, effectiveClaudeRuntimeProfileSchema } =\n  await import(\"./canonical38/src/domain/runtime-profile\");\nconst { presetRequirements } = await import(\"./canonical38/src/domain/presets\");\nconst capture = join(import.meta.dir, \"capture2\");\nawait mkdir(capture, { mode: 0o700 });\nconst paths = resolveStatePaths({ homeDirectory: join(capture, \"home\"), platform: \"darwin\" });\nawait initializeStatePaths(paths);\nlet now = 38_000;\nconst store = new StateStore(paths, { now: () => now, resolveMachineTimeZone: () => \"UTC\" });\nconst bootId = \"boot_\" + \"8\".repeat(32);\nconst daemonGeneration = store.nextDaemonGeneration(bootId);\nif (daemonGeneration !== 1) throw new Error(\"CAPTURE_DAEMON_INVALID\");\nconst first = store.createProfile(\"Canonical38 earlier signed out\");\nif (store.allocateNextUsageRevision(first.id) !== 1) throw new Error(\"CAPTURE_USAGE_RESERVATION_INVALID\");\nconst createSignedIn = (label: string, email: string) => {\n  const created = store.createProfile(label);\n  if (store.allocateNextUsageRevision(created.id) !== 1) throw new Error(\"CAPTURE_USAGE_RESERVATION_INVALID\");\n  const started = store.nextProfileGeneration(created.id);\n  if (!store.setProfileState(started.id, started.processGeneration, \"signed_in\", { email, plan: \"Plus\" })) {\n    throw new Error(\"CAPTURE_SIGNIN_REFUSED\");\n  }\n  return store.requireProfile(started.id);\n};\nnow = 38_001;\nconst signedIn = createSignedIn(\"Canonical38 source\", \"canonical38-source@example.com\");\nnow = 38_002;\nconst target = createSignedIn(\"Canonical38 target\", \"canonical38-target@example.com\");\nnow = 38_003;\nconst restartTarget = createSignedIn(\"Canonical38 restart target\", \"canonical38-restart@example.com\");\nif (!(first.createdAt < signedIn.createdAt && signedIn.createdAt < target.createdAt\n  && target.createdAt < restartTarget.createdAt)) throw new Error(\"CAPTURE_PROFILE_ORDER_INVALID\");\ntype Profile = ReturnType<typeof store.requireProfile>;\ntype Session = ReturnType<typeof store.requireSession>;\nconst codexRuntime = (profile: Profile, observedAt: number, session?: Session) => {\n  const requirement = session === undefined ? presetRequirements.high : store.requireSessionPresetRequirement(session.id).requirement;\n  return effectiveRuntimeProfileSchema.parse({\n    profileId: profile.id, processGeneration: profile.processGeneration, observedAt, preset: \"high\",\n    model: requirement.model, reasoningEffort: requirement.effort, serviceTier: null, fast: false,\n    approvalPolicy: \"on-request\", reviewMode: \"auto_review\", permissionProfile: \":workspace\",\n    computerUse: true, pluginCapability: true, enabledApps: [],\n  });\n};\nconst claudeRuntime = (profile: Profile, observedAt: number, session?: Session) => {\n  const requirement = session === undefined ? presetRequirements[\"fable-max\"] : store.requireSessionPresetRequirement(session.id).requirement;\n  return effectiveClaudeRuntimeProfileSchema.parse({\n    profileId: profile.id, processGeneration: profile.processGeneration, observedAt, preset: \"fable-max\",\n    model: requirement.model, reasoningEffort: requirement.effort, claudeVersion: \"2.1.260\",\n    permissionMode: \"default\", isolatedConfigDir: true, outputFormat: \"stream-json\", inputFormat: \"stream-json\",\n  });\n};\nconst sessionWithRuntime = (name: string, provider: \"codex\" | \"claude\", bound: boolean) => {\n  const initial = store.createSession({ profileId: signedIn.id, provider,\n    preset: provider === \"codex\" ? \"high\" : \"fable-max\", fastEnabled: false, title: name });\n  const runtime = provider === \"codex\" ? codexRuntime(signedIn, now, initial) : claudeRuntime(signedIn, now, initial);\n  const record = store.recordSessionRuntimeProfile({\n    sessionId: initial.id, sourceKind: \"session_start\", sourceId: name, profile: runtime,\n  });\n  const session = bound ? store.bindSession({\n    sessionId: initial.id, expectedRevision: initial.revision,\n    providerThreadId: name + \"-synthetic-thread\", providerUpdatedAt: now, state: \"idle\",\n  }) : initial;\n  return { session, runtime, record };\n};\nlet retained: unknown;\ntry {\n  const codex = sessionWithRuntime(\"canonical38-codex\", \"codex\", false);\n  const claude = sessionWithRuntime(\"canonical38-claude\", \"claude\", false);\n  // These two are valid archived baselines for separately labelled adversarial\n  // mismatch/latest-row test derivatives. This writer does not corrupt them.\n  const conflictingBaseline = sessionWithRuntime(\"canonical38-conflicting-baseline\", \"claude\", false);\n  const invalidLatestBaseline = sessionWithRuntime(\"canonical38-invalid-latest-baseline\", \"codex\", false);\n  const revisionPrecedence = sessionWithRuntime(\"canonical38-revision-precedence\", \"claude\", false);\n  now = 37_999;\n  const revisionSecond = store.recordSessionRuntimeProfile({\n    sessionId: revisionPrecedence.session.id, sourceKind: \"session_start\",\n    sourceId: \"canonical38-revision-precedence-second\",\n    profile: claudeRuntime(signedIn, 37_998, revisionPrecedence.session),\n  });\n  now = 38_100;\n  if (revisionSecond.revision !== revisionPrecedence.record.revision + 1\n    || revisionSecond.recordedAt >= revisionPrecedence.record.recordedAt\n    || JSON.stringify(store.latestSessionRuntimeProfile(revisionPrecedence.session.id)) !== JSON.stringify(revisionSecond)) {\n    throw new Error(\"CAPTURE_REVISION_PRECEDENCE_INVALID\");\n  }\n  const unproved = store.upsertProviderSession({ profileId: signedIn.id,\n    providerThreadId: \"canonical38-unproved-synthetic-thread\", title: \"Canonical38 unproved\", state: \"idle\" });\n  const unprovedQueue = store.enqueue(unproved.id, \"Canonical38 unproved queue body\");\n  const unprovedInteraction = store.admitInteraction({\n    publicId: \"38000000-0000-4000-8000-000000000001\", sessionId: unproved.id,\n    authority: {\n      profileId: signedIn.id, processGeneration: signedIn.processGeneration,\n      connectionId: \"38000000-0000-4000-8000-000000000002\",\n      requestId: { type: \"string\", value: \"canonical38-unproved-request\" },\n      method: \"item/commandExecution/requestApproval\", requestDigest: sha256(\"canonical38 synthetic approval\"),\n      threadId: unproved.providerThreadId ?? null, turnId: \"canonical38-unproved-turn\",\n      itemId: \"canonical38-unproved-item\", approvalId: null,\n    }, kind: \"command_approval\", blocking: true,\n    display: { kind: \"command_approval\", summary: \"Synthetic archived approval\",\n      reason: null, commandClass: \"test\", workingDirectory: null,\n      availableDecisions: [\"once\", \"session\", \"decline\", \"cancel\"] },\n  }).record;\n  const unprovedKey = \"38000000-0000-4000-8000-000000000003\";\n  const unprovedMutation = store.prepareMutation({\n    authorityId: unproved.id, authorityGeneration: signedIn.processGeneration,\n    idempotencyKey: unprovedKey, kind: \"session.rename\", request: { name: \"Canonical38 unresolved rename\" },\n  });\n  if (!store.transitionMutation(unprovedMutation.id, \"prepared\", \"effect_started\")) {\n    throw new Error(\"CAPTURE_UNPROVED_MUTATION_INVALID\");\n  }\n  const unprovedEvent = store.appendSessionEvent({ sessionId: unproved.id,\n    accountId: signedIn.id, providerGeneration: signedIn.processGeneration, providerConnectionId: null,\n    body: { type: \"warning\", code: \"UNPROVED\", message: \"Synthetic unproved source\" } });\n\n  const switched = sessionWithRuntime(\"canonical38-switched\", \"codex\", true);\n  const historicalEvent = store.appendSessionEvent({\n    sessionId: switched.session.id, accountId: signedIn.id,\n    providerGeneration: signedIn.processGeneration, providerConnectionId: null,\n    body: { type: \"warning\", code: \"SOURCE_PROVIDER\", message: \"Canonical38 immutable source event\" },\n  });\n  const queueMessage = \"Canonical38 immutable source queue\";\n  const historicalQueue = store.enqueue(switched.session.id, queueMessage);\n  const historicalQueueEffect = store.beginQueueEffect({\n    queueId: historicalQueue.id, sessionId: switched.session.id, profileGeneration: signedIn.processGeneration,\n    evidence: { kind: \"queue.dispatch\", queueId: historicalQueue.id, sessionId: switched.session.id,\n      profileGeneration: signedIn.processGeneration, providerThreadId: switched.session.providerThreadId!,\n      clientMessageId: historicalQueue.id, messageDigest: sha256(queueMessage),\n      baseline: { status: \"idle\", activeTurnId: null, providerUpdatedAt: switched.session.providerUpdatedAt ?? null },\n      runtimeProfile: switched.runtime },\n  });\n  if (!store.failQueueEffect(historicalQueue.id)) throw new Error(\"CAPTURE_QUEUE_FAILURE_NOT_RECORDED\");\n\n  const beginSwitch = (source: typeof switched, destination: Profile, key: string, seedText: string) => {\n    if (source.session.providerThreadId === undefined) throw new Error(\"CAPTURE_SWITCH_THREAD_MISSING\");\n    const runtime = claudeRuntime(destination, now);\n    const attempt = store.prepareMutation({ kind: \"session.switch\", authorityId: source.session.id,\n      authorityGeneration: destination.processGeneration, idempotencyKey: key,\n      request: { accountId: destination.id, preset: \"fable-max\", provider: \"claude\" } });\n    const evidence = {\n      kind: \"session.switch\" as const, daemonGeneration,\n      requestedAccountId: destination.id, requestedPreset: \"fable-max\" as const,\n      runtimeProfile: runtime, transcriptDigest: sha256(\"Canonical38 synthetic transcript \" + key),\n      seedDigest: sha256(\"hra:session-transcript-seed:v1\\0\" + seedText),\n      seedIncludedRecords: 1, seedOmittedRecords: 0,\n      sourcePreset: \"high\" as const, sourceProfileId: signedIn.id,\n      sourceProcessGeneration: signedIn.processGeneration, sourceProvider: \"codex\" as const,\n      sourceProviderThreadId: source.session.providerThreadId,\n      targetPreset: \"fable-max\" as const, targetProfileId: destination.id,\n      targetProcessGeneration: destination.processGeneration, targetProvider: \"claude\" as const,\n    };\n    const effect = store.beginSessionProviderSwitchEffect({\n      attemptId: attempt.id, sessionId: source.session.id, evidence,\n      providerAuthentication: { profileId: destination.id,\n        processGeneration: destination.processGeneration, provider: \"claude\", signedIn: true },\n    });\n    return { key, attempt, effect, runtime, evidence };\n  };\n  const seedText = \"Canonical38 synthetic provider switch seed.\";\n  const completedSwitch = beginSwitch(switched, target,\n    \"38000000-0000-4000-8000-000000000004\", seedText);\n  const switchThread = \"canonical38-completed-synthetic-target\";\n  const switchTurn = \"canonical38-completed-synthetic-turn\";\n  const switchIdentity = { attemptId: completedSwitch.attempt.id,\n    sessionId: switched.session.id, providerThreadId: switchThread };\n  store.recordSessionProviderSwitchTarget(switchIdentity);\n  store.recordSessionProviderSwitchSeedIntent({ ...switchIdentity, seedText, runtimeProfile: completedSwitch.runtime });\n  store.recordSessionProviderSwitchSeedResult({ ...switchIdentity, runtimeProfile: completedSwitch.runtime,\n    turnId: switchTurn, turnStatus: \"completed\" });\n  store.recordSessionProviderSwitchSourceReleased(switchIdentity);\n  const receipt = {\n    from: { account: signedIn.id, preset: \"high\", provider: \"codex\" },\n    providerThreadId: switchThread,\n    request: { accountId: target.id, preset: \"fable-max\", provider: \"claude\" },\n    seed: { digest: completedSwitch.evidence.seedDigest, includedRecords: 1, omittedRecords: 0, status: \"completed\" },\n    sessionId: switched.session.id,\n    to: { account: target.id, preset: \"fable-max\", provider: \"claude\" },\n    transcriptDigest: completedSwitch.evidence.transcriptDigest, turnId: switchTurn,\n  };\n  const switchedSession = store.completeSessionProviderSwitch({\n    ...switchIdentity, expectedSessionRevision: store.requireSession(switched.session.id).revision,\n    provider: \"claude\", profileId: target.id, preset: \"fable-max\", runtimeProfile: completedSwitch.runtime,\n    seedTurnId: switchTurn, receipt, state: \"idle\",\n  });\n  const pendingSwitchSource = sessionWithRuntime(\"canonical38-pending-switch\", \"codex\", true);\n  const pendingSwitch = beginSwitch(pendingSwitchSource, restartTarget,\n    \"38000000-0000-4000-8000-000000000005\", \"Canonical38 unstarted synthetic seed.\");\n  const unused = () => { throw new Error(\"CAPTURE_UNUSED_WORK_CAPABILITY\"); };\n  const work = store.createWorkStore(daemonGeneration, unused, { issue: unused, verify: unused });\n  now = 38_200;\n  const advanced = store.advanceProfileGenerationWithWorkRetirement(\n    restartTarget.id, restartTarget.processGeneration, work, { preserveSessionMutationAuthorities: true });\n  if (advanced.profile.processGeneration !== restartTarget.processGeneration + 1 || advanced.affectedWorkIds.length !== 0) {\n    throw new Error(\"CAPTURE_REAL_REBIND_INVALID\");\n  }\n  if (!store.isSessionMutationProviderAuthorityCurrent({\n    attemptId: pendingSwitch.attempt.id, profileId: restartTarget.id, provider: \"claude\",\n    originGeneration: restartTarget.processGeneration })) throw new Error(\"CAPTURE_REBIND_READBACK_INVALID\");\n  retained = {\n    bootId, daemonGeneration, first, signedIn, target, restartTarget, advanced,\n    codex, claude, conflictingBaseline, invalidLatestBaseline,\n    revisionPrecedence: { ...revisionPrecedence, second: revisionSecond },\n    unproved: { session: unproved, queue: unprovedQueue, interaction: unprovedInteraction,\n      mutationKey: unprovedKey, mutation: store.readMutation(unprovedKey), event: unprovedEvent },\n    switched: { original: switched, session: switchedSession, event: historicalEvent,\n      queue: store.requireQueue(historicalQueue.id), queueEffect: historicalQueueEffect,\n      switch: completedSwitch, receipt: store.readMutation(completedSwitch.key),\n      progress: store.readSessionProviderSwitchProgress(completedSwitch.attempt.id) },\n    pendingSwitch: { source: pendingSwitchSource, ...pendingSwitch,\n      mutation: store.readMutation(pendingSwitch.key) },\n  };\n} finally { store.close(); }\ncheckpoint(paths.database);\nconst beforeReopen = inspect(paths.database);\nif (JSON.stringify(beforeReopen.result.version) !== '{\"user_version\":38}'\n  || JSON.stringify(beforeReopen.result.ledger) !== JSON.stringify(\n    Array.from({ length: 38 }, (_, index) => ({ version: index + 1, applied_at: 38_000 })))) {\n  throw new Error(\"CAPTURE_FINAL_LEDGER_INVALID\");\n}\nif (beforeReopen.result.schema.some((row) => row.name === \"provider_accounts\")) {\n  throw new Error(\"CAPTURE_POST_TARGET_AUTHORITY_PRESENT\");\n}\nfor (const readonly of [false, true]) {\n  const beforeBytes = readBounded(paths.database);\n  const reopened = new StateStore(paths, { readonly, now: () => 38_201,\n    resolveMachineTimeZone: () => { throw new Error(\"CAPTURE_REOPEN_MUST_NOT_RESOLVE_ZONE\"); } });\n  try {\n    // Public readers do not run daemon boot, recover, provider IO, or writes.\n    const value = z.object({ codex: z.object({ session: z.object({ id: z.string() }) }),\n      pendingSwitch: z.object({ key: z.string() }) }).passthrough().parse(retained);\n    reopened.requireSession(value.codex.session.id);\n    reopened.readMutation(value.pendingSwitch.key);\n  } finally { reopened.close(); }\n  if (JSON.stringify(inspect(paths.database)) !== JSON.stringify(beforeReopen)) throw new Error(\"CAPTURE_ARCHIVED_REOPEN_CHANGED\");\n  checkpoint(paths.database);\n  if (readonly && sha256(readBounded(paths.database)) !== sha256(beforeBytes)) throw new Error(\"CAPTURE_READONLY_BYTES_CHANGED\");\n}\nverifySources();\nif (sha256(readBounded(import.meta.filename, 64 * 1024)) !== sha256(recipe)) throw new Error(\"CAPTURE_RECIPE_CHANGED\");\nconst bytes = readBounded(paths.database);\nassertPrivatePathFree(bytes);\nconst metadata = {\n  generatorSha256: sha256(recipe), bunVersion: Bun.version,\n  sources, dependencies, dependencyManifestHashes,\n  databaseSha256: sha256(bytes), databaseBytes: bytes.length,\n  provenance: { syntheticStorageOnly: true, providerOperations: 0, nativeObservations: false,\n    publicArchivedWritersOnly: true, rawRowOrSchemaWrites: false,\n    noCurrentProviderAccountAuthority: true, archivedReadonlyBytesUnchanged: true },\n  retained, snapshot: beforeReopen.result,\n};\nconst metadataBytes = Buffer.from(JSON.stringify(metadata, null, 2) + \"\\n\");\nif (metadataBytes.length > 32 * 1024 * 1024) throw new Error(\"CAPTURE_METADATA_LIMIT\");\nassertPrivatePathFree(metadataBytes);\nawait writeFile(join(capture, \"canonical38-runtime.sqlite\"), bytes, { mode: 0o600, flag: \"wx\" });\nawait writeFile(join(capture, \"fixture.json\"), metadataBytes, { mode: 0o600, flag: \"wx\" });\nconsole.log(JSON.stringify({ generatorSha256: metadata.generatorSha256,\n  databaseSha256: metadata.databaseSha256, databaseBytes: metadata.databaseBytes }));\n";

const compressed = {
  "base64": "H4sIAAAAAAACE+y9C3Ak533YOYPBYgDsAiOJkiBqRakXEgUMidnt7unumSYJUlhgdgntLkDiIXBFr0f9+Bpo7rw4j92FKEoeYElJVuxILjn2VXypJE7KKTvK2anynSsV2/eoKztO6s53ViTV+WznUqk638VO+XJ3Lped8t3/63fPdM8Mlrsiufz/Fjsz/X3/79/fu/vrx/+//eJVs00Yo96sKm0mn3hfYmws8RmGSSQSqUQi+bGEx9ij8DHubyeS8P/TicGkEud/4i9OwY8nMrM0yccyf5X588z/lfmTzP+e+beZP8j8IPN7mf8h89uZ/zLz32Z+OfOLmX+Q+TuZn838VOZvZN7M/Fjmi5l2ppY5yKiZH8l8NrOWeTZTzPCZpcynM0zmo5kXMp/L/PPMBy3FCIIgCIIgCIIgCHIikh89fh0+Hz0+hI3fP/4R+CTH1yHkkeMF+Jw6Pgshf3k8A59/cvQl+Pzjoyp8/uDIhM/vHf0oyHzkWIXPueNXIOR3j9bh818drcDnvzx6Cj5/5ygPn//iCLQlfvvoMfj8raNH4PM3j2C9nfjV7mvw+Z3uq/D5810Cn9/s7sLn3W4JPm91n4bPV7o5+LzRhbTJDx1TyXKXarvepQV48RZ8fHYfPkqQ7cRzO/BR/Cx8sM/RZbgIH/OPw8cH6dL+kQwtCCz6EQRBEARBEARBEAR5iKHr/0/P/m4i8xeZP8v8cebfwB3534X78f915tfgfvw/yvxduBv/zczX4F78nUwD7sR/IfMS3Hd/PvMZuBPPZhbhPvxHMu/LTGYSs38x+2ezfzz7b2Z/AMoQBEEQBEEQBEEQ5AEz8ekUPHT+7cbE4873p5zvTzrf8873Oeebcb4/4Xx/3Pl+zPn+mPN91vn+qPP9qPP9Eed7zvn+sPP9Ief7g873I873B5zv9zvf73O+M873rPM943yfcb5PO9/TzveU8z3pfKed7wnn+5TzPe58p5zvMec7aX/T9X8y8xsJ+EMQBEEQBEEQBEEQ5B3JZ5KnE1N7qcRjk3NTk2q93i4XhwBLfqXTrj+lVCqdSrup0PX/+Mz/msgcz/6n2Q78QBAEQRAEQRAEQd51dD88Pr238onklQ+lUiuKprXLhM/reVHTRaOgC0WNVZWioPIFUc0TTeOLhVWlVq+ZmlLJF5kmabWVZpuBj33Sbpn7NaKXzdqY5svkHJnPkDtKtVEh57V69YVKp5X4divx00UtVll3PDW9x31iah0yxlkZ04q8rKlFqagoklBQdZWD3MmqpIsyL7OKGMxYT4aC+bGj+rPThD+tT0V3fKwnGySvaSpHZFnmJEFReJk38lpBLggcX+CJpAez0ap3mhqJzIYd1Z+NV+FP61PxWnJ6b/3cJBjLS63buRAMWRZlrkAUWcgXCa0SRReLuqTwal5Wg7kgSrNikiZj54Opd9yKgV+w1oc/baD0NF3/Z67D+j9zPfOdzPdx1CAIgiAIgiAIgiDICcim9pIjXXMZ9ySHXQRJ+TqHXKcYW0ztTY10LcFe/38rkfnDzLcyv5X5ZWw4BEEQBEEQBEEQBPkh8PHUSjL+yYnxD6e4ZP+TDKneYPvJgrFzqfWpwff/0f4/giAIgiAIgiAIgjz8TOP6H0EQBEEQBEEQBEFw/Y8gCIIgCIIgCIIgCK7/EQRBEARBEARBEATB9T+CIAiCIAiCIAiCIG871P7f5OnTicyd2T+d3Zn5ZzPzZ26f/i0IQBAEQRAEQZCHm648+YG9vYS2MjP3oeTkhxLJVCqVaJFWq6wbisgLusCzmiywHKsospzneckwREPT8/mRfHIFHYQ3SE03a/u51m2zrR3kWoe19gFpm1qufdAkygBRra6TOwfm/sGYqVfIWOLb37X/urk0zft1cebROSfvCTvvhl7QZSlfNAxigC8wrsirRCtIrC5DrgW+MJLnsWCGwJs5ODVvEz2YbcsKecgFupVdomsVpaOTTqXdVKwsp5z8Lk7Q/O6JUNdTkN8pL78KUWVOIWyeFwWBlfKKwhVVXWPZvCKoiqqeuK47tUazfiucXauWg27UXSGvfmlenax+6BTNauKKVbWPBbIqF0SiF3VFKCqCUJC1okTEAmSXFCWoRfbk3aJJbpkts17LNZpEIzqpaSRYf5YheOgLiW+DL/lWd27cyte21V2D+ZJUXlfynKyyRBPA9xtUnwIZ5XnVKIiGyJ44X2btllIx9VxFaYM1+pyqtEjFrBG/M/bk7MMpK2fX+mqsmJcEXskXi4LBCsSQigIrioWCznOCQcBD3olzptVrRsXU6L79bMVX2eSYlTGuL2MFQ1EKEnQ0QyGCxBXUAi/wIs/KsgK7VOWTZ8zKxICsnEpaWbnQ13qQhbwAuxeFvC5oOisbIhFUQ9QFXdJ1Sb2HOoJmimsrev9/cvZXEpnrme9kjjMXMqcy35/9ldnfx8MBgiAIgiAIgiAI8raSTe0lR7ooN+lJDrsElvYkh118mvAkh137OeVJDrsaM+5JDrs6kvIkh12uGFtM7U2NdDXBXv/nE7Nfz3wv80uZH8vsZp6Yzc/+L9jREARBEARBEARB3vPsju9pyfv9yMvkC+N715P38WGU9Ob43l7y/j0tMvHE+F5iNH2nRhcdH100NbroWBZEp0YStdf/30rA0//fmv3NzHrmH2ZuZ85mfg+7OYIgCIIgCIIgCPJAyY3DTW547WK0e/wh6aH3+UPSQ+/1O9Kt0e73h6SH3vMPSQ+97x+SHnrvfwmkp1zpYff/Z9D+H4IgCIIgCIIgCIIk0P4/giAIgiAIgiAIgiCJh8D+fyaxlpj997MvJtbOnDv9Z6f3p35j6iemfmTyDyfrqU9NPjs5k/7FwTreuJFKzz3+ePLHX28raoXoCqnWa2WwM9gO/R5f3Sqt7JSYnZWLV0tMMIZZnGaYFrwdAq9y1GvM+sZO6XJpi3lha/3aytZ15krpOrP6fGn1yqIvs8xw2SVItU9qpKm0zUCyjc0dZmP36lUnTUDi2WWGtVKp9Xq7bOrMTumlHbpt2UQkellpu1rs0HqjEQqdXmJ0Yihg0LGsNOiLIkqlXAXLipYif8drpUsru1d3mAWl064/pVQqC05eohOvbzCLvuiS/fN2vXmz1VA0AgFVpdZRKgvZrL/71kH9drl9YNZuQpX0F93NAduz495kzCK7xAX1guXRFmnHlceyZNlbGCeJVYpK/Tbkl9qZhC9b2tZ+y9RIGd7WgaLo8OxNBQSJHp9vzttHXEIv5/BsT71Ta5crdqGG63brJD6hozvLbO9sra/ufD11Jj332GPJb123+jd9rgZ6U8v9ngn1azfU6tNOF4voyRBz+ermRWbBekrnZTYnKznjxhMLzMrGGlMhtf32AchkoZ/nC1aXhQ5jmBXi9lq/WFulS6Wt0sZqaduVadGUTppXiOb19B5RGhUUvWXqpFm233YKDo622a709nC7EE4+LYEs8wzklbfHV63ejh0TC+HEqyvbO4uW/Mo2cxGqJGtp4uA5LiGUszh9lmVTV6knbPVGO2ppwTbDSnuipS+ih7uph/VkLz10yRqEae3hfbg/AbPILfG2NkNpwUtaNWvejJvBemTcnm/PW+3oprFjrJK4Bl/pzAKWcm/RGYWaN4avNmlWzZpCJx2wOAzvvTUPy03yasdsEt0prp2k3O40a8FO4ZoqjsuzF/+sM+Vq0K3CU2xvkoCEN1F3GvqQVAEJSOXrgJnB69MBGRiqV3v6SjB6fdvWvbkVmdrOF6M0tQOolFC2nDklGOPrCgZ7ZdvdWH9xt7ToD+yliFGYnXZnISWTnnvysWQ3bdagV7vTTJlaiq613c33OXPR+sZa6SWmR4jZ3PCCgvW2VtpeXYK5KnthdmJu9bFkwt7DqxWzTcr0YGRtlz1tvPsrc2FmpASc+2u2ejo9V4BCPGJJuJNQuaKopFLu1MxXO8QNPOMUxa4mp0SRKWi5vPmMzuHNRSs6m/3SdHouD7sTrd3Va6TsH7QseTfZ6aidRciHdmW23Ogss/c8zKyMH0JPUC5MDaodryi8+2v6wuRICTj319Txp9PWkenNT1hHJjfc/Z4MHZnc0FGPTFR+lCOTVdeDjg92YzAXSzt7pdIGzItUEyfZo6BJT8UaSvugR4PdElQiUKkxc0BIIjA9/tDnHDg/tDvmTXJolccdvN2JCbvjl9yObx2onW5sz7FuYDqm4/encHqjfcwPdXynP9pHgXPLDEzvVfpa88KFU0O6mL0Xzv01cTc3bnWxr+XcLmaFu9+neruYFTpqF7NeUX7gXWy0o6S5X4NGrHfacDCs1PfNWtl5ZR22nUizFnmgXPJq1z1DqGv0rG742iRC0uuG3rGAVBWz4h14veBGRal5oe+gnj43lp47dy7ZPbT6S9XctwvW8n+lQn3GD7d6DVRt6Lwi0Hus05FGo2IOzHJAwiqodwA9+kAyPbe8nDwuOKfxWqdptg/LLa3ZUekgOKjT7bjwsZ7T/Gipky9ll+2FLFRtq16L7KV21PJCVWuUO80KdDydjv96bcFJaffDAXUSFAlXCl3/z4xNJab/8+kvjE1NPz71cxPy1PWpD88uz/z1+I/P/Dczd/EayXuCu1/+QHpuYSH59aet0QGnVR0Ci4520ySt0MaHQuMgFDXqtG8nGjjvF+2Z2z5vHLjo9c5oaUo4IK6VrpYge7CuXF1Zs04gqiCh7A9cwlqrUFfOX4iGjye8BG/kCKMfUvzjh27CpRwwe+KswuwZCn4ZMLNbP5Sqau536p0WXa0q4PelUvEOJ2/H3E5qdhu1aEeA7PQsc/qj/bVOX1y4EmWWLXCyDC9dFQR4Z4n1rrIcL300PZfNJt98xOqA1oKz1YHrPrRnhbceC3XBcJw9Ad+XfhNc83oq7G7ZUyu9fcCN91rDzt5h+ZW4OT7YD0PC4asirFAUC9Jb6BaBUbno19KSW9bgwjQY7ZbIP3C88fkPpecuXEj+uGYf5ztt6yAOO2uTaqPd6gv4SPio3xs98imjLT9w9hDsssJpUrUBV5Zq2qF3mhK1wICrf/qgRqHxvXNB0d6Fd9zv72ohFUG5vmmF7dU1/MQxUtZrZHq4hzFT1s19+BqUr7AkrTvpJBNckzQU+wyYwEuXcC7vXEg/+SQH18joMtsbH2/PxOd27pW5ibndC3GrpL6+W+b7gj668uGTqeD6gh7tTnzQOiR3r1iJ7GnVOaiEjrtzoas+ITk6s4VkQ8PaL7t1/Se0aoRFo3sAkx+ZmLu2EFeWkPoyF9r88NPvn5jbzA65QmTfBfKvEznbH3hDf591SPhGKnjh3YkNb70/6iK8Exd5SAhOMSc6Kow0MujdG/tgXyOE3rdwbvj4AbUWLNf9Tft8Hs4U4KKT81U26vSORKfRcgM05Ra0F91U1Lo1zpxrtNBjagOni4BA4PrIgDWHNz9QCevYw4v2cQcWaCp01Kq3/o3baZRgYOdeNO0TTcVZ3vckdeMC5xdOznpF7Dw6U2mFXjG3rpHQKTJ+JuiTC0yhJ7y+fdJpJ7AGe/pjg8ZI+PSmzIe3P/H02RMk5sLbH19+dGLuxSfjEnfo2XC5VVMacNuQTlE9AR87/sxH4Jr0k8k37RV1T3TP5tnQCO2JtIboSW9xxYzPeqcJtwyHNWCvmNfydbVFmrcGtmRQxL9eoxxW6nDNfqRTvJBw6BQvsMgYfvjuO2wHT++CNxZ6Shte/4/N/j+JzFfgA0EQBEEQBEEQBEEeIrqTY5PX9248mkol7YuVkiIYoqoTokm6wImGSggn6pLMGXmwBKjII1kXfNnS5d1sdB4JYRQDLk/BZcU2PCNbhYtwN+zL4WCFEP7GvpKEnFw5m0pN2TkRWTDWx0usyEoFQVd5WSZ5UedUTcoLrKDzI1kuXPX9GTCuPwP7IjA8+K4fOld17RzQ9//HMr+UoN7/sGcgCIIgCIIgCIIgyNvOE6nrI16vGMumro94QYGu/5OZf5zI/OPMHlYxgiAIgiAIgiAIgrz9bJ/ag3X9SI8AwJ390db/9Pn/1NQXEpmPT1+ELwRBEARBEOQt0i2nztzYze5NdWeyiVTKtV4hs4SVC4IIDpkVQSwWlEKe42WNCHAjhz5fmi+yFjnrQ6AfRXfTQXReVT/fum2CaZmR/GWzefBjXRC5ggRhik4KRFRUuQhxskCfYWW5vCILsqBwBq9Jsi7rUlHRC5CCE1VREsJWHuwnSL9+fWzGKeHZb874RVTFPMspkgHGXuActVhU4B+UlC8SSVN0VhuhiEJEEYc9hivLRVnJQyGLUBEcGEsRRSKyBieoBUWQpALhNUGW5EJBlXSW5Y0i1BmcQBNJUaAZdNGxW/HavNGsV+efem3eMRM8/9S8Za2O5DVN5Ygsy5wkKAov80ZeK0BbcnwB/G/r80vztsFXSECtx1rbtsk2CLEs0s6/7oftWIY+13Ua5z+2mwODxw2wgUP0XOuw1j4gbVMD+3vNfVC7NO8Y7QhkzkpvZU8rQjdSi9BsCvglV3WVK2qsDGUVZV5mFTGYPYO+tJ2rKnd68mhZy6WZbIFtAroX+zVjmkIqiipfNAqEBZfleQ6WHoLB8URQwAc6nyeyxIMXc5DIC0TIa1BL0KsNGbJCnZkXNdiRWdMqoF7fAjN6Tb01/xS3NF+vmtBp/CAWdg22FDotq8acmrAzZPUHq7gj9QbYYbse0Yr3tZrArG8NzMCZjfaaW1Hg513hJJ6IIs/ndd6AxVfeKEh6USEi+IHP5w0eRhOnqILMibxcJAYYKxRlUWQ13hAljuYbXtUfrV+A4LxXN7SwjlmPFchJvsixUJ3UhHDJtiA8/5ShVFoEWuIktUgtNIP4gHqh75qfsB/21uVbHRb2y+1QaLv/0AxTQ8e0MqmJ6h5l9qRC6Ih1TDN4Ffb66/bc1i0no2ZviZMIx/IcySswVRuKzKkFIw+NzUqaICr5Eaa2vDu1NcGwc5WMtKjnwPZTQYRm0oguQ4sVi0TVhKIqiLIARw1B1USuWOQMTcjrRl7UZPigk6EiaLLIq2rU7E3v/6cyX0xkvpv5YuYX8HiNIAiCIAiCIAiCIPeXpdSN5KiXg1NB4WEXVseeTN2YGvVShb3+fzOR+UHmv4AvBEEQBEEQBEEQBEEeGIup3eQoj3ylRhQUxhZSu1OjPIZAn/9PvA9bAEEQBEEQBEEQBEEeZqZx/Y8gCIIgCIIgCIIgDz14/x9BEARBEARBEARBEnj/H0EQBEEQBEEQBEEQXP8jCIIgCIIgCIIgCJLA5/8RBEEQBEEQBEEQBEng/X8EQRAEQRAEQRAEQRIP/v7/5NgfJU5/cvrfTl1Nf3Ti+vifp9ixP0r+Z8mrY7+R+PnE5+Afgrw72Xx8Yk5bTibMmk7utF6tmG1SVjrturVdrnbaStus18rEMIjWLpNbpk5qGilzcTGfPl79VHpueTn55qNtRa2QOLm48MdXt0orOyVmZ+Xi1RITJ8UsTjOM0m6TaqNdNnVmp/TSDvPC1vq1la3rzJXSdWardKm0VdpYLW37Ohz51qKpZ5cg/U0oo51yYxP+7169yqw+X1q9slghtf32wSKNzzIXSzt7pdIGwzErG2tMkbWSevXwSqteG6RjdWV7ZzEsvbLNXLy6eTHrq+Yt1bzEc4IQVq+b+6TVHrSDHtEss8xItpIm0epNnehQbmZ9Y6d0ubTVqyMo8uwyw2ans8z2ztb66s7RF+bTZ+WFybs3201zf580X+2QDim3m0qtZVq1ud9RmrodSmogRFpuy22tX6b7ik4Bhb60uVVidl9Yo8Kbl5gWNA9hNjeYkLLpveehZmh+aVMvbl5dO28LLjMLDVLTzdr+glVtG6U9J2Z9g1lc0M1WQ2lrBzR+aUFToGoqFaIvQHVvbvVpCkpHaVMajYoJqZcWDMWsWD+Uqmrud+qdFqiczk5fLF0Gye3S1dLqDrO1sr5dWly5uLm1s8QsmLDjfaVil4vxK2Ih+zRT2ljrPnsuPXctlzzKWGNNJ62b7Xqj3LptQobK+6RGmna/7dRMUBGOJ61POdW9u7H+4m4JsrtWeokZpgQqACq6V9Vin3iWgeqHVuqLYNa3vU509wJjjfSvvmqN9J59wyRyUG+a7cO48E+GRnqclNX8LWifCmnT3TsdOTjW7b7syywznDUAtE6zCb0plPvocRAhaQ2HoJbe2WboDAMDsEKUFoyuQRlYK11a2b26w7DekOxPRPNi9c6oyGeWIwpq5dxWCD+g10eU0FUaUUDayJA5Z8hEJ392cHKnfFlI788qx498In32uQuTb6w6s4pXc73TRF+V9kwusQkHzC99OgfOMU3SUJow4qOmBedoBCHNtjUpDJtnehLcw1Rjaw0q9dKPNgu5pe+fiJ77+MTcdi7uFKB3sihzvSHnvv75x9JzuVzyp/YjJgLS6t1mBgx8iL0fh/ZWvdOEY2KjWTegLqPGrBPlpYCW2SftvhTeOB2Q1NlZ/ygP6B0wBVCpxgEM68jDvB1j9RCvSy4tvNoxg93P2tTqNcNsVq2AitKpwSzqS9wiTdM4DAQM6W40U7qp7NfqrbapgW7dzh4N7zR06HWDzisCEvZpxVLUkcRJ60zfkUcaqnJzKyLxs3R2Zl6Bmq8plbJbM/HTK+fsJiIFs8gucdmAtuBJVziVExPImXMWFhZwT8IYtVPToTNpehla8cCuQK9vmnpvFQQiAmX3Q+1CkzsNmEto7WpavQMz701y6Ki2mx2i+pWHowIFCIbbO/D6Qdlo1qvlQN+0VUXGB1RGx9/nHpy1DrBaHYIPYY5S9IpZI8Eu6Z/h9ov4eY2Mt/qse8yi6/9k5i8T8IcgCIIgCIIgCIIgyEPHeHI8MYnP/yMIgiAIgiAIgiBI4r3x/P9Y+sOJ0z8JHwiCIAjynuZrnbHJG9m/2enOpNxndWWWsHJBEHVWVgSxWFAKeY6XNSIQTjSIIbRIqwWPbp63H+Z8bZ6+XjP/1Hw4eH5pXldItV677D3rOf8UtzTfJPD2Qgse/FuxH3pcp0nhAUh4JYjP63lR00WjoAtFjVWVoqDyBVHNE03ji4X5QOIXmqRF2pDSoM8p56rKHYi1H7B8wX6oN6A3r2kqR2RZ5iRBUXiZN/JaAQrI8QWeSHowpQZl6MmwF0ffz2mCUvoIbWh3VsTOQRMePLT2Cs+Q12umplTyxZzzhkvOrpRc67DWPiDwIG6ubckH1DgFOjD3ad3ZTxv3l2V4HXkpI8rixXllgaczdRJIFVGt1mPmWtNstNesh2IhmtV1mS0IBUPgJV3Qi5wucALLyTIvER56i1rUDJXXi1DPHKtLWqEoiAWJy+clTRQFge6wRYju6YNnNkVZM4qKlhdEQ+Q4XdYKRl5nWUIkQ4F98JokcKIkF3TCszpb4DROKUqkyBZEo1h09K3XtAoUR9+y3oZq2c0H4ZtVE7q2H8xCT4KuZ1bdzjL/1GvzjXuo60ZkLdfVFmnegh4ORcsXOZalghEVW4WOVPEaIWdHiTnO6ugKvGEGHadkGPUmTWgnsUU/R5ota2fz/HnuPC+xNCvwDoZpDcBroNaqU0PpVNoQZbbqFfoU9yp9Knd/zYSGbzc7BDLaaTc67Uv1ZlWhu2i1YbfVHH23jaaqxcW9/jqnsDLUvaKJRUkwOGhrVjUMySC8xklFTuVYrmAUDI0TZFbjWJEV8gVZ1yVotrzG8lri29/9Wj1J5x0zMO+oYp7lFMmAfgSdpFhU4B9MP3yRSJqis9oDmne0IkxualEqKookFFRd5aCxZVXSRZmXWUV8V847zksY+luecUaonR/GjKMaBYWTeCKKPAxL3pAKQt4oSHpRIaJe5PN5g5fg+KSogsyJvFwkBiexoiyKrMYbosT1zjiGVBRVvmgUCCsJfB5mL9qReSIoQoHl80SW+CId7sW8QIS8Bq0Ih0BDhjrQ4eXOovZAZpwR6vq9OuOIslwoKNBQBKYVAxocjgIGXyjmJQHmFl0RVNkw5ILKK5LEQk/RuKLMFwpEyxt6AaYQmHHo/f+xzC8kMr+Q+S6e9yEIgiAIgiAIgiDI28pS6kZy1DsRY0+mbkyNevkQ/f8hCIIgCIIgCIIgSAL9/yEIgiAIgiAIgiAIgut/BEEQBEEQBEEQBEES7wb7f+9LrCRm/9lsdZY58/7Tvz39r6Z+d/KP0v8hnZ5gUvupD4xdSV4CgTiOxsT0WW1l8sh1pd3j6hgsLtQrHWqUoVU2q9SlKZhXAH+E4MyYxIv2+MM9gc5px0PuGniLpR5yNwYkHuRY1knlOOdk/FSM2WK8nTo+Zo/GhHuoBMeP6H2tBFvndI+b4B9KJXTX8uk5bSXZfTXK47efdpjz72DmLozgBnyQ5iiP4EH9Eb7Bt/mJuf2V0fwFhxqBi487/4bEpedWVpJfvx3lTDwgGR+TG+RQPCB3Eg/Dfa7S/XS2799Yt7Y9LnFjXNiCikDrUNNEkV6Ae2Usb6pW4C3qCNbz5esF1eptLzjem2/vbnplLl/dvMgsvLyS+/yNJ2yn1Y6/2x7BLHjd3tkrgTNtzpIq2iWz7cvYvS3oVLdnr47OfmnXj65VSRoBwz5latdlkJLVle2dxZDwyjZzEYqR9fPIW3nkJbDII/gtcGugR+OgiO3S2PUP29XZ9Nk9cfLocq9P80GTcJRQnIvzk03mUckGzWCeX/Ahc5d+4UTFtKfZt17MuOn6QRWzdj599mV58mjbKaZjJsz2O+z5Ge9rh2ixnqKOqKu/TaMTDiquk4KxUjCqaZkTjC5w7oQFtlvk/hQ4rnUfZIEPl9Jny8uTR0pvRyaGQagBNmpzrAYut2PHbI9gXIcepm/A2O1JOlLHttMwbprosj954rL3DOS3XPahA/oBlf3yExNzL4txZy2RsxAXFbp090w2PSeKya8+bamPkokKezJ0dhIlcZLzEi+9OzYWnROSez6bABNxt0gtcC7RcKzv0UEIdUU9pdc0MDxH4xRVqen1mndy4bXzSMfnsPRIB+jeo7/n3d0PDzq1H34y8MxycAcaGI1rDzwBCEiEj/9XFifmynJcv4qZAfno8OyVhXtQxkWHLx6tfjo9J8vJu+esjhotFR26EOqs0TL3pbu6qs3enuqsZ5yTZ1/KPiWlAeWX2Zys5IyeU1Nflp4+5gtvtX3x/X8EQRAEQRAEQRAESeDz/wiCIAiCIAiCIAiCJB6G5/9x/Y8gCIIgCIIgCIIgCbz/jyAIgiAIgiAIgiAIrv8RBEEQBEEQBEEQBHlHM3NqE64BPJs4tZf8h+N/Pf6dxLOZU7PTZ37yzOr0M6f/4+Rfn/6Pg1If6U+Bed3lybtP95jXbXZqbbNKymBl0wCjmtTK40G9abYPy/sdpanHiMUZ2B2izbW2ur6xXdraCRrY7dU/vfc8GOCkthFLL61v72xTG4+O6VWOubS1ec1N2WJaEAXSoLZ13tSXN0p75wN2GqlFxtZ5Nz9OvL85nR1k19XJFePIu/tkvGIxVbNVVcCgumPc9c1ThfTc8nLyG4+FTF32li4unIs0d9krZRm8jDVYGbB26VaRb5P1ltkaYBvei3dNwrfqnSaYR4014BqMt4y3hix0gn3Wdqfpb4CV/w5xtrJB/aY+yFSrJ9Rr3Z1n7Vz6rRlfFW7duVUB2xq13TncYH6EpGWY0zcsP9CeZ1DES+fmeCQrtSHh0YzU1sGtxWAr8r6Il6mAydSA8dIlr9dYQrY51GDDL/mt6Bsr3ZQn5rTlYfZjezu2b462Nya/WbwnhVxcDD+5nZikE+Mbh1L67JXc5DdORTsEaTeVWsu0fVbQKazXEcNg1x+9qZkec9OXmMaB0iL9ri+CMyAd7oubV9fO27LLDJhEJg2lCVaPrba3ZjQryjGg7ETSEWe27QFnbVaUTg0y5QcYimtHuaqa+516pwUDEwwX9+0wpChqpz17sjbBTrNhNquj78BPELuLoM6+4gzbSU+CqJ306bxFmqZxeIKd9CSI2km/Ts/Ydb/2oHJPz+DDllmpkH2lwvQ4hfE7o3O0SiSS/weeWL0HuDv+nHVa8tWz1mmJfSB27NsHDL/HhUuh05I4KWuesiOHWOEOaXCNsC+6Se+z+Xg0Ee8dldefnZi7UYg7iEa2SpmLDBaPDpfTc4VC8o339/coVygyUIjvS57XhJN2pBocuv1TuwfcwF6C4Z6EekTDboROfI7me/q584ztPaM8eC0X7x3m3lZzJ/EQ07eeG8FlSu9qK8pxyJ2nT1z0sJ+Yt170Yb5iHlDRT8E8nsz8Ff08a30hCIIgCIIgCIIgCPKQ8b9N0ef/p2dfSGR2M7+U+bHME7N/nfne7Auzvzf7C7OvYf0gCIIgCIIgCIIgcTwxvjeVtPzX64Yi8oIu8KwmCyzHKoos53leMgzR0PR8fvrJ8b2kLWroBV2W8kV4YMMQDJkr8irRChKry4qmCXwhNTW67Nikn4VhsmlfrVwQiV7UFaGoCEJB1ooSEQsKVyRFSRIKbH5swlc7TPaULyqpvK7kOVlliSaIMqfqmgJpeV41CqIhsuO+aDEvCbySLxYFgxWIIRUFVhQLBR0eETGILhopX7RgKEpBKqpQxUSQuIJa4AVe5FlZVngiqfJYFkSn3FbICxAtCnld0HRWNkQiqIaoC7qk65Jqr/8fS8weZX4t8weZNzKbs49lHpv9d7O/PvtZ7M0IgiAIgiAIgiDvEZbGF1aSoZdvNaVWr5maUskXcw1S083afs5+D2y6MH7uRtJ/M1dpt0kV3jpRxTzLKZLBybIoCMWiAv/EYoEvEklTdFabemp84UZ4J6Mmnfz0+IIYnz/nlUc9XRxfuB4v5r6ImmvQF2WsNytyLXhLoqZPcOMLV06U8JQ4vrAdn8Ks3VIqpp6r0DcH2jkVXrmrmDUyzo8vXItPRV9OrJham9a1myT1qfEFbkASeOFQJ2Pz4wsXpgbohfdzqP+/5JmvJOAPQRAEQRAEQRDkQfLml5Pp638j251J2S/dS4pgiKpOiCbpAicaKiGcqEsyZ+RVMLkgvzZPbTLMPzVviZ/XzVaD2smaX7ID1r2ooZogibMyshKNdL8Y0lBDEPD6fXPnAMwh6FbSqDVnrnVYax+Qtqnl2paknZS+hX3Zs/g0/xS3NO+u6Oafes1Tvmu9C66vtOefyhc5loWswqK404KdmXqFgC4FloO3yA6stmkWap1K5fWleQ1sU9Ta16Akyv4Jq6JqJ1qzLApAQl1XJVU1WCIYcAO5kFc0WSxwKpHg5jHcn84bqqFxhqQU4TY4qxZlXuNIXpT1Ige3sHUigkrn5fMX7FI7xaM/rZxBhYJphrymqRyRZZmTBEXhZd7IawW5IHB8AW5kO5VG7WT1VJpr/ipQQ7AIbxGa9QNzn/aHKqxuK7C532jnpJzSAjM1NFNEAYMMsJIuGUa9ScWryh2rKzRvmRrZMUnTrs6leUOhNWEolRaB+m7QtlEqL9RhJX4IyWDZ36SmKECGar1lktvXYI+0ZGD6omyH0PyTJhhzo93Mq4j5p27Xmzeh42q0JbV6tdFpQ5u3IKrd7MDOGpXOvllbVRqKaoI1jUM3nNToi/v6SqMBPeHlG6+/TmS2KHJQXQWO16BdJS4PDwwo8ByBJEmcxOY5tiByLEcKAtz7l/iCxukFVdZEJa8RVmMT3/7utPX+//cS8IcgCIIgCIIgCIIgyLuKbOr61GjXfmbQ/x+CIAiCIAiCIAiCPPRM4/ofQRAEQRAEQRAEQR56ZiYeSZxO/lxi6t9P/vXk+9Mfnjib/LlTv3bqxszfPvM3Tx+fLk7/6fSfYi29PXz12VJ67vLl5E+8ZnlsdA05WDY2et1BDoyUQ95RB4paXlJ9P+09fkgDTlIdGc8/qqXN1Ac5LnVEfC+onO0FlbU9xQe8v0dqCcZbTnl9YyOWb3D6uIu9lQ3qG5wn38t8TK6cihlYF27luXXhvLRU3vfeWopzxxohaXllpVrcl5wGeHMNinjp3ByP5Kg2JDyCn1pXfrib2rDkW/RSS9MFvPUu+j10ye15lszuxvqLu6VgV1ny+4ElQd2rrl/esLVEi4EUE9HV+8ZKbHrXpe71yxNz1ctxnpEHjsMyPzD66euX7l01NzD6qelnEpN0+uneWQt7xY1z0d3nwDdOsMcr7sj6+h0CxyUd5BXXSsPYaQKewKMdAq+euOi2A9/7V/Q4h8APuuivXEyfvV6YPNqMKrrne3pgk7tSgwodq2lIY7vpRi6u5/87srArJytsRCPfY2FHat77WtjNz0zMacsj+WkP9kguLqYAb45exrO0t8zR1GfTZ83Lk0fVHu/j0bN3nPf1SOkYP+SjaY73wx6ZflAnpQlGcUd+NLV+b3URdsd+P+timGP2B1YXd9Xn02fJ5cmvfXKEuqAj+aDehLfFy/sdpanfr5ro1evWw/rGdmlrZ3g97D0PZ5H07K700vr2zjZdXTiVwjGXtjavxZ5cMQ0QhdSwr8Z5/3RveaO0F9i0TtXoKSrI+CdjtpC/3S9lhmRCevwTfkvE3wzL9Jy2u7I9wYE0gXN1SziwHbF3ej4e2j8NmM6euF/ZJWS8VmTAGkGVmsxwOpll/2/mDxLwhyAIgiAIgiAIgrxbucskZ/Z2z93Ym0rd3QcbiyMZOQybiK826JWgkD1DWGae3My/Ze9PK/KyphalogI26gqqrnJFjZVVSRdlXmYVEezRRVgJHJbqnqwEGvRCS842/ueaCrSt5ufsKDHHDbAXaIt+Dq7JWDub589z53mJDRn8c+wB6sRQOhVqJtCES6fUruMqGPQ399fMpmvYr95pgw3AS/UmrMypLco27Laaoyt+mqoWF/c6uB2QC7pBVJnNQw0VWVk3BB3sCgqKKhdYoohEM/LgkVDIi2pBMwzdYFmFAzsAiiHKRPTs//3TBPwhCIIgCIIgCIIgCPKO4dr43u7UfbuSY6///0UC/hAEQRAEQRAEQRAEeacjjZ+7MXXy5zLo8/+TMx9JZP5B5vnZP5n95qww869n2hCAIAiCIAiCIAjyHuHzk6fhNuvU5ORkImU/N68bisgLusCzmiywHKsospzneckwREPT83lWyOsiR5ScyKlcThBUkisKRM3xqkiKBU4oGmwBHriGv3IadCenkskxV/fQO7mGISuGZuRkjjNyAstKObnIkpxalPN6XiU87Hc8lTp1ZO/gxoS1g6kpbwcKPCPOKYTN87AKZKW8onBFVddYNq8I4AdOBQtPhbyYV3LwXLiSEzhBzcnw0H6OFMBjPFcoiqIqjyU3bfWfP9VbN3JBJHpRV4SiIggFWStKRCzALkhRgkf2wQ99EQpSVPI5XlZBPavwkH9CcgVW4DieyELeUBPfbsHf58d7dUsqryt5TlZZogmizEG2FdgZz6tGQTREtsDrKl8ghRwUSs0JEivmVB42eQ60w7PxkKm8ozvVq7uYlwReyReLgsEKxJCKAiuKhYIO5q4MoouGTARZEoVirijKxZyg6IWcqilSTpA5+MfCAlosOrrHenUXDEUpSFDLhkIEiSuoBV7gRZ6VZYUnkiqrqibJEifkJE0DjZyogu6ikJN1wrKQUOY5ydGdjOiLeQH0idDnBE1nZUMkgmqIuqBLui6pBZXV8oKh5jhDhzrhWSOnSkUux6pQPSxUpyQ5dULv/0/O/koicz3zncxx5kLmVOb7s78y+/s4AyAIgiAIgiAIgiCJt9e1/V5ypOsxk57ksKsraU9y2GWSCU9y2BWPU57ksOsX457ksKsRKU9y2LWFscXU3tRIVwqs9f/M1xOz/31Gy3xw9tbsQuafznx95gfY0RAEQRAEQRAEQR4QG/Bad/K+PWgw6au7H88WpH119+NJgglf3f14cuCUr+5+PCww7qu7H88HpHx19+ORgDH//f/78RQAff5/OnkxcZqc/uj0/5i8OP1T02emVtN/a+Iz4/8nDspR+OrjG+m5bDb5k6dCXvrILVJrt8Jbn4n0w2fHDXS8Z7mzsyw/lkmjrh1ExFKnRNTxT4xHNS8+7OVOhn4Fr4bAWC4I0A25t+SgDeaTOrifOKmrPOqyqDmar7w+0aDTOztSq9dq4KgoWIs9ycMS69v2Pja3GN9xXYQgdWCXl6x9WQ0W716PRpRvKRVTX/Qls4GU6iF4qokrpeULJCi3zAT99QX27Xnr89yHBJOFPfhJopiXQC67RGvqFadUt2z7pf1ZWStdWtm9Sn20eHXXn4ZZ5Jb47EDXfG6v6/e8FxQKdOxY33t20WzRVnxy6pDGcVcE1bW6slbynPEdbe+kz17LTt59usedjj3+yk7vBVuvPY6V7PgYnzlxiadXLu2AWL/rJDuB7ceFOiy0/QlFFtPylbMDw7GtmDUYa9YulsObOW7JqjLGF7Pafzm8mdu8unY+0D083zoBzzpUJDAB0W4TrFs7PhDw9DR12LS9PWqtmjUwx9u+x1q1Ezu12u986D7X6pOj1eqT1EHPkFoN+yvqr1UrvrdWj5/YAr902ck3bgys1TinTyeo29H9OzlVPKpDpxbTYj67CbOE79CJamuchzpphb0qOXV2Pt67U6vXK5N/qBnJK1PvcWOwIyUnA/Z06h7V4l0odS+9mD57JTt59MnoxopzUjZKK43uhiw4AkYpVpQ3xNQL6Tkum+zKtovAng6z35Pzi07W1zfWSi8x/dLQMn35C83cgZOIwKHi6c2Juc3sMM+mzm648PbK+rWJuRuFkRK784HvaTUU/Oz61ZOr4iKDl7/+kSvpuUIh+a3N/lNEVygy8Jn4E0ZXJPK8MXA8jvPZ3H+kHHySGTw9cX0nh4689PTIH7AdFWJDEkvyEkelFnILA8U4YUS5EfXxIX3WmUiN3IH6G3LGHBYa4bTZqNTrzaFqe6TCekP7DDuBbh806539g6H6rbqIT+Xuj40sh1eR8QqWe2ovx3ButYaPofFLh5CUdwYfPrQOTW1LBVPDoKBjYF9plG2z/cGz/8j4wLl/dPwGY9fngh9t5Rr8jfshMNWFtq2cWX3NypkGytoDF1MBCa889nQ/KFVAAlL5OkJ+sGNPs92zYrr+H0+fS8yeP3N16kvwA0EQBEEQ8KH00vgZuH4Pz9Mlvvr02P27pZKCFylHcm/02vwt180Q+DRyjuiWd6SR8gIehOwjf4ke+KmXoxEyRxM5J3jgOom6QbJXagFPSs6y+KRumqyVeI+fJjd41bveSrXWOpXK0rxa1w/nn3ptvn3YoM6UOnBaWq5CueGkCxRSe0dWDuoNBbJbvsWXCdx4UTSOLYALJJmDe1FqgYM7QoTLa6whsMTI6zKfh+uhYgHur4mSohQFlZM1QuAWkSbS+lK0dh18M3n5Krdum7Dcp/uDU1+IWPUNKzOeOWXvEjRji8Nqi+jnIVG9arap16cDpQmaoS3nn2Jffz35/bE3rqXcrvX1x+9j1xp713Qt/h3UtXpam+ig1WjWqy844bR84NGLev9q14OBliswT9jxL3Zg7h84khEex5wSQpeo7cOOHDdg7aZSa2lNs9FeM+FiC00EfVLhJJ6IIs/ndd6QCnDDsyDpRYWIcFsznzd4SSCcosIdR5GHO6MGB/f2ZFFkNd4QJc6qbaJ7+uAWpqjyRaNAWLizmefgDq5gwH1UQYGbrXyeyBIPNztBIi8QIQ/uxWAIydCokkDveRY1R9+m3aW3rLaz+/PY1bHj8hj05ynan9+4ch/7s9udSV7TVA7yJHOSoCi8zBt5rSAXBBjmcP9Uf9u7Mzdadx5WjvvSnW8rTeq3jvqqs/3QbW/ubq2Wyi9sbX5ufa20Rf3eOfNoeELzrgq6vuOty03zMGOVx443k14LPzl2/x4IuE8tPCwrfS08St7ePS28u0Ebt7QWatpt7/jUqVHlRHfalbbo5hh9/n88s53IfC/zS5mvwA8EQRAEQRAEQRAEQUbhyfG95GgXv1Ljo8uOpZ4Y35saUTYLolMjXRKx1/+ricz/nPn5TAt+IAiCIAiCIAiCIAgSxYVTe6kRF/HwnENq/GTyY6nzID81unyOio+2+Adx+vx/cuanE/CHIAiCIAiCIAiC/LC5e5D8+O7e3tTuo4nSXndm77nnErmzU1PHyQQ4gEukEol8kbXIWR8C/Si6mw7cSCvAkZ5WH2FvPDxXD8+ia/57BDn3cfNckz4932qD/YzqBa1erSo1vXSHaB36cPsFJ3KlQYUhHacL8BaLWoTXBopsIQ9vcuVFPU+K8IpLQSoY8I6LVlCgJBJvqCrYQdREDV7nKhZlwdBFXYnMgPeKVg6sGRBFjxSir5JFRtB8O9kuK042G6SmQ3Ffm78J1kCsF4PC8fSdgQ4ENQ9DT+ArTe3ApE/gB+RsUwPuI/6OotWK0oLXauB9M3hrZ2n+dr0JO9pfM+HdA3g17dCVVm4pZoW+qrFGNNOy7DH/1Mvzdfqmgvd2BPzSiVYBmwn0RQEF4irzN163HTl+7MwH6f3/ZOYHiQxa/EcQBEEQBEEQBEGQdx0Lqd2pUa4S0fv/pxI3E4mbmV+d/a9mfv3MP39gWfrZjV3LCuovP22Zl/DsrZg1MIqjWLYOWpGBqyErqJEilp3GRketmFqkEVTbZKJr4N2VC9h077WgGmM11TE175giPpGZ+x7TxAOs3PdKekYhI2zb96R2Shhnud652gaBZWpEIlJFrww1grlQ61RV0gQzl/Z1voVsrzpbwCtUnyo3PmhxszfStU2a6zVLOshVgZ9ZsM0UtvgZjuo39N8jke0xxipyvLWPKgHDzwOr25aIS+/uRreM8AzSE5ak7SYJlgr7umWPQwM/sL9oXlxcpujlzl59TlCENjsmThe9Qtqjyw3q1+XExOlyr4z26AsG9+sMxMbppRdqI6veivANvfZeyYUubw12zTLVFAxukCYYArcmjUCoZaDMrDU61EZsVWuUCUw1ZtsayL5N2BYERI8+O8bPj3Ol2TIw22rALETKjSZpKE2iB8NuN6lBppodVK/csmKd6770p33h1/pJ7jRML3W9Yl2GL3dqN2v124EcNsktszVgmvLin3XmJrVS1+hF6rgEgXhmkQWTzFYq3Ww1KsrhSM40grJZq3GDjjFCmjzXGFFuMJzyOTUXHJVu0cJRURNHSCIwUL0YqGWYgMEgb19F9uwkQjA4R8ZKPesZPrbmjCHeWgIy92xiOKjFnkPoCKjBsAtocKaSYIxfnGBwn0JGhxmL9tfIDLkeSfoODfYOA2mfXQ4VlzZ7IPaZ5f7jCEPPJGrUEL2XwcAAdSa0GJFA6WJF6AF05GEJ44JxhcGUdE/H9ILDncQLBjPn1Ea93W9AGW2mgF3w3oP7sntgt6op+nDttkCPRPCYantt2dyK2YdzzjBgH4P0O/vPulbGg8WxKnjZmyQdHdHDNxQXO+rCRbH0n+vZwaLjGiRyogjX1sC9BQpm75OJ7i+jzt22omx8RdmaT3hEsWfaiAEdUVMn7OrRpYjcX7ATeLbLu1++np67XEgen7Z8MkQuDMpOcSMjnw95sBiY3nZmESmy6C8IlvrP3peCs9GSv/Tw/Z7ce9N0b7+UntstJI/qAyrAHn1lJxuRMpederCtxg+sjrC2e6+V0AplqfdM3KucuLmk+9peem4PSt4ZUHKYYEgTantQ0S+NXvQedQ+g7PaMOKD0zmy9/rlBrkmic89FBq/R+/+J9+H1EgRBEARBEARBEAR5mLGf//92Av4QBEEQBEEQBEEQBPkhcnMCTD+Upu6bbYZBVhns9f93EvCHIAiCIAiCIAiCIMg7gS24MADv9Y90YQDM+43y/r+9/v8nCfhDEARBEARBEARBEOQdwYvg2293ZN9+o9r/O5P8RiLz4swnTu9M/ofJn0i/MnH5lDz+x8lvjP+91J9hnf/QuKuS9Fw+n/zaTcs+YqelgMGxRr1SKRvg5qED5j8igjZDthEjBGzLiCc0WUgtW6yVrpZAMRjXWl1ZK1lWy+qdpkbKw0yD9Yp5BqfqKhhHuzXQ4lRQxEtnu8goa3U9zmKhH2/ZUYELZPVOrV22q8OyhEerw7Gu5MYaYEiENBtgT8Q2/+XY4QnazbGIkg+YXwpIMp5Buv4k2WVJCEpSKzdRmmnZLoPtMmbhiZd/VMkZbE6+8cSCn9I1F2Tb+AnYuAwaHeltqoDNnPP76bmVfLJrG06J6DCQSCO1dkTMVshcTnxS2zJKRHwoi8GmXittr/Zl2grNloyJuev5OFsnUZngIgJf2NQn5rTlwWrcHdOIgzoY2Tl0dfXHbByd1tJzy8vJ42xgtPbLxYVfixi3/VKRgzdo1/RE47cGpnWGjt6wkGs+j402wel1qyNGTZ+tX5s8zoB9nn2rM/dbmym3m0qtZdr2aMxqtWPVXFkHs1BtMiyBW19b65dprk+sf/pi6dIm2NRxqiXGdE9QBaS4DNPJNiRYBYOwK+vbpcWVi5tbO0tgltFJywTSMn5axmwxXgYWsk8zpY21I0a55yqyDfE9uCqy9btVtPvC2srbUkXlL0zMta6dxK5RqDzcMImrd7Vyeu7ateTX5FgTxEH5YfFXhhomDkpH2SiOORBHmZTyjRZHDu4TG+x8N9ggfUA2OrV6Ux9iMNMX8U5DQsdatzWWmP5j7PHzN9Jnq4XJN24PGOmtstZpNuFoGbAM5lZrtBXs4aN7kM7ewX3J6QBxNsymwQTZBrNR2jvvGFnsb3vrmEBrrvTS+vbONu0tzkzAMZe2Nq95hySm4Zk0a5w39eXNq2vn/aPatHs61DjfbyzNle0JDqRxbTQ2SZU+2LwwnT3xrBSwtQ2zEij0ZqS7F15On90rTH715YFN6Z8w7HeUpn7v7dejyG209Y3t0tbOsLa6h5ag7TtqSziyJ2gJN8o9RbZ6k29o3Rm0vv1LP/c24TK4dtiZlifgWFB0SxLQTXfbChQtqqTuyXT2HrqMf4oGRqCrSls7cHpMd+nzllHK7v4gm4x2RiMj10cwSumkH2SC0K+LkAVK+1TbP5jMWPf/fycBfwiCIAiCIAiCIAiCvOMRkhO7U2cTqVHu+jtXdOEZAfv5/+8n4A9BEARBEARBEARBkHcXi+O7U1OjPv8/ntlJZP515hczX4EfCIIgCIIgCIIgCIKMRHY8tZe0jfTxeT0varpoFHShqLGqUhRUviCqeaJpfLEwlk25olqRlzW1KBUVRRIKqq5yIC+rki7KvMwq4lh2zNM6xPTfWDbpiQqGLIsyVyCKLOSLhOpWdLGoSwqv5mV1bNpa/19PZI4z1zPfwacAEARBEARBEARBEORkFwFGvQYwnh31EkAqO/IVgMXU3tRIFwDo/f/E+7C5EARBEARBEARBEORhZhrX/wiCIAiCIAiCIAjy0EPv/2cSzyVmyZlfPf2508npS1PXJn998lw6f+r/Hv9+6t+N/WLSTDw3/TMxyY8WbqXPvrg8eXzF8Y8BngY6BPwTwDd4ewn4s6jWa/V2vWZqcRI9/jGGK+r3aGL5rnKTUNcIcUp85yahJM9QZyOhkEF+ISzljLc73yMEOLqBLIJjmH3wmdJy3T8920mfJVBTZFhNtcAyI3isor4bXP9Ib7XOIlRG+INxhUarOV+c+vEA3yO08rzAe6o4X2WU/6xCO312Fypwf1gFmuClptku1yH0rVZcQFW/L5bBdeQ4Mwn7MIlL4noycStgmcveUw0qFert8JAhd8xW2+163UbLGqRHN4bVXK3ueEt7q/XmKep3uxZba29hqKmEsXenu53l0Wb67LWFyeP1UJFJrWfvPSMMXCc1TdKKLGV82v6h1Cvrl9vZgz+M+kQDo6k3bngVOSn8qooaSMuvQndYmLw7E1k34Eqm1o4cRqPUTlTquJETqos4z0VhUdflj+PQBxz9gNug3mpajqrX6ezotecWImY43Wykz15ZmDyqD+5b1O0O9XJ2D13LTTpSzcX2Iupb6eQ9xt23W9pH6+k5eSHZLVv+jOzdOPaDvd2FcvVSyIFRdALbc1EoWdBjUW9xsu78aLsicx3SdWdq4GsJ8iYH8tZXmZ2aCb9C+9pzsri7sf7ibjinMcmjMtyXy+6tquUT9OgrA4/aceGfC7kTjD1U0DESOPg6HuyCXkEdN36Bg4nn/tPvIAPcf3pCrvtPboj7z26xkp7bXEl2qwGvslql3tHBtWSlDv53wfcfZD/sXDZKYDfCx+wARUFXs1Fig5zi2v5lt29OzO2vDHYMG5kBLj5u5+hHXgEvuyvJu6sB57BRkvEx2xEOYqPk3kH+nWmTmLeGOVb0RKIdK47ixPg4Z6bPKuBg8dpAr3xVrVHuNCu2K70BPlRHc80Xpa3/yH8T+s2SbrYaFeWw/ErLPpke4mCRplleoPoJeGUz25ZfvQXPcx7VUoZhSRMuUvmg+qWFT52vguPrhezyAuSO+tyDI+Lq5spV6NylRStt+7BBIhPSBNmlhVqnAt/guM/6MfhAeW31BWZ362rIF55zEkZoEKN3mrTL21O1cww5/siB3V6fPEF72ScQ96u9bG0n86f4XmgavP+PIAiCIAiCIAiCIIn3xP1/XP8jCIIgCIIgCIIgSALf/0cQBEEQBEEQBEEQBNf/CIIgCIIgCIIgCIIk3unP/yczf5mAPwRBEARBEARBEARBHjrGk6lEMkXv/49l/jyR+U/wgSAIgiAIgiAIgiDIQ8SpVDI5NpZKTU1NW/f/v5fIfC/zi1gvCIIgCIIgCIIgCPJuIju+NzVF/emWFaLKnELYPHhtFVgpryhcUdU1ls0rgqqo6kx6OpFOXEzM8mc2T/+9U99N/e3Ez8Im/EtfSV8ZZV/b3cQgD6qeg8VKfd+seW5swX9umYuP+5E3E1+xPKh+47TlQTVeMj7m5ZAH1Xg5y5Oj0m6TaqPteVANutMNOFGlnrSpY8WyI295U126Bw+sThqNttE+qYHDxvYAl6sRks86zlPt4vTt1k5XIbX99sGiK5Ptcegrcrylw3IIGanAjgGPk4sL1KPkLbKwtNAi7XaF+oe201pbVfAwaStw0vmhjidq6vsyGEpVgndKjVBV4Oiy3i4b9U6N/m6Z+zVCXXbCb6/ZwEGmVq/ViNb2dg3OZOtNfZi/WU/E8zdr+24dlCwgAakCSqz0tsyi44zaqRerQvuLnaXldkXdmouSdTKQ9b3c3pW+nD57ozD5VW2g11S6UQOfzXQXtrPTe/eZ2q+r38OtFblkSdI6gdTg9Fmp2IkGu1SFurOcnQZ6VRNGMESDh/AmaShNqy94YbdhgMJuFrJWhVkO32N269a27WOVDmj4cXXtvFPxfRotAVdpODv1yi0rFzrRKmbN+hnop+ROw3aOHqXBbka635h8QqKBLlzdqgv5cHVVOMMURgH4m9VNrd1i3Epj7IZzfLoe5b+UPlsuTB6/PErHsT3j3qeeE1R2Yme7gxrXGR4DK8/2Cs9EVqLjCPdAuUX8Cg3VGjwR9zN45oAgyDuI7pOH6bnnCslu1Tqfjp599U60Y/vPO3P3+sZa6SUmNi09asbMzos6UXR6HISTn6VGRwUv6PREElLAtA2Tu3OAdebeheMv3EmfbRUm3zw38NDToDNwq0VPpG8plY5zrlG2T7vu/SA0UG3/mQx17r4UdLw+skP4wI6UBk2hVOyTutJL69s72/T8wzlEccylrc1rjqN4RTtYHOoyvkle7ZCWfZbrVbPvLN4qGJWzfsCpUfDoOPjkwss0Y6VtRXuHDx41nbyFPMYfX7ltNfEbt++lie0ThPvexLbaE59xYGva9/+/m4A/BEEQBEEQBEEQBEHeRTw5ntqd+tiZD+aLrEXO+hDoR9HddOBm0P4/giAIgiAIgiAIgiTQ/x+CIAiCIAiCIAiCIO92Zk6/L3E69aXE9MWp96V/cmLy1KnM+uwbM188o6a+dPpnx/4UawhBHgzHp7rvT89dvpx8Y8oycgFvCsELTVUw9KDsk3JLa3ZUz07F4cBIPWTqYqCo9XJ8C97Vq5B2wOBE0N6FY8LBlVnmHGsLr3boq+8DrS34Ip61BSewBe9raZ1OdUjagBizyC5xtqWHQRYy1kqXVnav0nezbEUB2bC1C5llC5wsgyGUgsDKMudbWuh+pXsK3phfmTwye99pC1sLOSybVWoCBBqrrINFgPYAwyRxr7MN0+i+xLYGb33R9xQ3BpguGcmWgJWK8TuA2WLgNTd4YTNXr1UO3bf6xrrj6bO7K5N3D4dVQZSliXsu/QimJgKGMgZXhv1aH/QL2sUD1h+CFjo8aw091jgs8X6jJV6SSGMdg9/QMysVsg9WBnoaIqAKXhustUzaVV3LDV/upqyOeHd/WCv43fx+NUWvxv72iDBDM0KLeC1xzm8KMNLhtUR/cP9+zi1TLf3hT3L30AKB7Pe3wPnuWPqstjJ5vDp0KtChDUMj+D5MBn06+1vBN1W05FsdWnJt/CwFTd7cr8nDzRadO7ycOTXW/Ww3mZ57eSV5dCr8hnpv2exGLjt5js/XjzqVtbux/uJu37vrg7X2vMnep3vRr7Fs+A12pwvCYflr74Rzg+6l7sfSc9cXkkePWrVqH9OhFZrUclb42A4v/uomfcW9FZIyQi//j6bArr+Q7GLwdX8nHQzZly0hNwCO8tU62M1hFIO+fezPcTcWjj7YPZOe2y8kj+cGWDComK02nHCUHUMCZWq8DCIihbURrBrE6Btk6cARsceQ89Y2HURrpe1V3/QBs7K92mP+wDYd5JpAWBrRptFRuns6PUcKyaOvnKBe9it1ValEyqr3UC22ukG18sOoiu5nutPpuT0wcjFKVQzqGsoJ6uD+doluvjuVntuFMuyPUIYBzfiFExThPjRfAu//IwiCIAiCIAiCIMjDzswEnziVYBOZz878yczfn3kJfrr/HouS/8aXuwvpuaefTv7MI9ZF4Nv15s1yE25cKXBBp12vqi24Y0haMcG10H3KGCHr9o0VF2WMP2TY3pHy7dpL1h2bonvn0VYNV0WqjTpcadIOyzfJYY+he+cyc0hvTMrscl4KaXauroBx+n34GmSCPzpFdlkSrBzHKKS6Ll/dvMgsPPHyj7I5WckZN55YsLIAxsmpwe0mMaL3HlWsvjTe/vu1Ddp1HW4wgAHtdr1Z9q+QDSp9dIqYZvOsf1PrnJFawxLWJUfaE85r9WqD3kKFi4zWtqGYFfe3bcPd8RzgKRi9AWOSeDUYp3JAPRqO/C2zNcD3Q1jqWTaQ9ABs85YPlNbBoIz3iHoZ7lUxIKPU94Ji3VPSwEVDu2Uby43ap2XZFOyRmvpiZCLbkr+Ts9WV7Z1oMbg0yVyEvGSzzyzDvXqpJxf2La7WCK0Wl8arhVilA6rDGayDn4TwRJ5ddmcjamye9vwO3H1vllXq7WKgimj5Z5cDyh3NrU6lPVKjBET7myKoJ9AAkijCtOc9LJFIpD+Nx00EQRAEieJy99MTcy+LcV7RrIVLo9PcJ4FHWfio0Orl7uMn1sRFhVaOPt/9VHpOFJN39/y1W49QVNjN/lVbj8Q9P1QaWuYNXLsMXuqdfIkXt7TTmmSIczBfgp7a+Q+R8t1PpufOnUseXfBrV6vUtZv+L7O/Jq3wk9cfs8xwnv83DU7k22aVxOU4JGM9mOvlGu3/IwiCIAiCIAiCIEji3Wv/P/Ht745i/99e//+TBPwhCIIgCIIgCIIgCPKO4MVTe7C0p09QlxWiypxC2DzYsxJYKa8oXFHVNZbNK4KqqOqJ1v94/x9BEARBEARBEARBEnj/H0EQBEEQBEEQBEGQxLv3/v9Mwrb/n/lzrF0EQRAEQRAEQRAEeVih6/+psR9PzHzpjDb9P039v5PsxP936vq4Ofbjye+MXcH6QX5YHL98fB18Xxcm33yy1/NyyPdlhOf0SME4l8vDlEW4Ife9gAYcLvc7o17S6rUasTRTAcsyu+0LwNTL7cMGWQps1zpVlTSDIW1yp71UJZAhz9uoY4zecllw0KSm+kFvu9O09IMd2Cr9BmfuUDYw7wm/qUOEJdUyNVrbXwLj9o2KcmhZdA85MF3SQVfFrIEJ1/Z0nO/QkfxDBxKEXcz3uYmuHF9In92WJ4/2nOalfqxtA/ekCo4ayo06+CU9LOuEunCwXZBHi/S07Ah63DZdg7LQNt2ISTSoyF4KxkrB2CkY8CtRq7cZlTD2DnWnvMfzx+et8r6xOri8nQb1vPzWyxvU09uHY8trOWi3PLF7hmXPLdse290A6l3Wdst+izQtRxWOhLPpxwdM5zoifogv5fm7cGS87ScZzpeyS2PpesYS8wMGenyvWX4OmJjG6nf3njvOWa10fH1wK5ngsLjZfuutFNTjttL6xnZpa2dYK5VeWt/e2V50is0xl7Y2r8UkcD0yB4wt30PPVip0xjlkyB3wNtxyu/XK8VJ6TpbH3jxrje7oDESHJj8cMn8ck/d7N4Xs9s8YK8hutCtOarQAepy4H80ssktc1nG1MdhZixfvWqnmLCvVMssWOFmGWzUFcGcicye2NG1bbaapAgMjJlVAAlL5OgKmql86fjJ99go3efSc0+thCjMNsBFtNcdBvdNshebP/uie3j4kff/8259gUA8NSjOWdPy8O3v8hFW2N56ML1twrryXsg2eayPK9rDOsxEN0z/Hfug4a7XIsRzfIsF58V5aZPC8GtcikXNqv/AJ59OISomcS99IHC+m5zhu7OtZay7t33F/SPKDoTk0Iq8/tPnzfs6FrbYCrQcOtDrtWCv2IRlXJ2vp5IS87Mzp+hAtAYl+HdaPgAQMneBebd9hYES//EVwVDfI75TlT8mX9Lwp9dQFL4pv86HAfv7/e4nM9zK/hGtQBEEQBEEQBEEQBHk3kU1dn4K7fR1SFlmhwPMSK7JSQdBVXpZJXtQ5VZPyAivoPF3/j2e+lcj8YeY3M/8IfiAIgiAIgiAIgiAI8uD5cIpLwrNN9Ro81VHJFxl4/GCftFO9wS141kMjYx9PrYSCm8R6XsFJNX4utT4VjCZKs2LCU7stc78Gj7bVO+1p5/1/BEEQBEEQBEEQBEESD/X7/8nMXyTgD0EQBEEQBEEQBEGQh4yJZCqRSvx0cSZ9NjEx8WRi4l9OvDbxZGZvtjn98vSF6VQiMfvRRML/hSAIgrxnudZ9YmJOeTqZABuT5E7r1QoYoKQGNOvWdvl2vXmz3ARbXEqLlNv1qtoC20KkVc7HRLx6rZu9F318TETjWnfxXvRxMRH1RCL1GWx1BLk3vvZIN5eem5tLfvOUZd6MjrOW9dEK2TCzgiyzZWBQzrKp1W+szDGrZeq+BS3JsqBVtE1hafBYa60No9joscq1u7H+4m4pwjhXIEW8dS7JVl6vN3WzprTrzbJvC7hnR1ulS2AjbmO1tO3aC27R7NL0dfUVahX41nCLYb5kXJ44KV8ULK0NeNaXtMtgc7hNDfD2mwBbK11a2b1KzdrZO+pPwCxyS3zWNcDWjs6fHUOFFxQrbwtLC/BMsUbAYieYSgMrchBgWAY8vU2tXm3YRhntKOuHnYj+PqEtTc/gWasNFsyqZdKoaweD6jIolwV7dXm7HWtgYBkaEF6MhozE7TUs9Kyz5wNqe/lAaTm7tUX9wPVtWwUYVXTz4EXSDEiC1Xh+ArrTy9C+zMITL/8om5OVnHHjCadefujG4GhyW6Sn9MtOp+sraNYqaW9VRQk7WcgGjI8q3aX02c2nJ49cw8hxR+Za3TG0GSPQYxVyqJp+S50xSeKNOy7sbW5dKW9BxMp2qbyzee3i9s7mRqm8fu3arjWbudauH+8+mZ7bfDrZvWadfcTlrUkcG7gxAk2njOsba6WXmKFaqF3P2FItOkGWAXBLBuanGXz+H0EQBEEQBEEQBEEeevD9fwRBEARBEARBEATB9T+CIAiCIAiCIAiCIImHwv4frv8RBEEQBEEQBEEQJIH3/xEEQRAEQRAEQRAEwfU/giAIgiAIgiAIgiC4/kcQBEEQBEEQBEEQBNf/CIIgCIIgCIIgCIIk0P4fgiAIgiAIgiAIgiAJvP+PIAiCIAiCIAiCIAiu/xEEQRAEQRAEQRAk8V5//n82cTeR/J3k35n9jZk/O/1Xp/+709+Ybk8/lfzz5EGST/wniHQY+/sPJg+d7tPpudy5se6CWdPJndv15s1yW2ndbJXrTZ00/e3Ej61ulVZ2Ssz6xlrpJaZXkNncCIQtWj9NfanRNOtNs33IrJW2V5dA0qwplSVTz+a7T03MXT6XTFi7bb1aMdukrHTadWu7HFCf939/Jd+VR0zF+7+/nO8WR0zF+b9fz3YvTMwtzw1K5eym1cl2zw+XtZS32t/8TLeQnjt3Lvl3r7QVtUL8Xfq/vuTU9c7KxaulQL0yi9MMY+rMTumlHeaFrfVrK1vXmSul68zq86XVK4sVUttvHyxC9TIXSzt7pdIGIzErG2tMkc0uQUqnVezkG5vwf/fqVWardKm0VdpYLW1bAi0rPTTnWulqCfKwurK9urJWoum1iklq7XKTGD0qQruHBDuLAdGVbebi1c2LWT9TnJUpXpSsXDm9AjrWTulyaatXqxv97DLDWuncgGc8DQ2lSXdGq8gtHg3WSaN9EKfWjgznqGjnR32FaG3zFhlaSF8yroyclC8Kllaz1mo3OyBdr7WGKg4Jx+nO8wXJzrEGQ4w0TaX8Sqtei1ROI8q3lIqpL4aEs5amUMOFdPn7fmY5sENF0+odqPFBfanRrBtmhVjdyWqkZp3W1rA0VCaQhrRIO7JETtT6BrO4UKnfXlhaODD3D+CrU2k3lYWsld5QWu24DuDEMYvsEpd19uZMVjEpvHi3HXIca3dJ+LY01OrtskqMepN4OuykwYhtW+fmVlCc9m67LSuKWS2rhz0K/GA/uRfmJdaJolfMWu/e/WA/sRfmJa4qd8pKu02qjXYrrgpCMr3d0dLSJK92zCbRYejfMsntWE19cq42p0YlR1sL2rN8E+bRyF4QjLe6QpvcaUMnoJ3X6QNVs1aGXeikppHYYgVlIjOiNYnShtwqsf0pIOFV6e7G+ou7Je9o6PTqnlB/qrRiL21uldYvb9Bp3T+Mhia4bO+U3XPQjZy/YRPSbFkHlPWN9Z31latXrzuBpbW4HfsDfckfv0v22FuiIygLCZm+/DTrnTZpnUBL9PHGGXbh2T3Qh3tizi0zTg3Hj5nogeiPpIBAQFPUAIrW5A+r0TVF5TM4PN347HSW2d7ZWl/dKXSlibkrjw88o6mSqkqa7jmNs/Xa0SNdMT33+OPJY9M/+3Aig7+/2H8G4sRY5yBv9UyiRVotOLgNVOHIeAeDV6B0A0egL+ANwMA5ktcb/X37FSp2hYm59U8OrFC7UztnlvbGodjNj5qOC2zcOX61y6fnPvnJ5FezfjPYccGf/Y1gR9yXNrj38y5JeIjPAqK6zPAJLGJed+rL72Tdz3a59Nnn5iaP1ttNc3/fWV41SVuxOm7FrJrt8n5HaepW07mtv7V+meY8Vnj6YonO3VCM7dLWjrsSa03vPQ9HscVtaPjVHWZ1c3djZ/GJLHNpa/OaLZClbVvkZB4UXIY6cCS3Vta3S4srFze3dv5/9t4Hyo3kvu/sAcnBcEguJcsSvBop6uVqBWAXwwUwf7HUcIXBNIfQzAAkgFmSWnHbPd2Fmd7BP3Y3SI5kyQ8YcqWVZPvJdmI79uXixHHiO+ecXHKxff6T3MW+57sX3zm2Lnm+l9z5nJyd3MU524kvyjvnctX/gG50N4AZkvtP3492tYOuX/2q6ldVv6rurq5KRG8USxt8iatk8wVujd/Mb+Ur0fglliusdS93kuGZS5GpBwvO0gjGhHissnhFh5akwN24qGp0jDWr24xNq1oU6Khd41ukQe29Sy9UBbn/05zh6v0l2BAs1U9TPYbyacOGqWR6fpQNs7lK/hXOZUF8/w8AAAAAAAAAADBY/w8AAAAAAAAAAADc/wMAAAAAAAAAAIDB+X8AAAAAAAAAAABg8P4fAAAAAAAAAAAADN7/AwAAAAAAAAAAgMH7fwAAAAAAAAAAAOD+HwAAAAAAAAAAwP0/7v8BAAAAAAAAAADc/wMAAAAAAAAAAAD3/wAAAAAAAAAAAGCw/z8AAAAAAAAAAAAYvP8HAAAAAAAAAAAA86Tf/09PhJjzD8995Oyvn/3imV+fKk2dD/+D8CV68VeZLzMbptwp4b1qga8tdLhwJBoN/XBUE3Zq5F5T2ecFTSP1lqa6fjBfzZW4bIVjK9nVTY51hbGxaZaVJbbC3ayw10r5rWzpFrvB3WJzV7ncRqxGGrvaXkyW4uwqV7nBcQV2kc0W1tjlZDxBYxq67OiFIv13e3NTD9AE1T9Aj0EUXiWqKjcbHhG2xF3hSlwhx5VZS0bVk9ejCqLYbDe0oXFaSrMq10gvDv39OhFHxtFlHHGISrQBedMeVlC+wMaitea9aCK6J+/u0f+0a5oiRONG/Kqg6iIVbp0rDSqwwthYMpGypElDJIHiRuBl1rS2Qu7KukWCpHvhdgRVEzTiWxAzxCiHWBPkOpFoISRZbQmauCc3dukvpd1omH+p7Z26TBuMLiM2660aMf/eqTXFfeOvqkCNrv+hkBoRVONPcr8lK9ZFsXmXKAe8Qu60rWuiQEtW0yOZZjCi8WYclTbPoDJ65C6vWIXVBGWXaJ6WNaRB2eXl603JMpOZiDsgXzYzUCy5Y6xEVdKg+TcsrZsoMGGjm/RFjAywa3p4yeiS+UK+ks9ubt6yLnJrzva+SxpEEbQhFe8j2TOLJJA6zdVoJV7Bng5RIbS5SEOqxSHRi9VuSSNiOSRorL4Osz6JUpcbQs0Z34zmCulXjvOyV912IX99m4tZjilh9CxngOXKElbbuFIscfn1gu4Le0FW3LinavUA1amBLRZoVW5y1OnmsuVcdo3TdZq5j3kbql0I3bP6tr24Xr6AiLZJ/SNbofH4dJwtV0r5XKVzrrMWjmRmQ52X5YZE7vdKwBtOQaW9VJAOBq8yX7EGkXxhjbvJ+kfSiz0Y0jOL8TPRr/KeOT/VyU1GyrMhxsiOeqcma4QX2lrT+M17kkp78vbmpzqrR1KR8qj48hv3OtlwZHY29D0f64+nDglPjC95R1VHsDGwukZB5+jq34ACG47vMDuoZEj8scaBFnVmpr8//ojgGAdGu/wjD2cNcl/jh46XDgk7kjXT4Q0PGehAXUI9D0b9KmnprfVJuHeFaNQ+jabG75BqUyEDTs4b3Pd0nrBj+9yknwu0O6bDZ5ntZIV11LbhcAIs5PQ8eobN6M+44js80mznU+FIPhPqiAMeSSJ6q6T1KRsuhrYolfiHMm8E+Cc/FbRcLk/llOlZoXfxgLcHDdswm52XJyN8ZrS7cSWeDsj5w83O5WOoSwWoO3xAOivUwWdCXxYHPJlTLiB2N8CrOYUM33b0qb/XoF6ZpiLpQ3hQ47WD9ZZrtD/7wifZ1OIjTFUcvnmwF/i0gyF9JmFl6InNIfx0+uTw0aYodvXQDuuju9dv73c+GY68+Eyo84K726p8S1BIQ+tfYDr+vdOWdHXHfjbNQH7Atnru8f4fAAAAAAAAAABgsP4fAAAAAAAAAAAADPb/AwAAAAAAAAAAAIP3/wAAAAAAAAAAAMD9PwAAAAAAAAAAAHD/DwAAAAAAAAAAAAbf/wMAAAAAAAAAAIDB+38AAAAAAAAAAAD3/7j/BwAAAAAAAAAAcP8PAAAAAAAAAAAA3P8DAAAAAAAAAADgHc656TzzvoliaPr+mW+e+eLpg6nfnxJOqVMfOvnfn104c2n6m9P/1UluonjmFya+nfltpgx7jeCh0qmEI889F/rqc5qwUyP3mso+r5C7MrmnOv9mfjRX4rIVjq1kVzc51hnExqZZVpbYCnezwl4r5beypVvsBneLzV3lchuxGmnsansxWYqzq1zlBscV2EU2W1hjl5PxBI1pqLKjF4r03+3NTT1Abe/UZVWVmw3fYDN1ovAq8RdiS9wVrsQVclyZtWRUPRt6ZImIsn5hIIaZ415gvsDGooIokpYWTUT1BFVi/PE6EbVoPN7PBv+6GqBMD+DvCjVZijlE44YFLNPksuWKM5DNltnVzeJqPM5+coVNJzNLqYW0MzFJ3iWq5pucpdIlGGdX2MV5I0W3Aj3uOk2IjT7/6mvJ2YwwW739fNRISVSIoBGJFzRqhQq3zpUGU3JIXF5hzbrcLuSvb3MxV80lfCrKKWzVf8K6eqVY4vLrBb0B9YJc+uLOejUk+sGqUxtbLLBr3CZHGy21cC67xk3H2XKllM9VOkynHI4szYY6UbkhkfuDanhNUPcHLzJ/3uoC+cIad5P1jaOn6cmTHqDnqW8xPXudT3QK4Qi3EOrc7udB0DRSb2m0a7Waiqbav/3CmD/rzU5A9F6uBsJj9u/BzNGLTY00xAN+nxzEH36ssxmOLCyE3uT7PmJAlW8Of8DrMwZELN/hSm+kI3HnjjbuucXhnqRfTG/YPjW+b08yAgwPIO4Rcb/VlBu6FzAqVv9jp9YU94lE/6oKcs34o93YbzTvNXqeQS/imJ6hJ+rnGfp6hngGQ2gcz+AQdHkGp4LH7hn8unW/Wrx92gobt0Nf7WxNRl5dCDFGV1Lv1GSN8EJbaxq/ed/OkfJtsz/YCXU2wpG5aKiz4OmXKl8jgurqACrz/YH90BIf7H79QqkaNVTCEOLJ/ZasENX2Dk91Pm3mYssnF4KoNRV3Lr4+JBeGeHAu9P+63LOVr3ZLcvqrzU4+HMlEQ92cT46aDcLX5LsDpvk+K1Omq/fNmx2RthFPBi3HGadhN67S5sEa+bI6ZU2Q60avk2S1JWjintzY1QfndqNh/mX2VM2QUYjYvEuUA1rNd9rUzFI0Tic/Lx5hovRS58pkZCs6TgsbaFoq87VPdUqTkfLs0MjOoWTOM/b8yKc614+kIu1R8cOf6lw7koqUR8UPvdS5Or4V5txW+N7lzvZkZOO5oZGtOaWVtj35/DHd/uvjp5x2p/w9X1rvFMOR2dnQ977cH8EcBfMU9M95Ry5H8JOa8Vrt/WgDmKf3jj8LVtv1uqAcDBsujBHIluuPPna5Uka5Uotzy/PWMKS2a+OOeT1RvzGvrydwzKONQ6LTADJWci5hb4JuXYFJis0GnXmMM866JR0D7YCKJzUHH5hWW1cdQ27QqGw7Xc+QrAeMGI/fgpEe7/8BAAAAAAAAAAAG6/8BAAAAAAAAAADwrucc7v8BAAAAAAAAAAAG7/8BAAAAAAAAAACA+38AAAAAAAAAAAAwWP8PAAAAAAAAAAAABu//AQAAAAAAAAAAgPt/AAAAAAAAAAAA4P4fAAAAAAAAAAAAuP8HAAAAAAAAAAAY7P+H+38AAAAAAAAAAIDB+38AAAAAAAAAAADg/h8AAAAAAAAAAAC4/wcAAAAAAAAAAADu/wEAAAAAAAAAAMBg/z8AAAAAAAAAAAAweP8PAAAAAAAAAAAA3P8DAAAAAAAAAADMt/z6//cxK8z5Xz3/lfMnz/wPZ77vTGX616bqUx8J/1r4YydeCf3H0PLEl6mAH931DgnPlLNTD05piry7S5R7TWWf1wR1n9+TVa2pHPB3iaLKzYbKi0JLEGXtIFgkV+KyFY6tlPLr61yJHUPX9Cp3pVji2HyhzJUqbLEwJNL0jatcgY2VuU0uV2Fzxe1CJfZ8nL1SKm4NicXSWDQBQ0CWVgrcjYvW3/Fplr28wqYyi8uL8zQj6/kCaykvZfNlLpZdLZYqieiNYmmDr2TLG/zVfLlSLN3iX+FK5XyxwG/mt/KVaPwSyxXWOomOFI5sZEOdG3JDIveHFF4PCg5mftoyY76wxt1kR+ihZRhqtJhV2IQRSv/bVCS5IdTinVxHDEfy2VA3PCq/Ylsbkt3/fNzsUjUjc2tfsHKZIHdJQ+NVcqdNGiJh17hyzi6B8SNe6exMRnazIcYohHqnJmuEF9pa0/jND8lOakiZ/rMvcR0hHMlmQ9/7AU3YqZFg2SFafsruD9nVTW5YE41Ru9ilyhcqnN55rpXyW9nSLXaDu8VmtyvFfIFq2+IKtOVf5XIbMVv+Mptks4W1XvxPrrCZZHIplcmkF+aX5pOZTCqeoPoHLNtLp1CssIXtzU22xF2hHaWQ48o+WTWsaacZ1ytxjfYUWrZctpzLrnF6ClZLYyvczUpPrR5gNT1vwEDterJklnRAihbYKJBCRJof/nW12XBrtqJREZbVQ/m7Qk2WYg75uBGmW61GGrvaXoyWouIUYLNldnWzuBqP6/ZMJzNLqYU0jeRMWJJ3iaoFJ22pdknHVxbnjXTdOvTo6zQ5Nvr8q68lZzPCbPX281E7PVEhgkYkXtCCLOSQoA7NNM92IX99mxvRoQxJ3QHn1wt6Sxv0FnHfVtF3KrqEb1vw0zmQtEe1Ed7X3RM0rOlJhf6k0UtG18oX8pV8dnPzlnWRW5uOs2U6DOUqnec63xmOcJdCne0AN2c6ipawSwLCmL82wsP1NQT5N7P7BLhi05Fd7/CTkRdeCN0y/I3lyGwbDPxk/qrLswyExhpCnejmixc6r01GhEvjO0fzeirIED/54Ebndjhy6VLoy7kAtzjMyMxfGeEQDam3xBse3Vft08z5dnYjgE4dYlFB00i9pUUT9l+8QlpNRb+gtnfqsqp7e/pDIXdlck+/Ku/STEbjRpZUw6L8PjnwTcbpqRyifUe1ylVucHSCtGgYYDn56L5DL1min9YTcRb9jjrV+Ww4knku1FnptyHTQCq1oyi3ZOoenFeZn/D2S0+EXn+0QvqZbtIOY9SI/qtvBT2by51XJyMbzw3tN3ZKaVeW/tJy5zNjR025ov74G4udW+HIc8+Fvjbb71xWqEvyL3q7kRVk9B279Tr7jKsN6RXh21p8e8VgraqxQK9fVZp1h1WD9Vgyhiqj1zWPF01QdonGC6LYbNOhZZc0iCJoVCKosQdH6LV9pwMwR/tW7YDXM2iY2BlUb0rEt68aAYZLoB65TfSerhGiWB19pymN7uKGkLdzp4zqmksvLS4/ev92dMy3ch7gtahX/WBvHeE7Qp2bdFiivuPFvu8wvazK912v8zLzn3qdhzdGz3tYQbF+kJ/XuDGy69tJzLny8heWO6+MHTXtivqf4P0/AAAAAAAAAADAYP8/AAAAAAAAAAAAMPj+HwAAAAAAAAAAAMy74P3/xPnfZ+g/AAAAAAAAAAAAeHcTmTixMKXvCKAQtdVsSHS3JFnSd/vB+38AAAAAAAAAAIDB9/8AAAAAAAAAAABg8P0/AAAAAAAAAAAAcP8PAAAAAAAAAAAA3P8DAAAAAAAAAADgSXPu7O8zZyd+iznzb6b/xuk3wr8z+VdPJU/86xNTE7917p+f+5FzJ859cOLKxLmJc7DUu4ZuqtMIzxQvTR2KmiLv7hLlXlPZ5zVB3ef3ZJXuAXnAyw2J3OcbTV4iNaKRAIFcictWOLZSyq+vcyV2pJrpVe5KscSxa9wmR+MVC0FRpm9c5QpsoVhhuZv5cqXMxso0Sq7CptgrpeKWGa3VVnYJTzet3GsqsnbA0jhUtxEkSyvFzbWL1t9xmu56vsBaOkrZfJmLZVeLpUoieqNY2uAr2fIGf5UmVCzd4vOFNe4mn9/a2q5kVze5aPwSyxXWOjudumG0LjfaaO2WJDwGo5lqbKNtX1vLDjfao5eye7lTC8/kn5t68PSIUqrybkOoGaHmn+qY5TKlp7NXKlQoXyhzpUqvTJYmq/a5GxeN+LLE5stGYyhsb26apZxm7bj5QqUYlFjMagAJS09in15OqJqwUyP8PjlIiAqhFpZ4QYtTja9kN7c52tb0lO2Yjlwkomb+osZFK8yh4dK0bkG1s29Y8OGJERZU6Bar5J4Rav45rgVNaX8LWpqeoJGs5uW0kdq3kJl+gIVo7H7vVds7dVlV5WZDZbNlVqWBZgdWbb0rjjTYbGGNhlgX+3FpkGn2hc7r4Znrs1OH90Y13F7cwWyM24B7MQIacV/j29pWe9kY2l4PL3Tk8MythamH2RGGEzSN1FsabWKtpqIZUu5L4xrQHcvfiAOa39r2LPSt6M6HbUl6qanR3ZEPDH1DGrkV3WjhQq+FC4EtXLBbuJ2u3bw/0dkLz2xEpw7JeLXkSv1o9TK0Qt7WJm3lYbj/fbmzG57Zzk4dqoGWuksUo3sOm9/YMiNt51U2zizHjvV2TnRe4UrlfLHgneq0OlXDhN3tsUwYNNs5lgnHn/P0TPg4ykynxR8Jmi93vq1zJxx5eSHUuWQ0a8dUhfoFkci0W/B60/YLYP6GVXxjwsUGxh2YA/UCY9bvXu8hd9r6vuzxq53WZOTVhRBj5Em9U5M1o400zc7sm1DKN4c/8+A7Os1wZGEh9KXrRt/0k/KN+V/YVatb0jf7bIx27F4R2Ap3s9KbybEl7gptyIUc7fTO6V+MNmTdHFb/yWXLuewal9AVWYXXvQ6nt6WeqtxVLrcR64VfZpNxPYJhWXeipqQRQFtNLCqIImlRDxKl/kXcp//fbuw3mvfoqBmtCnKNBsQNVYJIWx2vEnvaYap1FMEKMrKvR5CIRuPzYlMipqyZsvOyPq3V81QssTXS2NX2YrSwFZcIHThWN4ur8Ti7ylVucNRZpIyRIpU2S0gN3VQkwwEGWcUpcnnFssy1Un4rW7rFbnC3HE2s17qm42yZdthcBfv/AQAAAAAAAAAADNb/AwAAAAAAAAAAAPf/AAAAAAAAAAAAeMeD9f8AAAAAAAAAAACD9/8AAAAAAAAAAADA/T8AAAAAAAAAAABw/w8AAAAAAAAAAADmnfD9//TE32XO7J65OP0n0784/enwvwr/yOQ3Q09N/N2J1sSHJz58ogIrvWPZ7Hx+MsJnhp4SqhGlLpuHdtLTH9XeOaGe68wvvFntfC4cyWRC30/6J4V65AJi/9fe00I9QsZ5ofaJyMapmY6DKgcPDB1yUujAGc0DZ4BuF/LXtznreEzr5M2BGPGVucVxjxDV83JRbNZb+um/9NxQ47d+eKj9tyjQMzVr1kGi9PxjjfhqNEMMlZY9jGNJVaJpo84h9TtTdfBAUrVdrwvKgW/SzuNHbbnAo0cX55bnrcNH1XZN419Xmw3nEafOy44jTvWqZVn9Kn9XqMmSUy5uaHbmwqmkl5NPrqSTmaXUQpqqMs1Bz5uX9BNLHZkYKJojQZewN0m3Lm+iVpmNmuEleZf+Z5gx3ZLxlcV5I8UBBXrcdZoOG33+1deSsxlhtnr7+agzqRGHu/ZlLq+YZ7taDcYZyz4ftx/Qr5f+1csrTnWGLjOi2TRXHM3SKIpXX9yoaEvabrh+slYp4s5E9B61MtCbjLhBLSqgLcXjRkszsqLrfMZXqY/OeP/c285HOwfhyNJKqHO9f+iz00foFzwX5Qb9L3V1P+899Hkwbu/AZ5/4vYPT+6ebJwb907XO/cmIuDLUs/uotny7X6Z/7sFnOvfCkZWV0Je5vnf3kQzU8LNeD+8jZjgCXwft9PVDnTO7wlruudkiiqDprjDQUTu7+ID4qNOVXSPR+KPPsX0ELdcxvMSAEw72f0d3uOwnV1in9+s3yCCH5JAwDpvu9ahm5y49ZPzZUOf9/Q5F7hptUqGeVx+qHNeYv+PtQgPSvR5kXu91Gjs8vthpT0byzw7tIpbOOWfSf3uxo40bMe2M+LcWO+q4EVPOiP/lmx/sKOHIs8+Gvt7sdz0z0Cn3N70dzAzxzpuCTll/nMer92oicHCywu0IqkZbR50nraa4N6xbOOUcnX2sLj5Wxz7yae4t4aDWFKSxuplT1tvPXJpcHS01l0oupV3JjfYgbkmHBxlQMcSDtPR6arZVfk9Q95wTOXeAcypnJ+4UcKbtihiQtDV/o83XkbB/IftSjkQcUYcUThJIndbMLmlYnj+osXoFDf9ltnOxqUgj5mF9kV48x3jW8052JzIEzBsRr+fyCXOYwDkvs7vkitXAfavMmpX1u2+QbG9W1vPaeP8PAAAAAAAAAAAw2P8fAAAAAAAAAAAADL7/BwAAAAAAAAAAAO7/AQAAAAAAAAAAwGD9PwAAAAAAAAAAABi8/wcAAAAAAAAAAADu/wEAAAAAAAAAAMBg/T8AAAAAAAAAAMDg/T/u/wEAAAAAAAAAAOY9//5/KvRB5vzfPP0zp3em/l74D06dP/nLoQ9O/J2JG8x3wj7fkjx8rnsiHMnnQ2/mNGGnRu41lX2+QVSNSDypVomo8SrRtBqpk4amDg9lfiVX4rIVjq1kVzc5drgwG5tmWeuyLJF6q6mRhnjA75MDtsLdrLDXSvmtbOkWu8HdYkvcFa7EFXJc2dTaUkhLUHp61diAhjhbLLBr3CZHM5PLlnPZNS5Bk7MyU29rgiY3G/20CkX67/bmJrtdyF/fpnGucrmNWI00drW9mE+sOLvCzi3GdZ3NtiY262RAj6nADssX2FhUEEXSooqiiWhVkGv0j7ihQCEikVsa/7rabJhazMiu6/myqbdYYmP6Bf6uUJMll0yczRbWWCvPtNAVt4ZsmV3dLK7G4+wnV9jFhQWafVfykrxLy+lbDEunW1I3weK8keaACj32Ok2KjT7/6mvJ2YwwW739fNRITFSIoNtS0KhNKtw6VxpMyyFxeYVNxqfjbLlSyucqhW5oMiJcCjFyQyL31Ts1WSO80Naaxm/eaBZWc1KI2qy19bpS+VRAAPP3H36mOxGOXLoU+kq+3/K9gkHx/1tvW/dKvR2N3IgrS+6a1AMETaPxNd8wuaFqSls02vfoluCVdrQGH1VDWsTY3aelNO+SBi+0WjXZ6ESNpmWYwQ5F7lJDNUQyRkEGRB2lGFTyWBu1HutKscTl1wt6zcesKkv0ayjuaQ1WmNoT1oU8DaDXXTrFLhOOrC+Fui8YHcS3RfEt0pDkxq5vIPPfWC08X1jjbrJDFegZ8W+zvQuClhhsv9QKN67SQrIq9ay9ajblaaXaY4YmKLrbjHf+TOe7w5HsUqhT7BfJFmrvvK7/t92Q77SJf3n+nlUey8c7iuWrhOYusFRWhH2aj4Qdi9bHpztfnIzcXhrqozwmTPnn9pe/+sXOF8KRpaXQDz3d90+DYv5xf8nrmwZlDM90ZJfkjCA3NH0cH8Mr0Z9UTcnITL6Qr+Szm5u3rIvcWqDPGkxdTyrA5znqw7e7O8PNwdjqaZKstgRN3KPNTZV3G0KNTlEatiPp1+wwH+Kof3aVq9zguAK7aPiQZbOnOx1if5AfUOYY1AflvQO7R6NrcE8nM0uphXT8bfXrkkDqVHCXNIhiTJuCfKNXsOciTbfgl9+xHEbCZ8qViLYb+43mvYZVxdYQ47KNa/CxQ5wTMMtabgmHpQaiBljJlf7g5M91PWDy55TxthGXhqDJn8M7B9WPU6RXM1WZdhX5c+6Iprw7qJ9z13WqyKHXUGnGHq9m435mttNyBrnMpwf45U4fhyi6dc3UdQscNwe28Xxz4Qz05MQKjPenvJud75qM8Jmhw4lGlLquic466Zil0vEk7X+d+UW8/wcAAAAAAAAAABis/wcAAAAAAAAAAACD/f8AAAAAAAAAAADA4P0/AAAAAAAAAAAAGLz/BwAAAAAAAAAAAIP3/wAAAAAAAAAAAMD9PwAAAAAAAAAAAIZybuJfMeeZOHP2s2f+w/R3Tf3DyV+c/MCpmZOJ0D87X3pq+xx/9heYf0+D40xns/uB8EwuM9WNaoq8u0sU40hBiein/dJzXmWi8vT05XZLoqclmqcNCqo73D6AtpRf14+GHBJ/epXTj0Jmt6+t6THsI3c9GunZquv0UMYyPfs1V2FL2XyZi2VXi6VKInqjWNrg17hrHD3Rt5C7xee3traNo2+j8Ussvdhpdr8tPLPwzNThB5zl0ZMwMiKRGnEUxDfzA8J2rq2jaJ25VqfpocYF4zxH7ma+XCmzMSvTKfZKqbhlncfbVnaNwxz3moqsHVgHIVvn4K4UN9cuWn/Hp0cUvJItb3iKfOY68+++BZt4l+ueC89kn516kHLWtEJP4nQYm99tC4rUD/GtcN84drXnC2WuVOlVu6llVL3TE8yr9BBa1aprWs0F7sZFekZts90wDhnWjwU1TiB9ZiWq0FNx7+oHjU4bJ5MO1fq6caCzS6t1dZz2UypuVzh+K1/eylZyV+0us989G57JPDt1eMpryJpcl7UjGNEhP4YB7fLlituFSuz5uKPTmGIDfUUvrt1X9INlF+fHK/FmfitfsYurdc+EZ5ZocZ/2FHfQRYwo7WgnMV5recxewiyzxzM+1502yt35vH+5HT5+nHIPdelW7R0row/e3z1NO3Zk6kvbjoyq9DxehQh1XpDuCg2R9NukXz79pQcze4VVyF1ZpQdRJxrkPj3xVz8/l0on9ogg8XuCumcXyK5C2v7sKOwzK6xeK73fL7ApqwNTKZc+W9R9sS/vaBjG+cQ+rYPc1Q9g1w93JoaI2TrIRWf7kCXzdGPDuZCLdkIrnqRdYnb+V5yFc0m09KvNtmpahJ5frCvsmcglamTTuGyocwqNbLb0IGQuu8Vn117J0nPg+Xzhlexmfs1qFIfR7lR45sXI1BsfGGgUtBGObgs9IW8TMM+BHqhnWiN6VegFNcNXjFq1ZEs0KOYMo6ePa/JdEjWs0Bc0DpYW9fZX4/XZjdzYtY4nd/ykx0a3dA/iOrncjKT/Tc/x9klvQKk73RVndL/YrhwMxrXyQI+mHl1h1IR8pZQtlPOVfLFgO5rr3XB45oXIVHffVVUu1+pfUSPc6eNypGP40EGnRCccP/1umRl9tntqMtLMDz1LvEHPCafnkdtHnRNNq5G67mKsM8UDw5n/7rPdk4+gPjVC/a922O77jRl8p+07gx+4FRk+gx953zFyjPKdcneU7vvCM5eemzo878xjndR3iOKZM5mXfTPqjREwa7J0jJw2WXIj5k3phcVRHWCL21rlSu6Z00H3PJ0o0lJ/zFvqwanTyEKPnjy5yvyWzZ6sgnuq/PnuU0bhuxMBhXc0zPEKP7Rx2hV5vNzq3/9Ph15mnvrfz906+/qZtdN/MpULf2hy8dQivUjpfFf3I+EZPCcx6Xy2O0MfgkSnurecdStoGqm3NN6eFDm6tBXkW8P+0QKq2VY05vxyRGvIVirc1rUKX+JeyZf7I3I33v1weGY9OnXY9Cuf2t6py6qzhA/V7kfDMyvRqa+e843gnnSNZY3x52CDNjnqXEysCXKdzmD8JmOSrLYETdzrz8SM6ZZC3ZCgGn+S+y1ZGWsO5tTll5bSbjQ86Yj0Tl85oG3jTnvMZGw1fkkYNaeZc8edWlPcd88ij5NcX6XvZPY4k1VvNoaby1kq3wQd1eVMe/SM1e4fQTNXwytmaD951q/Zuwe4cRr9qBHO29LfkiHONoNnjIMfdPvBcX3bQEQfB9eXoA///Att9BmXHL3V1ttEYXtzs99j/CQ8UcfuCNur9GmgbiJPYzi82H06PFOOTj2s+xnL9n78jmzcRx7RZP7RvYbTBNro9TsEu2SJXsx6UwoaMwz/44nqsid97qILubU5BPSHsbrNY7rRA1X5p2M9A/LV7Ul07N66li9f0x/b8qv5wlq+sO6pse5G9zvCM1vRqQezfjXWf74t1+ttTdipje/IfOJ664pWjuWBEsYrHes3vb9xVF//GXii/+Ca/knoTWCiKqj0/4xHcLbcLmkQRdD0Z3SSQB+UN5xXRPqMT7+PFDRvQxjTqtntytViKV/xvkrqXuhGwjMc9RainzmNbNIabDS1ZkMWxzblQLyA+z2vPzTisZ9coXd92U2unONi9iCxlb0ZM0KdN4K2AmuYsCpkxWzNxt/xRHLstneF0x/J0fbLbxXp/xcL+Vz/7cGHwjP5WffTHvOdnjnn8xk2+qGBt+++kYe9QDTVPZ7xw7jpNycJA0PI4cnuB8Mz12enHn4woLgyfYmpeXvZ+EX2KvBzi/3+pf/XeLxrdRyrnRndZ7iJ+rHYT/YfUJsXLB/m1mZKDaRgClo5sq1t/7RCrXzaodbPI1TDYLPrznS/3XhvfcgNe2898Lr3yO+tR74BdsV4i6dxQ16Dnzv5Y0yYWWDOp5/64Lnyia+G/unE79Cf5v+CoM/Yo/Su77mph/dcb4hoxyH37EdVjleBxnX/t0TeKEFvA00lY1lu5LMt861qb6zpvdEg91xjkPWeddQrl/6Eynjvojreu6gXLe3u2ZiR/EXPmBeUj3Feiujuh7uhP+FxvQ6hj+I+4fMozrLm4FvMURU1xnvMI1TTY3yRaRTe71Hccz6P4hxlcb7KHKvww19mmnLs8XLbPdf9OH2dOTt1uOTMraN1DVSXI8Qv174RA6rNIfsWV92QGwuGmfpZPHMEAAAAwLvhJeHl7rPGPK779JB5nGPmebR53NAZqPNW5PgTr+7T3Qv0Uc3C1OHL/o/3W01FU/1fc9ihwx/0DygY/tbDln/Lbyqu0R/em4pPd58xjNN9ZoRxHFV8POMMreoBefZ4pTl35seZMxNlRl/tP/3bp788tTT5zcmtU+UTfz/09ESZBjyLDn3U/r/anaN3nSsD/V9uaMa6JnfDoM/w6q0mDREPbAm/xuGJHNAofNSNahj5QoUreBvG4Se66fDMy89OPXStrjLXbYpCSxDdi+bNdad+efeLEvCQx1Qycu2StcY1eOmS/gTmBYcG6zl4eXsrlsuWOWsZgZFMlL5RaAnGu+aK/jttXbZXnNGXNlovMMVymzR6UjeQ8VTcXNLq8D6WMmvB2ug8ptjL7OLCwtzIZVZXqccrlm7x3Ct6bTlXWx2e7aaMZfkP131qak+QG0eppr78GHVkPNlyrF32feNgC8RfSB2lDhOpeH+VtGdlsbHYw0qkv5b4CPqp5jVa9NVbbK8AazTrrGFZNjVydDDrIXc1my8MPnK7202a3w181FMfg4PmiOoYPUS6auOtGhnNsmev6U+V+WJh85Zd8mj3RfPLge/2L7nD8Y1T8qGuzqrgY2a1e6l7kT7CXph6cN79aFAkcsvbbVR5tyHU7OCAh4SeqAE9aEDZqK403XvoHNybBlTaT5/Nq/YjaPvXtNG3Rk0P8+uF7CadNuS4vP7+n7u+rb/as8231Z2lNU3Nl3HNcc0kBHH/aLYbjHdUw+3TtQErdG39vrVgyP2dhN8je0NT73H94MN621LWg3qtOfiQni7jb7qe0I9rz2yOvivNUU8+4DSoQRN0oTA16IJPe/Q8+R27OY7x6NfXqEe14KeL+YK/m6ECLT2xVu8TFLX3Ws9leWNtSr+NHrGBeqbpa90XDIN2nw0yqPMW7GgGHX4PNtAXH60cDBP625hTg3fVHdBBN+7z0tFyGb6+bMiwMK4Le8vfXJkd1+elY8znpaOjLB6/M6rwY7ibcd2M5/7/9D+i7/9XmDPnwx8/9Scn/9qJHz37Mv05Hm98pvsSvUdcmvpa3jXfM2+d6JeddFGuc/n34N2R7+zPJ7J3WYsdLMm79AOhhP3zdZWu9arK1B7y59yrvQaTdqykNO4F9VZjrC7u3Q4mBm8B7YV+xq1HL+ZKtN3YbzTvNXzXKtPFaaTlWpQcN8RGfsVpJk0XuzVrbc1eWaA4VhYoFy0Z5y3/PjmwvltzXdPXD7yVuQ/8aEsvRMNRiMYRCmGk3LhoVfVKL6vOwuk50gPczcO5onIgxFiE7oyhtyA/eeN6T9rVxBzSzuujZzDclSs0gKffNueKW97Pm7unu8t0jr00dfiiT+9yO9Ej9KxRztS/p7x195amUTzGyHeX6FPXpakHH/UxRsBSuiNYZZy1dAMNsremzlKh34Qk6AN4e6mq3KCflrdFvfeajsl5wXJc3pWqvTwPc15j2pAu+ar4Llh9obtI1//SNXGvutYmEqUum1NXeo+peu46POG+6xODlQStjhuM8VbvlcKVtvLmFJze45a9be/hxe6CYa43hZHmcn50emxzDf8YNdhcrq+f9O1CDAHPZzQrUdMlS1HLbRpxzEu2Q3N9SeAOsta92+NJ/5Ga0+qO0PEGKFvauJXXRfQ/HNcH77gNGc9tOOv4/KFeFxQzNetvRygdWNs1reftzWW/vUsOQfrYUTLWYevXDWWuKy6VhrWtnr1iqnRe8soaNnVKjjlwjGyxDDORwW3IcfYKSnTnjXc3h/WAdzcOf3j0dzdD/aCPuv4s1X5qbfdN724gj+IjRze5gLdEX1rpZuhTlqWp7/2Az7A8+PnnEcbjI3wFGjxhcftD54yRms85Ce6/A/KZBQ/cBiR8psWJ3jQ6HvdqH3yVNNZMe7jKd8U9h73bSyym9Kbt1NT0E88GL7RaNdlnZOpl3n63Zha9p8AsIu1KZk4Gy+izPUncvkF4C0z4Ntz4jDuhDviSVf/+P3zqAXPqwVNnzn3izB9Pf/j0t4VfY75OR5Cfw3AAAABPlsNXupfogsGlqTde9plE+ay1OcI8aqxlNwEzqP5Y2psfTZsD+rfE0py5x7A0J9nNhmdu56ceuj4+DN70yn2DESjnV+FjKA248QiMOe67YI9prd0Hj/JSmHheChPfJwf+86bR06ACvU/m1nqzIa5S2eS2/G5puie7nzLqrFsfu84cT30eX50NfQoUXGePyw6Hle7L4RkxP/VGeDw70MebRHFuZ/aYTOHUG+DAnlgLDmqJxqMh/5Zo3/Xoj4d4+pm0Qh9SxaiGwafB0Y9fNLO9RZ8365c3yEE0vmJ+bm0Up24FPGIDH9jFt5vsXg7PFC9NHQo+o43j7m9wqZpHYMiw46smaAmbJ8rb88qhxJWLm9sVvwXxHaG7YtismxttM+cit0ew2fDFb16bPXIhD+90Pxme2b409cbtEYX09PRjl3OMvj1O83jLOnV/H93Br8nJRcdrIPocY2D7mqhDRf8d0Ypz54SeIu97IkPOe3n6GE17wBucw/l/AAAAAAAAAADAe55p3P8DAAAAAAAAAAC4/wcAAAAAAAAAAMC7Hn39/9SExpz+4dNzU09P/u6pvx76yVCOXgBPjM5GNx+O3N4Kde7Rb0XIffsEW0Xf8qQm0yPNeeOUW/r/+qHHqn3Uwyg55n+2vrqhx/5yN9lx1epbYxRGSscGdz/rbUT9nd2rkxF1K8QYhVHv1GTN+C6rafzmR2YjNbJc33jjRHc9HNnaCn3lnrE326gYIzX+lv19kv7908iyGx8Y9Tbn1rfC0b9pulbKb2VLt9gN7laChg/u2lHhblb6p0iXuCv0oyO6gXY5ODX7JN5BU8f1+rE+mqPfSOeya5yeYFVp1uk3Tk2Rbn/l2EGul79e2rmrXG4jFiS+ylVucMYH1PrXR5lkcimVyaQX5pfmk5lMKq6nRPe/Hj8df+ExUrHtQjdRpN+etRS6B9KAEc0EaqSxq+3FfMTj7Aq7OG+k4KdM17O+WVxlo8+/+powW03OZm4/HzXSdpwPHVAsh8TlFTZpxBpW4MtB9WPE3C7k6c5dnj7lq4ru8cKW6Yd0uUo31b0SjuwWQ4dLwx2H3ZL4ZoPQM4FEXeNIYeY3rU5hZm6UF/FLY4Qr6TVw42M4WtIq3VvHeda3o7YS9wjZrx3wuots3jMV6C5L3/XG+oLPtSWQIaBvzlSjFSUdlIhE6CfAdOOe7lyXC0ea1GhzRzAa3b2b7lOkDHU2PcP9w+MbzpHOuMYbbrd4f1P1/n5GwZvaUoPVd+TdNj1bg/6tEE050PNCzfah7pphtu7BmGbrbaFpVtlos/1P4w1XQQm8BY2td0a27fz11rfTzU1G2sUjj3e9cqRGm+Z//JrUXQ1HisXQDy9oYzXC0Tp/fbwxr3cevG64wfL7DX5sdrtCN3qg2vXPzS2n6Ik4xgAwfAS1OpdrDPAMlCvs3KKhq1/fwQOxJaOPtwFDLP2yfJce5jH+4BccYYzyi21F0U+yGT+5ITHs9IJz9I4ciAM6YpABgsTt0ieDS9ncoZ+e36Ujelul/9ciikgtSZtHdtNTqb6SdhKZjJFGKmnOCUyv62euR/LHid6erYmoWGuqxs52RjGsQdBI0crvOONigm6ip+3RSqk0S5ZIo5mjeZI1S3OtKRq7zNrf3TuT8IQZablrgx6EQ6vc2jDRaAM9B24HxR9h8mXujzAslkOCxurrcMzdjLEhNrArrlGfPSP2d7w1rntLbu7IGTd3B+9rs2rJo2yoIiulAWX93em9jeBo+nXdxmny9pQS7/8BAAAAAAAAAAAG6/8BAAAAAAAAAADAvBfW/+P+HwAAAAAAAAAAYPD+HwAAAAAAAAAAALj/BwAAAAAAAAAAwDuac6d+jTnFiMzJP2LE8z86/XvTD6cf0p8+PLzU3QrP7Ban3tzQ6J6idDPPUVvIWtunvzndLRlb2X59YvhWtq1mTRZloo4UYH57vK1sbXljK9vBHWGdO9geaVPYcXb4NDZvpPteavJdwrcbOzR/krGfp9hsiHJNNnZgpbm805bNbUCtPTPVdovuDaqq1raZRnQzsr5r4/DdWR07WvrJ2HtDFktW9ugOn8EbuK4szltCR9vE1YhkbDE5zm6ujiwHiprZNmRo1o+34audH4XcldUh++n2wsfZrfft3rXUqh/HtrJjt7f4iLp1Gt2UGqd64s625cjWyLY9TnYsI42ZJae0e8PTTrl7PRwpz4W6Lxj7dbdVYZfonqLGVwW51qZ6+vvUUvvRv3xEmH/s2rt8DCVmxqlD8ZG1bTZql3K12aZ7D/O9VrrGlXNm1PjZ/ZO/hNEMAPCu47Xua5OROxtBJyqodNDQhy86ltGjMlRzLNOD6+afqRECzD89nOjeDkc2NkIPzPODRkQYpe+fuKafI6Stw4NMmRGTT0tsyOSTjhB36cii8Nqevp+793wD19b8NGIl5hMlW2ZX6dQtHh+Y6KStTexJQ7fSsFmKQ2LEXvu9kZdhTiTR1gEYj51u+VjnzNh3vUPOmendSP8veP8PAAAAAAAAAAAw3xL7/51hNGb6D6f/1vTd0984vTj1kZM/P/G7E9838Ul6+YnQWevK9BXcSqh7wny0YT0c1QR1n2+K5qGm9LRSfufAfvYbJML8vus93BiazFODgwRj/Qe1if6r14QhRi+p4h6R2vpzz2pTiV/r7k1GxJVRj609mUkHlub3rnV3j6UyFajy/3hY7lbDkZWV0FeWXM++ByUDNfxz36fdg2LGY27LTu5H0gmf59/OMCPSqDfzbqGhr+etc1idVRWk1S00xqGxYlOgFhRpBPo+lh4KK9TUwLf/PqJjpECPS277HFtsnX7seFdgCtI3y4o8bLXKkZYpjJE/x5uLmH+30KWuFEtcfr3gluq1gbjPOw+jQenlcMl5itR7m/AG3yXhmWx06muCtRzJpYg3l1Hwu21BkVwhdmsu5dd1YwTHml7l9GKw29fW9AgDXkOdpqesF9gCd+MiraxnVtji5hr9a9pYpaJfdTR5K7R/xSFlmY7fpz28J+i82Jd1VJQl2L9iSdGada8O0aUkUiN2E/As7NAV2/1qRZe2f7yQGpDqL0y5rMv1f3oXf4yV6lABwwx0CUlbXbHWikQHog8P9S3SgExDqBMjXP9jIIy+NKMr2IxQ88+BcLtP83W50daIakgOXgw04IqPAfvlbpD7Gi/Rzi0ELX0xct+XujwQy7HsZZVbp2twyrQP5SpsKZsvc7HsarFUSUTLXLmcLxb4Sra8wZttnM8XXslu5tei8UssV1jrfqgrhWdejk4dXvftYuYbhSP2MEcku4PlC2WuVAnoYDEr77nidqESez7OXikVt9yCLBUscY4xZmWg/+km87a2uL6+ai49rok281v5imWZzoe7YjjyYjTUkT0zGFWvBNcF5p8FTlIMYe+URI05ajOhO0KziN5CGGUb6AqdP9PdoSM+zZ3okzv/SZXK/O6QTA6bPgXNmYbl+qWuMBnZio4zzRmYLqnM77zU/c7xI6fckf+3r5zt8uFINBr6gW3PbEh1y/6vgfMec7Lj9y7fHFFpiLkyUjXGvlfp0ki6QJKujjQP5jbfzVP7rMwtx4fNjo62NED3YiMXAxhCQa//U4vm3Mn0eOMsLNDFAhcTLKZT8/OuyZg5yvkunXVKrEQHPWnUUDN4NWhG45HrZWzBLGcyuWzNEo2eE7iYt606F1bSZYstoa32zq1/PKtJzYy4fL5rdezgaGCt4XVeHmfi+pingUdax2rrcyQRqNjpLFx28PF91AyOq0dJxZxOD8w2BxfYjudtjWsBQ7Y+KRpLl9WufHUN02Ob/Ci6XMth9fv/k0/9W+b8L53/3Pkl+gcAAAAAAAAAAPAeIXty6kacYU6fOEEXyGs8Sc9JcwuitFBdkuaXxeSOsDy/k15a2JkjopheXnJ/Vcv8oEr/yZ5wqRCX0xlxZ3lxWRAW55d2pJ0U1ZPZWZQWMulMUlgYVKHQf7Ihdy7mRHEnRTL0CcXivCCkM+nqnLiUWZpPpZfSZFEaVHGH/pOdcKuYr2YyC5nUEhEy83PLRM+LIC0sS4tCemcuszOookX/0df/nzx/izl/eP7W+b9+/h+jdQAAAAAAAAAAAEcgfuLGxFiPF072JEc9RTjR1zniYUEoduLG6bGeCejv/0+c+GPm3JWpnz7xxyc/PvEPTvzQmedQfQC8N3lz8fCz4Rlxaerrt61Vvb0Ngox1c/pTQrrOUN8ppKWvEaU70JGapJpLdn1FB9b7HkHd4BL7K2xPTJJ3iaoler/J/RYR9ZVPvVV1dBGkb1LWwnxrKby5lsteTk7o8ijSkOieeuaCcedichrWS41uVNgS9J0Sp50Lswcy51q23l947pVxLuD26PIWbKhaj7h3hbudhG4UuiRW4qlt6EpIuh7S2pTRR/8w2cHsD/9kIG58iuBn+SHWHb8OAjOqr9OkcZu1u8YGkxIRa3LD+FMU6AdKtd62lyOKvBKlJpbHqnt/wxxL7pkVn0SO1gKCgqfH/dTDlunZQ/Bv4o4PQVbMLz0ESbe1+eUBXVsYvKSejdpdlnV02V6vZ+ky7r2mQnfNZGWVlev1trFI21p1/+aHDl8Nz9yinis61HMZFavxvejHd1qDmrz+Kqg5vvXO6Un19neZ44NzgnN6vM7JTtHs65qfZ3q4ePgZwzO9uTvUM2mK0FBlY4PIR5xODWryeqaj+KHhxtdNay2J93FV7i7Sa+oD3SQxqvknei3bEm0bhWs39hvNew36xYW9A3hsaKcdmpt7dGShVfikM2MnE5CXR014RBuWazWyS1urf1vuNRur5Z7D/n8AAAAAAAAAAMB7Huz/DwAAAAAAAAAAMN8S+//j/h8AAAAAAAAAAGDw/h8AAAAAAAAAAAC4/wcAAAAAAAAAAADzTl//f5p5nnkqffbL078x9YfhzKnPnfipiX9BLw1weOn0mRsTz9y+cfrEg90TKlFVviotSZnFueVqlVTpOQOp5fQOEZcWk1KGnj0wn146obWVhr5xqUI3QNRIvaXxOwtzyZSwWE3RUwnm55eXBfq/heWl9DJZFAUpKY51EALzg9/4/AW6v2FVrpG8dOGlC2PFupDQ44g04+ukQXdE1HdBvPBSKnGhuaMShe7JmNUuvDS3nEomdUGiEvrzQlXf5XO2LtynsetNidToNbEmtCUyawYtzKZokEIEtdmg22Fy1WpT0SOaUUzRV4iiGoldSF9MXUwvJvWs6LuKqvrlLaqWBkmkKrRrGg2S6b6P+h6muWajKu+uycqFlzSlTWhG21qrrV1pKnVBT0LVaLL12ddpynqsRlDYF6i9Di9P0dqLHqX2QrqUvvskKvCdUIGF8Jkbp6MLtAIfpsarQFf90S1GaflEoTa3PKvekzVxj0hjnSXiX1ejYh2rrvbk3T1HNe22tNnFWYFaQhhSQ7o6WSQVmVAzN9q1WoLWuUrDq0JNpTYXWvpOqELtWrMmiwc0WrMxq5A7bbqFsaH1rkzuWTVIdx9v8uYVVwVfM0tPJV6611T21ZYgEr1tNOu0xoiyrRK7glu19q7cyAktYUeu0W3M7eukobc1KdtqqRdeevW2UaGfnNR75C1Hj8wsLRBpWRLml4X5+aWMuLxIFpaE1DJZXqQdIjkXCqxRe7/eWWpLkUiEbic7qxKx2Ri3jhtPrI6XMpnl915/bB7On9L748YRqu8otTdmtalPrmsmk3PvvWpTD2+f1Kut7HCjiztpSZhLZXaSRJynRyXtSKJA6zGd3qkuLVQXkoHVJjeoW5GlWT2Tqja7I6hE39D5nVZ130peVT1cOKHX75ajWy7PLc6nhbnl5flqcp5UF5fnkwsLS0tSOjVfJfRYrsD6pe6zSkunUeu8Yyv3PdMvoyG93lKOeluqCsLS4vKOVBXI/GJqaWcpPZ9eSCczGYGaaycTXG9GoVBTT6imNib0mnrR4UFpDc3N09pZmJ+T5kUpmakukPmd6oI0Ly1K0uLOkB4mkfvwl2+jv8T7fwAAAAAAAAAAgMH6fwAAAAAAAAAAADDY/x8AAAAAAAAAAAAM3v8DAAAAAAAAAAAA9/8AAAAAAAAAAADA/T8AAAAAAAAAAACYR//+/+TENnP2N8783vTTE9sTU8x36tdPfRG2OTZf/1S3Ho4sLYX+0kc1/cQF+/wLTVD3ef2IJ7mlqb4XmX+ZK3HZCsdWsqubHOsrw8amWVaW6Gl8TY0eFXXA75MDtsLdrLDXSvmtbOkWu8HdYnNXudxGrEYau9pebEA6vjK3GE9QLdYJFLwk79L/mEoKRfrv9uamW4NbMr6yOM9mC2uDCvS465vFVTb6/KuvJWczwmz19vNRI6lmyzp/wzeVfmi+wMaiNVnVoomofgQG/Y9ID93QCP2DSLJ+mZ7LQejvuKHXNpEsuRXrYYbZrACzuCo9F4W3j9uiaVW4da5k5cETWjZzWCx5Iq5ylRscV2BThhEyyeQSPQ4xvTC/NE9Pp0nFHWm1W5J+AAsvaP6pOcM96TkC7RSTI1NskPu0PtokMEmXgCdNZ+j4iZpVElxMZ7gnSUfg+Cnq59GYNW4mREPcYY50zECW1a/zxpldMYdk3ArVU7Raey5brjhF2GyZXaXtOh7v5TBtyKcWljPp+WVDg67HyKHZXl3GGGjuDokxSuwooF2SXn9ZMfuKowh2o7fK7wgJaOBeCW+j9Mr4tCKvkLfavTK9yrJMZNrSWW2OwhoeIaCwzvjvmQJbvu6RihwoNVDsQLnjFD1Q2RGKbw4Gbvcff3tNcfwKtr3DlWKJy68X9EE61h+84myJu8KVuEKOK9tjmhrTrxcL7Bq3ydE5AfVKuewaN6jEskJiuDJjDqFrdMl5lE/H2XKllM9VDvPdWnhmIzr1xguaIu/u0oPHnIrM5iDdFehZlfxuW1AkV7A9iynl13X3NyLq9CqnF4jdvramxypeYZ0tjubRFX/6xlXqLwvcjYt21a4UN9d6P4ya0E3P3cyXK2W9UZVpEXMVOlpfKRW33JOqpii2FUU/cVNlm1SU6qYZaV60jGpolqVpu4abF/vWM8L6Px0y1nTNJ3NORfoJvG16HBdPDxIzhByFno5Tm6zT5m9lvZTNl7lYdrVYqiSiZa5czhcLfCVb3uDXtjk+u/ZKltY1fyNfuVrcrvDFXG67ZFR/NH6J5QprnWp3PzxzfWWqm/epTKcR+EbT6gtBEkOq1l/RYO0WAuOMW+Z++fj81ta2MVe2SvpGovt6eObGytRXi6NKKjfooW2at/Eep7BOXXZ584UyV6oMLa/Zksdsqyqr9RqoRhvlit4FrHbaa1eas4HqAj4NVOt3nJ4KTwOliuiZ3211JSrQEzDvWkOQGRLgBM1ARys2M+Bs59OGox9WYno/QeOSBq092iXv9Ep8xy6xKeAozp0xinzHKA1ZibZIQ6Kn90XNjHgzofvWkU7i00XaSgcyqtezkcemM4eD7sSvyqy8mYOdnT96lyPTE/7oMd3mL6G+I++2m22VDoDxY/ST7DZ1DaV85RafL7yS3cyvWf0F+/8BAAAAAAAAAAAM1v8DAAAAAAAAAAAA9/8AAAAAAAAAAABg3g3f/5+d+FMm9BMTf3r+uXM/c/bg7PPTvzP98NSfP/mHJyuhP5r4y8y/pCI/AEu99+h8vNsMR9aXQp1tuSGR+767DfA7B+bXR77bFfxf1gdS+cIad5MdqoB+7zL4KZQt4vgOMmF/zdj/RDr+6W5jMnJ7KcSYubxTkzX6dVFbaxq/ef9UU/4Z/j+7fPe7wpFcLvQgZ+zNoOuh3222mg2Jr9Mowi7h1WZbod/6DAli/o1rn4YhksZXrUGbFBzto09To1eJa6OGnlB8YJeCdDJ59K/TL6+wZizn1hLO6upnKt77dLTzHd3PUxMvhDo5o4ac1qGfmUn6h1RGjTQ0vyDmj12Nakhs3Ux+wTHrgy2jCGtcOZeg+2UYf8Q7n+h+LhzhaN5uB+fNKp9v5v5odOas6IG5c5ovOKdv7nYPwpGFhdD3Nz0N1Vblm8N/62qaF/xkLlh7iPRagLN66adi9Ps2qmSLK1QSj6310o/Z9nwbrhFgfvymNLWm2KzR793on6q9xYfc0OgH4aLmzIMZdSDEseWDvfGJSyDOrrDWzif7tPZ9c2MEmN+dN+t1gRpNaNHM0F0jaK6qco3w4p7QoP3bcZl+r16XTRs5r+pF6F8wyyLWBFUd1n8NAU/fXbD2a6HfUTrLb/z2llq/PKhicd7QUG/SjzedKswLXh3G9UElqfSyoUUiovmt9ZCC2DJDMuIb3QgwKkBvuS8JNd2Wxp/3mso+/SZS1PcCoDXT7hm12dZoZfmrMz6ztAVMtaJIWtS/US0KqbZV4y+VuhN9xxmi7NCtB+o8rc+6/vWlIWR0HqLwVYHWv2RtQUBNZas1t7zZpU7TEnnpVWH2czzd+sb+6L8mmJvv1NUgp+uQ6Dldtb1DR5JGoKN2hLOxZCJlWcPhUgIiOkV6qZlBZndcYfudUe81fj3NUhkPiKx3Xz2m0aHsS87u0Bsvpm9225ORfW7UAO/0ZGKzrefIMc77hTJ/2L3S1ai/50IPzrm2YvKTHqrp//bdmMlP1HfEdzrYI7lNkYYSsa1/gm2m4K3TNe5KdnuzQreQscZvT5ReHftsRzTQNBwSRqxeLW121ckInxlZSVYF83o/dlaP6zrzr7vprhKOZDKhwy+4K8YlFxD7D/wrwyX0eKvhcbqrR6iErtK9E57ZXpp6IPptb9Cb/YoCTVjWDnx2N7Blhm1tEKBnxM4GdixzWwPHV/W54nahEns+7vNpfW9TM/NL+eAv+eO6JWiFcGxv+w/vNjlsRQ+jOyctstwmFZ1P0n3K6Ffu434wX+JyXP5ahc9lr2Vz9GN5e/uMG90W3Qtlaaq7NNTq/ntnHMng4+6a0bP1EUs2uF8Gvv8HAAAAAAAAAAAYrP8HAAAAAAAAAAAA815Y/4/7fwAAAAAAAAAAgMH7fwAAAAAAAAAAAOD+HwAAAAAAAAAAALj/BwAAAAAAAAAAAIPv/wEAAAAAAAAAAID7fwAAAAAAAAAAADBY/w8AAAAAAAAAAADc/wMAAAAAAAAAAAzW/8MOAAAAAAAAAAAAg/f/AAAAAAAAAAAAeJff/0899Sbz1O8/9eZTP3eeO/+Xz2vnP3T+N2EZAAAAAAAAAABPhIunmBM3Jpgf/IZKVJWXqsJCel6aTyfFzHwylRSETGYunV6sVheqojQ3N+UWr0pLUmZxbrlaJdX5aia1nN4h4tJiUsoIojifXgq7xQWyk0kJJDmXXpifTy7OCUJqeUcSk8k5YX5H2NmZtMVVQzyztECkZUmYXxbm55cy4vIiWViiUcjy4uL8UnLulFt8cSctCXOpzE6SiPMLmRTVLND46fROdWmhupA86RZfnlucTwtzy8vz1eQ8qS4uzycXFpaWpHRqvkqkheoJt/hSVRCWFml2qwKZX0wt7Syl59ML6WQmI6TJ4k4mNKuLn7bFqdjcPBVZmJ+T5kUpmakukPmd6oI0Ly1K0uLOuenbzPuZz0+cOXGeO/eb5x5OV6d2p983+btT33HyNyd/auJ7Tr55jjlbPfNZ5vPT/+Qx13j3qcNz4ZlX56YOn9YUeXeXKHWaY2GX8IKmCeJenTQ0lVdIlSikIRJeIqJC9Is+YrkSl61wbKWUX1/nSuyYiqazVypUeo3b5GjkYsEv3vQqt54vTLPs9rU1PQlHEFvmKmxfrdhsNzR2hd3K3owNXp1lUwk2GWdvXOVKHCvJu0TVRYubaxfNH5emucLaw/uHU+HI3Fzoqx/UhJ0a8cmOz6WJCbv02dVNzq8MbIzmX28OcrPByxJb4W5W2EKR/ru9ucmWuCs0U4UcV7Zl1JgsxXV7WJbJZcu57BqX0LU02wotlUdJ7iqX24jVSGNX24v1hOLsKle5wXEFNsVmC2tsOpmM61paTVXWaEJsvlDh9Aob0NMLt6MnjehLRmTLeoGFcBQ8Zsoa0RpCnQzLNC1kJWYIZcvs6mZxNe7J/cKCoalOJFngtYOWvz5HcL7AxqJynVbHi63GbjRh/f16i/R/7MrV3t/3yE6L/tDIfe3FVk2QG/aPuqDsS817vd+iepf+KbRaNVkUdEu9+LrabETjRv52DjTCm6UKMrBTxF1I6nbTy8tmNdFuImhEok0pSI9D4vIKa8a6VspvZUu32A3uFhvrt7pEv+0keg0gPh1ny7TX5ipXDk9PRm7NhRi5IZH76p2aTHMotLWm8Zv369Epv84QOiwfToYjzz4bemPf6ESOQMefzH90dZrBzuJsY87yuFqM1bhoP16cN2xnxVqnjYeNvpqczQiz1dvPR9/yRvOOaAaDLtATdY27kt3erNC+bSoZjGBo6rWPxcPwZCT/bFD7cLULZ3tguunDk+FIJhM6/ILRHlpK83UiajztPErzrlDj602JqP5Xmf/gaiX+QkaDsYNsx+hsNA7fZIkNcbC6Sv8WogcYbUMv9UtCraZ7AP3Pe01lX20JIqEX6kKjLdSsFtBuSSMqziHhNvfm4anJCJ8JMre/JfhUgBn/v8PnDkPhyNJS6OGuUQkSuSsbFV2nGZZoE5To8O97kfl/XVXgK2N2WTOk1d6hPtGvHoyxQzjg98lBkDns4F4j1i8ENN9+DEdz1eNUZUXVeNvxqZqgaHyjqclV2V0VpoKR0mUzuWJppOJeDh6h3j99eGIycnspqN59zc+n/GvuT+mU8bQx1VMPJ8KRFz8a6jxnqrWmGbygiHvyXSLZF5h/b1V2vrDG3WQ9cnqX6c1R7Iu0EAlnkde4ci7B0g721B8w0THmoa90vzAZkXOBnoX+pVAH0aQFswcccyTTPU1wIPMn3cnDs+YE9/RYE1y58ZgmuD1F1gQ3Xyhzpcpjm+AOXnmBjhkDE9sCd8M5se186PBMOJKdC3VyhlH9sy/6F33ipKtRBMcNKKBrDuIYqfR2Eu9MHE6bOXs6MGdmQfxydmJkziyLBOTMmkF8+pAZ1ul6PX6veY/X9uTGvtzY5VO+l5lvdiPd7zZc7eGG4Wp9xfzj/juXq/WV8b2VCBjsRt9NkIYxGAR5qX4wG0smUo88qNHOfvNJPLvoLHa/GI5cz4U6olFjw1yG2VSH+Y3/x9WoRuvSTTtEamjzx/f/AAAAAAAAAAAAg+//AQAAAAAAAAAAwGD/fwAAAAAAAAAAADB4/w8AAAAAAAAAAAAG7/8BAAAAAAAAAADA4P0/AAAAAAAAAAAAGLz/BwAAAAAAAAAAAIP3/wAAAAAAAAAAAO7/cf8PAAAAAAAAAADg/h8AAAAAAAAAAADMu/77/4nzP8XQfwAAAAAAAAAAAPB2sz1x8vatE4KmkXpL43cW5pIpYbGaymQW5ueXlwX6v4XlpfQyWRQFKSmKQqPZkEWhNrc8KzbrrRrRiDSrHjS0PaLJ4qwmKLtEY37wG9PG/f83GPoPAAAAAAAAAAAA3kW8cOL26XEfFBjv/5/aYOg/AAAAAAAAAADAOBymJ8K3b4sPdsd+Sz2uXK7/NpvtvcNmW0rzriwRhVXvyZq4x6qESBc/f4Ferso1kpcuvHRBEEWNF5fTGXFneXFZEBbnl3akndSymMzsLEoLmXQmKSxcSOhxRKKq66RBFEGTm40LL6USF5o7KlHuEimrXXhpbjmVTOqCRCX054WqsFMjs3XhPo1db0qkRq+JNaEtkVkzaGE2RYMUIqg0641drlptKnpEM4op+gpRVCOxC+mLqYvpxaSeFaLUZVW/vEXV0iCJVIV2TaNBstqsCfQ9fq7ZqMq7a7Jy4SVNaROa0bbWamtXmkpd0JNQNZpsffZ1mrIeqxEU9gW8/wcAAAAAAAAAAJhvlff/T038I+b8zLlfPSedmZz+0dOvT30zHJ/85VPff4oN/URohQb+LGz67kI6nJmM3LseYuSGRO6rd2qyRnihrTWN37xKjAdMfL2tGU+79KC9piJrB7xCdqiMyqdHy0x8m3T44UdMJjVGMu9/cP/w6XDk+vXQl29p+rO10XHG0Pq+XInLVji2kl3d5NjREdjYNMvavUqW2Ap3s8IWivTf7c1NtsRd4UpcIceV2b4KU1iNyVI8QSNbDyaHRrZknHHMZ5zuGLmrXG4j1gvMF9hYVKSPC+9HE1Hz0WI0bsSvKs06v9t7rEklK9w6VxrUNCh2eYVNGvG15hix3UIrnkRfYFOGMoWITUUiErVMkCqnSC8T10r5rWzpFrvB3Yr1ayDRt2fCtkTClRUj8nYhf32bGxVvIMvx6ThbrpTyuUrz8DvCkc7Eq6PauK2JNx9G8+YHVrTx1OgTYOJo6CMEJ853Y4eRcOTVV0OHz7la+4iI4+p/yrfdj4jl2/gd1eJswsNVqo6aOHaj6NXO3uGHJiOf3z5q5ehvCmjZVPpYfUjNOKUmzh1uHH4wHNneDj28N7RanLHG0nx2rApxRnkctWHokxsaaXirRGsrDa+XMuuiRhq72l7MEomzq1zlBscV2BSbLayx6WSyr0GlfrCt+mpxhlvOy/pGkTowPVeK0m6Zv6oC7avm5WtKc5eaQLV82yO1nObhtx+rX6vNtiKSMfr1gODEme7s4QfMfv3i8Abkjjiu/unxmpE71mNrSVbLfMyd+9uO3bmtlj2ic1tSE1MPPnP4fqNzf/mDozu3FWsszeHxO7cV5Qm6WrEm0xT4Oo0l7JKgHu6RWnHkRu/klgvwyAU5A6N0GrmvDXMouWy5EutLZsvs6mZxNT6oMzWXSi6lzbbVbmhynfD2cK6/0hyZgm8kb2JpswCL6dT8/KM35NcO3zcZubNxvCnEyKmDOjHZLR2eD0c2NkIPnh5jyqCO0nfqCFOEI7XXYVNjU7e2R19PSyMGH690UNN7pGrrCIdPhWe256a6nKbIu7v0xbzV1mn2BXGvbngYua6Xihqdb7ck+nbeR8Y2Zym/rmdgHC3Tq9yVYoljt6+t6VGLBb9YVGidjp5lbpPLVdhSNl/mYtnVYqmSYKOWOOsQZwWFsL2EovFLLFdYM/f/+w2G/gMAAAAAAAAAAIB3CRcnTtwe+/sLrP8HAAAAAAAAAACYb5n9/87/OEP/AQAAAAAAAAAAwNvF7YlTt7c/9vgO/qNf3vWu4/0/AAAAAAAAAADAfKu8/2feB5sBAAAAAAAAAADvZaZx/w8AAAAAAAAAALznMb///4sM/QcAAAAAAAAAAABvE69NhG/fePr0RG8DgEySJDNL8wtSMiPM05X8wtJcKp0RyTxJLVRJdV4QRY0n6TlpbkGUFqpL0vyymNwRlud30ksLO3NEFNPLS+YZ4SHmzy6b3///FYb+AwAAAAAAAAAAgLeTz0zSZwATp5/EIwDz/v8nGfoPAAAAAAAAAAAA3lZu6Q8ATj+JBwDnzvwF5izzK8zEH09/9+nl8B9N/vypzsn8ifc/9fPnlLNrzK+c+yrzY8wPvLOt033+MBqeUa9PHc5oiry7SxSVqKrcbPD1tiZo+h9CW9trKrJ2wCtkR25IKi/X9cCdGuEloh+GMDpKrsRlKxxbKeXX17kSe4w0ple5K8USx65xmxzVVCyMoYTGWc8X2DKNkquwpWy+zMWyq8VSJcFGrdisHZvtxWbN2Kyssr1MROOXWK6w1p05/Eh4pr4xdXh6wFotpXlXlojCq/dkTdzjNUHZJZqzGO2WJPRNFSAfYKdxtdtG2r62lnUbKUDDOBayo7JmVNaM6mue+cNnwzP3tqcOoyPMoxIi0VpS2zUtuDkNizSmoYamE9ykhqk5jsn0+KwZP8BuFx7JbsPb1uOz21Fb2ZO32zNHsJvc0EjjqO3NinQUuwWlc8T2Zqk5tt3M+AF2Yx/JbmO0t8dit2O1tydot9zhx8IzX3h16jAzym7NtiIS2vRrRKAy4zc5d7xxrTcitSM0PLemY9nQUMFaKgLM+Gce1YwjWuBjNuOR2+FbYsaZw48edzIyvBU+6mTkqK3uiUxG6OT2XfBejs6/P/EI8293N3gy8+9Rjf+tnH/nDp8bz3OY7eLoDngg3pG6wONwwAOaHqFLDHfAH39UM45zO/P4zHi825snbEbz+/9/wdB/AADg/2/vWGLbOK6U5IQUbTWHpEkD1ehKbUARoVhRcuzICRPIMm2zlkRXomIXqcGsyCG1McmldpeSnTQNkpXtOE0DpAh6KtAee+whl5567amnHnrrob0VPRQ9F+ib3+7sj7ukJLh19kEQlvN5M/vmvTcz772ZjSGGGGKIIYYYYoghhhj+z+H5scnE5OT4+LMTE+O3nprbrq4mvuzB39SZPyaSiVri9O/Sv5z89VP/nHh26u/w87jg/oK5l5wuvpT6lNt3D1TtTk1XWl25Xeugzg7YO1p9WWsI6W5TS1AVbkopb2yVNqvYlCIiSd+8VtqQNipVqXSrvFXdkuaY6aQgXdmsrNOyFJ0uQVlARJKURnGjdDPPnqWVjcuWhYZlNTW1U7PTsmlJqmyeSEuGOrgdSJEkZ2OsvC6tbEm69IMKmIzAKtRU2ogk9TCZennAr+dZOqAmeGjP9Lxf27RzeR3snAjoLc1l5Lqh7KNMLqM0sDGJYJBIsR4tNlPMaKij7qNGhiTPkQaJeaqYocEnGfw+rHgxg8eNuL5c2KBWHTpSa6Eu0oidlfaPmscg1kXtdw0hFypng41lmZuVzeu1rfLVjZW12npp/VJps1beeGtlrXyZmcTuv2Wqyents6lPSw6eZcTgQTi2pZgwI6e7L+8Oruo2CV6R7JHJweO7CMJ56CMhHzyA0dLINWUdwny62JrXYGm1uto1NBgbwbDIJEHgGR/2ZF0jPCJDEcI4OIekHBDhwpwhc3ZNc4ahKdhsafNuZe1ynnEVHkNZZBwYeqUDTJHLNBS9J4OZUum24JfW73bZE6oD22jYBL/XVzQom7VQzTHWwBxgU2kG+sUZAZgVSwnNZ6TD+fYvhsIuRagK/FpXG+huxs7AFKVV8RNPF8mOc/FvGyXvoCTgsEZlpnjgTrKKU0LxRjNt9SDD8ujbZ9PhXF3a2ipXNmor1Wpp/Ua1trJdvVbZLFd/xDj7Yd7sgjbOpD6fEDmbs6Wm9g0kaGPOE34s7VMnQB1zLF59DK81Py+tco4tSDJ4TBalHdXYxQETansfQS4MiQTEkAxVMnaRhO7ismv9rvz9jnxXMvq9NspTTNeU1i7BAaEWmizVd+VuC3zhHUDRJulQX0NNVcMuyY6sdCXgMsyy803UraNGXhANeLSFw5B1KgfGAMkwBMkgZZyaGMtjXtD4DoER0VozBVTr4GqdfNBs0ckLMqfnBaE0LC0OXefFDT9ElmQZggSRAoJA0XxbgopO8RJwUP4t2rzP0rGQFLn0WOXFOcivTT1Cm3pAm7pDUAPa5tMREXyPktHdwhoovg6VIQhvBKHlwrpZ2a6WauvlrfWV6uo1JrEf6WYHJPaFlHlWkFjwKjUgvANPIJY/h6T7SKpfWe+EA7NLva1AOdC5zVxdVbWG0pUNVWTSnLqDaQ+zvnuyyemGhuRODfXU+m6uDs8GTOSywXWAHkaD8vr6dnXl0lqJO/eeN9vJ6dLZlLnNXpsNvF5ryzuoXbuDhNfhea63H1TFSwFSKGcVJcskhoBpLhhfki2Vt4gaw5McTWCjb1d2l8CJg/x3rCXaCYkPmK/b8znzTnL6OlDm+gDKdHWkGVQrD0EcoZZXlwcQw3rd7bU1uj5to27L2J1bXdmqzjmLgUK7tFa5lM0S4lwqVW+WAFWBiNy5heXzgyikdPflNmgFJ6UAqxUpMfbteJfnD4ffMntkQfuwLE77XPUGrEr5rsFv9g+p6pUusv7LeVfyjLNIQyMvU/0nWtl3muVrVmGuO8piNXBh6npPcYHq2KnwVSOuxrdN9kbINVHNWBunyEvCG5uVK+W1UuCSkPr//5WAvxhiiCGGGGKIIYYYYoghhhhiiOFJgamxZGIyNTkxwfz/kJRK/Dsx1Tr9dOqvp16e+NXES+NTkPDkAhiX3/UYl4kFKsC47GcGG1QlqnFZsHqdsHEZtxTNuKx4jMue13Qal6MSJ8y47EeMx2BcFihlG5cNczf5wptnxz56Ec50obs+tvN+V9nrW46IXUaP7Y3yD7fxe14u3ZICa+E3s+3rc1Z29qPTZou2e5W36yYrjcLgGa2Adv1rWe2SbKFdHgniiuJ4tGA2k9NvF1NfbDHugM73UQ01m9glRzy2fdchOjLeAcXcXBMRm5d7gvC7Pc5zPv5dVhf8WAoEyOxxk7IDJcLGV3AQSwi3hvI0EyzHe3kfb69tgd7L+5ie97hnlmOxLMh7PBBG7uworb7a1zOCs9IeDXdwBBiBQTLe1aEdwsZEMHifazg9O1MspFlsAs4UiHsHOKuIVcQ+Akr3euAEbOBmbZM2rVBHCtj5MTJBIIlIuhoWi5J2xWLGvR7yK5WhrsVMeOFc5nt5o691yxAUAvUMdNeuxZQDqQzp2DM5sL6fqlhcWODonIwjRlqxnwEMhEFkiRpurwYeAwNcCTUrGMuO/AB+MURPvotvJNu7zs5k00GjLQNfaEbGt5jNoUIe6QzkRKYSqz6Ie7Np6ovgjgwPf8k7EH6hdnkomC9LAbUxW2UHKWrSqkTFUrJbEc7ddhS9g900THMfftdEyelyJvVQduisDhBYbgH1kGG0UQc7vkVVRUfTVz8F1fRO+qykoKEoWlstcXlkJYuZt+kL8ppM80py08BnOq0Wb3slVIzMY1KcyzRl4DT8UJdBFbTbViQVDJQ/Zzt42qNQJY2xgWbrQMF7RtmA9kxE74fcImNd6+/YKl6SLQ+dDv41OHcM0X6FdIirizMGp5u4tIGAoTrqGRKE/QgUpKSV25xNbpsNYJNi6pM3fdlEYGjS4aFmtCAk6ZUrVSgUYR4jLw5EYEXLG9XKYDLOWcTL8WkCXKf8WQd1Xe/3OznbE4mHDWIgt0vgeS3kMEPZURy5hVwhSxcLq5WNK2vl1aqNPytdrnCe3ypVyXgLTRbXyxtzYhdgNNrgwGzkhcRsTqzGe1dcX7k15+6xuzrPYCiEEFFYIpZs1bUhZL2+vLBwobC8vPjKuQuwMlwuSFVngZe5gi+tbZUGMhohu1ATmG1X7uuGJWjAW6+lcUzpN806rJ0yqUdLvgwG8t1RcHwz6OOurng4LYJCCkTB+MzljA9SS0PpksfBmPQYfcyYx8OYUxPvJMYTf0mc+Qr+zcDueObJ2OTfP2XuJKe3QOBeHCxwbGM6qrCJ1YMUeixfX1/5SiQmq7HRMYYYYoghhhhiiOFo8OCaeRvi2S+kPnvGdlPRq9PwvafYoonNJmBC2VeIGZX7qrxlvI6rUDxeQx/PZ+4ULwavxY9XIeYz/oMsP33NerbHjySkXWcNrQzsHtB70CK2M6OerFFjPrf+WhhDyhGbHr5BFhbc9lZH2Law03kkLh7BwaGusHNBDcf5XdxmAK5iBnxaik/bVucaSgvphmgedmEeueRM0aehoCrQTTDJkWugHcMWlO3CY721bDicJ3YJe8/1BkHdQHIDUxUSHAb2QT5M2DK25LZ9BaDAgDaH2rYhHv8/+dvE04l3Esk/nPrHeO7Ml+n/wI93jk9WzWvmveQ0qqTut5is8mMQsHFCtbbSUYitE06T9dS2Und6igeX9W7Sh8Ht9SOGtubewmNWEw7Dgz93BxA02BHmbl1pK/RWUcdB5vAz/JaPqCcczO/l7TOQ7MhkwHH7wQfgpQx7Twm/5zx5T4kem6RUkiiViBWdOsb5wfjXzH5yulVJPboeNpbW8WByDWrIYAacMx4KuVcr1/uahr0z/oeOQjtDxxoLYzCiGTIewflMnYeMdmBX2A20kiZwgQZcAP1TQaECP4O3njlgHGmCdtHobRU+dygMfjUHCrgKIuAShogI+Cs2wXqEZ2vQTaR9n/SRmZfduGs564F9wRmok1NalH1vmEZy+g6w715U9rWOzp4MAzvRD7wGAqx7LaXrQ+ecDw2xTewAoTvte7UDoIl6QNvVsR1O3QHhBi1R6+vwr4fAUQwVbG9PejjhEO9gcConqulwmcC+0yqB2TYGn3eccZwXdzIQqxVAAlozIFPotR+hWI/9suyaNjGZgrCJOwpjD4rYMpGpwy3IldSDyag8ba1GrBCRk2HugHa8XA43SNTVDsq11TqUFrz6w3GisDylfl6yJG2rOpt27YU1GV3aqLVgxKNKk/jimsTXubskFHfnjay4OKEcqstzT/Pvx7bjnd8xg/mseRcWp+upww/DpIetNehV6CES439f/TCovXethzUWcng6VI7IaWoeehFliXFskzS4wGBzOK922zzc8uMZ84AMi/U9gTDa0f3TiQyLiNp7d3vosJwYkRKJ8auxBMdw1OMAk4XEqcQXiVOl8T9NPZf4YvKrx9yhw2Xzg+R0v5J6uBx1RTOM4WDU1czRDAgD78CKqKm5EYIYBbhJwHV9kutGP8E8UOQ2CmqhELL99mbBS2teK2D5PHBpfSSjREOFV++qBo/1fA9J1HQpC9asj3XzfWJtOixGtDZFmtBHtDaNOKM7rU2BjGIbiUQDkXNPFmQgOpp5SJdsexYh+6Nd8z34ilMl9YvvRCS7EKN2IqR34x9i5vYa+8Q9rpO+aevmL3HP59wD2mW4FXbGa/VnJWw78Ou4iP3TNhvSLYyP5d9lg/Q3+3uVQDbQkeBvwfTHy2Rd7/fw1WA6CkEeUDxCd+0iw9mUxJoB+umNATaDEHv9oFr+NCAbVesEQHQDcs6HdjlfOmWDHD8DxjVovAaNw//kUGXDduPcXRKm7DwOk0Ri4m/xsjGGGJ5YuL9r/iQ5rVZSn56NbFSNup4Z2ZoasqARovqH2IVgVT8n6HkrGMCt3dmhFHLYDC/7YJ5wVXWVcCJgXlLrXCOe3wztHrFv5ixzbdaDdlC97LB9pMisVxyIi9uNGY60ez70ntD0VnZkua3FxYx9AyFzArH7ion7lrZrt2hhTx9tVvP6/4Hfx76RTcBfDDHEEEMMMcQQQwwxxBBDDDFArEw1ffrmZGbl5uTE/cIEvqCm1mjKryyea5xbXKgvn1soLMjy8vLS4uL5ZvOVZr2xtMRvsSE7cjgcoHYV2AQvvTqPYxnA5DtPv1IPm1W4Y2mpXt8poGU4lXv+nCwvLi82l+oXli+cKyxeWETnG4kv//z+LHO8lBuzF2cj1ZrNzbKwwqtWVOHsxUJulkfwrRizF5deLSws4IJ4hwyYd+EzQlCRfDYIfrZ6xvz5efhyjCZDKrh14MIa6HypCTeK4OLwFSJIx+iUOqoqSJu92O2327lZ/LWZ2YtN+BQdys1CAIeGLxy5QczKUA2+OoRt73DqgGDdV9DBOrSI36wP8bY0BfcfR4cROt6gbw8lLpKPqvTkOoICELPWg28wads6ZBlaHxrrtfsQUbkq9+QdMPQb93g6+xbOSq+nz158+/YHQFS8/z818XzizG9SP3/qNjzEEMPXHg5XD8dIBNrDWsQItEjBJ6NFoI0Yc+IIDBwt5CRScCA54OVz/oB+SyX4gID9Kc2AwwMUwSjhKXKAwTfAkHy0WEb77irPgZkHucMEYaOfFSKyEQtfOAk2ElEfMxvxyxSjMRK5Gy9CmBP9UqkQ4SQ7Iy9GYciRoqHkgczG3eW2N18O9zc4vvoYHE0lh8QjZJ1fnJQD/BOhDb0R3lL4B4dGiuGi7MXk5ZNnzA+T03ol9XlryNg/4nI52dA/oYljcL75eYv48VceruXMGfUUmSNu0Ddy0BPT5GZtkbmlQTIkstrwQR8R2DQ8RMcjFNII/jdnb8KCliI36ez5Edo7SRpHIrGgFY5bI2Cu72v83MuDH5s/JSrhs7EhVcIOwqfKTlQlCE0cq0pwebJ9VIN/icegInph8V+9EaO//HVPJGd+VFYfTZsEhwEcnwY7QfHi3zFk8vVfquVpywDAEQA=",
  "gzipSha256": "28c841a05fbacc25c6ee303bd4528ad406f20a63730ce72fd721770f0f46c40c"
} as const;

export function canonical38RuntimeDatabaseBytes(): Buffer {
  const digest = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
  if (digest(Buffer.from(canonical38RuntimeGeneratorSource)) !== canonical38RuntimeFixture.generatorSha256) throw new Error("HISTORICAL_RECIPE_MISMATCH");
  const packed = Buffer.from(compressed.base64, "base64");
  if (digest(packed) !== compressed.gzipSha256) throw new Error("HISTORICAL_GZIP_MISMATCH");
  const bytes = gunzipSync(packed, { maxOutputLength: 8 * 1024 * 1024 });
  if (bytes.length !== canonical38RuntimeFixture.databaseBytes || digest(bytes) !== canonical38RuntimeFixture.databaseSha256) throw new Error("HISTORICAL_IMAGE_MISMATCH");
  return bytes;
}
