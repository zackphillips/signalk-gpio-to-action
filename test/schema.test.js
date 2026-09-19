'use strict'

const test = require('node:test')
const assert = require('node:assert')
const { schema, uiSchema, normalizeOptions, DEFAULT_MOB_RULE } = require('../lib/schema')

test('schema is serializable and describes the top level options', () => {
  const round = JSON.parse(JSON.stringify(schema))
  assert.deepEqual(Object.keys(round.properties).sort(), ['activeStates', 'debug', 'rules'])
  assert.equal(round.properties.rules.type, 'array')
  assert.ok(round.properties.rules.items.properties.actions.items.properties.trigger.enum.includes('hold'))
  assert.deepEqual(JSON.parse(JSON.stringify(uiSchema)), uiSchema)
})

test('every enum with enumNames has matching lengths', () => {
  const walk = (node) => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node.enum) && Array.isArray(node.enumNames)) {
      assert.equal(node.enum.length, node.enumNames.length, `enumNames mismatch: ${node.title}`)
    }
    Object.values(node).forEach(walk)
  }
  walk(schema)
})

test('the shipped default is the MOB button flow', () => {
  const [rule] = schema.properties.rules.default
  assert.equal(rule.inputPath, 'notifications.GPIO18')
  assert.equal(rule.detect.matchType, 'exact')
  assert.equal(rule.timing.holdMs, 5000)

  const raise = rule.actions.find((a) => a.trigger === 'press')
  const clear = rule.actions.find((a) => a.trigger === 'holdRelease')
  assert.equal(raise.notificationState, 'emergency')
  assert.equal(raise.condition, 'targetInactive')
  assert.equal(clear.type, 'clear')
  assert.equal(clear.condition, 'targetActive')
  assert.ok(!rule.actions.some((a) => a.trigger === 'hold'),
    'the destructive action must wait for the release, so a stuck button never fires it')
})

test('normalizeOptions fills in defaults for a bare rule', () => {
  const config = normalizeOptions({ rules: [{ inputPath: 'notifications.GPIO4' }] })
  const [rule] = config.rules
  assert.equal(rule.enabled, true)
  assert.equal(rule.context, 'vessels.self')
  assert.equal(rule.conditionMode, 'press')
  assert.equal(rule.detect.source, 'auto')
  assert.equal(rule.timing.holdMs, 5000)
  assert.deepEqual(rule.activeStates, ['alert', 'warn', 'alarm', 'emergency'])
  assert.deepEqual(rule.actions, [])
})

test('normalizeOptions survives empty and undefined input', () => {
  assert.deepEqual(normalizeOptions(undefined).rules, [])
  assert.deepEqual(normalizeOptions({}).rules, [])
})

test('normalizeOptions rejects unknown triggers and action types', () => {
  const config = normalizeOptions({
    rules: [{ inputPath: 'x', actions: [{ trigger: 'wiggle', type: 'explode' }] }]
  })
  assert.equal(config.rules[0].actions[0].trigger, 'press')
  assert.equal(config.rules[0].actions[0].type, 'raise')
})

test('the default rule round-trips through normalizeOptions unchanged in substance', () => {
  const config = normalizeOptions({ rules: [DEFAULT_MOB_RULE] })
  const [rule] = config.rules
  assert.equal(rule.actions.length, 2)
  assert.equal(rule.actions[0].notificationState, 'emergency')
  assert.equal(rule.actions[1].clearMessage, 'Person Overboard Cleared')
})

test('per-rule activeStates override the plugin-wide list', () => {
  const config = normalizeOptions({
    activeStates: ['alarm'],
    rules: [
      { inputPath: 'a' },
      { inputPath: 'b', activeStates: ['emergency'] }
    ]
  })
  assert.deepEqual(config.rules[0].activeStates, ['alarm'])
  assert.deepEqual(config.rules[1].activeStates, ['emergency'])
})
