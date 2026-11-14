import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { loadQuickAskShortcut } from '../src/main/quick-ask-shortcut.mjs'
import { QUICK_ASK_SHORTCUT } from '../src/main/quick-ask-window.mjs'

test('Quick Ask keeps the app-wide shortcut preference and reports OS registration separately', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'rerun-quick-ask-preference-'))
    const calls = []
    let available = true
    const globalShortcut = {
        register(key) { assert.equal(key, QUICK_ASK_SHORTCUT); calls.push('register'); return available },
        unregister(key) { assert.equal(key, QUICK_ASK_SHORTCUT); calls.push('unregister') },
    }
    const load = () => loadQuickAskShortcut({ dataRoot, globalShortcut, open() {} })
    const valid = () => {}
    try {
        const initial = await load()
        assert.deepEqual(initial.state(), { enabled: true, registered: true })
        await assert.rejects(initial.change(false, () => { throw new Error('Workspace changed') }), /Workspace changed/)
        assert.deepEqual(initial.state(), { enabled: true, registered: true })
        assert.deepEqual(await initial.change(false, valid), { enabled: false, registered: false })
        assert.deepEqual(calls, ['register', 'unregister'])
        await initial.flush()
        const restarted = await load()
        assert.deepEqual(restarted.state(), { enabled: false, registered: false })
        assert.deepEqual(calls, ['register', 'unregister'])
        available = false
        assert.deepEqual(await restarted.change(true, valid), { enabled: true, registered: false })
        assert.deepEqual(JSON.parse(await readFile(join(dataRoot, 'quick-ask.json'), 'utf8')), { version: 1, enabled: true })
        available = true
        assert.deepEqual(await restarted.change(true, valid), { enabled: true, registered: true })
        restarted.unregister()
        assert.deepEqual(calls, ['register', 'unregister', 'register', 'register', 'unregister'])
    } finally { await rm(dataRoot, { recursive: true, force: true }) }
})
