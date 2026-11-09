// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import { createDesktopCoworkerShareAttempts } from '@/lib/desktop/coworker-share/attempts'
import type { DesktopCoworkerShareClient } from '@/lib/desktop/coworker-share/client'
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
