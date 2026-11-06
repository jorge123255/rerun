import { mkdtemp, open, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Client } from '@libsql/client'
const state = vi.hoisted(() => ({ root: '', clients: [] as Client[], complete: vi.fn(), confirm: vi.fn() }))
vi.mock('../../config/paths.js', () => ({ dataDir: () => state.root }))
vi.mock('../policy.js', () => ({ desktopApp: () => true }))
vi.mock('../brain-pages-router.js', () => ({ getDesktopBrainStore: vi.fn() }))
vi.mock('./model.js', () => ({ openDesktopCompanyBriefModel: () => ({ complete: state.complete, confirm: state.confirm }) }))
vi.mock('@libsql/client', async original => {
    const actual = await original<typeof import('@libsql/client')>()
    return { ...actual, createClient: (options: Parameters<typeof actual.createClient>[0]) => { const client = actual.createClient(options); state.clients.push(client); return client } }
})
vi.mock('../data-executor.js', () => ({ prepareDesktopDataFile: async (_root: string, file: string) => { const handle = await open(file, 'a', 0o600); await handle.close(); return { file } }, verifyDesktopDataFile: async () => {} }))
beforeEach(async () => { state.root = await mkdtemp(join(tmpdir(), 'company-brief-restart-')); state.complete.mockClear(); state.confirm.mockClear() })
afterEach(async () => { for (const client of state.clients.splice(0)) client.close(); vi.resetModules(); await rm(state.root, { recursive: true, force: true }) })
it('reopens the process binding after migration while preserving saved research context and making no model call', async () => {
    const first = await import('./runtime.js')
    await first.initializeDesktopCompanyBriefStore()
    await first.getCompanyBriefService().observe({ workspaceId: '2', chatId: 'fmc_restart0001', sourceRevision: 'a'.repeat(64), active: true })
    const before = (await state.clients[0].execute('SELECT workspace_id,chat_id,source_revision,active FROM desktop_company_brief_context')).rows
    expect(before).toHaveLength(1)
    // A new process has no singleton, even though the on-disk migration is current.
    vi.resetModules()
    const reopened = await import('./runtime.js')
    expect(() => reopened.getCompanyBriefService()).toThrow('not initialized')
    await reopened.initializeDesktopCompanyBriefStore()
    expect(await reopened.getCompanyBriefService().read('2', 'fmc_restart0001')).toBeNull()
    expect((await state.clients[1].execute('SELECT workspace_id,chat_id,source_revision,active FROM desktop_company_brief_context')).rows).toEqual(before)
    expect(state.complete).not.toHaveBeenCalled()
    expect(state.confirm).not.toHaveBeenCalled()
})
