// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { DesktopCoworkerCallSnapshot } from '@/lib/desktop/coworker-calls-client'
import { DesktopCoworkerCalls } from './DesktopCoworkerCalls'

vi.mock('@/hooks/useToolDisplay', () => ({ useToolDisplay: () => (toolName: string) => ({ label: toolName, iconProps: { icon: () => null } }) }))
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Root[] = []
beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
})
afterEach(async () => {
    await act(async () => { for (const root of roots.splice(0)) root.unmount() })
    document.body.innerHTML = ''
    vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers()
})

const snapshot = (name = 'Ada', parentAgentId = 'parent-a', parentSessionId = 'chat-a', patch: Partial<DesktopCoworkerCallSnapshot> = {}): DesktopCoworkerCallSnapshot => ({
    callId: name === 'Ada' ? '00000000-0000-4000-8000-000000000001' : '00000000-0000-4000-8000-000000000002',
    revision: '1', parentAgentId, parentSessionId, parentRunId: 'run', toolCallId: 'tool-call', targetAgentId: `target-${name}`,
    targetSessionId: `chat-${name}`, targetName: name, wait: true, status: 'running', createdAt: '2026-11-05T10:00:00.000Z', updatedAt: '2026-11-05T10:01:00.000Z',
    progress: { steps: 1, toolCalls: 0, failures: 0, preview: '', calls: [] }, ...patch,
})

test('polls only while active and stops permanently on unmount without issuing a mutation', async () => {
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ calls: [snapshot()] }))
    vi.stubGlobal('fetch', fetcher)
    const root = createRoot(document.body.appendChild(document.createElement('div'))); roots.push(root)
    await act(async () => root.render(<DesktopCoworkerCalls agentId="parent-a" sessionId="chat-a" active={false} />))
    expect(fetcher).not.toHaveBeenCalled()
    await act(async () => root.render(<DesktopCoworkerCalls agentId="parent-a" sessionId="chat-a" active />))
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(document.body.textContent).toContain('Calling Ada')
    await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
    expect(fetcher).toHaveBeenCalledTimes(2)
    await act(async () => root.unmount()); roots.pop()
    await act(async () => { await vi.advanceTimersByTimeAsync(9000) })
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(fetcher.mock.calls.every(call => call[1]?.method === 'GET')).toBe(true)
})

test('separates initial loading from a valid empty result and stops polling empty', async () => {
    let resolve!: (response: Response) => void
    const fetcher = vi.fn(() => new Promise<Response>(done => { resolve = done }))
    vi.stubGlobal('fetch', fetcher)
    const root = createRoot(document.body.appendChild(document.createElement('div'))); roots.push(root)
    await act(async () => root.render(<DesktopCoworkerCalls agentId="parent-a" sessionId="chat-a" />))
    expect(document.body.textContent).toContain('Loading coworker calls…')
    await act(async () => { resolve(Response.json({ calls: [] })) })
    expect(document.body.textContent).not.toContain('Loading coworker calls…')
    expect(document.body.textContent).not.toContain('Calling Ada')
    await act(async () => { await vi.advanceTimersByTimeAsync(9000) })
    expect(fetcher).toHaveBeenCalledTimes(1)
})

test('does not poll a settled historical call or manufacture a live timer', async () => {
    const fetcher = vi.fn(async () => Response.json({ calls: [snapshot('Ada', 'parent-a', 'chat-a', { status: 'completed' })] }))
    vi.stubGlobal('fetch', fetcher)
    const root = createRoot(document.body.appendChild(document.createElement('div'))); roots.push(root)
    await act(async () => root.render(<DesktopCoworkerCalls agentId="parent-a" sessionId="chat-a" />))
    expect(document.body.textContent).toContain('Ada answered')
    await act(async () => { await vi.advanceTimersByTimeAsync(9000) })
    expect(fetcher).toHaveBeenCalledTimes(1)
})

test('an owner change clears the old calls and a late response cannot restore them', async () => {
    const pending: ((response: Response) => void)[] = []
    const fetcher = vi.fn(() => new Promise<Response>(resolve => pending.push(resolve)))
    vi.stubGlobal('fetch', fetcher)
    const root = createRoot(document.body.appendChild(document.createElement('div'))); roots.push(root)
    await act(async () => root.render(<DesktopCoworkerCalls agentId="parent-a" sessionId="chat-a" />))
    await act(async () => root.render(<DesktopCoworkerCalls agentId="parent-b" sessionId="chat-b" />))
    expect(document.body.textContent).not.toContain('Calling Ada')
    await act(async () => pending[1]?.(Response.json({ calls: [snapshot('Bea', 'parent-b', 'chat-b')] })))
    expect(document.body.textContent).toContain('Calling Bea')
    await act(async () => pending[0]?.(Response.json({ calls: [snapshot('Ada')] })))
    expect(document.body.textContent).not.toContain('Calling Ada')
    expect(document.body.textContent).toContain('Calling Bea')
})

test('a read failure has an explicit retry that reloads the same owner', async () => {
    const fetcher = vi.fn()
        .mockResolvedValueOnce(Response.json({ error: 'Calls unavailable.' }, { status: 503 }))
        .mockResolvedValueOnce(Response.json({ calls: [snapshot()] }))
    vi.stubGlobal('fetch', fetcher)
    const root = createRoot(document.body.appendChild(document.createElement('div'))); roots.push(root)
    await act(async () => root.render(<DesktopCoworkerCalls agentId="parent-a" sessionId="chat-a" />))
    expect(document.body.textContent).toContain('Calls unavailable.')
    const retry = [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === 'Retry coworker calls')!
    await act(async () => { retry.click() })
    expect(document.body.textContent).toContain('Calling Ada')
    expect(document.body.textContent).not.toContain('Calls unavailable.')
})
