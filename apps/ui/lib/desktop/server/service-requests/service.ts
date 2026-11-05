import 'server-only'
import { createHash, randomUUID } from 'node:crypto'
import type { Client, Row } from '@libsql/client'
import {
    deriveDesktopServiceSetup,
    desktopServiceChoiceSchema,
    desktopServiceProgressResultSchema,
    desktopServiceRequestViewSchema,
    serializeServiceSetupResult,
    type DesktopServiceCatalogFact,
    type DesktopServiceChoice,
    type DesktopServiceConnection,
    type DesktopServiceFinish,
    type DesktopServiceInstallFact,
    type DesktopServiceProgress,
    type DesktopServiceRequest,
    type DesktopServiceRequestCatalog,
    type DesktopServiceRequestGuard,
    type DesktopServiceRequestView,
    type DesktopServiceSetupEntry,
    type ServiceSuggestionItem,
} from '@rerun/contracts'
import { DesktopHttpError } from '../auth'
import { disabledCoworkerMessage } from '../coworker-enabled'

export type ServiceRequestScope = { agentId: string; sessionId: string; enabled: boolean }
export type ServiceRequestDatabase = Pick<Client, 'execute'>
export type ServiceRequestSealAuthority = {
    installations: (db: ServiceRequestDatabase) => Promise<DesktopServiceConnection[] | 'unavailable'>
    check: () => void
}
export type ServiceRequestPorts = {
    source: () => Promise<DesktopServiceRequest | null>
    catalog: (slug: string) => Promise<DesktopServiceRequestCatalog>
    installations: () => Promise<DesktopServiceConnection[] | 'unavailable'>
    prepareSeal: () => Promise<ServiceRequestSealAuthority>
    send: (receipt: SealedReceipt, mode: 'send' | 'replay') => Promise<FollowUpResponse>
}
export type SealedReceipt = {
    requestId: string
    serviceRequestId: string
    sessionId: string
    revision: string
    guard: DesktopServiceRequestGuard
    text: string
    entries: DesktopServiceSetupEntry[]
    accepted: boolean
}
export type FollowUpResponse = { status: number; sessionId: string | null; runId: string | null; code?: string; contentType?: string | null; body?: ReadableStream<Uint8Array> | null }

type Card = {
    serviceRequestId: string
    agentId: string
    sessionId: string
    sourceMessageId: string
    toolCallId: string
    fingerprint: string
    services: ServiceSuggestionItem[]
    revision: string
    currentIndex: number
    choices: DesktopServiceChoice[]
}

const locks = new Map<string, Promise<void>>()

function withCardLock<T>(key: string, run: () => Promise<T>): Promise<T> {
    const previous = locks.get(key) ?? Promise.resolve()
    const result = previous.then(run, run)
    const settled = result.then(() => undefined, () => undefined)
    locks.set(key, settled)
    void settled.then(() => { if (locks.get(key) === settled) locks.delete(key) })
    return result
}

export function desktopServiceRequestIdentity(agentId: string, sessionId: string, source: DesktopServiceRequestGuard): string {
    return createHash('sha256').update(JSON.stringify(['service-request', agentId, sessionId, source.sourceMessageId, source.toolCallId, source.fingerprint])).digest('hex')
}

function refusal(status: number, message: string): never {
    throw new DesktopHttpError(status, message)
}

function json(raw: string): unknown {
    try { return JSON.parse(raw) } catch { return null }
}

function servicesOf(raw: string): ServiceSuggestionItem[] {
    const value = json(raw)
    if (!Array.isArray(value) || value.length < 1) refusal(502, 'Saved app setup could not be read. Reload the conversation.')
    const services: ServiceSuggestionItem[] = []
    for (const entry of value) {
        if (!entry || typeof entry !== 'object') refusal(502, 'Saved app setup could not be read. Reload the conversation.')
        const slug = (entry as { slug?: unknown }).slug
        const reason = (entry as { reason?: unknown }).reason
        if (typeof slug !== 'string' || slug.length < 1 || slug.length > 200) refusal(502, 'Saved app setup could not be read. Reload the conversation.')
        if (reason != null && typeof reason !== 'string') refusal(502, 'Saved app setup could not be read. Reload the conversation.')
        services.push(typeof reason === 'string' ? { slug, reason } : { slug })
    }
    return services
}

