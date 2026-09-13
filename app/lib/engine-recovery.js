'use strict'

// Recovery restarts the transport only; it never submits or replays a task.
class EngineRecovery {
  constructor({ restart, publish }) {
    this.restart = restart
    this.publish = publish
    this.state = 'online'
    this.pending = null
    this.closed = false
    this.failureEpoch = 0
  }

  setState(state) {
    this.state = state
    if (!this.closed) this.publish({ state })
  }

  failed() {
    this.failureEpoch++
    if (!this.closed) this.setState('offline')
  }

  recover() {
    if (this.closed) return Promise.resolve(false)
    if (this.pending) return this.pending
    if (this.state === 'online') return Promise.resolve(true)
    this.setState('recovering')
    const epoch = this.failureEpoch
    this.pending = Promise.resolve().then(() => this.closed ? false : this.restart())
      .then((ok) => {
        if (epoch !== this.failureEpoch) return false
        if (!this.closed) this.setState(ok === false ? 'offline' : 'online')
        return !this.closed && ok !== false
      }, () => {
        if (!this.closed) this.setState('offline')
        return false
      }).finally(() => { this.pending = null })
    return this.pending
  }

  close() { this.closed = true }
}

module.exports = { EngineRecovery }
