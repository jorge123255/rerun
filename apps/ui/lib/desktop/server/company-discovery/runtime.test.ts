import { emptyCompanyDiscoverySnapshot, type CompanyDiscoveryEvent, type DesktopCompanyDiscoverySnapshot } from '@rerun/contracts'
import { expect, test } from 'vitest'
import { CompanyDiscoveryError, type CompanyDiscoveryAuthority, type CompanyDiscoveryRunner } from './authority'
import { createCompanyDiscoveryRuntime } from './runtime'
import { readSnapshotBody, type CompanyDiscoveryStore, type CompanyDiscoveryTx, type StoredSnapshot } from './store'

const now = () => new Date('2026-11-05T12:00:00.000Z')
const workspaceId = 'ws-1'
const chatId = 'fmc_chat-0001'
const otherChat = 'fmc_chat-0002'
const runId = 'run-1'
const discoveryId = 'fmx_disc-0001'
const url = 'https://acme.example/'

function memoryStore(): CompanyDiscoveryStore & { rows(): StoredSnapshot[] } {
    const rows: StoredSnapshot[] = []
    const revisions = new Set<string>()
    let chain = Promise.resolve()
    const tx: CompanyDiscoveryTx = {
        byRun: async (workspace, chat, run) => rows.find(row => row.state === 'unknown' ? row.workspaceId === workspace && row.chatId === chat && row.runId === run : row.snapshot.workspaceId === workspace && row.snapshot.chatId === chat && row.snapshot.runId === run) ?? null,
        byId: async (workspace, chat, id) => rows.find(row => row.state === 'unknown' ? row.workspaceId === workspace && row.chatId === chat && row.discoveryId === id : row.snapshot.workspaceId === workspace && row.snapshot.chatId === chat && row.snapshot.discoveryId === id) ?? null,
        latest: async (workspace, chat) => [...rows].reverse().find(row => row.state === 'unknown' ? row.workspaceId === workspace && row.chatId === chat : row.snapshot.workspaceId === workspace && row.snapshot.chatId === chat) ?? null,
        insert: async snapshot => {
            if (rows.some(row => row.state === 'present' && row.snapshot.workspaceId === snapshot.workspaceId && row.snapshot.chatId === snapshot.chatId && row.snapshot.runId === snapshot.runId)) return 'exists'
            rows.push({ state: 'present', snapshot })
            return 'inserted'
        },
        put: async snapshot => {
            const index = rows.findIndex(row => row.state === 'present' && row.snapshot.discoveryId === snapshot.discoveryId)
            if (index < 0) throw new Error('missing')
            rows[index] = { state: 'present', snapshot }
        },
        insertRevision: async (id, source, revision) => {
            const key = `${id}:${source}:${revision}`
            if (revisions.has(key)) return false
            revisions.add(key)
            return true
        },
        running: async () => rows.filter(row => row.state === 'present' && row.snapshot.status === 'running'),
    }
    return {
        rows: () => rows,
        transaction(work) {
            const run = chain.then(() => work(tx))
            chain = run.then(() => undefined, () => undefined)
            return run
        },
    }
}

function authority(owner: 'active' | 'deleted' | 'disabled' | 'replaced' = 'active', current = workspaceId): CompanyDiscoveryAuthority {
    return { assertRun: async () => {}, currentWorkspaceId: async () => current, owner: async () => owner }
}

const mail: CompanyDiscoveryEvent = {
    type: 'settled', source: 'dns', revision: 1, status: 'found', reason: 'found', fetchedAt: now().toISOString(),
    provenance: [{ url: 'dns://acme.example', fetchedAt: now().toISOString(), via: 'public-dns', status: null }],
    payload: { kind: 'dns', dns: { mailProvider: 'Google Workspace', mx: ['aspmx.l.google.com'], services: [], spfIncludes: [], dmarcPolicy: null } },
    findings: [{ kind: 'mail', source: 'dns', attribution: { url, fetchedAt: now().toISOString(), via: 'public-dns' }, provider: 'Google Workspace', iconUrl: null }],
}

