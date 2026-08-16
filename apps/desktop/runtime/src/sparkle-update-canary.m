#import <AppKit/AppKit.h>
#import <Foundation/Foundation.h>
#import <Sparkle/Sparkle.h>

static const NSTimeInterval HRACanaryTerminationDeadlineSeconds = 20.0;
static const unsigned long long HRACanaryMinimumDeadlineSeconds = 60;
static const unsigned long long HRACanaryMaximumDeadlineSeconds = 15 * 60;

@interface HRACanaryDriver : NSObject <SPUUpdaterDelegate, SPUUserDriver>

@property(nonatomic, strong) NSBundle *targetBundle;
@property(nonatomic, strong) NSURL *targetBundleURL;
@property(nonatomic, strong) NSURL *feedURL;
@property(nonatomic, strong) NSURL *expectedEnclosureURL;
@property(nonatomic, strong) NSURL *traceURL;
@property(nonatomic, strong) NSURL *ackURL;
@property(nonatomic, copy) NSString *ackToken;
@property(nonatomic, copy) NSString *expectedVersion;
@property(nonatomic, copy) NSString *expectedBuild;
@property(nonatomic) uint64_t expectedLength;
@property(nonatomic) NSTimeInterval deadlineSeconds;
@property(nonatomic) pid_t predecessorPID;
@property(nonatomic) pid_t candidatePID;
@property(nonatomic) uint64_t downloadedLength;
@property(nonatomic) BOOL foundUpdate;
@property(nonatomic) BOOL beganDownload;
@property(nonatomic) BOOL completedDownload;
@property(nonatomic) BOOL beganExtraction;
@property(nonatomic) BOOL completedExtraction;
@property(nonatomic) BOOL beganInstall;
@property(nonatomic) BOOL requestedRelaunch;
@property(nonatomic) BOOL observedCandidate;
@property(nonatomic) BOOL requestedCandidateTermination;
@property(nonatomic) CFAbsoluteTime candidateTerminationDeadline;
@property(nonatomic, strong) SPUUpdater *updater;

- (void)fail:(NSString *)message;
- (void)emit:(NSString *)event fields:(NSDictionary<NSString *, id> *)fields;
- (void)pollCandidate;

@end

static NSURL *HRACanonicalFileURL(NSURL *URL) {
  return URL.URLByStandardizingPath.URLByResolvingSymlinksInPath;
}

static BOOL HRAURLsEqual(NSURL *left, NSURL *right) {
  return [HRACanonicalFileURL(left).path
      isEqualToString:HRACanonicalFileURL(right).path];
}

static NSDictionary<NSString *, id> *HRAReadInfoPlist(NSURL *bundleURL) {
  NSURL *plistURL = [bundleURL URLByAppendingPathComponent:@"Contents/Info.plist"];
  NSData *data = [NSData dataWithContentsOfURL:plistURL options:0 error:nil];
  if (data == nil) {
    return nil;
  }
  id value = [NSPropertyListSerialization propertyListWithData:data
                                                       options:NSPropertyListImmutable
                                                        format:nil
                                                         error:nil];
  return [value isKindOfClass:NSDictionary.class] ? value : nil;
}

static NSString *HRAArgument(NSArray<NSString *> *arguments,
                               NSString *name) {
  NSUInteger index = [arguments indexOfObject:name];
  if (index == NSNotFound || index + 1 >= arguments.count) {
    return nil;
  }
  NSString *value = arguments[index + 1];
  return value.length > 0 ? value : nil;
}

@implementation HRACanaryDriver

- (void)emit:(NSString *)event fields:(NSDictionary<NSString *, id> *)fields {
  NSMutableDictionary<NSString *, id> *record = [fields mutableCopy];
  record[@"event"] = event;
  if (![NSJSONSerialization isValidJSONObject:record]) {
    fprintf(stderr, "Invalid canary trace record\n");
    exit(70);
  }
  NSError *error = nil;
  NSData *json = [NSJSONSerialization dataWithJSONObject:record options:0 error:&error];
  if (json == nil) {
    fprintf(stderr, "Could not serialize canary trace: %s\n",
            error.localizedDescription.UTF8String);
    exit(70);
  }
  NSFileHandle *handle = [NSFileHandle fileHandleForWritingToURL:self.traceURL
                                                           error:&error];
  if (handle == nil) {
    fprintf(stderr, "Could not open canary trace: %s\n",
            error.localizedDescription.UTF8String);
    exit(70);
  }
  @try {
    [handle seekToEndOfFile];
    [handle writeData:json];
    [handle writeData:[@"\n" dataUsingEncoding:NSUTF8StringEncoding]];
    [handle synchronizeFile];
    [handle closeFile];
  } @catch (NSException *exception) {
    fprintf(stderr, "Could not append canary trace: %s\n",
            exception.reason.UTF8String);
    exit(70);
  }
}

