import test from 'node:test'
import assert from 'node:assert/strict'
import { createNotificationClickHandoff, routeDesktopNotificationClick } from '../src/main/notification-click-handoff.mjs'

const scope = { workspaceId: 4, launchNonce: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }
const otherWorkspace = { workspaceId: 9, launchNonce: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }
const reloadedRuntime = { workspaceId: 4, launchNonce: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }
const secret = 'sk-SECRETVALUE'

function target(key, sessionId = 'chat-7') {
    return { key, kind: 'done', agentId: 'coworker-7', sessionId, groupId: 'group-7', title: 'Coworker', body: secret }
}

test('a click before board subscription or during reload is delivered once to that workspace runtime', () => {
    const handoff = createNotificationClickHandoff()
    const seen = []
    assert.equal(handoff.accept(target('event:startup', 'chat-startup'), scope), 'held')
    assert.deepEqual(handoff.flush(scope, () => false), [])
    assert.equal(handoff.snapshot().held.length, 1)
    assert.deepEqual(handoff.flush(scope, value => { seen.push(value); return true }), [
        { key: 'event:startup', kind: 'done', agentId: 'coworker-7', sessionId: 'chat-startup', groupId: 'group-7' },
    ])
    assert.equal(seen.length, 1)
    assert.equal(seen[0].sessionId, 'chat-startup')
    assert.equal('title' in seen[0], false)
    assert.equal('body' in seen[0], false)
    assert.deepEqual(handoff.flush(scope, () => true), [])
    assert.equal(handoff.accept(target('event:reload', 'chat-reload'), scope), 'held')
    assert.deepEqual(handoff.flush(scope, () => false), [])
    const reloaded = []
    assert.deepEqual(handoff.flush(scope, value => { reloaded.push(value); return true }).map(value => value.sessionId), ['chat-reload'])
    assert.deepEqual(handoff.flush(scope, () => true), [])
    assert.equal(reloaded.length, 1)
})

test('a different workspace or launch nonce is not delivered', () => {
    const handoff = createNotificationClickHandoff()
    assert.equal(handoff.accept(target('event:workspace'), scope), 'held')
    handoff.retain(otherWorkspace)
    const delivered = []
    assert.deepEqual(handoff.flush(otherWorkspace, value => { delivered.push(value); return true }), [])
    assert.equal(delivered.length, 0)
    assert.equal(handoff.snapshot().diagnostics.some(entry => entry.reason === 'stale-workspace' && entry.sessionId === 'chat-7'), true)
    assert.equal(handoff.accept(target('event:runtime'), scope), 'held')
    handoff.retain(reloadedRuntime)
    assert.deepEqual(handoff.flush(reloadedRuntime, () => true), [])
    assert.equal(handoff.snapshot().diagnostics.some(entry => entry.reason === 'stale-runtime' && entry.key === 'event:runtime'), true)
})

test('retain without a concrete runtime keeps the same queue', () => {
    const handoff = createNotificationClickHandoff()
    handoff.accept(target('event:kept'), scope)
    handoff.retain(null)
    handoff.retain({})
    assert.deepEqual(handoff.snapshot().held.map(item => item.key), ['event:kept'])
})

test('the queue stays bounded and a duplicate key is dropped', () => {
    const handoff = createNotificationClickHandoff()
    for (let index = 0; index < 8; index += 1) assert.equal(handoff.accept(target(`event:${index}`), scope), 'held')
    assert.equal(handoff.accept(target('event:0'), scope), 'dropped')
    assert.equal(handoff.accept(target('event:foreign'), otherWorkspace), 'held')
    const held = handoff.snapshot().held
    assert.equal(held.length, 8)
    assert.equal(held.some(item => item.key === 'event:foreign' && item.workspaceId === 9), true)
    assert.equal(held.filter(item => item.workspaceId === 4).length, 7)
    assert.equal(handoff.snapshot().diagnostics.some(entry => entry.reason === 'queue-bound'), true)
    assert.equal(handoff.snapshot().diagnostics.some(entry => entry.reason === 'duplicate' && entry.key === 'event:0'), true)
})

test('a malformed click, a committed quit, and diagnostics omit notification copy', () => {
    const handoff = createNotificationClickHandoff()
    assert.equal(handoff.accept({ ...target('event:bad'), sessionId: null }, scope), 'dropped')
    assert.equal(handoff.accept(target('event:quit', 'chat-quit'), scope), 'held')
    handoff.stop()
    assert.deepEqual(handoff.flush(scope, () => true), [])
    assert.deepEqual(handoff.snapshot().held, [])
    assert.equal(handoff.accept(target('event:after-quit'), scope), 'dropped')
    const diagnostics = handoff.snapshot().diagnostics
    assert.equal(diagnostics.every(entry => entry.outcome === 'held' || entry.outcome === 'dropped'), true)
    assert.equal(diagnostics.some(entry => entry.reason === 'malformed'), true)
    assert.equal(diagnostics.some(entry => entry.reason === 'quitting' && entry.sessionId === 'chat-quit'), true)
    assert.equal(JSON.stringify(diagnostics).includes(secret), false)
    assert.equal(JSON.stringify(diagnostics).includes('Coworker'), false)
})

test('a click switches to its submitted workspace before handing the target to the current runtime', async () => {
    let current = otherWorkspace
    let complete
    const switched = new Promise(resolve => { complete = resolve })
    const steps = []
    const handoff = createNotificationClickHandoff()
    const route = routeDesktopNotificationClick(target('event:return'), scope, {
        currentScope: () => current,
        switchWorkspace: workspaceId => { steps.push(workspaceId); return switched },
        deliver: (value, scope) => handoff.accept(value, scope),
    })
    assert.deepEqual(steps, [scope.workspaceId])
    assert.equal(handoff.snapshot().held.length, 0)
    current = reloadedRuntime
    complete({ ok: true })
    assert.equal(await route, true)
    assert.deepEqual(handoff.snapshot().held, [{ key: 'event:return', ...reloadedRuntime, sessionId: 'chat-7' }])
    assert.deepEqual(handoff.flush(current, () => true).map(item => item.sessionId), ['chat-7'])

    assert.equal(await routeDesktopNotificationClick(target('event:reopen'), scope, {
        currentScope: () => current,
        switchWorkspace: () => assert.fail('Already in the owning workspace'),
        deliver: (value, scope) => handoff.accept(value, scope),
    }), true)
    assert.deepEqual(handoff.flush(current, () => true).map(item => item.sessionId), ['chat-7'])
})

test('a refused switch or changed workspace cannot deliver the notice', async () => {
    for (const result of [{ ok: false }, { ok: true }]) {
        let switches = 0
        assert.equal(await routeDesktopNotificationClick(target('event:blocked'), scope, {
            currentScope: () => otherWorkspace,
            switchWorkspace: async () => { switches++; return result },
            deliver: () => assert.fail('Unexpected delivery'),
        }), false)
        assert.equal(switches, 1)
    }
    assert.equal(await routeDesktopNotificationClick(target('event:quitting'), scope, {
        currentScope: () => null,
        switchWorkspace: () => assert.fail('No active runtime'),
        deliver: () => assert.fail('Unexpected delivery'),
    }), false)
})
