#import "macos_updater.h"

#import <Cocoa/Cocoa.h>
#import <ServiceManagement/ServiceManagement.h>
#import <errno.h>
#import <fcntl.h>
#import <pwd.h>
#import <stdint.h>
#import <sys/stat.h>
#import <unistd.h>

// The app loads the checksum-pinned embedded Sparkle framework at runtime.
// Keeping this shim header-only with respect to Sparkle lets portable and
// unsigned development builds compile without a network-fetched SDK.
@interface HRASparkleController : NSObject
@property(nonatomic, readonly) id updater;
- (instancetype)initWithStartingUpdater:(BOOL)startingUpdater
                        updaterDelegate:(id)updaterDelegate
                     userDriverDelegate:(id)userDriverDelegate;
- (void)checkForUpdates:(id)sender;
@end

@interface HRASparkleUpdater : NSObject
@property(nonatomic, readonly) BOOL sessionInProgress;
- (BOOL)startUpdater:(NSError **)error;
@end

@interface HRASparkleAppcastItem : NSObject
@property(nonatomic, copy, readonly) NSString *versionString;
@property(nonatomic, copy, readonly) NSString *displayVersionString;
@end

@interface HRASparkleUserUpdateState : NSObject
@property(nonatomic, readonly) NSInteger stage;
@end

typedef NS_ENUM(NSInteger, HRASparkleUserUpdateChoice) {
  HRASparkleUserUpdateChoiceSkip = 0,
  HRASparkleUserUpdateChoiceInstall = 1,
  HRASparkleUserUpdateChoiceDismiss = 2,
};

typedef NS_ENUM(NSInteger, HRASparkleUserUpdateStage) {
  HRASparkleUserUpdateStageNotDownloaded = 0,
  HRASparkleUserUpdateStageDownloaded = 1,
  HRASparkleUserUpdateStageInstalling = 2,
};

static NSString *const HRAUpdateHazardFileName =
    @".Hraness Kitchen.update-hazard-v1.json";
static NSString *const HRAUpdateHazardTemporaryFileName =
    @".Hraness Kitchen.update-hazard-v1.json.tmp";
static NSString *const HRAUpdateHazardStateFound = @"found";
static NSString *const HRAUpdateHazardStateDownloading = @"downloading";
static NSString *const HRAUpdateHazardStateDownloaded = @"downloaded";
static NSString *const HRAUpdateHazardStateExtracting = @"extracting";
static NSString *const HRAUpdateHazardStateInstalling = @"installing";
static NSString *const HRAUpdateHazardStateInstallOnQuit =
    @"install-on-quit";
static NSString *const HRAUpdateHazardStateCancelled = @"cancelled";
static NSString *const HRAPreviewUpdaterCanaryRequestFileName =
    @".OPRTE.preview-updater-canary-v1.request.json";
static NSString *const HRAPreviewUpdaterCanaryEvidenceFileName =
    @".OPRTE.preview-updater-canary-v1.evidence.json";
static NSString *const HRAPreviewUpdaterCanaryEvidenceTemporaryFileName =
    @".OPRTE.preview-updater-canary-v1.evidence.json.tmp";

static HRAMacosUpdateHazardState HRAUpdateHazardStateValue(
    NSString *_Nullable state) {
  if ([state isEqualToString:HRAUpdateHazardStateFound]) {
    return HRAMacosUpdateHazardStateFound;
  }
  if ([state isEqualToString:HRAUpdateHazardStateDownloading]) {
    return HRAMacosUpdateHazardStateDownloading;
  }
  if ([state isEqualToString:HRAUpdateHazardStateDownloaded]) {
    return HRAMacosUpdateHazardStateDownloaded;
  }
  if ([state isEqualToString:HRAUpdateHazardStateExtracting]) {
    return HRAMacosUpdateHazardStateExtracting;
  }
  if ([state isEqualToString:HRAUpdateHazardStateInstalling]) {
    return HRAMacosUpdateHazardStateInstalling;
  }
  if ([state isEqualToString:HRAUpdateHazardStateInstallOnQuit]) {
    return HRAMacosUpdateHazardStateInstallOnQuit;
  }
  if ([state isEqualToString:HRAUpdateHazardStateCancelled]) {
    return HRAMacosUpdateHazardStateCancelled;
  }
  return HRAMacosUpdateHazardStateUnknown;
}

bool hra_macos_update_hazard_may_clear_without_artifact(
    HRAMacosUpdateHazardState state,
    bool cancellation_pending) {
  return cancellation_pending ||
         state == HRAMacosUpdateHazardStateFound ||
         state == HRAMacosUpdateHazardStateCancelled;
}

bool hra_macos_update_preparation_failure_next(
    bool currently_latched,
    HRAMacosUpdatePreparationResult result) {
  switch (result) {
    case HRAMacosUpdatePreparationFailed:
      return true;
    case HRAMacosUpdatePreparationSucceeded:
      return false;
    case HRAMacosUpdatePreparationNotAttempted:
    default:
      return currently_latched;
  }
}

static NSArray<NSString *> *HRABundleIdentifiers(void) {
  return @[
    @"kitchen.hraness",
    @"com.jungle.oprte",
    @"com.jungle.kitchen",
  ];
}

static BOOL HRAIsSafePathComponent(NSString *component) {
  return component.length > 0 &&
         ![component isEqualToString:@"."] &&
         ![component isEqualToString:@".."] &&
         [component rangeOfString:@"/"].location == NSNotFound &&
         [component rangeOfString:@"\0"].location == NSNotFound;
}

