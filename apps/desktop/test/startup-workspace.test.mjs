import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { hasLocalWorkspace } from '../src/main/startup-workspace.mjs'

test('remembering a server does not turn a fresh profile into a local workspace', async t => {
    const root = await mkdtemp(join(tmpdir(), 'rerun-startup-'))
    t.after(() => rm(root, { recursive: true, force: true }))
    assert.equal(await hasLocalWorkspace(root), false)
    await writeFile(join(root, 'connected-hub.json'), '{"origin":"https://example.test"}')
    assert.equal(await hasLocalWorkspace(root), false)
    assert.deepEqual(await readdir(root), ['connected-hub.json'])
    for (const entry of ['identity.encrypted', 'app.db', 'workspaces']) {
        const path = join(root, entry)
        if (entry === 'workspaces') await mkdir(path)
        else await writeFile(path, 'fixture')
        assert.equal(await hasLocalWorkspace(root), true)
        await rm(path, { recursive: true })
    }
})

test('the startup screen routes each choice separately and keeps the latest status', async () => {
    const source = await readFile(new URL('../src/main/startup.js', import.meta.url), 'utf8')
    const elements = new Map()
    const getElementById = id => {
        if (!elements.has(id)) elements.set(id, { addEventListener(type, handler) { this[type] = handler } })
        return elements.get(id)
    }
    const calls = []
    let notify, initialStatus, finishCloud
    const desktopApp = {
        onStatus: handler => { notify = handler },
        getStatus: () => new Promise(resolve => { initialStatus = resolve }),
        openLocalWorkspace: async () => { calls.push('local') },
        connectToServer: async () => { calls.push('server') },
        signInToCloud: () => {
            calls.push('cloud')
            return new Promise(resolve => { finishCloud = resolve })
        },
    }
    runInNewContext(source, { document: { getElementById }, window: { desktopApp } })
    const choices = { state: 'choose', message: 'Choose a workspace', choices: {
        local: 'Run on This Mac', connect: 'Connect to a Server', cloud: 'Sign in to Rerun Cloud',
        connecting: 'Connecting…', unreachable: 'Nothing answered at this address.',
    } }
    notify(choices)
    assert.deepEqual(calls, [])
    assert.equal(elements.get('run-locally').textContent, 'Run on This Mac')
    assert.equal(elements.get('connect-server').hidden, false)
    assert.equal(elements.get('local-footnote').hidden, true)
    const cloud = elements.get('sign-in-cloud')
    assert.equal(cloud.textContent, choices.choices.cloud)
    const pendingCloud = cloud.click()
    await cloud.click()
    assert.equal(cloud.textContent, choices.choices.connecting)
    assert.deepEqual(calls, ['cloud'])
    finishCloud({ ok: false, message: 'Try again shortly.' })
    await pendingCloud
    assert.equal(elements.get('cloud-error').hidden, false)
    assert.equal(elements.get('cloud-error').textContent, 'Try again shortly.')
    assert.equal(cloud.disabled, false)
    elements.get('connect-server').click()
    assert.deepEqual(calls, ['cloud', 'server'])
    elements.get('run-locally').click()
    assert.deepEqual(calls, ['cloud', 'server', 'local'])
    notify({ state: 'starting', message: 'Preparing local runtime…' })
    initialStatus(choices)
    await Promise.resolve()
    assert.equal(elements.get('run-locally').hidden, true)
    assert.equal(elements.get('connect-server').hidden, true)
    assert.equal(cloud.hidden, true)
    assert.equal(elements.get('cloud-error').hidden, true)
    assert.equal(elements.get('message').textContent, 'Preparing local runtime…')
})
