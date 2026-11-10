// @vitest-environment happy-dom
import { createClient } from '@libsql/client'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import type { DesktopCoworkerShareRevokeInput } from '@rerun/contracts'
import { createDesktopCoworkerSnapshot, type DesktopCoworkerShareSource } from '../../../../engine/src/desktop/coworker-share/snapshot'
import { createDesktopCoworkerShareAttempts } from '@/lib/desktop/coworker-share/attempts'
import type { DesktopCoworkerShareClient } from '@/lib/desktop/coworker-share/client'
import { ensureDesktopCoworkerShareSchema } from '@/lib/desktop/server/coworker-share/schema'
import { createDesktopCoworkerShareService } from '@/lib/desktop/server/coworker-share/service'
import { createDesktopCoworkerShareStore } from '@/lib/desktop/server/coworker-share/store'
import { DESKTOP_COWORKER_SHARE_DATABASE_UNAVAILABLE, DESKTOP_COWORKER_SHARE_MEMORY_UNAVAILABLE, sectionTransferReady } from '@/lib/desktop/coworker-share/sections'
import { exportInput, sharePlan, shareReview } from './test-fixtures'
import { DesktopCoworkerManifestReview } from './DesktopCoworkerManifestReview'
import { DesktopCoworkerShareDialog } from './DesktopCoworkerShareDialog'
import { DesktopCoworkerShareOptions } from './DesktopCoworkerShareOptions'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root | undefined
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; document.body.replaceChildren() })
const button = (label: string) => [...document.querySelectorAll('button')].find(item => item.textContent?.trim() === label)

function client(): DesktopCoworkerShareClient {
    return { plan: vi.fn(async () => sharePlan), review: vi.fn(async () => shareReview), export: vi.fn(async () => shareReview), preview: vi.fn(), inspect: vi.fn(), downloadUrl: vi.fn(() => '/download'), import: vi.fn(), revoke: vi.fn(), dispose: vi.fn() } as DesktopCoworkerShareClient
}

