import { createHash } from "node:crypto";

import { expect, test } from "bun:test";
import fc from "fast-check";
import { z, type ZodType } from "zod";

import {
  mutationEffectEvidence49Schema,
  queueEffectEvidence49Schema,
} from "./effect-evidence-codecs";
import {
  mutationEvidenceCanonical40Schema,
  mutationEvidenceCanonical41Schema,
  mutationEvidenceCanonical43Schema,
  mutationEvidencePrivate48Schema,
  queueEvidenceCanonicalSchema,
  queueEvidencePrivate48Schema,
} from "./historical-effect-evidence-codecs";

// Synthetic parser oracles, not captured database/provider effects or native
// acceptance. Expected JSON, hashes and format membership below were computed
// only by archived pure schemas, never by these current implementation imports.
// TypeScript AST extraction selected these StateStore variable initializers:
// sha256Schema, providerThreadIdSchema, providerLoginIdSchema,
// providerAccountAuthorityKeySchema (except private48), providerBaselineSchema,
// sessionProviderSwitchHostCapabilitiesSchema (canonical43 only),
// mutationEffectEvidenceSchema and queueEffectEvidenceSchema.
// Each selected initializer was emitted as "const <name> = <initializer>;" in
// that order, joined by one newline, before transpiling. Archived pure domain
// dependencies were evaluated from the same revision. canonical43's actor enum
// was separately AST-extracted, without importing its session-events module.
// No StateStore, database, fixture generator or native runtime was executed.
// Bun 1.3.14; Zod 4.4.3; TypeScript 5.9.2 (extraction only).
// Source bytes and selected-declaration SHA-256 provenance:
// c40: 6f056dcafd6435cd11ae504c75e9b1f869955ca7
//   src/domain/values.ts: e0bbef6d7f8120027eee9490ff03abaf63fbe67606733b240da42bf5fcf2a347
//   src/domain/presets.ts: 2d32a78d85b5c5993cd48e39192ad6f21ed93495dafccdbdb65d58456bde5022
//   src/domain/runtime-profile.ts: f133f50cc5e7b96eec9ead0c97b8ee4014487e0b1b08d64f776ef4e5e57dd2d8
//   src/domain/session-tasks.ts: 8d0b45c3f9aaa0112638d8891de0658c676fef9aff101f3a1ec2ef6ed82d97c1
//   src/storage/state-store.ts: 0e9e9f772b9caeb5c1ec80f58927c643643b28ac6cc7ca1ae868028d61cef32f
//   extractedDeclarations: 7ea5ed18465afefb54b9695997cb825dcb66126b28cfc59d30114d9f58f5d2c8
// c41: 576ccd76a6742cd62759ab6176a6a41844846daa
//   src/domain/values.ts: e0bbef6d7f8120027eee9490ff03abaf63fbe67606733b240da42bf5fcf2a347
//   src/domain/presets.ts: 0b07dd4db680446fcf0943d3848ea6ec17d3e369a36608e70926e449424fa6d4
//   src/domain/runtime-profile.ts: 3c39335ac9b2754616f37b9bd47400a38d61163d21ab6727b2f2c4442adfcb06
//   src/domain/session-tasks.ts: 8d0b45c3f9aaa0112638d8891de0658c676fef9aff101f3a1ec2ef6ed82d97c1
//   src/storage/state-store.ts: 7aedcd4d6b4ad2e42ac3583af29d80fa280bf4f1546516df4da490ef54577d14
//   extractedDeclarations: a97d81faf1390d0687583f9cc0cd6dd24f9b3711d15b7b2d96aef3bb910d0b12
// c43: eaf0448e19383ac899c30d0a9cd70bbea71ff8b3
//   src/domain/values.ts: 40cfad2fa531cdafa437dc028306d725eb7592d94c69caa6cffa4c86af05074d
//   src/domain/presets.ts: 0b07dd4db680446fcf0943d3848ea6ec17d3e369a36608e70926e449424fa6d4
//   src/domain/runtime-profile.ts: 3c39335ac9b2754616f37b9bd47400a38d61163d21ab6727b2f2c4442adfcb06
//   src/domain/session-tasks.ts: 8d0b45c3f9aaa0112638d8891de0658c676fef9aff101f3a1ec2ef6ed82d97c1
//   src/storage/state-store.ts: 7f8b283b5f8dcae738aa74d94f9466631f86350b06aa58ecb2790482890bb553
//   src/domain/session-events.ts: cc9b1a45001df0aebb801b8d93b319d8841aceec6ad5f5a2848d4f6fbb792f9d
//   extractedActor: 909665e148261afda8d27b516a7f23941f4b7e0a720f6802e9670f5e7213add5
//   extractedDeclarations: 2d690fd9783e570b257b34ec9aba9ac52b3f4cd34a76a7dfa32df170ac66fea8
// p48: 3f6ac733dc17b3eec881ad98f2d65faadbcbaf37
//   src/domain/values.ts: e0bbef6d7f8120027eee9490ff03abaf63fbe67606733b240da42bf5fcf2a347
//   src/domain/presets.ts: 0b759ebb599660f55a773f8aadb8e6b4a152127742c8779ca805fbc09c38fd11
//   src/domain/runtime-profile.ts: 74a463a5476ad256e4af19f04eace78d25fa2b77ecbbf9f3a0efca5a8328fb3a
//   src/domain/session-tasks.ts: 8d0b45c3f9aaa0112638d8891de0658c676fef9aff101f3a1ec2ef6ed82d97c1
//   src/storage/state-store.ts: ab85e4c22124cfb76806148a2460e67e2aac486d13334d13f9a036808f831025
//   extractedDeclarations: 63974f24d2d89a8639be7cb5861d3508ffa872cff34c0fe9bf92a7e5058aa080
// t49: 0ae317793d5ff694b4d333effe25f85f7e7f1491
//   src/domain/values.ts: e0bbef6d7f8120027eee9490ff03abaf63fbe67606733b240da42bf5fcf2a347
//   src/domain/presets.ts: 60c83135e15858462f87f4b09f96eb91675492357729202b63446e8b86145f56
//   src/domain/runtime-profile.ts: 10eb575dbde914ce4c5a408a3836c5264122c0ea3aa91f8f615b2c8977097076
//   src/domain/session-tasks.ts: 8d0b45c3f9aaa0112638d8891de0658c676fef9aff101f3a1ec2ef6ed82d97c1
//   src/storage/state-store.ts: ca0dea1d88cc81f1d03f99bced0dea9fcfaab2ff3f2a5d756d3cf4d1c658c3ca
//   extractedDeclarations: 7ea5ed18465afefb54b9695997cb825dcb66126b28cfc59d30114d9f58f5d2c8
// Combined49 is recaptured only as a shared-input comparison; its exhaustive
// historical schema coverage remains in effect-evidence-history.test.ts.
// An armed fallback record is readable evidence, not authority to arm a runtime.

