import { createHash } from 'node:crypto'
import { createClient, type Client } from '@libsql/client'
import { describe, expect, it, vi } from 'vitest'
import { DESKTOP_TRIGGER_TOOL_DESCRIPTIONS as D, DESKTOP_TRIGGER_TOOL_MESSAGES as M, DESKTOP_TRIGGER_TOOL_PROMPT } from '@rerun/contracts'
import { createDesktopTriggerLifecycle, desktopTriggerDefinitionRevision } from '../triggers/lifecycle.js'
import { createDesktopTriggerStore } from '../triggers/state.js'
import type { DesktopTriggerAuthority, DesktopTriggerRecord } from '../triggers/types.js'
import { bindDesktopTriggerTools, readDesktopTriggerTools } from './binding.js'
import { createDesktopTriggerToolFactory } from './tools.js'
import type { DesktopTriggerToolAuthority } from './types.js'

function requestId(engineAgentId: string, runId: string, toolCallId: string): string {
    const hex = createHash('sha256').update(`${engineAgentId}:${runId}:${toolCallId}`).digest('hex')
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

function record(patch: Partial<DesktopTriggerRecord> & Pick<DesktopTriggerRecord, 'slug'>): DesktopTriggerRecord {
    return {
        name: patch.slug,
        description: '',
        enabled: true,
        token: 'secret-token-a',
        methods: ['POST'],
        lastFiredAt: null,
        fireCount: 0,
        connectionId: null,
        provider: null,
        model: null,
        body: 'Do the thing.',
        createdAt: '2026-01-01T00:00:00.000Z',
        ...patch,
    }
}

function assertNoSecret(text: string, token?: string) {
    expect(text).not.toMatch(/https?:\/\//)
    expect(text).not.toContain('Its public URL is')
    expect(text).not.toContain('/api/desktop/trigger-ingress/')
    expect(text).not.toContain('127.0.0.1')
    if (token) expect(text).not.toContain(token)
}

function harness() {
    const files = new Map<string, Map<string, DesktopTriggerRecord>>()
    const clients = new Map<string, Client>()
    const store = createDesktopTriggerStore(async id => {
        let client = clients.get(id)
        if (!client) {
            client = createClient({ url: ':memory:' })
            clients.set(id, client)
        }
        return client
    })
    const state = {
        grant: true,
        setupClear: true,
        enabled: true,
        deleting: false,
        connected: { provider: 'openai', model: 'gpt-5' } as { provider: string; model: string } | null,
        status: 'running',
        reads: 0,
        stopAt: 0,
        unsafe: false,
        failReplace: false,
        starts: 0,
        marks: 0,
        cancels: 0,
        writes: 0,
    }
    const bucket = (id: string) => {
        let rows = files.get(id)
        if (!rows) { rows = new Map(); files.set(id, rows) }
        return rows
    }
    const authority: DesktopTriggerAuthority = {
        assertActive() {},
        resolveOwnerByEngineId: async id => ({ localAgentId: `local-${id}`, engineAgentId: id, enabled: state.enabled, deleting: state.deleting }),
        assertTriggerGrant: async () => { if (!state.grant) throw new Error('grant off') },
        assertSetupClear: async () => { if (!state.setupClear) throw new Error('setup pending') },
        resolveAutomationModel: async () => { throw new Error('management tools must not resolve a launch model') },
        startTriggerRun: async () => { state.starts += 1; throw new Error('management tools must not start a run') },
        cancelExactRun: async () => { state.cancels += 1; throw new Error('management tools must not cancel a run') },
        readRun: async () => null,
        readSession: async () => null,
        adoptTriggerSession: async () => { throw new Error('management tools must not adopt a chat') },
        routeHuman: async () => { throw new Error('management tools must not route human input') },
        ingressOrigin: () => ({ enabled: true, origin: 'http://127.0.0.1:9', bindHost: '127.0.0.1', bindPort: 9, hostingDecision: 'loopback-only' }),
        listTriggers: async id => {
            if (state.unsafe) throw new Error('Unsafe trigger file')
            return [...bucket(id).values()]
        },
        readTrigger: async (id, slug) => {
            if (state.unsafe) throw new Error('Unsafe trigger file')
            return bucket(id).get(slug) ?? null
        },
        writeTrigger: async () => { throw new Error('Use durable trigger definition CAS') },
        rotateTriggerToken: async () => { throw new Error('Use durable trigger definition CAS') },
        deleteTrigger: async () => { throw new Error('Use durable trigger definition CAS') },
        markFired: async () => { state.marks += 1; throw new Error('management tools must not mark fired') },
        replaceTrigger: async (id, slug, expected, next) => {
            if (state.failReplace) { state.failReplace = false; throw new Error('Trigger definition changed') }
            const current = bucket(id).get(slug) ?? null
            if (desktopTriggerDefinitionRevision(current) !== desktopTriggerDefinitionRevision(expected)) throw new Error('Trigger definition changed')
            if (!next) { bucket(id).delete(slug); return null }
            const saved = { ...next, fireCount: current?.fireCount ?? next.fireCount, lastFiredAt: current?.lastFiredAt ?? next.lastFiredAt }
            bucket(id).set(slug, saved)
            state.writes += 1
            return saved
        },
    }
    const lifecycle = createDesktopTriggerLifecycle(authority, store)
    const toolAuthority: DesktopTriggerToolAuthority = {
        assertActive() {},
        resolveOwner: async id => ({ localAgentId: `local-${id}`, engineAgentId: id, enabled: state.enabled, deleting: state.deleting }),
        assertTriggerGrant: async () => { if (!state.grant) throw new Error('grant off') },
        assertSetupClear: async () => { if (!state.setupClear) throw new Error('setup pending') },
        readRun: async id => {
            state.reads += 1
            const status = state.stopAt > 0 && state.reads >= state.stopAt ? 'cancelled' : state.status
            return { agentId: id, sessionId: 'session-1', status }
        },
        connectedModel: async () => state.connected,
    }
    const factory = createDesktopTriggerToolFactory({ authority: toolAuthority, lifecycle, store })
    const call = async (name: string, input: unknown, toolCallId = 'call-1', engineAgentId = 'eng-1') => {
        const tools = factory.tools(engineAgentId, { runId: 'run-1', sessionId: 'session-1' })
        return (tools[name] as { execute: (value: never, options: { toolCallId: string }) => Promise<string> }).execute(input as never, { toolCallId })
    }
    return { authority, bucket, call, factory, files, lifecycle, state, store, toolAuthority }
}

describe('desktop trigger tools', () => {
    it('keeps the local-only descriptions and prompt', () => {
        const { factory } = harness()
        const tools = factory.tools('eng-1', { runId: 'run-1', sessionId: 'session-1' })
        for (const name of Object.keys(D) as (keyof typeof D)[]) {
            expect(tools[name]).toBeDefined()
            expect(D[name]).not.toContain('Its public URL is')
        }
        expect(D.trigger_create).toContain('Adding GET means any link preview can fire it.')
        expect(D.trigger_rotate_token).toContain('confirm with the user first')
        expect(D.trigger_edit).toContain('Prefer this over trigger_update')
        expect(DESKTOP_TRIGGER_TOOL_PROMPT).toContain('There is no public URL')
        expect(DESKTOP_TRIGGER_TOOL_PROMPT).toContain('action: "rotate"')
    })

    it('creates a local trigger without a token, URL, or delivery', async () => {
        const { bucket, call, factory, state, store } = harness()
        const text = await call('trigger_create', { name: 'Hook', description: 'Inbound', body: 'Do the thing.' })
        const saved = bucket('eng-1').get('hook')
        expect(text).toBe(M.created('hook', 'POST'))
        assertNoSecret(text, saved?.token)
        expect(saved).toMatchObject({ provider: null, model: null, connectionId: null, enabled: true, fireCount: 0, body: 'Do the thing.' })
        expect(state.starts).toBe(0)
        expect(state.marks).toBe(0)
        expect(factory.projection('call-1')).toMatchObject({ outcome: 'committed', operation: 'create', slug: 'hook' })
        const intent = await store.findIntent('eng-1', requestId('eng-1', 'run-1', 'call-1'))
        expect(JSON.parse(intent?.resultJson ?? '{}').token).toBe(saved?.token)
        expect(text).not.toContain(String(saved?.token))
    })

    it('sorts the list and reads a revision without the secret', async () => {
        const { bucket, call } = harness()
        expect(await call('trigger_list', {}, 'empty')).toBe(M.empty)
        bucket('eng-1').set('banana', record({ slug: 'banana', name: 'Banana', fireCount: 2, lastFiredAt: '2026-02-01T00:00:00.000Z' }))
        bucket('eng-1').set('apple', record({ slug: 'apple', name: 'Apple', enabled: false, token: 'secret-token-b' }))
        const list = await call('trigger_list', {}, 'list')
        expect(list).toBe(`- Apple (apple): POST, disabled\n- Banana (banana): POST, 2 call(s), last 2026-02-01T00:00:00.000Z`)
        assertNoSecret(list, 'secret-token-b')
        const got = await call('trigger_get', { slug: 'apple' }, 'get')
        expect(got).toContain('Revision: ')
        expect(got).toContain(M.localOnly)
        expect(got).toContain('Do the thing.')
        assertNoSecret(got, 'secret-token-b')
        expect(await call('trigger_get', { slug: 'missing' }, 'miss')).toBe(M.notFound('missing'))
        bucket('eng-1').set('link', record({ slug: 'link', body: 'See https://example.com/hook and /api/desktop/trigger-ingress/local/hook/secret' }))
        const linked = await call('trigger_get', { slug: 'link' }, 'link')
        expect(linked).toContain('https://example.com/hook')
        expect(linked).not.toContain('/api/desktop/trigger-ingress/')
        expect(linked).toContain('[address omitted]')
    })

    it('refuses a second create and a changed retry of the same call', async () => {
        const { bucket, call } = harness()
        await call('trigger_create', { name: 'Hook', description: '', body: 'First body.' }, 'same')
        expect(await call('trigger_create', { name: 'Hook', description: '', body: 'First body.' }, 'same')).toBe(M.created('hook', 'POST'))
        expect(await call('trigger_create', { name: 'Hook', description: '', body: 'Changed body.' }, 'same')).toBe(M.conflict)
        expect(await call('trigger_create', { name: 'Hook', description: '', body: 'Other.' }, 'other')).toBe(M.exists)
        expect(bucket('eng-1').get('hook')?.body).toBe('First body.')
    })

    it('edits an exact excerpt, keeps the token and fire count, and stores kind update', async () => {
        const { bucket, call, store } = harness()
        bucket('eng-1').set('hook', record({ slug: 'hook', name: 'Hook', body: 'Check inbox.', token: 'secret-token-a', fireCount: 4, provider: 'openai', model: 'gpt-5', connectionId: 'human-conn' }))
        const revision = (await call('trigger_get', { slug: 'hook' }, 'get')).split('\n').find(line => line.startsWith('Revision: '))?.slice('Revision: '.length)
        const text = await call('trigger_edit', { slug: 'hook', expectedRevision: revision, oldString: 'inbox', newString: 'mailbox', replaceAll: false }, 'edit')
        expect(text).toBe(M.edited('hook', 1))
        assertNoSecret(text, 'secret-token-a')
        expect(bucket('eng-1').get('hook')).toMatchObject({ body: 'Check mailbox.', token: 'secret-token-a', fireCount: 4, provider: 'openai', model: 'gpt-5', connectionId: 'human-conn' })
        const intent = await store.findIntent('eng-1', requestId('eng-1', 'run-1', 'edit'))
        expect(intent?.kind).toBe('update')
        expect(JSON.parse(intent?.resultJson ?? '{}').token).toBe('secret-token-a')
        expect(await call('trigger_edit', { slug: 'hook', oldString: 'inbox', newString: 'x' }, 'miss')).toBe(M.missingExcerpt('hook'))
        expect(await call('trigger_edit', { slug: 'hook', oldString: 'Check', newString: 'Check' }, 'same-text')).toBe(M.identical)
        expect(await call('trigger_edit', { slug: 'hook', oldString: '', newString: 'x' }, 'empty')).toBe(M.emptyExcerpt)
    })

    it('refuses an ambiguous excerpt unless replaceAll is set', async () => {
        const { bucket, call } = harness()
        bucket('eng-1').set('hook', record({ slug: 'hook', body: 'a a' }))
        expect(await call('trigger_edit', { slug: 'hook', oldString: 'a', newString: 'b' }, 'amb')).toBe(M.ambiguous('hook', 2))
        expect(bucket('eng-1').get('hook')?.body).toBe('a a')
        expect(await call('trigger_edit', { slug: 'hook', oldString: 'a', newString: 'b', replaceAll: true }, 'all')).toBe('Edited trigger hook (2 replacements)')
        expect(bucket('eng-1').get('hook')?.body).toBe('b b')
    })

    it('replaces a whole body, refuses a stale revision, and refuses a lone provider', async () => {
        const { bucket, call } = harness()
        bucket('eng-1').set('hook', record({ slug: 'hook', body: 'Old', provider: 'openai', model: 'gpt-5', connectionId: 'human-conn' }))
        const revision = (await call('trigger_get', { slug: 'hook' }, 'get')).split('\n').find(line => line.startsWith('Revision: '))?.slice('Revision: '.length)
        expect(await call('trigger_update', { slug: 'hook', expectedRevision: 'stale', body: 'New' }, 'stale')).toBe(M.stale)
        expect(bucket('eng-1').get('hook')?.body).toBe('Old')
        expect(await call('trigger_update', { slug: 'hook', expectedRevision: revision, provider: 'openai' }, 'lone')).toBe(M.providerWithoutModel)
        expect(bucket('eng-1').get('hook')?.provider).toBe('openai')
        const text = await call('trigger_update', { slug: 'hook', expectedRevision: revision, body: 'New body' }, 'body')
        expect(text).toBe(M.replacedBody('hook', 3, 8))
        expect(bucket('eng-1').get('hook')).toMatchObject({ body: 'New body', provider: 'openai', connectionId: 'human-conn' })
    })

    it('stores a matching named model as follow-coworker and refuses any other pin', async () => {
        const { bucket, call, state } = harness()
        const created = await call('trigger_create', { name: 'Hook', description: '', body: 'Run.', provider: 'openai', model: 'gpt-5' }, 'match')
        expect(created).toBe(M.created('hook', 'POST'))
        expect(bucket('eng-1').get('hook')).toMatchObject({ provider: null, model: null, connectionId: null })
        expect(await call('trigger_create', { name: 'Other', description: '', body: 'Run.', model: 'gpt-5-mini' }, 'miss')).toBe(M.pinRefused('openai/gpt-5'))
        expect(bucket('eng-1').has('other')).toBe(false)
        state.connected = null
        expect(await call('trigger_create', { name: 'Third', description: '', body: 'Run.', model: 'gpt-5' }, 'none')).toBe(M.noModel('gpt-5'))
        expect(bucket('eng-1').has('third')).toBe(false)
        state.connected = { provider: 'openai', model: 'gpt-5' }
        expect(await call('trigger_create', { name: 'Lone', description: '', body: 'Run.', provider: 'openai' }, 'lone')).toBe(M.created('lone', 'POST'))
        expect(bucket('eng-1').get('lone')).toMatchObject({ provider: null, model: null })
        bucket('eng-1').set('pinned', record({ slug: 'pinned', provider: 'openai', model: 'gpt-5', connectionId: 'human-conn' }))
        await call('trigger_update', { slug: 'pinned', description: 'kept' }, 'keep')
        expect(bucket('eng-1').get('pinned')).toMatchObject({ provider: 'openai', model: 'gpt-5', connectionId: 'human-conn', description: 'kept' })
        await call('trigger_update', { slug: 'pinned', provider: 'openai', model: 'gpt-5' }, 'clear')
        expect(bucket('eng-1').get('pinned')).toMatchObject({ provider: null, model: null, connectionId: null })
    })

    it('rotates only with slug, revision, and action, and leaves the previous token until the write', async () => {
        const { bucket, call, state } = harness()
        bucket('eng-1').set('hook', record({ slug: 'hook', token: 'secret-token-a' }))
        bucket('eng-1').set('other', record({ slug: 'other', token: 'secret-token-b' }))
        const revision = (await call('trigger_get', { slug: 'hook' }, 'get')).split('\n').find(line => line.startsWith('Revision: '))?.slice('Revision: '.length)
        expect(await call('trigger_rotate_token', { slug: 'hook' }, 'chat')).toBe(M.rotateConfirm)
        expect(await call('trigger_rotate_token', { slug: 'hook', confirmation: { slug: 'hook', revision: 'nope', action: 'rotate' } }, 'wrong-rev')).toBe(M.rotateConfirm)
        expect(await call('trigger_rotate_token', { slug: 'hook', confirmation: { slug: 'other', revision, action: 'rotate' } }, 'wrong-slug')).toBe(M.rotateConfirm)
        expect(await call('trigger_rotate_token', { slug: 'hook', confirmation: { slug: 'hook', revision, action: 'yes' } }, 'yes')).toBe(M.rotateConfirm)
        expect(bucket('eng-1').get('hook')?.token).toBe('secret-token-a')
        expect(state.writes).toBe(0)
        const text = await call('trigger_rotate_token', { slug: 'hook', confirmation: { slug: 'hook', revision, action: 'rotate' } }, 'rotate')
        const rotated = bucket('eng-1').get('hook')?.token
        expect(text).toBe(M.rotated('hook'))
        assertNoSecret(text, rotated)
        expect(rotated).not.toBe('secret-token-a')
        expect(bucket('eng-1').get('other')?.token).toBe('secret-token-b')
        expect(state.writes).toBe(1)
        expect(await call('trigger_rotate_token', { slug: 'hook', confirmation: { slug: 'hook', revision, action: 'rotate' } }, 'rotate')).toBe(M.rotated('hook'))
        expect(bucket('eng-1').get('hook')?.token).toBe(rotated)
        expect(state.writes).toBe(1)
    })

    it('finishes a lost rotate acknowledgement without minting a second token', async () => {
        const { bucket, call, store, state } = harness()
        bucket('eng-1').set('hook', record({ slug: 'hook', token: 'secret-token-a' }))
        const revision = (await call('trigger_get', { slug: 'hook' }, 'get')).split('\n').find(line => line.startsWith('Revision: '))?.slice('Revision: '.length)
        vi.spyOn(store, 'completeIntent').mockRejectedValueOnce(new Error('Lost acknowledgement'))
        const confirmation = { slug: 'hook', revision, action: 'rotate' as const }
        expect(await call('trigger_rotate_token', { slug: 'hook', confirmation }, 'lost')).toBe(M.uncertain)
        const once = bucket('eng-1').get('hook')?.token
        expect(once).not.toBe('secret-token-a')
        expect(state.writes).toBe(1)
        expect(await call('trigger_rotate_token', { slug: 'hook', confirmation }, 'lost')).toBe(M.rotated('hook'))
        expect(bucket('eng-1').get('hook')?.token).toBe(once)
        expect(state.writes).toBe(1)
        const pending = await store.findIntent('eng-1', requestId('eng-1', 'run-1', 'lost'))
        expect(pending?.resultJson).toContain(once)
    })

    it('retries one replace after the definition write throws and does not overwrite a stale file', async () => {
        const { bucket, call, state } = harness()
        bucket('eng-1').set('hook', record({ slug: 'hook', body: 'Keep' }))
        state.failReplace = true
        expect(await call('trigger_update', { slug: 'hook', body: 'Next' }, 'cas')).toBe(M.uncertain)
        expect(bucket('eng-1').get('hook')?.body).toBe('Keep')
        expect(await call('trigger_update', { slug: 'hook', body: 'Next' }, 'cas')).toBe(M.replacedBody('hook', 4, 4))
        expect(bucket('eng-1').get('hook')?.body).toBe('Next')
    })

    it('leaves a post-reserve stop pending and finishes it on the same call', async () => {
        const { bucket, call, state, store } = harness()
        state.stopAt = 3
        expect(await call('trigger_create', { name: 'Hook', description: '', body: 'Later.' }, 'stop')).toBe(M.inactive)
        expect(bucket('eng-1').has('hook')).toBe(false)
        const pending = await store.findPendingIntent('eng-1', 'hook')
        expect(pending?.resultJson).toBeNull()
        state.stopAt = 0
        expect(await call('trigger_create', { name: 'Hook', description: '', body: 'Later.' }, 'stop')).toBe(M.created('hook', 'POST'))
        expect(bucket('eng-1').get('hook')?.body).toBe('Later.')
        expect(state.writes).toBe(1)
    })

    it('refuses a revoked grant, pending setup, a stopped parent, and an unsafe file before writing', async () => {
        const off = harness()
        off.state.grant = false
        expect(await off.call('trigger_create', { name: 'Hook', description: '', body: 'No.' })).toBe(M.permission)
        expect(off.bucket('eng-1').size).toBe(0)
        const setup = harness()
        setup.state.setupClear = false
        expect(await setup.call('trigger_list', {})).toBe(M.setup)
        const disabled = harness()
        disabled.state.enabled = false
        expect(await disabled.call('trigger_list', {})).toBe(M.disabled)
        const deleting = harness()
        deleting.state.deleting = true
        expect(await deleting.call('trigger_list', {})).toBe(M.deleting)
        const stopped = harness()
        stopped.state.status = 'cancelled'
        expect(await stopped.call('trigger_create', { name: 'Hook', description: '', body: 'No.' })).toBe(M.inactive)
        expect(stopped.state.writes).toBe(0)
        const unsafe = harness()
        unsafe.bucket('eng-1').set('hook', record({ slug: 'hook' }))
        unsafe.state.unsafe = true
        expect(await unsafe.call('trigger_list', {})).toBe(M.fileUnsafe)
        const named = harness()
        expect(await named.call('trigger_create', { name: '!!!', description: '', body: 'No.' })).toBe(M.name)
        expect(await named.call('trigger_create', { name: 'Hook', description: '', body: '   ' }, 'blank')).toBe(M.emptyBody)
        expect(await named.call('trigger_create', { name: 'Hook', description: '', body: 'x'.repeat(64001) }, 'long')).toBe(M.tooLong)
        expect(await named.call('trigger_create', { name: 'Hook', description: '', body: 'Ok', methods: ['TRACE'] }, 'method')).toBe(M.methods)
        expect(named.bucket('eng-1').size).toBe(0)
    })

    it('hides a sibling slug and keeps recorded deliveries across disable and delete', async () => {
        const { bucket, call, state, store } = harness()
        bucket('eng-1').set('hook', record({ slug: 'hook', name: 'Alpha', token: 'secret-token-a' }))
        bucket('eng-2').set('hook', record({ slug: 'hook', name: 'Beta', token: 'secret-token-b' }))
        await store.recordEvent({
            eventId: 'evt-1', attemptFingerprint: 'attempt-1', requestFingerprint: 'req-1', localAgentId: 'local-eng-1', engineAgentId: 'eng-1',
            slug: 'hook', triggerName: 'Alpha', method: 'POST', receivedAt: '2026-03-01T00:00:00.000Z', finishedAt: '2026-03-01T00:00:01.000Z',
            status: 'finished', localSessionId: 'local-session', engineSessionId: 'engine-session', runId: 'delivery-run', revision: 'rev-1',
            error: null, payloadBytes: 4, truncated: false, capturedPayload: false, payloadPreview: 'ping',
        })
        expect(await call('trigger_list', {}, 'list-2', 'eng-2')).toContain('Beta')
        expect(await call('trigger_list', {}, 'list-2', 'eng-2')).not.toContain('Alpha')
        await call('trigger_update', { slug: 'hook', enabled: false }, 'disable')
        expect(bucket('eng-1').get('hook')).toMatchObject({ enabled: false, token: 'secret-token-a' })
        expect((await store.listEvents('eng-1', 'hook')).map(event => event.eventId)).toEqual(['evt-1'])
        expect(await call('trigger_delete', { slug: 'hook' }, 'delete')).toBe(M.deleted('hook'))
        expect(bucket('eng-1').has('hook')).toBe(false)
        expect(bucket('eng-2').get('hook')?.token).toBe('secret-token-b')
        expect((await store.listEvents('eng-1', 'hook')).map(event => event.status)).toEqual(['finished'])
        expect(state.starts).toBe(0)
        expect(state.cancels).toBe(0)
        expect(state.marks).toBe(0)
        await store.revokeOwner('eng-1')
        expect(await call('trigger_list', {}, 'revoked')).toBe(M.revoked)
        expect(await call('trigger_list', {}, 'still', 'eng-2')).toContain('Beta')
    })

    it('requires a trusted tool call and stops when the parent run is cancelled', async () => {
        const { factory, state } = harness()
        const running = factory.tools('eng-1', { runId: 'run-1', sessionId: 'session-1' })
        const execute = running.trigger_delete as { execute: (value: never, options?: { toolCallId?: string }) => Promise<string> }
        expect(await execute.execute({ slug: 'hook' } as never, {})).toBe(M.invocation)
        const aborted = factory.tools('eng-1', { runId: 'run-1', sessionId: 'session-1', abortSignal: AbortSignal.abort() })
        const create = aborted.trigger_create as { execute: (value: never, options: { toolCallId: string }) => Promise<string> }
        expect(await create.execute({ name: 'Hook', description: '', body: 'No.' } as never, { toolCallId: 'abort' })).toBe(M.cancelled)
        expect(state.writes).toBe(0)
    })

    it('requires a lifecycle, store, and authority before the tools can be read', () => {
        const { lifecycle, store, toolAuthority } = harness()
        expect(() => bindDesktopTriggerTools({ lifecycle, store, authority: undefined as never })).toThrow(/authority/)
        const bound = bindDesktopTriggerTools({ lifecycle, store, authority: toolAuthority })
        expect(readDesktopTriggerTools()).toBe(bound)
    })
})
