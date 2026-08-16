#import "macos_code_identity.h"

#import <Foundation/Foundation.h>
#import <Security/Security.h>
#import <errno.h>
#import <fcntl.h>
#import <pwd.h>
#import <signal.h>
#import <spawn.h>
#import <stdatomic.h>
#import <sys/stat.h>
#import <time.h>
#import <sys/wait.h>
#import <unistd.h>

static NSString *const HRABundleIdentifier = @"kitchen.hraness";
static NSString *const HRARemovalHelperIdentifier =
    @"oprte-data-remover";
static NSString *const HRARemovalHelperCDHashPlistKey =
    // Stable Info.plist storage key read by previously signed releases.
    @"KitchenExpectedDataRemoverCDHashV1";
static const uint32_t HRAMaxRemovalRecoveryWaitMilliseconds =
    5 * 60 * 1000;
static const long HRARemovalRecoveryPollNanoseconds =
    10 * 1000 * 1000;
static _Atomic(bool) HRAAccountProfileCancellationRequested = false;

@interface HRAExpectedHelperIdentity : NSObject
@property(nonatomic, copy, nullable) NSString *teamIdentifier;
@property(nonatomic, copy) NSData *codeDirectoryHash;
@end

@implementation HRAExpectedHelperIdentity
@end

static NSString *_Nullable HRAEffectiveHome(void) {
  long suggested = sysconf(_SC_GETPW_R_SIZE_MAX);
  size_t capacity = suggested > 0 ? (size_t)suggested : 16 * 1024;
  for (NSUInteger attempt = 0; attempt < 4; attempt += 1) {
    char *buffer = calloc(capacity, 1);
    if (buffer == NULL) return nil;
    struct passwd record;
    struct passwd *result = NULL;
    int status = getpwuid_r(
        geteuid(), &record, buffer, capacity, &result);
    if (status == 0 && result != NULL && result->pw_dir != NULL) {
      NSString *home =
          [[NSFileManager defaultManager]
              stringWithFileSystemRepresentation:result->pw_dir
                                           length:strlen(result->pw_dir)];
      free(buffer);
      if (home.length == 0 || ![home hasPrefix:@"/"] ||
          ![home isEqualToString:home.stringByStandardizingPath]) {
        return nil;
      }
      return home;
    }
    free(buffer);
    if (status != ERANGE) return nil;
    capacity *= 2;
  }
  return nil;
}

static NSDictionary *_Nullable HRASigningInformationForStaticCode(
    SecStaticCodeRef code) {
  CFDictionaryRef information = NULL;
  OSStatus status = SecCodeCopySigningInformation(
      code, kSecCSSigningInformation, &information);
  if (status != errSecSuccess || information == NULL) {
    return nil;
  }
  return CFBridgingRelease(information);
}

static NSDictionary *_Nullable HRASigningInformationForSelf(void) {
  SecCodeRef selfCode = NULL;
  if (SecCodeCopySelf(kSecCSDefaultFlags, &selfCode) != errSecSuccess ||
      selfCode == NULL) {
    return nil;
  }
  if (SecCodeCheckValidity(
          selfCode, kSecCSStrictValidate, NULL) != errSecSuccess) {
    CFRelease(selfCode);
    return nil;
  }
  CFDictionaryRef information = NULL;
  OSStatus status = SecCodeCopySigningInformation(
      selfCode, kSecCSSigningInformation, &information);
  CFRelease(selfCode);
  if (status != errSecSuccess || information == NULL) {
    return nil;
  }
  return CFBridgingRelease(information);
}

static SecStaticCodeRef _Nullable HRACopyValidatedOuterBundle(void) {
  NSURL *bundleURL = NSBundle.mainBundle.bundleURL;
  if (bundleURL == nil ||
      ![bundleURL.pathExtension.lowercaseString isEqualToString:@"app"]) {
    return NULL;
  }
  SecStaticCodeRef outerCode = NULL;
  if (SecStaticCodeCreateWithPath(
          (__bridge CFURLRef)bundleURL,
          kSecCSDefaultFlags,
          &outerCode) != errSecSuccess ||
      outerCode == NULL) {
    return NULL;
  }
  const SecCSFlags flags =
      kSecCSStrictValidate |
      kSecCSCheckAllArchitectures |
      kSecCSCheckNestedCode;
  if (SecStaticCodeCheckValidity(outerCode, flags, NULL) != errSecSuccess) {
    CFRelease(outerCode);
    return NULL;
  }
  return outerCode;
}

static SecRequirementRef _Nullable HRACopyHelperRequirement(
    NSString *_Nullable teamIdentifier) {
  NSString *requirementText = nil;
  if (teamIdentifier.length == 0) {
    requirementText = [NSString stringWithFormat:
        @"identifier \"%@\"",
        HRARemovalHelperIdentifier];
  } else {
    if ([teamIdentifier rangeOfCharacterFromSet:
            [[NSCharacterSet alphanumericCharacterSet] invertedSet]]
                .location != NSNotFound) {
      return NULL;
    }
    requirementText =
        [NSString stringWithFormat:
            @"identifier \"%@\" and anchor apple generic and "
             "certificate leaf[subject.OU] = \"%@\"",
            HRARemovalHelperIdentifier,
            teamIdentifier];
  }
  SecRequirementRef requirement = NULL;
  if (SecRequirementCreateWithString(
          (__bridge CFStringRef)requirementText,
          kSecCSDefaultFlags,
          &requirement) != errSecSuccess) {
    return NULL;
  }
  return requirement;
}

static NSData *_Nullable HRACodeDirectoryHash(
    NSDictionary *_Nullable information) {
  id value = information[(__bridge NSString *)kSecCodeInfoUnique];
  if (![value isKindOfClass:[NSData class]]) return nil;
  NSData *hash = value;
  if (hash.length == 0 || hash.length > 64) return nil;
  return hash;
}

