#ifndef HRA_MACOS_APPLICATION_LIFECYCLE_H
#define HRA_MACOS_APPLICATION_LIFECYCLE_H

#include <stdbool.h>
#include <stdint.h>

bool hra_macos_request_application_termination(void);
bool hra_macos_arm_application_termination_watchdog(
    uint32_t delay_milliseconds);

#endif
