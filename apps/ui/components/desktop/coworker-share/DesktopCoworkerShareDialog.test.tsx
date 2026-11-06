// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import { createDesktopCoworkerShareAttempts } from '@/lib/desktop/coworker-share/attempts'
import type { DesktopCoworkerShareClient } from '@/lib/desktop/coworker-share/client'
import { exportInput, sharePlan, shareReview } from './test-fixtures'
import { DesktopCoworkerShareDialog } from './DesktopCoworkerShareDialog'
import { DesktopCoworkerShareOptions } from './DesktopCoworkerShareOptions'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root | undefined
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; document.body.replaceChildren() })
const button = (label: string) => [...document.querySelectorAll('button')].find(item => item.textContent?.trim() === label)

function client(): DesktopCoworkerShareClient {
    return { plan: vi.fn(async () => sharePlan), review: vi.fn(async () => shareReview), export: vi.fn(async () => shareReview), preview: vi.fn(), downloadUrl: vi.fn(() => '/download'), import: vi.fn(), revoke: vi.fn(), dispose: vi.fn() } as DesktopCoworkerShareClient
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