static NSData *_Nullable HRADataFromLowercaseHex(
    id _Nullable value) {
  if (![value isKindOfClass:[NSString class]]) return nil;
  NSString *text = value;
  if (text.length < 40 || text.length > 128 ||
      text.length % 2 != 0 ||
      ![text isEqualToString:text.lowercaseString]) {
    return nil;
  }
  NSMutableData *data =
      [NSMutableData dataWithLength:text.length / 2];
  uint8_t *bytes = data.mutableBytes;
  for (NSUInteger index = 0; index < text.length; index += 2) {
    unichar high = [text characterAtIndex:index];
    unichar low = [text characterAtIndex:index + 1];
    int highValue =
        high >= '0' && high <= '9' ? high - '0' :
        high >= 'a' && high <= 'f' ? high - 'a' + 10 : -1;
    int lowValue =
        low >= '0' && low <= '9' ? low - '0' :
        low >= 'a' && low <= 'f' ? low - 'a' + 10 : -1;
    if (highValue < 0 || lowValue < 0) return nil;
    bytes[index / 2] = (uint8_t)((highValue << 4) | lowValue);
  }
  return data;
}

static HRAExpectedHelperIdentity *_Nullable
HRACopyValidatedHelperIdentity(
    const char *path,
    size_t path_length) {
  if (path == NULL || path_length == 0 || path_length > 4096 ||
      memchr(path, '\0', path_length) != NULL) {
    return nil;
  }
  NSString *helperPath =
      [[NSFileManager defaultManager]
          stringWithFileSystemRepresentation:path
                                       length:path_length];
  if (helperPath.length == 0 ||
      ![helperPath isEqualToString:helperPath.stringByStandardizingPath]) {
    return nil;
  }

  NSURL *resources = NSBundle.mainBundle.resourceURL;
  if (resources == nil) return nil;
  NSString *expected =
      [[resources.path
          stringByAppendingPathComponent:
              @"runtime/bin/oprte-data-remover"]
          stringByStandardizingPath];
  if (![helperPath isEqualToString:expected]) {
    return nil;
  }
  struct stat before;
  if (lstat(helperPath.fileSystemRepresentation, &before) != 0 ||
      !S_ISREG(before.st_mode) || S_ISLNK(before.st_mode) ||
      before.st_nlink != 1 || (before.st_mode & 0111) == 0) {
    return nil;
  }

  SecStaticCodeRef outerCode = HRACopyValidatedOuterBundle();
  if (outerCode == NULL) return nil;
  NSDictionary *outerInformation =
      HRASigningInformationForStaticCode(outerCode);
  NSString *outerIdentifier = outerInformation[
      (__bridge NSString *)kSecCodeInfoIdentifier];
  NSString *outerTeam = outerInformation[
      (__bridge NSString *)kSecCodeInfoTeamIdentifier];
  NSData *outerCodeDirectoryHash =
      HRACodeDirectoryHash(outerInformation);
  id outerPlistValue = outerInformation[
      (__bridge NSString *)kSecCodeInfoPList];
  NSDictionary *outerPlist =
      [outerPlistValue isKindOfClass:[NSDictionary class]]
          ? outerPlistValue
          : nil;
  NSData *sealedHelperCodeDirectoryHash =
      HRADataFromLowercaseHex(
          outerPlist[HRARemovalHelperCDHashPlistKey]);
  NSDictionary *selfInformation = HRASigningInformationForSelf();
  NSString *selfIdentifier = selfInformation[
      (__bridge NSString *)kSecCodeInfoIdentifier];
  NSString *selfTeam = selfInformation[
      (__bridge NSString *)kSecCodeInfoTeamIdentifier];
  NSData *selfCodeDirectoryHash =
      HRACodeDirectoryHash(selfInformation);
  id selfPlistValue = selfInformation[
      (__bridge NSString *)kSecCodeInfoPList];
  NSDictionary *selfPlist =
      [selfPlistValue isKindOfClass:[NSDictionary class]]
          ? selfPlistValue
          : nil;
  NSData *selfSealedHelperCodeDirectoryHash =
      HRADataFromLowercaseHex(
          selfPlist[HRARemovalHelperCDHashPlistKey]);
  if (![outerIdentifier isEqualToString:HRABundleIdentifier] ||
      ![selfIdentifier isEqualToString:HRABundleIdentifier] ||
      ((outerTeam.length > 0) != (selfTeam.length > 0)) ||
      (outerTeam.length > 0 && ![selfTeam isEqualToString:outerTeam]) ||
      ![selfCodeDirectoryHash isEqualToData:outerCodeDirectoryHash] ||
      sealedHelperCodeDirectoryHash == nil ||
      ![selfSealedHelperCodeDirectoryHash
          isEqualToData:sealedHelperCodeDirectoryHash]) {
    CFRelease(outerCode);
    return nil;
  }

  SecStaticCodeRef helperCode = NULL;
  NSURL *helperURL = [NSURL fileURLWithPath:helperPath isDirectory:NO];
  if (SecStaticCodeCreateWithPath(
          (__bridge CFURLRef)helperURL,
          kSecCSDefaultFlags,
          &helperCode) != errSecSuccess ||
      helperCode == NULL) {
    CFRelease(outerCode);
    return nil;
  }
  SecRequirementRef helperRequirement =
      HRACopyHelperRequirement(outerTeam);
  if (helperRequirement == NULL) {
    CFRelease(helperCode);
    CFRelease(outerCode);
    return nil;
  }
  SecCSFlags validationFlags =
      kSecCSStrictValidate | kSecCSCheckAllArchitectures;
  OSStatus validation = SecStaticCodeCheckValidity(
      helperCode, validationFlags, helperRequirement);
  NSDictionary *helperInformation =
      validation == errSecSuccess
          ? HRASigningInformationForStaticCode(helperCode)
          : nil;
  CFRelease(helperRequirement);
  CFRelease(helperCode);
  if (validation != errSecSuccess || helperInformation == nil) {
    CFRelease(outerCode);
    return nil;
  }

  NSString *helperIdentifier = helperInformation[
      (__bridge NSString *)kSecCodeInfoIdentifier];
  NSString *helperTeam = helperInformation[
      (__bridge NSString *)kSecCodeInfoTeamIdentifier];
  NSData *helperCodeDirectoryHash =
      HRACodeDirectoryHash(helperInformation);
  if (![helperIdentifier isEqualToString:HRARemovalHelperIdentifier] ||
      ((outerTeam.length > 0) != (helperTeam.length > 0)) ||
      (outerTeam.length > 0 && ![helperTeam isEqualToString:outerTeam]) ||
      helperCodeDirectoryHash == nil ||
      ![helperCodeDirectoryHash
          isEqualToData:sealedHelperCodeDirectoryHash]) {
    CFRelease(outerCode);
    return nil;
  }

  struct stat after;
  BOOL stable =
      lstat(helperPath.fileSystemRepresentation, &after) == 0 &&
      before.st_dev == after.st_dev &&
      before.st_ino == after.st_ino &&
      before.st_size == after.st_size &&
      before.st_mtimespec.tv_sec == after.st_mtimespec.tv_sec &&
      before.st_mtimespec.tv_nsec == after.st_mtimespec.tv_nsec;
  CFRelease(outerCode);
  if (!stable) return nil;

  HRAExpectedHelperIdentity *identity =
      [[HRAExpectedHelperIdentity alloc] init];
  identity.teamIdentifier = outerTeam;
  // This value came from the public, secured kSecCodeInfoPList dictionary.
  // It is sealed by the validated outer app signature and is therefore not a
  // second sample of the mutable helper pathname.
  identity.codeDirectoryHash = sealedHelperCodeDirectoryHash;
  return identity;
}

