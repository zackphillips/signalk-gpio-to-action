'use strict'

const test = require('node:test')
const assert = require('node:assert')
const { GestureMachine } = require('../lib/gesture-machine')
const { FakeClock } = require('./helpers')

function build (options = {}) {
  const clock = new FakeClock()
  const events = []
  const machine = new GestureMachine(Object.assign({
    clock: clock.interface,
    emit: (gesture) => events.push(gesture),
    initialGraceMs: 0,
    debounceMs: 100,
    holdMs: 5000,
    holdEnabled: true
  }, options))
  machine.start()
  return { clock, events, machine }
}

test('press and release emit press, release and shortPress', () => {
  const { clock, events, machine } = build()
  machine.handle('pressed')
  clock.advance(200)
  machine.handle('released')
  assert.deepEqual(events, ['press', 'release', 'shortPress'])
})

test('repeated identical readings collapse to one edge', () => {
  const { clock, events, machine } = build()
  machine.handle('pressed')
  clock.advance(200)
  assert.equal(machine.handle('pressed'), 'repeat')
  assert.equal(machine.handle('pressed'), 'repeat')
  clock.advance(200)
  machine.handle('released')
  assert.deepEqual(events, ['press', 'release', 'shortPress'])
})

test('edges inside the debounce window are dropped', () => {
  const { clock, events, machine } = build({ debounceMs: 100 })
  machine.handle('pressed')
  clock.advance(20)
  assert.equal(machine.handle('released'), 'bounce')
  clock.advance(20)
  assert.equal(machine.handle('pressed'), 'repeat')
  clock.advance(200)
  machine.handle('released')
  assert.deepEqual(events, ['press', 'release', 'shortPress'])
  assert.equal(machine.stats.bounces, 1)
})

test('holding past the hold time emits hold then holdRelease', () => {
  const { clock, events, machine } = build({ holdMs: 5000 })
  machine.handle('pressed')
  clock.advance(5000)
  assert.deepEqual(events, ['press', 'hold'])
  clock.advance(500)
  machine.handle('released')
  assert.deepEqual(events, ['press', 'hold', 'release', 'holdRelease'])
})

test('releasing before the hold time cancels hold', () => {
  const { clock, events, machine } = build({ holdMs: 5000 })
  machine.handle('pressed')
  clock.advance(4999)
  machine.handle('released')
  clock.advance(10000)
  assert.deepEqual(events, ['press', 'release', 'shortPress'])
})

test('unknown readings are ignored', () => {
  const { events, machine } = build()
  assert.equal(machine.handle('unknown'), 'ignored')
  assert.deepEqual(events, [])
})

test('double press cancels the pending shortPress', () => {
  const { clock, events, machine } = build({ doubleEnabled: true, doublePressMs: 400 })
  machine.handle('pressed')
  clock.advance(120)
  machine.handle('released')
  assert.deepEqual(events, ['press', 'release'])
  clock.advance(200)
  machine.handle('pressed')
  assert.deepEqual(events, ['press', 'release', 'press', 'doublePress'])
  clock.advance(150)
  machine.handle('released')
  clock.advance(1000)
  assert.deepEqual(events, ['press', 'release', 'press', 'doublePress', 'release'])
})

test('a lone short press still resolves after the double press window', () => {
  const { clock, events, machine } = build({ doubleEnabled: true, doublePressMs: 400 })
  machine.handle('pressed')
  clock.advance(120)
  machine.handle('released')
  clock.advance(401)
  assert.deepEqual(events, ['press', 'release', 'shortPress'])
})

test('a cached pressed value replayed at startup fires nothing', () => {
  const { clock, events, machine } = build({ initialGraceMs: 1500 })
  assert.equal(machine.handle('pressed'), 'absorbed')
  clock.advance(300)
  assert.equal(machine.handle('released'), 'absorbed')
  assert.deepEqual(events, [])

  clock.advance(2000)
  machine.handle('pressed')
  clock.advance(200)
  machine.handle('released')
  assert.deepEqual(events, ['press', 'release', 'shortPress'])
})

test('a real press after the grace window is not absorbed', () => {
  const { clock, events, machine } = build({ initialGraceMs: 1500 })
  clock.advance(1600)
  machine.handle('pressed')
  assert.deepEqual(events, ['press'])
})

test('stop clears pending timers', () => {
  const { clock, events, machine } = build({ holdMs: 5000 })
  machine.handle('pressed')
  machine.stop()
  clock.advance(10000)
  assert.deepEqual(events, ['press'])
})