function choicesOf(raw: string): DesktopServiceChoice[] {
    const parsed = desktopServiceChoiceSchema.array().min(1).max(20).safeParse(json(raw))
    if (!parsed.success) refusal(502, 'Saved app setup choices could not be read. Reload the conversation.')
    return parsed.data
}

function entriesOf(raw: string): DesktopServiceSetupEntry[] {
    const value = json(raw)
    if (!Array.isArray(value)) refusal(502, 'Saved app setup result could not be read. Retry the same finish.')
    return value as DesktopServiceSetupEntry[]
}

function cardOf(row: Row): Card {
    return {
        serviceRequestId: String(row.service_request_id), agentId: String(row.agent_id), sessionId: String(row.session_id),
        sourceMessageId: String(row.source_message_id), toolCallId: String(row.tool_call_id), fingerprint: String(row.fingerprint),
        services: servicesOf(String(row.ordered_input)), revision: String(row.revision), currentIndex: Number(row.current_index), choices: choicesOf(String(row.choices)),
    }
}

function guardOf(card: Card): DesktopServiceRequestGuard {
    return { sourceMessageId: card.sourceMessageId, toolCallId: card.toolCallId, fingerprint: card.fingerprint }
}

async function cardById(db: ServiceRequestDatabase, serviceRequestId: string): Promise<Card | null> {
    const result = await db.execute({ sql: 'SELECT * FROM desktop_service_suggestion_requests WHERE service_request_id = ?', args: [serviceRequestId] })
    return result.rows[0] ? cardOf(result.rows[0]) : null
}

async function receiptByService(db: ServiceRequestDatabase, serviceRequestId: string, card: Card): Promise<SealedReceipt | null> {
    const result = await db.execute({ sql: 'SELECT * FROM desktop_service_suggestion_receipts WHERE service_request_id = ?', args: [serviceRequestId] })
    const row = result.rows[0]
    if (!row) return null
    return {
        requestId: String(row.request_id), serviceRequestId, sessionId: card.sessionId, revision: String(row.revision), guard: guardOf(card),
        text: String(row.summary_text), entries: entriesOf(String(row.entries)), accepted: Number(row.accepted) === 1,
    }
}

async function mutationById(db: ServiceRequestDatabase, requestId: string) {
    const result = await db.execute({ sql: 'SELECT * FROM desktop_service_suggestion_mutations WHERE request_id = ?', args: [requestId] })
    const row = result.rows[0]
    if (!row) return null
    return {
        requestId: String(row.request_id), serviceRequestId: String(row.service_request_id), kind: String(row.kind),
        expectedRevision: String(row.expected_revision), body: String(row.body), resultRevision: row.result_revision == null ? null : String(row.result_revision),
    }
}

function assertEnabled(scope: ServiceRequestScope) {
    if (!scope.enabled) refusal(403, disabledCoworkerMessage)
}

function assertOwned(card: Card, scope: ServiceRequestScope) {
    if (card.agentId !== scope.agentId || card.sessionId !== scope.sessionId) refusal(409, 'That app setup belongs to a different conversation.')
}

function assertAligned(input: DesktopServiceProgress | DesktopServiceFinish, card: Card) {
    if (input.serviceRequestId !== card.serviceRequestId || input.expectedRevision !== card.revision) refusal(409, 'This app setup changed. Reload the conversation and retry the saved choices.')
    if (input.source.sourceMessageId !== card.sourceMessageId || input.source.toolCallId !== card.toolCallId || input.source.fingerprint !== card.fingerprint) refusal(409, 'This app setup changed or is no longer waiting. Reload the conversation.')
    if (input.currentIndex < 0 || input.currentIndex >= card.services.length) refusal(400, 'Choose a step on this app setup.')
    if (input.choices.length !== card.services.length || input.choices.some((choice, index) => choice.slug !== card.services[index]?.slug)) refusal(400, 'Choose each suggested app once, in the requested order.')
    if (input.action === 'finish' && (input.currentIndex !== card.currentIndex || JSON.stringify(input.choices) !== JSON.stringify(card.choices))) refusal(409, 'Save these choices before finishing. Pending apps are not skipped.')
}