/// An unbundled developer executable has no outer Info.plist in which to seal
/// a helper CDHash. It still samples a valid static code object and requires
/// the suspended process to match that exact CDHash before resume. Packaged
/// applications can never enter this compatibility path.
static HRAExpectedHelperIdentity *_Nullable
HRACopyValidatedUnbundledDevelopmentHelperIdentity(
    const char *path,
    size_t path_length) {
  if ([NSBundle.mainBundle.bundleURL.pathExtension.lowercaseString
          isEqualToString:@"app"] ||
      path == NULL || path_length == 0 || path_length > 4096 ||
      memchr(path, '\0', path_length) != NULL) {
    return nil;
  }
  NSString *helperPath =
      [[NSFileManager defaultManager]
          stringWithFileSystemRepresentation:path
                                       length:path_length];
  if (helperPath.length == 0 ||
      ![helperPath hasPrefix:@"/"] ||
      ![helperPath isEqualToString:helperPath.stringByStandardizingPath]) {
    return nil;
  }
  struct stat before;
  if (lstat(helperPath.fileSystemRepresentation, &before) != 0 ||
      !S_ISREG(before.st_mode) || S_ISLNK(before.st_mode) ||
      before.st_nlink != 1 || (before.st_mode & 0111) == 0) {
    return nil;
  }
  SecStaticCodeRef helperCode = NULL;
  NSURL *helperURL = [NSURL fileURLWithPath:helperPath isDirectory:NO];
  if (SecStaticCodeCreateWithPath(
          (__bridge CFURLRef)helperURL,
          kSecCSDefaultFlags,
          &helperCode) != errSecSuccess ||
      helperCode == NULL) {
    return nil;
  }
  SecRequirementRef requirement = HRACopyHelperRequirement(nil);
  if (requirement == NULL) {
    CFRelease(helperCode);
    return nil;
  }
  OSStatus validation = SecStaticCodeCheckValidity(
      helperCode,
      kSecCSStrictValidate | kSecCSCheckAllArchitectures,
      requirement);
  NSDictionary *information =
      validation == errSecSuccess
          ? HRASigningInformationForStaticCode(helperCode)
          : nil;
  CFRelease(requirement);
  CFRelease(helperCode);
  if (validation != errSecSuccess || information == nil) return nil;
  NSString *identifier = information[
      (__bridge NSString *)kSecCodeInfoIdentifier];
  NSString *team = information[
      (__bridge NSString *)kSecCodeInfoTeamIdentifier];
  NSData *codeDirectoryHash = HRACodeDirectoryHash(information);
  struct stat after;
  if (![identifier isEqualToString:HRARemovalHelperIdentifier] ||
      codeDirectoryHash == nil ||
      lstat(helperPath.fileSystemRepresentation, &after) != 0 ||
      before.st_dev != after.st_dev ||
      before.st_ino != after.st_ino ||
      before.st_size != after.st_size ||
      before.st_mtimespec.tv_sec != after.st_mtimespec.tv_sec ||
      before.st_mtimespec.tv_nsec != after.st_mtimespec.tv_nsec) {
    return nil;
  }
  HRAExpectedHelperIdentity *identity =
      [[HRAExpectedHelperIdentity alloc] init];
  identity.teamIdentifier = team;
  identity.codeDirectoryHash = codeDirectoryHash;
  return identity;
}

bool hra_macos_verify_embedded_helper(
    const char *path,
    size_t path_length) {
  @autoreleasepool {
    return HRACopyValidatedHelperIdentity(path, path_length) != nil;
  }
}

