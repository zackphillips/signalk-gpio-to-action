'use strict'

const test = require('node:test')
const assert = require('node:assert')
const { setTimeout: sleep } = require('node:timers/promises')
const pluginFactory = require('../index.js')
const { FakeApp } = require('./helpers')

// Real timers, short windows: the whole file runs in well under a second.
const HOLD_MS = 80
const DEBOUNCE_MS = 10

function mobRule (overrides = {}) {
  return Object.assign({
    enabled: true,
    name: 'MOB button on GPIO18',
    inputPath: 'notifications.GPIO18',
    conditionMode: 'press',
    timing: { debounceMs: DEBOUNCE_MS, holdMs: HOLD_MS, doublePressMs: 0, initialGraceMs: 0 },
    actions: [
      {
        label: 'Raise MOB',
        trigger: 'press',
        type: 'raise',
        condition: 'targetInactive',
        notificationPath: 'notifications.mob.GPIO18',
        notificationState: 'emergency',
        notificationMessage: 'Person Overboard!',
        notificationMethods: ['visual', 'sound']
      },
      {
        label: 'Clear MOB on release after hold',
        trigger: 'holdRelease',
        type: 'clear',
        condition: 'targetActive',
        notificationPath: 'notifications.mob.GPIO18',
        clearMessage: 'Person Overboard Cleared'
      }
    ]
  }, overrides)
}

function start (rules, tree = {}) {
  const app = new FakeApp(tree)
  const plugin = pluginFactory(app)
  plugin.start({ rules })
  return { app, plugin }
}

const press = (app) => app.send('notifications.GPIO18', { state: 'normal', message: 'Pressed' })
const release = (app) => app.send('notifications.GPIO18', { state: 'normal', message: 'Not Pressed' })

test('press raises the MOB notification', async (t) => {
  const { app, plugin } = start([mobRule()])
  t.after(() => plugin.stop())

  press(app)
  const [written] = app.written()
  assert.equal(written.path, 'notifications.mob.GPIO18')
  assert.equal(written.value.state, 'emergency')
  assert.equal(written.value.message, 'Person Overboard!')
  assert.deepEqual(written.value.method, ['visual', 'sound'])
})

test('a panic hold from idle raises only, it never clears', async (t) => {
  const { app, plugin } = start([mobRule()])
  t.after(() => plugin.stop())

  press(app)
  await sleep(HOLD_MS * 3)
  release(app)
  await sleep(DEBOUNCE_MS * 4)

  const written = app.written()
  assert.equal(written.length, 1, 'the release must not clear the alarm the same press raised')
  assert.equal(written[0].value.state, 'emergency')
})

test('a button stuck closed raises once and never clears', async (t) => {
  const { app, plugin } = start([mobRule()])
  t.after(() => plugin.stop())

  press(app) // shorted switch: down forever, no release
  await sleep(HOLD_MS * 4)

  const written = app.written()
  assert.equal(written.length, 1, 'a stuck button must not silently disarm MOB')
  assert.equal(written[0].value.state, 'emergency')
})

test('press then a long hold released while MOB is active clears it', async (t) => {
  const { app, plugin } = start([mobRule()])
  t.after(() => plugin.stop())

  press(app)
  await sleep(DEBOUNCE_MS * 2)
  release(app)
  await sleep(DEBOUNCE_MS * 2)

  press(app) // MOB already active: the raise is skipped
  await sleep(HOLD_MS * 2)
  assert.equal(app.written().length, 1, 'nothing happens until the button comes back up')

  release(app)
  await sleep(DEBOUNCE_MS * 2)

  const written = app.written()
  assert.equal(written.length, 2)
  assert.equal(written[1].value.state, 'normal')
  assert.equal(written[1].value.message, 'Person Overboard Cleared')
  assert.deepEqual(written[1].value.method, [])
})

test('releasing before the hold time leaves MOB up', async (t) => {
  const { app, plugin } = start([mobRule()])
  t.after(() => plugin.stop())

  press(app)
  await sleep(DEBOUNCE_MS * 2)
  release(app)
  await sleep(DEBOUNCE_MS * 2)
  press(app)
  await sleep(HOLD_MS / 2)
  release(app)
  await sleep(HOLD_MS * 2)

  assert.equal(app.written().length, 1)
})

test('repeated Pressed deltas while held collapse to one press', async (t) => {
  const { app, plugin } = start([mobRule()])
  t.after(() => plugin.stop())

  press(app)
  press(app)
  press(app)
  assert.equal(app.written().length, 1)
})

