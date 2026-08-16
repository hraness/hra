#ifndef HRA_MACOS_UPDATER_H
#define HRA_MACOS_UPDATER_H

#include <stdbool.h>
#include <stddef.h>

typedef struct HRAMacosUpdateHazards {
  bool session_in_progress;
  bool memory_hazard;
  bool durable_hazard;
  bool preparation_failed;
  bool installer_job_present;
  bool sparkle_cache_present;
  bool probe_indeterminate;
} HRAMacosUpdateHazards;

typedef enum HRAMacosUpdateHazardState {
  HRAMacosUpdateHazardStateUnknown = 0,
  HRAMacosUpdateHazardStateFound = 1,
  HRAMacosUpdateHazardStateDownloading = 2,
  HRAMacosUpdateHazardStateDownloaded = 3,
  HRAMacosUpdateHazardStateExtracting = 4,
  HRAMacosUpdateHazardStateInstalling = 5,
  HRAMacosUpdateHazardStateInstallOnQuit = 6,
  HRAMacosUpdateHazardStateCancelled = 7,
} HRAMacosUpdateHazardState;

typedef enum HRAMacosUpdatePreparationResult {
  HRAMacosUpdatePreparationNotAttempted = 0,
  HRAMacosUpdatePreparationFailed = 1,
  HRAMacosUpdatePreparationSucceeded = 2,
} HRAMacosUpdatePreparationResult;

typedef enum HRAMacosUpdaterStartResult {
  HRAMacosUpdaterStartNotAttempted = 0,
  HRAMacosUpdaterStarted = 1,
  HRAMacosUpdaterBlockedByMaintenance = 2,
  HRAMacosUpdaterMissingReleaseMetadata = 3,
  HRAMacosUpdaterHazardPreparationFailed = 4,
  HRAMacosUpdaterFrameworkLoadFailed = 5,
  HRAMacosUpdaterControllerClassMissing = 6,
  HRAMacosUpdaterControllerInitializationFailed = 7,
  HRAMacosUpdaterObjectMissing = 8,
  HRAMacosUpdaterStartFailed = 9,
} HRAMacosUpdaterStartResult;

bool hra_macos_update_removal_is_safe(
    HRAMacosUpdateHazards hazards);
bool hra_macos_update_removal_lease_acquire(
    size_t current_count,
    size_t *next_count);
bool hra_macos_update_removal_lease_release(
    size_t current_count,
    size_t *next_count);
bool hra_macos_update_hazard_may_clear_without_artifact(
    HRAMacosUpdateHazardState state,
    bool cancellation_pending);
bool hra_macos_update_preparation_failure_next(
    bool currently_latched,
    HRAMacosUpdatePreparationResult result);
bool hra_macos_updater_start(void);
HRAMacosUpdaterStartResult hra_macos_updater_last_start_result(void);
bool hra_macos_updater_check_for_updates(bool updater_allowed);
bool hra_macos_updater_enter_removal_maintenance(void);
void hra_macos_updater_leave_removal_maintenance(void);
void hra_macos_updater_stop(void);

#endif
