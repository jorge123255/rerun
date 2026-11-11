import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { EMPTY_DRAFT, type DesktopForemanIntakeCompletionAuthority } from '@rerun/contracts'
import { closeDesktopDatabase, openDesktopDatabase } from '../database'
import { ensureForemanChat } from '../foreman/chat-store'
import { createSqliteDesktopForemanIntakeStore } from '../foreman-intake/store'
import type { DesktopRuntime } from '../runtime'
import { setDesktopWorkspaceFrozen } from '../workspace-admission'
import { createDesktopLocalStarterOffers } from './local-offer'
import { createDesktopLocalStarterDecisions } from './local-decision'

vi.mock('server-only', () => ({}))

const template = { templateId: 'a'.repeat(32), revision: 'b'.repeat(64), title: 'Customer support',
    status: 'captured', coworkerCount: 1, capturedAt: '2026-11-11' }
const signal = () => AbortSignal.timeout(5_000)
let dir: string
let db: Awaited<ReturnType<typeof openDesktopDatabase>>
let owner: Awaited<ReturnType<typeof ensureForemanChat>>
let runtime: DesktopRuntime
let catalog: ReturnType<typeof vi.fn>

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'rerun-local-starter-'))
    db = await openDesktopDatabase(dir)
    owner = await ensureForemanChat(db, '1')
    runtime = { workspaceId: 1, dataRoot: dir, launchNonce: 'test', protocolVersion: 1, buildId: 'test',
        app: { origin: 'http://127.0.0.1:8010', sessionToken: 'fixture-session' },
        engine: { origin: 'http://127.0.0.1:8011', apiKey: 'fixture-engine-key' } }
    catalog = vi.fn(async () => Response.json({ templates: [template, template,
        { ...template, templateId: 'c'.repeat(32), status: 'draft' },
        { ...template, templateId: 'd'.repeat(32), coworkerCount: 0 }] }))
    vi.stubGlobal('fetch', catalog)
})

afterEach(async () => {
    vi.unstubAllGlobals()
    await closeDesktopDatabase(dir)
    await rm(dir, { recursive: true, force: true })
})

async function intake(ownAsk?: string) {
    const store = createSqliteDesktopForemanIntakeStore(db, { schemaReady: true })
    const chat = owner.chat
    const draft = { ...EMPTY_DRAFT, companyUrl: 'example.com', firstName: 'Ada', position: 'Founder' }
    const saved = await store.save({ chat, requestId: randomUUID(), baseRevision: 0, stepIndex: 2, draft, knownFirstName: null, decidedIndustry: null })
    return { store, input: { chat, requestId: randomUUID(), expectedRevision: saved.session.revision,
        answers: { companyUrl: 'example.com', firstName: 'Ada', position: 'Founder', industry: null, decidedIndustry: null, industryLabel: null, ...(ownAsk && { ownAsk }) } } }
}

const ack = () => ({ conversationId: owner.sessionId, runId: null, industry: null })