static bool HRARunningHelperMatchesExpectedIdentity(
    pid_t processIdentifier,
    HRAExpectedHelperIdentity *expectedIdentity) {
  NSDictionary *attributes = @{
    (__bridge NSString *)kSecGuestAttributePid :
        @(processIdentifier)
  };
  SecCodeRef runningCode = NULL;
  if (SecCodeCopyGuestWithAttributes(
          NULL,
          (__bridge CFDictionaryRef)attributes,
          kSecCSDefaultFlags,
          &runningCode) != errSecSuccess ||
      runningCode == NULL) {
    return false;
  }
  SecRequirementRef helperRequirement =
      HRACopyHelperRequirement(expectedIdentity.teamIdentifier);
  if (helperRequirement == NULL) {
    CFRelease(runningCode);
    return false;
  }
  OSStatus validation = SecCodeCheckValidity(
      runningCode, kSecCSStrictValidate, helperRequirement);
  CFRelease(helperRequirement);
  if (validation != errSecSuccess) {
    CFRelease(runningCode);
    return false;
  }
  CFDictionaryRef rawInformation = NULL;
  OSStatus informationStatus = SecCodeCopySigningInformation(
      runningCode, kSecCSSigningInformation, &rawInformation);
  CFRelease(runningCode);
  if (informationStatus != errSecSuccess || rawInformation == NULL) {
    return false;
  }
  NSDictionary *information = CFBridgingRelease(rawInformation);
  NSString *identifier = information[
      (__bridge NSString *)kSecCodeInfoIdentifier];
  NSString *team = information[
      (__bridge NSString *)kSecCodeInfoTeamIdentifier];
  NSData *codeDirectoryHash = HRACodeDirectoryHash(information);
  return [identifier isEqualToString:HRARemovalHelperIdentifier] &&
         ((team.length > 0) ==
          (expectedIdentity.teamIdentifier.length > 0)) &&
         (team.length == 0 ||
          [team isEqualToString:expectedIdentity.teamIdentifier]) &&
         [codeDirectoryHash
             isEqualToData:expectedIdentity.codeDirectoryHash];
}

static bool HRAKillAndReapProcess(pid_t processIdentifier) {
  if (processIdentifier <= 1) return false;

  // Prove that this parent still owns an unreaped child before signaling the
  // numeric PID. If another path already reaped it, a later process may reuse
  // that number and must never receive this helper's cleanup signal.
  int status = 0;
  while (true) {
    pid_t waited = waitpid(processIdentifier, &status, WNOHANG);
    if (waited == processIdentifier) return true;
    if (waited == 0) break;
    if (waited < 0 && errno == EINTR) continue;
    return false;
  }

  int killResult = 0;
  do {
    killResult = kill(processIdentifier, SIGKILL);
  } while (killResult != 0 && errno == EINTR);
  if (killResult != 0 && errno != ESRCH) return false;

  while (true) {
    pid_t waited = waitpid(processIdentifier, &status, 0);
    if (waited == processIdentifier) return true;
    if (waited < 0 && errno == EINTR) continue;
    return false;
  }
}

void hra_macos_kill_and_reap_removal_helper(int process_id) {
  (void)HRAKillAndReapProcess((pid_t)process_id);
}

typedef enum {
  HRARemovalWaitReaped,
  HRARemovalWaitReapedAfterDeadline,
  HRARemovalWaitTimedOut,
  HRARemovalWaitNotOwned,
} HRARemovalWaitResult;

static uint64_t HRAMonotonicMilliseconds(void);

static HRARemovalWaitResult HRAWaitForRemovalChild(
    pid_t processIdentifier,
    uint32_t timeoutMilliseconds,
    int *status) {
  uint64_t started = HRAMonotonicMilliseconds();
  if (started == 0) return HRARemovalWaitTimedOut;

  while (true) {
    pid_t waited = waitpid(processIdentifier, status, WNOHANG);
    if (waited == processIdentifier) {
      uint64_t completed = HRAMonotonicMilliseconds();
      if (completed == 0 || completed < started ||
          completed - started >= timeoutMilliseconds) {
        return HRARemovalWaitReapedAfterDeadline;
      }
      return HRARemovalWaitReaped;
    }
    if (waited < 0 && errno != EINTR) {
      return HRARemovalWaitNotOwned;
    }

    // Check the monotonic deadline after every interrupted wait and sleep.
    // Repeated signals therefore cannot extend startup recovery forever.
    uint64_t now = HRAMonotonicMilliseconds();
    if (now == 0 || now < started ||
        now - started >= timeoutMilliseconds) {
      return HRARemovalWaitTimedOut;
    }

    uint64_t remainingMilliseconds =
        timeoutMilliseconds - (now - started);
    uint64_t pauseNanoseconds = remainingMilliseconds * 1000 * 1000;
    if (pauseNanoseconds > HRARemovalRecoveryPollNanoseconds) {
      pauseNanoseconds = HRARemovalRecoveryPollNanoseconds;
    }
    struct timespec pause = {
      .tv_sec = 0,
      .tv_nsec = (long)pauseNanoseconds,
    };
    if (nanosleep(&pause, NULL) != 0 && errno != EINTR) {
      return HRARemovalWaitTimedOut;
    }
  }
}

bool hra_macos_wait_removal_helper(
    int process_id,
    uint32_t timeout_milliseconds) {
  pid_t processIdentifier = (pid_t)process_id;
  if (processIdentifier <= 1) return false;
  if (timeout_milliseconds == 0 ||
      timeout_milliseconds > HRAMaxRemovalRecoveryWaitMilliseconds) {
    (void)HRAKillAndReapProcess(processIdentifier);
    return false;
  }

  int status = 0;
  HRARemovalWaitResult result = HRAWaitForRemovalChild(
      processIdentifier, timeout_milliseconds, &status);
  if (result == HRARemovalWaitTimedOut) {
    (void)HRAKillAndReapProcess(processIdentifier);
    return false;
  }
  if (result != HRARemovalWaitReaped) {
    return false;
  }
  return WIFEXITED(status) && WEXITSTATUS(status) == 0;
}

