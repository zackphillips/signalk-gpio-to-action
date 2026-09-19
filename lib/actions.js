'use strict'

/**
 * Condition evaluation and action execution against a Signal K server app.
 *
 * Everything that talks to the server lives here so the gesture logic stays
 * testable with a stub app object.
 */

const DEFAULT_ACTIVE_STATES = ['alert', 'warn', 'alarm', 'emergency']
const SKIP_KEYS = new Set(['meta', 'timestamp', '$source', 'source', 'values', 'pgn', 'sentence'])

function normalizeNotificationPath (path) {
  const trimmed = String(path || '').trim().replace(/^\.+|\.+$/g, '')
  if (trimmed.length === 0) return null
  return trimmed.startsWith('notifications.') ? trimmed : `notifications.${trimmed}`
}

/** Unwrap both `{value: {...}}` nodes and bare notification objects. */
function unwrap (node) {
  if (node === null || node === undefined) return null
  if (typeof node !== 'object') return node
  if (typeof node.state === 'string') return node
  if ('value' in node) return node.value
  return node
}

function collectNotifications (node, prefix, out) {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return out

  const direct = unwrap(node)
  if (direct && typeof direct === 'object' && typeof direct.state === 'string' && prefix.length > 0) {
    out.push({ path: `notifications.${prefix.join('.')}`, value: direct })
    return out
  }

  for (const key of Object.keys(node)) {
    if (SKIP_KEYS.has(key)) continue
    collectNotifications(node[key], prefix.concat(key), out)
  }
  return out
}

class ActionRunner {
  constructor (options = {}) {
    this.app = options.app
    this.pluginId = options.pluginId || 'signalk-gpio-to-action'
    this.activeStates = (options.activeStates && options.activeStates.length > 0)
      ? options.activeStates.map((s) => String(s).toLowerCase())
      : DEFAULT_ACTIVE_STATES
    this.debug = options.debug || (() => {})
    this.clock = options.clock || {
      now: () => Date.now(),
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (h) => clearTimeout(h)
    }
    this.timers = new Set()
    this.counts = { actions: 0, deltas: 0 }
  }

  getNotification (path) {
    const full = normalizeNotificationPath(path)
    if (!full) return null
    let node
    try {
      node = this.app.getSelfPath(full)
    } catch (err) {
      this.debug(`getSelfPath(${full}) failed: ${err.message}`)
      return null
    }
    return unwrap(node)
  }

  isActive (path, activeStates) {
    const states = activeStates && activeStates.length > 0
      ? activeStates.map((s) => String(s).toLowerCase())
      : this.activeStates
    const value = this.getNotification(path)
    if (!value || typeof value !== 'object') return false
    if (typeof value.state !== 'string') return false
    return states.includes(value.state.toLowerCase())
  }

  /** Snapshot the active/inactive state of a set of paths (taken at press time). */
  snapshot (paths, activeStates) {
    const out = {}
    for (const path of paths) {
      const full = normalizeNotificationPath(path)
      if (full) out[full] = this.isActive(full, activeStates)
    }
    return out
  }

  conditionMet (action, ctx, options = {}) {
    const condition = action.condition || 'always'
    if (condition === 'always') return true

    const target = normalizeNotificationPath(action.conditionPath || action.notificationPath)
    if (!target) {
      this.debug(`action "${action.label || action.type}" uses condition ${condition} but has no path to test; treating as always`)
      return true
    }

    const useSnapshot = options.conditionMode !== 'fire' && ctx && ctx.snapshot && target in ctx.snapshot
    const active = useSnapshot ? ctx.snapshot[target] : this.isActive(target, options.activeStates)

    return condition === 'targetActive' ? active === true : active === false
  }

  run (action, ctx, options = {}) {
    switch (action.type) {
      case 'raise':
        return this.raise(action)
      case 'clear':
        return this.clear(action)
      case 'toggle':
        return this.isActive(action.notificationPath, options.activeStates)
          ? this.clear(action)
          : this.raise(action)
      case 'silence':
        return this.silence(action)
      case 'delta':
        return this.sendDelta(action.deltaPath, parseValue(action.deltaValue))
      case 'put':
        return this.put(action.putPath, parseValue(action.putValue))
      default:
        throw new Error(`unknown action type "${action.type}"`)
    }
  }

