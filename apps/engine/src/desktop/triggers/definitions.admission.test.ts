import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterAll, expect, it } from 'vitest'
process.env.RERUN_DATA_DIR = realpathSync(mkdtempSync(resolve(tmpdir(), 'trigger-final-admission-')))
const { rm } = await import('node:fs/promises')
const { readDesktopTriggerDefinition, replaceDesktopTriggerDefinition } = await import('./definitions.js')
const { withKeyedLock } = await import('../../lib/lock.js')
afterAll(async () => { await rm(process.env.RERUN_DATA_DIR!, { recursive: true, force: true }) })

it.each(['write', 'delete'] as const)('rechecks cancelled admission inside the actual final file lock before %s', async operation => {
    const id = `final-${operation}`, slug = 'hook'
    const record = { slug, name: 'Hook', description: '', body: 'Original.', enabled: true, token: 'secret-token', methods: ['POST'] as ['POST'], connectionId: null, provider: null, model: null, createdAt: '2026-01-01T00:00:00.000Z', fireCount: 0, lastFiredAt: null }
    await replaceDesktopTriggerDefinition(id, slug, null, record)
    const before = await readDesktopTriggerDefinition(id, slug)
    let release!: () => void, entered!: () => void
    const acquired = new Promise<void>(resolve => { entered = resolve })
    const held = withKeyedLock(`trigger:${id}:${slug}`, async () => { entered(); await new Promise<void>(resolve => { release = resolve }) })
    await acquired
    const controller = new AbortController()
    const mutation = replaceDesktopTriggerDefinition(id, slug, before, operation === 'delete' ? null : { ...record, body: 'Changed.' }, async () => { controller.signal.throwIfAborted() })
    controller.abort(); release(); await held
    await expect(mutation).rejects.toThrow()
    expect(await readDesktopTriggerDefinition(id, slug)).toEqual(before)
})
