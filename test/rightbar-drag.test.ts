import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { rightbarDragAction, rightbarElasticWidth, RIGHTBAR_ELASTIC_MAX, RIGHTBAR_MIN, RIGHTBAR_SNAP_DISTANCE } from '../web/src/ui/layout/columns.ts'

test('right panel drag requires travel past the resize bounds, and dragging back cancels', () => {
  const max = 1008
  assert.equal(rightbarDragAction(max, max), null)
  assert.equal(rightbarDragAction(max + RIGHTBAR_SNAP_DISTANCE - 1, max), null)
  assert.equal(rightbarDragAction(max + RIGHTBAR_SNAP_DISTANCE, max), 'focus')
  assert.equal(rightbarDragAction(max - 10, max), null)
  assert.equal(rightbarDragAction(RIGHTBAR_MIN, max), null)
  assert.equal(rightbarDragAction(RIGHTBAR_MIN - RIGHTBAR_SNAP_DISTANCE + 1, max), null)
  assert.equal(rightbarDragAction(RIGHTBAR_MIN - RIGHTBAR_SNAP_DISTANCE, max), 'collapse')
  assert.equal(rightbarDragAction(RIGHTBAR_MIN + 10, max), null)
  assert.equal(rightbarElasticWidth(max, max), null)
  assert.equal(rightbarElasticWidth(max + 30, max), max + 10)
  assert.equal(rightbarElasticWidth(max + RIGHTBAR_SNAP_DISTANCE, max), max + RIGHTBAR_ELASTIC_MAX)
  assert.equal(rightbarElasticWidth(RIGHTBAR_MIN - 30, max), RIGHTBAR_MIN - 10)
  assert.equal(rightbarElasticWidth(RIGHTBAR_MIN - RIGHTBAR_SNAP_DISTANCE, max), RIGHTBAR_MIN - RIGHTBAR_ELASTIC_MAX)
  assert.equal(rightbarElasticWidth(RIGHTBAR_MIN + 1, max), null)
})
