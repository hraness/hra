import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";

// Captured exclusively through the exact canonical41 archived public APIs.
// Explicit UTC and all-table RW/RO preservation do not prove native provider
// behavior, a later-schema migration, or release acceptance.
// Regeneration: extract sourceRevision's src, package.json and bun.lock into a
// private scratch directory with the pinned dependencies, save GeneratorSource
// beside src, and execute it with a fresh run name. Original random API IDs mean
// a new capture has different bytes; these hashes identify this capture only.
export const canonical41TimestampsFixture = {
  "sourceRevision": "576ccd76a6742cd62759ab6176a6a41844846daa",
  "sourceTree": "a410268ccca4f5f6096a97b63d06652153d196be",
  "schemaVersion": 41,
  "provenance": {
    "archiveCommand": "git archive 576ccd76a6742cd62759ab6176a6a41844846daa src package.json bun.lock",
    "sourceHashes": {
      "src/storage/state-store.ts": "7aedcd4d6b4ad2e42ac3583af29d80fa280bf4f1546516df4da490ef54577d14",
      "package.json": "1ddf6d63c7f02778eeea54f273863dfcece8ae4c2fbbee291f76f2084e9d28b3",
      "bun.lock": "cf06ffbd2a9439846d94b85e06a992d73a4931570d336a7e23409f5427d2a032"
    },
    "archivedSourceManifestSha256": "daf90e9b10e7f93e40d6f390f5f4eb0b42a7cd5d08832daa58e0eb74ff3dc2d4",
    "generatorSha256": "6fb00eeb88e06436d6c35a77863585021a1c4e9badf3353c0b817c79a2e25456",
    "bunVersion": "1.3.14",
    "dependency": {
      "name": "zod",
      "version": "4.4.3"
    },
    "timeZone": "UTC",
    "unusedUsageRevisionReservationPerProfile": 1,
    "quotaObservations": 0,
    "syntheticOnly": true,
    "providerProcessesInvoked": false,
    "rawSqlWrites": false,
    "deterministicDatabaseBytes": false,
    "randomnessNotice": "Real archived public APIs generate random IDs. Hashes identify this captured output; rerunning reproduces the cohort/scenario, not identical database bytes.",
    "compatibilityNotice": "Generated and reopened only through exact canonical41. No current49, future integration, or release compatibility claim."
  },
  "databaseBytes": 1409024,
  "databaseSha256": "ad4842496d9ee5f8d51210ef9a99e255d76e6c42505cc3f6e996c919b2caa106",
  "generatorSha256": "6fb00eeb88e06436d6c35a77863585021a1c4e9badf3353c0b817c79a2e25456",
  "syntheticControlPlaneOnly": true,
  "nativeProviderAcceptance": false,
  "currentSchemaCompatibilityProved": false,
  "randomizedIdentifiers": true,
  "rawTimestamp": 1700000000,
  "profiles": [
    {
      "id": "acct_9e8ca0a3b6ec476b8788709e87be63cb",
      "label": "Canonical41 timestamp fixture",
      "state": "signed_in",
      "processGeneration": 1,
      "providerEmail": "canonical41-timestamps@example.com",
      "providerPlan": "Plus",
      "createdAt": 1800000000046,
      "updatedAt": 1800000000048
    },
    {
      "id": "acct_ed072537a75143fe8ddc89494be7eb0e",
      "label": "Canonical41 independent fixture",
      "state": "signed_in",
      "processGeneration": 1,
      "providerEmail": "canonical41-independent@example.com",
      "providerPlan": "Plus",
      "createdAt": 1800000000049,
      "updatedAt": 1800000000051
    }
  ],
  "queueSession": {
    "id": "sess_3499d68d3d994efe92ebd0fa65d8204c",
    "profileId": "acct_9e8ca0a3b6ec476b8788709e87be63cb",
    "providerThreadId": "canonical41-queue",
    "title": "Synthetic queue",
    "note": "",
    "provider": "codex",
    "preset": "high",
    "fastEnabled": false,
    "state": "idle",
    "providerUpdatedAt": 1700000000,
    "revision": 1,
    "createdAt": 1800000000052,
    "updatedAt": 1800000000052
  },
  "queue": {
    "input": {
      "sessionId": "sess_3499d68d3d994efe92ebd0fa65d8204c",
      "profileGeneration": 1,
      "message": "Synthetic canonical41 first queued input",
      "idempotencyKey": "00000000-0000-4000-8000-000000004101"
    },
    "first": {
      "id": "queue_ab5e401172b34100a3ed744f6a244481",
      "sessionId": "sess_3499d68d3d994efe92ebd0fa65d8204c",
      "message": "Synthetic canonical41 first queued input",
      "state": "pending",
      "createdAt": 1800000000054,
      "updatedAt": 1800000000054
    },
    "second": {
      "id": "queue_030abe887f384d3989ac3b84eac9c029",
      "sessionId": "sess_3499d68d3d994efe92ebd0fa65d8204c",
      "message": "Synthetic canonical41 second queued input",
      "state": "pending",
      "createdAt": 1800000000057,
      "updatedAt": 1800000000057
    }
  },
  "scenarios": {
    "stop-marked_unresolved": {
      "idempotencyKey": "00000000-0000-4000-8000-000000004102",
      "attemptId": "attempt_048c8de45fb7484cab8b4b8548992552",
      "sessionId": "sess_a72eda6c9dfb4125b399194de43f25f4",
      "originalSession": {
        "id": "sess_a72eda6c9dfb4125b399194de43f25f4",
        "profileId": "acct_9e8ca0a3b6ec476b8788709e87be63cb",
        "providerThreadId": "canonical41-stop-marked_unresolved",
        "title": "Synthetic stop-marked_unresolved",
        "note": "",
        "provider": "codex",
        "preset": "high",
        "fastEnabled": false,
        "state": "active",
        "activeTurnId": "turn-stop-marked_unresolved",
        "providerUpdatedAt": 1700000000,
        "revision": 1,
        "createdAt": 1800000000058,
        "updatedAt": 1800000000058
      },
      "originalEffect": {
        "attemptId": "attempt_048c8de45fb7484cab8b4b8548992552",
        "digest": "5b435f96618c5048b8fab9ac0cb3fc37be19d650e210e8db417397ba53441c8f",
        "evidence": {
          "kind": "session.stop",
          "providerThreadId": "canonical41-stop-marked_unresolved",
          "providerTimestampUnit": "unix_milliseconds_v1",
          "baseline": {
            "providerUpdatedAt": 1700000000,
            "status": "active",
            "activeTurnId": "turn-stop-marked_unresolved"
          },
          "activeTurnId": "turn-stop-marked_unresolved"
        },
        "recordedAt": 1800000000060
      },
      "finalMutation": {
        "id": "attempt_048c8de45fb7484cab8b4b8548992552",
        "idempotencyKey": "00000000-0000-4000-8000-000000004102",
        "kind": "session.stop",
        "authorityId": "sess_a72eda6c9dfb4125b399194de43f25f4",
        "authorityGeneration": 1,
        "requestDigest": "13101ff4ae9bbe444acfad1343c4cbb2afe39288806f78053962752fe99d52cf",
        "state": "ambiguous",
        "result": {
          "code": "SYNTHETIC_LOST_RESPONSE"
        },
        "evidence": {
          "attemptId": "attempt_048c8de45fb7484cab8b4b8548992552",
          "digest": "5b435f96618c5048b8fab9ac0cb3fc37be19d650e210e8db417397ba53441c8f",
          "evidence": {
            "kind": "session.stop",
            "providerThreadId": "canonical41-stop-marked_unresolved",
            "providerTimestampUnit": "unix_milliseconds_v1",
            "baseline": {
              "providerUpdatedAt": 1700000000,
              "status": "active",
              "activeTurnId": "turn-stop-marked_unresolved"
            },
            "activeTurnId": "turn-stop-marked_unresolved"
          },
          "recordedAt": 1800000000060
        }
      },
      "finalSession": {
        "id": "sess_a72eda6c9dfb4125b399194de43f25f4",
        "profileId": "acct_9e8ca0a3b6ec476b8788709e87be63cb",
        "providerThreadId": "canonical41-stop-marked_unresolved",
        "title": "Synthetic stop-marked_unresolved",
        "note": "",
        "provider": "codex",
        "preset": "high",
        "fastEnabled": false,
        "state": "recovery_required",
        "providerUpdatedAt": 1700000000,
        "revision": 2,
        "createdAt": 1800000000058,
        "updatedAt": 1800000000062
      }
    },
    "stop-legacy_unmarked": {
      "idempotencyKey": "00000000-0000-4000-8000-000000004103",
      "attemptId": "attempt_3fe3297f80f44c30833f1f7f06ad2a83",
      "sessionId": "sess_575e406ce4254bdaaa905d2f2704b5f3",
      "originalSession": {
        "id": "sess_575e406ce4254bdaaa905d2f2704b5f3",
        "profileId": "acct_9e8ca0a3b6ec476b8788709e87be63cb",
        "providerThreadId": "canonical41-stop-legacy_unmarked",
        "title": "Synthetic stop-legacy_unmarked",
        "note": "",
        "provider": "codex",
        "preset": "high",
        "fastEnabled": false,
        "state": "active",
        "activeTurnId": "turn-stop-legacy_unmarked",
        "providerUpdatedAt": 1700000000,
        "revision": 1,
        "createdAt": 1800000000063,
        "updatedAt": 1800000000063
      },
      "originalEffect": {
        "attemptId": "attempt_3fe3297f80f44c30833f1f7f06ad2a83",
        "digest": "edde74e1f333b21b684ebbd1199bd7dfdfe7b05ea44eff59c18121ebce2d57a5",
        "evidence": {
          "kind": "session.stop",
          "providerThreadId": "canonical41-stop-legacy_unmarked",
          "baseline": {
            "providerUpdatedAt": 1700000000,
            "status": "active",
            "activeTurnId": "turn-stop-legacy_unmarked"
          },
          "activeTurnId": "turn-stop-legacy_unmarked"
        },
        "recordedAt": 1800000000065
      },
      "finalMutation": {
        "id": "attempt_3fe3297f80f44c30833f1f7f06ad2a83",
        "idempotencyKey": "00000000-0000-4000-8000-000000004103",
        "kind": "session.stop",
        "authorityId": "sess_575e406ce4254bdaaa905d2f2704b5f3",
        "authorityGeneration": 1,
        "requestDigest": "3de11b231e8c2170074cb084858edc4860a03b00779f54eff501ccacdebd7b2c",
        "state": "ambiguous",
        "result": {
          "code": "SYNTHETIC_LOST_RESPONSE"
        },
        "evidence": {
          "attemptId": "attempt_3fe3297f80f44c30833f1f7f06ad2a83",
          "digest": "edde74e1f333b21b684ebbd1199bd7dfdfe7b05ea44eff59c18121ebce2d57a5",
          "evidence": {
            "kind": "session.stop",
            "providerThreadId": "canonical41-stop-legacy_unmarked",
            "baseline": {
              "providerUpdatedAt": 1700000000,
              "status": "active",
              "activeTurnId": "turn-stop-legacy_unmarked"
            },
            "activeTurnId": "turn-stop-legacy_unmarked"
          },
          "recordedAt": 1800000000065
        }
      },
      "finalSession": {
        "id": "sess_575e406ce4254bdaaa905d2f2704b5f3",
        "profileId": "acct_9e8ca0a3b6ec476b8788709e87be63cb",
        "providerThreadId": "canonical41-stop-legacy_unmarked",
        "title": "Synthetic stop-legacy_unmarked",
        "note": "",
        "provider": "codex",
        "preset": "high",
        "fastEnabled": false,
        "state": "recovery_required",
        "providerUpdatedAt": 1700000000,
        "revision": 2,
        "createdAt": 1800000000063,
        "updatedAt": 1800000000067
      }
    },
    "stop-marked_resolved": {
      "idempotencyKey": "00000000-0000-4000-8000-000000004104",
      "attemptId": "attempt_b90255118bb34b718164dfb95009870f",
      "sessionId": "sess_e40fb8c7948a491991d3ab3412f123b4",
      "originalSession": {
        "id": "sess_e40fb8c7948a491991d3ab3412f123b4",
        "profileId": "acct_ed072537a75143fe8ddc89494be7eb0e",
        "providerThreadId": "canonical41-stop-marked_resolved",
        "title": "Synthetic stop-marked_resolved",
        "note": "",
        "provider": "codex",
        "preset": "high",
        "fastEnabled": false,
        "state": "active",
        "activeTurnId": "turn-stop-marked_resolved",
        "providerUpdatedAt": 1700000000,
        "revision": 1,
        "createdAt": 1800000000069,
        "updatedAt": 1800000000069
      },
      "originalEffect": {
        "attemptId": "attempt_b90255118bb34b718164dfb95009870f",
        "digest": "e48be707a2cbf487b3659cd9dda84d570d8e1638352249a9ccf324afe5b78669",
        "evidence": {
          "kind": "session.stop",
          "providerThreadId": "canonical41-stop-marked_resolved",
          "providerTimestampUnit": "unix_milliseconds_v1",
          "baseline": {
            "providerUpdatedAt": 1700000000,
            "status": "active",
            "activeTurnId": "turn-stop-marked_resolved"
          },
          "activeTurnId": "turn-stop-marked_resolved"
        },
        "recordedAt": 1800000000071
      },
      "finalMutation": {
        "id": "attempt_b90255118bb34b718164dfb95009870f",
        "idempotencyKey": "00000000-0000-4000-8000-000000004104",
        "kind": "session.stop",
        "authorityId": "sess_e40fb8c7948a491991d3ab3412f123b4",
        "authorityGeneration": 1,
        "requestDigest": "c686540d716e623c7e47cdc331cf4023a70d110cb4a91e5553ed48c8ac99251c",
        "state": "reconciled",
        "result": {
          "stopped": true,
          "activeTurnId": "turn-stop-marked_resolved"
        },
        "originalState": "ambiguous",
        "resolution": {
          "kind": "proven_applied",
          "evidence": {
            "providerThreadId": "canonical41-stop-marked_resolved",
            "providerTimestampUnit": "unix_milliseconds_v1",
            "providerUpdatedAt": 1700000001,
            "kind": "session.stop",
            "activeTurnId": "turn-stop-marked_resolved",
            "observedStatus": "interrupted"
          },
          "receipt": {
            "stopped": true,
            "activeTurnId": "turn-stop-marked_resolved"
          },
          "createdAt": 1800000000074
        },
        "evidence": {
          "attemptId": "attempt_b90255118bb34b718164dfb95009870f",
          "digest": "e48be707a2cbf487b3659cd9dda84d570d8e1638352249a9ccf324afe5b78669",
          "evidence": {
            "kind": "session.stop",
            "providerThreadId": "canonical41-stop-marked_resolved",
            "providerTimestampUnit": "unix_milliseconds_v1",
            "baseline": {
              "providerUpdatedAt": 1700000000,
              "status": "active",
              "activeTurnId": "turn-stop-marked_resolved"
            },
            "activeTurnId": "turn-stop-marked_resolved"
          },
          "recordedAt": 1800000000071
        }
      },
      "finalSession": {
        "id": "sess_e40fb8c7948a491991d3ab3412f123b4",
        "profileId": "acct_ed072537a75143fe8ddc89494be7eb0e",
        "providerThreadId": "canonical41-stop-marked_resolved",
        "title": "Resolved stop-marked_resolved",
        "note": "",
        "provider": "codex",
        "preset": "high",
        "fastEnabled": false,
        "state": "idle",
        "providerUpdatedAt": 1700000001,
        "revision": 3,
        "createdAt": 1800000000069,
        "updatedAt": 1800000000074
      }
    },
    "rename-marked_unresolved": {
      "idempotencyKey": "00000000-0000-4000-8000-000000004105",
      "attemptId": "attempt_4fa040d98dc043fd8b9dccee1d90fe0b",
      "sessionId": "sess_f3a3a557c7a44e0ba354b70575d248a1",
      "originalSession": {
        "id": "sess_f3a3a557c7a44e0ba354b70575d248a1",
        "profileId": "acct_9e8ca0a3b6ec476b8788709e87be63cb",
        "providerThreadId": "canonical41-rename-marked_unresolved",
        "title": "Synthetic rename-marked_unresolved",
        "note": "",
        "provider": "codex",
        "preset": "high",
        "fastEnabled": false,
        "state": "idle",
        "providerUpdatedAt": 1700000000,
        "revision": 1,
        "createdAt": 1800000000075,
        "updatedAt": 1800000000075
      },
      "originalEffect": {
        "attemptId": "attempt_4fa040d98dc043fd8b9dccee1d90fe0b",
        "digest": "39127b46dd9c47a547e1761fd338af00f8ae8b09257ce100a98c20057cedc37c",
        "evidence": {
          "kind": "session.rename",
          "providerThreadId": "canonical41-rename-marked_unresolved",
          "providerTimestampUnit": "unix_milliseconds_v1",
          "baseline": {
            "providerUpdatedAt": 1700000000,
            "status": "idle",
            "activeTurnId": null
          },
          "requestedName": "Resolved rename-marked_unresolved"
        },
        "recordedAt": 1800000000077
      },
      "finalMutation": {
        "id": "attempt_4fa040d98dc043fd8b9dccee1d90fe0b",
        "idempotencyKey": "00000000-0000-4000-8000-000000004105",
        "kind": "session.rename",
        "authorityId": "sess_f3a3a557c7a44e0ba354b70575d248a1",
        "authorityGeneration": 1,
        "requestDigest": "59998673ac016f734d8f3c114c27b29c14ff8e66d18039b3889a657b7d611619",
        "state": "ambiguous",
        "result": {
          "code": "SYNTHETIC_LOST_RESPONSE"
        },
        "evidence": {
          "attemptId": "attempt_4fa040d98dc043fd8b9dccee1d90fe0b",
          "digest": "39127b46dd9c47a547e1761fd338af00f8ae8b09257ce100a98c20057cedc37c",
          "evidence": {
            "kind": "session.rename",
            "providerThreadId": "canonical41-rename-marked_unresolved",
            "providerTimestampUnit": "unix_milliseconds_v1",
            "baseline": {
              "providerUpdatedAt": 1700000000,
              "status": "idle",
              "activeTurnId": null
            },
            "requestedName": "Resolved rename-marked_unresolved"
          },
          "recordedAt": 1800000000077
        }
      },
      "finalSession": {
        "id": "sess_f3a3a557c7a44e0ba354b70575d248a1",
        "profileId": "acct_9e8ca0a3b6ec476b8788709e87be63cb",
        "providerThreadId": "canonical41-rename-marked_unresolved",
        "title": "Synthetic rename-marked_unresolved",
        "note": "",
        "provider": "codex",
        "preset": "high",
        "fastEnabled": false,
        "state": "recovery_required",
        "providerUpdatedAt": 1700000000,
        "revision": 2,
        "createdAt": 1800000000075,
        "updatedAt": 1800000000079
      }
    },
    "rename-legacy_unmarked": {
      "idempotencyKey": "00000000-0000-4000-8000-000000004106",
      "attemptId": "attempt_a91a5c4d26084f3dab9445ed869d0f46",
      "sessionId": "sess_122156ddabe049a09f24c6e447260308",
      "originalSession": {
        "id": "sess_122156ddabe049a09f24c6e447260308",
        "profileId": "acct_9e8ca0a3b6ec476b8788709e87be63cb",
        "providerThreadId": "canonical41-rename-legacy_unmarked",
        "title": "Synthetic rename-legacy_unmarked",
        "note": "",
        "provider": "codex",
        "preset": "high",
        "fastEnabled": false,
        "state": "idle",
        "providerUpdatedAt": 1700000000,
        "revision": 1,
        "createdAt": 1800000000080,
        "updatedAt": 1800000000080
      },
      "originalEffect": {
        "attemptId": "attempt_a91a5c4d26084f3dab9445ed869d0f46",
        "digest": "f623db4516c112ca25ae3671d1d2844df518978af08c913753b08afc814b5c45",
        "evidence": {
          "kind": "session.rename",
          "providerThreadId": "canonical41-rename-legacy_unmarked",
          "baseline": {
            "providerUpdatedAt": 1700000000,
            "status": "idle",
            "activeTurnId": null
          },
          "requestedName": "Resolved rename-legacy_unmarked"
        },
        "recordedAt": 1800000000082
      },
      "finalMutation": {
        "id": "attempt_a91a5c4d26084f3dab9445ed869d0f46",
        "idempotencyKey": "00000000-0000-4000-8000-000000004106",
        "kind": "session.rename",
        "authorityId": "sess_122156ddabe049a09f24c6e447260308",
        "authorityGeneration": 1,
        "requestDigest": "40ba4624671bf11ba0a6f2d647321bc004c9ee0c30aa4f015aadb8e1944d2159",
        "state": "ambiguous",
        "result": {
          "code": "SYNTHETIC_LOST_RESPONSE"
        },
        "evidence": {
          "attemptId": "attempt_a91a5c4d26084f3dab9445ed869d0f46",
          "digest": "f623db4516c112ca25ae3671d1d2844df518978af08c913753b08afc814b5c45",
          "evidence": {
            "kind": "session.rename",
            "providerThreadId": "canonical41-rename-legacy_unmarked",
            "baseline": {
              "providerUpdatedAt": 1700000000,
              "status": "idle",
              "activeTurnId": null
            },
            "requestedName": "Resolved rename-legacy_unmarked"
          },
          "recordedAt": 1800000000082
        }
      },
      "finalSession": {
        "id": "sess_122156ddabe049a09f24c6e447260308",
        "profileId": "acct_9e8ca0a3b6ec476b8788709e87be63cb",
        "providerThreadId": "canonical41-rename-legacy_unmarked",
        "title": "Synthetic rename-legacy_unmarked",
        "note": "",
        "provider": "codex",
        "preset": "high",
        "fastEnabled": false,
        "state": "recovery_required",
        "providerUpdatedAt": 1700000000,
        "revision": 2,
        "createdAt": 1800000000080,
        "updatedAt": 1800000000084
      }
    },
    "rename-marked_resolved": {
      "idempotencyKey": "00000000-0000-4000-8000-000000004107",
      "attemptId": "attempt_19de9242882e4dfc83c6b4fd803df170",
      "sessionId": "sess_cf3c1a0c930942f185ea048e36f2019f",
      "originalSession": {
        "id": "sess_cf3c1a0c930942f185ea048e36f2019f",
        "profileId": "acct_ed072537a75143fe8ddc89494be7eb0e",
        "providerThreadId": "canonical41-rename-marked_resolved",
        "title": "Synthetic rename-marked_resolved",
        "note": "",
        "provider": "codex",
        "preset": "high",
        "fastEnabled": false,
        "state": "idle",
        "providerUpdatedAt": 1700000000,
        "revision": 1,
        "createdAt": 1800000000086,
        "updatedAt": 1800000000086
      },
      "originalEffect": {
        "attemptId": "attempt_19de9242882e4dfc83c6b4fd803df170",
        "digest": "ee7573a0971cf98c2412e3486e1f12b19a2369974275faefb335fa43abf115b7",
        "evidence": {
          "kind": "session.rename",
          "providerThreadId": "canonical41-rename-marked_resolved",
          "providerTimestampUnit": "unix_milliseconds_v1",
          "baseline": {
            "providerUpdatedAt": 1700000000,
            "status": "idle",
            "activeTurnId": null
          },
          "requestedName": "Resolved rename-marked_resolved"
        },
        "recordedAt": 1800000000088
      },
      "finalMutation": {
        "id": "attempt_19de9242882e4dfc83c6b4fd803df170",
        "idempotencyKey": "00000000-0000-4000-8000-000000004107",
        "kind": "session.rename",
        "authorityId": "sess_cf3c1a0c930942f185ea048e36f2019f",
        "authorityGeneration": 1,
        "requestDigest": "e1fe1da24422d8a51cbd3a6c639e912c652165e8f6c3b155d2b33abdd58b17f7",
        "state": "reconciled",
        "result": {
          "renamed": true
        },
        "originalState": "ambiguous",
        "resolution": {
          "kind": "proven_applied",
          "evidence": {
            "providerThreadId": "canonical41-rename-marked_resolved",
            "providerTimestampUnit": "unix_milliseconds_v1",
            "providerUpdatedAt": 1700000001,
            "kind": "session.rename",
            "requestedName": "Resolved rename-marked_resolved"
          },
          "receipt": {
            "renamed": true
          },
          "createdAt": 1800000000091
        },
        "evidence": {
          "attemptId": "attempt_19de9242882e4dfc83c6b4fd803df170",
          "digest": "ee7573a0971cf98c2412e3486e1f12b19a2369974275faefb335fa43abf115b7",
          "evidence": {
            "kind": "session.rename",
            "providerThreadId": "canonical41-rename-marked_resolved",
            "providerTimestampUnit": "unix_milliseconds_v1",
            "baseline": {
              "providerUpdatedAt": 1700000000,
              "status": "idle",
              "activeTurnId": null
            },
            "requestedName": "Resolved rename-marked_resolved"
          },
          "recordedAt": 1800000000088
        }
      },
      "finalSession": {
        "id": "sess_cf3c1a0c930942f185ea048e36f2019f",
        "profileId": "acct_ed072537a75143fe8ddc89494be7eb0e",
        "providerThreadId": "canonical41-rename-marked_resolved",
        "title": "Resolved rename-marked_resolved",
        "note": "",
        "provider": "codex",
        "preset": "high",
        "fastEnabled": false,
        "state": "idle",
        "providerUpdatedAt": 1700000001,
        "revision": 3,
        "createdAt": 1800000000086,
        "updatedAt": 1800000000091
      }
    }
  },
  "rejectedLegacyProofs": {
    "stop-legacy_unmarked": "MUTATION_RECOVERY_TIMESTAMP_PROOF_INVALID",
    "rename-legacy_unmarked": "MUTATION_RECOVERY_TIMESTAMP_PROOF_INVALID"
  },
  "migrations": [
    {
      "version": 1,
      "applied_at": 1800000000000
    },
    {
      "version": 10,
      "applied_at": 1800000000009
    },
    {
      "version": 11,
      "applied_at": 1800000000010
    },
    {
      "version": 12,
      "applied_at": 1800000000011
    },
    {
      "version": 13,
      "applied_at": 1800000000012
    },
    {
      "version": 14,
      "applied_at": 1800000000013
    },
    {
      "version": 15,
      "applied_at": 1800000000014
    },
    {
      "version": 16,
      "applied_at": 1800000000015
    },
    {
      "version": 17,
      "applied_at": 1800000000018
    },
    {
      "version": 18,
      "applied_at": 1800000000019
    },
    {
      "version": 19,
      "applied_at": 1800000000020
    },
    {
      "version": 2,
      "applied_at": 1800000000001
    },
    {
      "version": 20,
      "applied_at": 1800000000021
    },
    {
      "version": 21,
      "applied_at": 1800000000022
    },
    {
      "version": 22,
      "applied_at": 1800000000023
    },
    {
      "version": 23,
      "applied_at": 1800000000024
    },
    {
      "version": 24,
      "applied_at": 1800000000025
    },
    {
      "version": 25,
      "applied_at": 1800000000026
    },
    {
      "version": 26,
      "applied_at": 1800000000027
    },
    {
      "version": 27,
      "applied_at": 1800000000028
    },
    {
      "version": 28,
      "applied_at": 1800000000029
    },
    {
      "version": 29,
      "applied_at": 1800000000030
    },
    {
      "version": 3,
      "applied_at": 1800000000002
    },
    {
      "version": 30,
      "applied_at": 1800000000031
    },
    {
      "version": 31,
      "applied_at": 1800000000032
    },
    {
      "version": 32,
      "applied_at": 1800000000033
    },
    {
      "version": 33,
      "applied_at": 1800000000034
    },
    {
      "version": 34,
      "applied_at": 1800000000035
    },
    {
      "version": 35,
      "applied_at": 1800000000036
    },
    {
      "version": 36,
      "applied_at": 1800000000037
    },
    {
      "version": 37,
      "applied_at": 1800000000038
    },
    {
      "version": 38,
      "applied_at": 1800000000039
    },
    {
      "version": 39,
      "applied_at": 1800000000040
    },
    {
      "version": 4,
      "applied_at": 1800000000003
    },
    {
      "version": 40,
      "applied_at": 1800000000041
    },
    {
      "version": 41,
      "applied_at": 1800000000042
    },
    {
      "version": 5,
      "applied_at": 1800000000004
    },
    {
      "version": 6,
      "applied_at": 1800000000005
    },
    {
      "version": 7,
      "applied_at": 1800000000006
    },
    {
      "version": 8,
      "applied_at": 1800000000007
    },
    {
      "version": 9,
      "applied_at": 1800000000008
    }
  ],
  "timestampGuard": {
    "type": "trigger",
    "name": "mutation_resolutions_timestamp_proof_insert",
    "tbl_name": "mutation_resolutions",
    "sql": "CREATE TRIGGER mutation_resolutions_timestamp_proof_insert\nBEFORE INSERT ON mutation_resolutions\nWHEN (SELECT kind FROM mutation_attempts WHERE id=NEW.attempt_id) IN ('session.stop','session.rename')\nBEGIN\n  SELECT CASE WHEN NEW.resolution_kind<>'proven_applied' AND NEW.receipt_json IS NOT NULL\n    THEN RAISE(ABORT,'MUTATION_RECOVERY_TIMESTAMP_RECEIPT_UNEXPECTED') END;\n  SELECT CASE WHEN NEW.resolution_kind='proven_applied' AND (\n    NOT json_valid(NEW.evidence_json) OR NEW.receipt_json IS NULL OR NOT json_valid(NEW.receipt_json)\n  ) THEN RAISE(ABORT,'MUTATION_RECOVERY_TIMESTAMP_PROOF_INVALID') END;\n  SELECT CASE WHEN NEW.resolution_kind='proven_applied' AND NOT EXISTS (\n    SELECT 1 FROM mutation_attempts m\n    JOIN mutation_effect_evidence e ON e.attempt_id=m.id\n    JOIN sessions s ON s.id=m.authority_id\n    WHERE m.id=NEW.attempt_id AND e.kind=m.kind\n      AND json_extract(e.evidence_json,'$.kind')=m.kind\n      AND json_extract(NEW.evidence_json,'$.kind')=m.kind\n      AND json_extract(e.evidence_json,'$.providerThreadId')=s.provider_thread_id\n      AND json_extract(NEW.evidence_json,'$.providerThreadId')=s.provider_thread_id\n      AND json_extract(e.evidence_json,'$.providerTimestampUnit')='unix_milliseconds_v1'\n      AND json_extract(NEW.evidence_json,'$.providerTimestampUnit')='unix_milliseconds_v1'\n      AND json_type(e.evidence_json,'$.baseline.providerUpdatedAt')='integer'\n      AND json_extract(e.evidence_json,'$.baseline.providerUpdatedAt') BETWEEN 0 AND 9007199254740991\n      AND json_type(NEW.evidence_json,'$.providerUpdatedAt')='integer'\n      AND json_extract(NEW.evidence_json,'$.providerUpdatedAt') BETWEEN 0 AND 9007199254740991\n      AND json_extract(NEW.evidence_json,'$.providerUpdatedAt')>json_extract(e.evidence_json,'$.baseline.providerUpdatedAt')\n      AND s.provider_updated_at=json_extract(NEW.evidence_json,'$.providerUpdatedAt')\n      AND (\n        (m.kind='session.stop'\n          AND s.active_turn_id IS NOT json_extract(e.evidence_json,'$.activeTurnId')\n          AND (SELECT count(*) FROM json_each(NEW.evidence_json))=6\n          AND (SELECT count(*) FROM json_each(NEW.receipt_json))=2\n          AND json_type(e.evidence_json,'$.activeTurnId')='text'\n          AND json_extract(NEW.evidence_json,'$.activeTurnId')=json_extract(e.evidence_json,'$.activeTurnId')\n          AND json_extract(NEW.receipt_json,'$.activeTurnId')=json_extract(e.evidence_json,'$.activeTurnId')\n          AND json_extract(NEW.evidence_json,'$.observedStatus') IN ('absent','completed','interrupted','failed')\n          AND json_type(NEW.receipt_json,'$.stopped')='true')\n        OR (m.kind='session.rename'\n          AND s.title=json_extract(e.evidence_json,'$.requestedName')\n          AND (SELECT count(*) FROM json_each(NEW.evidence_json))=5\n          AND (SELECT count(*) FROM json_each(NEW.receipt_json))=1\n          AND json_extract(NEW.evidence_json,'$.requestedName')=json_extract(e.evidence_json,'$.requestedName')\n          AND json_type(NEW.receipt_json,'$.renamed')='true')\n      )\n  ) THEN RAISE(ABORT,'MUTATION_RECOVERY_TIMESTAMP_PROOF_INVALID') END;\nEND"
  },
  "timestampGuardSha256": "58bf7130250f47f8cae27ba0e58057df1483b0b325e988e0116c2512d40acd8d",
  "notificationHours": [
    {
      "singleton": 1,
      "version": 1,
      "revision": 1,
      "start_minute": 600,
      "end_minute": 1320,
      "time_zone": "UTC",
      "created_at": 1800000000037,
      "updated_at": 1800000000037
    }
  ],
  "attentionEmailPolicy": [
    {
      "singleton": 1,
      "version": 1,
      "enabled": 0,
      "revision": 1,
      "created_at": 1800000000038,
      "updated_at": 1800000000038
    }
  ],
  "effects": [
    {
      "attempt_id": "attempt_048c8de45fb7484cab8b4b8548992552",
      "kind": "session.stop",
      "evidence_json": "{\"kind\":\"session.stop\",\"providerThreadId\":\"canonical41-stop-marked_unresolved\",\"providerTimestampUnit\":\"unix_milliseconds_v1\",\"baseline\":{\"providerUpdatedAt\":1700000000,\"status\":\"active\",\"activeTurnId\":\"turn-stop-marked_unresolved\"},\"activeTurnId\":\"turn-stop-marked_unresolved\"}",
      "evidence_digest": "5b435f96618c5048b8fab9ac0cb3fc37be19d650e210e8db417397ba53441c8f",
      "recorded_at": 1800000000060
    },
    {
      "attempt_id": "attempt_19de9242882e4dfc83c6b4fd803df170",
      "kind": "session.rename",
      "evidence_json": "{\"kind\":\"session.rename\",\"providerThreadId\":\"canonical41-rename-marked_resolved\",\"providerTimestampUnit\":\"unix_milliseconds_v1\",\"baseline\":{\"providerUpdatedAt\":1700000000,\"status\":\"idle\",\"activeTurnId\":null},\"requestedName\":\"Resolved rename-marked_resolved\"}",
      "evidence_digest": "ee7573a0971cf98c2412e3486e1f12b19a2369974275faefb335fa43abf115b7",
      "recorded_at": 1800000000088
    },
    {
      "attempt_id": "attempt_3fe3297f80f44c30833f1f7f06ad2a83",
      "kind": "session.stop",
      "evidence_json": "{\"kind\":\"session.stop\",\"providerThreadId\":\"canonical41-stop-legacy_unmarked\",\"baseline\":{\"providerUpdatedAt\":1700000000,\"status\":\"active\",\"activeTurnId\":\"turn-stop-legacy_unmarked\"},\"activeTurnId\":\"turn-stop-legacy_unmarked\"}",
      "evidence_digest": "edde74e1f333b21b684ebbd1199bd7dfdfe7b05ea44eff59c18121ebce2d57a5",
      "recorded_at": 1800000000065
    },
    {
      "attempt_id": "attempt_4fa040d98dc043fd8b9dccee1d90fe0b",
      "kind": "session.rename",
      "evidence_json": "{\"kind\":\"session.rename\",\"providerThreadId\":\"canonical41-rename-marked_unresolved\",\"providerTimestampUnit\":\"unix_milliseconds_v1\",\"baseline\":{\"providerUpdatedAt\":1700000000,\"status\":\"idle\",\"activeTurnId\":null},\"requestedName\":\"Resolved rename-marked_unresolved\"}",
      "evidence_digest": "39127b46dd9c47a547e1761fd338af00f8ae8b09257ce100a98c20057cedc37c",
      "recorded_at": 1800000000077
    },
    {
      "attempt_id": "attempt_a91a5c4d26084f3dab9445ed869d0f46",
      "kind": "session.rename",
      "evidence_json": "{\"kind\":\"session.rename\",\"providerThreadId\":\"canonical41-rename-legacy_unmarked\",\"baseline\":{\"providerUpdatedAt\":1700000000,\"status\":\"idle\",\"activeTurnId\":null},\"requestedName\":\"Resolved rename-legacy_unmarked\"}",
      "evidence_digest": "f623db4516c112ca25ae3671d1d2844df518978af08c913753b08afc814b5c45",
      "recorded_at": 1800000000082
    },
    {
      "attempt_id": "attempt_b90255118bb34b718164dfb95009870f",
      "kind": "session.stop",
      "evidence_json": "{\"kind\":\"session.stop\",\"providerThreadId\":\"canonical41-stop-marked_resolved\",\"providerTimestampUnit\":\"unix_milliseconds_v1\",\"baseline\":{\"providerUpdatedAt\":1700000000,\"status\":\"active\",\"activeTurnId\":\"turn-stop-marked_resolved\"},\"activeTurnId\":\"turn-stop-marked_resolved\"}",
      "evidence_digest": "e48be707a2cbf487b3659cd9dda84d570d8e1638352249a9ccf324afe5b78669",
      "recorded_at": 1800000000071
    }
  ],
  "resolutions": [
    {
      "attempt_id": "attempt_19de9242882e4dfc83c6b4fd803df170",
      "resolution_kind": "proven_applied",
      "evidence_json": "{\"providerThreadId\":\"canonical41-rename-marked_resolved\",\"providerTimestampUnit\":\"unix_milliseconds_v1\",\"providerUpdatedAt\":1700000001,\"kind\":\"session.rename\",\"requestedName\":\"Resolved rename-marked_resolved\"}",
      "receipt_json": "{\"renamed\":true}",
      "created_at": 1800000000091
    },
    {
      "attempt_id": "attempt_b90255118bb34b718164dfb95009870f",
      "resolution_kind": "proven_applied",
      "evidence_json": "{\"providerThreadId\":\"canonical41-stop-marked_resolved\",\"providerTimestampUnit\":\"unix_milliseconds_v1\",\"providerUpdatedAt\":1700000001,\"kind\":\"session.stop\",\"activeTurnId\":\"turn-stop-marked_resolved\",\"observedStatus\":\"interrupted\"}",
      "receipt_json": "{\"stopped\":true,\"activeTurnId\":\"turn-stop-marked_resolved\"}",
      "created_at": 1800000000074
    }
  ]
} as const;
export const canonical41TimestampsGeneratorSource = "import assert from \"node:assert/strict\";\nimport { createHash } from \"node:crypto\";\nimport { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, writeFileSync } from \"node:fs\";\nimport { mkdir } from \"node:fs/promises\";\nimport { join, relative } from \"node:path\";\nimport { gzipSync } from \"node:zlib\";\nimport { Database } from \"bun:sqlite\";\n\n// Imports are exclusively from the exact git-archived canonical41 source.\nimport type { MutationEffectEvidence } from \"./src/storage/state-store\";\n\nconst sourceCommit = \"576ccd76a6742cd62759ab6176a6a41844846daa\";\nconst sourceTree = \"a410268ccca4f5f6096a97b63d06652153d196be\";\nconst expectedSourceHashes = {\n  \"src/storage/state-store.ts\": \"7aedcd4d6b4ad2e42ac3583af29d80fa280bf4f1546516df4da490ef54577d14\",\n  \"package.json\": \"1ddf6d63c7f02778eeea54f273863dfcece8ae4c2fbbee291f76f2084e9d28b3\",\n  \"bun.lock\": \"cf06ffbd2a9439846d94b85e06a992d73a4931570d336a7e23409f5427d2a032\",\n} as const;\nconst hash = (bytes: Uint8Array | string) => createHash(\"sha256\").update(bytes).digest(\"hex\");\nconst scratch = import.meta.dir;\nconst runName = process.argv[2] ?? \"run_public1\";\nassert.match(runName, /^run_[a-z0-9]+$/);\nassert.equal(lstatSync(scratch).mode & 0o777, 0o700);\nassert.equal(Bun.version, \"1.3.14\");\nfor (const [path, expected] of Object.entries(expectedSourceHashes)) {\n  assert.equal(hash(readFileSync(join(scratch, path))), expected, `Archived bytes: ${path}`);\n}\nconst installedZodPath = realpathSync(join(scratch, \"node_modules/zod/package.json\"));\nconst zodPackage = JSON.parse(readFileSync(installedZodPath, \"utf8\"));\nconst archivedPackage = JSON.parse(readFileSync(join(scratch, \"package.json\"), \"utf8\"));\nassert.equal(zodPackage.version, \"4.4.3\");\nassert.equal(zodPackage.version, archivedPackage.dependencies.zod);\nconst sourceFiles: { path: string; sha256: string }[] = [];\nfunction visit(directory: string) {\n  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {\n    const path = join(directory, entry.name);\n    if (entry.isDirectory()) visit(path);\n    else if (entry.isFile()) sourceFiles.push({ path: relative(scratch, path), sha256: hash(readFileSync(path)) });\n    else throw new Error(\"Archived source unexpectedly contains a non-file entry.\");\n  }\n}\nvisit(join(scratch, \"src\"));\nassert.equal(hash(JSON.stringify(sourceFiles)), \"daf90e9b10e7f93e40d6f390f5f4eb0b42a7cd5d08832daa58e0eb74ff3dc2d4\",\n  \"The full archived source manifest must match the preserved canonical41 capture.\");\n// Load runtime code only after archive and dependency identity checks.\nconst { initializeStatePaths, resolveStatePaths } = await import(\"./src/storage/paths\");\nconst { StateStore } = await import(\"./src/storage/state-store\");\n\nconst outputDirectory = join(scratch, runName);\nassert.equal(existsSync(outputDirectory), false, \"Never overwrite a captured run.\");\nawait mkdir(outputDirectory, { mode: 0o700 });\nconst paths = resolveStatePaths({ rootDirectory: join(outputDirectory, \"state\") });\nawait initializeStatePaths(paths);\nlet recordedNow = 1_800_000_000_000;\nconst store = new StateStore(paths, { now: () => recordedNow++, resolveMachineTimeZone: () => \"UTC\" });\n\nconst snapshot = () => {\n  const database = new Database(paths.database, { readonly: true, strict: true });\n  try {\n    const schema = database.query(\"SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name\").all();\n    const tables = database.query(\"SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name\").all() as { name: string }[];\n    assert.ok(tables.length <= 512);\n    const rows: Record<string, unknown[]> = {};\n    for (const { name } of tables) {\n      assert.match(name, /^[a-zA-Z0-9_]+$/);\n      const statement = database.prepare(`SELECT * FROM \"${name}\"`);\n      try {\n        rows[name] = statement.all().sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));\n        assert.ok(rows[name].length <= 4096);\n      } finally { statement.finalize(); }\n    }\n    const value = { userVersion: database.query(\"PRAGMA user_version\").get(), schema, rows,\n      foreignKeyCheck: database.query(\"PRAGMA foreign_key_check\").all(),\n      inspectionChanges: database.query(\"SELECT total_changes() AS count\").get() };\n    assert.deepEqual(value.foreignKeyCheck, []);\n    assert.deepEqual(value.inspectionChanges, { count: 0 });\n    assert.ok(Buffer.byteLength(JSON.stringify(value)) <= 16 * 1_024 * 1_024);\n    return value;\n  } finally { database.close(false); }\n};\n\nconst initial = snapshot();\nassert.equal((initial.rows.notification_hours[0] as { time_zone: string }).time_zone, \"UTC\");\nassert.deepEqual(initial.userVersion, { user_version: 41 });\nconst originalMigrations = initial.rows.migrations;\nassert.equal(originalMigrations?.length, 41);\nassert.deepEqual(originalMigrations.map((row) => (row as { version: number }).version).sort((left, right) => left - right),\n  Array.from({ length: 41 }, (_, index) => index + 1));\n\nfunction signIn(label: string, email: string) {\n  const profile = store.nextProfileGeneration(store.createProfile(label).id);\n  assert.equal(store.setProfileState(profile.id, profile.processGeneration, \"signed_in\", {\n    email, plan: \"Plus\",\n  }), true);\n  // An unused sequence reservation initializes maintenance state, not quota.\n  assert.equal(store.allocateNextUsageRevision(profile.id), 1);\n  return store.requireProfile(profile.id);\n}\nconst mainProfile = signIn(\"Canonical41 timestamp fixture\", \"canonical41-timestamps@example.com\");\nconst otherProfile = signIn(\"Canonical41 independent fixture\", \"canonical41-independent@example.com\");\nconst accountKey = (email: string) => `v1:codex:${hash(email.trim().toLowerCase())}`;\nconst rawTimestamp = 1_700_000_000;\nfunction sessionFor(name: string, active = false, profile = mainProfile) {\n  assert.ok(profile.providerEmail);\n  return store.upsertProviderSession({\n    profileId: profile.id, provider: \"codex\", providerThreadId: `canonical41-${name}`,\n    providerAccountKey: accountKey(profile.providerEmail), title: `Synthetic ${name}`,\n    preset: \"high\", fastEnabled: false, state: active ? \"active\" : \"idle\",\n    ...(active ? { activeTurnId: `turn-${name}` } : {}), providerUpdatedAt: rawTimestamp,\n  });\n}\nconst queueSession = sessionFor(\"queue\");\nconst queueKey = \"00000000-0000-4000-8000-000000004101\";\nconst queueInput = { sessionId: queueSession.id, profileGeneration: mainProfile.processGeneration,\n  message: \"Synthetic canonical41 first queued input\", idempotencyKey: queueKey };\nconst firstQueued = store.enqueueIdempotent(queueInput);\nassert.deepEqual(store.enqueueIdempotent(queueInput), firstQueued);\nconst secondQueued = store.enqueue(queueSession.id, \"Synthetic canonical41 second queued input\");\nassert.deepEqual(store.listQueue(queueSession.id), [firstQueued, secondQueued]);\n\nconst scenarios: Record<string, unknown> = {};\nconst rejectedLegacyProofs: Record<string, string> = {};\nlet operationNumber = 0;\nfor (const kind of [\"session.stop\", \"session.rename\"] as const) {\n  for (const mode of [\"marked_unresolved\", \"legacy_unmarked\", \"marked_resolved\"] as const) {\n    operationNumber++;\n    const name = `${kind.slice(8)}-${mode}`;\n    const session = sessionFor(name, kind === \"session.stop\", mode === \"marked_resolved\" ? otherProfile : mainProfile);\n    const profile = store.requireProfile(session.profileId);\n    const thread = session.providerThreadId;\n    assert.ok(thread);\n    const activeTurnId = kind === \"session.stop\" ? `turn-${name}` : null;\n    const requestedName = `Resolved ${name}`;\n    const key = `00000000-0000-4000-8000-${String(4101 + operationNumber).padStart(12, \"0\")}`;\n    const attempt = store.prepareMutation({ kind, authorityId: session.id,\n      authorityGeneration: profile.processGeneration,\n      request: kind === \"session.stop\" ? { activeTurnId } : { name: requestedName }, idempotencyKey: key });\n    const effectInput: MutationEffectEvidence = {\n      providerThreadId: thread,\n      ...(mode === \"legacy_unmarked\" ? {} : { providerTimestampUnit: \"unix_milliseconds_v1\" }),\n      baseline: { providerUpdatedAt: rawTimestamp, status: kind === \"session.stop\" ? \"active\" : \"idle\", activeTurnId },\n      ...(kind === \"session.stop\" ? { kind, activeTurnId } : { kind, requestedName }),\n    };\n    const evidence = store.beginSessionMutationEffect({ attemptId: attempt.id, sessionId: session.id,\n      profileGeneration: profile.processGeneration, evidence: effectInput });\n    assert.equal(store.transitionMutation(attempt.id, \"effect_started\", \"ambiguous\", { code: \"SYNTHETIC_LOST_RESPONSE\" }), true);\n    store.quarantineSession(session.id);\n    const proof = { providerThreadId: thread, providerTimestampUnit: \"unix_milliseconds_v1\" as const,\n      providerUpdatedAt: rawTimestamp + 1,\n      ...(kind === \"session.stop\" ? { kind, activeTurnId, observedStatus: \"interrupted\" as const } : { kind, requestedName }) };\n    const receipt = kind === \"session.stop\" ? { stopped: true, activeTurnId } : { renamed: true };\n    const resolution = { attemptId: attempt.id, expectedOriginalState: \"ambiguous\" as const,\n      expectedEvidenceDigest: evidence.digest, resolution: \"proven_applied\" as const,\n      resolutionEvidence: proof, receipt,\n      provider: { providerThreadId: thread, title: requestedName, status: \"idle\" as const, providerUpdatedAt: rawTimestamp + 1 } };\n    if (mode === \"marked_resolved\") {\n      assert.equal(store.resolveSessionMutation(resolution).state, \"idle\");\n      assert.deepEqual(store.readMutation(key)?.result, receipt);\n      assert.equal(store.readMutation(key)?.resolution?.kind, \"proven_applied\");\n    } else if (mode === \"legacy_unmarked\") {\n      const before = snapshot();\n      assert.throws(() => store.resolveSessionMutation(resolution), (error: unknown) => {\n        assert.ok(error instanceof Error);\n        assert.equal(error.message, \"MUTATION_RECOVERY_TIMESTAMP_PROOF_INVALID\");\n        rejectedLegacyProofs[name] = error.message;\n        return true;\n      });\n      assert.deepEqual(snapshot(), before, \"Rejected legacy proof changes no stored row or DDL.\");\n    }\n    assert.deepEqual(store.readMutation(key)?.evidence, evidence);\n    scenarios[name] = { idempotencyKey: key, attemptId: attempt.id, sessionId: session.id,\n      originalSession: session, originalEffect: evidence, finalMutation: store.readMutation(key),\n      finalSession: store.requireSession(session.id) };\n  }\n}\n\nconst finalSnapshot = snapshot();\nassert.deepEqual(finalSnapshot.rows.migrations, originalMigrations);\nassert.equal(finalSnapshot.rows.mutation_effect_evidence?.length, 6);\nassert.equal(finalSnapshot.rows.mutation_resolutions?.length, 2);\nassert.equal(finalSnapshot.rows.queue_entries?.length, 2);\nassert.equal(finalSnapshot.rows.session_provider_account_authorities?.length, 7);\nassert.deepEqual(finalSnapshot.rows.notification_hours, initial.rows.notification_hours);\nassert.deepEqual(finalSnapshot.rows.attention_email_policy, initial.rows.attention_email_policy);\nfor (const profile of [mainProfile, otherProfile]) {\n  assert.deepEqual(finalSnapshot.rows.usage_revision_authority.filter((row) => (row as { profile_id: string }).profile_id === profile.id),\n    [{ profile_id: profile.id, next_revision: 2 }]);\n}\nfor (const table of [\"usage_snapshots\", \"usage_poll_failures\", \"usage_cloud_upload_anchors\"]) {\n  assert.deepEqual(finalSnapshot.rows[table], []);\n}\nstore.close();\n\n// Reopen only with the same archived constructor. This is not current49 compatibility proof.\nconst reopened = new StateStore(paths, { now: () => recordedNow++, resolveMachineTimeZone: () => \"UTC\" });\nassert.deepEqual(snapshot(), finalSnapshot);\nassert.deepEqual(reopened.listQueue(queueSession.id), [firstQueued, secondQueued]);\nreopened.close();\nconst checkpoint = new Database(paths.database, { create: false, strict: true });\nconst checkpointResult = checkpoint.query(\"PRAGMA wal_checkpoint(TRUNCATE)\").get();\ncheckpoint.close(false);\nassert.equal((checkpointResult as { busy: number }).busy, 0);\nconst beforeReadonlyHash = hash(readFileSync(paths.database));\nconst readonly = new StateStore(paths, { readonly: true });\nassert.deepEqual(readonly.listQueue(queueSession.id), [firstQueued, secondQueued]);\nassert.deepEqual(snapshot(), finalSnapshot);\nreadonly.close();\nconst bytes = readFileSync(paths.database);\nassert.equal(hash(bytes), beforeReadonlyHash);\nassert.ok(bytes.length < 8 * 1_024 * 1_024, \"Bound the fixture artifact.\");\nconst generatorSource = readFileSync(import.meta.path, \"utf8\");\nconst artifact = {\n  sourceCommit, sourceTree, schemaVersion: 41,\n  provenance: {\n    archiveCommand: `git archive ${sourceCommit} src package.json bun.lock`,\n    sourceHashes: expectedSourceHashes, archivedSourceManifestSha256: hash(JSON.stringify(sourceFiles)),\n    generatorSha256: hash(generatorSource),\n    bunVersion: Bun.version, dependency: { name: \"zod\", version: zodPackage.version },\n    timeZone: \"UTC\", unusedUsageRevisionReservationPerProfile: 1, quotaObservations: 0,\n    syntheticOnly: true, providerProcessesInvoked: false, rawSqlWrites: false,\n    deterministicDatabaseBytes: false,\n    randomnessNotice: \"Real archived public APIs generate random IDs. Hashes identify this captured output; rerunning reproduces the cohort/scenario, not identical database bytes.\",\n    compatibilityNotice: \"Generated and reopened only through exact canonical41. No current49, future integration, or release compatibility claim.\",\n  },\n  databaseBytes: bytes.length, databaseSha256: hash(bytes), checkpointResult,\n  rawTimestamp, profiles: [mainProfile, otherProfile], queueSession,\n  queue: { input: queueInput, first: firstQueued, second: secondQueued },\n  scenarios, rejectedLegacyProofs, snapshot: finalSnapshot,\n};\n// Public capture refuses unexpected host provenance; never scrub original bytes.\nfor (const forbidden of [scratch, \"/Users/\", \"/private/\", \"/tmp/\", \"/home/\", \"/Volumes/\"]) {\n  assert.equal(JSON.stringify(artifact).includes(forbidden), false);\n  assert.equal(bytes.includes(Buffer.from(forbidden)), false);\n}\nwriteFileSync(join(outputDirectory, \"canonical41.sqlite.gz\"), gzipSync(bytes), { mode: 0o600, flag: \"wx\" });\nwriteFileSync(join(outputDirectory, \"canonical41-fixture.json\"), `${JSON.stringify(artifact, null, 2)}\\n`, { mode: 0o600, flag: \"wx\" });\nwriteFileSync(join(outputDirectory, \"archived-source-manifest.json\"), `${JSON.stringify(sourceFiles, null, 2)}\\n`, { mode: 0o600, flag: \"wx\" });\nconsole.log(JSON.stringify({ sourceCommit, schemaVersion: 41, outputDirectory, databasePath: paths.database,\n  databaseBytes: bytes.length, databaseSha256: hash(bytes), generatorSha256: hash(generatorSource),\n  profiles: 2, sessions: 7, queued: 2, immutableEffects: 6, timestampResolutions: 2,\n  legacyProofRefusals: Object.keys(rejectedLegacyProofs).length, archivedReopenUnchanged: true }));\n";
const gzipBase64 = [
  "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",
  "KbtRsfys9yyPU+2eTnuidc5AiIvRcXKu309VprLfLbmhnk04dtkQL1Opo6jcaD90tIHrWDQkrkqWPu4pIWl7mZOVbWrEOQw9sOQFp+YDF6OC0Mc9KlnPkaFm",
  "i7o9FI9X6ki3sZwbWha1TEXZqtWg39MYz6ckq3Q6dFvseApIOAX0NdR/3jtePz+9vN9Kz0nLmd/6YExfcgq7pdCObBy+S4VEF9azAu2Tj67yhH3P7jFcf+lR",
  "VVbUbVsDk/WROC11mzapfo7ENVqw2GijNJPTw7EdOiT+ONnh7McPZ+xloBlW8zG1m7wNDj9KTTZGJR2hJmn/iUanoxmbkjjJHjd6JRu7xoxaEaOVnXnivQoQ",
  "xSBKt9tn3hadkct6/0994bN44wcAAAAAAAAAAMCLAv7/AQAAAAAAAACA4w++/wMAAAAAAAAAAMcffP8HAAAAAAAAAACOP3j/BwAAAAAAAAAAjj94/wcAAAAA",
  "AAAAAI4/eP8HAAAAAAAAAACOP/D/BwAAAAAAAAAAHH/w/R8AAAAAAAAAADj+4P0fAAAAAAAAAAA4/pw983dS6Skxdbp6pnvma6d+MH1rSjy3ePYfn/3HLzpn",
  "x4SnW4NUeu69SmavZurK9jbVDWoYiqa2TdF40NYkqa/rVJWo0Va1dr8niyaNkqg2hZWWQFrN2o0bQpOMj2jmmnC90RTIxp1VK2CjHhlm5ppwo1Yn68KaUG2R",
  "5kptXZhfudZotvLZdWF9vdaot1sr67fajWp1o9kU6lWhXbt9e6O1cm1NyObeJkJ99eP83q+n5+5WMj9ujCupohpUN9vbfVGXD1tYPi63vLX6utBsxZb37k2h",
  "TuqNFhHu1dZb6/MzxC18kVxvNm4HQhrEnCHk7k2hKRDzkiJX6sLdSyxKRZ4hhJCV+ioxL7lBHAH/Jyej013FuupH4V7hIzJFs29UsqJkKrs0y92RaYeaVG6L",
  "Jqmtk/rG2hp3U6WPzbbcp23RtDMg7VC536Fye0vTZ3Kk0Ywt8cM+7dM2VU1doQZ56JX4oVtiW4ArzsMERX7ISkMr2R5VZUXdztoZGc3EDBmteL7JiDZDyLuN",
  "Wn04o1Y7szxqfA7tvGtuM4U2mZM3UquTeS9/+aysGD3RlHbsX2J3U9nua30jm5vJHaCfrGy0bjaatdb9dq3+vZW12qrTX56u7v1r6dn1yvTeCUWV6eNIDd98",
  "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",
].join("");

