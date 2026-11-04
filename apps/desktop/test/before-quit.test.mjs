import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BeforeQuitDrafts, completeDesktopQuit } from '../src/main/before-quit.mjs'

function harness() {
    let sequence = 0
    const timers = new Map()
    const gate = new BeforeQuitDrafts({
        nextId: () => `request-${++sequence}`,
        schedule: callback => { const id = Symbol(); timers.set(id, callback); return id },
        cancel: id => timers.delete(id),
    })
    return { gate, timers, expire: () => { for (const callback of [...timers.values()]) callback() } }
}

test('startup or error pages without a registered draft saver need no request or warning', async () => {
    const { gate, timers } = harness()
    const events = []
    assert.equal(await completeDesktopQuit({
        flush: () => gate.request(() => assert.fail('No renderer request expected')),
        confirmDiscard: () => assert.fail('No warning expected'),
        stop: async () => { events.push('stop') },
        quit: () => { events.push('quit') },
        cancelled: () => assert.fail('Successful quit must keep the renderer frozen'),
    }), true)
    assert.deepEqual(events, ['stop', 'quit'])
    assert.equal(timers.size, 0)
})

test('only the matching registration and request ACK can allow a pending save to finish', async () => {
    const { gate, timers } = harness()
    gate.register('document-a')
    let request
    const pending = gate.request(value => { request = value })
    assert.equal(gate.request(() => assert.fail('Duplicate quit must share the request')), pending)
    gate.acknowledge({ ...request, requestId: 'old-request', saved: true })
    gate.acknowledge({ ...request, registrationId: 'other-document', saved: true })
    assert.equal(timers.size, 1)
    gate.acknowledge({ ...request, saved: true })
    assert.equal(await pending, true)
    assert.equal(timers.size, 0)
})

test('truthy non-boolean ACKs refuse quit instead of claiming the draft was saved', async () => {
    const { gate } = harness()
    gate.register('document-a')
    for (const saved of [false, undefined, 'true', 1, {}]) {
        let request
        const pending = gate.request(value => { request = value })
        gate.acknowledge({ ...request, saved })
        assert.equal(await pending, false)
    }
})

test('timeout ignores its late ACK and the same registered page can save on the next quit', async () => {
    const { gate, expire, timers } = harness()
    gate.register('document-a')
    let first
    const timedOut = gate.request(value => { first = value })
    expire()
    assert.equal(await timedOut, false)
    assert.equal(timers.size, 0)
    let retry
    const pending = gate.request(value => { retry = value })
    assert.notEqual(first.requestId, retry.requestId)
    gate.acknowledge({ ...first, saved: true })
    assert.equal(timers.size, 1)
    gate.acknowledge({ ...retry, saved: true })
    assert.equal(await pending, true)
})

test('navigation and listener replacement invalidate old registrations without clearing the newer one', async () => {
    const { gate } = harness()
    gate.register('document-a')
    let first
    const pending = gate.request(value => { first = value })
    gate.register('document-b')
    assert.equal(await pending, false)
    gate.unregister('document-a')
    assert.equal(gate.ready, true)
    let next
    const replacement = gate.request(value => { next = value })
    gate.acknowledge({ ...first, saved: true })
    gate.reset()
    assert.equal(await replacement, false)
    assert.equal(gate.ready, false)
    gate.acknowledge({ ...next, saved: true })
    assert.equal(await gate.request(() => assert.fail('No listener after navigation')), true)
})

test('a failed renderer delivery becomes a save failure with no pending timer', async () => {
    const { gate, timers } = harness()
    gate.register('document-a')
    assert.equal(await gate.request(() => { throw new Error('Renderer closed') }), false)
    assert.equal(timers.size, 0)
})

test('Stay or a failed native dialog preserves the running workspace and permits a subsequent quit', async () => {
    const events = []
    const actions = {
        flush: async () => { events.push('flush'); return false },
        stop: async () => { events.push('stop') },
        quit: () => { events.push('quit') },
        cancelled: () => { events.push('resume-editing') },
    }
    assert.equal(await completeDesktopQuit({ ...actions, confirmDiscard: async () => false }), false)
    assert.equal(await completeDesktopQuit({ ...actions, confirmDiscard: async () => { throw new Error('Dialog unavailable') } }), false)
    assert.deepEqual(events, ['flush', 'resume-editing', 'flush', 'resume-editing'])
    assert.equal(await completeDesktopQuit({ ...actions, confirmDiscard: async () => true }), true)
    assert.deepEqual(events, ['flush', 'resume-editing', 'flush', 'resume-editing', 'flush', 'stop', 'quit'])
})

test('successful flush precedes stopping, and stopping completes before final quit', async () => {
    const events = []
    let finishSave
    let finishStop
    const result = completeDesktopQuit({
        flush: () => new Promise(resolve => { events.push('flush'); finishSave = resolve }),
        confirmDiscard: () => assert.fail('No warning for an accepted save'),
        stop: () => new Promise(resolve => { events.push('stop'); finishStop = resolve }),
        quit: () => { events.push('quit') },
        cancelled: () => assert.fail('Successful save must remain frozen through stop'),
    })
    assert.deepEqual(events, ['flush'])
    finishSave(true)
    await Promise.resolve()
    assert.deepEqual(events, ['flush', 'stop'])
    finishStop()
    assert.equal(await result, true)
    assert.deepEqual(events, ['flush', 'stop', 'quit'])
})

test('a save timeout keeps editing frozen through the warning and resumes only after Stay', async () => {
    const { gate, expire } = harness()
    gate.register('document-a')
    const events = []
    let choose
    const result = completeDesktopQuit({
        flush: () => { events.push('freeze'); return gate.request(() => {}) },
        confirmDiscard: () => new Promise(resolve => { events.push('warning'); choose = resolve }),
        stop: () => assert.fail('Stay must not stop the workspace'),
        quit: () => assert.fail('Stay must not quit'),
        cancelled: () => { events.push('resume-editing') },
    })
    expire()
    await Promise.resolve()
    assert.deepEqual(events, ['freeze', 'warning'])
    choose(false)
    assert.equal(await result, false)
    assert.deepEqual(events, ['freeze', 'warning', 'resume-editing'])
})
