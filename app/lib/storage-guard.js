'use strict'

const GIB = 1024 ** 3
const DEFAULT_THRESHOLD_BYTES = 20 * GIB
const DEFAULT_REMINDER_INTERVAL_MS = 24 * 60 * 60 * 1000

function finiteNonNegative(value, name) {
  if (!Number.isFinite(value) || value < 0) throw new TypeError(`${name} must be a non-negative finite number`)
  return value
}

function normalizeState(value) {
  if (value?.schema !== 1) return { schema: 1, lowSpace: false, lastNotifiedUtc: null }
  const lowSpace = value.lowSpace === true
  const lastNotifiedUtc = lowSpace && typeof value.lastNotifiedUtc === 'string'
    && Number.isFinite(Date.parse(value.lastNotifiedUtc))
    ? new Date(value.lastNotifiedUtc).toISOString()
    : null
  return {
    schema: 1,
    lowSpace,
    lastNotifiedUtc,
  }
}

/**
 * Decide whether the current low-space episode is eligible for a reminder.
 * A recovery clears the episode, so a later drop can alert immediately. While
 * the same episode continues, reminders are rate-limited to once per 24 hours.
 */
function planLowSpaceCheck({
  freeBytes,
  state,
  now = Date.now(),
  thresholdBytes = DEFAULT_THRESHOLD_BYTES,
  reminderIntervalMs = DEFAULT_REMINDER_INTERVAL_MS,
}) {
  finiteNonNegative(freeBytes, 'freeBytes')
  finiteNonNegative(thresholdBytes, 'thresholdBytes')
  finiteNonNegative(now, 'now')
  finiteNonNegative(reminderIntervalMs, 'reminderIntervalMs')
  const previous = normalizeState(state)
  if (freeBytes >= thresholdBytes) {
    return {
      isLow: false,
      shouldNotify: false,
      reason: previous.lowSpace ? 'recovered' : 'healthy',
      nextState: { schema: 1, lowSpace: false, lastNotifiedUtc: null },
    }
  }
  const last = previous.lastNotifiedUtc === null ? null : Date.parse(previous.lastNotifiedUtc)
  const shouldNotify = !previous.lowSpace || last === null || now - last >= reminderIntervalMs
  return {
    isLow: true,
    shouldNotify,
    reason: shouldNotify ? (previous.lowSpace ? 'reminder-due' : 'new-low-space') : 'reminder-rate-limited',
    nextState: { schema: 1, lowSpace: true, lastNotifiedUtc: previous.lastNotifiedUtc },
  }
}

function recordNotification(state, now = Date.now()) {
  finiteNonNegative(now, 'now')
  const current = normalizeState(state)
  if (!current.lowSpace) throw new Error('cannot record a low-space notification while storage is healthy')
  return { ...current, lastNotifiedUtc: new Date(now).toISOString() }
}

module.exports = {
  DEFAULT_REMINDER_INTERVAL_MS,
  DEFAULT_THRESHOLD_BYTES,
  normalizeState,
  planLowSpaceCheck,
  recordNotification,
}