type Format = "c40" | "c41" | "c43" | "p48" | "t49";
type Fixture = Readonly<{
  name: string;
  codec: "mutation" | "queue";
  formats: readonly Format[];
  json: string;
  sha256: string;
}>;

const fixtures: readonly Fixture[] = [
  {
    "name": "send",
    "codec": "mutation",
    "formats": [
      "c40",
      "c41",
      "c43",
      "p48",
      "t49"
    ],
    "json": "{\"kind\":\"session.send\",\"providerThreadId\":\"synthetic-thread\",\"baseline\":{\"providerUpdatedAt\":1700000000,\"status\":\"active\",\"activeTurnId\":\"synthetic-turn\"},\"clientMessageId\":\"synthetic-message\",\"messageDigest\":\"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\"}",
    "sha256": "02f842352a893c18ffe1fc6dc08ca86b6a417c67e8d0ea451b9003476160a266"
  },
  {
    "name": "steer",
    "codec": "mutation",
    "formats": [
      "c40",
      "c41",
      "c43",
      "p48",
      "t49"
    ],
    "json": "{\"kind\":\"session.steer\",\"providerThreadId\":\"synthetic-thread\",\"baseline\":{\"providerUpdatedAt\":1700000000,\"status\":\"active\",\"activeTurnId\":\"synthetic-turn\"},\"activeTurnId\":null,\"clientMessageId\":\"synthetic-message\",\"messageDigest\":\"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\"}",
    "sha256": "b07e7ed4112f633d42c7b61eb02f9a12581187ec4f89bd4c31f9d0505392e6a9"
  },
  {
    "name": "stop",
    "codec": "mutation",
    "formats": [
      "c40",
      "c41",
      "c43",
      "p48",
      "t49"
    ],
    "json": "{\"kind\":\"session.stop\",\"providerThreadId\":\"synthetic-thread\",\"baseline\":{\"providerUpdatedAt\":1700000000,\"status\":\"active\",\"activeTurnId\":\"synthetic-turn\"},\"activeTurnId\":null}",
    "sha256": "d422aeb24449f262eab9c0804bc7e38b7e46adb97688b3ec24af9cb8c595d1fa"
  },
  {
    "name": "rename",
    "codec": "mutation",
    "formats": [
      "c40",
      "c41",
      "c43",
      "p48",
      "t49"
    ],
    "json": "{\"kind\":\"session.rename\",\"providerThreadId\":\"synthetic-thread\",\"baseline\":{\"providerUpdatedAt\":1700000000,\"status\":\"active\",\"activeTurnId\":\"synthetic-turn\"},\"requestedName\":\"Synthetic name\"}",
    "sha256": "a589e6c6ca8eb65bade2459b47f195446f06da49b514b61f317be4124612448e"
  },
  {
    "name": "start",
    "codec": "mutation",
    "formats": [
      "c40",
      "c41",
      "c43",
      "p48",
      "t49"
    ],
    "json": "{\"kind\":\"session.start\",\"projectId\":\"proj_22222222222222222222222222222222\",\"clientMessageId\":null,\"messageDigest\":null}",
    "sha256": "af0f31f69122dc49ac44ba855505bb4d0074fe2c4e0d911df5592210f40ebc76"
  },
  {
    "name": "switch",
    "codec": "mutation",
    "formats": [
      "c40",
      "c41",
      "c43",
      "p48",
      "t49"
    ],
    "json": "{\"kind\":\"session.switch\",\"requestedAccountId\":null,\"requestedPreset\":null,\"sourceProfileId\":\"acct_00000000000000000000000000000000\",\"sourceProcessGeneration\":2,\"sourceProvider\":\"codex\",\"sourceProviderThreadId\":\"synthetic-source-thread\",\"sourcePreset\":\"high\",\"targetProfileId\":\"acct_11111111111111111111111111111111\",\"targetProcessGeneration\":3,\"targetProvider\":\"codex\",\"targetPreset\":\"high\",\"transcriptDigest\":\"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc\",\"seedDigest\":\"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd\",\"seedIncludedRecords\":1,\"seedOmittedRecords\":0,\"runtimeProfile\":{\"profileId\":\"acct_11111111111111111111111111111111\",\"processGeneration\":3,\"observedAt\":1700000000000,\"preset\":\"high\",\"model\":\"gpt-5.6-sol\",\"reasoningEffort\":\"max\",\"serviceTier\":null,\"fast\":false,\"approvalPolicy\":\"on-request\",\"reviewMode\":\"auto_review\",\"permissionProfile\":\":workspace\",\"computerUse\":true,\"pluginCapability\":true,\"enabledApps\":[]}}",
    "sha256": "9957ae4088456966bc411cb5059cb79a6b9dc3d91be6aa96e841c63676739c59"
  },
  {
    "name": "queue",
    "codec": "queue",
    "formats": [
      "c40",
      "c41",
      "c43",
      "p48",
      "t49"
    ],
    "json": "{\"kind\":\"queue.dispatch\",\"queueId\":\"queue_33333333333333333333333333333333\",\"sessionId\":\"sess_44444444444444444444444444444444\",\"providerThreadId\":\"synthetic-thread\",\"profileGeneration\":3,\"baseline\":{\"providerUpdatedAt\":1700000000,\"status\":\"active\",\"activeTurnId\":\"synthetic-turn\"},\"clientMessageId\":\"synthetic-message\",\"messageDigest\":\"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\",\"runtimeProfile\":{\"profileId\":\"acct_11111111111111111111111111111111\",\"processGeneration\":3,\"observedAt\":1700000000000,\"preset\":\"high\",\"model\":\"gpt-5.6-sol\",\"reasoningEffort\":\"max\",\"serviceTier\":null,\"fast\":false,\"approvalPolicy\":\"on-request\",\"reviewMode\":\"auto_review\",\"permissionProfile\":\":workspace\",\"computerUse\":true,\"pluginCapability\":true,\"enabledApps\":[]}}",
    "sha256": "f27a090254dd7bcb997f725fb7692c2fcc4a9f70187c6a5a919adee29a436e9f"
  },
  {
    "name": "login",
    "codec": "mutation",
    "formats": [
      "c40",
      "c41",
      "c43",
      "p48",
      "t49"
    ],
    "json": "{\"kind\":\"account.login\",\"method\":\"browser\"}",
    "sha256": "c20652370ba62e0abe84bed6d62178354ba704d8d9284e0b21ab357c81aa54c1"
  },
  {
    "name": "claude-login",
    "codec": "mutation",
    "formats": [
      "c40",
      "c41",
      "c43",
      "p48",
      "t49"
    ],
    "json": "{\"kind\":\"account.claude-login\",\"provider\":\"claude\",\"baselineSignedIn\":false}",
    "sha256": "9800323eb0ebc24a963bf618ca360477c8190d459e64ffceb39f1a88f0d20edf"
  },
  {
    "name": "devin-login",
    "codec": "mutation",
    "formats": [
      "c40",
      "c41",
      "c43",
      "p48",
      "t49"
    ],
    "json": "{\"kind\":\"account.devin-login\",\"provider\":\"devin\",\"baselineSignedIn\":false}",
    "sha256": "2476e8f4eb506499ef2768c2dab661198e6e2b63db62edaabd9da7ae01e93252"
  },
  {
    "name": "logout",
    "codec": "mutation",
    "formats": [
      "c40",
      "c41",
      "c43",
      "p48",
      "t49"
    ],
    "json": "{\"kind\":\"account.logout\",\"baselineSignedIn\":true}",
    "sha256": "fd57bf63698409131b0d21ec97b1cf96aa42728578a36e605e2f420ba79bde8c"
  },
  {
    "name": "login-cancel",
    "codec": "mutation",
    "formats": [
      "c40",
      "c41",
      "c43",
      "p48",
      "t49"
    ],
    "json": "{\"kind\":\"account.login-cancel\",\"loginId\":\"synthetic-login\"}",
    "sha256": "127a77bbab7af70167d1f8f6f2e8d8d38273f759d267811ccdeb9ab65c055dc1"
  },
  {
    "name": "session.stop unit",
    "codec": "mutation",
    "formats": [
      "c41",
      "c43"
    ],
    "json": "{\"kind\":\"session.stop\",\"providerThreadId\":\"synthetic-thread\",\"providerTimestampUnit\":\"unix_milliseconds_v1\",\"baseline\":{\"providerUpdatedAt\":1700000000,\"status\":\"active\",\"activeTurnId\":\"synthetic-turn\"},\"activeTurnId\":null}",
    "sha256": "36c98b0fc0da381ce2f294198cf29b6afc09d886d29626d2a1846187d75e3574"
  },
  {
    "name": "session.rename unit",
    "codec": "mutation",
    "formats": [
      "c41",
      "c43"
    ],
    "json": "{\"kind\":\"session.rename\",\"providerThreadId\":\"synthetic-thread\",\"providerTimestampUnit\":\"unix_milliseconds_v1\",\"baseline\":{\"providerUpdatedAt\":1700000000,\"status\":\"active\",\"activeTurnId\":\"synthetic-turn\"},\"requestedName\":\"Synthetic name\"}",
    "sha256": "ca9dd965d6cf6eba283f575d964265e49bde51d79cb0101aa7bc2366081e408e"
  },
  {
    "name": "send human",
    "codec": "mutation",
    "formats": [
      "c43"
    ],
    "json": "{\"kind\":\"session.send\",\"providerThreadId\":\"synthetic-thread\",\"baseline\":{\"providerUpdatedAt\":1700000000,\"status\":\"active\",\"activeTurnId\":\"synthetic-turn\"},\"clientMessageId\":\"synthetic-message\",\"messageDigest\":\"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\",\"messageActor\":\"human\"}",
    "sha256": "cf75e795b28a1ddd0e674391b25fff6409d7cfc7abc249a82c8f9103638e4235"
  },
  {
    "name": "send autorespond",
    "codec": "mutation",
    "formats": [
      "c43"
    ],
    "json": "{\"kind\":\"session.send\",\"providerThreadId\":\"synthetic-thread\",\"baseline\":{\"providerUpdatedAt\":1700000000,\"status\":\"active\",\"activeTurnId\":\"synthetic-turn\"},\"clientMessageId\":\"synthetic-message\",\"messageDigest\":\"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\",\"messageActor\":\"autorespond\"}",
    "sha256": "6cd6824c81c7edfd0b4e62effda8ac6c2e69a3caa3c0aaccf03c83f86d523e01"
  },
  {
    "name": "send peer_session",
    "codec": "mutation",
    "formats": [
      "c43"
    ],
    "json": "{\"kind\":\"session.send\",\"providerThreadId\":\"synthetic-thread\",\"baseline\":{\"providerUpdatedAt\":1700000000,\"status\":\"active\",\"activeTurnId\":\"synthetic-turn\"},\"clientMessageId\":\"synthetic-message\",\"messageDigest\":\"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\",\"messageActor\":\"peer_session\"}",
    "sha256": "b05bf8b812d47469d19e184ae64e15c5646bbfdc2ced862be878cfcb50da1222"
  },
  {
    "name": "send provider_switch",
    "codec": "mutation",
    "formats": [
      "c43"
    ],
    "json": "{\"kind\":\"session.send\",\"providerThreadId\":\"synthetic-thread\",\"baseline\":{\"providerUpdatedAt\":1700000000,\"status\":\"active\",\"activeTurnId\":\"synthetic-turn\"},\"clientMessageId\":\"synthetic-message\",\"messageDigest\":\"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\",\"messageActor\":\"provider_switch\"}",
    "sha256": "ada759b8e7c891fbcee047ea8dd9d3aed6bd3b9bdb90c3f134b771054debc8b3"
  },
  {
    "name": "steer peer_session",
    "codec": "mutation",
    "formats": [
      "c43"
    ],
    "json": "{\"kind\":\"session.steer\",\"providerThreadId\":\"synthetic-thread\",\"baseline\":{\"providerUpdatedAt\":1700000000,\"status\":\"active\",\"activeTurnId\":\"synthetic-turn\"},\"activeTurnId\":null,\"clientMessageId\":\"synthetic-message\",\"messageDigest\":\"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\",\"messageActor\":\"peer_session\"}",
    "sha256": "0724d5aad5740e8f3d9daffae51481cb9f857098f35526951098a304b584e1b6"
  },
  {
    "name": "switch account key",
    "codec": "mutation",
    "formats": [
      "c40",
      "c41",
      "c43",
      "t49"
    ],
    "json": "{\"kind\":\"session.switch\",\"requestedAccountId\":null,\"requestedPreset\":null,\"sourceProfileId\":\"acct_00000000000000000000000000000000\",\"sourceProcessGeneration\":2,\"sourceProvider\":\"codex\",\"sourceProviderThreadId\":\"synthetic-source-thread\",\"sourcePreset\":\"high\",\"targetProfileId\":\"acct_11111111111111111111111111111111\",\"targetProcessGeneration\":3,\"targetProvider\":\"codex\",\"targetProviderAccountKey\":\"v1:codex:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc\",\"targetPreset\":\"high\",\"transcriptDigest\":\"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc\",\"seedDigest\":\"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd\",\"seedIncludedRecords\":1,\"seedOmittedRecords\":0,\"runtimeProfile\":{\"profileId\":\"acct_11111111111111111111111111111111\",\"processGeneration\":3,\"observedAt\":1700000000000,\"preset\":\"high\",\"model\":\"gpt-5.6-sol\",\"reasoningEffort\":\"max\",\"serviceTier\":null,\"fast\":false,\"approvalPolicy\":\"on-request\",\"reviewMode\":\"auto_review\",\"permissionProfile\":\":workspace\",\"computerUse\":true,\"pluginCapability\":true,\"enabledApps\":[]}}",
    "sha256": "7b0c71eb1462db4c00755e8eeeb81798a87b710c6155ef513c2a339866b4a782"
  },
  {
    "name": "switch host capabilities",
    "codec": "mutation",
    "formats": [
      "c43"
    ],
    "json": "{\"kind\":\"session.switch\",\"requestedAccountId\":null,\"requestedPreset\":null,\"sourceProfileId\":\"acct_00000000000000000000000000000000\",\"sourceProcessGeneration\":2,\"sourceProvider\":\"codex\",\"sourceProviderThreadId\":\"synthetic-source-thread\",\"sourcePreset\":\"high\",\"targetProfileId\":\"acct_11111111111111111111111111111111\",\"targetProcessGeneration\":3,\"targetProvider\":\"codex\",\"targetHostCapabilities\":{\"preambleVersion\":1,\"preambleDigest\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"manifestVersion\":2,\"manifestDigest\":\"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd\"},\"targetPreset\":\"high\",\"transcriptDigest\":\"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc\",\"seedDigest\":\"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd\",\"seedIncludedRecords\":1,\"seedOmittedRecords\":0,\"runtimeProfile\":{\"profileId\":\"acct_11111111111111111111111111111111\",\"processGeneration\":3,\"observedAt\":1700000000000,\"preset\":\"high\",\"model\":\"gpt-5.6-sol\",\"reasoningEffort\":\"max\",\"serviceTier\":null,\"fast\":false,\"approvalPolicy\":\"on-request\",\"reviewMode\":\"auto_review\",\"permissionProfile\":\":workspace\",\"computerUse\":true,\"pluginCapability\":true,\"enabledApps\":[]}}",
    "sha256": "f1925c5fa54e885fb468a8b47103859408f9454f438188ec2d678404bfd6b956"
  },
  {
    "name": "switch all optionals",
    "codec": "mutation",
    "formats": [
      "c43"
    ],
    "json": "{\"kind\":\"session.switch\",\"daemonGeneration\":9,\"requestedAccountId\":\"acct_11111111111111111111111111111111\",\"requestedPreset\":\"high\",\"sourceProfileId\":\"acct_00000000000000000000000000000000\",\"sourceProcessGeneration\":2,\"sourceProvider\":\"codex\",\"sourceProviderThreadId\":\"synthetic-source-thread\",\"sourcePreset\":\"high\",\"targetProfileId\":\"acct_11111111111111111111111111111111\",\"targetProcessGeneration\":3,\"targetProvider\":\"codex\",\"targetProviderAccountKey\":\"v1:codex:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc\",\"targetHostCapabilities\":{\"preambleVersion\":1,\"preambleDigest\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"manifestVersion\":2,\"manifestDigest\":\"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd\"},\"targetPreset\":\"high\",\"transcriptDigest\":\"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc\",\"seedDigest\":\"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd\",\"seedIncludedRecords\":1,\"seedOmittedRecords\":0,\"runtimeProfile\":{\"profileId\":\"acct_11111111111111111111111111111111\",\"processGeneration\":3,\"observedAt\":1700000000000,\"preset\":\"high\",\"model\":\"gpt-5.6-sol\",\"reasoningEffort\":\"max\",\"serviceTier\":null,\"fast\":false,\"approvalPolicy\":\"on-request\",\"reviewMode\":\"auto_review\",\"permissionProfile\":\":workspace\",\"computerUse\":true,\"pluginCapability\":true,\"enabledApps\":[]}}",
    "sha256": "a4aca568a4d1121f747eb3436fe83d0deb5005239f538549a5cf3a7b949a9817"
  },
  {
    "name": "start Claude legacy fallback absent",
    "codec": "mutation",
    "formats": [
      "c40",
      "c41",
      "c43",
      "p48",
      "t49"
    ],
    "json": "{\"kind\":\"session.start\",\"projectId\":\"proj_22222222222222222222222222222222\",\"clientMessageId\":null,\"messageDigest\":null,\"runtimeProfile\":{\"profileId\":\"acct_11111111111111111111111111111111\",\"processGeneration\":3,\"observedAt\":1700000000000,\"preset\":\"fable-max\",\"model\":\"claude-fable-5-1\",\"reasoningEffort\":\"max\",\"claudeVersion\":\"2.1.260\",\"permissionMode\":\"default\",\"isolatedConfigDir\":true,\"outputFormat\":\"stream-json\",\"inputFormat\":\"stream-json\"}}",
    "sha256": "4f5288f67ad5d4c0e1231062ef7ce9bd5fa6925741b4b089ccf7e8172ab49ea2"
  },
  {
    "name": "queue Claude legacy fallback absent",
    "codec": "queue",
    "formats": [
      "c40",
      "c41",
      "c43",
      "p48",
      "t49"
    ],
    "json": "{\"kind\":\"queue.dispatch\",\"queueId\":\"queue_33333333333333333333333333333333\",\"sessionId\":\"sess_44444444444444444444444444444444\",\"providerThreadId\":\"synthetic-thread\",\"profileGeneration\":3,\"baseline\":{\"providerUpdatedAt\":1700000000,\"status\":\"active\",\"activeTurnId\":\"synthetic-turn\"},\"clientMessageId\":\"synthetic-message\",\"messageDigest\":\"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\",\"runtimeProfile\":{\"profileId\":\"acct_11111111111111111111111111111111\",\"processGeneration\":3,\"observedAt\":1700000000000,\"preset\":\"fable-max\",\"model\":\"claude-fable-5-1\",\"reasoningEffort\":\"max\",\"claudeVersion\":\"2.1.260\",\"permissionMode\":\"default\",\"isolatedConfigDir\":true,\"outputFormat\":\"stream-json\",\"inputFormat\":\"stream-json\"}}",
    "sha256": "3f4f289310e3322a0661bb8688ec68ce647387a9017d3e1cd8637947e15092e0"
  },
  {
    "name": "start Claude isolated fallback absent",
    "codec": "mutation",
    "formats": [
      "c40",
      "c41",
      "c43",
      "t49"
    ],
    "json": "{\"kind\":\"session.start\",\"projectId\":\"proj_22222222222222222222222222222222\",\"clientMessageId\":null,\"messageDigest\":null,\"runtimeProfile\":{\"profileId\":\"acct_11111111111111111111111111111111\",\"processGeneration\":3,\"observedAt\":1700000000000,\"preset\":\"fable-max\",\"model\":\"claude-fable-5-1\",\"reasoningEffort\":\"max\",\"claudeVersion\":\"2.1.260\",\"permissionMode\":\"default\",\"configHome\":\"isolated\",\"outputFormat\":\"stream-json\",\"inputFormat\":\"stream-json\"}}",
    "sha256": "5a24bbb4c5bc454992f1be1a8076d430d81f3501fafa66365482f28943b52e6e"
  },
  {
    "name": "queue Claude isolated fallback absent",
    "codec": "queue",
    "formats": [
      "c40",
      "c41",
      "c43",
      "t49"
    ],
    "json": "{\"kind\":\"queue.dispatch\",\"queueId\":\"queue_33333333333333333333333333333333\",\"sessionId\":\"sess_44444444444444444444444444444444\",\"providerThreadId\":\"synthetic-thread\",\"profileGeneration\":3,\"baseline\":{\"providerUpdatedAt\":1700000000,\"status\":\"active\",\"activeTurnId\":\"synthetic-turn\"},\"clientMessageId\":\"synthetic-message\",\"messageDigest\":\"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\",\"runtimeProfile\":{\"profileId\":\"acct_11111111111111111111111111111111\",\"processGeneration\":3,\"observedAt\":1700000000000,\"preset\":\"fable-max\",\"model\":\"claude-fable-5-1\",\"reasoningEffort\":\"max\",\"claudeVersion\":\"2.1.260\",\"permissionMode\":\"default\",\"configHome\":\"isolated\",\"outputFormat\":\"stream-json\",\"inputFormat\":\"stream-json\"}}",
    "sha256": "38143f796dd7ca99e9846cc0b0909e1985071415e9808d661cb9b79bd035bdec"
  },
  {
    "name": "start Claude personal fallback absent",
    "codec": "mutation",
    "formats": [
      "c40",
      "c41",
      "c43",
      "t49"
    ],
    "json": "{\"kind\":\"session.start\",\"projectId\":\"proj_22222222222222222222222222222222\",\"clientMessageId\":null,\"messageDigest\":null,\"runtimeProfile\":{\"profileId\":\"acct_11111111111111111111111111111111\",\"processGeneration\":3,\"observedAt\":1700000000000,\"preset\":\"fable-max\",\"model\":\"claude-fable-5-1\",\"reasoningEffort\":\"max\",\"claudeVersion\":\"2.1.260\",\"permissionMode\":\"default\",\"configHome\":\"personal\",\"outputFormat\":\"stream-json\",\"inputFormat\":\"stream-json\"}}",
    "sha256": "a9d19090588a483219eeb978b8a0658b5906aa0c5145eeb785cd41f0a927c0ab"
  },
  {
    "name": "queue Claude personal fallback absent",
    "codec": "queue",
    "formats": [
      "c40",
      "c41",
      "c43",
      "t49"
    ],
    "json": "{\"kind\":\"queue.dispatch\",\"queueId\":\"queue_33333333333333333333333333333333\",\"sessionId\":\"sess_44444444444444444444444444444444\",\"providerThreadId\":\"synthetic-thread\",\"profileGeneration\":3,\"baseline\":{\"providerUpdatedAt\":1700000000,\"status\":\"active\",\"activeTurnId\":\"synthetic-turn\"},\"clientMessageId\":\"synthetic-message\",\"messageDigest\":\"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\",\"runtimeProfile\":{\"profileId\":\"acct_11111111111111111111111111111111\",\"processGeneration\":3,\"observedAt\":1700000000000,\"preset\":\"fable-max\",\"model\":\"claude-fable-5-1\",\"reasoningEffort\":\"max\",\"claudeVersion\":\"2.1.260\",\"permissionMode\":\"default\",\"configHome\":\"personal\",\"outputFormat\":\"stream-json\",\"inputFormat\":\"stream-json\"}}",
    "sha256": "c010e5fc840e8650816c720a8ad071baf86cae6240691dd39094b46eb94e665c"
  },
  {
    "name": "start Claude legacy fallback armed",
    "codec": "mutation",
    "formats": [
      "p48",
      "t49"
    ],
    "json": "{\"kind\":\"session.start\",\"projectId\":\"proj_22222222222222222222222222222222\",\"clientMessageId\":null,\"messageDigest\":null,\"runtimeProfile\":{\"profileId\":\"acct_11111111111111111111111111111111\",\"processGeneration\":3,\"observedAt\":1700000000000,\"preset\":\"fable-max\",\"model\":\"claude-fable-5-1\",\"reasoningEffort\":\"max\",\"claudeVersion\":\"2.1.260\",\"permissionMode\":\"default\",\"isolatedConfigDir\":true,\"outputFormat\":\"stream-json\",\"inputFormat\":\"stream-json\",\"nativeFallback\":{\"evidenceDigest\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"model\":\"claude-opus-5\",\"status\":\"armed\"}}}",
    "sha256": "8f394fa8d3a0fac9dc5990f532c25f3da389c88d4914d2985c501cef09ac7951"
  },
  {
    "name": "queue Claude legacy fallback armed",
    "codec": "queue",
    "formats": [
      "p48",
      "t49"
    ],
    "json": "{\"kind\":\"queue.dispatch\",\"queueId\":\"queue_33333333333333333333333333333333\",\"sessionId\":\"sess_44444444444444444444444444444444\",\"providerThreadId\":\"synthetic-thread\",\"profileGeneration\":3,\"baseline\":{\"providerUpdatedAt\":1700000000,\"status\":\"active\",\"activeTurnId\":\"synthetic-turn\"},\"clientMessageId\":\"synthetic-message\",\"messageDigest\":\"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\",\"runtimeProfile\":{\"profileId\":\"acct_11111111111111111111111111111111\",\"processGeneration\":3,\"observedAt\":1700000000000,\"preset\":\"fable-max\",\"model\":\"claude-fable-5-1\",\"reasoningEffort\":\"max\",\"claudeVersion\":\"2.1.260\",\"permissionMode\":\"default\",\"isolatedConfigDir\":true,\"outputFormat\":\"stream-json\",\"inputFormat\":\"stream-json\",\"nativeFallback\":{\"evidenceDigest\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"model\":\"claude-opus-5\",\"status\":\"armed\"}}}",
    "sha256": "33856e7d3e5769183fecd8b0df3e4168d051b343fa5061bed45928cf9959cb3a"
  },
  {
    "name": "start Claude legacy fallback unavailable",
    "codec": "mutation",
    "formats": [
      "p48",
      "t49"
    ],
    "json": "{\"kind\":\"session.start\",\"projectId\":\"proj_22222222222222222222222222222222\",\"clientMessageId\":null,\"messageDigest\":null,\"runtimeProfile\":{\"profileId\":\"acct_11111111111111111111111111111111\",\"processGeneration\":3,\"observedAt\":1700000000000,\"preset\":\"fable-max\",\"model\":\"claude-fable-5-1\",\"reasoningEffort\":\"max\",\"claudeVersion\":\"2.1.260\",\"permissionMode\":\"default\",\"isolatedConfigDir\":true,\"outputFormat\":\"stream-json\",\"inputFormat\":\"stream-json\",\"nativeFallback\":{\"model\":\"claude-opus-5\",\"reason\":\"live_acceptance_required\",\"status\":\"unavailable\"}}}",
    "sha256": "e6c57a40d69cf0de078ef0432f66e66dc1cbc6263b2b0c6c4511961d2fcb4466"
  },
  {
    "name": "queue Claude legacy fallback unavailable",
    "codec": "queue",
    "formats": [
      "p48",
      "t49"
    ],
    "json": "{\"kind\":\"queue.dispatch\",\"queueId\":\"queue_33333333333333333333333333333333\",\"sessionId\":\"sess_44444444444444444444444444444444\",\"providerThreadId\":\"synthetic-thread\",\"profileGeneration\":3,\"baseline\":{\"providerUpdatedAt\":1700000000,\"status\":\"active\",\"activeTurnId\":\"synthetic-turn\"},\"clientMessageId\":\"synthetic-message\",\"messageDigest\":\"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\",\"runtimeProfile\":{\"profileId\":\"acct_11111111111111111111111111111111\",\"processGeneration\":3,\"observedAt\":1700000000000,\"preset\":\"fable-max\",\"model\":\"claude-fable-5-1\",\"reasoningEffort\":\"max\",\"claudeVersion\":\"2.1.260\",\"permissionMode\":\"default\",\"isolatedConfigDir\":true,\"outputFormat\":\"stream-json\",\"inputFormat\":\"stream-json\",\"nativeFallback\":{\"model\":\"claude-opus-5\",\"reason\":\"live_acceptance_required\",\"status\":\"unavailable\"}}}",
    "sha256": "dda34052be0eaa0d147cd60aa670ce88fbff47e69afc7d9632f654295a2c8617"
  }
];

