import { createClient } from '@libsql/client'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import type { CompanyDiscoveryEvent } from '@rerun/contracts'
import { createCompanyDiscoveryRuntime } from './runtime'
import { createCompanyDiscoverySqliteStore, DESKTOP_COMPANY_DISCOVERY_SCHEMA_STATEMENTS, type CompanyDiscoveryStore } from './store'
import { createForemanSqliteStore, DESKTOP_FOREMAN_SCHEMA_STATEMENTS } from '../foreman/store'

test('keeps asynchronous live-run checks outside discovery write locks while the same database serves Foreman reads', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rerun-company-live-authority-'))
    const db = createClient({ url: `file:${join(directory, 'app.db')}` })
    try {
        await db.executeMultiple([...DESKTOP_COMPANY_DISCOVERY_SCHEMA_STATEMENTS, ...DESKTOP_FOREMAN_SCHEMA_STATEMENTS].join(';'))
        const actualStore = createCompanyDiscoverySqliteStore(db)
        const foreman = createForemanSqliteStore(db)
        let writing = false, authorityChecks = 0, publications = 0
        const store: CompanyDiscoveryStore = {
            transaction: work => actualStore.transaction(async tx => {
                writing = true
                try { return await work(tx) } finally { writing = false }
            }),
        }
        const identity = { workspaceId: '1', chatId: 'fmc_sqlite-live-0001', runId: 'run-live-1', discoveryId: 'fmx_sqlite-live-0001' }
        const url = 'https://acme.example/'
        const fetchedAt = '2026-11-06T00:00:00.000Z'
        const found: CompanyDiscoveryEvent = {
            type: 'settled', source: 'dns', revision: 1, status: 'found', reason: 'found', fetchedAt,
            provenance: [{ url: 'dns://acme.example', fetchedAt, via: 'public-dns', status: null }],
            payload: { kind: 'dns', dns: { mailProvider: 'Google Workspace', mx: ['mail.acme.example'], services: [], spfIncludes: [], dmarcPolicy: null } },
            findings: [{ kind: 'mail', source: 'dns', attribution: { url, fetchedAt, via: 'public-dns' }, provider: 'Google Workspace', iconUrl: null }],
        }
        const runtime = createCompanyDiscoveryRuntime({
            store,
            authority: {
                currentWorkspaceId: async () => identity.workspaceId,
                owner: async () => { expect(writing).toBe(false); await db.execute('SELECT 1'); return 'active' },
                assertRun: async () => {
                    // The production check awaits the engine HTTP response. A Foreman poll
                    // must be free to use its own write transaction while that is pending.
                    expect(writing).toBe(false)
                    await new Promise<void>(resolve => setTimeout(resolve, 0))
                    expect(await foreman.transaction(tx => tx.runningDiscoveries())).toEqual([])
                    authorityChecks++
                },
            },
            published: async () => { expect(writing).toBe(false); await db.execute('SELECT 1'); publications++ },
            run: async ({ emit, assertCurrent, revisions }) => {
                await assertCurrent()
                for (const source of ['search', 'linkedinPerson', 'linkedinCompany', 'googleBusiness'] as const) emit({ type: 'unavailable', source, reason: 'credentialed' })
                emit({ type: 'pending', source: 'dns' })
                emit({ ...found, revision: (revisions.dns ?? 0) + 1 })
                emit({ type: 'end' })
            },
        })
        const first = await runtime.begin({ ...identity, url })
        expect(first.status).toBe('done')
        expect(first.findings).toHaveLength(1)
        const retried = await runtime.retry({ ...identity, requestId: '00000000-0000-4000-8000-000000000001' })
        expect(retried.status).toBe('done')
        expect(retried.attempt).toBe(2)
        expect(authorityChecks).toBeGreaterThan(10)
        expect(publications).toBeGreaterThan(4)
        expect(await foreman.transaction(tx => tx.runningDiscoveries())).toEqual([])
        expect(await runtime.read(identity)).toMatchObject({ state: 'present', snapshot: { status: 'done' } })
    } finally {
        db.close()
        await rm(directory, { recursive: true, force: true })
    }
})