test('recovers one exact app-authored offer after a lost acknowledgement and a database reopen', async () => {
    const { store, input } = await intake()
    const offers = createDesktopLocalStarterOffers(runtime, db)
    expect(await offers.read(input.chat, input.requestId)).toBeNull()
    expect(await offers.prepare(input.chat, input.requestId, 'unreserved', signal())).toBeNull()
    expect(catalog).not.toHaveBeenCalled()
    let prepared: Awaited<ReturnType<typeof offers.prepare>>[] = []
    const uncertain = await store.complete(input, {
        lookup: async () => null,
        deliver: async effect => {
            prepared = await Promise.all([
                offers.prepare(effect.chat, effect.requestId, effect.fingerprint, signal()),
                offers.prepare(effect.chat, effect.requestId, effect.fingerprint, signal()),
            ])
            throw new Error('synthetic lost acknowledgement')
        },
    })
    expect(uncertain.state).toBe('uncertain')
    expect(prepared[0]).toMatchObject({ sessionId: owner.sessionId, cards: [
        { templateId: template.templateId, title: template.title, revision: template.revision },
    ] })
    expect(prepared[1]).toEqual(prepared[0])
    expect(catalog).toHaveBeenCalledWith('http://127.0.0.1:8011/desktop/templates', expect.objectContaining({
        method: 'GET', redirect: 'error', headers: expect.objectContaining({ Authorization: 'Bearer fixture-engine-key' }),
    }))
    const saved = await offers.read(input.chat, input.requestId)
    expect(saved).toBeTruthy()
    expect((await db.execute('SELECT id FROM desktop_foreman_local_starter_offers')).rows).toEqual([{ id: saved?.id }])

    await closeDesktopDatabase(dir)
    db = await openDesktopDatabase(dir)
    const reopened = createDesktopLocalStarterOffers({ ...runtime, launchNonce: 'reopened' }, db)
    catalog.mockClear().mockResolvedValue(Response.json({ templates: [{ ...template, revision: 'f'.repeat(64) }] }))
    const deliver = vi.fn(async () => ack())
    const completion = await createSqliteDesktopForemanIntakeStore(db, { schemaReady: true }).complete(input, {
        deliver,
        lookup: async effect => await reopened.read(effect.chat, effect.requestId) ? { ...effect, ...ack() } : null,
    })
    expect(completion).toMatchObject({ state: 'acknowledged', followUp: ack() })
    expect(await reopened.prepare(input.chat, input.requestId, completion.fingerprint, signal())).toEqual(saved)
    expect(deliver).not.toHaveBeenCalled()
    expect(catalog).not.toHaveBeenCalled()
    expect((await db.execute('SELECT request_id FROM desktop_foreman_turns')).rows).toEqual([])
    expect((await db.execute('SELECT id FROM desktop_schema_migrations WHERE version=40')).rows).toEqual([{ id: 'foreman-local-starter-offer' }])
})

test('refuses changed, frozen and foreign authority, and withdrawal survives reopen', async () => {
    const { store, input } = await intake()
    const offers = createDesktopLocalStarterOffers(runtime, db)
    const authority: DesktopForemanIntakeCompletionAuthority = {
        lookup: async () => null,
        deliver: async effect => {
            expect(await offers.prepare(effect.chat, effect.requestId, 'changed', signal())).toBeNull()
            expect(catalog).not.toHaveBeenCalled()
            await expect(offers.read({ ...effect.chat, workspaceId: '2' }, effect.requestId)).rejects.toMatchObject({ status: 404 })
            await expect(offers.read({ ...effect.chat, chatId: 'fmc_foreign' }, effect.requestId)).rejects.toMatchObject({ status: 404 })
            setDesktopWorkspaceFrozen(runtime, true)
            try { await expect(offers.prepare(effect.chat, effect.requestId, effect.fingerprint, signal())).rejects.toMatchObject({ status: 409 }) }
            finally { setDesktopWorkspaceFrozen(runtime, false) }
            expect(await offers.prepare(effect.chat, effect.requestId, effect.fingerprint, signal())).toBeTruthy()
            return ack()
        },
    }
    const completed = await store.complete(input, authority)
    expect(completed.state).toBe('acknowledged')
    const offered = (await offers.read(input.chat, input.requestId))!
    expect(await offers.withdraw(input.chat, randomUUID())).toBe(false)
    expect(await offers.withdraw(input.chat, offered.id)).toBe(true)
    await closeDesktopDatabase(dir)
    db = await openDesktopDatabase(dir)
    const reopened = createDesktopLocalStarterOffers(runtime, db)
    expect(await reopened.read(input.chat, input.requestId)).toBeNull()
    expect(await reopened.prepare(input.chat, input.requestId, completed.fingerprint, signal())).toBeNull()
    expect((await db.execute('SELECT withdrawn FROM desktop_foreman_local_starter_offers')).rows).toEqual([{ withdrawn: 1 }])
    expect(catalog).toHaveBeenCalledTimes(1)
})

