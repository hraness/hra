import type { Database } from "bun:sqlite";
import { z } from "zod";

import { normalizeSchemaSql, schemaCohortDigest } from "./schema-cohort";

// Frozen from the actual ALTER output in the three archived combined49
// fixtures (0ae3177), including both exact-provider adoption guard overrides.
// Do not derive these manifests from current adoption, Work or custody DDL.
const adoptionManifest = [
  ["index", "provider_runtime_account_revocations_releasing", "provider_runtime_account_revocations", "5c412534c973c0a6c81563571bd61dd2ec813883c71a8a1d5c79d935f0b81b10"],
  ["index", "session_adoption_candidates_claude_reprobe", "session_adoption_candidates", "db7d6fdc5749cf470640c41d9a6b13701f98d8bf2e47069b268b9b6e7178bd9f"],
  ["index", "session_adoption_candidates_pending", "session_adoption_candidates", "6b7d1f33eb73a67424030c355212100d3eec1bc4f3508fc51f809c416cf18c9c"],
  ["index", "session_claude_process_authorities_live_identity", "session_claude_process_authorities", "fa9a958c420a1b908f0c6ca2f12e32bef2f3b54dc1b55e18a6a752dfb0de16c9"],
  ["index", "session_claude_process_authorities_session", "session_claude_process_authorities", "0a97e93c7df89d761a28c74e4f35196b7f1ea2f361b6da8bbb6c501e1df4c35a"],
  ["index", "session_claude_process_launch_intents_profile", "session_claude_process_launch_intents", "7bfb18bb9314395f9c8015fe0873ced09d2905c78fdb485df1fb48ec9f9731bc"],
  ["index", "session_claude_process_launch_intents_session", "session_claude_process_launch_intents", "7406dc05244bdcffd0b510024e298e103cb053191d09c5bd7965a1e5639d9512"],
  ["index", "session_personal_runtime_bindings_active", "session_personal_runtime_bindings", "617d5af94a97221e546f38f840fc1bc8eff1ace76035fbce705d5e6528ed4287"],
  ["index", "sessions_profile_created", "sessions", "2c62ad9aeb0646909fe31f34f8f02db212063db20bed77e0661a28a83dca7039"],
  ["table", "profile_personal_authority_revocations", "profile_personal_authority_revocations", "61230493571b75d399ad32901bc18398ff33b85323e4d17f318ce2ceac5075b5"],
  ["table", "provider_runtime_account_revocations", "provider_runtime_account_revocations", "32bb19050a0c49a7adf548db695c042a17bf8ae6a39796db8d22afd4ed6469c3"],
  ["table", "session_account_authorities", "session_account_authorities", "a6dace76cedee9fc33433f6e99fe724226ed6b5b981c0c3615bab4bcffe1e4ac"],
  ["table", "session_adoption_candidates", "session_adoption_candidates", "f52ec19ac54d8d64d2023e2b38e4e856c9e7c7dbe100aeae2b17013c8ba6ce21"],
  ["table", "session_adoption_policies", "session_adoption_policies", "4bd25b13c0a7b906f5e265f2dd606f0e2fa23d88ea88b57d477be21cf20ee15f"],
  ["table", "session_adoption_profile_generation_permits", "session_adoption_profile_generation_permits", "8acc84bf508bdae7b5e7ae3c213c0b177eb68ff8cb9c6acd6adcb7212c53a6bf"],
  ["table", "session_claude_process_authorities", "session_claude_process_authorities", "f3d4d06842473597def4f230597c10e2aebabca22e236a38da29f54ca4080cb8"],
  ["table", "session_claude_process_launch_intents", "session_claude_process_launch_intents", "e60d612bfa4bff15470034677a34e5b44a48bdc367b388b8ba4f2195bb9adadd"],
  ["table", "session_personal_runtime_bindings", "session_personal_runtime_bindings", "39cadc0b3ce7d197f3378e455455c69f786d17683ef7f0affbf2c8227153e359"],
  ["table", "session_provider_account_authorities", "session_provider_account_authorities", "7f5261f6d1b11ccaccc5901f3675cdba46eef99132deef999ceb85e32de98509"],
  ["trigger", "detached_personal_session_active_state_guard", "sessions", "34d49f523e302265c220aaaf1fb064c0818824d6b5eed92b984156971b43baa0"],
  ["trigger", "detached_personal_session_interaction_guard", "provider_interactions", "6a4741bf66d4ba5f8ad04c7c744715688f18a9fd19ea47f2aaac7f75112673ea"],
  ["trigger", "detached_personal_session_queue_guard", "queue_entries", "81c4d08488e8baeb9d2a6901b136a112d257c32038dc41d6f92f72c0a55b8e35"],
  ["trigger", "detached_personal_session_task_insert_guard", "session_tasks", "273f573d8fb2ac6764e7694dbf996f2dd473f47acfd60ba57423f4b0ac1cf050"],
  ["trigger", "detached_personal_session_task_update_guard", "session_tasks", "3917b3ded7966b47702297d1dd163702f6304226c347f9bec598d7adc3f71508"],
  ["trigger", "profile_codex_account_key_insert_guard", "profiles", "6960c8a1f12840a65ae01591d91cf31e77be48ec7ca6b1be747c6a18c9fb0515"],
  ["trigger", "profile_codex_account_key_update_guard", "profiles", "8e665096468c114234802970e198b6ae766aa688bca0176891e02644e18eb474"],
  ["trigger", "profile_controller_authority_recovery_guard", "profiles", "5aea6fa4e4f5ed8db2289a04b1864af360d686348aef22b6102197351a6e4404"],
  ["trigger", "profile_personal_authority_revocation_revision_guard", "profile_personal_authority_revocations", "e5f15aa712e4bde6728e6c53681124ead2d1892c3fc9b32e9c5891c48dbc6b6f"],
  ["trigger", "provider_runtime_account_revocation_revision_guard", "provider_runtime_account_revocations", "13af87b555ddaff36c551e3f86849a652f9acf51506b89e7098b841c77b77357"],
  ["trigger", "session_account_authority_active_state_guard", "sessions", "ca5bf2b36ed292f290aef41858a2a1e7d7655c63c1560d76a47927360f839cc4"],
  ["trigger", "session_account_authority_insert", "sessions", "32756558387621c08d46c0d8811103c0070a113b72eef6e5664c5f7c1fbbed12"],
  ["trigger", "session_account_authority_interaction_guard", "provider_interactions", "8b2546d70824f1c06743c5f6e0661ac8249e7c26daf6c8a3a6ed003ae23b435a"],
  ["trigger", "session_account_authority_queue_guard", "queue_entries", "a654ca1af86402d97ae9f89bc1af319e6d86e67efb7ac324a4e3d34884fda76d"],
  ["trigger", "session_account_authority_rebind", "sessions", "f77e6faf58bd5e3f4cb984f3337317f658a41aba19153d60d99e94adee67eda6"],
  ["trigger", "session_account_authority_task_insert_guard", "session_tasks", "01f489ecca0082e5877b24433ff64071f05377b7d0aaaa5cd42142e3b2a7e9fc"],
  ["trigger", "session_account_authority_task_update_guard", "session_tasks", "168b83e2ca664e0410743b5ad107dd22bfeef964098986cc576252ebe1c35dc1"],
  ["trigger", "session_account_authority_update_guard", "session_account_authorities", "6198181db7a6ce19f2034f841234c4cc138a7d0b1afcffd3562951354eca5b94"],
  ["trigger", "session_adoption_candidate_identity_immutable", "session_adoption_candidates", "3619cd9b25d79ca4cc5baa82bed0d9d10e00ce82e96faef9e7a022e6982e21fd"],
  ["trigger", "session_adoption_candidate_revision_guard", "session_adoption_candidates", "5ac4057b9e45a3780e5daef97fdf0ea198ceb85c80265a98eb1100c3bfac6ef2"],
  ["trigger", "session_adoption_candidate_source_identity_guard_insert", "session_adoption_candidates", "3c506c2c31c02d93cf833d90a237c0c4c93fdf6cb3bd922a8539e5cd1fa15a3b"],
  ["trigger", "session_adoption_candidate_source_identity_guard_update", "session_adoption_candidates", "4e6e479540c072e56104f3374e0014e3edeaa129ed3b10ad97ee85027c9b00ae"],
  ["trigger", "session_adoption_policy_identity_immutable", "session_adoption_policies", "b1e3f128a93e6ed7f8d0981cba0dc62b0a16309e4577f7aded7efd41e14edbe0"],
  ["trigger", "session_adoption_policy_profile_guard_insert", "session_adoption_policies", "8571461aa47d7467a13d75ec69ae55521dcb01812e859259ccf2f7d2724e7155"],
  ["trigger", "session_adoption_policy_profile_guard_update", "session_adoption_policies", "d27219a3cffe15243106df388f6d383638083eac0d6c484067309b28df63e23e"],
  ["trigger", "session_adoption_policy_provider_revocation_guard_insert", "session_adoption_policies", "77d8079e98bea5920d36d4c651cb425d75e2a76ff48a2f50a9124874e34188df"],
  ["trigger", "session_adoption_policy_provider_revocation_guard_update", "session_adoption_policies", "64076b744b2e78c91079edbd62a6bd624c93256a8b78347821941363b76ef7d8"],
  ["trigger", "session_adoption_policy_revision_guard", "session_adoption_policies", "5bfbc9e47b2577175da1d017b84ffa384c267f308ccabd726f0e83a8ffc20527"],
  ["trigger", "session_adoption_policy_unsettled_claim_guard", "session_adoption_policies", "931449f4032b4915459524148c5609386366c6ab1269c27360003898bcac0022"],
  ["trigger", "session_adoption_profile_generation_guard", "profiles", "9621bd4b329afd7749809a181713b08e2673072c8b0560c03357de35ff55a180"],
  ["trigger", "session_adoption_profile_generation_permit_no_update", "session_adoption_profile_generation_permits", "ad35d967562a5df7a1626b98d4e9560fb94ec15f197f935b7e77ecb99096a19a"],
  ["trigger", "session_adoption_profile_identity_guard", "profiles", "8083224ee5ca15457d157e0cb548229d0eef287bd440b3378bac5cf86ab0460f"],
  ["trigger", "session_adoption_profile_signed_out_policy_disable", "profiles", "f4a2293d8c18949fa75a9a60d3bde05b357093f04282e8a2b690663feed333c1"],
  ["trigger", "session_adoption_profile_signout_guard", "profiles", "33158573860aec25ec8db5c70a182eecfeab7e1b3eb23a8d5613835f2c49976a"],
  ["trigger", "session_adoption_profile_unidentified_policy_disable", "profiles", "24a5e38a94e04d9904abe3c7bea003515b94aa461a1109d79351fa106ab80d4f"],
  ["trigger", "session_claude_process_authority_revision_guard", "session_claude_process_authorities", "4dcc3cf259aaeb1ccce2b20ac6fd7b1e1acf18518b97133bf219e7d7516bfaf2"],
  ["trigger", "session_claude_process_authority_session_guard_insert", "session_claude_process_authorities", "604c97290268aa3f6ca29ea086872df0060e47d8c885d34e5292195646800cc3"],
  ["trigger", "session_claude_process_authority_session_guard_update", "session_claude_process_authorities", "4f2d1897aa9be18012b8c7e8708759cd2ff1c7a10f6414f120e5cf8d5b9bdc94"],
  ["trigger", "session_claude_process_launch_intent_no_update", "session_claude_process_launch_intents", "462fac3671531c55e966ee351c98284e2678af12e1be1c45d46002192f069e88"],
  ["trigger", "session_claude_process_launch_intent_process_guard", "session_claude_process_launch_intents", "a9ba197a453c6ad10312bf5bcaadb347248cc3d6e397424122bd9fec8c5559ed"],
  ["trigger", "session_claude_process_launch_intent_profile_guard", "session_claude_process_launch_intents", "48f87b474a54439285ba0bbbd36d14d7775ab1856d2990355573d9b4d0d21805"],
  ["trigger", "session_personal_runtime_binding_authority_guard", "session_personal_runtime_bindings", "1eefc1ab8ee2fc7c24d6397c72efb087a7807452eb19c91d0e392e22668e8683"],
  ["trigger", "session_personal_runtime_binding_identity_immutable", "session_personal_runtime_bindings", "7157e5328e26a9c2206dd4db720d23224cfac5ca60725c33d37c216ffc7dfa22"],
  ["trigger", "session_personal_runtime_binding_launch_intent_detach_guard", "session_personal_runtime_bindings", "7e1d7d98073433898b5c9392d7299617786afd107b97283613df1ed82b06efe5"],
  ["trigger", "session_personal_runtime_binding_revision_guard", "session_personal_runtime_bindings", "ddc74c739c4ccb336b06ded3255e4500ac95e9781787f82d07373676eb45330d"],
  ["trigger", "session_provider_account_authority_insert_guard", "session_provider_account_authorities", "ac26fe0fc5adabcb2bd15e937520117120fd533aa95b1b147a319f1ff4782e9a"],
  ["trigger", "session_provider_account_authority_update_guard", "session_provider_account_authorities", "43daa2ef86e1341438682f907b7535819ab041a82eaf1deb7c498bea77856499"],
  ["trigger", "sessions_claude_process_authority_rebind_guard", "sessions", "e36a3930a1286e042db0f2ad38dbee7b27561b1cb6aada6eb571e3eb4b782fa5"],
  ["trigger", "sessions_personal_runtime_binding_rebind_guard", "sessions", "0522b04613305e130962b191b6284ceff2e242915562ea7528a9c0dfd9d0f147"],
] as const;
const adoptionObjectNames: ReadonlySet<string> = new Set(adoptionManifest.map(([, name]) => name));
const adoptionTableNames: ReadonlySet<string> = new Set(adoptionManifest
  .filter(([type]) => type === "table").map(([, name]) => name));
