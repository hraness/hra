#import "macos_keychain_custodian.h"
#import "macos_self_managed_code_identity.h"

#import <CommonCrypto/CommonDigest.h>
#import <Foundation/Foundation.h>
#import <Security/Security.h>
#import <errno.h>
#import <fcntl.h>
#import <limits.h>
#import <libproc.h>
#import <os/lock.h>
#import <poll.h>
#import <signal.h>
#import <spawn.h>
#import <stdatomic.h>
#import <stdio.h>
#import <stdlib.h>
#import <string.h>
#import <sys/proc.h>
#import <sys/stat.h>
#import <sys/wait.h>
#import <time.h>
#import <unistd.h>


static NSString *const HRAHarnessKeychainService =
    @"com.0thernet.oprte.context-heap.v2";
static NSString *const HRAHarnessKeychainAccount =
    @"installation-master";
static NSString *const HRAHarnessReconciliationAccount =
    @"legacy-reconciliation";
static NSString *const HRALegacyGatewayCDHashHex =
    @"9f39a6414ae834959ec63b39237a0ee426fd978a";
static NSString *const HRAKeychainCustodianIdentifier =
    @"oprte-keychain-custodian";
static NSString *const HRAApplicationIdentifier = @"kitchen.hraness";
static NSString *const HRALegacyGatewayIdentifier =
    @"kitchen.hraness.gateway";
static NSString *const HRALegacyGatewayRequirement =
    @"identifier \"kitchen.hraness.gateway\" and certificate root = H\"3b08b5c6d4209824787da73fd5108d66954a16e9\" and certificate leaf = H\"8e70be5be2b1804a473f4ef1d337930bdbd17dc0\"";
static NSString *const HRALegacyGatewayRelativePath =
    @"runtime/legacy/preview-0.1.4-5/oprte-gateway";
static const off_t HRALegacyGatewayByteLength = 69161536;
static const uint8_t HRALegacyGatewaySHA256[] = {
  0x51, 0x8c, 0xca, 0x92, 0x54, 0x18, 0x0f, 0x23,
  0xb3, 0xe8, 0xf5, 0x24, 0xa4, 0x55, 0x11, 0x79,
  0xee, 0x1f, 0xd5, 0x6d, 0x43, 0x3a, 0xb0, 0xcb,
  0x93, 0xb3, 0x93, 0x76, 0x0b, 0x63, 0x80, 0xcf,
};
static const uint8_t HRALegacyGatewayCDHash[] = {
  0x9f, 0x39, 0xa6, 0x41, 0x4a, 0xe8, 0x34, 0x95, 0x9e, 0xc6,
  0x3b, 0x39, 0x23, 0x7a, 0x0e, 0xe4, 0x26, 0xfd, 0x97, 0x8a,
};
static const uint8_t HRAPreviewLeafCertificateSHA1[] = {
  0x8e, 0x70, 0xbe, 0x5b, 0xe2, 0xb1, 0x80, 0x4a, 0x47, 0x3f,
  0x4e, 0xf1, 0xd3, 0x37, 0x93, 0x0b, 0xdb, 0xd1, 0x7d, 0xc0,
};
static const uint8_t HRAPreviewLeafCertificateSHA256[] = {
  0x6e, 0xc2, 0xc6, 0x3a, 0x7d, 0x3b, 0xf2, 0x8e,
  0x54, 0xc9, 0xc3, 0x84, 0x86, 0xdc, 0x37, 0xb8,
  0xf7, 0xc9, 0x4a, 0xbf, 0xc6, 0xfb, 0xc0, 0x7e,
  0xd5, 0x17, 0x46, 0x79, 0x2a, 0x5a, 0xe7, 0x93,
};
static const uint8_t HRAPreviewRootCertificateSHA1[] = {
  0x3b, 0x08, 0xb5, 0xc6, 0xd4, 0x20, 0x98, 0x24, 0x78, 0x7d,
  0xa7, 0x3f, 0xd5, 0x10, 0x8d, 0x66, 0x95, 0x4a, 0x16, 0xe9,
};
static const uint8_t HRAPreviewRootCertificateSHA256[] = {
  0xfa, 0x59, 0x3d, 0x3d, 0x8c, 0x22, 0x43, 0x41,
  0x2f, 0x89, 0x64, 0xed, 0x7a, 0x24, 0xf4, 0x55,
  0xe3, 0xab, 0x87, 0xb7, 0xc5, 0x06, 0x86, 0x2c,
  0xe8, 0x1a, 0x59, 0xc1, 0x9c, 0xb5, 0xec, 0xb9,
};
static const char *HRALegacyHarnessReadScript =
    "const descriptor={service:'com.0thernet.oprte.context-heap.v1',"
    "name:'installation-master'};"
    "const value=await Bun.secrets.get(descriptor);"
    "await Bun.write(Bun.stdout,JSON.stringify(value===null?"
    "{version:1,state:'absent'}:{version:1,state:'present',value}));";
static const char *HRALegacyHarnessDeleteScript =
    "const descriptor={service:'com.0thernet.oprte.context-heap.v1',"
    "name:'installation-master'};"
    "const deleted=await Bun.secrets.delete(descriptor);"
    "const after=await Bun.secrets.get(descriptor);"
    "if(after!==null)process.exit(1);"
    "await Bun.write(Bun.stdout,JSON.stringify({version:1,deleted}));";
static const size_t HRACustodianMaximumRequestBytes = 512;
static const size_t HRACustodianMaximumResponseBytes = 512;
static const uint32_t HRACustodianReapTimeoutMilliseconds = 1000;
static const uint32_t HRALegacyGroupQuiescenceTimeoutMilliseconds = 1000;
// Once Native stops treating a PID/PGID as signalable, cancellation must never
// use that number again. An ambiguous retirement therefore poisons the custody
// lane until the Native host itself restarts.
static const int HRAProcessRetiring = -3;
static const int HRACustodianRetirementUnproven = -2;
static const int HRALegacyRetirementUnproven = -2;
static _Atomic(int) HRACurrentCustodianProcess = -1;
static _Atomic(int) HRACurrentLegacyGatewayProcess = -1;
static os_unfair_lock HRACustodianProcessLock = OS_UNFAIR_LOCK_INIT;
static os_unfair_lock HRALegacyGatewayProcessLock = OS_UNFAIR_LOCK_INIT;
static uint64_t HRACustodianGeneration = 0;
static uint64_t HRALegacyGatewayGeneration = 0;
static bool HRACustodianGenerationPrepared = false;
static bool HRALegacyGatewayGenerationPrepared = false;
static bool HRACustodianGenerationCancelled = true;
static bool HRALegacyGatewayGenerationCancelled = true;
static bool HRACustodianUntrackedRetirementUnproven = false;
static bool HRALegacyUntrackedRetirementUnproven = false;
static pid_t HRAAuthorizedParentProcess = -1;


typedef NS_ENUM(NSUInteger, HRAKeychainReadState) {
  HRAKeychainReadFailure = 0,
  HRAKeychainReadAbsent = 1,
  HRAKeychainReadPresent = 2,
};

static void HRASecureZero(void *bytes, size_t length) {
  volatile uint8_t *cursor = (volatile uint8_t *)bytes;
  while (length > 0) {
    *cursor = 0;
    cursor += 1;
    length -= 1;
  }
  atomic_signal_fence(memory_order_seq_cst);
}

static bool HRAJSONIntegerIsExactlyOne(id _Nullable value) {
  if (value == nil ||
      CFGetTypeID((__bridge CFTypeRef)value) != CFNumberGetTypeID() ||
      CFNumberIsFloatType((__bridge CFNumberRef)value)) {
    return false;
  }
  int64_t integer = 0;
  return CFNumberGetValue(
             (__bridge CFNumberRef)value,
             kCFNumberSInt64Type,
             &integer) &&
      integer == 1;
}

static NSDictionary *_Nullable HRACopySigningInformationForCode(
    SecCodeRef code) {
  CFDictionaryRef information = NULL;
  if (SecCodeCopySigningInformation(
          code, kSecCSSigningInformation, &information) != errSecSuccess ||
      information == NULL) {
    return nil;
  }
  return CFBridgingRelease(information);
}

static NSArray<NSData *> *_Nullable HRACertificateChain(
    NSDictionary *information) {
  id raw = information[(__bridge NSString *)kSecCodeInfoCertificates];
  if (raw == nil) return @[];
  if (![raw isKindOfClass:[NSArray class]]) return nil;
  NSMutableArray<NSData *> *chain = [NSMutableArray array];
  for (id value in (NSArray *)raw) {
    if (CFGetTypeID((__bridge CFTypeRef)value) != SecCertificateGetTypeID()) {
      return nil;
    }
    CFDataRef data = SecCertificateCopyData((__bridge SecCertificateRef)value);
    if (data == NULL) return nil;
    [chain addObject:CFBridgingRelease(data)];
  }
  return chain;
}

static bool HRAParentIdentityIsAuthorized(pid_t parentProcess) {
  if (parentProcess <= 1 || getppid() != parentProcess) return false;
  SecCodeRef selfCode = NULL;
  if (SecCodeCopySelf(kSecCSDefaultFlags, &selfCode) != errSecSuccess ||
      selfCode == NULL) {
    return false;
  }
  OSStatus selfStatus = SecCodeCheckValidity(
      selfCode, kSecCSStrictValidate, NULL);
  NSDictionary *selfInformation = selfStatus == errSecSuccess
      ? HRACopySigningInformationForCode(selfCode)
      : nil;
  CFRelease(selfCode);
  if (selfInformation == nil ||
      ![selfInformation[(__bridge NSString *)kSecCodeInfoIdentifier]
          isEqualToString:HRAKeychainCustodianIdentifier]) {
    return false;
  }

  NSDictionary *attributes = @{
    (__bridge NSString *)kSecGuestAttributePid: @(parentProcess),
  };
  SecCodeRef parentCode = NULL;
  if (SecCodeCopyGuestWithAttributes(
          NULL,
          (__bridge CFDictionaryRef)attributes,
          kSecCSDefaultFlags,
          &parentCode) != errSecSuccess || parentCode == NULL) {
    return false;
  }
  OSStatus parentStatus = SecCodeCheckValidity(
      parentCode, kSecCSStrictValidate, NULL);
  NSDictionary *parentInformation = parentStatus == errSecSuccess
      ? HRACopySigningInformationForCode(parentCode)
      : nil;
  CFRelease(parentCode);
  if (parentInformation == nil || getppid() != parentProcess) return false;

  NSString *parentIdentifier =
      parentInformation[(__bridge NSString *)kSecCodeInfoIdentifier];
  NSArray<NSData *> *selfCertificates =
      HRACertificateChain(selfInformation);
  NSArray<NSData *> *parentCertificates =
      HRACertificateChain(parentInformation);
  if (selfCertificates == nil || parentCertificates == nil) return false;
  // The helper is a credential boundary. Ad-hoc identifiers are caller-chosen,
  // so even an exact `hra` identifier cannot authenticate a raw Debug parent.
  // Only the signed application with the helper's exact certificate chain may
  // inherit Keychain custody.
  return selfCertificates.count > 0 &&
      [parentIdentifier isEqualToString:HRAApplicationIdentifier] &&
      [parentCertificates isEqualToArray:selfCertificates];
}

static bool HRAAuthorizedParentRemainsLive(void) {
  pid_t expected = HRAAuthorizedParentProcess;
  return expected > 1 && getppid() == expected &&
      HRAParentIdentityIsAuthorized(expected) && getppid() == expected;
}

static bool HRAWriteAll(int descriptor, const uint8_t *bytes, size_t length) {
  size_t offset = 0;
  while (offset < length) {
    ssize_t written = write(descriptor, bytes + offset, length - offset);
    if (written > 0) {
      offset += (size_t)written;
      continue;
    }
    if (written < 0 && errno == EINTR) continue;
    return false;
  }
  return true;
}

static bool HRAConfigurePipeWriterNoSigPipe(int descriptor) {
#if defined(F_SETNOSIGPIPE)
  return descriptor >= 0 && fcntl(descriptor, F_SETNOSIGPIPE, 1) == 0;
#else
  (void)descriptor;
  return false;
#endif
}

static const char *_Nullable HRAExactFileSystemRepresentation(
    NSString *path,
    const char *expectedBytes,
    size_t expectedLength) {
  if (path == nil || expectedBytes == NULL || expectedLength == 0 ||
      expectedLength > 4096) {
    return NULL;
  }
  const char *representation = path.fileSystemRepresentation;
  if (representation == NULL ||
      strnlen(representation, expectedLength + 1) != expectedLength ||
      memcmp(representation, expectedBytes, expectedLength) != 0) {
    return NULL;
  }
  return representation;
}

static NSMutableData *_Nullable HRAReadBoundedStandardInput(void) {
  NSMutableData *input = [NSMutableData data];
  uint8_t buffer[128];
  memset(buffer, 0, sizeof(buffer));
  while (true) {
    ssize_t count = read(STDIN_FILENO, buffer, sizeof(buffer));
    if (count == 0) break;
    if (count < 0) {
      if (errno == EINTR) continue;
      HRASecureZero(buffer, sizeof(buffer));
      if (input.length > 0) HRASecureZero(input.mutableBytes, input.length);
      return nil;
    }
    if (input.length + (NSUInteger)count > HRACustodianMaximumRequestBytes) {
      HRASecureZero(buffer, sizeof(buffer));
      if (input.length > 0) HRASecureZero(input.mutableBytes, input.length);
      return nil;
    }
    [input appendBytes:buffer length:(NSUInteger)count];
    HRASecureZero(buffer, sizeof(buffer));
  }
  HRASecureZero(buffer, sizeof(buffer));
  return input.length == 0 ? nil : input;
}

static NSString *_Nullable HRACanonicalInstallEnvelope(id _Nullable value) {
  if (![value isKindOfClass:[NSString class]]) return nil;
  NSString *text = value;
  NSData *encoded = [text dataUsingEncoding:NSUTF8StringEncoding];
  if (encoded.length == 0 || encoded.length > 256) return nil;
  id parsed = [NSJSONSerialization JSONObjectWithData:encoded options:0 error:nil];
  if (![parsed isKindOfClass:[NSDictionary class]]) return nil;
  NSDictionary *object = parsed;
  if (object.count != 3 ||
      !HRAJSONIntegerIsExactlyOne(object[@"version"]) ||
      ![object[@"algorithm"] isEqual:@"hkdf-sha256"] ||
      ![object[@"key"] isKindOfClass:[NSString class]]) {
    return nil;
  }
  NSString *key = object[@"key"];
  if (key.length != 43) return nil;
  NSCharacterSet *invalid =
      [[NSCharacterSet characterSetWithCharactersInString:
          @"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-"]
          invertedSet];
  if ([key rangeOfCharacterFromSet:invalid].location != NSNotFound) return nil;
  NSString *standard = [[key stringByReplacingOccurrencesOfString:@"-"
                                                        withString:@"+"]
      stringByReplacingOccurrencesOfString:@"_" withString:@"/"];
  standard = [standard stringByAppendingString:@"="];
  NSData *decoded = [[NSData alloc] initWithBase64EncodedString:standard
                                                        options:0];
  if (decoded.length != 32) return nil;
  NSString *roundTrip = [decoded base64EncodedStringWithOptions:0];
  roundTrip = [[roundTrip stringByReplacingOccurrencesOfString:@"+"
                                                     withString:@"-"]
      stringByReplacingOccurrencesOfString:@"/" withString:@"_"];
  while ([roundTrip hasSuffix:@"="]) {
    roundTrip = [roundTrip substringToIndex:roundTrip.length - 1];
  }
  if (![roundTrip isEqualToString:key]) return nil;
  NSString *canonical = [NSString stringWithFormat:
      @"{\"version\":1,\"algorithm\":\"hkdf-sha256\",\"key\":\"%@\"}",
      key];
  return [canonical isEqualToString:text] ? canonical : nil;
}