static NSString *_Nullable HRAEffectiveUserHome(void) {
  const uid_t uid = geteuid();
  long suggested = sysconf(_SC_GETPW_R_SIZE_MAX);
  size_t capacity = suggested > 0 ? (size_t)suggested : 16 * 1024;
  for (NSUInteger attempt = 0; attempt < 4; attempt += 1) {
    char *buffer = calloc(capacity, 1);
    if (buffer == NULL) {
      return nil;
    }
    struct passwd record;
    struct passwd *result = NULL;
    const int status =
        getpwuid_r(uid, &record, buffer, capacity, &result);
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
    if (status != ERANGE) {
      return nil;
    }
    capacity *= 2;
  }
  return nil;
}

static BOOL HRADirectoryIsSafe(NSString *path, uid_t expectedOwner) {
  struct stat metadata;
  if (lstat(path.fileSystemRepresentation, &metadata) != 0) {
    return NO;
  }
  return S_ISDIR(metadata.st_mode) && !S_ISLNK(metadata.st_mode) &&
         metadata.st_uid == expectedOwner;
}

static NSString *_Nullable HRAEnsureAnchorDirectory(
    NSString *parent,
    NSString *component) {
  if (!HRAIsSafePathComponent(component) ||
      !HRADirectoryIsSafe(parent, geteuid())) {
    return nil;
  }
  NSString *path = [parent stringByAppendingPathComponent:component];
  if (mkdir(path.fileSystemRepresentation, 0700) != 0 && errno != EEXIST) {
    return nil;
  }
  return HRADirectoryIsSafe(path, geteuid()) ? path : nil;
}

static NSString *_Nullable HRAUpdateHazardDirectory(void) {
  NSString *home = HRAEffectiveUserHome();
  if (home == nil || !HRADirectoryIsSafe(home, geteuid())) {
    return nil;
  }
  NSString *library = HRAEnsureAnchorDirectory(home, @"Library");
  if (library == nil) {
    return nil;
  }
  NSString *applicationSupport =
      HRAEnsureAnchorDirectory(library, @"Application Support");
  if (applicationSupport == nil) {
    return nil;
  }
  // The updater starts immediately after the gateway process is spawned.
  // Keeping the hazard as an exact sibling avoids creating the canonical
  // HRA data root before a legacy Application Support cutover finishes.
  return applicationSupport;
}

static NSString *_Nullable HRAUpdateHazardPath(void) {
  NSString *directory = HRAUpdateHazardDirectory();
  return directory == nil
      ? nil
      : [directory stringByAppendingPathComponent:
                       HRAUpdateHazardFileName];
}

static BOOL HRADigitsOnly(NSString *value) {
  if (value.length == 0 || value.length > 32) {
    return NO;
  }
  NSCharacterSet *nonDigits =
      [[NSCharacterSet decimalDigitCharacterSet] invertedSet];
  return [value rangeOfCharacterFromSet:nonDigits].location == NSNotFound;
}

static BOOL HRASyncDirectory(NSString *path);

static BOOL HRABase64URLToken(NSString *value) {
  if (![value isKindOfClass:NSString.class] || value.length != 43) {
    return NO;
  }
  NSCharacterSet *invalid =
      [[NSCharacterSet characterSetWithCharactersInString:
                           @"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-"]
          invertedSet];
  return [value rangeOfCharacterFromSet:invalid].location == NSNotFound;
}

static NSDictionary *_Nullable HRAReadPreviewUpdaterCanaryRequest(void) {
  NSString *directory = HRAUpdateHazardDirectory();
  if (directory == nil) {
    return nil;
  }
  NSString *path =
      [directory stringByAppendingPathComponent:
                     HRAPreviewUpdaterCanaryRequestFileName];
  int descriptor = open(path.fileSystemRepresentation, O_RDONLY | O_NOFOLLOW);
  if (descriptor < 0) {
    return nil;
  }
  struct stat directoryMetadata;
  struct stat metadata;
  if (lstat(directory.fileSystemRepresentation, &directoryMetadata) != 0 ||
      fstat(descriptor, &metadata) != 0 ||
      !S_ISDIR(directoryMetadata.st_mode) ||
      directoryMetadata.st_uid != geteuid() ||
      !S_ISREG(metadata.st_mode) || metadata.st_uid != geteuid() ||
      metadata.st_nlink != 1 || (metadata.st_mode & 0777) != 0600 ||
      metadata.st_dev != directoryMetadata.st_dev || metadata.st_size <= 0 ||
      metadata.st_size > 1024) {
    close(descriptor);
    return nil;
  }
  NSMutableData *data =
      [NSMutableData dataWithLength:(NSUInteger)metadata.st_size];
  uint8_t *bytes = data.mutableBytes;
  NSUInteger remaining = data.length;
  while (remaining > 0) {
    ssize_t count = read(descriptor, bytes, remaining);
    if (count <= 0) {
      close(descriptor);
      return nil;
    }
    bytes += (NSUInteger)count;
    remaining -= (NSUInteger)count;
  }
  struct stat after;
  if (fstat(descriptor, &after) != 0 ||
      after.st_dev != metadata.st_dev || after.st_ino != metadata.st_ino ||
      after.st_size != metadata.st_size || after.st_mtime != metadata.st_mtime) {
    close(descriptor);
    return nil;
  }
  close(descriptor);
  NSError *error = nil;
  id value = [NSJSONSerialization JSONObjectWithData:data
                                             options:0
                                               error:&error];
  if (error != nil || ![value isKindOfClass:NSDictionary.class]) {
    return nil;
  }
  NSDictionary *record = value;
  if (record.count != 4 || ![record[@"version"] isEqual:@1] ||
      !HRABase64URLToken(record[@"token"]) ||
      ![record[@"targetVersion"] isKindOfClass:NSString.class] ||
      [record[@"targetVersion"] length] == 0 ||
      [record[@"targetVersion"] length] > 128 ||
      ![record[@"targetBuild"] isKindOfClass:NSString.class] ||
      !HRADigitsOnly(record[@"targetBuild"])) {
    return nil;
  }
  NSDictionary *info = NSBundle.mainBundle.infoDictionary;
  if (![record[@"targetVersion"]
          isEqual:info[@"CFBundleShortVersionString"]] ||
      ![record[@"targetBuild"] isEqual:info[@"CFBundleVersion"]]) {
    return nil;
  }
  return record;
}

