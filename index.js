'use strict'

const { PressDetector } = require('./lib/press-detector')
const { GestureMachine } = require('./lib/gesture-machine')
const { ActionRunner, normalizeNotificationPath } = require('./lib/actions')
const { schema, uiSchema, normalizeOptions } = require('./lib/schema')

module.exports = function (app) {
  const plugin = {
    id: 'signalk-gpio-to-action',
    name: 'GPIO to action',
    description:
      'Route GPIO digital inputs to Signal K actions: raise or clear notifications ' +
      '(MOB button), silence active alarms, send deltas or PUT requests.',
    schema,
    uiSchema
  }

  let unsubscribes = []
  let machines = []
  let runner = null
  let config = null
  const stats = { gestures: 0, actions: 0, errors: 0, last: null }

  const debug = (message) => {
    if (typeof app.debug === 'function') app.debug(message)
  }

  const reportError = (message) => {
    stats.errors += 1
    if (typeof app.error === 'function') app.error(message)
    else console.error(`${plugin.id}: ${message}`)
    if (typeof app.setPluginError === 'function') app.setPluginError(message)
  }

  const setStatus = (message) => {
    if (typeof app.setPluginStatus === 'function') app.setPluginStatus(message)
  }

  plugin.start = function (options) {
    config = normalizeOptions(options)
    stats.gestures = 0
    stats.actions = 0
    stats.errors = 0
    stats.last = null

    runner = new ActionRunner({
      app,
      pluginId: plugin.id,
      activeStates: config.activeStates,
      debug
    })

    const enabledRules = config.rules.filter((rule) => rule.enabled)
    enabledRules.forEach((rule) => {
      try {
        startRule(rule)
      } catch (err) {
        reportError(`rule "${rule.name}": ${err.message}`)
      }
    })

    if (enabledRules.length === 0) {
      setStatus('No inputs configured')
    } else {
      updateStatus()
    }
  }

  plugin.stop = function () {
    unsubscribes.forEach((f) => {
      try {
        f()
      } catch (err) {
        debug(`unsubscribe failed: ${err.message}`)
      }
    })
    unsubscribes = []
    machines.forEach((m) => m.stop())
    machines = []
    if (runner) runner.stop()
    runner = null
    setStatus('Stopped')
  }

  function startRule (rule) {
    const detector = new PressDetector(rule.detect)
    const triggers = new Set(rule.actions.filter((a) => a.enabled).map((a) => a.trigger))
    const conditionPaths = rule.actions
      .filter((a) => a.enabled && a.condition !== 'always')
      .map((a) => normalizeNotificationPath(a.conditionPath || a.notificationPath))
      .filter(Boolean)

    const machine = new GestureMachine({
      debounceMs: rule.timing.debounceMs,
      holdMs: rule.timing.holdMs,
      doublePressMs: rule.timing.doublePressMs,
      initialGraceMs: rule.timing.initialGraceMs,
      holdEnabled: triggers.has('hold') || triggers.has('holdRelease'),
      doubleEnabled: triggers.has('doublePress') && rule.timing.doublePressMs > 0,
      onGestureStart: () => runner.snapshot(conditionPaths, rule.activeStates),
      emit: (gesture, ctx) => onGesture(rule, gesture, ctx)
    })
    machine.start()
    machines.push(machine)

    const subscription = {
      context: rule.context || 'vessels.self',
      subscribe: [{ path: rule.inputPath, policy: 'instant', minPeriod: 0 }]
    }

    app.subscriptionmanager.subscribe(
      subscription,
      unsubscribes,
      (err) => {
        reportError(`subscription error on ${rule.inputPath}: ${err}`)
      },
      (delta) => onDelta(rule, detector, machine, delta)
    )

    debug(`watching ${rule.context} ${rule.inputPath} for "${rule.name}"`)
  }

  function onDelta (rule, detector, machine, delta) {
    if (!delta || !Array.isArray(delta.updates)) return
    delta.updates.forEach((update) => {
      if (rule.sourceFilter) {
        const source = update.$source || (update.source && (update.source.label || update.source.src)) || ''
        if (!String(source).includes(rule.sourceFilter)) return
      }
      const values = update.values || []
      values.forEach((value) => {
        if (value.path !== rule.inputPath) return
        const reading = detector.read(value.value)
        const result = machine.handle(reading, { value: value.value })
        if (config.debug) {
          debug(`${rule.name}: ${JSON.stringify(value.value)} -> ${reading} (${result})`)
        }
      })
    })
  }

  function onGesture (rule, gesture, ctx) {
    stats.gestures += 1
    if (config.debug) debug(`${rule.name}: gesture ${gesture}`)

    rule.actions
      .filter((action) => action.enabled && action.trigger === gesture)
      .forEach((action) => runAction(rule, action, gesture, ctx))
  }

  function runAction (rule, action, gesture, ctx) {
    const options = { conditionMode: rule.conditionMode, activeStates: rule.activeStates }

    if (!runner.conditionMet(action, ctx, options)) {
      if (config.debug) debug(`${rule.name}: "${action.label}" skipped, condition ${action.condition} not met`)
      return
    }

    const now = Date.now()
    if (action.cooldownMs > 0 && action._lastRunAt && now - action._lastRunAt < action.cooldownMs) {
      if (config.debug) debug(`${rule.name}: "${action.label}" skipped, in cooldown`)
      return
    }

    try {
      const outcome = runner.run(action, ctx, options)
      action._lastRunAt = now
      stats.actions += 1
      stats.last = `${gesture} -> ${action.label}: ${outcome}`
      debug(stats.last)
      updateStatus()
    } catch (err) {
      reportError(`rule "${rule.name}" action "${action.label}": ${err.message}`)
      updateStatus()
    }
  }

  function updateStatus () {
    const inputs = machines.length
    const parts = [`${inputs} input${inputs === 1 ? '' : 's'}`, `${stats.actions} action${stats.actions === 1 ? '' : 's'}`]
    if (stats.errors > 0) parts.push(`${stats.errors} error${stats.errors === 1 ? '' : 's'}`)
    if (stats.last) parts.push(stats.last)
    setStatus(parts.join(' | '))
  }

  return plugin
}
