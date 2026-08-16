#ifndef HRA_MACOS_KEYCHAIN_CUSTODIAN_H
#define HRA_MACOS_KEYCHAIN_CUSTODIAN_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/// Native entrypoint used only by the dedicated oprte-keychain-custodian
/// executable. It accepts one bounded request on stdin and writes one bounded
/// response to stdout. Service and both owned accounts are fixed internally.
int hra_keychain_custodian_main(void);

/// Runs the sealed helper with an empty environment and pipe-only protocol.
/// Release callers must pass allow_unsealed_development=false. The flag exists
/// solely for a directly executed Debug host that has no outer .app seal.
bool hra_macos_run_attested_keychain_custodian(
    const char *path,
    size_t path_length,
    const uint8_t *request,
    size_t request_length,
    uint8_t *response,
    size_t response_capacity,
    size_t *out_response_length,
    uint32_t timeout_milliseconds,
    bool allow_unsealed_development);

/// Arms a fresh runtime-generation fence. Cancellation remains sticky until
/// the next explicit preparation, including when it happens before spawn.
void hra_macos_prepare_attested_keychain_custodian_operations(void);

void hra_macos_cancel_attested_keychain_custodian(void);

/// Fixed, pathless failure boundary for the attested legacy gateway. Values
/// are diagnostic only and never replace the ordinary custody error.
typedef enum {
  HRALegacyHarnessCustodyFailureNone = 0,
  HRALegacyHarnessCustodyFailureAdmission,
  HRALegacyHarnessCustodyFailureStaticBundle,
  HRALegacyHarnessCustodyFailureStaticSelfManaged,
  HRALegacyHarnessCustodyFailureStaticSecurityMetadata,
  HRALegacyHarnessCustodyFailureSpawn,
  HRALegacyHarnessCustodyFailureDescriptorBeforeDynamic,
  HRALegacyHarnessCustodyFailureDynamicPidHash,
  HRALegacyHarnessCustodyFailureDynamicSecurityMetadata,
  HRALegacyHarnessCustodyFailureDescriptorAfterDynamic,
  HRALegacyHarnessCustodyFailureResume,
  HRALegacyHarnessCustodyFailureOutput,
  HRALegacyHarnessCustodyFailureExit,
  HRALegacyHarnessCustodyFailureGroupRetirement,
  HRALegacyHarnessCustodyFailureResponseParse,
} HRALegacyHarnessCustodyFailureSubstage;

/// Executes one fixed v1 Harness read or delete through the byte-exact public
/// Preview 0.1.4#5 gateway. Native supplies the sealed bundle path and the
/// implementation owns the complete Bun CLI script and environment.
bool hra_macos_run_attested_legacy_harness_custody(
    const char *path,
    size_t path_length,
    bool delete_action,
    uint8_t *response,
    size_t response_capacity,
    size_t *out_response_length,
    HRALegacyHarnessCustodyFailureSubstage *out_failure_substage,
    uint32_t timeout_milliseconds,
    bool allow_unsealed_development);

void hra_macos_prepare_attested_legacy_harness_custody_operations(void);

void hra_macos_cancel_attested_legacy_harness_custody(void);

#endif
