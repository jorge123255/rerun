import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import { test } from 'node:test'
import { parseHubLink } from '../src/main/connected-hub-policy.mjs'
import { createHubServiceSignIn, HUB_OAUTH_RETURN } from '../src/main/connected-hub-service-sign-in.mjs'

const originA = 'https://hub-a.example.test'
const originB = 'https://hub-b.example.test'
const jtiA = 'a'.repeat(22)
const jtiB = 'b'.repeat(22)

function ticket(origin, claims, now = Date.now) {
    const payload = Buffer.from(JSON.stringify({
        kind: 'ticket', desktop: 'dev', exp: now() + 60_000, ...claims,
    })).toString('base64url')
    const token = `${payload}.${'s'.repeat(43)}`
    return `${origin}/api/oauth/mobile/start?t=${encodeURIComponent(token)}`
}

function callback(params) {
    const url = new URL('rerun-desktop-dev://oauth/callback')
    for (const [key, value] of Object.entries(params)) url.searchParams.append(key, value)
    return parseHubLink(url.href)
}

function success(claim) {
    const link = callback({ status: 'success', claim })
    assert.equal(link?.kind, 'oauth')
    return link.result
}

function hub({ origin, id, responder, scope = `scope-${id}-live` }) {
    const sent = []
    const calls = []
    let destroyed = false
    const frame = { url: `${origin}/agents/agent-1`, send: (channel, value) => sent.push({ channel, value }) }
    const windowListeners = new Map()
    const contentListeners = new Map()
    const listen = (map, event, fn) => {
        const list = map.get(event) ?? []
        list.push(fn)
        map.set(event, list)
    }
    const forget = (map, event, fn) => map.set(event, (map.get(event) ?? []).filter(item => item !== fn))
    const emit = (map, event, ...args) => { for (const fn of [...(map.get(event) ?? [])]) fn(...args) }
    const session = {
        calls,
        fetch: async (url, init) => {
            calls.push({ url, init })
            return responder(url, init)
        },
    }
    const contents = {
        id,
        session,
        mainFrame: frame,
        isDestroyed: () => destroyed,
        on: (event, fn) => listen(contentListeners, event, fn),
        removeListener: (event, fn) => forget(contentListeners, event, fn),
    }
    const window = {
        isDestroyed: () => destroyed,
        once: (event, fn) => listen(windowListeners, event, fn),
        removeListener: (event, fn) => forget(windowListeners, event, fn),
    }
    const entry = { origin, scope, window, contents }
    return {
        entry, sent, calls, session,
        close() { destroyed = true; emit(windowListeners, 'closed') },
        navigate(url, { inPlace = false, mainFrame = true, retarget = true } = {}) {
            frame.url = url
            if (retarget && mainFrame && !inPlace) entry.scope = `left-${scope}`
            emit(contentListeners, 'did-start-navigation', {}, url, inPlace, mainFrame)
        },
    }
}

function signIn(now) {
    const opened = []
    const flow = createHubServiceSignIn({
        now, channel: 'dev',
        openBrowser: url => { opened.push(url) },
    })
    return { flow, opened }
}

const connected = () => new Response(null, { status: 204 })
const consider = (flow, page, url, registrationId = '1') => flow.consider(page.entry, url, registrationId, page.entry.contents.mainFrame)
const event = (result, registrationId = '1') => ({ channel: HUB_OAUTH_RETURN, value: { registrationId, result } })

