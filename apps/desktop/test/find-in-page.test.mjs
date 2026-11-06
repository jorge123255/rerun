import assert from 'node:assert/strict'
import test from 'node:test'
import { parseDesktopFindInput } from '../src/main/find-in-page.mjs'

test('accepts only start, next, previous, and stop with a bounded query', () => {
    assert.deepEqual(parseDesktopFindInput({ action: 'start', query: 'invoice' }), { action: 'start', query: 'invoice' })
    assert.deepEqual(parseDesktopFindInput({ action: 'next', query: 'invoice', url: 'file:///secret' }), { action: 'next', query: 'invoice' })
    assert.deepEqual(parseDesktopFindInput({ action: 'previous', query: '' }), { action: 'previous', query: '' })
    assert.deepEqual(parseDesktopFindInput({ action: 'stop', query: 'ignored' }), { action: 'stop' })
})

test('refuses commands, long text, and non-objects', () => {
    assert.equal(parseDesktopFindInput(null), null)
    assert.equal(parseDesktopFindInput(['start']), null)
    assert.equal(parseDesktopFindInput({ action: 'exec', query: 'ls' }), null)
    assert.equal(parseDesktopFindInput({ action: 'start', query: 'x'.repeat(201) }), null)
    assert.equal(parseDesktopFindInput({ action: 'start', query: 'bad\0query' }), null)
    assert.equal(parseDesktopFindInput({ action: 'start', query: 12 }), null)
})