function runtime(store: CompanyDiscoveryStore, run: CompanyDiscoveryRunner | null, owner: CompanyDiscoveryAuthority | null = authority()) {
    return createCompanyDiscoveryRuntime({ store, authority: owner, run, now })
}

const code = async (work: Promise<unknown>) => work.then(() => 'ok', error => (error instanceof CompanyDiscoveryError ? error.code : String(error)))

test('the same run is not fetched twice and a repeated source revision does not duplicate the card', async () => {
    const store = memoryStore()
    let calls = 0
    const run: CompanyDiscoveryRunner = async ({ emit }) => {
        calls += 1
        emit(mail)
        emit(mail)
        emit({ type: 'end' })
    }
    const discovery = runtime(store, run)
    const first = await discovery.begin({ workspaceId, chatId, runId, discoveryId, url })
    const second = await discovery.begin({ workspaceId, chatId, runId, discoveryId, url })
    expect(calls).toBe(1)
    expect(second).toEqual(first)
    expect(first.findings).toHaveLength(1)
    expect(first.findings[0]).toMatchObject({ kind: 'mail', source: 'dns' })
    expect(first.sources.find(source => source.source === 'dns')?.revision).toBe(1)
})

test('stop drains the admitted run and a later begin does not start another fetch', async () => {
    const store = memoryStore()
    let calls = 0
    let started: () => void = () => {}
    const startedGate = new Promise<void>(resolve => { started = resolve })
    const run: CompanyDiscoveryRunner = async ({ signal, emit }) => {
        calls += 1
        emit({ type: 'pending', source: 'dns' })
        started()
        await new Promise<void>(resolve => {
            if (signal.aborted) resolve()
            else signal.addEventListener('abort', () => resolve(), { once: true })
        })
    }
    const discovery = runtime(store, run)
    const pending = discovery.begin({ workspaceId, chatId, runId, discoveryId, url })
    await startedGate
    expect(await code(discovery.stop({ workspaceId, chatId, discoveryId }))).toBe('ok')
    expect(await code(pending)).toBe('cancelled')
    expect(calls).toBe(1)
    const saved = await discovery.read({ workspaceId, chatId, discoveryId })
    expect(saved.state === 'present' && saved.snapshot.status).toBe('stopped')
    await discovery.begin({ workspaceId, chatId, runId, discoveryId, url })
    expect(calls).toBe(1)
})

test('startup stops a running discovery and does not fetch', async () => {
    const store = memoryStore()
    const seeded = emptyCompanyDiscoverySnapshot({ discoveryId, workspaceId, chatId, runId, url, domain: 'acme.example', startedAt: now().toISOString() })
    await store.transaction(async tx => { await tx.insert(seeded) })
    let calls = 0
    const discovery = runtime(store, async () => { calls += 1 })
    await discovery.reconcile()
    const saved = await discovery.read({ workspaceId, chatId, discoveryId })
    expect(saved.state === 'present' && saved.snapshot.status).toBe('stopped')
    expect(calls).toBe(0)
})

test('an explicit retry reuses the discovery and the same request does not fetch again', async () => {
    const store = memoryStore()
    let calls = 0
    const run: CompanyDiscoveryRunner = async ({ emit }) => { calls += 1; emit({ type: 'end' }) }
    const discovery = runtime(store, run)
    await discovery.begin({ workspaceId, chatId, runId, discoveryId, url })
    const requestId = '00000000-0000-4000-8000-000000000001'
    await discovery.retry({ workspaceId, chatId, discoveryId, runId, requestId })
    await discovery.retry({ workspaceId, chatId, discoveryId, runId, requestId })
    expect(calls).toBe(2)
    const saved = await discovery.read({ workspaceId, chatId, discoveryId })
    expect(saved.state === 'present' && saved.snapshot.discoveryId).toBe(discoveryId)
    expect(saved.state === 'present' && saved.snapshot.retries).toEqual([requestId])
})

