#import "macos_instance_guard.h"

#import <Foundation/Foundation.h>
#import <errno.h>
#import <fcntl.h>
#import <pwd.h>
#import <sys/file.h>
#import <sys/stat.h>
#import <unistd.h>

static int hraInstanceLockDescriptor = -1;
static HRAMacosInstanceGuardStatus hraInstanceStatus =
    HRAMacosInstanceGuardUnavailable;

static NSString *_Nullable HRAGuardEffectiveHome(void) {
  long suggested = sysconf(_SC_GETPW_R_SIZE_MAX);
  size_t capacity = suggested > 0 ? (size_t)suggested : 16 * 1024;
  for (NSUInteger attempt = 0; attempt < 4; attempt += 1) {
    char *buffer = calloc(capacity, 1);
    if (buffer == NULL) return nil;
    struct passwd record;
    struct passwd *result = NULL;
    int status =
        getpwuid_r(geteuid(), &record, buffer, capacity, &result);
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

static BOOL HRAGuardDirectoryIsSafe(NSString *path) {
  struct stat metadata;
  return lstat(path.fileSystemRepresentation, &metadata) == 0 &&
         S_ISDIR(metadata.st_mode) && !S_ISLNK(metadata.st_mode) &&
         metadata.st_uid == geteuid();
}

static NSString *_Nullable HRAGuardEnsureDirectory(
    NSString *parent,
    NSString *component,
    BOOL appOwned) {
  if (!HRAGuardDirectoryIsSafe(parent) ||
      component.length == 0 ||
      [component containsString:@"/"] ||
      [component isEqualToString:@"."] ||
      [component isEqualToString:@".."]) {
    return nil;
  }
  NSString *path = [parent stringByAppendingPathComponent:component];
  if (mkdir(path.fileSystemRepresentation, 0700) != 0 && errno != EEXIST) {
    return nil;
  }
  if (!HRAGuardDirectoryIsSafe(path)) return nil;
  if (appOwned && chmod(path.fileSystemRepresentation, 0700) != 0) {
    return nil;
  }
  return path;
}

static BOOL HRARemovalExclusionExists(NSString *applicationSupport) {
  NSString *path =
      [applicationSupport
          stringByAppendingPathComponent:
              @".OPRTE Removal.removal-in-progress"];
  struct stat metadata;
  if (lstat(path.fileSystemRepresentation, &metadata) == 0) {
    return YES;
  }
  return errno != ENOENT;
}

HRAMacosInstanceGuardStatus
hra_macos_instance_guard_acquire(void) {
  @autoreleasepool {
    if (hraInstanceLockDescriptor >= 0) {
      return hraInstanceStatus;
    }
    NSString *home = HRAGuardEffectiveHome();
    if (home == nil || !HRAGuardDirectoryIsSafe(home)) {
      return HRAMacosInstanceGuardUnavailable;
    }
    NSString *library =
        HRAGuardEnsureDirectory(home, @"Library", NO);
    NSString *applicationSupport =
        library == nil
            ? nil
            : HRAGuardEnsureDirectory(
                  library, @"Application Support", NO);
    if (applicationSupport == nil) {
      return HRAMacosInstanceGuardUnavailable;
    }
    NSString *lockPath =
        [applicationSupport
            // Stable cross-version lock: predecessor releases must contend on
            // the same inode while the Application Support root is renamed.
            stringByAppendingPathComponent:
                @".Hraness Kitchen.native-instance.lock"];
    int descriptor = open(lockPath.fileSystemRepresentation,
                          O_RDWR | O_CREAT | O_NOFOLLOW | O_CLOEXEC,
                          0600);
    if (descriptor < 0) {
      return HRAMacosInstanceGuardUnavailable;
    }
    struct stat metadata;
    if (fstat(descriptor, &metadata) != 0 ||
        !S_ISREG(metadata.st_mode) || metadata.st_uid != geteuid() ||
        metadata.st_nlink != 1 || fchmod(descriptor, 0600) != 0) {
      close(descriptor);
      return HRAMacosInstanceGuardUnavailable;
    }
    if (flock(descriptor, LOCK_EX | LOCK_NB) != 0) {
      close(descriptor);
      return errno == EWOULDBLOCK
          ? HRAMacosInstanceGuardBusy
          : HRAMacosInstanceGuardUnavailable;
    }
    if (fsync(descriptor) != 0) {
      flock(descriptor, LOCK_UN);
      close(descriptor);
      return HRAMacosInstanceGuardUnavailable;
    }
    hraInstanceLockDescriptor = descriptor;
    hraInstanceStatus =
        HRARemovalExclusionExists(applicationSupport)
            ? HRAMacosInstanceGuardRemovalRecoveryRequired
            : HRAMacosInstanceGuardClear;
    return hraInstanceStatus;
  }
}

void hra_macos_instance_guard_release(void) {
  @autoreleasepool {
    if (hraInstanceLockDescriptor < 0) return;
    flock(hraInstanceLockDescriptor, LOCK_UN);
    close(hraInstanceLockDescriptor);
    hraInstanceLockDescriptor = -1;
    hraInstanceStatus = HRAMacosInstanceGuardUnavailable;
  }
}
