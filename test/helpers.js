'use strict'

/** Deterministic clock: timers only fire when the test advances time. */
class FakeClock {
  constructor (start = 1000) {
    this.time = start
    this.timers = new Map()
    this.nextId = 1
  }

  now () {
    return this.time
  }

  setTimeout (fn, ms) {
    const id = this.nextId++
    this.timers.set(id, { at: this.time + Number(ms || 0), fn })
    return id
  }

  clearTimeout (id) {
    this.timers.delete(id)
  }

  /** Advance the clock, firing due timers in order. */
  advance (ms) {
    const target = this.time + ms
    for (;;) {
      let due = null
      for (const [id, timer] of this.timers) {
        if (timer.at <= target && (due === null || timer.at < due.timer.at)) due = { id, timer }
      }
      if (!due) break
      this.timers.delete(due.id)
      this.time = due.timer.at
      due.timer.fn()
    }
    this.time = target
  }

  get interface () {
    return {
      now: () => this.now(),
      setTimeout: (fn, ms) => this.setTimeout(fn, ms),
      clearTimeout: (id) => this.clearTimeout(id)
    }
  }
}

/** Minimal stand-in for the Signal K server app object. */
class FakeApp {
  constructor (tree = {}) {
    this.tree = tree
    this.deltas = []
    this.puts = []
    this.errors = []
    this.subscriptions = []
    this.status = null
    this.subscriptionmanager = {
      subscribe: (subscription, unsubscribes, onError, onDelta) => {
        this.subscriptions.push({ subscription, onError, onDelta })
        unsubscribes.push(() => {})
      }
    }
  }

  /** Push a delta to every subscriber, as the server would. */
  send (path, value, source = 'gpio.0') {
    const delta = { updates: [{ $source: source, values: [{ path, value }] }] }
    this.subscriptions.forEach((s) => s.onDelta(delta))
  }

  getSelfPath (path) {
    return path.split('.').reduce((node, key) => (node === undefined || node === null ? undefined : node[key]), this.tree)
  }

  handleMessage (source, delta) {
    this.deltas.push({ source, delta })
    // Reflect writes back into the tree so conditions see current state.
    delta.updates.forEach((update) => {
      (update.values || []).forEach(({ path, value }) => {
        const keys = path.split('.')
        const last = keys.pop()
        const parent = keys.reduce((node, key) => {
          if (!node[key] || typeof node[key] !== 'object') node[key] = {}
          return node[key]
        }, this.tree)
        parent[last] = { value }
      })
    })
  }

  putSelfPath (path, value, cb) {
    this.puts.push({ path, value })
    if (cb) cb({ state: 'COMPLETED', statusCode: 200 })
  }

  error (message) {
    this.errors.push(message)
  }

  debug () {}
  setPluginStatus (message) {
    this.status = message
  }

  setPluginError (message) {
    this.errors.push(message)
  }

  /** Values written by the plugin, flattened. */
  written () {
    const out = []
    this.deltas.forEach(({ delta }) => {
      delta.updates.forEach((update) => {
        (update.values || []).forEach((v) => out.push(v))
      })
    })
    return out
  }
}

module.exports = { FakeClock, FakeApp }