static NSString *HRAUpdaterStartResultName(
    HRAMacosUpdaterStartResult result) {
  switch (result) {
    case HRAMacosUpdaterStarted:
      return @"started";
    case HRAMacosUpdaterBlockedByMaintenance:
      return @"maintenance";
    case HRAMacosUpdaterMissingReleaseMetadata:
      return @"missing_release_metadata";
    case HRAMacosUpdaterHazardPreparationFailed:
      return @"hazard_preparation_failed";
    case HRAMacosUpdaterFrameworkLoadFailed:
      return @"framework_load_failed";
    case HRAMacosUpdaterControllerClassMissing:
      return @"controller_class_missing";
    case HRAMacosUpdaterControllerInitializationFailed:
      return @"controller_initialization_failed";
    case HRAMacosUpdaterObjectMissing:
      return @"updater_object_missing";
    case HRAMacosUpdaterStartFailed:
      return @"updater_start_failed";
    case HRAMacosUpdaterStartNotAttempted:
    default:
      return @"not_attempted";
  }
}

static BOOL HRAWritePreviewUpdaterCanaryEvidence(
    NSDictionary *request,
    HRAMacosUpdaterStartResult result) {
  NSString *directory = HRAUpdateHazardDirectory();
  if (directory == nil) {
    return NO;
  }
  NSDictionary *record = @{
    @"version" : @1,
    @"token" : request[@"token"],
    @"pid" : @(getpid()),
    @"targetVersion" : request[@"targetVersion"],
    @"targetBuild" : request[@"targetBuild"],
    @"result" : HRAUpdaterStartResultName(result),
  };
  NSError *jsonError = nil;
  NSData *encoded = [NSJSONSerialization dataWithJSONObject:record
                                                    options:0
                                                      error:&jsonError];
  if (encoded == nil || jsonError != nil || encoded.length > 1024) {
    return NO;
  }
  NSString *path =
      [directory stringByAppendingPathComponent:
                     HRAPreviewUpdaterCanaryEvidenceFileName];
  NSString *temporaryPath =
      [directory stringByAppendingPathComponent:
                     HRAPreviewUpdaterCanaryEvidenceTemporaryFileName];
  int descriptor = open(temporaryPath.fileSystemRepresentation,
                        O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW,
                        0600);
  if (descriptor < 0) {
    return NO;
  }
  const uint8_t *bytes = encoded.bytes;
  NSUInteger remaining = encoded.length;
  BOOL completed = YES;
  while (remaining > 0) {
    ssize_t written = write(descriptor, bytes, remaining);
    if (written <= 0) {
      completed = NO;
      break;
    }
    bytes += (NSUInteger)written;
    remaining -= (NSUInteger)written;
  }
  if (completed && (fchmod(descriptor, 0600) != 0 ||
                    fsync(descriptor) != 0)) {
    completed = NO;
  }
  close(descriptor);
  BOOL published = completed &&
      link(temporaryPath.fileSystemRepresentation,
           path.fileSystemRepresentation) == 0 &&
      HRASyncDirectory(directory) &&
      unlink(temporaryPath.fileSystemRepresentation) == 0 &&
      HRASyncDirectory(directory);
  if (!published) {
    unlink(temporaryPath.fileSystemRepresentation);
    unlink(path.fileSystemRepresentation);
    (void)HRASyncDirectory(directory);
    return NO;
  }
  return YES;
}

