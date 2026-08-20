#import "macos_image_normalizer.h"

#import <CommonCrypto/CommonDigest.h>
#import <CoreGraphics/CoreGraphics.h>
#import <Foundation/Foundation.h>
#import <ImageIO/ImageIO.h>
#import <dirent.h>
#import <errno.h>
#import <fcntl.h>
#import <limits.h>
#import <stdbool.h>
#import <stdint.h>
#import <stdio.h>
#import <stdlib.h>
#import <string.h>
#import <sys/stat.h>
#import <sys/stdio.h>
#import <unistd.h>

static const size_t HRAMaximumSourceBytes = 24u * 1024u * 1024u;
static const size_t HRAMaximumCanonicalBytes = 64u * 1024u * 1024u;
static const size_t HRAMaximumPreviewBytes = 512u * 1024u;
static const size_t HRAMaximumDimension = 8192u;
static const size_t HRAMaximumPixels = 16777216u;
static const size_t HRAMaximumPreviewDimension = 320u;

typedef NS_ENUM(int, HRAImageNormalizerStatus) {
  HRAImageNormalizerSuccess = 0,
  HRAImageNormalizerInvalidProtocol = 64,
  HRAImageNormalizerInvalidPath = 65,
  HRAImageNormalizerUnsafeInput = 66,
  HRAImageNormalizerUnsupportedImage = 67,
  HRAImageNormalizerImageBoundsExceeded = 68,
  HRAImageNormalizerEncodingFailed = 69,
  HRAImageNormalizerUnsafeOutput = 70,
  HRAImageNormalizerFilesystemRace = 71,
};

typedef struct {
  int parentDescriptor;
  char name[NAME_MAX + 1];
} HRAPathAnchor;

typedef struct {
  HRAPathAnchor finalAnchor;
  char temporaryName[NAME_MAX + 1];
  int directoryDescriptor;
  int canonicalDescriptor;
  int previewDescriptor;
  struct stat directoryIdentity;
  struct stat canonicalIdentity;
  struct stat previewIdentity;
  bool temporaryCreated;
  bool renamed;
} HRAOutputGeneration;

typedef NS_ENUM(NSUInteger, HRAImageFormat) {
  HRAImageFormatUnknown = 0,
  HRAImageFormatPNG = 1,
  HRAImageFormatJPEG = 2,
  HRAImageFormatHEIC = 3,
  HRAImageFormatWebP = 4,
};

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

// ImageIO and CoreGraphics may write host-driver diagnostics directly to the
// inherited standard error descriptor. The helper protocol reserves stderr
// for one exact, path-free HRA receipt, so keep a private receipt descriptor
// and route framework-owned output to the system null device until exit.
static int HRAIsolateFrameworkStandardError(void) {
  if (fflush(stderr) != 0) return -1;

  int receiptDescriptor;
  do {
    receiptDescriptor = fcntl(STDERR_FILENO, F_DUPFD_CLOEXEC, 3);
  } while (receiptDescriptor < 0 && errno == EINTR);
  if (receiptDescriptor < 0) return -1;

  int sinkDescriptor;
  do {
    sinkDescriptor = open(
        "/dev/null",
        O_WRONLY | O_CLOEXEC | O_NOFOLLOW);
  } while (sinkDescriptor < 0 && errno == EINTR);
  if (sinkDescriptor < 0) {
    close(receiptDescriptor);
    return -1;
  }

  struct stat sinkIdentity;
  if (fstat(sinkDescriptor, &sinkIdentity) != 0 ||
      !S_ISCHR(sinkIdentity.st_mode)) {
    close(sinkDescriptor);
    close(receiptDescriptor);
    return -1;
  }

  int redirected;
  do {
    redirected = dup2(sinkDescriptor, STDERR_FILENO);
  } while (redirected < 0 && errno == EINTR);
  close(sinkDescriptor);
  if (redirected < 0) {
    close(receiptDescriptor);
    return -1;
  }
  clearerr(stderr);
  return receiptDescriptor;
}

static void HRAWriteErrorReceipt(int descriptor, int status) {
  char receipt[64];
  int length = snprintf(
      receipt,
      sizeof(receipt),
      "hra-image-normalizer:error:%d\n",
      status);
  if (length <= 0 || (size_t)length >= sizeof(receipt)) return;
  HRAWriteAll(descriptor, (const uint8_t *)receipt, (size_t)length);
}

static bool HRAStatIdentityMatches(
    const struct stat *left,
    const struct stat *right) {
  return left->st_dev == right->st_dev &&
      left->st_ino == right->st_ino &&
      left->st_mode == right->st_mode &&
      left->st_nlink == right->st_nlink &&
      left->st_size == right->st_size &&
      left->st_mtimespec.tv_sec == right->st_mtimespec.tv_sec &&
      left->st_mtimespec.tv_nsec == right->st_mtimespec.tv_nsec &&
      left->st_ctimespec.tv_sec == right->st_ctimespec.tv_sec &&
      left->st_ctimespec.tv_nsec == right->st_ctimespec.tv_nsec;
}

static bool HRAPathComponentIsSafe(const char *component) {
  size_t length = strlen(component);
  return length > 0 && length <= NAME_MAX &&
      strcmp(component, ".") != 0 && strcmp(component, "..") != 0;
}