  raise (action) {
    const path = normalizeNotificationPath(action.notificationPath)
    if (!path) throw new Error('raise action has no notification path')

    const value = Object.assign(
      {
        state: action.notificationState || 'alert',
        message: action.notificationMessage || '',
        method: toMethods(action.notificationMethods)
      },
      parseValue(action.notificationExtra) || {}
    )
    value.timestamp = new Date().toISOString()

    this.sendDelta(path, value)

    const autoClearMs = Number(action.autoClearMs) || 0
    if (autoClearMs > 0) {
      const timer = this.clock.setTimeout(() => {
        this.timers.delete(timer)
        this.debug(`auto-clearing ${path} after ${autoClearMs}ms`)
        try {
          this.clear(action)
        } catch (err) {
          this.debug(`auto-clear failed: ${err.message}`)
        }
      }, autoClearMs)
      this.timers.add(timer)
    }
    return `${path} -> ${value.state}`
  }

  clear (action) {
    const path = normalizeNotificationPath(action.notificationPath)
    if (!path) throw new Error('clear action has no notification path')

    if (action.clearMode === 'delete') {
      this.sendDelta(path, null)
      return `${path} -> deleted`
    }

    const state = action.clearState || 'normal'
    const value = {
      state,
      message: action.clearMessage !== undefined && action.clearMessage !== null
        ? action.clearMessage
        : (action.notificationMessage || ''),
      method: toMethods(action.clearMethods),
      timestamp: new Date().toISOString()
    }
    this.sendDelta(path, value)
    return `${path} -> ${state}`
  }

  silence (action) {
    const prefixes = toList(action.silencePaths)
    const excludes = toList(action.silenceExcludePaths).map(normalizeNotificationPath).filter(Boolean)
    const states = toList(action.silenceStates)
    const stateFilter = states.length > 0 ? states.map((s) => s.toLowerCase()) : this.activeStates

    let root
    try {
      root = this.app.getSelfPath('notifications')
    } catch (err) {
      this.debug(`could not read notifications tree: ${err.message}`)
      return 'silence: nothing readable'
    }

    const found = collectNotifications(root, [], [])
    const values = []
    for (const item of found) {
      if (typeof item.value.state !== 'string') continue
      if (!stateFilter.includes(item.value.state.toLowerCase())) continue
      if (excludes.some((ex) => item.path === ex || item.path.startsWith(`${ex}.`))) continue
      if (prefixes.length > 0) {
        const match = prefixes
          .map(normalizeNotificationPath)
          .filter(Boolean)
          .some((p) => item.path === p || item.path.startsWith(`${p}.`))
        if (!match) continue
      }

      const current = toMethods(item.value.method)
      if (current.length === 0) continue // already silent
      const method = action.silenceMode === 'sound'
        ? current.filter((m) => m !== 'sound')
        : []
      if (method.length === current.length) continue // nothing to remove

      values.push({
        path: item.path,
        value: Object.assign({}, item.value, { method, timestamp: new Date().toISOString() })
      })
    }

    if (values.length === 0) return 'silence: nothing active'
    this.sendValues(values)
    return `silenced ${values.length} notification${values.length === 1 ? '' : 's'}`
  }

  put (path, value) {
    if (!path) throw new Error('put action has no path')
    if (typeof this.app.putSelfPath !== 'function') {
      throw new Error('this Signal K server does not support putSelfPath')
    }
    this.app.putSelfPath(path, value, (reply) => {
      if (reply && reply.state === 'COMPLETED' && reply.statusCode >= 400) {
        this.debug(`PUT ${path} failed: ${reply.statusCode} ${reply.message || ''}`)
      }
    })
    return `PUT ${path} = ${JSON.stringify(value)}`
  }

  sendDelta (path, value) {
    if (!path) throw new Error('delta action has no path')
    this.sendValues([{ path, value }])
    return `${path} = ${JSON.stringify(value)}`
  }

  sendValues (values) {
    this.counts.deltas += 1
    this.app.handleMessage(this.pluginId, {
      updates: [{ values }]
    })
  }

  stop () {
    for (const timer of this.timers) this.clock.clearTimeout(timer)
    this.timers.clear()
  }
}

function toMethods (value) {
  if (Array.isArray(value)) return value.map((v) => String(v)).filter((v) => v.length > 0)
  if (typeof value === 'string' && value.trim().length > 0) {
    return value.split(',').map((v) => v.trim()).filter((v) => v.length > 0)
  }
  return []
}

function toList (value) {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter((v) => v.length > 0)
  if (typeof value === 'string' && value.trim().length > 0) {
    return value.split(',').map((v) => v.trim()).filter((v) => v.length > 0)
  }
  return []
}

/** Config values arrive as JSON text; fall back to the raw string. */
function parseValue (input) {
  if (input === undefined || input === null) return undefined
  if (typeof input !== 'string') return input
  const trimmed = input.trim()
  if (trimmed.length === 0) return undefined
  try {
    return JSON.parse(trimmed)
  } catch (err) {
    return input
  }
}

module.exports = {
  ActionRunner,
  normalizeNotificationPath,
  collectNotifications,
  parseValue,
  DEFAULT_ACTIVE_STATES
}