const formats: readonly Format[] = ["c40", "c41", "c43", "p48", "t49"];
const mutationSchemas: Readonly<Record<Format, ZodType>> = {
  c40: mutationEvidenceCanonical40Schema,
  c41: mutationEvidenceCanonical41Schema,
  c43: mutationEvidenceCanonical43Schema,
  p48: mutationEvidencePrivate48Schema,
  t49: mutationEffectEvidence49Schema,
};
const queueSchemas: Readonly<Record<Format, ZodType>> = {
  c40: queueEvidenceCanonicalSchema,
  c41: queueEvidenceCanonicalSchema,
  c43: queueEvidenceCanonicalSchema,
  p48: queueEvidencePrivate48Schema,
  t49: queueEffectEvidence49Schema,
};
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
const objectSchema = z.record(z.string(), z.unknown());
const fixtureInput = (name: string): Record<string, unknown> => {
  const fixture = fixtures.find((value) => value.name === name);
  if (fixture === undefined) throw new Error("Missing literal historical fixture.");
  return objectSchema.parse(JSON.parse(fixture.json) as unknown);
};

for (const fixture of fixtures) {
  test(`archived membership, canonical bytes and digest: ${fixture.name}`, () => {
    const input = objectSchema.parse(JSON.parse(fixture.json) as unknown);
    expect(hash(fixture.json)).toBe(fixture.sha256);
    const schemas = fixture.codec === "mutation" ? mutationSchemas : queueSchemas;
    for (const format of formats) {
      const result = schemas[format].safeParse(input);
      expect(result.success).toBe(fixture.formats.includes(format));
      if (result.success) {
        expect(result.data).toEqual(input);
        expect(JSON.stringify(result.data)).toBe(fixture.json);
        expect(hash(JSON.stringify(result.data))).toBe(fixture.sha256);
        // Full output equality also forbids silently added optional defaults.
        expect(schemas[format].safeParse({ ...input, futureEvidenceField: true }).success).toBe(false);
        if (fixture.formats.includes("t49")) {
          expect(result.data).toEqual(schemas.t49.parse(input));
        }
      }
    }
  });
}

