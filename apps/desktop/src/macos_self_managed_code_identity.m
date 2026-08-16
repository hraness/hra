#import "macos_self_managed_code_identity.h"

#import <CommonCrypto/CommonDigest.h>
#import <CoreFoundation/CoreFoundation.h>
#import <Security/CMSDecoder.h>
#import <Security/SecCertificate.h>
#import <Security/SecCode.h>
#import <Security/SecPolicy.h>
#import <Security/Security.h>
#import <errno.h>
#import <fcntl.h>
#import <limits.h>
#import <mach-o/loader.h>
#import <mach/machine.h>
#import <stdlib.h>
#import <string.h>
#import <sys/stat.h>
#import <unistd.h>

enum {
  HRACSMagicRequirement = 0xfade0c00u,
  HRACSMagicRequirements = 0xfade0c01u,
  HRACSMagicCodeDirectory = 0xfade0c02u,
  HRACSMagicEmbeddedSignature = 0xfade0cc0u,
  HRACSMagicBlobWrapper = 0xfade0b01u,
  HRACSMagicEntitlements = 0xfade7171u,
  HRACSMagicDEREntitlements = 0xfade7172u,
  HRACSMagicLaunchConstraint = 0xfade8181u,

  HRACSSlotCodeDirectory = 0,
  HRACSSlotInfo = 1,
  HRACSSlotRequirements = 2,
  HRACSSlotResourceDirectory = 3,
  HRACSSlotApplication = 4,
  HRACSSlotEntitlements = 5,
  HRACSSlotDEREntitlements = 7,
  HRACSSlotLaunchConstraintSelf = 8,
  HRACSSlotLaunchConstraintParent = 9,
  HRACSSlotLaunchConstraintResponsible = 10,
  HRACSSlotLibraryConstraint = 11,
  HRACSSlotAlternateCodeDirectories = 0x1000,
  HRACSSlotAlternateCodeDirectoryLimit = 0x1005,
  HRACSSlotSignature = 0x10000,

  HRACSCodeDirectoryEarliest = 0x20001,
  HRACSCodeDirectoryScatter = 0x20100,
  HRACSCodeDirectoryTeam = 0x20200,
  HRACSCodeDirectoryCodeLimit64 = 0x20300,
  HRACSCodeDirectoryExecSegment = 0x20400,
  HRACSCodeDirectoryRuntime = 0x20500,
  HRACSCodeDirectoryLinkage = 0x20600,

  HRAMaximumSuperBlobCount = 64,
  HRAMaximumCodeSignatureBytes = 64 * 1024 * 1024,
  HRAMaximumIdentifierBytes = 1024,
  HRAMaximumPageSizeShift = 20,
  HRAMaximumExternalSlotBytes = 64 * 1024 * 1024,
  HRAMaximumCodeResourcesFiles = 32,
  HRAMaximumBERDepth = 64,
  HRAMaximumBERTLVCount = 1024 * 1024,
};

typedef struct {
  const uint8_t *bytes;
  size_t length;
  size_t cursor;
  size_t remaining_tlvs;
} HRABERCursor;

typedef struct {
  uint32_t type;
  uint32_t magic;
  size_t offset;
  size_t length;
  const uint8_t *bytes;
} HRACodeBlob;

typedef struct {
  const uint8_t *bytes;
  size_t length;
  uint32_t version;
  uint32_t flags;
  uint32_t hash_offset;
  uint32_t special_slot_count;
  uint32_t code_slot_count;
  uint64_t code_limit;
  uint8_t hash_size;
  uint8_t hash_type;
  uint8_t page_size_shift;
} HRAParsedCodeDirectory;

typedef struct {
  uint32_t slot;
  int descriptor;
  char path[PATH_MAX];
  struct stat metadata;
  uint8_t *bytes;
  size_t length;
} HRAHeldExternalSlot;

static uint32_t HRAReadBig32(const uint8_t *bytes) {
  return ((uint32_t)bytes[0] << 24) |
      ((uint32_t)bytes[1] << 16) |
      ((uint32_t)bytes[2] << 8) |
      (uint32_t)bytes[3];
}

static uint64_t HRAReadBig64(const uint8_t *bytes) {
  return ((uint64_t)HRAReadBig32(bytes) << 32) |
      (uint64_t)HRAReadBig32(bytes + 4);
}

static uint32_t HRAReadLittle32(const uint8_t *bytes) {
  return (uint32_t)bytes[0] |
      ((uint32_t)bytes[1] << 8) |
      ((uint32_t)bytes[2] << 16) |
      ((uint32_t)bytes[3] << 24);
}

static bool HRAAddSize(size_t left, size_t right, size_t *out) {
  if (out == NULL || left > SIZE_MAX - right) return false;
  *out = left + right;
  return true;
}

static bool HRAMultiplySize(size_t left, size_t right, size_t *out) {
  if (out == NULL || (right != 0 && left > SIZE_MAX / right)) return false;
  *out = left * right;
  return true;
}

static bool HRAAdd64(uint64_t left, uint64_t right, uint64_t *out) {
  if (out == NULL || left > UINT64_MAX - right) return false;
  *out = left + right;
  return true;
}

static bool HRABERReadTag(
    HRABERCursor *cursor,
    size_t limit,
    bool *out_constructed) {
  if (cursor == NULL || out_constructed == NULL || cursor->cursor >= limit ||
      limit > cursor->length) {
    return false;
  }
  uint8_t first = cursor->bytes[cursor->cursor++];
  if (first == 0) return false;
  *out_constructed = (first & 0x20u) != 0;
  if ((first & 0x1fu) != 0x1fu) return true;
  size_t tag_bytes = 0;
  while (cursor->cursor < limit) {
    uint8_t value = cursor->bytes[cursor->cursor++];
    if (tag_bytes == 0 && (value & 0x7fu) == 0) return false;
    tag_bytes += 1;
    if (tag_bytes > sizeof(size_t)) return false;
    if ((value & 0x80u) == 0) return true;
  }
  return false;
}

static bool HRABERReadLength(
    HRABERCursor *cursor,
    size_t limit,
    bool *out_indefinite,
    size_t *out_length) {
  if (cursor == NULL || out_indefinite == NULL || out_length == NULL ||
      cursor->cursor >= limit || limit > cursor->length) {
    return false;
  }
  uint8_t first = cursor->bytes[cursor->cursor++];
  if (first == 0x80u) {
    *out_indefinite = true;
    *out_length = 0;
    return true;
  }
  *out_indefinite = false;
  if ((first & 0x80u) == 0) {
    *out_length = first;
    return true;
  }
  size_t byte_count = first & 0x7fu;
  if (byte_count == 0 || byte_count > sizeof(size_t) ||
      cursor->cursor > limit || byte_count > limit - cursor->cursor ||
      cursor->bytes[cursor->cursor] == 0) {
    return false;
  }
  size_t value = 0;
  for (size_t index = 0; index < byte_count; index += 1) {
    if (value > (SIZE_MAX >> 8)) return false;
    value = (value << 8) | cursor->bytes[cursor->cursor++];
  }
  if (value < 128) return false;
  *out_length = value;
  return true;
}

static bool HRABERParseOne(
    HRABERCursor *cursor,
    size_t limit,
    size_t depth) {
  if (cursor == NULL || depth > HRAMaximumBERDepth ||
      cursor->remaining_tlvs == 0 || cursor->cursor >= limit ||
      limit > cursor->length) {
    return false;
  }
  cursor->remaining_tlvs -= 1;
  bool constructed = false;
  if (!HRABERReadTag(cursor, limit, &constructed)) return false;
  bool indefinite = false;
  size_t content_length = 0;
  if (!HRABERReadLength(
          cursor, limit, &indefinite, &content_length) ||
      (indefinite && !constructed)) {
    return false;
  }
  if (indefinite) {
    while (true) {
      if (cursor->cursor > limit || limit - cursor->cursor < 2)
        return false;
      if (cursor->bytes[cursor->cursor] == 0 &&
          cursor->bytes[cursor->cursor + 1] == 0) {
        cursor->cursor += 2;
        return true;
      }
      if (!HRABERParseOne(cursor, limit, depth + 1)) return false;
    }
  }
  if (cursor->cursor > limit || content_length > limit - cursor->cursor)
    return false;
  size_t content_end = cursor->cursor + content_length;
  if (!constructed) {
    cursor->cursor = content_end;
    return true;
  }
  while (cursor->cursor < content_end) {
    if (content_end - cursor->cursor >= 2 &&
        cursor->bytes[cursor->cursor] == 0 &&
        cursor->bytes[cursor->cursor + 1] == 0) {
      return false;
    }
    if (!HRABERParseOne(cursor, content_end, depth + 1)) return false;
  }
  return cursor->cursor == content_end;
}

static bool HRABERIsOneExactSequence(const uint8_t *bytes, size_t length) {
  if (bytes == NULL || length < 2 || bytes[0] != 0x30) return false;
  HRABERCursor cursor = {
    .bytes = bytes,
    .length = length,
    .cursor = 0,
    .remaining_tlvs = HRAMaximumBERTLVCount,
  };
  return HRABERParseOne(&cursor, length, 0) && cursor.cursor == length;
}