test('refuses to project a saved template revision that no longer matches the offer digest', async () => {
    const { store, input } = await intake()
    const offers = createDesktopLocalStarterOffers(runtime, db)
    const completed = await store.complete(input, {
        lookup: async () => null,
        deliver: async effect => {
            expect(await offers.prepare(effect.chat, effect.requestId, effect.fingerprint, signal())).toBeTruthy()
            return ack()
        },
    })
    expect(completed.state).toBe('acknowledged')
    const saved = (await offers.read(input.chat, input.requestId))!
    await db.execute({
        sql: 'UPDATE desktop_foreman_local_starter_offers SET cards=? WHERE id=?',
        args: [JSON.stringify(saved.cards.map(card => ({ ...card, revision: 'f'.repeat(64) }))), saved.id],
    })
    await expect(offers.read(input.chat, input.requestId)).rejects.toMatchObject({ status: 503 })
    await expect(offers.prepare(input.chat, input.requestId, completed.fingerprint, signal())).rejects.toMatchObject({ status: 503 })
    expect(catalog).toHaveBeenCalledTimes(1)
})

test('an ordinary Foreman turn admitted during catalog loading prevents publication', async () => {
    const { store, input } = await intake()
    const offers = createDesktopLocalStarterOffers(runtime, db)
    catalog.mockImplementationOnce(async () => {
        await db.execute({
            sql: "INSERT INTO desktop_foreman_turns(request_id,chat_id,fingerprint,body,status,created_at) VALUES(?,?,?,?,'pending',?)",
            args: [randomUUID(), input.chat.chatId, 'fixture', '{}', '2026-11-11'],
        })
        return Response.json({ templates: [template] })
    })
    const completed = await store.complete(input, {
        lookup: async () => null,
        deliver: async effect => {
            expect(await offers.prepare(effect.chat, effect.requestId, effect.fingerprint, signal())).toBeNull()
            return { ...ack(), runId: 'ordinary-turn' }
        },
    })
    expect(completed.followUp?.runId).toBe('ordinary-turn')
    expect(await offers.read(input.chat, input.requestId)).toBeNull()
    expect((await db.execute('SELECT id FROM desktop_foreman_local_starter_offers')).rows).toEqual([])
})

test('a user-authored ask keeps the ordinary kickoff and does not fetch the catalog', async () => {
    const { store, input } = await intake('Draft a response to a sample customer.')
    const offers = createDesktopLocalStarterOffers(runtime, db)
    const completed = await store.complete(input, {
        lookup: async () => null,
        deliver: async effect => {
            expect(await offers.prepare(effect.chat, effect.requestId, effect.fingerprint, signal())).toBeNull()
            return { ...ack(), runId: 'custom-kickoff' }
        },
    })
    expect(completed.followUp?.runId).toBe('custom-kickoff')
    expect(catalog).not.toHaveBeenCalled()
})