test("canonical optional authority is absent, never synthesized or inferred from null", () => {
  for (const [name, key] of [
    ["send", "messageActor"],
    ["steer", "messageActor"],
    ["stop", "providerTimestampUnit"],
    ["rename", "providerTimestampUnit"],
    ["switch", "targetHostCapabilities"],
    ["switch", "targetProviderAccountKey"],
    ["switch", "daemonGeneration"],
  ] as const) {
    const input = fixtureInput(name);
    for (const schema of Object.values(mutationSchemas)) {
      expect(Object.hasOwn(objectSchema.parse(schema.parse(input)), key)).toBe(false);
      expect(schema.safeParse({ ...input, [key]: null }).success).toBe(false);
    }
  }
});

test("real later authority fields are strict refusals in predecessor formats", () => {
  // Literal valid later values ensure this proves format separation, not merely
  // a malformed value being rejected by every parser.
  const unit = fixtureInput("session.stop unit");
  expect(mutationEvidenceCanonical41Schema.safeParse(unit).success).toBe(true);
  for (const schema of [mutationEvidenceCanonical40Schema, mutationEvidencePrivate48Schema, mutationEffectEvidence49Schema]) {
    expect(schema.safeParse(unit).success).toBe(false);
  }
  const actor = fixtureInput("send peer_session");
  const capability = fixtureInput("switch host capabilities");
  for (const input of [actor, capability]) {
    expect(mutationEvidenceCanonical43Schema.safeParse(input).success).toBe(true);
    for (const schema of [mutationEvidenceCanonical40Schema, mutationEvidenceCanonical41Schema, mutationEvidencePrivate48Schema, mutationEffectEvidence49Schema]) {
      expect(schema.safeParse(input).success).toBe(false);
    }
  }
});