test('all controls are non-submit and Escape closes without creating a share', async () => {
    const api = client(), onOpenChange = vi.fn()
    root = createRoot(document.body.appendChild(document.createElement('div')))
    await act(async () => root!.render(<form><DesktopCoworkerShareDialog open onOpenChange={onOpenChange} client={api} attempts={createDesktopCoworkerShareAttempts()} workspaceId={1} agentId="agent-a" agentName="Ada" sourceRevision={exportInput.sourceRevision} /></form>))
    expect([...document.querySelectorAll('button')].every(item => item.type === 'button')).toBe(true)
    document.querySelector('[data-slot="dialog-content"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(api.export).not.toHaveBeenCalled()
})

test('closing discards an uncommitted review and reopening does not repeat it', async () => {
    const api = client()
    function Harness({ open }: { open: boolean }) {
        return <DesktopCoworkerShareDialog open={open} onOpenChange={() => {}} client={api} attempts={createDesktopCoworkerShareAttempts()} workspaceId={1} agentId="agent-a" agentName="Ada" sourceRevision={exportInput.sourceRevision} />
    }
    root = createRoot(document.body.appendChild(document.createElement('div')))
    await act(async () => root!.render(<Harness open />))
    expect(api.plan).toHaveBeenCalledTimes(1)
    await act(async () => root!.render(<Harness open={false} />))
    await act(async () => root!.render(<Harness open />))
    expect(api.plan).toHaveBeenCalledTimes(2)
    expect(api.review).not.toHaveBeenCalled()
    expect(api.export).not.toHaveBeenCalled()
    expect(button('Review portable file')).toBeTruthy()
})

test('unsupported capture options stay disabled and do not describe omitted data as absent', async () => {
    const onChange = vi.fn()
    root = createRoot(document.body.appendChild(document.createElement('div')))
    await act(async () => root!.render(<DesktopCoworkerShareOptions plan={{ ...sharePlan,unavailable: { memories: 'Memory transfer is unavailable.',database: 'Database transfer is unavailable.' } }} include={{ memories: true,database: true,files: false }} disabled={false} onChange={onChange} />))
    expect(document.body.textContent).toContain('Memory transfer is unavailable.')
    expect(document.body.textContent).toContain('Database transfer is unavailable.')
    expect(document.body.textContent).not.toContain('Nothing remembered yet')
    expect(document.body.textContent).not.toContain('No tables yet')
    for (const name of ['Memories','Coworker database']) {
        const toggle = document.querySelector(`[aria-label="${name}"]`) as HTMLButtonElement
        expect(toggle.disabled).toBe(true)
        expect(toggle.getAttribute('aria-checked')).toBe('false')
    }
    expect(onChange).not.toHaveBeenCalled()
})

test('omitted unavailable reasons do not enable memories or the database', async () => {
    root = createRoot(document.body.appendChild(document.createElement('div')))
    await act(async () => root!.render(<DesktopCoworkerShareOptions plan={sharePlan} include={{ memories: true, database: true, files: true }} disabled={false} onChange={vi.fn()} />))
    expect(document.body.textContent).toContain(DESKTOP_COWORKER_SHARE_MEMORY_UNAVAILABLE)
    expect(document.body.textContent).toContain(DESKTOP_COWORKER_SHARE_DATABASE_UNAVAILABLE)
    expect(document.body.textContent).not.toContain('Nothing remembered yet')
    expect(document.body.textContent).not.toContain('No tables yet')
    expect(document.body.textContent).toContain('1 file')
    for (const name of ['Memories', 'Coworker database']) expect((document.querySelector('[aria-label="' + name + '"]') as HTMLButtonElement).disabled).toBe(true)
    expect((document.querySelector('[aria-label="Workspace files"]') as HTMLButtonElement).disabled).toBe(false)
})

test('review lists a bound section digest and hides a section that was not captured', async () => {
    root = createRoot(document.body.appendChild(document.createElement('div')))
    await act(async () => root!.render(<DesktopCoworkerManifestReview manifest={shareReview.manifest} approved={false} onApprovedChange={vi.fn()} sectionReview={{ memoriesDigest: '1'.repeat(64), databaseDigest: null, databaseViewCount: null }} />))
    expect(document.body.textContent).toContain(`Memories SHA-256 ${'1'.repeat(64)}`)
    expect(document.body.textContent).not.toContain('Database SHA-256')
    expect(document.body.textContent).not.toContain('Saved database views')
})

test('a bound preview shows its own counts rather than snapshot path counts', async () => {
    const memories = sectionTransferReady('memories', undefined, { authorities: { capture: true, validation: true, install: true }, preview: { available: true, contents: { count: 4, bytes: 80 }, digest: '1'.repeat(64) } })
    const database = sectionTransferReady('database', undefined, { authorities: { capture: true, validation: true, install: true }, preview: { available: true, contents: { count: 2, bytes: 40 }, digest: '2'.repeat(64), viewCount: 3 } })
    root = createRoot(document.body.appendChild(document.createElement('div')))
    await act(async () => root!.render(<DesktopCoworkerShareOptions plan={sharePlan} include={{ memories: true, database: false, files: false }} sections={{ memories, database }} disabled={false} onChange={vi.fn()} />))
    expect(document.body.textContent).toContain('4 memorys · 80 B')
    expect(document.body.textContent).toContain('2 tables · 40 B · 3 saved views')
    expect(document.body.textContent).not.toContain('1 memory')
    expect((document.querySelector('[aria-label="Memories"]') as HTMLButtonElement).disabled).toBe(false)
    expect((document.querySelector('[aria-label="Memories"]') as HTMLButtonElement).getAttribute('aria-checked')).toBe('true')
})

async function settle(check: () => void) {
    let last: unknown
    for (let attempt = 0; attempt < 40; attempt++) {
        try {
            await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
            check()
            return
        } catch (error) { last = error }
    }
    throw last
}

test('a lost withdrawal acknowledgement reopens on the returned snapshot and later retrieval leaves saved bytes and the imported copy', async () => {
    const source: DesktopCoworkerShareSource = {
        workspaceId: 1, agentId: 'agent-a', name: 'Ada', description: '', revision: '1'.repeat(64),
        setup: { required: false, prompt: '', answered: true }, config: { setup: { required: false } }, envKeys: [], mcpAuth: [],
        members: [{ path: 'SOUL.md', bytes: Buffer.from('Be helpful.'), kind: 'instruction', binary: false, textScanned: true, flagged: [], ownership: 'user' }],
    }
    const include = { memories: false, database: false, files: false }
    const directory = await mkdtemp(join(tmpdir(), 'rerun-share-recovery-'))
    const db = createClient({ url: `file:${join(directory, 'app.db')}` })
    const installed: string[] = []
    try {
        await ensureDesktopCoworkerShareSchema(db)
        const store = createDesktopCoworkerShareStore(db)
        const service = createDesktopCoworkerShareService(store, { install: async () => { installed.push('imported-copy'); return 'imported-copy' } })
        const snapshot = await createDesktopCoworkerSnapshot(source, include)
        const packageKey = snapshot.manifest.packageKey
        expect(packageKey).toMatch(/^[a-f0-9]{32}$/)
        expect(packageKey.startsWith('00000000')).toBe(false)
        await store.create(snapshot, source.agentId, include, source.revision)
        const downloaded = await service.download(packageKey)
        const savedFile = Buffer.from(downloaded.bytes)
        const original = Buffer.from(snapshot.archiveBytes)
        expect(savedFile.equals(original)).toBe(true)
        await service.import({ requestId: 'import-copy', snapshotId: packageKey, expectedDigest: snapshot.manifest.contentDigest, targetWorkspaceId: 2 })
        expect(installed).toEqual(['imported-copy'])
        const returned = { manifest: snapshot.manifest, archiveSha256: snapshot.archiveSha256, archiveBytes: snapshot.archiveBytes.length, reused: false, reviewId: packageKey.repeat(2) }
        const decoy: DesktopCoworkerShareRevokeInput = { requestId: '00000000-0000-4000-8000-000000000001', snapshotId: '0'.repeat(32), expectedRevision: source.revision }
        const values = new Map<string, string>()
        const attemptStore = createDesktopCoworkerShareAttempts({
            get length() { return values.size },
            key: index => [...values.keys()][index] ?? null,
            getItem: key => values.get(key) ?? null,
            setItem: (key, value) => { values.set(key, value) },
            removeItem: key => { values.delete(key) },
        })
        attemptStore.rememberRevoke({ workspaceId: 1, agentId: 'agent-a', snapshotId: decoy.snapshotId }, decoy)
        const calls: DesktopCoworkerShareRevokeInput[] = []
        let misses = 0
        const api = {
            plan: vi.fn(async () => sharePlan),
            review: vi.fn(async () => returned),
            export: vi.fn(async () => returned),
            preview: vi.fn(),
            inspect: vi.fn(),
            downloadUrl: vi.fn((id: string) => `/api/desktop/coworkers/agent-a/share?snapshotId=${id}`),
            import: vi.fn(),
            revoke: vi.fn(async (input: DesktopCoworkerShareRevokeInput) => {
                calls.push(input)
                const receipt = await service.revoke(input)
                if (misses < 2) { misses += 1; throw new Error('acknowledgement unknown') }
                return receipt
            }),
            dispose: vi.fn(),
        } as DesktopCoworkerShareClient
        const prefix = packageKey.slice(0, 8)
        function Harness({ open }: { open: boolean }) {
            return <DesktopCoworkerShareDialog open={open} onOpenChange={() => {}} client={api} attempts={attemptStore} workspaceId={1} agentId="agent-a" agentName="Ada" sourceRevision={source.revision} />
        }
        root = createRoot(document.body.appendChild(document.createElement('div')))
        await act(async () => root!.render(<Harness open />))
        await settle(() => expect((button('Review portable file') as HTMLButtonElement).disabled).toBe(false))
        await act(async () => { button('Review portable file')!.click() })
        await settle(() => expect(document.querySelector('[aria-label="I reviewed what this coworker carries"]')).toBeTruthy())
        await act(async () => { (document.querySelector('[aria-label="I reviewed what this coworker carries"]') as HTMLButtonElement).click() })
        await settle(() => expect((button('Create portable file') as HTMLButtonElement).disabled).toBe(false))
        await act(async () => { button('Create portable file')!.click() })
        await settle(() => expect(document.body.textContent).toContain(`coworker-${prefix}.tar.gz`))
        const link = document.querySelector('a[download]') as HTMLAnchorElement
        expect(link.getAttribute('href')).toBe(`/api/desktop/coworkers/agent-a/share?snapshotId=${packageKey}`)
        expect(link.getAttribute('download')).toBe(`coworker-${prefix}.tar.gz`)
        expect(api.export).toHaveBeenCalledTimes(1)
        expect(vi.mocked(api.export).mock.calls[0]![0].reviewId.slice(0, 32)).toBe(packageKey)
        await act(async () => { button('Withdraw local share')!.click() })
        await settle(() => expect(document.querySelector('[role="alertdialog"]')).toBeTruthy())
        await act(async () => {
            const confirm = [...document.querySelectorAll('[role="alertdialog"] button')].find(item => item.textContent?.trim() === 'Withdraw local share') as HTMLButtonElement
            confirm.click()
        })
        await settle(() => expect(button(`Recover withdrawal ${prefix}`)).toBeTruthy())
        expect(button('Recover withdrawal 00000000')).toBeUndefined()
        expect(calls).toHaveLength(1)
        await expect(service.download(packageKey)).rejects.toMatchObject({ status: 409, message: 'This local share is no longer available.' })
        expect(savedFile.equals(original)).toBe(true)
        await act(async () => { button(`Recover withdrawal ${prefix}`)!.click() })
        await settle(() => expect(calls).toHaveLength(2))
        expect(calls[1]).toEqual(calls[0])
        expect(calls[0]).toMatchObject({ snapshotId: packageKey, expectedRevision: source.revision })
        expect(calls[0]!.requestId).not.toBe(decoy.requestId)
        await act(async () => root!.render(<Harness open={false} />))
        await act(async () => root!.render(<Harness open />))
        await settle(() => expect(button(`Recover withdrawal ${prefix}`)).toBeTruthy())
        expect(button('Recover withdrawal 00000000')).toBeTruthy()
        expect(api.export).toHaveBeenCalledTimes(1)
        expect(api.review).toHaveBeenCalledTimes(1)
        await act(async () => { button(`Recover withdrawal ${prefix}`)!.click() })
        await settle(() => expect(document.body.textContent).toContain('Local share withdrawn. Future downloads from Rerun are blocked; offline files and existing copies are unchanged.'))
        expect(calls).toHaveLength(3)
        expect(calls[2]).toEqual(calls[0])
        expect(new Set(calls.map(input => input.requestId)).size).toBe(1)
        expect(calls.every(input => input.snapshotId === packageKey)).toBe(true)
        expect(document.querySelector('a[download]')).toBeNull()
        await expect(service.download(packageKey)).rejects.toMatchObject({ status: 409, message: 'This local share is no longer available.' })
        await expect(service.preview(packageKey)).rejects.toMatchObject({ status: 409, message: 'This local share is no longer available.' })
        expect(savedFile.equals(original)).toBe(true)
        expect(Buffer.from(snapshot.archiveBytes).equals(original)).toBe(true)
        expect(installed).toEqual(['imported-copy'])
        const copy = await db.execute({ sql: 'SELECT imported_agent_id, status FROM desktop_coworker_share_imports WHERE snapshot_id=? AND target_workspace_id=?', args: [packageKey, 2] })
        expect(copy.rows).toHaveLength(1)
        expect(String(copy.rows[0]!.imported_agent_id)).toBe('imported-copy')
        expect(String(copy.rows[0]!.status)).toBe('imported')
        const share = await db.execute({ sql: 'SELECT status, archive_blob FROM desktop_coworker_shares WHERE snapshot_id=?', args: [packageKey] })
        expect(share.rows).toHaveLength(1)
        expect(String(share.rows[0]!.status)).toBe('revoked')
        expect(share.rows[0]!.archive_blob).toBeNull()
        expect(attemptStore.listRevoke({ workspaceId: 1, agentId: 'agent-a', snapshotId: packageKey })).toEqual([])
        expect(attemptStore.listRevoke({ workspaceId: 1, agentId: 'agent-a', snapshotId: decoy.snapshotId })).toEqual([decoy])
        expect(api.import).not.toHaveBeenCalled()
    } finally {
        db.close()
        await rm(directory, { recursive: true, force: true })
    }
})