- (void)fail:(NSString *)message {
  [self emit:@"failed" fields:@{ @"message" : message }];
  fprintf(stderr, "Sparkle update canary failed: %s\n", message.UTF8String);
  exit(1);
}

- (void)begin {
  NSRunningApplication *predecessor =
      [NSRunningApplication runningApplicationWithProcessIdentifier:self.predecessorPID];
  if (predecessor == nil || predecessor.terminated ||
      !HRAURLsEqual(predecessor.bundleURL, self.targetBundleURL)) {
    [self fail:@"exact predecessor application is not running"];
  }

  [self emit:@"driver_started"
       fields:@{ @"predecessorPid" : @(self.predecessorPID) }];
  NSError *startError = nil;
  if (![self.updater startUpdater:&startError]) {
    [self fail:[NSString stringWithFormat:@"Sparkle could not start: %@",
                                          startError.localizedDescription]];
  }
  [self.updater checkForUpdates];

  __weak HRACanaryDriver *weakSelf = self;
  dispatch_after(
      dispatch_time(DISPATCH_TIME_NOW,
                    (int64_t)(self.deadlineSeconds * NSEC_PER_SEC)),
      dispatch_get_main_queue(), ^{
        HRACanaryDriver *strongSelf = weakSelf;
        if (strongSelf != nil) {
          [strongSelf fail:@"bounded Sparkle transition deadline expired"];
        }
      });
  [self pollCandidate];
}

- (void)pollCandidate {
  NSRunningApplication *candidate = nil;
  for (NSRunningApplication *application in
       [NSRunningApplication runningApplicationsWithBundleIdentifier:
                                 self.targetBundle.bundleIdentifier]) {
    if (application.processIdentifier != self.predecessorPID &&
        !application.terminated &&
        HRAURLsEqual(application.bundleURL, self.targetBundleURL)) {
      candidate = application;
      break;
    }
  }

  if (!self.observedCandidate && candidate != nil) {
    if (!self.foundUpdate || !self.beganDownload || !self.completedDownload ||
        self.downloadedLength != self.expectedLength ||
        !self.beganExtraction || !self.completedExtraction ||
        !self.beganInstall || !self.requestedRelaunch) {
      [self fail:@"candidate relaunched before the complete verified update lifecycle"];
    }
    NSDictionary<NSString *, id> *info = HRAReadInfoPlist(self.targetBundleURL);
    if (![info[@"CFBundleShortVersionString"] isEqual:self.expectedVersion] ||
        ![info[@"CFBundleVersion"] isEqual:self.expectedBuild]) {
      [self fail:@"relaunched bundle does not have the exact candidate identity"];
    }
    self.observedCandidate = YES;
    self.candidatePID = candidate.processIdentifier;
    [self emit:@"candidate_relaunched"
         fields:@{
           @"pid" : @(self.candidatePID),
           @"version" : self.expectedVersion,
           @"build" : self.expectedBuild,
         }];
  }

  if (self.observedCandidate) {
    candidate = [NSRunningApplication
        runningApplicationWithProcessIdentifier:self.candidatePID];
    if (candidate == nil || candidate.terminated) {
      if (!self.requestedCandidateTermination) {
        [self fail:@"candidate exited before the orchestrator accepted it"];
      }
      [self emit:@"candidate_terminated"
           fields:@{ @"pid" : @(self.candidatePID) }];
      exit(0);
    }

    if (!self.requestedCandidateTermination) {
      NSData *ackBytes = [NSData dataWithContentsOfURL:self.ackURL];
      NSString *ack = ackBytes == nil
          ? nil
          : [[NSString alloc] initWithData:ackBytes encoding:NSUTF8StringEncoding];
      NSString *expectedAck = [self.ackToken stringByAppendingString:@"\n"];
      if ([ack isEqualToString:expectedAck]) {
        self.requestedCandidateTermination = YES;
        self.candidateTerminationDeadline =
            CFAbsoluteTimeGetCurrent() + HRACanaryTerminationDeadlineSeconds;
        if (![candidate terminate]) {
          [self fail:@"candidate rejected ordinary termination"];
        }
      }
    } else if (CFAbsoluteTimeGetCurrent() >= self.candidateTerminationDeadline) {
      // Never turn a forced shutdown into passing release evidence. Force only
      // the exact, unique temporary candidate so the runner cannot retain it.
      [candidate forceTerminate];
      [self fail:@"candidate required forced termination"];
    }
  }

  __weak HRACanaryDriver *weakSelf = self;
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 100 * NSEC_PER_MSEC),
                 dispatch_get_main_queue(), ^{
                   [weakSelf pollCandidate];
                 });
}