test("canonical units and actors reject malformed values and wrong evidence kinds", () => {
  for (const value of ["milliseconds", "unix_seconds_v1", "", 1, {}, [], null]) {
    for (const schema of Object.values(mutationSchemas)) {
      expect(schema.safeParse({ ...fixtureInput("stop"), providerTimestampUnit: value }).success).toBe(false);
      expect(schema.safeParse({ ...fixtureInput("rename"), providerTimestampUnit: value }).success).toBe(false);
    }
  }
  for (const messageActor of ["peer", "assistant", "", 1, {}, [], null]) {
    expect(mutationEvidenceCanonical43Schema.safeParse({ ...fixtureInput("send"), messageActor }).success).toBe(false);
    expect(mutationEvidenceCanonical43Schema.safeParse({ ...fixtureInput("steer"), messageActor }).success).toBe(false);
  }
  for (const [name, fields] of [
    ["send", { providerTimestampUnit: "unix_milliseconds_v1" }],
    ["stop", { messageActor: "human" }],
    ["start", { messageActor: "human" }],
    ["rename", { targetHostCapabilities: fixtureInput("switch host capabilities").targetHostCapabilities }],
  ] as const) {
    for (const schema of Object.values(mutationSchemas)) {
      expect(schema.safeParse({ ...fixtureInput(name), ...fields }).success).toBe(false);
    }
  }
  for (const schema of Object.values(queueSchemas)) {
    for (const fields of [
      { providerTimestampUnit: "unix_milliseconds_v1" },
      { messageActor: "peer_session" },
      { targetHostCapabilities: fixtureInput("switch host capabilities").targetHostCapabilities },
    ]) expect(schema.safeParse({ ...fixtureInput("queue"), ...fields }).success).toBe(false);
  }
});