test('a service connect opens the system browser and succeeds only after that hub session confirms the claim', async () => {
    const { flow, opened } = signIn()
    const page = hub({ origin: originA, id: 4, responder: connected })
    const url = ticket(originA, { jti: jtiA, agentId: 'agent-1', key: 'gmail@k3' })
    assert.equal(await consider(flow, page, 'https://hub-a.example.test/docs'), false)
    assert.equal(opened.length, 0)
    assert.equal(await consider(flow, page, url), true)
    assert.equal(opened.length, 1)
    assert.equal(new URL(opened[0]).origin, originA)
    assert.equal(new URL(opened[0]).pathname, '/api/oauth/mobile/start')
    assert.equal(new URL(opened[0]).searchParams.get('t'), new URL(url).searchParams.get('t'))

    await flow.complete(callback({ status: 'error', message: 'Access denied' }).result)
    await flow.complete(callback({ status: 'success' }).result)
    assert.equal(page.calls.length, 0)
    assert.equal(page.sent.length, 0)

    await flow.complete(success(jtiA))
    assert.equal(page.calls.length, 1)
    assert.equal(page.calls[0].url, `${originA}/api/v1/agents/agent-1/services/gmail%40k3/authorized`)
    assert.equal(page.calls[0].init.method, 'POST')
    assert.equal(page.calls[0].init.redirect, 'error')
    assert.equal(page.calls[0].init.credentials, 'include')
    assert.deepEqual(JSON.parse(page.calls[0].init.body), { claim: jtiA })
    assert.equal(page.calls[0].init.signal instanceof AbortSignal, true)
    assert.deepEqual(page.sent, [event({ status: 'success' })])
    await flow.complete(success(jtiA))
    assert.equal(page.calls.length, 1)
    assert.equal(page.sent.length, 1)
    assert.equal(await consider(flow, page, url, '2'), true)
    assert.equal(opened.length, 1)
    assert.equal(page.sent.at(-1).value.result.status, 'error')
})

test('an MCP connect and a 204 claim use the same hub session', async () => {
    const { flow, opened } = signIn()
    const page = hub({
        origin: 'http://127.0.0.1:8371', id: 8,
        responder: () => new Response(null, { status: 204 }),
    })
    assert.equal(await consider(flow, page, ticket('http://127.0.0.1:8371', { jti: jtiB, agentId: 'agent-9', server: 'linear' })), true)
    assert.equal(opened.length, 1)
    assert.equal(new URL(opened[0]).protocol, 'http:')
    await flow.complete(success(jtiB))
    assert.equal(page.calls[0].url, 'http://127.0.0.1:8371/api/v1/agents/agent-9/mcp/linear/authorized')
    assert.deepEqual(page.sent, [event({ status: 'success' })])
})

test('concurrent hubs cannot complete each other and each claim uses its own session', async () => {
    const { flow, opened } = signIn()
    const pageA = hub({ origin: originA, id: 1, responder: connected })
    const pageB = hub({ origin: originB, id: 2, responder: connected })
    assert.equal(await consider(flow, pageA, ticket(originA, { jti: jtiA, agentId: 'agent-a', key: 'gmail' })), true)
    assert.equal(await consider(flow, pageB, ticket(originB, { jti: jtiB, agentId: 'agent-b', server: 'linear' })), true)
    assert.equal(opened.length, 2)
    assert.equal(await consider(flow, pageB, ticket(originB, { jti: jtiA, agentId: 'agent-b', key: 'gmail' })), true)
    assert.equal(opened.length, 2)
    assert.deepEqual(pageB.sent.splice(0), [event({ status: 'error', message: 'Start a new service sign-in to continue' })])

    await flow.complete(success(jtiA))
    assert.equal(pageA.calls.length, 1)
    assert.equal(pageA.calls[0].url, `${originA}/api/v1/agents/agent-a/services/gmail/authorized`)
    assert.equal(pageB.calls.length, 0)
    assert.deepEqual(pageA.sent.map(item => item.value.result.status), ['success'])
    assert.equal(pageB.sent.length, 0)

    await flow.complete(success(jtiB))
    assert.equal(pageB.calls.length, 1)
    assert.equal(pageB.calls[0].url, `${originB}/api/v1/agents/agent-b/mcp/linear/authorized`)
    assert.equal(pageA.calls.length, 1)
    assert.deepEqual(pageB.sent.map(item => item.value.result.status), ['success'])
    assert.equal(pageA.sent.length, 1)
})

