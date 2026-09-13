'use strict'

// Shared maximums for isolated Desktop validation.  A server start can first
// run the bounded junction repair and only then begin its 90-second readiness
// window.  Keep parent-process waits derived from this module rather than
// inventing a shorter, incompatible timeout in PowerShell.
const JUNCTION_REPAIR_TIMEOUT_MS = 180_000
const ENGINE_READY_TIMEOUT_MS = 90_000
const VERIFY_RENDER_DELAY_MS = 12_000
const SCREENSHOT_RENDER_DELAY_MS = 8_000
const RECOVERY_PRE_KILL_DELAY_MS = 500
const RECOVERY_POST_RESTART_DELAY_MS = 500
const SHUTDOWN_GRACE_MS = 30_000

const ENGINE_START_ATTEMPT_TIMEOUT_MS = JUNCTION_REPAIR_TIMEOUT_MS + ENGINE_READY_TIMEOUT_MS

function isolatedValidationTimeoutMs(mode) {
  switch (mode) {
    case '--verify-engine-recovery':
      return (ENGINE_START_ATTEMPT_TIMEOUT_MS * 2) + RECOVERY_PRE_KILL_DELAY_MS + RECOVERY_POST_RESTART_DELAY_MS + SHUTDOWN_GRACE_MS
    case '--shot':
      return ENGINE_START_ATTEMPT_TIMEOUT_MS + SCREENSHOT_RENDER_DELAY_MS + SHUTDOWN_GRACE_MS
    case '--verify':
      return ENGINE_START_ATTEMPT_TIMEOUT_MS + VERIFY_RENDER_DELAY_MS + SHUTDOWN_GRACE_MS
    default:
      throw new Error(`Unknown isolated validation mode: ${mode}`)
  }
}

module.exports = {
  JUNCTION_REPAIR_TIMEOUT_MS,
  ENGINE_READY_TIMEOUT_MS,
  VERIFY_RENDER_DELAY_MS,
  SCREENSHOT_RENDER_DELAY_MS,
  RECOVERY_PRE_KILL_DELAY_MS,
  RECOVERY_POST_RESTART_DELAY_MS,
  SHUTDOWN_GRACE_MS,
  ENGINE_START_ATTEMPT_TIMEOUT_MS,
  isolatedValidationTimeoutMs,
}