test("canonical43 host capability bounds preserve both independently ordered digests", () => {
  const input = fixtureInput("switch host capabilities");
  const capabilities = objectSchema.parse(input.targetHostCapabilities);
  for (const version of [1, 2, Number.MAX_SAFE_INTEGER]) {
    const targetHostCapabilities = { ...capabilities, preambleVersion: version, manifestVersion: version };
    expect(mutationEvidenceCanonical43Schema.safeParse({ ...input, targetHostCapabilities }).success).toBe(true);
  }
  for (const version of [0, -1, 0.25, Number.MAX_SAFE_INTEGER + 1, Number.POSITIVE_INFINITY, "1"]) {
    for (const key of ["preambleVersion", "manifestVersion"]) {
      expect(mutationEvidenceCanonical43Schema.safeParse({
        ...input, targetHostCapabilities: { ...capabilities, [key]: version },
      }).success).toBe(false);
    }
  }
  for (const digest of ["A".repeat(64), "a".repeat(63), "g".repeat(64), null]) {
    for (const key of ["preambleDigest", "manifestDigest"]) {
      expect(mutationEvidenceCanonical43Schema.safeParse({
        ...input, targetHostCapabilities: { ...capabilities, [key]: digest },
      }).success).toBe(false);
    }
  }
  expect(mutationEvidenceCanonical43Schema.safeParse({
    ...input, targetHostCapabilities: { ...capabilities, futureCapability: true },
  }).success).toBe(false);
});

