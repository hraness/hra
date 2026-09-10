import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { z } from "zod";

// Test-only synthetic exact-schema recognizer fixture. No actual v36 producer
// is available. This is NOT an emitted historical database or migration-stage
// capture. It is built into empty SQLite, never downgraded from current state.
export const syntheticAdoption36SchemaFixture = {
  "kind": "synthetic_adoption_v36_recognizer_contract",
  "historicalWriterProvenance": false,
  "sourceCommit": "6f056dcafd6435cd11ae504c75e9b1f869955ca7",
  "sourceStateSha256": "0e9e9f772b9caeb5c1ec80f58927c643643b28ac6cc7ca1ae868028d61cef32f",
  "sourceTestsSha256": "6eaac1613aa4490c84cbfcd1ae81df9374b2de593cf41b3bcd90acccd652ef25",
  "baseSourceCommit": "127c1e7dcf8ef1461b7d71ab4d077a93f85cc682",
  "baseDatabaseSha256": "95d9e375061ac090f1409e50937d68f66ae702176fae06287ff137c23f049e6b",
  "baseSchemaSha256": "01d372a6428ad93cadf4021ba0fc68396430001207bfe03b95db3b4fda528ef3",
  "selection": "full canonical34 DDL; frozen provider-switch35; frozen adoption40 definition with only the explicitly admitted legacy-provider and absent-retention variants; exact six legacy Work guards",
  "fragmentSha256": {
    "adoptionSql": "2129785e8de94c2e824b83dd8c7a7542c25ba2e8831e0cd9616da0737d2571ea",
    "updateSql": "2397c23478858fa2463a67d28c4fdbb3749faf42087c6d3f9869a5910d1a8521",
    "sourceIdentitySql": "72e6abd6ffcea4abbaf108e3413840993fd3aa18819e506bfdf3981cd1c6f832",
    "profileColumn": "44927cec3f99fd5c38de2806dc15a5006e6411b592ea8bea36b34f3fde166ea8",
    "switchSql": "e964a6930522c0ed8cc0a3b1c8d2a046b3bc5aa25286e045293afe951baaf229",
    "workSql": "fda6e3d49c3bf3c5663f5d219ee04786af2cb480517f1dfafc5af37affe2f092"
  },
  "objectCount": 379,
  "tableCount": 86,
  "schemaBytes": 203262,
  "schemaSha256": "409dc4b1120eff4413ee80daa0b81bd0aa47ed7bb2fd7205ff7dcc6f479ba8e6",
  "manifest": [
    {
      "type": "index",
      "name": "account_rate_limit_reset_attempts_identity_window",
      "tbl_name": "account_rate_limit_reset_attempts",
      "sha256": "95f61bd33b3fab19ed14c08aaa7e8d16e3a27bdae3d6db649f278f46a3d4b86c"
    },
    {
      "type": "index",
      "name": "account_rate_limit_reset_attempts_one_recoverable",
      "tbl_name": "account_rate_limit_reset_attempts",
      "sha256": "d459e556f16fc063e817c2e172daf51bef25b1e836bc2e7c7071f61491303699"
    },
    {
      "type": "index",
      "name": "account_rate_limit_reset_attempts_one_success",
      "tbl_name": "account_rate_limit_reset_attempts",
      "sha256": "079587693b3c1030d66add721a563744710c34298b2a3ffcefc6f86c58db6e1a"
    },
    {
      "type": "index",
      "name": "account_rate_limit_reset_rebinds_attempt",
      "tbl_name": "account_rate_limit_reset_rebinds",
      "sha256": "0908ec6dfb3faf752c60adac745bf7cae41648b84277cd8e03ffaea2f7e4de8a"
    },
    {
      "type": "index",
      "name": "autorespond_evidence_recent",
      "tbl_name": "autorespond_evidence",
      "sha256": "2c195205aa41f58644b80b613ea8e8f38c1f706e0db8bb66768b336aa687613b"
    },
    {
      "type": "index",
      "name": "autorespond_evidence_session",
      "tbl_name": "autorespond_evidence",
      "sha256": "04fa8a6d6c8c03af586ee443891779d8d880ae52c0b4c02f86e36c58b921ae03"
    },
    {
      "type": "index",
      "name": "autorespond_message_sources_recent",
      "tbl_name": "autorespond_message_sources",
      "sha256": "8e16063e25c4bfd7f1eea6b690c376b53a4f7ed4aee0c92bf4c3846d508d0ecc"
    },
    {
      "type": "index",
      "name": "desktop_switch_generation_unique",
      "tbl_name": "desktop_switches",
      "sha256": "7c27f2d0c7a73b815a6a325a0cadf30e5b131eef775b0c2e87f84111877c832b"
    },
    {
      "type": "index",
      "name": "desktop_switch_resolution_generation_unique",
      "tbl_name": "desktop_switch_resolutions",
      "sha256": "223b109129f1335ad24085fb4e98760a5ec909d56de17545c4492ebea0192185"
    },
    {
      "type": "index",
      "name": "message_attachments_digest",
      "tbl_name": "message_attachments",
      "sha256": "1d4a628ec3c4c4564cffbafb365bddbedb2f058c233b56041372a15eff529793"
    },
    {
      "type": "index",
      "name": "message_attachments_recent",
      "tbl_name": "message_attachments",
      "sha256": "ef938439fe31e3774a988828772d09082b4071e6c30e1e426f3524a3423cb605"
    },
    {
      "type": "index",
      "name": "one_default_project",
      "tbl_name": "projects",
      "sha256": "4c70dcb895aafb9722ad8cc61b5927a241fe21888d113c102f0b1c0942e52541"
    },
    {
      "type": "index",
      "name": "profiles_label_active",
      "tbl_name": "profiles",
      "sha256": "55a683b4c74fd88244e3ea298c08afa4ba3773f406bce72ede8ec3d92e59a1c3"
    },
    {
      "type": "index",
      "name": "profiles_label_key_active",
      "tbl_name": "profiles",
      "sha256": "3bdd5c1fcfd1428df14a3deb9b32121e6dd3adb3ff638af7b4e8dcc77b979ff3"
    },
    {
      "type": "index",
      "name": "projects_label_key_unique",
      "tbl_name": "projects",
      "sha256": "245044cabcdf2de1b2482654102329d2d4ad045fb481156ba49472fcea9b41ac"
    },
    {
      "type": "index",
      "name": "projects_label_unique",
      "tbl_name": "projects",
      "sha256": "a24b940dd32e4c759d01b6a0292973df9e9b3f02e98a15ba0f3ac8e3eb1dd509"
    },
    {
      "type": "index",
      "name": "provider_interactions_due",
      "tbl_name": "provider_interactions",
      "sha256": "c65762cc2bb7039e5fd035b8d9d76edc41b1e2ab94184a0d2535daa2ecdfd243"
    },
    {
      "type": "index",
      "name": "provider_interactions_listing_global",
      "tbl_name": "provider_interactions",
      "sha256": "6fe4c39a82b04efc8d4f34660a46bb0e26eb8fd1b6f345e8b6a11d3b880a5f22"
    },
    {
      "type": "index",
      "name": "provider_interactions_listing_pending_global",
      "tbl_name": "provider_interactions",
      "sha256": "fa67e6cb0f12f54bd4759ea9b96a1351af83b3627ea75ac8343b3f5529b488ad"
    },
    {
      "type": "index",
      "name": "provider_interactions_listing_pending_session",
      "tbl_name": "provider_interactions",
      "sha256": "53f8bc744d564adb5fecfe7147e892d82143ce2caaaeab4dfa1cb3770ff34b71"
    },
    {
      "type": "index",
      "name": "provider_interactions_listing_session",
      "tbl_name": "provider_interactions",
      "sha256": "11fdf2b4c277716dd376d6e8ccf47fed5d37437cc1fd2474700eeb46645fdab3"
    },
    {
      "type": "index",
      "name": "provider_interactions_numeric_request",
      "tbl_name": "provider_interactions",
      "sha256": "cc8266e3d5fb91f4437eb9e2685e9219dfd915ff130d8322cb9fe64b0f8dc5e3"
    },
    {
      "type": "index",
      "name": "provider_interactions_pending",
      "tbl_name": "provider_interactions",
      "sha256": "f50e10fdaa2f96de52fee2dc7ed27a2087d2335f4acaed723611e2d08cae1fe3"
    },
    {
      "type": "index",
      "name": "provider_interactions_session",
      "tbl_name": "provider_interactions",
      "sha256": "61d9a7248a38a53a1881db954742a4414ec061ed14a9fde6452d26c925b425e6"
    },
    {
      "type": "index",
      "name": "provider_interactions_string_request",
      "tbl_name": "provider_interactions",
      "sha256": "27ee86f5be9dd2f74d48a59e592cbac152102211dcfb88bcfb9865efdb31351e"
    },
    {
      "type": "index",
      "name": "provider_login_authority_active_profile",
      "tbl_name": "provider_login_authorities",
      "sha256": "9ccbaeccd2a71f8443d7793aaaf4b74cff5ea41b497726e4a98c3df260b0b9ed"
    },
    {
      "type": "index",
      "name": "provider_runtime_account_revocations_releasing",
      "tbl_name": "provider_runtime_account_revocations",
      "sha256": "229d4f8eba1f121251bda09d3ea28e3c3f74e29b4e2d3a151fe802bad80f3d2e"
    },
    {
      "type": "index",
      "name": "queue_enqueue_sequence_unique",
      "tbl_name": "queue_entries",
      "sha256": "25ca7ec1d47fc4ea7fcdc3e2483501744f0cf0be06a5c9cf53ccb50082a6167f"
    },
    {
      "type": "index",
      "name": "queue_entries_message_scrub_candidates",
      "tbl_name": "queue_entries",
      "sha256": "53d5ea034235a7be00090891057b5c4a8822c6548b24f32b92da59c68641f533"
    },
    {
      "type": "index",
      "name": "queue_pending",
      "tbl_name": "queue_entries",
      "sha256": "5744a4f4a57876292c07959236fbb538acb54c868279f60b9a45f3d99abf3177"
    },
    {
      "type": "index",
      "name": "queue_pending_sequence",
      "tbl_name": "queue_entries",
      "sha256": "1536e18a87bacde64a51ee2f33a91cb5d8eb2f8e43ec4cee223229466c50d411"
    },
    {
      "type": "index",
      "name": "session_adoption_candidates_claude_reprobe",
      "tbl_name": "session_adoption_candidates",
      "sha256": "599ddc3d23ca447479cea35bd6dbbd706122f09d4f9d5d6b8f5b750813d64272"
    },
    {
      "type": "index",
      "name": "session_adoption_candidates_pending",
      "tbl_name": "session_adoption_candidates",
      "sha256": "a4b3cda9d5a16557822fe938d24b2034e98ebd8ad78d0f8475a7f118ec307990"
    },
    {
      "type": "index",
      "name": "session_claude_process_authorities_live_identity",
      "tbl_name": "session_claude_process_authorities",
      "sha256": "4c274314ef30cae2ed91b3a0f6be8f2887ef63e5ade94eb9e5fd7ffaeabbe34f"
    },
    {
      "type": "index",
      "name": "session_claude_process_authorities_session",
      "tbl_name": "session_claude_process_authorities",
      "sha256": "3e4ab266f6f8564bae94194456754de2603a90da9840633dbaf51ebd193f1541"
    },
    {
      "type": "index",
      "name": "session_claude_process_launch_intents_profile",
      "tbl_name": "session_claude_process_launch_intents",
      "sha256": "25def8777c92ba112c6b6f74c694d08959a8b8b7c25740801c80e3f2caeb56db"
    },
    {
      "type": "index",
      "name": "session_claude_process_launch_intents_session",
      "tbl_name": "session_claude_process_launch_intents",
      "sha256": "0460ad34d24ca8bddf47f632ee6ea841f486fb2ae50d4dd046391ed24400ff1a"
    },
    {
      "type": "index",
      "name": "session_events_age",
      "tbl_name": "session_events",
      "sha256": "68dec8a469452ce6dc4946c350506d01e0dbc16f4ed8146dedb52d68c9903e92"
    },
    {
      "type": "index",
      "name": "session_personal_runtime_bindings_active",
      "tbl_name": "session_personal_runtime_bindings",
      "sha256": "a3d1c5c2eb071bb58acd0454714f2b6e35704e09e95495d7b93a1a449847c712"
    },
    {
      "type": "index",
      "name": "session_task_occurrences_by_session",
      "tbl_name": "session_task_occurrences",
      "sha256": "9662037f81e544497eb96f70785ebecb36d449789c5cf89f5f5ec672345c8a0e"
    },
    {
      "type": "index",
      "name": "session_task_receipts_by_task",
      "tbl_name": "session_task_receipts",
      "sha256": "5f73ae98f16526379c47faa75df6aa88ba9191b875afe6c995499581a8ba9b46"
    },
    {
      "type": "index",
      "name": "session_tasks_by_session",
      "tbl_name": "session_tasks",
      "sha256": "271b9692c81ba63ee7e19b9c6bf1c69e94665fb83970fd8f9e0a37a1bca7a9f1"
    },
    {
      "type": "index",
      "name": "session_tasks_due",
      "tbl_name": "session_tasks",
      "sha256": "77f120b5ecea97a72b24385d6a57fb0af0dead825a14a3f3a0b95978a2332f51"
    },
    {
      "type": "index",
      "name": "sessions_archived",
      "tbl_name": "sessions",
      "sha256": "f5e99c0dd924bdcb7d2db5782437826868fcfad635db6cd9cb7c802e193d37e0"
    },
    {
      "type": "index",
      "name": "sessions_profile_created",
      "tbl_name": "sessions",
      "sha256": "38bdd7698d4ae737bffab78aef6954c515d183116d0acebc9401b26e57de4982"
    },
    {
      "type": "index",
      "name": "sessions_recent",
      "tbl_name": "sessions",
      "sha256": "eee97d2f7bbdf3171cdb9578a0f636f68501807f2aebd4b2c73fc45e0bc98069"
    },
    {
      "type": "index",
      "name": "usage_cloud_upload_anchors_recent",
      "tbl_name": "usage_cloud_upload_anchors",
      "sha256": "62e8608f5e305be59b8b273f6d1bddf115453a5a8ae10b8e96e69ca4db8635e8"
    },
    {
      "type": "index",
      "name": "usage_poll_failures_identity_recent",
      "tbl_name": "usage_poll_failures",
      "sha256": "937b80eb57fb49978b87d10c9816aea59d8d2ea5e64cf043a0fcd807cfed661e"
    },
    {
      "type": "index",
      "name": "usage_poll_failures_recent",
      "tbl_name": "usage_poll_failures",
      "sha256": "33f3c4cf78b17aaafcbc1caa20fdf08bbf0eea7ca05d34278065fda27011998d"
    },
    {
      "type": "index",
      "name": "work_attempt_reports_attempt",
      "tbl_name": "work_attempt_reports",
      "sha256": "99386f85d31a9cc8a6a84fdc21b45897a8428330bbb1c3ca8173aad11810748e"
    },
    {
      "type": "index",
      "name": "work_attempts_actor",
      "tbl_name": "work_attempts",
      "sha256": "45655d06dc54d1ea19f454d30e78ff9ed1211fbb4694c01b6332014330c286d4"
    },
    {
      "type": "index",
      "name": "work_attempts_lease",
      "tbl_name": "work_attempts",
      "sha256": "089b731855ce0eff5bdb83a2d333b816b1a9b7d9a8a458fb7625df1381c31f34"
    },
    {
      "type": "index",
      "name": "work_attempts_one_live",
      "tbl_name": "work_attempts",
      "sha256": "1004aced15c2470f635957f6dab5432da9f7817f6756ebf9243eb21be6b0a2d0"
    },
    {
      "type": "index",
      "name": "work_effect_subject_unique",
      "tbl_name": "work_prepared_effects",
      "sha256": "8dd70b22d529ef0697ec8b20e80e3d960cc88bc5e6ab3fef822c705ed641e9f1"
    },
    {
      "type": "index",
      "name": "work_events_revision",
      "tbl_name": "work_events",
      "sha256": "0ace9b55d4684427269ee8b29c3d9d7d365bc7589e35439fe2161d4fed09f305"
    },
    {
      "type": "index",
      "name": "work_idempotency_work",
      "tbl_name": "work_idempotency_intents",
      "sha256": "cfd514acb412b57f6955ee78ea34f87396d2192ed86d30126c7e099e8bf7376f"
    },
    {
      "type": "index",
      "name": "work_prepared_effects_pending",
      "tbl_name": "work_prepared_effects",
      "sha256": "327d113b4317f185a006f2651daf75cd14949cb8ccc96fb9c8cd41cbcb39e9f7"
    },
    {
      "type": "index",
      "name": "work_release_tombstones_retention",
      "tbl_name": "work_release_tombstones",
      "sha256": "ba6e50d0c62fd18b5b2003fbe1f3147db90046cea61b4888285002981449e00a"
    },
    {
      "type": "index",
      "name": "work_reviews_submission",
      "tbl_name": "work_reviews",
      "sha256": "ef570746721b65d0de5ce799129476dbe81bb1c2840ea798da26ed403def5301"
    },
    {
      "type": "index",
      "name": "work_signal_receipts_kind",
      "tbl_name": "work_signal_receipts",
      "sha256": "f584fb4d78f96d72c7e070c6f21793a99f44c9bdc31fbc094cdc442247c319d7"
    },
    {
      "type": "index",
      "name": "work_signals_recipient",
      "tbl_name": "work_signals",
      "sha256": "19ed0e32e32a82c2970ba629d3bdc55d62bec270b8ba095e0b60ac8e2a3274e5"
    },
    {
      "type": "index",
      "name": "work_submissions_task",
      "tbl_name": "work_submissions",
      "sha256": "7850aa7a4948e8e75ee131bf77af249af4864199f0067314dd593a3c63fea102"
    },
    {
      "type": "index",
      "name": "work_task_dependencies_reverse",
      "tbl_name": "work_task_dependencies",
      "sha256": "a818a2c4cbe43b98b7df330c24d7813206510e0ebd4dd1c19204e809f800d122"
    },
    {
      "type": "index",
      "name": "work_task_history_index_page",
      "tbl_name": "work_task_history_index",
      "sha256": "abab643d074f0dd492413e6425c76611abc824e29a0f17020850760e72ab9a34"
    },
    {
      "type": "index",
      "name": "work_task_history_versions_cut",
      "tbl_name": "work_task_history_versions",
      "sha256": "aded997b84dd516890d9388648b05e6ae4521c2c2eeda39541d5e530a3e5a8de"
    },
    {
      "type": "index",
      "name": "work_task_history_versions_work",
      "tbl_name": "work_task_history_versions",
      "sha256": "5be533ff790ea2dcf73b3a946092cbaca7a90dc6aaaf7d3041707d09fa5fdc58"
    },
    {
      "type": "index",
      "name": "work_task_states_ready",
      "tbl_name": "work_task_states",
      "sha256": "c3ba40e26d1dffa64baf0bfb8e273da4ae49721c765b0711c73bf8797872ad9d"
    },
    {
      "type": "index",
      "name": "work_tasks_order",
      "tbl_name": "work_tasks",
      "sha256": "24b3a3990ac90227b76316367f5b00345bfbe1f7c4aa346600f59281cabc9946"
    },
    {
      "type": "index",
      "name": "work_tasks_parent",
      "tbl_name": "work_tasks",
      "sha256": "db61c9ec9f9b73c9a3cc16e3113c8222f523b1837e7e1e662680e37744ecdc26"
    },
    {
      "type": "table",
      "name": "account_rate_limit_reset_attempts",
      "tbl_name": "account_rate_limit_reset_attempts",
      "sha256": "1e4f20481dc2ef3f18f1923c9c24050c3cd31dde8bb2a97af050cf3205d84132"
    },
    {
      "type": "table",
      "name": "account_rate_limit_reset_policies",
      "tbl_name": "account_rate_limit_reset_policies",
      "sha256": "96ee928762c47902c4d555e7fdcfdadf0e1e513fcca6e5059c24f4226ac47966"
    },
    {
      "type": "table",
      "name": "account_rate_limit_reset_rebinds",
      "tbl_name": "account_rate_limit_reset_rebinds",
      "sha256": "4b93905a9df9025dd2ea7f24f8147e35b8db3b82481652a219b8fa7927731545"
    },
    {
      "type": "table",
      "name": "attachments",
      "tbl_name": "attachments",
      "sha256": "456a33b41260cd3e95decd6e0599c1159377a9ae58d1098dd2ce46ab8ee41bc7"
    },
    {
      "type": "table",
      "name": "autorespond_evidence",
      "tbl_name": "autorespond_evidence",
      "sha256": "096d79c96141607623981d836ce8c2ed962054ff79a4407a6be6929a387dc90f"
    },
    {
      "type": "table",
      "name": "autorespond_message_sources",
      "tbl_name": "autorespond_message_sources",
      "sha256": "3b68f24a55ddd41db165f228aabf5e696375c6127cb9a0d7f206af45247e43e8"
    },
    {
      "type": "table",
      "name": "daemon_state",
      "tbl_name": "daemon_state",
      "sha256": "00b6f20eb3841b43906a23082e514c0868f30a1bf012679c525aeefb1dc491cb"
    },
    {
      "type": "table",
      "name": "desktop_switch_authority",
      "tbl_name": "desktop_switch_authority",
      "sha256": "aceb66925b11bd65c2229c7be8897169f2d229bd68920f478473c8894e2ae312"
    },
    {
      "type": "table",
      "name": "desktop_switch_resolutions",
      "tbl_name": "desktop_switch_resolutions",
      "sha256": "676052fda2f35da6d07bee727fcbf679479b7217245caf1f32bf150bb86d1b4b"
    },
    {
      "type": "table",
      "name": "desktop_switches",
      "tbl_name": "desktop_switches",
      "sha256": "ae79aa35fc44cddae5e697bb72736bb0c2f739682a7b469391cf8ed94728712d"
    },
    {
      "type": "table",
      "name": "device_command_ledger",
      "tbl_name": "device_command_ledger",
      "sha256": "232c1721927f8ed14e1d4f2872941cb24037aab19814049b67b9b742a5d56311"
    },
    {
      "type": "table",
      "name": "message_attachments",
      "tbl_name": "message_attachments",
      "sha256": "8eb584381b3fcda97ef62df9c7f39bbce0716a73016744aa10e7b2b701289cac"
    },
    {
      "type": "table",
      "name": "migrations",
      "tbl_name": "migrations",
      "sha256": "dc4af029f445680bccce121b5abd549189458a2e3d99c679cdf29a3e2792ce26"
    },
    {
      "type": "table",
      "name": "mutation_attempts",
      "tbl_name": "mutation_attempts",
      "sha256": "4b4745ddd2313d6f400ff7ee8c79e13500ac02e3f7ac304992d5ced34a9e83df"
    },
    {
      "type": "table",
      "name": "mutation_effect_evidence",
      "tbl_name": "mutation_effect_evidence",
      "sha256": "c0458a3461628814bb0da06b3b04be303d9ed58acf3638ae600a5e2106f88e99"
    },
    {
      "type": "table",
      "name": "mutation_resolutions",
      "tbl_name": "mutation_resolutions",
      "sha256": "d61ec28ba05f32a2a5ced14e827e3eda270dac175735b57f44dcc54d8f4a538a"
    },
    {
      "type": "table",
      "name": "profile_personal_authority_revocations",
      "tbl_name": "profile_personal_authority_revocations",
      "sha256": "7bfb4144fc4f838553f3e96cc0809846f697eb0c746b39fec878581eb2ddc103"
    },
    {
      "type": "table",
      "name": "profiles",
      "tbl_name": "profiles",
      "sha256": "f24cb9c390a1a290db4938db0e650478eee791b5ad33afc0bae9363a708539c1"
    },
    {
      "type": "table",
      "name": "project_approval_modes",
      "tbl_name": "project_approval_modes",
      "sha256": "ce73a5ec473dd65974d34ccd96a4aa007db75c22f2eb9dd3be9280479dcba31f"
    },
    {
      "type": "table",
      "name": "projects",
      "tbl_name": "projects",
      "sha256": "588ae1c8b2c15295402315745183839dd1cb1b88ce4792dd90982baa5d646161"
    },
    {
      "type": "table",
      "name": "provider_interaction_transitions",
      "tbl_name": "provider_interaction_transitions",
      "sha256": "c831a11d21ecd9522418fcbb08a25dd82d83afdee94548844a1d6ff77a23eb60"
    },
    {
      "type": "table",
      "name": "provider_interactions",
      "tbl_name": "provider_interactions",
      "sha256": "c1f63e13e3c2fa28975fd72e2642b869467afcdf64e2feb8eec614a485be7e7d"
    },
    {
      "type": "table",
      "name": "provider_login_authorities",
      "tbl_name": "provider_login_authorities",
      "sha256": "dedddfcfede32c69fb4f2d75ced40750bc0e098c37d0ad1a6e3b0d59255d7f45"
    },
    {
      "type": "table",
      "name": "provider_runtime_account_revocations",
      "tbl_name": "provider_runtime_account_revocations",
      "sha256": "a7d4a59b520ef7b0a182d7010c3e144b7b06a34fe700cc3fcfec16fa98c76831"
    },
    {
      "type": "table",
      "name": "queue_effect_evidence",
      "tbl_name": "queue_effect_evidence",
      "sha256": "f3236aa156f1d36324ae9c4e427c9dc939cd6ea3a5cae41b5ed284683e7aaec4"
    },
    {
      "type": "table",
      "name": "queue_effect_resolutions",
      "tbl_name": "queue_effect_resolutions",
      "sha256": "5ac1d9e26ac3658a516fba5e72b3ce2bca5e6d8ae80284542319162423171177"
    },
    {
      "type": "table",
      "name": "queue_entries",
      "tbl_name": "queue_entries",
      "sha256": "330db000cd5f6b7ff919ba78f862503e045823ee4a191870ab5afb84496245f1"
    },
    {
      "type": "table",
      "name": "queue_message_scrub_authority",
      "tbl_name": "queue_message_scrub_authority",
      "sha256": "af9868b84a450fc9a80919af75cacdf64d99f92089256fa7113ac23f24594d5d"
    },
    {
      "type": "table",
      "name": "queue_sequence_authority",
      "tbl_name": "queue_sequence_authority",
      "sha256": "e6adfb7b7197478519ada2a60c579a55419f73b3f9d33c2a7892952775dcfad3"
    },
    {
      "type": "table",
      "name": "security_scrub_authority",
      "tbl_name": "security_scrub_authority",
      "sha256": "c91f7fd89d5bf8d56c8c0e2818f387568cae7686626ff5f7fa75a04877e52cd7"
    },
    {
      "type": "table",
      "name": "session_account_authorities",
      "tbl_name": "session_account_authorities",
      "sha256": "1a224547029cf564afb4ba45c8af558c5ddd61b66160e011f7aa12c97a89ec2f"
    },
    {
      "type": "table",
      "name": "session_adoption_candidates",
      "tbl_name": "session_adoption_candidates",
      "sha256": "3ea80b0f4c01c7616e2478646d2c6291239313e78da2d14463e13ac490272206"
    },
    {
      "type": "table",
      "name": "session_adoption_policies",
      "tbl_name": "session_adoption_policies",
      "sha256": "6efeb9a7153a47c51ccdb362f744f05c5b170b0258a359986a6bfec5e6973dbc"
    },
    {
      "type": "table",
      "name": "session_adoption_profile_generation_permits",
      "tbl_name": "session_adoption_profile_generation_permits",
      "sha256": "addbad55255c8bfa6b3445817b703082d01abdfbbd4997a31e56eee3be009c9b"
    },
    {
      "type": "table",
      "name": "session_approval_modes",
      "tbl_name": "session_approval_modes",
      "sha256": "fc9e37e6d4e5bf11a130ae93a3a1dd2062781e94b794f632867e843808e03b3e"
    },
    {
      "type": "table",
      "name": "session_autorespond_counters",
      "tbl_name": "session_autorespond_counters",
      "sha256": "0da2251329a651ca1c34daf41a5a55e8ec012d57e8830b9a7fc360f9adab5013"
    },
    {
      "type": "table",
      "name": "session_claude_process_authorities",
      "tbl_name": "session_claude_process_authorities",
      "sha256": "29db93abc09ee5659b8114ce4cbc99b92be2b25b6b4b51c1fd22b956ad3da8b0"
    },
    {
      "type": "table",
      "name": "session_claude_process_launch_intents",
      "tbl_name": "session_claude_process_launch_intents",
      "sha256": "9ce6b6ca0ac6677ae95619dcb9568c19564f1022cce5595c261d13bbde509cb6"
    },
    {
      "type": "table",
      "name": "session_conversation_automation",
      "tbl_name": "session_conversation_automation",
      "sha256": "461bf8806cca451fcd2ee20b04a3d7a8e2f36c0df246b5bdd462a7dddc598e3f"
    },
    {
      "type": "table",
      "name": "session_event_streams",
      "tbl_name": "session_event_streams",
      "sha256": "1beab1fbfd85e3a3829660728b987e6eef015864dba93b27fb95fdfabb176ce1"
    },
    {
      "type": "table",
      "name": "session_events",
      "tbl_name": "session_events",
      "sha256": "b2c053e8761bf1b3a556babd540646c7b8743f0aa52363256c2c80c58fb8973a"
    },
    {
      "type": "table",
      "name": "session_mutation_authority_rebinds",
      "tbl_name": "session_mutation_authority_rebinds",
      "sha256": "ad19344c599da4c9a2c2b9a01a98a42bac365af9c5307fb0f0e4cf1e51f34109"
    },
    {
      "type": "table",
      "name": "session_personal_runtime_bindings",
      "tbl_name": "session_personal_runtime_bindings",
      "sha256": "8a17ae0140b65bd5576ad6eb39dcf60be96c3e316a06379c41eee17e6b592dc7"
    },
    {
      "type": "table",
      "name": "session_provider_account_authorities",
      "tbl_name": "session_provider_account_authorities",
      "sha256": "b9e0674280c8fdb9ea1a0d7ea2722f91661c2917b67e93dafede3da2a1056930"
    },
    {
      "type": "table",
      "name": "session_provider_switch_seed_intents",
      "tbl_name": "session_provider_switch_seed_intents",
      "sha256": "c9794ab7cf7833761a26e2a7ed1125d4c89c1433d22b478195274cf34c5cfbe3"
    },
    {
      "type": "table",
      "name": "session_provider_switch_seed_results",
      "tbl_name": "session_provider_switch_seed_results",
      "sha256": "773510719d9ed7513140163b0069e9f446852557bc968d65145d726593b67187"
    },
    {
      "type": "table",
      "name": "session_provider_switch_source_releases",
      "tbl_name": "session_provider_switch_source_releases",
      "sha256": "ebfd84a99ffd941bc71201bd95071ba5a390110ad0c02731a18690ee0dfece80"
    },
    {
      "type": "table",
      "name": "session_provider_switch_target_releases",
      "tbl_name": "session_provider_switch_target_releases",
      "sha256": "4625e7d4bab3440fb5b4f8cf54d44afe87afaf56ec9a35a1a890418d22b55be3"
    },
    {
      "type": "table",
      "name": "session_provider_switch_targets",
      "tbl_name": "session_provider_switch_targets",
      "sha256": "07101384250bac96c899d4425a07fb8639829682bd8167e81426e621ecbb9c11"
    },
    {
      "type": "table",
      "name": "session_runtime_profiles",
      "tbl_name": "session_runtime_profiles",
      "sha256": "02268074c770cd494ade50e1e6702d619a5f8a4e5cf1b2b889b483d1dc7ae33e"
    },
    {
      "type": "table",
      "name": "session_show_thinking",
      "tbl_name": "session_show_thinking",
      "sha256": "5e449a43bc8b7a33efd7fc4bd48a28b09bc6fe77bc6eec13aed13f9d3ef67ff8"
    },
    {
      "type": "table",
      "name": "session_start_attempts",
      "tbl_name": "session_start_attempts",
      "sha256": "180c93ef428fce557ce0cafe087e6096b9402eaddccbe19fd287cc251009a726"
    },
    {
      "type": "table",
      "name": "session_states",
      "tbl_name": "session_states",
      "sha256": "cefedb7ec983202bb307279a9ca52f6a4be11317b0dda365e16070c53ab16f91"
    },
    {
      "type": "table",
      "name": "session_task_occurrences",
      "tbl_name": "session_task_occurrences",
      "sha256": "8bd91209b5e525d7205223c69eeb644c68898d91e7b085b4b46aa6eeedaa0f1a"
    },
    {
      "type": "table",
      "name": "session_task_receipts",
      "tbl_name": "session_task_receipts",
      "sha256": "cb78497d41236aa2c3a1f1d64b93117d902460efa268f041b9acce58678243a5"
    },
    {
      "type": "table",
      "name": "session_tasks",
      "tbl_name": "session_tasks",
      "sha256": "dcf2f43693f0bef5431bd7d6a097ad3315374ae102a7b2d33dab707cc4726e2c"
    },
    {
      "type": "table",
      "name": "session_turn_runtime_profiles",
      "tbl_name": "session_turn_runtime_profiles",
      "sha256": "5f57539ed94c0b657ac93b62bf70f38e209a4ebcc7d4a9fa02a0c44bddad150d"
    },
    {
      "type": "table",
      "name": "sessions",
      "tbl_name": "sessions",
      "sha256": "244d4ce4007f9ca55cc3b211f12753eae084e7077eeda11587ed530c2f108e2c"
    },
    {
      "type": "table",
      "name": "turn_summaries",
      "tbl_name": "turn_summaries",
      "sha256": "0442143b1b626c720dc7937698540570744b42aa15bc0703da0a12505eaac857"
    },
    {
      "type": "table",
      "name": "usage_cloud_upload_anchors",
      "tbl_name": "usage_cloud_upload_anchors",
      "sha256": "2444784c4c01b8422c4768018c89bffab76f861abb62cfa65e0e6d5f83581fbf"
    },
    {
      "type": "table",
      "name": "usage_poll_failures",
      "tbl_name": "usage_poll_failures",
      "sha256": "02299e45299582dc64ab6c6d120f24c19b0d726e0a094785aed634a7d2dda4ca"
    },
    {
      "type": "table",
      "name": "usage_revision_authority",
      "tbl_name": "usage_revision_authority",
      "sha256": "b27407a32f41cd1c55eb9ebc5a39650d03cdbcdc4efa31c6ba50d367caa99292"
    },
    {
      "type": "table",
      "name": "usage_snapshots",
      "tbl_name": "usage_snapshots",
      "sha256": "255c77d6c06ce7226694098e9e6a5a120bce67f79fd4b60585f3406aa61601dc"
    },
    {
      "type": "table",
      "name": "work_attempt_reports",
      "tbl_name": "work_attempt_reports",
      "sha256": "470834e76c419f3f033fda2a1fdef27997593769ea4fe01885276e74e69e5855"
    },
    {
      "type": "table",
      "name": "work_attempts",
      "tbl_name": "work_attempts",
      "sha256": "3d88728fb5a9e4e64853b3d4d02f0287cbaf2f70e8a4b8694a658fde026363ee"
    },
    {
      "type": "table",
      "name": "work_clock",
      "tbl_name": "work_clock",
      "sha256": "c91034b28c82b12d1bb4ee8997951f97387cf985490cb086b052faf7edff8d97"
    },
    {
      "type": "table",
      "name": "work_effect_resolutions",
      "tbl_name": "work_effect_resolutions",
      "sha256": "1900e15032a00abb1eb466f669f3736f3e7cb6a65f94a24de26a9447757b8f9f"
    },
    {
      "type": "table",
      "name": "work_events",
      "tbl_name": "work_events",
      "sha256": "f6ce6829f0113da8e595cda4e08f3d41b5835e1739a1805bb0661b95885e80f3"
    },
    {
      "type": "table",
      "name": "work_idempotency_intents",
      "tbl_name": "work_idempotency_intents",
      "sha256": "28b46081596f19e1c3f08844d9ee10e1bfdabb26f7cade8010a7a04ad1ef161a"
    },
    {
      "type": "table",
      "name": "work_members",
      "tbl_name": "work_members",
      "sha256": "5fe8097a3dcd2b52689b4aa3fa75b034a4869aa94eda4cc232fcc3d337932fa5"
    },
    {
      "type": "table",
      "name": "work_nested_effect_settlements",
      "tbl_name": "work_nested_effect_settlements",
      "sha256": "d8bf7ba061dd252ebe22812689dfda6fabb1fb421ee096c8b9dfb87103874853"
    },
    {
      "type": "table",
      "name": "work_prepared_effects",
      "tbl_name": "work_prepared_effects",
      "sha256": "f0e3b737c0864649aaa84a2936a2ad588b663610ef1920be396c81813f9c8377"
    },
    {
      "type": "table",
      "name": "work_purge_authority",
      "tbl_name": "work_purge_authority",
      "sha256": "c136c4d120bdd0f6abfa3f8c6dabeb597a38544bc6dccfee1aa85b620c384cb1"
    },
    {
      "type": "table",
      "name": "work_release_tombstones",
      "tbl_name": "work_release_tombstones",
      "sha256": "fed3474fdae0c9701f70d6a736f0f085d49fd7e823de1c2ef4e9851ea9e11ba5"
    },
    {
      "type": "table",
      "name": "work_reviews",
      "tbl_name": "work_reviews",
      "sha256": "5e966296e5ef22c6aba325b3fcda42d022ca1a54c385d4b1dc5febdbf24fce21"
    },
    {
      "type": "table",
      "name": "work_routes",
      "tbl_name": "work_routes",
      "sha256": "974a304517ebf8fe4ae5ad664e606739a586e99fbe41c130f29974e6e601b6b9"
    },
    {
      "type": "table",
      "name": "work_signal_receipts",
      "tbl_name": "work_signal_receipts",
      "sha256": "b15ec295ef8ccce0d24700a2fef7da47be90c9e1b60257e0bde73e13074ea0b1"
    },
    {
      "type": "table",
      "name": "work_signals",
      "tbl_name": "work_signals",
      "sha256": "272b5446cbce2b894815cc3f20cdcc7d785cba59cf42580d01dc24cb38b86420"
    },
    {
      "type": "table",
      "name": "work_submissions",
      "tbl_name": "work_submissions",
      "sha256": "831d778a137bed01921657579dcf65f5ee8d6f414e79cf7a76f0615a7e389289"
    },
    {
      "type": "table",
      "name": "work_task_dependencies",
      "tbl_name": "work_task_dependencies",
      "sha256": "e9425175e07c06001bcdfdd3a60c18bc6ac84f126e3f065d08299e21c7b18464"
    },
    {
      "type": "table",
      "name": "work_task_history_index",
      "tbl_name": "work_task_history_index",
      "sha256": "0a0420fc3089e74e6ce409afe9fe4832d8d7433a547179ad9e2c64c440baeab3"
    },
    {
      "type": "table",
      "name": "work_task_history_versions",
      "tbl_name": "work_task_history_versions",
      "sha256": "005a4d6cbe67b809e5fc97adc9d080547d579af2a43645b76475101b07454b8f"
    },
    {
      "type": "table",
      "name": "work_task_states",
      "tbl_name": "work_task_states",
      "sha256": "3fd9b4c8fe7ee2c835acb6af8f6069c4ed4073a1115d2a2961f5d867512e9b1e"
    },
    {
      "type": "table",
      "name": "work_tasks",
      "tbl_name": "work_tasks",
      "sha256": "9f8c2b3f294825c78a504b59b0353c4496e7c8f1a606bafbfcfe3d62415b3f43"
    },
    {
      "type": "table",
      "name": "work_terminal_requests",
      "tbl_name": "work_terminal_requests",
      "sha256": "eb5f1e3f361712afb52255366d9ec71d2cf8d16cbc006056a7af1c49dcbd0c5d"
    },
    {
      "type": "table",
      "name": "works",
      "tbl_name": "works",
      "sha256": "70d78384a5f1c07b1515c329d1e3483f11a080bbf7d5a97daaa0f3337693c5c8"
    },
    {
      "type": "trigger",
      "name": "account_rate_limit_reset_attempt_identity_guard",
      "tbl_name": "account_rate_limit_reset_attempts",
      "sha256": "ecc7c34eda7df3ab17e8d945c902087a63721ed16f62d01906b72b3972395b36"
    },
    {
      "type": "trigger",
      "name": "account_rate_limit_reset_attempt_policy_begin_guard",
      "tbl_name": "account_rate_limit_reset_attempts",
      "sha256": "a3cf2a3bebcdf48b348a1434be52986d170a890f9c1c450fde3bfe0997cafe24"
    },
    {
      "type": "trigger",
      "name": "account_rate_limit_reset_attempt_policy_close_guard",
      "tbl_name": "account_rate_limit_reset_attempts",
      "sha256": "0f6a991dc6dcf273592323885a84760924c07fbc3da4c2b8ef911460fa2a4cf3"
    },
    {
      "type": "trigger",
      "name": "account_rate_limit_reset_attempt_policy_insert_guard",
      "tbl_name": "account_rate_limit_reset_attempts",
      "sha256": "7aaed0c85abff059eebfb41c369b9e3264187d69242e8600d3230f0036e55b3d"
    },
    {
      "type": "trigger",
      "name": "account_rate_limit_reset_attempt_rebind_guard",
      "tbl_name": "account_rate_limit_reset_attempts",
      "sha256": "7fa7b38704db9c1896707c2822a26fa8e63e37edc356058bdfa216aae962d393"
    },
    {
      "type": "trigger",
      "name": "account_rate_limit_reset_attempt_terminal_evidence_guard",
      "tbl_name": "account_rate_limit_reset_attempts",
      "sha256": "260e50b9f7d8d706682b5cf62fda0e7b40d3d11cd74e9f2c9a8fdd71d90c29d1"
    },
    {
      "type": "trigger",
      "name": "account_rate_limit_reset_attempt_transition_guard",
      "tbl_name": "account_rate_limit_reset_attempts",
      "sha256": "353d000a927f487b0139332b40f821eee484dc97f1796df34336ba43e10ff084"
    },
    {
      "type": "trigger",
      "name": "account_rate_limit_reset_policy_delete_guard",
      "tbl_name": "account_rate_limit_reset_policies",
      "sha256": "5658835b028f3277c1be7e2a80557440acf09f0dd949377840e1126ec9cbe0dc"
    },
    {
      "type": "trigger",
      "name": "account_rate_limit_reset_policy_insert_guard",
      "tbl_name": "account_rate_limit_reset_policies",
      "sha256": "50b127bf6b49e49c3dd9c8837f80b866be36db1a3a6e1f9708f3af298041dcb2"
    },
    {
      "type": "trigger",
      "name": "account_rate_limit_reset_policy_transition_guard",
      "tbl_name": "account_rate_limit_reset_policies",
      "sha256": "8bd79bb78cc21f73b3d50266f6aac9387f170d9789345ce4cc452e6fd2501a7a"
    },
    {
      "type": "trigger",
      "name": "account_rate_limit_reset_rebind_delete_guard",
      "tbl_name": "account_rate_limit_reset_rebinds",
      "sha256": "438e1c9b1dac9e6996ac554367fbb8e35640c8af985b41684d12bc562d5b4b50"
    },
    {
      "type": "trigger",
      "name": "account_rate_limit_reset_rebind_insert_guard",
      "tbl_name": "account_rate_limit_reset_rebinds",
      "sha256": "0454cf8830e64f9a8c16bbb3b352db4c0d037fa986d84cc0aec9388cb5af2050"
    },
    {
      "type": "trigger",
      "name": "account_rate_limit_reset_rebind_policy_guard",
      "tbl_name": "account_rate_limit_reset_rebinds",
      "sha256": "49384cecb34e621c484bf1964403cdebf420303369e836252d0e1d4539901f07"
    },
    {
      "type": "trigger",
      "name": "account_rate_limit_reset_rebind_update_guard",
      "tbl_name": "account_rate_limit_reset_rebinds",
      "sha256": "9708d8981fd9f322765457c49e9dc7083f83619e47b62efc58290a1e49388f84"
    },
    {
      "type": "trigger",
      "name": "desktop_switch_resolutions_immutable_delete",
      "tbl_name": "desktop_switch_resolutions",
      "sha256": "2f8a3ad9ecc898234e1fb7c17416ab8068013fbafffe060a95233905483bedf7"
    },
    {
      "type": "trigger",
      "name": "desktop_switch_resolutions_immutable_update",
      "tbl_name": "desktop_switch_resolutions",
      "sha256": "ff70d5c2db5d081fa870401ede561630c79f646a48ee9b424227d5cc0b1be562"
    },
    {
      "type": "trigger",
      "name": "desktop_switch_transition_guard",
      "tbl_name": "desktop_switches",
      "sha256": "d8ffb028dd2581643cab4debef9123668aefaa6b91182dc38522e25792f06943"
    },
    {
      "type": "trigger",
      "name": "detached_personal_session_active_state_guard",
      "tbl_name": "sessions",
      "sha256": "8667de1c5d106427d45738a9b6cd51e33f52eed63d1d1aa7daf3924e32dcac8e"
    },
    {
      "type": "trigger",
      "name": "detached_personal_session_interaction_guard",
      "tbl_name": "provider_interactions",
      "sha256": "725d731c4b8b204ed0d6084ac744f797023aed20d44f9f6c80b907a327d5c423"
    },
    {
      "type": "trigger",
      "name": "detached_personal_session_queue_guard",
      "tbl_name": "queue_entries",
      "sha256": "15103b93627d37a6b1692e11d85e157acd0ac36e6dd80dc4d4c315965d859b81"
    },
    {
      "type": "trigger",
      "name": "detached_personal_session_task_insert_guard",
      "tbl_name": "session_tasks",
      "sha256": "095b114e3eb5e471816a556586aab27645d3287ab06e0e1d7f46d8ce7cacd4ac"
    },
    {
      "type": "trigger",
      "name": "detached_personal_session_task_update_guard",
      "tbl_name": "session_tasks",
      "sha256": "b4e3ee22336bed1f80af60fb3fe40543748fb36b2022747e43e2d0d02085c126"
    },
    {
      "type": "trigger",
      "name": "message_attachments_immutable_update",
      "tbl_name": "message_attachments",
      "sha256": "df38ea484e934e0131cf2334fb4ac5b370c964c842a9485b910b5a3268495384"
    },
    {
      "type": "trigger",
      "name": "message_attachments_reference_decrement",
      "tbl_name": "message_attachments",
      "sha256": "bf11a089e1ba6e6759299b2d312e2c65d52136120c2a53b61bf5eb6d00c7f4bc"
    },
    {
      "type": "trigger",
      "name": "message_attachments_reference_increment",
      "tbl_name": "message_attachments",
      "sha256": "9d22b45ec233564be12f31b2ef8776d7ba2f384a647de8cb1a79220324397bfd"
    },
    {
      "type": "trigger",
      "name": "mutation_effect_evidence_immutable_delete",
      "tbl_name": "mutation_effect_evidence",
      "sha256": "8966594717bb6bfc66fad9881ceafa7077847536565a06e14de208dd6de21ab2"
    },
    {
      "type": "trigger",
      "name": "mutation_effect_evidence_immutable_update",
      "tbl_name": "mutation_effect_evidence",
      "sha256": "0b1d820db04f0fa949cc57dae272cb595a89f8998330b390ce83bba8a08ff687"
    },
    {
      "type": "trigger",
      "name": "mutation_resolutions_immutable_delete",
      "tbl_name": "mutation_resolutions",
      "sha256": "9ae71901bced2505da07a8bcb7c2b2a042adb0cc50b4ba8a61e0b751d5ee111d"
    },
    {
      "type": "trigger",
      "name": "mutation_resolutions_immutable_update",
      "tbl_name": "mutation_resolutions",
      "sha256": "ab22776d1b7b959a79550e23713d56692b531181a166bbcda9e9d73b434fe6f6"
    },
    {
      "type": "trigger",
      "name": "mutation_transition_guard",
      "tbl_name": "mutation_attempts",
      "sha256": "c84636413e0c3fc1d33523b6de9fe7a453b78b2f687b3877c695fabe7f3d400c"
    },
    {
      "type": "trigger",
      "name": "profile_codex_account_key_insert_guard",
      "tbl_name": "profiles",
      "sha256": "06966bfaaaeb0ec3ba31b6ae01dd69d74038ab15e74eaa28c26a137ffff6e676"
    },
    {
      "type": "trigger",
      "name": "profile_codex_account_key_update_guard",
      "tbl_name": "profiles",
      "sha256": "b64fb33fe40c3881e44e3bc2a95a5622b9d8b6ada7b03b7c5722d61ae237edb6"
    },
    {
      "type": "trigger",
      "name": "profile_controller_authority_recovery_guard",
      "tbl_name": "profiles",
      "sha256": "782462275a65024ef78affccc4c2bad8a69153917e2db4fbe05bba18b0356e17"
    },
    {
      "type": "trigger",
      "name": "profile_personal_authority_revocation_revision_guard",
      "tbl_name": "profile_personal_authority_revocations",
      "sha256": "06952c7a29d734cf7389c9c8ce95a5143a3c771d243a54c21fb77057b0f7f836"
    },
    {
      "type": "trigger",
      "name": "profiles_label_key_immutable",
      "tbl_name": "profiles",
      "sha256": "bb84795ab144f8263a8c15fc5d38c50ab13d1cd0b97d2cb01df8fa16097f4b80"
    },
    {
      "type": "trigger",
      "name": "profiles_label_key_insert_guard",
      "tbl_name": "profiles",
      "sha256": "7ddf705451ad1394af2f866167eaf86f1cf091dbc83f83bf7f4c032469569cd8"
    },
    {
      "type": "trigger",
      "name": "projects_label_key_immutable",
      "tbl_name": "projects",
      "sha256": "989eabf8350ce4cbe5349bbeda3ed8ace4ee31ba8cf92659bb5b3f71261b140c"
    },
    {
      "type": "trigger",
      "name": "projects_label_key_insert_guard",
      "tbl_name": "projects",
      "sha256": "37303e662e692a4b85a42fa1d02adb2de9d9b13539221073ff1dacc68e4c9121"
    },
    {
      "type": "trigger",
      "name": "provider_interaction_transitions_immutable_delete",
      "tbl_name": "provider_interaction_transitions",
      "sha256": "3d78d50a798fc10955f2b9f075c905861c8e49bfaa2138615eecd30f7935f2a2"
    },
    {
      "type": "trigger",
      "name": "provider_interaction_transitions_immutable_update",
      "tbl_name": "provider_interaction_transitions",
      "sha256": "9c686c9ac28beeaea7385ee9d11079c70f77bf6f1fb3228f5b6144fea5af041d"
    },
    {
      "type": "trigger",
      "name": "provider_interactions_authority_guard",
      "tbl_name": "provider_interactions",
      "sha256": "5fcffa2816626d3bdf1fcba4edd74083a35c2e08e3f6ea6112f2d178a21e0929"
    },
    {
      "type": "trigger",
      "name": "provider_interactions_authority_immutable",
      "tbl_name": "provider_interactions",
      "sha256": "e2cbae39406ddf1260f371185181168aa893af46764eb8a5c88ffcd9a63c1853"
    },
    {
      "type": "trigger",
      "name": "provider_interactions_current_generation_prepare",
      "tbl_name": "provider_interactions",
      "sha256": "add1cf52f7acf36aeb20ab54df200c64d25e5d59419c12fa003f9b401fa79b9a"
    },
    {
      "type": "trigger",
      "name": "provider_interactions_intent_immutable",
      "tbl_name": "provider_interactions",
      "sha256": "d4c313d1ab826f5f0597d0ac5a21a66c369c88a7d27da741a8adea69aafd7a96"
    },
    {
      "type": "trigger",
      "name": "provider_interactions_intent_insert_guard",
      "tbl_name": "provider_interactions",
      "sha256": "528e6c5996251adab38ed4e9b587938f07cdcebacdf22e0141215bb04e7cd244"
    },
    {
      "type": "trigger",
      "name": "provider_interactions_intent_state_guard",
      "tbl_name": "provider_interactions",
      "sha256": "fad2f889e76ecdd40344954b47685d7fa6f7c3bb055f27792264d2008af9ffe9"
    },
    {
      "type": "trigger",
      "name": "provider_interactions_mcp_url_guard_insert",
      "tbl_name": "provider_interactions",
      "sha256": "966a96a3e9923b33e6f9484b8bc580123230b62bed2b0276ab4ffd0207e336d9"
    },
    {
      "type": "trigger",
      "name": "provider_interactions_mcp_url_guard_update",
      "tbl_name": "provider_interactions",
      "sha256": "73b6ec1de2b19b726fed92f17b57f4d6375a6c083281de57fbaf17a9e7a0bb83"
    },
    {
      "type": "trigger",
      "name": "provider_interactions_permission_value_guard_insert",
      "tbl_name": "provider_interactions",
      "sha256": "545b933eaf70379e0a847ef70b38d17dc3dc1efbfcabb51fe732d082eb5406d7"
    },
    {
      "type": "trigger",
      "name": "provider_interactions_permission_value_guard_update",
      "tbl_name": "provider_interactions",
      "sha256": "a5fec465a1c7a5f02ff1735891afab50bf4cb917374291a65ea6b93acb8526a9"
    },
    {
      "type": "trigger",
      "name": "provider_interactions_response_fields_guard",
      "tbl_name": "provider_interactions",
      "sha256": "6392803f2d926804dd8e7f0adaf96533599a0a45aec2e906d15da68948df4fed"
    },
    {
      "type": "trigger",
      "name": "provider_interactions_revision_guard",
      "tbl_name": "provider_interactions",
      "sha256": "74aaaa484dc0f299206ce3a4a9a34d5ebe0e170e936d1a1f702b4ce978877fe2"
    },
    {
      "type": "trigger",
      "name": "provider_interactions_transition_guard",
      "tbl_name": "provider_interactions",
      "sha256": "ab70a72b4af497b12685ca5fba7ab7044d7353ecc97eb2d4de8a0fffc6b09c97"
    },
    {
      "type": "trigger",
      "name": "provider_login_authority_generation_guard",
      "tbl_name": "provider_login_authorities",
      "sha256": "f6f225a45e17b88262abf6d102e643a2487f517e6055813bd3136f139cad3345"
    },
    {
      "type": "trigger",
      "name": "provider_login_authority_identity_immutable",
      "tbl_name": "provider_login_authorities",
      "sha256": "4dfce4f6fb6acbda0aa2cc54463d4c4ed3fa5314c23375145cb51caa2c828344"
    },
    {
      "type": "trigger",
      "name": "provider_login_authority_immutable_delete",
      "tbl_name": "provider_login_authorities",
      "sha256": "e7d9d245b70f7491a959d258d480750118b3dc3fe1297dab45ed98dc9874779b"
    },
    {
      "type": "trigger",
      "name": "provider_login_authority_state_guard",
      "tbl_name": "provider_login_authorities",
      "sha256": "4a0dbedfad65777ba4fc7a8112ceaf8e6dddfe25b9c5ceb254986ffe6e3ce938"
    },
    {
      "type": "trigger",
      "name": "provider_runtime_account_revocation_revision_guard",
      "tbl_name": "provider_runtime_account_revocations",
      "sha256": "7c96f8e520d7a9d2c2d47612ffc5d371fcfb91535e4f1266779ded0f2b35120f"
    },
    {
      "type": "trigger",
      "name": "queue_effect_evidence_immutable_delete",
      "tbl_name": "queue_effect_evidence",
      "sha256": "9bbd486b14a4792f49c62e9bc254bdddee332f46a832487e3973ac8c95735509"
    },
    {
      "type": "trigger",
      "name": "queue_effect_evidence_immutable_update",
      "tbl_name": "queue_effect_evidence",
      "sha256": "5b74c388e7f73f73b24976c74f6e0c73cba2153a8eaf7c9f092b24bd2de59e42"
    },
    {
      "type": "trigger",
      "name": "queue_effect_resolution_authority_guard",
      "tbl_name": "queue_effect_resolutions",
      "sha256": "563dc90a706471edcc9064da8c8fb92fd8f3f4356ce465f9105f1c0d78bc3b62"
    },
    {
      "type": "trigger",
      "name": "queue_effect_resolutions_immutable_delete",
      "tbl_name": "queue_effect_resolutions",
      "sha256": "8be3794e5d0134976bbdd0014135265ef17c5154d75f911568244d80488cce09"
    },
    {
      "type": "trigger",
      "name": "queue_effect_resolutions_immutable_update",
      "tbl_name": "queue_effect_resolutions",
      "sha256": "17af3e386c9480830ad7afb6bb45dd34735236fa89c92207f507ff687f59eabf"
    },
    {
      "type": "trigger",
      "name": "queue_enqueue_identity_insert_once",
      "tbl_name": "queue_entries",
      "sha256": "f2a4c4406c62121a27d830a4223d01b5132ad226521b22814d46913b24d69a46"
    },
    {
      "type": "trigger",
      "name": "queue_enqueue_sequence_immutable",
      "tbl_name": "queue_entries",
      "sha256": "276e60609ad225db623780c992bb88d9e30afceb09f9724c9203a40d109d8908"
    },
    {
      "type": "trigger",
      "name": "queue_enqueue_sequence_required",
      "tbl_name": "queue_entries",
      "sha256": "60bcd94a6ceec7926cf1c8d686af8567dad8e0fa41981fa05a0de801cc63164e"
    },
    {
      "type": "trigger",
      "name": "queue_message_resolution_scrub",
      "tbl_name": "queue_effect_resolutions",
      "sha256": "2cd9cafb8f3d090447f208cd8550d1b48a67fa31cce1a0261d45704e93211040"
    },
    {
      "type": "trigger",
      "name": "queue_message_settlement_guard",
      "tbl_name": "queue_entries",
      "sha256": "43c522563a6bb011de7944411c319c6bf63122f0d94354df1ea8741b47a8277a"
    },
    {
      "type": "trigger",
      "name": "queue_message_terminal_insert_scrub",
      "tbl_name": "queue_entries",
      "sha256": "3dbc1a0287cf027fdf5c38035a415ca8ef08147f4b22bcc9a7aaba0350061afa"
    },
    {
      "type": "trigger",
      "name": "queue_message_terminal_transition_scrub",
      "tbl_name": "queue_entries",
      "sha256": "dd3851ea4111c87fd3184b0a487b9a43a4a5c3b73c47b47873fae6d101047289"
    },
    {
      "type": "trigger",
      "name": "queue_sequence_authority_insert_once",
      "tbl_name": "queue_sequence_authority",
      "sha256": "7ae4d0a4d23f2bbbad8ccf43c94b20d8707674aff29c55ec26f59ef23e75d5e0"
    },
    {
      "type": "trigger",
      "name": "queue_sequence_authority_monotonic",
      "tbl_name": "queue_sequence_authority",
      "sha256": "9be45bc27111e7fecff03244002d534bd6d49dca1cb3a8c9862d27c23a875236"
    },
    {
      "type": "trigger",
      "name": "queue_sequence_authority_no_delete",
      "tbl_name": "queue_sequence_authority",
      "sha256": "d225b023eb861ac1ecdb6b141e985c9fee34346c2543762a1b85db2d52f65b5f"
    },
    {
      "type": "trigger",
      "name": "queue_sequence_authority_singleton_immutable",
      "tbl_name": "queue_sequence_authority",
      "sha256": "6397884bf2f2b860a66eec4d2bf389787435062e09f3e56258e9dcd93d547d7d"
    },
    {
      "type": "trigger",
      "name": "queue_transition_guard",
      "tbl_name": "queue_entries",
      "sha256": "f2a592ee7c53ec8d89ce88e515df40855a9dfc679a4257fe716925d278e0b235"
    },
    {
      "type": "trigger",
      "name": "session_account_authority_active_state_guard",
      "tbl_name": "sessions",
      "sha256": "8d50aba887660af49b610990cd3b98a099f179cce75e9c87f650d1d7716ae2a5"
    },
    {
      "type": "trigger",
      "name": "session_account_authority_insert",
      "tbl_name": "sessions",
      "sha256": "13047726a860a319c7aa155ad6982d3fbcbdc09913bbdebe0587b43a6a8a2bf9"
    },
    {
      "type": "trigger",
      "name": "session_account_authority_interaction_guard",
      "tbl_name": "provider_interactions",
      "sha256": "35d233113d7457e3956fae2dda105d9c071468a040b716eaa04202b5c1637634"
    },
    {
      "type": "trigger",
      "name": "session_account_authority_queue_guard",
      "tbl_name": "queue_entries",
      "sha256": "818a1f780d1c9b5dc1296fe9d72dcc48ba7e74a432c3f74a80638fde8b857d91"
    },
    {
      "type": "trigger",
      "name": "session_account_authority_rebind",
      "tbl_name": "sessions",
      "sha256": "213eee37bca56cb59f69ab78be2e4e4aabee3407818364e9774961b40000cbd2"
    },
    {
      "type": "trigger",
      "name": "session_account_authority_task_insert_guard",
      "tbl_name": "session_tasks",
      "sha256": "e81d5f181176ab6da95ee4aa68491319fa7a39018ce61c6eacee62107c34bb85"
    },
    {
      "type": "trigger",
      "name": "session_account_authority_task_update_guard",
      "tbl_name": "session_tasks",
      "sha256": "d5817d5febaca951314ef49490b7121d1e99456bf7ff6b56f2d3d25e6c124ba1"
    },
    {
      "type": "trigger",
      "name": "session_account_authority_update_guard",
      "tbl_name": "session_account_authorities",
      "sha256": "80d97917f438d76e46cff7e8afaba9c6e6fda6b4f8b67529f5921495dbabc1f4"
    },
    {
      "type": "trigger",
      "name": "session_adoption_candidate_identity_immutable",
      "tbl_name": "session_adoption_candidates",
      "sha256": "8e410fda991b365ad678062cf235c12f48e65652b082c6d3a03544d8d4e9b92d"
    },
    {
      "type": "trigger",
      "name": "session_adoption_candidate_revision_guard",
      "tbl_name": "session_adoption_candidates",
      "sha256": "c8f2d88fdfb877c9a064b29fc1a39a9b1c99e2ef1c1b5c2eb58cda81016fff37"
    },
    {
      "type": "trigger",
      "name": "session_adoption_candidate_source_identity_guard_insert",
      "tbl_name": "session_adoption_candidates",
      "sha256": "14c7e2845aae8d75b6c234f070ee12b645c809f5c9448ff2ae13e15534a2aa59"
    },
    {
      "type": "trigger",
      "name": "session_adoption_candidate_source_identity_guard_update",
      "tbl_name": "session_adoption_candidates",
      "sha256": "1ad1a05afe13f1e8fd3f7381e763967579736e7f838be1bbdcbe37db4fdda20e"
    },
    {
      "type": "trigger",
      "name": "session_adoption_policy_identity_immutable",
      "tbl_name": "session_adoption_policies",
      "sha256": "ebe08c5e4c0cf924351a52d7ef1b4d11bec69a596bc7412f3d9ba46120c227a8"
    },
    {
      "type": "trigger",
      "name": "session_adoption_policy_profile_guard_insert",
      "tbl_name": "session_adoption_policies",
      "sha256": "8def1a693ecd9132886e7cb92890cf0b22fad2ea7fe13646ee9c46b118cec562"
    },
    {
      "type": "trigger",
      "name": "session_adoption_policy_profile_guard_update",
      "tbl_name": "session_adoption_policies",
      "sha256": "c3361f39517b5f580377394bd1d0cf8269fd6a4594332eab680a5fe8bbef0718"
    },
    {
      "type": "trigger",
      "name": "session_adoption_policy_provider_revocation_guard_insert",
      "tbl_name": "session_adoption_policies",
      "sha256": "d2bba7c87a9e8b00ba467d2f06e0e2932a8ad3fdd37989393c5494660e710725"
    },
    {
      "type": "trigger",
      "name": "session_adoption_policy_provider_revocation_guard_update",
      "tbl_name": "session_adoption_policies",
      "sha256": "966143d4dea1a8e1e83b083f7aa86bb9c90c08c98f740f84fadcc0822bd1944f"
    },
    {
      "type": "trigger",
      "name": "session_adoption_policy_revision_guard",
      "tbl_name": "session_adoption_policies",
      "sha256": "616e760569ab3903e24c883932f99e66791e1f28103337aeaf8486ce23f86257"
    },
    {
      "type": "trigger",
      "name": "session_adoption_policy_unsettled_claim_guard",
      "tbl_name": "session_adoption_policies",
      "sha256": "a68aadbcba943e7b6839d883bcd4b7b5dc63e3df2d165b894cd0489279fd6370"
    },
    {
      "type": "trigger",
      "name": "session_adoption_profile_generation_guard",
      "tbl_name": "profiles",
      "sha256": "63d1dfe615e56fabca2560443eac81e736bde4618b19483e27b3b4d889428d58"
    },
    {
      "type": "trigger",
      "name": "session_adoption_profile_generation_permit_no_update",
      "tbl_name": "session_adoption_profile_generation_permits",
      "sha256": "e11ce72c3423e0dd1fc961953292522a28db90eb26e34e998dd01b59645a3ee8"
    },
    {
      "type": "trigger",
      "name": "session_adoption_profile_identity_guard",
      "tbl_name": "profiles",
      "sha256": "7ab8244b2b59dee32c2942747645371445999d61ed227895366d347c389bd213"
    },
    {
      "type": "trigger",
      "name": "session_adoption_profile_signed_out_policy_disable",
      "tbl_name": "profiles",
      "sha256": "e4a826fb772868204933f7a5e99d43178dc56ceb1f36170619d3510f3826f9c5"
    },
    {
      "type": "trigger",
      "name": "session_adoption_profile_signout_guard",
      "tbl_name": "profiles",
      "sha256": "1b87f4ce773d2596cf0f0e8f44393242f02eb8546aa223fc517c1ae988b82904"
    },
    {
      "type": "trigger",
      "name": "session_adoption_profile_unidentified_policy_disable",
      "tbl_name": "profiles",
      "sha256": "5c2c5aa99406bc86fb9a9fcac20c87142979f3d781bb6644052f337eab708011"
    },
    {
      "type": "trigger",
      "name": "session_claude_process_authority_revision_guard",
      "tbl_name": "session_claude_process_authorities",
      "sha256": "e7f4cc0e7f677f42d6f48ca31e36c15b488b54f8902659a447719f19f3c7bb0f"
    },
    {
      "type": "trigger",
      "name": "session_claude_process_authority_session_guard_insert",
      "tbl_name": "session_claude_process_authorities",
      "sha256": "a258e48617eac997ef2bdaa5c1ea94db7e92b5b5eb862f2683258302dfe022bb"
    },
    {
      "type": "trigger",
      "name": "session_claude_process_authority_session_guard_update",
      "tbl_name": "session_claude_process_authorities",
      "sha256": "d262d38102cba15759c4397cc3f9e0a5216eec0d5fcbec2bd67e632c136ddc05"
    },
    {
      "type": "trigger",
      "name": "session_claude_process_launch_intent_no_update",
      "tbl_name": "session_claude_process_launch_intents",
      "sha256": "9f2ceaee1be06514533c9864f8fd2e4737126dd6048d077e72c4b10a418c799a"
    },
    {
      "type": "trigger",
      "name": "session_claude_process_launch_intent_process_guard",
      "tbl_name": "session_claude_process_launch_intents",
      "sha256": "7a41ce7b3f98523a8251d2d22ac392a0c4fe96518a0464b6e2bdc32eb4047b14"
    },
    {
      "type": "trigger",
      "name": "session_claude_process_launch_intent_profile_guard",
      "tbl_name": "session_claude_process_launch_intents",
      "sha256": "ad513a529b6fa646260de8e75f2498a0f80ed4890e107049417881dba8aeb754"
    },
    {
      "type": "trigger",
      "name": "session_events_account_authority_guard",
      "tbl_name": "session_events",
      "sha256": "e476f205d5928d467d60d1b720e999e183389d1476e5215137db11ec8f5515cf"
    },
    {
      "type": "trigger",
      "name": "session_events_accounting_delete",
      "tbl_name": "session_events",
      "sha256": "8484a1c59460bba8ce362051aa9330a9df27e48098e0ffcb597700f2e54a836d"
    },
    {
      "type": "trigger",
      "name": "session_events_accounting_insert",
      "tbl_name": "session_events",
      "sha256": "681c1be19c187f31065bca2d26f4134df6d6e7c707fd2e16c5de0fe24c49d951"
    },
    {
      "type": "trigger",
      "name": "session_events_immutable_update",
      "tbl_name": "session_events",
      "sha256": "6843436cb79ff0cf09d35a6e924e6a5fef1ea3150385e2c641a187537e5b870f"
    },
    {
      "type": "trigger",
      "name": "session_mutation_authority_rebinds_immutable_delete",
      "tbl_name": "session_mutation_authority_rebinds",
      "sha256": "b6cc024d803ded6ad1fa530a6641f6e0a9e0a9a21254c60bb44a297e60997c56"
    },
    {
      "type": "trigger",
      "name": "session_mutation_authority_rebinds_immutable_update",
      "tbl_name": "session_mutation_authority_rebinds",
      "sha256": "7c962b74845b74cf9f8d06b90b62344f40d360a19db55cee96ed3f57fb8e227f"
    },
    {
      "type": "trigger",
      "name": "session_personal_runtime_binding_authority_guard",
      "tbl_name": "session_personal_runtime_bindings",
      "sha256": "4d5902c4f339dadfc95de3014b267370bd770f6b6a7015c7a410560ff8796448"
    },
    {
      "type": "trigger",
      "name": "session_personal_runtime_binding_identity_immutable",
      "tbl_name": "session_personal_runtime_bindings",
      "sha256": "eb41498aed6a4885f9e2a90f65acef6d3006366102a3fb67cbd5d36143eda685"
    },
    {
      "type": "trigger",
      "name": "session_personal_runtime_binding_launch_intent_detach_guard",
      "tbl_name": "session_personal_runtime_bindings",
      "sha256": "c70eaaaef1e721c5895976daceda81154cf45430c6d0acc998adfb8ec19d6e00"
    },
    {
      "type": "trigger",
      "name": "session_personal_runtime_binding_revision_guard",
      "tbl_name": "session_personal_runtime_bindings",
      "sha256": "a6f0990ba9fe255003280cee6a8796b3ab2bad1fba732793e820614c18e221cb"
    },
    {
      "type": "trigger",
      "name": "session_provider_account_authority_insert_guard",
      "tbl_name": "session_provider_account_authorities",
      "sha256": "59e2860c348276e2899781188e7d972dd84723c47e3885f03f102f7241c32ce4"
    },
    {
      "type": "trigger",
      "name": "session_provider_account_authority_update_guard",
      "tbl_name": "session_provider_account_authorities",
      "sha256": "1d9ca95d76e8cbb5d811b0e2a1a6f7d9f36d40818793f86ddf9d86a3654de0bf"
    },
    {
      "type": "trigger",
      "name": "session_provider_switch_seed_intents_immutable_delete",
      "tbl_name": "session_provider_switch_seed_intents",
      "sha256": "0dad9e42a3febec657b79a6e69eb3b571e5cab8484f47087ae02e7d14604fb86"
    },
    {
      "type": "trigger",
      "name": "session_provider_switch_seed_intents_immutable_update",
      "tbl_name": "session_provider_switch_seed_intents",
      "sha256": "af55d102152a0b5785892256400e6e0267b73cf3a82e163fe64439562de00f1b"
    },
    {
      "type": "trigger",
      "name": "session_provider_switch_seed_results_immutable_delete",
      "tbl_name": "session_provider_switch_seed_results",
      "sha256": "7bba9fd8f71b6f1ffa6c264c7adaed61f92c380c7801585953767e4e35be16cc"
    },
    {
      "type": "trigger",
      "name": "session_provider_switch_seed_results_immutable_update",
      "tbl_name": "session_provider_switch_seed_results",
      "sha256": "cb693d9beddfbac071957e63163927e746bf0afa74a4d34e522d1565a918d180"
    },
    {
      "type": "trigger",
      "name": "session_provider_switch_source_releases_immutable_delete",
      "tbl_name": "session_provider_switch_source_releases",
      "sha256": "6203a8111fe8935b7262f7bb012b4d77e46a38ae47b2fb92f18e3ee0383cdd52"
    },
    {
      "type": "trigger",
      "name": "session_provider_switch_source_releases_immutable_update",
      "tbl_name": "session_provider_switch_source_releases",
      "sha256": "2141f85268feb59f2604f67aff4e7742c1ee673b2c7430a8fdfed403c5260f30"
    },
    {
      "type": "trigger",
      "name": "session_provider_switch_target_releases_immutable_delete",
      "tbl_name": "session_provider_switch_target_releases",
      "sha256": "bff5086f8b412e6cdb097f74f9eb49686783da6340fe9ca19174ac3b9fdb37be"
    },
    {
      "type": "trigger",
      "name": "session_provider_switch_target_releases_immutable_update",
      "tbl_name": "session_provider_switch_target_releases",
      "sha256": "264a35341b7b26cbe607f595949175ec18788481704862df5093aeba943a7510"
    },
    {
      "type": "trigger",
      "name": "session_provider_switch_targets_immutable_delete",
      "tbl_name": "session_provider_switch_targets",
      "sha256": "16f181b55858e599d2b2355467afcc49c46952b2d0f5a2c39a27f63eecb4b265"
    },
    {
      "type": "trigger",
      "name": "session_provider_switch_targets_immutable_update",
      "tbl_name": "session_provider_switch_targets",
      "sha256": "a0a6f0e3e51053d0676292f0c5c5f63aa5eeb1a3bb643528644946bee7f235fa"
    },
    {
      "type": "trigger",
      "name": "session_runtime_profile_authority_guard",
      "tbl_name": "session_runtime_profiles",
      "sha256": "663b43a41212aa5359832212ec22a67e060722aaa988fa2317d84cc2056c67c5"
    },
    {
      "type": "trigger",
      "name": "session_runtime_profiles_immutable_delete",
      "tbl_name": "session_runtime_profiles",
      "sha256": "4111d939674b61597e282d2114742e0e5518f137654665ab5baf76d08799dcbc"
    },
    {
      "type": "trigger",
      "name": "session_runtime_profiles_immutable_update",
      "tbl_name": "session_runtime_profiles",
      "sha256": "df50d0bf65497ef7c820a24eb6d9e4eb43da0be7ba68eb40ad24cf5c49f5e67b"
    },
    {
      "type": "trigger",
      "name": "session_start_attempts_immutable_delete",
      "tbl_name": "session_start_attempts",
      "sha256": "955321bbad11a971cf3555366002e3946e5eaf246d8ad088e80d61f777adf179"
    },
    {
      "type": "trigger",
      "name": "session_start_attempts_immutable_update",
      "tbl_name": "session_start_attempts",
      "sha256": "a2e5803b938f027a62d6be71c778b3db225719e32fdaec45bc8760b35983621e"
    },
    {
      "type": "trigger",
      "name": "session_task_occurrences_insert_guard",
      "tbl_name": "session_task_occurrences",
      "sha256": "01ca46baa563a1a048f3e3ce84b8a7f906cb0b1bdd80e86e2bd57724f500858d"
    },
    {
      "type": "trigger",
      "name": "session_task_occurrences_no_update",
      "tbl_name": "session_task_occurrences",
      "sha256": "ade7e8e8bfbd68f35a581a38e2f63ee7db6df6bf663aad54a550a1a776aa718b"
    },
    {
      "type": "trigger",
      "name": "session_task_receipts_capacity_guard",
      "tbl_name": "session_task_receipts",
      "sha256": "eb464b5dc916dd0d5c7861722651448432a81fec9c62bc93706cebb93d85d110"
    },
    {
      "type": "trigger",
      "name": "session_task_receipts_no_update",
      "tbl_name": "session_task_receipts",
      "sha256": "1357895f5cee1b38f1521afbee9fab4affc8cfdb9a0292c720f75f91a50def43"
    },
    {
      "type": "trigger",
      "name": "session_tasks_due_advance_guard",
      "tbl_name": "session_tasks",
      "sha256": "8b8c6e6262da5c3a2c1a2331015e514a0bc6a78ec97395e1ea8faa90c7ef77b3"
    },
    {
      "type": "trigger",
      "name": "session_tasks_limit_guard",
      "tbl_name": "session_tasks",
      "sha256": "f8b36f25513f67282a7a9d766b9bcbc7d2a17e7814434b7cf1d6111d43c27481"
    },
    {
      "type": "trigger",
      "name": "session_tasks_update_guard",
      "tbl_name": "session_tasks",
      "sha256": "4f06cab520f6095bac3f6410ead6ce11f378b301800549b1576d445562383b35"
    },
    {
      "type": "trigger",
      "name": "session_turn_runtime_profile_authority_guard",
      "tbl_name": "session_turn_runtime_profiles",
      "sha256": "29eb23973c773bc622f9990b70eb875be0fab3015941cb0a1ff09257c9b6dd15"
    },
    {
      "type": "trigger",
      "name": "session_turn_runtime_profiles_immutable_delete",
      "tbl_name": "session_turn_runtime_profiles",
      "sha256": "4bb1b22ac4fc55aab0a53e35c4785a1a0d1f8ef764654e87ba482a3c3c8c72b4"
    },
    {
      "type": "trigger",
      "name": "session_turn_runtime_profiles_immutable_update",
      "tbl_name": "session_turn_runtime_profiles",
      "sha256": "9d87c223401dbe15bb312b04a69ba25b1b521b1d6641ee74dc358beda75ed9c6"
    },
    {
      "type": "trigger",
      "name": "sessions_claude_process_authority_rebind_guard",
      "tbl_name": "sessions",
      "sha256": "f14ed153f1d8644909fdc7d662c4ecbd8db052673bd5206a327a026b183afe47"
    },
    {
      "type": "trigger",
      "name": "sessions_personal_runtime_binding_rebind_guard",
      "tbl_name": "sessions",
      "sha256": "8fcaa3ac1e4b3d817ebcde1446a35a9887dd2c312f565f15eb21378b24e4951a"
    },
    {
      "type": "trigger",
      "name": "work_active_limit_guard",
      "tbl_name": "works",
      "sha256": "2de618023a2b2f08bec41cdd01a2be8c91e12c143fe61a01ef66e091ea49a854"
    },
    {
      "type": "trigger",
      "name": "work_attempt_account_authority_guard",
      "tbl_name": "work_attempts",
      "sha256": "ce34542d757b7dd0c2a08445f2f1d4153444d759b0d5d899c19c05265dc1608a"
    },
    {
      "type": "trigger",
      "name": "work_attempt_authority_immutable",
      "tbl_name": "work_attempts",
      "sha256": "9344370c06896b8889db067b477edb3b79e8ca60e20ab3249c658061bd775a2e"
    },
    {
      "type": "trigger",
      "name": "work_attempt_dispatch_binding_guard",
      "tbl_name": "work_attempts",
      "sha256": "60ff573e49a369e313e78d2cd7a8ee35afaf701ec721c6c83ca702ee6678a5f0"
    },
    {
      "type": "trigger",
      "name": "work_attempt_fence_monotonic",
      "tbl_name": "work_attempts",
      "sha256": "49887529f48bdbcd008d0ee58d2c8e67864ecb94419a89e88e0c42418c20faa3"
    },
    {
      "type": "trigger",
      "name": "work_attempt_no_delete",
      "tbl_name": "work_attempts",
      "sha256": "bc93f691b7513258d60597f57553ac4f6a25392dd5a5de364c9292f50cddc4e7"
    },
    {
      "type": "trigger",
      "name": "work_attempt_reports_no_delete",
      "tbl_name": "work_attempt_reports",
      "sha256": "ba41b939650ecd68b7f1019dd594dd83cfd6b6375eb80c3bb6ce6c0e4e0bf7ca"
    },
    {
      "type": "trigger",
      "name": "work_attempt_reports_no_update",
      "tbl_name": "work_attempt_reports",
      "sha256": "16daa9ba1b59d764478bfe757fdf4878d447c009f119ddb46048f31a281e6a01"
    },
    {
      "type": "trigger",
      "name": "work_attempt_revision_guard",
      "tbl_name": "work_attempts",
      "sha256": "af6f69eedf44ce0acfc04edfedad329728e7d16f6d632e4547f8cfae24f2f1fc"
    },
    {
      "type": "trigger",
      "name": "work_attempt_route_guard",
      "tbl_name": "work_attempts",
      "sha256": "b7c81108bd768a744ca692c1227dd820a36c59282c7acbbee2cfe64dc97fe092"
    },
    {
      "type": "trigger",
      "name": "work_attempt_state_guard",
      "tbl_name": "work_attempts",
      "sha256": "9cb05c5fd33436fab4d0ea3abd008eafb4908fb370531b909762c002594beac2"
    },
    {
      "type": "trigger",
      "name": "work_attempt_submission_guard",
      "tbl_name": "work_attempts",
      "sha256": "81abb3a42ce5a6535c2e203dd5ab6a09171b44126bb2b7f91ae486a276f60fc3"
    },
    {
      "type": "trigger",
      "name": "work_coordinator_account_authority_guard",
      "tbl_name": "works",
      "sha256": "38273e596e7c4d958a525982db32034fb5b2311fdab3818ec2b28f75452c01e1"
    },
    {
      "type": "trigger",
      "name": "work_dependencies_no_delete",
      "tbl_name": "work_task_dependencies",
      "sha256": "b6cf8adbab1458b3c94e7f5c92a1f60d53cbdc9477e81a3feac8dfaf0f306dd6"
    },
    {
      "type": "trigger",
      "name": "work_dependencies_no_update",
      "tbl_name": "work_task_dependencies",
      "sha256": "becfa49fb93305f5bad10d2063886b59abc86b16f19a6fe4d2ad3d51ea88588e"
    },
    {
      "type": "trigger",
      "name": "work_effect_capacity_guard",
      "tbl_name": "work_prepared_effects",
      "sha256": "fb4b912be1d30346679d7e8c3c65d538102942f7926470cc1c2f8e182344d0b4"
    },
    {
      "type": "trigger",
      "name": "work_effect_identity_immutable",
      "tbl_name": "work_prepared_effects",
      "sha256": "7bf9215d6ad539dbfeb4e1bc41032a31bca1bca3a6932a144160afbb37fc33b7"
    },
    {
      "type": "trigger",
      "name": "work_effect_no_delete",
      "tbl_name": "work_prepared_effects",
      "sha256": "440ffefbc727c12250e2b84ec6c0f2ae2b9e075fb8f33ff476be9c77d5ca8228"
    },
    {
      "type": "trigger",
      "name": "work_effect_outcome_guard",
      "tbl_name": "work_prepared_effects",
      "sha256": "d5c5722cf56bdf5c6849b818b792325b39ce548cf2abf5c428c0ed326df930d7"
    },
    {
      "type": "trigger",
      "name": "work_effect_resolutions_insert_guard",
      "tbl_name": "work_effect_resolutions",
      "sha256": "7d0021c6fc6200f214455452566a9a371df6709f5baa7859103af6826f863db9"
    },
    {
      "type": "trigger",
      "name": "work_effect_resolutions_no_delete",
      "tbl_name": "work_effect_resolutions",
      "sha256": "270bf173e20e391966fc5428d4477bebcb4cddd968a1fea11a7be63cc72d30c2"
    },
    {
      "type": "trigger",
      "name": "work_effect_resolutions_no_update",
      "tbl_name": "work_effect_resolutions",
      "sha256": "999202db0edb5edba4a2f637bc615f295d2e09050b1245550b3e84abca86d19d"
    },
    {
      "type": "trigger",
      "name": "work_effect_state_guard",
      "tbl_name": "work_prepared_effects",
      "sha256": "5c46fcc36abdb229d097c6f804a6879e8eed2486c6ea677d4605ba527caa8591"
    },
    {
      "type": "trigger",
      "name": "work_event_capacity_guard",
      "tbl_name": "work_events",
      "sha256": "5284bdceb4b07922a85e3fe8a9029eb184776b02fe8c957eeefbbd6eb76fd1d2"
    },
    {
      "type": "trigger",
      "name": "work_event_chain_guard",
      "tbl_name": "work_events",
      "sha256": "f7ea95851b929636738edfea80fdaba61821a12f7f835dc40eeac45903efa106"
    },
    {
      "type": "trigger",
      "name": "work_events_no_delete",
      "tbl_name": "work_events",
      "sha256": "9de96ea1d635768e47505c46927a9e38c60b0e7d68092260092b0a27be546a64"
    },
    {
      "type": "trigger",
      "name": "work_events_no_update",
      "tbl_name": "work_events",
      "sha256": "e56d1b422fa8f4c07da95a9113889605a61c411c9f478a2567062e5e6f4a95a6"
    },
    {
      "type": "trigger",
      "name": "work_intents_no_delete",
      "tbl_name": "work_idempotency_intents",
      "sha256": "7018dbd86a6552c05b0682ae3e4c75135a9408e9111acfaac2c2d1aeaefffd68"
    },
    {
      "type": "trigger",
      "name": "work_intents_no_update",
      "tbl_name": "work_idempotency_intents",
      "sha256": "87930c9453865eedc55cd3a4c9a9990aa42412944d99217d1f5504925d272e6b"
    },
    {
      "type": "trigger",
      "name": "work_member_account_authority_guard",
      "tbl_name": "work_members",
      "sha256": "1c2d595f32d87a30163f4208d26d3dbdfc5cabb1c84d4281da8486f36bb6355d"
    },
    {
      "type": "trigger",
      "name": "work_member_limit_guard",
      "tbl_name": "work_members",
      "sha256": "feda6661eb576da4226c785542a5d41ba0f37a5ffa00758d77ea3e5ca38a6561"
    },
    {
      "type": "trigger",
      "name": "work_members_no_delete",
      "tbl_name": "work_members",
      "sha256": "1cee81bd8be3cb7445b16b067aaf3ad1b225ef3faeedf11b4f413e4bd0b33de8"
    },
    {
      "type": "trigger",
      "name": "work_members_no_update",
      "tbl_name": "work_members",
      "sha256": "11451107a0282ef384f67be24a5283a74ac4275548343604472d74c9315be528"
    },
    {
      "type": "trigger",
      "name": "work_nested_effect_settlements_insert_guard",
      "tbl_name": "work_nested_effect_settlements",
      "sha256": "6f3ca0c4563fa7ede3b19d8294d687ec45897c8163708112ab6bfe5b272a85d8"
    },
    {
      "type": "trigger",
      "name": "work_nested_effect_settlements_no_delete",
      "tbl_name": "work_nested_effect_settlements",
      "sha256": "99ce41de4275542c6d0f8892c315d8902dbf60f5a5e267b740067a852a829b67"
    },
    {
      "type": "trigger",
      "name": "work_nested_effect_settlements_no_update",
      "tbl_name": "work_nested_effect_settlements",
      "sha256": "74b87ae355bf27704818dc406764c53a738916fc5b1109946278327fd090c974"
    },
    {
      "type": "trigger",
      "name": "work_profile_attempt_authority_guard",
      "tbl_name": "profiles",
      "sha256": "6efbaa97c8a4a82627767f0ad96423562765458740606d3a6db398a8002c24fd"
    },
    {
      "type": "trigger",
      "name": "work_receipt_chain_guard",
      "tbl_name": "work_signal_receipts",
      "sha256": "a2b3b5335f463d12ef0dd365fb6bbf0b23a3e1046b8ba0ddeff248bc0ee969cd"
    },
    {
      "type": "trigger",
      "name": "work_receipts_no_delete",
      "tbl_name": "work_signal_receipts",
      "sha256": "516a91b8f3b3d7f8bc04c68b1eb69cc7696079a7fd2a2ebaa133f307bdea9549"
    },
    {
      "type": "trigger",
      "name": "work_receipts_no_update",
      "tbl_name": "work_signal_receipts",
      "sha256": "6ec76c313e0c2a911c394475120a6060befe48149833f02a8f5b88bb8e80a58d"
    },
    {
      "type": "trigger",
      "name": "work_release_tombstones_no_update",
      "tbl_name": "work_release_tombstones",
      "sha256": "a69a36b25fe0fb8de51975a050d15da3c379187d74ddf77dd328db5806be5817"
    },
    {
      "type": "trigger",
      "name": "work_retained_limit_guard",
      "tbl_name": "works",
      "sha256": "dc73bc9cde1d1cfabbbc14e4870786c34386a8cda60fce3cea19e9cdc3ac2344"
    },
    {
      "type": "trigger",
      "name": "work_review_account_authority_guard",
      "tbl_name": "work_reviews",
      "sha256": "3ccbcfa1b9b079509cd97d997c73ad67a1a30892a74ed674f8ab46fb2f34d5c7"
    },
    {
      "type": "trigger",
      "name": "work_review_member_guard",
      "tbl_name": "work_reviews",
      "sha256": "a7b631bde4113d1b6c2672c74cb6f88cdb5d4253471c96c1850b7cf3db01b11f"
    },
    {
      "type": "trigger",
      "name": "work_reviews_no_delete",
      "tbl_name": "work_reviews",
      "sha256": "e0d2b026b7c704ba3c9668b15c6b45d1e703759bb7d614d4d3611eb816d704a9"
    },
    {
      "type": "trigger",
      "name": "work_reviews_no_update",
      "tbl_name": "work_reviews",
      "sha256": "3ee3e182f7e53a2e49406d8ef02842ffcea16130aa185104ac4ded22595935b0"
    },
    {
      "type": "trigger",
      "name": "work_route_authority_guard",
      "tbl_name": "work_routes",
      "sha256": "266991b2110af97b6383871e5cfa03292b5ecec1d83060031c9ea4ae38c0c200"
    },
    {
      "type": "trigger",
      "name": "work_route_limit_guard",
      "tbl_name": "work_routes",
      "sha256": "496eb219d4c4da5437220ed9ed9a1e032a929817e0ffe46c9049ceef27f2c1b2"
    },
    {
      "type": "trigger",
      "name": "work_routes_no_delete",
      "tbl_name": "work_routes",
      "sha256": "9f5579a9685333895747a5be889e0981f80381d2b68c4d436177ee1da8109f6a"
    },
    {
      "type": "trigger",
      "name": "work_routes_no_update",
      "tbl_name": "work_routes",
      "sha256": "4a2be91ba6686979be9c475a4d401b79de2b145984aa6654f73cd0fce2c729f9"
    },
    {
      "type": "trigger",
      "name": "work_session_attempt_authority_guard",
      "tbl_name": "sessions",
      "sha256": "85eb3f652599a8e52f16e87b371738b658a5dd9b0c918c61040fc280616dd975"
    },
    {
      "type": "trigger",
      "name": "work_signal_account_authority_guard",
      "tbl_name": "work_signals",
      "sha256": "fe56979e59644d39710664ab5d4c0a987f0bd3c0b9e60714a784ac473aaca5a7"
    },
    {
      "type": "trigger",
      "name": "work_signal_ack_account_authority_guard",
      "tbl_name": "work_signal_receipts",
      "sha256": "bf6db16aeb87baf91e68e225d89627de3b9be08ed6b2b8dfab1c4d51d5eec4f5"
    },
    {
      "type": "trigger",
      "name": "work_signal_ack_guard",
      "tbl_name": "work_signal_receipts",
      "sha256": "1eca45dec9d6fa30aafe084e6eec49185231ccb0c6afae1461f71f252e218884"
    },
    {
      "type": "trigger",
      "name": "work_signal_member_guard",
      "tbl_name": "work_signals",
      "sha256": "8779917349e17510d3a426da31e8de12cf8ee3f35713d353da83b47ed7792028"
    },
    {
      "type": "trigger",
      "name": "work_signals_no_delete",
      "tbl_name": "work_signals",
      "sha256": "40e1dba9720459948f76a3ffe79a6b5558f9aa151e618e3724b5edb13bcb6cd9"
    },
    {
      "type": "trigger",
      "name": "work_signals_no_update",
      "tbl_name": "work_signals",
      "sha256": "05e99f807834ea551daf62267de1cd56e106a4d9cd39feb6eb41684abceab06b"
    },
    {
      "type": "trigger",
      "name": "work_submissions_no_delete",
      "tbl_name": "work_submissions",
      "sha256": "04384ab3e6fcae98b7698b8e89c390200c80403364cbd332332ad1ed7c06cae7"
    },
    {
      "type": "trigger",
      "name": "work_submissions_no_update",
      "tbl_name": "work_submissions",
      "sha256": "b0e88bae4b7475e1260c6149ac84b9305e787bd2054162b1541e976b8daa8c61"
    },
    {
      "type": "trigger",
      "name": "work_task_history_index_attempt",
      "tbl_name": "work_attempts",
      "sha256": "759ed60f8dfbc617353a7e3941bea1218fefbf900e0ae76585755ef593ec9478"
    },
    {
      "type": "trigger",
      "name": "work_task_history_index_attempt_report",
      "tbl_name": "work_attempt_reports",
      "sha256": "2c2eb878257d2305d124a7fc97535e9c2a7cd49f02e8af863a58fcf178f66d01"
    },
    {
      "type": "trigger",
      "name": "work_task_history_index_no_delete",
      "tbl_name": "work_task_history_index",
      "sha256": "9437287d367f3db20f919208ec058f2244244e0d7bccdf7f1470994f947b0c19"
    },
    {
      "type": "trigger",
      "name": "work_task_history_index_no_update",
      "tbl_name": "work_task_history_index",
      "sha256": "51a1c07b84fbf943c6087bbe52bea698cc13cf88a9a31e5b04e17da15a80d46f"
    },
    {
      "type": "trigger",
      "name": "work_task_history_index_review",
      "tbl_name": "work_reviews",
      "sha256": "10d9dec46436c85ef289486826cf4472c1fc1b66da2c1087eab144d364e4457b"
    },
    {
      "type": "trigger",
      "name": "work_task_history_index_signal",
      "tbl_name": "work_signals",
      "sha256": "67727f5b74f124e8d21369281d85ab03f695d80a4807c7ce16b10a9748eff4e5"
    },
    {
      "type": "trigger",
      "name": "work_task_history_index_submission",
      "tbl_name": "work_submissions",
      "sha256": "9123cd464f2fde3f1b9456440d04de71c764258fec5f77ab00f5c8223b66c014"
    },
    {
      "type": "trigger",
      "name": "work_task_history_versions_capacity",
      "tbl_name": "work_task_history_versions",
      "sha256": "9f3c41c0b444529a97effbb588c4e4670d450a1485da529f980a7fc69ee400b3"
    },
    {
      "type": "trigger",
      "name": "work_task_history_versions_no_delete",
      "tbl_name": "work_task_history_versions",
      "sha256": "c49b70def74ecd34370e2d6e2d3cb445584574096779f19dd8dcbfc7ccb5e9e7"
    },
    {
      "type": "trigger",
      "name": "work_task_history_versions_no_update",
      "tbl_name": "work_task_history_versions",
      "sha256": "3634ae3d5cc79fb22099457f4cdc424ba06deea1466b8f53bdeffecd1f9534c0"
    },
    {
      "type": "trigger",
      "name": "work_task_state_identity_immutable",
      "tbl_name": "work_task_states",
      "sha256": "a9ca1bf5e7dbdcd16063d555c8e157e1940e2eb4d0746f4595960993e8886065"
    },
    {
      "type": "trigger",
      "name": "work_task_state_revision_guard",
      "tbl_name": "work_task_states",
      "sha256": "2683cff535b06fbd3040d19c1a8102ec2570c702c9abd675956b01c7bdca6be7"
    },
    {
      "type": "trigger",
      "name": "work_tasks_no_delete",
      "tbl_name": "work_tasks",
      "sha256": "7e1185f903e616ad466e6093bedf134ec11bae8147dc2e4c13d3262abbb1e2c0"
    },
    {
      "type": "trigger",
      "name": "work_tasks_no_update",
      "tbl_name": "work_tasks",
      "sha256": "e54d39c02036926c82fe173669d974c851c5c6823821d7daf8a6ae1eb43cacb3"
    },
    {
      "type": "trigger",
      "name": "work_terminal_requests_no_delete",
      "tbl_name": "work_terminal_requests",
      "sha256": "761065603a49e5d60ac37aac543a9c2e6db7d50eec46fbb4eac0da2054d123e3"
    },
    {
      "type": "trigger",
      "name": "work_terminal_requests_no_update",
      "tbl_name": "work_terminal_requests",
      "sha256": "d1e11fb04748322f5c1f709f08ce59f3cfe915355350d4a2a08390bfe63d8f14"
    },
    {
      "type": "trigger",
      "name": "works_identity_immutable",
      "tbl_name": "works",
      "sha256": "ef6228fd438de1831b7946f20ddc71a4ed75493413617660543665bbee5d48b8"
    },
    {
      "type": "trigger",
      "name": "works_no_delete",
      "tbl_name": "works",
      "sha256": "9ae62568a97549a8ca93e7d804549f743920ee40778396b01632c2d1b9c95011"
    },
    {
      "type": "trigger",
      "name": "works_state_guard",
      "tbl_name": "works",
      "sha256": "36bde9ce6393ecc05309d6a22d198e0f8a694481db79d97e5d8e32444325b7d5"
    },
    {
      "type": "trigger",
      "name": "works_stream_advance_guard",
      "tbl_name": "works",
      "sha256": "5d59160940581a47ef610cb1efd5dcb34c65058e710d98cecebb780d5eddc2a9"
    }
  ]
} as const;