test('card decisions require the exact captured revision and one immutable choice across reopen', async () => {
    const { store, input } = await intake()
    const offers = createDesktopLocalStarterOffers(runtime, db)
    const completed = await store.complete(input, {
        lookup: async () => null,
        deliver: async effect => {
            expect(await offers.prepare(effect.chat, effect.requestId, effect.fingerprint, signal())).toBeTruthy()
            return ack()
        },
    })
    const offer = (await offers.read(input.chat, completed.requestId))!
    const decisions = createDesktopLocalStarterDecisions(runtime, db)
    const selection = { offerId: offer.id, digest: offer.digest, intakeRequestId: completed.requestId,
        choice: { kind: 'cards' as const, chosen: [template.templateId] } }
    await expect(decisions.reserve(input.chat, { ...selection, digest: 'f'.repeat(64) }, signal())).rejects.toMatchObject({ status: 409 })
    await expect(decisions.reserve(input.chat, { ...selection, choice: { kind: 'cards', chosen: ['f'.repeat(32)] } }, signal())).rejects.toMatchObject({ status: 409 })
    catalog.mockResolvedValueOnce(Response.json({ templates: [{ ...template, revision: 'f'.repeat(64) }] }))
    await expect(decisions.reserve(input.chat, selection, signal())).rejects.toMatchObject({ status: 409 })
    expect((await db.execute('SELECT offer_id FROM desktop_foreman_local_starter_decisions')).rows).toEqual([])
    const decision = await decisions.reserve(input.chat, selection, signal())
    expect(decision).toEqual({ offer, choice: selection.choice })
    expect(await offers.read(input.chat, completed.requestId)).toBeNull()
    await closeDesktopDatabase(dir)
    db = await openDesktopDatabase(dir)
    const reopened = createDesktopLocalStarterDecisions(runtime, db)
    catalog.mockClear()
    expect(await reopened.reserve(input.chat, selection, signal())).toEqual(decision)
    expect(catalog).not.toHaveBeenCalled()
    await expect(reopened.reserve(input.chat, { ...selection, choice: { kind: 'dismiss' } }, signal())).rejects.toMatchObject({ status: 409 })
    expect((await db.execute('SELECT offer_id FROM desktop_foreman_local_starter_decisions')).rows).toEqual([{ offer_id: offer.id }])
    expect((await db.execute('SELECT request_id FROM desktop_foreman_turns')).rows).toEqual([])
})

test('Stop fences the reserved intake before a catalog response can publish the offer', async () => {
    const { store, input } = await intake()
    const offers = createDesktopLocalStarterOffers(runtime, db)
    const decisions = createDesktopLocalStarterDecisions(runtime, db)
    catalog.mockImplementationOnce(async () => {
        await decisions.stop(input.chat)
        return Response.json({ templates: [template] })
    })
    const completed = await store.complete(input, {
        lookup: async () => null,
        deliver: async effect => {
            expect(await offers.prepare(effect.chat, effect.requestId, effect.fingerprint, signal())).toBeNull()
            return ack()
        },
    })
    expect(completed.state).toBe('acknowledged')
    expect(await offers.prepare(input.chat, completed.requestId, completed.fingerprint, signal())).toBeNull()
    expect(catalog).toHaveBeenCalledTimes(1)
    expect((await db.execute('SELECT intake_request_id FROM desktop_foreman_local_starter_stops')).rows).toEqual([{ intake_request_id: completed.requestId }])
    expect((await db.execute('SELECT id FROM desktop_foreman_local_starter_offers')).rows).toEqual([])
})

test('dismissal closes the exact acknowledged offer without reserving a turn', async () => {
    const { store, input } = await intake()
    const offers = createDesktopLocalStarterOffers(runtime, db)
    const decisions = createDesktopLocalStarterDecisions(runtime, db)
    const completed = await store.complete(input, {
        lookup: async () => null,
        deliver: async effect => {
            const offer = (await offers.prepare(effect.chat, effect.requestId, effect.fingerprint, signal()))!
            await expect(decisions.reserve(input.chat, { offerId: offer.id, digest: offer.digest, intakeRequestId: effect.requestId,
                choice: { kind: 'dismiss' } }, signal())).rejects.toMatchObject({ status: 409 })
            return ack()
        },
    })
    expect(completed.state).toBe('acknowledged')
    const offer = (await offers.read(input.chat, completed.requestId))!
    const choice = { offerId: offer.id, digest: offer.digest, intakeRequestId: completed.requestId, choice: { kind: 'dismiss' as const } }
    await expect(decisions.reserve(input.chat, choice, signal())).resolves.toEqual({ offer, choice: choice.choice })
    await expect(decisions.reserve(input.chat, choice, signal())).resolves.toEqual({ offer, choice: choice.choice })
    expect(await offers.read(input.chat, completed.requestId)).toBeNull()
    expect((await db.execute('SELECT request_id FROM desktop_foreman_turns')).rows).toEqual([])
})
