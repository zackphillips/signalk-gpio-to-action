'use strict'

const test = require('node:test')
const assert = require('node:assert')
const { ActionRunner, normalizeNotificationPath, collectNotifications, parseValue } = require('../lib/actions')
const { FakeApp, FakeClock } = require('./helpers')

function runner (tree = {}, options = {}) {
  const app = new FakeApp(tree)
  const clock = new FakeClock()
  return {
    app,
    clock,
    runner: new ActionRunner(Object.assign({ app, pluginId: 'test', clock: clock.interface }, options))
  }
}

test('notification paths get the notifications prefix when missing', () => {
  assert.equal(normalizeNotificationPath('mob.GPIO18'), 'notifications.mob.GPIO18')
  assert.equal(normalizeNotificationPath('notifications.mob.GPIO18'), 'notifications.mob.GPIO18')
  assert.equal(normalizeNotificationPath('  '), null)
})

test('raise sends a full notification value', () => {
  const { app, runner: r } = runner()
  r.raise({
    notificationPath: 'mob.GPIO18',
    notificationState: 'emergency',
    notificationMessage: 'Person Overboard!',
    notificationMethods: ['visual', 'sound']
  })
  const [written] = app.written()
  assert.equal(written.path, 'notifications.mob.GPIO18')
  assert.equal(written.value.state, 'emergency')
  assert.equal(written.value.message, 'Person Overboard!')
  assert.deepEqual(written.value.method, ['visual', 'sound'])
  assert.ok(written.value.timestamp)
})

test('extra notification properties are merged in', () => {
  const { app, runner: r } = runner()
  r.raise({
    notificationPath: 'mob.GPIO18',
    notificationState: 'emergency',
    notificationExtra: '{"id":"mob-button"}'
  })
  assert.equal(app.written()[0].value.id, 'mob-button')
})

test('clear sets normal with no methods', () => {
  const { app, runner: r } = runner()
  r.clear({ notificationPath: 'mob.GPIO18', clearMessage: 'Person Overboard Cleared' })
  const [written] = app.written()
  assert.equal(written.value.state, 'normal')
  assert.equal(written.value.message, 'Person Overboard Cleared')
  assert.deepEqual(written.value.method, [])
})

test('clear in delete mode sends a null value', () => {
  const { app, runner: r } = runner()
  r.clear({ notificationPath: 'mob.GPIO18', clearMode: 'delete' })
  assert.equal(app.written()[0].value, null)
})

test('autoClearMs clears the notification later', () => {
  const { app, clock, runner: r } = runner()
  r.raise({ notificationPath: 'mob.GPIO18', notificationState: 'alarm', autoClearMs: 30000 })
  assert.equal(app.written().length, 1)
  clock.advance(30000)
  const written = app.written()
  assert.equal(written.length, 2)
  assert.equal(written[1].value.state, 'normal')
})

test('isActive reads the current tree', () => {
  const tree = { notifications: { mob: { GPIO18: { value: { state: 'emergency' } } } } }
  const { runner: r } = runner(tree)
  assert.equal(r.isActive('mob.GPIO18'), true)
  assert.equal(r.isActive('notifications.mob.GPIO18'), true)
  assert.equal(r.isActive('mob.other'), false)
})

test('a normal notification does not count as active', () => {
  const tree = { notifications: { mob: { GPIO18: { value: { state: 'normal' } } } } }
  assert.equal(runner(tree).runner.isActive('mob.GPIO18'), false)
})

test('conditions use the press-time snapshot by default', () => {
  const tree = { notifications: { mob: { GPIO18: { value: { state: 'normal' } } } } }
  const { runner: r, app } = runner(tree)
  const ctx = { snapshot: r.snapshot(['notifications.mob.GPIO18']) }

  // The raise happens, so the live tree now says active...
  r.raise({ notificationPath: 'mob.GPIO18', notificationState: 'emergency' })
  assert.equal(r.isActive('mob.GPIO18'), true)

  const clearAction = {
    type: 'clear',
    condition: 'targetActive',
    notificationPath: 'mob.GPIO18'
  }
  // ...but the snapshot from before the press still says inactive.
  assert.equal(r.conditionMet(clearAction, ctx, { conditionMode: 'press' }), false)
  assert.equal(r.conditionMet(clearAction, ctx, { conditionMode: 'fire' }), true)
  assert.equal(app.written().length, 1)
})