async function transaction<T>(db: Client, run: (tx: ServiceRequestDatabase) => Promise<T>, check: () => void = () => {}): Promise<T> {
    const tx = await db.transaction('write')
    try {
        const value = await run(tx)
        // No asynchronous work between the final authority guard and commit admission.
        check()
        await tx.commit()
        return value
    } catch (error) {
        await tx.rollback().catch(() => undefined)
        throw error
    } finally { tx.close() }
}

function catalogFact(catalog: DesktopServiceRequestCatalog): DesktopServiceCatalogFact {
    if (catalog.status === 'available' || catalog.status === 'unsupported-auth') return { status: catalog.status, name: catalog.name }
    return { status: catalog.status }
}

function installFact(connection: DesktopServiceConnection): DesktopServiceInstallFact {
    return {
        key: connection.key, revision: connection.revision, slug: connection.slug, usable: connection.usable,
        disconnected: connection.state === 'disconnected', changing: connection.state === 'preparing' || connection.state === 'removing',
    }
}

async function project(db: Client, card: Card, ports: ServiceRequestPorts): Promise<DesktopServiceRequestView['request']> {
    const receipt = await receiptByService(db, card.serviceRequestId, card)
    const [catalogs, installations] = await Promise.all([
        Promise.all(card.services.map(service => ports.catalog(service.slug).catch((): DesktopServiceRequestCatalog => ({ status: 'unavailable' })))),
        ports.installations().catch(() => 'unavailable' as const),
    ])
    const request = {
        serviceRequestId: card.serviceRequestId, revision: card.revision, source: guardOf(card), currentIndex: card.currentIndex, choices: card.choices,
        services: card.services.map((service, index) => ({
            slug: service.slug,
            ...(service.reason !== undefined ? { reason: service.reason } : {}),
            catalog: catalogs[index] ?? { status: 'unavailable' as const },
            connections: installations === 'unavailable' ? null : installations.filter(item => item.slug === service.slug),
            connectionsStatus: installations === 'unavailable' ? 'unavailable' as const : 'ready' as const,
        })),
        retry: receipt ? { phase: receipt.accepted ? 'accepted' as const : 'finishing' as const, requestId: receipt.requestId } : { phase: 'open' as const },
        ...(receipt ? { receipt: { requestId: receipt.requestId, revision: receipt.revision, accepted: receipt.accepted, text: receipt.text, entries: receipt.entries } } : {}),
    }
    const parsed = desktopServiceRequestViewSchema.safeParse({ request })
    if (!parsed.success || !parsed.data.request) refusal(502, 'App setup could not be shown. Reload the conversation.')
    return parsed.data.request
}

async function ensureCard(db: Client, scope: ServiceRequestScope, source: DesktopServiceRequest): Promise<Card> {
    const serviceRequestId = desktopServiceRequestIdentity(scope.agentId, scope.sessionId, source)
    const existing = await cardById(db, serviceRequestId)
    if (existing) {
        assertOwned(existing, scope)
        return existing
    }
    const choices: DesktopServiceChoice[] = source.services.map(service => ({ slug: service.slug, choice: 'pending' }))
    await db.execute({
        sql: `INSERT INTO desktop_service_suggestion_requests
            (service_request_id, agent_id, session_id, source_message_id, tool_call_id, fingerprint, ordered_input, revision, current_index, choices, updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(service_request_id) DO NOTHING`,
        args: [serviceRequestId, scope.agentId, scope.sessionId, source.sourceMessageId, source.toolCallId, source.fingerprint, JSON.stringify(source.services), randomUUID(), 0, JSON.stringify(choices), new Date().toISOString()],
    })
    const saved = await cardById(db, serviceRequestId)
    if (!saved) refusal(502, 'App setup could not be saved. Reload the conversation.')
    assertOwned(saved, scope)
    return saved
}

export async function readPendingDesktopServiceToolCall(db: Client, scope: ServiceRequestScope, ports: Pick<ServiceRequestPorts, 'source'>): Promise<string | null> {
    const source = await ports.source()
    if (!source) return null
    const card = await cardById(db, desktopServiceRequestIdentity(scope.agentId, scope.sessionId, source))
    if (card) {
        assertOwned(card, scope)
        if ((await receiptByService(db, card.serviceRequestId, card))?.accepted) return null
    }
    return source.toolCallId
}

