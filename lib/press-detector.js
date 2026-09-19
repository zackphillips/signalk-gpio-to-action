'use strict'

/**
 * Turns whatever a GPIO input publishes into a clean pressed / released reading.
 *
 * OpenPlotter's GPIO digital input publishes `notifications.GPIO18` with the
 * state ALWAYS 'normal' - the discriminator lives in the message field:
 *   "Pressed"      (low)  -> button down
 *   "Not Pressed"  (high) -> button up
 * which is why the default source is 'auto' (message first, then state) and the
 * default match type is 'exact'. A contains/regex test is a trap here, since
 * "Not Pressed" contains "Pressed". Released patterns are tested before pressed
 * patterns so a contains/regex setup still resolves that pair correctly.
 */

const PRESSED = 'pressed'
const RELEASED = 'released'
const UNKNOWN = 'unknown'

const TRUTHY = ['true', '1', 'on', 'yes', 'high', 'closed', 'pressed', 'down']
const FALSY = ['false', '0', 'off', 'no', 'low', 'open', 'not pressed', 'up', 'released']

const SKIP_KEYS = new Set(['timestamp', '$source', 'source', 'meta', 'pgn', 'sentence'])

function isPlainObject (value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Pull the field we are going to test out of a delta value.
 *
 * 'auto' order is message -> state -> value -> the raw value itself, which
 * matches how notification-shaped GPIO inputs behave without any configuration.
 */
function extractCandidate (value, source) {
  if (value === null || value === undefined) return undefined

  if (!isPlainObject(value)) {
    // A plain boolean / number / string path (electrical.switches.*.state etc).
    return value
  }

  switch (source) {
    case 'message':
      return value.message
    case 'state':
      return value.state
    case 'value':
      return 'value' in value ? value.value : undefined
    default: {
      if (typeof value.message === 'string' && value.message.length > 0) return value.message
      if (typeof value.state === 'string' && value.state.length > 0) return value.state
      if ('value' in value) return value.value
      const keys = Object.keys(value).filter((k) => !SKIP_KEYS.has(k))
      if (keys.length === 1) return value[keys[0]]
      return undefined
    }
  }
}

class PressDetector {
  constructor (options = {}) {
    this.source = options.source || 'auto'
    this.mode = options.mode || 'values'
    this.matchType = options.matchType || 'exact'
    this.caseSensitive = options.caseSensitive === true
    this.invert = options.invert === true
    this.unmatched = options.unmatched || 'ignore'
    this.threshold = typeof options.threshold === 'number' ? options.threshold : 0.5
    this.comparison = options.comparison || '>='

    this.pressedValues = toStringList(options.pressedValues, ['Pressed'])
    this.releasedValues = toStringList(options.releasedValues, ['Not Pressed'])

    if (this.matchType === 'regex') {
      const flags = this.caseSensitive ? '' : 'i'
      this.pressedPatterns = this.pressedValues.map((p) => new RegExp(p, flags))
      this.releasedPatterns = this.releasedValues.map((p) => new RegExp(p, flags))
    }
  }

  /** @returns {'pressed'|'released'|'unknown'} */
  read (value) {
    const raw = this.readRaw(value)
    if (raw === UNKNOWN || !this.invert) return raw
    return raw === PRESSED ? RELEASED : PRESSED
  }

  readRaw (value) {
    const candidate = extractCandidate(value, this.source)
    if (candidate === undefined || candidate === null) return this.fallback()

    if (this.mode === 'threshold') {
      const num = Number(candidate)
      if (Number.isNaN(num)) return this.fallback()
      return compare(num, this.comparison, this.threshold) ? PRESSED : RELEASED
    }

    if (this.mode === 'truthy') {
      if (typeof candidate === 'boolean') return candidate ? PRESSED : RELEASED
      if (typeof candidate === 'number') return candidate !== 0 ? PRESSED : RELEASED
      const text = String(candidate).trim().toLowerCase()
      if (FALSY.includes(text)) return RELEASED
      if (TRUTHY.includes(text)) return PRESSED
      return this.fallback()
    }

    const text = String(candidate)
    // Released first: protects "Pressed" / "Not Pressed" under contains & regex.
    if (this.matchesAny(text, RELEASED)) return RELEASED
    if (this.matchesAny(text, PRESSED)) return PRESSED
    return this.fallback()
  }

  matchesAny (text, which) {
    if (this.matchType === 'regex') {
      const patterns = which === PRESSED ? this.pressedPatterns : this.releasedPatterns
      return patterns.some((re) => re.test(text))
    }
    const values = which === PRESSED ? this.pressedValues : this.releasedValues
    const subject = this.caseSensitive ? text : text.toLowerCase()
    return values.some((v) => {
      const pattern = this.caseSensitive ? v : v.toLowerCase()
      return this.matchType === 'contains' ? subject.includes(pattern) : subject === pattern
    })
  }

  fallback () {
    if (this.unmatched === 'released') return RELEASED
    if (this.unmatched === 'pressed') return PRESSED
    return UNKNOWN
  }
}

function compare (value, comparison, threshold) {
  switch (comparison) {
    case '>': return value > threshold
    case '<': return value < threshold
    case '<=': return value <= threshold
    case '==': return value === threshold
    case '!=': return value !== threshold
    default: return value >= threshold
  }
}

function toStringList (value, fallback) {
  if (Array.isArray(value)) {
    const list = value.map((v) => String(v)).filter((v) => v.length > 0)
    return list.length > 0 ? list : fallback
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    return value.split(',').map((v) => v.trim()).filter((v) => v.length > 0)
  }
  return fallback
}

module.exports = { PressDetector, extractCandidate, PRESSED, RELEASED, UNKNOWN }
