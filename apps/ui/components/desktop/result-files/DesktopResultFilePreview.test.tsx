// @vitest-environment happy-dom
import { StrictMode, act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
vi.mock('@/components/ui/dialog', () => ({ Dialog: ({ children }: { children: React.ReactNode }) => <div>{children}</div>, DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>, DialogTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }))
import { DesktopResultFilePreview } from './DesktopResultFilePreview'
afterEach(() => vi.unstubAllGlobals())

test('StrictMode effect replay still permits exactly one confirmed save', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    const fetcher = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'application/octet-stream', 'content-length': '3', 'x-rerun-result-identity': '1:2' } }))
    vi.stubGlobal('fetch', fetcher)
    const saved = vi.fn(async () => true), node = document.createElement('div'); document.body.append(node)
    const root = createRoot(node)
    try {
        await act(async () => root.render(<StrictMode><DesktopResultFilePreview agentId="owner" file={{ path: "Bob's report.zip", name: "Bob's report.zip", scope: 'agent', size: 3, identity: '1:2' }} saveResultFile={saved} onClose={() => {}} /></StrictMode>))
        const button = [...node.querySelectorAll('button')].find(value => value.textContent?.includes('Download'))!
        expect(button).toBeTruthy()
        await act(async () => { button.click(); await new Promise(resolve => setTimeout(resolve, 0)) })
        expect(saved).toHaveBeenCalledExactlyOnceWith("Bob's report.zip", new Uint8Array([1, 2, 3]))
        expect(node.textContent).toContain('Saved')
    } finally { await act(async () => root.unmount()); node.remove() }
})