static bool HRAConfigureRemovalSpawn(
    posix_spawnattr_t *attributes,
    posix_spawn_file_actions_t *actions,
    int inheritedFileDescriptor) {
  if (posix_spawnattr_init(attributes) != 0) return false;
  bool attributesInitialized = true;
  bool actionsInitialized = false;
  bool configured = false;

  if (posix_spawn_file_actions_init(actions) != 0) goto cleanup;
  actionsInitialized = true;

  sigset_t emptyMask;
  sigset_t defaultSignals;
  if (sigemptyset(&emptyMask) != 0 ||
      sigfillset(&defaultSignals) != 0 ||
      sigdelset(&defaultSignals, SIGKILL) != 0 ||
      sigdelset(&defaultSignals, SIGSTOP) != 0) {
    goto cleanup;
  }
  const short flags =
      POSIX_SPAWN_START_SUSPENDED |
      POSIX_SPAWN_CLOEXEC_DEFAULT |
      POSIX_SPAWN_SETSIGMASK |
      POSIX_SPAWN_SETSIGDEF;
  if (posix_spawnattr_setflags(attributes, flags) != 0 ||
      posix_spawnattr_setsigmask(attributes, &emptyMask) != 0 ||
      posix_spawnattr_setsigdefault(attributes, &defaultSignals) != 0) {
    goto cleanup;
  }

  if (posix_spawn_file_actions_addopen(
          actions, STDIN_FILENO, "/dev/null", O_RDONLY, 0) != 0 ||
      posix_spawn_file_actions_addopen(
          actions, STDOUT_FILENO, "/dev/null", O_WRONLY, 0) != 0 ||
      posix_spawn_file_actions_addopen(
          actions, STDERR_FILENO, "/dev/null", O_WRONLY, 0) != 0) {
    goto cleanup;
  }
  if (inheritedFileDescriptor >= 0 &&
      posix_spawn_file_actions_addinherit_np(
          actions, inheritedFileDescriptor) != 0) {
    goto cleanup;
  }
  configured = true;

cleanup:
  if (!configured) {
    if (actionsInitialized) {
      (void)posix_spawn_file_actions_destroy(actions);
    }
    if (attributesInitialized) {
      (void)posix_spawnattr_destroy(attributes);
    }
  }
  return configured;
}

static bool HRASpawnSuspendedAttestAndResume(
    const char *executablePath,
    char *const arguments[],
    int inheritedFileDescriptor,
    HRAExpectedHelperIdentity *expectedIdentity,
    int *outProcessIdentifier) {
  if (executablePath == NULL || arguments == NULL ||
      expectedIdentity == nil || outProcessIdentifier == NULL ||
      (inheritedFileDescriptor >= 0 &&
       (inheritedFileDescriptor <= STDERR_FILENO ||
        fcntl(inheritedFileDescriptor, F_GETFD) < 0))) {
    return false;
  }
  *outProcessIdentifier = -1;
  posix_spawnattr_t attributes = NULL;
  posix_spawn_file_actions_t actions = NULL;
  if (!HRAConfigureRemovalSpawn(
          &attributes, &actions, inheritedFileDescriptor)) {
    return false;
  }

  pid_t processIdentifier = -1;
  char *const emptyEnvironment[] = {NULL};
  // Darwin exposes neither fexecve nor execveat. START_SUSPENDED lets us
  // attest the vnode that posix_spawn actually loaded before this process
  // resumes it, closing the ordinary path-replacement race. It is not a
  // capability boundary against another active same-UID process, which is
  // permitted to send SIGCONT.
  int spawnStatus = posix_spawn(
      &processIdentifier,
      executablePath,
      &actions,
      &attributes,
      arguments,
      emptyEnvironment);
  (void)posix_spawn_file_actions_destroy(&actions);
  (void)posix_spawnattr_destroy(&attributes);
  if (spawnStatus != 0 || processIdentifier <= 1) {
    if (processIdentifier > 1) {
      HRAKillAndReapProcess(processIdentifier);
    }
    return false;
  }

  if (!HRARunningHelperMatchesExpectedIdentity(
          processIdentifier, expectedIdentity) ||
      kill(processIdentifier, SIGCONT) != 0) {
    HRAKillAndReapProcess(processIdentifier);
    return false;
  }
  *outProcessIdentifier = (int)processIdentifier;
  return true;
}

static char *_Nullable HRACopyNullTerminatedArgument(
    const char *bytes,
    size_t length) {
  if (bytes == NULL || length == 0 || length > 4096 ||
      memchr(bytes, '\0', length) != NULL) {
    return NULL;
  }
  char *copy = calloc(length + 1, 1);
  if (copy == NULL) return NULL;
  memcpy(copy, bytes, length);
  return copy;
}

static bool HRABytesEqual(
    const char *bytes,
    size_t length,
    const char *expected) {
  size_t expectedLength = strlen(expected);
  return bytes != NULL &&
         length == expectedLength &&
         memcmp(bytes, expected, length) == 0;
}

static bool HRAOpaqueIdentifierIsValid(
    const char *bytes,
    size_t length,
    const char *prefix) {
  size_t prefixLength = strlen(prefix);
  if (bytes == NULL || length < prefixLength + 8 || length > 96 ||
      memchr(bytes, '\0', length) != NULL ||
      memcmp(bytes, prefix, prefixLength) != 0 ||
      bytes[prefixLength] != '_') {
    return false;
  }
  for (size_t index = prefixLength + 1; index < length; index += 1) {
    unsigned char byte = (unsigned char)bytes[index];
    if (!((byte >= 'A' && byte <= 'Z') ||
          (byte >= 'a' && byte <= 'z') ||
          (byte >= '0' && byte <= '9') ||
          byte == '_' || byte == '-')) {
      return false;
    }
  }
  return true;
}

