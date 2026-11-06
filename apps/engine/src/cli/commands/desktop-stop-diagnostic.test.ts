import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { createDesktopStopDiagnostic } from './desktop-stop-diagnostic.js'

const identity = { launchNonce: 'c1111111-1111-4111-8111-111111111111', workspaceId: 1 }
let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'rerun-stop-diagnostic-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })
const read = async () => JSON.parse(await readFile(join(root, 'desktop-stop-diagnostic.json'), 'utf8'))

test('records the exact pending drain without postponing synchronous admission closure', async () => {
    const diagnostic = createDesktopStopDiagnostic(root, identity)
    let resolve!: () => void
    let revoked = false
    const drain = diagnostic.track('isolated-screens', () => {
        revoked = true
        return new Promise<void>(done => { resolve = done })
    })
    expect(revoked).toBe(true)
    await diagnostic.flush()
    expect(await read()).toMatchObject({ ...identity, status: 'stopping', components: expect.arrayContaining([
        { component: 'isolated-screens', status: 'pending' }, { component: 'mcp-pool', status: 'not-started' },
    ]) })
    resolve(); await drain; await diagnostic.finish(false)
    expect(await read()).toMatchObject({ status: 'stopped', components: expect.arrayContaining([{ component: 'isolated-screens', status: 'fulfilled' }]) })
})

test('keeps the rejection and private status while excluding all error details from the bounded journal', async () => {
    await writeFile(join(root, 'desktop-stop-diagnostic.json'), 'old diagnostic', { mode: 0o644 })
    const diagnostic = createDesktopStopDiagnostic(root, identity)
    const secret = new Error('private/path token=super-secret user message')
    const result = await diagnostic.track('mcp-callback', () => { throw secret }).catch(error => error)
    expect(result).toBe(secret)
    await diagnostic.finish(true)
    const raw = await readFile(join(root, 'desktop-stop-diagnostic.json'), 'utf8')
    expect(raw).not.toContain(secret.message)
    expect(raw.length).toBeLessThan(4096)
    expect(Object.keys(JSON.parse(raw)).sort()).toEqual(['components', 'launchNonce', 'status', 'workspaceId'])
    expect(JSON.parse(raw)).toMatchObject({ status: 'failed', components: expect.arrayContaining([{ component: 'mcp-callback', status: 'rejected' }]) })
    expect((await stat(join(root, 'desktop-stop-diagnostic.json'))).mode & 0o777).toBe(0o600)
})

test('a retry replaces old statuses, and unavailable diagnostics never change the drain result', async () => {
    const first = createDesktopStopDiagnostic(root, identity)
    await first.track('native-workers', async () => { throw new Error('not confirmed') }).catch(() => {})
    await first.finish(true)
    const retry = createDesktopStopDiagnostic(root, identity)
    await retry.track('native-workers', async () => 'confirmed')
    await retry.finish(false)
    expect(await read()).toMatchObject({ status: 'stopped', components: expect.arrayContaining([{ component: 'native-workers', status: 'fulfilled' }]) })
    const unavailable = createDesktopStopDiagnostic(join(root, 'missing'), identity)
    await expect(unavailable.track('foreman', () => 'unchanged')).resolves.toBe('unchanged')
    await expect(unavailable.finish(false)).resolves.toBeUndefined()
})