- (NSString *)feedURLStringForUpdater:(SPUUpdater *)updater {
  (void)updater;
  return self.feedURL.absoluteString;
}

- (void)showUpdatePermissionRequest:(SPUUpdatePermissionRequest *)request
                              reply:(void (^)(SUUpdatePermissionResponse *))reply {
  (void)request;
  reply([[SUUpdatePermissionResponse alloc]
      initWithAutomaticUpdateChecks:NO
                  sendSystemProfile:NO]);
}

- (void)showUserInitiatedUpdateCheckWithCancellation:(void (^)(void))cancellation {
  (void)cancellation;
}

- (void)showUpdateFoundWithAppcastItem:(SUAppcastItem *)item
                                 state:(SPUUserUpdateState *)state
                                 reply:(void (^)(SPUUserUpdateChoice))reply {
  (void)state;
  if (self.foundUpdate) {
    [self fail:@"Sparkle presented the candidate more than once"];
  }
  if (![item.versionString isEqual:self.expectedBuild] ||
      ![item.displayVersionString isEqual:self.expectedVersion] ||
      item.fileURL == nil ||
      ![item.fileURL.absoluteString
          isEqualToString:self.expectedEnclosureURL.absoluteString] ||
      item.contentLength != self.expectedLength || item.informationOnlyUpdate) {
    [self fail:@"Sparkle selected an unexpected update item"];
  }
  self.foundUpdate = YES;
  [self emit:@"update_found"
       fields:@{
         @"version" : item.displayVersionString,
         @"build" : item.versionString,
         @"url" : item.fileURL.absoluteString,
         @"length" : @(item.contentLength),
       }];
  reply(SPUUserUpdateChoiceInstall);
}

- (void)showUpdateReleaseNotesWithDownloadData:(SPUDownloadData *)downloadData {
  (void)downloadData;
}

- (void)showUpdateReleaseNotesFailedToDownloadWithError:(NSError *)error {
  (void)error;
}

- (void)showUpdateNotFoundWithError:(NSError *)error
                     acknowledgement:(void (^)(void))acknowledgement {
  acknowledgement();
  [self fail:[NSString stringWithFormat:@"Sparkle found no candidate: %@",
                                        error.localizedDescription]];
}

- (void)showUpdaterError:(NSError *)error
          acknowledgement:(void (^)(void))acknowledgement {
  acknowledgement();
  [self fail:[NSString stringWithFormat:@"Sparkle updater error: %@",
                                        error.localizedDescription]];
}

- (void)showDownloadInitiatedWithCancellation:(void (^)(void))cancellation {
  (void)cancellation;
}

- (void)showDownloadDidReceiveExpectedContentLength:(uint64_t)expectedContentLength {
  if (expectedContentLength != self.expectedLength) {
    [self fail:@"Sparkle download Content-Length is not exact"];
  }
}

- (void)showDownloadDidReceiveDataOfLength:(uint64_t)length {
  if (UINT64_MAX - self.downloadedLength < length) {
    [self fail:@"Sparkle download byte count overflowed"];
  }
  self.downloadedLength += length;
  if (self.downloadedLength > self.expectedLength) {
    [self fail:@"Sparkle downloaded more than the signed enclosure length"];
  }
}

