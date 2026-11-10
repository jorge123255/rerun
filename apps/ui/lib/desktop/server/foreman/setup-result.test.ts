import { createClient, type Client } from '@libsql/client'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ensureDesktopSetupSchema } from '../setup/schema'
import { firstInstall } from './seal'
import { decideSetupConnection, openSetupResult, projectSetupResult, resumeSetupResult, workWithinScope, type SetupPermissions } from './setup-result'
import { loadSetupResult, recordObservedServiceSetup, saveSetupResult } from './setup-result-store'

const scout = { role: 'Find companies that need marketing help' }
const grants: SetupPermissions = { services: false, suggestService: false, requestSecret: false }

describe('result-first setup instructions', () => {
    it('gives a job with no app a first result and does not wait for a connection', () => {
        const instructions = firstInstall(scout, null)
        expect(instructions).toContain('first real result')
        expect(instructions).toContain('what is public')
        expect(instructions).toContain('label as a sample')
        expect(instructions).toContain('A job that needs no app skips this step')
        expect(instructions).not.toContain('wait until they come back connected')
        expect(instructions).not.toContain('end your turn and wait')
        expect(workWithinScope(openSetupResult({ permissions: grants })).continue).toBe(true)
    })

    it('offers an improving app and still delivers a labeled sample', () => {
        const state = openSetupResult({
            permissions: grants,
            offers: [{ slug: 'notion', name: 'Notion', adds: 'the live pages behind the public site' }],
        })
        const instructions = firstInstall(scout, null, { offers: state.connections })
        expect(instructions).toContain('Notion')
        expect(instructions).toContain('suggest_service')
        expect(instructions).toContain('label as a sample')
        expect(instructions).toContain('what is public')
        expect(instructions).not.toContain('wait until they come back connected')
        expect(state.connections[0]).toMatchObject({ slug: 'notion', status: 'pending', role: 'improving' })
        expect(workWithinScope(state)).toMatchObject({ continue: true, delivery: 'public-or-labeled-sample', sampleLabel: 'sample', blockedBy: null })
        expect(state.permissions).toEqual(grants)
    })
})

describe('explicit skip and required gates', () => {
    it('records an explicit skip and keeps working inside the available scope', () => {
        const opened = openSetupResult({
            permissions: grants,
            offers: [{ slug: 'notion', name: 'Notion', adds: 'the live pages' }],
        })
        const skipped = decideSetupConnection(opened, { slug: 'notion', status: 'skipped' })
        expect(skipped.connections[0]!.status).toBe('skipped')
        expect(skipped.connections[0]!.status).not.toBe('pending')
        expect(skipped.connections[0]!.status).not.toBe('failed')
        expect(skipped.connections[0]!.status).not.toBe('connected')
        expect(workWithinScope(skipped).continue).toBe(true)
        expect(skipped.permissions).toEqual(grants)
        expect(resumeSetupResult(skipped).connections[0]!.status).toBe('skipped')
    })

    it('keeps a required credential gated when the user skips', () => {
        const opened = openSetupResult({
            permissions: grants,
            offers: [{ slug: 'notion', name: 'Notion', adds: 'the live pages' }],
            required: { name: 'CRM API key', kind: 'credential' },
        })
        const skipped = decideSetupConnection(opened, { slug: 'notion', status: 'skipped' })
        expect(skipped.gate).toEqual({ name: 'CRM API key', kind: 'credential', status: 'pending' })
        expect(skipped.connections[0]!.status).toBe('skipped')
        expect(workWithinScope(skipped)).toMatchObject({ continue: false, delivery: 'gated', blockedBy: 'CRM API key' })
        expect(skipped.permissions).toEqual(grants)
        const refused = decideSetupConnection(opened, { slug: 'CRM API key', status: 'skipped' })
        expect(refused.gate?.status).toBe('pending')
        expect(refused.permissions.requestSecret).toBe(false)
        expect(firstInstall(scout, null, { required: { name: 'CRM API key', kind: 'credential' } })).toContain('stays gated')
    })

    it('does not turn a failed connection or a granted gate into a wider permission', () => {
        const opened = openSetupResult({ permissions: grants, offers: [{ slug: 'slack', name: 'Slack', adds: 'the channel' }], required: { name: 'Apps', kind: 'permission' } })
        const failed = decideSetupConnection(opened, { slug: 'slack', status: 'failed' })
        expect(failed.connections[0]!.status).toBe('failed')
        expect(failed.gate?.status).toBe('pending')
        expect(failed.permissions.services).toBe(false)
        const granted = decideSetupConnection(failed, { gate: 'granted' })
        expect(granted.gate?.status).toBe('granted')
        expect(granted.permissions).toEqual(grants)
        expect(workWithinScope(granted).continue).toBe(true)
    })
})

