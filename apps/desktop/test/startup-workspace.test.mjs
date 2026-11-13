import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { configureStartupProfile, hasLocalWorkspace, loadStartupWorkspace } from '../src/main/startup-workspace.mjs'
import { localizeStartupStatus } from '../src/main/shell-language.mjs'

test('the startup preload forwards the localized copy and retry label', async () => {
    const source = await readFile(new URL('../src/main/preload.cjs', import.meta.url), 'utf8')
    const ipcRenderer = new EventEmitter()
    let desktopApp
    const contextBridge = { exposeInMainWorld: (_name, api) => { desktopApp = api } }
    runInNewContext(source, { process: { platform: 'darwin' }, require: () => ({ contextBridge, ipcRenderer }) })
    const received = []
    desktopApp.onStatus(status => received.push([status.retryLabel, status.copy]))
    const status = localizeStartupStatus('fr', { state: 'error', messageKey: 'keychainBlocked', retryLabel: 'Redémarrer Rerun' })
    ipcRenderer.emit('desktop:status', {}, status)
    ipcRenderer.emit('desktop:status', {}, { state: 'starting' })
    assert.deepEqual(received, [['Redémarrer Rerun', status.copy], [undefined, undefined]])
})

test('a development profile uses separate storage and packaged builds keep the installed profile', async t => {
    const root = await mkdtemp(join(tmpdir(), 'rerun-startup-profile-'))
    t.after(() => rm(root, { recursive: true, force: true }))
    const appData = join(root, 'Application Support')
    const development = join(root, 'development')
    await mkdir(appData)
    await mkdir(development)
    const operations = []
    const app = {
        isPackaged: false, getPath: () => appData,
        setPath: (name, value) => operations.push([name, value]),
        setName: name => operations.push(['name', name]),
    }
    const canonical = await realpath(development)
    assert.equal(configureStartupProfile(app, development), canonical)
    assert.deepEqual(operations.splice(0), [
        ['name', 'Rerun Desktop Development'], ['userData', canonical], ['sessionData', canonical],
    ])
    assert.deepEqual(await readdir(appData), [])

    app.isPackaged = true
    const installed = join(appData, 'Rerun Desktop Preview')
    assert.equal(configureStartupProfile(app, development), installed)
    assert.deepEqual(operations.splice(0), [['userData', installed], ['sessionData', installed]])

    app.isPackaged = false
    const alias = join(root, 'alias')
    const inside = join(installed, 'inside')
    await symlink(installed, alias)
    await mkdir(inside)
    for (const path of [appData, installed, alias, inside]) {
        assert.throws(() => configureStartupProfile(app, path), /separate from the installed preview/)
    }
    for (const path of ['relative', '', join(root, 'missing')]) {
        assert.throws(() => configureStartupProfile(app, path), /existing absolute directory/)
    }
    assert.deepEqual(operations, [])
})

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

test('startup remembers the latest explicit choice without creating a workspace', async t => {
    const root = await mkdtemp(join(tmpdir(), 'rerun-startup-selection-'))
    t.after(() => rm(root, { recursive: true, force: true }))
    const preference = await loadStartupWorkspace(root)
    assert.equal(preference.selection(), null)
    void preference.remember('connected')
    void preference.remember('local')
    await preference.flush()
    assert.equal((await loadStartupWorkspace(root)).selection(), 'local')
    await preference.remember('connected')
    await preference.remember('https://foreign.example')
    assert.equal((await loadStartupWorkspace(root)).selection(), 'connected')
    assert.equal(await hasLocalWorkspace(root), false)
    await writeFile(join(root, 'startup-workspace.json'), '{"version":2,"selection":"connected"}')
    assert.equal((await loadStartupWorkspace(root)).selection(), null)
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
        retry: async () => { calls.push('retry') },
        connectToServer: async () => { calls.push('server') },
        signInToCloud: () => {
            calls.push('cloud')
            return new Promise(resolve => { finishCloud = resolve })
        },
    }
    const documentElement = { lang: 'en' }
    runInNewContext(source, { document: { getElementById, documentElement }, window: { desktopApp } })
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
    const replacedCloud = cloud.click()
    elements.get('connect-server').click()
    finishCloud({ ok: false, reason: 'cancelled' })
    await replacedCloud
    assert.equal(elements.get('cloud-error').hidden, true)
    assert.equal(cloud.disabled, false)
    assert.deepEqual(calls, ['cloud', 'cloud', 'server'])
    elements.get('run-locally').click()
    assert.deepEqual(calls, ['cloud', 'cloud', 'server', 'local'])
    notify({ state: 'starting', message: 'Preparing local runtime…' })
    initialStatus(choices)
    await Promise.resolve()
    assert.equal(elements.get('run-locally').hidden, true)
    assert.equal(elements.get('connect-server').hidden, true)
    assert.equal(cloud.hidden, true)
    assert.equal(elements.get('cloud-error').hidden, true)
    assert.equal(elements.get('message').textContent, 'Preparing local runtime…')

    const { local, ...connectedChoices } = choices.choices
    notify({ state: 'keychain', message: 'Waiting for Keychain access.', choices: connectedChoices })
    assert.equal(elements.get('run-locally').hidden, true)
    assert.equal(elements.get('connect-server').hidden, false)
    assert.equal(elements.get('retry').hidden, true)
    notify({ state: 'error', message: 'Keychain is unavailable.', choices: connectedChoices, retryLabel: 'Restart Rerun' })
    assert.equal(elements.get('message').textContent, 'Keychain is unavailable.')
    assert.equal(elements.get('run-locally').hidden, true)
    assert.equal(cloud.hidden, false)
    assert.equal(elements.get('connect-server').hidden, false)
    assert.equal(elements.get('retry').hidden, false)
    assert.equal(elements.get('retry').textContent, 'Restart Rerun')
    elements.get('retry').click()
    elements.get('connect-server').click()
    assert.deepEqual(calls.slice(-2), ['retry', 'server'])

    notify(localizeStartupStatus('fr-CA', { state: 'error', messageKey: 'rendererClosed' }))
    assert.equal(documentElement.lang, 'fr')
    assert.equal(elements.get('welcome-title').textContent, 'Bienvenue sur Rerun')
    assert.equal(elements.get('quit').textContent, 'Quitter')
    assert.equal(elements.get('retry').textContent, 'Réessayer')
    assert.match(elements.get('message').textContent, /fermée de façon inattendue/)
    assert.equal(elements.get('local-footnote').hidden, false)
})
