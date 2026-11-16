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

async function open(file: { path: string; name: string; scope: 'agent' | 'shared'; size: number; identity: string }, fetcher: ReturnType<typeof vi.fn>) {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    vi.stubGlobal('fetch', fetcher)
    const node = document.createElement('div'); document.body.append(node)
    const root = createRoot(node)
    await act(async () => { root.render(<DesktopResultFilePreview agentId="owner" file={file} onClose={() => {}} />); await new Promise(resolve => setTimeout(resolve, 0)) })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    return { node, close: async () => { await act(async () => root.unmount()); node.remove() } }
}

test('a private HTML download tile previews as inert text and keeps its download', async () => {
    const source = '<img src=x onerror=alert(1)><b>bold</b>', bytes = new TextEncoder().encode(source)
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => new Response(bytes, { headers: { 'content-type': 'text/plain; charset=utf-8', 'content-length': String(bytes.byteLength), 'x-rerun-result-identity': '1:2', 'x-rerun-result-size': String(bytes.byteLength), 'x-rerun-preview-kind': 'text' } }))
    const view = await open({ path: 'site/index.html', name: 'index.html', scope: 'agent', size: bytes.byteLength, identity: '1:2' }, fetcher)
    try {
        expect(String(fetcher.mock.calls[0]![0])).toContain('?preview=1')
        expect(view.node.querySelector('pre')?.textContent).toBe(source)
        expect(view.node.querySelector('img, b, iframe, script')).toBeNull()
        expect([...view.node.querySelectorAll('button')].some(button => button.textContent?.includes('Download'))).toBe(true)
    } finally { await view.close() }
})

test('a refused or changed optional text preview never hides the download or shows stale text', async () => {
    const refused = vi.fn(async () => Response.json({ error: 'No preview is available for this file type.' }, { status: 415 }))
    const view = await open({ path: 'rows.csv', name: 'rows.csv', scope: 'agent', size: 4, identity: '1:2' }, refused)
    try {
        expect(view.node.textContent).toContain('No preview available for this file type')
        expect([...view.node.querySelectorAll('button')].some(button => button.textContent?.includes('Download'))).toBe(true)
    } finally { await view.close() }
    const replaced = vi.fn(async () => new Response('new!', { headers: { 'content-type': 'text/plain; charset=utf-8', 'content-length': '4', 'x-rerun-result-identity': '9:9', 'x-rerun-result-size': '4', 'x-rerun-preview-kind': 'text' } }))
    const stale = await open({ path: 'rows.csv', name: 'rows.csv', scope: 'agent', size: 4, identity: '1:2' }, replaced)
    try {
        expect(stale.node.querySelector('pre')).toBeNull()
        expect(stale.node.textContent).toContain('This file changed and was not downloaded.')
    } finally { await stale.close() }
    const zip = vi.fn()
    const binary = await open({ path: 'bundle.zip', name: 'bundle.zip', scope: 'agent', size: 4, identity: '1:2' }, zip)
    try { expect(zip).not.toHaveBeenCalled() } finally { await binary.close() }
})
