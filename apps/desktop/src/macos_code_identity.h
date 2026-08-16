#ifndef HRA_MACOS_CODE_IDENTITY_H
#define HRA_MACOS_CODE_IDENTITY_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

bool hra_macos_verify_embedded_helper(
    const char *path,
    size_t path_length);

bool hra_macos_validate_removal_launch_paths(
    const char *request_path,
    size_t request_path_length,
    const char *signing_key_path,
    size_t signing_key_path_length);

bool hra_macos_spawn_attested_removal_execute(
    const char *path,
    size_t path_length,
    const char *request_path,
    size_t request_path_length,
    const char *signing_key_path,
    size_t signing_key_path_length,
    uint32_t parent_process_id,
    int ready_fd,
    int *out_process_id);

bool hra_macos_spawn_attested_removal_recovery(
    const char *path,
    size_t path_length,
    const char *helper_state_root,
    size_t helper_state_root_length,
    int *out_process_id);

/// Waits for one attested, owned removal-helper child. A timeout reaps that
/// exact child, first killing it if it remains live, before returning false.
bool hra_macos_wait_removal_helper(
    int process_id,
    uint32_t timeout_milliseconds);

void hra_macos_kill_and_reap_removal_helper(int process_id);

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
    uint32_t timeout_milliseconds);

void hra_macos_prepare_attested_account_profile_operations(void);

void hra_macos_cancel_attested_account_profile_operation(void);

#endif