test("canonical Claude forbids fallback presence while private48 preserves only legacy home custody", () => {
  for (const [name, schemas] of [
    ["start", mutationSchemas],
    ["queue", queueSchemas],
  ] as const) {
    for (const home of ["legacy", "isolated", "personal"]) {
      const input = fixtureInput(`${name} Claude ${home} fallback absent`);
      const runtime = objectSchema.parse(input.runtimeProfile);
      for (const nativeFallback of [
        undefined,
        objectSchema.parse(fixtureInput(`${name} Claude legacy fallback armed`).runtimeProfile).nativeFallback,
        objectSchema.parse(fixtureInput(`${name} Claude legacy fallback unavailable`).runtimeProfile).nativeFallback,
      ]) {
        for (const format of ["c40", "c41", "c43"] as const) {
          expect(schemas[format].safeParse({ ...input, runtimeProfile: { ...runtime, nativeFallback } }).success).toBe(false);
        }
      }
      expect(schemas.p48.safeParse(input).success).toBe(home === "legacy");
      if (home !== "legacy") {
        // A present home key remains outside private48 even if undefined.
        const legacy = fixtureInput(`${name} Claude legacy fallback absent`);
        expect(schemas.p48.safeParse({
          ...legacy, runtimeProfile: { ...objectSchema.parse(legacy.runtimeProfile), configHome: undefined },
        }).success).toBe(false);
      }
    }
  }
  const input = fixtureInput("switch account key");
  expect(mutationEvidenceCanonical40Schema.safeParse(input).success).toBe(true);
  expect(mutationEvidencePrivate48Schema.safeParse(input).success).toBe(false);
  expect(mutationEvidencePrivate48Schema.safeParse({ ...fixtureInput("switch"), targetProviderAccountKey: undefined }).success).toBe(false);
});