static bool HRAOpenPathAnchor(
    const char *path,
    size_t pathLength,
    HRAPathAnchor *anchor) {
  if (path == NULL || anchor == NULL || pathLength < 2 ||
      pathLength > PATH_MAX || path[0] != '/' || path[pathLength - 1] == '/' ||
      strnlen(path, pathLength + 1) != pathLength) {
    return false;
  }
  char copy[PATH_MAX + 1];
  memcpy(copy, path, pathLength);
  copy[pathLength] = '\0';
  if (strstr(copy, "//") != NULL) return false;

  int current = open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  if (current < 0) return false;
  char *component = copy + 1;
  while (true) {
    char *slash = strchr(component, '/');
    if (slash == NULL) break;
    *slash = '\0';
    if (!HRAPathComponentIsSafe(component)) {
      close(current);
      return false;
    }
    struct stat before;
    struct stat after;
    if (fstatat(current, component, &before, AT_SYMLINK_NOFOLLOW) != 0 ||
        !S_ISDIR(before.st_mode)) {
      close(current);
      return false;
    }
    int next = openat(
        current,
        component,
        O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    if (next < 0 || fstat(next, &after) != 0 ||
        before.st_dev != after.st_dev || before.st_ino != after.st_ino ||
        !S_ISDIR(after.st_mode)) {
      if (next >= 0) close(next);
      close(current);
      return false;
    }
    close(current);
    current = next;
    component = slash + 1;
  }
  if (!HRAPathComponentIsSafe(component)) {
    close(current);
    return false;
  }
  size_t nameLength = strlen(component);
  memcpy(anchor->name, component, nameLength + 1);
  anchor->parentDescriptor = current;
  return true;
}

static void HRAClosePathAnchor(HRAPathAnchor *anchor) {
  if (anchor != NULL && anchor->parentDescriptor >= 0) {
    close(anchor->parentDescriptor);
    anchor->parentDescriptor = -1;
  }
}

static bool HRAOpenRegularInput(
    const char *path,
    size_t pathLength,
    int *descriptor,
    struct stat *identity) {
  HRAPathAnchor anchor = {.parentDescriptor = -1};
  if (!HRAOpenPathAnchor(path, pathLength, &anchor)) return false;
  struct stat directoryIdentity;
  struct stat entryIdentity;
  bool safe = fstat(anchor.parentDescriptor, &directoryIdentity) == 0 &&
      fstatat(
          anchor.parentDescriptor,
          anchor.name,
          &entryIdentity,
          AT_SYMLINK_NOFOLLOW) == 0 &&
      S_ISREG(entryIdentity.st_mode) && entryIdentity.st_nlink == 1 &&
      entryIdentity.st_dev == directoryIdentity.st_dev &&
      entryIdentity.st_size > 0 &&
      (uint64_t)entryIdentity.st_size <= HRAMaximumSourceBytes;
  int opened = safe
      ? openat(
            anchor.parentDescriptor,
            anchor.name,
            O_RDONLY | O_NONBLOCK | O_CLOEXEC | O_NOFOLLOW)
      : -1;
  struct stat openedIdentity;
  safe = opened >= 0 && fstat(opened, &openedIdentity) == 0 &&
      HRAStatIdentityMatches(&entryIdentity, &openedIdentity) &&
      S_ISREG(openedIdentity.st_mode) && openedIdentity.st_nlink == 1;
  if (safe) {
    int flags = fcntl(opened, F_GETFL);
    safe = flags >= 0 && fcntl(opened, F_SETFL, flags & ~O_NONBLOCK) == 0;
  }
  HRAClosePathAnchor(&anchor);
  if (!safe) {
    if (opened >= 0) close(opened);
    return false;
  }
  *descriptor = opened;
  *identity = openedIdentity;
  return true;
}

static bool HRAReopenPathMatches(
    const char *path,
    size_t pathLength,
    const struct stat *expected,
    bool requireSingleLink) {
  HRAPathAnchor anchor = {.parentDescriptor = -1};
  if (!HRAOpenPathAnchor(path, pathLength, &anchor)) return false;
  struct stat entry;
  int descriptor = -1;
  bool matches = fstatat(
          anchor.parentDescriptor,
          anchor.name,
          &entry,
          AT_SYMLINK_NOFOLLOW) == 0 &&
      S_ISREG(entry.st_mode) &&
      (!requireSingleLink || entry.st_nlink == 1);
  if (matches) {
    descriptor = openat(
        anchor.parentDescriptor,
        anchor.name,
        O_RDONLY | O_NONBLOCK | O_CLOEXEC | O_NOFOLLOW);
    struct stat opened;
    matches = descriptor >= 0 && fstat(descriptor, &opened) == 0 &&
        HRAStatIdentityMatches(&entry, &opened) &&
        HRAStatIdentityMatches(expected, &opened);
  }
  if (descriptor >= 0) close(descriptor);
  HRAClosePathAnchor(&anchor);
  return matches;
}

static NSData *_Nullable HRAReadInput(
    int descriptor,
    const struct stat *identity) {
  size_t length = (size_t)identity->st_size;
  uint8_t *bytes = malloc(length);
  if (bytes == NULL) return nil;
  size_t offset = 0;
  while (offset < length) {
    ssize_t count = pread(descriptor, bytes + offset, length - offset, (off_t)offset);
    if (count > 0) {
      offset += (size_t)count;
      continue;
    }
    if (count < 0 && errno == EINTR) continue;
    free(bytes);
    return nil;
  }
  uint8_t extra = 0;
  ssize_t extraCount = pread(descriptor, &extra, 1, (off_t)length);
  struct stat after;
  if (extraCount != 0 || fstat(descriptor, &after) != 0 ||
      !HRAStatIdentityMatches(identity, &after)) {
    free(bytes);
    return nil;
  }
  return [NSData dataWithBytesNoCopy:bytes length:length freeWhenDone:YES];
}

static uint32_t HRAReadBigEndian32(const uint8_t *bytes) {
  return ((uint32_t)bytes[0] << 24) | ((uint32_t)bytes[1] << 16) |
      ((uint32_t)bytes[2] << 8) | (uint32_t)bytes[3];
}

static uint64_t HRAReadBigEndian64(const uint8_t *bytes) {
  return ((uint64_t)HRAReadBigEndian32(bytes) << 32) |
      (uint64_t)HRAReadBigEndian32(bytes + 4);
}

static uint32_t HRAReadLittleEndian32(const uint8_t *bytes) {
  return (uint32_t)bytes[0] | ((uint32_t)bytes[1] << 8) |
      ((uint32_t)bytes[2] << 16) | ((uint32_t)bytes[3] << 24);
}

static uint32_t HRAPNGCRC32(const uint8_t *bytes, size_t length) {
  static uint32_t table[256];
  static bool initialized = false;
  if (!initialized) {
    for (uint32_t value = 0; value < 256; value += 1) {
      uint32_t entry = value;
      for (unsigned bit = 0; bit < 8; bit += 1) {
        uint32_t mask = (uint32_t)-(int32_t)(entry & 1u);
        entry = (entry >> 1) ^ (0xedb88320u & mask);
      }
      table[value] = entry;
    }
    initialized = true;
  }
  uint32_t crc = UINT32_MAX;
  for (size_t index = 0; index < length; index += 1) {
    crc = table[(crc ^ bytes[index]) & 0xffu] ^ (crc >> 8);
  }
  return ~crc;
}

static bool HRAValidatePNG(const uint8_t *bytes, size_t length) {
  static const uint8_t signature[] = {137, 80, 78, 71, 13, 10, 26, 10};
  if (length < sizeof(signature) + 12 ||
      memcmp(bytes, signature, sizeof(signature)) != 0) return false;
  size_t offset = sizeof(signature);
  bool sawHeader = false;
  bool sawImageData = false;
  bool sawEnd = false;
  while (offset <= length - 12) {
    uint32_t chunkLength = HRAReadBigEndian32(bytes + offset);
    if ((uint64_t)chunkLength + 12u > length - offset) return false;
    const uint8_t *type = bytes + offset + 4;
    const uint8_t *data = type + 4;
    uint32_t expectedCRC = HRAReadBigEndian32(data + chunkLength);
    if (HRAPNGCRC32(type, (size_t)chunkLength + 4) != expectedCRC) return false;
    if (!sawHeader) {
      if (memcmp(type, "IHDR", 4) != 0 || chunkLength != 13) return false;
      sawHeader = true;
    } else if (memcmp(type, "IHDR", 4) == 0) {
      return false;
    }
    if (memcmp(type, "IDAT", 4) == 0) sawImageData = true;
    if (memcmp(type, "acTL", 4) == 0 || memcmp(type, "fcTL", 4) == 0 ||
        memcmp(type, "fdAT", 4) == 0) return false;
    offset += (size_t)chunkLength + 12;
    if (memcmp(type, "IEND", 4) == 0) {
      if (chunkLength != 0 || !sawImageData || offset != length) return false;
      sawEnd = true;
      break;
    }
  }
  return sawHeader && sawImageData && sawEnd;
}

static bool HRAValidateJPEG(const uint8_t *bytes, size_t length) {
  return length >= 4 && bytes[0] == 0xff && bytes[1] == 0xd8 &&
      bytes[length - 2] == 0xff && bytes[length - 1] == 0xd9;
}

static bool HRAFourCCEquals(const uint8_t *bytes, const char *value) {
  return memcmp(bytes, value, 4) == 0;
}

static bool HRAValidateHEIC(const uint8_t *bytes, size_t length) {
  if (length < 16) return false;
  size_t offset = 0;
  bool sawFileType = false;
  bool sawHEICBrand = false;
  while (offset < length) {
    if (length - offset < 8) return false;
    uint64_t boxLength = HRAReadBigEndian32(bytes + offset);
    size_t headerLength = 8;
    if (boxLength == 1) {
      if (length - offset < 16) return false;
      boxLength = HRAReadBigEndian64(bytes + offset + 8);
      headerLength = 16;
    } else if (boxLength == 0) {
      boxLength = length - offset;
    }
    if (boxLength < headerLength || boxLength > length - offset) return false;
    const uint8_t *type = bytes + offset + 4;
    if (offset == 0) {
      if (!HRAFourCCEquals(type, "ftyp") || boxLength < headerLength + 8) {
        return false;
      }
      sawFileType = true;
      const uint8_t *brands = bytes + offset + headerLength;
      size_t brandsLength = (size_t)boxLength - headerLength;
      if (brandsLength < 8 || (brandsLength - 8) % 4 != 0) return false;
      for (size_t brandOffset = 0; brandOffset < brandsLength; brandOffset += 4) {
        if (brandOffset == 4) continue;
        const uint8_t *brand = brands + brandOffset;
        if (HRAFourCCEquals(brand, "avif") || HRAFourCCEquals(brand, "avis")) {
          return false;
        }
        if (HRAFourCCEquals(brand, "heic") || HRAFourCCEquals(brand, "heix") ||
            HRAFourCCEquals(brand, "hevc") || HRAFourCCEquals(brand, "hevx")) {
          sawHEICBrand = true;
        }
      }
    }
    offset += (size_t)boxLength;
  }
  return sawFileType && sawHEICBrand && offset == length;
}

static bool HRAValidateWebP(const uint8_t *bytes, size_t length) {
  if (length < 20 || !HRAFourCCEquals(bytes, "RIFF") ||
      !HRAFourCCEquals(bytes + 8, "WEBP") ||
      (uint64_t)HRAReadLittleEndian32(bytes + 4) + 8u != length) return false;
  size_t offset = 12;
  NSUInteger imageChunkCount = 0;
  while (offset < length) {
    if (length - offset < 8) return false;
    const uint8_t *type = bytes + offset;
    uint32_t chunkLength = HRAReadLittleEndian32(bytes + offset + 4);
    uint64_t paddedLength = (uint64_t)chunkLength + (chunkLength & 1u);
    if (paddedLength + 8u > length - offset) return false;
    const uint8_t *data = bytes + offset + 8;
    if (HRAFourCCEquals(type, "ANIM") || HRAFourCCEquals(type, "ANMF")) {
      return false;
    }
    if (HRAFourCCEquals(type, "VP8X") &&
        (chunkLength != 10 || (data[0] & 0x02u) != 0)) return false;
    if (HRAFourCCEquals(type, "VP8 ") || HRAFourCCEquals(type, "VP8L")) {
      imageChunkCount += 1;
    }
    offset += 8 + (size_t)paddedLength;
  }
  return offset == length && imageChunkCount == 1;
}

static HRAImageFormat HRAValidateImageContainer(NSData *data) {
  const uint8_t *bytes = data.bytes;
  size_t length = data.length;
  if (HRAValidatePNG(bytes, length)) return HRAImageFormatPNG;
  if (HRAValidateJPEG(bytes, length)) return HRAImageFormatJPEG;
  if (HRAValidateHEIC(bytes, length)) return HRAImageFormatHEIC;
  if (HRAValidateWebP(bytes, length)) return HRAImageFormatWebP;
  return HRAImageFormatUnknown;
}

static CFStringRef HRAExpectedImageType(HRAImageFormat format) {
  switch (format) {
    case HRAImageFormatPNG: return CFSTR("public.png");
    case HRAImageFormatJPEG: return CFSTR("public.jpeg");
    case HRAImageFormatHEIC: return CFSTR("public.heic");
    case HRAImageFormatWebP: return CFSTR("org.webmproject.webp");
    case HRAImageFormatUnknown: return NULL;
  }
}

static const char *HRAImageMediaType(HRAImageFormat format) {
  switch (format) {
    case HRAImageFormatPNG: return "image/png";
    case HRAImageFormatJPEG: return "image/jpeg";
    case HRAImageFormatHEIC: return "image/heic";
    case HRAImageFormatWebP: return "image/webp";
    case HRAImageFormatUnknown: return "";
  }
}

static CGImageRef _Nullable HRACreateRenderedSRGBImage(
    CGImageRef source,
    size_t width,
    size_t height,
    CGInterpolationQuality interpolation) {
  if (source == NULL || width == 0 || height == 0 ||
      width > SIZE_MAX / 4 || height > SIZE_MAX / (width * 4)) return NULL;
  CGColorSpaceRef colorSpace = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
  if (colorSpace == NULL) return NULL;
  CGContextRef context = CGBitmapContextCreate(
      NULL,
      width,
      height,
      8,
      width * 4,
      colorSpace,
      kCGImageAlphaPremultipliedLast | kCGBitmapByteOrder32Big);
  CGColorSpaceRelease(colorSpace);
  if (context == NULL) return NULL;
  CGContextSetBlendMode(context, kCGBlendModeCopy);
  CGContextSetInterpolationQuality(context, interpolation);
  CGContextDrawImage(context, CGRectMake(0, 0, width, height), source);
  CGImageRef rendered = CGBitmapContextCreateImage(context);
  CGContextRelease(context);
  return rendered;
}

static NSData *_Nullable HRAEncodePNG(CGImageRef image) {
  NSMutableData *data = [NSMutableData data];
  CGImageDestinationRef destination = CGImageDestinationCreateWithData(
      (__bridge CFMutableDataRef)data,
      CFSTR("public.png"),
      1,
      NULL);
  if (destination == NULL) return nil;
  CGImageDestinationAddImage(
      destination,
      image,
      (__bridge CFDictionaryRef)@{});
  bool finalized = CGImageDestinationFinalize(destination);
  CFRelease(destination);
  return finalized ? [data copy] : nil;
}

static void HRASHA256(NSData *data, char output[CC_SHA256_DIGEST_LENGTH * 2 + 1]) {
  unsigned char digest[CC_SHA256_DIGEST_LENGTH];
  CC_SHA256(data.bytes, (CC_LONG)data.length, digest);
  static const char hexadecimal[] = "0123456789abcdef";
  for (size_t index = 0; index < CC_SHA256_DIGEST_LENGTH; index += 1) {
    output[index * 2] = hexadecimal[digest[index] >> 4];
    output[index * 2 + 1] = hexadecimal[digest[index] & 0x0f];
  }
  output[CC_SHA256_DIGEST_LENGTH * 2] = '\0';
}

static void HRAInitializeOutputGeneration(HRAOutputGeneration *generation) {
  memset(generation, 0, sizeof(*generation));
  generation->finalAnchor.parentDescriptor = -1;
  generation->directoryDescriptor = -1;
  generation->canonicalDescriptor = -1;
  generation->previewDescriptor = -1;
}

static bool HRAOpenRelativeRegularFileMatches(
    int directoryDescriptor,
    const char *name,
    const struct stat *expected) {
  struct stat entry;
  if (fstatat(directoryDescriptor, name, &entry, AT_SYMLINK_NOFOLLOW) != 0 ||
      !S_ISREG(entry.st_mode) || entry.st_nlink != 1 ||
      !HRAStatIdentityMatches(expected, &entry)) return false;
  int descriptor = openat(
      directoryDescriptor,
      name,
      O_RDONLY | O_NONBLOCK | O_CLOEXEC | O_NOFOLLOW);
  struct stat opened;
  bool matches = descriptor >= 0 && fstat(descriptor, &opened) == 0 &&
      HRAStatIdentityMatches(&entry, &opened);
  if (descriptor >= 0) close(descriptor);
  return matches;
}

static bool HRAGenerationDirectoryHasExactEntries(int descriptor) {
  int duplicate = dup(descriptor);
  if (duplicate < 0) return false;
  DIR *directory = fdopendir(duplicate);
  if (directory == NULL) {
    close(duplicate);
    return false;
  }
  bool sawCanonical = false;
  bool sawPreview = false;
  bool exact = true;
  errno = 0;
  while (true) {
    struct dirent *entry = readdir(directory);
    if (entry == NULL) break;
    if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) {
      continue;
    }
    if (strcmp(entry->d_name, "canonical.png") == 0 && !sawCanonical) {
      sawCanonical = true;
    } else if (strcmp(entry->d_name, "preview.png") == 0 && !sawPreview) {
      sawPreview = true;
    } else {
      exact = false;
      break;
    }
  }
  if (errno != 0) exact = false;
  closedir(directory);
  return exact && sawCanonical && sawPreview;
}