const assertCanonical41DatabaseSize = (size: number): void => {
  if (!Number.isSafeInteger(size) || size < 100 || size > 8 * 1_024 * 1_024) {
    throw new Error("CANONICAL41_TIMESTAMPS_FIXTURE_BOUNDS_INVALID");
  }
};

export const canonical41TimestampsDatabaseBytes = (): Uint8Array => {
  if (Buffer.byteLength(canonical41TimestampsGeneratorSource, "utf8") > 64 * 1_024
    || createHash("sha256").update(canonical41TimestampsGeneratorSource).digest("hex") !== canonical41TimestampsFixture.generatorSha256) {
    throw new Error("CANONICAL41_TIMESTAMPS_GENERATOR_MISMATCH");
  }
  assertCanonical41DatabaseSize(canonical41TimestampsFixture.databaseBytes);
  if (gzipBase64.length > 2 * 1_024 * 1_024 || gzipBase64.length % 4 !== 0
    || !/^[A-Za-z0-9+/]*={0,2}$/u.test(gzipBase64)) {
    throw new Error("CANONICAL41_TIMESTAMPS_FIXTURE_BOUNDS_INVALID");
  }
  const compressed = Buffer.from(gzipBase64, "base64");
  if (compressed.toString("base64") !== gzipBase64) throw new Error("CANONICAL41_TIMESTAMPS_FIXTURE_ENCODING_INVALID");
  const bytes = gunzipSync(compressed, { maxOutputLength: canonical41TimestampsFixture.databaseBytes });
  if (bytes.byteLength !== canonical41TimestampsFixture.databaseBytes
    || createHash("sha256").update(bytes).digest("hex") !== canonical41TimestampsFixture.databaseSha256
    || !bytes.subarray(0, 16).equals(Buffer.from("SQLite format 3\0"))
    || bytes.readUInt32BE(60) !== canonical41TimestampsFixture.schemaVersion) {
    throw new Error("CANONICAL41_TIMESTAMPS_FIXTURE_MISMATCH");
  }
  return bytes;
};