test('a malformed source does not wipe an earlier card, and another chat cannot read it', async () => {
    const store = memoryStore()
    const run: CompanyDiscoveryRunner = async ({ emit }) => {
        emit(mail)
        emit({ type: 'settled', source: 'site', revision: 1, status: 'failed', reason: 'malformed', fetchedAt: now().toISOString(), provenance: [], payload: { kind: 'none' }, findings: [] })
        emit({ type: 'end' })
    }
    const discovery = runtime(store, run)
    await discovery.begin({ workspaceId, chatId, runId, discoveryId, url })
    const saved = await discovery.read({ workspaceId, chatId, discoveryId })
    expect(saved.state === 'present' && saved.snapshot.findings.map(finding => finding.kind)).toEqual(['mail'])
    expect(saved.state === 'present' && saved.snapshot.sources.find(source => source.source === 'site')?.reason).toBe('malformed')
    expect(await discovery.read({ workspaceId, chatId: otherChat, discoveryId })).toEqual({ state: 'absent' })
})

test('deleted owners, stale workspaces, private targets and a missing authority do not fetch', async () => {
    const store = memoryStore()
    let calls = 0
    const run: CompanyDiscoveryRunner = async () => { calls += 1 }
    expect(await code(runtime(store, run, authority('deleted')).begin({ workspaceId, chatId, runId, discoveryId, url }))).toBe('owner_deleted')
    expect(await code(runtime(store, run, authority('active', 'ws-other')).begin({ workspaceId, chatId, runId, discoveryId, url }))).toBe('stale_workspace')
    expect(await code(runtime(store, run).begin({ workspaceId, chatId, runId, discoveryId, url: 'http://127.0.0.1/a' }))).toBe('private_target')
    expect(await code(runtime(store, run, null).begin({ workspaceId, chatId, runId, discoveryId, url }))).toBe('authority_unbound')
    expect(await code(runtime(store, null).begin({ workspaceId, chatId, runId, discoveryId, url }))).toBe('fetch_authority_unbound')
    expect(calls).toBe(0)
    expect(() => runtime(store, null).collectForForeman({ url })).toThrow(CompanyDiscoveryError)
})

test('a corrupt saved body is unknown and is not treated as an empty success', () => {
    const identity = { discoveryId, workspaceId, chatId, runId }
    expect(readSnapshotBody('{', identity)).toEqual({ state: 'unknown', ...identity })
    const swapped = emptyCompanyDiscoverySnapshot({ ...identity, url, domain: 'acme.example', startedAt: now().toISOString() })
    const replaced: DesktopCompanyDiscoverySnapshot = { ...swapped, chatId: otherChat }
    expect(readSnapshotBody(JSON.stringify(replaced), identity).state).toBe('unknown')
})


test('keeps every admitted retry identity when capacity is reached and replays never refetch', async () => {
    const store = memoryStore(); let calls = 0
    const discovery = runtime(store, async ({ emit }) => { calls++; emit({ type: 'end' }) })
    await discovery.begin({ workspaceId, chatId, runId, discoveryId, url })
    const ids = Array.from({ length: 21 }, (_, index) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`)
    for (const requestId of ids.slice(0, 20)) await discovery.retry({ workspaceId, chatId, runId, discoveryId, requestId })
    expect(await code(discovery.retry({ workspaceId, chatId, runId, discoveryId, requestId: ids[20] }))).toBe('conflict')
    await discovery.retry({ workspaceId, chatId, runId, discoveryId, requestId: ids[0] })
    expect(calls).toBe(21)
})

test('rejects late source publication when the admitted Foreman run changes', async () => {
    let live = true
    const store = memoryStore()
    const owner = { ...authority(), assertRun: async () => { if (!live) throw new CompanyDiscoveryError('stale_run', 'changed') } }
    const discovery = runtime(store, async ({ emit }) => { live = false; emit(mail) }, owner)
    expect(await code(discovery.begin({ workspaceId, chatId, runId, discoveryId, url }))).toBe('stale_run')
    const saved = await discovery.read({ workspaceId, chatId, discoveryId })
    expect(saved.state === 'present' && saved.snapshot.findings).toEqual([])
})