static bool HRACreateOutputGeneration(
    const char *path,
    size_t pathLength,
    HRAOutputGeneration *generation) {
  if (!HRAOpenPathAnchor(path, pathLength, &generation->finalAnchor) ||
      strncmp(
          generation->finalAnchor.name,
          ".hra-image-normalizer-",
          strlen(".hra-image-normalizer-")) == 0) return false;
  struct stat existing;
  if (fstatat(
          generation->finalAnchor.parentDescriptor,
          generation->finalAnchor.name,
          &existing,
          AT_SYMLINK_NOFOLLOW) == 0 || errno != ENOENT) return false;

  bool created = false;
  for (NSUInteger attempt = 0; attempt < 16 && !created; attempt += 1) {
    uint8_t randomBytes[16];
    arc4random_buf(randomBytes, sizeof(randomBytes));
    static const char hexadecimal[] = "0123456789abcdef";
    const char *prefix = ".hra-image-normalizer-";
    size_t prefixLength = strlen(prefix);
    memcpy(generation->temporaryName, prefix, prefixLength);
    for (size_t index = 0; index < sizeof(randomBytes); index += 1) {
      generation->temporaryName[prefixLength + index * 2] =
          hexadecimal[randomBytes[index] >> 4];
      generation->temporaryName[prefixLength + index * 2 + 1] =
          hexadecimal[randomBytes[index] & 0x0f];
    }
    memcpy(
        generation->temporaryName + prefixLength + sizeof(randomBytes) * 2,
        ".tmp",
        5);
    if (mkdirat(
            generation->finalAnchor.parentDescriptor,
            generation->temporaryName,
            0700) == 0) {
      created = true;
    } else if (errno != EEXIST) {
      return false;
    }
  }
  if (!created) return false;
  generation->temporaryCreated = true;
  struct stat entryIdentity;
  generation->directoryDescriptor = openat(
      generation->finalAnchor.parentDescriptor,
      generation->temporaryName,
      O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  struct stat parentIdentity;
  bool safe = generation->directoryDescriptor >= 0 &&
      fstatat(
          generation->finalAnchor.parentDescriptor,
          generation->temporaryName,
          &entryIdentity,
          AT_SYMLINK_NOFOLLOW) == 0 &&
      fstat(generation->directoryDescriptor, &generation->directoryIdentity) == 0 &&
      fstat(generation->finalAnchor.parentDescriptor, &parentIdentity) == 0 &&
      S_ISDIR(entryIdentity.st_mode) &&
      S_ISDIR(parentIdentity.st_mode) &&
      entryIdentity.st_dev == generation->directoryIdentity.st_dev &&
      entryIdentity.st_ino == generation->directoryIdentity.st_ino &&
      entryIdentity.st_dev == parentIdentity.st_dev &&
      entryIdentity.st_uid == geteuid() &&
      generation->directoryIdentity.st_uid == geteuid() &&
      parentIdentity.st_uid == geteuid() &&
      (parentIdentity.st_mode & 0022) == 0 &&
      fchmod(generation->directoryDescriptor, 0700) == 0;
  return safe;
}

static bool HRACreateGenerationFile(
    HRAOutputGeneration *generation,
    const char *name,
    int *descriptor,
    struct stat *identity) {
  struct stat existing;
  if (fstatat(
          generation->directoryDescriptor,
          name,
          &existing,
          AT_SYMLINK_NOFOLLOW) == 0 || errno != ENOENT) return false;
  *descriptor = openat(
      generation->directoryDescriptor,
      name,
      O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW,
      0600);
  if (*descriptor < 0 || fstat(*descriptor, identity) != 0) return false;
  return S_ISREG(identity->st_mode) && identity->st_nlink == 1 &&
      identity->st_dev == generation->directoryIdentity.st_dev &&
      identity->st_uid == geteuid();
}

static bool HRAWriteAndSealGenerationFile(
    int descriptor,
    struct stat *identity,
    NSData *data) {
  if (descriptor < 0 || !HRAWriteAll(descriptor, data.bytes, data.length) ||
      fchmod(descriptor, 0600) != 0 || fsync(descriptor) != 0) return false;
  struct stat after;
  if (fstat(descriptor, &after) != 0 || !S_ISREG(after.st_mode) ||
      after.st_nlink != 1 || after.st_dev != identity->st_dev ||
      after.st_ino != identity->st_ino || after.st_size != (off_t)data.length) {
    return false;
  }
  *identity = after;
  return true;
}

static bool HRAVerifyPublishedGeneration(
    const char *path,
    size_t pathLength,
    HRAOutputGeneration *generation) {
  HRAPathAnchor anchor = {.parentDescriptor = -1};
  if (!HRAOpenPathAnchor(path, pathLength, &anchor)) return false;
  struct stat expectedParent;
  struct stat actualParent;
  struct stat entry;
  struct stat opened;
  bool matches = fstat(generation->finalAnchor.parentDescriptor, &expectedParent) == 0 &&
      fstat(anchor.parentDescriptor, &actualParent) == 0 &&
      expectedParent.st_dev == actualParent.st_dev &&
      expectedParent.st_ino == actualParent.st_ino &&
      strcmp(anchor.name, generation->finalAnchor.name) == 0 &&
      fstatat(anchor.parentDescriptor, anchor.name, &entry, AT_SYMLINK_NOFOLLOW) == 0 &&
      S_ISDIR(entry.st_mode);
  int directoryDescriptor = matches
      ? openat(
            anchor.parentDescriptor,
            anchor.name,
            O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW)
      : -1;
  matches = directoryDescriptor >= 0 && fstat(directoryDescriptor, &opened) == 0 &&
      entry.st_dev == opened.st_dev && entry.st_ino == opened.st_ino &&
      opened.st_dev == generation->directoryIdentity.st_dev &&
      opened.st_ino == generation->directoryIdentity.st_ino &&
      opened.st_uid == geteuid() && (opened.st_mode & 0777) == 0700 &&
      HRAGenerationDirectoryHasExactEntries(directoryDescriptor) &&
      HRAOpenRelativeRegularFileMatches(
          directoryDescriptor,
          "canonical.png",
          &generation->canonicalIdentity) &&
      HRAOpenRelativeRegularFileMatches(
          directoryDescriptor,
          "preview.png",
          &generation->previewIdentity);
  if (directoryDescriptor >= 0) close(directoryDescriptor);
  HRAClosePathAnchor(&anchor);
  return matches;
}

static bool HRAPublishOutputGeneration(
    const char *path,
    size_t pathLength,
    HRAOutputGeneration *generation) {
  if (!HRAGenerationDirectoryHasExactEntries(generation->directoryDescriptor) ||
      !HRAOpenRelativeRegularFileMatches(
          generation->directoryDescriptor,
          "canonical.png",
          &generation->canonicalIdentity) ||
      !HRAOpenRelativeRegularFileMatches(
          generation->directoryDescriptor,
          "preview.png",
          &generation->previewIdentity) ||
      fsync(generation->directoryDescriptor) != 0 ||
      renameatx_np(
          generation->finalAnchor.parentDescriptor,
          generation->temporaryName,
          generation->finalAnchor.parentDescriptor,
          generation->finalAnchor.name,
          RENAME_EXCL) != 0) return false;
  generation->temporaryCreated = false;
  generation->renamed = true;
  return fsync(generation->finalAnchor.parentDescriptor) == 0 &&
      HRAVerifyPublishedGeneration(path, pathLength, generation);
}

static void HRARemoveOutputGeneration(HRAOutputGeneration *generation) {
  if (generation == NULL) return;
  if (generation->canonicalDescriptor >= 0) {
    close(generation->canonicalDescriptor);
    generation->canonicalDescriptor = -1;
  }
  if (generation->previewDescriptor >= 0) {
    close(generation->previewDescriptor);
    generation->previewDescriptor = -1;
  }
  if (generation->directoryDescriptor >= 0) {
    (void)unlinkat(generation->directoryDescriptor, "preview.png", 0);
    (void)unlinkat(generation->directoryDescriptor, "canonical.png", 0);
    (void)fsync(generation->directoryDescriptor);
    close(generation->directoryDescriptor);
    generation->directoryDescriptor = -1;
  }
  if (generation->finalAnchor.parentDescriptor >= 0 &&
      (generation->temporaryCreated || generation->renamed)) {
    const char *name = generation->renamed
        ? generation->finalAnchor.name
        : generation->temporaryName;
    struct stat current;
    if (fstatat(
            generation->finalAnchor.parentDescriptor,
            name,
            &current,
            AT_SYMLINK_NOFOLLOW) == 0 &&
        S_ISDIR(current.st_mode) &&
        current.st_dev == generation->directoryIdentity.st_dev &&
        current.st_ino == generation->directoryIdentity.st_ino) {
      (void)unlinkat(
          generation->finalAnchor.parentDescriptor,
          name,
          AT_REMOVEDIR);
    }
    (void)fsync(generation->finalAnchor.parentDescriptor);
  }
  HRAClosePathAnchor(&generation->finalAnchor);
  generation->temporaryCreated = false;
  generation->renamed = false;
}

static void HRACloseSuccessfulOutputGeneration(HRAOutputGeneration *generation) {
  if (generation->canonicalDescriptor >= 0) {
    close(generation->canonicalDescriptor);
    generation->canonicalDescriptor = -1;
  }
  if (generation->previewDescriptor >= 0) {
    close(generation->previewDescriptor);
    generation->previewDescriptor = -1;
  }
  if (generation->directoryDescriptor >= 0) {
    close(generation->directoryDescriptor);
    generation->directoryDescriptor = -1;
  }
  HRAClosePathAnchor(&generation->finalAnchor);
  generation->renamed = false;
}

static int HRANormalizeImage(
    const char *inputPath,
    size_t inputPathLength,
    const char *outputDirectoryPath,
    size_t outputDirectoryPathLength) {
  if (inputPathLength == outputDirectoryPathLength &&
      memcmp(inputPath, outputDirectoryPath, inputPathLength) == 0) {
    return HRAImageNormalizerInvalidPath;
  }

  int inputDescriptor = -1;
  struct stat inputIdentity;
  if (!HRAOpenRegularInput(
          inputPath,
          inputPathLength,
          &inputDescriptor,
          &inputIdentity)) {
    return HRAImageNormalizerUnsafeInput;
  }
  NSData *sourceData = HRAReadInput(inputDescriptor, &inputIdentity);
  if (sourceData == nil || !HRAReopenPathMatches(
          inputPath,
          inputPathLength,
          &inputIdentity,
          true)) {
    close(inputDescriptor);
    return HRAImageNormalizerFilesystemRace;
  }

  HRAImageFormat format = HRAValidateImageContainer(sourceData);
  if (format == HRAImageFormatUnknown) {
    close(inputDescriptor);
    return HRAImageNormalizerUnsupportedImage;
  }
  CGImageSourceRef source = CGImageSourceCreateWithData(
      (__bridge CFDataRef)sourceData,
      NULL);
  if (source == NULL || CGImageSourceGetCount(source) != 1 ||
      !CFEqual(CGImageSourceGetType(source), HRAExpectedImageType(format))) {
    if (source != NULL) CFRelease(source);
    close(inputDescriptor);
    return HRAImageNormalizerUnsupportedImage;
  }
  NSDictionary *properties = CFBridgingRelease(
      CGImageSourceCopyPropertiesAtIndex(source, 0, NULL));
  NSNumber *rawWidth = properties[(__bridge NSString *)kCGImagePropertyPixelWidth];
  NSNumber *rawHeight = properties[(__bridge NSString *)kCGImagePropertyPixelHeight];
  unsigned long long sourceWidth = rawWidth.unsignedLongLongValue;
  unsigned long long sourceHeight = rawHeight.unsignedLongLongValue;
  if (rawWidth == nil || rawHeight == nil || sourceWidth == 0 || sourceHeight == 0 ||
      sourceWidth > HRAMaximumDimension || sourceHeight > HRAMaximumDimension ||
      sourceWidth > HRAMaximumPixels / sourceHeight) {
    CFRelease(source);
    close(inputDescriptor);
    return HRAImageNormalizerImageBoundsExceeded;
  }

  NSDictionary *thumbnailOptions = @{
    (__bridge NSString *)kCGImageSourceCreateThumbnailFromImageAlways: @YES,
    (__bridge NSString *)kCGImageSourceCreateThumbnailWithTransform: @YES,
    (__bridge NSString *)kCGImageSourceShouldCacheImmediately: @YES,
    (__bridge NSString *)kCGImageSourceThumbnailMaxPixelSize:
        @(MAX(sourceWidth, sourceHeight)),
  };
  CGImageRef oriented = CGImageSourceCreateThumbnailAtIndex(
      source,
      0,
      (__bridge CFDictionaryRef)thumbnailOptions);
  CFRelease(source);
  if (oriented == NULL) {
    close(inputDescriptor);
    return HRAImageNormalizerUnsupportedImage;
  }
  size_t width = CGImageGetWidth(oriented);
  size_t height = CGImageGetHeight(oriented);
  if (width == 0 || height == 0 || width > HRAMaximumDimension ||
      height > HRAMaximumDimension || width > HRAMaximumPixels / height) {
    CGImageRelease(oriented);
    close(inputDescriptor);
    return HRAImageNormalizerImageBoundsExceeded;
  }
  CGImageRef canonicalImage = HRACreateRenderedSRGBImage(
      oriented,
      width,
      height,
      kCGInterpolationNone);
  CGImageRelease(oriented);
  if (canonicalImage == NULL) {
    close(inputDescriptor);
    return HRAImageNormalizerEncodingFailed;
  }
  NSData *canonicalData = HRAEncodePNG(canonicalImage);

  size_t longestEdge = MAX(width, height);
  size_t previewWidth = width;
  size_t previewHeight = height;
  if (longestEdge > HRAMaximumPreviewDimension) {
    previewWidth = MAX(
        1u,
        (width * HRAMaximumPreviewDimension + longestEdge / 2) / longestEdge);
    previewHeight = MAX(
        1u,
        (height * HRAMaximumPreviewDimension + longestEdge / 2) / longestEdge);
  }
  CGImageRef previewImage = HRACreateRenderedSRGBImage(
      canonicalImage,
      previewWidth,
      previewHeight,
      kCGInterpolationHigh);
  CGImageRelease(canonicalImage);
  NSData *previewData = previewImage == NULL ? nil : HRAEncodePNG(previewImage);
  if (previewImage != NULL) CGImageRelease(previewImage);
  if (canonicalData == nil || previewData == nil ||
      canonicalData.length == 0 || previewData.length == 0 ||
      canonicalData.length > HRAMaximumCanonicalBytes ||
      previewData.length > HRAMaximumPreviewBytes) {
    close(inputDescriptor);
    return HRAImageNormalizerEncodingFailed;
  }
  if (!HRAReopenPathMatches(
          inputPath,
          inputPathLength,
          &inputIdentity,
          true)) {
    close(inputDescriptor);
    return HRAImageNormalizerFilesystemRace;
  }

  HRAOutputGeneration generation;
  HRAInitializeOutputGeneration(&generation);
  bool published = HRACreateOutputGeneration(
          outputDirectoryPath,
          outputDirectoryPathLength,
          &generation) &&
      HRACreateGenerationFile(
          &generation,
          "canonical.png",
          &generation.canonicalDescriptor,
          &generation.canonicalIdentity) &&
      HRACreateGenerationFile(
          &generation,
          "preview.png",
          &generation.previewDescriptor,
          &generation.previewIdentity) &&
      HRAWriteAndSealGenerationFile(
          generation.canonicalDescriptor,
          &generation.canonicalIdentity,
          canonicalData) &&
      HRAWriteAndSealGenerationFile(
          generation.previewDescriptor,
          &generation.previewIdentity,
          previewData) &&
      HRAReopenPathMatches(
          inputPath,
          inputPathLength,
          &inputIdentity,
          true) &&
      HRAPublishOutputGeneration(
          outputDirectoryPath,
          outputDirectoryPathLength,
          &generation);
  close(inputDescriptor);
  if (!published) {
    HRARemoveOutputGeneration(&generation);
    return HRAImageNormalizerUnsafeOutput;
  }

  char canonicalDigest[CC_SHA256_DIGEST_LENGTH * 2 + 1];
  char previewDigest[CC_SHA256_DIGEST_LENGTH * 2 + 1];
  HRASHA256(canonicalData, canonicalDigest);
  HRASHA256(previewData, previewDigest);
  int responseLength = printf(
      "{\"schemaVersion\":1,\"mediaType\":\"%s\",\"sourceBytes\":%llu,"
      "\"canonical\":{\"width\":%zu,\"height\":%zu,\"bytes\":%zu,"
      "\"sha256\":\"%s\"},\"preview\":{\"width\":%zu,\"height\":%zu,"
      "\"bytes\":%zu,\"sha256\":\"%s\"}}\n",
      HRAImageMediaType(format),
      (unsigned long long)inputIdentity.st_size,
      width,
      height,
      canonicalData.length,
      canonicalDigest,
      previewWidth,
      previewHeight,
      previewData.length,
      previewDigest);
  bool responsePublished = responseLength > 0 && fflush(stdout) == 0 &&
      HRAVerifyPublishedGeneration(
          outputDirectoryPath,
          outputDirectoryPathLength,
          &generation);
  if (!responsePublished) {
    HRARemoveOutputGeneration(&generation);
    return HRAImageNormalizerUnsafeOutput;
  }
  HRACloseSuccessfulOutputGeneration(&generation);
  return HRAImageNormalizerSuccess;
}

int hra_image_normalizer_run(
    const char *input_path,
    size_t input_path_length,
    const char *output_directory_path,
    size_t output_directory_path_length) {
  @autoreleasepool {
    return HRANormalizeImage(
        input_path,
        input_path_length,
        output_directory_path,
        output_directory_path_length);
  }
}

int main(int argc, const char *argv[]) {
  if (argc != 6 || strcmp(argv[1], "normalize") != 0 ||
      strcmp(argv[2], "--input") != 0 ||
      strcmp(argv[4], "--output-directory") != 0) {
    fprintf(
        stderr,
        "hra-image-normalizer:error:%d\n",
        HRAImageNormalizerInvalidProtocol);
    return HRAImageNormalizerInvalidProtocol;
  }
  size_t inputPathLength = strnlen(argv[3], PATH_MAX + 1);
  size_t outputPathLength = strnlen(argv[5], PATH_MAX + 1);
  if (inputPathLength > PATH_MAX || outputPathLength > PATH_MAX) {
    fprintf(
        stderr,
        "hra-image-normalizer:error:%d\n",
        HRAImageNormalizerInvalidProtocol);
    return HRAImageNormalizerInvalidProtocol;
  }
  int receiptDescriptor = HRAIsolateFrameworkStandardError();
  if (receiptDescriptor < 0) {
    fprintf(
        stderr,
        "hra-image-normalizer:error:%d\n",
        HRAImageNormalizerUnsafeOutput);
    return HRAImageNormalizerUnsafeOutput;
  }
  int status = hra_image_normalizer_run(
      argv[3],
      inputPathLength,
      argv[5],
      outputPathLength);
  if (status != HRAImageNormalizerSuccess) {
    HRAWriteErrorReceipt(receiptDescriptor, status);
  }
  close(receiptDescriptor);
  return status;
}