test('toggle raises then clears', () => {
  const { app, runner: r } = runner()
  const action = { notificationPath: 'anchor.alarm', notificationState: 'alarm', notificationMessage: 'Dragging' }
  r.run(Object.assign({ type: 'toggle' }, action))
  assert.equal(app.written()[0].value.state, 'alarm')
  r.run(Object.assign({ type: 'toggle' }, action))
  assert.equal(app.written()[1].value.state, 'normal')
})

test('silence strips sound from active notifications', () => {
  const tree = {
    notifications: {
      mob: { GPIO18: { value: { state: 'emergency', message: 'MOB', method: ['visual', 'sound'] } } },
      anchor: { alarm: { value: { state: 'alarm', message: 'Dragging', method: ['visual', 'sound'] } } },
      quiet: { one: { value: { state: 'normal', message: 'fine', method: [] } } }
    }
  }
  const { app, runner: r } = runner(tree)
  const outcome = r.silence({ silenceMode: 'sound', silenceExcludePaths: ['notifications.mob'] })
  const written = app.written()
  assert.equal(written.length, 1)
  assert.equal(written[0].path, 'notifications.anchor.alarm')
  assert.deepEqual(written[0].value.method, ['visual'])
  assert.equal(written[0].value.state, 'alarm')
  assert.match(outcome, /silenced 1/)
})

test('silence in all mode drops every method, honouring path filters', () => {
  const tree = {
    notifications: {
      anchor: { alarm: { value: { state: 'alarm', method: ['visual', 'sound'] } } },
      engine: { overTemp: { value: { state: 'warn', method: ['sound'] } } }
    }
  }
  const { app, runner: r } = runner(tree)
  r.silence({ silenceMode: 'all', silencePaths: ['anchor'] })
  const written = app.written()
  assert.equal(written.length, 1)
  assert.equal(written[0].path, 'notifications.anchor.alarm')
  assert.deepEqual(written[0].value.method, [])
})

test('silence reports when nothing is making noise', () => {
  const { app, runner: r } = runner({ notifications: {} })
  assert.match(r.silence({ silenceMode: 'all' }), /nothing active/)
  assert.equal(app.written().length, 0)
})

test('delta and put actions', () => {
  const { app, runner: r } = runner()
  r.run({ type: 'delta', deltaPath: 'electrical.switches.deck.state', deltaValue: 'true' })
  assert.deepEqual(app.written()[0], { path: 'electrical.switches.deck.state', value: true })

  r.run({ type: 'put', putPath: 'electrical.switches.deck.state', putValue: '1' })
  assert.deepEqual(app.puts[0], { path: 'electrical.switches.deck.state', value: 1 })
})

test('unknown action types throw', () => {
  const { runner: r } = runner()
  assert.throws(() => r.run({ type: 'nonsense' }), /unknown action type/)
})

test('parseValue falls back to the raw string', () => {
  assert.equal(parseValue('true'), true)
  assert.equal(parseValue('42'), 42)
  assert.equal(parseValue('on'), 'on')
  assert.equal(parseValue(''), undefined)
  assert.deepEqual(parseValue('{"a":1}'), { a: 1 })
})

test('collectNotifications walks the tree', () => {
  const found = collectNotifications({
    mob: { GPIO18: { value: { state: 'emergency' }, timestamp: 'x', $source: 'y' } },
    nested: { deep: { one: { value: { state: 'warn' } } } }
  }, [], [])
  assert.deepEqual(found.map((f) => f.path).sort(), [
    'notifications.mob.GPIO18',
    'notifications.nested.deep.one'
  ])
})
