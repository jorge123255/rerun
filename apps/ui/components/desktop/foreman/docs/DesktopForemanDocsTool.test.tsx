// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { RERUN_PUBLIC_DOCS_CORPUS } from '@rerun/contracts'
import { DesktopForemanDocsTool } from './DesktopForemanDocsTool'

let root: Root | undefined
const fetcher = vi.fn()
vi.stubGlobal('fetch', fetcher)
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; document.body.innerHTML = ''; fetcher.mockClear() })

const output = {
    status: 'ok', documentation: RERUN_PUBLIC_DOCS_CORPUS.documentation,
    passages: [{ title: 'Automations - Webhook triggers', url: 'https://docs.rerun.build/agents/automations#webhook-triggers', text: 'A trigger gives an agent a public URL.' }],
    source: { corpusId: 'rerun-public-docs', sourceUrl: RERUN_PUBLIC_DOCS_CORPUS.exportUrl, cacheState: 'fresh', fetchedAt: '2026-11-05T00:00:00.000Z', ageMs: 1000, sha256: 'a'.repeat(64), byteLength: 100, version: 'v1' },
}

it('renders saved citations and metadata without a fresh documentation or model request', async () => {
    const part = { type: 'tool-search_docs', toolCallId: 'call-1', state: 'output-available', input: { query: 'webhook token' }, output }
    root = createRoot(document.body.appendChild(document.createElement('div')))
    await act(async () => root!.render(<DesktopForemanDocsTool part={part as never} restored />))
    const sources = [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.includes('Used 1 source'))
    expect(sources).toBeDefined()
    await act(async () => sources!.click())
    const link = document.querySelector<HTMLAnchorElement>('a[href*="webhook-triggers"]')
    expect(link?.target).toBe('_blank')
    expect(link?.rel).toContain('noopener')
    expect(document.body.textContent).toContain('A trigger gives an agent a public URL.')
    expect(document.body.textContent).toContain('2026-11-05T00:00:00.000Z')
    expect(fetcher).not.toHaveBeenCalled()
})

it('keeps an honest unavailable result and never renders a foreign citation', async () => {
    const part = { type: 'tool-search_docs', toolCallId: 'call-2', state: 'output-available', input: { query: 'billing' }, output: { ...output, passages: [{ ...output.passages[0], url: 'https://example.com/private' }] } }
    root = createRoot(document.body.appendChild(document.createElement('div')))
    await act(async () => root!.render(<DesktopForemanDocsTool part={part as never} restored />))
    expect(document.querySelector('a[href*="example.com"]')).toBeNull()
    expect(fetcher).not.toHaveBeenCalled()
})
