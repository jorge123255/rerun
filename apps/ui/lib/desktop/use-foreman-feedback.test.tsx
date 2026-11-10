// @vitest-environment happy-dom
import { act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { MessageFeedbackRating } from '@rerun/contracts'
import { useDesktopForemanFeedback } from './use-foreman-feedback'
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const chat = { workspaceId: '1', chatId: 'fmc_feedback01' }
let current: ReturnType<typeof useDesktopForemanFeedback>
let root: Root
const flush = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
const captureFeedback = (feedback: ReturnType<typeof useDesktopForemanFeedback>) => { current = feedback }
function Probe({ active = true, onFeedback }: { active?: boolean; onFeedback: typeof captureFeedback }) {
    const feedback = useDesktopForemanFeedback(chat, active)
    useEffect(() => onFeedback(feedback), [feedback, onFeedback])
    return null
}
beforeEach(() => { root = createRoot(document.body.appendChild(document.createElement('div'))) })
afterEach(async () => { await act(async () => root.unmount()); document.body.innerHTML = ''; vi.unstubAllGlobals() })

it('recovers the saved vote, writes a change, and removes the exact row on a second click', async () => {
    let saved: { id: string; messageId: string; rating: MessageFeedbackRating } | null = { id: 'vote-1', messageId: 'engine-answer', rating: 'up' }
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), 'http://local')
        calls.push(`${init?.method ?? 'GET'} ${url.pathname}${url.search}`)
        if (init?.method === 'PUT') {
            const body = JSON.parse(String(init.body))
            saved = { id: 'vote-2', messageId: body.messageId, rating: body.rating }
            return Response.json(saved)
        }
        if (init?.method === 'DELETE') {
            saved = null
            return Response.json({ ok: true })
        }
        return Response.json({ votes: saved ? [saved] : [] })
    }))
    await act(async () => root.render(<Probe onFeedback={captureFeedback} />))
    await flush()
    expect(current.ratingOf('engine-answer')).toBe('up')
    expect(calls[0]).toContain('GET /api/desktop/foreman/feedback')
    await act(async () => current.rate('engine-answer', 'down'))
    await flush()
    expect(current.ratingOf('engine-answer')).toBe('down')
    expect(calls.at(-1)).toContain('PUT /api/desktop/foreman/feedback')
    await act(async () => current.rate('engine-answer', 'down'))
    await flush()
    expect(current.ratingOf('engine-answer')).toBeNull()
    expect(calls.at(-1)).toContain('DELETE /api/desktop/foreman/feedback')
})

it('does not read or write when inactive, and reverts a rejected stale message', async () => {
    const reads: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), 'http://local')
        if (init?.method === 'PUT') return Response.json({ error: 'Message not found' }, { status: 404 })
        reads.push(String(url))
        return Response.json({ votes: [] })
    }))
    await act(async () => root.render(<Probe active={false} onFeedback={captureFeedback} />))
    await flush()
    expect(reads).toHaveLength(0)
    await act(async () => current.rate('engine-answer', 'up'))
    await act(async () => root.render(<Probe onFeedback={captureFeedback} />))
    await flush()
    await act(async () => current.rate('engine-answer', 'up'))
    await flush()
    expect(current.ratingOf('engine-answer')).toBeNull()
})
