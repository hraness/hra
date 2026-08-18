#ifndef HRA_MACOS_IMAGE_NORMALIZER_H
#define HRA_MACOS_IMAGE_NORMALIZER_H

#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

int hra_image_normalizer_run(
    const char *input_path,
    size_t input_path_length,
    const char *output_directory_path,
    size_t output_directory_path_length);

#ifdef __cplusplus
}
#endif

#endif