const workGuardNames: ReadonlySet<string> = new Set([
  "work_attempt_account_authority_guard",
  "work_coordinator_account_authority_guard",
  "work_member_account_authority_guard",
  "work_review_account_authority_guard",
  "work_signal_account_authority_guard",
  "work_signal_ack_account_authority_guard",
]);
// These are footprint names, not a substitute for the caller's complete
// Claude/switch schema and row audits. Their evolving exports are not used.
const claudeCustodyObjectNames = [
  "claude_launch_custody_parent",
  "claude_process_custody_parent",
  "claude_process_unreleased_profile_scope",
  "session_claude_process_custody_incarnation",
  "session_claude_process_custody_origin",
  "session_claude_process_custody_previous",
  "session_claude_launch_dispositions",
  "session_claude_process_provider_authorities",
  "claude_launch_custody_delete",
  "claude_launch_custody_insert",
  "claude_launch_custody_update",
  "claude_launch_disposition_immutable_delete",
  "claude_launch_disposition_immutable_update",
  "claude_launch_disposition_insert",
  "claude_process_custody_bind",
  "claude_process_custody_delete",
  "claude_process_custody_immutable_delete",
  "claude_process_custody_immutable_update",
  "claude_process_custody_insert",
  "claude_process_custody_update",
  "claude_process_profile_removal_guard",
  "claude_process_proof_insert",
  "claude_process_restart_successor_guard",
  "claude_revocation_profile_rollover_guard",
] as const;
const switchAdoptionObjectNames = [
  "session_switch_adoption_anchors",
  "session_switch_adoption_capsules",
  "session_switch_adoption_anchors_delete",
  "session_switch_adoption_anchors_update",
  "session_switch_adoption_capsule_insert",
  "session_switch_adoption_capsules_delete",
  "session_switch_adoption_capsules_update",
  "session_switch_adoption_parent_insert",
  "session_switch_adoption_parent_update",
  "session_switch_adoption_personal_binding_delete",
  "session_switch_adoption_personal_binding_update",
  "session_switch_adoption_rebind_receipt",
  "session_switch_adoption_source_scope_delete",
  "session_switch_adoption_target_scope_insert",
] as const;
const expectedNames: ReadonlySet<string> = new Set([
  ...adoptionObjectNames, ...workGuardNames, ...claudeCustodyObjectNames, ...switchAdoptionObjectNames,
]);
const adoptionDigest = "5f281d052122cd392eefd87d792f942dcdb55ef375d4b5ba978cdd5dae56705b";
const workGuardsDigest = "72dfe2ececddea5e576f7718e894901f13e45df4f19d820c27739b8596f0eade";