static BOOL HRASyncDirectory(NSString *path) {
  int descriptor =
      open(path.fileSystemRepresentation, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  if (descriptor < 0) {
    return NO;
  }
  const BOOL synchronized = fsync(descriptor) == 0;
  close(descriptor);
  return synchronized;
}

static BOOL HRARemoveUncommittedUpdateHazardTemporary(void) {
  NSString *directory = HRAUpdateHazardDirectory();
  if (directory == nil) {
    return NO;
  }
  NSString *temporaryPath =
      [directory stringByAppendingPathComponent:
                     HRAUpdateHazardTemporaryFileName];
  struct stat directoryMetadata;
  struct stat temporaryMetadata;
  if (lstat(directory.fileSystemRepresentation, &directoryMetadata) != 0 ||
      !S_ISDIR(directoryMetadata.st_mode) ||
      directoryMetadata.st_uid != geteuid()) {
    return NO;
  }
  if (lstat(temporaryPath.fileSystemRepresentation, &temporaryMetadata) != 0) {
    return errno == ENOENT;
  }
  if (!S_ISREG(temporaryMetadata.st_mode) ||
      temporaryMetadata.st_uid != geteuid() ||
      temporaryMetadata.st_nlink != 1 ||
      (temporaryMetadata.st_mode & 0777) != 0600 ||
      temporaryMetadata.st_dev != directoryMetadata.st_dev ||
      temporaryMetadata.st_size < 0 ||
      temporaryMetadata.st_size > 1024) {
    return NO;
  }
  if (unlink(temporaryPath.fileSystemRepresentation) != 0) {
    return NO;
  }
  return HRASyncDirectory(directory);
}

static BOOL HRAWriteUpdateHazard(
    NSString *targetBuild,
    NSString *targetVersion,
    NSString *state) {
  if (!HRADigitsOnly(targetBuild) || targetVersion.length == 0 ||
      targetVersion.length > 128 || state.length == 0 ||
      state.length > 32) {
    return NO;
  }
  NSString *directory = HRAUpdateHazardDirectory();
  NSString *path = HRAUpdateHazardPath();
  if (directory == nil || path == nil) {
    return NO;
  }
  NSDictionary *record = @{
    @"version" : @1,
    @"targetBuild" : targetBuild,
    @"targetVersion" : targetVersion,
    @"state" : state,
  };
  NSError *jsonError = nil;
  NSData *encoded = [NSJSONSerialization dataWithJSONObject:record
                                                    options:0
                                                      error:&jsonError];
  if (encoded == nil || jsonError != nil || encoded.length > 1024) {
    return NO;
  }
  NSString *temporaryPath =
      [directory stringByAppendingPathComponent:
                     HRAUpdateHazardTemporaryFileName];
  int descriptor = open(temporaryPath.fileSystemRepresentation,
                        O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW,
                        0600);
  if (descriptor < 0) {
    return NO;
  }
  const uint8_t *bytes = encoded.bytes;
  NSUInteger remaining = encoded.length;
  BOOL completed = YES;
  while (remaining > 0) {
    ssize_t written = write(descriptor, bytes, remaining);
    if (written <= 0) {
      completed = NO;
      break;
    }
    bytes += (NSUInteger)written;
    remaining -= (NSUInteger)written;
  }
  if (completed && (fchmod(descriptor, 0600) != 0 ||
                    fsync(descriptor) != 0)) {
    completed = NO;
  }
  close(descriptor);
  if (!completed ||
      rename(temporaryPath.fileSystemRepresentation,
             path.fileSystemRepresentation) != 0 ||
      !HRASyncDirectory(directory)) {
    unlink(temporaryPath.fileSystemRepresentation);
    return NO;
  }
  return YES;
}

static NSDictionary *_Nullable HRAReadUpdateHazard(void) {
  NSString *path = HRAUpdateHazardPath();
  if (path == nil) {
    return nil;
  }
  int descriptor =
      open(path.fileSystemRepresentation, O_RDONLY | O_NOFOLLOW);
  if (descriptor < 0) {
    return errno == ENOENT ? @{} : nil;
  }
  struct stat metadata;
  if (fstat(descriptor, &metadata) != 0 ||
      !S_ISREG(metadata.st_mode) || metadata.st_uid != geteuid() ||
      metadata.st_nlink != 1 || metadata.st_size <= 0 ||
      metadata.st_size > 1024) {
    close(descriptor);
    return nil;
  }
  NSMutableData *data =
      [NSMutableData dataWithLength:(NSUInteger)metadata.st_size];
  uint8_t *bytes = data.mutableBytes;
  NSUInteger remaining = data.length;
  while (remaining > 0) {
    ssize_t count = read(descriptor, bytes, remaining);
    if (count <= 0) {
      close(descriptor);
      return nil;
    }
    bytes += (NSUInteger)count;
    remaining -= (NSUInteger)count;
  }
  close(descriptor);
  NSError *error = nil;
  id value = [NSJSONSerialization JSONObjectWithData:data
                                             options:0
                                               error:&error];
  if (error != nil || ![value isKindOfClass:NSDictionary.class]) {
    return nil;
  }
  NSDictionary *record = value;
  if (![record[@"version"] isEqual:@1] ||
      ![record[@"targetBuild"] isKindOfClass:NSString.class] ||
      !HRADigitsOnly(record[@"targetBuild"]) ||
      ![record[@"targetVersion"] isKindOfClass:NSString.class] ||
      ![record[@"state"] isKindOfClass:NSString.class] ||
      record.count != 4) {
    return nil;
  }
  return record;
}

static BOOL HRARemoveUpdateHazard(void) {
  NSString *directory = HRAUpdateHazardDirectory();
  NSString *path = HRAUpdateHazardPath();
  if (directory == nil || path == nil) {
    return NO;
  }
  if (unlink(path.fileSystemRepresentation) != 0 && errno != ENOENT) {
    return NO;
  }
  return HRASyncDirectory(directory);
}

typedef NS_ENUM(NSInteger, HRAProbeResult) {
  HRAProbeResultAbsent,
  HRAProbeResultPresent,
  HRAProbeResultIndeterminate,
};

static HRAProbeResult HRAInstallerJobProbe(void) {
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
  for (NSString *identifier in HRABundleIdentifiers()) {
    for (NSString *suffix in
         @[ @"-sparkle-updater", @"-sparkle-progress" ]) {
      NSString *label = [identifier stringByAppendingString:suffix];
      for (NSString *domainValue in
           @[ (__bridge NSString *)kSMDomainUserLaunchd,
              (__bridge NSString *)kSMDomainSystemLaunchd ]) {
        CFDictionaryRef job =
            SMJobCopyDictionary((__bridge CFStringRef)domainValue,
                                (__bridge CFStringRef)label);
        if (job != NULL) {
          CFRelease(job);
          return HRAProbeResultPresent;
        }
      }
    }
  }
#pragma clang diagnostic pop
  return HRAProbeResultAbsent;
}

static HRAProbeResult HRADirectoryContentProbe(NSString *path) {
  struct stat metadata;
  if (lstat(path.fileSystemRepresentation, &metadata) != 0) {
    return errno == ENOENT
        ? HRAProbeResultAbsent
        : HRAProbeResultIndeterminate;
  }
  if (!S_ISDIR(metadata.st_mode) || S_ISLNK(metadata.st_mode) ||
      metadata.st_uid != geteuid()) {
    return HRAProbeResultIndeterminate;
  }
  NSError *error = nil;
  NSArray<NSString *> *entries =
      [[NSFileManager defaultManager] contentsOfDirectoryAtPath:path
                                                         error:&error];
  if (entries == nil || error != nil) {
    return HRAProbeResultIndeterminate;
  }
  return entries.count == 0
      ? HRAProbeResultAbsent
      : HRAProbeResultPresent;
}

static HRAProbeResult HRASparkleCacheProbe(void) {
  NSString *home = HRAEffectiveUserHome();
  if (home == nil) {
    return HRAProbeResultIndeterminate;
  }
  for (NSString *identifier in HRABundleIdentifiers()) {
    NSString *root =
        [[[[home stringByAppendingPathComponent:@"Library"]
            stringByAppendingPathComponent:@"Caches"]
            stringByAppendingPathComponent:identifier]
            stringByAppendingPathComponent:@"org.sparkle-project.Sparkle"];
    for (NSString *leaf in @[ @"PersistentDownloads", @"Launcher" ]) {
      HRAProbeResult result =
          HRADirectoryContentProbe(
              [root stringByAppendingPathComponent:leaf]);
      if (result != HRAProbeResultAbsent) {
        return result;
      }
    }
  }
  return HRAProbeResultAbsent;
}

bool hra_macos_update_removal_is_safe(
    HRAMacosUpdateHazards hazards) {
  return !hazards.session_in_progress &&
         !hazards.memory_hazard &&
         !hazards.durable_hazard &&
         !hazards.preparation_failed &&
         !hazards.installer_job_present &&
         !hazards.sparkle_cache_present &&
         !hazards.probe_indeterminate;
}

bool hra_macos_update_removal_lease_acquire(
    size_t current_count,
    size_t *next_count) {
  if (next_count == NULL || current_count == SIZE_MAX) {
    return false;
  }
  *next_count = current_count + 1;
  return true;
}

bool hra_macos_update_removal_lease_release(
    size_t current_count,
    size_t *next_count) {
  if (next_count == NULL || current_count == 0) {
    return false;
  }
  *next_count = current_count - 1;
  return true;
}

static BOOL HRAInstalledBuildReached(NSString *targetBuild) {
  NSString *installed =
      NSBundle.mainBundle.infoDictionary[@"CFBundleVersion"];
  if (!HRADigitsOnly(installed) ||
      !HRADigitsOnly(targetBuild)) {
    return NO;
  }
  return [installed compare:targetBuild
                    options:NSNumericSearch] != NSOrderedAscending;
}

@interface HRAUpdaterDelegate : NSObject
@property(nonatomic) BOOL memoryHazard;
@property(nonatomic) BOOL persistenceFailed;
@property(nonatomic) BOOL cancellationPending;
- (BOOL)persistItem:(HRASparkleAppcastItem *)item
              state:(NSString *)state;
- (void)clearDiscardableHazardIfProvenSafe:
    (HRASparkleUpdater *)updater;
@end

static HRASparkleController *hraUpdaterController;
static HRAUpdaterDelegate *hraUpdaterDelegate;
static size_t hraUpdaterRemovalMaintenanceLeaseCount;
static BOOL hraUpdaterHazardPreparationFailed;
static HRAMacosUpdaterStartResult hraUpdaterLastStartResult =
    HRAMacosUpdaterStartNotAttempted;

@implementation HRAUpdaterDelegate

- (BOOL)persistItem:(HRASparkleAppcastItem *)item
              state:(NSString *)state {
  NSAssert(NSThread.isMainThread, @"Updater transitions must be on main");
  self.memoryHazard = YES;
  self.cancellationPending = NO;
  BOOL persisted =
      HRAWriteUpdateHazard(item.versionString,
                               item.displayVersionString,
                               state);
  if (!persisted) {
    self.persistenceFailed = YES;
  }
  return persisted;
}

- (void)clearDiscardableHazardIfProvenSafe:
    (HRASparkleUpdater *)updater {
  NSAssert(NSThread.isMainThread, @"Updater transitions must be on main");
  if (updater.sessionInProgress) {
    return;
  }
  NSDictionary *hazard = HRAReadUpdateHazard();
  if (hazard == nil) {
    self.memoryHazard = YES;
    self.persistenceFailed = YES;
    return;
  }
  if (!hra_macos_update_hazard_may_clear_without_artifact(
          HRAUpdateHazardStateValue(hazard[@"state"]),
          self.cancellationPending) ||
      HRAInstallerJobProbe() != HRAProbeResultAbsent ||
      HRASparkleCacheProbe() != HRAProbeResultAbsent) {
    return;
  }
  if (HRARemoveUpdateHazard()) {
    self.memoryHazard = NO;
    self.persistenceFailed = NO;
    self.cancellationPending = NO;
  }
}

- (BOOL)updater:(id)updater
    mayPerformUpdateCheck:(NSInteger)updateCheck
                    error:(NSError *__autoreleasing *)error {
  (void)updater;
  (void)updateCheck;
  if (hraUpdaterRemovalMaintenanceLeaseCount == 0) {
    return YES;
  }
  if (error != NULL) {
    *error = [NSError
        errorWithDomain:@"kitchen.hraness.updater"
                   code:1
               userInfo:@{
                 NSLocalizedDescriptionKey :
                     @"Updates are unavailable while local data removal is scheduled."
               }];
  }
  return NO;
}

- (void)updater:(id)updater
    didFindValidUpdate:(HRASparkleAppcastItem *)item {
  (void)updater;
  [self persistItem:item state:HRAUpdateHazardStateFound];
}

- (void)updater:(id)updater
    willDownloadUpdate:(HRASparkleAppcastItem *)item
           withRequest:(NSMutableURLRequest *)request {
  (void)updater;
  (void)request;
  [self persistItem:item state:HRAUpdateHazardStateDownloading];
}

- (void)updater:(id)updater
    didDownloadUpdate:(HRASparkleAppcastItem *)item {
  (void)updater;
  [self persistItem:item state:HRAUpdateHazardStateDownloaded];
}

- (void)updater:(id)updater
    willExtractUpdate:(HRASparkleAppcastItem *)item {
  (void)updater;
  [self persistItem:item state:HRAUpdateHazardStateExtracting];
}

- (void)updater:(id)updater
    willInstallUpdate:(HRASparkleAppcastItem *)item {
  (void)updater;
  [self persistItem:item state:HRAUpdateHazardStateInstalling];
}

- (BOOL)updater:(id)updater
    willInstallUpdateOnQuit:(HRASparkleAppcastItem *)item
    immediateInstallationBlock:(void (^)(void))immediateInstallHandler {
  (void)updater;
  (void)immediateInstallHandler;
  [self persistItem:item state:HRAUpdateHazardStateInstallOnQuit];
  return NO;
}

- (void)updater:(id)updater
    userDidMakeChoice:(HRASparkleUserUpdateChoice)choice
             forUpdate:(HRASparkleAppcastItem *)item
                  state:(HRASparkleUserUpdateState *)state {
  (void)updater;
  if (choice == HRASparkleUserUpdateChoiceSkip ||
      (choice == HRASparkleUserUpdateChoiceDismiss &&
       state.stage == HRASparkleUserUpdateStageNotDownloaded)) {
    self.memoryHazard = YES;
    self.cancellationPending =
        HRAWriteUpdateHazard(item.versionString,
                                 item.displayVersionString,
                                 HRAUpdateHazardStateCancelled);
    if (!self.cancellationPending) {
      self.persistenceFailed = YES;
    }
    return;
  }
  NSString *hazardState =
      state.stage == HRASparkleUserUpdateStageInstalling
          ? HRAUpdateHazardStateInstalling
          : state.stage == HRASparkleUserUpdateStageDownloaded
                ? HRAUpdateHazardStateDownloaded
                : HRAUpdateHazardStateFound;
  [self persistItem:item state:hazardState];
}

- (void)userDidCancelDownload:(id)updater {
  (void)updater;
  self.cancellationPending = YES;
}

- (void)updater:(id)updater
    failedToDownloadUpdate:(HRASparkleAppcastItem *)item
                     error:(NSError *)error {
  (void)updater;
  (void)item;
  (void)error;
  self.cancellationPending = YES;
}

- (void)updater:(id)updater
    didFinishUpdateCycleForUpdateCheck:(NSInteger)updateCheck
                                 error:(NSError *)error {
  (void)updateCheck;
  (void)error;
  [self clearDiscardableHazardIfProvenSafe:
            (HRASparkleUpdater *)updater];
}

- (void)updater:(id)updater didAbortWithError:(NSError *)error {
  (void)updater;
  (void)error;
  // Sparkle has ended this driver. Retain the durable hazard until the normal
  // finish callback proves that no detached job or deferred cache remains.
  self.cancellationPending = YES;
}

- (BOOL)updaterShouldRelaunchApplication:(id)updater {
  (void)updater;
  return hraUpdaterRemovalMaintenanceLeaseCount == 0;
}

@end

static BOOL HRAPrepareDurableHazardAtStartup(void) {
  if (!HRARemoveUncommittedUpdateHazardTemporary()) {
    return NO;
  }
  NSDictionary *hazard = HRAReadUpdateHazard();
  if (hazard == nil) {
    return NO;
  }
  if (hazard.count == 0) {
    return YES;
  }
  BOOL mayClear =
      HRAInstalledBuildReached(hazard[@"targetBuild"]) ||
      hra_macos_update_hazard_may_clear_without_artifact(
          HRAUpdateHazardStateValue(hazard[@"state"]),
          false);
  if (mayClear &&
      HRAInstallerJobProbe() == HRAProbeResultAbsent &&
      HRASparkleCacheProbe() == HRAProbeResultAbsent) {
    return HRARemoveUpdateHazard();
  }
  return YES;
}

static HRAMacosUpdaterStartResult HRAFinishUpdaterStart(
    NSDictionary *_Nullable canaryRequest,
    HRAMacosUpdaterStartResult result) {
  hraUpdaterLastStartResult = result;
  if (canaryRequest != nil &&
      !HRAWritePreviewUpdaterCanaryEvidence(canaryRequest, result)) {
    NSLog(@"HRA updater could not persist protected canary evidence");
  }
  return result;
}

static HRAMacosUpdaterStartResult HRAUpdaterStartOnMainThread(void) {
  if (!NSThread.isMainThread) {
    return HRAMacosUpdaterStartNotAttempted;
  }
  NSDictionary *canaryRequest = HRAReadPreviewUpdaterCanaryRequest();
  if (hraUpdaterRemovalMaintenanceLeaseCount != 0) {
    return HRAFinishUpdaterStart(
        canaryRequest,
        HRAMacosUpdaterBlockedByMaintenance);
  }
  if (hraUpdaterController != nil) {
    return HRAFinishUpdaterStart(
        canaryRequest,
        HRAMacosUpdaterStarted);
  }

  NSDictionary *info = NSBundle.mainBundle.infoDictionary;
  NSString *feedURL = info[@"SUFeedURL"];
  NSString *publicKey = info[@"SUPublicEDKey"];
  if (feedURL.length == 0 || publicKey.length == 0) {
    // Local unsigned packages intentionally omit the public key and do not
    // perform update checks. Release metadata verification requires it.
    return HRAFinishUpdaterStart(
        canaryRequest,
        HRAMacosUpdaterMissingReleaseMetadata);
  }
  const BOOL hazardPrepared = HRAPrepareDurableHazardAtStartup();
  hraUpdaterHazardPreparationFailed =
      hra_macos_update_preparation_failure_next(
          hraUpdaterHazardPreparationFailed,
          hazardPrepared
              ? HRAMacosUpdatePreparationSucceeded
              : HRAMacosUpdatePreparationFailed);
  if (!hazardPrepared) {
    // Any unreadable or unpersistable hazard state disables Sparkle and keeps
    // destructive maintenance fail-closed.
    return HRAFinishUpdaterStart(
        canaryRequest,
        HRAMacosUpdaterHazardPreparationFailed);
  }

  NSURL *frameworkURL =
      [NSBundle.mainBundle.privateFrameworksURL
          URLByAppendingPathComponent:@"Sparkle.framework"
                          isDirectory:YES];
  NSBundle *frameworkBundle = [NSBundle bundleWithURL:frameworkURL];
  NSError *loadError = nil;
  if (frameworkBundle == nil ||
      ![frameworkBundle loadAndReturnError:&loadError]) {
    NSLog(@"HRA updater could not load Sparkle: %@", loadError);
    return HRAFinishUpdaterStart(
        canaryRequest,
        HRAMacosUpdaterFrameworkLoadFailed);
  }

  Class controllerClass = NSClassFromString(@"SPUStandardUpdaterController");
  if (controllerClass == Nil) {
    NSLog(@"HRA updater could not resolve SPUStandardUpdaterController");
    return HRAFinishUpdaterStart(
        canaryRequest,
        HRAMacosUpdaterControllerClassMissing);
  }
  hraUpdaterDelegate = [HRAUpdaterDelegate new];
  NSDictionary *hazard = HRAReadUpdateHazard();
  if (hazard == nil) {
    hraUpdaterDelegate.persistenceFailed = YES;
    hraUpdaterDelegate.memoryHazard = YES;
  } else if (hazard.count > 0) {
    hraUpdaterDelegate.memoryHazard = YES;
  }
  id allocated = [controllerClass alloc];
  HRASparkleController *controller =
      [(HRASparkleController *)allocated
          initWithStartingUpdater:NO
                  updaterDelegate:hraUpdaterDelegate
               userDriverDelegate:nil];
  if (controller == nil) {
    hraUpdaterDelegate = nil;
    return HRAFinishUpdaterStart(
        canaryRequest,
        HRAMacosUpdaterControllerInitializationFailed);
  }
  HRASparkleUpdater *updater =
      (HRASparkleUpdater *)controller.updater;
  if (updater == nil) {
    hraUpdaterDelegate = nil;
    return HRAFinishUpdaterStart(
        canaryRequest,
        HRAMacosUpdaterObjectMissing);
  }
  NSError *startError = nil;
  if (![updater startUpdater:&startError]) {
    NSLog(@"HRA updater could not start Sparkle: %@", startError);
    hraUpdaterDelegate = nil;
    return HRAFinishUpdaterStart(
        canaryRequest,
        HRAMacosUpdaterStartFailed);
  }
  hraUpdaterController = controller;
  return HRAFinishUpdaterStart(
      canaryRequest,
      HRAMacosUpdaterStarted);
}

static void HRAShowManualUpdateFallbackOnMainThread(void) {
  NSCAssert(NSThread.isMainThread, @"Updater UI must be on main");
  NSDictionary *info = NSBundle.mainBundle.infoDictionary;
  id rawVersion = info[@"CFBundleShortVersionString"];
  id rawBuild = info[@"CFBundleVersion"];
  NSString *version = [rawVersion isKindOfClass:NSString.class]
      ? rawVersion
      : nil;
  NSString *build = [rawBuild isKindOfClass:NSString.class]
      ? rawBuild
      : nil;
  NSString *installed =
      version.length > 0 && build.length > 0
          ? [NSString stringWithFormat:@"HRA %@ (%@)", version, build]
          : @"This HRA build";

  NSAlert *alert = [NSAlert new];
  alert.alertStyle = NSAlertStyleInformational;
  alert.messageText = @"Automatic update checking is unavailable";
  alert.informativeText = [NSString stringWithFormat:
      @"%@ will keep running. Retry later, or download the latest release "
       @"from https://hra.sh/download.",
      installed];
  [alert addButtonWithTitle:@"Open Download Page"];
  [alert addButtonWithTitle:@"Not Now"];
  if ([alert runModal] != NSAlertFirstButtonReturn) {
    return;
  }
  NSURL *downloadURL = [NSURL URLWithString:@"https://hra.sh/download"];
  if (downloadURL != nil) {
    [NSWorkspace.sharedWorkspace openURL:downloadURL];
  }
}

bool hra_macos_updater_start(void) {
  __block HRAMacosUpdaterStartResult result =
      HRAMacosUpdaterStartNotAttempted;
  void (^work)(void) = ^{
    result = HRAUpdaterStartOnMainThread();
  };
  if (NSThread.isMainThread) {
    work();
  } else {
    dispatch_sync(dispatch_get_main_queue(), work);
  }
  return result == HRAMacosUpdaterStarted;
}

HRAMacosUpdaterStartResult hra_macos_updater_last_start_result(void) {
  __block HRAMacosUpdaterStartResult result =
      HRAMacosUpdaterStartNotAttempted;
  void (^work)(void) = ^{
    result = hraUpdaterLastStartResult;
  };
  if (NSThread.isMainThread) {
    work();
  } else {
    dispatch_sync(dispatch_get_main_queue(), work);
  }
  return result;
}

bool hra_macos_updater_check_for_updates(bool updater_allowed) {
  __block BOOL result = NO;
  void (^work)(void) = ^{
    if (updater_allowed &&
        HRAUpdaterStartOnMainThread() == HRAMacosUpdaterStarted) {
      [hraUpdaterController checkForUpdates:nil];
      result = YES;
      return;
    }
    // A user-requested check must never disappear silently. Do not surface
    // this alert from automatic startup checks, and do not expose the internal
    // reason (which may contain local filesystem or framework details).
    HRAShowManualUpdateFallbackOnMainThread();
  };
  if (NSThread.isMainThread) {
    work();
  } else {
    dispatch_sync(dispatch_get_main_queue(), work);
  }
  return result;
}

bool hra_macos_updater_enter_removal_maintenance(void) {
  __block BOOL result = NO;
  void (^work)(void) = ^{
    size_t nextLeaseCount = 0;
    if (hraUpdaterRemovalMaintenanceLeaseCount != 0) {
      if (!hra_macos_update_removal_lease_acquire(
              hraUpdaterRemovalMaintenanceLeaseCount,
              &nextLeaseCount)) {
        result = NO;
        return;
      }
      hraUpdaterRemovalMaintenanceLeaseCount = nextLeaseCount;
      result = YES;
      return;
    }

    // Close the in-process gate before probing. Every delegate callback and
    // updater command is serialized on this same queue, so an update check
    // cannot begin after the hazard snapshot.
    if (!hra_macos_update_removal_lease_acquire(
            hraUpdaterRemovalMaintenanceLeaseCount,
            &nextLeaseCount)) {
      result = NO;
      return;
    }
    hraUpdaterRemovalMaintenanceLeaseCount = nextLeaseCount;
    HRASparkleUpdater *updater =
        (HRASparkleUpdater *)hraUpdaterController.updater;
    NSDictionary *durableHazard = HRAReadUpdateHazard();
    HRAProbeResult installer = HRAInstallerJobProbe();
    HRAProbeResult cache = HRASparkleCacheProbe();
    HRAMacosUpdateHazards hazards = {
      .session_in_progress = updater != nil && updater.sessionInProgress,
      .memory_hazard =
          hraUpdaterDelegate.memoryHazard ||
          hraUpdaterDelegate.persistenceFailed,
      .durable_hazard =
          durableHazard == nil || durableHazard.count > 0,
      .preparation_failed = hraUpdaterHazardPreparationFailed,
      .installer_job_present = installer == HRAProbeResultPresent,
      .sparkle_cache_present = cache == HRAProbeResultPresent,
      .probe_indeterminate =
          installer == HRAProbeResultIndeterminate ||
          cache == HRAProbeResultIndeterminate,
    };
    if (!hra_macos_update_removal_is_safe(hazards)) {
      hraUpdaterRemovalMaintenanceLeaseCount = 0;
      result = NO;
      return;
    }

    hraUpdaterController = nil;
    hraUpdaterDelegate = nil;
    result = YES;
  };
  if (NSThread.isMainThread) {
    work();
  } else {
    dispatch_sync(dispatch_get_main_queue(), work);
  }
  return result;
}

void hra_macos_updater_leave_removal_maintenance(void) {
  void (^work)(void) = ^{
    size_t nextLeaseCount = 0;
    if (!hra_macos_update_removal_lease_release(
            hraUpdaterRemovalMaintenanceLeaseCount,
            &nextLeaseCount)) {
      return;
    }
    hraUpdaterRemovalMaintenanceLeaseCount = nextLeaseCount;
    if (hraUpdaterRemovalMaintenanceLeaseCount != 0) {
      return;
    }
    // The exclusion is rolled back only before the gateway has quiesced.
    // Restore automatic checking when this is a provisioned release; unsigned
    // local packages remain inert because the checked feed key is absent.
    (void)HRAUpdaterStartOnMainThread();
  };
  if (NSThread.isMainThread) {
    work();
  } else {
    dispatch_sync(dispatch_get_main_queue(), work);
  }
}

void hra_macos_updater_stop(void) {
  void (^work)(void) = ^{
    hraUpdaterController = nil;
    hraUpdaterDelegate = nil;
  };
  if (NSThread.isMainThread) {
    work();
  } else {
    dispatch_sync(dispatch_get_main_queue(), work);
  }
}
