// @vitest-environment happy-dom
import { act, useLayoutEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { cancelDraftShutdown, flushDesktopDrafts } from '@/lib/desktop/draft-writes'
import type { DesktopBoardState, DesktopSpaceCommand } from '@/lib/desktop/spaces'
import { useDesktopBoardState } from './useDesktopBoardState'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const spaceId = 'b2173048-7078-40c8-b14a-d5a9e5ad3ace'
const initial: DesktopBoardState = { revision: 3, spaces: [{ id: spaceId, name: 'Original', col_start: 0, row_start: 0, col_end: 7, row_end: 7 }], placements: [] }
const rename: DesktopSpaceCommand = { kind: 'rename', spaceId, name: 'Updated' }
const saved = (revision = 4) => ({ ...initial, revision, spaces: [{ ...initial.spaces[0]!, name: 'Updated' }] })
let state: ReturnType<typeof useDesktopBoardState>
let root: ReturnType<typeof createRoot>
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }
function Harness() {
    const value = useDesktopBoardState(initial)
    useLayoutEffect(() => { state = value })
    return <p>{value.board?.spaces[0]?.name}</p>
}
beforeEach(async () => {
    cancelDraftShutdown()
    const container = document.createElement('div'); document.body.append(container)
    root = createRoot(container)
    await act(async () => { root.render(<Harness />) })
})
afterEach(async () => {
    await act(async () => { root.unmount() })
    cancelDraftShutdown(); document.body.innerHTML = ''; vi.unstubAllGlobals(); vi.restoreAllMocks()
})

test('lost replies retry the same exact operation and block a different mutation until resolved', async () => {
    const fetcher = vi.fn().mockRejectedValueOnce(new TypeError('Network lost')).mockResolvedValueOnce(Response.json({ board: saved() }))
    vi.stubGlobal('fetch', fetcher)
    await act(async () => { await expect(state.command(rename)).rejects.toThrow('Network lost') })
    expect(state.board).toEqual(initial)
    expect(state.error).toBe('Network lost')
    await act(async () => { await expect(state.command({ kind: 'create', name: 'Other' })).rejects.toThrow('Retry the previous') })
    expect(fetcher).toHaveBeenCalledTimes(1)
    await act(async () => { await state.retry() })
    expect(fetcher.mock.calls[1]![1].body).toBe(fetcher.mock.calls[0]![1].body)
    expect(JSON.parse(fetcher.mock.calls[1]![1].body)).toMatchObject({ expectedRevision: 3, command: rename })
    expect(state.board).toEqual(saved())
    expect(state.error).toBeUndefined()
})

test('a conflict refreshes current layout and requires a new explicit command against its revision', async () => {
    const fetcher = vi.fn()
        .mockResolvedValueOnce(Response.json({ error: 'The board changed. Review and try again.' }, { status: 409 }))
        .mockResolvedValueOnce(Response.json({ board: saved(8) }))
        .mockResolvedValueOnce(Response.json({ board: saved(9) }))
    vi.stubGlobal('fetch', fetcher)
    await act(async () => { await expect(state.command(rename)).rejects.toThrow('The board changed') })
    expect(state.board?.revision).toBe(8)
    await act(async () => { await state.command(rename) })
    const first = JSON.parse(fetcher.mock.calls[0]![1].body), second = JSON.parse(fetcher.mock.calls[2]![1].body)
    expect(second.expectedRevision).toBe(8)
    expect(second.requestId).not.toBe(first.requestId)
    expect(state.board?.revision).toBe(9)
})

test('an old refresh cannot undo an accepted board write even if its server ignores abort', async () => {
    const old = deferred<Response>()
    const fetcher = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValueOnce(Response.json({ board: saved() }))
    vi.stubGlobal('fetch', fetcher)
    let read!: Promise<boolean>
    await act(async () => { read = state.refresh() })
    const signal = fetcher.mock.calls[0]![1].signal as AbortSignal
    await act(async () => { await state.command(rename) })
    expect(signal.aborted).toBe(true)
    await act(async () => { old.resolve(Response.json({ board: initial })); expect(await read).toBe(false) })
    expect(state.board).toEqual(saved())
})

test('cancelling the caller suppresses a late board refresh without exposing an error', async () => {
    const response = deferred<Response>()
    const fetcher = vi.fn().mockReturnValue(response.promise)
    vi.stubGlobal('fetch', fetcher)
    const owner = new AbortController()
    let read!: Promise<boolean>
    await act(async () => { read = state.refresh(owner.signal) })
    owner.abort()
    expect((fetcher.mock.calls[0]![1].signal as AbortSignal).aborted).toBe(true)
    await act(async () => {
        response.resolve(Response.json({ board: saved() }))
        expect(await read).toBe(false)
    })
    expect(state.board).toEqual(initial)
    expect(state.error).toBeUndefined()
})

test('an invalid success response remains retryable using the same request identity', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ board: { revision: 4 } })).mockResolvedValueOnce(Response.json({ board: saved() }))
    vi.stubGlobal('fetch', fetcher)
    await act(async () => { await expect(state.command(rename)).rejects.toThrow() })
    expect(state.board).toEqual(initial)
    await act(async () => { await state.retry() })
    expect(fetcher.mock.calls[1]![1].body).toBe(fetcher.mock.calls[0]![1].body)
    expect(state.board).toEqual(saved())
})

test('Quit waits for a board write and admits no new mutation once shutdown begins', async () => {
    const response = deferred<Response>()
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(response.promise))
    let write!: Promise<void>, quit!: Promise<boolean>, finished = false
    await act(async () => { write = state.command(rename); quit = flushDesktopDrafts().then(value => { finished = true; return value }) })
    expect(finished).toBe(false)
    await act(async () => { await expect(state.command({ kind: 'create', name: 'Later' })).rejects.toThrow('not available') })
    await act(async () => { response.resolve(Response.json({ board: saved() })); await write; expect(await quit).toBe(true) })
    expect(finished).toBe(true)
    expect(state.board).toEqual(saved())
})

test('a read that finishes after unmount cannot replace the last mounted board', async () => {
    const response = deferred<Response>()
    const fetcher = vi.fn().mockReturnValue(response.promise)
    vi.stubGlobal('fetch', fetcher)
    let read!: Promise<boolean>
    await act(async () => { read = state.refresh() })
    await act(async () => { root.unmount() })
    expect((fetcher.mock.calls[0]![1].signal as AbortSignal).aborted).toBe(true)
    await act(async () => { response.resolve(Response.json({ board: saved(8) })); await read })
    expect(state.board).toEqual(initial)
})