export async function readDesktopServiceRequest(db: Client, scope: ServiceRequestScope, ports: ServiceRequestPorts): Promise<DesktopServiceRequestView> {
    const source = await ports.source()
    if (!source) return { request: null }
    return { request: await project(db, await ensureCard(db, scope, source), ports) }
}

async function requireLiveCard(db: Client, scope: ServiceRequestScope, ports: ServiceRequestPorts, input: DesktopServiceProgress | DesktopServiceFinish): Promise<Card> {
    assertEnabled(scope)
    const card = await cardById(db, input.serviceRequestId)
    if (!card) refusal(409, 'This app setup is no longer waiting. Reload the conversation.')
    assertOwned(card, scope)
    assertAligned(input, card)
    if (await receiptByService(db, card.serviceRequestId, card)) refusal(409, 'This app setup is already finished. Retry that finish instead of changing it.')
    const source = await ports.source()
    if (!source || desktopServiceRequestIdentity(scope.agentId, scope.sessionId, source) !== card.serviceRequestId) refusal(409, 'This app setup changed or is no longer waiting. Reload the conversation.')
    return card
}

function progressBody(input: DesktopServiceProgress): string {
    return JSON.stringify({ currentIndex: input.currentIndex, choices: input.choices })
}

async function assertSelectedInstallations(input: DesktopServiceProgress, ports: ServiceRequestPorts) {
    if (!input.choices.some(choice => choice.choice === 'use-connection')) return
    const installations = await ports.installations()
    if (installations === 'unavailable') refusal(502, 'App connections could not be read. Nothing was saved.')
    for (const choice of input.choices) {
        if (choice.choice !== 'use-connection') continue
        const parsed = desktopServiceChoiceSchema.safeParse(choice)
        if (!parsed.success || parsed.data.choice !== 'use-connection') refusal(400, 'Choose a saved app connection.')
        const installation = parsed.data.installation
        const match = installations.find(item => item.key === installation.key && item.slug === choice.slug && item.revision === installation.revision)
        if (!match) refusal(409, 'That app connection changed. Refresh the card and choose the current connection.')
    }
}

export async function progressDesktopServiceRequest(db: Client, scope: ServiceRequestScope, ports: ServiceRequestPorts, input: DesktopServiceProgress) {
    assertEnabled(scope)
    const known = await mutationById(db, input.requestId)
    if (known) {
        if (known.kind !== 'progress' || known.serviceRequestId !== input.serviceRequestId || known.expectedRevision !== input.expectedRevision || known.body !== progressBody(input) || !known.resultRevision) refusal(409, 'That progress request was already used for a different app setup.')
        const card = await cardById(db, input.serviceRequestId)
        if (!card) refusal(409, 'This app setup is no longer waiting. Reload the conversation.')
        assertOwned(card, scope)
        if (JSON.stringify(input.source) !== JSON.stringify(guardOf(card))) refusal(409, 'That saved progress belongs to a different app request.')
        return desktopServiceProgressResultSchema.parse({ serviceRequestId: card.serviceRequestId, revision: known.resultRevision, currentIndex: input.currentIndex, choices: input.choices })
    }
    await requireLiveCard(db, scope, ports, input)
    await assertSelectedInstallations(input, ports)
    const nextRevision = randomUUID()
    const revision = await withCardLock(`${scope.agentId}\0${scope.sessionId}`, () => transaction(db, async tx => {
        const raced = await mutationById(tx, input.requestId)
        if (raced) {
            if (raced.kind !== 'progress' || raced.serviceRequestId !== input.serviceRequestId || raced.expectedRevision !== input.expectedRevision || raced.body !== progressBody(input) || !raced.resultRevision) refusal(409, 'That progress request was already used for different choices.')
            return raced.resultRevision
        }
        const current = await cardById(tx, input.serviceRequestId)
        if (!current || current.revision !== input.expectedRevision) refusal(409, 'This app setup changed. Reload the conversation and retry the saved choices.')
        assertOwned(current, scope)
        assertAligned(input, current)
        if (await receiptByService(tx, current.serviceRequestId, current)) refusal(409, 'This app setup is already finished. Retry that finish instead of changing it.')
        const updated = await tx.execute({
            sql: 'UPDATE desktop_service_suggestion_requests SET revision = ?, current_index = ?, choices = ?, updated_at = ? WHERE service_request_id = ? AND revision = ? AND agent_id = ? AND session_id = ?',
            args: [nextRevision, input.currentIndex, JSON.stringify(input.choices), new Date().toISOString(), current.serviceRequestId, current.revision, scope.agentId, scope.sessionId],
        })
        if (updated.rowsAffected !== 1) refusal(409, 'This app setup changed. Reload the conversation and retry the saved choices.')
        await tx.execute({
            sql: 'INSERT INTO desktop_service_suggestion_mutations (request_id, service_request_id, kind, expected_revision, body, result_revision, created_at) VALUES (?,?,?,?,?,?,?)',
            args: [input.requestId, current.serviceRequestId, 'progress', input.expectedRevision, progressBody(input), nextRevision, new Date().toISOString()],
        })
        return nextRevision
    }))
    return desktopServiceProgressResultSchema.parse({ serviceRequestId: input.serviceRequestId, revision, currentIndex: input.currentIndex, choices: input.choices })
}

