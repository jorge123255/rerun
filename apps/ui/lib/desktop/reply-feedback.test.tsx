// @vitest-environment happy-dom
import { act, useLayoutEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { useDesktopReplyFeedback } from './reply-feedback'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))
afterEach(() => { vi.unstubAllGlobals(); document.body.innerHTML = '' })

async function mount() {
    const root = createRoot(document.body.appendChild(document.createElement('div')))
    let current!: ReturnType<typeof useDesktopReplyFeedback>
    function Harness() {
        const feedback = useDesktopReplyFeedback('agent', 'chat')
        useLayoutEffect(() => { current = feedback })
        return null
    }
    await act(async () => root.render(<Harness />))
    return { read: () => current, unmount: () => act(async () => root.unmount()) }
}

it('keeps rapid flips, removal, and re-rating in click order on one reply while another reply can finish first', async () => {
    type Pending = { method: string; message: string; rating?: string; id?: string | null; finish: (result: object) => void }
    const requests: Pending[] = []
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
        if (!init?.method) return Response.json({ votes: [] })
        const data = init.body ? JSON.parse(String(init.body)) : {}
        return new Promise<Response>(resolve => requests.push({
            method: init.method!, message: data.messageId ?? '', rating: data.rating, id: new URL(url, 'http://localhost').searchParams.get('id'),
            finish: result => resolve(Response.json(result)),
        }))
    })
    const hook = await mount()
    const rate = (message: string, rating: 'up' | 'down') => hook.read().rate(message, rating)
    const finish = (i: number, id: string) => act(async () => {
        const request = requests[i]
        request.finish({ id, messageId: request.message, rating: request.rating })
    })
    try {
        await act(async () => {
            rate('a', 'up'); rate('a', 'down'); rate('a', 'down'); rate('a', 'up'); rate('b', 'down')
        })
        expect(requests.map(r => [r.method, r.message, r.rating])).toEqual([['PUT', 'a', 'up'], ['PUT', 'b', 'down']])
        expect(hook.read().votes.get('a')?.rating).toBe('up')
        await finish(1, 'b-vote')
        await finish(0, 'old-up')
        expect(requests[2]).toMatchObject({ method: 'PUT', message: 'a', rating: 'down' })
        await finish(2, 'old-down')
        expect(requests[3]).toMatchObject({ method: 'DELETE', id: 'old-down' })
        await act(async () => requests[3].finish({ ok: true }))
        expect(requests[4]).toMatchObject({ method: 'PUT', message: 'a', rating: 'up' })
        await finish(4, 'new-up')
        expect(await hook.read().votes.get('a')?.feedbackId).toBe('new-up')
        expect(await hook.read().votes.get('b')?.feedbackId).toBe('b-vote')
    } finally { await hook.unmount() }
})

it('recovers the committed ID after a lost PUT response so details and a subsequent undo target the saved row', async () => {
    let saved: { rating: string; id: string; messageId: string } | undefined
    const calls: string[] = []
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET'
        calls.push(method)
        if (method === 'GET') return Response.json({ votes: saved ? [saved] : [] })
        if (method === 'PUT') {
            saved = { id: 'committed', messageId: 'a', rating: 'down' }
            throw new TypeError('connection lost after commit')
        }
        if (method === 'PATCH') expect(JSON.parse(String(init?.body))).toMatchObject({ id: 'committed', details: 'Incorrect date' })
        if (method === 'DELETE') { expect(url).toContain('id=committed'); saved = undefined }
        return Response.json({ ok: true })
    })
    const hook = await mount()
    try {
        await act(async () => hook.read().rate('a', 'down'))
        expect(await hook.read().votes.get('a')?.feedbackId).toBe('committed')
        await act(async () => { expect(await hook.read().submitDetails({ category: 'not_factual', details: 'Incorrect date' })).toBe(true) })
        await act(async () => hook.read().rate('a', 'down'))
        expect(saved).toBeUndefined()
        expect(hook.read().votes.has('a')).toBe(false)
        expect(calls).toEqual(['GET', 'PUT', 'GET', 'PATCH', 'DELETE'])
    } finally { await hook.unmount() }
})

it('submits details to the clicked generation before a later flip, without closing the later dialog', async () => {
    let acknowledge!: () => void
    const order: string[] = []
    vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
        if (!init?.method) return Response.json({ votes: [] })
        const body = JSON.parse(String(init.body))
        if (init.method === 'PATCH') {
            order.push('details ' + body.id)
            return new Promise<Response>(resolve => { acknowledge = () => resolve(Response.json({ ok: true })) })
        }
        order.push('vote ' + body.rating)
        return Response.json({ id: 'vote-' + body.rating, messageId: 'a', rating: body.rating })
    })
    const hook = await mount()
    try {
        await act(async () => hook.read().rate('a', 'up'))
        const closeEarlierDialog = hook.read().onDialogOpenChange
        let submit!: Promise<boolean>
        await act(async () => { submit = hook.read().submitDetails({ category: null, details: 'Useful' }) })
        await act(async () => hook.read().rate('a', 'down'))
        expect(order).toEqual(['vote up', 'details vote-up'])
        await act(async () => { acknowledge(); if (await submit) closeEarlierDialog(false) })
        expect(order).toEqual(['vote up', 'details vote-up', 'vote down'])
        expect(hook.read().dialogOpen).toBe(true)
        expect(hook.read().dialogRating).toBe('down')
    } finally { await hook.unmount() }
})