// Separate, previously admitted compatibility shape: the first adoption
// build appended a nullable provider_account_key immediately before the PK;
// combined49 then appended its exact custody marker after that key. The
// other 67 adoption objects must be identical. This digest is proved by a
// synthetic DDL compatibility test, not an authentic nullable-key49 capture.
// A nullable declaration does not admit NULL-key custody rows: the outer
// proof/parent audit still decides whether each historical row is valid.
const legacyNullableLaunchAdoptionDigest = "5db88ec86554bca4f8acb75a96a926bb89c79fdc97f6f6d8b81dd2f2ce9ade8b";
const legacyNullableLaunchDigest = "eadaa62bb262a7a70536780c390fb3a3a0f22f4eda8af1ffc40a88e4dc5ad68b";
const objectSchema = z.object({
  type: z.enum(["table", "index", "trigger"]),
  name: z.string(),
  tbl_name: z.string(),
  sql: z.string(),
}).strict();

class Combined49AdoptionSchemaError extends Error {}

/**
 * Read-only component proof. The caller owns the exact migration ledger,
 * profiles.codex_account_key declaration/value audit, all row relationships,
 * and Claude/switch custody, proof, successor and disposition validation.
 */
export const assertCombined49AdoptionSchema = (database: Database): void => {
  const fail = (message = "STATE_COMBINED49_ADOPTION_SCHEMA_INVALID"): never => {
    throw new Combined49AdoptionSchemaError(message);
  };
  try {
    if (!z.object({ foreign_keys: z.literal(1) }).strict().safeParse(
      database.query("PRAGMA foreign_keys").get(),
    ).success) fail();
    // Match the historical footprint boundary, including references from
    // objects on unrelated host tables, without treating profiles as an
    // adoption-owned table. SQL and tuple bytes are digested in type/name order.
    const objects = objectSchema.array().parse(database.query(
      `SELECT type,name,tbl_name,sql FROM sqlite_master
       WHERE type IN ('table','index','trigger')
         AND name NOT LIKE 'sqlite_%' AND sql IS NOT NULL
       ORDER BY type,name`,
    ).all());
    const byName = new Map(objects.map((object) => [object.name, object]));
    for (const [type, name, table, digest] of adoptionManifest) {
      const object = byName.get(name) ?? fail(`STATE_SCHEMA_V39_OBJECT_MISSING:${name}`);
      const actualDigest = schemaCohortDigest([object]);
      if (object.type !== type || object.tbl_name !== table
        || (actualDigest !== digest && !(name === "session_claude_process_launch_intents"
          && actualDigest === legacyNullableLaunchDigest))) fail(`STATE_SCHEMA_V39_OBJECT_INVALID:${name}`);
    }
    const footprint = objects.filter((object) => {
      if (object.type === "table" && object.name === "profiles") return false;
      if (expectedNames.has(object.name) || adoptionTableNames.has(object.tbl_name)) return true;
      if (object.name.startsWith("session_adoption_")
        || object.name.startsWith("session_personal_runtime_")
        || object.name.startsWith("session_claude_process_")
        || object.name.startsWith("provider_runtime_account_")
        || object.name.startsWith("profile_personal_authority_")) return true;
      const sql = normalizeSchemaSql(object.sql).toLowerCase();
      return sql.includes("codex_account_key")
        || [...adoptionTableNames].some((name) => sql.includes(name));
    });
    const unexpected = footprint.find((object) => !expectedNames.has(object.name));
    if (unexpected !== undefined) fail(`STATE_SCHEMA_V39_LEGACY_ADOPTION_OBJECT_INVALID:${unexpected.name}`);
    if (footprint.length !== expectedNames.size) fail("STATE_SCHEMA_V39_ADOPTION_SURFACE_INVALID");
    const digest = schemaCohortDigest(footprint.filter((object) => adoptionObjectNames.has(object.name)));
    if (digest !== adoptionDigest && digest !== legacyNullableLaunchAdoptionDigest) fail();
    if (schemaCohortDigest(footprint.filter((object) => workGuardNames.has(object.name))) !== workGuardsDigest) {
      fail("STATE_SCHEMA_V39_ADOPTION_WORK_INVALID");
    }
  } catch (error) {
    if (error instanceof Combined49AdoptionSchemaError) throw error;
    fail();
  }
};
