import { createHash } from "node:crypto";

import { describe, expect, test } from "bun:test";
import type { ZodType } from "zod";

import {
  mutationEffectEvidence49Schema,
  queueEffectEvidence49Schema,
} from "./effect-evidence-codecs";

// Synthetic schema-history preimages captured from the pure archived schemas,
// not authentic effect receipts or evidence of provider/native acceptance.
// Source revision: 0ae317793d5ff694b4d333effe25f85f7e7f1491
// Only seven named schema declarations were extracted from StateStore with
// TypeScript's AST; the StateStore module was never imported or executed.
// Their original pure domain dependencies were evaluated from the same Git
// revision. No database, provider, filesystem effect or current parser produced
// these expected JSON strings/hashes. All account IDs and digests are synthetic.
// Bun 1.3.14; Zod 4.4.3; TypeScript 5.9.2 (extraction only).
// src/storage/state-store.ts: ca0dea1d88cc81f1d03f99bced0dea9fcfaab2ff3f2a5d756d3cf4d1c658c3ca
// src/domain/runtime-profile.ts: 10eb575dbde914ce4c5a408a3836c5264122c0ea3aa91f8f615b2c8977097076
// src/domain/presets.ts: 60c83135e15858462f87f4b09f96eb91675492357729202b63446e8b86145f56
// src/domain/values.ts: e0bbef6d7f8120027eee9490ff03abaf63fbe67606733b240da42bf5fcf2a347
// src/domain/session-tasks.ts: 8d0b45c3f9aaa0112638d8891de0658c676fef9aff101f3a1ec2ef6ed82d97c1
// Extracted declarations SHA-256: 63db11eb819315e5cd5269454764154f91c22d6495302dd077d563fcaae57d39
// Armed Claude fallback is readable history only, not live acceptance.
const fixtures = [
  {
    name: "send without runtime profile",
    codec: "mutation",
    kind: "session.send",
    json: "{\"kind\":\"session.send\",\"providerThreadId\":\"synthetic-thread\",\"baseline\":{\"providerUpdatedAt\":1700000000,\"status\":\"active\",\"activeTurnId\":\"synthetic-turn\"},\"clientMessageId\":\"synthetic-message\",\"messageDigest\":\"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\"}",
    sha256: "02f842352a893c18ffe1fc6dc08ca86b6a417c67e8d0ea451b9003476160a266",
  },
  {
    name: "send with codex runtime profile",
    codec: "mutation",
    kind: "session.send",
    json: "{\"kind\":\"session.send\",\"providerThreadId\":\"synthetic-thread\",\"baseline\":{\"providerUpdatedAt\":1700000000,\"status\":\"active\",\"activeTurnId\":\"synthetic-turn\"},\"clientMessageId\":\"synthetic-message\",\"messageDigest\":\"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\",\"runtimeProfile\":{\"profileId\":\"acct_11111111111111111111111111111111\",\"processGeneration\":3,\"observedAt\":1700000000000,\"preset\":\"high\",\"model\":\"gpt-5.6-sol\",\"reasoningEffort\":\"max\",\"serviceTier\":null,\"fast\":false,\"approvalPolicy\":\"on-request\",\"reviewMode\":\"auto_review\",\"permissionProfile\":\":workspace\",\"computerUse\":true,\"pluginCapability\":true,\"enabledApps\":[]}}",
    sha256: "9d8b743fba5f7fc85c9d9edc2b7b536e5bb65ad0a0eecb8be48b27fd6f4329a6",
  },
  {
    name: "send with claude runtime profile",
    codec: "mutation",
    kind: "session.send",
    json: "{\"kind\":\"session.send\",\"providerThreadId\":\"synthetic-thread\",\"baseline\":{\"providerUpdatedAt\":1700000000,\"status\":\"active\",\"activeTurnId\":\"synthetic-turn\"},\"clientMessageId\":\"synthetic-message\",\"messageDigest\":\"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\",\"runtimeProfile\":{\"profileId\":\"acct_11111111111111111111111111111111\",\"processGeneration\":3,\"observedAt\":1700000000000,\"preset\":\"fable-max\",\"model\":\"claude-fable-5-1\",\"reasoningEffort\":\"max\",\"claudeVersion\":\"2.1.260\",\"permissionMode\":\"default\",\"isolatedConfigDir\":true,\"outputFormat\":\"stream-json\",\"inputFormat\":\"stream-json\",\"nativeFallback\":{\"evidenceDigest\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"model\":\"claude-opus-5\",\"status\":\"armed\"}}}",
    sha256: "0253cb3eed11c183ba2be1d1d5e5ef376394d8a9b4290a0317c7f5643fd696d5",
  },
  {
    name: "send with devin runtime profile",
    codec: "mutation",
    kind: "session.send",
    json: "{\"kind\":\"session.send\",\"providerThreadId\":\"synthetic-thread\",\"baseline\":{\"providerUpdatedAt\":1700000000,\"status\":\"active\",\"activeTurnId\":\"synthetic-turn\"},\"clientMessageId\":\"synthetic-message\",\"messageDigest\":\"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\",\"runtimeProfile\":{\"profileId\":\"acct_11111111111111111111111111111111\",\"processGeneration\":3,\"observedAt\":1700000000000,\"preset\":\"astra\",\"model\":\"gpt-6-astra\",\"reasoningEffort\":\"provider-default\",\"devinVersion\":\"3000.6.14\",\"protocolVersion\":1,\"isolatedHome\":true}}",
    sha256: "72af8dc63a9865336e08e80585363994165d38ff0b962dc4601e705b9eff6efe",
  },
  {
    name: "steer with known turn",
    codec: "mutation",
    kind: "session.steer",
    json: "{\"kind\":\"session.steer\",\"providerThreadId\":\"synthetic-thread\",\"baseline\":{\"providerUpdatedAt\":1700000000,\"status\":\"active\",\"activeTurnId\":\"synthetic-turn\"},\"activeTurnId\":\"synthetic-turn\",\"clientMessageId\":\"synthetic-message\",\"messageDigest\":\"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\"}",
    sha256: "05eb185227eac9d1727e5e5b5ccc3ea7f9ebbdbafaff0bc308bd439c4a1e17e0",
  },
  {
    name: "stop with known turn",
    codec: "mutation",
    kind: "session.stop",
    json: "{\"kind\":\"session.stop\",\"providerThreadId\":\"synthetic-thread\",\"baseline\":{\"providerUpdatedAt\":1700000000,\"status\":\"active\",\"activeTurnId\":\"synthetic-turn\"},\"activeTurnId\":\"synthetic-turn\"}",
    sha256: "eb19d75d5713b789f493f27032886109ec9409ceb4e0c8c86b56c5714c4d4275",
  },
  {
    name: "steer with null turn",
    codec: "mutation",
    kind: "session.steer",
    json: "{\"kind\":\"session.steer\",\"providerThreadId\":\"synthetic-thread\",\"baseline\":{\"providerUpdatedAt\":1700000000,\"status\":\"active\",\"activeTurnId\":\"synthetic-turn\"},\"activeTurnId\":null,\"clientMessageId\":\"synthetic-message\",\"messageDigest\":\"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\"}",
    sha256: "b07e7ed4112f633d42c7b61eb02f9a12581187ec4f89bd4c31f9d0505392e6a9",
  },
  {
    name: "stop with null turn",
    codec: "mutation",
    kind: "session.stop",
    json: "{\"kind\":\"session.stop\",\"providerThreadId\":\"synthetic-thread\",\"baseline\":{\"providerUpdatedAt\":1700000000,\"status\":\"active\",\"activeTurnId\":\"synthetic-turn\"},\"activeTurnId\":null}",
    sha256: "d422aeb24449f262eab9c0804bc7e38b7e46adb97688b3ec24af9cb8c595d1fa",
  },
  {
    name: "rename",
    codec: "mutation",
    kind: "session.rename",
    json: "{\"kind\":\"session.rename\",\"providerThreadId\":\"synthetic-thread\",\"baseline\":{\"providerUpdatedAt\":1700000000,\"status\":\"active\",\"activeTurnId\":\"synthetic-turn\"},\"requestedName\":\"Synthetic name\"}",
    sha256: "a589e6c6ca8eb65bade2459b47f195446f06da49b514b61f317be4124612448e",
  },
  {
    name: "start with absent runtime and absent automation",
    codec: "mutation",
    kind: "session.start",
    json: "{\"kind\":\"session.start\",\"projectId\":\"proj_22222222222222222222222222222222\",\"clientMessageId\":null,\"messageDigest\":null}",
    sha256: "af0f31f69122dc49ac44ba855505bb4d0074fe2c4e0d911df5592210f40ebc76",
  },
  {
    name: "start with absent runtime and present automation",
    codec: "mutation",
    kind: "session.start",
    json: "{\"kind\":\"session.start\",\"projectId\":\"proj_22222222222222222222222222222222\",\"clientMessageId\":null,\"messageDigest\":null,\"conversationAutomationCapability\":\"hra.automation_update.v1\"}",
    sha256: "376faaf19dac7dd5f02c625b579266916db8e46165f4d7b2534e7cd3d8680cd7",
  },
  {
    name: "start with codex runtime and absent automation",
    codec: "mutation",
    kind: "session.start",
    json: "{\"kind\":\"session.start\",\"projectId\":\"proj_22222222222222222222222222222222\",\"clientMessageId\":\"synthetic-message\",\"messageDigest\":\"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\",\"runtimeProfile\":{\"profileId\":\"acct_11111111111111111111111111111111\",\"processGeneration\":3,\"observedAt\":1700000000000,\"preset\":\"high\",\"model\":\"gpt-5.6-sol\",\"reasoningEffort\":\"max\",\"serviceTier\":null,\"fast\":false,\"approvalPolicy\":\"on-request\",\"reviewMode\":\"auto_review\",\"permissionProfile\":\":workspace\",\"computerUse\":true,\"pluginCapability\":true,\"enabledApps\":[]}}",
    sha256: "2e45ae0f35f8848c4ca3ad47f1f85b5bdecebb0912a90a61513a2a011da0acb7",
  },
  {
    name: "start with codex runtime and present automation",
    codec: "mutation",
    kind: "session.start",
    json: "{\"kind\":\"session.start\",\"projectId\":\"proj_22222222222222222222222222222222\",\"clientMessageId\":\"synthetic-message\",\"messageDigest\":\"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\",\"runtimeProfile\":{\"profileId\":\"acct_11111111111111111111111111111111\",\"processGeneration\":3,\"observedAt\":1700000000000,\"preset\":\"high\",\"model\":\"gpt-5.6-sol\",\"reasoningEffort\":\"max\",\"serviceTier\":null,\"fast\":false,\"approvalPolicy\":\"on-request\",\"reviewMode\":\"auto_review\",\"permissionProfile\":\":workspace\",\"computerUse\":true,\"pluginCapability\":true,\"enabledApps\":[]},\"conversationAutomationCapability\":\"hra.automation_update.v1\"}",
    sha256: "95a303fad467d89537984af8e12b0190d254230b7399a8b6be354e4df2efb872",
  },
  {
    name: "start with claude runtime and absent automation",
    codec: "mutation",
    kind: "session.start",
    json: "{\"kind\":\"session.start\",\"projectId\":\"proj_22222222222222222222222222222222\",\"clientMessageId\":\"synthetic-message\",\"messageDigest\":\"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\",\"runtimeProfile\":{\"profileId\":\"acct_11111111111111111111111111111111\",\"processGeneration\":3,\"observedAt\":1700000000000,\"preset\":\"fable-max\",\"model\":\"claude-fable-5-1\",\"reasoningEffort\":\"max\",\"claudeVersion\":\"2.1.260\",\"permissionMode\":\"default\",\"isolatedConfigDir\":true,\"outputFormat\":\"stream-json\",\"inputFormat\":\"stream-json\",\"nativeFallback\":{\"evidenceDigest\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"model\":\"claude-opus-5\",\"status\":\"armed\"}}}",
    sha256: "1d65a7b9d02e3ec04f0876b37307b28d5aa9062ac4b66d901daa7e2e53b615c2",
  },
  {
    name: "start with claude runtime and present automation",
    codec: "mutation",
    kind: "session.start",
    json: "{\"kind\":\"session.start\",\"projectId\":\"proj_22222222222222222222222222222222\",\"clientMessageId\":\"synthetic-message\",\"messageDigest\":\"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\",\"runtimeProfile\":{\"profileId\":\"acct_11111111111111111111111111111111\",\"processGeneration\":3,\"observedAt\":1700000000000,\"preset\":\"fable-max\",\"model\":\"claude-fable-5-1\",\"reasoningEffort\":\"max\",\"claudeVersion\":\"2.1.260\",\"permissionMode\":\"default\",\"isolatedConfigDir\":true,\"outputFormat\":\"stream-json\",\"inputFormat\":\"stream-json\",\"nativeFallback\":{\"evidenceDigest\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"model\":\"claude-opus-5\",\"status\":\"armed\"}},\"conversationAutomationCapability\":\"hra.automation_update.v1\"}",
    sha256: "2bba1a3fa9f1b761dc51ca0da61d2fc4eeda5c3e0c71b07a27170773bef329f6",
  },
  {
    name: "start with devin runtime and absent automation",
    codec: "mutation",
    kind: "session.start",
    json: "{\"kind\":\"session.start\",\"projectId\":\"proj_22222222222222222222222222222222\",\"clientMessageId\":\"synthetic-message\",\"messageDigest\":\"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\",\"runtimeProfile\":{\"profileId\":\"acct_11111111111111111111111111111111\",\"processGeneration\":3,\"observedAt\":1700000000000,\"preset\":\"astra\",\"model\":\"gpt-6-astra\",\"reasoningEffort\":\"provider-default\",\"devinVersion\":\"3000.6.14\",\"protocolVersion\":1,\"isolatedHome\":true}}",
    sha256: "5a0ecbcb0925735492451744e13ba091d1ebdc94038b4eea3cf2b70c0c43fb93",
  },
  {
    name: "start with devin runtime and present automation",
    codec: "mutation",
    kind: "session.start",
    json: "{\"kind\":\"session.start\",\"projectId\":\"proj_22222222222222222222222222222222\",\"clientMessageId\":\"synthetic-message\",\"messageDigest\":\"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\",\"runtimeProfile\":{\"profileId\":\"acct_11111111111111111111111111111111\",\"processGeneration\":3,\"observedAt\":1700000000000,\"preset\":\"astra\",\"model\":\"gpt-6-astra\",\"reasoningEffort\":\"provider-default\",\"devinVersion\":\"3000.6.14\",\"protocolVersion\":1,\"isolatedHome\":true},\"conversationAutomationCapability\":\"hra.automation_update.v1\"}",
    sha256: "e7eda8bf4ff9cd21df6f0cc6e093c274998dfd9b7dc446d5eca0ca21baf691b4",
  },
  {
    name: "switch to codex daemon false account key false",
    codec: "mutation",
    kind: "session.switch",
    json: "{\"kind\":\"session.switch\",\"requestedAccountId\":null,\"requestedPreset\":null,\"sourceProfileId\":\"acct_00000000000000000000000000000000\",\"sourceProcessGeneration\":2,\"sourceProvider\":\"codex\",\"sourceProviderThreadId\":\"synthetic-source-thread\",\"sourcePreset\":\"high\",\"targetProfileId\":\"acct_11111111111111111111111111111111\",\"targetProcessGeneration\":3,\"targetProvider\":\"codex\",\"targetPreset\":\"high\",\"transcriptDigest\":\"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc\",\"seedDigest\":\"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd\",\"seedIncludedRecords\":1,\"seedOmittedRecords\":0,\"runtimeProfile\":{\"profileId\":\"acct_11111111111111111111111111111111\",\"processGeneration\":3,\"observedAt\":1700000000000,\"preset\":\"high\",\"model\":\"gpt-5.6-sol\",\"reasoningEffort\":\"max\",\"serviceTier\":null,\"fast\":false,\"approvalPolicy\":\"on-request\",\"reviewMode\":\"auto_review\",\"permissionProfile\":\":workspace\",\"computerUse\":true,\"pluginCapability\":true,\"enabledApps\":[]}}",
    sha256: "9957ae4088456966bc411cb5059cb79a6b9dc3d91be6aa96e841c63676739c59",
  },
  {
    name: "switch to codex daemon false account key true",
    codec: "mutation",
    kind: "session.switch",
    json: "{\"kind\":\"session.switch\",\"requestedAccountId\":\"acct_11111111111111111111111111111111\",\"requestedPreset\":\"high\",\"sourceProfileId\":\"acct_00000000000000000000000000000000\",\"sourceProcessGeneration\":2,\"sourceProvider\":\"codex\",\"sourceProviderThreadId\":\"synthetic-source-thread\",\"sourcePreset\":\"high\",\"targetProfileId\":\"acct_11111111111111111111111111111111\",\"targetProcessGeneration\":3,\"targetProvider\":\"codex\",\"targetProviderAccountKey\":\"v1:codex:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc\",\"targetPreset\":\"high\",\"transcriptDigest\":\"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc\",\"seedDigest\":\"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd\",\"seedIncludedRecords\":1,\"seedOmittedRecords\":0,\"runtimeProfile\":{\"profileId\":\"acct_11111111111111111111111111111111\",\"processGeneration\":3,\"observedAt\":1700000000000,\"preset\":\"high\",\"model\":\"gpt-5.6-sol\",\"reasoningEffort\":\"max\",\"serviceTier\":null,\"fast\":false,\"approvalPolicy\":\"on-request\",\"reviewMode\":\"auto_review\",\"permissionProfile\":\":workspace\",\"computerUse\":true,\"pluginCapability\":true,\"enabledApps\":[]}}",
    sha256: "8fbd8c5d1485a683ff6574c948273202eb94fa0519f4bb195bf1ce1c0e492623",
  },
  {
    name: "switch to codex daemon true account key false",
    codec: "mutation",
    kind: "session.switch",
    json: "{\"kind\":\"session.switch\",\"daemonGeneration\":9,\"requestedAccountId\":null,\"requestedPreset\":null,\"sourceProfileId\":\"acct_00000000000000000000000000000000\",\"sourceProcessGeneration\":2,\"sourceProvider\":\"codex\",\"sourceProviderThreadId\":\"synthetic-source-thread\",\"sourcePreset\":\"high\",\"targetProfileId\":\"acct_11111111111111111111111111111111\",\"targetProcessGeneration\":3,\"targetProvider\":\"codex\",\"targetPreset\":\"high\",\"transcriptDigest\":\"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc\",\"seedDigest\":\"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd\",\"seedIncludedRecords\":1,\"seedOmittedRecords\":0,\"runtimeProfile\":{\"profileId\":\"acct_11111111111111111111111111111111\",\"processGeneration\":3,\"observedAt\":1700000000000,\"preset\":\"high\",\"model\":\"gpt-5.6-sol\",\"reasoningEffort\":\"max\",\"serviceTier\":null,\"fast\":false,\"approvalPolicy\":\"on-request\",\"reviewMode\":\"auto_review\",\"permissionProfile\":\":workspace\",\"computerUse\":true,\"pluginCapability\":true,\"enabledApps\":[]}}",
    sha256: "3a7397ffa5627b58c0f1bf6b8dbbd0e05dfe5cb03005edd829397ceda0d3d734",
  },
  {
    name: "switch to codex daemon true account key true",
    codec: "mutation",
    kind: "session.switch",
    json: "{\"kind\":\"session.switch\",\"daemonGeneration\":9,\"requestedAccountId\":\"acct_11111111111111111111111111111111\",\"requestedPreset\":\"high\",\"sourceProfileId\":\"acct_00000000000000000000000000000000\",\"sourceProcessGeneration\":2,\"sourceProvider\":\"codex\",\"sourceProviderThreadId\":\"synthetic-source-thread\",\"sourcePreset\":\"high\",\"targetProfileId\":\"acct_11111111111111111111111111111111\",\"targetProcessGeneration\":3,\"targetProvider\":\"codex\",\"targetProviderAccountKey\":\"v1:codex:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc\",\"targetPreset\":\"high\",\"transcriptDigest\":\"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc\",\"seedDigest\":\"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd\",\"seedIncludedRecords\":1,\"seedOmittedRecords\":0,\"runtimeProfile\":{\"profileId\":\"acct_11111111111111111111111111111111\",\"processGeneration\":3,\"observedAt\":1700000000000,\"preset\":\"high\",\"model\":\"gpt-5.6-sol\",\"reasoningEffort\":\"max\",\"serviceTier\":null,\"fast\":false,\"approvalPolicy\":\"on-request\",\"reviewMode\":\"auto_review\",\"permissionProfile\":\":workspace\",\"computerUse\":true,\"pluginCapability\":true,\"enabledApps\":[]}}",
    sha256: "c9fd3c808504f712e46f63c428b04b501313cf7625b26a3a140a5d8180440564",
  },
  {
    name: "switch to claude daemon false account key false",
    codec: "mutation",
    kind: "session.switch",
    json: "{\"kind\":\"session.switch\",\"requestedAccountId\":null,\"requestedPreset\":null,\"sourceProfileId\":\"acct_00000000000000000000000000000000\",\"sourceProcessGeneration\":2,\"sourceProvider\":\"codex\",\"sourceProviderThreadId\":\"synthetic-source-thread\",\"sourcePreset\":\"high\",\"targetProfileId\":\"acct_11111111111111111111111111111111\",\"targetProcessGeneration\":3,\"targetProvider\":\"claude\",\"targetPreset\":\"fable-max\",\"transcriptDigest\":\"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc\",\"seedDigest\":\"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd\",\"seedIncludedRecords\":1,\"seedOmittedRecords\":0,\"runtimeProfile\":{\"profileId\":\"acct_11111111111111111111111111111111\",\"processGeneration\":3,\"observedAt\":1700000000000,\"preset\":\"fable-max\",\"model\":\"claude-fable-5-1\",\"reasoningEffort\":\"max\",\"claudeVersion\":\"2.1.260\",\"permissionMode\":\"default\",\"isolatedConfigDir\":true,\"outputFormat\":\"stream-json\",\"inputFormat\":\"stream-json\",\"nativeFallback\":{\"evidenceDigest\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"model\":\"claude-opus-5\",\"status\":\"armed\"}}}",
    sha256: "72b9547d17abc363317bcd953040d119c38dadfaba34176506bb263ec82ee19f",
  },
  {
    name: "switch to claude daemon false account key true",
    codec: "mutation",
    kind: "session.switch",
    json: "{\"kind\":\"session.switch\",\"requestedAccountId\":\"acct_11111111111111111111111111111111\",\"requestedPreset\":\"fable-max\",\"sourceProfileId\":\"acct_00000000000000000000000000000000\",\"sourceProcessGeneration\":2,\"sourceProvider\":\"codex\",\"sourceProviderThreadId\":\"synthetic-source-thread\",\"sourcePreset\":\"high\",\"targetProfileId\":\"acct_11111111111111111111111111111111\",\"targetProcessGeneration\":3,\"targetProvider\":\"claude\",\"targetProviderAccountKey\":\"v1:claude:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc\",\"targetPreset\":\"fable-max\",\"transcriptDigest\":\"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc\",\"seedDigest\":\"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd\",\"seedIncludedRecords\":1,\"seedOmittedRecords\":0,\"runtimeProfile\":{\"profileId\":\"acct_11111111111111111111111111111111\",\"processGeneration\":3,\"observedAt\":1700000000000,\"preset\":\"fable-max\",\"model\":\"claude-fable-5-1\",\"reasoningEffort\":\"max\",\"claudeVersion\":\"2.1.260\",\"permissionMode\":\"default\",\"isolatedConfigDir\":true,\"outputFormat\":\"stream-json\",\"inputFormat\":\"stream-json\",\"nativeFallback\":{\"evidenceDigest\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"model\":\"claude-opus-5\",\"status\":\"armed\"}}}",
    sha256: "5e1c58ca7f3874feda91dcc983f2641c254037372db356c10fabdfeb9dd3a7e8",
  },
  {
    name: "switch to claude daemon true account key false",
    codec: "mutation",
    kind: "session.switch",
    json: "{\"kind\":\"session.switch\",\"daemonGeneration\":9,\"requestedAccountId\":null,\"requestedPreset\":null,\"sourceProfileId\":\"acct_00000000000000000000000000000000\",\"sourceProcessGeneration\":2,\"sourceProvider\":\"codex\",\"sourceProviderThreadId\":\"synthetic-source-thread\",\"sourcePreset\":\"high\",\"targetProfileId\":\"acct_11111111111111111111111111111111\",\"targetProcessGeneration\":3,\"targetProvider\":\"claude\",\"targetPreset\":\"fable-max\",\"transcriptDigest\":\"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc\",\"seedDigest\":\"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd\",\"seedIncludedRecords\":1,\"seedOmittedRecords\":0,\"runtimeProfile\":{\"profileId\":\"acct_11111111111111111111111111111111\",\"processGeneration\":3,\"observedAt\":1700000000000,\"preset\":\"fable-max\",\"model\":\"claude-fable-5-1\",\"reasoningEffort\":\"max\",\"claudeVersion\":\"2.1.260\",\"permissionMode\":\"default\",\"isolatedConfigDir\":true,\"outputFormat\":\"stream-json\",\"inputFormat\":\"stream-json\",\"nativeFallback\":{\"evidenceDigest\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"model\":\"claude-opus-5\",\"status\":\"armed\"}}}",
    sha256: "4b349d8d44cb56ed12801431859a7b6821812c378e1b30eb516ab28e64512a72",
  },
  {
    name: "switch to claude daemon true account key true",
    codec: "mutation",
    kind: "session.switch",
    json: "{\"kind\":\"session.switch\",\"daemonGeneration\":9,\"requestedAccountId\":\"acct_11111111111111111111111111111111\",\"requestedPreset\":\"fable-max\",\"sourceProfileId\":\"acct_00000000000000000000000000000000\",\"sourceProcessGeneration\":2,\"sourceProvider\":\"codex\",\"sourceProviderThreadId\":\"synthetic-source-thread\",\"sourcePreset\":\"high\",\"targetProfileId\":\"acct_11111111111111111111111111111111\",\"targetProcessGeneration\":3,\"targetProvider\":\"claude\",\"targetProviderAccountKey\":\"v1:claude:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc\",\"targetPreset\":\"fable-max\",\"transcriptDigest\":\"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc\",\"seedDigest\":\"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd\",\"seedIncludedRecords\":1,\"seedOmittedRecords\":0,\"runtimeProfile\":{\"profileId\":\"acct_11111111111111111111111111111111\",\"processGeneration\":3,\"observedAt\":1700000000000,\"preset\":\"fable-max\",\"model\":\"claude-fable-5-1\",\"reasoningEffort\":\"max\",\"claudeVersion\":\"2.1.260\",\"permissionMode\":\"default\",\"isolatedConfigDir\":true,\"outputFormat\":\"stream-json\",\"inputFormat\":\"stream-json\",\"nativeFallback\":{\"evidenceDigest\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"model\":\"claude-opus-5\",\"status\":\"armed\"}}}",
    sha256: "afc3c79a0b56e8ea6c9699f386c474d2bb63f2198ee0efc4feee5ca2c8c227fd",
  },
  {
    name: "switch to devin daemon false account key false",
    codec: "mutation",
    kind: "session.switch",
    json: "{\"kind\":\"session.switch\",\"requestedAccountId\":null,\"requestedPreset\":null,\"sourceProfileId\":\"acct_00000000000000000000000000000000\",\"sourceProcessGeneration\":2,\"sourceProvider\":\"codex\",\"sourceProviderThreadId\":\"synthetic-source-thread\",\"sourcePreset\":\"high\",\"targetProfileId\":\"acct_11111111111111111111111111111111\",\"targetProcessGeneration\":3,\"targetProvider\":\"devin\",\"targetPreset\":\"astra\",\"transcriptDigest\":\"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc\",\"seedDigest\":\"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd\",\"seedIncludedRecords\":1,\"seedOmittedRecords\":0,\"runtimeProfile\":{\"profileId\":\"acct_11111111111111111111111111111111\",\"processGeneration\":3,\"observedAt\":1700000000000,\"preset\":\"astra\",\"model\":\"gpt-6-astra\",\"reasoningEffort\":\"provider-default\",\"devinVersion\":\"3000.6.14\",\"protocolVersion\":1,\"isolatedHome\":true}}",
    sha256: "887582e6a07f84c2dc1e378814da505e90367123277972b3cf0fa2c6c9f785ed",
  },
  {
    name: "switch to devin daemon true account key false",
    codec: "mutation",
    kind: "session.switch",
    json: "{\"kind\":\"session.switch\",\"daemonGeneration\":9,\"requestedAccountId\":null,\"requestedPreset\":null,\"sourceProfileId\":\"acct_00000000000000000000000000000000\",\"sourceProcessGeneration\":2,\"sourceProvider\":\"codex\",\"sourceProviderThreadId\":\"synthetic-source-thread\",\"sourcePreset\":\"high\",\"targetProfileId\":\"acct_11111111111111111111111111111111\",\"targetProcessGeneration\":3,\"targetProvider\":\"devin\",\"targetPreset\":\"astra\",\"transcriptDigest\":\"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc\",\"seedDigest\":\"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd\",\"seedIncludedRecords\":1,\"seedOmittedRecords\":0,\"runtimeProfile\":{\"profileId\":\"acct_11111111111111111111111111111111\",\"processGeneration\":3,\"observedAt\":1700000000000,\"preset\":\"astra\",\"model\":\"gpt-6-astra\",\"reasoningEffort\":\"provider-default\",\"devinVersion\":\"3000.6.14\",\"protocolVersion\":1,\"isolatedHome\":true}}",
    sha256: "ae4939e6b59667ab8a0dca26baa3ab61ec07a9bb28f24ab012adb182491273af",
  },
  {
    name: "browser login",
    codec: "mutation",
    kind: "account.login",
    json: "{\"kind\":\"account.login\",\"method\":\"browser\"}",
    sha256: "c20652370ba62e0abe84bed6d62178354ba704d8d9284e0b21ab357c81aa54c1",
  },
  {
    name: "device code login",
    codec: "mutation",
    kind: "account.login",
    json: "{\"kind\":\"account.login\",\"method\":\"device_code\"}",
    sha256: "dc4291e93544d14b3fcf8dea54a811dce603466a361211c361269a5fb54a865f",
  },
  {
    name: "Claude login",
    codec: "mutation",
    kind: "account.claude-login",
    json: "{\"kind\":\"account.claude-login\",\"provider\":\"claude\",\"baselineSignedIn\":false}",
    sha256: "9800323eb0ebc24a963bf618ca360477c8190d459e64ffceb39f1a88f0d20edf",
  },
  {
    name: "Devin login",
    codec: "mutation",
    kind: "account.devin-login",
    json: "{\"kind\":\"account.devin-login\",\"provider\":\"devin\",\"baselineSignedIn\":false}",
    sha256: "2476e8f4eb506499ef2768c2dab661198e6e2b63db62edaabd9da7ae01e93252",
  },
  {
    name: "signed-in logout",
    codec: "mutation",
    kind: "account.logout",
    json: "{\"kind\":\"account.logout\",\"baselineSignedIn\":true}",
    sha256: "fd57bf63698409131b0d21ec97b1cf96aa42728578a36e605e2f420ba79bde8c",
  },
  {
    name: "signed-out logout",
    codec: "mutation",
    kind: "account.logout",
    json: "{\"kind\":\"account.logout\",\"baselineSignedIn\":false}",
    sha256: "9dc4be08d4eb6f9ea753c0c577337a23edb638d6b678a2c64a32537d97f8c158",
  },
  {
    name: "login cancel",
    codec: "mutation",
    kind: "account.login-cancel",
    json: "{\"kind\":\"account.login-cancel\",\"loginId\":\"synthetic-login\"}",
    sha256: "127a77bbab7af70167d1f8f6f2e8d8d38273f759d267811ccdeb9ab65c055dc1",
  },
  {
    name: "queue dispatch with codex runtime",
    codec: "queue",
    kind: "queue.dispatch",
    json: "{\"kind\":\"queue.dispatch\",\"queueId\":\"queue_33333333333333333333333333333333\",\"sessionId\":\"sess_44444444444444444444444444444444\",\"providerThreadId\":\"synthetic-thread\",\"profileGeneration\":3,\"baseline\":{\"providerUpdatedAt\":1700000000,\"status\":\"active\",\"activeTurnId\":\"synthetic-turn\"},\"clientMessageId\":\"synthetic-message\",\"messageDigest\":\"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\",\"runtimeProfile\":{\"profileId\":\"acct_11111111111111111111111111111111\",\"processGeneration\":3,\"observedAt\":1700000000000,\"preset\":\"high\",\"model\":\"gpt-5.6-sol\",\"reasoningEffort\":\"max\",\"serviceTier\":null,\"fast\":false,\"approvalPolicy\":\"on-request\",\"reviewMode\":\"auto_review\",\"permissionProfile\":\":workspace\",\"computerUse\":true,\"pluginCapability\":true,\"enabledApps\":[]}}",
    sha256: "f27a090254dd7bcb997f725fb7692c2fcc4a9f70187c6a5a919adee29a436e9f",
  },
  {
    name: "queue dispatch with claude runtime",
    codec: "queue",
    kind: "queue.dispatch",
    json: "{\"kind\":\"queue.dispatch\",\"queueId\":\"queue_33333333333333333333333333333333\",\"sessionId\":\"sess_44444444444444444444444444444444\",\"providerThreadId\":\"synthetic-thread\",\"profileGeneration\":3,\"baseline\":{\"providerUpdatedAt\":1700000000,\"status\":\"active\",\"activeTurnId\":\"synthetic-turn\"},\"clientMessageId\":\"synthetic-message\",\"messageDigest\":\"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\",\"runtimeProfile\":{\"profileId\":\"acct_11111111111111111111111111111111\",\"processGeneration\":3,\"observedAt\":1700000000000,\"preset\":\"fable-max\",\"model\":\"claude-fable-5-1\",\"reasoningEffort\":\"max\",\"claudeVersion\":\"2.1.260\",\"permissionMode\":\"default\",\"isolatedConfigDir\":true,\"outputFormat\":\"stream-json\",\"inputFormat\":\"stream-json\",\"nativeFallback\":{\"evidenceDigest\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"model\":\"claude-opus-5\",\"status\":\"armed\"}}}",
    sha256: "33856e7d3e5769183fecd8b0df3e4168d051b343fa5061bed45928cf9959cb3a",
  },
  {
    name: "queue dispatch with devin runtime",
    codec: "queue",
    kind: "queue.dispatch",
    json: "{\"kind\":\"queue.dispatch\",\"queueId\":\"queue_33333333333333333333333333333333\",\"sessionId\":\"sess_44444444444444444444444444444444\",\"providerThreadId\":\"synthetic-thread\",\"profileGeneration\":3,\"baseline\":{\"providerUpdatedAt\":1700000000,\"status\":\"active\",\"activeTurnId\":\"synthetic-turn\"},\"clientMessageId\":\"synthetic-message\",\"messageDigest\":\"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\",\"runtimeProfile\":{\"profileId\":\"acct_11111111111111111111111111111111\",\"processGeneration\":3,\"observedAt\":1700000000000,\"preset\":\"astra\",\"model\":\"gpt-6-astra\",\"reasoningEffort\":\"provider-default\",\"devinVersion\":\"3000.6.14\",\"protocolVersion\":1,\"isolatedHome\":true}}",
    sha256: "7a7f3f81485ba46355dde939b73f6051ed379b742de60eb2d40e945fc240ed1f",
  },
] as const;

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

