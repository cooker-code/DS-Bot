import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_WIDTH, DETAILS_WIDTH, widthRange, fitWidth, draggedWidth, trackPanelResize } from '../src/client/panel-width.js'

test('details can fill the available room while browser and side keep their ranges', () => {
  assert.equal(DEFAULT_WIDTH, 520)
  assert.equal(DETAILS_WIDTH, 320)
  assert.deepEqual(widthRange('details', 1200), [320, 1200])
  assert.deepEqual(widthRange('browser', 1200), [360, 780])
  assert.deepEqual(widthRange('side', 1200), [320, 520])
  assert.deepEqual(widthRange('details', 740), [320, 740])
  assert.deepEqual(widthRange('details', 250), [320, 320])
  for (const room of [740, 800, 1200, 2200]) {
    const width = fitWidth(10000, widthRange('details', room))
    assert.equal(width, room)
    assert.equal(fitWidth(0, widthRange('details', room)), 320)
  }
})
test('left drag grows and right drag shrinks, rounding and clamping both ends', () => {
  const range = widthRange('details', 1200)
  assert.equal(draggedWidth(320, 900, 500, range), 720)
  assert.equal(draggedWidth(720, 500, 900, range), 320)
  assert.equal(draggedWidth(320, 900, -900, range), 1200)
  assert.equal(draggedWidth(320, 900, 899.4, range), 321)
})
class Grip extends EventTarget {
  capture = false
  setPointerCapture() { this.capture = true }
  hasPointerCapture() { return this.capture }
  releasePointerCapture() { this.capture = false; this.send('lostpointercapture') }
  send(type, pointerId = 1, clientX = 500) {
    this.dispatchEvent(Object.assign(new Event(type), { pointerId, clientX }))
  }
}
for (const ending of ['pointerup', 'pointercancel', 'lostpointercapture', 'layout/unmount']) {
  test(`${ending} finishes exactly once, drops listeners and releases capture`, () => {
    const grip = new Grip()
    const moves = []
    let finishes = 0
    const stop = trackPanelResize(grip, { pointerId: 1 }, e => moves.push(e.clientX), () => finishes++)
    assert.equal(grip.capture, true)
    grip.send('pointermove', 2)
    grip.send('pointerup', 2)
    assert.equal(finishes, 0)
    grip.send('pointermove', 1, 600)
    if (ending === 'layout/unmount') stop()
    else grip.send(ending, 1, 700)
    stop()
    grip.send('pointermove')
    grip.send('pointerup')
    assert.deepEqual(moves, ending === 'pointerup' ? [600, 700] : [600])
    assert.equal(finishes, 1)
    assert.equal(grip.capture, false)
  })
}
test('failed capture cleans up and permits a later drag', () => {
  const grip = new Grip()
  grip.setPointerCapture = () => { throw new Error('detached') }
  let finishes = 0
  assert.equal(trackPanelResize(grip, { pointerId: 1 }, () => assert.fail('listener leaked'), () => finishes++), null)
  grip.send('pointermove')
  assert.equal(finishes, 1)
})