- (void)showDownloadDidStartExtractingUpdate {}

- (void)showExtractionReceivedProgress:(double)progress {
  if (progress < 0.0 || progress > 1.0) {
    [self fail:@"Sparkle extraction progress escaped its closed interval"];
  }
}

- (void)showReadyToInstallAndRelaunch:(void (^)(SPUUserUpdateChoice))reply {
  reply(SPUUserUpdateChoiceInstall);
}

- (void)showInstallingUpdateWithApplicationTerminated:(BOOL)applicationTerminated
                           retryTerminatingApplication:(void (^)(void))retryTerminatingApplication {
  (void)applicationTerminated;
  (void)retryTerminatingApplication;
}

- (void)showUpdateInstalledAndRelaunched:(BOOL)relaunched
                         acknowledgement:(void (^)(void))acknowledgement {
  acknowledgement();
  if (!relaunched) {
    [self fail:@"Sparkle installed the candidate without relaunching it"];
  }
}

- (void)dismissUpdateInstallation {}

- (void)updater:(SPUUpdater *)updater
    willDownloadUpdate:(SUAppcastItem *)item
            withRequest:(NSMutableURLRequest *)request {
  (void)updater;
  (void)item;
  if (self.beganDownload || request.URL == nil ||
      ![request.URL.absoluteString
          isEqualToString:self.expectedEnclosureURL.absoluteString]) {
    [self fail:@"Sparkle began an unexpected enclosure download"];
  }
  self.beganDownload = YES;
  [self emit:@"download_started" fields:@{}];
}

- (void)updater:(SPUUpdater *)updater didDownloadUpdate:(SUAppcastItem *)item {
  (void)updater;
  (void)item;
  if (!self.beganDownload || self.completedDownload ||
      self.downloadedLength != self.expectedLength) {
    [self fail:@"Sparkle download lifecycle is inconsistent"];
  }
  self.completedDownload = YES;
  [self emit:@"downloaded" fields:@{}];
}

- (void)updater:(SPUUpdater *)updater willExtractUpdate:(SUAppcastItem *)item {
  (void)updater;
  (void)item;
  if (!self.completedDownload || self.beganExtraction) {
    [self fail:@"Sparkle extraction lifecycle is inconsistent"];
  }
  self.beganExtraction = YES;
  [self emit:@"extraction_started" fields:@{}];
}

- (void)updater:(SPUUpdater *)updater didExtractUpdate:(SUAppcastItem *)item {
  (void)updater;
  (void)item;
  if (!self.beganExtraction || self.completedExtraction) {
    [self fail:@"Sparkle extraction completion is inconsistent"];
  }
  self.completedExtraction = YES;
  [self emit:@"extracted" fields:@{}];
}

- (void)updater:(SPUUpdater *)updater willInstallUpdate:(SUAppcastItem *)item {
  (void)updater;
  (void)item;
  if (!self.completedExtraction || self.beganInstall) {
    [self fail:@"Sparkle install lifecycle is inconsistent"];
  }
  self.beganInstall = YES;
  [self emit:@"install_started" fields:@{}];
}

- (BOOL)updaterShouldRelaunchApplication:(SPUUpdater *)updater {
  (void)updater;
  return YES;
}

- (void)updaterWillRelaunchApplication:(SPUUpdater *)updater {
  (void)updater;
  if (!self.beganInstall || self.requestedRelaunch) {
    [self fail:@"Sparkle relaunch lifecycle is inconsistent"];
  }
  self.requestedRelaunch = YES;
  [self emit:@"relaunch_requested" fields:@{}];
}

- (void)updater:(SPUUpdater *)updater didAbortWithError:(NSError *)error {
  (void)updater;
  [self fail:[NSString stringWithFormat:@"Sparkle aborted: %@",
                                        error.localizedDescription]];
}

- (void)updater:(SPUUpdater *)updater
    didFinishUpdateCycleForUpdateCheck:(SPUUpdateCheck)updateCheck
                                 error:(NSError *)error {
  (void)updater;
  (void)updateCheck;
  if (error != nil) {
    [self fail:[NSString stringWithFormat:@"Sparkle update cycle failed: %@",
                                          error.localizedDescription]];
  }
}