function derivationError(reason: 'pending' | 'unavailable' | 'installation-rejected' | 'choice-mismatch' | 'changing'): never {
    if (reason === 'pending') refusal(409, 'Choose skip or a current connection for every app before finishing. Pending apps are not skipped.')
    if (reason === 'installation-rejected') refusal(409, 'That app connection was replaced, disconnected, or reconfigured, or Apps permission is off. Refresh the card and choose the current connection.')
    if (reason === 'changing') refusal(409, 'An app connection is still changing. Refresh the card before finishing.')
    if (reason === 'choice-mismatch') refusal(400, 'Choose each suggested app once, in the requested order.')
    refusal(502, 'App catalog or connection state could not be read. Nothing was marked connected or missing.')
}

function deriveFinish(card: Card, catalogs: DesktopServiceRequestCatalog[], installations: DesktopServiceConnection[] | 'unavailable'): DesktopServiceSetupEntry[] {
    if (card.choices.some(choice => choice.choice === 'pending')) derivationError('pending')
    if (installations === 'unavailable') derivationError('unavailable')
    const derived = deriveDesktopServiceSetup({ services: card.services, choices: card.choices, catalog: catalogs.map(catalogFact), installations: installations.map(installFact) })
    if (!derived.ok) derivationError(derived.reason)
    return derived.entries
}

function identified(response: Response, serviceRequestId: string) {
    response.headers.set('x-service-request-id', serviceRequestId)
    return response
}

function streamResponse(scope: ServiceRequestScope, receipt: SealedReceipt, body: ReadableStream<Uint8Array> | null, contentType?: string | null) {
    const headers = new Headers({ 'content-type': contentType ?? 'text/event-stream', 'x-vercel-ai-ui-message-stream': 'v1', 'x-session-id': scope.sessionId, 'x-run-id': receipt.requestId })
    return identified(new Response(body ?? 'data: [DONE]\n\n', { status: 200, headers }), receipt.serviceRequestId)
}

async function markAccepted(db: Client, receipt: SealedReceipt) {
    await db.execute({ sql: 'UPDATE desktop_service_suggestion_receipts SET accepted = 1 WHERE request_id = ? AND service_request_id = ? AND accepted = 0', args: [receipt.requestId, receipt.serviceRequestId] })
}

async function classify(scope: ServiceRequestScope, db: Client, ports: ServiceRequestPorts, receipt: SealedReceipt, mode: 'send' | 'replay'): Promise<Response | 'missing'> {
    let response: FollowUpResponse
    try { response = await ports.send(receipt, mode) } catch { refusal(502, 'Could not confirm this app setup result. Retry the same finish.') }
    if (response.status === 404 && response.code === 'queued_turn_not_found') return 'missing'
    if (response.status === 403) refusal(403, disabledCoworkerMessage)
    if (response.status === 409) refusal(409, 'This app setup changed or the conversation is still working. Reload the conversation and retry the saved finish.')
    if ((response.status !== 200 && response.status !== 204) || response.sessionId !== scope.sessionId || response.runId !== receipt.requestId) refusal(502, 'Could not confirm this app setup result. Retry the same finish.')
    await markAccepted(db, receipt)
    return streamResponse(scope, receipt, response.status === 204 ? null : response.body ?? null, response.contentType)
}