describe('resume of saved setup', () => {
    const sealedPlan = {
        title: 'Marketing',
        boxes: [{ name: 'Growth', key: 'box-0' }],
        items: [{ kind: 'agent', name: 'Scout', role: scout.role, key: 'item-0', boxKey: 'box-0' }],
        permissions: grants,
    }
    const setupView = { required: true, prompt: 'Connect your notes.', pending: true, skipped: true, sessionId: null, permissions: grants }
    const pendingCard = { choices: [{ slug: 'notion', choice: 'pending' }, { slug: 'slack', choice: 'skip' }], permissions: grants }

    it('keeps pre-change plans, setup views and cards inside their old boundaries', () => {
        for (const saved of [sealedPlan, setupView]) {
            const resumed = resumeSetupResult(saved)
            expect(resumed.connections).toEqual([])
            expect(resumed.gate).toBeNull()
            expect(resumed.permissions).toEqual(grants)
        }
        const card = resumeSetupResult(pendingCard)
        expect(card.connections.map(item => [item.slug, item.status])).toEqual([['notion', 'pending'], ['slack', 'skipped']])
        expect(card.permissions).toEqual(grants)
        const connected = resumeSetupResult({
            choices: [{ slug: 'notion', choice: 'use-connection', installation: { key: 'notion', revision: '11111111-1111-4111-8111-111111111111' } }],
            entries: [{ slug: 'notion', name: 'Notion', outcome: 'reset' }],
            permissions: { services: true, suggestService: false },
        })
        expect(connected.connections[0]!.status).toBe('failed')
        expect(connected.permissions.services).toBe(true)
        const liveRevoked = resumeSetupResult({ ...connected, permissions: { services: true } }, { services: false, suggestService: false })
        expect(liveRevoked.permissions).toEqual({ services: false, suggestService: false })
        expect(liveRevoked.connections[0]!.status).toBe('failed')
    })

    it('projects a saved card onto a pending scope without flipping a recorded skip', () => {
        const pending = openSetupResult({ permissions: grants, offers: [{ slug: 'notion', name: 'Notion', adds: 'pages' }] })
        const projected = projectSetupResult({
            saved: pending,
            card: { choices: [{ slug: 'notion', choice: 'skip' }], entries: [{ slug: 'notion', name: 'Notion', outcome: 'skipped' }] },
            permissions: grants,
        })
        expect(projected.connections[0]!.status).toBe('skipped')
        expect(projected.permissions).toEqual(grants)
        const kept = projectSetupResult({
            saved: projected,
            card: { choices: [{ slug: 'notion', choice: 'pending' }] },
            permissions: { services: true, suggestService: true, requestSecret: true },
        })
        expect(kept.connections[0]!.status).toBe('skipped')
        expect(kept.permissions).toEqual(grants)
    })
})

describe('persisted setup scope', () => {
    const roots: string[] = []
    const clients: Client[] = []
    afterEach(async () => {
        for (const db of clients.splice(0)) db.close()
        await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
    })

    async function database() {
        const root = await mkdtemp(join(tmpdir(), 'rerun-setup-result-'))
        roots.push(root)
        const db = createClient({ url: `file:${join(root, 'app.db')}` })
        clients.push(db)
        await db.execute('PRAGMA foreign_keys = ON')
        await db.execute('CREATE TABLE desktop_agents(id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0)')
        await db.execute("INSERT INTO desktop_agents(id, enabled) VALUES('coworker', 0)")
        await ensureDesktopSetupSchema(db)
        return db
    }

    it('reloads a skip and a required gate without widening grants', async () => {
        const db = await database()
        const opened = openSetupResult({
            permissions: grants,
            offers: [{ slug: 'notion', name: 'Notion', adds: 'pages' }],
            required: { name: 'CRM API key', kind: 'credential' },
        })
        await saveSetupResult(db, 'coworker', opened)
        await recordObservedServiceSetup(db, 'coworker', { choices: [{ slug: 'notion', choice: 'skip' }] })
        const reopened = createClient({ url: `file:${join(roots[0]!, 'app.db')}` })
        clients.push(reopened)
        const loaded = await loadSetupResult(reopened, 'coworker', { services: true, suggestService: true, requestSecret: true })
        expect(loaded.connections[0]!.status).toBe('skipped')
        expect(loaded.gate).toEqual({ name: 'CRM API key', kind: 'credential', status: 'pending' })
        expect(loaded.permissions).toEqual(grants)
        expect(workWithinScope(loaded).continue).toBe(false)
    })
})