@end

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    (void)argv;
    if (argc < 2) {
      fprintf(stderr, "Missing Sparkle canary arguments\n");
      return 64;
    }
    NSArray<NSString *> *arguments = NSProcessInfo.processInfo.arguments;
    NSString *appPath = HRAArgument(arguments, @"--app");
    NSString *feedValue = HRAArgument(arguments, @"--feed-url");
    NSString *enclosureValue = HRAArgument(arguments, @"--enclosure-url");
    NSString *tracePath = HRAArgument(arguments, @"--trace");
    NSString *ackPath = HRAArgument(arguments, @"--ack");
    NSString *ackToken = HRAArgument(arguments, @"--ack-token");
    NSString *version = HRAArgument(arguments, @"--version");
    NSString *build = HRAArgument(arguments, @"--build");
    NSString *lengthValue = HRAArgument(arguments, @"--length");
    NSString *deadlineValue = HRAArgument(arguments, @"--deadline-seconds");
    NSString *predecessorPIDValue = HRAArgument(arguments, @"--predecessor-pid");
    if (appPath == nil || feedValue == nil || enclosureValue == nil ||
        tracePath == nil || ackPath == nil || ackToken == nil ||
        version == nil || build == nil || lengthValue == nil ||
        deadlineValue == nil ||
        predecessorPIDValue == nil) {
      fprintf(stderr, "Incomplete Sparkle canary arguments\n");
      return 64;
    }

    NSScanner *lengthScanner = [NSScanner scannerWithString:lengthValue];
    unsigned long long length = 0;
    NSScanner *deadlineScanner = [NSScanner scannerWithString:deadlineValue];
    unsigned long long deadlineSeconds = 0;
    NSScanner *PIDScanner = [NSScanner scannerWithString:predecessorPIDValue];
    int PID = 0;
    if (![lengthScanner scanUnsignedLongLong:&length] ||
        !lengthScanner.isAtEnd || length == 0 ||
        ![deadlineScanner scanUnsignedLongLong:&deadlineSeconds] ||
        !deadlineScanner.isAtEnd ||
        deadlineSeconds < HRACanaryMinimumDeadlineSeconds ||
        deadlineSeconds > HRACanaryMaximumDeadlineSeconds ||
        ![PIDScanner scanInt:&PID] || !PIDScanner.isAtEnd || PID <= 1) {
      fprintf(stderr, "Invalid Sparkle canary numeric arguments\n");
      return 64;
    }

    NSURL *appURL = [NSURL fileURLWithPath:appPath isDirectory:YES];
    NSBundle *bundle = [NSBundle bundleWithURL:appURL];
    NSURL *feedURL = [NSURL URLWithString:feedValue];
    NSURL *enclosureURL = [NSURL URLWithString:enclosureValue];
    if (bundle == nil || feedURL == nil || enclosureURL == nil ||
        ![feedURL.scheme isEqualToString:@"http"] ||
        ![feedURL.host isEqualToString:@"127.0.0.1"] ||
        ![enclosureURL.scheme isEqualToString:@"https"]) {
      fprintf(stderr, "Invalid Sparkle canary bundle or URLs\n");
      return 64;
    }

    HRACanaryDriver *driver = [HRACanaryDriver new];
    driver.targetBundle = bundle;
    driver.targetBundleURL = appURL;
    driver.feedURL = feedURL;
    driver.expectedEnclosureURL = enclosureURL;
    driver.traceURL = [NSURL fileURLWithPath:tracePath];
    driver.ackURL = [NSURL fileURLWithPath:ackPath];
    driver.ackToken = ackToken;
    driver.expectedVersion = version;
    driver.expectedBuild = build;
    driver.expectedLength = length;
    driver.deadlineSeconds = (NSTimeInterval)deadlineSeconds;
    driver.predecessorPID = (pid_t)PID;
    driver.updater = [[SPUUpdater alloc] initWithHostBundle:bundle
                                         applicationBundle:bundle
                                                 userDriver:driver
                                                   delegate:driver];
    [driver begin];
    [NSRunLoop.mainRunLoop run];
  }
  return 1;
}