// Reorder object keys recursively without changing array or scalar values.
const reverseObjectKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(reverseObjectKeys);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).reverse()
      .map(([key, item]) => [key, reverseObjectKeys(item)]));
  }
  return value;
};

const expectUnknownFieldRejected = (
  schema: ZodType,
  input: unknown,
  field: string,
  path: readonly string[] = [],
): void => {
  const result = schema.safeParse(input);
  expect(result.success).toBe(false);
  if (result.success) throw new Error("A historical codec admitted an unknown field.");
  expect(result.error.issues.some((issue) =>
    issue.code === "unrecognized_keys"
    && issue.keys.includes(field)
    && JSON.stringify(issue.path) === JSON.stringify(path))).toBe(true);
};

describe("combined49 effect-evidence canonical JSON history", () => {
  test("covers every archived mutation kind and queue dispatch", () => {
    expect([...new Set(fixtures.filter((fixture) => fixture.codec === "mutation")
      .map((fixture) => fixture.kind))].sort()).toEqual([
      "account.claude-login", "account.devin-login", "account.login",
      "account.login-cancel", "account.logout", "session.rename", "session.send",
      "session.start", "session.steer", "session.stop", "session.switch",
    ]);
    expect(fixtures.filter((fixture) => fixture.codec === "queue").map((fixture) => fixture.kind))
      .toEqual(["queue.dispatch", "queue.dispatch", "queue.dispatch"]);
  });

  for (const fixture of fixtures) {
    test(`preserves ${fixture.name} without defaults or JSON rewrites`, () => {
      const input: unknown = JSON.parse(fixture.json);
      const schema = fixture.codec === "queue" ? queueEffectEvidence49Schema : mutationEffectEvidence49Schema;
      const parsed = schema.parse(input);
      expect(sha256(fixture.json)).toBe(fixture.sha256);
      expect(parsed.kind).toBe(fixture.kind);
      expect(JSON.stringify(parsed)).toBe(fixture.json);
      expect(sha256(JSON.stringify(parsed))).toBe(fixture.sha256);
      expect(JSON.stringify(input)).toBe(fixture.json);
      expectUnknownFieldRejected(schema, { ...parsed, unexpected: true }, "unexpected");

      const reversed = reverseObjectKeys(input);
      const reversedJson = JSON.stringify(reversed);
      expect(reversedJson).not.toBe(fixture.json);
      const canonical = schema.parse(reversed);
      expect(JSON.stringify(canonical)).toBe(fixture.json);
      expect(sha256(JSON.stringify(canonical))).toBe(fixture.sha256);
      expect(JSON.stringify(reversed)).toBe(reversedJson);
    });
  }
});