const compressedSchema = "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";
const objectSchema = z.object({ type: z.enum(["table", "index", "trigger"]),
  name: z.string().regex(/^[a-z0-9_]+$/u), tbl_name: z.string().regex(/^[a-z0-9_]+$/u),
  sql: z.string().min(1).max(65536) }).strict();
export function syntheticAdoption36SchemaObjects() {
  const bytes = gunzipSync(Buffer.from(compressedSchema, "base64"), { maxOutputLength: 1024 * 1024 });
  if (bytes.length !== syntheticAdoption36SchemaFixture.schemaBytes
    || createHash("sha256").update(bytes).digest("hex") !== syntheticAdoption36SchemaFixture.schemaSha256) {
    throw new Error("SYNTHETIC_ADOPTION36_SCHEMA_INVALID");
  }
  const objects = z.array(objectSchema).length(syntheticAdoption36SchemaFixture.objectCount)
    .parse(JSON.parse(bytes.toString("utf8")) as unknown);
  const manifest = objects.map(({ type, name, tbl_name, sql }) => ({ type, name, tbl_name,
    sha256: createHash("sha256").update(sql).digest("hex") }));
  if (JSON.stringify(manifest) !== JSON.stringify(syntheticAdoption36SchemaFixture.manifest)) {
    throw new Error("SYNTHETIC_ADOPTION36_MANIFEST_INVALID");
  }
  return objects;
}
