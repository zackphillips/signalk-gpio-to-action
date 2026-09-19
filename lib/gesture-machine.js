'use strict'

/**
 * Edge detection + debounce + gesture recognition for one input.
 *
 * Readings come in as 'pressed' / 'released' / 'unknown'. Repeats of the
 * current state are dropped (a GPIO input that re-publishes while held
 * collapses to one press and one release), and a transition inside the
 * debounce window is ignored.
 *
 * Gestures emitted:
 *   press        button down, as soon as the edge is accepted
 *   hold         still down after holdMs
 *   release      button up
 *   holdRelease  button up, after hold had already fired
 *   shortPress   button up before holdMs (deferred by doublePressMs when
 *                double press detection is enabled)
 *   doublePress  second press down inside doublePressMs of the previous
 *                short press; cancels that pending shortPress
 *
 * All timers come from the injected clock so tests can drive them.
 */

const DEFAULT_CLOCK = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle)
}

class GestureMachine {
  constructor (options = {}) {
    this.debounceMs = num(options.debounceMs, 100)
    this.holdMs = num(options.holdMs, 5000)
    this.doublePressMs = num(options.doublePressMs, 400)
    this.initialGraceMs = num(options.initialGraceMs, 1500)
    this.holdEnabled = options.holdEnabled !== false && this.holdMs > 0
    this.doubleEnabled = options.doubleEnabled === true && this.doublePressMs > 0

    this.emit = options.emit || (() => {})
    this.onGestureStart = options.onGestureStart || (() => undefined)
    this.clock = options.clock || DEFAULT_CLOCK

    this.startedAt = null
    this.pressed = false
    this.absorbed = false
    this.lastEdgeAt = null
    this.holdTimer = null
    this.holdFired = false
    this.pendingShortTimer = null
    this.pendingShortCtx = null
    this.suppressShort = false
    this.gestureId = 0
    this.ctx = null
    this.stats = { edges: 0, bounces: 0, presses: 0 }
  }

  start () {
    this.startedAt = this.clock.now()
  }

  /**
   * Feed one reading. Returns 'accepted', 'repeat', 'bounce', 'absorbed' or
   * 'ignored' - useful for logging and tests.
   */
  handle (reading, meta = {}) {
    if (reading !== 'pressed' && reading !== 'released') return 'ignored'

    const now = this.clock.now()
    const isPressed = reading === 'pressed'
    if (isPressed === this.pressed) return 'repeat'

    if (this.lastEdgeAt !== null && this.debounceMs > 0 && now - this.lastEdgeAt < this.debounceMs) {
      this.stats.bounces += 1
      return 'bounce'
    }

    this.lastEdgeAt = now
    this.pressed = isPressed
    this.stats.edges += 1

    // Values replayed by the server right after subscribing set the initial
    // state without firing anything, so a restart while the button happens to
    // read 'Pressed' does not raise an alarm.
    if (this.startedAt !== null && this.initialGraceMs > 0 && now - this.startedAt < this.initialGraceMs) {
      if (isPressed) {
        this.absorbed = true
        return 'absorbed'
      }
      if (this.absorbed) {
        this.absorbed = false
        return 'absorbed'
      }
    }

    if (isPressed) {
      this.onPress(now, meta)
    } else {
      this.onRelease(now, meta)
    }
    return 'accepted'
  }

  onPress (now, meta) {
    this.stats.presses += 1
    this.holdFired = false
    this.suppressShort = false
    this.ctx = {
      gestureId: ++this.gestureId,
      startedAt: now,
      value: meta.value,
      snapshot: this.onGestureStart() || {}
    }

    this.fire('press', this.ctx)

    if (this.doubleEnabled && this.pendingShortTimer !== null) {
      this.clock.clearTimeout(this.pendingShortTimer)
      this.pendingShortTimer = null
      this.pendingShortCtx = null
      this.suppressShort = true
      this.fire('doublePress', this.ctx)
    }

    if (this.holdEnabled) {
      const ctx = this.ctx
      this.holdTimer = this.clock.setTimeout(() => {
        this.holdTimer = null
        this.holdFired = true
        this.fire('hold', ctx)
      }, this.holdMs)
    }
  }

  onRelease (now, meta) {
    if (this.absorbed) {
      this.absorbed = false
      return
    }
    if (this.holdTimer !== null) {
      this.clock.clearTimeout(this.holdTimer)
      this.holdTimer = null
    }

    const ctx = Object.assign({}, this.ctx || { gestureId: ++this.gestureId, snapshot: {} }, {
      releasedAt: now,
      heldMs: this.ctx ? now - this.ctx.startedAt : 0,
      value: meta.value
    })

    this.fire('release', ctx)

    if (this.holdFired) {
      this.fire('holdRelease', ctx)
      return
    }
    if (this.suppressShort) return

    if (this.doubleEnabled) {
      this.pendingShortCtx = ctx
      this.pendingShortTimer = this.clock.setTimeout(() => {
        this.pendingShortTimer = null
        this.pendingShortCtx = null
        this.fire('shortPress', ctx)
      }, this.doublePressMs)
    } else {
      this.fire('shortPress', ctx)
    }
  }

  fire (gesture, ctx) {
    this.emit(gesture, ctx)
  }

  stop () {
    if (this.holdTimer !== null) this.clock.clearTimeout(this.holdTimer)
    if (this.pendingShortTimer !== null) this.clock.clearTimeout(this.pendingShortTimer)
    this.holdTimer = null
    this.pendingShortTimer = null
    this.pendingShortCtx = null
  }
}

function num (value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

module.exports = { GestureMachine, DEFAULT_CLOCK }
