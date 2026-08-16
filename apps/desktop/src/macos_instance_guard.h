#ifndef HRA_MACOS_INSTANCE_GUARD_H
#define HRA_MACOS_INSTANCE_GUARD_H

typedef enum HRAMacosInstanceGuardStatus {
  HRAMacosInstanceGuardUnavailable = -1,
  HRAMacosInstanceGuardBusy = 0,
  HRAMacosInstanceGuardClear = 1,
  HRAMacosInstanceGuardRemovalRecoveryRequired = 2,
} HRAMacosInstanceGuardStatus;

HRAMacosInstanceGuardStatus
hra_macos_instance_guard_acquire(void);
void hra_macos_instance_guard_release(void);

#endif