test('rejected callbacks write nothing and never report success', async () => {
    let time = 5_000_000
    const { flow, opened } = signIn(() => time)
    const claim = 'c'.repeat(22)
    const page = hub({ origin: originA, id: 3, responder: () => Response.json({ error: 'nope' }, { status: 409 }) })
    const other = hub({ origin: originB, id: 5, responder: connected })
    const start = () => consider(flow, page, ticket(originA, { jti: claim, agentId: 'agent-1', key: 'gmail' }, () => time))
    assert.equal(await start(), true)
    assert.equal(opened.length, 1)

    const wrong = [
        'rerun-desktop://oauth/callback?status=success&claim=' + claim,
        'rerun://oauth/callback?status=success&claim=' + claim,
        'rerun-desktop-dev://oauth/return?status=success&claim=' + claim,
        'rerun-desktop-dev://user@oauth/callback?status=success&claim=' + claim,
        `rerun-desktop-dev://oauth/callback?status=success&claim=${claim}&claim=${claim}`,
        `rerun-desktop-dev://oauth/callback?status=success&claim=${claim}&extra=1`,
        'rerun-desktop-dev://oauth/callback?status=success&claim=' + 'd'.repeat(65),
        'rerun-desktop-dev://oauth/callback?status=success&claim=' + 'd'.repeat(15),
        'rerun-desktop-dev://oauth/callback?status=maybe',
        'rerun-desktop-dev://oauth/callback?status=error&message=' + 'x'.repeat(301),
        'rerun-desktop-dev://oauth/callback?status=error&message=bad%0Aline',
        'not a url',
    ]
    for (const raw of wrong) assert.equal(parseHubLink(raw), null, raw)
    assert.deepEqual(callback({ status: 'success' }), { kind: 'oauth', result: { status: 'success' } })
    assert.equal(callback({ status: 'error', message: 'Access denied' }).result.message, 'Access denied')

    await flow.complete(success('e'.repeat(22)))
    assert.equal(page.calls.length, 0)

    time += 10 * 60_000
    await flow.complete(success(claim))
    assert.equal(page.calls.length, 0)
    assert.equal(page.sent.length, 0)

    time = 5_000_000
    assert.equal(await start(), true)
    flow.cancel(page.entry, '1', page.entry.contents.mainFrame)
    await flow.complete(success(claim))
    assert.equal(page.calls.length, 0)

    assert.equal(await start(), true)
    page.close()
    await flow.complete(success(claim))
    assert.equal(page.calls.length, 0)

    page.close = () => {}
    page.entry.window.isDestroyed = () => false
    page.entry.contents.isDestroyed = () => false
    assert.equal(await start(), true)
    page.navigate(`${originA}/elsewhere`)
    await flow.complete(success(claim))
    assert.equal(page.calls.length, 0)

    assert.equal(await start(), true)
    page.entry.scope = page.entry.scope
    page.navigate(`${originB}/agents/agent-1`, { retarget: false })
    await flow.complete(success(claim))
    assert.equal(page.calls.length, 0)

    page.entry.scope = 'scope-3-live'
    page.navigate(`${originA}/agents/agent-1`, { inPlace: true, retarget: false })
    assert.equal(await consider(flow, page, 'https://evil.example/api/oauth/mobile/start?t=' + 'a'.repeat(40)), true)
    assert.equal(await consider(flow, page, ticket(originA, { jti: claim, agentId: 'agent-1', key: 'gmail', desktop: 'stable' }, () => time)), true)
    assert.equal(opened.length, 5)
    assert.deepEqual(page.sent.splice(0).map(item => item.value.result.status), ['error', 'error'])

    assert.equal(await start(), true)
    await consider(flow, other, ticket(originB, { jti: 'f'.repeat(22), agentId: 'agent-b', key: 'slack' }, () => time))
    await flow.complete(success(claim))
    assert.equal(page.calls.length, 1)
    assert.equal(page.calls[0].url.startsWith(originA), true)
    assert.equal(other.calls.length, 0)
    assert.equal(other.sent.length, 0)
    assert.deepEqual(page.sent, [event({ status: 'error', message: 'The service sign-in could not be confirmed' })])
    await flow.complete(success(claim))
    assert.equal(page.calls.length, 1)
    assert.equal(page.sent.some(item => item.value.result.status === 'success'), false)
    assert.equal(other.sent.length, 0)
})

