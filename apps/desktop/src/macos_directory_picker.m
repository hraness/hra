#import <AppKit/AppKit.h>

typedef struct {
    int status;
    size_t path_len;
} hra_macos_directory_picker_result_t;

// status: 0 cancelled, 1 selected, 2 failed. This deliberately avoids the
// SDK's general open dialog, which permits files alongside directories.
hra_macos_directory_picker_result_t hra_macos_choose_directory(char *output, size_t output_len) {
    hra_macos_directory_picker_result_t result = { .status = 2, .path_len = 0 };
    if (output == NULL || output_len == 0) return result;

    @autoreleasepool {
        NSOpenPanel *panel = [NSOpenPanel openPanel];
        panel.title = @"Open Project";
        panel.canChooseFiles = NO;
        panel.canChooseDirectories = YES;
        panel.allowsMultipleSelection = NO;
        panel.resolvesAliases = NO;

        if ([panel runModal] != NSModalResponseOK) {
            result.status = 0;
            return result;
        }

        NSURL *url = panel.URL;
        NSString *path = url.path;
        NSData *utf8 = [path dataUsingEncoding:NSUTF8StringEncoding];
        if (utf8 == nil || utf8.length == 0 || utf8.length > output_len) return result;
        memcpy(output, utf8.bytes, utf8.length);
        result.status = 1;
        result.path_len = utf8.length;
    }
    return result;
}