static NSDictionary *HRAKeychainQueryForAccount(NSString *account) {
  return @{
    (__bridge id)kSecClass: (__bridge id)kSecClassGenericPassword,
    (__bridge id)kSecAttrService: HRAHarnessKeychainService,
    (__bridge id)kSecAttrAccount: account,
  };
}

static NSDictionary *HRAKeychainQuery(void) {
  return HRAKeychainQueryForAccount(HRAHarnessKeychainAccount);
}

static NSDictionary *HRAReconciliationKeychainQuery(void) {
  return HRAKeychainQueryForAccount(HRAHarnessReconciliationAccount);
}

static HRAKeychainReadState HRAReadInstallEnvelope(
    NSString *_Nullable *_Nonnull outValue) {
  *outValue = nil;
  if (!HRAAuthorizedParentRemainsLive()) return HRAKeychainReadFailure;
  NSMutableDictionary *query = [HRAKeychainQuery() mutableCopy];
  query[(__bridge id)kSecReturnData] = @YES;
  query[(__bridge id)kSecMatchLimit] = (__bridge id)kSecMatchLimitOne;
  CFTypeRef raw = NULL;
  OSStatus status = SecItemCopyMatching((__bridge CFDictionaryRef)query, &raw);
  if (status == errSecItemNotFound) return HRAKeychainReadAbsent;
  if (status != errSecSuccess || raw == NULL ||
      CFGetTypeID(raw) != CFDataGetTypeID()) {
    if (raw != NULL) CFRelease(raw);
    return HRAKeychainReadFailure;
  }
  NSData *data = CFBridgingRelease(raw);
  NSString *text = [[NSString alloc] initWithData:data
                                         encoding:NSUTF8StringEncoding];
  NSString *canonical = HRACanonicalInstallEnvelope(text);
  if (canonical == nil) return HRAKeychainReadFailure;
  *outValue = canonical;
  return HRAKeychainReadPresent;
}

static bool HRASetInstallEnvelopeIfAbsent(
    NSString *value,
    bool *outCreated,
    NSString *_Nullable *_Nonnull outAuthoritative) {
  NSString *canonical = HRACanonicalInstallEnvelope(value);
  if (canonical == nil) return false;
  if (!HRAAuthorizedParentRemainsLive()) return false;
  NSMutableDictionary *item = [HRAKeychainQuery() mutableCopy];
  item[(__bridge id)kSecValueData] =
      [canonical dataUsingEncoding:NSUTF8StringEncoding];
  OSStatus status = SecItemAdd((__bridge CFDictionaryRef)item, NULL);
  if (status != errSecSuccess && status != errSecDuplicateItem) return false;
  *outCreated = status == errSecSuccess;
  NSString *authoritative = nil;
  if (HRAReadInstallEnvelope(&authoritative) != HRAKeychainReadPresent ||
      authoritative == nil) {
    return false;
  }
  *outAuthoritative = authoritative;
  return true;
}

static bool HRADeleteInstallEnvelope(bool *outDeleted) {
  if (!HRAAuthorizedParentRemainsLive()) return false;
  OSStatus status = SecItemDelete((__bridge CFDictionaryRef)HRAKeychainQuery());
  if (status != errSecSuccess && status != errSecItemNotFound) return false;
  *outDeleted = status == errSecSuccess;
  NSString *unexpected = nil;
  return HRAReadInstallEnvelope(&unexpected) == HRAKeychainReadAbsent;
}

static NSString *_Nullable HRACanonicalReconciliationMarker(
    id _Nullable value) {
  if (![value isKindOfClass:[NSString class]]) return nil;
  NSString *text = value;
  NSData *encoded = [text dataUsingEncoding:NSUTF8StringEncoding];
  if (encoded.length == 0 || encoded.length > 320) return nil;
  id parsed = [NSJSONSerialization JSONObjectWithData:encoded options:0 error:nil];
  if (![parsed isKindOfClass:[NSDictionary class]]) return nil;
  NSDictionary *object = parsed;
  if (object.count != 6 ||
      !HRAJSONIntegerIsExactlyOne(object[@"version"]) ||
      ![object[@"phase"] isKindOfClass:[NSString class]] ||
      ![object[@"bridgeCDHash"] isEqual:HRALegacyGatewayCDHashHex] ||
      ![object[@"legacyState"] isKindOfClass:[NSString class]] ||
      ![object[@"envelopeState"] isKindOfClass:[NSString class]]) {
    return nil;
  }
  NSString *phase = object[@"phase"];
  NSString *legacyState = object[@"legacyState"];
  NSString *envelopeState = object[@"envelopeState"];
  id digestValue = object[@"envelopeSHA256"];
  bool prepared = [phase isEqual:@"prepared"];
  bool committed = [phase isEqual:@"committed"];
  bool legacyAbsent = [legacyState isEqual:@"absent"];
  bool legacyPresent = [legacyState isEqual:@"present"];
  bool envelopeAbsent = [envelopeState isEqual:@"absent"];
  bool envelopePresent = [envelopeState isEqual:@"present"];
  if ((!prepared && !committed) || (!legacyAbsent && !legacyPresent) ||
      (!envelopeAbsent && !envelopePresent)) {
    return nil;
  }
  NSString *digest = nil;
  if ([digestValue isKindOfClass:[NSString class]]) {
    digest = digestValue;
    NSCharacterSet *invalid =
        [[NSCharacterSet characterSetWithCharactersInString:@"0123456789abcdef"]
            invertedSet];
    if (digest.length != 64 ||
        [digest rangeOfCharacterFromSet:invalid].location != NSNotFound) {
      return nil;
    }
  } else if (digestValue != [NSNull null]) {
    return nil;
  }
  if (prepared) {
    if (!envelopePresent || digest == nil) return nil;
  } else if (envelopeAbsent) {
    if (!legacyAbsent || digest != nil) return nil;
  } else if (digest == nil) {
    return nil;
  }
  NSString *digestJSON = digest == nil
      ? @"null"
      : [NSString stringWithFormat:@"\"%@\"", digest];
  NSString *canonical = [NSString stringWithFormat:
      @"{\"version\":1,\"phase\":\"%@\",\"bridgeCDHash\":\"%@\","
       @"\"legacyState\":\"%@\",\"envelopeState\":\"%@\","
       @"\"envelopeSHA256\":%@}",
      phase,
      HRALegacyGatewayCDHashHex,
      legacyState,
      envelopeState,
      digestJSON];
  return [canonical isEqualToString:text] ? canonical : nil;
}

static NSDictionary *_Nullable HRAReconciliationMarkerObject(
    NSString *canonical) {
  NSData *encoded = [canonical dataUsingEncoding:NSUTF8StringEncoding];
  id parsed = [NSJSONSerialization JSONObjectWithData:encoded options:0 error:nil];
  return [parsed isKindOfClass:[NSDictionary class]] ? parsed : nil;
}

static HRAKeychainReadState HRAReadReconciliationMarker(
    NSString *_Nullable *_Nonnull outValue) {
  *outValue = nil;
  if (!HRAAuthorizedParentRemainsLive()) return HRAKeychainReadFailure;
  NSMutableDictionary *query =
      [HRAReconciliationKeychainQuery() mutableCopy];
  query[(__bridge id)kSecReturnData] = @YES;
  query[(__bridge id)kSecMatchLimit] = (__bridge id)kSecMatchLimitOne;
  CFTypeRef raw = NULL;
  OSStatus status = SecItemCopyMatching((__bridge CFDictionaryRef)query, &raw);
  if (status == errSecItemNotFound) return HRAKeychainReadAbsent;
  if (status != errSecSuccess || raw == NULL ||
      CFGetTypeID(raw) != CFDataGetTypeID()) {
    if (raw != NULL) CFRelease(raw);
    return HRAKeychainReadFailure;
  }
  NSData *data = CFBridgingRelease(raw);
  NSString *text = [[NSString alloc] initWithData:data
                                         encoding:NSUTF8StringEncoding];
  NSString *canonical = HRACanonicalReconciliationMarker(text);
  if (canonical == nil) return HRAKeychainReadFailure;
  *outValue = canonical;
  return HRAKeychainReadPresent;
}

static bool HRAReconciliationTransitionIsAllowed(
    NSString *_Nullable existing,
    NSString *desired,
    bool prepareAction) {
  NSDictionary *next = HRAReconciliationMarkerObject(desired);
  if (next == nil) return false;
  NSString *nextPhase = next[@"phase"];
  if (prepareAction != [nextPhase isEqual:@"prepared"]) return false;
  if (existing == nil) {
    if (prepareAction) {
      return [next[@"legacyState"] isEqual:@"present"] &&
          [next[@"envelopeState"] isEqual:@"present"] &&
          [next[@"envelopeSHA256"] isKindOfClass:[NSString class]];
    }
    return [next[@"phase"] isEqual:@"committed"] &&
        [next[@"legacyState"] isEqual:@"absent"] &&
        [next[@"envelopeState"] isEqual:@"absent"] &&
        [next[@"envelopeSHA256"] isEqual:[NSNull null]];
  }
  if ([existing isEqualToString:desired]) return true;
  NSDictionary *prior = HRAReconciliationMarkerObject(existing);
  if (prior == nil) return false;
  if (prepareAction) {
    return [prior[@"phase"] isEqual:@"committed"] &&
        [prior[@"legacyState"] isEqual:@"absent"] &&
        [prior[@"envelopeState"] isEqual:@"absent"] &&
        [prior[@"envelopeSHA256"] isEqual:[NSNull null]] &&
        [next[@"legacyState"] isEqual:@"absent"] &&
        [next[@"envelopeState"] isEqual:@"present"] &&
        [next[@"envelopeSHA256"] isKindOfClass:[NSString class]];
  }
  if (![next[@"phase"] isEqual:@"committed"]) return false;
  if ([prior[@"phase"] isEqual:@"prepared"]) {
    bool finalize =
        [prior[@"legacyState"] isEqual:next[@"legacyState"]] &&
        [prior[@"envelopeState"] isEqual:next[@"envelopeState"]] &&
        [prior[@"envelopeSHA256"] isEqual:next[@"envelopeSHA256"]];
    bool rollbackNative =
        [prior[@"legacyState"] isEqual:@"absent"] &&
        [next[@"legacyState"] isEqual:@"absent"] &&
        [next[@"envelopeState"] isEqual:@"absent"] &&
        [next[@"envelopeSHA256"] isEqual:[NSNull null]];
    return finalize || rollbackNative;
  }
  return false;
}

static NSString *_Nullable HRASHA256Hex(NSString *value) {
  uint8_t encoded[256];
  uint8_t digest[CC_SHA256_DIGEST_LENGTH];
  char hex[CC_SHA256_DIGEST_LENGTH * 2 + 1];
  memset(encoded, 0, sizeof(encoded));
  memset(digest, 0, sizeof(digest));
  memset(hex, 0, sizeof(hex));
  NSUInteger encodedLength = 0;
  if (![value getBytes:encoded
             maxLength:sizeof(encoded)
            usedLength:&encodedLength
              encoding:NSUTF8StringEncoding
               options:0
                 range:NSMakeRange(0, value.length)
        remainingRange:NULL] || encodedLength == 0 ||
      encodedLength > UINT32_MAX ||
      CC_SHA256(encoded, (CC_LONG)encodedLength, digest) == NULL) {
    HRASecureZero(encoded, sizeof(encoded));
    HRASecureZero(digest, sizeof(digest));
    HRASecureZero(hex, sizeof(hex));
    return nil;
  }
  static const char alphabet[] = "0123456789abcdef";
  for (size_t index = 0; index < sizeof(digest); index += 1) {
    hex[index * 2] = alphabet[digest[index] >> 4];
    hex[index * 2 + 1] = alphabet[digest[index] & 0x0f];
  }
  NSString *result = [[NSString alloc]
      initWithBytes:hex
             length:sizeof(digest) * 2
           encoding:NSASCIIStringEncoding];
  HRASecureZero(encoded, sizeof(encoded));
  HRASecureZero(digest, sizeof(digest));
  HRASecureZero(hex, sizeof(hex));
  return result;
}

static bool HRACommittedMarkerMatchesInstallEnvelope(NSString *marker) {
  NSDictionary *object = HRAReconciliationMarkerObject(marker);
  if (object == nil || ![object[@"phase"] isEqual:@"committed"])
    return false;
  NSString *envelope = nil;
  HRAKeychainReadState state = HRAReadInstallEnvelope(&envelope);
  if ([object[@"envelopeState"] isEqual:@"absent"]) {
    return state == HRAKeychainReadAbsent &&
        [object[@"envelopeSHA256"] isEqual:[NSNull null]];
  }
  if (state != HRAKeychainReadPresent || envelope == nil) return false;
  NSString *digest = HRASHA256Hex(envelope);
  return digest != nil && [digest isEqual:object[@"envelopeSHA256"]];
}

static bool HRAWriteReconciliationMarker(
    NSString *value,
    bool prepareAction,
    NSString *_Nullable *_Nonnull outAuthoritative) {
  *outAuthoritative = nil;
  NSString *desired = HRACanonicalReconciliationMarker(value);
  if (desired == nil || !HRAAuthorizedParentRemainsLive()) return false;
  NSString *existing = nil;
  HRAKeychainReadState state = HRAReadReconciliationMarker(&existing);
  if (state == HRAKeychainReadFailure ||
      !HRAReconciliationTransitionIsAllowed(
          state == HRAKeychainReadPresent ? existing : nil,
          desired,
          prepareAction)) {
    return false;
  }
  if (!prepareAction && !HRACommittedMarkerMatchesInstallEnvelope(desired))
    return false;
  if (state == HRAKeychainReadAbsent) {
    NSMutableDictionary *item =
        [HRAReconciliationKeychainQuery() mutableCopy];
    item[(__bridge id)kSecValueData] =
        [desired dataUsingEncoding:NSUTF8StringEncoding];
    if (SecItemAdd((__bridge CFDictionaryRef)item, NULL) != errSecSuccess)
      return false;
  } else if (![existing isEqualToString:desired]) {
    NSDictionary *attributes = @{
      (__bridge id)kSecValueData:
          [desired dataUsingEncoding:NSUTF8StringEncoding],
    };
    if (SecItemUpdate(
            (__bridge CFDictionaryRef)HRAReconciliationKeychainQuery(),
            (__bridge CFDictionaryRef)attributes) != errSecSuccess) {
      return false;
    }
  }
  NSString *readback = nil;
  if (HRAReadReconciliationMarker(&readback) !=
          HRAKeychainReadPresent ||
      ![readback isEqualToString:desired]) {
    return false;
  }
  *outAuthoritative = readback;
  return true;
}