test('an in-place navigation does not retire the attempt', async () => {
    const { flow } = signIn()
    const page = hub({ origin: originA, id: 6, responder: connected })
    assert.equal(await consider(flow, page, ticket(originA, { jti: jtiA, agentId: 'agent-1', key: 'gmail' })), true)
    page.navigate(`${originA}/agents/agent-1#account`, { inPlace: true, retarget: false })
    await flow.complete(success(jtiA))
    assert.equal(page.calls.length, 1)
    assert.equal(page.sent[0].value.result.status, 'success')
})

test('a superseded registration and non-authoritative JSON never receive success', async () => {
    const { flow, opened } = signIn()
    const page = hub({ origin: originA, id: 7, responder: () => Response.json({ ok: true }) })
    await consider(flow, page, ticket(originA, { jti: jtiA, agentId: 'agent-1', key: 'gmail' }), '1')
    await consider(flow, page, ticket(originA, { jti: jtiB, agentId: 'agent-1', key: 'calendar' }), '2')
    flow.cancel(page.entry, '1', page.entry.contents.mainFrame)
    await flow.complete(success(jtiA))
    assert.equal(page.calls.length, 0)
    await flow.complete(success(jtiB))
    assert.equal(opened.length, 2)
    assert.equal(page.calls.length, 1)
    assert.deepEqual(page.sent, [event({ status: 'error', message: 'The service sign-in could not be confirmed' }, '2')])
})

test('only the matching Connect listener can receive a hub service sign-in result', async () => {
    const source = await readFile(new URL('../src/main/connected-hub-preload.cjs', import.meta.url), 'utf8')
    const exposed = {}, listeners = new Set(), requests = []
    const ipcRenderer = {
        sendSync: () => ({ audience: 'hub', apiVersion: 1, capabilities: ['oauth'] }),
        on: (channel, fn) => { if (channel === 'hub:oauth-return') listeners.add(fn) },
        removeListener: (_channel, fn) => listeners.delete(fn),
        invoke: async (...args) => { requests.push(args); return true },
    }
    runInNewContext(source, { require: () => ({ ipcRenderer, contextBridge: { exposeInMainWorld: (name, api) => { exposed[name] = api } } }) })
    const first = [], second = []
    const a = ticket(originA, { jti: jtiA, agentId: 'agent-1', key: 'gmail' })
    const b = ticket(originA, { jti: jtiB, agentId: 'agent-1', server: 'linear' })
    exposed.rerunShell.oauth.onReturn(value => first.push(value))
    await exposed.rerunShell.links.openExternal(a)
    exposed.rerunShell.oauth.onReturn(value => second.push(value))
    await exposed.rerunShell.links.openExternal(b)
    const send = value => { for (const fn of listeners) fn({ sender: 'privileged' }, value) }
    send({ registrationId: '1', result: { status: 'success' } })
    assert.deepEqual(first.map(value => value.status), ['error'])
    assert.deepEqual(second, [])
    send({ registrationId: '2', result: { status: 'success' } })
    assert.deepEqual(second.map(value => value.status), ['success'])
    assert.equal(Object.keys(second[0]).join(','), 'status')
    assert.deepEqual(requests.filter(([name]) => name === 'hub:open-link').map(([, , id]) => id), ['1', '2'])
    assert.equal(listeners.size, 0)
})
