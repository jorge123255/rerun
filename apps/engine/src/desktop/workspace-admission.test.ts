import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { Hono } from 'hono'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
let dir: string | undefined
afterEach(async () => { vi.unstubAllEnvs(); vi.resetModules(); if (dir) await rm(dir, { recursive: true, force: true }); dir = undefined })
it('boots frozen, rejects wrong context and fences old preparations through unfreeze', async () => {
    dir = await mkdtemp(join(tmpdir(), 'workspace-admission-'))
    const file = join(dir, 'runtime.json'), nonce = 'c1111111-1111-4111-8111-111111111111'
    await writeFile(file, JSON.stringify({ launchNonce: nonce, workspaceId: 2, engine: { apiKey: 'fake-test-key' } }))
    vi.stubEnv('RERUN_DESKTOP_APP', '1'); vi.stubEnv('RERUN_DESKTOP_ADMISSIONS_FROZEN', '1'); vi.stubEnv('RERUN_DESKTOP_RUNTIME_FILE', file); vi.stubEnv('RERUN_API_KEY', 'fake-test-key')
    const { assertDesktopRunAdmission, createDesktopWorkspaceAdmissionRouter } = await import('./workspace-admission.js')
    const app = new Hono().route('/desktop/workspace-admission', createDesktopWorkspaceAdmissionRouter())
    let sequence = 0
    const post = (action: string, workspaceId = 2) => app.request('/desktop/workspace-admission', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, workspaceId, launchNonce: nonce, sequence: ++sequence }) })
    expect(() => assertDesktopRunAdmission()).toThrow('switching')
    expect((await post('unfreeze', 1)).status).not.toBe(200)
    expect(() => assertDesktopRunAdmission()).toThrow('switching')
    expect((await post('unfreeze')).status).toBe(200)
    const token = assertDesktopRunAdmission()
    expect((await post('freeze')).status).toBe(200)
    expect(() => assertDesktopRunAdmission(token)).toThrow('switching')
    expect((await post('unfreeze')).status).toBe(200)
    expect(() => assertDesktopRunAdmission(token)).toThrow('switching')
    expect(() => assertDesktopRunAdmission()).not.toThrow()
})

it('a late old freeze cannot overwrite an acknowledged newer unfreeze after identity-read delay', async () => {
    dir = await mkdtemp(join(tmpdir(), 'workspace-admission-order-'))
    const nonce = 'c2222222-2222-4222-8222-222222222222', file = join(dir, 'runtime.json')
    const runtime = { launchNonce: nonce, workspaceId: 7, engine: { apiKey: 'fake-key-7' } }
    await writeFile(file, JSON.stringify(runtime))
    vi.stubEnv('RERUN_DESKTOP_APP', '1'); vi.stubEnv('RERUN_DESKTOP_ADMISSIONS_FROZEN', '1')
    vi.stubEnv('RERUN_DESKTOP_RUNTIME_FILE', file); vi.stubEnv('RERUN_API_KEY', 'fake-key-7')
    const { createDesktopWorkspaceAdmissionRouter, assertDesktopRunAdmission } = await import('./workspace-admission.js')
    let release!: () => void, entered!: () => void, reads = 0
    const held = new Promise<void>(resolve => { release = resolve }), started = new Promise<void>(resolve => { entered = resolve })
    const app = new Hono().route('/desktop/workspace-admission', createDesktopWorkspaceAdmissionRouter({ readRuntime: async () => {
        if (++reads === 1) { entered(); await held }
        return runtime
    } }))
    const post = (action: string, sequence: number) => app.request('/desktop/workspace-admission', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, sequence, workspaceId: 7, launchNonce: nonce }) })
    const older = post('freeze', 1)
    await started
    const newer = await post('unfreeze', 2)
    expect(newer.status).toBe(200); expect(await newer.json()).toMatchObject({ sequence: 2, frozen: false })
    expect(() => assertDesktopRunAdmission()).not.toThrow()
    release()
    expect((await older).status).not.toBe(200)
    expect(() => assertDesktopRunAdmission()).not.toThrow()
    expect((await post('unfreeze', 2)).status).toBe(200)
    expect((await post('freeze', 2)).status).not.toBe(200)
    expect(() => assertDesktopRunAdmission()).not.toThrow()
})

it('awaits listener shutdown on freeze and leaves canceled quit admission usable without reopening listeners', async () => {
    const nonce = 'c3333333-3333-4333-8333-333333333333'
    vi.stubEnv('RERUN_DESKTOP_APP','1');vi.stubEnv('RERUN_DESKTOP_ADMISSIONS_FROZEN','0')
    vi.stubEnv('RERUN_DESKTOP_RUNTIME_FILE','test-runtime');vi.stubEnv('RERUN_API_KEY','fake-key')
    const { createDesktopWorkspaceAdmissionRouter,assertDesktopRunAdmission,observeDesktopAdmissionChange } = await import('./workspace-admission.js')
    let release!: () => void,entered!: () => void,closed = 0
    const held = new Promise<void>(resolve => { release = resolve }),started = new Promise<void>(resolve => { entered = resolve })
    observeDesktopAdmissionChange(async () => {
        try { assertDesktopRunAdmission() } catch { entered();await held;closed++ }
    })
    const router = createDesktopWorkspaceAdmissionRouter({ readRuntime: async () => ({ launchNonce: nonce,workspaceId: 2,engine: { apiKey: 'fake-key' } }) })
    const post = (action: string,sequence: number) => router.request('/',{ method: 'POST',headers: { 'content-type': 'application/json' },body: JSON.stringify({ action,sequence,workspaceId: 2,launchNonce: nonce }) })
    let answered = false
    const freeze = post('freeze',1).then(result => { answered = true;return result })
    await started
    expect(answered).toBe(false);expect(() => assertDesktopRunAdmission()).toThrow('switching')
    release();expect((await freeze).status).toBe(200);expect(closed).toBe(1)
    expect((await post('unfreeze',2)).status).toBe(200)
    expect(() => assertDesktopRunAdmission()).not.toThrow();expect(closed).toBe(1)
})
