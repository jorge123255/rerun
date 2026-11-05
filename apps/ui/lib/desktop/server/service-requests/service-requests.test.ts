import { createClient, type Client } from '@libsql/client'
import { afterEach, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

import { desktopServiceRequestFingerprint, serializeServiceSetupResult } from '@rerun/contracts'
import { DesktopHttpError } from '../auth'
import { describeDesktopServiceRequestCatalog } from './adapters'
import { desktopServiceSuggestionSchema, ensureDesktopServiceSuggestionSchema } from './schema'
import { desktopServiceRequestIdentity, finishDesktopServiceRequest, progressDesktopServiceRequest, readDesktopServiceRequest, type SealedReceipt, type ServiceRequestPorts, type ServiceRequestScope } from './service'
import { desktopServiceConnectionUsable } from './usable'

const secret = 'sk-test-secret-must-not-be-stored'
const clients: Client[] = []
afterEach(() => { for (const db of clients.splice(0)) db.close() })

async function database(): Promise<Client> {
    const db = createClient({ url: 'file::memory:' })
    clients.push(db)
    await db.execute('PRAGMA foreign_keys = ON')
    await db.executeMultiple(`CREATE TABLE desktop_agents (id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 1);
        CREATE TABLE desktop_sessions (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES desktop_agents(id));
        INSERT INTO desktop_agents (id) VALUES ('agent'), ('other');
        INSERT INTO desktop_sessions (id, agent_id) VALUES ('session', 'agent');`)
    await ensureDesktopServiceSuggestionSchema(db)
    return db
}

const services = [{ slug: 'notion', reason: 'pages' }, { slug: 'slack' }]
const source = { sourceMessageId: 'message-1', toolCallId: 'call-1', services, fingerprint: desktopServiceRequestFingerprint(services) }
const scope: ServiceRequestScope = { agentId: 'agent', sessionId: 'session', enabled: true }
const installRevision = '11111111-1111-4111-8111-111111111111'

function catalog(slug: string) {
    if (slug === 'notion') return { status: 'available' as const, name: 'Notion', category: 'productivity', summary: 'Pages', icon: null, verified: true, connected: false as const, authentication: 'supported' as const, methods: [{ id: 'default', supported: true }] }
    if (slug === 'slack') return { status: 'unsupported-auth' as const, name: 'Slack', category: 'communication', summary: 'Chat', icon: null, verified: false, connected: false as const, authentication: 'unsupported' as const, unsupportedReason: 'OAuth is not a local desktop method', methods: [{ id: 'oauth', supported: false, reason: 'OAuth is not a local desktop method' }] }
    if (slug === 'gone') return { status: 'not-found' as const }
    return { status: 'unavailable' as const }
}

function connection(over: Partial<{ usable: boolean; state: 'ready' | 'disconnected' | 'preparing'; revision: string; slug: string }> = {}) {
    return { key: over.slug ?? 'notion', revision: over.revision ?? installRevision, slug: over.slug ?? 'notion', state: over.state ?? 'ready' as const, usable: over.usable ?? true, healthState: 'healthy' as const }
}

function harness(db: Client, over: Partial<ServiceRequestPorts> = {}) {
    const sent: Array<'send' | 'replay'> = []
    const ports: ServiceRequestPorts = {
        source: async () => source,
        catalog: async slug => catalog(slug),
        installations: async () => [connection()],
        send: async (receipt, mode) => {
            sent.push(mode)
            if (mode === 'replay' && sent.filter(item => item === 'send').length === 0) return { status: 404, code: 'queued_turn_not_found', sessionId: null, runId: null }
            return { status: 200, sessionId: scope.sessionId, runId: receipt.requestId, contentType: 'text/event-stream', body: null }
        },
        ...over,
    }
    return { ports, sent }
}

async function open(db: Client, ports: ServiceRequestPorts) {
    const view = await readDesktopServiceRequest(db, scope, ports)
    if (!view.request) throw new Error('missing request')
    return view.request
}

it('keeps suggestion rows free of credential columns', () => {
    expect(desktopServiceSuggestionSchema).not.toContain('bearer')
    expect(desktopServiceSuggestionSchema).not.toContain('secret')
    expect(desktopServiceSuggestionSchema).not.toContain(secret)
})

it('treats a fresh healthy grant as usable and ignores catalog-only health', () => {
    const now = Date.parse('2026-04-01T00:00:30.000Z')
    const authority = { engineAgentId: 'engine', enabled: true, granted: true, launchNonce: 'launch' }
    const health = { state: 'healthy' as const, checkedAt: '2026-04-01T00:00:00.000Z' }
    expect(desktopServiceConnectionUsable({ engineId: 'engine', state: 'ready', health, healthLaunch: 'launch', authority, now })).toBe(true)
    expect(desktopServiceConnectionUsable({ engineId: 'engine', state: 'ready', health, healthLaunch: 'launch', authority: { ...authority, granted: false }, now })).toBe(false)
    expect(desktopServiceConnectionUsable({ engineId: 'engine', state: 'disconnected', health, healthLaunch: 'launch', authority, now })).toBe(false)
    expect(desktopServiceConnectionUsable({ engineId: 'other', state: 'ready', health, healthLaunch: 'launch', authority, now })).toBe(false)
    expect(desktopServiceConnectionUsable({ engineId: 'engine', state: 'ready', health: { state: 'unchecked' }, healthLaunch: null, authority, now })).toBe(false)
    expect(desktopServiceConnectionUsable({ engineId: 'engine', state: 'ready', health, healthLaunch: 'launch', authority, now: now + 60_000 })).toBe(false)
})

it('projects unavailable and unsupported auth without calling either one missing', async () => {
    expect(await describeDesktopServiceRequestCatalog('dynamics-365')).toEqual({ status: 'not-found' })
    expect(await describeDesktopServiceRequestCatalog('microsoft')).toMatchObject({ status: 'available', name: 'Microsoft Learn', verified: false, connected: false, authentication: 'supported' })
    const adobe = await describeDesktopServiceRequestCatalog('adobe')
    expect(adobe.status).not.toBe('not-found')
    expect(adobe.status).not.toBe('unavailable')
    if (adobe.status === 'unsupported-auth' || adobe.status === 'available') expect(adobe.connected).toBe(false)
})

it('saves ordered choices, rejects a stale installation, and finishes one secret-free follow-up', async () => {
    const db = await database()
    const { ports, sent } = harness(db)
    const opened = await open(db, ports)
    expect(opened.serviceRequestId).toBe(desktopServiceRequestIdentity(scope.agentId, scope.sessionId, source))
    expect(opened.choices).toEqual([{ slug: 'notion', choice: 'pending' }, { slug: 'slack', choice: 'pending' }])
    expect(opened.services[0]?.catalog).toMatchObject({ status: 'available', verified: true, connected: false })
    expect(opened.services[1]?.catalog).toMatchObject({ status: 'unsupported-auth' })
    expect(JSON.stringify(opened)).not.toContain(secret)
    const progress = { action: 'progress' as const, requestId: crypto.randomUUID(), serviceRequestId: opened.serviceRequestId, source: opened.source, expectedRevision: opened.revision, currentIndex: 1, choices: [{ slug: 'notion', choice: 'use-connection' as const, installation: { key: 'notion', revision: installRevision } }, { slug: 'slack', choice: 'skip' as const }] }
    await expect(progressDesktopServiceRequest(db, scope, ports, { ...progress, requestId: crypto.randomUUID(), choices: [{ slug: 'notion', choice: 'use-connection', installation: { key: 'notion', revision: crypto.randomUUID() } }, progress.choices[1]!] })).rejects.toMatchObject({ status: 409 })
    const saved = await progressDesktopServiceRequest(db, scope, ports, progress)
    expect(saved.revision).not.toBe(opened.revision)
    expect(await progressDesktopServiceRequest(db, scope, ports, progress)).toMatchObject({ revision: saved.revision })
    await expect(progressDesktopServiceRequest(db, scope, ports, { ...progress, choices: [{ slug: 'notion', choice: 'skip' }, { slug: 'slack', choice: 'skip' }] })).rejects.toMatchObject({ status: 409 })
    const stored = JSON.stringify((await db.execute('SELECT choices FROM desktop_service_suggestion_requests')).rows[0]?.choices)
    expect(stored).toContain(installRevision)
    expect(stored).not.toContain(secret)
    const finish = { action: 'finish' as const, requestId: crypto.randomUUID(), serviceRequestId: opened.serviceRequestId, source: opened.source, expectedRevision: saved.revision, currentIndex: saved.currentIndex, choices: saved.choices }
    await expect(finishDesktopServiceRequest(db, scope, { ...ports, installations: async () => [connection({ usable: false })] }, finish)).rejects.toBeInstanceOf(DesktopHttpError)
    expect(sent).toEqual([])
    expect((await db.execute('SELECT * FROM desktop_service_suggestion_receipts')).rows).toHaveLength(0)
    const response = await finishDesktopServiceRequest(db, scope, ports, finish)
    expect(response.status).toBe(200)
    expect(response.headers.get('x-service-request-id')).toBe(opened.serviceRequestId)
    expect(sent).toEqual(['replay', 'send'])
    const text = String((await db.execute('SELECT summary_text FROM desktop_service_suggestion_receipts')).rows[0]?.summary_text)
    expect(text).toBe(serializeServiceSetupResult([{ slug: 'notion', name: 'Notion', outcome: 'connected' }, { slug: 'slack', name: 'Slack', outcome: 'skipped' }]))
    expect(text).not.toContain('not found')
    expect(text).not.toContain(secret)
    const again = await finishDesktopServiceRequest(db, scope, ports, finish)
    expect(again.headers.get('x-run-id')).toBe(finish.requestId)
    expect(sent.filter(mode => mode === 'send')).toHaveLength(1)
})

it('blocks pending choices, derives reset and not-found, and refuses a failed catalog read', async () => {
    const db = await database()
    const single = { sourceMessageId: 'message-2', toolCallId: 'call-2', services: [{ slug: 'gone' }], fingerprint: desktopServiceRequestFingerprint([{ slug: 'gone' }]) }
    const { ports } = harness(db, { source: async () => single, installations: async () => [connection({ slug: 'gone', state: 'disconnected', usable: false })] })
    const opened = await open(db, ports)
    const pending = { action: 'finish' as const, requestId: crypto.randomUUID(), serviceRequestId: opened.serviceRequestId, source: opened.source, expectedRevision: opened.revision, currentIndex: 0, choices: opened.choices }
    await expect(finishDesktopServiceRequest(db, scope, ports, pending)).rejects.toMatchObject({ status: 409 })
    const skip = { ...pending, requestId: crypto.randomUUID(), choices: [{ slug: 'gone', choice: 'skip' as const }] }
    const progressed = await progressDesktopServiceRequest(db, scope, ports, { ...skip, action: 'progress' })
    const done = await finishDesktopServiceRequest(db, scope, ports, { ...skip, expectedRevision: progressed.revision })
    expect(done.status).toBe(200)
    expect(String((await db.execute('SELECT summary_text FROM desktop_service_suggestion_receipts')).rows[0]?.summary_text)).toContain('gone: not found in the catalog')
    const resetDb = await database()
    const slack = { sourceMessageId: 'message-3', toolCallId: 'call-3', services: [{ slug: 'slack' }], fingerprint: desktopServiceRequestFingerprint([{ slug: 'slack' }]) }
    const resetPorts = harness(resetDb, { source: async () => slack, installations: async () => [connection({ slug: 'slack', state: 'disconnected', usable: false })] }).ports
    const resetCard = await open(resetDb, resetPorts)
    const resetProgress = await progressDesktopServiceRequest(resetDb, scope, resetPorts, { action: 'progress', requestId: crypto.randomUUID(), serviceRequestId: resetCard.serviceRequestId, source: resetCard.source, expectedRevision: resetCard.revision, currentIndex: 0, choices: [{ slug: 'slack', choice: 'skip' }] })
    await finishDesktopServiceRequest(resetDb, scope, resetPorts, { action: 'finish', requestId: crypto.randomUUID(), serviceRequestId: resetCard.serviceRequestId, source: resetCard.source, expectedRevision: resetProgress.revision, currentIndex: 0, choices: resetProgress.choices })
    expect(String((await resetDb.execute('SELECT summary_text FROM desktop_service_suggestion_receipts')).rows[0]?.summary_text)).toContain('Slack: connection reset, not reconnected')
    const failed = await database()
    const failedPorts = harness(failed, { catalog: async () => ({ status: 'unavailable' }) }).ports
    const failedCard = await open(failed, failedPorts)
    expect(failedCard.services[0]?.catalog).toEqual({ status: 'unavailable' })
    const failedProgress = await progressDesktopServiceRequest(failed, scope, failedPorts, { action: 'progress', requestId: crypto.randomUUID(), serviceRequestId: failedCard.serviceRequestId, source: failedCard.source, expectedRevision: failedCard.revision, currentIndex: 0, choices: failedCard.services.map(service => ({ slug: service.slug, choice: 'skip' as const })) })
    await expect(finishDesktopServiceRequest(failed, scope, failedPorts, { action: 'finish', requestId: crypto.randomUUID(), serviceRequestId: failedCard.serviceRequestId, source: failedCard.source, expectedRevision: failedProgress.revision, currentIndex: 0, choices: failedProgress.choices })).rejects.toMatchObject({ status: 502 })
    expect((await failed.execute('SELECT * FROM desktop_service_suggestion_receipts')).rows).toHaveLength(0)
})

it('refuses a disabled owner and a superseded source without sending', async () => {
    const db = await database()
    const { ports, sent } = harness(db)
    const opened = await open(db, ports)
    await expect(readDesktopServiceRequest(db, { ...scope, enabled: false }, ports)).rejects.toMatchObject({ status: 403 })
    const body = { action: 'progress' as const, requestId: crypto.randomUUID(), serviceRequestId: opened.serviceRequestId, source: opened.source, expectedRevision: opened.revision, currentIndex: 0, choices: opened.choices }
    await expect(progressDesktopServiceRequest(db, { ...scope, enabled: false }, ports, body)).rejects.toMatchObject({ status: 403 })
    await expect(finishDesktopServiceRequest(db, { ...scope, enabled: false }, ports, { ...body, action: 'finish' })).rejects.toMatchObject({ status: 403 })
    await expect(progressDesktopServiceRequest(db, scope, { ...ports, source: async () => null }, body)).rejects.toMatchObject({ status: 409 })
    expect(sent).toEqual([])
    expect((await db.execute('SELECT revision FROM desktop_service_suggestion_requests')).rows[0]?.revision).toBe(opened.revision)
})

it('reports a usable missing catalog entry as not-found and blocks a changing installation', async () => {
    const db = await database()
    const gone = { sourceMessageId: 'message-4', toolCallId: 'call-4', services: [{ slug: 'gone' }], fingerprint: desktopServiceRequestFingerprint([{ slug: 'gone' }]) }
    const { ports } = harness(db, { source: async () => gone, installations: async () => [connection({ slug: 'gone', usable: true })] })
    const opened = await open(db, ports)
    const progress = await progressDesktopServiceRequest(db, scope, ports, { action: 'progress', requestId: crypto.randomUUID(), serviceRequestId: opened.serviceRequestId, source: opened.source, expectedRevision: opened.revision, currentIndex: 0, choices: [{ slug: 'gone', choice: 'use-connection', installation: { key: 'gone', revision: installRevision } }] })
    const done = await finishDesktopServiceRequest(db, scope, ports, { action: 'finish', requestId: crypto.randomUUID(), serviceRequestId: opened.serviceRequestId, source: opened.source, expectedRevision: progress.revision, currentIndex: 0, choices: progress.choices })
    expect(done.status).toBe(200)
    const text = String((await db.execute('SELECT summary_text FROM desktop_service_suggestion_receipts')).rows[0]?.summary_text)
    expect(text).toContain('gone: not found in the catalog')
    expect(text).not.toContain('connected')
    const changingDb = await database()
    const notion = { sourceMessageId: 'message-5', toolCallId: 'call-5', services: [{ slug: 'notion' }], fingerprint: desktopServiceRequestFingerprint([{ slug: 'notion' }]) }
    const changingPorts = harness(changingDb, { source: async () => notion, installations: async () => [connection({ state: 'preparing', usable: false })] }).ports
    const card = await open(changingDb, changingPorts)
    const saved = await progressDesktopServiceRequest(changingDb, scope, changingPorts, { action: 'progress', requestId: crypto.randomUUID(), serviceRequestId: card.serviceRequestId, source: card.source, expectedRevision: card.revision, currentIndex: 0, choices: [{ slug: 'notion', choice: 'skip' }] })
    await expect(finishDesktopServiceRequest(changingDb, scope, changingPorts, { action: 'finish', requestId: crypto.randomUUID(), serviceRequestId: card.serviceRequestId, source: card.source, expectedRevision: saved.revision, currentIndex: 0, choices: saved.choices })).rejects.toMatchObject({ status: 409 })
    expect((await changingDb.execute('SELECT * FROM desktop_service_suggestion_receipts')).rows).toHaveLength(0)
})