bool hra_macos_account_profile_identifier_is_valid(
    const char *bytes,
    size_t length) {
  return HRAOpaqueIdentifierIsValid(bytes, length, "acct");
}

static bool HRACanonicalPositiveDecimalIsValid(
    const char *bytes,
    size_t length) {
  if (bytes == NULL || length == 0 || length > 20 ||
      memchr(bytes, '\0', length) != NULL ||
      (length > 1 && bytes[0] == '0')) {
    return false;
  }
  for (size_t index = 0; index < length; index += 1) {
    if (bytes[index] < '0' || bytes[index] > '9') return false;
  }
  errno = 0;
  char copy[21] = {0};
  memcpy(copy, bytes, length);
  unsigned long long value = strtoull(copy, NULL, 10);
  return errno == 0 && value > 0;
}

static bool HRAPrefixedLowercaseHexIsValid(
    const char *bytes,
    size_t length,
    const char *prefix,
    size_t digits) {
  size_t prefixLength = strlen(prefix);
  if (bytes == NULL || length != prefixLength + digits ||
      memchr(bytes, '\0', length) != NULL ||
      memcmp(bytes, prefix, prefixLength) != 0) {
    return false;
  }
  for (size_t index = prefixLength; index < length; index += 1) {
    char byte = bytes[index];
    if (!((byte >= '0' && byte <= '9') ||
          (byte >= 'a' && byte <= 'f'))) {
      return false;
    }
  }
  return true;
}

static bool HRAControlPlanePathIsValid(
    const char *bytes,
    size_t length) {
  if (bytes == NULL || length == 0 || length > 4096 ||
      memchr(bytes, '\0', length) != NULL) {
    return false;
  }
  NSString *home = HRAEffectiveHome();
  if (home == nil) return false;
  NSString *expected =
      [[[[home stringByAppendingPathComponent:@"Library"]
          stringByAppendingPathComponent:@"Application Support"]
          stringByAppendingPathComponent:@"OPRTE"]
          stringByAppendingPathComponent:@"control-plane.sqlite"]
          .stringByStandardizingPath;
  NSString *provided =
      [[NSFileManager defaultManager]
          stringWithFileSystemRepresentation:bytes
                                       length:length];
  return provided.length > 0 &&
         [provided isEqualToString:provided.stringByStandardizingPath] &&
         [provided isEqualToString:expected];
}

static uint64_t HRAMonotonicMilliseconds(void) {
  struct timespec now = {0};
  if (clock_gettime(CLOCK_MONOTONIC, &now) != 0) return 0;
  return (uint64_t)now.tv_sec * 1000 +
         (uint64_t)now.tv_nsec / 1000000;
}

static bool HRAPollReap(
    pid_t processIdentifier,
    uint32_t timeoutMilliseconds,
    int *status) {
  uint64_t started = HRAMonotonicMilliseconds();
  if (started == 0) return false;
  while (true) {
    if (atomic_load_explicit(
            &HRAAccountProfileCancellationRequested,
            memory_order_acquire)) {
      return false;
    }
    pid_t waited = waitpid(processIdentifier, status, WNOHANG);
    if (waited == processIdentifier) return true;
    if (waited < 0 && errno != EINTR) return false;
    uint64_t now = HRAMonotonicMilliseconds();
    if (now == 0 || now - started >= timeoutMilliseconds) return false;
    struct timespec pause = {
      .tv_sec = 0,
      .tv_nsec = 10 * 1000 * 1000,
    };
    while (nanosleep(&pause, &pause) != 0 && errno == EINTR) {
    }
  }
}

static bool HRAWaitTerminateAndReap(
    pid_t processIdentifier,
    uint32_t timeoutMilliseconds) {
  if (processIdentifier <= 1 || timeoutMilliseconds == 0) return false;
  int status = 0;
  if (HRAPollReap(
          processIdentifier, timeoutMilliseconds, &status)) {
    return WIFEXITED(status) && WEXITSTATUS(status) == 0;
  }
  while (kill(processIdentifier, SIGTERM) != 0 && errno == EINTR) {
  }
  if (!HRAPollReap(processIdentifier, 1000, &status)) {
    HRAKillAndReapProcess(processIdentifier);
  }
  return false;
}

void hra_macos_prepare_attested_account_profile_operations(void) {
  atomic_store_explicit(
      &HRAAccountProfileCancellationRequested,
      false,
      memory_order_release);
}

void hra_macos_cancel_attested_account_profile_operation(void) {
  atomic_store_explicit(
      &HRAAccountProfileCancellationRequested,
      true,
      memory_order_release);
}

bool hra_macos_validate_removal_launch_paths(
    const char *request_path,
    size_t request_path_length,
    const char *signing_key_path,
    size_t signing_key_path_length) {
  @autoreleasepool {
    if (request_path == NULL || signing_key_path == NULL ||
        request_path_length == 0 || signing_key_path_length == 0 ||
        request_path_length > 4096 || signing_key_path_length > 4096 ||
        memchr(request_path, '\0', request_path_length) != NULL ||
        memchr(signing_key_path, '\0', signing_key_path_length) != NULL) {
      return false;
    }
    NSString *home = HRAEffectiveHome();
    if (home == nil) return false;
    NSString *root =
        [[[home stringByAppendingPathComponent:@"Library"]
            stringByAppendingPathComponent:@"Application Support"]
            stringByAppendingPathComponent:@"OPRTE Removal"];
    NSString *request =
        [[NSFileManager defaultManager]
            stringWithFileSystemRepresentation:request_path
                                         length:request_path_length];
    NSString *key =
        [[NSFileManager defaultManager]
            stringWithFileSystemRepresentation:signing_key_path
                                         length:signing_key_path_length];
    if (![request isEqualToString:request.stringByStandardizingPath] ||
        ![key isEqualToString:key.stringByStandardizingPath]) {
      return false;
    }
    NSString *requestsRoot =
        [root stringByAppendingPathComponent:@"requests"];
    return [request.stringByDeletingLastPathComponent
               isEqualToString:requestsRoot] &&
           [key isEqualToString:
                    [root stringByAppendingPathComponent:
                              @"removal-signing.key"]];
  }
}