describe("combined49 effect-evidence extension boundaries", () => {
  for (const fixture of fixtures) {
    if (fixture.kind === "session.stop" || fixture.kind === "session.rename") {
      test(`rejects later timestamp-unit fields in ${fixture.name}`, () => {
        const input = mutationEffectEvidence49Schema.parse(JSON.parse(fixture.json));
        if (!("baseline" in input)) throw new Error("Expected historical provider baseline.");
        for (const providerTimestampUnit of ["milliseconds", "unix_milliseconds_v1"]) {
          expectUnknownFieldRejected(mutationEffectEvidence49Schema, {
            ...input, providerTimestampUnit,
          }, "providerTimestampUnit");
          expectUnknownFieldRejected(mutationEffectEvidence49Schema, {
            ...input, baseline: { ...input.baseline, providerTimestampUnit },
          }, "providerTimestampUnit", ["baseline"]);
        }
      });
    }
    if (fixture.kind === "session.send" || fixture.kind === "session.steer") {
      test(`rejects later message actors in ${fixture.name}`, () => {
        const input = mutationEffectEvidence49Schema.parse(JSON.parse(fixture.json));
        for (const messageActor of [{ kind: "peer" }, "peer_session"]) {
          expectUnknownFieldRejected(mutationEffectEvidence49Schema, {
            ...input, messageActor,
          }, "messageActor");
        }
      });
    }
    if (fixture.kind === "session.switch") {
      test(`rejects later target host capabilities in ${fixture.name}`, () => {
        const input = mutationEffectEvidence49Schema.parse(JSON.parse(fixture.json));
        for (const targetHostCapabilities of [
          ["hra.automation_update.v1"],
          {
            preambleVersion: 1, preambleDigest: "a".repeat(64),
            manifestVersion: 1, manifestDigest: "b".repeat(64),
          },
        ]) {
          expectUnknownFieldRejected(mutationEffectEvidence49Schema, {
            ...input, targetHostCapabilities,
          }, "targetHostCapabilities");
        }
      });
    }
  }

  test("does not treat absent historical optional fields as nullable or open capabilities", () => {
    for (const fixture of fixtures.filter((value) => value.codec === "mutation")) {
      const input = mutationEffectEvidence49Schema.parse(JSON.parse(fixture.json));
      if (input.kind === "session.send" || input.kind === "session.start") {
        expect(mutationEffectEvidence49Schema.safeParse({ ...input, runtimeProfile: null }).success).toBe(false);
      }
      if (input.kind === "session.start") {
        expect(mutationEffectEvidence49Schema.safeParse({
          ...input, conversationAutomationCapability: null,
        }).success).toBe(false);
        expect(mutationEffectEvidence49Schema.safeParse({
          ...input, conversationAutomationCapability: "hra.automation_update.v2",
        }).success).toBe(false);
      }
      if (input.kind === "session.switch") {
        expect(mutationEffectEvidence49Schema.safeParse({ ...input, daemonGeneration: null }).success).toBe(false);
        expect(mutationEffectEvidence49Schema.safeParse({
          ...input, targetProviderAccountKey: null,
        }).success).toBe(false);
        expect(mutationEffectEvidence49Schema.safeParse({
          ...input, targetProviderAccountKey: "v1:devin:" + "c".repeat(64),
        }).success).toBe(false);
      }
    }
  });

  test("keeps the queue runtime profile required and its baseline closed", () => {
    for (const fixture of fixtures.filter((value) => value.codec === "queue")) {
      const input = queueEffectEvidence49Schema.parse(JSON.parse(fixture.json));
      expect(queueEffectEvidence49Schema.safeParse({ ...input, runtimeProfile: undefined }).success).toBe(false);
      expectUnknownFieldRejected(queueEffectEvidence49Schema, {
        ...input, baseline: { ...input.baseline, providerTimestampUnit: "milliseconds" },
      }, "providerTimestampUnit", ["baseline"]);
    }
  });
});