test('deltas from other sources are ignored when a source filter is set', async (t) => {
  const { app, plugin } = start([mobRule({ sourceFilter: 'gpio' })])
  t.after(() => plugin.stop())

  app.send('notifications.GPIO18', { state: 'normal', message: 'Pressed' }, 'n2k.0')
  assert.equal(app.written().length, 0)

  app.send('notifications.GPIO18', { state: 'normal', message: 'Pressed' }, 'gpio.18')
  assert.equal(app.written().length, 1)
})

test('a value replayed inside the startup grace window fires nothing', async (t) => {
  const { app, plugin } = start([mobRule({
    timing: { debounceMs: DEBOUNCE_MS, holdMs: HOLD_MS, doublePressMs: 0, initialGraceMs: 60 }
  })])
  t.after(() => plugin.stop())

  press(app)
  assert.equal(app.written().length, 0, 'a cached Pressed must not raise MOB on restart')

  await sleep(80)
  release(app)
  await sleep(20)
  press(app)
  assert.equal(app.written().length, 1)
})

test('condition mode "fire" re-reads the tree and lets one press-and-hold clear its own raise', async (t) => {
  const { app, plugin } = start([mobRule({ conditionMode: 'fire' })])
  t.after(() => plugin.stop())

  press(app)
  await sleep(HOLD_MS * 2)
  release(app)
  await sleep(DEBOUNCE_MS * 2)

  const written = app.written()
  assert.equal(written.length, 2)
  assert.equal(written[1].value.state, 'normal')
})

test('a silence button strips sound from everything except MOB', async (t) => {
  const tree = {
    notifications: {
      mob: { GPIO18: { value: { state: 'emergency', method: ['visual', 'sound'] } } },
      anchor: { alarm: { value: { state: 'alarm', method: ['visual', 'sound'] } } }
    }
  }
  const { app, plugin } = start([{
    name: 'Silence button on GPIO23',
    inputPath: 'notifications.GPIO23',
    timing: { debounceMs: DEBOUNCE_MS, holdMs: 0, initialGraceMs: 0 },
    actions: [{
      label: 'Silence',
      trigger: 'press',
      type: 'silence',
      silenceMode: 'sound',
      silenceExcludePaths: ['notifications.mob']
    }]
  }], tree)
  t.after(() => plugin.stop())

  app.send('notifications.GPIO23', { state: 'normal', message: 'Pressed' })
  const written = app.written()
  assert.equal(written.length, 1)
  assert.equal(written[0].path, 'notifications.anchor.alarm')
  assert.deepEqual(written[0].value.method, ['visual'])
})

test('a toggle button on a plain boolean path', async (t) => {
  const { app, plugin } = start([{
    name: 'Anchor alarm toggle',
    inputPath: 'electrical.switches.gpio24.state',
    timing: { debounceMs: DEBOUNCE_MS, holdMs: 0, initialGraceMs: 0 },
    detect: { mode: 'truthy' },
    actions: [{
      label: 'Toggle anchor alarm',
      trigger: 'press',
      type: 'toggle',
      notificationPath: 'anchor.armed',
      notificationState: 'alert',
      notificationMessage: 'Anchor alarm armed',
      notificationMethods: ['visual']
    }]
  }])
  t.after(() => plugin.stop())

  app.send('electrical.switches.gpio24.state', true)
  await sleep(DEBOUNCE_MS * 2)
  app.send('electrical.switches.gpio24.state', false)
  await sleep(DEBOUNCE_MS * 2)
  app.send('electrical.switches.gpio24.state', true)

  const written = app.written()
  assert.equal(written.length, 2)
  assert.equal(written[0].value.state, 'alert')
  assert.equal(written[1].value.state, 'normal')
})

test('disabled rules and actions do nothing', async (t) => {
  const { app, plugin } = start([mobRule({ enabled: false })])
  t.after(() => plugin.stop())
  press(app)
  assert.equal(app.written().length, 0)
  assert.equal(app.subscriptions.length, 0)
})

test('cooldown suppresses repeat actions', async (t) => {
  const rule = mobRule()
  rule.actions = [Object.assign({}, rule.actions[0], { condition: 'always', cooldownMs: 10000 })]
  const { app, plugin } = start([rule])
  t.after(() => plugin.stop())

  press(app)
  await sleep(DEBOUNCE_MS * 2)
  release(app)
  await sleep(DEBOUNCE_MS * 2)
  press(app)

  assert.equal(app.written().length, 1)
})

test('stop unsubscribes and cancels pending holds', async (t) => {
  const { app, plugin } = start([mobRule()])
  press(app)
  plugin.stop()
  await sleep(HOLD_MS * 2)
  assert.equal(app.written().length, 1)
  assert.equal(app.errors.length, 0)
})