static bool HRARemovalHelperStateRootIsValid(
    const char *helperStateRoot,
    size_t helperStateRootLength) {
  if (helperStateRoot == NULL || helperStateRootLength == 0 ||
      helperStateRootLength > 4096 ||
      memchr(helperStateRoot, '\0', helperStateRootLength) != NULL) {
    return false;
  }
  NSString *home = HRAEffectiveHome();
  if (home == nil) return false;
  NSString *expected =
      [[[[home stringByAppendingPathComponent:@"Library"]
          stringByAppendingPathComponent:@"Application Support"]
          stringByAppendingPathComponent:@"OPRTE Removal"]
          stringByStandardizingPath];
  NSString *provided =
      [[NSFileManager defaultManager]
          stringWithFileSystemRepresentation:helperStateRoot
                                       length:helperStateRootLength];
  return provided.length > 0 &&
         [provided isEqualToString:provided.stringByStandardizingPath] &&
         [provided isEqualToString:expected];
}

bool hra_macos_run_attested_account_profile_operation(
    const char *path,
    size_t path_length,
    const char *action,
    size_t action_length,
    const char *control_plane_path,
    size_t control_plane_path_length,
    const char *account_profile_id,
    size_t account_profile_id_length,
    const char *state_root_device,
    size_t state_root_device_length,
    const char *state_root_inode,
    size_t state_root_inode_length,
    const char *control_plane_device,
    size_t control_plane_device_length,
    const char *control_plane_inode,
    size_t control_plane_inode_length,
    const char *deletion_nonce,
    size_t deletion_nonce_length,
    uint64_t expected_revision,
    uint32_t timeout_milliseconds) {
  @autoreleasepool {
    bool ensure = HRABytesEqual(action, action_length, "ensure");
    bool delete = HRABytesEqual(action, action_length, "delete");
    if ((!ensure && !delete) ||
        !HRAControlPlanePathIsValid(
            control_plane_path, control_plane_path_length) ||
        !HRAOpaqueIdentifierIsValid(
            account_profile_id, account_profile_id_length, "acct") ||
        !HRACanonicalPositiveDecimalIsValid(
            state_root_device, state_root_device_length) ||
        !HRACanonicalPositiveDecimalIsValid(
            state_root_inode, state_root_inode_length) ||
        !HRACanonicalPositiveDecimalIsValid(
            control_plane_device, control_plane_device_length) ||
        !HRACanonicalPositiveDecimalIsValid(
            control_plane_inode, control_plane_inode_length) ||
        timeout_milliseconds == 0 ||
        (ensure &&
         (deletion_nonce != NULL || deletion_nonce_length != 0 ||
          expected_revision != 0)) ||
        (delete &&
         (!HRAPrefixedLowercaseHexIsValid(
              deletion_nonce,
              deletion_nonce_length,
              "deletion_",
              64) ||
          expected_revision == 0 ||
          expected_revision > 9007199254740991ULL))) {
      return false;
    }

    if (atomic_load_explicit(
            &HRAAccountProfileCancellationRequested,
            memory_order_acquire)) {
      return false;
    }
    HRAExpectedHelperIdentity *expectedIdentity =
        HRACopyValidatedHelperIdentity(path, path_length);
    if (expectedIdentity == nil) {
      expectedIdentity =
          HRACopyValidatedUnbundledDevelopmentHelperIdentity(
              path,
              path_length);
    }
    if (expectedIdentity == nil) return false;
    char *helper = HRACopyNullTerminatedArgument(path, path_length);
    char *controlPlane = HRACopyNullTerminatedArgument(
        control_plane_path, control_plane_path_length);
    char *accountProfile = HRACopyNullTerminatedArgument(
        account_profile_id, account_profile_id_length);
    char *stateDevice = HRACopyNullTerminatedArgument(
        state_root_device, state_root_device_length);
    char *stateInode = HRACopyNullTerminatedArgument(
        state_root_inode, state_root_inode_length);
    char *controlDevice = HRACopyNullTerminatedArgument(
        control_plane_device, control_plane_device_length);
    char *controlInode = HRACopyNullTerminatedArgument(
        control_plane_inode, control_plane_inode_length);
    char *deletionNonce =
        delete
            ? HRACopyNullTerminatedArgument(
                  deletion_nonce, deletion_nonce_length)
            : NULL;
    if (helper == NULL || controlPlane == NULL ||
        accountProfile == NULL || stateDevice == NULL ||
        stateInode == NULL || controlDevice == NULL ||
        controlInode == NULL || (delete && deletionNonce == NULL)) {
      free(helper);
      free(controlPlane);
      free(accountProfile);
      free(stateDevice);
      free(stateInode);
      free(controlDevice);
      free(controlInode);
      free(deletionNonce);
      return false;
    }

    char expectedRevision[32] = {0};
    if (delete) {
      int written = snprintf(
          expectedRevision,
          sizeof(expectedRevision),
          "%llu",
          (unsigned long long)expected_revision);
      if (written <= 0 ||
          (size_t)written >= sizeof(expectedRevision)) {
        free(helper);
        free(controlPlane);
        free(accountProfile);
        free(stateDevice);
        free(stateInode);
        free(controlDevice);
        free(controlInode);
        free(deletionNonce);
        return false;
      }
    }

    char *const ensureArguments[] = {
      helper,
      "ensure-account-profile",
      "--control-plane-path",
      controlPlane,
      "--account-profile-id",
      accountProfile,
      "--state-root-device",
      stateDevice,
      "--state-root-inode",
      stateInode,
      "--control-plane-device",
      controlDevice,
      "--control-plane-inode",
      controlInode,
      NULL,
    };
    char *const deleteArguments[] = {
      helper,
      "delete-account-home",
      "--control-plane-path",
      controlPlane,
      "--account-profile-id",
      accountProfile,
      "--state-root-device",
      stateDevice,
      "--state-root-inode",
      stateInode,
      "--control-plane-device",
      controlDevice,
      "--control-plane-inode",
      controlInode,
      "--deletion-nonce",
      deletionNonce,
      "--expected-revision",
      expectedRevision,
      NULL,
    };
    if (atomic_load_explicit(
            &HRAAccountProfileCancellationRequested,
            memory_order_acquire)) {
      free(helper);
      free(controlPlane);
      free(accountProfile);
      free(stateDevice);
      free(stateInode);
      free(controlDevice);
      free(controlInode);
      free(deletionNonce);
      return false;
    }
    int processIdentifier = -1;
    bool launched = HRASpawnSuspendedAttestAndResume(
        helper,
        ensure ? ensureArguments : deleteArguments,
        -1,
        expectedIdentity,
        &processIdentifier);
    free(helper);
    free(controlPlane);
    free(accountProfile);
    free(stateDevice);
    free(stateInode);
    free(controlDevice);
    free(controlInode);
    free(deletionNonce);
    if (!launched) return false;
    bool succeeded = HRAWaitTerminateAndReap(
        (pid_t)processIdentifier,
        timeout_milliseconds);
    return succeeded;
  }
}

