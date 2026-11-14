// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import { DesktopApp } from './DesktopApp'
import { DesktopRunHistory } from './DesktopRunHistory'
import { DesktopLocale, useDesktopLocale } from './DesktopLocale'
import { desktopMessages, englishDesktopLanguage } from '@/lib/desktop/locale'
import { loadMessages } from '@rerun/i18n/messages'
import { fullDateTime } from '@rerun/i18n/format'
import type { DesktopRunView } from '@/lib/desktop/run-history'
import { createDesktopDraftFixture } from '@/test/desktop-draft-fixture'
import { createDesktopRecentFixture } from '@/test/desktop-recent-fixture'
import { desktopBackgroundRead } from '@/test/desktop-background-fixture'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const alice = { id: 'alice', name: 'Alice', description: '', createdAt: '', updatedAt: '' }
const bob = { ...alice, id: 'bob', name: 'Bob' }
const running: DesktopRunView = { id: 'run-1', status: 'running', startedAt: '2026-11-03T12:00:00.000Z', finishedAt: null, stepCount: 0,
    provider: 'openrouter', model: 'local-test', inputTokens: null, outputTokens: null, totalTokens: null, cachedInputTokens: null, reasoningTokens: null, costMicros: null }
const click = (label: string) => act(async () => {
    const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.trim() === label || b.getAttribute('aria-label') === label)
    expect(button, label).toBeTruthy()
    button!.click()
})
afterEach(() => { document.body.innerHTML = ''; vi.unstubAllGlobals(); vi.useRealTimers() })

