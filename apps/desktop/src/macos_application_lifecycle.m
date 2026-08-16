#import "macos_application_lifecycle.h"

#import <Cocoa/Cocoa.h>
#import <errno.h>
#import <pthread.h>
#import <sched.h>
#import <stdatomic.h>
#import <time.h>
#import <unistd.h>

enum {
  HRA_TERMINATION_WATCHDOG_UNARMED = 0,
  HRA_TERMINATION_WATCHDOG_ARMING = 1,
  HRA_TERMINATION_WATCHDOG_ARMED = 2,
  HRA_TERMINATION_WATCHDOG_MAX_DELAY_MILLISECONDS = 5000,
  HRA_TERMINATION_WATCHDOG_GRACE_MILLISECONDS = 750,
};

static atomic_uint hra_termination_watchdog_state =
    HRA_TERMINATION_WATCHDOG_UNARMED;
static atomic_uint hra_termination_watchdog_delay_milliseconds = 0;

static void hra_macos_sleep_milliseconds(uint32_t milliseconds) {
  struct timespec remaining = {
      .tv_sec = milliseconds / 1000,
      .tv_nsec = (long)(milliseconds % 1000) * 1000 * 1000,
  };
  while (nanosleep(&remaining, &remaining) == -1 && errno == EINTR) {
  }
}

static void *hra_macos_termination_watchdog_main(void *unused) {
  (void)unused;

  // Nothing outside this file retains the pthread identifier, and cancellation
  // is disabled before the first wait. Once armed, the hard deadline cannot be
  // withdrawn by renderer or AppKit state.
  (void)pthread_setcancelstate(PTHREAD_CANCEL_DISABLE, NULL);

  const uint32_t delay_milliseconds = (uint32_t)atomic_load_explicit(
      &hra_termination_watchdog_delay_milliseconds, memory_order_acquire);
  hra_macos_sleep_milliseconds(delay_milliseconds);

  // AppKit remains main-thread-only. The watchdog does not wait for the main
  // queue to make progress: a stuck main loop is precisely the condition that
  // the independent hard deadline must cover.
  (void)hra_macos_request_application_termination();
  hra_macos_sleep_milliseconds(
      HRA_TERMINATION_WATCHDOG_GRACE_MILLISECONDS);
  _exit(1);
}

bool hra_macos_request_application_termination(void) {
  dispatch_async(dispatch_get_main_queue(), ^{
    [NSApp terminate:nil];
  });
  return true;
}

bool hra_macos_arm_application_termination_watchdog(
    uint32_t delay_milliseconds) {
  if (delay_milliseconds == 0 ||
      delay_milliseconds >
          HRA_TERMINATION_WATCHDOG_MAX_DELAY_MILLISECONDS) {
    return false;
  }

  for (;;) {
    unsigned int state = atomic_load_explicit(
        &hra_termination_watchdog_state, memory_order_acquire);
    if (state == HRA_TERMINATION_WATCHDOG_ARMED) {
      return true;
    }
    if (state == HRA_TERMINATION_WATCHDOG_ARMING) {
      sched_yield();
      continue;
    }

    unsigned int expected = HRA_TERMINATION_WATCHDOG_UNARMED;
    if (!atomic_compare_exchange_weak_explicit(
            &hra_termination_watchdog_state, &expected,
            HRA_TERMINATION_WATCHDOG_ARMING, memory_order_acq_rel,
            memory_order_acquire)) {
      continue;
    }
    break;
  }

  atomic_store_explicit(&hra_termination_watchdog_delay_milliseconds,
                        delay_milliseconds, memory_order_release);

  pthread_t watchdog_thread;
  const int create_result =
      pthread_create(&watchdog_thread, NULL,
                     hra_macos_termination_watchdog_main, NULL);
  if (create_result != 0) {
    atomic_store_explicit(&hra_termination_watchdog_state,
                          HRA_TERMINATION_WATCHDOG_UNARMED,
                          memory_order_release);
    return false;
  }

  // Detachment only releases bookkeeping after the thread exits. Even if this
  // unexpectedly fails, the already-running watchdog retains its safety
  // semantics and still owns the process deadline.
  (void)pthread_detach(watchdog_thread);
  atomic_store_explicit(&hra_termination_watchdog_state,
                        HRA_TERMINATION_WATCHDOG_ARMED,
                        memory_order_release);
  return true;
}
