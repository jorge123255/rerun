import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { agentConfigSchema } from '@rerun/contracts'
import { closeDesktopDatabase, openDesktopDatabase } from './database'
import { createDesktopAgent, findDesktopAgent } from './store'
import { desktopCoworkerSettings } from './engine'
import { reconcileDesktopEnabled } from './coworker-enabled'
import type { DesktopRuntime } from './runtime'

const fixture = vi.hoisted(() => ({ descriptions: new Map<string, string>(), loseAcknowledgement: false }))
vi.mock('@/lib/engine/client', async original => {
    const detail = (id: string) => ({ id, config: agentConfigSchema.parse({ name: id, description: fixture.descriptions.get(id) }), soul: 'Instructions' })
    return { ...await original<object>(), getAgent: async (_engine: unknown, id: string) => detail(id), patchAgent: async (_engine: unknown, id: string, patch: { description: string }) => {
        fixture.descriptions.set(id, patch.description)
        if (fixture.loseAcknowledgement) throw new Error('Disconnected after applied update')
        return detail(id)
    } }
})
let root: string, runtime: DesktopRuntime, id: string, legacy: string
beforeEach(async () => {
    fixture.descriptions.clear(); fixture.loseAcknowledgement = false
    root = await mkdtemp(join(tmpdir(), 'phone-settings-description-'))
    runtime = { dataRoot: root, engine: { origin: 'http://127.0.0.1:1', apiKey: 'fixture' } } as DesktopRuntime
    const db = await openDesktopDatabase(root)
    id = (await createDesktopAgent(db, { engineAgentId: 'alice', name: 'Alice', description: 'Initial' })).id
    legacy = (await createDesktopAgent(db, { engineAgentId: 'old', name: 'Old', description: 'Legacy board job' })).id
    fixture.descriptions.set('alice', 'Initial')
})
afterEach(async () => { await closeDesktopDatabase(root); await rm(root, { recursive: true, force: true }) })

it('uses the owner’s canonical settings and persists the board description after reopen', async () => {
    expect((await desktopCoworkerSettings(runtime, id, { description: 'New job' })).description).toBe('New job')
    expect(fixture.descriptions.get('alice')).toBe('New job')
    await closeDesktopDatabase(root)
    expect((await findDesktopAgent(await openDesktopDatabase(root), id))?.description).toBe('New job')
    expect((await desktopCoworkerSettings(runtime, id)).description).toBe('New job')
    await expect(desktopCoworkerSettings(runtime, 'foreign', { description: 'Wrong' })).rejects.toMatchObject({ status: 404 })
})
it('recovers a lost acknowledgement without rewriting unrelated legacy descriptions', async () => {
    fixture.loseAcknowledgement = true
    await expect(desktopCoworkerSettings(runtime, id, { description: '' })).rejects.toMatchObject({ status: 502 })
    await closeDesktopDatabase(root)
    const db = await openDesktopDatabase(root)
    await reconcileDesktopEnabled(db, { baseUrl: 'http://127.0.0.1:1', apiKey: 'fixture' })
    expect((await findDesktopAgent(db, id))?.description).toBe('')
    expect((await findDesktopAgent(db, legacy))?.description).toBe('Legacy board job')
    expect((await db.execute('SELECT * FROM desktop_description_checks')).rows).toEqual([])
})
