'use strict'

const test = require('node:test')
const assert = require('node:assert')
const { PressDetector } = require('../lib/press-detector')

test('openplotter GPIO notification: message is the discriminator', () => {
  const d = new PressDetector()
  assert.equal(d.read({ state: 'normal', message: 'Pressed' }), 'pressed')
  assert.equal(d.read({ state: 'normal', message: 'Not Pressed' }), 'released')
})

test('exact match is not fooled by "Not Pressed" containing "Pressed"', () => {
  const d = new PressDetector({ matchType: 'exact' })
  assert.equal(d.read({ message: 'Not Pressed' }), 'released')
})

test('contains match still resolves the Pressed / Not Pressed pair', () => {
  const d = new PressDetector({ matchType: 'contains' })
  assert.equal(d.read({ message: 'Not Pressed' }), 'released')
  assert.equal(d.read({ message: 'Pressed' }), 'pressed')
})

test('case insensitive by default, case sensitive on request', () => {
  assert.equal(new PressDetector().read({ message: 'pressed' }), 'pressed')
  assert.equal(new PressDetector({ caseSensitive: true }).read({ message: 'pressed' }), 'unknown')
})

test('invert swaps the reading for active-low wiring', () => {
  const d = new PressDetector({ invert: true })
  assert.equal(d.read({ message: 'Pressed' }), 'released')
  assert.equal(d.read({ message: 'Not Pressed' }), 'pressed')
})

test('truthy mode handles booleans, numbers and words', () => {
  const d = new PressDetector({ mode: 'truthy' })
  assert.equal(d.read(true), 'pressed')
  assert.equal(d.read(false), 'released')
  assert.equal(d.read(1), 'pressed')
  assert.equal(d.read(0), 'released')
  assert.equal(d.read('on'), 'pressed')
  assert.equal(d.read('off'), 'released')
})

test('threshold mode compares numerically', () => {
  const d = new PressDetector({ mode: 'threshold', threshold: 2.5, comparison: '<' })
  assert.equal(d.read(1.2), 'pressed')
  assert.equal(d.read(3.0), 'released')
})

test('regex match type', () => {
  const d = new PressDetector({ matchType: 'regex', pressedValues: ['^down$'], releasedValues: ['^up$'] })
  assert.equal(d.read({ message: 'down' }), 'pressed')
  assert.equal(d.read({ message: 'up' }), 'released')
  assert.equal(d.read({ message: 'sideways' }), 'unknown')
})

test('source override reads the state field', () => {
  const d = new PressDetector({
    source: 'state',
    pressedValues: ['alarm'],
    releasedValues: ['normal']
  })
  assert.equal(d.read({ state: 'alarm', message: 'Not Pressed' }), 'pressed')
})

test('unmatched values can be treated as released', () => {
  const d = new PressDetector({ unmatched: 'released' })
  assert.equal(d.read({ message: 'garbage' }), 'released')
})

test('null and undefined values fall through to the unmatched rule', () => {
  const d = new PressDetector()
  assert.equal(d.read(null), 'unknown')
  assert.equal(d.read({ state: 'normal' }), 'unknown')
})