test('opens from a board coworker, updates a running entry, isolates coworkers, and preserves the transcript and typed draft', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    let runs = [running], reads = 0
    const drafts = createDesktopDraftFixture()
    const recent = createDesktopRecentFixture()
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
        const recentResponse = recent.handle(url, init)
        if (recentResponse) return recentResponse
        const draftResponse = drafts.handle(url, init)
        if (draftResponse) return draftResponse
        if (url.endsWith('/tabs') && init?.method === 'PUT') return Response.json({ tabs: { revision: JSON.parse(String(init.body)).baseRevision + 1 } })
        if (url.endsWith('/approvals') && (init?.method ?? 'GET') === 'GET') return Response.json({ approval: null })
        if (url.endsWith('/questions') && (init?.method ?? 'GET') === 'GET') return Response.json({ question: null })
        if (url === '/api/desktop/settings') return Response.json({ connections: [], default: null })
        if (url === '/api/desktop/board-activity') return Response.json({ agents: { alice: 'idle', bob: 'idle' } })
        if (url === '/api/desktop/agents/alice/runs') { reads++; return Response.json({ runs }) }
        if (url === '/api/desktop/agents/bob/runs') return Response.json({ runs: [] })
        if (url.endsWith('/details')) return Response.json({ steps: [{ id: 'step', stepNumber: 1, finishReason: 'stop', totalTokens: 16, durationMs: 100 }], tools: [] })
        if (url.endsWith('/sessions')) return Response.json({ sessions: [{ id: 'saved', agentId: url.includes('/alice/') ? alice.id : bob.id, title: 'Saved chat', createdAt: '', updatedAt: '' }] })
        if (url.endsWith('/messages')) return Response.json({ messages: [{ id: 'answer', role: 'assistant', parts: [{ type: 'text', text: 'The saved answer.' }] }] })
        if (url.includes('/model')) return Response.json({ catalog: [], workspace: null, coworker: null, conversation: null, effective: { source: 'workspace', connectionId: null, provider: null, name: null, model: null, label: 'Select model', available: false } })
        if ((init?.method ?? 'GET') === 'GET') {
            if (/^\/api\/desktop\/agents\/[^/]+\/queue\?/.test(url)) return Response.json({ queued: null })
            if (/^\/api\/desktop\/sessions\/[^/]+\/stop$/.test(url)) return Response.json({ running: false })
            if (/^\/api\/desktop\/sessions\/[^/]+\/feedback(?:\?|$)/.test(url)) return Response.json({ votes: [] })
            if (url === '/api/desktop/pending-inbox') return Response.json({ items: [], unavailableAgentIds: [], checkedAt: '2026-11-05T00:00:00Z' })
            if (url === '/api/desktop/completions') return Response.json({ items: [], unavailableAgentIds: [], enabledAt: '2026-11-05T00:00:00Z', checkedAt: '2026-11-05T00:00:00Z', nextCursor: null })
        }
        const background = desktopBackgroundRead(url, init); if (background) return background
        throw new Error(`Unexpected test request: ${url}`)
    })
    vi.stubGlobal('fetch', fetcher)
    const container = document.createElement('div'); document.body.append(container)
    const root = createRoot(container)
    try {
        await act(async () => { root.render(<DesktopApp initialData={{ theme: 'system', connections: [], default: null,
            profile: { id: 1, displayName: 'Test' }, workspace: { id: 1, name: 'Disposable' }, agents: [alice, bob] }} />) })
        await act(async () => { container.querySelector<HTMLElement>('[aria-label="Open chat with Alice"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
        expect(container.textContent).toContain('The saved answer.')
        const composer = container.querySelector<HTMLTextAreaElement>('#desktop-message')!
        await act(async () => {
            Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(composer, 'Keep my unsent draft')
            composer.dispatchEvent(new Event('input', { bubbles: true }))
            composer.dispatchEvent(new Event('change', { bubbles: true }))
        })
        expect(reads).toBe(0)
        await click('Coworker card')
        await click('Runs')
        expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Running')
        expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Usage not recorded')
        expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Finished In progress')
        await act(async () => { document.querySelector<HTMLButtonElement>('[aria-label="Recent runs"] button')!.click() })
        expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Step 1')
        expect(composer.value).toBe('Keep my unsent draft')
        runs = [{ ...running, status: 'done', finishedAt: '2026-11-03T12:00:03.000Z', stepCount: 1, totalTokens: 16,
            triggerSource: 'schedule', triggerSlug: 'weekly-report' }]
        await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
        expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Done')
        expect(document.querySelector('[role="dialog"]')?.textContent).toContain('16 tokens')
        expect(document.querySelector('[aria-label="Recent runs"]')?.textContent).toContain('weekly-report')
        expect(document.querySelector('[aria-label="Recent runs"]')?.textContent).not.toContain('schedule')
        expect(document.querySelector('time[datetime="2026-11-03T12:00:03.000Z"]')).not.toBeNull()
        await click('Done')
        expect(container.querySelector('#desktop-message')).toBe(composer)
        expect(composer.value).toBe('Keep my unsent draft')
        expect(container.textContent).toContain('The saved answer.')
        const readCount = reads
        await act(async () => { await vi.advanceTimersByTimeAsync(6000) })
        expect(reads).toBe(readCount)
        await act(async () => { container.querySelector<HTMLElement>('[aria-label="Open chat with Bob"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
        await click('Coworker card')
        await click('Runs')
        expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Latest 100 runs for Bob.')
        expect(document.querySelector('[role="dialog"]')?.textContent).toContain('No runs yet')
        expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain('16 tokens')
    } finally { await act(async () => { root.unmount() }) }
})

test('failed reads, retry, empty reads, and stale records have different states', async () => {
    let response = () => Response.json({ error: 'Unavailable' }, { status: 503 })
    vi.stubGlobal('fetch', vi.fn(async () => response()))
    const container = document.createElement('div'); document.body.append(container)
    const root = createRoot(container)
    try {
        await act(async () => { root.render(<DesktopRunHistory agent={alice} />) })
        await click('Runs')
        expect(document.querySelector('[role="alert"]')?.textContent).toContain('Could not load runs')
        expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain('No runs yet')
        response = () => Response.json({ runs: [] })
        await click('Retry runs')
        expect(document.querySelector('[role="alert"]')).toBeNull()
        expect(document.querySelector('[role="dialog"]')?.textContent).toContain('No runs yet')
        response = () => Response.json({ runs: [{ ...running, status: 'error', finishedAt: null, triggerSource: 'webhook', triggerSlug: null }] })
        await click('Refresh runs')
        expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Error')
        expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Finished Not recorded')
        expect(document.querySelector('[aria-label="Recent runs"]')?.textContent).toContain('webhook')
        response = () => Response.json({}, { status: 502 })
        await click('Refresh runs')
        expect(document.querySelector('[role="alert"]')?.textContent).toContain('Showing the last loaded runs.')
        expect(document.querySelector('[aria-label="Recent runs"]')?.textContent).toContain('Error')
    } finally { await act(async () => { root.unmount() }) }
})

test('closing aborts the request and reopening reads again without reusing a late response', async () => {
    let finish!: (response: Response) => void
    const slow = new Promise<Response>(resolve => { finish = resolve })
    const fetcher = vi.fn().mockImplementationOnce(() => slow).mockResolvedValue(Response.json({ runs: [] }))
    vi.stubGlobal('fetch', fetcher)
    const container = document.createElement('div'); document.body.append(container)
    const root = createRoot(container)
    try {
        await act(async () => { root.render(<DesktopRunHistory agent={alice} />) })
        await click('Runs')
        expect(document.querySelector('[role="status"]')?.textContent).toBe('Loading runs…')
        await click('Done')
        expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true)
        await act(async () => { finish(Response.json({ runs: [running] })); await new Promise(resolve => setTimeout(resolve, 100)) })
        await click('Runs')
        expect(document.querySelector('[role="dialog"]')?.textContent).toContain('No runs yet')
    } finally { await act(async () => { root.unmount() }) }
})


test('controlled Logs navigation aborts an old owner and ignores its late run response', async () => {
    let finish!: (response: Response) => void
    const slow = new Promise<Response>(resolve => { finish = resolve })
    const fetcher = vi.fn().mockImplementationOnce(() => slow).mockResolvedValue(Response.json({ runs: [] }))
    vi.stubGlobal('fetch', fetcher)
    const container = document.createElement('div'); document.body.append(container)
    const root = createRoot(container)
    const onOpenChange = vi.fn()
    try {
        await act(async () => { root.render(<DesktopRunHistory agent={alice} dialogControl={{ open: true, onOpenChange }} />) })
        expect(document.querySelector('[role="status"]')?.textContent).toBe('Loading runs…')
        await act(async () => { root.render(<DesktopRunHistory agent={bob} dialogControl={{ open: true, onOpenChange }} />) })
        expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true)
        expect(fetcher.mock.calls[1][0]).toBe('/api/desktop/agents/bob/runs')
        await act(async () => { finish(Response.json({ runs: [running] })) })
        expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Latest 100 runs for Bob.')
        expect(document.querySelector('[role="dialog"]')?.textContent).toContain('No runs yet')
        expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain('local-test')
        await click('Done')
        expect(onOpenChange).toHaveBeenCalledWith(false)
        await act(async () => { root.render(<DesktopRunHistory agent={bob} dialogControl={{ open: false, onOpenChange }} />) })
        expect(document.querySelector('[role="dialog"]')).toBeNull()
    } finally { await act(async () => { root.unmount() }) }
})

test('uses the selected app language for loaded rows and details without refetching when the language changes', async () => {
    const startedAt = running.startedAt!
    const fetcher = vi.fn(async (url: string) => url.endsWith('/details')
        ? Response.json({ steps: [{ id: 'step', stepNumber: 1, finishReason: null, totalTokens: 1400, durationMs: 1250 }], tools: [] })
        : Response.json({ runs: [{ ...running, status: 'done', stepCount: 1, totalTokens: 1400 }] }))
    vi.stubGlobal('fetch', fetcher)
    const french = { locale: 'fr' as const, preference: 'fr' as const, messages: desktopMessages('fr', await loadMessages('fr')) }
    function Harness() {
        const { setLanguage } = useDesktopLocale()
        return <><button onClick={() => setLanguage(french)}>French</button><DesktopRunHistory agent={alice} dialogControl={{ open: true, onOpenChange: () => {} }} /></>
    }
    const container = document.createElement('div'); document.body.append(container)
    const root = createRoot(container)
    try {
        await act(async () => { root.render(<DesktopLocale initial={englishDesktopLanguage}><Harness /></DesktopLocale>) })
        await act(async () => { document.querySelector<HTMLButtonElement>('[aria-label="Recent runs"] button')!.click() })
        expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Step 1')
        expect(fetcher).toHaveBeenCalledTimes(2)
        await click('French')
        const dialog = document.querySelector('[role="dialog"]')!
        expect(dialog.querySelector('h2')?.textContent).toBe('Exécutions récentes')
        expect(dialog.querySelector('time')?.textContent).toBe(fullDateTime(startedAt, 'fr'))
        expect(dialog.textContent).toContain('Étape 1')
        expect(dialog.textContent).toContain('1,3')
        expect(dialog.textContent).toContain(new Intl.NumberFormat('fr').format(1400))
        expect(dialog.textContent).not.toContain('Step 1')
        expect(fetcher).toHaveBeenCalledTimes(2)
    } finally { await act(async () => { root.unmount() }) }
})