// Reorder each object recursively, but never reorder array content. A generated
// signed integer changes the ranking of every key; fixture semantics stay fixed.
const reorderKeys = (input: unknown, seed: number): unknown => {
  if (Array.isArray(input)) return input.map((value: unknown) => reorderKeys(value, seed + 1));
  if (input === null || typeof input !== "object") return input;
  return Object.fromEntries(Object.entries(objectSchema.parse(input))
    .sort(([left], [right]) => hash(`${seed}:${left}`).localeCompare(hash(`${seed}:${right}`)))
    .map(([key, value]) => [key, reorderKeys(value, seed + 1)]));
};

test("bounded key-order permutations retain archived bytes, membership and old49 intersections", () => {
  fc.assert(fc.property(
    fc.integer({ min: 0, max: fixtures.length - 1 }),
    fc.integer(),
    (index, seed) => {
      const fixture = fixtures[index];
      if (fixture === undefined) throw new Error("Missing generated fixture.");
      const input = reorderKeys(JSON.parse(fixture.json) as unknown, seed);
      const schemas = fixture.codec === "mutation" ? mutationSchemas : queueSchemas;
      for (const format of formats) {
        const result = schemas[format].safeParse(input);
        expect(result.success).toBe(fixture.formats.includes(format));
        if (result.success) {
          expect(JSON.stringify(result.data)).toBe(fixture.json);
          expect(hash(JSON.stringify(result.data))).toBe(fixture.sha256);
        }
      }
    },
  ), { seed: 4904143, numRuns: 200 });
});

test("all historical parsers are total over bounded generated JSON inputs", () => {
  const schemas = [...Object.values(mutationSchemas), ...Object.values(queueSchemas)];
  fc.assert(fc.property(fc.jsonValue({ maxDepth: 4 }), (value) => {
    for (const schema of schemas) {
      const result = schema.safeParse(value);
      expect(typeof result.success).toBe("boolean");
      if (result.success) {
        expect(schema.safeParse(result.data).success).toBe(true);
        expect(schema.parse(result.data)).toEqual(result.data);
      }
    }
  }), { seed: 4804143, numRuns: 200 });
});