static bool HRADeleteReconciliationMarker(bool *outDeleted) {
  if (!HRAAuthorizedParentRemainsLive()) return false;
  OSStatus status = SecItemDelete(
      (__bridge CFDictionaryRef)HRAReconciliationKeychainQuery());
  if (status != errSecSuccess && status != errSecItemNotFound) return false;
  *outDeleted = status == errSecSuccess;
  if (!HRAAuthorizedParentRemainsLive()) return false;
  NSMutableDictionary *query =
      [HRAReconciliationKeychainQuery() mutableCopy];
  query[(__bridge id)kSecReturnData] = @YES;
  query[(__bridge id)kSecMatchLimit] = (__bridge id)kSecMatchLimitOne;
  CFTypeRef raw = NULL;
  OSStatus readStatus = SecItemCopyMatching(
      (__bridge CFDictionaryRef)query, &raw);
  if (raw != NULL) CFRelease(raw);
  return readStatus == errSecItemNotFound;
}

static bool HRAWriteJSONResponse(NSDictionary *response) {
  if (![NSJSONSerialization isValidJSONObject:response]) return false;
  NSData *data = [NSJSONSerialization dataWithJSONObject:response
                                                  options:0
                                                    error:nil];
  if (data.length == 0 || data.length > HRACustodianMaximumResponseBytes) {
    return false;
  }
  return HRAWriteAll(STDOUT_FILENO, data.bytes, data.length);
}

int hra_keychain_custodian_main(void) {
  @autoreleasepool {
    pid_t parentProcess = getppid();
    if (!HRAParentIdentityIsAuthorized(parentProcess)) return 1;
    HRAAuthorizedParentProcess = parentProcess;
    NSMutableData *input = HRAReadBoundedStandardInput();
    id parsed = input == nil
        ? nil
        : [NSJSONSerialization JSONObjectWithData:input options:0 error:nil];
    if (input.length > 0) HRASecureZero(input.mutableBytes, input.length);
    if (![parsed isKindOfClass:[NSDictionary class]]) {
      HRAWriteJSONResponse(@{ @"ok": @NO, @"version": @1 });
      HRAAuthorizedParentProcess = -1;
      return 1;
    }
    NSDictionary *request = parsed;
    if (!HRAJSONIntegerIsExactlyOne(request[@"version"]) ||
        ![request[@"action"] isKindOfClass:[NSString class]]) {
      HRAWriteJSONResponse(@{ @"ok": @NO, @"version": @1 });
      HRAAuthorizedParentProcess = -1;
      return 1;
    }
    NSString *action = request[@"action"];
    if ([action isEqual:@"read"] && request.count == 2) {
      NSString *value = nil;
      HRAKeychainReadState state = HRAReadInstallEnvelope(&value);
      if (state == HRAKeychainReadAbsent) {
        int status = HRAWriteJSONResponse(@{
          @"ok": @YES,
          @"state": @"absent",
          @"version": @1,
        }) ? 0 : 1;
        HRAAuthorizedParentProcess = -1;
        return status;
      }
      if (state == HRAKeychainReadPresent && value != nil) {
        int status = HRAWriteJSONResponse(@{
          @"ok": @YES,
          @"state": @"present",
          @"value": value,
          @"version": @1,
        }) ? 0 : 1;
        HRAAuthorizedParentProcess = -1;
        return status;
      }
    } else if ([action isEqual:@"setIfAbsent"] && request.count == 3) {
      bool created = false;
      NSString *authoritative = nil;
      if (HRASetInstallEnvelopeIfAbsent(
              request[@"value"], &created, &authoritative) &&
          authoritative != nil) {
        int status = HRAWriteJSONResponse(@{
          @"created": @(created),
          @"ok": @YES,
          @"value": authoritative,
          @"version": @1,
        }) ? 0 : 1;
        HRAAuthorizedParentProcess = -1;
        return status;
      }
    } else if ([action isEqual:@"delete"] && request.count == 2) {
      bool deleted = false;
      if (HRADeleteInstallEnvelope(&deleted)) {
        int status = HRAWriteJSONResponse(@{
          @"deleted": @(deleted),
          @"ok": @YES,
          @"version": @1,
        }) ? 0 : 1;
        HRAAuthorizedParentProcess = -1;
        return status;
      }
    } else if ([action isEqual:@"markerRead"] && request.count == 2) {
      NSString *value = nil;
      HRAKeychainReadState state = HRAReadReconciliationMarker(&value);
      if (state == HRAKeychainReadAbsent) {
        int status = HRAWriteJSONResponse(@{
          @"ok": @YES,
          @"state": @"absent",
          @"version": @1,
        }) ? 0 : 1;
        HRAAuthorizedParentProcess = -1;
        return status;
      }
      if (state == HRAKeychainReadPresent && value != nil) {
        int status = HRAWriteJSONResponse(@{
          @"ok": @YES,
          @"state": @"present",
          @"value": value,
          @"version": @1,
        }) ? 0 : 1;
        HRAAuthorizedParentProcess = -1;
        return status;
      }
    } else if (([action isEqual:@"markerPrepare"] ||
                [action isEqual:@"markerCommit"]) && request.count == 3) {
      NSString *authoritative = nil;
      if (HRAWriteReconciliationMarker(
              request[@"value"],
              [action isEqual:@"markerPrepare"],
              &authoritative) && authoritative != nil) {
        int status = HRAWriteJSONResponse(@{
          @"ok": @YES,
          @"value": authoritative,
          @"version": @1,
        }) ? 0 : 1;
        HRAAuthorizedParentProcess = -1;
        return status;
      }
    } else if ([action isEqual:@"markerDelete"] && request.count == 2) {
      bool deleted = false;
      if (HRADeleteReconciliationMarker(&deleted)) {
        int status = HRAWriteJSONResponse(@{
          @"deleted": @(deleted),
          @"ok": @YES,
          @"version": @1,
        }) ? 0 : 1;
        HRAAuthorizedParentProcess = -1;
        return status;
      }
    }
    HRAWriteJSONResponse(@{ @"ok": @NO, @"version": @1 });
    HRAAuthorizedParentProcess = -1;
    return 1;
  }
}

static NSDictionary *_Nullable HRASigningInformationForStaticCode(
    SecStaticCodeRef code) {
  CFDictionaryRef information = NULL;
  if (SecCodeCopySigningInformation(
          code, kSecCSSigningInformation, &information) != errSecSuccess ||
      information == NULL) {
    return nil;
  }
  return CFBridgingRelease(information);
}

static NSData *_Nullable HRACodeDirectoryHash(NSDictionary *information) {
  id value = information[(__bridge NSString *)kSecCodeInfoUnique];
  return [value isKindOfClass:[NSData class]] && [value length] > 0 &&
          [value length] <= 64
      ? value
      : nil;
}

static bool HRAFileMetadataIdentityMatches(
    const struct stat *left,
    const struct stat *right) {
  return left != NULL && right != NULL &&
      left->st_dev == right->st_dev && left->st_ino == right->st_ino &&
      left->st_mode == right->st_mode && left->st_nlink == right->st_nlink &&
      left->st_uid == right->st_uid && left->st_gid == right->st_gid &&
      left->st_size == right->st_size &&
      left->st_mtimespec.tv_sec == right->st_mtimespec.tv_sec &&
      left->st_mtimespec.tv_nsec == right->st_mtimespec.tv_nsec &&
      left->st_ctimespec.tv_sec == right->st_ctimespec.tv_sec &&
      left->st_ctimespec.tv_nsec == right->st_ctimespec.tv_nsec;
}

static bool HRALegacyGatewayFileMetadataIsExact(
    const struct stat *metadata,
    bool allowUnsealedDevelopment) {
  if (metadata == NULL || !S_ISREG(metadata->st_mode) ||
      metadata->st_nlink != 1 || metadata->st_uid != geteuid() ||
      metadata->st_size != HRALegacyGatewayByteLength) {
    return false;
  }
  mode_t permissions = metadata->st_mode & 07777;
  return permissions == 0755 ||
      (allowUnsealedDevelopment && permissions == 0700);
}

static bool HRAPathResolvesToItself(NSString *path) {
  const char *representation = path.fileSystemRepresentation;
  if (representation == NULL || representation[0] != '/') return false;
  char resolved[PATH_MAX];
  memset(resolved, 0, sizeof(resolved));
  if (realpath(representation, resolved) == NULL) return false;
  return strcmp(representation, resolved) == 0;
}

static bool HRAOpenedDescriptorNamesPath(int descriptor, NSString *path) {
  const char *representation = path.fileSystemRepresentation;
  if (descriptor < 0 || representation == NULL) return false;
  char expected[PATH_MAX];
  char actual[PATH_MAX];
  memset(expected, 0, sizeof(expected));
  memset(actual, 0, sizeof(actual));
  if (realpath(representation, expected) == NULL ||
      fcntl(descriptor, F_GETPATH, actual) != 0) {
    return false;
  }
  char canonicalActual[PATH_MAX];
  memset(canonicalActual, 0, sizeof(canonicalActual));
  if (realpath(actual, canonicalActual) == NULL) return false;
  return strcmp(expected, canonicalActual) == 0;
}

static bool HRAHashDescriptorIsExact(
    int descriptor,
    const uint8_t expected[CC_SHA256_DIGEST_LENGTH]) {
  if (descriptor < 0 || expected == NULL || lseek(descriptor, 0, SEEK_SET) != 0)
    return false;
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
  CC_SHA256_CTX context;
  memset(&context, 0, sizeof(context));
  uint8_t buffer[64 * 1024];
  uint8_t digest[CC_SHA256_DIGEST_LENGTH];
  memset(buffer, 0, sizeof(buffer));
  memset(digest, 0, sizeof(digest));
  bool success = CC_SHA256_Init(&context) == 1;
  off_t length = 0;
  while (success) {
    ssize_t count = read(descriptor, buffer, sizeof(buffer));
    if (count > 0) {
      if (length > HRALegacyGatewayByteLength - count ||
          CC_SHA256_Update(&context, buffer, (CC_LONG)count) != 1) {
        success = false;
        break;
      }
      length += count;
      continue;
    }
    if (count == 0) break;
    if (errno == EINTR) continue;
    success = false;
  }
  success = success && length == HRALegacyGatewayByteLength &&
      CC_SHA256_Final(digest, &context) == 1 &&
      memcmp(digest, expected, CC_SHA256_DIGEST_LENGTH) == 0;
  HRASecureZero(buffer, sizeof(buffer));
  HRASecureZero(digest, sizeof(digest));
  HRASecureZero(&context, sizeof(context));
#pragma clang diagnostic pop
  return success;
}

static bool HRALegacyGatewayDescriptorRemainsExact(
    NSString *path,
    int descriptor,
    const struct stat *openedMetadata,
    bool allowUnsealedDevelopment) {
  struct stat pathMetadata;
  struct stat descriptorMetadata;
  struct stat afterHashMetadata;
  memset(&pathMetadata, 0, sizeof(pathMetadata));
  memset(&descriptorMetadata, 0, sizeof(descriptorMetadata));
  memset(&afterHashMetadata, 0, sizeof(afterHashMetadata));
  if (lstat(path.fileSystemRepresentation, &pathMetadata) != 0 ||
      fstat(descriptor, &descriptorMetadata) != 0 ||
      !HRALegacyGatewayFileMetadataIsExact(
          &pathMetadata, allowUnsealedDevelopment) ||
      !HRAFileMetadataIdentityMatches(openedMetadata, &pathMetadata) ||
      !HRAFileMetadataIdentityMatches(openedMetadata, &descriptorMetadata) ||
      !HRAOpenedDescriptorNamesPath(descriptor, path) ||
      !HRAHashDescriptorIsExact(descriptor, HRALegacyGatewaySHA256) ||
      fstat(descriptor, &afterHashMetadata) != 0 ||
      !HRAFileMetadataIdentityMatches(openedMetadata, &afterHashMetadata)) {
    return false;
  }
  return true;
}