static bool HRAConstantTimeEqual(
    const uint8_t *left,
    const uint8_t *right,
    size_t length) {
  if (left == NULL || right == NULL) return false;
  uint8_t difference = 0;
  for (size_t index = 0; index < length; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference == 0;
}

static bool HRABytesAreZero(const uint8_t *bytes, size_t length) {
  if (bytes == NULL) return false;
  uint8_t combined = 0;
  for (size_t index = 0; index < length; index += 1) {
    combined |= bytes[index];
  }
  return combined == 0;
}

static bool HRARelativeResourcePathIsCanonical(
    const char *path,
    size_t length);

static bool HRAPreadAll(
    int descriptor,
    uint8_t *bytes,
    size_t length,
    uint64_t offset) {
  if (descriptor < 0 || (length > 0 && bytes == NULL) || offset > INT64_MAX)
    return false;
  size_t consumed = 0;
  while (consumed < length) {
    if (offset > (uint64_t)INT64_MAX - consumed) return false;
    ssize_t count = pread(
        descriptor,
        bytes + consumed,
        length - consumed,
        (off_t)(offset + consumed));
    if (count > 0) {
      consumed += (size_t)count;
      continue;
    }
    if (count < 0 && errno == EINTR) continue;
    return false;
  }
  return true;
}

static bool HRAHashDescriptorSHA256(
    int descriptor,
    uint64_t byte_length,
    uint8_t out_sha256[HRA_MACOS_SHA256_LENGTH]) {
  if (descriptor < 0 || byte_length == 0 || byte_length > INT64_MAX ||
      out_sha256 == NULL) {
    return false;
  }
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
  CC_SHA256_CTX context;
  memset(&context, 0, sizeof(context));
  uint8_t buffer[64 * 1024];
  memset(buffer, 0, sizeof(buffer));
  bool valid = CC_SHA256_Init(&context) == 1;
  uint64_t offset = 0;
  while (valid && offset < byte_length) {
    uint64_t remaining = byte_length - offset;
    size_t request = remaining < sizeof(buffer)
        ? (size_t)remaining
        : sizeof(buffer);
    if (!HRAPreadAll(descriptor, buffer, request, offset) ||
        CC_SHA256_Update(&context, buffer, (CC_LONG)request) != 1) {
      valid = false;
      break;
    }
    offset += request;
  }
  valid = valid && offset == byte_length &&
      CC_SHA256_Final(out_sha256, &context) == 1;
  memset(buffer, 0, sizeof(buffer));
  memset(&context, 0, sizeof(context));
#pragma clang diagnostic pop
  if (!valid) memset(out_sha256, 0, HRA_MACOS_SHA256_LENGTH);
  return valid;
}

static bool HRAStatIdentityMatches(
    const struct stat *left,
    const struct stat *right) {
  return left != NULL && right != NULL &&
      left->st_dev == right->st_dev &&
      left->st_ino == right->st_ino &&
      left->st_mode == right->st_mode &&
      left->st_nlink == right->st_nlink &&
      left->st_uid == right->st_uid &&
      left->st_gid == right->st_gid &&
      left->st_size == right->st_size &&
      left->st_flags == right->st_flags &&
      left->st_mtimespec.tv_sec == right->st_mtimespec.tv_sec &&
      left->st_mtimespec.tv_nsec == right->st_mtimespec.tv_nsec &&
      left->st_ctimespec.tv_sec == right->st_ctimespec.tv_sec &&
      left->st_ctimespec.tv_nsec == right->st_ctimespec.tv_nsec &&
      left->st_birthtimespec.tv_sec == right->st_birthtimespec.tv_sec &&
      left->st_birthtimespec.tv_nsec == right->st_birthtimespec.tv_nsec;
}

static bool HRAExpectationIsWellFormed(
    const HRAMacOSSelfManagedCodeExpectation *expectation,
    char path[PATH_MAX]) {
  if (expectation == NULL || path == NULL ||
      expectation->canonical_path == NULL ||
      expectation->canonical_path_length == 0 ||
      expectation->canonical_path_length >= PATH_MAX ||
      expectation->canonical_path[0] != '/' ||
      memchr(expectation->canonical_path,
             '\0',
             expectation->canonical_path_length) != NULL ||
      expectation->identifier == NULL ||
      expectation->identifier_length == 0 ||
      expectation->identifier_length > HRAMaximumIdentifierBytes ||
      memchr(expectation->identifier,
             '\0',
             expectation->identifier_length) != NULL ||
      (expectation->expected_permissions & ~07777u) != 0 ||
      (expectation->expected_code_directory_flags &
       HRA_MACOS_CODE_DIRECTORY_RUNTIME) == 0 ||
      expectation->expected_page_size_shift == 0 ||
      expectation->expected_page_size_shift > HRAMaximumPageSizeShift ||
      expectation->external_special_slot_count >
          HRACSSlotLibraryConstraint ||
      (expectation->external_special_slot_count > 0 &&
       expectation->external_special_slots == NULL) ||
      expectation->code_resources_file_count >
          HRAMaximumCodeResourcesFiles ||
      (expectation->code_resources_file_count > 0 &&
       expectation->code_resources_files == NULL)) {
    return false;
  }
  if (expectation->expected_hash_type !=
          HRA_MACOS_CODE_DIRECTORY_HASH_SHA1 &&
      expectation->expected_hash_type !=
          HRA_MACOS_CODE_DIRECTORY_HASH_SHA256 &&
      expectation->expected_hash_type !=
          HRA_MACOS_CODE_DIRECTORY_HASH_SHA256_TRUNCATED &&
      expectation->expected_hash_type !=
          HRA_MACOS_CODE_DIRECTORY_HASH_SHA384) {
    return false;
  }
  for (size_t index = 0;
       index < expectation->external_special_slot_count;
       index += 1) {
    const HRAMacOSExternalCodeSpecialSlot *slot =
        &expectation->external_special_slots[index];
    if (slot->slot == 0 || slot->slot > HRACSSlotLibraryConstraint ||
        slot->canonical_path == NULL || slot->canonical_path_length == 0 ||
        slot->canonical_path_length >= PATH_MAX ||
        slot->canonical_path[0] != '/' ||
        memchr(slot->canonical_path,
               '\0',
               slot->canonical_path_length) != NULL ||
        (slot->expected_permissions & ~07777u) != 0) {
      return false;
    }
    for (size_t prior = 0; prior < index; prior += 1) {
      if (expectation->external_special_slots[prior].slot == slot->slot)
        return false;
    }
  }
  bool has_code_resources_slot = false;
  for (size_t index = 0;
       index < expectation->external_special_slot_count;
       index += 1) {
    has_code_resources_slot |=
        expectation->external_special_slots[index].slot ==
        HRACSSlotResourceDirectory;
  }
  if (expectation->code_resources_file_count > 0 &&
      !has_code_resources_slot) {
    return false;
  }
  for (size_t index = 0;
       index < expectation->code_resources_file_count;
       index += 1) {
    const HRAMacOSCodeResourcesFileExpectation *file =
        &expectation->code_resources_files[index];
    if (!HRARelativeResourcePathIsCanonical(
            file->relative_path, file->relative_path_length))
      return false;
    for (size_t prior = 0; prior < index; prior += 1) {
      const HRAMacOSCodeResourcesFileExpectation *prior_file =
          &expectation->code_resources_files[prior];
      if (prior_file->relative_path_length == file->relative_path_length &&
          memcmp(prior_file->relative_path,
                 file->relative_path,
                 file->relative_path_length) == 0) {
        return false;
      }
    }
  }
  memcpy(path,
         expectation->canonical_path,
         expectation->canonical_path_length);
  path[expectation->canonical_path_length] = '\0';
  char resolved[PATH_MAX];
  memset(resolved, 0, sizeof(resolved));
  return realpath(path, resolved) != NULL &&
      strlen(resolved) == expectation->canonical_path_length &&
      memcmp(resolved,
             expectation->canonical_path,
             expectation->canonical_path_length) == 0;
}

static bool HRAPathAndDescriptorAreExact(
    const char *path,
    int descriptor,
    const struct stat *expected) {
  if (path == NULL || descriptor < 0 || expected == NULL) return false;
  struct stat path_metadata;
  struct stat descriptor_metadata;
  memset(&path_metadata, 0, sizeof(path_metadata));
  memset(&descriptor_metadata, 0, sizeof(descriptor_metadata));
  if (lstat(path, &path_metadata) != 0 ||
      fstat(descriptor, &descriptor_metadata) != 0 ||
      !HRAStatIdentityMatches(expected, &path_metadata) ||
      !HRAStatIdentityMatches(expected, &descriptor_metadata)) {
    return false;
  }
  char resolved[PATH_MAX];
  char descriptor_path[PATH_MAX];
  char resolved_descriptor_path[PATH_MAX];
  memset(resolved, 0, sizeof(resolved));
  memset(descriptor_path, 0, sizeof(descriptor_path));
  memset(resolved_descriptor_path, 0, sizeof(resolved_descriptor_path));
  return realpath(path, resolved) != NULL && strcmp(resolved, path) == 0 &&
      fcntl(descriptor, F_GETPATH, descriptor_path) == 0 &&
      realpath(descriptor_path, resolved_descriptor_path) != NULL &&
      strcmp(resolved_descriptor_path, path) == 0;
}

static void HRAReleaseHeldExternalSlots(
    HRAHeldExternalSlot *slots,
    size_t count) {
  if (slots == NULL) return;
  for (size_t index = 0; index < count; index += 1) {
    if (slots[index].bytes != NULL) {
      memset(slots[index].bytes, 0, slots[index].length);
      free(slots[index].bytes);
    }
    if (slots[index].descriptor >= 0) close(slots[index].descriptor);
    memset(&slots[index], 0, sizeof(slots[index]));
    slots[index].descriptor = -1;
  }
}

static bool HRAOpenHeldExternalSlots(
    const HRAMacOSSelfManagedCodeExpectation *expectation,
    HRAHeldExternalSlot *slots) {
  if (expectation == NULL ||
      (expectation->external_special_slot_count > 0 && slots == NULL)) {
    return false;
  }
  for (size_t index = 0;
       index < expectation->external_special_slot_count;
       index += 1) {
    slots[index].descriptor = -1;
  }
  for (size_t index = 0;
       index < expectation->external_special_slot_count;
       index += 1) {
    const HRAMacOSExternalCodeSpecialSlot *expected =
        &expectation->external_special_slots[index];
    HRAHeldExternalSlot *held = &slots[index];
    memcpy(held->path,
           expected->canonical_path,
           expected->canonical_path_length);
    held->path[expected->canonical_path_length] = '\0';
    char resolved[PATH_MAX];
    memset(resolved, 0, sizeof(resolved));
    struct stat path_metadata;
    memset(&path_metadata, 0, sizeof(path_metadata));
    if (realpath(held->path, resolved) == NULL ||
        strcmp(resolved, held->path) != 0 ||
        lstat(held->path, &path_metadata) != 0 ||
        !S_ISREG(path_metadata.st_mode) || path_metadata.st_nlink != 1 ||
        (uint32_t)path_metadata.st_uid != expected->expected_uid ||
        ((uint32_t)path_metadata.st_mode & 07777u) !=
            expected->expected_permissions ||
        path_metadata.st_size <= 0 ||
        path_metadata.st_size > HRAMaximumExternalSlotBytes) {
      HRAReleaseHeldExternalSlots(
          slots, expectation->external_special_slot_count);
      return false;
    }
    held->descriptor = open(
        held->path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
    if (held->descriptor < 0 ||
        fstat(held->descriptor, &held->metadata) != 0 ||
        !HRAStatIdentityMatches(&path_metadata, &held->metadata) ||
        !HRAPathAndDescriptorAreExact(
            held->path, held->descriptor, &held->metadata)) {
      HRAReleaseHeldExternalSlots(
          slots, expectation->external_special_slot_count);
      return false;
    }
    held->slot = expected->slot;
    held->length = (size_t)held->metadata.st_size;
    held->bytes = malloc(held->length);
    if (held->bytes == NULL ||
        !HRAPreadAll(
            held->descriptor, held->bytes, held->length, 0) ||
        !HRAPathAndDescriptorAreExact(
            held->path, held->descriptor, &held->metadata)) {
      HRAReleaseHeldExternalSlots(
          slots, expectation->external_special_slot_count);
      return false;
    }
  }
  return true;
}

static bool HRAHeldExternalSlotsRemainExact(
    const HRAHeldExternalSlot *slots,
    size_t count) {
  if (count > 0 && slots == NULL) return false;
  for (size_t index = 0; index < count; index += 1) {
    if (slots[index].descriptor < 0 ||
        !HRAPathAndDescriptorAreExact(
            slots[index].path,
            slots[index].descriptor,
            &slots[index].metadata)) {
      return false;
    }
  }
  return true;
}

static bool HRARelativeResourcePathIsCanonical(
    const char *path,
    size_t length) {
  if (path == NULL || length == 0 || length > PATH_MAX || path[0] == '/' ||
      path[length - 1] == '/' || memchr(path, '\0', length) != NULL) {
    return false;
  }
  size_t component_start = 0;
  for (size_t index = 0; index <= length; index += 1) {
    if (index != length && path[index] != '/') continue;
    size_t component_length = index - component_start;
    if (component_length == 0 ||
        (component_length == 1 && path[component_start] == '.') ||
        (component_length == 2 && path[component_start] == '.' &&
         path[component_start + 1] == '.')) {
      return false;
    }
    component_start = index + 1;
  }
  return true;
}

static size_t HRAHashLength(uint8_t hash_type) {
  switch (hash_type) {
    case HRA_MACOS_CODE_DIRECTORY_HASH_SHA1:
      return CC_SHA1_DIGEST_LENGTH;
    case HRA_MACOS_CODE_DIRECTORY_HASH_SHA256:
      return CC_SHA256_DIGEST_LENGTH;
    case HRA_MACOS_CODE_DIRECTORY_HASH_SHA256_TRUNCATED:
      return CC_SHA256_DIGEST_LENGTH;
    case HRA_MACOS_CODE_DIRECTORY_HASH_SHA384:
      return CC_SHA384_DIGEST_LENGTH;
    default:
      return 0;
  }
}

static size_t HRAStoredHashLength(uint8_t hash_type) {
  return hash_type == HRA_MACOS_CODE_DIRECTORY_HASH_SHA256_TRUNCATED
      ? HRA_MACOS_CDHASH_LENGTH
      : HRAHashLength(hash_type);
}

static bool HRAHashBytes(
    uint8_t hash_type,
    const uint8_t *bytes,
    size_t length,
    uint8_t digest[CC_SHA384_DIGEST_LENGTH],
    size_t *out_length) {
  if ((length > 0 && bytes == NULL) || digest == NULL || out_length == NULL ||
      length > UINT32_MAX) {
    return false;
  }
  memset(digest, 0, CC_SHA384_DIGEST_LENGTH);
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
  switch (hash_type) {
    case HRA_MACOS_CODE_DIRECTORY_HASH_SHA1:
      if (CC_SHA1(bytes, (CC_LONG)length, digest) == NULL) return false;
      *out_length = CC_SHA1_DIGEST_LENGTH;
      return true;
    case HRA_MACOS_CODE_DIRECTORY_HASH_SHA256:
    case HRA_MACOS_CODE_DIRECTORY_HASH_SHA256_TRUNCATED:
      if (CC_SHA256(bytes, (CC_LONG)length, digest) == NULL) return false;
      *out_length = CC_SHA256_DIGEST_LENGTH;
      return true;
    case HRA_MACOS_CODE_DIRECTORY_HASH_SHA384:
      if (CC_SHA384(bytes, (CC_LONG)length, digest) == NULL) return false;
      *out_length = CC_SHA384_DIGEST_LENGTH;
      return true;
    default:
      return false;
  }
#pragma clang diagnostic pop
}

static bool HRAHashDescriptorRange(
    int descriptor,
    uint64_t offset,
    size_t length,
    uint8_t hash_type,
    uint8_t digest[CC_SHA384_DIGEST_LENGTH],
    size_t *out_length) {
  if (length == 0 || length > ((size_t)1 << HRAMaximumPageSizeShift))
    return false;
  uint8_t *bytes = malloc(length);
  if (bytes == NULL) return false;
  bool valid = HRAPreadAll(descriptor, bytes, length, offset) &&
      HRAHashBytes(hash_type, bytes, length, digest, out_length);
  memset(bytes, 0, length);
  free(bytes);
  return valid;
}

static uint32_t HRAExpectedBlobMagic(uint32_t type) {
  switch (type) {
    case HRACSSlotCodeDirectory:
      return HRACSMagicCodeDirectory;
    case HRACSSlotRequirements:
      return HRACSMagicRequirements;
    case HRACSSlotEntitlements:
      return HRACSMagicEntitlements;
    case HRACSSlotDEREntitlements:
      return HRACSMagicDEREntitlements;
    case HRACSSlotLaunchConstraintSelf:
    case HRACSSlotLaunchConstraintParent:
    case HRACSSlotLaunchConstraintResponsible:
    case HRACSSlotLibraryConstraint:
      return HRACSMagicLaunchConstraint;
    case HRACSSlotSignature:
      return HRACSMagicBlobWrapper;
    default:
      return 0;
  }
}

static bool HRAValidateRequirementsBlob(const HRACodeBlob *blob) {
  if (blob == NULL || blob->magic != HRACSMagicRequirements ||
      blob->length < 12 || HRAReadBig32(blob->bytes + 4) != blob->length) {
    return false;
  }
  uint32_t count = HRAReadBig32(blob->bytes + 8);
  if (count > HRAMaximumSuperBlobCount) return false;
  size_t index_bytes = 0;
  size_t table_end = 0;
  if (!HRAMultiplySize((size_t)count, 8, &index_bytes) ||
      !HRAAddSize(12, index_bytes, &table_end) ||
      table_end > blob->length) {
    return false;
  }
  size_t offsets[HRAMaximumSuperBlobCount];
  size_t lengths[HRAMaximumSuperBlobCount];
  uint32_t types[HRAMaximumSuperBlobCount];
  memset(offsets, 0, sizeof(offsets));
  memset(lengths, 0, sizeof(lengths));
  memset(types, 0, sizeof(types));
  for (uint32_t index = 0; index < count; index += 1) {
    const uint8_t *entry = blob->bytes + 12 + (size_t)index * 8;
    types[index] = HRAReadBig32(entry);
    offsets[index] = HRAReadBig32(entry + 4);
    for (uint32_t prior = 0; prior < index; prior += 1) {
      if (types[prior] == types[index]) return false;
    }
    size_t header_end = 0;
    if (offsets[index] < table_end ||
        !HRAAddSize(offsets[index], 8, &header_end) ||
        header_end > blob->length ||
        HRAReadBig32(blob->bytes + offsets[index]) !=
            HRACSMagicRequirement) {
      return false;
    }
    lengths[index] = HRAReadBig32(blob->bytes + offsets[index] + 4);
    size_t requirement_end = 0;
    if (lengths[index] < 12 ||
        !HRAAddSize(offsets[index], lengths[index], &requirement_end) ||
        requirement_end > blob->length) {
      return false;
    }
  }
  for (uint32_t left = 0; left < count; left += 1) {
    size_t left_end = offsets[left] + lengths[left];
    for (uint32_t right = left + 1; right < count; right += 1) {
      size_t right_end = offsets[right] + lengths[right];
      if (offsets[left] < right_end && offsets[right] < left_end)
        return false;
    }
  }
  return true;
}

static bool HRAParseSuperBlob(
    const uint8_t *signature,
    size_t signature_length,
    HRACodeBlob blobs[HRAMaximumSuperBlobCount],
    size_t *out_count,
    const HRACodeBlob **out_code_directory,
    const HRACodeBlob **out_cms) {
  if (signature == NULL || blobs == NULL || out_count == NULL ||
      out_code_directory == NULL || out_cms == NULL ||
      signature_length < 12 ||
      HRAReadBig32(signature) != HRACSMagicEmbeddedSignature) {
    return false;
  }
  size_t super_length = HRAReadBig32(signature + 4);
  uint32_t count = HRAReadBig32(signature + 8);
  if (super_length < 12 || super_length > signature_length || count == 0 ||
      count > HRAMaximumSuperBlobCount) {
    return false;
  }
  size_t index_bytes = 0;
  size_t table_end = 0;
  if (!HRAMultiplySize((size_t)count, 8, &index_bytes) ||
      !HRAAddSize(12, index_bytes, &table_end) ||
      table_end > super_length) {
    return false;
  }
  memset(blobs, 0, sizeof(HRACodeBlob) * HRAMaximumSuperBlobCount);
  *out_code_directory = NULL;
  *out_cms = NULL;
  for (uint32_t index = 0; index < count; index += 1) {
    const uint8_t *entry = signature + 12 + (size_t)index * 8;
    uint32_t type = HRAReadBig32(entry);
    size_t offset = HRAReadBig32(entry + 4);
    if (type >= HRACSSlotAlternateCodeDirectories &&
        type < HRACSSlotAlternateCodeDirectoryLimit) {
      return false;
    }
    for (uint32_t prior = 0; prior < index; prior += 1) {
      if (blobs[prior].type == type || blobs[prior].offset == offset)
        return false;
    }
    size_t header_end = 0;
    if (offset < table_end || !HRAAddSize(offset, 8, &header_end) ||
        header_end > super_length) {
      return false;
    }
    uint32_t magic = HRAReadBig32(signature + offset);
    size_t length = HRAReadBig32(signature + offset + 4);
    size_t blob_end = 0;
    uint32_t expected_magic = HRAExpectedBlobMagic(type);
    if (expected_magic == 0 || magic != expected_magic || length < 8 ||
        !HRAAddSize(offset, length, &blob_end) || blob_end > super_length) {
      return false;
    }
    blobs[index] = (HRACodeBlob){
      .type = type,
      .magic = magic,
      .offset = offset,
      .length = length,
      .bytes = signature + offset,
    };
    if (type == HRACSSlotCodeDirectory) {
      if (*out_code_directory != NULL) return false;
      *out_code_directory = &blobs[index];
    } else if (type == HRACSSlotSignature) {
      if (*out_cms != NULL) return false;
      *out_cms = &blobs[index];
    }
  }
  if (*out_code_directory == NULL || *out_cms == NULL) return false;
  for (uint32_t left = 0; left < count; left += 1) {
    size_t left_end = blobs[left].offset + blobs[left].length;
    for (uint32_t right = left + 1; right < count; right += 1) {
      size_t right_end = blobs[right].offset + blobs[right].length;
      if (blobs[left].offset < right_end &&
          blobs[right].offset < left_end) {
        return false;
      }
    }
    if (blobs[left].type == HRACSSlotRequirements &&
        !HRAValidateRequirementsBlob(&blobs[left])) {
      return false;
    }
  }

  size_t order[HRAMaximumSuperBlobCount];
  for (uint32_t index = 0; index < count; index += 1) order[index] = index;
  for (uint32_t index = 1; index < count; index += 1) {
    size_t value = order[index];
    uint32_t cursor = index;
    while (cursor > 0 &&
           blobs[order[cursor - 1]].offset > blobs[value].offset) {
      order[cursor] = order[cursor - 1];
      cursor -= 1;
    }
    order[cursor] = value;
  }
  size_t cursor = table_end;
  for (uint32_t index = 0; index < count; index += 1) {
    const HRACodeBlob *blob = &blobs[order[index]];
    if (blob->offset < cursor ||
        !HRABytesAreZero(signature + cursor, blob->offset - cursor)) {
      return false;
    }
    cursor = blob->offset + blob->length;
  }
  if (cursor > super_length ||
      !HRABytesAreZero(signature + cursor, super_length - cursor) ||
      !HRABytesAreZero(
          signature + super_length, signature_length - super_length)) {
    return false;
  }
  *out_count = count;
  return true;
}

static bool HRACodeDirectoryVersionIsKnown(uint32_t version) {
  return version == HRACSCodeDirectoryEarliest ||
      version == HRACSCodeDirectoryScatter ||
      version == HRACSCodeDirectoryTeam ||
      version == HRACSCodeDirectoryCodeLimit64 ||
      version == HRACSCodeDirectoryExecSegment ||
      version == HRACSCodeDirectoryRuntime ||
      version == HRACSCodeDirectoryLinkage;
}

static size_t HRACodeDirectoryHeaderLength(uint32_t version) {
  if (version >= HRACSCodeDirectoryLinkage) return 108;
  if (version >= HRACSCodeDirectoryRuntime) return 96;
  if (version >= HRACSCodeDirectoryExecSegment) return 88;
  if (version >= HRACSCodeDirectoryCodeLimit64) return 64;
  if (version >= HRACSCodeDirectoryTeam) return 52;
  if (version >= HRACSCodeDirectoryScatter) return 48;
  return 44;
}

static bool HRAParseCodeDirectory(
    const HRACodeBlob *blob,
    uint64_t signature_offset,
    const HRAMacOSSelfManagedCodeExpectation *expectation,
    HRAParsedCodeDirectory *out) {
  if (blob == NULL || expectation == NULL || out == NULL ||
      blob->magic != HRACSMagicCodeDirectory || blob->length < 44 ||
      HRAReadBig32(blob->bytes + 4) != blob->length) {
    return false;
  }
  uint32_t version = HRAReadBig32(blob->bytes + 8);
  size_t header_length = HRACodeDirectoryHeaderLength(version);
  if (!HRACodeDirectoryVersionIsKnown(version) ||
      version < HRACSCodeDirectoryRuntime ||
      blob->length < header_length) {
    return false;
  }
  uint32_t flags = HRAReadBig32(blob->bytes + 12);
  uint32_t hash_offset = HRAReadBig32(blob->bytes + 16);
  uint32_t identifier_offset = HRAReadBig32(blob->bytes + 20);
  uint32_t special_slot_count = HRAReadBig32(blob->bytes + 24);
  uint32_t code_slot_count = HRAReadBig32(blob->bytes + 28);
  uint32_t code_limit_32 = HRAReadBig32(blob->bytes + 32);
  uint8_t hash_size = blob->bytes[36];
  uint8_t hash_type = blob->bytes[37];
  uint8_t platform = blob->bytes[38];
  uint8_t page_size_shift = blob->bytes[39];
  uint32_t spare2 = HRAReadBig32(blob->bytes + 40);
  if (flags != expectation->expected_code_directory_flags ||
      hash_type != expectation->expected_hash_type ||
      page_size_shift != expectation->expected_page_size_shift ||
      hash_size != HRAStoredHashLength(hash_type) || platform != 0 ||
      spare2 != 0 || special_slot_count > HRACSSlotLibraryConstraint ||
      code_slot_count == 0) {
    return false;
  }
  if (version >= HRACSCodeDirectoryScatter &&
      HRAReadBig32(blob->bytes + 44) != 0) {
    return false;
  }
  if (version >= HRACSCodeDirectoryTeam &&
      HRAReadBig32(blob->bytes + 48) != 0) {
    return false;
  }
  uint64_t code_limit = code_limit_32;
  if (version >= HRACSCodeDirectoryCodeLimit64) {
    uint32_t spare3 = HRAReadBig32(blob->bytes + 52);
    uint64_t code_limit_64 = HRAReadBig64(blob->bytes + 56);
    if (spare3 != 0) return false;
    if (code_limit_32 == UINT32_MAX) {
      code_limit = code_limit_64;
    } else if (code_limit_64 != 0) {
      return false;
    }
  }
  if (code_limit == 0 || code_limit != signature_offset) return false;
  if (version >= HRACSCodeDirectoryExecSegment) {
    uint64_t executable_base = HRAReadBig64(blob->bytes + 64);
    uint64_t executable_limit = HRAReadBig64(blob->bytes + 72);
    uint64_t executable_end = 0;
    if (!HRAAdd64(executable_base, executable_limit, &executable_end) ||
        executable_end > code_limit) {
      return false;
    }
  }
  if (version >= HRACSCodeDirectoryRuntime &&
      (HRAReadBig32(blob->bytes + 88) == 0 ||
       HRAReadBig32(blob->bytes + 92) != 0)) {
    return false;
  }
  if (version >= HRACSCodeDirectoryLinkage &&
      (blob->bytes[96] != 0 || blob->bytes[97] != 0 ||
       blob->bytes[98] != 0 || blob->bytes[99] != 0 ||
       HRAReadBig32(blob->bytes + 100) != 0 ||
       HRAReadBig32(blob->bytes + 104) != 0)) {
    return false;
  }
  if (identifier_offset < header_length || identifier_offset >= blob->length)
    return false;
  const uint8_t *identifier = blob->bytes + identifier_offset;
  size_t remaining_identifier = blob->length - identifier_offset;
  const uint8_t *identifier_end = memchr(identifier, '\0', remaining_identifier);
  if (identifier_end == NULL ||
      (size_t)(identifier_end - identifier) != expectation->identifier_length ||
      memcmp(identifier,
             expectation->identifier,
             expectation->identifier_length) != 0) {
    return false;
  }
  size_t special_bytes = 0;
  size_t code_bytes = 0;
  size_t table_end = 0;
  if (!HRAMultiplySize(special_slot_count, hash_size, &special_bytes) ||
      hash_offset < special_bytes || hash_offset - special_bytes < header_length ||
      (size_t)(identifier_end - blob->bytes) + 1 >
          hash_offset - special_bytes ||
      !HRAMultiplySize(code_slot_count, hash_size, &code_bytes) ||
      !HRAAddSize(hash_offset, code_bytes, &table_end) ||
      table_end != blob->length) {
    return false;
  }
  uint64_t page_size = UINT64_C(1) << page_size_shift;
  uint64_t rounded = 0;
  if (!HRAAdd64(code_limit, page_size - 1, &rounded) ||
      rounded / page_size != code_slot_count) {
    return false;
  }
  *out = (HRAParsedCodeDirectory){
    .bytes = blob->bytes,
    .length = blob->length,
    .version = version,
    .flags = flags,
    .hash_offset = hash_offset,
    .special_slot_count = special_slot_count,
    .code_slot_count = code_slot_count,
    .code_limit = code_limit,
    .hash_size = hash_size,
    .hash_type = hash_type,
    .page_size_shift = page_size_shift,
  };
  return true;
}

static const HRACodeBlob *HRABlobForType(
    const HRACodeBlob *blobs,
    size_t blob_count,
    uint32_t type) {
  for (size_t index = 0; index < blob_count; index += 1) {
    if (blobs[index].type == type) return &blobs[index];
  }
  return NULL;
}

static const HRAHeldExternalSlot *HRAExternalSlot(
    const HRAHeldExternalSlot *slots,
    size_t slot_count,
    uint32_t slot) {
  for (size_t index = 0; index < slot_count; index += 1) {
    if (slots[index].slot == slot) return &slots[index];
  }
  return NULL;
}

static bool HRAVerifyCodeAndSpecialSlots(
    int descriptor,
    const HRAParsedCodeDirectory *code_directory,
    const HRACodeBlob *blobs,
    size_t blob_count,
    const HRAHeldExternalSlot *external_slots,
    size_t external_slot_count,
    const HRAMacOSSelfManagedCodeExpectation *expectation) {
  if (descriptor < 0 || code_directory == NULL || blobs == NULL ||
      expectation == NULL) {
    return false;
  }
  const size_t page_size = (size_t)1 << code_directory->page_size_shift;
  uint8_t digest[CC_SHA384_DIGEST_LENGTH];
  for (uint32_t slot = 0; slot < code_directory->code_slot_count; slot += 1) {
    uint64_t offset = (uint64_t)slot * page_size;
    uint64_t remaining = code_directory->code_limit - offset;
    size_t length = remaining < page_size ? (size_t)remaining : page_size;
    size_t digest_length = 0;
    if (!HRAHashDescriptorRange(
            descriptor,
            offset,
            length,
            code_directory->hash_type,
            digest,
            &digest_length) ||
        digest_length < code_directory->hash_size ||
        !HRAConstantTimeEqual(
            digest,
            code_directory->bytes + code_directory->hash_offset +
                (size_t)slot * code_directory->hash_size,
            code_directory->hash_size)) {
      memset(digest, 0, sizeof(digest));
      return false;
    }
  }
  for (uint32_t slot = 1;
       slot <= code_directory->special_slot_count;
       slot += 1) {
    const uint8_t *expected = code_directory->bytes +
        code_directory->hash_offset - (size_t)slot * code_directory->hash_size;
    const HRACodeBlob *embedded = HRABlobForType(blobs, blob_count, slot);
    const HRAHeldExternalSlot *external =
        HRAExternalSlot(external_slots, external_slot_count, slot);
    bool is_zero = HRABytesAreZero(expected, code_directory->hash_size);
    if (is_zero) {
      if (embedded != NULL || external != NULL) return false;
      continue;
    }
    if ((embedded == NULL) == (external == NULL)) return false;
    const uint8_t *bytes = embedded != NULL ? embedded->bytes : external->bytes;
    size_t length = embedded != NULL ? embedded->length : external->length;
    size_t digest_length = 0;
    if (!HRAHashBytes(
            code_directory->hash_type,
            bytes,
            length,
            digest,
            &digest_length) ||
        digest_length < code_directory->hash_size ||
        !HRAConstantTimeEqual(
            digest, expected, code_directory->hash_size)) {
      memset(digest, 0, sizeof(digest));
      return false;
    }
  }
  for (size_t index = 0;
       index < expectation->external_special_slot_count;
       index += 1) {
    if (expectation->external_special_slots[index].slot >
        code_directory->special_slot_count) {
      memset(digest, 0, sizeof(digest));
      return false;
    }
  }
  for (size_t index = 0; index < blob_count; index += 1) {
    uint32_t type = blobs[index].type;
    if (type != HRACSSlotCodeDirectory &&
        type != HRACSSlotSignature &&
        type > code_directory->special_slot_count) {
      memset(digest, 0, sizeof(digest));
      return false;
    }
  }
  memset(digest, 0, sizeof(digest));
  return true;
}

static bool HRACertificateMatchesPins(
    SecCertificateRef certificate,
    const uint8_t expected_sha1[HRA_MACOS_SHA1_LENGTH],
    const uint8_t expected_sha256[HRA_MACOS_SHA256_LENGTH]) {
  if (certificate == NULL || expected_sha1 == NULL || expected_sha256 == NULL)
    return false;
  CFDataRef raw = SecCertificateCopyData(certificate);
  if (raw == NULL) return false;
  const uint8_t *bytes = CFDataGetBytePtr(raw);
  CFIndex signed_length = CFDataGetLength(raw);
  uint8_t sha1[CC_SHA1_DIGEST_LENGTH];
  uint8_t sha256[CC_SHA256_DIGEST_LENGTH];
  memset(sha1, 0, sizeof(sha1));
  memset(sha256, 0, sizeof(sha256));
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
  bool matches = bytes != NULL && signed_length > 0 &&
      (uint64_t)signed_length <= UINT32_MAX &&
      CC_SHA1(bytes, (CC_LONG)signed_length, sha1) != NULL &&
      CC_SHA256(bytes, (CC_LONG)signed_length, sha256) != NULL &&
      HRAConstantTimeEqual(sha1, expected_sha1, sizeof(sha1)) &&
      HRAConstantTimeEqual(sha256, expected_sha256, sizeof(sha256));
#pragma clang diagnostic pop
  memset(sha1, 0, sizeof(sha1));
  memset(sha256, 0, sizeof(sha256));
  CFRelease(raw);
  return matches;
}

bool hra_macos_verify_pinned_detached_cms(
    const uint8_t *cms_bytes,
    size_t cms_length,
    const uint8_t *detached_content,
    size_t detached_content_length,
    const uint8_t leaf_certificate_sha1[HRA_MACOS_SHA1_LENGTH],
    const uint8_t leaf_certificate_sha256[HRA_MACOS_SHA256_LENGTH],
    const uint8_t root_certificate_sha1[HRA_MACOS_SHA1_LENGTH],
    const uint8_t root_certificate_sha256[HRA_MACOS_SHA256_LENGTH]) {
  if (cms_bytes == NULL || cms_length == 0 || cms_length > UINT32_MAX ||
      !HRABERIsOneExactSequence(cms_bytes, cms_length) ||
      detached_content == NULL || detached_content_length == 0 ||
      detached_content_length > UINT32_MAX || leaf_certificate_sha1 == NULL ||
      leaf_certificate_sha256 == NULL || root_certificate_sha1 == NULL ||
      root_certificate_sha256 == NULL) {
    return false;
  }
  CMSDecoderRef decoder = NULL;
  SecPolicyRef policy = NULL;
  CFDataRef content = NULL;
  CFDataRef detached = NULL;
  CFArrayRef certificates = NULL;
  SecCertificateRef signer = NULL;
  SecTrustRef trust = NULL;
  bool valid = CMSDecoderCreate(&decoder) == errSecSuccess && decoder != NULL &&
      CMSDecoderUpdateMessage(decoder, cms_bytes, cms_length) ==
          errSecSuccess &&
      CMSDecoderFinalizeMessage(decoder) == errSecSuccess;
  size_t signer_count = 0;
  if (!valid ||
      CMSDecoderGetNumSigners(decoder, &signer_count) != errSecSuccess ||
      signer_count != 1 ||
      CMSDecoderCopyContent(decoder, &content) != errSecSuccess ||
      content != NULL) {
    valid = false;
    goto cleanup;
  }
  policy = SecPolicyCreateBasicX509();
  if (policy == NULL) {
    valid = false;
    goto cleanup;
  }
  CMSSignerStatus signer_status = kCMSSignerUnsigned;
  if (CMSDecoderCopySignerStatus(
          decoder,
          0,
          policy,
          false,
          &signer_status,
          &trust,
          NULL) != errSecSuccess ||
      signer_status != kCMSSignerNeedsDetachedContent) {
    valid = false;
    goto cleanup;
  }
  if (trust != NULL) {
    CFRelease(trust);
    trust = NULL;
  }
  detached = CFDataCreate(
      kCFAllocatorDefault,
      detached_content,
      (CFIndex)detached_content_length);
  if (detached == NULL ||
      CMSDecoderSetDetachedContent(decoder, detached) != errSecSuccess) {
    valid = false;
    goto cleanup;
  }
  signer_status = kCMSSignerUnsigned;
  if (CMSDecoderCopySignerStatus(
          decoder,
          0,
          policy,
          false,
          &signer_status,
          &trust,
          NULL) != errSecSuccess ||
      signer_status != kCMSSignerValid ||
      CMSDecoderCopySignerCert(decoder, 0, &signer) != errSecSuccess ||
      signer == NULL ||
      !HRACertificateMatchesPins(
          signer,
          leaf_certificate_sha1,
          leaf_certificate_sha256) ||
      CMSDecoderCopyAllCerts(decoder, &certificates) != errSecSuccess ||
      certificates == NULL || CFArrayGetCount(certificates) != 2) {
    valid = false;
    goto cleanup;
  }
  bool found_leaf = false;
  bool found_root = false;
  for (CFIndex index = 0; index < CFArrayGetCount(certificates); index += 1) {
    CFTypeRef value = CFArrayGetValueAtIndex(certificates, index);
    if (value == NULL || CFGetTypeID(value) != SecCertificateGetTypeID()) {
      valid = false;
      goto cleanup;
    }
    SecCertificateRef certificate = (SecCertificateRef)value;
    bool leaf = HRACertificateMatchesPins(
        certificate,
        leaf_certificate_sha1,
        leaf_certificate_sha256);
    bool root = HRACertificateMatchesPins(
        certificate,
        root_certificate_sha1,
        root_certificate_sha256);
    if (leaf == root || (leaf && found_leaf) || (root && found_root)) {
      valid = false;
      goto cleanup;
    }
    found_leaf |= leaf;
    found_root |= root;
  }
  valid = found_leaf && found_root;

cleanup:
  if (trust != NULL) CFRelease(trust);
  if (signer != NULL) CFRelease(signer);
  if (certificates != NULL) CFRelease(certificates);
  if (detached != NULL) CFRelease(detached);
  if (content != NULL) CFRelease(content);
  if (policy != NULL) CFRelease(policy);
  if (decoder != NULL) CFRelease(decoder);
  return valid;
}

static bool HRAVerifyDetachedCMS(
    const HRACodeBlob *cms,
    const HRAParsedCodeDirectory *code_directory,
    const HRAMacOSSelfManagedCodeExpectation *expectation) {
  return cms != NULL && code_directory != NULL && expectation != NULL &&
      cms->magic == HRACSMagicBlobWrapper && cms->length > 8 &&
      hra_macos_verify_pinned_detached_cms(
          cms->bytes + 8,
          cms->length - 8,
          code_directory->bytes,
          code_directory->length,
          expectation->leaf_certificate_sha1,
          expectation->leaf_certificate_sha256,
          expectation->root_certificate_sha1,
          expectation->root_certificate_sha256);
}

static bool HRAParseMachOSignatureRange(
    int descriptor,
    uint64_t file_length,
    uint64_t *out_signature_offset,
    size_t *out_signature_length) {
  if (descriptor < 0 || out_signature_offset == NULL ||
      out_signature_length == NULL || file_length < sizeof(struct mach_header_64)) {
    return false;
  }
  uint8_t header[sizeof(struct mach_header_64)];
  if (!HRAPreadAll(descriptor, header, sizeof(header), 0) ||
      HRAReadLittle32(header) != MH_MAGIC_64 ||
      (int32_t)HRAReadLittle32(header + 4) != CPU_TYPE_ARM64 ||
      HRAReadLittle32(header + 12) != MH_EXECUTE ||
      HRAReadLittle32(header + 28) != 0) {
    return false;
  }
  uint32_t command_count = HRAReadLittle32(header + 16);
  size_t command_bytes = HRAReadLittle32(header + 20);
  uint64_t commands_end = 0;
  if (command_count == 0 || command_count > 4096 || command_bytes < 8 ||
      command_bytes > 16 * 1024 * 1024 ||
      !HRAAdd64(sizeof(header), command_bytes, &commands_end) ||
      commands_end > file_length) {
    return false;
  }
  uint8_t *commands = malloc(command_bytes);
  if (commands == NULL) return false;
  bool valid = HRAPreadAll(
      descriptor, commands, command_bytes, sizeof(header));
  size_t cursor = 0;
  uint32_t signature_count = 0;
  uint64_t signature_offset = 0;
  size_t signature_length = 0;
  for (uint32_t index = 0; valid && index < command_count; index += 1) {
    size_t command_header_end = 0;
    if (!HRAAddSize(cursor, 8, &command_header_end) ||
        command_header_end > command_bytes) {
      valid = false;
      break;
    }
    uint32_t command = HRAReadLittle32(commands + cursor);
    size_t command_size = HRAReadLittle32(commands + cursor + 4);
    size_t command_end = 0;
    if (command_size < 8 || (command_size & 7) != 0 ||
        !HRAAddSize(cursor, command_size, &command_end) ||
        command_end > command_bytes) {
      valid = false;
      break;
    }
    if (command == LC_CODE_SIGNATURE) {
      if (command_size != sizeof(struct linkedit_data_command) ||
          signature_count != 0) {
        valid = false;
        break;
      }
      signature_count += 1;
      signature_offset = HRAReadLittle32(commands + cursor + 8);
      signature_length = HRAReadLittle32(commands + cursor + 12);
    }
    cursor = command_end;
  }
  uint64_t signature_end = 0;
  valid = valid && cursor == command_bytes && signature_count == 1 &&
      signature_offset >= commands_end && (signature_offset & 15) == 0 &&
      signature_length >= 12 &&
      signature_length <= HRAMaximumCodeSignatureBytes &&
      HRAAdd64(signature_offset, signature_length, &signature_end) &&
      signature_end == file_length;
  memset(commands, 0, command_bytes);
  free(commands);
  if (!valid) return false;
  *out_signature_offset = signature_offset;
  *out_signature_length = signature_length;
  return true;
}

static void HRAFillIdentity(
    const struct stat *metadata,
    const HRAParsedCodeDirectory *code_directory,
    const uint8_t cdhash[HRA_MACOS_CDHASH_LENGTH],
    const uint8_t full_file_sha256[HRA_MACOS_SHA256_LENGTH],
    HRAMacOSSelfManagedCodeIdentity *identity) {
  memset(identity, 0, sizeof(*identity));
  identity->device = (uint64_t)metadata->st_dev;
  identity->inode = (uint64_t)metadata->st_ino;
  identity->byte_length = (uint64_t)metadata->st_size;
  identity->mode = (uint32_t)metadata->st_mode;
  identity->link_count = (uint32_t)metadata->st_nlink;
  identity->uid = (uint32_t)metadata->st_uid;
  identity->gid = (uint32_t)metadata->st_gid;
  identity->file_flags = (uint32_t)metadata->st_flags;
  identity->modified_seconds = metadata->st_mtimespec.tv_sec;
  identity->modified_nanoseconds = metadata->st_mtimespec.tv_nsec;
  identity->changed_seconds = metadata->st_ctimespec.tv_sec;
  identity->changed_nanoseconds = metadata->st_ctimespec.tv_nsec;
  identity->created_seconds = metadata->st_birthtimespec.tv_sec;
  identity->created_nanoseconds = metadata->st_birthtimespec.tv_nsec;
  identity->code_limit = code_directory->code_limit;
  identity->code_directory_flags = code_directory->flags;
  identity->hash_type = code_directory->hash_type;
  identity->page_size_shift = code_directory->page_size_shift;
  memcpy(identity->cdhash, cdhash, HRA_MACOS_CDHASH_LENGTH);
  memcpy(identity->full_file_sha256,
         full_file_sha256,
         HRA_MACOS_SHA256_LENGTH);
}

static bool HRAIdentityMatches(
    const HRAMacOSSelfManagedCodeIdentity *left,
    const HRAMacOSSelfManagedCodeIdentity *right) {
  return left != NULL && right != NULL &&
      left->device == right->device && left->inode == right->inode &&
      left->byte_length == right->byte_length && left->mode == right->mode &&
      left->link_count == right->link_count && left->uid == right->uid &&
      left->gid == right->gid && left->file_flags == right->file_flags &&
      left->modified_seconds == right->modified_seconds &&
      left->modified_nanoseconds == right->modified_nanoseconds &&
      left->changed_seconds == right->changed_seconds &&
      left->changed_nanoseconds == right->changed_nanoseconds &&
      left->created_seconds == right->created_seconds &&
      left->created_nanoseconds == right->created_nanoseconds &&
      left->code_limit == right->code_limit &&
      left->code_directory_flags == right->code_directory_flags &&
      left->hash_type == right->hash_type &&
      left->page_size_shift == right->page_size_shift &&
      HRAConstantTimeEqual(
          left->cdhash, right->cdhash, HRA_MACOS_CDHASH_LENGTH) &&
      HRAConstantTimeEqual(
          left->full_file_sha256,
          right->full_file_sha256,
          HRA_MACOS_SHA256_LENGTH);
}

bool hra_macos_code_resources_entry_matches_sha256(
    const uint8_t *code_resources_bytes,
    size_t code_resources_length,
    const char *relative_path,
    size_t relative_path_length,
    const uint8_t expected_sha256[HRA_MACOS_SHA256_LENGTH]) {
  if (code_resources_bytes == NULL || code_resources_length == 0 ||
      code_resources_length > HRAMaximumExternalSlotBytes ||
      !HRARelativeResourcePathIsCanonical(
          relative_path, relative_path_length) ||
      expected_sha256 == NULL) {
    return false;
  }
  CFDataRef data = CFDataCreate(
      kCFAllocatorDefault,
      code_resources_bytes,
      (CFIndex)code_resources_length);
  CFErrorRef error = NULL;
  CFPropertyListFormat format = kCFPropertyListOpenStepFormat;
  CFPropertyListRef property_list = data == NULL
      ? NULL
      : CFPropertyListCreateWithData(
          kCFAllocatorDefault,
          data,
          kCFPropertyListImmutable,
          &format,
          &error);
  if (data != NULL) CFRelease(data);
  if (error != NULL) CFRelease(error);
  if (property_list == NULL ||
      CFGetTypeID(property_list) != CFDictionaryGetTypeID()) {
    if (property_list != NULL) CFRelease(property_list);
    return false;
  }
  CFStringRef path = CFStringCreateWithBytes(
      kCFAllocatorDefault,
      (const UInt8 *)relative_path,
      (CFIndex)relative_path_length,
      kCFStringEncodingUTF8,
      false);
  CFStringRef files_key = CFSTR("files");
  CFStringRef files2_key = CFSTR("files2");
  CFStringRef hash2_key = CFSTR("hash2");
  CFTypeRef raw_files = CFDictionaryGetValue(
      (CFDictionaryRef)property_list, files_key);
  CFTypeRef raw_files2 = CFDictionaryGetValue(
      (CFDictionaryRef)property_list, files2_key);
  bool valid = path != NULL && raw_files != NULL && raw_files2 != NULL &&
      CFGetTypeID(raw_files) == CFDictionaryGetTypeID() &&
      CFGetTypeID(raw_files2) == CFDictionaryGetTypeID();
  CFTypeRef legacy_entry = valid
      ? CFDictionaryGetValue((CFDictionaryRef)raw_files, path)
      : NULL;
  CFTypeRef modern_entry = valid
      ? CFDictionaryGetValue((CFDictionaryRef)raw_files2, path)
      : NULL;
  valid = valid && legacy_entry != NULL && modern_entry != NULL &&
      CFGetTypeID(legacy_entry) == CFDataGetTypeID() &&
      CFDataGetLength((CFDataRef)legacy_entry) == CC_SHA1_DIGEST_LENGTH &&
      CFGetTypeID(modern_entry) == CFDictionaryGetTypeID() &&
      CFDictionaryGetCount((CFDictionaryRef)modern_entry) == 1;
  CFTypeRef hash2 = valid
      ? CFDictionaryGetValue((CFDictionaryRef)modern_entry, hash2_key)
      : NULL;
  valid = valid && hash2 != NULL && CFGetTypeID(hash2) == CFDataGetTypeID() &&
      CFDataGetLength((CFDataRef)hash2) == HRA_MACOS_SHA256_LENGTH &&
      HRAConstantTimeEqual(
          CFDataGetBytePtr((CFDataRef)hash2),
          expected_sha256,
          HRA_MACOS_SHA256_LENGTH);
  if (path != NULL) CFRelease(path);
  CFRelease(property_list);
  return valid;
}

static bool HRAVerifyCodeResourcesEntries(
    const HRAMacOSSelfManagedCodeExpectation *expectation,
    const HRAHeldExternalSlot *external_slots,
    size_t external_slot_count) {
  if (expectation == NULL) return false;
  if (expectation->code_resources_file_count == 0) return true;
  const HRAHeldExternalSlot *code_resources = HRAExternalSlot(
      external_slots, external_slot_count, HRACSSlotResourceDirectory);
  if (code_resources == NULL) return false;
  for (size_t index = 0;
       index < expectation->code_resources_file_count;
       index += 1) {
    const HRAMacOSCodeResourcesFileExpectation *file =
        &expectation->code_resources_files[index];
    if (!hra_macos_code_resources_entry_matches_sha256(
            code_resources->bytes,
            code_resources->length,
            file->relative_path,
            file->relative_path_length,
            file->sha256)) {
      return false;
    }
  }
  return true;
}

bool hra_macos_verify_self_managed_code_identity(
    const HRAMacOSSelfManagedCodeExpectation *expectation,
    HRAMacOSSelfManagedCodeIdentity *out_identity) {
  if (out_identity == NULL) return false;
  memset(out_identity, 0, sizeof(*out_identity));
  char path[PATH_MAX];
  memset(path, 0, sizeof(path));
  if (!HRAExpectationIsWellFormed(expectation, path)) return false;
  struct stat path_before;
  memset(&path_before, 0, sizeof(path_before));
  if (lstat(path, &path_before) != 0 || !S_ISREG(path_before.st_mode) ||
      path_before.st_nlink != 1 ||
      (uint32_t)path_before.st_uid != expectation->expected_uid ||
      ((uint32_t)path_before.st_mode & 07777u) !=
          expectation->expected_permissions ||
      path_before.st_size <= 0) {
    return false;
  }
  int descriptor = open(path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (descriptor < 0) return false;
  struct stat descriptor_before;
  memset(&descriptor_before, 0, sizeof(descriptor_before));
  bool valid = fstat(descriptor, &descriptor_before) == 0 &&
      HRAStatIdentityMatches(&path_before, &descriptor_before) &&
      HRAPathAndDescriptorAreExact(path, descriptor, &descriptor_before);
  HRAHeldExternalSlot external_slots[HRACSSlotLibraryConstraint];
  memset(external_slots, 0, sizeof(external_slots));
  for (size_t index = 0;
       index < HRACSSlotLibraryConstraint;
       index += 1) {
    external_slots[index].descriptor = -1;
  }
  if (valid) {
    valid = HRAOpenHeldExternalSlots(expectation, external_slots);
  }
  uint8_t *signature = NULL;
  uint64_t signature_offset = 0;
  size_t signature_length = 0;
  HRACodeBlob blobs[HRAMaximumSuperBlobCount];
  size_t blob_count = 0;
  const HRACodeBlob *code_directory_blob = NULL;
  const HRACodeBlob *cms_blob = NULL;
  HRAParsedCodeDirectory code_directory;
  memset(blobs, 0, sizeof(blobs));
  memset(&code_directory, 0, sizeof(code_directory));
  uint8_t full_code_directory_hash[CC_SHA384_DIGEST_LENGTH];
  memset(full_code_directory_hash, 0, sizeof(full_code_directory_hash));
  size_t full_code_directory_hash_length = 0;
  uint8_t full_file_sha256[HRA_MACOS_SHA256_LENGTH];
  memset(full_file_sha256, 0, sizeof(full_file_sha256));
  if (valid) {
    valid = HRAParseMachOSignatureRange(
        descriptor,
        (uint64_t)descriptor_before.st_size,
        &signature_offset,
        &signature_length);
  }
  if (valid) {
    signature = malloc(signature_length);
    valid = signature != NULL && HRAPreadAll(
        descriptor, signature, signature_length, signature_offset);
  }
  if (valid) {
    valid = HRAParseSuperBlob(
        signature,
        signature_length,
        blobs,
        &blob_count,
        &code_directory_blob,
        &cms_blob) &&
      HRAParseCodeDirectory(
        code_directory_blob, signature_offset, expectation, &code_directory) &&
      HRAVerifyCodeAndSpecialSlots(
        descriptor,
        &code_directory,
        blobs,
        blob_count,
        external_slots,
        expectation->external_special_slot_count,
        expectation) &&
      HRAVerifyCodeResourcesEntries(
        expectation,
        external_slots,
        expectation->external_special_slot_count) &&
      HRAHashBytes(
        code_directory.hash_type,
        code_directory.bytes,
        code_directory.length,
        full_code_directory_hash,
        &full_code_directory_hash_length) &&
      full_code_directory_hash_length >= HRA_MACOS_CDHASH_LENGTH &&
      HRAVerifyDetachedCMS(cms_blob, &code_directory, expectation) &&
      HRAHashDescriptorSHA256(
          descriptor,
          (uint64_t)descriptor_before.st_size,
          full_file_sha256);
  }
  struct stat descriptor_after;
  memset(&descriptor_after, 0, sizeof(descriptor_after));
  if (valid) {
    valid = fstat(descriptor, &descriptor_after) == 0 &&
        HRAStatIdentityMatches(&descriptor_before, &descriptor_after) &&
        HRAPathAndDescriptorAreExact(path, descriptor, &descriptor_before) &&
        HRAHeldExternalSlotsRemainExact(
            external_slots, expectation->external_special_slot_count);
  }
  if (valid) {
    HRAFillIdentity(
        &descriptor_before,
        &code_directory,
        full_code_directory_hash,
        full_file_sha256,
        out_identity);
  }
  memset(full_code_directory_hash, 0, sizeof(full_code_directory_hash));
  memset(full_file_sha256, 0, sizeof(full_file_sha256));
  if (signature != NULL) {
    memset(signature, 0, signature_length);
    free(signature);
  }
  HRAReleaseHeldExternalSlots(
      external_slots, expectation->external_special_slot_count);
  close(descriptor);
  if (!valid) memset(out_identity, 0, sizeof(*out_identity));
  return valid;
}

bool hra_macos_reverify_self_managed_code_identity(
    const HRAMacOSSelfManagedCodeExpectation *expectation,
    const HRAMacOSSelfManagedCodeIdentity *expected_identity) {
  if (expected_identity == NULL) return false;
  HRAMacOSSelfManagedCodeIdentity actual;
  memset(&actual, 0, sizeof(actual));
  bool matches = hra_macos_verify_self_managed_code_identity(
      expectation, &actual) && HRAIdentityMatches(&actual, expected_identity);
  memset(&actual, 0, sizeof(actual));
  return matches;
}

static bool HRACFStringMatchesBytes(
    CFStringRef string,
    const char *expected,
    size_t expected_length) {
  if (string == NULL || expected == NULL || expected_length == 0 ||
      CFGetTypeID(string) != CFStringGetTypeID()) {
    return false;
  }
  CFIndex utf8_length = CFStringGetMaximumSizeForEncoding(
      CFStringGetLength(string), kCFStringEncodingUTF8);
  if (utf8_length < 0 || (uint64_t)utf8_length >= SIZE_MAX) return false;
  size_t capacity = (size_t)utf8_length + 1;
  char *buffer = calloc(capacity, 1);
  if (buffer == NULL) return false;
  bool matches = CFStringGetCString(
      string, buffer, (CFIndex)capacity, kCFStringEncodingUTF8) &&
      strlen(buffer) == expected_length &&
      memcmp(buffer, expected, expected_length) == 0;
  memset(buffer, 0, capacity);
  free(buffer);
  return matches;
}

bool hra_macos_self_managed_dynamic_code_matches(
    pid_t process_identifier,
    const char *expected_canonical_path,
    size_t expected_canonical_path_length,
    const char *expected_identifier,
    size_t expected_identifier_length,
    const uint8_t expected_cdhash[HRA_MACOS_CDHASH_LENGTH],
    uint32_t expected_code_directory_flags) {
  @autoreleasepool {
    if (process_identifier <= 1 || expected_canonical_path == NULL ||
        expected_canonical_path_length == 0 ||
        expected_canonical_path_length >= PATH_MAX ||
        expected_canonical_path[0] != '/' ||
        memchr(expected_canonical_path,
               '\0',
               expected_canonical_path_length) != NULL ||
        expected_identifier == NULL || expected_identifier_length == 0 ||
        expected_identifier_length > HRAMaximumIdentifierBytes ||
        memchr(expected_identifier, '\0', expected_identifier_length) != NULL ||
        expected_cdhash == NULL ||
        (expected_code_directory_flags &
         HRA_MACOS_CODE_DIRECTORY_RUNTIME) == 0) {
      return false;
    }
    char expected_path[PATH_MAX];
    memset(expected_path, 0, sizeof(expected_path));
    memcpy(expected_path,
           expected_canonical_path,
           expected_canonical_path_length);
    char resolved[PATH_MAX];
    memset(resolved, 0, sizeof(resolved));
    if (realpath(expected_path, resolved) == NULL ||
        strcmp(resolved, expected_path) != 0) {
      return false;
    }
    SecCodeRef code = NULL;
    if (process_identifier == getpid()) {
      if (SecCodeCopySelf(kSecCSDefaultFlags, &code) != errSecSuccess ||
          code == NULL) {
        return false;
      }
    } else {
      CFNumberRef process = CFNumberCreate(
          kCFAllocatorDefault, kCFNumberIntType, &process_identifier);
      CFDataRef hash = CFDataCreate(
          kCFAllocatorDefault,
          expected_cdhash,
          HRA_MACOS_CDHASH_LENGTH);
      if (process == NULL || hash == NULL) {
        if (process != NULL) CFRelease(process);
        if (hash != NULL) CFRelease(hash);
        return false;
      }
      // PID alone can select a disk-derived static object. Supplying the
      // descriptor-computed CDHash forces Security.framework to select the
      // exact live guest generation before we inspect its dynamic status.
      const void *keys[] = {
        kSecGuestAttributePid,
        kSecGuestAttributeHash,
      };
      const void *values[] = { process, hash };
      CFDictionaryRef attributes = CFDictionaryCreate(
          kCFAllocatorDefault,
          keys,
          values,
          2,
          &kCFTypeDictionaryKeyCallBacks,
          &kCFTypeDictionaryValueCallBacks);
      CFRelease(process);
      CFRelease(hash);
      if (attributes == NULL) return false;
      OSStatus status = SecCodeCopyGuestWithAttributes(
          NULL, attributes, kSecCSDefaultFlags, &code);
      CFRelease(attributes);
      if (status != errSecSuccess || code == NULL) return false;
    }
    CFURLRef raw_path = NULL;
    CFDictionaryRef information = NULL;
    bool valid = SecCodeCopyPath(code, kSecCSDefaultFlags, &raw_path) ==
            errSecSuccess && raw_path != NULL &&
        SecCodeCopySigningInformation(
            code,
            kSecCSSigningInformation | kSecCSDynamicInformation,
            &information) == errSecSuccess && information != NULL;
    char actual_path[PATH_MAX];
    memset(actual_path, 0, sizeof(actual_path));
    if (valid) {
      valid = CFURLGetFileSystemRepresentation(
          raw_path, true, (UInt8 *)actual_path, sizeof(actual_path)) &&
          strlen(actual_path) == expected_canonical_path_length &&
          memcmp(actual_path,
                 expected_canonical_path,
                 expected_canonical_path_length) == 0;
    }
    CFTypeRef raw_status = valid
        ? CFDictionaryGetValue(information, kSecCodeInfoStatus)
        : NULL;
    CFTypeRef raw_flags = valid
        ? CFDictionaryGetValue(information, kSecCodeInfoFlags)
        : NULL;
    CFTypeRef raw_identifier = valid
        ? CFDictionaryGetValue(information, kSecCodeInfoIdentifier)
        : NULL;
    CFTypeRef raw_cdhash = valid
        ? CFDictionaryGetValue(information, kSecCodeInfoUnique)
        : NULL;
    uint32_t status_value = 0;
    uint32_t flags_value = 0;
    valid = valid && raw_status != NULL && raw_flags != NULL &&
        raw_identifier != NULL && raw_cdhash != NULL &&
        CFGetTypeID(raw_status) == CFNumberGetTypeID() &&
        CFGetTypeID(raw_flags) == CFNumberGetTypeID() &&
        CFGetTypeID(raw_identifier) == CFStringGetTypeID() &&
        CFGetTypeID(raw_cdhash) == CFDataGetTypeID() &&
        CFNumberGetValue(
            (CFNumberRef)raw_status, kCFNumberSInt32Type, &status_value) &&
        CFNumberGetValue(
            (CFNumberRef)raw_flags, kCFNumberSInt32Type, &flags_value) &&
        (status_value & kSecCodeStatusValid) != 0 &&
        flags_value == expected_code_directory_flags &&
        HRACFStringMatchesBytes(
            (CFStringRef)raw_identifier,
            expected_identifier,
            expected_identifier_length) &&
        CFDataGetLength((CFDataRef)raw_cdhash) ==
            HRA_MACOS_CDHASH_LENGTH &&
        HRAConstantTimeEqual(
            CFDataGetBytePtr((CFDataRef)raw_cdhash),
            expected_cdhash,
            HRA_MACOS_CDHASH_LENGTH);
    if (information != NULL) CFRelease(information);
    if (raw_path != NULL) CFRelease(raw_path);
    CFRelease(code);
    return valid;
  }
}
