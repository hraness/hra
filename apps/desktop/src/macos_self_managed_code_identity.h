#ifndef HRA_MACOS_SELF_MANAGED_CODE_IDENTITY_H
#define HRA_MACOS_SELF_MANAGED_CODE_IDENTITY_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <sys/types.h>

#define HRA_MACOS_CDHASH_LENGTH 20
#define HRA_MACOS_SHA1_LENGTH 20
#define HRA_MACOS_SHA256_LENGTH 32

#define HRA_MACOS_CODE_DIRECTORY_RUNTIME 0x00010000u
#define HRA_MACOS_CODE_DIRECTORY_HASH_SHA1 1u
#define HRA_MACOS_CODE_DIRECTORY_HASH_SHA256 2u
#define HRA_MACOS_CODE_DIRECTORY_HASH_SHA256_TRUNCATED 3u
#define HRA_MACOS_CODE_DIRECTORY_HASH_SHA384 4u

/// Canonical no-follow file for a nonzero CodeDirectory special slot that is
/// stored outside the embedded signature. The verifier holds its descriptor
/// open and rechecks both the descriptor and path across the whole executable
/// proof. Typical bundle callers provide slot 1 (Info.plist) and slot 3
/// (_CodeSignature/CodeResources). Embedded requirements and entitlements are
/// discovered and hashed directly from the SuperBlob.
typedef struct {
  uint32_t slot;
  const char *canonical_path;
  size_t canonical_path_length;
  uint32_t expected_uid;
  uint32_t expected_permissions;
} HRAMacOSExternalCodeSpecialSlot;

/// One exact full-file hash that must appear in the already CodeDirectory-
/// authenticated CodeResources file. Relative paths use the CodeResources
/// spelling beneath Contents, such as Resources/runtime/bin/oprte-gateway.
typedef struct {
  const char *relative_path;
  size_t relative_path_length;
  uint8_t sha256[HRA_MACOS_SHA256_LENGTH];
} HRAMacOSCodeResourcesFileExpectation;

/// Exact policy for one self-managed, CMS-signed Apple Silicon executable.
/// The verifier opens canonical_path itself and never delegates authorization
/// to Security.framework's platform trust result.
typedef struct {
  const char *canonical_path;
  size_t canonical_path_length;
  const char *identifier;
  size_t identifier_length;
  uint32_t expected_uid;
  uint32_t expected_permissions;
  uint32_t expected_code_directory_flags;
  uint8_t expected_hash_type;
  uint8_t expected_page_size_shift;
  uint8_t leaf_certificate_sha1[HRA_MACOS_SHA1_LENGTH];
  uint8_t leaf_certificate_sha256[HRA_MACOS_SHA256_LENGTH];
  uint8_t root_certificate_sha1[HRA_MACOS_SHA1_LENGTH];
  uint8_t root_certificate_sha256[HRA_MACOS_SHA256_LENGTH];
  const HRAMacOSExternalCodeSpecialSlot *external_special_slots;
  size_t external_special_slot_count;
  /// Supplemental exact entries for callers that separately authenticate a
  /// bounded set of resources. This list is not a complete Apple bundle seal:
  /// it does not enumerate rules, omissions, symlinks, or recursive nested
  /// code and must not replace full outer-bundle validation.
  const HRAMacOSCodeResourcesFileExpectation *code_resources_files;
  size_t code_resources_file_count;
} HRAMacOSSelfManagedCodeExpectation;

/// Immutable identity sampled from the same no-follow descriptor used for
/// every Mach-O, CodeDirectory, special-slot, page-hash, and CMS check.
typedef struct {
  uint64_t device;
  uint64_t inode;
  uint64_t byte_length;
  uint32_t mode;
  uint32_t link_count;
  uint32_t uid;
  uint32_t gid;
  uint32_t file_flags;
  int64_t modified_seconds;
  int64_t modified_nanoseconds;
  int64_t changed_seconds;
  int64_t changed_nanoseconds;
  int64_t created_seconds;
  int64_t created_nanoseconds;
  uint64_t code_limit;
  uint32_t code_directory_flags;
  uint8_t hash_type;
  uint8_t page_size_shift;
  uint8_t cdhash[HRA_MACOS_CDHASH_LENGTH];
  uint8_t full_file_sha256[HRA_MACOS_SHA256_LENGTH];
} HRAMacOSSelfManagedCodeIdentity;

/// Verifies a thin arm64 Mach-O with exactly one embedded code signature. The
/// returned identity is written only after the pathname and descriptor remain
/// stable across the complete verification.
bool hra_macos_verify_self_managed_code_identity(
    const HRAMacOSSelfManagedCodeExpectation *expectation,
    HRAMacOSSelfManagedCodeIdentity *out_identity);

/// Repeats the complete descriptor-based proof and requires both the code
/// identity and stable filesystem identity to equal a previous sample.
bool hra_macos_reverify_self_managed_code_identity(
    const HRAMacOSSelfManagedCodeExpectation *expectation,
    const HRAMacOSSelfManagedCodeIdentity *expected_identity);

/// Strictly checks one relevant CodeResources files/files2 entry. The caller
/// must first authenticate code_resources_bytes as CodeDirectory special slot
/// 3. This parser never evaluates CodeResources rules as authorization.
bool hra_macos_code_resources_entry_matches_sha256(
    const uint8_t *code_resources_bytes,
    size_t code_resources_length,
    const char *relative_path,
    size_t relative_path_length,
    const uint8_t expected_sha256[HRA_MACOS_SHA256_LENGTH]);

/// Verifies a detached CMS message independently of the platform trust store.
/// The CMS must have no encapsulated content, exactly one valid signer, and
/// exactly the pinned leaf and root certificates. The platform trust result is
/// never evaluated or used as authorization.
bool hra_macos_verify_pinned_detached_cms(
    const uint8_t *cms_bytes,
    size_t cms_length,
    const uint8_t *detached_content,
    size_t detached_content_length,
    const uint8_t leaf_certificate_sha1[HRA_MACOS_SHA1_LENGTH],
    const uint8_t leaf_certificate_sha256[HRA_MACOS_SHA256_LENGTH],
    const uint8_t root_certificate_sha1[HRA_MACOS_SHA1_LENGTH],
    const uint8_t root_certificate_sha256[HRA_MACOS_SHA256_LENGTH]);

/// Matches the kernel's current valid-code object for a live process to a
/// descriptor-verified static identity. This routine deliberately makes no
/// SecCodeCheckValidity or SecTrust evaluation call. Callers remain
/// responsible for PID/PPID stability and a post-match static reverify.
bool hra_macos_self_managed_dynamic_code_matches(
    pid_t process_identifier,
    const char *expected_canonical_path,
    size_t expected_canonical_path_length,
    const char *expected_identifier,
    size_t expected_identifier_length,
    const uint8_t expected_cdhash[HRA_MACOS_CDHASH_LENGTH],
    uint32_t expected_code_directory_flags);

#endif