static int HRAOpenExactLegacyGateway(
    NSString *path,
    bool allowUnsealedDevelopment,
    struct stat *outMetadata) {
  if (outMetadata == NULL) return -1;
  memset(outMetadata, 0, sizeof(*outMetadata));
  struct stat pathMetadata;
  memset(&pathMetadata, 0, sizeof(pathMetadata));
  if (lstat(path.fileSystemRepresentation, &pathMetadata) != 0 ||
      !HRALegacyGatewayFileMetadataIsExact(
          &pathMetadata, allowUnsealedDevelopment)) {
    return -1;
  }
  int descriptor = open(
      path.fileSystemRepresentation, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (descriptor < 0) return -1;
  struct stat descriptorMetadata;
  memset(&descriptorMetadata, 0, sizeof(descriptorMetadata));
  if (fstat(descriptor, &descriptorMetadata) != 0 ||
      !HRAFileMetadataIdentityMatches(&pathMetadata, &descriptorMetadata) ||
      !HRALegacyGatewayDescriptorRemainsExact(
          path,
          descriptor,
          &descriptorMetadata,
          allowUnsealedDevelopment)) {
    close(descriptor);
    return -1;
  }
  *outMetadata = descriptorMetadata;
  return descriptor;
}

static bool HRACertificateMatchesHashes(
    SecCertificateRef certificate,
    const uint8_t expectedSHA1[CC_SHA1_DIGEST_LENGTH],
    const uint8_t expectedSHA256[CC_SHA256_DIGEST_LENGTH]) {
  if (certificate == NULL || expectedSHA1 == NULL || expectedSHA256 == NULL)
    return false;
  CFDataRef raw = SecCertificateCopyData(certificate);
  if (raw == NULL) return false;
  const uint8_t *bytes = CFDataGetBytePtr(raw);
  CFIndex length = CFDataGetLength(raw);
  uint8_t sha1[CC_SHA1_DIGEST_LENGTH];
  uint8_t sha256[CC_SHA256_DIGEST_LENGTH];
  memset(sha1, 0, sizeof(sha1));
  memset(sha256, 0, sizeof(sha256));
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
  bool matches = bytes != NULL && length > 0 && length <= UINT32_MAX &&
      CC_SHA1(bytes, (CC_LONG)length, sha1) != NULL &&
      CC_SHA256(bytes, (CC_LONG)length, sha256) != NULL &&
      memcmp(sha1, expectedSHA1, sizeof(sha1)) == 0 &&
      memcmp(sha256, expectedSHA256, sizeof(sha256)) == 0;
#pragma clang diagnostic pop
  CFRelease(raw);
  return matches;
}

static bool HRALegacyGatewayCertificateMetadataIsExact(
    NSDictionary *information,
    bool requireAvailableLeaf) {
  id rawCertificates =
      information[(__bridge NSString *)kSecCodeInfoCertificates];
  NSArray *certificates = nil;
  if (rawCertificates != nil) {
    if (![rawCertificates isKindOfClass:[NSArray class]]) return false;
    certificates = rawCertificates;
  } else {
    id rawTrust = information[(__bridge NSString *)kSecCodeInfoTrust];
    if (rawTrust != nil) {
      if (CFGetTypeID((__bridge CFTypeRef)rawTrust) != SecTrustGetTypeID())
        return false;
      CFArrayRef chain = SecTrustCopyCertificateChain(
          (__bridge SecTrustRef)rawTrust);
      certificates = chain == NULL ? nil : CFBridgingRelease(chain);
    }
  }
  if (certificates == nil || certificates.count == 0)
    return !requireAvailableLeaf;
  if (certificates.count != 1 && certificates.count != 2) return false;
  id leaf = certificates[0];
  if (CFGetTypeID((__bridge CFTypeRef)leaf) != SecCertificateGetTypeID() ||
      !HRACertificateMatchesHashes(
          (__bridge SecCertificateRef)leaf,
          HRAPreviewLeafCertificateSHA1,
          HRAPreviewLeafCertificateSHA256)) {
    return false;
  }
  if (certificates.count == 2) {
    id root = certificates[1];
    if (CFGetTypeID((__bridge CFTypeRef)root) != SecCertificateGetTypeID() ||
        !HRACertificateMatchesHashes(
            (__bridge SecCertificateRef)root,
            HRAPreviewRootCertificateSHA1,
            HRAPreviewRootCertificateSHA256)) {
      return false;
    }
  }
  return true;
}

static bool HRACodeDesignatedRequirementIsExact(SecStaticCodeRef code) {
  if (code == NULL) return false;
  SecRequirementRef requirement = NULL;
  if (SecCodeCopyDesignatedRequirement(
          code, kSecCSDefaultFlags, &requirement) != errSecSuccess ||
      requirement == NULL) {
    return false;
  }
  CFStringRef text = NULL;
  OSStatus status = SecRequirementCopyString(
      requirement, kSecCSDefaultFlags, &text);
  CFRelease(requirement);
  if (status != errSecSuccess || text == NULL) return false;
  bool exact = [(__bridge NSString *)text
      isEqualToString:HRALegacyGatewayRequirement];
  CFRelease(text);
  return exact;
}

static bool HRACodeOriginPathIsExact(
    SecStaticCodeRef code,
    NSString *expectedPath) {
  CFURLRef rawPath = NULL;
  if (code == NULL || expectedPath == nil ||
      SecCodeCopyPath(code, kSecCSDefaultFlags, &rawPath) != errSecSuccess ||
      rawPath == NULL) {
    return false;
  }
  NSURL *path = CFBridgingRelease(rawPath);
  return [path.path isEqualToString:expectedPath];
}

static bool HRAOuterBundleIsSealed(void) {
  NSURL *bundleURL = NSBundle.mainBundle.bundleURL;
  if (bundleURL == nil ||
      ![bundleURL.pathExtension.lowercaseString isEqualToString:@"app"]) {
    return false;
  }
  SecStaticCodeRef outer = NULL;
  if (SecStaticCodeCreateWithPath(
          (__bridge CFURLRef)bundleURL, kSecCSDefaultFlags, &outer) !=
          errSecSuccess || outer == NULL) {
    return false;
  }
  OSStatus status = SecStaticCodeCheckValidity(
      outer,
      kSecCSStrictValidate | kSecCSCheckAllArchitectures | kSecCSCheckNestedCode,
      NULL);
  CFRelease(outer);
  return status == errSecSuccess;
}

static NSDictionary *_Nullable HRACopyStaticCustodianIdentity(
    NSString *path,
    bool allowUnsealedDevelopment) {
  NSURL *resources = NSBundle.mainBundle.resourceURL;
  if (!allowUnsealedDevelopment) {
    if (resources == nil || !HRAOuterBundleIsSealed()) {
      return nil;
    } else {
      NSString *expected = [[resources.path
          stringByAppendingPathComponent:
              @"runtime/bin/oprte-keychain-custodian"]
          stringByStandardizingPath];
      if (![path isEqualToString:expected]) return nil;
    }
  }
  struct stat metadata;
  if (lstat(path.fileSystemRepresentation, &metadata) != 0 ||
      !S_ISREG(metadata.st_mode) || S_ISLNK(metadata.st_mode) ||
      metadata.st_nlink != 1 || (metadata.st_mode & 0111) == 0) {
    return nil;
  }
  SecStaticCodeRef code = NULL;
  if (SecStaticCodeCreateWithPath(
          (__bridge CFURLRef)[NSURL fileURLWithPath:path],
          kSecCSDefaultFlags,
          &code) != errSecSuccess || code == NULL) {
    return nil;
  }
  OSStatus status = SecStaticCodeCheckValidity(
      code,
      kSecCSStrictValidate | kSecCSCheckAllArchitectures,
      NULL);
  NSDictionary *information = status == errSecSuccess
      ? HRASigningInformationForStaticCode(code)
      : nil;
  CFRelease(code);
  NSString *identifier = information[(__bridge NSString *)kSecCodeInfoIdentifier];
  NSData *hash = information == nil ? nil : HRACodeDirectoryHash(information);
  if (![identifier isEqualToString:HRAKeychainCustodianIdentifier] ||
      hash == nil) {
    return nil;
  }
  NSString *team = information[(__bridge NSString *)kSecCodeInfoTeamIdentifier];
  return @{
    @"hash": hash,
    @"identifier": identifier,
    @"team": [team isKindOfClass:[NSString class]] ? team : @"",
  };
}

static bool HRADynamicCustodianMatches(
    pid_t processIdentifier,
    NSDictionary *expected) {
  NSDictionary *attributes = @{
    (__bridge NSString *)kSecGuestAttributePid: @(processIdentifier),
  };
  SecCodeRef code = NULL;
  if (SecCodeCopyGuestWithAttributes(
          NULL,
          (__bridge CFDictionaryRef)attributes,
          kSecCSDefaultFlags,
          &code) != errSecSuccess || code == NULL) {
    return false;
  }
  OSStatus status = SecCodeCheckValidity(code, kSecCSStrictValidate, NULL);
  CFDictionaryRef raw = NULL;
  if (status == errSecSuccess) {
    status = SecCodeCopySigningInformation(
        code, kSecCSSigningInformation, &raw);
  }
  CFRelease(code);
  if (status != errSecSuccess || raw == NULL) return false;
  NSDictionary *actual = CFBridgingRelease(raw);
  NSData *hash = HRACodeDirectoryHash(actual);
  NSString *identifier = actual[(__bridge NSString *)kSecCodeInfoIdentifier];
  NSString *team = actual[(__bridge NSString *)kSecCodeInfoTeamIdentifier];
  if (![team isKindOfClass:[NSString class]]) team = @"";
  return hash != nil && [hash isEqual:expected[@"hash"]] &&
      [identifier isEqual:expected[@"identifier"]] &&
      [team isEqual:expected[@"team"]];
}

static bool HRALegacyGatewayIdentityIsExact(
    SecStaticCodeRef code,
    NSDictionary *information,
    NSString *expectedPath,
    bool requireAvailableLeaf) {
  NSString *identifier =
      information[(__bridge NSString *)kSecCodeInfoIdentifier];
  id team = information[(__bridge NSString *)kSecCodeInfoTeamIdentifier];
  id flags = information[(__bridge NSString *)kSecCodeInfoFlags];
  NSData *hash = HRACodeDirectoryHash(information);
  return [identifier isEqualToString:HRALegacyGatewayIdentifier] &&
      team == nil && [flags isKindOfClass:[NSNumber class]] &&
      [(NSNumber *)flags unsignedIntValue] == kSecCodeSignatureRuntime &&
      hash.length == sizeof(HRALegacyGatewayCDHash) &&
      memcmp(hash.bytes,
             HRALegacyGatewayCDHash,
             sizeof(HRALegacyGatewayCDHash)) == 0 &&
      HRACodeDesignatedRequirementIsExact(code) &&
      HRACodeOriginPathIsExact(code, expectedPath) &&
      HRALegacyGatewayCertificateMetadataIsExact(
          information, requireAvailableLeaf);
}

static SecRequirementRef _Nullable HRACreateLegacyGatewayRequirement(void) {
  SecRequirementRef requirement = NULL;
  if (SecRequirementCreateWithString(
          (__bridge CFStringRef)HRALegacyGatewayRequirement,
          kSecCSDefaultFlags,
          &requirement) != errSecSuccess) {
    return NULL;
  }
  return requirement;
}

static bool HRASelfManagedLegacyGatewayIdentityIsExact(
    NSString *path,
    const struct stat *metadata,
    HRAMacOSSelfManagedCodeIdentity *outIdentity) {
  if (path == nil || metadata == NULL || outIdentity == NULL)
    return false;
  const char *canonicalPath = path.fileSystemRepresentation;
  const char *identifier = HRALegacyGatewayIdentifier.UTF8String;
  size_t canonicalPathLength = canonicalPath == NULL
      ? 0
      : strlen(canonicalPath);
  size_t identifierLength = identifier == NULL ? 0 : strlen(identifier);
  if (canonicalPathLength == 0 || canonicalPathLength >= PATH_MAX ||
      identifierLength == 0) {
    return false;
  }
  HRAMacOSSelfManagedCodeExpectation expectation;
  memset(&expectation, 0, sizeof(expectation));
  expectation.canonical_path = canonicalPath;
  expectation.canonical_path_length = canonicalPathLength;
  expectation.identifier = identifier;
  expectation.identifier_length = identifierLength;
  expectation.expected_uid = (uint32_t)metadata->st_uid;
  expectation.expected_permissions =
      (uint32_t)metadata->st_mode & 07777u;
  expectation.expected_code_directory_flags =
      HRA_MACOS_CODE_DIRECTORY_RUNTIME;
  expectation.expected_hash_type =
      HRA_MACOS_CODE_DIRECTORY_HASH_SHA256;
  expectation.expected_page_size_shift = 12;
  memcpy(expectation.leaf_certificate_sha1,
         HRAPreviewLeafCertificateSHA1,
         sizeof(HRAPreviewLeafCertificateSHA1));
  memcpy(expectation.leaf_certificate_sha256,
         HRAPreviewLeafCertificateSHA256,
         sizeof(HRAPreviewLeafCertificateSHA256));
  memcpy(expectation.root_certificate_sha1,
         HRAPreviewRootCertificateSHA1,
         sizeof(HRAPreviewRootCertificateSHA1));
  memcpy(expectation.root_certificate_sha256,
         HRAPreviewRootCertificateSHA256,
         sizeof(HRAPreviewRootCertificateSHA256));
  HRAMacOSSelfManagedCodeIdentity identity;
  memset(&identity, 0, sizeof(identity));
  bool exact = hra_macos_verify_self_managed_code_identity(
      &expectation, &identity) &&
      identity.device == (uint64_t)metadata->st_dev &&
      identity.inode == (uint64_t)metadata->st_ino &&
      identity.byte_length == (uint64_t)metadata->st_size &&
      identity.mode == (uint32_t)metadata->st_mode &&
      identity.link_count == (uint32_t)metadata->st_nlink &&
      identity.uid == (uint32_t)metadata->st_uid &&
      identity.gid == (uint32_t)metadata->st_gid &&
      identity.byte_length == (uint64_t)HRALegacyGatewayByteLength &&
      identity.code_directory_flags ==
          HRA_MACOS_CODE_DIRECTORY_RUNTIME &&
      identity.hash_type == HRA_MACOS_CODE_DIRECTORY_HASH_SHA256 &&
      identity.page_size_shift == 12 &&
      memcmp(identity.cdhash,
             HRALegacyGatewayCDHash,
             sizeof(HRALegacyGatewayCDHash)) == 0;
  if (exact) *outIdentity = identity;
  HRASecureZero(&identity, sizeof(identity));
  return exact;
}

static bool HRASelfManagedLegacyGatewayDynamicIdentityIsExact(
    pid_t processIdentifier,
    NSString *path,
    const HRAMacOSSelfManagedCodeIdentity *expectedIdentity) {
  if (path == nil || expectedIdentity == NULL) return false;
  const char *canonicalPath = path.fileSystemRepresentation;
  const char *identifier = HRALegacyGatewayIdentifier.UTF8String;
  size_t canonicalPathLength = canonicalPath == NULL
      ? 0
      : strlen(canonicalPath);
  size_t identifierLength = identifier == NULL ? 0 : strlen(identifier);
  return canonicalPathLength > 0 && identifierLength > 0 &&
      hra_macos_self_managed_dynamic_code_matches(
          processIdentifier,
          canonicalPath,
          canonicalPathLength,
          identifier,
          identifierLength,
          expectedIdentity->cdhash,
          HRA_MACOS_CODE_DIRECTORY_RUNTIME);
}

static void HRARecordLegacyHarnessCustodyFailure(
    HRALegacyHarnessCustodyFailureSubstage *outFailureSubstage,
    HRALegacyHarnessCustodyFailureSubstage failureSubstage) {
  if (outFailureSubstage != NULL &&
      *outFailureSubstage == HRALegacyHarnessCustodyFailureNone) {
    *outFailureSubstage = failureSubstage;
  }
}

static NSDictionary *_Nullable HRACopyStaticLegacyGatewayIdentity(
    NSString *path,
    bool allowUnsealedDevelopment,
    int *outDescriptor,
    struct stat *outMetadata,
    HRAMacOSSelfManagedCodeIdentity *outSelfManagedIdentity,
    HRALegacyHarnessCustodyFailureSubstage *outFailureSubstage) {
  if (outDescriptor == NULL || outMetadata == NULL ||
      outSelfManagedIdentity == NULL) {
    HRARecordLegacyHarnessCustodyFailure(
        outFailureSubstage,
        HRALegacyHarnessCustodyFailureStaticBundle);
    return nil;
  }
  *outDescriptor = -1;
  memset(outMetadata, 0, sizeof(*outMetadata));
  memset(outSelfManagedIdentity, 0, sizeof(*outSelfManagedIdentity));
  NSURL *resources = NSBundle.mainBundle.resourceURL;
  if (!allowUnsealedDevelopment) {
    if (resources == nil || !HRAOuterBundleIsSealed()) {
      HRARecordLegacyHarnessCustodyFailure(
          outFailureSubstage,
          HRALegacyHarnessCustodyFailureStaticBundle);
      return nil;
    }
    NSString *expected = [[resources.path
        stringByAppendingPathComponent:HRALegacyGatewayRelativePath]
        stringByStandardizingPath];
    if (![path isEqualToString:expected] || !HRAPathResolvesToItself(path)) {
      HRARecordLegacyHarnessCustodyFailure(
          outFailureSubstage,
          HRALegacyHarnessCustodyFailureStaticBundle);
      return nil;
    }
  }
  int descriptor = HRAOpenExactLegacyGateway(
      path, allowUnsealedDevelopment, outMetadata);
  if (descriptor < 0) {
    HRARecordLegacyHarnessCustodyFailure(
        outFailureSubstage,
        HRALegacyHarnessCustodyFailureStaticBundle);
    return nil;
  }
  SecStaticCodeRef code = NULL;
  if (SecStaticCodeCreateWithPath(
          (__bridge CFURLRef)[NSURL fileURLWithPath:path],
          kSecCSDefaultFlags,
          &code) != errSecSuccess || code == NULL) {
    HRARecordLegacyHarnessCustodyFailure(
        outFailureSubstage,
        HRALegacyHarnessCustodyFailureStaticSecurityMetadata);
    close(descriptor);
    return nil;
  }
  SecRequirementRef requirement = HRACreateLegacyGatewayRequirement();
  if (requirement == NULL) {
    HRARecordLegacyHarnessCustodyFailure(
        outFailureSubstage,
        HRALegacyHarnessCustodyFailureStaticSecurityMetadata);
    CFRelease(code);
    close(descriptor);
    return nil;
  }
  // Preserve the platform validity check where the self-managed Preview root
  // is locally trusted. Exact immutable identity below remains authoritative
  // when a host deliberately has no such trust-store entry.
  OSStatus platformValidity = SecStaticCodeCheckValidity(
      code,
      kSecCSStrictValidate | kSecCSCheckAllArchitectures,
      requirement);
  (void)platformValidity;
  CFRelease(requirement);
  NSDictionary *information = HRASigningInformationForStaticCode(code);
  HRAMacOSSelfManagedCodeIdentity selfManagedIdentity;
  memset(&selfManagedIdentity, 0, sizeof(selfManagedIdentity));
  bool selfManagedExact = HRASelfManagedLegacyGatewayIdentityIsExact(
      path, outMetadata, &selfManagedIdentity);
  if (!selfManagedExact) {
    HRARecordLegacyHarnessCustodyFailure(
        outFailureSubstage,
        HRALegacyHarnessCustodyFailureStaticSelfManaged);
  }
  bool securityMetadataExact = selfManagedExact && information != nil &&
      HRALegacyGatewayIdentityIsExact(
          code, information, path, false);
  if (selfManagedExact && !securityMetadataExact) {
    HRARecordLegacyHarnessCustodyFailure(
        outFailureSubstage,
        HRALegacyHarnessCustodyFailureStaticSecurityMetadata);
  }
  bool descriptorExact = securityMetadataExact &&
      HRALegacyGatewayDescriptorRemainsExact(
          path, descriptor, outMetadata, allowUnsealedDevelopment);
  if (securityMetadataExact && !descriptorExact) {
    HRARecordLegacyHarnessCustodyFailure(
        outFailureSubstage,
        HRALegacyHarnessCustodyFailureStaticBundle);
  }
  bool exact = selfManagedExact && securityMetadataExact && descriptorExact;
  CFRelease(code);
  if (!exact) {
    close(descriptor);
    memset(outMetadata, 0, sizeof(*outMetadata));
    HRASecureZero(&selfManagedIdentity, sizeof(selfManagedIdentity));
    return nil;
  }
  *outDescriptor = descriptor;
  *outSelfManagedIdentity = selfManagedIdentity;
  HRASecureZero(&selfManagedIdentity, sizeof(selfManagedIdentity));
  return information;
}

static bool HRADynamicLegacyGatewayMatches(
    pid_t processIdentifier,
    NSString *expectedPath,
    const HRAMacOSSelfManagedCodeIdentity *expectedSelfManagedIdentity,
    HRALegacyHarnessCustodyFailureSubstage *outFailureSubstage) {
  NSDictionary *attributes = @{
    (__bridge NSString *)kSecGuestAttributePid: @(processIdentifier),
  };
  SecCodeRef code = NULL;
  if (SecCodeCopyGuestWithAttributes(
          NULL,
          (__bridge CFDictionaryRef)attributes,
          kSecCSDefaultFlags,
          &code) != errSecSuccess || code == NULL) {
    HRARecordLegacyHarnessCustodyFailure(
        outFailureSubstage,
        HRALegacyHarnessCustodyFailureDynamicSecurityMetadata);
    return false;
  }
  SecRequirementRef requirement = HRACreateLegacyGatewayRequirement();
  if (requirement == NULL) {
    HRARecordLegacyHarnessCustodyFailure(
        outFailureSubstage,
        HRALegacyHarnessCustodyFailureDynamicSecurityMetadata);
    CFRelease(code);
    return false;
  }
  OSStatus platformValidity = SecCodeCheckValidity(
      code, kSecCSStrictValidate, requirement);
  (void)platformValidity;
  CFRelease(requirement);
  CFDictionaryRef raw = NULL;
  OSStatus status = SecCodeCopySigningInformation(
      code,
      kSecCSSigningInformation | kSecCSDynamicInformation,
      &raw);
  NSDictionary *information = status == errSecSuccess && raw != NULL
      ? CFBridgingRelease(raw)
      : nil;
  id rawDynamicStatus =
      information[(__bridge NSString *)kSecCodeInfoStatus];
  bool dynamicallyValid =
      [rawDynamicStatus isKindOfClass:[NSNumber class]] &&
      ([(NSNumber *)rawDynamicStatus unsignedIntValue] &
       kSecCodeStatusValid) == kSecCodeStatusValid;
  SecStaticCodeRef staticCode = NULL;
  status = SecCodeCopyStaticCode(
      code, kSecCSUseAllArchitectures, &staticCode);
  bool pidHashExact = HRASelfManagedLegacyGatewayDynamicIdentityIsExact(
      processIdentifier, expectedPath, expectedSelfManagedIdentity);
  if (!pidHashExact) {
    HRARecordLegacyHarnessCustodyFailure(
        outFailureSubstage,
        HRALegacyHarnessCustodyFailureDynamicPidHash);
  }
  bool securityMetadataExact = pidHashExact &&
      dynamicallyValid &&
      HRALegacyGatewayIdentityIsExact(
          staticCode, information, expectedPath, false);
  bool exact = status == errSecSuccess && securityMetadataExact;
  if (pidHashExact && !exact) {
    HRARecordLegacyHarnessCustodyFailure(
        outFailureSubstage,
        HRALegacyHarnessCustodyFailureDynamicSecurityMetadata);
  }
  if (staticCode != NULL) CFRelease(staticCode);
  CFRelease(code);
  return status == errSecSuccess && pidHashExact && securityMetadataExact;
}

static uint64_t HRAMonotonicMilliseconds(void) {
  struct timespec now;
  if (clock_gettime(CLOCK_MONOTONIC, &now) != 0) return 0;
  return (uint64_t)now.tv_sec * 1000 + (uint64_t)now.tv_nsec / 1000000;
}

static bool HRADeadlineFromTimeout(
    uint64_t start,
    uint32_t timeoutMilliseconds,
    uint64_t *outDeadline) {
  if (start == 0 || timeoutMilliseconds == 0 || outDeadline == NULL ||
      UINT64_MAX - start < timeoutMilliseconds) {
    return false;
  }
  *outDeadline = start + timeoutMilliseconds;
  return true;
}

static bool HRADeadlineHasTime(uint64_t deadline) {
  uint64_t now = HRAMonotonicMilliseconds();
  return deadline > 0 && now > 0 && now < deadline;
}

static int HRADeadlineRemainingMilliseconds(uint64_t deadline) {
  uint64_t now = HRAMonotonicMilliseconds();
  if (deadline == 0 || now == 0 || now >= deadline) return 0;
  uint64_t remaining = deadline - now;
  return (int)(remaining > INT_MAX ? INT_MAX : remaining);
}

static uint64_t HRACleanupDeadline(uint32_t timeoutMilliseconds) {
  uint64_t now = HRAMonotonicMilliseconds();
  uint64_t deadline = 0;
  return HRADeadlineFromTimeout(now, timeoutMilliseconds, &deadline)
      ? deadline
      : 0;
}

static bool HRAWaitForChildAndReap(
    pid_t processIdentifier,
    uint64_t deadline,
    int *outStatus) {
  if (processIdentifier <= 1 || deadline == 0 ||
      outStatus == NULL) return false;
  while (true) {
    if (!HRADeadlineHasTime(deadline)) return false;
    int status = 0;
    pid_t waited = waitpid(processIdentifier, &status, WNOHANG);
    if (waited == processIdentifier) {
      *outStatus = status;
      return HRADeadlineHasTime(deadline);
    }
    if (waited < 0 && errno != EINTR) return false;
    int remaining = HRADeadlineRemainingMilliseconds(deadline);
    if (remaining <= 0) return false;
    struct timespec pause = {
      .tv_sec = 0,
      .tv_nsec = (long)(remaining < 5 ? remaining : 5) * 1000 * 1000,
    };
    if (nanosleep(&pause, NULL) != 0 && errno != EINTR) return false;
  }
}

static bool HRAReapExitedChild(
    pid_t processIdentifier,
    int *outStatus) {
  if (processIdentifier <= 1 || outStatus == NULL) return false;
  while (true) {
    int status = 0;
    pid_t waited = waitpid(processIdentifier, &status, 0);
    if (waited == processIdentifier) {
      *outStatus = status;
      return true;
    }
    if (waited < 0 && errno == EINTR) continue;
    return false;
  }
}

static bool HRAKillAndReapUnregistered(
    pid_t processIdentifier,
    uint64_t deadline) {
  if (processIdentifier <= 1 || deadline == 0 ||
      (kill(processIdentifier, SIGKILL) != 0 && errno != ESRCH)) {
    return false;
  }
  int status = 0;
  return HRAWaitForChildAndReap(processIdentifier, deadline, &status);
}

static bool HRAWaitForChildExitUnreaped(
    pid_t processIdentifier,
    uint64_t deadline,
    siginfo_t *outExitInformation) {
  if (processIdentifier <= 1 || deadline == 0 ||
      outExitInformation == NULL) return false;
  while (true) {
    if (!HRADeadlineHasTime(deadline)) return false;
    memset(outExitInformation, 0, sizeof(*outExitInformation));
    int waitStatus = waitid(
        P_PID,
        (id_t)processIdentifier,
        outExitInformation,
        WEXITED | WNOWAIT | WNOHANG);
    if (waitStatus == 0 && outExitInformation->si_pid == processIdentifier) {
      return HRADeadlineHasTime(deadline);
    }
    if (waitStatus != 0 && errno != EINTR) return false;
    int remaining = HRADeadlineRemainingMilliseconds(deadline);
    if (remaining <= 0) return false;
    struct timespec pause = {
      .tv_sec = 0,
      .tv_nsec = (long)(remaining < 5 ? remaining : 5) * 1000 * 1000,
    };
    if (nanosleep(&pause, NULL) != 0 && errno != EINTR) return false;
  }
}

static bool HRABeginCustodianOperation(uint64_t *outGeneration) {
  if (outGeneration == NULL) return false;
  os_unfair_lock_lock(&HRACustodianProcessLock);
  bool admitted = HRACustodianGenerationPrepared &&
      !HRACustodianGenerationCancelled &&
      !HRACustodianUntrackedRetirementUnproven &&
      atomic_load(&HRACurrentCustodianProcess) == -1;
  *outGeneration = HRACustodianGeneration;
  os_unfair_lock_unlock(&HRACustodianProcessLock);
  return admitted;
}

static bool HRARegisterAndResumeCustodianProcess(
    pid_t processIdentifier,
    uint64_t generation,
    uint64_t deadline,
    bool *outRegistered) {
  if (processIdentifier <= 1 || outRegistered == NULL) return false;
  *outRegistered = false;
  os_unfair_lock_lock(&HRACustodianProcessLock);
  bool registered = HRACustodianGenerationPrepared &&
      !HRACustodianGenerationCancelled &&
      !HRACustodianUntrackedRetirementUnproven &&
      HRACustodianGeneration == generation &&
      atomic_load(&HRACurrentCustodianProcess) == -1 &&
      HRADeadlineHasTime(deadline);
  if (registered) {
    atomic_store(&HRACurrentCustodianProcess, (int)processIdentifier);
    *outRegistered = true;
    registered = kill(processIdentifier, SIGCONT) == 0;
  }
  os_unfair_lock_unlock(&HRACustodianProcessLock);
  return registered;
}

static void HRAMarkCustodianUntrackedRetirementUnproven(void) {
  os_unfair_lock_lock(&HRACustodianProcessLock);
  HRACustodianUntrackedRetirementUnproven = true;
  if (atomic_load(&HRACurrentCustodianProcess) == -1) {
    atomic_store(
        &HRACurrentCustodianProcess,
        HRACustodianRetirementUnproven);
  }
  os_unfair_lock_unlock(&HRACustodianProcessLock);
}

static bool HRARetireRegisteredCustodianProcess(
    pid_t processIdentifier,
    uint64_t deadline,
    bool terminate,
    int *outStatus) {
  if (processIdentifier <= 1 || deadline == 0 || outStatus == NULL) {
    return false;
  }
  *outStatus = INT_MIN;
  os_unfair_lock_lock(&HRACustodianProcessLock);
  if (atomic_load(&HRACurrentCustodianProcess) != processIdentifier) {
    bool alreadyRetired =
        atomic_load(&HRACurrentCustodianProcess) == -1;
    os_unfair_lock_unlock(&HRACustodianProcessLock);
    return alreadyRetired;
  }
  bool signalled = !terminate ||
      kill(processIdentifier, SIGKILL) == 0 || errno == ESRCH;
  os_unfair_lock_unlock(&HRACustodianProcessLock);
  if (!signalled) return false;

  siginfo_t exitInformation;
  if (!HRAWaitForChildExitUnreaped(
          processIdentifier, deadline, &exitInformation)) {
    return false;
  }
  os_unfair_lock_lock(&HRACustodianProcessLock);
  if (atomic_load(&HRACurrentCustodianProcess) != processIdentifier) {
    os_unfair_lock_unlock(&HRACustodianProcessLock);
    return false;
  }
  // The unreaped child still reserves its PID while this synchronized state
  // transition removes all signal paths to the numeric identifier.
  atomic_store(&HRACurrentCustodianProcess, HRAProcessRetiring);
  os_unfair_lock_unlock(&HRACustodianProcessLock);

  int status = 0;
  // WNOWAIT already proved this exact child exited while its PID remained
  // leased. Reap unconditionally after the nonsignal transition; deadline
  // expiry disqualifies success but must not strand a zombie.
  bool reaped = HRAReapExitedChild(processIdentifier, &status);
  if (reaped) *outStatus = status;
  bool timely = reaped && HRADeadlineHasTime(deadline);
  os_unfair_lock_lock(&HRACustodianProcessLock);
  if (atomic_load(&HRACurrentCustodianProcess) == HRAProcessRetiring) {
    atomic_store(
        &HRACurrentCustodianProcess,
        reaped ? -1 : HRACustodianRetirementUnproven);
  }
  os_unfair_lock_unlock(&HRACustodianProcessLock);
  return timely;
}

static void HRAPoisonUnretiredCustodianProcess(pid_t processIdentifier) {
  os_unfair_lock_lock(&HRACustodianProcessLock);
  int current = atomic_load(&HRACurrentCustodianProcess);
  if (current == processIdentifier || current == HRAProcessRetiring) {
    atomic_store(
        &HRACurrentCustodianProcess,
        HRACustodianRetirementUnproven);
  }
  os_unfair_lock_unlock(&HRACustodianProcessLock);
}

static bool HRABeginLegacyGatewayOperation(uint64_t *outGeneration) {
  if (outGeneration == NULL) return false;
  os_unfair_lock_lock(&HRALegacyGatewayProcessLock);
  bool admitted = HRALegacyGatewayGenerationPrepared &&
      !HRALegacyGatewayGenerationCancelled &&
      !HRALegacyUntrackedRetirementUnproven &&
      atomic_load(&HRACurrentLegacyGatewayProcess) == -1;
  *outGeneration = HRALegacyGatewayGeneration;
  os_unfair_lock_unlock(&HRALegacyGatewayProcessLock);
  return admitted;
}

static bool HRARegisterAndResumeLegacyGatewayProcess(
    pid_t processIdentifier,
    uint64_t generation,
    uint64_t deadline,
    bool *outRegistered) {
  if (processIdentifier <= 1 || outRegistered == NULL) return false;
  *outRegistered = false;
  os_unfair_lock_lock(&HRALegacyGatewayProcessLock);
  bool registered = HRALegacyGatewayGenerationPrepared &&
      !HRALegacyGatewayGenerationCancelled &&
      !HRALegacyUntrackedRetirementUnproven &&
      HRALegacyGatewayGeneration == generation &&
      atomic_load(&HRACurrentLegacyGatewayProcess) == -1 &&
      HRADeadlineHasTime(deadline);
  if (registered) {
    atomic_store(&HRACurrentLegacyGatewayProcess, (int)processIdentifier);
    *outRegistered = true;
    registered = kill(processIdentifier, SIGCONT) == 0;
  }
  os_unfair_lock_unlock(&HRALegacyGatewayProcessLock);
  return registered;
}

static void HRAMarkLegacyUntrackedRetirementUnproven(void) {
  os_unfair_lock_lock(&HRALegacyGatewayProcessLock);
  HRALegacyUntrackedRetirementUnproven = true;
  if (atomic_load(&HRACurrentLegacyGatewayProcess) == -1) {
    atomic_store(
        &HRACurrentLegacyGatewayProcess,
        HRALegacyRetirementUnproven);
  }
  os_unfair_lock_unlock(&HRALegacyGatewayProcessLock);
}

// proc_listpids deliberately includes both allproc and zombproc. A zombie has
// no executable state and cannot create another descendant, so retirement must
// distinguish it from a live process instead of depending on another process
// eventually collecting it. Every listed PID is re-read to close enumeration,
// exit, group-change, and PID-reuse races; any ambiguous state fails closed.
static bool HRALegacyProcessGroupHasNoLiveMembers(
    pid_t groupLeader,
    bool ignoreUnreapedLeader) {
  pid_t members[1024];
  memset(members, 0, sizeof(members));
  int listedBytes = proc_listpids(
      PROC_PGRP_ONLY,
      (uint32_t)groupLeader,
      members,
      (int)sizeof(members));
  if (listedBytes < 0 || listedBytes >= (int)sizeof(members) ||
      listedBytes % (int)sizeof(pid_t) != 0) {
    return false;
  }
  size_t count = (size_t)listedBytes / sizeof(pid_t);
  for (size_t index = 0; index < count; index += 1) {
    pid_t member = members[index];
    if (member <= 0 || (ignoreUnreapedLeader && member == groupLeader)) {
      continue;
    }
    struct proc_bsdinfo information;
    memset(&information, 0, sizeof(information));
    errno = 0;
    int informationBytes = proc_pidinfo(
        member,
        PROC_PIDTBSDINFO,
        0,
        &information,
        (int)sizeof(information));
    if (informationBytes == 0 && errno == ESRCH) continue;
    if (informationBytes != (int)sizeof(information) ||
        information.pbi_pid != (uint32_t)member) {
      return false;
    }
    if (information.pbi_pgid != (uint32_t)groupLeader) continue;
    if (information.pbi_status != SZOMB) return false;
  }
  return true;
}

static bool HRAWaitForExitedLegacyLeaderAndGroupQuiescence(
    pid_t groupLeader,
    uint64_t deadline) {
  if (groupLeader <= 1 || deadline == 0) return false;
  while (true) {
    if (!HRADeadlineHasTime(deadline)) return false;
    siginfo_t exitInformation;
    memset(&exitInformation, 0, sizeof(exitInformation));
    int waitStatus = waitid(
        P_PID,
        (id_t)groupLeader,
        &exitInformation,
        WEXITED | WNOWAIT | WNOHANG);
    if (waitStatus != 0 && errno != EINTR) return false;
    bool leaderExited = waitStatus == 0 &&
        exitInformation.si_pid == groupLeader;
    if (leaderExited && HRALegacyProcessGroupHasNoLiveMembers(
            groupLeader, true)) {
      return HRADeadlineHasTime(deadline);
    }
    int remaining = HRADeadlineRemainingMilliseconds(deadline);
    if (remaining <= 0) return false;
    struct timespec pause = {
      .tv_sec = 0,
      .tv_nsec = (long)(remaining < 5 ? remaining : 5) * 1000 * 1000,
    };
    if (nanosleep(&pause, NULL) != 0 && errno != EINTR) return false;
  }
}

/// Kills the complete group and proves that no member retains executable state
/// while the unreaped leader still reserves its numeric PID/PGID. It then
/// removes every signal path and reaps the leader. The pre-reap proof is the
/// authoritative retirement boundary: after it succeeds, every descendant is
/// inert and no member can create or admit another process. Re-querying the
/// numeric PGID after reap would instead observe an unrelated reuse race.
static bool HRAContainAndReapRegisteredLegacyProcessGroup(
    pid_t groupLeader,
    uint64_t deadline,
    int *outStatus) {
  if (groupLeader <= 1 || deadline == 0 || outStatus == NULL) return false;
  *outStatus = INT_MIN;
  os_unfair_lock_lock(&HRALegacyGatewayProcessLock);
  if (atomic_load(&HRACurrentLegacyGatewayProcess) != groupLeader) {
    bool alreadyRetired =
        atomic_load(&HRACurrentLegacyGatewayProcess) == -1;
    os_unfair_lock_unlock(&HRALegacyGatewayProcessLock);
    return alreadyRetired;
  }
  errno = 0;
  int signalStatus = kill(-groupLeader, SIGKILL);
  int signalError = errno;
  // Darwin reports EPERM when this process group contains only an unreaped
  // zombie leader. EPERM never proves retirement: it only permits the exact
  // leader-exit and no-live-member proof below to decide. A live or ambiguous
  // member remains visible there and fails closed at the deadline.
  bool signalAttemptAdmissible = signalStatus == 0 ||
      signalError == ESRCH || signalError == EPERM;
  os_unfair_lock_unlock(&HRALegacyGatewayProcessLock);
  if (!signalAttemptAdmissible ||
      !HRAWaitForExitedLegacyLeaderAndGroupQuiescence(
          groupLeader, deadline)) {
    return false;
  }
  os_unfair_lock_lock(&HRALegacyGatewayProcessLock);
  if (atomic_load(&HRACurrentLegacyGatewayProcess) != groupLeader) {
    os_unfair_lock_unlock(&HRALegacyGatewayProcessLock);
    return false;
  }
  // The unreaped leader still reserves both PID and PGID. Remove the PGID from
  // every signal path under the cancellation lock before releasing that lease.
  atomic_store(&HRACurrentLegacyGatewayProcess, HRAProcessRetiring);
  os_unfair_lock_unlock(&HRALegacyGatewayProcessLock);

  int status = 0;
  bool reaped = HRAReapExitedChild(groupLeader, &status);
  if (reaped) *outStatus = status;
  bool timely = reaped && HRADeadlineHasTime(deadline);
  os_unfair_lock_lock(&HRALegacyGatewayProcessLock);
  if (atomic_load(&HRACurrentLegacyGatewayProcess) == HRAProcessRetiring) {
    atomic_store(
        &HRACurrentLegacyGatewayProcess,
        reaped ? -1 : HRALegacyRetirementUnproven);
  }
  os_unfair_lock_unlock(&HRALegacyGatewayProcessLock);
  return timely;
}

static void HRAPoisonUnretiredLegacyProcess(pid_t processIdentifier) {
  os_unfair_lock_lock(&HRALegacyGatewayProcessLock);
  int current = atomic_load(&HRACurrentLegacyGatewayProcess);
  if (current == processIdentifier || current == HRAProcessRetiring) {
    atomic_store(
        &HRACurrentLegacyGatewayProcess,
        HRALegacyRetirementUnproven);
  }
  os_unfair_lock_unlock(&HRALegacyGatewayProcessLock);
}

bool hra_macos_run_attested_keychain_custodian(
    const char *path,
    size_t path_length,
    const uint8_t *request,
    size_t request_length,
    uint8_t *response,
    size_t response_capacity,
    size_t *out_response_length,
    uint32_t timeout_milliseconds,
    bool allow_unsealed_development) {
  @autoreleasepool {
    if (path == NULL || path_length == 0 || path_length > 4096 ||
        memchr(path, '\0', path_length) != NULL || request == NULL ||
        request_length == 0 ||
        request_length > HRACustodianMaximumRequestBytes ||
        response == NULL || response_capacity == 0 ||
        response_capacity > HRACustodianMaximumResponseBytes ||
        out_response_length == NULL || timeout_milliseconds == 0 ||
        timeout_milliseconds > 60000) {
      return false;
    }
    *out_response_length = 0;
    uint8_t requestCopy[HRACustodianMaximumRequestBytes];
    memset(requestCopy, 0, sizeof(requestCopy));
    memcpy(requestCopy, request, request_length);
    const uint64_t operationStart = HRAMonotonicMilliseconds();
    uint64_t operationDeadline = 0;
    uint64_t generation = 0;
    if (!HRADeadlineFromTimeout(
            operationStart, timeout_milliseconds, &operationDeadline) ||
        !HRABeginCustodianOperation(&generation)) {
      HRASecureZero(requestCopy, sizeof(requestCopy));
      return false;
    }
    NSString *helperPath = [[NSFileManager defaultManager]
        stringWithFileSystemRepresentation:path length:path_length];
    if (helperPath.length == 0 ||
        ![helperPath isEqualToString:helperPath.stringByStandardizingPath]) {
      HRASecureZero(requestCopy, sizeof(requestCopy));
      return false;
    }
    NSDictionary *identity = HRACopyStaticCustodianIdentity(
        helperPath, allow_unsealed_development);
    const char *spawnPath = HRAExactFileSystemRepresentation(
        helperPath, path, path_length);
    if (identity == nil || spawnPath == NULL ||
        !HRADeadlineHasTime(operationDeadline)) {
      HRASecureZero(requestCopy, sizeof(requestCopy));
      return false;
    }

    int inputPipe[2] = {-1, -1};
    int outputPipe[2] = {-1, -1};
    if (pipe(inputPipe) != 0 || pipe(outputPipe) != 0) {
      if (inputPipe[0] >= 0) close(inputPipe[0]);
      if (inputPipe[1] >= 0) close(inputPipe[1]);
      if (outputPipe[0] >= 0) close(outputPipe[0]);
      if (outputPipe[1] >= 0) close(outputPipe[1]);
      HRASecureZero(requestCopy, sizeof(requestCopy));
      return false;
    }
    if (!HRAConfigurePipeWriterNoSigPipe(inputPipe[1])) {
      close(inputPipe[0]); close(inputPipe[1]);
      close(outputPipe[0]); close(outputPipe[1]);
      HRASecureZero(requestCopy, sizeof(requestCopy));
      return false;
    }
    posix_spawnattr_t attributes = NULL;
    posix_spawn_file_actions_t actions = NULL;
    bool initializedAttributes = posix_spawnattr_init(&attributes) == 0;
    bool initializedActions = initializedAttributes &&
        posix_spawn_file_actions_init(&actions) == 0;
    if (!initializedActions) {
      if (initializedAttributes) posix_spawnattr_destroy(&attributes);
      close(inputPipe[0]); close(inputPipe[1]);
      close(outputPipe[0]); close(outputPipe[1]);
      HRASecureZero(requestCopy, sizeof(requestCopy));
      return false;
    }
    short flags = POSIX_SPAWN_START_SUSPENDED | POSIX_SPAWN_CLOEXEC_DEFAULT;
    bool configured = posix_spawnattr_setflags(&attributes, flags) == 0 &&
        posix_spawn_file_actions_adddup2(&actions, inputPipe[0], STDIN_FILENO) == 0 &&
        posix_spawn_file_actions_adddup2(&actions, outputPipe[1], STDOUT_FILENO) == 0 &&
        posix_spawn_file_actions_addopen(
            &actions, STDERR_FILENO, "/dev/null", O_WRONLY, 0) == 0 &&
        posix_spawn_file_actions_addclose(&actions, inputPipe[1]) == 0 &&
        posix_spawn_file_actions_addclose(&actions, outputPipe[0]) == 0;
    char *argv[] = {(char *)spawnPath, NULL};
    char *emptyEnvironment[] = {NULL};
    pid_t processIdentifier = -1;
    int spawnStatus = configured
        ? posix_spawn(&processIdentifier, spawnPath, &actions, &attributes,
                      argv, emptyEnvironment)
        : EINVAL;
    posix_spawn_file_actions_destroy(&actions);
    posix_spawnattr_destroy(&attributes);
    close(inputPipe[0]);
    close(outputPipe[1]);
    if (spawnStatus != 0 || processIdentifier <= 1) {
      close(inputPipe[1]);
      close(outputPipe[0]);
      HRASecureZero(requestCopy, sizeof(requestCopy));
      return false;
    }
    bool success = false;
    bool registered = false;
    bool spawned = true;
    if (!HRADynamicCustodianMatches(processIdentifier, identity) ||
        !HRADeadlineHasTime(operationDeadline) ||
        !HRARegisterAndResumeCustodianProcess(
            processIdentifier,
            generation,
            operationDeadline,
            &registered)) {
      goto cleanup;
    }
    if (!HRADeadlineHasTime(operationDeadline) ||
        !HRAWriteAll(inputPipe[1], requestCopy, request_length) ||
        !HRADeadlineHasTime(operationDeadline)) goto cleanup;
    close(inputPipe[1]);
    inputPipe[1] = -1;
    int currentFlags = fcntl(outputPipe[0], F_GETFL, 0);
    if (currentFlags < 0 ||
        fcntl(outputPipe[0], F_SETFL, currentFlags | O_NONBLOCK) != 0) {
      goto cleanup;
    }
    size_t responseLength = 0;
    bool reachedEOF = false;
    while (!reachedEOF) {
      int remaining = HRADeadlineRemainingMilliseconds(operationDeadline);
      if (remaining <= 0) goto cleanup;
      struct pollfd descriptor = {
        .fd = outputPipe[0],
        .events = POLLIN | POLLHUP,
        .revents = 0,
      };
      int pollStatus = poll(&descriptor, 1, remaining);
      if (pollStatus < 0 && errno == EINTR) continue;
      if (pollStatus <= 0 || (descriptor.revents & (POLLERR | POLLNVAL)) != 0) {
        goto cleanup;
      }
      while (true) {
        if (responseLength == response_capacity) goto cleanup;
        ssize_t count = read(
            outputPipe[0], response + responseLength,
            response_capacity - responseLength);
        if (count > 0) {
          responseLength += (size_t)count;
          continue;
        }
        if (count == 0) {
          reachedEOF = true;
          break;
        }
        if (errno == EINTR) {
          if (!HRADeadlineHasTime(operationDeadline)) goto cleanup;
          continue;
        }
        if (errno == EAGAIN || errno == EWOULDBLOCK) break;
        goto cleanup;
      }
    }
    int status = 0;
    if (!HRARetireRegisteredCustodianProcess(
            processIdentifier,
            operationDeadline,
            false,
            &status)) goto cleanup;
    registered = false;
    spawned = false;
    processIdentifier = -1;
    if (!WIFEXITED(status) || WEXITSTATUS(status) != 0 ||
        responseLength == 0 || !HRADeadlineHasTime(operationDeadline)) {
      goto cleanup;
    }
    *out_response_length = responseLength;
    success = true;

  cleanup:
    if (inputPipe[1] >= 0) close(inputPipe[1]);
    if (outputPipe[0] >= 0) close(outputPipe[0]);
    if (registered && processIdentifier > 1) {
      int ignoredStatus = INT_MIN;
      uint64_t cleanupDeadline = HRACleanupDeadline(
          HRACustodianReapTimeoutMilliseconds);
      if (!HRARetireRegisteredCustodianProcess(
              processIdentifier,
              cleanupDeadline,
              true,
              &ignoredStatus)) {
        HRAPoisonUnretiredCustodianProcess(processIdentifier);
      }
    } else if (spawned && processIdentifier > 1) {
      uint64_t cleanupDeadline = HRACleanupDeadline(
          HRACustodianReapTimeoutMilliseconds);
      if (!HRAKillAndReapUnregistered(
              processIdentifier, cleanupDeadline)) {
        HRAMarkCustodianUntrackedRetirementUnproven();
      }
    }
    HRASecureZero(requestCopy, sizeof(requestCopy));
    if (!success && response_capacity > 0) {
      HRASecureZero(response, response_capacity);
    }
    return success;
  }
}

void hra_macos_prepare_attested_keychain_custodian_operations(void) {
  os_unfair_lock_lock(&HRACustodianProcessLock);
  bool available = atomic_load(&HRACurrentCustodianProcess) == -1 &&
      !HRACustodianUntrackedRetirementUnproven &&
      HRACustodianGeneration != UINT64_MAX;
  if (available) {
    HRACustodianGeneration += 1;
    HRACustodianGenerationPrepared = true;
    HRACustodianGenerationCancelled = false;
  } else {
    HRACustodianGenerationPrepared = false;
    HRACustodianGenerationCancelled = true;
  }
  os_unfair_lock_unlock(&HRACustodianProcessLock);
}

void hra_macos_cancel_attested_keychain_custodian(void) {
  os_unfair_lock_lock(&HRACustodianProcessLock);
  HRACustodianGenerationCancelled = true;
  int processIdentifier = atomic_load(&HRACurrentCustodianProcess);
  if (processIdentifier > 1) {
    (void)kill((pid_t)processIdentifier, SIGKILL);
  }
  os_unfair_lock_unlock(&HRACustodianProcessLock);
}

bool hra_macos_run_attested_legacy_harness_custody(
    const char *path,
    size_t path_length,
    bool delete_action,
    uint8_t *response,
    size_t response_capacity,
    size_t *out_response_length,
    HRALegacyHarnessCustodyFailureSubstage *out_failure_substage,
    uint32_t timeout_milliseconds,
    bool allow_unsealed_development) {
  @autoreleasepool {
    if (out_failure_substage != NULL) {
      *out_failure_substage = HRALegacyHarnessCustodyFailureNone;
    }
    if (path == NULL || path_length == 0 || path_length > 4096 ||
        memchr(path, '\0', path_length) != NULL || response == NULL ||
        response_capacity == 0 ||
        response_capacity > HRACustodianMaximumResponseBytes ||
        out_response_length == NULL || out_failure_substage == NULL ||
        timeout_milliseconds == 0 ||
        timeout_milliseconds > 60000) {
      HRARecordLegacyHarnessCustodyFailure(
          out_failure_substage,
          HRALegacyHarnessCustodyFailureAdmission);
      return false;
    }
    *out_response_length = 0;
    const uint64_t operationStart = HRAMonotonicMilliseconds();
    uint64_t operationDeadline = 0;
    uint64_t generation = 0;
    if (!HRADeadlineFromTimeout(
            operationStart, timeout_milliseconds, &operationDeadline) ||
        !HRABeginLegacyGatewayOperation(&generation)) {
      HRARecordLegacyHarnessCustodyFailure(
          out_failure_substage,
          HRALegacyHarnessCustodyFailureAdmission);
      return false;
    }
    NSString *gatewayPath = [[NSFileManager defaultManager]
        stringWithFileSystemRepresentation:path length:path_length];
    int gatewayDescriptor = -1;
    struct stat gatewayMetadata;
    memset(&gatewayMetadata, 0, sizeof(gatewayMetadata));
    HRAMacOSSelfManagedCodeIdentity gatewaySelfManagedIdentity;
    memset(&gatewaySelfManagedIdentity, 0, sizeof(gatewaySelfManagedIdentity));
    if (gatewayPath.length == 0 ||
        ![gatewayPath isEqualToString:gatewayPath.stringByStandardizingPath] ||
        HRACopyStaticLegacyGatewayIdentity(
            gatewayPath,
            allow_unsealed_development,
            &gatewayDescriptor,
            &gatewayMetadata,
            &gatewaySelfManagedIdentity,
            out_failure_substage) == nil) {
      HRARecordLegacyHarnessCustodyFailure(
          out_failure_substage,
          HRALegacyHarnessCustodyFailureStaticBundle);
      return false;
    }
    const char *spawnPath = HRAExactFileSystemRepresentation(
        gatewayPath, path, path_length);
    if (spawnPath == NULL || !HRADeadlineHasTime(operationDeadline)) {
      HRARecordLegacyHarnessCustodyFailure(
          out_failure_substage,
          HRALegacyHarnessCustodyFailureSpawn);
      close(gatewayDescriptor);
      return false;
    }

    char temporaryDirectory[] =
        "/private/tmp/oprte-legacy-custody.XXXXXX";
    if (mkdtemp(temporaryDirectory) == NULL ||
        chmod(temporaryDirectory, 0700) != 0) {
      HRARecordLegacyHarnessCustodyFailure(
          out_failure_substage,
          HRALegacyHarnessCustodyFailureSpawn);
      close(gatewayDescriptor);
      return false;
    }
    struct stat temporaryMetadata;
    if (lstat(temporaryDirectory, &temporaryMetadata) != 0 ||
        !S_ISDIR(temporaryMetadata.st_mode) ||
        temporaryMetadata.st_uid != geteuid() ||
        (temporaryMetadata.st_mode & 07777) != 0700) {
      HRARecordLegacyHarnessCustodyFailure(
          out_failure_substage,
          HRALegacyHarnessCustodyFailureSpawn);
      close(gatewayDescriptor);
      (void)rmdir(temporaryDirectory);
      return false;
    }
    char temporaryEnvironment[PATH_MAX + 8];
    int temporaryEnvironmentLength = snprintf(
        temporaryEnvironment,
        sizeof(temporaryEnvironment),
        "TMPDIR=%s",
        temporaryDirectory);
    if (temporaryEnvironmentLength <= 0 ||
        (size_t)temporaryEnvironmentLength >= sizeof(temporaryEnvironment)) {
      HRARecordLegacyHarnessCustodyFailure(
          out_failure_substage,
          HRALegacyHarnessCustodyFailureSpawn);
      close(gatewayDescriptor);
      (void)rmdir(temporaryDirectory);
      return false;
    }

    int outputPipe[2] = {-1, -1};
    if (pipe(outputPipe) != 0) {
      HRARecordLegacyHarnessCustodyFailure(
          out_failure_substage,
          HRALegacyHarnessCustodyFailureSpawn);
      close(gatewayDescriptor);
      (void)rmdir(temporaryDirectory);
      return false;
    }
    posix_spawnattr_t attributes = NULL;
    posix_spawn_file_actions_t actions = NULL;
    bool initializedAttributes = posix_spawnattr_init(&attributes) == 0;
    bool initializedActions = initializedAttributes &&
        posix_spawn_file_actions_init(&actions) == 0;
    if (!initializedActions) {
      HRARecordLegacyHarnessCustodyFailure(
          out_failure_substage,
          HRALegacyHarnessCustodyFailureSpawn);
      if (initializedAttributes) posix_spawnattr_destroy(&attributes);
      close(outputPipe[0]);
      close(outputPipe[1]);
      close(gatewayDescriptor);
      (void)rmdir(temporaryDirectory);
      return false;
    }
    short flags = POSIX_SPAWN_START_SUSPENDED |
        POSIX_SPAWN_CLOEXEC_DEFAULT | POSIX_SPAWN_SETPGROUP;
    bool configured = posix_spawnattr_setflags(&attributes, flags) == 0 &&
        posix_spawnattr_setpgroup(&attributes, 0) == 0 &&
        posix_spawn_file_actions_addchdir_np(
            &actions, temporaryDirectory) == 0 &&
        posix_spawn_file_actions_addopen(
            &actions, STDIN_FILENO, "/dev/null", O_RDONLY, 0) == 0 &&
        posix_spawn_file_actions_adddup2(
            &actions, outputPipe[1], STDOUT_FILENO) == 0 &&
        posix_spawn_file_actions_addopen(
            &actions, STDERR_FILENO, "/dev/null", O_WRONLY, 0) == 0 &&
        posix_spawn_file_actions_addclose(&actions, outputPipe[0]) == 0;
    const char *script = delete_action
        ? HRALegacyHarnessDeleteScript
        : HRALegacyHarnessReadScript;
    char *argv[] = {
      (char *)spawnPath,
      (char *)"--no-env-file",
      (char *)"--no-install",
      (char *)"--no-addons",
      (char *)"--no-orphans",
      (char *)"--config=/dev/null",
      (char *)"--cwd",
      temporaryDirectory,
      (char *)"--eval",
      (char *)script,
      NULL,
    };
    char *environment[] = {
      (char *)"BUN_BE_BUN=1",
      temporaryEnvironment,
      NULL,
    };
    pid_t processIdentifier = -1;
    int spawnStatus = configured
        ? posix_spawn(&processIdentifier,
                      spawnPath,
                      &actions,
                      &attributes,
                      argv,
                      environment)
        : EINVAL;
    posix_spawn_file_actions_destroy(&actions);
    posix_spawnattr_destroy(&attributes);
    close(outputPipe[1]);
    if (spawnStatus != 0 || processIdentifier <= 1) {
      HRARecordLegacyHarnessCustodyFailure(
          out_failure_substage,
          HRALegacyHarnessCustodyFailureSpawn);
      close(outputPipe[0]);
      close(gatewayDescriptor);
      (void)rmdir(temporaryDirectory);
      return false;
    }
    bool success = false;
    bool registered = false;
    bool spawned = true;
    if (!HRALegacyGatewayDescriptorRemainsExact(
            gatewayPath,
            gatewayDescriptor,
            &gatewayMetadata,
            allow_unsealed_development)) {
      HRARecordLegacyHarnessCustodyFailure(
          out_failure_substage,
          HRALegacyHarnessCustodyFailureDescriptorBeforeDynamic);
      goto cleanup;
    }
    if (!HRADynamicLegacyGatewayMatches(
            processIdentifier,
            gatewayPath,
            &gatewaySelfManagedIdentity,
            out_failure_substage)) {
      goto cleanup;
    }
    if (!HRALegacyGatewayDescriptorRemainsExact(
            gatewayPath,
            gatewayDescriptor,
            &gatewayMetadata,
            allow_unsealed_development)) {
      HRARecordLegacyHarnessCustodyFailure(
          out_failure_substage,
          HRALegacyHarnessCustodyFailureDescriptorAfterDynamic);
      goto cleanup;
    }
    if (!HRADeadlineHasTime(operationDeadline) ||
        !HRARegisterAndResumeLegacyGatewayProcess(
            processIdentifier,
            generation,
            operationDeadline,
            &registered)) {
      HRARecordLegacyHarnessCustodyFailure(
          out_failure_substage,
          HRALegacyHarnessCustodyFailureResume);
      goto cleanup;
    }
    int currentFlags = fcntl(outputPipe[0], F_GETFL, 0);
    if (currentFlags < 0 ||
        fcntl(outputPipe[0], F_SETFL, currentFlags | O_NONBLOCK) != 0) {
      HRARecordLegacyHarnessCustodyFailure(
          out_failure_substage,
          HRALegacyHarnessCustodyFailureOutput);
      goto cleanup;
    }
    size_t responseLength = 0;
    bool reachedEOF = false;
    while (!reachedEOF) {
      int remaining = HRADeadlineRemainingMilliseconds(operationDeadline);
      if (remaining <= 0) {
        HRARecordLegacyHarnessCustodyFailure(
            out_failure_substage,
            HRALegacyHarnessCustodyFailureOutput);
        goto cleanup;
      }
      struct pollfd descriptor = {
        .fd = outputPipe[0],
        .events = POLLIN | POLLHUP,
        .revents = 0,
      };
      int pollStatus = poll(&descriptor, 1, remaining);
      if (pollStatus < 0 && errno == EINTR) continue;
      if (pollStatus <= 0 ||
          (descriptor.revents & (POLLERR | POLLNVAL)) != 0) {
        HRARecordLegacyHarnessCustodyFailure(
            out_failure_substage,
            HRALegacyHarnessCustodyFailureOutput);
        goto cleanup;
      }
      while (true) {
        if (responseLength == response_capacity) {
          HRARecordLegacyHarnessCustodyFailure(
              out_failure_substage,
              HRALegacyHarnessCustodyFailureOutput);
          goto cleanup;
        }
        ssize_t count = read(outputPipe[0],
                             response + responseLength,
                             response_capacity - responseLength);
        if (count > 0) {
          responseLength += (size_t)count;
          continue;
        }
        if (count == 0) {
          reachedEOF = true;
          break;
        }
        if (errno == EINTR) {
          if (!HRADeadlineHasTime(operationDeadline)) {
            HRARecordLegacyHarnessCustodyFailure(
                out_failure_substage,
                HRALegacyHarnessCustodyFailureOutput);
            goto cleanup;
          }
          continue;
        }
        if (errno == EAGAIN || errno == EWOULDBLOCK) break;
        HRARecordLegacyHarnessCustodyFailure(
            out_failure_substage,
            HRALegacyHarnessCustodyFailureOutput);
        goto cleanup;
      }
    }
    siginfo_t exitInformation;
    if (!HRAWaitForChildExitUnreaped(
            processIdentifier,
            operationDeadline,
            &exitInformation)) {
      HRARecordLegacyHarnessCustodyFailure(
          out_failure_substage,
          HRALegacyHarnessCustodyFailureExit);
      goto cleanup;
    }
    if (exitInformation.si_code != CLD_EXITED ||
        exitInformation.si_status != 0 || responseLength == 0 ||
        !HRADeadlineHasTime(operationDeadline)) {
      HRARecordLegacyHarnessCustodyFailure(
          out_failure_substage,
          HRALegacyHarnessCustodyFailureExit);
      goto cleanup;
    }
    int status = 0;
    uint64_t retirementDeadline = HRACleanupDeadline(
        HRALegacyGroupQuiescenceTimeoutMilliseconds);
    if (!HRAContainAndReapRegisteredLegacyProcessGroup(
            processIdentifier, retirementDeadline, &status)) {
      HRARecordLegacyHarnessCustodyFailure(
          out_failure_substage,
          HRALegacyHarnessCustodyFailureGroupRetirement);
      goto cleanup;
    }
    registered = false;
    spawned = false;
    processIdentifier = -1;
    if (!WIFEXITED(status) || WEXITSTATUS(status) != 0) {
      HRARecordLegacyHarnessCustodyFailure(
          out_failure_substage,
          HRALegacyHarnessCustodyFailureExit);
      goto cleanup;
    }
    *out_response_length = responseLength;
    success = true;

  cleanup:
    close(gatewayDescriptor);
    close(outputPipe[0]);
    if (registered && processIdentifier > 1) {
      int ignoredStatus = INT_MIN;
      uint64_t cleanupDeadline = HRACleanupDeadline(
          HRALegacyGroupQuiescenceTimeoutMilliseconds);
      if (!HRAContainAndReapRegisteredLegacyProcessGroup(
              processIdentifier, cleanupDeadline, &ignoredStatus)) {
        HRARecordLegacyHarnessCustodyFailure(
            out_failure_substage,
            HRALegacyHarnessCustodyFailureGroupRetirement);
        HRAPoisonUnretiredLegacyProcess(processIdentifier);
      }
    } else if (spawned && processIdentifier > 1) {
      uint64_t cleanupDeadline = HRACleanupDeadline(
          HRALegacyGroupQuiescenceTimeoutMilliseconds);
      if (!HRAKillAndReapUnregistered(
              processIdentifier, cleanupDeadline)) {
        HRARecordLegacyHarnessCustodyFailure(
            out_failure_substage,
            HRALegacyHarnessCustodyFailureGroupRetirement);
        HRAMarkLegacyUntrackedRetirementUnproven();
      }
    }
    if (rmdir(temporaryDirectory) != 0) {
      HRARecordLegacyHarnessCustodyFailure(
          out_failure_substage,
          HRALegacyHarnessCustodyFailureGroupRetirement);
      success = false;
    }
    if (!success && response_capacity > 0) {
      HRASecureZero(response, response_capacity);
    }
    return success;
  }
}

void hra_macos_prepare_attested_legacy_harness_custody_operations(void) {
  os_unfair_lock_lock(&HRALegacyGatewayProcessLock);
  bool available = atomic_load(&HRACurrentLegacyGatewayProcess) == -1 &&
      !HRALegacyUntrackedRetirementUnproven &&
      HRALegacyGatewayGeneration != UINT64_MAX;
  if (available) {
    HRALegacyGatewayGeneration += 1;
    HRALegacyGatewayGenerationPrepared = true;
    HRALegacyGatewayGenerationCancelled = false;
  } else {
    HRALegacyGatewayGenerationPrepared = false;
    HRALegacyGatewayGenerationCancelled = true;
  }
  os_unfair_lock_unlock(&HRALegacyGatewayProcessLock);
}

void hra_macos_cancel_attested_legacy_harness_custody(void) {
  os_unfair_lock_lock(&HRALegacyGatewayProcessLock);
  HRALegacyGatewayGenerationCancelled = true;
  int processIdentifier = atomic_load(&HRACurrentLegacyGatewayProcess);
  if (processIdentifier > 1) {
    (void)kill(-(pid_t)processIdentifier, SIGKILL);
  }
  os_unfair_lock_unlock(&HRALegacyGatewayProcessLock);
}

#if defined(HRA_LEGACY_ATTESTATION_PROBE)
// Darwin-only release probe. It deliberately calls the production static
// verifier and never spawns the gateway or enters any SecItem operation.
int main(int argumentCount, const char *arguments[]) {
  @autoreleasepool {
    if (argumentCount != 2 || arguments == NULL || arguments[1] == NULL)
      return 64;
    NSString *path = [NSString stringWithUTF8String:arguments[1]];
    NSString *requiredSuffix = [@"/Contents/Resources/"
        stringByAppendingString:HRALegacyGatewayRelativePath];
    if (path.length == 0 || !path.isAbsolutePath ||
        ![path hasSuffix:requiredSuffix]) {
      return 65;
    }
    int descriptor = -1;
    struct stat metadata;
    memset(&metadata, 0, sizeof(metadata));
    HRAMacOSSelfManagedCodeIdentity selfManagedIdentity;
    memset(&selfManagedIdentity, 0, sizeof(selfManagedIdentity));
    HRALegacyHarnessCustodyFailureSubstage failureSubstage =
        HRALegacyHarnessCustodyFailureNone;
    NSDictionary *identity = HRACopyStaticLegacyGatewayIdentity(
        path,
        true,
        &descriptor,
        &metadata,
        &selfManagedIdentity,
        &failureSubstage);
    bool exact = identity != nil && descriptor >= 0 &&
        HRALegacyGatewayDescriptorRemainsExact(
            path, descriptor, &metadata, true);
    if (descriptor >= 0) close(descriptor);
    return exact ? 0 : 1;
  }
}
#elif defined(HRA_LEGACY_GROUP_RETIREMENT_PROBE)
static bool HRAReadLegacyGroupProbeReady(
    int descriptor,
    uint64_t deadline) {
  while (true) {
    int remaining = HRADeadlineRemainingMilliseconds(deadline);
    if (remaining <= 0) return false;
    struct pollfd pollDescriptor = {
      .fd = descriptor,
      .events = POLLIN | POLLHUP,
      .revents = 0,
    };
    int pollStatus = poll(&pollDescriptor, 1, remaining);
    if (pollStatus < 0 && errno == EINTR) continue;
    if (pollStatus <= 0 ||
        (pollDescriptor.revents & (POLLERR | POLLNVAL)) != 0) {
      return false;
    }
    uint8_t marker = 0;
    ssize_t count = read(descriptor, &marker, sizeof(marker));
    if (count == (ssize_t)sizeof(marker)) return marker == 0x51;
    if (count < 0 && errno == EINTR) continue;
    return false;
  }
}

static void HRARunLegacyGroupProbeChild(
    int readyDescriptor,
    int controlDescriptor,
    bool zombieDescendant) {
  if (setpgid(0, 0) != 0) _exit(70);
  pid_t descendant = fork();
  if (descendant < 0) _exit(71);
  if (descendant == 0) {
    close(readyDescriptor);
    close(controlDescriptor);
    if (zombieDescendant) _exit(0);
    while (true) pause();
  }
  if (zombieDescendant) {
    siginfo_t exitInformation;
    memset(&exitInformation, 0, sizeof(exitInformation));
    while (waitid(
               P_PID,
               (id_t)descendant,
               &exitInformation,
               WEXITED | WNOWAIT) != 0) {
      if (errno != EINTR) _exit(72);
    }
    if (exitInformation.si_pid != descendant) _exit(73);
  } else if (kill(descendant, 0) != 0) {
    _exit(74);
  }
  const uint8_t readyMarker = 0x51;
  if (!HRAWriteAll(
          readyDescriptor, &readyMarker, sizeof(readyMarker))) {
    _exit(75);
  }
  close(readyDescriptor);
  uint8_t controlMarker = 0;
  ssize_t controlCount;
  do {
    controlCount = read(
        controlDescriptor, &controlMarker, sizeof(controlMarker));
  } while (controlCount < 0 && errno == EINTR);
  close(controlDescriptor);
  if (controlCount != (ssize_t)sizeof(controlMarker) ||
      controlMarker != 0x72) {
    _exit(76);
  }
  if (!zombieDescendant &&
      kill(descendant, SIGKILL) != 0 && errno != ESRCH) {
    _exit(77);
  }
  int descendantStatus = 0;
  while (waitpid(descendant, &descendantStatus, 0) < 0) {
    if (errno != EINTR) _exit(78);
  }
  _exit(0);
}

static void HRAKillLegacyGroupProbe(pid_t groupLeader) {
  if (groupLeader <= 1) return;
  if (getpgid(groupLeader) == groupLeader) {
    (void)kill(-groupLeader, SIGKILL);
  } else {
    (void)kill(groupLeader, SIGKILL);
  }
}

static int HRARunExitedLegacyGroupRetirementProbeFixture(
    bool liveDescendant) {
  int readyPipe[2] = {-1, -1};
  int controlPipe[2] = {-1, -1};
  if (pipe(readyPipe) != 0 || pipe(controlPipe) != 0) {
    if (readyPipe[0] >= 0) close(readyPipe[0]);
    if (readyPipe[1] >= 0) close(readyPipe[1]);
    if (controlPipe[0] >= 0) close(controlPipe[0]);
    if (controlPipe[1] >= 0) close(controlPipe[1]);
    return 20;
  }
  pid_t groupLeader = fork();
  if (groupLeader == 0) {
    close(readyPipe[0]);
    close(controlPipe[1]);
    if (setpgid(0, 0) != 0) _exit(80);
    if (liveDescendant) {
      pid_t descendant = fork();
      if (descendant < 0) _exit(81);
      if (descendant == 0) {
        while (true) pause();
      }
    }
    const uint8_t readyMarker = 0x51;
    if (!HRAWriteAll(
            readyPipe[1], &readyMarker, sizeof(readyMarker))) {
      _exit(82);
    }
    close(readyPipe[1]);
    uint8_t controlMarker = 0;
    ssize_t controlCount;
    do {
      controlCount = read(
          controlPipe[0], &controlMarker, sizeof(controlMarker));
    } while (controlCount < 0 && errno == EINTR);
    close(controlPipe[0]);
    if (controlCount != (ssize_t)sizeof(controlMarker) ||
        controlMarker != 0x72) {
      _exit(83);
    }
    _exit(0);
  }
  close(readyPipe[1]);
  close(controlPipe[0]);
  if (groupLeader <= 1) {
    close(readyPipe[0]);
    close(controlPipe[1]);
    return 20;
  }
  uint64_t readyDeadline = HRACleanupDeadline(5000);
  bool ready = HRAReadLegacyGroupProbeReady(
      readyPipe[0], readyDeadline);
  bool exactGroup = ready && getpgid(groupLeader) == groupLeader;
  const uint8_t controlMarker = 0x72;
  bool released = exactGroup && HRAWriteAll(
      controlPipe[1], &controlMarker, sizeof(controlMarker));
  close(readyPipe[0]);
  close(controlPipe[1]);
  uint64_t exitDeadline = HRACleanupDeadline(5000);
  siginfo_t exitInformation;
  bool exited = released && HRAWaitForChildExitUnreaped(
      groupLeader, exitDeadline, &exitInformation);
  bool initialQuiescence = exited &&
      HRALegacyProcessGroupHasNoLiveMembers(groupLeader, true);
  os_unfair_lock_lock(&HRALegacyGatewayProcessLock);
  bool registered = exited &&
      atomic_load(&HRACurrentLegacyGatewayProcess) == -1;
  if (registered) {
    atomic_store(&HRACurrentLegacyGatewayProcess, (int)groupLeader);
  }
  os_unfair_lock_unlock(&HRALegacyGatewayProcessLock);
  int status = INT_MIN;
  uint64_t containmentDeadline = HRACleanupDeadline(5000);
  bool contained = registered &&
      HRAContainAndReapRegisteredLegacyProcessGroup(
          groupLeader, containmentDeadline, &status);
  if (!contained) {
    HRAKillLegacyGroupProbe(groupLeader);
    uint64_t cleanupDeadline = HRACleanupDeadline(1000);
    int ignoredStatus = 0;
    (void)HRAWaitForChildAndReap(
        groupLeader, cleanupDeadline, &ignoredStatus);
    os_unfair_lock_lock(&HRALegacyGatewayProcessLock);
    int current = atomic_load(&HRACurrentLegacyGatewayProcess);
    if (current == groupLeader || current == HRAProcessRetiring) {
      atomic_store(&HRACurrentLegacyGatewayProcess, -1);
    }
    os_unfair_lock_unlock(&HRALegacyGatewayProcessLock);
  }
  if (!exited || exitInformation.si_code != CLD_EXITED ||
      exitInformation.si_status != 0) return 21;
  if (!exactGroup) return 22;
  if (initialQuiescence != !liveDescendant) return 26;
  if (!registered) return 23;
  if (!contained) return 24;
  if (!WIFEXITED(status) || WEXITSTATUS(status) != 0 ||
      atomic_load(&HRACurrentLegacyGatewayProcess) != -1) return 25;
  return 0;
}

static bool HRARunLegacyGroupRetirementProbeFixture(
    bool zombieDescendant,
    bool expectedInitialQuiescence) {
  int readyPipe[2] = {-1, -1};
  int controlPipe[2] = {-1, -1};
  if (pipe(readyPipe) != 0 || pipe(controlPipe) != 0) {
    if (readyPipe[0] >= 0) close(readyPipe[0]);
    if (readyPipe[1] >= 0) close(readyPipe[1]);
    if (controlPipe[0] >= 0) close(controlPipe[0]);
    if (controlPipe[1] >= 0) close(controlPipe[1]);
    return false;
  }
  pid_t groupLeader = fork();
  if (groupLeader == 0) {
    close(readyPipe[0]);
    close(controlPipe[1]);
    HRARunLegacyGroupProbeChild(
        readyPipe[1], controlPipe[0], zombieDescendant);
  }
  close(readyPipe[1]);
  close(controlPipe[0]);
  if (groupLeader <= 1) {
    close(readyPipe[0]);
    close(controlPipe[1]);
    return false;
  }
  uint64_t deadline = HRACleanupDeadline(5000);
  bool ready = HRAReadLegacyGroupProbeReady(readyPipe[0], deadline);
  bool exactGroup = ready && getpgid(groupLeader) == groupLeader;
  bool initialQuiescence = exactGroup &&
      HRALegacyProcessGroupHasNoLiveMembers(groupLeader, true);
  os_unfair_lock_lock(&HRALegacyGatewayProcessLock);
  bool registered =
      atomic_load(&HRACurrentLegacyGatewayProcess) == -1;
  if (registered) {
    atomic_store(&HRACurrentLegacyGatewayProcess, (int)groupLeader);
  }
  os_unfair_lock_unlock(&HRALegacyGatewayProcessLock);
  int status = INT_MIN;
  uint64_t containmentDeadline = HRACleanupDeadline(5000);
  bool contained = registered &&
      HRAContainAndReapRegisteredLegacyProcessGroup(
          groupLeader, containmentDeadline, &status);
  close(readyPipe[0]);
  close(controlPipe[1]);
  if (!contained) {
    HRAKillLegacyGroupProbe(groupLeader);
    uint64_t cleanupDeadline = HRACleanupDeadline(1000);
    int ignoredStatus = 0;
    (void)HRAWaitForChildAndReap(
        groupLeader, cleanupDeadline, &ignoredStatus);
    os_unfair_lock_lock(&HRALegacyGatewayProcessLock);
    int current = atomic_load(&HRACurrentLegacyGatewayProcess);
    if (current == groupLeader || current == HRAProcessRetiring) {
      atomic_store(&HRACurrentLegacyGatewayProcess, -1);
    }
    os_unfair_lock_unlock(&HRALegacyGatewayProcessLock);
  }
  return ready && exactGroup &&
      initialQuiescence == expectedInitialQuiescence && registered &&
      contained && WIFSIGNALED(status) && WTERMSIG(status) == SIGKILL &&
      atomic_load(&HRACurrentLegacyGatewayProcess) == -1;
}

// Darwin-only process-state probe. It creates synthetic process groups and
// never launches HRA, the legacy gateway, or any Keychain operation.
int main(int argumentCount, const char *arguments[]) {
  (void)arguments;
  if (argumentCount != 1) return 64;
  bool zombieAccepted =
      HRARunLegacyGroupRetirementProbeFixture(true, true);
  bool liveRejected =
      HRARunLegacyGroupRetirementProbeFixture(false, false);
  int exitedLeaderResult =
      HRARunExitedLegacyGroupRetirementProbeFixture(false);
  int exitedLeaderWithDescendantResult =
      HRARunExitedLegacyGroupRetirementProbeFixture(true);
  if (!zombieAccepted) return 10;
  if (!liveRejected) return 11;
  if (exitedLeaderResult != 0) return exitedLeaderResult;
  if (exitedLeaderWithDescendantResult != 0) {
    return exitedLeaderWithDescendantResult + 10;
  }
  return 0;
}
#endif