bool hra_macos_spawn_attested_removal_execute(
    const char *path,
    size_t path_length,
    const char *request_path,
    size_t request_path_length,
    const char *signing_key_path,
    size_t signing_key_path_length,
    uint32_t parent_process_id,
    int ready_fd,
    int *out_process_id) {
  @autoreleasepool {
    if (out_process_id == NULL) return false;
    *out_process_id = -1;
    if (parent_process_id <= 1 ||
        !hra_macos_validate_removal_launch_paths(
            request_path,
            request_path_length,
            signing_key_path,
            signing_key_path_length)) {
      return false;
    }
    HRAExpectedHelperIdentity *expectedIdentity =
        HRACopyValidatedHelperIdentity(path, path_length);
    if (expectedIdentity == nil) return false;

    char *helper = HRACopyNullTerminatedArgument(path, path_length);
    char *request = HRACopyNullTerminatedArgument(
        request_path, request_path_length);
    char *signingKey = HRACopyNullTerminatedArgument(
        signing_key_path, signing_key_path_length);
    if (helper == NULL || request == NULL || signingKey == NULL) {
      free(helper);
      free(request);
      free(signingKey);
      return false;
    }
    char parentProcessIdentifier[32];
    char readyFileDescriptor[32];
    int parentLength = snprintf(
        parentProcessIdentifier,
        sizeof(parentProcessIdentifier),
        "%u",
        parent_process_id);
    int readyLength = snprintf(
        readyFileDescriptor,
        sizeof(readyFileDescriptor),
        "%d",
        ready_fd);
    if (parentLength <= 0 ||
        (size_t)parentLength >= sizeof(parentProcessIdentifier) ||
        readyLength <= 0 ||
        (size_t)readyLength >= sizeof(readyFileDescriptor)) {
      free(helper);
      free(request);
      free(signingKey);
      return false;
    }
    char *const arguments[] = {
      helper,
      "execute",
      "--request-path",
      request,
      "--signing-key-path",
      signingKey,
      "--parent-pid",
      parentProcessIdentifier,
      "--ready-fd",
      readyFileDescriptor,
      NULL,
    };
    bool launched = HRASpawnSuspendedAttestAndResume(
        helper,
        arguments,
        ready_fd,
        expectedIdentity,
        out_process_id);
    free(helper);
    free(request);
    free(signingKey);
    return launched;
  }
}

bool hra_macos_spawn_attested_removal_recovery(
    const char *path,
    size_t path_length,
    const char *helper_state_root,
    size_t helper_state_root_length,
    int *out_process_id) {
  @autoreleasepool {
    if (out_process_id == NULL) return false;
    *out_process_id = -1;
    if (!HRARemovalHelperStateRootIsValid(
            helper_state_root, helper_state_root_length)) {
      return false;
    }
    HRAExpectedHelperIdentity *expectedIdentity =
        HRACopyValidatedHelperIdentity(path, path_length);
    if (expectedIdentity == nil) return false;

    char *helper = HRACopyNullTerminatedArgument(path, path_length);
    char *helperStateRoot = HRACopyNullTerminatedArgument(
        helper_state_root, helper_state_root_length);
    if (helper == NULL || helperStateRoot == NULL) {
      free(helper);
      free(helperStateRoot);
      return false;
    }
    char *const arguments[] = {
      helper,
      "recover-staged",
      "--helper-state-root",
      helperStateRoot,
      NULL,
    };
    bool launched = HRASpawnSuspendedAttestAndResume(
        helper,
        arguments,
        -1,
        expectedIdentity,
        out_process_id);
    free(helper);
    free(helperStateRoot);
    return launched;
  }
}