async function reconcile(db: Client, scope: ServiceRequestScope, ports: ServiceRequestPorts, receipt: SealedReceipt): Promise<Response> {
    if (receipt.accepted) return streamResponse(scope, receipt, null)
    const replay = await classify(scope, db, ports, receipt, 'replay')
    if (replay !== 'missing') return replay
    const sent = await classify(scope, db, ports, receipt, 'send')
    if (sent === 'missing') refusal(502, 'Could not send this app setup result. Retry the same finish.')
    return sent
}

export async function finishDesktopServiceRequest(db: Client, scope: ServiceRequestScope, ports: ServiceRequestPorts, input: DesktopServiceFinish): Promise<Response> {
    assertEnabled(scope)
    const card = await cardById(db, input.serviceRequestId)
    if (!card) refusal(409, 'This app setup is no longer waiting. Reload the conversation.')
    assertOwned(card, scope)
    const existing = await receiptByService(db, card.serviceRequestId, card)
    if (existing) {
        assertAligned(input, card)
        if (existing.revision !== card.revision) refusal(409, 'This app setup result belongs to an earlier decision. Reload the conversation.')
        return reconcile(db, scope, ports, existing)
    }
    const known = await mutationById(db, input.requestId)
    if (known) refusal(409, known.kind === 'finish' && known.serviceRequestId === input.serviceRequestId ? 'That finish request was already used. Reload the conversation.' : 'That finish request was already used for a different app setup.')
    const live = await requireLiveCard(db, scope, ports, input)
    const [catalogs, authority, source] = await Promise.all([
        Promise.all(live.services.map(service => ports.catalog(service.slug).catch((): DesktopServiceRequestCatalog => ({ status: 'unavailable' })))),
        ports.prepareSeal(), ports.source(),
    ])
    if (!source || desktopServiceRequestIdentity(scope.agentId, scope.sessionId, source) !== live.serviceRequestId) refusal(409, 'This app setup changed or is no longer waiting. Reload the conversation.')
    const receipt = await withCardLock(`${scope.agentId}\0${scope.sessionId}`, () => transaction(db, async tx => {
        authority.check()
        const current = await cardById(tx, live.serviceRequestId)
        if (!current || current.revision !== live.revision || JSON.stringify(current.choices) !== JSON.stringify(live.choices)) refusal(409, 'This app setup changed. Reload the conversation and retry the saved choices.')
        assertOwned(current, scope)
        assertAligned(input, current)
        const raced = await receiptByService(tx, current.serviceRequestId, current)
        if (raced) return raced
        const confirmed = deriveFinish(current, catalogs, await authority.installations(tx))
        const text = serializeServiceSetupResult(confirmed)
        const sealed: SealedReceipt = { requestId: input.requestId, serviceRequestId: current.serviceRequestId, sessionId: current.sessionId, revision: current.revision, guard: guardOf(current), text, entries: confirmed, accepted: false }
        const createdAt = new Date().toISOString()
        await tx.execute({
            sql: 'INSERT INTO desktop_service_suggestion_receipts (service_request_id, request_id, revision, summary_text, entries, accepted, created_at) VALUES (?,?,?,?,?,?,?)',
            args: [sealed.serviceRequestId, sealed.requestId, sealed.revision, sealed.text, JSON.stringify(confirmed), 0, createdAt],
        })
        await tx.execute({
            sql: 'INSERT INTO desktop_service_suggestion_mutations (request_id, service_request_id, kind, expected_revision, body, result_revision, created_at) VALUES (?,?,?,?,?,?,?)',
            args: [input.requestId, current.serviceRequestId, 'finish', current.revision, JSON.stringify({ source: sealed.guard, choices: current.choices }), current.revision, createdAt],
        })
        return sealed
    }, authority.check))
    return reconcile(db, scope, ports, receipt)
}
