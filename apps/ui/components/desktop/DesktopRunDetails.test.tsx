// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import { DesktopRunDetails } from './DesktopRunDetails'
import { DesktopRunHistory } from './DesktopRunHistory'
import { recordedToolOutcome, type DesktopRunDetailsView } from '@/lib/desktop/run-details'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const detail: DesktopRunDetailsView = { steps: [{ id: 'step', stepNumber: 1, finishReason: 'tool-calls', totalTokens: 16, durationMs: 0 }],
    tools: [{ id: 'tool', stepNumber: 1, toolName: 'fixture_lookup', isError: 0, resultJson: '{"answer":"<script>fixture</script>"}', durationMs: 0 }] }
const run = { id: 'completed', status: 'done', startedAt: '2026-11-03T12:00:00.000Z', finishedAt: '2026-11-03T12:00:01.000Z', stepCount: 1, provider: 'fixture', model: 'test', inputTokens: null, outputTokens: null, totalTokens: 16, cachedInputTokens: null, reasoningTokens: null, costMicros: null }
const click = (text: string) => act(async () => {
    const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent?.trim() === text)
    expect(button).toBeTruthy(); button!.click()
})
afterEach(() => { document.body.innerHTML = ''; vi.unstubAllGlobals() })

test('loads only when a row opens, exposes recorded step/tool outcomes as text, and reloads after collapse', async () => {
    let detailReads = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
        if (url.endsWith('/details')) { detailReads++; return Response.json(detail) }
        if (url.endsWith('/runs')) return Response.json({ runs: [run] })
        throw new Error(`Unexpected request ${url}`)
    }))
    const container = document.createElement('div'); document.body.append(container)
    const root = createRoot(container)
    try {
        await act(async () => { root.render(<DesktopRunHistory agent={{ id: 'alice', name: 'Alice', description: '', createdAt: '', updatedAt: '' }} />) })
        await click('Runs')
        expect(detailReads).toBe(0)
        const row = () => document.querySelector<HTMLButtonElement>('[aria-label="Recent runs"] button')!
        await act(async () => { row().click() })
        expect(detailReads).toBe(1)
        expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Step 1')
        expect(document.querySelector('[role="dialog"]')?.textContent).toContain('fixture_lookup')
        expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Succeeded')
        expect(document.querySelector('pre')?.textContent).toContain('<script>fixture</script>')
        expect(document.querySelector('[role="dialog"] script')).toBeNull()
        await act(async () => { row().click() })
        await act(async () => { row().click() })
        expect(detailReads).toBe(2)
    } finally { await act(async () => { root.unmount() }) }
})
test('shows cancelled empty details honestly, handles failure and retry, and does not drop tools without steps', async () => {
    let response = () => Response.json({}, { status: 502 })
    vi.stubGlobal('fetch', vi.fn(async () => response()))
    const container = document.createElement('div'); document.body.append(container)
    const root = createRoot(container)
    try {
        await act(async () => { root.render(<DesktopRunDetails agentId="alice" runId="cancelled" status="cancelled" />) })
        expect(container.querySelector('[role="alert"]')?.textContent).toContain('Could not load run details')
        expect(container.textContent).not.toContain('No steps')
        response = () => Response.json({ steps: [], tools: [] })
        await click('Retry details')
        expect(container.textContent).toContain('No steps or tool calls recorded for this run.')
        response = () => Response.json({ steps: [], tools: [{ ...detail.tools[0], isError: 1, resultJson: '{"error":"Fixture failure"}' }] })
        await click('Refresh details')
        expect(container.textContent).toContain('No steps recorded for this run.')
        expect(container.textContent).toContain('Tool calls without a recorded step')
        expect(container.textContent).toContain('Failed')
    } finally { await act(async () => { root.unmount() }) }
})
test('refreshes a running row when it becomes terminal and aborts closed reads', async () => {
    let finish!: (value: Response) => void
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ steps: [], tools: [] })).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    vi.stubGlobal('fetch', fetcher)
    const container = document.createElement('div'); document.body.append(container)
    const root = createRoot(container)
    await act(async () => { root.render(<DesktopRunDetails agentId="alice" runId="r" status="running" />) })
    await act(async () => { root.render(<DesktopRunDetails agentId="alice" runId="r" status="done" />) })
    expect(fetcher).toHaveBeenCalledTimes(2)
    await act(async () => { root.unmount() })
    expect(fetcher.mock.calls[1][1].signal.aborted).toBe(true)
    await act(async () => { finish(Response.json(detail)) })
})
test('does not infer success when a tool outcome was not recorded', () => {
    expect(recordedToolOutcome({ ...detail.tools[0], resultJson: null })).toBe('Outcome not recorded')
    expect(recordedToolOutcome({ ...detail.tools[0], resultJson: null, isError: 1 })).toBe('Failed')
})
